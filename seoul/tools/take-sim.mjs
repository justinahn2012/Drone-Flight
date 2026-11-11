// seoul/tools/take-sim.mjs — noisy-pilot takes through the Hongdae lines, scored by take.js with the level's tuning
// (stream F1, design #1: "stars from noisy-pilot sims"). Node only, ~1-3 min:
//   node seoul/tools/take-sim.mjs [--runs N] [--route short|loop|long|...|all, or a,b,c] [--json out.json] [--no-movers]
//   env: PILOT=careful,regular  TL=1 (per-run timelines)  NOPIECES=1 (no set pieces)  NOWALKERS=1
// [P3-F1] set-piece routes ('from' starts a route 14 m before a line's first gate), walkers, per-run timelines.
// A Cine autopilot (pure pursuit over a 3D A* route at 1 m, 0.9 m clearance) flies each route through the gates in order,
// with a pilot's cruise speed, OU thumb noise on every stick and a line choice inside each gate; buses, taxis and people
// are on (world.movers via seoul-movers.js, the drawn sim's seed). Each take ends in a CUT (3 s hands off) or a crash.
// Prints per pilot x route: total (p25 / p50 / p75), stars, lines, banks, caption gaps, first reward after spawn.
import fs from 'node:fs';
import * as THREE from 'three';
import { buildSeoulGeometry } from '../../world-seoul.js';
import { Drone } from '../../flight.js';
import { Take, starsFor, mergeTuning } from '../../take.js';
import { Rng } from '../../rng.js';

const ROOT = new URL('../', import.meta.url);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const RUNS = +arg('--runs', 6), ROUTE = arg('--route', 'all'), OUT = arg('--json', null), MOVERS = !process.argv.includes('--no-movers');
const layout = JSON.parse(fs.readFileSync(new URL('layout.json', ROOT), 'utf8'));
const lineData = JSON.parse(fs.readFileSync(new URL('lines.json', ROOT), 'utf8'));
const geo = buildSeoulGeometry(layout, { lineData });
const { bvh } = geo; const cp = {};
const V = (a) => new THREE.Vector3(...a);
const clr = (p, m = 3) => { const q = bvh.closestPointToPoint(p, cp, 0, m); return q ? q.distance : m; };
const tuning = mergeTuning(lineData.tuning);

let movers = null;
if (MOVERS) {
  try {
    const { LifeSim } = await import('../../seoul-life.js'), { lifeMovers } = await import('../../seoul-movers.js');
    const sim = new LifeSim(layout, { seed: 11, density: 1, maxAgents: 2400, setPieces: geo.setPieces || [], obstacles: geo.dressingOut?.obstacles || null });   // [integ8] as world-seoul builds it
    // [P3-F1] walkers too (the panel: "take-sim has no walkers"): seoul-life's soft people colliders, at the take clock
    // + the drawn city's 75 s warm start, as world-seoul's build() serves them to the game (colliders.people)
    movers = lifeMovers({ sim, colliders: process.env.NOWALKERS ? {} : { people: (p, r, t) => sim.hitPeople(p, r, t + 75) } });
  } catch (e) { console.log('movers off:', e.message); }
}
const world = { bvh, lastDist: Infinity, funnels: geo.funnels, envelope: { min: new THREE.Vector3(-300, -2, -600), max: new THREE.Vector3(400, 160, 400) },
  lines: geo.lines, skimBvh: geo.skimBvh, tuning: lineData.tuning, setPieces: process.env.NOPIECES ? null : geo.setPieces, takeStart: { pos: V(lineData.takeStart.pos), yaw: lineData.takeStart.yaw }, movers };

