'use strict';

/**
 * On-disk storage for shared files.
 *
 * Every member keeps their own copy of a room's files in
 *   <userData>/rooms/<roomId>/files/<fileId>
 * Files are streamed to/from disk chunk by chunk, so even multi-GB files never
 * sit in memory. A SHA-256 is computed while writing and checked against the
 * hash the uploader signed.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const ROOM_RE = /^[0-9a-f]{16}$/;
const FILE_RE = /^[0-9a-f]{32}$/;

class FileStore {
  constructor(baseDir) {
    this.base = baseDir;
    /** token -> {fh, hash, next, tmp, final} */
    this.writes = new Map();
    this._seq = 0;
  }

  _dir(room) {
    if (!ROOM_RE.test(room)) throw new Error('bad room id');
    return path.join(this.base, room, 'files');
  }

  path(room, fileId) {
    if (!FILE_RE.test(fileId)) throw new Error('bad file id');
    return path.join(this._dir(room), fileId);
  }

  async begin(room, fileId) {
    const final = this.path(room, fileId);
    await fsp.mkdir(path.dirname(final), { recursive: true });
    const tmp = `${final}.part`;
    const fh = await fsp.open(tmp, 'w');
    const token = ++this._seq;
    this.writes.set(token, { fh, hash: crypto.createHash('sha256'), next: 0, sequential: true, tmp, final });
    return token;
  }

  async write(token, offset, data) {
    const w = this.writes.get(token);
    if (!w) throw new Error('no such write');
    const buf = Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
    await w.fh.write(buf, 0, buf.length, offset);
    if (offset === w.next) {
      w.hash.update(buf);
      w.next += buf.length;
    } else {
      w.sequential = false;
    }
  }

  /** Finish a write; resolves with {sha256, size}. Rejects (and deletes) on hash mismatch. */
  async finish(token, expectedSha) {
    const w = this.writes.get(token);
    if (!w) throw new Error('no such write');
    this.writes.delete(token);
    await w.fh.close();
    const sha256 = w.sequential ? w.hash.digest('hex') : await this._hashFile(w.tmp);
    if (expectedSha && sha256 !== expectedSha) {
      await fsp.rm(w.tmp, { force: true });
      throw new Error('file corrupted in transfer (hash mismatch)');
    }
    await fsp.rename(w.tmp, w.final);
    const { size } = await fsp.stat(w.final);
    return { sha256, size };
  }

  async abort(token) {
    const w = this.writes.get(token);
    if (!w) return;
    this.writes.delete(token);
    await w.fh.close().catch(() => {});
    await fsp.rm(w.tmp, { force: true });
  }

  /** Copy a file from the user's disk into the store (no renderer round trip). */
  async importPath(room, fileId, src) {
    const final = this.path(room, fileId);
    await fsp.mkdir(path.dirname(final), { recursive: true });
    const hash = crypto.createHash('sha256');
    const tmp = `${final}.part`;
    await pipeline(
      fs.createReadStream(src),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk);
          yield chunk;
        }
      },
      fs.createWriteStream(tmp),
    );
    await fsp.rename(tmp, final);
    const { size } = await fsp.stat(final);
    return { sha256: hash.digest('hex'), size };
  }

  async _hashFile(p) {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(p), hash);
    return hash.digest('hex');
  }

  async read(room, fileId, offset, length) {
    const fh = await fsp.open(this.path(room, fileId), 'r');
    try {
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async size(room, fileId) {
    try {
      return (await fsp.stat(this.path(room, fileId))).size;
    } catch {
      return null;
    }
  }

  async remove(room, fileId) {
    await fsp.rm(this.path(room, fileId), { force: true });
  }

  async list(room) {
    const dir = this._dir(room);
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!FILE_RE.test(name)) {
        // Leftover partial download from a crash.
        if (name.endsWith('.part') && !this._isWriting(path.join(dir, name))) await fsp.rm(path.join(dir, name), { force: true });
        continue;
      }
      const { size } = await fsp.stat(path.join(dir, name));
      out.push({ fileId: name, size });
    }
    return out;
  }

  _isWriting(tmp) {
    for (const w of this.writes.values()) if (w.tmp === tmp) return true;
    return false;
  }

  async removeRoom(room) {
    if (!ROOM_RE.test(room)) return;
    await fsp.rm(path.join(this.base, room), { recursive: true, force: true });
  }
}

/** Make a user-supplied file name safe for the local file system. */
function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return base.slice(0, 200) || 'file';
}

module.exports = { FileStore, safeName };
