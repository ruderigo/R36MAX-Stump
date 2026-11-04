"""limbs.py -- the handheld's Wi-Fi cards ("limbs") and their jobs.

Every Wi-Fi card on the handheld (the Blueway on the hub, and any other one
plugged in, in any order) is a limb with a job:

  lan   EmulationStation's network is on it (chosen there, shown here)
  ap    the Stump's open Wi-Fi with its sign-in page
  idle  plugged in, unused
  off   the system can't use it now (unavailable, unmanaged)

A card is known by its hardware (permanent MAC), never by wlan0/wlan1,
which change with the plug order. Whether it can run an AP, and on which
bands, is read from the card itself (`iw phy`), so a future card qualifies
without a change here.

Each AP is one NetworkManager connection, Stump-AP-<mac>, bound to the
card's MAC: open, "shared" (NetworkManager's DHCP), at 10.42.<slot>.1 on its
own channel. "Remember" is that connection's autoconnect, with a priority
above EmulationStation's networks, so NetworkManager itself brings the AP
back when the card is plugged in again or at boot, cockpit open or not.
Taking the AP off a card brings its connection down; NetworkManager then
puts EmulationStation's network back on it by itself.

Standard library only. nmcli and iw are passed in (the tests use fakes).
"""

import json
import os
import re

AP_PREFIX = "Stump-AP-"
OLD_HOTSPOT = "Stump-Hotspot"         # v2.0's single hotspot connection
PRIORITY = 50                         # above a saved home network's default 0
CHANNELS = {"bg": (1, 6, 11), "a": (36, 44, 149, 157)}

# Friendly names by USB id; any other card is shown by its driver or id.
KNOWN = {
    "148f:3070": "Blueway High Power",
    "148f:5572": "Ralink RT5572",
    "0cf3:9271": "Atheros AR9271",
}


def split_nm(line):
    """nmcli -t fields: ':' separated, '\\:' for a colon inside one."""
    out, cur, esc = [], "", False
    for ch in line:
        if esc:
            cur += ch
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == ":":
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return out


def parse_iw_phy(text):
    """(modes, bands) from `iw phy <phy> info` (or `iw list`): the
    "Supported interface modes" ({"managed", "AP", ...}) and the band
    numbers (1 = 2.4 GHz, 2 = 5 GHz, ...)."""
    modes, inside = set(), False
    for line in (text or "").splitlines():
        if "Supported interface modes:" in line:
            inside = True
            continue
        if inside:
            m = re.match(r"^\s+\*\s+(\S+)\s*$", line)
            if not m:
                inside = False
                continue
            modes.add(m.group(1))
    bands = set(int(b) for b in re.findall(r"^\s*Band (\d+):", text or "", re.M))
    return modes, bands


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def con_name(key):
    return AP_PREFIX + key.replace(":", "").lower()


def list_cards(iw, sys_net="/sys/class/net", sys_phy="/sys/class/ieee80211"):
    """[{key, iface, phy, driver, usb, name, ap_ok, bands}] of the Wi-Fi
    cards present now. iw(phy) returns `iw phy <phy> info`."""
    cards = []
    try:
        ifaces = sorted(os.listdir(sys_net))
    except OSError:
        return cards
    for iface in ifaces:
        base = os.path.join(sys_net, iface)
        if not os.path.exists(os.path.join(base, "phy80211")):
            continue
        phy = os.path.basename(os.path.realpath(os.path.join(base, "phy80211")))
        key = (_read(os.path.join(sys_phy, phy, "macaddress")) or _read(os.path.join(base, "address"))).lower()
        if not key:
            continue
        drv = os.path.join(base, "device", "driver")
        driver = os.path.basename(os.path.realpath(drv)) if os.path.exists(drv) else ""
        usb = ""
        dev = os.path.realpath(os.path.join(base, "device"))
        for d in (dev, os.path.dirname(dev)):              # the USB interface, then its device
            vid, pid = _read(os.path.join(d, "idVendor")), _read(os.path.join(d, "idProduct"))
            if vid and pid:
                usb = "%s:%s" % (vid.lower(), pid.lower())
                break
        modes, bands = parse_iw_phy(iw(phy))
        name = KNOWN.get(usb) or ("%s card" % driver if driver else ("Wi-Fi %s" % usb if usb else iface))
        cards.append({"key": key, "iface": iface, "phy": phy, "driver": driver, "usb": usb, "name": name,
                      "ap_ok": "AP" in modes, "bands": bands})
    return cards