// ---- 3D voxel A* (1 m), occupancy cached, clearance RC
const RC = 0.9, Y0 = 1, NY = 34; const occ = new Map();
const key = (i, j, k) => (i + 400) * 2e6 + (j + 700) * 1000 + k;
const blocked = (i, j, k) => { if (k < 0 || k >= NY) return true; const K = key(i, j, k); let o = occ.get(K); if (o === undefined) { o = clr(new THREE.Vector3(i, Y0 + k, j), RC + 0.01) < RC; occ.set(K, o); } return o; };
function astar3(a, b) {
  const s = [Math.round(a.x), Math.round(a.z), Math.round(a.y - Y0)], t = [Math.round(b.x), Math.round(b.z), Math.round(b.y - Y0)];
  const sk = key(...s), tk = key(...t);
  const g = new Map([[sk, 0]]), from = new Map(), open = [[0, sk, s]];
  const h = (p) => Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
  const push = (e) => { open.push(e); let i = open.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (open[q][0] <= open[i][0]) break; [open[q], open[i]] = [open[i], open[q]]; i = q; } };
  const pop = () => { const top = open[0], last = open.pop(); if (open.length) { open[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < open.length && open[l][0] < open[m][0]) m = l; if (r < open.length && open[r][0] < open[m][0]) m = r; if (m === i) break; [open[m], open[i]] = [open[i], open[m]]; i = m; } } return top; };
  const N = []; for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) for (const dy of [-1, 0, 1]) if (dx || dz || dy) N.push([dx, dz, dy, Math.hypot(dx, dz, dy) + (dy ? 0.3 : 0)]);
  let it = 0, found = false;
  while (open.length && it++ < 2e6) {
    const [, k, p] = pop(); if (k === tk) { found = true; break; }
    for (const [dx, dz, dy, c] of N) { const q = [p[0] + dx, p[1] + dz, p[2] + dy]; const qk = key(...q); if (blocked(...q) && qk !== tk) continue; const ng = g.get(k) + c; if (ng < (g.get(qk) ?? Infinity)) { g.set(qk, ng); from.set(qk, [k, p]); push([ng + h(q), qk, q]); } }
  }
  if (!found) return null;
  const P = [t]; let k = tk; while (from.has(k)) { const [pk, pp] = from.get(k); P.push(pp); k = pk; }
  return P.reverse().map(([x, z, y]) => new THREE.Vector3(x, y + Y0, z));
}
const losClear = (a, b) => { const n = Math.ceil(a.distanceTo(b) / 0.4); for (let i = 0; i <= n; i++) if (clr(a.clone().lerp(b, i / Math.max(1, n)), RC) < RC - 0.2) return false; return true; };
function simplify(P) { if (P.length < 3) return P; const o = [P[0]]; let i = 0; while (i < P.length - 1) { let j = Math.min(P.length - 1, i + 60); while (j > i + 1 && !losClear(P[i], P[j])) j--; o.push(P[j]); i = j; } return o; }

