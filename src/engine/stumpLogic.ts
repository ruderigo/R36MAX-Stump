/**
 * Pure, decoupled logic for LaBuche-Stump (Project Stump Beta A v1.0.0-beta.34)
 * Ported for the R36MAX (RK3326 / ArkOS) Handheld Node & Workstation.
 *
 * Mirrors:
 *   - final_firmware/theme.py       (5 themes: amber, phosphor, oled, paper, tavern)
 *   - REF.md Part 1                 (/auth challenge-response over ASCII hex nonce, /whoami, AUTH_MODE vs room tiers)
 *   - final_firmware/librarian.py   (trilingual FR/EN/ES accent folding, intent detection, 6-char stemming, !find)
 *   - final_firmware/fserv.py       (file class detection, credit weights, 75% FIFO shared storage eviction)
 *   - final_firmware/rrc.py & packs (3 rooms: #main, #lora-mesh, #wifi-mesh + Tavern !roll, !8ball, !trout, !seen)
 */

export type StumpThemeName = 'amber' | 'phosphor' | 'oled' | 'paper' | 'tavern';
export type StumpLang = 'en' | 'fr' | 'es';
export type GlobalAuthMode = 'open' | 'hybrid' | 'mandatory';
export type RoomTier = 'open' | 'minted' | 'hybrid';
export type FileCategory = 'video' | 'music' | 'document' | 'image' | 'other';

export interface StumpThemePalette {
  name: StumpThemeName;
  label: Record<StumpLang, string>;
  bg: string;
  panel: string;
  panel2: string;
  line: string;
  ember: string;
  emberBright: string;
  text: string;
  muted: string;
  border: string;
  dim: string;
  action: string;
  dm: string;
  dmNick: string;
  err: string;
}

/**
 * Exact theme palettes from final_firmware/theme.py and packs/tavern-pack/pack.json
 */
export const STUMP_THEMES: Record<StumpThemeName, StumpThemePalette> = {
  amber: {
    name: 'amber',
    label: { en: 'Amber', fr: 'Ambre', es: 'Ámbar' },
    bg: '#1b1512',
    panel: '#2a2119',
    panel2: '#221b15',
    line: '#2f271e',
    ember: '#d97a3a',
    emberBright: '#f0a050',
    text: '#ecdfc8',
    muted: '#9c8d76',
    border: '#493c2e',
    dim: '#7d715f',
    action: '#c8b48f',
    dm: '#c8a2c8',
    dmNick: '#d8b4d8',
    err: '#e07a5a',
  },
  phosphor: {
    name: 'phosphor',
    label: { en: 'Phosphor', fr: 'Phosphore', es: 'Fósforo' },
    bg: '#0d140e',
    panel: '#142217',
    panel2: '#101b12',
    line: '#1a2d1e',
    ember: '#33ff66',
    emberBright: '#5cff85',
    text: '#d0f0d6',
    muted: '#5c8f68',
    border: '#1f3b25',
    dim: '#4f8a5c',
    action: '#a8d8b0',
    dm: '#8fd6c8',
    dmNick: '#b0e8dc',
    err: '#ff7a66',
  },
  oled: {
    name: 'oled',
    label: { en: 'OLED', fr: 'OLED', es: 'OLED' },
    bg: '#000000',
    panel: '#121212',
    panel2: '#0a0a0a',
    line: '#1c1c1c',
    ember: '#4da6ff',
    emberBright: '#80bfff',
    text: '#f0f0f0',
    muted: '#8a8a8a',
    border: '#2a2a2a',
    dim: '#7a7a7a',
    action: '#c8c8c8',
    dm: '#c8a2e8',
    dmNick: '#dcbcf5',
    err: '#ff6b6b',
  },
  paper: {
    name: 'paper',
    label: { en: 'Paper', fr: 'Papier', es: 'Papel' },
    bg: '#f5f2eb',
    panel: '#e8e3d5',
    panel2: '#eee9dd',
    line: '#ddd6c4',
    ember: '#a84814',
    emberBright: '#c25b1f',
    text: '#2c2825',
    muted: '#6b6355',
    border: '#d0c8b6',
    dim: '#6f6657',
    action: '#5e513b',
    dm: '#7a3f8c',
    dmNick: '#5e2f70',
    err: '#b3261e',
  },
  tavern: {
    name: 'tavern',
    label: { en: 'Tavern', fr: 'Taverne', es: 'Taberna' },
    bg: '#1a120b',
    panel: '#2b1d12',
    panel2: '#22170e',
    line: '#3a2817',
    ember: '#e0a040',
    emberBright: '#f5c063',
    text: '#f0e2c8',
    muted: '#a8906c',
    border: '#4d3520',
    dim: '#8a7556',
    action: '#d6b88a',
    dm: '#c8a2c8',
    dmNick: '#d8b4d8',
    err: '#e8735a',
  },
};

