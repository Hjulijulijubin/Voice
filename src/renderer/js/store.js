/**
 * Local persistence (IndexedDB). Nothing is stored anywhere else: every
 * member keeps their own copy and peers fill each other's gaps.
 *
 * Stores:
 *   rooms     joined rooms (secret, per-room identity)
 *   messages  chat messages + room-state ops (channel "__room")
 *   summary   per-day {count, xor-hash} of message ids → cheap sync diffing
 *   holders   who has which file (last-writer-wins records)
 */

const DB_NAME = 'voice-p2p';
const DB_VERSION = 1;
const DAY = 86400000;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('rooms', { keyPath: 'roomId' });
        const m = db.createObjectStore('messages', { keyPath: 'id' });
        m.createIndex('by_channel', ['room', 'channel', 'ts']);
        m.createIndex('by_day', ['room', 'day']);
        m.createIndex('by_room', 'room');
        const s = db.createObjectStore('summary', { keyPath: ['room', 'day'] });
        s.createIndex('by_room', 'room');
        const h = db.createObjectStore('holders', { keyPath: ['room', 'fileId', 'peer'] });
        h.createIndex('by_room', 'room');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const p = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function run(stores, mode, fn) {
  const db = await openDb();
  const t = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  const result = await fn(t);
  await done;
  return result;
}

/** 32-bit FNV-1a, used for order-independent per-day hashes. */
export function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const dayOf = (ts) => Math.floor(ts / DAY);

export const store = {
  // ---------------------------------------------------------------- rooms
  listRooms: () => run('rooms', 'readonly', (t) => p(t.objectStore('rooms').getAll())),
  putRoom: (room) => run('rooms', 'readwrite', (t) => p(t.objectStore('rooms').put(room))),

  async deleteRoom(roomId) {
    await run(['rooms', 'messages', 'summary', 'holders'], 'readwrite', async (t) => {
      t.objectStore('rooms').delete(roomId);
      for (const name of ['messages', 'summary', 'holders']) {
        const keys = await p(t.objectStore(name).index('by_room').getAllKeys(roomId));
        for (const k of keys) t.objectStore(name).delete(k);
      }
    });
  },

  // ------------------------------------------------------------- messages
  /** Insert many messages in one transaction; resolves with the new ones. */
  async addMessages(room, msgs) {
    if (!msgs.length) return [];
    return run(['messages', 'summary'], 'readwrite', async (t) => {
      const ms = t.objectStore('messages');
      const ss = t.objectStore('summary');
      const fresh = [];
      const exists = await Promise.all(msgs.map((m) => p(ms.getKey(m.id))));
      const days = new Map();
      msgs.forEach((m, i) => {
        if (exists[i] !== undefined || fresh.some((f) => f.id === m.id)) return;
        const day = dayOf(m.ts);
        ms.put({ ...m, room, day });
        fresh.push(m);
        const d = days.get(day) || { n: 0, h: 0 };
        d.n++;
        d.h ^= fnv(m.id);
        days.set(day, d);
      });
      for (const [day, d] of days) {
        const cur = (await p(ss.get([room, day]))) || { room, day, n: 0, h: 0 };
        ss.put({ room, day, n: cur.n + d.n, h: (cur.h ^ d.h) >>> 0 });
      }
      return fresh;
    });
  },

  async getMessages(room, channel, limit = 150) {
    return run('messages', 'readonly', async (t) => {
      const range = IDBKeyRange.bound([room, channel, -Infinity], [room, channel, Infinity]);
      const out = [];
      await new Promise((resolve, reject) => {
        const req = t.objectStore('messages').index('by_channel').openCursor(range, 'prev');
        req.onsuccess = () => {
          const c = req.result;
          if (!c || out.length >= limit) return resolve();
          out.push(c.value);
          c.continue();
        };
        req.onerror = () => reject(req.error);
      });
      return out.reverse();
    });
  },

  getDay: (room, day) => run('messages', 'readonly', (t) => p(t.objectStore('messages').index('by_day').getAll([room, day]))),

  async summary(room) {
    const rows = await run('summary', 'readonly', (t) => p(t.objectStore('summary').index('by_room').getAll(room)));
    return Object.fromEntries(rows.map((r) => [r.day, [r.n, r.h]]));
  },

  // -------------------------------------------------------------- holders
  holders: (room) => run('holders', 'readonly', (t) => p(t.objectStore('holders').index('by_room').getAll(room))),

  /** Last-writer-wins merge; resolves with the records that changed. */
  async mergeHolders(room, recs) {
    if (!recs.length) return [];
    return run('holders', 'readwrite', async (t) => {
      const hs = t.objectStore('holders');
      const changed = [];
      for (const r of recs) {
        const cur = await p(hs.get([room, r.fileId, r.peer]));
        // Records are only ever written by the holder itself; on a timestamp
        // tie, deletion wins.
        if (cur && (cur.ts > r.ts || (cur.ts === r.ts && (cur.has === r.has || !cur.has)))) continue;
        const rec = { ...r, room };
        hs.put(rec);
        changed.push(rec);
      }
      return changed;
    });
  },
};
