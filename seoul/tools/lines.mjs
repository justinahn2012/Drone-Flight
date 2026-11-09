// seoul/tools/lines.mjs — Hongdae take lines, funnels and start points, measured off the built geometry.
//   node seoul/tools/lines.mjs            (writes seoul/lines.json; prints the clearance check per gate)
// Lines are real moves on the real streets (D5: "a line is a real move, named afterwards"): the length of the
// Eoulmadang-ro walking street over heads, Wausan-ro 21-gil under the service drops, the narrowest real gaps between
// buildings, a climb up a facade, a roof drop into an alley, the station-front crossing of Yanghwa-ro over the buses.
// Every gate is placed from layout.json and checked against the collider (buildSeoulGeometry): no sample point of
// the gate rectangle within CLEAR of geometry, and a straight pass through its centre along n is open for +-2 m.
// [P2-F1] phase 2: streets cut into <= 60 m segment micros with feature micros (blades, queues, forks) between them,
// windows sized for 4.5 m/s, gaps open at both ends, a hint + next per start point, set-piece lines coded against stream
// E's setPieces ids, and the level's take `tuning`. Re-run after the buildings (C) or the dressing (E) change.
// [P3-F1] phase 3 (panel 2): WALKING STREET is 걷고싶은거리 itself (s069, the 312 m piece) and the s065 fork is RED ROAD
// (design #1); windows are the flown path / 3.5 m/s + 4 s (design #3, UX #4); head-height micros fly 1.95-2.6 m over
// real club queues and crowds, and a HEADS! on the way voids the move (design #6); no gate a vehicle can touch over
// 0-600 s of the drawn traffic (design #2, gateprobe.mjs); every named line carries a `hint` (UX #2: one source for copy).
// Re-run after the buildings (C), the dressing (E) or the traffic / crowd (G1) change.
import fs from 'node:fs';
import * as THREE from 'three';
import { buildSeoulGeometry } from '../../world-seoul.js';
import { LifeSim } from '../../seoul-life.js';
import { vehicleTouches, gateBasis } from './gateprobe.mjs';

const ROOT = new URL('../', import.meta.url);
const layout = JSON.parse(fs.readFileSync(new URL('layout.json', ROOT), 'utf8'));
const geo = buildSeoulGeometry(layout);
// the previous lines.json: seoul-dressing.js keeps its clutter out of these gates (contract P2-1)
const lineDataPrev = (() => { try { return JSON.parse(fs.readFileSync(new URL('lines.json', ROOT), 'utf8')); } catch (e) { return null; } })();
const { bvh } = geo;
const CLEAR = 0.3;
const lotById = new Map(layout.lots.map((l) => [l.id, l]));
const H = (l) => l.floors * l.floorH;

// ---- street geometry
const len = (p) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
const byId = new Map(layout.streets.map((s) => [s.id, s]));
// the piece of a named street nearest `near` (optionally of a kind), longest first among ties
function piece(ko, near, kind) {
  let best = null;
  for (const s of layout.streets) { if (s.ko !== ko || (kind && s.kind !== kind)) continue;
    const d = Math.min(...s.points.map((p) => Math.hypot(p[0] - near[0], p[1] - near[1])));
    if (!best || d < best.d - 1) best = { s, d }; }
  return best.s;
}
// point + unit tangent at arc length s (negative: from the end)
function at(pts, s) {
  const L = len(pts); if (s < 0) s += L; s = Math.max(0, Math.min(L, s));
  for (let i = 0; i < pts.length - 1; i++) { const [ax, az] = pts[i], [bx, bz] = pts[i + 1], l = Math.hypot(bx - ax, bz - az);
    if (s <= l || i === pts.length - 2) { const t = l ? s / l : 0; return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / l, tz: (bz - az) / l }; } s -= l; }
}
const r3 = (v) => Math.round(v * 1000) / 1000;
const g = (c, n, w, h, u) => ({ c: c.map(r3), n: n.map(r3), w: r3(w), h: r3(h), ...(u ? { u: u.map(r3) } : {}) });
const neg = (G) => ({ ...G, n: G.n.map((v) => -v) });
// a gate across a street at arc length s, y0..y1
// measured from the built street: the OSM centreline is often off the middle (and the carriageway is not the gap
// between facades), so the gate centres between the walls / sign bands found by rays at both heights, 0.5 m off each
const across = (pts, s, w, y0, y1) => {
  const p = at(pts, s), px = -p.tz, pz = p.tx; let dl = 30, dr = 30;
  for (const y of [y0 + 0.2, (y0 + y1) / 2, y1 - 0.2]) for (const sg of [1, -1]) {
    ray.origin.set(p.x, y, p.z); ray.direction.set(px * sg, 0, pz * sg); const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, 30);
    if (h) { if (sg > 0) dl = Math.min(dl, h.distance); else dr = Math.min(dr, h.distance); } }
  const W = Math.min(w, dl + dr - 1.0), half = W / 2 + 0.5;   // stay on the centreline unless a wall is within reach
  const off = dl < half ? dl - half : dr < half ? half - dr : 0;
  return g([p.x + px * off, (y0 + y1) / 2, p.z + pz * off], [p.tx, 0, p.tz], W, y1 - y0, [px, 0, pz]);
};

// ---- clearance: shrink a gate until its samples clear the collider (returns null if it can't keep 60 %)
const cp = {}, ray = new THREE.Ray();
function clearOf(G) {
  const n = new THREE.Vector3(...G.n).normalize();
  let u = G.u ? new THREE.Vector3(...G.u) : Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n);
  u.addScaledVector(n, -u.dot(n)).normalize(); const v = new THREE.Vector3().crossVectors(n, u);
  const c = new THREE.Vector3(...G.c);
  // a 25 x 13 grid: holds both this tool's old 9 x 7 samples and test-seoul's 7 x 5 (a gate that clears here clears there)
  for (let i = 0; i <= 24; i++) for (let j = 0; j <= 12; j++) {
    const p = c.clone().addScaledVector(u, (i / 24 - 0.5) * G.w).addScaledVector(v, (j / 12 - 0.5) * G.h);
    const q = bvh.closestPointToPoint(p, cp, 0, CLEAR); if (q && q.distance < CLEAR) return { ok: false, p, what: geo.colKeyOf(cp.faceIndex) };
  }
  ray.origin.copy(c).addScaledVector(n, -2); ray.direction.copy(n);
  const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, 4);
  if (hit) return { ok: false, p: hit.point, what: geo.colKeyOf(hit.faceIndex) + ' (ray)' };
  return { ok: true };
}
function fit(G, name) {
  let cur = { ...G };
  let r; for (let k = 0; k < 14; k++) { r = clearOf(cur); if (r.ok) { if (k) console.log(`  ${name}: shrunk to ${cur.w.toFixed(2)} x ${cur.h.toFixed(2)}`); return cur; } cur = { ...cur, w: r3(cur.w * 0.9), h: r3(cur.h * 0.93) }; }
  if (cur.w < G.w * 0.6) console.log(`  ${name}: BLOCKED (kept ${cur.w.toFixed(2)} x ${cur.h.toFixed(2)}) at ${r.p.toArray().map((v) => v.toFixed(1))} ${r.what}`);
  return cur;
}
// straight flight between two gate centres open?
function openPath(a, b) {
  const A = new THREE.Vector3(...a.c), B = new THREE.Vector3(...b.c), d = B.clone().sub(A), L = d.length();
  ray.origin.copy(A); ray.direction.copy(d.normalize()); const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, L);
  return h ? +h.distance.toFixed(1) : true;
}

