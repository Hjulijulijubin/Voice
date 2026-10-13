/**
 * Latency-based routing for the peer mesh (pure logic, no I/O).
 *
 * Every peer measures the round-trip time to each directly connected peer
 * and floods a small "node state" (link-state advertisement) through the
 * mesh. From that graph every peer computes the fastest path to every other
 * peer (Dijkstra on one-way latency). If going through one or more other
 * peers is clearly faster than the direct connection — or if no direct
 * connection is possible at all (strict NATs) — traffic is relayed.
 */

/** Cost added for every intermediate peer (receive → forward). */
export const HOP_PENALTY_MS = 2;

export class LinkState {
  constructor(selfId) {
    this.selfId = selfId;
    /** @type {Map<string, {id:string, t0:number, seq:number, links:Record<string, number>, relay:boolean, seenAt:number, info:object}>} */
    this.nodes = new Map();
  }

  /**
   * Apply a node state. Returns true if it was newer than what we had
   * (and therefore must be flooded on).
   */
  apply(state, now = Date.now()) {
    if (!state || typeof state.id !== 'string' || typeof state.seq !== 'number' || typeof state.t0 !== 'number') return false;
    const cur = this.nodes.get(state.id);
    if (cur && (state.t0 < cur.t0 || (state.t0 === cur.t0 && state.seq <= cur.seq))) {
      if (state.t0 === cur.t0 && state.seq === cur.seq) cur.seenAt = now;
      return false;
    }
    const links = {};
    if (state.links && typeof state.links === 'object') {
      for (const [k, v] of Object.entries(state.links)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) links[k] = Math.min(v, 5000);
      }
    }
    this.nodes.set(state.id, { id: state.id, t0: state.t0, seq: state.seq, links, relay: state.relay !== false, seenAt: now, info: state.info || {} });
    return true;
  }

  remove(id) {
    return this.nodes.delete(id);
  }

  /** Drop nodes we haven't heard from in `maxAgeMs`. Returns removed ids. */
  expire(now, maxAgeMs) {
    const removed = [];
    for (const [id, n] of this.nodes) {
      if (id !== this.selfId && now - n.seenAt > maxAgeMs) {
        this.nodes.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  /** One-way latency estimate between two directly linked peers, or null. */
  weight(a, b) {
    const ra = this.nodes.get(a)?.links[b];
    const rb = this.nodes.get(b)?.links[a];
    if (ra === undefined && rb === undefined) return null;
    const rtt = ra !== undefined && rb !== undefined ? (ra + rb) / 2 : (ra ?? rb);
    return rtt / 2;
  }

  /**
   * Shortest paths from `source`. Returns Map(dest → {cost, path}) where
   * `path` lists the hops after the source, ending with dest.
   */
  paths(source = this.selfId) {
    const ids = new Set(this.nodes.keys());
    ids.add(source);
    const dist = new Map([[source, 0]]);
    const prev = new Map();
    const done = new Set();
    while (true) {
      let u = null;
      let best = Infinity;
      for (const [id, d] of dist) {
        if (!done.has(id) && d < best) {
          best = d;
          u = id;
        }
      }
      if (u === null) break;
      done.add(u);
      // Only the source and relay-willing peers may forward traffic.
      if (u !== source && this.nodes.get(u)?.relay === false) continue;
      const neighbours = new Set([...Object.keys(this.nodes.get(u)?.links || {})]);
      for (const [id, n] of this.nodes) if (n.links[u] !== undefined) neighbours.add(id);
      for (const v of neighbours) {
        if (done.has(v) || !ids.has(v)) continue;
        const w = this.weight(u, v);
        if (w === null) continue;
        const cost = best + w + (u === source ? 0 : HOP_PENALTY_MS);
        if (cost < (dist.get(v) ?? Infinity)) {
          dist.set(v, cost);
          prev.set(v, u);
        }
      }
    }
    const out = new Map();
    for (const [dest, cost] of dist) {
      if (dest === source) continue;
      const path = [dest];
      let p = prev.get(dest);
      while (p && p !== source) {
        path.unshift(p);
        p = prev.get(p);
      }
      out.set(dest, { cost, path });
    }
    return out;
  }
}

/**
 * Decide how audio should reach one listener, with hysteresis so routes don't
 * flap on small RTT changes.
 *
 * @param {'direct'|'relay'|'none'} current
 * @param {number|null} directCost  one-way ms over the direct connection (null = no direct link)
 * @param {{cost:number, path:string[]}|null} best  best path (may itself be direct: path.length === 1)
 * @param {{switchMarginMs?:number, switchRatio?:number, returnMarginMs?:number, relayPenaltyMs?:number}} [opts]
 */
export function selectRoute(current, directCost, best, opts = {}) {
  const { switchMarginMs = 10, switchRatio = 0.15, returnMarginMs = 3, relayPenaltyMs = 0 } = opts;
  const relay = best && best.path.length > 1 ? { path: best.path, cost: best.cost + relayPenaltyMs } : null;
  if (directCost === null || directCost === undefined) return relay ? { mode: 'relay', ...relay } : { mode: 'none' };
  if (!relay) return { mode: 'direct', cost: directCost };
  if (current === 'relay') {
    // Go back to direct as soon as it is about as good.
    return directCost <= relay.cost + returnMarginMs ? { mode: 'direct', cost: directCost } : { mode: 'relay', ...relay };
  }
  const gain = directCost - relay.cost;
  return gain > Math.max(switchMarginMs, directCost * switchRatio) ? { mode: 'relay', ...relay } : { mode: 'direct', cost: directCost };
}
