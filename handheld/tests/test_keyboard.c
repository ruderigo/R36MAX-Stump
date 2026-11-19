/* The cockpit's keyboard (FireFly's Compose), driven with the R36MAX's real
 * button codes and a USB keyboard's, checked on what ends up typed; and the
 * rooms and the OWNER tab, read from a live file and sent as commands.
 *   gcc -O2 -Dmain=engine_main -o test_keyboard tests/test_keyboard.c -lasound -lpthread -ldl -lm && ./test_keyboard
 */
#define CMD_QUEUE_FILE "/tmp/stump_test_keyboard_cmd.txt"   /* never the real one */
#define LIVE_STATE_FILE "/tmp/stump_test_keyboard_live.txt"
#include "../stump_r36max_engine.c"
#undef main

static int fails = 0;
#define CHECK(name, cond) do { if (cond) printf("PASS %s\n", name); \
    else { printf("FAIL %s  (buffer \"%s\", scroll %d, room %d, menu %d)\n", name, g_st.input_buf, \
                  g_st.chat_scroll, g_st.room_idx, g_st.menu_cursor); fails++; } } while (0)

static void key(uint16_t code) { cmp_key(code, 1, false); }
static void keyx(uint16_t code, bool shift) { cmp_key(code, 1, shift); }
static void open_kb(int tab) {
    memset(&g_st, 0, sizeof(g_st));
    g_st.tab_idx = tab; g_st.osk_open = true; cmp_reset(); g_cmp.was_open = true;
    g_st.ipc_sock = -1;
}
/* Move the cursor to (row, col) from where it is. */
static void go(int row, int col) {
    while (g_cmp.row != row) key(545);
    while (g_cmp.col != col) key(547);
}

