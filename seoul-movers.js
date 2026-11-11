// seoul-movers.js — Hongdae's world.movers for flight.js (stream F1, design #5, contract P2-F1): buses and taxis
// crash the quad, people are a SCRAPE + HEADS!. No three.js, no DOM: runs in node (tests/movers.mjs) and in the page.
//
//   lifeMovers(life) -> movers | null      life = seoulLife.build()'s return ({colliders, sim}), or null
//   movers.hit(p:[x,y,z], r, t) -> null | {kind: 'vehicle' | 'pedestrian', id, type, n:[x,y,z], depth, vel:[x,y,z]}
//   movers.fork() -> an independent copy (flight.js binds one per Drone: the live quad, the ghost and the HQ re-sim each
//                    walk their own clock forward, and none of them rewinds the city that is drawn)
//
// t is the drone's tick clock (flight.js: tick / 240 s since reset), the same clock main.js feeds the drawn city
// (takeClock), so what you see is what you hit, and a replay of the input log meets the same bus at the same tick.
// Every answer is a pure function of (t, p, r): nothing here reads the camera, the frame rate or the quality setting.
//
// Sources, in order:
//   1. life.colliders already speaks this contract (its hit() returns `kind` and it has fork()): used as it is.
//   2. else built from life.sim (seoul-life.js LifeSim):
//      vehicles: a private TrafficSim (the drawn one's net and seed) per fork, stepped to floor(t * trafficHz) exactly as
//        LifeSim.advanceTo does, its pose interpolated the same way; a broad phase per traffic step (an AABB per
//        vehicle over the step, padded) keeps the per-tick query to a few boxes. Box = LifeSim.boxesAt's.
//      pedestrians: the crowd's standing and seated agents (club queues, chatting groups, pocha stools, which this crowd
//        never moves) as vertical capsules r PED_R, PED_H tall (seated PED_SIT), captured once; walkers come from
//        life.colliders.people(p, r, t) when seoul-life provides it (same return shape, kind 'pedestrian').
//   No life (or no sim): null, and the level has no movers.

export const PED_R = 0.3, PED_H = 1.75, PED_SIT = 1.3;
const M_STAND = 2, M_SEAT = 3;           // seoul-life.js CrowdSim modes
const CELL = 2;                          // m, pedestrian hash
const VEH_TOP = 3.4;                     // m: above this (+ r) no vehicle can be touched (bus 3.15 m)

// sphere (p, r) vs an oriented box {c, half:[hw, hh, hl], h:[hx, hz]} (z along the heading), as LifeSim.hit
function boxHit(p, r, cx, cy, cz, hw, hh, hl, hx, hz, out) {
  const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
  const lz = dx * hx + dz * hz, lx = dx * hz - dz * hx;
  const qx = Math.max(-hw, Math.min(hw, lx)), qy = Math.max(-hh, Math.min(hh, dy)), qz = Math.max(-hl, Math.min(hl, lz));
  const ex = lx - qx, ey = dy - qy, ez = lz - qz, d2 = ex * ex + ey * ey + ez * ez;
  if (d2 >= r * r) return false;
  let d = Math.sqrt(d2), nlx, nly, nlz;
  if (d > 1e-6) { nlx = ex / d; nly = ey / d; nlz = ez / d; }
  else {   // centre inside the box: out through the nearest face
    const fx = hw - Math.abs(lx), fy = hh - Math.abs(dy), fz = hl - Math.abs(lz);
    nlx = nly = nlz = 0;
    if (fy <= fx && fy <= fz) { nly = dy < 0 ? -1 : 1; d = -fy; } else if (fx <= fz) { nlx = lx < 0 ? -1 : 1; d = -fx; } else { nlz = lz < 0 ? -1 : 1; d = -fz; }
  }
  out.depth = r - d;
  out.n[0] = nlx * hz + nlz * hx; out.n[1] = nly; out.n[2] = -nlx * hx + nlz * hz;
  return true;
}

