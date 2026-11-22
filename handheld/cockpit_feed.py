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

The handheld's Wi-Fi is EmulationStation's: the network and its password
are chosen there, and the Stump uses whatever the handheld is on (it
follows a change of network by itself). The cockpit only shows it, and
turns the Stump's hotspot on or off through NetworkManager (nmcli), on an
adapter that network isn't using.

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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # limbs.py, next to this file (also under -I)
import limbs  # noqa: E402


def _version():
    """handheld/VERSION, the one place the release is written (package.sh, the tests)."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "VERSION"), encoding="utf-8") as f:
            return f.read().strip() or "2.7.4-b.87"
    except OSError:
        return "2.7.4-b.87"


FEED_VERSION = _version()

HOME = os.path.expanduser("~")
STUMP_DIR = os.environ.get("STUMP_DIR", os.path.join(HOME, "Stump"))
APP_DIR = os.environ.get("STUMP_R36MAX_DIR", "/roms/ports/stump_r36max")
TF_DIR = os.path.join(APP_DIR, "tf_backup")
DROP_DIR = os.path.join(APP_DIR, "drop")
LIVE_TXT = os.environ.get("STUMP_LIVE_FILE", "/dev/shm/stump_live.txt")
CMD_TXT = os.environ.get("STUMP_CMD_FILE", "/dev/shm/stump_cmd.txt")
IPC_PORT = int(os.environ.get("STUMP_IPC_PORT", "42421"))
NICK = os.environ.get("STUMP_COCKPIT_NICK", "r36max")
# OWNER → Button chimes and Message chime, kept for the next start.
SETTINGS = os.environ.get("STUMP_COCKPIT_SETTINGS") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "cockpit_settings.json")
MSG_CHIMES = ("dms", "all", "off")
MSG_CHIME_NAMES = ("DMs", "everything", "off")
HOTSPOT_CON = limbs.OLD_HOTSPOT                  # v2.0's single hotspot (limbs.py moves it)
LIMBS_FILE = os.environ.get("STUMP_LIMBS_FILE", os.path.join(APP_DIR, "limbs.json"))

ROOMS = ("main", "lora-mesh", "wifi-mesh")      # the Stump's built-in rooms: always first, in this order
MAX_ROOMS = 16                                  # what the cockpit shows (the Stump's others: /rooms)
KEEP_MSGS = 60                                  # a room's scrollback in the cockpit (all the Stump keeps: 60)
KEEP_ITEMS = 20                                 # notices and files listed (the cockpit scrolls them)
MAX_CMDS = 120                                  # the command menu's rows
ROOMS_S = 8.0                                   # the room list (/rooms, /setchan) asked again
MOD_ACTS = ("op", "deop", "mod", "demod", "kick", "mute", "unmute", "ban", "unban")
SCOPES = ("local", "wifi", "lora")
SCOPE_NAMES = ("local", "Wi-Fi chain", "LoRa")

import re  # noqa: E402
ROOM_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,31}$")
ROOMS_LINE = re.compile(r"^#(\S+) \u00b7(\d+)(?:  (.*))?$")      # /rooms: "#quiz ·2  its topic  [Wi-Fi]"
SETCHAN_LINE = re.compile(r"^#(\S+)  (local|wifi|lora)$")          # /setchan <pw>: "#quiz  wifi"
CHANREQ_LINE = re.compile(r"^(\d+)\. #(\S+)  (.*?)  \(")          # /chanreq <pw>: "1. #jardin  Oak  (3 min)"

# A command's admin password, in the Stump's words (fr, en, es): the menu puts • there, the feed the password.
PW_ARG = re.compile(r"<(mot de passe(?: admin)?|admin password|password|pw|contrase\u00f1a(?: admin)?)>", re.I)
PW_MARK = "\u2022"
CMDS_S = 120.0                                    # the command menu asked again
# The commands that can't be asked for without a password, from docs/COMMANDS.md.
DOCUMENTED = (
    ("Identity", "/whoami", "are you verified, and as whom"),
    ("Identity", "/auth", "prove an identity (an app answers the challenge)"),
    ("Identity", "/invite <nick> [room]", "bring someone into a hybrid room you're in"),
    ("Identity", "/lora", "who may use #lora-mesh from the web"),
    ("Rooms (owner)", "/create <password> #room -local|-wifi|-lora", "a new room: this Stump, the chain or the LoRa"),
    ("Owner (/admin)", "/admin <password> mode <open|hybrid|mandatory>", "who may enter this Stump"),
    ("Owner (/admin)", "/admin <password> room <name> <open|minted|hybrid>", "a room's tier"),
    ("Owner (/admin)", "/admin <password> meshroom", "#lora-mesh's status"),
    ("Owner (/admin)", "/admin <password> reset-access", "back to config.py's mode, no room tiers"),
    ("Owner (/admin)", "/admin <password> revoke <hexhash>", "forget a verified identity"),
    ("Owner (/admin)", "/admin <password> plugin [on|off <name>]", "the plugins, and turning one off or on"),
)

AUTH_CHECK_S = 60.0   # how often the cockpit asks the Stump whether it's still verified (/whoami)
POLL_S = 2.0          # the reference client's cadence (CLIENT_QUICKSTART "Polling cadence")
INFO_S = 5.0
NET_S = 4.0           # the Wi-Fi cards: often enough to notice one plugged in


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


_FONT_CHARS = []


def font_chars():
    """The characters the cockpit's font can draw: read from cockpit_font.bin
    (gen_font.py) next to this file. None without it: the engine then uses
    its 5x7 capitals font, which is ASCII only."""
    if not _FONT_CHARS:
        import struct
        chars = None
        try:
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "cockpit_font.bin"), "rb") as f:
                buf = f.read()
            if buf[:8] == b"CKFONT1\0":
                ng = struct.unpack_from("<I", buf, 12 + 12)[0]      # the first font's glyph count
                chars = set(chr(struct.unpack_from("<I", buf, 32 + 16 * k)[0]) for k in range(ng))
        except (OSError, struct.error):
            chars = None
        _FONT_CHARS.append(chars)
    return _FONT_CHARS[0]


def screen_line(s):
    """Text as the cockpit can draw it. With FireFly's font: as sent, symbols
    and accents included (✓ ~rod, café, → ...), as FireFly shows it; a
    character the font lacks is folded (é -> e) or dropped. Without it: ASCII,
    the symbols said in words."""
    import unicodedata
    s = str(s or "")
    chars = font_chars()
    if chars is None:
        if s.startswith("\u2713 "):                       # ✓ rod
            s = "+ %s joined" % s[2:]
        elif s.startswith("\u2717 "):                     # ✗ rod
            s = "- %s left" % s[2:]
        elif s.startswith("\u270e #"):                    # ✎ #main text
            room, _, text = s[2:].partition(" ")
            s = "%s topic: %s" % (room, text)
        elif s.startswith("\u270e "):                     # ✎ rod → bob
            s = "%s is now %s" % tuple((s[2:].split(" \u2192 ", 1) + [""])[:2])
        elif s.startswith("\u2296 "):                     # ⊖ ghost
            s = "no one here is called " + s[2:]
        for k, v in (("\u2192", "->"), ("\u2014", "-"), ("\u2013", "-"), ("\u2026", "..."), ("\u00b7", "."),
                     ("\u2298", "(refused)"), ("\u29d7", "(slow down)"), ("\u266a", "voice"),
                     ("\u00ab", '"'), ("\u00bb", '"'), ("\u2019", "'"), ("\u201c", '"'), ("\u201d", '"')):
            s = s.replace(k, v)
        s = s.replace("~", "")
        s = unicodedata.normalize("NFKD", s)
        return "".join(c for c in s if 32 <= ord(c) < 127)
    out = []
    for c in s.replace("\u29d7", "(slow down)"):
        if c in chars:
            out.append(c)
        elif ord(c) >= 32:
            out.append("".join(d for d in unicodedata.normalize("NFKD", c) if d in chars))
    return "".join(out)


def clip(s, nbytes):
    """At most nbytes of UTF-8, cut between characters: the engine keeps
    each field in a fixed number of bytes."""
    b = s.encode("utf-8")
    if len(b) <= nbytes:
        return s
    return b[:nbytes].decode("utf-8", "ignore")


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


# ── the Stump's own /admin forms, read as a browser reads them ──────

import html as _html
from html.parser import HTMLParser


class _Forms(HTMLParser):
    """Every <form> of a page: its action, and its controls as a browser
    sees them (name, type, value, checked, disabled), each with the text of
    the <label> around it and the <summary> of the group it's in -- so the
    cockpit shows the Stump's own words, in its language, and sends back
    exactly what a browser would."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.forms, self.form = {}, None
        self.label = None            # the control(s) of the <label> being read, and its text
        self.summary, self.in_summary, self.pk = "", False, 0
        self.textarea = None

    def handle_starttag(self, tag, attrs):
        a = dict((k, v if v is not None else "") for k, v in attrs)
        if tag == "form":
            self.form = self.forms.setdefault(a.get("action", ""), [])
        elif tag == "summary":
            self.in_summary, self.summary = True, ""
        elif tag == "span" and self.in_summary:
            self.pk += 1                                    # the summary's preview: not its title
        elif tag == "label":
            self.label = {"text": "", "controls": []}
        elif self.form is not None and tag in ("input", "textarea", "select") and a.get("name"):
            c = {"name": a["name"], "type": (a.get("type") or ("textarea" if tag == "textarea" else "text")).lower(),
                 "value": a.get("value", ""), "checked": "checked" in a, "disabled": "disabled" in a,
                 "label": "", "group": self.summary.strip(), "max": a.get("maxlength") or a.get("max") or ""}
            if c["type"] in ("submit", "button", "reset", "image", "file"):
                return
            self.form.append(c)
            if self.label is not None:
                self.label["controls"].append(c)
            if tag == "textarea":
                self.textarea = c

    def handle_endtag(self, tag):
        if tag == "form":
            self.form = None
        elif tag == "summary":
            self.in_summary = False
        elif tag == "span" and self.in_summary and self.pk:
            self.pk -= 1
        elif tag == "label" and self.label is not None:
            for c in self.label["controls"]:
                c["label"] = " ".join(self.label["text"].split())
            self.label = None
        elif tag == "textarea":
            self.textarea = None

    def handle_data(self, data):
        if self.textarea is not None:
            self.textarea["value"] += data
        elif self.in_summary and not self.pk:
            self.summary += data
        elif self.label is not None:
            self.label["text"] += data