// the first station (arc length) along the list where the gate keeps >= 75 % of its width clear
const bestAcross = (pts, list, w, y0, y1) => { let first = null; for (const s of list) { const G = across(pts, s, w, y0, y1); first ||= G; if (G.w >= Math.min(w, 3) * 0.75 && clearOf(G).ok) return G; } return first; };
const lines = [], funnels = [], report = [];
const add = (name, caption, pts, main, extra = {}) => {
  main = fit(main, name); if (extra.pre) extra.pre = extra.pre.map((p) => fit(p, name + ' (pre)'));
  const path = extra.pre && extra.straight ? openPath(extra.pre[0], main) : true;
  lines.push({ name, caption, pts, ...main, ...extra });
  report.push(`${name.padEnd(18)} ${String(pts).padStart(5)}  gate ${main.w.toFixed(1)} x ${main.h.toFixed(1)} m at [${main.c.map((v) => v.toFixed(1))}]${extra.straight ? `  pre->gate straight: ${path === true ? 'open' : 'hit at ' + path + ' m'}` : ''}${extra.micro ? '  (micro)' : ''}`);
};
// [P2-F1 design #6] windows a pilot can make. [P3-F1 design #3 / UX #4] the flown path (a street run's polyline, not the
// straight line between its gates) at PILOT_V = 3.5 m/s + WIN_PAD 4 s: a careful pilot averaged 4.3 m/s through the fork
// and missed phase 2's 48 s WALKING STREET window in 4 of 6 sims (route / 4.5 + 2 s).
const PILOT_V = 3.5, WIN_PAD = 4;
const within = (dist) => Math.ceil(dist / PILOT_V + WIN_PAD);
const dist3 = (a, b) => Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1], a.c[2] - b.c[2]);
// arc length of the point nearest (x, z) on a polyline
function arcOf(pts, x, z) { let best = null, acc = 0; for (let i = 0; i < pts.length - 1; i++) { const [ax, az] = pts[i], [bx, bz] = pts[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1e-9; const u = Math.max(0, Math.min(l, ((x - ax) * dx + (z - az) * dz) / l)); const d = Math.hypot(x - ax - dx * u / l, z - az - dz * u / l); if (!best || d < best.d) best = { s: acc + u, d }; acc += l; } return best.s; }
// [P2-F1 design #1/#3] a street run. The named line (pre-gate near one end, gate near the other, either way) is cut into
// micro segments of <= MAX_SEG m ("<NAME> 2/4"), with micros on real features in between (the first blade stack, a club's
// door queue, a fork of the street), so a pilot at 8 m/s meets a beat every 2-5 s instead of nothing for 150-200 m.
// Segments and feature micros are micro-lines (500-750 pts, never hinted, counted apart from the named lines).
const MAX_SEG = 60;
function run({ path, name, caption, value, s0, s1, y0, y1, w, cuts = null, segValue = 750, feats = [], first = false, label = name }) {
  const Lp = len(path), S = (v) => (v < 0 ? v + Lp : v);
  const gateAt = (sv, a = y0, b = y1, ww = w) => bestAcross(path, [0, 3, -3, 6, -6].map((d) => S(sv) + d), ww, a, b);
  const arcG = (G) => arcOf(path, G.c[0], G.c[2]);
  const A = gateAt(s0), B = gateAt(s1), sa = arcOf(path, A.c[0], A.c[2]), sb = arcOf(path, B.c[0], B.c[2]);
  add(name, caption, value, B, { pre: [A], within: within(Math.abs(sb - sa)), ...(first ? { first: true } : {}) });
  add(name, caption, value, neg(A), { pre: [neg(B)], within: within(Math.abs(sb - sa)) });
  // segment boundaries: given cuts (arc lengths), else equal pieces of <= MAX_SEG m
  const span = sb - sa, n = cuts ? cuts.length + 1 : Math.max(1, Math.ceil(Math.abs(span) / MAX_SEG));
  const cs = cuts ? cuts.map(S) : Array.from({ length: n - 1 }, (_, i) => sa + span * (i + 1) / n);
  const G = [A, ...cs.map((c) => gateAt(c)), B];
  if (n > 1) for (let i = 0; i < n; i++) {
    const a = G[i], b = G[i + 1], segName = `${label} ${i + 1}/${n}`, cap = `${label} *${i + 1}/${n}*`, L = Math.max(dist3(a, b), Math.abs(arcG(b) - arcG(a)));
    add(segName, cap, segValue, b, { pre: [a], within: within(L), micro: true, seg: name });
    add(segName, cap, segValue, neg(a), { pre: [neg(b)], within: within(L), micro: true, seg: name });
  }
  for (const f of feats) {
    const cap = f.caption || f.name.replace(/ (\S+)$/, ' *$1*!');
    // [P3-F1 design #6] a club queue near f.s: fly its length at head height (queueMove), else the gate across the street
    if (f.queue) { const q = queueNear(path, S(f.s), f.queueR ?? 14); const mv = q && queueMove(q, f.name);
      if (mv) { addQueue(f.name, cap, f.pts || 750, mv, { feature: f.what, on: name }); continue; }
      report.push(`  (${f.name}: no club queue near ${S(f.s).toFixed(0)} m with open air over it: ${f.queueOnly ? 'no micro' : 'across the street'})`); if (f.queueOnly) continue; }
    const Gf = f.gate || gateAt(f.s, f.y0 ?? y0, f.y1 ?? y1, f.w ?? w);
    add(f.name, cap, f.pts || 500, Gf, { two: true, micro: true, feature: f.what, on: name, ...(f.heads ? { heads: true } : {}) });
  }
  report.push(`  (${name}: ${Math.abs(span).toFixed(0)} m, window ${within(Math.abs(span))} s, ${n} segments, ${feats.length} feature micros)`);
  return { A, B, G };
}

// ---- [P3-F1 design #6] heads with a stake. seoul-life.js's crowd (LifeSim, world-seoul's seed 11: the drawn city) stands
// its club queues in pairs 0.85-1.4 m off the frontage from 0.9 m past the door; heads reach 1.62 x 1.14 = 1.85 m (static
// capsules 2.0 m), so with the quad's 0.12 m a pass at 1.95-2.6 m has 0-0.6 m of air. Phase 2's queue and blade micros
// were 1.9-3.4 m across the whole street: a pilot flew the middle at 3 m and 0 of 54 sim takes met a head.
// OVER THE QUEUE flies a queue's length (door end to tail, either way) at HEAD_Y, a pre-gate at one end and the gate at
// the other, under the awnings and blades (skipped where something hangs lower than 2.6 m + CLEAR); a HEADS! on the way
// voids the move (take.js: lines with `heads`). Across-street head-height micros carry `heads` too.
const HEAD_Y = [1.95, 2.6];
const HEADS = { y0: HEAD_Y[0], y1: HEAD_Y[1], heads: true };
const lifeSim = new LifeSim(layout, { seed: 11, density: 1, maxAgents: 2400 });
const queues = lifeSim.crowd?.queues || [];
const usedQ = new Set();
// the queue whose door projects onto `path` within r m of arc length s and within the street (+4 m)
function queueNear(path, s, r) {
  let best = null;
  for (const q of queues) { if (usedQ.has(q.id)) continue;
    let acc = 0, bd = null; for (let i = 0; i < path.length - 1; i++) { const [ax, az] = path[i], [bx, bz] = path[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1e-9; const u = Math.max(0, Math.min(l, ((q.door[0] - ax) * dx + (q.door[1] - az) * dz) / l)); const d = Math.hypot(q.door[0] - ax - dx * u / l, q.door[1] - az - dz * u / l); if (!bd || d < bd.d) bd = { s: acc + u, d }; acc += l; }
    if (bd.d > 12 || Math.abs(bd.s - s) > r) continue;
    if (!best || Math.abs(bd.s - s) < best.ds) best = { q, ds: Math.abs(bd.s - s) };
  }
  return best?.q || null;
}
// the queue's two ends at HEAD_Y: 0.9 m off the door line (the pairs stand 0.45 and 1.0 m off it), 1.8 m wide, along t
function queueMove(q, name) {
  const Lq = 0.9 + 0.75 * Math.ceil(q.Q / 2) + 0.4, lat = 0.95, y = (HEAD_Y[0] + HEAD_Y[1]) / 2, h = HEAD_Y[1] - HEAD_Y[0];
  const P = (a) => [q.door[0] + q.t[0] * a + q.n[0] * lat, y, q.door[1] + q.t[1] * a + q.n[1] * lat];
  const A = g(P(0.2), [q.t[0], 0, q.t[1]], 1.8, h, [q.n[0], 0, q.n[1]]), B = g(P(Lq), [q.t[0], 0, q.t[1]], 1.8, h, [q.n[0], 0, q.n[1]]);
  const fa = fit(A, name + ' (door end)'), fb = fit(B, name + ' (tail)');
  if (fa.w < 1.2 || fb.w < 1.2 || fa.h < h * 0.8 || fb.h < h * 0.8 || openPath(fa, fb) !== true) return null;
  usedQ.add(q.id);
  return { A: fa, B: fb, L: Lq - 0.2, q };
}
function addQueue(name, caption, pts, mv, extra) {
  const w = within(mv.L);
  add(name, caption, pts, mv.B, { pre: [mv.A], within: w, micro: true, heads: true, ...extra });
  add(name, caption, pts, neg(mv.A), { pre: [neg(mv.B)], within: w, micro: true, heads: true, ...extra });
  report.push(`  (${name}: over the ${mv.q.Q}-person queue at ${mv.q.lot}, ${mv.L.toFixed(1)} m at ${HEAD_Y.join('-')} m)`);
}
const longest = (ko, kind) => layout.streets.filter((s) => s.ko === ko && (!kind || s.kind === kind)).sort((a, b) => len(b.points) - len(a.points))[0];
// a street's points running away from a hero point (layout.hero id)
const fromHero = (st, id) => { const h = (layout.hero || []).find((x) => x.id === id)?.pos, P = st.points;
  if (!h) return P; return Math.hypot(P[0][0] - h[0], P[0][1] - h[2]) <= Math.hypot(P[P.length - 1][0] - h[0], P[P.length - 1][1] - h[2]) ? P : P.slice().reverse(); };

// 1. WALKING STREET: 걷고싶은거리 itself [P3-F1 design #1]: C's widths show it is the 312 x 14.8 m Eoulmadang-ro piece
// (s069, 50 lots) from its SE end to the Hongik-ro junction, not the s065 fork phase 2 flew (now RED ROAD). 2.2-5.2 m
// over the crowd, flown toward the hub: the spawn is at the SE end, the line ends at the junction over the busking ring
// (13 m before it), where RED ROAD, HONGIK-RO and the bar alleys begin (from the hub out, the take would have to fly
// 300 m back: a transit hole, design #4). Cut <= 60 m at the side streets (Wausan-ro 23-gil joins 157 m from the SE
// end, the two Eoulmadang-ro branches leave at 232 and 244 m); micros on what is there: OVER THE CROWD 17 m from the
// spawn (head height: design #6), a pocha tent at 134 m, the branches.
const walk = longest('어울마당로', 'walking'), WP = fromHero(walk, 'hongik-junction').slice().reverse(), WL = len(WP);
const tentOn = (P, s, r) => (geo.dressingOut?.labels || []).filter((l) => l.kind === 'tent').map((l) => ({ l, a: arcOf(P, l.pos[0], l.pos[2]) })).filter((x) => Math.abs(x.a - s) < r).sort((a, b) => Math.abs(a.a - s) - Math.abs(b.a - s))[0]?.l || null;
// over a pocha tent, along the street: the tarp's top found by a ray down, the gate 0.5-2.1 m over it
function overTent(P, s) {
  const T = tentOn(P, s, 15); if (!T) return null;
  ray.origin.set(T.pos[0], 8, T.pos[2]); ray.direction.set(0, -1, 0); const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, 8); if (!h) return null;
  const top = 8 - h.distance, a = at(P, arcOf(P, T.pos[0], T.pos[2]));
  return g([T.pos[0], top + 1.3, T.pos[2]], [a.tx, 0, a.tz], 3.0, 1.6, [-a.tz, 0, a.tx]);
}
const tentG = overTent(WP, WL - 178);
run({ path: WP, name: 'WALKING STREET', caption: 'THE WALKING *STREET*!', value: 2500, s0: 12, s1: -6, y0: 2.2, y1: 5.2, w: walk.width - 1, first: true,
  cuts: [52, 102, 152, 202, 252].map((v) => v + WL - 312), label: 'WALKING STREET', feats: [
    { name: 'OVER THE CROWD', caption: 'OVER THE *CROWD*!', s: 24, ...HEADS, w: 8, pts: 750, what: 'the walking street crowd, 17 m from the spawn (head height)' },
    ...(tentG ? [{ name: 'OVER THE TENT', caption: 'OVER THE *TENT*!', s: WL - 178, gate: tentG, what: 'a pocha tent' }] : []),
    { name: 'THE BRANCHES', caption: 'THE *BRANCHES*!', s: WL - 74, what: 'two Eoulmadang-ro branches leave (68 and 80 m before the junction)' },
  ] });
// 1b. RED ROAD: the s065 fork of Eoulmadang-ro (phase 2's walking street: the Red Road busking stretch), 2.2-5.2 m, cut at the
// side streets (55, 100, 160 of 226 m); micros: the first blade stack (22 m) and the densest blade stretch (58-79 m) at
// head height under the 3.55 m blades, the fork (133 m), OVER THE QUEUE at the club door (150 m), the split (177 m)
const red = piece('어울마당로', [-27, -14], 'walking'), RL = len(red.points);
run({ path: red.points, name: 'RED ROAD', caption: 'THE RED *ROAD*!', value: 2000, s0: 12, s1: -5, y0: 2.2, y1: 5.2, w: red.width - 1,
  cuts: [55, 100, 166], label: 'RED ROAD', feats: [
    { name: 'UNDER THE BLADES', s: 22, ...HEADS, pts: 750, what: 'first blade stack (2F blades at 3.55 m), head height' },
    { name: 'BLADE ALLEY', s: 70, ...HEADS, pts: 750, what: 'blade stacks both sides, 58-79 m, head height' },
    { name: 'THE FORK', s: 133, what: 'the other Eoulmadang-ro branch joins' },
    { name: 'OVER THE QUEUE', caption: 'OVER THE *QUEUE*!', s: 150, queue: true, ...HEADS, what: 'the club queue at 150 m' },
    { name: 'THE SPLIT', s: 177, what: 'the walking branch splits off' },
  ] });
// 2. BAR ALLEY: Wausan-ro 21-gil, the E-W bar and club alley (reference hero line 4), 2.0-4.0 m (drops cross from 4.2 m)
const club = longest('와우산로21길', 'club'); const CL = len(club.points);
run({ path: club.points, name: 'BAR ALLEY', caption: 'THE BAR *ALLEY*!', value: 2000, s0: 14, s1: -14, y0: 2.0, y1: 4.0, w: club.width - 0.8,
  cuts: [57, 100, 150], feats: [
    { name: 'DOOR QUEUE', caption: 'DOOR *QUEUE*!', s: 121, queue: true, ...HEADS, what: 'the club queue at 120 m (karaoke, blades both sides)' },
    { name: 'CLUB DOORS', s: 173, ...HEADS, pts: 750, what: 'club door at 173 m, head height under the awnings' },
    { name: 'POCHA ROW', s: 188, ...HEADS, pts: 750, what: 'pocha at 187 m, head height' },
  ] });
// 2b. CLUB STREET: Wausan-ro 19-gil, "클럽거리" proper (hero line 5), 2.0-4.0 m
{ const c19 = longest('와우산로19길'); const L19 = len(c19.points);
  if (c19 && L19 > 40) {
    run({ path: c19.points, name: 'CLUB STREET', caption: 'CLUB *STREET*!', value: 2000, s0: 10, s1: -10, y0: 2.0, y1: 4.0, w: c19.width + 2,
      feats: [{ name: 'CLUB QUEUE', caption: 'CLUB *QUEUE*!', s: 50, queue: true, queueOnly: true, queueR: 25, ...HEADS, what: 'a club queue on 19-gil' }] });
    report.push(`  (CLUB STREET: Wausan-ro 19-gil piece ${c19.id}, ${L19.toFixed(0)} m)`); } }
// 2c. PLAYGROUND POP (micro): out of the bar alleys, up over Hongdae Playground (hero line 4's pop-up): a 10 m
// horizontal portal at 9 m over the park, crossed climbing
{ const G = g([80, 9, 97], [0, 1, 0], 10, 10, [1, 0, 0]); add('PLAYGROUND POP', 'PLAYGROUND *POP*!', 500, G, { micro: true }); }
// 3. HONGIK-RO: down the main road from the station to the university, 5-8 m: over the buses, under the lamp arms' reach
const hong = longest('홍익로', 'main'); const HL = len(hong.points);
run({ path: hong.points, name: 'HONGIK-RO', caption: 'DOWN *HONGIK-RO*!', value: 1500, s0: 10, s1: -10, y0: 5.0, y1: 8.0, w: hong.width });
// 4. CROSSING: across Yanghwa-ro at the station front. [P3-F1 design #5] anchored: phase 2 was a 30 x 3 m portal in the air
// over the median. Now a pre-gate under the near carriageway's signal mast arm (E's dressing: the arm at 5.5 m, heads at
// 5.1-5.4 m) and the gate under the far one's, 3.7-4.9 m (a bus's roof is 3.15 m: it passes under you), across the
// crosswalk; either way. No masts in the dressing: phase 2's portal.
{ const X9 = [46, -313];   // exit 9 (reference.md)
  const dTo = (s) => Math.min(...s.points.map((p) => Math.hypot(p[0] - X9[0], p[1] - X9[1])));
  const ys = layout.streets.filter((s) => s.ko === '양화로' && s.kind === 'main').sort((a, b) => dTo(a) - dTo(b));
  const nA = ys[0], nB = ys.find((s) => s !== nA && Math.abs(dTo(s) - dTo(nA)) < 40 && s.points.length) || ys[1];
  let s0 = 0, bd = Infinity; for (let s = 0; s <= len(nA.points); s += 1) { const q = at(nA.points, s), d = Math.hypot(q.x - X9[0], q.z - X9[1]); if (d < bd) { bd = d; s0 = s; } }
  const pa = at(nA.points, s0);
  // the far carriageway's nearest point
  let best = null; for (let s = 0; s <= len(nB.points); s += 1) { const q = at(nB.points, s), d = Math.hypot(q.x - pa.x, q.z - pa.z); if (!best || d < best.d) best = { q, d }; }
  const mx = (pa.x + best.q.x) / 2, mz = (pa.z + best.q.z) / 2, nx = -pa.tz, nz = pa.tx;
  // E's signal masts at this crossing: 4 car heads per mast (carR/A/L/G) at the end of a 5.5 m arm from the kerb pole
  const heads = (geo.dressingOut?.lamps || []).filter((l) => /^car/.test(l.role) && Math.hypot(l.pos[0] - mx, l.pos[2] - mz) < 30);
  const masts = [...new Set(heads.map((l) => l.id))].map((id) => { const H4 = heads.filter((l) => l.id === id), c = [0, 1, 2].map((k) => H4.reduce((a, l) => a + l.pos[k], 0) / H4.length);
    return { id, c, d: (c[0] - mx) * nx + (c[2] - mz) * nz, s: (c[0] - mx) * pa.tx + (c[2] - mz) * pa.tz }; });
  const near = masts.filter((m) => m.d > 0).sort((a, b) => a.d - b.d)[0], far = masts.filter((m) => m.d < 0).sort((a, b) => b.d - a.d)[0];
  if (near && far) {
    // the arm runs from the head out to its pole (away from the road centre, ~5.5-6.5 m): the gate under its middle
    const under = (m, sg) => { const dd = m.d + sg * 3.0; return g([mx + nx * dd + pa.tx * m.s, 4.3, mz + nz * dd + pa.tz * m.s], [-nx, 0, -nz], 2.4, 1.2, [pa.tx, 0, pa.tz]); };
    const A = fit(under(near, 1), 'CROSSING (near mast)'), B = fit(under(far, -1), 'CROSSING (far mast)'), L = dist3(A, B);
    add('CROSSING', 'THE *CROSSING*!', 1500, B, { pre: [A], within: within(L) });
    add('CROSSING', 'THE *CROSSING*!', 1500, neg(A), { pre: [neg(B)], within: within(L) });
    report.push(`  (CROSSING: under the masts ${near.id} and ${far.id}, ${L.toFixed(1)} m, ${A.w.toFixed(1)} x ${A.h.toFixed(1)} / ${B.w.toFixed(1)} x ${B.h.toFixed(1)} m at 3.7-4.9 m)`);
  } else {
    add('CROSSING', 'THE *CROSSING*.', 1500, g([mx, 7.5, mz], [nx, 0, nz], 30, 3, [pa.tx, 0, pa.tz]), { two: true });
    report.push('  (CROSSING: no signal masts in the dressing: the phase-2 portal)');
  }
  report.push(`  (Yanghwa-ro carriageway centres ${best.d.toFixed(1)} m apart at exit 9)`);
  // SCREEN CANYON (hero line 1): from exit 9 SW down Yanghwa-ro between the 14-16 m LED screens to the Hongik-ro junction.
  // [P3-F1 design #5] anchored: down the exit-9 carriageway (nA) at 4.4-8.4 m (the screens' feet; a bus's roof 3.15 m),
  // through 14 x 4 m gates strung between the street-lamp pairs (8.7 m heads every 32 m, both kerbs: C's emitters),
  // instead of phase 2's 30 x 6 m portals at 11 m over the median. Pre-gate at the first lamp pair >= 9 m SW of exit 9,
  // the gate at the last one ~110 m on; the pairs between cut it into micros.
  const sg = pa.tx < 0 ? 1 : -1;   // nA's direction: the flight runs SW (toward Hongik-ro, x decreasing)
  const lamps = geo.emitters.filter((e) => e.kind === 'street' && e.pos[1] > 7.5).map((e) => { const s = arcOf(nA.points, e.pos[0], e.pos[2]), q = at(nA.points, s);
    return { s, d: (e.pos[0] - q.x) * -q.tz + (e.pos[2] - q.z) * q.tx }; }).filter((x) => Math.abs(x.d) < nA.width / 2 + 1 && x.s > 1 && x.s < len(nA.points) - 1);
  // a pair: a lamp on each kerb at the same station (+-1.5 m)
  const lampS = [...new Set(lamps.filter((a) => a.d > 0 && lamps.some((b) => b.d < 0 && Math.abs(b.s - a.s) < 1.5)).map((a) => Math.round(a.s)))];
  const pairs = lampS.filter((v) => sg * (v - s0) >= 9 && sg * (v - s0) <= 125).sort((a, b) => sg * (a - b));
  const canyonGate = (s) => { const q = at(nA.points, s), n = [q.tx * sg, 0, q.tz * sg]; return g([q.x, 6.4, q.z], n, Math.min(14, nA.width - 4), 4.0, [-n[2], 0, n[0]]); };
  if (pairs.length >= 3) {
    const Gs = pairs.map((v, i) => fit(canyonGate(v), `SCREEN CANYON lamp ${i}`)), Ga = Gs[0], Gb = Gs[Gs.length - 1], dl = Math.abs(pairs[pairs.length - 1] - pairs[0]);
    add('SCREEN CANYON', 'THE SCREEN *CANYON*!', 2500, Gb, { pre: [Ga], within: within(dl) });
    add('SCREEN CANYON', 'THE SCREEN *CANYON*!', 2500, neg(Ga), { pre: [neg(Gb)], within: within(dl) });
    const N = Gs.length - 1;
    for (let i = 0; i < N; i++) { const a = Gs[i], b = Gs[i + 1], L = Math.abs(pairs[i + 1] - pairs[i]);
      add(`SCREEN CANYON ${i + 1}/${N}`, `SCREEN CANYON *${i + 1}/${N}*`, 750, b, { pre: [a], within: within(L), micro: true, seg: 'SCREEN CANYON' });
      add(`SCREEN CANYON ${i + 1}/${N}`, `SCREEN CANYON *${i + 1}/${N}*`, 750, neg(a), { pre: [neg(b)], within: within(L), micro: true, seg: 'SCREEN CANYON' }); }
    report.push(`  (SCREEN CANYON: ${dl.toFixed(0)} m down nA ${nA.id} from exit 9, gates at the lamp pairs ${pairs.map((v) => (v - s0).toFixed(0)).join(', ')} m)`);
  } else report.push(`  (SCREEN CANYON: only ${pairs.length} lamp pairs on ${nA.id}: no line)`);
  // OVER THE BUSES half way: low over the median bus lane (Seoul's median BRT), 4.5-8 m, where the buses are
  const cx = (s) => { const q = at(nA.points, s); let bb = null; for (let t = 0; t <= len(nB.points); t += 1) { const r = at(nB.points, t), d = Math.hypot(r.x - q.x, r.z - q.z); if (!bb || d < bb.d) bb = { r, d }; }
    return { x: (q.x + bb.r.x) / 2, z: (q.z + bb.r.z) / 2 }; };
  const pBus = cx(s0 + sg * 45), q45 = at(nA.points, s0 + sg * 45), nb = [q45.tx * sg, 0, q45.tz * sg];
  add('OVER THE BUSES', 'OVER THE *BUSES*!', 500, g([pBus.x, 6.25, pBus.z], nb, 10, 3.5, [-nb[2], 0, nb[0]]), { two: true, micro: true, feature: 'Yanghwa-ro median bus lane', on: 'SCREEN CANYON' }); }
// 5. THE GAP / TIGHT GAP: the narrowest real gaps between two buildings of 3+ storeys (parallel walls 1.4-3.2 m apart,
// overlapping >= 6 m), found in the footprints; flown through along the gap
const gaps = [];
{ const L = layout.lots.filter((l) => l.floors >= 3);
  const edges = L.flatMap((l) => l.footprint.map((a, i) => { const b = l.footprint[(i + 1) % l.footprint.length], dx = b[0] - a[0], dz = b[1] - a[1], ln = Math.hypot(dx, dz); return { l, a, b, ln, tx: dx / ln, tz: dz / ln, nx: dz / ln, nz: -dx / ln }; })).filter((e) => e.ln >= 6);
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const e = edges[i], f = edges[j]; if (e.l === f.l) continue;
    if (e.nx * f.nx + e.nz * f.nz > -0.985) continue;                                           // facing each other
    const d = (f.a[0] - e.a[0]) * e.nx + (f.a[1] - e.a[1]) * e.nz; if (d < 1.4 || d > 3.2) continue;
    const s0 = Math.max(0, Math.min((f.a[0] - e.a[0]) * e.tx + (f.a[1] - e.a[1]) * e.tz, (f.b[0] - e.a[0]) * e.tx + (f.b[1] - e.a[1]) * e.tz));
    const s1 = Math.min(e.ln, Math.max((f.a[0] - e.a[0]) * e.tx + (f.a[1] - e.a[1]) * e.tz, (f.b[0] - e.a[0]) * e.tx + (f.b[1] - e.a[1]) * e.tz));
    if (s1 - s0 < 6) continue;
    const sm = (s0 + s1) / 2, cx = e.a[0] + e.tx * sm + e.nx * d / 2, cz = e.a[1] + e.tz * sm + e.nz * d / 2;
    gaps.push({ d, len: s1 - s0, c: [cx, cz], t: [e.tx, e.tz], nrm: [e.nx, e.nz], hMin: Math.min(H(e.l), H(f.l)), lots: [e.l.id, f.l.id] });
  }
  gaps.sort((a, b) => a.d - b.d);
}
const usedGap = [], GAP_RUN = 14;
for (const [name, pts, micro] of [['THE GAP', 2500, false], ['TIGHT GAP', 500, true], ['SIDE GAP', 500, true]]) {
  for (const q of gaps) {
    if (usedGap.some((u) => Math.hypot(u.c[0] - q.c[0], u.c[1] - q.c[1]) < 40)) continue;
    const top = Math.min(q.hMin - 0.5, 9), G = g([q.c[0], (1.0 + top) / 2, q.c[1]], [q.t[0], 0, q.t[1]], q.d - 0.25, top - 1.0, [q.nrm[0], 0, q.nrm[1]]);
    if (!clearOf({ ...G, w: Math.min(1.2, G.w), h: G.h * 0.8 }).ok) continue;   // blocked (AC units, a pole, a drop): next gap
    // [P2-F1] a gap you can fly through: open for GAP_RUN m past both ends (phase 1: TIGHT GAP's -n side was 7.2 m to a
    // wall, THE GAP's an 11 m dead end), checked at three heights
    const runOut = (sg) => Math.min(...[0.3, 0.5, 0.7].map((f) => { ray.origin.set(q.c[0], 1.0 + (top - 1.0) * f, q.c[1]); ray.direction.set(q.t[0] * sg, 0, q.t[1] * sg);
      const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, 80); return h ? h.distance : 80; }));
    const ro = [runOut(1), runOut(-1)];
    if (Math.min(...ro) < q.len / 2 + GAP_RUN) continue;
    usedGap.push(q);
    add(name, name === 'THE GAP' ? 'THE *GAP*!' : name.replace(/ (\w+)$/, ' *$1*!'), pts, G, { two: true, ...(micro ? { micro: true } : {}) });
    report.push(`  (${name}: ${q.d.toFixed(2)} m between ${q.lots.join(' and ')}, ${q.len.toFixed(1)} m deep, walls ${q.hMin.toFixed(1)} m, open ${ro.map((v) => v.toFixed(0)).join(' / ')} m from the centre)`);
    break;
  }
}
// 6. BACK ALLEY / NARROW ALLEY: the two most enclosed narrow alleys (<= 4 m, >= 40 m, lots on both sides), 2.0-4.0 m
const enclosed = (s) => { let n = 0, k = 0; const L = len(s.points); for (let d = 4; d < L - 4; d += 4) { const p = at(s.points, d); k++;
  for (const sd of [1, -1]) { const x = p.x - p.tz * sd * (s.width / 2 + 1.2), z = p.z + p.tx * sd * (s.width / 2 + 1.2);
    if (layout.lots.some((l) => l.floors >= 3 && Math.abs(l.footprint[0][0] - x) < 60 && Math.abs(l.footprint[0][1] - z) < 60 && pipXZ(x, z, l.footprint))) n++; } } return k ? n / (2 * k) : 0; };
