import os
import sys
import time
import mmap
import fcntl
import struct
import signal
import subprocess
import faulthandler

try:
    faulthandler.enable()
except Exception:
    pass

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
os.environ.setdefault("SDL_NOMOUSE", "1")
for _db in ("/opt/inttools/gamecontrollerdb.txt", "/usr/share/gamecontrollerdb.txt"):
    if os.path.exists(_db):
        os.environ.setdefault("SDL_GAMECONTROLLERCONFIG_FILE", _db)
        break


def _prepare_tty1_and_hide_cursor():
    """Disable VT1 fbcon blinking cursor and acquire /dev/tty1 when launched via SSH start_all.sh.
    IMPORTANT: Never call KDSETMODE(KD_TEXT) or FBIOBLANK on /dev/fb0 here — on Rockchip RK3326
    (rockchipdrm), FBIOBLANK restores fbcon and detaches pygame's KMSDRM plane from the CRTC!"""
    try:
        with open("/sys/class/graphics/fbcon/cursor_blink", "w") as f:
            f.write("0\n")
    except Exception:
        pass
    try:
        tfd = os.open("/dev/tty1", os.O_RDWR | os.O_NOCTTY)
        try:
            os.write(tfd, b"\033[?25l\033[9;0]")
        except Exception:
            pass
        try:
            # TIOCSCTTY = 0x540E (acquire controlling terminal if session leader over SSH)
            fcntl.ioctl(tfd, 0x540E, 1)
        except Exception:
            pass
        try:
            # VT_SETMODE = 0x5602, VT_AUTO = 0 (clear stale VT_PROCESS lock if previous process was SIGKILLed)
            fcntl.ioctl(tfd, 0x5602, struct.pack("bbhhh", 0, 0, 0, 0, 0))
        except Exception:
            pass
        try:
            # VT_ACTIVATE = 0x5606 (ensure VT 1 is active)
            fcntl.ioctl(tfd, 0x5606, 1)
        except Exception:
            pass
        os.close(tfd)
    except Exception:
        pass


_prepare_tty1_and_hide_cursor()
import pygame

SHM_PATH = "/dev/shm/stump_fb.rgba"
QUIT_FLAG = "/dev/shm/stump_user_quit"
W, H = 720, 720
FRAME_BYTES = W * H * 4
ROTATIONS = {0: 0, 90: -90, 180: 180, 270: 90}


class Display:
    """Exact FireFly_RK3326_R36MAX_R36S Display wrapper (firefly/ui/display.py)
    with automatic /dev/fb0 hardware scanout fallback if KMSDRM master is busy."""

    def __init__(self, fullscreen=True, window_size=(720, 720), rotation="auto"):
        self.fullscreen = fullscreen
        self.requested_size = window_size
        self.rotation_spec = rotation
        self.rotation = 0
        self.width = window_size[0]
        self.height = window_size[1]
        self._screen = None
        self._canvas = None
        self.kmsdrm_ok = False

    def open(self):
        try:
            if os.environ.get("SDL_VIDEODRIVER") == "dummy":
                os.environ.pop("SDL_VIDEODRIVER", None)
            pygame.display.init()
            # "offscreen" too: SDL's fallback draws into memory, never to the panel.
            if pygame.display.get_driver() in ("dummy", "offscreen"):
                pygame.display.quit()
                os.environ["SDL_VIDEODRIVER"] = "kmsdrm"
                pygame.display.init()
            pygame.font.init()
            flags = pygame.FULLSCREEN if self.fullscreen else 0
            if self.fullscreen:
                info = pygame.display.Info()
                dw = info.current_w or self.requested_size[0]
                dh = info.current_h or self.requested_size[1]
                try:
                    self._screen = pygame.display.set_mode((0, 0), flags)
                    dw, dh = self._screen.get_size()
                except Exception:
                    self._screen = pygame.display.set_mode((dw, dh))
            else:
                dw, dh = self.requested_size
                self._screen = pygame.display.set_mode((dw, dh), flags)

            pygame.display.set_caption("FireFly · Stump v1.8.8-r36max")
            try:
                pygame.mouse.set_visible(False)
            except Exception:
                pass

            self.rotation = self._resolve_rotation(dw, dh)
            if self.rotation in (90, 270):
                self.width, self.height = dh, dw
            else:
                self.width, self.height = dw, dh
            if pygame.display.get_driver() in ("dummy", "offscreen"):
                raise RuntimeError("SDL driver %s doesn't reach the screen" % pygame.display.get_driver())
            self._canvas = pygame.Surface((self.width, self.height))
            # Verify KMSDRM CRTC master by performing an initial page-flip now
            self._screen.fill((27, 21, 18))
            pygame.display.flip()
            self.kmsdrm_ok = True
            os.environ.pop("STUMP_FB0_PAN", None)
            print("[FireFly-Display] KMSDRM display initialized (%dx%d, driver=%s)" % (
                self.width, self.height, pygame.display.get_driver()
            ), flush=True)
        except Exception as e:
            print("[FireFly-Display] KMSDRM set_mode/flip note (%s) — enabling direct /dev/fb0 scanout!" % e, flush=True)
            self.kmsdrm_ok = False
            os.environ["STUMP_FB0_PAN"] = "1"
            try:
                pygame.display.quit()
            except Exception:
                pass
            try:
                pygame.font.init()
            except Exception:
                pass
            self._canvas = pygame.Surface((self.width, self.height))

    def _resolve_rotation(self, dw, dh):
        env = os.environ.get("FIREFLY_ROTATE")
        spec = env if env is not None else self.rotation_spec
        if isinstance(spec, str):
            s = spec.strip().lower()
            if s in ("0", "90", "180", "270"):
                return int(s)
            return 0
        if int(spec) in ROTATIONS:
            return int(spec)
        return 0

    @property
    def surface(self):
        return self._canvas

    def present(self):
        if not self.kmsdrm_ok or self._screen is None:
            return
        try:
            if self.rotation == 0:
                if self._canvas.get_size() != self._screen.get_size():
                    pygame.transform.scale(self._canvas, self._screen.get_size(), self._screen)
                else:
                    self._screen.blit(self._canvas, (0, 0))
            else:
                rotated = pygame.transform.rotate(self._canvas, ROTATIONS[self.rotation])
                if rotated.get_size() != self._screen.get_size():
                    rotated = pygame.transform.smoothscale(rotated, self._screen.get_size())
                self._screen.blit(rotated, (0, 0))
            pygame.display.flip()
        except Exception as e:
            print("[FireFly-Display] flip warning: %s" % e, flush=True)


