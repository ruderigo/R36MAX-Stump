#!/usr/bin/env python3
"""Tests for limbs.py (the Wi-Fi cards and their jobs) and the feed around
it, with a fake /sys and a fake NetworkManager that keeps state:
    python3 handheld/test_limbs.py
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import limbs as L  # noqa: E402
import cockpit_feed as F  # noqa: E402

# `iw list` on the R36MAX (2026-11-02): the Blueway, as it answered.
IW_BLUEWAY = """Wiphy phy1
\tSupported interface modes:
\t\t * IBSS
\t\t * managed
\t\t * AP
\t\t * AP/VLAN
\t\t * WDS
\t\t * monitor
\tBand 1:
\t\tCapabilities: 0x17e
\tvalid interface combinations:
\t\t * #{ AP, mesh point } <= 8, #{ managed } <= 1,
"""
IW_DUAL = IW_BLUEWAY.replace("Wiphy phy1", "Wiphy phy2").replace(
    "\tvalid interface", "\tBand 2:\n\t\tCapabilities: 0x1ff\n\tvalid interface")
IW_NO_AP = """Wiphy phy3
\tSupported interface modes:
\t\t * managed
\t\t * monitor
\tBand 1:
"""


def _w(path, text):
    with open(path, "w") as f:
        f.write(text)


class FakeSys:
    """/sys/class/net and /sys/class/ieee80211 with USB cards plugged in."""
    def __init__(self):
        self.root = tempfile.mkdtemp()
        self.net = os.path.join(self.root, "net")
        self.phy = os.path.join(self.root, "ieee80211")
        os.makedirs(self.net)
        os.makedirs(self.phy)
        self.iw = {}

    def plug(self, iface, phy, mac, usb, driver, iw):
        p = os.path.join(self.phy, phy)
        os.makedirs(p, exist_ok=True)
        _w(os.path.join(p, "macaddress"), mac + "\n")
        port = os.path.join(self.root, "usb", phy)
        intf = os.path.join(port, phy + ":1.0")
        drv = os.path.join(self.root, "drivers", driver)
        os.makedirs(intf, exist_ok=True)
        os.makedirs(drv, exist_ok=True)
        vid, pid = usb.split(":")
        _w(os.path.join(port, "idVendor"), vid + "\n")
        _w(os.path.join(port, "idProduct"), pid + "\n")
        if not os.path.exists(os.path.join(intf, "driver")):
            os.symlink(drv, os.path.join(intf, "driver"))
        d = os.path.join(self.net, iface)
        os.makedirs(d)
        os.symlink(p, os.path.join(d, "phy80211"))
        os.symlink(intf, os.path.join(d, "device"))
        _w(os.path.join(d, "address"), "02:00:00:00:00:99\n")   # a random one: not the key
        self.iw[phy] = iw

    def unplug(self, iface):
        import shutil
        shutil.rmtree(os.path.join(self.net, iface))


class FakeNM:
    """nmcli: devices, saved connections, up/down; EmulationStation's network
    comes back on a card when its AP goes down, as NetworkManager does."""
    def __init__(self):
        self.dev = {}          # iface -> [state, connection]
        self.es = {}           # iface -> EmulationStation's connection there
        self.cons = {}         # name -> {prop: value}
        self.calls = []

    def on_es(self, iface, name):
        self.dev[iface] = ["connected", name]
        self.es[iface] = name

    def idle(self, iface):
        self.dev[iface] = ["disconnected", ""]

    def __call__(self, *a, timeout=25):
        self.calls.append(a)
        if a[:4] == ("-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"):
            return True, "\n".join("%s:wifi:%s:%s" % (i, s, c) for i, (s, c) in sorted(self.dev.items()))
        if a[:5] == ("-t", "-f", "NAME,AUTOCONNECT", "connection", "show"):
            return True, "\n".join("%s:%s" % (n, p.get("connection.autoconnect", "yes")) for n, p in self.cons.items())
        if a[:2] == ("-t", "-g"):
            p = self.cons.get(a[-1])
            if not p:
                return False, "no such connection"
            fields = a[2].split(",")
            vals = [p.get(f, "").replace(":", "\\:") for f in fields]
            return True, ":".join(vals)
        if a[:2] == ("connection", "add"):
            args = list(a[2:])
            props = dict(zip(args[0::2], args[1::2]))
            props["connection.autoconnect"] = props.get("connection.autoconnect", "yes")
            props["802-11-wireless.ssid"] = props.get("ssid", "")
            self.cons[props["con-name"]] = props
            return True, ""
        if a[:2] == ("connection", "delete"):
            return (self.cons.pop(a[2], None) is not None), ""
        if a[:2] == ("connection", "modify"):
            if a[2] not in self.cons:
                return False, "no such connection"
            self.cons[a[2]][a[3]] = a[4]
            return True, ""
        if a[:2] == ("connection", "up"):
            iface = a[a.index("ifname") + 1]
            self.dev[iface] = ["connected", a[2]]
            return True, ""
        if a[:2] == ("connection", "down"):
            for i, d in self.dev.items():
                if d[1] == a[2]:
                    self.dev[i] = ["connected", self.es[i]] if i in self.es else ["disconnected", ""]
                    return True, ""
            return False, "not active"
        return True, ""


def setup(cards=("blueway",), state_file=None):
    fs, nm = FakeSys(), FakeNM()
    if "blueway" in cards:
        fs.plug("wlan0", "phy1", "00:0F:00:5E:11:ED", "148f:3070", "rt2800usb", IW_BLUEWAY)
        nm.on_es("wlan0", "HomeNet")
    if "dual" in cards:
        fs.plug("wlan1", "phy2", "aa:bb:cc:00:00:02", "148f:5572", "rt2800usb", IW_DUAL)
        nm.idle("wlan1")
    if "noap" in cards:
        fs.plug("wlan2", "phy3", "aa:bb:cc:00:00:03", "1234:abcd", "oddwifi", IW_NO_AP)
        nm.idle("wlan2")
    lb = L.Limbs(nmcli=nm, iw_phy=lambda phy: fs.iw.get(phy, ""), iw_dev=lambda i: "",
                 sys_net=fs.net, sys_phy=fs.phy, state_file=state_file,
                 config=lambda: {"PC_HOTSPOT_NAME": "R36Test-Stump", "NODE_NAME": "R36Test"})
    return fs, nm, lb


BLUEWAY = "00:0f:00:5e:11:ed"
DUAL = "aa:bb:cc:00:00:02"


class Cards(unittest.TestCase):
    def test_the_r36max_blueway_as_iw_reports_it(self):
        modes, bands = L.parse_iw_phy(IW_BLUEWAY)
        self.assertIn("AP", modes)
        self.assertNotIn("#{", " ".join(modes))               # interface combinations aren't modes
        self.assertEqual(bands, {1})
        self.assertEqual(L.parse_iw_phy(IW_DUAL)[1], {1, 2})
        self.assertNotIn("AP", L.parse_iw_phy(IW_NO_AP)[0])

    def test_cards_listed_by_hardware_with_their_job(self):
        fs, nm, lb = setup(("blueway", "dual", "noap"))
        cards = {c["key"]: c for c in lb.scan()}
        b = cards[BLUEWAY]                                       # the phy's MAC, not the interface's
        self.assertEqual((b["name"], b["driver"], b["usb"], b["ap_ok"]), ("Blueway High Power", "rt2800usb",
                                                                          "148f:3070", True))
        self.assertEqual((b["job"], b["info"]), ("lan", "HomeNet"))
        self.assertEqual((cards[DUAL]["job"], cards[DUAL]["bands"]), ("idle", {1, 2}))
        self.assertFalse(cards["aa:bb:cc:00:00:03"]["ap_ok"])
        self.assertEqual(cards["aa:bb:cc:00:00:03"]["name"], "oddwifi card")

    def test_a_card_without_ap_mode_is_never_made_one(self):
        fs, nm, lb = setup(("noap",))
        lb.scan()
        ok, msg = lb.set_ap("aa:bb:cc:00:00:03")
        self.assertFalse(ok)
        self.assertEqual([a for a in nm.calls if a[:2] == ("connection", "add")], [])


class Jobs(unittest.TestCase):
    def test_take_over_emulationstations_card_and_give_it_back(self):
        fs, nm, lb = setup()
        lb.scan()
        ok, msg = lb.set_ap(BLUEWAY)
        self.assertTrue(ok, msg)
        p = nm.cons[L.con_name(BLUEWAY)]
        self.assertEqual((p["802-11-wireless.mac-address"], p["ipv4.addresses"], p["802-11-wireless.channel"],
                          p["ssid"], p["802-11-wireless.mode"], p["ipv4.method"], p["connection.autoconnect"]),
                         (BLUEWAY, "10.42.0.1/24", "1", "R36Test-Stump", "ap", "shared", "no"))
        self.assertEqual(p["ifname"], "*")                       # bound to the card, not to "wlan0"
        c = lb.scan()[0]
        self.assertEqual((c["job"], c["info"]), ("ap", "R36Test-Stump · 10.42.0.1 · ch 1"))
        lb.set_off(BLUEWAY)
        c = lb.scan()[0]
        self.assertEqual((c["job"], c["info"]), ("lan", "HomeNet"))   # EmulationStation's network is back

    def test_as_many_aps_as_cards_each_its_own_range_channel_name(self):
        fs, nm, lb = setup(("blueway", "dual"))
        fs.plug("wlan2", "phy4", "aa:bb:cc:00:00:04", "0cf3:9271", "ath9k_htc", IW_BLUEWAY.replace("phy1", "phy4"))
        nm.idle("wlan2")
        lb.scan()
        for key in (DUAL, BLUEWAY, "aa:bb:cc:00:00:04"):
            self.assertTrue(lb.set_ap(key)[0])
        got = sorted((p["ipv4.addresses"], p["802-11-wireless.channel"], p["ssid"]) for p in nm.cons.values())
        self.assertEqual(got, [("10.42.0.1/24", "1", "R36Test-Stump"), ("10.42.1.1/24", "6", "R36Test-Stump-2"),
                               ("10.42.2.1/24", "11", "R36Test-Stump-3")])
        self.assertEqual([c["job"] for c in lb.scan()], ["ap", "ap", "ap"])

    def test_a_card_keeps_its_range_and_freed_ranges_are_reused(self):
        fs, nm, lb = setup(("blueway", "dual"))
        lb.scan()
        lb.set_ap(BLUEWAY)
        lb.set_ap(DUAL)
        lb.set_ap(DUAL)                                          # again: same range
        self.assertEqual(nm.cons[L.con_name(DUAL)]["ipv4.addresses"], "10.42.1.1/24")
        lb.set_off(BLUEWAY)
        nm.cons.pop(L.con_name(BLUEWAY))                         # gone for good
        fs.plug("wlan2", "phy4", "aa:bb:cc:00:00:04", "0cf3:9271", "ath9k_htc", IW_BLUEWAY.replace("phy1", "phy4"))
        nm.idle("wlan2")
        lb.scan()
        lb.set_ap("aa:bb:cc:00:00:04")
        self.assertEqual(nm.cons[L.con_name("aa:bb:cc:00:00:04")]["ipv4.addresses"], "10.42.0.1/24")

    def test_5ghz_only_where_the_card_has_it(self):
        fs, nm, lb = setup(("blueway", "dual"))
        lb.scan()
        self.assertFalse(lb.set_ap(BLUEWAY, "a")[0])
        self.assertTrue(lb.set_ap(DUAL, "a")[0])
        p = nm.cons[L.con_name(DUAL)]
        self.assertEqual((p["802-11-wireless.band"], p["802-11-wireless.channel"]), ("a", "36"))

    def test_the_old_single_hotspot_is_replaced(self):
        fs, nm, lb = setup()
        nm.cons[L.OLD_HOTSPOT] = {"connection.autoconnect": "no"}
        nm.dev["wlan0"] = ["connected", L.OLD_HOTSPOT]
        self.assertEqual(lb.scan()[0]["job"], "ap")              # seen as the AP it is
        lb.set_ap(BLUEWAY)
        self.assertNotIn(L.OLD_HOTSPOT, nm.cons)


class Remember(unittest.TestCase):
    def test_remember_is_networkmanagers_autoconnect_kept_per_card(self):
        state = os.path.join(tempfile.mkdtemp(), "limbs.json")
        fs, nm, lb = setup(state_file=state)
        lb.scan()
        lb.set_remember(BLUEWAY, True)                           # before it's an AP: kept for when it is
        lb.set_ap(BLUEWAY)
        self.assertEqual(nm.cons[L.con_name(BLUEWAY)]["connection.autoconnect"], "yes")
        self.assertEqual(int(nm.cons[L.con_name(BLUEWAY)]["connection.autoconnect-priority"]), L.PRIORITY)
        self.assertTrue(lb.scan()[0]["remember"])
        lb.set_remember(BLUEWAY, False)                          # while it is one: changed at once
        self.assertEqual(nm.cons[L.con_name(BLUEWAY)]["connection.autoconnect"], "no")
        with open(state) as f:
            self.assertEqual(json.load(f), {BLUEWAY: {"remember": False}})

    def test_turning_the_ap_off_stops_it_coming_back(self):
        fs, nm, lb = setup()
        lb.scan()
        lb.set_remember(BLUEWAY, True)
        lb.set_ap(BLUEWAY)
        lb.set_off(BLUEWAY)
        self.assertEqual(nm.cons[L.con_name(BLUEWAY)]["connection.autoconnect"], "no")

    def test_kept_across_restarts_of_the_cockpit(self):
        state = os.path.join(tempfile.mkdtemp(), "limbs.json")
        fs, nm, lb = setup(state_file=state)
        lb.scan()
        lb.set_remember(BLUEWAY, True)
        _, _, lb2 = setup(state_file=state)
        self.assertTrue(lb2.remember_pref(BLUEWAY))


class Hotplug(unittest.TestCase):
    def test_new_and_gone_in_any_order_same_card_same_key(self):
        fs, nm, lb = setup()
        lb.scan()
        self.assertEqual(lb.new_and_gone(), ([], []))           # what's there at start isn't news
        fs.plug("wlan1", "phy2", "aa:bb:cc:00:00:02", "148f:5572", "rt2800usb", IW_DUAL)
        nm.idle("wlan1")
        lb.scan()
        new, gone = lb.new_and_gone()
        self.assertEqual(([c["key"] for c in new], gone), ([DUAL], []))
        fs.unplug("wlan0")                                       # the Blueway out...
        nm.dev.pop("wlan0")
        lb.scan()
        self.assertEqual(lb.new_and_gone(), ([], [BLUEWAY]))
        fs.plug("wlan2", "phy5", "00:0F:00:5E:11:ED", "148f:3070", "rt2800usb", IW_BLUEWAY)   # ...back as wlan2
        nm.idle("wlan2")
        cards = {c["key"]: c for c in lb.scan()}
        self.assertEqual(cards[BLUEWAY]["iface"], "wlan2")
        self.assertEqual([c["key"] for c in lb.new_and_gone()[0]], [BLUEWAY])
        lb.set_ap(BLUEWAY)
        up = [a for a in nm.calls if a[:2] == ("connection", "up")][-1]
        self.assertEqual((up[2], up[up.index("ifname") + 1]), (L.con_name(BLUEWAY), "wlan2"))


class FeedWithLimbs(unittest.TestCase):
    def feed(self, cards=("blueway",)):
        fs, nm, lb = setup(cards)
        feed = F.Feed()
        feed._nmcli = nm
        feed.limbs = lb
        feed.restarts = []
        feed.restart_stump = lambda why: feed.restarts.append(why)
        return fs, nm, feed

    def test_limb_lines_for_the_engine(self):
        fs, nm, feed = self.feed(("blueway", "dual"))
        feed.refresh_net()
        lines = [l for l in feed.live_lines() if l.startswith("LIMB|")]
        self.assertEqual(lines[0], "LIMB|%s|Blueway High Power|rt2800usb|lan|1|1|bg|0|wlan0|HomeNet|0" % BLUEWAY)
        self.assertEqual(lines[1].split("|")[4:8], ["idle", "1", "3", "bg"])
        for l in lines:
            self.assertEqual(len(l.split("|")), 12)

    def test_a_plugged_card_is_offered_a_job(self):
        fs, nm, feed = self.feed()
        feed.refresh_net()
        fs.plug("wlan1", "phy2", "aa:bb:cc:00:00:02", "148f:5572", "rt2800usb", IW_DUAL)
        nm.idle("wlan1")
        feed.refresh_net()
        self.assertIn("New Wi-Fi: Ralink RT5572, AP-capable", feed.busy_msg)

    def test_a_job_from_the_cockpit_and_one_stump_restart_per_change(self):
        fs, nm, feed = self.feed()
        feed.refresh_net()
        self.assertEqual(feed.restarts, [])                      # nothing changed yet
        feed.handle("LIMB_JOB|%s|ap|bg" % BLUEWAY.upper())
        feed.refresh_net()
        feed.refresh_net()
        self.assertEqual(len(feed.restarts), 1)
        self.assertTrue(feed.net["ap"])
        self.assertIn("AP|1|wlan0|", "\n".join(feed.live_lines()))
        feed.handle("LIMB_JOB|%s|off" % BLUEWAY)
        feed.refresh_net()
        self.assertEqual(len(feed.restarts), 2)
        self.assertEqual(feed.limbs.cards[0]["job"], "lan")

    def test_the_old_hotspot_button_prefers_a_free_card(self):
        fs, nm, feed = self.feed(("blueway", "dual"))
        feed.refresh_net()
        feed.handle("AP_ON")
        feed.refresh_net()
        jobs = {c["key"]: c["job"] for c in feed.limbs.cards}
        self.assertEqual(jobs, {BLUEWAY: "lan", DUAL: "ap"})     # EmulationStation's network kept
        feed.handle("AP_OFF")
        feed.refresh_net()
        self.assertEqual(sorted(c["job"] for c in feed.limbs.cards), ["idle", "lan"])

    def test_the_old_hotspot_button_takes_over_when_it_is_the_only_card(self):
        fs, nm, feed = self.feed()
        feed.refresh_net()
        feed.handle("NET_APPLY|AP")
        feed.refresh_net()
        self.assertEqual(feed.limbs.cards[0]["job"], "ap")

    def test_wifi_join_and_scan_never_touch_a_network_or_a_password(self):
        fs, nm, feed = self.feed()
        feed.refresh_net()
        for cmd in ("WIFI_JOIN|Neighbour|secret", "WIFI_SCAN"):
            feed.handle(cmd)
        self.assertEqual([a for a in nm.calls if a[:2] in (("connection", "add"), ("connection", "up"))
                          or a[:3] == ("device", "wifi", "connect")], [])
        self.assertNotIn("secret", repr(nm.calls))

    def test_remember_from_the_cockpit(self):
        fs, nm, feed = self.feed()
        feed.limbs.state_file = os.path.join(tempfile.mkdtemp(), "limbs.json")
        feed.refresh_net()
        feed.handle("LIMB_REMEMBER|%s|1" % BLUEWAY)
        feed.handle("LIMB_JOB|%s|ap|bg" % BLUEWAY)
        self.assertEqual(nm.cons[L.con_name(BLUEWAY)]["connection.autoconnect"], "yes")
        feed.refresh_net()
        self.assertIn("|ap|1|1|bg|1|", [l for l in feed.live_lines() if l.startswith("LIMB|")][0])


if __name__ == "__main__":
    unittest.main(verbosity=1)
