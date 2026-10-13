import { Emitter } from './util.js';
import { store } from './store.js';
import { seal, open, randomHex, fromHex, toHex, signObject, verifyObject, peerIdFromPub } from './crypto.js';

const CHUNK = 64 * 1024;
const WINDOW = 32; // chunks requested at once (2 MB) — bounds memory at relays
const READ_BLOCK = 16; // chunks per disk read
const WRITE_BLOCK = 16 * CHUNK; // bytes buffered before a disk write
const STALL_MS = 15000;
const HIGH_WATER = 4 * 1024 * 1024;
const fs = () => window.voice.files;

/**
 * Peer-to-peer file sharing with local storage on every member's disk.
 *
 * - Files live on disk (main process), never fully in memory.
 * - Transfers go to/through any route (direct or relayed); every chunk is
 *   AES-GCM encrypted with the room key, and the whole file is verified
 *   against the SHA-256 the uploader signed.
 * - Every member publishes a signed "holder" record per file (has / deleted).
 *   When no member holds a file any more, it disappears from the chat.
 */
export class FileManager extends Emitter {
  constructor(room) {
    super();
    this.room = room;
    /** fileId -> Map(peerId -> record) */
    this.holders = new Map();
    /** fileId -> size on disk */
    this.local = new Map();
    this.metas = new Map();
    this.downloads = new Map();
    this.uploads = new Map();
  }

  get roomId() {
    return this.room.id;
  }

  async init() {
    for (const { fileId, size } of await fs().list(this.roomId)) this.local.set(fileId, size);
    for (const rec of await store.holders(this.roomId)) this._setRec(rec);
    // Files on disk without our own record (e.g. after a crash) are announced.
    for (const fileId of this.local.keys()) {
      const mine = this.holders.get(fileId)?.get(this.room.selfId);
      if (!mine || !mine.has) await this.setHolder(fileId, true, false);
    }
  }

  _setRec(rec) {
    if (!this.holders.has(rec.fileId)) this.holders.set(rec.fileId, new Map());
    this.holders.get(rec.fileId).set(rec.peer, rec);
  }

  holdersOf(fileId) {
    return [...(this.holders.get(fileId)?.values() || [])].filter((r) => r.has).map((r) => r.peer);
  }

  /** True once every member who ever had the file has deleted it. */
  isGone(fileId) {
    const recs = this.holders.get(fileId);
    return !!recs && recs.size > 0 && ![...recs.values()].some((r) => r.has);
  }

  hasLocal(fileId) {
    return this.local.has(fileId);
  }

  deletedByMe(fileId) {
    return this.holders.get(fileId)?.get(this.room.selfId)?.has === false;
  }

  url(meta) {
    return `voicefile://${this.roomId}/${meta.id}?type=${encodeURIComponent(meta.type || 'application/octet-stream')}`;
  }

  // ------------------------------------------------------------ holders
  async setHolder(fileId, has, broadcast = true) {
    const body = { fileId, peer: this.room.selfId, has, ts: Date.now() };
    const rec = { ...body, pub: this.room.identity.pub, sig: await signObject(this.room.identity, body) };
    const changed = await store.mergeHolders(this.roomId, [rec]);
    changed.forEach((r) => this._setRec(r));
    if (broadcast) this.room.overlay.broadcast({ t: 'holders', recs: [rec] });
    this.emit('holders', fileId);
    return rec;
  }

  async onHolders(recs) {
    if (!Array.isArray(recs)) return;
    const valid = [];
    await Promise.all(
      recs.slice(0, 2000).map(async (r) => {
        if (!r || typeof r.fileId !== 'string' || !/^[0-9a-f]{32}$/.test(r.fileId) || typeof r.has !== 'boolean' || typeof r.ts !== 'number') return;
        if (typeof r.pub !== 'string' || (await peerIdFromPub(r.pub)) !== r.peer) return;
        if (!(await verifyObject(r.pub, { fileId: r.fileId, peer: r.peer, has: r.has, ts: r.ts }, r.sig))) return;
        valid.push({ fileId: r.fileId, peer: r.peer, has: r.has, ts: r.ts, pub: r.pub, sig: r.sig });
      }),
    );
    const changed = await store.mergeHolders(this.roomId, valid);
    for (const rec of changed) {
      this._setRec(rec);
      this.emit('holders', rec.fileId);
      const meta = this.metas.get(rec.fileId);
      if (rec.has && meta) this.maybeAutoDownload(meta);
    }
  }

  /** All holder records, for syncing a newly connected peer. */
  allRecords() {
    const out = [];
    for (const recs of this.holders.values()) for (const r of recs.values()) out.push({ fileId: r.fileId, peer: r.peer, has: r.has, ts: r.ts, pub: r.pub, sig: r.sig });
    return out;
  }

