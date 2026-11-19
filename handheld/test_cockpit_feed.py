#!/usr/bin/env python3
"""Tests for cockpit_feed.py's pure parts (no Stump needed):
    python3 handheld/test_cockpit_feed.py
The whole path (feed + engine + a real stock Stump, chained) was tested by
running them together; see handheld/README.md "How it was tested"."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cockpit_feed as F  # noqa: E402


class ScreenLine(unittest.TestCase):
    def test_with_the_font_text_stays_as_sent(self):
        self.assertIsNotNone(F.font_chars())                 # cockpit_font.bin is next to the feed
        self.assertEqual(F.screen_line("\u2713 ~rod"), "\u2713 ~rod")
        self.assertEqual(F.screen_line("\u270e rod \u2192 bob"), "\u270e rod \u2192 bob")
        self.assertEqual(F.screen_line("caf\u00e9 \u00e0 Montr\u00e9al"), "caf\u00e9 \u00e0 Montr\u00e9al")
        self.assertEqual(F.screen_line("LaBuche_Cabin"), "LaBuche_Cabin")      # case kept

    def test_what_the_font_lacks_is_folded_or_dropped(self):
        self.assertEqual(F.screen_line("\u29d7 \u2014 slow"), "(slow down) \u2014 slow")
        self.assertEqual(F.screen_line("tree \U0001F332 \u0103"), "tree  a")

    def test_without_the_font_ascii_and_words(self):
        old = list(F._FONT_CHARS)
        F._FONT_CHARS[:] = [None]
        try:
            self.assertEqual(F.screen_line("\u2713 rod"), "+ rod joined")
            self.assertEqual(F.screen_line("\u2717 ~rod"), "- rod left")
            self.assertEqual(F.screen_line("caf\u00e9"), "cafe")
        finally:
            F._FONT_CHARS[:] = old

    def test_clip_cuts_between_characters(self):
        self.assertEqual(F.clip("\u00e9t\u00e9", 4), "\u00e9t")
        self.assertEqual(F.clip("abc", 45), "abc")


class Fields(unittest.TestCase):
    def test_clean_never_breaks_the_line_format(self):
        self.assertEqual(F.clean("a|b\nc\td", 60), "a/b c d")
        self.assertEqual(len(F.clean("x" * 100, 44)), 44)

    def test_nmcli_terse_split(self):
        self.assertEqual(F._split_nm(r"*:72:WPA2:Bob\:s net"), ["*", "72", "WPA2", "Bob:s net"])
        self.assertEqual(F._split_nm("wlan0:wifi:connected:Stump-Hotspot"),
                         ["wlan0", "wifi", "connected", "Stump-Hotspot"])


class Config(unittest.TestCase):
    def test_read_as_data_never_executed(self):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "config.py"), "w") as f:
            f.write("import os\nNODE_NAME = 'R36'\nPC_STORAGE_MB = 4096\n"
                    "AUTH_ADMIN_PASSWORD = 'pw'\nX = os.system('touch %s/ran')\n" % d)
        old, F.STUMP_DIR = F.STUMP_DIR, d
        try:
            cfg = F.read_config()
        finally:
            F.STUMP_DIR = old
        self.assertEqual((cfg["NODE_NAME"], cfg["PC_STORAGE_MB"]), ("R36", 4096))
        self.assertNotIn("X", cfg)
        self.assertFalse(os.path.exists(os.path.join(d, "ran")))


class Live(unittest.TestCase):
    def test_live_lines_match_the_engine_parser(self):
        feed = F.Feed()
        feed.node = {"lxmf": "ab" * 16, "release": "1.0.0-beta.42", "ap_ip": "10.42.0.1"}
        feed.stump.port = 80
        feed.chain = {"enabled": True, "role": "member", "secret": True, "chain": "d2a0d48a8da3",
                      "uplink": {"parent": "192.168.0.173", "parent_heard_s": 3}, "below": []}
        feed.msgs["wifi-mesh"] = [{"id": 1, "kind": "system", "nick": "*", "body": "✓ rod"},
                                  {"id": 2, "kind": "msg", "nick": "rod@LaBuche3", "body": "hi | there"}]
        feed.board = [{"id": "1793456586.959009450", "title": "Potluck", "body": "", "sig": "647c"}]
        feed.files = [{"name": "a, b.txt", "size": 3000, "cat": "document", "mtime": 1}]
        lines = feed.live_lines()
        get = lambda k: [l for l in lines if l.startswith(k + "|")]
        self.assertEqual(get("VER")[0].split("|")[3:6], ["1", "0", "10.42.0.1"])
        chain = get("CHAIN")[0].split("|")
        self.assertEqual(len(chain), 9)
        self.assertEqual(chain[1:4], ["1", "2", "1"])
        self.assertNotIn("secret", chain[4])                       # the secret itself is never shown
        self.assertIn("MSG|2|1|1|*|\u2713 rod", lines)                 # room, system, its id, nick, text
        self.assertIn("MSG|2|0|2|rod@LaBuche3|hi / there", lines)
        self.assertEqual(get("FILE")[0], "FILE|a_ b.txt|2|DOC")
        self.assertEqual(feed.full_names["a_ b.txt"], "a, b.txt")  # deletes reach the real name
        chars = F.font_chars()
        for l in lines:
            self.assertTrue(all(c in chars or c == "|" for c in l), l)   # only what the font can draw

    def test_a_long_message_comes_whole(self):
        """The Stump takes up to 400 characters a line: all of it reaches the cockpit."""
        feed = F.Feed()
        body = ("Rendez-vous samedi \u00e0 10 h au jardin, apportez des gants. " * 7)[:400]
        feed.msgs["wifi-mesh"] = [{"id": 1, "kind": "msg", "nick": "zoe", "body": body}]
        line = [l for l in feed.live_lines() if l.startswith("MSG|")][0]
        self.assertEqual(line.split("|", 5)[5], body.strip())

    def test_ssids_shown_map_back_to_the_real_name(self):
        feed = F.Feed()
        feed.net["ssids"] = [{"active": True, "signal": 70, "sec": "WPA2", "ssid": "Caf\u00e9 \U0001F332 Guest|5G"}]
        line = [l for l in feed.live_lines() if l.startswith("SSID|")][0]
        shown = line.split("|", 4)[4]
        self.assertEqual(feed.full_ssids[shown], "Caf\u00e9 \U0001F332 Guest|5G")


PAGE = """<h1>Admin</h1><p class='sub'><b>Saved. &amp; it&#39;s live.</b></p>
<form method='POST' action='/admin/setup'><input type='hidden' name='admin_pass' value='tok'>
<details class='inner'><summary>Names <span class='pk'>Oak · Bot</span></summary>
<label>Stump's name<br><input name='node_name' maxlength='20' required value='Oak'></label>
<label>Greeting<br><textarea name='greeting' maxlength='200'>Hi &amp; welcome</textarea></label></details>
<details class='inner'><summary>Language <span class='pk'>English</span></summary>
<label class='opt'><input type='radio' name='default_lang' value='fr'> Français</label>
<label class='opt'><input type='radio' name='default_lang' value='en' checked> English</label></details>
<details class='inner'><summary>Features</summary>
<label class='opt'><input type='checkbox' name='f_chat' value='1' checked> Chat</label>
<label class='opt'><input type='checkbox' name='f_about' value='1'> About</label>
<label class='opt'><input type='checkbox' name='keep_awake' value='1' disabled> Keep awake</label>
<button type='submit' formaction='/admin/announce'>Announce now</button></details>
<button type='submit'>Save</button></form><form action='/admin/logout'></form>"""


class AdminForms(unittest.TestCase):
    def test_read_as_a_browser_reads_it(self):
        f = F.parse_forms(PAGE)
        self.assertEqual(sorted(f), ["/admin/logout", "/admin/setup"])
        c = {x["name"] + ("=" + x["value"] if x["type"] == "radio" else ""): x for x in f["/admin/setup"]}
        self.assertEqual((c["node_name"]["label"], c["node_name"]["value"], c["node_name"]["group"]),
                         ("Stump's name", "Oak", "Names"))
        self.assertEqual(c["greeting"]["value"], "Hi & welcome")
        self.assertEqual((c["default_lang=en"]["checked"], c["default_lang=en"]["label"]), (True, "English"))
        self.assertEqual(c["default_lang=fr"]["group"], "Language")          # the preview isn't the title
        self.assertTrue(c["keep_awake"]["disabled"])
        self.assertNotIn("Announce now", [x["label"] for x in f["/admin/setup"]])   # buttons aren't fields
        self.assertEqual(F.page_notice(PAGE), "Saved. & it's live.")

    def test_submitted_as_a_browser_submits_it(self):
        ctl = F.parse_forms(PAGE)["/admin/setup"]
        body = F.form_body(ctl, {})
        self.assertEqual(body, "admin_pass=tok&node_name=Oak&greeting=Hi%20%26%20welcome&default_lang=en&f_chat=1")
        body = F.form_body(ctl, {"f_about": "1", "f_chat": "0", "default_lang": "fr", "admin_pass": "pw"})
        self.assertEqual(body, "admin_pass=pw&node_name=Oak&greeting=Hi%20%26%20welcome&default_lang=fr&f_about=1")

    def test_the_settings_form_rows(self):
        feed = F.Feed()
        feed.admin_pw = lambda: "pw"
        feed.setup, feed.form = F.parse_forms(PAGE)["/admin/setup"], "setup"
        title, parent, rows = feed.form_rows()
        self.assertEqual((title, parent), ("Stump settings", "owner"))
        kinds = [(r["key"], r["kind"]) for r in rows]
        self.assertEqual(kinds, [("node_name", "text"), ("greeting", "text"), ("default_lang", "choice"),
                                 ("f_chat", "toggle"), ("f_about", "toggle"), ("keep_awake", "toggle")])
        lang = rows[2]
        self.assertEqual((lang["options"], lang["sel"], lang["label"]), (["Français", "English"], 1, "Language"))
        self.assertEqual(rows[0]["max"], 20)

    def test_no_admin_password_one_can_be_made_here(self):
        feed = F.Feed()
        feed.admin_pw = lambda: ""
        title, _, rows = feed.form_rows()
        self.assertEqual([(r["kind"], r["key"]) for r in rows], [("info", ""), ("text", "setpw"), ("action", "makepw")])
        made = []
        feed.make_password = lambda: made.append(1) or "made"
        feed.form_set("owner", "makepw", "")
        self.assertEqual(made, [1])


class Rooms(unittest.TestCase):
    def feed(self, answers):
        feed = F.Feed()
        feed.stump.port = 80
        feed.admin_pw = lambda: "pw"
        sent = []

        def send(line):
            sent.append(line)
            return answers.get(line.split(" ")[0], [])
        feed.stump.send = send
        return feed, sent

    def test_every_room_the_stump_has(self):
        feed, sent = self.feed({
            "/rooms": ["#main \u00b72  General", "#lora-mesh \u00b70  \u2298 No LoRa", "#quiz \u00b71  trivia night",
                       "#jardin \u00b70  [Wi-Fi]", "#bad name \u00b71"],
            "/setchan": ["#lora-mesh  lora", "#main  local", "#wifi-mesh  wifi", "#jardin  wifi"]})
        feed.refresh_rooms()
        self.assertEqual(sent, ["/rooms", "/setchan pw"])
        self.assertEqual(feed.room_order, ["main", "lora-mesh", "wifi-mesh", "quiz", "jardin"])
        self.assertEqual(feed.room_info["quiz"], {"count": 1, "topic": "trivia night", "scope": ""})
        self.assertEqual(feed.room_info["jardin"], {"count": 0, "topic": "", "scope": "wifi"})
        feed.want_room = "quiz"
        lines = feed.live_lines()
        rooms = [l for l in lines if l.startswith("ROOM|")]
        self.assertEqual(rooms[3], "ROOM|3|quiz|0||trivia night|1")      # on screen: its own people count
        self.assertEqual(rooms[4], "ROOM|4|jardin|0|wifi||0")

    def test_a_new_room(self):
        feed, sent = self.feed({"/create": ["\u2717 #jardin exists"]})
        feed.new_room("Jardin Club!", "local")
        self.assertEqual(sent[-1], "/join #jardin-club")
        self.assertEqual(feed.want_room, "jardin-club")
        feed.new_room("jardin", "lora")
        self.assertEqual(sent[-1], "/create pw #jardin -lora confirm")      # refused: not joined
        self.assertEqual(feed.want_room, "jardin-club")
        feed.new_room("  ", "local")
        self.assertIn("letters, digits", feed.busy_msg)

    def test_owner_commands_carry_the_password(self):
        feed, sent = self.feed({})
        feed.stump.room = "quiz"
        feed.form_set("rooms", "room:quiz", "1")
        feed.form_set("people", "p:zoe", str(F.MOD_ACTS.index("ban") + 1))
        feed.form_set("people", "where", "1")
        feed.form_set("people", "p:zoe", str(F.MOD_ACTS.index("kick") + 1))     # a kick: one room, always
        feed.form_set("people", "p:zoe", str(F.MOD_ACTS.index("mute") + 1))
        feed.form_set("rooms", "req:2", "2")
        feed.form = "rooms"
        self.assertEqual(sent, ["/setchan pw #quiz -wifi", "/ban pw #quiz zoe", "/kick pw #quiz zoe",
                                "/mute pw -stump zoe", "/chanreq pw -r 2"])
        lines = feed.live_lines()
        self.assertTrue(any(l.startswith("FORM|rooms|Rooms|owner") for l in lines))
        for l in [l for l in lines if l.startswith("FIELD|")]:
            self.assertEqual(len(l.split("|")), 11, l)


class Scrollback(unittest.TestCase):
    def test_the_rooms_history_and_long_lists(self):
        feed = F.Feed()
        feed.msgs["wifi-mesh"] = [{"id": i, "kind": "msg", "nick": "zoe", "body": "line %d" % i} for i in range(1, 61)]
        feed.board = [{"id": str(i), "title": "n%d" % i, "body": "", "sig": "x"} for i in range(30)]
        feed.files = [{"name": "f%d" % i, "size": 10, "cat": "document", "mtime": i} for i in range(30)]
        lines = feed.live_lines()
        msgs = [l for l in lines if l.startswith("MSG|")]
        self.assertEqual(len(msgs), 60)                                   # all the Stump keeps
        self.assertEqual(msgs[0], "MSG|2|0|1|zoe|line 1")
        self.assertEqual(len([l for l in lines if l.startswith("BOARD|")]), 20)
        self.assertEqual(len([l for l in lines if l.startswith("FILE|")]), 20)


class Commands(unittest.TestCase):
    def feed(self, cfg="AUTH_ADMIN_PASSWORD = ''\nFSERVBOT_OP_PASSWORD = 'op-pw'\n"):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "config.py"), "w") as f:
            f.write(cfg)
        self.addCleanup(setattr, F, "STUMP_DIR", F.STUMP_DIR)
        F.STUMP_DIR = d
        feed = F.Feed()
        feed.stump.port = 80
        return feed

    def test_admin_password_as_the_stump_checks_it(self):
        self.assertEqual(self.feed().admin_pw(), "op-pw")                 # blank /admin's: the fserv operator's
        self.assertEqual(self.feed("AUTH_ADMIN_PASSWORD = 'adm'\nFSERVBOT_OP_PASSWORD = 'op'\n").admin_pw(), "adm")
        self.assertEqual(self.feed("NODE_NAME = 'x'\n").admin_pw(), "")

    def test_every_command_it_knows(self):
        feed = self.feed()
        answers = {
            "/help": ["/nick <name>       change your name", "/msg <who> <text> a private message only they see",
                      "/post <title> | <text> a new notice", "/clear            clear your own view",
                      "!fserv !help     the file bot  (/fshelp to set it up)",
                      "\u2713 joined \u00b7 \u2717 left", "/roll <dice>   roll dice"],
            "/help mods": ["/op <admin password> <#room|-stump> <nick> : makes an op", "/unban <#room|-stump> <nick>"],
            "/setchan": ["/setchan <password> #room -local|-wifi|-lora (or /setchan <password> : the rooms and their reach)"],
            "/chanreq": ["/chanreq <password> : LoRa rooms other Stumps offer"],
            "/fshelp": ["fserv bot -- channel triggers start with '!'", "/fsadd <pw> <trigger> :: <response>   add one",
                        "/fslist                               show active triggers"],
            "/fslist": ["active: !about, !files, !find"]}
        feed.stump.send = lambda line: answers.get(line, [])
        feed.stump.get = lambda path: {"plugins": [{"name": "simple", "version": "1.0", "commands": ["roll", "8ball"]},
                                                   {"name": "stumpid", "version": "1.1", "commands": ["whoami"]}]}
        feed.refresh_commands()
        got = {c["syntax"]: c for c in feed.catalog}
        self.assertIn("/msg <who> <text>", got)
        self.assertEqual(got["/msg <who> <text>"]["desc"], "a private message only they see")
        self.assertEqual(got["/post <title> | <text>"]["args"], True)
        self.assertEqual(got["/clear"]["args"], False)
        self.assertEqual(got["/op \u2022 <#room|-stump> <nick>"]["pw"], True)        # • where the password goes
        self.assertIn("/setchan \u2022 #room -local|-wifi|-lora", got)
        self.assertIn("/fsadd \u2022 <trigger> :: <response>", got)
        self.assertEqual({c["word"] for c in feed.catalog if c["group"] == "File bot: its words"},
                         {"!fserv", "!help", "!about", "!files", "!find"})
        self.assertEqual(got["/roll <dice>"]["group"], "Pack: simple 1.0")           # a pack's, under its name
        self.assertEqual(got["/8ball"]["group"], "Pack: simple 1.0")                 # no help: still listed
        self.assertIn("/create \u2022 #room -local|-wifi|-lora", got)                 # from the command reference
        lines = [l for l in feed.live_lines() if l.startswith("CMD|")]
        self.assertTrue(all(len(l.split("|")) == 8 for l in lines), lines[:3])
        self.assertTrue(any("<#room\u00a6-stump>" in l for l in lines))           # | shown as ¦

    def test_the_password_is_filled_in_here(self):
        feed = self.feed()
        self.assertEqual(feed.fill_password("/setchan \u2022 #quiz -wifi"), "/setchan op-pw #quiz -wifi")
        self.assertEqual(feed.fill_password("hello \u2022 there"), "hello \u2022 there")    # not a command
        self.assertEqual(feed.fill_password("/msg zoe \u2022"), "/msg zoe \u2022")          # not its place

    def test_no_password_one_can_be_typed_or_made(self):
        feed = self.feed("NODE_NAME = 'x'\n")
        _, _, rows = feed.form_rows()
        self.assertEqual([r["key"] for r in rows], ["", "setpw", "makepw"])
        self.assertEqual(rows[1]["value"], "")                                    # never shown on the row

    def stump_with_settings(self, cfg):
        """A scratch Stump folder: its config.py and a settings.write_config as the Stump's."""
        feed = self.feed(cfg)
        with open(os.path.join(F.STUMP_DIR, "settings.py"), "w") as f:
            f.write("def write_config(values, path):\n"
                    "    lines = [l for l in open(path).read().splitlines() if l.split(' =')[0] not in values]\n"
                    "    lines += ['%s = %r' % kv for kv in values.items()]\n"
                    "    open(path, 'w').write('\\n'.join(lines) + '\\n')\n"
                    "    return True\n")
        feed.restarts = []
        feed.restart_stump = feed.restarts.append
        return feed

    def test_typed_on_the_handheld_set_then_changed(self):
        feed = self.stump_with_settings("NODE_NAME = 'x'\n")
        feed.form_set("owner", "setpw", "jardin-2026")
        self.assertEqual(feed.admin_pw(), "jardin-2026")
        self.assertTrue(os.path.isfile(os.path.join(F.STUMP_DIR, "config.py.bak")))
        self.assertEqual(len(feed.restarts), 1)                                   # the Stump restarts to take it
        _, _, rows = feed.form_rows()
        self.assertIn("setpw", [r["key"] for r in rows])                          # now: change it
        self.assertEqual([r["label"] for r in rows if r["key"] == "setpw"], ["Change the admin password"])
        feed.form_set("owner", "setpw", "potager|99")                             # (| refused)
        self.assertEqual(feed.admin_pw(), "jardin-2026")
        feed.form_set("owner", "setpw", "potager99")
        self.assertEqual(feed.admin_pw(), "potager99")
        self.assertEqual(len(feed.restarts), 2)

    def test_deletes_use_the_password_the_stump_takes(self):
        feed = self.feed()                                # /admin's blank, the fserv operator's set
        posted = []
        feed.stump.post = lambda path, body, *a, **k: posted.append((path, body)) or (200, "")
        feed._admin_delete("/admin/delete_post", "ts", ["123"], "NOTICE")
        self.assertEqual(posted, [("/admin/delete_post", "ts=123&admin_pass=op-pw")])

    def test_locked_out_is_told_by_the_stumps_answers(self):
        L = F.Feed.locked_out
        self.assertTrue(L("hello", ["auth required for that -- send /auth to verify your identity"]))
        self.assertTrue(L("/join quiz", ["cette salle exige une identit\u00e9 v\u00e9rifi\u00e9e \u2014 envoie /auth d'abord"]))
        self.assertTrue(L("/whoami", ["not verified this session -- /auth to prove an identity"]))
        self.assertFalse(L("/help", ["/auth   prove an identity"]))                    # its list of commands
        self.assertFalse(L("/auth", ["AUTH-CHALLENGE 00ff"]))
        self.assertFalse(L("hello", []))

    def test_a_commands_answer_shown_in_the_room(self):
        feed = self.feed()
        feed.stump.port, feed.stump.room = 80, "wifi-mesh"
        feed.stump.send = lambda line: ["verified as abcd  nick=r36max"] if line == "/whoami" else []
        feed.handle("RRC|wifi-mesh|/whoami")
        self.assertIn("MSG|2|1|0|*|verified as abcd  nick=r36max", feed.live_lines())

    def test_a_typed_password_it_wont_take(self):
        feed = self.stump_with_settings("AUTH_ADMIN_PASSWORD = 'keep-me'\n")
        for bad in ("abc", "two words", "pw\u2022x", ""):
            with self.subTest(bad):
                self.assertTrue(feed.password_problem(bad))
                feed.form_set("owner", "setpw", bad)
                self.assertEqual(feed.admin_pw(), "keep-me")
        self.assertEqual(feed.restarts, [])
        self.assertEqual(feed.password_problem("caf\u00e9-1"), "")                  # accents are fine


if __name__ == "__main__":
    unittest.main(verbosity=1)
