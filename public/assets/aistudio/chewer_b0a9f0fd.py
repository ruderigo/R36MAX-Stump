#!/usr/bin/env python3
# =============================================================================
# chewer.py — The Chewer: a universal file grinder for the R36MAX AV breakbeat
# workstation (Team R36MAX).
#
# Drop ANY file into the watched folder and the Chewer grinds it, ahead of
# time, into a RAM-ready "kit": 16 uncompressed audio slices + a raw video
# texture strip + a manifest. At playback the live engine never decodes — it
# blasts raw bytes from RAM. This is the piece that makes the RK3326 keep up.
#
# One kit, four input classes (ext-first, ffprobe fallback):
#   video  (.mp4/.mkv/.mov/.webm/.avi)  -> rip audio, chop 16; 16 frames 320x240
#   audio  (.mp3/.wav/.m4a/.flac/.ogg)  -> chop 16; per-slice waveform visuals
#   image  (.jpg/.png/.gif/.bmp/.webp)  -> frames as texture; DATABEND bytes->audio
#   raw    (.raw/.bin/.dat/anything)    -> bytes as glitch texture AND as PCM
#
# Output kit (the contract the engine consumes — see README):
#   <out>/<name>/slice_00.wav .. slice_15.wav   16-bit 44.1k mono PCM WAV
#   <out>/<name>/video.rgb565                   N frames of 320x240 RGB565-LE
#   <out>/<name>/kit.json                       manifest
#
# Usage:
#   chewer.py watch [--drop DIR] [--out DIR] [--archive DIR] [--poll SECS]
#   chewer.py chew FILE [--out DIR]
#   chewer.py --help
#
# Needs: ffmpeg + ffprobe, python3.  (No sox / no pip.)
# =============================================================================

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path

# ---- the kit format (locked; the engine depends on these) ------------------
SR = 44100              # sample rate
BITS = 16               # sample width (signed LE)
CH = 1                  # mono
N_SLICES = 16           # audio chops per kit (== step grid)
N_FRAMES = 16           # video frames per kit (1:1 with slices)
FRAME_W = 320
FRAME_H = 240
PIXFMT = "rgb565le"     # 2 bytes/px, direct GL_RGB565 upload
BYTES_PER_PX = 2
FRAME_BYTES = FRAME_W * FRAME_H * BYTES_PER_PX   # 153600
MAX_SECONDS = 4.0       # cap kit audio length (2 bars @174 ~ 2.76s)
CHEWER_VERSION = "1.0"

VIDEO_EXT = {"mp4", "mkv", "mov", "webm", "avi", "m4v", "mpg", "mpeg", "flv", "ts"}
AUDIO_EXT = {"mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma", "aif", "aiff"}
IMAGE_EXT = {"jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff"}
# everything else (raw, bin, dat, hex, or no extension) -> RAW path

# ---- tiny ui ---------------------------------------------------------------
def say(m):  print(m, flush=True)
def step(m): print("==> " + m, flush=True)
def warn(m): print("[!] " + m, flush=True)


def run(cmd, timeout=180):
    """Run a subprocess quietly; return (ok, combined_output)."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (r.returncode == 0, (r.stdout or "") + (r.stderr or ""))
    except FileNotFoundError:
        return (False, f"command not found: {cmd[0]}")
    except subprocess.TimeoutExpired:
        return (False, f"timed out: {' '.join(cmd[:3])}")


def need_tools():
    missing = [t for t in ("ffmpeg", "ffprobe") if shutil.which(t) is None]
    if missing:
        sys.exit("[x] missing tools: %s  (install: sudo apt-get install -y ffmpeg)"
                 % ", ".join(missing))


# ---- probe / classify ------------------------------------------------------
def probe(path):
    ok, out = run(["ffprobe", "-v", "quiet", "-print_format", "json",
                   "-show_format", "-show_streams", str(path)], timeout=60)
    if not ok:
        return None
    try:
        return json.loads(out)
    except Exception:
        return None


def duration_of(info):
    if not info:
        return 0.0
    try:
        d = float(info.get("format", {}).get("duration", 0) or 0)
        if d > 0:
            return d
    except Exception:
        pass
    for s in (info or {}).get("streams", []):
        try:
            d = float(s.get("duration", 0) or 0)
            if d > 0:
                return d
        except Exception:
            pass
    return 0.0


def streams(info, kind):
    return [s for s in (info or {}).get("streams", []) if s.get("codec_type") == kind]


def classify(path, info):
    ext = path.suffix.lower().lstrip(".")
    if ext in IMAGE_EXT:
        return "image"
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    # unknown extension: let the probe decide, else raw bytes
    if info:
        if streams(info, "video") and duration_of(info) > 0.3:
            return "video"
        if streams(info, "audio"):
            return "audio"
    return "raw"


# ---- audio: canonical decode + equal-16 chopping ---------------------------
def decode_audio(src, dst_wav):
    """Decode any media's audio to mono/44.1k/16-bit WAV. False if no audio."""
    ok, _ = run(["ffmpeg", "-y", "-v", "error", "-i", str(src),
                 "-vn", "-ac", str(CH), "-ar", str(SR), "-c:a", "pcm_s16le",
                 "-f", "wav", str(dst_wav)])
    return ok and Path(dst_wav).is_file() and Path(dst_wav).stat().st_size > 44


