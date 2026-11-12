// tests/seoul-dressing.mjs — stream E harness for seoul-dressing.js (contract P2-1), run before C wires it in:
//   node tests/seoul-dressing.mjs [--map out.png] [--flights N] [--focus x,z,half]
// 1. geometry() runs in node, is deterministic, and its output follows P2-1 (attribute layouts per key, colTris, emitters L3)
// 2. the five set pieces exist; the ground cut (groundTris) leaves exactly the holes; holes are off every street ribbon
// 3. combined with C's buildSeoulGeometry (as C will merge it): every lines.json gate and pre-gate stays clear (0.25 m)
// 4. stairwells are closed: rays from inside every stairwell hit the collider (no way out but the opening)
// 5. stress: seeded pilots in the combined collider; no pass-through (as seoul/tools/test-seoul.mjs)
// 6. optional top-down map (PNG) of the dressing over C's footprints
import fs from 'node:fs';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { buildSeoulGeometry, SEOUL_MATS, boxOf } from '../world-seoul.js';
import { geometry, groundTris, DRESS_MATS, beyond, ringMean, RING_LOOK } from '../seoul-dressing.js';
import { Drone } from '../flight.js';
import { encodePNG } from '../tools/png.mjs';

const ROOT = new URL('../', import.meta.url);
const argv = process.argv, arg = (k, d) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : d; };
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const J = (f) => JSON.parse(fs.readFileSync(new URL(f, ROOT), 'utf8'));
const layout = J('seoul/layout.json'), lines = J('seoul/lines.json');

// C's geometry (what geometry() gets from buildSeoulGeometry when C wires it: poles, lotInfo, emitters, lines)
let t0 = performance.now();
const C = buildSeoulGeometry(layout, { lineData: lines });
const tC = performance.now() - t0;
const opts = { seed: 11, lines, poles: C.poles, lotInfo: C.lotInfo, emitters: C.emitters };
t0 = performance.now();
const E = geometry(layout, opts);
const tE = performance.now() - t0;
console.log(`C geometry ${tC.toFixed(0)} ms, ${C.facts.tris} tris | E dressing ${tE.toFixed(0)} ms, ${E.facts.tris} tris (collider ${E.facts.colTris})`);
console.log('facts', JSON.stringify(E.facts));

// 1. contract + determinism
const hashOf = (g) => { let h = 0; for (const k of Object.keys(g.merged).sort()) { const a = g.merged[k].getAttribute('position').array; for (let i = 0; i < a.length; i += 5) h = (Math.imul(h, 31) + Math.round(a[i] * 1000)) | 0; } const c = g.colTris.getAttribute('position').array; for (let i = 0; i < c.length; i += 7) h = (Math.imul(h, 31) + Math.round(c[i] * 1000)) | 0; return h >>> 0; };
const E2 = geometry(JSON.parse(JSON.stringify(layout)), { ...opts, poles: C.poles.map((p) => ({ ...p })) });
ok(hashOf(E) === hashOf(E2), 'dressing deterministic');
ok(JSON.stringify(E.emitters) === JSON.stringify(E2.emitters) && JSON.stringify(E.setPieces) === JSON.stringify(E2.setPieces), 'emitters + set pieces deterministic');
for (const [k, g] of Object.entries(E.merged)) {
  const names = Object.keys(g.attributes).sort().join(',');
  if (SEOUL_MATS[k]) ok(names === (SEOUL_MATS[k].emissive ? 'aEm,normal,position,uv' : 'normal,position,uv') && !g.index, `C key ${k} layout (${names})`);
  else { const m = DRESS_MATS[k]; ok(!!m, `unknown key ${k}`); if (m) ok(names === ['normal', 'position', 'uv', ...(m.emissive ? ['aEm'] : []), ...(m.vcol ? ['color'] : [])].sort().join(','), `E key ${k} layout (${names})`); }
  const p = g.getAttribute('position').array; let bad = 0; for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) bad++; ok(!bad, `${k}: finite positions`);
}
ok(E.colTris.getAttribute('position').count % 3 === 0 && E.colTris.getAttribute('position').count > 0, 'colTris non-indexed triangles');
ok(E.emitters.every((e) => e.id && e.pos.length === 3 && e.normal.length === 3 && e.w > 0 && e.h > 0 && e.rgb && e.nits > 0 && e.kind), 'emitters are L3 records');
ok(new Set(E.emitters.map((e) => e.id)).size === E.emitters.length, 'emitter ids unique');
const tents = E.emitters.filter((e) => e.kind === 'tent'); ok(tents.length >= 6, `pocha tents placed (${tents.length})`);
ok(E.emitters.filter((e) => e.kind === 'tent').every((e) => e.nits >= 100 && e.nits <= 150), 'tent nits within SOURCE_TYPES.tent band');
const doors = E.emitters.filter((e) => e.id.startsWith('dress:door:')); ok(doors.length >= 3 && doors.every((e) => e.nits >= 20 && e.nits <= 40), `rear doors behind the gaps at 20-40 nits (${doors.length})`);