function pipXZ(x, z, P) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; }
const alleys = layout.streets.filter((s) => s.kind === 'alley' && s.width <= 4 && len(s.points) >= 40 && s.points.every(([x, z]) => x > layout.core.x0 && x < layout.core.x1 && z > layout.core.z0 && z < layout.core.z1))
  .map((s) => ({ s, e: enclosed(s) })).sort((a, b) => b.e - a.e);
const usedAl = [];
const h3 = layout.streets.filter((s) => s.ko === '홍익로3길').map((s) => ({ s, e: enclosed(s) })).sort((a, b) => len(b.s.points) - len(a.s.points));
for (const name of ['CABLE LATTICE', 'NARROW ALLEY']) {
  for (const { s, e } of name === 'CABLE LATTICE' ? h3.concat(alleys) : alleys) {
    if (usedAl.some((u) => u.id === s.id || u.ko === s.ko && s.ko)) continue;
    const L = Math.min(len(s.points), 90), A = across(s.points, 6, s.width - 0.6, 2.0, 3.8), B = across(s.points, L - 6, s.width - 0.6, 2.0, 3.8);
    if (!clearOf({ ...A, w: A.w * 0.6 }).ok || !clearOf({ ...B, w: B.w * 0.6 }).ok) continue;
    usedAl.push(s);
    add(name, name.replace(/ (\w+)$/, ' *$1*!'), 1500, B, { pre: [A], within: within(dist3(A, B)) });
    add(name, name.replace(/ (\w+)$/, ' *$1*!'), 1500, neg(A), { pre: [neg(B)], within: within(dist3(A, B)) });
    if (L > MAX_SEG + 12) {   // two halves as micros
      const M = across(s.points, L / 2, s.width - 0.6, 2.0, 3.8);
      if (clearOf({ ...M, w: M.w * 0.6 }).ok) for (const [i, a, b] of [[1, A, M], [2, M, B]]) {
        add(`${name} ${i}/2`, `${name} *${i}/2*`, 750, b, { pre: [a], within: within(dist3(a, b)), micro: true, seg: name });
        add(`${name} ${i}/2`, `${name} *${i}/2*`, 750, neg(a), { pre: [neg(b)], within: within(dist3(a, b)), micro: true, seg: name }); }
    }
    report.push(`  (${name}: ${s.ko || s.id} ${s.width} m wide, ${Math.round(L)} m flown, ${(e * 100).toFixed(0)} % walled)`);
    break;
  }
}
// 7. SCREEN PASS: along the face of the biggest facade LED screen, 1-7 m off it (either way)
{ const sc = layout.screens.find((s) => s.id === 'Y151') || layout.screens.filter((s) => s.kind === 'facade').sort((a, b) => b.w * b.h - a.w * a.h)[0];   // the 14 x 15.8 m screen facing exit 9
  const [nx, , nz] = sc.normal, c = [sc.pos[0] + nx * 4, sc.pos[1], sc.pos[2] + nz * 4];
  add('SCREEN PASS', 'SCREEN *PASS*!', 1000, g(c, [-nz, 0, nx], 6, sc.h, [nx, 0, nz]), { two: true });
  report.push(`  (SCREEN PASS: ${sc.id} on ${sc.lot}, ${sc.w} x ${sc.h} m, centre ${sc.pos[1]} m up)`); }