class Limbs:
    def __init__(self, nmcli, iw_phy=None, iw_dev=None, sys_net="/sys/class/net",
                 sys_phy="/sys/class/ieee80211", state_file=None, config=None):
        self.nmcli = nmcli                                   # nmcli(*args, timeout=) -> (ok, out)
        self.iw_phy = iw_phy or (lambda phy: "")             # `iw phy <phy> info`
        self.iw_dev = iw_dev or (lambda iface: "")           # `iw dev <iface> station dump`
        self.sys_net, self.sys_phy = sys_net, sys_phy
        self.state_file = state_file
        self.config = config or (lambda: {})
        self.state = self._load()
        self.cards = []
        self._seen = None                                    # keys at the last scan (None: none yet)

    # -- the remembered preferences (remember on/off per card) --
    def _load(self):
        try:
            with open(self.state_file, encoding="utf-8") as f:
                d = json.load(f)
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}

    def _save(self):
        if not self.state_file:
            return
        try:
            tmp = self.state_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.state, f)
            os.replace(tmp, self.state_file)
        except OSError:
            pass

    def remember_pref(self, key):
        return bool((self.state.get(key) or {}).get("remember"))

    # -- what's there now --
    def _ap_connections(self):
        """{name: autoconnect} of the Stump's AP connections."""
        ok, out = self.nmcli("-t", "-f", "NAME,AUTOCONNECT", "connection", "show")
        cons = {}
        for line in out.splitlines() if ok else []:
            p = split_nm(line)
            if len(p) >= 2 and (p[0].startswith(AP_PREFIX) or p[0] == OLD_HOTSPOT):
                cons[p[0]] = p[1] == "yes"
        return cons

    def _ap_details(self, name):
        """(ssid, address, channel, band) of an AP connection."""
        ok, out = self.nmcli("-t", "-g", "802-11-wireless.ssid,ipv4.addresses,802-11-wireless.channel,"
                             "802-11-wireless.band", "connection", "show", name)
        p = split_nm(out.splitlines()[0]) if ok and out else []
        p += [""] * (4 - len(p))
        return p[0], p[1].split("/")[0], p[2], p[3] or "bg"

    def _slot_of(self, name):
        m = re.match(r"10\.42\.(\d+)\.1", self._ap_details(name)[1])
        return int(m.group(1)) if m else None

    def scan(self):
        """The cards now, each with its job: [{..., job, conn, info, remember,
        band, clients}]. Also keeps what new_and_gone() compares."""
        cards = list_cards(self.iw_phy, self.sys_net, self.sys_phy)
        ok, out = self.nmcli("-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device")
        dev = {}
        for line in out.splitlines() if ok else []:
            p = split_nm(line)
            if len(p) >= 4:
                dev[p[0]] = (p[2], p[3])
        cons = self._ap_connections()
        for c in cards:
            state, conn = dev.get(c["iface"], ("unavailable", ""))
            c["conn"] = conn
            c["remember"] = cons.get(con_name(c["key"]), self.remember_pref(c["key"])) is True
            c["band"], c["clients"], c["info"] = "bg", 0, ""
            if state.startswith("connected") and (conn.startswith(AP_PREFIX) or conn == OLD_HOTSPOT):
                c["job"] = "ap"
                ssid, ip, ch, band = self._ap_details(conn)
                c["band"] = band
                c["info"] = " · ".join(x for x in (ssid, ip, ("ch %s" % ch) if ch and ch != "0" else "") if x)
                c["clients"] = self.iw_dev(c["iface"]).count("Station ")
            elif state.startswith("connected"):
                c["job"], c["info"] = "lan", conn
            elif state in ("unavailable", "unmanaged"):
                c["job"] = "off"
            else:
                c["job"] = "idle"
        self.cards = cards
        return cards

    def new_and_gone(self):
        """(cards that appeared, keys that left) since the last call; nothing
        the first time (the cards there at start aren't news)."""
        keys = set(c["key"] for c in self.cards)
        if self._seen is None:
            self._seen = keys
            return [], []
        new = [c for c in self.cards if c["key"] not in self._seen]
        gone = sorted(self._seen - keys)
        self._seen = keys
        return new, gone

    def find(self, key):
        return next((c for c in self.cards if c["key"] == key), None)

    # -- jobs --
    def hotspot_name(self, slot):
        cfg = self.config() or {}
        base = str(cfg.get("PC_HOTSPOT_NAME") or "%s-Stump" % (cfg.get("NODE_NAME") or "R36MAX"))[:32]
        return base if slot == 0 else "%s-%d" % (base[:29], slot + 1)

    def free_slot(self, name):
        """This card's slot if it had one, else the lowest one no other AP uses."""
        used = {}
        for other in self._ap_connections():
            s = self._slot_of(other)
            if s is not None:
                used[other] = s
        if name in used:
            return used.pop(name)
        taken = set(used.values())
        slot = 0
        while slot in taken:
            slot += 1
        return slot

    def set_ap(self, key, band="bg"):
        """The card runs an AP. (ok, message)."""
        c = self.find(key)
        if not c:
            return False, "That card is gone"
        if not c["ap_ok"]:
            return False, "%s can't run an AP" % c["name"]
        if band == "a" and 2 not in c["bands"]:
            return False, "%s has no 5 GHz" % c["name"]
        band = "a" if band == "a" else "bg"
        # v2.0's single hotspot goes; every AP is now one per card.
        self.nmcli("connection", "down", OLD_HOTSPOT)
        self.nmcli("connection", "delete", OLD_HOTSPOT)
        name = con_name(key)
        slot = self.free_slot(name)
        chans = CHANNELS[band]
        ssid = self.hotspot_name(slot)
        self.nmcli("connection", "delete", name)
        ok, out = self.nmcli("connection", "add", "type", "wifi", "ifname", "*", "con-name", name,
                             "ssid", ssid, "802-11-wireless.mode", "ap", "802-11-wireless.band", band,
                             "802-11-wireless.channel", str(chans[slot % len(chans)]),
                             "802-11-wireless.mac-address", key,
                             "ipv4.method", "shared", "ipv4.addresses", "10.42.%d.1/24" % slot,
                             "ipv6.method", "ignore",
                             "connection.autoconnect", "yes" if self.remember_pref(key) else "no",
                             "connection.autoconnect-priority", str(PRIORITY))
        if ok:
            ok, out = self.nmcli("connection", "up", name, "ifname", c["iface"], timeout=45)
        if not ok:
            return False, "AP failed: %s" % out
        return True, "AP on %s: %s (10.42.%d.1)" % (c["name"], ssid, slot)

    def set_off(self, key):
        """The card stops being an AP; EmulationStation's network comes back
        on it by itself (NetworkManager). (ok, message)."""
        c = self.find(key)
        name = con_name(key)
        self.nmcli("connection", "modify", name, "connection.autoconnect", "no")
        ok, out = self.nmcli("connection", "down", name)
        if c and c.get("conn") == OLD_HOTSPOT:
            ok, out = self.nmcli("connection", "down", OLD_HOTSPOT)
        return True, "AP off on %s" % (c["name"] if c else "that card")

    def set_remember(self, key, on):
        """Remember on: the card goes back to being an AP by itself (replug,
        boot). Kept per card, by its MAC."""
        self.state.setdefault(key, {})["remember"] = bool(on)
        self._save()
        c = self.find(key)
        if c and c["job"] == "ap" and c.get("conn") == con_name(key):
            self.nmcli("connection", "modify", con_name(key), "connection.autoconnect", "yes" if on else "no")
        return True, "%s: %s" % (c["name"] if c else "card", "remembered as an AP" if on else "not remembered")

    def ap_target(self):
        """The card the old one-button "hotspot on" uses: a free AP-capable
        card first, else the one EmulationStation is on (taken over)."""
        for job in ("idle", "lan"):
            for c in self.cards:
                if c["ap_ok"] and c["job"] == job:
                    return c
        return None
