'use strict';

/**
 * Serverless rendezvous: how members of a room find each other.
 *
 * A room is identified on the wire only by its `topic` (an HKDF hash of the
 * room secret). Peers publish small, already-encrypted handshake blobs
 * (produced by the renderer with the room key) to that topic over:
 *
 *   1. Public Nostr relays — ephemeral events (kind 20000–29999) that relays
 *      forward live and never store. Any Nostr relay works, including the
 *      minimal one in /server. Events are signed with a throw-away key per
 *      app session, so nothing links them to a person.
 *   2. LAN multicast — works with no internet at all.
 *
 * Relays only ever see: a random-looking topic, an ephemeral public key and
 * an encrypted blob. They cannot read, forge or modify anything (AES-GCM).
 * Once two peers are connected, everything else goes peer-to-peer and
 * further handshakes are routed through the peer mesh instead.
 */

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');

const EVENT_KIND = 20078;
const LAN_GROUP = '239.255.71.77';
const LAN_PORT = 47177;
const MAX_LAN_PAYLOAD = 60000;

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.snort.social'];

let schnorrPromise = null;
function loadSchnorr() {
  if (!schnorrPromise) schnorrPromise = import('@noble/curves/secp256k1.js').then((m) => m.schnorr);
  return schnorrPromise;
}

class RelayConnection {
  constructor(url, owner) {
    this.url = url;
    this.owner = owner;
    this.ws = null;
    this.backoff = 1000;
    this.closed = false;
    this.open = false;
    this._timer = null;
    this.outbox = []; // events published while (re)connecting
    this.connect();
  }

  connect() {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 8000 });
    } catch {
      return this._retry();
    }
    this.ws = ws;
    ws.on('open', () => {
      this.open = true;
      this.backoff = 1000;
      for (const topic of this.owner.topics) this.subscribe(topic);
      // Flush what was published while connecting (if still fresh).
      const fresh = this.outbox.filter((o) => Date.now() - o.at < 30000);
      this.outbox = [];
      for (const o of fresh) this.send(o.msg);
      this.owner.emit('status');
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[2]) this.owner._onEvent(msg[2], this.url);
    });
    ws.on('close', () => {
      this.open = false;
      this.owner.emit('status');
      this._retry();
    });
    ws.on('error', () => {});
  }

  _retry() {
    if (this.closed) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60000);
  }

  send(arr, queue = false) {
    if (this.open && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(arr));
    else if (queue) {
      this.outbox.push({ msg: arr, at: Date.now() });
      if (this.outbox.length > 50) this.outbox.shift();
    }
  }

  subscribe(topic) {
    // Only live events: ephemeral events are never stored anyway.
    this.send(['REQ', topic.slice(0, 32), { kinds: [EVENT_KIND], '#t': [topic], since: Math.floor(Date.now() / 1000) - 30 }]);
  }

  unsubscribe(topic) {
    this.send(['CLOSE', topic.slice(0, 32)]);
  }

  close() {
    this.closed = true;
    clearTimeout(this._timer);
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
  }
}

class Rendezvous extends EventEmitter {
  constructor() {
    super();
    this.topics = new Set();
    this.relayUrls = [...DEFAULT_RELAYS];
    this.lanEnabled = true;
    this.relays = new Map();
    this.seen = new Map(); // event id -> time (dedupe across relays)
    this.sessionKey = null;
    this.sessionPub = null;
    this.lan = null;
    this.lanSession = crypto.randomBytes(8).toString('hex');
  }

