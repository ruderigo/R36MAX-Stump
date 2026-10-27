import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFile,
  guessBpm,
  encodeRgb888ToRgb565LE,
  decodeRgb565LEToRgba,
  databendBytesToPcm16,
  chopPcmInto16Slices,
  calculateRamBudget,
  FRAME_BYTES,
  TOTAL_VIDEO_BYTES,
  N_SLICES,
} from './chewerLogic';

test('frame byte constants match locked 320x240 RGB565-LE contract', () => {
  assert.equal(FRAME_BYTES, 153600);
  assert.equal(TOTAL_VIDEO_BYTES, 2457600); // 2400 KB
});

test('classifyFile routes extensions and ffprobe fallbacks identically to chewer.py', () => {
  assert.equal(classifyFile('amen_174bpm.mp4'), 'video');
  assert.equal(classifyFile('think_break.wav'), 'audio');
  assert.equal(classifyFile('test_card.jpg'), 'image');
  assert.equal(classifyFile('firmware_dump.bin'), 'raw');
  assert.equal(classifyFile('mystery_blob', true, true, 2.5), 'video');
  assert.equal(classifyFile('mystery_audio', false, true, 1.2), 'audio');
  assert.equal(classifyFile('mystery_raw', false, false, 0), 'raw');
});

test('guessBpm extracts BPM from filename or infers DnB bar tempo from duration', () => {
  const fromExplicit = guessBpm('amen_break_174bpm.wav', 2.75);
  assert.equal(fromExplicit.value, 174);
  assert.equal(fromExplicit.source, 'filename');

  const fromNumericToken = guessBpm('jungle_chop_165_loop.wav', 2.9);
  assert.equal(fromNumericToken.value, 165);
  assert.equal(fromNumericToken.source, 'filename');

  const fromDuration3s = guessBpm('untitled_clip.wav', 3.0);
  assert.equal(fromDuration3s.value, 160);
  assert.equal(fromDuration3s.source, 'assumed-2bar');
});

test('RGB565-LE encoding and decoding preserves color channels accurately', () => {
  const [lo, hi] = encodeRgb888ToRgb565LE(255, 0, 0);
  // Red: r5=31 (0x1f), shifted << 11 = 0xF800 -> lo=0x00, hi=0xF8
  assert.equal(lo, 0x00);
  assert.equal(hi, 0xf8);

  const [r, g, b, a] = decodeRgb565LEToRgba(lo, hi);
  assert.equal(r, 255);
  assert.equal(g, 0);
  assert.equal(b, 0);
  assert.equal(a, 255);
});

test('chopPcmInto16Slices splits samples evenly and distributes remainder across initial slices', () => {
  const input = new Int16Array(1605);
  for (let i = 0; i < input.length; i++) input[i] = i;
  const { slices, counts, totalSamples } = chopPcmInto16Slices(input, N_SLICES);
  assert.equal(slices.length, 16);
  assert.equal(totalSamples, 1605);
  // 1605 = 16 * 100 + 5 -> first 5 slices have 101 samples, remaining 11 have 100
  assert.equal(counts[0], 101);
  assert.equal(counts[4], 101);
  assert.equal(counts[5], 100);
  assert.equal(counts[15], 100);
  assert.equal(counts.reduce((a, b) => a + b, 0), 1605);
});

test('databendBytesToPcm16 pads odd byte counts and tiles tiny payloads to >= 16 samples', () => {
  const tiny = new Uint8Array([0x10, 0x20, 0x30]);
  const pcm = databendBytesToPcm16(tiny);
  assert.ok(pcm.length >= 16);
});

test('calculateRamBudget accounts for R36MAX 639 MiB usable RAM and /dev/shm budget', () => {
  const report12 = calculateRamBudget(12, 240);
  assert.equal(report12.usableLinuxMiB, 639);
  assert.equal(report12.status, 'Nominal');
  assert.ok(report12.usedShmMiB > 25 && report12.usedShmMiB < 35);
});
