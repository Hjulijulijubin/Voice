import { Emitter, uid } from './util.js';
import { store } from './store.js';

const CHUNK = 64 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
const STALL_TIMEOUT = 15000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Peer-to-peer file sharing over the "file" data channel.
 *
 * Sharing a file posts a small chat message with the file's metadata.
 * Anyone who wants the file requests it from the uploader, or from any other
 * peer that already downloaded it (every downloader becomes a seeder).
 *
 * Binary frame: [u8 idLength][fileId utf8][payload bytes]
 */
export class FileManager extends Emitter {
  constructor(mesh) {
    super();
    this.mesh = mesh;
    /** fileId -> Blob we can serve */
    this.local = new Map();
    /** fileId -> Set(peerId) peers that announced they have it */
    this.holders = new Map();
    /** fileId -> active download */
    this.downloads = new Map();
    /** fileId -> object URL */
    this.urls = new Map();
    this.uploads = 0;

    mesh.on('file-data', (peer, data) => this._onChunk(peer, data));
  }

  /** Register a local file and return the metadata to put in a chat message. */
  async share(file) {
    const meta = { id: uid(), name: file.name || 'file', size: file.size, type: file.type || 'application/octet-stream' };
    this.local.set(meta.id, file);
    // Keep a copy so we can keep seeding after a restart.
    store.putFile(meta.id, file, meta).catch(() => {});
    return meta;
  }

  async getLocal(fileId) {
    if (this.local.has(fileId)) return this.local.get(fileId);
    const blob = await store.getFile(fileId).catch(() => null);
    if (blob) this.local.set(fileId, blob);
    return blob;
  }

  async urlFor(fileId) {
    if (this.urls.has(fileId)) return this.urls.get(fileId);
    const blob = await this.getLocal(fileId);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(fileId, url);
    return url;
  }

  isDownloading(fileId) {
    return this.downloads.has(fileId);
  }

  /** Handle control messages arriving on the chat channel. */
  async onControl(peer, msg) {
    switch (msg.t) {
      case 'file-req': {
        const blob = await this.getLocal(msg.fileId);
        if (!blob) {
          peer.sendJson({ t: 'file-err', fileId: msg.fileId, reason: 'not-found' });
          return;
        }
        peer.sendJson({ t: 'file-ok', fileId: msg.fileId, size: blob.size });
        this._upload(peer, msg.fileId, blob).catch((err) => {
          console.warn('upload failed', err);
          peer.sendJson({ t: 'file-err', fileId: msg.fileId, reason: 'aborted' });
        });
        break;
      }
      case 'file-err': {
        const dl = this.downloads.get(msg.fileId);
        if (dl && dl.peerId === peer.id) dl.next(new Error(msg.reason));
        break;
      }
      case 'file-ok': {
        const dl = this.downloads.get(msg.fileId);
        if (dl && dl.peerId === peer.id) dl.touch();
        break;
      }
      case 'file-have': {
        if (!this.holders.has(msg.fileId)) this.holders.set(msg.fileId, new Set());
        this.holders.get(msg.fileId).add(peer.id);
        break;
      }
      default:
        break;
    }
  }

  async _upload(peer, fileId, blob) {
    const ch = peer.file;
    const idBytes = encoder.encode(fileId);
    this.uploads++;
    this.emit('uploads', this.uploads);
    try {
      for (let offset = 0; offset < blob.size; offset += CHUNK) {
        if (ch.readyState !== 'open') throw new Error('channel closed');
        if (ch.bufferedAmount > HIGH_WATER) {
          await new Promise((resolve, reject) => {
            const onLow = () => {
              ch.removeEventListener('bufferedamountlow', onLow);
              ch.removeEventListener('close', onClose);
              resolve();
            };
            const onClose = () => {
              ch.removeEventListener('bufferedamountlow', onLow);
              reject(new Error('channel closed'));
            };
            ch.addEventListener('bufferedamountlow', onLow);
            ch.addEventListener('close', onClose);
          });
        }
        const payload = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
        const frame = new Uint8Array(1 + idBytes.length + payload.length);
        frame[0] = idBytes.length;
        frame.set(idBytes, 1);
        frame.set(payload, 1 + idBytes.length);
        ch.send(frame);
      }
    } finally {
      this.uploads--;
      this.emit('uploads', this.uploads);
    }
  }

  _onChunk(peer, data) {
    if (!(data instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(data);
    const idLen = bytes[0];
    const fileId = decoder.decode(bytes.subarray(1, 1 + idLen));
    const dl = this.downloads.get(fileId);
    if (!dl || dl.peerId !== peer.id) return;
    const payload = bytes.subarray(1 + idLen);
    dl.chunks.push(payload);
    dl.received += payload.length;
    dl.touch();
    this.emit('progress', fileId, dl.received / dl.meta.size);
    if (dl.received >= dl.meta.size) dl.finish();
  }

  /**
   * Download a file from whoever has it. Resolves with a Blob.
   * @param {{id,name,size,type}} meta
   * @param {string} ownerUserId
   */
  download(meta, ownerUserId) {
    if (this.local.has(meta.id)) return Promise.resolve(this.local.get(meta.id));
    if (this.downloads.has(meta.id)) return this.downloads.get(meta.id).promise;

    const candidates = () => {
      const open = this.mesh.openPeers();
      const owner = open.filter((p) => p.info.userId === ownerUserId);
      const holders = open.filter((p) => this.holders.get(meta.id)?.has(p.id));
      return [...new Set([...owner, ...holders, ...open])];
    };

    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const tried = new Set();
    const dl = {
      meta,
      promise,
      chunks: [],
      received: 0,
      peerId: null,
      timer: null,
      touch: () => {
        clearTimeout(dl.timer);
        dl.timer = setTimeout(() => dl.next(new Error('stalled')), STALL_TIMEOUT);
      },
      next: () => {
        clearTimeout(dl.timer);
        const peer = candidates().find((p) => !tried.has(p.id));
        if (!peer) {
          this.downloads.delete(meta.id);
          this.emit('progress', meta.id, null);
          rejectFn(new Error('Nobody online has this file right now'));
          return;
        }
        tried.add(peer.id);
        dl.peerId = peer.id;
        dl.chunks = [];
        dl.received = 0;
        dl.touch();
        peer.sendJson({ t: 'file-req', fileId: meta.id });
      },
      finish: async () => {
        clearTimeout(dl.timer);
        this.downloads.delete(meta.id);
        const blob = new Blob(dl.chunks, { type: meta.type });
        this.local.set(meta.id, blob);
        store.putFile(meta.id, blob, meta).catch(() => {});
        this.mesh.broadcast({ t: 'file-have', fileId: meta.id });
        this.emit('progress', meta.id, 1);
        resolveFn(blob);
      },
    };
    this.downloads.set(meta.id, dl);
    if (meta.size === 0) {
      dl.finish();
    } else {
      dl.next();
    }
    return promise;
  }

  /** Forget a peer that left: re-route its downloads to someone else. */
  peerGone(peerId) {
    for (const set of this.holders.values()) set.delete(peerId);
    for (const dl of this.downloads.values()) if (dl.peerId === peerId) dl.next(new Error('peer left'));
  }
}
