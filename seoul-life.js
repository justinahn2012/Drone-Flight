// seoul-life.js: Neon Seoul (Hongdae) street life. Stream S4, contract L2/L3.
//   build(layout, ctx) -> { group, emitters, colliders, update(t, camPos?, camQuat?), audio, sim, crowd, near, stats, setFill(k), dispose() }
//
// Everything that moves is a pure function of (seed, take clock):
//   * TrafficSim: taxis, cars, 1-ton trucks, city buses (median bus lane, dwell + kneel at stops), delivery scooters,
//     on a lane graph built from layout.streets. IDM car-following at a fixed 60 Hz step (= every 4th 240 Hz take
//     tick), signals cycling on the take clock, taxis pulling over with hazards. Integer-seeded, no Math.random, no
//     trig in the step, so a replay of the same take clock reproduces every bumper to the bit. Kinematic colliders:
//     colliders.at(t) / colliders.hit(p, r, t) (flight.js support is the D stream's, plan-U5 M3).
//   * CrowdSim (G, phase 2): closed form. Every person is a pure function of (seed, take clock): door-to-door walker
//     trips, chat clusters that shuffle, club queues that admit and step up, busking rings, pocha tables, crossers that
//     surge on the walk phase. Avoidance near the camera only, statelessly. Soft colliders for the drone (scrape).
// Rendering: one procedural human (CC0 by construction: built here, no asset), 15 bones, hair shells (short, bob, long,
// ponytail, cap, hood, beanie), hands, scarves, backpacks, masks, fabric detail and a shaded face; a normative-gait walk
// (Winter/Perry joint curves, stance-leg hip height, pelvis and thorax rotation) and idles (weight shift, talk, phone,
// smoke, film, dance, sing, clap, drink) in the vertex shader; three instanced LODs. Shopfront fill: a 4 m grid
// of what the frontages (and S2's emitters when passed) throw onto the pavement, so people read as lit silhouettes
// against shopfronts even before S3's light grid. Vehicles: instanced low-poly bodies with emissive head/tail/brake/
// hazard/bus-interior parts, additive headlight pools on the asphalt, and an L3 emitter per light cluster.
//
// Units: metres, y up, x east, z south (L1). Luminance: emissive parts are authored in nits and scaled by
// ctx.nitScale (scene units per nit; S3 owns the calibration). Fill grid is in lux.
import * as THREE from 'three';
import { Rng } from './rng.js';
import { createSeoulAudio } from './seoul-audio.js';
import { LifeWorker } from './seoul-life-client.js';

