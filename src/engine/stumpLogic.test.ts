import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STUMP_THEMES,
  AuthSessionState,
  processAuthCommand,
  signAsciiNonceHex,
  evaluateRoomPostAccess,
  librarianFold,
  librarianParse,
  librarianStem,
  librarianSearch,
  guessFileCategory,
  makeRoomFifo,
  StumpSharedFile,
  encodeQrVersion2L,
} from './stumpLogic.ts';

const TEST_PUBKEY_A = 'a1b2c3d4'.repeat(16); // 128 hex chars
const TEST_PUBKEY_B = 'f0e1d2c3'.repeat(16); // 128 hex chars

function freshSession(): AuthSessionState {
  return {
    clientId: 'r36max-local',
    nick: 'rodrigo',
    verified: false,
    identityHash: null,
    pendingNonce: null,
    nonceIssuedAtMs: null,
    invitedRooms: ['vip-ops'],
  };
}

test('REF.md /auth test matrix: fresh challenge -> valid ASCII nonce signature -> AUTH-OK and single-use consumption', () => {
  const s0 = freshSession();
  const c1 = processAuthCommand(s0, [], 1000);
  assert.match(c1.reply, /^AUTH-CHALLENGE [0-9a-f]{32}$/);
  const nonceHex = c1.reply.split(' ')[1];

  const sigHex = signAsciiNonceHex(TEST_PUBKEY_A, nonceHex);
  const c2 = processAuthCommand(c1.session, [TEST_PUBKEY_A, sigHex], 5000);
  assert.match(c2.reply, /^AUTH-OK [0-9a-f]{32}$/);
  assert.equal(c2.session.verified, true);
  assert.equal(c2.session.pendingNonce, null);

  // Reusing an already-consumed nonce fails with "no challenge pending"
  const c3 = processAuthCommand(c2.session, [TEST_PUBKEY_A, sigHex], 6000);
  assert.equal(c3.reply, 'AUTH-FAIL no challenge pending -- start with /auth');
});

test('REF.md /auth test matrix: no preceding /auth, expired challenge (>60s), wrong identity sig, and malformed hex', () => {
  const s0 = freshSession();

  // 1. Answer without preceding /auth
  const noChallenge = processAuthCommand(s0, [TEST_PUBKEY_A, '00'.repeat(64)], 1000);
  assert.equal(noChallenge.reply, 'AUTH-FAIL no challenge pending -- start with /auth');

  // 2. Expired challenge (61+ seconds later)
  const issued = processAuthCommand(s0, [], 10_000);
  const nonce = issued.reply.split(' ')[1];
  const validSig = signAsciiNonceHex(TEST_PUBKEY_A, nonce);
  const expired = processAuthCommand(issued.session, [TEST_PUBKEY_A, validSig], 10_000 + 61_000);
  assert.equal(expired.reply, 'AUTH-FAIL challenge expired -- start again with /auth');

  // 3. Signature from a different identity than pubkey claims
  const reissued = processAuthCommand(s0, [], 20_000);
  const nonce2 = reissued.reply.split(' ')[1];
  const wrongIdSig = signAsciiNonceHex(TEST_PUBKEY_B, nonce2);
  const mismatch = processAuthCommand(reissued.session, [TEST_PUBKEY_A, wrongIdSig], 22_000);
  assert.equal(mismatch.reply, 'AUTH-FAIL signature does not match');

  // 4. Malformed hex in pubkey or signature
  const malformed = processAuthCommand(reissued.session, ['zzzz_not_hex', wrongIdSig], 23_000);
  assert.equal(malformed.reply, 'AUTH-FAIL bad public key or signature encoding');
});

test('REF.md Global AUTH_MODE vs Per-Room Tier independence (the "hybrid" naming trap)', () => {
  const unverified = freshSession();
  const verified: AuthSessionState = { ...unverified, verified: true, identityHash: '12345678'.repeat(4) };

  // Global open, room open -> unverified can post
  assert.equal(evaluateRoomPostAccess(unverified, 'open', 'main', 'open').allowed, true);

  // Global open, room hybrid -> unverified blocked!
  assert.equal(evaluateRoomPostAccess(unverified, 'open', 'lora-mesh', 'hybrid').allowed, false);
  assert.equal(evaluateRoomPostAccess(verified, 'open', 'lora-mesh', 'hybrid').allowed, true);

  // Global hybrid, room open -> verified is exempt and allowed; unverified is read-only
  assert.equal(evaluateRoomPostAccess(unverified, 'hybrid', 'main', 'open').allowed, false);
  assert.equal(evaluateRoomPostAccess(verified, 'hybrid', 'main', 'open').allowed, true);

  // Minted room requires both verification AND invite
  assert.equal(evaluateRoomPostAccess(verified, 'open', 'vip-ops', 'minted').allowed, true);
  assert.equal(evaluateRoomPostAccess(verified, 'open', 'uninvited-room', 'minted').allowed, false);
});

