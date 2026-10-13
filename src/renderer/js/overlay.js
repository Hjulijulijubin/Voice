import { Emitter } from './util.js';
import { tuneOpus, receiveParams, sendParams, clampBitrate } from './opus.js';
import { LinkState, selectRoute } from './routing.js';
import { seal, open, sealJson, openJson, b64uEncode, b64uDecode, fromHex, toHex } from './crypto.js';

export const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// Binary packet types on the "rt" (unreliable) and "file" (reliable) channels.
export const PKT_AUDIO = 1;
const PKT_PING = 2;
const PKT_PONG = 3;
export const PKT_FILE = 4;

const PING_INTERVAL = 2000;
const STATE_HEARTBEAT = 10000;
const NODE_TIMEOUT = 32000;
const HELLO_INTERVAL = 90000;
const CONNECT_TIMEOUT = 20000;
const td = new TextDecoder();

/**
 * The peer overlay of one room.
 *
 * - Finds members through the encrypted rendezvous (Nostr relays / LAN).
 * - Keeps a direct WebRTC connection to every member it can reach.
 * - Measures latency to its neighbours and floods link-state, so every peer
 *   knows the whole topology and can route through other peers when that is
 *   faster or when a direct connection is impossible.
 * - Anything forwarded by intermediate peers is encrypted end-to-end with
 *   the room key (AES-GCM); intermediates only see routing headers.
 */
export class Overlay extends Emitter {
  constructor(opts) {
    super();
    this.selfId = opts.selfId;
    this.selfBytes = fromHex(opts.selfId);
    this.topic = opts.topic;
    this.sigKey = opts.sigKey;
    this.dataKey = opts.dataKey;
    this.iceServers = opts.iceServers;
    this.getQuality = opts.getQuality;
    this.getJitterTargetMs = opts.getJitterTargetMs;
    this.getMode = opts.getMode; // 'auto' | 'ultra'
    this.rv = opts.rendezvous;
    this.t0 = Date.now();
    this.seq = 0;
    this.info = { ...opts.info };
    this.relayAllowed = opts.relayAllowed !== false;

    /** @type {Map<string, Peer>} */
    this.peers = new Map();
    this.ls = new LinkState(this.selfId);
    this.routes = new Map();
    this.audioRoutes = new Map(); // listenerId -> {mode, path, cost}
    this.rtt = new Map(); // neighbourId -> ms (EWMA)
    this.retryAt = new Map(); // id -> {at, backoff}
    this.blocked = new Set(); // ids we refuse direct connections with (tests / user choice)
    this.remoteT0 = new Map(); // id -> session start, to detect restarts

    this.localTrack = null;
    this.myVoice = null;
    this.deafened = false;
    this.outputDeviceId = '';
    this.volumes = new Map();
    this.localMutes = new Set();
    this._customPaths = '';
    this._timers = [];
    this._stateDirty = null;
    this._unsub = null;
    this._pingSeq = 0;
    this._pingTick = 0;
    this.stopped = false;
  }

  // ------------------------------------------------------------- lifecycle
  async start() {
    this._applyOwnState();
    this._unsub = this.rv.onMessage((m) => {
      if (m.topic === this.topic) this._onRendezvous(m.payload);
    });
    await this.rv.join(this.topic);
    this._hello();
    const every = (ms, fn) => this._timers.push(setInterval(fn, ms));
    // Latency probes: every 2 s while in voice (routing matters), else every 6 s.
    every(PING_INTERVAL, () => (this.myVoice || ++this._pingTick % 3 === 0) && this._ping());
    every(STATE_HEARTBEAT, () => this._broadcastState());
    every(5000, () => this._maintain());
    every(HELLO_INTERVAL, () => this._hello());
    every(150, () => this._pollSpeaking());
  }

  stop() {
    this.stopped = true;
    this.info.gone = true;
    this._broadcastState();
    for (const t of this._timers) clearInterval(t);
    clearTimeout(this._stateDirty);
    this._unsub?.();
    this.rv.leave(this.topic);
    const peers = [...this.peers.values()];
    this.peers.clear();
    // Give the goodbye a moment to leave before tearing connections down.
    setTimeout(() => peers.forEach((p) => p.close()), 300);
  }

