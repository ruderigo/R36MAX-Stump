#!/bin/bash
# Makes a release of the handheld from this checkout:
#
#   bash handheld/package.sh                 # test, then package
#   bash handheld/package.sh --no-tests      # package only (CI has tested already)
#
# Writes, in dist/:
#   R36MAX-Stump-handheld-<VERSION>.tar.gz   R36MAX-Stump-<VERSION>/handheld/...
#   SHA256SUMS
#   RELEASE_NOTES.md                         this version's section of CHANGELOG.md
#
# On the handheld:  tar xzf R36MAX-Stump-handheld-<VERSION>.tar.gz
#                   bash R36MAX-Stump-<VERSION>/handheld/install.sh
# (install.sh doesn't try to git-pull a copy that isn't a git checkout.)
#
# In CI on a tag, the tag must be v<VERSION>: GITHUB_REF_NAME is checked.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"            # handheld/
REPO="$(dirname "$HERE")"
VERSION="$(tr -d '[:space:]' < "$HERE/VERSION")"
NAME="R36MAX-Stump-$VERSION"
DIST="$REPO/dist"
TARBALL="R36MAX-Stump-handheld-$VERSION.tar.gz"

die() { echo "package.sh: $*" >&2; exit 1; }
[ -n "$VERSION" ] || die "handheld/VERSION is empty"
if [ "${GITHUB_REF_TYPE:-}" = "tag" ] && [ "${GITHUB_REF_NAME:-}" != "v$VERSION" ]; then
  die "tag ${GITHUB_REF_NAME:-?} doesn't match handheld/VERSION (v$VERSION)"
fi
if [ "${1:-}" != "--no-tests" ]; then
  bash "$HERE/tests/run_tests.sh" || die "the tests failed: no package"
fi

# The files git knows (no build output, no caches); a plain copy if this isn't a checkout.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME/handheld"
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  [ -z "$(git -C "$REPO" status --porcelain -- handheld)" ] \
    || echo "package.sh: note: handheld/ has uncommitted changes; they're packaged as they are" >&2
  (cd "$REPO" && git ls-files -co --exclude-standard handheld) | while IFS= read -r f; do
    [ -f "$REPO/$f" ] || continue
    mkdir -p "$STAGE/$NAME/$(dirname "$f")"
    cp -p "$REPO/$f" "$STAGE/$NAME/$f"
  done
else
  cp -rp "$HERE/." "$STAGE/$NAME/handheld/"
fi
find "$STAGE" \( -name __pycache__ -o -name '*.pyc' \) -prune -exec rm -rf {} +
for f in install.sh admin_password.py LaBuche_Stump.sh stump_r36max_engine.c cockpit_feed.py cockpit_font.bin VERSION; do
  [ -f "$STAGE/$NAME/handheld/$f" ] || die "$f is missing from the package"
done
cp -p "$REPO/LICENSE" "$STAGE/$NAME/" 2>/dev/null || true

# This version's notes: from "## v<VERSION>" to the next "## ".
mkdir -p "$DIST"
awk -v h="## v$VERSION" '$0 == h || index($0, h " ") == 1 {on=1; next} on && /^## / {exit} on' \
    "$HERE/CHANGELOG.md" > "$DIST/RELEASE_NOTES.md"
[ -s "$DIST/RELEASE_NOTES.md" ] || die "CHANGELOG.md has no '## v$VERSION' section"
cat >> "$DIST/RELEASE_NOTES.md" <<EOF

---

**Install or update on the handheld** (as \`ark\`, online):

\`\`\`sh
tar xzf $TARBALL
bash $NAME/handheld/install.sh
\`\`\`

Check the download first with \`sha256sum -c SHA256SUMS\`.
EOF

# A reproducible tarball: fixed owner, order and times (the commit's, else now).
STAMP="$(git -C "$REPO" log -1 --format=%ct 2>/dev/null || date +%s)"
rm -f "$DIST/$TARBALL" "$DIST/SHA256SUMS"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$STAMP" \
    -C "$STAGE" -cf - "$NAME" | gzip -n -9 > "$DIST/$TARBALL"
(cd "$DIST" && sha256sum "$TARBALL" > SHA256SUMS)

echo "dist/$TARBALL ($(du -k "$DIST/$TARBALL" | cut -f1) KB, $(tar tzf "$DIST/$TARBALL" | grep -vc '/$') files)"
cat "$DIST/SHA256SUMS"
