import React, { useEffect, useRef } from 'react';
import {
  LoadedKit,
  SequencerStep,
  FRAME_BYTES,
  decodeRgb565WordToRgb888,
} from '../engine/chewerLogic';

interface R36MaxDisplayCanvasProps {
  kit: LoadedKit;
  currentStep: number;
  activeSlice: number;
  isPlaying: boolean;
  bpm: number;
  globalShader: SequencerStep['shaderFx'];
  stepState: SequencerStep;
  onTriggerSlice: (sliceIdx: number) => void;
  onTogglePlay: () => void;
  onCycleShader: () => void;
  onPrevKit: () => void;
  onNextKit: () => void;
}

/**
 * Renders the R36MAX's 720x720 (1:1 aspect ratio) 4.0-inch IPS screen:
 *   - Top 4:3 region (360x270 internal canvas): Live RGB565 texture frame for activeSlice
 *     with real-time GLES2 fragment shader emulation (CRT, RGB Split, Invert, Databend, Thresh).
 *   - Bottom 4:1 region (360x90 internal canvas): On-device hardware tracker HUD,
 *     live slice waveform oscilloscope, and RGB565 byte offset telemetry.
 */
export const R36MaxDisplayCanvas: React.FC<R36MaxDisplayCanvasProps> = ({
  kit,
  currentStep,
  activeSlice,
  isPlaying,
  bpm,
  globalShader,
  stepState,
  onTriggerSlice,
  onTogglePlay,
  onCycleShader,
  onPrevKit,
  onNextKit,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 360;
    const H = 360; // 1:1 aspect ratio matching R36MAX 720x720 panel
    const VID_H = 270; // 4:3 top video region (360x270)

    const sliceIdx = Math.max(0, Math.min(15, activeSlice));
    const frameBuf = kit.rgb565Frames[sliceIdx] || kit.rgb565Frames[0];
    const texW = kit.texWidth;
    const texH = kit.texHeight;

    const effectiveShader =
      globalShader !== 'none' ? globalShader : stepState?.shaderFx || 'none';

    // 1. Decode RGB565 frame into ImageData for the 360x270 video surface
    const imgData = ctx.createImageData(W, VID_H);
    const dst = imgData.data;

    for (let y = 0; y < VID_H; y++) {
      const srcY = Math.min(texH - 1, Math.floor((y / VID_H) * texH));
      // Databend horizontal slice displacement
      const bandShift =
        effectiveShader === 'databend'
          ? Math.floor(Math.sin(Math.floor(y / 10) * 7.3 + sliceIdx) * 18)
          : 0;

      for (let x = 0; x < W; x++) {
        const shiftedX = (x + bandShift + W) % W;
        const srcX = Math.min(texW - 1, Math.floor((shiftedX / W) * texW));
        const pxWord = frameBuf[srcY * texW + srcX] || 0;
        let [r, g, b] = decodeRgb565WordToRgb888(pxWord);

        if (effectiveShader === 'rgb_split') {
          const rx = Math.min(texW - 1, Math.max(0, srcX + 5));
          const bx = Math.min(texW - 1, Math.max(0, srcX - 5));
          const [rr] = decodeRgb565WordToRgb888(frameBuf[srcY * texW + rx] || 0);
          const [, , bb] = decodeRgb565WordToRgb888(frameBuf[srcY * texW + bx] || 0);
          r = rr;
          b = bb;
        } else if (effectiveShader === 'invert') {
          r = 255 - r;
          g = 255 - g;
          b = 255 - b;
        } else if (effectiveShader === 'thresh') {
          const luma = r * 0.299 + g * 0.587 + b * 0.114;
          const hi = luma > 118 ? 255 : 14;
          r = hi;
          g = hi === 255 ? 115 : 18;
          b = hi === 255 ? 22 : 28;
        }

        if (effectiveShader === 'crt' && y % 2 === 1) {
          r = Math.floor(r * 0.72);
          g = Math.floor(g * 0.72);
          b = Math.floor(b * 0.72);
        }

        const outIdx = (y * W + x) * 4;
        dst[outIdx] = r;
        dst[outIdx + 1] = g;
        dst[outIdx + 2] = b;
        dst[outIdx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // 2. Top-left & top-right translucent scrim for crisp OSD telemetry
    ctx.fillStyle = 'rgba(11, 15, 23, 0.78)';
    ctx.fillRect(0, 0, W, 24);
    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#F8FAFC';
    ctx.fillText(
      `KIT: ${kit.manifest.name.slice(0, 18)}  [${kit.manifest.source_type.toUpperCase()}]`,
      8,
      15
    );
    ctx.fillStyle = '#F97316';
    const byteOffset = (sliceIdx * FRAME_BYTES).toString(16).toUpperCase().padStart(6, '0');
    ctx.fillText(`0x${byteOffset}`, W - 64, 15);

    // 3. Bottom 720x180 (360x90) On-Device Hardware HUD
    ctx.fillStyle = '#090D14';
    ctx.fillRect(0, VID_H, W, H - VID_H);
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, VID_H + 0.5);
    ctx.lineTo(W, VID_H + 0.5);
    ctx.stroke();

    // Live slice PCM oscilloscope in HUD
    const slicePcm = kit.slicesPcm[sliceIdx] || new Int16Array(64);
    ctx.strokeStyle = '#38BDF8';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    const waveTop = VID_H + 8;
    const waveH = 38;
    const waveMid = waveTop + waveH / 2;
    for (let x = 0; x < W - 16; x++) {
      const sIdx = Math.floor((x / (W - 16)) * slicePcm.length);
      const norm = (slicePcm[sIdx] || 0) / 32768;
      const py = waveMid - norm * (waveH * 0.45);
      if (x === 0) ctx.moveTo(8 + x, py);
      else ctx.lineTo(8 + x, py);
    }
    ctx.stroke();

    // 16-step mini hardware LED bar inside the 720x720 panel
    const barY = VID_H + 54;
    const stepW = (W - 16) / 16;
    for (let s = 0; s < 16; s++) {
      const sx = 8 + s * stepW;
      const isCur = s === currentStep;
      ctx.fillStyle = isCur ? '#F97316' : s % 4 === 0 ? '#334155' : '#1E293B';
      ctx.fillRect(sx + 1, barY, stepW - 3, 12);
    }

    // Footer status line inside the 720x720 display
    ctx.font = '500 10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#94A3B8';
    ctx.fillText(
      `STEP ${String(currentStep + 1).padStart(2, '0')}/16 · SLICE_${String(sliceIdx).padStart(2, '0')} · ${bpm.toFixed(1)} BPM · FX:${effectiveShader.toUpperCase()}`,
      8,
      H - 8
    );
  }, [kit, currentStep, activeSlice, isPlaying, bpm, globalShader, stepState]);

  return (
    <div className="bg-[#111722] border border-slate-800 rounded-xl p-4 flex flex-col items-center">
      {/* Hardware Bezel Header */}
      <div className="w-full flex items-center justify-between text-xs text-slate-400 mb-2.5 font-mono tabular-nums">
        <span>R36MAX · 4.0&quot; IPS 720×720 (1:1)</span>
        <span>GL_RGB565 · 153,600 B/FRM</span>
      </div>

      {/* 1:1 Square 720x720 Viewport */}
      <div className="relative w-full max-w-[360px] aspect-square rounded-lg overflow-hidden border border-slate-700 bg-black shadow-inner">
        <canvas
          ref={canvasRef}
          width={360}
          height={360}
          data-testid="r36max-display-canvas"
          data-active-slice={activeSlice}
          data-current-step={currentStep}
          data-playing={isPlaying ? 'true' : 'false'}
          className="w-full h-full block"
        />
      </div>

      {/* Tactile Handheld Shoulder & Transport Controls */}
      <div className="w-full max-w-[360px] mt-3.5 space-y-2">
        <div className="grid grid-cols-4 gap-1.5">
          <button
            type="button"
            onClick={onPrevKit}
            className="px-1.5 py-1.5 text-[11px] font-mono font-medium bg-slate-800/90 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 transition-colors whitespace-nowrap shrink-0 text-center"
            title="L1: Previous RAM Kit"
          >
            L1 Kit -
          </button>
          <button
            type="button"
            onClick={onNextKit}
            className="px-1.5 py-1.5 text-[11px] font-mono font-medium bg-slate-800/90 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 transition-colors whitespace-nowrap shrink-0 text-center"
            title="R1: Next RAM Kit"
          >
            R1 Kit +
          </button>
          <button
            type="button"
            onClick={onCycleShader}
            className="px-1.5 py-1.5 text-[11px] font-mono font-medium bg-slate-800/90 hover:bg-slate-700 text-amber-300 rounded border border-slate-700 transition-colors whitespace-nowrap shrink-0 text-center"
            title="L2: Cycle GLES2 Fragment Shader"
          >
            L2 Shader
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            className={`px-1.5 py-1.5 text-[11px] font-mono font-semibold rounded border transition-colors whitespace-nowrap shrink-0 text-center ${
              isPlaying
                ? 'bg-orange-600 hover:bg-orange-500 text-white border-orange-500'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500'
            }`}
          >
            {isPlaying ? 'START Stop' : 'START Play'}
          </button>
        </div>

        {/* Quick 4-Pad Handheld Face Button Audition (Y / X / B / A) */}
        <div className="grid grid-cols-4 gap-1.5">
          {[
            { label: 'Y · Kick 00', slice: 0 },
            { label: 'X · Snr 02', slice: 2 },
            { label: 'B · Chop 06', slice: 6 },
            { label: 'A · Amen 10', slice: 10 },
          ].map((btn) => (
            <button
              key={btn.label}
              type="button"
              onClick={() => onTriggerSlice(btn.slice)}
              className="px-1.5 py-1.5 text-[11px] font-mono bg-[#0B0F17] hover:bg-slate-800 text-slate-300 border border-slate-800 rounded transition-colors whitespace-nowrap shrink-0 text-center"
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