  // ------------------------------------------------------------- rendezvous
  async _publish(obj) {
    try {
      await this.rv.publish(this.topic, await sealJson(this.sigKey, obj));
    } catch (err) {
      console.warn('rendezvous publish failed', err);
    }
  }

  _hello() {
    this._publish({ t: 'hello', from: this.selfId, t0: this.t0 });
  }

  async _onRendezvous(payload) {
    let msg;
    try {
      msg = await openJson(this.sigKey, payload);
    } catch {
      return; // not for us / forged
    }
    if (!msg || typeof msg.from !== 'string' || msg.from === this.selfId || !/^[0-9a-f]{16}$/.test(msg.from)) return;
    if (msg.t === 'hello') {
      this._noteSession(msg.from, msg.t0);
      this.ensureConnection(msg.from);
    } else if (msg.t === 'sig' && msg.to === this.selfId) {
      this._noteSession(msg.from, msg.t0);
      this._onSignal(msg.from, msg.data);
    }
  }

  /** A different session start time means the peer restarted: drop the stale connection. */
  _noteSession(id, t0) {
    if (typeof t0 !== 'number') return;
    const known = this.remoteT0.get(id);
    if (known !== undefined && known !== t0 && t0 > known) {
      const peer = this.peers.get(id);
      if (peer) this._dropPeer(id, false);
      this.retryAt.delete(id);
    }
    if (known === undefined || t0 > known) this.remoteT0.set(id, t0);
  }

  // ------------------------------------------------------------- connections
  /** Make sure we have (or are building) a direct connection to `id`. */
  ensureConnection(id) {
    if (this.stopped || id === this.selfId || this.blocked.has(id)) return;
    if (this.peers.has(id)) return;
    const retry = this.retryAt.get(id);
    if (retry && Date.now() < retry.at) return;
    if (this.selfId < id) {
      this._createPeer(id, true);
    } else {
      // The peer with the smaller id makes the offer; ask it to, but don't
      // ask again for a while (rendezvous relays are shared infrastructure).
      this._signalTo(id, { knock: true });
      this.retryAt.set(id, { at: Date.now() + 15000, backoff: retry?.backoff || 7500 });
    }
  }

  _createPeer(id, initiator) {
    const peer = new Peer(this, id, initiator);
    this.peers.set(id, peer);
    peer.connectTimer = setTimeout(() => {
      if (peer.pc.connectionState !== 'connected') this._peerFailed(id);
    }, CONNECT_TIMEOUT);
    return peer;
  }

  _peerFailed(id) {
    const prev = this.retryAt.get(id);
    const backoff = Math.min((prev?.backoff || 7500) * 2, 300000);
    this.retryAt.set(id, { at: Date.now() + backoff, backoff });
    this._dropPeer(id, true);
  }

