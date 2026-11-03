#!/bin/bash
# The handheld's tests, all of them that need no handheld:
#
#   bash handheld/tests/run_tests.sh                     # everything but the Stump test
#   bash handheld/tests/run_tests.sh ../SandBox_Stump_On # ... and the feed against a real Stump
#
# Needs: gcc, libasound2-dev, python3; shellcheck if installed. The Stump test
# also needs SandBox_Stump_On's packages (python3 -m pip install cryptography pyserial).
# CI runs this (.github/workflows/handheld.yml), and package.sh runs it before packaging.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"          # handheld/
SANDBOX="${1:-}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=()
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run() {  # run NAME COMMAND...: one test, kept going on failure
  local name="$1"; shift
  if "$@"; then echo "ok: $name"; else echo "FAILED: $name"; FAILED+=("$name"); fi
}

step "Versions agree (handheld/VERSION)"
check_versions() {
  local v; v="$(tr -d '[:space:]' < "$HERE/VERSION")"
  [ -n "$v" ] || { echo "VERSION is empty"; return 1; }
  local bad=0
  grep -q "STUMP_ENGINE_VERSION \"v$v\"" "$HERE/stump_r36max_engine.c" || { echo "engine: STUMP_ENGINE_VERSION isn't v$v"; bad=1; }
  grep -q "\"v$v\");" "$HERE/stump_r36max_engine.c" || { echo "engine: ver_str isn't v$v"; bad=1; }
  grep -q "(v$v)" "$HERE/install.sh" || { echo "install.sh header isn't v$v"; bad=1; }
  grep -q "(v$v)" "$HERE/LaBuche_Stump.sh" || { echo "LaBuche_Stump.sh header isn't v$v"; bad=1; }
  grep -q "cockpit v$v," "$HERE/LaBuche_Stump.sh" || { echo "LaBuche_Stump.sh log line isn't v$v"; bad=1; }
  grep -q "^## v$v" "$HERE/CHANGELOG.md" || { echo "CHANGELOG.md has no '## v$v' section"; bad=1; }
  [ "$(python3 -I -c "import sys; sys.path.insert(0, '$HERE'); import cockpit_feed as F; print(F.FEED_VERSION)")" = "$v" ] \
    || { echo "cockpit_feed.FEED_VERSION isn't $v"; bad=1; }
  [ "$bad" = 0 ] && echo "all at $v"
  return "$bad"
}
run "versions" check_versions

step "Shell scripts"
lint_shell() {
  local f bad=0
  for f in install.sh LaBuche_Stump.sh package.sh tests/run_tests.sh; do
    bash -n "$HERE/$f" || bad=1
  done
  if command -v shellcheck >/dev/null; then
    shellcheck -S warning "$HERE/install.sh" "$HERE/LaBuche_Stump.sh" "$HERE/package.sh" "$HERE/tests/run_tests.sh" || bad=1
  else
    echo "(shellcheck not installed: syntax only)"
  fi
  return "$bad"
}
run "shell" lint_shell

step "install.sh's options (stops before touching anything)"
install_options() {
  local out bad=0
  out="$(STUMP_INSTALL_PULLED=1 bash "$HERE/install.sh" --what 2>&1)"
  echo "$out" | grep -q "unknown option: --what" || { echo "an unknown option isn't refused: $out"; bad=1; }
  out="$(STUMP_INSTALL_PULLED=1 bash "$HERE/install.sh" --answers /nonexistent/answers.json 2>&1)"
  echo "$out" | grep -q "can't read the answers file /nonexistent/answers.json" || { echo "a missing answers file: $out"; bad=1; }
  out="$(STUMP_INSTALL_PULLED=1 bash "$HERE/install.sh" --answers 2>&1)"
  echo "$out" | grep -q "can't read the answers file" || { echo "--answers with no file: $out"; bad=1; }
  [ "$bad" = 0 ] && echo "refused, nothing done"
  return "$bad"
}
run "install options" install_options

step "The feed (unit tests)"
run "feed" python3 -I "$HERE/test_cockpit_feed.py"

step "The Wi-Fi cards (limbs.py, with a fake /sys and NetworkManager)"
run "limbs" python3 -I -W error::ResourceWarning "$HERE/test_limbs.py"

