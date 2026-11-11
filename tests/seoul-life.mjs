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
  const road = T.vehicles.filter((v) => !v.hidden && !v.lane.shared), s45 = road.filter((v) => still.get(v.id) > 45).length, s90 = road.filter((v) => still.get(v.id) > 90).length;
  ok(s45 < 0.15 * road.length && s90 < 0.03 * road.length, `liveness at 300 s: ${s45}/${road.length} road vehicles stopped > 45 s (< 15 %), ${s90} > 90 s (< 3 %)`);
  ok((ev.kneel || 0) >= 5, `buses kneel at stops (${ev.kneel || 0} in 300 s: the hiss has something to play)`);
  ok((ev.unstick || 0) <= 12, `watchdog rarely needed (${ev.unstick || 0} unsticks in 300 s)`);
  const ty = {}; for (const v of T.vehicles) if (!v.hidden) ty[v.type] = (ty[v.type] || 0) + 1;
  ok(ty.scooter >= 20 && ty.scooter <= 60, `about 40 scooters (${ty.scooter}), P1 had 161`);
  ok(ty.taxi / (ty.taxi + ty.car) > 0.33, `taxis ~45 % of cars (${(ty.taxi / (ty.taxi + ty.car)).toFixed(2)})`);
  const E = [...T.entries.road, ...T.entries.shared];
  ok(T.entries.road.every((l) => l.start && l.start.boundary), `road traffic re-enters only at map-edge lanes (${T.entries.road.length})`);
  void E;
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
const perStepT = (() => { const q = new LifeSim(layout, { seed: 12 }); const c0 = process.cpuUsage(); for (let i = 0; i < 600; i++) q.traffic.step(); const c = process.cpuUsage(c0); return (c.user + c.system) / 1000 / 600; })();
console.log(`cost: 60 s of traffic in ${ms.toFixed(0)} ms; traffic step ${perStepT.toFixed(3)} ms CPU (60 Hz) -> ${(perStepT * 60).toFixed(2)} ms/s of sim`);
ok(perStepT * 60 < 30, 'traffic cost < 30 ms per second of take');
// rewinds are cheap: snapshots every 10 s
{ const q = new LifeSim(layout, { seed: 7 }); q.advanceTo(300); const h = q.hash(); const c0 = process.cpuUsage(); q.advanceTo(295); q.advanceTo(300); const c = process.cpuUsage(c0);
  ok(q.hash() === h, 'snapshot rewind reproduces the traffic bit for bit'); ok((c.user + c.system) / 1000 < 400, `rewind 5 s at t=300 costs ${((c.user + c.system) / 1000).toFixed(0)} ms CPU (P1: a full re-sim from 0)`); }
// life #1 (P3): the Rocketbox avatar LODs (seoul/people) parse, fit their budgets and use only the crowd rig's bones
if (existsSync('seoul/people/people.json')) {
  const meta = JSON.parse(readFileSync('seoul/people/people.json', 'utf8')), b = readFileSync('seoul/people/people.bin'), bin = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  let bad = 0; const tris = [[], []];
  for (const av of meta.avatars) av.lods.forEach((L, k) => { tris[k].push(L.tris); const bd = new Uint8Array(bin, L.bone, L.verts * 4), ix = new Uint16Array(bin, L.index, L.tris * 3), p = new Float32Array(bin, L.pos, L.verts * 3);
    for (let i = 0; i < L.verts; i++) { const b1 = bd[i * 4], b2 = bd[i * 4 + 1], r = bd[i * 4 + 3]; if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14].includes(b1) || ![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14].includes(b2) || r > 6 || !isFinite(p[i * 3 + 1])) bad++; }
    for (const q of ix) if (q >= L.verts) bad++; });
  ok(meta.avatars.length >= 8 && bad === 0 && Math.max(...tris[0]) <= 3600 && Math.max(...tris[1]) <= 900 && meta.avatars.every((a) => a.mean && a.joints.top > 1.6 && a.joints.top < 1.95),
    `avatars: ${meta.avatars.length} (${meta.avatars.filter((a) => a.sex === 'm').length} men), near ${Math.max(...tris[0])} / mid ${Math.max(...tris[1])} tris, ${bad} bad vertices, ${(b.byteLength / 1024).toFixed(0)} KB (MIT, Microsoft Rocketbox)`);
  const lifeMod = await import('../seoul-life.js'), THREE = await import('three');
  const L2 = lifeMod.build(layout, { audio: false, scene: new THREE.Scene(), peopleData: { meta, bin } }), cam = new THREE.Vector3(-36, 3, -23), qq = new THREE.Quaternion();
  for (let k = 0; k < 10; k++) L2.update(10 + k / 30, cam, qq);
  const nAv = L2.avatars.tiers[0].reduce((a, t) => a + t.n, 0) + L2.avatars.tiers[1].reduce((a, t) => a + t.n, 0);
  ok(L2.avatars.ready && nAv > 50 && nAv === L2.stats.near + L2.stats.mid && L2.stats.contacts === nAv && L2.motionMeshes.length === 5 && L2.motionMeshes.some((m) => m.count > 0 && m.geometry.attributes.instanceVelocity.array.some((x) => Math.abs(x) > 1)),
    `render path: ${nAv} near/mid people on avatars, ${L2.stats.contacts} contact shadows, ${L2.motionMeshes.length} vehicle meshes with instanceVelocity (A's object blur)`);
}
// native export (H): life.json round-trips through JSON and carries the parity hash
{ const d = JSON.parse(JSON.stringify(exportData(layout, { seed: 7 }))); ok(d.lanes.length === a.traffic.lanes.length && d.walkways.length === a.crowd.ways.length && d.parity.trafficHash90 === ha[ha.length - 1], `exportData(): life.json with ${d.lanes.length} lanes, ${d.walkways.length} walkways, ${d.crowd.units.length} units, parity hash ${d.parity.trafficHash90}`); }
process.exit(fail ? 1 : 0);