export const LIFE = {
  crowdHz: 10, trafficHz: 60,
  // pedestrians per m^2 of walkway, Friday ~23:00 (life #1: ref ccb0f315 ~0.25 clumped; targets walking 0.35, club 0.3,
  // Yanghwa-ro sidewalks 0.08, alleys 0.06, exit 9 ~0.3 from its portal)
  density: { main: 0.08, walking: 0.35, club: 0.3, alley: 0.06 },
  // unit counts per home-way kind, fitted so the realised (visible, through-flow included) densities hit the targets
  crowdK: { main: 1.25, walking: 1.75, club: 1.5, alley: 1.35 },
  // per-street weights on top (life #4, P3): the hero club street (Wausan-ro 19-gil) read 0.07-0.11 p/m^2 against a 0.3
  // target once C widened it, so its own walkers are weighted x1.7 (people also turn into it at junctions by this weight)
  streetK: { '와우산로19길': 1.7 },
  // exit 9 (life #4): trains every ~140 s (Line 2 / Gyeongui / AREX alternate); each one sends 20-40 up the stairs in ~45 s
  train: { headway: 140, spread: 45, perTrain: 30 },
  // (P6, design #1) exit 9's stair mouth: walkers keep stairPad m off E's opening, eased in over stairRamp m of walkway
  // (stairHeadPad / stairHeadRamp: the stair head's side, where the line comes in above heads and a building corner
  // stands 1.8 m on)
  stairPad: 1.2, stairRamp: 5, stairHeadPad: 0.3, stairHeadRamp: 1.5,
  // road vehicles at reset: bumper gaps of roadGap[0] + U * roadGap[1] m per lane (P4: 20 + U 40; P3 10 + U 30 packed the
  // widened carriageways past what the junctions pass)
  roadGap: [20, 40],
  // (P5, life #1) demand at the map edge: Friday night on Yanghwa-ro is ~2,000 veh/h per direction (one-way carriageways:
  // `arterial`, shared over the entry lanes of each approach); `lane` veh/h for every other road entry lane. P4 ran a closed
  // fleet that re-entered as fast as it left, so it piled up in front of the junctions until 62 % of main-road traffic
  // stood. Vehicles that leave wait off stage (hidden) for their entry lane's next arrival; `fleet` is the road fleet
  // (arterialLane caps a lane at what it clears in 66-72 s of green with taxis stopping at the kerb: westbound has 3 general lanes)
  demand: { arterial: 2000, arterialLane: 420, lane: 200, fleet: 240 },
  // (P4 perf #2: people were 0.8-1.34 M main-pass triangles) the 3.4k avatar LOD only within nearR0, a 1.7k LOD to nearR;
  // 1500 drawn on auto, 900 on the phone preset (crowd 'low'); the velocity pass sees only the near tiers
  // warm: the city's head start (s) at take clock 0; (P5, life #6) a retry opens 0..warmMax - warm s later (attemptTicks)
  // retryPrerollMs (P6): the most a retry spends topping up the pre-roll (attemptTicks)
  retryPrerollMs: 60,
  // (P7, perf #1: people were 0.48-0.86 M of the main pass) at most maxLod0 people on the 3.4k LOD (the nearest; the rest
  // of nearR0 on lod1), avatars' mid LOD to midR 42 m (P6 55; past it the 218-triangle far body, P6 282)
  maxLod0: 60,
  warm: 75, warmMax: 240, maxAgents: 15500, nearR0: 6, nearR: 18, midR: 42, farR: 170, maxNear: 240, maxMid: 1100, maxDrawn: 1500, maxDrawnLow: 900,
  counterShare: 0.22,          // (P6, life #3) walkers on the 'wrong' side of the walkway (prefD)
  groupShare: 0.55,            // share of pedestrians walking in groups of 2-4 (nightlife district)
  phoneShare: 0.32,            // walkers alone looking at a phone (P5, life #3: with groups at 0.2, 25 % of walkers; P4 18 % alone, 8 % in groups)
  // (P5, life #3) a trip's chance of one stop at a shop window or sign, and its length (s): ~4 % of walkers stand at any time
  pause: { p: 0.65, t0: 3, t1: 10 },
  sidewalk: (w) => Math.max(3, Math.min(6, w * 0.15)),
  laneW: 3.25,
  // s; walk = after green+amber+allRed. (P5, life #1) a 120 s cycle (Seoul arterials run 120-160 s; P4's 70 s spent 10 s of
  // every 70 in inter-greens and held the arterial to 36 s of green). Junctions: 2 x (3 s amber + 2 s all-red), the major
  // axis 55-60 % of the cycle
  // shift (P7, life #1): the whole plan runs 98 s later, so station2 (take clock 0 = sim 75 s) opens on an eastbound platoon
  signal: { period: 120, green: 84, amber: 3, allRed: 1, walk: 30, shift: 98 },
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
// crosswalk c at take clock t. Intersections ('X') run two axis groups: axis 0 green from 0 for c.g0 s, axis 1 green from
// c.g0 + 5 to P - 5 (each followed by 3 s amber and 2 s all-red); a crosswalk over an axis-g road walks while the other
// axis has its green. (P4, life #3) the split follows the lanes; (P5, life #1) P = 120 s, so the arterial gets 66-72 s
export function crossPhase(c, t) {
  if (c.kind !== 'X') return signalPhase(t, c.offset);
  const P = LIFE.signal.period, S = P - 10, G0 = c.g0 ?? S / 2, G = c.axis ? S - G0 : G0, tc = (((t + c.offset) % P) + P) % P, g0 = c.axis ? G0 + 5 : 0, u = (tc - g0 + P) % P;
  const car = u < G ? 'G' : u < G + 3 ? 'A' : 'R';
  const w0 = c.axis ? 0 : G0 + 5, wlen = (c.axis ? G0 : S - G0) - 3;
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
  // ---- one-way carriageways: st.oneway (1 = point order, -1 = reverse) or a same-named anti-parallel twin nearby, or (P4) a
  // same-named continuation of one (Yanghwa-ro's 13 m pieces either side of the 월드컵북로 junction: P3 read them as 7 m
  // of road inside pavements, so 4 lanes fed 2 and three lanes merged into one: 79 % of the main-road traffic stood)
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
  const med = (a) => { if (!a.length) return null; const b = a.slice().sort((p, q) => p - q); return b[b.length >> 1]; };
  for (let pass = 0; pass < 3; pass++) for (const a of mains) {
    if (a.ow || a.oneway != null) continue;
    for (const b of mains) {
      if (b === a || !b.ow || (b.ko || b.name) !== (a.ko || a.name) || !(a.ko || a.name)) continue;
      const pe = b.points[b.points.length - 1], ps = b.points[0], qs = a.points[0], qe = a.points[a.points.length - 1];
      if (Math.hypot(pe[0] - qs[0], pe[1] - qs[1]) < 30 || Math.hypot(qe[0] - ps[0], qe[1] - ps[1]) < 30) { a.ow = 1; a.owCont = true; break; }
    }
  }
  for (const st of streets) {
    const sd = sides.get(st), bl = [med(sd.L), med(sd.R)], w2 = st.width / 2;
    if (st.kind === 'main') {
      // building line well beyond width/2: width is the carriageway (OSM). Else width spans the pavements (synthetic).
      // (P4) a one-way carriageway is an OSM way: its width is the carriageway whatever the buildings say
      const known = bl.filter((v) => v != null), b = known.length ? Math.min(...known) : null;
      // (P4) so is any OSM way (st.osm): world-seoul paints the whole width as carriageway with round(w / 3.25) lanes; P3 put
      // walkers on its outer lanes and squeezed 4 painted lanes into 2
      const carriage = st.ow || st.osm != null || (b != null && b > w2 + 1.8) ? w2 : st.sidewalk ? w2 - st.sidewalk : w2 - LIFE.sidewalk(st.width);
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
  const crossings = [], signals = []; let ci = 0;
  const addCross = (c) => {
    c.main.path.at(c.sc, o1); c.x = o1.x; c.z = o1.z; c.cw = 5; c.halfSpan = c.main.carHalf + 0.9;
    // (P4) a junction approach whose crosswalk is merged into a neighbour's (< 14 m) still gets its stop line and signal
    // (P3 dropped it: Yanghwa-ro westbound ran through the Hongik station junction unsignalled and never let the cross
    // streets out)
    if (crossings.some((d) => Math.hypot(d.x - c.x, d.z - c.z) < 14)) { if (c.kind === 'X') { c.id = 'S' + signals.length; c.stopOnly = true; signals.push(c); } return; }
    c.id = 'X' + ci++; crossings.push(c);
  };
  // (P4) junctions joined by a road piece under 25 m (the two carriageways of Yanghwa-ro) are one junction: one signal plan
  // (offset and axes from the group's first node) and no stop line on the link inside it (P3 ran each node's lights on
  // its own offset, so traffic released by one stopped on the median link at the other's red, holding the box)
  const jr = new Map(nodes.map((n) => [n, n])), root = (n) => { while (jr.get(n) !== n) n = jr.get(n); return n; };
  for (const st of mains) if (st.path.len < 25 && st.n[0] !== st.n[1]) { const a = root(st.n[0]), b = root(st.n[1]); if (a !== b) jr.set(a.id < b.id ? b : a, a.id < b.id ? a : b); }
  const isJ = (n) => { const roads = n.ends.filter((e) => e.st.kind === 'main'), names = new Set(roads.map((e) => e.st.ko || e.st.name || e.st.id)); return roads.length >= 3 || (roads.length === 2 && names.size === 2); };
  const ax0Of = new Map();
  for (const n of nodes) {   // intersections: >= 3 road pieces, or 2 of different names
    const roads = n.ends.filter((e) => e.st.kind === 'main');
    if (!isJ(n)) continue;
    const R0 = root(n);
    if (!ax0Of.has(R0)) { const rr = (isJ(R0) ? R0 : n).ends.filter((e) => e.st.kind === 'main'), e = rr.find((q) => q.st.path.len >= 25) || rr[0]; e.st.path.at(e.k ? e.st.path.len : 0, o1); ax0Of.set(R0, [o1.tx, o1.tz]); }
    const ax0 = ax0Of.get(R0);
    const off = (R0.id * 17) % LIFE.signal.period;
    for (const e of roads) {
      if (e.st.path.len < 25 && root(e.st.n[0]) === root(e.st.n[1])) continue;   // the link inside a junction
      const P = e.st.path; P.at(e.k ? P.len : 0, o1);
      const axis = Math.abs(o1.tx * ax0[1] - o1.tz * ax0[0]) < 0.5 ? 0 : 1;
      const r = Math.max(...n.ends.filter((q) => q !== e).map((q) => (q.st.carHalf ?? q.st.width / 2))) + 3.5;
      if (P.len < r + 3) continue;
      addCross({ kind: 'X', node: n, main: e.st, sc: e.k ? P.len - r : r, toward: e.k ? 1 : -1, axis, offset: off, root: R0 });
    }
  }
  // green split per junction group: lanes approaching on each axis (one-way pieces count whole, two-way half)
  { const lanes = new Map(); for (const c of [...crossings, ...signals]) if (c.kind === 'X') { const L = lanes.get(c.root) || [0, 0]; L[c.axis] += Math.max(1, Math.round((c.main.ow ? 2 : 1) * c.main.carHalf / LIFE.laneW)); lanes.set(c.root, L); }
    for (const c of [...crossings, ...signals]) if (c.kind === 'X') { const L = lanes.get(c.root); const S = LIFE.signal.period - 10, r = L[0] / (L[0] + L[1] || 1), maj = Math.max(Math.round(S / 2), Math.min(Math.round(0.55 * LIFE.signal.period), Math.max(Math.round(0.55 * LIFE.signal.period), Math.round(S * Math.max(r, 1 - r))))); c.g0 = r >= 0.5 ? maj : S - maj; } }   // (P5) the major axis 55-60 % of the cycle
  // (P4, life #4) where a crosswalk's kerb is the next carriageway (Yanghwa-ro's two halves), its crowd waits past that one too
  // and crosses both in one go (P3 stood them on the other carriageway, between its crosswalk and stop line); and a junction's
  // split gives them the walk (and its clearance) to do it at 1.4 m/s
  for (const c of crossings) { const P = c.main.path.at(c.sc, {}); c.ext = [-1, 1].map((sd) => { let e = 0; while (e < 30) { const off = sd * (c.halfSpan + e + 0.6), q = offRoad(mains, P.x + P.nx * off, P.z + P.nz * off, 0.4, c.main); if (q.moved === 0) break; e += 0.5; } return e; }); }
  { const need = new Map();
    for (const c of crossings) if (c.kind === 'X') { const sp = 2 * c.halfSpan + c.ext[0] + c.ext[1], nd = need.get(c.root) || [0, 0]; nd[c.axis] = Math.max(nd[c.axis], Math.ceil(sp / 1.4) - 1); need.set(c.root, nd); }   // (walk + the 3 s amber and 2 s all-red after it, 1 s spare)
    for (const c of [...crossings, ...signals]) if (c.kind === 'X' && need.has(c.root)) { const nd = need.get(c.root); c.g0 = Math.max(nd[1], Math.min(LIFE.signal.period - 10 - nd[0], c.g0)); } }
  // (P5, life #1) green wave: junction groups linked by a road get offsets so that a platoon released by one arrives at
  // the next as its green starts (at 11 m/s, Seoul's 50 km/h limit less the start-up). The group with the most approach
  // lanes keeps its offset; the others follow it along the shortest road chain that passes no other junction
  { const P = LIFE.signal.period, xs = [...crossings, ...signals].filter((c) => c.kind === 'X'), groups = [...new Set(xs.map((c) => c.root))];
    const gOf = new Map(); for (const c of xs) gOf.set(c.node, c.root);
    const size = (g) => xs.filter((c) => c.root === g).reduce((a, c) => a + c.main.carHalf, 0);
    groups.sort((a, b) => size(b) - size(a) || a.id - b.id);
    const done = new Set(groups.slice(0, 1)), gStart = (c) => (c.axis ? c.g0 + 5 : 0);
    for (let pass = 0; pass < groups.length; pass++) for (const g of groups) {
      if (done.has(g)) continue; let best = null;
      for (const c0 of xs) { if (!done.has(c0.root)) continue;   // walk the road from a done junction's approach outward
        let st = c0.main, n = c0.node, d = 0, seen = 0;
        while (st && seen++ < 12) {
          const far = st.n[0] === n ? st.n[1] : st.n[0]; d += st.path.len; const rg = gOf.get(far);
          if (rg && rg !== c0.root) { if (rg === g) { const c1 = xs.find((c) => c.node === far && c.main === st); if (c1 && (!best || d < best.d)) best = { d, c0, c1 }; } break; }
          const nx = far.ends.filter((e) => e.st !== st && e.st.kind === 'main' && (e.st.ko || e.st.name) === (st.ko || st.name)); if (nx.length !== 1) break; st = nx[0].st; n = far;
        } }
      if (!best) continue;
      const tg = gStart(best.c0) - best.c0.offset + best.d / 11, off = (((gStart(best.c1) - tg) % P) + P) % P, o = Math.round(off);
      for (const c of xs) if (c.root === g) c.offset = o;
      done.add(g);
    } }
  for (const m of mains) for (const o of streets) {   // mid-block: a walking or club street meets a road
    if (o.kind !== 'walking' && o.kind !== 'club') continue;
    const hits = pathCross(m.path, o.path).map(([sm]) => sm);
    for (const k of [0, o.points.length - 1]) { const pr = m.path.project(o.points[k][0], o.points[k][1]); if (pr.dist < m.carHalf + 8) hits.push(pr.s); }
    for (const sm of hits) {
      const sc = Math.max(3, Math.min(m.path.len - 3, sm + o.width / 2 + 3)); if (m.path.len < 8) continue;
      // (P4) mid-block crossings within 80 m of one another on the same road run together (P3 gave each its own offset:
      // Wausan-ro's three crosswalks 17-30 m apart stopped a car at each in turn)
      // and one within 60 m of a junction's crosswalk on the same road turns green with that approach
      const P = LIFE.signal.period, nearX = crossings.find((d) => d.kind === 'X' && d.main === m && Math.abs(d.sc - sc) < 60);
      const near = crossings.find((d) => d.kind === 'T' && d.main === m && Math.abs(d.sc - sc) < 80);
      addCross({ kind: 'T', main: m, sc, toward: 0, axis: 0, offset: nearX ? (nearX.offset - (nearX.axis ? nearX.g0 + 5 : 0) + P) % P : near ? near.offset : (ci * 13) % P });
    }
  }
  // (P7, life #1) the city's signal plan as a whole runs LIFE.signal.shift s later (green wave kept): station2 opened in the
  // lull between Yanghwa-ro's eastbound platoons (one car on the near carriageway at take clock 0)
  { const P = LIFE.signal.period, sh = LIFE.signal.shift || 0; if (sh) for (const c of [...crossings, ...signals]) c.offset = (((c.offset + sh) % P) + P) % P; }
  return { streets, mains, nodes, crossings, signals, bounds: boundsOf(layout, streets) };
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
// (P7) render-only vehicle cull: m, m, rad added to the camera's half-angle
export const VCULL = { near: 12, far: 220, pad: 0.26 };
// Seoul night palettes (sRGB): mostly white / black / grey-silver; taxis silver-white or orange
const PAINT = {
  car: [[0.92, 0.92, 0.9], [0.92, 0.92, 0.9], [0.9, 0.91, 0.92], [0.05, 0.05, 0.06], [0.06, 0.06, 0.07], [0.55, 0.56, 0.58], [0.38, 0.39, 0.41], [0.68, 0.69, 0.7], [0.12, 0.17, 0.3], [0.45, 0.07, 0.07]],
  taxi: [[0.86, 0.86, 0.84], [0.8, 0.81, 0.82], [0.85, 0.42, 0.13], [0.86, 0.86, 0.84]],
  truck: [[0.18, 0.32, 0.62], [0.88, 0.89, 0.9], [0.2, 0.34, 0.6]],
  bus: [[0.0, 0.41, 0.72], [0.0, 0.41, 0.72], [0.33, 0.7, 0.2]],   // (P5) Seoul 간선 blue #0068B7 (2 in 3), 지선 green #53B332
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
          const n = Math.max(1, Math.min(4, Math.floor(ch / 2.9))), w = ch / n;   // (P4) lanes >= 2.9 m (P3: 2.45 m lanes, buses wider than their lane)
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
      ln.id = `${st.id}:${ln.dir > 0 ? 'f' : 'b'}${ln.k}`; ln.idx = i; ln.len = ln.s1 - ln.s0; ln.vlim = ln.shared ? 99 : st.ow ? 10.5 : 8;
      ln.start = ln.dir > 0 ? (ln.s0 < 0.5 ? st.n[0] : null) : (ln.s1 > st.path.len - 0.5 ? st.n[1] : null);
      ln.end = ln.dir > 0 ? (ln.s1 > st.path.len - 0.5 ? st.n[1] : null) : (ln.s0 < 0.5 ? st.n[0] : null);
      st.path.at(this.toBase(ln, 0), o); ln.h0 = [o.tx * ln.dir, o.tz * ln.dir];
      st.path.at(this.toBase(ln, ln.len), o); ln.h1 = [o.tx * ln.dir, o.tz * ln.dir];
      // stop lines: 2.5 m before each crosswalk this lane runs into
      ln.stops = [];
      if (!ln.shared) for (const c of [...net.crossings, ...(net.signals || [])]) if (c.main === st && (c.toward === 0 || c.toward === ln.dir)) {
        const sc = ln.dir > 0 ? c.sc - ln.s0 : ln.s1 - c.sc, sl = sc - c.cw / 2 - 2.5;
        if (sl > 1) ln.stops.push({ s: sl, c });
      }
      ln.stops.sort((a, b) => a.s - b.s);
      ln.busStops = ln.bus && ln.len > 70 ? [ln.len * 0.45] : [];
    }
    // ---- BUS SHELTER islands (design #2, P3: a bus filled the shelter gates 42 % of the time; the bus lane ran through the
    // island). Beside an island the lanes of each carriageway fan out (smoothly over 18 m): the bus lane's side 1.5 m off the
    // island edge, each next lane >= 2.3 m on, so the gates under the canopy (0.5-2.7 m off the axis) stay clear; buses
    // dwell beside the island. ln.shel = { sc, half, d } (lane s at the island centre, half length, lat offset)
    for (const sh of net.shelters || []) {
      const [px, , pz] = sh.pos, dx = sh.dir[0], dz = sh.dir[2], ux = dz, uz = -dx, half = sh.island.L / 2, edge = sh.island.w / 2;
      const groups = new Map();
      for (const ln of this.lanes) {
        if (ln.shared) continue; let best = null;
        for (let s = 0; s <= ln.len; s += 1) { ln.base.at(this.toBase(ln, s), o); const x = o.x + o.nx * ln.lat, z = o.z + o.nz * ln.lat, a = (x - px) * dx + (z - pz) * dz, u = (x - px) * ux + (z - pz) * uz; if (Math.abs(a) < half && Math.abs(u) < 14 && (!best || Math.abs(a) < Math.abs(best.a))) best = { s, a, u, nx: o.nx, nz: o.nz }; }
        if (!best) continue;
        const key = ln.street.id + ':' + ln.dir + ':' + Math.sign(best.u); let g = groups.get(key); if (!g) groups.set(key, (g = [])); g.push({ ln, ...best });
      }
      for (const g of groups.values()) {
        g.sort((a, b) => Math.abs(a.u) - Math.abs(b.u)); let need = edge + 1.5 + 1.25;
        for (const e of g) {
          const du = Math.max(0, need - Math.abs(e.u)), sgn = Math.sign(e.u) * Math.sign(e.nx * ux + e.nz * uz) || 1;   // lat units -> outward
          if (du > 0.01) e.ln.shel = { sc: e.s, half, d: sgn * du };
          need = Math.abs(e.u) + du + 2.3;
          if (e.ln.bus && du > 0.01) e.ln.busStops = [Math.min(e.ln.len - 30, Math.max(30, e.s + 2))];
        }
      }
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
    // junction boxes (life #3, P3): a lane's `entry` is where the other streets' carriageways begin (vehicles not holding the
    // box stop their front bumper there); `clear` is how far into a lane its rear bumper must be before the box is free again
    // nodes joined by a road lane under 25 m (the two carriageways of Yanghwa-ro) are one box: a vehicle crossing the median
    // holds both, so it never waits on the link inside a box it is blocking
    for (const n of net.nodes) n.bid = n.id;
    const root = (n) => { while (net.nodes[n.bid] !== n) n = net.nodes[n.bid]; return n; };
    for (const ln of this.lanes) if (!ln.shared && ln.start && ln.end && ln.len < 25) { const a = root(ln.start), b = root(ln.end); if (a !== b) b.bid = a.id; }
    for (const n of net.nodes) n.bid = root(n).id;
    for (const ln of this.lanes) ln.internal = !ln.shared && !!(ln.start && ln.end && ln.len < 25 && ln.start.bid === ln.end.bid);
    const halfOf = (st) => st.carHalf ?? (st.kind === 'pedestrian' ? 0 : Math.min(st.width / 2, 3.2));
    const otherHalf = (node, st) => node ? Math.max(0, ...node.ends.filter((e) => e.st !== st).map((e) => halfOf(e.st))) : 0;
    for (const ln of this.lanes) {
      ln.entry = Math.max(ln.len * 0.5, ln.len - otherHalf(ln.end, ln.street) - 0.6);
      ln.clear = Math.min(ln.len * 0.5, Math.max(3, otherHalf(ln.start, ln.street) + 0.6));
    }
    this.mvGeo = new Map(); this.mvDist = new Map(); this.mvEnd = new Map();
    // a lane's waiting line also stops short of every other movement's swept path through its node (the hand-off ease and
    // wide turns reach past the carriageway edges): front bumper 1 m before the first point any such path comes within
    // 2.45 m (a bus and a car side by side) of its centre line in its last 25 m
    const EC = net._entry && net._entry.length === this.lanes.length ? net._entry : null;   // (P5) a second sim on this net reuses the first's
    if (EC) this.lanes.forEach((m, i) => { m.entry = EC[i]; });
    else for (const m of this.lanes) {
      if (!m.end) continue; let e = m.entry;
      for (const a of this.lanes) {
        if (a === m || !a.end || a.end.bid !== m.end.bid) continue;
        for (const g of a.succ) for (const b of g.lanes) {
          const P = this.mvPath(a.idx, b.idx);
          for (let i = 0; i < P.length; i += 2) {
            const pr = m.base.project(P[i], P[i + 1]), sl = m.dir > 0 ? pr.s - m.s0 : m.s1 - pr.s;
            if (sl > m.len - 25 && sl < m.len + 3 && Math.abs(pr.d - m.lat) < 2.8 && sl - 1 < e) e = sl - 1;
          }
        }
      }
      m.entry = Math.max(m.len * 0.5, Math.min(m.entry, e));
    }
    if (!EC) net._entry = this.lanes.map((m) => m.entry);
    // (P5) the movement caches are pure functions of the net's lanes once built: every sim on this net shares them (the
    // movers' forks and the worker's twin each refilled them from cold, ~2 s of the first 20 s of a fork)
    { const C = net._mv || (net._mv = { geo: new Map(), dist: new Map(), end: new Map() }); this.mvGeo = C.geo; this.mvDist = C.dist; this.mvEnd = C.end; }
    // (P5, life #1) a signalled approach waits for its box grant behind its stop line, not at the entry: P4 let a car queue
    // past the line on its green, keep its place in the crosswalk through the red, then cross on the other axis's green
    // (World Cup-buk-ro cars ran the red into Yanghwa-ro's platoons and held them, and stood on the walk)
    for (const ln of this.lanes) { ln.boxStop = null; if (ln.end) for (const st of ln.stops) if (st.c.kind === 'X' && st.c.node && st.c.node.bid === ln.end.bid) ln.boxStop = st.s; }
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
    // (P5) buses run Yanghwa-ro's median bus lanes only (one-way carriageways): World Cup-buk-ro's turned up Hongik-ro, or
    // right across the BUS SHELTER gates, once the junction let them through
    this.busEntries = this.lanes.filter((l) => l.bus && l.street.ow && len10(l) && l.pred === 0 && l.start && l.start.boundary);
    // (P5) arrival rate per road entry lane, as a mean headway in steps (uniform +-60 %: no transcendental in the step)
    { const D = LIFE.demand, appr = new Map(); for (const l of this.entries.road) { const k = l.street.id + ':' + l.dir; appr.set(k, (appr.get(k) || 0) + 1); }
      for (const l of this.entries.road) { const vph = l.street.ow ? Math.min(D.arterialLane, D.arterial / appr.get(l.street.id + ':' + l.dir)) : D.lane; l.hw = Math.max(1, Math.round(3600 / vph * LIFE.trafficHz)); } }
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
      ln.veh = []; ln.nextArr = 0;
      if (ln.len < 8 || (ln.bus && !ln.street.ow)) continue;
      let s = ln.shared ? ln.len - R.next() * 400 : ln.len - R.next() * 12;   // alleys: most short ones start empty
      while (s > 2) {
        const type = this.pickType(ln, R), c = VEH[type];
        const v = this.spawn(id++, type, ln, s, R);
        v.v = v.v0 * (0.4 + 0.4 * R.next());
        ln.veh.push(v); this.vehicles.push(v);
        // alley lanes: one scooter or car per ~350 m of lane (life #6: ~40 scooters in all, P1 had 161)
        s -= c.L + (ln.shared ? 220 + R.next() * 300 : (type === 'bus' ? 70 + R.next() * 90 : LIFE.roadGap[0] + R.next() * LIFE.roadGap[1]));
      }
    }
    for (const v of this.vehicles) v.next = this.pickNext(v.lane, v, R);
    // (P5) top the road fleet up to demand.fleet with vehicles waiting off stage for their arrival
    let road = 0; for (const v of this.vehicles) if (!v.lane.shared) road++;
    const E = this.entries.road;
    for (; road < LIFE.demand.fleet && E.length; road++) { const ln = E[0], v = this.spawn(id++, 'car', ln, 0, R); v.hidden = true; ln.veh.push(v); this.vehicles.push(v); this.respawn(v, R); }
  }
  // Hongdae after 22:00: taxis are 45 % of the car-class traffic (life #6), few trucks, scooters on the kerb lanes
  // exact state copy for cheap rewinds (LifeSim keeps one every 10 s of take clock): every vehicle field, lane
  // membership (rebuilt in id order: every per-lane loop is order-free or sorts with an id tie-break), RNG, step count
  // (P5) portable between sims on the same net: lanes by index (a pre-roll sim's snapshots restore into the drawn sim and the
  // movers' forks)
  snapshot() {
    return { n: this.n, rs: this.R.state, na: this.lanes.map((l) => l.nextArr),
      v: this.vehicles.map((v) => ({ ...v, lane: v.lane.idx, next: v.next ? v.next.idx : -1, next2: v.next2 ? { lane: v.next2.lane ? v.next2.lane.idx : -1, n2: v.next2.n2 } : null })) };
  }
  restore(S) {
    this.n = S.n; this.R.state = S.rs; this.events.length = 0;
    if (S.na) this.lanes.forEach((l, i) => { l.nextArr = S.na[i]; });
    for (const ln of this.lanes) ln.veh = [];
    const L = this.lanes, ln = (x) => (typeof x === 'number' ? (x >= 0 ? L[x] : null) : x);
    S.v.forEach((c, i) => { const v = this.vehicles[i]; for (const k in v) if (!(k in c)) delete v[k]; Object.assign(v, c); v.lane = ln(c.lane); v.next = ln(c.next); v.next2 = c.next2 ? { lane: ln(c.next2.lane), n2: c.next2.n2 } : null; });
    for (const v of this.vehicles) v.lane.veh.push(v);
  }
  pickType(ln, R) {
    if (ln.bus) return 'bus';
    // (P3) a car only where one can pass an oncoming scooter (walkable half >= 1.9 m); else delivery scooters
    if (ln.shared) { const r = R.next(); return ln.street.kind === 'walking' || r < 0.8 || (ln.street.walkHalf ?? 0) < 1.9 ? 'scooter' : 'car'; }
    const r = R.next();
    return r < 0.36 ? 'car' : r < 0.74 ? 'taxi' : r < 0.81 ? 'truck' : ln.curb && r < 0.91 ? 'scooter' : 'car';
  }
  spawn(id, type, ln, s, R) {
    const c = VEH[type], pal = PAINT[type];
    const v0 = (ln.shared ? (type === 'scooter' ? 5.5 : 3.5) : c.v0) * (0.85 + 0.3 * R.next());
    return { id, type, lane: ln, s, ps: s, v: 0, v0, acc: 0, L: c.L, W: c.W, H: c.H, paint: pal[Math.floor(R.next() * pal.length)], weave: R.next(),
      arr: 0, dwell: null, dwellT: 0, hazard: false, brake: 0, jumped: true, hidden: false, nextPick: R.next() * 40, next: null, jx: 0, jz: 0, jhx: 0, jhz: 0, stepped: -1,
      still: 0, hsrc: -1e9, lc0: 0, lcN: -1e9, lcCool: 0, horn: 0, hold: -1, hin: -1, hout: -1, tk: -1, lcFrom: -1, next2: null, _riN: -1, _riM: -1, _ri: 0 };   // (P5: every field from birth: a restore never reshapes the object)
  }
  // the lane v takes after ln: approaches weighted toward straight on; lane index kept (buses keep the bus lane)
  pickNext(ln, v, R) {
    if (!ln.succ.length) return null;
    // (P4, life #3) lane discipline on multi-lane roads: right turns from the kerb lane, left turns from the innermost
    // general lane, the middle lanes straight on (P3 let any lane turn: a left-turner from a middle lane of Yanghwa-ro
    // waited the whole green for a gap and held every car behind it)
    const al = this.allowed(ln, v);
    let tot = 0; const w = ln.succ.map((g, i) => { if (!al[i]) return 0; const c = Math.max(0, g.turn); const x = 0.25 + 3 * c * c; tot += x; return x; });
    if (!tot) return null;
    let r = R.next() * tot, g = ln.succ[w.findLastIndex((x) => x > 0)];
    for (let i = 0; i < w.length; i++) if ((r -= w[i]) < 0) { g = ln.succ[i]; break; }
    // (P5) buses keep to their route: straight on along the bus lane (P4's could turn up Hongik-ro into Wausan-ro, a
    // 3.15 m roof under the low gates of INTO THE BAR ALLEY once the arterial flowed)
    if (v.type === 'bus') {   // (the straightest way on that has a bus lane; across a median link, one whose way out does)
      const busy = (q) => q.lanes.some((m) => m.bus) || (q.lanes[0].internal && q.lanes[0].succ.some((r) => r.turn > 0.7 && r.lanes.some((m) => m.bus)));
      let b = null; for (const q of ln.succ) if (busy(q) && (!b || q.turn > b.turn)) b = q;
      if (!b) for (const q of ln.succ) if (!b || q.turn > b.turn) b = q;
      g = b;
    }
    const L = g.lanes;
    if (v.type === 'bus') return L.find((m) => m.bus) || L[0];
    let k = Math.min(L.length - 1, ln.k); if (L[k].bus) k = Math.min(L.length - 1, k + 1);
    // (P5) a turn goes to the near lane of the road it turns into (right: the kerb lane; left: the innermost general one),
    // so it never cuts across the straight-on lane beside it (P4 kept the lane index: a right turn from World Cup-buk-ro's
    // kerb lane landed in Yanghwa-ro's third lane, through the car going straight next to it)
    if (g.turn <= 0.7 && !ln.shared && L.length > 1) { const h0 = L[0].h0, right = h0[0] * -ln.h1[1] + h0[1] * ln.h1[0] > 0; k = right ? L.length - 1 : L[0].bus ? 1 : 0; }
    if (L[k].bus) return null;
    return L[k];
  }
  allowed(ln, v) {
    const S = ln.succ, all = S.map(() => true);
    // a car never turns into an alley too narrow to pass an oncoming scooter (P3 only kept them out at spawn)
    if (ln.shared) { if (v.type !== 'car') return all; const ok = S.map((g) => (g.lanes[0].street.walkHalf ?? 0) >= 1.9); return ok; }
    if (S.length < 2 || v.type === 'bus') return all;
    if (!ln._allow) {   // per lane, once
      const same = this.lanes.filter((m) => m.street === ln.street && m.dir === ln.dir && !m.shared), n = same.length;
      const kmin = same.some((m) => m.bus) ? 1 : 0, side = S.map((g) => { const h0 = g.lanes[0].h0; return h0[0] * -ln.h1[1] + h0[1] * ln.h1[0]; });   // > 0: a right turn
      // (P5, life #1) where straight on narrows (World Cup-buk-ro's 2 general lanes into 1-lane Hongik-ro across the median),
      // only as many lanes as it has go straight; the kerb-side rest turn right (P4 sent both straight: the queue sat at 93 %)
      const capOf = (g) => { let c = g.lanes.length; if (g.lanes[0].internal) { let b = null; for (const q of g.lanes[0].succ) if (!b || q.turn > b.turn) b = q; if (b && b.turn > 0.7) c = Math.min(c, b.lanes.filter((m) => !m.bus).length); } return c; };
      const sg = S.findIndex((g) => g.turn > 0.7), cap = sg >= 0 ? capOf(S[sg]) : n, hasR = side.some((x, i) => x > 0 && S[i].turn <= 0.7);
      const out = S.map((g, i) => n < 2 ? true : g.turn > 0.7 ? !(hasR && ln.k - kmin >= cap && ln.k > kmin) : side[i] > 0 ? ln.k === n - 1 || (ln.k - kmin >= cap && ln.k > kmin) : ln.k === kmin);
      ln._allow = out.some(Boolean) ? out : S.map(() => true);
    }
    return ln._allow;
  }
  // (P3: s is a vehicle's centre; this compares rear bumpers, P2 took the whole length off)
  hasRoom(ln, need) { for (const o of ln.veh) if (!o.hidden && o.s - o.L / 2 < need) return false; return true; }
  enter(v, ln, s, R, carry) {   // move v into ln at s (carry: keep the world position continuous)
    const old = v.lane, i = old.veh.indexOf(v); if (i >= 0) old.veh.splice(i, 1);
    if (carry) {
      const a = this.pose(v, 1, {}), ps = v.ps - old.len, vs = v.s;
      // (P3) the ease is solved at the entry point itself, so a vehicle entering part-way in (an alley U-turn) doesn't jump
      v.lane = ln; v.s = s; v.ps = s; v.jx = 0; v.jz = 0; v.jhx = 0; v.jhz = 0; v.lcN = -1e9;
      const b = this.pose(v, 1, {}), f0 = s < 12 ? (1 - Math.max(0, s) / 12) ** 2 : 1;
      v.jx = (a.x - b.x) / f0; v.jz = (a.z - b.z) / f0; v.jhx = (a.hx - b.hx) / f0; v.jhz = (a.hz - b.hz) / f0; v.ps = s > 1 ? s : ps < s ? Math.max(-0.5, ps) : s; void vs;
    } else { v.lane = ln; v.s = s; v.ps = s; v.jx = v.jz = v.jhx = v.jhz = 0; v.jumped = true; }
    ln.veh.push(v); v.dwell = null; v.dwellT = 0; v.hazard = false; v.nextPick = s + 30 + R.next() * 150;
    v.next = v.next2 && v.next2.n2 === ln.idx ? v.next2.lane : this.pickNext(ln, v, R); v.next2 = null;
  }
  respawn(v, R) {   // re-enter the block at an entry lane (off-stage), or wait hidden until there is room
    const E = v.type === 'bus' && this.busEntries.length ? this.busEntries : this.entries[v.lane.shared ? 'shared' : 'road'];
    let ln = E[Math.floor(R.next() * E.length)], arr = this.n;
    // (P5) road traffic: the entry lane whose next arrival is due first takes it, at that time (each lane keeps its own rate)
    if (ln.hw) { for (const l of E) if (l.nextArr < ln.nextArr || (l.nextArr === ln.nextArr && l.idx < ln.idx)) ln = l; arr = Math.max(ln.nextArr, this.n + 1); ln.nextArr = arr + Math.floor(ln.hw * (0.4 + 1.2 * R.next())); }
    const type = this.pickType(ln, R), nv = this.spawn(v.id, type, ln, 0, R), old = v.lane;
    const i = old.veh.indexOf(v); if (i >= 0) old.veh.splice(i, 1);
    Object.assign(v, nv); v.lane = old; v.hidden = true; v.arr = arr;
    this.enter(v, ln, ln.shared && !ln.start ? v.L / 2 + 0.3 : 0, R, false); v.hidden = arr > this.n || !this.hasRoom(ln, v.L + 8);   // (P3: alley mouths: rear bumper at the kerb) v.v = v.hidden ? 0 : Math.min(v.v0, 6);
  }
  step() {
    const dt = this.dt, R = this.R, t = this.n * dt, N = this.n;
    this.events.length = 0;
    // who holds / waits for which junction box, as of the end of the last step (order-free: grants made during this step
    // are added as they happen, in the step's fixed lane/position order)
    const box = this.box || (this.box = new Map()); box.clear();
    const easing = this._easing || (this._easing = []); easing.length = 0;   // vehicles still easing out of a lane change
    for (const v of this.vehicles) {
      if (v.lcN > N - 3 * LIFE.trafficHz && v.lcFrom >= 0) easing.push(v);
      if (v.hidden) { if (v.hold >= 0) { v.hold = -1; v.tk = -1; } continue; }
      // already in the box without a grant (placed there at reset, or pushed past the entry): it holds the box now
      if (v.hold < 0 && v.next && v.lane.end && (v.lane.internal || v.s + v.L / 2 > v.lane.entry + 0.3)) { v.hold = v.lane.end.bid; v.hin = v.lane.idx; v.hout = v.next.idx; }
      if (v.hold >= 0) { let b = box.get(v.hold); if (!b) box.set(v.hold, (b = { hold: [], wait: [] })); b.hold.push(v); }
      if (v.tk >= 0 && v.hold < 0 && v.lane.end) { let b = box.get(v.lane.end.bid); if (!b) box.set(v.lane.end.bid, (b = { hold: [], wait: [] })); b.wait.push(v); }
    }
    const easeBy = this._easeBy || (this._easeBy = new Map()); easeBy.clear();   // (P4) per lane, once per step
    for (const l of easing) { let a = easeBy.get(l.lcFrom); if (!a) easeBy.set(l.lcFrom, (a = [])); a.push(l); }
    for (const ln of this.lanes) {
      const vs = ln.veh; vs.sort((a, b) => b.s - a.s || a.id - b.id); const eL = easeBy.get(ln.idx);
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i], c = VEH[v.type];
        if (v.stepped === N) continue;
        v.stepped = N; v.ps = v.s; v.jumped = false;
        if (v.hidden) { if (N >= v.arr && this.hasRoom(ln, v.L + 8)) { v.hidden = false; v.v = Math.min(v.v0, 6); v.jumped = true; } continue; }
        // leader: in this lane, else the last car of the lane we turn into
        let gap = Infinity, dv = 0, ldr = null;
        // bumper to bumper (P3: s is the centre; P2's l.s - l.L - v.s let a bus run 3 m into a car ahead)
        for (let j = i - 1; j >= 0; j--) { const l = vs[j]; if (!l.hidden) { gap = l.s - v.s - (l.L + v.L) / 2; dv = v.v - l.v; ldr = l; break; } }
        if (eL) for (const l of eL) if (l.lane !== ln && l.s > v.s && !l.hidden) { const g = l.s - v.s - (l.L + v.L) / 2; if (g < gap) { gap = g; dv = v.v - l.v; ldr = l; } }   // still easing out of this lane
        if (gap === Infinity && v.next) {
          let last = null; for (const o of v.next.veh) if (!o.hidden && (!last || o.s < last.s)) last = o;
          if (last) { gap = ln.len - v.s + last.s - (last.L + v.L) / 2; dv = v.v - last.v; ldr = last;
            // (P5) through a turn the bodies are closer than the lanes' lengths say (the hand-off cuts the corner): keep 3 m more
            if (last.s < 15) { const tn = ln._tn || (ln._tn = new Map()); let tu = tn.get(v.next.idx); if (tu === undefined) { tu = ln.succ.find((q) => q.lanes.includes(v.next))?.turn ?? 1; tn.set(v.next.idx, tu); } if (tu < 0.7) gap -= 3 * (1 - last.s / 15); } }
        }
        // signals (held: a red or amber ahead within 150 m, so the watchdog doesn't count the wait)
        let held = false, sig = Infinity;
        for (const st of ln.stops) {
          const d = st.s - v.s - v.L / 2; if (d < -0.5 || d > 150) continue;   // front bumper to the stop line (past it: committed)
          const ph = crossPhase(st.c, t);
          if (ph.car !== 'G') held = true;
          if (d > 120) continue;
          const stop = ph.car === 'R' || (ph.car === 'A' && d > v.v * v.v / (2 * c.b) + 1);
          if (stop && d < sig) sig = d;
          if (stop && d < gap) { gap = Math.max(0.01, d); dv = v.v; }
          if (stop && v.hold >= 0 && ln.end && v.hold === ln.end.bid && !ln.internal && d > -0.5) { v.hold = -1; v.tk = -1; }   // (P3) caught by the light: let the box go
          else if (stop && v.hold < 0) v.tk = -1;   // (P5) and its ticket: P4 kept it, so a car waiting at a red stayed first in the box's FIFO and held the crossing axis out through its green
        }
        // junction box (life #3, P3): within braking distance of the entry, ask for the box; until it is granted the entry is
        // a stop line (and the wait is explained, so the watchdog leaves it alone)
        if (v.next && ln.end && v.hold !== ln.end.bid) {
          const d = (ln.boxStop != null && v.s + v.L / 2 < ln.boxStop + 0.5 ? ln.boxStop : ln.entry) - (v.s + v.L / 2);
          // ask only when nothing else (a leader, a red light) stops it short of the line (P3: a vehicle granted the box then
          // held at a red kept the crossing axis out of it through its own green: gridlock)
          if (d < v.v * v.v / (2 * c.b) + 3 && gap >= d - 0.5 && sig > d + 0.5) {   // (P5) not against its own red
            // the minor road yields (+2 s), and so do turns and median crossings (+6 s: they wait for a gap in the straight flow)
            if (v.tk < 0) { const g = ln.succ.find((q) => q.lanes.includes(v.next)); v.tk = N + (ln.shared || ln.street.kind !== 'main' ? 2 * LIFE.trafficHz : 0) + ((g && g.turn < 0.7) || v.next.internal ? 6 * LIFE.trafficHz : 0); }
            if (this.grant(v, ln, ln.end, N)) { v.hold = ln.end.bid; v.hin = ln.idx; v.hout = v.next.idx; }
            else { if (N - v.tk < 40 * LIFE.trafficHz) held = true; if (d < gap) { gap = Math.max(0.01, d); dv = v.v; } }   // a 40 s box wait is a jam: the watchdog may act
          }
        }
        // through: release once the rear bumper is out of the box, or (a connector too short for that) at its next line
        // (any lane past the box: a lane change on the way out must not keep the box held)
        if (v.hold >= 0 && v.lane.idx !== v.hin) {
          if (ln.internal && v.next && ln.end.bid === v.hold) { if (v.lane.idx === v.hout) { v.hin = ln.idx; v.hout = v.next.idx; } }   // a junction's internal link: the movement goes on
          else if (!ln.start || ln.start.bid !== v.hold || v.s - v.L / 2 > ln.clear || (ln.end && v.s + v.L / 2 > ln.entry - 0.5)) { v.hold = -1; v.tk = -1; }
        }
        // dwell (taxi pick-up, bus stop); no exit: slow for the end of the lane only when it is a dead end on stage
        if (v.dwell != null) { const d = v.dwell - v.s; if (d < gap) { gap = Math.max(0.01, d); dv = v.v; } }
        // IDM. (P5, life #1) a Friday-night cruise under Seoul's 5030 limits: ~38 km/h on the arterial carriageways, ~29 on the
        // other roads (ln.vlim; P4 drove Hongik-ro at 47 km/h)
        const v0 = v.v0 < ln.vlim ? v.v0 : ln.vlim;
        const sstar = c.s0 + Math.max(0, v.v * c.T + v.v * dv / (2 * Math.sqrt(c.a * c.b)));
        const r = v.v / v0, r2 = r * r;
        let a = c.a * ((r > 1.1 ? -1 : 1 - r2 * r2) - (gap === Infinity ? 0 : (sstar / gap) * (sstar / gap)));   // (over a new limit: ease down)
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
        // (P3) an alley cut short by a road's band ends at the kerb: turn there with the front bumper, not the centre, at it
        const lend = ln.shared && !ln.end ? ln.len - v.L / 2 - 0.3 : ln.len;
        if (v.s > lend) {
          const nx = v.next;
          if (nx && !this.hasRoom(nx, v.s - ln.len + v.L / 2 + 0.5)) { v.s = ln.len; v.v = 0; }   // merge conflict: wait at the line
          else if (nx) { this.enter(v, nx, v.s - ln.len, R, true); i--; }
          else if (ln.shared && !(ln.end && ln.end.boundary) && this.twin.get(ln)) { const tw = this.twin.get(ln); if (this.hasRoom(tw, 1.5 + v.L)) { this.enter(v, tw, v.L / 2 + 0.3, R, true); v.v *= 0.3; i--; } else { v.s = lend; v.v = 0; } }
          else { this.respawn(v, R); i--; }
        }
      }
    }
    if (this.n % 15 === 0) this.laneChanges(t, R);
    this.n++;
  }
  // ---- junction boxes (life #3, P3). A movement is (in-lane, out-lane). Two movements conflict when their swept paths
  // (centre lines, the hand-off ease included) come within (Wa + Wb) / 2 + 0.4 m inside the box; the same in-lane never
  // conflicts with itself (IDM follows). Grant: no conflicting holder, room on the out-lane for the whole vehicle (don't
  // block the box), and no conflicting earlier ticket still waiting that could go itself (FIFO; minor roads +2 s).
  grant(v, ln, node, N) {
    const b = this.box.get(node.bid), nx = v.next;
    if (!this.roomOut(v, nx)) return false;
    if (b) {
      for (const h of b.hold) if (h !== v && h.hold === node.bid && h.hin !== ln.idx && this.blocks(h, ln.idx, nx.idx, v.W)) return false;   // (a holder respawned this step has let go)
      // FIFO: an earlier conflicting ticket with room ahead that could go now (or has waited 15 s: the box drains for it) goes first
      for (const w of b.wait) if (w !== v && w.tk < v.tk && w.lane !== ln && w.next && w.lane.end && w.lane.end.bid === node.bid && this.conflict(ln.idx, nx.idx, w.lane.idx, w.next.idx, v.W, w.W) && this.roomOut(w, w.next)
        && (N - w.tk > 15 * LIFE.trafficHz || !b.hold.some((h) => h !== w && h.hold === node.bid && h.hin !== w.lane.idx && this.blocks(h, w.lane.idx, w.next.idx, w.W)))) return false;
    } else this.box.set(node.bid, { hold: [], wait: [] });
    // and its swept path must clear anyone queued at another entry line of this node (the hand-off ease reaches past the box)
    if (!this.pathClear(ln.idx, nx.idx, v, node)) return false;
    this.box.get(node.bid).hold.push(v);
    return true;
  }
  pathClear(a, b, v, node) {
    const P = this.mvPath(a, b), o = this._pc || (this._pc = {});
    const IL = this._inL || (this._inL = new Map());   // per sim: the net (and its nodes) is shared with seoul-movers' private sims
    let ins = IL.get(node.bid); if (!ins) IL.set(node.bid, (ins = this.lanes.filter((m) => m.end && m.end.bid === node.bid && !m.internal)));
    for (const m of ins) {
      if (m.idx === a || !m.veh.length) continue;
      for (const q of m.veh) {
        if (q === v || q.hidden || q.hold === node.bid || q.s + q.L / 2 < m.entry - 0.5) continue;   // (short of the line: clear by construction)
        this.pose(q, 1, o); const hw = q.W / 2 + v.W / 2 + 0.25, hl = q.L / 2 + 0.4;
        for (let i = 0; i < P.length; i += 2) { const dx = P[i] - o.x, dz = P[i + 1] - o.z, lz = dx * o.hx + dz * o.hz, lx = dx * o.hz - dz * o.hx; if (Math.abs(lx) < hw && Math.abs(lz) < hl) return false; }
      }
    }
    // (P5) and any other in-lane's holder whose body is on the path now, wherever it is (a late-amber car still leaving the
    // box as the crossing axis's platoon arrives at speed on its green: the centre-line test passed them 0.6 m into each other)
    const B = this.box.get(node.bid);
    if (B) for (const h of B.hold) {
      if (h === v || h.hidden || h.hold !== node.bid || h.hin === a) continue;
      this.pose(h, 1, o); const hw = h.W / 2 + v.W / 2 + 0.25, hl = h.L / 2 + 0.4;
      for (let i = 0; i < P.length; i += 2) { const dx = P[i] - o.x, dz = P[i + 1] - o.z, lz = dx * o.hx + dz * o.hz, lx = dx * o.hz - dz * o.hx; if (Math.abs(lx) < hw && Math.abs(lz) < hl) return false; }
    }
    return true;
  }
  // room to get the whole vehicle out of the box; into a box's internal link (across the median) only an empty link with
  // room on the way out of it (chosen now, and kept), so nobody waits inside a box they hold
  // (P5, life #1) a vehicle already moving off at > 2.5 m/s leaves room by the time the next one gets there: P4 counted it
  // as a blockage, so a platoon went through the box one car per ~40 m of the leader's travel (550 veh/h of green per lane
  // on Yanghwa-ro against ~1,800 saturation) and every median crossing waited for an empty link
  roomOut(v, nx) {
    if (!this.roomMoving(nx, Math.min(nx.clear + v.L + 1, nx.entry - 0.5)) || !this.roomRed(v, nx)) return false;
    if (nx.internal) {
      if (nx.veh.some((o) => !o.hidden && o.v < 2.5)) return false;
      if (!v.next2 || v.next2.n2 !== nx.idx) { const c = this.pickNext(nx, v, this.R); v.next2 = c ? { lane: c, n2: nx.idx } : null; }
      const c = v.next2 && v.next2.lane; if (c && !this.roomMoving(c, Math.min(c.clear + v.L + 1, c.entry - 0.5))) return false;
    }
    return true;
  }
  // (P5) and room before a red just past the box: a crosswalk 20 m down the exit (Wausan-ro's, off the Hongik-ro junction)
  // queued turners back into the box, across the crossing flow
  roomRed(v, nx) {
    const st = nx.stops[0]; if (!st || st.s > nx.clear + v.L + 20 || crossPhase(st.c, this.n * this.dt).car === 'G') return true;
    let used = 0; for (const o of nx.veh) if (!o.hidden && o.s < st.s) used += o.L + 2;
    return st.s - nx.clear - used >= v.L + 1;
  }
  roomMoving(ln, need) { for (const o of ln.veh) if (!o.hidden && o.s - o.L / 2 < need && (o.v < 2.5 || o.acc < -1 || o.dwell != null)) return false; return true; }   // (moving off, not braking to a stop)
  // (P4, life #3: AIM-style conflict cells) a holder blocks movement (a -> b) only until its rear bumper has cleared the last
  // point of its own swept path that comes within reach of (a -> b): crossing flows follow each other through the box a
  // car length apart instead of waiting for the whole box to empty (P3: 129 grants in 300 s at the Yanghwa-ro box, 79 %
  // of main-road traffic standing). A conflict on an internal link's onward branches holds until the holder is past them.
  blocks(h, a, b, w) {
    if (!this.conflict(a, b, h.hin, h.hout, w, h.W)) return false;
    const k = ((h.hin * 4096 + h.hout) * 4096 + a) * 4096 + b; let e = this.mvEnd.get(k);   // (numeric keys: no garbage in the step)
    if (e === undefined) {
      const P = this.mvPath(h.hin, h.hout), Q = this.mvPath(a, b), thr = (w + h.W) / 2 + 0.4, t2 = thr * thr; e = -1;
      const near = (i) => { for (let j = 0; j < Q.length; j += 2) { const dx = P[i] - Q[j], dz = P[i + 1] - Q[j + 1]; if (dx * dx + dz * dz < t2) return true; } return false; };
      for (let i = P.n0; i < P.length && e < 0; i += 2) if (near(i)) e = Infinity;   // onward branches first
      for (let i = P.n0 - 2; i >= 0 && e < 0; i -= 2) if (near(i)) e = i >> 1;          // then the last conflicting sample
      this.mvEnd.set(k, e);
    }
    return e === Infinity || this.rearIdx(h) <= e + 1;
  }
  // index of the primary path sample nearest the holder's rear bumper, once per step
  rearIdx(h) {
    if (h._riN === this.n && h._riM === h.hin * 4096 + h.hout) return h._ri;
    const P = this.mvPath(h.hin, h.hout), o = this.pose(h, 1, this._rp || (this._rp = {})), rx = o.x - o.hx * h.L / 2, rz = o.z - o.hz * h.L / 2;
    let best = 0, bd = Infinity; for (let i = 0; i < P.n0; i += 2) { const dx = P[i] - rx, dz = P[i + 1] - rz, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = i >> 1; } }
    h._riN = this.n; h._riM = h.hin * 4096 + h.hout; h._ri = best; return best;
  }
  conflict(a, b, c, d, wa, wb) {
    if (a === c) return false;
    const k = a < c ? ((a * 4096 + b) * 4096 + c) * 4096 + d : ((c * 4096 + d) * 4096 + a) * 4096 + b;
    let m = this.mvDist.get(k);
    if (m === undefined) {
      const P = this.mvPath(a, b), Q = this.mvPath(c, d); m = Infinity;
      for (let i = 0; i < P.length; i += 2) for (let j = 0; j < Q.length; j += 2) { const dx = P[i] - Q[j], dz = P[i + 1] - Q[j + 1], e = dx * dx + dz * dz; if (e < m) m = e; }
      m = Math.sqrt(m); this.mvDist.set(k, m);
    }
    return m < (wa + wb) / 2 + 0.4;
  }
  mvPath(a, b) {   // centre-line samples [x, z, ...] of the movement lane a -> lane b, from 2 m before a's entry to b's clear + 4 m
    const k = a * 4096 + b; let P = this.mvGeo.get(k); if (P) return P;
    const A = this.lanes[a], B = this.lanes[b], o = {}, at = (ln, s) => { ln.base.at(this.toBase(ln, s), o); return [o.x + o.nx * ln.lat, o.z + o.nz * ln.lat]; };
    P = []; for (let s = Math.max(0, A.entry - 2); s < A.len; s += 0.75) P.push(...at(A, s));
    const e = at(A, A.len), b0 = at(B, 0), jx = e[0] - b0[0], jz = e[1] - b0[1];
    for (let s = 0; s <= (B.internal ? B.len : Math.min(B.len, B.clear + 4)); s += 0.75) { const f = s < 12 ? (1 - s / 12) ** 2 : 0, q = at(B, s); P.push(q[0] + jx * f, q[1] + jz * f); }
    this.mvGeo.set(k, P); P.n0 = P.length;
    // into a box's internal link: every way on out of it too (the grant covers the whole crossing)
    if (B.internal) for (const g of B.succ) for (const c of g.lanes) if (!c.internal) { const Q = this.mvPath(b, c.idx); for (const x of Q) P.push(x); }
    return P;
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
    // a vehicle still easing out of a lane (3 s) is in it too (P3: two taxis moved left a lane each in one pass and drove
    // side by side through each other for 3 s)
    const eas = this.vehicles.filter((o) => o.lcFrom >= 0 && this.lcOffset(o));
    const occ = (ln, f) => { for (const o of ln.veh) f(o); for (const o of eas) if (o.lcFrom === ln.idx && o.lane !== ln) f(o); };
    const lead = (ln, s, skip) => { let b = null; occ(ln, (o) => { if (o !== skip && !o.hidden && o.s > s && (!b || o.s < b.s)) b = o; }); return b; };
    const foll = (ln, s, skip) => { let b = null; occ(ln, (o) => { if (o !== skip && !o.hidden && o.s <= s && (!b || o.s > b.s)) b = o; }); return b; };
    for (const ln of this.lanes) {
      if (!ln.adj.length || !ln.veh.length) continue;
      const vs = ln.veh.slice().sort((a, b) => b.s - a.s || a.id - b.id);
      for (const v of vs) {
        if (v.hidden || v.dwell != null || v.type === 'bus' || v.lane !== ln) continue;
        if (v.lcCool > this.n) continue;
        if (v.s < 8 || ln.len - v.s < 25 || ln.stops.some((st) => st.s - v.s > -2 && st.s - v.s < 25)) continue;
        const c = VEH[v.type], L0 = lead(ln, v.s, v);
        const gap0 = L0 ? L0.s - v.s - (L0.L + v.L) / 2 : Infinity, blocked = L0 && (L0.dwell != null || L0.still > 3 * LIFE.trafficHz) && gap0 < 30;
        const a0 = this.idm(c, v.v, v.v0, gap0, L0 ? v.v - L0.v : 0);
        let best = null, bestG = blocked ? 0.05 : 0.3;
        for (const m of ln.adj) {
          if (m.bus || m.s1 - m.s0 < ln.len - 1) continue;
          const Ln = lead(m, v.s, v), Fn = foll(m, v.s, v);
          const gapN = Ln ? Ln.s - v.s - (Ln.L + v.L) / 2 : Infinity, gapF = Fn ? v.s - Fn.s - (v.L + Fn.L) / 2 : Infinity;
          if (gapN < 1.5 || gapF < 1.5) continue;
          const aN = this.idm(c, v.v, v.v0, gapN, Ln ? v.v - Ln.v : 0);
          let cost = 0;
          if (Fn) { const cf = VEH[Fn.type], aF = this.idm(cf, Fn.v, Fn.v0, gapF, Fn.v - v.v); if (aF < -3) continue; cost = Math.max(0, this.idm(cf, Fn.v, Fn.v0, Ln ? Ln.s - Fn.s - (Ln.L + Fn.L) / 2 : Infinity, Ln ? Fn.v - Ln.v : 0) - aF); }
          const g = aN - a0 - 0.25 * cost - (m.k > ln.k ? 0 : 0.05);   // a slight keep-right preference
          if (g > bestG) { bestG = g; best = m; }
        }
        if (!best) continue;
        // execute: same base path and s range, so only the lateral position changes (eased over 3 s in pose())
        const i = ln.veh.indexOf(v); ln.veh.splice(i, 1); best.veh.push(v);
        v.lc0 = this.lcOffset(v) + (ln.lat - best.lat) * ln.dir * best.dir; v.lcN = this.n; v.lane = best; v.lcFrom = ln.idx; v.lcCool = this.n + Math.floor((6 + R.next() * 6) * LIFE.trafficHz);
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
    if (ln.shared) {   // (P3) alleys: keep to your side by your own width, so a car and an oncoming scooter pass (P2: both at
      // +-0.56 m, through each other); a car in an alley too narrow to pass takes what room there is
      const wh = ln.street.walkHalf ?? 1.6;
      lat = ln.dir * Math.max(0.2, Math.min(v.W / 2 + (v.type === 'scooter' ? 0.45 : 0.15), wh - v.W / 2 - 0.1));
      if (v.type === 'scooter') {   // alley weave: a parabolic sine (integer-free arithmetic only, no Math.sin: native #3)
        let u = s / 56.5 + v.weave; u -= Math.floor(u); u = 2 * u - 1;           // [-1, 1), one wiggle per 56.5 m
        lat += ln.dir * 0.25 * 4 * u * (1 - Math.abs(u));
      }
    }
    if (ln.shel) {   // fanning out round a BUS SHELTER island
      const a = Math.abs(s - ln.shel.sc), R = 18, h = ln.shel.half;
      if (a < h + R) { const u = a < h ? 1 : 1 - (a - h) / R, f = u * u * (3 - 2 * u); lat += ln.shel.d * f;
        if (a > h) { const df = 6 * u * (1 - u) / R * (s > ln.shel.sc ? -1 : 1); dlat += ln.shel.d * df; } }
    }
    if (v.lcN > -1e8) {   // easing out of a lane change: offset and the yaw that goes with it
      const n = this.n - 1 + (v.jumped ? 1 : alpha), o0 = this.lcOffset(v, n);
      if (o0) { lat += o0; dlat += (this.lcOffset(v, n + 1) - o0) * LIFE.trafficHz / Math.max(1, v.v); }
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

// ---------------------------------------------------------------- crowd (closed form, G / phase 2)
// Every person is a pure function of (seed, take clock): no stepping, no state, any t costs the same, rewinds are free,
// and a replay, an HQ re-render or a hit test at tick t all see the same street (life #1). Kinds:
//   walkers   units of 1-4 people on door-to-door trips: out of a shop door (or exit 9, or a map edge), along walkways and
//             across junction corners, into another door. Trip k of a unit is generated from hash(seed, unit, k), so
//             people only appear or vanish in doorways, at the exit 9 stair mouth and at the map edge, never mid-street.
//   standing  chatting clusters and smokers off shop doors; they shuffle, turn and change what they're doing every 15-45 s
//   queue     club queues in pairs; the door admits 1-3 every 20-60 s, the line steps up, newcomers walk in at the tail
//   busk      busking rings (performers + 20-60 in an arc, phones up, applause at the end of each song)
//   seat      pocha tables
//   cross     crowds that bunch at the kerb and surge over the crosswalk on the walk phase, cycle by cycle
// Walkers sidestep each other and standing people (static discs) near the camera only (< 45 m), statelessly: the offset
// is a smooth function of who is where at t, so it never pops. Hit tests use the un-avoided positions (camera-free).
export const P_WALK = 0, P_PHONE = 1, P_IDLE = 2, P_SIT = 3, P_TALK = 4, P_SMOKE = 5, P_FILM = 6, P_DANCE = 7, P_SING = 8, P_CLAP = 9, P_FLINCH = 10;
export const K_WALK = 0, K_STAND = 1, K_QUEUE = 2, K_SEAT = 3, K_CROSS = 4, K_BUSK = 5, K_PERF = 6, K_DOOR = 7;
export function h32(a, b = 0, c = 0) {
  let h = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85EBCA77) ^ Math.imul((c | 0) + 0x165667b1, 0xC2B2AE3D)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D) >>> 0; h ^= h >>> 12; h = Math.imul(h, 0x297A2D39) >>> 0; h ^= h >>> 15; return h >>> 0;
}
const hu = (a, b, c) => h32(a, b, c) / 4294967296;
// sin/cos without libm (native parity, P3): every standing or seated person is a SCRAPE capsule, so their placement must be
// bit-identical on a port; range-reduced odd/even minimax polynomials, |error| < 2e-7, IEEE +,* only
export function psin(x) {
  const TAU = 6.283185307179586; let k = Math.floor(x / TAU + 0.5); x -= k * TAU;   // [-pi, pi]
  let sg = 1; if (x > 1.5707963267948966) x = 3.141592653589793 - x; else if (x < -1.5707963267948966) x = -3.141592653589793 - x; void sg;
  const x2 = x * x; return x * (1 + x2 * (-0.16666666666666666 + x2 * (0.008333333333333333 + x2 * (-0.0001984126984126984 + x2 * (2.7557319223985893e-6 + x2 * (-2.505210838544172e-8 + x2 * 1.6059043836821613e-10))))));
}
export const pcos = (x) => psin(x + 1.5707963267948966);
const wrapA = (a) => a - Math.round(a / 6.283185307179586) * 6.283185307179586;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
// how much door traffic a frontage makes (people in and out per unit of frontage), by use
const DOOR_W = { conv: 3, cafe: 2, restaurant: 2, bar: 2, karaoke: 2, pc: 1.5, shop: 1.5, pocha: 1.2, motel: 0.5, hotel: 0.8, office: 0.3, club: 0.6 };

// ---- busking sites from E's set pieces (life #5, P3). UNDER THE STAGE (seoul-dressing.js): a 9 x 5.6 m canopy against the
// building line, `dir` along the street, the deck (0.32 m) on the building side, `crowdRing.c` 2.52 m street-side of `pos`.
// The crew dances on the deck 1.4 m off the back wall facing the street; the crowd stands in an arc 2.2-5 m in front, its
// mass on crowdRing.c. Returns { sites, deck } (deck: [x, z, r] discs for the walkers to go round).
export function buskSitesFrom(pieces = []) {
  const sites = [], deck = [], keep = [];
  for (const p of pieces || []) {
    if (!p || !p.pos || !/busk|stage/i.test((p.kind || '') + ' ' + (p.id || ''))) continue;
    const c = p.crowdRing?.c;
    if (p.busk && p.busk.pos) {   // E's P3 stage: performers at busk.pos facing busk.yaw, the crowd round crowdRing.c, canopy {c, len, dep}
      const B = p.busk, yaw = B.yaw ?? p.yaw ?? 0, fx = psin(yaw), fz = pcos(yaw), r = B.r || [2.6, 4.1];
      sites.push({ pos: B.pos, yaw, kind: B.kind || 'dance', n: p.n ?? 56, arc: B.arc ?? 1.95, r0: r[0], y0: B.pos[1] > 0.05 ? B.pos[1] : 0, piece: p.id, ring: c ? { c: [c[0], c[2]], r: p.crowdRing.r ?? 3.2 } : null });
      const cc = p.canopy?.c || p.pos; keep.push({ x: cc[0], z: cc[2], ax: fz, az: -fx, sx: fx, sz: fz, hx: (p.canopy?.len ?? 9) / 2 + 0.4, hz: (p.canopy?.dep ?? 5.6) / 2 + 0.4 });
      continue;
    }
    if (c) {
      let sx = c[0] - p.pos[0], sz = c[2] - p.pos[2]; const l = Math.hypot(sx, sz) || 1; sx /= l; sz /= l;   // toward the street
      const px = p.pos[0] - sx * 1.4, pz = p.pos[2] - sz * 1.4, ax = p.dir ? p.dir[0] : -sz, az = p.dir ? p.dir[2] : sx;
      sites.push({ pos: [px, 0, pz], yaw: Math.atan2(sx, sz), kind: 'dance', n: p.n ?? 56, arc: 0.9, r0: 2.6, y0: (p.deck ?? 0.32), piece: p.id, ring: { c: [c[0], c[2]], r: p.crowdRing.r ?? 3.2 } });
      for (let u = -3; u <= 3.01; u += 1.5) deck.push([p.pos[0] - sx * 1.5 + ax * u, p.pos[2] - sz * 1.5 + az * u, 0.75]);
      keep.push({ x: p.pos[0], z: p.pos[2], ax, az, sx, sz, hx: 4.9, hz: 3.0 });
    } else sites.push({ pos: p.pos, yaw: p.yaw ?? 0, kind: p.busk || 'dance', n: p.n, piece: p.id });
  }
  return { sites, deck, areas: keep };
}
function mergeBuskSites(pieces, defaults) {
  const out = pieces.slice();
  defaults.forEach((d, i) => {
    if (out.some((p) => Math.hypot(p.pos[0] - d.pos[0], p.pos[2] - d.pos[2]) < 30)) return;
    out.push(pieces.length && i === 0 ? { ...d, kind: 'acoustic', n: 34 } : d);   // with E's dance stage, the default stage spot goes acoustic
  });
  return out;
}
// E's obstacle discs as the crowd sees them: inside a set-piece canopy only its deck counts (E's occupancy discs fill the
// whole footprint so nothing else gets dressed there; the crowd stands under it)
export function crowdObstacles(obstacles, bs) {
  const out = [];
  for (const o of obstacles || []) {
    if (!o || !(o[2] > 0)) continue;
    if (bs && bs.areas.some((A) => { const dx = o[0] - A.x, dz = o[1] - A.z; return Math.abs(dx * A.ax + dz * A.az) < A.hx && Math.abs(dx * A.sx + dz * A.sz) < A.hz; })) continue;
    out.push(o);
  }
  if (bs) out.push(...bs.deck);
  return out;
}

// (P4, life #4) a point pushed off every main carriageway to its kerb + margin -> [x, z] with .moved (m); skip: a road it may stand next to
export function offRoad(mains, x, z, margin = 0.5, skip = null) {
  let moved = 0;
  for (const m of mains) {
    if (m === skip) continue; const pr = m.path.project(x, z), lim = m.carHalf + margin;
    if (pr.dist >= lim || pr.s <= 0.5 || pr.s >= m.path.len - 0.5) continue;
    const o = m.path.at(pr.s, {}), sg = pr.d >= 0 ? 1 : -1, nx2 = o.x + o.nx * sg * lim, nz2 = o.z + o.nz * sg * lim;
    moved += Math.hypot(nx2 - x, nz2 - z); x = nx2; z = nz2;
  }
  const out = [x, z]; out.moved = moved; return out;
}

export class CrowdSim {
  constructor(net, layout, { seed = 1, density = 1, maxAgents = LIFE.maxAgents, sites = null, obstacles = null, holes = null, puddles = null } = {}) {
    this.net = net; this.layout = layout; this.seed = seed >>> 0; this.density = density; this.maxAgents = maxAgents;
    // (P5) E's ground openings (stairwells, [[x, z], ...] polygons): nobody stands in one (P4 put 4-5 of exit 9's waiting
    // ring inside the stair dive)
    this.holes = (holes || []).filter((h) => Array.isArray(h) && h.length >= 3);
    // E's dressing discs [[x, z, r]] (life #6: carts, tents, stalls, parked scooters): walkers sidestep them, nobody stands in one
    this.dress = (obstacles || []).filter((o) => o && o[2] > 0 && o[2] < 1.7);
    // (P8, life: keep people off E's puddles) E's standing water at the post bases ([x, z, tx, tz, a, b]: centre, long axis,
    // half-axes; seoul-dressing `puddles`): walkers step round them (render side, like the dressing discs: a chain of discs
    // along the long axis in each walkway's avoidance). Nobody is placed standing in one already (0 of all statics), and
    // re-placing the statics round them dropped 21 % of the standing clusters near the cameras: left as placed
    this.pud = (puddles || []).filter((q) => Array.isArray(q) && q.length >= 6 && q[4] > 0 && q[5] > 0);
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
    const o = {};
    const SK = LIFE.streetK || {};
    this.ways.forEach((w, i) => {
      w.idx = i; w.len = w.s1 - w.s0; w.area = w.len * (w.dmax - w.dmin); w.sk = SK[w.street.ko] ?? SK[w.street.name] ?? SK[w.street.id] ?? 1;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let s = w.s0; s <= w.s1 + 1e-6; s += Math.max(2, w.len / 24)) { w.base.at(s, o); x0 = Math.min(x0, o.x); x1 = Math.max(x1, o.x); z0 = Math.min(z0, o.z); z1 = Math.max(z1, o.z); }
      const pad = Math.max(Math.abs(w.c) + w.dmax, 4); w.box = [x0 - pad, x1 + pad, z0 - pad, z1 + pad];
    });
    // junctions: each walkway end -> the walkways it touches
    for (const w of this.ways) {
      w.ends = [w.s0, w.s1].map((s) => {
        w.base.at(s, o); const x = o.x + o.nx * w.c, z = o.z + o.nz * w.c, out = [];
        for (const u of this.ways) {
          if (u === w) continue; const pr = u.base.project(x, z), d = pr.d - u.c;
          // (pr.dist too: project()'s signed d is the perpendicular part only, so past a polyline's end it linked
          // walkways hundreds of metres away along the extension line)
          if (pr.dist > Math.abs(u.c) + Math.max(-u.dmin, u.dmax) + 3.5) continue;
          if (pr.s >= u.s0 - 1 && pr.s <= u.s1 + 1 && d > u.dmin - 3.5 && d < u.dmax + 3.5) out.push({ way: u, s: Math.min(u.s1 - 0.5, Math.max(u.s0 + 0.5, pr.s)), d: Math.min(u.dmax, Math.max(u.dmin, d)) });
        }
        return out;
      });
    }
    this.boundaryEnds = [];
    this.ways.forEach((w) => w.ends.forEach((e, k) => { if (!e.length) { const n = w.street.n[k === 1 ? (w.s1 > w.street.path.len - 0.5 ? 1 : -1) : (w.s0 < 0.5 ? 0 : -1)]; if (n && n.boundary) this.boundaryEnds.push({ way: w, k }); } }));
    this.lots = (layout.lots || []).filter((l) => l.frontage && l.frontage.length === 2);
    this.sites = sites;
    this.buildDoors(layout);
    this.buildKeepOut();
    this.buildPeople(layout);
    const N = this.people.length;
    // dynamic state (what evaluate(t) writes): position, heading, gait phase, walk amount, pose, visible
    this.X = new Float32Array(N); this.Z = new Float32Array(N); this.YAW = new Float32Array(N); this.PH = new Float32Array(N);
    this.WALK = new Float32Array(N); this.POSE = new Uint8Array(N); this.VIS = new Uint8Array(N);
    this.WAY = new Int16Array(N); this.WS = new Float32Array(N); this.WD = new Float32Array(N); this.WDIR = new Int8Array(N);
    this.events = [];   // door in/out near the camera since the last evaluate (sound: shop chimes)
    this.t = -1; this.n = 0;
  }
  // (P4, life #4) a standing spot pushed off every carriageway to its kerb + margin (deterministic: no extra draws).
  // -> [x, z] with .moved = how far it went (skip: a road it may stand next to)
  offRoad(x, z, margin = 0.5, skip = null) { return offRoad(this.net.mains, x, z, margin, skip); }
  // ---- portals: shop doors (by use), the exit 9 stair mouth, map-edge walkway ends
  buildDoors(layout) {
    const o = {}, byStreet = new Map();
    for (const w of this.ways) { w.doors = []; let l = byStreet.get(w.street.id); if (!l) byStreet.set(w.street.id, (l = [])); l.push(w); }
    for (const [li, l] of this.lots.entries()) {
      const wt = DOOR_W[l.use] ?? 1, ws = byStreet.get(l.street); if (!wt || !ws) continue;
      const [a, b] = l.frontage, u = 0.3 + 0.4 * hu(this.seed, li, 3);
      const fx = a[0] + (b[0] - a[0]) * u, fz = a[1] + (b[1] - a[1]) * u, st = ws[0].street, pr = st.path.project(fx, fz);
      let w = ws[0];
      if (st.kind === 'main') { w = ws.find((q) => q.side === (pr.d >= 0 ? 1 : -1)); if (!w) continue; }
      if (pr.s < w.s0 + 1 || pr.s > w.s1 - 1) continue;
      const dl = pr.d - w.c, edge = dl >= 0 ? w.dmax : w.dmin;
      if (Math.abs(dl - edge) > 5 && Math.abs(dl) > Math.abs(edge)) continue;   // facade too far from the walkway band
      w.doors.push({ s: pr.s, d: Math.max(w.dmin, Math.min(w.dmax, dl)), x: fx, z: fz, wt: wt * Math.min(3, Math.hypot(b[0] - a[0], b[1] - a[1]) / 8), use: l.use, lot: l.id });
    }
    // side and corner entrances: any building wall (footprint edge > 4 m) right on a walkway's facade line, where that
    // walkway has no door within 6 m (main-road sidewalks and alleys get doors from buildings fronting other streets)
    for (const l of layout.lots || []) {
      const f = l.footprint; if (!f || f.length < 3) continue;
      for (let e = 0; e < f.length; e++) {
        const a = f[e], b = f[(e + 1) % f.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 4) continue;
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        for (const w of this.ways) {
          if (mx < w.box[0] || mx > w.box[1] || mz < w.box[2] || mz > w.box[3]) continue;
          const pr = w.base.project(mx, mz); if (pr.s < w.s0 + 1 || pr.s > w.s1 - 1) continue;
          const dl = pr.d - w.c, edge = dl >= 0 ? w.dmax : w.dmin;
          if (Math.abs(dl) < Math.abs(edge) - 0.2 || Math.abs(dl - edge) > 6) continue;
          if (w.doors.some((d) => Math.abs(d.s - pr.s) < 6)) continue;
          w.doors.push({ s: pr.s, d: edge, x: mx, z: mz, wt: 0.5 * Math.min(2, L / 8), use: l.use || 'shop', lot: l.id, side: true });
        }
      }
    }
    const ex = (layout.hero || []).find((h) => /exit/i.test(h.id || ''));
    if (ex) {
      let best = null;
      // (P6) the true distance to the walkway band (project()'s signed d is the perpendicular part only: past a polyline's
      // end it put the portal on an alley 90 m away, and exit 9's people walked a diagonal through the block)
      for (const w of this.ways) { const pr = w.base.project(ex.pos[0], ex.pos[2]); if (pr.s < w.s0 || pr.s > w.s1) continue; const P = this.wayPoint(w, pr.s, Math.max(w.dmin, Math.min(w.dmax, pr.d - w.c)), {}), d = Math.hypot(P.x - ex.pos[0], P.z - ex.pos[2]); if (!best || d < best.d) best = { w, pr, d }; }
      if (best && best.d < 10) best.w.doors.push({ s: best.pr.s, d: Math.max(best.w.dmin, Math.min(best.w.dmax, best.pr.d - best.w.c)), x: ex.pos[0], z: ex.pos[2], wt: 40, use: 'exit', portal: 'exit' });
      this.exitPortal = best ? { x: ex.pos[0], z: ex.pos[2], way: best.w.idx } : null;
    }
    for (const be of this.boundaryEnds) {
      const w = be.way, s = be.k ? w.s1 - 0.3 : w.s0 + 0.3; w.base.at(s, o);
      w.doors.push({ s, d: 0, x: o.x + o.nx * w.c, z: o.z + o.nz * w.c, wt: 6, use: 'edge', edge: be.k ? 1 : -1 });
    }
    for (const w of this.ways) { w.doors.sort((p, q) => p.s - q.s); w.doorW = w.doors.reduce((a, d) => a + d.wt, 0); w.shopW = w.doors.reduce((a, d) => a + (d.edge ? 0 : d.wt), 0); }
  }
  // (P6, design #1) exit 9's stair mouth (E's hole nearest the exit portal, + LIFE.stairPad) is a keep-out for walkers: on
  // every walkway its padded box crosses, the walkers' lateral offset d is remapped into the free strip beside it (the
  // band squeezed, not cut), eased in over LIFE.stairRamp m of walkway on either side, so it is a pure function of (s, d)
  // and smooth in t. Where the band leaves less than 1.2 m (Yanghwa-ro's north footway, the kerb on the other side), the
  // strip runs on into the station forecourt, outward of the band. Connector legs (door / junction hops) that would cut
  // through it are routed round its corners (trip()). -> w.keep [{sa, sb, lo, hi, ramp}], this.keepPoly [[x, z]...]
  buildKeepOut() {
    this.keepPoly = null; for (const w of this.ways) w.keep = null;
    const ep = this.exitPortal; if (!ep || !this.holes.length) return;
    const cen = (H) => H.reduce((a, q) => [a[0] + q[0] / H.length, a[1] + q[1] / H.length], [0, 0]);
    let H = null, bd = 14;
    for (const h of this.holes) { const c = cen(h), d = Math.hypot(c[0] - ep.x, c[1] - ep.z); if (d < bd) { bd = d; H = h; } }
    if (!H) return;
    const pad = LIFE.stairPad, c = cen(H), xw = this.ways[ep.way];
    // the padded polygon: every edge moved out by pad, except the stair head's (the edge furthest along the exit's
    // walkway, where STATION STAIRS comes in over heads at 2.35 m): stairHeadPad, so the stair head and the building
    // corner 1.8 m past it on Yanghwa-ro keep a walkable gap between them
    const n = H.length, E = [], heads = H.map((b, i) => { const e = H[(i + 1) % n]; return xw.base.project((b[0] + e[0]) / 2, (b[1] + e[1]) / 2).s; });
    const head = heads.indexOf(Math.max(...heads));
    for (let i = 0; i < n; i++) {
      const b = H[i], e = H[(i + 1) % n], l = Math.hypot(e[0] - b[0], e[1] - b[1]) || 1; let nx = (e[1] - b[1]) / l, nz = (b[0] - e[0]) / l;
      if (((b[0] + e[0]) / 2 - c[0]) * nx + ((b[1] + e[1]) / 2 - c[1]) * nz < 0) { nx = -nx; nz = -nz; }
      const pd = i === head ? LIFE.stairHeadPad : pad; E.push({ px: b[0] + nx * pd, pz: b[1] + nz * pd, dx: e[0] - b[0], dz: e[1] - b[1] });
    }
    const poly = [];
    for (let i = 0; i < n; i++) {   // corner i = edge i-1's offset line meets edge i's
      const A = E[(i + n - 1) % n], B = E[i], den = A.dx * B.dz - A.dz * B.dx;
      if (Math.abs(den) < 1e-9) { poly.push([B.px, B.pz]); continue; }
      const t = ((B.px - A.px) * B.dz - (B.pz - A.pz) * B.dx) / den; poly.push([A.px + A.dx * t, A.pz + A.dz * t]);
    }
    this.keepPoly = poly; this.keepC = c;
    const ramp = LIFE.stairRamp;
    for (const w of this.ways) {
      const pr = poly.map(([x, z]) => w.base.project(x, z));
      if (pr.some((q) => q.dist > Math.abs(w.c) + Math.max(-w.dmin, w.dmax) + 12)) continue;
      const sa = Math.min(...pr.map((q) => q.s)), sb = Math.max(...pr.map((q) => q.s)), da = Math.min(...pr.map((q) => q.d - w.c)), db = Math.max(...pr.map((q) => q.d - w.c));
      if (sb < w.s0 - ramp || sa > w.s1 + ramp || db < w.dmin || da > w.dmax) continue;
      let lo, hi;
      const below = da - w.dmin, above = w.dmax - db, out = w.kind === 'main' ? Math.sign(w.c) || 1 : 0;
      if (Math.max(below, above) >= 1.2) { if (above >= below) { lo = db; hi = w.dmax; } else { lo = w.dmin; hi = da; } }
      else if (out > 0) { lo = db; hi = Math.max(w.dmax, db + 1.5); }      // into the forecourt, outward of the band
      else if (out < 0) { lo = Math.min(w.dmin, da - 1.5); hi = da; }
      else if (above >= below) { lo = db; hi = Math.max(db + 0.6, w.dmax); } else { lo = Math.min(da - 0.6, w.dmin); hi = da; }
      (w.keep || (w.keep = [])).push({ sa, sb, lo, hi, ramp, rampB: w === xw ? LIFE.stairHeadRamp : ramp });
      // the exit's people come up the stairs and step out at the stair head (the opening's high-s end on its walkway), on
      // the forecourt side of the line that comes in over it (a sagging pilot met their heads under the pre-gate), not at
      // the hero point beside the opening (P5: the portal sat on the kerb between the opening and the road, and every trip
      // from it cut across the stair mouth)
      if (w.idx === ep.way) for (const dr of w.doors) if (dr.portal === 'exit') {
        const ss = Math.min(w.s1 - 0.5, sb + 0.4), dd = Math.max(w.dmin + 0.3, Math.min(w.dmax - 0.3, lo - 0.4)), q = this.wayPoint(w, ss, dd, {});
        dr.s = ss; dr.d = dd; dr.x = q.x; dr.z = q.z; w.doors.sort((p, q) => p.s - q.s);
      }
    }
  }
  // a walker's lateral offset d at s on walkway w, after the keep-out (identity elsewhere)
  keepD(w, s, d) {
    for (const k of w.keep) {
      const g = s < k.sa ? smooth(1 - (k.sa - s) / k.ramp) : s > k.sb ? smooth(1 - (s - k.sb) / k.rampB) : 1;
      if (g <= 0) continue;
      const f = (d - w.dmin) / Math.max(1e-6, w.dmax - w.dmin), m = k.lo + 0.22 + (k.hi - k.lo - 0.44) * Math.max(0, Math.min(1, f));
      d += (m - d) * g;
    }
    return d;
  }
  // a way point with the keep-out applied (the connector legs meet the way legs where evalUnit draws them)
  wpK(w, s, d, out = {}) { return this.wayPoint(w, s, w.keep ? this.keepD(w, s, d) : d, out); }
  // does segment a-b pass through the keep-out polygon's interior (Cyrus-Beck on the convex quad)?
  keepCuts(ax, az, bx, bz) {
    const H = this.keepPoly; if (!H) return false;
    const c = this.keepC; let t0 = 0, t1 = 1; const dx = bx - ax, dz = bz - az;
    for (let i = 0; i < H.length; i++) {
      const p = H[i], q = H[(i + 1) % H.length]; let nx = q[1] - p[1], nz = p[0] - q[0];
      if ((p[0] - c[0]) * nx + (p[1] - c[1]) * nz < 0) { nx = -nx; nz = -nz; }   // outward
      const num = (ax - p[0]) * nx + (az - p[1]) * nz, den = dx * nx + dz * nz;
      if (Math.abs(den) < 1e-12) { if (num > -1e-6) return false; continue; }
      const t = -num / den; if (den < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
      if (t0 > t1 - 1e-4) return false;
    }
    return (t1 - t0) * Math.hypot(dx, dz) > 0.02;
  }
  // a -> b round the keep-out: [] if the straight line is clear, else the corner points to pass (shortest walk, corners
  // on a carriageway barred)
  keepDetour(a, b) {
    if (!this.keepCuts(a.x, a.z, b.x, b.z)) return [];
    const H = this.keepPoly, c = this.keepC, n = H.length;
    const V = H.map(([x, z]) => { const ex = x - c[0], ez = z - c[1], l = Math.hypot(ex, ez) || 1; return { x: x + ex / l * 0.08, z: z + ez / l * 0.08 }; });
    const bad = V.map((v) => offRoad(this.net.mains, v.x, v.z, 0.2).moved > 0);
    const vis = (p, v) => !this.keepCuts(p.x, p.z, v.x, v.z);
    let best = null, bl = Infinity;
    for (let i = 0; i < n; i++) {
      if (bad[i] || !vis(a, V[i])) continue;
      for (const step of [1, -1]) {
        let j = i, len = Math.hypot(V[i].x - a.x, V[i].z - a.z), path = [V[i]], ok = true;
        for (let k = 0; k < n; k++) {
          if (vis(V[j], b)) { const L = len + Math.hypot(b.x - V[j].x, b.z - V[j].z); if (L < bl) { bl = L; best = path.slice(); } break; }
          const jn = (j + step + n) % n; if (bad[jn]) { ok = false; break; }
          len += Math.hypot(V[jn].x - V[j].x, V[jn].z - V[j].z); path.push(V[jn]); j = jn;
        }
        void ok;
      }
    }
    return best || [];
  }
  inKeep(x, z) { const H = this.keepPoly; if (!H) return false; let c = false; for (let i = 0, j = H.length - 1; i < H.length; j = i++) { const [xi, zi] = H[i], [xj, zj] = H[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; }
  // keep right, loosely. (P6, life #3) P5 put every walker on its own side (0.15-0.85 of the half band), so the lanes
  // self-sorted: the outer thirds of every walkway were 100 % one direction (walk0 all backs, walk180 all faces). Now a
  // share LIFE.counterShare walks the other side (one draw, as before; spreading everyone over the middle instead raised
  // the walker overlaps 4.7 -> 5.4 %)
  prefD(w, dir, r) {
    const mid = (w.dmin + w.dmax) / 2, half = (w.dmax - w.dmin) / 2, cs = LIFE.counterShare;
    const sd = r < cs ? -dir : dir, q = r < cs ? r / cs : (r - cs) / (1 - cs);
    return mid + sd * half * (0.15 + 0.7 * q);
  }
  wayPoint(w, s, d, out = {}) { const P = w.base.at(s, this._wp || (this._wp = {})); out.x = P.x + P.nx * (w.c + d); out.z = P.z + P.nz * (w.c + d); return out; }
  newPerson(R, kind, male = R.next() < 0.5) {
    const h = male ? 1.73 + R.gauss() * 0.07 : 1.60 + R.gauss() * 0.07;   // art #6: sigma 7 cm
    const p = { id: this.people.length, kind, male, scale: Math.max(0.86, Math.min(1.14, h / 1.7)), wide: (male ? 1.04 : 0.93) * (0.96 + 0.08 * R.next()), look: lookFor(R, male), ph0: R.next(), unit: -1, slot: 0, sOff: 0 };
    this.people.push(p); return p;
  }
  buildPeople(layout) {
    const R = new Rng(this.seed ^ 0xc0ffee), D = LIFE.density, K = LIFE.crowdK;
    this.people = []; this.units = []; this.statics = [];
    // ---- budgets
    const homes = this.ways.filter((w) => w.doorW > 0);
    const want = (w) => w.area * (D[w.kind] ?? D.alley) * (K[w.kind] ?? 1) * w.sk * this.density;
    const walkTot = this.ways.reduce((a, w) => a + want(w), 0);
    const frontN = this.lots.map((l) => (l.use === 'club' ? 0 : l.use === 'pocha' ? 10 : ['conv', 'bar', 'karaoke', 'pc', 'cafe'].includes(l.use) ? 3 : 1.2) * this.density);
    const others = frontN.reduce((a, b) => a + b, 0) + this.lots.filter((l) => l.use === 'club').length * 21 + 150 + this.net.crossings.length * 22;
    const k = walkTot + others > this.maxAgents ? Math.max(0.2, (this.maxAgents - others) / walkTot) : 1;
    this.budgetK = k;
    // ---- walkers: home ways get the persons of their own area plus a share of the door-less ways
    const homeW = homes.map((w) => want(w)), lost = walkTot - homeW.reduce((a, b) => a + b, 0), hsum = homeW.reduce((a, b) => a + b, 0) || 1;
    homes.forEach((w, hi) => {
      let n = Math.round((homeW[hi] + lost * homeW[hi] / hsum) * k);
      while (n > 0) {
        const gs = R.next() < LIFE.groupShare ? 2 + Math.floor(R.next() * R.next() * 3.2) : 1;
        // (P5, life #3) a group walks at its slowest member's pace: pairs 0.9x, threes and fours 0.84x
        const u = { id: this.units.length, home: w, v: Math.max(0.75, 1.2 + R.gauss() * 0.17) * (gs > 2 ? 0.84 : gs > 1 ? 0.9 : 1), gsize: gs, members: [], P: 80 + R.next() * 120, phi: R.next(), fvis: 0.66 + R.next() * 0.14, trip: null, lk: null, lv: 0, dc: 0 };
        for (let g = 0; g < gs; g++) {
          // groups walk abreast (P3: 3-4 abreast spanned 1.9 m and ploughed through the crowd, so rows of 2, 0.85 m apart).
          // (P5, life #3) threes walk three abreast at 0.58 m (1.16 m across: Hongdae friends, not a column), fours as two
          // pairs 0.7 m apart, the back pair a half step off
          const three = gs === 3, row = three ? 0 : g >> 1, inRow = three ? 3 : Math.min(2, gs - row * 2);
          const p = this.newPerson(R, K_WALK); p.unit = u.id;
          p.slot = inRow === 1 ? (R.next() - 0.5) * 0.3 : inRow === 3 ? (g - 1) * 0.58 : ((g & 1) - 0.5) * 0.6;
          p.sOff = -row * 0.7 + (g ? (R.next() - 0.5) * (three ? 0.25 : 0.3) : 0);
          p.pose = R.next() < (gs > 1 ? 0.2 : LIFE.phoneShare) ? P_PHONE : P_WALK; p.ph0 = R.next(); u.members.push(p.id);
        }
        this.units.push(u); n -= gs;
      }
    });
    // ---- exit 9 (the meeting point): units that come up the stairs, and people waiting around the mouth on phones
    const ex = this.exitPortal ? this.ways[this.exitPortal.way].doors.find((d) => d.portal === 'exit') : null;
    if (ex) {
      const xw = this.ways[this.exitPortal.way];
      // trains (life #4): a unit's trip k starts at (k - phi) P; with P a whole number of headways and phi on a train's
      // arrival plus the stair spread, each train sends ~perTrain people up the stairs within `spread` s, then a lull
      const TR = LIFE.train, H = TR.headway;
      let n = Math.round(TR.perTrain * 2.5 / 0.85 * Math.min(1.5, this.density) * Math.min(1, k + 0.2));
      while (n > 0) {
        const gs = R.next() < 0.45 ? 2 : 1, m = 2 + (R.next() < 0.5 ? 1 : 0), P = m * H, j = Math.floor(R.next() * m), jit = TR.spread * R.next() * (0.4 + 0.6 * R.next());
        const u = { id: this.units.length, home: xw, exit: ex, v: Math.max(0.8, 1.25 + R.gauss() * 0.15), gsize: gs, members: [], P, phi: ((((-(j * H + jit)) % P) + P) % P) / P, fvis: 0.55 + R.next() * 0.2, trip: null, lk: null, lv: 0, dc: 0 };
        for (let g = 0; g < gs; g++) { const p = this.newPerson(R, K_WALK); p.unit = u.id; p.slot = gs === 1 ? 0 : (g - 0.5) * 0.62; p.sOff = g ? (R.next() - 0.5) * 0.4 : 0; p.pose = R.next() < 0.22 ? P_PHONE : P_WALK; u.members.push(p.id); }
        this.units.push(u); n -= gs;
      }
      const ep = this.exitPortal;   // (P6) the waiting ring stays round the hero point (the door moved to the stair head)
      for (let q = 0; q < 24; q++) {
        let a = R.next() * 6.283, r = 2.5 + R.next() * 6.5; const p = this.newPerson(R, K_STAND);
        [p.x, p.z] = this.offRoad(ep.x + pcos(a) * r, ep.z + psin(a) * r);
        for (let tr = 1; tr < 12 && this.holes.length && (this.inHole(p.x, p.z) || this.inKeep(p.x, p.z) || this.inDress(p.x, p.z, 0.3)); tr++) { a += 2.4; r = 2.5 + ((r - 2.5 + 1.7) % 6.5); [p.x, p.z] = this.offRoad(ep.x + pcos(a) * r, ep.z + psin(a) * r); } p.yaw = R.next() * 6.283; p.T = 20 + R.next() * 40; p.smoker = false; p.wait = true; p.cl = [ep.x, ep.z];
        this.statics.push(p.id);
      }
    }
    // ---- frontage people: chat clusters / smokers, club queues (+ a bouncer), pocha tables
    this.queues = []; this.tables = [];
    this.lots.forEach((l, i) => {
      const [a, b] = l.frontage, fx = b[0] - a[0], fz = b[1] - a[1], fl = Math.hypot(fx, fz) || 1, tx = fx / fl, tz = fz / fl;
      let cx = 0, cz = 0; l.footprint.forEach((p) => { cx += p[0]; cz += p[1]; }); cx /= l.footprint.length; cz /= l.footprint.length;
      let nx = -tz, nz = tx; if ((cx - a[0]) * nx + (cz - a[1]) * nz > 0) { nx = -nx; nz = -nz; }
      if (l.use === 'club') {
        const door = 0.2 + 0.25 * R.next(), dx = a[0] + fx * door + nx * 0.4, dz = a[1] + fz * door + nz * 0.4;
        const Q = 14 + Math.floor(R.next() * 9), q = { id: this.queues.length, lot: l.id, door: [dx, dz], t: [tx, tz], n: [nx, nz], Q, G: 22 + R.next() * 30, seed: h32(this.seed, i, 99), pool: [], cap: Math.max(2, Math.floor((fl * (1 - door) - 1) / 0.75) * 2) };
        q.Q = Math.min(q.Q, q.cap);
        for (let j = 0; j < q.Q + 3; j++) { const p = this.newPerson(R, K_QUEUE); p.q = q.id; p.qi = j; p.pose = R.next() < 0.45 ? P_PHONE : R.next() < 0.5 ? P_TALK : P_IDLE; q.pool.push(p.id); this.statics.push(p.id); }
        const bo = this.newPerson(R, K_DOOR, true); bo.x = dx + tx * -0.5 + nx * 0.6; bo.z = dz + tz * -0.5 + nz * 0.6; bo.yaw = Math.atan2(tx, tz); bo.pose = P_IDLE;
        for (let k = 0; k < 10 && this.inHole(bo.x, bo.z); k++) { bo.x += nx * 0.5; bo.z += nz * 0.5; }   // (P5) at the top of a basement club's stairwell, not in it bo.look.top = [0.02, 0.02, 0.025]; bo.look.coat = 1; this.statics.push(bo.id);
        this.queues.push(q); l._door = [dx, dz];
        return;
      }
      let n = Math.round(frontN[i]); if (n <= 0) return;
      if (l.use === 'pocha') {   // plastic tables under the tent, 4 seats each
        l._tables = [];
        const nt = Math.max(1, Math.min(4, Math.round(n / 3)));
        for (let t = 0; t < nt; t++) {
          const u = (t + 0.5) / nt, x = a[0] + fx * u + nx * 1.6, z = a[1] + fz * u + nz * 1.6; l._tables.push([x, z]);
          const occ = 2 + Math.floor(R.next() * 3);
          for (let q = 0; q < 4; q++) {
            const ang = q * Math.PI / 2 + 0.785, sx = x + pcos(ang) * 0.62, sz = z + psin(ang) * 0.62;
            l._tables.push({ stool: [sx, sz] });
            if (q < occ) { const p = this.newPerson(R, K_SEAT); p.x = sx; p.z = sz; p.yaw = Math.atan2(x - sx, z - sz); p.pose = P_SIT; this.statics.push(p.id); }
          }
        }
        return;
      }
      if (R.next() > 0.85) return;
      const u = 0.2 + 0.6 * R.next(), [gx, gz] = this.offRoad(a[0] + fx * u + nx * (1.0 + R.next() * 0.8), a[1] + fz * u + nz * (1.0 + R.next() * 0.8), 1.0);
      if (this.inDress(gx, gz, 0.4 + 0.1 * n) || this.inHole(gx, gz, 0.6 + 0.1 * n)) return;   // (life #6) not inside E's cart / tent / stall
      const smokers = n === 1 && R.next() < 0.5;
      for (let q = 0; q < n; q++) {
        const ang = (q / n) * 6.283 + R.next() * 0.5, r = n > 1 ? 0.42 + 0.1 * n : 0;
        const p = this.newPerson(R, K_STAND); p.x = gx + pcos(ang) * r; p.z = gz + psin(ang) * r;
        p.yaw = n > 1 ? Math.atan2(gx - p.x, gz - p.z) : Math.atan2(nx, nz) + (R.next() - 0.5) * 2; p.smoker = smokers || R.next() < 0.12; p.T = 15 + R.next() * 30; p.cl = [gx, gz];
        this.statics.push(p.id);
      }
    });
    // ---- busking rings (art #4 / life #5): the Walking Street stage and the Playground, unless the dressing gives sites
    this.busk = [];
    // (life #5, P3) E's UNDER THE STAGE canopy comes first (its crew on the deck, the crowd massed on crowdRing.c), merged
    // with the defaults: a default ring within 30 m of a set-piece ring is dropped, the rest stay (the Playground)
    const siteList = mergeBuskSites(this.sites || [], this.defaultBuskSites(layout));
    this.buskSites = siteList;
    siteList.forEach((s, si) => {
      const b = { id: si, x: s.pos[0], z: s.pos[2], yaw: s.yaw ?? 0, kind: s.kind || (si ? 'acoustic' : 'dance'), song: 170 + 30 * hu(this.seed, si, 5), off: 97 * hu(this.seed, si, 6), perf: [], aud: [], piece: s.piece || null, ring: s.ring || null };
      const fwx = psin(b.yaw), fwz = pcos(b.yaw), rtx = fwz, rtz = -fwx;
      const np = b.kind === 'dance' ? 3 : 1 + (R.next() < 0.5 ? 1 : 0);
      for (let j = 0; j < np; j++) { const p = this.newPerson(R, K_PERF, b.kind === 'dance' ? R.next() < 0.6 : true); const lat = (j - (np - 1) / 2) * 1.1; p.x = b.x + rtx * lat - fwx * (j === 1 ? 0.5 : 0); p.z = b.z + rtz * lat - fwz * (j === 1 ? 0.5 : 0); p.y0 = s.y0 || 0; p.yaw = b.yaw; p.busk = si; p.pose = b.kind === 'dance' ? P_DANCE : P_SING; b.perf.push(p.id); this.statics.push(p.id); }
      const na = Math.round((s.n ?? (b.kind === 'dance' ? 50 : 30)) * Math.min(1, this.density));
      for (let j = 0; j < na; j++) {
        const row = Math.floor(R.next() * R.next() * 3), r = (s.r0 ?? 2.6) + row * 0.75 + R.next() * 0.35, th = (R.next() - 0.5) * 2 * (s.arc ?? 1.95);
        const ax = b.x + (fwx * pcos(th) + rtx * psin(th)) * r, az = b.z + (fwz * pcos(th) + rtz * psin(th)) * r;
        if (this.inDress(ax, az, 0.3) || this.inHole(ax, az)) continue;
        const p = this.newPerson(R, K_BUSK); p.x = ax; p.z = az;
        p.yaw = Math.atan2(b.x - p.x, b.z - p.z) + (R.next() - 0.5) * 0.3; p.busk = si; p.film = R.next() < 0.4; p.pose = p.film ? P_FILM : R.next() < 0.6 ? P_IDLE : P_TALK;
        p.Pa = 90 + R.next() * 150; p.pa = R.next(); p.out = [(p.x - b.x) / r, (p.z - b.z) / r]; b.aud.push(p.id); this.statics.push(p.id);
      }
      this.busk.push(b);
    });
    // ---- crossers: bunch at the kerb, surge on the walk phase, cycle after cycle
    this.net.crossings.forEach((c) => {
      const n = Math.round((c.kind === 'T' ? 30 : 14) * this.density);
      for (let q = 0; q < n; q++) { const p = this.newPerson(R, K_CROSS); p.cross = c; p.cside = q % 2 ? 1 : -1; p.v = 1.25 + R.next() * 0.35; this.statics.push(p.id); }
    });
    // the slowest walkers speed up to make a long crossing inside its walk phase
    for (const i of this.statics) { const p = this.people[i]; if (p.kind !== K_CROSS) continue; const c = p.cross, ph = crossPhase(c, 0), sp = 2 * c.halfSpan + (c.ext ? c.ext[0] + c.ext[1] : 0); p.v = Math.max(p.v, sp / Math.max(1, ph.wlen + 4)); }
    // static disc obstacles per walkway (standing, queues, busk audience, tables) for walker avoidance
    for (const w of this.ways) w.obst = [];
    const addObst = (x, z, r) => {
      for (const w of this.ways) {
        if (x < w.box[0] || x > w.box[1] || z < w.box[2] || z > w.box[3]) continue;
        const pr = w.base.project(x, z); if (pr.s < w.s0 - 1 || pr.s > w.s1 + 1) continue; const d = pr.d - w.c;
        if (d > w.dmin - r && d < w.dmax + r) w.obst.push([pr.s, d, r]);
      }
    };
    for (const i of this.statics) { const p = this.people[i]; if (p.kind === K_STAND || p.kind === K_SEAT || p.kind === K_BUSK || p.kind === K_DOOR || p.kind === K_PERF) addObst(p.x, p.z, 0.32); }
    for (const q of this.queues) for (let j = 0; j < q.Q; j += 2) { const r = j / 2; addObst(q.door[0] + q.t[0] * (0.9 + 0.75 * r) + q.n[0] * 0.72, q.door[1] + q.t[1] * (0.9 + 0.75 * r) + q.n[1] * 0.72, 0.6); }
    for (const l of this.lots) for (const t of l._tables || []) if (!t.stool) addObst(t[0], t[1], 1.0);
    for (const o of this.dress) addObst(o[0], o[1], o[2]);
    // the puddles near each standing person's spot and each queue's line (evalStatic keeps them out)
    if (this.pud.length) { this.pudNear = new Array(this.people.length).fill(null);
      for (const i of this.statics) { const p = this.people[i]; let ax, az, R;
        if (p.kind === K_STAND) { ax = p.x; az = p.z; R = 1.5; } else if (p.kind === K_QUEUE) { const q = this.queues[p.q]; ax = q.door[0]; az = q.door[1]; R = 6 + 0.4 * q.Q; } else continue;
        const L = this.pud.filter((u) => Math.hypot(u[0] - ax, u[1] - az) < R + u[4] + 0.5); if (L.length) this.pudNear[i] = L; } }
    for (const [x, z, tx, tz, a, b] of this.pud) { const n = Math.max(1, Math.ceil((a - b) / (0.6 * b)) + 1); for (let k = 0; k < n; k++) { const u = n > 1 ? -(a - b) + (2 * (a - b) * k) / (n - 1) : 0; addObst(x + tx * u, z + tz * u, b * 1.05); } }
    for (const w of this.ways) w.obst.sort((p, q) => p[0] - q[0]);
  }
  inHole(x, z, pad = 0.45) {
    const pip = (px, pz, H) => { let c = false; for (let i = 0, j = H.length - 1; i < H.length; j = i++) { const [xi, zi] = H[i], [xj, zj] = H[j]; if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) c = !c; } return c; };
    for (const H of this.holes) for (const [ox, oz] of [[0, 0], [pad, 0], [-pad, 0], [0, pad], [0, -pad]]) if (pip(x + ox, z + oz, H)) return true;
    return false;
  }
  inDress(x, z, pad = 0) { for (const o of this.dress) { const dx = x - o[0], dz = z - o[1], r = o[2] + pad; if (dx * dx + dz * dz < r * r) return true; } return false; }
  inPuddle(x, z, pad = 0) { for (const [px, pz, tx, tz, a, b] of this.pud) { const dx = x - px, dz = z - pz, u = (dx * tx + dz * tz) / (a + pad), v = (dz * tx - dx * tz) / (b + pad); if (u * u + v * v < 1) return true; } return false; }
  defaultBuskSites(layout) {
    const out = [], o = {};
    const walk = this.ways.filter((w) => w.kind === 'walking').sort((a, b) => b.area - a.area)[0];
    if (walk) {   // R1/R2 stage: on the widest Walking Street walkway, ~40 m from the spawn hover, against one facade
      const hero = (layout.hero || []).find((h) => h.id === 'walking-street'), pr = hero ? walk.base.project(hero.pos[0], hero.pos[2]) : { s: (walk.s0 + walk.s1) / 2 };
      const s = Math.max(walk.s0 + 8, Math.min(walk.s1 - 8, pr.s + 38)), dPerf = walk.dmax - 0.8;
      this.wayPoint(walk, s, dPerf, o); const P = walk.base.at(s, {});
      out.push({ pos: [o.x, 0, o.z], yaw: Math.atan2(-P.nx, -P.nz), kind: 'dance', n: 50, arc: 1.35 });
    }
    const pg = (layout.hero || []).find((h) => h.id === 'playground');
    if (pg) out.push({ pos: pg.pos, yaw: 0.6, kind: 'acoustic', n: 32, arc: 2.2 });
    return out;
  }
  // ---- a walker unit's trip k: legs [{w, s0, dir, len, d} | {x0, z0, x1, z1, len}] + cumulative lengths
  trip(u, k) {
    const R = new Rng(h32(this.seed, u.id + 1, k + 7)), legs = [], cap = u.v * u.P * 0.97;
    let budget = u.v * u.P * u.fvis, used = 0;
    const pick = (doors) => { let r = R.next() * doors.reduce((a, d) => a + d.wt, 0); for (const d of doors) if ((r -= d.wt) < 0) return d; return doors[doors.length - 1]; };
    const conn1 = (a, b) => { const len = Math.hypot(b.x - a.x, b.z - a.z); if (len > 1e-3) { legs.push({ x0: a.x, z0: a.z, x1: b.x, z1: b.z, len }); used += len; } };
    // (P6) round exit 9's stair mouth, never across it
    const conn = (a, b) => { if (!this.keepPoly) return conn1(a, b); let p = { x: a.x, z: a.z }; for (const v of this.keepDetour(a, b)) { conn1(p, v); p = v; } conn1(p, b); };
    const way = (w, s0, dir, len, d) => { if (len > 1e-3) { legs.push({ w, s0, dir, len, d }); used += len; } };
    let w = u.home; const door = u.exit && R.next() < 0.85 ? u.exit : pick(w.doors), start = door;
    let s = door.s, dir = door.edge ? -door.edge : s - w.s0 < 4 ? 1 : w.s1 - s < 4 ? -1 : R.next() < 0.5 ? 1 : -1;
    let dP = this.prefD(w, dir, R.next()), prev = null, end = null;
    const s1 = Math.max(w.s0, Math.min(w.s1, s + dir * 1.2));
    conn({ x: door.x, z: door.z }, this.wpK(w, s1, dP, {})); s = s1;
    for (let hop = 0; hop < 10 && !end; hop++) {
      const sEnd = dir > 0 ? w.s1 : w.s0, room = Math.max(0, (sEnd - s) * dir), left = budget - used;
      if (left < room + 2) {   // finish at a door ahead, nearest the budget point, never past the cap
        const target = s + dir * Math.max(3, left); let best = null, bd = Infinity;
        for (const dd of w.doors) { const a = (dd.s - s) * dir; if (a < 3 || dd === start) continue; if (used + a > cap - 3) continue; const e = Math.abs(dd.s - target) - (dd.portal === 'exit' ? 40 : 0); if (e < bd) { bd = e; best = dd; } }
        if (best) { const sd = best.s - dir * 1.0; way(w, s, dir, Math.max(0, (sd - s) * dir), dP); conn(this.wpK(w, sd, dP, {}), { x: best.x, z: best.z }); end = best; break; }
      }
      if (left < room + 2 || used + room > cap) {   // no door ahead in reach: turn back to the nearest door behind (a shop they just passed)
        let best = null, bd = Infinity;
        for (const dd of w.doors) { if (dd === start || dd.edge) continue; const back = (s - dd.s) * dir; if (back < 1 || used + 1 + back > cap) continue; if (back < bd) { bd = back; best = dd; } }
        if (best) {
          const nd = -dir, ndP = this.prefD(w, nd, R.next()); conn(this.wpK(w, s, dP, {}), this.wpK(w, s + nd * 0.6, ndP, {})); s += nd * 0.6;
          const sd = best.s - nd * 1.0; way(w, s, nd, Math.max(0, (sd - s) * nd), ndP); conn(this.wpK(w, sd, ndP, {}), { x: best.x, z: best.z }); end = best; break;
        }
        if (used + room > cap) { way(w, s, dir, (cap - used) - 1, dP); break; }
      }
      way(w, s, dir, room, dP); s = sEnd;
      const e = w.ends[dir > 0 ? 1 : 0];
      if (!e.length) {
        if (this.boundaryEnds.some((b) => b.way === w && b.k === (dir > 0 ? 1 : 0))) { end = { edge: true }; break; }   // leaves the map
        const nd = -dir, ndP = this.prefD(w, nd, R.next());                                                                // dead end: turn back
        conn(this.wpK(w, s, dP, {}), this.wpK(w, s + nd * 0.8, ndP, {})); s += nd * 0.8; dir = nd; dP = ndP; continue;
      }
      const late = budget - used < 80;   // near the end of the budget: prefer streets with doors to end at
      let tot = 0; const wts = e.map((j) => { const x = Math.pow((LIFE.density[j.way.kind] ?? 0.06) / 0.1, 0.5) * j.way.sk * (j.way === prev ? 0.15 : 1) * (late && !j.way.shopW ? 0.05 : 1); tot += x; return x; });
      let r = R.next() * tot, j = e[e.length - 1]; for (let q = 0; q < e.length; q++) if ((r -= wts[q]) < 0) { j = e[q]; break; }
      const nw = j.way, nd = j.s - nw.s0 < 3 ? 1 : nw.s1 - j.s < 3 ? -1 : R.next() < 0.5 ? 1 : -1, ndP = this.prefD(nw, nd, R.next());
      const ns = Math.max(nw.s0, Math.min(nw.s1, j.s + nd * 0.5));
      conn(this.wpK(w, s, dP, {}), this.wpK(nw, ns, ndP, {}));
      prev = w; w = nw; s = ns; dir = nd; dP = ndP;
    }
    if (!end) {   // still no door: cut the trip back to the last door it walked past (they went in there)
      for (let i = legs.length - 1; i >= 0 && !end; i--) {
        const L = legs[i]; if (!L.w) continue;
        let best = null;
        for (const dd of L.w.doors) { if (dd === start || dd.edge) continue; const a = (dd.s - L.s0) * L.dir; if (a > 1.5 && a < L.len && (!best || a > (best.s - L.s0) * L.dir)) best = dd; }
        if (best) { legs.length = i; const a = (best.s - L.s0) * L.dir - 1; legs.push({ w: L.w, s0: L.s0, dir: L.dir, len: a, d: L.d }); const p0 = this.wpK(L.w, L.s0 + L.dir * a, L.d, {}); const n0 = legs.length; conn(p0, { x: best.x, z: best.z }); if (legs.length === n0) legs.push({ x0: p0.x, z0: p0.z, x1: best.x, z1: best.z, len: 1e-3 }); end = best; }
      }
    }
    const cum = new Float64Array(legs.length + 1); for (let i = 0; i < legs.length; i++) cum[i + 1] = cum[i] + legs[i].len;
    // heading at each leg's start and end (blended over the first 0.7 m of a leg so corners turn, not snap)
    const o = {};
    for (const L of legs) {
      if (L.w) { L.w.base.at(L.s0, o); L.y0 = Math.atan2(o.tx * L.dir, o.tz * L.dir); L.w.base.at(L.s0 + L.dir * L.len, o); L.y1 = Math.atan2(o.tx * L.dir, o.tz * L.dir); }
      else { L.y0 = L.y1 = Math.atan2(L.x1 - L.x0, L.z1 - L.z0); }
    }
    // (P5, life #3) one stop on the way, on a way with shop doors: 3-10 s at a window or a sign, facing it (closed form:
    // the trip's clock just holds; skipped where it would run into the next trip)
    const tr = { k, legs, cum, L: cum[legs.length], start, end, pD: -1, pT: 0, pYaw: 0 }, PZ = LIFE.pause;
    if (hu(u.id, k, 0x9a05) < PZ.p) {
      const pT = PZ.t0 + (PZ.t1 - PZ.t0) * hu(u.id, k, 0x9a06), cand = [];
      for (let i = 0; i < legs.length; i++) if (legs[i].w && legs[i].w.doorW > 0 && legs[i].len > 6) cand.push(i);
      if (cand.length && tr.L / u.v + pT < 0.95 * u.P) {
        const i = cand[Math.floor(hu(u.id, k, 0x9a07) * cand.length)], L = legs[i], a = 2 + (L.len - 4) * hu(u.id, k, 0x9a08);
        L.w.base.at(L.s0 + L.dir * a, o); const sg = Math.sign(L.w.c + L.d) || 1;
        tr.pD = cum[i] + a; tr.pT = pT; tr.pYaw = Math.atan2(o.nx * sg, o.nz * sg);
      }
    }
    return tr;
  }
  // ---- evaluation
  unitTrip(u, t) {
    const q = t / u.P + u.phi, k = Math.floor(q);
    if (!u.trip || u.trip.k !== k) u.trip = this.trip(u, k);
    return (q - k) * u.P;
  }
  // walker unit u at t -> members' pose into the arrays (avoidance not applied). Returns false if hidden.
  evalUnit(u, t, A, cam = null, farR2 = Infinity) {
    const tau0 = this.unitTrip(u, t), tr = u.trip;
    // (P5) the window stop: the clock holds at pD for pT s (turn: 0..1 how far turned to the window)
    let tau = tau0, turn = 0;
    if (tr.pT > 0) { const tp = tr.pD / u.v; if (tau0 > tp) { if (tau0 < tp + tr.pT) { tau = tp; turn = Math.min(smooth((tau0 - tp) / 0.7), smooth((tp + tr.pT - tau0) / 0.7)); } else tau = tau0 - tr.pT; } }
    const dist = tau * u.v;
    const vis = dist < tr.L && tr.legs.length;
    if (!vis) { for (const i of u.members) A.VIS[i] = 0; return false; }
    let lo = 0, hi = tr.legs.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tr.cum[m] <= dist) lo = m; else hi = m - 1; }
    const L = tr.legs[lo], into = dist - tr.cum[lo];
    if (cam && L.w) { const b = L.w.box, dx = Math.max(b[0] - cam.x, 0, cam.x - b[1]), dz = Math.max(b[2] - cam.z, 0, cam.z - b[3]); if (dx * dx + dz * dz > farR2) { for (const i of u.members) A.VIS[i] = 0; return false; } }
    let x, z, tx, tz, nx, nz, yaw;
    const o = this._eo || (this._eo = {});
    if (L.w) {
      const s = L.s0 + L.dir * into; L.w.base.at(s, o);
      tx = o.tx * L.dir; tz = o.tz * L.dir; nx = o.nx; nz = o.nz;
      x = o.x + o.nx * (L.w.c + L.d); z = o.z + o.nz * (L.w.c + L.d); yaw = Math.atan2(tx, tz);
      // (P3: each member's own s, its row offset included: the avoidance compared group mates by the leader's s)
      for (const i of u.members) { A.WAY[i] = L.w.idx; A.WS[i] = s + L.dir * this.people[i].sOff; A.WDIR[i] = L.dir; }
    } else {
      const f = into / L.len; x = L.x0 + (L.x1 - L.x0) * f; z = L.z0 + (L.z1 - L.z0) * f;
      tx = (L.x1 - L.x0) / L.len; tz = (L.z1 - L.z0) / L.len; nx = -tz; nz = tx; yaw = L.y0;
      for (const i of u.members) A.WAY[i] = -1;
    }
    if (into < 0.7 && lo > 0) { const py = tr.legs[lo - 1].y1, f = smooth(into / 0.7); yaw = py + wrapA(yaw - py) * f; }
    const stopped = turn > 0 || (tr.pT > 0 && tau0 > tr.pD / u.v && tau0 < tr.pD / u.v + tr.pT);
    if (stopped) yaw += wrapA(tr.pYaw - yaw) * turn;
    const stride = 0.95 + 0.42 * u.v;
    for (const i of u.members) {
      const p = this.people[i], lat = L.w ? p.slot * L.dir : p.slot;
      let px = x + nx * lat + tx * p.sOff, pz = z + nz * lat + tz * p.sOff;
      if (L.w) {
        let d = L.d + lat; const half = 0.25; d = Math.max(L.w.dmin + half, Math.min(L.w.dmax - half, d));
        if (L.w.keep) { const ms = A.WS[i], d0 = d; d = this.keepD(L.w, ms, d); if (d !== d0) { const q = L.w.base.at(ms, o); px = q.x + q.nx * (L.w.c + d); pz = q.z + q.nz * (L.w.c + d); A.WD[i] = d; A.X[i] = px; A.Z[i] = pz; } else { A.WD[i] = d; px = x + nx * (d - L.d) + tx * p.sOff; pz = z + nz * (d - L.d) + tz * p.sOff; } }
        else { A.WD[i] = d; px = x + nx * (d - L.d) + tx * p.sOff; pz = z + nz * (d - L.d) + tz * p.sOff; }
      }
      A.X[i] = px; A.Z[i] = pz; A.YAW[i] = yaw; A.VIS[i] = 1; A.WALK[i] = stopped ? 0 : 1;
      A.PH[i] = ((dist + p.sOff) / (stride * p.scale) + p.ph0) % 1; A.POSE[i] = stopped && p.pose === P_WALK ? (hu(p.id, tr.k, 3) < 0.5 ? P_IDLE : P_PHONE) : p.pose;
    }
    return true;
  }
  queueState(q, t, o = {}) {   // admissions so far: { A, N, TN, mN }
    let A = 0, n = 0, TN = -1e9, mN = 0;
    for (;;) { const nn = n + 1, Tn = nn * q.G + (hu(q.seed, nn, 1) - 0.5) * 0.6 * q.G; if (Tn > t) break; n = nn; TN = Tn; mN = 1 + Math.floor(hu(q.seed, nn, 2) * 2.6); A += mN; }
    o.A = A; o.N = n; o.TN = TN; o.mN = mN; return o;
  }
  // (P8) a standing or queueing person whose spot falls in one of E's puddles is drawn (and collides) at its rim + 20 cm:
  // P7 had 13 of 878 there (9 in club queues along a lamp post's puddle). Every caller (render, worker, colliders) goes
  // through here, so they agree
  evalStatic(i, t, A, qs) {
    this._evalStatic(i, t, A, qs);
    const L = this.pudNear && this.pudNear[i]; if (!L || !A.VIS[i]) return;
    for (const [px, pz, tx, tz, a, b] of L) {
      const dx = A.X[i] - px, dz = A.Z[i] - pz, u = dx * tx + dz * tz, v = dz * tx - dx * tz, e = (u / (a + 0.2)) ** 2 + (v / (b + 0.2)) ** 2;
      if (e >= 1) continue; const k = 1 / Math.sqrt(Math.max(e, 1e-4)), uu = e > 1e-4 ? u * k : 0, vv = e > 1e-4 ? v * k : b + 0.2;
      A.X[i] = px + tx * uu - tz * vv; A.Z[i] = pz + tz * uu + tx * vv;
    }
  }
  _evalStatic(i, t, A, qs) {
    const p = this.people[i];
    A.WAY[i] = -1; A.VIS[i] = 1; A.WALK[i] = 0; A.POSE[i] = p.pose; A.PH[i] = (t * 0.11 + p.ph0) % 1;
    if (p.kind === K_STAND) {
      const q = t / p.T + p.ph0 * 7, j = Math.floor(q), f = (q - j) * p.T, g = smooth(f / 1.1);   // (P3: no per-frame arrays)
      const a0 = (hu(p.id, j, 1) - 0.5) * 0.35, a1 = (hu(p.id, j, 2) - 0.5) * 0.35, a2 = (hu(p.id, j, 3) - 0.5) * 0.9;
      const b0 = (hu(p.id, j - 1, 1) - 0.5) * 0.35, b1 = (hu(p.id, j - 1, 2) - 0.5) * 0.35, b2 = (hu(p.id, j - 1, 3) - 0.5) * 0.9;
      A.X[i] = p.x + b0 + (a0 - b0) * g; A.Z[i] = p.z + b1 + (a1 - b1) * g; A.YAW[i] = p.yaw + b2 + (a2 - b2) * g;
      if (f < 1.1) A.WALK[i] = 0.5 * Math.sin(Math.PI * f / 1.1);
      const r = hu(p.id, j, 4); A.POSE[i] = p.wait ? (r < 0.75 ? P_PHONE : P_IDLE) : p.smoker ? (r < 0.7 ? P_SMOKE : P_PHONE) : r < 0.5 ? P_TALK : r < 0.8 ? P_PHONE : r < 0.9 ? P_IDLE : P_SMOKE;
      return;
    }
    if (p.kind === K_QUEUE) {
      const q = this.queues[p.q], st = qs[p.q], M = q.Q + 3, A0 = st.A - 3;
      const pn = A0 + (((p.qi - A0) % M) + M) % M;            // the person in this pool slot now
      const since = t - st.TN, admitted = pn < st.A;
      if (admitted && (pn < st.A - st.mN || since > 2.6)) { A.VIS[i] = 0; return; }
      const sNew = pn - st.A, sOld = pn - (st.A - st.mN), side = pn & 1;
      const slot = (sg) => { const r = Math.max(0, sg) / 2; return [q.door[0] + q.t[0] * (0.9 + 0.75 * Math.floor(r)) + q.n[0] * (0.45 + 0.55 * side), q.door[1] + q.t[1] * (0.9 + 0.75 * Math.floor(r)) + q.n[1] * (0.45 + 0.55 * side)]; };
      let x, z, walking = 0;
      if (pn >= st.A + q.Q - st.mN && since < 3.2) {          // newcomer walking in to the tail
        const e = slot(sNew), g = smooth(since / 3.2); x = e[0] + (q.n[0] * 3 + q.t[0] * 2) * (1 - g); z = e[1] + (q.n[1] * 3 + q.t[1] * 2) * (1 - g); walking = since < 3.2 ? 1 : 0;
      } else if (admitted) {                                   // in through the door
        const a = slot(sOld), g = smooth(since / 2.6); x = a[0] + (q.door[0] - q.n[0] * 0.9 - a[0]) * g; z = a[1] + (q.door[1] - q.n[1] * 0.9 - a[1]) * g; walking = 1;
      } else {
        const a = slot(sOld), b = slot(sNew), g = smooth((since - 0.15 * Math.floor(Math.max(0, sOld) / 2)) / 1.8);
        x = a[0] + (b[0] - a[0]) * g; z = a[1] + (b[1] - a[1]) * g; walking = g > 0 && g < 1 ? 1 : 0;
      }
      A.X[i] = x; A.Z[i] = z; A.WALK[i] = walking * 0.8; A.YAW[i] = Math.atan2(-q.t[0], -q.t[1]) + (hu(p.id, 1, 1) - 0.5) * 0.7;
      if (walking) A.PH[i] = (since * 0.85 + p.ph0) % 1;
      const r = hu(pn, q.id, Math.floor(t / 30)); A.POSE[i] = r < 0.45 ? P_PHONE : r < 0.75 ? P_TALK : P_IDLE;
      return;
    }
    if (p.kind === K_BUSK || p.kind === K_PERF) {
      const b = this.busk[p.busk], sp = ((t + b.off) / b.song) % 1, clap = sp > 0.94;
      if (p.kind === K_PERF) { A.X[i] = p.x; A.Z[i] = p.z; A.YAW[i] = p.yaw; A.POSE[i] = sp > 0.955 ? P_IDLE : p.pose; A.PH[i] = ((t + b.off) * 2.0667) % 1; return; }   // beat phase (124 bpm)
      const q = t / p.Pa + p.pa, j = Math.floor(q), f = (q - j) * p.Pa, stay = 0.8 * p.Pa;
      if (f > stay + 3.2) { A.VIS[i] = 0; return; }
      const g = f < 3.2 ? 1 - smooth(f / 3.2) : f > stay ? smooth((f - stay) / 3.2) : 0;
      A.X[i] = p.x + p.out[0] * 4 * g; A.Z[i] = p.z + p.out[1] * 4 * g; A.WALK[i] = g > 0 && g < 1 ? 1 : 0;
      A.YAW[i] = g > 0.02 ? Math.atan2(f > stay ? p.out[0] : -p.out[0], f > stay ? p.out[1] : -p.out[1]) : p.yaw;
      if (A.WALK[i]) A.PH[i] = (f * 0.85 + p.ph0) % 1;
      A.POSE[i] = clap && !A.WALK[i] ? P_CLAP : p.pose; return;
    }
    if (p.kind === K_CROSS) {
      const c = p.cross, Pd = LIFE.signal.period, ph = crossPhase(c, t), m = Math.floor((t + c.offset) / Pd), side = p.cside * (m & 1 ? -1 : 1);
      const hsp = (sd) => c.halfSpan + (c.ext ? c.ext[sd > 0 ? 1 : 0] : 0), span = hsp(1) + hsp(-1), cu = (hu(p.id, m, 1) - 0.5) * (c.cw - 0.8), cw = 0.3 + hu(p.id, m, 2) * 2.2;
      const delay = Math.min(0.3 + hu(p.id, m, 3) * hu(p.id, m, 4) * 4, Math.max(0, ph.wlen - span / p.v - 0.5));
      const P = c.main.path.at(c.sc, this._cp || (this._cp = {}));
      const at = (off, u) => [P.x + P.nx * off + P.tx * u, P.z + P.nz * off + P.tz * u];
      const w0 = ph.w0 + delay, w1 = w0 + span / p.v, tc = ph.tc;
      let x, z, yaw, walk = 0;
      if (tc >= w0 && tc < w1) { const g = (tc - w0) / (w1 - w0), off = side * hsp(side) * (1 - g) - side * hsp(-side) * g; [x, z] = at(off, cu); yaw = Math.atan2(-P.nx * side, -P.nz * side); walk = 1; A.PH[i] = ((tc - w0) * p.v / 1.45 + p.ph0) % 1; }
      else {
        // waiting on this cycle's side; right after arriving (previous cycle) they drift to the new waiting spot
        const wside = tc >= w1 ? -side : side, mm = tc >= w1 ? m + 1 : m, wcu = tc >= w1 ? (hu(p.id, mm, 1) - 0.5) * (c.cw - 0.8) : cu, wcw = tc >= w1 ? 0.3 + hu(p.id, mm, 2) * 2.2 : cw;
        const tArr = tc >= w1 ? tc - w1 : tc + Pd - (ph.w0 + Math.min(0.3 + hu(p.id, m - 1, 3) * hu(p.id, m - 1, 4) * 4, Math.max(0, ph.wlen - span / p.v - 0.5)) + span / p.v);
        const prevCu = tc >= w1 ? cu : (hu(p.id, m - 1, 1) - 0.5) * (c.cw - 0.8);
        const g = smooth(tArr / 3);
        const a = at(wside * hsp(wside), prevCu), b = at(wside * (hsp(wside) + wcw), wcu);
        x = a[0] + (b[0] - a[0]) * g; z = a[1] + (b[1] - a[1]) * g; walk = g < 1 ? 0.6 : 0;
        yaw = Math.atan2(-P.nx * wside, -P.nz * wside) + (hu(p.id, mm, 5) - 0.5) * 0.6; if (walk) A.PH[i] = (tArr * 0.8 + p.ph0) % 1;
      }
      A.X[i] = x; A.Z[i] = z; A.YAW[i] = yaw; A.WALK[i] = walk; A.POSE[i] = walk ? P_WALK : (hu(p.id, m, 6) < 0.4 ? P_PHONE : P_IDLE);
      return;
    }
    A.X[i] = p.x; A.Z[i] = p.z; A.YAW[i] = p.yaw;   // seated, bouncer
  }
  // every person at t (avoidance near cam if given). A = target arrays (default: this). farR: walkers past it are skipped.
  evaluate(t, cam = null, { farR = 150, avoid = true, A = this } = {}) {
    const farR2 = farR * farR, live = A === this && cam, fr = live ? (this.frame = (this.frame || 0) + 1) : 0;
    for (const u of this.units) {
      // render path: units past 60 m are re-evaluated every 3rd frame (<= 10 cm of lag at 60+ m: sub-pixel)
      // (P3: past 110 m every 6th frame, <= 13 cm at 110+ m)
      // and units behind the camera (cam.fx/fz: its horizontal forward) past 25 m every 6th: not drawn, and a turn shows
      // them at most 0.1 s stale
      if (live && u.trip && u.lk === u.trip.k && u.dc > 25) {
        const k = u.dc > 110 || (u.db > 0 && u.dc > 25) ? 6 : u.dc > 60 ? 3 : 1;
        if (k > 1 && (fr + u.id) % k) continue;
      }
      const vis = this.evalUnit(u, t, A, cam, farR2);
      if (live) {   // door in/out events near the camera (shop chimes), and distance for the stagger
        const tr = u.trip, inNow = vis ? 1 : 0, i0 = u.members[0];
        u.dc = vis ? Math.hypot(A.X[i0] - cam.x, A.Z[i0] - cam.z) : 999;
        u.db = vis && cam.fx != null && ((A.X[i0] - cam.x) * cam.fx + (A.Z[i0] - cam.z) * cam.fz) < -0.3 * u.dc ? 1 : 0;
        let door = null, type = null;
        if (u.lk != null && u.lk !== tr.k) { if (inNow) { door = tr.start; type = 'out'; } }
        else if (u.lk != null && u.lv !== inNow) { door = inNow ? tr.start : tr.end; type = inNow ? 'out' : 'in'; }
        if (door && door.x != null && (door.x - cam.x) ** 2 + (door.z - cam.z) ** 2 < 900) this.events.push({ type, use: door.use, x: door.x, z: door.z });
        u.lk = tr.k; u.lv = inNow;
      }
    }
    const qs = this._qs || (this._qs = []); qs.length = this.queues.length;
    for (let k = 0; k < this.queues.length; k++) qs[k] = this.queueState(this.queues[k], t, qs[k]);
    for (const i of this.statics) this.evalStatic(i, t, A, qs);
    if (avoid && cam) this.avoid(cam, A);
    if (A === this) { this.t = t; this.n++; }
    return A;
  }
  // stateless lateral avoidance near the camera: walkers vs walkers (head-on keep right, overtakes pass left) and vs
  // static discs (standing groups, queues, busk audience, pocha tables); smooth in t, so nobody pops
  avoid(cam, A, R0 = 32) {
    const R2 = R0 * R0, by = new Map(), conn = [], all = [];
    for (const u of this.units) for (const i of u.members) {
      if (!A.VIS[i]) continue; const dx = A.X[i] - cam.x, dz = A.Z[i] - cam.z; if (dx * dx + dz * dz > R2) continue;
      all.push(i); if (A.WAY[i] < 0) { conn.push(i); continue; }
      let l = by.get(A.WAY[i]); if (!l) by.set(A.WAY[i], (l = [])); l.push(i);
    }
    // walkers on connectors (doorways, junction corners): a plain 2-D push away from any other walker within 0.6 m
    if (conn.length) {
      const grid = new Map(), key = (x, z) => Math.floor(x) * 4096 + Math.floor(z);
      for (const i of all) { const k = key(A.X[i], A.Z[i]); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i); }
      for (const i of conn) {
        let px = 0, pz = 0; const gx = Math.floor(A.X[i]), gz = Math.floor(A.Z[i]);
        for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) { const l = grid.get((gx + ox) * 4096 + gz + oz); if (!l) continue;
          for (const j of l) { if (j === i || this.people[j].unit === this.people[i].unit) continue; const dx = A.X[i] - A.X[j], dz = A.Z[i] - A.Z[j], d = Math.hypot(dx, dz); if (d >= 0.6) continue; const f = (0.6 - d) * (A.WAY[j] < 0 ? 0.5 : 1) / Math.max(d, 1e-3); px += dx * f; pz += dz * f; } }
        const m = Math.hypot(px, pz); if (m > 0.5) { px *= 0.5 / m; pz *= 0.5 / m; } A.X[i] += px; A.Z[i] += pz;
      }
    }
    const o = {};
    for (const [wi, L] of by) {
      const w = this.ways[wi]; L.sort((a, b) => A.WS[a] - A.WS[b] || a - b);
      const d0 = Float32Array.from(L, (i) => A.WD[i]), d = d0.slice(), push = new Float32Array(L.length);
      for (let it = 0; it < 12; it++) {   // a few relaxation passes so crowded spots settle instead of trading places
        push.fill(0);
        for (let a = 0; a < L.length; a++) {
          const i = L[a];
          for (let b = a + 1; b < L.length && A.WS[L[b]] - A.WS[i] < 2.2; b++) {
            // (P3: group mates too, at a closer 0.5 m, so a pushed member doesn't walk into its own friend)
            // the lateral clearance a pair needs falls off with their along-way separation over a look-ahead Ls: short for
            // walkers going the same way at about the same pace (P3: a fixed 2.2 m window over-constrained dense streets, so
            // nothing converged: 6-8 % overlaps at 0.35-0.5 p/m^2), longer for overtakes, longest head-on
            const j = L[b], mate = this.people[i].unit === this.people[j].unit, same = A.WDIR[i] === A.WDIR[j];
            const Ls = mate ? 0.9 : same ? 0.8 + 1.4 * Math.min(1, Math.abs(this.units[this.people[i].unit].v - this.units[this.people[j].unit].v) * 2.5) : 2.2;
            const ds = A.WS[j] - A.WS[i]; if (ds >= Ls) continue;
            const dd = d[a] - d[b], kk = 1 - (ds / Ls) ** 2, gap = (mate ? 0.5 : 0.64) * Math.sqrt(kk) - Math.abs(dd); if (gap <= 0) continue;
            const sg = dd !== 0 ? Math.sign(dd) : (A.WDIR[i] > 0 ? 1 : -1);
            push[a] += sg * gap * 0.5; push[b] -= sg * gap * 0.5;
          }
          const ob = w.obst, s = A.WS[i]; let lo = 0, hi = ob.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ob[m][0] < s - 1.6) lo = m + 1; else hi = m; }
          for (let k = lo; k < ob.length && ob[k][0] < s + 1.6; k++) {
            const [os, od, orr] = ob[k], dd = d[a] - od, gap = orr + 0.3 - Math.abs(dd); if (gap <= 0) continue;
            const kk = (1 - ((os - s) / 1.6) ** 2) ** 2; let sg = dd !== 0 ? Math.sign(dd) : 1;
            if ((sg > 0 && od + orr + 0.55 > w.dmax) || (sg < 0 && od - orr - 0.55 < w.dmin)) sg = -sg;   // no room on that side: go round the other
            push[a] += sg * gap * kk;
          }
        }
        for (let a = 0; a < L.length; a++) d[a] = Math.max(w.dmin + 0.2, Math.min(w.dmax - 0.2, d[a] + Math.max(-0.45, Math.min(0.45, push[a] * 0.7))));
      }
      for (let a = 0; a < L.length; a++) {
        const dd = d[a] - d0[a]; if (!dd) continue; const i = L[a];
        w.base.at(A.WS[i], o); A.X[i] += o.nx * dd; A.Z[i] += o.nz * dd; A.WD[i] = d[a];
      }
    }
  }
  // ---- pedestrians as soft colliders (F1: "pedestrians scrape"): vertical capsules at take clock t, camera-free
  // (no avoidance offsets). A 10 Hz index (4 m cells) of everyone, rebuilt only when a low query comes in.
  hit(p, r, t) {
    if (p[1] - r > 2.05) return null;
    // (P3: the index covers 20 m round its centre and is rebuilt when the query strays 8 m from it, so a low pass costs a
    // local evaluate, not the whole crowd's; any person within r + 0.8 of p is within 10 m of the centre: same answer)
    const b = Math.floor(t * 10);
    if (this._hb !== b || !this._hc || Math.hypot(p[0] - this._hc.x, p[2] - this._hc.z) > 8) {
      this._hb = b; this._hc = { x: p[0], z: p[2] }; const N = this.people.length;
      const H = this._hA || (this._hA = { X: new Float32Array(N), Z: new Float32Array(N), YAW: new Float32Array(N), PH: new Float32Array(N), WALK: new Float32Array(N), POSE: new Uint8Array(N), VIS: new Uint8Array(N), WAY: new Int16Array(N), WS: new Float32Array(N), WD: new Float32Array(N), WDIR: new Int8Array(N) });
      this.evaluate(b / 10, this._hc, { avoid: false, A: H, farR: 20 });
      const grid = this._hg = new Map();
      for (let i = 0; i < N; i++) { if (!H.VIS[i]) continue; const k = Math.floor(H.X[i] / 4) * 4096 + Math.floor(H.Z[i] / 4); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i); }
    }
    const H = this._hA, cx = Math.floor(p[0] / 4), cz = Math.floor(p[2] / 4), cand = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const l = this._hg.get((cx + dx) * 4096 + cz + dz); if (l) for (const i of l) if ((H.X[i] - p[0]) ** 2 + (H.Z[i] - p[2]) ** 2 < (r + 0.8) ** 2) cand.push(i); }
    if (!cand.length) return null;
    const E = this._hE || (this._hE = { X: new Float32Array(1), Z: new Float32Array(1), YAW: new Float32Array(1), PH: new Float32Array(1), WALK: new Float32Array(1), POSE: new Uint8Array(1), VIS: new Uint8Array(1), WAY: new Int16Array(1), WS: new Float32Array(1), WD: new Float32Array(1), WDIR: new Int8Array(1) });
    let best = null;
    for (const i of cand) {
      const P = this.people[i]; let x, z;
      if (P.kind === K_WALK) { const u = this.units[P.unit]; this.evalUnit(u, t, H); if (!H.VIS[i]) continue; x = H.X[i]; z = H.Z[i]; }
      else { this.evalStatic(i, t, H, this.queues.map((q) => this.queueState(q, t))); if (!H.VIS[i]) continue; x = H.X[i]; z = H.Z[i]; }
      void E;
      const top = 1.62 * P.scale, rad = 0.2 * P.wide * P.scale, y = Math.max(0.15, Math.min(top - rad, p[1]));
      const dx = p[0] - x, dy = p[1] - y, dz = p[2] - z, d = Math.hypot(dx, dy, dz) || 1e-6, depth = r + rad - d;
      if (depth > 0 && (!best || depth > best.depth)) best = { id: 'p' + i, type: 'person', depth, n: [dx / d, dy / d, dz / d], vel: [0, 0, 0] };
    }
    return best;
  }
}

