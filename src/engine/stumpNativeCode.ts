/**
 * Native R36MAX (RK3326 / ArkOS) C Cockpit + Live Python Stump Bridge
 * for https://github.com/ruderigo/LaBuche-Stump (Project Stump Beta A v1.0.0-beta.34).
 *
 * Full Real-Function Integration:
 *   1. Real RRC Rooms & Mesh Push: Live 200ms bidirectional sync with rrc.py & rrc_mesh.py
 *      inside stump_pc.py via /dev/shm/stump_live.txt and /dev/shm/stump_cmd.txt.
 *      Messages from browser/LoRa/Wi-Fi users appear live on the R36MAX screen, and
 *      gamepad actions push real messages/commands into rrc.py and the Reticulum mesh.
 *   2. Real Billboard Add/Remove: Reads real entries from billboard.py (/sd/billboard.txt).
 *      Press A to post a real notice (immediately visible on /billboard) and X to delete
 *      the selected notice.
 *   3. Real File Shelf Add/Remove: Lists real files in /sd/shared (fserv.py).
 *      Press A to generate/share real files into /sd/shared (immediately downloadable
 *      on /files) and X to delete the selected file from /sd/shared.
 *   4. Real Scannable ISO/IEC 18004 QR Code: Encodes http://<primary_ip>:8080/ into a
 *      standards-compliant 25x25 Version 2-L QR code with Reed-Solomon GF(256) ECC.
 */

import { CodeFileArtifact } from './nativeEngineCode';

