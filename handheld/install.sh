#!/bin/bash
# =============================================================================
# install.sh — makes the R36MAX a Stump like any other (v2.0.0-r36max)
#
# Run ON THE HANDHELD, as ark, with internet (once, for packages):
#   git clone -b r36max-pc-stump https://github.com/ruderigo/R36MAX-Stump ~/R36MAX-Stump
#   bash ~/R36MAX-Stump/handheld/install.sh
# Run it again to update (it pulls both repos and re-runs the Stump's own update).
#
# What it does:
#   1. Packages: git, python3-venv, gcc + ALSA headers, NetworkManager, iw, pygame.
#   2. SandBox_Stump_On in ~/SandBox_Stump_On (clone, or pull).
#   3. The Stump in ~/Stump, by SandBox_Stump_On's own `provisioner.py --pc`:
#      the same wizard, files, venv and start-at-login service as every
#      computer Stump (docs/PC.md). Nothing in the firmware is changed.
#   4. Two things a Linux laptop doesn't need but a walk-up handheld does,
#      both outside the Stump: the Stump's own Python may use ports 80 and 53
#      (a capability on its venv's python only), and the hotspot's DHCP
#      points phones at the Stump's own captive DNS.
#   5. The cockpit: engine (compiled here), display, feed, Ports launcher.
#   The old v1.x bridge is put aside first (moved, nothing deleted).
# =============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
ME="$(id -un)"; MY_UID="$(id -u)"
STUMP_DIR="${STUMP_DIR:-$HOME/Stump}"
SANDBOX="${SANDBOX_DIR:-$HOME/SandBox_Stump_On}"
SANDBOX_URL="https://github.com/ruderigo/SandBox_Stump_On.git"
COCKPIT_DIR="$HOME/stump_r36max"
APP_DIR="/roms/ports/stump_r36max"
export XDG_RUNTIME_DIR="/run/user/$MY_UID"

step() { printf '\n\033[1;33m>>> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[31m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m[x] %s\033[0m\n' "$*"; exit 1; }

[ "$MY_UID" -eq 0 ] && die "Run this as your user (ark), not root: it asks for sudo when it needs it."
# This repo first (an update), then start again on the new copy of this script.
if [ -z "${STUMP_INSTALL_PULLED:-}" ] && [ -d "$REPO/.git" ]; then
  git -C "$REPO" pull --ff-only -q 2>/dev/null || true
  STUMP_INSTALL_PULLED=1 exec bash "$HERE/install.sh" "$@"
fi
sudo -v || die "sudo is needed for packages and the hotspot settings."

# ── 1. packages ──────────────────────────────────────────────────────────────
step "1/6 Packages"
NEED=""
have() { command -v "$1" >/dev/null 2>&1 || [ -x "/usr/sbin/$1" ] || [ -x "/sbin/$1" ]; }
have git      || NEED="$NEED git"
python3 -c "import ensurepip" >/dev/null 2>&1 || NEED="$NEED python3-venv"
have gcc      || NEED="$NEED gcc"
[ -f /usr/include/alsa/asoundlib.h ] || NEED="$NEED libasound2-dev"
have nmcli    || NEED="$NEED network-manager"
have iw       || NEED="$NEED iw"
have setcap   || NEED="$NEED libcap2-bin"
if ! "$HOME/firefly/venv/bin/python" -c "import pygame" >/dev/null 2>&1 && ! python3 -c "import pygame" >/dev/null 2>&1; then
  NEED="$NEED python3-pygame"
fi
if [ -n "$NEED" ]; then
  echo "    installing:$NEED"
  sudo apt-get update -q && sudo apt-get install -y -q $NEED || die "apt-get couldn't install:$NEED"
  sudo apt-get clean
fi
ok "packages ready"

# ── 2. SandBox_Stump_On ─────────────────────────────────────────────────────
step "2/6 SandBox_Stump_On (the Stump firmware and its Provisioner)"
if [ -d "$SANDBOX/.git" ]; then
  git -C "$SANDBOX" pull --ff-only || warn "couldn't update $SANDBOX (keeping what's there)"
else
  git clone --depth 1 "$SANDBOX_URL" "$SANDBOX" || die "couldn't clone $SANDBOX_URL"
fi
ok "$(cd "$SANDBOX" && git log -1 --format='%h %s' | cut -c1-70)"

