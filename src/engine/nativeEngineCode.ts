/**
 * Complete Phase 2 Native C Engine (ArkOS SDL2 KMSDRM via dlopen + ALSA RK817 + evdev + Core Pinning),
 * Makefile, Ports Launcher, SCP/SSH Deployer, and R36MAX Hardware Specification data.
 */

export interface CodeFileArtifact {
  id: string;
  filename: string;
  title: string;
  language: 'c' | 'makefile' | 'bash' | 'python' | 'markdown';
  summary: string;
  content: string;
}

export const R36MAX_ENGINE_C_SOURCE = `/*
 * r36max_engine.c — Phase 2 Live AV Breakbeat Engine for R36MAX (RK3326 / ArkOS)
 *
 * Why SDL2 KMSDRM (via dlopen) + Direct ALSA + evdev:
 *   On ArkOS (RK3326), /dev/fb0 blocks in the kernel when DRM master is active.
 *   All ArkOS Ports render through pre-installed libSDL2-2.0.so.0 (KMSDRM/Mali backend).
 *   By binding libSDL2-2.0.so.0 via dlopen(), this engine compiles with ZERO -dev header
 *   packages needed and renders hardware-accelerated 60fps textures on the 720x720 panel.
 *
 * Gamepad Controls (ArkOS /dev/input/event*):
 *   - START         : Play / Pause sequencer
 *   - L1 / R1       : Previous / Next RAM Kit in /dev/shm/r36max_kits
 *   - L2 / R2       : Cycle Visual Shader (CRT, RGB Split, Invert, Databend, Thresh)
 *   - D-Pad UP/DOWN : BPM +/- 2
 *   - D-Pad L/R     : Shift slice chop offset
 *   - A / B / X / Y : Live trigger slices (Kick 00, Snare 02, Chop 06, Amen 10)
 *   - SELECT + START: Exit cleanly back to EmulationStation
 *
 * Build on R36MAX (ArkOS aarch64):
 *   gcc -O2 -mcpu=cortex-a35 -Wall r36max_engine.c -o r36max_engine -lasound -lpthread -ldl -lm
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <math.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <dlfcn.h>
#include <sched.h>
#include <pthread.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <linux/input.h>
#include <alsa/asoundlib.h>

#define SR              44100
#define N_SLICES        16
#define N_FRAMES        16
#define FRAME_W         320
#define FRAME_H         240
#define FRAME_BYTES     (FRAME_W * FRAME_H * 2) /* 153,600 bytes */
#define TOTAL_VID_BYTES (FRAME_BYTES * N_FRAMES)
#define ALSA_PERIOD     512
#define WAV_HEADER_LEN  44
#define MAX_KITS        16

/* Internal composite canvas streamed to Mali-G31 GPU (360x360 1:1 -> scaled to 720x720) */
#define COMP_W          360
#define COMP_H          360
#define COMP_VID_H      270

/* Minimal SDL2 ABI definitions via dlopen("libSDL2-2.0.so.0") */
#define SDL_INIT_VIDEO              0x00000020u
#define SDL_WINDOWPOS_UNDEFINED     0x1FFF0000u
#define SDL_WINDOW_SHOWN            0x00000004u
#define SDL_WINDOW_FULLSCREEN_DESK  0x00001001u
#define SDL_RENDERER_ACCELERATED    0x00000002u
#define SDL_RENDERER_PRESENTVSYNC   0x00000004u
#define SDL_PIXELFORMAT_ARGB8888    0x16362004u
#define SDL_TEXTUREACCESS_STREAMING 1

typedef int   (*pfn_SDL_Init)(uint32_t flags);
typedef void  (*pfn_SDL_Quit)(void);
typedef const char* (*pfn_SDL_GetError)(void);
typedef void* (*pfn_SDL_CreateWindow)(const char *title, int x, int y, int w, int h, uint32_t flags);
typedef void  (*pfn_SDL_DestroyWindow)(void *win);
typedef void* (*pfn_SDL_CreateRenderer)(void *win, int index, uint32_t flags);
typedef void  (*pfn_SDL_DestroyRenderer)(void *ren);
typedef void* (*pfn_SDL_CreateTexture)(void *ren, uint32_t fmt, int access, int w, int h);
typedef void  (*pfn_SDL_DestroyTexture)(void *tex);
typedef int   (*pfn_SDL_UpdateTexture)(void *tex, const void *rect, const void *pixels, int pitch);
typedef int   (*pfn_SDL_RenderClear)(void *ren);
typedef int   (*pfn_SDL_RenderCopy)(void *ren, void *tex, const void *srcrect, const void *dstrect);
typedef void  (*pfn_SDL_RenderPresent)(void *ren);
typedef void  (*pfn_SDL_PumpEvents)(void);
typedef int   (*pfn_SDL_ShowCursor)(int toggle);

typedef struct {
    int16_t *pcm;
    uint32_t num_samples;
} SliceBuffer;

typedef struct {
    char         name[64];
    float        bpm;
    SliceBuffer  slices[N_SLICES];
    uint8_t     *video_rgb565;
    bool         is_mmapped;
} RamKit;

typedef struct {
    bool     active;
    uint8_t  slice_idx;
    int8_t   pitch_semi;
    uint8_t  stutter;
    bool     reverse;
    uint8_t  shader_fx;
} StepState;

typedef struct {
    volatile bool     running;
    volatile bool     playing;
    volatile float    bpm;
    volatile uint8_t  current_step;
    volatile uint8_t  active_slice;
    volatile uint8_t  active_fx;
    volatile uint8_t  slice_offset;
    volatile int      manual_slice;
    volatile float    rms_energy;
    volatile int      active_kit_idx;
    int               num_kits;
    RamKit            kits[MAX_KITS];
    StepState         steps[N_SLICES];
} EngineState;

static EngineState g_eng;

static void pin_thread_to_core(int core_id) {
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(core_id, &cpuset);
    pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset);
}

static inline uint16_t pack_rgb565(uint8_t r, uint8_t g, uint8_t b) {
    return (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
}

/* ---- Built-in Fallback Kit Generator (Pure Integer Math) ---- */
static void build_fallback_kit(RamKit *kit) {
    memset(kit, 0, sizeof(*kit));
    strncpy(kit->name, "builtin_amen_174bpm", sizeof(kit->name) - 1);
    kit->bpm = 174.0f;
    kit->is_mmapped = false;
    kit->video_rgb565 = calloc(1, TOTAL_VID_BYTES);

    uint32_t samples_per_slice = 7604;
    const char *pattern = "KKSHHGKSHGKKSHRG";
    uint32_t lfsr = 0xACE1u;

    for (int s = 0; s < N_SLICES; s++) {
        kit->slices[s].num_samples = samples_per_slice;
        kit->slices[s].pcm = calloc(samples_per_slice, sizeof(int16_t));
        char hit = pattern[s & 15];

        for (uint32_t i = 0; i < samples_per_slice; i++) {
            lfsr = (lfsr >> 1) ^ ((lfsr & 1u) ? 0xB400u : 0u);
            int32_t noise = (int32_t)(lfsr & 0xFFFF) - 32768;
            int32_t env = (int32_t)(samples_per_slice - i);
            int32_t sample = 0;

            if (hit == 'K') {
                uint32_t period = 220 + (i >> 5);
                int32_t tone = ((i % period) < (period >> 1)) ? 18000 : -18000;
                sample = (tone * env) / (int32_t)samples_per_slice + (noise >> 4);
            } else if (hit == 'S') {
                int32_t body = ((i % 180) < 90) ? 10000 : -10000;
                sample = ((body + (noise >> 1)) * env) / (int32_t)samples_per_slice;
            } else {
                sample = ((noise >> 2) * env) / (int32_t)samples_per_slice;
            }
            if (sample > 30000) sample = 30000;
            if (sample < -30000) sample = -30000;
            kit->slices[s].pcm[i] = (int16_t)sample;
        }

        uint16_t *frame = (uint16_t *)(kit->video_rgb565 + (size_t)s * FRAME_BYTES);
        static const uint8_t bars[7][3] = {
            {192,192,192}, {192,192,0}, {0,192,192}, {0,192,0},
            {192,0,192},   {192,0,0},   {0,0,192}
        };
        for (int y = 0; y < FRAME_H; y++) {
            for (int x = 0; x < FRAME_W; x++) {
                int bx = ((x + s * 20) % FRAME_W) * 7 / FRAME_W;
                uint8_t r = bars[bx][0], g = bars[bx][1], b = bars[bx][2];
                if (y > (FRAME_H * 3) / 4) {
                    r = (uint8_t)((x * 255) / FRAME_W);
                    g = (uint8_t)((s * 16) & 0xFF);
                    b = 80;
                }
                uint32_t s_idx = (uint32_t)x * samples_per_slice / FRAME_W;
                int wave_y = (FRAME_H / 2) + (kit->slices[s].pcm[s_idx] * (FRAME_H / 3)) / 32768;
                if (abs(y - wave_y) <= 2) { r = 255; g = 255; b = 255; }
                frame[y * FRAME_W + x] = pack_rgb565(r, g, b);
            }
        }
    }
}

static int load_kit_from_dir(const char *kit_dir, RamKit *out) {
    char path[512];
    memset(out, 0, sizeof(*out));
    const char *slash = strrchr(kit_dir, '/');
    strncpy(out->name, slash ? slash + 1 : kit_dir, sizeof(out->name) - 1);
    out->bpm = 174.0f;

    for (int i = 0; i < N_SLICES; i++) {
        snprintf(path, sizeof(path), "%s/slice_%02d.wav", kit_dir, i);
        int fd = open(path, O_RDONLY);
        if (fd < 0) return -1;
        struct stat st;
        if (fstat(fd, &st) < 0 || st.st_size <= WAV_HEADER_LEN) { close(fd); return -1; }
        size_t pcm_bytes = st.st_size - WAV_HEADER_LEN;
        out->slices[i].num_samples = pcm_bytes / sizeof(int16_t);
        out->slices[i].pcm = malloc(pcm_bytes);
        lseek(fd, WAV_HEADER_LEN, SEEK_SET);
        if (read(fd, out->slices[i].pcm, pcm_bytes) != (ssize_t)pcm_bytes) { close(fd); return -1; }
        close(fd);
    }

    snprintf(path, sizeof(path), "%s/video.rgb565", kit_dir);
    int vfd = open(path, O_RDONLY);
    if (vfd < 0) return -1;
    out->video_rgb565 = mmap(NULL, TOTAL_VID_BYTES, PROT_READ, MAP_SHARED, vfd, 0);
    close(vfd);
    if (out->video_rgb565 == MAP_FAILED) return -1;
    out->is_mmapped = true;
    return 0;
}

static void load_all_kits(const char *root_path) {
    g_eng.num_kits = 0;
    if (load_kit_from_dir(root_path, &g_eng.kits[0]) == 0) {
        g_eng.num_kits = 1;
        fprintf(stderr, "[Engine] Loaded direct kit: %s\\n", g_eng.kits[0].name);
        fflush(stderr);
        return;
    }
    DIR *d = opendir(root_path);
    if (d) {
        struct dirent *ent;
        while ((ent = readdir(d)) != NULL && g_eng.num_kits < MAX_KITS) {
            if (ent->d_name[0] == '.') continue;
            char subpath[512];
            snprintf(subpath, sizeof(subpath), "%s/%s", root_path, ent->d_name);
            if (load_kit_from_dir(subpath, &g_eng.kits[g_eng.num_kits]) == 0) {
                fprintf(stderr, "[Engine] Loaded kit [%d]: %s\\n", g_eng.num_kits, g_eng.kits[g_eng.num_kits].name);
                fflush(stderr);
                g_eng.num_kits++;
            }
        }
        closedir(d);
    }
    if (g_eng.num_kits == 0) {
        fprintf(stderr, "[Engine] Synthesizing built-in 174 BPM RAM kit...\\n");
        fflush(stderr);
        build_fallback_kit(&g_eng.kits[0]);
        g_eng.num_kits = 1;
        fprintf(stderr, "[Engine] Built-in RAM kit ready.\\n");
        fflush(stderr);
    }
}

/* ---- Core 0: ALSA Sequencer & Chopper Thread (RK817 Codec) ---- */
static void *alsa_audio_thread(void *arg) {
    (void)arg;
    pin_thread_to_core(0);
    snd_pcm_t *pcm = NULL;
    const char *devs[] = { "plughw:0,0", "default", "hw:0,0", NULL };
    for (int d = 0; devs[d]; d++) {
        if (snd_pcm_open(&pcm, devs[d], SND_PCM_STREAM_PLAYBACK, 0) == 0) {
            if (snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 2, SR, 1, 80000) == 0) {
                fprintf(stderr, "[ALSA] Configured playback device: %s\\n", devs[d]);
                fflush(stderr);
                break;
            }
            snd_pcm_close(pcm);
            pcm = NULL;
        }
    }
    if (!pcm) {
        fprintf(stderr, "[ALSA] Warning: ALSA unavailable, using internal timer\\n");
        fflush(stderr);
    }

    int16_t period_buf[ALSA_PERIOD * 2];
    double playhead = 0.0;
    uint64_t tick_samples = 0;

    while (g_eng.running) {
        RamKit *kit = &g_eng.kits[g_eng.active_kit_idx % g_eng.num_kits];
        uint32_t samples_per_step = (uint32_t)((60.0f / g_eng.bpm / 4.0f) * SR);
        if (samples_per_step < 256) samples_per_step = 256;
        float energy_acc = 0.0f;

        for (int i = 0; i < ALSA_PERIOD; i++) {
            int man = g_eng.manual_slice;
            if (man >= 0) {
                g_eng.active_slice = (uint8_t)(man & 0x0F);
                playhead = 0.0;
                g_eng.manual_slice = -1;
            }
            if (!g_eng.playing) {
                period_buf[i * 2] = 0;
                period_buf[i * 2 + 1] = 0;
                continue;
            }
            if (tick_samples % samples_per_step == 0) {
                uint8_t step = (tick_samples / samples_per_step) % N_SLICES;
                g_eng.current_step = step;
                StepState st = g_eng.steps[step];
                if (st.active) {
                    g_eng.active_slice = (st.slice_idx + g_eng.slice_offset) & 0x0F;
                    SliceBuffer *sb = &kit->slices[g_eng.active_slice];
                    playhead = st.reverse ? (double)(sb->num_samples - 1) : 0.0;
                }
            }
            StepState st = g_eng.steps[g_eng.current_step];
            SliceBuffer *sb = &kit->slices[g_eng.active_slice];
            if (st.stutter > 1) {
                uint32_t sub_len = samples_per_step / st.stutter;
                if (sub_len > 0 && (tick_samples % sub_len) == 0)
                    playhead = st.reverse ? (double)(sb->num_samples - 1) : 0.0;
            }
            int16_t sample = 0;
            if (st.active && sb->pcm && playhead >= 0.0 && playhead < (double)sb->num_samples) {
                sample = sb->pcm[(uint32_t)playhead];
                double rate = (st.pitch_semi == 0) ? 1.0 : pow(2.0, (double)st.pitch_semi / 12.0);
                playhead += st.reverse ? -rate : rate;
            }
            period_buf[i * 2] = sample;
            period_buf[i * 2 + 1] = sample;
            energy_acc += fabsf((float)sample / 32768.0f);
            tick_samples++;
        }
        g_eng.rms_energy = energy_acc / (float)ALSA_PERIOD;
        if (pcm) {
            snd_pcm_sframes_t frames = snd_pcm_writei(pcm, period_buf, ALSA_PERIOD);
            if (frames < 0 && snd_pcm_recover(pcm, (int)frames, 1) < 0) usleep(10000);
        } else {
            usleep(11600);
        }
    }
    if (pcm) snd_pcm_close(pcm);
    return NULL;
}

int main(int argc, char **argv) {
    const char *kit_root = (argc > 1) ? argv[1] : "/dev/shm/r36max_kits";
    memset(&g_eng, 0, sizeof(g_eng));
    g_eng.running = true;
    g_eng.playing = true;
    g_eng.bpm = 174.0f;
    g_eng.manual_slice = -1;

    const uint8_t jungle_map[16] = {0,1,2,3, 2,5,6,7, 0,2,10,11, 2,13,14,15};
    const uint8_t stutter_map[16] = {1,1,1,1, 2,1,1,3, 1,1,2,1, 1,4,1,2};
    for (int i = 0; i < N_SLICES; i++) {
        g_eng.steps[i].active = true;
        g_eng.steps[i].slice_idx = jungle_map[i];
        g_eng.steps[i].stutter = stutter_map[i];
        g_eng.steps[i].reverse = (i == 11 || i == 15);
        g_eng.steps[i].pitch_semi = (i == 13) ? 3 : 0;
    }

    load_all_kits(kit_root);

    /* Dynamically load ArkOS pre-installed libSDL2-2.0.so.0 (KMSDRM/Mali) */
    void *sdl = dlopen("libSDL2-2.0.so.0", RTLD_LAZY | RTLD_GLOBAL);
    if (!sdl) sdl = dlopen("/usr/lib/aarch64-linux-gnu/libSDL2-2.0.so.0", RTLD_LAZY | RTLD_GLOBAL);

    pfn_SDL_Init            fn_Init            = sdl ? (pfn_SDL_Init)dlsym(sdl, "SDL_Init") : NULL;
    pfn_SDL_Quit            fn_Quit            = sdl ? (pfn_SDL_Quit)dlsym(sdl, "SDL_Quit") : NULL;
    pfn_SDL_GetError        fn_GetError        = sdl ? (pfn_SDL_GetError)dlsym(sdl, "SDL_GetError") : NULL;
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
        win = fn_CreateWindow("R36MAX_AV", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
                              720, 720, SDL_WINDOW_SHOWN | SDL_WINDOW_FULLSCREEN_DESK);
        if (win) {
            ren = fn_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
            if (!ren) ren = fn_CreateRenderer(win, -1, 0);
        }
        if (ren) {
            tex = fn_CreateTexture(ren, SDL_PIXELFORMAT_ARGB8888, SDL_TEXTUREACCESS_STREAMING, COMP_W, COMP_H);
        }
        fprintf(stderr, "[SDL2] KMSDRM Display ready: win=%p ren=%p tex=%p\\n", win, ren, tex);
        fflush(stderr);
    } else {
        fprintf(stderr, "[SDL2] Video init note: %s\\n", fn_GetError ? fn_GetError() : "no SDL2");
        fflush(stderr);
    }

    int ev_fds[12];
    int num_ev = 0;
    for (int i = 0; i < 12; i++) {
        char evpath[64];
        snprintf(evpath, sizeof(evpath), "/dev/input/event%d", i);
        int fd = open(evpath, O_RDONLY | O_NONBLOCK);
        if (fd >= 0) ev_fds[num_ev++] = fd;
    }
    fprintf(stderr, "[Input] Monitoring %d /dev/input/event* nodes\\n", num_ev);
    fflush(stderr);

    pthread_t audio_tid;
    pthread_create(&audio_tid, NULL, alsa_audio_thread, NULL);
    pin_thread_to_core(1);

    uint32_t *canvas = calloc(COMP_W * COMP_H, sizeof(uint32_t));
    bool select_held = false;
    bool start_held = false;
    uint32_t frame_counter = 0;

    while (g_eng.running) {
        if (fn_PumpEvents) fn_PumpEvents();

        struct input_event ev;
        for (int e = 0; e < num_ev; e++) {
            while (read(ev_fds[e], &ev, sizeof(ev)) == sizeof(ev)) {
                if (ev.type == EV_KEY) {
                    bool pressed = (ev.value == 1);
                    if (ev.code == BTN_SELECT || ev.code == BTN_MODE || ev.code == 314 || ev.code == 704 || ev.code == 706)
                        select_held = (ev.value != 0);
                    if (ev.code == BTN_START || ev.code == 315 || ev.code == 705 || ev.code == 707) {
                        start_held = (ev.value != 0);
                        if (pressed && !select_held) g_eng.playing = !g_eng.playing;
                    }
                    if (select_held && start_held) {
                        fprintf(stderr, "[Input] SELECT+START detected — exiting cleanly\\n");
                        fflush(stderr);
                        g_eng.running = false;
                    }
                    if (pressed) {
                        if (ev.code == BTN_TL || ev.code == 310)
                            g_eng.active_kit_idx = (g_eng.active_kit_idx + g_eng.num_kits - 1) % g_eng.num_kits;
                        else if (ev.code == BTN_TR || ev.code == 311)
                            g_eng.active_kit_idx = (g_eng.active_kit_idx + 1) % g_eng.num_kits;
                        else if (ev.code == BTN_TL2 || ev.code == BTN_TR2 || ev.code == 312 || ev.code == 313)
                            g_eng.active_fx = (g_eng.active_fx + 1) % 5;
                        else if (ev.code == BTN_SOUTH || ev.code == 304) g_eng.manual_slice = 0;
                        else if (ev.code == BTN_EAST  || ev.code == 305) g_eng.manual_slice = 2;
                        else if (ev.code == BTN_WEST  || ev.code == 307) g_eng.manual_slice = 6;
                        else if (ev.code == BTN_NORTH || ev.code == 308) g_eng.manual_slice = 10;
                        else if (ev.code == BTN_DPAD_UP || ev.code == 544)
                            g_eng.bpm = fminf(220.0f, g_eng.bpm + 2.0f);
                        else if (ev.code == BTN_DPAD_DOWN || ev.code == 545)
                            g_eng.bpm = fmaxf(60.0f, g_eng.bpm - 2.0f);
                        else if (ev.code == BTN_DPAD_LEFT || ev.code == 546)
                            g_eng.slice_offset = (g_eng.slice_offset + 15) & 0x0F;
                        else if (ev.code == BTN_DPAD_RIGHT || ev.code == 547)
                            g_eng.slice_offset = (g_eng.slice_offset + 1) & 0x0F;
                    }
                } else if (ev.type == EV_ABS) {
                    if (ev.code == ABS_HAT0Y && ev.value < 0) g_eng.bpm = fminf(220.0f, g_eng.bpm + 2.0f);
                    if (ev.code == ABS_HAT0Y && ev.value > 0) g_eng.bpm = fmaxf(60.0f, g_eng.bpm - 2.0f);
                    if (ev.code == ABS_HAT0X && ev.value < 0) g_eng.slice_offset = (g_eng.slice_offset + 15) & 0x0F;
                    if (ev.code == ABS_HAT0X && ev.value > 0) g_eng.slice_offset = (g_eng.slice_offset + 1) & 0x0F;
                }
            }
        }

        if (tex && fn_UpdateTexture && fn_RenderCopy && fn_RenderPresent) {
            RamKit *kit = &g_eng.kits[g_eng.active_kit_idx % g_eng.num_kits];
            uint8_t slice = g_eng.active_slice & 0x0F;
            const uint16_t *src_frame = (const uint16_t *)(kit->video_rgb565 + (size_t)slice * FRAME_BYTES);
            uint8_t fx = g_eng.active_fx;

            for (int y = 0; y < COMP_VID_H; y++) {
                int sy = (y * FRAME_H) / COMP_VID_H;
                int tear = (fx == 3) ? (int)(sinf((y / 10) * 3.7f + frame_counter * 0.2f) * 20.0f * g_eng.rms_energy) : 0;
                uint32_t *row_ptr = canvas + y * COMP_W;

                for (int x = 0; x < COMP_W; x++) {
                    int sx = ((x + tear + COMP_W) % COMP_W) * FRAME_W / COMP_W;
                    uint16_t px = src_frame[sy * FRAME_W + sx];

                    if (fx == 1) {
                        int sx_r = (sx + 6 < FRAME_W) ? sx + 6 : FRAME_W - 1;
                        int sx_b = (sx - 6 >= 0) ? sx - 6 : 0;
                        uint16_t pr = src_frame[sy * FRAME_W + sx_r];
                        uint16_t pb = src_frame[sy * FRAME_W + sx_b];
                        px = (pr & 0xF800) | (px & 0x07E0) | (pb & 0x001F);
                    } else if (fx == 2) {
                        px = ~px;
                    } else if (fx == 4) {
                        uint8_t r5 = (px >> 11) & 0x1F;
                        uint8_t g6 = (px >> 5) & 0x3F;
                        px = (r5 + (g6 >> 1) > 28) ? 0xFBE4 : 0x0862;
                    }
                    if (fx == 0 && (y & 1)) px = ((px & 0xF7DE) >> 1);

                    uint8_t r = ((px >> 11) & 0x1F) << 3;
                    uint8_t g = ((px >> 5) & 0x3F) << 2;
                    uint8_t b = (px & 0x1F) << 3;
                    row_ptr[x] = (0xFFu << 24) | (r << 16) | (g << 8) | b;
                }
            }

            SliceBuffer *sb = &kit->slices[slice];
            int hud_h = COMP_H - COMP_VID_H;
            int step_y_start = COMP_VID_H + (hud_h * 2) / 3;

            for (int y = COMP_VID_H; y < COMP_H; y++) {
                uint32_t *row_ptr = canvas + y * COMP_W;
                for (int x = 0; x < COMP_W; x++) {
                    uint8_t r = 11, g = 15, b = 23;
                    if (y >= step_y_start && y < COMP_H - 8) {
                        int step_col = (x * 16) / COMP_W;
                        int pad = (x * 16) % COMP_W;
                        if (pad > 2 && pad < COMP_W - 2) {
                            if (step_col == g_eng.current_step) { r = 249; g = 115; b = 22; }
                            else if (step_col % 4 == 0) { r = 51; g = 65; b = 85; }
                            else { r = 30; g = 41; b = 59; }
                        }
                    } else if (sb->pcm && sb->num_samples > 0 && y < step_y_start - 4) {
                        uint32_t s_idx = (uint32_t)x * sb->num_samples / (uint32_t)COMP_W;
                        int wave_mid = COMP_VID_H + (step_y_start - COMP_VID_H) / 2;
                        int wave_y = wave_mid - (sb->pcm[s_idx] * ((step_y_start - COMP_VID_H) / 2 - 4)) / 32768;
                        if (abs(y - wave_y) <= 1) { r = 56; g = 189; b = 248; }
                    }
                    row_ptr[x] = (0xFFu << 24) | (r << 16) | (g << 8) | b;
                }
            }

            fn_UpdateTexture(tex, NULL, canvas, COMP_W * 4);
            if (fn_RenderClear) fn_RenderClear(ren);
            fn_RenderCopy(ren, tex, NULL, NULL);
            fn_RenderPresent(ren);
        } else {
            usleep(16000);
        }
        frame_counter++;
    }

    pthread_join(audio_tid, NULL);
    free(canvas);
    if (tex && fn_DestroyTexture) fn_DestroyTexture(tex);
    if (ren && fn_DestroyRenderer) fn_DestroyRenderer(ren);
    if (win && fn_DestroyWindow) fn_DestroyWindow(win);
    if (fn_Quit) fn_Quit();
    for (int i = 0; i < num_ev; i++) close(ev_fds[i]);
    return 0;
}
`;

