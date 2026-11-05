/*
 * stump_r36max_engine.c — Native 720x720 handheld cockpit for the R36MAX
 * (RK3326 / dArkOS), v2.4.0-r36max.
 *
 * The Stump on the handheld is a stock Stump on a computer (SandBox_Stump_On
 * pc/stump_pc.py, set up by provisioner.py --pc). This cockpit is only its
 * screen and gamepad: it reads /dev/shm/stump_live.txt and sends command
 * lines to cockpit_feed.py (UDP 127.0.0.1:42421), which talks to the Stump
 * over its public HTTP API. Nothing here reads or writes the Stump's own
 * files, and nothing here talks to the network.
 *   - Chat (#main, #lora-mesh, #wifi-mesh), Billboard, Files, Network, Setup
 *   - ISO/IEC 18004 QR code (Version 2-L) for the Stump's address
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
#define IPC_UDP_PORT    42421

#define LIVE_STATE_FILE "/dev/shm/stump_live.txt"
#ifndef CMD_QUEUE_FILE                   /* a test can point it elsewhere */
#define CMD_QUEUE_FILE  "/dev/shm/stump_cmd.txt"
#endif
#define SHM_FB_FILE     "/dev/shm/stump_fb.rgba"

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


/* True 5x7 Pixel-Matrix Bitmap Font (35-bit row-major integer per glyph) */
#define G57(a,b,c,d,e,f,g) ( \
    ((uint64_t)(a) << 30) | ((uint64_t)(b) << 25) | ((uint64_t)(c) << 20) | \
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

static void draw_text_5x7(uint32_t *fb, int x, int y, const char *s, uint32_t color, int scale, int max_chars) {
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

/* ---- FireFly's font: DejaVu Sans Mono, pre-rendered by gen_font.py ----
 * cockpit_font.bin sits next to the engine (or STUMP_COCKPIT_FONT). Real
 * lower and upper case, accents, and the symbols Stump sends (✓ ✗ → ⊖), all
 * anti-aliased. Without the file, the old 5x7 capitals font is used. */
typedef struct { uint32_t cp; int16_t xo, yo; uint16_t w, h; uint32_t off; } CkGlyph;
typedef struct {
    int px, adv64, ascent, descent, line, bold;
    uint32_t n;
    CkGlyph *g;
    const uint8_t *data;
    int16_t idx[256];            /* codepoint < 256 -> glyph index (-1: none) */
} CkFont;
enum { F10 = 0, F16, F20, F24, F30B, F_COUNT };
static CkFont g_fonts[F_COUNT];
static bool g_fonts_ok = false;

static bool load_fonts(void) {
    char path[512] = "";
    const char *env = getenv("STUMP_COCKPIT_FONT");
    if (env && env[0]) {
        snprintf(path, sizeof(path), "%s", env);
    } else {
        ssize_t n = readlink("/proc/self/exe", path, sizeof(path) - 32);
        if (n <= 0) return false;
        path[n] = '\0';
        char *slash = strrchr(path, '/');
        if (!slash) return false;
        strcpy(slash + 1, "cockpit_font.bin");
    }
    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "[Stump-R36MAX] no %s: the 5x7 font\n", path); return false; }
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *buf = (len > 16) ? malloc((size_t)len) : NULL;
    if (!buf || fread(buf, 1, (size_t)len, f) != (size_t)len) { fclose(f); free(buf); return false; }
    fclose(f);
    if (memcmp(buf, "CKFONT1\0", 8) != 0) { free(buf); return false; }
    uint32_t nf;
    memcpy(&nf, buf + 8, 4);
    size_t pos = 12;
    for (uint32_t i = 0; i < nf && i < F_COUNT; i++) {
        if (pos + 20 > (size_t)len) { free(buf); return false; }
        uint16_t px, adv64, line, bold; int16_t asc, desc; uint32_t ng, dlen;
        memcpy(&px, buf + pos, 2); memcpy(&adv64, buf + pos + 2, 2);
        memcpy(&asc, buf + pos + 4, 2); memcpy(&desc, buf + pos + 6, 2);
        memcpy(&line, buf + pos + 8, 2); memcpy(&bold, buf + pos + 10, 2);
        memcpy(&ng, buf + pos + 12, 4); memcpy(&dlen, buf + pos + 16, 4);
        pos += 20;
        if (pos + (size_t)ng * 16 + dlen > (size_t)len) { free(buf); return false; }
        CkFont *ft = &g_fonts[i];
        ft->px = px; ft->adv64 = adv64; ft->ascent = asc; ft->descent = desc;
        ft->line = line; ft->bold = bold; ft->n = ng;
        ft->g = calloc(ng, sizeof(CkGlyph));
        if (!ft->g) { free(buf); return false; }
        memset(ft->idx, 0xFF, sizeof(ft->idx));
        for (uint32_t k = 0; k < ng; k++) {
            const uint8_t *r = buf + pos + k * 16;
            memcpy(&ft->g[k].cp, r, 4); memcpy(&ft->g[k].xo, r + 4, 2); memcpy(&ft->g[k].yo, r + 6, 2);
            memcpy(&ft->g[k].w, r + 8, 2); memcpy(&ft->g[k].h, r + 10, 2); memcpy(&ft->g[k].off, r + 12, 4);
            if (ft->g[k].cp < 256) ft->idx[ft->g[k].cp] = (int16_t)k;
        }
        pos += (size_t)ng * 16;
        ft->data = buf + pos;            /* the buffer stays for the program's life */
        pos += dlen;
    }
    g_fonts_ok = (nf >= F_COUNT);
    fprintf(stderr, "[Stump-R36MAX] FireFly font loaded: %s\n", path);
    return g_fonts_ok;
}

/* The next codepoint of a UTF-8 string (advances *s); 0 at the end. A broken
 * sequence (a field cut mid-character) gives U+FFFD and moves on. */
static uint32_t utf8_next(const char **ps) {
    const unsigned char *s = (const unsigned char *)*ps;
    if (!*s) return 0;
    uint32_t c = *s++;
    int extra = 0;
    if (c >= 0xF0) { c &= 0x07; extra = 3; }
    else if (c >= 0xE0) { c &= 0x0F; extra = 2; }
    else if (c >= 0xC0) { c &= 0x1F; extra = 1; }
    else if (c >= 0x80) { *ps = (const char *)s; return 0xFFFD; }
    for (int i = 0; i < extra; i++) {
        if ((*s & 0xC0) != 0x80) { *ps = (const char *)s; return 0xFFFD; }
        c = (c << 6) | (*s++ & 0x3F);
    }
    *ps = (const char *)s;
    return c;
}

static const CkGlyph *font_glyph(const CkFont *f, uint32_t cp) {
    if (cp < 256) {
        int16_t k = f->idx[cp];
        return (k >= 0) ? &f->g[k] : NULL;
    }
    for (uint32_t k = 0; k < f->n; k++) if (f->g[k].cp == cp) return &f->g[k];
    return NULL;
}

static inline uint32_t blend_px(uint32_t bg, uint32_t fg, unsigned a) {
    unsigned ia = 255 - a;
    unsigned r = (((fg >> 16) & 0xFF) * a + ((bg >> 16) & 0xFF) * ia) / 255;
    unsigned g = (((fg >> 8) & 0xFF) * a + ((bg >> 8) & 0xFF) * ia) / 255;
    unsigned b = ((fg & 0xFF) * a + (bg & 0xFF) * ia) / 255;
    return 0xFF000000u | (r << 16) | (g << 8) | b;
}

static void font_draw_glyph(uint32_t *fb, const CkFont *f, int x, int baseline, uint32_t cp, uint32_t color) {
    const CkGlyph *g = font_glyph(f, cp);
    if (!g) g = font_glyph(f, '?');
    if (!g) return;
    const uint8_t *src = f->data + g->off;
    for (int r = 0; r < g->h; r++) {
        int py = baseline + g->yo + r;
        if (py < 0 || py >= PANEL_H) continue;
        for (int c = 0; c < g->w; c++) {
            int pxx = x + g->xo + c;
            if (pxx < 0 || pxx >= PANEL_W) continue;
            unsigned a = src[r * g->w + c];
            if (!a) continue;
            uint32_t *d = &fb[py * PANEL_W + pxx];
            *d = (a == 255) ? color : blend_px(*d, color, a);
        }
    }
}

/* Text in font fid with its top at y_top; at most max_px wide (0: to the
 * screen's edge). Returns the width drawn. */
static int font_text(uint32_t *fb, int fid, int x, int y_top, const char *s, uint32_t color, int max_px) {
    const CkFont *f = &g_fonts[fid];
    int base = y_top + f->ascent;
    int x0 = x, acc = 0, limit = max_px > 0 ? x + max_px : PANEL_W - 2;
    uint32_t cp;
    while ((cp = utf8_next(&s)) != 0) {
        int nx = x0 + (acc + f->adv64) / 64;
        if (nx > limit) break;
        font_draw_glyph(fb, f, x0 + acc / 64, base, cp, color);
        acc += f->adv64;
    }
    return acc / 64;
}

static int font_width(int fid, const char *s) {
    if (!g_fonts_ok) return (int)strlen(s) * (fid == F30B ? 18 : fid == F10 ? 6 : 12);
    int n = 0;
    while (utf8_next(&s)) n++;
    return n * g_fonts[fid].adv64 / 64;
}

/* The engine's text call: same cells as the 5x7 font (6 px per character
 * per scale step: DejaVu Sans Mono at 10*scale px is 6.02*scale wide), the
 * baseline where the 5x7 glyphs ended, max_chars counted in characters. */
