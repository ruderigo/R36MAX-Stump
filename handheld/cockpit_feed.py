#!/usr/bin/env python3
"""cockpit_feed.py -- the R36MAX cockpit's link to its Stump.

The Stump on this handheld is a stock Stump on a computer (SandBox_Stump_On's
pc/stump_pc.py, set up by `provisioner.py --pc`), exactly like any other
computer Stump. This program is only a *client* of it, like a browser tab
or the FireFly app: it talks to the Stump over its public HTTP API
(docs/CLIENT_QUICKSTART.md) and never imports or patches the firmware.

    cockpit (C, 720x720)  --commands-->  this feed  --HTTP-->  the Stump
                          <--live file--             <--JSON--

It speaks the cockpit's existing protocol:
  * reads commands from UDP 127.0.0.1:42421 (or /dev/shm/stump_cmd.txt),
    one line each: RRC|room|text, ROOM_VIEW|room, BOARD_ADD|title|body, ...
  * writes /dev/shm/stump_live.txt (META|, VER|, AP|, CHAIN|, ROOM|, MSG|,
    BOARD|, FILE|, STORAGE|, LOG| lines) about once a second.

On the Stump's side it is "the person on this computer" (a localhost
client keeping the Stump's cookie, as a browser does), the same standing
the owner of any computer Stump has in their own browser.

The handheld's Wi-Fi (hotspot on/off, joining a network) is the operating
system's, as on every computer Stump (docs/PC.md "Visitors' Wi-Fi"): that
part goes through NetworkManager (nmcli), then the Stump is restarted so
it picks up its new address, as /admin does after a settings change.

Python 3.8+, standard library only.
"""

import ast
import http.cookiejar
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FEED_VERSION = "2.0.0-r36max"

HOME = os.path.expanduser("~")
STUMP_DIR = os.environ.get("STUMP_DIR", os.path.join(HOME, "Stump"))
APP_DIR = os.environ.get("STUMP_R36MAX_DIR", "/roms/ports/stump_r36max")
TF_DIR = os.path.join(APP_DIR, "tf_backup")
DROP_DIR = os.path.join(APP_DIR, "drop")
LIVE_TXT = os.environ.get("STUMP_LIVE_FILE", "/dev/shm/stump_live.txt")
CMD_TXT = os.environ.get("STUMP_CMD_FILE", "/dev/shm/stump_cmd.txt")
IPC_PORT = int(os.environ.get("STUMP_IPC_PORT", "42421"))
NICK = os.environ.get("STUMP_COCKPIT_NICK", "r36max")
HOTSPOT_CON = "Stump-Hotspot"

ROOMS = ("main", "lora-mesh", "wifi-mesh")      # the cockpit's three room tabs, in order

POLL_S = 2.0          # the reference client's cadence (CLIENT_QUICKSTART "Polling cadence")
INFO_S = 5.0
NET_S = 12.0


# ── small helpers ──────────────────────────────────────────────────

_LOG = []


def log(tag, msg):
    line = "%s [%s] %s" % (time.strftime("%H:%M:%S"), tag, clean(msg, 200))
    _LOG.append(line)
    del _LOG[:-36]
    print(line, flush=True)


def clean(s, n=60):
    """One field of a live line: no '|' (the separator), no line breaks."""
    s = str("" if s is None else s)
    s = s.replace("|", "/").replace("\r", " ").replace("\n", " ").replace("\t", " ")
    return s.strip()[:n]


def ascii_line(s):
    """The cockpit's font is ASCII: the Stump's room-activity symbols
    (CLIENT_QUICKSTART "Room activity and DMs are symbols") said in words,
    accents folded, anything else dropped."""
    import unicodedata
    s = str(s or "")
    if s.startswith("✓ "):                       # ✓ rod
        s = "+ %s joined" % s[2:]
    elif s.startswith("✗ "):                     # ✗ rod
        s = "- %s left" % s[2:]
    elif s.startswith("✎ #"):                    # ✎ #main text
        room, _, text = s[2:].partition(" ")
        s = "%s topic: %s" % (room, text)
    elif s.startswith("✎ "):                     # ✎ rod → bob
        s = "%s is now %s" % tuple((s[2:].split(" → ", 1) + [""])[:2])
    elif s.startswith("⊖ "):                     # ⊖ ghost
        s = "no one here is called " + s[2:]
    for k, v in (("→", "->"), ("—", "-"), ("–", "-"), ("…", "..."), ("·", "."),
                 ("⊘", "(refused)"), ("⧗", "(slow down)"), ("♪", "voice"),
                 ("«", '"'), ("»", '"'), ("’", "'"), ("“", '"'), ("”", '"')):
        s = s.replace(k, v)
    s = s.replace("~", "")                            # "on the mesh" mark: the font has no ~
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if 32 <= ord(c) < 127)


