// seoul/tools/take-sim.mjs — noisy-pilot takes through the Hongdae lines, scored by take.js with the level's tuning
// (stream F1, design #1: "stars from noisy-pilot sims"). Node only, ~1-3 min:
//   node seoul/tools/take-sim.mjs [--runs N] [--route short|loop|long|...|all, or a,b,c] [--json out.json] [--no-movers] [--no-dive] [--record [--merge]]
// [P7-F] --record alone runs the record's set (REC_ROUTES: every set-piece line, stairs-nodive at 12 runs); --merge adds the
// given routes to a record of the same lines.json; a NO PATH route is logged as DROPPED and kept in the record's `dropped`
// (tests/take.mjs fails on it); --no-dive (and route stairs-nodive) flies without phase 6's dive model; a 'from' start in a
// dead end steps in toward the gate (stage1). The long route flies TO THE ROOFLINE 2.
//   env: PILOT=careful,regular  TL=1 (per-run timelines)  NOPIECES=1 (no set pieces)  NOWALKERS=1
// [P3-F1] set-piece routes ('from' starts a route 14 m before a line's first gate), walkers, per-run timelines.
// [P4-F1] the game's crowd (LIFE.maxAgents; env LIFE_Q=low: the low preset's half, design #2); the A* reaches 4 m below the
// street (down the stair dive) over a heightfield floor: the street at 0, E's stairwell openings (dressing holes) open
// (design #1); routes open UNDER THE STAGE into the walking street (design #4); prints FAST lines and the first x2.
// [P6-F] LifeSim gets E's stairwell `holes` (as world-seoul builds it: G1 keeps walkers out of exit 9's mouth); design #2 / #4: 8 runs (the record), the opening's outer pre-gate flown first, an A* that keeps over the heads (LOWY);
// the record keeps `by` (what crashed a run) and `heads`.
// [P5-F] design #1: the take opens at the junction (lines.json takeStart), UNDER THE STAGE (its `first` entry, out of the
// junction) then the walking street out to its SE end; longer routes fly it back (entry 1) to the junction. design #6:
// the air portals (pop, pass); an unknown route or line name throws a readable error (phase 4: buildPath crashed on
// `lineGates(...)` undefined).
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
import { lifeAgents } from './gateprobe.mjs';

const ROOT = new URL('../', import.meta.url);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const RUNS = +arg('--runs', 6), OUT = arg('--json', null), MOVERS = !process.argv.includes('--no-movers'), NODIVE = process.argv.includes('--no-dive');
// [P7-F design #6] the record's route set (every set-piece line, the stair dive also without the dive model): --record with no
// --route runs it
const REC_ROUTES = 'short,walk,loop,long,hongik,hub,stairs,stairs-nodive,pop,pass,stage0,stage1,thread0,thread1,shelter0,shelter2,slot0,gap';
const ROUTE = arg('--route', process.argv.includes('--record') ? REC_ROUTES : 'all');
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
    const sim = new LifeSim(layout, { seed: 11, density: 1, maxAgents: lifeAgents(), setPieces: geo.setPieces || [], obstacles: geo.dressingOut?.obstacles || null, holes: geo.dressingOut?.holes || null, puddles: geo.dressingOut?.puddles || null });   // [integ8] as world-seoul builds it; [P4-F1] at the game's crowd
    // [P3-F1] walkers too (the panel: "take-sim has no walkers"): seoul-life's soft people colliders, at the take clock
    // + the drawn city's 75 s warm start, as world-seoul's build() serves them to the game (colliders.people)
    movers = lifeMovers({ sim, colliders: process.env.NOWALKERS ? {} : { people: (p, r, t) => sim.hitPeople(p, r, t + 75) } });
  } catch (e) { console.log('movers off:', e.message); }
}
const world = { bvh, lastDist: Infinity, funnels: geo.funnels, envelope: { min: new THREE.Vector3(-300, -2, -600), max: new THREE.Vector3(400, 160, 400) },
  lines: geo.lines, skimBvh: geo.skimBvh, tuning: lineData.tuning, setPieces: process.env.NOPIECES ? null : geo.setPieces, takeStart: { pos: V(lineData.takeStart.pos), yaw: lineData.takeStart.yaw }, movers };