  // ------------------------------------------------------------ sharing
  /** Copy a local file into the room's storage; returns signed-ready metadata. */
  async share(file) {
    const id = randomHex(16);
    const path = fs().pathFor(file);
    let result;
    if (path) {
      result = await fs().importPath(this.roomId, id, path);
    } else {
      // Pasted data without a path: stream it through in 1 MB pieces.
      const token = await fs().begin(this.roomId, id);
      try {
        for (let off = 0; off < file.size; off += WRITE_BLOCK) {
          await fs().write(token, off, new Uint8Array(await file.slice(off, off + WRITE_BLOCK).arrayBuffer()));
        }
        result = await fs().finish(token);
      } catch (err) {
        await fs().abort(token);
        throw err;
      }
    }
    this.local.set(id, result.size);
    const meta = { id, name: file.name || 'pasted-file', size: result.size, type: file.type || 'application/octet-stream', sha256: result.sha256 };
    this.metas.set(id, meta);
    await this.setHolder(id, true);
    return meta;
  }

  /** A chat message referenced a file. */
  register(meta) {
    if (!this.metas.has(meta.id)) this.metas.set(meta.id, meta);
    this.maybeAutoDownload(meta);
  }

  maybeAutoDownload(meta) {
    const limitMb = this.room.settings.autoDownloadMB;
    if (this.local.has(meta.id) || this.downloads.has(meta.id) || this.deletedByMe(meta.id)) return;
    if (limitMb === 0 || (limitMb > 0 && meta.size > limitMb * 1024 * 1024)) return;
    if (!this._sources(meta.id).length) return;
    this.download(meta).catch(() => {});
  }

  async deleteLocal(fileId) {
    this.downloads.get(fileId)?.cancel();
    await fs().remove(this.roomId, fileId);
    this.local.delete(fileId);
    await this.setHolder(fileId, false);
  }

  /** Leaving the room: tell everyone we no longer hold anything. */
  async releaseAll() {
    const recs = [];
    for (const fileId of this.local.keys()) recs.push(await this.setHolder(fileId, false, false));
    if (recs.length) this.room.overlay.broadcast({ t: 'holders', recs });
  }

  /** Online holders, fastest route first. */
  _sources(fileId) {
    const holders = new Set(this.holdersOf(fileId));
    return this.room.overlay
      .roster()
      .filter((m) => holders.has(m.id))
      .sort((a, b) => (a.route?.cost ?? 1e9) - (b.route?.cost ?? 1e9))
      .map((m) => m.id);
  }

