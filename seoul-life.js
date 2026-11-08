// seoul-life.js: Neon Seoul (Hongdae) street life. Stream S4, contract L2/L3.
//   build(layout, ctx) -> { group, emitters, colliders, update(t, camPos?, camQuat?), audio, sim, stats, setFill(k), dispose() }
//
// Everything that moves is a pure function of (seed, take clock):
//   * TrafficSim: taxis, cars, 1-ton trucks, city buses (median bus lane, dwell + kneel at stops), delivery scooters,
//     on a lane graph built from layout.streets. IDM car-following at a fixed 60 Hz step (= every 4th 240 Hz take
//     tick), signals cycling on the take clock, taxis pulling over with hazards. Integer-seeded, no Math.random, no
//     trig in the step, so a replay of the same take clock reproduces every bumper to the bit. Kinematic colliders:
//     colliders.at(t) / colliders.hit(p, r, t) (flight.js support is the D stream's, plan-U5 M3).
//   * CrowdSim: visual only this phase (no collision). Fixed 10 Hz step, interpolated: sidewalk/walkway lanes with
//     keep-right flow, head-on and overtaking avoidance, walking groups abreast, junction hand-off between streets,
//     chatting groups and club queues at frontages, seated groups at pocha tents, crowds that bunch at the kerb and
//     surge over the crosswalk on the walk phase, people stepping aside for alley scooters.
// Rendering: one procedural human (CC0 by construction: built here, no asset) with a 10-bone walk/phone/idle/sit
// cycle evaluated in the vertex shader, instanced in two LODs (near < 18 m, mid < 170 m). Shopfront fill: a 4 m grid
// of what the frontages (and S2's emitters when passed) throw onto the pavement, so people read as lit silhouettes
// against shopfronts even before S3's light grid. Vehicles: instanced low-poly bodies with emissive head/tail/brake/
// hazard/bus-interior parts, additive headlight pools on the asphalt, and an L3 emitter per light cluster.
//
// Units: metres, y up, x east, z south (L1). Luminance: emissive parts are authored in nits and scaled by
// ctx.nitScale (scene units per nit; S3 owns the calibration). Fill grid is in lux.
import * as THREE from 'three';
import { Rng } from './rng.js';
import { createSeoulAudio } from './seoul-audio.js';

export const LIFE = {
  crowdHz: 10, trafficHz: 60,
  // pedestrians per m^2 of walkway, Friday ~22:00 (provisional; to be fitted to the M0 clip counts, plan-U5 §5)
  density: { main: 0.08, walking: 0.25, club: 0.2, alley: 0.06 },
  // when the budget can't hold every street at its density, hero streets keep more of theirs
  priority: { walking: 1, club: 1, main: 0.6, alley: 0.35 },
  maxAgents: 2400, nearR: 18, midR: 55, farR: 170, maxNear: 140, maxMid: 700, maxDrawn: 1600,
  groupShare: 0.55,            // share of pedestrians walking in groups of 2-4 (nightlife district)
  phoneShare: 0.18,            // walkers looking at a phone
  sidewalk: (w) => Math.max(3, Math.min(6, w * 0.15)),
  laneW: 3.25,
  signal: { period: 70, green: 36, amber: 3, allRed: 1, walk: 26 },   // s; walk = after green+amber+allRed
  nitScale: 1e-3,
};

// ---------------------------------------------------------------- geometry
export class Path {
  constructor(pts) {
    this.p = pts.map((q) => [q[0], q[1]]); const n = this.p.length;
    this.cum = [0]; this.t = [];
    for (let i = 1; i < n; i++) {
      const dx = this.p[i][0] - this.p[i - 1][0], dz = this.p[i][1] - this.p[i - 1][1], l = Math.hypot(dx, dz) || 1e-6;
      this.cum.push(this.cum[i - 1] + l); this.t.push([dx / l, dz / l]);
    }
    this.len = this.cum[n - 1];
  }
  seg(s) { let lo = 0, hi = this.t.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.cum[m] <= s) lo = m; else hi = m - 1; } return lo; }
  // o = {x, z, tx, tz, nx, nz}; n = right normal (-tz, tx) of the smoothed tangent (kinks blend over +-B m)
  at(s, o = {}) {
    s = s < 0 ? 0 : s > this.len ? this.len : s;
    const i = this.seg(s), u = s - this.cum[i], a = this.p[i], t = this.t[i];
    o.x = a[0] + t[0] * u; o.z = a[1] + t[1] * u;
    let tx = t[0], tz = t[1]; const B = 3;
    if (i > 0 && u < B) { const w = 0.5 + 0.5 * u / B, q = this.t[i - 1]; tx = q[0] + (t[0] - q[0]) * w; tz = q[1] + (t[1] - q[1]) * w; }
    else if (i < this.t.length - 1 && this.cum[i + 1] - s < B) { const w = 0.5 + 0.5 * (this.cum[i + 1] - s) / B, q = this.t[i + 1]; tx = q[0] + (t[0] - q[0]) * w; tz = q[1] + (t[1] - q[1]) * w; }
    const l = Math.sqrt(tx * tx + tz * tz) || 1; o.tx = tx / l; o.tz = tz / l; o.nx = -o.tz; o.nz = o.tx;
    return o;
  }
  project(x, z) {
    let best = { s: 0, d: 0, dist: Infinity };
    for (let i = 0; i < this.t.length; i++) {
      const a = this.p[i], t = this.t[i], L = this.cum[i + 1] - this.cum[i];
      let u = (x - a[0]) * t[0] + (z - a[1]) * t[1]; u = u < 0 ? 0 : u > L ? L : u;
      const px = a[0] + t[0] * u, pz = a[1] + t[1] * u, dist = Math.hypot(x - px, z - pz);
      if (dist < best.dist) best = { s: this.cum[i] + u, d: (x - px) * -t[1] + (z - pz) * t[0], dist };
    }
    return best;
  }
}
function segX(a, b, c, d) {   // segment intersection -> [ua, ub] or null
  const r0 = b[0] - a[0], r1 = b[1] - a[1], s0 = d[0] - c[0], s1 = d[1] - c[1], den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-9) return null;
  const ua = ((c[0] - a[0]) * s1 - (c[1] - a[1]) * s0) / den, ub = ((c[0] - a[0]) * r1 - (c[1] - a[1]) * r0) / den;
  return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1 ? [ua, ub] : null;
}
function pathCross(A, B) {   // all (sA, sB) where two polylines cross
  const out = [];
  for (let i = 0; i < A.t.length; i++) for (let j = 0; j < B.t.length; j++) {
    const r = segX(A.p[i], A.p[i + 1], B.p[j], B.p[j + 1]);
    if (r) out.push([A.cum[i] + r[0] * (A.cum[i + 1] - A.cum[i]), B.cum[j] + r[1] * (B.cum[j + 1] - B.cum[j])]);
  }
  return out;
}
// longest s-range of `path` that stays clear of every main street's band (half-width `inset` from its centre line)
function clearRange(path, mains, insetOf) {
  if (!mains.length) return [0, path.len];
  const o = {}; let best = [0, 0], cur = null;
  for (let s = 0; s <= path.len + 1e-6; s += 0.5) {
    path.at(s, o); let inside = false;
    for (const m of mains) { const pr = m.path.project(o.x, o.z); if (pr.dist < insetOf(m) && pr.s > 0.1 && pr.s < m.path.len - 0.1) { inside = true; break; } }
    if (!inside) { if (!cur) cur = [s, s]; cur[1] = s; if (cur[1] - cur[0] > best[1] - best[0]) best = cur.slice(); }
    else cur = null;
  }
  return best;
}
export function signalPhase(t, offset = 0) {   // mid-block crosswalk: -> { car: 'G'|'A'|'R', walk, tc, w0, wlen }
  const S = LIFE.signal, tc = (((t + offset) % S.period) + S.period) % S.period;
  const car = tc < S.green ? 'G' : tc < S.green + S.amber ? 'A' : 'R';
  const w0 = S.green + S.amber + S.allRed;
  return { car, walk: tc >= w0 && tc < w0 + S.walk, tc, w0, wlen: S.walk };
}
// crosswalk c at take clock t. Intersections ('X') run two axis groups: axis 0 green 0-30 s, axis 1 green 35-65 s
// (3 s amber, 2 s all-red); a crosswalk over an axis-g road walks while the other axis has its green.
export function crossPhase(c, t) {
  if (c.kind !== 'X') return signalPhase(t, c.offset);
  const P = LIFE.signal.period, tc = (((t + c.offset) % P) + P) % P, g0 = c.axis ? 35 : 0, u = (tc - g0 + P) % P;
  const car = u < 30 ? 'G' : u < 33 ? 'A' : 'R';
  const w0 = c.axis ? 0 : 35, wlen = 27;
  return { car, walk: tc >= w0 && tc < w0 + wlen, tc, w0, wlen };
}

// ---------------------------------------------------------------- the network shared by both sims
// Works on both kinds of L1 layout: the synthetic one (street width = building line to building line) and S1's OSM one
// (width = carriageway; ways split at every junction; Yanghwa-ro as two one-way carriageways). The street profile
// (carriageway half-width, pavement band per side) comes from where the street's own lots actually stand.
export function buildNetwork(layout) {
  const streets = (layout.streets || []).filter((s) => s.points && s.points.length >= 2).map((s) => ({ ...s, path: new Path(s.points) }));
  const byId = new Map(streets.map((s) => [s.id, s]));
  const half = layout.half || null;
  // ---- building lines per side, from the frontages of the street's own lots
  const sides = new Map(streets.map((s) => [s, { L: [], R: [] }]));
  for (const l of layout.lots || []) {
    const st = byId.get(l.street); if (!st || !l.frontage) continue;
    const m = [(l.frontage[0][0] + l.frontage[1][0]) / 2, (l.frontage[0][1] + l.frontage[1][1]) / 2], pr = st.path.project(m[0], m[1]);
    if (pr.dist < 40) sides.get(st)[pr.d >= 0 ? 'R' : 'L'].push(Math.abs(pr.d));
  }
  const med = (a) => { if (!a.length) return null; const b = a.slice().sort((p, q) => p - q); return b[b.length >> 1]; };
  for (const st of streets) {
    const sd = sides.get(st), bl = [med(sd.L), med(sd.R)], w2 = st.width / 2;
    if (st.kind === 'main') {
      // building line well beyond width/2: width is the carriageway (OSM). Else width spans the pavements (synthetic).
      const known = bl.filter((v) => v != null), b = known.length ? Math.min(...known) : null;
      const carriage = b != null && b > w2 + 1.8 ? w2 : st.sidewalk ? w2 - st.sidewalk : w2 - LIFE.sidewalk(st.width);
      st.carHalf = Math.max(1.7, carriage);
      st.walk = [-1, 1].map((sg, i) => {
        const line = bl[i] ?? (b != null && b <= w2 + 1.8 ? w2 : null);
        if (line == null) return null;                                  // no buildings on this side (median of a dual carriageway)
        const outer = Math.min(line, st.carHalf + 7), inner = st.carHalf + 0.5;
        return outer - inner > 1.2 ? [inner, outer - 0.5] : null;
      });
      if (!st.walk[0] && !st.walk[1] && !known.length) st.walk = [[st.carHalf + 0.5, st.carHalf + 3], [st.carHalf + 0.5, st.carHalf + 3]];
    } else {
      const known = bl.filter((v) => v != null), b = known.length ? Math.min(...known) : w2;
      st.walkHalf = Math.max(1.4, Math.min(Math.max(w2, b), w2 + 3) - 0.5);
    }
  }
  // ---- one-way carriageways: st.oneway (1 = point order, -1 = reverse) or a same-named anti-parallel twin nearby
  const mains = streets.filter((s) => s.kind === 'main');
  const o1 = {}, o2 = {};
  for (const a of mains) {
    if (a.oneway != null) { a.ow = a.oneway === true ? 1 : +a.oneway || 0; continue; }
    a.ow = 0; a.path.at(a.path.len / 2, o1);
    for (const b of mains) {
      if (b === a || (b.ko || b.name) !== (a.ko || a.name) || !(a.ko || a.name)) continue;
      const pr = b.path.project(o1.x, o1.z); if (pr.dist > (a.width + b.width) / 2 + 22 || pr.dist < 2) continue;
      b.path.at(pr.s, o2); if (o1.tx * o2.tx + o1.tz * o2.tz < -0.8) { a.ow = 1; break; }
    }
  }
  // ---- junction nodes: street end points clustered within 3 m
  const nodes = [];
  const nodeOf = (p) => { for (const n of nodes) if (Math.hypot(n.x - p[0], n.z - p[1]) < 3) return n; const n = { id: nodes.length, x: p[0], z: p[1], ends: [] }; nodes.push(n); return n; };
  for (const st of streets) { st.n = [nodeOf(st.points[0]), nodeOf(st.points[st.points.length - 1])]; st.n[0].ends.push({ st, k: 0 }); st.n[1].ends.push({ st, k: 1 }); }
  // map-edge dead ends (where traffic and walkers enter and leave the block): within 12 m of any side of the street
  // bounding box. (P1 used max |coord| - 4 for every side, so on the asymmetric OSM box 3 of 7 road ends qualified.)
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (const s of streets) for (const p of s.points) { bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]); bz0 = Math.min(bz0, p[1]); bz1 = Math.max(bz1, p[1]); }
  if (half) { bx0 = Math.max(bx0, -half); bx1 = Math.min(bx1, half); bz0 = Math.max(bz0, -half); bz1 = Math.min(bz1, half); }
  for (const n of nodes) n.boundary = n.ends.length === 1 && (n.x < bx0 + 12 || n.x > bx1 - 12 || n.z < bz0 + 12 || n.z > bz1 - 12);
  // ---- crosswalks + signals
  const crossings = []; let ci = 0;
  const addCross = (c) => {
    c.main.path.at(c.sc, o1); c.x = o1.x; c.z = o1.z;
    if (crossings.some((d) => Math.hypot(d.x - c.x, d.z - c.z) < 14)) return;
    c.id = 'X' + ci++; c.cw = 5; c.halfSpan = c.main.carHalf + 0.9; crossings.push(c);
  };
  for (const n of nodes) {   // intersections: >= 3 road pieces, or 2 of different names
    const roads = n.ends.filter((e) => e.st.kind === 'main');
    const names = new Set(roads.map((e) => e.st.ko || e.st.name || e.st.id));
    if (!(roads.length >= 3 || (roads.length === 2 && names.size === 2))) continue;
    const ax0 = (() => { const e = roads[0]; e.st.path.at(e.k ? e.st.path.len : 0, o1); return [o1.tx, o1.tz]; })();
    const off = (n.id * 17) % LIFE.signal.period;
    for (const e of roads) {
      const P = e.st.path; P.at(e.k ? P.len : 0, o1);
      const axis = Math.abs(o1.tx * ax0[1] - o1.tz * ax0[0]) < 0.5 ? 0 : 1;
      const r = Math.max(...n.ends.filter((q) => q !== e).map((q) => (q.st.carHalf ?? q.st.width / 2))) + 3.5;
      if (P.len < r + 3) continue;
      addCross({ kind: 'X', node: n, main: e.st, sc: e.k ? P.len - r : r, toward: e.k ? 1 : -1, axis, offset: off });
    }
  }
  for (const m of mains) for (const o of streets) {   // mid-block: a walking or club street meets a road
    if (o.kind !== 'walking' && o.kind !== 'club') continue;
    const hits = pathCross(m.path, o.path).map(([sm]) => sm);
    for (const k of [0, o.points.length - 1]) { const pr = m.path.project(o.points[k][0], o.points[k][1]); if (pr.dist < m.carHalf + 8) hits.push(pr.s); }
    for (const sm of hits) {
      const sc = Math.max(3, Math.min(m.path.len - 3, sm + o.width / 2 + 3)); if (m.path.len < 8) continue;
      addCross({ kind: 'T', main: m, sc, toward: 0, axis: 0, offset: (ci * 13) % LIFE.signal.period });
    }
  }
  return { streets, mains, nodes, crossings, bounds: boundsOf(layout, streets) };
}
function boundsOf(layout, streets) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const add = (p) => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); };
  for (const s of streets) s.points.forEach(add);
  for (const l of layout.lots || []) (l.footprint || []).forEach(add);
  if (!isFinite(x0)) { x0 = z0 = -100; x1 = z1 = 100; }
  return { x0: x0 - 10, x1: x1 + 10, z0: z0 - 10, z1: z1 + 10 };
}