// ---- 3D voxel A* (1 m), occupancy cached, clearance RC
// [P4-F1 design #1] Y0 -4 (phase 3: 1 m, so the stair dive was "NO LEG") over a heightfield floor: below the street (y < 0)
// a voxel is open only with a floor under it within 6 m (a stairwell's steps or landing: E's openings and the part under
// the slab); under the street there is none (the ground is above it), so the A* never routes through the earth
const RC = 0.9, Y0 = -4, NY = 39;
// [P6-F design #4] a pilot keeps over the heads: an A* step at street level below LOWY m (the crowd, the cars) costs LOWC x
// (phase 5's careful hongik takes dipped to 1.0 m under a sign before DOOR QUEUE and met a car: 3 crashes in 8). Below the
// street (the stair dive) is unaffected.
const LOWY = 1.9, LOWC = +(process.env.LOWC || 4), VLOOK = +(process.env.VLOOK || 0.3), DIVE_LOOK = 6, DIVE_VZ = +(process.env.DIVE_VZ || 0.9); const occ = new Map(), _rd = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
const underground = (x, y, z) => { if (y >= 0) return false; _rd.origin.set(x, y, z); return !bvh.raycastFirst(_rd, THREE.DoubleSide, 0, 6); };
const key = (i, j, k) => (i + 400) * 2e6 + (j + 700) * 1000 + k;
const blocked = (i, j, k) => { if (k < 0 || k >= NY) return true; const K = key(i, j, k); let o = occ.get(K); if (o === undefined) { o = underground(i, Y0 + k, j) || clr(new THREE.Vector3(i, Y0 + k, j), RC + 0.01) < RC; occ.set(K, o); } return o; };
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
    for (const [dx, dz, dy, c] of N) { const q = [p[0] + dx, p[1] + dz, p[2] + dy]; const qk = key(...q); if (blocked(...q) && qk !== tk) continue; const ng = g.get(k) + c * (q[2] + Y0 >= 0 && q[2] + Y0 < LOWY ? LOWC : 1); if (ng < (g.get(qk) ?? Infinity)) { g.set(qk, ng); from.set(qk, [k, p]); push([ng + h(q), qk, q]); } }
  }
  if (!found) return null;
  const P = [t]; let k = tk; while (from.has(k)) { const [pk, pp] = from.get(k); P.push(pp); k = pk; }
  return P.reverse().map(([x, z, y]) => new THREE.Vector3(x, y + Y0, z));
}
const _rs = new THREE.Ray();
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
    if (V(l.c).sub(V(A.c)).dot(dir) < 0) continue;       // [P4-F1] a feature behind the start gate (OVER THE CROWD, before the stage)
    gs.push(l);
  }
  const uniq = new Map(); for (const l of gs) { const kk = l.c.map((v) => v.toFixed(1)).join(); if (!uniq.has(kk)) uniq.set(kk, l); }
  const mids = [...uniq.values()].filter((l) => V(l.c).distanceTo(V(e.c)) > 2 && V(l.c).distanceTo(V(A.c)) > 2).sort((a, b) => V(a.c).distanceTo(V(A.c)) - V(b.c).distanceTo(V(A.c)));
  return [A, ...mids, e];
}
// k: the entry index, or 'first' (the entry flagged `first`: UNDER THE STAGE toward the hub)
const pickEntry = (name, k) => { const E = entries(name); return k === 'first' ? E.find((l) => l.first) || E[0] : E[k]; };
// [P6-F] a line with several pre-gates (UNDER THE STAGE's outer one, 8 m out): the farthest first
const lineGates = (name, k = 0) => { const e = pickEntry(name, k); return e ? [...(e.pre || []).slice().sort((a, b) => V(b.c).distanceTo(V(e.c)) - V(a.c).distanceTo(V(e.c))), e] : null; };
// [P5-F design #1] a take opens UNDER THE STAGE out of the junction (its exit lines up with the walking street's start gate),
// then the street to its SE end; BACK flies it home to the junction (entry 1: repeats, the chain kept)
// (and back under the stage toward the junction: entry 0, a repeat; it splits the 14-16 s run to HONGIK-RO 1/4)
const OPEN = [['line', 'UNDER THE STAGE', 'first']], WALK = [['street', 'WALKING STREET', 0]], BACK = [['street', 'WALKING STREET', 1], ['line', 'UNDER THE STAGE', 0]];
const ROUTES = {
  short: [...OPEN, ...WALK],
  walk: [...WALK],          // [P4-F1] past the stage, straight down the street
  // [P3-F1] through the transit connectors (TO THE BAR ALLEY n): a pilot follows the street between the two lines
  loop: [...OPEN, ...WALK, ...BACK, ['street', 'HONGIK-RO', 0], ['line', 'TO THE BAR ALLEY 1', 0], ['line', 'INTO THE BAR ALLEY 1', 0], ['street', 'BAR ALLEY', 0]],   // [P4-E] + INTO THE BAR ALLEY
  // [P5-F design #5] from the junction straight onto Hongik-ro (its first segment: 30 m)
  hongik: [['street', 'HONGIK-RO', 0], ['line', 'TO THE BAR ALLEY 1', 0], ['line', 'INTO THE BAR ALLEY 1', 0], ['street', 'BAR ALLEY', 0]],
  stairs: [['from', 'STATION STAIRS', 0, 14], ['line', 'STATION STAIRS', 0]],
  // [P7-F design #3] the stair dive flown by phase 5's pilot (no dive model: no slope feed-forward, no dive braking), as a
  // thumb would: tests/take.mjs wants regular >= 8 of 12 (NODIVE_RUNS runs)
  'stairs-nodive': [['from', 'STATION STAIRS', 0, 14], ['line', 'STATION STAIRS', 0]],
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
  hub: [...OPEN, ...WALK, ...BACK, ['line', 'TO THE RED ROAD 1', 0], ['street', 'RED ROAD', 1]],   // [P6-F design #6] + TO THE RED ROAD
  sig: [...OPEN, ...WALK, ...BACK, ['line', 'CABLE THREAD', 0], ['street', 'BAR ALLEY', 0], ['line', 'THE GAP', 0], ['street', 'HONGIK-RO', 0], ['line', 'SCREEN CANYON', 0], ['line', 'BUS SHELTER', 0], ['line', 'STATION STAIRS', 0]],
  // [P4-E design #5] through the new connectors (TO THE CABLE LATTICE / TO THE FORK / TO THE SIGN STACK n), as the hint's via leads
  long: [...OPEN, ...WALK, ...BACK, ['street', 'HONGIK-RO', 0], ['line', 'TO THE BAR ALLEY 1', 0], ['line', 'INTO THE BAR ALLEY 1', 0], ['street', 'BAR ALLEY', 0], ['line', 'TO THE CABLE LATTICE 1', 0], ['street', 'CABLE LATTICE', 0],
    ['line', 'TO THE FORK 1', 0], ['line', 'TO THE SIGN STACK 1', 0], ['line', 'TO THE SIGN STACK 2', 0], ['line', 'SIGN STACK', 0], ['line', 'TO THE ROOFLINE 1', 0],
    ...(entries('TO THE ROOFLINE 2').length ? [['line', 'TO THE ROOFLINE 2', 0]] : []), ['street', 'ROOFLINE', 1]],   // [P7-F design #1] + TO THE ROOFLINE 2, square to the street
  // [P5-F design #6] the air portals: up through PLAYGROUND POP (horizontal: a climb from 4 m under it, 2 m to the side), along
  // the screen face through SCREEN PASS
  pop: [['from', 'PLAYGROUND POP', 0, 2], ['line', 'PLAYGROUND POP', 0]],
  pass: [['from', 'SCREEN PASS', 0, 14], ['line', 'SCREEN PASS', 0]],
};
// [P5-F design #6] a readable error for a route or line that isn't there (phase 4: TypeError in buildPath)
for (const rn of (ROUTE === 'all' ? Object.keys(ROUTES) : ROUTE.split(','))) {
  if (!ROUTES[rn]) throw new Error(`take-sim: no route '${rn}' (routes: ${Object.keys(ROUTES).join(', ')})`);
  for (const [kind, name, k] of ROUTES[rn]) if (!pickEntry(name, k)) throw new Error(`take-sim: route '${rn}' names ${kind} '${name}' entry ${k}, which lines.json doesn't have (${entries(name).length} entries)`);
}
// a pilot: cruise m/s, thumb noise (stick OU sigma), line choice spread (share of the gate half-size), reaction lookahead m
const PILOTS = {
  careful: { v: 5.0, noise: 0.10, spread: 0.30, look: 3.0 },
  regular: { v: 7.5, noise: 0.16, spread: 0.40, look: 3.5 },
  sharp:   { v: 10.0, noise: 0.12, spread: 0.35, look: 4.5 },
};