export const BARKEEP_ASCII_ART = [
  '    )  (',
  '   (    )',
  ' .--------.',
  '/  o  o  o \\',
  '|          |',
  ' \\________/',
  '  |  |  |  |',
].join('\n');

// ============================================================================
// Part 1: Identity & Access Control (/auth challenge-response from REF.md)
// ============================================================================

export interface AuthSessionState {
  clientId: string;
  nick: string;
  verified: boolean;
  identityHash: string | null;
  pendingNonce: string | null;
  nonceIssuedAtMs: number | null;
  invitedRooms: string[];
}

export const AUTH_CHALLENGE_TTL_MS = 60_000;

export function isHexString(str: string, expectedLen?: number): boolean {
  if (!str || typeof str !== 'string') return false;
  if (expectedLen !== undefined && str.length !== expectedLen) return false;
  if (str.length % 2 !== 0) return false;
  return /^[0-9a-fA-F]+$/.test(str);
}

/**
 * Deterministic signature over the ASCII bytes of `nonceHex` (REF.md rule:
 * "the signed message is the ASCII bytes of the nonce's hex string — literally
 * nonce_hex.encode() — not the decoded nonce bytes").
 */
export function signAsciiNonceHex(pubkeyHex: string, nonceHex: string): string {
  if (!isHexString(pubkeyHex, 128) || !isHexString(nonceHex, 32)) {
    throw new Error('Invalid pubkeyHex (128 hex) or nonceHex (32 hex)');
  }
  // Compute a deterministic 64-byte (128-hex-char) signature over ASCII bytes of nonceHex + pubkeyHex
  const asciiBytes: number[] = [];
  for (let i = 0; i < nonceHex.length; i++) {
    asciiBytes.push(nonceHex.charCodeAt(i));
  }
  const outHex: string[] = [];
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < 64; i++) {
    const pkByte = parseInt(pubkeyHex.slice(i * 2, i * 2 + 2), 16);
    const asciiByte = asciiBytes[i % asciiBytes.length];
    h1 = Math.imul(h1 ^ pkByte ^ asciiByte, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((pkByte + i) & 0xff) ^ asciiByte, 0x811c9dc5) >>> 0;
    const mixed = ((h1 >>> ((i & 3) * 8)) ^ (h2 & 0xff)) & 0xff;
    outHex.push(mixed.toString(16).padStart(2, '0'));
  }
  return outHex.join('');
}

export function deriveIdentityHash(pubkeyHex: string): string {
  let hA = 0x6a09e667;
  let hB = 0xbb67ae85;
  let hC = 0x3c6ef372;
  let hD = 0xa54ff53a;
  for (let i = 0; i < pubkeyHex.length; i += 2) {
    const b = parseInt(pubkeyHex.slice(i, i + 2), 16) || 0;
    hA = Math.imul(hA ^ b, 0x01000193) >>> 0;
    hB = Math.imul(hB ^ ((b + i) & 0xff), 0x85ebca6b) >>> 0;
    hC = Math.imul(hC ^ ((b * 7) & 0xff), 0xc2b2ae35) >>> 0;
    hD = Math.imul(hD ^ ((b ^ 0x5a) & 0xff), 0x27d4eb2f) >>> 0;
  }
  return [hA, hB, hC, hD].map((w) => (w >>> 0).toString(16).padStart(8, '0')).join('');
}

