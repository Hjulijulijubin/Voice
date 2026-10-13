/**
 * Media worker: the custom audio pipeline used when audio is routed through
 * other peers (or always, in ultra-low-latency mode).
 *
 *   capture worklet ──PCM──▶ [Opus encode (WebCodecs) → AES-GCM] ──▶ main thread → data channel
 *   data channel → main thread ──▶ [AES-GCM → Opus decode → PLC] ──PCM──▶ playback worklet
 *
 * Audio is encrypted end-to-end with the room's media key, so peers that
 * relay it cannot listen in. Runs off the main thread so UI work never
 * delays audio.
 *
 * Packet payload (after the routing header added by the overlay):
 *   [8 src][8 stream nonce][u32 seq][u32 timestamp@48k][u8 channels][u8 frameMs] | AES-GCM(opus)
 * IV = nonce ‖ seq (unique per stream), AAD = the 26 header bytes.
 */

const HEADER = 26;
let key = null;
let selfSrc = null;
let config = { bitrate: 128000, channels: 2, frameMs: 10, fec: true, dtx: false, cbr: false, complexity: 10 };
let sending = false;
let encoder = null;
let encoderKey = '';
let nonce = crypto.getRandomValues(new Uint8Array(8));
let seq = 0;
let inTs = 0; // input timeline in 48 kHz samples
let lastPcmAt = 0;
let playPort = null;
let jitterTargetMs = 0;
const sources = new Map();
const counters = { encoded: 0, decoded: 0, dropped: 0, concealed: 0 };
setInterval(() => postMessage({ counters }), 2000);

function encoderConfig() {
  return {
    codec: 'opus',
    sampleRate: 48000,
    numberOfChannels: config.channels,
    bitrate: config.bitrate,
    bitrateMode: config.cbr ? 'constant' : 'variable',
    opus: { frameDuration: config.frameMs * 1000, complexity: config.complexity, useinbandfec: config.fec, usedtx: config.dtx, packetlossperc: config.fec ? 10 : 0 },
  };
}

function ensureEncoder() {
  const k = JSON.stringify(encoderConfig());
  if (encoder && encoderKey === k && encoder.state === 'configured') return;
  if (encoder && encoder.state !== 'closed') encoder.close();
  encoder = new AudioEncoder({
    output: (chunk) => {
      const opus = new Uint8Array(chunk.byteLength);
      chunk.copyTo(opus);
      emitPacket(opus, Math.round((chunk.timestamp * 48) / 1000));
    },
    error: (e) => {
      postMessage({ error: `encoder: ${e.message}` });
      encoder = null;
    },
  });
  encoder.configure(encoderConfig());
  encoderKey = k;
  // New stream: fresh nonce so IVs never repeat.
  nonce = crypto.getRandomValues(new Uint8Array(8));
  seq = 0;
}

async function emitPacket(opus, ts48) {
  if (!key || !selfSrc) return;
  const header = new Uint8Array(HEADER);
  const view = new DataView(header.buffer);
  header.set(selfSrc, 0);
  header.set(nonce, 8);
  const s = seq++ >>> 0;
  view.setUint32(16, s);
  view.setUint32(20, ts48 >>> 0);
  header[24] = config.channels;
  header[25] = config.frameMs;
  const iv = new Uint8Array(12);
  iv.set(nonce);
  new DataView(iv.buffer).setUint32(8, s);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, opus));
  counters.encoded++;
  const out = new Uint8Array(HEADER + ct.length);
  out.set(header);
  out.set(ct, HEADER);
  postMessage({ out }, [out.buffer]);
}

function onPcm(pcm) {
  if (!sending) return;
  ensureEncoder();
  if (!encoder) return;
  const frames = pcm.length / config.channels;
  // Keep media time in step with wall-clock time across talk pauses, so the
  // receiver's jitter estimate isn't disturbed by silence.
  const now = performance.now();
  const gapMs = now - lastPcmAt - config.frameMs;
  if (lastPcmAt && gapMs > config.frameMs) inTs += Math.round(gapMs * 48);
  lastPcmAt = now;
  const data = new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: frames, numberOfChannels: config.channels, timestamp: (inTs / 48) * 1000, data: pcm });
  inTs += frames;
  encoder.encode(data);
  data.close();
}