const NODIVE_ROUTES = new Set(['stairs-nodive']), NODIVE_RUNS = 12;
function buildPath(route, rng, spread, noDive = NODIVE) {
  const ts = world.takeStart; let path = [ts.pos.clone()];
  if (route[0][0] === 'from') { const [, nm, kk, back] = route[0]; const g = lineGates(nm, kk)[0];
    // [P5-F] a horizontal gate (PLAYGROUND POP, n up): start `back` m to the side of it (along u), 4 m under it, at >= 2.2 m
    const horiz = Math.abs(g.n[1]) > 0.9, n = horiz ? V(g.u || [1, 0, 0]).setY(0).normalize() : V(g.n).setY(0).normalize();
    const at = (bk) => { const q = V(g.c).addScaledVector(n, -bk); if (horiz) q.y = Math.max(2.2, g.c[1] - 4 * Math.sign(g.n[1])); if (q.y < 2) q.y = Math.max(2.2, g.c[1]); return q; };
    // [P7-F design #6] a start the A* can leave: phase 6's stage1 started 14 m back from the outer pre-gate, in a shop's open
    // front (walls on 3 sides), every leg failed and the route was dropped (NO PATH). Step in 2 m at a time until the gate's
    // approach is reachable (straight, else the A*).
    let p0 = at(back);
    for (let bk = back; bk >= 4; bk -= 2) { const q = at(bk), a = along(g, -2.5); if (clr(q, RC) < RC) continue; if (losClear(q, a) || astar3(q, a)) { if (bk !== back) console.log(`start ${nm} ${kk}: ${bk} m back, not ${back} (no way out from ${back} m)`); p0 = q; break; } }
    path = [p0]; route = route.slice(1); }
  for (const [kind, name, k] of route) {
    const gates = kind === 'street' ? streetGates(name, k) : lineGates(name, k);
    if (!gates) { console.log('no line', name, '(skipped)'); continue; }
    let carry = null;
    for (let gi = 0; gi < gates.length; gi++) {
      const G = gates[gi], n = V(G.n).normalize();
      const u = G.u ? V(G.u) : new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n); u.addScaledVector(n, -u.dot(n)).normalize();
      const v = new THREE.Vector3().crossVectors(n, u);
      const off = carry || u.clone().multiplyScalar((rng.next() - 0.5) * G.w * spread).addScaledVector(v, (rng.next() - 0.5) * G.h * spread);
      let a = along(G, -2.5).add(off), b = along(G, 2.5).add(off);
      // [P4-F1] a pre-gate -> gate move (a 'line' of two gates) whose straight line is open is flown straight (the stair
      // dive: 27 deg from under the canopy lip to the landing gate), not level out of the pre-gate
      carry = null; let down = false;
      if (kind === 'line' && gi === 0 && gates.length === 2) { const P = V(G.c).add(off), Q = V(gates[1].c).add(off), d = Q.clone().sub(P), L = d.length(); d.normalize();
        _rs.origin.copy(P); _rs.direction.copy(d); if (!bvh.raycastFirst(_rs, THREE.DoubleSide, 0, L) && Math.abs(Q.y - P.y) > 1) { down = Q.y < P.y - 1; b = P.clone().addScaledVector(d, Math.min(1.5, L / 3)); carry = off; } }
      const straight = gi === 1 && path.straight;   // the second gate of a straight move: on along the same line (ray-checked above)
      if (straight) a = V(G.c).add(off).addScaledVector(V(G.c).add(off).sub(path[path.length - 1]).normalize(), -1.0);
      path.straight = carry !== null;
      const last = path[path.length - 1];
      let leg = straight || losClear(last, a) ? [last, a] : astar3(last, a), bb = b;
      if (!leg) { const a0 = along(G, -2.5); bb = along(G, 2.5); leg = losClear(last, a0) ? [last, a0] : astar3(last, a0); }   // the gate centre instead
      if (!leg) { console.log('NO LEG to', name, gi, a.toArray().map((x) => x.toFixed(1)), '(gate skipped: the 1 m A* found no 0.9 m-clear path)'); continue; }
      // [P6-F] a straight move's first gate: through its centre (+ the line offset) before turning down the move (the level
      // approach to bb cut the corner: the stair dive's pre-gate was crossed 0.1-0.4 m under its 2.0 m floor)
      const k0 = path.length - 1;
      path.push(...simplify(leg).slice(1), ...(carry && down && bb === b ? [V(G.c).add(off)] : []), bb);
      // [P6-F] the segments of a straight dive (down: the stair dive), its approach included: flown with the dive model in fly()
      // (a climb, SIGN STACK, keeps phase 5's pilot)
      if (gi === 0) path.down = down;
      if (!noDive && ((carry && down) || (straight && path.down))) for (let k2 = k0; k2 < path.length - 1; k2++) (path.dive ||= new Set()).add(k2);
    }
  }
  return path;
}

