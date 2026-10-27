import {
  SR,
  BITS,
  CH,
  N_SLICES,
  N_FRAMES,
  FRAME_W,
  FRAME_H,
  PIXFMT,
  FRAME_BYTES,
  TOTAL_VIDEO_BYTES,
  CHEWER_VERSION,
  LoadedKit,
  KitManifest,
  SequencerStep,
  packRgb565Word,
  chopPcmInto16Slices,
  computeSlicePeaks,
  databendBytesToPcm16,
  classifyFile,
  guessBpm,
  sanitizeKitName,
} from './chewerLogic';

const PREVIEW_W = 160;
const PREVIEW_H = 120;

/**
 * Synthesize realistic drum/breakbeat PCM (44.1kHz mono s16le) so that every kit
 * plays punchy, distinct breakbeat audio slices immediately in Web Audio.
 */
function synthesizeBreakbeatPcm(
  style: 'amen_174' | 'think_160' | 'databend_jpg' | 'glitch_bin',
  durationSec: number
): Int16Array {
  const totalSamples = Math.floor(durationSec * SR);
  const out = new Int16Array(totalSamples);
  const samplesPerSlice = Math.floor(totalSamples / N_SLICES);

  // Classic 16-step Amen / Jungle drum archetype map:
  // K = Kick, S = Snare, H = Hat, G = Ghost snare, R = Ride/Crash, B = Sub/Reese, X = Glitch burst
  const patternMap: Record<typeof style, string[]> = {
    amen_174: ['K', 'K', 'S', 'H', 'H', 'G', 'K', 'S', 'H', 'G', 'K', 'K', 'S', 'H', 'R', 'G'],
    think_160: ['K', 'H', 'S', 'G', 'K', 'K', 'S', 'H', 'G', 'S', 'K', 'H', 'S', 'G', 'H', 'R'],
    databend_jpg: ['B', 'X', 'S', 'X', 'K', 'B', 'S', 'X', 'X', 'G', 'B', 'K', 'S', 'X', 'R', 'X'],
    glitch_bin: ['X', 'K', 'X', 'S', 'X', 'X', 'K', 'S', 'B', 'X', 'K', 'X', 'S', 'X', 'G', 'X'],
  };

  const hits = patternMap[style];
  let lfsr = style === 'glitch_bin' ? 0xace1 : 0x7f3d;

  for (let s = 0; s < N_SLICES; s++) {
    const hit = hits[s % 16];
    const sliceOffset = s * samplesPerSlice;
    for (let i = 0; i < samplesPerSlice; i++) {
      const t = i / SR;
      const envFast = Math.exp(-t * 28);
      const envMed = Math.exp(-t * 14);
      const envSlow = Math.exp(-t * 6);

      // Deterministic pseudo-noise via LFSR
      lfsr = (lfsr >> 1) ^ (-(lfsr & 1) & 0xb400);
      const noise = ((lfsr & 0xffff) / 32768.0) - 1.0;

      let sample = 0;
      if (hit === 'K') {
        // Punchy pitched breakbeat kick + subtle saturation
        const freq = 52 + 135 * Math.exp(-t * 42);
        sample = Math.sin(2 * Math.PI * freq * t) * envMed * 0.92 + noise * envFast * 0.12;
      } else if (hit === 'S') {
        // Crispy Amen snare (body tone + high-passed snare wires)
        const body = Math.sin(2 * Math.PI * (185 + 90 * Math.exp(-t * 35)) * t) * envFast;
        const wires = noise * Math.exp(-t * 15) * 0.78;
        sample = body * 0.55 + wires;
      } else if (hit === 'G') {
        // Ghost snare / shuffle
        const body = Math.sin(2 * Math.PI * 210 * t) * Math.exp(-t * 38);
        sample = (body * 0.3 + noise * Math.exp(-t * 24) * 0.45) * 0.75;
      } else if (hit === 'H') {
        // Closed metallic hi-hat
        const metallic = Math.sin(2 * Math.PI * 3400 * t) * Math.sin(2 * Math.PI * 5100 * t);
        sample = (noise * 0.65 + metallic * 0.35) * Math.exp(-t * 36) * 0.65;
      } else if (hit === 'R') {
        // Jungle ride / crash chop
        const shimmer = Math.sin(2 * Math.PI * 2850 * t) * Math.cos(2 * Math.PI * 4120 * t);
        sample = (noise * 0.55 + shimmer * 0.45) * envSlow * 0.75;
      } else if (hit === 'B') {
        // Reese / Acid databend bass tone
        const f0 = 55 * Math.pow(2, ((s % 5) * 2) / 12);
        const saw1 = 2 * ((t * f0) - Math.floor(0.5 + t * f0));
        const saw2 = 2 * ((t * f0 * 1.012) - Math.floor(0.5 + t * f0 * 1.012));
        sample = Math.tanh((saw1 + saw2) * 1.6) * envSlow * 0.8;
      } else {
        // Industrial PCM byte-glitch burst
        const bitCrush = (((i >> ((s % 3) + 1)) & 0xff) / 128.0) - 1.0;
        const carrier = Math.sin(2 * Math.PI * (120 + (s * 47)) * t);
        sample = (bitCrush * 0.65 + carrier * noise * 0.45) * envMed * 0.85;
      }

      // Soft clip like 16-bit sampler crunch
      const clipped = Math.max(-0.98, Math.min(0.98, Math.tanh(sample * 1.35)));
      out[sliceOffset + i] = Math.floor(clipped * 32767);
    }
  }
  return out;
}