// ---- routes: ordered gates. A street run = its pre-gate, then every segment / feature gate of that run sorted by distance
// from the pre-gate, then its gate (direction k of the named line). Other lines: their pre (if any) then main.
const entries = (name) => geo.lines.filter((l) => l.name === name && !l.carve);
const along = (G, d) => V(G.c).addScaledVector(V(G.n).normalize(), d);
function streetGates(name, k = 0) {
  const e = entries(name)[k]; if (!e) return null;
  const A = e.pre[0], dir = V(e.c).sub(V(A.c)).normalize();
  const gs = [];
  for (const l of geo.lines) {
    if (l.carve || l.name === name || (l.seg !== name && l.on !== name)) continue;
    if (l.seg && V(l.n).dot(dir) <= 0) continue;          // segments: this direction's entries only
    gs.push(l);
  }
  const uniq = new Map(); for (const l of gs) { const kk = l.c.map((v) => v.toFixed(1)).join(); if (!uniq.has(kk)) uniq.set(kk, l); }
  const mids = [...uniq.values()].filter((l) => V(l.c).distanceTo(V(e.c)) > 2 && V(l.c).distanceTo(V(A.c)) > 2).sort((a, b) => V(a.c).distanceTo(V(A.c)) - V(b.c).distanceTo(V(A.c)));
  return [A, ...mids, e];
}
const lineGates = (name, k = 0) => { const e = entries(name)[k]; return e ? [...(e.pre || []), e] : null; };
const ROUTES = {
  short: [['street', 'WALKING STREET', 0]],
  // [P3-F1] through the transit connectors (TO THE BAR ALLEY n): a pilot follows the street between the two lines
  loop: [['street', 'WALKING STREET', 0], ['street', 'HONGIK-RO', 0], ['line', 'TO THE BAR ALLEY 1', 0], ['line', 'INTO THE BAR ALLEY 1', 0], ['street', 'BAR ALLEY', 0]],   // [P4-E] + INTO THE BAR ALLEY
  stairs: [['from', 'STATION STAIRS', 0, 14], ['line', 'STATION STAIRS', 0]],
  stage0: [['from', 'UNDER THE STAGE', 0, 14], ['line', 'UNDER THE STAGE', 0]],
  stage1: [['from', 'UNDER THE STAGE', 1, 14], ['line', 'UNDER THE STAGE', 1]],
  thread0: [['from', 'CABLE THREAD', 0, 14], ['line', 'CABLE THREAD', 0]],
  thread1: [['from', 'CABLE THREAD', 1, 14], ['line', 'CABLE THREAD', 1]],
  shelter0: [['from', 'BUS SHELTER', 0, 14], ['line', 'BUS SHELTER', 0]],
  shelter2: [['from', 'BUS SHELTER', 2, 14], ['line', 'BUS SHELTER', 2]],
  slot0: [['from', 'ROOF SLOT', 0, 14], ['line', 'ROOF SLOT', 0]],
  gap: [['from', 'THE GAP', 0, 14], ['line', 'THE GAP', 0]],
  canyon: [['from', 'SCREEN CANYON', 0, 14], ['street', 'SCREEN CANYON', 0]],
  // [P3-F1] the re-cut lines
  red: [['from', 'RED ROAD', 0, 14], ['street', 'RED ROAD', 0]],
  crossing: [['from', 'CROSSING', 0, 6], ['line', 'CROSSING', 0]],
  crossing1: [['from', 'CROSSING', 1, 6], ['line', 'CROSSING', 1]],
  queue: [['from', 'OVER THE QUEUE', 0, 10], ['line', 'OVER THE QUEUE', 0]],
  door: [['from', 'DOOR QUEUE', 0, 10], ['line', 'DOOR QUEUE', 0]],
  roofline: [['from', 'ROOFLINE', 0, 14], ['street', 'ROOFLINE', 0], ['line', 'ROOF SLOT', 0]],
  hub: [['street', 'WALKING STREET', 0], ['street', 'RED ROAD', 1]],
  sig: [['street', 'WALKING STREET', 0], ['line', 'UNDER THE STAGE', 1], ['line', 'CABLE THREAD', 0], ['street', 'BAR ALLEY', 0], ['line', 'THE GAP', 0], ['street', 'HONGIK-RO', 0], ['line', 'SCREEN CANYON', 0], ['line', 'BUS SHELTER', 0], ['line', 'STATION STAIRS', 0]],
  // [P4-E design #5] through the new connectors (TO THE CABLE LATTICE / TO THE FORK / TO THE SIGN STACK n), as the hint's via leads
  long: [['street', 'WALKING STREET', 0], ['street', 'HONGIK-RO', 0], ['line', 'TO THE BAR ALLEY 1', 0], ['line', 'INTO THE BAR ALLEY 1', 0], ['street', 'BAR ALLEY', 0], ['line', 'TO THE CABLE LATTICE 1', 0], ['street', 'CABLE LATTICE', 0],
    ['line', 'TO THE FORK 1', 0], ['line', 'TO THE SIGN STACK 1', 0], ['line', 'TO THE SIGN STACK 2', 0], ['line', 'SIGN STACK', 0], ['line', 'TO THE ROOFLINE 1', 0], ['street', 'ROOFLINE', 1]],
};
// a pilot: cruise m/s, thumb noise (stick OU sigma), line choice spread (share of the gate half-size), reaction lookahead m
const PILOTS = {
  careful: { v: 5.0, noise: 0.10, spread: 0.30, look: 3.0 },
  regular: { v: 7.5, noise: 0.16, spread: 0.40, look: 3.5 },
  sharp:   { v: 10.0, noise: 0.12, spread: 0.35, look: 4.5 },
};