// ---------------------------------------------------------------- traffic
// vehicle classes: L/W/H (m), v0 (m/s), IDM a/b (m/s^2), s0 (m), T (s)
export const VEH = {
  car:     { L: 4.7, W: 1.85, H: 1.45, v0: 13.0, a: 1.6, b: 2.2, s0: 2.0, T: 1.2 },
  taxi:    { L: 4.85, W: 1.85, H: 1.48, v0: 14.0, a: 1.9, b: 2.5, s0: 1.8, T: 1.0 },
  truck:   { L: 5.1, W: 1.75, H: 1.95, v0: 12.0, a: 1.2, b: 2.0, s0: 2.2, T: 1.4 },
  bus:     { L: 11.0, W: 2.5, H: 3.15, v0: 11.5, a: 0.9, b: 1.6, s0: 2.5, T: 1.6 },
  scooter: { L: 1.9, W: 0.75, H: 1.45, v0: 12.5, a: 2.4, b: 3.0, s0: 1.2, T: 0.8 },
};
const VTYPES = ['car', 'taxi', 'truck', 'bus', 'scooter'];
// Seoul night palettes (sRGB): mostly white / black / grey-silver; taxis silver-white or orange
const PAINT = {
  car: [[0.92, 0.92, 0.9], [0.92, 0.92, 0.9], [0.9, 0.91, 0.92], [0.05, 0.05, 0.06], [0.06, 0.06, 0.07], [0.55, 0.56, 0.58], [0.38, 0.39, 0.41], [0.68, 0.69, 0.7], [0.12, 0.17, 0.3], [0.45, 0.07, 0.07]],
  taxi: [[0.86, 0.86, 0.84], [0.8, 0.81, 0.82], [0.85, 0.42, 0.13], [0.86, 0.86, 0.84]],
  truck: [[0.18, 0.32, 0.62], [0.88, 0.89, 0.9], [0.2, 0.34, 0.6]],
  bus: [[0.16, 0.36, 0.72], [0.16, 0.36, 0.72], [0.28, 0.6, 0.25]],
  scooter: [[0.85, 0.85, 0.85], [0.08, 0.08, 0.09], [0.6, 0.12, 0.1], [0.2, 0.22, 0.25]],
};

