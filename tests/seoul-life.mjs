// tests/seoul-life.mjs: S4 life sims. Determinism (traffic hash at fixed take clocks, twice and after a rewind),
// budgets (agents, vehicles, step cost), sanity (no NaN, vehicles never overlap in a lane, crossers obey the light).
//   node tests/seoul-life.mjs [layout.json]
import { readFileSync, existsSync } from 'fs';
import { LifeSim, LIFE, crossPhase, K_WALK, K_STAND, K_QUEUE, K_CROSS } from '../seoul-life.js';
const arg = process.argv[2];
const cands = [arg, 'seoul/layout.json', 'seoul/layout.provisional.json', 'tests/seoul-life-layout.json'].filter(Boolean);
const file = cands.find((f) => existsSync(f)); const layout = JSON.parse(readFileSync(file, 'utf8'));
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const a = new LifeSim(layout, { seed: 7 }), b = new LifeSim(layout, { seed: 7 });
console.log(`layout ${file}: ${a.crowd.people.length} people (${a.crowd.units.length} walker units), ${a.traffic.vehicles.length} vehicles, ${a.traffic.lanes.length} lanes, ${a.crowd.ways.length} walkways, ${a.net.crossings.length} crossings`);
const T = [0, 1 / 240, 5, 37.5, 61.25, 90];
const ha = T.map((t) => (a.advanceTo(t), a.hash())), hb = T.map((t) => (b.advanceTo(t), b.hash()));
ok(ha.join() === hb.join(), 'traffic hash identical across two sims: ' + ha.slice(-2).join(' '));
b.advanceTo(10); b.advanceTo(90); ok(b.hash() === ha[ha.length - 1], 'rewind + re-simulate reproduces t=90');
const c = new LifeSim(layout, { seed: 8 }); c.advanceTo(90); ok(c.hash() !== ha[ha.length - 1], 'a different seed differs');
// overlaps + NaN
let nan = 0, overlap = 0;
for (const ln of a.traffic.lanes) { const vs = ln.veh.filter((v) => !v.hidden).sort((p, q) => q.s - p.s); for (let i = 1; i < vs.length; i++) if (vs[i - 1].s - vs[i - 1].L - vs[i].s < -0.05) overlap++; for (const v of vs) if (!isFinite(v.s) || !isFinite(v.v)) nan++; }
a.crowd.evaluate(90, { x: -36, z: -23 });
for (let i = 0; i < a.crowd.people.length; i++) if (a.crowd.VIS[i] && (!isFinite(a.crowd.X[i]) || !isFinite(a.crowd.Z[i]))) nan++;
ok(nan === 0, 'no NaN'); ok(overlap === 0, `no bumper overlaps (${overlap})`);
// crowd: closed form (same t -> same street, from any history), density where the drone is, portals, behaviour
{
  const C = a.crowd, D = new LifeSim(layout, { seed: 7 }).crowd, snap = (X) => Array.from(X.X.slice(0, 4000)).map((x, i) => (X.VIS[i] ? x : 0)).join();
  C.evaluate(200, null, { avoid: false }); const s1 = snap(C); C.evaluate(37, null, { avoid: false }); C.evaluate(200, null, { avoid: false });
  D.evaluate(200, null, { avoid: false });
  ok(snap(C) === s1 && snap(D) === s1, 'crowd is a pure function of the take clock (rewind and a fresh sim agree)');
  const area = {}, cnt = {}; for (const w of C.ways) area[w.kind] = (area[w.kind] || 0) + w.area;
  let S = 0; for (let t = 60; t < 360; t += 15) { C.evaluate(t, null, { avoid: false }); S++; for (let i = 0; i < C.people.length; i++) if (C.VIS[i] && C.WAY[i] >= 0) { const k = C.ways[C.WAY[i]].kind; cnt[k] = (cnt[k] || 0) + 1; } }
  const dens = Object.fromEntries(Object.keys(area).map((k) => [k, (cnt[k] || 0) / S / area[k]]));
  console.log('      realised walker density p/m2:', Object.entries(dens).map(([k, v]) => `${k} ${v.toFixed(3)} (target ${LIFE.density[k]})`).join(', '));
  ok(dens.walking > 0.25 && dens.club > 0.2 && dens.main > 0.055 && dens.alley > 0.04, 'densities within ~25 % of the targets (P1: walking 0.10, club 0.08, main 0.03, alley 0.02)');
  // portals: trips start at a door / exit / map edge and end at one (or leave the map); never mid-street
  let trips = 0, open = 0; for (const u of C.units) { if (!u.trip) continue; trips++; if (!u.trip.end) open++; }
  ok(open / trips < 0.06, `walkers appear and vanish only at doors, exit 9 and the map edge (${open}/${trips} trips end without a door)`);
  // bodies: walkers through walkers / standing people, near the camera (avoidance on)
  let ww = 0, ws = 0, n = 0; const cam = { x: -36, z: -23 };
  for (let t = 100; t < 130; t += 0.5) {
    C.evaluate(t, cam); const near = [];
    for (let i = 0; i < C.people.length; i++) if (C.VIS[i] && Math.hypot(C.X[i] - cam.x, C.Z[i] - cam.z) < 30) near.push(i);
    for (const i of near) { if (C.people[i].kind !== K_WALK) continue; n++; let hw = false, hs = false;
      for (const j of near) { if (j === i || (C.people[j].kind === K_WALK && C.people[j].unit === C.people[i].unit)) continue; const d = Math.hypot(C.X[i] - C.X[j], C.Z[i] - C.Z[j]); if (d < 0.35) { if (C.people[j].kind === K_WALK) hw = true; else hs = true; } }
      if (hw) ww++; if (hs) ws++; }
  }
  ok(ww / n < 0.05 && ws / n < 0.003, `walker overlaps near the camera (at 3x P1 density): ${(100 * ww / n).toFixed(2)} % with walkers, ${(100 * ws / n).toFixed(2)} % inside standing people (P1: 6.1 %, 0.47 %)`);
  // standing people shuffle; queues admit and step up
  C.evaluate(60, null, { avoid: false }); const st = C.people.filter((p) => p.kind === K_STAND).map((p) => [C.X[p.id], C.Z[p.id], C.YAW[p.id]]);
  C.evaluate(240, null, { avoid: false }); let moved = 0; C.people.filter((p) => p.kind === K_STAND).forEach((p, i) => { if (Math.hypot(C.X[p.id] - st[i][0], C.Z[p.id] - st[i][1]) > 0.05 || Math.abs(C.YAW[p.id] - st[i][2]) > 0.05) moved++; });
  ok(moved > 0.6 * st.length, `standing people move, turn, change what they do (${moved}/${st.length} over 3 min; P1: 0)`);
  const q0 = C.queues.map((q) => C.queueState(q, 60).A), q1 = C.queues.map((q) => C.queueState(q, 240).A);
  ok(q1.every((v, i) => v - q0[i] >= 3), `club queues admit 1-3 every 20-60 s (${q1.map((v, i) => v - q0[i]).join(',')} admitted in 3 min)`);
  // soft colliders: a sphere on a walker hits, high above misses
  C.evaluate(150, null, { avoid: false }); const wi = C.people.findIndex((p) => p.kind === K_WALK && C.VIS[p.id]);
  ok(!!a.hitPeople([C.X[wi], 1.0, C.Z[wi]], 0.15, 150) && !a.hitPeople([C.X[wi], 4, C.Z[wi]], 0.15, 150), 'pedestrian soft collider: hit at chest height, miss overhead');
  // cost
  const c0 = process.cpuUsage(); for (let k = 0; k < 120; k++) C.evaluate(300 + k / 30, cam); const c1 = process.cpuUsage(c0), ms = (c1.user + c1.system) / 1000 / 120;
  ok(ms < 6, `crowd evaluate ${ms.toFixed(2)} ms CPU per frame (${C.people.length} people, staggered past 60 m)`);
}
// crossers only on the road during walk
let bad = 0, onRoad = 0; const s2 = new LifeSim(layout, { seed: 3 });
for (let t = 0; t < 140; t += 0.5) { s2.crowd.evaluate(t, null, { avoid: false }); for (const g of s2.crowd.people) { if (g.kind !== K_CROSS || !s2.crowd.VIS[g.id]) continue; const c = g.cross, P = c.main.path.at(c.sc, {}); const off = (s2.crowd.X[g.id] - P.x) * P.nx + (s2.crowd.Z[g.id] - P.z) * P.nz; if (Math.abs(off) < 0.5 * c.halfSpan) { onRoad++; if (crossPhase(c, t).car === 'G') bad++; } } }
ok(bad === 0 && onRoad > 0, `crossers mid-road only off green (${onRoad} samples, ${bad} bad)`);
s2.advanceTo(140);
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
// cost (traffic; the crowd is closed-form, costed above)
const p = new LifeSim(layout, { seed: 11 }); let t0 = performance.now(); p.advanceTo(60); const ms = performance.now() - t0;
const perStepT = (() => { const q = new LifeSim(layout, { seed: 12 }); const c0 = process.cpuUsage(); for (let i = 0; i < 600; i++) q.traffic.step(); const c = process.cpuUsage(c0); return (c.user + c.system) / 1000 / 600; })();
console.log(`cost: 60 s of traffic in ${ms.toFixed(0)} ms; traffic step ${perStepT.toFixed(3)} ms CPU (60 Hz) -> ${(perStepT * 60).toFixed(2)} ms/s of sim`);
ok(perStepT * 60 < 30, 'traffic cost < 30 ms per second of take');
// rewinds are cheap: snapshots every 10 s
{ const q = new LifeSim(layout, { seed: 7 }); q.advanceTo(300); const h = q.hash(); const c0 = process.cpuUsage(); q.advanceTo(295); q.advanceTo(300); const c = process.cpuUsage(c0);
  ok(q.hash() === h, 'snapshot rewind reproduces the traffic bit for bit'); ok((c.user + c.system) / 1000 < 400, `rewind 5 s at t=300 costs ${((c.user + c.system) / 1000).toFixed(0)} ms CPU (P1: a full re-sim from 0)`); }
process.exit(fail ? 1 : 0);