  _dropPeer(id, keepRetry) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.close();
    this.peers.delete(id);
    this.rtt.delete(id);
    if (!keepRetry) this.retryAt.delete(id);
    this._markStateDirty();
    this.emit('peer-closed', id);
    this._recomputeRoutes();
  }

  blockDirect(id) {
    this.blocked.add(id);
    this._dropPeer(id, true);
  }

  /** Send WebRTC signalling to `id`: through the mesh if possible, else rendezvous. */
  _signalTo(id, data) {
    const direct = this.peers.get(id);
    if (direct?.ctlOpen) return direct.sendCtl({ t: 'sig', data });
    const route = this.routes.get(id);
    if (route && this.peers.get(route.path[0])?.ctlOpen) {
      return this._forward(route.path, { t: 'sig', data });
    }
    this._publish({ t: 'sig', from: this.selfId, to: id, t0: this.t0, data });
  }

  _onSignal(from, data) {
    if (!data || typeof data !== 'object' || this.blocked.has(from)) return;
    if (data.knock) {
      if (this.selfId < from) {
        this.retryAt.delete(from);
        this.ensureConnection(from);
      }
      return;
    }
    let peer = this.peers.get(from);
    if (!peer) {
      if (!data.description || data.description.type !== 'offer') return;
      peer = this._createPeer(from, false);
    }
    peer.handleSignal(data);
  }

  _maintain() {
    const now = Date.now();
    const removed = this.ls.expire(now, NODE_TIMEOUT);
    for (const id of removed) this._nodeGone(id);
    // Reconnect to members we know about but aren't directly connected to.
    for (const id of this.ls.nodes.keys()) if (id !== this.selfId) this.ensureConnection(id);
    this._recomputeRoutes();
    if (removed.length) this.emit('roster');
  }

  _nodeGone(id) {
    this._dropPeer(id, false);
    this.ls.remove(id);
    this.emit('node-gone', id);
  }

  // ------------------------------------------------------------- link state
  _applyOwnState() {
    const links = {};
    for (const [id, rtt] of this.rtt) if (this.peers.get(id)?.ctlOpen) links[id] = Math.round(rtt * 10) / 10;
    const state = { id: this.selfId, t0: this.t0, seq: ++this.seq, links, relay: this.relayAllowed, info: this.info };
    this.ls.apply(state);
    return state;
  }

  _broadcastState() {
    const state = this._applyOwnState();
    for (const peer of this.peers.values()) peer.sendCtl({ t: 'ls', s: state });
    this._recomputeRoutes();
  }

  _markStateDirty() {
    if (this._stateDirty) return;
    this._stateDirty = setTimeout(() => {
      this._stateDirty = null;
      this._broadcastState();
    }, 250);
  }

  setInfo(partial) {
    Object.assign(this.info, partial);
    this._markStateDirty();
    this.emit('roster');
    this._recomputeRoutes();
  }

  setRelayAllowed(v) {
    this.relayAllowed = v;
    this._markStateDirty();
  }

  /** Members currently in the room (excluding us). */
  roster() {
    const out = [];
    for (const [id, n] of this.ls.nodes) {
      if (id === this.selfId || n.info.gone) continue;
      const peer = this.peers.get(id);
      const route = this.routes.get(id);
      if (!peer?.ctlOpen && !route) continue; // known but unreachable
      out.push({ id, info: n.info, direct: !!peer?.ctlOpen, peerState: peer?.pc.connectionState || 'none', rtt: this.rtt.get(id) ?? null, route });
    }
    return out;
  }

  _recomputeRoutes() {
    this.routes = this.ls.paths(this.selfId);
    this._updateAudioRoutes();
  }

  // ------------------------------------------------------------- ctl messages
  _onCtl(peer, msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'ls': {
        const s = msg.s;
        if (!s || s.id === this.selfId) return;
        if (s.info?.gone) {
          if (this.ls.nodes.has(s.id)) {
            this._nodeGone(s.id);
            for (const p of this.peers.values()) if (p !== peer) p.sendCtl(msg);
            this.emit('roster');
          }
          return;
        }
        const known = this.ls.nodes.has(s.id);
        if (this.ls.apply(s)) {
          for (const p of this.peers.values()) if (p !== peer) p.sendCtl(msg);
          if (!known) this.ensureConnection(s.id);
          this.emit('roster');
          this._recomputeRoutes();
        }
        break;
      }
      case 'lsdb':
        if (Array.isArray(msg.states)) for (const s of msg.states) this._onCtl(peer, { t: 'ls', s });
        break;
      case 'm':
        this.emit('message', peer.id, msg.o);
        break;
      case 'sig':
        this._onSignal(peer.id, msg.data);
        break;
      case 'fwd':
        this._onForward(peer, msg);
        break;
      default:
        break;
    }
  }

  async _forward(path, obj) {
    const first = this.peers.get(path[0]);
    if (!first?.ctlOpen) return false;
    const c = b64uEncode(await seal(this.dataKey, JSON.stringify(obj), this.selfId));
    return first.sendCtl({ t: 'fwd', path, i: 0, src: this.selfId, c });
  }

  async _onForward(peer, msg) {
    const { path, i, src, c } = msg;
    if (!Array.isArray(path) || path.length > 8 || typeof i !== 'number' || path[i] !== this.selfId || typeof c !== 'string') return;
    if (i < path.length - 1) {
      // We're a relay: pass it on without being able to read it.
      this.peers.get(path[i + 1])?.sendCtl({ t: 'fwd', path, i: i + 1, src, c });
      return;
    }
    let inner;
    try {
      inner = JSON.parse(td.decode(await open(this.dataKey, b64uDecode(c), src)));
    } catch {
      return;
    }
    if (inner?.t === 'sig') this._onSignal(src, inner.data);
    else this.emit('message', src, inner);
  }

  /** Send an application message to one member (direct or relayed). */
  sendTo(id, obj) {
    const peer = this.peers.get(id);
    if (peer?.ctlOpen) return peer.sendCtl({ t: 'm', o: obj });
    const route = this.routes.get(id);
    if (route) {
      this._forward(route.path, obj);
      return true;
    }
    return false;
  }

  /** Send to every reachable member. */
  broadcast(obj) {
    let n = 0;
    for (const m of this.roster()) if (this.sendTo(m.id, obj)) n++;
    return n;
  }

  // ------------------------------------------------------------- binary
  _onRt(peer, buf) {
    const b = new Uint8Array(buf);
    switch (b[0]) {
      case PKT_PING: {
        b[0] = PKT_PONG;
        peer.sendRt(b);
        break;
      }
      case PKT_PONG: {
        const view = new DataView(buf);
        const sample = performance.now() - view.getFloat64(5);
        if (sample >= 0 && sample < 10000) {
          const prev = this.rtt.get(peer.id);
          const next = prev === undefined ? sample : prev * 0.7 + sample * 0.3;
          this.rtt.set(peer.id, next);
          // Flood only meaningful changes; heartbeat carries the rest.
          if (prev === undefined || Math.abs(next - prev) > Math.max(5, prev * 0.2)) this._markStateDirty();
        }
        break;
      }
      case PKT_AUDIO:
        this._routeBinary(peer, b, 'rt');
        break;
      default:
        break;
    }
  }

  _onFileFrame(peer, buf) {
    const b = new Uint8Array(buf);
    if (b[0] === PKT_FILE) this._routeBinary(peer, b, 'file');
  }

  /** [type][hopIndex][pathLen][pathLen × 8-byte ids][payload] */
  _routeBinary(peer, b, channel) {
    const i = b[1];
    const len = b[2];
    const off = 3 + i * 8;
    if (len === 0 || i >= len || b.length < 3 + len * 8) return;
    for (let k = 0; k < 8; k++) if (b[off + k] !== this.selfBytes[k]) return;
    if (i === len - 1) {
      const payload = b.subarray(3 + len * 8);
      if (channel === 'rt') this.emit('audio-packet', payload);
      else this.emit('file-frame', payload);
      return;
    }
    const nextId = toHex(b.subarray(off + 8, off + 16));
    const next = this.peers.get(nextId);
    if (!next) return;
    b[1] = i + 1;
    if (channel === 'rt') next.sendRt(b);
    else next.sendFile(b);
  }

  static frame(type, path, payload) {
    const out = new Uint8Array(3 + path.length * 8 + payload.length);
    out[0] = type;
    out[1] = 0;
    out[2] = path.length;
    path.forEach((id, k) => out.set(fromHex(id), 3 + k * 8));
    out.set(payload, 3 + path.length * 8);
    return out;
  }

  /** Send a file frame to `dest` (direct or routed). Returns the channel used, for back-pressure. */
  sendFileFrame(dest, payload) {
    const path = this.peers.get(dest)?.fileOpen ? [dest] : this.routes.get(dest)?.path;
    if (!path) return null;
    const first = this.peers.get(path[0]);
    if (!first?.fileOpen) return null;
    first.sendFile(Overlay.frame(PKT_FILE, path, payload));
    return first.file;
  }

  /** Send an encoded audio packet along every custom (relayed / ultra) route. */
  sendAudio(payload) {
    for (const r of this.audioRoutes.values()) {
      if (r.mode !== 'relay') continue;
      this.peers.get(r.path[0])?.sendRt(Overlay.frame(PKT_AUDIO, r.path, payload));
    }
  }

  _ping() {
    const buf = new ArrayBuffer(13);
    const view = new DataView(buf);
    view.setUint8(0, PKT_PING);
    view.setUint32(1, ++this._pingSeq);
    view.setFloat64(5, performance.now());
    const bytes = new Uint8Array(buf);
    for (const peer of this.peers.values()) peer.sendRt(bytes);
  }

  // ------------------------------------------------------------- voice
  setLocalTrack(track) {
    this.localTrack = track;
    this._applyNative(true);
  }

  setVoiceChannel(channelId) {
    this.myVoice = channelId;
    this.setInfo({ voice: channelId });
  }

  setDeafened(v) {
    this.deafened = v;
    this._applyNative();
  }

  setOutputDevice(id) {
    this.outputDeviceId = id || '';
    for (const p of this.peers.values()) p.applySink();
  }

  setUserVolume(id, v) {
    this.volumes.set(id, v);
    this.peers.get(id)?.applyVolume();
  }

  setUserLocalMute(id, muted) {
    if (muted) this.localMutes.add(id);
    else this.localMutes.delete(id);
    this._applyNative();
  }

  inVoiceWith(id) {
    return !!this.myVoice && this.ls.nodes.get(id)?.info.voice === this.myVoice;
  }

  /** Choose for every listener in our voice channel how our audio reaches them. */
  _updateAudioRoutes() {
    const ultra = this.getMode() === 'ultra';
    const next = new Map();
    if (this.myVoice) {
      for (const [id, n] of this.ls.nodes) {
        if (id === this.selfId || n.info.voice !== this.myVoice) continue;
        const peer = this.peers.get(id);
        const best = this.routes.get(id) || null;
        if (ultra) {
          if (best) next.set(id, { mode: 'relay', path: best.path, cost: best.cost });
          continue;
        }
        const directOk = peer && peer.pc.connectionState === 'connected' && peer.transceiver;
        const directCost = directOk ? (this.rtt.get(id) ?? 0) / 2 : null;
        const current = this.audioRoutes.get(id)?.mode || 'none';
        // The custom pipeline's jitter buffer is a bit less clever than
        // WebRTC's NetEq, so it must win by a margin to be used.
        next.set(id, selectRoute(current, directCost, best, { relayPenaltyMs: 5 }));
      }
    }
    this.audioRoutes = next;
    this._applyNative();
    const key = [...next].filter(([, r]) => r.mode === 'relay').map(([id, r]) => `${id}:${r.path.join('>')}`).join(',');
    if (key !== this._customPaths) {
      this._customPaths = key;
      this.emit('custom-routes', [...next.values()].filter((r) => r.mode === 'relay').length);
    }
  }

  _applyNative(force = false) {
    for (const peer of this.peers.values()) {
      const route = this.audioRoutes.get(peer.id);
      const send = route?.mode === 'direct' ? this.localTrack : null;
      peer.setSending(send, force);
      peer.setListening(this.inVoiceWith(peer.id) && !this.deafened && !this.localMutes.has(peer.id));
    }
  }

  applyQuality() {
    for (const peer of this.peers.values()) {
      peer.applySenderParams();
      peer.negotiate();
    }
  }

  applyJitterTarget() {
    for (const peer of this.peers.values()) peer.applyJitterTarget();
  }

  _pollSpeaking() {
    if (!this.myVoice) return;
    for (const peer of this.peers.values()) peer.pollLevel();
  }
}