def run(cmd, timeout=20):
    """(ok, output) of a command; never raises."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, ((r.stdout or "") + (r.stderr or "")).strip()
    except FileNotFoundError:
        return False, "%s: not installed" % cmd[0]
    except subprocess.TimeoutExpired:
        return False, "%s: timed out" % cmd[0]


def read_config():
    """The simple settings from the Stump folder's config.py, read as data
    (never executed: it's the Stump's file, not ours)."""
    out = {}
    try:
        with open(os.path.join(STUMP_DIR, "config.py"), encoding="utf-8") as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError):
        return out
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            try:
                out[node.targets[0].id] = ast.literal_eval(node.value)
            except Exception:
                pass
    return out


# ── the Stump, over HTTP ───────────────────────────────────────────

class Stump:
    """A localhost client of the Stump: one cookie, one current room, the
    way the web chat is."""

    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar),
                                              urllib.request.ProxyHandler({}))
        # Replies in English (the Stump picks the language from this, as for a
        # browser); STUMP_COCKPIT_LANG=fr / es for the others.
        self.op.addheaders = [("User-Agent", "R36MAX-cockpit/" + FEED_VERSION),
                              ("Accept-Language", os.environ.get("STUMP_COCKPIT_LANG", "en"))]
        self.port = None
        self.room = None            # the server's idea of our room
        self.since = 0
        self.fail = 0
        self.next_poll = 0.0

    def _url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def find(self):
        """Which port the Stump serves on: 80, or 8080 when 80 was taken
        (docs/PC.md). None if it isn't answering."""
        for port in ([self.port] if self.port else []) + [80, 8080]:
            try:
                with self.op.open("http://127.0.0.1:%d/node.json" % port, timeout=2) as r:
                    d = json.loads(r.read().decode("utf-8", "replace"))
                if isinstance(d, dict) and "lxmf" in d:
                    if port != self.port:
                        self.port = port
                        log("STUMP", "answering on :%d (%s %s)" % (port, d.get("name"), d.get("release")))
                    return d
            except Exception:
                continue
        self.port = None
        return None

    def has_cookie(self):
        return any(c.name == "stump_v" for c in self.jar)

    def visit(self):
        """The home page, once: the Stump offers its visitor cookie there, and
        a client with it is a browser-like visitor (no app greeting); on
        127.0.0.1 that's the person on this computer."""
        with self.op.open(self._url("/"), timeout=5) as r:
            r.read()

    def get(self, path, timeout=4):
        with self.op.open(self._url(path), timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))

    def post(self, path, body, ctype="text/plain; charset=utf-8", headers=None, timeout=10):
        """(status, text). Always asks for JSON where the route offers it."""
        h = {"Content-Type": ctype, "Accept": "application/json"}
        h.update(headers or {})
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        req = urllib.request.Request(self._url(path), data=data, headers=h, method="POST")
        try:
            with self.op.open(req, timeout=timeout) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")

    def send(self, line):
        """One chat line or command, as the web chat sends it. Returns the
        replies (feedback for us only)."""
        status, text = self.post("/rrc/send", line)
        try:
            d = json.loads(text) if text else {}
        except ValueError:
            d = {}
        if d.get("room"):
            self.room, self.since = d["room"], 0
        return d.get("replies") or ([] if status == 200 else ["HTTP %d" % status])


# ── the cockpit's view of things ───────────────────────────────────