export class TrafficSim {
  constructor(net, { seed = 1 } = {}) {
    this.net = net; this.seed = seed >>> 0; this.dt = 1 / LIFE.trafficHz;
    this.lanes = [];
    const LW = LIFE.laneW, o = {};
    for (const st of net.streets) {
      const P = st.path;
      if (st.kind === 'main') {
        const ch = st.carHalf;
        if (st.ow) {   // one-way: lanes across the whole carriageway, k = 0 leftmost (Seoul median bus lane)
          const n = Math.max(1, Math.min(6, Math.round((2 * ch) / LW))), w = (2 * ch) / n;
          for (let k = 0; k < n; k++) this.lanes.push({ street: st, base: P, dir: st.ow, k, lat: st.ow * (-ch + (k + 0.5) * w), shared: false, bus: n >= 3 && k === 0, curb: k === n - 1, s0: 0, s1: P.len });
        } else {
          const n = Math.max(1, Math.min(4, Math.round(ch / LW))), w = ch / n;
          for (const dir of [1, -1]) for (let k = 0; k < n; k++) this.lanes.push({ street: st, base: P, dir, k, lat: dir * (k + 0.5) * w * (n === 1 ? 1.15 : 1), shared: false, bus: n >= 3 && k === 0, curb: k === n - 1, s0: 0, s1: P.len });
        }
      } else if (st.kind !== 'pedestrian') {
        const r = clearRange(P, net.mains, (m) => m.carHalf + 0.6);
        if (r[1] - r[0] < 6) continue;
        for (const dir of [1, -1]) this.lanes.push({ street: st, base: P, dir, k: 0, lat: dir * Math.min(1.6, st.walkHalf * 0.4), shared: true, bus: false, curb: true, s0: r[0], s1: r[1] });
      }
    }
    for (const [i, ln] of this.lanes.entries()) {
      const st = ln.street;
      ln.id = `${st.id}:${ln.dir > 0 ? 'f' : 'b'}${ln.k}`; ln.idx = i; ln.len = ln.s1 - ln.s0;
      ln.start = ln.dir > 0 ? (ln.s0 < 0.5 ? st.n[0] : null) : (ln.s1 > st.path.len - 0.5 ? st.n[1] : null);
      ln.end = ln.dir > 0 ? (ln.s1 > st.path.len - 0.5 ? st.n[1] : null) : (ln.s0 < 0.5 ? st.n[0] : null);
      st.path.at(this.toBase(ln, 0), o); ln.h0 = [o.tx * ln.dir, o.tz * ln.dir];
      st.path.at(this.toBase(ln, ln.len), o); ln.h1 = [o.tx * ln.dir, o.tz * ln.dir];
      // stop lines: 2.5 m before each crosswalk this lane runs into
      ln.stops = [];
      if (!ln.shared) for (const c of net.crossings) if (c.main === st && (c.toward === 0 || c.toward === ln.dir)) {
        const sc = ln.dir > 0 ? c.sc - ln.s0 : ln.s1 - c.sc, sl = sc - c.cw / 2 - 2.5;
        if (sl > 1) ln.stops.push({ s: sl, c });
      }
      ln.stops.sort((a, b) => a.s - b.s);
      ln.busStops = ln.bus && ln.len > 70 ? [ln.len * 0.45] : [];
    }
    // successors: lanes of the other streets that start where this one ends, grouped by approach (street + dir)
    for (const ln of this.lanes) {
      ln.succ = []; ln.pred = 0;
      if (!ln.end) continue;
      const by = new Map();
      for (const m of this.lanes) {
        if (m.start !== ln.end || m.street === ln.street || m.shared !== ln.shared) continue;
        const key = m.street.id + m.dir; let g = by.get(key); if (!g) by.set(key, (g = { lanes: [], turn: ln.h1[0] * m.h0[0] + ln.h1[1] * m.h0[1] })); g.lanes.push(m);
      }
      for (const g of by.values()) { g.lanes.sort((a, b) => a.k - b.k); if (g.turn > -0.7) ln.succ.push(g); }
    }
    for (const ln of this.lanes) for (const g of ln.succ) for (const m of g.lanes) m.pred++;
    // re-entry (life #6): road traffic re-enters only at map-edge lanes, so nothing pops in on stage. Alley scooters come
    // in at a map edge, else at an alley mouth on a road kerb (lane cut by the road band: start === null).
    const len10 = (l) => l.len > 10;
    this.entries = {
      road: this.lanes.filter((l) => !l.shared && len10(l) && l.pred === 0 && l.start && l.start.boundary && !l.bus),
      shared: this.lanes.filter((l) => l.shared && len10(l) && l.start && l.start.boundary),
    };
    if (this.entries.shared.length < 6) this.entries.shared.push(...this.lanes.filter((l) => l.shared && len10(l) && !l.start));
    if (!this.entries.road.length) this.entries.road = this.lanes.filter((l) => !l.shared && len10(l) && l.pred === 0);
    for (const k of ['road', 'shared']) if (!this.entries[k].length) this.entries[k] = this.lanes.filter((l) => l.shared === (k === 'shared') && len10(l));
    this.busEntries = this.lanes.filter((l) => l.bus && len10(l) && l.pred === 0 && l.start && l.start.boundary);
    this.twin = new Map();
    for (const ln of this.lanes) this.twin.set(ln, this.lanes.find((m) => m.street === ln.street && m.dir === -ln.dir && m.k === ln.k) || null);
    // neighbours for lane changes (same carriageway and direction, k +- 1)
    for (const ln of this.lanes) {
      ln.adj = ln.shared ? [] : this.lanes.filter((m) => m !== ln && m.street === ln.street && m.dir === ln.dir && !m.shared && Math.abs(m.k - ln.k) === 1);
    }
    this.reset();
  }
  toBase(ln, s) { return ln.dir > 0 ? ln.s0 + s : ln.s1 - s; }
  reset() {
    const R = this.R = new Rng(this.seed ^ 0x7a11c);
    this.n = 0; this.vehicles = []; this.events = []; let id = 0;
    for (const ln of this.lanes) {
      ln.veh = [];
      if (ln.len < 8) continue;
      let s = ln.shared ? ln.len - R.next() * 400 : ln.len - R.next() * 12;   // alleys: most short ones start empty
      while (s > 2) {
        const type = this.pickType(ln, R), c = VEH[type];
        const v = this.spawn(id++, type, ln, s, R);
        v.v = v.v0 * (0.4 + 0.4 * R.next());
        ln.veh.push(v); this.vehicles.push(v);
        // alley lanes: one scooter or car per ~350 m of lane (life #6: ~40 scooters in all, P1 had 161)
        s -= c.L + (ln.shared ? 220 + R.next() * 300 : (type === 'bus' ? 70 + R.next() * 90 : 10 + R.next() * 30));
      }
    }
    for (const v of this.vehicles) v.next = this.pickNext(v.lane, v, R);
  }
  // Hongdae after 22:00: taxis are 45 % of the car-class traffic (life #6), few trucks, scooters on the kerb lanes
  pickType(ln, R) {
    if (ln.bus) return 'bus';
    if (ln.shared) return ln.street.kind === 'walking' || R.next() < 0.8 ? 'scooter' : 'car';
    const r = R.next();
    return r < 0.36 ? 'car' : r < 0.74 ? 'taxi' : r < 0.81 ? 'truck' : ln.curb && r < 0.91 ? 'scooter' : 'car';
  }
  spawn(id, type, ln, s, R) {
    const c = VEH[type], pal = PAINT[type];
    const v0 = (ln.shared ? (type === 'scooter' ? 5.5 : 3.5) : c.v0) * (0.85 + 0.3 * R.next());
    return { id, type, lane: ln, s, ps: s, v: 0, v0, acc: 0, L: c.L, W: c.W, H: c.H, paint: pal[Math.floor(R.next() * pal.length)], weave: R.next(),
      dwell: null, dwellT: 0, hazard: false, brake: 0, jumped: true, hidden: false, nextPick: R.next() * 40, next: null, jx: 0, jz: 0, jhx: 0, jhz: 0, stepped: -1,
      still: 0, hsrc: -1e9, lc0: 0, lcN: -1e9, lcCool: 0, horn: 0 };
  }
  // the lane v takes after ln: approaches weighted toward straight on; lane index kept (buses keep the bus lane)
  pickNext(ln, v, R) {
    if (!ln.succ.length) return null;
    let tot = 0; const w = ln.succ.map((g) => { const c = Math.max(0, g.turn); const x = 0.25 + 3 * c * c; tot += x; return x; });
    let r = R.next() * tot, g = ln.succ[ln.succ.length - 1];
    for (let i = 0; i < w.length; i++) if ((r -= w[i]) < 0) { g = ln.succ[i]; break; }
    const L = g.lanes;
    if (v.type === 'bus') return L.find((m) => m.bus) || L[0];
    let k = Math.min(L.length - 1, ln.k); if (L[k].bus) k = Math.min(L.length - 1, k + 1);
    if (L[k].bus) return null;
    return L[k];
  }
  hasRoom(ln, need) { for (const o of ln.veh) if (!o.hidden && o.s - o.L < need) return false; return true; }
  enter(v, ln, s, R, carry) {   // move v into ln at s (carry: keep the world position continuous)
    const old = v.lane, i = old.veh.indexOf(v); if (i >= 0) old.veh.splice(i, 1);
    if (carry) {
      const a = this.pose(v, 1, {}), ps = v.ps - old.len, vs = v.s;
      v.lane = ln; v.s = 0; v.ps = 0; v.jx = 0; v.jz = 0; v.jhx = 0; v.jhz = 0;
      const b = this.pose(v, 1, {});
      v.jx = a.x - b.x; v.jz = a.z - b.z; v.jhx = a.hx - b.hx; v.jhz = a.hz - b.hz; v.s = s; v.ps = ps < s ? Math.max(-0.5, ps) : s; void vs;
    } else { v.lane = ln; v.s = s; v.ps = s; v.jx = v.jz = v.jhx = v.jhz = 0; v.jumped = true; }
    ln.veh.push(v); v.dwell = null; v.dwellT = 0; v.hazard = false; v.nextPick = s + 30 + R.next() * 150;
    v.next = this.pickNext(ln, v, R);
  }
  respawn(v, R) {   // re-enter the block at an entry lane (off-stage), or wait hidden until there is room
    const E = v.type === 'bus' && this.busEntries.length ? this.busEntries : this.entries[v.lane.shared ? 'shared' : 'road'], ln = E[Math.floor(R.next() * E.length)];
    const type = this.pickType(ln, R), nv = this.spawn(v.id, type, ln, 0, R), old = v.lane;
    const i = old.veh.indexOf(v); if (i >= 0) old.veh.splice(i, 1);
    Object.assign(v, nv); v.lane = old; v.hidden = true;
    this.enter(v, ln, 0, R, false); v.hidden = !this.hasRoom(ln, v.L + 8); v.v = v.hidden ? 0 : Math.min(v.v0, 6);
  }
  step() {
    const dt = this.dt, R = this.R, t = this.n * dt, N = this.n;
    this.events.length = 0;
    for (const ln of this.lanes) {
      const vs = ln.veh; vs.sort((a, b) => b.s - a.s || a.id - b.id);
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i], c = VEH[v.type];
        if (v.stepped === N) continue;
        v.stepped = N; v.ps = v.s; v.jumped = false;
        if (v.hidden) { if (this.hasRoom(ln, v.L + 8)) { v.hidden = false; v.v = Math.min(v.v0, 6); v.jumped = true; } continue; }
        // leader: in this lane, else the last car of the lane we turn into
        let gap = Infinity, dv = 0, ldr = null;
        for (let j = i - 1; j >= 0; j--) { const l = vs[j]; if (!l.hidden) { gap = l.s - l.L - v.s; dv = v.v - l.v; ldr = l; break; } }
        if (gap === Infinity && v.next) {
          let last = null; for (const o of v.next.veh) if (!o.hidden && (!last || o.s < last.s)) last = o;
          if (last) { gap = ln.len - v.s + last.s - last.L; dv = v.v - last.v; ldr = last; }
        }
        // signals (held: a red or amber ahead within 150 m, so the watchdog doesn't count the wait)
        let held = false;
        for (const st of ln.stops) {
          const d = st.s - v.s; if (d < -0.5 || d > 150) continue;
          const ph = crossPhase(st.c, t);
          if (ph.car !== 'G') held = true;
          if (d > 120) continue;
          const stop = ph.car === 'R' || (ph.car === 'A' && d > v.v * v.v / (2 * c.b) + 1);
          if (stop && d < gap) { gap = Math.max(0.01, d); dv = v.v; }
        }
        // dwell (taxi pick-up, bus stop); no exit: slow for the end of the lane only when it is a dead end on stage
        if (v.dwell != null) { const d = v.dwell - v.s; if (d < gap) { gap = Math.max(0.01, d); dv = v.v; } }
        // IDM
        const sstar = c.s0 + Math.max(0, v.v * c.T + v.v * dv / (2 * Math.sqrt(c.a * c.b)));
        const r = v.v / v.v0, r2 = r * r;
        let a = c.a * (1 - r2 * r2 - (gap === Infinity ? 0 : (sstar / gap) * (sstar / gap)));
        if (a < -9) a = -9;
        v.acc = a; v.v += a * dt; if (v.v < 0) v.v = 0;
        v.s += v.v * dt;
        v.brake = a < -0.4 || v.v < 0.3 ? 1 : 0;
        // dwell starts once stopped at the point. IDM halts a vehicle s0 short of its target, so the trigger is s0 + 1.5
        // (P1 used 1.5: taxis and buses stopped 1.7-5.5 m short and never started their dwell, deadlocking every lane)
        if (v.dwell != null && v.v < 0.15 && v.dwell - v.s < c.s0 + 1.5) {
          if (v.dwellT === 0) {
            v.dwellT = N + Math.floor((v.type === 'bus' ? 9 + R.next() * 10 : 5 + R.next() * 9) * LIFE.trafficHz);
            if (v.type === 'bus') this.events.push({ type: 'kneel', id: v.id });
          } else if (N >= v.dwellT) { v.dwell = null; v.dwellT = 0; v.hazard = false; v.nextPick = v.s + 80 + R.next() * 200; if (v.type === 'bus') this.events.push({ type: 'doors', id: v.id }); }
        }
        if (v.dwell == null) {
          if (v.type === 'bus') { for (const bs of ln.busStops) if (bs - v.s > 25 && bs - v.s < 30 + v.v) { v.dwell = bs; break; } }
          else if (v.type === 'taxi' && ln.curb && v.s > v.nextPick && v.s < ln.len - 40) {
            // pick-ups mostly where others can pass (multi-lane kerb lanes); on a one-lane road a taxi stops 1 time in 4
            if (ln.adj.length || R.next() < 0.25) { v.dwell = v.s + 18 + R.next() * 10; v.hazard = true; } else v.nextPick = v.s + 150 + R.next() * 300;
          }
        }
        // watchdog (life #2): stopped for 25 s with nothing holding it (no red ahead, not dwelling). A queue head that
        // is still blocked then leaves the block (re-enters at an edge); the vehicles behind it get a lane change.
        // held is inherited down a queue (one step late, order-free): a car queued behind a red or a dwelling taxi waits;
        // only a jam that nothing explains (a merge deadlock, a gridlocked ring) runs the clock
        // (hsrc = the step its hold was last seen at a source, so a gridlocked ring can't keep itself 'held' forever)
        v.hsrc = held ? N : ldr && gap < 30 ? (ldr.dwell != null ? N : ldr.hsrc) : -1e9;
        held = N - v.hsrc < 2 * LIFE.trafficHz;
        if (v.v < 0.3 && v.dwell == null && !held) v.still++; else v.still = 0;
        if (v.still > 25 * LIFE.trafficHz) {
          let head = true; for (let j = i - 1; j >= 0; j--) if (!vs[j].hidden && vs[j].s - vs[j].L - v.s < 25) { head = false; break; }
          if (head) { v.still = 0; this.respawn(v, R); i--; this.events.push({ type: 'unstick', id: v.id }); continue; }
          if (v.still > 40 * LIFE.trafficHz) v.lcCool = 0;   // let the lane-change pass try it every round
        }
        // a taxi or car held up behind a dwelling vehicle sounds its horn now and then (sound #3: taxi horns)
        if (v.horn > 0) v.horn--;
        else if (v.type !== 'bus' && !ln.shared && v.v < 0.3 && v.id % 3 === 0 && ldr && ldr.dwell != null && gap < 12 && (N - ldr.dwellT) % (7 * LIFE.trafficHz) === 0) {
          v.horn = 25 * LIFE.trafficHz; this.events.push({ type: 'horn', id: v.id, k: v.type === 'taxi' ? 1 : 0 });
        }
        else if (v.still === Math.floor((9 + (v.id % 9)) * LIFE.trafficHz) && v.id % 2 === 0 && v.type !== 'bus' && !ln.shared) { v.horn = 25 * LIFE.trafficHz; this.events.push({ type: 'horn', id: v.id, k: v.type === 'taxi' ? 1 : 0 }); }
        // end of the lane: turn into the next one, U-turn (alley scooters at a road kerb), or leave the block
        if (v.s > ln.len) {
          const nx = v.next;
          if (nx && !this.hasRoom(nx, v.s - ln.len + 1)) { v.s = ln.len; v.v = 0; }   // merge conflict: wait at the line
          else if (nx) { this.enter(v, nx, v.s - ln.len, R, true); i--; }
          else if (ln.shared && !(ln.end && ln.end.boundary) && this.twin.get(ln)) { const tw = this.twin.get(ln); if (this.hasRoom(tw, 1.5)) { this.enter(v, tw, 0, R, true); v.v *= 0.3; i--; } else { v.s = ln.len; v.v = 0; } }
          else { this.respawn(v, R); i--; }
        }
      }
    }
    if (this.n % 15 === 0) this.laneChanges(t, R);
    this.n++;
  }
  // IDM acceleration of class c at speed v (desired v0) behind a leader `gap` m ahead closing at dv
  idm(c, v, v0, gap, dv) {
    const sstar = c.s0 + Math.max(0, v * c.T + v * dv / (2 * Math.sqrt(c.a * c.b)));
    const r = v / v0, r2 = r * r;
    return c.a * (1 - r2 * r2 - (gap === Infinity ? 0 : (sstar / gap) * (sstar / gap)));
  }
  // MOBIL lane changes (life #6), 4 Hz, deterministic order (lane index, then position): a vehicle moves to an adjacent
  // lane of its carriageway when it gains > 0.3 m/s^2 there (net of 0.25 x what it costs the new follower) and the new
  // follower brakes no harder than 3 m/s^2. Buses keep the bus lane; nobody else enters it. No changes within 25 m of a
  // stop line or the lane end, none while dwelling. Blocked vehicles (behind a dwell, a stuck head) get a lower bar.
  laneChanges(t, R) {
    const lead = (ln, s, skip) => { let b = null; for (const o of ln.veh) if (o !== skip && !o.hidden && o.s > s && (!b || o.s < b.s)) b = o; return b; };
    const foll = (ln, s, skip) => { let b = null; for (const o of ln.veh) if (o !== skip && !o.hidden && o.s <= s && (!b || o.s > b.s)) b = o; return b; };
    for (const ln of this.lanes) {
      if (!ln.adj.length || !ln.veh.length) continue;
      const vs = ln.veh.slice().sort((a, b) => b.s - a.s || a.id - b.id);
      for (const v of vs) {
        if (v.hidden || v.dwell != null || v.type === 'bus' || v.lane !== ln) continue;
        if (v.lcCool > this.n) continue;
        if (v.s < 8 || ln.len - v.s < 25 || ln.stops.some((st) => st.s - v.s > -2 && st.s - v.s < 25)) continue;
        const c = VEH[v.type], L0 = lead(ln, v.s, v);
        const gap0 = L0 ? L0.s - L0.L - v.s : Infinity, blocked = L0 && (L0.dwell != null || L0.still > 3 * LIFE.trafficHz) && gap0 < 30;
        const a0 = this.idm(c, v.v, v.v0, gap0, L0 ? v.v - L0.v : 0);
        let best = null, bestG = blocked ? 0.05 : 0.3;
        for (const m of ln.adj) {
          if (m.bus || m.s1 - m.s0 < ln.len - 1) continue;
          const Ln = lead(m, v.s, v), Fn = foll(m, v.s, v);
          const gapN = Ln ? Ln.s - Ln.L - v.s : Infinity, gapF = Fn ? v.s - v.L - Fn.s : Infinity;
          if (gapN < 1.5 || gapF < 1.5) continue;
          const aN = this.idm(c, v.v, v.v0, gapN, Ln ? v.v - Ln.v : 0);
          let cost = 0;
          if (Fn) { const cf = VEH[Fn.type], aF = this.idm(cf, Fn.v, Fn.v0, gapF, Fn.v - v.v); if (aF < -3) continue; cost = Math.max(0, this.idm(cf, Fn.v, Fn.v0, Ln ? Ln.s - Ln.L - Fn.s : Infinity, Ln ? Fn.v - Ln.v : 0) - aF); }
          const g = aN - a0 - 0.25 * cost - (m.k > ln.k ? 0 : 0.05);   // a slight keep-right preference
          if (g > bestG) { bestG = g; best = m; }
        }
        if (!best) continue;
        // execute: same base path and s range, so only the lateral position changes (eased over 3 s in pose())
        const i = ln.veh.indexOf(v); ln.veh.splice(i, 1); best.veh.push(v);
        v.lc0 = this.lcOffset(v) + (ln.lat - best.lat) * ln.dir * best.dir; v.lcN = this.n; v.lane = best; v.lcCool = this.n + Math.floor((6 + R.next() * 6) * LIFE.trafficHz);
        v.still = 0; v.next = this.pickNext(best, v, R);
      }
    }
  }
  // lateral offset still left from a lane change, at step position n (fractional)
  lcOffset(v, n = this.n) { const u = (n - v.lcN) / (3 * LIFE.trafficHz); if (u >= 1 || u < 0) return 0; const f = 1 - u; return v.lc0 * f * f * (3 - 2 * f); }
  // world pose of vehicle v at interpolation alpha in [0,1] between the last two steps
  pose(v, alpha, o = {}) {
    const ln = v.lane, s = v.jumped ? v.s : v.ps + (v.s - v.ps) * alpha, P = this._p || (this._p = {});
    ln.base.at(this.toBase(ln, s), P);
    let lat = ln.lat, dlat = 0;
    if (ln.shared && v.type === 'scooter') {   // alley weave: a parabolic sine (integer-free arithmetic only, no Math.sin: native #3)
      let u = s / 56.5 + v.weave; u -= Math.floor(u); u = 2 * u - 1;           // [-1, 1), one wiggle per 56.5 m
      lat += ln.dir * 0.45 * 4 * u * (1 - Math.abs(u));
    }
    if (v.lcN > -1e8) {   // easing out of a lane change: offset and the yaw that goes with it
      const n = this.n - 1 + (v.jumped ? 1 : alpha), o0 = this.lcOffset(v, n);
      if (o0) { lat += o0; dlat = (this.lcOffset(v, n + 1) - o0) * LIFE.trafficHz / Math.max(1, v.v); }
    }
    let x = P.x + P.nx * lat, z = P.z + P.nz * lat, hx = P.tx * ln.dir + P.nx * dlat, hz = P.tz * ln.dir + P.nz * dlat;
    if (dlat) { const l = Math.hypot(hx, hz) || 1; hx /= l; hz /= l; }
    if (v.jx || v.jz || v.jhx || v.jhz) {   // ease out of a junction hand-off over 12 m
      const f = s < 12 ? (1 - Math.max(0, s) / 12) ** 2 : 0;
      x += v.jx * f; z += v.jz * f; hx += v.jhx * f; hz += v.jhz * f; const l = Math.hypot(hx, hz) || 1; hx /= l; hz /= l;
    }
    o.x = x; o.z = z; o.hx = hx; o.hz = hz; o.v = v.v; o.hidden = v.hidden;
    return o;
  }
}