// 8. SIGN STACK (up funnel): climb a 6+ storey facade on the walking / club street, 2.5 m off the wall, street to roof
{ const cands = layout.lots.filter((l) => l.floors >= 5 && ['walking', 'club'].includes(byId.get(l.street).kind)).sort((a, b) => b.floors - a.floors);
  for (const l of cands) {
    const [a, b] = l.frontage, dx = b[0] - a[0], dz = b[1] - a[1], ln = Math.hypot(dx, dz); if (ln < 5) continue;
    const nx = dz / ln, nz = -dx / ln, x = (a[0] + b[0]) / 2 + nx * 2.6, z = (a[1] + b[1]) / 2 + nz * 2.6, top = H(l) + 2.5;
    const lo = g([x, 5.0, z], [0, 1, 0], 2.6, 2.6, [dx / ln, 0, dz / ln]), hi = g([x, top, z], [0, 1, 0], 3.0, 3.0, [dx / ln, 0, dz / ln]);
    if (!clearOf(lo).ok || !clearOf(hi).ok || openPath(lo, hi) !== true) continue;
    add('SIGN STACK', 'SIGN *STACK*!', 1500, hi, { pre: [lo], within: 8, straight: true });
    funnels.push({ name: 'sign stack', dir: 'up', c: [r3(x), r3(z)], bottom: 4.6, top: r3(top + 0.5), r: 3.0, rIn: 1.2 });
    report.push(`  (SIGN STACK: ${l.id} ${l.floors} storeys, ${H(l).toFixed(1)} m, on ${byId.get(l.street).ko})`);
    break;
  }
}
// 9. ROOF DROP (down funnel): off the roofs into a narrow alley between 4+ storey buildings, landing gate at 2.5 m
{ let done = false;
  for (const { s } of alleys) { if (done) break;
    for (let d = 10; d < len(s.points) - 10 && !done; d += 5) {
      const p = at(s.points, d), side = (sd) => layout.lots.find((l) => l.floors >= 4 && pipXZ(p.x - p.tz * sd * (s.width / 2 + 1.5), p.z + p.tx * sd * (s.width / 2 + 1.5), l.footprint));
      const L1 = side(1), L2 = side(-1); if (!L1 || !L2) continue;
      const roof = Math.min(H(L1), H(L2)), w = s.width - 0.8;
      const hi = g([p.x, roof + 1.5, p.z], [0, -1, 0], w, 3, [-p.tz, 0, p.tx]), lo = g([p.x, 2.6, p.z], [0, -1, 0], w, 3, [-p.tz, 0, p.tx]);
      if (!clearOf(hi).ok || !clearOf(lo).ok || openPath(hi, lo) !== true) continue;
      add('ROOF DROP', 'ROOF *DROP*!', 1500, lo, { pre: [hi], within: 6, straight: true });
      funnels.push({ name: 'roof drop', dir: 'down', c: [r3(p.x), r3(p.z)], top: r3(roof + 0.9), bottom: 3, r: 2.5, rIn: r3(w / 2) });
      report.push(`  (ROOF DROP: into ${s.ko || s.id} between ${L1.id} (${L1.floors}F) and ${L2.id} (${L2.floors}F), ${roof.toFixed(1)} m)`);
      done = true;
    }
  }
}
// 10. ROOFLINE [P3-F1 design #5]: phase 2 flew 33 x 5 m portals 7 m over the roofline. Now a chain of slots over the run of
// roofs E's ROOF SLOT sits on (seoul-dressing.js roofline-slot: a stair house and a water tank, 0.6-2.4 m over a 16.5 m
// roof): every ~15 m back along the run a 2.9 x 1.8 m gate 0.6-2.4 m over that roof's deck (the lowest of five rays down,
// so not a tank top), preferring stations with rooftop kit within 3.5 m on both sides (a slot), each straight-line open
// to the next; the chain ends in E's slot pre-gate, so ROOFLINE runs into ROOF SLOT. No slot piece: phase 2's portals.
{ const RS = (geo.setPieces || []).find((p) => p.id === 'roofline-slot'), Gs = RS?.gates?.gate, Ps = RS?.gates?.pre;
  let chain = null;
  if (Gs && Ps) {
    const dx = Gs.n[0], dz = Gs.n[2], px = -dz, pz = dx, rays = (x, y, z, sx, sz, m) => { ray.origin.set(x, y, z); ray.direction.set(sx, 0, sz); const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, m); return h ? h.distance : m; };
    const deck = (x, z) => { let lo = Infinity; for (const o of [-2, -1, 0, 1, 2]) { ray.origin.set(x + px * o, 60, z + pz * o); ray.direction.set(0, -1, 0); const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, 60); lo = Math.min(lo, h ? 60 - h.distance : 0); } return lo; };
    const y0 = Ps.c[1] - Ps.h / 2 - 0.6;   // E's roof deck
    const gateAtK = (k) => { const x = Ps.c[0] - dx * k, z = Ps.c[2] - dz * k, dk = deck(x, z); if (dk < 8 || Math.abs(dk - y0) > 4) return null;
      const G = g([x, dk + 1.5, z], Gs.n, 2.9, 1.8, [px, 0, pz]); if (!clearOf(G).ok) return null;
      const side = Math.min(rays(x, dk + 1.5, z, px, pz, 6), 6) + Math.min(rays(x, dk + 1.5, z, -px, -pz, 6), 6);
      return { k, G, slot: side < 7.5, side }; };
    chain = [{ k: 0, G: g(Ps.c, Ps.n, Ps.w, Ps.h, Ps.u) }];
    for (let tries = 0; tries < 4; tries++) {
      const last = chain[chain.length - 1]; let pick = null;
      for (let k = last.k + 10; k <= last.k + 20; k++) { const c = gateAtK(k); if (!c || openPath(c.G, last.G) !== true) continue; const sc = (c.slot ? 0 : 10) + Math.abs(k - last.k - 15); if (!pick || sc < pick.sc) pick = { ...c, sc }; }
      if (!pick) break; chain.push(pick);
    }
    if (chain.length < 3) chain = null;
  }
  if (chain) {
    const C = chain.slice().reverse(), A = C[0].G, B = C[C.length - 1].G, L = C[C.length - 1].k === 0 ? C[0].k : dist3(A, B);
    add('ROOFLINE', 'ROOF*LINE*!', 1500, B, { pre: [A], within: within(L) });
    add('ROOFLINE', 'ROOF*LINE*!', 1500, neg(A), { pre: [neg(B)], within: within(L) });
    const N = C.length - 1;
    for (let i = 0; i < N; i++) { const a = C[i].G, b = C[i + 1].G, l = C[i].k - C[i + 1].k;
      add(`ROOFLINE ${i + 1}/${N}`, `ROOFLINE *${i + 1}/${N}*`, 750, b, { pre: [a], within: within(l), micro: true, seg: 'ROOFLINE' });
      add(`ROOFLINE ${i + 1}/${N}`, `ROOFLINE *${i + 1}/${N}*`, 750, neg(a), { pre: [neg(b)], within: within(l), micro: true, seg: 'ROOFLINE' }); }
    report.push(`  (ROOFLINE: ${C[0].k} m of roofs into E's ROOF SLOT, ${N} pieces, gates ${C.slice(0, -1).map((c) => `${c.k} m ${c.slot ? 'slot' : 'open'} (${c.side.toFixed(1)} m)`).join(', ')})`);
  } else {
    const roofAt = (s) => { const p = at(red.points, s); let h = 0; for (const l of layout.lots) { const d = Math.min(...l.footprint.map((q) => Math.hypot(q[0] - p.x, q[1] - p.z))); if (d < 18) h = Math.max(h, H(l)); } return h; };
    const s1 = RL * 0.3, s2 = RL * 0.6, top = Math.max(roofAt(s1), roofAt(s2)) + 1.5;
    const A = across(red.points, s1, red.width + 24, top, top + 5), B = across(red.points, s2, red.width + 24, top, top + 5);
    add('ROOFLINE', 'ROOF*LINE*!', 1500, B, { pre: [A], within: within(dist3(A, B)) });
    add('ROOFLINE', 'ROOF*LINE*!', 1500, neg(A), { pre: [neg(B)], within: within(dist3(A, B)) });
    report.push('  (ROOFLINE: no roofline-slot set piece: the phase-2 portals over the Red Road)');
  } }