def parse_forms(page):
    """{action: [control, ...]} of an HTML page."""
    p = _Forms()
    try:
        p.feed(page or "")
        p.close()
    except Exception:
        pass
    return p.forms


def form_body(controls, changes):
    """What a browser submits for this form, with changes ({name: value};
    a checkbox: "1" ticked, "" not): text, textareas and hidden fields, the
    radio and checkboxes that are checked; disabled ones left out, as a
    browser does."""
    out, done = [], set()
    for c in controls:
        n, t = c["name"], c["type"]
        if t == "radio":
            if n in done:
                continue
            if n in changes:
                v = changes[n]
            else:
                v = next((x["value"] for x in controls if x["name"] == n and x["type"] == "radio" and x["checked"]), None)
            done.add(n)
            if v is not None:
                out.append((n, v))
        elif t == "checkbox":
            on = (changes[n] not in ("", "0")) if n in changes else (c["checked"] and not c["disabled"])
            if on:
                out.append((n, c["value"] or "1"))
        elif not c["disabled"] or n in changes:
            out.append((n, changes.get(n, c["value"])))
    return "&".join("%s=%s" % (urllib.parse.quote(k, safe=""), urllib.parse.quote(str(v), safe="")) for k, v in out)


def page_notice(page):
    """The message the Stump puts on top of its page after a form (saved,
    unchanged, a field not accepted...)."""
    import re
    m = re.search(r"<p class='sub'><b>(.*?)</b></p>", page or "", re.S)
    return " ".join(_html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).split()) if m else ""


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
        extra = [int(os.environ["STUMP_HTTP_PORT"])] if os.environ.get("STUMP_HTTP_PORT", "").isdigit() else []
        for port in ([self.port] if self.port else []) + extra + [80, 8080]:
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
        # Every room the Stump has (its poll's list, /rooms' counts and topics,
        # /setchan's reach), as the web chat lists them; who's in ours.
        self.room_info = {r: {"count": 0, "topic": "", "scope": ""} for r in ROOMS}
        self.room_order = list(ROOMS)
        self.people = []
        self.my_nick = NICK
        # Sound: the buttons' chimes on or off; the message chime for DMs (the
        # default), everything, or off. chime_seq counts the messages that
        # deserved one; the engine chimes when it goes up (SOUND| line).
        self.sound = {"chimes": True, "msg": "dms"}
        try:
            with open(SETTINGS) as f:
                saved = json.load(f)
            if isinstance(saved.get("chimes"), bool):
                self.sound["chimes"] = saved["chimes"]
            if saved.get("msg") in MSG_CHIMES:
                self.sound["msg"] = saved["msg"]
        except (OSError, ValueError, AttributeError):
            pass
        self.chime_seq = 0
        self.next_rooms = 0.0
        # The OWNER tab: the form on screen, what it last heard back.
        self.form = "owner"
        self.replies = []
        self.new_scope = "local"
        self.mod_where = "room"
        self.setup = None                  # the Stump's /admin/setup form, as a browser reads it
        self.requests = []                 # LoRa rooms other Stumps offer (/chanreq)
        self.catalog = []                 # every command it knows (the cockpit's menu)
        self.show_pw_until = 0.0
        self.next_cmds = 0.0
        self.node = None
        self.hw = {}
        self.chain = {"enabled": False}
        self.stumps = []
        self.chat_stumps = set()           # Stumps the chat knows (they can be ahead of the beacons)
        self.board = []
        self.files = []
        self.net = {"ap": False, "ap_if": "", "ap_mac": "", "ap_driver": "", "clients": 0,
                    "ip": "", "ssids": [], "ap_ssid": ""}
        self.limbs = limbs.Limbs(nmcli=lambda *a, **k: self._nmcli(*a, **k), iw_phy=_iw_phy, iw_dev=_iw_stations,
                                 state_file=LIMBS_FILE, config=read_config)
        self.ap_keys = None                # the cards running an AP at the last look (None: not looked yet)
        self.busy_until, self.busy_msg = 0.0, "READY"
        self.full_names = {}               # shown (truncated) file name -> the real one
        self.full_ssids = {}               # shown SSID -> the real one
        self.next_info = self.next_net = 0.0
        self.nick_set = False
        # Verified with its own identity (/auth, as FireFly does): a Stump set
        # to hybrid or closed lets only a verified identity write (closed: read).
        self.verified = None               # the identity hash the Stump verified it as
        self.next_auth = self.next_auth_check = 0.0
        self.ipc = None

    # -- status line on the cockpit --
    def busy(self, msg, secs=2.5):
        self.busy_msg, self.busy_until = clip(clean(screen_line(msg), 54), 62), time.time() + secs
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

    @staticmethod
    def locked_out(sent, replies):
        """The Stump's answer says this client isn't verified (it's set to
        hybrid or closed, or it restarted and forgot): every such answer
        points to /auth. Not /help's list or /auth's own answers."""
        low = sent.strip().lower()
        if low.startswith("/help") or low.startswith("/auth"):
            return False
        return any("/auth" in str(r) and not str(r).startswith("AUTH-") for r in replies or [])

    def authenticate(self):
        """/auth with the cockpit's own identity, as FireFly does: the Stump's
        challenge signed by cockpit_auth.py (the Stump's own Reticulum code,
        its Python) and sent back. The identity hash, or None."""
        st = self.stump
        here = os.path.dirname(os.path.abspath(__file__))
        tool = os.path.join(here, "cockpit_auth.py")
        py = os.path.join(STUMP_DIR, "venv", "bin", "python")
        if not os.path.isfile(tool):
            log("AUTH", "cockpit_auth.py isn't next to the feed: run the update again")
            return None
        nonce = next((m.group(1) for r in st.send("/auth") for m in [re.match(r"AUTH-CHALLENGE ([0-9a-f]+)", str(r))] if m),
                     None)
        if not nonce:
            log("AUTH", "the Stump gave no challenge")
            return None
        try:
            p = subprocess.run([py if os.path.isfile(py) else sys.executable, "-I", tool, "--stump", STUMP_DIR,
                                "--key", os.environ.get("STUMP_COCKPIT_IDENTITY") or os.path.join(here, "cockpit_identity"),
                                "sign"],
                               input=nonce + "\n", stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               universal_newlines=True, timeout=60)
            pub, sig = p.stdout.split()
        except (OSError, ValueError, subprocess.TimeoutExpired) as e:
            log("AUTH", "couldn't sign the challenge: %s" % ((p.stderr.strip().splitlines() or [str(e)])[-1]
                                                              if "p" in locals() else e))
            return None
        said = st.send("/auth %s %s" % (pub, sig))
        ok = next((str(r)[8:].strip() for r in said if str(r).startswith("AUTH-OK ")), None)
        if ok:
            if ok != self.verified:
                log("AUTH", "verified as %s (the cockpit's own identity)" % ok)
            self.verified = ok
            self.nick_set = False                  # (a closed Stump refused the name before)
        else:
            log("AUTH", "not verified: %s" % " ".join(str(r) for r in said))
        return ok

    def poll(self):
        st = self.stump
        if st.port is None or time.time() < st.next_poll:
            return
        try:
            if not st.has_cookie():
                st.visit()
            now = time.time()
            if self.verified and now >= self.next_auth_check:
                # Still verified? (A Stump that restarted has forgotten.)
                self.next_auth_check = now + AUTH_CHECK_S
                if any("not verified" in str(r) for r in st.send("/whoami")):
                    self.verified = None
            if not self.verified and now >= self.next_auth:
                self.next_auth = now + 60
                if self.authenticate():
                    self.next_auth_check = now + AUTH_CHECK_S
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
            backlog = st.since == 0                   # its scrollback (or DMs from before): not news
            if room != st.room:
                # Joined (or moved to) another room: the poll below brings its
                # whole scrollback, so start that room's lines afresh.
                st.room, st.since = room, 0
                self.msgs[room] = []
                backlog = True
            for m in (d.get("messages") or []) + (d.get("dms") or []):
                mid = int(m.get("id") or 0)
                st.since = max(st.since, mid)
                if all(int(x.get("id") or 0) != mid for x in self.msgs.setdefault(room, [])):
                    self.msgs[room].append(m)
                    del self.msgs[room][:-KEEP_MSGS]
                    if not backlog and str(m.get("nick") or "") != str(d.get("nick") or self.my_nick):
                        self.message_arrived(m.get("kind"))
                if m.get("kind") == "dm":
                    log("DM", "%s: %s" % (m.get("nick"), m.get("body")))
            self.users[room] = len(d.get("users") or [])
            self.people = [u for u in (d.get("users") or []) if isinstance(u, str)]
            self.my_nick = str(d.get("nick") or NICK)
            self.msgs.setdefault(room, [])
            for r in [room] + [x for x in (d.get("rooms") or []) if isinstance(x, str)]:
                if r not in self.room_order and ROOM_RE.match(r):
                    self.room_order.append(r)
                    self.room_info.setdefault(r, {"count": 0, "topic": "", "scope": ""})
            if d.get("rooms"):                       # gone from the Stump: off the list (not the built-in ones)
                live = set(d["rooms"]) | set(ROOMS) | {room, self.want_room}
                self.room_order = [r for r in self.room_order if r in live]
            if d.get("topic") is not None:
                self.room_info.setdefault(room, {"count": 0, "topic": "", "scope": ""})["topic"] = str(d["topic"])
            self.chat_stumps = set(d.get("stumps") or [])
            st.fail = 0
            st.next_poll = time.time() + POLL_S * (1 + 0.3 * (os.getpid() % 10) / 10)
        except Exception as e:
            st.fail += 1
            st.next_poll = time.time() + min(30.0, POLL_S * (2 ** st.fail))
            if st.fail in (1, 4):
                log("CHAT", "poll failed: %s" % e)

    # -- every room the Stump has --
    def admin_pw(self):
        """The password /admin takes, as the Stump checks it (stumpid's
        check_admin_password): AUTH_ADMIN_PASSWORD, or when that's blank the
        fserv bot operator's, the one the computer wizard asks for."""
        cfg = read_config()
        return str(cfg.get("AUTH_ADMIN_PASSWORD") or cfg.get("FSERVBOT_OP_PASSWORD") or "")

    def refresh_rooms(self):
        """Its rooms, as /rooms lists them (people, topic) and /setchan (each
        one's reach: this Stump, the chain's Wi-Fi, the LoRa); and, on the
        owner's Rooms page, the LoRa rooms other Stumps offer (/chanreq)."""
        st = self.stump
        if st.port is None:
            return
        for line in st.send("/rooms"):
            m = ROOMS_LINE.match(str(line).strip())
            if not m or not ROOM_RE.match(m.group(1)):
                continue
            r, rest = m.group(1), (m.group(3) or "")
            rest = re.sub(r"\s*\[(Wi-Fi|LoRa[^\]]*)\]$", "", rest).strip()
            info = self.room_info.setdefault(r, {"count": 0, "topic": "", "scope": ""})
            info["count"], info["topic"] = int(m.group(2)), rest
            if r not in self.room_order:
                self.room_order.append(r)
        pw = self.admin_pw()
        if not pw:
            return
        for line in st.send("/setchan %s" % pw):
            m = SETCHAN_LINE.match(str(line).strip())
            if m and m.group(1) in self.room_info:
                self.room_info[m.group(1)]["scope"] = m.group(2)
        if self.form == "rooms":
            self.requests = []
            for line in st.send("/chanreq %s" % pw):
                m = CHANREQ_LINE.match(str(line).strip())
                if m:
                    self.requests.append({"n": int(m.group(1)), "room": m.group(2), "name": m.group(3)})

    def new_room(self, name, scope):
        """A room: "local" (only on this Stump: /join makes it, anyone may),
        or reaching the chain or the LoRa (/create, the owner's); then it's
        the room on screen."""
        slug = re.sub(r"[^a-z0-9_.-]", "", str(name).strip().lower().lstrip("#").replace(" ", "-"))[:32].strip(".-")
        st = self.stump
        if not slug or not ROOM_RE.match(slug):
            self.busy("A room's name: letters, digits, - or _", 3)
            return
        if st.port is None:
            self.busy("The Stump isn't answering yet", 2.5)
            return
        if scope != "local":
            pw = self.admin_pw()
            if not pw:
                self.busy("No admin password on this Stump: no rooms beyond it", 4)
                return
            said = st.send("/create %s #%s -%s%s" % (pw, slug, scope, " confirm" if scope == "lora" else ""))
            self.heard(said)
            if any(str(x).startswith("\u2717") for x in said):
                return
        for r in st.send("/join #" + slug):
            log("CHAT", r)
        self.room_info.setdefault(slug, {"count": 0, "topic": "", "scope": scope})
        if slug not in self.room_order:
            self.room_order.append(slug)
        self.want_room, st.next_poll, self.next_rooms = slug, 0, 0
        self.busy("#%s: you're in it" % slug, 3)

    def answer(self, room, said):
        """What the Stump answered a command typed or picked here: in the
        room, as lines for us only (the web chat shows them the same way),
        and on the status line."""
        said = [str(x) for x in said or [] if str(x).strip()]
        if not said:
            return
        lines = self.msgs.setdefault(room, [])
        for x in said:
            lines.append({"id": 0, "kind": "system", "nick": "*", "body": x})
        del lines[:-KEEP_MSGS]
        self.busy(said[0], 4)

    def heard(self, said):
        """What the Stump answered an owner's command: on the status line, and
        under the form it came from."""
        said = [str(x) for x in said or [] if str(x).strip()]
        for x in said:
            log("OWNER", x)
        if said:
            self.busy(said[0], 4)
        self.replies = (self.replies + said)[-6:]

    # -- every command the Stump knows: the cockpit's command menu --
    def refresh_commands(self):
        """Every command this Stump answers, read from it without posting a
        line anywhere: /help (the chat's, and its packs' with help), /help mods,
        /setchan and /chanreq (their usage), /fshelp and /fslist (the file bot
        and its !words), /plugins.json (every pack's commands, those without
        help too); and the ones that can't be asked for without a password
        (/create, /admin's), from the command reference (docs/COMMANDS.md)."""
        st = self.stump
        if st.port is None:
            return
        cmds, seen = [], set()

        def add(group, syntax, desc="", word=None):
            syntax = " ".join(str(syntax).split())
            word = word or syntax.split(" ")[0]
            if not re.match(r"^[/!][\w.-]+$", word):
                return
            key = (word, syntax)
            if key in seen:
                return
            seen.add(key)
            pw = bool(PW_ARG.search(syntax))
            if pw:                                  # the admin password: filled in by the feed (•)
                syntax = PW_ARG.sub(PW_MARK, syntax, count=1)
            cmds.append({"group": group, "word": word, "syntax": syntax, "desc": " ".join(str(desc).split()),
                         "args": " " in syntax, "pw": pw})

        def help_line(group, line):
            line = str(line).strip()
            if line[:1] not in "/!":
                return                                  # (the key to the symbols, a heading)
            if " : " in line:                           # "/kick <#room> <nick> : out of the room"
                syn, desc = line.split(" : ", 1)
            elif re.search(r"\s{2,}", line):            # "/rooms            list the rooms"
                syn, desc = re.split(r"\s{2,}", line, maxsplit=1)
            else:                                       # "/msg <who> <text> a private message"
                toks, k = line.split(" "), 1
                while k < len(toks) and re.match(r"^([<\[#|-].*|.*[>\]]|::)$", toks[k]):
                    k += 1
                syn, desc = " ".join(toks[:k]), " ".join(toks[k:])
            syn = syn.split(" (")[0]                     # "/setchan <pw> ... (or /setchan <pw>: ...)"
            if desc.endswith(")") and "(" not in desc:
                desc = desc[:-1]
            words = syn.split()
            if all(w.startswith("!") for w in words):   # "!fserv !help   the file bot"
                for w in words:
                    add("File bot: its words", w, desc)
                return
            add(group, syn, desc)
        try:
            for line in st.send("/help"):
                help_line("Chat", line)
            for line in st.send("/help mods"):
                help_line("Moderation", line)
            for c in ("/setchan", "/chanreq"):
                for line in st.send(c):
                    help_line("Rooms (owner)", line)
            for line in st.send("/fshelp"):
                help_line("File bot", line)
            for line in st.send("/fslist"):
                for w in re.findall(r"(?<![\w])([!][\w-]+)", str(line)):
                    add("File bot: its words", w, "")
        except Exception as e:
            log("CMDS", "asking the Stump: %s" % e)
        for group, syntax, desc in DOCUMENTED:
            add(group, syntax, desc)
        try:
            pj = st.get("/plugins.json")
            for p in pj.get("plugins") or []:
                for w in p.get("commands") or []:
                    if not any(c["word"] == "/" + w for c in cmds):
                        add("Pack: %s %s" % (p.get("name"), p.get("version") or ""), "/" + w, "")
        except Exception as e:
            log("CMDS", "/plugins.json: %s" % e)
        # the packs' commands, each under its pack's name (those /help described too)
        try:
            owner = {"/" + w: "Pack: %s %s" % (p.get("name"), p.get("version") or "")
                     for p in (pj.get("plugins") or []) for w in (p.get("commands") or [])
                     if p.get("name") not in ("fservbot", "stumpid")}
            for c in cmds:
                if c["word"] in owner:
                    c["group"] = owner[c["word"]]
        except Exception:
            pass
        order = ["Chat", "Identity", "Moderation", "Rooms (owner)", "Owner (/admin)", "File bot", "File bot: its words"]
        cmds.sort(key=lambda c: (order.index(c["group"]) if c["group"] in order else len(order), c["group"]))
        if cmds:
            self.catalog = cmds

    def make_password(self):
        """A Stump with no admin password at all: one made here (12 letters
        and digits), written by set_password."""
        import secrets
        words = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(12))
        self.set_password("-".join(words[i:i + 4] for i in range(0, 12, 4)), made=True)

    @staticmethod
    def password_problem(pw):
        """Why a typed admin password can't be used, or "". The chat's owner
        commands take it as one word (/setchan <password> #room...)."""
        if len(pw) < 4:
            return "At least 4 characters"
        if any(c.isspace() for c in pw):
            return "No spaces: the chat's owner commands take it as one word"
        if PW_MARK in pw or "|" in pw:
            return "No \u2022 and no vertical bar in it"
        return ""

    def set_password(self, pw, made=False):
        """The owner's handheld sets its Stump's admin password (typed, or
        made here): AUTH_ADMIN_PASSWORD, written with the Stump's own
        settings.write_config (admin_password.py, config.py.bak kept), then
        the Stump restarted to take it. Never logged."""
        why = self.password_problem(pw)
        if why:
            self.busy(why, 4)
            return False
        tool = os.path.join(os.path.dirname(os.path.abspath(__file__)), "admin_password.py")
        py = os.path.join(STUMP_DIR, "venv", "bin", "python")
        if not os.path.isfile(tool):
            self.busy("admin_password.py isn't next to the feed: run install.sh again", 5)
            return False
        had = bool(self.admin_pw())
        try:
            p = subprocess.run([py if os.path.isfile(py) else sys.executable, "-I", tool, "--stump", STUMP_DIR, "set"],
                               input=pw + "\n", stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               universal_newlines=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired) as e:
            self.busy("Couldn't set it: %s" % e, 5)
            return False
        if self.admin_pw() != pw:
            self.busy("Couldn't set it: %s" % (p.stdout.strip().splitlines() or ["?"])[-1], 5)
            return False
        log("OWNER", "the admin password was %s here%s" % ("changed" if had else "set",
                                                          " (Show the admin password to see it)" if made else ""))
        if made:
            self.show_pw_until = time.time() + 30
        self.busy("Admin password %s: the Stump restarts to take it" % ("changed" if had else "set"), 6)
        self.restart_stump("its new admin password")
        return True

    def fill_password(self, text):
        """A command from the menu with the admin password's place (•) filled,
        here on the handheld (the cockpit never has the password)."""
        if PW_MARK not in text or not text.startswith("/"):
            return text
        pw = self.admin_pw()
        toks = text.split(" ")
        if len(toks) > 1 and toks[1] == PW_MARK and pw:
            toks[1] = pw
        return " ".join(toks)

    # -- the OWNER tab: the Stump's owner on their own handheld --
    def open_form(self, fid):
        if fid not in ("owner", "setup", "rooms", "people"):
            return
        self.form, self.replies = fid, []
        if fid == "setup":
            self.fetch_setup()
        elif fid == "rooms":
            self.next_rooms = 0

    def admin_page(self, path="/admin", body=None):
        """An /admin page, logged in with the owner's password (a session, as
        a browser keeps one): (status, html)."""
        pw = self.admin_pw()
        st = self.stump
        if not pw or st.port is None:
            return 0, ""
        if body is None:
            body = "admin_pass=" + urllib.parse.quote(pw, safe="")
        return st.post(path, body, "application/x-www-form-urlencoded", {"Accept": "text/html"}, timeout=20)

    def fetch_setup(self):
        s, page = self.admin_page()
        forms = parse_forms(page) if s == 200 else {}
        self.setup = forms.get("/admin/setup")
        if self.setup is None:
            self.busy("Couldn't read the Stump's settings (%s)" % (s or "no admin password"), 4)

    def form_set(self, fid, key, value):
        st, pw = self.stump, self.admin_pw()
        if fid == "owner" and key == "makepw" and not pw:
            self.make_password()
            return
        if fid == "owner" and key == "setpw":         # typed on the handheld: set, or changed
            self.set_password(value)
            return
        if fid == "owner" and key in ("chimes", "msgchime"):   # this handheld's sound: no password
            try:
                n = int(value)
            except ValueError:
                return
            if key == "chimes" and n in (0, 1):
                self.sound["chimes"] = n == 0
            elif key == "msgchime" and 0 <= n < len(MSG_CHIMES):
                self.sound["msg"] = MSG_CHIMES[n]
                if MSG_CHIMES[n] != "off":
                    self.chime_seq += 1                # hear it
            self.save_sound()
            return
        if not pw:
            self.busy("No admin password on this Stump", 3)
            return
        try:
            n = int(value)
        except ValueError:
            n = -1
        if fid == "owner":
            if key == "showpw":
                self.show_pw_until = time.time() + 30
            elif key == "announce":
                s, page = self.admin_page("/admin/announce")
                self.busy(page_notice(page) or ("Announce: HTTP %s" % s), 4)
            elif key == "restart":
                self.busy("Restarting the Stump\u2026", 6)
                self.restart_stump("from the owner tools")
        elif fid == "setup":
            ctl = [c for c in (self.setup or []) if c["name"] == key]
            if not ctl:
                return
            if ctl[0]["type"] == "radio":
                if not 0 <= n < len(ctl):
                    return
                value = ctl[n]["value"]
            s, page = self.admin_page("/admin/setup", form_body(self.setup, {key: value, "admin_pass": pw}))
            self.busy(page_notice(page) or ("Settings: HTTP %s" % s), 5)
            self.fetch_setup()
            self.next_info = 0
        elif fid == "rooms":
            if key.startswith("room:") and 0 <= n < len(SCOPES):
                r = key[5:]
                self.heard(st.send("/setchan %s #%s -%s%s" % (pw, r, SCOPES[n], " confirm" if SCOPES[n] == "lora" else "")))
            elif key == "new_scope" and 0 <= n < len(SCOPES):
                self.new_scope = SCOPES[n]
            elif key == "new":
                self.new_room(value, self.new_scope)
            elif key == "topic":
                self.heard(st.send("/topic " + value.strip()) or ["\u270e #%s" % (st.room or self.want_room)])
            elif key.startswith("req:") and n in (1, 2):
                self.heard(st.send("/chanreq %s -%s %s" % (pw, "a" if n == 1 else "r", key[4:])))
            self.next_rooms = 0
        elif fid == "people":
            room = st.room or self.want_room
            if key == "where" and n in (0, 1):
                self.mod_where = ("room", "stump")[n]
            elif key.startswith("p:") and 1 <= n <= len(MOD_ACTS):
                act, nick = MOD_ACTS[n - 1], key[2:]
                where = "-stump" if self.mod_where == "stump" and act != "kick" else "#" + room
                self.heard(st.send("/%s %s %s %s" % (act, pw, where, nick)))
            elif key == "roles":
                self.heard(st.send("/roles " + ("-stump" if self.mod_where == "stump" else "#" + room)))
            elif key == "bans":
                self.heard(st.send("/bans %s %s" % (pw, "-stump" if self.mod_where == "stump" else "#" + room)))
            st.next_poll = 0

    def message_arrived(self, kind):
        """A new line from someone else: the message chime, if OWNER →
        Message chime wants it (DMs: private messages only)."""
        want = self.sound["msg"]
        if want == "all" and kind in ("msg", "action", "dm") or want == "dms" and kind == "dm":
            self.chime_seq += 1
            return True
        return False

    def save_sound(self):
        try:
            with open(SETTINGS + ".tmp", "w") as f:
                json.dump(self.sound, f)
            os.replace(SETTINGS + ".tmp", SETTINGS)
        except OSError as e:
            log("SOUND", "couldn't keep the sound settings: %s" % e)

    def sound_rows(self, row):
        return [row("", "info", "This handheld's sound",
                    hint="USB-C headphones when plugged in, else the speaker"),
                row("chimes", "choice", "Button chimes", "on" if self.sound["chimes"] else "off", ("on", "off"),
                    0 if self.sound["chimes"] else 1, ask=2, hint="the short sounds as you press buttons"),
                row("msgchime", "choice", "Message chime", MSG_CHIME_NAMES[MSG_CHIMES.index(self.sound["msg"])],
                    MSG_CHIME_NAMES, MSG_CHIMES.index(self.sound["msg"]), ask=2,
                    hint="two notes when a message arrives (DMs: private messages to you)")]

    def form_rows(self):
        """The form on screen: (title, the form B goes back to, rows). A row:
        {key, kind (open, choice, toggle, text, action, info), label, value,
        options, sel, ask (1: asks first; 2: a choice that applies as it's
        picked), max (bytes), hint}."""
        def row(key, kind, label, value="", options=(), sel=0, ask=False, mx=0, hint=""):
            return {"key": key, "kind": kind, "label": label, "value": value, "options": list(options), "sel": sel,
                    "ask": ask, "max": mx, "hint": hint}
        room = self.stump.room or self.want_room
        pw = self.admin_pw()
        if not pw:
            return "Owner tools", "", [
                row("", "info", "No admin password on this Stump yet",
                    hint="/admin, its rooms and its people need one"),
                row("setpw", "text", "Set the admin password", mx=64,
                    hint="type your own: 4 characters or more, no spaces"),
                row("makepw", "action", "Make one for me", ask=1,
                    hint="the cockpit fills it in for you; shown here when you need it on a phone")] + self.sound_rows(row)
        if self.form == "setup":
            rows, seen = [], set()
            for c in self.setup or []:
                t, nm = c["type"], c["name"]
                if t == "hidden" or nm in seen:
                    continue
                if t == "radio":
                    seen.add(nm)
                    opts = [x for x in self.setup if x["name"] == nm and x["type"] == "radio"]
                    sel = next((i for i, x in enumerate(opts) if x["checked"]), 0)
                    rows.append(row(nm, "choice", c["group"] or nm, opts[sel]["label"],
                                    [x["label"].split(" \u2014 ")[0] for x in opts], sel, hint=opts[sel]["label"]))
                elif t == "checkbox":
                    rows.append(row(nm, "toggle", c["label"] or nm, "1" if c["checked"] else "0",
                                    hint=c["label"] if len(c["label"]) > 42 else c["group"]))
                else:
                    mx = int(c["max"]) if t != "number" and str(c["max"]).isdigit() else (200 if t == "textarea" else 64)
                    rows.append(row(nm, "text", c["label"] or nm, c["value"], mx=mx,
                                    hint=c["label"] if len(c["label"]) > 42 else c["group"]))
            if not rows:
                rows.append(row("", "info", "Reading the Stump's own settings\u2026"))
            return "Stump settings", "owner", rows
        if self.form == "rooms":
            rows = [row("", "info", "Each room reaches this Stump, the chain or LoRa",
                        hint="local: only here  \u00b7  Wi-Fi: every Stump of the chain  \u00b7  LoRa: the radio")]
            for r in self.room_order:
                i = self.room_info.get(r) or {}
                sc = i.get("scope") or "local"
                what = "%d here%s" % (i.get("count", 0), ("  \u00b7  " + i["topic"]) if i.get("topic") else "")
                if r in ROOMS:
                    rows.append(row("", "info", "#%s  %s (built in)" % (r, dict(zip(SCOPES, SCOPE_NAMES)).get(sc, sc)),
                                    hint=what))
                else:
                    rows.append(row("room:" + r, "choice", "#" + r, sc, SCOPE_NAMES, SCOPES.index(sc) if sc in SCOPES else 0,
                                    ask=True, hint=what))
            rows.append(row("new_scope", "choice", "A new room reaches", self.new_scope,
                            ("this Stump", "the chain (Wi-Fi)", "the LoRa"), SCOPES.index(self.new_scope), ask=2))
            rows.append(row("new", "text", "Create a room", "", mx=32, hint="its name; you join it"))
            rows.append(row("topic", "text", "Topic of #" + room, (self.room_info.get(room) or {}).get("topic", ""),
                            mx=120, hint="/topic in the room on screen"))
            for q in self.requests:
                rows.append(row("req:%d" % q["n"], "choice", "LoRa room #%s from %s" % (q["room"], q["name"]), "",
                                ("\u2014", "accept", "refuse"), 0, ask=True, hint="another Stump offers it (/chanreq)"))
            rows += [row("", "info", x) for x in self.replies]
            return "Rooms", "owner", rows
        if self.form == "people":
            rows = [row("where", "choice", "Where", "", ("#" + room + " only", "every room of this Stump"),
                        0 if self.mod_where == "room" else 1, ask=2)]
            others = [u for u in self.people if u != self.my_nick]
            for u in others:
                rows.append(row("p:" + u, "choice", u, "", ("\u2014",) + MOD_ACTS, 0, ask=True,
                                hint="op, mod, kick, mute, ban... (A asks first)"))
            if not others:
                rows.append(row("", "info", "Nobody else in #%s right now" % room))
            rows += [row("roles", "action", "Who's op or mod"), row("bans", "action", "Who's banned or muted")]
            rows += [row("", "info", x) for x in self.replies]
            return "People in #" + room, "owner", rows
        n = len(self.room_order)
        here = len([u for u in self.people if u != self.my_nick])
        return "Owner tools", "", [
            row("setup", "open", "Stump settings", hint="name, bot, language, announces, files, who may enter, features"),
            row("rooms", "open", "Rooms", hint="%d rooms  \u00b7  their reach, new rooms, LoRa offers" % n),
            row("people", "open", "People in #" + room, hint="%d other%s here  \u00b7  op, mod, kick, mute, ban"
                % (here, "" if here == 1 else "s")),
            row("showpw", "action", "Show the admin password", ask=1,
                hint=("%s  (for /admin on a phone; hidden again in 30 s)" % pw) if time.time() < self.show_pw_until
                else "you never type it here: the cockpit fills it in"),
            row("setpw", "text", "Change the admin password", mx=64,
                hint="type the new one: 4 characters or more, no spaces"),
            row("announce", "action", "Announce now", ask=True, hint="its address and beacon, at once"),
            row("restart", "action", "Restart the Stump", ask=True, hint="settings that wait for a restart"),
            row("", "info", "The rest: /admin on a phone",
                hint="on its hotspot: the radio, the chain, plugins, themes, layout..."),
        ] + self.sound_rows(row)

    # -- the handheld's Wi-Fi (the OS's, via NetworkManager) --
    def _nmcli(self, *args, timeout=25):
        ok, out = run(["nmcli"] + list(args), timeout=timeout)
        if not ok and ("authoriz" in out.lower() or "permission" in out.lower() or "insufficient" in out.lower()):
            ok, out = run(["sudo", "-n", "nmcli"] + list(args), timeout=timeout)
        return ok, out

    def refresh_net(self):
        cards = self.limbs.scan()
        aps = [c for c in cards if c["job"] == "ap"]
        first = aps[0] if aps else (cards[0] if cards else None)
        self.net["ap"] = bool(aps)
        self.net["ap_if"] = first["iface"] if first else "wlan0"
        self.net["ap_mac"] = first["key"] if first else ""
        self.net["ap_driver"] = first["driver"] if first else ""
        self.net["ap_ssid"] = aps[0]["info"].split(" \u00b7 ")[0] if aps else ""
        self.net["clients"] = sum(c["clients"] for c in aps)
        # Cards plugged in or pulled out: say so; a remembered AP is already
        # back (NetworkManager), any other AP-capable card is offered a job.
        new, gone = self.limbs.new_and_gone()
        for c in new:
            if c["job"] == "ap":
                self.busy("%s is back as an AP" % c["name"], 5)
            elif c["ap_ok"]:
                self.busy("New Wi-Fi: %s, AP-capable: give it a job (NETWORK)" % c["name"], 8)
            else:
                self.busy("New Wi-Fi: %s (no AP mode)" % c["name"], 5)
        for key in gone:
            self.busy("A Wi-Fi card was unplugged", 4)
            log("NET", "card %s unplugged" % key)
        # The Stump's sign-in DNS answers with its hotspot address, chosen when
        # it starts: one restart whenever the cards running an AP change.
        keys = sorted(c["key"] for c in aps)
        if self.ap_keys is not None and keys != self.ap_keys:
            self.restart_stump("APs now: %s" % (", ".join(c["name"] for c in aps) or "none"))
        self.ap_keys = keys
        # The Wi-Fi is EmulationStation's: the network(s) the handheld is on
        # now, shown, never chosen here (the APs' own networks left out).
        ok, out = self._nmcli("-t", "-f", "IN-USE,SIGNAL,SECURITY,SSID", "device", "wifi", "list", "--rescan", "no")
        own = set(c["info"].split(" \u00b7 ")[0] for c in aps)
        ssids, seen = [], set()
        for line in out.splitlines() if ok else []:
            p = _split_nm(line)
            if len(p) >= 4 and p[0] == "*" and p[3] and p[3] not in seen and p[3] not in own:
                seen.add(p[3])
                ssids.append({"active": True, "signal": int(p[1] or 0) if p[1].isdigit() else 0,
                              "sec": p[2] or "OPEN", "ssid": p[3]})
        self.net["ssids"] = ssids[:2]

    def restart_stump(self, why):
        """The Stump picks up a new address on restart, as after /admin's
        settings: its own user service (provisioner --pc), else its Start file."""
        log("STUMP", "restarting (%s)" % why)
        self.verified, self.next_auth = None, time.time() + 8     # it forgets: verified again once it's up
        ok, out = run(["systemctl", "--user", "restart", "stump"], timeout=30)
        if not ok:      # no user manager (dArkOS): install.sh's system service
            import getpass
            ok, out = run(["sudo", "-n", "systemctl", "restart", "stump-" + getpass.getuser()], timeout=30)
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
        """The old one-button hotspot: on = an AP on a free AP-capable card,
        else on the card EmulationStation is on; off = every AP off."""
        self.limbs.scan()
        if not on:
            aps = [c for c in self.limbs.cards if c["job"] == "ap"]
            for c in aps:
                self.limbs.set_off(c["key"])
            self.busy("AP off" if aps else "No AP was on", 3)
            return
        c = self.limbs.ap_target()
        if not c:
            self.busy("No Wi-Fi card here can run an AP", 4)
            return
        self.limb_job(c["key"], "ap", c.get("band") or "bg")

    def limb_job(self, key, job, band="bg"):
        c = self.limbs.find(key) or (self.limbs.scan() and self.limbs.find(key))
        if not c:
            self.busy("That Wi-Fi card is gone", 3)
            return
        if job == "ap":
            if c["job"] == "lan":
                log("NET", "AP on %s: the handheld leaves %s" % (c["name"], c["info"]))
            ok, msg = self.limbs.set_ap(key, band)
        else:
            ok, msg = self.limbs.set_off(key)
        self.busy(msg, 5)
        self.next_net = 0                  # look again now (and restart the Stump if the APs changed)

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
                room = parts[1].strip().lower().lstrip("#")
                if ROOM_RE.match(room) and room in self.room_order and room != self.want_room:
                    self.want_room = room
                    st.next_poll = 0
            elif op == "ROOM_NEW" and len(parts) >= 2:
                self.new_room(parts[1], "local")
            elif op == "FORM_OPEN" and len(parts) >= 2:
                self.open_form(parts[1].strip().lower())
            elif op == "FORM_SET" and len(parts) >= 4:
                self.form_set(parts[1].strip().lower(), parts[2].strip(), "|".join(parts[3:]))
            elif op == "RRC" and len(parts) >= 3:
                room = parts[1].strip().lower().lstrip("#") or self.want_room
                if not ROOM_RE.match(room):
                    room = self.want_room
                text = "|".join(parts[2:]).strip()
                if not text or st.port is None:
                    self.busy("The Stump isn't answering yet", 2.5)
                    return
                if room != st.room:
                    st.send("/join " + room)
                    self.want_room = room
                if text.lower() == "/auth":           # verify, as FireFly does (the challenge answered here)
                    self.verified = None
                    ok = self.authenticate()
                    self.answer(room, ["\u2713 verified as %s" % ok] if ok else
                                ["\u2717 not verified (see the cockpit's log)"])
                    st.next_poll = 0
                    return
                said = st.send(self.fill_password(text))
                if self.locked_out(text, said) and self.authenticate():
                    if st.room != room:
                        st.send("/join " + room)
                    said = st.send(self.fill_password(text))      # once more, verified
                for r in said:
                    log("CHAT", r)
                if PW_MARK in text:
                    self.heard(said)               # an owner's command from the menu: its answer under the form too
                if text.startswith("/"):
                    self.answer(st.room or room, said)
                st.next_poll = 0
            elif op == "BOARD_ADD" and len(parts) >= 2:
                s, t = st.post("/post", json.dumps({"title": parts[1], "body": "|".join(parts[2:])}),
                               "application/json")
                self.busy("Notice posted" if s == 201 else "Notice: " + _msg(t, s), 2.5)
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
                self.busy("%d notice(s) saved to the TF card" % len(rows), 2.5)
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
                self.busy("%d file(s) copied to the TF card" % n, 2.5)
            elif op == "LIMB_JOB" and len(parts) >= 3:
                job = parts[2].strip().lower()
                self.busy("AP on\u2026" if job == "ap" else "AP off\u2026", 10)
                self.limb_job(parts[1].strip().lower(), job, parts[3].strip() if len(parts) > 3 else "bg")
            elif op == "LIMB_REMEMBER" and len(parts) >= 3:
                ok, msg = self.limbs.set_remember(parts[1].strip().lower(), parts[2].strip() == "1")
                self.busy(msg, 3)
                self.next_net = 0
            elif op in ("AP_ON", "AP_OFF", "AP_TOGGLE"):
                on = (op == "AP_ON") or (op == "AP_TOGGLE" and not self.net["ap"])
                self.busy("Hotspot %s\u2026" % ("on" if on else "off"), 8)
                self.hotspot(on)
                self.next_net = 0
            elif op == "NET_APPLY" and len(parts) >= 2:
                if parts[1].strip().upper() == "AP":
                    self.busy("Hotspot on\u2026", 8)
                    self.hotspot(True)
                else:                    # back to EmulationStation's Wi-Fi only
                    self.busy("Hotspot off\u2026", 8)
                    self.hotspot(False)
                self.next_net = 0
            elif op in ("WIFI_SCAN", "WIFI_JOIN"):
                # The Wi-Fi (network and password) is chosen in EmulationStation;
                # the Stump follows whatever it's on, by itself.
                self.busy("Wi-Fi is set in EmulationStation: the Stump follows it", 4)
                self.next_net = 0
            elif op == "CHAIN_SCAN":
                found = discover_stumps()
                for s in found:
                    log("CHAIN", "%s at %s (%s)" % (s.get("name"), s.get("here") or ",".join(s.get("http") or []),
                                                    s.get("release")))
                self.busy("%d Stump(s) on this network" % len(found), 3)
                self.next_info = 0
            elif op == "CHAIN_SET":
                # The chain is the Stump's own setting, as on every Stump: /admin
                # (Stump chain) or the setup wizard -- never edited from here.
                self.busy("The chain is set in /admin (or provisioner.py --pc --reconfigure)", 5)
            elif op == "ANNOUNCE":
                self.busy("The Stump announces itself on its own (radio up, new Stumps)", 3)
            elif op == "DEBUG_EXPORT_TF":
                self.export_diagnostics()
            elif op == "DEBUG_HEAL_NET":
                self.busy("Restarting the Stump\u2026", 6)
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
        pw = self.admin_pw()                       # /admin's, or the fserv operator's, as the Stump checks
        if not items:
            return
        if not pw:
            self.busy("No admin password yet: OWNER \u2192 Set the admin password", 4)
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
            self.busy("Put files in %s first" % DROP_DIR, 4)
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
            self.busy("Shared %s" % name, 3)
        else:
            self.busy("Share: %s" % _msg(t, s), 4)
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
        self.busy("Diagnostics saved to the TF card", 3)
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
        # Other Stumps: from their beacons (/stumps.json), or already from the
        # chain's chat; a "mesh-xxxx" is one whose name hasn't arrived yet.
        peers = len(set(s.get("name") for s in self.stumps) | self.chat_stumps)
        out = ["META|%s|%d|%s" % (clean(node.get("lxmf") or "STUMP OFFLINE", 32), peers, clean(rlabel, 23)),
               "SOUND|%d|%d" % (1 if self.sound["chimes"] else 0, self.chime_seq)]
        ip =clean(node.get("ap_ip") or self.net.get("ip") or "127.0.0.1", 20)
        out.append("VER|%s|%s|%d|%d|%s|%d" % (
            clean(node.get("release") or "OFFLINE", 27), clean("PC Stump, feed " + FEED_VERSION, 27),
            1 if port == 80 else 0, 1 if port == 8080 else 0, ip, self.tf_count()))
        busy = time.time() < self.busy_until
        out.append("BUSY|%d|%s" % (1 if busy else 0, clean(self.busy_msg if busy else "READY", 54)))
        cfg_ssid = self.net.get("ap_ssid") or read_config().get("PC_HOTSPOT_NAME") or ""
        out.append("AP|%d|%s|%s|%s|%s|%d" % (1 if self.net["ap"] else 0, clean(self.net["ap_if"] or "wlan0", 16),
                                             clean(self.net["ap_mac"], 20), clean(self.net["ap_driver"], 16),
                                             clean(cfg_ssid or "Stump hotspot", 23), self.net["clients"]))
        ch = self.chain or {}
        if ch.get("enabled"):
            up = ch.get("uplink") or {}
            below = ch.get("below") or []
            role = ch.get("role") or "member"
            if role == "root":
                status = "First Stump \u00b7 %d below" % len(below)
            elif up.get("parent_heard_s") is not None:
                status = "Linked to %s (heard %ds ago)" % (up.get("parent"), up.get("parent_heard_s"))
            else:
                status = "Looking for %s\u2026" % (up.get("parent") or "the Stump above")
            peer_ip = up.get("parent") or ch.get("lan_ip") or ip
            out.append("CHAIN|1|%d|%d|%s|%s|%d|%s|%s" % (1 if role == "root" else 2, 1 if ch.get("secret") else 0,
                                                         "(set in /admin)" if ch.get("secret") else "",
                                                         clean(ch.get("chain") or "none", 16),
                                                         len(below) + (1 if up.get("parent_heard_s") is not None else 0),
                                                         clean(peer_ip, 24), clean(status, 56)))
        else:
            out.append("CHAIN|0|0|0||none|0|%s|Not in a chain (set it in /admin)" % ip)
        # The cockpit sends back the SSID it shows: keep the real one behind it
        # (a name cut short, or with a character the font lacks, would not join).
        self.full_ssids = {}
        for w in self.net["ssids"]:
            shown = clip(clean(screen_line(w["ssid"]), 31), 31)
            self.full_ssids[shown] = w["ssid"]
            out.append("SSID|%d|%d|%s|%s" % (1 if w["active"] else 0, w["signal"], clean(w["sec"], 8), shown))
        # The Wi-Fi cards: LIMB|key|name|driver|job|ap_ok|bands|band|remember|iface|info|clients
        for c in self.limbs.cards[:6]:
            bands = (1 if 1 in c["bands"] else 0) | (2 if 2 in c["bands"] else 0)
            out.append("LIMB|%s|%s|%s|%s|%d|%d|%s|%d|%s|%s|%d" % (
                clean(c["key"], 17), clip(clean(screen_line(c["name"]), 28), 28), clean(c["driver"], 15), c["job"],
                1 if c["ap_ok"] else 0, bands, "a" if c.get("band") == "a" else "bg", 1 if c["remember"] else 0,
                clean(c["iface"], 15), clip(clean(screen_line(c["info"]), 44), 44), c["clients"]))
        # Every room the Stump has (the built-in ones first), the one on screen
        # marked; its last messages. ROOM|i|room|people|reach|topic|on screen
        view = self.stump.room or self.want_room
        order = list(self.room_order)
        if view not in order:
            order.append(view)
        if len(order) > MAX_ROOMS:
            order = order[:MAX_ROOMS]
            if view not in order:
                order[-1] = view
        for i, room in enumerate(order):
            info = self.room_info.get(room) or {}
            count = self.users.get(room, 0) if room == view else info.get("count", 0)
            out.append("ROOM|%d|%s|%d|%s|%s|%d" % (i, clean(room, 32), count, clean(info.get("scope") or "", 6),
                                                   clip(clean(screen_line(info.get("topic") or ""), 40), 41),
                                                   1 if room == view else 0))
            if room != view:
                continue
            for m in self.msgs.get(room, [])[-KEEP_MSGS:]:
                sys_ = m.get("kind") == "system"
                nick = "*" if sys_ else (m.get("nick") or "?")
                if m.get("kind") == "dm":
                    nick = "DM " + nick
                body = m.get("body")
                if m.get("kind") == "action":            # /me: "* rod waves", as FireFly shows it
                    nick, body = "*", "%s %s" % (m.get("nick") or "?", body or "")
                out.append("MSG|%d|%d|%d|%s|%s" % (i, 1 if sys_ else 0, int(m.get("id") or 0),
                                                   clip(clean(screen_line(nick), 16), 17),
                                                clip(clean(screen_line(body), 400), 1023)))     # the whole of it (400: the Stump's longest)
        # The command menu: CMD|i|group|word|syntax|args|password|what it does
        for i, c in enumerate(self.catalog[:MAX_CMDS]):
            out.append("CMD|%d|%s|%s|%s|%d|%d|%s" % (
                i, clip(clean(screen_line(c["group"]), 30), 31), clean(c["word"], 24),
                clip(clean(screen_line(c["syntax"].replace("|", "\u00a6")), 90), 121),   # (| is the separator)
                1 if c["args"] else 0, 1 if c["pw"] else 0,
                clip(clean(screen_line(c["desc"]), 110), 161)))
        # The OWNER tab's form: FORM|id|title|back to; then its rows,
        # FIELD|i|key|kind|asks|max|label|value|choice|opt~opt~...|hint
        title, parent, rows = self.form_rows()
        out.append("FORM|%s|%s|%s" % (self.form, clip(clean(screen_line(title), 40), 41), parent))
        for i, r in enumerate(rows[:24]):
            opts = "~".join(clip(clean(screen_line(o), 28).replace("~", "-"), 29) for o in r["options"][:10])
            out.append("FIELD|%d|%s|%s|%d|%d|%s|%s|%d|%s|%s" % (
                i, clean(r["key"], 40), r["kind"], int(r["ask"] or 0), int(r["max"] or 0),
                clip(clean(screen_line(r["label"]), 44), 45), clip(clean(screen_line(r["value"]), 120), 121),
                int(r["sel"]), opts, clip(clean(screen_line(r["hint"]), 64), 65)))
        for p in self.board[:KEEP_ITEMS]:
            out.append("BOARD|%s|%s|%s|%s" % (clean(p.get("id") or "", 24), clip(clean(screen_line(p.get("sig")), 14), 15),
                                              clip(clean(screen_line(p.get("title")), 44), 45),
                                              clip(clean(screen_line(p.get("body")), 48), 49)))
        self.full_names = {}
        used = 0
        files = sorted(self.files, key=lambda f: -(f.get("mtime") or 0))
        for f in files:
            used += int(f.get("size") or 0)
        for f in files[:KEEP_ITEMS]:
            shown = clip(clean(screen_line(f.get("name")), 35), 35).replace(",", "_")
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
            if now >= self.next_rooms and self.stump.port is not None:
                try:
                    self.refresh_rooms()
                except Exception as e:
                    log("CHAT", "rooms: %s" % e)
                self.next_rooms = time.time() + ROOMS_S
            if now >= self.next_cmds and self.stump.port is not None:
                try:
                    self.refresh_commands()
                except Exception as e:
                    log("CMDS", "%s" % e)
                self.next_cmds = time.time() + (CMDS_S if self.catalog else 15.0)
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


def _iw_phy(phy):
    ok, out = run(["iw", "phy", phy, "info"], timeout=5)
    return out if ok else ""


def _iw_stations(iface):
    ok, out = run(["iw", "dev", iface, "station", "dump"], timeout=5)
    return out if ok else ""


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
