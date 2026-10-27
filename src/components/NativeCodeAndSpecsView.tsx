import React, { useState } from 'react';
import {
  CODE_ARTIFACTS,
  R36MAX_HARDWARE_SPECS,
  CodeFileArtifact,
} from '../engine/nativeEngineCode';
import { calculateRamBudget } from '../engine/chewerLogic';
import { Copy, Check, Download, Cpu, HardDrive, Terminal } from 'lucide-react';

interface NativeCodeAndSpecsViewProps {
  mode: 'code' | 'specs';
  loadedKitCount: number;
}

export const NativeCodeAndSpecsView: React.FC<NativeCodeAndSpecsViewProps> = ({
  mode,
  loadedKitCount,
}) => {
  const [selectedFileId, setSelectedFileId] = useState<string>(CODE_ARTIFACTS[0].id);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [plannedKits, setPlannedKits] = useState<number>(Math.max(12, loadedKitCount));

  const activeArtifact: CodeFileArtifact =
    CODE_ARTIFACTS.find((f) => f.id === selectedFileId) || CODE_ARTIFACTS[0];

  const ramReport = calculateRamBudget(plannedKits, 240);

  const handleCopy = async (artifact: CodeFileArtifact) => {
    try {
      await navigator.clipboard.writeText(artifact.content);
      setCopiedId(artifact.id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // Fallback for restricted clipboard contexts
    }
  };

  const handleDownload = (artifact: CodeFileArtifact) => {
    const blob = new Blob([artifact.content], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = artifact.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (mode === 'specs') {
    return (
      <div className="space-y-8">
        {/* Section 1: R36MAX Hardware Architecture Reference */}
        <section className="bg-[#111722] border border-slate-800 rounded-xl p-6">
          <div className="max-w-3xl">
            <h2 className="text-xl font-semibold text-slate-100 font-['Outfit']">
              R36MAX Hardware Specifications &amp; Engine Coupling
            </h2>
            <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">
              The R36MAX pairs the Rockchip RK3326 (quad-core Cortex-A35 @ 1.5 GHz + Mali-G31 MP2) with a square 4.0-inch 720×720 (1:1) IPS panel and ~639 MiB of usable Linux RAM. Below is how the Phase 2 ALSA + GLES2 engine locks to each hardware subsystem.
            </p>
          </div>

          {/* Core Pinning Map */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
            <div className="bg-[#0B0F17] border border-slate-800 rounded-lg p-4">
              <div className="text-xs font-mono text-orange-400">CPU CORE 0 · SCHED_FIFO 80</div>
              <div className="text-base font-semibold text-slate-100 mt-1">
                Direct ALSA PCM Sequencer
              </div>
              <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                Dedicated to RK817 I2S audio output (<code className="text-slate-200">snd_pcm_writei</code>) with 256-sample periods (~5.8 ms latency). Zero decoding—blasts pre-sliced 44.1kHz s16le arrays from RAM.
              </p>
            </div>

            <div className="bg-[#0B0F17] border border-slate-800 rounded-lg p-4">
              <div className="text-xs font-mono text-sky-400">CPU CORE 1 · DRM/GBM + GLES2</div>
              <div className="text-base font-semibold text-slate-100 mt-1">
                Mali-G31 RGB565 Streamer + evdev
              </div>
              <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                Streams 153,600-byte <code className="text-slate-200">GL_UNSIGNED_SHORT_5_6_5</code> slices from <code className="text-slate-200">mmap</code>&apos;d <code className="text-slate-200">video.rgb565</code> into the 720×720 panel at 60 fps and polls the odroidgo2-joypad evdev node.
              </p>
            </div>

            <div className="bg-[#0B0F17] border border-slate-800 rounded-lg p-4">
              <div className="text-xs font-mono text-emerald-400">CPU CORES 2–3 · NICE +19 / IDLE IO</div>
              <div className="text-base font-semibold text-slate-100 mt-1">
                The Chewer Watch Daemon + OS
              </div>
              <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                Runs <code className="text-slate-200">taskset -c 2,3 nice -n 19 python3 chewer.py watch</code> so background ffmpeg grinding never preempts Core 0 audio or Core 1 GL frame pacing.
              </p>
            </div>
          </div>

          {/* Detailed Hardware Specification Table */}
          <div className="mt-6 overflow-x-auto border border-slate-800 rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#0B0F17] border-b border-slate-800 text-xs font-mono text-slate-400">
                  <th className="py-3 px-4">Subsystem</th>
                  <th className="py-3 px-4">R36MAX Hardware Specification</th>
                  <th className="py-3 px-4">Phase 2 Engine Architecture Choice</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-sm">
                {R36MAX_HARDWARE_SPECS.map((row) => (
                  <tr key={row.subsystem} className="hover:bg-slate-900/40">
                    <td className="py-3.5 px-4 font-medium text-slate-200 whitespace-nowrap">
                      {row.subsystem}
                    </td>
                    <td className="py-3.5 px-4 text-slate-300 font-mono text-xs leading-relaxed">
                      {row.r36maxSpec}
                    </td>
                    <td className="py-3.5 px-4 text-slate-400 text-xs leading-relaxed">
                      {row.engineDesignImpact}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Section 2: Interactive /dev/shm RAM Budget Planner (~639 MiB Usable) */}
        <section className="bg-[#111722] border border-slate-800 rounded-xl p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-800">
            <div>
              <h3 className="text-lg font-semibold text-slate-100 font-['Outfit']">
                /dev/shm Kit Preload Budget Calculator (639 MiB Usable Linux RAM)
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Each Chewer kit consumes exactly 2,400 KB for video.rgb565 (16 × 153,600 B) + ~240 KB for 16 mono PCM WAV slices (~2.58 MiB/kit).
              </p>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <label
                htmlFor="kit-budget-slider"
                className="text-xs font-mono text-slate-300 whitespace-nowrap"
              >
                Preloaded Kits: <span className="text-orange-400 font-bold">{plannedKits}</span>
              </label>
              <input
                id="kit-budget-slider"
                type="range"
                min={1}
                max={80}
                value={plannedKits}
                onChange={(e) => setPlannedKits(Number(e.target.value))}
                className="w-40 accent-orange-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5 font-mono tabular-nums">
            <div className="bg-[#0B0F17] border border-slate-800 rounded-lg p-4">
              <div className="text-xs text-slate-400">Usable Linux RAM</div>
              <div className="text-xl font-bold text-slate-100 mt-1">
                {ramReport.usableLinuxMiB} MiB
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                of {ramReport.nominalMiB} MiB DDR3L
              </div>
            </div>

            <div className="bg-[#0B0F17] border border-slate-800 rounded-lg p-4">
              <div className="text-xs text-slate-400">/dev/shm Kit Usage</div>
              <div className="text-xl font-bold text-orange-400 mt-1">
                {ramReport.usedShmMiB} MiB
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {plannedKits} kits × {ramReport.kitSizeMiB} MiB
              </div>
            </div>

            <div className="bg-[#0B0F17] border border-slate-800 rounded-lg p-4">
              <div className="text-xs text-slate-400">/dev/shm Remaining</div>
              <div className="text-xl font-bold text-slate-100 mt-1">
                {ramReport.freeShmMiB} MiB
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                of {ramReport.shmAllocatedMiB} MiB safe ceiling
              </div>
            </div>

            <div className="bg-[#0B0F17] border border-slate-800 rounded-lg p-4">
              <div className="text-xs text-slate-400">Memory Status</div>
              <div
                className={`text-xl font-bold mt-1 ${
                  ramReport.status === 'Nominal'
                    ? 'text-emerald-400'
                    : ramReport.status === 'Warning'
                      ? 'text-amber-400'
                      : 'text-red-400'
                }`}
              >
                {ramReport.status} ({ramReport.utilizationPct}%)
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                Zero swap / OOM margin
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="bg-[#111722] border border-slate-800 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-800">
          <div>
            <h2 className="text-xl font-semibold text-slate-100 font-['Outfit']">
              Phase 2 Native C Engine (ALSA Direct + GLES2 Shaders) &amp; Ports Launcher
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Ready-to-compile C source for the RK3326 (Cortex-A35 + Mali-G31) plus the EmulationStation Ports tile script that wires The Chewer and live engine together.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => handleCopy(activeArtifact)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              {copiedId === activeArtifact.id ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy {activeArtifact.filename}
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => handleDownload(activeArtifact)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-mono bg-orange-600 hover:bg-orange-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Download {activeArtifact.filename}
            </button>
          </div>
        </div>

        {/* File selector tabs */}
        <div className="flex flex-wrap items-center gap-2 mt-4">
          {CODE_ARTIFACTS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedFileId(item.id)}
              className={`px-3.5 py-2 text-xs font-mono rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                item.id === activeArtifact.id
                  ? 'bg-slate-100 text-slate-900 border-white font-semibold'
                  : 'bg-[#0B0F17] text-slate-300 border-slate-800 hover:border-slate-700'
              }`}
            >
              {item.filename} — {item.title}
            </button>
          ))}
          <a
            href="/assets/aistudio/chewer_b0a9f0fd.py"
            download="chewer.py"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-mono rounded-lg border border-slate-700 bg-[#0B0F17] hover:bg-slate-800 text-emerald-400 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Download Attached chewer.py
          </a>
        </div>

        <p className="text-xs text-slate-400 mt-4 font-mono">
          {activeArtifact.summary}
        </p>

        <pre className="mt-3 bg-[#0B0F17] border border-slate-800 rounded-lg p-4 text-xs font-mono text-slate-200 overflow-x-auto max-h-[600px] leading-relaxed">
          {activeArtifact.content}
        </pre>
      </section>
    </div>
  );
};
