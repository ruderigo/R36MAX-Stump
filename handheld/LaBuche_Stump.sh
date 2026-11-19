#!/bin/bash
# =============================================================================
# LaBuche_Stump.sh — the R36MAX Stump cockpit (v2.6.1-b.87)
# EmulationStation Ports launcher: /roms/ports/LaBuche_Stump.sh
#
# The Stump itself is a stock Stump on a computer (SandBox_Stump_On,
# pc/stump_pc.py, set up by provisioner.py --pc). Since v2.5.0 it runs only
# while this Port is open, like a ROM: this launcher starts it, opens the
# 720x720 cockpit on it, and SELECT+START stops both and goes back to
# EmulationStation. Nothing of it runs in the background, so it never runs
# beside FireFly (one Port at a time).
#
# Installed by handheld/install.sh from github.com/ruderigo/R36MAX-Stump.
# =============================================================================

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export PYGAME_HIDE_SUPPORT_PROMPT=1 PYTHONUNBUFFERED=1 SDL_NOMOUSE=1

# Who the Stump belongs to (ES normally runs Ports as ark; also works as root).
USER_NAME="${STUMP_USER:-ark}"
[ "$(id -u)" -ne 0 ] && USER_NAME="$(id -un)"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"; USER_HOME="${USER_HOME:-/home/$USER_NAME}"
USER_UID="$(id -u "$USER_NAME")"
as_user() { if [ "$(id -u)" -eq 0 ]; then sudo -u "$USER_NAME" XDG_RUNTIME_DIR="/run/user/$USER_UID" "$@"; else XDG_RUNTIME_DIR="/run/user/$USER_UID" "$@"; fi; }
# sudo without a password prompt (install.sh allows the few commands used here).
# Never pipe data into "sudo -S": it would read that data as the password.
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo -n"

COCKPIT_DIR="$USER_HOME/stump_r36max"            # engine, display, feed (ext4: no exFAT mmap issues)
APP_DIR="/roms/ports/stump_r36max"               # on the TF card: drop/, tf_backup/, the log
STUMP_DIR="$USER_HOME/Stump"
LOG="$APP_DIR/cockpit.log"
mkdir -p "$APP_DIR/drop" "$APP_DIR/tf_backup" 2>/dev/null
echo "=== R36MAX Stump cockpit v2.6.1-b.87, $(date) ===" > "$LOG"
# For diagnosing a black screen: who we are, and whether we can open the display.
{ echo "user: $(id)"; ls -l /dev/dri/ /dev/fb0 /dev/tty1 2>&1; } >> "$LOG"

# The display and gamepad, for the cockpit (as the old launcher did).
$SUDO chmod 666 /dev/tty1 /dev/fb0 /dev/dri/card* /dev/dri/render* /dev/input/event* 2>/dev/null
# Hide VT1's blinking cursor. "sudo -n tee", so the data goes to tee (v1.8.8
# piped it into "sudo -S", which took it for the password).
echo 0 | $SUDO tee /sys/class/graphics/fbcon/cursor_blink >/dev/null 2>&1
printf '\033[?25l' | $SUDO tee /dev/tty1 >/dev/null 2>&1

# Leftovers from a cockpit that didn't exit cleanly (never the Stump itself).
# Anchored on the python binary, so these never match this script's own command line.
DISP_PAT='^[^ ]*python[^ ]* .*stump_pygame_display\.py'
FEED_PAT='^[^ ]*python[^ ]* .*cockpit_feed\.py'
pkill -TERM -f "$DISP_PAT" 2>/dev/null
pkill -TERM -f "$FEED_PAT" 2>/dev/null
pkill -TERM -x stump_r36max_engine 2>/dev/null
sleep 0.2
rm -f /dev/shm/stump_user_quit /dev/shm/stump_live.txt /dev/shm/stump_cmd.txt /dev/shm/stump_fb.rgba 2>/dev/null

# The Stump: started for this session (and any copy left from before, or a
# start-at-login of v2.4 and earlier, stopped first so there's exactly one).
STUMP_PAT="^[^ ]*python[^ ]* .*$STUMP_DIR/stump_pc\.py"
stop_stump() {
  as_user sh "$STUMP_DIR/stop-stump.sh" >> "$LOG" 2>&1          # /admin/poweroff: the radio off first
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "$STUMP_PAT" >/dev/null || break; sleep 0.5; done
  pkill -TERM -f "$STUMP_PAT" 2>/dev/null
}
if [ ! -f "$STUMP_DIR/stump_pc.py" ]; then
  echo "No Stump in $STUMP_DIR: run handheld/install.sh first." >> "$LOG"
else
  as_user systemctl --user stop stump >> "$LOG" 2>&1              # v2.4's start-at-login, if still there
  pgrep -f "$STUMP_PAT" >/dev/null && stop_stump
  echo "Starting the Stump for this session" >> "$LOG"
  as_user sh -c 'cd "$1" && PYTHONUNBUFFERED=1 nohup "$1/venv/bin/python" "$1/stump_pc.py" --service >> "$1/stump.log" 2>&1 &' sh "$STUMP_DIR"
fi

# The feed: the cockpit's client of the Stump's HTTP API (cores 2-3, away from the display).
PIN=""; command -v taskset >/dev/null 2>&1 && PIN="taskset -c 2,3"
as_user env STUMP_DIR="$STUMP_DIR" STUMP_R36MAX_DIR="$APP_DIR" $PIN python3 "$COCKPIT_DIR/cockpit_feed.py" >> "$LOG" 2>&1 &

# The display. The engine draws to the screen itself through the system's SDL2
# (the one EmulationStation uses, with KMSDRM), as before v1.8; it reads the
# gamepad itself, and SELECT+START ends it. The pygame presenter (v1.8.x) is
# kept only on request, STUMP_DISPLAY=pygame: on dArkOS the FireFly venv's
# pygame brings its own SDL, which has no KMSDRM there and drew "offscreen",
# into memory, so the screen stayed black.
ENGINE="$COCKPIT_DIR/stump_r36max_engine"
for attempt in 1 2 3; do
  if [ "${STUMP_DISPLAY:-engine}" = "pygame" ]; then
    for py in "$USER_HOME/firefly/venv/bin/python" python3; do
      command -v "$py" >/dev/null 2>&1 && "$py" -c "import pygame" >/dev/null 2>&1 && break
    done
    "$py" -X faulthandler "$COCKPIT_DIR/stump_pygame_display.py" "$ENGINE" >> "$LOG" 2>&1
  else
    SDL_VIDEODRIVER=kmsdrm "$ENGINE" >> "$LOG" 2>&1
  fi
  [ -f /dev/shm/stump_user_quit ] && break        # SELECT+START: back to EmulationStation
  echo "display exited without SELECT+START (attempt $attempt); restarting it" >> "$LOG"
  sleep 1
done

# Back to EmulationStation: the cockpit, then the Stump itself, stopped.
pkill -TERM -f "$FEED_PAT" 2>/dev/null
pkill -TERM -x stump_r36max_engine 2>/dev/null
[ -f "$STUMP_DIR/stump_pc.py" ] && stop_stump
rm -f /dev/shm/stump_user_quit /dev/shm/stump_live.txt /dev/shm/stump_cmd.txt /dev/shm/stump_fb.rgba 2>/dev/null
sync
printf '\033c' | $SUDO tee /dev/tty1 >/dev/null 2>&1
echo "=== cockpit closed $(date); the Stump stopped ===" >> "$LOG"