def write_wav(path, frames_bytes):
    w = wave.open(str(path), "wb")
    w.setnchannels(CH)
    w.setsampwidth(BITS // 8)
    w.setframerate(SR)
    w.writeframes(frames_bytes)
    w.close()


def pcm_from_wav(path):
    w = wave.open(str(path), "rb")
    n = w.getnframes()
    data = w.readframes(n)
    w.close()
    return data  # bytes, mono s16le


def chop_pcm(data, outdir, n=N_SLICES, max_seconds=MAX_SECONDS):
    """Split mono s16le PCM into n equal slices, written as WAVs. Returns
    (slice_files, per_slice_sample_counts, total_samples)."""
    bpf = (BITS // 8) * CH                      # bytes per sample-frame
    total = len(data) // bpf
    cap = int(max_seconds * SR)
    if total > cap:
        total = cap
        data = data[:total * bpf]
    if total < n:                               # too short: pad with silence
        pad = (n - total) * bpf
        data = data + (b"\x00" * pad)
        total = n
    base = total // n
    rem = total - base * n
    files, counts = [], []
    pos = 0
    for i in range(n):
        cnt = base + (1 if i < rem else 0)
        chunk = data[pos * bpf:(pos + cnt) * bpf]
        pos += cnt
        fn = outdir / ("slice_%02d.wav" % i)
        write_wav(fn, chunk)
        files.append(fn.name)
        counts.append(cnt)
    return files, counts, total


def databend_to_pcm(src_path, max_seconds=MAX_SECONDS):
    """Read a file's raw bytes and reinterpret them as mono s16le PCM — the
    'crunchy industrial' databend. Caps length; pads to even bytes."""
    raw = Path(src_path).read_bytes()
    cap = int(max_seconds * SR) * (BITS // 8)
    if len(raw) > cap:
        raw = raw[:cap]
    if len(raw) % 2:
        raw += b"\x00"
    if len(raw) < (BITS // 8) * N_SLICES:       # tiny file: tile it up a bit
        raw = (raw * (1 + ((BITS // 8) * N_SLICES) // max(1, len(raw))))
    return raw


# ---- video: frame extraction / generation -> video.rgb565 ------------------
def _normalize_frames(raw_bytes):
    """Force a raw rgb565 blob to exactly N_FRAMES frames (repeat last / pad /
    truncate)."""
    got = len(raw_bytes) // FRAME_BYTES
    if got == 0:
        return b"\x00" * (FRAME_BYTES * N_FRAMES)          # all black
    frames = [raw_bytes[i * FRAME_BYTES:(i + 1) * FRAME_BYTES] for i in range(got)]
    if got < N_FRAMES:
        frames += [frames[-1]] * (N_FRAMES - got)
    return b"".join(frames[:N_FRAMES])


_VF_FIT = ("scale=%d:%d:force_original_aspect_ratio=decrease,"
           "pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black,format=%s"
           % (FRAME_W, FRAME_H, FRAME_W, FRAME_H, PIXFMT))


def frames_from_video(src, dur, outpath):
    """Pull N_FRAMES evenly across the clip into a single rgb565 strip."""
    fps = max(0.1, N_FRAMES / dur) if dur > 0 else float(N_FRAMES)
    vf = "fps=%.6f,%s" % (fps, _VF_FIT)
    ok, out = run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-an",
                   "-vf", vf, "-frames:v", str(N_FRAMES), "-f", "rawvideo",
                   str(outpath)])
    if not ok or not Path(outpath).is_file():
        return False
    data = _normalize_frames(Path(outpath).read_bytes())
    Path(outpath).write_bytes(data)
    return True


def frames_from_image(src, info, outpath):
    """Static image -> one frame replicated; animated (gif) -> spread frames."""
    nb = 0
    for s in streams(info, "video"):
        try:
            nb = max(nb, int(s.get("nb_frames", 0) or 0))
        except Exception:
            pass
    dur = duration_of(info)
    if nb > 1 and dur > 0:                        # animated: treat like video
        return frames_from_video(src, dur, outpath)
    ok, _ = run(["ffmpeg", "-y", "-v", "error", "-i", str(src),
                 "-vf", _VF_FIT, "-frames:v", "1", "-f", "rawvideo", str(outpath)])
    if not ok or not Path(outpath).is_file():
        return False
    one = Path(outpath).read_bytes()[:FRAME_BYTES]
    if len(one) < FRAME_BYTES:
        one = (one + b"\x00" * FRAME_BYTES)[:FRAME_BYTES]
    Path(outpath).write_bytes(one * N_FRAMES)
    return True


def frames_from_waveforms(slice_files, kitdir, outpath):
    """One high-contrast waveform image per audio slice -> rgb565 strip."""
    blob = bytearray()
    tmp = kitdir / "_wf.raw"
    for sf in slice_files:
        ok, _ = run(["ffmpeg", "-y", "-v", "error", "-i", str(kitdir / sf),
                     "-filter_complex",
                     "aformat=channel_layouts=mono,"
                     "showwavespic=s=%dx%d:colors=0xFFFFFF,format=%s"
                     % (FRAME_W, FRAME_H, PIXFMT),
                     "-frames:v", "1", "-f", "rawvideo", str(tmp)])
        if ok and tmp.is_file():
            f = tmp.read_bytes()[:FRAME_BYTES]
            f = (f + b"\x00" * FRAME_BYTES)[:FRAME_BYTES]
        else:
            f = b"\x00" * FRAME_BYTES
        blob += f
    tmp.unlink(missing_ok=True)
    outpath.write_bytes(bytes(blob))
    return True


def frames_from_glitch(src_path, outpath):
    """Reinterpret a file's bytes as an 8-bit glitch texture -> rgb565 strip."""
    raw = Path(src_path).read_bytes()
    need = FRAME_W * FRAME_H * N_FRAMES
    if not raw:
        outpath.write_bytes(b"\x00" * (FRAME_BYTES * N_FRAMES))
        return True
    if len(raw) < need:                           # tile to fill
        raw = raw * (1 + need // len(raw))
    raw = raw[:need]
    # byte -> grayscale rgb565 (little-endian)
    out = bytearray(need * 2)
    for i, b in enumerate(raw):
        r5 = b >> 3
        g6 = b >> 2
        b5 = b >> 3
        px = (r5 << 11) | (g6 << 5) | b5
        out[i * 2] = px & 0xFF
        out[i * 2 + 1] = (px >> 8) & 0xFF
    outpath.write_bytes(bytes(out))
    return True


# ---- bpm guess -------------------------------------------------------------
def guess_bpm(name, dur):
    m = re.search(r"(?:^|[_\-\s])(\d{2,3})\s*bpm", name, re.I)
    if not m:
        m = re.search(r"(?:^|[_\-\s])(1[0-9]{2}|[7-9][0-9])(?:[_\-\s.]|$)", name)
    if m:
        v = int(m.group(1))
        if 60 <= v <= 220:
            return {"value": float(v), "source": "filename"}
    if dur and dur > 0.1:
        for bars in (1, 2, 4, 8):                 # pick bars landing in DnB range
            bpm = bars * 4 * 60.0 / dur
            if 150 <= bpm <= 185:
                return {"value": round(bpm, 1), "source": "assumed-%dbar" % bars}
        for bars in (1, 2, 4, 8):
            bpm = bars * 4 * 60.0 / dur
            if 85 <= bpm <= 185:
                return {"value": round(bpm, 1), "source": "assumed-%dbar" % bars}
        return {"value": round(4 * 60.0 / dur, 1), "source": "assumed-1bar"}
    return {"value": None, "source": None}


# ---- the grind -------------------------------------------------------------
def sanitize(stem):
    s = re.sub(r"[^A-Za-z0-9._-]", "_", stem).strip("._") or "kit"
    return s[:48]


def unique_dir(out, name):
    d = out / name
    i = 2
    while d.exists():
        d = out / ("%s-%d" % (name, i))
        i += 1
    return d


def chew(src, out):
    src = Path(src)
    if not src.is_file():
        warn("not a file: %s" % src)
        return None
    info = probe(src)
    kind = classify(src, info)
    dur = duration_of(info)
    name = sanitize(src.stem)
    kitdir = unique_dir(Path(out), name)
    kitdir.mkdir(parents=True, exist_ok=True)
    step("chewing %s  (%s, %.2fs)  ->  %s/" % (src.name, kind, dur, kitdir.name))

    audio_src = "decoded"
    video_src = "frames"
    tmpwav = kitdir / "_decoded.wav"

    # ---- audio slices ----
    if kind in ("audio", "video"):
        if decode_audio(src, tmpwav):
            data = pcm_from_wav(tmpwav)
        else:                                     # video with no audio track
            warn("no audio track — databending the file bytes for sound")
            data = databend_to_pcm(src)
            audio_src = "databent"
    else:                                         # image / raw -> databend
        data = databend_to_pcm(src)
        audio_src = "databent"
    slice_files, counts, total = chop_pcm(data, kitdir)
    tmpwav.unlink(missing_ok=True)

    # ---- video strip ----
    vpath = kitdir / "video.rgb565"
    if kind == "video":
        if not frames_from_video(src, dur, vpath):
            warn("frame extraction failed — using waveforms")
            frames_from_waveforms(slice_files, kitdir, vpath); video_src = "waveform"
    elif kind == "image":
        if frames_from_image(src, info, vpath):
            video_src = "frames"
        else:
            frames_from_glitch(src, vpath); video_src = "glitch"
    elif kind == "audio":
        frames_from_waveforms(slice_files, kitdir, vpath); video_src = "waveform"
    else:                                         # raw
        frames_from_glitch(src, vpath); video_src = "glitch"

    # ---- manifest ----
    manifest = {
        "chewer_version": CHEWER_VERSION,
        "name": name,
        "source": src.name,
        "source_type": kind,
        "created": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "audio": {
            "sample_rate": SR, "bits": BITS, "channels": CH,
            "format": "pcm_s16le", "container": "wav",
            "slices": N_SLICES, "slice_files": slice_files,
            "slice_samples": counts, "total_samples": total,
            "source_of_audio": audio_src,
        },
        "video": {
            "file": "video.rgb565", "pixfmt": PIXFMT,
            "width": FRAME_W, "height": FRAME_H, "frames": N_FRAMES,
            "frame_bytes": FRAME_BYTES, "total_bytes": FRAME_BYTES * N_FRAMES,
            "source_of_video": video_src,
        },
        "bpm": guess_bpm(src.name, dur),
        "coupling": {"slices": N_SLICES, "frames": N_FRAMES, "mode": "1:1"},
    }
    (kitdir / "kit.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    kb = sum((kitdir / f).stat().st_size for f in slice_files) / 1024
    vkb = vpath.stat().st_size / 1024 if vpath.is_file() else 0
    say("    OK: %d slices (%.0f KB audio) + %d frames (%.0f KB video)  bpm=%s"
        % (N_SLICES, kb, N_FRAMES, vkb, manifest["bpm"]["value"]))
    return kitdir


# ---- watch daemon ----------------------------------------------------------
def _stable(path, prev):
    """True once a file's size has stopped changing (finished copying)."""
    try:
        sz = path.stat().st_size
    except OSError:
        return False
    return prev.get(path.name) == sz and sz > 0


def watch(drop, out, archive, failed, poll):
    drop, out = Path(drop), Path(out)
    archive, failed = Path(archive), Path(failed)
    for d in (drop, out, archive, failed):
        d.mkdir(parents=True, exist_ok=True)
    say("Chewer watching: %s" % drop)
    say("  kits -> %s   archive -> %s   (poll %.1fs, Ctrl-C to stop)"
        % (out, archive, poll))
    sizes = {}
    try:
        while True:
            entries = [p for p in sorted(drop.iterdir())
                       if p.is_file() and not p.name.startswith(".")]
            for p in entries:
                if not _stable(p, sizes):         # wait until the copy settles
                    try:
                        sizes[p.name] = p.stat().st_size
                    except OSError:
                        pass
                    continue
                try:
                    kit = chew(p, out)
                    dest = (archive if kit else failed) / p.name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(p), str(dest))
                except Exception as e:
                    warn("failed on %s: %s" % (p.name, e))
                    try:
                        shutil.move(str(p), str(failed / p.name))
                    except Exception:
                        pass
                sizes.pop(p.name, None)
            time.sleep(poll)
    except KeyboardInterrupt:
        say("\nChewer stopped.")


# ---- cli -------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(prog="chewer.py", description="The Chewer — universal file grinder for the R36MAX AV workstation.")
    sub = ap.add_subparsers(dest="cmd")

    base = Path(os.environ.get("CHEWER_BASE", str(Path.home() / "chewer")))
    w = sub.add_parser("watch", help="watch a folder and grind what lands in it")
    w.add_argument("--drop", default=str(base / "drop_anything_here"))
    w.add_argument("--out", default=str(base / "kits"))
    w.add_argument("--archive", default=str(base / "_chewed"))
    w.add_argument("--failed", default=str(base / "_failed"))
    w.add_argument("--poll", type=float, default=2.0)

    c = sub.add_parser("chew", help="grind a single file now")
    c.add_argument("file")
    c.add_argument("--out", default=str(base / "kits"))

    args = ap.parse_args()
    need_tools()
    if args.cmd == "chew":
        Path(args.out).mkdir(parents=True, exist_ok=True)
        ok = chew(args.file, args.out)
        sys.exit(0 if ok else 1)
    elif args.cmd == "watch":
        watch(args.drop, args.out, args.archive, args.failed, args.poll)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