// 11. UNDER THE WIRES (micro): under the lowest cable span over the club street or an alley, 2.0 m to 0.4 m below it
{ const span = geo.cables.filter((c) => c.low > 4.5 && c.a[0] > layout.core.x0 && c.a[0] < layout.core.x1 && c.a[2] > layout.core.z0 && c.a[2] < layout.core.z1).sort((a, b) => a.low - b.low);
  for (const c of span) {
    const mx = (c.a[0] + c.b[0]) / 2, mz = (c.a[2] + c.b[2]) / 2, dx = c.b[0] - c.a[0], dz = c.b[2] - c.a[2], ln = Math.hypot(dx, dz);
    const G = g([mx, (2.0 + c.low - 0.4) / 2, mz], [dx / ln, 0, dz / ln], 2.5, c.low - 2.4, [-dz / ln, 0, dx / ln]);
    // the wires run along the street here, so the move is under the bundle along it
    if (!clearOf(G).ok) continue;
    add('UNDER THE WIRES', 'UNDER THE *WIRES*!', 500, G, { two: true, micro: true });
    report.push(`  (UNDER THE WIRES: lowest wire ${c.low.toFixed(2)} m)`); break;
  }
}
// 12. THE CORNER (micro carve): round the Hongik-ro x Eoulmadang-ro corner, 75 deg of track inside the junction box
{ const p = at(red.points, -2);
  lines.push({ name: 'THE CORNER', caption: 'THE *CORNER*!', pts: 500, micro: true, c: [r3(p.x), 3, r3(p.z)], carve: { kind: 'turn', box: [r3(p.x - 14), r3(p.x + 14), 1.5, 9, r3(p.z - 14), r3(p.z + 14)], sweep: 1.3 } });
  report.push(`THE CORNER           500  carve 28 x 28 m box at [${p.x.toFixed(1)}, ${p.z.toFixed(1)}] (micro)`); }

