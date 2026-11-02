/* The cockpit's keyboard (FireFly's Compose), driven with the R36MAX's real
 * button codes and a USB keyboard's, checked on what ends up typed.
 *   gcc -O2 -Dmain=engine_main -o test_keyboard tests/test_keyboard.c -lasound -lpthread -ldl -lm && ./test_keyboard
 */
#define CMD_QUEUE_FILE "/tmp/stump_test_keyboard_cmd.txt"   /* never the real one */
#include "../stump_r36max_engine.c"
#undef main

static int fails = 0;
#define CHECK(name, cond) do { if (cond) printf("PASS %s\n", name); \
    else { printf("FAIL %s  (buffer \"%s\")\n", name, g_st.input_buf); fails++; } } while (0)

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

    printf(fails ? "FAILURES %d\n" : "all passed\n", fails);
    return fails ? 1 : 0;
}