function fly(path, P, rng) {
  const dr = new Drone('freestyle5'); let crashed = false; dr.onCrash = () => { crashed = true; };
  { const d0 = path[1].clone().sub(path[0]); dr.reset(path[0].clone(), Math.atan2(-d0.x, -d0.z)); }
  const tk = new Take(), evs = [], DT = 1 / 240; let seg = 0, vseg = 0, t = 0, stuck = 0, lastP = dr.pos.clone();
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
    // [P6-F] a pilot slows for a dive: Cine's floor guard lets the quad sink ~2 x (height over the floor - 0.6) m/s while the
    // right stick is on (flight.js _diveGuard, skim), ~1 m/s over the stair mouth's steps, so a 28 deg dive at street speed
    // runs into the lip. Over the next DIVE_LOOK m of path, a segment steeper than 0.3 down caps the speed at DIVE_VZ / slope.
    // (only on a straight move's segments, path.dive: elsewhere phase 5's pilot, a P term on the steering look-ahead's height)
    let vCap = Infinity;
    { let acc = 0; for (let k2 = vseg; k2 < path.length - 1 && acc < DIVE_LOOK; k2++) { const a = path[k2], b = path[k2 + 1], dhh = Math.hypot(b.x - a.x, b.z - a.z), sl = dhh > 0.3 ? (a.y - b.y) / dhh : 0;
        if (sl > 0.3 && path.dive?.has(k2)) vCap = Math.min(vCap, DIVE_VZ / sl); acc += k2 === vseg ? Math.max(0, a.distanceTo(b) - p.distanceTo(a)) : a.distanceTo(b); } }
    const vWant = steep ? 0 : Math.min(vCap, vC * Math.max(0.3, Math.cos(Math.min(Math.PI / 2, Math.abs(e) * 1.5))) * (1 - 0.6 * Math.min(1, turn / 1.6)));
    const pitch = Math.max(-1, Math.min(1, vWant / 18 + ou.p * 0.3));
    const roll = Math.max(-1, Math.min(1, -e * 2.2 + ou.r));
    // [P6-F] vertical: the path's height VLOOK (0.3) m ahead (the 3-4.5 m steering look-ahead started the stair dive before its
    // pre-gate: under it, into the heads) plus a feed-forward of that segment's slope x the horizontal speed (a P term alone
    // lagged a 28 deg dive by 0.8 m, onto the stair mouth's lip: 0 of 12 even with no walkers)
    let yRef = tgt.y, vyDes = 0, plumb = false;
    // (vseg: the segment the quad is actually over, advanced only past a segment's end; `seg` runs ahead by the steering look)
    // (the nearest segment from vseg to seg, never backwards: a path that doubles back kept a plain "past its end" rule
    // on an old segment's height, into the stage canopy)
    { let bd = Infinity, bk = vseg; for (let k2 = vseg; k2 <= Math.min(seg, path.length - 2); k2++) { const a = path[k2], b = path[k2 + 1], ab = b.clone().sub(a), Lg = ab.length() || 1e-6;
        const u = Math.max(0, Math.min(Lg, p.clone().sub(a).dot(ab) / Lg)), d = p.distanceTo(a.clone().addScaledVector(ab, u / Lg)); if (d < bd - 1e-6) { bd = d; bk = k2; } } vseg = bk; }
    { let kk = vseg, ss = 0; { const a = path[kk], b = path[kk + 1], ab = b.clone().sub(a), Lg = ab.length() || 1e-6; ss = Math.max(0, Math.min(Lg, p.clone().sub(a).dot(ab) / Lg)) + VLOOK; }
      while (kk < path.length - 2) { const Lg = path[kk + 1].distanceTo(path[kk]); if (ss <= Lg) break; ss -= Lg; kk++; }
      const a = path[kk], b = path[kk + 1], Lg = a.distanceTo(b) || 1e-6, f = Math.min(1, ss / Lg), dhh = Math.hypot(b.x - a.x, b.z - a.z);
      plumb = dhh < 0.5 * Math.abs(b.y - a.y);   // a climb / drop straight up or down (SIGN STACK): phase 5's look-ahead
      yRef = a.y + (b.y - a.y) * f; const slope = dhh > 0.3 ? (b.y - a.y) / dhh : 0; if (Math.abs(slope) > 0.15) vyDes = slope * Math.hypot(dr.vel.x, dr.vel.z); }
    const ff = vyDes > 0 ? (-3.6 + Math.sqrt(12.96 + 9.6 * vyDes * 6 / dr.c.cineClimb)) / 4.8 : vyDes < 0 ? -(-1.8 + Math.sqrt(3.24 + 40.8 * -vyDes * 12 / dr.c.cineDive)) / 20.4 : 0;
    const dv = !!path.dive && !plumb && (path.dive.has(vseg) || path.dive.has(seg));
    const climb = dv ? Math.max(-1, Math.min(1, ff + (yRef - p.y) * 0.7 - (dr.vel.y - vyDes) * 0.12 + ou.c * 0.5))
      : Math.max(-1, Math.min(1, (tgt.y - p.y) * 0.7 - dr.vel.y * 0.12 + ou.c * 0.5));
    dr.step(DT, { thr: 0.4, pitch, roll, yaw: 0, climb }, 'cine', world); t += DT; if (process.env.TRACE && Math.round(t * 240) % 30 === 0) console.log('TR', t.toFixed(2), dr.pos.toArray().map((v) => v.toFixed(2)).join(','), 'yRef', yRef.toFixed(2), 'vy', dr.vel.y.toFixed(2), 'vh', Math.hypot(dr.vel.x, dr.vel.z).toFixed(2), 'seg', seg);
    for (const e2 of tk.update(DT, dr, world, { hands: true, moved: true, steer: true })) evs.push({ ...e2, at: t, ...(process.env.TLPOS ? { p: dr.pos.toArray().map((v) => +v.toFixed(2)) } : {}) });
    if (crashed) break;
    if ((Math.round(t * 240) % 480) === 0) { if (dr.pos.distanceTo(lastP) < 0.5) stuck++; else stuck = 0; lastP = dr.pos.clone(); if (stuck > 3) break; }
  }
  for (let i = 0; i < 240 * 12 && !crashed && tk.state !== 'done'; i++) { dr.step(DT, { thr: 0.4, pitch: 0, roll: 0, yaw: 0, climb: 0 }, 'cine', world); t += DT; for (const e2 of tk.update(DT, dr, world, { hands: false, moved: false, steer: false })) evs.push({ ...e2, at: t }); }
  const caps = evs.filter((e) => e.type === 'line' || e.type === 'repeat').map((e) => e.at), gaps = caps.slice(1).map((c, i) => c - caps[i]);
  const start = evs.find((e) => e.type === 'start')?.at ?? 0;
  return { total: tk.total, stars: starsFor(tk.total, tuning.stars), crashed, by: evs.find((e) => e.type === 'crash')?.by || null, t: +t.toFixed(1),
    lines: evs.filter((e) => e.type === 'line' && !e.micro).length, micros: evs.filter((e) => e.type === 'line' && e.micro).length, banks: evs.filter((e) => e.type === 'bank' && !e.cut).length,
    scrapes: evs.filter((e) => e.type === 'scrape').length, cleanTake: evs.some((e) => e.type === 'cut' && e.cleanTake), missed: evs.filter((e) => e.type === 'missed').map((e) => e.name), heads: evs.filter((e) => e.heads).length, maxFlow: tk.stats.maxFlow,
    first: caps.length ? +(caps[0] - start).toFixed(1) : null, gapMean: gaps.length ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : null, gapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null,
    // [P4-F1] x2: take time of the first caption at FLOW >= 2 (design #4: by 20 s); fast: FAST lines; voids: heads moves voided;
    // ws: WALKING STREET's own time (s) and pts
    x2: (() => { const e = evs.find((e) => (e.type === 'line' || e.type === 'repeat') && e.flow >= 2); return e ? +(e.at - start).toFixed(1) : null; })(),
    fast: evs.filter((e) => e.fast).length, clipped: evs.filter((e) => e.clipped).length, voids: evs.reduce((a, e) => a + (e.voids?.length || 0), 0),
    ws: (() => { const e = evs.find((e) => e.type === 'line' && e.name === 'WALKING STREET'); return e ? { dur: e.dur, speed: e.speed, pts: e.pts } : null; })(),
    names: evs.filter((e) => e.type === 'line').map((e) => e.name), tl: evs.filter((e)=>['line','repeat','bank','scrape','crash','cut','void'].includes(e.type)).map((e)=>`${e.at.toFixed(1)} ${e.type} ${e.name||''}${e.by?' by '+e.by:''}${e.heads?' HEADS':''}${e.voids?' VOID '+e.voids:''} +${e.pts||0} x${e.flow||''}${e.fast?' FAST':''}${e.clipped?' CLIPPED':''}${e.dur?' '+e.dur+'s':''}${e.p?' @'+e.p:''}`) };
}

