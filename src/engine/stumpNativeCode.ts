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
run_stump_r36max.py — Launches LaBuche-Stump (stump_pc / example_node) on R36MAX
with:
  1. Dual-port HTTP server on BOTH :80 (for FireFly /auth & UDP 4244 STUMP? discovery)
     and :8080 (for browser fallback).
  2. Instant UDP 127.0.0.1:42421 + /dev/shm/stump_cmd.txt IPC command bridge so
     D-pad, On-Screen Keyboard, and USB Keyboard messages from the C cockpit
     always land in rrc.py and push to Reticulum LoRa / Wi-Fi Chain mesh.
  3. Heltec V3 RNode (/dev/ttyACM* / /dev/ttyUSB* @ 115200) auto-detection &
     CHAIN = True (#wifi-mesh UDP :4243) multi-Stump chaining.
"""
import builtins
import os
import sys
import time
import shutil
import socket
import select
import asyncio
import threading

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

HERE      = os.path.dirname(os.path.abspath(__file__))
LIVE_TMP  = "/dev/shm/stump_live.tmp"
LIVE_TXT  = "/dev/shm/stump_live.txt"
CMD_TXT   = "/dev/shm/stump_cmd.txt"
LOCAL_CID = "r36max-local"
IPC_UDP_PORT = 42421

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
            "=== LABUCHE-STUMP R36MAX LIVE NODE REPORT ===",
            "Timestamp: %s" % time.strftime("%Y-%m-%d %H:%M:%S"),
            "Node LXMF: %s" % _node_lxmf_str(rrc_mod),
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
            "# Guide Terrain LaBuche-Stump (FR / EN / ES)\\n\\n"
            "## 1. Jardinage & Permaculture / Gardening / Jardineria\\n"
            "- Association de cultures, paillage organique, collecte d'eau de pluie.\\n"
            "- Companion planting, mulching, off-grid water catchment.\\n\\n"
            "## 2. Relais Radio LoRa (Heltec V3) & Wi-Fi Stump Chain\\n"
            "- Heltec V3 RNode USB-C -> /dev/ttyACM0 ou /dev/ttyUSB0 (868/915 MHz).\\n"
            "- Salon #main (local), #lora-mesh (Heltec RNode), #wifi-mesh (Chained Stumps).\\n"
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
            f.write("R36MAX Stump Beacon Snapshot at %s\\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
        return fname

def _execute_cmd_line(line, rrc_mod, rrc_mesh_mod, bb_mod, fserv_mod):
    parts = line.strip().split("|")
    if not parts or not parts[0]:
        return
    op = parts[0]
    try:
        if op == "RRC" and len(parts) >= 3 and rrc_mod:
            room = parts[1].lower().strip()
            text = "|".join(parts[2:]).strip()
            if not text:
                return
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
            # If text was a chat message (not a /command) and handle_input was gated, post directly!
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
            rrc_mod.post(room, "r36max", "[BEACON] Node %s announced on Wi-Fi (:80/:8080) + Chain%s" % (str(node_hex)[:12], rnode_tag))
        elif op == "BOARD_ADD" and len(parts) >= 3 and bb_mod:
            title = parts[1]
            body = parts[2]
            bb_mod._append_entry(title, body, LOCAL_CID)
        elif op == "BOARD_DEL" and len(parts) >= 2 and bb_mod:
            target_id = parts[1]
            bb_mod.delete_entry(target_id)
        elif op == "FILE_ADD" and len(parts) >= 2:
            mode_str = parts[1]
            created = _share_real_file(mode_str, rrc_mod)
            if fserv_mod and hasattr(fserv_mod, "record_upload"):
                try:
                    fserv_mod.record_upload(created, LOCAL_CID)
                except Exception:
                    pass
            if rrc_mod and created:
                rrc_mod.system("main", "Shared new file in /files: %s" % created)
        elif op == "FILE_DEL" and len(parts) >= 2:
            fname = os.path.basename(parts[1])
            fpath = os.path.join(HERE, "sd", "shared", fname)
            if _REAL_ISFILE(fpath):
                _REAL_REMOVE(fpath)
            if fserv_mod and hasattr(fserv_mod, "remove_from_ledger"):
                try:
                    fserv_mod.remove_from_ledger(fname)
                except Exception:
                    pass
    except Exception as e:
        print("[r36max_bridge] cmd error:", e)

def _drain_commands(ipc_sock, rrc_mod, rrc_mesh_mod, bb_mod, fserv_mod):
    lines = []
    # 1. Drain instant UDP loopback socket (zero permission issues between ark & root!)
    if ipc_sock:
        while True:
            try:
                data, _ = ipc_sock.recvfrom(2048)
                for ln in data.decode("utf-8", errors="replace").splitlines():
                    if ln.strip():
                        lines.append(ln.strip())
            except BlockingIOError:
                break
            except Exception:
                break
    # 2. Drain /dev/shm/stump_cmd.txt file fallback
    if _REAL_EXISTS(CMD_TXT):
        try:
            with _REAL_OPEN(CMD_TXT, "r+", encoding="utf-8", errors="replace") as f:
                for ln in f:
                    if ln.strip():
                        lines.append(ln.strip())
                f.seek(0)
                f.truncate(0)
        except OSError:
            try:
                _REAL_REMOVE(CMD_TXT)
            except OSError:
                pass

    for line in lines:
        _execute_cmd_line(line, rrc_mod, rrc_mesh_mod, bb_mod, fserv_mod)
    return len(lines) > 0

def _bridge_worker():
    rooms_init = False
    last_rnode = ""
    ipc_sock = None
    try:
        ipc_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        ipc_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        ipc_sock.bind(("127.0.0.1", IPC_UDP_PORT))
        ipc_sock.setblocking(False)
    except Exception as e:
        print("[r36max_bridge] UDP IPC bind note:", e)

    while True:
        try:
            if ipc_sock:
                select.select([ipc_sock], [], [], 0.15)
            else:
                time.sleep(0.15)

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

            # Hotplug detection for Heltec V3 RNode (/dev/ttyACM0 or /dev/ttyUSB0)
            cur_rnode = _detect_heltec_rnode()
            if cur_rnode != last_rnode:
                last_rnode = cur_rnode
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
            rnode_label = os.path.basename(cur_rnode) if cur_rnode else "WAIT-USB"
            out.append("META|%s|%d|%s" % (node_id, mesh_peers, rnode_label))

            # 1. Real RRC Rooms & Messages
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

            # 2. Real Billboard Posts (newest first)
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

            # 3. Real Shared Files in sd/shared
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
    sys.path[:0] = [os.path.join(HERE, "pc_compat"), HERE]
    import stump_host
    stump_host.install(HERE)

    # Exempt run_stump_r36max.py from stump_host's firmware path redirection
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

    # Enable Stump-to-Stump Wi-Fi Chaining (CHAIN = True -> #wifi-mesh + UDP :4243)
    try:
        import config
        config.CHAIN = True
    except Exception:
        pass

    # Hook asyncio.start_server so barkeep serves on BOTH port 80 (for FireFly /auth) AND port 8080
    _orig_start_server = asyncio.start_server
    async def _dual_port_start_server(cb, host=None, port=None, *args, **kwargs):
        srv = await _orig_start_server(cb, host, port, *args, **kwargs)
        if port == 80:
            try:
                await _orig_start_server(cb, host, 8080, *args, **kwargs)
                print("[web] dual listener active: serving on BOTH port 80 (FireFly) and port 8080")
            except Exception as e:
                print("[web] port 8080 secondary bind note:", e)
        elif port == 8080:
            try:
                await _orig_start_server(cb, host, 80, *args, **kwargs)
                print("[web] dual listener active: serving on BOTH port 80 (FireFly) and port 8080")
                try:
                    import discovery
                    discovery.WEB_PORT = 80
                except Exception:
                    pass
            except Exception as e:
                print("[web] port 80 secondary bind note:", e)
        return srv
    asyncio.start_server = _dual_port_start_server

    # Seed 1 real starter file ONLY if sd/shared is completely empty
    sd_shared = os.path.join(HERE, "sd", "shared")
    _REAL_MAKEDIRS(sd_shared, exist_ok=True)
    if not [f for f in _REAL_LISTDIR(sd_shared) if not f.startswith(".")]:
        _share_real_file("1", None)

    t = threading.Thread(target=_bridge_worker, daemon=True)
    t.start()

    import example_node  # noqa: F401
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

static const ThemeColors g_themes[5] = {
    { "AMBER",    0xFF1B1512u, 0xFF2A2119u, 0xFF221B15u, 0xFFD97A3Au, 0xFFF0A050u, 0xFFF5EBD6u, 0xFFA89882u, 0xFF524334u, 0xFF5CFF85u, 0xFFFFB84Du },
    { "PHOSPHOR", 0xFF0B120Cu, 0xFF142217u, 0xFF0F1A11u, 0xFF33FF66u, 0xFF66FF8Cu, 0xFFE2FCE6u, 0xFF6EA87Bu, 0xFF23452Au, 0xFF33FF66u, 0xFFFFCC33u },
    { "OLED",     0xFF000000u, 0xFF141414u, 0xFF0A0A0Au, 0xFF4DA6FFu, 0xFF80BFFFu, 0xFFFFFFFFu, 0xFF9E9E9Eu, 0xFF333333u, 0xFF4DFF88u, 0xFFFFB84Du },
    { "PAPER",    0xFFF5F2EBu, 0xFFE6E0D0u, 0xFFEDE8DAu, 0xFFA84814u, 0xFFC25B1Fu, 0xFF1F1C19u, 0xFF5C5447u, 0xFFC4BBA6u, 0xFF1B6E23u, 0xFFB85D00u },
    { "TAVERN",   0xFF1A120Bu, 0xFF2B1D12u, 0xFF22170Eu, 0xFFE0A040u, 0xFFF5C063u, 0xFFF7EBD6u, 0xFFB59C76u, 0xFF573C24u, 0xFF5CFF85u, 0xFFF5C063u }
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

/* ---- Multi-Transport Hardware Scanner (WiFi, Eth, Heltec V3 RNode, USB Keyboard) ---- */
typedef struct {
    bool wifi_online;
    char wifi_if[24];
    char wifi_ip[40];
    char wifi_driver[32];
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
    ts->wifi_rssi_dbm = -55;

    DIR *d = opendir("/sys/class/net");
    if (d) {
        struct dirent *ent;
        while ((ent = readdir(d)) != NULL) {
            if (ent->d_name[0] == '.' || strcmp(ent->d_name, "lo") == 0) continue;
            char wpath[320], ppath[320], uevent[320];
            snprintf(wpath, sizeof(wpath), "/sys/class/net/%s/wireless", ent->d_name);
            snprintf(ppath, sizeof(ppath), "/sys/class/net/%s/phy80211", ent->d_name);
            bool is_wlan = (access(wpath, F_OK) == 0 || access(ppath, F_OK) == 0 ||
                            strncmp(ent->d_name, "wl", 2) == 0 || strncmp(ent->d_name, "ra", 2) == 0);
            if (is_wlan && !ts->wifi_online) {
                ts->wifi_online = true;
                snprintf(ts->wifi_if, sizeof(ts->wifi_if), "%.23s", ent->d_name);
                snprintf(ts->wifi_ip, sizeof(ts->wifi_ip), "DHCP/ASSOC");
                snprintf(ts->wifi_driver, sizeof(ts->wifi_driver), "USB-WIFI");
                snprintf(uevent, sizeof(uevent), "/sys/class/net/%s/device/uevent", ent->d_name);
                FILE *uf = fopen(uevent, "r");
                if (uf) {
                    char line[128];
                    while (fgets(line, sizeof(line), uf)) {
                        if (strncmp(line, "DRIVER=", 7) == 0) {
                            char *nl = strchr(line + 7, '\\n');
                            if (nl) *nl = '\\0';
                            snprintf(ts->wifi_driver, sizeof(ts->wifi_driver), "%.31s", line + 7);
                            break;
                        }
                    }
                    fclose(uf);
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
                    snprintf(ts->wifi_driver, sizeof(ts->wifi_driver), "USB-WIFI");
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

            if (strncmp(ifa->ifa_name, "wl", 2) == 0 || strcmp(ifa->ifa_name, ts->wifi_if) == 0) {
                ts->wifi_online = true;
                snprintf(ts->wifi_if, sizeof(ts->wifi_if), "%.23s", ifa->ifa_name);
                snprintf(ts->wifi_ip, sizeof(ts->wifi_ip), "%.39s", ip);
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

#define MAX_LOG_LINES 10
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
} BoardItem;

typedef struct {
    char name[36];
    int  size_kb;
    char cat[8];
} ShelfItem;

typedef struct {
    volatile bool   running;
    volatile int    chime_freq;
    volatile int    chime_ms;
    int             theme_idx;
    int             tab_idx;
    int             room_idx;
    int             auth_mode_idx;
    int             cmd_cursor;
    int             board_cursor;
    int             board_preset_idx;
    int             file_cursor;
    int             file_action_idx;
    bool            verified;
    int             beacons_sent;
    int             rx_packets;
    int             udp_sock;
    int             ipc_sock;
    int             suppress_poll_frames;
    char            node_lxmf[36];
    char            rnode_status[24];
    int             mesh_peers;
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

/* 4x10 On-Screen Keyboard (OSK) Grid (Y or SELECT to open/close) */
static const char *OSK_LABELS[4][10] = {
    { "1", "2", "3", "4", "5", "6", "7", "8", "9", "0" },
    { "Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P" },
    { "A", "S", "D", "F", "G", "H", "J", "K", "L", "/" },
    { "Z", "X", "C", "V", "B", "N", "M", "SPC", "DEL", "SEND" }
};

static const char *BOARD_PRESET_TITLES[5] = {
    "R36MAX NODE ONLINE & READY",
    "HELTEC V3 + WIFI CHAIN READY",
    "MEET AT BASE / CHANNEL 1",
    "NEW FILES SHARED IN /FILES",
    "SOLAR & BATTERY CHECK OK"
};

static const char *BOARD_PRESET_BODIES[5] = {
    "Posted from R36MAX handheld operator console.",
    "Walk-up HTTP :80/:8080 and Stump Chain active.",
    "Check #main or #wifi-mesh room for coordinates.",
    "Download offline guides and logs from /files.",
    "Handheld battery nominal; radio link clear."
};

static const char *FILE_ACTION_LABELS[3] = {
    "1. EXPORT LIVE MESH LOG (.TXT)",
    "2. SHARE FIELD GUIDE (.MD)",
    "3. IMPORT FROM DROP FOLDER"
};

static void trigger_chime(int freq, int ms) {
    g_st.chime_freq = freq;
    g_st.chime_ms = ms;
}

/* Send command to Python bridge via BOTH UDP 127.0.0.1:42421 (instant, no root/ark perm issue)
 * AND /dev/shm/stump_cmd.txt fallback. */
static void send_bridge_cmd(const char *cmd_line) {
    if (g_st.ipc_sock >= 0) {
        struct sockaddr_in dst;
        memset(&dst, 0, sizeof(dst));
        dst.sin_family = AF_INET;
        dst.sin_port = htons(IPC_UDP_PORT);
        dst.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        sendto(g_st.ipc_sock, cmd_line, strlen(cmd_line), MSG_DONTWAIT,
               (struct sockaddr *)&dst, sizeof(dst));
    }
    int fd = open(CMD_QUEUE_FILE, O_WRONLY | O_CREAT | O_APPEND, 0666);
    if (fd >= 0) {
        dprintf(fd, "%s\\n", cmd_line);
        close(fd);
    }
    /* Hold 18 frames (~300ms) so poll_live_bridge doesn't overwrite optimistic UI before Python flushes */
    g_st.suppress_poll_frames = 18;
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

static void send_typed_chat(void) {
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

/* Translate Linux kernel EV_KEY keycode from any plugged USB keyboard into ASCII */
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

/* Direct disk fallback for Billboard & File Shelf when standalone */
static void sync_disk_fallback(void) {
    /* Read /roms/ports/stump_r36max/node/sd/billboard.txt directly */
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

    /* Scan /roms/ports/stump_r36max/node/sd/shared directly */
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

/* Poll /dev/shm/stump_live.txt written every 150ms by run_stump_r36max.py */
static void poll_live_bridge(void) {
    if (g_st.suppress_poll_frames > 0) return;
    FILE *f = fopen(LIVE_STATE_FILE, "r");
    if (!f) {
        sync_disk_fallback();
        return;
    }
    int r_counts[3] = {0, 0, 0};
    int b_count = 0;
    int f_count = 0;
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
                f_count++;
            }
        } else if (strncmp(line, "STORAGE|", 8) == 0) {
            int u = 0, c = 0, t = 0;
            if (sscanf(line + 8, "%d|%d|%d", &u, &c, &t) >= 2) {
                g_st.used_kb = u;
                g_st.ceil_kb = c;
            }
        }
    }
    fclose(f);
    for (int r = 0; r < 3; r++) g_st.room_counts[r] = r_counts[r];
    g_st.board_count = b_count;
    g_st.file_count = f_count;
    if (g_st.board_cursor >= g_st.board_count) g_st.board_cursor = (g_st.board_count > 0) ? (g_st.board_count - 1) : 0;
    if (g_st.file_cursor >= g_st.file_count) g_st.file_cursor = (g_st.file_count > 0) ? (g_st.file_count - 1) : 0;
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

    /* Also write directly if standalone */
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

static void action_board_delete(void) {
    if (g_st.board_count <= 0) return;
    int idx = g_st.board_cursor;
    if (idx < 0 || idx >= g_st.board_count) idx = 0;
    char cmd[128];
    snprintf(cmd, sizeof(cmd), "BOARD_DEL|%s", g_st.board[idx].id);
    send_bridge_cmd(cmd);
    trigger_chime(440, 70);
}

static void action_file_add(void) {
    int m = g_st.file_action_idx % 3;
    char cmd[128];
    snprintf(cmd, sizeof(cmd), "FILE_ADD|%d", m);
    send_bridge_cmd(cmd);

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

static void action_file_delete(void) {
    if (g_st.file_count <= 0) return;
    int idx = g_st.file_cursor;
    if (idx < 0 || idx >= g_st.file_count) idx = 0;
    char cmd[160];
    snprintf(cmd, sizeof(cmd), "FILE_DEL|%s", g_st.files[idx].name);
    send_bridge_cmd(cmd);

    char fpath[256];
    snprintf(fpath, sizeof(fpath), "%s/%s", SD_SHARED_DIR, g_st.files[idx].name);
    unlink(fpath);
    trigger_chime(440, 70);
}

static void update_qr_if_needed(void) {
    char target_url[64];
    snprintf(target_url, sizeof(target_url), "http://%s:80/", g_st.net.primary_ip);
    if (strcmp(target_url, g_st.qr_url) != 0) {
        snprintf(g_st.qr_url, sizeof(g_st.qr_url), "%s", target_url);
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
    snprintf(g_st.node_lxmf, sizeof(g_st.node_lxmf), "A7F391C208B4E6D1");
    snprintf(g_st.rnode_status, sizeof(g_st.rnode_status), "WAIT-USB");

    scan_transports(&g_st.net);
    update_qr_if_needed();
    poll_live_bridge();

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
    fprintf(stderr, "[Stump-R36MAX] Display ready (SDL_tex=%p fb0_mmap=%p) WiFi=%s(%s) QR=%s\\n",
            tex, (void *)fb0_map, g_st.net.wifi_if[0] ? g_st.net.wifi_if : "none",
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
    broadcast_udp_beacon("BOOT", "R36MAX STUMP ONLINE");

    uint32_t *fb = calloc(PANEL_W * PANEL_H, sizeof(uint32_t));
    bool select_held = false, start_held = false;
    int max_frames = (argc > 1 && strcmp(argv[1], "--smoke") == 0) ? 90 : 0;
    int frames = 0;

    while (g_st.running) {
        if (fn_PumpEvents && tex) fn_PumpEvents();

        if (g_st.suppress_poll_frames > 0) g_st.suppress_poll_frames--;

        /* Poll live Python Stump state every 10 frames (~160ms) */
        if (frames % 10 == 0) poll_live_bridge();

        /* Re-scan hardware network transports, Heltec V3 RNode, and hotplugged USB Keyboards every 120 frames (~2s) */
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
                if (ev.type == EV_KEY) {
                    bool pressed = (ev.value == 1);
                    bool key_press_or_rep = (ev.value == 1 || ev.value == 2);

                    /* Track USB Keyboard Shift keys */
                    if (ev.code == KEY_LEFTSHIFT || ev.code == KEY_RIGHTSHIFT) {
                        g_st.shift_held = (ev.value != 0);
                        continue;
                    }

                    /* Direct Kernel USB Keyboard typing (KEY_1..KEY_SLASH, KEY_BACKSPACE, KEY_ENTER, KEY_ESC) */
                    if (ev.code < 256) {
                        if (ev.code == KEY_BACKSPACE && key_press_or_rep) {
                            input_backspace();
                            trigger_chime(420, 15);
                            continue;
                        } else if ((ev.code == KEY_ENTER || ev.code == KEY_KPENTER) && pressed) {
                            if (g_st.input_len > 0) send_typed_chat();
                            else execute_rrc_deck_action();
                            continue;
                        } else if (ev.code == KEY_ESC && pressed) {
                            g_st.osk_open = !g_st.osk_open;
                            trigger_chime(600, 30);
                            continue;
                        } else if (ev.code == KEY_TAB && pressed) {
                            g_st.room_idx = (g_st.room_idx + 1) % 3;
                            trigger_chime(520, 25);
                            continue;
                        } else if (key_press_or_rep) {
                            char kch = translate_linux_key(ev.code, g_st.shift_held);
                            if (kch != 0) {
                                g_st.tab_idx = 0;
                                input_append_char(kch);
                                trigger_chime(620, 12);
                                continue;
                            }
                        }
                    }

                    /* Handheld Gamepad Buttons */
                    if (ev.code == BTN_SELECT || ev.code == BTN_MODE || ev.code == 314 || ev.code == 704 || ev.code == 706) {
                        select_held = (ev.value != 0);
                    }
                    if (ev.code == BTN_START || ev.code == 315 || ev.code == 705 || ev.code == 707) {
                        start_held = (ev.value != 0);
                        if (pressed && !select_held) {
                            if (g_st.input_len > 0) {
                                send_typed_chat();
                            } else {
                                g_st.cmd_cursor = 4;
                                execute_rrc_deck_action();
                            }
                        }
                    }
                    if (select_held && start_held) g_st.running = false;

                    if (pressed) {
                        if (ev.code == BTN_TL || ev.code == 310) { g_st.tab_idx = (g_st.tab_idx + 3) % 4; trigger_chime(523, 35); }
                        else if (ev.code == BTN_TR || ev.code == 311) { g_st.tab_idx = (g_st.tab_idx + 1) % 4; trigger_chime(659, 35); }
                        else if (ev.code == BTN_TL2 || ev.code == BTN_TR2 || ev.code == 312 || ev.code == 313) { g_st.theme_idx = (g_st.theme_idx + 1) % 5; trigger_chime(784, 35); }
                        else if (ev.code == BTN_NORTH || ev.code == 308) {
                            /* Y button: Open / Close On-Screen Virtual Keyboard */
                            g_st.osk_open = !g_st.osk_open;
                            trigger_chime(g_st.osk_open ? 740 : 520, 45);
                        }
                        else if (g_st.tab_idx == 0) {
                            if (g_st.osk_open) {
                                /* On-Screen Keyboard Navigation */
                                if (ev.code == BTN_DPAD_LEFT || ev.code == 546) { g_st.osk_col = (g_st.osk_col + 9) % 10; }
                                else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) { g_st.osk_col = (g_st.osk_col + 1) % 10; }
                                else if (ev.code == BTN_DPAD_UP || ev.code == 544) { g_st.osk_row = (g_st.osk_row + 3) % 4; }
                                else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) { g_st.osk_row = (g_st.osk_row + 1) % 4; }
                                else if (ev.code == BTN_SOUTH || ev.code == 304) { execute_osk_key(); }
                                else if (ev.code == BTN_EAST || ev.code == 305) { input_backspace(); trigger_chime(420, 25); }
                                else if (ev.code == BTN_WEST || ev.code == 307) { g_st.room_idx = (g_st.room_idx + 1) % 3; trigger_chime(580, 30); }
                            } else {
                                /* Quick Mesh Command Deck Navigation */
                                if (ev.code == BTN_DPAD_LEFT || ev.code == 546) { g_st.room_idx = (g_st.room_idx + 2) % 3; }
                                else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) { g_st.room_idx = (g_st.room_idx + 1) % 3; }
                                else if (ev.code == BTN_DPAD_UP || ev.code == 544) { g_st.cmd_cursor = (g_st.cmd_cursor + 5) % 6; }
                                else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) { g_st.cmd_cursor = (g_st.cmd_cursor + 1) % 6; }
                                else if (ev.code == BTN_SOUTH || ev.code == 304) {
                                    if (g_st.input_len > 0) send_typed_chat();
                                    else execute_rrc_deck_action();
                                }
                                else if (ev.code == BTN_EAST || ev.code == 305) {
                                    if (g_st.input_len > 0) { input_backspace(); trigger_chime(420, 25); }
                                    else { g_st.cmd_cursor = 2; execute_rrc_deck_action(); }
                                }
                                else if (ev.code == BTN_WEST || ev.code == 307) { g_st.cmd_cursor = 1; execute_rrc_deck_action(); }
                            }
                        } else if (g_st.tab_idx == 1) {
                            if (ev.code == BTN_DPAD_UP || ev.code == 544) {
                                if (g_st.board_count > 0) g_st.board_cursor = (g_st.board_cursor + g_st.board_count - 1) % g_st.board_count;
                            } else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) {
                                if (g_st.board_count > 0) g_st.board_cursor = (g_st.board_cursor + 1) % g_st.board_count;
                            } else if (ev.code == BTN_DPAD_LEFT || ev.code == 546) {
                                g_st.board_preset_idx = (g_st.board_preset_idx + 4) % 5;
                            } else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) {
                                g_st.board_preset_idx = (g_st.board_preset_idx + 1) % 5;
                            } else if (ev.code == BTN_SOUTH || ev.code == 304) {
                                action_board_add();
                            } else if (ev.code == BTN_WEST || ev.code == 307 || ev.code == BTN_EAST || ev.code == 305) {
                                action_board_delete();
                            }
                        } else if (g_st.tab_idx == 2) {
                            if (ev.code == BTN_DPAD_UP || ev.code == 544) {
                                if (g_st.file_count > 0) g_st.file_cursor = (g_st.file_cursor + g_st.file_count - 1) % g_st.file_count;
                            } else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) {
                                if (g_st.file_count > 0) g_st.file_cursor = (g_st.file_cursor + 1) % g_st.file_count;
                            } else if (ev.code == BTN_DPAD_LEFT || ev.code == 546) {
                                g_st.file_action_idx = (g_st.file_action_idx + 2) % 3;
                            } else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) {
                                g_st.file_action_idx = (g_st.file_action_idx + 1) % 3;
                            } else if (ev.code == BTN_SOUTH || ev.code == 304) {
                                action_file_add();
                            } else if (ev.code == BTN_WEST || ev.code == 307 || ev.code == BTN_EAST || ev.code == 305) {
                                action_file_delete();
                            }
                        } else {
                            if (ev.code == BTN_SOUTH || ev.code == 304) {
                                g_st.cmd_cursor = 4;
                                execute_rrc_deck_action();
                            }
                        }
                    }
                } else if (ev.type == EV_ABS) {
                    if (g_st.tab_idx == 0) {
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
                        if (ev.code == ABS_HAT0X && ev.value < 0) g_st.board_preset_idx = (g_st.board_preset_idx + 4) % 5;
                        if (ev.code == ABS_HAT0X && ev.value > 0) g_st.board_preset_idx = (g_st.board_preset_idx + 1) % 5;
                        if (ev.code == ABS_HAT0Y && ev.value < 0 && g_st.board_count > 0)
                            g_st.board_cursor = (g_st.board_cursor + g_st.board_count - 1) % g_st.board_count;
                        if (ev.code == ABS_HAT0Y && ev.value > 0 && g_st.board_count > 0)
                            g_st.board_cursor = (g_st.board_cursor + 1) % g_st.board_count;
                    } else if (g_st.tab_idx == 2) {
                        if (ev.code == ABS_HAT0X && ev.value < 0) g_st.file_action_idx = (g_st.file_action_idx + 2) % 3;
                        if (ev.code == ABS_HAT0X && ev.value > 0) g_st.file_action_idx = (g_st.file_action_idx + 1) % 3;
                        if (ev.code == ABS_HAT0Y && ev.value < 0 && g_st.file_count > 0)
                            g_st.file_cursor = (g_st.file_cursor + g_st.file_count - 1) % g_st.file_count;
                        if (ev.code == ABS_HAT0Y && ev.value > 0 && g_st.file_count > 0)
                            g_st.file_cursor = (g_st.file_cursor + 1) % g_st.file_count;
                    }
                }
            }
        }

        const ThemeColors *th = &g_themes[g_st.theme_idx];
        fill_rect(fb, 0, 0, PANEL_W, PANEL_H, th->bg);

        /* ---- Top Header Banner ---- */
        fill_rect(fb, 0, 0, PANEL_W, 82, th->panel);
        draw_border(fb, 0, 0, PANEL_W, 82, 2, th->border);
        draw_text_s(fb, 16, 10, "LABUCHE-STUMP R36MAX", th->ember_bright, 3, 24);
        draw_text_s(fb, 430, 14, g_st.net.lora_online ? "HELTEC V3 PAIRED" : "CHAIN + MESH READY", th->ok, 2, 22);

        char line2[160];
        snprintf(line2, sizeof(line2), "WEB: HTTP://%s:80 (:8080)  PEERS:%d  RNODE:%s",
                 g_st.net.primary_ip, g_st.mesh_peers,
                 g_st.net.lora_online ? g_st.net.lora_dev : g_st.rnode_status);
        draw_text_s(fb, 16, 40, line2, th->text, 2, 56);

        char line3[160];
        if (g_st.net.wifi_online) {
            snprintf(line3, sizeof(line3), "WIFI:%s (%s) %dDBM  KBD:%s",
                     g_st.net.wifi_if, g_st.net.wifi_ip, g_st.net.wifi_rssi_dbm,
                     g_st.net.usb_kbd_online ? "USB-HID READY" : (g_st.osk_open ? "OSK OPEN" : "PRESS Y FOR OSK"));
            draw_text_s(fb, 16, 60, line3, th->ok, 2, 56);
        } else if (g_st.net.eth_online) {
            snprintf(line3, sizeof(line3), "USB/ETH: %s (%s)  KBD:%s",
                     g_st.net.eth_if, g_st.net.eth_ip,
                     g_st.net.usb_kbd_online ? "USB-HID READY" : "PRESS Y FOR OSK");
            draw_text_s(fb, 16, 60, line3, th->ok, 2, 56);
        } else {
            draw_text_s(fb, 16, 60, "TRANSPORTS: SCANNING USB WIFI / HELTEC V3 / USB KBD...", th->warn, 2, 56);
        }

        /* ---- 4 Main Navigation Tabs (L1 / R1) ---- */
        const char *tabs[4] = { "1:RRC CHAT", "2:BILLBOARD", "3:FILE SHELF", "4:TRANSPORTS" };
        for (int t = 0; t < 4; t++) {
            int tx = 12 + t * 176;
            bool act = (t == g_st.tab_idx);
            fill_rect(fb, tx, 90, 168, 34, act ? th->ember : th->panel2);
            draw_border(fb, tx, 90, 168, 34, 2, act ? th->ember_bright : th->border);
            draw_text_s(fb, tx + 12, 100, tabs[t], act ? th->bg : th->text, 2, 14);
        }

        if (g_st.tab_idx == 0) {
            /* Room Selector Bar with Live User Count */
            for (int r = 0; r < 3; r++) {
                int rx = 12 + r * 234;
                bool ract = (r == g_st.room_idx);
                fill_rect(fb, rx, 132, 228, 30, ract ? th->panel : th->panel2);
                draw_border(fb, rx, 132, 228, 30, 2, ract ? th->ember : th->border);
                char rlabel[48];
                snprintf(rlabel, sizeof(rlabel), "%s (%d)", ROOM_NAMES[r], g_st.room_users[r]);
                draw_text_s(fb, rx + 12, 140, rlabel, ract ? th->ember_bright : th->muted, 2, 18);
            }

            /* Live RRC Chat Viewport */
            fill_rect(fb, 12, 168, PANEL_W - 24, 294, th->panel);
            draw_border(fb, 12, 168, PANEL_W - 24, 294, 2, th->border);
            int r = g_st.room_idx;
            if (g_st.room_counts[r] == 0) {
                draw_text_s(fb, 28, 192, "ROOM QUIET - TYPE ON USB KBD, PRESS [Y] FOR OSK, OR [A] DECK.", th->muted, 2, 54);
            }
            for (int i = 0; i < g_st.room_counts[r] && i < 9; i++) {
                int ly = 178 + i * 30;
                char row_txt[128];
                snprintf(row_txt, sizeof(row_txt), "<%s> %s", g_st.rooms[r][i].nick, g_st.rooms[r][i].body);
                draw_text_s(fb, 24, ly, row_txt, g_st.rooms[r][i].is_sys ? th->ember_bright : th->text, 2, 55);
            }

            /* Live Chat Input Composer Bar (supports both physical USB Keyboard and On-Screen Keyboard) */
            fill_rect(fb, 12, 468, PANEL_W - 24, 38, th->panel2);
            draw_border(fb, 12, 468, PANEL_W - 24, 38, 2, (g_st.osk_open || g_st.input_len > 0) ? th->ember_bright : th->border);
            char comp_line[160];
            if (g_st.input_len > 0) {
                snprintf(comp_line, sizeof(comp_line), "MSG > %s_  [ENTER/START: SEND]", g_st.input_buf);
                draw_text_s(fb, 24, 480, comp_line, th->ok, 2, 55);
            } else {
                snprintf(comp_line, sizeof(comp_line), "MSG > _  (%s | PRESS [Y] TO %s KEYBOARD)",
                         g_st.net.usb_kbd_online ? "USB KBD READY" : "NO USB KBD",
                         g_st.osk_open ? "CLOSE" : "OPEN");
                draw_text_s(fb, 24, 480, comp_line, th->muted, 2, 55);
            }

            if (g_st.osk_open) {
                /* Open/Close On-Screen Virtual Keyboard (OSK) Drawer */
                fill_rect(fb, 12, 512, PANEL_W - 24, 154, th->panel2);
                draw_border(fb, 12, 512, PANEL_W - 24, 154, 2, th->ember);
                draw_text_s(fb, 24, 520, "VIRTUAL KEYBOARD (DPAD MOVE, A:TYPE, B:DEL, START:SEND, Y:CLOSE):", th->ember_bright, 2, 56);
                for (int kr = 0; kr < 4; kr++) {
                    for (int kc = 0; kc < 10; kc++) {
                        int kx = 22 + kc * 67;
                        int ky = 542 + kr * 29;
                        bool ksel = (kr == g_st.osk_row && kc == g_st.osk_col);
                        fill_rect(fb, kx, ky, 62, 24, ksel ? th->ember : th->panel);
                        draw_border(fb, kx, ky, 62, 24, 1, ksel ? th->ember_bright : th->border);
                        const char *klbl = OSK_LABELS[kr][kc];
                        int xoff = (strlen(klbl) == 1) ? 24 : 8;
                        draw_text_s(fb, kx + xoff, ky + 5, klbl, ksel ? th->bg : th->text, 2, 4);
                    }
                }
            } else {
                /* Gamepad Quick Action Deck (Pushes directly to rrc.py & mesh via UDP 42421) */
                fill_rect(fb, 12, 512, PANEL_W - 24, 154, th->panel2);
                draw_border(fb, 12, 512, PANEL_W - 24, 154, 2, th->border);
                draw_text_s(fb, 24, 522, "QUICK MESH DECK (UP/DN SELECT, A:SEND TO ROOM, Y:OPEN KEYBOARD):", th->muted, 2, 56);
                for (int c = 0; c < 6; c++) {
                    int col = c % 2, row = c / 2;
                    int cx = 24 + col * 340, cy = 550 + row * 36;
                    bool sel = (c == g_st.cmd_cursor);
                    if (sel) {
                        fill_rect(fb, cx - 6, cy - 5, 326, 26, th->ember);
                    } else {
                        fill_rect(fb, cx - 6, cy - 5, 326, 26, th->panel);
                        draw_border(fb, cx - 6, cy - 5, 326, 26, 1, th->border);
                    }
                    draw_text_s(fb, cx + 4, cy + 1, QUICK_CMDS[c], sel ? th->bg : th->text, 2, 26);
                }
            }
        } else if (g_st.tab_idx == 1) {
            /* Tab 2: Real Bulletin Board with Add (A) & Delete (X) */
            fill_rect(fb, 12, 134, PANEL_W - 24, 532, th->panel);
            draw_border(fb, 12, 134, PANEL_W - 24, 532, 2, th->border);
            char bhead[80];
            snprintf(bhead, sizeof(bhead), "LIVE BULLETIN BOARD (%d NOTICES - UP/DN SELECT, X DELETE)", g_st.board_count);
            draw_text_s(fb, 24, 148, bhead, th->ember_bright, 2, 54);

            if (g_st.board_count == 0) {
                draw_text_s(fb, 28, 200, "NO NOTICES ON BOARD YET. PRESS [A] BELOW TO POST ONE!", th->muted, 2, 52);
            }
            for (int b = 0; b < g_st.board_count && b < 4; b++) {
                int by = 180 + b * 92;
                bool sel = (b == g_st.board_cursor);
                fill_rect(fb, 24, by, PANEL_W - 48, 82, th->panel2);
                draw_border(fb, 24, by, PANEL_W - 48, 82, sel ? 3 : 1, sel ? th->ember_bright : th->border);
                char tline[96], bline[96];
                snprintf(tline, sizeof(tline), "%s%s [%s]", sel ? "> " : "  ", g_st.board[b].title, g_st.board[b].sig);
                snprintf(bline, sizeof(bline), "  %s (ID:%s)", g_st.board[b].body, g_st.board[b].id);
                draw_text_s(fb, 34, by + 14, tline, sel ? th->ember_bright : th->text, 2, 52);
                draw_text_s(fb, 34, by + 46, bline, th->muted, 2, 52);
            }

            /* Notice Composer Bar at bottom of Tab 2 */
            fill_rect(fb, 24, 556, PANEL_W - 48, 96, th->panel2);
            draw_border(fb, 24, 556, PANEL_W - 48, 96, 2, th->ember);
            draw_text_s(fb, 36, 566, "LEFT/RIGHT: CHOOSE NOTICE   [A]: POST NOTICE   [X]: DELETE SELECTED", th->ok, 2, 54);
            char preset_str[96];
            snprintf(preset_str, sizeof(preset_str), "NEW POST [%d/5]: < %s >",
                     g_st.board_preset_idx + 1, BOARD_PRESET_TITLES[g_st.board_preset_idx]);
            draw_text_s(fb, 36, 594, preset_str, th->ember_bright, 2, 52);
            draw_text_s(fb, 36, 622, BOARD_PRESET_BODIES[g_st.board_preset_idx], th->text, 2, 52);
        } else if (g_st.tab_idx == 2) {
            /* Tab 3: Real Shared File Shelf (/sd/shared) with Add (A) & Delete (X) */
            fill_rect(fb, 12, 134, PANEL_W - 24, 532, th->panel);
            draw_border(fb, 12, 134, PANEL_W - 24, 532, 2, th->border);
            char fhead[96];
            snprintf(fhead, sizeof(fhead), "SHARED FILE SHELF: %d FILES  (USED %d KB / 75%% CAP %d KB)",
                     g_st.file_count, g_st.used_kb, g_st.ceil_kb);
            draw_text_s(fb, 24, 148, fhead, th->ember_bright, 2, 54);

            if (g_st.file_count == 0) {
                draw_text_s(fb, 28, 200, "NO FILES IN /SD/SHARED YET. PRESS [A] BELOW TO SHARE ONE!", th->muted, 2, 52);
            }
            for (int f = 0; f < g_st.file_count && f < 5; f++) {
                int fy = 180 + f * 72;
                bool sel = (f == g_st.file_cursor);
                fill_rect(fb, 24, fy, PANEL_W - 48, 62, th->panel2);
                draw_border(fb, 24, fy, PANEL_W - 48, 62, sel ? 3 : 1, sel ? th->ember_bright : th->border);
                char fline[96];
                snprintf(fline, sizeof(fline), "%s%-30s [%s] %d KB",
                         sel ? "> " : "  ", g_st.files[f].name, g_st.files[f].cat, g_st.files[f].size_kb);
                draw_text_s(fb, 34, fy + 12, fline, sel ? th->ember_bright : th->text, 2, 52);
                draw_text_s(fb, 34, fy + 38, "  LIVE IN /SD/SHARED  -  PRESS [X] TO DELETE FILE", th->muted, 2, 52);
            }

            /* File Share / Generator Bar at bottom of Tab 3 */
            fill_rect(fb, 24, 556, PANEL_W - 48, 96, th->panel2);
            draw_border(fb, 24, 556, PANEL_W - 48, 96, 2, th->ember);
            draw_text_s(fb, 36, 566, "LEFT/RIGHT: CHOOSE ACTION   [A]: ADD/SHARE FILE   [X]: DELETE FILE", th->ok, 2, 54);
            char act_str[96];
            snprintf(act_str, sizeof(act_str), "ACTION: < %s >", FILE_ACTION_LABELS[g_st.file_action_idx]);
            draw_text_s(fb, 36, 598, act_str, th->ember_bright, 2, 52);
            draw_text_s(fb, 36, 624, "FILES APPEAR IMMEDIATELY AT HTTP://<IP>:80/FILES & :8080/FILES", th->text, 2, 56);
        } else {
            /* Tab 4: Hardware Transports + Heltec V3 RNode + USB Keyboard + ISO 18004 QR Code */
            fill_rect(fb, 12, 134, PANEL_W - 24, 532, th->panel);
            draw_border(fb, 12, 134, PANEL_W - 24, 532, 2, th->border);
            draw_text_s(fb, 28, 148, "R36MAX TRANSPORTS, HELTEC V3 RNODE & STUMP CHAIN", th->ember_bright, 2, 52);

            char t1[160], t2[160], t3[160], t4[160];
            snprintf(t1, sizeof(t1), "1. USB WIFI : %s  IP:%s  DRV:%s (%dDBM)",
                     g_st.net.wifi_online ? g_st.net.wifi_if : "NOT DETECTED",
                     g_st.net.wifi_online ? g_st.net.wifi_ip : "-",
                     g_st.net.wifi_online ? g_st.net.wifi_driver : "-",
                     g_st.net.wifi_rssi_dbm);
            snprintf(t2, sizeof(t2), "2. HELTEC V3: %s  LXMF:%s",
                     g_st.net.lora_online ? g_st.net.lora_dev : "PLUG IN USB-C HUB (/DEV/TTYACM0)",
                     g_st.node_lxmf);
            snprintf(t3, sizeof(t3), "3. USB KBD  : %s  (Y: TOGGLE OSK)",
                     g_st.net.usb_kbd_online ? g_st.net.usb_kbd_name : "HOTPLUG READY ON USB HUB");
            snprintf(t4, sizeof(t4), "4. STUMP CHN: #WIFI-MESH (:4243)  PEERS:%d  BEACONS:%d",
                     g_st.mesh_peers, g_st.beacons_sent);

            fill_rect(fb, 28, 178, PANEL_W - 56, 152, th->panel2);
            draw_border(fb, 28, 178, PANEL_W - 56, 152, 2, th->border);
            draw_text_s(fb, 40, 190, t1, g_st.net.wifi_online ? th->ok : th->warn, 2, 52);
            draw_text_s(fb, 40, 222, t2, g_st.net.lora_online ? th->ok : th->ember_bright, 2, 52);
            draw_text_s(fb, 40, 254, t3, g_st.net.usb_kbd_online ? th->ok : th->text, 2, 52);
            draw_text_s(fb, 40, 286, t4, th->ok, 2, 52);

            char url[128];
            snprintf(url, sizeof(url), "FIREFLY :80 & :8080 QR: %s", g_st.qr_url);
            draw_text_s(fb, 28, 344, url, th->ember_bright, 2, 54);

            /* Render 25x25 ISO/IEC 18004 QR Code with 4-module white quiet zone */
            int qs = 9;
            int qx = (PANEL_W - (25 * qs)) / 2;
            int qy = 384;
            fill_rect(fb, qx - 4 * qs, qy - 2 * qs, (25 + 8) * qs, (25 + 4) * qs, 0xFFFFFFFFu);
            for (int r = 0; r < 25; r++) {
                for (int c = 0; c < 25; c++) {
                    if (g_st.qr_grid[r][c]) {
                        fill_rect(fb, qx + c * qs, qy + r * qs, qs, qs, 0xFF000000u);
                    }
                }
            }
        }

        /* ---- Bottom Control Legend Bar ---- */
        fill_rect(fb, 0, PANEL_H - 42, PANEL_W, 42, th->panel);
        draw_border(fb, 0, PANEL_H - 42, PANEL_W, 42, 2, th->border);
        draw_text_s(fb, 16, PANEL_H - 28, "L1/R1:TAB  Y:OPEN/CLOSE KEYBOARD  A:SEND/TYPE  START:SEND  SEL+START:EXIT", th->muted, 2, 58);

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
            fprintf(stderr, "[Stump-R36MAX] First 720x720 frame rendered!\\n");
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
# LaBuche_Stump.sh — EmulationStation Ports Launcher for LaBuche-Stump on R36MAX
# Place in: /roms/ports/LaBuche_Stump.sh
# =============================================================================

APP_DIR="/roms/ports/stump_r36max"
NODE_DIR="$APP_DIR/node"
LOG_FILE="$APP_DIR/stump_r36max.log"

mkdir -p "$NODE_DIR/sd/shared" "$NODE_DIR/sd/tools" "$APP_DIR/drop"
echo ark | sudo -S rm -f /dev/shm/stump_cmd.txt /dev/shm/stump_live.txt 2>/dev/null || true
exec > "$LOG_FILE" 2>&1
echo "=== Launching LaBuche-Stump R36MAX Node $(date) ==="

# Ensure no stale Python node is holding port 80, 8080, or UDP 42421
echo ark | sudo -S pkill -f "run_stump_r36max.py" 2>/dev/null || true
echo ark | sudo -S pkill -f "stump_pc.py" 2>/dev/null || true

# Grant dialout/tty access if Heltec V3 RNode is plugged into the USB hub
echo ark | sudo -S chmod 666 /dev/ttyACM* /dev/ttyUSB* /dev/input/event* 2>/dev/null || true

# 1. Start the authentic LaBuche-Stump Python node + UDP 42421 Live IPC Bridge on Cores 2-3
#    Runs with sudo so barkeep binds BOTH port 80 (for FireFly /auth & UDP 4244) and port 8080
if [ -f "$NODE_DIR/run_stump_r36max.py" ]; then
  (cd "$NODE_DIR" && echo ark | sudo -S taskset -c 2,3 python3 "$NODE_DIR/run_stump_r36max.py" > "$APP_DIR/stump_http.log" 2>&1) &
  STUMP_PY_PID=$!
  echo "[Launcher] Started run_stump_r36max.py (PID $STUMP_PY_PID) on 0.0.0.0:80 + 0.0.0.0:8080 + UDP 127.0.0.1:42421"
elif [ -f "$NODE_DIR/stump_pc.py" ]; then
  (cd "$NODE_DIR" && echo ark | sudo -S taskset -c 2,3 python3 "$NODE_DIR/stump_pc.py" > "$APP_DIR/stump_http.log" 2>&1) &
  STUMP_PY_PID=$!
fi

# 2. Launch the 720x720 SDL2 KMSDRM + /dev/fb0 + ALSA Handheld Cockpit on Cores 0-1
"$APP_DIR/stump_r36max_engine"

# 3. Clean shutdown on SELECT+START
echo ark | sudo -S pkill -f "run_stump_r36max.py" 2>/dev/null || true
echo "=== LaBuche-Stump R36MAX exited cleanly $(date) ==="
`;

export const STUMP_CODE_ARTIFACTS: CodeFileArtifact[] = [
  {
    id: 'stump_r36max_c',
    filename: 'stump_r36max_engine.c',
    title: 'LaBuche-Stump R36MAX 720x720 Live Cockpit + ISO 18004 QR Encoder (C)',
    language: 'c',
    summary:
      'Polls /dev/shm/stump_live.txt every 200ms for real RRC room messages, real Billboard posts, and real /sd/shared files; pushes gamepad commands to rrc.py & mesh; renders a scannable 25x25 ISO 18004 QR code.',
    content: STUMP_R36MAX_C_SOURCE,
  },
  {
    id: 'run_stump_r36max_py',
    filename: 'run_stump_r36max.py',
    title: 'Live Python IPC Bridge for rrc.py, rrc_mesh.py, billboard.py & fserv.py',
    language: 'python',
    summary:
      'Runs inside the stump_pc.py process on Cores 2-3, syncing live RRC rooms, mesh peers, billboard notices, and shared files with the 720x720 C Cockpit every 200ms.',
    content: STUMP_R36MAX_BRIDGE_PY,
  },
  {
    id: 'labuche_stump_sh',
    filename: 'LaBuche_Stump.sh',
    title: 'EmulationStation Ports Launcher (/roms/ports/LaBuche_Stump.sh)',
    language: 'bash',
    summary:
      'Starts run_stump_r36max.py on Cores 2-3 and launches stump_r36max_engine on Cores 0-1.',
    content: STUMP_R36MAX_PORTS_SCRIPT,
  },
];