// ---- [P2-F1 design #2] set pieces (stream E's seoul-dressing.js, contract P2-1): lines coded against E's setPieces ids.
// E gives each piece's openings as `gates`: {pre, gate} (a pre-gate -> gate move), {left: {pre, gate}, right: {...}}
// (alternatives: one line, either one scores), {windows: [rect...]} (threaded in order: first -> last) or {gate} (one
// opening, either way). Each line carries `piece`: take.js flies it only while world.setPieces holds that id, so this
// lines.json also works on a build without the pieces. The stairs are a dive (one way); the rest go either way.
const SET_LINES = {
  'station-stairs': { name: 'STATION STAIRS', caption: 'DOWN THE *STAIRS*!', pts: 2000, oneWay: true },
  'under-the-stage': { name: 'UNDER THE STAGE', caption: 'UNDER THE *STAGE*!', pts: 1500 },
  'bus-shelter': { name: 'BUS SHELTER', caption: 'THROUGH THE *SHELTER*!', pts: 1000 },
  'cable-thread': { name: 'CABLE THREAD', caption: 'CABLE *THREAD*!', pts: 1500 },
  'roofline-slot': { name: 'ROOF SLOT', caption: 'THE ROOF *SLOT*!', pts: 1500 },
};
const rect = (q) => (q?.c && q?.n && q.w > 0 && q.h > 0 ? g(q.c, q.n, q.w, q.h, q.u) : null);
function pieceMoves(sp) {   // -> [{pre: rect | null, gate: rect}]
  const G = sp.gates || (sp.gate ? { gate: sp.gate, pre: sp.pre?.[0] } : null); if (!G) return [];
  if (G.gate) return [{ pre: rect(G.pre), gate: rect(G.gate) }];
  if (Array.isArray(G.windows) && G.windows.length) { const w = G.windows.map(rect).filter(Boolean); return w.length > 1 ? [{ pre: w[0], gate: w[w.length - 1] }] : w.length ? [{ pre: null, gate: w[0] }] : []; }
  return Object.values(G).filter((v) => v && v.gate).map((v) => ({ pre: rect(v.pre), gate: rect(v.gate) }));
}
{ // the pieces of THIS build (the collider every gate here is checked against): E places them from the layout alone, so the
  // runtime build (with lines.json) has the same pieces. Their gates are E's, sized >= 2.2 x 1.8 and 0.3 m clear: add() keeps them.
  const pieces = geo.setPieces || [];
  const made = [];
  for (const sp of pieces) {
    const L = SET_LINES[sp.id]; if (!L) continue;
    const mv = pieceMoves(sp).filter((m) => m.gate);
    if (!mv.length) { report.push(`  (set piece ${sp.id}: no gates, no line)`); continue; }
    for (const m of mv) {
      if (m.pre) {
        const w = within(dist3(m.pre, m.gate) + 4);
        add(L.name, L.caption, L.pts, m.gate, { pre: [m.pre], within: w, piece: sp.id });
        if (!L.oneWay) add(L.name, L.caption, L.pts, neg(m.pre), { pre: [neg(m.gate)], within: w, piece: sp.id });
      } else add(L.name, L.caption, L.pts, m.gate, { ...(L.oneWay ? {} : { two: true }), piece: sp.id });
    }
    made.push(`${sp.id} (${mv.length})`);
  }
  report.push(`  (set pieces: ${pieces.length ? `${pieces.length} from seoul-dressing.js, lines for ${made.join(', ') || 'none'}` : 'seoul-dressing.js absent or without setPieces: no set-piece lines'})`); }