// appearance (sRGB, art #6). November in Seoul after 22:00: 70 % in dark coats (long padded coats and short puffers),
// black/charcoal/navy/brown, some camel/beige/grey, a few cream puffers; jeans or black trousers; hair on ~95 %
// (black and dark brown, some dyed); skin albedo ~0.30-0.42; phones, shoulder bags, backpacks, scarves, black masks.
const DARK = [[0.025, 0.025, 0.03], [0.03, 0.03, 0.035], [0.04, 0.04, 0.045], [0.05, 0.05, 0.055], [0.09, 0.09, 0.1], [0.12, 0.12, 0.13], [0.06, 0.07, 0.12], [0.07, 0.09, 0.16], [0.13, 0.09, 0.06], [0.16, 0.12, 0.08], [0.1, 0.11, 0.08]];
const MID = [[0.55, 0.47, 0.36], [0.62, 0.52, 0.38], [0.47, 0.34, 0.22], [0.4, 0.4, 0.42], [0.55, 0.55, 0.56], [0.3, 0.32, 0.25], [0.42, 0.12, 0.13], [0.5, 0.44, 0.4]];
const LIGHT = [[0.82, 0.82, 0.8], [0.86, 0.84, 0.78], [0.78, 0.73, 0.64], [0.7, 0.75, 0.82], [0.85, 0.7, 0.72]];
const BOTTOMS = [[0.03, 0.03, 0.035], [0.035, 0.035, 0.04], [0.04, 0.04, 0.05], [0.06, 0.08, 0.14], [0.1, 0.14, 0.24], [0.17, 0.23, 0.35], [0.26, 0.32, 0.44], [0.45, 0.41, 0.34], [0.2, 0.2, 0.21], [0.66, 0.64, 0.6]];
const HAIR = [[0.018, 0.016, 0.014], [0.02, 0.017, 0.015], [0.025, 0.02, 0.017], [0.04, 0.03, 0.024], [0.07, 0.05, 0.035], [0.13, 0.09, 0.06], [0.2, 0.14, 0.09], [0.36, 0.3, 0.24], [0.12, 0.1, 0.12]];
const SKIN = [[0.80, 0.62, 0.50], [0.78, 0.60, 0.48], [0.76, 0.58, 0.47], [0.82, 0.65, 0.54], [0.72, 0.54, 0.43], [0.70, 0.52, 0.40]];
// hair styles (vertex 'style' groups in buildHumanGeo): 0 bald, 1 short, 2 bob, 3 long, 4 ponytail, 5 cap, 6 hood, 7 beanie
export function lookFor(R, male) {
  const pick = (A) => A[Math.floor(R.next() * A.length)];
  const r = R.next(), coat = r < 0.45 ? 1 : r < 0.7 ? 2 : 0;           // 1 long padded coat, 2 short puffer, 0 jacket/hoodie
  const c = R.next(), top = coat ? (c < 0.72 ? pick(DARK) : c < 0.9 ? pick(MID) : pick(LIGHT)) : (c < 0.6 ? pick(DARK) : c < 0.85 ? pick(MID) : pick(LIGHT));
  const hs = R.next();
  let style = male ? (hs < 0.78 ? 1 : hs < 0.86 ? 5 : hs < 0.91 ? 6 : hs < 0.96 ? 7 : 0) : (hs < 0.42 ? 3 : hs < 0.62 ? 2 : hs < 0.82 ? 4 : hs < 0.88 ? 5 : hs < 0.94 ? 7 : 6);
  if (coat === 0 && style === 6 && R.next() < 0.5) style = 1 + (male ? 0 : 2);
  const hairC = R.next() < 0.8 ? pick(HAIR.slice(0, 5)) : pick(HAIR);
  const wear = style === 5 || style === 7 ? pick([[0.03, 0.03, 0.035], [0.03, 0.03, 0.035], [0.12, 0.12, 0.13], [0.5, 0.45, 0.38], [0.75, 0.73, 0.7]]) : top;
  const acc = (R.next() < 0.22 ? 1 : 0) | (R.next() < (male ? 0.12 : 0.1) ? 2 : 0) | (R.next() < 0.1 ? 4 : 0);   // 1 scarf, 2 backpack, 4 black mask
  return { top, bottom: pick(BOTTOMS), hair: hairC, skin: pick(SKIN), wear, coat, bag: R.next() < (male ? 0.2 : 0.55) ? 1 : 0, style, acc, pocket: R.next() < 0.3 ? 1 : 0, umb: 0 };
}

