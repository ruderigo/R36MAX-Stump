#!/usr/bin/env python3
"""Makes cockpit_font.bin: FireFly's font (DejaVu Sans Mono, as in FireFly's
firefly/ui/theme.py) pre-rendered for the cockpit engine, which has no
font library. Anti-aliased (8-bit coverage), with Latin-1, the extra
letters French and Spanish use, and the symbols Stump sends (✓ ✗ ✎ → ⊖) and
FireFly's keyboard shows (⇧ ⌫).

    python3 handheld/gen_font.py          # needs Pillow and fonts-dejavu-core

The file is committed, so the handheld needs neither. DejaVu fonts: Bitstream
Vera licence (free to use, embed and redistribute); notice in FONT_LICENSE.

Format, little-endian:
    "CKFONT1\\0", u32 font count, then per font:
      u16 px, u16 advance*64, i16 ascent, i16 descent, u16 line height,
      u16 bold, u32 glyph count, u32 data length,
      glyphs: u32 codepoint, i16 x offset, i16 y offset (top of the bitmap
              from the baseline, negative = above), u16 w, u16 h, u32 offset
      data: w*h coverage bytes per glyph, row by row
"""
import os
import struct
from PIL import ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
DEJAVU = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu", "/usr/share/fonts/TTF"]

# (px, bold): 10/20/30 match the engine's 6/12/18-px text cells (DejaVu Sans
# Mono is 0.602 em wide); 16 and 24 are FireFly's own small and body sizes
# at 720 px (theme.py: base = screen_h // 30).
FONTS = [(10, False), (16, False), (20, False), (24, False), (30, True)]

EXTRA = ("œŒÿŸ€£‘’“”–—…·•✓✗✎→←↑↓⊖⇧⌫▏●○◀▶›‹«»¿¡°±×÷♥☺★♪⧗⊘≈≠≤≥⏎␣")
CHARS = [chr(c) for c in range(32, 127)] + [chr(c) for c in range(160, 256)] + list(EXTRA)


def find(name):
    for d in DEJAVU:
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    raise SystemExit("%s not found: sudo apt install fonts-dejavu-core" % name)


def has_glyph(font, ch):
    """Pillow draws a missing glyph as the font's .notdef box: compare."""
    a = font.getmask2(ch, mode="L", anchor="ls")
    b = font.getmask2("", mode="L", anchor="ls")
    return not (a[0].size == b[0].size and bytes(a[0]) == bytes(b[0]))


def build():
    out = [b"CKFONT1\0", struct.pack("<I", len(FONTS))]
    report = []
    for px, bold in FONTS:
        mono = ImageFont.truetype(find("DejaVuSansMono-Bold.ttf" if bold else "DejaVuSansMono.ttf"), px)
        sans = ImageFont.truetype(find("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"), px)
        ascent, descent = mono.getmetrics()
        advance = mono.getlength("M")
        glyphs, data, missing = [], bytearray(), []
        for ch in CHARS:
            f = mono if has_glyph(mono, ch) else (sans if has_glyph(sans, ch) else None)
            if f is None:
                missing.append(ch)
                continue
            mask, (ox, oy) = f.getmask2(ch, mode="L", anchor="ls")
            w, h = mask.size
            glyphs.append(struct.pack("<IhhHHI", ord(ch), ox, oy, w, h, len(data)))
            data += bytes(mask)
        out.append(struct.pack("<HHhhHHII", px, int(round(advance * 64)), ascent, descent,
                               ascent + descent, int(bold), len(glyphs), len(data)))
        out += glyphs
        out.append(bytes(data))
        report.append("%2d px%s: %d glyphs, advance %.2f, %d KB%s" % (
            px, " bold" if bold else "", len(glyphs), advance, len(data) // 1024,
            (", missing " + "".join(missing)) if missing else ""))
    path = os.path.join(HERE, "cockpit_font.bin")
    with open(path, "wb") as f:
        f.write(b"".join(out))
    print("\n".join(report))
    print("wrote %s (%d KB)" % (path, os.path.getsize(path) // 1024))


if __name__ == "__main__":
    build()