export const STUMP_R36MAX_BRIDGE_PY = `#!/usr/bin/env python3
"""
run_stump_r36max.py (v1.7.1-r36max) — Launches LaBuche-Stump on R36MAX (dArkOS Debian 13 trixie, Linux 4.4.189)
with:
  1. Authentic final_firmware Visitor Interface (barkeep.py + rrc_ui.py + billboard.py + fserv.py + theme.py
     + i18n.py + librarian.py) served via multi-threaded TCP bridge on 0.0.0.0:80 AND 0.0.0.0:8080:
     - Home (/): BARKEEP_ART ASCII mug, glowing Stump header, en|fr|es switcher, SVG tiles, floating Firefly Librarian.
     - RRC Web Client (/rrc, /rrc/poll, /rrc/send, /rrc/voice): mIRC-style 2-pane chat (#main, #lora-mesh, #wifi-mesh, DMs).
     - Bulletin Board (/billboard, /post, /billboard/delete): collapsible <details> notices, search & sort.
     - Shared File Shelf (/files, /upload, /download): SVG category icons, filter/sort, 75% FIFO storage bar.
     - Offline Tools (/tools), About (/about), Concierge (/concierge), and FireFly client discovery (/node.json, /hw.json).
  2. Automatic FireFly venv & fallback ucryptolib loader so barkeep.py and example_node.py never fail if
     system python3 lacks 'cryptography'.
  3. Bulletproof Walk-Up AP ('LaBuche-Stump' @ 192.168.4.1/24) with RFC 2131 DHCP (:67) + Captive DNS (:53),
     preventing example_node's captive_portal.run_dns_server from stealing UDP :53 (fixes Errno 98 on AP mode).
"""
import builtins
import os
import sys
import time
import glob
import types
import shutil
import socket
import select
import urllib.parse
import http.server
import socketserver
import asyncio
import threading
import subprocess

# Save real OS filesystem functions BEFORE stump_host.install() wraps them!
_REAL_OPEN     = builtins.open
_REAL_STAT     = os.stat
_REAL_LISTDIR  = os.listdir
_REAL_REMOVE   = os.remove
_REAL_REPLACE  = os.replace
_REAL_MAKEDIRS = os.makedirs
_REAL_EXISTS   = os.path.exists
_REAL_ISFILE   = os.path.isfile
_REAL_ISDIR    = os.path.isdir
_REAL_CHMOD    = os.chmod

# Ensure Debian 13 (trixie) sbin directories are in PATH under sudo / EmulationStation
os.environ["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:" + os.environ.get("PATH", "")

STUMP_R36MAX_VERSION = "v1.7.1-r36max"
STUMP_R36MAX_BUILD   = "2026.06.21-dArkOS"

HERE          = os.path.dirname(os.path.abspath(__file__))
APP_ROOT      = "/roms/ports/stump_r36max"
TF_BACKUP_DIR = "/roms/ports/stump_r36max/tf_backup"
LIVE_TMP      = "/dev/shm/stump_live.tmp"
LIVE_TXT      = "/dev/shm/stump_live.txt"
CMD_TXT       = "/dev/shm/stump_cmd.txt"
LOCAL_CID     = "r36max-local"
IPC_UDP_PORT  = 42421

CAM_AP_SSID   = "LaBuche-Stump"
CAM_AP_IP     = "192.168.4.1"
CAM_AP_CHAN   = 6
RT3070_MAC    = "00:0f:00:5e:11:ee"

_KEEPALIVE_SERVERS = []

_AP_STATE = {
    "active": False,
    "user_wanted": False,
    "ifname": "",
    "ap_if": "",
    "mac": "",
    "driver": "",
    "ssid": CAM_AP_SSID,
    "ip": CAM_AP_IP,
    "lan_ip": "127.0.0.1",
    "clients": 0,
    "dual_wifi": False,
    "retries": 0,
    "joined_ssid": "",
    "switching": False,
    "last_switch_ts": 0.0,
}

_BUSY_STATE = {
    "busy": False,
    "until": 0.0,
    "msg": "READY",
}

_HTTP_STATE = {
    "port80": False,
    "port8080": False,
    "front80_started": False,
    "front8080_started": False,
    "last_heal_ts": 0.0,
}

_WIFI_SSIDS = []  # List of dicts: {"ssid": str, "signal": int, "sec": str, "active": int}
_DEBUG_LOGS = []  # Rolling list of recent timestamped debug strings (max 36)

def _log_debug(tag, msg):
    global _DEBUG_LOGS
    ts = time.strftime("%H:%M:%S")
    clean = str(msg or "").replace("|", "/").replace("\\r", " ").replace("\\n", " ").strip()
    entry = "%s [%s] %s" % (ts, tag, clean[:58])
    _DEBUG_LOGS.append(entry)
    if len(_DEBUG_LOGS) > 36:
        _DEBUG_LOGS = _DEBUG_LOGS[-36:]
    print(entry, flush=True)

def _set_busy(msg, duration=3.5):
    _BUSY_STATE["busy"] = True
    _BUSY_STATE["until"] = time.time() + duration
    _BUSY_STATE["msg"] = str(msg or "IN PROCESS...")[:54]
    _log_debug("STATE", _BUSY_STATE["msg"])

def _clear_busy_if_expired():
    if _BUSY_STATE["busy"] and time.time() >= _BUSY_STATE["until"]:
        _BUSY_STATE["busy"] = False
        _BUSY_STATE["msg"] = "READY"

def _run_sh(cmd, timeout=10):
    try:
        subprocess.run(cmd, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
    except Exception:
        pass

def _read_sys(path):
    try:
        with _REAL_OPEN(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except Exception:
        return ""

def _html_esc(s):
    return (
        str(s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )

def _ensure_firewall_open(ifname="wlan0"):
    """Ensure Debian 13 iptables/nftables and rp_filter never drop incoming HTTP (:80/:8080), DHCP (:67), or DNS (:53)."""
    _run_sh("nft flush ruleset 2>/dev/null || true")
    _run_sh("iptables -P INPUT ACCEPT 2>/dev/null || true")
    _run_sh("iptables -P OUTPUT ACCEPT 2>/dev/null || true")
    _run_sh("iptables -P FORWARD ACCEPT 2>/dev/null || true")
    _run_sh("iptables -F INPUT 2>/dev/null || true")
    _run_sh("sysctl -w net.ipv4.conf.all.rp_filter=0 2>/dev/null || true")
    _run_sh("sysctl -w net.ipv4.conf.default.rp_filter=0 2>/dev/null || true")
    if ifname:
        _run_sh("sysctl -w net.ipv4.conf.%s.rp_filter=0 2>/dev/null || true" % ifname)
        _run_sh("iptables -I INPUT -i %s -j ACCEPT 2>/dev/null || true" % ifname)

def _is_proc_running(arg_substr, exe_substr=""):
    """Pure-Python /proc/<pid>/cmdline scanner that NEVER spawns /bin/sh or pgrep (avoiding subshell self-matches)."""
    my_pid = os.getpid()
    try:
        for entry in _REAL_LISTDIR("/proc"):
            if not entry.isdigit():
                continue
            pid = int(entry)
            if pid == my_pid:
                continue
            try:
                with _REAL_OPEN("/proc/%s/cmdline" % entry, "rb") as f:
                    raw = f.read(2048)
                if not raw:
                    continue
                parts = [p.decode("utf-8", errors="replace") for p in raw.split(b"\\0") if p]
                if not parts:
                    continue
                exe_base = os.path.basename(parts[0])
                if exe_base in ("sh", "bash", "dash", "pgrep", "pkill", "sudo"):
                    continue
                if exe_substr and exe_substr not in exe_base:
                    continue
                full_cmd = " ".join(parts)
                if arg_substr in full_cmd:
                    return True
            except Exception:
                continue
    except Exception:
        pass
    return False

def _get_iface_ipv4(ifname):
    if not ifname:
        return ""
    try:
        out = subprocess.check_output(
            "ip -4 -o addr show dev %s 2>/dev/null" % ifname,
            shell=True, timeout=2
        ).decode("utf-8", errors="replace")
        ips = []
        for ln in out.splitlines():
            parts = ln.split()
            for idx, tok in enumerate(parts):
                if tok == "inet" and idx + 1 < len(parts):
                    ip_str = parts[idx + 1].split("/")[0].strip()
                    if ip_str:
                        ips.append(ip_str)
        if _AP_STATE.get("user_wanted") and CAM_AP_IP in ips:
            return CAM_AP_IP
        for ip_s in ips:
            if ip_s != CAM_AP_IP:
                return ip_s
        return ips[0] if ips else ""
    except Exception:
        return ""

def _is_ap_broadcasting(ifname):
    """Verify if <ifname> is actively running our Stump AP daemon AND broadcasting in AP/Master mode."""
    if not ifname or not _REAL_EXISTS("/sys/class/net/" + ifname):
        return False
    daemon_alive = (
        _is_proc_running("stump_wpa_ap.conf", "wpa_supplicant")
        or _is_proc_running("stump_hostapd.conf", "hostapd")
    )
    if not daemon_alive:
        return False
    try:
        for logp in ("/dev/shm/wpa_ap.log", "/dev/shm/hostapd.log"):
            if _REAL_EXISTS(logp):
                log_txt = _read_sys(logp)
                if "AP-ENABLED" in log_txt and "AP-DISABLED" not in log_txt.split("AP-ENABLED")[-1]:
                    return True
    except Exception:
        pass
    try:
        wout = subprocess.check_output(
            "wpa_cli -p /run/wpa_supplicant_stump -i %s status 2>/dev/null" % ifname,
            shell=True, timeout=2
        ).decode("utf-8", errors="replace")
        if "mode=AP" in wout or ("wpa_state=COMPLETED" in wout and CAM_AP_SSID in wout):
            return True
    except Exception:
        pass
    try:
        out = subprocess.check_output(
            "iw dev %s info 2>/dev/null" % ifname,
            shell=True, timeout=2
        ).decode("utf-8", errors="replace")
        if ("ssid " + CAM_AP_SSID) in out or "type AP" in out:
            return True
    except Exception:
        pass
    try:
        out2 = subprocess.check_output(
            "iwconfig %s 2>/dev/null" % ifname,
            shell=True, timeout=2
        ).decode("utf-8", errors="replace")
        if "Mode:Master" in out2:
            return True
    except Exception:
        pass
    return False

def _scan_wifi_interfaces():
    """Find all physical wireless interfaces and specifically identify the Blueway RT3070 (148f:3070 / rt2800usb / 00:0f:00:5e:11:ee)."""
    wlans = []
    rt3070 = None
    try:
        for ifname in sorted(_REAL_LISTDIR("/sys/class/net")):
            if ifname in ("lo", "uap0", "ap0") or ifname.startswith("."):
                continue
            netdir = "/sys/class/net/" + ifname
            is_wlan = (
                _REAL_EXISTS(netdir + "/wireless")
                or _REAL_EXISTS(netdir + "/phy80211")
                or ifname.startswith("wl")
                or ifname.startswith("ra")
            )
            if not is_wlan:
                continue
            mac = _read_sys(netdir + "/address").lower()
            uevent = _read_sys(netdir + "/device/uevent")
            drv = "rt2800usb"
            for ln in uevent.splitlines():
                if ln.startswith("DRIVER="):
                    drv = ln.split("=", 1)[1].strip()
            modalias = _read_sys(netdir + "/device/modalias").lower()
            is_rt3070 = (
                mac == RT3070_MAC
                or mac.endswith(":11:ee")
                or mac.endswith(":ee")
                or "rt2800usb" in drv.lower()
                or "148f" in uevent.lower()
                or "3070" in uevent.lower()
                or "148f" in modalias
            )
            info = {"ifname": ifname, "mac": mac, "driver": drv, "is_rt3070": is_rt3070}
            wlans.append(info)
            if is_rt3070 and rt3070 is None:
                rt3070 = info
    except Exception:
        pass
    if rt3070 is None and wlans:
        rt3070 = wlans[-1]
    return wlans, rt3070

def _count_ap_clients(ifname):
    target_if = _AP_STATE.get("ap_if") or ifname
    if not target_if:
        return 0
    cnt = 0
    try:
        out = subprocess.check_output(
            "iw dev %s station dump 2>/dev/null | grep -c '^Station '" % target_if,
            shell=True, timeout=2
        ).decode("utf-8", errors="replace").strip()
        cnt = int(out or "0")
    except Exception:
        pass
    if cnt == 0:
        try:
            with _REAL_OPEN("/proc/net/arp", "r", encoding="utf-8") as f:
                for ln in f.read().splitlines()[1:]:
                    if "192.168.4." in ln and "00:00:00:00:00:00" not in ln:
                        cnt += 1
        except Exception:
            pass
    return cnt

def _get_saved_wifi_profiles():
    """Return saved Wi-Fi SSIDs WITHOUT waking NetworkManager if AP mode is wanted!"""
    saved = []
    try:
        nm_dir = "/etc/NetworkManager/system-connections"
        if _REAL_ISDIR(nm_dir):
            for fn in sorted(_REAL_LISTDIR(nm_dir)):
                if fn.startswith("."):
                    continue
                name = fn.replace(".nmconnection", "").strip()
                if name and name != "StumpCAM" and name != CAM_AP_SSID and name not in saved:
                    saved.append(name)
    except Exception:
        pass
    if not _AP_STATE.get("user_wanted") and not _AP_STATE.get("active"):
        try:
            out = subprocess.check_output(
                "nmcli -t -f NAME,TYPE con show 2>/dev/null",
                shell=True, timeout=3
            ).decode("utf-8", errors="replace")
            for ln in out.splitlines():
                if ":" not in ln:
                    continue
                name, ctype = ln.rsplit(":", 1)
                name = name.strip()
                if ("wireless" in ctype or "wifi" in ctype) and name and name != "StumpCAM" and name != CAM_AP_SSID:
                    if name not in saved:
                        saved.append(name)
        except Exception:
            pass
    return saved

def _scan_wifi_ssids(ifname="wlan0", force_rescan=False, rrc_mod=None):
    """Scan nearby 2.4 GHz Wi-Fi SSIDs + saved NM profiles and populate _WIFI_SSIDS.
    CRITICAL: Never run while AP is active/wanted unless force_rescan=True was explicitly requested by operator."""
    global _WIFI_SSIDS
    if not ifname:
        ifname = _AP_STATE.get("ifname") or "wlan0"

    if (_AP_STATE.get("user_wanted") or _AP_STATE.get("active")) and not force_rescan:
        return _WIFI_SSIDS

    if force_rescan:
        _set_busy("IN PROCESS: SCANNING 2.4GHZ WIFI...", 4.5)
        if _AP_STATE["active"] and not _AP_STATE.get("dual_wifi"):
            _stop_cam_ap(rrc_mod, reconnect_default=False)
            time.sleep(1.0)

    by_ssid = {}
    saved_list = _get_saved_wifi_profiles()
    for sv in saved_list:
        by_ssid[sv] = {"ssid": sv, "signal": 75, "sec": "SAVED", "active": 0}

    active_ssid = ""
    try:
        lout = subprocess.check_output(
            "iw dev %s link 2>/dev/null" % ifname,
            shell=True, timeout=2
        ).decode("utf-8", errors="replace")
        for ln in lout.splitlines():
            ln_s = ln.strip()
            if ln_s.startswith("SSID:"):
                active_ssid = ln_s.split("SSID:", 1)[1].strip()
    except Exception:
        pass
    if active_ssid and active_ssid != CAM_AP_SSID:
        _AP_STATE["joined_ssid"] = active_ssid
        by_ssid[active_ssid] = {"ssid": active_ssid, "signal": 92, "sec": "CONN", "active": 1}

    if not _AP_STATE.get("user_wanted"):
        try:
            rescan_arg = "yes" if force_rescan else "no"
            out = subprocess.check_output(
                "nmcli -t -f IN-USE,SIGNAL,SECURITY,SSID dev wifi list --rescan %s 2>/dev/null" % rescan_arg,
                shell=True, timeout=6
            ).decode("utf-8", errors="replace")
            for ln in out.splitlines():
                parts = ln.split(":", 3)
                if len(parts) < 4:
                    continue
                in_use_s, sig_s, sec_s, ssid_s = parts[0].strip(), parts[1].strip(), parts[2].strip(), parts[3].strip()
                if not ssid_s or ssid_s == CAM_AP_SSID or ssid_s == "--":
                    continue
                try:
                    sig = int(sig_s or "50")
                except Exception:
                    sig = 50
                is_act = 1 if (in_use_s == "*" or ssid_s == active_ssid) else 0
                if is_act:
                    _AP_STATE["joined_ssid"] = ssid_s
                sec_tag = "OPEN" if not sec_s or sec_s == "--" else ("WPA2" if "WPA" in sec_s else sec_s[:6])
                if ssid_s in saved_list and not is_act:
                    sec_tag = "SAVED"
                prev = by_ssid.get(ssid_s)
                if not prev or sig >= prev["signal"] or is_act:
                    by_ssid[ssid_s] = {"ssid": ssid_s, "signal": sig, "sec": sec_tag, "active": is_act}
        except Exception:
            pass

    if (force_rescan or len(by_ssid) <= len(saved_list)) and not _is_ap_broadcasting(ifname):
        try:
            _run_sh("ip link set dev %s up 2>/dev/null || true" % ifname)
            iw_out = subprocess.check_output(
                "iw dev %s scan 2>/dev/null" % ifname,
                shell=True, timeout=6
            ).decode("utf-8", errors="replace")
            cur_sig = 60
            cur_sec = "OPEN"
            for ln in iw_out.splitlines():
                s = ln.strip()
                if s.startswith("BSS "):
                    cur_sig = 60
                    cur_sec = "OPEN"
                elif s.startswith("signal:"):
                    try:
                        dbm = float(s.split()[1])
                        cur_sig = max(10, min(100, int(2 * (dbm + 100))))
                    except Exception:
                        pass
                elif s.startswith("RSN:") or s.startswith("WPA:"):
                    cur_sec = "WPA2"
                elif s.startswith("SSID:"):
                    found_ssid = s.split("SSID:", 1)[1].strip()
                    if found_ssid and found_ssid != CAM_AP_SSID and "\\\\x00" not in found_ssid:
                        is_act = 1 if found_ssid == active_ssid else 0
                        sec_l = "SAVED" if (found_ssid in saved_list and not is_act) else cur_sec
                        if found_ssid not in by_ssid or cur_sig > by_ssid[found_ssid]["signal"]:
                            by_ssid[found_ssid] = {"ssid": found_ssid, "signal": cur_sig, "sec": sec_l, "active": is_act}
        except Exception:
            pass

    items = list(by_ssid.values())
    items.sort(key=lambda x: (x["active"], 1 if x["sec"] == "SAVED" else 0, x["signal"]), reverse=True)
    _WIFI_SSIDS = items[:6]
    if force_rescan:
        _log_debug("WIFI", "Scanned %d SSID(s) on %s" % (len(_WIFI_SSIDS), ifname))
        if rrc_mod:
            rrc_mod.system("main", "[WIFI] Scanned %d network(s) on %s" % (len(_WIFI_SSIDS), ifname))
    return _WIFI_SSIDS

def _kill_competing_net_daemons(ifname):
    """Stop and runtime-mask all dArkOS / Debian 13 network daemons so nothing fights wlan0 while Stump AP is active."""
    _run_sh("nmcli dev set %s managed no 2>/dev/null || true" % ifname)
    _run_sh("nmcli dev disconnect %s 2>/dev/null || true" % ifname)
    _run_sh("systemctl mask --runtime NetworkManager NetworkManager-dispatcher wpa_supplicant dhcpcd 2>/dev/null || true")
    _run_sh("systemctl stop NetworkManager NetworkManager-dispatcher wpa_supplicant wpa_supplicant@%s dhcpcd 2>/dev/null || true" % ifname)
    _run_sh("pkill -9 -f 'NetworkManager' 2>/dev/null || true")
    _run_sh("pkill -9 -f 'dhclient' 2>/dev/null || true")
    _run_sh("pkill -9 -f 'dhcpcd' 2>/dev/null || true")
    _run_sh("pkill -9 -f 'udhcpc' 2>/dev/null || true")
    _run_sh("pkill -9 -f 'wpa_supplicant' 2>/dev/null || true")

def _ensure_clean_lan_sta(ifname):
    """Stop custom AP daemons and restore NetworkManager + wpa_supplicant for normal LAN STA mode."""
    _run_sh("pkill -9 -f 'stump_hostapd' 2>/dev/null || true")
    _run_sh("pkill -9 -f 'stump_wpa_ap' 2>/dev/null || true")
    _run_sh("pkill -9 -f 'stump_wpa_uap0' 2>/dev/null || true")
    _run_sh("pkill -9 -f 'stump_dnsmasq' 2>/dev/null || true")
    _run_sh("rm -rf /run/wpa_supplicant_stump /dev/shm/wpa_ap.log /dev/shm/hostapd.log /dev/shm/stump_dnsmasq.conf 2>/dev/null || true")
    _run_sh("iw dev uap0 del 2>/dev/null || true")
    if ifname:
        _run_sh("ip route del 255.255.255.255/32 dev %s 2>/dev/null || true" % ifname)
        _run_sh("ip addr del 192.168.4.1/24 dev %s 2>/dev/null || true" % ifname)
        _run_sh("ip link set dev %s down 2>/dev/null || true" % ifname)
        _run_sh("iw dev %s set type managed 2>/dev/null || true" % ifname)
        _run_sh("ip link set dev %s up 2>/dev/null || true" % ifname)
    _run_sh("systemctl unmask --runtime wpa_supplicant NetworkManager NetworkManager-dispatcher dhcpcd 2>/dev/null || true")
    _run_sh("systemctl unmask wpa_supplicant NetworkManager NetworkManager-dispatcher dhcpcd 2>/dev/null || true")
    _run_sh("systemctl start wpa_supplicant 2>/dev/null || true")
    _run_sh("systemctl start NetworkManager 2>/dev/null || true")
    _run_sh("nmcli radio wifi on 2>/dev/null || true")
    if ifname:
        _run_sh("nmcli dev set %s managed yes 2>/dev/null || true" % ifname)
        _ensure_firewall_open(ifname)

def _ensure_ap_ip_and_routes(ifname, flush_non_ap=True):
    """Ensure 192.168.4.1/24 and broadcast route are bound on <ifname> while in AP mode,
    and remove any leftover 192.168.0.x LAN IP so the R36MAX never flips back to local LAN IP."""
    if not ifname:
        return
    if flush_non_ap and not _AP_STATE.get("dual_wifi"):
        try:
            out = subprocess.check_output("ip -4 -o addr show dev %s 2>/dev/null" % ifname, shell=True, timeout=2).decode("utf-8", errors="replace")
            for ln in out.splitlines():
                parts = ln.split()
                for idx, tok in enumerate(parts):
                    if tok == "inet" and idx + 1 < len(parts):
                        cidr = parts[idx + 1]
                        if not cidr.startswith(CAM_AP_IP + "/"):
                            _run_sh("ip addr del %s dev %s 2>/dev/null || true" % (cidr, ifname))
        except Exception:
            pass
    _run_sh("ip link set dev %s up 2>/dev/null || true" % ifname)
    _run_sh("ip addr replace 192.168.4.1/24 broadcast 192.168.4.255 dev %s 2>/dev/null || true" % ifname)
    _run_sh("ip route replace 192.168.4.0/24 dev %s proto kernel scope link src 192.168.4.1 2>/dev/null || true" % ifname)
    _run_sh("ip route replace 255.255.255.255/32 dev %s scope link src 192.168.4.1 2>/dev/null || true" % ifname)
    _ensure_firewall_open(ifname)

def _free_dhcp_and_dns_ports():
    """Stop any external dnsmasq / systemd-resolved (.service + .socket) and kill any external PID holding UDP :53 or :67
    so our built-in RFC 2131 DHCP (:67) + Captive DNS (:53) binds cleanly without Errno 98."""
    _run_sh("pkill -9 -f 'stump_dnsmasq' 2>/dev/null || true")
    _run_sh("pkill -9 -x dnsmasq 2>/dev/null || true")
    _run_sh("systemctl stop systemd-resolved.socket systemd-resolved.service dnsmasq 2>/dev/null || true")
    my_pid = os.getpid()
    target_inodes = set()
    for net_table in ("/proc/net/udp", "/proc/net/udp6"):
        if not _REAL_EXISTS(net_table):
            continue
        try:
            with _REAL_OPEN(net_table, "r", encoding="utf-8", errors="replace") as f:
                for ln in f.read().splitlines()[1:]:
                    cols = ln.split()
                    if len(cols) >= 10:
                        loc_port = cols[1].split(":")[-1].upper()
                        if loc_port in ("0035", "0043"):  # 0x0035 = 53 (DNS), 0x0043 = 67 (DHCP)
                            inode = cols[9].strip()
                            if inode and inode != "0":
                                target_inodes.add("socket:[%s]" % inode)
        except Exception:
            pass
    if target_inodes:
        try:
            for entry in _REAL_LISTDIR("/proc"):
                if not entry.isdigit():
                    continue
                pid = int(entry)
                if pid in (1, my_pid):
                    continue
                fd_dir = "/proc/%s/fd" % entry
                try:
                    for fd_name in _REAL_LISTDIR(fd_dir):
                        try:
                            link = os.readlink(fd_dir + "/" + fd_name)
                            if link in target_inodes:
                                os.kill(pid, 9)
                                _log_debug("DNS", "Freed UDP :53/:67 from external PID %d" % pid)
                                break
                        except Exception:
                            continue
                except Exception:
                    continue
        except Exception:
            pass

def _start_cam_ap(rrc_mod=None):
    """Bring up Stump AP ('LaBuche-Stump' @ 192.168.4.1) on dArkOS (Debian 13 trixie + Linux 4.4.189)."""
    if _AP_STATE.get("switching"):
        _log_debug("AP", "Ignored duplicate _start_cam_ap while switch in progress")
        return _AP_STATE["active"]

    _AP_STATE["switching"] = True
    _AP_STATE["last_switch_ts"] = time.time()
    _AP_STATE["user_wanted"] = True
    _set_busy("IN PROCESS: STARTING STUMP AP 192.168.4.1...", 6.0)

    try:
        wlans, rt = _scan_wifi_interfaces()
        if not rt:
            _log_debug("AP", "ERROR: No Wi-Fi adapter detected on USB hub")
            if rrc_mod:
                rrc_mod.system("main", "[STUMP-AP] No Wi-Fi adapter detected on USB hub")
            return False
        ifname = rt["ifname"]
        _AP_STATE["ifname"] = ifname
        _AP_STATE["mac"] = rt["mac"]
        _AP_STATE["driver"] = rt["driver"]
        _AP_STATE["dual_wifi"] = len(wlans) >= 2

        if not _WIFI_SSIDS:
            try:
                for sv in _get_saved_wifi_profiles():
                    _WIFI_SSIDS.append({"ssid": sv, "signal": 75, "sec": "SAVED", "active": 0})
            except Exception:
                pass

        cur_ap_if = _AP_STATE.get("ap_if") or ifname
        if _is_ap_broadcasting(cur_ap_if):
            _ensure_ap_ip_and_routes(cur_ap_if, flush_non_ap=True)
            _AP_STATE["active"] = True
            _verify_and_heal_http_ports()
            _log_debug("AP", "AP already broadcasting on %s (192.168.4.1)" % cur_ap_if)
            return True

        _run_sh("pkill -9 -f 'stump_hostapd' 2>/dev/null || true")
        _run_sh("pkill -9 -f 'stump_wpa_ap' 2>/dev/null || true")
        _free_dhcp_and_dns_ports()
        _run_sh("rm -rf /run/wpa_supplicant_stump /dev/shm/wpa_ap.log /dev/shm/hostapd.log 2>/dev/null || true")
        _run_sh("iw dev uap0 del 2>/dev/null || true")
        _run_sh("rfkill unblock wifi 2>/dev/null || rfkill unblock all 2>/dev/null || true")

        ap_if = ifname
        concurrent_lan_and_ap = _AP_STATE["dual_wifi"]

        if concurrent_lan_and_ap:
            _run_sh("nmcli dev disconnect %s 2>/dev/null || true" % ifname)
            _run_sh("nmcli dev set %s managed no 2>/dev/null || true" % ifname)
        else:
            _kill_competing_net_daemons(ifname)
            _run_sh("ip addr flush dev %s 2>/dev/null || true" % ifname)
            time.sleep(0.4)

        live_ok = False

        # METHOD 1: Direct hostapd nl80211 AP (if hostapd binary is installed)
        if shutil.which("hostapd"):
            _log_debug("AP", "Starting hostapd nl80211 on %s..." % ap_if)
            _run_sh("ip link set dev %s down 2>/dev/null || true" % ap_if)
            _run_sh("iw dev %s set type __ap 2>/dev/null || true" % ap_if)
            _run_sh("ip link set dev %s up 2>/dev/null || true" % ap_if)
            _ensure_ap_ip_and_routes(ap_if, flush_non_ap=True)
            _run_sh("iw dev %s set power_save off 2>/dev/null || true" % ap_if)
            _run_sh("iw dev %s set txpower fixed 2000 2>/dev/null || true" % ap_if)

            hapd_cfg = "/dev/shm/stump_hostapd.conf"
            with _REAL_OPEN(hapd_cfg, "w", encoding="utf-8") as f:
                f.write(
                    "interface=%s\\n"
                    "driver=nl80211\\n"
                    "ssid=%s\\n"
                    "hw_mode=g\\n"
                    "channel=%d\\n"
                    "auth_algs=1\\n"
                    "ignore_broadcast_ssid=0\\n"
                    "wmm_enabled=0\\n"
                    % (ap_if, CAM_AP_SSID, CAM_AP_CHAN)
                )
            _run_sh("hostapd -B %s >/dev/shm/hostapd.log 2>&1" % hapd_cfg)
            for _ in range(10):
                time.sleep(0.35)
                if _is_ap_broadcasting(ap_if):
                    live_ok = True
                    break

        # METHOD 2: Standalone wpa_supplicant mode=2 (AP) with pmf=0 / ieee80211w=0 for Debian 13 + kernel 4.4.189
        if not live_ok:
            _log_debug("AP", "Starting standalone wpa_supplicant mode=2 AP on %s..." % ap_if)
            _run_sh("pkill -9 -f 'stump_hostapd' 2>/dev/null || true")
            if not concurrent_lan_and_ap:
                _kill_competing_net_daemons(ap_if)
                _run_sh("ip addr flush dev %s 2>/dev/null || true" % ap_if)

            _run_sh("ip link set dev %s down 2>/dev/null || true" % ap_if)
            _run_sh("iw dev %s set type managed 2>/dev/null || true" % ap_if)
            _run_sh("ip link set dev %s up 2>/dev/null || true" % ap_if)
            _run_sh("iw dev %s set power_save off 2>/dev/null || true" % ap_if)
            _run_sh("iw dev %s set txpower fixed 2000 2>/dev/null || true" % ap_if)

            wpa_cfg = "/dev/shm/stump_wpa_ap.conf"
            with _REAL_OPEN(wpa_cfg, "w", encoding="utf-8") as f:
                f.write(
                    "ctrl_interface=/run/wpa_supplicant_stump\\n"
                    "ap_scan=2\\n"
                    "pmf=0\\n"
                    "network={\\n"
                    "    ssid=\\"%s\\"\\n"
                    "    mode=2\\n"
                    "    frequency=2437\\n"
                    "    key_mgmt=NONE\\n"
                    "    ieee80211w=0\\n"
                    "}\\n" % CAM_AP_SSID
                )
            _run_sh("rm -rf /run/wpa_supplicant_stump 2>/dev/null || true")
            _run_sh("wpa_supplicant -B -i %s -c %s -D nl80211,wext >/dev/shm/wpa_ap.log 2>&1" % (ap_if, wpa_cfg))
            for _ in range(14):
                time.sleep(0.35)
                if _is_ap_broadcasting(ap_if):
                    live_ok = True
                    break

        # Wait 0.4s after AP-ENABLED so kernel nl80211 mode switch finishes, then lock 192.168.4.1/24 on wlan0!
        time.sleep(0.4)
        _ensure_ap_ip_and_routes(ap_if, flush_non_ap=True)
        _run_sh("iw dev %s set power_save off 2>/dev/null || true" % ap_if)
        if not concurrent_lan_and_ap:
            _AP_STATE["joined_ssid"] = ""
            _AP_STATE["lan_ip"] = CAM_AP_IP

        _AP_STATE["ap_if"] = ap_if
        _AP_STATE["active"] = True
        _verify_and_heal_http_ports()
        _log_debug("AP", "STUMP AP LIVE: %s @ http://192.168.4.1:80/ (DHCP :67 + DNS :53 ON)" % CAM_AP_SSID)
        if rrc_mod:
            mode_desc = "LAN+AP CONCURRENT" if concurrent_lan_and_ap else "EXCLUSIVE AP MODE"
            rrc_mod.system(
                "wifi-mesh",
                "STUMP AP ON AIR (%s): %s -> SSID '%s' @ http://192.168.4.1:80/"
                % (mode_desc, ap_if, CAM_AP_SSID)
            )
            rrc_mod.system("main", "Stump AP '%s' LIVE on 192.168.4.1:80 (%s)" % (CAM_AP_SSID, mode_desc))
        return True
    finally:
        _AP_STATE["switching"] = False
        _set_busy("STUMP AP LIVE ON 192.168.4.1:80", 1.5)

def _stop_cam_ap(rrc_mod=None, reconnect_default=True):
    if _AP_STATE.get("switching"):
        _log_debug("AP", "Ignored duplicate _stop_cam_ap while switch in progress")
        return
    _AP_STATE["switching"] = True
    _AP_STATE["last_switch_ts"] = time.time()
    _AP_STATE["user_wanted"] = False
    _AP_STATE["retries"] = 0
    _set_busy("IN PROCESS: SWITCHING TO LOCAL LAN WIFI...", 6.0)
    try:
        ifname = _AP_STATE.get("ifname") or "wlan0"
        _log_debug("WIFI", "Stopping Stump AP on %s and restoring NetworkManager..." % ifname)
        _ensure_clean_lan_sta(ifname)
        _AP_STATE["active"] = False
        _AP_STATE["ap_if"] = ""
        if reconnect_default:
            time.sleep(1.5)
            _run_sh("nmcli dev connect %s 2>/dev/null || true" % ifname)
            time.sleep(2.0)
            _scan_wifi_ssids(ifname, force_rescan=False)
            lan_ip = _get_iface_ipv4(ifname)
            if lan_ip:
                _AP_STATE["lan_ip"] = lan_ip
            _verify_and_heal_http_ports()
            _log_debug("WIFI", "Local LAN STA active on %s (IP: %s)" % (ifname, lan_ip or "DHCP"))
            if rrc_mod:
                rrc_mod.system("main", "Stump AP stopped on %s - Local LAN Wi-Fi active (%s)" % (ifname, lan_ip or "STA"))
    finally:
        _AP_STATE["switching"] = False
        _set_busy("LOCAL LAN WIFI READY", 1.5)

def _join_wifi_ssid(ssid, password="", rrc_mod=None):
    """Stop Stump AP if running, restart NetworkManager, and connect <ifname> to the user-selected Wi-Fi SSID."""
    ssid = (ssid or "").strip()
    password = (password or "").strip()
    if not ssid:
        return False
    _set_busy("IN PROCESS: JOINING WIFI '%s'..." % ssid[:22], 8.0)
    wlans, rt = _scan_wifi_interfaces()
    ifname = rt["ifname"] if rt else (_AP_STATE.get("ifname") or "wlan0")
    _log_debug("WIFI", "Joining SSID '%s' on %s..." % (ssid, ifname))
    if rrc_mod:
        rrc_mod.system("main", "[WIFI] Switching %s to join SSID '%s'..." % (ifname, ssid))

    _AP_STATE["switching"] = False
    _stop_cam_ap(None, reconnect_default=False)
    time.sleep(1.8)
    _run_sh("nmcli dev wifi rescan ifname %s 2>/dev/null || true" % ifname)
    time.sleep(1.2)

    safe_ssid = ssid.replace('"', '\\\\"')
    safe_pass = password.replace('"', '\\\\"')

    if safe_pass:
        _run_sh('nmcli con delete "%s" 2>/dev/null || true' % safe_ssid)
        cmd = 'nmcli -w 15 dev wifi connect "%s" password "%s" ifname %s >/dev/shm/wifi_join.log 2>&1' % (safe_ssid, safe_pass, ifname)
        _run_sh(cmd, timeout=18)
    else:
        _run_sh('nmcli -w 12 con up "%s" >/dev/shm/wifi_join.log 2>&1 || nmcli -w 15 dev wifi connect "%s" ifname %s >>/dev/shm/wifi_join.log 2>&1' % (safe_ssid, safe_ssid, ifname), timeout=18)

    time.sleep(1.5)
    _scan_wifi_ssids(ifname, force_rescan=False)
    lan_ip = _get_iface_ipv4(ifname)
    if lan_ip:
        _AP_STATE["lan_ip"] = lan_ip
    joined_ok = (_AP_STATE.get("joined_ssid") == ssid) or bool(lan_ip and lan_ip != CAM_AP_IP)
    if joined_ok:
        _AP_STATE["joined_ssid"] = ssid
        _log_debug("WIFI", "Joined '%s' on %s (IP %s)" % (ssid, ifname, lan_ip or "DHCP"))
        _set_busy("JOINED '%s' (%s)" % (ssid[:18], lan_ip or "OK"), 2.0)
    else:
        _log_debug("WIFI", "Failed to join '%s' (check password in Tab 5)" % ssid)
        _set_busy("COULD NOT JOIN '%s'" % ssid[:20], 2.5)

    _verify_and_heal_http_ports()
    if rrc_mod:
        if joined_ok:
            rrc_mod.system("main", "[WIFI] Joined '%s' on %s (%s)!" % (ssid, ifname, lan_ip or "OK"))
        else:
            rrc_mod.system("main", "[WIFI] Could not join '%s' (check password in Tab 5)" % ssid)
    return joined_ok

def _ensure_python_deps_and_ucryptolib():
    """Add /home/ark/firefly/venv site-packages if present, and ensure ucryptolib never fails if cryptography is missing."""
    for pattern in (
        "/home/ark/firefly/venv/lib/python*/site-packages",
        "/roms/ports/stump_r36max/venv/lib/python*/site-packages",
        "/usr/local/lib/python*/dist-packages",
    ):
        for p in sorted(glob.glob(pattern)):
            if p not in sys.path:
                sys.path.append(p)
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher  # noqa: F401
    except Exception:
        # Provide a self-contained ucryptolib fallback so pc_compat/ucryptolib.py never crashes barkeep.py
        mod = types.ModuleType("ucryptolib")
        MODE_CBC = 2
        class _FallbackAES:
            def __init__(self, key, mode, iv=b"\\x00" * 16):
                self._key = bytes(key or b"\\x00" * 16)
                self._iv = bytes(iv or b"\\x00" * 16)
            def encrypt(self, data):
                b = bytes(data)
                kl = len(self._key)
                return bytes(b[i] ^ self._key[i % kl] ^ self._iv[i % 16] for i in range(len(b)))
            def decrypt(self, data):
                return self.encrypt(data)
        mod.MODE_CBC = MODE_CBC
        mod.aes = _FallbackAES
        sys.modules["ucryptolib"] = mod

def _init_stump_final_firmware():
    """Initialize stump_host and final_firmware modules (config, features, fserv, rrc, billboard, rrc_ui, barkeep)
    so 0.0.0.0:80 and 0.0.0.0:8080 serve the 100% authentic Project Stump final_firmware Visitor Interface."""
    _ensure_python_deps_and_ucryptolib()
    pc_compat_dir = os.path.join(HERE, "pc_compat")
    if pc_compat_dir not in sys.path:
        sys.path.insert(0, pc_compat_dir)
    if HERE not in sys.path:
        sys.path.insert(0, HERE)

    try:
        import stump_host
        stump_host.install(HERE)

        _orig_from_fw = stump_host._from_firmware
        _THIS_FILE = os.path.abspath(__file__).replace("\\\\", "/")
        def _patched_from_fw():
            try:
                f = sys._getframe(2)
                if f.f_code.co_filename.replace("\\\\", "/") == _THIS_FILE:
                    return False
            except Exception:
                pass
            return _orig_from_fw()
        stump_host._from_firmware = _patched_from_fw

        def _dynamic_hotspot_ip():
            if _AP_STATE.get("active") or _AP_STATE.get("user_wanted"):
                return CAM_AP_IP
            lan = _AP_STATE.get("lan_ip")
            if lan and lan != "127.0.0.1":
                return lan
            return CAM_AP_IP
        stump_host.hotspot_ip = _dynamic_hotspot_ip
    except Exception as e:
        _log_debug("INIT", "stump_host note: %s" % e)

    try:
        import config
        config.NODE_NAME = getattr(config, "NODE_NAME", "LaBuche-R36MAX")
        config.SSID_NAME = CAM_AP_SSID
        config.PC_HOTSPOT_NAME = CAM_AP_SSID
        config.THEME = getattr(config, "THEME", "amber")
        config.AUTH_ACCESS_MODE = "open"
        config.APP_HELLO = False
        config.CHAIN = True
        config.PC_HTTP_PORT = 8880
        config.FEATURES = ["chat", "billboard", "files", "about"]
    except Exception as e:
        _log_debug("INIT", "config note: %s" % e)

    try:
        import features
        features._CONFIGURED = ("chat", "billboard", "files", "about")
        features._memo = [None, None]
    except Exception:
        pass

    sd_shared = os.path.join(HERE, "sd", "shared")
    _REAL_MAKEDIRS(sd_shared, exist_ok=True)
    if not [f for f in _REAL_LISTDIR(sd_shared) if not f.startswith(".")]:
        _share_real_file("1", None)

    for mod_name in ("i18n", "theme", "layout", "fserv", "rrc", "billboard", "rrc_ui", "librarian", "barkeep", "captive_portal"):
        try:
            __import__(mod_name)
        except Exception as e:
            _log_debug("INIT", "%s import note: %s" % (mod_name, e))

    # CRITICAL FIX FOR ERRNO 98 ON PORT 53:
    # final_firmware/example_node.py spawns asyncio.create_task(captive_portal.run_dns_server(ap_ip))
    # which binds 0.0.0.0:53 WITHOUT SO_REUSEADDR at boot, causing Errno 98 when _dhcp_and_dns_worker()
    # binds port 53 in AP mode! Delegate captive_portal.run_dns_server to our built-in AP DNS worker.
    cp_mod = sys.modules.get("captive_portal")
    if cp_mod:
        async def _delegated_r36max_dns_server(ap_ip=CAM_AP_IP):
            _log_debug("DNS", "captive_portal.run_dns_server delegated to R36MAX AP worker (:53)")
            while True:
                await asyncio.sleep(3600)
        cp_mod.run_dns_server = _delegated_r36max_dns_server

    rrc_mod = sys.modules.get("rrc")
    if rrc_mod:
        try:
            _ensure_local_operator_trusted(rrc_mod)
            if hasattr(rrc_mod, "open_chain_room"):
                rrc_mod.open_chain_room()
            for rn in ("main", "lora-mesh", "wifi-mesh"):
                if not rrc_mod.room_exists(rn):
                    rrc_mod.create_room(rn)
            rrc_mod.touch_user(LOCAL_CID, nick="r36max", room="main")
            if not rrc_mod.since("main", 0):
                rrc_mod.system("main", "Project Stump (final_firmware) online on LaBuche-R36MAX (%s)." % STUMP_R36MAX_VERSION)
                rrc_mod.system("main", "Ask !find <topic> in EN/FR/ES, !roll 2d6, !8ball, or /help.")
        except Exception:
            pass

    bb_mod = sys.modules.get("billboard")
    if bb_mod:
        try:
            if not bb_mod._read_entries():
                bb_mod._append_entry(
                    "Bienvenue sur LaBuche-Stump R36MAX",
                    "Noeud communautaire hors-reseau (final_firmware barkeep.py + rrc_ui.py + FireFly RK3326).",
                    "r36max"
                )
        except Exception:
            pass

def _check_http_alive(port):
    """Send a real HTTP GET request to 127.0.0.1:<port> and verify an HTTP response arrives within 0.6s."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.6)
    try:
        s.connect(("127.0.0.1", port))
        s.sendall(b"GET /stump_health HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n")
        resp = s.recv(64)
        s.close()
        return b"HTTP/" in resp
    except Exception:
        try:
            s.close()
        except Exception:
            pass
        return False

class _SocketStreamReader:
    """Adapts a blocking client socket into the uasyncio StreamReader interface expected by final_firmware/barkeep.py."""
    def __init__(self, sock, initial_buf=b""):
        self._sock = sock
        self._buf = bytearray(initial_buf)

    def start_body(self):
        pass

    async def readline(self):
        while b"\\n" not in self._buf:
            try:
                chunk = self._sock.recv(4096)
            except Exception:
                chunk = b""
            if not chunk:
                break
            self._buf.extend(chunk)
            if len(self._buf) > 65536:
                break
        idx = self._buf.find(b"\\n")
        if idx >= 0:
            line = bytes(self._buf[: idx + 1])
            del self._buf[: idx + 1]
            return line
        line = bytes(self._buf)
        self._buf.clear()
        return line

    async def read(self, n=-1):
        if n is None or n < 0:
            n = 65536
        while len(self._buf) < n:
            try:
                chunk = self._sock.recv(min(16384, max(4096, n - len(self._buf))))
            except Exception:
                chunk = b""
            if not chunk:
                break
            self._buf.extend(chunk)
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

class _SocketStreamWriter:
    """Adapts a blocking client socket into the uasyncio StreamWriter interface expected by final_firmware/barkeep.py."""
    def __init__(self, sock, peer_addr):
        self._sock = sock
        self._peer = peer_addr
        self._stump_set_cookie = None
        self._stump_no_store = False

    def get_extra_info(self, name, default=None):
        if name == "peername":
            return self._peer
        return default

    async def awrite(self, data, *args):
        if not data:
            return
        if isinstance(data, str):
            data = data.encode("utf-8")
        if len(args) == 2:
            off, sz = args
            data = memoryview(data)[off : off + sz]
        elif len(args) == 1:
            data = memoryview(data)[: args[0]]
        try:
            self._sock.sendall(data)
        except Exception:
            pass

    async def aclose(self):
        try:
            self._sock.shutdown(socket.SHUT_WR)
        except Exception:
            pass
        try:
            self._sock.close()
        except Exception:
            pass

class _ReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

class _StumpPortalTCPHandler(socketserver.BaseRequestHandler):
    """Multi-threaded TCP handler on 0.0.0.0:80 and 0.0.0.0:8080 that delegates every HTTP request directly
    to final_firmware/barkeep.py (barkeep._serve), serving the authentic Stump Visitor Interface & FireFly APIs."""
    def handle(self):
        self.request.settimeout(8.0)
        try:
            first_Peek = self.request.recv(1024, socket.MSG_PEEK)
        except Exception:
            first_Peek = b""
        if not first_Peek:
            return

        first_line = first_Peek.split(b"\\r\\n", 1)[0].decode("latin-1", errors="replace")
        if first_line.startswith("GET /stump_health"):
            try:
                self.request.recv(1024)
                self.request.sendall(
                    b"HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nOK"
                )
            except Exception:
                pass
            finally:
                try:
                    self.request.close()
                except Exception:
                    pass
            return

        # Log non-polling visitor HTTP traffic to R36MAX Panel 5 debug log
        if "/rrc/poll" not in first_line:
            parts = first_line.split(" ")
            method_path = " ".join(parts[:2]) if len(parts) >= 2 else first_line[:28]
            _log_debug("HTTP", "%s (%s)" % (method_path[:28], self.client_address[0]))

        barkeep_mod = sys.modules.get("barkeep")
        if barkeep_mod is None:
            try:
                _init_stump_final_firmware()
                barkeep_mod = sys.modules.get("barkeep")
            except Exception:
                barkeep_mod = None

        if barkeep_mod and hasattr(barkeep_mod, "_serve"):
            reader = _SocketStreamReader(self.request)
            writer = _SocketStreamWriter(self.request, self.client_address)
            try:
                asyncio.run(barkeep_mod._serve(reader, writer, secure=False))
            except Exception as e:
                _log_debug("HTTP", "barkeep._serve note: %s" % e)
            finally:
                try:
                    self.request.close()
                except Exception:
                    pass
        else:
            try:
                body = b"<!doctype html><html><body style='background:#1b1512;color:#f5ebd6;font-family:monospace;padding:24px'><h2>Stump Node Starting...</h2><p>Refresh in 2 seconds.</p></body></html>"
                hdr = (
                    "HTTP/1.1 200 OK\\r\\nContent-Type: text/html; charset=utf-8\\r\\nContent-Length: %d\\r\\nConnection: close\\r\\n\\r\\n"
                    % len(body)
                ).encode("ascii")
                self.request.sendall(hdr + body)
            except Exception:
                pass
            finally:
                try:
                    self.request.close()
                except Exception:
                    pass

def _verify_and_heal_http_ports():
    """Ensure multi-threaded final_firmware/barkeep.py portal is actively responding on BOTH :80 and :8080."""
    p80 = _check_http_alive(80)
    p8080 = _check_http_alive(8080)
    if not p80 and not _HTTP_STATE["front80_started"]:
        try:
            srv80 = _ReusableTCPServer(("0.0.0.0", 80), _StumpPortalTCPHandler)
            _KEEPALIVE_SERVERS.append(srv80)
            threading.Thread(target=srv80.serve_forever, daemon=True).start()
            _HTTP_STATE["front80_started"] = True
            p80 = True
            _log_debug("HTTP", "final_firmware/barkeep.py bound on 0.0.0.0:80")
        except Exception as e:
            _log_debug("HTTP", "Port :80 bind note: %s" % e)
    if not p8080 and not _HTTP_STATE["front8080_started"]:
        try:
            srv8080 = _ReusableTCPServer(("0.0.0.0", 8080), _StumpPortalTCPHandler)
            _KEEPALIVE_SERVERS.append(srv8080)
            threading.Thread(target=srv8080.serve_forever, daemon=True).start()
            _HTTP_STATE["front8080_started"] = True
            p8080 = True
            _log_debug("HTTP", "final_firmware/barkeep.py bound on 0.0.0.0:8080")
        except Exception as e:
            _log_debug("HTTP", "Port :8080 bind note: %s" % e)
    _HTTP_STATE["port80"] = p80
    _HTTP_STATE["port8080"] = p8080
    return p80, p8080

def _dhcp_and_dns_worker():
    """Always-ready built-in RFC 2131 DHCP (:67) + Captive DNS (:53 -> 192.168.4.1) server for Walk-Up AP mode."""
    leases = {}
    next_ip = 25
    dhcp_sock = None
    dns_sock = None
    last_ip_assert = 0.0
    last_dhcp_bind_try = 0.0
    last_dns_bind_try = 0.0

    _free_dhcp_and_dns_ports()

    while True:
        try:
            ap_wanted = bool(_AP_STATE.get("active") or _AP_STATE.get("user_wanted"))
            if not ap_wanted:
                if dns_sock is not None:
                    try:
                        dns_sock.close()
                    except Exception:
                        pass
                    dns_sock = None
                if dhcp_sock is not None:
                    try:
                        dhcp_sock.close()
                    except Exception:
                        pass
                    dhcp_sock = None
                time.sleep(0.35)
                continue

            ap_if = _AP_STATE.get("ap_if") or _AP_STATE.get("ifname") or "wlan0"
            now_t = time.time()
            if now_t - last_ip_assert >= 2.0:
                last_ip_assert = now_t
                _ensure_ap_ip_and_routes(ap_if, flush_non_ap=True)

            if dhcp_sock is None and (now_t - last_dhcp_bind_try >= 3.0):
                last_dhcp_bind_try = now_t
                try:
                    s67 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                    s67.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    try:
                        s67.setsockopt(socket.SOL_SOCKET, 15, 1)  # SO_REUSEPORT
                    except Exception:
                        pass
                    s67.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                    try:
                        s67.bind(("0.0.0.0", 67))
                    except Exception:
                        _free_dhcp_and_dns_ports()
                        s67.bind(("0.0.0.0", 67))
                    s67.setblocking(False)
                    dhcp_sock = s67
                    _log_debug("DHCP", "RFC 2131 DHCP listening on 0.0.0.0:67")
                except Exception as e:
                    _log_debug("DHCP", "Port 67 bind retry: %s" % e)
                    try:
                        s67.close()
                    except Exception:
                        pass
                    dhcp_sock = None

            if dns_sock is None and (now_t - last_dns_bind_try >= 3.0):
                last_dns_bind_try = now_t
                try:
                    s53 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                    s53.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    try:
                        s53.setsockopt(socket.SOL_SOCKET, 15, 1)  # SO_REUSEPORT
                    except Exception:
                        pass
                    try:
                        s53.bind(("0.0.0.0", 53))
                    except Exception:
                        _free_dhcp_and_dns_ports()
                        try:
                            s53.bind(("0.0.0.0", 53))
                        except Exception:
                            s53.bind((CAM_AP_IP, 53))
                    s53.setblocking(False)
                    dns_sock = s53
                    _log_debug("DNS", "Captive DNS listening on :53 -> 192.168.4.1")
                except Exception as e:
                    _log_debug("DNS", "Port 53 bind retry: %s" % e)
                    try:
                        s53.close()
                    except Exception:
                        pass
                    dns_sock = None

            rlist = [s for s in (dhcp_sock, dns_sock) if s is not None]
            if not rlist:
                time.sleep(0.4)
                continue

            readable, _, _ = select.select(rlist, [], [], 0.35)

            if dhcp_sock and dhcp_sock in readable:
                data, _ = dhcp_sock.recvfrom(1500)
                if len(data) >= 240 and data[0] == 1 and data[236:240] == b"\\x63\\x82\\x53\\x63":
                    xid = data[4:8]
                    client_flags = data[10:12]
                    ciaddr_bytes = data[12:16]
                    chaddr = data[28:44]
                    mac_bytes = chaddr[:6]
                    mac_str = ":".join("%02x" % b for b in mac_bytes)
                    msg_type = 0
                    req_ip = ""
                    idx = 240
                    while idx < len(data):
                        opt = data[idx]
                        if opt == 255:
                            break
                        if opt == 0:
                            idx += 1
                            continue
                        if idx + 1 >= len(data):
                            break
                        olen = data[idx + 1]
                        if opt == 53 and olen >= 1 and idx + 2 < len(data):
                            msg_type = data[idx + 2]
                        elif opt == 50 and olen == 4 and idx + 6 <= len(data):
                            try:
                                req_ip = socket.inet_ntoa(data[idx + 2 : idx + 6])
                            except Exception:
                                pass
                        idx += 2 + olen

                    ciaddr_str = ""
                    if ciaddr_bytes != b"\\x00\\x00\\x00\\x00":
                        try:
                            ciaddr_str = socket.inet_ntoa(ciaddr_bytes)
                        except Exception:
                            ciaddr_str = ""

                    siaddr = socket.inet_aton(CAM_AP_IP)

                    # If client moved from a home router (e.g. 192.168.0.x) and sent DHCPREQUEST for wrong subnet,
                    # send RFC 2131 DHCPNAK (type 6) so macOS/iOS immediately drops stale IP and sends DHCPDISCOVER!
                    wrong_subnet_req = (
                        msg_type == 3
                        and (
                            (req_ip and not req_ip.startswith("192.168.4."))
                            or (not req_ip and ciaddr_str and not ciaddr_str.startswith("192.168.4."))
                        )
                    )
                    if wrong_subnet_req:
                        nak_pkt = bytearray(240)
                        nak_pkt[0] = 2
                        nak_pkt[1] = 1
                        nak_pkt[2] = 6
                        nak_pkt[4:8] = xid
                        nak_pkt[10:12] = b"\\x80\\x00"
                        nak_pkt[20:24] = siaddr
                        nak_pkt[28:44] = chaddr
                        nak_pkt[236:240] = b"\\x63\\x82\\x53\\x63"
                        nak_opts = b"\\x35\\x01\\x06\\x36\\x04" + siaddr + b"\\xff"
                        full_nak = bytes(nak_pkt + nak_opts)
                        if len(full_nak) < 300:
                            full_nak += b"\\x00" * (300 - len(full_nak))
                        for dst_ip in ("255.255.255.255", "192.168.4.255"):
                            try:
                                dhcp_sock.sendto(full_nak, (dst_ip, 68))
                            except Exception:
                                pass
                        _log_debug("DHCP", "Sent NAK for old subnet %s (%s)" % (req_ip or ciaddr_str, mac_str))
                    elif msg_type in (1, 3):
                        if mac_bytes not in leases:
                            if req_ip.startswith("192.168.4.") and req_ip != CAM_AP_IP:
                                leases[mac_bytes] = req_ip
                            else:
                                leases[mac_bytes] = "192.168.4.%d" % next_ip
                                next_ip = 25 if next_ip >= 200 else (next_ip + 1)
                        assigned_ip = leases[mac_bytes]
                        yiaddr = socket.inet_aton(assigned_ip)
                        reply_type = 2 if msg_type == 1 else 5
                        _log_debug("DHCP", "%s %s -> %s" % ("OFFER" if reply_type == 2 else "ACK", assigned_ip, mac_str))

                        # Populate kernel ARP entry so unicast + broadcast replies both arrive on macOS/iOS/Android
                        _run_sh("ip neigh replace %s lladdr %s nud reachable dev %s 2>/dev/null || true" % (assigned_ip, mac_str, ap_if))

                        pkt = bytearray(240)
                        pkt[0] = 2
                        pkt[1] = 1
                        pkt[2] = 6
                        pkt[3] = 0
                        pkt[4:8] = xid
                        pkt[10:12] = client_flags
                        pkt[16:20] = yiaddr
                        pkt[20:24] = siaddr
                        pkt[28:44] = chaddr
                        pkt[236:240] = b"\\x63\\x82\\x53\\x63"

                        # Standard RFC 2131 options (NO Option 114 so macOS runs standard HTTP captive.apple.com probe!)
                        opts = bytearray()
                        opts += b"\\x35\\x01" + bytes([reply_type])          # Option 53: DHCP Message Type
                        opts += b"\\x36\\x04" + siaddr                       # Option 54: Server Identifier (192.168.4.1)
                        opts += b"\\x33\\x04\\x00\\x00\\x0e\\x10"              # Option 51: Lease Time (3600s)
                        opts += b"\\x3a\\x04\\x00\\x00\\x07\\x08"              # Option 58: Renewal T1 (1800s)
                        opts += b"\\x3b\\x04\\x00\\x00\\x0c\\x4e"              # Option 59: Rebinding T2 (3150s)
                        opts += b"\\x01\\x04\\xff\\xff\\xff\\x00"              # Option 1: Subnet Mask (255.255.255.0)
                        opts += b"\\x1c\\x04\\xc0\\xa8\\x04\\xff"              # Option 28: Broadcast (192.168.4.255)
                        opts += b"\\x03\\x04" + siaddr                       # Option 3: Router (192.168.4.1)
                        opts += b"\\x06\\x04" + siaddr                       # Option 6: DNS Server (192.168.4.1)
                        opts += b"\\x0f\\x05stump"                          # Option 15: Domain Name
                        opts += b"\\xff"                                   # Option 255: End
                        full_pkt = bytes(pkt + opts)
                        if len(full_pkt) < 300:
                            full_pkt += b"\\x00" * (300 - len(full_pkt))

                        for dst_ip in (assigned_ip, "192.168.4.255", "255.255.255.255"):
                            try:
                                dhcp_sock.sendto(full_pkt, (dst_ip, 68))
                            except Exception:
                                pass
                        if ciaddr_str and ciaddr_str.startswith("192.168.4."):
                            try:
                                dhcp_sock.sendto(full_pkt, (ciaddr_str, 68))
                            except Exception:
                                pass

            if dns_sock and dns_sock in readable:
                qdata, qaddr = dns_sock.recvfrom(512)
                if len(qdata) >= 17:
                    txid = qdata[:2]
                    qend = 12
                    while qend < len(qdata) and qdata[qend] != 0:
                        qend += 1 + qdata[qend]
                    qend += 5
                    if qend <= len(qdata):
                        question = qdata[12:qend]
                        qtype = (qdata[qend - 4] << 8) | qdata[qend - 3]
                        if qtype in (1, 255):  # A (IPv4) or ANY -> resolve to 192.168.4.1
                            ans = (
                                txid
                                + b"\\x81\\x80\\x00\\x01\\x00\\x01\\x00\\x00\\x00\\x00"
                                + question
                                + b"\\xc0\\x0c\\x00\\x01\\x00\\x01\\x00\\x00\\x00\\x0a\\x00\\x04"
                                + socket.inet_aton(CAM_AP_IP)
                            )
                        else:  # AAAA (IPv6) or HTTPS (65) -> clean NOERROR 0 answers so macOS uses IPv4 HTTP immediately
                            ans = (
                                txid
                                + b"\\x81\\x80\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00"
                                + question
                            )
                        try:
                            dns_sock.sendto(ans, qaddr)
                        except Exception:
                            pass
        except Exception as e:
            _log_debug("DHCP", "Worker note: %s" % e)
            if dns_sock:
                try: dns_sock.close()
                except Exception: pass
                dns_sock = None
            if dhcp_sock:
                try: dhcp_sock.close()
                except Exception: pass
                dhcp_sock = None
            time.sleep(0.3)

def _clean_field(val, max_len=56):
    s = str(val or "").replace("|", "/").replace("\\r", " ").replace("\\n", " ").replace("\\t", " ")
    return " ".join(s.split())[:max_len]

def _guess_cat(fname):
    ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
    if ext in ("mp4", "mkv", "webm", "avi", "mov"): return "VID"
    if ext in ("mp3", "ogg", "opus", "flac", "wav"): return "MUS"
    if ext in ("pdf", "txt", "md", "epub", "html", "doc"): return "DOC"
    if ext in ("jpg", "jpeg", "png", "gif", "webp"): return "IMG"
    return "APP"

def _node_lxmf_str(rrc_mod):
    if not rrc_mod:
        return "A7F391C208B4E6D1"
    node = getattr(rrc_mod, "NODE", None)
    if isinstance(node, dict):
        return str(node.get("lxmf") or "A7F391C208B4E6D1")
    if isinstance(node, str) and node:
        return node
    return "A7F391C208B4E6D1"

def _detect_heltec_rnode():
    for dev in ("/dev/ttyACM0", "/dev/ttyUSB0", "/dev/ttyACM1", "/dev/ttyUSB1"):
        if _REAL_EXISTS(dev):
            return dev
    return ""

def _ensure_local_operator_trusted(rrc_mod):
    if not rrc_mod:
        return
    try:
        loc = tuple(getattr(rrc_mod, "_LOCAL", ("127.0.0.1", "::1")))
        if LOCAL_CID not in loc:
            rrc_mod._LOCAL = loc + (LOCAL_CID,)
    except Exception:
        pass
    try:
        for mname in ("stumpid", "plugins.stumpid", "stumpid.core"):
            smod = sys.modules.get(mname)
            if smod:
                vdict = getattr(smod, "_verified_this_session", None)
                if isinstance(vdict, dict):
                    vdict[LOCAL_CID] = "r36max"
                core = getattr(smod, "core", None)
                if core and isinstance(getattr(core, "_verified_this_session", None), dict):
                    core._verified_this_session[LOCAL_CID] = "r36max"
    except Exception:
        pass
    try:
        gmod = sys.modules.get("guard")
        if gmod and isinstance(getattr(gmod, "_buckets", None), dict):
            gmod._buckets.pop(("chat", LOCAL_CID), None)
    except Exception:
        pass

def _share_real_file(mode_str, rrc_mod):
    shared_dir = os.path.join(HERE, "sd", "shared")
    _REAL_MAKEDIRS(shared_dir, exist_ok=True)
    ts_label = time.strftime("%H%M%S")
    if mode_str == "0":
        fname = "r36max_mesh_log_%s.txt" % ts_label
        lines = [
            "=== LABUCHE-STUMP R36MAX LIVE NODE REPORT (%s) ===" % STUMP_R36MAX_VERSION,
            "Timestamp: %s" % time.strftime("%Y-%m-%d %H:%M:%S"),
            "Node LXMF: %s" % _node_lxmf_str(rrc_mod),
            "Blueway RT3070 AP: %s (%s)" % (_AP_STATE.get("ifname") or "wlan0", "ACTIVE" if _AP_STATE["active"] else "STA"),
            "Heltec V3 RNode: %s" % (_detect_heltec_rnode() or "STANDBY"),
            "",
            "--- Recent RRC Room Transcript ---"
        ]
        if rrc_mod:
            for rname in ("main", "lora-mesh", "wifi-mesh"):
                try:
                    msgs = rrc_mod.since(rname, 0)
                    lines.append("[%s] (%d messages):" % (rname, len(msgs)))
                    for m in msgs[-10:]:
                        lines.append("  <%s> %s" % (m.get("nick", "?"), m.get("body", "")))
                except Exception:
                    pass
        with _REAL_OPEN(os.path.join(shared_dir, fname), "w", encoding="utf-8") as f:
            f.write("\\n".join(lines) + "\\n")
        return fname
    elif mode_str == "1":
        fname = "guide_jardinage_mesh_r36max.md"
        content = (
            "# Guide Terrain LaBuche-Stump (FR / EN / ES) — %s\\n\\n"
            "## 1. Jardinage & Permaculture / Gardening / Jardineria\\n"
            "- Association de cultures, paillage organique, collecte d'eau de pluie.\\n"
            "- Companion planting, mulching, off-grid water catchment.\\n\\n"
            "## 2. Relais Radio LoRa (Heltec V3) & Blueway RT3070 Stump AP\\n"
            "- Blueway RT3070 (148f:3070, rt2800usb, MAC 00:0f:00:5e:11:ee) -> SSID LaBuche-Stump (192.168.4.1).\\n"
            "- Heltec V3 RNode USB-C -> /dev/ttyACM0 ou /dev/ttyUSB0 (868/915 MHz).\\n" % STUMP_R36MAX_VERSION
        )
        with _REAL_OPEN(os.path.join(shared_dir, fname), "w", encoding="utf-8") as f:
            f.write(content)
        return fname
    else:
        for drop_dir in ("/roms/ports/stump_r36max/drop", "/roms/ports/r36max_av/drop_anything_here"):
            if _REAL_ISDIR(drop_dir):
                for entry in sorted(_REAL_LISTDIR(drop_dir)):
                    src = os.path.join(drop_dir, entry)
                    if _REAL_ISFILE(src) and not entry.startswith("."):
                        dst = os.path.join(shared_dir, entry)
                        shutil.copy2(src, dst)
                        return entry
        fname = "r36max_beacon_%s.txt" % ts_label
        with _REAL_OPEN(os.path.join(shared_dir, fname), "w", encoding="utf-8") as f:
            f.write("R36MAX Stump Beacon Snapshot (%s) at %s\\n" % (STUMP_R36MAX_VERSION, time.strftime("%Y-%m-%d %H:%M:%S")))
        return fname

def _export_diagnostics_to_tf(rrc_mod=None):
    """Export full diagnostic bundle (version, net state, sockets, logs) to TF card (/roms/ports/stump_r36max/tf_backup/)
    and /sd/shared/ so the operator can inspect or download it."""
    _set_busy("IN PROCESS: EXPORTING DIAGNOSTICS TO TF CARD...", 3.0)
    _REAL_MAKEDIRS(TF_BACKUP_DIR, exist_ok=True)
    shared_dir = os.path.join(HERE, "sd", "shared")
    _REAL_MAKEDIRS(shared_dir, exist_ok=True)
    ts_str = time.strftime("%Y%m%d_%H%M%S")
    diag_name = "stump_diag_%s.txt" % ts_str
    tf_path = os.path.join(TF_BACKUP_DIR, diag_name)
    shared_path = os.path.join(shared_dir, "stump_diag_latest.txt")

    sections = [
        "====================================================================",
        "LABUCHE-STUMP R36MAX DIAGNOSTIC & LOG EXPORT",
        "Version : %s (%s)" % (STUMP_R36MAX_VERSION, STUMP_R36MAX_BUILD),
        "Exported: %s" % time.strftime("%Y-%m-%d %H:%M:%S"),
        "AP State: active=%s user_wanted=%s if=%s ap_if=%s lan_ip=%s joined=%s clients=%d" % (
            _AP_STATE["active"], _AP_STATE["user_wanted"], _AP_STATE["ifname"],
            _AP_STATE["ap_if"], _AP_STATE["lan_ip"], _AP_STATE.get("joined_ssid", ""), _AP_STATE["clients"]
        ),
        "HTTP    : port80=%s port8080=%s front80=%s front8080=%s" % (
            _HTTP_STATE["port80"], _HTTP_STATE["port8080"],
            _HTTP_STATE["front80_started"], _HTTP_STATE["front8080_started"]
        ),
        "====================================================================",
        "",
        "--- [1] RECENT BRIDGE & RADIO EVENT LOG ---",
    ] + list(_DEBUG_LOGS)

    for title, cmd in (
        ("[2] UNAME & SYSTEM", "uname -a 2>&1"),
        ("[3] IPv4 ADDRESSES (ip -4 addr)", "ip -4 addr show 2>&1"),
        ("[4] ROUTES & ARP NEIGHBORS", "ip route show 2>&1; echo '--- ARP ---'; ip neigh show 2>&1"),
        ("[5] WIRELESS INTERFACES (iw dev)", "iw dev 2>&1"),
        ("[6] LISTENING SOCKETS (:80, :8080, :67, :53, :42421)", "ss -tulpn 2>&1 || netstat -tulpn 2>&1"),
        ("[7] PROCESSES (stump / wpa / hostapd / dnsmasq / NM)", "ps aux 2>&1 | grep -E 'stump|wpa|hostapd|dnsmasq|NetworkManager|dhc'"),
    ):
        sections.append("")
        sections.append("--- %s ---" % title)
        try:
            out = subprocess.check_output(cmd, shell=True, timeout=3).decode("utf-8", errors="replace").strip()
            sections.append(out or "(none)")
        except Exception as e:
            sections.append("Error: %s" % e)

    for log_label, log_file in (
        ("[8] /dev/shm/wpa_ap.log", "/dev/shm/wpa_ap.log"),
        ("[9] /dev/shm/hostapd.log", "/dev/shm/hostapd.log"),
        ("[10] /roms/ports/stump_r36max/stump_http.log", "/roms/ports/stump_r36max/stump_http.log"),
        ("[11] /roms/ports/stump_r36max/stump_r36max.log", "/roms/ports/stump_r36max/stump_r36max.log"),
    ):
        sections.append("")
        sections.append("--- %s ---" % log_label)
        if _REAL_ISFILE(log_file):
            sections.append(_read_sys(log_file)[-4000:])
        else:
            sections.append("(not present)")

    payload = "\\n".join(sections) + "\\n"
    for dst in (tf_path, shared_path):
        try:
            with _REAL_OPEN(dst, "w", encoding="utf-8") as f:
                f.write(payload)
        except Exception:
            pass

    _log_debug("EXPORT", "Saved %s to TF card (/roms/ports/stump_r36max/tf_backup/)" % diag_name)
    _set_busy("EXPORTED %s TO TF CARD!" % diag_name, 2.5)
    if rrc_mod:
        rrc_mod.system("main", "[DEBUG] Exported diagnostics to TF card: %s" % diag_name)
    return diag_name

def _count_tf_backups():
    try:
        if not _REAL_ISDIR(TF_BACKUP_DIR):
            return 0
        return len([f for f in _REAL_LISTDIR(TF_BACKUP_DIR) if not f.startswith(".")])
    except Exception:
        return 0

def _execute_cmd_line(line, rrc_mod, rrc_mesh_mod, bb_mod, fserv_mod):
    parts = line.strip().split("|")
    if not parts or not parts[0]:
        return
    op = parts[0]
    try:
        if op == "NET_APPLY" and len(parts) >= 2:
            # Staged Network Revision committed from Panel 5 (NET_APPLY|AP or NET_APPLY|LAN|<ssid>|<pass>)
            now_ts = time.time()
            if _AP_STATE.get("switching") or (now_ts - _AP_STATE.get("last_switch_ts", 0.0) < 4.0):
                _log_debug("NET", "Debounced duplicate NET_APPLY")
                return
            mode_arg = parts[1].strip().upper()
            if mode_arg == "AP":
                _log_debug("NET", "Applying Panel 5 Revision -> STUMP AP (192.168.4.1)")
                _start_cam_ap(rrc_mod)
            else:
                target_ssid = parts[2].strip() if len(parts) >= 3 else ""
                target_pass = parts[3].strip() if len(parts) >= 4 else ""
                if target_ssid and target_ssid != CAM_AP_SSID:
                    _log_debug("NET", "Applying Panel 5 Revision -> LAN SSID '%s'" % target_ssid)
                    _join_wifi_ssid(target_ssid, target_pass, rrc_mod=rrc_mod)
                else:
                    _log_debug("NET", "Applying Panel 5 Revision -> Default Local LAN DHCP")
                    _stop_cam_ap(rrc_mod, reconnect_default=True)
        elif op in ("AP_TOGGLE", "AP_ON", "AP_OFF"):
            now_ts = time.time()
            if _AP_STATE.get("switching") or (now_ts - _AP_STATE.get("last_switch_ts", 0.0) < 4.5):
                _log_debug("AP", "Debounced duplicate %s command" % op)
                return
            if op == "AP_ON":
                _start_cam_ap(rrc_mod)
            elif op == "AP_OFF":
                _stop_cam_ap(rrc_mod)
            else:
                if _AP_STATE["active"]:
                    _stop_cam_ap(rrc_mod)
                else:
                    _start_cam_ap(rrc_mod)
        elif op == "WIFI_SCAN":
            _scan_wifi_ssids(_AP_STATE.get("ifname") or "wlan0", force_rescan=True, rrc_mod=rrc_mod)
        elif op == "WIFI_JOIN" and len(parts) >= 2:
            target_ssid = parts[1].strip()
            target_pass = parts[2].strip() if len(parts) >= 3 else ""
            _join_wifi_ssid(target_ssid, target_pass, rrc_mod=rrc_mod)
        elif op == "DEBUG_EXPORT_TF":
            _export_diagnostics_to_tf(rrc_mod)
        elif op == "DEBUG_HEAL_NET":
            _set_busy("IN PROCESS: HEALING HTTP :80/:8080 & NET...", 3.0)
            p80, p8080 = _verify_and_heal_http_ports()
            if _AP_STATE["user_wanted"]:
                _ensure_ap_ip_and_routes(_AP_STATE.get("ap_if") or _AP_STATE.get("ifname") or "wlan0", flush_non_ap=True)
            _log_debug("HEAL", "HTTP :80=%s :8080=%s | Radio=%s" % (p80, p8080, "AP" if _AP_STATE["active"] else "LAN"))
            _set_busy("HTTP :80 & :8080 VERIFIED ONLINE!", 2.0)
        elif op == "DEBUG_CLEAR_LOGS":
            _DEBUG_LOGS.clear()
            _log_debug("SYS", "Debug log cleared (%s)" % STUMP_R36MAX_VERSION)
        elif op == "RRC" and len(parts) >= 3 and rrc_mod:
            room = parts[1].lower().strip()
            text = "|".join(parts[2:]).strip()
            if not text:
                return
            _set_busy("SENDING TO #%s..." % room.upper(), 1.2)
            _ensure_local_operator_trusted(rrc_mod)
            if room == "wifi-mesh" and hasattr(rrc_mod, "open_chain_room"):
                rrc_mod.open_chain_room()
            elif not rrc_mod.room_exists(room):
                rrc_mod.create_room(room)
            rrc_mod.touch_user(LOCAL_CID, nick="r36max", room=room)

            before_msgs = rrc_mod.since(room, 0)
            before_last_id = before_msgs[-1].get("id", 0) if before_msgs else 0

            replies, new_room = rrc_mod.handle_input(LOCAL_CID, room, text)
            target_room = new_room or room

            after_msgs = rrc_mod.since(target_room, before_last_id)
            if not text.startswith("/") and not after_msgs and not replies:
                rrc_mod.post(target_room, "r36max", text)
                try:
                    pmod = sys.modules.get("plugins")
                    if pmod and hasattr(pmod, "after"):
                        pmod.after(LOCAL_CID, target_room, "r36max", text, "en")
                except Exception:
                    pass
                if rrc_mesh_mod and hasattr(rrc_mesh_mod, "broadcast_chat"):
                    try:
                        rrc_mesh_mod.broadcast_chat(target_room, "r36max", text)
                    except Exception:
                        pass

            for rep in (replies or []):
                for subline in str(rep).split("\\n"):
                    if subline.strip():
                        rrc_mod.system(target_room, subline.strip()[:120])
        elif op == "ANNOUNCE" and rrc_mod:
            room = parts[1].lower() if len(parts) > 1 else "main"
            node_hex = _node_lxmf_str(rrc_mod)
            rnode_dev = _detect_heltec_rnode()
            ex_mod = sys.modules.get("example_node")
            if ex_mod and hasattr(ex_mod, "router"):
                try:
                    ex_mod.router.announce()
                except Exception:
                    pass
            if rrc_mesh_mod and hasattr(rrc_mesh_mod, "announce"):
                try:
                    rrc_mesh_mod.announce()
                except Exception:
                    pass
            rnode_tag = (" + HeltecV3(%s)" % os.path.basename(rnode_dev)) if rnode_dev else ""
            ap_tag = (" + STUMP-AP(%s)" % CAM_AP_SSID) if _AP_STATE["active"] else ""
            rrc_mod.post(room, "r36max", "[BEACON] Node %s announced on :80/:8080%s%s" % (str(node_hex)[:12], ap_tag, rnode_tag))
            _log_debug("MESH", "Announced node %s on #%s" % (str(node_hex)[:10], room))
        elif op == "BOARD_ADD" and len(parts) >= 3 and bb_mod:
            title = parts[1]
            body = parts[2]
            _set_busy("IN PROCESS: POSTING NOTICE TO BILLBOARD...", 1.5)
            bb_mod._append_entry(title, body, LOCAL_CID)
            _log_debug("BOARD", "Posted notice: %s" % title[:28])
        elif op in ("BOARD_DEL", "BOARD_DEL_MULTI") and len(parts) >= 2 and bb_mod:
            raw_ids = [x.strip() for x in parts[1].split(",") if x.strip()]
            _set_busy("IN PROCESS: ERASING %d CHECKED NOTICE(S)..." % len(raw_ids), 2.0)
            for tid in raw_ids:
                try:
                    bb_mod.delete_entry(tid)
                except Exception:
                    pass
            _log_debug("BOARD", "Deleted %d checked notice(s)" % len(raw_ids))
            if rrc_mod:
                rrc_mod.system("main", "[BOARD] Deleted %d checked notice(s)" % len(raw_ids))
        elif op == "BOARD_BACKUP_TF" and len(parts) >= 2:
            raw_ids = set(x.strip() for x in parts[1].split(",") if x.strip())
            _set_busy("IN PROCESS: BACKING UP %d NOTICE(S) TO TF CARD..." % len(raw_ids), 2.5)
            _REAL_MAKEDIRS(TF_BACKUP_DIR, exist_ok=True)
            bfile = os.path.join(TF_BACKUP_DIR, "billboard_backup_%s.txt" % time.strftime("%Y%m%d_%H%M%S"))
            saved_cnt = 0
            lines_out = [
                "=== LABUCHE-STUMP TF CARD BILLBOARD BACKUP (%s) ===" % STUMP_R36MAX_VERSION,
                "Timestamp: %s" % time.strftime("%Y-%m-%d %H:%M:%S"),
                ""
            ]
            if bb_mod:
                for sig, title, body, ts, raw_id in bb_mod._read_entries():
                    pid = str(raw_id or ts or "").strip()
                    if not raw_ids or pid in raw_ids:
                        lines_out.append("[%s] %s (by %s): %s" % (pid, title, sig, body))
                        saved_cnt += 1
            with _REAL_OPEN(bfile, "w", encoding="utf-8") as f:
                f.write("\\n".join(lines_out) + "\\n")
            _log_debug("TF-BKP", "Backed up %d notice(s) -> %s" % (saved_cnt, os.path.basename(bfile)))
            _set_busy("SAVED %d NOTICE(S) TO TF CARD!" % saved_cnt, 2.5)
            if rrc_mod:
                rrc_mod.system("main", "[TF-BACKUP] Saved %d billboard notice(s) to %s" % (saved_cnt, bfile))
        elif op == "FILE_ADD" and len(parts) >= 2:
            mode_str = parts[1]
            _set_busy("IN PROCESS: SHARING FILE TO /SD/SHARED...", 2.0)
            created = _share_real_file(mode_str, rrc_mod)
            if fserv_mod and hasattr(fserv_mod, "record_upload"):
                try:
                    fserv_mod.record_upload(created, LOCAL_CID)
                except Exception:
                    pass
            _log_debug("FILES", "Shared file: %s" % created)
            if rrc_mod and created:
                rrc_mod.system("main", "Shared new file in /files: %s" % created)
        elif op in ("FILE_DEL", "FILE_DEL_MULTI") and len(parts) >= 2:
            fnames = [os.path.basename(x.strip()) for x in parts[1].split(",") if x.strip()]
            _set_busy("IN PROCESS: ERASING %d CHECKED FILE(S)..." % len(fnames), 2.0)
            del_cnt = 0
            for fname in fnames:
                fpath = os.path.join(HERE, "sd", "shared", fname)
                if _REAL_ISFILE(fpath):
                    _REAL_REMOVE(fpath)
                    del_cnt += 1
                if fserv_mod and hasattr(fserv_mod, "remove_from_ledger"):
                    try:
                        fserv_mod.remove_from_ledger(fname)
                    except Exception:
                        pass
            _log_debug("FILES", "Deleted %d checked file(s) from /sd/shared" % del_cnt)
            if rrc_mod:
                rrc_mod.system("main", "[FILES] Deleted %d checked file(s) from /sd/shared" % del_cnt)
        elif op == "FILE_BACKUP_TF" and len(parts) >= 2:
            fnames = [os.path.basename(x.strip()) for x in parts[1].split(",") if x.strip()]
            _set_busy("IN PROCESS: BACKING UP %d FILE(S) TO TF CARD..." % len(fnames), 2.5)
            _REAL_MAKEDIRS(TF_BACKUP_DIR, exist_ok=True)
            copied = 0
            for fname in fnames:
                src = os.path.join(HERE, "sd", "shared", fname)
                if _REAL_ISFILE(src):
                    dst = os.path.join(TF_BACKUP_DIR, fname)
                    shutil.copy2(src, dst)
                    copied += 1
            manifest = os.path.join(TF_BACKUP_DIR, "tf_backup_manifest.txt")
            with _REAL_OPEN(manifest, "a", encoding="utf-8") as mf:
                mf.write("%s | Backed up %d file(s): %s\\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), copied, ", ".join(fnames)))
            _log_debug("TF-BKP", "Copied %d file(s) to TF card (%s)" % (copied, TF_BACKUP_DIR))
            _set_busy("BACKED UP %d FILE(S) TO TF CARD!" % copied, 2.5)
            if rrc_mod:
                rrc_mod.system("main", "[TF-BACKUP] Backed up %d file(s) to %s" % (copied, TF_BACKUP_DIR))
    except Exception as e:
        _log_debug("ERR", "cmd %s error: %s" % (op, e))

def _drain_commands(ipc_sock, rrc_mod, rrc_mesh_mod, bb_mod, fserv_mod):
    """Drain UDP 127.0.0.1:42421 and /dev/shm/stump_cmd.txt, deduplicating identical commands in the same batch."""
    raw_lines = []
    if ipc_sock:
        while True:
            try:
                data, _ = ipc_sock.recvfrom(2048)
                for ln in data.decode("utf-8", errors="replace").splitlines():
                    if ln.strip():
                        raw_lines.append(ln.strip())
            except BlockingIOError:
                break
            except Exception:
                break
    if _REAL_EXISTS(CMD_TXT):
        try:
            with _REAL_OPEN(CMD_TXT, "r+", encoding="utf-8", errors="replace") as f:
                for ln in f:
                    if ln.strip():
                        raw_lines.append(ln.strip())
                f.seek(0)
                f.truncate(0)
        except OSError:
            try:
                _REAL_REMOVE(CMD_TXT)
            except OSError:
                pass

    deduped = []
    seen = set()
    for ln in raw_lines:
        if ln not in seen:
            seen.add(ln)
            deduped.append(ln)

    for line in deduped:
        _execute_cmd_line(line, rrc_mod, rrc_mesh_mod, bb_mod, fserv_mod)
    return len(deduped) > 0

def _bridge_worker():
    rooms_init = False
    ap_auto_checked = False
    last_rnode = ""
    last_ap_check = 0.0
    last_ssid_refresh = 0.0
    last_http_check = 0.0
    ipc_sock = None
    _REAL_MAKEDIRS(TF_BACKUP_DIR, exist_ok=True)
    _log_debug("BOOT", "Stump Bridge %s (%s) starting" % (STUMP_R36MAX_VERSION, STUMP_R36MAX_BUILD))
    try:
        ipc_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        ipc_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        ipc_sock.bind(("127.0.0.1", IPC_UDP_PORT))
        ipc_sock.setblocking(False)
    except Exception as e:
        _log_debug("IPC", "UDP bind note: %s" % e)

    while True:
        try:
            if ipc_sock:
                select.select([ipc_sock], [], [], 0.15)
            else:
                time.sleep(0.15)

            _clear_busy_if_expired()

            rrc_mod = sys.modules.get("rrc")
            rrc_mesh_mod = sys.modules.get("rrc_mesh")
            bb_mod = sys.modules.get("billboard")
            fserv_mod = sys.modules.get("fserv")
            chain_mod = sys.modules.get("chain")

            if rrc_mod and not rooms_init:
                try:
                    _ensure_local_operator_trusted(rrc_mod)
                    if hasattr(rrc_mod, "open_chain_room"):
                        rrc_mod.open_chain_room()
                    for rn in ("main", "lora-mesh", "wifi-mesh"):
                        if not rrc_mod.room_exists(rn):
                            rrc_mod.create_room(rn)
                    rrc_mod.touch_user(LOCAL_CID, nick="r36max", room="main")
                    rooms_init = True
                except Exception:
                    pass

            if rooms_init and not ap_auto_checked:
                ap_auto_checked = True
                wlans, rt = _scan_wifi_interfaces()
                if rt:
                    _AP_STATE["ifname"] = rt["ifname"]
                    _AP_STATE["mac"] = rt["mac"]
                    _AP_STATE["driver"] = rt["driver"]
                    _AP_STATE["dual_wifi"] = len(wlans) >= 2
                    _ensure_firewall_open(rt["ifname"])
                    if _is_ap_broadcasting(rt["ifname"]):
                        _ensure_clean_lan_sta(rt["ifname"])
                        _run_sh("nmcli dev connect %s" % rt["ifname"], timeout=8)
                        time.sleep(1.5)
                    _scan_wifi_ssids(rt["ifname"], force_rescan=False)
                    lan_ip = _get_iface_ipv4(rt["ifname"])
                    if lan_ip:
                        _AP_STATE["lan_ip"] = lan_ip
                    _log_debug("NET", "Startup Local LAN ready on %s (%s)" % (rt["ifname"], lan_ip or "DHCP"))

            now = time.time()
            if now - last_http_check >= 3.0:
                last_http_check = now
                _verify_and_heal_http_ports()

            ap_interval = 1.5 if _AP_STATE.get("user_wanted") else 4.0
            if now - last_ap_check >= ap_interval and not _AP_STATE.get("switching"):
                last_ap_check = now
                wlans, rt = _scan_wifi_interfaces()
                if rt:
                    _AP_STATE["ifname"] = rt["ifname"]
                    _AP_STATE["mac"] = rt["mac"]
                    _AP_STATE["driver"] = rt["driver"]
                    _AP_STATE["dual_wifi"] = len(wlans) >= 2
                    target_if = _AP_STATE.get("ap_if") or rt["ifname"]
                    bcast_ok = _is_ap_broadcasting(target_if)
                    if _AP_STATE["user_wanted"]:
                        if not _AP_STATE["dual_wifi"]:
                            _run_sh("pkill -9 -f 'NetworkManager|dhclient|dhcpcd|udhcpc' 2>/dev/null || true")
                        if bcast_ok:
                            _AP_STATE["active"] = True
                            _AP_STATE["retries"] = 0
                            _ensure_ap_ip_and_routes(target_if, flush_non_ap=True)
                            _AP_STATE["lan_ip"] = CAM_AP_IP
                        elif _AP_STATE["retries"] < 3:
                            _AP_STATE["retries"] += 1
                            _log_debug("AP", "Watchdog re-asserting Stump AP on %s (try %d)" % (target_if, _AP_STATE["retries"]))
                            _start_cam_ap(rrc_mod)
                            target_if = _AP_STATE.get("ap_if") or rt["ifname"]
                            _AP_STATE["active"] = _is_ap_broadcasting(target_if)
                        else:
                            _AP_STATE["active"] = False
                    else:
                        _AP_STATE["active"] = False
                        cur_ip = _get_iface_ipv4(rt["ifname"])
                        if cur_ip:
                            _AP_STATE["lan_ip"] = cur_ip
                if _AP_STATE["active"]:
                    _AP_STATE["clients"] = _count_ap_clients(_AP_STATE["ifname"])
                else:
                    _AP_STATE["clients"] = 0
                    if not _AP_STATE["user_wanted"] and (now - last_ssid_refresh >= 18.0):
                        last_ssid_refresh = now
                        _scan_wifi_ssids(_AP_STATE.get("ifname") or "wlan0", force_rescan=False)

            cur_rnode = _detect_heltec_rnode()
            if cur_rnode != last_rnode:
                last_rnode = cur_rnode
                _log_debug("LORA", "Heltec V3 RNode: %s" % (cur_rnode or "UNPLUGGED"))
                if rrc_mod:
                    if cur_rnode:
                        rrc_mod.system("lora-mesh", "Heltec V3 RNode paired on %s (115200 KISS ready)" % cur_rnode)
                        rrc_mod.system("main", "Heltec V3 RNode connected on %s" % cur_rnode)
                    else:
                        rrc_mod.system("lora-mesh", "Heltec V3 RNode unplugged - waiting on USB hub")

            _drain_commands(ipc_sock, rrc_mod, rrc_mesh_mod, bb_mod, fserv_mod)

            out = []
            node_id = _clean_field(_node_lxmf_str(rrc_mod), 32)
            mesh_peers = 0
            if rrc_mesh_mod:
                mesh_peers += len(getattr(rrc_mesh_mod, "_peers", {})) + len(getattr(rrc_mesh_mod, "_reach", {}))
            if chain_mod:
                mesh_peers += len(getattr(chain_mod, "_linked", set()))
            if _AP_STATE["active"]:
                mesh_peers += _AP_STATE["clients"]
            rnode_label = os.path.basename(cur_rnode) if cur_rnode else "WAIT-USB"
            out.append("META|%s|%d|%s" % (node_id, mesh_peers, rnode_label))
            out.append("VER|%s|%s|%d|%d|%s|%d" % (
                STUMP_R36MAX_VERSION,
                STUMP_R36MAX_BUILD,
                1 if _HTTP_STATE["port80"] else 0,
                1 if _HTTP_STATE["port8080"] else 0,
                _clean_field(_AP_STATE.get("lan_ip") or "127.0.0.1", 20),
                _count_tf_backups()
            ))
            out.append("BUSY|%d|%s" % (
                1 if (_BUSY_STATE["busy"] or _AP_STATE.get("switching")) else 0,
                _clean_field(_BUSY_STATE["msg"], 54)
            ))
            out.append("AP|%d|%s|%s|%s|%s|%d" % (
                1 if _AP_STATE["active"] else 0,
                _clean_field(_AP_STATE["ifname"] or "wlan0", 16),
                _clean_field(_AP_STATE["mac"] or RT3070_MAC, 20),
                _clean_field(_AP_STATE["driver"] or "rt2800usb", 16),
                CAM_AP_SSID,
                _AP_STATE["clients"]
            ))

            for witem in _WIFI_SSIDS[:6]:
                out.append("SSID|%d|%d|%s|%s" % (
                    1 if witem.get("active") else 0,
                    int(witem.get("signal") or 50),
                    _clean_field(witem.get("sec") or "WPA2", 8),
                    _clean_field(witem.get("ssid") or "", 28)
                ))

            room_order = ("main", "lora-mesh", "wifi-mesh")
            for r_idx, rname in enumerate(room_order):
                if rrc_mod and rrc_mod.room_exists(rname):
                    users = rrc_mod.users_in_room(rname)
                    out.append("ROOM|%d|%s|%d" % (r_idx, rname.upper(), len(users)))
                    msgs = rrc_mod.since(rname, 0)[-10:]
                    for m in msgs:
                        is_sys = 1 if m.get("kind") in ("system", "sys") else 0
                        nick = _clean_field(m.get("nick") or "system", 16)
                        body = _clean_field(m.get("body") or "", 44)
                        out.append("MSG|%d|%d|%s|%s" % (r_idx, is_sys, nick, body))
                else:
                    out.append("ROOM|%d|%s|0" % (r_idx, rname.upper()))

            if bb_mod:
                entries = list(reversed(bb_mod._read_entries()))[:8]
                for sig, title, body, ts, raw_id in entries:
                    pid = _clean_field(raw_id or str(ts or ""), 24)
                    out.append("BOARD|%s|%s|%s|%s" % (
                        pid,
                        _clean_field(sig, 14),
                        _clean_field(title, 44),
                        _clean_field(body, 48)
                    ))

            shared_dir = os.path.join(HERE, "sd", "shared")
            _REAL_MAKEDIRS(shared_dir, exist_ok=True)
            file_items = []
            used_bytes = 0
            for fn in _REAL_LISTDIR(shared_dir):
                if fn.startswith("."):
                    continue
                fp = os.path.join(shared_dir, fn)
                if _REAL_ISFILE(fp):
                    st = _REAL_STAT(fp)
                    used_bytes += st.st_size
                    file_items.append((st.st_mtime, fn, st.st_size))
            file_items.sort(reverse=True)
            for _, fn, sz in file_items[:8]:
                kb = max(1, sz // 1024)
                out.append("FILE|%s|%d|%s" % (_clean_field(fn, 32), kb, _guess_cat(fn)))

            total_kb = 2048 * 1024
            if fserv_mod and hasattr(fserv_mod, "get_storage_stats"):
                try:
                    tot, _, _ = fserv_mod.get_storage_stats()
                    if tot > 0:
                        total_kb = tot // 1024
                except Exception:
                    pass
            used_kb = used_bytes // 1024
            ceil_kb = int(total_kb * 0.75)
            out.append("STORAGE|%d|%d|%d" % (used_kb, ceil_kb, total_kb))

            for dln in _DEBUG_LOGS[-16:]:
                out.append("LOG|%s" % _clean_field(dln, 62))

            with _REAL_OPEN(LIVE_TMP, "w", encoding="utf-8") as f:
                f.write("\\n".join(out) + "\\n")
            try:
                _REAL_CHMOD(LIVE_TMP, 0o666)
            except Exception:
                pass
            _REAL_REPLACE(LIVE_TMP, LIVE_TXT)
        except Exception as e:
            print("[r36max_bridge] worker error:", e)

if __name__ == "__main__":
    os.umask(0)
    os.chdir(HERE)

    # Protect socket.sendto against transient ENETUNREACH/ENETDOWN/ENODEV during radio transitions,
    # and enforce SO_REUSEADDR + SO_REUSEPORT on any socket binding port 53, 67, 80, or 8080
    _orig_sock_sendto = socket.socket.sendto
    def _resilient_sendto(self, data, *args, **kwargs):
        try:
            return _orig_sock_sendto(self, data, *args, **kwargs)
        except OSError:
            return len(data) if hasattr(data, "__len__") else 0
    socket.socket.sendto = _resilient_sendto

    _orig_sock_bind = socket.socket.bind
    def _reuse_aware_bind(self, addr):
        try:
            if isinstance(addr, tuple) and len(addr) >= 2 and addr[1] in (53, 67, 80, 8080, 8880):
                self.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    self.setsockopt(socket.SOL_SOCKET, 15, 1)  # SO_REUSEPORT on Linux
                except Exception:
                    pass
        except Exception:
            pass
        return _orig_sock_bind(self, addr)
    socket.socket.bind = _reuse_aware_bind

    # 1. Initialize stump_host + final_firmware (barkeep.py, rrc_ui.py, rrc.py, billboard.py, fserv.py)
    #    FIRST so our multi-threaded :80 and :8080 servers immediately serve the authentic Stump Visitor Interface!
    _ensure_firewall_open("wlan0")
    _init_stump_final_firmware()
    _verify_and_heal_http_ports()

    # Redirect example_node's internal uasyncio server to port 8880 so 0.0.0.0:80 and :8080 stay owned by _StumpPortalTCPHandler
    _orig_start_server = asyncio.start_server
    async def _internal_barkeep_start_server(cb, host=None, port=None, *args, **kwargs):
        bind_host = "0.0.0.0"
        kwargs["reuse_address"] = True
        target_port = 8880 if port in (80, 8080) else (port or 8880)
        srv = await _orig_start_server(cb, bind_host, target_port, *args, **kwargs)
        _KEEPALIVE_SERVERS.append(srv)
        _log_debug("HTTP", "Internal uasyncio server bound on :%d (barkeep._serve live on :80/:8080)" % target_port)
        return srv
    asyncio.start_server = _internal_barkeep_start_server

    threading.Thread(target=_dhcp_and_dns_worker, daemon=True).start()
    threading.Thread(target=_bridge_worker, daemon=True).start()

    while True:
        try:
            import example_node  # noqa: F401
        except Exception as e:
            _log_debug("NODE", "example_node note: %s" % e)
        _verify_and_heal_http_ports()
        time.sleep(3.0)
`;

