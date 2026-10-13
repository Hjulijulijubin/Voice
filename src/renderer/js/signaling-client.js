import { Emitter } from './util.js';

/**
 * WebSocket client for the signaling server. Only presence and WebRTC
 * handshakes go through here; all content is peer-to-peer.
 */
export class SignalingClient extends Emitter {
  constructor() {
    super();
    this.ws = null;
    this.id = null;
    this._pingTimer = null;
    this.latency = null;
  }

  static normalizeUrl(address) {
    let url = address.trim();
    if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
    const parsed = new URL(url);
    if (!parsed.port && parsed.protocol === 'ws:') parsed.port = '9987';
    return parsed.toString().replace(/\/$/, '');
  }

  /**
   * Connect and authenticate. Resolves with the server's welcome message.
   */
  connect(address, { name, userId, password }) {
    const url = SignalingClient.normalizeUrl(address);
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;
      const timeout = setTimeout(() => fail(new Error('Connection timed out')), 10000);

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };

      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', name, userId, password, protocol: 1 }));
      ws.onerror = () => fail(new Error(`Could not reach ${url}`));
      ws.onclose = (ev) => {
        clearInterval(this._pingTimer);
        if (!settled) return fail(new Error(ev.reason || `Could not reach ${url}`));
        if (this.ws === ws) this.emit('disconnected', ev);
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!settled) {
          if (msg.type === 'error') return fail(new Error(msg.message || msg.code));
          if (msg.type === 'welcome') {
            settled = true;
            clearTimeout(timeout);
            this.id = msg.id;
            this.url = url;
            this._startPing();
            resolve(msg);
          }
          return;
        }
        if (msg.type === 'pong') {
          this.latency = performance.now() - msg.t;
          return;
        }
        this.emit(msg.type, msg);
      };
    });
  }

  _startPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => this.send({ type: 'ping', t: performance.now() }), 5000);
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  signal(to, data) {
    this.send({ type: 'signal', to, data });
  }

  close() {
    clearInterval(this._pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.close(1000, 'bye');
  }
}