// 2. set pieces, holes
const ids = new Set(E.setPieces.map((s) => s.id));
for (const id of ['station-stairs', 'under-the-stage', 'bus-shelter', 'cable-thread', 'roofline-slot']) ok(ids.has(id), `set piece ${id}`);
for (const sp of E.setPieces) console.log(`  ${sp.id.padEnd(16)} ${sp.kind.padEnd(7)} at [${sp.pos ?? ''}] ${sp.gates ? 'gates: ' + Object.keys(sp.gates).join(',') : ''}`);
const B = boxOf(layout), gx0 = B.x0 - 80, gx1 = B.x1 + 80, gz0 = B.z0 - 80, gz1 = B.z1 + 80;
const gt = groundTris(gx0, gz0, gx1, gz1, E.holes);
const area = (P) => { let a = 0; for (let i = 0; i < P.length; i++) { const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % P.length]; a += x0 * z1 - x1 * z0; } return a / 2; };
const holeA = E.holes.reduce((s, h) => s + Math.abs(area(h)), 0), groundA = gt.reduce((s, t) => s + Math.abs(area(t)), 0);
ok(Math.abs(groundA - ((gx1 - gx0) * (gz1 - gz0) - holeA)) < 0.5, `groundTris area = box - holes (${holeA.toFixed(1)} m2 cut in ${E.holes.length} holes)`);
const segD = (px, pz, ax, az, bx, bz) => { const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1e-9; const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2)); return Math.hypot(px - ax - t * vx, pz - az - t * vz); };
const onRibbon = (x, z) => layout.streets.some((s) => { for (let i = 0; i < s.points.length - 1; i++) if (segD(x, z, ...s.points[i], ...s.points[i + 1]) < s.width / 2) return true; return false; });
for (const h of E.holes) { let hit = false; for (let i = 0; i < h.length; i++) for (let t = 0; t <= 1; t += 0.1) { const a = h[i], b = h[(i + 1) % h.length]; if (onRibbon(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) hit = true; } ok(!hit, `hole off the street ribbons at [${h[0].map((v) => v.toFixed(1))}]`); }

// 3. combined collider (C's with the ground cut + E) — the way C merges it
const posOnly = (g) => { const h = new THREE.BufferGeometry(); h.setAttribute('position', g.getAttribute('position')); return h; };
const wired = !!C.dressing;   // world-seoul.js already calls geometry() (C merged P2-1): use its collider as is
const noCol = new Set(['stripe', 'yellow', 'glass', 'shop']);
const ground = new THREE.BufferGeometry(); { const p = []; for (const [a, b, c] of gt) p.push(a[0], 0, a[1], b[0], 0, b[1], c[0], 0, c[1]); ground.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); }
// C's 'walk' geometry starts with its full-box ground quad (2 tris): drop those, use the cut ground
let colGeo, bvh;
if (wired) { colGeo = C.colGeo; bvh = C.bvh; ok(C.setPieces?.length === E.setPieces.length, 'wired: world exposes the set pieces'); }
else {
  const walk = C.merged.walk, wp = walk.getAttribute('position').array.slice(18), walkRest = new THREE.BufferGeometry(); walkRest.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
  ok(Math.abs(walk.getAttribute('position').array[0] - gx0) < 1e-3, "C's ground quad is the first 2 'walk' triangles");
  const parts = Object.entries(C.merged).filter(([k]) => !noCol.has(k) && k !== 'walk').map(([, g]) => posOnly(g));
  parts.push(walkRest, ground, E.colTris);
  colGeo = mergeGeometries(parts, false); bvh = new MeshBVH(colGeo, { maxLeafTris: 5 });
}
console.log(`combined collider ${colGeo.getAttribute('position').count / 3} tris${wired ? ' (world-seoul.js wired)' : ''}`);
const cp = {};
const basis = (G) => { const n = new THREE.Vector3(...G.n).normalize(); const u = G.u ? new THREE.Vector3(...G.u) : Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n); u.addScaledVector(n, -u.dot(n)).normalize(); return { n, u, v: new THREE.Vector3().crossVectors(n, u) }; };
const clear = (G, m = 0.25, bv = bvh) => { const { u, v } = basis(G), c = new THREE.Vector3(...G.c); for (let i = 0; i <= 6; i++) for (let j = 0; j <= 4; j++) { const p = c.clone().addScaledVector(u, (i / 6 - 0.5) * G.w).addScaledVector(v, (j / 4 - 0.5) * G.h); const q = bv.closestPointToPoint(p, cp, 0, m); if (q && q.distance < m) return false; } return true; };
for (const l of lines.lines) { if (l.carve) continue; ok(clear(l), `${l.name} gate clear with dressing`); for (const p of l.pre || []) ok(clear(p), `${l.name} pre-gate clear with dressing`); }
// set-piece gates: clear of the combined collider (they are E's proposals to F1)
for (const sp of E.setPieces) for (const [k, g] of Object.entries(sp.gates || {})) {
  const list = g.c ? [[k, g]] : Array.isArray(g) ? g.map((x, i) => [k + i, x]) : Object.entries(g).flatMap(([k2, x]) => (x.c ? [[k + '.' + k2, x]] : Object.entries(x).map(([k3, y]) => [k + '.' + k2 + '.' + k3, y])));
  for (const [name, G] of list) ok(clear(G, 0.25), `set piece ${sp.id} ${name} clear (0.25 m, as test-seoul checks lines)`);
}