class Feed:
    def __init__(self):
        self.stump = Stump()
        self.want_room = "wifi-mesh"       # the cockpit opens on #wifi-mesh
        self.msgs = {r: [] for r in ROOMS}
        self.users = {r: 0 for r in ROOMS}
        self.node = None
        self.hw = {}
        self.chain = {"enabled": False}
        self.stumps = []
        self.board = []
        self.files = []
        self.net = {"ap": False, "ap_if": "", "ap_mac": "", "ap_driver": "", "clients": 0,
                    "ip": "", "ssids": []}
        self.busy_until, self.busy_msg = 0.0, "READY"
        self.full_names = {}               # shown (truncated) file name -> the real one
        self.next_info = self.next_net = 0.0
        self.nick_set = False
        self.ipc = None

    # -- status line on the cockpit --
    def busy(self, msg, secs=2.5):
        self.busy_msg, self.busy_until = clean(msg, 54), time.time() + secs
        log("UI", msg)

    # -- reading the Stump --
    def refresh_info(self):
        st = self.stump
        self.node = st.find()
        if not self.node:
            return
        for path, attr, default in (("/hw.json", "hw", {}), ("/chain.json", "chain", {"enabled": False}),
                                    ("/stumps.json", "stumps", []), ("/billboard.json", "board", []),
                                    ("/files.json", "files", [])):
            try:
                d = st.get(path)
            except urllib.error.HTTPError as e:
                d = None if e.code != 404 else default      # 404: that feature is off here
            except Exception:
                d = None
            if d is None:
                continue
            if attr == "stumps":
                d = d.get("stumps", []) if isinstance(d, dict) else []
            elif attr == "board":
                d = d.get("posts", []) if isinstance(d, dict) else []
            elif attr == "files":
                d = d.get("files", []) if isinstance(d, dict) else []
            setattr(self, attr, d)

    def poll(self):
        st = self.stump
        if st.port is None or time.time() < st.next_poll:
            return
        try:
            if not st.has_cookie():
                st.visit()
            if not self.nick_set:
                d = st.get("/rrc/poll?room=main&since=0")
                if str(d.get("nick", "")).startswith("guest-") and NICK:
                    # Our name, or (taken by someone else here) the name with a
                    # number, as a person would pick another.
                    for nick in [NICK] + ["%s%d" % (NICK, n) for n in range(2, 6)]:
                        st.send("/nick " + nick)
                        if st.get("/rrc/poll?room=main&since=0").get("nick") == nick:
                            log("CHAT", "on the chat as %s" % nick)
                            break
                self.nick_set = True
            if st.room != self.want_room:
                for r in st.send("/join " + self.want_room):
                    log("CHAT", r)
            q = "/rrc/poll?room=%s&since=%d" % (urllib.parse.quote(st.room or self.want_room), st.since)
            d = st.get(q)
            room = d.get("room") or "main"
            if room != st.room:
                # Joined (or moved to) another room: the poll below brings its
                # whole scrollback, so start that room's lines afresh.
                st.room, st.since = room, 0
                if room in self.msgs:
                    self.msgs[room] = []
            for m in (d.get("messages") or []) + (d.get("dms") or []):
                mid = int(m.get("id") or 0)
                st.since = max(st.since, mid)
                if room in self.msgs and all(int(x.get("id") or 0) != mid for x in self.msgs[room]):
                    self.msgs[room].append(m)
                    del self.msgs[room][:-10]
                if m.get("kind") == "dm":
                    log("DM", "%s: %s" % (m.get("nick"), m.get("body")))
            if room in self.users:
                self.users[room] = len(d.get("users") or [])
            st.fail = 0
            st.next_poll = time.time() + POLL_S * (1 + 0.3 * (os.getpid() % 10) / 10)
        except Exception as e:
            st.fail += 1
            st.next_poll = time.time() + min(30.0, POLL_S * (2 ** st.fail))
            if st.fail in (1, 4):
                log("CHAT", "poll failed: %s" % e)

    # -- the handheld's Wi-Fi (the OS's, via NetworkManager) --
    def _nmcli(self, *args, timeout=25):
        ok, out = run(["nmcli"] + list(args), timeout=timeout)
        if not ok and ("authoriz" in out.lower() or "permission" in out.lower() or "insufficient" in out.lower()):
            ok, out = run(["sudo", "-n", "nmcli"] + list(args), timeout=timeout)
        return ok, out

    def wifi_devices(self):
        """[(device, state, connection)] of the Wi-Fi interfaces."""
        ok, out = self._nmcli("-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device")
        devs = []
        for line in out.splitlines() if ok else []:
            parts = _split_nm(line)
            if len(parts) >= 4 and parts[1] == "wifi":
                devs.append((parts[0], parts[2], parts[3]))
        return devs

    def refresh_net(self):
        devs = self.wifi_devices()
        ap_dev = next((d for d, s, c in devs if c == HOTSPOT_CON and s.startswith("connected")), "")
        self.net["ap"] = bool(ap_dev)
        self.net["ap_if"] = ap_dev or (devs[-1][0] if devs else "wlan0")
        self.net["ap_mac"] = _read("/sys/class/net/%s/address" % self.net["ap_if"])
        drv = "/sys/class/net/%s/device/driver" % self.net["ap_if"]
        self.net["ap_driver"] = os.path.basename(os.path.realpath(drv)) if os.path.exists(drv) else ""
        self.net["clients"] = 0
        if ap_dev and shutil.which("iw"):
            ok, out = run(["iw", "dev", ap_dev, "station", "dump"], timeout=5)
            self.net["clients"] = out.count("Station ") if ok else 0
        ok, out = self._nmcli("-t", "-f", "IN-USE,SIGNAL,SECURITY,SSID", "device", "wifi", "list", "--rescan", "no")
        ssids, seen = [], set()
        for line in out.splitlines() if ok else []:
            p = _split_nm(line)
            if len(p) >= 4 and p[3] and p[3] not in seen:
                seen.add(p[3])
                ssids.append({"active": p[0] == "*", "signal": int(p[1] or 0) if p[1].isdigit() else 0,
                              "sec": p[2] or "OPEN", "ssid": p[3]})
        self.net["ssids"] = sorted(ssids, key=lambda s: (not s["active"], -s["signal"]))[:6]

    def restart_stump(self, why):
        """The Stump picks up a new address on restart, as after /admin's
        settings: its own user service (provisioner --pc), else its Start file."""
        log("STUMP", "restarting (%s)" % why)
        ok, out = run(["systemctl", "--user", "restart", "stump"], timeout=30)
        if not ok:
            start = os.path.join(STUMP_DIR, "start-stump.sh")
            stop = os.path.join(STUMP_DIR, "stop-stump.sh")
            if os.path.exists(stop):
                run(["sh", stop], timeout=30)
                time.sleep(3)
            if os.path.exists(start):
                subprocess.Popen(["sh", start], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        self.stump.port, self.stump.room, self.nick_set = None, None, False
        self.next_info = time.time() + 6

    def hotspot(self, on):
        cfg = read_config()
        if not on:
            ok, out = self._nmcli("connection", "down", HOTSPOT_CON)
            self.busy("HOTSPOT OFF" if ok else "HOTSPOT: " + out, 3)
            self.restart_stump("hotspot off")
            return
        devs = self.wifi_devices()
        if not devs:
            self.busy("NO WI-FI ADAPTER FOUND", 3)
            return
        # Two Wi-Fi adapters (internal + RT3070): the hotspot on the one not in
        # use, so the handheld stays on its network (PC.md: two networks).
        free = [d for d, s, c in devs if not s.startswith("connected") or c == HOTSPOT_CON]
        dev = free[-1] if free else devs[-1][0]
        if not free:
            log("NET", "one Wi-Fi adapter: the hotspot replaces the network on %s" % dev)
        ssid = cfg.get("PC_HOTSPOT_NAME") or "%s-Stump" % (cfg.get("NODE_NAME") or "R36MAX")
        ssid = str(ssid)[:32]
        self._nmcli("connection", "delete", HOTSPOT_CON)
        # Open, like a CAM's walk-up Wi-Fi; NetworkManager's "shared" mode gives
        # it 10.42.0.1 with DHCP (the Linux hotspot of docs/PC.md).
        ok, out = self._nmcli("connection", "add", "type", "wifi", "ifname", dev, "con-name", HOTSPOT_CON,
                              "autoconnect", "no", "ssid", ssid, "802-11-wireless.mode", "ap",
                              "802-11-wireless.band", "bg", "ipv4.method", "shared", "ipv6.method", "ignore")
        if ok:
            ok, out = self._nmcli("connection", "up", HOTSPOT_CON, timeout=45)
        self.busy(("HOTSPOT ON: %s" % ssid) if ok else ("HOTSPOT FAILED: %s" % out), 4)
        if ok:
            self.restart_stump("hotspot on")

    def join_wifi(self, ssid, password):
        if not ssid:
            return
        self._nmcli("connection", "down", HOTSPOT_CON)
        args = ["device", "wifi", "connect", ssid] + (["password", password] if password else [])
        ok, out = self._nmcli(*args, timeout=60)
        self.busy(("JOINED %s" % ssid) if ok else ("JOIN FAILED: %s" % out), 4)
        if ok:
            self.restart_stump("joined %s" % ssid)

    # -- the TF card --
    def tf_count(self):
        try:
            return len([f for f in os.listdir(TF_DIR) if not f.startswith(".")])
        except OSError:
            return 0

    def _tf_write(self, name, text):
        os.makedirs(TF_DIR, exist_ok=True)
        p = os.path.join(TF_DIR, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p

    # -- commands from the cockpit --
    def handle(self, line):
        parts = line.rstrip("\r\n").split("|")
        op = parts[0].strip().upper() if parts else ""
        if not op:
            return
        st = self.stump
        try:
            if op == "ROOM_VIEW" and len(parts) >= 2:
                room = parts[1].strip().lower()
                if room in ROOMS and room != self.want_room:
                    self.want_room = room
                    st.next_poll = 0
            elif op == "RRC" and len(parts) >= 3:
                room = parts[1].strip().lower() or self.want_room
                text = "|".join(parts[2:]).strip()
                if not text or st.port is None:
                    self.busy("THE STUMP ISN'T ANSWERING YET", 2.5)
                    return
                if room != st.room:
                    st.send("/join " + room)
                    self.want_room = room
                for r in st.send(text):
                    log("CHAT", r)
                st.next_poll = 0
            elif op == "BOARD_ADD" and len(parts) >= 2:
                s, t = st.post("/post", json.dumps({"title": parts[1], "body": "|".join(parts[2:])}),
                               "application/json")
                self.busy("NOTICE POSTED" if s == 201 else "NOTICE: " + _msg(t, s), 2.5)
                self.next_info = 0
            elif op in ("BOARD_DEL", "BOARD_DEL_MULTI") and len(parts) >= 2:
                ids = [i.strip() for i in parts[1].split(",") if i.strip()]
                full = {p.get("id"): p.get("id") for p in self.board if p.get("id")}
                ids = [next((f for f in full if f and f.startswith(i)), i) for i in ids]
                self._admin_delete("/admin/delete_post", "ts", ids, "NOTICE")
            elif op in ("FILE_DEL", "FILE_DEL_MULTI") and len(parts) >= 2:
                names = [self.full_names.get(n.strip(), n.strip()) for n in parts[1].split(",") if n.strip()]
                self._admin_delete("/admin/delete", "f", names, "FILE")
            elif op == "FILE_ADD":
                self.share_next_file()
            elif op == "BOARD_BACKUP_TF":
                ids = set(i.strip() for i in (parts[1] if len(parts) > 1 else "").split(",") if i.strip())
                rows = [p for p in self.board if not ids or any(str(p.get("id", "")).startswith(i) for i in ids)]
                text = "Billboard of %s, %s\n\n" % ((self.node or {}).get("name", "?"), time.strftime("%Y-%m-%d %H:%M"))
                text += "".join("[%s] %s (%s)\n%s\n\n" % (p.get("id"), p.get("title"), p.get("sig"), p.get("body", ""))
                                for p in rows)
                p = self._tf_write("billboard_%s.txt" % time.strftime("%Y%m%d_%H%M%S"), text)
                self.busy("SAVED %d NOTICE(S) TO TF CARD" % len(rows), 2.5)
                log("TF", p)
            elif op == "FILE_BACKUP_TF" and len(parts) >= 2:
                names = [self.full_names.get(n.strip(), n.strip()) for n in parts[1].split(",") if n.strip()]
                os.makedirs(TF_DIR, exist_ok=True)
                n = 0
                for name in names:
                    src = os.path.join(STUMP_DIR, "sd", "shared", os.path.basename(name))
                    if os.path.isfile(src):          # a read-only copy: the Stump's shelf is untouched
                        shutil.copy2(src, os.path.join(TF_DIR, os.path.basename(name)))
                        n += 1
                self.busy("COPIED %d FILE(S) TO TF CARD" % n, 2.5)
            elif op in ("AP_ON", "AP_OFF", "AP_TOGGLE"):
                on = (op == "AP_ON") or (op == "AP_TOGGLE" and not self.net["ap"])
                self.busy("HOTSPOT %s..." % ("ON" if on else "OFF"), 8)
                self.hotspot(on)
                self.next_net = 0
            elif op == "NET_APPLY" and len(parts) >= 2:
                if parts[1].strip().upper() == "AP":
                    self.busy("HOTSPOT ON...", 8)
                    self.hotspot(True)
                else:
                    ssid = parts[2].strip() if len(parts) > 2 else ""
                    if ssid:
                        self.busy("JOINING %s..." % ssid, 15)
                        self.join_wifi(ssid, parts[3] if len(parts) > 3 else "")
                    else:
                        self.busy("HOTSPOT OFF...", 8)
                        self.hotspot(False)
                self.next_net = 0
            elif op == "WIFI_SCAN":
                self.busy("SCANNING WI-FI...", 6)
                self._nmcli("device", "wifi", "rescan", timeout=15)
                self.next_net = time.time() + 4
            elif op == "WIFI_JOIN" and len(parts) >= 2:
                self.busy("JOINING %s..." % parts[1], 15)
                self.join_wifi(parts[1].strip(), parts[2] if len(parts) > 2 else "")
                self.next_net = 0
            elif op == "CHAIN_SCAN":
                found = discover_stumps()
                for s in found:
                    log("CHAIN", "%s at %s (%s)" % (s.get("name"), s.get("here") or ",".join(s.get("http") or []),
                                                    s.get("release")))
                self.busy("%d STUMP(S) ON THIS NETWORK" % len(found), 3)
                self.next_info = 0
            elif op == "CHAIN_SET":
                # The chain is the Stump's own setting, as on every Stump: /admin
                # (Stump chain) or the setup wizard -- never edited from here.
                self.busy("SET THE CHAIN IN /admin OR: provisioner.py --pc --reconfigure", 5)
            elif op == "ANNOUNCE":
                self.busy("THE STUMP ANNOUNCES ITSELF (RADIO UP, NEW STUMPS HEARD)", 3)
            elif op == "DEBUG_EXPORT_TF":
                self.export_diagnostics()
            elif op == "DEBUG_HEAL_NET":
                self.busy("RESTARTING THE STUMP...", 6)
                self.restart_stump("from the cockpit")
            elif op == "DEBUG_CLEAR_LOGS":
                _LOG.clear()
                log("SYS", "log cleared")
            else:
                log("CMD", "not handled: %s" % op)
        except Exception as e:
            log("ERR", "%s: %s" % (op, e))

    def _admin_delete(self, path, field, items, what):
        """The Stump's own /admin delete, with its admin password (this is the
        owner's handheld; the password stays on localhost)."""
        pw = read_config().get("AUTH_ADMIN_PASSWORD") or ""
        if not items:
            return
        if not pw:
            self.busy("SET AN ADMIN PASSWORD (/admin) TO DELETE FROM HERE", 4)
            return
        body = "&".join("%s=%s" % (field, urllib.parse.quote(i, safe="")) for i in items)
        body += "&admin_pass=" + urllib.parse.quote(pw, safe="")
        s, t = self.stump.post(path, body, "application/x-www-form-urlencoded")
        self.busy(("DELETED %d %s(S)" % (len(items), what)) if s == 200 else ("DELETE: %s" % _msg(t, s)), 2.5)
        self.next_info = 0

    def share_next_file(self):
        """Shares the oldest file waiting in the drop folder through the
        Stump's own /upload (so its shelf, quotas and credits apply), then
        moves it to drop/_shared."""
        try:
            waiting = sorted((os.path.getmtime(os.path.join(DROP_DIR, f)), f) for f in os.listdir(DROP_DIR)
                             if not f.startswith((".", "_")) and os.path.isfile(os.path.join(DROP_DIR, f)))
        except OSError:
            waiting = []
        if not waiting:
            self.busy("PUT FILES IN %s FIRST" % DROP_DIR, 4)
            return
        name = waiting[0][1]
        src = os.path.join(DROP_DIR, name)
        with open(src, "rb") as f:
            data = f.read()
        s, t = self.stump.post("/upload", data, "application/octet-stream",
                               {"X-Filename": urllib.parse.quote(name), "X-Filename-Encoding": "url"}, timeout=120)
        if s == 200:
            os.makedirs(os.path.join(DROP_DIR, "_shared"), exist_ok=True)
            shutil.move(src, os.path.join(DROP_DIR, "_shared", name))
            self.busy("SHARED %s" % name, 3)
        else:
            self.busy("SHARE: %s" % _msg(t, s), 4)
        self.next_info = 0

    def export_diagnostics(self):
        st, out = self.stump, ["R36MAX Stump diagnostics, %s (feed %s)" % (time.strftime("%Y-%m-%d %H:%M:%S"),
                                                                            FEED_VERSION)]
        for path in ("/node.json", "/hw.json", "/chain.json", "/stumps.json"):
            try:
                out.append("%s\n%s" % (path, json.dumps(st.get(path), indent=1)))
            except Exception as e:
                out.append("%s: %s" % (path, e))
        out.append("nmcli:\n" + self._nmcli("-t", "device")[1])
        try:
            with open(os.path.join(STUMP_DIR, "stump.log"), encoding="utf-8", errors="replace") as f:
                out.append("stump.log (last 200 lines):\n" + "".join(f.readlines()[-200:]))
        except OSError as e:
            out.append("stump.log: %s" % e)
        out.append("cockpit feed log:\n" + "\n".join(_LOG))
        p = self._tf_write("diagnostics_%s.txt" % time.strftime("%Y%m%d_%H%M%S"), "\n\n".join(out) + "\n")
        self.busy("DIAGNOSTICS SAVED TO TF CARD", 3)
        log("TF", p)

    # -- the live file the cockpit reads --
    def live_lines(self):
        node = self.node or {}
        port = self.stump.port
        hw = self.hw or {}
        radios = hw.get("radios") or []
        if radios:
            r0 = radios[0]
            rlabel = (r0.get("state") or "?").upper()[:7] + " " + os.path.basename(str(r0.get("device") or r0.get("where") or ""))
        else:
            lora = (hw.get("lora") or {}).get("state")
            rlabel = "VIA CHAIN" if lora in ("up", "connecting") else "NO RADIO"
        peers = len(self.stumps)
        out = ["META|%s|%d|%s" % (clean(node.get("lxmf") or "STUMP OFFLINE", 32), peers, clean(rlabel, 23))]
        ip =clean(node.get("ap_ip") or self.net.get("ip") or "127.0.0.1", 20)
        out.append("VER|%s|%s|%d|%d|%s|%d" % (
            clean(node.get("release") or "OFFLINE", 27), clean("PC Stump, feed " + FEED_VERSION, 27),
            1 if port == 80 else 0, 1 if port == 8080 else 0, ip, self.tf_count()))
        busy = time.time() < self.busy_until
        out.append("BUSY|%d|%s" % (1 if busy else 0, clean(self.busy_msg if busy else "READY", 54)))
        cfg_ssid = read_config().get("PC_HOTSPOT_NAME") or ""
        out.append("AP|%d|%s|%s|%s|%s|%d" % (1 if self.net["ap"] else 0, clean(self.net["ap_if"] or "wlan0", 16),
                                             clean(self.net["ap_mac"], 20), clean(self.net["ap_driver"], 16),
                                             clean(cfg_ssid or "Stump hotspot", 23), self.net["clients"]))
        ch = self.chain or {}
        if ch.get("enabled"):
            up = ch.get("uplink") or {}
            below = ch.get("below") or []
            role = ch.get("role") or "member"
            if role == "root":
                status = "FIRST STUMP · %d BELOW" % len(below)
            elif up.get("parent_heard_s") is not None:
                status = "LINKED TO %s (%ds AGO)" % (up.get("parent"), up.get("parent_heard_s"))
            else:
                status = "LOOKING FOR %s" % (up.get("parent") or "THE STUMP ABOVE")
            peer_ip = up.get("parent") or ch.get("lan_ip") or ip
            out.append("CHAIN|1|%d|%d|%s|%s|%d|%s|%s" % (1 if role == "root" else 2, 1 if ch.get("secret") else 0,
                                                         "(set in /admin)" if ch.get("secret") else "",
                                                         clean(ch.get("chain") or "none", 16),
                                                         len(below) + (1 if up.get("parent_heard_s") is not None else 0),
                                                         clean(peer_ip, 24), clean(status, 56)))
        else:
            out.append("CHAIN|0|0|0||none|0|%s|NOT IN A CHAIN (SET IT IN /admin)" % ip)
        for w in self.net["ssids"]:
            out.append("SSID|%d|%d|%s|%s" % (1 if w["active"] else 0, w["signal"], clean(w["sec"], 8), clean(w["ssid"], 28)))
        for i, room in enumerate(ROOMS):
            out.append("ROOM|%d|%s|%d" % (i, room.upper(), self.users[room]))
            for m in self.msgs[room][-10:]:
                sys_ = m.get("kind") == "system"
                nick = "*" if sys_ else (m.get("nick") or "?")
                if m.get("kind") == "dm":
                    nick = "DM " + nick
                out.append("MSG|%d|%d|%s|%s" % (i, 1 if sys_ else 0, clean(ascii_line(nick), 16),
                                                clean(ascii_line(m.get("body")), 44)))
        for p in self.board[:8]:
            out.append("BOARD|%s|%s|%s|%s" % (clean(p.get("id") or "", 24), clean(p.get("sig"), 14),
                                              clean(p.get("title"), 44), clean(p.get("body"), 48)))
        self.full_names = {}
        used = 0
        files = sorted(self.files, key=lambda f: -(f.get("mtime") or 0))
        for f in files:
            used += int(f.get("size") or 0)
        for f in files[:8]:
            shown = clean(f.get("name"), 35).replace(",", "_")
            self.full_names[shown] = f.get("name")
            cat = {"document": "DOC", "image": "IMG", "music": "AUDIO", "video": "VIDEO"}.get(f.get("cat"), "FILE")
            out.append("FILE|%s|%d|%s" % (shown, max(1, int(f.get("size") or 0) // 1024), cat))
        total_kb = int(read_config().get("PC_STORAGE_MB") or 2048) * 1024
        out.append("STORAGE|%d|%d|%d" % (used // 1024, int(total_kb * 0.75), total_kb))
        for line in _LOG[-16:]:
            out.append("LOG|%s" % clean(line, 62))
        return out

    def write_live(self):
        tmp = LIVE_TXT + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("\n".join(self.live_lines()) + "\n")
            os.chmod(tmp, 0o666)
            os.replace(tmp, LIVE_TXT)
        except OSError as e:
            log("ERR", "live file: %s" % e)

    # -- commands in --
    def open_ipc(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", IPC_PORT))
            s.setblocking(False)
            self.ipc = s
        except OSError as e:
            log("IPC", "UDP %d: %s (the command file still works)" % (IPC_PORT, e))

    def commands(self):
        lines = []
        while self.ipc:
            try:
                data, _ = self.ipc.recvfrom(4096)
            except (BlockingIOError, OSError):
                break
            lines.append(data.decode("utf-8", "replace"))
        try:
            if os.path.exists(CMD_TXT):
                tmp = CMD_TXT + ".feed"
                os.replace(CMD_TXT, tmp)
                with open(tmp, encoding="utf-8", errors="replace") as f:
                    lines += [l for l in f.read().splitlines() if l.strip()]
                os.remove(tmp)
        except OSError:
            pass
        return lines

    def loop(self, once=False):
        self.open_ipc()
        log("BOOT", "cockpit feed %s, Stump folder %s" % (FEED_VERSION, STUMP_DIR))
        while True:
            now = time.time()
            for line in self.commands():
                self.handle(line)
            if now >= self.next_info:
                self.refresh_info()
                self.next_info = now + INFO_S
            if now >= self.next_net:
                self.refresh_net()
                self.next_net = now + NET_S
            self.poll()
            self.write_live()
            if once:
                return
            if self.ipc:
                import select
                select.select([self.ipc], [], [], 0.5)
            else:
                time.sleep(0.5)


def discover_stumps(timeout=1.5):
    """Every Stump on this network (CLIENT_QUICKSTART "Finding a Stump on a
    Wi-Fi"): a STUMP? datagram to UDP 4244, broadcast; each answers with its
    card."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(0.3)
    found = {}
    try:
        s.sendto(b"STUMP? r36max", ("255.255.255.255", 4244))
        s.sendto(b"STUMP? r36max", ("127.0.0.1", 4244))
    except OSError:
        pass
    end = time.time() + timeout
    while time.time() < end:
        try:
            data, _ = s.recvfrom(4096)
            d = json.loads(data.decode("utf-8", "replace"))
            if isinstance(d, dict) and d.get("lxmf"):
                found[d["lxmf"]] = d
        except (socket.timeout, ValueError, OSError):
            continue
    s.close()
    return list(found.values())


def _split_nm(line):
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


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def _msg(text, status):
    try:
        d = json.loads(text)
        return clean(d.get("message") or d.get("error") or status, 40)
    except Exception:
        return clean(text or ("HTTP %s" % status), 40)


if __name__ == "__main__":
    if "--once" in sys.argv:
        Feed().loop(once=True)
    else:
        try:
            Feed().loop()
        except KeyboardInterrupt:
            pass
