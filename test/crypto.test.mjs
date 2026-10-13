import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/renderer/js/crypto.js';

test('invite codes round-trip and reject junk', () => {
  const { secret, code } = c.createInvite();
  assert.match(code, /^voice:[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(c.parseInvite(code), secret);
  assert.deepEqual(c.parseInvite(code.slice(6)), secret, 'prefix optional');
  assert.deepEqual(c.parseInvite(`voice://join/${code.slice(6)}`), secret, 'link form');
  assert.deepEqual(c.parseInvite(`  ${code}\n`), secret, 'whitespace tolerated');
  assert.throws(() => c.parseInvite('voice:short'));
  assert.throws(() => c.parseInvite(''));
});

test('room keys are deterministic per secret and differ between rooms', async () => {
  const a = c.createInvite().secret;
  const b = c.createInvite().secret;
  const ka1 = await c.deriveRoomKeys(a);
  const ka2 = await c.deriveRoomKeys(a);
  const kb = await c.deriveRoomKeys(b);
  assert.equal(ka1.roomId, ka2.roomId);
  assert.equal(ka1.topic, ka2.topic);
  assert.match(ka1.roomId, /^[0-9a-f]{16}$/);
  assert.match(ka1.topic, /^[0-9a-f]{64}$/);
  assert.notEqual(ka1.topic, kb.topic);
  // Cross-member compatibility: what A seals, A' (same secret) opens.
  const sealed = await c.sealJson(ka1.sigKey, { hello: 1 });
  assert.deepEqual(await c.openJson(ka2.sigKey, sealed), { hello: 1 });
  // Another room cannot read it.
  await assert.rejects(c.openJson(kb.sigKey, sealed));
});

test('AES-GCM detects tampering and checks AAD', async () => {
  const { dataKey } = await c.deriveRoomKeys(c.createInvite().secret);
  const sealed = await c.seal(dataKey, 'secret text', 'from-a');
  assert.equal(new TextDecoder().decode(await c.open(dataKey, sealed, 'from-a')), 'secret text');
  await assert.rejects(c.open(dataKey, sealed, 'from-b'), 'wrong AAD');
  const tampered = sealed.slice();
  tampered[20] ^= 1;
  await assert.rejects(c.open(dataKey, tampered, 'from-a'), 'flipped bit');
});

test('identities sign and verify; signatures bind content', async () => {
  const rec = await c.generateIdentity();
  const me = await c.loadIdentity(rec);
  assert.equal(me.id, await c.peerIdFromPub(rec.pub));
  assert.match(me.id, /^[0-9a-f]{16}$/);
  const msg = { text: 'hi', ts: 1, nested: { b: 2, a: 1 } };
  const sig = await c.signObject(me, msg);
  assert.ok(await c.verifyObject(rec.pub, { nested: { a: 1, b: 2 }, ts: 1, text: 'hi' }, sig), 'key order irrelevant');
  assert.equal(await c.verifyObject(rec.pub, { ...msg, text: 'hj' }, sig), false);
  const other = await c.generateIdentity();
  assert.equal(await c.verifyObject(other.pub, msg, sig), false);
  assert.equal(await c.verifyObject('garbage', msg, sig), false);
});

test('canonical JSON is stable and omits undefined', () => {
  assert.equal(c.canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
});