// ---------------------------------------------------------------- crowd
const P_WALK = 0, P_PHONE = 1, P_IDLE = 2, P_SIT = 3, P_TALK = 4;
const M_WALK = 0, M_FOLLOW = 1, M_STAND = 2, M_SEAT = 3, M_CROSS = 4;
export class CrowdSim {
  constructor(net, layout, { seed = 1, density = 1, maxAgents = LIFE.maxAgents, traffic = null } = {}) {
    this.net = net; this.layout = layout; this.seed = seed >>> 0; this.density = density; this.maxAgents = maxAgents; this.traffic = traffic;
    this.dt = 1 / LIFE.crowdHz;
    // walkways
    this.ways = [];
    for (const st of net.streets) {
      if (st.kind === 'main') {
        st.walk.forEach((band, i) => {
          if (!band) return; const side = i ? 1 : -1, mid = (band[0] + band[1]) / 2, hw = (band[1] - band[0]) / 2;
          this.ways.push({ id: `${st.id}:${side > 0 ? 'R' : 'L'}`, street: st, base: st.path, c: side * mid, dmin: -hw, dmax: hw, s0: 0, s1: st.path.len, kind: 'main', side });
        });
      } else {
        const r = clearRange(st.path, net.mains, (m) => m.carHalf + 0.3);
        if (r[1] - r[0] < 3) continue;
        this.ways.push({ id: `${st.id}:W`, street: st, base: st.path, c: 0, dmin: -st.walkHalf, dmax: st.walkHalf, s0: r[0], s1: r[1], kind: st.kind, side: 0 });
      }
    }
    // junctions: each walkway end -> the walkways it touches
    const o = {};
    for (const w of this.ways) {
      w.ends = [w.s0, w.s1].map((s) => {
        w.base.at(s, o); const x = o.x + o.nx * w.c, z = o.z + o.nz * w.c, out = [];
        for (const u of this.ways) {
          if (u === w) continue; const pr = u.base.project(x, z), d = pr.d - u.c;
          if (pr.s >= u.s0 - 1 && pr.s <= u.s1 + 1 && d > u.dmin - 3.5 && d < u.dmax + 3.5) out.push({ way: u, s: Math.min(u.s1 - 0.5, Math.max(u.s0 + 0.5, pr.s)), d: Math.min(u.dmax, Math.max(u.dmin, d)) });
        }
        return out;
      });
    }
    this.boundaryEnds = [];
    this.ways.forEach((w) => w.ends.forEach((e, k) => { if (!e.length) this.boundaryEnds.push({ way: w, k }); }));
    // frontage spots (chatting groups, club queues, pocha tables)
    this.lots = (layout.lots || []).filter((l) => l.frontage && l.frontage.length === 2);
    this.reset();
  }
  reset() {
    const R = this.R = new Rng(this.seed ^ 0xc0ffee), A = this.agents = [];
    this.n = 0; this.groups = [];
    const D = LIFE.density;
    // budgets: walkway area x density, then frontage people, then crossers; scaled to maxAgents
    const wayN = this.ways.map((w) => Math.max(0, (w.s1 - w.s0) * (w.dmax - w.dmin) * (D[w.kind] ?? D.alley) * (LIFE.priority[w.kind] ?? 0.35) * this.density));
    const frontN = this.lots.map((l) => (l.use === 'club' ? 12 : l.use === 'pocha' ? 10 : ['conv', 'bar', 'karaoke', 'pc', 'cafe'].includes(l.use) ? 3 : 1.2) * this.density);
    const crossN = this.net.crossings.map((c) => (c.kind === 'T' ? 30 : 12) * this.density);
    const tot = [...wayN, ...frontN, ...crossN].reduce((a, b) => a + b, 0);
    const k = tot > this.maxAgents ? 0.93 * this.maxAgents / tot : 1;   // 0.93: groups round up
    this.ways.forEach((w, i) => {
      let n = Math.round(wayN[i] * k);
      while (n > 0) {
        const gs = R.next() < LIFE.groupShare ? 2 + Math.floor(R.next() * R.next() * 3.2) : 1, s = w.s0 + R.next() * (w.s1 - w.s0);
        const dir = R.next() < 0.5 ? 1 : -1, lead = this.newAgent(R, M_WALK, w, s, 0, dir);
        lead.dPref = this.prefD(w, dir, R); lead.d = lead.dPref;
        if (gs > 1) { lead.gsize = gs; lead.v *= 0.9; for (let g = 1; g < gs; g++) { const f = this.newAgent(R, M_FOLLOW, w, s, 0, dir); f.lead = lead; f.slot = (g % 2 ? 1 : -1) * Math.ceil(g / 2) * 0.62; f.sOff = (R.next() - 0.5) * 0.5; f.pose = R.next() < 0.1 ? P_PHONE : P_WALK; } }
        n -= gs;
      }
    });
    // frontage people
    this.lots.forEach((l, i) => {
      let n = Math.round(frontN[i] * k); if (n <= 0) return;
      const [a, b] = l.frontage, fx = b[0] - a[0], fz = b[1] - a[1], fl = Math.hypot(fx, fz) || 1, tx = fx / fl, tz = fz / fl;
      // street side = the side of the frontage away from the footprint centroid
      let cx = 0, cz = 0; l.footprint.forEach((p) => { cx += p[0]; cz += p[1]; }); cx /= l.footprint.length; cz /= l.footprint.length;
      let nx = -tz, nz = tx; if ((cx - a[0]) * nx + (cz - a[1]) * nz > 0) { nx = -nx; nz = -nz; }
      if (l.use === 'club') {   // queue along the facade from the door
        const door = 0.25 + 0.5 * R.next();
        for (let q = 0; q < n; q++) {
          const u = Math.min(0.98, door + q * 0.75 / fl), x = a[0] + fx * u + nx * (0.7 + (R.next() - 0.5) * 0.25), z = a[1] + fz * u + nz * (0.7 + (R.next() - 0.5) * 0.25);
          const ag = this.newAgent(R, M_STAND, null, 0, 0, 1); ag.x = x; ag.z = z; ag.yaw = Math.atan2(-tx, -tz) + (R.next() - 0.5) * 0.8; ag.pose = R.next() < 0.45 ? P_PHONE : (R.next() < 0.5 ? P_TALK : P_IDLE);
          ag.door = q === 0;
        }
        l._door = [a[0] + fx * door + nx * 0.5, a[1] + fz * door + nz * 0.5];
      } else if (l.use === 'pocha') {   // plastic tables under the tent, 4 seats each
        l._tables = [];
        const nt = Math.max(1, Math.min(4, Math.round(n / 3)));
        for (let t = 0; t < nt; t++) {
          const u = (t + 0.5) / nt, x = a[0] + fx * u + nx * 1.6, z = a[1] + fz * u + nz * 1.6; l._tables.push([x, z]);
          const occ = 2 + Math.floor(R.next() * 3);
          for (let q = 0; q < 4; q++) {
            const ang = q * Math.PI / 2 + 0.785, sx = x + Math.cos(ang) * 0.62, sz = z + Math.sin(ang) * 0.62;
            l._tables.push({ stool: [sx, sz] });
            if (q < occ) { const ag = this.newAgent(R, M_SEAT, null, 0, 0, 1); ag.x = sx; ag.z = sz; ag.yaw = Math.atan2(x - sx, z - sz); ag.pose = P_SIT; }
          }
        }
      } else {   // a chatting cluster (or a lone smoker / phone user) off the shop door
        const u = 0.2 + 0.6 * R.next(), gx = a[0] + fx * u + nx * (1.2 + R.next()), gz = a[1] + fz * u + nz * (1.2 + R.next());
        for (let q = 0; q < n; q++) {
          const ang = (q / n) * 6.283 + R.next() * 0.5, r = n > 1 ? 0.45 + 0.1 * n : 0;
          const ag = this.newAgent(R, M_STAND, null, 0, 0, 1); ag.x = gx + Math.cos(ang) * r; ag.z = gz + Math.sin(ang) * r;
          ag.yaw = n > 1 ? Math.atan2(gx - ag.x, gz - ag.z) : Math.atan2(nx, nz) + (R.next() - 0.5) * 2; ag.pose = R.next() < 0.35 ? P_PHONE : P_TALK;
        }
      }
    });
    // crossers: bunch at the kerb, surge on the walk phase
    this.net.crossings.forEach((c, i) => {
      const n = Math.round(crossN[i] * k);
      for (let q = 0; q < n; q++) {
        const ag = this.newAgent(R, M_CROSS, null, 0, 0, 1); ag.cross = c; ag.cside = q % 2 ? 1 : -1;
        ag.cu = (R.next() - 0.5) * (c.cw - 0.8);       // across the crosswalk width
        ag.cw = 0.3 + R.next() * 2.2;                  // depth back from the kerb while waiting
        ag.cdelay = 0.3 + R.next() * R.next() * 4;     // reaction after the walk light
        ag.cp = 0;                                     // 0 waiting at cside, then progress 0..1 to -cside
        ag.v = 1.25 + R.next() * 0.35;
      }
    });
    for (const a of A) { this.place(a); a.px = a.x; a.pz = a.z; a.pyaw = a.yaw; a.pph = a.ph; }
  }
  prefD(w, dir, R) { const mid = (w.dmin + w.dmax) / 2, half = (w.dmax - w.dmin) / 2; return mid + dir * half * (0.15 + 0.7 * R.next()); }   // keep right
  newAgent(R, mode, way, s, d, dir) {
    const male = R.next() < 0.5, h = male ? 1.74 + R.gauss() * 0.06 : 1.61 + R.gauss() * 0.05;
    const a = { id: this.agents.length, mode, way, s, d, dir, v: Math.max(0.7, 1.18 + R.gauss() * 0.17), vc: 0, ph: R.next(), pose: R.next() < LIFE.phoneShare ? P_PHONE : P_WALK,
      x: 0, z: 0, yaw: 0, px: 0, pz: 0, pyaw: 0, pph: 0, walkAmt: 1, scale: h / 1.7, wide: male ? 1.05 : 0.92, look: lookFor(R, male), gsize: 1, jumped: false };
    this.agents.push(a); return a;
  }
  place(a) {
    if (a.mode === M_WALK || a.mode === M_FOLLOW) {
      const w = a.way, P = this._o || (this._o = {}); w.base.at(a.s, P); const off = w.c + a.d;
      a.x = P.x + P.nx * off; a.z = P.z + P.nz * off; a.tx = P.tx * a.dir; a.tz = P.tz * a.dir;
    } else if (a.mode === M_CROSS) {
      const c = a.cross, m = c.main.path, P = this._o || (this._o = {}); m.at(c.sc, P);
      const side = a.cp > 0 ? a.cp : 0, from = a.cside * (c.halfSpan + (a.cp > 0 ? 0 : a.cw)), to = -a.cside * c.halfSpan;
      const off = a.cp > 0 ? from + (to - from) * side : from;
      a.x = P.x + P.nx * off + P.tx * a.cu; a.z = P.z + P.nz * off + P.tz * a.cu;
      a.tx = -P.nx * a.cside; a.tz = -P.nz * a.cside;
      if (a.cp === 0 && a.yaw === 0) a.yaw = Math.atan2(a.tx, a.tz);
    }
  }
  transfer(a, R) {
    const w = a.way, k = a.dir > 0 ? 1 : 0, opts = w.ends[k];
    if (opts.length && R.next() < 0.85) {
      const j = opts[Math.floor(R.next() * opts.length)], u = j.way;
      a.way = u; a.s = j.s; a.dir = j.s - u.s0 < 3 ? 1 : u.s1 - j.s < 3 ? -1 : (R.next() < 0.5 ? 1 : -1); a.d = j.d;
      a.dPref = this.prefD(u, a.dir, R);
    } else if (!opts.length && this.boundaryEnds.length && R.next() < 0.9) {   // left the block: someone else walks in elsewhere
      const b = this.boundaryEnds[Math.floor(R.next() * this.boundaryEnds.length)], u = b.way;
      a.way = u; a.dir = b.k ? -1 : 1; a.s = b.k ? u.s1 - 0.3 : u.s0 + 0.3; a.dPref = this.prefD(u, a.dir, R); a.d = a.dPref; a.jumped = true;
    } else { a.dir = -a.dir; a.dPref = this.prefD(w, a.dir, R); }   // turn back
  }
  step() {
    const R = this.R, dt = this.dt, A = this.agents, t = (this.n + 1) * dt;
    for (const a of A) { a.px = a.x; a.pz = a.z; a.pyaw = a.yaw; a.pph = a.ph; a.jumped = false; }
    // per-walkway sorted lists of leaders for avoidance
    const byWay = new Map();
    for (const a of A) if (a.mode === M_WALK) { let l = byWay.get(a.way); if (!l) byWay.set(a.way, (l = [])); l.push(a); }
    // scooters / cars on shared streets, in centre-line coordinates
    const veh = new Map();
    if (this.traffic) {
      const T = this.traffic, P = {};
      for (const v of T.vehicles) {
        const ln = v.lane; if (!ln.shared || v.hidden) continue;
        const sb = T.toBase(ln, v.s); T.pose(v, 1, P);
        let l = veh.get(ln.street); if (!l) veh.set(ln.street, (l = []));
        const pr = ln.base.project(P.x, P.z); l.push({ s: sb, d: pr.d, dir: ln.dir, v: v.v });
      }
    }
    for (const [w, L] of byWay) {
      L.sort((p, q) => p.s - q.s);
      const vl = veh.get(w.street) || null;
      for (let i = 0; i < L.length; i++) {
        const a = L[i], wa = 0.32 * a.gsize + 0.25;
        let vt = a.v, shift = 0;
        // neighbours within 4 m along s
        for (let j = i + 1; j < L.length && L[j].s - a.s < 4; j++) shift += this.avoid(a, L[j], wa);
        for (let j = i - 1; j >= 0 && a.s - L[j].s < 4; j--) shift += this.avoid(a, L[j], wa);
        if (a._slow) { vt = Math.min(vt, a._slow); a._slow = 0; }
        // vehicles: step aside
        if (vl) for (const v of vl) {
          const ds = (a.s - v.s) * v.dir; if (ds < -2 || ds > 9) continue;
          const dd = a.d + w.c - v.d; if (Math.abs(dd) < 1.3) shift += (dd >= 0 ? 1 : -1) * 0.35, vt = Math.min(vt, 0.6);
        }
        // drift to preferred keep-right line
        shift += (a.dPref - a.d) * 0.08;
        a.d += Math.max(-0.12, Math.min(0.12, shift));
        const half = (a.gsize - 1) * 0.31;
        a.d = Math.max(w.dmin + half, Math.min(w.dmax - half, a.d));
        a.vc += (vt - a.vc) * 0.3;
        a.s += a.dir * a.vc * dt;
        a.ph = (a.ph + a.vc * dt / (1.45 * a.scale)) % 1;
        if (a.s < w.s0 || a.s > w.s1) this.transfer(a, R);
        // occasional pose change
        if (R.next() < 0.002) a.pose = R.next() < LIFE.phoneShare ? P_PHONE : P_WALK;
        this.place(a);
      }
    }
    for (const a of A) {
      if (a.mode === M_FOLLOW) {
        const L = a.lead, ow = a.way; a.way = L.way; a.dir = L.dir; a.s = L.s - L.dir * a.sOff;
        a.d = Math.max(L.way.dmin, Math.min(L.way.dmax, L.d + a.slot * L.dir));
        if (ow !== a.way) a.jumped = L.jumped;
        a.s = Math.max(a.way.s0, Math.min(a.way.s1, a.s)); a.vc = L.vc; a.ph = (a.ph + a.vc * dt / (1.45 * a.scale)) % 1; a.walkAmt = 1;
        this.place(a);
      } else if (a.mode === M_CROSS) this.stepCross(a, t, dt, R);
      else if (a.mode === M_STAND || a.mode === M_SEAT) {
        a.walkAmt = 0; a.ph = (a.ph + dt * 0.11) % 1;   // idle cycle ~9 s (weight shift, gestures)
        if (a.mode === M_STAND && R.next() < 0.0015) a.pose = a.pose === P_PHONE ? P_TALK : (R.next() < 0.5 ? P_PHONE : P_TALK);
      }
      if (a.mode === M_WALK || a.mode === M_FOLLOW || a.mode === M_CROSS) {
        const mx = a.x - a.px, mz = a.z - a.pz, m = Math.hypot(mx, mz);
        const hx = m > 0.02 ? mx / m : a.tx, hz = m > 0.02 ? mz / m : a.tz;
        if (a.mode !== M_CROSS || a.cp > 0) { const ty = Math.atan2(hx, hz); let dy = ty - a.yaw; dy -= Math.round(dy / 6.283185307) * 6.283185307; a.yaw += dy * 0.45; }
        a.walkAmt = Math.min(1, a.vc / 0.9);
      }
    }
    this.n++;
  }
  avoid(a, b, wa) {
    const ds = (b.s - a.s) * a.dir; if (ds <= 0) return 0;           // only what is ahead
    const wb = 0.32 * b.gsize + 0.25, dd = b.d - a.d;
    if (Math.abs(dd) > wa + wb) return 0;
    if (b.dir !== a.dir) return ds < 4 ? -Math.sign(a.dir) * 0.09 * (1 - ds / 4) * (dd * a.dir > 0 ? 1.4 : 1) : 0;   // head-on: both go to their right
    if (b.v < a.v - 0.05 && ds < 2.2) {                              // slower ahead: pass on the left if there is room, else slow
      const w = a.way, left = a.d - a.dir * (wa + wb + 0.2);
      if (left > w.dmin && left < w.dmax) return -a.dir * 0.12;
      a._slow = Math.min(a._slow || 9, b.vc);
    }
    return 0;
  }
  stepCross(a, t, dt, R) {
    const c = a.cross, ph = crossPhase(c, t);
    const span = 2 * c.halfSpan;
    if (a.cp === 0) {   // waiting
      a.vc = 0; a.walkAmt = 0; a.ph = (a.ph + dt * 0.11) % 1;
      if (ph.walk && ph.tc - ph.w0 > a.cdelay && ph.tc - ph.w0 < ph.wlen - span / a.v) { a.cp = 1e-4; a.cs = (R.next() - 0.5) * 0.6; }
      const ty = Math.atan2(a.tx, a.tz); let dy = ty - a.yaw; dy -= Math.round(dy / 6.283185307) * 6.283185307; a.yaw += dy * 0.2;
      a.pose = a.pose === P_SIT ? P_IDLE : a.pose;
    } else {
      a.vc += (a.v - a.vc) * 0.4;
      a.cp += a.vc * dt / span; a.ph = (a.ph + a.vc * dt / (1.45 * a.scale)) % 1;
      a.cu += a.cs * dt * 0.3;
      if (a.cp >= 1) { a.cp = 0; a.cside = -a.cside; a.cw = 0.3 + R.next() * 2.2; a.cu = Math.max(-(c.cw - 0.8) / 2, Math.min((c.cw - 0.8) / 2, a.cu)); a.vc = 0; a.jumped = false; this.place(a); a.cdelay = 0.3 + R.next() * R.next() * 4; return; }
    }
    this.place(a);
  }
}

