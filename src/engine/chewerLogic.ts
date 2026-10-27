/**
 * Pure core logic mirroring chewer.py and the R36MAX Live AV Engine contract.
 * Locked contract:
 *  - 16 slices of 16-bit 44.1kHz mono PCM
 *  - 16 frames of 320x240 RGB565-LE (153,600 bytes/frame, 2,457,600 bytes total)
 *  - 1:1 coupling between step, audio slice, and RGB565 video frame
 */

export const SR = 44100;
export const BITS = 16;
export const CH = 1;
export const N_SLICES = 16;
export const N_FRAMES = 16;
export const FRAME_W = 320;
export const FRAME_H = 240;
export const PIXFMT = 'rgb565le';
export const BYTES_PER_PX = 2;
export const FRAME_BYTES = FRAME_W * FRAME_H * BYTES_PER_PX; // 153,600 bytes
export const TOTAL_VIDEO_BYTES = FRAME_BYTES * N_FRAMES; // 2,457,600 bytes (2400 KB)
export const MAX_SECONDS = 4.0;
export const CHEWER_VERSION = '1.0';

// R36MAX Hardware Constants
export const R36MAX_NOMINAL_RAM_MIB = 1024;
export const R36MAX_USABLE_RAM_MIB = 639; // Actual Linux MemTotal after RK3326 CMA/GPU carveout
export const R36MAX_SHM_BUDGET_MIB = 192; // Safe /dev/shm preload ceiling on ArkOS/ROCKNIX

export type SourceKind = 'video' | 'audio' | 'image' | 'raw';
export type AudioSourceMode = 'decoded' | 'databent';
export type VideoSourceMode = 'frames' | 'waveform' | 'glitch';

export interface BpmGuess {
  value: number | null;
  source: string | null;
}

export interface KitManifest {
  chewer_version: string;
  name: string;
  source: string;
  source_type: SourceKind;
  created: string;
  audio: {
    sample_rate: number;
    bits: number;
    channels: number;
    format: 'pcm_s16le';
    container: 'wav';
    slices: number;
    slice_files: string[];
    slice_samples: number[];
    total_samples: number;
    source_of_audio: AudioSourceMode;
  };
  video: {
    file: 'video.rgb565';
    pixfmt: 'rgb565le';
    width: number;
    height: number;
    frames: number;
    frame_bytes: number;
    total_bytes: number;
    source_of_video: VideoSourceMode;
  };
  bpm: BpmGuess;
  coupling: {
    slices: number;
    frames: number;
    mode: '1:1';
  };
}

export interface SequencerStep {
  active: boolean;
  sliceIdx: number; // 0..15 (coupled 1:1 to video frame sliceIdx)
  pitchSemitones: number; // -12..+12
  stutter: 1 | 2 | 3 | 4; // retrig subdivision within step
  reverse: boolean;
  shaderFx: 'none' | 'crt' | 'rgb_split' | 'invert' | 'databend' | 'thresh';
  velocity: number; // 0.1..1.0
}

export interface LoadedKit {
  id: string;
  manifest: KitManifest;
  slicesPcm: Int16Array[]; // 16 slices of mono s16le samples
  slicePeaks: number[][]; // 16 arrays of normalized waveform peaks for UI
  /**
   * Downsampled or full RGB565-LE frame buffers.
   * Each entry is an Uint16Array of RGB565 pixels (width * height) for fast canvas blit.
   */
  rgb565Frames: Uint16Array[];
  texWidth: number;
  texHeight: number;
  audioSizeKb: number;
  videoSizeKb: number;
}

const VIDEO_EXT = new Set(['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'mpg', 'mpeg', 'flv', 'ts']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aif', 'aiff']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff']);

export function sanitizeKitName(stem: string): string {
  const cleaned = stem.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+|[._]+$/g, '') || 'kit';
  return cleaned.slice(0, 48);
}