# ── 3. The old v1.x bridge, put aside ───────────────────────────────────────
step "3/6 Putting the old v1.x bridge aside"
pkill -TERM -f "^[^ ]*python[^ ]* .*run_stump_r36max\.py" 2>/dev/null && ok "stopped run_stump_r36max.py"
for pat in "[s]tump_hostapd" "[s]tump_wpa_ap" "[s]tump_dnsmasq.conf"; do sudo pkill -f "$pat" 2>/dev/null; done
sudo nmcli connection delete StumpCAM >/dev/null 2>&1
if [ -d "$APP_DIR/node" ]; then
  OLD="$APP_DIR/v1-old-$(date +%Y%m%d-%H%M%S)"
  sudo mkdir -p "$OLD" "$APP_DIR/drop" && sudo chown "$ME" "$APP_DIR" "$OLD" "$APP_DIR/drop" 2>/dev/null
  # Files people shared on the old node: into drop/, to share again from the
  # cockpit (through the Stump's /upload, so its shelf and quotas apply).
  if [ -d "$APP_DIR/node/sd/shared" ]; then
    n=$(find "$APP_DIR/node/sd/shared" -maxdepth 1 -type f ! -name '.*' | wc -l)
    find "$APP_DIR/node/sd/shared" -maxdepth 1 -type f ! -name '.*' -exec cp -n {} "$APP_DIR/drop/" \; 2>/dev/null
    [ "$n" -gt 0 ] && ok "$n file(s) the old node shared copied to $APP_DIR/drop/ (share them again from FILES)"
  fi
  for f in node run_stump_r36max.py stump_r36max_engine.c stump_r36max_engine start_all.sh stump_pygame_display.py \
           stump_http.log stump_r36max.log; do
    [ -e "$APP_DIR/$f" ] && sudo mv "$APP_DIR/$f" "$OLD/" 2>/dev/null
  done
  ok "old files moved to $OLD (delete it once you're happy)"
else
  ok "nothing to put aside"
fi
sudo mkdir -p "$APP_DIR/drop" "$APP_DIR/tf_backup" && sudo chown -R "$ME" "$APP_DIR" 2>/dev/null

# ── 4. The Stump, exactly as on any computer ────────────────────────────────
step "4/6 The Stump: provisioner.py --pc (the same wizard as every computer Stump)"
# A user service that runs from boot, with or without anyone logged in.
sudo loginctl enable-linger "$ME" && ok "user services start at boot (loginctl enable-linger $ME)"
for _ in 1 2 3 4 5 6 7 8 9 10; do systemctl --user show-environment >/dev/null 2>&1 && break; sleep 1; done
systemctl --user show-environment >/dev/null 2>&1 || warn "no systemd user manager yet: the Provisioner's start-at-login may fail (log out and in, or reboot, then run this again)"
# The Stump's own Python, as a real file (--copies), so the port capability
# below applies to it alone. The Provisioner keeps a venv that's already there.
if [ ! -x "$STUMP_DIR/venv/bin/python" ]; then
  mkdir -p "$STUMP_DIR"
  python3 -m venv --copies "$STUMP_DIR/venv" || die "python3 -m venv failed (sudo apt install python3-venv)"
fi
echo
echo "    The Provisioner asks its questions now. Answer them as for macOS1:"
echo "      folder: $STUMP_DIR  ·  chain: 'Joins another Stump's Wi-Fi' -> 'On the Wi-Fi it's on now'"
echo "      -> LaBuche3's address -> the chain's secret  ·  Heltec: 'on USB' if it's plugged in"
echo "      ·  start at login: yes"
echo
(cd "$SANDBOX" && python3 provisioner.py --pc "$STUMP_DIR") || die "provisioner.py --pc stopped (its message is above)"
[ -f "$STUMP_DIR/stump_pc.py" ] || die "no Stump in $STUMP_DIR after the Provisioner"
ok "the Stump is in $STUMP_DIR"

