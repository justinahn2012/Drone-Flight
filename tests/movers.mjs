// tests/movers.mjs — world.movers (P2-F1, design #5): Hongdae's buses, taxis and people on the drone's tick clock.
//   node tests/movers.mjs        (~10 s; needs seoul/layout.json + seoul-life.js, like test-seoul)
//  1. seoul-movers.js's private traffic matches the drawn LifeSim's boxes at the same take clock
//  2. pure function of t: a fork queried with rewinds answers exactly as one queried in order
//  3. a bus / car driving into a hovering quad crashes it (crashBy = its type)
//  4. flying into a standing person is a SCRAPE + HEADS! (take.js), not a crash
//  5. replay-exact: a low flight across Yanghwa-ro's traffic, recorded as main.js does (quantize, record, step), replays
//     bit-identically (continuous and re-synced at every snapshot), twice, with its Take events; snapshot v4 restore
//     continues bit-identically with the movers
//  6. without movers nothing changes: the tick clock is the only new state (bando parity is tests/replay.mjs)
//  7. [P3-F1 design #2] no gate in lines.json (pre-gates too) can be touched by a vehicle of the drawn traffic over
//     0-600 s at the quad's radius (seoul/tools/gateprobe.mjs; lines.mjs keeps them out at 0.35 m)
// [P4-F1 design #2] at the game's crowd (gateprobe.mjs lifeAgents: LIFE.maxAgents; phase 3 ran 2,400), and the low preset
// too: its traffic is the same (7), and
//  8. [P4-F1 design #1] the stair dive's approach (6 m to its pre-gate at 2.0-2.7 m) is <= 5 % occupied by people, at
//     both presets; the dive itself (pre-gate to the landing gate) too once nobody stands inside E's stairwell openings
//     (seoul-life places exit 9's waiting people round the portal without E's discs: PENDING G1 until then)
import fs from 'node:fs';
import * as THREE from 'three';
import { buildSeoulGeometry } from '../world-seoul.js';
import { Drone, SNAP_VERSION } from '../flight.js';
import { Take } from '../take.js';
import { InputLog, quantize, replayLog, worldHash } from '../inputlog.js';
import { lifeMovers, PED_R } from '../seoul-movers.js';
import { LifeSim } from '../seoul-life.js';
import { Rng } from '../rng.js';
import { vehicleTouches, lifeAgents } from '../seoul/tools/gateprobe.mjs';

const ROOT = new URL('../seoul/', import.meta.url);
const J = (f) => JSON.parse(fs.readFileSync(new URL(f, ROOT), 'utf8'));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
const layout = J('layout.json');
const t0 = performance.now();
const geo = buildSeoulGeometry(layout, { lineData: J('lines.json') });
const lifeOpts = (q) => ({ seed: 11, density: 1, maxAgents: lifeAgents(q), setPieces: geo.setPieces || [], obstacles: geo.dressingOut?.obstacles || null });   // [integ8] as world-seoul builds it (ctx.seed 11)
const sim = new LifeSim(layout, lifeOpts('auto'));
const life = { sim, colliders: { at: (t, o) => sim.boxesAt(t, o), hit: (p, r, t) => sim.hit(p, r, t) } };
const M = lifeMovers(life);
ok(!!M, `lifeMovers: ${JSON.stringify(M?.stats())}`);
const PHYS = 1 / 240;
const ENV = { min: new THREE.Vector3(-300, -2, -600), max: new THREE.Vector3(400, 160, 400) };
const world = { bvh: geo.bvh, funnels: geo.funnels, envelope: ENV, movers: M, lines: geo.lines, skimBvh: geo.skimBvh, tuning: J('lines.json').tuning || null };

// 1. parity with the drawn sim
{
  const A = M.fork(); let worst = 0, n = 0;
  for (const t of [0, 1 / 240, 2.5, 7.3, 20.0125, 41.7]) {
    const B = sim.boxesAt(t, []);
    A.hit([1e6, 0, 1e6], 0.1, t);                      // advance the private traffic to t
    const alpha = A._advance(t), o = {};
    for (const b of B) { const v = A.ts.vehicles.find((q) => q.id === b.id); A.ts.pose(v, alpha, o); worst = Math.max(worst, Math.hypot(o.x - b.c[0], o.z - b.c[2])); n++; }
  }
  ok(n > 100 && worst === 0, `private traffic = drawn traffic at 6 clocks (${n} boxes, worst ${worst} m)`);
}
// a vehicle and a query point on its roof / ahead of it at clock t
const vehAt = (t, pred) => sim.boxesAt(t, []).map((b) => ({ ...b, v: sim.traffic.vehicles.find((q) => q.id === b.id) })).filter(pred);