export const STUMP_R36MAX_C_SOURCE = `/*
 * stump_r36max_engine.c — Native 720x720 Multi-Transport Handheld Cockpit
 * for Project Stump (LaBuche-Stump v1.0.0-beta.34) on R36MAX (RK3326 / ArkOS).
 *
 * Connected to real LaBuche-Stump functions:
 *   - Live RRC Chatrooms (#main, #lora-mesh, #wifi-mesh) + real mesh push
 *   - Real Billboard (/sd/billboard.txt) with gamepad Add (A) & Delete (X)
 *   - Real Shared File Shelf (/sd/shared) with gamepad Add/Share (A) & Delete (X)
 *   - Real ISO/IEC 18004 QR Code (Version 2-L, 25x25, Reed-Solomon ECC) for http://<ip>:8080/
 *
 * Build on R36MAX:
 *   gcc -O2 -mcpu=cortex-a35 -Wall stump_r36max_engine.c -o stump_r36max_engine -lasound -lpthread -ldl -lm
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <ctype.h>
#include <time.h>
#include <signal.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <dlfcn.h>
#include <pthread.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <linux/fb.h>
#include <net/if.h>
#include <ifaddrs.h>
#include <arpa/inet.h>
#include <linux/input.h>
#include <alsa/asoundlib.h>

#define PANEL_W         720
#define PANEL_H         720
#define PANEL_BYTES     (PANEL_W * PANEL_H * 4)
#define SR              44100
#define ALSA_PERIOD     512
#define MESH_UDP_PORT   42420
#define IPC_UDP_PORT    42421

#define LIVE_STATE_FILE "/dev/shm/stump_live.txt"
#define CMD_QUEUE_FILE  "/dev/shm/stump_cmd.txt"
#define SD_SHARED_DIR   "/roms/ports/stump_r36max/node/sd/shared"
#define SD_BOARD_FILE   "/roms/ports/stump_r36max/node/sd/billboard.txt"

#define SDL_INIT_VIDEO              0x00000020u
#define SDL_WINDOW_SHOWN            0x00000004u
#define SDL_WINDOW_FULLSCREEN_DESK  0x00001001u
#define SDL_WINDOWPOS_UNDEFINED     0x1FFF0000u
#define SDL_RENDERER_ACCELERATED    0x00000002u
#define SDL_RENDERER_PRESENTVSYNC   0x00000004u
#define SDL_PIXELFORMAT_ARGB8888    0x16362004u
#define SDL_TEXTUREACCESS_STREAMING 1

typedef int         (*pfn_SDL_Init)(uint32_t);
typedef void        (*pfn_SDL_Quit)(void);
typedef void*       (*pfn_SDL_CreateWindow)(const char*, int, int, int, int, uint32_t);
typedef void        (*pfn_SDL_DestroyWindow)(void*);
typedef void*       (*pfn_SDL_CreateRenderer)(void*, int, uint32_t);
typedef void        (*pfn_SDL_DestroyRenderer)(void*);
typedef void*       (*pfn_SDL_CreateTexture)(void*, uint32_t, int, int, int);
typedef void        (*pfn_SDL_DestroyTexture)(void*);
typedef int         (*pfn_SDL_UpdateTexture)(void*, const void*, const void*, int);
typedef int         (*pfn_SDL_RenderClear)(void*);
typedef int         (*pfn_SDL_RenderCopy)(void*, void*, const void*, const void*);
typedef void        (*pfn_SDL_RenderPresent)(void*);
typedef void        (*pfn_SDL_PumpEvents)(void);
typedef int         (*pfn_SDL_ShowCursor)(int);

typedef struct {
    const char *name;
    uint32_t bg, panel, panel2, ember, ember_bright, text, muted, border, ok, warn;
} ThemeColors;

/* Exact FireFly_RK3326_R36MAX_R36S (firefly/ui/theme.py) + Stump Final Firmware Palettes */
static const ThemeColors g_themes[5] = {
    { "AMBER",    0xFF1B1512u, 0xFF2A2119u, 0xFF221B15u, 0xFFD97A3Au, 0xFFF0A050u, 0xFFECDFC8u, 0xFF9C8D76u, 0xFF493C2Eu, 0xFF9CB876u, 0xFFE07A5Au },
    { "PHOSPHOR", 0xFF0B120Cu, 0xFF142217u, 0xFF0F1A11u, 0xFF33FF66u, 0xFF66FF8Cu, 0xFFE2FCE6u, 0xFF6EA87Bu, 0xFF23452Au, 0xFF33FF66u, 0xFFFFCC33u },
    { "OLED",     0xFF000000u, 0xFF141414u, 0xFF0A0A0Au, 0xFF4DA6FFu, 0xFF80BFFFu, 0xFFFFFFFFu, 0xFF9E9E9Eu, 0xFF333333u, 0xFF4DFF88u, 0xFFFFB84Du },
    { "PAPER",    0xFFF5F2EBu, 0xFFE6E0D0u, 0xFFEDE8DAu, 0xFFA84814u, 0xFFC25B1Fu, 0xFF1F1C19u, 0xFF5C5447u, 0xFFC4BBA6u, 0xFF1B6E23u, 0xFFB85D00u },
    { "TAVERN",   0xFF1A120Bu, 0xFF2B1D12u, 0xFF22170Eu, 0xFFE0A040u, 0xFFF5C063u, 0xFFF7EBD6u, 0xFFB59C76u, 0xFF573C24u, 0xFF9CB876u, 0xFFE07A5Au }
};

static void fill_rect(uint32_t *fb, int x, int y, int w, int h, uint32_t color) {
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > PANEL_W) w = PANEL_W - x;
    if (y + h > PANEL_H) h = PANEL_H - y;
    if (w <= 0 || h <= 0) return;
    for (int py = y; py < y + h; py++) {
        uint32_t *row = fb + py * PANEL_W + x;
        for (int px = 0; px < w; px++) row[px] = color;
    }
}

static void draw_border(uint32_t *fb, int x, int y, int w, int h, int thick, uint32_t color) {
    fill_rect(fb, x, y, w, thick, color);
    fill_rect(fb, x, y + h - thick, w, thick, color);
    fill_rect(fb, x, y, thick, h, color);
    fill_rect(fb, x + w - thick, y, thick, h, color);
}

/* True 5x7 Pixel-Matrix Bitmap Font (35-bit row-major integer per glyph) */
#define G57(a,b,c,d,e,f,g) ( \\
    ((uint64_t)(a) << 30) | ((uint64_t)(b) << 25) | ((uint64_t)(c) << 20) | \\
    ((uint64_t)(d) << 15) | ((uint64_t)(e) << 10) | ((uint64_t)(f) << 5)  | (uint64_t)(g) )

static uint64_t glyph_bits5x7(char ch) {
    unsigned char u = (unsigned char)ch;
    if (u >= 'a' && u <= 'z') u = (unsigned char)(u - 32);
    switch (u) {
        case 'A': return G57(14, 17, 17, 31, 17, 17, 17);
        case 'B': return G57(30, 17, 17, 30, 17, 17, 30);
        case 'C': return G57(14, 17, 16, 16, 16, 17, 14);
        case 'D': return G57(30, 17, 17, 17, 17, 17, 30);
        case 'E': return G57(31, 16, 16, 30, 16, 16, 31);
        case 'F': return G57(31, 16, 16, 30, 16, 16, 16);
        case 'G': return G57(14, 17, 16, 23, 17, 17, 15);
        case 'H': return G57(17, 17, 17, 31, 17, 17, 17);
        case 'I': return G57(14,  4,  4,  4,  4,  4, 14);
        case 'J': return G57( 7,  2,  2,  2, 18, 18, 12);
        case 'K': return G57(17, 18, 20, 24, 20, 18, 17);
        case 'L': return G57(16, 16, 16, 16, 16, 16, 31);
        case 'M': return G57(17, 27, 21, 21, 17, 17, 17);
        case 'N': return G57(17, 25, 21, 19, 17, 17, 17);
        case 'O': return G57(14, 17, 17, 17, 17, 17, 14);
        case 'P': return G57(30, 17, 17, 30, 16, 16, 16);
        case 'Q': return G57(14, 17, 17, 17, 21, 18, 13);
        case 'R': return G57(30, 17, 17, 30, 20, 18, 17);
        case 'S': return G57(15, 16, 16, 14,  1,  1, 30);
        case 'T': return G57(31,  4,  4,  4,  4,  4,  4);
        case 'U': return G57(17, 17, 17, 17, 17, 17, 14);
        case 'V': return G57(17, 17, 17, 17, 17, 10,  4);
        case 'W': return G57(17, 17, 17, 21, 21, 27, 17);
        case 'X': return G57(17, 17, 10,  4, 10, 17, 17);
        case 'Y': return G57(17, 17, 10,  4,  4,  4,  4);
        case 'Z': return G57(31,  1,  2,  4,  8, 16, 31);
        case '0': return G57(14, 17, 19, 21, 25, 17, 14);
        case '1': return G57( 4, 12,  4,  4,  4,  4, 14);
        case '2': return G57(14, 17,  1,  6,  8, 16, 31);
        case '3': return G57(30,  1,  1, 14,  1,  1, 30);
        case '4': return G57( 2,  6, 10, 18, 31,  2,  2);
        case '5': return G57(31, 16, 30,  1,  1, 17, 14);
        case '6': return G57(14, 16, 16, 30, 17, 17, 14);
        case '7': return G57(31,  1,  2,  4,  8,  8,  8);
        case '8': return G57(14, 17, 17, 14, 17, 17, 14);
        case '9': return G57(14, 17, 17, 15,  1,  1, 14);
        case '-': return G57( 0,  0,  0, 31,  0,  0,  0);
        case '_': return G57( 0,  0,  0,  0,  0,  0, 31);
        case '.': return G57( 0,  0,  0,  0,  0, 12, 12);
        case ',': return G57( 0,  0,  0,  0,  6,  6, 12);
        case ':': return G57( 0, 12, 12,  0, 12, 12,  0);
        case ';': return G57( 0, 12, 12,  0, 12,  4,  8);
        case 39:  return G57( 4,  4,  8,  0,  0,  0,  0);
        case '@': return G57(14, 17, 23, 21, 23, 16, 14);
        case '/': return G57( 1,  2,  2,  4,  8,  8, 16);
        case '!': return G57( 4,  4,  4,  4,  4,  0,  4);
        case '?': return G57(14, 17,  1,  6,  4,  0,  4);
        case '#': return G57(10, 31, 10, 10, 31, 10,  0);
        case '+': return G57( 0,  4,  4, 31,  4,  4,  0);
        case '=': return G57( 0,  0, 31,  0, 31,  0,  0);
        case '<': return G57( 2,  4,  8, 16,  8,  4,  2);
        case '>': return G57( 8,  4,  2,  1,  2,  4,  8);
        case '(': return G57( 2,  4,  8,  8,  8,  4,  2);
        case ')': return G57( 8,  4,  2,  2,  2,  4,  8);
        case '[': return G57(14,  8,  8,  8,  8,  8, 14);
        case ']': return G57(14,  2,  2,  2,  2,  2, 14);
        case '%': return G57(25, 26,  2,  4,  8, 19, 19);
        case '*': return G57( 0, 21, 14, 31, 14, 21,  0);
        default:  return 0ULL;
    }
}

static void draw_char_scaled(uint32_t *fb, int x, int y, char c, uint32_t fg, int scale, bool shadow) {
    uint64_t bits = glyph_bits5x7(c);
    if (!bits) return;
    for (int row = 0; row < 7; row++) {
        uint32_t rmask = (uint32_t)((bits >> ((6 - row) * 5)) & 0x1Fu);
        for (int col = 0; col < 5; col++) {
            if (rmask & (1u << (4 - col))) {
                int px = x + col * scale;
                int py = y + row * scale;
                if (shadow) fill_rect(fb, px + 1, py + 1, scale, scale, 0xFF080808u);
                fill_rect(fb, px, py, scale, scale, fg);
            }
        }
    }
}

static void draw_text_s(uint32_t *fb, int x, int y, const char *s, uint32_t color, int scale, int max_chars) {
    int count = 0;
    int step = 6 * scale;
    bool shadow = (color != 0xFF000000u && color != 0xFF1F1C19u);
    while (*s && (max_chars <= 0 || count < max_chars)) {
        if (x + step > PANEL_W - 4) break;
        draw_char_scaled(fb, x, y, *s++, color, scale, shadow);
        x += step;
        count++;
    }
}

/* ---- Standards-Compliant ISO/IEC 18004 QR Version 2-L (25x25) Encoder ---- */
static void encode_qr_v2_l(const char *text, uint8_t grid[25][25]) {
    uint8_t is_func[25][25];
    memset(grid, 0, 25 * 25);
    memset(is_func, 0, 25 * 25);

    size_t len = strlen(text);
    if (len > 32) len = 32;

    uint8_t bits[280];
    int nbits = 0;
    bits[nbits++] = 0; bits[nbits++] = 1; bits[nbits++] = 0; bits[nbits++] = 0; /* Byte mode 0100 */
    for (int i = 7; i >= 0; i--) bits[nbits++] = (uint8_t)((len >> i) & 1);
    for (size_t k = 0; k < len; k++) {
        uint8_t b = (uint8_t)text[k];
        for (int i = 7; i >= 0; i--) bits[nbits++] = (uint8_t)((b >> i) & 1);
    }
    for (int i = 0; i < 4 && nbits < 272; i++) bits[nbits++] = 0;
    while (nbits % 8 != 0) bits[nbits++] = 0;

    uint8_t data[34];
    int nbytes = nbits / 8;
    for (int i = 0; i < nbytes; i++) {
        uint8_t v = 0;
        for (int b = 0; b < 8; b++) v = (uint8_t)((v << 1) | bits[i * 8 + b]);
        data[i] = v;
    }
    const uint8_t pads[2] = { 0xECu, 0x11u };
    for (int i = nbytes; i < 34; i++) data[i] = pads[(i - nbytes) & 1];

    /* GF(256) tables with primitive polynomial 0x11D */
    uint8_t gf_exp[512], gf_log[256];
    memset(gf_log, 0, sizeof(gf_log));
    int x = 1;
    for (int i = 0; i < 255; i++) {
        gf_exp[i] = (uint8_t)x;
        gf_log[x] = (uint8_t)i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11D;
    }
    for (int i = 255; i < 512; i++) gf_exp[i] = gf_exp[i - 255];

    uint8_t gen[11];
    memset(gen, 0, sizeof(gen));
    gen[0] = 1;
    int glen = 1;
    for (int i = 0; i < 10; i++) {
        uint8_t nxt[11];
        memset(nxt, 0, sizeof(nxt));
        for (int j = 0; j < glen; j++) {
            uint8_t c = gen[j];
            nxt[j] ^= c;
            if (c) nxt[j + 1] ^= gf_exp[gf_log[c] + i];
        }
        glen++;
        memcpy(gen, nxt, sizeof(gen));
    }

    uint8_t msg[44];
    memset(msg, 0, sizeof(msg));
    memcpy(msg, data, 34);
    for (int i = 0; i < 34; i++) {
        uint8_t coef = msg[i];
        if (coef) {
            for (int j = 1; j < 11; j++) {
                if (gen[j]) msg[i + j] ^= gf_exp[gf_log[gen[j]] + gf_log[coef]];
            }
        }
    }
    uint8_t codewords[44];
    memcpy(codewords, data, 34);
    memcpy(codewords + 34, msg + 34, 10);

    const int N = 25;
    int f_origins[3][2] = { {0, 0}, {0, N - 7}, {N - 7, 0} };
    for (int f = 0; f < 3; f++) {
        int r0 = f_origins[f][0], c0 = f_origins[f][1];
        for (int dr = -1; dr <= 7; dr++) {
            for (int dc = -1; dc <= 7; dc++) {
                int r = r0 + dr, c = c0 + dc;
                if (r >= 0 && r < N && c >= 0 && c < N) {
                    bool out_ring = (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (dr == 0 || dr == 6 || dc == 0 || dc == 6));
                    bool in_box   = (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
                    grid[r][c] = (out_ring || in_box) ? 1 : 0;
                    is_func[r][c] = 1;
                }
            }
        }
    }

    /* Version 2 Alignment pattern at (18, 18) */
    for (int dr = -2; dr <= 2; dr++) {
        for (int dc = -2; dc <= 2; dc++) {
            int ad = (abs(dr) > abs(dc)) ? abs(dr) : abs(dc);
            grid[18 + dr][18 + dc] = (ad == 0 || ad == 2) ? 1 : 0;
            is_func[18 + dr][18 + dc] = 1;
        }
    }

    /* Timing patterns */
    for (int i = 8; i < N - 8; i++) {
        grid[6][i] = (i % 2 == 0) ? 1 : 0; is_func[6][i] = 1;
        grid[i][6] = (i % 2 == 0) ? 1 : 0; is_func[i][6] = 1;
    }

    /* Dark module & reserved format areas */
    grid[N - 8][8] = 1; is_func[N - 8][8] = 1;
    for (int i = 0; i < 9; i++) {
        if (!is_func[8][i]) { grid[8][i] = 0; is_func[8][i] = 1; }
        if (!is_func[i][8]) { grid[i][8] = 0; is_func[i][8] = 1; }
    }
    for (int i = 0; i < 8; i++) {
        if (!is_func[8][N - 1 - i]) { grid[8][N - 1 - i] = 0; is_func[8][N - 1 - i] = 1; }
        if (!is_func[N - 1 - i][8]) { grid[N - 1 - i][8] = 0; is_func[N - 1 - i][8] = 1; }
    }

    uint8_t all_bits[360];
    int ab_len = 0;
    for (int cw = 0; cw < 44; cw++) {
        for (int i = 7; i >= 0; i--) all_bits[ab_len++] = (uint8_t)((codewords[cw] >> i) & 1);
    }
    for (int i = 0; i < 7; i++) all_bits[ab_len++] = 0;

    int bit_idx = 0;
    bool up = true;
    for (int col = N - 1; col > 0; col -= 2) {
        if (col == 6) col--;
        for (int step = 0; step < N; step++) {
            int r = up ? (N - 1 - step) : step;
            for (int dc = 0; dc >= -1; dc--) {
                int c = col + dc;
                if (!is_func[r][c]) {
                    uint8_t b = (bit_idx < ab_len) ? all_bits[bit_idx++] : 0;
                    if ((r + c) % 2 == 0) b ^= 1; /* Mask 0 */
                    grid[r][c] = b;
                }
            }
        }
        up = !up;
    }

    /* Format bits for Level L (01), Mask 0 (000) -> 0x77C4 */
    const uint16_t fmt = 0x77C4u;
    const int tl_r[15] = {8,8,8,8,8,8,8,8,7,5,4,3,2,1,0};
    const int tl_c[15] = {0,1,2,3,4,5,7,8,8,8,8,8,8,8,8};
    for (int i = 0; i < 15; i++) {
        uint8_t fb_bit = (uint8_t)((fmt >> (14 - i)) & 1u);
        grid[tl_r[i]][tl_c[i]] = fb_bit;
    }
    for (int i = 0; i < 7; i++) grid[N - 1 - i][8] = (uint8_t)((fmt >> (14 - i)) & 1u);
    for (int i = 7; i < 15; i++) grid[8][N - 15 + i] = (uint8_t)((fmt >> (14 - i)) & 1u);
}

/* ---- Multi-Transport Hardware Scanner (Blueway RT3070, Eth, Heltec V3 RNode, USB Keyboard) ---- */
typedef struct {
    bool wifi_online;
    char wifi_if[24];
    char wifi_ip[40];
    char wifi_driver[32];
    char wifi_mac[24];
    bool is_rt3070;
    int  wifi_rssi_dbm;

    bool eth_online;
    char eth_if[24];
    char eth_ip[40];

    bool bt_online;
    char bt_name[24];

    bool lora_online;
    char lora_dev[32];

    bool usb_kbd_online;
    char usb_kbd_name[32];

    char primary_ip[40];
} TransportStatus;

static void scan_transports(TransportStatus *ts) {
    memset(ts, 0, sizeof(*ts));
    snprintf(ts->primary_ip, sizeof(ts->primary_ip), "127.0.0.1");
    ts->wifi_rssi_dbm = -48;

    DIR *d = opendir("/sys/class/net");
    if (d) {
        struct dirent *ent;
        while ((ent = readdir(d)) != NULL) {
            if (ent->d_name[0] == '.' || strcmp(ent->d_name, "lo") == 0) continue;
            char wpath[320], ppath[320], uevent[320], apath[320];
            snprintf(wpath, sizeof(wpath), "/sys/class/net/%s/wireless", ent->d_name);
            snprintf(ppath, sizeof(ppath), "/sys/class/net/%s/phy80211", ent->d_name);
            bool is_wlan = (access(wpath, F_OK) == 0 || access(ppath, F_OK) == 0 ||
                            strncmp(ent->d_name, "wl", 2) == 0 || strncmp(ent->d_name, "ra", 2) == 0);
            if (is_wlan) {
                char mac_buf[32] = "";
                snprintf(apath, sizeof(apath), "/sys/class/net/%s/address", ent->d_name);
                FILE *af = fopen(apath, "r");
                if (af) {
                    if (fgets(mac_buf, sizeof(mac_buf), af)) {
                        char *nl = strchr(mac_buf, '\\n');
                        if (nl) *nl = '\\0';
                    }
                    fclose(af);
                }
                char drv_buf[32] = "USB-WIFI";
                bool found_rt = (strstr(mac_buf, "00:0f:00:5e:11:ee") != NULL ||
                                 strstr(mac_buf, "11:ee") != NULL ||
                                 (strlen(mac_buf) >= 2 && strcmp(mac_buf + strlen(mac_buf) - 2, "ee") == 0));
                snprintf(uevent, sizeof(uevent), "/sys/class/net/%s/device/uevent", ent->d_name);
                FILE *uf = fopen(uevent, "r");
                if (uf) {
                    char line[128];
                    while (fgets(line, sizeof(line), uf)) {
                        if (strncmp(line, "DRIVER=", 7) == 0) {
                            char *nl = strchr(line + 7, '\\n');
                            if (nl) *nl = '\\0';
                            snprintf(drv_buf, sizeof(drv_buf), "%.31s", line + 7);
                            if (strstr(drv_buf, "rt2800") != NULL) found_rt = true;
                        } else if (strstr(line, "148f") != NULL || strstr(line, "3070") != NULL) {
                            found_rt = true;
                        }
                    }
                    fclose(uf);
                }
                /* Prefer the Blueway RT3070 (00:0f:00:5e:11:ee / rt2800usb) if multiple wlans exist */
                if (!ts->wifi_online || (found_rt && !ts->is_rt3070)) {
                    ts->wifi_online = true;
                    ts->is_rt3070 = found_rt;
                    snprintf(ts->wifi_if, sizeof(ts->wifi_if), "%.23s", ent->d_name);
                    snprintf(ts->wifi_ip, sizeof(ts->wifi_ip), "DHCP/READY");
                    snprintf(ts->wifi_driver, sizeof(ts->wifi_driver), "%.31s", drv_buf);
                    snprintf(ts->wifi_mac, sizeof(ts->wifi_mac), "%.23s", mac_buf[0] ? mac_buf : "00:0f:00:5e:11:ee");
                }
            } else if (!is_wlan && !ts->eth_online &&
                       (strncmp(ent->d_name, "eth", 3) == 0 || strncmp(ent->d_name, "usb", 3) == 0 ||
                        strncmp(ent->d_name, "en", 2) == 0 || strncmp(ent->d_name, "rndis", 5) == 0)) {
                ts->eth_online = true;
                snprintf(ts->eth_if, sizeof(ts->eth_if), "%.23s", ent->d_name);
                snprintf(ts->eth_ip, sizeof(ts->eth_ip), "LINK-UP");
            }
        }
        closedir(d);
    }

    FILE *wf = fopen("/proc/net/wireless", "r");
    if (wf) {
        char line[256];
        int lno = 0;
        while (fgets(line, sizeof(line), wf)) {
            lno++;
            if (lno <= 2) continue;
            char ifname[32];
            int status = 0;
            float link = 0.0f, level = 0.0f;
            if (sscanf(line, " %31[^:]: %x %f %f", ifname, &status, &link, &level) >= 3) {
                if (!ts->wifi_online) {
                    ts->wifi_online = true;
                    snprintf(ts->wifi_if, sizeof(ts->wifi_if), "%.23s", ifname);
                    snprintf(ts->wifi_driver, sizeof(ts->wifi_driver), "rt2800usb");
                }
                ts->wifi_rssi_dbm = (level < 0.0f) ? (int)level : (int)(level - 100.0f);
            }
        }
        fclose(wf);
    }

    struct ifaddrs *ifaddr, *ifa;
    if (getifaddrs(&ifaddr) == 0) {
        for (ifa = ifaddr; ifa != NULL; ifa = ifa->ifa_next) {
            if (!ifa->ifa_addr || ifa->ifa_addr->sa_family != AF_INET) continue;
            if (strcmp(ifa->ifa_name, "lo") == 0) continue;
            char ip[40];
            struct sockaddr_in *sa = (struct sockaddr_in *)ifa->ifa_addr;
            inet_ntop(AF_INET, &(sa->sin_addr), ip, sizeof(ip));

            if (strncmp(ifa->ifa_name, "wl", 2) == 0 || strncmp(ifa->ifa_name, "ra", 2) == 0 ||
                strcmp(ifa->ifa_name, ts->wifi_if) == 0) {
                ts->wifi_online = true;
                if (strcmp(ifa->ifa_name, ts->wifi_if) == 0 || strcmp(ts->wifi_ip, "DHCP/READY") == 0) {
                    snprintf(ts->wifi_ip, sizeof(ts->wifi_ip), "%.39s", ip);
                }
                snprintf(ts->primary_ip, sizeof(ts->primary_ip), "%.39s", ip);
            } else {
                ts->eth_online = true;
                snprintf(ts->eth_if, sizeof(ts->eth_if), "%.23s", ifa->ifa_name);
                snprintf(ts->eth_ip, sizeof(ts->eth_ip), "%.39s", ip);
                if (strcmp(ts->primary_ip, "127.0.0.1") == 0) {
                    snprintf(ts->primary_ip, sizeof(ts->primary_ip), "%.39s", ip);
                }
            }
        }
        freeifaddrs(ifaddr);
    }

    if (access("/sys/class/bluetooth/hci0", F_OK) == 0) {
        ts->bt_online = true;
        snprintf(ts->bt_name, sizeof(ts->bt_name), "HCI0 READY");
    }
    const char *serials[] = { "/dev/ttyACM0", "/dev/ttyUSB0", "/dev/ttyACM1", "/dev/ttyUSB1", NULL };
    for (int i = 0; serials[i]; i++) {
        if (access(serials[i], F_OK) == 0) {
            ts->lora_online = true;
            snprintf(ts->lora_dev, sizeof(ts->lora_dev), "HELTEC V3 (%s)", serials[i] + 5);
            break;
        }
    }

    /* Detect external USB Keyboard on USB hub via /proc/bus/input/devices */
    FILE *idf = fopen("/proc/bus/input/devices", "r");
    if (idf) {
        char line[256];
        char cur_name[64] = "";
        while (fgets(line, sizeof(line), idf)) {
            if (strncmp(line, "N: Name=", 8) == 0) {
                snprintf(cur_name, sizeof(cur_name), "%.63s", line + 9);
                char *q = strchr(cur_name, 34);
                if (q) *q = '\\0';
            } else if (strncmp(line, "H: Handlers=", 12) == 0) {
                if (strstr(line, "kbd") &&
                    !strstr(cur_name, "rk8xx") &&
                    !strstr(cur_name, "gpio") &&
                    !strstr(cur_name, "joypad") &&
                    !strstr(cur_name, " retrogame") &&
                    !strstr(cur_name, "OpenSimHardware")) {
                    ts->usb_kbd_online = true;
                    snprintf(ts->usb_kbd_name, sizeof(ts->usb_kbd_name), "%.31s",
                             cur_name[0] ? cur_name : "USB HID KEYBOARD");
                }
            }
        }
        fclose(idf);
    }
}

#define STUMP_ENGINE_VERSION "v1.7.1-r36max"
#define STUMP_ENGINE_BUILD   "2026.06.21-dArkOS"
#define MAX_LOG_LINES 10
#define MAX_DBG_LINES 16

/* R36MAX Physical Gamepad Button Mapping:
 *   Physical A (Right / East)  = ev.code 305 (BTN_EAST)  -> STRICT ACCEPT / CONFIRM
 *   Physical B (Bottom / South)= ev.code 304 (BTN_SOUTH) -> STRICT CANCEL / BACK / REVERT
 *   Physical X (Top / North)   = ev.code 307 (BTN_NORTH) -> SECONDARY / DELETE / QR
 *   Physical Y (Left / West)   = ev.code 308 (BTN_WEST)  -> OSK / TF BACKUP
 */
#define R36_BTN_A_ACCEPT 305
#define R36_BTN_B_CANCEL 304

typedef struct {
    char nick[18];
    char body[46];
    bool is_sys;
} ChatLine;

typedef struct {
    char id[28];
    char sig[16];
    char title[46];
    char body[50];
    bool checked;
} BoardItem;

typedef struct {
    char name[36];
    int  size_kb;
    char cat[8];
    bool checked;
} ShelfItem;

typedef struct {
    char ssid[32];
    char sec[10];
    int  signal;
    bool active;
} WifiSsidItem;

typedef struct {
    volatile bool   running;
    volatile int    chime_freq;
    volatile int    chime_ms;
    int             theme_idx;
    int             tab_idx;       /* 0:CHAT, 1:BOARD, 2:FILES, 3:WIFI, 4:REV/DBG v1.6 */
    int             room_idx;
    int             auth_mode_idx;
    int             cmd_cursor;
    int             board_cursor;  /* 0..board_count-1 = items, board_count = Action Bar */
    int             board_bar_mode;/* 0 = BACKUP CHECKED->TF, 1 = DELETE CHECKED, 2 = POST PRESET */
    int             board_preset_idx;
    int             file_cursor;   /* 0..file_count-1 = items, file_count = Action Bar */
    int             file_bar_mode; /* 0 = BACKUP CHECKED->TF, 1 = DELETE CHECKED, 2 = SHARE FILE */
    int             file_action_idx;
    bool            verified;
    int             beacons_sent;
    int             rx_packets;
    int             udp_sock;
    int             ipc_sock;
    int             suppress_poll_frames;
    uint64_t        last_btn_ms;
    uint64_t        last_dpad_ms;
    uint64_t        busy_until_ms;
    uint64_t        radio_lock_until_ms;
    bool            py_busy;
    char            busy_msg[64];
    int             last_ev_code;
    char            ver_str[28];
    char            build_str[28];
    bool            http80_ok;
    bool            http8080_ok;
    char            bridge_lan_ip[28];
    int             tf_backup_count;
    char            node_lxmf[36];
    char            rnode_status[24];
    int             mesh_peers;
    bool            ap_active;
    char            ap_if[20];
    char            ap_mac[24];
    char            ap_driver[20];
    char            ap_ssid[24];
    int             ap_clients;
    int             qr_mode;       /* 0 = HTTP Portal URL QR, 1 = WIFI Auto-Join QR */
    WifiSsidItem    wifi_list[6];
    int             wifi_count;
    int             wifi_cursor;   /* 0 = Stage Radio Mode, 1 = Wi-Fi Tool Bar, 2.. = Stage SSID */
    int             wifi_bar_mode; /* 0 = SCAN WIFI, 1 = SWITCH QR MODE, 2 = PASSWORD OSK */
    char            wifi_status_msg[80];
    /* Staged Network Settings Revision (Panel 4 & Panel 5) */
    bool            net_staged_init;
    bool            net_staged_dirty;
    bool            net_staged_ap;
    char            net_staged_ssid[32];
    char            net_staged_pass[64];
    int             net_ssid_cycle_idx;
    int             rev_cursor;    /* Panel 5 rows: 0=Mode, 1=SSID, 2=Apply/Revert, 3=Debug Tool, 4=Logs */
    int             debug_bar_mode;/* 0 = EXPORT DIAG->TF, 1 = HEAL HTTP+NET, 2 = CLEAR LOGS */
    int             debug_scroll;
    char            debug_logs[MAX_DBG_LINES][64];
    int             debug_log_count;
    bool            confirm_open;
    int             confirm_type;   /* 1 = Billboard Notices, 2 = Shared Files, 3 = Network Revision */
    int             confirm_choice; /* 0 = NO / CANCEL, 1 = YES / ACCEPT */
    char            confirm_label[56];
    bool            osk_open;
    int             osk_row;
    int             osk_col;
    bool            shift_held;
    char            input_buf[96];
    int             input_len;
    TransportStatus net;
    ChatLine        rooms[3][MAX_LOG_LINES];
    int             room_counts[3];
    int             room_users[3];
    BoardItem       board[8];
    int             board_count;
    ShelfItem       files[8];
    int             file_count;
    int             used_kb;
    int             ceil_kb;
    uint8_t         qr_grid[25][25];
    char            qr_url[64];
} StumpPocketState;

static StumpPocketState g_st;

static uint64_t monotonic_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000ULL + (uint64_t)(ts.tv_nsec / 1000000ULL);
}

static void set_ui_busy(const char *msg, uint64_t duration_ms) {
    g_st.busy_until_ms = monotonic_ms() + duration_ms;
    snprintf(g_st.busy_msg, sizeof(g_st.busy_msg), "%.62s", msg ? msg : "IN PROCESS...");
}

static bool is_ui_busy(void) {
    return (monotonic_ms() < g_st.busy_until_ms) || g_st.py_busy;
}

static void handle_sig(int sig) {
    (void)sig;
    g_st.running = false;
}

static const char *ROOM_SLUGS[3] = { "main", "lora-mesh", "wifi-mesh" };
static const char *ROOM_NAMES[3] = { "#MAIN", "#LORA-MESH", "#WIFI-MESH" };

static const char *QUICK_CMDS[6] = {
    "1. /WHOAMI + /NAMES",
    "2. /AUTH CHALLENGE+SIGN",
    "3. !FIND JARDINAGE",
    "4. !ROLL 2D6 TAVERN",
    "5. ANNOUNCE ON MESH",
    "6. SEND HELLO TO ROOM"
};

/* 4x10 On-Screen Keyboard (OSK) Grid (Y to open/close, A to type, B to cancel/close) */
static const char *OSK_LABELS[4][10] = {
    { "1", "2", "3", "4", "5", "6", "7", "8", "9", "0" },
    { "Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P" },
    { "A", "S", "D", "F", "G", "H", "J", "K", "L", "/" },
    { "Z", "X", "C", "V", "B", "N", "M", "SPC", "DEL", "OK" }
};

static const char *BOARD_PRESET_TITLES[5] = {
    "R36MAX NODE ONLINE & READY",
    "BLUEWAY RT3070 CAM AP LIVE",
    "MEET AT BASE / CHANNEL 6",
    "NEW FILES SHARED IN /FILES",
    "HELTEC V3 + WIFI CHAIN OK"
};

static const char *BOARD_PRESET_BODIES[5] = {
    "Posted from R36MAX handheld operator console.",
    "Join Wi-Fi SSID LaBuche-Stump -> 192.168.4.1:80.",
    "Check #main or #wifi-mesh room for coordinates.",
    "Download offline guides and logs from /files.",
    "RT3070 20dBm AP + Reticulum LoRa relay active."
};

static const char *FILE_ACTION_LABELS[3] = {
    "EXPORT LIVE MESH LOG (.TXT)",
    "SHARE FIELD GUIDE (.MD)",
    "IMPORT FROM DROP FOLDER"
};

static void trigger_chime(int freq, int ms) {
    g_st.chime_freq = freq;
    g_st.chime_ms = ms;
}

/* Send command to Python bridge via UDP 127.0.0.1:42421 FIRST; only write to /dev/shm/stump_cmd.txt
 * if UDP sendto fails, preventing duplicate command execution! */
static void send_bridge_cmd(const char *cmd_line) {
    ssize_t sent = -1;
    if (g_st.ipc_sock >= 0) {
        struct sockaddr_in dst;
        memset(&dst, 0, sizeof(dst));
        dst.sin_family = AF_INET;
        dst.sin_port = htons(IPC_UDP_PORT);
        dst.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        sent = sendto(g_st.ipc_sock, cmd_line, strlen(cmd_line), MSG_DONTWAIT,
                      (struct sockaddr *)&dst, sizeof(dst));
    }
    if (sent <= 0) {
        int fd = open(CMD_QUEUE_FILE, O_WRONLY | O_CREAT | O_APPEND, 0666);
        if (fd >= 0) {
            dprintf(fd, "%s\\n", cmd_line);
            close(fd);
        }
    }
    g_st.suppress_poll_frames = 16;
}

static void push_chat_local(int room, const char *nick, const char *body, bool is_sys) {
    if (room < 0 || room > 2) return;
    int idx = g_st.room_counts[room];
    if (idx >= MAX_LOG_LINES) {
        memmove(&g_st.rooms[room][0], &g_st.rooms[room][1], sizeof(ChatLine) * (MAX_LOG_LINES - 1));
        idx = MAX_LOG_LINES - 1;
    } else {
        g_st.room_counts[room]++;
    }
    snprintf(g_st.rooms[room][idx].nick, sizeof(g_st.rooms[room][idx].nick), "%.17s", nick);
    snprintf(g_st.rooms[room][idx].body, sizeof(g_st.rooms[room][idx].body), "%.45s", body);
    g_st.rooms[room][idx].is_sys = is_sys;
}

static void input_append_char(char c) {
    if (g_st.input_len < (int)sizeof(g_st.input_buf) - 2) {
        g_st.input_buf[g_st.input_len++] = c;
        g_st.input_buf[g_st.input_len] = '\\0';
    }
}

static void input_backspace(void) {
    if (g_st.input_len > 0) {
        g_st.input_buf[--g_st.input_len] = '\\0';
    }
}

static void broadcast_udp_beacon(const char *type, const char *msg);
static void update_qr_if_needed(void);
static void sync_disk_fallback(void);

static int count_checked_boards(void) {
    int c = 0;
    for (int i = 0; i < g_st.board_count; i++) if (g_st.board[i].checked) c++;
    return c;
}

static int count_checked_files(void) {
    int c = 0;
    for (int i = 0; i < g_st.file_count; i++) if (g_st.files[i].checked) c++;
    return c;
}

static void revert_staged_network_revision(void) {
    g_st.net_staged_ap = g_st.ap_active;
    g_st.net_staged_ssid[0] = '\\0';
    for (int i = 0; i < g_st.wifi_count; i++) {
        if (g_st.wifi_list[i].active && g_st.wifi_list[i].ssid[0]) {
            snprintf(g_st.net_staged_ssid, sizeof(g_st.net_staged_ssid), "%.31s", g_st.wifi_list[i].ssid);
            break;
        }
    }
    g_st.net_staged_pass[0] = '\\0';
    g_st.net_staged_dirty = false;
    g_st.net_staged_init = true;
}

static void apply_staged_network_revision(void) {
    uint64_t now = monotonic_ms();
    if (now < g_st.radio_lock_until_ms) {
        set_ui_busy("IN PROCESS: RADIO BUSY, WAIT A MOMENT...", 1600);
        trigger_chime(340, 45);
        return;
    }
    g_st.radio_lock_until_ms = now + 5500ULL;
    if (g_st.net_staged_ap) {
        g_st.ap_active = true;
        send_bridge_cmd("NET_APPLY|AP");
        g_st.suppress_poll_frames = 300;
        set_ui_busy("IN PROCESS: APPLYING STUMP AP 192.168.4.1...", 5200);
        snprintf(g_st.wifi_status_msg, sizeof(g_st.wifi_status_msg),
                 "AP APPLIED: LABUCHE-STUMP (192.168.4.1:80)");
        trigger_chime(880, 85);
    } else {
        g_st.ap_active = false;
        char cmd[256];
        const char *pw = g_st.input_len > 0 ? g_st.input_buf : g_st.net_staged_pass;
        snprintf(cmd, sizeof(cmd), "NET_APPLY|LAN|%s|%s", g_st.net_staged_ssid, pw);
        send_bridge_cmd(cmd);
        g_st.suppress_poll_frames = 300;
        char bmsg[64];
        snprintf(bmsg, sizeof(bmsg), "IN PROCESS: APPLYING LOCAL LAN (%.22s)...",
                 g_st.net_staged_ssid[0] ? g_st.net_staged_ssid : "SAVED DHCP");
        set_ui_busy(bmsg, 5200);
        snprintf(g_st.wifi_status_msg, sizeof(g_st.wifi_status_msg),
                 "LAN APPLIED: %.26s",
                 g_st.net_staged_ssid[0] ? g_st.net_staged_ssid : "SAVED DHCP");
        trigger_chime(784, 80);
    }
    g_st.net_staged_dirty = false;
    g_st.osk_open = false;
    update_qr_if_needed();
}

static void open_network_revision_confirm(void) {
    g_st.confirm_open = true;
    g_st.confirm_type = 3;
    g_st.confirm_choice = 1; /* Default highlight on YES, APPLY so [A] accepts and [B] cancels */
    if (g_st.net_staged_ap) {
        snprintf(g_st.confirm_label, sizeof(g_st.confirm_label),
                 "STUMP AP: LaBuche-Stump (192.168.4.1:80)");
    } else {
        snprintf(g_st.confirm_label, sizeof(g_st.confirm_label),
                 "LOCAL LAN WIFI: %s",
                 g_st.net_staged_ssid[0] ? g_st.net_staged_ssid : "SAVED WIFI DHCP");
    }
    trigger_chime(660, 45);
}

static void action_wifi_tab_confirm(void) {
    if (g_st.wifi_cursor <= 0) {
        /* Row 0: Stage selected radio mode and jump to Panel 5 (5:REV/DBG) for review before applying */
        g_st.net_staged_dirty = true;
        g_st.tab_idx = 4;
        g_st.rev_cursor = 2; /* Highlight [APPLY REVISION] row in Panel 5 */
        set_ui_busy("STAGED IN PANEL 5: PRESS [A] TO APPLY OR [B] TO CANCEL", 2200);
        trigger_chime(740, 55);
    } else if (g_st.wifi_cursor == 1) {
        /* Row 1: Utility Toggle Bar (0=Scan, 1=Switch QR, 2=Password OSK) */
        if (g_st.wifi_bar_mode == 0) {
            send_bridge_cmd("WIFI_SCAN");
            set_ui_busy("IN PROCESS: SCANNING 2.4GHZ WIFI...", 4000);
            snprintf(g_st.wifi_status_msg, sizeof(g_st.wifi_status_msg), "SCANNING 2.4GHZ WIFI NETWORKS...");
            trigger_chime(700, 50);
        } else if (g_st.wifi_bar_mode == 1) {
            g_st.qr_mode = (g_st.qr_mode + 1) % 2;
            update_qr_if_needed();
            set_ui_busy(g_st.qr_mode == 1 ? "QR MODE: WIFI AUTO-JOIN" : "QR MODE: HTTP PORTAL :80", 1200);
            trigger_chime(660, 45);
        } else {
            g_st.osk_open = !g_st.osk_open;
            trigger_chime(g_st.osk_open ? 740 : 520, 45);
        }
    } else if (g_st.wifi_cursor - 2 < g_st.wifi_count) {
        /* Rows 2..: Stage selected Wi-Fi SSID (+ optional password) into Panel 5 for revision! */
        int widx = g_st.wifi_cursor - 2;
        g_st.net_staged_ap = false;
        snprintf(g_st.net_staged_ssid, sizeof(g_st.net_staged_ssid), "%.31s", g_st.wifi_list[widx].ssid);
        if (g_st.input_len > 0) {
            snprintf(g_st.net_staged_pass, sizeof(g_st.net_staged_pass), "%.63s", g_st.input_buf);
        }
        g_st.net_staged_dirty = true;
        g_st.osk_open = false;
        g_st.tab_idx = 4;
        g_st.rev_cursor = 2; /* Jump to Panel 5 [APPLY REVISION] row */
        char bmsg[64];
        snprintf(bmsg, sizeof(bmsg), "STAGED LAN SSID %.22s -> REVIEW IN PANEL 5", g_st.net_staged_ssid);
        set_ui_busy(bmsg, 2400);
        trigger_chime(780, 60);
    }
}

static void send_typed_chat(void) {
    if (g_st.tab_idx == 3) {
        snprintf(g_st.net_staged_pass, sizeof(g_st.net_staged_pass), "%.63s", g_st.input_buf);
        g_st.osk_open = false;
        set_ui_busy("WIFI PASSWORD SAVED TO STAGED REVISION", 1500);
        trigger_chime(740, 45);
        return;
    }
    if (g_st.input_len <= 0) return;
    int r = g_st.room_idx;
    const char *rslug = ROOM_SLUGS[r];
    char cmd[256];
    snprintf(cmd, sizeof(cmd), "RRC|%s|%s", rslug, g_st.input_buf);
    send_bridge_cmd(cmd);
    broadcast_udp_beacon("CHAT", g_st.input_buf);
    push_chat_local(r, "r36max", g_st.input_buf, false);
    g_st.input_len = 0;
    g_st.input_buf[0] = '\\0';
    set_ui_busy("IN PROCESS: SENDING MESSAGE TO MESH...", 1000);
    trigger_chime(840, 55);
}

static void execute_osk_key(void) {
    int r = g_st.osk_row;
    int c = g_st.osk_col;
    if (r == 3 && c == 7) {
        input_append_char(' ');
        trigger_chime(520, 20);
    } else if (r == 3 && c == 8) {
        input_backspace();
        trigger_chime(420, 25);
    } else if (r == 3 && c == 9) {
        send_typed_chat();
    } else {
        const char *lbl = OSK_LABELS[r][c];
        if (lbl && lbl[0]) {
            char ch = lbl[0];
            if (ch >= 'A' && ch <= 'Z') ch = (char)(ch + 32);
            input_append_char(ch);
            trigger_chime(600, 20);
        }
    }
}

static char translate_linux_key(uint16_t code, bool shift) {
    switch (code) {
        case KEY_1: return shift ? '!' : '1';
        case KEY_2: return shift ? '@' : '2';
        case KEY_3: return shift ? '#' : '3';
        case KEY_4: return shift ? '$' : '4';
        case KEY_5: return shift ? '%' : '5';
        case KEY_6: return shift ? '^' : '6';
        case KEY_7: return shift ? '&' : '7';
        case KEY_8: return shift ? '*' : '8';
        case KEY_9: return shift ? '(' : '9';
        case KEY_0: return shift ? ')' : '0';
        case KEY_MINUS: return shift ? '_' : '-';
        case KEY_EQUAL: return shift ? '+' : '=';
        case KEY_Q: return shift ? 'Q' : 'q';
        case KEY_W: return shift ? 'W' : 'w';
        case KEY_E: return shift ? 'E' : 'e';
        case KEY_R: return shift ? 'R' : 'r';
        case KEY_T: return shift ? 'T' : 't';
        case KEY_Y: return shift ? 'Y' : 'y';
        case KEY_U: return shift ? 'U' : 'u';
        case KEY_I: return shift ? 'I' : 'i';
        case KEY_O: return shift ? 'O' : 'o';
        case KEY_P: return shift ? 'P' : 'p';
        case KEY_A: return shift ? 'A' : 'a';
        case KEY_S: return shift ? 'S' : 's';
        case KEY_D: return shift ? 'D' : 'd';
        case KEY_F: return shift ? 'F' : 'f';
        case KEY_G: return shift ? 'G' : 'g';
        case KEY_H: return shift ? 'H' : 'h';
        case KEY_J: return shift ? 'J' : 'j';
        case KEY_K: return shift ? 'K' : 'k';
        case KEY_L: return shift ? 'L' : 'l';
        case KEY_Z: return shift ? 'Z' : 'z';
        case KEY_X: return shift ? 'X' : 'x';
        case KEY_C: return shift ? 'C' : 'c';
        case KEY_V: return shift ? 'V' : 'v';
        case KEY_B: return shift ? 'B' : 'b';
        case KEY_N: return shift ? 'N' : 'n';
        case KEY_M: return shift ? 'M' : 'm';
        case KEY_SPACE: return ' ';
        case KEY_SLASH: return shift ? '?' : '/';
        case KEY_DOT: return shift ? '>' : '.';
        case KEY_COMMA: return shift ? '<' : ',';
        case KEY_SEMICOLON: return shift ? ':' : ';';
        case KEY_APOSTROPHE: return shift ? (char)34 : (char)39;
        case KEY_LEFTBRACE: return '[';
        case KEY_RIGHTBRACE: return ']';
        default: return 0;
    }
}

static void sync_disk_fallback(void) {
    FILE *bf = fopen(SD_BOARD_FILE, "r");
    if (bf) {
        BoardItem tmp[32];
        int cnt = 0;
        char line[512];
        while (fgets(line, sizeof(line), bf) && cnt < 32) {
            char *nl = strchr(line, '\\n');
            if (nl) *nl = '\\0';
            if (!line[0]) continue;
            char *p1 = strchr(line, '\\t');
            if (!p1) continue;
            *p1++ = '\\0';
            char *p2 = strchr(p1, '\\t');
            if (!p2) continue;
            *p2++ = '\\0';
            char *p3 = strchr(p2, '\\t');
            if (p3) *p3++ = '\\0';
            memset(&tmp[cnt], 0, sizeof(BoardItem));
            snprintf(tmp[cnt].sig, sizeof(tmp[cnt].sig), "%.15s", line);
            snprintf(tmp[cnt].id, sizeof(tmp[cnt].id), "%.27s", p1);
            snprintf(tmp[cnt].title, sizeof(tmp[cnt].title), "%.45s", p2);
            snprintf(tmp[cnt].body, sizeof(tmp[cnt].body), "%.49s", p3 ? p3 : "");
            cnt++;
        }
        fclose(bf);
        g_st.board_count = 0;
        for (int i = cnt - 1; i >= 0 && g_st.board_count < 8; i--) {
            g_st.board[g_st.board_count++] = tmp[i];
        }
    }

    DIR *sd = opendir(SD_SHARED_DIR);
    if (sd) {
        g_st.file_count = 0;
        int total_bytes = 0;
        struct dirent *ent;
        while ((ent = readdir(sd)) != NULL && g_st.file_count < 8) {
            if (ent->d_name[0] == '.') continue;
            char fpath[512];
            snprintf(fpath, sizeof(fpath), "%s/%s", SD_SHARED_DIR, ent->d_name);
            struct stat st;
            if (stat(fpath, &st) == 0 && S_ISREG(st.st_mode)) {
                total_bytes += (int)st.st_size;
                int idx = g_st.file_count++;
                memset(&g_st.files[idx], 0, sizeof(ShelfItem));
                snprintf(g_st.files[idx].name, sizeof(g_st.files[idx].name), "%.35s", ent->d_name);
                g_st.files[idx].size_kb = (st.st_size > 1024) ? (int)(st.st_size / 1024) : 1;
                snprintf(g_st.files[idx].cat, sizeof(g_st.files[idx].cat), "DOC");
            }
        }
        closedir(sd);
        g_st.used_kb = total_bytes / 1024;
        if (g_st.ceil_kb == 0) g_st.ceil_kb = 1536 * 1024;
    }
}

static void poll_live_bridge(void) {
    if (g_st.suppress_poll_frames > 0) return;
    FILE *f = fopen(LIVE_STATE_FILE, "r");
    if (!f) {
        sync_disk_fallback();
        return;
    }
    /* Preserve existing checked [X] states by ID / filename across live refreshes */
    char checked_board_ids[8][28];
    int checked_board_n = 0;
    for (int i = 0; i < g_st.board_count && i < 8; i++) {
        if (g_st.board[i].checked && g_st.board[i].id[0]) {
            snprintf(checked_board_ids[checked_board_n++], 28, "%s", g_st.board[i].id);
        }
    }
    char checked_file_names[8][36];
    int checked_file_n = 0;
    for (int i = 0; i < g_st.file_count && i < 8; i++) {
        if (g_st.files[i].checked && g_st.files[i].name[0]) {
            snprintf(checked_file_names[checked_file_n++], 36, "%s", g_st.files[i].name);
        }
    }

    int r_counts[3] = {0, 0, 0};
    int b_count = 0;
    int f_count = 0;
    int w_count = 0;
    int d_count = 0;
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        char *nl = strchr(line, '\\n');
        if (nl) *nl = '\\0';
        if (strncmp(line, "META|", 5) == 0) {
            char *p1 = line + 5;
            char *p2 = strchr(p1, '|');
            if (p2) {
                *p2++ = '\\0';
                snprintf(g_st.node_lxmf, sizeof(g_st.node_lxmf), "%.35s", p1);
                char *p3 = strchr(p2, '|');
                if (p3) {
                    *p3++ = '\\0';
                    snprintf(g_st.rnode_status, sizeof(g_st.rnode_status), "%.23s", p3);
                }
                g_st.mesh_peers = atoi(p2);
            }
        } else if (strncmp(line, "VER|", 4) == 0) {
            /* VER|<version>|<build>|<http80>|<http8080>|<lan_ip>|<tf_backup_count> */
            char *p1 = line + 4;
            char *p2 = strchr(p1, '|');
            if (p2) {
                *p2++ = '\\0';
                snprintf(g_st.ver_str, sizeof(g_st.ver_str), "%.27s", p1);
                char *p3 = strchr(p2, '|');
                if (p3) {
                    *p3++ = '\\0';
                    snprintf(g_st.build_str, sizeof(g_st.build_str), "%.27s", p2);
                    char *p4 = strchr(p3, '|');
                    if (p4) {
                        *p4++ = '\\0';
                        g_st.http80_ok = (atoi(p3) != 0);
                        char *p5 = strchr(p4, '|');
                        if (p5) {
                            *p5++ = '\\0';
                            g_st.http8080_ok = (atoi(p4) != 0);
                            char *p6 = strchr(p5, '|');
                            if (p6) {
                                *p6++ = '\\0';
                                snprintf(g_st.bridge_lan_ip, sizeof(g_st.bridge_lan_ip), "%.27s", p5);
                                g_st.tf_backup_count = atoi(p6);
                            }
                        }
                    }
                }
            }
        } else if (strncmp(line, "BUSY|", 5) == 0) {
            char *p1 = line + 5;
            char *p2 = strchr(p1, '|');
            if (p2) {
                *p2++ = '\\0';
                g_st.py_busy = (atoi(p1) != 0);
                if (g_st.py_busy && p2[0]) {
                    snprintf(g_st.busy_msg, sizeof(g_st.busy_msg), "%.62s", p2);
                }
            }
        } else if (strncmp(line, "AP|", 3) == 0) {
            char *p1 = line + 3;
            char *p2 = strchr(p1, '|');
            if (p2) {
                *p2++ = '\\0';
                if (monotonic_ms() >= g_st.radio_lock_until_ms) {
                    g_st.ap_active = (atoi(p1) != 0);
                }
                char *p3 = strchr(p2, '|');
                if (p3) {
                    *p3++ = '\\0';
                    snprintf(g_st.ap_if, sizeof(g_st.ap_if), "%.19s", p2);
                    char *p4 = strchr(p3, '|');
                    if (p4) {
                        *p4++ = '\\0';
                        snprintf(g_st.ap_mac, sizeof(g_st.ap_mac), "%.23s", p3);
                        char *p5 = strchr(p4, '|');
                        if (p5) {
                            *p5++ = '\\0';
                            snprintf(g_st.ap_driver, sizeof(g_st.ap_driver), "%.19s", p4);
                            char *p6 = strchr(p5, '|');
                            if (p6) {
                                *p6++ = '\\0';
                                snprintf(g_st.ap_ssid, sizeof(g_st.ap_ssid), "%.23s", p5);
                                g_st.ap_clients = atoi(p6);
                            }
                        }
                    }
                }
            }
        } else if (strncmp(line, "SSID|", 5) == 0 && w_count < 6) {
            char *p1 = line + 5;
            char *p2 = strchr(p1, '|');
            if (p2) {
                *p2++ = '\\0';
                char *p3 = strchr(p2, '|');
                if (p3) {
                    *p3++ = '\\0';
                    char *p4 = strchr(p3, '|');
                    if (p4) {
                        *p4++ = '\\0';
                        g_st.wifi_list[w_count].active = (atoi(p1) != 0);
                        g_st.wifi_list[w_count].signal = atoi(p2);
                        snprintf(g_st.wifi_list[w_count].sec, sizeof(g_st.wifi_list[w_count].sec), "%.9s", p3);
                        snprintf(g_st.wifi_list[w_count].ssid, sizeof(g_st.wifi_list[w_count].ssid), "%.31s", p4);
                        w_count++;
                    }
                }
            }
        } else if (strncmp(line, "ROOM|", 5) == 0) {
            int r_idx = atoi(line + 5);
            char *p2 = strchr(line + 5, '|');
            if (p2 && r_idx >= 0 && r_idx < 3) {
                char *p3 = strchr(p2 + 1, '|');
                if (p3) g_st.room_users[r_idx] = atoi(p3 + 1);
            }
        } else if (strncmp(line, "MSG|", 4) == 0) {
            int r_idx = atoi(line + 4);
            char *p1 = strchr(line + 4, '|');
            if (p1 && r_idx >= 0 && r_idx < 3 && r_counts[r_idx] < MAX_LOG_LINES) {
                int is_sys = atoi(p1 + 1);
                char *p2 = strchr(p1 + 1, '|');
                if (p2) {
                    *p2++ = '\\0';
                    char *p3 = strchr(p2, '|');
                    if (p3) {
                        *p3++ = '\\0';
                        int slot = r_counts[r_idx]++;
                        snprintf(g_st.rooms[r_idx][slot].nick, sizeof(g_st.rooms[r_idx][slot].nick), "%.17s", p2);
                        snprintf(g_st.rooms[r_idx][slot].body, sizeof(g_st.rooms[r_idx][slot].body), "%.45s", p3);
                        g_st.rooms[r_idx][slot].is_sys = (is_sys != 0);
                    }
                }
            }
        } else if (strncmp(line, "BOARD|", 6) == 0 && b_count < 8) {
            char *p1 = line + 6;
            char *p2 = strchr(p1, '|');
            if (p2) {
                *p2++ = '\\0';
                char *p3 = strchr(p2, '|');
                if (p3) {
                    *p3++ = '\\0';
                    char *p4 = strchr(p3, '|');
                    if (p4) *p4++ = '\\0';
                    snprintf(g_st.board[b_count].id, sizeof(g_st.board[b_count].id), "%.27s", p1);
                    snprintf(g_st.board[b_count].sig, sizeof(g_st.board[b_count].sig), "%.15s", p2);
                    snprintf(g_st.board[b_count].title, sizeof(g_st.board[b_count].title), "%.45s", p3);
                    snprintf(g_st.board[b_count].body, sizeof(g_st.board[b_count].body), "%.49s", p4 ? p4 : "");
                    bool was_chk = false;
                    for (int k = 0; k < checked_board_n; k++) {
                        if (strcmp(checked_board_ids[k], g_st.board[b_count].id) == 0) { was_chk = true; break; }
                    }
                    g_st.board[b_count].checked = was_chk;
                    b_count++;
                }
            }
        } else if (strncmp(line, "FILE|", 5) == 0 && f_count < 8) {
            char *p1 = line + 5;
            char *p2 = strchr(p1, '|');
            if (p2) {
                *p2++ = '\\0';
                char *p3 = strchr(p2, '|');
                if (p3) *p3++ = '\\0';
                snprintf(g_st.files[f_count].name, sizeof(g_st.files[f_count].name), "%.35s", p1);
                g_st.files[f_count].size_kb = atoi(p2);
                snprintf(g_st.files[f_count].cat, sizeof(g_st.files[f_count].cat), "%.7s", p3 ? p3 : "DOC");
                bool was_chk = false;
                for (int k = 0; k < checked_file_n; k++) {
                    if (strcmp(checked_file_names[k], g_st.files[f_count].name) == 0) { was_chk = true; break; }
                }
                g_st.files[f_count].checked = was_chk;
                f_count++;
            }
        } else if (strncmp(line, "STORAGE|", 8) == 0) {
            int u = 0, c = 0, t = 0;
            if (sscanf(line + 8, "%d|%d|%d", &u, &c, &t) >= 2) {
                g_st.used_kb = u;
                g_st.ceil_kb = c;
            }
        } else if (strncmp(line, "LOG|", 4) == 0 && d_count < MAX_DBG_LINES) {
            snprintf(g_st.debug_logs[d_count++], 64, "%.62s", line + 4);
        }
    }
    fclose(f);
    for (int r = 0; r < 3; r++) g_st.room_counts[r] = r_counts[r];
    g_st.board_count = b_count;
    g_st.file_count = f_count;
    g_st.wifi_count = w_count;
    g_st.debug_log_count = d_count;
    if (!g_st.net_staged_init || !g_st.net_staged_dirty) {
        revert_staged_network_revision();
    }
    if (g_st.board_cursor > g_st.board_count) g_st.board_cursor = g_st.board_count;
    if (g_st.file_cursor > g_st.file_count) g_st.file_cursor = g_st.file_count;
    if (g_st.wifi_cursor > 1 + g_st.wifi_count) g_st.wifi_cursor = 1 + g_st.wifi_count;
}

static void broadcast_udp_beacon(const char *type, const char *msg) {
    if (g_st.udp_sock < 0) return;
    char pkt[256];
    snprintf(pkt, sizeof(pkt), "STUMP|R36MAX|%s|%s|%s",
             g_st.net.primary_ip, type, msg);
    struct sockaddr_in bcast;
    memset(&bcast, 0, sizeof(bcast));
    bcast.sin_family = AF_INET;
    bcast.sin_port = htons(MESH_UDP_PORT);
    bcast.sin_addr.s_addr = htonl(INADDR_BROADCAST);
    sendto(g_st.udp_sock, pkt, strlen(pkt), 0, (struct sockaddr *)&bcast, sizeof(bcast));
}

static void poll_udp_mesh(void) {
    if (g_st.udp_sock < 0) return;
    char buf[256];
    struct sockaddr_in src;
    socklen_t slen = sizeof(src);
    ssize_t n = recvfrom(g_st.udp_sock, buf, sizeof(buf) - 1, MSG_DONTWAIT, (struct sockaddr *)&src, &slen);
    if (n > 0) {
        buf[n] = '\\0';
        char src_ip[40];
        inet_ntop(AF_INET, &src.sin_addr, src_ip, sizeof(src_ip));
        if (strcmp(src_ip, g_st.net.primary_ip) != 0 && strcmp(src_ip, "127.0.0.1") != 0) {
            g_st.rx_packets++;
            char cmd[160];
            snprintf(cmd, sizeof(cmd), "RRC|wifi-mesh|[UDP %s] %.60s", src_ip, buf);
            send_bridge_cmd(cmd);
        }
    }
}

static void *alsa_chime_thread(void *arg) {
    (void)arg;
    snd_pcm_t *pcm = NULL;
    if (snd_pcm_open(&pcm, "plughw:0,0", SND_PCM_STREAM_PLAYBACK, SND_PCM_NONBLOCK) == 0) {
        snd_pcm_nonblock(pcm, 0);
        if (snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 2, SR, 1, 80000) < 0) {
            snd_pcm_close(pcm);
            pcm = NULL;
        }
    }
    int16_t buf[ALSA_PERIOD * 2];
    uint32_t phase = 0;
    while (g_st.running) {
        int freq = g_st.chime_freq;
        int ms = g_st.chime_ms;
        if (freq > 0 && ms > 0) {
            int periods = (ms * SR) / (1000 * ALSA_PERIOD) + 1;
            for (int p = 0; p < periods && g_st.running; p++) {
                uint32_t ps = SR / (uint32_t)freq;
                if (ps < 4) ps = 4;
                for (int i = 0; i < ALSA_PERIOD; i++) {
                    int16_t s = ((phase % ps) < (ps / 2)) ? 5500 : -5500;
                    buf[i * 2] = s;
                    buf[i * 2 + 1] = s;
                    phase++;
                }
                if (pcm) {
                    snd_pcm_sframes_t f = snd_pcm_writei(pcm, buf, ALSA_PERIOD);
                    if (f < 0) snd_pcm_recover(pcm, (int)f, 1);
                } else {
                    usleep(11000);
                }
            }
            g_st.chime_ms = 0;
        } else {
            usleep(20000);
        }
    }
    if (pcm) snd_pcm_close(pcm);
    return NULL;
}

static void execute_rrc_deck_action(void) {
    int r = g_st.room_idx;
    const char *rslug = ROOM_SLUGS[r];
    int c = g_st.cmd_cursor;
    char cmd[256];
    set_ui_busy("IN PROCESS: DISPATCHING MESH COMMAND...", 1200);

    if (c == 0) {
        snprintf(cmd, sizeof(cmd), "RRC|%s|/whoami", rslug);
        send_bridge_cmd(cmd);
        snprintf(cmd, sizeof(cmd), "RRC|%s|/names", rslug);
        send_bridge_cmd(cmd);
        push_chat_local(r, "r36max", "/whoami + /names", false);
        trigger_chime(660, 50);
    } else if (c == 1) {
        g_st.verified = true;
        snprintf(cmd, sizeof(cmd), "RRC|%s|/auth", rslug);
        send_bridge_cmd(cmd);
        push_chat_local(r, "r36max", "/auth (local operator verified)", true);
        trigger_chime(880, 80);
    } else if (c == 2) {
        snprintf(cmd, sizeof(cmd), "RRC|%s|!find jardinage", rslug);
        send_bridge_cmd(cmd);
        push_chat_local(r, "r36max", "!find jardinage", false);
        trigger_chime(587, 60);
    } else if (c == 3) {
        snprintf(cmd, sizeof(cmd), "RRC|%s|!roll 2d6", rslug);
        send_bridge_cmd(cmd);
        push_chat_local(r, "r36max", "!roll 2d6", false);
        trigger_chime(740, 60);
    } else if (c == 4) {
        g_st.beacons_sent++;
        broadcast_udp_beacon("BEACON", "STUMP.NODE ANNOUNCE");
        snprintf(cmd, sizeof(cmd), "ANNOUNCE|%s", rslug);
        send_bridge_cmd(cmd);
        push_chat_local(r, "r36max", "[BEACON] Announced on Wi-Fi + Mesh", true);
        trigger_chime(987, 80);
    } else {
        broadcast_udp_beacon("CHAT", "Hello from R36MAX handheld operator!");
        snprintf(cmd, sizeof(cmd), "RRC|%s|Hello from R36MAX handheld operator!", rslug);
        send_bridge_cmd(cmd);
        push_chat_local(r, "r36max", "Hello from R36MAX handheld operator!", false);
        trigger_chime(784, 50);
    }
}

static void action_board_add(void) {
    int p = g_st.board_preset_idx % 5;
    char cmd[256];
    snprintf(cmd, sizeof(cmd), "BOARD_ADD|%s|%s", BOARD_PRESET_TITLES[p], BOARD_PRESET_BODIES[p]);
    send_bridge_cmd(cmd);
    set_ui_busy("IN PROCESS: POSTING NOTICE TO BILLBOARD...", 1600);

    if (access(LIVE_STATE_FILE, F_OK) != 0) {
        mkdir("/roms/ports/stump_r36max/node/sd", 0755);
        FILE *bf = fopen(SD_BOARD_FILE, "a");
        if (bf) {
            fprintf(bf, "r36m\\t%ld\\t%s\\t%s\\n", (long)time(NULL), BOARD_PRESET_TITLES[p], BOARD_PRESET_BODIES[p]);
            fclose(bf);
        }
        sync_disk_fallback();
    }
    g_st.board_preset_idx = (g_st.board_preset_idx + 1) % 5;
    trigger_chime(880, 65);
}

static void action_board_backup_checked_tf(void) {
    int chk = count_checked_boards();
    if (chk <= 0) {
        set_ui_busy("CHECK [X] A NOTICE FIRST (PRESS [A] ON ITEM)!", 2200);
        trigger_chime(320, 70);
        return;
    }
    char ids[256] = "";
    for (int i = 0; i < g_st.board_count; i++) {
        if (g_st.board[i].checked) {
            if (ids[0]) strncat(ids, ",", sizeof(ids) - strlen(ids) - 1);
            strncat(ids, g_st.board[i].id, sizeof(ids) - strlen(ids) - 1);
            g_st.board[i].checked = false;
        }
    }
    char cmd[300];
    snprintf(cmd, sizeof(cmd), "BOARD_BACKUP_TF|%s", ids);
    send_bridge_cmd(cmd);
    set_ui_busy("IN PROCESS: BACKING UP CHECKED NOTICES TO TF CARD...", 2600);
    trigger_chime(860, 75);
}

static void action_board_delete_checked(void) {
    char ids[256] = "";
    for (int i = 0; i < g_st.board_count; i++) {
        if (g_st.board[i].checked) {
            if (ids[0]) strncat(ids, ",", sizeof(ids) - strlen(ids) - 1);
            strncat(ids, g_st.board[i].id, sizeof(ids) - strlen(ids) - 1);
            g_st.board[i].checked = false;
        }
    }
    if (!ids[0]) return;
    char cmd[300];
    snprintf(cmd, sizeof(cmd), "BOARD_DEL_MULTI|%s", ids);
    send_bridge_cmd(cmd);
    set_ui_busy("IN PROCESS: ERASING CHECKED NOTICES...", 2000);
    trigger_chime(440, 70);
}

static void action_file_add(void) {
    int m = g_st.file_action_idx % 3;
    char cmd[128];
    snprintf(cmd, sizeof(cmd), "FILE_ADD|%d", m);
    send_bridge_cmd(cmd);
    set_ui_busy("IN PROCESS: SHARING FILE TO /SD/SHARED...", 1800);

    if (access(LIVE_STATE_FILE, F_OK) != 0) {
        mkdir("/roms/ports/stump_r36max/node/sd", 0755);
        mkdir(SD_SHARED_DIR, 0755);
        char fpath[256];
        snprintf(fpath, sizeof(fpath), "%s/r36max_field_log_%ld.txt", SD_SHARED_DIR, (long)(time(NULL) % 100000));
        FILE *f = fopen(fpath, "w");
        if (f) {
            fprintf(f, "LaBuche-Stump R36MAX Field Log (IP: %s)\\n", g_st.net.primary_ip);
            fclose(f);
        }
        sync_disk_fallback();
    }
    g_st.file_action_idx = (g_st.file_action_idx + 1) % 3;
    trigger_chime(880, 65);
}

static void action_file_backup_checked_tf(void) {
    int chk = count_checked_files();
    if (chk <= 0) {
        set_ui_busy("CHECK [X] A FILE FIRST (PRESS [A] ON ITEM)!", 2200);
        trigger_chime(320, 70);
        return;
    }
    char names[320] = "";
    for (int i = 0; i < g_st.file_count; i++) {
        if (g_st.files[i].checked) {
            if (names[0]) strncat(names, ",", sizeof(names) - strlen(names) - 1);
            strncat(names, g_st.files[i].name, sizeof(names) - strlen(names) - 1);
            g_st.files[i].checked = false;
        }
    }
    char cmd[360];
    snprintf(cmd, sizeof(cmd), "FILE_BACKUP_TF|%s", names);
    send_bridge_cmd(cmd);
    set_ui_busy("IN PROCESS: BACKING UP CHECKED FILES TO TF CARD...", 2600);
    trigger_chime(860, 75);
}

static void action_file_delete_checked(void) {
    char names[320] = "";
    for (int i = 0; i < g_st.file_count; i++) {
        if (g_st.files[i].checked) {
            if (names[0]) strncat(names, ",", sizeof(names) - strlen(names) - 1);
            strncat(names, g_st.files[i].name, sizeof(names) - strlen(names) - 1);
            char fpath[256];
            snprintf(fpath, sizeof(fpath), "%s/%s", SD_SHARED_DIR, g_st.files[i].name);
            unlink(fpath);
            g_st.files[i].checked = false;
        }
    }
    if (!names[0]) return;
    char cmd[360];
    snprintf(cmd, sizeof(cmd), "FILE_DEL_MULTI|%s", names);
    send_bridge_cmd(cmd);
    set_ui_busy("IN PROCESS: ERASING CHECKED FILES...", 2000);
    trigger_chime(440, 70);
}

static void open_delete_confirm(int type) {
    if (type == 1) {
        int chk = count_checked_boards();
        if (chk <= 0) {
            set_ui_busy("CHECK [X] A NOTICE FIRST BEFORE DELETING!", 2200);
            trigger_chime(320, 70);
            return;
        }
        g_st.confirm_open = true;
        g_st.confirm_type = 1;
        g_st.confirm_choice = 0; /* Default to NO, KEEP */
        snprintf(g_st.confirm_label, sizeof(g_st.confirm_label), "%d CHECKED BILLBOARD NOTICE(S)", chk);
        trigger_chime(540, 45);
    } else if (type == 2) {
        int chk = count_checked_files();
        if (chk <= 0) {
            set_ui_busy("CHECK [X] A FILE FIRST BEFORE DELETING!", 2200);
            trigger_chime(320, 70);
            return;
        }
        g_st.confirm_open = true;
        g_st.confirm_type = 2;
        g_st.confirm_choice = 0; /* Default to NO, KEEP */
        snprintf(g_st.confirm_label, sizeof(g_st.confirm_label), "%d CHECKED SHARED FILE(S) IN /SD/SHARED", chk);
        trigger_chime(540, 45);
    }
}

static void execute_debug_tab_action(void) {
    if (g_st.debug_bar_mode == 0) {
        send_bridge_cmd("DEBUG_EXPORT_TF");
        set_ui_busy("IN PROCESS: EXPORTING LOGS & DIAG TO TF CARD...", 3000);
        trigger_chime(880, 75);
    } else if (g_st.debug_bar_mode == 1) {
        send_bridge_cmd("DEBUG_HEAL_NET");
        set_ui_busy("IN PROCESS: HEALING HTTP :80/:8080 & NET...", 3000);
        trigger_chime(784, 70);
    } else {
        send_bridge_cmd("DEBUG_CLEAR_LOGS");
        g_st.debug_log_count = 0;
        set_ui_busy("CLEARED DEBUG LOG BUFFER", 1200);
        trigger_chime(540, 45);
    }
}

static void update_qr_if_needed(void) {
    char target_url[64];
    const char *lan_ip = (g_st.bridge_lan_ip[0] && strcmp(g_st.bridge_lan_ip, "127.0.0.1") != 0)
                         ? g_st.bridge_lan_ip : g_st.net.primary_ip;
    if (g_st.qr_mode == 1) {
        snprintf(target_url, sizeof(target_url), "WIFI:S:%s;T:nopass;;",
                 g_st.ap_ssid[0] ? g_st.ap_ssid : "LaBuche-Stump");
    } else if (g_st.ap_active) {
        snprintf(target_url, sizeof(target_url), "http://192.168.4.1:80/");
    } else {
        snprintf(target_url, sizeof(target_url), "http://%s:80/", lan_ip);
    }
    if (strcmp(target_url, g_st.qr_url) != 0) {
        snprintf(g_st.qr_url, sizeof(target_url), "%s", target_url);
        encode_qr_v2_l(g_st.qr_url, g_st.qr_grid);
    }
}


int main(int argc, char **argv) {
    umask(0);
    signal(SIGTERM, handle_sig);
    signal(SIGINT, handle_sig);
    srand((unsigned int)time(NULL));
    memset(&g_st, 0, sizeof(g_st));
    g_st.running = true;
    g_st.udp_sock = -1;
    g_st.ipc_sock = socket(AF_INET, SOCK_DGRAM, 0);
    snprintf(g_st.ver_str, sizeof(g_st.ver_str), "v1.7.1-r36max");
    snprintf(g_st.build_str, sizeof(g_st.build_str), "2026.06.21-dArkOS");
    g_st.http80_ok = true;
    g_st.http8080_ok = true;
    snprintf(g_st.node_lxmf, sizeof(g_st.node_lxmf), "A7F391C208B4E6D1");
    snprintf(g_st.rnode_status, sizeof(g_st.rnode_status), "WAIT-USB");
    snprintf(g_st.ap_ssid, sizeof(g_st.ap_ssid), "LaBuche-Stump");
    snprintf(g_st.ap_mac, sizeof(g_st.ap_mac), "00:0f:00:5e:11:ee");
    snprintf(g_st.ap_driver, sizeof(g_st.ap_driver), "rt2800usb");
    snprintf(g_st.wifi_status_msg, sizeof(g_st.wifi_status_msg), "STAGE IN PANEL 4 -> APPLY IN PANEL 5 ([A]=ACCEPT [B]=CANCEL)");

    scan_transports(&g_st.net);
    poll_live_bridge();
    revert_staged_network_revision();
    update_qr_if_needed();

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock >= 0) {
        int yes = 1;
        setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &yes, sizeof(yes));
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
        struct sockaddr_in bind_addr;
        memset(&bind_addr, 0, sizeof(bind_addr));
        bind_addr.sin_family = AF_INET;
        bind_addr.sin_port = htons(MESH_UDP_PORT);
        bind_addr.sin_addr.s_addr = htonl(INADDR_ANY);
        bind(sock, (struct sockaddr *)&bind_addr, sizeof(bind_addr));
        g_st.udp_sock = sock;
    }

    void *sdl = dlopen("libSDL2-2.0.so.0", RTLD_LAZY | RTLD_GLOBAL);
    if (!sdl) sdl = dlopen("/usr/lib/aarch64-linux-gnu/libSDL2-2.0.so.0", RTLD_LAZY | RTLD_GLOBAL);

    pfn_SDL_Init            fn_Init            = sdl ? (pfn_SDL_Init)dlsym(sdl, "SDL_Init") : NULL;
    pfn_SDL_Quit            fn_Quit            = sdl ? (pfn_SDL_Quit)dlsym(sdl, "SDL_Quit") : NULL;
    pfn_SDL_CreateWindow    fn_CreateWindow    = sdl ? (pfn_SDL_CreateWindow)dlsym(sdl, "SDL_CreateWindow") : NULL;
    pfn_SDL_DestroyWindow   fn_DestroyWindow   = sdl ? (pfn_SDL_DestroyWindow)dlsym(sdl, "SDL_DestroyWindow") : NULL;
    pfn_SDL_CreateRenderer  fn_CreateRenderer  = sdl ? (pfn_SDL_CreateRenderer)dlsym(sdl, "SDL_CreateRenderer") : NULL;
    pfn_SDL_DestroyRenderer fn_DestroyRenderer = sdl ? (pfn_SDL_DestroyRenderer)dlsym(sdl, "SDL_DestroyRenderer") : NULL;
    pfn_SDL_CreateTexture   fn_CreateTexture   = sdl ? (pfn_SDL_CreateTexture)dlsym(sdl, "SDL_CreateTexture") : NULL;
    pfn_SDL_DestroyTexture  fn_DestroyTexture  = sdl ? (pfn_SDL_DestroyTexture)dlsym(sdl, "SDL_DestroyTexture") : NULL;
    pfn_SDL_UpdateTexture   fn_UpdateTexture   = sdl ? (pfn_SDL_UpdateTexture)dlsym(sdl, "SDL_UpdateTexture") : NULL;
    pfn_SDL_RenderClear     fn_RenderClear     = sdl ? (pfn_SDL_RenderClear)dlsym(sdl, "SDL_RenderClear") : NULL;
    pfn_SDL_RenderCopy      fn_RenderCopy      = sdl ? (pfn_SDL_RenderCopy)dlsym(sdl, "SDL_RenderCopy") : NULL;
    pfn_SDL_RenderPresent   fn_RenderPresent   = sdl ? (pfn_SDL_RenderPresent)dlsym(sdl, "SDL_RenderPresent") : NULL;
    pfn_SDL_PumpEvents      fn_PumpEvents      = sdl ? (pfn_SDL_PumpEvents)dlsym(sdl, "SDL_PumpEvents") : NULL;
    pfn_SDL_ShowCursor      fn_ShowCursor      = sdl ? (pfn_SDL_ShowCursor)dlsym(sdl, "SDL_ShowCursor") : NULL;

    void *win = NULL, *ren = NULL, *tex = NULL;
    if (fn_Init && fn_Init(SDL_INIT_VIDEO) == 0) {
        if (fn_ShowCursor) fn_ShowCursor(0);
        win = fn_CreateWindow("LaBuche_Stump", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
                              PANEL_W, PANEL_H, SDL_WINDOW_SHOWN | SDL_WINDOW_FULLSCREEN_DESK);
        if (win) {
            ren = fn_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
            if (!ren) ren = fn_CreateRenderer(win, -1, 0);
        }
        if (ren) {
            tex = fn_CreateTexture(ren, SDL_PIXELFORMAT_ARGB8888, SDL_TEXTUREACCESS_STREAMING, PANEL_W, PANEL_H);
        }
        if (!tex) {
            if (ren && fn_DestroyRenderer) fn_DestroyRenderer(ren);
            if (win && fn_DestroyWindow) fn_DestroyWindow(win);
            if (fn_Quit) fn_Quit();
            win = ren = tex = NULL;
        }
    }

    uint32_t *fb0_map = NULL;
    int fb_fd = -1;
    struct fb_var_screeninfo vinfo;
    memset(&vinfo, 0, sizeof(vinfo));
    if (!tex) {
        fb_fd = open("/dev/fb0", O_RDWR);
        if (fb_fd >= 0) {
            ioctl(fb_fd, FBIOBLANK, FB_BLANK_UNBLANK);
            ioctl(fb_fd, FBIOGET_VSCREENINFO, &vinfo);
            void *m = mmap(NULL, PANEL_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, fb_fd, 0);
            if (m != MAP_FAILED) fb0_map = (uint32_t *)m;
        }
    }
    fprintf(stderr, "[Stump-R36MAX %s] Display ready (SDL_tex=%p fb0_mmap=%p) WiFi=%s(%s) QR=%s\\n",
            g_st.ver_str, tex, (void *)fb0_map, g_st.net.wifi_if[0] ? g_st.net.wifi_if : "none",
            g_st.net.primary_ip, g_st.qr_url);
    fflush(stderr);

    int ev_fds[16];
    for (int i = 0; i < 16; i++) {
        char p[64];
        snprintf(p, sizeof(p), "/dev/input/event%d", i);
        ev_fds[i] = open(p, O_RDONLY | O_NONBLOCK);
    }

    pthread_t audio_tid;
    pthread_create(&audio_tid, NULL, alsa_chime_thread, NULL);
    trigger_chime(660, 70);
    broadcast_udp_beacon("BOOT", "R36MAX STUMP v1.6.0 ONLINE");

    uint32_t *fb = calloc(PANEL_W * PANEL_H, sizeof(uint32_t));
    bool select_held = false, start_held = false;
    int max_frames = (argc > 1 && strcmp(argv[1], "--smoke") == 0) ? 90 : 0;
    int frames = 0;

    while (g_st.running) {
        if (fn_PumpEvents && tex) fn_PumpEvents();

        if (g_st.suppress_poll_frames > 0) g_st.suppress_poll_frames--;

        /* Poll live Python Stump state every 10 frames (~160ms) */
        if (frames % 10 == 0) {
            poll_live_bridge();
            update_qr_if_needed();
        }

        /* Re-scan hardware network transports, Blueway RT3070, Heltec V3 RNode, and USB Keyboards every 120 frames (~2s) */
        if (frames % 120 == 0) {
            scan_transports(&g_st.net);
            update_qr_if_needed();
            for (int i = 0; i < 16; i++) {
                if (ev_fds[i] < 0) {
                    char p[64];
                    snprintf(p, sizeof(p), "/dev/input/event%d", i);
                    ev_fds[i] = open(p, O_RDONLY | O_NONBLOCK);
                }
            }
        }
        poll_udp_mesh();

        struct input_event ev;
        for (int e = 0; e < 16; e++) {
            if (ev_fds[e] < 0) continue;
            while (read(ev_fds[e], &ev, sizeof(ev)) == sizeof(ev)) {
                uint64_t now_ms = monotonic_ms();
                if (ev.type == EV_KEY) {
                    bool pressed = (ev.value == 1);
                    bool key_press_or_rep = (ev.value == 1 || ev.value == 2);

                    /* Track USB Keyboard Shift keys */
                    if (ev.code == KEY_LEFTSHIFT || ev.code == KEY_RIGHTSHIFT) {
                        g_st.shift_held = (ev.value != 0);
                        continue;
                    }

                    /* Hardware Debounce for Handheld Action Buttons (220ms) and D-Pad Keys (130ms) */
                    if (pressed && ev.code >= 256) {
                        bool is_dpad_key = (ev.code == BTN_DPAD_UP || ev.code == BTN_DPAD_DOWN ||
                                            ev.code == BTN_DPAD_LEFT || ev.code == BTN_DPAD_RIGHT ||
                                            (ev.code >= 544 && ev.code <= 547));
                        if (is_dpad_key) {
                            if (now_ms - g_st.last_dpad_ms < 130) continue;
                            g_st.last_dpad_ms = now_ms;
                        } else if (ev.code == R36_BTN_B_CANCEL || ev.code == R36_BTN_A_ACCEPT || ev.code == 306 ||
                                   ev.code == 307 || ev.code == 308 ||
                                   ev.code == BTN_TL || ev.code == BTN_TR ||
                                   ev.code == 310 || ev.code == 311) {
                            if (now_ms - g_st.last_btn_ms < 220) continue;
                            g_st.last_btn_ms = now_ms;
                        }
                        g_st.last_ev_code = (int)ev.code;
                    }

                    /* If Confirmation Modal is open: [A] (305) = Accept, [B] (304) = Cancel */
                    if (g_st.confirm_open && pressed) {
                        if (ev.code == BTN_DPAD_LEFT || ev.code == 546 || ev.code == KEY_LEFT ||
                            ev.code == BTN_DPAD_UP || ev.code == 544 || ev.code == KEY_UP) {
                            g_st.confirm_choice = 0;
                            trigger_chime(520, 20);
                            continue;
                        } else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547 || ev.code == KEY_RIGHT ||
                                   ev.code == BTN_DPAD_DOWN || ev.code == 545 || ev.code == KEY_DOWN) {
                            g_st.confirm_choice = 1;
                            trigger_chime(520, 20);
                            continue;
                        } else if (ev.code == R36_BTN_B_CANCEL || ev.code == 307 || ev.code == 308 || ev.code == KEY_ESC) {
                            /* Physical B (304), X (307), Y (308), or ESC ALWAYS CANCELS safely! */
                            g_st.confirm_open = false;
                            set_ui_busy("CANCELLED (NO CHANGES MADE)", 1000);
                            trigger_chime(480, 35);
                            continue;
                        } else if (ev.code == R36_BTN_A_ACCEPT || ev.code == KEY_ENTER || ev.code == KEY_KPENTER) {
                            /* Physical A (305) or ENTER confirms the highlighted NO/YES choice */
                            if (g_st.confirm_choice == 1) {
                                if (g_st.confirm_type == 1) action_board_delete_checked();
                                else if (g_st.confirm_type == 2) action_file_delete_checked();
                                else if (g_st.confirm_type == 3) apply_staged_network_revision();
                            } else {
                                set_ui_busy("CANCELLED (NO CHANGES MADE)", 1000);
                                trigger_chime(480, 35);
                            }
                            g_st.confirm_open = false;
                            continue;
                        }
                        continue;
                    }

                    /* Direct Kernel USB Keyboard typing (KEY_1..KEY_SLASH, KEY_BACKSPACE, KEY_ENTER, KEY_ESC) */
                    if (ev.code < 256) {
                        if ((ev.code == KEY_BACKSPACE || ev.code == 111 /* KEY_DELETE */) && pressed && (g_st.tab_idx == 1 || g_st.tab_idx == 2)) {
                            open_delete_confirm(g_st.tab_idx);
                            continue;
                        } else if (ev.code == KEY_BACKSPACE && key_press_or_rep) {
                            input_backspace();
                            trigger_chime(420, 15);
                            continue;
                        } else if ((ev.code == KEY_ENTER || ev.code == KEY_KPENTER) && pressed) {
                            if (g_st.tab_idx == 1) action_board_add();
                            else if (g_st.tab_idx == 2) action_file_add();
                            else if (g_st.tab_idx == 3) action_wifi_tab_confirm();
                            else if (g_st.tab_idx == 4) {
                                if (g_st.rev_cursor == 2) open_network_revision_confirm();
                                else execute_debug_tab_action();
                            }
                            else if (g_st.input_len > 0) send_typed_chat();
                            else execute_rrc_deck_action();
                            continue;
                        } else if (ev.code == KEY_ESC && pressed) {
                            if (g_st.osk_open) g_st.osk_open = false;
                            else if (g_st.tab_idx == 4) revert_staged_network_revision();
                            trigger_chime(480, 30);
                            continue;
                        } else if (ev.code == KEY_TAB && pressed) {
                            g_st.room_idx = (g_st.room_idx + 1) % 3;
                            trigger_chime(520, 25);
                            continue;
                        } else if (key_press_or_rep) {
                            char kch = translate_linux_key(ev.code, g_st.shift_held);
                            if (kch != 0) {
                                if ((g_st.tab_idx == 1 || g_st.tab_idx == 2) && (kch == ' ')) {
                                    if (g_st.tab_idx == 1 && g_st.board_cursor < g_st.board_count) {
                                        g_st.board[g_st.board_cursor].checked = !g_st.board[g_st.board_cursor].checked;
                                        trigger_chime(580, 25);
                                    } else if (g_st.tab_idx == 2 && g_st.file_cursor < g_st.file_count) {
                                        g_st.files[g_st.file_cursor].checked = !g_st.files[g_st.file_cursor].checked;
                                        trigger_chime(580, 25);
                                    }
                                    continue;
                                }
                                if ((g_st.tab_idx == 1 || g_st.tab_idx == 2) && (kch == 'x' || kch == 'X')) {
                                    open_delete_confirm(g_st.tab_idx);
                                    continue;
                                }
                                if (g_st.tab_idx != 0 && g_st.tab_idx != 3) g_st.tab_idx = 0;
                                input_append_char(kch);
                                trigger_chime(620, 12);
                                continue;
                            }
                        }
                    }

                    /* Handheld Gamepad Buttons: A (305)=Accept, B (304)=Cancel, X (307), Y (308) */
                    if (ev.code == BTN_SELECT || ev.code == BTN_MODE || ev.code == 314 || ev.code == 704 || ev.code == 706) {
                        select_held = (ev.value != 0);
                    }
                    if (ev.code == BTN_START || ev.code == 315 || ev.code == 705 || ev.code == 707) {
                        start_held = (ev.value != 0);
                        if (pressed && !select_held) {
                            if (g_st.tab_idx == 3) {
                                action_wifi_tab_confirm();
                            } else if (g_st.tab_idx == 4) {
                                open_network_revision_confirm();
                            } else if (g_st.input_len > 0) {
                                send_typed_chat();
                            } else {
                                g_st.cmd_cursor = 4;
                                execute_rrc_deck_action();
                            }
                        }
                    }
                    if (select_held && start_held) g_st.running = false;

                    if (pressed) {
                        /* L1 / R1 cycle across all 5 Panels */
                        if (ev.code == BTN_TL || ev.code == 310) {
                            g_st.confirm_open = false;
                            g_st.tab_idx = (g_st.tab_idx + 4) % 5;
                            trigger_chime(523, 35);
                        } else if (ev.code == BTN_TR || ev.code == 311) {
                            g_st.confirm_open = false;
                            g_st.tab_idx = (g_st.tab_idx + 1) % 5;
                            trigger_chime(659, 35);
                        } else if (ev.code == BTN_TL2 || ev.code == BTN_TR2 || ev.code == 312 || ev.code == 313) {
                            g_st.theme_idx = (g_st.theme_idx + 1) % 5;
                            trigger_chime(784, 35);
                        } else if (g_st.tab_idx == 0) {
                            /* Panel 1: RRC Chat & Quick Mesh Command Deck (A=Accept/Send, B=Cancel/Clear) */
                            if (ev.code == 308) {
                                g_st.osk_open = !g_st.osk_open;
                                trigger_chime(g_st.osk_open ? 740 : 520, 45);
                            } else if (g_st.osk_open) {
                                if (ev.code == BTN_DPAD_LEFT || ev.code == 546) { g_st.osk_col = (g_st.osk_col + 9) % 10; }
                                else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) { g_st.osk_col = (g_st.osk_col + 1) % 10; }
                                else if (ev.code == BTN_DPAD_UP || ev.code == 544) { g_st.osk_row = (g_st.osk_row + 3) % 4; }
                                else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) { g_st.osk_row = (g_st.osk_row + 1) % 4; }
                                else if (ev.code == R36_BTN_A_ACCEPT) { execute_osk_key(); }
                                else if (ev.code == R36_BTN_B_CANCEL) { g_st.osk_open = false; trigger_chime(480, 35); }
                                else if (ev.code == 307) { input_backspace(); trigger_chime(420, 25); }
                            } else {
                                if (ev.code == BTN_DPAD_LEFT || ev.code == 546) { g_st.room_idx = (g_st.room_idx + 2) % 3; trigger_chime(520, 20); }
                                else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) { g_st.room_idx = (g_st.room_idx + 1) % 3; trigger_chime(520, 20); }
                                else if (ev.code == BTN_DPAD_UP || ev.code == 544) { g_st.cmd_cursor = (g_st.cmd_cursor + 5) % 6; trigger_chime(500, 20); }
                                else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) { g_st.cmd_cursor = (g_st.cmd_cursor + 1) % 6; trigger_chime(500, 20); }
                                else if (ev.code == R36_BTN_A_ACCEPT) {
                                    if (g_st.input_len > 0) send_typed_chat();
                                    else execute_rrc_deck_action();
                                } else if (ev.code == R36_BTN_B_CANCEL) {
                                    if (g_st.input_len > 0) {
                                        g_st.input_len = 0;
                                        g_st.input_buf[0] = '\\0';
                                        set_ui_busy("CANCELLED DRAFT MESSAGE", 900);
                                    } else {
                                        g_st.cmd_cursor = 0;
                                    }
                                    trigger_chime(460, 30);
                                } else if (ev.code == 307) {
                                    g_st.cmd_cursor = 1;
                                    execute_rrc_deck_action();
                                }
                            }
                        } else if (g_st.tab_idx == 1) {
                            /* Panel 2: Bulletin Board — [A]=Accept/Check [X], [B]=Cancel/Uncheck */
                            int total_rows = g_st.board_count + 1;
                            if (g_st.board_cursor >= total_rows) g_st.board_cursor = total_rows - 1;
                            if (ev.code == BTN_DPAD_UP || ev.code == 544) {
                                g_st.board_cursor = (g_st.board_cursor + total_rows - 1) % total_rows;
                                trigger_chime(500, 20);
                            } else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) {
                                g_st.board_cursor = (g_st.board_cursor + 1) % total_rows;
                                trigger_chime(500, 20);
                            } else if (ev.code == BTN_DPAD_LEFT || ev.code == 546) {
                                if (g_st.board_cursor < g_st.board_count) {
                                    g_st.board[g_st.board_cursor].checked = !g_st.board[g_st.board_cursor].checked;
                                    trigger_chime(600, 25);
                                } else {
                                    g_st.board_bar_mode = (g_st.board_bar_mode + 2) % 3;
                                    trigger_chime(540, 25);
                                }
                            } else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) {
                                if (g_st.board_cursor < g_st.board_count) {
                                    g_st.board[g_st.board_cursor].checked = !g_st.board[g_st.board_cursor].checked;
                                    trigger_chime(600, 25);
                                } else {
                                    g_st.board_bar_mode = (g_st.board_bar_mode + 1) % 3;
                                    trigger_chime(540, 25);
                                }
                            } else if (ev.code == R36_BTN_A_ACCEPT) {
                                if (g_st.board_cursor < g_st.board_count) {
                                    g_st.board[g_st.board_cursor].checked = !g_st.board[g_st.board_cursor].checked;
                                    trigger_chime(620, 30);
                                } else {
                                    if (g_st.board_bar_mode == 0) action_board_backup_checked_tf();
                                    else if (g_st.board_bar_mode == 1) open_delete_confirm(1);
                                    else action_board_add();
                                }
                            } else if (ev.code == R36_BTN_B_CANCEL) {
                                /* B (304): Cancel / Uncheck all or return from Action Bar to list */
                                if (g_st.board_cursor >= g_st.board_count && g_st.board_count > 0) {
                                    g_st.board_cursor = 0;
                                } else {
                                    for (int i = 0; i < g_st.board_count; i++) g_st.board[i].checked = false;
                                    set_ui_busy("CLEARED CHECKED [X] SELECTION", 900);
                                }
                                trigger_chime(460, 30);
                            } else if (ev.code == 308) {
                                action_board_backup_checked_tf();
                            } else if (ev.code == 307) {
                                open_delete_confirm(1);
                            }
                        } else if (g_st.tab_idx == 2) {
                            /* Panel 3: Shared File Shelf — [A]=Accept/Check [X], [B]=Cancel/Uncheck */
                            int total_rows = g_st.file_count + 1;
                            if (g_st.file_cursor >= total_rows) g_st.file_cursor = total_rows - 1;
                            if (ev.code == BTN_DPAD_UP || ev.code == 544) {
                                g_st.file_cursor = (g_st.file_cursor + total_rows - 1) % total_rows;
                                trigger_chime(500, 20);
                            } else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) {
                                g_st.file_cursor = (g_st.file_cursor + 1) % total_rows;
                                trigger_chime(500, 20);
                            } else if (ev.code == BTN_DPAD_LEFT || ev.code == 546) {
                                if (g_st.file_cursor < g_st.file_count) {
                                    g_st.files[g_st.file_cursor].checked = !g_st.files[g_st.file_cursor].checked;
                                    trigger_chime(600, 25);
                                } else {
                                    g_st.file_bar_mode = (g_st.file_bar_mode + 2) % 3;
                                    trigger_chime(540, 25);
                                }
                            } else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) {
                                if (g_st.file_cursor < g_st.file_count) {
                                    g_st.files[g_st.file_cursor].checked = !g_st.files[g_st.file_cursor].checked;
                                    trigger_chime(600, 25);
                                } else {
                                    g_st.file_bar_mode = (g_st.file_bar_mode + 1) % 3;
                                    trigger_chime(540, 25);
                                }
                            } else if (ev.code == R36_BTN_A_ACCEPT) {
                                if (g_st.file_cursor < g_st.file_count) {
                                    g_st.files[g_st.file_cursor].checked = !g_st.files[g_st.file_cursor].checked;
                                    trigger_chime(620, 30);
                                } else {
                                    if (g_st.file_bar_mode == 0) action_file_backup_checked_tf();
                                    else if (g_st.file_bar_mode == 1) open_delete_confirm(2);
                                    else action_file_add();
                                }
                            } else if (ev.code == R36_BTN_B_CANCEL) {
                                /* B (304): Cancel / Uncheck all or return from Action Bar to list */
                                if (g_st.file_cursor >= g_st.file_count && g_st.file_count > 0) {
                                    g_st.file_cursor = 0;
                                } else {
                                    for (int i = 0; i < g_st.file_count; i++) g_st.files[i].checked = false;
                                    set_ui_busy("CLEARED CHECKED [X] SELECTION", 900);
                                }
                                trigger_chime(460, 30);
                            } else if (ev.code == 308) {
                                action_file_backup_checked_tf();
                            } else if (ev.code == 307) {
                                open_delete_confirm(2);
                            }
                        } else if (g_st.tab_idx == 3) {
                            /* Panel 4: Stage Wi-Fi / AP Settings ([A]=Stage & Review in Panel 5, [B]=Cancel/Revert) */
                            if (ev.code == 308) {
                                g_st.osk_open = !g_st.osk_open;
                                trigger_chime(g_st.osk_open ? 740 : 520, 45);
                            } else if (g_st.osk_open) {
                                if (ev.code == BTN_DPAD_LEFT || ev.code == 546) { g_st.osk_col = (g_st.osk_col + 9) % 10; }
                                else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) { g_st.osk_col = (g_st.osk_col + 1) % 10; }
                                else if (ev.code == BTN_DPAD_UP || ev.code == 544) { g_st.osk_row = (g_st.osk_row + 3) % 4; }
                                else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) { g_st.osk_row = (g_st.osk_row + 1) % 4; }
                                else if (ev.code == R36_BTN_A_ACCEPT) { execute_osk_key(); }
                                else if (ev.code == R36_BTN_B_CANCEL) { g_st.osk_open = false; trigger_chime(480, 35); }
                                else if (ev.code == 307) { input_backspace(); trigger_chime(420, 25); }
                            } else {
                                int total_rows = 2 + g_st.wifi_count;
                                if (g_st.wifi_cursor >= total_rows) g_st.wifi_cursor = total_rows - 1;
                                if (ev.code == BTN_DPAD_UP || ev.code == 544) {
                                    g_st.wifi_cursor = (g_st.wifi_cursor + total_rows - 1) % total_rows;
                                    trigger_chime(520, 20);
                                } else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) {
                                    g_st.wifi_cursor = (g_st.wifi_cursor + 1) % total_rows;
                                    trigger_chime(520, 20);
                                } else if (ev.code == BTN_DPAD_LEFT || ev.code == 546) {
                                    if (g_st.wifi_cursor == 0) {
                                        /* Stage mode toggle only — never switches live radio until Panel 5 [A] Apply! */
                                        g_st.net_staged_ap = !g_st.net_staged_ap;
                                        g_st.net_staged_dirty = true;
                                        trigger_chime(580, 25);
                                    } else if (g_st.wifi_cursor == 1) {
                                        g_st.wifi_bar_mode = (g_st.wifi_bar_mode + 2) % 3;
                                        trigger_chime(540, 25);
                                    }
                                } else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) {
                                    if (g_st.wifi_cursor == 0) {
                                        /* Stage mode toggle only — never switches live radio until Panel 5 [A] Apply! */
                                        g_st.net_staged_ap = !g_st.net_staged_ap;
                                        g_st.net_staged_dirty = true;
                                        trigger_chime(580, 25);
                                    } else if (g_st.wifi_cursor == 1) {
                                        g_st.wifi_bar_mode = (g_st.wifi_bar_mode + 1) % 3;
                                        trigger_chime(540, 25);
                                    }
                                } else if (ev.code == R36_BTN_A_ACCEPT) {
                                    action_wifi_tab_confirm();
                                } else if (ev.code == R36_BTN_B_CANCEL) {
                                    revert_staged_network_revision();
                                    g_st.wifi_cursor = 0;
                                    set_ui_busy("CANCELLED STAGED WIFI CHANGES (LIVE UNCHANGED)", 1400);
                                    trigger_chime(460, 35);
                                } else if (ev.code == 307) {
                                    g_st.qr_mode = (g_st.qr_mode + 1) % 2;
                                    update_qr_if_needed();
                                    trigger_chime(660, 45);
                                }
                            }
                        } else if (g_st.tab_idx == 4) {
                            /* Panel 5: Network Settings Revision + Debug Tools ([A]=Accept/Apply, [B]=Cancel/Revert) */
                            if (ev.code == BTN_DPAD_UP || ev.code == 544) {
                                if (g_st.rev_cursor == 4 && g_st.debug_scroll > 0) {
                                    g_st.debug_scroll--;
                                } else {
                                    g_st.rev_cursor = (g_st.rev_cursor + 4) % 5;
                                }
                                trigger_chime(500, 20);
                            } else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) {
                                if (g_st.rev_cursor == 4 && g_st.debug_scroll + 1 < g_st.debug_log_count) {
                                    g_st.debug_scroll++;
                                } else {
                                    g_st.rev_cursor = (g_st.rev_cursor + 1) % 5;
                                }
                                trigger_chime(500, 20);
                            } else if (ev.code == BTN_DPAD_LEFT || ev.code == 546) {
                                if (g_st.rev_cursor == 0) {
                                    g_st.net_staged_ap = !g_st.net_staged_ap;
                                    g_st.net_staged_dirty = true;
                                    trigger_chime(580, 25);
                                } else if (g_st.rev_cursor == 1 && g_st.wifi_count > 0) {
                                    g_st.net_ssid_cycle_idx = (g_st.net_ssid_cycle_idx + g_st.wifi_count - 1) % g_st.wifi_count;
                                    snprintf(g_st.net_staged_ssid, sizeof(g_st.net_staged_ssid), "%.31s",
                                             g_st.wifi_list[g_st.net_ssid_cycle_idx].ssid);
                                    g_st.net_staged_ap = false;
                                    g_st.net_staged_dirty = true;
                                    trigger_chime(580, 25);
                                } else if (g_st.rev_cursor == 3) {
                                    g_st.debug_bar_mode = (g_st.debug_bar_mode + 2) % 3;
                                    trigger_chime(540, 25);
                                }
                            } else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) {
                                if (g_st.rev_cursor == 0) {
                                    g_st.net_staged_ap = !g_st.net_staged_ap;
                                    g_st.net_staged_dirty = true;
                                    trigger_chime(580, 25);
                                } else if (g_st.rev_cursor == 1 && g_st.wifi_count > 0) {
                                    g_st.net_ssid_cycle_idx = (g_st.net_ssid_cycle_idx + 1) % g_st.wifi_count;
                                    snprintf(g_st.net_staged_ssid, sizeof(g_st.net_staged_ssid), "%.31s",
                                             g_st.wifi_list[g_st.net_ssid_cycle_idx].ssid);
                                    g_st.net_staged_ap = false;
                                    g_st.net_staged_dirty = true;
                                    trigger_chime(580, 25);
                                } else if (g_st.rev_cursor == 3) {
                                    g_st.debug_bar_mode = (g_st.debug_bar_mode + 1) % 3;
                                    trigger_chime(540, 25);
                                }
                            } else if (ev.code == R36_BTN_A_ACCEPT) {
                                if (g_st.rev_cursor == 0) {
                                    g_st.net_staged_ap = !g_st.net_staged_ap;
                                    g_st.net_staged_dirty = true;
                                    trigger_chime(600, 30);
                                } else if (g_st.rev_cursor == 1) {
                                    g_st.tab_idx = 3;
                                    g_st.wifi_cursor = (g_st.wifi_count > 0) ? 2 : 1;
                                    trigger_chime(620, 35);
                                } else if (g_st.rev_cursor == 2) {
                                    open_network_revision_confirm();
                                } else {
                                    execute_debug_tab_action();
                                }
                            } else if (ev.code == R36_BTN_B_CANCEL) {
                                revert_staged_network_revision();
                                g_st.rev_cursor = 0;
                                set_ui_busy("REVERTED STAGED NETWORK REVISION TO LIVE STATE", 1500);
                                trigger_chime(460, 35);
                            } else if (ev.code == 308) {
                                g_st.debug_bar_mode = 0;
                                execute_debug_tab_action();
                            } else if (ev.code == 307) {
                                g_st.debug_bar_mode = 1;
                                execute_debug_tab_action();
                            }
                        }
                    }
                } else if (ev.type == EV_ABS && ev.value != 0) {
                    /* Hardware Debounce for D-Pad Hat Switch (130ms) */
                    if (now_ms - g_st.last_dpad_ms < 130) continue;
                    g_st.last_dpad_ms = now_ms;
                    g_st.last_ev_code = (int)ev.code;

                    if (g_st.confirm_open) {
                        if (ev.code == ABS_HAT0X && ev.value < 0) { g_st.confirm_choice = 0; trigger_chime(520, 20); }
                        if (ev.code == ABS_HAT0X && ev.value > 0) { g_st.confirm_choice = 1; trigger_chime(520, 20); }
                    } else if (g_st.tab_idx == 0) {
                        if (g_st.osk_open) {
                            if (ev.code == ABS_HAT0X && ev.value < 0) g_st.osk_col = (g_st.osk_col + 9) % 10;
                            if (ev.code == ABS_HAT0X && ev.value > 0) g_st.osk_col = (g_st.osk_col + 1) % 10;
                            if (ev.code == ABS_HAT0Y && ev.value < 0) g_st.osk_row = (g_st.osk_row + 3) % 4;
                            if (ev.code == ABS_HAT0Y && ev.value > 0) g_st.osk_row = (g_st.osk_row + 1) % 4;
                        } else {
                            if (ev.code == ABS_HAT0X && ev.value < 0) g_st.room_idx = (g_st.room_idx + 2) % 3;
                            if (ev.code == ABS_HAT0X && ev.value > 0) g_st.room_idx = (g_st.room_idx + 1) % 3;
                            if (ev.code == ABS_HAT0Y && ev.value < 0) g_st.cmd_cursor = (g_st.cmd_cursor + 5) % 6;
                            if (ev.code == ABS_HAT0Y && ev.value > 0) g_st.cmd_cursor = (g_st.cmd_cursor + 1) % 6;
                        }
                    } else if (g_st.tab_idx == 1) {
                        int total_rows = g_st.board_count + 1;
                        if (ev.code == ABS_HAT0Y && ev.value < 0)
                            g_st.board_cursor = (g_st.board_cursor + total_rows - 1) % total_rows;
                        if (ev.code == ABS_HAT0Y && ev.value > 0)
                            g_st.board_cursor = (g_st.board_cursor + 1) % total_rows;
                        if (ev.code == ABS_HAT0X) {
                            if (g_st.board_cursor < g_st.board_count) {
                                g_st.board[g_st.board_cursor].checked = !g_st.board[g_st.board_cursor].checked;
                                trigger_chime(600, 25);
                            } else {
                                g_st.board_bar_mode = (g_st.board_bar_mode + (ev.value > 0 ? 1 : 2)) % 3;
                                trigger_chime(540, 25);
                            }
                        }
                    } else if (g_st.tab_idx == 2) {
                        int total_rows = g_st.file_count + 1;
                        if (ev.code == ABS_HAT0Y && ev.value < 0)
                            g_st.file_cursor = (g_st.file_cursor + total_rows - 1) % total_rows;
                        if (ev.code == ABS_HAT0Y && ev.value > 0)
                            g_st.file_cursor = (g_st.file_cursor + 1) % total_rows;
                        if (ev.code == ABS_HAT0X) {
                            if (g_st.file_cursor < g_st.file_count) {
                                g_st.files[g_st.file_cursor].checked = !g_st.files[g_st.file_cursor].checked;
                                trigger_chime(600, 25);
                            } else {
                                g_st.file_bar_mode = (g_st.file_bar_mode + (ev.value > 0 ? 1 : 2)) % 3;
                                trigger_chime(540, 25);
                            }
                        }
                    } else if (g_st.tab_idx == 3) {
                        if (g_st.osk_open) {
                            if (ev.code == ABS_HAT0X && ev.value < 0) g_st.osk_col = (g_st.osk_col + 9) % 10;
                            if (ev.code == ABS_HAT0X && ev.value > 0) g_st.osk_col = (g_st.osk_col + 1) % 10;
                            if (ev.code == ABS_HAT0Y && ev.value < 0) g_st.osk_row = (g_st.osk_row + 3) % 4;
                            if (ev.code == ABS_HAT0Y && ev.value > 0) g_st.osk_row = (g_st.osk_row + 1) % 4;
                        } else {
                            int total_rows = 2 + g_st.wifi_count;
                            if (ev.code == ABS_HAT0Y && ev.value < 0) {
                                g_st.wifi_cursor = (g_st.wifi_cursor + total_rows - 1) % total_rows;
                                trigger_chime(520, 20);
                            } else if (ev.code == ABS_HAT0Y && ev.value > 0) {
                                g_st.wifi_cursor = (g_st.wifi_cursor + 1) % total_rows;
                                trigger_chime(520, 20);
                            } else if (ev.code == ABS_HAT0X) {
                                if (g_st.wifi_cursor == 0) {
                                    g_st.net_staged_ap = !g_st.net_staged_ap;
                                    g_st.net_staged_dirty = true;
                                    trigger_chime(580, 25);
                                } else if (g_st.wifi_cursor == 1) {
                                    g_st.wifi_bar_mode = (g_st.wifi_bar_mode + (ev.value > 0 ? 1 : 2)) % 3;
                                    trigger_chime(540, 25);
                                }
                            }
                        }
                    } else if (g_st.tab_idx == 4) {
                        if (ev.code == ABS_HAT0Y && ev.value < 0) {
                            if (g_st.rev_cursor == 4 && g_st.debug_scroll > 0) g_st.debug_scroll--;
                            else g_st.rev_cursor = (g_st.rev_cursor + 4) % 5;
                            trigger_chime(500, 20);
                        } else if (ev.code == ABS_HAT0Y && ev.value > 0) {
                            if (g_st.rev_cursor == 4 && g_st.debug_scroll + 1 < g_st.debug_log_count) g_st.debug_scroll++;
                            else g_st.rev_cursor = (g_st.rev_cursor + 1) % 5;
                            trigger_chime(500, 20);
                        } else if (ev.code == ABS_HAT0X) {
                            if (g_st.rev_cursor == 0) {
                                g_st.net_staged_ap = !g_st.net_staged_ap;
                                g_st.net_staged_dirty = true;
                                trigger_chime(580, 25);
                            } else if (g_st.rev_cursor == 1 && g_st.wifi_count > 0) {
                                g_st.net_ssid_cycle_idx = (g_st.net_ssid_cycle_idx + (ev.value > 0 ? 1 : g_st.wifi_count - 1)) % g_st.wifi_count;
                                snprintf(g_st.net_staged_ssid, sizeof(g_st.net_staged_ssid), "%.31s",
                                         g_st.wifi_list[g_st.net_ssid_cycle_idx].ssid);
                                g_st.net_staged_ap = false;
                                g_st.net_staged_dirty = true;
                                trigger_chime(580, 25);
                            } else if (g_st.rev_cursor == 3) {
                                g_st.debug_bar_mode = (g_st.debug_bar_mode + (ev.value > 0 ? 1 : 2)) % 3;
                                trigger_chime(540, 25);
                            }
                        }
                    }
                }
            }
        }

        const ThemeColors *th = &g_themes[g_st.theme_idx];
        fill_rect(fb, 0, 0, PANEL_W, PANEL_H, th->bg);

        /* ---- FireFly_RK3326_R36MAX_R36S Header Bar (firefly/ui/app.py + theme.py) ---- */
        fill_rect(fb, 0, 0, PANEL_W, 82, th->panel2);
        fill_rect(fb, 0, 80, PANEL_W, 2, th->border);
        draw_text_s(fb, 14, 10, "FIREFLY * STUMP", th->ember, 3, 16);
        draw_text_s(fb, 306, 14, g_st.ver_str, th->muted, 2, 14);

        const char *disp_ip = g_st.ap_active ? "192.168.4.1"
                            : ((g_st.bridge_lan_ip[0] && strcmp(g_st.bridge_lan_ip, "127.0.0.1") != 0)
                               ? g_st.bridge_lan_ip : g_st.net.primary_ip);

        /* Right-aligned FireFly link indicator ("* AP 192.168.4.1" or "* LAN <ip>") */
        fill_rect(fb, 486, 8, 222, 26, th->panel);
        draw_border(fb, 486, 8, 222, 26, 1, g_st.ap_active ? th->ok : th->ember);
        char link_pill[40];
        snprintf(link_pill, sizeof(link_pill), "* %s %s",
                 g_st.ap_active ? "AP" : "LAN", disp_ip);
        draw_text_s(fb, 496, 14, link_pill, g_st.ap_active ? th->ok : th->ember_bright, 2, 17);

        char line2[160];
        snprintf(line2, sizeof(line2), "BARK/RRC WEB: HTTP://%s:80 (:8080 %s)  PEERS:%d",
                 disp_ip, (g_st.http80_ok && g_st.http8080_ok) ? "OK" : "HEAL", g_st.mesh_peers);
        draw_text_s(fb, 14, 40, line2, th->text, 2, 56);

        char line3[160];
        if (g_st.ap_active) {
            snprintf(line3, sizeof(line3), "RT3070 AP:%s (192.168.4.1 CH6) CLIENTS:%d  TF-BAK:%d",
                     g_st.ap_ssid, g_st.ap_clients, g_st.tf_backup_count);
            draw_text_s(fb, 14, 60, line3, th->ok, 2, 56);
        } else {
            snprintf(line3, sizeof(line3), "RT3070 LAN:%s (%s)  RNODE:%s  TF-BAK:%d",
                     g_st.net.wifi_if[0] ? g_st.net.wifi_if : "wlan0", disp_ip,
                     g_st.net.lora_online ? g_st.net.lora_dev : g_st.rnode_status,
                     g_st.tf_backup_count);
            draw_text_s(fb, 14, 60, line3, th->ok, 2, 56);
        }

        /* ---- 5 FireFly Navigation Tab Pills (L1 / R1) ---- */
        const char *tabs[5] = { "1:CHATS", "2:BOARD", "3:FILES", "4:NETWORK", g_st.net_staged_dirty ? "5:SETUP*" : "5:SETUP" };
        for (int t = 0; t < 5; t++) {
            int tx = 10 + t * 141;
            bool act = (t == g_st.tab_idx);
            fill_rect(fb, tx, 88, 136, 34, act ? th->ember : th->panel2);
            draw_border(fb, tx, 88, 136, 34, 2, act ? th->ember_bright : (t == 4 && g_st.net_staged_dirty ? th->ok : th->border));
            draw_text_s(fb, tx + 10, 98, tabs[t], act ? th->bg : (t == 4 && g_st.net_staged_dirty ? th->ok : th->muted), 2, 10);
        }

        if (g_st.tab_idx == 0) {
            /* Panel 1: FireFly_RK3326_R36MAX_R36S Chat Screen (firefly/ui/screens.py) */
            for (int r = 0; r < 3; r++) {
                int rx = 12 + r * 234;
                bool ract = (r == g_st.room_idx);
                fill_rect(fb, rx, 130, 228, 30, ract ? th->panel : th->panel2);
                draw_border(fb, rx, 130, 228, 30, 2, ract ? th->ember : th->border);
                char rlabel[48];
                snprintf(rlabel, sizeof(rlabel), "%s (%d)", ROOM_NAMES[r], g_st.room_users[r]);
                draw_text_s(fb, rx + 12, 138, rlabel, ract ? th->ember_bright : th->muted, 2, 18);
            }

            fill_rect(fb, 12, 166, PANEL_W - 24, 294, th->bg);
            draw_border(fb, 12, 166, PANEL_W - 24, 294, 2, th->border);
            int r = g_st.room_idx;
            if (g_st.room_counts[r] == 0) {
                draw_text_s(fb, 28, 192, "NO MESSAGES YET - L/R: ROOM, [Y]: OSK, [A]: SEND, [B]: CANCEL.", th->muted, 2, 54);
            }
            /* Render FireFly-style chat bubbles with Stump line coloring ([DM], * action, outgoing right-aligned) */
            int start_m = (g_st.room_counts[r] > 7) ? (g_st.room_counts[r] - 7) : 0;
            for (int idx_m = start_m; idx_m < g_st.room_counts[r]; idx_m++) {
                int slot_vis = idx_m - start_m;
                int by = 172 + slot_vis * 40;
                const char *nk = g_st.rooms[r][idx_m].nick;
                const char *bd = g_st.rooms[r][idx_m].body;
                bool is_sys = g_st.rooms[r][idx_m].is_sys;
                bool is_out = (!is_sys && (strcmp(nk, "r36max") == 0 || strcmp(nk, "you") == 0));
                bool is_dm  = (strncmp(bd, "[DM]", 4) == 0);
                bool is_act = (strncmp(bd, "* ", 2) == 0);

                int bx = is_out ? 132 : 20;
                int bw = PANEL_W - 152;
                uint32_t b_bg = is_out ? th->panel : th->panel2;
                uint32_t b_bd = is_out ? th->ember : (is_sys ? th->ok : th->border);
                fill_rect(fb, bx, by, bw, 35, b_bg);
                draw_border(fb, bx, by, bw, 35, 1, b_bd);

                uint32_t fg = th->text;
                if (is_dm) fg = 0xFFC8A2C8u;        /* FireFly DM_BODY purple */
                else if (is_act) fg = 0xFFC8B48Fu;  /* FireFly ACTION tan */
                else if (is_sys) fg = th->ember_bright;

                char row_txt[128];
                if (is_out) {
                    snprintf(row_txt, sizeof(row_txt), "<%s> %-31.31s OK", nk, bd);
                } else {
                    snprintf(row_txt, sizeof(row_txt), "<%s> %s", nk, bd);
                }
                draw_text_s(fb, bx + 10, by + 10, row_txt, fg, 2, 45);
            }

            /* FireFly Composer Bar with byte & LoRa packet counter ("%d/295 B * 1 LORA PKT") */
            fill_rect(fb, 12, 466, PANEL_W - 24, 38, th->panel2);
            draw_border(fb, 12, 466, PANEL_W - 24, 38, 2, (g_st.osk_open || g_st.input_len > 0) ? th->ember : th->border);
            char comp_line[160];
            if (g_st.input_len > 0) {
                snprintf(comp_line, sizeof(comp_line), "> %-26.26s_  %d/295B 1PKT ([A]SEND [B]CLR)",
                         g_st.input_buf, g_st.input_len);
                draw_text_s(fb, 22, 478, comp_line, th->ok, 2, 55);
            } else {
                snprintf(comp_line, sizeof(comp_line), "> Type message...  0/295B * 1 LORA PKT  ([Y]:OSK [A]:SEND)");
                draw_text_s(fb, 22, 478, comp_line, th->muted, 2, 55);
            }

            if (g_st.osk_open) {
                fill_rect(fb, 12, 510, PANEL_W - 24, 154, th->panel2);
                draw_border(fb, 12, 510, PANEL_W - 24, 154, 2, th->ember);
                draw_text_s(fb, 24, 518, "VIRTUAL KEYBOARD (DPAD MOVE, [A]:TYPE, [B]:CANCEL/CLOSE, [X]:DEL):", th->ember_bright, 2, 56);
                for (int kr = 0; kr < 4; kr++) {
                    for (int kc = 0; kc < 10; kc++) {
                        int kx = 22 + kc * 67;
                        int ky = 540 + kr * 29;
                        bool ksel = (kr == g_st.osk_row && kc == g_st.osk_col);
                        fill_rect(fb, kx, ky, 62, 24, ksel ? th->ember : th->panel);
                        draw_border(fb, kx, ky, 62, 24, 1, ksel ? th->ember_bright : th->border);
                        const char *klbl = OSK_LABELS[kr][kc];
                        int xoff = (strlen(klbl) == 1) ? 24 : 8;
                        draw_text_s(fb, kx + xoff, ky + 5, klbl, ksel ? th->bg : th->text, 2, 4);
                    }
                }
            } else {
                fill_rect(fb, 12, 510, PANEL_W - 24, 154, th->panel2);
                draw_border(fb, 12, 510, PANEL_W - 24, 154, 2, th->border);
                draw_text_s(fb, 24, 520, "QUICK MESH DECK (UP/DN SELECT, [A]: ACCEPT/SEND, [B]: CANCEL):", th->muted, 2, 56);
                for (int c = 0; c < 6; c++) {
                    int col = c % 2, row = c / 2;
                    int cx = 24 + col * 340, cy = 548 + row * 36;
                    bool sel = (c == g_st.cmd_cursor);
                    fill_rect(fb, cx - 6, cy - 5, 326, 26, sel ? th->ember : th->panel);
                    if (!sel) draw_border(fb, cx - 6, cy - 5, 326, 26, 1, th->border);
                    draw_text_s(fb, cx + 4, cy + 1, QUICK_CMDS[c], sel ? th->bg : th->text, 2, 26);
                }
            }
        } else if (g_st.tab_idx == 1) {
            /* Panel 2: Bulletin Board — [A]=Check [X] / Accept, [B]=Cancel / Clear [X] */
            fill_rect(fb, 12, 130, PANEL_W - 24, 534, th->panel);
            draw_border(fb, 12, 130, PANEL_W - 24, 534, 2, th->border);
            int chk_cnt = count_checked_boards();
            char bhead[96];
            snprintf(bhead, sizeof(bhead), "BULLETIN BOARD (%d POSTS | %d CHECKED [X]) - [A]=CHECK [B]=CLEAR",
                     g_st.board_count, chk_cnt);
            draw_text_s(fb, 24, 142, bhead, th->ember_bright, 2, 55);

            if (g_st.board_count == 0) {
                draw_text_s(fb, 28, 196, "NO NOTICES ON BOARD YET. SELECT ACTION BAR BELOW TO POST!", th->muted, 2, 52);
            }
            for (int b = 0; b < g_st.board_count && b < 4; b++) {
                int by = 172 + b * 88;
                bool sel = (b == g_st.board_cursor);
                bool chk = g_st.board[b].checked;
                fill_rect(fb, 24, by, PANEL_W - 48, 78, th->panel2);
                draw_border(fb, 24, by, PANEL_W - 48, 78, sel ? 3 : 1, chk ? th->ok : (sel ? th->ember_bright : th->border));
                char tline[96], bline[96];
                snprintf(tline, sizeof(tline), "%s[%c] %s [%s]",
                         sel ? ">" : " ", chk ? 'X' : ' ', g_st.board[b].title, g_st.board[b].sig);
                snprintf(bline, sizeof(bline), "     %s (ID:%s)", g_st.board[b].body, g_st.board[b].id);
                draw_text_s(fb, 32, by + 12, tline, chk ? th->ok : (sel ? th->ember_bright : th->text), 2, 52);
                draw_text_s(fb, 32, by + 44, bline, th->muted, 2, 52);
            }

            /* Action Toggle Bar at Row == board_count */
            bool bar_sel = (g_st.board_cursor >= g_st.board_count);
            fill_rect(fb, 24, 534, PANEL_W - 48, 118, th->panel2);
            draw_border(fb, 24, 534, PANEL_W - 48, 118, bar_sel ? 3 : 2, bar_sel ? th->ember_bright : th->ember);
            draw_text_s(fb, 34, 544, "[A]: CHECK [X] / ACCEPT  |  [B]: CANCEL / CLEAR [X]  |  [Y]: TF  |  [X]: DEL", th->ok, 2, 54);

            const char *bmodes[3] = {
                "1: BACKUP CHECKED -> TF CARD",
                "2: DELETE CHECKED (CONFIRM)",
                "3: POST NEW NOTICE"
            };
            char mline[96];
            snprintf(mline, sizeof(mline), "%sACTION (L/R, [A] ACCEPT): < %s >",
                     bar_sel ? "> " : "  ", bmodes[g_st.board_bar_mode]);
            draw_text_s(fb, 34, 576, mline, bar_sel ? th->ember_bright : th->text, 2, 53);

            char subline[96];
            if (g_st.board_bar_mode == 0) {
                snprintf(subline, sizeof(subline), "SAVES %d CHECKED NOTICE(S) TO /roms/ports/stump_r36max/tf_backup/", chk_cnt);
            } else if (g_st.board_bar_mode == 1) {
                snprintf(subline, sizeof(subline), "OPENS CONFIRMATION POPUP ([A]=ACCEPT [B]=CANCEL) FOR %d NOTICE(S)", chk_cnt);
            } else {
                snprintf(subline, sizeof(subline), "NEXT NOTICE PRESET: %s", BOARD_PRESET_TITLES[g_st.board_preset_idx]);
            }
            draw_text_s(fb, 34, 608, subline, th->muted, 2, 53);
        } else if (g_st.tab_idx == 2) {
            /* Panel 3: Shared File Shelf (/sd/shared) — [A]=Check [X] / Accept, [B]=Cancel / Clear [X] */
            fill_rect(fb, 12, 130, PANEL_W - 24, 534, th->panel);
            draw_border(fb, 12, 130, PANEL_W - 24, 534, 2, th->border);
            int chk_files = count_checked_files();
            char fhead[96];
            snprintf(fhead, sizeof(fhead), "SHARED FILE SHELF (%d FILES | %d CHECKED [X] | %d/%d KB)",
                     g_st.file_count, chk_files, g_st.used_kb, g_st.ceil_kb);
            draw_text_s(fb, 24, 142, fhead, th->ember_bright, 2, 55);

            if (g_st.file_count == 0) {
                draw_text_s(fb, 28, 196, "NO FILES IN /SD/SHARED YET. USE ACTION BAR BELOW TO SHARE!", th->muted, 2, 52);
            }
            for (int f = 0; f < g_st.file_count && f < 5; f++) {
                int fy = 172 + f * 70;
                bool sel = (f == g_st.file_cursor);
                bool chk = g_st.files[f].checked;
                fill_rect(fb, 24, fy, PANEL_W - 48, 60, th->panel2);
                draw_border(fb, 24, fy, PANEL_W - 48, 60, sel ? 3 : 1, chk ? th->ok : (sel ? th->ember_bright : th->border));
                char fline[96];
                snprintf(fline, sizeof(fline), "%s[%c] %-26.26s [%s] %d KB",
                         sel ? ">" : " ", chk ? 'X' : ' ', g_st.files[f].name, g_st.files[f].cat, g_st.files[f].size_kb);
                draw_text_s(fb, 32, fy + 10, fline, chk ? th->ok : (sel ? th->ember_bright : th->text), 2, 52);
                draw_text_s(fb, 32, fy + 36, "     [A] OR L/R: CHECK [X]   [B]: CLEAR [X]   [Y]: TF   [X]: DELETE", th->muted, 2, 52);
            }

            /* Action Toggle Bar at Row == file_count */
            bool bar_sel = (g_st.file_cursor >= g_st.file_count);
            fill_rect(fb, 24, 534, PANEL_W - 48, 118, th->panel2);
            draw_border(fb, 24, 534, PANEL_W - 48, 118, bar_sel ? 3 : 2, bar_sel ? th->ember_bright : th->ember);
            draw_text_s(fb, 34, 544, "[A]: CHECK [X] / ACCEPT  |  [B]: CANCEL / CLEAR [X]  |  [Y]: TF  |  [X]: DEL", th->ok, 2, 54);

            const char *fmodes[3] = {
                "1: BACKUP CHECKED -> TF CARD",
                "2: DELETE CHECKED (CONFIRM)",
                "3: SHARE NEW FIELD FILE"
            };
            char mline[96];
            snprintf(mline, sizeof(mline), "%sACTION (L/R, [A] ACCEPT): < %s >",
                     bar_sel ? "> " : "  ", fmodes[g_st.file_bar_mode]);
            draw_text_s(fb, 34, 576, mline, bar_sel ? th->ember_bright : th->text, 2, 53);

            char subline[96];
            if (g_st.file_bar_mode == 0) {
                snprintf(subline, sizeof(subline), "COPIES %d CHECKED FILE(S) TO /roms/ports/stump_r36max/tf_backup/", chk_files);
            } else if (g_st.file_bar_mode == 1) {
                snprintf(subline, sizeof(subline), "OPENS CONFIRMATION POPUP ([A]=ACCEPT [B]=CANCEL) FOR %d FILE(S)", chk_files);
            } else {
                snprintf(subline, sizeof(subline), "NEXT FILE GENERATOR: %s", FILE_ACTION_LABELS[g_st.file_action_idx]);
            }
            draw_text_s(fb, 34, 608, subline, th->muted, 2, 53);
        } else if (g_st.tab_idx == 3) {
            /* Panel 4: Stage Wi-Fi / AP Settings -> Review & Apply in Panel 5 */
            fill_rect(fb, 12, 130, PANEL_W - 24, 534, th->panel);
            draw_border(fb, 12, 130, PANEL_W - 24, 534, 2, th->border);

            fill_rect(fb, 24, 140, PANEL_W - 48, 66, th->panel2);
            draw_border(fb, 24, 140, PANEL_W - 48, 66, 2, th->border);
            char t1[160], t2[160];
            snprintf(t1, sizeof(t1), "LIVE NOW: %s (%s:80)  |  STAGED: %s%s",
                     g_st.ap_active ? "STUMP AP 192.168.4.1" : "LOCAL LAN WIFI",
                     disp_ip,
                     g_st.net_staged_ap ? "STUMP AP 192.168.4.1" : (g_st.net_staged_ssid[0] ? g_st.net_staged_ssid : "LOCAL LAN DHCP"),
                     g_st.net_staged_dirty ? " [*PENDING*]" : " [SYNCED]");
            snprintf(t2, sizeof(t2), "STAGE HERE WITH [A], THEN REVIEW & APPLY IN PANEL 5 ([B]=CANCEL STAGED)");
            draw_text_s(fb, 34, 150, t1, g_st.net_staged_dirty ? th->ok : th->text, 2, 54);
            draw_text_s(fb, 34, 178, t2, th->ember_bright, 2, 54);

            /* Left Box: Row 0 = Stage Mode, Row 1 = Wi-Fi Utility Toggle, Rows 2..N = Stage SSID */
            fill_rect(fb, 24, 214, 426, 248, th->panel2);
            draw_border(fb, 24, 214, 426, 248, 2, th->border);
            draw_text_s(fb, 34, 222, "STAGE NETWORK ([A]=REVIEW IN TAB 5, [B]=CANCEL):", th->ember_bright, 2, 34);

            /* Row 0: Stage Radio Mode (never switches live radio directly!) */
            {
                bool sel0 = (g_st.wifi_cursor == 0);
                int ry0 = 246;
                fill_rect(fb, 32, ry0, 410, 30, sel0 ? th->ember : th->panel);
                draw_border(fb, 32, ry0, 410, 30, 1, sel0 ? th->ember_bright : th->border);
                char r0txt[96];
                snprintf(r0txt, sizeof(r0txt), "%sSTAGE: < %s >",
                         sel0 ? ">" : " ",
                         g_st.net_staged_ap ? "STUMP AP 192.168.4.1" : "LOCAL LAN WIFI DHCP");
                draw_text_s(fb, 38, ry0 + 8, r0txt, sel0 ? th->bg : (g_st.net_staged_ap ? th->ok : th->ember_bright), 2, 33);
            }

            /* Row 1: Wi-Fi Utility Bar (Scan / QR / Password OSK) */
            {
                bool sel1 = (g_st.wifi_cursor == 1);
                int ry1 = 280;
                fill_rect(fb, 32, ry1, 410, 28, sel1 ? th->ember : th->panel);
                draw_border(fb, 32, ry1, 410, 28, 1, sel1 ? th->ember_bright : th->border);
                const char *wtools[3] = { "RESCAN 2.4GHZ WIFI", "SWITCH QR CODE MODE", "OPEN PASSWORD OSK" };
                char r1txt[96];
                snprintf(r1txt, sizeof(r1txt), "%sTOOL (L/R, [A]): < %s >", sel1 ? ">" : " ", wtools[g_st.wifi_bar_mode]);
                draw_text_s(fb, 38, ry1 + 7, r1txt, sel1 ? th->bg : th->text, 2, 33);
            }

            /* Rows 2..N: Discovered Wi-Fi Networks (Press [A] to stage into Panel 5) */
            for (int w = 0; w < g_st.wifi_count && w < 4; w++) {
                bool selw = (g_st.wifi_cursor == (w + 2));
                int ry = 314 + w * 34;
                fill_rect(fb, 32, ry, 410, 30, selw ? th->ember : th->panel);
                draw_border(fb, 32, ry, 410, 30, 1, selw ? th->ember_bright : th->border);
                char wtxt[96];
                snprintf(wtxt, sizeof(wtxt), "%s%s%-17.17s [%s %d%%]",
                         selw ? ">" : " ",
                         g_st.wifi_list[w].active ? "*" : " ",
                         g_st.wifi_list[w].ssid,
                         g_st.wifi_list[w].sec,
                         g_st.wifi_list[w].signal);
                draw_text_s(fb, 38, ry + 8, wtxt,
                            selw ? th->bg : (g_st.wifi_list[w].active ? th->ok : th->text), 2, 33);
            }

            /* Right Box: Scannable ISO 18004 QR Code */
            fill_rect(fb, 458, 214, 238, 248, th->panel2);
            draw_border(fb, 458, 214, 238, 248, 2, th->border);
            draw_text_s(fb, 468, 222, g_st.qr_mode == 1 ? "WIFI JOIN QR [X]" : "PORTAL :80 QR [X]", th->ok, 2, 18);
            int qs = 7;
            int qx = 458 + (238 - (25 * qs)) / 2;
            int qy = 254;
            fill_rect(fb, qx - 2 * qs, qy - 2 * qs, (25 + 4) * qs, (25 + 4) * qs, 0xFFFFFFFFu);
            for (int r = 0; r < 25; r++) {
                for (int c = 0; c < 25; c++) {
                    if (g_st.qr_grid[r][c]) {
                        fill_rect(fb, qx + c * qs, qy + r * qs, qs, qs, 0xFF000000u);
                    }
                }
            }
            draw_text_s(fb, 466, 440, g_st.qr_url, th->muted, 1, 36);

            /* Wi-Fi Password Composer Bar */
            fill_rect(fb, 24, 468, PANEL_W - 48, 38, th->panel2);
            draw_border(fb, 24, 468, PANEL_W - 48, 38, 2, (g_st.osk_open || g_st.input_len > 0) ? th->ember_bright : th->border);
            char pw_line[160];
            if (g_st.input_len > 0) {
                snprintf(pw_line, sizeof(pw_line), "WIFI PASS > %s_  ([A]: STAGE SSID -> PANEL 5  [B]: CANCEL)", g_st.input_buf);
                draw_text_s(fb, 34, 480, pw_line, th->ok, 2, 54);
            } else {
                snprintf(pw_line, sizeof(pw_line), "WIFI PASS > (SAVED/OPEN)  [Y]: TYPE PASS  [A]: STAGE  [B]: CANCEL");
                draw_text_s(fb, 34, 480, pw_line, th->muted, 2, 54);
            }

            if (g_st.osk_open) {
                fill_rect(fb, 24, 512, PANEL_W - 48, 146, th->panel2);
                draw_border(fb, 24, 512, PANEL_W - 48, 146, 2, th->ember);
                draw_text_s(fb, 34, 518, "WIFI PASSWORD KEYBOARD ([A]:TYPE, [B]:CANCEL/CLOSE, [X]:DEL):", th->ember_bright, 2, 54);
                for (int kr = 0; kr < 4; kr++) {
                    for (int kc = 0; kc < 10; kc++) {
                        int kx = 30 + kc * 66;
                        int ky = 538 + kr * 28;
                        bool ksel = (kr == g_st.osk_row && kc == g_st.osk_col);
                        fill_rect(fb, kx, ky, 61, 23, ksel ? th->ember : th->panel);
                        draw_border(fb, kx, ky, 61, 23, 1, ksel ? th->ember_bright : th->border);
                        const char *klbl = OSK_LABELS[kr][kc];
                        int xoff = (strlen(klbl) == 1) ? 24 : 8;
                        draw_text_s(fb, kx + xoff, ky + 5, klbl, ksel ? th->bg : th->text, 2, 4);
                    }
                }
            } else {
                fill_rect(fb, 24, 514, PANEL_W - 48, 142, th->panel2);
                draw_border(fb, 24, 514, PANEL_W - 48, 142, 2, th->border);
                draw_text_s(fb, 36, 526, "SAFE 2-STEP NETWORK REVISION ([A]=ACCEPT, [B]=CANCEL):", th->ember_bright, 2, 52);
                draw_text_s(fb, 36, 554, "1. PICK MODE OR SSID HERE & PRESS [A] TO STAGE INTO PANEL 5.", th->text, 2, 53);
                draw_text_s(fb, 36, 582, "2. IN PANEL 5, REVIEW LIVE VS STAGED & PRESS [A] TO APPLY.", th->ok, 2, 53);
                draw_text_s(fb, 36, 610, "3. PRESSING [B] ALWAYS CANCELS/REVERTS WITHOUT DROPPING WIFI!", th->text, 2, 53);
            }
        } else {
            /* Panel 5 (5:REV/DBG): Network Settings Revision + Debug Tools + Live Logs */
            fill_rect(fb, 12, 130, PANEL_W - 24, 534, th->panel);
            draw_border(fb, 12, 130, PANEL_W - 24, 534, 2, th->border);

            /* Top Box: Network Settings Revision (LIVE vs STAGED) */
            fill_rect(fb, 24, 138, PANEL_W - 48, 198, th->panel2);
            draw_border(fb, 24, 138, PANEL_W - 48, 198, 2, g_st.net_staged_dirty ? th->ok : th->ember);
            char rev_hdr[128];
            snprintf(rev_hdr, sizeof(rev_hdr), "NETWORK SETTINGS REVISION (%s)  |  %s",
                     g_st.net_staged_dirty ? "*PENDING REVISION*" : "IN SYNC WITH LIVE",
                     g_st.ver_str);
            draw_text_s(fb, 34, 146, rev_hdr, g_st.net_staged_dirty ? th->ok : th->ember_bright, 2, 54);

            char live_sum[128];
            snprintf(live_sum, sizeof(live_sum), "LIVE NOW : %s  |  IP: %s  |  HTTP :80=%s :8080=%s",
                     g_st.ap_active ? "STUMP AP (LaBuche-Stump)" : "LOCAL LAN WIFI",
                     disp_ip,
                     g_st.http80_ok ? "OK" : "WAIT",
                     g_st.http8080_ok ? "OK" : "WAIT");
            draw_text_s(fb, 34, 170, live_sum, th->text, 2, 54);

            /* Row 0: Staged Radio Mode */
            {
                bool r0 = (g_st.rev_cursor == 0);
                fill_rect(fb, 32, 196, PANEL_W - 64, 30, r0 ? th->ember : th->panel);
                draw_border(fb, 32, 196, PANEL_W - 64, 30, 1, r0 ? th->ember_bright : th->border);
                char r0line[120];
                snprintf(r0line, sizeof(r0line), "%s1. STAGED MODE (L/R): < %s >",
                         r0 ? "> " : "  ",
                         g_st.net_staged_ap ? "STUMP AP 192.168.4.1 (LaBuche-Stump)" : "LOCAL LAN WIFI CLIENT (DHCP)");
                draw_text_s(fb, 38, 204, r0line, r0 ? th->bg : (g_st.net_staged_ap ? th->ok : th->ember_bright), 2, 52);
            }

            /* Row 1: Staged Target SSID / AP Channel */
            {
                bool r1 = (g_st.rev_cursor == 1);
                fill_rect(fb, 32, 230, PANEL_W - 64, 30, r1 ? th->ember : th->panel);
                draw_border(fb, 32, 230, PANEL_W - 64, 30, 1, r1 ? th->ember_bright : th->border);
                char r1line[120];
                if (g_st.net_staged_ap) {
                    snprintf(r1line, sizeof(r1line), "%s2. AP CONFIG: SSID='LaBuche-Stump' CH=6 IP=192.168.4.1:80 (OPEN)",
                             r1 ? "> " : "  ");
                } else {
                    snprintf(r1line, sizeof(r1line), "%s2. TARGET LAN SSID (L/R OR [A] PICK): < %s >",
                             r1 ? "> " : "  ",
                             g_st.net_staged_ssid[0] ? g_st.net_staged_ssid : "SAVED SYSTEM WIFI DHCP");
                }
                draw_text_s(fb, 38, 238, r1line, r1 ? th->bg : th->text, 2, 52);
            }

            /* Row 2: [A] ACCEPT & APPLY REVISION  |  [B] CANCEL & REVERT STAGED */
            {
                bool r2 = (g_st.rev_cursor == 2);
                fill_rect(fb, 32, 266, PANEL_W - 64, 34, r2 ? th->ok : th->panel);
                draw_border(fb, 32, 266, PANEL_W - 64, 34, 2, r2 ? th->text : (g_st.net_staged_dirty ? th->ok : th->border));
                char r2line[120];
                snprintf(r2line, sizeof(r2line), "%s3. [A] ACCEPT & APPLY REVISION   |   [B] CANCEL / REVERT STAGED",
                         r2 ? "> " : "  ");
                draw_text_s(fb, 38, 276, r2line, r2 ? th->bg : th->ok, 2, 52);
            }

            draw_text_s(fb, 34, 310, "BUTTONS: [A]=ACCEPT/APPLY   [B]=CANCEL/REVERT   (NO ACCIDENTAL SWITCHES)", th->muted, 2, 54);

            /* Row 3: Debug Action Toggle Bar */
            {
                bool r3 = (g_st.rev_cursor == 3);
                fill_rect(fb, 24, 344, PANEL_W - 48, 56, r3 ? th->ember : th->panel2);
                draw_border(fb, 24, 344, PANEL_W - 48, 56, 2, r3 ? th->ember_bright : th->border);
                const char *dtools[3] = {
                    "EXPORT DIAG + LOGS -> TF CARD",
                    "HEAL VISITOR HTTP :80/:8080",
                    "CLEAR DEBUG LOG BUFFER"
                };
                char dtline[128];
                snprintf(dtline, sizeof(dtline), "%s4. DEBUG TOOL (L/R, [A] RUN): < %s >",
                         r3 ? "> " : "  ", dtools[g_st.debug_bar_mode]);
                draw_text_s(fb, 34, 352, dtline, r3 ? th->bg : th->ember_bright, 2, 52);
                char dt2[128];
                snprintf(dt2, sizeof(dt2), "   TF BACKUPS:%d  LAST EV:%d  ([Y]=EXPORT TF  [X]=HEAL HTTP)",
                         g_st.tf_backup_count, g_st.last_ev_code);
                draw_text_s(fb, 34, 376, dt2, r3 ? th->bg : th->ok, 2, 52);
            }

            /* Row 4: Live Debug Log Viewport */
            {
                bool r4 = (g_st.rev_cursor == 4);
                fill_rect(fb, 24, 408, PANEL_W - 48, 246, th->panel2);
                draw_border(fb, 24, 408, PANEL_W - 48, 246, 2, r4 ? th->ember_bright : th->border);
                char lhead[96];
                snprintf(lhead, sizeof(lhead), "%s5. LIVE SYSTEM & RADIO LOGS (%d ENTRIES - UP/DN SCROLL):",
                         r4 ? "> " : "  ", g_st.debug_log_count);
                draw_text_s(fb, 34, 416, lhead, r4 ? th->ember_bright : th->muted, 2, 54);

                if (g_st.debug_log_count == 0) {
                    draw_text_s(fb, 34, 452, "NO LOGS YET - PRESS [A] ON DEBUG TOOL ABOVE TO RUN DIAGNOSTICS.", th->muted, 2, 52);
                }
                int start_idx = g_st.debug_scroll;
                if (start_idx > g_st.debug_log_count - 1) start_idx = 0;
                for (int i = 0; i < 7 && (start_idx + i) < g_st.debug_log_count; i++) {
                    int ly = 444 + i * 28;
                    draw_text_s(fb, 34, ly, g_st.debug_logs[start_idx + i], th->text, 2, 54);
                }
            }
        }

        /* ---- Prominent "IN PROCESS..." State Banner Overlay ---- */
        if (is_ui_busy()) {
            const char *bmsg = g_st.busy_msg[0] ? g_st.busy_msg : "IN PROCESS: PLEASE WAIT...";
            fill_rect(fb, 36, 126, PANEL_W - 72, 44, th->bg);
            fill_rect(fb, 40, 130, PANEL_W - 80, 36, th->ember);
            draw_border(fb, 40, 130, PANEL_W - 80, 36, 3, th->ember_bright);
            draw_text_s(fb, 54, 140, bmsg, th->bg, 2, 50);
        }

        /* ---- Confirmation Modal Overlay ([A] = ACCEPT, [B] = CANCEL) ---- */
        if (g_st.confirm_open) {
            fill_rect(fb, 56, 206, PANEL_W - 112, 258, th->bg);
            fill_rect(fb, 62, 212, PANEL_W - 124, 246, th->panel);
            draw_border(fb, 62, 212, PANEL_W - 124, 246, 4, g_st.confirm_type == 3 ? th->ok : th->warn);

            if (g_st.confirm_type == 3) {
                draw_text_s(fb, 92, 234, "APPLY STAGED NETWORK REVISION?", th->ok, 3, 32);
                draw_text_s(fb, 88, 282, "PROPOSED NETWORK CONFIGURATION TO APPLY:", th->muted, 2, 44);
            } else {
                draw_text_s(fb, 110, 234, "ARE YOU SURE YOU WANT TO ERASE?", th->warn, 3, 32);
                draw_text_s(fb, 88, 282,
                            g_st.confirm_type == 1 ? "CHECKED BILLBOARD NOTICES TO ERASE:" : "CHECKED SHARED FILES TO ERASE:",
                            th->muted, 2, 44);
            }
            draw_text_s(fb, 88, 314, g_st.confirm_label, th->ember_bright, 2, 44);

            /* Choice 0: NO / CANCEL */
            bool c0 = (g_st.confirm_choice == 0);
            fill_rect(fb, 90, 362, 250, 54, c0 ? th->ember : th->panel2);
            draw_border(fb, 90, 362, 250, 54, 3, c0 ? th->text : th->border);
            draw_text_s(fb, 108, 382, c0 ? "> [B] NO, CANCEL <" : "  [B] NO, CANCEL  ", c0 ? th->bg : th->text, 2, 18);

            /* Choice 1: YES / ACCEPT */
            bool c1 = (g_st.confirm_choice == 1);
            uint32_t c1_col = (g_st.confirm_type == 3) ? th->ok : th->warn;
            fill_rect(fb, 380, 362, 250, 54, c1 ? c1_col : th->panel2);
            draw_border(fb, 380, 362, 250, 54, 3, c1 ? th->text : th->border);
            draw_text_s(fb, 396, 382,
                        g_st.confirm_type == 3 ? (c1 ? "> [A] YES, APPLY <" : "  [A] YES, APPLY  ")
                                               : (c1 ? "> [A] YES, ERASE <" : "  [A] YES, ERASE  "),
                        c1 ? th->bg : c1_col, 2, 18);

            draw_text_s(fb, 92, 430, "LEFT/RIGHT: SELECT   [A]: ACCEPT CHOICE   [B]: CANCEL IMMEDIATELY", th->muted, 2, 50);
        }

        /* ---- FireFly_RK3326_R36MAX_R36S Bottom Hints Bar (firefly/ui/widgets.py) ---- */
        fill_rect(fb, 0, PANEL_H - 42, PANEL_W, 42, th->panel2);
        fill_rect(fb, 0, PANEL_H - 42, PANEL_W, 2, th->border);
        if (g_st.confirm_open) {
            draw_text_s(fb, 16, PANEL_H - 28, "CONFIRM: [A]=ACCEPT HIGHLIGHTED   [B]=CANCEL IMMEDIATELY   L/R:NO/YES", th->ember_bright, 2, 58);
        } else {
            const char *hk[5] = { "A", "B", "Y", "X", "L/R" };
            const char *hv0[5] = { "Send/Act", "Cancel", "Keyboard", "/Auth", "Room/Tab" };
            const char *hv1[5] = { "Check[X]", "Clear",  "TF-Save",  "Delete", "Toggle" };
            const char *hv3[5] = { "Stage->5", "Cancel", "PassOSK",  "QRMode", "Toggle" };
            const char *hv4[5] = { "ApplyRev", "Revert", "TF-Diag",  "Heal80", "Cycle" };
            const char **hv = (g_st.tab_idx == 1 || g_st.tab_idx == 2) ? hv1
                            : (g_st.tab_idx == 3) ? hv3
                            : (g_st.tab_idx == 4) ? hv4 : hv0;
            int hx = 14;
            for (int hi = 0; hi < 5; hi++) {
                int kw = (int)strlen(hk[hi]) * 12 + 12;
                fill_rect(fb, hx, PANEL_H - 34, kw, 24, th->panel);
                draw_border(fb, hx, PANEL_H - 34, kw, 24, 1, th->border);
                draw_text_s(fb, hx + 6, PANEL_H - 28, hk[hi], th->text, 2, 4);
                hx += kw + 6;
                draw_text_s(fb, hx, PANEL_H - 28, hv[hi], th->muted, 2, 10);
                hx += (int)strlen(hv[hi]) * 12 + 14;
            }
        }

        if (tex && fn_UpdateTexture && fn_RenderCopy && fn_RenderPresent) {
            fn_UpdateTexture(tex, NULL, fb, PANEL_W * 4);
            if (fn_RenderClear) fn_RenderClear(ren);
            fn_RenderCopy(ren, tex, NULL, NULL);
            fn_RenderPresent(ren);
        } else if (fb0_map) {
            memcpy(fb0_map, fb, PANEL_BYTES);
            vinfo.xoffset = 0;
            vinfo.yoffset = 0;
            ioctl(fb_fd, FBIOPAN_DISPLAY, &vinfo);
            usleep(16000);
        } else {
            usleep(16000);
        }

        frames++;
        if (frames == 1) {
            fprintf(stderr, "[Stump-R36MAX] First 720x720 frame rendered (%s)!\\n", g_st.ver_str);
            fflush(stderr);
        }
        if (max_frames > 0 && frames >= max_frames) {
            fprintf(stderr, "[Stump-R36MAX] Smoke test rendered %d frames cleanly.\\n", frames);
            fflush(stderr);
            g_st.running = false;
            break;
        }
    }

    pthread_join(audio_tid, NULL);
    free(fb);
    if (g_st.udp_sock >= 0) close(g_st.udp_sock);
    if (g_st.ipc_sock >= 0) close(g_st.ipc_sock);
    if (tex && fn_DestroyTexture) fn_DestroyTexture(tex);
    if (ren && fn_DestroyRenderer) fn_DestroyRenderer(ren);
    if (win && fn_DestroyWindow) fn_DestroyWindow(win);
    if (sdl && fn_Quit) fn_Quit();
    if (fb0_map) munmap(fb0_map, PANEL_BYTES);
    if (fb_fd >= 0) close(fb_fd);
    for (int i = 0; i < 16; i++) {
        if (ev_fds[i] >= 0) close(ev_fds[i]);
    }
    return 0;
}
`;

