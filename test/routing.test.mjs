import test from 'node:test';
import assert from 'node:assert/strict';
import { LinkState, selectRoute, HOP_PENALTY_MS } from '../src/renderer/js/routing.js';

function ls(self, edges, relayOff = []) {
  const s = new LinkState(self);
  const nodes = new Map();
  for (const [a, b, rtt] of edges) {
    if (!nodes.has(a)) nodes.set(a, {});
    if (!nodes.has(b)) nodes.set(b, {});
    nodes.get(a)[b] = rtt;
    nodes.get(b)[a] = rtt;
  }
  for (const [id, links] of nodes) s.apply({ id, t0: 1, seq: 1, links, relay: !relayOff.includes(id) });
  return s;
}

test('direct path when it is fastest', () => {
  const s = ls('A', [['A', 'B', 20], ['B', 'C', 20], ['A', 'C', 30]]);
  const p = s.paths().get('C');
  assert.deepEqual(p.path, ['C']);
  assert.equal(p.cost, 15);
});

test('relays through a peer when the direct link is slow', () => {
  // A–C direct 200 ms RTT (100 one-way); A–B–C 20+30 ms RTT (25 one-way + hop)
  const s = ls('A', [['A', 'B', 20], ['B', 'C', 30], ['A', 'C', 200]]);
  const p = s.paths().get('C');
  assert.deepEqual(p.path, ['B', 'C']);
  assert.equal(p.cost, 10 + 15 + HOP_PENALTY_MS);
});

test('reaches peers without any direct link (strict NAT)', () => {
  const s = ls('A', [['A', 'B', 40], ['B', 'C', 40]]);
  assert.deepEqual(s.paths().get('C').path, ['B', 'C']);
});

test('multi-hop paths', () => {
  const s = ls('A', [['A', 'B', 10], ['B', 'C', 10], ['C', 'D', 10], ['A', 'D', 300]]);
  assert.deepEqual(s.paths().get('D').path, ['B', 'C', 'D']);
});

test('peers that disallow relaying are never used as hops', () => {
  const s = ls('A', [['A', 'B', 10], ['B', 'C', 10], ['A', 'C', 300]], ['B']);
  assert.deepEqual(s.paths().get('C').path, ['C']);
  const s2 = ls('A', [['A', 'B', 10], ['B', 'C', 10]], ['B']);
  assert.equal(s2.paths().get('C'), undefined, 'unreachable');
  assert.deepEqual(s2.paths().get('B').path, ['B'], 'but B itself is reachable');
});

test('asymmetric reports are averaged; one-sided reports still count', () => {
  const s = new LinkState('A');
  s.apply({ id: 'A', t0: 1, seq: 1, links: { B: 40 } });
  s.apply({ id: 'B', t0: 1, seq: 1, links: { A: 20 } });
  assert.equal(s.weight('A', 'B'), 15);
  s.apply({ id: 'C', t0: 1, seq: 1, links: { B: 10 } });
  assert.equal(s.weight('B', 'C'), 5);
});

test('state versioning: old states ignored, new sessions win, expiry', () => {
  const s = new LinkState('A');
  assert.ok(s.apply({ id: 'B', t0: 5, seq: 2, links: {} }, 0));
  assert.equal(s.apply({ id: 'B', t0: 5, seq: 1, links: {} }, 0), false);
  assert.equal(s.apply({ id: 'B', t0: 4, seq: 99, links: {} }, 0), false);
  assert.ok(s.apply({ id: 'B', t0: 6, seq: 0, links: {} }, 0), 'restart');
  assert.equal(s.apply({ id: 'B', seq: 1 }), false, 'malformed');
  assert.deepEqual(s.expire(10000, 5000), ['B']);
});

test('route hysteresis', () => {
  const relay = { cost: 40, path: ['B', 'C'] };
  // Gain 5 ms: not worth switching.
  assert.equal(selectRoute('direct', 45, relay).mode, 'direct');
  // Gain 60 ms: switch.
  assert.equal(selectRoute('direct', 100, relay).mode, 'relay');
  // Once relayed, stay until direct is within 3 ms.
  assert.equal(selectRoute('relay', 50, relay).mode, 'relay');
  assert.equal(selectRoute('relay', 42, relay).mode, 'direct');
  // No direct link at all.
  assert.deepEqual(selectRoute('none', null, relay).path, ['B', 'C']);
  assert.equal(selectRoute('none', null, null).mode, 'none');
  // Best path is the direct one.
  assert.equal(selectRoute('direct', 20, { cost: 20, path: ['C'] }).mode, 'direct');
  // Relay penalty (custom pipeline) is respected.
  assert.equal(selectRoute('direct', 60, relay, { relayPenaltyMs: 15 }).mode, 'direct');
});