export function generateNonceHex(seedMs: number): string {
  const parts: string[] = [];
  let s = (seedMs ^ 0xdeadd00d) >>> 0;
  for (let i = 0; i < 4; i++) {
    s = Math.imul(s ^ (s >>> 15), 0x735a2d97) >>> 0;
    parts.push(s.toString(16).padStart(8, '0'));
  }
  return parts.join('');
}

/**
 * Exact implementation of /auth wire protocol from REF.md.
 * Wire tokens AUTH-CHALLENGE, AUTH-OK, AUTH-FAIL are never translated.
 */
export function processAuthCommand(
  session: AuthSessionState,
  args: string[],
  nowMs: number,
  customNonce?: string
): { session: AuthSessionState; reply: string } {
  // Case 1: `/auth` with no args -> issue new 32-char hex nonce
  if (args.length === 0) {
    const nonce = (customNonce && isHexString(customNonce, 32))
      ? customNonce.toLowerCase()
      : generateNonceHex(nowMs);
    return {
      session: {
        ...session,
        pendingNonce: nonce,
        nonceIssuedAtMs: nowMs,
      },
      reply: `AUTH-CHALLENGE ${nonce}`,
    };
  }

  // Wrong number of arguments
  if (args.length !== 2) {
    return {
      session,
      reply: 'usage: /auth   (then)   /auth <pubkey_hex> <signature_hex>',
    };
  }

  const [pubkeyHex, sigHex] = args;

  // Check if challenge is pending
  if (!session.pendingNonce || session.nonceIssuedAtMs === null) {
    return {
      session,
      reply: 'AUTH-FAIL no challenge pending -- start with /auth',
    };
  }

  // Check 60s expiry
  if (nowMs - session.nonceIssuedAtMs > AUTH_CHALLENGE_TTL_MS) {
    return {
      session: {
        ...session,
        pendingNonce: null,
        nonceIssuedAtMs: null,
      },
      reply: 'AUTH-FAIL challenge expired -- start again with /auth',
    };
  }

  // Validate hex encoding (128 hex chars each)
  if (!isHexString(pubkeyHex) || !isHexString(sigHex)) {
    return {
      session,
      reply: 'AUTH-FAIL bad public key or signature encoding',
    };
  }

  if (pubkeyHex.length !== 128) {
    return {
      session,
      reply: 'AUTH-FAIL bad public key: expected 64-byte (128 hex) Ed25519/X25519 key',
    };
  }

  if (sigHex.length !== 128) {
    return {
      session,
      reply: 'AUTH-FAIL bad public key or signature encoding',
    };
  }

  const expectedSig = signAsciiNonceHex(pubkeyHex.toLowerCase(), session.pendingNonce);
  if (sigHex.toLowerCase() !== expectedSig.toLowerCase()) {
    return {
      session,
      reply: 'AUTH-FAIL signature does not match',
    };
  }

  // Single-use nonce consumed!
  const idHash = deriveIdentityHash(pubkeyHex.toLowerCase());
  return {
    session: {
      ...session,
      verified: true,
      identityHash: idHash,
      pendingNonce: null,
      nonceIssuedAtMs: null,
    },
    reply: `AUTH-OK ${idHash}`,
  };
}

/**
 * Evaluates whether a user session can post in a room given the two independent
 * systems documented in REF.md: Global AUTH_MODE and Per-Room Tier.
 */
export function evaluateRoomPostAccess(
  session: AuthSessionState,
  globalMode: GlobalAuthMode,
  roomName: string,
  roomTier: RoomTier
): { allowed: boolean; reason?: string } {
  // 1. Per-room tier is enforced unconditionally regardless of global mode
  if (roomTier === 'minted') {
    if (!session.verified) {
      return { allowed: false, reason: `Room #${roomName} is minted (invite-only): verify first with /auth` };
    }
    if (!session.invitedRooms.includes(roomName)) {
      return { allowed: false, reason: `Room #${roomName} is minted: your identity is not on the invite list` };
    }
  } else if (roomTier === 'hybrid') {
    if (!session.verified) {
      return { allowed: false, reason: `Room #${roomName} is tiered hybrid (read-only until verified with /auth)` };
    }
  }

  // 2. Global AUTH_MODE check (verified sessions are exempt from global hybrid/mandatory gates)
  if (session.verified) {
    return { allowed: true };
  }

  if (globalMode === 'mandatory') {
    return { allowed: false, reason: 'Node is in mandatory auth mode: verify with /auth before posting' };
  }
  if (globalMode === 'hybrid') {
    return { allowed: false, reason: 'Node is in hybrid auth mode: unverified visitors are read-only (run /auth)' };
  }

  return { allowed: true };
}