// ---- [P3-F1 design #2] no gate a vehicle can touch. Phase 2: a bus filled BUS SHELTER's gate 42 % of 240 s and 4 of 4 sim
// flights crashed `by: 'bus'`. Every gate (and pre-gate) below the vehicles' reach is probed against the drawn traffic
// (gateprobe.mjs: seoul-movers.js over this LifeSim, vehicles only) every 0.25 s over 0-600 s, at R_PROBE (the quad's
// 0.12 m + 0.23 m of line error). A touched gate gets its floor raised over the highest roof that touched it (vertical
// gates, keeping >= 55 % of the height), else it is narrowed to its longest untouched run of columns (>= 55 % and
// >= 1.2 m), else its line is dropped; the fixed gates are probed again. tests/movers.mjs checks lines.json at 0.12 m.
const R_PROBE = 0.35, NU = 9;
{ const t0 = Date.now();
  const gs = [], own = [];
  lines.forEach((l, li) => { if (l.carve) return; gs.push(l); own.push([li, -1]); (l.pre || []).forEach((q, pi) => { gs.push(q); own.push([li, pi]); }); });
  const touched = vehicleTouches(lifeSim, gs, { r: R_PROBE, nu: NU });
  const drop = new Set(), fixedIdx = [], fixedG = [];
  const shape = (G) => ({ c: G.c, n: G.n, w: G.w, h: G.h, ...(G.u ? { u: G.u } : {}) });
  for (const x of touched) {
    const G = gs[x.i], [li, pi] = own[x.i], { u, v } = gateBasis(G);
    let F = null;
    if (Math.abs(v[1]) > 0.9) { const bot = G.c[1] - G.h / 2, top = G.c[1] + G.h / 2, nb = x.top + R_PROBE + 0.1;
      if (top - nb >= G.h * 0.55) F = { ...shape(G), c: [G.c[0], r3((nb + top) / 2), G.c[2]], h: r3(top - nb) }; }
    if (!F) { let best = null; for (let a = 0; a < NU; a++) { if (x.cols.has(a)) continue; let b = a; while (b + 1 < NU && !x.cols.has(b + 1)) b++; if (!best || b - a > best[1] - best[0]) best = [a, b]; a = b; }
      if (best) { const f0 = (best[0] + (best[0] > 0 ? 0.5 : 0)) / NU, f1 = (best[1] + (best[1] < NU - 1 ? 0.5 : 1)) / NU, w = (f1 - f0) * G.w, off = ((f0 + f1) / 2 - 0.5) * G.w;
        if (w >= Math.max(1.2, G.w * 0.55)) F = { ...shape(G), c: G.c.map((cv, k) => r3(cv + u[k] * off)), w: r3(w) }; } }
    report.push(`  (vehicles: ${lines[li].name} ${pi < 0 ? 'gate' : 'pre-gate'} touched ${x.n}x by ${x.type} (roof ${x.top} m, first at ${x.t0} s): ${F ? `now ${F.w} x ${F.h} m at y ${(F.c[1] - F.h / 2).toFixed(2)}-${(F.c[1] + F.h / 2).toFixed(2)}` : 'line dropped'})`);
    if (F) { fixedIdx.push(x.i); fixedG.push(F); } else drop.add(li);
  }
  if (fixedG.length) for (const x of vehicleTouches(lifeSim, fixedG, { r: R_PROBE, nu: NU })) { const [li] = own[fixedIdx[x.i]]; drop.add(li); report.push(`  (vehicles: ${lines[li].name} still touched after the fix: line dropped)`); }
  fixedIdx.forEach((gi, k) => { const [li, pi] = own[gi]; if (drop.has(li)) return; const l = lines[li], F = fixedG[k];
    if (pi < 0) Object.assign(l, { c: F.c, w: F.w, h: F.h }); else l.pre[pi] = F; });
  const gone = new Set([...drop].map((li) => lines[li].name));
  for (const li of [...drop].sort((a, b) => b - a)) lines.splice(li, 1);
  for (const nm of gone) if (!lines.some((l) => l.name === nm)) report.push(`  (vehicles: ${nm} has no gate left a vehicle can't touch: no line until the traffic keeps out (G1))`);
  report.push(`  (vehicles: ${gs.length} gates probed over 600 s in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${touched.length} touched)`); }