// (P7, life #2: walk0 and w21 repeated a coat silhouette inside 10 m) each person's Rocketbox body, once, and the tone of
// their top: a weighted hash of the id (avatars.w: East Asian x4, suits x0.1, as P6). People are created together (a group
// walking as a unit, a chat cluster, a queue, a pocha table), so within the previous `span` people no two share a body in
// the same tone of top (tintClass: dark / mid / light): a clash keeps the body and re-dyes the top into a tone nobody
// there wears (P6: groups of friends in one body and one black coat), or, with all three taken, re-draws the body.
// -> Int16Array of avatar indices (-1: no body of that sex), with .tops: per person null or a new sRGB top
export const tintClass = (c) => { const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; return l < 0.2 ? 0 : l < 0.6 ? 1 : 2; };
export function assignAvatars(people, meta, w, span = 6) {
  const lists = { m: [], f: [] }; meta.avatars.forEach((av, i) => lists[av.sex === 'm' ? 'm' : 'f'].push(i));
  const out = new Int16Array(people.length).fill(-1), cls = new Int8Array(people.length), tops = new Array(people.length).fill(null);
  const PAL = [0, 1, 2].map((c) => [...DARK, ...MID, ...LIGHT].filter((x) => tintClass(x) === c));
  for (let i = 0; i < people.length; i++) {
    const a = people[i], list = lists[a.male ? 'm' : 'f']; cls[i] = tintClass(a.look.top); if (!list.length) continue;
    let tot = 0; for (const j of list) tot += w[j];
    for (let tr = 0; tr < 8; tr++) {
      const hsh = tr ? h32(a.id, tr, 0x5a1) : (a.id * 2654435761) >>> 0;
      let u = ((hsh >>> 7) / 33554432) * tot, av = list[list.length - 1]; for (const j of list) { u -= w[j]; if (u < 0) { av = j; break; } }
      let used = 0; for (let k = Math.max(0, i - span); k < i; k++) if (out[k] === av) used |= 1 << cls[k];
      if (!(used & (1 << cls[i]))) { out[i] = av; break; }
      const free = [1, 2, 0].find((c) => !(used & (1 << c)));
      if (free !== undefined) { const P = PAL[free]; tops[i] = P[h32(a.id, 0x70b) % P.length]; cls[i] = tintClass(tops[i]); out[i] = av; break; }
      if (tr === 7) out[i] = av;
    }
  }
  out.tops = tops;
  return out;
}
// the avatar weights: suits a tenth, the East Asian bodies (people.json `ea`) x4 (Hongdae on a Friday is 85 %+ Korean)
export const avatarWeights = (meta) => meta.avatars.map((av) => (/^Business/i.test(av.name) ? 0.1 : av.ea ? 4 : 1));