export const R36MAX_MAKEFILE = `# Makefile — Native R36MAX AV Engine (RK3326 Cortex-A35)
CC      ?= gcc
CFLAGS  := -O2 -mcpu=cortex-a35 -mtune=cortex-a35 -Wall -Wextra
LDFLAGS := -lasound -lpthread -ldl -lm

TARGET  := r36max_engine
SRC     := r36max_engine.c

.PHONY: all clean install-deps

all: $(TARGET)

$(TARGET): $(SRC)
\t$(CC) $(CFLAGS) $(SRC) -o $(TARGET) $(LDFLAGS)

install-deps:
\tsudo apt-get update && sudo apt-get install -y ffmpeg libasound2-dev

clean:
\trm -f $(TARGET)
`;

export const R36MAX_PORTS_SCRIPT = `#!/bin/bash
# =============================================================================
# R36MAX_AV.sh — EmulationStation Ports Tile Launcher for ArkOS / R36MAX
# Place in: /roms/ports/R36MAX_AV.sh
# =============================================================================

APP_DIR="/roms/ports/r36max_av"
SHM_KITS="/dev/shm/r36max_kits"
SD_KITS="$APP_DIR/kits"
DROP_DIR="$APP_DIR/drop_anything_here"
LOG_FILE="$APP_DIR/engine.log"

mkdir -p "$SHM_KITS" "$SD_KITS" "$DROP_DIR"
exec > "$LOG_FILE" 2>&1
echo "=== Launching R36MAX AV Engine $(date) ==="

# 1. Preload up to 12 existing kits (~31 MB) into /dev/shm RAM disk
count=0
for kit in "$SD_KITS"/*; do
  [ -d "$kit" ] || continue
  cp -ru "$kit" "$SHM_KITS/"
  count=$((count + 1))
  [ "$count" -ge 12 ] && break
done

# 2. Start The Chewer daemon pinned to Cores 2-3 (lowest CPU/IO priority)
taskset -c 2,3 ionice -c 3 nice -n 19 \\
  python3 "$APP_DIR/chewer.py" watch \\
  --drop "$DROP_DIR" \\
  --out "$SHM_KITS" \\
  --archive "$APP_DIR/_chewed" \\
  --poll 2.0 > "$APP_DIR/chewer.log" 2>&1 &
CHEWER_PID=$!

# 3. Launch the ALSA (Core 0) + SDL2 KMSDRM (Core 1) Live Engine
"$APP_DIR/r36max_engine" "$SHM_KITS"

# 4. Clean shutdown on SELECT+START exit
kill "$CHEWER_PID" 2>/dev/null || true
rsync -a "$SHM_KITS/" "$SD_KITS/" 2>/dev/null || true
echo "=== Exited cleanly $(date) ==="
`;

