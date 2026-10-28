/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SR,
  LoadedKit,
  SequencerStep,
  calculateRamBudget,
  FRAME_BYTES,
} from './engine/chewerLogic';
import {
  createInitialPreloadedKits,
  createPresetPattern,
  chewUserFileIntoKit,
} from './engine/kitFactory';
import {
  R36MAX_ENGINE_C_SOURCE,
  R36MAX_MAKEFILE,
  R36MAX_PORTS_SCRIPT,
} from './engine/nativeEngineCode';
import { R36MaxDisplayCanvas } from './components/R36MaxDisplayCanvas';
import { ChewerInspectorView } from './components/ChewerInspectorView';
import { NativeCodeAndSpecsView } from './components/NativeCodeAndSpecsView';
import { StumpWorkstationView } from './components/StumpWorkstationView';
import {
  Play,
  Square,
  Volume2,
  VolumeX,
  Sliders,
  Download,
  RotateCcw,
} from 'lucide-react';

type ActiveTab = 'stump' | 'engine' | 'chewer' | 'code' | 'specs';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('stump');
  const [kits, setKits] = useState<LoadedKit[]>(() => createInitialPreloadedKits());
  const [activeKitId, setActiveKitId] = useState<string>('kit-amen-174');

  const activeKit = useMemo(
    () => kits.find((k) => k.id === activeKitId) || kits[0],
    [kits, activeKitId]
  );

  const [steps, setSteps] = useState<SequencerStep[]>(() =>
    createPresetPattern('jungle_chop')
  );
  const [selectedStepIdx, setSelectedStepIdx] = useState<number>(0);
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [activeSlice, setActiveSlice] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [bpm, setBpm] = useState<number>(174);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [globalShader, setGlobalShader] = useState<SequencerStep['shaderFx']>('none');
  const [activePatternName, setActivePatternName] = useState<string>('jungle_chop');

  const audioCtxRef = useRef<AudioContext | null>(null);
  const stepsRef = useRef<SequencerStep[]>(steps);
  stepsRef.current = steps;
  const activeKitRef = useRef<LoadedKit>(activeKit);
  activeKitRef.current = activeKit;
  const isMutedRef = useRef<boolean>(isMuted);
  isMutedRef.current = isMuted;

  const ensureAudioContext = useCallback((): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        audioCtxRef.current = new Ctx({ sampleRate: SR });
      }
    }
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  }, []);

  /**
   * Play a mono s16le PCM slice through Web Audio with pitch semitones, reverse, and stutter
   */
  const playPcmSlice = useCallback(
    (
      kit: LoadedKit,
      sliceIdx: number,
      opts?: {
        pitchSemitones?: number;
        reverse?: boolean;
        stutter?: 1 | 2 | 3 | 4;
        velocity?: number;
        stepDurationSec?: number;
      }
    ) => {
      const clampedSlice = Math.max(0, Math.min(15, sliceIdx));
      setActiveSlice(clampedSlice);

      if (isMutedRef.current) return;
      const ctx = ensureAudioContext();
      if (!ctx) return;

      const pcm = kit.slicesPcm[clampedSlice];
      if (!pcm || pcm.length === 0) return;

      const pitchSemi = opts?.pitchSemitones ?? 0;
      const reverse = opts?.reverse ?? false;
      const stutter = opts?.stutter ?? 1;
      const velocity = opts?.velocity ?? 0.9;
      const stepDur = opts?.stepDurationSec ?? 60 / bpm / 4;

      const audioBuf = ctx.createBuffer(1, pcm.length, SR);
      const chData = audioBuf.getChannelData(0);
      if (reverse) {
        for (let i = 0; i < pcm.length; i++) {
          chData[i] = pcm[pcm.length - 1 - i] / 32768;
        }
      } else {
        for (let i = 0; i < pcm.length; i++) {
          chData[i] = pcm[i] / 32768;
        }
      }

      const playbackRate = Math.pow(2, pitchSemi / 12);
      const subDur = stepDur / stutter;

      for (let s = 0; s < stutter; s++) {
        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.playbackRate.value = playbackRate;

        const gain = ctx.createGain();
        const startTime = ctx.currentTime + s * subDur;
        gain.gain.setValueAtTime(velocity * 0.65, startTime);
        if (stutter > 1) {
          gain.gain.setValueAtTime(0.0001, startTime + subDur * 0.92);
        }

        src.connect(gain);
        gain.connect(ctx.destination);
        src.start(startTime);
      }
    },
    [bpm, ensureAudioContext]
  );

  // Sequencer transport clock
  useEffect(() => {
    if (!isPlaying) return;
    const stepMs = (60 / bpm / 4) * 1000;
    const stepSec = stepMs / 1000;

    const timer = window.setInterval(() => {
      setCurrentStep((prev) => {
        const next = (prev + 1) % 16;
        const st = stepsRef.current[next];
        if (st && st.active) {
          playPcmSlice(activeKitRef.current, st.sliceIdx, {
            pitchSemitones: st.pitchSemitones,
            reverse: st.reverse,
            stutter: st.stutter,
            velocity: st.velocity,
            stepDurationSec: stepSec,
          });
        }
        return next;
      });
    }, stepMs);

    return () => window.clearInterval(timer);
  }, [isPlaying, bpm, playPcmSlice]);

  // Sync BPM when switching kits if kit has a guessed BPM
  const handleSelectKit = useCallback(
    (kitId: string) => {
      setActiveKitId(kitId);
      const found = kits.find((k) => k.id === kitId);
      if (found?.manifest.bpm.value) {
        setBpm(found.manifest.bpm.value);
      }
    },
    [kits]
  );

  const handleTriggerSliceManual = useCallback(
    (sliceIdx: number) => {
      playPcmSlice(activeKit, sliceIdx, {
        pitchSemitones: 0,
        reverse: false,
        stutter: 1,
        velocity: 0.95,
      });
    },
    [activeKit, playPcmSlice]
  );

  const handleTogglePlay = useCallback(() => {
    ensureAudioContext();
    setIsPlaying((prev) => {
      const next = !prev;
      if (next) {
        const st = stepsRef.current[currentStep];
        if (st?.active) {
          playPcmSlice(activeKitRef.current, st.sliceIdx, {
            pitchSemitones: st.pitchSemitones,
            reverse: st.reverse,
            stutter: st.stutter,
            velocity: st.velocity,
          });
        }
      }
      return next;
    });
  }, [currentStep, ensureAudioContext, playPcmSlice]);

  const handleLoadPatternPreset = (
    preset: 'linear_1to1' | 'jungle_chop' | 'amen_roll' | 'databend_chaos'
  ) => {
    setActivePatternName(preset);
    setSteps(createPresetPattern(preset));
  };

  const handleUpdateSelectedStep = (patch: Partial<SequencerStep>) => {
    setSteps((prev) =>
      prev.map((st, idx) => (idx === selectedStepIdx ? { ...st, ...patch } : st))
    );
  };

  const handleToggleStepActive = (idx: number) => {
    setSteps((prev) =>
      prev.map((st, i) => (i === idx ? { ...st, active: !st.active } : st))
    );
  };

  const handleCycleShader = () => {
    const order: SequencerStep['shaderFx'][] = [
      'none',
      'crt',
      'rgb_split',
      'invert',
      'databend',
      'thresh',
    ];
    const nextIdx = (order.indexOf(globalShader) + 1) % order.length;
    setGlobalShader(order[nextIdx]);
  };

  const handlePrevKit = () => {
    const idx = kits.findIndex((k) => k.id === activeKit.id);
    const prevIdx = (idx - 1 + kits.length) % kits.length;
    handleSelectKit(kits[prevIdx].id);
  };

  const handleNextKit = () => {
    const idx = kits.findIndex((k) => k.id === activeKit.id);
    const nextIdx = (idx + 1) % kits.length;
    handleSelectKit(kits[nextIdx].id);
  };

  const handleChewNewFile = async (fileName: string, bytes: Uint8Array) => {
    const ctx = ensureAudioContext() || undefined;
    const newKit = await chewUserFileIntoKit(fileName, bytes, ctx);
    setKits((prev) => [newKit, ...prev]);
    setActiveKitId(newKit.id);
    if (newKit.manifest.bpm.value) {
      setBpm(newKit.manifest.bpm.value);
    }
  };

  const handleExportPortsBundle = () => {
    const bundleText = [
      '# =====================================================================',
      '# TEAM R36MAX — PHASE 2 ALSA + GLES2 LIVE ENGINE & PORTS BUNDLE',
      '# =====================================================================',
      '',
      '### FILE 1: /roms/ports/R36MAX_AV.sh',
      R36MAX_PORTS_SCRIPT,
      '',
      '### FILE 2: /roms/ports/r36max_av/Makefile',
      R36MAX_MAKEFILE,
      '',
      '### FILE 3: /roms/ports/r36max_av/r36max_engine.c',
      R36MAX_ENGINE_C_SOURCE,
    ].join('\n');

    const blob = new Blob([bundleText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'R36MAX_AV_Engine_Ports_Bundle.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const ramBudget = useMemo(() => calculateRamBudget(kits.length, 240), [kits.length]);
  const selectedStep = steps[selectedStepIdx] || steps[0];

  return (
    <div
      className="min-h-screen bg-[#0B0F17] text-[#F1F5F9] flex flex-col font-['Plus_Jakarta_Sans']"
      data-playing={isPlaying ? 'true' : 'false'}
      data-active-kit={activeKit.manifest.name}
    >
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800 bg-[#0B0F17]/95 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('stump');
          }}
          className="text-lg font-bold tracking-tight text-slate-100 font-['Outfit'] whitespace-nowrap shrink-0"
        >
          R36MAX Handheld Suite
        </a>

        {/* Zone 2: Concise single-line text navigation links */}
        <nav aria-label="Main navigation" className="flex items-center gap-6 text-sm font-medium text-slate-400 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('stump')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeTab === 'stump'
                ? 'text-slate-100 underline underline-offset-8 decoration-amber-500 decoration-2'
                : ''
            }`}
          >
            LaBuche-Stump Node
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('engine')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeTab === 'engine'
                ? 'text-slate-100 underline underline-offset-8 decoration-orange-500 decoration-2'
                : ''
            }`}
          >
            AV Breakbeat Engine
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('chewer')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeTab === 'chewer'
                ? 'text-slate-100 underline underline-offset-8 decoration-orange-500 decoration-2'
                : ''
            }`}
          >
            Chewer Inspector
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('code')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeTab === 'code'
                ? 'text-slate-100 underline underline-offset-8 decoration-orange-500 decoration-2'
                : ''
            }`}
          >
            AV C Source
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('specs')}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeTab === 'specs'
                ? 'text-slate-100 underline underline-offset-8 decoration-orange-500 decoration-2'
                : ''
            }`}
          >
            Hardware Specs
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleExportPortsBundle}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-orange-600 hover:bg-orange-500 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Export Ports Bundle
          </button>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 max-w-[1380px] w-full mx-auto px-6 py-6 space-y-6">
        {/* Context Metadata Strip (Unboxed text with middot separators per Zero-Pill rule) */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800/80 text-xs text-slate-400 font-mono tabular-nums">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-slate-200 font-semibold">RK3326 Cortex-A35 (720×720 1:1)</span>
            <span aria-hidden="true">·</span>
            <span>Build 1: Chewer + AV Breakbeat Engine</span>
            <span aria-hidden="true">·</span>
            <span>Build 2: LaBuche-Stump v1.6.0-r36max ([A]=Accept/[B]=Cancel + Panel 5 Network Revision + Multi-Threaded AP Portal)</span>
          </div>
          <div className="flex items-center gap-2">
            <span>/dev/shm: {ramBudget.usedShmMiB} MiB used</span>
            <span aria-hidden="true">·</span>
            <span>{ramBudget.usableLinuxMiB} MiB Linux RAM ceiling</span>
          </div>
        </div>

        {activeTab === 'stump' && <StumpWorkstationView />}

        {activeTab === 'engine' && (
          <div className="space-y-6">
            {/* Top Toolbar: Transport, BPM, Kit Switcher, Pattern Presets, GLES2 Shader Override */}
            <section className="bg-[#111722] border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
              {/* Transport & Tempo */}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleTogglePlay}
                  className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-mono font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    isPlaying
                      ? 'bg-orange-600 hover:bg-orange-500 text-white'
                      : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  }`}
                >
                  {isPlaying ? (
                    <>
                      <Square className="w-3.5 h-3.5 fill-current" />
                      Stop Sequencer
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 fill-current" />
                      Play Sequencer
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setIsMuted((m) => !m)}
                  aria-label={isMuted ? 'Unmute audio output' : 'Mute audio output'}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  {isMuted ? (
                    <>
                      <VolumeX className="w-3.5 h-3.5 text-red-400" />
                      Muted
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                      ALSA Out
                    </>
                  )}
                </button>

                <div className="flex items-center gap-2 bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-1.5">
                  <label htmlFor="bpm-input" className="text-xs font-mono text-slate-400">
                    BPM
                  </label>
                  <input
                    id="bpm-input"
                    type="number"
                    min={60}
                    max={220}
                    step={1}
                    value={bpm}
                    onChange={(e) =>
                      setBpm(Math.max(60, Math.min(220, Number(e.target.value) || 174)))
                    }
                    className="w-16 bg-transparent text-sm font-mono font-bold text-slate-100 focus:outline-none tabular-nums"
                  />
                </div>
              </div>

              {/* Kit Bank Selector (/dev/shm preloaded kits) */}
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="kit-select" className="text-xs font-mono text-slate-400">
                  RAM Kit:
                </label>
                <select
                  id="kit-select"
                  value={activeKit.id}
                  onChange={(e) => handleSelectKit(e.target.value)}
                  className="bg-[#0B0F17] border border-slate-700 text-slate-100 text-xs font-mono rounded-lg px-3 py-2 focus:outline-none focus:border-orange-500"
                >
                  {kits.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.manifest.name} ({k.manifest.source_type} · {k.manifest.bpm.value || 174} BPM)
                    </option>
                  ))}
                </select>
              </div>

              {/* Pattern Presets & GLES2 Shader Selector */}
              <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[#0B0F17] border border-slate-800 rounded-lg">
                {(
                  [
                    { id: 'jungle_chop', label: 'Jungle Chop' },
                    { id: 'amen_roll', label: 'Amen Roll' },
                    { id: 'databend_chaos', label: 'Databend Chaos' },
                    { id: 'linear_1to1', label: '1:1 Linear' },
                  ] as const
                ).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleLoadPatternPreset(p.id)}
                    className={`px-2.5 py-1.5 text-xs font-mono rounded transition-colors whitespace-nowrap shrink-0 ${
                      activePatternName === p.id
                        ? 'bg-slate-800 text-white font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </section>

            {/* Main 2-Column Workstation Grid: Left = R36MAX 720x720 Display; Right = 16-Slice Chopper & 16-Step Sequencer */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left 5 Columns: R36MAX 720x720 Handheld Display & Active Kit Telemetry */}
              <div className="lg:col-span-5 space-y-4">
                <R36MaxDisplayCanvas
                  kit={activeKit}
                  currentStep={currentStep}
                  activeSlice={activeSlice}
                  isPlaying={isPlaying}
                  bpm={bpm}
                  globalShader={globalShader}
                  stepState={steps[currentStep] || steps[0]}
                  onTriggerSlice={handleTriggerSliceManual}
                  onTogglePlay={handleTogglePlay}
                  onCycleShader={handleCycleShader}
                  onPrevKit={handlePrevKit}
                  onNextKit={handleNextKit}
                />

                {/* Active Kit Contract Summary */}
                <div className="bg-[#111722] border border-slate-800 rounded-xl p-4 font-mono text-xs space-y-2 tabular-nums">
                  <div className="flex items-center justify-between text-slate-300 font-semibold">
                    <span>Active Kit Contract</span>
                    <span className="text-orange-400">{activeKit.manifest.source}</span>
                  </div>
                  <div className="text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>Audio: {activeKit.manifest.audio.source_of_audio}</span>
                    <span>·</span>
                    <span>16× s16le WAV ({activeKit.audioSizeKb} KB)</span>
                    <span>·</span>
                    <span>Video: {activeKit.manifest.video.source_of_video} ({activeKit.videoSizeKb} KB)</span>
                  </div>
                  <div className="text-slate-400 flex flex-wrap items-center gap-x-2">
                    <span>Coupling: 1:1 Step→Slice→Frame</span>
                    <span>·</span>
                    <span>
                      Frame Offset: {(activeSlice * FRAME_BYTES).toLocaleString()} B
                    </span>
                  </div>
                </div>
              </div>

              {/* Right 7 Columns: 16-Step Sequencer Matrix + Per-Step Parameter Locks + 16-Slice Audition Pads */}
              <div className="lg:col-span-7 space-y-6">
                {/* 16-Step Sequencer Grid */}
                <section className="bg-[#111722] border border-slate-800 rounded-xl p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                    <div>
                      <h2 className="text-base font-semibold text-slate-100 font-['Outfit']">
                        16-Step AV Breakbeat Sequencer (1:1 Slice &amp; RGB565 Frame Lock)
                      </h2>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Click a step to inspect/lock its Slice (00–15), Pitch, Stutter subdivision, Reverse, and GLES2 Fragment Shader.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <label htmlFor="global-shader-select" className="text-xs font-mono text-slate-400">
                        Master GLES2 FX:
                      </label>
                      <select
                        id="global-shader-select"
                        value={globalShader}
                        onChange={(e) =>
                          setGlobalShader(e.target.value as SequencerStep['shaderFx'])
                        }
                        className="bg-[#0B0F17] border border-slate-700 text-xs font-mono text-slate-200 rounded px-2.5 py-1"
                      >
                        <option value="none">Per-Step Auto</option>
                        <option value="crt">CRT Scanlines</option>
                        <option value="rgb_split">RGB Chromatic Split</option>
                        <option value="invert">Strobe Invert</option>
                        <option value="databend">Databend Tear</option>
                        <option value="thresh">1-Bit Threshold</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
                    {steps.map((st, idx) => {
                      const isCurrent = isPlaying && idx === currentStep;
                      const isSelected = idx === selectedStepIdx;
                      return (
                        <div
                          key={idx}
                          className={`rounded-lg border p-2 transition-colors flex flex-col justify-between ${
                            isCurrent
                              ? 'bg-orange-600/20 border-orange-500'
                              : isSelected
                                ? 'bg-slate-800/90 border-sky-400'
                                : st.active
                                  ? 'bg-[#0B0F17] border-slate-800 hover:border-slate-700'
                                  : 'bg-[#0B0F17]/40 border-slate-900 opacity-50'
                          }`}
                        >
                          <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
                            <button
                              type="button"
                              onClick={() => setSelectedStepIdx(idx)}
                              className="font-bold text-slate-200 hover:text-orange-400"
                            >
                              #{String(idx + 1).padStart(2, '0')}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleStepActive(idx)}
                              aria-label={`Toggle step ${idx + 1} active`}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                                st.active
                                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                  : 'bg-slate-900 text-slate-500'
                              }`}
                            >
                              {st.active ? 'ON' : 'MUTE'}
                            </button>
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              setSelectedStepIdx(idx);
                              playPcmSlice(activeKit, st.sliceIdx, {
                                pitchSemitones: st.pitchSemitones,
                                reverse: st.reverse,
                                stutter: st.stutter,
                                velocity: st.velocity,
                              });
                            }}
                            className="mt-2 text-left space-y-0.5"
                          >
                            <div className="text-xs font-mono font-semibold text-orange-400 tabular-nums">
                              SL_{String(st.sliceIdx).padStart(2, '0')}
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 tabular-nums truncate">
                              {st.stutter > 1 ? `${st.stutter}x` : '1x'}{' '}
                              {st.reverse ? 'REV' : 'FWD'}{' '}
                              {st.pitchSemitones !== 0
                                ? `${st.pitchSemitones > 0 ? '+' : ''}${st.pitchSemitones}st`
                                : ''}
                            </div>
                            <div className="text-[10px] font-mono text-sky-400 uppercase truncate">
                              {st.shaderFx}
                            </div>
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  {/* Selected Step Parameter Lock Inspector */}
                  <div className="mt-5 pt-4 border-t border-slate-800 grid grid-cols-2 sm:grid-cols-5 gap-3 items-end">
                    <div>
                      <label
                        htmlFor="step-slice-select"
                        className="block text-[11px] font-mono text-slate-400 mb-1 whitespace-nowrap"
                      >
                        Step #{String(selectedStepIdx + 1).padStart(2, '0')} Slice
                      </label>
                      <select
                        id="step-slice-select"
                        value={selectedStep.sliceIdx}
                        onChange={(e) =>
                          handleUpdateSelectedStep({ sliceIdx: Number(e.target.value) })
                        }
                        className="w-full bg-[#0B0F17] border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100"
                      >
                        {Array.from({ length: 16 }, (_, i) => (
                          <option key={i} value={i}>
                            slice_{String(i).padStart(2, '0')} (frm #{i})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="step-pitch-input"
                        className="block text-[11px] font-mono text-slate-400 mb-1"
                      >
                        Pitch ({selectedStep.pitchSemitones > 0 ? '+' : ''}
                        {selectedStep.pitchSemitones} st)
                      </label>
                      <input
                        id="step-pitch-input"
                        type="range"
                        min={-12}
                        max={12}
                        step={1}
                        value={selectedStep.pitchSemitones}
                        onChange={(e) =>
                          handleUpdateSelectedStep({
                            pitchSemitones: Number(e.target.value),
                          })
                        }
                        className="w-full accent-orange-500"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="step-stutter-select"
                        className="block text-[11px] font-mono text-slate-400 mb-1"
                      >
                        Stutter Retrig
                      </label>
                      <select
                        id="step-stutter-select"
                        value={selectedStep.stutter}
                        onChange={(e) =>
                          handleUpdateSelectedStep({
                            stutter: Number(e.target.value) as 1 | 2 | 3 | 4,
                          })
                        }
                        className="w-full bg-[#0B0F17] border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100"
                      >
                        <option value={1}>1x Normal</option>
                        <option value={2}>2x Double</option>
                        <option value={3}>3x Triplet</option>
                        <option value={4}>4x Drill Roll</option>
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="step-shader-select"
                        className="block text-[11px] font-mono text-slate-400 mb-1"
                      >
                        Step GLES2 Shader
                      </label>
                      <select
                        id="step-shader-select"
                        value={selectedStep.shaderFx}
                        onChange={(e) =>
                          handleUpdateSelectedStep({
                            shaderFx: e.target.value as SequencerStep['shaderFx'],
                          })
                        }
                        className="w-full bg-[#0B0F17] border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100"
                      >
                        <option value="none">none (clean)</option>
                        <option value="crt">crt scanline</option>
                        <option value="rgb_split">rgb_split</option>
                        <option value="invert">invert strobe</option>
                        <option value="databend">databend tear</option>
                        <option value="thresh">thresh 1-bit</option>
                      </select>
                    </div>

                    <div className="pt-4">
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateSelectedStep({ reverse: !selectedStep.reverse })
                        }
                        className={`w-full py-1.5 px-3 rounded text-xs font-mono border transition-colors whitespace-nowrap shrink-0 ${
                          selectedStep.reverse
                            ? 'bg-orange-600 text-white border-orange-500'
                            : 'bg-[#0B0F17] text-slate-300 border-slate-700 hover:border-slate-600'
                        }`}
                      >
                        {selectedStep.reverse ? 'Direction: REV' : 'Direction: FWD'}
                      </button>
                    </div>
                  </div>
                </section>

                {/* 16-Slice Direct Audition & Waveform Pad Matrix */}
                <section className="bg-[#111722] border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-base font-semibold text-slate-100 font-['Outfit']">
                      16-Slice RAM Bank (slice_00.wav .. slice_15.wav)
                    </h3>
                    <span className="text-xs font-mono text-slate-400 tabular-nums">
                      44.1 kHz · 16-bit Mono PCM · Click pad to fire slice + RGB565 frame
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    {activeKit.slicePeaks.map((peaks, idx) => {
                      const isTriggered = idx === activeSlice;
                      const samplesCount = activeKit.manifest.audio.slice_samples[idx] || 0;
                      return (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => handleTriggerSliceManual(idx)}
                          className={`p-2.5 rounded-lg border text-left transition-colors ${
                            isTriggered
                              ? 'bg-slate-800 border-orange-500'
                              : 'bg-[#0B0F17] border-slate-800 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-center justify-between text-xs font-mono tabular-nums mb-1.5">
                            <span className="font-semibold text-slate-200">
                              slice_{String(idx).padStart(2, '0')}
                            </span>
                            <span className="text-[11px] text-slate-400">
                              {(samplesCount / SR).toFixed(2)}s
                            </span>
                          </div>

                          {/* Mini waveform bars */}
                          <div className="h-7 flex items-end gap-[2px]">
                            {peaks.slice(0, 24).map((p, bIdx) => (
                              <div
                                key={bIdx}
                                className={`flex-1 rounded-t ${
                                  isTriggered ? 'bg-orange-400' : 'bg-sky-400/75'
                                }`}
                                style={{ height: `${Math.max(12, Math.round(p * 100))}%` }}
                              />
                            ))}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'chewer' && (
          <ChewerInspectorView
            activeKit={activeKit}
            allKits={kits}
            activeSlice={activeSlice}
            onSelectKit={handleSelectKit}
            onTriggerSlice={handleTriggerSliceManual}
            onChewFile={handleChewNewFile}
          />
        )}

        {activeTab === 'code' && (
          <NativeCodeAndSpecsView mode="code" loadedKitCount={kits.length} />
        )}

        {activeTab === 'specs' && (
          <NativeCodeAndSpecsView mode="specs" loadedKitCount={kits.length} />
        )}
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-800/80 py-4 px-6 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-4 max-w-[1380px] w-full mx-auto">
        <span>Team R36MAX · Chew Ahead of Time, Blast Raw Bytes at Playback</span>
        <span className="font-mono tabular-nums">
          Chewer Contract v1.0 · 16 Slices × 44.1kHz s16le + 16 Frames × 320×240 RGB565-LE
        </span>
      </footer>
    </div>
  );
}