export class LifeSim {
  // setPieces / obstacles: E's (world-seoul ctx); sites: explicit busking sites (override the set pieces')
  constructor(layout, { seed = 1, density = 1, maxAgents, sites, setPieces, obstacles, holes, puddles } = {}) {
    this.net = buildNetwork(layout);
    // E's median BUS SHELTER islands (design #2, P3): the traffic gives them room (see TrafficSim: shelter offsets)
    this.net.shelters = (setPieces || []).filter((p) => p && p.kind === 'shelter' && p.pos && p.dir && p.island);
    this.traffic = new TrafficSim(this.net, { seed });
    const bs = buskSitesFrom(setPieces);
    this.crowd = new CrowdSim(this.net, layout, { seed, density, maxAgents, sites: sites || bs.sites, obstacles: crowdObstacles(obstacles, setPieces ? bs : null), holes, puddles });
    this.t = 0; this.snaps = new Map();
  }
  reset() { this.traffic.reset(); this.t = 0; }
  // advance traffic to take clock t (s). The crowd is closed-form (evaluated where it is drawn or queried). A rewind
  // restores the nearest traffic snapshot (every 10 s of take clock) and re-simulates at most 10 s, bit-identically.
  advanceTo(t) {
    t = Math.max(0, t);
    const T = this.traffic, nt = Math.floor(t * LIFE.trafficHz + 1e-9);
    if (nt < T.n) {
      let best = -1; for (const k of this.snaps.keys()) if (k <= nt && k > best) best = k;
      if (best >= 0) T.restore(this.snaps.get(best)); else T.reset();
    } else if (nt - T.n > 1200) {   // (P5) a jump ahead (a new attempt's later city): from the pre-roll's snapshots
      let best = -1; for (const k of this.snaps.keys()) if (k <= nt && k > T.n && k > best) best = k;
      if (best >= 0) T.restore(this.snaps.get(best));
    }
    while (T.n < nt) { if (T.n % 600 === 0 && !this.snaps.has(T.n) && (T.n <= 36000 || T.n % 3600 === 0)) this.snaps.set(T.n, T.snapshot()); T.step(); }
    this.t = t;
    this.aT = T.n === 0 ? 1 : Math.min(1, Math.max(0, t * LIFE.trafficHz - (T.n - 1)));
  }
  // take-tick entry point (240 Hz): t = tick / 240
  stepTick(tick) { this.advanceTo(tick / 240); }
  // (P5, life #6) a second sim on the same net steps ahead in spare time, leaving its snapshots (every 10 s) for advanceTo
  // and the movers, so a new attempt can open on a later city (60-240 s in) without simulating up to it. -> pre-rolled s
  preroll(steps, upTo = LIFE.warmMax + 15) {
    const N = Math.floor(upTo * LIFE.trafficHz);
    if (!this._pre) {
      if (this.traffic.n >= N) return this.prerolled = upTo;
      // (P6, perf bug 1) start from the latest snapshot the drawn sim has left (its 75 s warm start), not from 0: P5 spent
      // the first 75 s of pre-roll re-simulating what was already on screen, so attemptTicks() was 0 for ~1,100 frames
      this._pre = new TrafficSim(this.net, { seed: this.traffic.seed });
      let best = -1; for (const k of this.snaps.keys()) if (k <= N && k > best) best = k;
      if (best > 0) this._pre.restore(this.snaps.get(best));
    }
    const P = this._pre;
    for (let k = 0; k < steps && P.n < N; k++) { if (P.n % 600 === 0 && !this.snaps.has(P.n)) this.snaps.set(P.n, P.snapshot()); P.step(); }
    this.prerolled = Math.max(this.traffic.n, P.n) / LIFE.trafficHz;
    if (P.n >= N && P.step) { this.snaps.set(P.n, P.snapshot()); this._pre = { n: N }; }   // done: drop the sim
    return this.prerolled;
  }
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
  // pedestrians at t (soft contact: scrape, not crash)
  hitPeople(p, r, t) { return this.crowd.hit(p, r, t); }
  // a hash of the full traffic state (replay parity checks)
  hash() {
    let h = 2166136261 >>> 0; const f = new Float64Array(1), u = new Uint32Array(f.buffer);
    for (const v of this.traffic.vehicles) { for (const x of [v.s, v.v]) { f[0] = x; h = Math.imul(h ^ u[0], 16777619) >>> 0; h = Math.imul(h ^ u[1], 16777619) >>> 0; } h = Math.imul(h ^ (v.id + 1), 16777619) >>> 0; }
    return h.toString(16);
  }
}

// ================================================================ rendering
const STATIC_ATTR = new Set(['iTop', 'iBot', 'iHair', 'iSkin', 'iWear']);   // (P7) per-person, constant
const lin = (c) => c.map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));

// ---- procedural human (art #6, life #3/#4). CC0 by construction (built here, no asset). Bones: 0 pelvis/torso, 1 head,
//      2 L thigh, 3 L shin, 4 R thigh, 5 R shin, 6 L upper arm, 7 L forearm, 8 R upper arm, 9 R forearm, 10 phone (R hand),
//      11 coat skirt, 12 umbrella, 13 L foot, 14 R foot.
// Regions: 0 skin, 1 hair, 2 top, 3 bottom, 4 shoes, 5 phone screen, 6 bag, 7 umbrella, 8 headwear (cap/hood/beanie), 9 scarf.
// Groups (vertex 'grp'; the instance's style/accessories pick which show): 0 always, 1-7 hair styles (1 short, 2 bob,
// 3 long, 4 ponytail, 5 cap, 6 hood, 7 beanie), 98 far-LOD hair (any style but bald), 11 scarf, 12 backpack.
function buildHumanGeo(lod) {
  const P = [], N = [], B = [], G = [], S = [];
  const rs = [10, 6, 4][lod], hs = [8, 5, 3][lod];
  let grp = 0;
  const vtx = (x, y, z, nx, ny, nz, bone, reg) => { P.push(x, y, z); N.push(nx, ny, nz); B.push(bone); G.push(reg); S.push(grp); };
  // ring-stack primitive: list of [y, rx, rz, cx, cz]; region fn(y, angle) -> region
  function tube(rings, bone, region, closeTop = false, closeBot = false) {
    const base = P.length / 3, nr = rings.length;
    for (let i = 0; i < nr; i++) {
      const [y, rx, rz, cx = 0, cz = 0] = rings[i];
      for (let k = 0; k < rs; k++) {
        const a = (k / rs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const dy = i === 0 ? rings[1][0] - y : y - rings[i - 1][0], dr = i === 0 ? rings[1][1] - rx : rx - rings[i - 1][1];
        const ny = -dr / (Math.abs(dy) + 1e-6) * 0.5; const l = Math.hypot(ca, ny, sa);
        vtx(cx + ca * rx, y, cz + sa * rz, ca / l, ny / l, sa / l, bone, typeof region === 'function' ? region(y, a) : region);
      }
    }
    const idx = [];
    for (let i = 0; i < nr - 1; i++) for (let k = 0; k < rs; k++) {
      const a = base + i * rs + k, b = base + i * rs + ((k + 1) % rs), c = a + rs, d = b + rs;
      idx.push(a, c, b, b, c, d);
    }
    const cap = (i, up) => { const [y, , , cx = 0, cz = 0] = rings[i]; const ci = P.length / 3; vtx(cx, y, cz, 0, up ? 1 : -1, 0, bone, typeof region === 'function' ? region(y, 0) : region); for (let k = 0; k < rs; k++) { const a = base + i * rs + k, b = base + i * rs + ((k + 1) % rs); up ? idx.push(ci, b, a) : idx.push(ci, a, b); } };
    if (closeTop) cap(nr - 1, true); if (closeBot) cap(0, false);
    return idx;
  }
  function box(x0, y0, z0, x1, y1, z1, bone, region) {
    const base = P.length / 3, idx = [];
    const f = [[[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]], [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
      [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]], [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
      [[0, 0, 1], [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]]], [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]]];
    let q = 0;
    for (const [n, vs] of f) { for (const v of vs) vtx(v[0], v[1], v[2], n[0], n[1], n[2], bone, typeof region === 'function' ? region(n) : region); const o = base + q * 4; idx.push(o, o + 1, o + 2, o, o + 2, o + 3); q++; }
    return idx;
  }
  // a partial ellipsoid shell around the head centre (hair, hood, cap): keep(x, y, z) on the unit sphere picks the
  // faces; rad(x, y, z) scales the radius (volume, flare). Head centre (0, 1.6, 0.01), radii (0.085, 0.112, 0.1).
  const HC = [0, 1.6, 0.01], HR = [0.085, 0.112, 0.1];
  function shell(bone, region, keep, rad, nth = hs + 2, nph = rs + 2) {
    const base = P.length / 3, idx = [], kept = [];
    for (let i = 0; i <= nth; i++) for (let k = 0; k <= nph; k++) {
      const th = (i / nth) * Math.PI, a = (k / nph) * Math.PI * 2, x = Math.sin(th) * Math.cos(a), y = Math.cos(th), z = Math.sin(th) * Math.sin(a);
      const r = rad(x, y, z); vtx(HC[0] + x * HR[0] * r, HC[1] + y * HR[1] * r, HC[2] + z * HR[2] * r, x, y, z, bone, typeof region === 'function' ? region(x, y, z) : region);
      kept.push(keep(x, y, z));
    }
    const W = nph + 1;
    for (let i = 0; i < nth; i++) for (let k = 0; k < nph; k++) {
      const a = i * W + k, b = a + 1, c = a + W, d = c + 1;
      if (kept[a] && kept[b] && kept[c] && kept[d]) idx.push(base + a, base + b, base + c, base + b, base + d, base + c);
    }
    return idx;
  }
  const I = [];
  const add = (a) => { for (const v of a) I.push(v); };
  // legs (x = +-0.095), hip pivot y 0.9, knee 0.48, ankle 0.09
  for (const [sx, th, sh, ft] of [[0.095, 2, 3, 13], [-0.095, 4, 5, 14]]) {
    add(tube([[0.9, 0.08, 0.084, sx, 0], [0.7, 0.069, 0.071, sx, 0.005], [0.5, 0.055, 0.058, sx, 0.01]], th, 3));
    // (P7, perf #1: the far tier is ~1100 people a shot) far: no foot box, the shin runs to the ground, closed (a shoe-dark cap)
    if (lod < 2) { add(tube([[0.5, 0.055, 0.058, sx, 0.01], [0.32, 0.05, 0.055, sx, -0.005], [0.12, 0.037, 0.04, sx, 0]], sh, 3)); add(box(sx - 0.046, 0, -0.06, sx + 0.046, 0.115, 0.17, ft, 4)); }
    else add(tube([[0.5, 0.055, 0.058, sx, 0.01], [0.1, 0.045, 0.06, sx, 0.02], [0.0, 0.045, 0.07, sx, 0.035]], sh, (y) => (y < 0.11 ? 4 : 3), false, true));
  }
  // pelvis + torso (back is -z, chest +z), shoulders y 1.39
  add(tube(lod < 2 ? [[0.84, 0.15, 0.105], [0.98, 0.16, 0.105], [1.12, 0.155, 0.11], [1.3, 0.18, 0.12], [1.39, 0.2, 0.105], [1.44, 0.1, 0.07]]
    : [[0.84, 0.15, 0.105], [0.98, 0.16, 0.105], [1.3, 0.18, 0.12], [1.42, 0.17, 0.09]], 0, (y) => (y < 0.97 ? 3 : 2), true, true));   // (P7) far: 4 rings
  // head + neck (all skin; hair is shells; far: the head sits on the shoulders' cap)
  if (lod < 2) add(tube([[1.42, 0.05, 0.05, 0, 0.01], [1.5, 0.05, 0.05, 0, 0.01]], 1, 0));
  add(shell(1, 0, () => true, () => 1, hs, rs));
  // arms: shoulder pivot (+-0.2, 1.38), elbow y 1.1, wrist 0.86; a mitten hand
  for (const [sx, ua, fa] of [[0.205, 6, 7], [-0.205, 8, 9]]) {
    add(tube([[1.41, 0.05, 0.052, sx, 0], [1.25, 0.046, 0.048, sx, 0], [1.1, 0.042, 0.044, sx, 0.005]], ua, 2, true));
    add(tube([[1.1, 0.042, 0.044, sx, 0.005], [0.9, 0.036, 0.037, sx, 0.01], [0.85, 0.034, 0.033, sx, 0.01]], fa, 2, false, true));
    if (lod < 2) add(box(sx - 0.02, 0.72, -0.02, sx + 0.02, 0.85, 0.045, fa, 0));   // (P7) far: no hand box
  }
  if (lod < 2) {
    // phone in the right hand (screen faces the body)
    add(box(-0.24, 0.8, 0.0, -0.17, 0.95, 0.012, 10, (n) => (n[2] < 0 ? 5 : 6)));
    // long coat skirt (coat 1 only), hip to knee
    add(tube([[0.98, 0.17, 0.115], [0.75, 0.2, 0.145], [0.5, 0.215, 0.16]], 11, 2, false, false));
    // shoulder bag on the left hip
    add(box(0.17, 0.86, -0.08, 0.235, 1.07, 0.1, 0, 6));
    // scarf (grp 11) and backpack (grp 12)
    grp = 11; add(tube([[1.4, 0.13, 0.118], [1.45, 0.095, 0.088], [1.5, 0.07, 0.07, 0, 0.005]], 0, 9, false, false)); grp = 0;
    grp = 12; add(box(-0.14, 1.0, -0.27, 0.14, 1.36, -0.12, 0, 6)); grp = 0;
  }
  // hair / headwear shells
  if (lod < 2) {
    const R = (k) => () => k;
    grp = 1; add(shell(1, 1, (x, y, z) => y > 0.18 || (z < 0.15 && y > -0.38 + 0.6 * Math.max(0, z)), (x, y, z) => 1.07 + 0.03 * Math.max(0, y)));
    grp = 2; add(shell(1, 1, (x, y, z) => y > 0.2 || (z < 0.42 && y > -0.88), (x, y, z) => 1.1 + 0.05 * Math.max(0, -y) + 0.02 * Math.max(0, y)));
    grp = 3; add(shell(1, 1, (x, y, z) => y > 0.2 || (z < 0.45 && y > -0.95), (x, y, z) => 1.1 + 0.04 * Math.max(0, -y)));
    add(tube([[1.6, 0.1, 0.06, 0, -0.07], [1.45, 0.11, 0.05, 0, -0.1], [1.3, 0.12, 0.04, 0, -0.13], [1.2, 0.1, 0.03, 0, -0.135]], 0, 1, false, false));
    grp = 4; add(shell(1, 1, (x, y, z) => y > 0.15 || (z < 0.2 && y > -0.45), R(1.06)));
    add(tube([[1.66, 0.028, 0.03, 0, -0.115], [1.56, 0.03, 0.028, 0, -0.14], [1.44, 0.018, 0.018, 0, -0.15], [1.38, 0.006, 0.006, 0, -0.15]], 1, 1, false, false));
    grp = 5; add(shell(1, 8, (x, y, z) => y > 0.05, (x, y, z) => 1.08 + 0.04 * Math.max(0, y)));
    add(box(-0.075, 1.6 + 0.112 * 0.12, 0.07, 0.075, 1.6 + 0.112 * 0.12 + 0.012, 0.19, 1, 8));
    add(shell(1, 1, (x, y, z) => z < -0.3 && y > -0.45 && y < 0.12, R(1.05)));
    grp = 6; add(shell(1, 8, (x, y, z) => z < 0.55 && y > -0.95, (x, y, z) => 1.28 + 0.06 * Math.max(0, -z)));
    grp = 7; add(shell(1, 8, (x, y, z) => y > -0.08, (x, y, z) => 1.09 + 0.05 * Math.max(0, y)));
    add(shell(1, 1, (x, y, z) => z < -0.2 && y > -0.4 && y < 0.0, R(1.05)));
  } else {
    grp = 98; add(shell(1, 1, (x, y, z) => y > 0.1 || (z < 0 && y > -0.4), () => 1.08, 3, 5));
  }
  grp = 0;
  // umbrella (rain mode): canopy cone over the head on a shaft
  if (!lod) add(tube([[1.95, 0.5, 0.5, 0, 0.15], [2.1, 0.25, 0.25, 0, 0.15], [2.16, 0.01, 0.01, 0, 0.15]], 12, 7));
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  const bd = new Float32Array(B.length * 4); for (let i = 0; i < B.length; i++) { bd[i * 4] = B[i]; bd[i * 4 + 1] = B[i]; bd[i * 4 + 3] = G[i]; }
  g.setAttribute('bdat', new THREE.Float32BufferAttribute(bd, 4));
  g.setAttribute('grp', new THREE.Float32BufferAttribute(S, 1));
  g.setIndex(I);
  return g;
}

