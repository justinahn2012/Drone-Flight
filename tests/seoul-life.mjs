// tests/seoul-life.mjs: S4 life sims. Determinism (traffic hash at fixed take clocks, twice and after a rewind),
// budgets (agents, vehicles, step cost), sanity (no NaN, vehicles never overlap in a lane, crossers obey the light).
//   node tests/seoul-life.mjs [layout.json]
import { readFileSync, existsSync } from 'fs';
import { LifeSim, LIFE, crossPhase, K_WALK, K_STAND, K_QUEUE, K_CROSS, exportData, buskSitesFrom, crowdObstacles } from '../seoul-life.js';
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
for (const ln of a.traffic.lanes) { const vs = ln.veh.filter((v) => !v.hidden).sort((p, q) => q.s - p.s); for (let i = 1; i < vs.length; i++) if (vs[i - 1].s - vs[i].s - (vs[i - 1].L + vs[i].L) / 2 < -0.05) overlap++; /* s is the centre (P3) */ for (const v of vs) if (!isFinite(v.s) || !isFinite(v.v)) nan++; }
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
  // (P6, life #3) the lanes don't self-sort: in the outer thirds of the walking-street and Yanghwa-ro walkways, >= 15 % walk
  // the other way (P5: 0 %, so walk0 showed only backs and walk180 only faces)
  { const B = {}; for (let t = 100; t < 400; t += 20) { C.evaluate(t, null, { avoid: false });
      for (let i = 0; i < C.people.length; i++) { if (!C.VIS[i] || C.people[i].kind !== K_WALK || C.WAY[i] < 0) continue; const w = C.ways[C.WAY[i]]; if (w.kind !== 'walking' && w.kind !== 'main') continue;
        const f = (C.WD[i] - w.dmin) / (w.dmax - w.dmin); if (f > 1 / 3 && f < 2 / 3) continue; const k = w.kind + (f < 0.5 ? 'L' : 'R'); B[k] ??= [0, 0]; B[k][C.WDIR[i] > 0 ? 0 : 1]++; } }
    const mins = Object.entries(B).map(([k, [p, m]]) => [k, Math.min(p, m) / Math.max(1, p + m)]);
    ok(mins.length === 4 && mins.every(([, v]) => v >= 0.15), `walkways' outer thirds walk both ways: minority ${mins.map(([k, v]) => `${k} ${(100 * v).toFixed(0)} %`).join(', ')} (P5: 0 %)`); }
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
  // steady state (P3): a seek regenerates every unit's trip once; that is costed on its own, then 120 frames at 30 fps
  const camF = { x: cam.x, z: cam.z, fx: 0, fz: -1 };
  const k0 = process.cpuUsage(); C.evaluate(300, camF); const k1 = process.cpuUsage(k0);
  for (let k = 1; k < 30; k++) C.evaluate(300 + k / 30, camF);
  const c0 = process.cpuUsage(); for (let k = 0; k < 120; k++) C.evaluate(301 + k / 30, camF); const c1 = process.cpuUsage(c0), ms = (c1.user + c1.system) / 1000 / 120;
  ok(ms < 6, `crowd evaluate ${ms.toFixed(2)} ms CPU per frame (${C.people.length} people, staggered past 60 m and behind the camera; a seek costs ${((k1.user + k1.system) / 1000).toFixed(0)} ms once)`);
  // life #4 (P3): the hero club street (Wausan-ro 19-gil) and exit 9 trains
  { const ar = {}, cn = {}; let S = 0; const ex = C.exitPortal, burst = [];
    for (const w of C.ways) { const k = w.street.ko || w.street.id; ar[k] = (ar[k] || 0) + w.area; }
    for (let t = 60; t < 420; t += 5) { C.evaluate(t, null, { avoid: false }); S++; let e = 0;
      for (let i = 0; i < C.people.length; i++) { if (!C.VIS[i]) continue; if (C.WAY[i] >= 0) { const k = C.ways[C.WAY[i]].street.ko || C.ways[C.WAY[i]].street.id; cn[k] = (cn[k] || 0) + 1; }
        if (ex && C.people[i].kind === K_WALK && Math.hypot(C.X[i] - ex.x, C.Z[i] - ex.z) < 12) e++; }
      burst.push(e); }
    const d19 = (cn['와우산로19길'] || 0) / S / (ar['와우산로19길'] || 1);
    ok(!ar['와우산로19길'] || d19 > 0.25, `Wausan-ro 19-gil (club street) ${d19.toFixed(3)} p/m2 (P2: 0.07-0.11, target 0.3)`);
    ok(!ex || (Math.max(...burst) >= 30 && Math.min(...burst) < Math.max(...burst) * 0.5), `exit 9: walkers within 12 m swing ${Math.min(...burst)}-${Math.max(...burst)} as trains arrive (P2: ~0.02 p/m2, flat)`); }
}
// life #5/#6 (P3): E's set pieces and dressing discs (a snapshot of seoul-dressing's output for the integ7 layout)
if (existsSync('tests/seoul-life-dressing.json') && file === 'seoul/layout.json') {
  const D = JSON.parse(readFileSync('tests/seoul-life-dressing.json', 'utf8')), st = D.setPieces.find((p) => p.kind === 'stage'), c = st.crowdRing.c;
  const phys = crowdObstacles(D.obstacles, buskSitesFrom(D.setPieces)).filter((o) => o[2] < 1.7);
  const res = [];
  for (const opt of [{}, { setPieces: D.setPieces, obstacles: D.obstacles }]) {
    const C = new LifeSim(layout, { seed: 7, ...opt }).crowd; let tot = 0, ins = 0, ring = 0;
    C.evaluate(200, null, { avoid: false }); for (const b of C.busk) for (const i of b.aud) if (C.VIS[i] && Math.hypot(C.X[i] - c[0], C.Z[i] - c[2]) < 6) ring++;
    for (const cam of [{ x: -36, z: -23 }, { x: c[0], z: c[2] }]) for (let t = 100; t < 130; t += 0.5) { C.evaluate(t, cam);
      for (let i = 0; i < C.people.length; i++) { if (!C.VIS[i] || C.people[i].kind !== K_WALK || Math.hypot(C.X[i] - cam.x, C.Z[i] - cam.z) > 25) continue; tot++;
        for (const o of phys) if (Math.abs(C.X[i] - o[0]) < 2 && Math.abs(C.Z[i] - o[1]) < 2 && Math.hypot(C.X[i] - o[0], C.Z[i] - o[1]) < o[2]) { ins++; break; } } }
    res.push({ ring, inside: 100 * ins / tot, rings: C.busk.length });
  }
  { const P3 = { id: 'under-the-stage', kind: 'stage', pos: [196, 0, -311], yaw: 0.5, busk: { pos: [196, 0, -311], yaw: 0.5, arc: 1.95, r: [2.6, 4.1] }, crowdRing: { c: [196 + 3.3 * Math.sin(0.5), 0, -311 + 3.3 * Math.cos(0.5)], r: 3.2 }, canopy: { c: [196 - 1, 0, -311 - 1.5], len: 9, dep: 5.6 } };
    const bs = buskSitesFrom([P3]); ok(bs.sites.length === 1 && bs.sites[0].pos === P3.busk.pos && bs.sites[0].yaw === 0.5 && bs.areas.length === 1, "E's P3 stage format (busk.pos / busk.yaw / canopy) gives the busk site"); }
  ok(res[1].ring >= 30 && res[0].ring === 0 && res[1].rings >= 3, `UNDER THE STAGE busks: ${res[1].ring} in the crowd round crowdRing.c (P2: ${res[0].ring}); ${res[1].rings} rings (the Playground kept)`);
  ok(res[1].inside < 1.2 && res[1].inside < res[0].inside * 0.5, `walkers inside E's carts, tents, stalls and parked scooters within 25 m: ${res[1].inside.toFixed(2)} % (without the discs ${res[0].inside.toFixed(2)} %)`);
}
// design #2 (P3): no vehicle in the BUS SHELTER corridors (pre gate -> gate under the canopy, 2.2 m wide, 1.1-2.9 m up)
if (existsSync('tests/seoul-life-dressing.json') && file === 'seoul/layout.json') {
  const D = JSON.parse(readFileSync('tests/seoul-life-dressing.json', 'utf8')), sh = D.setPieces.find((p) => p.kind === 'shelter');
  const corr = Object.values(sh.gates).map((g) => { const c = [(g.pre.c[0] + g.gate.c[0]) / 2, (g.pre.c[2] + g.gate.c[2]) / 2]; return { c, n: [g.pre.n[0], g.pre.n[2]], u: [g.pre.u[0], g.pre.u[2]], hl: Math.hypot(g.gate.c[0] - g.pre.c[0], g.gate.c[2] - g.pre.c[2]) / 2 + 0.3, hw: g.pre.w / 2, y0: g.pre.c[1] - g.pre.h / 2 }; });
  const hits = (b, k) => { if (b.c[1] + b.half[1] < k.y0) return false;   // SAT, 2-D: vehicle OBB vs corridor rectangle
    const A = [[b.h[0], b.h[1]], [b.h[1], -b.h[0]]], ah = [b.half[2], b.half[0]], B = [k.n, k.u], bh = [k.hl, k.hw], d = [k.c[0] - b.c[0], k.c[1] - b.c[2]];
    for (const ax of [...A, ...B]) { const ra = ah[0] * Math.abs(ax[0] * A[0][0] + ax[1] * A[0][1]) + ah[1] * Math.abs(ax[0] * A[1][0] + ax[1] * A[1][1]), rb = bh[0] * Math.abs(ax[0] * B[0][0] + ax[1] * B[0][1]) + bh[1] * Math.abs(ax[0] * B[1][0] + ax[1] * B[1][1]); if (Math.abs(d[0] * ax[0] + d[1] * ax[1]) > ra + rb) return false; }
    return true; };
  const occ = (opt) => { const S = new LifeSim(layout, { seed: 11, ...opt }); let n = 0, S2 = 0; for (let t = 1; t <= 600; t += 0.5) { S2++; if (S.boxesAt(t).some((b) => corr.some((k) => hits(b, k)))) n++; } return n / S2; };
  const before = occ({}), after = occ({ setPieces: D.setPieces });
  ok(after === 0, `BUS SHELTER corridors clear of traffic: ${(100 * after).toFixed(1)} % of 600 s blocked (lanes not fanned out round the island: ${(100 * before).toFixed(1)} %)`);
}
// crossers only on the road during walk
let bad = 0, onRoad = 0; const s2 = new LifeSim(layout, { seed: 3 });
for (let t = 0; t < 140; t += 0.5) { s2.crowd.evaluate(t, null, { avoid: false }); for (const g of s2.crowd.people) { if (g.kind !== K_CROSS || !s2.crowd.VIS[g.id]) continue; const c = g.cross, P = c.main.path.at(c.sc, {}); const off = (s2.crowd.X[g.id] - P.x) * P.nx + (s2.crowd.Z[g.id] - P.z) * P.nz; if (Math.abs(off) < 0.5 * c.halfSpan) { onRoad++; if (crossPhase(c, t).car === 'G') bad++; } } }
ok(bad === 0 && onRoad > 0, `crossers mid-road only off green (${onRoad} samples, ${bad} bad)`);
s2.advanceTo(140);
// moving + stopping
const mv = a.traffic.vehicles.filter((v) => v.v > 3).length, st = a.traffic.vehicles.filter((v) => v.v < 0.3 && !v.hidden).length;
ok(mv > 5 && st > 0, `traffic flows and queues (moving ${mv}, stopped ${st})`);
// life #3 (P4): traffic that streams. P3 passed the line above at 75 % stopped (79 % on the main roads, 3.7 km/h). Gate the
// stopped share over 600 s and the speed of what moves between the lights.
{ const F = new LifeSim(layout, { seed: 11 }); let n = 0, st2 = 0, mn = 0, mst = 0, mvs = 0, mvn = 0;
  for (let t = 60; t <= 600; t += 10) { F.advanceTo(t + LIFE.warm); for (const v of F.traffic.vehicles) { if (v.hidden) continue; n++; if (v.v < 0.5) st2++; if (v.lane.street.kind === 'main') { mn++; if (v.v < 0.5) mst++; else { mvs += v.v; mvn++; } } } }
  const all = st2 / n, main = mst / mn, kmh = mvs / mvn * 3.6;
  // (P5, life #1) the panel's gate: main roads 35-50 % stopped (P4 passed at 62 % against a 66 % line)
  ok(all <= 0.5 && main >= 0.35 && main <= 0.5 && kmh >= 15 && kmh <= 30, `traffic streams: ${(100 * all).toFixed(0)} % stopped (main roads ${(100 * main).toFixed(0)} %, gate 35-50), moving at ${kmh.toFixed(1)} km/h between the lights (P4: 55 % / 62 %, 20.5 km/h; P3: 72 % / 79 %)`); }