const q = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : null; };
const results = {}, dropped = [];
const routes = ROUTE === 'all' ? Object.keys(ROUTES) : ROUTE.split(',');
const T0 = performance.now();
for (const rn of routes) for (const [pn, P] of Object.entries(PILOTS).filter(([k]) => !process.env.PILOT || process.env.PILOT.split(',').includes(k))) {
  if (occ.size > 1.5e6) occ.clear();   // [P7-F] the voxel cache grew past 1.5 GB over the record's 18 routes (OOM-killed at hub)
  const R = []; const rng = new Rng(1000 + rn.length * 31 + pn.length * 7), nd = NODIVE || NODIVE_ROUTES.has(rn), runs = NODIVE_ROUTES.has(rn) ? Math.max(RUNS, NODIVE_RUNS) : RUNS;
  // [P7-F design #6] a dropped route is logged and recorded (phase 6: stage1 printed NO PATH and quietly left the record)
  for (let i = 0; i < runs; i++) { const path = buildPath(ROUTES[rn], rng, P.spread, nd); if (!path || path.length < 2) { console.log(`NO PATH ${rn} ${pn}: every leg skipped (no clear approach), route DROPPED after ${R.length} of ${runs} runs`); dropped.push(`${rn}/${pn}`); break; } if (process.env.TRACE) console.log('PATH', path.map((v) => v.toArray().map((x) => x.toFixed(2)).join(',')).join(' | ')); R.push(fly(path, P, rng)); }
  const tot = R.map((r) => r.total);
  results[`${rn}/${pn}`] = { runs: R.length, p25: q(tot, 0.25), p50: q(tot, 0.5), p75: q(tot, 0.75), crash: R.filter((r) => r.crashed).length, by: R.map((r) => r.by).filter(Boolean),
    stars: R.map((r) => r.stars), lines: q(R.map((r) => r.lines), 0.5), micros: q(R.map((r) => r.micros), 0.5), banks: q(R.map((r) => r.banks), 0.5), scrapes: q(R.map((r) => r.scrapes), 0.5),
    heads: R.reduce((a, r) => a + r.heads, 0), first: q(R.map((r) => r.first ?? 99), 0.5), gapMean: q(R.map((r) => r.gapMean ?? 99), 0.5), gapMax: q(R.map((r) => r.gapMax ?? 99), 0.5), t: q(R.map((r) => r.t), 0.5), maxFlow: q(R.map((r) => r.maxFlow), 0.5),
    // [P5-F] flown: runs in which the route's last line fired (the portals, the stair dive: design #2 / #6, >= 10 of 12)
    flown: R.filter((r) => r.names.includes(ROUTES[rn][ROUTES[rn].length - 1][1])).length,
    // [P8-F design #4 / #5] runs that won CLEAN TAKE; the streets the guide-following bot joined past their start (missed events)
    cleanTakes: R.filter((r) => r.cleanTake).length, missed: [...new Set(R.flatMap((r) => r.missed))],
    x2: q(R.map((r) => r.x2 ?? 999), 0.5), fast: q(R.map((r) => r.fast), 0.5), clipped: R.reduce((a, r) => a + r.clipped, 0), voids: R.reduce((a, r) => a + r.voids, 0), wsDur: q(R.map((r) => r.ws?.dur ?? 0), 0.5), wsPts: q(R.map((r) => r.ws?.pts ?? 0), 0.5), agents: lifeAgents() };
  console.log(`${rn.padEnd(5)} ${pn.padEnd(8)} ${JSON.stringify(results[`${rn}/${pn}`])}`); if (process.env.TL) for (const r of R) console.log('   ', r.total, r.stars, r.crashed?'CRASH '+r.by:'', '|', r.tl.join(' ; '));
}
console.log(`stars ${JSON.stringify(tuning.stars)} | ${((performance.now() - T0) / 1000).toFixed(0)} s`);
if (dropped.length) console.log(`DROPPED ${dropped.length} route x pilot: ${dropped.join(', ')}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ tuning, results, dropped }, null, 1));
// [P5-F design #3] --record: tests/seoul/take-sim.json, the star fit's evidence (tests/take.mjs: careful long <= 2 stars, regular
// long 3, against lines.json's stars; stale when lines.json's lines or tuning change)
if (process.argv.includes('--record')) {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256').update(JSON.stringify({ lines: lineData.lines, tuning: lineData.tuning, takeStart: lineData.takeStart })).digest('hex').slice(0, 16);
  const keep = ['runs', 'p25', 'p50', 'p75', 'crash', 'by', 'heads', 'stars', 'lines', 'gapMax', 'x2', 'wsPts', 'fast', 'flown', 'cleanTakes', 'missed'];
  // [P7-F] --merge: add these routes to an existing record of the same lines.json (the record in several processes: one node
  // running all 18 routes was OOM-killed on the 8 GB box)
  const prev = process.argv.includes('--merge') ? (() => { try { const P = JSON.parse(fs.readFileSync(new URL('../../tests/seoul/take-sim.json', import.meta.url), 'utf8')); return P.lines === h && P.runs === RUNS ? P : null; } catch (e) { return null; } })() : null;
  if (process.argv.includes('--merge')) console.log(prev ? `merging into the record (${Object.keys(prev.results).length} pilot x route)` : 'no record of these lines to merge into: a new one');
  const rec = { note: `seoul/tools/take-sim.mjs --record: noisy-pilot takes at the game crowd, ${RUNS} runs per pilot x route (${[...NODIVE_ROUTES].join(', ')}: ${Math.max(RUNS, NODIVE_RUNS)})`, lines: h, stars: lineData.tuning.stars, runs: RUNS,
    routes: routes, dropped,
    results: { ...(prev?.results || {}), ...Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Object.fromEntries(keep.map((f) => [f, v[f]]))])) } };
  if (prev) { rec.routes = [...new Set([...(prev.routes || []), ...routes])]; rec.dropped = [...(prev.dropped || []).filter((k) => !routes.includes(k.split('/')[0])), ...dropped]; }
  fs.writeFileSync(new URL('../../tests/seoul/take-sim.json', import.meta.url), JSON.stringify(rec, null, 1) + '\n'); console.log('recorded tests/seoul/take-sim.json');
}
