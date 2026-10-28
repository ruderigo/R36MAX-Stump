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
  const [camApActive, setCamApActive] = useState<boolean>(true);
  const [qrWifiJoin, setQrWifiJoin] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [quickCursor, setQuickCursor] = useState<number>(0);
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<{
    type: 'board' | 'file';
    ids: string[];
    label: string;
  } | null>(null);
  const [checkedBoardIds, setCheckedBoardIds] = useState<string[]>([]);
  const [checkedFileNames, setCheckedFileNames] = useState<string[]>([]);
  const [tfBackups, setTfBackups] = useState<string[]>([
    'stump_diag_20260619_0820.txt',
    'billboard_backup_1729901000.json',
  ]);
  const [simBusyMsg, setSimBusyMsg] = useState<string | null>(null);
  const [visitorRoute, setVisitorRoute] = useState<'home' | 'rrc' | 'billboard' | 'files' | 'tools' | 'about' | 'concierge'>('home');
  const [boardSearch, setBoardSearch] = useState<string>('');
  const [fileCatFilter, setFileCatFilter] = useState<string>('all');
  const [aboutSubTab, setAboutSubTab] = useState<'about' | 'connect' | 'apps'>('about');
  const [debugLogs, setDebugLogs] = useState<string[]>([
    '08:19:22 Bridge v1.7.0-r36max booted on dArkOS (Linux 4.4.189)',
    '08:19:23 final_firmware/barkeep.py + rrc_ui.py bound on :80=True :8080=True',
    '08:19:24 Blueway RT3070 wlan0 (rt2800usb) + RFC 2131 DHCP(:67) + DNS(:53) ready',
    '08:19:25 FireFly · Stump 720x720 UI + Panel 5 Network Revision ready',
  ]);
  const [joinedWifiSsid, setJoinedWifiSsid] = useState<string>('Home-LAN-2.4G');
  const [wifiPassInput, setWifiPassInput] = useState<string>('');
  const [stagedApMode, setStagedApMode] = useState<boolean>(true);
  const [stagedWifiSsid, setStagedWifiSsid] = useState<string>('Home-LAN-2.4G');
  const [stagedDirty, setStagedDirty] = useState<boolean>(false);
  const [confirmNetRevision, setConfirmNetRevision] = useState<boolean>(false);
  const [wifiSsids, setWifiSsids] = useState<
    Array<{ ssid: string; signal: number; sec: string }>
  >([
    { ssid: 'Home-LAN-2.4G', signal: 92, sec: 'SAVED' },
    { ssid: 'LaBuche-Relay-02', signal: 78, sec: 'OPEN' },
    { ssid: 'FieldCamp-Net', signal: 64, sec: 'WPA2' },
  ]);

  const triggerBusy = (msg: string, ms = 1600) => {
    setSimBusyMsg(msg);
    setTimeout(() => {
      setSimBusyMsg((cur) => (cur === msg ? null : cur));
    }, ms);
  };

  const addDebugLog = (entry: string) => {
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(
      now.getSeconds()
    ).padStart(2, '0')}`;
    setDebugLogs((prev) => [`${ts} ${entry}`, ...prev.slice(0, 29)]);
  };

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
rm -rf /tmp/LaBuche-Stump
git clone --depth 1 https://github.com/ruderigo/LaBuche-Stump.git /tmp/LaBuche-Stump
cp -rf /tmp/LaBuche-Stump/final_firmware/* ~/r36max-deploy/stump_pkg/node/
cp -rf /tmp/LaBuche-Stump/pc/stump_pc.py ~/r36max-deploy/stump_pkg/node/
cp -rf /tmp/LaBuche-Stump/pc/pc_compat ~/r36max-deploy/stump_pkg/node/

cat << 'CFGEOF' >> ~/r36max-deploy/stump_pkg/node/config.py

NODE_NAME = "LaBuche-R36MAX"
PC_HTTP_PORT = 8880
PC_STORAGE_MB = 2048
THEME = "amber"
AUTH_MODE = "open"
AUTH_ACCESS_MODE = "open"
APP_HELLO = False
CHAIN = True
FEATURES = ["chat", "billboard", "files", "about"]
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

cat << 'INSTEOF' > ~/r36max-deploy/install_full_remote.sh
#!/bin/bash
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
mkdir -p /roms/ports/stump_r36max/node/sd/shared /roms/ports/stump_r36max/node/sd/tools /roms/ports/stump_r36max/tf_backup
echo ark | sudo -S pkill -f stump_r36max_engine 2>/dev/null || true
echo ark | sudo -S pkill -f run_stump_r36max.py 2>/dev/null || true
echo ark | sudo -S rm -f /dev/shm/stump_cmd.txt /dev/shm/stump_live.txt 2>/dev/null || true
echo ark | sudo -S pkill -f stump_hostapd 2>/dev/null || true
echo ark | sudo -S pkill -f stump_wpa_ap 2>/dev/null || true
echo ark | sudo -S pkill -f stump_dnsmasq.conf 2>/dev/null || true
echo ark | sudo -S nmcli con down StumpCAM 2>/dev/null || true
echo ark | sudo -S nmcli con delete StumpCAM 2>/dev/null || true
echo ark | sudo -S systemctl unmask --runtime NetworkManager NetworkManager-dispatcher wpa_supplicant dhcpcd 2>/dev/null || true
echo ark | sudo -S systemctl unmask NetworkManager wpa_supplicant 2>/dev/null || true
echo ark | sudo -S systemctl start wpa_supplicant 2>/dev/null || true
echo ark | sudo -S systemctl start NetworkManager 2>/dev/null || true
tar -xzf /roms/ports/stump_r36max.tar.gz -C /roms/ports/stump_r36max
rm -f /roms/ports/stump_r36max.tar.gz
cd /roms/ports/stump_r36max || exit 1
gcc -O2 -mcpu=cortex-a35 -Wall stump_r36max_engine.c -o stump_r36max_engine.new -lasound -lpthread -ldl -lm && mv -f stump_r36max_engine.new stump_r36max_engine
chmod +x /roms/ports/stump_r36max/stump_r36max_engine /roms/ports/LaBuche_Stump.sh
/roms/ports/stump_r36max/stump_r36max_engine --smoke
rm -f /roms/ports/install_full_remote.sh
echo "=== INSTALLED v1.7.1-r36max — Authentic final_firmware Stump Portal + FireFly R36MAX UI ==="
INSTEOF

tar -czf ~/r36max-deploy/stump_r36max.tar.gz -C ~/r36max-deploy/stump_pkg .
scp ~/r36max-deploy/stump_r36max.tar.gz ~/r36max-deploy/LaBuche_Stump.sh ~/r36max-deploy/install_full_remote.sh ark@r36max.local:/roms/ports/
ssh -t ark@r36max.local "bash /roms/ports/install_full_remote.sh"`;

  const fastUpdateSshDeploy = `echo ">>> Staging LaBuche-Stump v1.7.1-r36max in ~/r36max-deploy ..."
mkdir -p ~/r36max-deploy

cat << 'PYEOF' > ~/r36max-deploy/run_stump_r36max.py
${STUMP_R36MAX_BRIDGE_PY}
PYEOF

cat << 'CEOF' > ~/r36max-deploy/stump_r36max_engine.c
${STUMP_R36MAX_C_SOURCE}
CEOF

cat << 'SHEOF' > ~/r36max-deploy/LaBuche_Stump.sh
${STUMP_R36MAX_PORTS_SCRIPT}
SHEOF

cat << 'INSTEOF' > ~/r36max-deploy/install_remote.sh
#!/bin/bash
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
mkdir -p /roms/ports/stump_r36max/tf_backup /roms/ports/stump_r36max/node/sd/shared /roms/ports/stump_r36max/node/sd/tools
mv -f /roms/ports/run_stump_r36max.py /roms/ports/stump_r36max/node/run_stump_r36max.py
cp -f /roms/ports/stump_r36max/node/run_stump_r36max.py /roms/ports/stump_r36max/run_stump_r36max.py
mv -f /roms/ports/stump_r36max_engine.c /roms/ports/stump_r36max/stump_r36max_engine.c
echo ark | sudo -S pkill -f stump_r36max_engine 2>/dev/null || true
echo ark | sudo -S pkill -f run_stump_r36max.py 2>/dev/null || true
echo ark | sudo -S rm -f /dev/shm/stump_cmd.txt /dev/shm/stump_live.txt 2>/dev/null || true
echo ark | sudo -S pkill -f stump_hostapd 2>/dev/null || true
echo ark | sudo -S pkill -f stump_wpa_ap 2>/dev/null || true
echo ark | sudo -S pkill -f stump_dnsmasq.conf 2>/dev/null || true
echo ark | sudo -S nft flush ruleset 2>/dev/null || true
echo ark | sudo -S iptables -P INPUT ACCEPT 2>/dev/null || true
echo ark | sudo -S iptables -F INPUT 2>/dev/null || true
echo ark | sudo -S sysctl -w net.ipv4.conf.all.rp_filter=0 2>/dev/null || true
echo ark | sudo -S nmcli con down StumpCAM 2>/dev/null || true
echo ark | sudo -S nmcli con delete StumpCAM 2>/dev/null || true
echo ark | sudo -S systemctl unmask --runtime NetworkManager NetworkManager-dispatcher wpa_supplicant dhcpcd 2>/dev/null || true
echo ark | sudo -S systemctl unmask NetworkManager wpa_supplicant 2>/dev/null || true
echo ark | sudo -S systemctl start wpa_supplicant 2>/dev/null || true
echo ark | sudo -S systemctl start NetworkManager 2>/dev/null || true
grep -q 'CHAIN = True' /roms/ports/stump_r36max/node/config.py 2>/dev/null || echo 'CHAIN = True' >> /roms/ports/stump_r36max/node/config.py
grep -q "FEATURES = \['chat', 'billboard', 'files', 'about'\]" /roms/ports/stump_r36max/node/config.py 2>/dev/null || echo "FEATURES = ['chat', 'billboard', 'files', 'about']" >> /roms/ports/stump_r36max/node/config.py
cd /roms/ports/stump_r36max || exit 1
gcc -O2 -mcpu=cortex-a35 -Wall stump_r36max_engine.c -o stump_r36max_engine.new -lasound -lpthread -ldl -lm && mv -f stump_r36max_engine.new stump_r36max_engine
chmod +x /roms/ports/stump_r36max/stump_r36max_engine /roms/ports/LaBuche_Stump.sh
/roms/ports/stump_r36max/stump_r36max_engine --smoke
rm -f /roms/ports/install_remote.sh
echo "=== UPDATED TO v1.7.1-r36max — Port 53 Errno 98 Fix + Authentic final_firmware Portal (:80/:8080) + FireFly UI Ready ==="
INSTEOF

scp ~/r36max-deploy/run_stump_r36max.py ~/r36max-deploy/stump_r36max_engine.c ~/r36max-deploy/LaBuche_Stump.sh ~/r36max-deploy/install_remote.sh ark@r36max.local:/roms/ports/
ssh -t ark@r36max.local "bash /roms/ports/install_remote.sh"`;

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
      {/* Prominent 1-Paste CLI Update Banner */}
      <div className="bg-emerald-950/30 border border-emerald-500/40 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-[11px] font-mono uppercase tracking-wider text-emerald-400 block font-bold">
            v1.7.1-r36max · PORT 53 ERRNO 98 FIX + AUTHENTIC FINAL_FIRMWARE STUMP PORTAL + FIREFLY_RK3326 UI
          </span>
          <p className="text-xs text-slate-200 mt-0.5">
            Fixes AP Mode <code className="text-emerald-300">Port 53 Errno 98 (Address already in use)</code> by delegating{' '}
            <code className="text-emerald-300">captive_portal.run_dns_server</code> to the R36MAX AP worker, serves real{' '}
            <code className="text-emerald-300">final_firmware/barkeep.py + rrc_ui.py</code> on <code className="text-emerald-300">192.168.4.1:80</code>, and renders the{' '}
            <code className="text-emerald-300">FireFly_RK3326_R36MAX_R36S</code> UI.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => handleCopy('fast_update_top', fastUpdateSshDeploy)}
            className="px-4 py-2.5 rounded-lg text-xs font-bold flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg transition-colors cursor-pointer"
          >
            {copiedId === 'fast_update_top' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copiedId === 'fast_update_top'
              ? 'Copied v1.7.1 1-Paste CLI!'
              : 'Copy 1-Paste CLI Update (v1.7.1-r36max)'}
          </button>
          <button
            onClick={() => setSubView('deploy_ssh')}
            className="px-3 py-2.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 bg-[#182030] hover:bg-[#222d42] text-slate-200 border border-slate-700 transition-colors cursor-pointer"
          >
            <Terminal className="w-3.5 h-3.5 text-emerald-400" />
            View Full CLI Script
          </button>
        </div>
      </div>

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
            1. FireFly · Stump 720×720 Cockpit (v1.7.1)
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
            2. Authentic final_firmware Visitor Portal (192.168.4.1:80)
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
            3. 1-Paste CLI &amp; SSH Deploy (ark@r36max.local)
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
          {/* LEFT: 720x720 1:1 R36MAX Handheld Hardware Simulator (FireFly_RK3326_R36MAX_R36S UI) */}
          <div className="lg:col-span-5 bg-[#111621] border border-[#1E2638] rounded-2xl p-4 shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="text-[11px] font-mono uppercase tracking-wider text-amber-400 block">
                  FireFly_RK3326_R36MAX_R36S · 720×720 1:1 IPS · dArkOS
                </span>
                <h2 className="text-sm font-bold text-white">
                  FireFly · Stump Handheld Client ({STUMP_THEMES[themeName].label[lang]})
                </h2>
              </div>
              <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[11px] font-mono">
                v1.7.1-r36max
              </span>
            </div>

            {/* 1:1 Square 720x720 Simulated Screen */}
            <div
              className="relative w-full aspect-square rounded-xl overflow-hidden border-2 flex flex-col justify-between p-3 font-mono select-none shadow-inner transition-colors"
              style={{
                backgroundColor: palette.bg,
                color: palette.text,
                borderColor: palette.border,
              }}
            >
              {/* FireFly_RK3326_R36MAX_R36S Header Bar (firefly/ui/app.py) */}
              <div>
                <div
                  className="rounded-lg p-2.5 mb-2 border"
                  style={{ backgroundColor: palette.panel2, borderColor: palette.border }}
                >
                  <div className="flex items-center justify-between text-xs font-bold">
                    <span style={{ color: palette.ember }}>FireFly · Stump</span>
                    <span
                      className="px-2 py-0.5 rounded border text-[10px]"
                      style={{
                        backgroundColor: palette.panel,
                        color: camApActive ? '#9cb876' : palette.emberBright,
                        borderColor: camApActive ? '#9cb876' : palette.ember,
                      }}
                    >
                      {camApActive ? '● AP 192.168.4.1' : '● LAN 192.168.0.167'}
                    </span>
                  </div>
                  <div className="text-[10px] mt-1 flex flex-wrap justify-between gap-1" style={{ color: palette.text }}>
                    <span>
                      BARK/RRC WEB: {camApActive ? 'HTTP://192.168.4.1:80' : 'HTTP://192.168.0.167:80'} (:8080 OK)
                    </span>
                    <span style={{ color: stagedDirty ? palette.emberBright : palette.muted }}>
                      {stagedDirty ? 'SETUP: PENDING*' : 'v1.7.1-r36max'}
                    </span>
                  </div>
                  <div className="text-[10px] mt-0.5 flex items-center justify-between" style={{ color: palette.muted }}>
                    <span>
                      {camApActive
                        ? 'RT3070 AP: LaBuche-Stump (DHCP :67 + DNS :53)'
                        : `RT3070 LAN: ${joinedWifiSsid} (192.168.0.167)`}
                    </span>
                    <span>[A]:ACCEPT [B]:CANCEL</span>
                  </div>
                </div>

                {/* 5 FireFly Screen Tab Pills (CHATS, BOARD, FILES, NETWORK, SETUP) */}
                <div className="grid grid-cols-5 gap-1 mb-2">
                  {['1:CHATS', '2:BOARD', '3:FILES', '4:NETWORK', stagedDirty ? '5:SETUP*' : '5:SETUP'].map((label, idx) => {
                    const active = handheldTab === idx;
                    return (
                      <button
                        key={label}
                        onClick={() => {
                          setConfirmDeleteTarget(null);
                          setConfirmNetRevision(false);
                          setHandheldTab(idx);
                        }}
                        className="py-1 px-1 rounded text-[9px] font-bold border text-center truncate transition-transform active:scale-95"
                        style={{
                          backgroundColor: active ? palette.ember : palette.panel2,
                          color: active ? palette.bg : palette.muted,
                          borderColor: active ? palette.emberBright : palette.border,
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Prominent "IN PROCESS..." State Banner Overlay */}
              {simBusyMsg && (
                <div
                  className="mb-1.5 px-2.5 py-1.5 rounded border-2 text-[10px] font-bold text-center shadow-lg animate-pulse"
                  style={{
                    backgroundColor: palette.ember,
                    color: palette.bg,
                    borderColor: palette.emberBright,
                  }}
                >
                  {simBusyMsg}
                </div>
              )}

              {/* Center Viewport per Tab */}
              <div
                className="flex-1 rounded-lg p-2.5 border overflow-y-auto flex flex-col justify-between text-[11px]"
                style={{ backgroundColor: palette.bg, borderColor: palette.border }}
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
                              backgroundColor: activeRoom === r ? palette.panel : palette.panel2,
                              color: activeRoom === r ? palette.emberBright : palette.muted,
                              borderColor: activeRoom === r ? palette.ember : palette.border,
                            }}
                          >
                            #{r.toUpperCase()}
                            {roomTiers[r] !== 'open' ? `[${roomTiers[r].toUpperCase()}]` : ''}
                          </button>
                        ))}
                      </div>
                      {/* FireFly-style Chat Bubbles (firefly/ui/screens.py) */}
                      <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                        {roomMessages.slice(-6).map((m) => {
                          const isOut = !m.isSystem && (m.nick === session.nick || m.nick === 'r36max');
                          const isDm = m.body.startsWith('[DM]');
                          const isAct = m.body.startsWith('* ');
                          return (
                            <div
                              key={m.id}
                              className={`px-2 py-1 rounded border text-[10px] leading-snug break-words ${
                                isOut ? 'ml-10' : 'mr-6'
                              }`}
                              style={{
                                backgroundColor: isOut ? palette.panel : palette.panel2,
                                borderColor: isOut ? palette.ember : m.isSystem ? '#9cb876' : palette.border,
                              }}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span>
                                  <strong
                                    style={{
                                      color: m.isSystem
                                        ? palette.emberBright
                                        : isDm
                                        ? '#d8b4d8'
                                        : palette.ember,
                                    }}
                                  >
                                    &lt;{m.nick}&gt;
                                  </strong>{' '}
                                  <span
                                    style={{
                                      color: isDm
                                        ? '#c8a2c8'
                                        : isAct
                                        ? '#c8b48f'
                                        : m.isSystem
                                        ? palette.emberBright
                                        : palette.text,
                                    }}
                                  >
                                    {m.body}
                                  </span>
                                </span>
                                {isOut && (
                                  <span className="text-[9px] shrink-0" style={{ color: '#9cb876' }}>
                                    ✓✓
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* FireFly Composer & Quick Deck */}
                    <div className="mt-2 pt-1.5 border-t space-y-1" style={{ borderColor: palette.border }}>
                      <div
                        className="px-2 py-1 rounded border flex items-center justify-between text-[9px]"
                        style={{ backgroundColor: palette.panel2, borderColor: palette.border }}
                      >
                        <span style={{ color: chatInput ? '#9cb876' : palette.muted }}>
                          &gt; {chatInput || 'Type message...'}
                        </span>
                        <span style={{ color: palette.muted }}>
                          {chatInput.length}/295 B · 1 LoRa pkt
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-1">
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
                              className="text-left px-1.5 py-0.5 rounded text-[9px] truncate border"
                              style={{
                                backgroundColor: sel ? palette.ember : palette.panel2,
                                color: sel ? palette.bg : palette.text,
                                borderColor: sel ? palette.emberBright : palette.border,
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
                        <span className="text-[10px] font-bold" style={{ color: palette.emberBright }}>
                          BOARD ({posts.length} | {checkedBoardIds.length} CHECKED [X])
                        </span>
                        <button
                          onClick={() => {
                            const next: StumpBillboardPost = {
                              id: `p-${Date.now()}`,
                              title: 'R36MAX NODE ONLINE & RELAY READY',
                              body: 'Posted directly from R36MAX gamepad.',
                              sig: 'r36m',
                              createdAtSec: Math.floor(Date.now() / 1000),
                            };
                            setPosts([next, ...posts]);
                            triggerBusy('IN PROCESS: POSTING NOTICE TO BOARD...', 1200);
                            playChime(880, 60);
                          }}
                          className="px-1.5 py-0.5 rounded text-[9px] font-bold"
                          style={{ backgroundColor: palette.ember, color: palette.bg }}
                        >
                          + Post Notice
                        </button>
                      </div>
                      {posts.slice(0, 4).map((p) => {
                        const isChecked = checkedBoardIds.includes(p.id);
                        return (
                          <div
                            key={p.id}
                            onClick={() => {
                              setCheckedBoardIds((prev) =>
                                prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id]
                              );
                              playChime(600, 25);
                            }}
                            className="p-1.5 rounded border flex items-start justify-between gap-2 cursor-pointer"
                            style={{
                              backgroundColor: palette.panel2,
                              borderColor: isChecked ? palette.action : palette.border,
                            }}
                          >
                            <div className="flex items-start gap-1.5">
                              <span
                                className="font-bold text-[10px] shrink-0"
                                style={{ color: isChecked ? palette.action : palette.muted }}
                              >
                                [{isChecked ? 'X' : ' '}]
                              </span>
                              <div>
                                <div className="font-bold text-[10px]" style={{ color: palette.text }}>
                                  {p.title}
                                </div>
                                <div className="text-[9px] line-clamp-1" style={{ color: palette.muted }}>
                                  {p.body}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Check-first Action Bar: Backup to TF Card or Delete Checked */}
                    <div
                      className="p-1.5 rounded border flex items-center justify-between gap-1.5"
                      style={{ backgroundColor: palette.panel2, borderColor: palette.ember }}
                    >
                      <button
                        onClick={() => {
                          if (checkedBoardIds.length === 0) {
                            triggerBusy('CHECK [X] A NOTICE FIRST BEFORE BACKUP!', 1800);
                            playChime(320, 60);
                            return;
                          }
                          const fname = `billboard_backup_${Math.floor(Date.now() / 1000)}.json`;
                          setTfBackups((prev) => [fname, ...prev]);
                          addDebugLog(`Backed up ${checkedBoardIds.length} notices -> TF card (${fname})`);
                          triggerBusy(`IN PROCESS: SAVED ${checkedBoardIds.length} NOTICE(S) TO TF CARD!`, 1800);
                          playChime(840, 70);
                        }}
                        className="flex-1 py-1 px-1.5 rounded text-[9px] font-bold border text-center"
                        style={{
                          backgroundColor: palette.panel,
                          color: palette.action,
                          borderColor: palette.action,
                        }}
                      >
                        [Y] Backup Checked -&gt; TF ({checkedBoardIds.length})
                      </button>
                      <button
                        onClick={() => {
                          if (checkedBoardIds.length === 0) {
                            triggerBusy('CHECK [X] A NOTICE FIRST BEFORE DELETING!', 1800);
                            playChime(320, 60);
                            return;
                          }
                          setConfirmDeleteTarget({
                            type: 'board',
                            ids: checkedBoardIds,
                            label: `${checkedBoardIds.length} CHECKED BILLBOARD NOTICE(S)`,
                          });
                          playChime(540, 45);
                        }}
                        className="flex-1 py-1 px-1.5 rounded text-[9px] font-bold border text-center"
                        style={{
                          backgroundColor: palette.panel,
                          color: palette.emberBright,
                          borderColor: palette.emberBright,
                        }}
                      >
                        [X] Delete Checked ({checkedBoardIds.length})
                      </button>
                    </div>
                  </div>
                )}

                {handheldTab === 2 && (
                  <div className="space-y-2 flex flex-col justify-between h-full">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold" style={{ color: palette.emberBright }}>
                          FILES ({files.length} | {checkedFileNames.length} CHECKED [X])
                        </span>
                        <button
                          onClick={() => {
                            handleSimulateUpload(
                              `r36max_mesh_log_${String(Date.now()).slice(-4)}.txt`,
                              180_000,
                              'Live RRC chat & mesh telemetry report exported from R36MAX'
                            );
                            triggerBusy('IN PROCESS: SHARING FILE TO /SD/SHARED...', 1200);
                          }}
                          className="px-1.5 py-0.5 rounded text-[9px] font-bold"
                          style={{ backgroundColor: palette.ember, color: palette.bg }}
                        >
                          + Share File
                        </button>
                      </div>
                      <div className="space-y-1">
                        {files.map((f) => {
                          const isChecked = checkedFileNames.includes(f.name);
                          return (
                            <div
                              key={f.name}
                              onClick={() => {
                                setCheckedFileNames((prev) =>
                                  prev.includes(f.name) ? prev.filter((x) => x !== f.name) : [...prev, f.name]
                                );
                                playChime(600, 25);
                              }}
                              className="p-1.5 rounded border flex items-center justify-between gap-2 text-[10px] cursor-pointer"
                              style={{
                                backgroundColor: palette.panel2,
                                borderColor: isChecked ? palette.action : palette.border,
                              }}
                            >
                              <span className="truncate max-w-[180px]" style={{ color: palette.text }}>
                                <strong style={{ color: isChecked ? palette.action : palette.muted }}>
                                  [{isChecked ? 'X' : ' '}]
                                </strong>{' '}
                                {f.name}
                              </span>
                              <span style={{ color: palette.emberBright }}>
                                [{f.cat.toUpperCase()}] {Math.round(f.sizeBytes / 1024)}KB
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Check-first Action Bar: Backup Checked Files to TF Card or Delete Checked */}
                    <div
                      className="p-1.5 rounded border flex items-center justify-between gap-1.5"
                      style={{ backgroundColor: palette.panel2, borderColor: palette.ember }}
                    >
                      <button
                        onClick={() => {
                          if (checkedFileNames.length === 0) {
                            triggerBusy('CHECK [X] A FILE FIRST BEFORE BACKUP!', 1800);
                            playChime(320, 60);
                            return;
                          }
                          setTfBackups((prev) => [...checkedFileNames.map((n) => `bak_${n}`), ...prev]);
                          addDebugLog(`Backed up ${checkedFileNames.length} file(s) -> TF card`);
                          triggerBusy(`IN PROCESS: COPIED ${checkedFileNames.length} FILE(S) TO TF CARD!`, 1800);
                          playChime(840, 70);
                        }}
                        className="flex-1 py-1 px-1.5 rounded text-[9px] font-bold border text-center"
                        style={{
                          backgroundColor: palette.panel,
                          color: palette.action,
                          borderColor: palette.action,
                        }}
                      >
                        [Y] Backup Checked -&gt; TF ({checkedFileNames.length})
                      </button>
                      <button
                        onClick={() => {
                          if (checkedFileNames.length === 0) {
                            triggerBusy('CHECK [X] A FILE FIRST BEFORE DELETING!', 1800);
                            playChime(320, 60);
                            return;
                          }
                          setConfirmDeleteTarget({
                            type: 'file',
                            ids: checkedFileNames,
                            label: `${checkedFileNames.length} CHECKED FILE(S) IN /SD/SHARED`,
                          });
                          playChime(540, 45);
                        }}
                        className="flex-1 py-1 px-1.5 rounded text-[9px] font-bold border text-center"
                        style={{
                          backgroundColor: palette.panel,
                          color: palette.emberBright,
                          borderColor: palette.emberBright,
                        }}
                      >
                        [X] Delete Checked ({checkedFileNames.length})
                      </button>
                    </div>
                  </div>
                )}

                {handheldTab === 3 && (
                  <div className="space-y-2 flex flex-col justify-between h-full">
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] font-bold" style={{ color: palette.emberBright }}>
                          SELECT NETWORK TARGET (STAGES REVISION IN TAB 5)
                        </div>
                        <button
                          onClick={() => {
                            triggerBusy('IN PROCESS: SCANNING 2.4GHZ WIFI...', 1400);
                            setWifiSsids([
                              { ssid: 'Home-LAN-2.4G', signal: 94, sec: 'SAVED' },
                              { ssid: 'LaBuche-Relay-02', signal: 81, sec: 'OPEN' },
                              { ssid: 'FieldCamp-Net', signal: 68, sec: 'WPA2' },
                              { ssid: 'Phone-Hotspot', signal: 88, sec: 'WPA2' },
                            ]);
                            playChime(700, 50);
                          }}
                          className="text-[9px] px-1.5 py-0.5 rounded font-bold border"
                          style={{ color: palette.emberBright, borderColor: palette.border }}
                        >
                          Rescan SSIDs
                        </button>
                      </div>

                      {/* Row 0: Stage Radio Mode + Scanned Wi-Fi SSIDs (Stages into Tab 5 instead of changing immediately!) */}
                      <div className="mt-1.5 space-y-1">
                        <button
                          onClick={() => {
                            const nextAp = !stagedApMode;
                            setStagedApMode(nextAp);
                            setStagedDirty(true);
                            setHandheldTab(4);
                            addDebugLog(
                              `Staged revision in Tab 5: ${
                                nextAp ? 'STUMP AP (LaBuche-Stump 192.168.4.1)' : `LOCAL LAN (${stagedWifiSsid})`
                              }`
                            );
                            playChime(740, 55);
                          }}
                          className="w-full text-left px-2 py-1 rounded border flex items-center justify-between text-[10px] font-bold"
                          style={{
                            backgroundColor: stagedApMode ? palette.ember : palette.panel2,
                            color: stagedApMode ? palette.bg : palette.text,
                            borderColor: stagedApMode ? palette.emberBright : palette.border,
                          }}
                        >
                          <span>
                            STAGE MODE: {stagedApMode ? 'STUMP AP 192.168.4.1' : 'LOCAL LAN WIFI DHCP'}
                          </span>
                          <span>[A: STAGE -&gt; TAB 5]</span>
                        </button>
                        {wifiSsids.map((w) => {
                          const isLiveConn = !camApActive && joinedWifiSsid === w.ssid;
                          const isStagedTarget = !stagedApMode && stagedWifiSsid === w.ssid;
                          return (
                            <button
                              key={w.ssid}
                              onClick={() => {
                                setStagedApMode(false);
                                setStagedWifiSsid(w.ssid);
                                setStagedDirty(true);
                                setHandheldTab(4);
                                addDebugLog(`Staged LAN SSID '${w.ssid}' in Tab 5 for review before apply`);
                                playChime(740, 55);
                              }}
                              className="w-full text-left px-2 py-1 rounded border flex items-center justify-between text-[10px]"
                              style={{
                                backgroundColor: isStagedTarget ? palette.panel2 : 'transparent',
                                color: isLiveConn ? palette.action : palette.text,
                                borderColor: isStagedTarget ? palette.emberBright : palette.border,
                              }}
                            >
                              <span>
                                {isLiveConn ? '* ' : isStagedTarget ? '> ' : '  '}
                                {w.ssid}
                              </span>
                              <span style={{ color: palette.muted }}>
                                [{w.sec} {w.signal}%] [A: STAGE]
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      <div className="mt-1.5 flex items-center gap-1">
                        <input
                          type="text"
                          value={wifiPassInput}
                          onChange={(e) => {
                            setWifiPassInput(e.target.value);
                            setStagedDirty(true);
                          }}
                          placeholder="[Y] Wi-Fi Password (staged for Tab 5 review)"
                          className="flex-1 px-2 py-0.5 rounded text-[10px] border bg-black/20 outline-none"
                          style={{ borderColor: palette.border, color: palette.text }}
                        />
                        <button
                          onClick={() => setQrWifiJoin((v) => !v)}
                          className="px-2 py-0.5 rounded text-[9px] font-bold border shrink-0"
                          style={{
                            backgroundColor: palette.panel2,
                            color: palette.emberBright,
                            borderColor: palette.ember,
                          }}
                        >
                          [X] QR
                        </button>
                      </div>
                    </div>

                    {/* Real 25x25 ISO/IEC 18004 Version 2-L QR Code */}
                    <div className="flex items-center gap-3">
                      <div className="bg-white p-1.5 rounded-lg shadow-md shrink-0">
                        <div
                          className="grid"
                          style={{
                            gridTemplateColumns: 'repeat(25, minmax(0, 1fr))',
                            width: '75px',
                            height: '75px',
                          }}
                        >
                          {encodeQrVersion2L(
                            qrWifiJoin
                              ? 'WIFI:S:LaBuche-Stump;T:nopass;;'
                              : camApActive
                              ? 'http://192.168.4.1:80/'
                              : 'http://192.168.0.167:80/'
                          ).flatMap((row, rIdx) =>
                            row.map((bit, cIdx) => (
                              <div
                                key={`${rIdx}-${cIdx}`}
                                style={{
                                  width: '3px',
                                  height: '3px',
                                  backgroundColor: bit ? '#000000' : '#FFFFFF',
                                }}
                              />
                            ))
                          )}
                        </div>
                      </div>
                      <div className="text-[9px] space-y-0.5 leading-tight" style={{ color: palette.muted }}>
                        <div className="font-bold" style={{ color: palette.emberBright }}>
                          {qrWifiJoin
                            ? 'WIFI:S:LaBuche-Stump;T:nopass;;'
                            : camApActive
                            ? 'http://192.168.4.1:80/'
                            : 'http://192.168.0.167:80/'}
                        </div>
                        <div>• [A] stages target into Tab 5 · [B] cancels staged</div>
                        <div>• Multi-threaded Front-Door HTTP :80 &amp; :8080</div>
                        <div>• dnsmasq + ARP neighbor injection for 192.168.4.1</div>
                      </div>
                    </div>
                  </div>
                )}

                {handheldTab === 4 && (
                  <div className="space-y-1.5 flex flex-col justify-between h-full">
                    <div className="space-y-1.5">
                      <div
                        className="p-2 rounded border space-y-1 text-[9px]"
                        style={{
                          backgroundColor: palette.panel2,
                          borderColor: stagedDirty ? palette.emberBright : palette.border,
                        }}
                      >
                        <div className="flex items-center justify-between font-bold text-[10px]">
                          <span style={{ color: palette.emberBright }}>
                            NETWORK SETTINGS REVISION (REVIEW BEFORE APPLY)
                          </span>
                          <span style={{ color: stagedDirty ? palette.emberBright : palette.action }}>
                            {stagedDirty ? '[PENDING REVISION]' : '[IN SYNC]'}
                          </span>
                        </div>
                        <div style={{ color: palette.action }}>
                          LIVE NOW : {camApActive ? 'STUMP AP (LaBuche-Stump 192.168.4.1)' : `LOCAL LAN (${joinedWifiSsid} 192.168.0.167)`}
                        </div>
                        <div className="font-bold" style={{ color: stagedDirty ? palette.emberBright : palette.text }}>
                          STAGED   : {stagedApMode ? 'STUMP AP (LaBuche-Stump 192.168.4.1)' : `LOCAL LAN (${stagedWifiSsid} DHCP)`}{' '}
                          {!stagedApMode && wifiPassInput ? `[PASS: ${'*'.repeat(Math.min(8, wifiPassInput.length))}]` : '[OPEN/SAVED]'}
                        </div>

                        <div className="grid grid-cols-2 gap-1 pt-1">
                          <button
                            onClick={() => {
                              setStagedApMode((v) => !v);
                              setStagedDirty(true);
                              playChime(660, 40);
                            }}
                            className="py-1 px-1.5 rounded border font-bold text-[9px] text-left truncate"
                            style={{
                              backgroundColor: palette.panel,
                              color: palette.text,
                              borderColor: palette.border,
                            }}
                          >
                            1. Mode: {stagedApMode ? 'STUMP AP' : 'LOCAL LAN'}
                          </button>
                          <button
                            onClick={() => {
                              const idx = wifiSsids.findIndex((x) => x.ssid === stagedWifiSsid);
                              const next = wifiSsids[(idx + 1) % wifiSsids.length];
                              if (next) {
                                setStagedWifiSsid(next.ssid);
                                setStagedApMode(false);
                                setStagedDirty(true);
                              }
                              playChime(660, 40);
                            }}
                            className="py-1 px-1.5 rounded border font-bold text-[9px] text-left truncate"
                            style={{
                              backgroundColor: palette.panel,
                              color: palette.text,
                              borderColor: palette.border,
                            }}
                          >
                            2. SSID: {stagedWifiSsid}
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-1.5 pt-1">
                          <button
                            onClick={() => {
                              setConfirmNetRevision(true);
                              playChime(784, 55);
                            }}
                            className="py-1 px-1.5 rounded border font-bold text-[9px] text-center"
                            style={{
                              backgroundColor: palette.action,
                              color: palette.bg,
                              borderColor: palette.text,
                            }}
                          >
                            [A] ACCEPT &amp; APPLY REVISION
                          </button>
                          <button
                            onClick={() => {
                              setStagedApMode(camApActive);
                              setStagedWifiSsid(joinedWifiSsid);
                              setStagedDirty(false);
                              addDebugLog('Cancelled & reverted staged network revision to live state');
                              triggerBusy('REVERTED STAGED SETTINGS TO LIVE NETWORK STATE', 1400);
                              playChime(440, 45);
                            }}
                            className="py-1 px-1.5 rounded border font-bold text-[9px] text-center"
                            style={{
                              backgroundColor: palette.panel,
                              color: palette.emberBright,
                              borderColor: palette.emberBright,
                            }}
                          >
                            [B] CANCEL &amp; REVERT
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          onClick={() => {
                            const diagName = `stump_diag_${Math.floor(Date.now() / 1000)}.txt`;
                            setTfBackups((prev) => [diagName, ...prev]);
                            addDebugLog(`Exported full diagnostic & logs -> TF card (${diagName})`);
                            triggerBusy('IN PROCESS: EXPORTING LOGS & DIAG TO TF CARD...', 1800);
                            playChime(880, 75);
                          }}
                          className="p-1 rounded border text-[9px] font-bold text-center"
                          style={{
                            backgroundColor: palette.ember,
                            color: palette.bg,
                            borderColor: palette.emberBright,
                          }}
                        >
                          [Y] Export Diag+Logs -&gt; TF
                        </button>
                        <button
                          onClick={() => {
                            addDebugLog('Verified & healed visitor HTTP :80 and :8080 sockets');
                            triggerBusy('IN PROCESS: HEALING VISITOR HTTP :80/:8080...', 1500);
                            playChime(784, 70);
                          }}
                          className="p-1 rounded border text-[9px] font-bold text-center"
                          style={{
                            backgroundColor: palette.panel2,
                            color: palette.action,
                            borderColor: palette.action,
                          }}
                        >
                          [X] Heal Visitor HTTP :80/:8080
                        </button>
                      </div>

                      <div
                        className="p-1.5 rounded border space-y-0.5 max-h-24 overflow-y-auto text-[9px]"
                        style={{ backgroundColor: palette.panel2, borderColor: palette.border }}
                      >
                        <div className="font-bold uppercase" style={{ color: palette.muted }}>
                          v1.6.0-r36max SYSTEM &amp; RADIO LOGS (TF BACKUPS: {tfBackups.length}):
                        </div>
                        {debugLogs.map((l, i) => (
                          <div key={i} className="truncate" style={{ color: palette.text }}>
                            {l}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* "ARE YOU SURE?" Delete Confirmation Modal Overlay */}
              {confirmDeleteTarget && (
                <div
                  className="absolute inset-4 rounded-xl border-2 p-4 flex flex-col justify-between shadow-2xl z-20"
                  style={{
                    backgroundColor: palette.panel,
                    borderColor: palette.emberBright,
                  }}
                >
                  <div>
                    <div className="text-xs font-bold uppercase tracking-wide" style={{ color: palette.emberBright }}>
                      ⚠️ ARE YOU SURE YOU WANT TO ERASE?
                    </div>
                    <div className="text-[10px] mt-2" style={{ color: palette.muted }}>
                      {confirmDeleteTarget.type === 'board'
                        ? 'CHECKED BILLBOARD NOTICES TO ERASE:'
                        : 'CHECKED SHARED FILES TO ERASE:'}
                    </div>
                    <div
                      className="mt-1 p-2 rounded border text-xs font-bold break-all"
                      style={{ backgroundColor: palette.panel2, borderColor: palette.border, color: palette.text }}
                    >
                      {confirmDeleteTarget.label}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <button
                      onClick={() => {
                        setConfirmDeleteTarget(null);
                        playChime(480, 35);
                      }}
                      className="py-2 px-2 rounded font-bold text-[10px] border text-center"
                      style={{
                        backgroundColor: palette.action,
                        color: palette.bg,
                        borderColor: palette.text,
                      }}
                    >
                      &gt; NO, KEEP &lt;
                    </button>
                    <button
                      onClick={() => {
                        if (confirmDeleteTarget.type === 'board') {
                          setPosts((prev) => prev.filter((item) => !confirmDeleteTarget.ids.includes(item.id)));
                          setCheckedBoardIds([]);
                          addDebugLog(`Deleted ${confirmDeleteTarget.ids.length} checked notice(s)`);
                        } else {
                          setFiles((prev) => prev.filter((item) => !confirmDeleteTarget.ids.includes(item.name)));
                          setCheckedFileNames([]);
                          addDebugLog(`Deleted ${confirmDeleteTarget.ids.length} checked file(s)`);
                        }
                        triggerBusy('IN PROCESS: ERASING CHECKED ITEMS...', 1400);
                        setConfirmDeleteTarget(null);
                        playChime(440, 70);
                      }}
                      className="py-2 px-2 rounded font-bold text-[10px] border text-center"
                      style={{
                        backgroundColor: palette.ember,
                        color: palette.bg,
                        borderColor: palette.emberBright,
                      }}
                    >
                      [A] ACCEPT: ERASE!
                    </button>
                  </div>
                </div>
              )}

              {/* Staged Network Settings Revision Confirmation Modal Overlay */}
              {confirmNetRevision && (
                <div
                  className="absolute inset-4 rounded-xl border-2 p-4 flex flex-col justify-between shadow-2xl z-20"
                  style={{
                    backgroundColor: palette.panel,
                    borderColor: palette.emberBright,
                  }}
                >
                  <div>
                    <div className="text-xs font-bold uppercase tracking-wide" style={{ color: palette.emberBright }}>
                      APPLY STAGED NETWORK REVISION?
                    </div>
                    <div className="text-[10px] mt-2" style={{ color: palette.muted }}>
                      CURRENT LIVE NETWORK:
                    </div>
                    <div className="text-[10px] font-bold" style={{ color: palette.text }}>
                      {camApActive ? 'STUMP AP (LaBuche-Stump 192.168.4.1)' : `LOCAL LAN (${joinedWifiSsid} 192.168.0.167)`}
                    </div>
                    <div className="text-[10px] mt-2" style={{ color: palette.muted }}>
                      PROPOSED REVISION TO COMMIT:
                    </div>
                    <div
                      className="mt-1 p-2 rounded border text-xs font-bold break-all"
                      style={{ backgroundColor: palette.panel2, borderColor: palette.border, color: palette.action }}
                    >
                      {stagedApMode
                        ? 'MODE: STUMP AP (LaBuche-Stump · 192.168.4.1:80)'
                        : `MODE: LOCAL LAN WIFI (SSID: ${stagedWifiSsid})`}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <button
                      onClick={() => {
                        setConfirmNetRevision(false);
                        playChime(440, 40);
                      }}
                      className="py-2 px-2 rounded font-bold text-[10px] border text-center"
                      style={{
                        backgroundColor: palette.panel2,
                        color: palette.text,
                        borderColor: palette.border,
                      }}
                    >
                      [B] CANCEL / KEEP LIVE
                    </button>
                    <button
                      onClick={() => {
                        setCamApActive(stagedApMode);
                        if (!stagedApMode) {
                          setJoinedWifiSsid(stagedWifiSsid);
                        }
                        setStagedDirty(false);
                        setConfirmNetRevision(false);
                        triggerBusy(
                          stagedApMode
                            ? 'IN PROCESS: APPLYING STUMP AP 192.168.4.1...'
                            : `IN PROCESS: APPLYING LOCAL LAN '${stagedWifiSsid}'...`,
                          1800
                        );
                        addDebugLog(
                          stagedApMode
                            ? 'Applied revision -> STUMP AP LaBuche-Stump (192.168.4.1:80)'
                            : `Applied revision -> LOCAL LAN '${stagedWifiSsid}'`
                        );
                        playChime(880, 75);
                      }}
                      className="py-2 px-2 rounded font-bold text-[10px] border text-center"
                      style={{
                        backgroundColor: palette.action,
                        color: palette.bg,
                        borderColor: palette.emberBright,
                      }}
                    >
                      [A] ACCEPT &amp; APPLY!
                    </button>
                  </div>
                </div>
              )}

              {/* FireFly_RK3326_R36MAX_R36S Framed Keycap Hints Bar (firefly/ui/widgets.py) */}
              <div
                className="mt-2 py-1 px-2 rounded border text-[9px] flex flex-wrap items-center justify-between gap-1"
                style={{ backgroundColor: palette.panel2, borderColor: palette.border, color: palette.muted }}
              >
                {[
                  { k: 'A', v: handheldTab === 4 ? 'Apply' : 'Send/Ok' },
                  { k: 'B', v: 'Cancel' },
                  { k: 'Y', v: handheldTab === 1 || handheldTab === 2 ? 'TF-Save' : 'OSK' },
                  { k: 'X', v: handheldTab === 1 || handheldTab === 2 ? 'Delete' : '/Auth' },
                  { k: 'L/R', v: 'Tab' },
                ].map((h) => (
                  <span key={h.k} className="inline-flex items-center gap-1">
                    <span
                      className="px-1 rounded border font-bold"
                      style={{
                        backgroundColor: palette.panel,
                        borderColor: palette.border,
                        color: palette.text,
                      }}
                    >
                      {h.k}
                    </span>
                    <span>{h.v}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* Physical R36MAX Gamepad Controls Bar */}
            <div className="mt-3 grid grid-cols-4 gap-2">
              <button
                onClick={() => setHandheldTab((handheldTab + 1) % 5)}
                className="px-2.5 py-2 rounded-lg bg-[#182030] hover:bg-[#222d42] border border-slate-700 text-xs font-mono text-slate-200"
              >
                [R1] Next Tab (1..5)
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
                [A/B] Action
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
                AUTHENTIC FINAL_FIRMWARE VISITOR PORTAL (`final_firmware/barkeep.py` + `rrc_ui.py` + `theme.py`)
              </span>
              <h2 className="text-base font-bold text-white">
                What Walk-Up Visitors See at `http://192.168.4.1:80/` (v1.7.0-r36max)
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: 'home', label: '/ (Home)' },
                  { id: 'rrc', label: '/rrc (Chat)' },
                  { id: 'billboard', label: '/billboard' },
                  { id: 'files', label: '/files' },
                  { id: 'tools', label: '/tools' },
                  { id: 'about', label: '/about' },
                  { id: 'concierge', label: '/concierge' },
                ] as const
              ).map((rt) => (
                <button
                  key={rt.id}
                  onClick={() => setVisitorRoute(rt.id)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${
                    visitorRoute === rt.id
                      ? 'bg-amber-500 text-slate-950 font-bold'
                      : 'bg-[#0B0E14] text-slate-300 border border-slate-800 hover:text-white'
                  }`}
                >
                  {rt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Authentic final_firmware/barkeep.py + rrc_ui.py Viewport */}
          <div
            className="relative max-w-3xl mx-auto rounded-xl p-6 border shadow-2xl transition-colors"
            style={{
              backgroundColor: palette.bg,
              color: palette.text,
              borderColor: palette.border,
              fontFamily: visitorRoute === 'rrc' ? "'Courier New', monospace" : "Georgia, 'Palatino Linotype', serif",
            }}
          >
            {/* Top Language Bar (`layout.py` .langbar) */}
            <div className="text-right font-mono text-xs mb-1" style={{ color: palette.muted }}>
              {(['en', 'fr', 'es'] as StumpLang[]).map((l, idx) => (
                <React.Fragment key={l}>
                  {idx > 0 && <span className="mx-1">·</span>}
                  <button
                    onClick={() => setLang(l)}
                    className={lang === l ? 'font-bold underline' : 'hover:underline'}
                    style={{ color: lang === l ? palette.emberBright : palette.ember }}
                  >
                    {l}
                  </button>
                </React.Fragment>
              ))}
            </div>

            {visitorRoute === 'home' && (
              <div>
                <pre
                  className="text-xs leading-tight mb-2 font-mono overflow-x-auto"
                  style={{ color: palette.ember, textShadow: `0 0 8px ${palette.ember}44` }}
                >
                  {BARKEEP_ASCII_ART}
                </pre>
                <h1
                  className="text-xl font-bold font-mono pb-1.5 mb-2 border-b"
                  style={{ color: palette.ember, borderColor: palette.border }}
                >
                  Stump
                </h1>
                <p className="text-sm italic mb-4" style={{ color: palette.muted }}>
                  {lang === 'fr'
                    ? "Bienvenue, voyageur. Vous avez trouvé un noeud Stump — un petit coin tranquille hors-réseau. Laissez un mot sur le babillard, prenez un fichier sur l'étagère, ou entrez dans le salon."
                    : lang === 'es'
                    ? 'Bienvenido, viajero. Encontraste un nodo Stump — un rincón tranquilo fuera de la red. Deja una nota en el tablón, toma un archivo del estante o entra en la sala.'
                    : 'Welcome, wanderer. You have found a Stump node — a small, quiet corner off the grid. Leave a note on the board, pull a file from the shelf, or step into the chat room.'}
                </p>

                {/* Authentic .tiles Nav Grid from final_firmware/barkeep.py */}
                <div className="space-y-2.5 my-4">
                  {[
                    {
                      id: 'rrc' as const,
                      title:
                        lang === 'fr'
                          ? 'Entrer dans le salon (RRC)'
                          : lang === 'es'
                          ? 'Entrar a la sala de chat (RRC)'
                          : 'Step into the chat room (RRC)',
                      badge: `(${messages.length} msgs · 3 rooms)`,
                      icon: (
                        <svg viewBox="0 0 24 24" className="w-6 h-6 shrink-0" fill="none" stroke={palette.ember} strokeWidth="1.8">
                          <path d="M21 12c0 4-4 7-9 7-1.3 0-2.5-.2-3.6-.6L3 20l1.4-4.2C3.5 14.7 3 13.4 3 12c0-4 4-7 9-7s9 3 9 7z" />
                        </svg>
                      ),
                    },
                    {
                      id: 'billboard' as const,
                      title:
                        lang === 'fr'
                          ? 'Babillard communautaire'
                          : lang === 'es'
                          ? 'Tablón de anuncios'
                          : 'Bulletin board',
                      badge: `(${posts.length})`,
                      icon: (
                        <svg viewBox="0 0 24 24" className="w-6 h-6 shrink-0" fill="none" stroke={palette.ember} strokeWidth="1.8">
                          <path d="M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6zM12 14v7" />
                        </svg>
                      ),
                    },
                    {
                      id: 'files' as const,
                      title:
                        lang === 'fr'
                          ? 'Fichiers partagés'
                          : lang === 'es'
                          ? 'Archivos compartidos'
                          : 'Shared files',
                      badge: `(${files.length})`,
                      icon: (
                        <svg viewBox="0 0 24 24" className="w-6 h-6 shrink-0" fill="none" stroke={palette.ember} strokeWidth="1.8">
                          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                        </svg>
                      ),
                    },
                    {
                      id: 'tools' as const,
                      title:
                        lang === 'fr'
                          ? 'Applications & Outils hors-ligne'
                          : lang === 'es'
                          ? 'Aplicaciones y herramientas sin red'
                          : 'Offline tools & apps (FireFly)',
                      badge: `(${INITIAL_APPS.length})`,
                      icon: (
                        <svg viewBox="0 0 24 24" className="w-6 h-6 shrink-0" fill="none" stroke={palette.ember} strokeWidth="1.8">
                          <rect x="3" y="7" width="18" height="13" rx="2" />
                          <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 12h18" />
                        </svg>
                      ),
                    },
                    {
                      id: 'about' as const,
                      title:
                        lang === 'fr'
                          ? 'Projet Stump & Fireflies — À propos'
                          : lang === 'es'
                          ? 'Proyecto Stump & Fireflies — Acerca de'
                          : 'Projet Stump & Fireflies — About',
                      badge: '',
                      icon: (
                        <svg viewBox="0 0 24 24" className="w-6 h-6 shrink-0" fill="none" stroke={palette.ember} strokeWidth="1.8">
                          <circle cx="12" cy="12" r="9" />
                          <path d="M12 11v5M12 8h.01" />
                        </svg>
                      ),
                    },
                  ].map((tile) => (
                    <button
                      key={tile.id}
                      onClick={() => setVisitorRoute(tile.id)}
                      className="w-full text-left p-3.5 rounded border flex items-center gap-3.5 transition-colors font-mono text-sm"
                      style={{
                        backgroundColor: palette.panel,
                        borderColor: palette.border,
                        color: palette.emberBright,
                      }}
                    >
                      {tile.icon}
                      <span className="flex-1">
                        {tile.title}{' '}
                        {tile.badge && (
                          <span className="text-xs font-normal" style={{ color: palette.muted }}>
                            {tile.badge}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>

                {/* QR Footer matching barkeep.py */}
                <div
                  className="mt-5 pt-4 border-t flex items-center gap-4 text-xs font-mono"
                  style={{ borderColor: palette.border, color: palette.muted }}
                >
                  <div className="bg-white p-1.5 rounded shrink-0">
                    <div
                      className="grid"
                      style={{
                        gridTemplateColumns: 'repeat(25, minmax(0, 1fr))',
                        width: '60px',
                        height: '60px',
                      }}
                    >
                      {encodeQrVersion2L('http://192.168.4.1/').flatMap((row, rIdx) =>
                        row.map((bit, cIdx) => (
                          <div
                            key={`${rIdx}-${cIdx}`}
                            style={{
                              width: '2.4px',
                              height: '2.4px',
                              backgroundColor: bit ? '#1b1512' : '#f5ebd6',
                            }}
                          />
                        ))
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="font-bold" style={{ color: palette.emberBright }}>
                      http://192.168.4.1
                    </div>
                    <div>SSID: LaBuche-Stump · Open Walk-Up Node</div>
                    <div>FireFly Clients: /node.json &amp; /hw.json active</div>
                  </div>
                </div>
              </div>
            )}

            {visitorRoute === 'rrc' && (
              /* Authentic final_firmware/rrc_ui.py mIRC-style Two-Pane Web Client */
              <div className="border rounded overflow-hidden" style={{ borderColor: palette.border }}>
                <div
                  className="px-3 py-2 border-b flex items-center justify-between text-xs font-mono"
                  style={{ backgroundColor: palette.panel, borderColor: palette.border }}
                >
                  <div>
                    <strong style={{ color: palette.ember }}>RRC</strong>{' '}
                    <span style={{ color: palette.emberBright }}>#{activeRoom}</span>{' '}
                    <span style={{ color: palette.muted }}>
                      ({session.nick}
                      {session.verified ? ' ✓' : ''})
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: '#9cb876' }}>
                      <span className="w-2 h-2 rounded-full bg-[#9cb876] inline-block" /> LoRa + Chain OK
                    </span>
                    <button
                      onClick={() => setVisitorRoute('home')}
                      className="underline text-xs"
                      style={{ color: palette.ember }}
                    >
                      ← Stump
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 min-h-[300px]">
                  {/* Left #side Room List */}
                  <div
                    className="sm:col-span-3 border-b sm:border-b-0 sm:border-r p-2 text-xs font-mono space-y-1"
                    style={{ backgroundColor: palette.panel2, borderColor: palette.border }}
                  >
                    <div className="text-[10px] uppercase px-1.5 py-0.5" style={{ color: palette.muted }}>
                      Rooms
                    </div>
                    {roomOrder.map((rn) => (
                      <button
                        key={rn}
                        onClick={() => setActiveRoom(rn)}
                        className="w-full text-left px-2 py-1 rounded flex items-center justify-between"
                        style={{
                          backgroundColor: activeRoom === rn ? palette.panel : 'transparent',
                          color: activeRoom === rn ? palette.emberBright : palette.text,
                          fontWeight: activeRoom === rn ? 'bold' : 'normal',
                        }}
                      >
                        <span>#{rn}</span>
                        <span className="text-[10px]" style={{ color: palette.muted }}>
                          {rn === 'lora-mesh' ? 'LoRa' : rn === 'wifi-mesh' ? '🪵' : ''}
                        </span>
                      </button>
                    ))}
                  </div>

                  {/* Right #log + #bar */}
                  <div className="sm:col-span-9 flex flex-col justify-between">
                    <div className="p-3 space-y-1.5 max-h-64 overflow-y-auto text-xs font-mono">
                      {roomMessages.map((m) => (
                        <div key={m.id} className="leading-relaxed">
                          <span className="text-[10px] mr-1.5" style={{ color: palette.muted }}>
                            {m.ts}
                          </span>
                          {m.isSystem ? (
                            <span className="italic" style={{ color: palette.muted }}>
                              * {m.nick}: {m.body}
                            </span>
                          ) : (
                            <>
                              <strong style={{ color: palette.ember }}>&lt;{m.nick}&gt;</strong>{' '}
                              <span style={{ color: palette.text }}>{m.body}</span>
                            </>
                          )}
                        </div>
                      ))}
                    </div>

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        executeRrcLine(chatInput);
                        setChatInput('');
                      }}
                      className="p-2 border-t flex gap-2"
                      style={{ backgroundColor: palette.panel, borderColor: palette.border }}
                    >
                      <input
                        type="text"
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        placeholder={`Message #${activeRoom} or /help, /nick, /join, !find, !roll 2d6...`}
                        className="flex-1 px-2.5 py-1.5 rounded border text-xs font-mono outline-none"
                        style={{ backgroundColor: palette.bg, color: palette.text, borderColor: palette.border }}
                      />
                      <button
                        type="submit"
                        className="px-3 py-1.5 rounded font-mono font-bold text-xs"
                        style={{ backgroundColor: palette.ember, color: palette.bg }}
                      >
                        Send
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            )}

            {visitorRoute === 'billboard' && (
              /* Authentic final_firmware/billboard.py + barkeep.py Bulletin Board */
              <div>
                <h1
                  className="text-lg font-bold font-mono pb-1.5 mb-3 border-b"
                  style={{ color: palette.ember, borderColor: palette.border }}
                >
                  Bulletin Board
                </h1>

                <div className="flex gap-2 mb-3 font-mono text-xs">
                  <input
                    type="search"
                    value={boardSearch}
                    onChange={(e) => setBoardSearch(e.target.value)}
                    placeholder="Filter notices..."
                    className="flex-1 px-2.5 py-1.5 rounded border outline-none"
                    style={{ backgroundColor: palette.panel, color: palette.text, borderColor: palette.border }}
                  />
                </div>

                <div className="space-y-2 mb-4">
                  {posts
                    .filter(
                      (p) =>
                        !boardSearch.trim() ||
                        p.title.toLowerCase().includes(boardSearch.toLowerCase()) ||
                        p.body.toLowerCase().includes(boardSearch.toLowerCase())
                    )
                    .map((p, idx) => (
                      <details
                        key={p.id}
                        open={idx === 0}
                        className="rounded border px-3 py-2"
                        style={{ backgroundColor: palette.panel, borderColor: palette.border }}
                      >
                        <summary className="cursor-pointer font-mono text-sm flex items-center justify-between">
                          <span className="font-bold" style={{ color: palette.emberBright }}>
                            {p.title}
                          </span>
                          <span className="text-xs" style={{ color: palette.muted }}>
                            — {p.sig}
                          </span>
                        </summary>
                        <div
                          className="mt-2 pt-2 border-t text-sm whitespace-pre-wrap"
                          style={{ borderColor: palette.border, color: palette.text }}
                        >
                          {p.body}
                        </div>
                      </details>
                    ))}
                </div>

                <form
                  onSubmit={handleAddPost}
                  className="p-3.5 rounded border space-y-2 font-mono text-xs"
                  style={{ backgroundColor: palette.panel, borderColor: palette.border }}
                >
                  <div className="font-bold" style={{ color: palette.emberBright }}>
                    Leave a notice on the board
                  </div>
                  <input
                    type="text"
                    value={newPostTitle}
                    onChange={(e) => setNewPostTitle(e.target.value)}
                    placeholder="Title..."
                    className="w-full px-2.5 py-1.5 rounded border"
                    style={{ backgroundColor: palette.bg, color: palette.text, borderColor: palette.border }}
                  />
                  <textarea
                    value={newPostBody}
                    onChange={(e) => setNewPostBody(e.target.value)}
                    placeholder="Message body..."
                    rows={2}
                    className="w-full px-2.5 py-1.5 rounded border"
                    style={{ backgroundColor: palette.bg, color: palette.text, borderColor: palette.border }}
                  />
                  <button
                    type="submit"
                    className="px-4 py-1.5 rounded font-bold"
                    style={{ backgroundColor: palette.ember, color: palette.bg }}
                  >
                    Post
                  </button>
                </form>

                <div className="mt-3 font-mono text-xs">
                  <button onClick={() => setVisitorRoute('home')} className="underline" style={{ color: palette.ember }}>
                    ← Back to Stump
                  </button>
                </div>
              </div>
            )}

            {visitorRoute === 'files' && (
              /* Authentic final_firmware/fserv.py + barkeep.py Shared File Shelf */
              <div>
                <h1
                  className="text-lg font-bold font-mono pb-1.5 mb-3 border-b"
                  style={{ color: palette.ember, borderColor: palette.border }}
                >
                  Shared Files
                </h1>

                <div className="flex flex-wrap gap-1.5 mb-3 font-mono text-xs">
                  {['all', 'document', 'music', 'image'].map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setFileCatFilter(cat)}
                      className="px-2.5 py-1 rounded border uppercase"
                      style={{
                        backgroundColor: fileCatFilter === cat ? palette.ember : palette.panel,
                        color: fileCatFilter === cat ? palette.bg : palette.text,
                        borderColor: palette.border,
                      }}
                    >
                      {cat}
                    </button>
                  ))}
                </div>

                <ul className="space-y-1.5 mb-4 font-mono text-xs">
                  {files
                    .filter((f) => fileCatFilter === 'all' || f.cat === fileCatFilter)
                    .map((f) => (
                      <li
                        key={f.name}
                        className="p-2.5 rounded border flex items-center justify-between gap-3"
                        style={{ backgroundColor: palette.panel, borderColor: palette.border }}
                      >
                        <div className="min-w-0">
                          <div className="font-bold truncate" style={{ color: palette.emberBright }}>
                            📄 {f.name}
                          </div>
                          {f.description && (
                            <div className="text-[11px] italic truncate" style={{ color: palette.muted }}>
                              {f.description}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0" style={{ color: palette.muted }}>
                          {Math.round(f.sizeBytes / 1024)} KB
                        </span>
                      </li>
                    ))}
                </ul>

                <div className="mt-3 font-mono text-xs">
                  <button onClick={() => setVisitorRoute('home')} className="underline" style={{ color: palette.ember }}>
                    ← Back to Stump
                  </button>
                </div>
              </div>
            )}

            {visitorRoute === 'tools' && (
              <div>
                <h1
                  className="text-lg font-bold font-mono pb-1.5 mb-3 border-b"
                  style={{ color: palette.ember, borderColor: palette.border }}
                >
                  Offline Tools &amp; Companion Apps
                </h1>
                <div className="space-y-2.5 mb-4 font-mono text-xs">
                  {INITIAL_APPS.map((app) => (
                    <div
                      key={app.file}
                      className="p-3.5 rounded border flex items-center justify-between gap-3"
                      style={{ backgroundColor: palette.panel, borderColor: palette.border }}
                    >
                      <div>
                        <div className="font-bold text-sm" style={{ color: palette.emberBright }}>
                          {app.app}{' '}
                          <span className="text-xs font-normal" style={{ color: palette.muted }}>
                            v{app.version}
                          </span>
                        </div>
                        <div className="text-xs mt-0.5" style={{ color: palette.muted }}>
                          {app.platform} · {app.file} ({Math.round(app.sizeBytes / 1024)} KB)
                        </div>
                      </div>
                      <span
                        className="px-2.5 py-1 rounded font-bold"
                        style={{ backgroundColor: palette.ember, color: palette.bg }}
                      >
                        Download
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 font-mono text-xs">
                  <button onClick={() => setVisitorRoute('home')} className="underline" style={{ color: palette.ember }}>
                    ← Back to Stump
                  </button>
                </div>
              </div>
            )}

            {visitorRoute === 'about' && (
              <div>
                <h1
                  className="text-lg font-bold font-mono pb-1.5 mb-3 border-b"
                  style={{ color: palette.ember, borderColor: palette.border }}
                >
                  Projet Stump &amp; Fireflies
                </h1>
                <div className="flex gap-1.5 mb-3 font-mono text-xs border-b pb-2" style={{ borderColor: palette.border }}>
                  {(
                    [
                      { id: 'about', label: 'About' },
                      { id: 'connect', label: 'How to Connect' },
                      { id: 'apps', label: 'Apps & Handhelds' },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setAboutSubTab(t.id)}
                      className="px-3 py-1 rounded border"
                      style={{
                        backgroundColor: aboutSubTab === t.id ? palette.ember : palette.panel,
                        color: aboutSubTab === t.id ? palette.bg : palette.ember,
                        borderColor: palette.border,
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                {aboutSubTab === 'about' && (
                  <div className="space-y-2 text-sm">
                    <p>
                      A <strong>Stump</strong> is a small, off-grid dead-drop and chat room tucked in a weatherproof box
                      or R36MAX pocket node. Anyone within Wi-Fi range can walk up, join its open hotspot (
                      <code>LaBuche-Stump</code>), and read the bulletin board, trade files, or step into the chat room.
                    </p>
                    <p>
                      <strong>Fireflies</strong> are the handhelds and phones people carry between Stumps — R36S/R36MAX
                      consoles running <code>FireFly_RK3326_R36MAX_R36S</code> and Android phones over LoRa RNodes.
                    </p>
                  </div>
                )}
                {aboutSubTab === 'connect' && (
                  <ol className="list-decimal list-inside space-y-1.5 text-sm">
                    <li>Join the open Wi-Fi network <code>LaBuche-Stump</code>.</li>
                    <li>Open <code>http://192.168.4.1</code> in any browser.</li>
                    <li>Use <code>/rrc</code> for chat, <code>/billboard</code> for notices, or <code>/files</code> for the shelf.</li>
                  </ol>
                )}
                {aboutSubTab === 'apps' && (
                  <div className="space-y-2 text-sm">
                    <p>
                      <strong>FireFly for RK3326 (R36MAX / R36S)</strong>: Native handheld client that auto-discovers
                      this Stump via <code>/node.json</code> and bridges <code>#lora-mesh</code> over Heltec V3 USB RNodes.
                    </p>
                  </div>
                )}
                <div className="mt-4 font-mono text-xs">
                  <button onClick={() => setVisitorRoute('home')} className="underline" style={{ color: palette.ember }}>
                    ← Back to Stump
                  </button>
                </div>
              </div>
            )}

            {visitorRoute === 'concierge' && (
              <div>
                <h1
                  className="text-lg font-bold font-mono pb-1.5 mb-2 border-b"
                  style={{ color: palette.ember, borderColor: palette.border }}
                >
                  BarKeep Concierge (`librarian.py`)
                </h1>
                <p className="text-xs italic mb-3" style={{ color: palette.muted }}>
                  Ask in English, Français, or Español about files on the shelf, notices on the board, or offline apps.
                </p>
                <div
                  className="p-3 rounded border mb-3 space-y-2 font-mono text-xs"
                  style={{ backgroundColor: palette.panel, borderColor: palette.border }}
                >
                  <div>
                    <strong style={{ color: palette.emberBright }}>You:</strong> {librarianQuery}
                  </div>
                  <div>
                    <strong style={{ color: palette.ember }}>BarKeep:</strong> Found {librarianLiveResult.files.length}{' '}
                    file(s), {librarianLiveResult.posts.length} notice(s), and {librarianLiveResult.apps.length} app(s)
                    matching your query.
                  </div>
                </div>
                <div className="mt-3 font-mono text-xs">
                  <button onClick={() => setVisitorRoute('home')} className="underline" style={{ color: palette.ember }}>
                    ← Back to Stump
                  </button>
                </div>
              </div>
            )}

            {/* Floating Firefly Librarian Button (`.ff-btn` in final_firmware/layout.py) */}
            <button
              onClick={() => setVisitorRoute(visitorRoute === 'concierge' ? 'home' : 'concierge')}
              title="Ask the Firefly Librarian"
              className="mt-4 ml-auto flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-mono shadow-lg transition-transform hover:scale-105"
              style={{
                backgroundColor: palette.panel,
                borderColor: palette.ember,
                color: palette.emberBright,
              }}
            >
              <span>✨</span>
              <span>Ask Firefly Concierge</span>
            </button>
          </div>
        </div>
      )}

      {subView === 'deploy_ssh' && (
        <div className="space-y-5">
          {/* Fast 1-Paste CLI Update (All 3 Files Bundled via Heredoc + SCP + Compile) */}
          <div className="bg-[#111621] border border-emerald-500/50 rounded-2xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div>
                <span className="text-xs font-mono uppercase tracking-wider text-emerald-400 block">
                  1-PASTE MAC TERMINAL CLI UPDATE · dArkOS (DEBIAN 13 TRIXIE + LINUX 4.4.189)
                </span>
                <h2 className="text-base font-bold text-white">
                  Write All 3 Files (`run_stump_r36max.py`, `stump_r36max_engine.c`, `LaBuche_Stump.sh`), SCP &amp; Compile
                </h2>
              </div>
              <button
                onClick={() => handleCopy('fast_update_tab', fastUpdateSshDeploy)}
                className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg cursor-pointer"
              >
                {copiedId === 'fast_update_tab' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copiedId === 'fast_update_tab' ? 'Copied 1-Paste CLI!' : 'Copy 1-Paste CLI Update'}
              </button>
            </div>
            <p className="text-xs text-slate-300 mb-3">
              Copy and paste this single block into your Mac terminal (password <code className="text-emerald-300">ark</code>).
              No manual file downloads needed—it writes all 3 files locally into <code className="text-emerald-300">~/r36max-deploy/</code>,
              uploads them to <code className="text-emerald-300">ark@r36max.local</code>, compiles with Cortex-A35 flags, and runs the smoke test:
            </p>
            <pre className="bg-[#0B0E14] border border-slate-800 rounded-xl p-4 text-[11px] font-mono text-emerald-300 overflow-x-auto max-h-80">
              {fastUpdateSshDeploy}
            </pre>
          </div>

          {/* One-Command Copy-Paste SSH Installer */}
          <div className="bg-[#111621] border border-amber-500/40 rounded-2xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div>
                <span className="text-xs font-mono uppercase tracking-wider text-amber-400 block">
                  FULL INITIAL INSTALLER (CLONES GITHUB REPO + COMPILES COCKPIT)
                </span>
                <h2 className="text-base font-bold text-white">
                  Clone `ruderigo/LaBuche-Stump` + Compile 720×720 SDL2 KMSDRM Cockpit on Your R36MAX
                </h2>
              </div>
              <button
                onClick={() => handleCopy('ssh_one_click', fullOneClickSshDeploy)}
                className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg cursor-pointer"
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