// appearance (sRGB). November in Seoul: long padded coats, black/charcoal/beige, a few white puffers
const TOPS = [[0.03, 0.03, 0.035], [0.03, 0.03, 0.035], [0.05, 0.05, 0.055], [0.12, 0.12, 0.13], [0.2, 0.2, 0.21], [0.07, 0.09, 0.16], [0.55, 0.47, 0.36], [0.62, 0.52, 0.38], [0.47, 0.34, 0.22], [0.82, 0.82, 0.8], [0.88, 0.86, 0.82], [0.25, 0.27, 0.2], [0.35, 0.08, 0.1], [0.75, 0.7, 0.62], [0.4, 0.4, 0.42], [0.15, 0.2, 0.3]];
const BOTTOMS = [[0.03, 0.03, 0.035], [0.04, 0.04, 0.05], [0.08, 0.1, 0.17], [0.16, 0.22, 0.33], [0.25, 0.3, 0.42], [0.5, 0.45, 0.36], [0.2, 0.2, 0.21], [0.75, 0.74, 0.7]];
const HAIR = [[0.02, 0.018, 0.016], [0.02, 0.018, 0.016], [0.04, 0.03, 0.025], [0.09, 0.06, 0.04], [0.16, 0.11, 0.07], [0.3, 0.25, 0.2], [0.6, 0.52, 0.4], [0.12, 0.1, 0.12]];
const SKIN = [[0.83, 0.66, 0.55], [0.8, 0.62, 0.5], [0.75, 0.57, 0.45], [0.86, 0.7, 0.6], [0.68, 0.5, 0.38]];
function lookFor(R, male) {
  const pick = (A) => A[Math.floor(R.next() * A.length)];
  const coat = R.next() < (male ? 0.4 : 0.5) ? 1 : 0, bag = R.next() < (male ? 0.25 : 0.6) ? 1 : 0, cap = R.next() < 0.12 ? 1 : 0;
  return { top: pick(TOPS), bottom: pick(BOTTOMS), hair: cap ? [0.03, 0.03, 0.03] : pick(HAIR), skin: pick(SKIN), coat, bag, longHair: !male && R.next() < 0.7 ? 1 : 0, umb: 0 };
}

export class LifeSim {
  constructor(layout, { seed = 1, density = 1, maxAgents } = {}) {
    this.net = buildNetwork(layout);
    this.traffic = new TrafficSim(this.net, { seed });
    this.crowd = new CrowdSim(this.net, layout, { seed, density, maxAgents, traffic: this.traffic });
    this.t = 0;
  }
  reset() { this.traffic.reset(); this.crowd.reset(); this.t = 0; }
  // advance both sims to take clock t (s). A rewind re-simulates from 0 (replays restart at 0, so that is cheap).
  advanceTo(t) {
    t = Math.max(0, t);
    const nt = Math.floor(t * LIFE.trafficHz + 1e-9), nc = Math.floor(t * LIFE.crowdHz + 1e-9);
    if (nt < this.traffic.n || nc < this.crowd.n) this.reset();
    while (this.traffic.n < nt) this.traffic.step();
    while (this.crowd.n < nc) this.crowd.step();
    this.t = t;
    this.aT = t * LIFE.trafficHz - (this.traffic.n - 1); this.aC = t * LIFE.crowdHz - (this.crowd.n - 1);
    if (this.traffic.n === 0) this.aT = 1; if (this.crowd.n === 0) this.aC = 1;
    this.aT = Math.min(1, Math.max(0, this.aT)); this.aC = Math.min(1, Math.max(0, this.aC));
  }
  // take-tick entry point (240 Hz): t = tick / 240
  stepTick(tick) { this.advanceTo(tick / 240); }
  // kinematic vehicle boxes at take clock t: [{ id, type, c:[x,y,z], half:[hw,hh,hl], h:[hx,hz] }]
  boxesAt(t, out = []) {
    this.advanceTo(t); out.length = 0; const P = {};
    for (const v of this.traffic.vehicles) {
      const p = this.traffic.pose(v, this.aT, P); if (p.hidden) continue;
      out.push({ id: v.id, type: v.type, c: [p.x, v.H / 2, p.z], half: [v.W / 2, v.H / 2, v.L / 2], h: [p.hx, p.hz] });
    }
    return out;
  }
  // sphere (p:[x,y,z], r) vs the vehicle boxes at t -> null | { id, n:[x,y,z], depth, vel:[x,y,z] }
  hit(p, r, t) {
    const B = this.boxesAt(t, this._bx || (this._bx = [])); let best = null;
    for (const b of B) {
      const dx = p[0] - b.c[0], dy = p[1] - b.c[1], dz = p[2] - b.c[2];
      const lz = dx * b.h[0] + dz * b.h[1], lx = dx * b.h[1] - dz * b.h[0];   // local: z along heading, x right
      const cx = Math.max(-b.half[0], Math.min(b.half[0], lx)), cy = Math.max(-b.half[1], Math.min(b.half[1], dy)), cz = Math.max(-b.half[2], Math.min(b.half[2], lz));
      const ex = lx - cx, ey = dy - cy, ez = lz - cz, d2 = ex * ex + ey * ey + ez * ez;
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2) || 1e-6, depth = r - d;
      if (best && depth <= best.depth) continue;
      const nlx = ex / d, nly = ey / d, nlz = ez / d;
      const v = this.traffic.vehicles.find((q) => q.id === b.id);
      best = { id: b.id, type: b.type, depth, n: [nlx * b.h[1] + nlz * b.h[0], nly, -nlx * b.h[0] + nlz * b.h[1]], vel: [b.h[0] * v.v, 0, b.h[1] * v.v] };
    }
    return best;
  }
  // a hash of the full traffic state (replay parity checks)
  hash() {
    let h = 2166136261 >>> 0; const f = new Float64Array(1), u = new Uint32Array(f.buffer);
    for (const v of this.traffic.vehicles) { for (const x of [v.s, v.v]) { f[0] = x; h = Math.imul(h ^ u[0], 16777619) >>> 0; h = Math.imul(h ^ u[1], 16777619) >>> 0; } h = Math.imul(h ^ (v.id + 1), 16777619) >>> 0; }
    return h.toString(16);
  }
}

// ================================================================ rendering
const lin = (c) => c.map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));

// ---- procedural human. Bones: 0 pelvis/torso, 1 head, 2 L thigh, 3 L shin, 4 R thigh, 5 R shin,
//      6 L upper arm, 7 L forearm, 8 R upper arm, 9 R forearm, 10 phone (R hand), 11 coat skirt, 12 umbrella
// Regions: 0 skin, 1 hair, 2 top, 3 bottom, 4 shoes, 5 phone screen, 6 bag, 7 umbrella
function buildHumanGeo(lod) {
  const P = [], N = [], B = [], G = [];
  const rs = [9, 5, 3][lod], hs = [8, 4, 2][lod];
  // ring-stack primitive: list of [y, rx, rz, cx, cz]; region fn(y, angle) -> region
  function tube(rings, bone, region, closeTop = false, closeBot = false) {
    const base = P.length / 3, nr = rings.length;
    for (let i = 0; i < nr; i++) {
      const [y, rx, rz, cx = 0, cz = 0] = rings[i];
      for (let k = 0; k < rs; k++) {
        const a = (k / rs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        P.push(cx + ca * rx, y, cz + sa * rz);
        const dy = i === 0 ? rings[1][0] - y : y - rings[i - 1][0], dr = i === 0 ? rings[1][1] - rx : rx - rings[i - 1][1];
        const ny = -dr / (Math.abs(dy) + 1e-6) * 0.5; const l = Math.hypot(ca, ny, sa); N.push(ca / l, ny / l, sa / l);
        B.push(bone); G.push(typeof region === 'function' ? region(y, a) : region);
      }
    }
    const idx = [];
    for (let i = 0; i < nr - 1; i++) for (let k = 0; k < rs; k++) {
      const a = base + i * rs + k, b = base + i * rs + ((k + 1) % rs), c = a + rs, d = b + rs;
      idx.push(a, c, b, b, c, d);
    }
    const cap = (i, up) => { const [y, , , cx = 0, cz = 0] = rings[i]; const ci = P.length / 3; P.push(cx, y, cz); N.push(0, up ? 1 : -1, 0); B.push(bone); G.push(typeof region === 'function' ? region(y, 0) : region); for (let k = 0; k < rs; k++) { const a = base + i * rs + k, b = base + i * rs + ((k + 1) % rs); up ? idx.push(ci, b, a) : idx.push(ci, a, b); } };
    if (closeTop) cap(nr - 1, true); if (closeBot) cap(0, false);
    return idx;
  }
  function box(x0, y0, z0, x1, y1, z1, bone, region) {
    const base = P.length / 3, idx = [];
    const f = [[[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]], [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
      [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]], [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
      [[0, 0, 1], [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]]], [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]]];
    let q = 0;
    for (const [n, vs] of f) { for (const v of vs) { P.push(...v); N.push(...n); B.push(bone); G.push(typeof region === 'function' ? region(n) : region); } const o = base + q * 4; idx.push(o, o + 1, o + 2, o, o + 2, o + 3); q++; }
    return idx;
  }
  const I = [];
  const add = (a) => { for (const v of a) I.push(v); };
  // legs (x = +-0.095), hip pivot y 0.9, knee 0.48
  for (const [sx, th, sh] of [[0.095, 2, 3], [-0.095, 4, 5]]) {
    add(tube([[0.9, 0.078, 0.082, sx, 0], [0.7, 0.068, 0.07, sx, 0.005], [0.5, 0.055, 0.058, sx, 0.01]], th, 3));
    add(tube([[0.5, 0.055, 0.058, sx, 0.01], [0.32, 0.05, 0.055, sx, -0.005], [0.1, 0.038, 0.042, sx, 0]], sh, (y) => (y < 0.15 ? 4 : 3)));
    if (lod < 2) add(box(sx - 0.048, 0, -0.06, sx + 0.048, 0.085, 0.17, sh, 4));
  }
  // pelvis + torso (back is -z, chest +z), shoulders y 1.39
  add(tube([[0.84, 0.15, 0.105], [0.98, 0.16, 0.105], [1.12, 0.155, 0.11], [1.3, 0.18, 0.12], [1.39, 0.2, 0.105], [1.44, 0.1, 0.07]], 0, (y) => (y < 0.97 ? 3 : 2), true, true));
  // head + neck
  add(tube([[1.42, 0.05, 0.05, 0, 0.01], [1.5, 0.05, 0.05, 0, 0.01]], 1, 0));
  {
    const base = P.length / 3, cy = 1.6, R = [0.085, 0.112, 0.1], idx = [];
    for (let i = 0; i <= hs; i++) for (let k = 0; k < rs; k++) {
      const th = (i / hs) * Math.PI, a = (k / rs) * Math.PI * 2, x = Math.sin(th) * Math.cos(a), y = Math.cos(th), z = Math.sin(th) * Math.sin(a);
      P.push(x * R[0], cy + y * R[1], z * R[2] + 0.01); N.push(x, y, z); B.push(1); G.push(y > 0.25 || (z < -0.25 && y > -0.6) ? 1 : 0);
    }
    for (let i = 0; i < hs; i++) for (let k = 0; k < rs; k++) { const a = base + i * rs + k, b = base + i * rs + ((k + 1) % rs), c = a + rs, d = b + rs; idx.push(a, b, c, b, d, c); }
    add(idx);
  }
  // arms: shoulder pivot (+-0.2, 1.38), elbow y 1.1, wrist 0.86
  for (const [sx, ua, fa] of [[0.205, 6, 7], [-0.205, 8, 9]]) {
    add(tube([[1.41, 0.05, 0.052, sx, 0], [1.25, 0.046, 0.048, sx, 0], [1.1, 0.042, 0.044, sx, 0.005]], ua, 2, true));
    add(tube([[1.1, 0.042, 0.044, sx, 0.005], [0.9, 0.035, 0.036, sx, 0.01], [0.86, 0.032, 0.03, sx, 0.01], [0.77, 0.022, 0.03, sx, 0.015]], fa, (y) => (y < 0.875 ? 0 : 2), false, true));
  }
  // phone in the right hand (screen faces the body); far LOD: no phone, coat, bag
  if (lod < 2) add(box(-0.24, 0.8, 0.0, -0.17, 0.95, 0.012, 10, (n) => (n[0] === 0 && n[2] === 0 && n[1] === 0 ? 5 : n[2] < 0 ? 5 : 6)));
  // long coat skirt (hidden unless coat), hip to knee
  if (lod < 2) add(tube([[0.98, 0.17, 0.115], [0.75, 0.2, 0.145], [0.5, 0.215, 0.16]], 11, 2, false, false));
  // shoulder bag on the left hip
  if (lod < 2) add(box(0.17, 0.86, -0.08, 0.235, 1.07, 0.1, 0, 6));
  // umbrella (rain mode): canopy cone over the head on a shaft
  if (!lod) add(tube([[1.95, 0.5, 0.5, 0, 0.15], [2.1, 0.25, 0.25, 0, 0.15], [2.16, 0.01, 0.01, 0, 0.15]], 12, 7));
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('bone', new THREE.Float32BufferAttribute(B, 1));
  g.setAttribute('region', new THREE.Float32BufferAttribute(G, 1));
  g.setIndex(I);
  return g;
}