  configure({ relays, lan }) {
    if (Array.isArray(relays)) {
      this.relayUrls = relays.filter((u) => /^wss?:\/\//i.test(u));
    }
    if (typeof lan === 'boolean') this.lanEnabled = lan;
    this._sync();
  }

  join(topic) {
    if (!/^[0-9a-f]{64}$/.test(topic) || this.topics.has(topic)) return;
    this.topics.add(topic);
    this._sync();
    for (const r of this.relays.values()) r.subscribe(topic);
  }

  leave(topic) {
    if (!this.topics.delete(topic)) return;
    for (const r of this.relays.values()) r.unsubscribe(topic);
    this._sync();
  }

  status() {
    return {
      relays: [...this.relays.values()].map((r) => ({ url: r.url, open: r.open })),
      lan: !!this.lan,
    };
  }

  /** Connect only while at least one room is joined (no idle sockets). */
  _sync() {
    const active = this.topics.size > 0;
    const wanted = active ? new Set(this.relayUrls) : new Set();
    for (const [url, r] of this.relays) {
      if (!wanted.has(url)) {
        r.close();
        this.relays.delete(url);
      }
    }
    for (const url of wanted) if (!this.relays.has(url)) this.relays.set(url, new RelayConnection(url, this));
    if (active && this.lanEnabled) this._startLan();
    else this._stopLan();
    this.emit('status');
  }

  async publish(topic, payload) {
    if (!this.topics.has(topic) || typeof payload !== 'string') return;
    // Nostr
    if (this.relays.size) {
      const schnorr = await loadSchnorr();
      if (!this.sessionKey) {
        this.sessionKey = schnorr.utils.randomSecretKey();
        this.sessionPub = Buffer.from(schnorr.getPublicKey(this.sessionKey)).toString('hex');
      }
      const ev = {
        pubkey: this.sessionPub,
        created_at: Math.floor(Date.now() / 1000),
        kind: EVENT_KIND,
        tags: [['t', topic]],
        content: payload,
      };
      const id = crypto.createHash('sha256').update(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])).digest();
      ev.id = id.toString('hex');
      ev.sig = Buffer.from(schnorr.sign(new Uint8Array(id), this.sessionKey)).toString('hex');
      for (const r of this.relays.values()) r.send(['EVENT', ev], true);
    }
    // LAN
    if (this.lan && payload.length < MAX_LAN_PAYLOAD) {
      const msg = Buffer.from(JSON.stringify({ v: 1, s: this.lanSession, t: topic, p: payload }));
      for (const addr of this._lanTargets()) this.lan.send(msg, LAN_PORT, addr, () => {});
    }
  }

  _onEvent(ev, via) {
    if (!ev || ev.kind !== EVENT_KIND || typeof ev.content !== 'string' || typeof ev.id !== 'string') return;
    if (ev.pubkey === this.sessionPub) return;
    if (this.seen.has(ev.id)) return;
    this._remember(ev.id);
    const tag = Array.isArray(ev.tags) && ev.tags.find((t) => Array.isArray(t) && t[0] === 't' && this.topics.has(t[1]));
    if (!tag) return;
    this.emit('message', { topic: tag[1], payload: ev.content, via });
  }

  _remember(id) {
    this.seen.set(id, Date.now());
    if (this.seen.size > 4000) {
      // Drop the oldest half.
      let i = 0;
      for (const key of this.seen.keys()) {
        if (i++ > 2000) break;
        this.seen.delete(key);
      }
    }
  }

  // ------------------------------------------------------------- LAN
  _lanTargets() {
    return [LAN_GROUP];
  }

  _startLan() {
    if (this.lan) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => this._stopLan());
    sock.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (!msg || msg.v !== 1 || msg.s === this.lanSession || !this.topics.has(msg.t) || typeof msg.p !== 'string') return;
      this.emit('message', { topic: msg.t, payload: msg.p, via: 'lan' });
    });
    sock.bind(LAN_PORT, () => {
      try {
        sock.setMulticastTTL(1);
        sock.setMulticastLoopback(true);
        let joined = false;
        for (const list of Object.values(os.networkInterfaces())) {
          for (const ni of list || []) {
            if (ni.family !== 'IPv4') continue;
            try {
              sock.addMembership(LAN_GROUP, ni.address);
              joined = true;
            } catch {
              /* interface without multicast */
            }
          }
        }
        if (!joined) sock.addMembership(LAN_GROUP);
      } catch {
        this._stopLan();
      }
    });
    this.lan = sock;
  }

  _stopLan() {
    if (!this.lan) return;
    try {
      this.lan.close();
    } catch {
      /* ignore */
    }
    this.lan = null;
  }

  stop() {
    this.topics.clear();
    this._sync();
  }
}

module.exports = { Rendezvous, DEFAULT_RELAYS, EVENT_KIND };
