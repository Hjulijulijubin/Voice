/**
 * End-to-end test with real app instances (separate profiles):
 *
 *  1. Alice creates a room; Bob and Carol join with the invite code only
 *     (rendezvous through a local Nostr relay — no server of ours involved).
 *  2. Signed chat messages reach everyone.
 *  3. The direct Alice↔Carol link is blocked: the overlay must route through Bob.
 *  4. Voice: Alice→Bob uses direct WebRTC Opus (10 ms frames, 256 kbps),
 *     Alice→Carol is relayed via Bob through the encrypted custom pipeline.
 *  5. Ultra-low-latency mode: 5 ms frames on the custom pipeline.
 *  6. A file is auto-replicated to every member (Carol's copy travels via Bob).
 *  7. Everyone deletes it → it disappears from every chat.
 *  8. Carol restarts and catches up on missed history.
 *
 *   xvfb-run -a npm run test:e2e
 *   E2E_EXECUTABLE=dist/linux-unpacked/voice xvfb-run -a npm run test:e2e   (packaged build)
 */
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Relay } = require('../../src/server/relay.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = path.join(os.tmpdir(), `voice-e2e-${process.pid}`);
const shots = process.env.E2E_SCREENSHOTS || work;
mkdirSync(shots, { recursive: true });
mkdirSync(work, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last})`);
}

// E2E_RELAYS=wss://nos.lol,wss://relay.damus.io runs the test over public Nostr relays.
const relay = new Relay({ port: 0, host: '127.0.0.1' });
const { port } = await relay.start();
const relays = process.env.E2E_RELAYS || `ws://127.0.0.1:${port}`;
console.log(`rendezvous via ${relays}`);