// ---- [P3-F1 UX #2] one source for line copy: every named line carries `hint` (the LINES grid and the pause menu read it;
// F2 builds levels.json lineNames from lines.json). Measured here, so a hint can't go stale (phase 2: "the 1.15 m slot" of a
// 1.29 m gate). Plain ASCII + the UI's middle dot: the menu font is subset to the hangul the UI already shows.
{ const L1 = (nm) => lines.find((l) => l.name === nm && !l.micro);
  const sp = (id) => (geo.setPieces || []).find((p) => p.id === id);
  const HINTS = {
    'WALKING STREET': () => `the walking street end to end, ${Math.round(WL / 10) * 10} m over the crowd`,
    'RED ROAD': () => 'the Red Road fork · under the blades, over the queue',
    'BAR ALLEY': () => 'Wausan-ro 21-gil · under the service drops',
    'CLUB STREET': () => 'Wausan-ro 19-gil · past the club doors',
    'HONGIK-RO': () => 'down the main road · over the buses',
    'CROSSING': (l) => (l.pre ? 'across Yanghwa-ro · under the signal mast' : 'across Yanghwa-ro at exit 9 · over the buses'),
    'SCREEN CANYON': (l) => `Yanghwa-ro between the screens · ${l.w.toFixed(0)} m gates`,
    'THE GAP': (l) => `the ${l.w.toFixed(2)} m slot between two buildings`,
    'CABLE LATTICE': () => 'Hongik-ro 3-gil · under the cable lattice',
    'NARROW ALLEY': (l) => `an alley ${l.w.toFixed(1)} m wide · walls both sides`,
    'SCREEN PASS': () => 'along the face of the 14 x 16 m screen',
    'SIGN STACK': (l) => `climb the sign stack to the roof · ${Math.round(l.c[1])} m`,
    'ROOF DROP': (l) => `off the roofs into a ${l.w.toFixed(1)} m alley`,
    'ROOFLINE': (l) => (l.pre && l.w < 8 ? 'along the roofs · between the tanks' : 'along the roofline · over the tanks'),
    'STATION STAIRS': () => `down exit ${sp('station-stairs')?.exit || 9}'s stairs to the landing`,
    'UNDER THE STAGE': () => 'under the busking canopy · over the crowd',
    'BUS SHELTER': () => "under the median shelter's roof",
    'CABLE THREAD': () => 'thread the low drops on Hongik-ro 3-gil',
    'ROOF SLOT': (l) => `the ${(sp('roofline-slot')?.gates?.gate?.w ?? l.w).toFixed(1)} m slot between a stair house and a tank`,
  };
  for (const nm of new Set(lines.filter((l) => !l.micro).map((l) => l.name))) {
    const f = HINTS[nm], txt = f ? f(L1(nm)) : null;
    if (!txt) { report.push(`  (hint: no copy for ${nm})`); continue; }
    for (const l of lines) if (l.name === nm) l.hint = txt;
  } }

// ---- start points: each on a line's approach, hovering; [P2-F1 UX #5] every one with a hint (the READY tag) and `next`
// (the OSD arrow's line from there). The walking street's at 3.2 m: level flight passes UNDER THE BLADES 15 m ahead.
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
const st = (name, s, pts, y, back = 8) => { const p = at(pts, s), sgn = s < 0 ? -1 : 1; return { name, pos: [r3(p.x - p.tx * back * sgn), y, r3(p.z - p.tz * back * sgn)], yaw: r3(yawTo(p.tx * sgn, p.tz * sgn)) }; };
const hint = (text, line) => ({ hint: { text, line, until: 2, next: line } });
const SC = lines.find((l) => l.name === 'SCREEN CANYON');
const startPoints = [
  { ...st('Walking street', 15, WP, 3.2), ...hint('FLY THE WALKING STREET · OVER THE HEADS', 'WALKING STREET') },
  { ...st('Bar alley', 12, club.points, 3.2), ...hint('DOWN THE BAR ALLEY · UNDER THE DROPS', 'BAR ALLEY') },
  { name: 'Exit 9', pos: SC.pre[0].c.map((v, i) => i === 1 ? r3(v) : r3(v - SC.pre[0].n[i] * 10)), yaw: r3(yawTo(SC.n[0], SC.n[2])), ...hint('DOWN THE SCREEN CANYON · ABOVE THE BUSES', 'SCREEN CANYON') },
  { ...st('Hongik-ro', 10, hong.points, 6.5), ...hint('DOWN HONGIK-RO · OVER THE TRAFFIC', 'HONGIK-RO') },
  (() => { const R0 = lines.find((l) => l.name === 'ROOFLINE' && l.pre), A = R0.pre[0], n = R0.w < 8 ? A.n : [R0.c[0] - A.c[0], 0, R0.c[2] - A.c[2]], nl = Math.hypot(n[0], n[2]);
    return { name: 'Rooftops', pos: [r3(A.c[0] - n[0] / nl * 8), r3(A.c[1]), r3(A.c[2] - n[2] / nl * 8)], yaw: r3(yawTo(n[0], n[2])), ...hint('ALONG THE ROOFLINE · BETWEEN THE TANKS', 'ROOFLINE') }; })(),
  { ...st('Red Road', 15, red.points, 3.2), ...hint('FLY THE RED ROAD · UNDER THE BLADES', 'RED ROAD') },
];
// [P3-F1] every start point >= 1.0 m from the collider (test-seoul asks 0.8): else slide it along its heading (toward its
// line) in 1 m steps, up to 10 m
for (const sp of startPoints) {
  const fx = -Math.sin(sp.yaw), fz = -Math.cos(sp.yaw), P = new THREE.Vector3();
  let k = 0; for (; k <= 10; k++) { P.set(sp.pos[0] + fx * k, sp.pos[1], sp.pos[2] + fz * k); const q = bvh.closestPointToPoint(P, cp, 0, 1.0); if (!q || q.distance >= 1.0) break; }
  if (k > 10) { report.push(`  (start ${sp.name}: no clear hover within 10 m)`); continue; }
  if (k) { sp.pos = [r3(P.x), sp.pos[1], r3(P.z)]; report.push(`  (start ${sp.name}: moved ${k} m ahead, clear of the geometry)`); }
}
// ---- [P2-F1 design #1] the level's take tuning, merged over take.js TAKE_TUNING (bando keeps its own). Stars fitted from
// noisy-pilot sims (seoul/tools/take-sim.mjs, movers on; clean bots, so a little under their numbers): the walking street
// alone + CUT 25k (1 star at 18k), the walking street / Hongik-ro / bar alley loop 51-112k (2 at 60k), six lines and 23
// micros chained 164-190k, or 54-78k with a bank (3 at 150k). The chain is held while a line is armed (UX #2), micros add
// no FLOW (FLOW counts lines: x4-6 on a long take), the bank timer covers a 50-100 m transit between streets, the hold
// zone is 1.5 m (6-10 m streets), PACE is scaled to a 1 km map, and the first-line guide only works near the spawn (design #4).
const tuning = { stars: [18000, 60000, 150000], bankT: 10.0, holdZone: 1.5, armHold: true, firstR: 60, pace: [120, 300, 1.5], microFlow: 0 };
// a copy on the `first` line for world loaders that pass lines[] only (take.js reads either)
const firstLine = lines.find((l) => l.first); if (firstLine) firstLine.tuning = tuning;
const out = { version: 2, level: 'seoul-hongdae', generated: 'seoul/tools/lines.mjs from layout.json + buildSeoulGeometry', tuning, lines, funnels, startPoints,
  takeStart: { pos: startPoints[0].pos, yaw: startPoints[0].yaw, hint: startPoints[0].hint } };
fs.writeFileSync(new URL('lines.json', ROOT), JSON.stringify(out, null, 1));
console.log(report.join('\n'));
const nm = (f) => new Set(lines.filter(f).map((l) => l.name)).size;
console.log(`lines ${lines.length} entries, ${nm(() => true)} named (${nm((l) => !l.micro)} lines + ${nm((l) => l.micro)} micro: ${nm((l) => l.seg)} segments, ${nm((l) => l.feature)} feature), funnels ${funnels.length}`);