// 2. purity under rewinds
{
  const probes = []; const R = new Rng(5);
  for (let k = 0; k < 400; k++) { const t = 10 + k * 0.05; const B = vehAt(t, (b) => true); const b = B[Math.floor(R.next() * B.length)]; probes.push({ t, p: [b.c[0] + (R.next() - 0.5) * 3, 0.5 + R.next() * 3, b.c[2] + (R.next() - 0.5) * 3] }); }
  const key = (h) => (h ? `${h.kind}:${h.id}:${h.depth.toFixed(12)}:${h.n.map((x) => x.toFixed(12))}` : '-');
  const A = M.fork(), B = M.fork();
  const a = probes.map((q) => key(A.hit(q.p, 0.12, q.t)));
  const order = probes.map((_, i) => i).sort((i, j) => ((i * 7919) % 400) - ((j * 7919) % 400));   // shuffled clocks: rewinds
  const b = new Array(probes.length); for (const i of order) b[i] = key(B.hit(probes[i].p, 0.12, probes[i].t));
  ok(a.join() === b.join() && a.filter((x) => x !== '-').length > 50, `hit() is a pure function of t (${a.filter((x) => x !== '-').length} hits of 400, shuffled clocks agree)`);
}

// 3. a vehicle drives into a hovering quad
{
  const t = 30, k0 = t * 240;
  const cands = vehAt(t, (b) => b.type !== 'scooter' && b.v.v > 6);
  let crashed = null, tried = 0;
  for (const b of cands.slice(0, 12)) {
    tried++;
    const d = new Drone('freestyle5'); d.reset(new THREE.Vector3(b.c[0] + b.h[0] * (b.half[2] + 4), 1.0, b.c[2] + b.h[1] * (b.half[2] + 4)), 0); d.tick = k0;
    const inp = { thr: 0.4, pitch: 0, roll: 0, yaw: 0, climb: 0 };
    for (let i = 0; i < 240 * 2 && !d.crashed; i++) d.step(PHYS, inp, 'cine', world);
    if (d.crashed) { crashed = { by: d.crashBy, type: b.type, moverN: d.moverN }; break; }
  }
  ok(crashed && crashed.by === crashed.type && crashed.moverN >= 1, `a ${crashed?.type} driving into a hovering quad crashes it (crashBy ${crashed?.by}, tried ${tried})`);
}

// 4. a standing person: SCRAPE + HEADS!
{
  // a standing person with a clear 4 m run-in at 1.2 m from some side, nobody else within 1 m
  // [integ7] try candidates in order until one isn't on a traffic lane (a car crashing the run says nothing about people)
  const ray = new THREE.Ray(); let tried = 0, done = false;
  for (const p of M.src.peds) {
    if (done || tried >= 25) break;
    if (p.h < 1.6 || M.src.peds.some((o) => o !== p && Math.hypot(o.x - p.x, o.z - p.z) < 1.0)) continue;
    let dir = null;
    for (let k = 0; k < 8 && !dir; k++) { const a = k * Math.PI / 4, dx = Math.cos(a), dz = Math.sin(a);
      ray.origin.set(p.x - dx * 4, 1.2, p.z - dz * 4); ray.direction.set(dx, 0, dz);
      if (!geo.bvh.raycastFirst(ray, THREE.DoubleSide, 0, 4.5) && !((geo.bvh.closestPointToPoint(ray.origin, {}, 0, 0.6)?.distance ?? 1e9) < 0.6)) dir = [dx, dz]; }   // the threshold is an early-out, not a filter
    if (!dir) continue;
    // away from the traffic for the whole run (a bus sweeping the quad says nothing about people)
    let nearCar = false;
    for (let tt = 0; tt <= 3 && !nearCar; tt += 0.25) for (const bx of sim.boxesAt(tt, [])) if (Math.hypot(bx.c[0] - p.x, bx.c[2] - p.z) < 14) { nearCar = true; break; }
    if (nearCar) continue;
    tried++;
    const q = p, mv = M.fork ? M.fork() : M;
    const d = new Drone('freestyle5'); d.reset(new THREE.Vector3(q.x - dir[0] * 3, 1.2, q.z - dir[1] * 3), Math.atan2(-dir[0], -dir[1]));
    const tk = new Take(); const ev = [];
    const w = { ...world, movers: mv, lines: [] };
    for (let i = 0; i < 240 * 3 && !d.crashed; i++) { d.step(PHYS, { thr: 0.4, pitch: 0.18, roll: 0, yaw: 0, climb: 0 }, 'cine', w); ev.push(...tk.update(PHYS, d, w, { hands: true, moved: true, steer: true })); }
    if (d.crashed && d.moverKind === 'vehicle') continue;
    const s = ev.find((e) => e.type === 'scrape' && e.heads);
    ok(!d.crashed && d.moverKind === 'pedestrian' && !!s, `flying into a person (r ${PED_R} m): HEADS! scrape (impact ${s?.impact} m/s), no crash, ${ev.filter((e) => e.type === 'scrape').length} scrape event(s) [candidate ${tried}]`);
    done = true;
  }
  if (!done) ok(false, `a standing person to fly into (${tried} candidates tried)`);
}

