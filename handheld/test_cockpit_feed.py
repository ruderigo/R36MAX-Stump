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


class AsciiLine(unittest.TestCase):
    def test_room_activity_symbols_in_words(self):
        self.assertEqual(F.ascii_line("✓ rod"), "+ rod joined")
        self.assertEqual(F.ascii_line("✗ ~rod"), "- rod left")
        self.assertEqual(F.ascii_line("✎ rod → bob"), "rod is now bob")
        self.assertEqual(F.ascii_line("✎ #main market at 10"), "#main topic: market at 10")
        self.assertEqual(F.ascii_line("⊖ ghost"), "no one here is called ghost")
        self.assertEqual(F.ascii_line("⧗ — slow"), "(slow down) - slow")

    def test_accents_folded_and_rest_dropped(self):
        self.assertEqual(F.ascii_line("café à Montréal \U0001F332"), "cafe a Montreal ")


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
        self.assertIn("MSG|2|1|*|+ rod joined", lines)
        self.assertIn("MSG|2|0|rod@LaBuche3|hi / there", lines)
        self.assertEqual(get("FILE")[0], "FILE|a_ b.txt|2|DOC")
        self.assertEqual(feed.full_names["a_ b.txt"], "a, b.txt")  # deletes reach the real name
        for l in lines:
            self.assertTrue(all(32 <= ord(c) < 127 for c in l), l)


if __name__ == "__main__":
    unittest.main(verbosity=1)