step "The font file"
check_font() {
  python3 -I - "$HERE/cockpit_font.bin" <<'PY'
import struct, sys
buf = open(sys.argv[1], "rb").read()
assert buf[:8] == b"CKFONT1\0", "not a cockpit font"
n = struct.unpack_from("<I", buf, 8)[0]
assert n == 5, "%d fonts, the engine wants 5" % n
pos, sizes = 12, []
for _ in range(n):
    px, adv, asc, desc, line, bold, ng, dlen = struct.unpack_from("<HHhhHHII", buf, pos)
    pos += 20
    cps = set(struct.unpack_from("<I", buf, pos + 16 * k)[0] for k in range(ng))
    need = set(range(32, 127)) | {0xE9, 0xE0, 0xE7, 0x2713, 0x2192, 0x21E7, 0x232B, 0x2022}
    assert need <= cps, "%d px lacks %s" % (px, sorted(need - cps)[:8])
    pos += 16 * ng + dlen
    sizes.append(px)
assert pos == len(buf), "trailing bytes"
assert sizes == [10, 16, 20, 24, 30], sizes
print("5 fonts, %s px, ASCII + accents + symbols" % sizes)
PY
}
check_engine_chars() {   # every character the engine writes on screen is in the font
  python3 -I - "$HERE/cockpit_font.bin" "$HERE/stump_r36max_engine.c" <<'PY'
import re, struct, sys
buf = open(sys.argv[1], "rb").read()
n, pos, have = struct.unpack_from("<I", buf, 8)[0], 12, None
for _ in range(n):
    ng, dlen = struct.unpack_from("<II", buf, pos + 12)
    pos += 20
    cps = set(struct.unpack_from("<I", buf, pos + 16 * k)[0] for k in range(ng))
    pos += 16 * ng + dlen
    have = cps if have is None else have & cps
src = open(sys.argv[2], encoding="utf-8").read()
missing = {}
for m in re.finditer(r'"((?:[^"\\\n]|\\.)*)"', src):
    for c in m.group(1):
        if ord(c) > 126 and ord(c) not in have:
            missing.setdefault(c, src[:m.start()].count("\n") + 1)
assert not missing, "not in the font: %s" % ", ".join("%s (line %d)" % kv for kv in missing.items())
print("every character the engine draws is in the font")
PY
}
run "font" check_font
run "font has the engine's characters" check_engine_chars

step "The engine: strict build and smoke test"
build_engine() {
  gcc -O2 -Wall -Wextra -Werror -Wno-unused-parameter -Wno-format-truncation -Wno-sign-compare \
      "$HERE/stump_r36max_engine.c" -o "$WORK/stump_r36max_engine" -lasound -lpthread -ldl -lm \
    && cp "$HERE/cockpit_font.bin" "$WORK/" \
    && (cd "$WORK" && timeout 30 ./stump_r36max_engine --smoke 2>&1 | tee "$WORK/smoke.log" | tail -2) \
    && grep -q "FireFly font loaded" "$WORK/smoke.log" && grep -q "rendered 10 frames cleanly" "$WORK/smoke.log"
}
run "engine" build_engine

step "The keyboard (the R36MAX's real button codes)"
keyboard() {
  gcc -O2 -Wall -Wno-unused-function -Wno-format-truncation -Dmain=engine_main \
      -o "$WORK/test_keyboard" "$HERE/tests/test_keyboard.c" -lasound -lpthread -ldl -lm \
    && STUMP_COCKPIT_FONT="$HERE/cockpit_font.bin" "$WORK/test_keyboard" | grep -v '^\[Stump'
  return "${PIPESTATUS[0]}"
}
run "keyboard" keyboard

step "The web app's copy of these files"
run "app copy" python3 -I "$HERE/sync_app.py" --check

if [ -n "$SANDBOX" ]; then
  step "The feed against a real Stump ($SANDBOX)"
  run "with a Stump" python3 "$HERE/tests/test_with_stump.py" "$SANDBOX"
else
  printf '\n(the Stump test skipped: give the path to SandBox_Stump_On to run it)\n'
fi

echo
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "FAILED: ${FAILED[*]}"
  exit 1
fi
echo "all passed"