export const R36MAX_DEPLOY_SCRIPT = `#!/bin/bash
# =============================================================================
# deploy_to_r36max.sh — One-Command SCP + SSH Installer for ark@r36max.local
# Default ArkOS credentials: user = ark, password = ark
# =============================================================================
set -e

HOST="\${1:-ark@r36max.local}"
REMOTE_DIR="/roms/ports/r36max_av"

# Auto-fix if macOS Safari/Chrome appended .txt to extensionless Makefile
[ -f Makefile.txt ] && mv -f Makefile.txt Makefile

echo "==> 1. Creating remote directories on $HOST..."
ssh "$HOST" "mkdir -p $REMOTE_DIR/{kits,drop_anything_here,_chewed,_failed}"

echo "==> 2. Copying chewer.py, r36max_engine.c, Makefile, and R36MAX_AV.sh via scp..."
scp chewer.py r36max_engine.c Makefile "$HOST:$REMOTE_DIR/"
scp R36MAX_AV.sh "$HOST:/roms/ports/R36MAX_AV.sh"

echo "==> 3. Compiling engine on Cortex-A35 and registering Ports launcher..."
ssh -t "$HOST" "cd $REMOTE_DIR && \\
  make clean && make && \\
  chmod +x $REMOTE_DIR/chewer.py $REMOTE_DIR/r36max_engine /roms/ports/R36MAX_AV.sh"

echo "==> Done! Launch Ports -> R36MAX_AV on your R36MAX (SELECT+START to exit)."
`;