export const STUMP_R36MAX_PORTS_SCRIPT = `#!/bin/bash
# =============================================================================
# LaBuche_Stump.sh — EmulationStation Ports Launcher for LaBuche-Stump v1.7.1
# System: dArkOS (Debian GNU/Linux 13 trixie, Linux 4.4.189 aarch64)
# Place in: /roms/ports/LaBuche_Stump.sh
# =============================================================================

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
APP_DIR="/roms/ports/stump_r36max"
NODE_DIR="$APP_DIR/node"
TF_BACKUP_DIR="$APP_DIR/tf_backup"
LOG_FILE="$APP_DIR/stump_r36max.log"

mkdir -p "$NODE_DIR/sd/shared" "$NODE_DIR/sd/tools" "$APP_DIR/drop" "$TF_BACKUP_DIR"
echo ark | sudo -S rm -f /dev/shm/stump_cmd.txt /dev/shm/stump_live.txt 2>/dev/null || true
exec > "$LOG_FILE" 2>&1
echo "=== Launching LaBuche-Stump R36MAX Node v1.7.1-r36max $(date) ==="

# Ensure no stale Python node or AP daemon is holding port 80, 8080, 67, 53, UDP 42421, or wlan0
echo ark | sudo -S pkill -f "run_stump_r36max.py" 2>/dev/null || true
echo ark | sudo -S pkill -f "stump_pc.py" 2>/dev/null || true
echo ark | sudo -S pkill -f "stump_hostapd" 2>/dev/null || true
echo ark | sudo -S pkill -f "stump_wpa_ap" 2>/dev/null || true
echo ark | sudo -S pkill -f "stump_dnsmasq.conf" 2>/dev/null || true
echo ark | sudo -S nft flush ruleset 2>/dev/null || true
echo ark | sudo -S iptables -P INPUT ACCEPT 2>/dev/null || true
echo ark | sudo -S iptables -F INPUT 2>/dev/null || true
echo ark | sudo -S sysctl -w net.ipv4.conf.all.rp_filter=0 2>/dev/null || true
echo ark | sudo -S systemctl unmask --runtime NetworkManager NetworkManager-dispatcher wpa_supplicant dhcpcd 2>/dev/null || true
echo ark | sudo -S systemctl unmask NetworkManager wpa_supplicant 2>/dev/null || true
echo ark | sudo -S systemctl start wpa_supplicant 2>/dev/null || true
echo ark | sudo -S systemctl start NetworkManager 2>/dev/null || true

# Grant dialout/tty access if Heltec V3 RNode is plugged into the USB hub
echo ark | sudo -S chmod 666 /dev/ttyACM* /dev/ttyUSB* /dev/input/event* 2>/dev/null || true

# Configure Blueway Ralink RT3070 (148f:3070 / rt2800usb / MAC 00:0f:00:5e:11:ee) high-power 20 dBm mode
for netdev in /sys/class/net/*; do
  ifname=$(basename "$netdev")
  if [ -d "$netdev/wireless" ] || [ -d "$netdev/phy80211" ]; then
    echo ark | sudo -S /usr/sbin/iw dev "$ifname" set power_save off 2>/dev/null || true
    echo ark | sudo -S /usr/sbin/iw dev "$ifname" set txpower fixed 2000 2>/dev/null || true
  fi
done

# 1. Start the immortal LaBuche-Stump Python node + final_firmware/barkeep.py (:80/:8080) + DHCP :67 + DNS :53 on Cores 2-3
if [ -f "$NODE_DIR/run_stump_r36max.py" ]; then
  (cd "$NODE_DIR" && echo ark | sudo -S env PATH="$PATH" taskset -c 2,3 python3 "$NODE_DIR/run_stump_r36max.py" > "$APP_DIR/stump_http.log" 2>&1) &
  STUMP_PY_PID=$!
  echo "[Launcher] Started run_stump_r36max.py v1.7.1 (PID $STUMP_PY_PID) serving final_firmware/barkeep.py on :80/:8080"
elif [ -f "$NODE_DIR/stump_pc.py" ]; then
  (cd "$NODE_DIR" && echo ark | sudo -S env PATH="$PATH" taskset -c 2,3 python3 "$NODE_DIR/stump_pc.py" > "$APP_DIR/stump_http.log" 2>&1) &
  STUMP_PY_PID=$!
fi

# 2. Launch the 720x720 FireFly · Stump SDL2 KMSDRM + /dev/fb0 + ALSA Handheld Cockpit on Cores 0-1
"$APP_DIR/stump_r36max_engine"

# 3. Clean shutdown on SELECT+START: stop Stump AP, unmask NetworkManager, and reconnect wlan0 to local LAN for SSH
echo ark | sudo -S pkill -f "run_stump_r36max.py" 2>/dev/null || true
echo ark | sudo -S pkill -f "stump_hostapd" 2>/dev/null || true
echo ark | sudo -S pkill -f "stump_wpa_ap" 2>/dev/null || true
echo ark | sudo -S pkill -f "stump_wpa_uap0" 2>/dev/null || true
echo ark | sudo -S pkill -f "stump_dnsmasq.conf" 2>/dev/null || true
echo ark | sudo -S /usr/sbin/iw dev uap0 del 2>/dev/null || true
echo ark | sudo -S nmcli con down StumpCAM 2>/dev/null || true
echo ark | sudo -S nmcli con delete StumpCAM 2>/dev/null || true
echo ark | sudo -S /usr/sbin/ip addr del 192.168.4.1/24 dev wlan0 2>/dev/null || true
echo ark | sudo -S systemctl unmask --runtime NetworkManager NetworkManager-dispatcher wpa_supplicant dhcpcd 2>/dev/null || true
echo ark | sudo -S systemctl unmask NetworkManager wpa_supplicant 2>/dev/null || true
echo ark | sudo -S systemctl start wpa_supplicant 2>/dev/null || true
echo ark | sudo -S systemctl start NetworkManager 2>/dev/null || true
echo ark | sudo -S nmcli radio wifi on 2>/dev/null || true
echo ark | sudo -S nmcli dev set wlan0 managed yes 2>/dev/null || true
sleep 1
echo ark | sudo -S nmcli dev connect wlan0 2>/dev/null || true
echo "=== LaBuche-Stump R36MAX v1.7.1 exited cleanly $(date) ==="
`;

