/**
 * End-to-end test: two real app instances (separate profiles) connect to a
 * signaling server, open a direct WebRTC connection, chat, join voice with a
 * synthetic microphone, verify the negotiated Opus parameters / packet rate,
 * and transfer a file peer-to-peer.
 *
 *   npm run test:e2e          (Linux CI: wrap with xvfb-run)
 *   E2E_EXECUTABLE=dist/linux-unpacked/voice npm run test:e2e   (packaged build)
 */
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { SignalingServer } = require('../../src/server/signaling.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shotDir = process.env.E2E_SCREENSHOTS || path.join(os.tmpdir(), 'voice-e2e');
mkdirSync(shotDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 20000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last})`);
}

const server = new SignalingServer({ port: 0, host: '127.0.0.1', name: 'E2E Server' });
const { port } = await server.start();
console.log(`signaling on ${port}`);

async function launch(name) {
  const profile = `e2e-${name}-${process.pid}`;
  const appData = path.join(os.tmpdir(), `voice-e2e-appdata-${process.pid}`);
  // E2E_EXECUTABLE=dist/linux-unpacked/voice tests a packaged build instead of the sources.
  const exe = process.env.E2E_EXECUTABLE;
  const app = await electron.launch({
    executablePath: exe ? path.resolve(exe) : undefined,
    args: [...(exe ? [] : [root]), `--profile=${profile}`, `--voice-name=${name}`, `--voice-connect=127.0.0.1:${port}`, '--no-sandbox'],
    env: { ...process.env, VOICE_FAKE_MEDIA: '1', XDG_CONFIG_HOME: appData },
  });
  const page = await app.firstWindow();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name} ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[${name} pageerror] ${e.message}`));
  return { app, page, appData };
}

const A = await launch('Alice');
const B = await launch('Bob');
let failed = false;