// 4. stairwells closed: from points inside each stairwell, rays in 200 directions must hit something within 40 m
{ const ray = new THREE.Ray(); let leaks = 0, tests = 0; const leakEx = [];
  const inPoly = (x, z, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
  for (const h of E.holes) {
    const cx = h.reduce((s, p) => s + p[0], 0) / h.length, cz = h.reduce((s, p) => s + p[1], 0) / h.length;
    for (const y of [-1.0, -2.2]) {
      const o = new THREE.Vector3(cx, y, cz); if (bvh.closestPointToPoint(o, cp, 0, 0.05) && cp.distance < 0.05) continue;
      for (let i = 0; i < 200; i++) { const z = 1 - 2 * (i + 0.5) / 200, r = Math.sqrt(1 - z * z), a = i * 2.39996; const d = new THREE.Vector3(r * Math.cos(a), z, r * Math.sin(a));
        ray.set(o, d); tests++; if (bvh.raycastFirst(ray, THREE.DoubleSide, 0, 40)) continue;
        // an unobstructed ray is fine only if it leaves through the opening (crosses y = 0 inside the hole)
        if (d.y > 0) { const t = -o.y / d.y, x = o.x + d.x * t, z = o.z + d.z * t; if (inPoly(x, z, h)) continue; }
        leaks++; if (leakEx.length < 4) leakEx.push({ hole: h[0].map((v) => +v.toFixed(1)), y, d: d.toArray().map((v) => +v.toFixed(2)) }); }
    }
  }
  ok(leaks === 0, `stairwells closed below grade (${tests} rays, ${leaks} leaks)`); if (leaks) console.log('leaks', JSON.stringify(leakEx)); }

// 5. stress: seeded pilots near the dressing (streets, set pieces) — no pass-through
{ const N = +arg('--flights', 18), world = { bvh, lastDist: Infinity, envelope: { min: new THREE.Vector3(-245, -6, -480), max: new THREE.Vector3(285, 160, 245) }, funnels: C.funnels };
  let seed = 4242; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const ray = new THREE.Ray(), DOWN = new THREE.Vector3(0, -1, 0), seg = new THREE.Vector3(), prev = new THREE.Vector3(), cl = (v) => Math.max(-1, Math.min(1, v));
  const anchors = E.setPieces.map((s) => s.pos).filter(Boolean).concat(E.emitters.filter((e) => e.kind === 'tent').map((e) => e.pos));
  const ex = []; const tS = performance.now();
  for (const [mode, n, secs] of [['cine', N, 10], ['acro', Math.round(N * 0.75), 7], ['angle', Math.round(N * 0.5), 8]]) {
    const st = { flights: 0, steps: 0, passThrough: 0, nan: 0, crashes: 0, contactSteps: 0 };
    for (let f = 0; f < n; f++) {
      const dr = new Drone('freestyle5'); let crashed = false; dr.onCrash = () => { crashed = true; st.crashes++; };
      let p; const a = anchors[f % anchors.length];
      for (let t = 0; t < 120; t++) { p = new THREE.Vector3(a[0] + (rnd() - 0.5) * 30, 1.0 + rnd() * 6, a[2] + (rnd() - 0.5) * 30);
        const q = bvh.closestPointToPoint(p, cp, 0, 0.6); if ((!q || q.distance >= 0.6) && bvh.raycastFirst(new THREE.Ray(p.clone(), DOWN), THREE.DoubleSide)?.point.y < 0.1) break; }
      dr.reset(p, rnd() * Math.PI * 2);
      const ou = { p: 0, r: 0, y: 0, c: 0 };
      for (let i = 0; i < secs * 240; i++) {
        for (const k in ou) ou[k] += -ou[k] * 0.8 / 240 + 1.87 * Math.sqrt(1 / 240) * (rnd() * 2 - 1);
        const inp = mode === 'cine' ? { thr: 0.4, pitch: cl(0.55 + ou.p * 0.7), roll: cl(ou.r), yaw: cl(ou.y * 0.6), climb: cl(ou.c) }
          : mode === 'angle' ? { thr: cl(0.45 + ou.c * 0.25), pitch: cl(0.35 + ou.p * 0.6), roll: cl(ou.r * 0.7), yaw: cl(ou.y * 0.5), climb: 0 }
          : { thr: cl(0.42 + ou.c * 0.3), pitch: cl(ou.p * 0.6), roll: cl(ou.r * 0.6), yaw: cl(ou.y * 0.5), climb: 0 };
        prev.copy(dr.pos); dr.step(1 / 240, inp, crashed ? 'acro' : mode, world); st.steps++;
        if (!Number.isFinite(dr.pos.x + dr.pos.y + dr.pos.z)) { st.nan++; break; }
        seg.subVectors(dr.pos, prev); const L = seg.length();
        if (L > 1e-5) { ray.set(prev, seg.divideScalar(L)); const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, L); if (h) { st.passThrough++; if (ex.length < 6) ex.push({ mode, at: dr.pos.toArray().map((v) => +v.toFixed(2)) }); } }
        { const q = bvh.closestPointToPoint(dr.pos, cp, 0, dr.c.radius + 0.05); if (q && q.distance < dr.c.radius + 0.05) st.contactSteps++; }
        if (crashed && dr.crashT > 1.2) break;
      }
      st.flights++;
    }
    ok(!st.passThrough && !st.nan, `stress ${mode} ${JSON.stringify(st)}`);
    console.log(`${st.passThrough || st.nan ? 'FAIL' : 'ok  '} ${mode.padEnd(5)} ${JSON.stringify(st)}`);
  }
  if (ex.length) console.log('pass-throughs:', JSON.stringify(ex));
  console.log(`stress ${((performance.now() - tS) / 1000).toFixed(1)} s`);
}

