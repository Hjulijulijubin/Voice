import { Emitter, uid } from './util.js';
import { store } from './store.js';
import { Overlay, DEFAULT_ICE_SERVERS } from './overlay.js';
import { FileManager } from './files.js';
import { deriveRoomKeys, loadIdentity, generateIdentity, signObject, verifyObject, peerIdFromPub, b64uDecode, b64uEncode, inviteFromSecret } from './crypto.js';

export const ROOM_CHANNEL = '__room';
const MAX_TEXT = 4000;
const SYNC_BATCH_BYTES = 120 * 1024;

/** Channels every room starts with, so it's usable before any sync. */
const DEFAULT_CHANNELS = [
  { id: 'general', name: 'general', type: 'text' },
  { id: 'voice', name: 'Voice', type: 'voice' },
];

/** Create the local record for a brand-new or joined room. */
export async function newRoomRecord(secret, name = '') {
  const { roomId } = await deriveRoomKeys(secret);
  return { roomId, secret: b64uEncode(secret), identity: await generateIdentity(), name, joinedAt: Date.now() };
}

/**
 * One room ("server"/group chat). Everything about it is derived from its
 * secret; its state is the merge of signed messages and ops held by members.
 */
export class Room extends Emitter {
  constructor(record, ctx) {
    super();
    this.record = record;
    this.ctx = ctx; // { settings, getName, onAudioPacket, onCustomRoutes }
    this.settings = ctx.settings;
    this.name = record.name || 'New room';
    this.channels = DEFAULT_CHANNELS.map((c) => ({ ...c }));
    this.ops = [];
    this.syncedWith = new Set();
    this.syncQueue = [];
    this.syncing = null;
    this.typing = new Map();
    this.unread = new Map();
  }

  get invite() {
    return inviteFromSecret(b64uDecode(this.record.secret));
  }

  async start() {
    this.keys = await deriveRoomKeys(b64uDecode(this.record.secret));
    this.id = this.keys.roomId;
    this.identity = await loadIdentity(this.record.identity);
    this.selfId = this.identity.id;

    this.overlay = new Overlay({
      selfId: this.selfId,
      topic: this.keys.topic,
      sigKey: this.keys.sigKey,
      dataKey: this.keys.dataKey,
      iceServers: [...DEFAULT_ICE_SERVERS, ...this.ctx.extraIce()],
      getQuality: () => this.settings.quality,
      getJitterTargetMs: () => this.settings.jitterTargetMs,
      getMode: () => this.settings.audioMode,
      rendezvous: window.voice.rendezvous,
      relayAllowed: this.settings.allowRelay,
      info: { name: this.ctx.getName(), pub: this.identity.pub, voice: null, muted: false, deafened: false },
    });
    this.files = new FileManager(this);
    await this.files.init();

    this.ops = await store.getMessages(this.id, ROOM_CHANNEL, 5000);
    this._applyOps();

    const ov = this.overlay;
    ov.on('message', (from, msg) => this._onMessage(from, msg).catch((err) => console.warn('message error', err)));
    ov.on('peer-open', (id) => {
      this.overlay.sendTo(id, { t: 'holders', recs: this.files.allRecords() });
      this._queueSync(id);
    });
    ov.on('roster', () => {
      // Members reachable only through relays never get "peer-open": sync with them too.
      for (const m of ov.roster()) if (!this.syncedWith.has(m.id) && !this.syncQueue.includes(m.id) && this.syncing !== m.id) this._queueSync(m.id);
      this.emit('roster');
    });
    ov.on('node-gone', (id) => {
      this.files.peerGone(id);
      this.syncedWith.delete(id);
      this.emit('roster');
    });
    ov.on('speaking', () => this.emit('speaking'));
    ov.on('audio-packet', (p) => this.ctx.onAudioPacket(this, p));
    ov.on('custom-routes', (n) => this.ctx.onCustomRoutes(this, n));
    ov.on('file-frame', (p) => this.files.onFrame(p));
    this.files.on('holders', (fileId) => this.emit('holders', fileId));
    this.files.on('progress', (fileId, frac) => this.emit('progress', fileId, frac));
    this.files.on('uploads', (n) => this.emit('uploads', n));
    await ov.start();
  }

  stop() {
    this.overlay?.stop();
  }

  setName(name) {
    this.overlay?.setInfo({ name });
  }

  // ---------------------------------------------------------------- state
  _applyOps() {
    const channels = new Map(DEFAULT_CHANNELS.map((c) => [c.id, { ...c }]));
    let name = this.record.name || '';
    const sorted = [...this.ops].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    for (const { op } of sorted) {
      if (!op || typeof op !== 'object') continue;
      if (op.kind === 'name' && typeof op.value === 'string') name = op.value.slice(0, 40);
      if (op.kind === 'channel-add' && typeof op.cid === 'string' && !channels.has(op.cid)) {
        channels.set(op.cid, { id: op.cid, name: String(op.name).slice(0, 32), type: op.type === 'voice' ? 'voice' : 'text' });
      }
      if (op.kind === 'channel-rename' && channels.has(op.cid)) channels.get(op.cid).name = String(op.name).slice(0, 32);
      if (op.kind === 'channel-del') channels.delete(op.cid);
    }
    if (![...channels.values()].some((c) => c.type === 'text')) channels.set('general', { ...DEFAULT_CHANNELS[0] });
    this.channels = [...channels.values()];
    if (name && name !== this.name) {
      this.name = name;
      if (this.record.name !== name) {
        this.record.name = name;
        store.putRoom(this.record);
      }
    }
    this.emit('state');
  }

  async applyOp(op) {
    await this._post(ROOM_CHANNEL, '', null, op);
  }

