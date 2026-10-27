import React, { useState } from 'react';
import {
  Radio,
  ShieldCheck,
  Terminal,
  FileText,
  FolderOpen,
  Search,
  Copy,
  Check,
  Download,
  Wifi,
  Volume2,
  Send,
  KeyRound,
  Sparkles,
  Globe,
  Cpu,
} from 'lucide-react';
import {
  STUMP_THEMES,
  StumpThemeName,
  StumpLang,
  GlobalAuthMode,
  RoomTier,
  BARKEEP_ASCII_ART,
  AuthSessionState,
  processAuthCommand,
  signAsciiNonceHex,
  evaluateRoomPostAccess,
  librarianSearch,
  guessFileCategory,
  makeRoomFifo,
  DEFAULT_CREDIT_WEIGHTS,
  StumpSharedFile,
  StumpBillboardPost,
  StumpToolApp,
  encodeQrVersion2L,
} from '../engine/stumpLogic';
import {
  STUMP_CODE_ARTIFACTS,
  STUMP_R36MAX_C_SOURCE,
  STUMP_R36MAX_BRIDGE_PY,
  STUMP_R36MAX_PORTS_SCRIPT,
} from '../engine/stumpNativeCode';

interface RrcMessage {
  id: number;
  room: string;
  nick: string;
  body: string;
  isSystem?: boolean;
  via?: 'local' | 'lora' | 'chain';
  ts: string;
}

const DEMO_PUBKEY_HEX =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90' +
  '102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f000';

const INITIAL_FILES: StumpSharedFile[] = [
  {
    name: 'guide_jardinage_permaculture.pdf',
    sizeBytes: 420_000,
    cat: 'document',
    mtimeSec: 1729900100,
    creditCost: 1,
    description: 'Manuel pratique de jardinage et permaculture hors-réseau',
  },
  {
    name: 'offline_topo_montana_pirineos.pdf',
    sizeBytes: 680_000,
    cat: 'document',
    mtimeSec: 1729900200,
    creditCost: 1,
    description: 'Mapas topográficos y refugios de montaña sin cobertura',
  },
  {
    name: 'bivouac_lora_session.opus',
    sizeBytes: 510_000,
    cat: 'music',
    mtimeSec: 1729900300,
    creditCost: 2,
    description: 'Chanson acoustique et musique enregistrée au camp',
  },
  {
    name: 'solar_node_wiring_diagram.png',
    sizeBytes: 240_000,
    cat: 'image',
    mtimeSec: 1729900400,
    creditCost: 1,
    description: 'Photo & wiring schema for ESP32-S3-CAM + Heltec V3 solar box',
  },
];

const INITIAL_POSTS: StumpBillboardPost[] = [
  {
    id: 'p-101',
    title: 'Bienvenue sur LaBuche-Stump R36MAX (Beta A 1.0.0-beta.34)',
    body: 'Ce noeud communautaire tourne sur R36MAX (RK3326). Rejoignez #main en Wi-Fi ou #lora-mesh via Heltec V3.',
    sig: 'r36max-op',
    createdAtSec: 1729901000,
  },
  {
    id: 'p-102',
    title: 'Atelier Jardinage & Semences Libres — Samedi 15h',
    body: 'Échange de graines et guide permaculture disponible dans /files (demandez !find jardinage à BarKeep).',
    sig: 'camille@LaBuche',
    createdAtSec: 1729902000,
  },
  {
    id: 'p-103',
    title: 'LoRa Mesh Net Check — 868.8 MHz SF8 BW125',
    body: 'FireFly-RK3326 handhelds and Android nodes testing #lora-mesh relay hops at 18:00 UTC.',
    sig: 'rod@LaBuche',
    createdAtSec: 1729903000,
  },
];

const INITIAL_APPS: StumpToolApp[] = [
  {
    app: 'FireFly for RK3326 (R36MAX / R36S)',
    file: 'FireFly_RK3326_R36MAX.zip',
    version: '1.2.4',
    sizeBytes: 1_240_000,
    platform: 'R36MAX / R36S Handheld (ArkOS)',
  },
  {
    app: 'FireFly Android LoRa + Stump Client',
    file: 'firefly-android-v1.4.apk',
    version: '1.4.0',
    sizeBytes: 4_850_000,
    platform: 'Android 10+',
  },
  {
    app: 'rnfs (Reticulum File System Wheel Bundle)',
    file: 'rnfs-0.1.1-py3-none-any.whl',
    version: '0.1.1',
    sizeBytes: 148_000,
    platform: 'Python 3 Offline Installer',
  },
];

function playChime(freqHz = 660, durationMs = 65) {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freqHz;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000);
  } catch {
    // Ignore audio context restrictions if not yet interacted
  }
}