const HUMAN_VS = /* glsl */`
attribute float bone;
attribute float region;
attribute vec4 iPos;    // x, y, z, yaw
attribute vec4 iAnim;   // phase, walk amount, pose, height scale
attribute vec4 iTop;    // top rgb, coat flag
attribute vec4 iBot;    // bottom rgb, bag flag
attribute vec4 iHair;   // hair rgb, width scale
attribute vec4 iSkin;   // skin rgb, umbrella flag
attribute vec4 iFill;   // fill rgb (lux, linear), dir angle
varying vec3 vAlb;
varying vec3 vFillE;
varying float vScreen;
uniform float uTime;
uniform float uNit;
vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
// rotate p (y,z) about pivot (py,pz) by forward angle a (positive swings the limb end forward = +z)
vec3 swing(vec3 p, float py, float pz, float a) { vec2 q = rot(vec2(p.z - pz, p.y - py), -a); return vec3(p.x, py + q.y, pz + q.x); }
vec3 swingN(vec3 n, float a) { vec2 q = rot(vec2(n.z, n.y), -a); return vec3(n.x, q.y, q.x); }
`;
const HUMAN_ANIM = /* glsl */`
  float ph = iAnim.x * 6.2831853, wa = iAnim.y, pose = iAnim.z, hs = iAnim.w;
  float sitP = step(2.5, pose) * step(pose, 3.5), phoneP = step(0.5, pose) * step(pose, 1.5), talkP = step(3.5, pose);
  float idleCyc = sin(iAnim.x * 6.2831853 + float(gl_InstanceID));
  vec3 p = position, nrm = normal;
  // hide what this person doesn't have
  float hide = 0.0;
  if (bone > 9.5 && bone < 10.5) hide = 1.0 - phoneP;
  if (bone > 10.5 && bone < 11.5) hide = 1.0 - iTop.w;
  if (bone > 11.5) hide = 1.0 - iSkin.w;
  if (region > 5.5 && region < 6.5 && bone < 0.5) hide = 1.0 - iBot.w;
  // limb angles: walking gait
  float hipA = 0.42 * wa * sin(ph);
  float kneeL = wa * (0.08 + 0.7 * pow(max(0.0, cos(ph + 0.35)), 1.6)) + (1.0 - wa) * 0.03;
  float kneeR = wa * (0.08 + 0.7 * pow(max(0.0, cos(ph + 3.14159 + 0.35)), 1.6)) + (1.0 - wa) * 0.03;
  float armA = -0.32 * wa * sin(ph), elb = 0.22 + 0.12 * wa;
  float hL = hipA, hR = -hipA, sL = -armA, sR = armA, eL = elb, eR = elb, headP = 0.0;
  // idle: weight shift + small gestures when talking
  hL += (1.0 - wa) * 0.04 * idleCyc; hR -= (1.0 - wa) * 0.03 * idleCyc;
  sL += talkP * (1.0 - wa) * 0.15 * max(0.0, sin(uTime * 1.3 + float(gl_InstanceID) * 1.7)); eL += talkP * (1.0 - wa) * 0.9 * max(0.0, sin(uTime * 1.3 + float(gl_InstanceID) * 1.7));
  // phone: right forearm up in front, head down
  sR = mix(sR, 0.35, phoneP); eR = mix(eR, 1.45, phoneP); headP += 0.38 * phoneP;
  // umbrella: right arm up, holding the shaft
  sR = mix(sR, 0.7, iSkin.w); eR = mix(eR, 1.2, iSkin.w);
  // sit
  hL = mix(hL, 1.45, sitP); hR = mix(hR, 1.35, sitP); kneeL = mix(kneeL, 1.5, sitP); kneeR = mix(kneeR, 1.4, sitP);
  sL = mix(sL, 0.5, sitP); sR = mix(sR, 0.55 + 0.25 * phoneP, sitP); eL = mix(eL, 1.1, sitP); eR = mix(eR, 1.3, sitP);
  // skeleton (proportions scale with hs; joint pivots in rest space)
  if (bone > 1.5 && bone < 5.5) {
    bool left = bone < 3.5; float hip = left ? hL : hR, kn = left ? kneeL : kneeR;
    if (bone == 3.0 || bone == 5.0) { p = swing(p, 0.48, 0.01, -kn); nrm = swingN(nrm, -kn); }
    p = swing(p, 0.9, 0.0, hip); nrm = swingN(nrm, hip);
  } else if (bone > 5.5 && bone < 10.5) {
    bool left = bone < 7.5; float sh = left ? sL : sR, el = left ? eL : eR;
    if (bone == 7.0 || bone == 9.0 || bone == 10.0) { p = swing(p, 1.1, 0.005, el); nrm = swingN(nrm, el); }
    p = swing(p, 1.38, 0.0, sh); nrm = swingN(nrm, sh);
  } else if (bone > 0.5 && bone < 1.5) {
    p = swing(p, 1.46, 0.0, headP); nrm = swingN(nrm, headP);
  } else if (bone > 10.5 && bone < 11.5) {   // coat follows the thighs a little
    float sw = 0.35 * hipA * sign(p.x) * smoothstep(0.95, 0.5, p.y);
    p.z += sw * (0.95 - p.y);
    p = mix(p, swing(p, 0.9, 0.0, 1.4), sitP);
  }
  // pelvis drop when sitting (seat 0.45), gait bob and sway
  float bob = wa * 0.022 * cos(2.0 * ph) - sitP * 0.47;
  p.y += bob; p.x += wa * 0.018 * sin(ph);
  p.x *= iHair.w;
  p *= hs;
  p *= 1.0 - hide;
  float yaw = iPos.w; vec2 xz = rot(vec2(p.z, p.x), yaw); p = vec3(xz.y, p.y, xz.x) + iPos.xyz;
  vec2 nxz = rot(vec2(nrm.z, nrm.x), yaw); nrm = vec3(nxz.y, nrm.y, nxz.x);
  // albedo by region
  vec3 alb = region < 0.5 ? iSkin.rgb : region < 1.5 ? iHair.rgb : region < 2.5 ? iTop.rgb : region < 3.5 ? (bone > 1.5 && bone < 5.5 && iTop.w > 0.5 && position.y > 0.62 ? iTop.rgb : iBot.rgb)
    : region < 4.5 ? vec3(0.03) : region < 5.5 ? vec3(0.02) : region < 6.5 ? vec3(0.04, 0.035, 0.03) : vec3(0.02, 0.02, 0.025);
  vAlb = alb;
  vScreen = (region > 4.5 && region < 5.5) ? phoneP : 0.0;
  // shopfront fill (lux) arriving from direction iFill.w, wrapped diffuse + a weak overhead/street term
  vec3 L = vec3(sin(iFill.w), 0.25, cos(iFill.w));
  float wrap = max(0.0, (dot(normalize(nrm), normalize(L)) + 0.35) / 1.35);
  float top = max(0.0, nrm.y) * 0.35 + 0.15;
  vFillE = iFill.rgb * (wrap * 0.85 + top * 0.3) * uNit / 3.14159;
`;

// ---- vehicles. Parts: 0 paint, 1 glass, 2 black (tyres, trim), 3 headlight, 4 taillight, 5 interior glow (bus),
//      6 roof sign / destination LED, 7 indicator (amber), 8 rider (scooter), 9 delivery box
function vehicleGeo(type) {
  const P = [], N = [], C = [], I = [];
  const box = (x0, y0, z0, x1, y1, z1, part, taper = 0) => {   // z forward; taper narrows the top face in x
    const b = P.length / 3, t = taper;
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0 + t, y1, z0], [x1 - t, y1, z0], [x1 - t, y1, z1], [x0 + t, y1, z1]];
    const F = [[0, 1, 2, 3, [0, -1, 0]], [7, 6, 5, 4, [0, 1, 0]], [3, 2, 6, 7, [0, 0, 1]], [1, 0, 4, 5, [0, 0, -1]], [0, 3, 7, 4, [-1, 0.2, 0]], [2, 1, 5, 6, [1, 0.2, 0]]];
    let q = 0;
    for (const f of F) { for (let k = 0; k < 4; k++) { P.push(...v[f[k]]); N.push(...f[4]); C.push(part); } const o = b + q * 4; I.push(o, o + 2, o + 1, o, o + 3, o + 2); q++; }
  };
  const wheel = (x, z, r, w) => {
    const b = P.length / 3, n = 8;
    for (let k = 0; k <= n; k++) { const a = (k / n) * Math.PI * 2, y = r + Math.sin(a) * r, zz = z + Math.cos(a) * r; P.push(x - w / 2, y, zz, x + w / 2, y, zz); N.push(0, Math.sin(a), Math.cos(a), 0, Math.sin(a), Math.cos(a)); C.push(2, 2); }
    for (let k = 0; k < n; k++) { const o = b + k * 2; I.push(o, o + 2, o + 1, o + 1, o + 2, o + 3); }
  };
  const c = VEH[type], L = c.L, W = c.W, H = c.H, hw = W / 2, hl = L / 2;
  if (type === 'car' || type === 'taxi') {
    box(-hw, 0.28, -hl, hw, 0.85, hl, 0);                                  // lower body
    box(-hw + 0.06, 0.85, -hl + 1.05, hw - 0.06, H - 0.02, hl - 1.35, 1, 0.16);   // greenhouse
    box(-hw + 0.25, H - 0.04, -hl + 1.25, hw - 0.25, H, hl - 1.55, 0);    // roof skin
    // lamps are small point-like emitters (fpv #1): projector cores 0.16 x 0.06 m in a dark housing, slim LED tail bars
    box(-hw + 0.08, 0.6, hl - 0.02, -hw + 0.42, 0.74, hl + 0.005, 2); box(hw - 0.42, 0.6, hl - 0.02, hw - 0.08, 0.74, hl + 0.005, 2);
    box(-hw + 0.17, 0.64, hl - 0.01, -hw + 0.33, 0.70, hl + 0.012, 3); box(hw - 0.33, 0.64, hl - 0.01, hw - 0.17, 0.70, hl + 0.012, 3);
    box(-hw + 0.05, 0.71, -hl - 0.01, -hw + 0.45, 0.76, -hl + 0.02, 4); box(hw - 0.45, 0.71, -hl - 0.01, hw - 0.05, 0.76, -hl + 0.02, 4);
    box(-hw - 0.01, 0.62, hl - 0.25, -hw + 0.01, 0.7, hl - 0.1, 7); box(hw - 0.01, 0.62, hl - 0.25, hw + 0.01, 0.7, hl - 0.1, 7);
    box(-hw + 0.1, 0.3, hl - 0.02, hw - 0.1, 0.5, hl + 0.02, 2); box(-hw + 0.1, 0.3, -hl - 0.02, hw - 0.1, 0.5, -hl + 0.02, 2);
    for (const z of [hl - 0.95, -hl + 0.9]) { wheel(-hw + 0.1, z, 0.33, 0.22); wheel(hw - 0.1, z, 0.33, 0.22); }
    if (type === 'taxi') box(-0.32, H, -0.25, 0.32, H + 0.2, 0.05, 6, 0.04);   // roof lamp
  } else if (type === 'truck') {
    box(-hw, 0.4, hl - 1.6, hw, 1.05, hl, 0);
    box(-hw + 0.04, 1.05, hl - 1.5, hw - 0.04, H, hl - 0.15, 1, 0.08); box(-hw, 1.05, hl - 1.6, hw, H, hl - 1.45, 0);
    box(-hw, 0.55, -hl, hw, 0.75, hl - 1.65, 0); box(-hw, 0.75, -hl, -hw + 0.05, 1.15, hl - 1.65, 0); box(hw - 0.05, 0.75, -hl, hw, 1.15, hl - 1.65, 0); box(-hw, 0.75, -hl, hw, 1.15, -hl + 0.05, 0);
    box(-hw + 0.14, 0.6, hl - 0.02, -hw + 0.3, 0.67, hl + 0.01, 3); box(hw - 0.3, 0.6, hl - 0.02, hw - 0.14, 0.67, hl + 0.01, 3);
    box(-hw + 0.05, 0.54, -hl - 0.02, -hw + 0.3, 0.6, -hl + 0.01, 4); box(hw - 0.3, 0.54, -hl - 0.02, hw - 0.05, 0.6, -hl + 0.01, 4);
    for (const z of [hl - 0.8, -hl + 1.0]) { wheel(-hw + 0.12, z, 0.3, 0.2); wheel(hw - 0.12, z, 0.3, 0.2); }
  } else if (type === 'bus') {
    box(-hw, 0.3, -hl, hw, 1.1, hl, 0);
    box(-hw, 1.1, -hl + 0.3, hw, H - 0.35, hl - 0.15, 5);                  // window band: dark glass over a 20-40 nit interior
    box(-hw, 1.1, hl - 0.15, hw, H - 0.35, hl, 1);                          // windscreen
    box(-hw, H - 0.35, -hl, hw, H, hl, 0); box(-hw, 1.1, -hl, hw, H - 0.35, -hl + 0.3, 0);
    box(-hw + 0.3, H - 0.32, hl - 0.01, hw - 0.3, H - 0.08, hl + 0.02, 6); // destination LED
    box(-hw + 0.18, 0.55, hl - 0.02, -hw + 0.38, 0.63, hl + 0.01, 3); box(hw - 0.38, 0.55, hl - 0.02, hw - 0.18, 0.63, hl + 0.01, 3);
    box(-hw + 0.1, 0.7, -hl - 0.02, -hw + 0.22, 0.95, -hl + 0.01, 4); box(hw - 0.22, 0.7, -hl - 0.02, hw - 0.1, 0.95, -hl + 0.01, 4);
    for (const z of [hl - 2.3, -hl + 2.6]) { wheel(-hw + 0.15, z, 0.48, 0.3); wheel(hw - 0.15, z, 0.48, 0.3); }
  } else {   // scooter + rider + delivery box
    box(-0.16, 0.25, -0.7, 0.16, 0.62, 0.55, 0); box(-0.12, 0.62, -0.6, 0.12, 0.72, 0.05, 2);
    box(-0.08, 0.62, 0.45, 0.08, 1.05, 0.6, 0); box(-0.32, 1.02, 0.42, 0.32, 1.06, 0.48, 2);
    box(-0.07, 0.86, 0.6, 0.07, 0.96, 0.64, 3); box(-0.08, 0.6, -0.78, 0.08, 0.68, -0.74, 4);
    box(-0.25, 0.72, -0.98, 0.25, 1.18, -0.55, 9);                          // delivery box
    box(-0.18, 0.72, -0.4, 0.18, 1.3, -0.05, 8, 0.03); box(-0.15, 1.3, -0.35, 0.15, 1.45, -0.1, 8);   // rider torso, shoulders
    box(-0.11, 1.45, -0.3, 0.11, 1.68, -0.08, 2);                           // helmet
    box(-0.2, 0.55, -0.15, -0.1, 0.75, 0.35, 8); box(0.1, 0.55, -0.15, 0.2, 0.75, 0.35, 8);   // legs
    box(-0.26, 1.1, -0.1, -0.18, 1.3, 0.42, 8); box(0.18, 1.1, -0.1, 0.26, 1.3, 0.42, 8);      // arms
    wheel(0, 0.62, 0.22, 0.11); wheel(0, -0.62, 0.22, 0.12);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N.map((v, i) => v), 3));
  g.setAttribute('part', new THREE.Float32BufferAttribute(C, 1));
  g.setIndex(I); g.computeBoundingSphere();
  return g;
}

