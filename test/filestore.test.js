'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { FileStore, safeName } = require('../src/main/filestore');

const ROOM = '0123456789abcdef';
const id = () => crypto.randomBytes(16).toString('hex');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-fs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new FileStore(dir);
}

test('chunked write, hash check, read back, list, remove', async (t) => {
  const store = tmpStore(t);
  const data = crypto.randomBytes(300000);
  const fileId = id();
  const token = await store.begin(ROOM, fileId);
  for (let off = 0; off < data.length; off += 65536) await store.write(token, off, new Uint8Array(data.subarray(off, off + 65536)));
  const res = await store.finish(token, sha(data));
  assert.equal(res.size, data.length);
  assert.equal(res.sha256, sha(data));
  const part = await store.read(ROOM, fileId, 1000, 5000);
  assert.deepEqual(Buffer.from(part), data.subarray(1000, 6000));
  assert.deepEqual(await store.list(ROOM), [{ fileId, size: data.length }]);
  assert.equal(await store.size(ROOM, fileId), data.length);
  await store.remove(ROOM, fileId);
  assert.equal(await store.size(ROOM, fileId), null);
});

test('hash mismatch rejects and leaves nothing behind', async (t) => {
  const store = tmpStore(t);
  const fileId = id();
  const token = await store.begin(ROOM, fileId);
  await store.write(token, 0, new Uint8Array([1, 2, 3]));
  await assert.rejects(store.finish(token, sha(Buffer.from([9]))), /hash mismatch/);
  assert.deepEqual(await store.list(ROOM), []);
});

test('import copies and hashes a file from disk', async (t) => {
  const store = tmpStore(t);
  const src = path.join(os.tmpdir(), `voice-src-${process.pid}`);
  const data = crypto.randomBytes(1234567);
  fs.writeFileSync(src, data);
  t.after(() => fs.rmSync(src, { force: true }));
  const fileId = id();
  const res = await store.importPath(ROOM, fileId, src);
  assert.equal(res.sha256, sha(data));
  assert.equal(res.size, data.length);
});

test('ids are validated (no path traversal)', async (t) => {
  const store = tmpStore(t);
  assert.throws(() => store.path('../../etc', id()));
  assert.throws(() => store.path(ROOM, '../passwd'));
  await assert.rejects(store.begin(ROOM, 'x'.repeat(32)));
  assert.equal(safeName('../../evil.sh'), 'evil.sh');
  assert.equal(safeName('a<b>:c?.txt'), 'a_b__c_.txt');
  assert.equal(safeName(''), 'file');
});