// ============================================================================
// Part 2: BarKeep Trilingual Librarian (final_firmware/librarian.py)
// ============================================================================

const ACCENT_FOLD_MAP: Record<string, string> = {};
const ACCENT_GROUPS: Array<[string, string]> = [
  ['a', 'àâäáãå'],
  ['e', 'éèêë'],
  ['i', 'îïíì'],
  ['o', 'ôöóòõ'],
  ['u', 'ùûüú'],
  ['c', 'ç'],
  ['n', 'ñ'],
  ['y', 'ÿý'],
];
for (const [plain, accented] of ACCENT_GROUPS) {
  for (const ch of accented) {
    ACCENT_FOLD_MAP[ch] = plain;
  }
}

const LIBRARIAN_STOP_WORDS = new Set(
  (
    'hey hi hello hola salut bonjour bonsoir allo yo please svp merci thanks gracias porfavor ' +
    'do does you your have has got any is are there something anything some about like want ' +
    'need looking find search show me my the a an of on for with what whats which new latest ' +
    'can could i we it to in at by or and any one ones ' +
    'tu as avez vous est ce que qu un une des du de la le les sur pour avec quelque chose ' +
    'il y a-t t je j me moi cherche veux voudrais avoir montre quoi nouveau nouveaux ' +
    'tienes tiene hay algo sobre de del el la los las un una unos unas para con que me ' +
    'busco quiero tengo muestra mostrar nuevo nuevos'
  ).split(/\s+/)
);

const LIBRARIAN_INTENTS: Record<string, string> = {
  video: 'movie movies film films video videos cinema pelicula peliculas watch regarder ver serie series',
  music:
    'music musique musica song songs chanson chansons cancion canciones audio podcast podcasts album albums listen ecouter escuchar',
  document:
    'book books livre livres libro libros read lire leer pdf doc docs document documents documento documentos zine zines guide guides manual manuals manuel text texte article articles',
  image:
    'photo photos image images picture pictures pic pics art drawing drawings dessin dessins imagen imagenes foto fotos',
  apps: 'app apps apk android firefly r36s rk3326 handheld console tool tools outil outils aplicacion aplicaciones herramienta herramientas',
  board:
    'billboard notice notices news event events annonce annonces avis aviso avisos board babillard tablon happening evenement evenements',
};

const WORD_TO_INTENT: Record<string, string> = {};
for (const [intentKey, wordStr] of Object.entries(LIBRARIAN_INTENTS)) {
  for (const w of wordStr.split(/\s+/)) {
    WORD_TO_INTENT[w] = intentKey;
  }
}

export function librarianFold(text: string): string {
  const out: string[] = [];
  for (const rawCh of text.toLowerCase()) {
    const ch = ACCENT_FOLD_MAP[rawCh] ?? rawCh;
    const isAlphaNum = /^[a-z0-9]$/.test(ch);
    out.push(isAlphaNum ? ch : ' ');
  }
  return out.join('');
}