async function launch(name) {
  const exe = process.env.E2E_EXECUTABLE;
  const app = await electron.launch({
    executablePath: exe ? path.resolve(exe) : undefined,
    args: [...(exe ? [] : [root]), `--profile=e2e-${name}`, `--voice-name=${name}`, `--voice-relays=${relays}`, '--voice-no-lan', '--no-sandbox'],
    env: { ...process.env, VOICE_FAKE_MEDIA: '1', XDG_CONFIG_HOME: work },
  });
  const page = await app.firstWindow();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(`  [${name} ${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`  [${name} pageerror] ${e.message}`));
  await page.waitForFunction(() => window.__voice && window.__voice.rooms);
  return { name, app, page, ev: (fn, arg) => page.evaluate(fn, arg) };
}

const roster = (c) =>
  c.ev(() => window.__voice.current?.overlay.roster().map((m) => ({ name: m.info.name, direct: m.direct, path: m.route?.path })) || []);
const selfId = (c) => c.ev(() => window.__voice.current.selfId);

let A;
let B;
let C;
let failed = false;
try {
  A = await launch('Alice');
  const code = await A.ev(async () => (await window.__voice.createRoom('E2E Room')).code);
  assert.match(code, /^voice:[A-Za-z0-9_-]{43}$/);
  console.log(`✓ room created, invite code ${code.slice(0, 14)}…`);

  B = await launch('Bob');
  C = await launch('Carol');
  await B.ev((c) => window.__voice.joinRoom(c), code);
  await C.ev((c) => window.__voice.joinRoom(c), code);

  for (const c of [A, B, C]) {
    await until(async () => (await roster(c)).filter((m) => m.direct).length === 2, `${c.name} directly connected to 2 peers`, 45000);
  }
  console.log('✓ all three found each other via the invite code and connected directly');
  await until(async () => (await B.ev(() => window.__voice.current.name)) === 'E2E Room', 'room name synced');

  // Chat
  await A.page.fill('#composer-input', 'hello from **Alice**');
  await A.page.press('#composer-input', 'Enter');
  for (const c of [B, C]) await until(async () => (await c.page.textContent('#messages')).includes('hello from Alice'), `${c.name} got message`);
  console.log('✓ signed chat message delivered');

  // Smart routing: no direct Alice↔Carol connection
  const [idA, idB, idC] = await Promise.all([A, B, C].map(selfId));
  await A.ev((id) => window.__voice.current.overlay.blockDirect(id), idC);
  await C.ev((id) => window.__voice.current.overlay.blockDirect(id), idA);
  await until(async () => {
    const r = (await roster(A)).find((m) => m.name === 'Carol');
    return r && !r.direct && r.path?.join() === [idB, idC].join();
  }, 'Alice routes to Carol via Bob');
  console.log('✓ Alice→Carol routed via Bob (direct link blocked)');

  await C.page.fill('#composer-input', 'carol over the relay');
  await C.page.press('#composer-input', 'Enter');
  await until(async () => (await A.page.textContent('#messages')).includes('carol over the relay'), 'relayed chat');
  console.log('✓ chat through a relaying peer (end-to-end encrypted envelope)');

  // Voice
  for (const c of [A, B, C]) {
    await c.ev(() => {
      const s = window.__voice.settings;
      s.inputMode = 'open';
      s.echoCancellation = false;
      s.noiseSuppression = false;
      Object.assign(s.quality, { bitrate: 256000, stereo: true, frameMs: 10, cbr: true });
    });
    await c.page.click('[data-voice="voice"]');
  }
  await until(async () => (await A.page.$$('#channel-list .voice-member')).length === 3, 'all in voice');
  await A.ev(() => window.__voice.current.overlay.applyQuality());
  await until(async () => (await A.ev((id) => window.__voice.current.overlay.audioRoutes.get(id)?.mode, idC)) === 'relay', 'Alice uses a custom route to Carol');

  const m = () =>
    A.ev(async (id) => {
      const peer = window.__voice.current.overlay.peers.get(id);
      let out;
      (await peer.pc.getStats()).forEach((s) => s.type === 'outbound-rtp' && s.kind === 'audio' && (out = s));
      return { p: out?.packetsSent || 0, b: out?.bytesSent || 0, t: performance.now() };
    }, idB);
  await sleep(2000);
  const s1 = await m();
  await sleep(3000);
  const s2 = await m();
  const pps = ((s2.p - s1.p) * 1000) / (s2.t - s1.t);
  const kbps = ((s2.b - s1.b) * 8) / (s2.t - s1.t);
  console.log(`  Alice→Bob direct WebRTC: ${pps.toFixed(0)} pkt/s, ${kbps.toFixed(0)} kbps`);
  assert.ok(pps > 90 && pps < 110, 'native 10 ms frames');
  assert.ok(kbps > 200, 'native ~256 kbps');
  console.log('✓ direct WebRTC Opus: 10 ms frames, 256 kbps');

  const customRate = async (c) => {
    const n1 = await c.ev(() => window.__voice.media.packetsIn);
    const t1 = Date.now();
    await sleep(3000);
    const n2 = await c.ev(() => window.__voice.media.packetsIn);
    const counters = await c.ev(() => window.__voice.media.counters);
    return { pps: ((n2 - n1) * 1000) / (Date.now() - t1), counters };
  };
  const relayed = await customRate(C);
  console.log(`  Carol receives Alice via Bob: ${relayed.pps.toFixed(0)} pkt/s, worker ${JSON.stringify(relayed.counters)}`);
  assert.ok(relayed.pps > 90, 'Carol receives relayed audio');
  assert.ok(relayed.counters?.decoded > 50, 'relayed audio decodes');
  const bobPipeline = await B.ev(() => window.__voice.media.packetsIn);
  assert.equal(bobPipeline, 0, 'Bob only forwards; he never decodes Alice→Carol audio');
  console.log('✓ relayed voice: encrypted Opus forwarded by Bob without decoding, decoded by Carol');

  // Ultra mode on Alice: custom pipeline to everyone with 5 ms frames
  await A.ev(() => {
    window.__voice.settings.audioMode = 'ultra';
    window.__voice.settings.ultraFrameMs = 5;
    window.__voice.media.applySettings();
    window.__voice.current.overlay._recomputeRoutes();
  });
  await until(async () => (await A.ev((id) => window.__voice.current.overlay.audioRoutes.get(id)?.mode, idB)) === 'relay', 'ultra route to Bob');
  await sleep(2000);
  const ultra = await customRate(B);
  console.log(`  Bob receives in ultra mode: ${ultra.pps.toFixed(0)} pkt/s, worker ${JSON.stringify(ultra.counters)}`);
  assert.ok(ultra.pps > 180 && ultra.pps < 230, 'about 200 packets/s = 5 ms frames');
  console.log('✓ ultra-low-latency pipeline: 5 ms Opus frames');
  await A.ev(() => {
    window.__voice.settings.audioMode = 'auto';
    window.__voice.media.applySettings();
    window.__voice.current.overlay._recomputeRoutes();
  });

  // Files: auto-replication to all (Carol via Bob)
  const file = path.join(work, 'random.bin');
  writeFileSync(file, crypto.randomBytes(3 * 1024 * 1024 + 777));
  await A.page.setInputFiles('#file-input', file);
  for (const c of [A, B, C]) {
    await until(
      () => c.ev(() => [...document.querySelectorAll('.file-holders')].some((e) => e.textContent.startsWith('Stored on 3 devices'))),
      `${c.name} sees the file stored on 3 devices`,
      45000,
    );
  }
  console.log('✓ file auto-replicated to every member (Carol via relay), SHA-256 verified');

  // Everyone deletes → disappears from the chat
  for (const c of [A, B, C]) {
    await c.ev(() => {
      const f = window.__voice.current.files;
      return f.deleteLocal([...f.local.keys()][0]);
    });
  }
  for (const c of [A, B, C]) await until(async () => (await c.page.$$('[data-file]')).length === 0, `file gone for ${c.name}`);
  console.log('✓ deleted by everyone → removed from every chat');

  await A.page.screenshot({ path: path.join(shots, 'alice.png') });
  await C.page.screenshot({ path: path.join(shots, 'carol.png') });

  // Carol restarts; she missed a message meanwhile
  await C.app.close();
  await A.page.fill('#composer-input', 'sent while carol was away');
  await A.page.press('#composer-input', 'Enter');
  C = await launch('Carol');
  await until(async () => (await C.page.textContent('#messages')).includes('sent while carol was away'), 'Carol catches up after restart', 60000);
  console.log('✓ history synced after restart (rooms persist locally, no account)');
} catch (err) {
  failed = true;
  console.error('✗', err);
  for (const c of [A, B, C]) await c?.page.screenshot({ path: path.join(shots, `${c.name}-fail.png`) }).catch(() => {});
} finally {
  for (const c of [A, B, C]) await c?.app.close().catch(() => {});
  await relay.stop();
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? 'E2E FAILED' : 'E2E PASSED');
process.exit(failed ? 1 : 0);