/**
 * Generate 16 RGB565 frames matching the 4 visual pipelines of chewer.py:
 * 1) 'smpte_video' -> SMPTE color bars + timecode/chop overlay
 * 2) 'waveform'    -> High-contrast white-on-black audio slice waveform (showwavespic)
 * 3) 'test_image'  -> Geometric JPEG test card texture with RGB565 scan bars
 * 4) 'raw_glitch'  -> 8-bit grayscale/industrial RGB565 byte-stream texture
 */
function generateRgb565Strip(
  mode: 'smpte_video' | 'waveform' | 'test_image' | 'raw_glitch',
  slicesPcm: Int16Array[]
): Uint16Array[] {
  const frames: Uint16Array[] = [];
  const smpteTop: [number, number, number][] = [
    [192, 192, 192], // White 75%
    [192, 192, 0],   // Yellow
    [0, 192, 192],   // Cyan
    [0, 192, 0],     // Green
    [192, 0, 192],   // Magenta
    [192, 0, 0],     // Red
    [0, 0, 192],     // Blue
  ];
  const smpteMid: [number, number, number][] = [
    [0, 0, 192],
    [19, 19, 19],
    [192, 0, 192],
    [19, 19, 19],
    [0, 192, 192],
    [19, 19, 19],
    [192, 192, 192],
  ];

  for (let f = 0; f < N_FRAMES; f++) {
    const buf = new Uint16Array(PREVIEW_W * PREVIEW_H);
    const slice = slicesPcm[f] || new Int16Array(64);

    if (mode === 'smpte_video') {
      // SMPTE Bars + animated breakbeat phase bar & slice indicator
      const phaseShift = (f * 10) % PREVIEW_W;
      for (let y = 0; y < PREVIEW_H; y++) {
        for (let x = 0; x < PREVIEW_W; x++) {
          const sx = (x + phaseShift) % PREVIEW_W;
          const barIdx = Math.min(6, Math.floor((sx / PREVIEW_W) * 7));
          let r = 0, g = 0, b = 0;
          if (y < PREVIEW_H * 0.67) {
            [r, g, b] = smpteTop[barIdx];
          } else if (y < PREVIEW_H * 0.75) {
            [r, g, b] = smpteMid[barIdx];
          } else {
            // Pluge & sub-bars
            const sub = Math.floor((sx / PREVIEW_W) * 4);
            if (sub === 0) { r = 0; g = 33; b = 76; }
            else if (sub === 1) { r = 255; g = 255; b = 255; }
            else if (sub === 2) { r = 50; g = 0; b = 106; }
            else { r = 19; g = 19; b = 19; }
          }
          // Overlay live slice energy bar across center
          const sampleIdx = Math.floor((x / PREVIEW_W) * slice.length);
          const amp = Math.abs(slice[sampleIdx] || 0) / 32768;
          const waveY = Math.floor(PREVIEW_H * 0.5 + (slice[sampleIdx] / 32768) * (PREVIEW_H * 0.25));
          if (Math.abs(y - waveY) <= 1) {
            r = 255; g = 255; b = 255;
          } else if (y > PREVIEW_H - 14 && x < ((f + 1) / N_FRAMES) * PREVIEW_W) {
            r = Math.min(255, Math.floor(249 * (0.6 + amp * 0.4)));
            g = 115;
            b = 22;
          }
          buf[y * PREVIEW_W + x] = packRgb565Word(r, g, b);
        }
      }
    } else if (mode === 'waveform') {
      // High-contrast monochrome waveform matching ffmpeg showwavespic=s=320x240:colors=0xFFFFFF
      buf.fill(packRgb565Word(8, 11, 18));
      const midY = Math.floor(PREVIEW_H / 2);
      // Center zero-axis reticle
      for (let x = 0; x < PREVIEW_W; x++) {
        buf[midY * PREVIEW_W + x] = packRgb565Word(38, 48, 64);
      }
      const samplesPerCol = Math.max(1, Math.floor(slice.length / PREVIEW_W));
      for (let x = 0; x < PREVIEW_W; x++) {
        let minV = 0;
        let maxV = 0;
        const start = x * samplesPerCol;
        for (let j = 0; j < samplesPerCol && start + j < slice.length; j++) {
          const v = slice[start + j] / 32768;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
        const yTop = Math.max(2, Math.min(PREVIEW_H - 3, Math.floor(midY - maxV * (midY - 6))));
        const yBot = Math.max(2, Math.min(PREVIEW_H - 3, Math.floor(midY - minV * (midY - 6))));
        for (let y = yTop; y <= yBot; y++) {
          const edge = y === yTop || y === yBot;
          buf[y * PREVIEW_W + x] = edge
            ? packRgb565Word(255, 255, 255)
            : packRgb565Word(215, 228, 245);
        }
      }
    } else if (mode === 'test_image') {
      // Test pattern from JPEG texture + databend scan offset per slice
      const cx = PREVIEW_W / 2;
      const cy = PREVIEW_H / 2;
      for (let y = 0; y < PREVIEW_H; y++) {
        for (let x = 0; x < PREVIEW_W; x++) {
          const dx = x - cx;
          const dy = y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const ring = Math.abs(dist - 42) < 3 || Math.abs(dist - 24) < 2;
          const grid = x % 20 === 0 || y % 20 === 0;
          const shift = (x + f * 7) % 32;
          let r = 18, g = 24, b = 34;
          if (ring) {
            r = 249; g = 115; b = 22;
          } else if (grid) {
            r = 56; g = 189; b = 248;
          } else if (Math.abs(dx) < 28 && Math.abs(dy) < 18) {
            r = shift * 8;
            g = 220 - shift * 5;
            b = 140;
          }
          buf[y * PREVIEW_W + x] = packRgb565Word(r, g, b);
        }
      }
    } else {
      // Raw binary 8-bit grayscale RGB565 glitch texture (exact chewer.py frames_from_glitch logic)
      for (let i = 0; i < PREVIEW_W * PREVIEW_H; i++) {
        const sampleVal = slice[(i + f * 313) % slice.length] || 0;
        const byteVal = ( (sampleVal & 0xff) ^ ((i >> 2) + f * 19) ) & 0xff;
        const r5 = byteVal >> 3;
        const g6 = byteVal >> 2;
        const b5 = byteVal >> 3;
        buf[i] = (r5 << 11) | (g6 << 5) | b5;
      }
    }

    frames.push(buf);
  }
  return frames;
}

function buildKitObject(
  id: string,
  name: string,
  sourceFile: string,
  kind: 'video' | 'audio' | 'image' | 'raw',
  audioSrc: 'decoded' | 'databent',
  videoSrc: 'frames' | 'waveform' | 'glitch',
  visualStyle: 'smpte_video' | 'waveform' | 'test_image' | 'raw_glitch',
  pcmData: Int16Array,
  durationSec: number
): LoadedKit {
  const { slices, counts, totalSamples } = chopPcmInto16Slices(pcmData, N_SLICES);
  const sliceFiles = slices.map((_, idx) => `slice_${String(idx).padStart(2, '0')}.wav`);
  const slicePeaks = slices.map((s) => computeSlicePeaks(s, 48));
  const rgb565Frames = generateRgb565Strip(visualStyle, slices);
  const bpm = guessBpm(sourceFile, durationSec);
  const audioBytes = totalSamples * 2 + N_SLICES * 44;

  const manifest: KitManifest = {
    chewer_version: CHEWER_VERSION,
    name,
    source: sourceFile,
    source_type: kind,
    created: '2026-10-27T10:55:00Z',
    audio: {
      sample_rate: SR,
      bits: BITS,
      channels: CH,
      format: 'pcm_s16le',
      container: 'wav',
      slices: N_SLICES,
      slice_files: sliceFiles,
      slice_samples: counts,
      total_samples: totalSamples,
      source_of_audio: audioSrc,
    },
    video: {
      file: 'video.rgb565',
      pixfmt: PIXFMT,
      width: FRAME_W,
      height: FRAME_H,
      frames: N_FRAMES,
      frame_bytes: FRAME_BYTES,
      total_bytes: TOTAL_VIDEO_BYTES,
      source_of_video: videoSrc,
    },
    bpm,
    coupling: {
      slices: N_SLICES,
      frames: N_FRAMES,
      mode: '1:1',
    },
  };

  return {
    id,
    manifest,
    slicesPcm: slices,
    slicePeaks,
    rgb565Frames,
    texWidth: PREVIEW_W,
    texHeight: PREVIEW_H,
    audioSizeKb: Math.round(audioBytes / 1024),
    videoSizeKb: Math.round(TOTAL_VIDEO_BYTES / 1024), // 2400 KB on disk
  };
}

export function createInitialPreloadedKits(): LoadedKit[] {
  // 1. Video Class: SMPTE Bars + 174 BPM Amen Break
  const amenDur = (2 * 4 * 60) / 174; // ~2.758s
  const amenPcm = synthesizeBreakbeatPcm('amen_174', amenDur);
  const kitVideo = buildKitObject(
    'kit-amen-174',
    'amen_smpte_174bpm',
    'amen_smpte_174bpm.mp4',
    'video',
    'decoded',
    'frames',
    'smpte_video',
    amenPcm,
    amenDur
  );

  // 2. Audio Class: 3.0s clip -> inferred 160 BPM + showwavespic waveform strip
  const thinkDur = 3.0; // 160 BPM (2 bars)
  const thinkPcm = synthesizeBreakbeatPcm('think_160', thinkDur);
  const kitAudio = buildKitObject(
    'kit-think-160',
    'classic_break_clip',
    'classic_break_clip.wav',
    'audio',
    'decoded',
    'waveform',
    'waveform',
    thinkPcm,
    thinkDur
  );

  // 3. Image Class: JPEG Test Card -> texture + databent PCM percussion
  const jpgDur = 2.8;
  const jpgPcm = synthesizeBreakbeatPcm('databend_jpg', jpgDur);
  const kitImage = buildKitObject(
    'kit-testcard-jpg',
    'pm5544_test_pattern_170bpm',
    'pm5544_test_pattern_170bpm.jpg',
    'image',
    'databent',
    'frames',
    'test_image',
    jpgPcm,
    jpgDur
  );

  // 4. Raw Class: Arbitrary .bin -> 8-bit RGB565 glitch texture + raw PCM databend
  const binDur = 2.66;
  const binPcm = synthesizeBreakbeatPcm('glitch_bin', binDur);
  const kitRaw = buildKitObject(
    'kit-industrial-bin',
    'rk3326_uboot_dump_180bpm',
    'rk3326_uboot_dump_180bpm.bin',
    'raw',
    'databent',
    'glitch',
    'raw_glitch',
    binPcm,
    binDur
  );

  return [kitVideo, kitAudio, kitImage, kitRaw];
}

/**
 * Grind an arbitrary user-uploaded file or synthetic byte payload into a RAM-ready LoadedKit
 */
export async function chewUserFileIntoKit(
  fileName: string,
  rawBytes: Uint8Array,
  audioCtx?: AudioContext
): Promise<LoadedKit> {
  const stem = fileName.replace(/\.[^.]+$/, '') || fileName;
  const safeName = sanitizeKitName(stem);
  const kind = classifyFile(fileName);

  let pcmData: Int16Array | null = null;
  let audioSrc: 'decoded' | 'databent' = 'databent';
  let durationSec = 2.76;

  if ((kind === 'audio' || kind === 'video') && audioCtx && rawBytes.byteLength > 44) {
    try {
      const copyBuf = rawBytes.buffer.slice(
        rawBytes.byteOffset,
        rawBytes.byteOffset + rawBytes.byteLength
      ) as ArrayBuffer;
      const decoded = await audioCtx.decodeAudioData(copyBuf);
      durationSec = Math.min(4.0, decoded.duration);
      const ch0 = decoded.getChannelData(0);
      const count = Math.min(Math.floor(4.0 * SR), ch0.length);
      pcmData = new Int16Array(count);
      for (let i = 0; i < count; i++) {
        pcmData[i] = Math.max(-32768, Math.min(32767, Math.floor(ch0[i] * 32767)));
      }
      audioSrc = 'decoded';
    } catch {
      pcmData = databendBytesToPcm16(rawBytes);
      audioSrc = 'databent';
    }
  } else {
    pcmData = databendBytesToPcm16(rawBytes);
    audioSrc = 'databent';
  }

  // Ensure audible percussion transients when databending small files
  if (pcmData.length < SR * 0.5) {
    const synthFallback = synthesizeBreakbeatPcm(
      kind === 'video' ? 'amen_174' : kind === 'audio' ? 'think_160' : 'glitch_bin',
      2.76
    );
    const blended = new Int16Array(synthFallback.length);
    for (let i = 0; i < blended.length; i++) {
      const rawSample = pcmData[i % pcmData.length];
      blended[i] = Math.max(-32768, Math.min(32767, Math.floor(synthFallback[i] * 0.65 + rawSample * 0.35)));
    }
    pcmData = blended;
  }

  const videoSrc: 'frames' | 'waveform' | 'glitch' =
    kind === 'video' || kind === 'image' ? 'frames' : kind === 'audio' ? 'waveform' : 'glitch';
  const visualStyle: 'smpte_video' | 'waveform' | 'test_image' | 'raw_glitch' =
    kind === 'video'
      ? 'smpte_video'
      : kind === 'audio'
        ? 'waveform'
        : kind === 'image'
          ? 'test_image'
          : 'raw_glitch';

  return buildKitObject(
    `kit-${Date.now()}`,
    safeName,
    fileName,
    kind,
    audioSrc,
    videoSrc,
    visualStyle,
    pcmData,
    durationSec
  );
}

/**
 * Create default 16-step sequencer patterns (1:1 step -> slice -> frame coupling + jungle variations)
 */
export function createPresetPattern(
  preset: 'linear_1to1' | 'jungle_chop' | 'amen_roll' | 'databend_chaos'
): SequencerStep[] {
  const steps: SequencerStep[] = [];
  for (let i = 0; i < 16; i++) {
    if (preset === 'linear_1to1') {
      steps.push({
        active: true,
        sliceIdx: i,
        pitchSemitones: 0,
        stutter: 1,
        reverse: false,
        shaderFx: 'none',
        velocity: i % 4 === 0 ? 1.0 : 0.85,
      });
    } else if (preset === 'jungle_chop') {
      const sliceMap = [0, 1, 2, 3, 2, 5, 6, 7, 0, 2, 10, 11, 2, 13, 14, 15];
      const stutterMap: (1 | 2 | 3 | 4)[] = [1, 1, 1, 1, 2, 1, 1, 3, 1, 1, 2, 1, 1, 4, 1, 2];
      const fxMap: SequencerStep['shaderFx'][] = [
        'none', 'none', 'rgb_split', 'none',
        'crt', 'none', 'none', 'invert',
        'none', 'rgb_split', 'none', 'none',
        'databend', 'thresh', 'none', 'rgb_split',
      ];
      steps.push({
        active: true,
        sliceIdx: sliceMap[i],
        pitchSemitones: i === 13 ? 3 : i === 7 ? -2 : 0,
        stutter: stutterMap[i],
        reverse: i === 11 || i === 15,
        shaderFx: fxMap[i],
        velocity: i % 4 === 0 ? 1.0 : 0.9,
      });
    } else if (preset === 'amen_roll') {
      const sliceMap = [0, 0, 2, 3, 4, 2, 6, 2, 0, 1, 2, 2, 12, 12, 14, 15];
      steps.push({
        active: true,
        sliceIdx: sliceMap[i],
        pitchSemitones: i >= 12 ? (i - 11) * 2 : 0,
        stutter: i === 6 || i === 11 || i === 15 ? 4 : i === 3 ? 2 : 1,
        reverse: i === 7 || i === 14,
        shaderFx: i >= 12 ? 'rgb_split' : i === 2 || i === 6 ? 'invert' : 'crt',
        velocity: 0.95,
      });
    } else {
      // databend_chaos
      const sliceMap = [15, 2, 9, 0, 12, 7, 2, 14, 4, 11, 2, 8, 13, 1, 6, 15];
      const fxCycle: SequencerStep['shaderFx'][] = ['databend', 'thresh', 'rgb_split', 'invert', 'crt'];
      steps.push({
        active: i !== 5,
        sliceIdx: sliceMap[i],
        pitchSemitones: ((i * 5) % 11) - 5,
        stutter: ((i % 3) + 1) as 1 | 2 | 3,
        reverse: i % 3 === 0,
        shaderFx: fxCycle[i % fxCycle.length],
        velocity: 0.9,
      });
    }
  }
  return steps;
}

/**
 * Encode a 16-bit mono 44.1kHz PCM slice into a standard RIFF WAV Blob for export/download
 */
export function encodePcmSliceToWavBlob(samples: Int16Array): Blob {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true);  // AudioFormat = 1 (PCM)
  view.setUint16(22, CH, true);
  view.setUint32(24, SR, true);
  view.setUint32(28, SR * CH * 2, true);
  view.setUint16(32, CH * 2, true);
  view.setUint16(34, BITS, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i], true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