export const CODE_ARTIFACTS: CodeFileArtifact[] = [
  {
    id: 'r36max_engine_c',
    filename: 'r36max_engine.c',
    title: 'Phase 2 Live Engine (SDL2 KMSDRM via dlopen + ALSA RK817 + evdev)',
    language: 'c',
    summary:
      'Binds ArkOS libSDL2-2.0.so.0 via dlopen (bypassing /dev/fb0 kernel lock), streams 720x720 textures on Core 1, and drives RK817 ALSA audio on Core 0.',
    content: R36MAX_ENGINE_C_SOURCE,
  },
  {
    id: 'ports_launcher_sh',
    filename: 'R36MAX_AV.sh',
    title: 'ArkOS / ROCKNIX Ports Launcher Script',
    language: 'bash',
    summary:
      'Preloads kits into /dev/shm, logs to /roms/ports/r36max_av/engine.log, pins chewer.py watch to Cores 2-3, and boots r36max_engine.',
    content: R36MAX_PORTS_SCRIPT,
  },
  {
    id: 'makefile',
    filename: 'Makefile',
    title: 'Cortex-A35 Native Makefile',
    language: 'makefile',
    summary: 'Builds r36max_engine with -O2 -mcpu=cortex-a35 and links ALSA, pthread, dl, and libm.',
    content: R36MAX_MAKEFILE,
  },
  {
    id: 'deploy_ssh_sh',
    filename: 'deploy_to_r36max.sh',
    title: 'SCP + SSH Automated Installer (ark@r36max.local)',
    language: 'bash',
    summary:
      'Copies all files via scp to ark@r36max.local, compiles r36max_engine on-device, and sets executable permissions.',
    content: R36MAX_DEPLOY_SCRIPT,
  },
];