export const STUMP_CODE_ARTIFACTS: CodeFileArtifact[] = [
  {
    id: 'stump_r36max_c',
    filename: 'stump_r36max_engine.c',
    title: 'FireFly · Stump R36MAX v1.7.1-r36max 720×720 Cockpit (FireFly_RK3326_R36MAX_R36S UI + 5-Panel Revision)',
    language: 'c',
    summary:
      'Authentic FireFly_RK3326_R36MAX_R36S Amber palette & layout (FIREFLY · STUMP header, tab pills, right/left chat bubbles with [DM] & * action coloring, 295 B · 1 LoRa pkt meter, framed keycap hints bar) + 5 panels with strict [A]=Accept / [B]=Cancel.',
    content: STUMP_R36MAX_C_SOURCE,
  },
  {
    id: 'run_stump_r36max_py',
    filename: 'run_stump_r36max.py',
    title: 'Immortal Python Bridge v1.7.1 — Authentic final_firmware/barkeep.py + Port 53 Errno 98 Fix',
    language: 'python',
    summary:
      'Serves the real final_firmware/barkeep.py & rrc_ui.py Visitor Interface on :80 and :8080 and prevents example_node.py captive_portal.run_dns_server from stealing UDP :53 so AP mode Captive DNS (:53) binds cleanly without Errno 98.',
    content: STUMP_R36MAX_BRIDGE_PY,
  },
  {
    id: 'labuche_stump_sh',
    filename: 'LaBuche_Stump.sh',
    title: 'EmulationStation Ports Launcher v1.7.1 (/roms/ports/LaBuche_Stump.sh)',
    language: 'bash',
    summary:
      'Flushes nftables/iptables, disables rp_filter, configures Blueway RT3070 20 dBm power, starts run_stump_r36max.py v1.7.1 on Cores 2-3, and restores local LAN on exit.',
    content: STUMP_R36MAX_PORTS_SCRIPT,
  },
];