function vehicleMaterial(nit) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.0, envMapIntensity: 0.6 });
  m.userData.uNit = nit;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNit = nit; sh.uniforms.uTimeV = m.userData.uTime || (m.userData.uTime = { value: 0 });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
attribute float part; attribute vec4 iState; varying float vPart; varying vec4 vState; varying vec3 vPaint; varying vec3 vLoc;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vPart = part; vState = iState; vLoc = position;
#ifdef USE_INSTANCING_COLOR
vPaint = instanceColor;
#else
vPaint = vec3(0.8);
#endif`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uNit; uniform float uTimeV; varying float vPart; varying vec4 vState; varying vec3 vPaint; varying vec3 vLoc;
float vh21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float pt = floor(vPart + 0.5);
vec3 alb = pt < 0.5 ? vPaint : pt < 1.5 ? vec3(0.015, 0.017, 0.02) : pt < 2.5 ? vec3(0.025) : pt < 4.5 ? vec3(0.3) : pt < 5.5 ? vec3(0.012, 0.014, 0.016) : pt < 6.5 ? vec3(0.02) : pt < 7.5 ? vec3(0.35, 0.2, 0.05) : pt < 8.5 ? vec3(0.03, 0.03, 0.035) : vec3(0.55, 0.12, 0.08);
diffuseColor.rgb = alb;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = pt < 0.5 ? 0.32 : (pt < 1.5 || (pt > 4.5 && pt < 5.5)) ? 0.06 : 0.6;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
// nits (binding table, PLAN-P2): lamps are point sources (low-beam core ~3k off-axis, tail 250, brake 1500, hazard 600);
// bodies are not emissive; the bus interior is 20-40 nits seen through dark glass, broken by window posts, seat backs
// and standing passengers; the destination LED is amber dot-matrix text (250-nit dots, ~30 % lit, so never a plate);
// the taxi roof lamp is a light box (180)
float blink = step(0.5, fract(uTimeV * 1.5 + vState.w));
vec3 e = vec3(0.0);
if (pt > 2.5 && pt < 3.5) e = vec3(1.0, 0.97, 0.92) * 3000.0 * vState.z;
else if (pt > 3.5 && pt < 4.5) e = vec3(1.0, 0.04, 0.02) * (250.0 + 1250.0 * vState.x) * vState.z;
else if (pt > 4.5 && pt < 5.5) {
  float zc = vLoc.z / 1.18, post = smoothstep(0.0, 0.06, abs(fract(zc) - 0.5) - 0.42);
  float seat = mix(0.35, 1.0, smoothstep(1.55, 1.75, vLoc.y));
  float cell = floor(zc), pax = step(0.62, vh21(vec2(cell, floor(vState.w * 97.0))));
  float body = 1.0 - pax * smoothstep(0.17, 0.12, abs(fract(zc) - 0.5)) * smoothstep(1.2, 1.4, vLoc.y) * (1.0 - smoothstep(2.3, 2.45, vLoc.y));
  e = vec3(0.95, 0.97, 1.0) * 32.0 * (1.0 - post) * seat * body;
}
else if (pt > 5.5 && pt < 6.5) {
  vec2 dot = vec2(vLoc.x * 55.0, vLoc.y * 55.0), cel = floor(dot);
  float lit = step(0.7, vh21(vec2(floor(cel.x / 5.0), cel.y))) * step(length(fract(dot) - 0.5), 0.38);
  e = (vState.w > -1.0 && abs(vLoc.z) > 1.0) ? vec3(1.0, 0.55, 0.12) * 250.0 * lit : vec3(1.0, 0.82, 0.55) * 180.0;
}
else if (pt > 6.5 && pt < 7.5) e = vec3(1.0, 0.45, 0.03) * 600.0 * vState.y * blink;
totalEmissiveRadiance += e * uNit;`);
  };
  return m;
}

// headlight pool on the asphalt: additive quad ahead of each vehicle, elongated falloff. Peak 0.6 nit: low beams lift
// lamp-lit asphalt (~1 nit at 20 lux, albedo 0.12) by at most ~1.5x (life #6; P1 drew 18-nit white wedges). ctx.pools = false
// drops them (for a light model that lights the road from the vehicle emitters itself).
function poolMaterial(nit) {
  return new THREE.ShaderMaterial({
    uniforms: { uNit: nit },
    vertexShader: `attribute vec4 iPool; varying vec2 vUv; varying float vI; void main(){ vUv = uv; vI = iPool.w; vec3 p = position; float c = cos(iPool.z), s = sin(iPool.z);
      vec3 w = vec3(c * p.x + s * p.z, 0.0, -s * p.x + c * p.z) + vec3(iPool.x, 0.03, iPool.y); gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`,
    fragmentShader: `uniform float uNit; varying vec2 vUv; varying float vI; void main(){ vec2 q = vUv * 2.0 - 1.0; float r = length(vec2(q.x * 1.0, q.y));
      float f = smoothstep(1.0, 0.0, r) * smoothstep(-1.0, -0.6, q.y); f *= f; gl_FragColor = vec4(vec3(1.0, 0.95, 0.85) * f * vI * 0.6 * uNit, 1.0); }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

// ---- shopfront fill grid (lux), from the layout's frontages, street lights, and any emitters passed in
const USE_LIGHT = {   // linear rgb, lux at 1.5 m in front of the frontage
  conv: [[0.85, 0.95, 1.0], 160], cafe: [[1.0, 0.72, 0.45], 70], club: [[0.75, 0.25, 1.0], 45], bar: [[1.0, 0.5, 0.22], 50], pocha: [[1.0, 0.42, 0.12], 90],
  karaoke: [[1.0, 0.3, 0.7], 60], pc: [[0.35, 0.65, 1.0], 55], shop: [[1.0, 0.95, 0.88], 110], restaurant: [[1.0, 0.75, 0.5], 80], motel: [[1.0, 0.3, 0.4], 30],
  office: [[0.9, 0.95, 1.0], 12], hotel: [[1.0, 0.85, 0.65], 25],
};
function buildFill(net, layout, emitters, cell = 4) {
  const b = net.bounds, nx = Math.ceil((b.x1 - b.x0) / cell), nz = Math.ceil((b.z1 - b.z0) / cell);
  const rgb = new Float32Array(nx * nz * 3), dir = new Float32Array(nx * nz * 2);
  const splat = (x, z, nX, nZ, col, lux, reach) => {   // a source facing (nX,nZ); lux at 1.5 m
    const r = Math.ceil(reach / cell), ci = Math.floor((x - b.x0) / cell), cj = Math.floor((z - b.z0) / cell);
    for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
      if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
      const cx = b.x0 + (i + 0.5) * cell, cz = b.z0 + (j + 0.5) * cell, dx = cx - x, dz = cz - z, d = Math.hypot(dx, dz) + 0.5;
      const facing = nX === 0 && nZ === 0 ? 1 : Math.max(0, (dx * nX + dz * nZ) / d + 0.15) / 1.15;
      const E = lux * facing / (1 + (d / 1.5) * (d / 1.5)) * 2.25 * Math.max(0, 1 - d / reach);
      if (E <= 0) continue; const k = (j * nx + i);
      rgb[k * 3] += col[0] * E; rgb[k * 3 + 1] += col[1] * E; rgb[k * 3 + 2] += col[2] * E;
      const w = E * (col[0] + col[1] + col[2]); dir[k * 2] -= dx / d * w; dir[k * 2 + 1] -= dz / d * w;   // points from the cell to the source
    }
  };
  for (const l of layout.lots || []) {
    if (!l.frontage) continue; const [a, c] = l.frontage, L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    let cx = 0, cz = 0; (l.footprint || [a, c]).forEach((p) => { cx += p[0]; cz += p[1]; }); cx /= (l.footprint || [a, c]).length; cz /= (l.footprint || [a, c]).length;
    let nX = -(c[1] - a[1]) / L, nZ = (c[0] - a[0]) / L; if ((cx - a[0]) * nX + (cz - a[1]) * nZ > 0) { nX = -nX; nZ = -nZ; }
    const [col, lux] = USE_LIGHT[l.use] || USE_LIGHT.shop;
    for (let u = 1; u < L; u += 3) splat(a[0] + (c[0] - a[0]) * u / L, a[1] + (c[1] - a[1]) * u / L, nX, nZ, col, lux, 14);
  }
  // street lights: LED ~4000 K along main streets every 25 m, both kerbs (~25 lux under), warm sodium-ish in alleys
  const o = {};
  for (const st of net.streets) {
    const main = st.kind === 'main', step = main ? 25 : 30;
    for (let s = 5; s < st.path.len; s += step) {
      st.path.at(s, o);
      for (const side of main ? [1, -1] : [((s / step) | 0) % 2 ? 1 : -1]) splat(o.x + o.nx * side * (st.width / 2 - 0.8), o.z + o.nz * side * (st.width / 2 - 0.8), 0, 0, main ? [1, 0.9, 0.78] : [1, 0.72, 0.42], main ? 22 : 8, main ? 18 : 12);
    }
  }
  for (const e of emitters || []) {
    if (!e.pos || !e.rgb || e.kind === 'vehicle') continue;
    const area = (e.w || 1) * (e.h || 1), I = (e.nits || 300) * area;   // E ~ L A cos / d^2 at d = 1.5 m, ground ~ half that
    splat(e.pos[0], e.pos[2], e.normal ? e.normal[0] : 0, e.normal ? e.normal[2] : 0, e.rgb, Math.min(400, I / 2.25 * 0.5), 16);
  }
  const ang = new Float32Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) ang[k] = Math.atan2(dir[k * 2], dir[k * 2 + 1]);
  return { rgb, ang, nx, nz, cell, x0: b.x0, z0: b.z0,
    at(x, z, out) { const i = Math.max(0, Math.min(nx - 1, Math.floor((x - b.x0) / cell))), j = Math.max(0, Math.min(nz - 1, Math.floor((z - b.z0) / cell))), k = j * nx + i; out[0] = rgb[k * 3]; out[1] = rgb[k * 3 + 1]; out[2] = rgb[k * 3 + 2]; out[3] = ang[k]; return out; } };
}

