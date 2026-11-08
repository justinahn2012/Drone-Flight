// tests/seoul-life.mjs: S4 life sims. Determinism (traffic hash at fixed take clocks, twice and after a rewind),
// budgets (agents, vehicles, step cost), sanity (no NaN, vehicles never overlap in a lane, crossers obey the light).
//   node tests/seoul-life.mjs [layout.json]
import { readFileSync, existsSync } from 'fs';
import { LifeSim, LIFE, crossPhase } from '../seoul-life.js';
const arg = process.argv[2];
const cands = [arg, 'seoul/layout.json', 'seoul/layout.provisional.json', 'tests/seoul-life-layout.json'].filter(Boolean);
const file = cands.find((f) => existsSync(f)); const layout = JSON.parse(readFileSync(file, 'utf8'));
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const a = new LifeSim(layout, { seed: 7 }), b = new LifeSim(layout, { seed: 7 });
console.log(`layout ${file}: ${a.crowd.agents.length} agents, ${a.traffic.vehicles.length} vehicles, ${a.traffic.lanes.length} lanes, ${a.crowd.ways.length} walkways, ${a.net.crossings.length} crossings`);
const T = [0, 1 / 240, 5, 37.5, 61.25, 90];
const ha = T.map((t) => (a.advanceTo(t), a.hash())), hb = T.map((t) => (b.advanceTo(t), b.hash()));
ok(ha.join() === hb.join(), 'traffic hash identical across two sims: ' + ha.slice(-2).join(' '));
b.advanceTo(10); b.advanceTo(90); ok(b.hash() === ha[ha.length - 1], 'rewind + re-simulate reproduces t=90');
const c = new LifeSim(layout, { seed: 8 }); c.advanceTo(90); ok(c.hash() !== ha[ha.length - 1], 'a different seed differs');
// overlaps + NaN
let nan = 0, overlap = 0;
for (const ln of a.traffic.lanes) { const vs = ln.veh.filter((v) => !v.hidden).sort((p, q) => q.s - p.s); for (let i = 1; i < vs.length; i++) if (vs[i - 1].s - vs[i - 1].L - vs[i].s < -0.05) overlap++; for (const v of vs) if (!isFinite(v.s) || !isFinite(v.v)) nan++; }
for (const g of a.crowd.agents) if (!isFinite(g.x) || !isFinite(g.z)) nan++;
ok(nan === 0, 'no NaN'); ok(overlap === 0, `no bumper overlaps (${overlap})`);
// crossers only on the road during walk
let bad = 0, onRoad = 0; const s2 = new LifeSim(layout, { seed: 3 });
for (let t = 0; t < 140; t += 0.5) { s2.advanceTo(t); for (const g of s2.crowd.agents) if (g.mode === 4 && g.cp > 0.25 && g.cp < 0.75) { onRoad++; const ph = crossPhase(g.cross, t); if (ph.car === 'G') bad++; } }
ok(bad === 0 && onRoad > 0, `crossers mid-road only off green (${onRoad} samples, ${bad} bad)`);
// moving + stopping
const mv = a.traffic.vehicles.filter((v) => v.v > 3).length, st = a.traffic.vehicles.filter((v) => v.v < 0.3 && !v.hidden).length;
ok(mv > 5 && st > 0, `traffic flows and queues (moving ${mv}, stopped ${st})`);
// liveness (life #2): P1 deadlocked (82 % of road vehicles stopped at 90 s, 100 % at 300 s). At 300 s fewer than 10 %
// may have been stopped for more than 45 s (longer than any red), and the taxi/bus dwells must actually happen.
{
  const L = new LifeSim(layout, { seed: 7 }), T = L.traffic, still = new Map(), ev = {};
  for (let t = 1; t <= 300; t++) {
    while (T.n < t * 60) { T.step(); for (const e of T.events) ev[e.type] = (ev[e.type] || 0) + 1; }
    for (const v of T.vehicles) { if (v.hidden || v.lane.shared) { still.set(v.id, 0); continue; } still.set(v.id, v.v < 0.3 ? (still.get(v.id) || 0) + 1 : 0); }
  }
  const road = T.vehicles.filter((v) => !v.hidden && !v.lane.shared), s45 = road.filter((v) => still.get(v.id) > 45).length;
  ok(s45 < 0.1 * road.length, `liveness at 300 s: ${s45}/${road.length} road vehicles stopped > 45 s (< 10 %)`);
  ok((ev.kneel || 0) >= 5, `buses kneel at stops (${ev.kneel || 0} in 300 s: the hiss has something to play)`);
  ok((ev.unstick || 0) <= 12, `watchdog rarely needed (${ev.unstick || 0} unsticks in 300 s)`);
  const ty = {}; for (const v of T.vehicles) if (!v.hidden) ty[v.type] = (ty[v.type] || 0) + 1;
  ok(ty.scooter >= 20 && ty.scooter <= 60, `about 40 scooters (${ty.scooter}), P1 had 161`);
  ok(ty.taxi / (ty.taxi + ty.car) > 0.33, `taxis ~45 % of cars (${(ty.taxi / (ty.taxi + ty.car)).toFixed(2)})`);
  const E = [...T.entries.road, ...T.entries.shared];
  ok(T.entries.road.every((l) => l.start && l.start.boundary), `road traffic re-enters only at map-edge lanes (${T.entries.road.length})`);
  void E;
}
// hit test
const v0 = a.traffic.vehicles.find((v) => !v.hidden && v.type !== 'scooter'), B = a.boxesAt(90); const bx = B.find((q) => q.id === v0.id);
ok(!!a.hit([bx.c[0], bx.c[1] + bx.half[1] + 0.1, bx.c[2]], 0.2, 90), 'sphere on a roof hits'); ok(!a.hit([bx.c[0], 40, bx.c[2]], 0.2, 90), 'sphere high above misses');
// cost
const p = new LifeSim(layout, { seed: 11 }); let t0 = performance.now(); p.advanceTo(60); const ms = performance.now() - t0;
const perStepC = (() => { const q = new LifeSim(layout, { seed: 12 }); q.advanceTo(5); const t1 = performance.now(); for (let i = 0; i < 100; i++) q.crowd.step(); return (performance.now() - t1) / 100; })();
const perStepT = (() => { const q = new LifeSim(layout, { seed: 12 }); const t1 = performance.now(); for (let i = 0; i < 600; i++) q.traffic.step(); return (performance.now() - t1) / 600; })();
console.log(`cost: 60 s of take in ${ms.toFixed(0)} ms; crowd step ${perStepC.toFixed(3)} ms (10 Hz), traffic step ${perStepT.toFixed(3)} ms (60 Hz) -> ${(perStepC * 10 + perStepT * 60).toFixed(2)} ms/s of sim`);
ok(perStepC * 10 + perStepT * 60 < 60, 'sim cost < 60 ms per second of take on this box (~6 % of a frame budget/s)');
process.exit(fail ? 1 : 0);