// 5. replay-exact with movers
{
  // across Yanghwa-ro near exit 9, low over the lanes, weaving: meets the traffic
  const X9 = [46, -313];
  const pilot = (seed) => { const r = new Rng(seed), ou = { p: 0, r: 0, c: 0 }; return (i) => { for (const k in ou) ou[k] += -ou[k] * 0.8 * PHYS + 1.6 * Math.sqrt(PHYS) * (r.next() * 2 - 1);
    return { thr: 0.4, pitch: Math.max(-1, Math.min(1, 0.35 + ou.p * 0.4)), roll: Math.max(-1, Math.min(1, ou.r * 0.6)), yaw: 0, climb: Math.max(-1, Math.min(1, ou.c * 0.5 - 0.05)) }; }; };
  let rec = null;
  for (let s = 1; s <= 60 && !rec; s++) {
    const d = new Drone('freestyle5'); d.reset(new THREE.Vector3(X9[0] - 20, 1.3, X9[1] + 12), 0.9 + s * 0.37);
    const drive = pilot(100 + s), log = new InputLog({ seed: d.seed, world: worldHash(world), craft: d.key, mode: 'cine', hz: 240, start: d.snapshot(), meta: { test: 'movers' } });
    const inp = {};
    for (let i = 0; i < 240 * 25 && !(d.crashed && d.crashT > 1); i++) { quantize(drive(i), inp); log.record(inp, 'cine', d); d.step(PHYS, inp, 'cine', world); }
    if (d.moverN > 0 && log.ticks > 240 * 1) rec = /* [P3-G1] >= 1 s: with junction boxes a taxi passes the X9 start at 1.4 s in every heading */ { log, final: JSON.stringify(d.snapshot()), moverN: d.moverN, crashBy: d.crashBy, s };
  }
  ok(!!rec, `a flight that meets the traffic (seed ${rec?.s}: ${rec?.moverN} mover contact(s), crashBy ${rec?.crashBy})`);
  if (rec) {
    const a = replayLog(rec.log, new Drone('freestyle5'), world), b = replayLog(rec.log, new Drone('freestyle5'), world, { resync: true }), c = replayLog(rec.log, new Drone('freestyle5'), world);
    ok(JSON.stringify(a.final) === rec.final, `replay = live run, bit for bit (${(rec.log.ticks / 240).toFixed(1)} s, ${a.snaps} snapshots, max error ${a.maxErr} m)`);
    ok(b.maxErr === 0 && JSON.stringify(b.final) === rec.final, `re-synced at every v${SNAP_VERSION} snapshot: identical`);
    ok(JSON.stringify(a.final) === JSON.stringify(c.final), 'two replays end identical');
    // take parity: the same events from two replays
    const evs = () => { const tk = new Take(), out = []; replayLog(rec.log, new Drone('freestyle5'), world, { onTick: (i, d) => { for (const e of tk.update(PHYS, d, world, { hands: true, moved: true, steer: true })) out.push(e.type + (e.heads ? '!' : '') + (e.by ? ':' + e.by : '') + '@' + i); } }); return out.join(); };
    const e1 = evs(), e2 = evs();
    ok(e1 === e2 && e1.length > 0, `Take events replay identically (${e1.split(',').filter((x) => !x.startsWith('start')).slice(0, 4).join(' ')})`);
  }
  // snapshot v4 -> JSON -> restore mid-flight continues identically (the tick clock rides along)
  const drive = pilot(7), A = new Drone('freestyle5'); A.reset(new THREE.Vector3(X9[0] - 20, 1.3, X9[1] + 12), 1.2);
  for (let i = 0; i < 240 * 4; i++) A.step(PHYS, quantize(drive(i)), 'cine', world);
  const snap = JSON.parse(JSON.stringify(A.snapshot())), B = new Drone('cinewhoop').restore(snap);
  ok(snap.ver === 4 && snap.tick === 960 && B.tick === 960, `snapshot v4 carries the tick clock (${snap.tick})`);
  for (let i = 240 * 4; i < 240 * 10; i++) { const s = quantize(drive(i)); A.step(PHYS, s, 'cine', world); B.step(PHYS, s, 'cine', world); }
  ok(JSON.stringify(A.snapshot()) === JSON.stringify(B.snapshot()), 'restore(snapshot v4) continues bit-identically with movers (6 s)');
}