// liveness (life #2): P1 deadlocked (82 % of road vehicles stopped at 90 s, 100 % at 300 s). At 300 s fewer than 10 %
// may have been stopped for more than 45 s (longer than any red), and the taxi/bus dwells must actually happen.
{
  const L = new LifeSim(layout, { seed: 7 }), T = L.traffic, still = new Map(), ev = {};
  for (let t = 1; t <= 300; t++) {
    while (T.n < t * 60) { T.step(); for (const e of T.events) ev[e.type] = (ev[e.type] || 0) + 1; }
    for (const v of T.vehicles) { if (v.hidden || v.lane.shared) { still.set(v.id, 0); continue; } still.set(v.id, v.v < 0.3 ? (still.get(v.id) || 0) + 1 : 0); }
  }
  // (P3: junction boxes queue the Yanghwa-ro median crossings for up to a second cycle, so > 45 s may reach ~15 %; a jam
  // shows as > 90 s, two full cycles)
  // (P5: the 120 s cycle's longest red is 82 s, so the lines are one red (90 s) and two (180 s))
  const road = T.vehicles.filter((v) => !v.hidden && !v.lane.shared), s45 = road.filter((v) => still.get(v.id) > 90).length, s90 = road.filter((v) => still.get(v.id) > 180).length;
  ok(s45 < 0.15 * road.length && s90 < 0.03 * road.length, `liveness at 300 s: ${s45}/${road.length} road vehicles stopped > 90 s (< 15 %), ${s90} > 180 s (< 3 %)`);
  ok((ev.kneel || 0) >= 5, `buses kneel at stops (${ev.kneel || 0} in 300 s: the hiss has something to play)`);
  ok((ev.unstick || 0) <= 12, `watchdog rarely needed (${ev.unstick || 0} unsticks in 300 s)`);
  const ty = {}; for (const v of T.vehicles) if (!v.hidden) ty[v.type] = (ty[v.type] || 0) + 1;
  ok(ty.scooter >= 20 && ty.scooter <= 60, `about 40 scooters (${ty.scooter}), P1 had 161`);
  ok(ty.taxi / (ty.taxi + ty.car) > 0.33, `taxis ~45 % of cars (${(ty.taxi / (ty.taxi + ty.car)).toFixed(2)})`);
  const E = [...T.entries.road, ...T.entries.shared];
  ok(T.entries.road.every((l) => l.start && l.start.boundary), `road traffic re-enters only at map-edge lanes (${T.entries.road.length})`);
  void E;
}
// (P7, life #1) station2 (31.8, -309, the game's seed 11): its near carriageway was empty at take clock 0 (one car on eight
// lanes: the still opened in the lull between Yanghwa-ro's eastbound platoons). >= 6 vehicles heading +x within 60 m, at
// take clock 0 and through the first 15 s of a take
{
  const L = new LifeSim(layout, { seed: 11 }), T = L.traffic, o = {}; let at0 = -1, mn = 1e9, mv0 = 0;
  for (let t = LIFE.warm + 0.5; t <= LIFE.warm + 15; t += 0.5) { L.advanceTo(t); let n = 0, mv = 0;
    for (const v of T.vehicles) { if (v.hidden || v.lane.shared) continue; const ln = v.lane; ln.base.at(T.toBase(ln, v.s), o);
      const x = o.x + o.nx * ln.lat, z = o.z + o.nz * ln.lat; if (Math.hypot(x - 31.8, z + 309) < 60 && o.tx * ln.dir > 0.3) { n++; if (v.v > 1) mv++; } }
    if (at0 < 0) { at0 = n; mv0 = mv; } mn = Math.min(mn, n); }
  ok(at0 >= 6 && mn >= 6, `station2: ${at0} vehicles heading +x within 60 m at take clock 0 (${mv0} moving), >= ${mn} through 15 s (P6: 3, min 1)`);
}
// junction conflicts (life #3, P3): vehicle boxes that interpenetrate > 0.1 m, sampled every second from 30 s to 600 s.
// P2 had ~3.7 pairs per sample, 85 % on crossing paths in junction boxes.
{
  const pen = (a, b) => { const ax = [[a.h[0], a.h[1]], [a.h[1], -a.h[0]]], bx = [[b.h[0], b.h[1]], [b.h[1], -b.h[0]]], ah = [a.half[2], a.half[0]], bh = [b.half[2], b.half[0]], d = [b.c[0] - a.c[0], b.c[2] - a.c[2]]; let m = Infinity;
    for (const n of [...ax, ...bx]) { const ra = ah[0] * Math.abs(n[0] * ax[0][0] + n[1] * ax[0][1]) + ah[1] * Math.abs(n[0] * ax[1][0] + n[1] * ax[1][1]), rb = bh[0] * Math.abs(n[0] * bx[0][0] + n[1] * bx[0][1]) + bh[1] * Math.abs(n[0] * bx[1][0] + n[1] * bx[1][1]); m = Math.min(m, ra + rb - Math.abs(d[0] * n[0] + d[1] * n[1])); }
    return m; };
  const J = new LifeSim(layout, { seed: 7 }), byId = new Map(J.traffic.vehicles.map((v) => [v.id, v])); let road = 0, alley = 0, S = 0;
  for (let t = 30; t <= 600; t += 1) { const B = J.boxesAt(t).map((b) => ({ ...b })); S++;
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) { const a = B[i], b = B[j]; if (Math.abs(a.c[0] - b.c[0]) > 14 || Math.abs(a.c[2] - b.c[2]) > 14 || pen(a, b) <= 0.1) continue;
      if (byId.get(a.id).lane.shared || byId.get(b.id).lane.shared) alley++; else road++; } }
  ok(road <= 5 && alley <= 15, `junction boxes: ${road} road + ${alley} alley vehicle pairs interpenetrate in ${S} samples over 600 s (P2: ~3.7 per sample)`);
}
// hit test
const v0 = a.traffic.vehicles.find((v) => !v.hidden && v.type !== 'scooter'), B = a.boxesAt(90); const bx = B.find((q) => q.id === v0.id);
ok(!!a.hit([bx.c[0], bx.c[1] + bx.half[1] + 0.1, bx.c[2]], 0.2, 90), 'sphere on a roof hits'); ok(!a.hit([bx.c[0], 40, bx.c[2]], 0.2, 90), 'sphere high above misses');
// cost (traffic; the crowd is closed-form, costed above)
const p = new LifeSim(layout, { seed: 11 }); let t0 = performance.now(); p.advanceTo(60); const ms = performance.now() - t0;
// (P4) per frame the game steps a warm sim (it opens at take clock + warm), so the step is costed after the first 10 s, when
// the movement caches have filled; the warm start itself is a load cost, gated on its own
const [perStepT, warmMs] = (() => { const q = new LifeSim(layout, { seed: 12 }); const w0 = process.cpuUsage(); for (let i = 0; i < LIFE.warm * LIFE.trafficHz; i++) q.traffic.step(); const w = process.cpuUsage(w0);
  const c0 = process.cpuUsage(); for (let i = 0; i < 600; i++) q.traffic.step(); const c = process.cpuUsage(c0); return [(c.user + c.system) / 1000 / 600, (w.user + w.system) / 1000]; })();