export function classifyFile(
  filename: string,
  hasVideoStream = false,
  hasAudioStream = false,
  durationSec = 0
): SourceKind {
  const parts = filename.split('.');
  const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (hasVideoStream && durationSec > 0.3) return 'video';
  if (hasAudioStream) return 'audio';
  return 'raw';
}

export function guessBpm(filename: string, durationSec: number): BpmGuess {
  const explicitMatch = filename.match(/(?:^|[_\-\s])(\d{2,3})\s*bpm/i);
  const numberMatch = explicitMatch || filename.match(/(?:^|[_\-\s])(1[0-9]{2}|[7-9][0-9])(?:[_\-\s.]|$)/);
  if (numberMatch) {
    const v = parseInt(numberMatch[1], 10);
    if (v >= 60 && v <= 220) {
      return { value: v, source: 'filename' };
    }
  }
  if (durationSec && durationSec > 0.1) {
    const barOptions = [1, 2, 4, 8];
    for (const bars of barOptions) {
      const bpm = (bars * 4 * 60.0) / durationSec;
      if (bpm >= 150 && bpm <= 185) {
        return { value: Math.round(bpm * 10) / 10, source: `assumed-${bars}bar` };
      }
    }
    for (const bars of barOptions) {
      const bpm = (bars * 4 * 60.0) / durationSec;
      if (bpm >= 85 && bpm <= 185) {
        return { value: Math.round(bpm * 10) / 10, source: `assumed-${bars}bar` };
      }
    }
    return {
      value: Math.round(((4 * 60.0) / durationSec) * 10) / 10,
      source: 'assumed-1bar',
    };
  }
  return { value: null, source: null };
}

/**
 * Pack 8-bit RGB into 16-bit RGB565 little-endian byte pair, identical to chewer.py:
 * r5 = r >> 3; g6 = g >> 2; b5 = b >> 3; px = (r5 << 11) | (g6 << 5) | b5
 */
export function encodeRgb888ToRgb565LE(r: number, g: number, b: number): [number, number] {
  const r5 = (r & 0xff) >> 3;
  const g6 = (g & 0xff) >> 2;
  const b5 = (b & 0xff) >> 3;
  const px = (r5 << 11) | (g6 << 5) | b5;
  return [px & 0xff, (px >> 8) & 0xff];
}

export function packRgb565Word(r: number, g: number, b: number): number {
  const r5 = (r & 0xff) >> 3;
  const g6 = (g & 0xff) >> 2;
  const b5 = (b & 0xff) >> 3;
  return (r5 << 11) | (g6 << 5) | b5;
}

export function decodeRgb565WordToRgb888(px: number): [number, number, number] {
  const r5 = (px >> 11) & 0x1f;
  const g6 = (px >> 5) & 0x3f;
  const b5 = px & 0x1f;
  const r = (r5 << 3) | (r5 >> 2);
  const g = (g6 << 2) | (g6 >> 4);
  const b = (b5 << 3) | (b5 >> 2);
  return [r, g, b];
}

export function decodeRgb565LEToRgba(lowByte: number, highByte: number): [number, number, number, number] {
  const px = (lowByte & 0xff) | ((highByte & 0xff) << 8);
  const [r, g, b] = decodeRgb565WordToRgb888(px);
  return [r, g, b, 255];
}

/**
 * Reinterpret arbitrary file bytes as mono s16le PCM — the crunchy industrial databend from chewer.py
 */