class Movers {
  constructor(src) {
    this.src = src;                                   // shared, read-only: {TS, net, seed, hz, peds, grid, people, warm?, snaps?}
    this.ts = src.TS ? new src.TS(src.net, { seed: src.seed }) : null;
    this.bn = -1; this.bb = null;                     // broad phase of traffic step bn: Float64Array [x0, x1, z0, z1] per vehicle
    this._o = {}; this._a = {}; this._b = {};
    this._res = { kind: '', id: 0, type: '', n: [0, 0, 0], depth: 0, vel: [0, 0, 0] };
    this._tmp = { n: [0, 0, 0], depth: 0 };
  }
  fork() { return new Movers(this.src); }
  // the traffic at take clock t (LifeSim.advanceTo's arithmetic): returns the interpolation alpha
  // (P5 G1) at take clock + the life's warm start (seoul-life draws and serves its people at t + warm: P4 hit the traffic of
  // 75 s earlier than the one on screen), and seeking through the life sim's snapshots, so a rewind or a retry that opens on
  // a later city costs at most 10 s of traffic, not a re-run from 0
  _advance(t) {
    const ts = this.ts, hz = this.src.hz, S = this.src.snaps;
    t = Math.max(0, t + (this.src.warm ? this.src.warm() : 0));
    const nt = Math.floor(t * hz + 1e-9);
    if (nt < ts.n || (S && nt - ts.n > 1200)) {
      let best = -1; if (S) for (const k of S.keys()) if (k <= nt && k > best && (nt < ts.n || k > ts.n)) best = k;
      if (best >= 0) ts.restore(S.get(best)); else if (nt < ts.n) ts.reset();
    }
    while (ts.n < nt) ts.step();
    let a = ts.n === 0 ? 1 : t * hz - (ts.n - 1);
    return Math.min(1, Math.max(0, a));
  }
  _broad() {
    const ts = this.ts, V = ts.vehicles;
    if (this.bn === ts.n && this.bb) return this.bb;
    const bb = this.bb && this.bb.length === V.length * 4 ? this.bb : new Float64Array(V.length * 4);
    const A = this._a, B = this._b;
    for (let i = 0; i < V.length; i++) {
      const v = V[i];
      if (v.hidden) { bb[i * 4] = Infinity; bb[i * 4 + 1] = -Infinity; continue; }
      ts.pose(v, 0, A); ts.pose(v, 1, B);
      const pad = Math.hypot(v.L, v.W) / 2 + 0.75;    // half diagonal + slack for the curve / junction ease between the two
      bb[i * 4] = Math.min(A.x, B.x) - pad; bb[i * 4 + 1] = Math.max(A.x, B.x) + pad;
      bb[i * 4 + 2] = Math.min(A.z, B.z) - pad; bb[i * 4 + 3] = Math.max(A.z, B.z) + pad;
    }
    this.bn = ts.n; this.bb = bb;
    return bb;
  }
  hit(p, r, t) {
    let best = null;
    const res = this._res, tmp = this._tmp;
    // vehicles
    if (this.ts) {
      const alpha = this._advance(t);                 // advance even when out of reach: the clock only moves forward
      if (p[1] - r < VEH_TOP) {
        const ts = this.ts, V = ts.vehicles, bb = this._broad(), o = this._o;
        for (let i = 0; i < V.length; i++) {
          if (p[0] + r < bb[i * 4] || p[0] - r > bb[i * 4 + 1] || p[2] + r < bb[i * 4 + 2] || p[2] - r > bb[i * 4 + 3]) continue;
          const v = V[i]; ts.pose(v, alpha, o); if (o.hidden) continue;
          if (!boxHit(p, r, o.x, v.H / 2, o.z, v.W / 2, v.H / 2, v.L / 2, o.hx, o.hz, tmp)) continue;
          if (best && tmp.depth <= best.depth) continue;
          best = res; res.kind = 'vehicle'; res.id = v.id; res.type = v.type; res.depth = tmp.depth;
          res.n[0] = tmp.n[0]; res.n[1] = tmp.n[1]; res.n[2] = tmp.n[2];
          res.vel[0] = o.hx * v.v; res.vel[1] = 0; res.vel[2] = o.hz * v.v;
        }
      }
    }
    // pedestrians: static capsules
    const S = this.src;
    if (S.grid && p[1] - r < PED_H) {
      const R = PED_R + r, i0 = Math.floor((p[0] - R) / CELL), i1 = Math.floor((p[0] + R) / CELL), j0 = Math.floor((p[2] - R) / CELL), j1 = Math.floor((p[2] + R) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const cell = S.grid.get(i * 100003 + j); if (!cell) continue;
        for (const k of cell) {
          const q = S.peds[k], qy = Math.max(PED_R, Math.min(q.h - PED_R, p[1]));
          const dx = p[0] - q.x, dy = p[1] - qy, dz = p[2] - q.z, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= R * R) continue;
          const d = Math.sqrt(d2), depth = R - d;
          if (best && depth <= best.depth) continue;
          best = res; res.kind = 'pedestrian'; res.id = q.id; res.type = 'pedestrian'; res.depth = depth;
          if (d > 1e-6) { res.n[0] = dx / d; res.n[1] = dy / d; res.n[2] = dz / d; } else { res.n[0] = 0; res.n[1] = 1; res.n[2] = 0; }
          res.vel[0] = 0; res.vel[1] = 0; res.vel[2] = 0;
        }
      }
    }
    // walkers from seoul-life, when it serves them
    if (S.people && p[1] - r < PED_H) {
      const h = S.people(p, r, t);
      if (h && (!best || h.depth > best.depth)) {
        best = res; res.kind = 'pedestrian'; res.id = h.id; res.type = h.type || 'pedestrian'; res.depth = h.depth;
        res.n[0] = h.n[0]; res.n[1] = h.n[1]; res.n[2] = h.n[2]; res.vel[0] = h.vel?.[0] || 0; res.vel[1] = h.vel?.[1] || 0; res.vel[2] = h.vel?.[2] || 0;
      }
    }
    return best;
  }
  // debug / tests: the vehicles' boxes at t (as LifeSim.boxesAt) and the capsule count
  stats() { return { vehicles: this.ts ? this.ts.vehicles.length : 0, pedestrians: this.src.peds.length, walkers: !!this.src.people }; }
}

