'use strict';

/**
 * Minimal Nostr relay for *ephemeral* events (kinds 20000–29999).
 *
 * Voice works without any server of your own: by default clients meet on
 * public Nostr relays or on the LAN. Run this if you prefer a private
 * rendezvous point. It stores nothing: events are forwarded live to matching
 * subscriptions and then forgotten. Payloads are end-to-end encrypted by the
 * clients, so the relay only sees random topics and ciphertext.
 */

const http = require('node:http');
const { EventEmitter } = require('node:events');
const { WebSocketServer, WebSocket } = require('ws');

const MAX_SUBS = 32;
const MAX_EVENTS_PER_10S = 60;

function matches(filter, ev) {
  if (!filter || typeof filter !== 'object') return false;
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(ev.kind)) return false;
  if (typeof filter.since === 'number' && ev.created_at < filter.since) return false;
  if (Array.isArray(filter.authors) && !filter.authors.includes(ev.pubkey)) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (key[0] !== '#' || !Array.isArray(values)) continue;
    const name = key.slice(1);
    if (!ev.tags.some((t) => Array.isArray(t) && t[0] === name && values.includes(t[1]))) return false;
  }
  return true;
}

function validEvent(ev) {
  return (
    ev &&
    typeof ev.id === 'string' &&
    typeof ev.pubkey === 'string' &&
    typeof ev.kind === 'number' &&
    typeof ev.created_at === 'number' &&
    typeof ev.content === 'string' &&
    Array.isArray(ev.tags)
  );
}

class Relay extends EventEmitter {
  constructor({ port = 7777, host = '0.0.0.0', name = 'Voice relay' } = {}) {
    super();
    this.port = port;
    this.host = host;
    this.name = name;
    this.clients = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.http = http.createServer((req, res) => {
        if (req.headers.accept === 'application/nostr+json') {
          res.writeHead(200, { 'content-type': 'application/nostr+json', 'access-control-allow-origin': '*' });
          return res.end(
            JSON.stringify({ name: this.name, description: 'Ephemeral-only relay for Voice', supported_nips: [1, 11, 16], software: 'voice-relay' }),
          );
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`${this.name}: ${this.clients.size} connected\n`);
      });
      this.wss = new WebSocketServer({ server: this.http, maxPayload: 128 * 1024 });
      this.wss.on('connection', (ws) => this._onConnection(ws));
      this.http.once('error', reject);
      this.http.listen(this.port, this.host, () => {
        this.port = this.http.address().port;
        this._heartbeat = setInterval(() => {
          for (const c of this.clients) {
            if (!c.alive) {
              c.ws.terminate();
              continue;
            }
            c.alive = false;
            c.ws.ping();
          }
        }, 30000);
        resolve({ port: this.port });
      });
    });
  }

  stop() {
    clearInterval(this._heartbeat);
    for (const c of this.clients) c.ws.terminate();
    return new Promise((resolve) => (this.wss ? this.wss.close(() => this.http.close(() => resolve())) : resolve()));
  }

  _onConnection(ws) {
    const client = { ws, subs: new Map(), alive: true, window: Date.now(), count: 0 };
    this.clients.add(client);
    this.emit('log', `client connected (${this.clients.size})`);
    ws.on('pong', () => (client.alive = true));
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      const [type, a, ...rest] = msg;
      if (type === 'REQ' && typeof a === 'string') {
        if (client.subs.size >= MAX_SUBS && !client.subs.has(a)) return this._send(ws, ['CLOSED', a, 'error: too many subscriptions']);
        client.subs.set(a, rest);
        this._send(ws, ['EOSE', a]);
      } else if (type === 'CLOSE' && typeof a === 'string') {
        client.subs.delete(a);
      } else if (type === 'EVENT' && validEvent(a)) {
        const now = Date.now();
        if (now - client.window > 10000) {
          client.window = now;
          client.count = 0;
        }
        if (++client.count > MAX_EVENTS_PER_10S) return this._send(ws, ['OK', a.id, false, 'rate-limited: slow down']);
        if (a.kind < 20000 || a.kind >= 30000) return this._send(ws, ['OK', a.id, false, 'blocked: only ephemeral events']);
        this._send(ws, ['OK', a.id, true, '']);
        this._broadcast(a, client);
      }
    });
  }

  _broadcast(ev, from) {
    for (const c of this.clients) {
      if (c === from) continue;
      for (const [subId, filters] of c.subs) {
        if (filters.some((f) => matches(f, ev))) {
          this._send(c.ws, ['EVENT', subId, ev]);
          break;
        }
      }
    }
  }

  _send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}

module.exports = { Relay, matches };