// ---------------------------------------------------------------- receive
function hex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function sourceFor(src, channels) {
  let s = sources.get(src);
  if (!s || s.channels !== channels) {
    if (s && s.decoder.state !== 'closed') s.decoder.close();
    s = { src, channels, nonce: '', lastSeq: -1, last: null, jitter: 0, transit: null, frameMs: 10, decoder: null };
    s.decoder = new AudioDecoder({
      output: (data) => deliver(s, data),
      error: () => sources.delete(src),
    });
    s.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: channels });
    sources.set(src, s);
  }
  return s;
}

function deliver(s, data) {
  const frames = data.numberOfFrames;
  const pcm = new Float32Array(frames * 2);
  const plane = new Float32Array(frames);
  const chans = data.numberOfChannels;
  for (let c = 0; c < 2; c++) {
    data.copyTo(plane, { planeIndex: Math.min(c, chans - 1), format: 'f32-planar' });
    for (let i = 0; i < frames; i++) pcm[i * 2 + c] = plane[i];
  }
  data.close();
  counters.decoded++;
  s.last = pcm;
  send(s, pcm.slice());
}

function send(s, pcm) {
  // Target buffer: one frame + 3× measured jitter + a little headroom.
  const target = Math.min(200, Math.max(jitterTargetMs, s.frameMs + 3 * s.jitter + 3));
  playPort?.postMessage({ src: s.src, pcm, target }, [pcm.buffer]);
}

async function onPacket(buf) {
  if (!key || buf.byteLength <= HEADER + 16) return;
  const bytes = new Uint8Array(buf);
  const header = bytes.subarray(0, HEADER);
  const view = new DataView(buf);
  const src = hex(header.subarray(0, 8));
  const streamNonce = hex(header.subarray(8, 16));
  const pseq = view.getUint32(16);
  const pts = view.getUint32(20);
  const channels = header[24] === 1 ? 1 : 2;
  const iv = new Uint8Array(12);
  iv.set(header.subarray(8, 16));
  iv.set(header.subarray(16, 20), 8);
  let opus;
  try {
    opus = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header }, key, bytes.subarray(HEADER));
  } catch {
    return; // forged or corrupted
  }
  const s = sourceFor(src, channels);
  s.frameMs = header[25] || 10;
  if (s.nonce !== streamNonce) {
    s.nonce = streamNonce;
    s.lastSeq = pseq - 1;
    s.transit = null;
  }
  if (pseq <= s.lastSeq) {
    counters.dropped++; // late or duplicate
    return;
  }
  // Jitter (RFC 3550 style) from arrival time vs. media timestamp.
  const arrival = performance.now();
  const transit = arrival - pts / 48;
  if (s.transit !== null) {
    const d = Math.abs(transit - s.transit);
    if (d < 1000) s.jitter += (d - s.jitter) / 16;
  }
  s.transit = transit;
  // Packet loss concealment: repeat the last frame with decaying volume.
  const gap = pseq - s.lastSeq - 1;
  if (gap > 0 && gap <= 3 && s.last) {
    for (let k = 1; k <= gap; k++) {
      const g = 0.5 ** k;
      const conceal = new Float32Array(s.last.length);
      for (let i = 0; i < conceal.length; i++) conceal[i] = s.last[i] * g;
      counters.concealed++;
      send(s, conceal);
    }
  }
  s.lastSeq = pseq;
  s.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: (pts / 48) * 1000, data: opus }));
}

// ---------------------------------------------------------------- control
self.onmessage = async (e) => {
  const d = e.data;
  switch (d.cmd) {
    case 'init':
      if (d.pcmPort) d.pcmPort.onmessage = (ev) => onPcm(ev.data);
      if (d.playPort) playPort = d.playPort;
      break;
    case 'key':
      key = await crypto.subtle.importKey('raw', d.raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
      selfSrc = d.src;
      break;
    case 'config':
      config = { ...config, ...d.config };
      if (typeof d.jitterTargetMs === 'number') jitterTargetMs = d.jitterTargetMs;
      break;
    case 'send':
      sending = d.on;
      if (!sending && encoder && encoder.state === 'configured') encoder.flush().catch(() => {});
      break;
    case 'packet':
      onPacket(d.data);
      break;
    case 'reset':
      for (const s of sources.values()) if (s.decoder.state !== 'closed') s.decoder.close();
      sources.clear();
      break;
    default:
      break;
  }
};
