'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { SignalingServer } = require('../src/server/signaling');

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i !== -1) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  return {
    ws,
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    next: (type) => {
      const i = queue.findIndex((m) => m.type === type);
      if (i !== -1) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 2000);
      });
    },
    closed: () => new Promise((r) => ws.once('close', (code) => r(code))),
  };
}

async function join(port, name, extra = {}) {
  const c = client(port);
  await c.open();
  c.send({ type: 'hello', name, userId: `${name}-id`, ...extra });
  return c;
}

test('peers discover each other and relay signals', async (t) => {
  const server = new SignalingServer({ port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  t.after(() => server.stop());

  const alice = await join(port, 'Alice');
  const aWelcome = await alice.next('welcome');
  assert.equal(aWelcome.peers.length, 0);
  assert.ok(aWelcome.channels.some((c) => c.type === 'voice'));

  const bob = await join(port, 'Bob');
  const bWelcome = await bob.next('welcome');
  assert.deepEqual(bWelcome.peers.map((p) => p.name), ['Alice']);
  const joined = await alice.next('peer-joined');
  assert.equal(joined.peer.name, 'Bob');

  // Signal relay with sender id filled in by the server.
  bob.send({ type: 'signal', to: aWelcome.id, data: { description: { type: 'offer', sdp: 'x' } } });
  const sig = await alice.next('signal');
  assert.equal(sig.from, bWelcome.id);
  assert.equal(sig.data.description.sdp, 'x');

  // Presence
  bob.send({ type: 'state', voice: 'lounge', muted: true });
  const st = await alice.next('peer-state');
  assert.equal(st.peer.voice, 'lounge');
  assert.equal(st.peer.muted, true);

  // Unknown voice channels are rejected.
  bob.send({ type: 'state', voice: 'does-not-exist' });
  const st2 = await alice.next('peer-state');
  assert.equal(st2.peer.voice, 'lounge');

  bob.ws.close();
  const left = await alice.next('peer-left');
  assert.equal(left.id, bWelcome.id);
  alice.ws.close();
});

test('channel create/delete is broadcast; last text channel is protected', async (t) => {
  const server = new SignalingServer({ port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  t.after(() => server.stop());
  const a = await join(port, 'A');
  await a.next('welcome');

  a.send({ type: 'channel-create', name: 'Raid Night', channelType: 'voice' });
  let ch = await a.next('channels');
  const created = ch.channels.find((c) => c.name === 'Raid Night');
  assert.equal(created.type, 'voice');
  assert.equal(created.id, 'raid-night');

  a.send({ type: 'channel-create', name: 'Raid Night', channelType: 'voice' });
  ch = await a.next('channels');
  assert.ok(ch.channels.some((c) => c.id === 'raid-night-2'), 'ids stay unique');

  for (const c of ch.channels.filter((c) => c.type === 'text')) {
    a.send({ type: 'channel-delete', id: c.id });
  }
  ch = await a.next('channels');
  // The first delete succeeds; deleting the last text channel is refused.
  assert.equal(ch.channels.filter((c) => c.type === 'text').length, 1);
  a.ws.close();
});

test('password is enforced', async (t) => {
  const server = new SignalingServer({ port: 0, host: '127.0.0.1', password: 'hunter2' });
  const { port } = await server.start();
  t.after(() => server.stop());

  const bad = await join(port, 'Mallory', { password: 'nope' });
  const err = await bad.next('error');
  assert.equal(err.code, 'bad-password');
  assert.equal(await bad.closed(), 4001);

  const good = await join(port, 'Alice', { password: 'hunter2' });
  await good.next('welcome');
  good.ws.close();
});

test('same user reconnecting replaces the old session', async (t) => {
  const server = new SignalingServer({ port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  t.after(() => server.stop());
  const first = await join(port, 'Alice');
  await first.next('welcome');
  const closed = first.closed();
  const second = await join(port, 'Alice');
  const welcome = await second.next('welcome');
  assert.equal(welcome.peers.length, 0);
  assert.equal(await closed, 4003);
  second.ws.close();
});
