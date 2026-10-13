/**
 * Local persistence (IndexedDB): chat history and shared files.
 *
 * There is no central database. Every client keeps its own copy of the
 * history and peers exchange what the other one is missing when they connect.
 */

const DB_NAME = 'voice';
const DB_VERSION = 1;
/** Files up to this size are kept on disk so they survive a restart. */
export const PERSIST_FILE_LIMIT = 200 * 1024 * 1024;

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const messages = db.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('by_channel', ['server', 'channel', 'ts']);
        messages.createIndex('by_server', ['server', 'ts']);
        db.createObjectStore('files', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await open();
  const t = db.transaction(storeName, mode);
  const result = await fn(t.objectStore(storeName));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return result;
}

export const store = {
  /** Save a message; returns true if it was new. */
  async addMessage(server, msg) {
    return tx('messages', 'readwrite', async (s) => {
      const existing = await promisify(s.get(msg.id));
      if (existing) return false;
      s.put({ ...msg, server });
      return true;
    });
  },

  async getMessages(server, channel, limit = 200) {
    return tx('messages', 'readonly', async (s) => {
      const range = IDBKeyRange.bound([server, channel, -Infinity], [server, channel, Infinity]);
      const out = [];
      await new Promise((resolve, reject) => {
        const req = s.index('by_channel').openCursor(range, 'prev');
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || out.length >= limit) return resolve();
          out.push(cursor.value);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
      return out.reverse();
    });
  },

  /** Messages of a server newer than `since` (used for history sync). */
  async getMessagesSince(server, since, limit = 1000) {
    return tx('messages', 'readonly', async (s) => {
      const range = IDBKeyRange.bound([server, since], [server, Infinity], true, false);
      return promisify(s.index('by_server').getAll(range, limit));
    });
  },

  async latestTimestamp(server) {
    return tx('messages', 'readonly', async (s) => {
      const range = IDBKeyRange.bound([server, -Infinity], [server, Infinity]);
      return new Promise((resolve, reject) => {
        const req = s.index('by_server').openCursor(range, 'prev');
        req.onsuccess = () => resolve(req.result ? req.result.value.ts : 0);
        req.onerror = () => reject(req.error);
      });
    });
  },

  async putFile(id, blob, meta) {
    if (blob.size > PERSIST_FILE_LIMIT) return false;
    await tx('files', 'readwrite', (s) => s.put({ id, blob, meta, savedAt: Date.now() }));
    return true;
  },

  async getFile(id) {
    const rec = await tx('files', 'readonly', (s) => promisify(s.get(id)));
    return rec ? rec.blob : null;
  },
};