// ================================================================ build (contract L2)
export function build(layout, ctx = {}) {
  const seed = ctx.seed ?? 7, q = ctx.quality || 'auto';
  const maxAgents = ctx.maxAgents ?? (q === 'low' ? 1200 : LIFE.maxAgents);
  const sim = new LifeSim(layout, { seed, density: ctx.density ?? 1, maxAgents });
  const crowd = sim.crowd, traffic = sim.traffic;
  const group = new THREE.Group(); group.name = 'seoul-life';
  const nit = { value: ctx.nitScale ?? LIFE.nitScale };
  const fillK = { value: 1 };
  const uTime = { value: 0 };
  const groundAt = ctx.groundAt || (() => 0);

  // ---- people
  const fill = buildFill(sim.net, layout, ctx.emitters);
  const humanMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  humanMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime; sh.uniforms.uNit = nit; sh.uniforms.uFillK = fillK;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + HUMAN_VS)
      .replace('#include <beginnormal_vertex>', HUMAN_ANIM + '\nvec3 objectNormal = nrm;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(1.0, 0.0, 0.0);\n#endif')
      .replace('#include <begin_vertex>', 'vec3 transformed = p;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vAlb; varying vec3 vFillE; varying float vScreen; uniform float uNit; uniform float uFillK;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vAlb;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vAlb * vFillE * uFillK + vec3(0.75, 0.85, 1.0) * 220.0 * uNit * vScreen;');
  };
  humanMat.customProgramCacheKey = () => 'seoul-human';
  const tiers = [0, 1, 2].map((lod) => {
    const g = buildHumanGeo(lod), cap = [LIFE.maxNear, LIFE.maxMid, LIFE.maxDrawn][lod];
    const at = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    const A = { iPos: at(4), iAnim: at(4), iTop: at(4), iBot: at(4), iHair: at(4), iSkin: at(4), iFill: at(4) };
    for (const k in A) g.setAttribute(k, A[k]);
    g.instanceCount = 0; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const m = new THREE.Mesh(g, humanMat); m.frustumCulled = false; m.name = ['crowd-near', 'crowd-mid', 'crowd-far'][lod]; group.add(m);
    return { g, A, cap, mesh: m, tris: g.index.count / 3 };
  });
  // static per-agent appearance, linearised once
  const look = crowd.agents.map((a) => ({ top: lin(a.look.top), bot: lin(a.look.bottom), hair: lin(a.look.hair), skin: lin(a.look.skin) }));
  const umbrella = ctx.rain ? 1 : 0;
  const umbOf = crowd.agents.map((a, i) => (umbrella && a.mode !== M_SEAT && ((i * 2654435761) >>> 0) % 100 < 62 ? 1 : 0));   // ~60% under umbrellas in rain

  // ---- pocha furniture (plastic tables + stools), only if the site doesn't provide it
  if (!ctx.noFurniture) {
    const tabs = [], stools = [];
    for (const l of crowd.lots) for (const t of l._tables || []) (t.stool ? stools.push(t.stool) : tabs.push(t));
    if (tabs.length) {
      const tm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.42, 0.42, 0.04, 14).translate(0, 0.72, 0), new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.5, metalness: 0.6 }), tabs.length);
      const sm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.17, 0.44, 8).translate(0, 0.22, 0), new THREE.MeshStandardMaterial({ color: 0x1d4fb8, roughness: 0.6 }), stools.length);
      const M = new THREE.Matrix4();
      tabs.forEach((t, i) => tm.setMatrixAt(i, M.makeTranslation(t[0], groundAt(t[0], t[1]), t[1])));
      stools.forEach((t, i) => sm.setMatrixAt(i, M.makeTranslation(t[0], groundAt(t[0], t[1]), t[1])));
      tm.name = 'pocha-tables'; sm.name = 'pocha-stools'; group.add(tm, sm);
    }
  }

  // ---- vehicles
  const vMat = vehicleMaterial(nit); vMat.userData.uTime = uTime;
  const vByType = {};
  for (const ty of VTYPES) {
    const list = traffic.vehicles.filter((v) => v.type === ty);
    const cap = Math.max(4, Math.ceil(traffic.vehicles.length * (ty === 'bus' ? 0.25 : 0.7)));
    const im = new THREE.InstancedMesh(vehicleGeo(ty), vMat, cap);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const st = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); st.setUsage(THREE.DynamicDrawUsage); im.geometry.setAttribute('iState', st);
    im.count = 0; im.frustumCulled = false; im.name = 'traffic-' + ty; group.add(im);
    vByType[ty] = { im, st, cap, n: list.length };
  }
  const poolG = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  // plane in xz: x across (width 3.2 m), z ahead (length 14 m), starting at the bumper
  { const p = poolG.attributes.position; for (let i = 0; i < p.count; i++) { p.setX(i, p.getX(i) * 3.4); p.setZ(i, (p.getZ(i) + 0.5) * 14); } }
  const poolA = new THREE.InstancedBufferAttribute(new Float32Array(traffic.vehicles.length * 4), 4); poolA.setUsage(THREE.DynamicDrawUsage);
  poolG.setAttribute('iPool', poolA); poolG.instanceCount = 0;
  const pools = new THREE.Mesh(poolG, poolMaterial(nit)); pools.frustumCulled = false; pools.name = 'headlight-pools'; pools.renderOrder = 2; pools.visible = ctx.pools !== false; group.add(pools);

  // ---- L3 emitters: one front cluster + one rear cluster per vehicle (mutated in place every update)
  const emitters = [];
  const vEm = [];
  for (const v of traffic.vehicles) {
    const f = { id: `veh${v.id}:head`, pos: [0, 0, 0], normal: [0, 0, 1], w: v.W * 0.8, h: 0.15, rgb: [1, 0.97, 0.92], nits: 40000, kind: 'vehicle', animated: true, dynamic: true, beam: { cone: 0.35, range: 30 } };
    const r = { id: `veh${v.id}:tail`, pos: [0, 0, 0], normal: [0, 0, -1], w: v.W * 0.8, h: 0.15, rgb: [1, 0.04, 0.02], nits: 250, kind: 'vehicle', animated: true, dynamic: true };
    emitters.push(f, r); vEm[v.id] = [f, r];
  }

  const tmpF = [0, 0, 0, 0], M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), S1 = new THREE.Vector3(1, 1, 1), V3 = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), PO = {};
  const fwd = new THREE.Vector3(0, 0, -1);
  const hist = new Int32Array(18), ax = new Float32Array(crowd.agents.length), az = new Float32Array(crowd.agents.length), ab = new Uint8Array(crowd.agents.length);
  const stats = { agents: crowd.agents.length, vehicles: traffic.vehicles.length, near: 0, mid: 0, drawn: 0, cpuMs: 0, simMs: 0, trisNear: tiers[0].tris, trisMid: tiers[1].tris, trisFar: tiers[2].tris, lanes: traffic.lanes.length, ways: crowd.ways.length, crossings: sim.net.crossings.length };
  let clock = 0, extClock = false;
  const camP = new THREE.Vector3(0, 2, 0);

  function update(t, camPos, camQuat) {
    const c0 = performance.now();
    if (typeof t === 'number') { clock = t; extClock = true; }
    if (camPos) camP.copy(camPos);
    sim.advanceTo(clock);
    const c1 = performance.now();
    uTime.value = clock;
    if (camQuat) fwd.set(0, 0, -1).applyQuaternion(camQuat); else fwd.set(0, 0, 0);
    // ---- people: interpolate, tier by distance, cull behind the camera (FPV lenses are wide: only > ~100 deg)
    const aC = sim.aC, A = crowd.agents, nr2 = LIFE.nearR * LIFE.nearR;
    let nN = 0, nM = 0, nF = 0; const T0 = tiers[0].A, T1 = tiers[1].A, T2 = tiers[2].A, mr2 = LIFE.midR * LIFE.midR;
    // visible set + a 10 m distance histogram: the mid tier keeps the nearest maxMid
    hist.fill(0);
    for (let i = 0; i < A.length; i++) {
      const a = A[i], u = a.jumped ? 1 : aC;
      const x = a.px + (a.x - a.px) * u, z = a.pz + (a.z - a.pz) * u;
      const dx = x - camP.x, dz = z - camP.z, d2 = dx * dx + dz * dz + camP.y * camP.y * 0.25;
      let b = d2 > 36 && (dx * fwd.x + dz * fwd.z) < -0.25 * Math.sqrt(d2) ? 99 : Math.floor(Math.sqrt(d2) / 10);
      if (b > 17) b = 99; else hist[b]++;
      ax[i] = x; az[i] = z; ab[i] = b;
    }
    let cut = 17, acc = 0; for (let b = 0; b <= 17; b++) { acc += hist[b]; if (acc > LIFE.maxDrawn) { cut = b - 1; break; } }
    for (let i = 0; i < A.length; i++) {
      if (ab[i] > cut) continue;
      const a = A[i], u = a.jumped ? 1 : aC, x = ax[i], z = az[i];
      const dx = x - camP.x, dz = z - camP.z, d2 = dx * dx + dz * dz + camP.y * camP.y * 0.25;
      let T, k;
      if (d2 < nr2 && nN < tiers[0].cap) { T = T0; k = nN++; } else if (d2 < mr2 && nM < tiers[1].cap) { T = T1; k = nM++; } else if (nN + nM + nF < LIFE.maxDrawn) { T = T2; k = nF++; } else continue;
      let dy = a.yaw - a.pyaw; dy -= Math.round(dy / 6.283185307) * 6.283185307;
      let ph = a.ph - a.pph; if (ph < -0.5) ph += 1; else if (ph > 0.5) ph -= 1;
      const o = k * 4, L = look[i];
      T.iPos.array[o] = x; T.iPos.array[o + 1] = groundAt(x, z); T.iPos.array[o + 2] = z; T.iPos.array[o + 3] = a.pyaw + dy * u;
      T.iAnim.array[o] = (a.pph + ph * u + 1) % 1; T.iAnim.array[o + 1] = a.walkAmt; T.iAnim.array[o + 2] = a.pose; T.iAnim.array[o + 3] = a.scale;
      T.iTop.array.set(L.top, o); T.iTop.array[o + 3] = a.look.coat;
      T.iBot.array.set(L.bot, o); T.iBot.array[o + 3] = a.look.bag;
      T.iHair.array.set(L.hair, o); T.iHair.array[o + 3] = a.wide;
      T.iSkin.array.set(L.skin, o); T.iSkin.array[o + 3] = umbOf[i];
      fill.at(x, z, tmpF); T.iFill.array[o] = tmpF[0]; T.iFill.array[o + 1] = tmpF[1]; T.iFill.array[o + 2] = tmpF[2]; T.iFill.array[o + 3] = tmpF[3];
    }
    for (const [T, n] of [[tiers[0], nN], [tiers[1], nM], [tiers[2], nF]]) {
      T.g.instanceCount = n;
      for (const k in T.A) { const at = T.A[k]; at.clearUpdateRanges?.(); at.addUpdateRange?.(0, n * 4); at.needsUpdate = true; }
    }
    // ---- vehicles
    const aT = sim.aT, cnt = {}; for (const ty of VTYPES) cnt[ty] = 0;
    let np = 0;
    for (const v of traffic.vehicles) {
      const p = traffic.pose(v, aT, PO), [ef, er] = vEm[v.id];
      if (p.hidden) { ef.nits = 0; er.nits = 0; continue; }
      const B = vByType[v.type], k = cnt[v.type]; if (k >= B.cap) continue; cnt[v.type]++;
      const y = groundAt(p.x, p.z), yaw = Math.atan2(p.hx, p.hz);
      Q.setFromAxisAngle(UP, yaw); M4.compose(V3.set(p.x, y, p.z), Q, S1); B.im.setMatrixAt(k, M4);
      const col = v._lin || (v._lin = lin(v.paint)); B.im.instanceColor.setXYZ(k, col[0], col[1], col[2]);
      B.st.setXYZW(k, v.brake, v.hazard ? 1 : 0, 1, (v.id * 0.37) % 1);
      const hl = v.L / 2;
      ef.pos[0] = p.x + p.hx * hl; ef.pos[1] = y + (v.type === 'bus' ? 0.6 : 0.68); ef.pos[2] = p.z + p.hz * hl; ef.normal[0] = p.hx; ef.normal[2] = p.hz; ef.nits = 40000;
      er.pos[0] = p.x - p.hx * hl; er.pos[1] = y + 0.75; er.pos[2] = p.z - p.hz * hl; er.normal[0] = -p.hx; er.normal[2] = -p.hz; er.nits = 250 + 1250 * v.brake;
      const I = v.type === 'scooter' ? 0.35 : v.type === 'bus' ? 1.2 : 1;
      poolA.setXYZW(np++, p.x + p.hx * hl, p.z + p.hz * hl, yaw, I);
    }
    for (const ty of VTYPES) { const B = vByType[ty]; B.im.count = cnt[ty]; B.im.instanceMatrix.needsUpdate = true; B.im.instanceColor.needsUpdate = true; B.st.needsUpdate = true; }
    poolG.instanceCount = np; poolA.needsUpdate = true;
    stats.near = nN; stats.mid = nM; stats.far = nF; stats.drawn = nN + nM + nF; stats.tris = nN * tiers[0].tris + nM * tiers[1].tris + nF * tiers[2].tris;
    stats.simMs = c1 - c0; stats.cpuMs = performance.now() - c0;
    if (life.audio && life.audio.feed) life.audio.feed(camP, fwd, clock);
  }
  const life = {
    group, emitters, sim, stats, fill,
    colliders: { at: (t, out) => sim.boxesAt(t, out), hit: (p, r, t) => sim.hit(p, r, t), keyed: 'take-clock' },
    update,
    // free-running clock for previews without a take clock (dev page, menu background)
    tick(dt) { if (!extClock) clock += dt; },
    setFill(k) { fillK.value = k; }, setNitScale(k) { nit.value = k; },
    // acoustic context at a point (for the props' wall slapback): nearest facade distance and canyon openness
    acoustics: (p) => acousticsAt(layout, sim.net, p),
    audio: null,
    dispose() { group.traverse((o) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); }); group.removeFromParent(); },
  };
  life.crossPhase = crossPhase;
  if (ctx.audio !== false) life.audio = createSeoulAudio(layout, life, { signs: ctx.emitters, rain: ctx.rain });
  return life;
}

function acousticsAt(layout, net, p) {
  let best = Infinity, cnt = 0;
  for (const l of layout.lots || []) {
    const f = l.footprint; if (!f) continue;
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
      let u = ((p.x - a[0]) * dx + (p.z - a[1]) * dz) / L2; u = u < 0 ? 0 : u > 1 ? 1 : u;
      const d = Math.hypot(p.x - a[0] - dx * u, p.z - a[1] - dz * u);
      if (d < best) best = d; if (d < 12) cnt++;
    }
  }
  let w = 30; for (const st of net.streets) { const pr = st.path.project(p.x, p.z); if (pr.dist < st.width / 2 + 1) { w = Math.min(w, st.width); } }
  return { wallDist: best, streetW: w, canyon: Math.max(0, Math.min(1, (12 - w) / 9)) * (p.y < 25 ? 1 : 0.3) };
}

export default { build, LIFE, LifeSim };