  // ------------------------------------------------------------ download
  download(meta) {
    if (this.local.has(meta.id)) return Promise.resolve();
    if (this.downloads.has(meta.id)) return this.downloads.get(meta.id).promise;
    const total = Math.ceil(meta.size / CHUNK);
    const tried = new Set();
    let resolveFn;
    let rejectFn;
    const dl = {
      meta,
      total,
      next: 0, // next chunk index expected
      requested: 0, // chunks requested so far from the current source
      source: null,
      token: null,
      pending: [], // decrypted chunks not yet written
      pendingBytes: 0,
      writing: Promise.resolve(),
      timer: null,
      promise: new Promise((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      }),
      cancel: () => fail(new Error('cancelled')),
    };
    const fail = async (err) => {
      clearTimeout(dl.timer);
      this.downloads.delete(meta.id);
      if (dl.token) await fs().abort(dl.token).catch(() => {});
      this.emit('progress', meta.id, null);
      rejectFn(err);
    };
    dl.touch = () => {
      clearTimeout(dl.timer);
      dl.timer = setTimeout(() => dl.nextSource(), STALL_MS);
    };
    dl.request = () => {
      const count = Math.min(WINDOW, total - dl.requested);
      if (count <= 0) return;
      this.room.overlay.sendTo(dl.source, { t: 'f-req', fileId: meta.id, index: dl.requested, count });
      dl.requested += count;
    };
    dl.nextSource = () => {
      const src = this._sources(meta.id).find((id) => !tried.has(id));
      if (!src) return fail(new Error('Nobody online has this file right now'));
      tried.add(src);
      dl.source = src;
      dl.requested = dl.next; // resume where we are
      dl.touch();
      dl.request();
      dl.request(); // keep two windows in flight
    };
    dl.onChunk = async (index, data) => {
      if (index !== dl.next) return; // stale data from a previous source
      dl.next++;
      dl.touch();
      dl.pending.push(data);
      dl.pendingBytes += data.length;
      this.emit('progress', meta.id, dl.next / total);
      if (dl.requested - dl.next < WINDOW) dl.request();
      const last = dl.next === total;
      if (dl.pendingBytes >= WRITE_BLOCK || last) {
        const chunks = dl.pending;
        const offset = (dl.next - chunks.length) * CHUNK;
        dl.pending = [];
        dl.pendingBytes = 0;
        const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of chunks) {
          buf.set(c, o);
          o += c.length;
        }
        dl.writing = dl.writing.then(() => fs().write(dl.token, offset, buf));
      }
      if (last) {
        clearTimeout(dl.timer);
        try {
          await dl.writing;
          await fs().finish(dl.token, meta.sha256);
          this.downloads.delete(meta.id);
          this.local.set(meta.id, meta.size);
          await this.setHolder(meta.id, true);
          this.emit('progress', meta.id, 1);
          resolveFn();
        } catch (err) {
          dl.token = null;
          fail(err);
        }
      }
    };
    this.downloads.set(meta.id, dl);
    (async () => {
      dl.token = await fs().begin(this.roomId, meta.id);
      if (total === 0) {
        dl.next = 0;
        await fs().finish(dl.token, meta.sha256);
        this.downloads.delete(meta.id);
        this.local.set(meta.id, 0);
        await this.setHolder(meta.id, true);
        this.emit('progress', meta.id, 1);
        return resolveFn();
      }
      dl.nextSource();
    })().catch(fail);
    return dl.promise;
  }

  /** Incoming chunk frame: [16 fileId][u32 index][sealed chunk] */
  async onFrame(payload) {
    if (payload.length < 20 + 28) return;
    const fileId = toHex(payload.subarray(0, 16));
    const dl = this.downloads.get(fileId);
    if (!dl) return;
    const index = new DataView(payload.buffer, payload.byteOffset + 16, 4).getUint32(0);
    let data;
    try {
      data = await open(this.room.keys.dataKey, payload.subarray(20), `${fileId}:${index}`);
    } catch {
      return;
    }
    dl.queue = (dl.queue || Promise.resolve()).then(() => dl.onChunk(index, data));
  }

  // ------------------------------------------------------------ upload
  async onRequest(from, msg) {
    const { fileId, index, count } = msg;
    if (typeof fileId !== 'string' || !/^[0-9a-f]{32}$/.test(fileId) || !Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > WINDOW) return;
    if (!this.local.has(fileId)) {
      this.room.overlay.sendTo(from, { t: 'f-err', fileId });
      return;
    }
    const key = `${from}:${fileId}`;
    // Windows for the same transfer are served in order.
    const prev = this.uploads.get(key) || Promise.resolve();
    const job = prev.then(() => this._send(from, fileId, index, count)).catch(() => {});
    this.uploads.set(key, job);
    this.emit('uploads', this.uploads.size);
    await job;
    if (this.uploads.get(key) === job) {
      this.uploads.delete(key);
      this.emit('uploads', this.uploads.size);
    }
  }

  async _send(to, fileId, index, count) {
    const size = this.local.get(fileId);
    const total = Math.ceil(size / CHUNK);
    const end = Math.min(total, index + count);
    const idBytes = fromHex(fileId);
    for (let block = index; block < end; block += READ_BLOCK) {
      const n = Math.min(READ_BLOCK, end - block);
      const bytes = await fs().read(this.roomId, fileId, block * CHUNK, n * CHUNK);
      for (let k = 0; k < n; k++) {
        const i = block + k;
        const chunk = bytes.subarray(k * CHUNK, (k + 1) * CHUNK);
        const sealed = await seal(this.room.keys.dataKey, chunk, `${fileId}:${i}`);
        const payload = new Uint8Array(20 + sealed.length);
        payload.set(idBytes);
        new DataView(payload.buffer).setUint32(16, i);
        payload.set(sealed, 20);
        const channel = this.room.overlay.sendFileFrame(to, payload);
        if (!channel) throw new Error('no route');
        if (channel.bufferedAmount > HIGH_WATER) {
          await new Promise((resolve) => {
            const done = () => {
              channel.removeEventListener('bufferedamountlow', done);
              channel.removeEventListener('close', done);
              resolve();
            };
            channel.addEventListener('bufferedamountlow', done);
            channel.addEventListener('close', done);
          });
        }
      }
    }
  }

  onError(from, msg) {
    const dl = this.downloads.get(msg.fileId);
    if (dl && dl.source === from) dl.nextSource();
  }

  peerGone(id) {
    for (const dl of this.downloads.values()) if (dl.source === id) dl.nextSource();
  }

  totalBytes() {
    let n = 0;
    for (const s of this.local.values()) n += s;
    return n;
  }
}