function buildPath(route, rng, spread) {
  const ts = world.takeStart; let path = [ts.pos.clone()];
  if (route[0][0] === 'from') { const [, nm, kk, back] = route[0]; const g = lineGates(nm, kk)[0]; const n = V(g.n).setY(0).normalize(); const p0 = V(g.c).addScaledVector(n, -back); if (p0.y < 2) p0.y = 2.2; path = [p0]; route = route.slice(1); }
  for (const [kind, name, k] of route) {
    const gates = kind === 'street' ? streetGates(name, k) : lineGates(name, k);
    if (!gates) { console.log('no line', name, '(skipped)'); continue; }
    for (let gi = 0; gi < gates.length; gi++) {
      const G = gates[gi], n = V(G.n).normalize();
      const u = G.u ? V(G.u) : new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n); u.addScaledVector(n, -u.dot(n)).normalize();
      const v = new THREE.Vector3().crossVectors(n, u);
      const off = u.clone().multiplyScalar((rng.next() - 0.5) * G.w * spread).addScaledVector(v, (rng.next() - 0.5) * G.h * spread);
      const a = along(G, -2.5).add(off), b = along(G, 2.5).add(off);
      const last = path[path.length - 1];
      let leg = losClear(last, a) ? [last, a] : astar3(last, a), bb = b;
      if (!leg) { const a0 = along(G, -2.5); bb = along(G, 2.5); leg = losClear(last, a0) ? [last, a0] : astar3(last, a0); }   // the gate centre instead
      if (!leg) { console.log('NO LEG to', name, gi, a.toArray().map((x) => x.toFixed(1)), '(gate skipped: the 1 m A* found no 0.9 m-clear path)'); continue; }
      path.push(...simplify(leg).slice(1), bb);
    }
  }
  return path;
}

function fly(path, P, rng) {
  const dr = new Drone('freestyle5'); let crashed = false; dr.onCrash = () => { crashed = true; };
  { const d0 = path[1].clone().sub(path[0]); dr.reset(path[0].clone(), Math.atan2(-d0.x, -d0.z)); }
  const tk = new Take(), evs = [], DT = 1 / 240; let seg = 0, t = 0, stuck = 0, lastP = dr.pos.clone();
  const ou = { p: 0, r: 0, c: 0 }, vC = P.v * (0.9 + 0.2 * rng.next());
  while (t < 600) {
    const p = dr.pos; let tgt = null, k = seg;
    while (k < path.length - 1) { const a = path[k], b = path[k + 1], ab = b.clone().sub(a), Lg = ab.length() || 1e-6; const s = Math.max(0, Math.min(Lg, p.clone().sub(a).dot(ab) / Lg));
      if (Lg - s < P.look && k < path.length - 2) { k++; continue; } tgt = a.clone().addScaledVector(ab, Math.min(1, (s + P.look) / Lg)); break; }
    seg = Math.min(k, path.length - 2); if (!tgt) tgt = path[path.length - 1].clone();
    if (seg === path.length - 2 && p.distanceTo(path[path.length - 1]) < 1.2) break;
    for (const q in ou) ou[q] += -ou[q] * 1.5 * DT + P.noise * Math.sqrt(3 * DT) * (rng.next() * 2 - 1) * 1.7;
    const dx = tgt.x - p.x, dz = tgt.z - p.z, dh = Math.hypot(dx, dz);
    const hDes = Math.atan2(-dx, -dz), e = dh < 0.6 ? 0 : Math.atan2(Math.sin(hDes - dr.heading), Math.cos(hDes - dr.heading));
    let turn = 0; if (seg < path.length - 2) { const a = path[seg + 1].clone().sub(path[seg]).setY(0), b = path[seg + 2].clone().sub(path[seg + 1]).setY(0); if (a.length() > 0.1 && b.length() > 0.1) turn = a.angleTo(b); if (p.distanceTo(path[seg + 1]) > 12) turn = 0; }
    const steep = dh < 1.5 ? 1 : 0;
    const vWant = steep ? 0 : vC * Math.max(0.3, Math.cos(Math.min(Math.PI / 2, Math.abs(e) * 1.5))) * (1 - 0.6 * Math.min(1, turn / 1.6));
    const pitch = Math.max(-1, Math.min(1, vWant / 18 + ou.p * 0.3));
    const roll = Math.max(-1, Math.min(1, -e * 2.2 + ou.r));
    const climb = Math.max(-1, Math.min(1, (tgt.y - p.y) * 0.7 - dr.vel.y * 0.12 + ou.c * 0.5));
    dr.step(DT, { thr: 0.4, pitch, roll, yaw: 0, climb }, 'cine', world); t += DT;
    for (const e2 of tk.update(DT, dr, world, { hands: true, moved: true, steer: true })) evs.push({ ...e2, at: t });
    if (crashed) break;
    if ((Math.round(t * 240) % 480) === 0) { if (dr.pos.distanceTo(lastP) < 0.5) stuck++; else stuck = 0; lastP = dr.pos.clone(); if (stuck > 3) break; }
  }
  for (let i = 0; i < 240 * 12 && !crashed && tk.state !== 'done'; i++) { dr.step(DT, { thr: 0.4, pitch: 0, roll: 0, yaw: 0, climb: 0 }, 'cine', world); t += DT; for (const e2 of tk.update(DT, dr, world, { hands: false, moved: false, steer: false })) evs.push({ ...e2, at: t }); }
  const caps = evs.filter((e) => e.type === 'line' || e.type === 'repeat').map((e) => e.at), gaps = caps.slice(1).map((c, i) => c - caps[i]);
  const start = evs.find((e) => e.type === 'start')?.at ?? 0;
  return { total: tk.total, stars: starsFor(tk.total, tuning.stars), crashed, by: evs.find((e) => e.type === 'crash')?.by || null, t: +t.toFixed(1),
    lines: evs.filter((e) => e.type === 'line' && !e.micro).length, micros: evs.filter((e) => e.type === 'line' && e.micro).length, banks: evs.filter((e) => e.type === 'bank' && !e.cut).length,
    scrapes: evs.filter((e) => e.type === 'scrape').length, heads: evs.filter((e) => e.heads).length, maxFlow: tk.stats.maxFlow,
    first: caps.length ? +(caps[0] - start).toFixed(1) : null, gapMean: gaps.length ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : null, gapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null,
    names: evs.filter((e) => e.type === 'line').map((e) => e.name), tl: evs.filter((e)=>['line','repeat','bank','scrape','crash','cut'].includes(e.type)).map((e)=>`${e.at.toFixed(1)} ${e.type} ${e.name||''}${e.by?' by '+e.by:''}${e.heads?' HEADS':''} +${e.pts||0} x${e.flow||''}`) };
}