const HUMAN_VS = /* glsl */`
// bone, second bone, its weight x 255, region (P3: one vec4, so the 9 instance vec4s still fit in 16 attributes; Rocketbox
// avatars blend two bones, the procedural body has weight 0)
attribute vec4 bdat;
attribute float grp;
attribute vec2 auv;     // atlas uv (textured avatars)
attribute vec4 iPos;    // x, y, z, yaw
attribute vec4 iAnim;   // gait phase, walk amount, pose, height scale
attribute vec4 iTop;    // top rgb, coat (0 jacket, 1 long padded coat, 2 short puffer)
attribute vec4 iBot;    // bottom rgb, bag flag
attribute vec4 iHair;   // hair rgb, width scale
attribute vec4 iSkin;   // skin rgb, umbrella flag
attribute vec4 iFill;   // fill rgb (lux, linear), dir angle
attribute vec4 iWear;   // headwear rgb, hair style
attribute vec4 iLook;   // head yaw, head pitch (rad, look-at), accessory bits (1 scarf 2 backpack 4 mask 8 pockets), seed
varying vec3 vAlb;
varying vec3 vHairC;    // the person's hair colour (P4: an avatar's scalp texels take it, aux.png r)
varying vec3 vFillE;
varying float vScreen;
varying vec3 vRest;
varying vec4 vMisc;     // region, bone, coat, accessory bits
varying vec2 vUv;
uniform float uTime;
uniform float uNit;
// the body's joints (P3): procedural body hipX 0.095, hipY 0.9, knee 0.48, ankle 0.09 / shoulder 0.205, 1.38, elbow 1.1,
// neck 1.46 / kneeZ 0.01, elbowZ 0.005, height comp 1, textured 0; a Rocketbox avatar passes its own (seoul/people)
uniform vec4 uJA;       // hipX, hipY, kneeY, ankleY
uniform vec4 uJB;       // shX, shY, elY, neckY
uniform vec4 uJC;       // kneeZ, elZ, height comp, textured
vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
// rotate p (y,z) about pivot (py,pz) by forward angle a (positive swings the limb end forward = +z)
vec3 swing(vec3 p, float py, float pz, float a) { vec2 q = rot(vec2(p.z - pz, p.y - py), -a); return vec3(p.x, py + q.y, pz + q.x); }
vec3 swingN(vec3 n, float a) { vec2 q = rot(vec2(n.z, n.y), -a); return vec3(n.x, q.y, q.x); }
// about the vertical axis (positive turns +x toward -z) and about the forward axis at a pivot (abduction, + raises +x side)
vec3 rotY(vec3 p, float a) { vec2 q = rot(vec2(p.x, p.z), a); return vec3(q.x, p.y, q.y); }
vec3 rotZ(vec3 p, float px, float py, float a) { vec2 q = rot(vec2(p.x - px, p.y - py), a); return vec3(px + q.x, py + q.y, p.z); }
vec3 rotZN(vec3 n, float a) { vec2 q = rot(n.xy, a); return vec3(q, n.z); }
float gb(float x, float c, float w) { float d = x - c; d -= floor(d + 0.5); return exp(-d * d / (w * w)); }
// normative gait (Winter / Perry, sagittal, degrees -> rad), phase 0 = heel strike of that leg
float hipC(float f) { return radians(10.0 + 21.0 * cos(6.2831853 * (f - 0.92))); }
float kneeC(float f) { return radians(4.0 + 15.0 * gb(f, 0.14, 0.07) + 56.0 * gb(f, 0.72, 0.11)); }
float ankleC(float f) { return radians(2.0 - 4.0 * gb(f, 0.04, 0.04) + 9.0 * gb(f, 0.42, 0.12) - 18.0 * gb(f, 0.62, 0.05)); }
// joint angles for this vertex's person (set in main, read by rig)
float gHipL, gHipR, gKnL, gKnR, gAnL, gAnR, gSL, gSR, gEL, gER, gAbL, gAbR, gHeadP, gHeadY, gPelR, gThR, gPelZ, gSit;
// one bone's part of the pose: limb swings, pelvis / thorax twist, the upper body's counter-tilt over the stance hip
vec3 rig(vec3 p, inout vec3 nrm, float b, float restY) {
  bool legB = b > 1.5 && b < 5.5 || b > 12.5;
  if (legB) {
    bool left = b < 3.5 || b == 13.0; float hip = left ? gHipL : gHipR, kn = left ? gKnL : gKnR, an = left ? gAnL : gAnR;
    if (b > 12.5) { p = swing(p, uJA.w, 0.0, an); nrm = swingN(nrm, an); }
    if (b == 3.0 || b == 5.0 || b > 12.5) { p = swing(p, uJA.z, uJC.x, -kn); nrm = swingN(nrm, -kn); }
    p = swing(p, uJA.y, 0.0, hip); nrm = swingN(nrm, hip);
  } else if (b > 5.5 && b < 10.5) {
    bool left = b < 7.5; float sh = left ? gSL : gSR, el = left ? gEL : gER, ab = left ? gAbL : gAbR;
    if (b == 7.0 || b == 9.0 || b == 10.0) { p = swing(p, uJB.z, uJC.y, el); nrm = swingN(nrm, el); }
    p = swing(p, uJB.y, 0.0, sh); nrm = swingN(nrm, sh);
    float sx = left ? uJB.x : -uJB.x, aa = left ? ab : -ab; p = rotZ(p, sx, uJB.y, aa); nrm = rotZN(nrm, aa);
  } else if (b > 0.5 && b < 1.5) {
    p = swing(p, uJB.w, 0.0, gHeadP); nrm = swingN(nrm, gHeadP);
    p = rotY(p, gHeadY); nrm = rotY(nrm, gHeadY);
  } else if (b > 10.5 && b < 11.5) {   // coat follows the thighs a little
    float sw = 0.35 * (gHipL - gHipR) * 0.5 * sign(p.x) * smoothstep(0.95, 0.5, p.y);
    p.z += sw * (0.95 - p.y);
    p = mix(p, swing(p, 0.9, 0.0, 1.4), gSit);
  }
  // pelvis / thorax rotation about the vertical axis, by height (legs and pelvis with the pelvis, arms and head with the thorax)
  float tw = legB || (b > 10.5 && b < 11.5) ? gPelR : (b > 5.5 && b < 10.5) || (b > 0.5 && b < 1.5) ? gThR : mix(gPelR, gThR, smoothstep(uJA.y + 0.07, uJA.y + 0.4, restY));
  p = rotY(p, tw); nrm = rotY(nrm, tw);
  if (!legB && b < 10.5) { p = rotZ(p, 0.0, uJA.y + 0.05, -0.6 * gPelZ); nrm = rotZN(nrm, -0.6 * gPelZ); }   // hip drop: the upper body counter-tilts
  return p;
}
`;
const HUMAN_ANIM = /* glsl */`
  float bone = bdat.x, bone2 = bdat.y, bw = bdat.z / 255.0, region = bdat.w;
  float ph = iAnim.x, wa = iAnim.y, poseI = floor(iAnim.z + 0.5), hs = iAnim.w * uJC.z;
  float acc = iLook.z, seed = iLook.w, T = uTime + seed * 37.0, tex = uJC.w;
  float scarf = mod(acc, 2.0), backpack = mod(floor(acc / 2.0), 2.0), pocket = mod(floor(acc / 8.0), 2.0);
  float sitP = float(poseI == 3.0), phoneP = float(poseI == 1.0), talkP = float(poseI == 4.0), smokeP = float(poseI == 5.0);
  float filmP = float(poseI == 6.0), danceP = float(poseI == 7.0), singP = float(poseI == 8.0), clapP = float(poseI == 9.0), flinchP = float(poseI == 10.0);
  float style = floor(iWear.w + 0.5), coat = floor(iTop.w + 0.5);
  vec3 p = position, nrm = normal;
  // (P4) 28 Rocketbox head vertices carry a zero normal (welded seams that cancel): normalize(0) put NaN pixels on heads
  // (C: 63 px in walk0). Point them out from the head's centre instead.
  if (dot(nrm, nrm) < 1e-4) { vec3 r = position - vec3(0.0, uJB.w + 0.12, 0.02); nrm = dot(r, r) > 1e-8 ? normalize(r) : vec3(0.0, 1.0, 0.0); }
  // ---- what this person doesn't have
  float hide = 0.0;
  if (bone > 9.5 && bone < 10.5) hide = 1.0 - max(max(phoneP, filmP), 0.0);
  if (bone > 10.5 && bone < 11.5) hide = 1.0 - float(coat == 1.0);
  if (bone > 11.5 && bone < 12.5) hide = 1.0 - iSkin.w;
  if (region > 5.5 && region < 6.5 && bone < 0.5 && grp < 0.5) hide = 1.0 - iBot.w;
  if (grp > 0.5 && grp < 7.5) hide = float(abs(grp - style) > 0.5);
  if (grp > 97.5) hide = float(style < 0.5);
  if (grp > 10.5 && grp < 11.5) hide = 1.0 - scarf;
  if (grp > 11.5 && grp < 12.5) hide = 1.0 - backpack;
  // (P8, life #1) an avatar's own accessories (seoul/tools/people-bake.mjs): region 8 a cap (style 5), 11 a beanie (style 7),
  // 10 a backpack (bit 2), 6 the tote (bag flag, above); the procedural body's caps and hoods are groups 5-7
  if (grp < 0.5 && region > 7.5 && region < 8.5) hide = float(style != 5.0);
  if (region > 10.5 && region < 11.5) hide = float(style != 7.0);
  if (region > 9.5 && region < 10.5) hide = 1.0 - backpack;
  // ---- bulk: puffers and padded coats are thick (procedural body only; an avatar wears its own clothes)
  float bulk = tex > 0.5 ? 1.0 : coat == 2.0 ? 1.13 : coat == 1.0 ? 1.06 : 1.0;
  // (P8, life #1) a short puffer on an avatar: its top (region 2: torso and sleeves) stands 2.2 cm off the body along the
  // normal (1.4 cm on the forearms), quilted in the fragment shader; a quarter of the crowd (coat 2) wears one
  if (tex > 0.5 && coat == 2.0 && region > 1.5 && region < 2.5 && bone < 9.5) p += nrm * (bone == 7.0 || bone == 9.0 ? 0.014 : 0.022);
  if (bone < 0.5 && position.y > 0.95 && grp < 0.5 && region > 1.5 && region < 2.5) p.xz *= bulk;
  if (bone > 5.5 && bone < 9.5 && region > 1.5) { float ax = bone < 7.5 ? uJB.x : -uJB.x; p.x = ax + (p.x - ax) * bulk; p.z *= bulk; }
  // ---- gait (wa = walk amount): normative joint curves, stance-leg hip height, pelvis rotation, thorax counter-rotation
  float fL = ph, fR = fract(ph + 0.5);
  float hipL = wa * hipC(fL), hipR = wa * hipC(fR), knL = wa * kneeC(fL) + (1.0 - wa) * 0.03, knR = wa * kneeC(fR) + (1.0 - wa) * 0.03;
  float anL = -wa * ankleC(fL), anR = -wa * ankleC(fR);
  float armK = wa * (1.0 - 0.85 * pocket);
  float sL = armK * radians(6.0 + 16.0 * cos(6.2831853 * (ph - 0.42))) - 0.06 * pocket, sR = armK * radians(6.0 + 16.0 * cos(6.2831853 * (ph - 0.92))) - 0.06 * pocket;
  float eL = radians(16.0) + armK * radians(14.0) * (0.5 + 0.5 * cos(6.2831853 * (ph - 0.42))) + 0.3 * pocket, eR = radians(16.0) + armK * radians(14.0) * (0.5 + 0.5 * cos(6.2831853 * (ph - 0.92))) + 0.3 * pocket;
  float abL = 0.04 + 0.08 * pocket, abR = 0.04 + 0.08 * pocket;
  float pelR = -0.075 * wa * cos(6.2831853 * ph), thR = -0.55 * pelR;
  float headP = 0.0, headY = 0.0, swayX = 0.021 * wa * sin(6.2831853 * ph), lift = 0.0, pelZ = 0.0;
  // ---- standing (1 - wa): contrapposto weight shifts every ~11 s, small head turns
  float idle = 1.0 - wa, wsh = smoothstep(-0.35, 0.35, sin(T * 0.57 + seed * 9.0));
  knL += idle * 0.2 * wsh; hipL += idle * 0.07 * wsh; knR += idle * 0.2 * (1.0 - wsh); hipR += idle * 0.07 * (1.0 - wsh);
  swayX += idle * 0.028 * (1.0 - 2.0 * wsh) * (1.0 - sitP); pelZ = idle * 0.045 * (2.0 * wsh - 1.0) * (1.0 - sitP);
  headY += idle * 0.25 * sin(T * 0.23 + seed * 5.0) * sin(T * 0.11 + seed);
  // talk: gesture bursts with both forearms, nods
  float burst = max(0.0, sin(T * 0.45 + seed * 3.0)), gst = burst * max(0.0, sin(T * 1.7 + seed));
  sL += talkP * idle * 0.25 * gst; eL += talkP * idle * (0.5 + 0.9 * gst); sR += talkP * idle * 0.12 * burst; eR += talkP * idle * 0.45 * burst * max(0.0, sin(T * 1.3 + 2.0));
  headP += talkP * idle * 0.06 * sin(T * 2.3) * burst;
  // phone: right forearm up in front, head down (walking too)
  sR = mix(sR, 0.35, phoneP); eR = mix(eR, 1.45, phoneP); headP += 0.38 * phoneP; abR = mix(abR, -0.12, phoneP);
  // smoke: hand to mouth for ~2 s every 9 s
  float su = fract(T / 9.0 + seed), toM = smokeP * smoothstep(0.0, 0.05, su) * (1.0 - smoothstep(0.18, 0.24, su));
  sR = mix(sR, mix(0.12, 0.55, toM), smokeP); eR = mix(eR, mix(0.55, 2.25, toM), smokeP); abR = mix(abR, -0.25 * toM, smokeP); headP -= 0.1 * toM;
  // film: right arm up holding the phone at eye level, head up (the drone is the show)
  sR = mix(sR, 1.25, filmP); eR = mix(eR, 0.4, filmP); abR = mix(abR, -0.15, filmP); headP -= 0.18 * filmP;
  // clap: forearms in front, hands meeting at ~3.3 Hz
  float cl = sin(T * 20.7);
  sL = mix(sL, 0.75, clapP); sR = mix(sR, 0.75, clapP); eL = mix(eL, 1.25, clapP); eR = mix(eR, 1.25, clapP);
  abL = mix(abL, -0.32 - 0.12 * cl, clapP); abR = mix(abR, -0.32 - 0.12 * cl, clapP);
  // dance (busking cover crews): beat phase in ph, 8-beat moves, knees bounce, hips sway, arms pump
  float beat = ph, bar = floor(T * 2.0667 / 8.0), mv = mod(bar + floor(seed * 3.0), 3.0), bounce = 0.5 + 0.5 * cos(6.2831853 * beat);
  float side = sin(3.14159 * (T * 2.0667));
  knL += danceP * (0.12 + 0.25 * bounce); knR += danceP * (0.12 + 0.25 * bounce); hipL += danceP * 0.12 * bounce; hipR += danceP * 0.12 * bounce;
  swayX += danceP * 0.06 * side; thR += danceP * 0.22 * side; lift -= danceP * 0.035 * bounce;
  float up = mv < 0.5 ? max(0.0, side) : mv < 1.5 ? bounce : 0.6;
  sL = mix(sL, 0.3 + 1.6 * (mv < 1.5 ? up : max(0.0, -side)), danceP); sR = mix(sR, 0.3 + 1.6 * (mv < 0.5 ? max(0.0, -side) : up), danceP);
  eL = mix(eL, 0.5 + 0.8 * bounce, danceP); eR = mix(eR, 0.5 + 0.8 * bounce, danceP); abL = mix(abL, 0.25 + 0.4 * up, danceP); abR = mix(abR, 0.25 + 0.4 * up, danceP);
  headP += danceP * 0.08 * bounce;
  // sing + guitar (acoustic busker): mic hand at the mouth, strumming arm
  sL = mix(sL, 0.65, singP); eL = mix(eL, 2.0, singP); abL = mix(abL, -0.2, singP);
  sR = mix(sR, 0.25 + 0.12 * sin(T * 25.0), singP); eR = mix(eR, 1.45, singP); abR = mix(abR, -0.3, singP); headY += singP * 0.15 * sin(T * 0.7);
  // umbrella: right arm up, holding the shaft
  sR = mix(sR, 0.7, iSkin.w); eR = mix(eR, 1.2, iSkin.w); abR = mix(abR, 0.0, iSkin.w);
  // sit (pocha stools), a drink every ~14 s
  float du = fract(T / 14.0 + seed * 1.7), drink = sitP * smoothstep(0.0, 0.06, du) * (1.0 - smoothstep(0.16, 0.22, du));
  hipL = mix(hipL, 1.45, sitP); hipR = mix(hipR, 1.35, sitP); knL = mix(knL, 1.5, sitP); knR = mix(knR, 1.4, sitP); anL *= 1.0 - sitP; anR *= 1.0 - sitP;
  sL = mix(sL, 0.5, sitP); sR = mix(sR, mix(0.55 + 0.25 * phoneP, 0.7, drink), sitP); eL = mix(eL, 1.1, sitP); eR = mix(eR, mix(1.3, 2.2, drink), sitP); headP -= 0.12 * drink;
  // flinch (P4, life #4): a drone at head height within 2.5 m. (P5, graphics bug: P4's forearms-up read as a hold-up) a duck:
  // knees give, head ducks forward, hands come up to the chest at most (upper arm 0.4 rad forward, forearm across)
  sL = mix(sL, 0.4, flinchP); sR = mix(sR, 0.4, flinchP); eL = mix(eL, 1.25, flinchP); eR = mix(eR, 1.25, flinchP);
  abL = mix(abL, -0.15, flinchP); abR = mix(abR, -0.15, flinchP); headP += 0.18 * flinchP; knL += 0.32 * flinchP; knR += 0.32 * flinchP;
  // look-at (CPU-side: people turn their heads to the drone, filmers aim up)
  headY += iLook.x; headP += iLook.y;
  // ---- skeleton: each vertex's bone (and, on an avatar, its second bone blended by weight bw)
  gHipL = hipL; gHipR = hipR; gKnL = knL; gKnR = knR; gAnL = anL; gAnR = anR; gSL = sL; gSR = sR; gEL = eL; gER = eR; gAbL = abL; gAbR = abR;
  gHeadP = headP; gHeadY = headY; gPelR = pelR; gThR = thR; gPelZ = pelZ; gSit = sitP;
  vec3 nA = nrm, pRest = p; p = rig(p, nA, bone, position.y);
  if (bw > 0.004) { vec3 nB = nrm, pB = rig(pRest, nB, bone2, position.y); p = mix(p, pB, bw); vec3 nm = mix(nA, nB, bw); nA = dot(nm, nm) > 1e-8 ? normalize(nm) : nA; }
  nrm = nA;
  // body height from the stance leg (the longer of the two: the planted one), so the bob comes out of the gait itself
  float thighL = uJA.y - uJA.z, shinL = uJA.z - uJA.w;
  float lenL = thighL * cos(hipL) + shinL * cos(hipL - knL) + uJA.w, lenR = thighL * cos(hipR) + shinL * cos(hipR - knR) + uJA.w;
  float bob = (max(lenL, lenR) - uJA.y) * (1.0 - sitP) - sitP * 0.47 * uJA.y / 0.9 + lift;
  p.y += bob;
  p.x += swayX;
  p.x *= iHair.w;
  p *= hs;
  p *= 1.0 - hide;
  float yaw = iPos.w; vec2 xz = rot(vec2(p.z, p.x), yaw); p = vec3(xz.y, p.y, xz.x) + iPos.xyz;
  vec2 nxz = rot(vec2(nrm.z, nrm.x), yaw); nrm = vec3(nxz.y, nrm.y, nxz.x);
  // albedo by region (region 3 on a coat's thighs stays coat; headwear and hood take the wear colour; scarf a muted accent).
  // On an avatar these are the tint targets for its texture classes (0 skin, 1 hair, 2 top, 3 bottom, 4 shoes).
  vec3 alb = region < 0.5 ? iSkin.rgb : region < 1.5 ? iHair.rgb : region < 2.5 ? iTop.rgb : region < 3.5 ? (tex < 0.5 && bone > 1.5 && bone < 5.5 && coat == 1.0 && position.y > 0.62 ? iTop.rgb : iBot.rgb)
    : region < 4.5 ? vec3(0.03) : region < 5.5 ? vec3(0.02) : region < 6.5 ? (fract(seed * 7.31) < 0.35 && bone < 0.5 ? vec3(0.5, 0.46, 0.38) : vec3(0.04, 0.035, 0.03)) : region < 7.5 ? vec3(0.02, 0.02, 0.025) : region < 8.5 ? iWear.rgb
    : region < 9.5 ? mix(iBot.rgb, vec3(0.32, 0.08, 0.07), 0.6) : region < 10.5 ? (fract(seed * 3.7) < 0.6 ? vec3(0.025, 0.025, 0.03) : fract(seed * 3.7) < 0.8 ? vec3(0.07, 0.08, 0.12) : vec3(0.3, 0.27, 0.22)) : iWear.rgb;   // (P8: 6 a third of totes canvas; 10 backpack black / navy / beige; 11 beanie)
  vAlb = alb; vUv = auv; vHairC = iHair.rgb;
  vRest = position; vMisc = vec4(region, bone, coat, acc);
  vScreen = (region > 4.5 && region < 5.5) ? max(phoneP, filmP) : 0.0;
  // (P7, life bug: station2's phones were floating white dots at 25 m, a 160-nit screen spread by the bloom) the screen
  // fades to 15 % between 12 and 20 m
  vScreen *= 1.0 - 0.85 * smoothstep(12.0, 20.0, distance(p, cameraPosition));
  // shopfront fill (lux) arriving from direction iFill.w, wrapped diffuse + a weak overhead/street term
  vec3 L = vec3(sin(iFill.w), 0.25, cos(iFill.w));
  float wrap = max(0.0, (dot(normalize(nrm), normalize(L)) + 0.35) / 1.35);
  float top = max(0.0, nrm.y) * 0.35 + 0.15;
  vFillE = iFill.rgb * (wrap * 0.85 + top * 0.3) * uNit / 3.14159;
`;
// fragment detail: fabric (puffer quilting, denim twill, knit ribs, wool), hair strands, and a face (eye sockets, brows,
// nose and chin shading, a black mask on some) so a head reads as a head and not a bald egg at 3-15 m. On a textured
// avatar (P3): its own maps, each class re-tinted toward the person's colours (instance colour x texel / class mean),
// alpha-tested hair cards, the black mask kept.
const HUMAN_FS = /* glsl */`
  float reg = floor(vMisc.x + 0.5), bn = floor(vMisc.y + 0.5), ct = floor(vMisc.z + 0.5), ac = vMisc.w;
  vec3 q = vRest; float k = 1.0;
  vec3 albD;
  if (uJC.w > 0.5 && reg < 4.5) {
    vec4 tx = reg == 1.0 ? texture2D(tHair, vUv) : texture2D(tAtlas, vUv);
    if (reg == 1.0) {
      // hair cards: alpha sharpened by the mip level (graphics #3, P4), so coverage holds at distance instead of thinning
      vec2 du = dFdx(vUv * vec2(1024.0, 512.0)), dv = dFdy(vUv * vec2(1024.0, 512.0));
      tx.a *= 1.0 + 0.25 * max(0.0, 0.5 * log2(max(max(dot(du, du), dot(dv, dv)), 1e-8)));
      if (tx.a < 0.45) discard;
    }
    vec3 mean = reg < 0.5 ? uMean[0] : reg < 1.5 ? uMean[1] : reg < 2.5 ? uMean[2] : reg < 3.5 ? uMean[3] : uMean[4];
    float tint = reg < 0.5 ? 0.45 : reg < 1.5 ? 0.85 : reg < 2.5 ? 0.8 : reg < 3.5 ? 0.7 : 0.3;
    // (P8) a puffer (coat 2) over an avatar's top: one solid nylon colour, quilted every 10.5 cm (the procedural puffer's bands)
    float puff = float(reg == 2.0 && ct == 2.0);
    tint = mix(tint, 0.95, puff);
    albD = mix(tx.rgb, vAlb * clamp(tx.rgb / max(mean, vec3(0.004)), 0.0, 3.0), tint);
    if (puff > 0.5) { float band = abs(fract(q.y / 0.105) - 0.5) * 2.0; albD *= mix(0.62, 1.06, smoothstep(0.05, 0.6, band)); }
    if (reg == 0.0) {
      // the head map's own masks (P4, life #1 / graphics #3; seoul/people/aux.png from seoul/tools/people-aux.py): r = hair
      // painted on the scalp, re-tinted to the person's hair colour like the cards (P3 tinted it toward the skin, so dark
      // cards sat on brown or blond scalps: the black patches); g = the face mask, placed from each head's own nose, chin
      // and eye line (P3's band at neck + 3..12 cm in rest space missed: a dot under the nose on the women)
      // (P6) uRows atlas rows of 1024 px (2 for the 8-avatar bake, 4 for the 14-avatar one): the head map is each row's lower half
      float vt = 1.0 - vUv.y, rw = floor(vt * uRows), loc = (vt - (rw + 0.5) / uRows) * 2.0 * uRows;
      if (loc > 0.0 && loc < 1.0) {
        vec3 ax = texture2D(tAux, vec2(vUv.x, 1.0 - (rw + loc) / uRows)).rgb;
        vec3 hairD = mix(tx.rgb, vHairC * clamp(tx.rgb / max(uMean[5], vec3(0.004)), 0.0, 3.0), 0.85);
        albD = mix(albD, hairD, ax.r);
        float mk = mod(floor(ac / 4.0), 2.0) * ax.g, white = mod(floor(ac / 16.0), 2.0);
        albD = mix(albD, white > 0.5 ? vec3(0.62, 0.64, 0.66) * (0.92 + 0.08 * tx.g / max(mean.g, 0.004)) : vec3(0.016), mk);
      }
    }
  } else {
  float hn = fract(sin(dot(floor(q * 180.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  if (reg == 2.0) {
    if (ct == 2.0) { float band = abs(fract(q.y / 0.105) - 0.5) * 2.0; k *= mix(0.66, 1.06, smoothstep(0.05, 0.6, band)); }
    else if (ct == 1.0) k *= 0.94 + 0.08 * hn;
    else k *= 0.93 + 0.1 * smoothstep(0.3, 0.7, fract(atan(q.z, q.x + 1e-5) * 14.0));
  } else if (reg == 3.0) {
    k *= 0.9 + 0.12 * fract((q.y + q.x * 0.6) * 140.0) * (0.6 + 0.4 * hn);
  } else if (reg == 1.0 || reg == 8.0) {
    k *= reg == 1.0 ? 0.8 + 0.3 * fract(atan(q.z - 0.01, q.x + 1e-5) * 9.0 + hn * 0.3) : 0.92 + 0.08 * hn;
  } else if (reg == 0.0 && bn == 1.0 && q.y > 1.5) {
    vec3 h = q - vec3(0.0, 1.6, 0.01);
    float front = smoothstep(0.03, 0.08, h.z);
    float eyes = front * (1.0 - smoothstep(0.012, 0.02, length(vec2(abs(h.x) - 0.032, (h.y - 0.008) * 1.4))));
    float brow = front * (1.0 - smoothstep(0.006, 0.012, abs(h.y - 0.032))) * step(abs(h.x), 0.055) * step(0.012, abs(h.x));
    float sock = front * (1.0 - smoothstep(0.02, 0.04, length(vec2(abs(h.x) - 0.032, h.y - 0.012))));
    float mouth = front * (1.0 - smoothstep(0.003, 0.007, abs(h.y + 0.05))) * step(abs(h.x), 0.022);
    float chin = smoothstep(-0.06, -0.11, h.y);
    float nose = front * (1.0 - smoothstep(0.004, 0.012, abs(h.x))) * step(-0.03, h.y) * step(h.y, 0.012);
    k *= (1.0 - 0.35 * sock) * (1.0 - 0.75 * eyes) * (1.0 - 0.6 * brow) * (1.0 - 0.4 * mouth) * (1.0 - 0.3 * chin) * (1.0 + 0.12 * nose);
    float mask = mod(floor(ac / 4.0), 2.0) * smoothstep(0.02, 0.05, h.z) * (1.0 - smoothstep(-0.012, -0.002, h.y)) * smoothstep(-0.105, -0.09, h.y);
    k = mix(k, (mod(floor(ac / 16.0), 2.0) > 0.5 ? 0.62 : 0.016) / max(0.05, dot(vAlb, vec3(0.333))), mask);
  } else if (reg == 0.0 && bn == 1.0) k *= 0.72;   // neck in the shadow of the jaw
  else if (reg == 11.0) k *= 0.86 + 0.14 * smoothstep(0.3, 0.7, fract(atan(q.z - 0.01, q.x + 1e-5) * 18.0));   // (P8) beanie rib knit
  else if (reg == 10.0) k *= 0.9 + 0.1 * hn;
  albD = vAlb * k;
  }
`;
// ---- vehicles (P3, life #2 / graphics #6: cars that aren't bricks). Parts: 0 paint, 1 glass, 2 black (tyres, trim, grille),
//      3 headlight, 4 taillight, 5 interior glow (bus), 6 roof sign / destination LED, 7 indicator (amber), 8 rider (scooter),
//      9 delivery box, 10 alloy rim, 11 number plate. Cars and taxis are lofted: a side profile (bumper, hood, raked
//      windscreen, roof, rear screen, boot) swept through rounded cross-sections with tumblehome, wheel arches cut into
//      the sill, glass split from paint at the beltline; wheels are tyres with alloy faces. (No CC0/MIT car model was
//      reachable: Kenney's are toys, glTF-Sample-Assets' cars are CC-BY.)
// (P4, life #2: P3's box() wound every face against its normal and the loft was wound inward, so 98 % of a car's body and
// all its glass faced in: at 3 m a taxi showed its far panel's inside with the near wheels floating in front, and buses
// were hollow. Everything is wound counter-clockwise seen from outside now, normals out; tests/seoul-life.mjs checks it
// per primitive (g.userData.prims: triangle range, kind, centre).)
export function vehicleGeo(type) {
  const P = [], N = [], C = [], I = [], prims = [];
  const prim = (kind, c, f) => { const t0 = I.length / 3; f(); prims.push({ kind, c, start: t0, count: I.length / 3 - t0 }); };
  const box = (x0, y0, z0, x1, y1, z1, part, taper = 0) => prim('box', [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], () => {   // z forward; taper narrows the top face in x
    const b = P.length / 3, t = taper;
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0 + t, y1, z0], [x1 - t, y1, z0], [x1 - t, y1, z1], [x0 + t, y1, z1]];
    const F = [[0, 1, 2, 3, [0, -1, 0]], [7, 6, 5, 4, [0, 1, 0]], [3, 2, 6, 7, [0, 0, 1]], [1, 0, 4, 5, [0, 0, -1]], [0, 3, 7, 4, [-1, 0.2, 0]], [2, 1, 5, 6, [1, 0.2, 0]]];
    let q = 0;
    for (const f of F) { for (let k = 0; k < 4; k++) { P.push(...v[f[k]]); N.push(...f[4]); C.push(part); } const o = b + q * 4; I.push(o, o + 1, o + 2, o, o + 2, o + 3); q++; }
  });
  // a wheel: tyre (16-sided, rounded shoulders) + alloy face on the outside (part 10; spokes in the shader)
  const wheel = (x, z, r, w) => prim('wheel', [x, r, z], () => {
    const n = 16, out = Math.sign(x) || 1, xi = x - out * w / 2, xo = x + out * w / 2;
    const rings = [[xi, r * 0.78], [xi + out * w * 0.08, r * 0.97], [xo - out * w * 0.08, r * 0.97], [xo, r * 0.8]];
    const b = P.length / 3;
    for (const [xx, rr] of rings) for (let k = 0; k <= n; k++) { const a = (k / n) * Math.PI * 2, cy = Math.sin(a), cz = Math.cos(a); P.push(xx, r + cy * rr, z + cz * rr); N.push((xx - x) / (w / 2) * 0.3, cy, cz); C.push(2); }
    for (let j = 0; j < rings.length - 1; j++) for (let k = 0; k < n; k++) { const a = b + j * (n + 1) + k, c = a + n + 1; out > 0 ? I.push(a, c, a + 1, a + 1, c, c + 1) : I.push(a, a + 1, c, a + 1, c + 1, c); }
    const ci = P.length / 3; P.push(xo + out * 0.004, r, z); N.push(out, 0, 0); C.push(10);
    for (let k = 0; k <= n; k++) { const a = (k / n) * Math.PI * 2; P.push(xo + out * 0.002, r + Math.sin(a) * r * 0.8, z + Math.cos(a) * r * 0.8); N.push(out, 0, 0); C.push(10); }
    for (let k = 0; k < n; k++) out > 0 ? I.push(ci, ci + 2 + k, ci + 1 + k) : I.push(ci, ci + 1 + k, ci + 2 + k);
  });
  const c = VEH[type], L = c.L, W = c.W, H = c.H, hw = W / 2, hl = L / 2;
  if (type === 'car' || type === 'taxi') {
    const zf = hl - 0.95, zr = -hl + 0.88, wr = 0.33, ar = 0.385;            // wheel centres, tyre and arch radii
    const zw = hl - 1.28, zrw = -hl + 0.82, zroofF = hl - 2.02, zroofR = -hl + 1.42, belt = 0.95;
    // side profile: roofline / hood / boot (top) and sill with the arches (bottom)
    const topY = (z) => {
      const K = [[-hl, 0.66], [-hl + 0.12, 0.86], [-hl + 0.5, 0.97], [zrw, 1.0], [zroofR, H - 0.03], [zroofR + 0.4, H], [zroofF - 0.3, H], [zroofF, H - 0.04], [zw, 0.93], [hl - 0.55, 0.82], [hl - 0.12, 0.74], [hl, 0.6]];
      for (let i = 1; i < K.length; i++) if (z <= K[i][0]) { const u = (z - K[i - 1][0]) / (K[i][0] - K[i - 1][0]); const s = u * u * (3 - 2 * u); return K[i - 1][1] + (K[i][1] - K[i - 1][1]) * (0.35 * u + 0.65 * s); }
      return 0.6;
    };
    const botY = (z) => { let y = 0.3; for (const zc of [zf, zr]) { const d = z - zc; if (Math.abs(d) < ar) y = Math.max(y, wr + Math.sqrt(ar * ar - d * d)); } return Math.min(y, z > hl - 0.1 || z < -hl + 0.1 ? 0.42 : y); };
    const plan = (z) => { const e = Math.min(1, (hl - Math.abs(z)) / 0.55); return 0.86 + 0.14 * Math.sqrt(Math.max(0, e)); };   // corners round off in plan
    // z stations (denser at the ends and arches), duplicated at the glass edges (windscreen base, rear screen base)
    const zs = []; for (let i = 0; i <= 44; i++) { const u = i / 44; zs.push(-hl + L * (0.5 - 0.5 * Math.cos(Math.PI * u))); }
    for (const zc of [zf, zr]) for (let d = -ar; d <= ar + 1e-6; d += ar / 4) zs.push(zc + d);
    zs.push(zw, zw, zrw, zrw); zs.sort((a, b) => a - b);
    const glassZ = (z, k) => z > zrw + (k === 0 ? 1e-6 : -1e-6) && z < zw - (k === 0 ? 1e-6 : -1e-6);
    const dup = new Map(); const st = zs.map((z) => { const n = (dup.get(z) || 0); dup.set(z, n + 1); return { z, g: n }; });   // g: 0 first, 1 second copy
    // section rows: [side level u (0 sill .. 1 roof edge), across-roof fraction]; duplicated at the beltline and the roof edge
    const rows = [[0, 0, 0], [0.12, 0, 0], [0.5, 0, 0], [0.9, 0, 0], [1, 0, 0], [1, 0, 1], [1.45, 0, 1], [1.9, 0, 1], [1.9, 0, 0], [2, 0.55, 0], [2, 1, 0]];
    const secPt = (z, row, sx) => {
      const yb = botY(z), yt = topY(z), b = Math.min(belt, yt - 0.02), pl = plan(z), hwz = hw * pl;
      let y, x; const [u, f] = row;
      if (u <= 1) { y = yb + (b - yb) * u; x = hwz * (0.965 + 0.035 * Math.sin(Math.PI * u * 0.9)); }
      else if (u < 2) { const v = (u - 1) / 0.95; y = b + (yt - 0.035 - b) * Math.min(1, v); x = hwz * (1 - 0.2 * Math.min(1, v)); }
      else { y = yt + 0.012 * (1 - f * f) - 0.03 * (1 - f); x = hwz * 0.8 * (1 - f); }
      return [sx * x, y, z];
    };
    const base = P.length / 3, nr = rows.length;
    for (const sx of [1, -1]) {
      for (const { z, g } of st) for (const r of rows) {
        const [x, y] = secPt(z, r, sx); const glass = r[2] === 1 && topY(z) > belt + 0.05 && (g ? glassZ(z, 1) : glassZ(z, 0));
        P.push(x, y, z); N.push(0, 0, 0); C.push(glass ? 1 : 0);
      }
    }
    const nS = st.length, side = nS * nr;
    for (let s2 = 0; s2 < 2; s2++) for (let i = 0; i < nS - 1; i++) for (let j = 0; j < nr - 1; j++) {
      const a = base + s2 * side + i * nr + j, b2 = a + nr; s2 === 0 ? I.push(a, a + 1, b2, a + 1, b2 + 1, b2) : I.push(a, b2, a + 1, a + 1, b2, b2 + 1);
    }
    // end caps (bumper faces): fan between the two sides at the first and last station
    for (const [i, flip] of [[0, true], [nS - 1, false]]) for (let j = 0; j < nr - 1; j++) {
      const a = base + i * nr + j, b2 = base + side + i * nr + j; I.push(a, b2, a + 1, a + 1, b2, b2 + 1); void flip;
    }
    prims.push({ kind: 'loft', c: [0, 0.8, 0], start: 0, count: I.length / 3 });
    // smooth normals over the shell
    { const g0 = new THREE.BufferGeometry(); g0.setAttribute('position', new THREE.Float32BufferAttribute(P.slice(base * 3), 3)); g0.setIndex(I.map((q) => q - base)); g0.computeVertexNormals(); const nn = g0.attributes.normal.array; for (let i = 0; i < nn.length; i++) N[base * 3 + i] = nn[i]; }
    // trim: grille, lower bumpers, mirrors, lamps (point-like cores in dark housings), plates
    box(-hw * 0.62, 0.36, hl - 0.05, hw * 0.62, 0.52, hl + 0.015, 2); box(-hw * 0.7, 0.3, -hl - 0.015, hw * 0.7, 0.42, -hl + 0.05, 2);
    for (const sx of [1, -1]) {
      box(sx > 0 ? hw - 0.02 : -hw - 0.14, 0.97, zw - 0.3, sx > 0 ? hw + 0.14 : -hw + 0.02, 1.07, zw - 0.17, 0);   // door mirror
      box(Math.min(sx * (hw - 0.1), sx * (hw - 0.44)), 0.63, hl - 0.13, Math.max(sx * (hw - 0.1), sx * (hw - 0.44)), 0.74, hl - 0.02, 2);
      box(Math.min(sx * (hw - 0.18), sx * (hw - 0.32)), 0.665, hl - 0.03, Math.max(sx * (hw - 0.18), sx * (hw - 0.32)), 0.71, hl + 0.002, 3);
      box(Math.min(sx * (hw - 0.06), sx * (hw - 0.5)), 0.74, -hl + 0.02, Math.max(sx * (hw - 0.06), sx * (hw - 0.5)), 0.8, -hl + 0.1, 4);
      box(Math.min(sx * (hw - 0.03), sx * (hw - 0.05)), 0.64, hl - 0.3, Math.max(sx * (hw - 0.03), sx * (hw - 0.05)), 0.69, hl - 0.18, 7);
    }
    box(-0.26, 0.4, hl + 0.012, 0.26, 0.51, hl + 0.025, 11); box(-0.26, 0.5, -hl - 0.025, 0.26, 0.61, -hl - 0.012, 11);
    for (const z of [zf, zr]) { wheel(hw - 0.12, z, wr, 0.22); wheel(-hw + 0.12, z, wr, 0.22); }
    box(-hw * 0.82, 0.27, -hl + 0.35, hw * 0.82, 0.31, hl - 0.35, 2);   // (P4) underbody: a closed shell from a low drone
    if (type === 'taxi') { box(-0.3, H - 0.01, -0.28, 0.3, H + 0.19, -0.06, 6, 0.03); box(-0.34, H - 0.02, -0.3, 0.34, H + 0.01, -0.04, 2); }
  } else if (type === 'truck') {
    box(-hw, 0.4, hl - 1.6, hw, 1.05, hl, 0);
    box(-hw + 0.04, 1.05, hl - 1.5, hw - 0.04, H, hl - 0.15, 1, 0.08); box(-hw, 1.05, hl - 1.6, hw, H, hl - 1.45, 0); box(-hw + 0.1, H - 0.04, hl - 1.5, hw - 0.1, H + 0.02, hl - 0.2, 0);
    box(-hw, 0.55, -hl, hw, 0.75, hl - 1.65, 0); box(-hw, 0.75, -hl, -hw + 0.05, 1.15, hl - 1.65, 0); box(hw - 0.05, 0.75, -hl, hw, 1.15, hl - 1.65, 0); box(-hw, 0.75, -hl, hw, 1.15, -hl + 0.05, 0);
    box(-hw + 0.12, 0.45, hl - 0.02, hw - 0.12, 0.58, hl + 0.015, 2);
    box(-hw + 0.14, 0.6, hl - 0.02, -hw + 0.3, 0.67, hl + 0.01, 3); box(hw - 0.3, 0.6, hl - 0.02, hw - 0.14, 0.67, hl + 0.01, 3);
    box(-hw + 0.05, 0.54, -hl - 0.02, -hw + 0.3, 0.6, -hl + 0.01, 4); box(hw - 0.3, 0.54, -hl - 0.02, hw - 0.05, 0.6, -hl + 0.01, 4);
    box(-0.26, 0.4, -hl - 0.02, 0.26, 0.51, -hl - 0.005, 11);
    for (const z of [hl - 0.8, -hl + 1.0]) { wheel(-hw + 0.13, z, 0.3, 0.2); wheel(hw - 0.13, z, 0.3, 0.2); }
  } else if (type === 'bus') {
    // (P5, life #5 / graphics #3 / fpv #4: P4's bus was a stack of 48-triangle boxes) a lofted 11 m low-floor city bus:
    // rounded plan corners (0.42 m), wheel arches cut into the skirt, a tumblehome window band (part 5: the lit interior
    // and its passengers, in the shader), a crowned roof with a rounded shoulder, a one-piece windscreen (part 1) in a front
    // cap, the rear window, two kerb-side door leaves (glass to the floor), the livery skirt, LED boards front and
    // rear (part 6), lamps. Winding is set per triangle from the spine, so every face is outward by construction.
    const rc = 0.42, ar = 0.6, wz = [hl - 2.3, -hl + 2.6], belt = 1.1, top = H - 0.36;
    const planHW = (z) => { const d = Math.max(0, Math.abs(z) - (hl - rc)); return hw - rc + Math.sqrt(Math.max(0, rc * rc - d * d)); };
    const botY = (z) => { let y = 0.32; for (const zc of wz) { const d = z - zc; if (Math.abs(d) < ar) y = Math.max(y, 0.48 + Math.sqrt(ar * ar - d * d) * 0.92); } return y; };
    // rows: [y(z) or fixed, x fraction of the plan half-width, part]; duplicated at the belt and the window head (sharp edges)
    const rows = [[(z) => botY(z), 0.985, 0], [() => 0.62, 1, 0], [() => belt, 1, 0], [() => belt, 0.995, 5], [() => top, 0.97, 5], [() => top, 0.97, 0], [() => H - 0.14, 0.93, 0], [() => H - 0.03, 0.72, 0], [() => H, 0.0, 0]];
    const zs = []; for (let i = 0; i <= 30; i++) { const u = i / 30; zs.push(-hl + L * (0.5 - 0.5 * Math.cos(Math.PI * u))); }
    for (const zc of wz) for (let d = -ar; d <= ar + 1e-6; d += ar / 4) zs.push(zc + d);
    zs.sort((a, b) => a - b);
    const nr = rows.length, nS = zs.length, base = P.length / 3, t0 = I.length / 3;
    const spine = (x, y, z) => [x, y - 0.45, z - Math.max(-hl + 0.6, Math.min(hl - 0.6, z))];
    const triO = (a, b, c) => {   // wind (a, b, c) so its normal points away from the spine
      const A = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]], B = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], Cc = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [Cc[0] - A[0], Cc[1] - A[1], Cc[2] - A[2]], n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const o = spine((A[0] + B[0] + Cc[0]) / 3, (A[1] + B[1] + Cc[1]) / 3, (A[2] + B[2] + Cc[2]) / 3);
      if (n[0] * o[0] + n[1] * o[1] + n[2] * o[2] >= 0) I.push(a, b, c); else I.push(a, c, b);
    };
    for (const sx of [1, -1]) for (const z of zs) { const hwz = planHW(z); for (const [fy, fx, part] of rows) { P.push(sx * hwz * fx, fy(z), z); N.push(0, 0, 0); C.push(part); } }
    const side = nS * nr;
    for (let s2 = 0; s2 < 2; s2++) for (let i = 0; i < nS - 1; i++) for (let j = 0; j < nr - 1; j++) {
      const a = base + s2 * side + i * nr + j, b2 = a + nr; triO(a, a + 1, b2); triO(a + 1, b2 + 1, b2);
    }
    { const g0 = new THREE.BufferGeometry(); g0.setAttribute('position', new THREE.Float32BufferAttribute(P.slice(base * 3), 3)); g0.setIndex(I.slice(t0 * 3).map((q) => q - base)); g0.computeVertexNormals(); const nn = g0.attributes.normal.array; for (let i = 0; i < nn.length; i++) N[base * 3 + i] = nn[i]; }
    prims.push({ kind: 'loft', c: [0, 0.45, 0], start: t0, count: I.length / 3 - t0 });
    // end caps on their own vertices: the front is a windscreen from 0.85 m to the roof shoulder, the rear a window band
    for (const [zi, front] of [[nS - 1, true], [0, false]]) {
      const c0 = I.length / 3, cb = P.length / 3, z = zs[zi], sz = front ? 1 : -1;
      for (const sx of [1, -1]) for (let j = 0; j < nr; j++) {
        const q = base + (sx > 0 ? 0 : side) + zi * nr + j, y = P[q * 3 + 1];
        // (P7, life #4 / fpv #6) the rear cap is body colour only: P6 tagged its top rows glass (part 5) and the rows under
        // them paint, so the part id interpolated 0 -> 5 across one triangle and the rear read as a white (part 3, headlamp)
        // slab over a red (part 4, tail lamp) band. The rear window is its own panel now (part 13, below)
        const glass = front && y > 0.84 && y < H - 0.13;
        P.push(P[q * 3], y, z); N.push(0, 0, sz); C.push(glass ? 1 : 0);
      }
      for (let j = 0; j < nr - 1; j++) { const a = cb + j, b2 = cb + nr + j; triO(a, a + 1, b2); triO(a + 1, b2 + 1, b2); }
      prims.push({ kind: 'loft', c: [0, 0.45, 0], start: c0, count: I.length / 3 - c0 });
    }
    // kerb-side door leaves (glass to the floor), front and middle; the window posts are drawn by the interior shader
    for (const [z0, z1] of [[hl - 1.55, hl - 0.5], [-0.75, 0.45]]) box(-hw - 0.012, 0.36, z0, -hw + 0.03, top - 0.05, z1, 1);
    box(-hw + 0.35, H - 0.34, hl - 0.06, hw - 0.35, H - 0.12, hl + 0.005, 6);   // front destination LED (route + terminus)
    box(-0.55, top + 0.04, -hl - 0.005, 0.55, H - 0.16, -hl + 0.06, 6);        // rear route LED
    box(-hw + 0.2, 0.52, hl - 0.03, -hw + 0.42, 0.62, hl + 0.012, 3); box(hw - 0.42, 0.52, hl - 0.03, hw - 0.2, 0.62, hl + 0.012, 3);
    box(-hw + 0.08, 0.75, -hl - 0.012, -hw + 0.2, 1.05, -hl + 0.03, 4); box(hw - 0.2, 0.75, -hl - 0.012, hw - 0.08, 1.05, -hl + 0.03, 4);
    // (P7, life #4 / fpv #6) the rear: a window onto the lit cabin (part 13: the aisle seen end-on in the shader), a dark
    // engine grille, a second row of lamps over it and a high-mounted stop lamp under the roof
    box(-0.74, 1.45, -hl - 0.01, 0.74, top - 0.04, -hl + 0.02, 13);
    box(-0.7, 0.62, -hl - 0.014, 0.7, 1.02, -hl + 0.03, 2);
    for (const sx of [1, -1]) box(Math.min(sx * 0.5, sx * 0.76), 1.12, -hl - 0.012, Math.max(sx * 0.5, sx * 0.76), 1.24, -hl + 0.03, 4);
    box(-0.3, H - 0.13, -hl - 0.006, 0.3, H - 0.085, -hl + 0.03, 4);
    box(-hw * 0.75, 0.33, hl - 0.04, hw * 0.75, 0.48, hl + 0.03, 2); box(-hw * 0.8, 0.33, -hl - 0.03, hw * 0.8, 0.5, -hl + 0.04, 2);   // bumpers
    box(-hw - 0.012, 0.44, -hl + 0.5, hw + 0.012, 0.6, hl - 0.5, 12);     // livery skirt band under the colour
    box(-0.26, 0.6, hl + 0.025, 0.26, 0.71, hl + 0.04, 11);                // plate
    for (const sx of [1, -1]) box(sx > 0 ? hw - 0.02 : -hw - 0.22, 2.0, hl - 0.25, sx > 0 ? hw + 0.22 : -hw + 0.02, 2.35, hl - 0.12, 2);   // mirror arms
    box(-hw * 0.8, 0.27, -hl + 0.6, hw * 0.8, 0.31, hl - 0.6, 2);          // underbody
    for (const z of wz) { wheel(-hw + 0.16, z, 0.48, 0.3); wheel(hw - 0.16, z, 0.48, 0.3); }
  } else {   // scooter + rider + delivery box
    box(-0.16, 0.25, -0.7, 0.16, 0.62, 0.55, 0); box(-0.12, 0.62, -0.6, 0.12, 0.72, 0.05, 2);
    box(-0.08, 0.62, 0.45, 0.08, 1.05, 0.6, 0); box(-0.32, 1.02, 0.42, 0.32, 1.06, 0.48, 2);
    box(-0.07, 0.86, 0.6, 0.07, 0.96, 0.64, 3); box(-0.08, 0.6, -0.78, 0.08, 0.68, -0.74, 4);
    box(-0.25, 0.72, -0.98, 0.25, 1.18, -0.55, 9);                          // delivery box
    box(-0.18, 0.72, -0.4, 0.18, 1.3, -0.05, 8, 0.03); box(-0.15, 1.3, -0.35, 0.15, 1.45, -0.1, 8);   // rider torso, shoulders
    box(-0.11, 1.45, -0.3, 0.11, 1.68, -0.08, 2);                           // helmet
    box(-0.2, 0.55, -0.15, -0.1, 0.75, 0.35, 8); box(0.1, 0.55, -0.15, 0.2, 0.75, 0.35, 8);   // legs
    box(-0.26, 1.1, -0.1, -0.18, 1.3, 0.42, 8); box(0.18, 1.1, -0.1, 0.26, 1.3, 0.42, 8);      // arms
    wheel(0.055, 0.62, 0.22, 0.11); wheel(0.055, -0.62, 0.22, 0.12);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('part', new THREE.Float32BufferAttribute(C, 1));
  g.setIndex(I); g.computeBoundingSphere(); g.userData.prims = prims;
  return g;
}

