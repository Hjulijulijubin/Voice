import { Emitter } from './util.js';
import { tuneOpus, receiveParams, sendParams, clampBitrate } from './opus.js';

export const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * Full-mesh of direct WebRTC connections, one per remote peer.
 *
 * Each connection carries:
 *   - one Opus audio transceiver (only fed with the mic while both peers are
 *     in the same voice channel; otherwise `replaceTrack(null)` → 0 bandwidth,
 *     no renegotiation needed when hopping channels),
 *   - a reliable "chat" data channel (JSON: messages, history sync, control),
 *   - a reliable "file" data channel (binary file chunks).
 *
 * Negotiation follows the W3C "perfect negotiation" pattern so either side
 * can (re)negotiate at any time without glare problems.
 */
export class Mesh extends Emitter {
  constructor({ signaling, selfId, getQuality, getJitterTargetMs, iceServers }) {
    super();
    this.signaling = signaling;
    this.selfId = selfId;
    this.getQuality = getQuality;
    this.getJitterTargetMs = getJitterTargetMs;
    this.iceServers = iceServers;
    /** @type {Map<string, Peer>} */
    this.peers = new Map();
    this.localTrack = null;
    this.myVoice = null;
    this.deafened = false;
    this.outputDeviceId = '';
    this.volumes = new Map(); // userId -> 0..1
    this.localMutes = new Set(); // userIds muted locally
    this._levelTimer = setInterval(() => this._pollLevels(), 80);
  }

  destroy() {
    clearInterval(this._levelTimer);
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
  }

  /** We just arrived: we open the connection to everyone already present. */
  connectTo(info) {
    if (this.peers.has(info.id)) return this.peers.get(info.id);
    const peer = new Peer(this, info, true);
    this.peers.set(info.id, peer);
    return peer;
  }

  /** Someone else arrived: they will send us an offer. */
  expect(info) {
    if (this.peers.has(info.id)) return this.peers.get(info.id);
    const peer = new Peer(this, info, false);
    this.peers.set(info.id, peer);
    return peer;
  }

  remove(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.close();
    this.peers.delete(id);
    this.emit('peer-removed', id);
  }

  updateInfo(info) {
    const peer = this.peers.get(info.id);
    if (!peer) return;
    peer.info = { ...peer.info, ...info };
    this.updateRouting();
  }

  onSignal(from, data) {
    // An offer may theoretically overtake the "peer-joined" notice.
    const peer = this.peers.get(from) || this.expect({ id: from, name: '…', voice: null });
    peer.handleSignal(data);
  }

  // ---- local mungers -------------------------------------------------------

  mungeLocal(sdp) {
    return tuneOpus(sdp, receiveParams());
  }

  mungeRemote(sdp) {
    const { params, ptime } = sendParams(this.getQuality());
    return tuneOpus(sdp, params, ptime);
  }

  // ---- voice routing -------------------------------------------------------

  setLocalTrack(track) {
    this.localTrack = track;
    this.updateRouting(true);
  }

  setVoiceChannel(channelId) {
    this.myVoice = channelId;
    this.updateRouting();
  }

  setDeafened(value) {
    this.deafened = value;
    this.updateRouting();
  }

  updateRouting(forceTrack = false) {
    for (const peer of this.peers.values()) peer.applyRouting(forceTrack);
  }

  setOutputDevice(deviceId) {
    this.outputDeviceId = deviceId || '';
    for (const peer of this.peers.values()) peer.applySink();
  }

  setUserVolume(userId, volume) {
    this.volumes.set(userId, volume);
    for (const peer of this.peers.values()) if (peer.info.userId === userId) peer.applyVolume();
  }

  setUserLocalMute(userId, muted) {
    if (muted) this.localMutes.add(userId);
    else this.localMutes.delete(userId);
    this.updateRouting();
  }

  /** Apply new quality settings: renegotiate so both ends pick up new Opus params. */
  async applyQuality() {
    for (const peer of this.peers.values()) {
      peer.applySenderParams();
      peer.negotiate();
    }
  }

  applyJitterTarget() {
    for (const peer of this.peers.values()) peer.applyJitterTarget();
  }

  // ---- data ----------------------------------------------------------------

  send(peerId, obj) {
    return this.peers.get(peerId)?.sendJson(obj) ?? false;
  }

  broadcast(obj) {
    let n = 0;
    for (const peer of this.peers.values()) if (peer.sendJson(obj)) n++;
    return n;
  }

  openPeers() {
    return [...this.peers.values()].filter((p) => p.chat?.readyState === 'open');
  }

  findByUser(userId) {
    return [...this.peers.values()].find((p) => p.info.userId === userId) || null;
  }

