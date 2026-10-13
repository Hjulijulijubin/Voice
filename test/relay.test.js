'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { Relay, matches } = require('../src/server/relay');
const { Rendezvous } = require('../src/main/rendezvous');

test('filter matching', () => {
  const ev = { kind: 20078, created_at: 100, tags: [['t', 'abc']], pubkey: 'p' };
  assert.ok(matches({ kinds: [20078], '#t': ['abc'] }, ev));
  assert.ok(!matches({ kinds: [1] }, ev));
  assert.ok(!matches({ '#t': ['zzz'] }, ev));
  assert.ok(!matches({ since: 101 }, ev));
});

test('relay only accepts ephemeral events', async (t) => {
  const relay = new Relay({ port: 0, host: '127.0.0.1' });
  const { port } = await relay.start();
  t.after(() => relay.stop());
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.once('open', r));
  const reply = new Promise((r) => ws.once('message', (m) => r(JSON.parse(m))));
  ws.send(JSON.stringify(['EVENT', { id: 'x', pubkey: 'p', kind: 1, created_at: 1, content: '', tags: [] }]));
  const [type, id, ok] = await reply;
  assert.equal(type, 'OK');
  assert.equal(id, 'x');
  assert.equal(ok, false);
  ws.close();
});

test('two rendezvous clients meet on a topic through the relay', async (t) => {
  const relay = new Relay({ port: 0, host: '127.0.0.1' });
  const { port } = await relay.start();
  const a = new Rendezvous();
  const b = new Rendezvous();
  t.after(async () => {
    a.stop();
    b.stop();
    await relay.stop();
  });
  const topic = 'a'.repeat(64);
  for (const r of [a, b]) {
    r.configure({ relays: [`ws://127.0.0.1:${port}`], lan: false });
    r.join(topic);
  }
  const ready = () => [a, b].every((r) => r.status().relays.every((x) => x.open));
  for (let i = 0; i < 50 && !ready(); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100)); // subscriptions registered

  const got = new Promise((resolve) => b.on('message', resolve));
  await a.publish(topic, 'ciphertext-blob');
  const msg = await got;
  assert.equal(msg.topic, topic);
  assert.equal(msg.payload, 'ciphertext-blob');

  // Other topics are not delivered; own events are not echoed.
  let echoed = false;
  a.on('message', () => (echoed = true));
  await a.publish('b'.repeat(64), 'nope');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(echoed, false);
});