export function lifeMovers(life) {
  if (!life) return null;
  const col = life.colliders;
  if (col && typeof col.fork === 'function' && col.contract === 'P2-F1') return col;   // 1. seoul-life serves the contract
  const sim = life.sim, tr = sim?.traffic;
  const TS = tr && typeof tr.constructor === 'function' && typeof tr.step === 'function' && typeof tr.pose === 'function' ? tr.constructor : null;
  const peds = [];
  // [integ7] G's phase-2 crowd: walkers are a pure function of the take clock (not collidable yet); the standing and
  // seated people (chat clusters, smokers, queues, the bouncer, pocha tables) are crowd.statics ids into crowd.people
  const cr = sim?.crowd;
  if (cr && Array.isArray(cr.people) && Array.isArray(cr.statics)) for (const id of cr.statics) {
    const a = cr.people[id]; if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.z)) continue;
    const s = Number.isFinite(a.scale) ? Math.max(0.85, Math.min(1.15, a.scale)) : 1;
    peds.push({ id: 100000 + (a.id ?? peds.length), x: a.x, z: a.z, h: (a.pose === 3 /* P_SIT */ ? PED_SIT : PED_H) * s });
  }
  for (const a of sim?.crowd?.agents || []) {
    if (a.mode !== M_STAND && a.mode !== M_SEAT) continue;
    if (!Number.isFinite(a.x) || !Number.isFinite(a.z)) continue;
    const s = Number.isFinite(a.scale) ? Math.max(0.85, Math.min(1.15, a.scale)) : 1;
    peds.push({ id: 100000 + (a.id ?? peds.length), x: a.x, z: a.z, h: (a.mode === M_SEAT ? PED_SIT : PED_H) * s });
  }
  let grid = null;
  if (peds.length) {
    grid = new Map();
    peds.forEach((q, k) => { const key = Math.floor(q.x / CELL) * 100003 + Math.floor(q.z / CELL); let c = grid.get(key); if (!c) grid.set(key, (c = [])); c.push(k); });
  }
  const people = col && typeof col.people === 'function' ? (p, r, t) => col.people(p, r, t) : null;
  if (!TS && !grid && !people) return null;
  const hz = tr?.dt ? Math.round(1 / tr.dt) : 60;
  const warm = col && 'warm' in col ? () => +col.warm || 0 : null, snaps = sim?.snaps instanceof Map && hz === 60 ? sim.snaps : null;
  return new Movers({ TS, net: sim?.net, seed: tr?.seed ?? 1, hz, peds, grid, people, warm, snaps });
}

export default { lifeMovers, PED_R, PED_H };