class Splash:
    """Exact FireFly_RK3326_R36MAX_R36S Boot Splash (firefly/__main__.py)."""

    BG = (27, 21, 18)
    PANEL = (42, 33, 25)
    BORDER = (73, 60, 46)
    EMBER = (240, 160, 80)
    TEXT = (236, 223, 200)
    MUTED = (156, 141, 118)

    def __init__(self, display):
        self.display = display
        font_path = None
        for p in (
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
        ):
            if os.path.exists(p):
                font_path = p
                break
        try:
            self.title_font = pygame.font.Font(font_path, 26)
            self.body_font = pygame.font.Font(font_path, 16)
        except Exception:
            try:
                self.title_font = pygame.font.SysFont("monospace", 24, bold=True)
                self.body_font = pygame.font.SysFont("monospace", 15)
            except Exception:
                self.title_font = None
                self.body_font = None

    def show(self, lines):
        if not self.display.kmsdrm_ok or not self.title_font:
            return
        s = self.display.surface
        w, h = self.display.width, self.display.height
        s.fill(self.BG)
        card = pygame.Rect(24, h // 2 - 110, w - 48, 220)
        pygame.draw.rect(s, self.PANEL, card, border_radius=8)
        pygame.draw.rect(s, self.BORDER, card, width=2, border_radius=8)
        title = self.title_font.render("FireFly · Stump  v1.8.8-r36max", True, self.EMBER)
        s.blit(title, (card.x + 20, card.y + 18))
        y = card.y + 66
        for i, line in enumerate(lines[-5:]):
            color = self.TEXT if i == len(lines[-5:]) - 1 else self.MUTED
            surf = self.body_font.render(str(line)[:54], True, color)
            s.blit(surf, (card.x + 20, y))
            y += 26
        self.display.present()


def _init_joysticks():
    joys = []
    try:
        pygame.joystick.init()
        for i in range(pygame.joystick.get_count()):
            j = pygame.joystick.Joystick(i)
            j.init()
            joys.append(j)
    except Exception:
        pass
    return joys


def _mark_user_quit():
    try:
        with open(QUIT_FLAG, "w") as f:
            f.write("1\n")
    except Exception:
        pass


def main():
    engine_bin = sys.argv[1] if len(sys.argv) > 1 else "/home/ark/stump_r36max/stump_r36max_engine"

    # 1. Open FireFly KMSDRM display FIRST (or fallback cleanly to /dev/fb0) and immediately paint the Amber splash screen
    display = Display(fullscreen=True, window_size=(W, H), rotation="auto")
    display.open()
    splash = Splash(display)
    boot_lines = [
        "Display ready (%dx%d %s)" % (display.width, display.height, "KMSDRM" if display.kmsdrm_ok else "FB0"),
        "Pre-allocating /dev/shm/stump_fb.rgba (720x720 RGBA)...",
    ]
    splash.show(boot_lines)
    joys = _init_joysticks() if display.kmsdrm_ok else []

    # 2. Pre-create writable /dev/shm/stump_fb.rgba with O_RDWR and PROT_READ|PROT_WRITE.
    #    CRITICAL: pygame.image.frombuffer requires a WRITABLE buffer (PyBUF_WRITABLE);
    #    opening O_RDONLY/PROT_READ raises BufferError on every frame!
    fd = os.open(SHM_PATH, os.O_RDWR | os.O_CREAT, 0o666)
    os.ftruncate(fd, FRAME_BYTES)
    shm_map = mmap.mmap(fd, FRAME_BYTES, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE)

    # 3. Spawn stump_r36max_engine --shm as child process (inherits STUMP_FB0_PAN=1 ONLY if KMSDRM was unavailable)
    boot_lines.append("Starting %s --shm ..." % os.path.basename(engine_bin))
    splash.show(boot_lines)
    eng_proc = subprocess.Popen([engine_bin, "--shm"], env=os.environ.copy())

    def _sig_handler(signum, frame):
        try:
            if eng_proc.poll() is None:
                eng_proc.terminate()
        except Exception:
            pass
    signal.signal(signal.SIGTERM, _sig_handler)
    signal.signal(signal.SIGINT, _sig_handler)

    clock = pygame.time.Clock()
    select_down = False
    start_down = False
    first_frame_logged = False

    try:
        while True:
            if eng_proc.poll() is not None:
                break

            if display.kmsdrm_ok:
                for ev in pygame.event.get():
                    if ev.type == pygame.QUIT:
                        _mark_user_quit()
                        eng_proc.terminate()
                        break
                    elif ev.type == pygame.KEYDOWN and ev.key == pygame.K_ESCAPE:
                        _mark_user_quit()
                        eng_proc.terminate()
                        break
                    elif ev.type in (pygame.JOYBUTTONDOWN, pygame.JOYBUTTONUP):
                        down = (ev.type == pygame.JOYBUTTONDOWN)
                        # ArkOS / R36MAX SELECT (6, 8, 10, 12) + START (7, 9, 11, 13)
                        if ev.button in (6, 8, 10, 12):
                            select_down = down
                        elif ev.button in (7, 9, 11, 13):
                            start_down = down
                        if select_down and start_down:
                            _mark_user_quit()
                            eng_proc.terminate()
                            break

                # Also check joystick get_button directly for SELECT+START combo
                for j in joys:
                    try:
                        nb = j.get_numbuttons()
                        if nb >= 8 and j.get_button(6) and j.get_button(7):
                            _mark_user_quit()
                            eng_proc.terminate()
                            break
                        if nb >= 10 and j.get_button(8) and j.get_button(9):
                            _mark_user_quit()
                            eng_proc.terminate()
                            break
                    except Exception:
                        pass

                # Byte 3 is the alpha channel of pixel (0,0), which stump_r36max_engine sets to 0xFF
                if shm_map[3] == 0xFF:
                    try:
                        frame_surf = pygame.image.frombuffer(shm_map, (W, H), "RGBA")
                    except Exception:
                        frame_surf = pygame.image.fromstring(shm_map[:], (W, H), "RGBA")

                    if (display.width, display.height) != (W, H):
                        pygame.transform.scale(frame_surf, (display.width, display.height), display.surface)
                    else:
                        display.surface.blit(frame_surf, (0, 0))
                    display.present()
                    if not first_frame_logged:
                        first_frame_logged = True
                        print("[FireFly-Display] First 720x720 SHM frame presented via pygame.display.flip()!", flush=True)
                else:
                    splash.show(boot_lines)

            clock.tick(30)
    finally:
        try:
            if eng_proc.poll() is None:
                eng_proc.terminate()
                eng_proc.wait(timeout=1.0)
        except Exception:
            try:
                eng_proc.kill()
            except Exception:
                pass
        try:
            shm_map.close()
            os.close(fd)
        except Exception:
            pass
        try:
            if display.kmsdrm_ok:
                pygame.quit()
        except Exception:
            pass
        if os.path.exists(QUIT_FLAG):
            try:
                subprocess.run("killall -CONT emulationstation 2>/dev/null || true", shell=True)
            except Exception:
                pass

    os._exit(0)


if __name__ == "__main__":
    main()