int main(void) {
    load_fonts();
    /* 1. Lower case by default, shift for one capital (Y), A types the key. */
    open_kb(4);
    go(1, 0); key(R36_BTN_A_ACCEPT);                         /* q */
    key(308); go(1, 1); key(R36_BTN_A_ACCEPT);              /* Y then w -> W */
    go(1, 2); key(R36_BTN_A_ACCEPT);                         /* e (shift was one-shot) */
    CHECK("lower case, Y shifts one letter", strcmp(g_st.input_buf, "qWe") == 0);

    /* 2. The on-screen shift key, space (X), digits, delete (B). */
    go(4, 0); key(R36_BTN_A_ACCEPT); go(2, 0); key(R36_BTN_A_ACCEPT);   /* ⇧ then a -> A */
    key(307);                                                            /* X: space */
    go(0, 3); key(R36_BTN_A_ACCEPT);                                     /* 4 */
    key(R36_BTN_B_CANCEL);                                               /* B: delete the 4 */
    CHECK("shift key, space, digit, delete", strcmp(g_st.input_buf, "qWeA ") == 0);

    /* 3. Pages with R1: symbols, then accents; an accented letter is 2 bytes,
     *    and delete removes the whole letter. */
    open_kb(0);
    key(311); go(0, 1); key(R36_BTN_A_ACCEPT);              /* SYM: @ */
    key(311); go(1, 0); key(R36_BTN_A_ACCEPT);              /* ÀÉ: ô */
    go(2, 3); key(R36_BTN_A_ACCEPT);                         /* É */
    CHECK("symbol and accents typed as UTF-8", strcmp(g_st.input_buf, "@\xc3\xb4\xc3\x89") == 0);
    key(R36_BTN_B_CANCEL);
    CHECK("delete removes a whole accented letter", strcmp(g_st.input_buf, "@\xc3\xb4") == 0);
    key(310); key(310);                                      /* L1 twice: back to ABC */
    CHECK("L1 pages back", g_cmp.page == 0);

    /* 4. Shift on an accent gives its capital (à -> À). */
    open_kb(0);
    key(311); key(311); go(0, 0); key(308); key(R36_BTN_A_ACCEPT);
    CHECK("shifted accent", strcmp(g_st.input_buf, "\xc3\x80") == 0);

    /* 5. A USB keyboard: Shift, Caps Lock, and the keys secrets use. */
    open_kb(4);
    keyx(KEY_P, true); keyx(KEY_A, false);
    g_caps_lock = true; keyx(KEY_S, false); keyx(KEY_S, true); g_caps_lock = false;
    keyx(KEY_LEFTBRACE, true); keyx(KEY_BACKSLASH, true); keyx(KEY_GRAVE, true); keyx(KEY_KP7, false);
    CHECK("USB keyboard: Shift, Caps Lock, { | ~ and keypad", strcmp(g_st.input_buf, "PaSs{|~7") == 0);

    /* 6. The chain secret's limit: 50 bytes, no more. */
    open_kb(4);
    for (int i = 0; i < 70; i++) key(307);
    CHECK("chain secret stops at 50 bytes", g_st.input_len == 50);

    /* 7. START finishes a chain secret: keyboard closed, sent with its exact case. */
    unlink(CMD_QUEUE_FILE);
    open_kb(4);
    snprintf(g_st.input_buf, sizeof(g_st.input_buf), "Tr0ub4dor&3"); g_st.input_len = 11;
    key(315);
    char sent[200] = "";
    FILE *cf = fopen(CMD_QUEUE_FILE, "r");
    if (cf) { if (!fgets(sent, sizeof(sent), cf)) sent[0] = '\0'; fclose(cf); }
    unlink(CMD_QUEUE_FILE);
    CHECK("START sends the chain secret exactly", !g_st.osk_open && strcmp(sent, "CHAIN_SET|Tr0ub4dor&3|auto|\n") == 0);

    /* 8. SELECT cancels: closed, nothing sent, the draft gone. */
    open_kb(4);
    snprintf(g_st.input_buf, sizeof(g_st.input_buf), "oops"); g_st.input_len = 4;
    key(314);
    CHECK("SELECT cancels", !g_st.osk_open && g_st.input_len == 0 && access(CMD_QUEUE_FILE, F_OK) != 0);

    /* 9. The D-pad wraps around the keys, rows and the special row. */
    open_kb(0);
    key(546); CHECK("left from the first key wraps to the last", g_cmp.col == 9);
    key(544); key(544); CHECK("up twice from row 1 reaches the special row", g_cmp.row == 4 && g_cmp.col == 4);

    /* 10. Every room the Stump has, from the live file; L/R moves by name. */
    memset(&g_st, 0, sizeof(g_st)); g_st.ipc_sock = -1;
    FILE *lf = fopen(LIVE_STATE_FILE, "w");
    fputs("ROOM|0|main|2|local|General|0\nROOM|1|lora-mesh|0|lora||0\nROOM|2|wifi-mesh|3|wifi||1\n"
          "MSG|2|0|5|zoe|hello\nROOM|3|quiz|1||trivia night|0\n", lf);
    fputs("MSG|2|0|6|rod|", lf);                                    /* a 400-character message */
    for (int i = 0; i < 39; i++) fputs("abcdefghi ", lf);
    fputs("abcdefghij\n"
          "FORM|rooms|Rooms|owner\nFIELD|0||info|0|0|Each room reaches|||0||\n"
          "FIELD|1|room:quiz|choice|1|0|#quiz|local|0|local~Wi-Fi chain~LoRa|1 here\n"
          "FIELD|2|new_scope|choice|2|0|A new room reaches|local|0|this Stump~the chain~the LoRa|\n"
          "FIELD|3|new|text|0|32|Create a room||0||its name\n"
          "FIELD|4|f_chat|toggle|1|0|Chat|1|0||Features\n", lf);
    fclose(lf);
    poll_live_bridge();
    CHECK("four rooms, #wifi-mesh on screen", g_st.room_n == 4 && g_st.room_idx == 2 &&
          strcmp(g_st.room_list[3].slug, "quiz") == 0 && g_st.room_counts[2] == 2);
    CHECK("a 400-character message kept whole", strlen(g_st.rooms[2][1].body) == 400 &&
          strcmp(g_st.rooms[2][1].body + 390, "abcdefghij") == 0);
    room_step(1);
    CHECK("R moves to #quiz", strcmp(g_st.view_room, "quiz") == 0);
    poll_live_bridge();                                      /* the feed still says wifi-mesh: L/R wins a while */
    CHECK("the room chosen stays while the feed catches up", strcmp(room_slug(g_st.room_idx), "quiz") == 0);

    /* 11. The OWNER tab: the cursor skips the info row; a choice picked with →
     *     asks first, and Yes sends it. */
    CHECK("the form read, cursor on its first row that does something",
          strcmp(g_st.form_id, "rooms") == 0 && g_st.field_n == 5 && g_st.form_cursor == 1);
    unlink(CMD_QUEUE_FILE);
    form_activate();
    CHECK("A on an unpicked choice sends nothing", access(CMD_QUEUE_FILE, F_OK) != 0 && !g_st.confirm_open);
    form_pick_dir(1);
    form_activate();
    CHECK("a picked choice asks first", g_st.confirm_open && g_st.confirm_type == 4 &&
          strcmp(g_st.pending_cmd, "FORM_SET|rooms|room:quiz|1") == 0 && access(CMD_QUEUE_FILE, F_OK) != 0);
    char got[400] = "";
    #define LAST_CMD() do { got[0] = '\0'; FILE *q = fopen(CMD_QUEUE_FILE, "r"); \
        if (q) { while (fgets(got, sizeof(got), q)) {} fclose(q); } } while (0)

    /* 12. A choice that applies as it's picked; a text row opens the keyboard
     *     on its label and OK sends it; B goes back to the form above. */
    g_st.confirm_open = false;
    form_move(1);
    form_pick_dir(1);
    LAST_CMD();
    CHECK("a page setting applies as it's picked", strcmp(got, "FORM_SET|rooms|new_scope|1\n") == 0);
    form_move(1);
    form_activate();
    CHECK("a text row opens the keyboard on it", g_st.osk_open && g_st.osk_target == 3 && cmp_max_bytes() == 32);
    snprintf(g_st.input_buf, sizeof(g_st.input_buf), "potluck"); g_st.input_len = 7;
    key(315);
    LAST_CMD();
    CHECK("START sends the text to that row", !g_st.osk_open && strcmp(got, "FORM_SET|rooms|new|potluck\n") == 0);
    form_move(1);
    form_activate();
    CHECK("a toggle that asks first", g_st.confirm_open && strcmp(g_st.pending_cmd, "FORM_SET|rooms|f_chat|0") == 0);
    g_st.confirm_open = false;
    form_back();
    LAST_CMD();
    CHECK("B goes back to the form above", strcmp(got, "FORM_OPEN|owner\n") == 0);

    /* 13. "new room…" on the chat deck: the keyboard for a room's name, then ROOM_NEW. */
    g_st.tab_idx = 0; g_st.cmd_cursor = 4;
    execute_rrc_deck_action();
    CHECK("new room opens the keyboard for its name", g_st.osk_open && g_st.osk_target == 2 && cmp_max_bytes() == 32);
    snprintf(g_st.input_buf, sizeof(g_st.input_buf), "jardin"); g_st.input_len = 6;
    key(315);
    LAST_CMD();
    CHECK("... and sends ROOM_NEW", strcmp(got, "ROOM_NEW|jardin\n") == 0);

    /* 14. Every command it knows, in a menu: one without arguments is sent at
     *     once; one with them opens the keyboard, written up to its first. */
    memset(&g_st, 0, sizeof(g_st)); g_st.ipc_sock = -1;
    lf = fopen(LIVE_STATE_FILE, "w");
    fputs("ROOM|0|main|0|local||0\nROOM|1|wifi-mesh|0|wifi||1\n", lf);
    for (int i = 1; i <= 30; i++) fprintf(lf, "MSG|1|0|%d|zoe|line %d\n", i, i);
    fputs("CMD|0|Chat|/who|/who|0|0|who is here\n"
          "CMD|1|Chat|/msg|/msg <who> <text>|1|0|a private message\n"
          "CMD|2|Owner|/setchan|/setchan \xe2\x80\xa2 #room -local\xc2\xa6-wifi|1|1|a room's reach\n"
          "CMD|3|Owner|/fsadd|/fsadd \xe2\x80\xa2 <trigger> :: <response>|1|1|a trigger\n"
          "CMD|4|Pack: simple 1.0|/roll|/roll <dice>|1|0|roll dice\n", lf);
    fclose(lf);
    poll_live_bridge();
    CHECK("the commands read", g_st.cmd_n == 5 && strcmp(g_st.cmds[2].word, "/setchan") == 0 && g_st.cmds[2].pw);
    CHECK("thirty messages kept, the newest at the bottom", g_st.room_counts[1] == 30 && g_st.chat_scroll == 0);
    g_st.tab_idx = 0; g_st.cmd_cursor = 5;
    execute_rrc_deck_action();
    CHECK("all commands… opens the menu", g_st.menu_open && g_st.menu_cursor == 0);
    unlink(CMD_QUEUE_FILE);
    menu_activate();
    LAST_CMD();
    CHECK("a command without arguments is sent at once", !g_st.menu_open && strcmp(got, "RRC|wifi-mesh|/who\n") == 0);
    menu_open(); menu_move(1); menu_activate();
    CHECK("one with arguments: the keyboard, up to its first", g_st.osk_open && strcmp(g_st.input_buf, "/msg ") == 0);
    g_st.osk_open = false;
    menu_open(); menu_group(1);
    CHECK("→ jumps to the next group", g_st.menu_cursor == 2);
    menu_activate();
    CHECK("the password's place kept as •", strcmp(g_st.input_buf, "/setchan \xe2\x80\xa2 ") == 0);
    g_st.osk_open = false;
    menu_open();
    CHECK("the menu opens where it was left", g_st.menu_cursor == 2);
    menu_group(-1);
    CHECK("← to the group before", g_st.menu_cursor == 0);
    menu_group(-1);
    CHECK("← from the first group wraps to the last", g_st.menu_cursor == 4);
    menu_move(1);
    CHECK("↓ from the last command wraps to the first", g_st.menu_cursor == 0);
    g_st.menu_open = false;

    /* 15. Scrolling the chat: older up, newer down; it stays put as new ones come. */
    for (int i = 0; i < 5; i++) chat_scroll_by(-1);
    CHECK("up five: five newer hidden", g_st.chat_scroll == 5);
    chat_scroll_by(1);
    CHECK("down one", g_st.chat_scroll == 4);
    for (int i = 0; i < 60; i++) chat_scroll_by(-1);
    CHECK("up stops at the oldest (30 lines and the /who sent)", g_st.chat_scroll == g_st.room_counts[1] - 1);
    for (int i = 0; i < 60; i++) chat_scroll_by(1);
    CHECK("down stops at the newest", g_st.chat_scroll == 0);
    for (int i = 0; i < 3; i++) chat_scroll_by(-1);
    lf = fopen(LIVE_STATE_FILE, "a");
    fputs("MSG|1|0|31|rod|new one\nMSG|1|0|32|rod|and another\n", lf);
    fclose(lf);
    g_st.suppress_poll_frames = 0;                          /* (paused a moment after a send) */
    poll_live_bridge();
    CHECK("new messages keep a scrolled view where it is", g_st.chat_scroll == 5);

    /* 16. The sticks: past half-way a step at once, then repeats while held. */
    g_axes[3][ABS_Y].ok = true; g_axes[3][ABS_Y].min = 0; g_axes[3][ABS_Y].max = 4095;
    g_axes[3][ABS_RX].ok = true; g_axes[3][ABS_RX].min = -1800; g_axes[3][ABS_RX].max = 1800;
    CHECK("an axis that isn't a stick is ignored", stick_event(3, ABS_X, 4000) && g_st.stick_ax[ABS_X] == 0);
    CHECK("not a stick axis: left to the buttons", !stick_event(3, ABS_HAT0Y, 1));
    stick_event(3, ABS_Y, 2200);                            /* a little off centre: jitter */
    stick_tick(1000);
    CHECK("jitter does nothing", g_st.chat_scroll == 5);
    stick_event(3, ABS_Y, 100);                             /* pushed up */
    stick_tick(1000);
    CHECK("pushed up: one older at once", g_st.chat_scroll == 6);
    stick_tick(1200);
    CHECK("... then a wait", g_st.chat_scroll == 6);
    stick_tick(1350); stick_tick(1460);
    CHECK("... then repeats while held", g_st.chat_scroll == 8);
    stick_event(3, ABS_Y, 1200);                            /* eased back, still past a third: held */
    stick_tick(1570);
    CHECK("held until it's let go", g_st.chat_scroll == 9);
    stick_event(3, ABS_Y, 2048);
    stick_tick(1700);
    CHECK("let go: it stops", g_st.chat_scroll == 9);
    stick_event(3, ABS_RX, 1700);                           /* the right stick, → */
    stick_tick(2000);
    CHECK("→ on the chat tab moves to the next room", g_st.room_idx == 0);
    stick_event(3, ABS_RX, 0);
    stick_tick(2100);
    g_st.tab_idx = 5; g_st.form_cursor = 1;
    stick_step(0, 1);
    CHECK("on OWNER the stick moves the form's cursor", g_st.form_cursor != 1 || g_st.field_n <= 1);
    g_st.menu_open = true; g_st.menu_cursor = 0;
    stick_step(0, 1);
    CHECK("with the menu open it moves the menu", g_st.menu_cursor == 1);
    g_st.menu_open = false;

    unlink(CMD_QUEUE_FILE);
    unlink(LIVE_STATE_FILE);

    printf(fails ? "FAILURES %d\n" : "all passed\n", fails);
    return fails ? 1 : 0;
}