const q = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : null; };
const results = {};
const routes = ROUTE === 'all' ? Object.keys(ROUTES) : ROUTE.split(',');
const T0 = performance.now();
for (const rn of routes) for (const [pn, P] of Object.entries(PILOTS).filter(([k]) => !process.env.PILOT || process.env.PILOT.split(',').includes(k))) {
  const R = []; const rng = new Rng(1000 + rn.length * 31 + pn.length * 7);
  for (let i = 0; i < RUNS; i++) { const path = buildPath(ROUTES[rn], rng, P.spread); if (!path) break; R.push(fly(path, P, rng)); }
  const tot = R.map((r) => r.total);
  results[`${rn}/${pn}`] = { runs: R.length, p25: q(tot, 0.25), p50: q(tot, 0.5), p75: q(tot, 0.75), crash: R.filter((r) => r.crashed).length, by: R.map((r) => r.by).filter(Boolean),
    stars: R.map((r) => r.stars), lines: q(R.map((r) => r.lines), 0.5), micros: q(R.map((r) => r.micros), 0.5), banks: q(R.map((r) => r.banks), 0.5), scrapes: q(R.map((r) => r.scrapes), 0.5),
    heads: R.reduce((a, r) => a + r.heads, 0), first: q(R.map((r) => r.first ?? 99), 0.5), gapMean: q(R.map((r) => r.gapMean ?? 99), 0.5), gapMax: q(R.map((r) => r.gapMax ?? 99), 0.5), t: q(R.map((r) => r.t), 0.5), maxFlow: q(R.map((r) => r.maxFlow), 0.5) };
  console.log(`${rn.padEnd(5)} ${pn.padEnd(8)} ${JSON.stringify(results[`${rn}/${pn}`])}`); if (process.env.TL) for (const r of R) console.log('   ', r.total, r.stars, r.crashed?'CRASH '+r.by:'', '|', r.tl.join(' ; '));
}
console.log(`stars ${JSON.stringify(tuning.stars)} | ${((performance.now() - T0) / 1000).toFixed(0)} s`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ tuning, results }, null, 1));