# ── 5. Walk-up extras, outside the Stump ────────────────────────────────────
step "5/6 Ports 80 and 53 for the Stump's own Python, and the hotspot's captive DNS"
PY_REAL="$(readlink -f "$STUMP_DIR/venv/bin/python")"
case "$PY_REAL" in
  "$STUMP_DIR"/venv/*)
    SETCAP="$(command -v setcap || echo /usr/sbin/setcap)"
    if sudo "$SETCAP" cap_net_bind_service=+ep "$PY_REAL"; then
      ok "the Stump may serve on :80 and answer DNS on :53 ($PY_REAL only)"
      CAP=1
    else
      warn "setcap failed: the Stump will serve on :8080 and phones won't get the sign-in pop-up"; CAP=0
    fi ;;
  *) warn "the venv's python is a link to $PY_REAL, not its own copy: not giving it ports <1024"; CAP=0 ;;
esac
if [ "$CAP" = 1 ] && [ -d /etc/NetworkManager ]; then
  # The hotspot (NetworkManager "shared", 10.42.0.1) keeps its DHCP; DNS goes to
  # the Stump's own captive DNS on :53, as on a CAM's walk-up Wi-Fi.
  sudo mkdir -p /etc/NetworkManager/dnsmasq-shared.d
  printf '%s\n' "# R36MAX Stump (R36MAX-Stump/handheld/install.sh): the hotspot's DNS is the Stump's own" \
                "port=0" "dhcp-option=option:dns-server,10.42.0.1" | sudo tee /etc/NetworkManager/dnsmasq-shared.d/stump.conf >/dev/null
  ok "hotspot phones use the Stump's DNS (sign-in pop-up)"
fi
# The screen and gamepad for the user who runs the cockpit: its groups (they
# apply from the next boot), and the devices opened up now for this boot.
for g in video render input tty; do
  getent group "$g" >/dev/null && sudo usermod -aG "$g" "$ME"
done
sudo chmod 666 /dev/dri/card* /dev/dri/render* /dev/fb0 /dev/input/event* 2>/dev/null
ok "screen and gamepad: $ME is in $(id -nG "$ME" | tr ' ' ',')"

# Passwordless sudo for exactly what the cockpit does (devices, cursor, Wi-Fi,
# restarting the Stump's service).
SYSTEMCTL="$(command -v systemctl || echo /usr/bin/systemctl)"
SUDOERS=/etc/sudoers.d/stump-r36max
TMP="$(mktemp)"
printf '%s\n' "# R36MAX Stump cockpit (R36MAX-Stump/handheld/install.sh)" \
  "$ME ALL=(root) NOPASSWD: /usr/bin/nmcli, /usr/bin/chmod, /usr/bin/tee, /usr/sbin/iw, /usr/bin/iw, $SYSTEMCTL start stump-$ME, $SYSTEMCTL restart stump-$ME" > "$TMP"
chmod 644 "$TMP"
VISUDO=""
for v in "$(command -v visudo 2>/dev/null)" /usr/sbin/visudo /sbin/visudo; do [ -n "$v" ] && [ -x "$v" ] && VISUDO="$v" && break; done
if [ -n "$VISUDO" ]; then
  if sudo "$VISUDO" -cf "$TMP" >/dev/null; then sudo install -m 0440 "$TMP" "$SUDOERS" && ok "sudoers: $SUDOERS"
  else warn "sudoers check failed: not installed"; fi
else
  # No visudo here (dArkOS): put it in place and have sudo itself read it, as
  # root, in the same shell; any error and it's removed there, so sudo never
  # breaks. (sudo exits 0 even on a syntax error: its message is what counts.)
  if sudo sh -c 'install -m 0440 "$1" "$2" || exit 1
                 if sudo -l -U "$3" 2>&1 | grep -qiE "syntax error|parse error|no valid sudoers"; then rm -f "$2"; exit 1; fi' \
       sh "$TMP" "$SUDOERS" "$ME"; then
    ok "sudoers: $SUDOERS (checked by sudo itself; no visudo here)"
  else
    warn "sudoers not installed (sudo couldn't read it)"
  fi
fi
rm -f "$TMP"

# How the Stump starts at boot: the Provisioner's user service when this system
# has a user manager; otherwise (dArkOS) a system service that runs it as $ME.
if systemctl --user is-enabled stump >/dev/null 2>&1 && systemctl --user restart stump 2>/dev/null; then
  ok "the Stump restarted with its ports (systemd --user: stump)"
else
  UNIT="/etc/systemd/system/stump-$ME.service"
  printf '%s\n' "[Unit]" "Description=Stump ($STUMP_DIR, R36MAX-Stump/handheld/install.sh)" \
    "After=network-online.target" "Wants=network-online.target" "" "[Service]" "User=$ME" \
    "WorkingDirectory=$STUMP_DIR" "Environment=PYTHONUNBUFFERED=1" \
    "ExecStart=$STUMP_DIR/venv/bin/python $STUMP_DIR/stump_pc.py --service" \
    "Restart=on-failure" "RestartSec=5" "" "[Install]" "WantedBy=multi-user.target" | sudo tee "$UNIT" >/dev/null
  # A copy started by hand or by the Start file, stopped first (radio off).
  [ -x "$STUMP_DIR/stop-stump.sh" ] && sh "$STUMP_DIR/stop-stump.sh" >/dev/null 2>&1
  pkill -TERM -f "^[^ ]*python[^ ]* .*$STUMP_DIR/stump_pc\.py" 2>/dev/null; sleep 2
  sudo systemctl daemon-reload && sudo systemctl enable "stump-$ME" >/dev/null 2>&1 && sudo systemctl restart "stump-$ME" \
    && ok "the Stump runs from boot as a system service: stump-$ME (no user manager here)" \
    || warn "couldn't start stump-$ME: sudo systemctl status stump-$ME"
fi

# ── 6. The cockpit ──────────────────────────────────────────────────────────
step "6/6 The cockpit (720x720 screen, gamepad, Ports launcher)"
mkdir -p "$COCKPIT_DIR"
cp -f "$HERE/cockpit_feed.py" "$HERE/stump_pygame_display.py" "$HERE/stump_r36max_engine.c" "$COCKPIT_DIR/"
CFLAGS="-O2 -Wall -Wno-format-truncation"
grep -qi "cortex-a35\|rk3326" /proc/device-tree/compatible /proc/cpuinfo 2>/dev/null && CFLAGS="$CFLAGS -mcpu=cortex-a35"
gcc $CFLAGS "$COCKPIT_DIR/stump_r36max_engine.c" -o "$COCKPIT_DIR/stump_r36max_engine" -lasound -lpthread -ldl -lm \
  || die "the engine didn't compile (gcc's message is above)"
"$COCKPIT_DIR/stump_r36max_engine" --smoke >/dev/null 2>&1 && ok "engine built, smoke test passed" || warn "engine built; its smoke test failed"
for ports in /roms/ports /roms2/ports; do
  [ -d "$ports" ] || continue
  sudo cp -f "$HERE/LaBuche_Stump.sh" "$ports/LaBuche_Stump.sh" && sudo chmod 755 "$ports/LaBuche_Stump.sh" && ok "$ports/LaBuche_Stump.sh"
done

# ── check ────────────────────────────────────────────────────────────────────
step "Check"
for _ in $(seq 1 20); do
  NODE="$(python3 - <<'PY' 2>/dev/null
import json, urllib.request
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for port in (80, 8080):
    try:
        d = json.load(op.open("http://127.0.0.1:%d/node.json" % port, timeout=2))
        c = json.load(op.open("http://127.0.0.1:%d/chain.json" % port, timeout=2))
        up = (c.get("uplink") or {})
        chain = ("chain %s, %s" % (c.get("chain"), c.get("role")) +
                 (", parent %s heard %ss ago" % (up.get("parent"), up.get("parent_heard_s")) if up else "")) if c.get("enabled") else "no chain"
        print("%s %s on :%d, %s" % (d.get("name"), d.get("release"), port, chain)); break
    except Exception:
        pass
PY
)"
  [ -n "$NODE" ] && break; sleep 2
done
if [ -n "$NODE" ]; then ok "Stump up: $NODE"; else warn "the Stump isn't answering yet: see $STUMP_DIR/stump.log"; fi
echo
echo "Done. Open it from EmulationStation: Ports -> LaBuche_Stump. SELECT+START goes back."
echo "The Stump runs in the background from boot, like any computer Stump:"
echo "  log: $STUMP_DIR/stump.log    stop: $STUMP_DIR/stop-stump.sh    start: $STUMP_DIR/start-stump.sh"
echo "  update: bash $HERE/install.sh   (pulls SandBox_Stump_On, runs provisioner.py --pc again)"
echo "  chain check: cd $SANDBOX && python3 provisioner.py --check-chain"