// 7. [P4-E] phase-4 items: the violet villas, the ring's luminance (fpv #4: ring median <= 1.5x the near facades), the tents'
// hot spots and seams (art #6), lit roofs in the block's interior, the Playground's anchor (design #6), the transit holes (#5)
{
  ok(DRESS_MATS.dr_mass.fold === false && !!C.merged.dr_mass && !(C.groupMats?.city?.layers || []).includes('dr_mass'), 'dr_mass stays out of the city atlas group (was violet: its colour is data)');
  const BY = beyond(layout, { seed: 11 }), Bd = BY.buildings, n = Bd.length / 9;
  ok(RING_LOOK.wall[0] >= 0.05 && RING_LOOK.wall[1] <= 0.16, `ring walls ${RING_LOOK.wall.join('-')} nits (lighting: 0.05-0.15, was 0.5-2)`);
  // area-weighted facade mean before haze, and the median through the haze at 300-2000 m toward the sky's horizon (x hazeK)
  const hz = RING_LOOK.horizon.map((v) => v * RING_LOOK.hazeK), hzL = 0.2126 * hz[0] + 0.7152 * hz[1] + 0.0722 * hz[2];
  const vals = []; let aSum = 0, lSum = 0;
  for (let i = 0; i < n; i++) { const kind = Bd[i * 9 + 7], H = Bd[i * 9 + 5], area = 2 * (Bd[i * 9 + 2] + Bd[i * 9 + 3]) * 2 * H, apt = kind === 2 && (i % 20) < 11, m = ringMean(kind, H, apt); aSum += area; lSum += area * m;
    for (const d of [300, 800, 2000]) { const T = Math.exp(-d / RING_LOOK.hazeD); vals.push([m * T + hzL * (1 - T), area]); } }
  vals.sort((a, b) => a[0] - b[0]); let acc = 0, med = 0; const tot = vals.reduce((s, v) => s + v[1], 0); for (const [v, a] of vals) { acc += a; if (acc >= tot / 2) { med = v; break; } }
  console.log(`ring: ${n} buildings, area-mean ${(lSum / aSum).toFixed(3)} nits before haze, median through the haze ${med.toFixed(3)} nits (phase 3: ~1.1-1.8)`);
  ok(lSum / aSum < 0.5 && med < 0.45, `ring luminance budget (mean ${(lSum / aSum).toFixed(2)} < 0.5, hazed median ${med.toFixed(2)} < 0.45 nits)`);
  ok(BY.roadLamps.length === BY.roads.length / 6 * 2 && BY.roofLamp.length === n * 2, 'ring: lamp pools per road, a roof lamp slot per building');
  const loc = (() => { let k = 0; const R = BY.roads, Cr = BY.cars; for (let i = 0; i < Cr.length; i += 8) if (Cr[i + 7] < 8.01) k++; return k; })();
  ok(loc > 200 && BY.facts.roofLamps > 500, `ring: cars on the local streets (${loc}), rooftop wall packs (${BY.facts.roofLamps})`);
  // tents: per-vertex tarp emission has a hot spot (max / median >= 3) and dark seams (some vertices <= 1/4 of the median)
  const tg = E.merged.dr_tarp, em = tg.getAttribute('aEm').array, L = []; for (let i = 0; i < em.length; i += 3) L.push(0.2126 * em[i] + 0.7152 * em[i + 1] + 0.0722 * em[i + 2]);
  L.sort((a, b) => a - b); const mid = L[L.length >> 1], top = L[Math.floor(L.length * 0.995)], low = L[Math.floor(L.length * 0.02)];
  console.log(`tents: tarp luminance p2 ${(low / 0.1).toFixed(1)}, p50 ${(mid / 0.1).toFixed(1)}, p99.5 ${(top / 0.1).toFixed(1)} nits (carts included)`);
  ok(top / mid >= 3 && low / mid <= 0.3, `tent bulb hot spots (p99.5 / p50 ${(top / mid).toFixed(1)}) and 2-stop seams (p2 / p50 ${(low / mid).toFixed(2)})`);
  ok(!!E.merged.dr_vinyl?.getAttribute('aEm'), 'tent vinyl scatters the inside light (emissive)');
  ok((E.facts.massRoofs || 0) >= 100, `lit roofs in the block's interior: stair houses with wall packs on the massing (${E.facts.massRoofs})`);
  const A = E.anchors?.['playground-pop'];
  ok(!!A && A.gate.w >= 3 && A.gate.w <= 4.5 && A.gap - A.gate.w <= 1.6, `PLAYGROUND POP anchored between the mast and a crown (${A ? A.gate.w + ' m in a ' + A.gap + ' m slot' : 'none'})`);
  const pop = lines.lines.find((l) => l.name === 'PLAYGROUND POP'), pass_ = lines.lines.find((l) => l.name === 'SCREEN PASS');
  if (A && pop) ok(Math.hypot(pop.c[0] - A.gate.c[0], pop.c[2] - A.gate.c[2]) < 0.5, 'lines.json PLAYGROUND POP is the anchor (regenerate lines.json after the dressing changes)');
  if (pass_) ok(pass_.h <= 4.01 && pass_.w <= 3.5, `SCREEN PASS at most 4 m tall, 3 m off the screen (${pass_.w} x ${pass_.h})`);
  for (const nm of ['TO THE SIGN STACK 1', 'TO THE SIGN STACK 2', 'TO THE CABLE LATTICE 1', 'TO THE FORK 1']) ok(lines.lines.some((l) => l.name === nm && l.connector), `transit connector ${nm}`);
  ok(lines.lines.filter((l) => l.name === 'SIGN STACK').every((l) => l.via?.length === 1 && l.via[0].unless?.length === 6), 'SIGN STACK has a via along the street');
}