console.log(`cost: 60 s of traffic in ${ms.toFixed(0)} ms; warm start (${LIFE.warm} s) ${warmMs.toFixed(0)} ms CPU at load; traffic step ${perStepT.toFixed(3)} ms CPU (60 Hz) -> ${(perStepT * 60).toFixed(2)} ms/s of sim`);
ok(perStepT * 60 < 30 && warmMs < 3000, 'traffic cost < 30 ms per second of take; warm start < 3 s at load');
// rewinds are cheap: snapshots every 10 s
{ const q = new LifeSim(layout, { seed: 7 }); q.advanceTo(300); const h = q.hash(); const c0 = process.cpuUsage(); q.advanceTo(295); q.advanceTo(300); const c = process.cpuUsage(c0);
  ok(q.hash() === h, 'snapshot rewind reproduces the traffic bit for bit'); ok((c.user + c.system) / 1000 < 400, `rewind 5 s at t=300 costs ${((c.user + c.system) / 1000).toFixed(0)} ms CPU (P1: a full re-sim from 0)`); }
// life #1 (P3): the Rocketbox avatar LODs (seoul/people) parse, fit their budgets and use only the crowd rig's bones
if (existsSync('seoul/people/people.json')) {
  const meta = JSON.parse(readFileSync('seoul/people/people.json', 'utf8')), b = readFileSync('seoul/people/people.bin'), bin = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  let bad = 0; const tris = [[], [], []];
  for (const av of meta.avatars) av.lods.forEach((L, k) => { tris[k].push(L.tris); const bd = new Uint8Array(bin, L.bone, L.verts * 4), ix = new Uint16Array(bin, L.index, L.tris * 3), p = new Float32Array(bin, L.pos, L.verts * 3);
    for (let i = 0; i < L.verts; i++) { const b1 = bd[i * 4], b2 = bd[i * 4 + 1], r = bd[i * 4 + 3]; if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14].includes(b1) || ![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14].includes(b2) || r > 11 || r === 7 || r === 9 || !isFinite(p[i * 3 + 1])) bad++; }   // (P8: + 8 cap, 10 backpack, 11 beanie)
    for (const q of ix) if (q >= L.verts) bad++; });
  ok(meta.avatars.length >= 22 && meta.avatars.filter((a) => a.ea).length >= 14 && bad === 0 && Math.max(...tris[0]) <= 3600 && Math.max(...tris[1]) <= 1800 && Math.max(...tris[2]) <= 900 && meta.avatars.every((a) => a.mean && a.joints.top > 1.6 && a.joints.top < 1.95),
    `avatars: ${meta.avatars.length} (${meta.avatars.filter((a) => a.sex === 'm').length} men, ${meta.avatars.filter((a) => a.ea).length} East Asian, ${meta.avatars.filter((a) => a.head).length} made from two donors; P5: 8, 0; P7: 14, 6), near ${Math.max(...tris[0])} / lod1 ${Math.max(...tris[1])} / mid ${Math.max(...tris[2])} tris, ${bad} bad vertices, ${(b.byteLength / 1024).toFixed(0)} KB (MIT, Microsoft Rocketbox)`);
  const lifeMod = await import('../seoul-life.js'), THREE = await import('three');
  const L2 = lifeMod.build(layout, { audio: false, scene: new THREE.Scene(), peopleData: { meta, bin } }), cam = new THREE.Vector3(-36, 3, -23), qq = new THREE.Quaternion();
  for (let k = 0; k < 10; k++) L2.update(10 + k / 30, cam, qq);
  const nAv = L2.avatars.tiers.flat().reduce((a, t) => a + t.n, 0);
  // perf #2 (P4): the people's triangles at the walk0 camera, by tier; suits <= 5 %
  const triP = L2.avatars.tiers.flat().reduce((a, t) => a + t.n * t.tris, 0) + L2.stats.far * L2.stats.trisFar, suit = L2.avatars.tiers.flat().filter((t) => /^crowd-[a-z0-9]+-Business/.test(t.mesh.name))   /* (P9: a suit is the body donor, not a head donor) */.reduce((a, t) => a + t.n, 0);
  const triV = L2.motionMeshes.filter((m) => !m.isInstancedMesh).reduce((a, m) => a + (m.geometry.instanceCount || 0) * (m.geometry.index.count / 3), 0);   // what A's velocity pass redraws
  ok(L2.stats.drawn <= 1500 && triP + triV < 1.3e6 && suit / nAv <= 0.05, `people triangles at walk0: main ${(triP / 1e6).toFixed(2)} M (${L2.stats.drawn} drawn; near ${L2.avatars.tiers[0].reduce((a, t) => a + t.n, 0)} at 3.4k, lod1 ${L2.avatars.tiers[1].reduce((a, t) => a + t.n, 0)} at 1.7k) + velocity ${(triV / 1e6).toFixed(2)} M (P3: 0.8-1.34 M main, every tier redrawn for velocity); suits ${(100 * suit / nAv).toFixed(1)} % (P3 ~25 %)`);
  ok(L2.avatars.ready && nAv > 50 && nAv === L2.stats.near + L2.stats.mid && L2.stats.contacts === nAv && L2.motionMeshes.filter((m) => m.isInstancedMesh).length === 5 && L2.motionMeshes.some((m) => m.count > 0 && m.geometry.attributes.instanceVelocity.array.some((x) => Math.abs(x) > 1))
    && L2.motionMeshes.some((m) => !m.isInstancedMesh && m.geometry.instanceCount > 0 && m.geometry.attributes.instanceVelocity.array.some((x) => Math.abs(x) > 0.5)),
    `render path: ${nAv} near/mid people on avatars, ${L2.stats.contacts} contact shadows, ${L2.motionMeshes.length} meshes with instanceVelocity (5 vehicle types + crowd tiers; A's object blur)`);
  // [P9 G1, perf #6 / life bug: avatar draws rose 36 -> 52 at walk0 in P8 with no gate] the avatar meshes drawn (instanceCount
  // > 0, main pass; the near and lod1 tiers draw again in A's velocity pass) at walk0 / walk180 / w21 / club90 <= 64. P9's
  // per-face weights make the two new faces' bodies common (the suits they replaced were a tenth as common): 52 -> 62 at
  // walk0, the price of 18.8 -> 9.2 % repeated faces. The fix that lowers it is perf #6's BatchedMesh merge (a shader
  // change, for a phase with browser runs)
  { const dr = [];
    for (const [nm, x, z, yaw] of [['walk0', -36, -23, 0], ['walk180', -36, -23, 180], ['w21', -66.7, 88, 0], ['club90', 63.7, 129.6, 90]]) {
      const c = new THREE.Vector3(x, 3, z), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw * Math.PI / 180);
      for (let k = 0; k < 10; k++) L2.update(10 + k / 30, c, q);
      dr.push([nm, L2.avatars.tiers.flat().filter((t) => t.n > 0).length]); }
    ok(dr.every(([, n]) => n <= 64), `avatar draw calls (main pass): ${dr.map(([a, n]) => `${a} ${n}`).join(', ')} (P7 36 at walk0, P8 52; gate 64)`);
    for (let k = 0; k < 10; k++) L2.update(10 + k / 30, cam, qq); }
  // (P6, life #1) a Hongdae crowd: >= 65 % of the near and mid people at walk0 on the East Asian bodies (P5: 0 of 8 avatars);
  // and how often a near person's avatar repeats on another near person within 8 m (reported: 14 bodies can't keep a
  // 0.37 p/m^2 street free of repeats; the per-person clothes, hair and skin tints carry the rest)
  { const meta = JSON.parse(readFileSync('seoul/people/people.json', 'utf8')), ea = L2.avatars.tiers.flat().reduce((a, t, k) => a + (meta.avatars[k % meta.avatars.length].ea ? t.n : 0), 0);
    ok(ea / nAv >= 0.65, `East Asian bodies: ${(100 * ea / nAv).toFixed(0)} % of ${nAv} near/mid people at walk0 (${meta.avatars.length} avatars; P5 0 %)`);
    // (P7, life #2) pairs of people within 8 m of each other (walk0, w21, club90; 25 m round the camera) in the same body and
    // the same tone of top (dark / mid / light): P6 7.6 %; groups, clusters and queues no longer share one (assignAvatars)
    const S = new LifeSim(layout, { seed: 11 }), C = S.crowd, AV = lifeMod.assignAvatars(C.people, meta, lifeMod.avatarWeights(meta)), tone = (i) => lifeMod.tintClass(AV.tops[i] || C.people[i].look.top);
    let pairs = 0, same = 0, sameB = 0, grp = 0, grpSame = 0;
    for (const [cx, cz] of [[-36, -23], [-66.7, 88], [63.7, 129.6]]) for (let t = 75; t < 135; t += 6) {
      C.evaluate(t, null, { avoid: false }); const nr = []; for (let i = 0; i < C.people.length; i++) if (C.VIS[i] && Math.hypot(C.X[i] - cx, C.Z[i] - cz) < 25) nr.push(i);
      for (const i of nr) for (const j of nr) { if (j <= i || Math.hypot(C.X[i] - C.X[j], C.Z[i] - C.Z[j]) > 8) continue; pairs++; const g = C.people[i].unit >= 0 && C.people[i].unit === C.people[j].unit; if (g) grp++;
        if (AV[i] === AV[j]) { sameB++; if (tone(i) === tone(j)) { same++; if (g) grpSame++; } } } }
    // (P8, life #1) and the body alone (tone ignored) <= 8 % (P7 14.0 %: 4 casual East Asian bodies carried 70 %)
    ok(same / pairs <= 0.065 && grpSame === 0 && sameB / pairs <= 0.08, `crowd repeats: ${(100 * same / pairs).toFixed(1)} % of pairs within 8 m share a body and a tone of top (P6 7.6 %; gate 6.5 %), ${grpSame} of ${grp} pairs inside a group; the same body alone ${(100 * sameB / pairs).toFixed(1)} % (P7 14.0 %; gate 8 %)`);
    // [P9 G1, life #3] the same face (head donor) within 8 m <= 10 % (P8 18.8 % in the panel's count, 16.7 % in this one),
    // with >= 75 % of everyone on East Asian bodies and >= 8 East Asian faces
    { let sf = 0; for (const [cx, cz] of [[-36, -23], [-66.7, 88], [63.7, 129.6]]) for (let t = 75; t < 135; t += 6) {
        C.evaluate(t, null, { avoid: false }); const nr = []; for (let i = 0; i < C.people.length; i++) if (C.VIS[i] && Math.hypot(C.X[i] - cx, C.Z[i] - cz) < 25) nr.push(i);
        for (const i of nr) for (const j of nr) if (j > i && Math.hypot(C.X[i] - C.X[j], C.Z[i] - C.Z[j]) <= 8 && lifeMod.faceOf(meta.avatars[AV[i]]) === lifeMod.faceOf(meta.avatars[AV[j]])) sf++; }
      const eaAll = C.people.filter((p, i) => meta.avatars[AV[i]]?.ea).length / C.people.length, eaFaces = new Set(meta.avatars.filter((a) => a.ea && !/^Business/i.test(a.name)).map(lifeMod.faceOf)).size;
      ok(sf / pairs <= 0.10 && eaAll >= 0.75 && eaFaces >= 8, `faces: ${(100 * sf / pairs).toFixed(1)} % of pairs within 8 m share a face (P8 16.7 % here, 18.8 % in G1's P8 count; gate 10 %); ${eaFaces} East Asian faces on casual bodies (P8 6), ${(100 * eaAll).toFixed(0)} % of everyone East Asian`); }
    // (P8, life #1) accessories on the avatars: every LOD of every avatar carries a cap, a beanie, a backpack and a tote
    // (regions 8, 11, 10, 6 on the head / torso bones), shown by the person's style, accessory bits and bag flag
    const has = meta.avatars.every((av) => av.lods.every((L) => { const bd = new Uint8Array(bin, L.bone, L.verts * 4), seen = new Set(); for (let i = 0; i < L.verts; i++) seen.add(bd[i * 4 + 3] * 16 + bd[i * 4]); return seen.has(8 * 16 + 1) && seen.has(11 * 16 + 1) && seen.has(10 * 16) && seen.has(6 * 16); }));
    const P = C.people, ns = P.length, cap = P.filter((q) => q.look.style === 5).length / ns, bea = P.filter((q) => q.look.style === 7).length / ns, bp = P.filter((q) => q.look.acc & 2).length / ns, tote = P.filter((q) => q.look.bag).length / ns, puf = P.filter((q) => q.look.coat === 2).length / ns;
    ok(has, `avatar accessories in every LOD (cap, beanie, backpack, tote; P7 none): caps ${(100 * cap).toFixed(0)} %, beanies ${(100 * bea).toFixed(0)} %, backpacks ${(100 * bp).toFixed(0)} %, totes ${(100 * tote).toFixed(0)} %, puffers ${(100 * puf).toFixed(0)} % of people`); }
}
// (P8, life: keep people off E's puddles; seoul-dressing `puddles`, snapshot in tests/seoul-life-dressing.json) nobody
// standing or queueing is drawn in one (P7: 40 person-samples of 2638), and walkers within 25 m of walk0, w21, club90/270
// and the station step round them (P7: 1.34 % of samples inside one)
if (existsSync('tests/seoul-life-dressing.json') && file === 'seoul/layout.json') {
  const D = JSON.parse(readFileSync('tests/seoul-life-dressing.json', 'utf8'));
  if (D.puddles) {
    const inP = (x, z) => D.puddles.some(([px, pz, tx, tz, a, b]) => { const dx = x - px, dz = z - pz, u = (dx * tx + dz * tz) / (a - 0.1), v = (dz * tx - dx * tz) / (b - 0.1); return u * u + v * v < 1; });
    const S = new LifeSim(layout, { seed: 11, setPieces: D.setPieces, obstacles: D.obstacles, puddles: D.puddles }), C = S.crowd;
    let bad = 0, n = 0; for (const t of [100, 160, 220]) { C.evaluate(t, null, { avoid: false }); for (const i of C.statics) { if (!C.VIS[i]) continue; n++; if (inP(C.X[i], C.Z[i])) bad++; } }
    let inW = 0, nW = 0;
    for (const [cx, cz] of [[-36, -23], [-66.7, 88], [63.7, 129.6], [-120, 95]]) for (let t = 75; t < 135; t += 3) {
      C.evaluate(t, { x: cx, z: cz, fx: null, fz: null });
      for (let i = 0; i < C.people.length; i++) { if (!C.VIS[i] || C.people[i].kind !== K_WALK || Math.hypot(C.X[i] - cx, C.Z[i] - cz) > 25) continue; nW++; if (inP(C.X[i], C.Z[i])) inW++; } }
    ok(bad === 0 && inW / nW <= 0.004, `people off the puddles (${D.puddles.length}): ${bad} of ${n} standing / queueing samples in one (P7 40), walkers ${(100 * inW / nW).toFixed(2)} % of ${nW} near-camera samples (P7 1.34 %; gate 0.4 %)`);
  }
}
// (P7, perf #1 with D) vehicles are culled for drawing (render only): behind the camera and past VCULL.far nothing is drawn;
// every vehicle within VCULL.near still is. P6 drew all ~171 at every pose (0.46 M triangles a pass)
{
  const lifeMod = await import('../seoul-life.js'), THREE = await import('three');
  const L = lifeMod.build(layout, { audio: false, people: false, scene: new THREE.Scene(), lifeWorker: false, preroll: false, seed: 11 });
  const ims = []; L.group.traverse((o) => { if (o.isInstancedMesh && o.geometry.attributes.iState) ims.push(o); });
  const q = new THREE.Quaternion(), res = [];
  for (const [x, y, z, yaw] of [[-36, 3, -23, 0], [31.8, 8, -309, Math.PI], [-66.7, 3, 88, 0]]) {
    const cam = new THREE.Vector3(x, y, z); q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw); for (let k = 0; k < 3; k++) L.update(0.3 + k / 30, cam, q);
    let tris = 0, behind = 0, nearMiss = 0; const M = new THREE.Matrix4(), P = new THREE.Vector3(), fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    for (const m of ims) { tris += m.count * m.geometry.index.count / 3; for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, M); P.setFromMatrixPosition(M).sub(cam); if (P.length() > 40 && P.dot(fwd) < -0.3 * P.length()) behind++; } }
    const T = L.sim.traffic; for (const v of T.vehicles) { if (v.hidden) continue; const p = T.pose(v, L.sim.aT, {}); if (Math.hypot(p.x - x, p.z - z) < lifeMod.VCULL.near - 3) { let found = false; for (const m of ims) for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, M); P.setFromMatrixPosition(M); if (Math.hypot(P.x - p.x, P.z - p.z) < 0.5) found = true; } if (!found) nearMiss++; } }
    res.push({ tris, behind, nearMiss }); }
  ok(res.every((r) => r.tris < 0.3e6 && r.behind === 0 && r.nearMiss === 0), `vehicles culled for drawing: ${res.map((r) => (r.tris / 1e6).toFixed(2)).join(' / ')} M triangles a pass at walk0 / station2 / w21 (P6 0.46 M at every pose), none drawn behind the camera, none missing within ${lifeMod.VCULL.near - 3} m`);
}
// life #4 (P4): people react to a low drone (render side; the soft colliders stay on the sim's positions). A walker the drone
// hovers beside at 1.5 m height is drawn slower (0.4x), stepped aside ~0.5 m away from it, and flinches on the first moment.
{
  const lifeMod = await import('../seoul-life.js'), THREE = await import('three');
  const L3 = lifeMod.build(layout, { audio: false, people: false, scene: new THREE.Scene() }), C3 = L3.crowd, q0 = new THREE.Quaternion();
  C3.evaluate(140, null, { avoid: false }); let wi = -1;
  // (P5: 1 person in 3 ducks: pick one of those)
  // (P6: with counterflow on the walkways the first such walker was walking upstream through 25 people within 3 m, and the
  // crowd's avoidance, not the drone, set where it was drawn: pick one with nobody else within 1.5 m)
  const alone = (i) => { for (let j = 0; j < C3.people.length; j++) if (j !== i && C3.VIS[j] && Math.abs(C3.X[j] - C3.X[i]) < 1.5 && Math.hypot(C3.X[j] - C3.X[i], C3.Z[j] - C3.Z[i]) < 1.5) return false; return true; };
  for (let i = 0; i < C3.people.length; i++) if (C3.people[i].kind === K_WALK && C3.VIS[i] && C3.WALK[i] > 0.9 && Math.hypot(C3.X[i] + 36, C3.Z[i] + 23) < 40 && lifeMod.h32(i, 0xf11c) % 3 === 0 && alone(i)) { wi = i; break; }
  let flinch = false, minD = 9, aside = 0, off = 0, sx = 0;
  const posOf = () => { for (const T of [...L3.group.children]) { const g = T.geometry; if (!g?.isInstancedBufferGeometry || !g.attributes.iLook || !/crowd/.test(T.name)) continue; for (let k = 0; k < g.instanceCount; k++) if (g.attributes.iLook.array[k * 4 + 3] === Math.fround(((C3.people[wi].id * 2654435761) >>> 0) / 4294967296)) return [g.attributes.iPos.array[k * 4], g.attributes.iPos.array[k * 4 + 2], g.attributes.iAnim.array[k * 4 + 2], g.attributes.iAnim.array[k * 4 + 1]]; } return null; };
  for (let k = 0; k < 60; k++) {   // 2 s at 30 fps, the camera 1.6 m beside the walker at 1.5 m
    const t = 140 - LIFE.warm + k / 30; C3.evaluate(t + LIFE.warm, null, { avoid: false });
    const yx = Math.sin(C3.YAW[wi]), yz = Math.cos(C3.YAW[wi]), cam = new THREE.Vector3(C3.X[wi] + yz * 1.6, 1.5, C3.Z[wi] - yx * 1.6);
    L3.update(t, cam, q0); const P = posOf(); if (!P) continue;
    C3.evaluate(t + LIFE.warm, null, { avoid: false });
    if (P[2] === 10) flinch = true; off = Math.hypot(P[0] - C3.X[wi], P[1] - C3.Z[wi]); sx = (P[0] - C3.X[wi]) * yz - (P[1] - C3.Z[wi]) * yx; aside = Math.max(aside, -sx);
    minD = Math.min(minD, Math.hypot(P[0] - cam.x, P[1] - cam.z));
  }
  ok(wi >= 0 && flinch && aside > 0.3 && off < 3.5, `a low drone 1.6 m off a walker: flinch ${flinch}, stepped ${aside.toFixed(2)} m away, drawn ${off.toFixed(2)} m from its collider (P3: walked into the lens at 1.65 m)`);
}
// life #4 / fpv #3 (P5): no ghost walkers. In a hover (the drone still at 2.2 m over the walking street's footway, 3 s at
// 60 fps) every near-tier instance's instanceVelocity (what A's object blur smears by) must match how far that person is
// actually drawn moving frame to frame, and nobody may jump: a smear on someone standing, or a pop, is a ghost.
{
  const lifeMod = await import('../seoul-life.js'), THREE = await import('three');
  const L4 = lifeMod.build(layout, { audio: false, people: false, scene: new THREE.Scene() }), q0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2.2);
  const cam = new THREE.Vector3(-36, 2.2, -23), near = L4.group.children.find((m) => m.name === 'crowd-near'), T0 = near.geometry.attributes;
  const tier = L4.group.children.filter((m) => /^crowd-near/.test(m.name));
  let prev = new Map(), n = 0, smear = 0, jump = 0, worst = 0;
  for (let k = 0; k < 180; k++) {
    const t = 30 + k / 60; L4.update(t, cam, q0);
    const cur = new Map(), pid = L4.tierPids?.(0) || null; if (!pid) break;
    for (let s = 0; s < near.geometry.instanceCount; s++) {
      const i = pid[s], x = T0.iPos.array[s * 4], z = T0.iPos.array[s * 4 + 2], v = Math.hypot(T0.instanceVelocity.array[s * 3], T0.instanceVelocity.array[s * 3 + 2]); cur.set(i, [x, z]);
      const p = prev.get(i); if (!p || k === 0) continue; n++;
      const act = Math.hypot(x - p[0], z - p[1]) * 60;
      if (act > 3.5) jump++; else if (Math.abs(v - act) > 0.9) { smear++; worst = Math.max(worst, Math.abs(v - act)); }
    }
    prev = cur; void tier;
  }
  ok(n > 2000 && smear <= 0.005 * n && jump <= 0.001 * n, `hover: ${n} near-tier instance-frames, ${smear} whose blur velocity is off their drawn motion by > 0.9 m/s (worst ${worst.toFixed(2)}), ${jump} jumps > 3.5 m/s (ghost walkers, fpv #3)`);
}
// life #6 (P5): a fresh tableau per attempt. Retry n opens the city at warm + attemptTicks(n) / 240 s (75-240 s in, not
// past the pre-roll), the movers collide with the vehicles drawn (P4: the movers ran 75 s behind the screen), and a jump
// to a later city restores the pre-roll's snapshots instead of re-simulating.
{
  const lifeMod = await import('../seoul-life.js'), THREE = await import('three'), { lifeMovers } = await import('../seoul-movers.js');
  const L5 = lifeMod.build(layout, { audio: false, people: false, scene: new THREE.Scene() });
  // (P6, perf bug 1) 350 frames of update()'s work (the drawn city, 8 pre-roll steps), then a retry: P5 returned +0 here (the
  // pre-roll re-simulated the warm start from 0), so a slow device retried on the same city
  for (let k = 0; k < 350; k++) { L5.sim.advanceTo(LIFE.warm + k / 60); L5.sim.preroll(8); }
  const a0 = L5.attemptTicks(1); let pr = 0; const tp = performance.now(); while (pr < LIFE.warmMax + 15) pr = L5.sim.preroll(600); const prMs = performance.now() - tp;
  const W = L5.colliders.warm, ws = [1, 2, 3, 4, 5, 6].map((n) => W + L5.attemptTicks(n) / 240);
  const M = lifeMovers(L5); let same = 0, tried = 0, worstMs = 0;
  for (const n of [3, 1, 5]) {
    // (P6) CPU time, not wall clock: P5's 500 ms gate failed once at 632 ms while the browser and audio renders shared the box
    const t0 = L5.attemptTicks(n) / 240 + 2.5, a = process.cpuUsage(); const B = L5.colliders.at(t0, []); const c = process.cpuUsage(a); worstMs = Math.max(worstMs, (c.user + c.system) / 1000);
    for (const b of B.filter((x) => x.type !== 'scooter').slice(0, 6)) { tried++; const h = M.hit([b.c[0], b.c[1], b.c[2]], 0.1, t0); if (h && h.kind === 'vehicle' && h.id === b.id) same++; }
  }
  ok(a0 > 0 && new Set(ws.map((w) => w.toFixed(2))).size >= 5 && ws.every((w) => w >= W && w <= LIFE.warmMax) && Math.max(...ws) - Math.min(...ws) > 60 && same === tried && tried >= 12 && worstMs < 500,
    `fresh tableau per retry: warm ${ws.map((w) => w.toFixed(0)).join(' / ')} s (after 350 frames: +${(a0 / 240).toFixed(1)} s, P5 +0; pre-roll to ${pr.toFixed(0)} s ${prMs.toFixed(0)} ms in all); the movers hit the drawn vehicle ${same}/${tried}; a jump costs <= ${worstMs.toFixed(0)} ms CPU`);
}
// [P9 G1, perf #2: the retry hitch] each retry's opening city keeps an exact traffic snapshot (LIFE.retryKeep of them), so
// a retry restores it in 0 steps (P8: up to 10 s re-simulated, ~200 ms of the panel's 403 ms frame), bit-identically; and
// [ux #1] the iPhone's phone preset builds a quarter of auto's agents (desktop ?preset=phone and CI keep half)
{
  const lifeMod = await import('../seoul-life.js'), THREE = await import('three');
  const L9 = lifeMod.build(layout, { audio: false, people: false, scene: new THREE.Scene(), lifeWorker: false });
  for (let k = 0; k < 30; k++) L9.sim.advanceTo(LIFE.warm + k / 60);
  while (!(L9.sim.prerolled >= LIFE.warmMax + 15)) L9.sim.preroll(600);
  let exact = 0, steps = 0, bad = 0; const n9 = [1, 4, 9, LIFE.retryKeep];
  for (const n of n9) {
    const t = L9.colliders.warm + L9.attemptTicks(n) / 240, nt = Math.floor(t * LIFE.trafficHz + 1e-9);
    if (L9.sim.snaps.has(nt)) exact++;
    const T = L9.sim.traffic, s0 = { n: 0 }; const st = T.step.bind(T); T.step = () => { s0.n++; st(); };
    L9.sim.advanceTo(t); T.step = st; steps = Math.max(steps, s0.n);
    const ref = new LifeSim(layout, { seed: 7 }); ref.advanceTo(t); if (ref.hash() !== L9.sim.hash()) bad++;
  }
  const mk = (ios, quality) => lifeMod.build(layout, { audio: false, people: false, scene: new THREE.Scene(), lifeWorker: false, ios, quality });
  const a = mk(true, 'low'), b = mk(false, 'low'), c = mk(true, 'auto');
  ok(exact === n9.length && steps === 0 && !bad && a.maxAgents === Math.round(LIFE.maxAgents * 0.25) && b.maxAgents === Math.round(LIFE.maxAgents * 0.5) && c.maxAgents === LIFE.maxAgents,
    `retries ${n9.join(', ')} open on a kept snapshot (${exact}/${n9.length}), ${steps} traffic steps to get there (P8 up to 600), ${bad} hash mismatches against a sim stepped from 0; ` +
    `agents: iPhone phone preset ${a.maxAgents} (${a.stats.agents} built), desktop phone preset ${b.maxAgents}, iPhone auto ${c.maxAgents}`);
  for (const L of [L9, a, b, c]) L.dispose();
}
// life #2 (P4): vehicles right side out. P3's box() wound every face against its normal and the loft was wound inward (98 % of
// a car's body faced in: a close taxi showed its far panel's inside, buses were hollow). Per primitive: >= 95 % of each part's
// triangles face away from the primitive's centre (the loft: its spine) and agree with their vertex normals.
{
  const { vehicleGeo, VEH } = await import('../seoul-life.js');
  const worst = []; let allOk = true;
  for (const ty of ['car', 'taxi', 'truck', 'bus', 'scooter']) {
    const g = vehicleGeo(ty), P = g.attributes.position.array, N = g.attributes.normal.array, I = g.index.array, part = g.attributes.part.array, hl = VEH[ty].L / 2, by = {};
    for (const pr of g.userData.prims) for (let t = pr.start; t < pr.start + pr.count; t++) {
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; if (Math.hypot(nx, ny, nz) < 1e-10) continue;
      const mx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, my = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3, mz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
      const ref = pr.kind === 'loft' ? [0, 0.45, Math.max(-hl + 0.6, Math.min(hl - 0.6, mz))] : pr.c;
      const k = part[a]; by[k] ??= [0, 0, 0]; by[k][0]++;
      if ((mx - ref[0]) * nx + (my - ref[1]) * ny + (mz - ref[2]) * nz > 0) by[k][1]++;
      if ((N[a * 3] + N[b * 3] + N[c * 3]) * nx + (N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1]) * ny + (N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2]) * nz > 0) by[k][2]++;
    }
    for (const [k, v] of Object.entries(by)) { const o = v[1] / v[0], n = v[2] / v[0]; worst.push([`${ty}:${k}`, o, n]); if (o < 0.95 || n < 0.95) allOk = false; }
  }
  worst.sort((p, q) => Math.min(p[1], p[2]) - Math.min(q[1], q[2]));
  // (P7, life #4) a part id never interpolates through others across a visible triangle (P6's bus rear: paint 0 to glass 5
  // drew a headlamp-white and a tail-red band across the rear). The bus loft's 6 mm ledges at the window band (part 0 to
  // 5 at one height) are the only blends left: <= 0.2 m2 in all, none on an end face
  { let ends = 0, area = 0, rear = 0; for (const ty of ['car', 'taxi', 'truck', 'bus', 'scooter']) { const g = vehicleGeo(ty), P = g.attributes.position.array, I = g.index.array, part = g.attributes.part.array;
      for (let t = 0; t < I.length; t += 3) { const [a, b, c] = [I[t], I[t + 1], I[t + 2]]; if (ty === 'bus' && part[a] === 13) rear++;
        if (Math.max(part[a], part[b], part[c]) - Math.min(part[a], part[b], part[c]) <= 1) continue;
        const u = [0, 1, 2].map((k) => P[b * 3 + k] - P[a * 3 + k]), v = [0, 1, 2].map((k) => P[c * 3 + k] - P[a * 3 + k]), n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n);
        area += l / 2; if (l > 0 && Math.abs(n[2]) / l > 0.5) ends++; } }
    ok(ends === 0 && area <= 0.2 && rear >= 12, `vehicle parts never blend across an end face (${ends}; P6: 4, 3.24 m2 in all), ${area.toFixed(2)} m2 of ledges; the bus has a rear window panel (${rear} triangles)`); }
  ok(allOk, `vehicles right side out: every part of car/taxi/truck/bus/scooter >= 95 % outward and normal-true (worst ${worst[0][0]} ${(100 * worst[0][1]).toFixed(0)} % / ${(100 * worst[0][2]).toFixed(0)} %; P3: car body 2 %, glass 0 %)`);
}
// life #1 (P4): masks where masks go, and no dark hair cards on a brown or blond scalp. seoul/people/aux.png (people-aux.py):
// r = painted scalp hair (re-tinted like the cards), g = the face mask. Every avatar, near and mid LOD: the eyes are never
// under the mask; the lower face between the nose tip and the chin is; the hair cards lie over scalp hair.
if (existsSync('seoul/people/aux.png')) {
  const { inflateSync } = await import('zlib');
  const png = (buf) => {   // 8-bit RGB / RGBA, non-interlaced
    let o = 8, w = 0, h = 0, ct = 0; const idat = [];
    while (o < buf.length) { const len = buf.readUInt32BE(o), ty = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
      if (ty === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } else if (ty === 'IDAT') idat.push(d); o += 12 + len; }
    const bpp = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 2, raw = inflateSync(Buffer.concat(idat)), out = new Uint8Array(w * h * bpp), st = w * bpp;
    for (let y = 0; y < h; y++) { const f = raw[y * (st + 1)], src = raw.subarray(y * (st + 1) + 1, (y + 1) * (st + 1));
      for (let x = 0; x < st; x++) { const a = x >= bpp ? out[y * st + x - bpp] : 0, b = y ? out[(y - 1) * st + x] : 0, c = x >= bpp && y ? out[(y - 1) * st + x - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        out[y * st + x] = (src[x] + (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; } }
    return { w, h, bpp, px: out };
  };
  const A = png(readFileSync('seoul/people/aux.png')), meta = JSON.parse(readFileSync('seoul/people/people.json', 'utf8')), bb = readFileSync('seoul/people/people.bin'), bin = bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength);
  // (P6) R atlas rows of 1024 px (the shader's uRows): 2 for the 8-avatar bake, 4 for the 14-avatar one
  const NR = Math.max(1, Math.round((meta.atlas?.h || 2048) / (2 * (meta.atlas?.cell || 512))));   // (P8: rows of 2 x cell px)
  const aux = (u, v, ch) => { const vt = 1 - v, rw = Math.floor(vt * NR), loc = (vt - (rw + 0.5) / NR) * 2 * NR; if (loc <= 0 || loc >= 1) return -1;
    const x = Math.min(A.w - 1, Math.floor(u * A.w)), y = Math.min(A.h - 1, Math.floor(((rw + loc) / NR) * A.h)); return A.px[(y * A.w + x) * A.bpp + ch] / 255; };
  const rows = []; let good = true;
  for (const av of meta.avatars) for (const [li, L] of av.lods.entries()) {
    const P = new Float32Array(bin, L.pos, L.verts * 3), UV = new Float32Array(bin, L.uv, L.verts * 2), Bn = new Uint8Array(bin, L.bone, L.verts * 4), F = av.face;
    let eyes = 0, eyeHit = 0, low = 0, lowHit = 0, cards = 0, onHair = 0; const scalp = [];
    for (let i = 0; i < L.verts; i++) { if (Bn[i * 4] !== 1) continue; const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], r = Bn[i * 4 + 3];
      if (r === 0) { const g = aux(UV[i * 2], UV[i * 2 + 1], 1); if (g < 0) continue; scalp.push([x, y, z, aux(UV[i * 2], UV[i * 2 + 1], 0)]);
        if (z > F.noseZ - 0.05 && Math.abs(Math.abs(x) - 0.032) < 0.012 && Math.abs(y - F.eyeY) < 0.008) { eyes++; if (g > 0.1) eyeHit++; }
        if (z > F.noseZ - 0.04 && Math.abs(x) < 0.03 && y > F.chinY + 0.008 && y < F.noseY - 0.004) { low++; if (g > 0.5) lowHit++; } } }
    for (let i = 0; i < L.verts; i++) { if (Bn[i * 4] !== 1 || Bn[i * 4 + 3] !== 1) continue; const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      if (Math.abs(y - F.eyeY) < 0.02 && z > F.noseZ - 0.06) continue; cards++;   // (lashes are cards too)
      let best = null, bd = 1e9; for (const q of scalp) { const d = (q[0] - x) ** 2 + (q[1] - y) ** 2 + (q[2] - z) ** 2; if (d < bd) { bd = d; best = q; } }
      if (!best || best[3] > 0.5 || bd > 0.03 * 0.03) onHair++; }   // (a card standing off the head counts: nothing under it)
    const e = eyes ? eyeHit / eyes : 0, m = low ? lowHit / low : 0, c = cards ? onHair / cards : 1;
    rows.push(`${av.name.replace(/_Adult|usiness/g, '')}${li ? 'm' : 'n'} ${eyeHit}/${eyes} ${(100 * m).toFixed(0)}% ${(100 * c).toFixed(0)}%`);
    // (P6: the mid LODs of some of the new bodies keep no vertex within 8 mm of the eye line: nothing to sample there, and the
    // mid LOD shares the near LOD's UVs and mask; the near LOD must still have eye samples)
    if (!((eyes >= 1 || li > 0) && eyeHit === 0 && low >= 3 && m >= 0.9 && c >= 0.75)) good = false;
  }
  ok(good, `face masks and scalp (eyes under the mask / lower face masked / hair cards over scalp hair), all ${meta.avatars.length} avatars near+mid: ${rows.join(', ')}`);
}
// native export (H): life.json round-trips through JSON and carries the parity hash
{ const d = JSON.parse(JSON.stringify(exportData(layout, { seed: 7 }))); ok(d.lanes.length === a.traffic.lanes.length && d.walkways.length === a.crowd.ways.length && d.parity.trafficHash90 === ha[ha.length - 1], `exportData(): life.json with ${d.lanes.length} lanes, ${d.walkways.length} walkways, ${d.crowd.units.length} units, parity hash ${d.parity.trafficHash90}`); }
process.exit(fail ? 1 : 0);