function vehicleMaterial(nit) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.0, envMapIntensity: 0.6 });
  m.userData.uNit = nit;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNit = nit; sh.uniforms.uTimeV = m.userData.uTime || (m.userData.uTime = { value: 0 });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
attribute float part; attribute vec4 iState; attribute vec4 iEnv; varying float vPart; varying vec4 vState; varying vec3 vPaint; varying vec3 vLoc; varying vec4 vEnv; varying vec3 vWN; varying vec3 vWP;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vPart = part; vState = iState; vLoc = position; vEnv = iEnv;
#ifdef USE_INSTANCING
vWN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal); vWP = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
#else
vWN = normalize(mat3(modelMatrix) * normal); vWP = (modelMatrix * vec4(position, 1.0)).xyz;
#endif
#ifdef USE_INSTANCING_COLOR
vPaint = instanceColor;
#else
vPaint = vec3(0.8);
#endif`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uNit; uniform float uTimeV; varying float vPart; varying vec4 vState; varying vec3 vPaint; varying vec3 vLoc; varying vec4 vEnv; varying vec3 vWN; varying vec3 vWP;
float vh21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// the street a body reflects (P3): no env map at night, so a clearcoat sees a dark sky, a horizon band of shopfronts, signs
// and lamps (the person-fill grid's lux at this vehicle, broken into storefront-wide streaks that slide as the car moves),
// and the asphalt below; in nits
vec3 cityEnv(vec3 R) {
  float hz = 1.0 - smoothstep(0.0, 0.28, abs(R.y - 0.06));
  float az = atan(R.x, R.z) * 5.0 + vEnv.w * 13.0 + (vWP.x + vWP.z) * 0.35;
  float streak = 0.25 + 0.75 * smoothstep(0.35, 0.65, fract(az)) * (1.0 - smoothstep(0.75, 0.95, fract(az)));
  float spot = pow(max(0.0, sin(az * 2.7 + R.y * 9.0)), 24.0);
  vec3 band = vEnv.rgb * (0.022 * streak + 0.06 * spot);
  return mix(vec3(0.03, 0.028, 0.03), vec3(0.06, 0.05, 0.045) + band, hz) + (R.y < -0.05 ? vEnv.rgb * 0.004 : vec3(0.0));
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float pt = floor(vPart + 0.5);
// B/C pillars and the window frames read through the glass band as black trim
if (pt > 0.5 && pt < 1.5 && abs(vWN.y) < 0.75 && vLoc.y > 0.5 && vLoc.y < 2.0 && abs(vLoc.z) < 3.0 && abs(vLoc.z - 0.02) < 0.07) pt = 2.0;
vec3 alb = pt < 0.5 ? vPaint : pt < 1.5 ? vec3(0.012, 0.014, 0.016) : pt < 2.5 ? vec3(0.022) : pt < 4.5 ? vec3(0.3) : pt < 5.5 ? vec3(0.012, 0.014, 0.016) : pt < 6.5 ? vec3(0.02) : pt < 7.5 ? vec3(0.35, 0.2, 0.05) : pt < 8.5 ? vec3(0.03, 0.03, 0.035) : pt < 9.5 ? vec3(0.55, 0.12, 0.08) : pt < 10.5 ? vec3(0.42, 0.43, 0.45) : pt < 11.5 ? vec3(0.75, 0.75, 0.72) : pt < 12.5 ? vec3(0.62, 0.64, 0.66) : vec3(0.012, 0.014, 0.016);
if (pt > 9.5 && pt < 10.5) { float a = atan(vLoc.y - 0.33, vLoc.z), r = length(vec2(vLoc.y, vLoc.z)); float sp = smoothstep(0.55, 0.75, abs(sin(a * 2.5))); alb *= mix(0.25, 1.0, sp); }   // five spokes
if (pt > 10.5 && pt < 11.5) { float ch = step(0.45, fract(vLoc.x * 14.0)) * step(0.3, fract(vLoc.y * 18.0 + 0.2)); alb = mix(alb, vec3(0.03), ch * 0.8); }   // plate characters
diffuseColor.rgb = alb;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = pt < 0.5 || (pt > 11.5 && pt < 12.5) ? 0.24 : (pt < 1.5 || (pt > 4.5 && pt < 5.5) || pt > 12.5) ? 0.05 : pt > 9.5 && pt < 10.5 ? 0.3 : 0.6;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
// nits (binding table, PLAN-P2): lamps are point sources (low-beam core ~3k off-axis, tail 250, brake 1500, hazard 600);
// bodies are not emissive; the bus interior is 20-40 nits seen through dark glass, broken by window posts, seat backs
// and standing passengers; the destination LED is amber dot-matrix text (250-nit dots, ~30 % lit, so never a plate);
// the taxi roof lamp is a light box (180) with dark 'TAXI' strokes
float blink = step(0.5, fract(uTimeV * 1.5 + vState.w));
vec3 e = vec3(0.0);
if (pt > 2.5 && pt < 3.5) e = vec3(1.0, 0.97, 0.92) * 3000.0 * vState.z;
else if (pt > 3.5 && pt < 4.5) e = vec3(1.0, 0.04, 0.02) * (250.0 + 1250.0 * vState.x) * vState.z;
else if (pt > 4.5 && pt < 5.5) {
  float zc = vLoc.z / 1.18, post = smoothstep(0.0, 0.06, abs(fract(zc) - 0.5) - 0.42);
  float seat = mix(0.35, 1.0, smoothstep(1.55, 1.75, vLoc.y));
  vec3 cabin = vec3(0.95, 0.97, 1.0) * 36.0 * seat;
  // (P6, life #4) passengers lit by the cabin, not cut-out silhouettes: per window bay two seats (a head and shoulders over
  // the seat back, ~55 % taken) and sometimes a standing rider by the aisle (head at ~2.3 m, coat below); black hair over
  // the crown, a skin face (6-9 nits under the cabin light), dark coats
  float cell = floor(zc), fz = fract(zc), sd = floor(vState.w * 97.0);
  vec3 pc = cabin; float occ = 0.0;
  for (int k = 0; k < 2; k++) {
    float slot = k == 0 ? 0.3 : 0.72, r = vh21(vec2(cell * 2.0 + float(k), sd));
    if (r < 0.55) {   // seated: head centre 1.74 m, shoulders under 1.6 m
      vec2 q = vec2((fz - slot) * 1.18 / 0.105, (vLoc.y - 1.74) / 0.125); float hd = dot(q, q);
      float sh = step(abs(fz - slot) * 1.18, 0.21) * step(vLoc.y, 1.6);
      if (hd < 1.0) { float hair = step(0.05 + 0.4 * r, q.y) + step(0.7, abs(q.x)) * step(-0.2, q.y); pc = hair > 0.5 ? vec3(0.9, 0.85, 0.8) * 1.2 : vec3(1.0, 0.8, 0.66) * (6.0 + 3.0 * r); occ = 1.0; }
      else if (sh > 0.5 && occ < 0.5) { pc = vec3(0.8, 0.82, 0.9) * (2.0 + 4.0 * fract(r * 7.0)); occ = 1.0; }
    } else if (r > 0.86 && k == 1) {   // standing by the aisle
      vec2 q = vec2((fz - 0.5) * 1.18 / 0.1, (vLoc.y - 2.3) / 0.12); float hd = dot(q, q);
      if (hd < 1.0) { pc = q.y > 0.1 ? vec3(1.2) : vec3(1.0, 0.8, 0.66) * 7.0; occ = 1.0; }
      else if (abs(fz - 0.5) * 1.18 < 0.2 && vLoc.y < 2.17) { pc = vec3(0.8, 0.82, 0.9) * 3.0; occ = 1.0; }
    }
  }
  e = mix(cabin, pc, occ) * (1.0 - post) * 0.8;   // through the tinted glass (~29 nits of cabin, as P5's 32)
}
else if (pt > 5.5 && pt < 6.5) {
  vec2 dot = vec2(vLoc.x * 55.0, vLoc.y * 55.0), cel = floor(dot);
  float lit = step(0.7, vh21(vec2(floor(cel.x / 5.0), cel.y))) * step(length(fract(dot) - 0.5), 0.38);
  // taxi sign: four letters across the box face, strokes dark on the lit box
  vec2 tq = vec2((vLoc.x + 0.3) / 0.6 * 4.0, (vLoc.y - 1.49) / 0.18);
  float cx = fract(tq.x), li = floor(tq.x), stroke = 0.0;
  if (tq.y > 0.2 && tq.y < 0.85) {
    if (li < 0.5) stroke = max(step(abs(cx - 0.5), 0.09), step(0.75, tq.y));                                    // T
    else if (li < 1.5) stroke = max(step(abs(abs(cx - 0.5) - 0.45 * (tq.y - 0.2)), 0.09), step(abs(tq.y - 0.42), 0.06) * step(abs(cx - 0.5), 0.2));   // A
    else if (li < 2.5) stroke = step(abs(abs(cx - 0.5) - abs(tq.y - 0.52) * 0.9), 0.09);                     // X
    else stroke = step(abs(cx - 0.5), 0.09);                                                                     // I
  }
  e = (vState.w > -1.0 && abs(vLoc.z) > 1.0) ? vec3(1.0, 0.55, 0.12) * 250.0 * lit : vec3(1.0, 0.86, 0.6) * 180.0 * (1.0 - 0.85 * stroke * step(0.1, abs(vLoc.z + 0.17)));
}
else if (pt > 6.5 && pt < 7.5) e = vec3(1.0, 0.45, 0.03) * 600.0 * vState.y * blink;
else if (pt > 12.5) {
  // (P7, life #4 / fpv #6) the bus's rear window: the cabin seen down the aisle through tinted glass (~24 nits, as the
  // sides), two ceiling LED rows, the rear bench's backs to 1.62 m with the backs of heads over them (black hair, ~60 %
  // taken), a smaller row further in, sometimes a standing rider, the centre post
  float x = vLoc.x, y = vLoc.y, sd = floor(vState.w * 97.0);
  vec3 cabin = vec3(0.95, 0.97, 1.0) * 30.0 * mix(0.55, 1.0, smoothstep(1.6, 2.6, y));
  cabin *= 1.0 + 1.2 * step(2.6, y) * (1.0 - smoothstep(0.03, 0.07, abs(abs(x) - 0.42)));
  vec3 pc = y < 1.62 ? vec3(0.14, 0.15, 0.19) * 3.0 : cabin;
  for (int k = 0; k < 4; k++) {   // the far row first: the near bench draws over it
    float xs = -0.36 + 0.24 * float(k), r = vh21(vec2(float(k) + 7.0, sd));
    if (r < 0.5) { vec2 q = vec2((x - xs) / 0.065, (y - 1.9) / 0.075); if (dot(q, q) < 1.0) pc = vec3(0.9, 0.85, 0.8) * 0.6; else if (abs(x - xs) < 0.11 && y < 1.83 && y > 1.62) pc = vec3(0.3, 0.3, 0.34) * 2.0; }
  }
  for (int k = 0; k < 4; k++) {
    float xs = -0.54 + 0.36 * float(k), r = vh21(vec2(float(k), sd));
    if (r < 0.6) { vec2 q = vec2((x - xs) / 0.1, (y - 1.76) / 0.12); if (dot(q, q) < 1.0) pc = vec3(0.9, 0.85, 0.8) * (0.7 + 0.8 * smoothstep(0.2, 0.9, q.y)); else if (abs(x - xs) < 0.19 && y < 1.66) pc = vec3(0.2, 0.2, 0.24) * (1.5 + 2.0 * r); }
  }
  float rs = vh21(vec2(11.0, sd));
  if (rs > 0.75) { float xs = rs > 0.87 ? 0.12 : -0.12; vec2 q = vec2((x - xs) / 0.09, (y - 2.27) / 0.11);
    if (dot(q, q) < 1.0) pc = vec3(0.9, 0.85, 0.8) * 1.0; else if (abs(x - xs) < 0.17 && y < 2.16 && y > 1.62) pc = vec3(0.25, 0.25, 0.3) * 3.0; }
  pc *= 1.0 - (1.0 - smoothstep(0.02, 0.04, abs(x))) * 0.95;   // centre post
  e = pc * 0.8;
}
// clearcoat and glass: Fresnel x the street they face
if (pt < 1.5 || (pt > 4.5 && pt < 5.5) || (pt > 9.5 && pt < 10.5) || pt > 11.5) {
  vec3 Vw = normalize(cameraPosition - vWP), Nw = normalize(vWN), Rw = reflect(-Vw, Nw);
  float F = (pt < 0.5 ? 0.04 : 0.05) + 0.96 * pow(1.0 - clamp(dot(Nw, Vw), 0.0, 1.0), 5.0);
  e += cityEnv(Rw) * F * (pt < 0.5 ? 0.9 : 1.0);
}
totalEmissiveRadiance += e * uNit;`);
  };
  m.customProgramCacheKey = () => 'seoul-vehicle-6';
  return m;
}

// headlight pool on the asphalt: additive quad ahead of each vehicle. Low beams lift lamp-lit asphalt (~1 nit at 20 lux,
// albedo 0.12) by at most ~1.4x (life #6; P1 drew 18-nit white wedges). (P4, graphics #4 / life bug: P3's pool read as a
// uniform white rectangle at 3 m: its falloff leaned on smoothstep with edge0 > edge1, which GLSL leaves undefined.) Now a
// soft gaussian beam: dark under the bumper, peak 3-6 m out, widening (sigma 0.45 -> 1.2 m) and fading by 14 m, zero at
// every edge of the quad. ctx.pools = false drops them (for a light model that lights the road from the emitters itself).
function poolMaterial(nit) {
  return new THREE.ShaderMaterial({
    uniforms: { uNit: nit },
    vertexShader: `attribute vec4 iPool; varying vec2 vUv; varying float vI; void main(){ vUv = uv; vI = iPool.w; vec3 p = position; float c = cos(iPool.z), s = sin(iPool.z);
      vec3 w = vec3(c * p.x + s * p.z, 0.0, -s * p.x + c * p.z) + vec3(iPool.x, 0.03, iPool.y); gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`,
    fragmentShader: `uniform float uNit; varying vec2 vUv; varying float vI; void main(){
      float along = (1.0 - vUv.y) * 14.0, across = (vUv.x * 2.0 - 1.0) * 2.5, w = 0.45 + 0.055 * along;
      float f = exp(-0.5 * across * across / (w * w)) * clamp((along - 0.6) / 2.4, 0.0, 1.0) * exp(-max(0.0, along - 5.0) / 3.5);
      float ex = 1.0 - (vUv.x * 2.0 - 1.0) * (vUv.x * 2.0 - 1.0); f *= ex * ex;
      gl_FragColor = vec4(vec3(1.0, 0.95, 0.85) * f * vI * 0.45 * uNit, 1.0); }`,
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
  const pq = typeof location !== 'undefined' && /[?&]preset=phone/.test(location.search || '') ? 'low' : null;   // (P4) ?preset=phone too
  const seed = ctx.seed ?? 7, q = pq || ctx.quality || 'auto';
  const maxAgents = ctx.maxAgents ?? (q === 'low' ? Math.round(LIFE.maxAgents * 0.5) : LIFE.maxAgents);
  // E's set pieces and dressing discs (contract P3-G1/C: world-seoul passes ctx.setPieces = geo.setPieces and ctx.obstacles =
  // geo.dressingOut.obstacles; ctx.dressing (E's geometry output) is read too). Absent: the default rings, no discs.
  const setPieces = ctx.setPieces ?? ctx.dressing?.setPieces ?? null, obstacles = ctx.obstacles ?? ctx.dressing?.obstacles ?? null, holes = ctx.holes ?? ctx.dressing?.holes ?? null;
  const puddles = ctx.puddles ?? ctx.dressing?.puddles ?? null;   // (P8) E's standing water: nobody stands in it, walkers go round
  const sim = new LifeSim(layout, { seed, density: ctx.density ?? 1, maxAgents, setPieces, obstacles, holes, puddles });
  const crowd = sim.crowd, traffic = sim.traffic;
  const group = new THREE.Group(); group.name = 'seoul-life';
  const nit = { value: ctx.nitScale ?? LIFE.nitScale };
  const fillK = { value: 1 };
  const uTime = { value: 0 };
  const groundAt = ctx.groundAt || (() => 0);
  // warm start: the sims run at take clock + 75 s, so a take opens on queues at the lights, buses at stops and taxis
  // pulling over instead of the evenly spread t = 0 set-up (life bug; ~170 ms of traffic steps at load)
  const W = ctx.warm ?? LIFE.warm;
  const rain = ctx.rain ?? (typeof location !== 'undefined' && /[?&]rain/.test(location.search || ''));

  // ---- people
  const fill = buildFill(sim.net, layout, ctx.emitters);
  // one program for every body (procedural tiers and the Rocketbox avatars); per material: the joints (uJA/B/C), the atlases
  // and the class means (P3)
  const blank = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); blank.needsUpdate = true;
  const zero = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); zero.needsUpdate = true;   // no aux.png: no scalp re-tint, no masks
  const JDEF = [new THREE.Vector4(0.095, 0.9, 0.48, 0.09), new THREE.Vector4(0.205, 1.38, 1.1, 1.46), new THREE.Vector4(0.01, 0.005, 1, 0)];
  const makeHumanMat = (J = JDEF, atlas = blank, hair = blank, mean = null, aux = zero, scalp = null, rows = 2) => {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
    const M = (mean || [[0.2, 0.1, 0.07], [0.02, 0.015, 0.01], [0.06, 0.05, 0.05], [0.03, 0.03, 0.03], [0.02, 0.02, 0.02]]).slice(0, 5);
    M.push(scalp || M[1]);   // uMean[5]: the painted scalp hair's mean (people-aux.py), else the cards'
    const U = { uJA: { value: J[0] }, uJB: { value: J[1] }, uJC: { value: J[2] }, tAtlas: { value: atlas }, tHair: { value: hair }, tAux: { value: aux }, uRows: { value: rows },
      uMean: { value: M.map((c) => new THREE.Vector3(...c)) } };
    m.userData.humanU = U;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime; sh.uniforms.uNit = nit; sh.uniforms.uFillK = fillK; Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + HUMAN_VS)
        .replace('#include <beginnormal_vertex>', HUMAN_ANIM + '\nvec3 objectNormal = nrm;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(1.0, 0.0, 0.0);\n#endif')
        .replace('#include <begin_vertex>', 'vec3 transformed = p;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vAlb; varying vec3 vHairC; varying vec3 vFillE; varying float vScreen; varying vec3 vRest; varying vec4 vMisc; varying vec2 vUv; uniform float uNit; uniform float uFillK; uniform vec4 uJA; uniform vec4 uJB; uniform vec4 uJC; uniform sampler2D tAtlas; uniform sampler2D tHair; uniform sampler2D tAux; uniform float uRows; uniform vec3 uMean[6];')
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + HUMAN_FS + '\ndiffuseColor.rgb = albD;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += albD * vFillE * uFillK + vec3(0.75, 0.85, 1.0) * 160.0 * uNit * vScreen;');
    };
    m.customProgramCacheKey = () => 'seoul-human-4';
    return m;
  };
  const humanMat = makeHumanMat();
  const instAttrs = (g, cap) => {
    const at = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    const A = { iPos: at(4), iAnim: at(4), iTop: at(4), iBot: at(4), iHair: at(4), iSkin: at(4), iFill: at(4), iWear: at(4), iLook: at(4), instanceVelocity: at(3) };   // (+ m/s for A's object blur, P3-A1)
    for (const k in A) g.setAttribute(k, A[k]);
    g.instanceCount = 0; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return A;
  };
  const tiers = [0, 1, 2].map((lod) => {
    const g = buildHumanGeo(lod), cap = [LIFE.maxNear, LIFE.maxMid, LIFE.maxDrawn][lod], A = instAttrs(g, cap);
    const m = new THREE.Mesh(g, humanMat); m.frustumCulled = false; m.name = ['crowd-near', 'crowd-mid', 'crowd-far'][lod]; group.add(m);
    return { g, A, cap, mesh: m, tris: g.index.count / 3, n: 0, pid: new Int32Array(cap), prev: new Int32Array(cap).fill(-1), lo: 0, hi: -1 };   // (pid: the person in each slot; prev: last frame's, lo..hi: slots whose person changed)
  });
  // ---- Rocketbox avatars (life #1, art #5, graphics #6; MIT, seoul/people): 8 rigged, textured bodies baked onto the crowd's
  // rig for the near (3.4k tris) and mid (0.77k) tiers; the procedural body stays as the far tier and the fallback (node, no
  // assets, ctx.people === false). They load after the build; until then everyone is procedural.
  const avatars = { ready: false, tiers: null, mats: [], n: 0, error: null };
  const avatarGeo = (bin, L) => {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin, L.pos, L.verts * 3), 3));
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Int8Array(bin, L.nrm, L.verts * 4), 4), 3, 0, true));
    g.setAttribute('auv', new THREE.BufferAttribute(new Float32Array(bin, L.uv, L.verts * 2), 2));
    g.setAttribute('bdat', new THREE.BufferAttribute(new Uint8Array(bin, L.bone, L.verts * 4), 4, false));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array(bin, L.index, L.tris * 3), 1));
    return g;
  };
  // people.json + people.bin (+ atlases): build the avatar tiers. data = { meta, bin, atlas?, hair? } (node tests pass it)
  const avatarOf = (a) => avatars.of[a.id];   // (P7) assigned once in attachAvatars (assignAvatars)
  function attachAvatars(data) {
    const { meta, bin } = data; const nA = meta.avatars.length;
    avatars.mats = meta.avatars.map((av) => {
      const j = av.joints, J = [new THREE.Vector4(j.hipX, j.hipY, j.kneeY, j.ankleY), new THREE.Vector4(j.shX, j.shY, j.elY, j.neckY), new THREE.Vector4(j.kneeZ, j.elZ, 1.712 / j.top, 1)];
      return makeHumanMat(J, data.atlas || blank, data.hair || blank, av.mean, data.aux || zero, av.meanScalp, Math.max(1, Math.round((meta.atlas?.h || 2048) / (2 * (meta.atlas?.cell || 512)))));   // (P8) rows of 2 x cell px
    });
    // tiers: [near, (lod1,) mid]; people.json from before P4 has no lod1 (then 0 near, 1 mid)
    const nL = Math.min(3, meta.avatars[0].lods.length); avatars.nL = nL;
    avatars.tiers = Array.from({ length: nL }, (_, lod) => meta.avatars.map((av, ai) => {
      const mid = lod === nL - 1, L = av.lods[lod], g = avatarGeo(bin, L), cap = mid ? Math.ceil(LIFE.maxMid * 0.5) : Math.ceil(LIFE.maxNear * (nL === 3 && lod === 0 ? 0.3 : 0.5)), A = instAttrs(g, cap);
      const m = new THREE.Mesh(g, avatars.mats[ai]); m.frustumCulled = false; m.name = `crowd-${mid ? 'mid' : L.name || 'near'}-${av.name}`; group.add(m);
      return { g, A, cap, mesh: m, tris: L.tris, n: 0, near: !mid, pid: new Int32Array(cap), prev: new Int32Array(cap).fill(-1), lo: 0, hi: -1 };
    }));
    avatars.male = meta.avatars.map((av, i) => (av.sex === 'm' ? i : -1)).filter((i) => i >= 0);
    avatars.female = meta.avatars.map((av, i) => (av.sex === 'f' ? i : -1)).filter((i) => i >= 0);
    // (P4, life #5 / art #3: suits on 2 of 8 bodies put a quarter of Hongdae's Friday crowd in business wear) suit avatars
    // are picked a tenth as often (~3 % of people); the rest share evenly
    // (P6, life #1) Hongdae on a Friday is 85 %+ Korean: the East Asian bodies (people.json `ea`) are picked 4x as often as
    // the others (suits a tenth, whoever wears them): ~80 % of the crowd's near and mid people
    avatars.w = avatarWeights(meta); avatars.of = assignAvatars(people, meta, avatars.w);
    // (P7) re-dyed tops into the packed attributes (and every slot rewritten once)
    avatars.of.tops.forEach((c, i) => { if (c) { const l = lin(c); STAT[i * 20] = l[0]; STAT[i * 20 + 1] = l[1]; STAT[i * 20 + 2] = l[2]; if (people[i].look.style !== 5 && people[i].look.style !== 7) { STAT[i * 20 + 16] = l[0]; STAT[i * 20 + 17] = l[1]; STAT[i * 20 + 18] = l[2]; } } });
    for (const t of tiers) t.prev.fill(-1);
    avatars.n = nA; avatars.ready = true; avatars.patched = false;
    for (const L of avatars.tiers) for (const t of L) if (t.near) motionMeshes.push(t.mesh);   // (the same array scene.userData.motionMeshes spreads: re-list; near tiers only, P4 perf #2)
    if (ctx.scene?.userData) ctx.scene.userData.motionMeshes = [...(ctx.scene.userData.motionMeshes || []).filter((m) => !motionMeshes.includes(m)), ...motionMeshes];
    stats.avatars = nA; stats.trisNear = avatars.tiers[0][0].tris; stats.trisMid = avatars.tiers[nL - 1][0].tris; stats.trisLod1 = nL === 3 ? avatars.tiers[1][0].tris : null;
  }
  // ---- contact shadows (lighting #6, P3): a soft dark footprint under every near and mid person (multiplied into what is
  // already on the ground; walkers' a little longer along their heading), so crowds stand on the street instead of floating
  const capC = LIFE.maxNear + LIFE.maxMid;
  const contactG = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const contactA = new THREE.InstancedBufferAttribute(new Float32Array(capC * 4), 4); contactA.setUsage(THREE.DynamicDrawUsage);
  const contactY = new THREE.InstancedBufferAttribute(new Float32Array(capC), 1); contactY.setUsage(THREE.DynamicDrawUsage);
  contactG.setAttribute('iC', contactA); contactG.setAttribute('iCy', contactY); contactG.instanceCount = 0;
  const contactMat = new THREE.ShaderMaterial({
    vertexShader: `attribute vec4 iC; attribute float iCy; varying vec2 vQ; varying float vK; void main(){ vQ = position.xz * 2.0; vK = fract(iC.w); float ext = 1.0 + floor(iC.w) * 0.35;
      vec3 p = vec3(position.x * 0.78, 0.0, position.z * 0.78 * ext); float c = cos(iC.z), s = sin(iC.z);
      vec3 w = vec3(c * p.x + s * p.z, 0.0, -s * p.x + c * p.z) + vec3(iC.x, iCy + 0.025, iC.y); gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`,
    fragmentShader: `varying vec2 vQ; varying float vK; void main(){ float r = length(vQ); float o = vK * (1.0 - smoothstep(0.15, 1.0, r)) * (0.55 + 0.45 * (1.0 - smoothstep(0.0, 0.45, r))); gl_FragColor = vec4(vec3(1.0 - o), 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const contacts = new THREE.Mesh(contactG, contactMat); contacts.frustumCulled = false; contacts.name = 'crowd-contact'; contacts.renderOrder = 1; contacts.visible = ctx.contacts !== false; group.add(contacts);
  // static per-person appearance, linearised once
  const people = crowd.people, NP = people.length;
  const look = people.map((a) => ({ top: lin(a.look.top), bot: lin(a.look.bottom), hair: lin(a.look.hair), skin: lin(a.look.skin), wear: lin(a.look.wear) }));
  // (P4) 16: a white KF94 instead of a black one, on 35 % of the masks (a hash, so the look RNG stream is unchanged)
  const accOf = people.map((a) => (a.look.acc & 7) | (a.look.pocket ? 8 : 0) | (a.look.acc & 4 && h32(a.id, 0x3a5c) % 100 < 35 ? 16 : 0));
  const seedOf = people.map((a) => ((a.id * 2654435761) >>> 0) / 4294967296);
  // (P7, perf #3 / life #6) the per-person attributes that never change, packed once: top rgb + coat, bottom + bag, hair +
  // width, skin + umbrella, wear + style (20 floats). A slot is rewritten (and uploaded) only when its person changes: P6
  // wrote and uploaded all five from JS arrays for every drawn person every frame (~35 % of the render-side loop)
  const umbOf = people.map((a, i) => (rain && a.kind !== K_SEAT && a.kind !== K_PERF && ((i * 2654435761) >>> 0) % 100 < 62 ? 1 : 0));   // ~60% under umbrellas in rain
  const STAT = new Float32Array(NP * 20);
  people.forEach((a, i) => { const L = look[i], s = i * 20; STAT.set(L.top, s); STAT[s + 3] = a.look.coat; STAT.set(L.bot, s + 4); STAT[s + 7] = a.look.bag;
    STAT.set(L.hair, s + 8); STAT[s + 11] = a.wide; STAT.set(L.skin, s + 12); STAT[s + 15] = umbOf[i]; STAT.set(L.wear, s + 16); STAT[s + 19] = a.look.style; });
  // look-at state (render side only): head yaw/pitch toward the drone, attention time (phones come up after ~1.2 s)
  const LY = new Float32Array(NP), LP = new Float32Array(NP), ATT = new Float32Array(NP);
  // (P4, life #4) reaction to a low drone, render side only (the soft colliders stay where the sim puts people): RX 0-1 how
  // startled, LAG m a walker has fallen behind its sim position (slowed to 0.4x, then catches up), SX sidestep (m, signed
  // across the heading), FL s of flinch left
  const RX = new Float32Array(NP), LAG = new Float32Array(NP), SX = new Float32Array(NP), FL = new Float32Array(NP);
  // (P5, life #4 / fpv #3: ghost walkers) where each person was drawn last frame (DST: that frame's number). A person drawn
  // on consecutive frames follows the frame's position from where they were, carried by their own velocity, closing the
  // gap at 6/s; the blur velocity is what they were actually drawn doing. P4 drew the crowd's avoidance as it came out
  // (12 relaxation passes, re-sorted every frame: 6 % of near people jumped 0.06-0.25 m in a frame) and smeared them by
  // the walk speed alone: in a hover, standing and side-stepping people streaked
  const DXp = new Float32Array(NP), DZp = new Float32Array(NP), DST = new Int32Array(NP).fill(-9); let frameNo = 0;
  const filmer = people.map((a) => a.kind !== K_WALK && a.kind !== K_SEAT && a.kind !== K_PERF && seedOf[a.id] < 0.3);

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
    const env = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); env.setUsage(THREE.DynamicDrawUsage); im.geometry.setAttribute('iEnv', env);   // the street's light at this vehicle (lux) + seed
    // contract P2-A1 (A's object blur): world m/s per instance, in setMatrixAt order
    const vel = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); vel.setUsage(THREE.DynamicDrawUsage); im.geometry.setAttribute('instanceVelocity', vel);
    im.count = 0; im.frustumCulled = false; im.name = 'traffic-' + ty; group.add(im);
    vByType[ty] = { im, st, vel, env, cap, n: list.length };
  }
  // contract P2-A1: list the vehicle meshes for A's object blur (world.motionMeshes / scene.userData.motionMeshes)
  const motionMeshes = [...Object.values(vByType).map((B) => B.im), tiers[0].mesh];   // (P4 perf #2: the mid and far crowd move < 1 px per frame at 18+ m; no velocity proxies)
  group.userData.motionMeshes = motionMeshes;
  if (ctx.scene?.userData) ctx.scene.userData.motionMeshes = [...(ctx.scene.userData.motionMeshes || []), ...motionMeshes];
  const poolG = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  // plane in xz: x across (width 5 m, the beam fades to 0 at its edges), z ahead (length 14 m), starting at the bumper
  { const p = poolG.attributes.position; for (let i = 0; i < p.count; i++) { p.setX(i, p.getX(i) * 5.0); p.setZ(i, (p.getZ(i) + 0.5) * 14); } }
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

  const tmpF = [0, 0, 0, 0], M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), S1 = new THREE.Vector3(1, 1, 1), V3 = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), FWD = new THREE.Vector3(0, 0, 1), QK = new THREE.Quaternion(), PO = {};
  const fwd = new THREE.Vector3(0, 0, -1);
  const hist = new Int32Array(18), ab = new Uint8Array(NP);
  const stats = { agents: NP, walkers: crowd.units.reduce((n, u) => n + u.gsize, 0), vehicles: traffic.vehicles.length, near: 0, mid: 0, drawn: 0, cpuMs: 0, simMs: 0, crowdMs: 0, trisNear: tiers[0].tris, trisMid: tiers[1].tris, trisFar: tiers[2].tris, lanes: traffic.lanes.length, ways: crowd.ways.length, crossings: sim.net.crossings.length };
  let clock = 0, extClock = false, lastClock = null;
  const camP = new THREE.Vector3(0, 2, 0), camE = { x: 0, z: 0, fx: null, fz: null };
  // what the sound needs from the crowd each frame (sound #3): density around the camera, footsteps within 5 m,
  // door in/out events, busking sites
  const near = { crowdN: 0, feet: [], doors: [], busk: crowd.busk };

  if (ctx.peopleData) { try { attachAvatars(ctx.peopleData); } catch (e) { avatars.error = String(e?.message || e); } }
  else if (ctx.people !== false && typeof fetch === 'function' && typeof document !== 'undefined') {
    const base = ctx.peopleBase || new URL('./seoul/people/', import.meta.url).href;
    Promise.all([fetch(base + 'people.json').then((r) => r.json()), fetch(base + 'people.bin').then((r) => r.arrayBuffer()),
      new THREE.TextureLoader().loadAsync(base + 'atlas.jpg'), new THREE.TextureLoader().loadAsync(base + 'hair.png'),
      new THREE.TextureLoader().loadAsync(base + 'aux.png').catch(() => null)])
      .then(([meta, bin, atlas, hair, aux]) => {
        for (const t of [atlas, hair]) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.needsUpdate = true; }
        if (aux) { aux.colorSpace = THREE.NoColorSpace; aux.needsUpdate = true; }   // masks, not colour
        attachAvatars({ meta, bin, atlas, hair, aux });
      }).catch((e) => { avatars.error = String(e?.message || e); console.warn('seoul-life: avatars', e); });
  }
  // ---- [P4 H, perf #1 / native #3] the crowd's per-frame evaluate off the main thread (seoul-life-worker.js): the worker
  // runs this same LifeSim (same layout and options) and returns X, Z, YAW, PH, WALK, POSE, VIS + the door events for a
  // requested (t, camera); update() asks for the next frame's clock and draws the newest finished frame (a pure function
  // of its t: one frame of camera lag in the far-unit throttling only), so the main thread skips crowd.evaluate. The
  // traffic, the colliders and take parity stay on this thread's sim. ctx.lifeWorker: false = inline; true / absent in a
  // browser = start one (?lifeworker=0 turns it off); a LifeWorker instance = use it (node tests). Until it is ready,
  // after a seek (|t - frame t| > 0.25 s), or if it fails, the inline evaluate runs as before.
  const lwq = typeof location !== 'undefined' ? new URLSearchParams(location.search || '').get('lifeworker') : null;
  const LW = { w: null, f: null, dt: 1 / 60, last: null, used: 0, inline: 0, state: 'off', hash0: sim.hash(), disposed: false, firstUsed: null };   // (the sim as built: t = 0)
  // [P8 G1, perf #3] LW.ready resolves (to the state) once the worker is on with its first frame in hand, or failed / off:
  // world-seoul waits for it (bounded) before its first update, so the level opens on the worker's crowd
  let lwDone; LW.ready = new Promise((r) => { lwDone = r; });
  const lwPlain = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const lwAttach = (w) => {
    if (!w) { LW.state = 'unavailable'; return; }
    if (w.info && (w.info.agents !== crowd.X.length || w.info.vehicles !== traffic.vehicles.length || w.info.hash !== LW.hash0)) { LW.state = 'mismatch'; w.dispose(); return; }
    if (LW.disposed) { w.dispose(); LW.state = 'disposed'; return; }
    LW.w = w; LW.state = 'on';
  };
  const lwEnd = () => lwDone(LW.state);
  if (ctx.lifeWorker && typeof ctx.lifeWorker === 'object') { lwAttach(ctx.lifeWorker); lwEnd(); }
  else if (ctx.lifeWorker !== false && lwq !== '0' && (ctx.lifeWorker === true || typeof window !== 'undefined') && LifeWorker.supported()) {
    LW.state = 'starting';
    // [P5 H, perf #2] warmTo: the worker reaches the warm clock before 'ready' (it used to pay that 75 s of traffic on its
    // first frame: 2.65-22 s with no frame back); until then, and after a seek until a post-seek frame lands, inline
    // [P8] cam / fr: the first frame (at warmTo, from the spawn, in the first update's stagger phase) comes with 'ready'
    const sp = layout.spawn?.pos, cam0 = Array.isArray(sp) ? [sp[0], sp[1], sp[2], Math.sin(layout.spawn.yaw || 0) * -1, -Math.cos(layout.spawn.yaw || 0)] : null;
    LifeWorker.create(layout, { seed, density: ctx.density ?? 1, maxAgents, setPieces: lwPlain(setPieces), obstacles: lwPlain(obstacles), holes: lwPlain(holes), puddles: lwPlain(puddles), warmTo: W, cam: cam0, fr: 1 })
      .then(lwAttach, (e) => { LW.state = 'failed'; console.warn('[life worker]', e); }).finally(lwEnd);
  } else lwEnd();
  function lwFrame(tNow, cam) {   // -> the worker frame to draw at tNow, or null (inline)
    const w = LW.w; if (!w) return null;
    if (w.error) { LW.state = 'failed: ' + w.error; LW.w = null; return null; }
    // [P8] frames up to 0.5 s apart count (a slow or loaded device: P7 kept 1/60 s, asked for a clock it had already passed,
    // and drew inline every frame)
    if (LW.last != null) { const d = tNow - LW.last; if (d > 0 && d < 0.5) LW.dt += (d - LW.dt) * (LW.dt < 0.05 && d > 0.1 ? 0.6 : 0.2); }
    LW.last = tNow;
    // [P5 H] fr: the crowd's frame counter the next update would evaluate with (its far / behind-camera stagger keys on
    // it): the worker evaluates in the inline sim's phase (P4 didn't: a 7.9 % tier-total gap on the frames the stagger flips)
    const c = crowd.frame || 0;
    w.request(tNow + LW.dt, [cam.x, camP.y, cam.z, cam.fx, cam.fz], c + 2);
    const f = w.latest(); if (f) { if (LW.f) w.release(LW.f); LW.f = f; }
    const use = LW.f && Math.abs(LW.f.t - tNow) <= 0.25 ? LW.f : null;
    if (use) { LW.used++; crowd.frame = c + 1; if (LW.firstUsed == null) LW.firstUsed = LW.used + LW.inline; } else LW.inline++;   // (inline: evaluate advances it; firstUsed: the update that first drew the worker's crowd)
    return use;
  }
  function update(t, camPos, camQuat) {
    const c0 = performance.now();
    if (typeof t === 'number') { clock = t; extClock = true; }
    if (camPos) camP.copy(camPos);
    sim.advanceTo(clock + W);
    // (P5, life #6) pre-roll the later city a few steps a frame (~1 ms; done ~25 s after load), so retries can open on it
    if (ctx.preroll !== false && !(sim.prerolled >= LIFE.warmMax + 15)) sim.preroll(ctx.prerollSteps ?? 8);
    const c1 = performance.now();
    uTime.value = clock + W;
    const dt = lastClock == null ? 0 : Math.max(0, Math.min(0.1, clock - lastClock)); lastClock = clock;   // (W: see warm below)
    if (camQuat) fwd.set(0, 0, -1).applyQuaternion(camQuat); else fwd.set(0, 0, 0);
    // ---- people: closed-form at the clock (avoidance near the camera), tier by distance, cull behind the camera
    crowd.events.length = 0;
    camE.x = camP.x; camE.z = camP.z; const fl = Math.hypot(fwd.x, fwd.z); camE.fx = fl > 1e-3 ? fwd.x / fl : null; camE.fz = fl > 1e-3 ? fwd.z / fl : null;
    const CF = lwFrame(clock + W, camE);   // [P4 H] the worker's frame, else the inline evaluate
    if (CF) { for (const e of CF.events) crowd.events.push(e); } else crowd.evaluate(clock + W, camE);
    const CA = CF || crowd;   // the frame's arrays: X, Z, YAW, PH, WALK, POSE, VIS
    const dtF = CF ? Math.max(-0.25, Math.min(0.25, clock + W - CF.t)) : 0; frameNo++;
    stats.lifeWorker = LW.state; stats.lifeWorkerUsed = LW.used; stats.lifeWorkerInline = LW.inline;
    const c2 = performance.now();
    const X = CA.X, Z = CA.Z, VIS = CA.VIS, nr2 = LIFE.nearR * LIFE.nearR, gy = groundAt(camP.x, camP.z), camH = camP.y - gy;
    const VZ = ctx.scene?.userData?.seoulLight?.visibility;   // D's frustum + heightfield occlusion (P3), else ctx.visible
    const cosFov = Math.cos(Math.min(1.55, ctx.fovHalf ?? 1.15)), visTest = VZ && typeof VZ.visible === 'function' ? (x, y, z, r) => VZ.visible(x, y, z, r) : typeof ctx.visible === 'function' ? ctx.visible : null;
    let nN = 0, nM = 0, nF = 0, nC = 0, n0 = 0; for (const t of tiers) { t.n = 0; t.lo = 1e9; t.hi = -1; } if (avatars.ready) for (const L of avatars.tiers) for (const t of L) { t.n = 0; t.lo = 1e9; t.hi = -1; }
    if (avatars.ready && !avatars.patched) { const SL = ctx.scene?.userData?.seoulLight; if (SL?.patchMaterial) { for (const m of avatars.mats) SL.patchMaterial(m); avatars.patched = true; } }
    const T0 = tiers[0].A, T1 = tiers[1].A, T2 = tiers[2].A, mr2 = LIFE.midR * LIFE.midR;
    hist.fill(0); near.crowdN = 0; near.feet.length = 0;
    for (let i = 0; i < NP; i++) {
      if (!VIS[i]) { ab[i] = 99; continue; }
      const dx = X[i] - camP.x, dz = Z[i] - camP.z, h2 = dx * dx + dz * dz, d2 = h2 + camH * camH * 0.25;
      if (h2 < 900) { const d = Math.sqrt(h2); near.crowdN += 1 / (1 + d / 6); if (d < 5 && CA.WALK[i] > 0.5 && near.feet.length < 16) near.feet.push(i); }
      // (perf #2, P3) view cone: off the camera's half-angle plus the person's own angular size (ctx.fovHalf, default 66 deg;
      // D's ctx.visible(x, y, z, r) occlusion test when given). P2 only dropped people behind the camera.
      let b = Math.floor(Math.sqrt(d2) / 10);
      if (d2 > 25 && fwd.lengthSq() > 0) {
        const ry = gy + 1.0 - camP.y, l3 = Math.sqrt(h2 + ry * ry), c = (dx * fwd.x + ry * fwd.y + dz * fwd.z) / l3;
        if (c < cosFov - 1.3 / l3 || (visTest && !visTest(X[i], gy + 1.0, Z[i], 1.1))) b = 99;
      }
      if (b > 17) b = 99; else hist[b]++;
      ab[i] = b;
    }
    near.doors = crowd.events;
    // the phone preset (seoul-light's qualityCap, crowd 'low') draws fewer, live
    const capP = ctx.scene?.userData?.seoulLight?.qualityCap, low = q === 'low' || (capP && capP.presets?.[capP.current]?.crowd === 'low'), maxD = low ? LIFE.maxDrawnLow : LIFE.maxDrawn;
    // (P5) the band where the budget runs out is thinned by a per-person hash, not dropped whole: P4 cut at whole 10 m bands,
    // so ~115 far people popped in and out together as the total crossed maxDrawn (and the worker's frame, a frame apart,
    // drew 7.9 % more or fewer than inline)
    let cut = 17, acc = 0, part = 1; for (let b = 0; b <= 17; b++) { if (acc + hist[b] > maxD) { cut = b; part = (maxD - acc) / hist[b]; break; } acc += hist[b]; }
    const kL = 1 - Math.exp(-dt * 4);
    for (let i = 0; i < NP; i++) {
      if (ab[i] > cut || (ab[i] === cut && part < 1 && h32(i, 0x5eed) / 4294967296 >= part)) { ATT[i] = 0; continue; }
      const a = people[i];
      // ---- reaction (life #4): within 2.5 m of a drone flying under 2.5 m: walkers slow to 0.4x and sidestep 0.5 m away
      // from it, everyone near flinches for 0.4 s on the first moment; eased in 0.15 s, out over ~1 s
      { const rx = X[i] - camP.x, rz = Z[i] - camP.z, near = camH < 2.5 && camH > -0.5 && rx * rx + rz * rz < 6.25 && a.kind !== K_PERF && a.kind !== K_SEAT;
        const r0 = RX[i], tgt = near ? 1 : 0; RX[i] += (tgt - r0) * (1 - Math.exp(-dt * (near ? 7 : 1.2)));
        // (P5) the duck is 1 person in 3 (P4: everyone near at once read as a hold-up)
        if (near && r0 < 0.05 && dt > 0 && h32(i, 0xf11c) % 3 === 0) FL[i] = 0.4; else if (FL[i] > 0) FL[i] = Math.max(0, FL[i] - dt);
        if (a.kind === K_WALK) {
          // (P5) the frame's own arrays (CA): P4 read the inline crowd's, stale whenever the worker's frame was drawn, so the
          // lag and the sidestep pushed people along an old heading
          const sp = CA.WALK[i] * crowd.units[a.unit].v; LAG[i] = Math.max(0, Math.min(3, LAG[i] + (sp * 0.6 * RX[i] - (RX[i] < 0.2 ? LAG[i] * 0.3 : 0)) * dt));   // (P5: catch up at 0.3/s, a brisk walk, not 0.6/s, a sprint)
          const hy = CA.YAW[i], hx = Math.sin(hy), hz = Math.cos(hy), side = (rx * hz - rz * hx) >= 0 ? 1 : -1;   // the side away from the drone
          if (near && Math.abs(SX[i]) < 0.01) SX[i] = side * 1e-3; SX[i] += ((near ? Math.sign(SX[i] || side) * 0.5 : 0) - SX[i]) * (1 - Math.exp(-dt * (near ? 6 : 1.5)));
        } else { LAG[i] *= Math.exp(-dt); SX[i] *= Math.exp(-dt * 1.5); } }
      // (P5, life #4 / fpv #3: ghost walkers) a worker frame is evaluated at its own time (up to 0.25 s off the clock):
      // carry each person along their velocity to the clock, so switching between worker and inline frames, or a late
      // worker frame, never jumps anyone (P4 drew the frame's positions as they were; with the object blur a jump smears)
      const walker0 = a.kind === K_WALK, sp0 = CA.WALK[i] * (walker0 ? crowd.units[a.unit].v : 1.25) * (1 - 0.6 * RX[i]), hy0 = CA.YAW[i], ex = dtF * sp0;
      let x = X[i] + Math.sin(hy0) * (ex - LAG[i]) + Math.cos(hy0) * SX[i], z = Z[i] + Math.cos(hy0) * (ex - LAG[i]) - Math.sin(hy0) * SX[i];
      let vx = Math.sin(hy0) * sp0, vz = Math.cos(hy0) * sp0;
      if (DST[i] === frameNo - 1 && dt > 0 && dt < 0.1) {
        const px = DXp[i] + vx * dt, pz = DZp[i] + vz * dt, gx = x - px, gz = z - pz;
        const g2 = gx * gx + gz * gz;
        if (g2 < 9) { let f = 1 - Math.exp(-dt * 6); const cm = 0.9 * dt; if (f * f * g2 > cm * cm) f = cm / Math.sqrt(g2); x = px + gx * f; z = pz + gz * f; vx = (x - DXp[i]) / dt; vz = (z - DZp[i]) / dt; }   // (closing <= 0.9 m/s)
      }
      DXp[i] = x; DZp[i] = z; DST[i] = frameNo;
      const dx = x - camP.x, dz = z - camP.z, h2 = dx * dx + dz * dz, d2 = h2 + camH * camH * 0.25;
      let T, k;
      let lod = d2 < nr2 && nN < tiers[0].cap ? 0 : d2 < mr2 && nM < tiers[1].cap ? 1 : nN + nM + nF < maxD ? 2 : -1;
      if (lod < 0) continue;
      if (lod === 0) nN++; else if (lod === 1) nM++; else nF++;
      let AT = null;
      if (lod < 2 && avatars.ready) {   // the person's own avatar (by sex, then a hash), unless that avatar's buffer is full
        const av = avatarOf(a), al = lod === 0 ? (avatars.nL === 3 && (d2 >= LIFE.nearR0 * LIFE.nearR0 || n0 >= LIFE.maxLod0) ? 1 : 0) : avatars.nL - 1; AT = av >= 0 ? avatars.tiers[al][av] : null;
        if (AT && al === 0) n0++;
        if (AT && AT.n >= AT.cap) AT = null;
      }
      if (!AT) AT = tiers[lod];
      T = AT.A; k = AT.n++; AT.pid[k] = i;
      const gyx = groundAt(x, z);
      if (lod < 2 && nC < capC) {   // contact footprint: full strength standing, a touch lighter and longer walking; fades out by 50 m
        const w = CA.WALK[i] > 0.5 ? 1 : 0, fade = 1 - Math.min(1, Math.max(0, (Math.sqrt(h2) - 38) / 12));
        contactA.setXYZW(nC, x, z, CA.YAW[i], w + Math.min(0.999, (a.kind === K_SEAT ? 0.45 : 0.62) * fade * (w ? 0.85 : 1))); contactY.setX(nC, gyx); nC++;
      }
      // look at the drone (life #4): standing people within 14 m turn their heads, filmers raise phones after ~1.2 s;
      // walkers within 8 m glance
      let pose = CA.POSE[i], ty = 0, tp = 0;
      const yaw = CA.YAW[i], walker = a.kind === K_WALK;
      const R = walker ? 8 : 14;
      if (h2 < R * R && camH < 20 && camH > -1 && a.kind !== K_PERF) {
        const rel = wrapA(Math.atan2(-dx, -dz) - yaw), hd = Math.sqrt(h2);
        if (Math.abs(rel) < (walker ? 1.3 : 2.2)) { ty = Math.max(-1.1, Math.min(1.1, rel)); tp = -Math.max(-0.25, Math.min(0.9, Math.atan2(camP.y - gyx - 1.55 * a.scale, hd))); }
        ATT[i] += dt;
        if (filmer[i] && ATT[i] > 1.2 && CA.WALK[i] < 0.3) { pose = P_FILM; tp -= 0.05; }
      } else ATT[i] = Math.max(0, ATT[i] - dt * 2);
      LY[i] += (ty - LY[i]) * kL; LP[i] += (tp - LP[i]) * kL;
      if (FL[i] > 0 && a.kind !== K_PERF) pose = P_FLINCH;
      const o = k * 4;
      const pA = T.iPos.array; pA[o] = x; pA[o + 1] = gyx + (a.y0 || 0); pA[o + 2] = z; pA[o + 3] = yaw;
      const nA = T.iAnim.array; nA[o] = CA.PH[i]; nA[o + 1] = CA.WALK[i] * (1 - 0.6 * RX[i]); nA[o + 2] = pose; nA[o + 3] = a.scale;
      if (AT.prev[k] !== i) {   // (P7) static attributes: only when the slot's person changed
        AT.prev[k] = i; if (k < AT.lo) AT.lo = k; if (k > AT.hi) AT.hi = k;
        const s = i * 20, tA = T.iTop.array, bA = T.iBot.array, hA = T.iHair.array, sA = T.iSkin.array, wA = T.iWear.array;
        tA[o] = STAT[s]; tA[o + 1] = STAT[s + 1]; tA[o + 2] = STAT[s + 2]; tA[o + 3] = STAT[s + 3];
        bA[o] = STAT[s + 4]; bA[o + 1] = STAT[s + 5]; bA[o + 2] = STAT[s + 6]; bA[o + 3] = STAT[s + 7];
        hA[o] = STAT[s + 8]; hA[o + 1] = STAT[s + 9]; hA[o + 2] = STAT[s + 10]; hA[o + 3] = STAT[s + 11];
        sA[o] = STAT[s + 12]; sA[o + 1] = STAT[s + 13]; sA[o + 2] = STAT[s + 14]; sA[o + 3] = STAT[s + 15];
        wA[o] = STAT[s + 16]; wA[o + 1] = STAT[s + 17]; wA[o + 2] = STAT[s + 18]; wA[o + 3] = STAT[s + 19];
      }
      const lA = T.iLook.array; lA[o] = LY[i]; lA[o + 1] = LP[i]; lA[o + 2] = accOf[i]; lA[o + 3] = seedOf[i];
      { const vl = Math.hypot(vx, vz), c = vl > 2.5 ? 2.5 / vl : 1, ov = k * 3; T.instanceVelocity.array[ov] = vx * c; T.instanceVelocity.array[ov + 1] = 0; T.instanceVelocity.array[ov + 2] = vz * c; }   // (P5: as drawn, <= 2.5 m/s)
      fill.at(x, z, tmpF); T.iFill.array[o] = tmpF[0]; T.iFill.array[o + 1] = tmpF[1]; T.iFill.array[o + 2] = tmpF[2]; T.iFill.array[o + 3] = tmpF[3];
    }
    let avTris = 0;
    for (const T of [...tiers, ...(avatars.ready ? avatars.tiers.flat() : [])]) {
      const n = T.n; T.g.instanceCount = n; T.mesh.visible = n > 0; avTris += n * T.tris;
      if (!n) continue;
      for (const k in T.A) {
        const at = T.A[k], st = STATIC_ATTR.has(k); if (st && T.hi < T.lo) continue;   // (P7) static: only the slots whose person changed
        at.clearUpdateRanges?.(); if (st) at.addUpdateRange?.(T.lo * 4, (T.hi - T.lo + 1) * 4); else at.addUpdateRange?.(0, n * at.itemSize); at.needsUpdate = true;
      }
    }
    contactG.instanceCount = nC; contactA.clearUpdateRanges?.(); contactA.addUpdateRange?.(0, nC * 4); contactA.needsUpdate = true; contactY.clearUpdateRanges?.(); contactY.addUpdateRange?.(0, nC); contactY.needsUpdate = true;
    stats.contacts = nC;
    stats.crowdMs = c2 - c1;
    // ---- vehicles
    const aT = sim.aT, cnt = {}; for (const ty of VTYPES) cnt[ty] = 0;
    const vCullOn = ctx.vehicleCull !== false && fwd.lengthSq() > 0, cosV = Math.cos(Math.min(Math.PI, Math.min(1.55, ctx.fovHalf ?? 1.15) + VCULL.pad)); stats.vCulled = 0;
    let np = 0;
    for (const v of traffic.vehicles) {
      const p = traffic.pose(v, aT, PO), [ef, er] = vEm[v.id];
      if (p.hidden) { ef.nits = 0; er.nits = 0; continue; }
      if (v.type === 'bus') { const tk = v.dwell != null && v.dwellT > 0 ? 1 : 0; v._kn = (v._kn || 0) + (tk - (v._kn || 0)) * Math.min(1, dt * 2.5); }   // (eased even while culled)
      let y = groundAt(p.x, p.z); const yaw = Math.atan2(p.hx, p.hz), hl = v.L / 2;
      // the lamps stay lit (D's light bins every emitter, culled or not)
      ef.pos[0] = p.x + p.hx * hl; ef.pos[1] = y + (v.type === 'bus' ? 0.6 : 0.68); ef.pos[2] = p.z + p.hz * hl; ef.normal[0] = p.hx; ef.normal[2] = p.hz; ef.nits = 40000;
      er.pos[0] = p.x - p.hx * hl; er.pos[1] = y + 0.75; er.pos[2] = p.z - p.hz * hl; er.normal[0] = -p.hx; er.normal[2] = -p.hz; er.nits = 250 + 1250 * v.brake;
      // (P7, perf #1 with D: every vehicle was drawn every pass, ~0.44 M triangles, cars 300 m behind the camera included)
      // render-only cull: within VCULL.far m and inside the view cone widened by VCULL.pad (plus the vehicle's own angular
      // size), or within VCULL.near m; the headlight pool by its own 14 m reach. The sim, colliders and lamps are untouched.
      // The kept vehicles pack the instance slots in order (H's depth proxies, A's velocity pass and D's mirror occluders
      // share instanceMatrix and count)
      const vdx = p.x - camP.x, vdz = p.z - camP.z, vry = y + 1 - camP.y, vd = Math.sqrt(vdx * vdx + vdz * vdz + vry * vry);
      const vc = vCullOn ? (vdx * fwd.x + vry * fwd.y + vdz * fwd.z) / Math.max(vd, 1e-3) : 1;
      const drawV = !vCullOn || vd < VCULL.near || (vd < VCULL.far && vc > cosV - (hl + 1.5) / vd);
      if (!drawV) { stats.vCulled++; if (vc > cosV - (hl + 14) / vd && vd < VCULL.far + 14) { const I = v.type === 'scooter' ? 0.35 : v.type === 'bus' ? 1.2 : 1; poolA.setXYZW(np++, p.x + p.hx * hl, p.z + p.hz * hl, yaw, I); } continue; }
      const B = vByType[v.type], k = cnt[v.type]; if (k >= B.cap) continue; cnt[v.type]++;
      Q.setFromAxisAngle(UP, yaw);
      if (v.type === 'bus') {   // (P6, life #4) the kneel: -8 cm and a 1.2 deg lean to the kerb while it dwells at a stop (eased above)
        if (v._kn > 1e-3) { y -= 0.08 * v._kn; Q.multiply(QK.setFromAxisAngle(FWD, -0.021 * v._kn)); }
      }
      M4.compose(V3.set(p.x, y, p.z), Q, S1); B.im.setMatrixAt(k, M4);
      const col = v._lin || (v._lin = lin(v.paint)); B.im.instanceColor.setXYZ(k, col[0], col[1], col[2]);
      B.st.setXYZW(k, v.brake, v.hazard ? 1 : 0, 1, (v.id * 0.37) % 1);
      B.vel.setXYZ(k, p.hx * v.v, 0, p.hz * v.v);
      fill.at(p.x, p.z, tmpF); B.env.setXYZW(k, tmpF[0], tmpF[1], tmpF[2], (v.id * 0.618) % 1);
      const I = v.type === 'scooter' ? 0.35 : v.type === 'bus' ? 1.2 : 1;
      poolA.setXYZW(np++, p.x + p.hx * hl, p.z + p.hz * hl, yaw, I);
    }
    for (const ty of VTYPES) { const B = vByType[ty]; B.im.count = cnt[ty]; B.im.instanceMatrix.needsUpdate = true; B.im.instanceColor.needsUpdate = true; B.st.needsUpdate = true; B.vel.needsUpdate = true; B.env.needsUpdate = true; }
    poolG.instanceCount = np; poolA.needsUpdate = true;
    stats.near = nN; stats.mid = nM; stats.far = nF; stats.drawn = nN + nM + nF; stats.tris = avTris;
    stats.simMs = c1 - c0; stats.cpuMs = performance.now() - c0;
    if (life.audio && life.audio.feed) life.audio.feed(camP, fwd, clock + W);
  }
  const life = {
    group, emitters, sim, stats, fill, motionMeshes, avatars, attachAvatars, tierPids: (lod) => tiers[lod].pid,
    // (P5, life #6: every attempt opened on the same 75 s tableau) the take-tick offset a retry should start its drone clock
    // at (main.js respawn: drone.tick = attemptTicks(n)): the city then opens warm + offset s in, 75-240 s, a hash of
    // (seed, n), never past what the pre-roll has reached. Attempt 0 (and n <= 0) keeps 0. The offset rides in the drone's
    // snapshot, so the input log, replays, ghosts and the movers all see the same city
    attemptTicks: (n) => {
      if (!(n > 0)) return 0;
      const want = (LIFE.warmMax - W) * (h32(seed, n, 0x3a77) / 4294967296);
      // (P6, perf bug 1) a slow device that hasn't pre-rolled that far tops it up here, within LIFE.retryPrerollMs (the
      // retry's fade hides it), so the retry still opens on a later city, not the same one
      if (ctx.preroll !== false) { const t0 = performance.now(); while ((sim.prerolled || 0) - W - 2 < want && !(sim.prerolled >= LIFE.warmMax + 15) && performance.now() - t0 < LIFE.retryPrerollMs) sim.preroll(60); }
      const have = Math.max(0, (sim.prerolled || 0) - W - 2);
      return Math.round(Math.max(0, Math.min(want, have)) * 4) * 60;   // whole quarter seconds of 240 Hz ticks
    },
    // F1 (design #5): vehicles are hard (crash), pedestrians soft (scrape); both pure functions of the take clock
    colliders: { at: (t, out) => sim.boxesAt(t + W, out), hit: (p, r, t) => sim.hit(p, r, t + W), people: (p, r, t) => sim.hitPeople(p, r, t + W), keyed: 'take-clock', warm: W },
    near, crowd,
    update,
    // free-running clock for previews without a take clock (dev page, menu background)
    tick(dt) { if (!extClock) clock += dt; },
    setFill(k) { fillK.value = k; }, setNitScale(k) { nit.value = k; },
    // acoustic context at a point (for the props' wall slapback): nearest facade distance and canyon openness
    acoustics: (p) => acousticsAt(layout, sim.net, p),
    audio: null,
    dispose() { LW.disposed = true; LW.w?.dispose(); LW.w = LW.f = null; group.traverse((o) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); }); group.removeFromParent(); },
    lifeWorker: LW,   // [P4 H] { state, used, inline } (perf / tests)
  };
  life.crossPhase = crossPhase;
  if (ctx.audio !== false) life.audio = createSeoulAudio(layout, life, { signs: ctx.emitters, rain });
  return life;
}