  _pollLevels() {
    for (const peer of this.peers.values()) peer.pollLevel();
  }
}

class Peer {
  constructor(mesh, info, initiator) {
    this.mesh = mesh;
    this.id = info.id;
    this.info = info;
    this.initiator = initiator;
    // Deterministic roles so glare resolves the same way on both ends.
    this.polite = mesh.selfId > info.id;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.transceiver = null;
    this.sentTrack = undefined;
    this.speaking = false;
    this.state = 'new';
    this._queue = Promise.resolve();
    this._disconnectTimer = null;
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.audio.muted = true;

    const pc = new RTCPeerConnection({
      iceServers: mesh.iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    this.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) this._signal({ candidate: e.candidate.toJSON() });
    };
    pc.onnegotiationneeded = () => this.negotiate();
    pc.ontrack = (e) => this._onTrack(e);
    pc.onconnectionstatechange = () => this._onConnectionState();

    if (initiator) {
      this._createChannels();
      this.transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      this.applyRouting(true);
    }
  }

  _createChannels() {
    if (this.chat) return;
    this.chat = this.pc.createDataChannel('chat', { negotiated: true, id: 0, ordered: true });
    this.file = this.pc.createDataChannel('file', { negotiated: true, id: 1, ordered: true });
    this.file.binaryType = 'arraybuffer';
    this.file.bufferedAmountLowThreshold = 1 << 20;
    this.chat.onopen = () => this.mesh.emit('peer-open', this);
    this.chat.onclose = () => this.mesh.emit('peer-closed', this);
    this.chat.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let obj;
      try {
        obj = JSON.parse(e.data);
      } catch {
        return;
      }
      this.mesh.emit('data', this, obj);
    };
    this.file.onmessage = (e) => this.mesh.emit('file-data', this, e.data);
  }

  _signal(data) {
    this.mesh.signaling.signal(this.id, data);
  }

  async negotiate() {
    const pc = this.pc;
    if (pc.signalingState === 'closed') return;
    try {
      this.makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription({ type: 'offer', sdp: this.mesh.mungeLocal(offer.sdp) });
      this._signal({ description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } catch (err) {
      console.warn('negotiation failed', err);
    } finally {
      this.makingOffer = false;
    }
  }

  handleSignal(data) {
    // Serialize: ICE candidates must not overtake the description they belong to.
    this._queue = this._queue.then(() => this._handleSignal(data)).catch((err) => console.warn('signal error', err));
  }

  async _handleSignal({ description, candidate }) {
    const pc = this.pc;
    if (pc.signalingState === 'closed') return;
    if (description) {
      const offerCollision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return;
      this._createChannels();
      await pc.setRemoteDescription({ type: description.type, sdp: this.mesh.mungeRemote(description.sdp) });
      if (description.type === 'offer') {
        this._adoptTransceiver();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription({ type: 'answer', sdp: this.mesh.mungeLocal(answer.sdp) });
        this._signal({ description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      }
      this.applySenderParams();
      this.applyRouting();
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!this.ignoreOffer) console.warn('addIceCandidate failed', err);
      }
    }
  }

  /** The answering side reuses the offerer's audio transceiver for sending too. */
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
    this.audio.srcObject = new MediaStream([e.track]);
    this.applySink();
    this.applyVolume();
    this.applyJitterTarget();
    this.audio.play().catch(() => {});
    this.applyRouting();
  }

  applyJitterTarget() {
    const receiver = this.transceiver?.receiver;
    if (!receiver) return;
    const ms = this.mesh.getJitterTargetMs();
    try {
      // Chromium: target jitter buffer delay in ms (0 = as low as the network allows).
      if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = ms;
      // Older Chromium name, in seconds.
      else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = ms / 1000;
    } catch (err) {
      console.warn('could not set jitter buffer target', err);
    }
  }

  async applySenderParams() {
    const sender = this.transceiver?.sender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) return;
      const q = this.mesh.getQuality();
      params.encodings[0].maxBitrate = clampBitrate(q.bitrate);
      params.encodings[0].priority = 'high';
      params.encodings[0].networkPriority = 'high';
      await sender.setParameters(params);
    } catch (err) {
      console.warn('setParameters failed', err);
    }
  }

  get together() {
    return !!this.mesh.myVoice && this.info.voice === this.mesh.myVoice;
  }

  applyRouting(forceTrack = false) {
    const mesh = this.mesh;
    const together = this.together;
    if (this.transceiver) {
      const want = together ? mesh.localTrack : null;
      if (forceTrack || want !== this.sentTrack) {
        this.sentTrack = want;
        this.transceiver.sender.replaceTrack(want).catch((err) => console.warn('replaceTrack failed', err));
      }
    }
    this.audio.muted = !together || mesh.deafened || mesh.localMutes.has(this.info.userId);
  }

  applySink() {
    if (this.audio.setSinkId) this.audio.setSinkId(this.mesh.outputDeviceId).catch(() => {});
  }

  applyVolume() {
    const v = this.mesh.volumes.get(this.info.userId);
    this.audio.volume = typeof v === 'number' ? Math.min(1, Math.max(0, v)) : 1;
  }

  pollLevel() {
    const receiver = this.transceiver?.receiver;
    let speaking = false;
    if (receiver && this.together && receiver.getSynchronizationSources) {
      const now = performance.now();
      for (const s of receiver.getSynchronizationSources()) {
        // timestamps are on the performance clock; ignore stale entries
        if ((s.audioLevel ?? 0) > 0.015 && now - s.timestamp < 300) speaking = true;
      }
    }
    if (speaking !== this.speaking) {
      this.speaking = speaking;
      this.mesh.emit('speaking', this, speaking);
    }
  }

  _onConnectionState() {
    const state = this.pc.connectionState;
    this.state = state;
    clearTimeout(this._disconnectTimer);
    if (state === 'failed') {
      this.pc.restartIce();
    } else if (state === 'disconnected') {
      this._disconnectTimer = setTimeout(() => {
        if (this.pc.connectionState === 'disconnected') this.pc.restartIce();
      }, 4000);
    }
    this.mesh.emit('peer-state', this, state);
  }

  sendJson(obj) {
    if (this.chat?.readyState !== 'open') return false;
    try {
      this.chat.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      console.warn('send failed', err);
      return false;
    }
  }

  /** Connection diagnostics: RTT, bitrates, loss, jitter buffer, codec. */
  async getStats() {
    const report = await this.pc.getStats();
    const now = performance.now();
    const out = { rttMs: null, inKbps: null, outKbps: null, lossPct: null, jitterMs: null, bufferMs: null, codec: null, sendCodec: null, path: null };
    const byId = new Map();
    report.forEach((s) => byId.set(s.id, s));
    let inbound = null;
    let outbound = null;
    let pair = null;
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound = s;
      if (s.type === 'outbound-rtp' && s.kind === 'audio') outbound = s;
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
    });
    if (!pair) report.forEach((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && (pair = s));
    if (pair) {
      if (pair.currentRoundTripTime != null) out.rttMs = pair.currentRoundTripTime * 1000;
      const local = byId.get(pair.localCandidateId);
      const remote = byId.get(pair.remoteCandidateId);
      if (local && remote) {
        out.path = local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'relay (TURN)' : 'direct (P2P)';
      }
    }
    const prev = this._prevStats || {};
    if (inbound) {
      if (prev.inBytes != null && inbound.bytesReceived != null) {
        out.inKbps = ((inbound.bytesReceived - prev.inBytes) * 8) / (now - prev.t);
      }
      const lost = inbound.packetsLost || 0;
      const total = lost + (inbound.packetsReceived || 0);
      out.lossPct = total ? (lost / total) * 100 : 0;
      out.jitterMs = inbound.jitter != null ? inbound.jitter * 1000 : null;
      if (inbound.jitterBufferEmittedCount) {
        const dDelay = inbound.jitterBufferDelay - (prev.jbDelay ?? 0);
        const dCount = inbound.jitterBufferEmittedCount - (prev.jbCount ?? 0);
        out.bufferMs = dCount > 0 ? (dDelay / dCount) * 1000 : (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000;
      }
      const codec = byId.get(inbound.codecId);
      if (codec) out.codec = `${codec.mimeType.split('/')[1]} ${codec.clockRate / 1000}kHz ${codec.channels || 1}ch`;
    }
    if (outbound) {
      if (prev.outBytes != null && outbound.bytesSent != null) {
        out.outKbps = ((outbound.bytesSent - prev.outBytes) * 8) / (now - prev.t);
      }
      const codec = byId.get(outbound.codecId);
      if (codec) out.sendCodec = codec.sdpFmtpLine || null;
    }
    this._prevStats = {
      t: now,
      inBytes: inbound?.bytesReceived,
      outBytes: outbound?.bytesSent,
      jbDelay: inbound?.jitterBufferDelay,
      jbCount: inbound?.jitterBufferEmittedCount,
    };
    return out;
  }

  close() {
    clearTimeout(this._disconnectTimer);
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.audio.pause();
    this.audio.srcObject = null;
  }
}