// 7. [P7-E perf #1] distance tiers: every lod key is split into cells by seoul-light (>= 12k tris, > 1 cell), each cell's
// sphere centre lies in its own square (build().update decides N / F per square from it), and the in-view dressing at the
// stills' poses (node frustum, 64 m cells, N within LOD_R of the square, F beyond) stays under 200k triangles
{
  const { splitCells } = await import('../seoul-light.js');
  const { LOD_R } = await import('../seoul-dressing.js');
  const lodKeys = Object.keys(E.merged).filter((k) => DRESS_MATS[k]?.lod);
  ok(lodKeys.length >= 6 && lodKeys.some((k) => DRESS_MATS[k].lod === 'far') && lodKeys.every((k) => DRESS_MATS[k].fold === false && DRESS_MATS[k].lodR === LOD_R), `tier keys (${lodKeys.join(', ')})`);
  const parts = {};
  for (const k of lodKeys) {
    const g = E.merged[k], n = g.getAttribute('position').count / 3, sp = splitCells(g, 64);
    parts[k] = sp.parts;
    ok(n >= 12000 && sp.parts.length > 1, `${k}: split into cells (${n} tris, ${sp.parts.length} cells)`);
    const bad = sp.parts.filter((p) => Math.floor(p.sphere.center.x / 64) !== p.cell[0] || Math.floor(p.sphere.center.z / 64) !== p.cell[1]);
    ok(bad.length <= Math.max(1, sp.parts.length * 0.02), `${k}: cell sphere centres in their own square (${bad.length} of ${sp.parts.length} off)`);
  }
  // the poses (seoulsnap's SHOTS): yaw 0 looks -z; a wide FPV frustum (tan 1.9 x 1.07)
  const SH = { walk0: [-36, 3, -23, 0, 4], walk180: [-36, 3, -23, 180, 4], station: [31.8, 8, -309, 0, 0], station2: [31.8, 8, -309, 180, 0], club90: [63.7, 3, 129.6, 90, 4], club270: [63.7, 3, 129.6, 270, 4], w21: [-66.7, 3, 88, 0, 4], high: [0, 60, 60, 0, -35] };
  const cellsOf = (k) => parts[k] || splitCells(E.merged[k], 64)?.parts || [];
  const all = Object.keys(E.merged).map((k) => [k, cellsOf(k)]);
  const view = {}, before = {};
  for (const [s, [x, y, z, yaw, pit]] of Object.entries(SH)) {
    const yr = yaw * Math.PI / 180, pr = pit * Math.PI / 180, f = [-Math.sin(yr) * Math.cos(pr), Math.sin(pr), -Math.cos(yr) * Math.cos(pr)], r = [Math.cos(yr), 0, -Math.sin(yr)];
    const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]], hy = Math.max(0, y - 10);
    let tot = 0, old = 0;
    for (const [k, ps] of all) { const lod = DRESS_MATS[k]?.lod;
      for (const p of ps) { const c = p.sphere.center, R = p.sphere.radius, d = [c.x - x, c.y - y, c.z - z], fz = d[0] * f[0] + d[1] * f[1] + d[2] * f[2], fx = d[0] * r[0] + d[1] * r[1] + d[2] * r[2], fy = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
        if (fz < -R || Math.abs(fx) > fz * 1.9 + R * 2.15 || Math.abs(fy) > fz * 1.07 + R * 1.47) continue;
        if (k === 'dr_roof' && y < E.facts.roofHideY - 0.25) continue;
        if (lod !== 'far') old += p.tris;
        if (lod) { const x0 = p.cell[0] * 64, z0 = p.cell[1] * 64, dx = Math.max(x0 - x, 0, x - x0 - 64), dz = Math.max(z0 - z, 0, z - z0 - 64), nearC = Math.hypot(dx, dz, hy) < LOD_R; if ((lod === 'near') !== nearC) continue; }
        tot += p.tris; } }
    view[s] = tot; before[s] = old;
  }
  console.log('dressing tris in view (tiers / all near):', Object.entries(view).map(([s, v]) => `${s} ${(v / 1000).toFixed(0)}k/${(before[s] / 1000).toFixed(0)}k`).join(', '));
  ok(Object.values(view).every((v) => v <= 200000), `dressing in view <= 200k at every still pose (max ${(Math.max(...Object.values(view)) / 1000).toFixed(0)}k)`);
  // [P7-E lighting #4] puddles at the post bases: a soft-edged wet decal (no collider), the crowd's discs on it; club270's
  // lamp pole (72.4, 130.6) stands in one
  const pud = E.merged.dr_puddle, pp = pud?.getAttribute('position').array || [];
  ok((E.facts.puddles || 0) >= 100 && DRESS_MATS.dr_puddle?.noCol && DRESS_MATS.dr_puddle.wet, `puddles at post bases (${E.facts.puddles})`);
  let atClub = 0; for (let i = 0; i < pp.length; i += 3) if (Math.hypot(pp[i] - 72.39, pp[i + 2] - 130.58) < 1.2) atClub++;
  ok(atClub > 6 && E.puddles.some((q) => Math.hypot(q[0] - 72.4, q[1] - 130.3) < 1.0 && q[4] >= 1.8), `club270's pole stands in a puddle, listed for the crowd (${atClub} verts)`);
}

