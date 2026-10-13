'use strict';

/**
 * Voice signaling server.
 *
 * This server never sees audio, chat messages or files. Its only jobs are:
 *   - peer discovery (who is online),
 *   - relaying WebRTC offers/answers/ICE candidates between peers,
 *   - presence (which voice channel a peer is in, mute/deafen state),
 *   - the shared channel list.
 *
 * Everything else flows directly peer-to-peer over encrypted WebRTC
 * (DTLS-SRTP for audio, DTLS-SCTP data channels for chat and files).
 *
 * It can run embedded in the desktop app ("Host a server") or standalone
 * via `node server/index.js` on a VPS / home server.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WebSocketServer, WebSocket } = require('ws');

const PROTOCOL_VERSION = 1;
const MAX_NAME = 32;
const MAX_CHANNELS = 100;
const MAX_PEERS_DEFAULT = 64;

const DEFAULT_CHANNELS = [
  { id: 'general', name: 'general', type: 'text' },
  { id: 'files', name: 'files', type: 'text' },
  { id: 'lounge', name: 'Lounge', type: 'voice' },
  { id: 'gaming', name: 'Gaming', type: 'voice' },
  { id: 'music', name: 'Music (Hi-Fi)', type: 'voice' },
];

function cleanName(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  // Collapse whitespace and strip control characters.
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return name.slice(0, MAX_NAME) || fallback;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

class SignalingServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.port=9987]
   * @param {string} [opts.host='0.0.0.0']
   * @param {string} [opts.name='Voice Server']
   * @param {string} [opts.password]
   * @param {number} [opts.maxPeers=64]
   * @param {Array}  [opts.iceServers] extra STUN/TURN servers pushed to clients
   * @param {string} [opts.stateFile] JSON file used to persist the channel list
   */
  constructor(opts = {}) {
    super();
    this.port = opts.port ?? 9987;
    this.host = opts.host ?? '0.0.0.0';
    this.name = cleanName(opts.name, 'Voice Server');
    this.password = opts.password || '';
    this.maxPeers = opts.maxPeers ?? MAX_PEERS_DEFAULT;
    this.iceServers = Array.isArray(opts.iceServers) ? opts.iceServers : [];
    this.stateFile = opts.stateFile || null;
    this.channels = this._loadChannels();
    /** @type {Map<string, {id:string, userId:string, name:string, ws:WebSocket, voice:string|null, muted:boolean, deafened:boolean, alive:boolean}>} */
    this.peers = new Map();
    this.http = null;
    this.wss = null;
    this._heartbeat = null;
  }

  _loadChannels() {
    if (this.stateFile) {
      try {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        if (Array.isArray(data.channels) && data.channels.some((c) => c.type === 'text')) {
          return data.channels
            .filter((c) => c && typeof c.id === 'string' && (c.type === 'text' || c.type === 'voice'))
            .map((c) => ({ id: c.id, name: cleanName(c.name, c.id), type: c.type }));
        }
      } catch {
        /* first start or unreadable file: fall back to defaults */
      }
    }
    return DEFAULT_CHANNELS.map((c) => ({ ...c }));
  }

  _saveChannels() {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ channels: this.channels }, null, 2));
    } catch (err) {
      this.emit('log', `could not persist channels: ${err.message}`);
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.http = http.createServer((req, res) => {
        // A tiny status endpoint so people can check the server is reachable.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ app: 'voice', name: this.name, peers: this.peers.size, protocol: PROTOCOL_VERSION }));
      });
      this.wss = new WebSocketServer({ server: this.http, maxPayload: 256 * 1024 });
      this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
      this.http.once('error', reject);
      this.http.listen(this.port, this.host, () => {
        this.http.off('error', reject);
        this.port = this.http.address().port;
        this._heartbeat = setInterval(() => this._checkAlive(), 15000);
        this.emit('log', `listening on ${this.host}:${this.port}`);
        resolve({ port: this.port });
      });
    });
  }

  stop() {
    clearInterval(this._heartbeat);
    for (const peer of this.peers.values()) peer.ws.terminate();
    this.peers.clear();
    return new Promise((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => this.http.close(() => resolve()));
      this.wss = null;
    });
  }

  _checkAlive() {
    for (const peer of this.peers.values()) {
      if (!peer.alive) {
        peer.ws.terminate();
        continue;
      }
      peer.alive = false;
      try {
        peer.ws.ping();
      } catch {
        /* socket already closing */
      }
    }
  }

  _publicPeer(p) {
    return { id: p.id, userId: p.userId, name: p.name, voice: p.voice, muted: p.muted, deafened: p.deafened };
  }

  _send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  _broadcast(msg, exceptId = null) {
    const data = JSON.stringify(msg);
    for (const peer of this.peers.values()) {
      if (peer.id !== exceptId && peer.ws.readyState === WebSocket.OPEN) peer.ws.send(data);
    }
  }

  _onConnection(ws, req) {
    let peer = null;
    const remote = req.socket.remoteAddress;
    // Clients must say hello quickly.
    const helloTimer = setTimeout(() => {
      if (!peer) ws.close(4000, 'hello timeout');
    }, 10000);

    ws.on('pong', () => {
      if (peer) peer.alive = true;
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (!peer) {
        if (msg.type !== 'hello') return;
        clearTimeout(helloTimer);
        peer = this._handleHello(ws, msg, remote);
        return;
      }

      switch (msg.type) {
        case 'signal': {
          const target = this.peers.get(msg.to);
          if (target && msg.data && typeof msg.data === 'object') {
            this._send(target.ws, { type: 'signal', from: peer.id, data: msg.data });
          }
          break;
        }
        case 'state': {
          if (msg.voice === null || (typeof msg.voice === 'string' && this._channel(msg.voice, 'voice'))) {
            peer.voice = msg.voice;
          }
          if (typeof msg.muted === 'boolean') peer.muted = msg.muted;
          if (typeof msg.deafened === 'boolean') peer.deafened = msg.deafened;
          if (typeof msg.name === 'string') peer.name = cleanName(msg.name, peer.name);
          this._broadcast({ type: 'peer-state', peer: this._publicPeer(peer) });
          break;
        }
        case 'channel-create': {
          const type = msg.channelType === 'voice' ? 'voice' : 'text';
          const name = cleanName(msg.name);
          if (!name || this.channels.length >= MAX_CHANNELS) break;
          const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'channel';
          let id = base;
          for (let i = 2; this.channels.some((c) => c.id === id); i++) id = `${base}-${i}`;
          this.channels.push({ id, name, type });
          this._channelsChanged();
          break;
        }
        case 'channel-delete': {
          const ch = this.channels.find((c) => c.id === msg.id);
          if (!ch) break;
          if (ch.type === 'text' && this.channels.filter((c) => c.type === 'text').length <= 1) break;
          this.channels = this.channels.filter((c) => c.id !== ch.id);
          if (ch.type === 'voice') {
            for (const p of this.peers.values()) {
              if (p.voice === ch.id) {
                p.voice = null;
                this._broadcast({ type: 'peer-state', peer: this._publicPeer(p) });
              }
            }
          }
          this._channelsChanged();
          break;
        }
        case 'ping':
          this._send(ws, { type: 'pong', t: msg.t });
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (peer && this.peers.get(peer.id) === peer) {
        this.peers.delete(peer.id);
        this._broadcast({ type: 'peer-left', id: peer.id });
        this.emit('log', `${peer.name} left (${this.peers.size} online)`);
        this.emit('peers', this.peers.size);
      }
    });

    ws.on('error', () => {});
  }

  _handleHello(ws, msg, remote) {
    if (this.password && !safeEqual(msg.password || '', this.password)) {
      this._send(ws, { type: 'error', code: 'bad-password', message: 'Wrong server password' });
      ws.close(4001, 'bad password');
      return null;
    }
    if (this.peers.size >= this.maxPeers) {
      this._send(ws, { type: 'error', code: 'full', message: 'Server is full' });
      ws.close(4002, 'full');
      return null;
    }
    const userId = typeof msg.userId === 'string' ? msg.userId.slice(0, 64) : crypto.randomUUID();
    // The same user reconnecting (e.g. after a network drop) replaces the old session.
    for (const existing of this.peers.values()) {
      if (existing.userId === userId) existing.ws.close(4003, 'replaced by new session');
    }
    const peer = {
      id: crypto.randomUUID(),
      userId,
      name: cleanName(msg.name, 'Anonymous'),
      ws,
      voice: null,
      muted: false,
      deafened: false,
      alive: true,
    };
    const others = [...this.peers.values()].filter((p) => p.userId !== userId).map((p) => this._publicPeer(p));
    this.peers.set(peer.id, peer);
    this._send(ws, {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      id: peer.id,
      serverName: this.name,
      channels: this.channels,
      peers: others,
      iceServers: this.iceServers,
    });
    this._broadcast({ type: 'peer-joined', peer: this._publicPeer(peer) }, peer.id);
    this.emit('log', `${peer.name} joined from ${remote} (${this.peers.size} online)`);
    this.emit('peers', this.peers.size);
    return peer;
  }

  _channel(id, type) {
    return this.channels.find((c) => c.id === id && (!type || c.type === type));
  }

  _channelsChanged() {
    this._saveChannels();
    this._broadcast({ type: 'channels', channels: this.channels });
  }
}

module.exports = { SignalingServer, DEFAULT_CHANNELS, PROTOCOL_VERSION };