static void draw_text_s(uint32_t *fb, int x, int y, const char *s, uint32_t color, int scale, int max_chars) {
    if (!g_fonts_ok) { draw_text_5x7(fb, x, y, s, color, scale, max_chars); return; }
    int fid = scale >= 3 ? F30B : (scale == 1 ? F10 : F20);
    const CkFont *f = &g_fonts[fid];
    int base = y + 7 * scale, count = 0, acc = 0;
    uint32_t cp;
    while ((cp = utf8_next(&s)) != 0 && (max_chars <= 0 || count < max_chars)) {
        if (x + (acc + f->adv64) / 64 > PANEL_W - 4) break;
        font_draw_glyph(fb, f, x + acc / 64, base, cp, color);
        acc += f->adv64;
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
                        char *nl = strchr(mac_buf, '\n');
                        if (nl) *nl = '\0';
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
                            char *nl = strchr(line + 7, '\n');
                            if (nl) *nl = '\0';
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
            if (!ifa->ifa_name || !ifa->ifa_addr || ifa->ifa_addr->sa_family != AF_INET) continue;
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
            if (strncmp(line, "N: Name=", 8) == 0 && strlen(line) > 9) {
                snprintf(cur_name, sizeof(cur_name), "%.63s", line + 9);
                char *q = strchr(cur_name, 34);
                if (q) *q = '\0';
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

#define STUMP_ENGINE_VERSION "v2.4.0-r36max"
#define STUMP_ENGINE_BUILD   "2026.06.24-dArkOS"
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

/* A Wi-Fi card on the handheld (a "limb"), from the feed's LIMB| lines. */
typedef struct {
    char key[18];        /* its permanent MAC: the card, whatever wlanN it is */
    char name[30];
    char driver[16];
    char job[6];         /* lan, ap, idle, off */
    bool ap_ok;
    int  bands;          /* 1 = 2.4 GHz, 2 = 5 GHz (added) */
    char band[3];        /* the AP's band: bg or a */
    bool remember;
    char iface[16];
    char info[48];
    int  clients;
} LimbItem;

typedef struct {
    volatile bool   running;
    volatile int    chime_freq;
    volatile int    chime_ms;
    int             theme_idx;
    int             tab_idx;       /* 0:CHAT, 1:BOARD, 2:FILES, 3:WIFI, 4:SETUP/CHAIN v1.8 */
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
    /* SandBox_Stump_On Chain State (UDP :4242 ChainHub / ChainUplink + UDP :4244 Discovery) */
    bool            chain_enabled;
    int             chain_role_idx; /* 0 = AUTO (LAN+AP), 1 = ROOT (FIRST STUMP), 2 = MEMBER (JOIN LAN) */
    bool            chain_has_secret;
    char            chain_secret[52];
    char            chain_id[20];
    int             chain_peers;
    char            chain_peer_ip[28];
    char            chain_status_msg[64];
    int             qr_mode;       /* 0 = HTTP Portal URL QR, 1 = WIFI Auto-Join QR */
    WifiSsidItem    wifi_list[6];
    int             wifi_count;
    int             wifi_cursor;   /* NETWORK rows: 0..limb_count-1 = the cards, limb_count = the tool */
    int             wifi_bar_mode; /* network tab tool: 0 = chain secret, 1 = find Stumps */
    char            wifi_status_msg[80];
    LimbItem        limbs[6];
    int             limb_count;
    char            limb_pick_key[18];  /* the card whose job is being chosen (←/→) */
    int             limb_pick;          /* that choice: 0 = not an AP, 1 = AP 2.4 GHz, 2 = AP 5 GHz; -1 none */
    int             rev_cursor;    /* SETUP rows: 0=Wi-Fi cards, 1=ES's Wi-Fi, 2=Chain, 3=Jobs, 4=Tool, 5=Log */
    int             debug_bar_mode;/* 0 = SCAN & LINK LAN CHAIN, 1 = EDIT CHAIN SECRET, 2 = EXPORT DIAG->TF, 3 = HEAL HTTP */
    int             debug_scroll;
    char            debug_logs[MAX_DBG_LINES][64];
    int             debug_log_count;
    bool            confirm_open;
    int             confirm_type;   /* 1 = notices, 2 = files, 3 = a Wi-Fi card's job */
    int             confirm_choice; /* 0 = NO / CANCEL, 1 = YES / ACCEPT */
    char            confirm_label[56];
    bool            osk_open;
    int             osk_target;     /* 0 = default tab input, 1 = Chain Secret editor in Panel 5 */
    int             osk_row;
    int             osk_col;
    bool            shift_held;
    char            input_buf[300];
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


/* 4x10 On-Screen Keyboard (OSK) Grid (Y to open/close, A to type, B to cancel/close) */
static const char *OSK_LABELS[4][10] = {
    { "1", "2", "3", "4", "5", "6", "7", "8", "9", "0" },
    { "Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P" },
    { "A", "S", "D", "F", "G", "H", "J", "K", "L", "-" },
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
    "Join this Stump's Wi-Fi hotspot; the page opens itself.",
    "Check #main or #wifi-mesh room for coordinates.",
    "Download offline guides and logs from /files.",
    "RT3070 20dBm AP + Reticulum LoRa relay active."
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
            dprintf(fd, "%s\n", cmd_line);
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
        g_st.input_buf[g_st.input_len] = '\0';
    }
}

static void input_backspace(void) {
    /* One character, not one byte: an accented letter is 2-3 bytes in UTF-8. */
    while (g_st.input_len > 0 && (g_st.input_buf[g_st.input_len - 1] & 0xC0) == 0x80) g_st.input_len--;
    if (g_st.input_len > 0) g_st.input_len--;
    g_st.input_buf[g_st.input_len] = '\0';
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

static void commit_chain_settings(const char *new_secret, int role_idx) {
    const char *rmode = (role_idx == 1) ? "root" : ((role_idx == 2) ? "member" : "auto");
    if (new_secret) {
        snprintf(g_st.chain_secret, sizeof(g_st.chain_secret), "%.50s", new_secret);
        g_st.chain_has_secret = (g_st.chain_secret[0] != '\0');
    }
    g_st.chain_role_idx = role_idx;
    char cmd[220];
    snprintf(cmd, sizeof(cmd), "CHAIN_SET|%s|%s|", g_st.chain_secret, rmode);
    send_bridge_cmd(cmd);
    set_ui_busy("Chain secret…", 2600);
    trigger_chime(840, 65);
}

static void open_chain_secret_osk(void) {
    g_st.osk_target = 1;
    g_st.osk_open = true;
    snprintf(g_st.input_buf, sizeof(g_st.input_buf), "%.50s", g_st.chain_secret);
    g_st.input_len = (int)strlen(g_st.input_buf);
    trigger_chime(740, 45);
}

/* ---- The Wi-Fi cards ("limbs") on the NETWORK tab ----
 * Each card has a job: EmulationStation's network (shown, chosen there),
 * the Stump's AP (any card that can), or nothing. ←/→ chooses, A asks and
 * applies (LIMB_JOB to the feed), Y remembers it for the next plug-in. */
static int limb_current(const LimbItem *l) {
    if (strcmp(l->job, "ap") == 0) return strcmp(l->band, "a") == 0 ? 2 : 1;
    return 0;
}

static int limb_shown(int i) {
    const LimbItem *l = &g_st.limbs[i];
    if (g_st.limb_pick >= 0 && strcmp(g_st.limb_pick_key, l->key) == 0) return g_st.limb_pick;
    return limb_current(l);
}

static const char *limb_label(const LimbItem *l, int choice) {
    if (choice == 1) return "AP 2.4 GHz";
    if (choice == 2) return "AP 5 GHz";
    if (strcmp(l->job, "lan") == 0) return "Local LAN (ES)";
    if (strcmp(l->job, "ap") == 0) return "Off · back to ES";
    if (strcmp(l->job, "off") == 0) return "Unavailable";
    return "Idle";
}

static void limb_cycle(int dir) {
    if (g_st.wifi_cursor >= g_st.limb_count) return;
    const LimbItem *l = &g_st.limbs[g_st.wifi_cursor];
    int n = !l->ap_ok ? 1 : ((l->bands & 2) ? 3 : 2);
    if (n == 1) {
        set_ui_busy("This card can't run an AP", 1600);
        trigger_chime(340, 40);
        return;
    }
    int c = (limb_shown(g_st.wifi_cursor) + n + dir) % n;
    snprintf(g_st.limb_pick_key, sizeof(g_st.limb_pick_key), "%s", l->key);
    g_st.limb_pick = c;
    trigger_chime(580, 25);
}

static void limb_apply(void) {
    const LimbItem *l = &g_st.limbs[g_st.wifi_cursor];
    int c = limb_shown(g_st.wifi_cursor);
    if (c == limb_current(l)) {
        set_ui_busy("←→ chooses a job for this card", 1800);
        trigger_chime(460, 30);
        return;
    }
    snprintf(g_st.limb_pick_key, sizeof(g_st.limb_pick_key), "%s", l->key);
    g_st.limb_pick = c;
    g_st.confirm_open = true;
    g_st.confirm_type = 3;
    g_st.confirm_choice = 1;
    if (c > 0 && strcmp(l->job, "lan") == 0)
        snprintf(g_st.confirm_label, sizeof(g_st.confirm_label), "AP on %.20s: leaves %.20s", l->name, l->info);
    else if (c > 0)
        snprintf(g_st.confirm_label, sizeof(g_st.confirm_label), "%s on %.30s", limb_label(l, c), l->name);
    else
        snprintf(g_st.confirm_label, sizeof(g_st.confirm_label), "AP off on %.30s", l->name);
    trigger_chime(660, 45);
}

static void limb_confirmed(void) {
    char cmd[64];
    if (g_st.limb_pick <= 0) snprintf(cmd, sizeof(cmd), "LIMB_JOB|%s|off", g_st.limb_pick_key);
    else snprintf(cmd, sizeof(cmd), "LIMB_JOB|%s|ap|%s", g_st.limb_pick_key, g_st.limb_pick == 2 ? "a" : "bg");
    send_bridge_cmd(cmd);
    set_ui_busy(g_st.limb_pick > 0 ? "Starting the AP…" : "Stopping the AP…", 6000);
    g_st.limb_pick = -1;
    trigger_chime(880, 85);
}

static void limb_remember(void) {
    LimbItem *l = &g_st.limbs[g_st.wifi_cursor];
    if (!l->ap_ok) {
        set_ui_busy("This card can't run an AP", 1600);
        return;
    }
    char cmd[48];
    l->remember = !l->remember;
    snprintf(cmd, sizeof(cmd), "LIMB_REMEMBER|%s|%d", l->key, l->remember ? 1 : 0);
    send_bridge_cmd(cmd);
    set_ui_busy(l->remember ? "Remembered: back as an AP when plugged in" : "Not remembered", 2200);
    trigger_chime(l->remember ? 740 : 520, 40);
}

/* A (or START, or Enter) on the NETWORK tab. */
static void network_tab_a(void) {
    if (g_st.wifi_cursor < g_st.limb_count) {
        limb_apply();
    } else if (g_st.wifi_bar_mode % 2 == 0) {
        open_chain_secret_osk();
    } else {
        send_bridge_cmd("CHAIN_SCAN");
        set_ui_busy("Looking for Stumps on this network…", 3000);
        trigger_chime(880, 65);
    }
}

static void network_tab_cancel(void) {
    g_st.limb_pick = -1;
    set_ui_busy("Nothing changed", 1000);
    trigger_chime(460, 35);
}

static void go_network_tab(void) {
    g_st.tab_idx = 3;
    g_st.wifi_cursor = 0;
    trigger_chime(620, 35);
}

static void send_typed_chat(void) {
    if (g_st.tab_idx == 4 || g_st.osk_target == 1) {
        commit_chain_settings(g_st.input_buf, g_st.chain_role_idx);
        g_st.osk_open = false;
        g_st.osk_target = 0;
        g_st.input_len = 0;
        g_st.input_buf[0] = '\0';
        return;
    }
    if (g_st.input_len <= 0) return;
    int r = g_st.room_idx;
    const char *rslug = ROOM_SLUGS[r];
    char cmd[400];
    snprintf(cmd, sizeof(cmd), "RRC|%s|%s", rslug, g_st.input_buf);
    send_bridge_cmd(cmd);
    broadcast_udp_beacon("CHAT", g_st.input_buf);
    push_chat_local(r, "r36max", g_st.input_buf, false);
    g_st.input_len = 0;
    g_st.input_buf[0] = '\0';
    set_ui_busy("Sending…", 1000);
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

static bool g_caps_lock = false;      /* a USB keyboard's Caps Lock (toggled in the key loop) */

static char translate_linux_key(uint16_t code, bool shift) {
    /* Letters: upper case with Shift or Caps Lock (not both), as a computer types. */
    static const char letters[] = "qwertyuiopasdfghjklzxcvbnm";
    static const uint16_t lcodes[] = { KEY_Q, KEY_W, KEY_E, KEY_R, KEY_T, KEY_Y, KEY_U, KEY_I, KEY_O, KEY_P,
                                       KEY_A, KEY_S, KEY_D, KEY_F, KEY_G, KEY_H, KEY_J, KEY_K, KEY_L,
                                       KEY_Z, KEY_X, KEY_C, KEY_V, KEY_B, KEY_N, KEY_M };
    for (int i = 0; i < 26; i++) {
        if (code == lcodes[i]) return (shift != g_caps_lock) ? (char)(letters[i] - 32) : letters[i];
    }
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
        case KEY_LEFTBRACE: return shift ? '{' : '[';
        case KEY_RIGHTBRACE: return shift ? '}' : ']';
        case KEY_BACKSLASH: return shift ? '|' : (char)92;
        case KEY_GRAVE: return shift ? '~' : '`';
        case KEY_KP0: return '0'; case KEY_KP1: return '1'; case KEY_KP2: return '2';
        case KEY_KP3: return '3'; case KEY_KP4: return '4'; case KEY_KP5: return '5';
        case KEY_KP6: return '6'; case KEY_KP7: return '7'; case KEY_KP8: return '8';
        case KEY_KP9: return '9'; case KEY_KPDOT: return '.'; case KEY_KPMINUS: return '-';
        case KEY_KPPLUS: return '+'; case KEY_KPASTERISK: return '*'; case KEY_KPSLASH: return '/';
        default: return 0;
    }
}

static void sync_disk_fallback(void) {
    /* v2.0: no live file means the feed (and so the Stump) isn't up yet:
     * say so, rather than reading the Stump's card behind its back. */
    snprintf(g_st.node_lxmf, sizeof(g_st.node_lxmf), "WAITING FOR THE STUMP");
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
    int l_count = 0;
    int d_count = 0;
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = '\0';
        if (strncmp(line, "META|", 5) == 0) {
            char *p1 = line + 5;
            char *p2 = strchr(p1, '|');
            if (p2) {
                *p2++ = '\0';
                snprintf(g_st.node_lxmf, sizeof(g_st.node_lxmf), "%.35s", p1);
                char *p3 = strchr(p2, '|');
                if (p3) {
                    *p3++ = '\0';
                    snprintf(g_st.rnode_status, sizeof(g_st.rnode_status), "%.23s", p3);
                }
                g_st.mesh_peers = atoi(p2);
            }
        } else if (strncmp(line, "VER|", 4) == 0) {
            /* VER|<version>|<build>|<http80>|<http8080>|<lan_ip>|<tf_backup_count> */
            char *p1 = line + 4;
            char *p2 = strchr(p1, '|');
            if (p2) {
                *p2++ = '\0';
                snprintf(g_st.ver_str, sizeof(g_st.ver_str), "%.27s", p1);
                char *p3 = strchr(p2, '|');
                if (p3) {
                    *p3++ = '\0';
                    snprintf(g_st.build_str, sizeof(g_st.build_str), "%.27s", p2);
                    char *p4 = strchr(p3, '|');
                    if (p4) {
                        *p4++ = '\0';
                        g_st.http80_ok = (atoi(p3) != 0);
                        char *p5 = strchr(p4, '|');
                        if (p5) {
                            *p5++ = '\0';
                            g_st.http8080_ok = (atoi(p4) != 0);
                            char *p6 = strchr(p5, '|');
                            if (p6) {
                                *p6++ = '\0';
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
                *p2++ = '\0';
                g_st.py_busy = (atoi(p1) != 0);
                if (g_st.py_busy && p2[0]) {
                    snprintf(g_st.busy_msg, sizeof(g_st.busy_msg), "%.62s", p2);
                }
            }
        } else if (strncmp(line, "AP|", 3) == 0) {
            char *p1 = line + 3;
            char *p2 = strchr(p1, '|');
            if (p2) {
                *p2++ = '\0';
                if (monotonic_ms() >= g_st.radio_lock_until_ms) {
                    g_st.ap_active = (atoi(p1) != 0);
                }
                char *p3 = strchr(p2, '|');
                if (p3) {
                    *p3++ = '\0';
                    snprintf(g_st.ap_if, sizeof(g_st.ap_if), "%.19s", p2);
                    char *p4 = strchr(p3, '|');
                    if (p4) {
                        *p4++ = '\0';
                        snprintf(g_st.ap_mac, sizeof(g_st.ap_mac), "%.23s", p3);
                        char *p5 = strchr(p4, '|');
                        if (p5) {
                            *p5++ = '\0';
                            snprintf(g_st.ap_driver, sizeof(g_st.ap_driver), "%.19s", p4);
                            char *p6 = strchr(p5, '|');
                            if (p6) {
                                *p6++ = '\0';
                                snprintf(g_st.ap_ssid, sizeof(g_st.ap_ssid), "%.23s", p5);
                                g_st.ap_clients = atoi(p6);
                            }
                        }
                    }
                }
            }
        } else if (strncmp(line, "CHAIN|", 6) == 0) {
            /* CHAIN|<enabled>|<role_idx>|<has_secret>|<secret>|<chain_id>|<peers_count>|<peer_ip>|<status_msg> */
            char *p1 = line + 6;
            char *p2 = strchr(p1, '|');
            if (p2) {
                *p2++ = '\0';
                g_st.chain_enabled = (atoi(p1) != 0);
                char *p3 = strchr(p2, '|');
                if (p3) {
                    *p3++ = '\0';
                    g_st.chain_role_idx = atoi(p2);
                    char *p4 = strchr(p3, '|');
                    if (p4) {
                        *p4++ = '\0';
                        g_st.chain_has_secret = (atoi(p3) != 0);
                        char *p5 = strchr(p4, '|');
                        if (p5) {
                            *p5++ = '\0';
                            if (!g_st.osk_open || g_st.osk_target != 1) {
                                snprintf(g_st.chain_secret, sizeof(g_st.chain_secret), "%.50s", p4);
                            }
                            char *p6 = strchr(p5, '|');
                            if (p6) {
                                *p6++ = '\0';
                                snprintf(g_st.chain_id, sizeof(g_st.chain_id), "%.18s", p5);
                                char *p7 = strchr(p6, '|');
                                if (p7) {
                                    *p7++ = '\0';
                                    g_st.chain_peers = atoi(p6);
                                    char *p8 = strchr(p7, '|');
                                    if (p8) {
                                        *p8++ = '\0';
                                        snprintf(g_st.chain_peer_ip, sizeof(g_st.chain_peer_ip), "%.26s", p7);
                                        snprintf(g_st.chain_status_msg, sizeof(g_st.chain_status_msg), "%.62s", p8);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else if (strncmp(line, "SSID|", 5) == 0 && w_count < 6) {
            char *p1 = line + 5;
            char *p2 = strchr(p1, '|');
            if (p2) {
                *p2++ = '\0';
                char *p3 = strchr(p2, '|');
                if (p3) {
                    *p3++ = '\0';
                    char *p4 = strchr(p3, '|');
                    if (p4) {
                        *p4++ = '\0';
                        g_st.wifi_list[w_count].active = (atoi(p1) != 0);
                        g_st.wifi_list[w_count].signal = atoi(p2);
                        snprintf(g_st.wifi_list[w_count].sec, sizeof(g_st.wifi_list[w_count].sec), "%.9s", p3);
                        snprintf(g_st.wifi_list[w_count].ssid, sizeof(g_st.wifi_list[w_count].ssid), "%.31s", p4);
                        w_count++;
                    }
                }
            }
        } else if (strncmp(line, "LIMB|", 5) == 0 && l_count < 6) {
            /* LIMB|key|name|driver|job|ap_ok|bands|band|remember|iface|info|clients */
            char *fld[11];
            int nf = 0;
            char *q = line + 5;
            q[strcspn(q, "\r\n")] = '\0';
            while (nf < 11) {
                fld[nf++] = q;
                char *bar = strchr(q, '|');
                if (!bar) break;
                *bar = '\0';
                q = bar + 1;
            }
            if (nf == 11) {
                LimbItem *l = &g_st.limbs[l_count++];
                snprintf(l->key, sizeof(l->key), "%.17s", fld[0]);
                snprintf(l->name, sizeof(l->name), "%.29s", fld[1]);
                snprintf(l->driver, sizeof(l->driver), "%.15s", fld[2]);
                snprintf(l->job, sizeof(l->job), "%.5s", fld[3]);
                l->ap_ok = atoi(fld[4]) != 0;
                l->bands = atoi(fld[5]);
                snprintf(l->band, sizeof(l->band), "%.2s", fld[6]);
                l->remember = atoi(fld[7]) != 0;
                snprintf(l->iface, sizeof(l->iface), "%.15s", fld[8]);
                snprintf(l->info, sizeof(l->info), "%.47s", fld[9]);
                l->clients = atoi(fld[10]);
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
                    *p2++ = '\0';
                    char *p3 = strchr(p2, '|');
                    if (p3) {
                        *p3++ = '\0';
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
                *p2++ = '\0';
                char *p3 = strchr(p2, '|');
                if (p3) {
                    *p3++ = '\0';
                    char *p4 = strchr(p3, '|');
                    if (p4) *p4++ = '\0';
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
                *p2++ = '\0';
                char *p3 = strchr(p2, '|');
                if (p3) *p3++ = '\0';
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
    g_st.limb_count = l_count;
    g_st.debug_log_count = d_count;
    bool pick_here = false;                  /* a card being chosen for, unplugged: forget the choice */
    for (int i = 0; i < l_count; i++) if (strcmp(g_st.limbs[i].key, g_st.limb_pick_key) == 0) pick_here = true;
    if (!pick_here) g_st.limb_pick = -1;
    if (g_st.board_cursor > g_st.board_count) g_st.board_cursor = g_st.board_count;
    if (g_st.file_cursor > g_st.file_count) g_st.file_cursor = g_st.file_count;
    if (g_st.wifi_cursor > g_st.limb_count) g_st.wifi_cursor = g_st.limb_count;
}

/* v2.0: the cockpit no longer broadcasts or accepts chat on a LAN UDP port
 * (it used to post any datagram on :42420 into #wifi-mesh). The Stump's own
 * chain and discovery (UDP 4244) carry everything between Stumps. */
static void broadcast_udp_beacon(const char *type, const char *msg) {
    (void)type;
    (void)msg;
}

static void poll_udp_mesh(void) {
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
    set_ui_busy("Sending the command…", 1200);

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
    set_ui_busy("Posting the notice…", 1600);
    g_st.board_preset_idx = (g_st.board_preset_idx + 1) % 5;
    trigger_chime(880, 65);
}

static void action_board_backup_checked_tf(void) {
    int chk = count_checked_boards();
    if (chk <= 0) {
        set_ui_busy("Check a notice first (A on it)", 2200);
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
    set_ui_busy("Backing up the checked notices to the TF card…", 2600);
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
    set_ui_busy("Deleting the checked notices…", 2000);
    trigger_chime(440, 70);
}

static void action_file_add(void) {
    int m = g_st.file_action_idx % 3;
    char cmd[128];
    snprintf(cmd, sizeof(cmd), "FILE_ADD|%d", m);
    send_bridge_cmd(cmd);
    set_ui_busy("Sharing the next file from drop/…", 1800);
    g_st.file_action_idx = (g_st.file_action_idx + 1) % 3;
    trigger_chime(880, 65);
}

static void action_file_backup_checked_tf(void) {
    int chk = count_checked_files();
    if (chk <= 0) {
        set_ui_busy("Check a file first (A on it)", 2200);
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
    set_ui_busy("Backing up the checked files to the TF card…", 2600);
    trigger_chime(860, 75);
}

static void action_file_delete_checked(void) {
    char names[320] = "";
    for (int i = 0; i < g_st.file_count; i++) {
        if (g_st.files[i].checked) {
            if (names[0]) strncat(names, ",", sizeof(names) - strlen(names) - 1);
            strncat(names, g_st.files[i].name, sizeof(names) - strlen(names) - 1);
            g_st.files[i].checked = false;
        }
    }
    if (!names[0]) return;
    char cmd[360];
    snprintf(cmd, sizeof(cmd), "FILE_DEL_MULTI|%s", names);
    send_bridge_cmd(cmd);
    set_ui_busy("Deleting the checked files…", 2000);
    trigger_chime(440, 70);
}

static void open_delete_confirm(int type) {
    if (type == 1) {
        int chk = count_checked_boards();
        if (chk <= 0) {
            set_ui_busy("Check a notice first, then delete", 2200);
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
            set_ui_busy("Check a file first, then delete", 2200);
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
        send_bridge_cmd("CHAIN_SCAN");
        set_ui_busy("Looking for Stumps on this network…", 3000);
        trigger_chime(880, 75);
    } else if (g_st.debug_bar_mode == 1) {
        open_chain_secret_osk();
    } else if (g_st.debug_bar_mode == 2) {
        send_bridge_cmd("DEBUG_EXPORT_TF");
        set_ui_busy("Saving diagnostics to the TF card…", 3000);
        trigger_chime(880, 75);
    } else {
        send_bridge_cmd("DEBUG_HEAL_NET");
        set_ui_busy("Restarting the Stump…", 3000);
        trigger_chime(784, 70);
    }
}

static void update_qr_if_needed(void) {
    char target_url[64];
    const char *lan_ip = (g_st.bridge_lan_ip[0] && strcmp(g_st.bridge_lan_ip, "127.0.0.1") != 0)
                         ? g_st.bridge_lan_ip : g_st.net.primary_ip;
    if (g_st.qr_mode == 1) {
        snprintf(target_url, sizeof(target_url), "WIFI:S:%s;T:nopass;;",
                 g_st.ap_ssid[0] ? g_st.ap_ssid : "Stump");
    } else if (!g_st.http80_ok && g_st.http8080_ok) {
        snprintf(target_url, sizeof(target_url), "http://%s:8080/", lan_ip);
    } else {
        snprintf(target_url, sizeof(target_url), "http://%s/", lan_ip);
    }
    if (strcmp(target_url, g_st.qr_url) != 0) {
        snprintf(g_st.qr_url, sizeof(g_st.qr_url), "%s", target_url);
        encode_qr_v2_l(g_st.qr_url, g_st.qr_grid);
    }
}


/* ==== FireFly's keyboard: firefly/ui/widgets.py Compose, for the cockpit ====
 * Full screen while open, and it takes every button first (as FireFly's
 * pushed screen does): A key, B delete, X space, Y shift, L/R page, START
 * send/OK, SELECT cancel, the D-pad to move; a USB keyboard types too. Real
 * lower and upper case, symbols and accents: what you type is what is sent
 * (a chain secret keeps its exact case). Done, it hands the text to
 * send_typed_chat(), which knows the purpose (chat or chain secret). */
static const char *CMP_PAGES[3][4] = {
    { "1234567890", "qwertyuiop", "asdfghjkl'", "zxcvbnm,.?" },
    { "!@#$%&*()-", "_=+/\\:;\"<>", "[]{}~`|^€£", "°±×÷…«»¿¡·" },
    { "àâäçéèêëîï", "ôöùûüÿœæñß",
      "ÀÂÇÉÈÊÎÔÙÛ", "✓✗→←↑↓♥☺★—" },
};
static const char *CMP_PAGE_NAMES[3] = { "ABC", "SYM", "ÀÉ" };
static const char *CMP_SPECIALS[4] = { "⇧", "PAGE", "SPACE", "⌫" };
static struct { int page, row, col; bool shift, was_open; } g_cmp;

static int utf8_count(const char *s) { int n = 0; while (utf8_next(&s)) n++; return n; }

static uint32_t utf8_at(const char *s, int i) {
    uint32_t c = 0;
    for (int k = 0; k <= i; k++) { c = utf8_next(&s); if (!c) return 0; }
    return c;
}

static int utf8_put(char *o, uint32_t c) {
    if (c < 0x80) { o[0] = (char)c; return 1; }
    if (c < 0x800) { o[0] = (char)(0xC0 | (c >> 6)); o[1] = (char)(0x80 | (c & 0x3F)); return 2; }
    if (c < 0x10000) { o[0] = (char)(0xE0 | (c >> 12)); o[1] = (char)(0x80 | ((c >> 6) & 0x3F));
                       o[2] = (char)(0x80 | (c & 0x3F)); return 3; }
    o[0] = (char)(0xF0 | (c >> 18)); o[1] = (char)(0x80 | ((c >> 12) & 0x3F));
    o[2] = (char)(0x80 | ((c >> 6) & 0x3F)); o[3] = (char)(0x80 | (c & 0x3F)); return 4;
}

static uint32_t cp_upper(uint32_t c) {
    if (c >= 'a' && c <= 'z') return c - 32;
    if (c >= 0xE0 && c <= 0xFE && c != 0xF7) return c - 32;     /* à..þ -> À..Þ (not ÷) */
    if (c == 0x153) return 0x152;                                 /* œ -> Œ */
    if (c == 0xFF) return 0x178;                                  /* ÿ -> Ÿ */
    return c;
}

static bool cmp_is_chat(void) { return g_st.tab_idx != 3 && g_st.tab_idx != 4 && g_st.osk_target != 1; }
static const char *cmp_send_label(void) { return cmp_is_chat() ? "SEND" : "OK"; }
static int cmp_max_bytes(void) {
    if (g_st.osk_target == 1 || g_st.tab_idx == 4) return 50;    /* chain secret */
    return 295;                                                   /* one LoRa packet's text */
}
static int cmp_row_len(int r) { return r < 4 ? utf8_count(CMP_PAGES[g_cmp.page][r]) : 5; }

static void cmp_reset(void) {
    g_cmp.page = 0; g_cmp.row = 1; g_cmp.col = 0; g_cmp.shift = false;
}

static void cmp_type_cp(uint32_t c) {
    char b[5];
    int n = utf8_put(b, c);
    if (g_st.input_len + n > cmp_max_bytes() || g_st.input_len + n >= (int)sizeof(g_st.input_buf)) {
        trigger_chime(300, 40);
        return;
    }
    memcpy(g_st.input_buf + g_st.input_len, b, (size_t)n);
    g_st.input_len += n;
    g_st.input_buf[g_st.input_len] = '\0';
    trigger_chime(600, 15);
}

static void cmp_close(bool keep) {
    g_st.osk_open = false;
    g_st.osk_target = 0;
    if (!keep) { g_st.input_len = 0; g_st.input_buf[0] = '\0'; }
}

static void cmp_finish(void) {
    if (g_st.input_len <= 0 && cmp_is_chat()) { cmp_close(false); return; }
    send_typed_chat();                 /* chat line or chain secret, by purpose */
    cmp_close(false);
}

static void cmp_move(int dx, int dy) {
    g_cmp.row = (g_cmp.row + dy + 5) % 5;
    int n = cmp_row_len(g_cmp.row);
    g_cmp.col = ((g_cmp.col + dx) % n + n) % n;
    trigger_chime(520, 10);
}

static void cmp_page(int d) {
    g_cmp.page = (g_cmp.page + d + 3) % 3;
    g_cmp.col %= cmp_row_len(g_cmp.row);
    trigger_chime(660, 20);
}

static void cmp_press(void) {
    if (g_cmp.row < 4) {
        uint32_t c = utf8_at(CMP_PAGES[g_cmp.page][g_cmp.row], g_cmp.col);
        if (!c) return;
        if (g_cmp.shift) c = cp_upper(c);
        cmp_type_cp(c);
        g_cmp.shift = false;
    } else if (g_cmp.col == 0) {
        g_cmp.shift = !g_cmp.shift; trigger_chime(740, 20);
    } else if (g_cmp.col == 1) {
        cmp_page(1);
    } else if (g_cmp.col == 2) {
        cmp_type_cp(' ');
    } else if (g_cmp.col == 3) {
        input_backspace(); trigger_chime(420, 15);
    } else {
        cmp_finish();
    }
}

/* Every key while the keyboard is open (value 1 press, 2 repeat). */
static void cmp_key(uint16_t code, int value, bool shift_held) {
    bool press = (value == 1), rep = (value == 2);
    if (!press && !rep) return;
    if (code == BTN_DPAD_UP || code == 544 || code == KEY_UP) cmp_move(0, -1);
    else if (code == BTN_DPAD_DOWN || code == 545 || code == KEY_DOWN) cmp_move(0, 1);
    else if (code == BTN_DPAD_LEFT || code == 546 || code == KEY_LEFT) cmp_move(-1, 0);
    else if (code == BTN_DPAD_RIGHT || code == 547 || code == KEY_RIGHT) cmp_move(1, 0);
    else if (code == R36_BTN_B_CANCEL || code == KEY_BACKSPACE) { input_backspace(); trigger_chime(420, 15); }
    else if (!press) return;                                     /* the rest: one press, one action */
    else if (code == R36_BTN_A_ACCEPT) cmp_press();
    else if (code == 307) cmp_type_cp(' ');                      /* X: space */
    else if (code == 308) { g_cmp.shift = !g_cmp.shift; trigger_chime(740, 20); }   /* Y: shift */
    else if (code == BTN_TL || code == 310) cmp_page(-1);
    else if (code == BTN_TR || code == 311) cmp_page(1);
    else if (code == BTN_START || code == 315 || code == 705 || code == 707 ||
             code == KEY_ENTER || code == KEY_KPENTER) cmp_finish();
    else if (code == BTN_SELECT || code == BTN_MODE || code == 314 || code == 704 || code == 706 ||
             code == KEY_ESC) { cmp_close(false); trigger_chime(480, 30); }
    else if (code < 256) {
        char ch = translate_linux_key(code, shift_held);
        if (ch) cmp_type_cp((unsigned char)ch);
    }
}

/* Rounded boxes, as FireFly's draw.box (pygame border_radius). */
static void fill_rrect(uint32_t *fb, int x, int y, int w, int h, int r, uint32_t color) {
    if (r * 2 > h) r = h / 2;
    if (r * 2 > w) r = w / 2;
    for (int i = 0; i < h; i++) {
        int inset = 0;
        int dy = (i < r) ? (r - i) : (i >= h - r ? (i - (h - r) + 1) : 0);
        if (dy > 0) {
            int k = 0;
            while (k < r && (r - k) * (r - k) + dy * dy > r * r) k++;
            inset = k;
        }
        fill_rect(fb, x + inset, y + i, w - 2 * inset, 1, color);
    }
}

static void stroke_rrect(uint32_t *fb, int x, int y, int w, int h, int r, uint32_t color, uint32_t inner) {
    fill_rrect(fb, x, y, w, h, r, color);
    fill_rrect(fb, x + 1, y + 1, w - 2, h - 2, r > 1 ? r - 1 : 0, inner);
}

static int ctext(uint32_t *fb, int fid, int x, int y, const char *s, uint32_t color, int max_px) {
    if (g_fonts_ok) return font_text(fb, fid, x, y, s, color, max_px);
    draw_text_s(fb, x, y + 4, s, color, fid == F30B ? 3 : 2, max_px > 0 ? max_px / (fid == F30B ? 18 : 12) : 0);
    return font_width(fid, s);
}

static int cline(int fid) { return g_fonts_ok ? g_fonts[fid].line : (fid == F30B ? 24 : 18); }

/* FireFly's hint bar: keycaps on the sidebar colour, labels muted. */
static void draw_hint_bar(uint32_t *fb, const ThemeColors *th, const char *const *keys, const char *const *labels, int n) {
    int line = cline(F16);
    int y = PANEL_H - line - 10;
    fill_rect(fb, 0, y - 6, PANEL_W, PANEL_H - y + 6, th->panel2);
    int x = 10;
    for (int i = 0; i < n; i++) {
        int kw = font_width(F16, keys[i]) + 10;
        if (x + kw > PANEL_W - 20) break;
        fill_rrect(fb, x, y, kw, line - 2, 4, th->border);
        ctext(fb, F16, x + 5, y - 1, keys[i], th->text, 0);
        x += kw + 5;
        x += ctext(fb, F16, x, y - 1, labels[i], th->muted, PANEL_W - x - 8) + 13;
    }
}

static void compose_draw(uint32_t *fb, const ThemeColors *th) {
    const int W = PANEL_W, H = PANEL_H;
    fill_rect(fb, 0, 0, W, H, th->bg);
    int line = cline(F24);
    char title[96];
    if (g_st.osk_target == 1 || g_st.tab_idx == 4) snprintf(title, sizeof(title), "Chain secret");
    else {
        const char *rooms[3] = { "#main", "#lora-mesh", "#wifi-mesh" };
        snprintf(title, sizeof(title), "To %s", rooms[g_st.room_idx % 3]);
    }
    ctext(fb, F30B, 14, 8, title, th->ember, W - 28);

    /* The text, wrapped, the end of it shown, a cursor after it. */
    int ax = 10, ay = 14 + line, aw = W - 20, ah = H * 2 / 5 - line;
    stroke_rrect(fb, ax, ay, aw, ah, 8, th->border, th->panel);
    char buf[sizeof(g_st.input_buf) + 8];
    snprintf(buf, sizeof(buf), "%s▏", g_st.input_buf);
    int per = g_fonts_ok ? (aw - 20) * 64 / g_fonts[F24].adv64 : (aw - 20) / 12;
    if (per < 4) per = 4;
    const char *starts[64];
    int nl = 0;
    const char *p = buf;
    while (*p && nl < 64) {
        starts[nl++] = p;
        const char *q = p, *brk = NULL, *after = NULL;
        int n = 0;
        while (*q && n < per) {
            const char *prev = q;
            uint32_t c = utf8_next(&q);
            if (c == ' ') { brk = prev; after = q; }
            n++;
        }
        if (!*q) break;
        p = (brk && brk > starts[nl - 1]) ? after : q;
    }
    int maxl = (ah - 12) / line;
    int first = nl > maxl ? nl - maxl : 0;
    for (int i = first; i < nl; i++) {
        char tmp[sizeof(buf)];
        size_t len = (i + 1 < nl) ? (size_t)(starts[i + 1] - starts[i]) : strlen(starts[i]);
        if (len >= sizeof(tmp)) len = sizeof(tmp) - 1;
        memcpy(tmp, starts[i], len);
        tmp[len] = '\0';
        ctext(fb, F24, ax + 10, ay + 6 + (i - first) * line, tmp, th->text, aw - 20);
    }

    char pg[32];
    snprintf(pg, sizeof(pg), "%s%s", CMP_PAGE_NAMES[g_cmp.page], g_cmp.shift ? "  ⇧" : "");
    ctext(fb, F16, 14, ay + ah + 4, pg, th->muted, 0);
    char meter[64];
    if (cmp_is_chat())
        snprintf(meter, sizeof(meter), "%d/295 B · 1 LoRa packet", g_st.input_len);
    else
        snprintf(meter, sizeof(meter), "%d/%d bytes", g_st.input_len, cmp_max_bytes());
    ctext(fb, F16, ax + aw - 8 - font_width(F16, meter), ay + ah + 4, meter, th->muted, 0);

    /* The keys. */
    int kb_top = ay + ah + line + 8;
    int kb_h = H - kb_top - line - 16;
    int rh = kb_h / 5;
    for (int r = 0; r < 5; r++) {
        int n = cmp_row_len(r);
        for (int c = 0; c < n; c++) {
            char label[16];
            if (r < 4) {
                uint32_t cp = utf8_at(CMP_PAGES[g_cmp.page][r], c);
                if (g_cmp.shift) cp = cp_upper(cp);
                label[utf8_put(label, cp)] = '\0';
            } else {
                snprintf(label, sizeof(label), "%s", c < 4 ? CMP_SPECIALS[c] : cmp_send_label());
            }
            int kx = 10 + c * (W - 20) / n + 2, kw = (W - 20) / n - 4;
            int ky = kb_top + r * rh + 2, kh = rh - 4;
            bool sel = (r == g_cmp.row && c == g_cmp.col);
            if (sel) fill_rrect(fb, kx, ky, kw, kh, 6, th->ember);
            else stroke_rrect(fb, kx, ky, kw, kh, 6, th->border, th->panel);
            int fid = (utf8_count(label) == 1) ? F24 : F16;
            int lw = font_width(fid, label);
            ctext(fb, fid, kx + (kw - lw) / 2, ky + (kh - cline(fid)) / 2, label, sel ? th->bg : th->text, 0);
        }
    }
    static const char *const hk[7] = { "A", "B", "X", "Y", "L/R", "START", "SEL" };
    const char *hl[7] = { "key", "del", "space", "shift", "page", cmp_is_chat() ? "send" : "ok", "cancel" };
    draw_hint_bar(fb, th, hk, hl, 7);
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
    load_fonts();
    snprintf(g_st.ver_str, sizeof(g_st.ver_str), "v2.4.0-r36max");
    snprintf(g_st.build_str, sizeof(g_st.build_str), "PC Stump cockpit");
    g_st.http80_ok = true;
    g_st.http8080_ok = true;
    g_st.chain_enabled = true;
    g_st.room_idx = 2; /* Default Chat Room: #WIFI-MESH (Stump Chain room) so console writes reach all Chain Stumps */
    g_st.chain_role_idx = 2; /* Default Role: MEMBER (Connects to another Stump on LAN, NOT parent/host) */
    snprintf(g_st.chain_id, sizeof(g_st.chain_id), "none");
    snprintf(g_st.chain_status_msg, sizeof(g_st.chain_status_msg), "MEMBER MODE: CONNECTING TO PARENT STUMP (:4242)");
    snprintf(g_st.node_lxmf, sizeof(g_st.node_lxmf), "A7F391C208B4E6D1");
    snprintf(g_st.rnode_status, sizeof(g_st.rnode_status), "WAIT-USB");
    snprintf(g_st.ap_ssid, sizeof(g_st.ap_ssid), "Stump");
    snprintf(g_st.ap_mac, sizeof(g_st.ap_mac), "00:0f:00:5e:11:ee");
    snprintf(g_st.ap_driver, sizeof(g_st.ap_driver), "rt2800usb");
    snprintf(g_st.wifi_status_msg, sizeof(g_st.wifi_status_msg), "Wi-Fi: EmulationStation's");

    scan_transports(&g_st.net);
    g_st.limb_pick = -1;
    poll_live_bridge();
    update_qr_if_needed();


    int max_frames = (argc > 1 && strcmp(argv[1], "--smoke") == 0) ? 10 : 0;
    bool use_shm_only = (argc > 1 && strcmp(argv[1], "--shm") == 0);
    const char *fb0_pan_env = getenv("STUMP_FB0_PAN");
    bool force_fb0_pan = (fb0_pan_env && strcmp(fb0_pan_env, "1") == 0);

    /* Open /dev/shm/stump_fb.rgba (720x720x4 RGBA shared memory) for FireFly pygame.display.flip() presenter */
    uint8_t *shm_rgba = NULL;
    int shm_fd = open(SHM_FB_FILE, O_RDWR | O_CREAT, 0666);
    if (shm_fd >= 0) {
        if (ftruncate(shm_fd, PANEL_BYTES) == 0) {
            void *sm = mmap(NULL, PANEL_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd, 0);
            if (sm != MAP_FAILED) shm_rgba = (uint8_t *)sm;
        }
    }

    void *sdl = NULL;
    if (max_frames == 0 && !use_shm_only) {
        sdl = dlopen("libSDL2-2.0.so.0", RTLD_LAZY | RTLD_GLOBAL);
        if (!sdl) sdl = dlopen("/usr/lib/aarch64-linux-gnu/libSDL2-2.0.so.0", RTLD_LAZY | RTLD_GLOBAL);
    }

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
    size_t fb0_map_len = PANEL_BYTES;
    int fb_fd = -1;
    struct fb_var_screeninfo vinfo;
    struct fb_fix_screeninfo finfo;
    memset(&vinfo, 0, sizeof(vinfo));
    memset(&finfo, 0, sizeof(finfo));
    /* CRITICAL (FireFly_RK3326_R36MAX_R36S Display rule):
     * When running under stump_pygame_display.py (--shm without STUMP_FB0_PAN=1),
     * NEVER open /dev/fb0 or call ioctl(fb_fd, FBIOBLANK, FB_BLANK_UNBLANK)!
     * On Rockchip RK3326 (rockchipdrm, Linux 4.4.189), calling FBIOBLANK on /dev/fb0 invokes
     * drm_fb_helper_restore_fbdev_mode_unlocked(), which detaches pygame's KMSDRM plane
     * from the VOP CRTC and switches the hardware display back to the black VT1 fbcon console! */
    if (!tex && max_frames == 0 && (!use_shm_only || force_fb0_pan)) {
        fb_fd = open("/dev/fb0", O_RDWR);
        if (fb_fd >= 0) {
            ioctl(fb_fd, FBIOBLANK, FB_BLANK_UNBLANK);
            /* Read vinfo/finfo ONLY — never call FBIOPUT_VSCREENINFO which resets RK3326 DSI timings */
            ioctl(fb_fd, FBIOGET_VSCREENINFO, &vinfo);
            if (ioctl(fb_fd, FBIOGET_FSCREENINFO, &finfo) == 0 && finfo.smem_len > 0) {
                if (finfo.smem_len < fb0_map_len) fb0_map_len = finfo.smem_len;
            }
            void *m = mmap(NULL, fb0_map_len, PROT_READ | PROT_WRITE, MAP_SHARED, fb_fd, 0);
            if (m != MAP_FAILED) fb0_map = (uint32_t *)m;
        }
    }
    fprintf(stderr, "[Stump-R36MAX %s] Display ready (SDL_tex=%p fb0_mmap=%p shm_rgba=%p) WiFi=%s(%s) QR=%s\n",
            g_st.ver_str, tex, (void *)fb0_map, (void *)shm_rgba, g_st.net.wifi_if[0] ? g_st.net.wifi_if : "none",
            g_st.net.primary_ip, g_st.qr_url);
    fflush(stderr);

    int ev_fds[16];
    for (int i = 0; i < 16; i++) {
        char p[64];
        snprintf(p, sizeof(p), "/dev/input/event%d", i);
        ev_fds[i] = open(p, O_RDONLY | O_NONBLOCK);
    }

    pthread_t audio_tid = 0;
    bool audio_started = false;
    if (max_frames == 0) {
        if (pthread_create(&audio_tid, NULL, alsa_chime_thread, NULL) == 0) {
            audio_started = true;
        }
        trigger_chime(660, 70);
    }
    

    uint32_t *fb = calloc(PANEL_W * PANEL_H, sizeof(uint32_t));
    bool select_held = false, start_held = false;
    int frames = 0;
    int last_room_view = -1;

    while (g_st.running) {
        if (fn_PumpEvents && tex) fn_PumpEvents();

        if (g_st.suppress_poll_frames > 0) g_st.suppress_poll_frames--;
        if (g_st.osk_open && !g_cmp.was_open) cmp_reset();
        g_cmp.was_open = g_st.osk_open;
        if (getenv("STUMP_COCKPIT_TAB") && frames == 0) g_st.tab_idx = atoi(getenv("STUMP_COCKPIT_TAB")) % 5;
        if (getenv("STUMP_COCKPIT_CONFIRM") && frames == 0) {          /* screenshots in tests */
            g_st.confirm_open = true;
            g_st.confirm_type = atoi(getenv("STUMP_COCKPIT_CONFIRM"));
            g_st.confirm_choice = 1;
            snprintf(g_st.confirm_label, sizeof(g_st.confirm_label), "%s", g_st.confirm_type == 3
                     ? "AP on Blueway High Power: leaves HomeNet" : "2 notices: March\u00e9 samedi, Potluck Sunday");
        }
        if (getenv("STUMP_COCKPIT_OSK") && frames == 0) {     /* screenshots in tests: open it at start */
            g_st.osk_open = true; cmp_reset(); g_cmp.was_open = true;
            g_cmp.page = atoi(getenv("STUMP_COCKPIT_OSK")) % 3;
            g_cmp.shift = getenv("STUMP_COCKPIT_SHIFT") != NULL;
            const char *t = getenv("STUMP_COCKPIT_TEXT");
            if (t) { snprintf(g_st.input_buf, sizeof(g_st.input_buf), "%s", t); g_st.input_len = (int)strlen(g_st.input_buf); }
        }

        /* The room on screen: the feed joins it (the Stump keeps one current room per client). */
        if (g_st.room_idx != last_room_view || frames % 300 == 0) {
            char rv[48];
            snprintf(rv, sizeof(rv), "ROOM_VIEW|%s", ROOM_SLUGS[g_st.room_idx]);
            send_bridge_cmd(rv);
            g_st.suppress_poll_frames = 0;
            last_room_view = g_st.room_idx;
        }

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
                    if (ev.code == KEY_CAPSLOCK) {
                        if (ev.value == 1) g_caps_lock = !g_caps_lock;
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
                            /* 220 ms against contact bounce; 90 while typing, so the keyboard keeps up */
                            if (now_ms - g_st.last_btn_ms < (g_st.osk_open ? 90u : 220u)) continue;
                            g_st.last_btn_ms = now_ms;
                        }
                        g_st.last_ev_code = (int)ev.code;
                    }

                    /* A USB keyboard typing on the chat tab: FireFly's keyboard opens, so you see
                     * what you type, big (OTG port, or a hub on it). */
                    if (!g_st.osk_open && !g_st.confirm_open && g_st.tab_idx == 0 && ev.code < 256 && ev.value == 1 &&
                        ev.code != KEY_ENTER && ev.code != KEY_KPENTER && ev.code != KEY_ESC && ev.code != KEY_TAB &&
                        translate_linux_key(ev.code, g_st.shift_held) != 0) {
                        g_st.osk_open = true;
                        g_st.osk_target = 0;
                        cmp_reset();
                        g_cmp.was_open = true;
                    }
                    /* FireFly's keyboard, while open, takes every key first. */
                    if (g_st.osk_open) {
                        cmp_key(ev.code, ev.value, g_st.shift_held);
                        continue;
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
                            set_ui_busy("Cancelled: nothing changed", 1000);
                            trigger_chime(480, 35);
                            continue;
                        } else if (ev.code == R36_BTN_A_ACCEPT || ev.code == KEY_ENTER || ev.code == KEY_KPENTER) {
                            /* Physical A (305) or ENTER confirms the highlighted NO/YES choice */
                            if (g_st.confirm_choice == 1) {
                                if (g_st.confirm_type == 1) action_board_delete_checked();
                                else if (g_st.confirm_type == 2) action_file_delete_checked();
                                else if (g_st.confirm_type == 3) limb_confirmed();
                            } else {
                                if (g_st.confirm_type == 3) g_st.limb_pick = -1;
                                set_ui_busy("Cancelled: nothing changed", 1000);
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
                            else if (g_st.tab_idx == 3) network_tab_a();
                            else if (g_st.tab_idx == 4) {
                                if (g_st.osk_open || g_st.input_len > 0) send_typed_chat();
                                else if (g_st.rev_cursor == 2) open_chain_secret_osk();
                                else if (g_st.rev_cursor <= 1 || g_st.rev_cursor == 3) go_network_tab();
                                else execute_debug_tab_action();
                            }
                            else if (g_st.input_len > 0) send_typed_chat();
                            else execute_rrc_deck_action();
                            continue;
                        } else if (ev.code == KEY_ESC && pressed) {
                            if (g_st.osk_open) { g_st.osk_open = false; g_st.osk_target = 0; }
                            else if (g_st.tab_idx == 3) g_st.limb_pick = -1;
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
                                if (g_st.tab_idx == 4) {
                                    g_st.osk_target = 1;
                                } else if (g_st.tab_idx != 0) {
                                    g_st.tab_idx = 0;
                                    g_st.osk_target = 0;
                                }
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
                                network_tab_a();
                            } else if (g_st.tab_idx == 4) {
                                if (g_st.osk_open) send_typed_chat();
                                else go_network_tab();
                            } else if (g_st.input_len > 0) {
                                send_typed_chat();
                            } else {
                                g_st.cmd_cursor = 4;
                                execute_rrc_deck_action();
                            }
                        }
                    }
                    if (select_held && start_held) {
                        int qfd = open("/dev/shm/stump_user_quit", O_WRONLY | O_CREAT | O_TRUNC, 0666);
                        if (qfd >= 0) close(qfd);
                        g_st.running = false;
                    }

                    if (pressed) {
                        /* L1 / R1 cycle across all 5 Panels */
                        if (ev.code == BTN_TL || ev.code == 310) {
                            g_st.confirm_open = false;
                            g_st.osk_open = false;
                            g_st.tab_idx = (g_st.tab_idx + 4) % 5;
                            trigger_chime(523, 35);
                        } else if (ev.code == BTN_TR || ev.code == 311) {
                            g_st.confirm_open = false;
                            g_st.osk_open = false;
                            g_st.tab_idx = (g_st.tab_idx + 1) % 5;
                            trigger_chime(659, 35);
                        } else if (ev.code == BTN_TL2 || ev.code == BTN_TR2 || ev.code == 312 || ev.code == 313) {
                            g_st.theme_idx = (g_st.theme_idx + 1) % 5;
                            trigger_chime(784, 35);
                        } else if (g_st.tab_idx == 0) {
                            /* Panel 1: RRC Chat & Quick Mesh Command Deck (A=Accept/Send, B=Cancel/Clear) */
                            if (ev.code == 308) {
                                g_st.osk_target = 0;
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
                                        g_st.input_buf[0] = '\0';
                                        set_ui_busy("Draft cleared", 900);
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
                                    set_ui_busy("Checks cleared", 900);
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
                                    set_ui_busy("Checks cleared", 900);
                                }
                                trigger_chime(460, 30);
                            } else if (ev.code == 308) {
                                action_file_backup_checked_tf();
                            } else if (ev.code == 307) {
                                open_delete_confirm(2);
                            }
                        } else if (g_st.tab_idx == 3) {
                            /* Panel 4: Stage Wi-Fi / AP + Stump Chain Secret ([A]=Accept/Stage, [B]=Cancel, [Y]=Chain/WiFi OSK) */
                            if (g_st.osk_open) {
                                if (ev.code == BTN_DPAD_LEFT || ev.code == 546) { g_st.osk_col = (g_st.osk_col + 9) % 10; }
                                else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) { g_st.osk_col = (g_st.osk_col + 1) % 10; }
                                else if (ev.code == BTN_DPAD_UP || ev.code == 544) { g_st.osk_row = (g_st.osk_row + 3) % 4; }
                                else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) { g_st.osk_row = (g_st.osk_row + 1) % 4; }
                                else if (ev.code == R36_BTN_A_ACCEPT) { execute_osk_key(); }
                                else if (ev.code == R36_BTN_B_CANCEL || ev.code == 308) {
                                    g_st.osk_open = false;
                                    g_st.osk_target = 0;
                                    trigger_chime(480, 35);
                                }
                                else if (ev.code == 307) { input_backspace(); trigger_chime(420, 25); }
                            } else if (ev.code == 308) {
                                if (g_st.wifi_cursor < g_st.limb_count) limb_remember();
                                else open_chain_secret_osk();
                            } else {
                                int total_rows = g_st.limb_count + 1;
                                if (g_st.wifi_cursor >= total_rows) g_st.wifi_cursor = total_rows - 1;
                                if (ev.code == BTN_DPAD_UP || ev.code == 544) {
                                    g_st.wifi_cursor = (g_st.wifi_cursor + total_rows - 1) % total_rows;
                                    trigger_chime(520, 20);
                                } else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) {
                                    g_st.wifi_cursor = (g_st.wifi_cursor + 1) % total_rows;
                                    trigger_chime(520, 20);
                                } else if (ev.code == BTN_DPAD_LEFT || ev.code == 546 ||
                                           ev.code == BTN_DPAD_RIGHT || ev.code == 547) {
                                    int dir = (ev.code == BTN_DPAD_LEFT || ev.code == 546) ? -1 : 1;
                                    if (g_st.wifi_cursor < g_st.limb_count) {
                                        limb_cycle(dir);
                                    } else {
                                        g_st.wifi_bar_mode = (g_st.wifi_bar_mode + 1) % 2;
                                        trigger_chime(540, 25);
                                    }
                                } else if (ev.code == R36_BTN_A_ACCEPT) {
                                    network_tab_a();
                                } else if (ev.code == R36_BTN_B_CANCEL) {
                                    network_tab_cancel();
                                } else if (ev.code == 307) {
                                    g_st.qr_mode = (g_st.qr_mode + 1) % 2;
                                    update_qr_if_needed();
                                    trigger_chime(660, 45);
                                }
                            }
                        } else if (g_st.tab_idx == 4) {
                            /* Panel 5 (SETUP): the Wi-Fi cards (shown; jobs on NETWORK), chain, tools, log */
                            if (g_st.osk_open) {
                                if (ev.code == BTN_DPAD_LEFT || ev.code == 546) { g_st.osk_col = (g_st.osk_col + 9) % 10; }
                                else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) { g_st.osk_col = (g_st.osk_col + 1) % 10; }
                                else if (ev.code == BTN_DPAD_UP || ev.code == 544) { g_st.osk_row = (g_st.osk_row + 3) % 4; }
                                else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) { g_st.osk_row = (g_st.osk_row + 1) % 4; }
                                else if (ev.code == R36_BTN_A_ACCEPT) { execute_osk_key(); }
                                else if (ev.code == R36_BTN_B_CANCEL || ev.code == 308) {
                                    g_st.osk_open = false;
                                    g_st.osk_target = 0;
                                    g_st.input_len = 0;
                                    g_st.input_buf[0] = '\0';
                                    set_ui_busy("Chain secret: cancelled", 1000);
                                    trigger_chime(480, 35);
                                } else if (ev.code == 307) { input_backspace(); trigger_chime(420, 25); }
                            } else if (ev.code == BTN_DPAD_UP || ev.code == 544) {
                                if (g_st.rev_cursor == 5 && g_st.debug_scroll > 0) {
                                    g_st.debug_scroll--;
                                } else {
                                    g_st.rev_cursor = (g_st.rev_cursor + 5) % 6;
                                }
                                trigger_chime(500, 20);
                            } else if (ev.code == BTN_DPAD_DOWN || ev.code == 545) {
                                if (g_st.rev_cursor == 5 && g_st.debug_scroll + 1 < g_st.debug_log_count) {
                                    g_st.debug_scroll++;
                                } else {
                                    g_st.rev_cursor = (g_st.rev_cursor + 1) % 6;
                                }
                                trigger_chime(500, 20);
                            } else if (ev.code == BTN_DPAD_LEFT || ev.code == 546) {
                                if (g_st.rev_cursor == 2) {
                                    int next_role = (g_st.chain_role_idx + 2) % 3;
                                    commit_chain_settings(g_st.chain_secret, next_role);
                                } else if (g_st.rev_cursor == 4) {
                                    g_st.debug_bar_mode = (g_st.debug_bar_mode + 3) % 4;
                                    trigger_chime(540, 25);
                                }
                            } else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547) {
                                if (g_st.rev_cursor == 2) {
                                    int next_role = (g_st.chain_role_idx + 1) % 3;
                                    commit_chain_settings(g_st.chain_secret, next_role);
                                } else if (g_st.rev_cursor == 4) {
                                    g_st.debug_bar_mode = (g_st.debug_bar_mode + 1) % 4;
                                    trigger_chime(540, 25);
                                }
                            } else if (ev.code == R36_BTN_A_ACCEPT) {
                                if (g_st.rev_cursor == 0 || g_st.rev_cursor == 3) {
                                    go_network_tab();
                                } else if (g_st.rev_cursor == 1) {
                                    set_ui_busy("Wi-Fi is set in EmulationStation: the Stump follows it", 2600);
                                    trigger_chime(520, 30);
                                } else if (g_st.rev_cursor == 2) {
                                    open_chain_secret_osk();
                                } else {
                                    execute_debug_tab_action();
                                }
                            } else if (ev.code == R36_BTN_B_CANCEL) {
                                g_st.rev_cursor = 0;
                                trigger_chime(460, 35);
                            } else if (ev.code == 308) {
                                open_chain_secret_osk();
                            } else if (ev.code == 307) {
                                g_st.debug_bar_mode = 0;
                                execute_debug_tab_action();
                            }
                        }
                    }
                } else if (ev.type == EV_ABS && ev.value != 0) {
                    /* Hardware Debounce for D-Pad Hat Switch (130ms) */
                    if (now_ms - g_st.last_dpad_ms < 130) continue;
                    g_st.last_dpad_ms = now_ms;
                    g_st.last_ev_code = (int)ev.code;

                    if (g_st.osk_open) {
                        if (ev.code == ABS_HAT0X) cmp_move(ev.value < 0 ? -1 : 1, 0);
                        if (ev.code == ABS_HAT0Y) cmp_move(0, ev.value < 0 ? -1 : 1);
                        continue;
                    }
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
                            int total_rows = g_st.limb_count + 1;
                            if (ev.code == ABS_HAT0Y && ev.value < 0) {
                                g_st.wifi_cursor = (g_st.wifi_cursor + total_rows - 1) % total_rows;
                                trigger_chime(520, 20);
                            } else if (ev.code == ABS_HAT0Y && ev.value > 0) {
                                g_st.wifi_cursor = (g_st.wifi_cursor + 1) % total_rows;
                                trigger_chime(520, 20);
                            } else if (ev.code == ABS_HAT0X) {
                                if (g_st.wifi_cursor < g_st.limb_count) {
                                    limb_cycle(ev.value > 0 ? 1 : -1);
                                } else {
                                    g_st.wifi_bar_mode = (g_st.wifi_bar_mode + 1) % 2;
                                    trigger_chime(540, 25);
                                }
                            }
                        }
                    } else if (g_st.tab_idx == 4) {
                        if (g_st.osk_open) {
                            if (ev.code == ABS_HAT0X && ev.value < 0) g_st.osk_col = (g_st.osk_col + 9) % 10;
                            if (ev.code == ABS_HAT0X && ev.value > 0) g_st.osk_col = (g_st.osk_col + 1) % 10;
                            if (ev.code == ABS_HAT0Y && ev.value < 0) g_st.osk_row = (g_st.osk_row + 3) % 4;
                            if (ev.code == ABS_HAT0Y && ev.value > 0) g_st.osk_row = (g_st.osk_row + 1) % 4;
                        } else if (ev.code == ABS_HAT0Y && ev.value < 0) {
                            if (g_st.rev_cursor == 5 && g_st.debug_scroll > 0) g_st.debug_scroll--;
                            else g_st.rev_cursor = (g_st.rev_cursor + 5) % 6;
                            trigger_chime(500, 20);
                        } else if (ev.code == ABS_HAT0Y && ev.value > 0) {
                            if (g_st.rev_cursor == 5 && g_st.debug_scroll + 1 < g_st.debug_log_count) g_st.debug_scroll++;
                            else g_st.rev_cursor = (g_st.rev_cursor + 1) % 6;
                            trigger_chime(500, 20);
                        } else if (ev.code == ABS_HAT0X) {
                            if (g_st.rev_cursor == 2) {
                                int next_role = (g_st.chain_role_idx + (ev.value > 0 ? 1 : 2)) % 3;
                                commit_chain_settings(g_st.chain_secret, next_role);
                            } else if (g_st.rev_cursor == 4) {
                                g_st.debug_bar_mode = (g_st.debug_bar_mode + (ev.value > 0 ? 1 : 3)) % 4;
                                trigger_chime(540, 25);
                            }
                        }
                    }
                }
            }
        }

        const ThemeColors *th = &g_themes[g_st.theme_idx];
        fill_rect(fb, 0, 0, PANEL_W, PANEL_H, th->bg);

        /* ---- FireFly's header (firefly/ui/app.py draw_header): the title, the tab
         * pills in the same band (only the current one boxed), the link dot. ---- */
        const char *disp_ip = (g_st.bridge_lan_ip[0] && strcmp(g_st.bridge_lan_ip, "127.0.0.1") != 0)
                               ? g_st.bridge_lan_ip : g_st.net.primary_ip;
        bool stump_up = (g_st.http80_ok || g_st.http8080_ok) && strncmp(g_st.node_lxmf, "WAITING", 7) != 0
                        && strncmp(g_st.node_lxmf, "STUMP OFFLINE", 13) != 0;
        {
            int hl = cline(F24);
            fill_rect(fb, 0, 0, PANEL_W, hl + 14, th->panel2);
            ctext(fb, F30B, 12, 4, "Stump", th->ember, 0);
            int tx = 12 + font_width(F30B, "Stump  ");
            const char *tabs[5] = { "CHATS", "BOARD", "FILES", "NETWORK", "SETUP" };
            for (int t = 0; t < 5; t++) {
                int w = font_width(F24, tabs[t]) + 14;
                bool act = (t == g_st.tab_idx);
                bool dirty = false;
                if (act) fill_rrect(fb, tx, 6, w, hl + 2, 4, th->ember);
                ctext(fb, F24, tx + 7, 7, tabs[t], act ? th->bg : (dirty ? th->ok : th->muted), 0);
                tx += w + 3;
            }
            const char *link = stump_up ? "● link" : "○ no link";
            ctext(fb, F16, PANEL_W - 10 - font_width(F16, link), 12, link, stump_up ? th->ok : th->warn, 0);

            /* Under it, quieter: where the Stump is, and its radio and Wi-Fi. */
            char l1[200], l2[200];
            snprintf(l1, sizeof(l1), "%s  http://%s%s/  ·  %d other Stump%s",
                     g_st.ver_str, disp_ip, (!g_st.http80_ok && g_st.http8080_ok) ? ":8080" : "",
                     g_st.mesh_peers, g_st.mesh_peers == 1 ? "" : "s");
            ctext(fb, F20, 14, hl + 22, l1, stump_up ? th->text : th->muted, PANEL_W - 28);
            if (g_st.ap_active)
                snprintf(l2, sizeof(l2), "hotspot %s on %s  ·  %d connected  ·  TF backups %d",
                         g_st.ap_ssid, g_st.ap_if, g_st.ap_clients, g_st.tf_backup_count);
            else
                snprintf(l2, sizeof(l2), "Wi-Fi %s %s  ·  LoRa %s  ·  TF backups %d",
                         g_st.net.wifi_if[0] ? g_st.net.wifi_if : "wlan0", disp_ip,
                         g_st.net.lora_online ? g_st.net.lora_dev : g_st.rnode_status, g_st.tf_backup_count);
            ctext(fb, F16, 14, hl + 22 + cline(F20) + 4, l2, g_st.ap_active ? th->ok : th->muted, PANEL_W - 28);
            fill_rect(fb, 0, 124, PANEL_W, 1, th->border);
        }

        /* ---- The five panels, in FireFly's style (firefly/ui/screens.py): small
         * ember headings, normal-case text, label ... value rows, rounded boxes,
         * chat bubbles. Same cursors and actions as before; only the drawing. ---- */
        const uint32_t ACTION_C = 0xFFC8B48Fu, DM_C = 0xFFC8A2C8u;   /* FireFly's ACTION, DM_BODY */
        if (g_st.tab_idx == 0) {
            /* Rooms: FireFly's pills, the current one outlined. */
            static const char *rooms[3] = { "#main", "#lora-mesh", "#wifi-mesh" };
            int rx = 12;
            for (int r = 0; r < 3; r++) {
                char lbl[40];
                snprintf(lbl, sizeof(lbl), "%s %d", rooms[r], g_st.room_users[r]);
                int w = font_width(F20, lbl) + 20;
                bool act = (r == g_st.room_idx);
                if (act) stroke_rrect(fb, rx, 132, w, 30, 6, th->ember, th->panel);
                ctext(fb, F20, rx + 10, 136, lbl, act ? th->ember_bright : th->muted, 0);
                rx += w + 8;
            }

            /* Messages: bubbles, newest at the bottom (FireFly's chat view). */
            int r = g_st.room_idx, ybot = 466;
            if (g_st.room_counts[r] == 0)
                ctext(fb, F20, 20, 190, "No messages yet. Y to write.", th->muted, 0);
            for (int i = g_st.room_counts[r] - 1; i >= 0; i--) {
                const char *nk = g_st.rooms[r][i].nick, *bd = g_st.rooms[r][i].body;
                bool sys = g_st.rooms[r][i].is_sys;
                bool act = (!sys && strcmp(nk, "*") == 0);
                bool dm = (strncmp(nk, "DM ", 3) == 0);
                bool out = (!sys && !act && !dm && strncmp(nk, "r36max", 6) == 0);
                char txt[160];
                if (sys) snprintf(txt, sizeof(txt), "%s", bd);
                else if (act) snprintf(txt, sizeof(txt), "* %s", bd);
                else if (dm) snprintf(txt, sizeof(txt), "[DM] %s: %s", nk + 3, bd);
                else if (out) snprintf(txt, sizeof(txt), "%s", bd);
                else snprintf(txt, sizeof(txt), "<%s> %s", nk, bd);
                /* up to 2 lines of 45 characters (F20 is 12 px a character) */
                int per = 45, n = utf8_count(txt);
                char l1[160], l2[160] = "";
                if (n <= per) {
                    snprintf(l1, sizeof(l1), "%s", txt);
                } else {
                    const char *q = txt, *cut = NULL, *after = NULL;
                    for (int k = 0; k < per && *q; k++) {
                        const char *prev = q;
                        if (utf8_next(&q) == ' ') { cut = prev; after = q; }
                    }
                    if (!cut) { cut = q; after = q; }
                    size_t len = (size_t)(cut - txt);
                    memcpy(l1, txt, len); l1[len] = '\0';
                    snprintf(l2, sizeof(l2), "%s", after);
                }
                int lines = l2[0] ? 2 : 1;
                int w1 = font_width(F20, l1), w2 = font_width(F20, l2);
                int bw = (w1 > w2 ? w1 : w2) + 20, bh = lines * 24 + 12;
                if (bw > PANEL_W - 60) bw = PANEL_W - 60;
                int by = ybot - bh;
                if (by < 170) break;
                int bx = out ? PANEL_W - 12 - bw : 12;
                stroke_rrect(fb, bx, by, bw, bh, 8, out ? th->ember : th->border, th->panel);
                uint32_t fg = sys ? th->muted : act ? ACTION_C : dm ? DM_C : th->text;
                ctext(fb, F20, bx + 10, by + 4, l1, fg, bw - 16);
                if (l2[0]) ctext(fb, F20, bx + 10, by + 28, l2, fg, bw - 16);
                ybot = by - 6;
            }

            /* The draft (Y opens FireFly's keyboard) and its size. */
            bool draft = g_st.input_len > 0;
            stroke_rrect(fb, 12, 474, PANEL_W - 24, 40, 8, draft ? th->ember : th->border, th->panel2);
            char meter[32];
            snprintf(meter, sizeof(meter), "%d/295 B", g_st.input_len);
            int mw = font_width(F16, meter);
            ctext(fb, F20, 24, 482, draft ? g_st.input_buf : "Y to write a message", draft ? th->text : th->muted,
                  PANEL_W - 60 - mw);
            ctext(fb, F16, PANEL_W - 24 - mw, 486, meter, th->muted, 0);

            /* Quick commands. */
            static const char *quick[6] = { "/whoami + /names", "/auth", "!find jardinage",
                                            "!roll 2d6", "announce", "say hello" };
            ctext(fb, F16, 14, 524, "QUICK", th->ember, 0);
            for (int c = 0; c < 6; c++) {
                int cx = 12 + (c % 2) * 354, cy = 546 + (c / 2) * 42;
                bool sel = (c == g_st.cmd_cursor);
                if (sel) fill_rrect(fb, cx, cy, 342, 36, 6, th->ember);
                else stroke_rrect(fb, cx, cy, 342, 36, 6, th->border, th->panel);
                ctext(fb, F20, cx + 12, cy + 6, quick[c], sel ? th->bg : th->text, 320);
            }
        } else if (g_st.tab_idx == 1 || g_st.tab_idx == 2) {
            /* Billboard / shared files: a list with check boxes, then one action row. */
            bool board = (g_st.tab_idx == 1);
            int count = board ? g_st.board_count : g_st.file_count;
            int cursor = board ? g_st.board_cursor : g_st.file_cursor;
            int checked = board ? count_checked_boards() : count_checked_files();
            int shown = board ? 4 : 5;
            char head[96];
            if (board) snprintf(head, sizeof(head), "%d notice%s · %d checked", count, count == 1 ? "" : "s", checked);
            else snprintf(head, sizeof(head), "%d file%s · %d checked · %d of %d MB", count, count == 1 ? "" : "s",
                          checked, g_st.used_kb / 1024, g_st.ceil_kb / 1024);
            ctext(fb, F16, 14, 134, board ? "BILLBOARD" : "SHARED FILES", th->ember, 0);
            ctext(fb, F16, PANEL_W - 14 - font_width(F16, head), 134, head, th->muted, 0);
            if (count == 0)
                ctext(fb, F20, 20, 170, board ? "No notices yet." : "No files shared yet.", th->muted, 0);
            int rh = board ? 76 : 62;
            for (int i = 0; i < count && i < shown; i++) {
                int y = 158 + i * rh;
                bool sel = (i == cursor);
                bool chk = board ? g_st.board[i].checked : g_st.files[i].checked;
                if (sel) stroke_rrect(fb, 12, y, PANEL_W - 24, rh - 6, 8, th->ember, th->panel);
                /* the check box */
                if (chk) { fill_rrect(fb, 24, y + 10, 22, 22, 4, th->ok); ctext(fb, F20, 28, y + 9, "✓", th->bg, 0); }
                else stroke_rrect(fb, 24, y + 10, 22, 22, 4, th->muted, sel ? th->panel : th->bg);
                if (board) {
                    int tw = ctext(fb, F24, 58, y + 6, g_st.board[i].title, sel ? th->ember_bright : th->text, 520);
                    char sig[32];
                    snprintf(sig, sizeof(sig), "  — %s", g_st.board[i].sig);
                    ctext(fb, F16, 58 + tw, y + 12, sig, th->muted, PANEL_W - 90 - tw);
                    ctext(fb, F16, 58, y + 40, g_st.board[i].body[0] ? g_st.board[i].body : "(no text)", th->muted,
                          PANEL_W - 90);
                } else {
                    char meta[32];
                    snprintf(meta, sizeof(meta), "%s · %d KB", g_st.files[i].cat, g_st.files[i].size_kb);
                    int mw = font_width(F16, meta);
                    ctext(fb, F24, 58, y + 9, g_st.files[i].name, sel ? th->ember_bright : th->text, PANEL_W - 110 - mw);
                    ctext(fb, F16, PANEL_W - 28 - mw, y + 15, meta, th->muted, 0);
                }
            }
            /* the action row, under the list (the cursor's last stop) */
            bool bar = (cursor >= count);
            int mode = board ? g_st.board_bar_mode : g_st.file_bar_mode;
            static const char *bacts[3] = { "Back up checked → TF card", "Delete checked", "Post a notice" };
            static const char *facts[3] = { "Back up checked → TF card", "Delete checked", "Share the next file from drop/" };
            ctext(fb, F16, 14, 520, "ACTION", th->ember, 0);
            if (bar) stroke_rrect(fb, 12, 542, PANEL_W - 24, 42, 8, th->ember, th->panel);
            else stroke_rrect(fb, 12, 542, PANEL_W - 24, 42, 8, th->border, th->bg);
            char act[96];
            snprintf(act, sizeof(act), "◀  %s  ▶", (board ? bacts : facts)[mode % 3]);
            ctext(fb, F24, 24, 549, act, bar ? th->ember_bright : th->text, PANEL_W - 48);
            char sub[160];
            if (mode == 0) snprintf(sub, sizeof(sub), "%d checked → /roms/ports/stump_r36max/tf_backup/", checked);
            else if (mode == 1) snprintf(sub, sizeof(sub), "asks first · %d checked", checked);
            else if (board) snprintf(sub, sizeof(sub), "next: %s", BOARD_PRESET_TITLES[g_st.board_preset_idx]);
            else snprintf(sub, sizeof(sub), "files waiting in /roms/ports/stump_r36max/drop/");
            ctext(fb, F16, 18, 594, sub, th->muted, PANEL_W - 36);
        } else if (g_st.tab_idx == 3) {
            /* Network: where this Stump is, its Wi-Fi cards and their jobs, the QR code. */
            char now[120], sum[120];
            int n_ap = 0, n_rem = 0;
            for (int i = 0; i < g_st.limb_count; i++) {
                if (strcmp(g_st.limbs[i].job, "ap") == 0) n_ap++;
                if (g_st.limbs[i].remember) n_rem++;
            }
            if (g_st.ap_active) snprintf(now, sizeof(now), "AP %s · %s", g_st.ap_ssid, disp_ip);
            else snprintf(now, sizeof(now), "%.32s · %s", g_st.wifi_count > 0 ? g_st.wifi_list[0].ssid : "no Wi-Fi", disp_ip);
            snprintf(sum, sizeof(sum), "%d Wi-Fi card%s · %d AP%s · Wi-Fi network chosen in EmulationStation",
                     g_st.limb_count, g_st.limb_count == 1 ? "" : "s", n_ap, n_ap == 1 ? "" : "s");
            ctext(fb, F16, 14, 134, "THIS STUMP", th->ember, 0);
            ctext(fb, F24, 14, 154, now, th->text, PANEL_W - 28);
            ctext(fb, F16, 14, 184, sum, th->muted, PANEL_W - 28);

            ctext(fb, F16, 14, 212, "WI-FI CARDS", th->ember, 0);
            static const char *tools[2] = { "Chain secret", "Find Stumps on this network" };
            /* One card per row (name / job / what it's doing), four at a time, scrolling. */
            int lw = 440, rh = 72, vis = 4;
            int first = g_st.wifi_cursor - (vis - 1);
            if (first < 0) first = 0;
            if (first > g_st.limb_count - vis) first = g_st.limb_count > vis ? g_st.limb_count - vis : 0;
            int rows = g_st.limb_count - first < vis ? g_st.limb_count - first : vis;
            if (g_st.limb_count == 0) ctext(fb, F20, 22, 237, "No Wi-Fi card found", th->muted, lw - 20);
            if (first > 0) ctext(fb, F16, lw - 40, 212, "↑ more", th->muted, 0);
            for (int k = 0; k < rows; k++) {
                int row = first + k;
                const LimbItem *l = &g_st.limbs[row];
                int y = 232 + k * rh;
                bool sel = (g_st.wifi_cursor == row);
                if (sel) stroke_rrect(fb, 12, y, lw, rh - 4, 6, th->ember, th->panel);
                int c = limb_shown(row);
                bool pending = (c != limb_current(l));
                char val[48], sub[120];
                if (l->ap_ok && sel) snprintf(val, sizeof(val), "◀ %s ▶", limb_label(l, c));
                else snprintf(val, sizeof(val), "%s", limb_label(l, c));
                uint32_t vc = pending ? th->ember_bright : (strcmp(l->job, "ap") == 0 ? th->ok : th->text);
                ctext(fb, F20, 22, y + 3, l->name, sel ? th->ember_bright : th->text, lw - 30);
                ctext(fb, F20, 22, y + 25, val, vc, lw - 30);
                if (pending) snprintf(sub, sizeof(sub), "A to apply · B to cancel");
                else if (strcmp(l->job, "ap") == 0)
                    snprintf(sub, sizeof(sub), "%d phone%s%s · %s", l->clients, l->clients == 1 ? "" : "s",
                             l->remember ? " · remembered" : "", l->info);
                else if (strcmp(l->job, "lan") == 0)
                    snprintf(sub, sizeof(sub), "%s · %s%s", l->info, l->ap_ok ? "can run an AP" : "no AP mode",
                             l->remember ? " · remembered" : "");
                else snprintf(sub, sizeof(sub), "%s · %s%s", l->driver[0] ? l->driver : l->iface,
                              l->ap_ok ? ((l->bands & 2) ? "AP 2.4/5 GHz" : "AP 2.4 GHz") : "no AP mode",
                              l->remember ? " · remembered" : "");
                ctext(fb, F16, 22, y + 48, sub, pending ? th->ember : th->muted, lw - 30);
            }
            if (first + rows < g_st.limb_count) ctext(fb, F16, lw - 40, 232 + rows * rh - 2, "↓ more", th->muted, 0);
            {
                int y = 232 + (rows > 0 ? rows : 1) * rh + 8;
                bool sel = (g_st.wifi_cursor >= g_st.limb_count);
                if (sel) stroke_rrect(fb, 12, y, lw, 34, 6, th->ember, th->panel);
                char val[64];
                snprintf(val, sizeof(val), "◀ %s ▶", tools[g_st.wifi_bar_mode % 2]);
                int vw = font_width(F20, val);
                ctext(fb, F20, 22, y + 5, "Tool", sel ? th->ember_bright : th->text, lw - 40 - vw);
                ctext(fb, F20, 12 + lw - 10 - vw, y + 5, val, th->muted, 0);
            }

            /* the QR code: the Stump's page, or (X) joining the hotspot */
            int qx0 = 466;
            ctext(fb, F16, qx0, 212, g_st.qr_mode == 1 ? "JOIN THE HOTSPOT" : "OPEN THE STUMP", th->ember, 0);
            int qs = 7, qn = 25 + 4, qbox = qn * qs;
            int qx = qx0 + (240 - qbox) / 2, qy = 234;
            fill_rect(fb, qx, qy, qbox, qbox, 0xFFFFFFFFu);
            for (int rr = 0; rr < 25; rr++)
                for (int cc = 0; cc < 25; cc++)
                    if (g_st.qr_grid[rr][cc]) fill_rect(fb, qx + (cc + 2) * qs, qy + (rr + 2) * qs, qs, qs, 0xFF000000u);
            ctext(fb, F16, qx0 + (240 - font_width(F16, g_st.qr_url)) / 2, qy + qbox + 6, g_st.qr_url, th->muted, 240);

        } else {
            /* Setup: the staged change, apply or revert, the tools, the log. */
            ctext(fb, F16, 14, 134, "NETWORK", th->ember, 0);
            static const char *dtools[4] = { "Scan LAN for Stumps", "Chain secret", "Diagnostics → TF card",
                                             "Restart the Stump" };
            for (int row = 0; row < 5; row++) {
                int y = (row < 4) ? 156 + row * 38 : 362;
                bool sel = (g_st.rev_cursor == row);
                if (sel) stroke_rrect(fb, 12, y, PANEL_W - 24, 34, 6, th->ember, th->panel);
                char lab[32], val[120];
                uint32_t vc = th->muted;
                if (row == 0) {
                    int n_ap = 0;
                    for (int i = 0; i < g_st.limb_count; i++) if (strcmp(g_st.limbs[i].job, "ap") == 0) n_ap++;
                    snprintf(lab, sizeof(lab), "Wi-Fi cards");
                    snprintf(val, sizeof(val), "%d · %d running an AP", g_st.limb_count, n_ap);
                    vc = n_ap > 0 ? th->ok : th->text;
                } else if (row == 1) {
                    snprintf(lab, sizeof(lab), "Wi-Fi");
                    snprintf(val, sizeof(val), "%.32s (set in EmulationStation)",
                             g_st.wifi_count > 0 ? g_st.wifi_list[0].ssid : "none");
                    vc = th->text;
                } else if (row == 2) {
                    snprintf(lab, sizeof(lab), "Chain");
                    if (g_st.chain_has_secret) snprintf(val, sizeof(val), "secret set · id %s", g_st.chain_id);
                    else snprintf(val, sizeof(val), "no secret · set it in /admin");
                    vc = g_st.chain_has_secret ? th->ok : th->muted;
                } else if (row == 3) {
                    snprintf(lab, sizeof(lab), "Jobs");
                    snprintf(val, sizeof(val), "chosen on NETWORK (A to go)");
                    vc = th->muted;
                } else {
                    snprintf(lab, sizeof(lab), "Tool");
                    snprintf(val, sizeof(val), "◀ %s ▶", dtools[g_st.debug_bar_mode % 4]);
                    vc = th->text;
                }
                int vw = font_width(F20, val);
                ctext(fb, F20, 22, y + 5, lab, sel ? th->ember_bright : th->text, 200);
                ctext(fb, F20, PANEL_W - 22 - vw, y + 5, val, vc, PANEL_W - 250);
            }
            ctext(fb, F16, 14, 314, g_st.chain_status_msg, g_st.chain_peers > 0 ? th->ok : th->muted, PANEL_W - 28);
            ctext(fb, F16, 14, 340, "TOOLS", th->ember, 0);

            bool lsel = (g_st.rev_cursor == 5);
            char lh[48];
            snprintf(lh, sizeof(lh), "LOG%s", lsel ? "  ↑↓ scroll" : "");
            ctext(fb, F16, 14, 410, lh, lsel ? th->ember_bright : th->ember, 0);
            if (g_st.debug_log_count == 0) ctext(fb, F16, 14, 434, "nothing yet", th->muted, 0);
            int start = g_st.debug_scroll;
            if (start > g_st.debug_log_count - 1) start = 0;
            for (int i = 0; i < 10 && start + i < g_st.debug_log_count; i++)
                ctext(fb, F16, 14, 434 + i * 23, g_st.debug_logs[start + i], th->text, PANEL_W - 28);
        }

        /* Busy: FireFly's toast, over the top of the panel. */
        if (is_ui_busy()) {
            const char *bmsg = g_st.busy_msg[0] ? g_st.busy_msg : "Working…";
            fill_rrect(fb, 40, 128, PANEL_W - 80, 38, 8, th->ember);
            ctext(fb, F20, 56, 135, bmsg, th->bg, PANEL_W - 112);
        }

        /* Confirm: a panel in the middle, No / Yes. */
        if (g_st.confirm_open) {
            bool apply = (g_st.confirm_type == 3);
            uint32_t tone = apply ? th->ok : th->warn;
            stroke_rrect(fb, 60, 200, PANEL_W - 120, 270, 10, tone, th->panel);
            ctext(fb, F24, 84, 220, apply ? "Change this card's job?" : "Erase what's checked?", tone, PANEL_W - 168);
            ctext(fb, F16, 84, 262, apply ? "This change:" : (g_st.confirm_type == 1 ? "Checked notices:" : "Checked files:"),
                  th->muted, 0);
            ctext(fb, F20, 84, 286, g_st.confirm_label, th->ember_bright, PANEL_W - 168);
            for (int c = 0; c < 2; c++) {
                bool sel = (g_st.confirm_choice == c);
                int bx = 84 + c * 284;
                const char *lbl = c == 0 ? "No, cancel" : (apply ? "Yes, apply" : "Yes, erase");
                uint32_t fillc = c == 0 ? th->ember : tone;
                if (sel) fill_rrect(fb, bx, 380, 268, 54, 8, fillc);
                else stroke_rrect(fb, bx, 380, 268, 54, 8, th->border, th->panel2);
                ctext(fb, F24, bx + (268 - font_width(F24, lbl)) / 2, 392, lbl, sel ? th->bg : th->text, 0);
            }
        }

        /* ---- FireFly's hint bar (firefly/ui/app.py draw_hints) ---- */
        if (g_st.confirm_open) {
            static const char *const ck[3] = { "←→", "A", "B" };
            static const char *const cl[3] = { "choose", "accept", "cancel" };
            draw_hint_bar(fb, th, ck, cl, 3);
        } else if (g_st.tab_idx == 1 || g_st.tab_idx == 2) {
            static const char *const k[6] = { "A", "B", "Y", "X", "↑↓", "L/R" };
            static const char *const l[6] = { "check", "clear", "TF backup", "delete", "move", "tab" };
            draw_hint_bar(fb, th, k, l, 6);
        } else if (g_st.tab_idx == 3) {
            static const char *const k[6] = { "A", "←→", "Y", "X", "↑↓", "L/R" };
            static const char *const l[6] = { "apply", "job", "remember", "QR", "move", "tab" };
            draw_hint_bar(fb, th, k, l, 6);
        } else if (g_st.tab_idx == 4) {
            static const char *const k[6] = { "A", "B", "X", "START", "↑↓", "L/R" };
            static const char *const l[6] = { "do", "back", "scan LAN", "cards", "move", "tab" };
            draw_hint_bar(fb, th, k, l, 6);
        } else {
            static const char *const k[6] = { "A", "Y", "X", "←→", "↑↓", "L/R" };
            static const char *const l[6] = { "do", "keyboard", "/auth", "room", "deck", "tab" };
            draw_hint_bar(fb, th, k, l, 6);
        }

        if (g_st.osk_open) compose_draw(fb, th);

        /* Always publish RGBA buffer to /dev/shm/stump_fb.rgba for FireFly pygame.display.flip() presenter */
        if (shm_rgba) {
            const uint32_t *src = fb;
            uint8_t *dst = shm_rgba;
            for (int i = 0; i < PANEL_W * PANEL_H; i++) {
                uint32_t px = src[i];
                dst[0] = (uint8_t)((px >> 16) & 0xFFu);
                dst[1] = (uint8_t)((px >> 8) & 0xFFu);
                dst[2] = (uint8_t)(px & 0xFFu);
                dst[3] = 0xFFu;
                dst += 4;
            }
        }

        if (tex && fn_UpdateTexture && fn_RenderCopy && fn_RenderPresent) {
            fn_UpdateTexture(tex, NULL, fb, PANEL_W * 4);
            if (fn_RenderClear) fn_RenderClear(ren);
            fn_RenderCopy(ren, tex, NULL, NULL);
            fn_RenderPresent(ren);
        } else if (fb0_map) {
            /* Always mirror 720x720 ARGB8888 pixels into /dev/fb0's CMA buffer so even if the CRTC is on fbdev
             * (or KMSDRM is unavailable), the panel never displays black zeros. Only call FBIOPAN_DISPLAY when
             * not using KMSDRM (--shm) or when STUMP_FB0_PAN=1 is signaled by stump_pygame_display.py. */
            memcpy(fb0_map, fb, fb0_map_len);
            if (!use_shm_only || force_fb0_pan) {
                vinfo.xoffset = 0;
                vinfo.yoffset = 0;
                ioctl(fb_fd, FBIOPAN_DISPLAY, &vinfo);
            }
            if (max_frames == 0) usleep(16000);
        } else {
            if (max_frames == 0) usleep(16000);
        }

        frames++;
        if (frames == 1) {
            fprintf(stderr, "[Stump-R36MAX] First 720x720 frame rendered (%s)!\n", g_st.ver_str);
            fflush(stderr);
        }
        if (max_frames > 0 && frames >= max_frames) {
            fprintf(stderr, "[Stump-R36MAX] Smoke test rendered %d frames cleanly.\n", frames);
            fflush(stderr);
            g_st.running = false;
            break;
        }
    }

    if (audio_started) pthread_join(audio_tid, NULL);
    free(fb);
    if (shm_rgba) munmap(shm_rgba, PANEL_BYTES);
    if (shm_fd >= 0) close(shm_fd);
    if (max_frames == 0) unlink(SHM_FB_FILE);
    if (g_st.udp_sock >= 0) close(g_st.udp_sock);
    if (g_st.ipc_sock >= 0) close(g_st.ipc_sock);
    if (tex && fn_DestroyTexture) fn_DestroyTexture(tex);
    if (ren && fn_DestroyRenderer) fn_DestroyRenderer(ren);
    if (win && fn_DestroyWindow) fn_DestroyWindow(win);
    if (sdl && fn_Quit) fn_Quit();
    if (fb0_map) munmap(fb0_map, fb0_map_len);
    if (fb_fd >= 0) close(fb_fd);
    for (int i = 0; i < 16; i++) {
        if (ev_fds[i] >= 0) close(ev_fds[i]);
    }
    return 0;
}