export function databendBytesToPcm16(rawBytes: Uint8Array, maxSeconds = MAX_SECONDS): Int16Array {
  const capBytes = Math.floor(maxSeconds * SR) * 2;
  let len = Math.min(rawBytes.length, capBytes);
  if (len === 0) {
    return new Int16Array(N_SLICES);
  }
  const minBytes = 2 * N_SLICES;
  let working = rawBytes.subarray(0, len);
  if (working.length % 2 !== 0) {
    const padded = new Uint8Array(working.length + 1);
    padded.set(working);
    working = padded;
  }
  if (working.length < minBytes) {
    const repeats = 1 + Math.floor(minBytes / Math.max(1, working.length));
    const tiled = new Uint8Array(working.length * repeats);
    for (let i = 0; i < repeats; i++) {
      tiled.set(working, i * working.length);
    }
    working = tiled;
  }
  const sampleCount = Math.floor(working.length / 2);
  const pcm = new Int16Array(sampleCount);
  const view = new DataView(working.buffer, working.byteOffset, working.byteLength);
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = view.getInt16(i * 2, true);
  }
  return pcm;
}

/**
 * Split mono s16le PCM into 16 equal slices, matching chewer.py chop_pcm() sample-for-sample.
 */
export function chopPcmInto16Slices(
  samples: Int16Array,
  n = N_SLICES,
  maxSeconds = MAX_SECONDS
): { slices: Int16Array[]; counts: number[]; totalSamples: number } {
  const cap = Math.floor(maxSeconds * SR);
  let working = samples.length > cap ? samples.subarray(0, cap) : samples;
  if (working.length < n) {
    const padded = new Int16Array(n);
    padded.set(working);
    working = padded;
  }
  const total = working.length;
  const base = Math.floor(total / n);
  const rem = total - base * n;
  const slices: Int16Array[] = [];
  const counts: number[] = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const cnt = base + (i < rem ? 1 : 0);
    slices.push(working.slice(pos, pos + cnt));
    counts.push(cnt);
    pos += cnt;
  }
  return { slices, counts, totalSamples: total };
}

export function computeSlicePeaks(slice: Int16Array, bins = 48): number[] {
  if (slice.length === 0) return new Array(bins).fill(0);
  const step = Math.max(1, Math.floor(slice.length / bins));
  const peaks: number[] = [];
  for (let b = 0; b < bins; b++) {
    const start = b * step;
    const end = Math.min(slice.length, start + step);
    let maxAbs = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(slice[i]) / 32768;
      if (v > maxAbs) maxAbs = v;
    }
    peaks.push(Math.min(1, Number(maxAbs.toFixed(3))));
  }
  return peaks;
}

export interface RamBudgetReport {
  nominalMiB: number;
  usableLinuxMiB: number;
  shmAllocatedMiB: number;
  kitSizeMiB: number;
  usedShmMiB: number;
  freeShmMiB: number;
  utilizationPct: number;
  status: 'Nominal' | 'Warning' | 'Overflow';
}

export function calculateRamBudget(kitCount: number, avgAudioKb = 240): RamBudgetReport {
  const videoKb = TOTAL_VIDEO_BYTES / 1024; // 2400 KB
  const kitSizeMiB = Number(((videoKb + avgAudioKb) / 1024).toFixed(2)); // ~2.58 MiB
  const usedShmMiB = Number((kitCount * kitSizeMiB).toFixed(2));
  const freeShmMiB = Number(Math.max(0, R36MAX_SHM_BUDGET_MIB - usedShmMiB).toFixed(2));
  const utilizationPct = Number(((usedShmMiB / R36MAX_SHM_BUDGET_MIB) * 100).toFixed(1));
  let status: 'Nominal' | 'Warning' | 'Overflow' = 'Nominal';
  if (usedShmMiB > R36MAX_SHM_BUDGET_MIB) {
    status = 'Overflow';
  } else if (utilizationPct >= 75) {
    status = 'Warning';
  }
  return {
    nominalMiB: R36MAX_NOMINAL_RAM_MIB,
    usableLinuxMiB: R36MAX_USABLE_RAM_MIB,
    shmAllocatedMiB: R36MAX_SHM_BUDGET_MIB,
    kitSizeMiB,
    usedShmMiB,
    freeShmMiB,
    utilizationPct,
    status,
  };
}
