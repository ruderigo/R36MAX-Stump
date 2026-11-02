#!/usr/bin/env python3
"""The cockpit's feed against a real, unmodified Stump: SandBox_Stump_On's
stump_pc.py in a folder made by its own Provisioner functions, exactly as
install.sh makes the R36MAX's. Every cockpit command is sent the way the
engine sends it (UDP), and checked in the Stump itself (its public API) and
in the live file the engine reads.

    python3 handheld/tests/test_with_stump.py PATH/TO/SandBox_Stump_On

Needs the Stump's packages (cryptography, pyserial). Linux. Uses its own
ports and temporary folders; stops what it started.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
HANDHELD = os.path.dirname(HERE)
FAIL = []


def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + repr(info)[:600]), flush=True)
    if not cond:
        FAIL.append(name)


def free_port(kind=socket.SOCK_STREAM):
    s = socket.socket(socket.AF_INET, kind)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait(cond, secs, step=0.5):
    end = time.time() + secs
    while time.time() < end:
        try:
            if cond():
                return True
        except Exception:
            pass
        time.sleep(step)
    return False


def main():
    if len(sys.argv) < 2 or not os.path.isfile(os.path.join(sys.argv[1], "provisioner.py")):
        sys.exit(__doc__)
    sandbox = os.path.abspath(sys.argv[1])
    sys.path.insert(0, sandbox)
    import builtins
    builtins.input = lambda *a: ""
    import provisioner as P
    from pathlib import Path

    work = tempfile.mkdtemp(prefix="r36max-test-")
    stump_dir, app_dir = os.path.join(work, "Stump"), os.path.join(work, "app")
    os.makedirs(os.path.join(app_dir, "drop"))
    http = free_port()
    ipc = free_port(socket.SOCK_DGRAM)
    live, cmdf = os.path.join(work, "live.txt"), os.path.join(work, "cmd.txt")
    procs = []
    try:
        # ── the Stump, as provisioner.py --pc makes it ──────────────────
        fw = Path(sandbox) / "final_firmware"
        os.makedirs(stump_dir)
        P._pc_copy_firmware(fw, stump_dir)
        P._pc_write_config(fw, stump_dir, dict(node_name="R36Test", wifi_ssid="", wifi_pass="", heltec_host="",
                                               heltec_port=0, pc_heltec="none", pc_hotspot_name="R36Test",
                                               pc_storage_mb=256, chain={"enabled": False}))
        cfg = os.path.join(stump_dir, "config.py")
        text = open(cfg, encoding="utf-8").read()
        text += "\nAUTH_ADMIN_PASSWORD = 'test-admin-pw'\nPC_HTTP_PORT = %d\nPC_HOTSPOT_IP = '127.0.0.1'\n" % http
        open(cfg, "w", encoding="utf-8").write(text)
        procs.append(subprocess.Popen([sys.executable, "-u", "stump_pc.py"], cwd=stump_dir,
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True))
        base = "http://127.0.0.1:%d" % http
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        get = lambda path: json.loads(op.open(base + path, timeout=5).read().decode())
        check("the stock Stump starts and answers /node.json", wait(lambda: get("/node.json").get("lxmf"), 60),
              procs[0].poll())

        # ── the feed, as the launcher starts it ─────────────────────────
        env = dict(os.environ, STUMP_DIR=stump_dir, STUMP_R36MAX_DIR=app_dir, STUMP_LIVE_FILE=live,
                   STUMP_CMD_FILE=cmdf, STUMP_IPC_PORT=str(ipc), STUMP_HTTP_PORT=str(http),
                   STUMP_COCKPIT_NICK="r36max")
        procs.append(subprocess.Popen([sys.executable, "-I", os.path.join(HANDHELD, "cockpit_feed.py")], env=env,
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True))
        lines = lambda: open(live, encoding="utf-8").read().splitlines()
        check("the feed writes the live file, with the Stump's address and release",
              wait(lambda: any(l.startswith("META|") and len(l.split("|")[1]) == 32 for l in lines()), 30),
              lines() if os.path.exists(live) else "no live file")

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        send = lambda cmd: sock.sendto(cmd.encode("utf-8"), ("127.0.0.1", ipc))

        # ── chat, with real text (accents, case, symbols) ───────────────
        send("RRC|wifi-mesh|Bonjour ! Été à Montréal → LaBuche_Cabin")
        seen = lambda: [m for m in json.loads(op.open(base + "/rrc/poll?room=wifi-mesh&since=0", timeout=5).read())
                        .get("messages", [])]
        # a second client (a browser) joins #wifi-mesh to read it
        browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(), urllib.request.ProxyHandler({}))
        browser.open(base + "/").read()
        browser.open(urllib.request.Request(base + "/rrc/send", data=b"/join wifi-mesh", method="POST")).read()
        said = lambda: [m["body"] for m in json.loads(browser.open(base + "/rrc/poll?room=wifi-mesh&since=0").read())
                        .get("messages", []) if m.get("nick") == "r36max"]
        check("a chat line reaches the Stump exactly (case, accents, arrow)",
              wait(lambda: "Bonjour ! Été à Montréal → LaBuche_Cabin" in said(), 20), said())
        check("... and comes back in the live file as it was sent",
              wait(lambda: any(l.startswith("MSG|2|0|r36max|Bonjour ! Été à Montréal") for l in lines()), 20),
              [l for l in lines() if l.startswith("MSG|2")])

        # ── billboard: post, back up, delete ────────────────────────────
        send("BOARD_ADD|Marché samedi|L'été à 10h")
        posts = lambda: get("/billboard.json").get("posts", [])
        check("a notice is posted through /post", wait(lambda: any(p["title"] == "Marché samedi" for p in posts()), 20),
              posts())
        check("... and listed in the live file", wait(lambda: any(l.startswith("BOARD|") and "Marché samedi" in l
                                                                  for l in lines()), 20))
        send("BOARD_BACKUP_TF|")
        tf = os.path.join(app_dir, "tf_backup")
        check("notices backed up to the TF card", wait(lambda: any(f.startswith("billboard_") and "Marché samedi" in
                                                                   open(os.path.join(tf, f), encoding="utf-8").read()
                                                                   for f in os.listdir(tf)), 15))
        pid = next(p["id"] for p in posts() if p["title"] == "Marché samedi")
        send("BOARD_DEL_MULTI|%s" % pid)
        check("a notice is deleted through the Stump's /admin", wait(lambda: not posts(), 20), posts())

        # ── files: share from drop/, back up, delete ────────────────────
        with open(os.path.join(app_dir, "drop", "Carte du sentier, été.txt"), "w", encoding="utf-8") as f:
            f.write("la carte\n")
        send("FILE_ADD|0")
        files = lambda: [f["name"] for f in get("/files.json").get("files", [])]
        check("a file in drop/ is shared through /upload, its name intact",
              wait(lambda: "Carte du sentier, été.txt" in files(), 20), files())
        check("... and moved to drop/_shared", os.path.exists(os.path.join(app_dir, "drop", "_shared",
                                                                         "Carte du sentier, été.txt")))
        shown = next((l.split("|")[1] for l in lines() if l.startswith("FILE|")), "")
        check("the live file shows it with no comma (the cockpit's list separator)", shown and "," not in shown, shown)
        send("FILE_BACKUP_TF|%s" % shown)
        check("a file is copied to the TF card", wait(lambda: os.path.exists(os.path.join(tf, "Carte du sentier, été.txt")), 15))
        send("FILE_DEL_MULTI|%s" % shown)
        check("a file is deleted by its shown name (the feed maps it back)", wait(lambda: not files(), 20), files())

        # ── the rest ─────────────────────────────────────────────────────
        send("DEBUG_EXPORT_TF")
        check("diagnostics saved to the TF card", wait(lambda: any(f.startswith("diagnostics_") for f in os.listdir(tf)), 15))
        check("the live file has every line the engine reads",
              all(any(l.startswith(k + "|") for l in lines()) for k in ("META", "VER", "BUSY", "AP", "CHAIN", "ROOM",
                                                                        "STORAGE")), lines()[:8])
        open(cmdf, "w").write("CHAIN_SCAN\n")
        check("commands also arrive through the command file",
              wait(lambda: not os.path.exists(cmdf) and any("Stump(s) on this network" in l for l in lines()), 15))
    except Exception:
        import traceback
        check("the test ran to the end", False, traceback.format_exc())
    finally:
        logs = []
        for p in procs:
            p.terminate()
            try:
                logs.append(p.communicate(timeout=15)[0])
            except subprocess.TimeoutExpired:
                p.kill()
                logs.append(p.communicate()[0])
        for name, log in zip(("Stump", "feed"), logs):
            check("no traceback in the %s's output" % name, "Traceback" not in (log or ""), (log or "")[-1500:])
        shutil.rmtree(work, ignore_errors=True)
    print("FAILURES %s" % FAIL if FAIL else "all passed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
