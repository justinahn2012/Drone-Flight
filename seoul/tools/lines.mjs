// seoul/tools/lines.mjs — Hongdae take lines, funnels and start points, measured off the built geometry.
//   node seoul/tools/lines.mjs            (writes seoul/lines.json; prints the clearance check per gate)
// Lines are real moves on the real streets (D5: "a line is a real move, named afterwards"): the length of the
// Eoulmadang-ro walking street over heads, Wausan-ro 21-gil under the service drops, the narrowest real gaps between
// buildings, a climb up a facade, a roof drop into an alley, the station-front crossing of Yanghwa-ro over the buses.
// Every gate is placed from layout.json and checked against the collider (buildSeoulGeometry): no sample point of
// the gate rectangle within CLEAR of geometry, and a straight pass through its centre along n is open for +-2 m.
import fs from 'node:fs';
import * as THREE from 'three';
import { buildSeoulGeometry } from '../../world-seoul.js';

const ROOT = new URL('../', import.meta.url);
const layout = JSON.parse(fs.readFileSync(new URL('layout.json', ROOT), 'utf8'));
const geo = buildSeoulGeometry(layout);
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
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 6; j++) {
    const p = c.clone().addScaledVector(u, (i / 8 - 0.5) * G.w).addScaledVector(v, (j / 6 - 0.5) * G.h);
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
const speedWithin = (dist, v = 7) => Math.ceil(dist / v + 4);

// 1. WALKING STREET: Eoulmadang-ro's car-free 220 m (Hongik-ro -> Wausan-ro 21-gil), 2.2-5.2 m: over heads, under the drops
const walk = piece('어울마당로', [-27, -14], 'walking'); const WL = len(walk.points);
{ const A = bestAcross(walk.points, [15, 20, 25, 30, 10], walk.width - 1, 2.2, 5.2), B = bestAcross(walk.points, [-15, -20, -25, -30, -35, -40, -45, -50], walk.width - 1, 2.2, 5.2);
  add('WALKING STREET', 'THE WALKING *STREET*!', 2000, B, { pre: [A], within: speedWithin(WL), first: true });
  add('WALKING STREET', 'THE WALKING *STREET*!', 2000, neg(A), { pre: [neg(B)], within: speedWithin(WL) }); }
// 2. BAR ALLEY: Wausan-ro 21-gil, the E-W bar and club alley (reference hero line 4), 2.0-4.0 m (drops cross from 4.2 m)
const longest = (ko, kind) => layout.streets.filter((s) => s.ko === ko && (!kind || s.kind === kind)).sort((a, b) => len(b.points) - len(a.points))[0];
const club = longest('와우산로21길', 'club'); const CL = len(club.points);
{ const A = bestAcross(club.points, [12, 16, 20, 8], club.width - 0.8, 2.0, 4.0), B = bestAcross(club.points, [-12, -16, -20, -8], club.width - 0.8, 2.0, 4.0);
  add('BAR ALLEY', 'THE BAR *ALLEY*!', 2000, B, { pre: [A], within: speedWithin(CL) });
  add('BAR ALLEY', 'THE BAR *ALLEY*!', 2000, neg(A), { pre: [neg(B)], within: speedWithin(CL) }); }
// 2b. CLUB STREET: Wausan-ro 19-gil, "클럽거리" proper (hero line 5), 2.0-4.0 m
{ const c19 = longest('와우산로19길'); const L19 = len(c19.points);
  if (c19 && L19 > 40) { const A = bestAcross(c19.points, [8, 12, 16], c19.width + 2, 2.0, 4.0), B = bestAcross(c19.points, [-8, -12, -16], c19.width + 2, 2.0, 4.0);
    add('CLUB STREET', 'CLUB *STREET*!', 2000, B, { pre: [A], within: speedWithin(L19) });
    add('CLUB STREET', 'CLUB *STREET*!', 2000, neg(A), { pre: [neg(B)], within: speedWithin(L19) });
    report.push(`  (CLUB STREET: Wausan-ro 19-gil piece ${c19.id}, ${L19.toFixed(0)} m)`); } }
// 2c. PLAYGROUND POP (micro): out of the bar alleys, up over Hongdae Playground (hero line 4's pop-up): a 10 m
// horizontal portal at 9 m over the park, crossed climbing
{ const G = g([80, 9, 97], [0, 1, 0], 10, 10, [1, 0, 0]); add('PLAYGROUND POP', 'PLAYGROUND *POP*!', 500, G, { micro: true }); }
// 3. HONGIK-RO: down the main road from the station to the university, 5-8.5 m: over the buses, under the lamp arms' reach
const hong = longest('홍익로', 'main'); const HL = len(hong.points);
{ const A = across(hong.points, 10, hong.width, 5.0, 8.0), B = across(hong.points, -10, hong.width, 5.0, 8.0);
  add('HONGIK-RO', 'DOWN *HONGIK-RO*!', 1500, B, { pre: [A], within: speedWithin(HL, 12) });
  add('HONGIK-RO', 'DOWN *HONGIK-RO*!', 1500, neg(A), { pre: [neg(B)], within: speedWithin(HL, 12) }); }
// 4. CROSSING: across Yanghwa-ro at the station front, 6-9 m over the bus lanes (a 30 m wide portal along the road)
{ const X9 = [46, -313];   // exit 9 (reference.md)
  const dTo = (s) => Math.min(...s.points.map((p) => Math.hypot(p[0] - X9[0], p[1] - X9[1])));
  const ys = layout.streets.filter((s) => s.ko === '양화로' && s.kind === 'main').sort((a, b) => dTo(a) - dTo(b));
  const nA = ys[0], nB = ys.find((s) => s !== nA && Math.abs(dTo(s) - dTo(nA)) < 40 && s.points.length) || ys[1];
  let s0 = 0, bd = Infinity; for (let s = 0; s <= len(nA.points); s += 1) { const q = at(nA.points, s), d = Math.hypot(q.x - X9[0], q.z - X9[1]); if (d < bd) { bd = d; s0 = s; } }
  const pa = at(nA.points, s0);
  // the far carriageway's nearest point
  let best = null; for (let s = 0; s <= len(nB.points); s += 1) { const q = at(nB.points, s), d = Math.hypot(q.x - pa.x, q.z - pa.z); if (!best || d < best.d) best = { q, d }; }
  const mx = (pa.x + best.q.x) / 2, mz = (pa.z + best.q.z) / 2, nx = -pa.tz, nz = pa.tx;
  const G = g([mx, 7.5, mz], [nx, 0, nz], 30, 3, [pa.tx, 0, pa.tz]);
  add('CROSSING', 'THE *CROSSING*.', 1500, G, { two: true });
  report.push(`  (Yanghwa-ro carriageway centres ${best.d.toFixed(1)} m apart at exit 9)`);
  // SCREEN CANYON (hero line 1): from exit 9 SW down Yanghwa-ro between the 14-16 m LED screens, 8-14 m up (over
  // the bus lanes, at screen height), to the Hongik-ro junction. Portals across the road centre, 30 m wide.
  const cx = (s) => { const q = at(nA.points, s); let bb = null; for (let t = 0; t <= len(nB.points); t += 1) { const r = at(nB.points, t), d = Math.hypot(r.x - q.x, r.z - q.z); if (!bb || d < bb.d) bb = { r, d }; }
    return { x: (q.x + bb.r.x) / 2, z: (q.z + bb.r.z) / 2, tx: q.tx, tz: q.tz }; };
  // nA's direction: sign so that the flight runs SW (toward Hongik-ro, x decreasing)
  const sg = pa.tx < 0 ? 1 : -1, sA = s0 + sg * 15, sB = s0 + sg * 120;
  const pA = cx(sA), pB = cx(sB), dir = [pB.x - pA.x, pB.z - pA.z], dl = Math.hypot(...dir), n = [dir[0] / dl, 0, dir[1] / dl];
  const Ga = g([pA.x, 11, pA.z], n, 30, 6, [-n[2], 0, n[0]]), Gb = g([pB.x, 11, pB.z], n, 30, 6, [-n[2], 0, n[0]]);
  add('SCREEN CANYON', 'THE SCREEN *CANYON*!', 2500, Gb, { pre: [Ga], within: speedWithin(dl, 10) });
  add('SCREEN CANYON', 'THE SCREEN *CANYON*!', 2500, neg(Ga), { pre: [neg(Gb)], within: speedWithin(dl, 10) });
  report.push(`  (SCREEN CANYON: ${dl.toFixed(0)} m from exit 9 SW along Yanghwa-ro)`); }
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
const usedGap = [];
for (const [name, pts, micro] of [['THE GAP', 2500, false], ['TIGHT GAP', 500, true], ['SIDE GAP', 500, true]]) {
  for (const q of gaps) {
    if (usedGap.some((u) => Math.hypot(u.c[0] - q.c[0], u.c[1] - q.c[1]) < 40)) continue;
    const top = Math.min(q.hMin - 0.5, 9), G = g([q.c[0], (1.0 + top) / 2, q.c[1]], [q.t[0], 0, q.t[1]], q.d - 0.25, top - 1.0, [q.nrm[0], 0, q.nrm[1]]);
    if (!clearOf({ ...G, w: Math.min(1.2, G.w), h: G.h * 0.8 }).ok) continue;   // blocked (AC units, a pole, a drop): next gap
    usedGap.push(q);
    add(name, name === 'THE GAP' ? 'THE *GAP*!' : name.replace(/ (\w+)$/, ' *$1*!'), pts, G, { two: true, ...(micro ? { micro: true } : {}) });
    report.push(`  (${name}: ${q.d.toFixed(2)} m between ${q.lots.join(' and ')}, ${q.len.toFixed(1)} m deep, walls ${q.hMin.toFixed(1)} m)`);
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
    add(name, name.replace(/ (\w+)$/, ' *$1*!'), 1500, B, { pre: [A], within: speedWithin(L, 6) });
    add(name, name.replace(/ (\w+)$/, ' *$1*!'), 1500, neg(A), { pre: [neg(B)], within: speedWithin(L, 6) });
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
// 10. ROOFLINE: along the walking street's roofline, 1-6 m over the taller side, 30 m portals 60 m apart
{ const roofAt = (s) => { const p = at(walk.points, s); let h = 0; for (const l of layout.lots) { const d = Math.min(...l.footprint.map((q) => Math.hypot(q[0] - p.x, q[1] - p.z))); if (d < 18) h = Math.max(h, H(l)); } return h; };
  const s1 = WL * 0.3, s2 = WL * 0.6, top = Math.max(roofAt(s1), roofAt(s2)) + 1.5;
  const A = across(walk.points, s1, walk.width + 24, top, top + 5), B = across(walk.points, s2, walk.width + 24, top, top + 5);
  add('ROOFLINE', 'ROOF*LINE*!', 1500, B, { pre: [A], within: 8 });
  add('ROOFLINE', 'ROOF*LINE*!', 1500, neg(A), { pre: [neg(B)], within: 8 }); }
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
{ const p = at(walk.points, -2);
  lines.push({ name: 'THE CORNER', caption: 'THE *CORNER*!', pts: 500, micro: true, c: [r3(p.x), 3, r3(p.z)], carve: { kind: 'turn', box: [r3(p.x - 14), r3(p.x + 14), 1.5, 9, r3(p.z - 14), r3(p.z + 14)], sweep: 1.3 } });
  report.push(`THE CORNER           500  carve 28 x 28 m box at [${p.x.toFixed(1)}, ${p.z.toFixed(1)}] (micro)`); }

// ---- start points: each on a line's approach, hovering
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
const st = (name, s, pts, y, back = 8) => { const p = at(pts, s), sgn = s < 0 ? -1 : 1; return { name, pos: [r3(p.x - p.tx * back * sgn), y, r3(p.z - p.tz * back * sgn)], yaw: r3(yawTo(p.tx * sgn, p.tz * sgn)) }; };
const startPoints = [
  { ...st('Walking street', 15, walk.points, 4.0), hint: { text: 'FLY THE WALKING STREET · OVER THE HEADS', line: 'WALKING STREET', until: 2, next: 'WALKING STREET' } },
  st('Bar alley', 12, club.points, 3.2),
  { name: 'Exit 9', pos: lines.find((l) => l.name === 'SCREEN CANYON').pre[0].c.map((v, i) => i === 1 ? 11 : v - lines.find((l) => l.name === 'SCREEN CANYON').pre[0].n[i] * 10), yaw: r3(yawTo(lines.find((l) => l.name === 'SCREEN CANYON').n[0], lines.find((l) => l.name === 'SCREEN CANYON').n[2])) },
  st('Hongik-ro', 10, hong.points, 6.5),
  { name: 'Rooftops', pos: [r3(at(walk.points, WL * 0.3 - 20).x), r3(lines.find((l) => l.name === 'ROOFLINE').c[1]), r3(at(walk.points, WL * 0.3 - 20).z)], yaw: r3(yawTo(at(walk.points, WL * 0.3).tx, at(walk.points, WL * 0.3).tz)) },
];
const out = { version: 1, level: 'seoul-hongdae', generated: 'seoul/tools/lines.mjs from layout.json + buildSeoulGeometry', lines, funnels, startPoints, takeStart: { pos: startPoints[0].pos, yaw: startPoints[0].yaw } };
fs.writeFileSync(new URL('lines.json', ROOT), JSON.stringify(out, null, 1));
console.log(report.join('\n'));
console.log(`lines ${lines.length} entries, ${new Set(lines.map((l) => l.name)).size} named (${new Set(lines.filter((l) => !l.micro).map((l) => l.name)).size} lines + ${new Set(lines.filter((l) => l.micro).map((l) => l.name)).size} micro), funnels ${funnels.length}`);