// 6. top-down map: C's roofs dark, ribbons grey, dressing coloured by key, emitters as dots, holes outlined
const mapOut = arg('--map', null);
if (mapOut) {
  const foc = (arg('--focus', '') || '').split(',').map(Number);
  const [fx, fz, fh] = foc.length === 3 ? foc : [(B.x0 + B.x1) / 2, (B.z0 + B.z1) / 2, Math.max(B.x1 - B.x0, B.z1 - B.z0) / 2];
  const S = 1400, sc = S / (2 * fh), img = new Uint8Array(S * S * 4).fill(0); for (let i = 3; i < img.length; i += 4) img[i] = 255;
  const zb = new Float32Array(S * S).fill(-1e9);
  const raster = (g, colr, yMin = -1e9) => { const p = g.getAttribute('position').array, c = g.getAttribute('color')?.array; for (let i = 0; i < p.length; i += 9) {
    const v = [0, 3, 6].map((o) => [(p[i + o] - fx + fh) * sc, (p[i + o + 2] - fz + fh) * sc, p[i + o + 1]]); if (Math.max(v[0][2], v[1][2], v[2][2]) < yMin) continue;
    const x0 = Math.max(0, Math.floor(Math.min(v[0][0], v[1][0], v[2][0]))), x1 = Math.min(S - 1, Math.ceil(Math.max(v[0][0], v[1][0], v[2][0]))), y0 = Math.max(0, Math.floor(Math.min(v[0][1], v[1][1], v[2][1]))), y1 = Math.min(S - 1, Math.ceil(Math.max(v[0][1], v[1][1], v[2][1])));
    const d = (v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[2][0] - v[0][0]) * (v[1][1] - v[0][1]); if (Math.abs(d) < 1e-9) continue;
    const cc = c ? [c[i] ** 0.45 * 255, c[i + 1] ** 0.45 * 255, c[i + 2] ** 0.45 * 255] : colr;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const px = x + 0.5, py = y + 0.5, a = ((v[1][0] - px) * (v[2][1] - py) - (v[2][0] - px) * (v[1][1] - py)) / d, b = ((v[2][0] - px) * (v[0][1] - py) - (v[0][0] - px) * (v[2][1] - py)) / d, w = 1 - a - b;
      if (a < 0 || b < 0 || w < 0) continue; const h = a * v[0][2] + b * v[1][2] + w * v[2][2]; const k = y * S + x; if (h < zb[k]) continue; zb[k] = h; img.set([cc[0], cc[1], cc[2]], k * 4); } } };
  const ck = { road: [40, 40, 44], plaza: [70, 45, 45], walk: [22, 22, 24], roof: [55, 60, 55], tile: [80, 78, 74], brick: [80, 50, 42], plaster: [85, 82, 76], concrete: [70, 70, 70] };
  for (const k of ['walk', 'road', 'plaza', 'roof']) if (C.merged[k]) raster(C.merged[k], ck[k]);
  const EK = { dr_steel: [150, 150, 160], dr_galv: [200, 200, 205], dr_glass: [90, 160, 200], dr_glow: [255, 240, 120], dr_bark: [120, 80, 40], concrete: [170, 170, 170], tile: [210, 200, 190], walk: [120, 120, 120], dark: [255, 0, 255], white: [240, 240, 240], metal: [120, 140, 160], plaster: [200, 190, 170] };
  for (const [k, g] of Object.entries(E.merged)) raster(g, EK[k] || [255, 0, 0]);
  for (const h of E.holes) for (let i = 0; i < h.length; i++) { const a = h[i], b = h[(i + 1) % h.length]; for (let t = 0; t <= 1; t += 0.01) { const x = Math.round((a[0] + (b[0] - a[0]) * t - fx + fh) * sc), y = Math.round((a[1] + (b[1] - a[1]) * t - fz + fh) * sc); if (x >= 0 && y >= 0 && x < S && y < S) img.set([0, 255, 255], (y * S + x) * 4); } }
  const dot = (x, z, c, r = 2) => { const X = Math.round((x - fx + fh) * sc), Y = Math.round((z - fz + fh) * sc); for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const xx = X + i, yy = Y + j; if (xx >= 0 && yy >= 0 && xx < S && yy < S) img.set(c, (yy * S + xx) * 4); } };
  for (const l of lines.lines) { if (!l.c) continue; dot(l.c[0], l.c[2], [0, 255, 0], 3); for (const p of l.pre || []) dot(p.c[0], p.c[2], [0, 160, 0], 3); }
  for (const sp of E.setPieces) for (const g of Object.values(sp.gates || {})) for (const x of (g.c ? [g] : Object.values(g).flatMap((y) => (y.c ? [y] : Object.values(y))))) if (x?.c) dot(x.c[0], x.c[2], [255, 60, 60], 3);
  fs.writeFileSync(mapOut, encodePNG(img, S, S)); console.log('map ->', mapOut);
}
console.log(`seoul-dressing tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
