// seoul/tools/test-seoul.mjs — S1 checks for the Hongdae level (~10 s):  node seoul/tools/test-seoul.mjs [--flights N]
//  1. layout.json and layout.provisional.json follow contract L1
//  2. buildSeoulGeometry is deterministic (two builds, identical position hash)
//  3. every gate of lines.json is clear of the collider (0.25 m), funnels sane
//  4. each straight line scores in take.js when flown through its gates (kinematic pass)
//  5. collision stress: seeded pilots fly Cine / Acro / Angle in the block at 240 Hz; any swept segment through the
//     collider is a pass-through and fails (as tests/stress-lite.mjs does for bando). Cables are 2-4 cm tubes.
import fs from 'node:fs';
import * as THREE from 'three';
import { buildSeoulGeometry } from '../../world-seoul.js';
import { Drone } from '../../flight.js';
import { Take } from '../../take.js';

const ROOT = new URL('../', import.meta.url);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? +process.argv[i + 1] : d; };
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const J = (f) => JSON.parse(fs.readFileSync(new URL(f, ROOT), 'utf8'));

// 1. schema
const USES = new Set(['club', 'bar', 'pocha', 'restaurant', 'cafe', 'shop', 'conv', 'karaoke', 'pc', 'motel', 'office', 'hotel']);
const KINDS = new Set(['main', 'walking', 'alley', 'club']);
for (const f of ['layout.json', 'layout.provisional.json']) {
  const L = J(f), sid = new Set(L.streets.map((s) => s.id)), lid = new Set(L.lots.map((l) => l.id));
  ok(L.version === 1 && L.origin && typeof L.origin.lat === 'number', `${f}: version/origin`);
  ok(L.streets.every((s) => s.id && KINDS.has(s.kind) && s.width > 0 && s.points.length >= 2 && typeof s.ko === 'string'), `${f}: streets`);
  ok(L.lots.every((l) => l.footprint.length >= 3 && l.floors >= 1 && l.floorH > 2 && sid.has(l.street) && l.frontage.length === 2 && USES.has(l.use)), `${f}: lots`);
  ok(L.screens.every((s) => lid.has(s.lot) && s.pos.length === 3 && s.normal.length === 3 && s.w > 0 && s.h > 0 && ['billboard', 'facade', 'small'].includes(s.kind)), `${f}: screens`);
  ok(Array.isArray(L.hero) && L.spawn && L.spawn.pos.length === 3, `${f}: hero/spawn`);
}
const layout = J('layout.json'), lineData = J('lines.json');

// 2. determinism
const t0 = performance.now();
const geo = buildSeoulGeometry(layout, { lineData });
const tb = performance.now() - t0;
const hashOf = (g) => { let h = 0; for (const m of Object.values(g.merged)) { const a = m.getAttribute('position').array; for (let i = 0; i < a.length; i += 7) h = (Math.imul(h, 31) + Math.round(a[i] * 1000)) | 0; } return h >>> 0; };
const h1 = hashOf(geo), h2 = hashOf(buildSeoulGeometry(layout, { lineData }));
ok(h1 === h2, 'geometry deterministic');
console.log(`geometry: ${geo.facts.tris} tris (collider ${geo.facts.colTris}), build ${tb.toFixed(0)} ms, hash ${h1.toString(16)}`);

// 3. gates clear
const { bvh } = geo, cp = {};
const gateBasis = (G) => { const n = new THREE.Vector3(...G.n).normalize(); const u = G.u ? new THREE.Vector3(...G.u) : Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n);
  u.addScaledVector(n, -u.dot(n)).normalize(); return { n, u, v: new THREE.Vector3().crossVectors(n, u) }; };
const clear = (G, m = 0.25) => { const { u, v } = gateBasis(G), c = new THREE.Vector3(...G.c);
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 4; j++) { const p = c.clone().addScaledVector(u, (i / 6 - 0.5) * G.w).addScaledVector(v, (j / 4 - 0.5) * G.h); const q = bvh.closestPointToPoint(p, cp, 0, m); if (q && q.distance < m) return false; } return true; };
for (const l of geo.lines) {
  if (l.carve) { ok(l.carve.box || l.carve.axes, `${l.name}: carve`); continue; }
  ok(clear(l), `${l.name} gate clear at [${l.c}]`);
  for (const p of l.pre || []) ok(clear(p), `${l.name} pre-gate clear at [${p.c}]`);
}
const names = new Set(geo.lines.filter((l) => !l.micro).map((l) => l.name));
ok(names.size >= 10, `>= 10 named lines (${names.size})`);
for (const f of geo.funnels) ok(f.r > 0 && f.rIn > 0.5 && (f.dir === 'up' ? f.top > f.bottom : f.top > f.bottom), `funnel ${f.name}`);
ok(geo.startPoints.length >= 3 && geo.startPoints.every((s) => !bvh.closestPointToPoint(new THREE.Vector3(...s.pos), cp, 0, 0.8) || cp.distance >= 0.8), 'start points clear');