try {
  // 1. Both connected to the server and to each other.
  for (const c of [A, B]) await c.page.waitForSelector('#main-view:not(.hidden)', { timeout: 20000 });
  await until(
    async () => (await A.page.evaluate(() => [...window.__voice.mesh.peers.values()].map((p) => p.state))).includes('connected'),
    'A↔B peer connection',
  );
  await until(async () => B.page.evaluate(() => window.__voice.mesh.openPeers().length === 1), 'B data channel open');
  console.log('✓ peers connected directly');

  // 2. Chat
  await A.page.fill('#composer-input', 'hello from **Alice** https://example.com');
  await A.page.press('#composer-input', 'Enter');
  await until(async () => (await B.page.textContent('#messages')).includes('hello from Alice'), 'message delivered');
  console.log('✓ chat message delivered');

  // 3. Voice with a forced CBR 256 kbps stereo, 10 ms frames
  for (const c of [A, B]) {
    await c.page.evaluate(() => {
      const v = window.__voice;
      v.settings.inputMode = 'open';
      v.settings.echoCancellation = false;
      v.settings.noiseSuppression = false;
      Object.assign(v.settings.quality, { bitrate: 256000, stereo: true, frameMs: 10, cbr: true });
    });
  }
  await A.page.click('[data-voice="lounge"]');
  await B.page.click('[data-voice="lounge"]');
  await until(async () => (await B.page.$$('#channel-list .voice-member')).length === 2, 'both in voice');

  // Measure packets/s and bitrate from Alice's sender.
  const measure = () =>
    A.page.evaluate(async () => {
      const peer = [...window.__voice.mesh.peers.values()][0];
      const report = await peer.pc.getStats();
      let out = null;
      let codec = null;
      report.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'audio') out = s;
      });
      if (out) codec = report.get(out.codecId);
      return { packets: out?.packetsSent ?? 0, bytes: out?.bytesSent ?? 0, t: performance.now(), fmtp: codec?.sdpFmtpLine, channels: codec?.channels };
    });
  await sleep(2000);
  const s1 = await measure();
  await sleep(3000);
  const s2 = await measure();
  const pps = ((s2.packets - s1.packets) * 1000) / (s2.t - s1.t);
  const kbps = ((s2.bytes - s1.bytes) * 8) / (s2.t - s1.t);
  console.log(`  sender: ${pps.toFixed(1)} packets/s, ${kbps.toFixed(0)} kbps, fmtp="${s2.fmtp}"`);
  assert.ok(pps > 90 && pps < 110, `expected ~100 packets/s for 10 ms frames, got ${pps}`);
  assert.ok(kbps > 200, `expected ~256 kbps CBR, got ${kbps}`);
  assert.match(s2.fmtp, /maxaveragebitrate=256000/);
  assert.match(s2.fmtp, /stereo=1/);
  console.log('✓ Opus: 10 ms frames, 256 kbps, stereo');

  const inbound = await B.page.evaluate(async () => {
    const peer = [...window.__voice.mesh.peers.values()][0];
    await peer.getStats();
    await new Promise((r) => setTimeout(r, 1500));
    return { stats: await peer.getStats(), jbTarget: peer.transceiver.receiver.jitterBufferTarget };
  });
  console.log(`  receiver: ${JSON.stringify(inbound)}`);
  assert.ok(inbound.stats.inKbps > 200, 'B receives the high bitrate stream');
  console.log('✓ receiver gets audio');

  // 4. Live quality change (renegotiation) to 128 kbps
  await A.page.evaluate(() => {
    window.__voice.settings.quality.bitrate = 128000;
    window.__voice.mesh.applyQuality();
  });
  await sleep(2500);
  const s3 = await measure();
  await sleep(2000);
  const s4 = await measure();
  const kbps2 = ((s4.bytes - s3.bytes) * 8) / (s4.t - s3.t);
  console.log(`  after change: ${kbps2.toFixed(0)} kbps, fmtp="${s4.fmtp}"`);
  assert.ok(kbps2 > 100 && kbps2 < 170, `expected ~128 kbps after live change, got ${kbps2}`);
  console.log('✓ live bitrate change');

  // 5. Peer-to-peer file transfer (3 MB) with integrity check
  const sentHash = await A.page.evaluate(async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024 + 123);
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, bytes.length)));
    const file = new File([bytes], 'random.bin', { type: 'application/octet-stream' });
    await window.__voice.shareFiles([file]);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  });
  await B.page.waitForSelector('.file-card .file-name:text("random.bin")', { timeout: 10000 });
  await B.page.click('.file-card .icon-btn');
  const gotHash = await until(
    () =>
      B.page.evaluate(async () => {
        const files = window.__voice.files;
        const id = [...files.local.keys()][0];
        if (!id) return null;
        const blob = files.local.get(id);
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      }),
    'file download',
  );
  assert.equal(gotHash, sentHash);
  console.log('✓ file transferred P2P, SHA-256 matches');

  // 6. History sync: a third client joining later receives old messages.
  const C = await launch('Carol');
  try {
    await C.page.waitForSelector('#main-view:not(.hidden)', { timeout: 20000 });
    await until(async () => (await C.page.textContent('#messages')).includes('hello from Alice'), 'history sync to late joiner');
    console.log('✓ chat history synced to late joiner');
    await A.page.screenshot({ path: path.join(shotDir, 'alice.png') });
    await B.page.screenshot({ path: path.join(shotDir, 'bob.png') });
  } finally {
    await C.app.close();
    rmSync(C.appData, { recursive: true, force: true });
  }
} catch (err) {
  failed = true;
  console.error('✗', err);
  await A.page.screenshot({ path: path.join(shotDir, 'alice-fail.png') }).catch(() => {});
  await B.page.screenshot({ path: path.join(shotDir, 'bob-fail.png') }).catch(() => {});
} finally {
  await A.app.close();
  await B.app.close();
  await server.stop();
  rmSync(A.appData, { recursive: true, force: true });
}

console.log(failed ? 'E2E FAILED' : 'E2E PASSED');
process.exit(failed ? 1 : 0);