test('librarian.py trilingual search (FR/EN/ES accent folding, stopword removal, stemming, and intent matching)', () => {
  assert.equal(librarianFold('As-tu un livre sur le jardinage ou la musique ?'), 'as tu un livre sur le jardinage ou la musique  ');
  assert.equal(librarianStem('gardening'), 'garden');
  assert.equal(librarianStem('books'), 'book');

  const parsedFr = librarianParse('Bonjour, as-tu un livre sur le jardinage ?');
  assert.deepEqual(parsedFr.intents, ['document']);
  assert.deepEqual(parsedFr.words, ['jardinage']);

  const parsedEs = librarianParse('Hola, ¿tienes algo de música o mapas de montaña?');
  assert.deepEqual(parsedEs.intents, ['music']);
  assert.ok(parsedEs.words.includes('mapas'));

  const files: StumpSharedFile[] = [
    { name: 'guide_jardinage_permaculture.pdf', sizeBytes: 420_000, cat: 'document', mtimeSec: 100, creditCost: 1 },
    { name: 'offline_topo_montana.pdf', sizeBytes: 950_000, cat: 'document', mtimeSec: 200, creditCost: 1 },
    { name: 'lo_fi_bivouac_session.ogg', sizeBytes: 3_100_000, cat: 'music', mtimeSec: 300, creditCost: 2 },
  ];

  const res = librarianSearch('as-tu un livre sur le jardinage ?', files, [], []);
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].name, 'guide_jardinage_permaculture.pdf');
});

test('fserv.py 75% shared shelf ceiling and FIFO oldest-file eviction', () => {
  assert.equal(guessFileCategory('field_map.pdf'), 'document');
  assert.equal(guessFileCategory('mesh_intro.mp4'), 'video');
  assert.equal(guessFileCategory('beacon.opus'), 'music');

  const quota = 1000; // 75% ceiling = 750 bytes
  const existing: StumpSharedFile[] = [
    { name: 'oldest.txt', sizeBytes: 300, cat: 'document', mtimeSec: 10, creditCost: 1 },
    { name: 'middle.txt', sizeBytes: 300, cat: 'document', mtimeSec: 20, creditCost: 1 },
  ];
  // Adding 300 bytes -> 600 + 300 = 900 > 750, so oldest.txt (mtime 10) must be evicted
  const fifo = makeRoomFifo(existing, 300, quota);
  assert.equal(fifo.ok, true);
  assert.equal(fifo.evictedFiles.length, 1);
  assert.equal(fifo.evictedFiles[0].name, 'oldest.txt');
  assert.equal(fifo.keptFiles.length, 1);
  assert.equal(fifo.keptFiles[0].name, 'middle.txt');
});

test('theme.py palettes define all 5 Stump themes (amber, phosphor, oled, paper, tavern)', () => {
  for (const key of ['amber', 'phosphor', 'oled', 'paper', 'tavern'] as const) {
    assert.ok(STUMP_THEMES[key].bg.startsWith('#'));
    assert.ok(STUMP_THEMES[key].ember.startsWith('#'));
  }
});

test('encodeQrVersion2L generates a standards-compliant 25x25 ISO/IEC 18004 QR matrix', () => {
  const qr1 = encodeQrVersion2L('http://192.168.0.167:8080/');
  const qr2 = encodeQrVersion2L('http://10.0.0.1:8080/');
  assert.equal(qr1.length, 25);
  assert.equal(qr1[0].length, 25);
  // Finder centers (3,3), (3,21), (21,3) and Alignment center (18,18) and Dark module (17,8) must be 1
  assert.equal(qr1[3][3], 1);
  assert.equal(qr1[3][21], 1);
  assert.equal(qr1[21][3], 1);
  assert.equal(qr1[18][18], 1);
  assert.equal(qr1[17][8], 1);
  // Different URLs produce different encoded data patterns
  assert.notDeepEqual(qr1, qr2);
});