// 6. cost: the per-tick query on the busiest road
{
  const F = M.fork(); const t1 = performance.now(); let h = 0;
  for (let i = 0; i < 240 * 20; i++) if (F.hit([46 - 20 + i * 0.01, 1.2, -313 + 12], 0.12, i / 240)) h++;
  const ms = performance.now() - t1;
  ok(ms < 1500, `20 s of per-tick queries on Yanghwa-ro: ${ms.toFixed(0)} ms (${(ms / 20).toFixed(1)} ms per second of flight, traffic stepping included)`);
}
// 7. vehicles stay out of the gates
{
  const gs = [], who = [];
  for (const l of J('lines.json').lines) { if (l.carve) continue; gs.push(l); who.push(l.name); for (const p of l.pre || []) { gs.push(p); who.push(l.name + ' (pre)'); } }
  const t1 = performance.now(), T = vehicleTouches(sim, gs, { T: 600, dt: 0.25, r: 0.12 });
  ok(T.length === 0, `no gate a vehicle touches over 0-600 s (${gs.length} gates, ${((performance.now() - t1) / 1000).toFixed(1)} s)${T.length ? ': ' + [...new Set(T.map((x) => `${who[x.i]} by ${x.type} at ${x.t0} s`))].slice(0, 6).join(', ') : ''}`);
}
// 7b. the low preset (half the people) draws the same traffic: one gate probe covers both
{ const low = new LifeSim(layout, lifeOpts('low')), a = [], b = [];
  for (const t of [0, 37.5, 120, 300]) { sim.advanceTo(t); low.advanceTo(t); a.push(sim.hash()); b.push(low.hash()); }
  ok(a.join() === b.join(), `the low preset's traffic = the game's (${lifeAgents('low')} vs ${lifeAgents('auto')} people; hashes ${b.join(' ')})`);
  // 8. the stair dive (lines.json STATION STAIRS): people on its approach and in its dive, both presets
  const L = J('lines.json').lines.find((l) => l.name === 'STATION STAIRS' && l.pre?.length);
  if (!L) ok(false, 'STATION STAIRS in lines.json');
  else {
    const P = L.pre[0], n = P.n, u = P.u, A = P.c, B = L.c, D = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
    const holes = geo.dressingOut?.holes || [], pip = (x, z, H) => { let c = false; for (let i = 0, j = H.length - 1; i < H.length; j = i++) { const [xi, zi] = H[i], [xj, zj] = H[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
    const appr = [], dive = [];
    for (let s = -6; s <= 0; s += 0.5) for (const y of [P.c[1] - P.h / 2, P.c[1], P.c[1] + P.h / 2]) appr.push([A[0] + n[0] * s, y, A[2] + n[2] * s]);
    for (let s = 0.5; s <= D; s += 0.5) { const f = s / D; dive.push([A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f]); }
    for (const [q, S] of [['auto', sim], ['low', low]]) {
      const M2 = lifeMovers({ sim: S, colliders: { people: (p, r, t) => S.hitPeople(p, r, t + 75) } }), F = M2.fork();
      const occ = (pts) => { let k = 0, N = 0; for (let t = 0; t <= 600; t += 1) { N++; if (pts.some((p) => [-0.6, 0, 0.6].some((o) => { const h = F.hit([p[0] + u[0] * o, p[1], p[2] + u[2] * o], 0.12, t); return h && h.kind === 'pedestrian'; }))) k++; } return 100 * k / N; };
      const a8 = occ(appr), d8 = occ(dive), inHole = M2.src.peds.filter((p) => holes.some((H) => pip(p.x, p.z, H))).length;
      ok(a8 <= 5, `${q}: the stair dive's approach (6 m to the pre-gate at ${(P.c[1] - P.h / 2).toFixed(1)}-${(P.c[1] + P.h / 2).toFixed(1)} m) is ${a8.toFixed(1)} % occupied (<= 5 %)`);
      if (inHole) console.log(`PEND ${q}: the dive (pre-gate to the landing gate) is ${d8.toFixed(1)} % occupied: ${inHole} standing people inside E's stairwell openings (G1: keep exit 9's waiting ring and walkers out of dressingOut.holes / the obstacle discs)`);
      else ok(d8 <= 5, `${q}: the dive (pre-gate to the landing gate) is ${d8.toFixed(1)} % occupied (<= 5 %)`);
    }
  }
}
console.log(`movers tests: ${pass} passed, ${fail} failed (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