  // ---------------------------------------------------------------- messages
  async _post(channel, text, file, op) {
    const body = {
      id: uid(),
      channel,
      ts: Date.now(),
      text: String(text).slice(0, MAX_TEXT),
      author: { id: this.selfId, name: this.ctx.getName(), pub: this.identity.pub },
    };
    if (file) body.file = file;
    if (op) body.op = op;
    const msg = { ...body, sig: await signObject(this.identity, body) };
    this.overlay.broadcast({ t: 'msg', m: msg });
    await this._ingest([msg], false);
    return msg;
  }

  sendMessage(channel, text, file = null) {
    return this._post(channel, text, file, null);
  }

  async shareFile(channel, fileObj) {
    const meta = await this.files.share(fileObj);
    return this._post(channel, '', meta, null);
  }

  /** Validate structure + signature. */
  async _verify(m) {
    if (!m || typeof m.id !== 'string' || m.id.length > 64 || typeof m.channel !== 'string' || m.channel.length > 64) return null;
    if (typeof m.ts !== 'number' || typeof m.text !== 'string' || m.text.length > MAX_TEXT || typeof m.sig !== 'string') return null;
    const a = m.author;
    if (!a || typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.pub !== 'string') return null;
    if (m.file) {
      const f = m.file;
      if (typeof f.id !== 'string' || !/^[0-9a-f]{32}$/.test(f.id) || typeof f.name !== 'string' || typeof f.size !== 'number' || typeof f.sha256 !== 'string') return null;
    }
    if ((await peerIdFromPub(a.pub)) !== a.id) return null;
    const body = { id: m.id, channel: m.channel, ts: m.ts, text: m.text, author: { id: a.id, name: a.name, pub: a.pub } };
    if (m.file) body.file = m.file;
    if (m.op) body.op = m.op;
    if (!(await verifyObject(a.pub, body, m.sig))) return null;
    return { ...body, sig: m.sig };
  }

  async _ingest(msgs, live) {
    const fresh = await store.addMessages(this.id, msgs);
    if (!fresh.length) return fresh;
    const ops = fresh.filter((m) => m.channel === ROOM_CHANNEL);
    if (ops.length) {
      this.ops.push(...ops);
      this._applyOps();
    }
    const chat = fresh.filter((m) => m.channel !== ROOM_CHANNEL);
    for (const m of chat) {
      if (m.file) this.files.register(m.file);
      this.typing.delete(m.author.id);
    }
    if (chat.length) this.emit('messages', chat, live);
    return fresh;
  }

  async _onMessage(from, msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'msg': {
        const m = await this._verify(msg.m);
        // Live messages must come from their author (relays forward encrypted).
        if (m && m.author.id === from) await this._ingest([m], true);
        break;
      }
      case 'sync':
        await this._answerSync(from, msg.summary);
        break;
      case 'sync-data': {
        if (!Array.isArray(msg.msgs)) return;
        const verified = (await Promise.all(msg.msgs.slice(0, 2000).map((m) => this._verify(m)))).filter(Boolean);
        await this._ingest(verified, false);
        break;
      }
      case 'sync-done':
        if (this.syncing === from) this._syncNext(true);
        break;
      case 'holders':
        await this.files.onHolders(msg.recs);
        break;
      case 'typing':
        if (typeof msg.channel === 'string') {
          const name = this.overlay.ls.nodes.get(from)?.info.name || 'Someone';
          this.typing.set(from, { name, channel: msg.channel, until: Date.now() + 4000 });
          this.emit('typing');
        }
        break;
      case 'f-req':
        this.files.onRequest(from, msg);
        break;
      case 'f-err':
        this.files.onError(from, msg);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- sync
  // History sync compares per-day {count, hash} summaries and only exchanges
  // the days that differ. Peers are synced one after another, so a newcomer
  // downloads the history once instead of once per member.
  _queueSync(id) {
    if (this.syncQueue.includes(id) || this.syncing === id) return;
    this.syncQueue.push(id);
    if (!this.syncing) this._syncNext(false);
  }

  async _syncNext(completed) {
    if (completed && this.syncing) this.syncedWith.add(this.syncing);
    clearTimeout(this._syncTimer);
    this.syncing = this.syncQueue.shift() || null;
    if (!this.syncing) return;
    const id = this.syncing;
    const summary = await store.summary(this.id);
    if (!this.overlay.sendTo(id, { t: 'sync', summary })) return this._syncNext(true);
    // No answer: count it as done for this session (avoids retry storms).
    this._syncTimer = setTimeout(() => this.syncing === id && this._syncNext(true), 15000);
  }

  async _answerSync(to, theirs) {
    if (!theirs || typeof theirs !== 'object') return;
    const mine = await store.summary(this.id);
    let batch = [];
    let bytes = 0;
    const flush = () => {
      if (batch.length) this.overlay.sendTo(to, { t: 'sync-data', msgs: batch });
      batch = [];
      bytes = 0;
    };
    for (const [day, [n, h]] of Object.entries(mine)) {
      const t = theirs[day];
      if (Array.isArray(t) && t[0] === n && t[1] === h) continue;
      for (const m of await store.getDay(this.id, Number(day))) {
        const { room: _r, day: _d, ...clean } = m;
        const size = JSON.stringify(clean).length;
        if (bytes + size > SYNC_BATCH_BYTES) flush();
        batch.push(clean);
        bytes += size;
      }
    }
    flush();
    this.overlay.sendTo(to, { t: 'sync-done' });
  }

  sendTyping(channel) {
    this.overlay.broadcast({ t: 'typing', channel });
  }

  /** Room roster including ourselves. */
  members() {
    const self = { id: this.selfId, self: true, info: this.overlay.info, direct: true, rtt: 0, route: null };
    return [self, ...this.overlay.roster()];
  }
}

