import React, { useEffect, useRef, useState } from 'react';
import {
  LoadedKit,
  FRAME_BYTES,
  decodeRgb565WordToRgb888,
} from '../engine/chewerLogic';
import { encodePcmSliceToWavBlob } from '../engine/kitFactory';
import { Upload, Download, Play, FileCode, Disc } from 'lucide-react';

interface ChewerInspectorViewProps {
  activeKit: LoadedKit;
  allKits: LoadedKit[];
  activeSlice: number;
  onSelectKit: (kitId: string) => void;
  onTriggerSlice: (sliceIdx: number) => void;
  onChewFile: (fileName: string, bytes: Uint8Array) => Promise<void>;
}

const Rgb565ThumbCanvas: React.FC<{
  frame: Uint16Array;
  texW: number;
  texH: number;
  index: number;
  isSelected: boolean;
  sampleCount: number;
  onClick: () => void;
}> = ({ frame, texW, texH, index, isSelected, sampleCount, onClick }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = ctx.createImageData(texW, texH);
    const dst = img.data;
    for (let i = 0; i < texW * texH; i++) {
      const [r, g, b] = decodeRgb565WordToRgb888(frame[i] || 0);
      const o = i * 4;
      dst[o] = r;
      dst[o + 1] = g;
      dst[o + 2] = b;
      dst[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [frame, texW, texH]);

  const offsetBytes = index * FRAME_BYTES;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-lg p-2 border transition-colors ${
        isSelected
          ? 'bg-slate-800/90 border-orange-500'
          : 'bg-[#0B0F17] border-slate-800 hover:border-slate-700'
      }`}
    >
      <div className="relative aspect-[4/3] w-full rounded overflow-hidden bg-black border border-slate-800 mb-1.5">
        <canvas
          ref={ref}
          width={texW}
          height={texH}
          className="w-full h-full block"
        />
      </div>
      <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-200">
        <span>slice_{String(index).padStart(2, '0')}</span>
        <span className="text-slate-400">#{index}</span>
      </div>
      <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
        off: {offsetBytes.toLocaleString()} B · {sampleCount.toLocaleString()} smp
      </div>
    </button>
  );
};

export const ChewerInspectorView: React.FC<ChewerInspectorViewProps> = ({
  activeKit,
  allKits,
  activeSlice,
  onSelectKit,
  onTriggerSlice,
  onChewFile,
}) => {
  const [isChewing, setIsChewing] = useState(false);
  const [lastChewMessage, setLastChewMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsChewing(true);
    try {
      const buf = await file.arrayBuffer();
      await onChewFile(file.name, new Uint8Array(buf));
      setLastChewMessage(
        `Chewed ${file.name} -> 16 WAV slices + 2400 KB video.rgb565 strip in /dev/shm.`
      );
    } finally {
      setIsChewing(false);
      e.target.value = '';
    }
  };

  const handleSyntheticDrop = async (
    filename: string,
    seedByte: number
  ) => {
    setIsChewing(true);
    try {
      const synthetic = new Uint8Array(16384);
      for (let i = 0; i < synthetic.length; i++) {
        synthetic[i] = ((i * seedByte) ^ (i >> 3)) & 0xff;
      }
      await onChewFile(filename, synthetic);
      setLastChewMessage(
        `Chewed ${filename} -> 16 slices + 16 RGB565 frames (2,457,600 B) loaded into RAM bank.`
      );
    } finally {
      setIsChewing(false);
    }
  };

  const handleDownloadManifest = () => {
    const blob = new Blob([JSON.stringify(activeKit.manifest, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeKit.manifest.name}_kit.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadActiveSliceWav = () => {
    const pcm = activeKit.slicesPcm[activeSlice] || activeKit.slicesPcm[0];
    const wavBlob = encodePcmSliceToWavBlob(pcm);
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeKit.manifest.name}_slice_${String(activeSlice).padStart(2, '0')}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8">
      {/* Section 1: Dropzone & Synthetic Test Grinder */}
      <section className="bg-[#111722] border border-slate-800 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-800">
          <div>
            <h2 className="text-xl font-semibold text-slate-100 font-['Outfit']">
              The Chewer — Ahead-of-Time RAM Kit Grinder
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Drop any video, audio, image, or arbitrary binary file. The Chewer outputs 16 mono 44.1kHz s16le WAV slices, a 16-frame 320×240 RGB565-LE strip (2,400 KB), and a locked kit.json manifest.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileUpload}
              className="hidden"
              aria-label="Upload file to chew into kit"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isChewing}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-orange-600 hover:bg-orange-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Upload className="w-3.5 h-3.5" />
              {isChewing ? 'Grinding Bytes...' : 'Upload File to Chew'}
            </button>
            <button
              type="button"
              onClick={() => handleSyntheticDrop('jungle_break_174bpm.mp4', 37)}
              className="px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              Chew Test Video (174 BPM)
            </button>
            <button
              type="button"
              onClick={() => handleSyntheticDrop('eeprom_glitch_168bpm.bin', 73)}
              className="px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              Chew Raw .bin Databend
            </button>
          </div>
        </div>

        {lastChewMessage && (
          <div
            role="status"
            className="mt-4 px-4 py-2.5 rounded-lg bg-slate-900 border border-slate-700 text-xs font-mono text-emerald-400"
          >
            {lastChewMessage}
          </div>
        )}

        {/* Kit selector bar */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="text-xs font-mono text-slate-400 mr-2">
            /dev/shm/kits ({allKits.length} loaded):
          </span>
          {allKits.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => onSelectKit(k.id)}
              className={`px-3 py-1.5 text-xs font-mono rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                k.id === activeKit.id
                  ? 'bg-slate-100 text-slate-900 border-white font-semibold'
                  : 'bg-[#0B0F17] text-slate-300 border-slate-800 hover:border-slate-700'
              }`}
            >
              {k.manifest.name} · {k.manifest.source_type}
            </button>
          ))}
        </div>
      </section>

      {/* Section 2: 16-Frame RGB565 Contact Sheet + Manifest Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 bg-[#111722] border border-slate-800 rounded-xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-base font-semibold text-slate-100">
                16-Frame Decoded Contact Sheet (video.rgb565)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
                320×240 · rgb565le · 153,600 B/frame · 2,457,600 B total
              </p>
            </div>
            <button
              type="button"
              onClick={handleDownloadActiveSliceWav}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Download slice_{String(activeSlice).padStart(2, '0')}.wav
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {activeKit.rgb565Frames.map((frame, idx) => (
              <Rgb565ThumbCanvas
                key={idx}
                frame={frame}
                texW={activeKit.texWidth}
                texH={activeKit.texHeight}
                index={idx}
                isSelected={idx === activeSlice}
                sampleCount={activeKit.manifest.audio.slice_samples[idx] || 0}
                onClick={() => onTriggerSlice(idx)}
              />
            ))}
          </div>
        </div>

        {/* Right Column: Locked kit.json Contract Inspector */}
        <div className="lg:col-span-4 bg-[#111722] border border-slate-800 rounded-xl p-6">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <FileCode className="w-4 h-4 text-orange-400" />
              <h3 className="text-base font-semibold text-slate-100">
                kit.json Manifest
              </h3>
            </div>
            <button
              type="button"
              onClick={handleDownloadManifest}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Export JSON
            </button>
          </div>

          <div className="text-xs text-slate-400 mb-3 font-mono tabular-nums">
            <span>Audio: {activeKit.audioSizeKb} KB ({activeKit.manifest.audio.source_of_audio})</span>
            <span className="mx-1.5">·</span>
            <span>Video: {activeKit.videoSizeKb} KB ({activeKit.manifest.video.source_of_video})</span>
          </div>

          <pre className="bg-[#0B0F17] border border-slate-800 rounded-lg p-3.5 text-xs font-mono text-slate-300 overflow-x-auto max-h-[460px] leading-relaxed tabular-nums">
            {JSON.stringify(activeKit.manifest, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
};