/** One direct WebRTC connection. */
class Peer {
  constructor(overlay, id, initiator) {
    this.overlay = overlay;
    this.id = id;
    this.polite = overlay.selfId > id;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.transceiver = null;
    this.sentTrack = undefined;
    this.speaking = false;
    this._queue = Promise.resolve();
    this.descSent = false;
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.audio.muted = true;

    const pc = new RTCPeerConnection({ iceServers: overlay.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    this.pc = pc;
    pc.onicecandidate = (e) => {
      // Non-trickle: candidates ride along with the description. Late ones
      // (after the gathering timeout) are sent separately.
      if (e.candidate && this.descSent) overlay._signalTo(id, { candidate: e.candidate.toJSON() });
    };
    pc.onnegotiationneeded = () => this.negotiate();
    pc.ontrack = (e) => this._onTrack(e);
    pc.onconnectionstatechange = () => this._onState();

    this._createChannels();
    if (initiator) {
      this.transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      this.setSending(null, true);
    }
  }

  get ctlOpen() {
    return this.ctl.readyState === 'open';
  }

  get fileOpen() {
    return this.file.readyState === 'open';
  }

  _createChannels() {
    const pc = this.pc;
    const ov = this.overlay;
    this.ctl = pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true });
    this.file = pc.createDataChannel('file', { negotiated: true, id: 1, ordered: true });
    this.rt = pc.createDataChannel('rt', { negotiated: true, id: 2, ordered: false, maxRetransmits: 0 });
    this.file.binaryType = 'arraybuffer';
    this.rt.binaryType = 'arraybuffer';
    this.file.bufferedAmountLowThreshold = 1 << 20;
    this.ctl.onopen = () => {
      clearTimeout(this.connectTimer);
      ov.retryAt.delete(this.id);
      // Share everything we know about the room's topology.
      this.sendCtl({ t: 'lsdb', states: [...ov.ls.nodes.values()].map((n) => ({ id: n.id, t0: n.t0, seq: n.seq, links: n.links, relay: n.relay, info: n.info })) });
      ov._markStateDirty();
      ov.emit('peer-open', this.id);
      ov.emit('roster');
    };
    this.ctl.onclose = () => ov.emit('roster');
    this.ctl.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        ov._onCtl(this, JSON.parse(e.data));
      } catch (err) {
        console.warn('bad ctl message', err);
      }
    };
    this.rt.onmessage = (e) => ov._onRt(this, e.data);
    this.file.onmessage = (e) => ov._onFileFrame(this, e.data);
  }

  sendCtl(obj) {
    if (!this.ctlOpen) return false;
    try {
      this.ctl.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  sendRt(bytes) {
    if (this.rt.readyState !== 'open' || this.rt.bufferedAmount > 64 * 1024) return; // late audio is useless
    try {
      this.rt.send(bytes);
    } catch {
      /* closing */
    }
  }

  sendFile(bytes) {
    if (!this.fileOpen) return;
    try {
      this.file.send(bytes);
    } catch {
      /* closing */
    }
  }

  _waitGathering() {
    const pc = this.pc;
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => pc.iceGatheringState === 'complete' && done();
      const timer = setTimeout(done, 2500);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  async _sendDescription() {
    await this._waitGathering();
    const d = this.pc.localDescription;
    if (!d) return;
    this.overlay._signalTo(this.id, { description: { type: d.type, sdp: d.sdp } });
    this.descSent = true;
  }

  async negotiate() {
    const pc = this.pc;
    if (pc.signalingState === 'closed') return;
    try {
      this.makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp, receiveParams()) });
      await this._sendDescription();
    } catch (err) {
      console.warn('negotiation failed', err);
    } finally {
      this.makingOffer = false;
    }
  }

  handleSignal(data) {
    this._queue = this._queue.then(() => this._handleSignal(data)).catch((err) => console.warn('signal error', err));
  }

  async _handleSignal({ description, candidate }) {
    const pc = this.pc;
    if (pc.signalingState === 'closed') return;
    if (description && (description.type === 'offer' || description.type === 'answer') && typeof description.sdp === 'string') {
      const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      const { params, ptime } = sendParams(this.overlay.getQuality());
      await pc.setRemoteDescription({ type: description.type, sdp: tuneOpus(description.sdp, params, ptime) });
      if (description.type === 'offer') {
        this._adoptTransceiver();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(answer.sdp, receiveParams()) });
        await this._sendDescription();
      }
      this.applySenderParams();
      this.overlay._applyNative();
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!this.ignoreOffer) console.warn('addIceCandidate failed', err);
      }
    }
  }

  _adoptTransceiver() {
    if (this.transceiver) return;
    const t = this.pc.getTransceivers().find((tr) => tr.receiver.track?.kind === 'audio');
    if (!t) return;
    t.direction = 'sendrecv';
    this.transceiver = t;
    this.sentTrack = undefined;
  }

  _onTrack(e) {
    if (e.track.kind !== 'audio') return;
    if (!this.transceiver) this._adoptTransceiver();
    this.remoteTrack = e.track;
    this.applyJitterTarget();
    this.overlay._applyNative();
  }

  /**
   * Only play the remote track while we're actually in voice together: an
   * idle <audio> element playing silence keeps the sound card busy.
   */
  setListening(on) {
    if (on && this.remoteTrack) {
      if (!this.audio.srcObject) {
        this.audio.srcObject = new MediaStream([this.remoteTrack]);
        this.applySink();
        this.applyVolume();
      }
      this.audio.muted = false;
      if (this.audio.paused) this.audio.play().catch(() => {});
    } else if (this.audio.srcObject) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
  }

  setSending(track, force = false) {
    if (!this.transceiver || (!force && track === this.sentTrack)) return;
    this.sentTrack = track;
    this.transceiver.sender.replaceTrack(track).catch(() => {});
  }

  applyJitterTarget() {
    const receiver = this.transceiver?.receiver;
    if (!receiver) return;
    try {
      receiver.jitterBufferTarget = this.overlay.getJitterTargetMs();
    } catch {
      /* not supported */
    }
  }

  async applySenderParams() {
    const sender = this.transceiver?.sender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      params.encodings[0].maxBitrate = clampBitrate(this.overlay.getQuality().bitrate);
      params.encodings[0].priority = 'high';
      params.encodings[0].networkPriority = 'high';
      await sender.setParameters(params);
    } catch {
      /* not negotiated yet */
    }
  }

  applySink() {
    if (this.audio.setSinkId) this.audio.setSinkId(this.overlay.outputDeviceId).catch(() => {});
  }

  applyVolume() {
    const v = this.overlay.volumes.get(this.id);
    this.audio.volume = typeof v === 'number' ? Math.min(1, Math.max(0, v)) : 1;
  }

  pollLevel() {
    let speaking = false;
    const receiver = this.transceiver?.receiver;
    if (receiver && this.audio.srcObject) {
      const now = performance.now();
      for (const s of receiver.getSynchronizationSources()) if ((s.audioLevel ?? 0) > 0.015 && now - s.timestamp < 300) speaking = true;
    }
    if (speaking !== this.speaking) {
      this.speaking = speaking;
      this.overlay.emit('speaking', this.id, speaking);
    }
  }

  _onState() {
    const state = this.pc.connectionState;
    if (state === 'connected') clearTimeout(this.connectTimer);
    if (state === 'failed') this.overlay._peerFailed(this.id);
    if (state === 'disconnected') {
      clearTimeout(this._dcTimer);
      this._dcTimer = setTimeout(() => this.pc.connectionState === 'disconnected' && this.pc.restartIce(), 4000);
    }
    this.overlay.emit('roster');
    this.overlay._recomputeRoutes();
  }

  /** Connection diagnostics: RTT, bitrates, loss, jitter buffer, codec, path. */
  async getStats() {
    const report = await this.pc.getStats();
    const now = performance.now();
    const out = { rttMs: null, inKbps: null, outKbps: null, lossPct: null, jitterMs: null, bufferMs: null, codec: null, sendCodec: null, path: null };
    let inbound = null;
    let outbound = null;
    let pair = null;
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound = s;
      if (s.type === 'outbound-rtp' && s.kind === 'audio') outbound = s;
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId);
    });
    if (pair) {
      if (pair.currentRoundTripTime != null) out.rttMs = pair.currentRoundTripTime * 1000;
      const local = report.get(pair.localCandidateId);
      const remote = report.get(pair.remoteCandidateId);
      if (local && remote) out.path = local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'TURN relay' : 'direct UDP';
    }
    const prev = this._prevStats || {};
    if (inbound) {
      if (prev.inBytes != null) out.inKbps = ((inbound.bytesReceived - prev.inBytes) * 8) / (now - prev.t);
      const lost = inbound.packetsLost || 0;
      const total = lost + (inbound.packetsReceived || 0);
      out.lossPct = total ? (lost / total) * 100 : 0;
      out.jitterMs = inbound.jitter != null ? inbound.jitter * 1000 : null;
      if (inbound.jitterBufferEmittedCount) {
        const dCount = inbound.jitterBufferEmittedCount - (prev.jbCount ?? 0);
        out.bufferMs = dCount > 0 ? ((inbound.jitterBufferDelay - (prev.jbDelay ?? 0)) / dCount) * 1000 : null;
      }
      const codec = report.get(inbound.codecId);
      if (codec) out.codec = `${codec.mimeType.split('/')[1]} ${codec.clockRate / 1000}kHz ${codec.channels || 1}ch`;
    }
    if (outbound) {
      if (prev.outBytes != null) out.outKbps = ((outbound.bytesSent - prev.outBytes) * 8) / (now - prev.t);
      out.sendCodec = report.get(outbound.codecId)?.sdpFmtpLine || null;
    }
    this._prevStats = { t: now, inBytes: inbound?.bytesReceived, outBytes: outbound?.bytesSent, jbDelay: inbound?.jitterBufferDelay, jbCount: inbound?.jitterBufferEmittedCount };
    return out;
  }

  close() {
    clearTimeout(this.connectTimer);
    clearTimeout(this._dcTimer);
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.audio.pause();
    this.audio.srcObject = null;
  }
}