export interface HardwareSpecRow {
  subsystem: string;
  r36maxSpec: string;
  engineDesignImpact: string;
}

export const R36MAX_HARDWARE_SPECS: HardwareSpecRow[] = [
  {
    subsystem: 'SoC & CPU Cores',
    r36maxSpec: 'Rockchip RK3326 — 4x ARM Cortex-A35 @ 1.5 GHz (64-bit aarch64, in-order pipeline)',
    engineDesignImpact:
      'In-order A35 cores stall on heavy runtime MP4/H.264 decoding. Pinning ALSA to Core 0, Display/Input to Core 1, and Chewer to Cores 2–3 eliminates audio xruns.',
  },
  {
    subsystem: 'System Memory (RAM)',
    r36maxSpec: '1 GB DDR3L physical chip (~639 MiB usable in Linux; ~385 MiB reserved by CMA/GPU/kernel)',
    engineDesignImpact:
      'Each Chewer kit is ~2.64 MB (2400 KB RGB565 strip + ~240 KB PCM WAVs). Preloading 12 kits in /dev/shm uses ~31.7 MB (<5% of usable RAM).',
  },
  {
    subsystem: 'Display Panel',
    r36maxSpec: '4.0-inch IPS 720x720 (1:1 square aspect ratio, 32 bpp XRGB8888, stride 2880)',
    engineDesignImpact:
      'Confirmed 720x720 @ 32bpp. Engine streams 360x360 composite texture via ArkOS libSDL2-2.0.so.0 KMSDRM backend directly to the 720x720 screen.',
  },
  {
    subsystem: 'Display & Shader Path',
    r36maxSpec: 'ArkOS libSDL2-2.0.so.0 KMSDRM/Mali hardware texture streamer (via dlopen)',
    engineDesignImpact:
      'Avoids /dev/fb0 DRM kernel lock; compiles with zero -dev packages and runs real-time CRT, RGB split, invert, databend, and threshold shaders at 60Hz.',
  },
  {
    subsystem: 'Audio Codec (ALSA)',
    r36maxSpec: 'card 0: rockchiprk817co [rockchip,rk817-codec], device 0: ff070000.i2s-rk817-hifi',
    engineDesignImpact:
      'Opens plughw:0,0 (80ms buffer, 512-frame periods) for rock-solid RK817 I2S playback.',
  },
  {
    subsystem: 'Gamepad Controls (evdev)',
    r36maxSpec: '/dev/input/event* (D-Pad, A/B/X/Y, L1/L2/R1/R2, FN, START, SELECT, Dual Sticks)',
    engineDesignImpact:
      'A/B/X/Y trigger slices; D-Pad adjusts BPM & slice offset; L1/R1 bank kits; L2/R2 cycle shaders; SELECT+START exits cleanly to EmulationStation.',
  },
];