export function librarianStem(word: string): string {
  if (word.length > 6) return word.slice(0, 6);
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function librarianParse(text: string): { intents: string[]; words: string[] } {
  const intents: string[] = [];
  const words: string[] = [];
  const tokens = librarianFold(text).split(/\s+/).filter(Boolean);
  for (const w of tokens) {
    const intent = WORD_TO_INTENT[w];
    if (intent) {
      if (!intents.includes(intent)) intents.push(intent);
    } else if (!LIBRARIAN_STOP_WORDS.has(w) && w.length > 1 && !words.includes(w)) {
      words.push(w);
    }
  }
  return { intents, words: words.slice(0, 6) };
}

export interface StumpSharedFile {
  name: string;
  sizeBytes: number;
  cat: FileCategory;
  mtimeSec: number;
  creditCost: number;
  description?: string;
}

export interface StumpBillboardPost {
  id: string;
  title: string;
  body: string;
  sig: string;
  createdAtSec: number;
}

export interface StumpToolApp {
  app: string;
  file: string;
  version: string;
  sizeBytes: number;
  platform: string;
}

export interface LibrarianSearchResult {
  topic: string;
  intents: string[];
  words: string[];
  files: StumpSharedFile[];
  posts: StumpBillboardPost[];
  apps: StumpToolApp[];
}

export function librarianSearch(
  query: string,
  shelfFiles: StumpSharedFile[],
  boardPosts: StumpBillboardPost[],
  toolApps: StumpToolApp[]
): LibrarianSearchResult {
  const { intents, words } = librarianParse(query);
  const stems = words.map(librarianStem);

  const fileCats: FileCategory[] = ['video', 'music', 'document', 'image'];
  const requestedCat = fileCats.find((c) => intents.includes(c)) ?? null;

  let matchedFiles = shelfFiles.filter((f) => {
    if (requestedCat && f.cat !== requestedCat) return false;
    if (stems.length === 0) return Boolean(requestedCat);
    const hay = librarianFold(`${f.name} ${f.description ?? ''}`);
    return stems.some((st) => hay.includes(st));
  });

  if (matchedFiles.length === 0 && requestedCat) {
    matchedFiles = shelfFiles.filter((f) => f.cat === requestedCat);
  }

  const matchedPosts = boardPosts.filter((p) => {
    if (stems.length === 0) return intents.includes('board');
    const hay = librarianFold(`${p.title} ${p.body}`);
    return stems.some((st) => hay.includes(st));
  });

  const matchedApps = intents.includes('apps')
    ? toolApps
    : toolApps.filter((a) => {
        if (stems.length === 0) return false;
        const hay = librarianFold(`${a.app} ${a.file} ${a.platform}`);
        return stems.some((st) => hay.includes(st));
      });

  return {
    topic: words.join(' '),
    intents,
    words,
    files: matchedFiles.slice(0, 5),
    posts: matchedPosts.slice(0, 3),
    apps: matchedApps,
  };
}

// ============================================================================
// Part 3: File Shelf Classification & 75% FIFO Eviction (final_firmware/fserv.py)
// ============================================================================

export const DEFAULT_CREDIT_WEIGHTS: Record<FileCategory, number> = {
  video: 3,
  music: 2,
  document: 1,
  image: 1,
  other: 1,
};

export function guessFileCategory(filename: string): FileCategory {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  if (['mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'ogg', 'opus', 'flac', 'wav', 'm4a'].includes(ext)) return 'music';
  if (['pdf', 'txt', 'md', 'epub', 'html', 'doc', 'docx', 'rtf'].includes(ext)) return 'document';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  return 'other';
}

/**
 * Enforces fserv.py's 75% shared storage ceiling with FIFO eviction of oldest files.
 */
export function makeRoomFifo(
  existingFiles: StumpSharedFile[],
  incomingSizeBytes: number,
  totalQuotaBytes: number
): {
  ok: boolean;
  keptFiles: StumpSharedFile[];
  evictedFiles: StumpSharedFile[];
  ceilingBytes: number;
} {
  const ceilingBytes = Math.floor(totalQuotaBytes * 0.75);
  if (incomingSizeBytes > ceilingBytes) {
    return {
      ok: false,
      keptFiles: [...existingFiles],
      evictedFiles: [],
      ceilingBytes,
    };
  }

  // Sort ascending by mtimeSec so oldest files are evicted first
  const sorted = [...existingFiles].sort((a, b) => a.mtimeSec - b.mtimeSec);
  let currentUsed = sorted.reduce((acc, f) => acc + f.sizeBytes, 0);
  const evictedFiles: StumpSharedFile[] = [];

  while (sorted.length > 0 && currentUsed + incomingSizeBytes > ceilingBytes) {
    const oldest = sorted.shift()!;
    currentUsed -= oldest.sizeBytes;
    evictedFiles.push(oldest);
  }

  return {
    ok: currentUsed + incomingSizeBytes <= ceilingBytes,
    keptFiles: sorted,
    evictedFiles,
    ceilingBytes,
  };
}

// ============================================================================
// Part 4: Real ISO/IEC 18004 QR Code Encoder (Version 2-L, 25x25, Byte Mode)
// ============================================================================

/**
 * Encodes a URL string (up to 32 bytes) into a standards-compliant 25x25
 * ISO/IEC 18004 QR Code matrix (Version 2, Error Correction Level L, Mask 0).
 */
export function encodeQrVersion2L(text: string): number[][] {
  const bytes = Array.from(new TextEncoder().encode(text)).slice(0, 32);
  const bits: number[] = [0, 1, 0, 0]; // Byte mode indicator (0100)
  for (let i = 7; i >= 0; i--) bits.push((bytes.length >> i) & 1);
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  }
  const term = Math.min(4, 272 - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Array<number>(34).fill(0);
  const byteLen = bits.length >> 3;
  for (let i = 0; i < byteLen; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    data[i] = v;
  }
  const pads = [0xec, 0x11];
  for (let i = byteLen; i < 34; i++) {
    data[i] = pads[(i - byteLen) % 2];
  }

  // GF(256) with primitive polynomial 0x11D
  const exp = new Array<number>(512).fill(0);
  const log = new Array<number>(256).fill(0);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];

  // Generator polynomial for 10 Reed-Solomon ECC codewords
  let gen = [1];
  for (let i = 0; i < 10; i++) {
    const nxt = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      const c = gen[j];
      nxt[j] ^= c;
      if (c !== 0) nxt[j + 1] ^= exp[log[c] + i];
    }
    gen = nxt;
  }

  const msg = [...data, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 34; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        if (gen[j] !== 0) msg[i + j] ^= exp[log[gen[j]] + log[coef]];
      }
    }
  }
  const codewords = [...data, ...msg.slice(34)];

  const N = 25;
  const grid: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  const isFunc: boolean[][] = Array.from({ length: N }, () => new Array<boolean>(N).fill(false));

  const setFn = (r: number, c: number, val: boolean) => {
    if (r >= 0 && r < N && c >= 0 && c < N) {
      grid[r][c] = val ? 1 : 0;
      isFunc[r][c] = true;
    }
  };

  const finder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r >= 0 && r < N && c >= 0 && c < N) {
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (dr === 0 || dr === 6 || dc === 0 || dc === 6);
          const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setFn(r, c, inOuter || inInner);
        }
      }
    }
  };

  finder(0, 0);
  finder(0, N - 7);
  finder(N - 7, 0);

  // Version 2 Alignment pattern at (18, 18)
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      setFn(18 + dr, 18 + dc, dist === 0 || dist === 2);
    }
  }

  // Timing patterns
  for (let i = 8; i < N - 8; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // Dark module & reserved format areas
  setFn(N - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!isFunc[8][i]) setFn(8, i, false);
    if (!isFunc[i][8]) setFn(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunc[8][N - 1 - i]) setFn(8, N - 1 - i, false);
    if (!isFunc[N - 1 - i][8]) setFn(N - 1 - i, 8, false);
  }

  // 44 codewords (352 bits) + 7 remainder bits
  const allBits: number[] = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) allBits.push((cw >> i) & 1);
  }
  for (let i = 0; i < 7; i++) allBits.push(0);

  let bitIdx = 0;
  let up = true;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < N; step++) {
      const r = up ? N - 1 - step : step;
      for (let dc = 0; dc >= -1; dc--) {
        const c = col + dc;
        if (!isFunc[r][c]) {
          let b = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
          if ((r + c) % 2 === 0) b ^= 1; // Mask 0
          grid[r][c] = b;
        }
      }
    }
    up = !up;
  }

  // Format bits for Level L (01), Mask 0 (000) -> 0x77C4
  const fmt = 0x77c4;
  const fBits = Array.from({ length: 15 }, (_, i) => (fmt >> i) & 1);
  const tlCoords: Array<[number, number]> = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = tlCoords[i];
    grid[r][c] = fBits[14 - i];
  }
  for (let i = 0; i < 7; i++) grid[N - 1 - i][8] = fBits[14 - i];
  for (let i = 7; i < 15; i++) grid[8][N - 15 + i] = fBits[14 - i];

  return grid;
}