// ================================================================ native export (H, native #2): life.json
// Everything a native port needs to rebuild both sims bit-for-bit from the same layout: constants, vehicle classes,
// signal timing, the lane graph (stops, successors, entries), walkways with their junction links, doors and portals,
// the crowd's static set-up (people, units, queues, busk rings), and the seeds. Hashes let CI check parity.
export function exportData(layout, { seed = 7, density = 1, maxAgents, setPieces, obstacles, puddles } = {}) {
  const sim = new LifeSim(layout, { seed, density, maxAgents, setPieces, obstacles, puddles }), T = sim.traffic, C = sim.crowd, r3 = (v) => Math.round(v * 1000) / 1000;
  const laneId = (l) => l && l.id;
  sim.advanceTo(90); const h90 = sim.hash();
  return {
    version: 2, seed, density, LIFE: { ...LIFE, sidewalk: 'w => clamp(w * 0.15, 3, 6)' }, VEH, signal: LIFE.signal,
    crossings: sim.net.crossings.map((c) => ({ id: c.id, kind: c.kind, street: c.main.id, sc: r3(c.sc), x: r3(c.x), z: r3(c.z), cw: c.cw, halfSpan: r3(c.halfSpan), axis: c.axis, offset: c.offset, toward: c.toward })),
    lanes: T.lanes.map((l) => ({ id: l.id, street: l.street.id, dir: l.dir, k: l.k, lat: r3(l.lat), s0: r3(l.s0), s1: r3(l.s1), bus: l.bus, shared: l.shared, curb: l.curb,
      stops: l.stops.map((st) => ({ s: r3(st.s), crossing: st.c.id })), busStops: l.busStops.map(r3), succ: l.succ.map((g) => ({ turn: r3(g.turn), lanes: g.lanes.map(laneId) })), adj: l.adj.map(laneId) })),
    entries: { road: T.entries.road.map(laneId), shared: T.entries.shared.map(laneId), bus: T.busEntries.map(laneId) },
    walkways: C.ways.map((w) => ({ id: w.id, street: w.street.id, kind: w.kind, c: r3(w.c), dmin: r3(w.dmin), dmax: r3(w.dmax), s0: r3(w.s0), s1: r3(w.s1),
      ends: w.ends.map((e) => e.map((j) => ({ way: j.way.id, s: r3(j.s), d: r3(j.d) }))), doors: w.doors.map((d) => ({ s: r3(d.s), d: r3(d.d), x: r3(d.x), z: r3(d.z), wt: r3(d.wt), use: d.use, portal: d.portal || (d.edge ? 'edge' : null) })) })),
    crowd: { people: C.people.length, units: C.units.map((u) => ({ home: u.home.id, v: r3(u.v), P: r3(u.P), phi: r3(u.phi), fvis: r3(u.fvis), members: u.members.length, exit: !!u.exit })),
      queues: C.queues.map((q) => ({ lot: q.lot, door: q.door.map(r3), t: q.t.map(r3), n: q.n.map(r3), Q: q.Q, G: r3(q.G), seed: q.seed })),
      busk: C.busk.map((b) => ({ x: r3(b.x), z: r3(b.z), yaw: r3(b.yaw), kind: b.kind, song: r3(b.song), off: r3(b.off), performers: b.perf.length, audience: b.aud.length })) },
    parity: { trafficHash90: h90 },
  };
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

export default { build, LIFE, LifeSim, exportData };