// 4. take: fly each line with a pre-gate straight through pre -> main (kinematic), expect a 'line' event of that name
{ const world = { lines: geo.lines, skimBvh: geo.skimBvh, funnels: geo.funnels, setPieces: geo.setPieces };   // set-piece lines fly only with their pieces
  const scored = new Set();
  for (const l of geo.lines) {
    if (l.carve || !l.pre || scored.has(l.name)) continue;
    const tk = new Take(); const n = gateBasis(l).n, np = gateBasis(l.pre[0]).n;
    const pts = [new THREE.Vector3(...l.pre[0].c).addScaledVector(np, -2), new THREE.Vector3(...l.pre[0].c).addScaledVector(np, 1.5), new THREE.Vector3(...l.c).addScaledVector(n, -1.5), new THREE.Vector3(...l.c).addScaledVector(n, 2)];
    const d = { pos: pts[0].clone(), vel: new THREE.Vector3(), crashed: false, heading: 0, lastImpact: 0, contactN: { x: 0, y: 0, z: 0 }, c: { radius: 0.12 }, key: 'freestyle5' };
    const evs = []; const DT = 1 / 240, v = 12;
    for (let k = 0; k < pts.length - 1; k++) { const a = pts[k], b = pts[k + 1], L = a.distanceTo(b), dir = b.clone().sub(a).normalize(); d.vel = dir.clone().multiplyScalar(v);
      for (let s = 0; s < L; s += v * DT) { const p = a.clone().addScaledVector(dir, Math.min(L, s + v * DT)); d.pos = p; evs.push(...tk.update(DT, d, world, true)); } }
    const hit = evs.some((e) => e.type === 'line' && e.name === l.name);
    if (hit) scored.add(l.name);
    ok(hit, `take scores ${l.name} (pre -> gate)`);
  }
  console.log(`take: ${scored.size} lines scored through their gates`);
}

// 5. stress
{ const N = arg('--flights', 24), world = { bvh, lastDist: Infinity, envelope: { min: new THREE.Vector3(-245, -2, -245), max: new THREE.Vector3(245, 160, 245) }, funnels: geo.funnels };
  let seed = 9090; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const ray = new THREE.Ray(), DOWN = new THREE.Vector3(0, -1, 0), seg = new THREE.Vector3(), prev = new THREE.Vector3(), cl = (v) => Math.max(-1, Math.min(1, v));
  const examples = []; let tStress = performance.now();
  for (const [mode, n, secs] of [['cine', N, 12], ['acro', Math.round(N * 0.75), 8], ['angle', Math.round(N * 0.5), 10]]) {
    const st = { flights: 0, steps: 0, passThrough: 0, nan: 0, crashes: 0, contactSteps: 0 };
    for (let f = 0; f < n; f++) {
      const dr = new Drone('freestyle5'); let crashed = false; dr.onCrash = () => { crashed = true; st.crashes++; };
      let p; // start low in the streets (where the hazards are): within 120 m, 1.5-12 m up, clear by 0.6 m
      for (let t = 0; t < 80; t++) { p = new THREE.Vector3(-120 + rnd() * 240, 1.5 + rnd() * 10.5, -120 + rnd() * 240);
        const q = bvh.closestPointToPoint(p, cp, 0, 0.6); if ((!q || q.distance >= 0.6) && bvh.raycastFirst(new THREE.Ray(p.clone(), DOWN), THREE.DoubleSide)?.point.y < 0.1) break; }
      dr.reset(p, rnd() * Math.PI * 2);
      const ou = { p: 0, r: 0, y: 0, c: 0 };
      for (let i = 0; i < secs * 240; i++) {
        for (const k in ou) ou[k] += -ou[k] * 0.8 / 240 + 1.87 * Math.sqrt(1 / 240) * (rnd() * 2 - 1);
        const inp = mode === 'cine' ? { thr: 0.4, pitch: cl(0.55 + ou.p * 0.7), roll: cl(ou.r), yaw: cl(ou.y * 0.6), climb: cl(ou.c) }
          : mode === 'angle' ? { thr: cl(0.45 + ou.c * 0.25), pitch: cl(0.35 + ou.p * 0.6), roll: cl(ou.r * 0.7), yaw: cl(ou.y * 0.5), climb: 0 }
          : { thr: cl(0.42 + ou.c * 0.3), pitch: cl(ou.p * 0.6), roll: cl(ou.r * 0.6), yaw: cl(ou.y * 0.5), climb: 0 };
        prev.copy(dr.pos); dr.step(1 / 240, inp, crashed ? 'acro' : mode, world); st.steps++;
        if (!Number.isFinite(dr.pos.x + dr.pos.y + dr.pos.z + dr.vel.x + dr.vel.y + dr.vel.z)) { st.nan++; break; }
        seg.subVectors(dr.pos, prev); const L = seg.length();
        if (L > 1e-5) { ray.set(prev, seg.divideScalar(L)); const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, L);
          if (h) { st.passThrough++; if (examples.length < 6) examples.push({ mode, at: dr.pos.toArray().map((v) => +v.toFixed(2)), what: geo.colKeyOf(h.faceIndex) }); } }
        { const q = bvh.closestPointToPoint(dr.pos, cp, 0, dr.c.radius + 0.05); if (q && q.distance < dr.c.radius + 0.05) st.contactSteps++; }
        if (crashed && dr.crashT > 1.2) break;
      }
      st.flights++;
    }
    ok(!st.passThrough && !st.nan, `stress ${mode} ${JSON.stringify(st)}`);
    console.log(`${st.passThrough || st.nan ? 'FAIL' : 'ok  '} ${mode.padEnd(5)} ${JSON.stringify(st)}`);
  }
  if (examples.length) console.log('pass-throughs:', JSON.stringify(examples));
  console.log(`stress ${((performance.now() - tStress) / 1000).toFixed(1)} s`);
}
console.log(`seoul tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