export const StumpWorkstationView: React.FC = () => {
  const [subView, setSubView] = useState<'cockpit' | 'visitor_web' | 'deploy_ssh'>('cockpit');
  const [themeName, setThemeName] = useState<StumpThemeName>('amber');
  const [lang, setLang] = useState<StumpLang>('en');
  const [handheldTab, setHandheldTab] = useState<number>(0); // 0:Chat, 1:Billboard, 2:Files, 3:Radio/QR
  const [activeRoom, setActiveRoom] = useState<'main' | 'lora-mesh' | 'wifi-mesh'>('main');
  const [globalAuthMode, setGlobalAuthMode] = useState<GlobalAuthMode>('open');
  const [roomTiers, setRoomTiers] = useState<Record<'main' | 'lora-mesh' | 'wifi-mesh', RoomTier>>({
    main: 'open',
    'lora-mesh': 'open',
    'wifi-mesh': 'open',
  });

  const [session, setSession] = useState<AuthSessionState>({
    clientId: 'r36max-handheld-01',
    nick: 'rodrigo',
    verified: false,
    identityHash: null,
    pendingNonce: null,
    nonceIssuedAtMs: null,
    invitedRooms: ['main', 'lora-mesh', 'wifi-mesh'],
  });

  const [messages, setMessages] = useState<RrcMessage[]>([
    {
      id: 1,
      room: 'main',
      nick: 'system',
      body: 'Project Stump Beta A (1.0.0-beta.34) — Node "LaBuche-R36MAX" online.',
      isSystem: true,
      ts: '14:20',
    },
    {
      id: 2,
      room: 'main',
      nick: 'BarKeep',
      body: 'Bienvenue / Welcome / Bienvenido! Ask `!find <topic>` in FR, EN or ES, or `/help`.',
      isSystem: true,
      ts: '14:20',
    },
    {
      id: 3,
      room: 'lora-mesh',
      nick: 'system',
      body: '#lora-mesh shared over Heltec V3 USB RNode (868.8 MHz, SF8, BW 125 kHz, CR 4/5).',
      isSystem: true,
      via: 'lora',
      ts: '14:21',
    },
    {
      id: 4,
      room: 'lora-mesh',
      nick: 'firefly@r36s',
      body: 'Signal check from FireFly-RK3326 over LoRa (-72 dBm, SNR +8.5 dB).',
      via: 'lora',
      ts: '14:22',
    },
    {
      id: 5,
      room: 'wifi-mesh',
      nick: 'cam@LaBuche-Root',
      body: '🪵 Chained Stump root linked on 192.168.4.1 (channel 11).',
      via: 'chain',
      ts: '14:22',
    },
  ]);

  const [chatInput, setChatInput] = useState<string>('');
  const [files, setFiles] = useState<StumpSharedFile[]>(INITIAL_FILES);
  const [posts, setPosts] = useState<StumpBillboardPost[]>(INITIAL_POSTS);
  const [newPostTitle, setNewPostTitle] = useState<string>('');
  const [newPostBody, setNewPostBody] = useState<string>('');
  const [librarianQuery, setLibrarianQuery] = useState<string>('as-tu un livre sur le jardinage ?');
  const [beaconsSent, setBeaconsSent] = useState<number>(3);
  const [heltecConnected, setHeltecConnected] = useState<boolean>(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [quickCursor, setQuickCursor] = useState<number>(0);

  // Quota set to 3.0 MB for interactive demonstration so uploading files visibly triggers 75% (2.25 MB) FIFO eviction
  const demoQuotaBytes = 3_000_000;
  const demoCeilingBytes = Math.floor(demoQuotaBytes * 0.75);
  const usedBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);

  const palette = STUMP_THEMES[themeName];
  const themeOrder: StumpThemeName[] = ['amber', 'phosphor', 'oled', 'paper', 'tavern'];
  const roomOrder: Array<'main' | 'lora-mesh' | 'wifi-mesh'> = ['main', 'lora-mesh', 'wifi-mesh'];

  const appendMessage = (room: string, nick: string, body: string, isSystem = false, via: 'local' | 'lora' | 'chain' = 'local') => {
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    setMessages((prev) => [
      ...prev,
      {
        id: prev.length + 1,
        room,
        nick,
        body,
        isSystem,
        via,
        ts,
      },
    ]);
  };

  const executeRrcLine = (rawLine: string) => {
    const text = rawLine.trim();
    if (!text) return;

    // 1. Check /auth command
    if (text === '/auth' || text.startsWith('/auth ')) {
      const parts = text.split(/\s+/).slice(1);
      const res = processAuthCommand(session, parts, Date.now());
      setSession(res.session);
      appendMessage(activeRoom, session.nick, text, false);
      appendMessage(activeRoom, 'stumpid', res.reply, true);
      playChime(res.reply.startsWith('AUTH-OK') ? 880 : 660, 75);
      return;
    }

    // 2. Check /whoami
    if (text === '/whoami') {
      appendMessage(activeRoom, session.nick, text, false);
      if (session.verified && session.identityHash) {
        appendMessage(
          activeRoom,
          'stumpid',
          `verified as ${session.identityHash} (nick: ${session.nick}, global AUTH_MODE=${globalAuthMode})`,
          true
        );
      } else {
        appendMessage(
          activeRoom,
          'stumpid',
          `not verified (nick: ${session.nick}, global AUTH_MODE=${globalAuthMode}) — send /auth to verify`,
          true
        );
      }
      playChime(620, 50);
      return;
    }

    // 3. Check /rooms
    if (text === '/rooms') {
      appendMessage(activeRoom, session.nick, text, false);
      const summary = roomOrder
        .map((r) => `#${r}${roomTiers[r] !== 'open' ? ` [${roomTiers[r]}]` : ''}`)
        .join(', ');
      appendMessage(activeRoom, 'rrc', `rooms: ${summary}`, true);
      return;
    }

    // 4. Check /join
    if (text.startsWith('/join ')) {
      const target = text.slice(6).trim().replace(/^#/, '') as 'main' | 'lora-mesh' | 'wifi-mesh';
      if (roomOrder.includes(target)) {
        setActiveRoom(target);
        appendMessage(target, 'rrc', `switched to #${target}`, true);
        playChime(540, 45);
      } else {
        appendMessage(activeRoom, 'rrc', `unknown room #${target} (try #main, #lora-mesh, #wifi-mesh)`, true);
      }
      return;
    }

    // 5. Check /admin <pw> mode <open|hybrid|mandatory>
    if (text.startsWith('/admin ')) {
      const tokens = text.split(/\s+/);
      if (tokens.length >= 4 && tokens[1] === 'TeK' && tokens[2] === 'mode') {
        const m = tokens[3] as GlobalAuthMode;
        if (['open', 'hybrid', 'mandatory'].includes(m)) {
          setGlobalAuthMode(m);
          appendMessage(activeRoom, 'admin', `global AUTH_MODE set to ${m}`, true);
          playChime(784, 60);
          return;
        }
      }
      appendMessage(activeRoom, 'admin', 'usage: /admin TeK mode <open|hybrid|mandatory>', true);
      return;
    }

    // 6. Check access gate before posting regular lines or !commands
    const gate = evaluateRoomPostAccess(session, globalAuthMode, activeRoom, roomTiers[activeRoom]);
    if (!gate.allowed) {
      appendMessage(activeRoom, 'guard', gate.reason || 'Access denied by room/node auth policy', true);
      playChime(220, 120);
      return;
    }

    appendMessage(activeRoom, session.nick, text, false);

    // 7. Check BarKeep !find
    if (text.startsWith('!find')) {
      const q = text.slice(5).trim() || 'jardinage';
      const res = librarianSearch(q, files, posts, INITIAL_APPS);
      const fileHits = res.files.map((f) => `${f.name} (${Math.round(f.sizeBytes / 1024)} KB)`).join(', ');
      const postHits = res.posts.map((p) => `"${p.title}"`).join(', ');
      const appHits = res.apps.map((a) => a.app).join(', ');
      const parts: string[] = [];
      if (fileHits) parts.push(`Files: ${fileHits}`);
      if (postHits) parts.push(`Board: ${postHits}`);
      if (appHits) parts.push(`Apps: ${appHits}`);
      appendMessage(
        activeRoom,
        'BarKeep',
        parts.length > 0 ? parts.join(' · ') : `No exact match for "${q}" — try !shelf or browse /files.`,
        true
      );
      playChime(700, 60);
      return;
    }

    // 8. Check Tavern pack commands (!roll, !8ball, !trout, !shelf)
    if (text.startsWith('!roll')) {
      const d1 = Math.floor(Math.random() * 6) + 1;
      const d2 = Math.floor(Math.random() * 6) + 1;
      appendMessage(activeRoom, 'Tavernier', `🎲 ${session.nick} rolled 2d6: [${d1}] + [${d2}] = ${d1 + d2}`, true);
      playChime(740, 50);
      return;
    }
    if (text.startsWith('!8ball')) {
      const answers = [
        '8-Ball: LoRa line-of-sight is crystal clear.',
        '8-Ball: Ask again after the next Reticulum announce.',
        '8-Ball: Without a doubt — relay hop confirmed.',
      ];
      appendMessage(activeRoom, 'Tavernier', answers[Math.floor(Math.random() * answers.length)], true);
      playChime(587, 50);
      return;
    }
    if (text.startsWith('!trout')) {
      const target = text.slice(6).trim() || 'visitors';
      appendMessage(activeRoom, 'Tavernier', `* ${session.nick} slaps ${target} around a bit with a large trout 🐟`, true);
      return;
    }
    if (text === '!shelf') {
      const summary = files.map((f) => `${f.name} [${f.cat}]`).join(' · ');
      appendMessage(activeRoom, 'BarKeep', `Shelf (${files.length} files): ${summary}`, true);
      return;
    }

    playChime(520, 40);
  };

  const handleInstantChallengeAndSign = () => {
    const step1 = processAuthCommand(session, [], Date.now());
    const nonceHex = step1.reply.split(' ')[1];
    const sigHex = signAsciiNonceHex(DEMO_PUBKEY_HEX, nonceHex);
    const step2 = processAuthCommand(step1.session, [DEMO_PUBKEY_HEX, sigHex], Date.now() + 50);
    setSession(step2.session);
    appendMessage(activeRoom, session.nick, '/auth', false);
    appendMessage(activeRoom, 'stumpid', step1.reply, true);
    appendMessage(
      activeRoom,
      session.nick,
      `/auth ${DEMO_PUBKEY_HEX.slice(0, 16)}… ${sigHex.slice(0, 16)}… (signed ASCII hex nonce)`,
      false
    );
    appendMessage(activeRoom, 'stumpid', step2.reply, true);
    playChime(880, 90);
  };

  const handleSimulateUpload = (name: string, sizeBytes: number, desc: string) => {
    const cat = guessFileCategory(name);
    const fifo = makeRoomFifo(files, sizeBytes, demoQuotaBytes);
    if (!fifo.ok) {
      appendMessage(activeRoom, 'fserv', `507 Insufficient Storage: ${name} exceeds 75% shelf ceiling`, true);
      return;
    }
    const nextFile: StumpSharedFile = {
      name,
      sizeBytes,
      cat,
      mtimeSec: Math.floor(Date.now() / 1000),
      creditCost: DEFAULT_CREDIT_WEIGHTS[cat],
      description: desc,
    };
    setFiles([...fifo.keptFiles, nextFile]);
    if (fifo.evictedFiles.length > 0) {
      appendMessage(
        activeRoom,
        'fserv',
        `Uploaded ${name} (${Math.round(sizeBytes / 1024)} KB). 75% FIFO evicted oldest: ${fifo.evictedFiles
          .map((e) => e.name)
          .join(', ')}`,
        true
      );
    } else {
      appendMessage(activeRoom, 'fserv', `Uploaded ${name} (${Math.round(sizeBytes / 1024)} KB) to /sd/shared`, true);
    }
    playChime(660, 60);
  };

  const handleAddPost = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPostTitle.trim()) return;
    const next: StumpBillboardPost = {
      id: `p-${Date.now()}`,
      title: newPostTitle.trim(),
      body: newPostBody.trim() || 'Posted from R36MAX Handheld Node.',
      sig: `${session.nick}@R36MAX`,
      createdAtSec: Math.floor(Date.now() / 1000),
    };
    setPosts([next, ...posts]);
    setNewPostTitle('');
    setNewPostBody('');
    playChime(740, 60);
  };

  const quickCommands = [
    { label: '/WHOAMI', cmd: '/whoami' },
    { label: '/AUTH + SIGN', cmd: '__AUTH_AUTO__' },
    { label: '!FIND JARDINAGE', cmd: '!find as-tu un livre sur le jardinage ?' },
    { label: '!ROLL 2D6', cmd: '!roll 2d6' },
    { label: '!8BALL MESH', cmd: '!8ball is the LoRa path clear?' },
    { label: 'PING #LORA-MESH', cmd: 'Handheld R36MAX checking in on Reticulum mesh!' },
  ];

  const triggerGamepadA = () => {
    const item = quickCommands[quickCursor];
    if (item.cmd === '__AUTH_AUTO__') {
      handleInstantChallengeAndSign();
    } else {
      executeRrcLine(item.cmd);
    }
  };

  const fullOneClickSshDeploy = `mkdir -p ~/r36max-deploy/stump_pkg/node
cd ~/r36max-deploy

# 1. Clone LaBuche-Stump on your Mac and stage the node files
rm -rf /tmp/LaBuche-Stump
git clone --depth 1 https://github.com/ruderigo/LaBuche-Stump.git /tmp/LaBuche-Stump
cp -rf /tmp/LaBuche-Stump/final_firmware/* ~/r36max-deploy/stump_pkg/node/
cp -rf /tmp/LaBuche-Stump/pc/stump_pc.py ~/r36max-deploy/stump_pkg/node/
cp -rf /tmp/LaBuche-Stump/pc/pc_compat ~/r36max-deploy/stump_pkg/node/

cat << 'CFGEOF' >> ~/r36max-deploy/stump_pkg/node/config.py

# --- R36MAX Handheld Node Overrides ---
NODE_NAME = "LaBuche-R36MAX"
PC_HTTP_PORT = 80
PC_STORAGE_MB = 2048
THEME = "amber"
AUTH_MODE = "open"
CHAIN = True
CFGEOF

cat << 'PYEOF' > ~/r36max-deploy/stump_pkg/node/run_stump_r36max.py
${STUMP_R36MAX_BRIDGE_PY}
PYEOF

cat << 'CEOF' > ~/r36max-deploy/stump_pkg/stump_r36max_engine.c
${STUMP_R36MAX_C_SOURCE}
CEOF

cat << 'SHEOF' > ~/r36max-deploy/LaBuche_Stump.sh
${STUMP_R36MAX_PORTS_SCRIPT}
SHEOF

# 2. Pack and SCP to R36MAX (prompts for password: ark)
tar -czf ~/r36max-deploy/stump_r36max.tar.gz -C ~/r36max-deploy/stump_pkg .
scp ~/r36max-deploy/stump_r36max.tar.gz ~/r36max-deploy/LaBuche_Stump.sh ark@r36max.local:/roms/ports/

  # 3. Extract, compile on Cortex-A35, and test (prompts for password: ark)
ssh -t ark@r36max.local "mkdir -p /roms/ports/stump_r36max/node/sd/shared /roms/ports/stump_r36max/node/sd/tools && \\
  tar -xzf /roms/ports/stump_r36max.tar.gz -C /roms/ports/stump_r36max && \\
  rm -f /roms/ports/stump_r36max.tar.gz && \\
  cd /roms/ports/stump_r36max && \\
  gcc -O2 -mcpu=cortex-a35 -Wall stump_r36max_engine.c -o stump_r36max_engine -lasound -lpthread -ldl -lm && \\
  chmod +x /roms/ports/stump_r36max/stump_r36max_engine /roms/ports/LaBuche_Stump.sh && \\
  ls -la /roms/ports/LaBuche_Stump.sh /roms/ports/stump_r36max/stump_r36max_engine && \\
  /roms/ports/stump_r36max/stump_r36max_engine --smoke && \\
  echo '=== INSTALLED! Restart EmulationStation or look in Ports -> LaBuche_Stump ==='"`;

  const fastUpdateSshDeploy = `mkdir -p ~/r36max-deploy
cat << 'PYEOF' > ~/r36max-deploy/run_stump_r36max.py
${STUMP_R36MAX_BRIDGE_PY}
PYEOF

cat << 'CEOF' > ~/r36max-deploy/stump_r36max_engine.c
${STUMP_R36MAX_C_SOURCE}
CEOF

cat << 'SHEOF' > ~/r36max-deploy/LaBuche_Stump.sh
${STUMP_R36MAX_PORTS_SCRIPT}
SHEOF

scp ~/r36max-deploy/run_stump_r36max.py ark@r36max.local:/roms/ports/stump_r36max/node/run_stump_r36max.py
scp ~/r36max-deploy/stump_r36max_engine.c ark@r36max.local:/roms/ports/stump_r36max/stump_r36max_engine.c
scp ~/r36max-deploy/LaBuche_Stump.sh ark@r36max.local:/roms/ports/LaBuche_Stump.sh

ssh -t ark@r36max.local "grep -q 'CHAIN = True' /roms/ports/stump_r36max/node/config.py || echo 'CHAIN = True' >> /roms/ports/stump_r36max/node/config.py && \\
  cd /roms/ports/stump_r36max && \\
  gcc -O2 -mcpu=cortex-a35 -Wall stump_r36max_engine.c -o stump_r36max_engine -lasound -lpthread -ldl -lm && \\
  chmod +x /roms/ports/stump_r36max/stump_r36max_engine /roms/ports/LaBuche_Stump.sh && \\
  /roms/ports/stump_r36max/stump_r36max_engine --smoke && \\
  echo '=== UPDATED! Launch from EmulationStation -> Ports -> LaBuche_Stump ==='"`;

  const handleCopy = (id: string, text: string) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {
      // Fallback
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDownload = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const librarianLiveResult = librarianSearch(librarianQuery, files, posts, INITIAL_APPS);
  const roomMessages = messages.filter((m) => m.room === activeRoom);

  return (
    <div className="space-y-5">
      {/* Sub-Navigation Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#111621] border border-[#1E2638] rounded-xl p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setSubView('cockpit')}
            className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors ${
              subView === 'cockpit'
                ? 'bg-amber-500 text-slate-950'
                : 'bg-[#182030] text-slate-300 hover:text-white border border-slate-800'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            1. R36MAX 720×720 Stump Cockpit & RRC Mesh
          </button>
          <button
            onClick={() => setSubView('visitor_web')}
            className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors ${
              subView === 'visitor_web'
                ? 'bg-amber-500 text-slate-950'
                : 'bg-[#182030] text-slate-300 hover:text-white border border-slate-800'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            2. Walk-Up Visitor Web Portal (barkeep.py)
          </button>
          <button
            onClick={() => setSubView('deploy_ssh')}
            className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors ${
              subView === 'deploy_ssh'
                ? 'bg-amber-500 text-slate-950'
                : 'bg-[#182030] text-slate-300 hover:text-white border border-slate-800'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            3. Install on R36MAX (ark@r36max.local SSH + C Source)
          </button>
          <button
            onClick={() => handleCopy('fast_update_top', fastUpdateSshDeploy)}
            className="px-3.5 py-2 rounded-lg text-xs font-bold flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md transition-colors"
          >
            {copiedId === 'fast_update_top' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedId === 'fast_update_top' ? 'Copied Fast Update!' : 'Copy Fast R36MAX Update (UDP + OSK/USB Kbd + Heltec)'}
          </button>
          <button
            onClick={() => handleDownload('update_r36max.sh', fastUpdateSshDeploy)}
            className="px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Download update_r36max.sh
          </button>
        </div>

        {/* Theme & Language Selector */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-mono text-slate-400">THEME:</span>
          {themeOrder.map((t) => (
            <button
              key={t}
              onClick={() => setThemeName(t)}
              className={`px-2.5 py-1 rounded text-[11px] font-mono uppercase transition-all ${
                themeName === t
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/50 font-semibold'
                  : 'bg-[#0B0E14] text-slate-400 border border-slate-800 hover:text-slate-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {subView === 'cockpit' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* LEFT: 720x720 1:1 R36MAX Handheld Hardware Simulator */}
          <div className="lg:col-span-5 bg-[#111621] border border-[#1E2638] rounded-2xl p-4 shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="text-[11px] font-mono uppercase tracking-wider text-amber-400 block">
                  R36MAX 4.0&quot; IPS (720×720 1:1) · SDL2 KMSDRM
                </span>
                <h2 className="text-sm font-bold text-white">
                  LaBuche-Stump Pocket Operator ({STUMP_THEMES[themeName].label[lang]})
                </h2>
              </div>
              <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[11px] font-mono">
                v1.0.0-beta.34
              </span>
            </div>

            {/* 1:1 Square 720x720 Simulated Screen */}
            <div
              className="w-full aspect-square rounded-xl overflow-hidden border-2 flex flex-col justify-between p-3 font-mono select-none shadow-inner transition-colors"
              style={{
                backgroundColor: palette.bg,
                color: palette.text,
                borderColor: palette.border,
              }}
            >
              {/* Screen Header */}
              <div>
                <div
                  className="rounded-lg p-2.5 mb-2 border"
                  style={{ backgroundColor: palette.panel, borderColor: palette.border }}
                >
                  <div className="flex items-center justify-between text-xs font-bold">
                    <span style={{ color: palette.emberBright }}>🪵 LABUCHE-R36MAX (BETA A)</span>
                    <span style={{ color: session.verified ? palette.emberBright : palette.muted }}>
                      {session.verified ? 'AUTH-OK ✓' : 'UNVERIFIED'}
                    </span>
                  </div>
                  <div className="text-[10px] mt-1 flex flex-wrap justify-between gap-1" style={{ color: palette.text }}>
                    <span>HTTP://R36MAX.LOCAL:8080</span>
                    <span>THEME:{themeName.toUpperCase()}</span>
                    <span>MODE:{globalAuthMode.toUpperCase()}</span>
                  </div>
                  <div className="text-[10px] mt-0.5 flex items-center justify-between" style={{ color: palette.muted }}>
                    <span>
                      {heltecConnected
                        ? 'RADIO: HELTEC V3 USB (868.8MHz SF8 -72dBm)'
                        : 'RADIO: WIFI/CHAIN RELAY MODE'}
                    </span>
                    <span>BEACONS:{beaconsSent}</span>
                  </div>
                </div>

                {/* L1 / R1 Screen Tabs */}
                <div className="grid grid-cols-4 gap-1 mb-2">
                  {['1:RRC CHAT', '2:BOARD', '3:FILES', '4:RADIO/QR'].map((label, idx) => {
                    const active = handheldTab === idx;
                    return (
                      <button
                        key={label}
                        onClick={() => setHandheldTab(idx)}
                        className="py-1 px-1 rounded text-[10px] font-bold border text-center truncate transition-transform active:scale-95"
                        style={{
                          backgroundColor: active ? palette.ember : palette.panel2,
                          color: active ? palette.bg : palette.text,
                          borderColor: active ? palette.emberBright : palette.border,
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Center Viewport per Tab */}
              <div
                className="flex-1 rounded-lg p-2.5 border overflow-y-auto flex flex-col justify-between text-[11px]"
                style={{ backgroundColor: palette.panel, borderColor: palette.border }}
              >
                {handheldTab === 0 && (
                  <>
                    <div>
                      <div className="flex items-center gap-1.5 mb-2">
                        {roomOrder.map((r) => (
                          <button
                            key={r}
                            onClick={() => setActiveRoom(r)}
                            className="px-2 py-0.5 rounded text-[10px] font-bold border"
                            style={{
                              backgroundColor: activeRoom === r ? palette.panel2 : 'transparent',
                              color: activeRoom === r ? palette.emberBright : palette.muted,
                              borderColor: activeRoom === r ? palette.ember : palette.border,
                            }}
                          >
                            #{r.toUpperCase()}
                            {roomTiers[r] !== 'open' ? `[${roomTiers[r].toUpperCase()}]` : ''}
                          </button>
                        ))}
                      </div>
                      <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                        {roomMessages.slice(-7).map((m) => (
                          <div key={m.id} className="leading-snug break-words">
                            <span style={{ color: m.isSystem ? palette.emberBright : palette.action }}>
                              &lt;{m.nick}&gt;
                            </span>{' '}
                            <span style={{ color: m.isSystem ? palette.emberBright : palette.text }}>{m.body}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Gamepad Quick Deck */}
                    <div
                      className="mt-2 pt-2 border-t"
                      style={{ borderColor: palette.border }}
                    >
                      <div className="text-[9px] uppercase mb-1" style={{ color: palette.muted }}>
                        D-PAD UP/DN + A TO SEND · X FOR /AUTH:
                      </div>
                      <div className="grid grid-cols-2 gap-1">
                        {quickCommands.map((q, idx) => {
                          const sel = quickCursor === idx;
                          return (
                            <button
                              key={q.label}
                              onClick={() => {
                                setQuickCursor(idx);
                                if (q.cmd === '__AUTH_AUTO__') handleInstantChallengeAndSign();
                                else executeRrcLine(q.cmd);
                              }}
                              className="text-left px-1.5 py-0.5 rounded text-[10px] truncate"
                              style={{
                                backgroundColor: sel ? palette.ember : palette.panel2,
                                color: sel ? palette.bg : palette.text,
                              }}
                            >
                              {q.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}

                {handheldTab === 1 && (
                  <div className="space-y-2 flex flex-col justify-between h-full">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold" style={{ color: palette.emberBright }}>
                          LIVE BULLETIN BOARD ({posts.length})
                        </span>
                        <button
                          onClick={() => {
                            const next: StumpBillboardPost = {
                              id: `p-${Date.now()}`,
                              title: 'R36MAX NODE ONLINE & RELAY READY',
                              body: 'Posted directly from R36MAX gamepad ([A] button).',
                              sig: 'r36m',
                              createdAtSec: Math.floor(Date.now() / 1000),
                            };
                            setPosts([next, ...posts]);
                            playChime(880, 60);
                          }}
                          className="px-2 py-0.5 rounded text-[10px] font-bold"
                          style={{ backgroundColor: palette.ember, color: palette.bg }}
                        >
                          + [A] Post Notice
                        </button>
                      </div>
                      {posts.slice(0, 4).map((p) => (
                        <div
                          key={p.id}
                          className="p-2 rounded border flex items-start justify-between gap-2"
                          style={{ backgroundColor: palette.panel2, borderColor: palette.border }}
                        >
                          <div>
                            <div className="font-bold text-[11px]" style={{ color: palette.text }}>
                              {p.title}
                            </div>
                            <div className="text-[10px] mt-0.5 line-clamp-1" style={{ color: palette.muted }}>
                              {p.body}
                            </div>
                            <div className="text-[9px] mt-0.5" style={{ color: palette.ember }}>
                              sig: {p.sig} · id: {p.id}
                            </div>
                          </div>
                          <button
                            onClick={() => {
                              setPosts(posts.filter((item) => item.id !== p.id));
                              playChime(440, 60);
                            }}
                            className="px-1.5 py-0.5 rounded text-[9px] border shrink-0"
                            style={{ borderColor: palette.border, color: palette.muted }}
                          >
                            [X] Del
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {handheldTab === 2 && (
                  <div className="space-y-2 flex flex-col justify-between h-full">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold" style={{ color: palette.emberBright }}>
                          FILE SHELF (/SD/SHARED)
                        </span>
                        <button
                          onClick={() =>
                            handleSimulateUpload(
                              `r36max_mesh_log_${String(Date.now()).slice(-4)}.txt`,
                              180_000,
                              'Live RRC chat & mesh telemetry report exported from R36MAX'
                            )
                          }
                          className="px-2 py-0.5 rounded text-[10px] font-bold"
                          style={{ backgroundColor: palette.ember, color: palette.bg }}
                        >
                          + [A] Share File
                        </button>
                      </div>
                      <div className="text-[10px]" style={{ color: palette.muted }}>
                        Used: {(usedBytes / 1024).toFixed(0)} KB / {(demoCeilingBytes / 1024).toFixed(0)} KB (75% FIFO cap)
                      </div>
                      <div className="space-y-1.5">
                        {files.map((f) => (
                          <div
                            key={f.name}
                            className="p-1.5 rounded border flex items-center justify-between gap-2 text-[10px]"
                            style={{ backgroundColor: palette.panel2, borderColor: palette.border }}
                          >
                            <span className="truncate max-w-[165px]" style={{ color: palette.text }}>
                              {f.name}
                            </span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span style={{ color: palette.emberBright }}>
                                [{f.cat.toUpperCase()}] {Math.round(f.sizeBytes / 1024)}KB
                              </span>
                              <button
                                onClick={() => {
                                  setFiles(files.filter((item) => item.name !== f.name));
                                  playChime(440, 60);
                                }}
                                className="px-1.5 py-0.5 rounded text-[9px] border"
                                style={{ borderColor: palette.border, color: palette.muted }}
                              >
                                [X]
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {handheldTab === 3 && (
                  <div className="space-y-2 flex flex-col justify-between h-full">
                    <div>
                      <div className="text-xs font-bold" style={{ color: palette.emberBright }}>
                        TRANSPORTS &amp; SCANNABLE ISO 18004 QR
                      </div>
                      <div className="text-[10px] mt-1" style={{ color: palette.text }}>
                        WIFI DONGLE: wlan0 (192.168.0.167) · UDP :42420
                      </div>
                      <div className="text-xs font-bold mt-0.5" style={{ color: palette.emberBright }}>
                        http://192.168.0.167:80/ (:8080)
                      </div>
                    </div>

                    {/* Real 25x25 ISO/IEC 18004 Version 2-L QR Code */}
                    <div className="mx-auto bg-white p-2.5 rounded-lg shadow-md">
                      <div
                        className="grid"
                        style={{
                          gridTemplateColumns: 'repeat(25, minmax(0, 1fr))',
                          width: '125px',
                          height: '125px',
                        }}
                      >
                        {encodeQrVersion2L('http://192.168.0.167:80/').flatMap((row, rIdx) =>
                          row.map((bit, cIdx) => (
                            <div
                              key={`${rIdx}-${cIdx}`}
                              style={{
                                width: '5px',
                                height: '5px',
                                backgroundColor: bit ? '#000000' : '#FFFFFF',
                              }}
                            />
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Screen Footer */}
              <div
                className="mt-2 pt-1.5 px-2 rounded border text-[9px] flex items-center justify-between"
                style={{ backgroundColor: palette.panel, borderColor: palette.border, color: palette.muted }}
              >
                <span>L1/R1:TAB · L2/R2:THEME</span>
                <span>X:/AUTH · START:BEACON</span>
              </div>
            </div>

            {/* Physical R36MAX Gamepad Controls Bar */}
            <div className="mt-3 grid grid-cols-4 gap-2">
              <button
                onClick={() => setHandheldTab((handheldTab + 1) % 4)}
                className="px-2.5 py-2 rounded-lg bg-[#182030] hover:bg-[#222d42] border border-slate-700 text-xs font-mono text-slate-200"
              >
                [R1] Next Tab
              </button>
              <button
                onClick={() => {
                  const next = themeOrder[(themeOrder.indexOf(themeName) + 1) % themeOrder.length];
                  setThemeName(next);
                  playChime(784, 40);
                }}
                className="px-2.5 py-2 rounded-lg bg-[#182030] hover:bg-[#222d42] border border-slate-700 text-xs font-mono text-amber-300"
              >
                [R2] Theme
              </button>
              <button
                onClick={triggerGamepadA}
                className="px-2.5 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-xs font-mono text-amber-200 font-semibold"
              >
                [A] Fire Cmd
              </button>
              <button
                onClick={() => {
                  setBeaconsSent((b) => b + 1);
                  appendMessage(
                    activeRoom,
                    'stump.node',
                    'Announced Reticulum stump.node beacon over Heltec V3 + Wi-Fi',
                    true
                  );
                  playChime(987, 85);
                }}
                className="px-2.5 py-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-xs font-mono text-emerald-200 font-semibold"
              >
                [START] Beacon
              </button>
            </div>
          </div>

          {/* RIGHT: Interactive RRC Chat, /auth Verifier, BarKeep Librarian & Shelf Controls */}
          <div className="lg:col-span-7 space-y-5">
            {/* Panel 1: Cryptographic /auth Challenge-Response & Access Control Matrix */}
            <div className="bg-[#111621] border border-[#1E2638] rounded-2xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-amber-400" />
                  <h3 className="text-sm font-bold text-white">
                    Part 1: Cryptographic /auth Challenge-Response &amp; Access Control (REF.md)
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleInstantChallengeAndSign}
                    className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs flex items-center gap-1.5 transition-colors"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Run /auth Challenge + Sign ASCII Nonce
                  </button>
                  {session.verified && (
                    <button
                      onClick={() =>
                        setSession((s) => ({ ...s, verified: false, identityHash: null, pendingNonce: null }))
                      }
                      className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono"
                    >
                      Reset Session
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="bg-[#0B0E14] border border-slate-800 rounded-xl p-3">
                  <div className="text-slate-400 font-mono text-[11px] mb-1.5">
                    GLOBAL AUTH_MODE (Node-Wide Setting)
                  </div>
                  <div className="flex gap-1.5">
                    {(['open', 'hybrid', 'mandatory'] as GlobalAuthMode[]).map((m) => (
                      <button
                        key={m}
                        onClick={() => setGlobalAuthMode(m)}
                        className={`flex-1 py-1.5 rounded font-mono uppercase text-[11px] border ${
                          globalAuthMode === m
                            ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-bold'
                            : 'bg-[#111621] border-slate-800 text-slate-400'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-[#0B0E14] border border-slate-800 rounded-xl p-3">
                  <div className="text-slate-400 font-mono text-[11px] mb-1.5">
                    PER-ROOM TIER FOR #{activeRoom.toUpperCase()} (Independent Gate)
                  </div>
                  <div className="flex gap-1.5">
                    {(['open', 'hybrid', 'minted'] as RoomTier[]).map((tier) => (
                      <button
                        key={tier}
                        onClick={() => setRoomTiers((prev) => ({ ...prev, [activeRoom]: tier }))}
                        className={`flex-1 py-1.5 rounded font-mono uppercase text-[11px] border ${
                          roomTiers[activeRoom] === tier
                            ? 'bg-sky-500/20 border-sky-400 text-sky-300 font-bold'
                            : 'bg-[#111621] border-slate-800 text-slate-400'
                        }`}
                      >
                        {tier}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Panel 2: Live 3-Room RRC Chat & Command Console */}
            <div className="bg-[#111621] border border-[#1E2638] rounded-2xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-emerald-400" />
                  <h3 className="text-sm font-bold text-white">
                    Reticulum Relay Chat (rrc.py) — Three Rooms, Three Reaches
                  </h3>
                </div>
                <div className="flex items-center gap-1.5">
                  {roomOrder.map((r) => (
                    <button
                      key={r}
                      onClick={() => setActiveRoom(r)}
                      className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${
                        activeRoom === r
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold'
                          : 'bg-[#0B0E14] text-slate-400 border border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      #{r}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-[#0B0E14] border border-slate-800 rounded-xl p-3 h-48 overflow-y-auto font-mono text-xs space-y-1.5 mb-3">
                {roomMessages.map((m) => (
                  <div key={m.id} className="flex items-start gap-2 leading-relaxed">
                    <span className="text-slate-600 text-[10px] shrink-0">{m.ts}</span>
                    <span
                      className={`font-semibold shrink-0 ${
                        m.isSystem ? 'text-amber-400' : m.via === 'lora' ? 'text-emerald-400' : 'text-sky-400'
                      }`}
                    >
                      &lt;{m.nick}&gt;
                    </span>
                    <span className={m.isSystem ? 'text-amber-200/90' : 'text-slate-200'}>{m.body}</span>
                  </div>
                ))}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  executeRrcLine(chatInput);
                  setChatInput('');
                }}
                className="flex gap-2"
              >
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={`Message #${activeRoom} or run /auth, /whoami, /rooms, !find, !roll, !8ball, !shelf...`}
                  className="flex-1 bg-[#0B0E14] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-amber-500"
                />
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  Send
                </button>
              </form>
            </div>

            {/* Panel 3: BarKeep Librarian (!find in FR/EN/ES) + 75% FIFO File Shelf */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* BarKeep Trilingual Librarian */}
              <div className="bg-[#111621] border border-[#1E2638] rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                    BarKeep Librarian (librarian.py — FR / EN / ES)
                  </h3>
                </div>
                <input
                  type="text"
                  value={librarianQuery}
                  onChange={(e) => setLibrarianQuery(e.target.value)}
                  placeholder="Ask in FR, EN, or ES..."
                  className="w-full bg-[#0B0E14] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white mb-2"
                />
                <div className="flex flex-wrap gap-1 mb-2.5">
                  {[
                    'as-tu un livre sur le jardinage ?',
                    '¿tienes mapas de montaña?',
                    'any handheld firefly apps?',
                  ].map((sample) => (
                    <button
                      key={sample}
                      onClick={() => setLibrarianQuery(sample)}
                      className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-amber-300"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
                <div className="bg-[#0B0E14] border border-slate-800 rounded-lg p-2.5 text-[11px] font-mono space-y-1">
                  <div className="text-slate-400">
                    Intents:{' '}
                    <span className="text-amber-300">
                      {librarianLiveResult.intents.join(', ') || 'topic-only'}
                    </span>{' '}
                    · Words: <span className="text-sky-300">{librarianLiveResult.words.join(', ') || 'none'}</span>
                  </div>
                  <div className="text-emerald-300">
                    Matches: {librarianLiveResult.files.length} files, {librarianLiveResult.posts.length} notices,{' '}
                    {librarianLiveResult.apps.length} apps
                  </div>
                  {librarianLiveResult.files.map((f) => (
                    <div key={f.name} className="text-slate-200 truncate">
                      📄 {f.name} ({Math.round(f.sizeBytes / 1024)} KB)
                    </div>
                  ))}
                  {librarianLiveResult.apps.map((a) => (
                    <div key={a.file} className="text-amber-200 truncate">
                      📦 {a.app} ({a.file})
                    </div>
                  ))}
                </div>
              </div>

              {/* Shared File Shelf & 75% FIFO Eviction */}
              <div className="bg-[#111621] border border-[#1E2638] rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-sky-400" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                      /sd/shared 75% FIFO Shelf (fserv.py)
                    </h3>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">
                    {Math.round((usedBytes / demoCeilingBytes) * 100)}% of 75% cap
                  </span>
                </div>

                <div className="w-full h-2 rounded-full bg-[#0B0E14] overflow-hidden border border-slate-800 mb-2.5">
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 to-emerald-400 transition-all"
                    style={{ width: `${Math.min(100, Math.round((usedBytes / demoCeilingBytes) * 100))}%` }}
                  />
                </div>

                <div className="space-y-1 max-h-24 overflow-y-auto mb-2.5 text-[11px] font-mono">
                  {files.map((f) => (
                    <div key={f.name} className="flex items-center justify-between text-slate-300">
                      <span className="truncate max-w-[180px]">{f.name}</span>
                      <span className="text-slate-500">{Math.round(f.sizeBytes / 1024)} KB</span>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() =>
                    handleSimulateUpload(
                      `field_report_${files.length + 1}.pdf`,
                      550_000,
                      'R36MAX field mesh telemetry report'
                    )
                  }
                  className="w-full py-1.5 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-sky-200 text-xs font-mono font-semibold"
                >
                  + Upload 550 KB File (Test 75% FIFO Eviction)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {subView === 'visitor_web' && (
        <div className="bg-[#111621] border border-[#1E2638] rounded-2xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4 pb-3 border-b border-slate-800">
            <div>
              <span className="text-xs font-mono text-amber-400">
                WALK-UP VISITOR PORTAL (`final_firmware/barkeep.py` + `theme.py`)
              </span>
              <h2 className="text-base font-bold text-white">
                What Phones & Laptops See at `http://r36max.local:8080/`
              </h2>
            </div>
            <div className="flex items-center gap-2">
              {(['en', 'fr', 'es'] as StumpLang[]).map((l) => (
                <button
                  key={l}
                  onClick={() => setLang(l)}
                  className={`px-2.5 py-1 rounded text-xs font-mono uppercase ${
                    lang === l ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-[#0B0E14] text-slate-400'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>

          <div
            className="max-w-2xl mx-auto rounded-xl p-6 border shadow-xl transition-colors"
            style={{
              backgroundColor: palette.bg,
              color: palette.text,
              borderColor: palette.border,
              fontFamily: "Georgia, 'Palatino Linotype', serif",
            }}
          >
            <pre
              className="text-xs leading-tight mb-2 font-mono"
              style={{ color: palette.ember }}
            >
              {BARKEEP_ASCII_ART}
            </pre>
            <h1 className="text-xl font-bold font-mono mb-1" style={{ color: palette.ember }}>
              LaBuche-R36MAX · Project Stump
            </h1>
            <p className="text-sm mb-4" style={{ color: palette.muted }}>
              {lang === 'fr'
                ? 'Noeud communautaire hors-réseau sur R36MAX — Salon RRC, Babillard, Bibliothèque de fichiers & Reticulum LoRa.'
                : lang === 'es'
                ? 'Nodo comunitario sin red en R36MAX — Chat RRC, Tablón de anuncios, Biblioteca de archivos y malla LoRa.'
                : 'Off-grid community node on R36MAX — RRC Chat room, Bulletin board, File library & Reticulum LoRa mesh.'}
            </p>

            {/* Post Notice Form */}
            <div
              className="p-4 rounded-lg border mb-4"
              style={{ backgroundColor: palette.panel, borderColor: palette.border }}
            >
              <h3 className="font-mono text-sm font-bold mb-2" style={{ color: palette.emberBright }}>
                📌 Bulletin Board (`/billboard`)
              </h3>
              <div className="space-y-2 mb-3">
                {posts.map((p) => (
                  <div
                    key={p.id}
                    className="p-2.5 rounded border"
                    style={{ backgroundColor: palette.panel2, borderColor: palette.border }}
                  >
                    <div className="font-bold text-sm">{p.title}</div>
                    <div className="text-xs mt-1" style={{ color: palette.muted }}>
                      {p.body} — <span style={{ color: palette.ember }}>{p.sig}</span>
                    </div>
                  </div>
                ))}
              </div>
              <form onSubmit={handleAddPost} className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={newPostTitle}
                  onChange={(e) => setNewPostTitle(e.target.value)}
                  placeholder="Notice title..."
                  className="flex-1 px-3 py-1.5 rounded border text-sm"
                  style={{ backgroundColor: palette.bg, color: palette.text, borderColor: palette.border }}
                />
                <input
                  type="text"
                  value={newPostBody}
                  onChange={(e) => setNewPostBody(e.target.value)}
                  placeholder="Details (optional)..."
                  className="flex-1 px-3 py-1.5 rounded border text-sm"
                  style={{ backgroundColor: palette.bg, color: palette.text, borderColor: palette.border }}
                />
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded font-bold text-sm"
                  style={{ backgroundColor: palette.ember, color: palette.bg }}
                >
                  Post Notice
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {subView === 'deploy_ssh' && (
        <div className="space-y-5">
          {/* One-Command Copy-Paste SSH Installer */}
          <div className="bg-[#111621] border border-amber-500/40 rounded-2xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div>
                <span className="text-xs font-mono uppercase tracking-wider text-amber-400 block">
                  ONE-COMMAND SSH INSTALLER FOR ARK@R36MAX.LOCAL
                </span>
                <h2 className="text-base font-bold text-white">
                  Clone `ruderigo/LaBuche-Stump` + Compile 720×720 SDL2 KMSDRM Cockpit on Your R36MAX
                </h2>
              </div>
              <button
                onClick={() => handleCopy('ssh_one_click', fullOneClickSshDeploy)}
                className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg"
              >
                {copiedId === 'ssh_one_click' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copiedId === 'ssh_one_click' ? 'Copied SSH Installer!' : 'Copy Full SSH Install Command'}
              </button>
            </div>
            <p className="text-xs text-slate-300 mb-3">
              Paste this single command into your Mac terminal (password <code className="text-amber-300">ark</code>).
              It clones <code className="text-amber-300">https://github.com/ruderigo/LaBuche-Stump</code> onto your
              handheld, configures <code className="text-amber-300">stump_pc.py</code> on port 8080, compiles{' '}
              <code className="text-amber-300">stump_r36max_engine.c</code> with SDL2 KMSDRM + ALSA, registers{' '}
              <code className="text-amber-300">/roms/ports/LaBuche_Stump.sh</code> in EmulationStation, and runs a 3s
              verification test:
            </p>
            <pre className="bg-[#0B0E14] border border-slate-800 rounded-xl p-4 text-[11px] font-mono text-emerald-300 overflow-x-auto max-h-80">
              {fullOneClickSshDeploy}
            </pre>
          </div>

          {/* Individual Source Artifacts */}
          <div className="grid grid-cols-1 gap-4">
            {STUMP_CODE_ARTIFACTS.map((art) => (
              <div key={art.id} className="bg-[#111621] border border-[#1E2638] rounded-2xl p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div>
                    <h3 className="text-sm font-bold text-white font-mono">{art.filename}</h3>
                    <p className="text-xs text-slate-400">{art.summary}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleCopy(art.id, art.content)}
                      className="px-3 py-1.5 rounded-lg bg-[#182030] hover:bg-[#222d42] text-slate-200 text-xs font-mono flex items-center gap-1.5 border border-slate-700"
                    >
                      {copiedId === art.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedId === art.id ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      onClick={() => handleDownload(art.filename, art.content)}
                      className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-mono flex items-center gap-1.5 border border-amber-500/40"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download
                    </button>
                  </div>
                </div>
                <pre className="bg-[#0B0E14] border border-slate-800 rounded-xl p-3 text-[11px] font-mono text-slate-300 overflow-x-auto max-h-64">
                  {art.content}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
