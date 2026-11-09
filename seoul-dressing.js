// seoul-dressing.js — Neon Seoul phase 2, stream E: street dressing and flyable set pieces for the Hongdae block.
//
// Contract P2-1
//   seoulDressing.geometry(layout, opts) is pure CPU (node-safe, deterministic, no Math.random) and returns
//     { merged: {matKey: BufferGeometry}, colTris: BufferGeometry (position only), emitters: [L3], setPieces: [...],
//       holes: [[[x, z], ...]], cables: [{pts, r}], labels: [...], lamps: [...], obstacles: [[x, z, r]], facts }
//   - merged keys are either S1/C keys (SEOUL_MATS: concrete, tile, walk, metal, white, dark, pole) with C's attribute
//     layout (position, normal, uv), or E's own keys (DRESS_MATS, prefix dr_) whose material comes from
//     seoulDressing.material(key, renderer). vcol keys carry `color`, emissive keys `aEm` (scene-linear radiance).
//   - holes: ground openings (stairwells). The ground ('walk') must not cover them: groundTris(x0, z0, x1, z1, holes).
//     Every hole lies off the street ribbons, and its walls, floor and ceiling are closed in colTris.
//   - opts (all optional): seed; lines (seoul/lines.json: gates to keep clear, pre-gates for road plates, gaps for doors);
//     poles, lotInfo (from buildSeoulGeometry: extra span cables, drops, roof clearances); emitters (C's, to keep clear
//     of street lights); shopTop (2.95), fasciaY (3.05); density (clutter, default 1: a perf knob).
//   seoulDressing.build(layout, ctx) (browser) returns { group, update(t, camPos, camQuat), dispose, stats }: screen-space
//   cable lines (>= 1.25 px, coverage alpha, lit by S3's grid as a MeshStandardMaterial), hangul labels (road-name
//   plates, exit signs, tent tarps, the bus stop) and the signal lamps, which follow seoul-life's crossPhase on the take clock.
//   Call it before seoulLight.attach so the cable material gets the city grid (it patches itself if attach ran first).
//
// Units: metres, y up, x east, z south. Light: NITS = 0.1 scene units per cd/m2 (integrator decision).
// Reference: review/seoul/reference.md (exits 9/1/2/8, Yanghwa-ro median bus lane, Red Road busking), panel1 art #4,
// design #2/#4, ux #4, color #2.
import * as THREE from 'three';
import * as LIFE from './seoul-life.js';      // namespace import: crossings + signal phases (tolerates API drift)

export const NITS = 0.1;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------------------- materials
// Same schema as world-seoul.js SEOUL_MATS (+ vcol: per-vertex colour; transparent/opacity; double; decal; noCol).
export const DRESS_MATS = {
  dr_steel: { color: [0.075, 0.078, 0.085], rough: 0.42, metal: 0.55, albedo: [0.075, 0.078, 0.085] },   // painted steel
  dr_galv: { color: [0.40, 0.41, 0.42], rough: 0.38, metal: 0.8, albedo: [0.40, 0.41, 0.42] },        // galvanised / stainless
  dr_glass: { color: [0.025, 0.03, 0.034], rough: 0.04, transparent: true, opacity: 0.3, double: true, albedo: [0.03, 0.03, 0.03] },
  dr_prop: { color: [1, 1, 1], rough: 0.6, vcol: true, albedo: [0.25, 0.22, 0.2] },                   // plastics, fabric, paint
  dr_tarp: { color: [1, 1, 1], rough: 0.75, vcol: true, emissive: true, double: true, albedo: [0.35, 0.14, 0.05] },   // lit from inside
  dr_glow: { color: [0.02, 0.02, 0.02], rough: 0.35, emissive: true, albedo: [0.02, 0.02, 0.02] },    // lit faces, tubes, doors
  dr_roadpaint: { color: [1, 1, 1], rough: 0.5, vcol: true, decal: true, noCol: true, albedo: [0.6, 0.6, 0.58] },   // wet via S3's name rule
  dr_bark: { color: [0.11, 0.095, 0.08], rough: 0.92, albedo: [0.11, 0.095, 0.08] },
  dr_leaf: { color: [1, 1, 1], rough: 0.8, vcol: true, albedo: [0.42, 0.33, 0.06] },
};
// S1/C keys this module writes into (attribute layout: position, normal, uv)
const C_KEYS = new Set(['concrete', 'tile', 'walk', 'metal', 'white', 'dark', 'pole', 'brick', 'plaster']);
const specOf = (k) => DRESS_MATS[k] || { emissive: false, vcol: false };

// browser: a ready material for an E key (C uses its own for C keys)
export function material(key, renderer) {
  const m = DRESS_MATS[key]; if (!m) return null;
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...m.color), roughness: m.rough ?? 0.8, metalness: m.metal || 0, vertexColors: !!m.vcol });
  if (m.transparent) { mat.transparent = true; mat.opacity = m.opacity ?? 0.5; mat.depthWrite = false; }
  if (m.double) mat.side = THREE.DoubleSide;
  if (m.decal) { mat.polygonOffset = true; mat.polygonOffsetFactor = -3; mat.polygonOffsetUnits = -3; }
  if (m.emissive) {
    mat.emissive = new THREE.Color(0, 0, 0);
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aEm;\nvarying vec3 vEm;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvEm = aEm;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vEm;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEm;');
    };
    mat.customProgramCacheKey = () => 'seoul:dr-em';
  }
  mat.name = 'seoul:' + key;
  return mat;
}

// ---------------------------------------------------------------------------------------------------------- helpers
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
function rng(seed) { let s = (typeof seed === 'number' ? seed : Math.floor(hash(seed) * 4294967296)) >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pip = (x, z, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
const segD = (px, pz, ax, az, bx, bz) => { const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1e-9; const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2)); return Math.hypot(px - ax - t * vx, pz - az - t * vz); };
function polyD(px, pz, P) { let d = Infinity; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; d = Math.min(d, segD(px, pz, a[0], a[1], b[0], b[1])); } return d; }
const polyArea = (P) => { let a = 0; for (let i = 0; i < P.length; i++) { const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % P.length]; a += x0 * z1 - x1 * z0; } return a / 2; };
const v3 = { add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; } };
const r3 = (v) => v.map((x) => +x.toFixed(3));
const srgb = (h) => { const c = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return [c(((h >> 16) & 255) / 255), c(((h >> 8) & 255) / 255), c((h & 255) / 255)]; };

// local frame: o + x*lx + y*ly + z*lz; frameH: x = horizontal dir, y = up, z = x cross up (the right of x)
function frameH(o, dx, dz) { const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; return { o, x: [dx, 0, dz], y: [0, 1, 0], z: [-dz, 0, dx] }; }
const W = (F, lx, ly, lz) => [F.o[0] + F.x[0] * lx + F.y[0] * ly + F.z[0] * lz, F.o[1] + F.x[1] * lx + F.y[1] * ly + F.z[1] * lz, F.o[2] + F.x[2] * lx + F.y[2] * ly + F.z[2] * lz];
const D = (F, lx, ly, lz) => [F.x[0] * lx + F.y[0] * ly + F.z[0] * lz, F.x[1] * lx + F.y[1] * ly + F.z[1] * lz, F.x[2] * lx + F.y[2] * ly + F.z[2] * lz];

// ---------------------------------------------------------------------------------------------------------- accumulator
// growable Float32 buffer (no GC churn, no array -> typed copy at the end); length is settable for rollbacks
class FBuf {
  constructor(n = 4096) { this.a = new Float32Array(n); this.length = 0; }
  need(k) { if (this.length + k > this.a.length) { const b = new Float32Array(Math.max(this.a.length * 2, this.length + k)); b.set(this.a.subarray(0, this.length)); this.a = b; } }
  p3(x, y, z) { const a = this.a, i = this.length; a[i] = x; a[i + 1] = y; a[i + 2] = z; this.length = i + 3; }
  p2(x, y) { const a = this.a, i = this.length; a[i] = x; a[i + 1] = y; this.length = i + 2; }
  out() { return this.a.slice(0, this.length); }
}
class Acc {
  constructor(spec) { this.p = new FBuf(); this.n = new FBuf(); this.uv = new FBuf(); this.e = spec.emissive ? new FBuf() : null; this.c = spec.vcol ? new FBuf() : null; }
  tri(a, b, c, ua, ub, uc, ea, eb, ec, col) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const P = this.p, N = this.n, U = this.uv; P.need(9); N.need(9); U.need(6);
    P.p3(a[0], a[1], a[2]); P.p3(b[0], b[1], b[2]); P.p3(c[0], c[1], c[2]); N.p3(nx, ny, nz); N.p3(nx, ny, nz); N.p3(nx, ny, nz); U.p2(ua[0], ua[1]); U.p2(ub[0], ub[1]); U.p2(uc[0], uc[1]);
    if (this.e) { const A = ea || Z3, B = eb || A, C = ec || A, E = this.e; E.need(9); E.p3(A[0], A[1], A[2]); E.p3(B[0], B[1], B[2]); E.p3(C[0], C[1], C[2]); }
    if (this.c) { const k = col || G3, C = this.c; C.need(9); C.p3(k[0], k[1], k[2]); C.p3(k[0], k[1], k[2]); C.p3(k[0], k[1], k[2]); }
  }
  geometry() {
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p.out(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.n.out(), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.out(), 2));
    if (this.e) g.setAttribute('aEm', new THREE.BufferAttribute(this.e.out(), 3));
    if (this.c) g.setAttribute('color', new THREE.BufferAttribute(this.c.out(), 3));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}
const Z3 = [0, 0, 0], G3 = [0.5, 0.5, 0.5];

// ---------------------------------------------------------------------------------------------------------- the block model
function blockModel(layout) {
  const streets = layout.streets.map((s) => {
    const P = s.points, segs = []; let len = 0;
    for (let i = 0; i < P.length - 1; i++) { const [ax, az] = P[i], [bx, bz] = P[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < 1e-3) continue; segs.push({ ax, az, bx, bz, L, tx: (bx - ax) / L, tz: (bz - az) / L, s0: len }); len += L; }
    return { ...s, segs, len };
  });
  const byId = new Map(streets.map((s) => [s.id, s]));
  // segment grid (20 m)
  const SC = 20, sg = new Map(), sk = (i, j) => i * 92821 + j;
  for (const st of streets) for (const g of st.segs) {
    const pad = st.width / 2 + 2, x0 = Math.min(g.ax, g.bx) - pad, x1 = Math.max(g.ax, g.bx) + pad, z0 = Math.min(g.az, g.bz) - pad, z1 = Math.max(g.az, g.bz) + pad;
    for (let i = Math.floor(x0 / SC); i <= Math.floor(x1 / SC); i++) for (let j = Math.floor(z0 / SC); j <= Math.floor(z1 / SC); j++) { const k = sk(i, j); if (!sg.has(k)) sg.set(k, []); sg.get(k).push([st, g]); }
  }
  // signed clearance to the nearest street ribbon (negative = on a ribbon); main = mains only
  const ribbonD = (x, z, mainOnly = false) => { let d = 99; for (const [st, g] of sg.get(sk(Math.floor(x / SC), Math.floor(z / SC))) || []) { if (mainOnly && st.kind !== 'main') continue; d = Math.min(d, segD(x, z, g.ax, g.az, g.bx, g.bz) - st.width / 2); } return d; };
  const project = (st, x, z) => { let best = null; for (const g of st.segs) { const vx = g.bx - g.ax, vz = g.bz - g.az; const t = clamp(((x - g.ax) * vx + (z - g.az) * vz) / (g.L * g.L), 0, 1); const px = g.ax + vx * t, pz = g.az + vz * t, d = Math.hypot(x - px, z - pz);
    if (!best || d < best.dist) best = { dist: d, s: g.s0 + t * g.L, px, pz, tx: g.tx, tz: g.tz, side: Math.sign(g.tx * (z - g.az) - g.tz * (x - g.ax)) || 1 }; } return best; };
  const at = (st, s) => { for (const g of st.segs) if (s <= g.s0 + g.L || g === st.segs[st.segs.length - 1]) { const t = clamp((s - g.s0) / g.L, 0, 1); return { x: g.ax + (g.bx - g.ax) * t, z: g.az + (g.bz - g.az) * t, tx: g.tx, tz: g.tz }; } return null; };
  // lots
  const lots = layout.lots, LC = 20, lg = new Map();
  for (const l of lots) { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const [x, z] of l.footprint) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    l._bb = [x0, x1, z0, z1]; l._H = l.floors * l.floorH;
    for (let i = Math.floor(x0 / LC); i <= Math.floor(x1 / LC); i++) for (let j = Math.floor(z0 / LC); j <= Math.floor(z1 / LC); j++) { const k = sk(i, j); if (!lg.has(k)) lg.set(k, []); lg.get(k).push(l); } }
  const lotAt = (x, z) => (lg.get(sk(Math.floor(x / LC), Math.floor(z / LC))) || []).find((l) => x >= l._bb[0] && x <= l._bb[1] && z >= l._bb[2] && z <= l._bb[3] && pip(x, z, l.footprint)) || null;
  const lotsNear = (x, z) => lg.get(sk(Math.floor(x / LC), Math.floor(z / LC))) || [];
  const lotClear = (x, z, r) => !lotAt(x, z) && !lotsNear(x, z).some((l) => x > l._bb[0] - r && x < l._bb[1] + r && z > l._bb[2] - r && z < l._bb[3] + r && polyD(x, z, l.footprint) < r);
  // march from (x,z) along (dx,dz) to the first facade (or max)
  const freeRay = (x, z, dx, dz, max = 30, step = 0.2) => { for (let d = 0; d <= max; d += step) if (lotAt(x + dx * d, z + dz * d)) return d; return Infinity; };
  return { streets, byId, ribbonD, project, at, lots, lotAt, lotClear, freeRay };
}

// gates from lines.json (gate + pre-gates), with their basis
function gatesOf(lineData) {
  const out = [];
  const basis = (G) => { const n = v3.norm(G.n); let u = G.u ? G.u.slice() : Math.abs(n[1]) > 0.9 ? [1, 0, 0] : v3.cross([0, 1, 0], n); const d = v3.dot(u, n); u = v3.norm([u[0] - n[0] * d, u[1] - n[1] * d, u[2] - n[2] * d]); return { n, u, v: v3.cross(n, u) }; };
  for (const l of lineData?.lines || []) {
    if (l.carve || !l.c || l.piece) continue;   // set-piece lines are E's own gates (registered by the pieces themselves)
    out.push({ name: l.name, c: l.c, w: l.w, h: l.h, two: !!l.two, micro: !!l.micro, pre: false, line: l, ...basis(l) });
    for (const p of l.pre || []) out.push({ name: l.name, c: p.c, w: p.w, h: p.h, pre: true, line: l, ...basis(p) });
  }
  return out;
}
const gateDist = (p, g) => { const d = v3.sub(p, g.c), a = v3.dot(d, g.u), b = v3.dot(d, g.v), c = v3.dot(d, g.n); const ea = Math.max(0, Math.abs(a) - g.w / 2), eb = Math.max(0, Math.abs(b) - g.h / 2); return Math.hypot(ea, eb, c); };

// set-piece gates join the clearance list (so later dressing keeps out of them): flatten {pre, gate, left: {pre, gate}, windows: [..]}
function spGates(sp) {
  const out = [], walk = (o) => { if (!o) return; if (o.c && o.n) { out.push(o); return; } for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v); };
  walk(sp.gates);
  return gatesOf({ lines: out.map((g) => ({ name: sp.name, ...g })) }).map((g) => ({ ...g, sp: true }));
}

// ================================================================================================================
// geometry(layout, opts) — contract P2-1 (pure CPU)
// ================================================================================================================
const CACHE = new WeakMap();
export function geometry(layout, opts = {}) {
  const t0 = Date.now();
  const seed = opts.seed ?? 11, R0 = rng('dress' + seed);
  const M = blockModel(layout);
  const gates = gatesOf(opts.lines);
  const shopTop = opts.shopTop ?? 2.95, fasciaY = opts.fasciaY ?? 3.05;
  const dens = clamp(opts.density ?? 1, 0, 3);   // clutter density (scooters, stools, bags): a perf knob, 1 = the reference look
  const acc = {}; const A = (k) => (acc[k] ||= new Acc(specOf(k)));
  const col = new FBuf(1 << 16);       // collider positions (non-indexed)
  const emitters = [], setPieces = [], holes = [], cables = [], labels = [], lamps = [];
  const spPush = setPieces.push.bind(setPieces);
  setPieces.push = (...sps) => { for (const sp of sps) gates.push(...spGates(sp)); return spPush(...sps); };
  const msParts = {}; let tLap = Date.now(); const lap = (k) => { const t = Date.now(); msParts[k] = t - tLap; tLap = t; };
  const facts = { tris: 0, colTris: 0, items: 0, rejectedByGates: 0, scooters: 0, tents: 0, trees: 0, awnings: 0, cablesExtra: 0, drops: 0, signals: 0, crossings: 0, plates: 0, doors: 0, b1: 0, stairs2f: 0 };

  // ---------------- kit state: material key, colour (vcol keys), emission (emissive keys), collidable
  const S = { key: 'concrete', c: [0.5, 0.5, 0.5], em: null, col: true };
  const set = (key, o = {}) => { S.key = key; S.c = o.c || S.c; S.em = o.em ?? null; S.col = o.col ?? !specOf(key).noCol; return S; };
  const uvDef = [[0, 0], [1, 0], [1, 1], [0, 1]];
  function tri(a, b, c, ua = [0, 0], ub = [1, 0], uc = [1, 1], e) {
    A(S.key).tri(a, b, c, ua, ub, uc, e ? e[0] : S.em, e ? e[1] : S.em, e ? e[2] : S.em, S.c);
    if (S.col) { col.need(9); col.p3(a[0], a[1], a[2]); col.p3(b[0], b[1], b[2]); col.p3(c[0], c[1], c[2]); }
  }
  // quad p0..p3 facing nrm (winding fixed), uv per corner, optional per-corner emission
  function quad(p0, p1, p2, p3, nrm, uvs = uvDef, e4) {
    const cr = v3.cross(v3.sub(p1, p0), v3.sub(p3, p0));
    const E = e4 || [S.em, S.em, S.em, S.em];
    if (v3.dot(cr, nrm) >= 0) { tri(p0, p1, p2, uvs[0], uvs[1], uvs[2], [E[0], E[1], E[2]]); tri(p0, p2, p3, uvs[0], uvs[2], uvs[3], [E[0], E[2], E[3]]); }
    else { tri(p0, p2, p1, uvs[0], uvs[2], uvs[1], [E[0], E[2], E[1]]); tri(p0, p3, p2, uvs[0], uvs[3], uvs[2], [E[0], E[3], E[2]]); }
  }
  // box in frame F: centre (local), half sizes (local); faces: skip = set of 'px','nx','py','ny','pz','nz'
  function box(F, cx, cy, cz, hx, hy, hz, skip = null) {
    const P = (x, y, z) => W(F, cx + x, cy + y, cz + z), N = (x, y, z) => D(F, x, y, z);
    const f = (k, a, b, c, d, n, w, h) => { if (!skip || !skip.includes(k)) quad(P(...a), P(...b), P(...c), P(...d), N(...n), [[0, 0], [w, 0], [w, h], [0, h]]); };
    f('pz', [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [0, 0, 1], 2 * hx, 2 * hy);
    f('nz', [hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [0, 0, -1], 2 * hx, 2 * hy);
    f('px', [hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [1, 0, 0], 2 * hz, 2 * hy);
    f('nx', [-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-1, 0, 0], 2 * hz, 2 * hy);
    f('py', [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz], [0, 1, 0], 2 * hx, 2 * hz);
    f('ny', [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz], [0, -1, 0], 2 * hx, 2 * hz);
  }
  // box from local min/max corners
  const boxMM = (F, x0, y0, z0, x1, y1, z1, skip) => box(F, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2, skip);
  // cylinder in frame F along local axis ('x' | 'y' | 'z'), centre c (local), radius r0 -> r1 over length L
  function cyl(F, c, axis, r0, L, sides = 8, r1 = r0, caps = true) {
    const ax = axis === 'x' ? [1, 0, 0] : axis === 'z' ? [0, 0, 1] : [0, 1, 0], p1 = axis === 'y' ? [1, 0, 0] : [0, 1, 0], p2 = v3.cross(ax, p1);
    const at = (k, s, r) => { const th = (k / sides) * TAU, cs = Math.cos(th), sn = Math.sin(th); return W(F, c[0] + ax[0] * s + (p1[0] * cs + p2[0] * sn) * r, c[1] + ax[1] * s + (p1[1] * cs + p2[1] * sn) * r, c[2] + ax[2] * s + (p1[2] * cs + p2[2] * sn) * r); };
    for (let k = 0; k < sides; k++) {
      const thm = ((k + 0.5) / sides) * TAU, nl = [p1[0] * Math.cos(thm) + p2[0] * Math.sin(thm), p1[1] * Math.cos(thm) + p2[1] * Math.sin(thm), p1[2] * Math.cos(thm) + p2[2] * Math.sin(thm)];
      quad(at(k, -L / 2, r0), at(k + 1, -L / 2, r0), at(k + 1, L / 2, r1), at(k, L / 2, r1), D(F, ...nl));
      if (caps) { tri(W(F, c[0] + ax[0] * L / 2, c[1] + ax[1] * L / 2, c[2] + ax[2] * L / 2), at(k + 1, L / 2, r1), at(k, L / 2, r1)); tri(W(F, c[0] - ax[0] * L / 2, c[1] - ax[1] * L / 2, c[2] - ax[2] * L / 2), at(k, -L / 2, r0), at(k + 1, -L / 2, r0)); }
    }
  }
  const FW = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };      // world frame
  // tube along a polyline (world), radius r
  function tube(pts, r, sides = 3) {
    const ring = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const t = v3.norm(v3.sub(b, a)), up = Math.abs(t[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = v3.norm(v3.cross(t, up)), v = v3.norm(v3.cross(u, t));
      ring.push([...Array(sides)].map((_, k) => { const th = (k / sides) * TAU + 0.3, cs = Math.cos(th), sn = Math.sin(th); return { p: [pts[i][0] + (u[0] * cs + v[0] * sn) * r, pts[i][1] + (u[1] * cs + v[1] * sn) * r, pts[i][2] + (u[2] * cs + v[2] * sn) * r], n: [u[0] * cs + v[0] * sn, u[1] * cs + v[1] * sn, u[2] * cs + v[2] * sn] }; }));
    }
    for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < sides; k++) {
      const a = ring[i][k], b = ring[i][(k + 1) % sides], c = ring[i + 1][(k + 1) % sides], d = ring[i + 1][k];
      quad(a.p, b.p, c.p, d.p, v3.mul(v3.add(a.n, b.n), 0.5), [[k / sides, i], [(k + 1) / sides, i], [(k + 1) / sides, i + 1], [k / sides, i + 1]]);
    }
  }
  // icosahedron blob (detail 0 or 1), radii rx/ry/rz, jittered
  const ICO = (() => { const t = (1 + Math.sqrt(5)) / 2; const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(v3.norm);
    const f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const f1 = [], v1 = v.slice(), mid = new Map(); const m = (a, b) => { const k = a < b ? a + '_' + b : b + '_' + a; if (!mid.has(k)) { v1.push(v3.norm(v3.add(v1[a], v1[b]))); mid.set(k, v1.length - 1); } return mid.get(k); };
    for (const [a, b, c] of f) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); f1.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    return [{ v, f }, { v: v1, f: f1 }]; })();
  function blob(c, rx, ry, rz, R, detail = 0, jit = 0.18) {
    const { v, f } = ICO[detail]; const P = v.map((p) => { const j = 1 + (R() - 0.5) * 2 * jit; return [c[0] + p[0] * rx * j, c[1] + p[1] * ry * j, c[2] + p[2] * rz * j]; });
    for (const [a, b, cc] of f) { const n = v3.norm(v3.cross(v3.sub(P[b], P[a]), v3.sub(P[cc], P[a]))); const out = v3.dot(n, v3.sub(P[a], c)) >= 0; if (out) tri(P[a], P[b], P[cc]); else tri(P[a], P[cc], P[b]); }
  }
  // flat decal polygon (convex), y fixed
  function decal(pts2, y, uv = null) { for (let i = 1; i < pts2.length - 1; i++) { const a = [pts2[0][0], y, pts2[0][1]], b = [pts2[i][0], y, pts2[i][1]], c = [pts2[i + 1][0], y, pts2[i + 1][1]]; const cr = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]); if (cr >= 0) tri(a, b, c); else tri(a, c, b); } }

  // ---------------- items: everything emitted between mark() and commit() is one item; rolled back if it enters a gate
  const lens = () => { const o = {}; for (const [k, a] of Object.entries(acc)) o[k] = [a.p.length, a.n.length, a.uv.length, a.e ? a.e.length : 0, a.c ? a.c.length : 0]; return { o, col: col.length, em: emitters.length, cab: cables.length, lab: labels.length, lamp: lamps.length }; };
  function rollback(m) { for (const [k, a] of Object.entries(acc)) { const L = m.o[k] || [0, 0, 0, 0, 0]; a.p.length = L[0]; a.n.length = L[1]; a.uv.length = L[2]; if (a.e) a.e.length = L[3]; if (a.c) a.c.length = L[4]; } col.length = m.col; emitters.length = m.em; cables.length = m.cab; labels.length = m.lab; lamps.length = m.lamp; }
  function aabbSince(m) { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (const [k, a] of Object.entries(acc)) { const s = (m.o[k] || [0])[0], P = a.p.a; for (let i = s; i < a.p.length; i += 3) { for (let j = 0; j < 3; j++) { const v = P[i + j]; if (v < b[j]) b[j] = v; if (v > b[j + 3]) b[j + 3] = v; } } } return b; }
  // does the AABB come within `m` of a gate rect? (samples the rect)
  const gSamples = (g) => g._s ||= (() => { const o = []; for (let i = 0; i <= 8; i++) for (let j = 0; j <= 6; j++) o.push(v3.add(v3.add(g.c, v3.mul(g.u, (i / 8 - 0.5) * g.w)), v3.mul(g.v, (j / 6 - 0.5) * g.h))); const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (const p of o) for (let k = 0; k < 3; k++) { bb[k] = Math.min(bb[k], p[k]); bb[k + 3] = Math.max(bb[k + 3], p[k]); } o.bb = bb; return o; })();
  const gateHit = (b, m = 0.35, skip = null, nG = gates.length) => { for (let gi = 0; gi < nG; gi++) { const g = gates[gi]; if (skip && skip(g)) continue; const S2 = gSamples(g), gb = S2.bb;
    if (gb[0] > b[3] + m || gb[3] < b[0] - m || gb[1] > b[4] + m || gb[4] < b[1] - m || gb[2] > b[5] + m || gb[5] < b[2] - m) continue;
    for (const p of S2) if (p[0] > b[0] - m && p[0] < b[3] + m && p[1] > b[1] - m && p[1] < b[4] + m && p[2] > b[2] - m && p[2] < b[5] + m) return g; } return null; };
  // (a set piece registers its own gates inside fn: the item is checked only against the gates that existed before it)
  function item(fn, o = {}) {
    const m = lens(), g0 = gates.length, s0 = setPieces.length, h0 = holes.length;
    const undo = () => { rollback(m); gates.length = g0; setPieces.length = s0; holes.length = h0; };
    const r = fn(); if (r === false) { undo(); return false; }
    if (!o.noGate && g0) { const g = gateHit(aabbSince(m), o.margin ?? 0.35, o.skip, g0); if (g) { undo(); facts.rejectedByGates++; if (opts.debug && o.tag) console.log('gate reject', o.tag, g.name); return false; } }
    facts.items++; return true;
  }
  // a polyline (cable) must stay `m` clear of every gate rect: segments sampled every <= 0.2 m (vertices alone miss crossings)
  const polyGateOK = (pts, m = 0.35) => { for (const g of gates) for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.2));
    if (gateDist(a, g) > m + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) + 0.5) continue;
    for (let k = 0; k <= n; k++) { const t = k / n; if (gateDist([lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)], g) < m) return false; } } return true; };

  // ---------------- occupancy (ground footprints of placed things, discs)
  const OC = 4, occ = new Map(), ok_ = (i, j) => i * 92821 + j;
  const occFree = (x, z, r) => { for (let i = Math.floor((x - r - 3) / OC); i <= Math.floor((x + r + 3) / OC); i++) for (let j = Math.floor((z - r - 3) / OC); j <= Math.floor((z + r + 3) / OC); j++) for (const d of occ.get(ok_(i, j)) || []) if (Math.hypot(d[0] - x, d[1] - z) < d[2] + r) return false; return true; };
  const occAdd = (x, z, r) => { const k = ok_(Math.floor(x / OC), Math.floor(z / OC)); if (!occ.has(k)) occ.set(k, []); occ.get(k).push([x, z, r]); };
  const occRect = (F, x0, x1, z0, z1, pad = 0) => { for (let x = x0; x <= x1 + 1e-6; x += Math.max(0.5, (x1 - x0) / Math.ceil((x1 - x0) / 1.5))) for (let z = z0; z <= z1 + 1e-6; z += Math.max(0.5, (z1 - z0) / Math.ceil((z1 - z0) / 1.5 || 1))) { const p = W(F, x, 0, z); occAdd(p[0], p[2], 0.9 + pad); } };
  const rectFree = (F, x0, x1, z0, z1, test) => { for (let x = x0; x <= x1 + 1e-6; x += (x1 - x0) / Math.max(1, Math.ceil((x1 - x0) / 0.5))) for (let z = z0; z <= z1 + 1e-6; z += (z1 - z0) / Math.max(1, Math.ceil((z1 - z0) / 0.5))) { const p = W(F, x, 0, z); if (!test(p[0], p[2])) return false; } return true; };
  // keep clear of C's street-light poles and utility poles
  for (const e of opts.emitters || []) if (e.kind === 'street' && e.pos) occAdd(e.pos[0], e.pos[2], 1.8);
  for (const p of opts.poles || []) occAdd(p.x, p.z, 0.5);

  const emit = (o) => { emitters.push({ animated: false, ...o, pos: r3(o.pos), normal: r3(v3.norm(o.normal)) }); };
  const NI = (rgb, nits) => rgb.map((c) => c * nits * NITS);       // emissive radiance for aEm
  const mainStreets = M.streets.filter((s) => s.kind === 'main');
  const inCore = (x, z) => { const b = layout.box || layout.core; return !b || (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1); };

  // ================================================================================================ SET PIECES
  // ---- stairwell (station exits and B1 basements): local x = descent, z = right; o = top of the first riser, centre
  function stairwell(o, f, p) {
    const F = frameH([o[0], 0, o[1]], f[0], f[1]);
    const { W: w, rise, tread, n1, land, n2 = 0, land2 = 0, wallT = 0.25, hole } = p, hw = w / 2;
    const y1 = -n1 * rise, x1 = n1 * tread, xL = x1 + land, y2 = y1 - n2 * rise, x2 = xL + n2 * tread, xE = x2 + land2;
    const floorBot = y2 - 0.3, Lh = hole;      // hole: length of the opening at grade (local x 0..Lh)
    const wallTop = p.parapet ?? 1.05;
    // steps (granite), landing(s)
    set('concrete');
    for (let i = 0; i < n1; i++) boxMM(F, i * tread, -(i + 1) * rise - 0.22, -hw, (i + 1) * tread, -(i + 1) * rise, hw, ['ny']);
    boxMM(F, x1, y1 - 0.3, -hw, xL, y1, hw, ['ny']);
    for (let j = 0; j < n2; j++) boxMM(F, xL + j * tread, y1 - (j + 1) * rise - 0.22, -hw, xL + (j + 1) * tread, y1 - (j + 1) * rise, hw, ['ny']);
    if (n2) boxMM(F, x2, y2 - 0.3, -hw, xE, y2, hw, ['ny']);
    // under-fill: closes the void below the steps (seen only from inside if anything is mis-aligned)
    boxMM(F, 0, floorBot - 0.3, -hw, xE, floorBot, hw, ['py']);
    // nosing strips (dark anti-slip) on flight 1
    set('dark'); for (let i = 0; i < n1; i++) boxMM(F, (i + 1) * tread - 0.06, -(i + 1) * rise, -hw + 0.05, (i + 1) * tread - 0.01, -(i + 1) * rise + 0.006, hw - 0.05, ['ny']);
    // head kerb under the sidewalk edge (top just below grade, hidden by the ground)
    set('concrete'); boxMM(F, -0.3, floorBot - 0.3, -hw - wallT, 0, -0.004, hw + wallT, ['py']);
    // side walls: tiled inside, rising to a parapet over the opening
    const yTopAt = (x) => (x <= Lh ? wallTop : -0.004);
    for (const sd of [-1, 1]) {
      const zi = sd * hw, zo = sd * (hw + wallT);
      set(p.wallMat || 'tile');
      boxMM(F, 0, floorBot, Math.min(zi, zo), Lh, wallTop, Math.max(zi, zo));
      boxMM(F, Lh, floorBot, Math.min(zi, zo), xE + wallT, -0.004, Math.max(zi, zo), ['py']);
    }
    // the end wall + ceiling slab over the covered part (underside at -slab)
    const slab = p.slab ?? 0.35;
    set(p.wallMat || 'tile'); boxMM(F, xE, floorBot, -hw - wallT, xE + wallT, -0.004, hw + wallT, ['py']);
    set('concrete'); boxMM(F, Lh, -slab, -hw - wallT, xE + wallT, -0.004, hw + wallT, ['py']);
    // the opening's far parapet only when the opening ends before the slab line (it does not: the slab starts at Lh)
    // handrails on both walls, following the flights (galvanised, 0.88 m over the nosings)
    set('dr_galv');
    for (const sd of [-1, 1]) {
      const z = sd * (hw - 0.06), pts = [W(F, -0.2, 0.9, z), W(F, 0, 0.88, z), W(F, x1, y1 + 0.88, z), W(F, xL, y1 + 0.88, z)];
      if (n2) pts.push(W(F, x2, y2 + 0.88, z), W(F, xE - 0.2, y2 + 0.88, z));
      tube(pts, 0.025, 4);
    }
    // ceiling lights (fluorescent strips) under the slab, and the lit concourse doorway at the far end
    const tube_ = p.lightRGB || [0.92, 0.98, 1.0];
    set('dr_glow', { em: NI(tube_, p.tubeNits ?? 650), col: false });
    for (let x = Lh + 0.8; x < xE - 0.4; x += 2.6) boxMM(F, x, -slab - 0.03, -0.06, x + 1.2, -slab, 0.06, ['py']);
    if (p.endGlow) { set('dr_glow', { em: NI(p.endGlow.rgb, p.endGlow.nits), col: false }); const gw = Math.min(w - 0.4, 2.2); quad(W(F, xE - 0.01, y2 + 0.02, -gw / 2), W(F, xE - 0.01, y2 + 0.02, gw / 2), W(F, xE - 0.01, y2 + Math.min(2.4, -y2 - slab - 0.1), gw / 2), W(F, xE - 0.01, y2 + Math.min(2.4, -y2 - slab - 0.1), -gw / 2), D(F, -1, 0, 0)); }
    holes.push([W(F, 0, 0, -hw - wallT), W(F, Lh, 0, -hw - wallT), W(F, Lh, 0, hw + wallT), W(F, 0, 0, hw + wallT)].map((q) => [+q[0].toFixed(3), +q[2].toFixed(3)]));
    return { F, x1, y1, xL, x2, y2, xE, Lh, hw, wallT };
  }

  // a placement search: rectangle (local x0..x1, z0..z1) around a frame at candidate origins near `target`
  function findSpot(target, dir, rect, test, { radius = 30, step = 1 } = {}) {
    const [tx, tz] = dir, nx = -tz, nz = tx, cand = [];
    for (let a = -radius; a <= radius; a += step) for (let b = -radius; b <= radius; b += step) { const d = Math.hypot(a, b); if (d <= radius) cand.push([d, a, b]); }
    cand.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    for (const [d, a, b] of cand) {
      const ox = target[0] + tx * a + nx * b, oz = target[1] + tz * a + nz * b, F = frameH([ox, 0, oz], tx, tz);
      if (!test(ox, oz)) continue;
      if (rectFree(F, rect[0], rect[1], rect[2], rect[3], test)) return { o: [ox, oz], d, F };
    }
    return null;
  }
  const sidewalkOK = (pad = 0.4, lotPad = 0.6, occR = 0.4) => (x, z) => M.ribbonD(x, z) > pad && M.lotClear(x, z, lotPad) && occFree(x, z, occR) && inCore(x, z);

  lap('setup');
  // ---- 1. STATION STAIRS: Hongik Univ. Station exits (reference.md: 9 (-7,225), 1 (-28,252), 2 (78,349), 8 (99,319) from
  // 37.5540 N 126.9230 E, x east / y north) -> layout origin.
  const toLayout = (rx, ry) => { const o = layout.origin || { lat: 37.5532, lon: 126.9224 }; return [rx + (126.9230 - o.lon) * 111320 * Math.cos(o.lat * Math.PI / 180), -(ry + (37.5540 - o.lat) * 110574)]; };
  const EXITS = [{ n: '9', ref: [-7, 225], deep: true, flip: -1 }, { n: '1', ref: [-28, 252], flip: 1 }, { n: '2', ref: [78, 349], flip: -1 }, { n: '8', ref: [99, 319], flip: 1 }];
  const yanghwa = mainStreets.filter((s) => s.ko === '양화로');
  // the station-front crossing of Yanghwa-ro, between exits 9 and 1 (from the layout, not from lines.json)
  const stationX = (() => { const a = toLayout(...EXITS[0].ref), b = toLayout(...EXITS[1].ref); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; })();
  for (const ex of EXITS) {
    const target = toLayout(...ex.ref);
    const road = yanghwa.map((s) => ({ s, p: M.project(s, target[0], target[1]) })).sort((a, b) => a.p.dist - b.p.dist)[0];
    if (!road || road.p.dist > 60) continue;
    const f = [road.p.tx * ex.flip, road.p.tz * ex.flip];
    const P = ex.deep ? { W: 3.2, rise: 0.17, tread: 0.3, n1: 18, land: 3.0, n2: 10, land2: 2.2, hole: 5.1, endGlow: { rgb: [0.95, 0.97, 1.0], nits: 40 } }
      : { W: 3.0, rise: 0.17, tread: 0.3, n1: 17, land: 2.4, n2: 4, land2: 1.6, hole: 4.8, endGlow: { rgb: [0.95, 0.97, 1.0], nits: 35 } };
    const hwT = P.W / 2 + 0.25;
    // canopy footprint incl. the mouth apron (people need room to walk in): x -1.5..hole+0.4, z +-(hwT+0.5)
    const spot = findSpot(target, f, [-0.9, P.hole + 0.4, -hwT - 0.3, hwT + 0.3], sidewalkOK(0.45, 0.6, 0.3), { radius: 34, step: 0.5 });
    if (opts.debug) console.log('exit', ex.n, 'target', target.map((v) => v.toFixed(1)), 'road', road.s.id, road.p.dist.toFixed(1), 'spot', spot && spot.o.map((v) => v.toFixed(1)), spot && spot.d.toFixed(1));
    if (!spot) continue;
    item(() => {
      const st = stairwell(spot.o, f, P), F = st.F, Lh = st.Lh;
      // glass canopy: steel posts on the parapets, a gently sloped glass roof, glass sides and back; open mouth
      const zE = hwT + 0.12, yR0 = 2.78, yR1 = 2.66;
      set('dr_steel');
      for (const x of [0.05, Lh / 2, Lh - 0.05]) for (const sd of [-1, 1]) boxMM(F, x - 0.06, 1.05, sd * (hwT - 0.18) - 0.06, x + 0.06, lerp(yR0, yR1, x / Lh), sd * (hwT - 0.18) + 0.06);
      for (const sd of [-1, 1]) boxMM(F, -0.35, yR0 - 0.02, sd * zE - 0.07, Lh + 0.3, yR0 + 0.1, sd * zE + 0.07);          // eaves beams
      boxMM(F, -0.42, yR0 - 0.02, -zE, -0.3, yR0 + 0.36, zE);                                                            // front fascia (sign carrier)
      boxMM(F, Lh + 0.18, yR1 - 0.02, -zE, Lh + 0.3, yR1 + 0.1, zE);
      set('dr_glass');
      { const a = W(F, -0.3, yR0 + 0.06, -zE), b = W(F, Lh + 0.18, yR1 + 0.06, -zE), c = W(F, Lh + 0.18, yR1 + 0.06, zE), d = W(F, -0.3, yR0 + 0.06, zE); quad(a, b, c, d, [0, 1, 0]); quad(a, d, c, b, [0, -1, 0]); }
      for (const sd of [-1, 1]) boxMM(F, 0.05, 1.05, sd * (hwT - 0.13) - 0.01, Lh - 0.05, yR1, sd * (hwT - 0.13) + 0.01);       // side glass
      boxMM(F, Lh + 0.2, 0.0, -zE, Lh + 0.22, yR1, zE);                                                                    // back glass
      // LED strips under the eaves
      set('dr_glow', { em: NI([1.0, 0.97, 0.92], 450), col: false });
      for (const sd of [-1, 1]) boxMM(F, 0.0, yR0 - 0.05, sd * (hwT - 0.35) - 0.025, Lh, yR0 - 0.02, sd * (hwT - 0.35) + 0.025, ['py']);
      // the sign: station name band + yellow exit number tile on the front fascia (faces -x, toward people walking in)
      const sn = D(F, -1, 0, 0);
      set('dr_glow', { em: NI([0.92, 0.96, 1.0], 110), col: false });
      quad(W(F, -0.425, yR0 + 0.02, -zE + 0.05), W(F, -0.425, yR0 + 0.02, zE - 0.75), W(F, -0.425, yR0 + 0.33, zE - 0.75), W(F, -0.425, yR0 + 0.33, -zE + 0.05), sn);
      set('dr_glow', { em: NI(srgb(0xffc20e), 180), col: false });
      quad(W(F, -0.425, yR0 + 0.0, zE - 0.7), W(F, -0.425, yR0 + 0.0, zE - 0.05), W(F, -0.425, yR0 + 0.35, zE - 0.05), W(F, -0.425, yR0 + 0.35, zE - 0.7), sn);
      labels.push({ id: 'exit' + ex.n + ':name', kind: 'station', pos: r3(W(F, -0.43, yR0 + 0.175, (-zE + 0.05 + zE - 0.75) / 2)), normal: r3(sn), right: r3(D(F, 0, 0, -1)), w: 2 * zE - 0.8, h: 0.31, nits: 110, lines: ['홍대입구', 'Hongik Univ.'], badges: ['2', 'K', 'A'] });
      labels.push({ id: 'exit' + ex.n + ':num', kind: 'exitnum', pos: r3(W(F, -0.43, yR0 + 0.175, zE - 0.375)), normal: r3(sn), right: r3(D(F, 0, 0, -1)), w: 0.65, h: 0.35, nits: 180, lines: [ex.n] });
      emit({ id: 'dress:exit' + ex.n + ':canopy', kind: 'store', pos: W(F, Lh / 2, yR0 - 0.1, 0), normal: [0, -1, 0], w: 2.4, h: Math.max(1, Lh - 0.6), rgb: [1.0, 0.95, 0.88], nits: 140, range: 10 });
      emit({ id: 'dress:exit' + ex.n + ':sign', kind: 'lightbox', pos: W(F, -0.45, yR0 + 0.18, 0), normal: sn, w: 2 * zE, h: 0.35, rgb: [0.95, 0.95, 0.9], nits: 120 });
      emit({ id: 'dress:exit' + ex.n + ':stair', kind: 'store', pos: W(F, st.xL - 0.5, -0.45, 0), normal: [0, -1, 0], w: 1.0, h: 3.0, rgb: [0.92, 0.98, 1.0], nits: 220, range: 5.5 });
      occRect(F, -1.2, Lh + 0.4, -hwT, hwT, 0.2);
      if (ex.deep) {
        // the set piece: from the canopy mouth down flight 1 to the first landing (headroom 2.7 m there)
        const pre = { c: r3(W(F, -0.9, 1.45, 0)), n: r3(D(F, 1, 0, 0)), u: r3(D(F, 0, 0, 1)), w: 2.4, h: 1.8 };
        const gate = { c: r3(W(F, st.x1 + 1.6, st.y1 + 1.26, 0)), n: r3(D(F, 1, 0, 0)), u: r3(D(F, 0, 0, 1)), w: 2.3, h: 1.8 };
        setPieces.push({ id: 'station-stairs', kind: 'stairs', name: 'STATION STAIRS', exit: ex.n, pos: r3(W(F, Lh / 2, 0, 0)), dir: r3(D(F, 1, 0, 0)), gates: { pre, gate },
          landing: { y: +st.y1.toFixed(2), headroom: +(-0.35 - st.y1).toFixed(2) }, note: 'dive under the canopy, down 18 steps (3.06 m) to the first landing; flip and climb out' });
      }
      setPieces.push({ id: 'exit-' + ex.n, kind: 'exit', name: 'EXIT ' + ex.n, pos: r3(W(F, Lh / 2, 0, 0)), dir: r3(D(F, 1, 0, 0)), mouth: r3(W(F, -0.8, 1.4, 0)) });
    }, { noGate: true });
  }

  lap('exits');
  // ---- 2. Yanghwa-ro median bus stop (the island between the two one-way carriageways, under the screens)
  {
    const pairs = [];
    for (const a of mainStreets) for (const b of mainStreets) {
      if (a === b || a.ko !== b.ko || a.len < 150 || b.len < 150) continue;
      const m = M.at(a, a.len / 2), pb = M.project(b, m.x, m.z);
      if (pb.dist < (a.width + b.width) / 2 + 22 && pb.dist > 4 && m.tx * pb.tx + m.tz * pb.tz < -0.8 && a.len >= b.len) pairs.push([a, b]);
    }
    const pair = pairs.sort((p, q) => (q[0].ko === '양화로') - (p[0].ko === '양화로'))[0];
    if (pair) {
      const [a, b] = pair;
      // G's bus stops sit at 45 % of each carriageway (seoul-life TrafficSim); centre the island between the two
      const sa = M.at(a, a.len * 0.45), sb = M.at(b, b.len * 0.45), pbA = M.project(a, sb.x, sb.z);
      let sMid = (a.len * 0.45 + pbA.s) / 2;
      // stay clear of the exit stairs and THE CROSSING: slide toward the screens (SW) when the island would sit on them
      const ctr = (s) => { const q = M.at(a, s), pb2 = M.project(b, q.x, q.z), dAB = pb2.dist, off = (dAB - a.width / 2 - b.width / 2) / 2 + a.width / 2, sx = pb2.side;
        const nx = -q.tz, nz = q.tx, sgn = Math.sign((pb2.px - q.x) * nx + (pb2.pz - q.z) * nz) || 1; return { x: q.x + nx * off * sgn, z: q.z + nz * off * sgn, tx: q.tx, tz: q.tz, gap: dAB - a.width / 2 - b.width / 2, sx }; };
      const isl = { L: 40, w: 3.0, h: 0.18 }, can = { L: 24, w: 3.8, y: 3.3 };
      // keep the island's noses off THE CROSSING's zebra (a refuge would be cut there; ours simply stops short)
      { const pc = M.project(a, stationX[0], stationX[1]), gap = isl.L / 2 + 5; if (Math.abs(pc.s - sMid) < gap) sMid = pc.s + Math.sign(sMid - pc.s || 1) * gap; }
      let c = ctr(sMid);
      const F = frameH([c.x, 0, c.z], c.tx, c.tz);
      item(() => {
        // island: kerbed concrete, yellow/black nose bollards
        set('concrete'); boxMM(F, -isl.L / 2, 0, -isl.w / 2, isl.L / 2, isl.h, isl.w / 2);
        set('walk'); quad(W(F, -isl.L / 2 + 0.2, isl.h + 0.005, -isl.w / 2 + 0.2), W(F, isl.L / 2 - 0.2, isl.h + 0.005, -isl.w / 2 + 0.2), W(F, isl.L / 2 - 0.2, isl.h + 0.005, isl.w / 2 - 0.2), W(F, -isl.L / 2 + 0.2, isl.h + 0.005, isl.w / 2 - 0.2), [0, 1, 0]);
        for (const e of [-1, 1]) for (const z of [-0.8, 0, 0.8]) { set('dr_prop', { c: srgb(0xf2b705) }); cyl(F, [e * (isl.L / 2 - 0.4), isl.h + 0.45, z], 'y', 0.1, 0.9, 8); set('dr_prop', { c: [0.02, 0.02, 0.02] }); cyl(F, [e * (isl.L / 2 - 0.4), isl.h + 0.6, z], 'y', 0.105, 0.15, 8, 0.105, false); }
        // end fences (white steel) on the noses
        set('dr_galv'); for (const e of [-1, 1]) { tube([W(F, e * (isl.L / 2 - 1.2), isl.h + 1.0, -isl.w / 2 + 0.15), W(F, e * (isl.L / 2 - 3.8), isl.h + 1.0, -isl.w / 2 + 0.15)], 0.03, 4); tube([W(F, e * (isl.L / 2 - 1.2), isl.h + 1.0, isl.w / 2 - 0.15), W(F, e * (isl.L / 2 - 3.8), isl.h + 1.0, isl.w / 2 - 0.15)], 0.03, 4);
          for (const x of [1.2, 2.5, 3.8]) for (const z of [-1, 1]) boxMM(F, e * (isl.L / 2 - x) - 0.03, isl.h, z * (isl.w / 2 - 0.15) - 0.03, e * (isl.L / 2 - x) + 0.03, isl.h + 1.0, z * (isl.w / 2 - 0.15) + 0.03); }
        // canopy: centre columns, a cantilevered roof (dark steel deck, glass skylight strip), LED edge lights
        set('dr_galv'); for (let x = -can.L / 2 + 1; x <= can.L / 2 - 1 + 1e-6; x += (can.L - 2) / 4) boxMM(F, x - 0.09, isl.h, -0.09, x + 0.09, can.y, 0.09);
        set('dr_steel'); for (const sd of [-1, 1]) boxMM(F, -can.L / 2, can.y, sd * (can.w / 2 - 0.18), can.L / 2, can.y + 0.16, sd * can.w / 2);   // edge beams
        boxMM(F, -can.L / 2, can.y + 0.16, -0.25, can.L / 2, can.y + 0.42, 0.25);                                         // spine beam
        for (let x = -can.L / 2; x <= can.L / 2 + 1e-6; x += can.L / 8) boxMM(F, x - 0.05, can.y, -can.w / 2, x + 0.05, can.y + 0.16, can.w / 2);   // ribs
        set('dr_glass'); for (const sd of [-1, 1]) boxMM(F, -can.L / 2, can.y + 0.07, sd > 0 ? 0.25 : -can.w / 2 + 0.18, can.L / 2, can.y + 0.09, sd > 0 ? can.w / 2 - 0.18 : -0.25);
        set('dr_glow', { em: NI([1.0, 0.96, 0.9], 650), col: false }); for (const sd of [-1, 1]) boxMM(F, -can.L / 2 + 0.3, can.y - 0.03, sd * (can.w / 2 - 0.2) - 0.04, can.L / 2 - 0.3, can.y, sd * (can.w / 2 - 0.2) + 0.04, ['py']);
        // spine: two lightbox ad panels (double-sided), glass windbreaks, benches, the stop's name post
        for (const x of [-can.L / 4, can.L / 4]) {
          set('dr_steel'); boxMM(F, x - 0.7, isl.h, -0.16, x + 0.7, isl.h + 2.15, 0.16);
          set('dr_glow', { em: NI([0.96, 0.95, 1.0], 160), col: false });
          for (const sd of [-1, 1]) quad(W(F, x - 0.62, isl.h + 0.3, sd * 0.165), W(F, x + 0.62, isl.h + 0.3, sd * 0.165), W(F, x + 0.62, isl.h + 2.07, sd * 0.165), W(F, x - 0.62, isl.h + 2.07, sd * 0.165), D(F, 0, 0, sd));
          for (const sd of [-1, 1]) emit({ id: `dress:busstop:ad${x > 0 ? 1 : 0}${sd > 0 ? 'r' : 'l'}`, kind: 'lightbox', pos: W(F, x, isl.h + 1.2, sd * 0.2), normal: D(F, 0, 0, sd), w: 1.24, h: 1.77, rgb: [0.95, 0.95, 1.0], nits: 160 });
        }
        set('dr_glass'); for (const x of [-can.L / 2 + 3, 0, can.L / 2 - 3]) boxMM(F, x - 1.1, isl.h + 0.1, -0.01, x + 1.1, isl.h + 2.1, 0.01);
        set('dr_galv'); for (const x of [-can.L / 2 + 6.2, can.L / 2 - 6.2]) for (const sd of [-1, 1]) boxMM(F, x - 1.0, isl.h + 0.4, sd * 0.25 - 0.18, x + 1.0, isl.h + 0.46, sd * 0.25 + 0.18);
        // LED bus-arrival boards hanging from the roof (amber text on black), both faces
        set('dr_steel'); boxMM(F, -0.7, can.y - 0.36, -0.08, 0.7, can.y - 0.02, 0.08);
        set('dr_glow', { em: NI(srgb(0xffa020), 60), col: false }); for (const sd of [-1, 1]) quad(W(F, -0.64, can.y - 0.32, sd * 0.081), W(F, 0.64, can.y - 0.32, sd * 0.081), W(F, 0.64, can.y - 0.06, sd * 0.081), W(F, -0.64, can.y - 0.06, sd * 0.081), D(F, 0, 0, sd));
        for (const sd of [-1, 1]) labels.push({ id: 'busstop:board' + sd, kind: 'led', pos: r3(W(F, 0, can.y - 0.19, sd * 0.084)), normal: r3(D(F, 0, 0, sd)), right: r3(D(F, sd, 0, 0)), w: 1.26, h: 0.24, nits: 220, lines: ['7016 곧 도착', '273  3분'] });
        // the stop's name panel on the canopy fascia, both ends
        for (const e of [-1, 1]) { set('dr_glow', { em: NI([0.1, 0.32, 0.75], 90), col: false }); quad(W(F, e * (can.L / 2 + 0.005), can.y + 0.02, -1.4), W(F, e * (can.L / 2 + 0.005), can.y + 0.02, 1.4), W(F, e * (can.L / 2 + 0.005), can.y + 0.4, 1.4), W(F, e * (can.L / 2 + 0.005), can.y + 0.4, -1.4), D(F, e, 0, 0));
          labels.push({ id: 'busstop:name' + e, kind: 'busname', pos: r3(W(F, e * (can.L / 2 + 0.01), can.y + 0.21, 0)), normal: r3(D(F, e, 0, 0)), right: r3(D(F, 0, 0, -e)), w: 2.8, h: 0.36, nits: 120, lines: ['홍대입구역', 'Hongik Univ. Stn.'] }); }
        emit({ id: 'dress:busstop:canopy', kind: 'store', pos: W(F, 0, can.y - 0.1, 0), normal: [0, -1, 0], w: can.w - 0.6, h: can.L - 1, rgb: [1.0, 0.96, 0.9], nits: 60, range: 12 });
        occRect(F, -isl.L / 2, isl.L / 2, -isl.w / 2, isl.w / 2);
        // the set piece: along the canopy's side over the platform, the bus lane beside it
        // 2.2 x 1.8 m, 0.5 m off the spine (ad panels 0.16), 0.5 m under the roof, half over the bus lane
        const mk = (sd) => ({ pre: { c: r3(W(F, -can.L / 2 - 0.5, 2.0, sd * 1.6)), n: r3(D(F, 1, 0, 0)), u: r3(D(F, 0, 0, 1)), w: 2.2, h: 1.8 }, gate: { c: r3(W(F, can.L / 2 + 0.5, 2.0, sd * 1.6)), n: r3(D(F, 1, 0, 0)), u: r3(D(F, 0, 0, 1)), w: 2.2, h: 1.8 } });
        setPieces.push({ id: 'bus-shelter', kind: 'shelter', name: 'BUS SHELTER', pos: r3([c.x, 0, c.z]), dir: r3(D(F, 1, 0, 0)), island: { L: isl.L, w: isl.w, h: isl.h }, canopy: can,
          medianGap: +c.gap.toFixed(2), gates: { left: mk(-1), right: mk(1) }, busStops: [r3([sa.x, 0, sa.z]), r3([sb.x, 0, sb.z])],
          note: 'thread the shelter under its 3.3 m roof, between the spine and the bus lane; G: stop buses beside the island and offset their lanes by half the island width along it' });
      }, { noGate: true });
    }
  }

  lap('shelter');
  // ---- 3. UNDER THE STAGE: the Red Road busking canopy on the walking street
  {
    const walks = M.streets.filter((s) => s.kind === 'walking');
    let best = null;
    const offOthers = (st, x, z) => M.streets.every((o) => o === st || M.project(o, x, z).dist > o.width / 2 + 9);   // not at a junction
    for (const st of walks) for (let s = 12; s < st.len - 12; s += 2) {
      const q = M.at(st, s), nx = -q.tz, nz = q.tx;
      if (!offOthers(st, q.x, q.z)) continue;
      const fl = M.freeRay(q.x, q.z, nx, nz, 25), fr = M.freeRay(q.x, q.z, -nx, -nz, 25);
      const span = Math.min(fl, 20) + Math.min(fr, 20);
      if (!isFinite(span)) continue;
      const score = span + (st.id === 's065' ? 2 : 0) - Math.abs(s - st.len / 2) * 0.02;
      if (!best || score > best.score) best = { st, s, q, fl, fr, score, nx, nz };
    }
    if (best) {
      const { q, fl, fr, nx, nz } = best, sd = fl >= fr ? 1 : -1, free = sd > 0 ? fl : fr;
      const dep = 5.6, len = 9.0, back = Math.min(free, 12) - 0.5;          // canopy against the building line on the wider side
      const cx = q.x + nx * sd * (back - dep / 2), cz = q.z + nz * sd * (back - dep / 2);
      const F = frameH([cx, 0, cz], q.tx, q.tz);                              // x along the street, z across (toward -sd = street centre)
      const zin = -sd * dep / 2, zback = sd * dep / 2;                        // street side, building side
      item(() => {
        // stage platform at the back, carpet-black deck with a front edge strip
        set('dr_prop', { c: [0.03, 0.03, 0.035] }); boxMM(F, -3.2, 0, zback - sd * 2.6, 3.2, 0.32, zback - sd * 0.15);
        set('dr_glow', { em: NI([1.0, 0.75, 0.45], 300), col: false }); boxMM(F, -3.2, 0.24, zback - sd * 2.61 - 0.01, 3.2, 0.27, zback - sd * 2.6 + 0.01);
        // truss columns + roof (white membrane deck, mono-pitch: 2.6 m clear at the street edge, 3.1 m at the back)
        set('dr_galv'); for (const z of [zin * 0.92, zback * 0.92]) for (const x of z === zin * 0.92 ? [-len / 2 + 0.2, len / 2 - 0.2] : [-len / 2 + 0.2, 0, len / 2 - 0.2]) { const yt = z === zin * 0.92 ? 2.6 : 3.1; boxMM(F, x - 0.1, 0, z - 0.1, x + 0.1, yt, z + 0.1); }   // the street edge is a 9 m truss: no middle post
        set('dr_steel'); for (const z of [zin * 0.92, zback * 0.92]) { const yt = z === zin * 0.92 ? 2.6 : 3.1; boxMM(F, -len / 2, yt, z - 0.12, len / 2, yt + 0.25, z + 0.12); }
        for (const x of [-len / 2 + 0.2, 0, len / 2 - 0.2]) { const a = W(F, x, 2.72, zin * 0.92), b = W(F, x, 3.22, zback * 0.92); tube([a, b], 0.06, 4); }
        set('white');
        { const a = W(F, -len / 2 - 0.2, 2.86, zin * 1.02), b = W(F, len / 2 + 0.2, 2.86, zin * 1.02), c = W(F, len / 2 + 0.2, 3.36, zback * 1.02), d = W(F, -len / 2 - 0.2, 3.36, zback * 1.02);
          const up = v3.norm(v3.cross(v3.sub(b, a), v3.sub(d, a))), nU = up[1] > 0 ? up : v3.mul(up, -1);
          quad(a, b, c, d, nU); quad(a, d, c, b, v3.mul(nU, -1));
          // a 6 cm thick edge so it is a closed solid for the collider
          set('white'); boxMM(F, -len / 2 - 0.2, 2.8, zin * 1.02 - 0.03, len / 2 + 0.2, 2.88, zin * 1.02 + 0.03); }
        // festoon bulbs along the street edge and the ridge (warm 2200 K point sources)
        set('dr_glow', { em: NI(srgb(0xffb46b), 1600), col: false });
        for (let x = -len / 2 + 0.3; x <= len / 2 - 0.2; x += 0.6) for (const [z, y] of [[zin * 0.95, 2.52 - 0.08 * Math.cos((x / len) * TAU * 1.5)], [0, 2.95 - 0.06 * Math.cos((x / len) * TAU * 1.5)]]) {
          const p = W(F, x, y, z); blob([p[0], p[1] - 0.06, p[2]], 0.05, 0.055, 0.05, R0, 0, 0.05); boxMM(FW, p[0] - 0.012, p[1] - 0.02, p[2] - 0.012, p[0] + 0.012, p[1] + 0.02, p[2] + 0.012); }
        set('dark'); for (const z of [zin * 0.95, 0]) { const pts = []; for (let x = -len / 2 + 0.3; x <= len / 2 - 0.2; x += 0.3) pts.push(W(F, x, (z === 0 ? 3.0 : 2.57) - 0.06 * Math.cos((x / len) * TAU * 1.5), z)); tube(pts, 0.006, 3); }
        // PA: two speaker stacks, an amp, a mic stand; a portable LED panel on a stand lighting the busker
        set('dr_prop', { c: [0.02, 0.02, 0.022] });
        for (const x of [-2.7, 2.7]) { boxMM(F, x - 0.28, 0.32, zback - sd * 2.3 - 0.2, x + 0.28, 1.15, zback - sd * 2.3 + 0.2); cyl(F, [x, 1.5, zback - sd * 2.3], 'y', 0.025, 0.7, 6); boxMM(F, x - 0.22, 1.85, zback - sd * 2.3 - 0.16, x + 0.22, 2.4, zback - sd * 2.3 + 0.16); }
        boxMM(F, 1.2, 0.32, zback - sd * 0.8 - 0.2, 1.8, 0.75, zback - sd * 0.8 + 0.2);
        set('dr_galv'); cyl(F, [0, 1.05, zback - sd * 2.2], 'y', 0.012, 1.45, 5);
        set('dr_steel'); cyl(F, [-1.9, 1.2, zback - sd * 0.6], 'y', 0.02, 1.7, 5);
        set('dr_glow', { em: NI([1.0, 0.92, 0.82], 1500), col: false }); boxMM(F, -2.15, 1.95, zback - sd * 0.6 - 0.04, -1.65, 2.25, zback - sd * 0.6 + 0.04);
        // back wall: dark panel with the busking-zone sign
        set('dr_steel'); boxMM(F, -3.4, 0, zback - 0.06, 3.4, 2.9, zback + 0.06);
        set('dr_glow', { em: NI([0.95, 0.35, 0.45], 140), col: false });
        quad(W(F, -1.6, 2.2, zback - sd * 0.065), W(F, 1.6, 2.2, zback - sd * 0.065), W(F, 1.6, 2.75, zback - sd * 0.065), W(F, -1.6, 2.75, zback - sd * 0.065), D(F, 0, 0, -sd));
        labels.push({ id: 'stage:sign', kind: 'stage', pos: r3(W(F, 0, 2.475, zback - sd * 0.07)), normal: r3(D(F, 0, 0, -sd)), right: r3(D(F, sd, 0, 0)), w: 3.2, h: 0.55, nits: 160, lines: ['걷고싶은거리 버스킹존', 'BUSKING ZONE · 홍대 레드로드'] });
        emit({ id: 'dress:stage:festoon', kind: 'neon', pos: W(F, 0, 2.5, zin * 0.95), normal: D(F, 0, 0, -sd), w: len, h: 0.15, rgb: [1.0, 0.62, 0.32], nits: 600, omni: 0.8, range: 14 });
        emit({ id: 'dress:stage:panel', kind: 'lightbox', pos: W(F, -1.9, 2.1, zback - sd * 0.65), normal: D(F, 0.4, -0.3, -sd), w: 0.5, h: 0.3, rgb: [1.0, 0.92, 0.82], nits: 1500, range: 10 });
        emit({ id: 'dress:stage:sign', kind: 'lightbox', pos: W(F, 0, 2.47, zback - sd * 0.08), normal: D(F, 0, 0, -sd), w: 3.2, h: 0.55, rgb: [0.95, 0.35, 0.45], nits: 140 });
        occRect(F, -len / 2, len / 2, -dep / 2, dep / 2);
        const yG = 1.4, gz = zin * (1.2 / (dep / 2));   // 0.5-2.3 m over the audience, 0.3 m under the 2.6 m edge, inside the festoon line
        setPieces.push({ id: 'under-the-stage', kind: 'stage', name: 'UNDER THE STAGE', street: best.st.id, pos: r3([cx, 0, cz]), dir: r3(D(F, 1, 0, 0)), roof: { low: 2.6, high: 3.1 },
          crowdRing: { c: r3(W(F, 0, 0, zin * 0.9)), r: 3.2 },
          gates: { pre: { c: r3(W(F, -len / 2 - 0.6, yG, gz)), n: r3(D(F, 1, 0, 0)), u: r3(D(F, 0, 0, 1)), w: 2.2, h: 1.8 }, gate: { c: r3(W(F, len / 2 + 0.6, yG, gz)), n: r3(D(F, 1, 0, 0)), u: r3(D(F, 0, 0, 1)), w: 2.2, h: 1.8 } },
          note: 'over the busking crowd (heads to 1.8 m) and under the canopy edge (2.6 m); G: a crowd ring at crowdRing' });
      }, { noGate: true });
    }
  }

  lap('stage');
  // ---- 4. CABLE THREAD: low service drops across Hongik-ro 3-gil (lowest points 4.0-4.6 m), and two windows to thread:
  // a low drop with a crossing line 2.85 m above it, the window fitted 0.3 m inside both (>= 2.2 x 1.8 m). Placed from the
  // layout alone (the first 84 m of the street from Wausan-ro 21-gil), clear of C's poles and cables (opts.poles / cables).
  {
    const st = M.streets.find((s) => s.ko === '홍익로3길') || M.streets.find((s) => /Hongik-ro 3-gil/.test(s.name || ''));
    if (st) {
      const s0 = 6, s1 = Math.min(st.len - 6, 84);
      const R = rng('thread' + seed); const drops = [], windows = [];
      const cat = (d, n = 12) => { const pts = []; for (let i = 0; i <= n; i++) { const t = i / n; pts.push([lerp(d.a[0], d.b[0], t), lerp(d.a[1], d.b[1], t) - 4 * d.sag * t * (1 - t), lerp(d.a[2], d.b[2], t)]); } return pts; };
      const others = [...(opts.cables || []).filter((c) => c.pts?.length > 1).map((c) => ({ pts: c.pts, r: c.r ?? 0.03 })), ...cables];
      const pole = (x, z, r) => (opts.poles || []).some((p) => Math.hypot(p.x - x, p.z - z) < r);
      // distance from a point to any polyline already standing (C's and E's cables)
      const cabD = (p) => { let d = Infinity; for (const c of others) for (let i = 0; i + 1 < c.pts.length; i++) { const A2 = c.pts[i], B2 = c.pts[i + 1]; if (Math.abs(A2[0] - p[0]) > 8 && Math.abs(B2[0] - p[0]) > 8) continue;
        const vx = B2[0] - A2[0], vy = B2[1] - A2[1], vz = B2[2] - A2[2], l2 = vx * vx + vy * vy + vz * vz || 1e-9, t = clamp(((p[0] - A2[0]) * vx + (p[1] - A2[1]) * vy + (p[2] - A2[2]) * vz) / l2, 0, 1);
        d = Math.min(d, Math.hypot(p[0] - A2[0] - vx * t, p[1] - A2[1] - vy * t, p[2] - A2[2] - vz * t) - c.r); } return d; };
      let k = 0, lastWin = -1e9;
      for (let s = s0 + 5 + R() * 2; s < s1 - 4; s += 5 + R() * 4, k++) {
        const q = M.at(st, s), nx = -q.tz, nz = q.tx;
        const dl = M.freeRay(q.x, q.z, nx, nz, 9), dr = M.freeRay(q.x, q.z, -nx, -nz, 9);
        if (!isFinite(dl) || !isFinite(dr)) continue;
        const wantWin = windows.length < 2 && k >= 1 && (!windows.length || s - lastWin >= 15) && dl + dr > 3.4 && !pole(q.x, q.z, 2.5);
        const skew = wantWin ? 0 : (R() - 0.5) * 2.4;
        const a = [q.x + nx * (dl - 0.06) - q.tx * skew / 2, 4.75 + R() * 0.55, q.z + nz * (dl - 0.06) - q.tz * skew / 2];
        const b = [q.x - nx * (dr - 0.06) + q.tx * skew / 2, 4.7 + R() * 0.55, q.z - nz * (dr - 0.06) + q.tz * skew / 2];
        const low = wantWin ? 4.0 + R() * 0.15 : 4.0 + R() * 0.6, sag = Math.max(0.15, (a[1] + b[1]) / 2 - low);
        const d0 = { a, b, sag, r: 0.011 + R() * 0.012, pair: !wantWin && R() < 0.5 };
        if (wantWin) {
          // the crossing line above: lowest point 2.85 m over the drop's; the window between them, 0.3 m clear of both
          const up = 2.85, d1 = { a: [a[0], low + up + 0.35, a[2]], b: [b[0], low + up + 0.35, b[2]], sag: 0.3, r: 0.02, pair: false };
          const P0 = cat(d0, 40), P1 = cat(d1, 40), uC = (dl - dr) / 2, w = Math.min(2.6, dl + dr - 1.4);
          const yAt = (P, u) => { let best = null; for (const p of P) { const uu = (p[0] - q.x) * nx + (p[2] - q.z) * nz; if (!best || Math.abs(uu - u) < Math.abs(best[0] - u)) best = [uu, p[1]]; } return best[1]; };
          let lo = -Infinity, hi = Infinity; for (let j = 0; j <= 8; j++) { const u = uC + (j / 8 - 0.5) * w; lo = Math.max(lo, yAt(P0, u) + d0.r); hi = Math.min(hi, yAt(P1, u) - d1.r); }
          const gb = lo + 0.33, gt = hi - 0.33, G = { c: r3([q.x + nx * uC, (gb + gt) / 2, q.z + nz * uC]), n: r3([q.tx, 0, q.tz]), u: r3([nx, 0, nz]), w: +w.toFixed(2), h: +(gt - gb).toFixed(2) };
          // the window's samples must stay 0.35 m off every other cable already up (C's spans and drops)
          let okC = G.w >= 2.2 && G.h >= 1.8;
          if (okC) for (let i = 0; i <= 6 && okC; i++) for (let j = 0; j <= 4; j++) { const p = [G.c[0] + nx * (i / 6 - 0.5) * G.w, G.c[1] + (j / 4 - 0.5) * G.h, G.c[2] + nz * (i / 6 - 0.5) * G.w]; if (cabD(p) < 0.35) { okC = false; break; } }
          if (okC) { drops.push(d0, d1); windows.push(G); lastWin = s; continue; }
        }
        drops.push(d0);
      }
      set('dark');
      for (const d of drops) {
        const pts = cat(d, 10);
        if (!polyGateOK(pts, 0.35)) { facts.rejectedByGates++; continue; }
        tube(pts, d.r, 4); cables.push({ pts: pts.map(r3), r: d.r });
        if (d.pair) { const p2 = pts.map((p) => [p[0], p[1] - 0.07, p[2]]); tube(p2, d.r * 0.8, 3); cables.push({ pts: p2.map(r3), r: d.r * 0.8 }); }
        for (const e of [d.a, d.b]) boxMM(FW, e[0] - 0.05, e[1] - 0.06, e[2] - 0.05, e[0] + 0.05, e[1] + 0.06, e[2] + 0.05);   // wall brackets
        facts.drops++;
      }
      setPieces.push({ id: 'cable-thread', kind: 'cables', name: 'CABLE THREAD', street: st.id, s: [+s0.toFixed(1), +s1.toFixed(1)], drops: drops.length, low: [4.0, 4.6], gates: { windows },
        note: 'low drops across Hongik-ro 3-gil; windows = a low drop with a crossing line 2.85 m above it, the gate 0.33 m inside both (>= 2.2 x 1.8)' });
    }
  }
  lap('thread');
  // ---- 5. ROOFLINE: a 3.5 m slot between a rooftop stair house and a water tank, on the longest run of similar roofs
  // parallel to lines.json's ROOFLINE (which flies over the walking street at 23.8 m): F1 re-cuts the line along this run.
  {
    // the search axis: phase 1's ROOFLINE, fixed off the walking-street hero (layout only, so lines.mjs and runtime agree)
    let a = null, b = null;
    const hw = (layout.hero || []).find((x) => x.id === 'walking-street');
    if (hw) { a = [hw.pos[0] - 13.58, 0, hw.pos[2] + 45.45]; b = [hw.pos[0] + 7.27, 0, hw.pos[2] - 19.03]; }
    if (a && b) {
      const dx = b[0] - a[0], dz = b[2] - a[2], L = Math.hypot(dx, dz), tx = dx / L, tz = dz / L, nx = -tz, nz = tx;
      const roofItems = [];
      if (opts.lotInfo) for (const info of opts.lotInfo.values ? opts.lotInfo.values() : Object.values(opts.lotInfo)) for (const r of info.roof || []) roofItems.push(r);
      // runs of roofs: lines parallel to the path, offset -45..45 m; a run tolerates gaps <= 3 m and height steps <= 3.5 m
      const runs = [];
      for (let o = -45; o <= 45; o += 1.5) {
        let cur = null, gap = 0;
        for (let s = -30; s <= L + 30; s += 1) {
          const x = a[0] + tx * s + nx * o, z = a[2] + tz * s + nz * o, l = M.lotAt(x, z), H = l ? l.floors * l.floorH : 0;
          if (l && l.floors >= 3 && l.floors <= 7 && (!cur || Math.abs(H - cur.h0) <= 3.5)) { if (!cur) cur = { o, s0: s, s1: s, h0: H, lots: new Set() }; cur.s1 = s; cur.lots.add(l); gap = 0; }
          else if (cur && ++gap > 3) { runs.push(cur); cur = null; gap = 0; }
        }
        if (cur) runs.push(cur);
      }
      runs.sort((p, q) => (q.s1 - q.s0) - (p.s1 - p.s0) || Math.abs(p.o) - Math.abs(q.o));
      let c = null;
      for (const run of runs.slice(0, 12)) {
        const mid = (run.s0 + run.s1) / 2, cands = [];
        for (let s = run.s0 + 6; s <= run.s1 - 6; s += 0.5) {
          const x = a[0] + tx * s + nx * run.o, z = a[2] + tz * s + nz * run.o, l = M.lotAt(x, z); if (!l) continue;
          const H = l.floors * l.floorH, half = 1.8;
          const sh = [x + nx * (half + 1.25), z + nz * (half + 1.25)], tk = [x - nx * (half + 0.95), z - nz * (half + 0.95)];
          const inside = (px, pz, r) => pip(px, pz, l.footprint) && polyD(px, pz, l.footprint) > r;
          if (!inside(sh[0], sh[1], 1.9) || !inside(tk[0], tk[1], 1.5) || !inside(x, z, 0.5)) continue;
          if (roofItems.some((r) => Math.hypot(r.x - sh[0], r.z - sh[1]) < 3.0 || Math.hypot(r.x - tk[0], r.z - tk[1]) < 2.5 || segD(r.x, r.z, x - tx * 9, z - tz * 9, x + tx * 5, z + tz * 5) < 2.6)) continue;
          // the pre-gate: 7 m back along the run on the same roof, 2 m inside its parapets
          const px = x - tx * 7, pz = z - tz * 7;
          if (!inside(px, pz, 2.0) || !inside(x - tx * 3.5, z - tz * 3.5, 1.9)) continue;
          cands.push({ s, x, z, l, H, sh, tk, run, px, pz, score: -Math.abs(s - mid) });
        }
        cands.sort((p, q) => q.score - p.score);
        if (cands[0]) { c = cands[0]; break; }
      }
      if (opts.debug) console.log('roofline', { runs: runs.length, best: runs[0] && [runs[0].o, runs[0].s0, runs[0].s1, runs[0].h0], slot: c && [c.x.toFixed(1), c.z.toFixed(1), c.H] });
      if (c) item(() => {
        const H = c.H, F1 = frameH([c.sh[0], H, c.sh[1]], tx, tz), F2 = frameH([c.tk[0], H, c.tk[1]], tx, tz);
        set(c.l.floors > 6 ? 'concrete' : 'plaster'); boxMM(F1, -1.6, 0, -1.25, 1.6, 2.7, 1.25);
        set('concrete'); boxMM(F1, -1.75, 2.7, -1.4, 1.75, 2.82, 1.4);
        set('dr_steel'); boxMM(F1, -0.5, 0, -1.27, 0.45, 2.1, -1.25);       // the door, facing the slot
        set('dr_glow', { em: NI([1.0, 0.82, 0.6], 900), col: false }); boxMM(F1, -0.12, 2.25, -1.33, 0.12, 2.38, -1.25);   // bulb over the door
        emit({ id: 'dress:roofline:door', kind: 'store', pos: W(F1, 0, 2.3, -1.35), normal: D(F1, 0, -0.3, -1), w: 0.25, h: 0.15, rgb: [1.0, 0.82, 0.6], nits: 900, range: 7 });
        set('metal'); boxMM(F2, -1.0, 0, -1.0, 1.0, 0.5, 1.0);
        set('white'); cyl(F2, [0, 1.45, 0], 'y', 0.95, 1.9, 12);
        set('dr_galv'); tube([W(F2, 0.95, 0.6, 0), W(F2, 1.4, 0.6, 0), W(F2, 1.4, 0.05, 0)], 0.03, 4);
        const run = c.run;
        const gate = { c: r3([c.x, H + 1.5, c.z]), n: r3([tx, 0, tz]), u: r3([nx, 0, nz]), w: 2.9, h: 1.8 };
        const pre = { c: r3([c.px, H + 1.5, c.pz]), n: r3([tx, 0, tz]), u: r3([nx, 0, nz]), w: 2.9, h: 1.8 };
        setPieces.push({ id: 'roofline-slot', kind: 'roof', name: 'ROOFLINE', lot: c.l.id, pos: r3([c.x, H, c.z]), roof: +H.toFixed(2), dir: r3([tx, 0, tz]), run: { offset: run.o, length: run.s1 - run.s0, lots: run.lots.size },
          gates: { pre, gate }, note: 'a 3.6 m slot between a stair house (2.8 m) and a water tank (2.4 m); pre-gate 7 m back on the same roof, 0.6-2.4 m over it' });
      }, { noGate: true });
    }
  }

  lap('roofline');
  // ---- 6. lit rear doors behind every gap (ux #4): 20-40 nits on a side wall of the slot, past the gate (both sides if two-way)
  for (const g of gates) {
    if (g.sp || g.pre || g.w > 2.2 || g.h < 3 || Math.abs(g.n[1]) > 0.5) continue;
    const R = rng('door' + g.name + g.c[0]);
    for (const sgn of g.two ? [1, -1] : [1]) {
      const along = sgn * (1.6 + R() * 1.4), wall = (sgn > 0 ? 1 : -1) * (R() < 0.5 ? 1 : -1);
      const px = g.c[0] + g.n[0] * along, pz = g.c[2] + g.n[2] * along;
      const d = M.freeRay(px, pz, g.u[0] * wall, g.u[2] * wall, 3, 0.05);
      if (!isFinite(d)) continue;
      const wx = px + g.u[0] * wall * (d - 0.06), wz = pz + g.u[2] * wall * (d - 0.06);       // just off the wall
      const out = [-g.u[0] * wall, 0, -g.u[2] * wall];
      const F = frameH([wx, 0, wz], g.n[0], g.n[2]);
      const nits = 25 + R() * 12, rgb = R() < 0.6 ? [1.0, 0.8, 0.58] : [0.9, 0.96, 1.0];
      item(() => {
        const zo = D(F, 0, 0, 1)[0] * out[0] + D(F, 0, 0, 1)[2] * out[2] > 0 ? 1 : -1;
        set('dr_glow', { em: NI(rgb, nits), col: false }); quad(W(F, -0.45, 0.02, 0.012 * zo), W(F, 0.45, 0.02, 0.012 * zo), W(F, 0.45, 2.1, 0.012 * zo), W(F, -0.45, 2.1, 0.012 * zo), out, uvDef,
          [NI(rgb, nits * 1.25), NI(rgb, nits * 1.25), NI(rgb, nits * 0.75), NI(rgb, nits * 0.75)]);
        set('dr_steel', { col: false }); for (const x of [-0.5, 0.5]) boxMM(F, x - 0.04, 0, -0.03 + 0.02 * zo, x + 0.04, 2.16, 0.03 + 0.02 * zo); boxMM(F, -0.54, 2.12, -0.03 + 0.02 * zo, 0.54, 2.2, 0.03 + 0.02 * zo);
        set('dr_glow', { em: NI([1.0, 0.85, 0.65], 700), col: false }); boxMM(F, -0.07, 2.32, -0.04 + 0.03 * zo, 0.07, 2.42, 0.04 + 0.03 * zo);
        emit({ id: `dress:door:${g.name}:${sgn}`, kind: 'store', pos: W(F, 0, 1.1, 0.05 * zo), normal: out, w: 0.9, h: 2.1, rgb, nits: Math.round(nits), range: 8 });
        facts.doors++;
      }, { noGate: true });
    }
  }

  lap('doors');
  // ================================================================================================ STREETSCAPE
  // ---- crossings: zebra paint, stop lines and signal heads at seoul-life's crossings (+ THE CROSSING at the station)
  {
    let net = null; try { net = typeof LIFE.buildNetwork === 'function' ? LIFE.buildNetwork(layout) : null; } catch (e) { net = null; }
    const list = (net?.crossings || []).map((c) => ({ x: c.x, z: c.z, cw: c.cw || 5, half: c.halfSpan, st: M.byId.get(c.main.id), kind: c.kind, axis: c.axis, offset: c.offset, ow: c.main.ow || 0, carHalf: c.main.carHalf ?? c.main.width / 2, id: c.id }));
    const cr = { c: [stationX[0], 0, stationX[1]] };
    if (cr) {   // THE CROSSING: zebras over both Yanghwa-ro carriageways at the station (static: walk red)
      for (const st of yanghwa) { const p = M.project(st, cr.c[0], cr.c[2]); if (p.dist < st.width / 2 + 12 && !list.some((c) => Math.hypot(c.x - p.px, c.z - p.pz) < 14)) list.push({ x: p.px, z: p.pz, cw: 6, half: st.width / 2 + 0.6, st, kind: 'S', ow: 1, carHalf: st.width / 2, id: 'S' + st.id, offset: 0, axis: 0 }); }
    }
    for (const c of list) {
      if (!c.st) continue;
      const p = M.project(c.st, c.x, c.z), tx = p.tx, tz = p.tz, F = frameH([c.x, 0, c.z], tx, tz);
      facts.crossings++;
      // zebra: bars parallel to the road, 0.45 m wide / 0.45 m gaps, across the carriageway
      set('dr_roadpaint', { c: [0.62, 0.62, 0.6] });
      for (let z = -c.half + 0.3; z <= c.half - 0.3; z += 0.9) decal([W(F, -c.cw / 2, 0, z), W(F, c.cw / 2, 0, z), W(F, c.cw / 2, 0, z + 0.45), W(F, -c.cw / 2, 0, z + 0.45)].map((q) => [q[0], q[2]]), 0.026);
      // stop lines 3 m ahead of the crosswalk on each approach (right-hand traffic)
      const dirs = c.ow ? [c.ow] : [1, -1];
      for (const d of dirs) { const x = -d * (c.cw / 2 + 3), z0 = c.ow ? -c.carHalf + 0.2 : 0, z1 = c.ow ? c.carHalf - 0.2 : d * (c.carHalf - 0.2);
        decal([W(F, x - 0.2, 0, Math.min(z0, z1)), W(F, x + 0.2, 0, Math.min(z0, z1)), W(F, x + 0.2, 0, Math.max(z0, z1)), W(F, x - 0.2, 0, Math.max(z0, z1))].map((q) => [q[0], q[2]]), 0.026); }
      // signal heads: pedestrian heads on both kerbs, car heads on mast arms past the crosswalk, facing the approach
      const phase = { kind: c.kind === 'S' ? 'S' : c.kind, offset: c.offset, axis: c.axis };
      for (const sd of [-1, 1]) {
        const z = sd * (c.half + 0.7), base = W(F, c.cw / 2 + 0.4, 0, z);
        if (!M.lotClear(base[0], base[2], 0.4) || M.ribbonD(base[0], base[2], true) < 0.2) continue;
        item(() => {
          set('dr_galv'); cyl(F, [c.cw / 2 + 0.4, 1.6, z], 'y', 0.07, 3.2, 8);
          set('dr_steel'); boxMM(F, c.cw / 2 + 0.25, 2.2, z - sd * 0.12 - 0.17, c.cw / 2 + 0.55, 2.95, z - sd * 0.12 + 0.17);
          const n = D(F, 0, 0, -sd), fx = z - sd * 0.12 - sd * 0.175;
          lamps.push({ id: c.id + ':p' + sd, role: 'walkR', pos: r3(W(F, c.cw / 2 + 0.4, 2.76, fx)), normal: r3(n), r: 0.11, phase });
          lamps.push({ id: c.id + ':p' + sd, role: 'walkG', pos: r3(W(F, c.cw / 2 + 0.4, 2.42, fx)), normal: r3(n), r: 0.11, phase });
          facts.signals++;
        }, { margin: 0.3 });
      }
      for (const d of dirs) {
        const sideZ = d * (c.carHalf + 0.8);     // the approach's right-hand kerb (local z = right of the street direction)
        const x = d * (c.cw / 2 + 1.2), base = W(F, x, 0, sideZ);
        if (!M.lotClear(base[0], base[2], 0.4) || M.ribbonD(base[0], base[2], true) < 0.1) continue;
        const arm = Math.min(c.carHalf * 0.85, 6.5), zEnd = sideZ - Math.sign(sideZ) * arm;
        item(() => {
          set('dr_galv'); cyl(F, [x, 2.9, sideZ], 'y', 0.12, 5.8, 8);
          tube([W(F, x, 5.5, sideZ), W(F, x, 5.55, zEnd)], 0.07, 6);
          set('dr_steel'); boxMM(F, x - d * 0.12 - 0.12, 5.1, zEnd - 0.62, x - d * 0.12 + 0.12, 5.42, zEnd + 0.62);
          const n = D(F, -d, 0, 0), fx = x - d * 0.12 - d * 0.125;
          ['carR', 'carA', 'carL', 'carG'].forEach((role, i) => lamps.push({ id: c.id + ':c' + d, role, pos: r3(W(F, fx, 5.26, zEnd + (i - 1.5) * 0.3 * d)), normal: r3(n), r: 0.12, phase }));   // red, amber, left arrow, green from the driver's left
          facts.signals++;
        }, { margin: 0.3 });
      }
      occAdd(c.x, c.z, 0); for (const sd of [-1, 1]) { const q = W(F, 0, 0, sd * (c.half + 1)); occAdd(q[0], q[2], 3.2); }
    }
  }

  lap('crossings');
  // ---- trees: ginkgos on the main roads' pavements (Nov: half gold), tree pits with grates
  {
    const R = rng('trees' + seed);
    for (const st of mainStreets) {
      if (st.width < 9) continue;
      for (const sd of [-1, 1]) {
        let s = 4 + R() * 4;
        for (; s < st.len - 3; s += 8.5 + R() * 2) {
          const q = M.at(st, s), nx = -q.tz * sd, nz = q.tx * sd, off = st.width / 2 + 1.05;
          const x = q.x + nx * off, z = q.z + nz * off;
          if (!inCore(x, z) || M.ribbonD(x, z) < 0.8 || !M.lotClear(x, z, 1.7) || !occFree(x, z, 1.2)) continue;
          // pavement must be >= 3 m deep here (else no trees: Seoul plants only where the walk is wide enough)
          if (M.freeRay(x, z, nx, nz, 3.2) < 2.2) continue;
          item(() => {
            const H = 7.5 + R() * 3.5, F = frameH([x, 0, z], q.tx, q.tz), lean = (R() - 0.5) * 0.25;
            set('dr_steel'); boxMM(F, -0.62, 0, -0.62, 0.62, 0.02, 0.62, ['ny']);                 // grate
            set('dr_bark'); cyl(F, [0, H * 0.32, 0], 'y', 0.14, H * 0.64, 7, 0.08);
            tube([[x, H * 0.4, z], [x + nx * 0.9 + lean, H * 0.62, z + nz * 0.9], [x + nx * 1.2, H * 0.78, z + nz * 1.2]], 0.05, 3);
            tube([[x, H * 0.45, z], [x - nx * 0.8, H * 0.68, z - nz * 0.8 + lean]], 0.045, 3);
            // conical-columnar crown of clumps; colour: gold to yellow-green, a few nearly bare
            const bare = R() < 0.15, nC = bare ? 4 : 7;
            for (let k = 0; k < nC; k++) {
              const t = k / nC, y = lerp(3.2, H - 0.6, t + R() * 0.08), rr = lerp(1.7, 0.7, t) * (bare ? 0.6 : 1) * (0.8 + R() * 0.4), a = R() * TAU, off2 = rr * 0.45;
              const g = R(); set('dr_leaf', { c: bare ? [0.12, 0.1, 0.06] : g < 0.55 ? [0.62, 0.46, 0.05] : g < 0.85 ? [0.5, 0.42, 0.07] : [0.28, 0.32, 0.08] });
              blob([x + Math.cos(a) * off2, y, z + Math.sin(a) * off2], rr, rr * 0.8, rr, R, 0, 0.25);
            }
            occAdd(x, z, 1.1); facts.trees++;
          }, { margin: 0.4 });
        }
      }
    }
  }

  lap('trees');
  // ---- road-name plates (도로명판) at every pre-gate (design #4): lit navy plate, white hangul, facing the approach
  {
    const done = [];
    for (const g of gates) {
      if (g.sp || !g.pre || Math.abs(g.n[1]) > 0.5 || g.c[1] > 14) continue;
      if (done.some((p) => Math.hypot(p[0] - g.c[0], p[1] - g.c[2]) < 4)) continue;
      const st = M.streets.map((s) => ({ s, p: M.project(s, g.c[0], g.c[2]) })).sort((a, b) => a.p.dist - b.p.dist)[0];
      if (!st || st.p.dist > 12) continue;
      done.push([g.c[0], g.c[2]]);
      const s = st.s, isRoad = s.kind === 'main', pw = isRoad ? 1.1 : 0.85, ph = isRoad ? 0.3 : 0.24;
      const facing = v3.mul(g.n, -1);                 // toward the pilot approaching the pre-gate
      // a wall bracket on the nearer facade, above the gate (or a kerb pole on a main road), just past the pre-gate plane
      let placed = false;
      for (const side of [1, -1]) {
        if (placed) break;
        const ux = g.u[0] * side, uz = g.u[2] * side, d = M.freeRay(g.c[0], g.c[2], ux, uz, isRoad ? 25 : 9, 0.05);
        if (!isFinite(d)) continue;
        const wx = g.c[0] + ux * (d - 0.02) + g.n[0] * 0.8, wz = g.c[2] + uz * (d - 0.02) + g.n[2] * 0.8;
        const y = isRoad ? 3.4 : clamp(g.c[1] + g.h / 2 + 0.55, 3.3, 6.5), outD = 0.12 + pw / 2;
        const cx = wx - ux * outD, cz = wz - uz * outD;
        const F = frameH([cx, y, cz], ux, uz);       // local x = toward the wall (u side), z = right of that
        const nz = D(F, 0, 0, 1), sgnF = v3.dot(nz, facing) >= 0 ? 1 : -1;
        placed = item(() => {
          set('dr_steel'); boxMM(F, -pw / 2, -0.03, -0.05, pw / 2 + 0.12, 0.03, 0.05);                                   // bracket arm
          set('dr_steel'); boxMM(F, -pw / 2 - 0.02, -ph / 2 - 0.02, -0.03, pw / 2 + 0.02, ph / 2 + 0.02, 0.03);           // plate body
          set('dr_glow', { em: NI(srgb(0x1b3f8f), 90), col: false });
          for (const f of [1, -1]) quad(W(F, -pw / 2, -ph / 2, f * 0.031), W(F, pw / 2, -ph / 2, f * 0.031), W(F, pw / 2, ph / 2, f * 0.031), W(F, -pw / 2, ph / 2, f * 0.031), D(F, 0, 0, f));
          const fz = sgnF;
          labels.push({ id: 'plate:' + g.name + ':' + done.length, kind: 'plate', pos: r3(W(F, 0, 0, fz * 0.034)), normal: r3(D(F, 0, 0, fz)), right: r3(D(F, -fz, 0, 0)), w: pw, h: ph, nits: 160,
            lines: [s.ko || s.name, s.name || ''], range: '1→' + Math.max(2, Math.round(s.len / 10) * 2) });
          labels.push({ id: 'plate:' + g.name + ':' + done.length + 'b', kind: 'plate', pos: r3(W(F, 0, 0, -fz * 0.034)), normal: r3(D(F, 0, 0, -fz)), right: r3(D(F, fz, 0, 0)), w: pw, h: ph, nits: 160,
            lines: [s.ko || s.name, s.name || ''], range: Math.max(2, Math.round(s.len / 10) * 2) + '←1' });
          emit({ id: `dress:plate:${g.name}:${done.length}`, kind: 'lightbox', pos: W(F, 0, 0, 0.04 * fz), normal: D(F, 0, 0, fz), w: pw, h: ph, rgb: srgb(0x1b3f8f).map((v) => v / 0.15), nits: 90, range: 6 });
          facts.plates++;
        }, { margin: 0.3 });
      }
    }
  }

  lap('plates');
  // ---- pojangmacha tents (color #2: SOURCE_TYPES.tent): orange tarp lit from inside, clear vinyl front, on wide pavements
  // Kerbside rows on Hongik-ro / Wausan-ro pavements (the late-night pocha strip) and single tents at pocha lots. Frame:
  // local x along the kerb (or facade), local +z = away from it (customers come from +z; the vinyl front faces +z).
  {
    const R = rng('pocha' + seed), spots = [];
    let tentId = 0;
    for (const l of M.lots.filter((l) => l.use === 'pocha' || (l.use === 'bar' && hash(l.id + 'pt') < 0.2))) {
      const [fa, fb] = l.frontage, L = Math.hypot(fb[0] - fa[0], fb[1] - fa[1]); if (L < 3.5) continue;
      const tx = (fb[0] - fa[0]) / L, tz = (fb[1] - fa[1]) / L, mx = (fa[0] + fb[0]) / 2, mz = (fa[1] + fb[1]) / 2;
      let nx = tz, nz = -tx; if (pip(mx + nx * 0.3, mz + nz * 0.3, l.footprint)) { nx = -nx; nz = -nz; }
      spots.push({ x: mx + nx * 0.25, z: mz + nz * 0.25, tx, tz, nx, nz, row: 1, facade: true });
    }
    for (const st of mainStreets.filter((s) => s.ko === '홍익로' || s.ko === '와우산로')) for (let s = 8; s < st.len - 8; s += 17) {
      const q = M.at(st, s);
      for (const sd of [1, -1]) { const nx = -q.tz * sd, nz = q.tx * sd, off = st.width / 2 + 0.3; spots.push({ x: q.x + nx * off, z: q.z + nz * off, tx: q.tx, tz: q.tz, nx, nz, row: 2 + (R() < 0.3 ? 1 : 0) }); }
    }
    // pocha lots first, then the rows in a seeded order
    const lotSpots = spots.filter((sp) => sp.facade), rowSpots = spots.filter((sp) => !sp.facade).map((sp) => [R(), sp]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    let n = 0;
    for (const sp of [...lotSpots, ...rowSpots]) {
      if (n >= 12) break;
      const depth = 2.5, wTent = 3.0, rowN = sp.row;
      const F = frameH([sp.x + sp.nx * depth / 2, 0, sp.z + sp.nz * depth / 2], sp.nz, -sp.nx);   // frameH's local z = (-dz, dx) = n
      const half = wTent * rowN / 2 + 0.15;
      const okRect = rectFree(F, -half, half, -depth / 2 - 0.05, depth / 2 + 1.5, (x, z) => M.lotClear(x, z, 0.1) && occFree(x, z, 0.3) && M.ribbonD(x, z, true) > 0.15 && inCore(x, z));
      // on an alley a facade tent must leave >= 2.2 m to the far side
      const okAlley = !sp.facade || M.freeRay(sp.x + sp.nx * (depth + 0.1), sp.z + sp.nz * (depth + 0.1), sp.nx, sp.nz, 3) >= 2.2;
      if (!okRect || !okAlley || gates.some((g) => Math.hypot(g.c[0] - sp.x, g.c[2] - sp.z) < 6)) continue;
      let placedAny = false;
      for (let k = 0; k < rowN; k++) {
        const xo = (k - (rowN - 1) / 2) * (wTent + 0.1), id = tentId++;
        if (item(() => tent(F, xo, wTent, depth, R, id), { margin: 0.35 })) { n++; facts.tents++; placedAny = true; }
      }
      if (placedAny) occRect(F, -half, half, -depth / 2, depth / 2);
    }
  }
  // ---- street-food carts (노점) along the walking street edges: steel cart, tarp canopy, bare bulbs, lit menu band
  {
    const R = rng('carts' + seed); let n = 0;
    const menus = ['떡볶이 · 순대', '호떡', '어묵 · 꼬치', '타코야끼', '닭꼬치', '와플 · 츄러스', '군고구마', '계란빵'];
    for (const st of M.streets.filter((x) => x.kind === 'walking')) for (let s = 6 + R() * 6; s < st.len - 6 && n < 12; s += 14 + R() * 10) {
      const q = M.at(st, s), sd = R() < 0.5 ? 1 : -1, nx = -q.tz * sd, nz = q.tx * sd;
      const d = M.freeRay(q.x, q.z, nx, nz, 12); if (!isFinite(d) || d < 3.2) continue;
      const off = d - 1.0, x = q.x + nx * off, z = q.z + nz * off;           // backed against the shop side, 1 m off the facades
      if (!inCore(x, z) || !occFree(x, z, 1.3) || gates.some((g) => Math.hypot(g.c[0] - x, g.c[2] - z) < 5)) continue;
      const F = frameH([x, 0, z], -nz, nx);                                  // local +z = -n: the counter faces the street
      const tarp = [srgb(0xc8261e), srgb(0x1f5fbf), srgb(0xe8a417), srgb(0x2a8a4a)][Math.floor(R() * 4)], id = n;
      if (item(() => {
        set('dr_galv'); boxMM(F, -0.8, 0.25, -0.45, 0.8, 0.95, 0.45); set('dr_prop', { c: [0.02, 0.02, 0.02] }); for (const xx of [-0.55, 0.55]) cyl(F, [xx, 0.2, 0], 'z', 0.2, 0.92, 6);
        set('dr_steel'); for (const xx of [-0.78, 0.78]) for (const zz of [-0.43, 0.43]) boxMM(F, xx - 0.02, 0.95, zz - 0.02, xx + 0.02, 2.05, zz + 0.02, ['ny']);
        set('dr_tarp', { c: tarp.map((v) => v * 0.6), em: NI([1.0, 0.62, 0.3], 75) }); boxMM(F, -0.95, 2.05, -0.6, 0.95, 2.12, 0.62);
        boxMM(F, -0.95, 1.85, 0.6, 0.95, 2.12, 0.62);                           // valance over the counter
        set('dr_glow', { em: NI(srgb(0xffb46b), 1500), col: false }); for (const xx of [-0.45, 0.1, 0.55]) boxMM(F, xx - 0.03, 1.88, 0.15 - 0.03, xx + 0.03, 1.95, 0.15 + 0.03);
        set('dr_glow', { em: NI([1.0, 0.7, 0.4], 160), col: false }); boxMM(F, -0.7, 0.55, 0.451, 0.7, 0.85, 0.455);   // lit counter front (menu)
        labels.push({ id: 'cart:' + id, kind: 'tent', pos: r3(W(F, 0, 1.985, 0.625)), normal: r3(D(F, 0, 0, 1)), w: 1.8, h: 0.24, nits: 70, lines: [menus[id % menus.length]] });
        emit({ id: 'dress:cart:' + id, kind: 'tent', pos: W(F, 0, 1.6, 0.4), normal: D(F, 0, 0, 1), w: 1.6, h: 1.1, rgb: [1.0, 0.62, 0.3], nits: 110 });
      }, { margin: 0.35 })) { occAdd(x, z, 1.2); n++; facts.carts = n; }
    }
  }
  // tent: frame F (x along the kerb, +z away from it, toward the customers), tarp box with a ridge, the vinyl front (+z) lit
  function tent(F, xo, w, d, R, idx) {
    const eave = 2.15, ridge = 2.7, hz = d / 2, hx = w / 2 - 0.05;
    const tarp = [srgb(0xe8541c), srgb(0xd9401a), srgb(0xf06a1f), srgb(0xc93a2a)][idx % 4];
    const glow = (k) => NI([1.0, 0.56, 0.24], k);
    // walls: lit tarp (translucent: the lamp inside shows through), the front (road side) and the side facing the walk are clear vinyl
    set('dr_tarp', { c: tarp.map((v) => v * 0.6), em: glow(70) });
    boxMM(F, xo - hx, 0.02, -hz, xo + hx, eave, -hz + 0.02);                      // back (kerb / facade side)
    for (const s of [-1, 1]) boxMM(F, xo + s * hx - 0.01, 0.02, -hz, xo + s * hx + 0.01, eave, hz);
    set('dr_tarp', { c: [0.2, 0.2, 0.2], em: glow(115) });
    boxMM(F, xo - hx, 0.35, hz - 0.02, xo + hx, eave - 0.25, hz);                // vinyl front, lit interior behind it
    set('dr_tarp', { c: tarp.map((v) => v * 0.6), em: glow(60) });
    boxMM(F, xo - hx, eave - 0.25, hz - 0.02, xo + hx, eave, hz);
    // roof: two pitches to the ridge
    for (const s of [-1, 1]) { const a = W(F, xo - hx - 0.08, eave + 0.02, s * (hz + 0.1)), b = W(F, xo + hx + 0.08, eave + 0.02, s * (hz + 0.1)), c = W(F, xo + hx + 0.08, ridge, 0), dd = W(F, xo - hx - 0.08, ridge, 0);
      const nU = v3.norm(v3.cross(v3.sub(b, a), v3.sub(dd, a))), up = nU[1] > 0 ? nU : v3.mul(nU, -1);
      set('dr_tarp', { c: tarp.map((v) => v * 0.7), em: glow(45) }); quad(a, b, c, dd, up); quad(a, dd, c, b, v3.mul(up, -1)); }
    for (const s of [-1, 1]) { const p0 = W(F, xo + s * (hx + 0.08), eave + 0.02, -hz - 0.1), p1 = W(F, xo + s * (hx + 0.08), eave + 0.02, hz + 0.1), p2 = W(F, xo + s * (hx + 0.08), ridge, 0); set('dr_tarp', { c: tarp.map((v) => v * 0.6), em: glow(55) }); tri(p0, p1, p2); tri(p0, p2, p1); }
    // tarp lettering band on the front (runtime label)
    labels.push({ id: 'tent:' + idx + ':' + xo, kind: 'tent', pos: r3(W(F, xo, eave - 0.125, hz + 0.004)), normal: r3(D(F, 0, 0, 1)), right: r3(D(F, 1, 0, 0)), w: 2 * hx - 0.2, h: 0.23, nits: 60,
      lines: [['포장마차', '닭발 · 오뎅', '소주 · 맥주', '꼼장어', '실내포차'][idx % 5]] });
    // stools and a table just outside, a crate of empties
    set('dr_prop', { c: srgb(0x2f6fd6) }); boxMM(F, xo - 0.7, 0, hz + 0.3, xo - 0.4, 0.43, hz + 0.6);
    set('dr_prop', { c: srgb(0xd23a2a) }); boxMM(F, xo + 0.5, 0, hz + 0.25, xo + 0.8, 0.43, hz + 0.55);
    set('dr_prop', { c: srgb(0x1f7a3a) }); boxMM(F, xo + 1.0, 0, -hz + 0.1, xo + 1.45, 0.3, -hz + 0.42);
    emit({ id: 'dress:tent:' + idx, kind: 'tent', pos: W(F, xo, 1.25, hz), normal: D(F, 0, 0, 1), w: 2 * hx, h: 1.6, rgb: [1.0, 0.56, 0.24], nits: 120 });
  }

  lap('tents');
  // ---- paint: 천천히 ("slowly") across alleys where they leave a road, manholes, gutter grates
  const GLYPH = {
    '천': [[0.25, 0.92, 0.42, 0.98], [0.08, 0.8, 0.56, 0.87], ['q', [0.27, 0.8], [0.37, 0.8], [0.14, 0.46], [0.04, 0.46]], ['q', [0.29, 0.73], [0.38, 0.73], [0.6, 0.49], [0.5, 0.49]], [0.72, 0.38, 0.83, 1.0], [0.57, 0.64, 0.72, 0.72], [0.14, 0.05, 0.25, 0.33], [0.14, 0.05, 0.9, 0.13]],
    '히': [[0.22, 0.92, 0.4, 0.98], [0.06, 0.8, 0.56, 0.87], ['o', [0.31, 0.47], 0.17, 0.075], [0.72, 0.06, 0.83, 1.0]],
  };
  function paintText(txt, cx, cz, tx, tz, cellW = 0.85, cellL = 2.1, y = 0.026) {
    const rx = -tz, rz = tx, n = [...txt].length, total = n * cellW + (n - 1) * 0.1;
    const P = (k, u, v) => { const x0 = -total / 2 + k * (cellW + 0.1) + u * cellW, along = (v - 0.5) * cellL; return [cx + rx * x0 + tx * along, cz + rz * x0 + tz * along]; };
    [...txt].forEach((ch, k) => { for (const s of GLYPH[ch] || []) {
      if (typeof s[0] === 'number') decal([P(k, s[0], s[1]), P(k, s[2], s[1]), P(k, s[2], s[3]), P(k, s[0], s[3])], y);
      else if (s[0] === 'q') decal([P(k, ...s[1]), P(k, ...s[2]), P(k, ...s[3]), P(k, ...s[4])], y);
      else if (s[0] === 'o') { const [c, r, t] = [s[1], s[2], s[3]]; for (let i = 0; i < 12; i++) { const a0 = (i / 12) * TAU, a1 = ((i + 1) / 12) * TAU; decal([P(k, c[0] + Math.cos(a0) * r, c[1] + Math.sin(a0) * r * 0.75), P(k, c[0] + Math.cos(a1) * r, c[1] + Math.sin(a1) * r * 0.75), P(k, c[0] + Math.cos(a1) * (r - t), c[1] + Math.sin(a1) * (r - t) * 0.75), P(k, c[0] + Math.cos(a0) * (r - t), c[1] + Math.sin(a0) * (r - t) * 0.75)], y); } }
    } });
  }
  {
    set('dr_roadpaint', { c: [0.6, 0.6, 0.58] });
    for (const st of M.streets) {
      if (st.kind === 'main' || st.kind === 'walking' || st.len < 25) continue;
      for (const end of [0, 1]) {
        const s = end ? st.len - 9 : 9, q = M.at(st, s); if (!q || !inCore(q.x, q.z)) continue;
        const nearMain = mainStreets.some((m) => M.project(m, ...(end ? [st.segs[st.segs.length - 1].bx, st.segs[st.segs.length - 1].bz] : [st.segs[0].ax, st.segs[0].az])).dist < m.width / 2 + 4);
        if (!nearMain && hash(st.id + end) > 0.35) continue;
        const dir = end ? -1 : 1;                   // read by a driver entering the alley from the road
        paintText('천천히', q.x, q.z, q.tx * dir, q.tz * dir, Math.min(0.85, st.width / 4.2), Math.min(2.1, st.width * 0.55));
      }
    }
    // manhole covers (cast iron) and gutter grates
    const R = rng('manhole' + seed);
    for (const st of M.streets) for (let s = 6 + R() * 10; s < st.len - 4; s += 22 + R() * 18) {
      const q = M.at(st, s), off = (R() - 0.5) * st.width * 0.5, x = q.x - q.tz * off, z = q.z + q.tx * off; if (!inCore(x, z)) continue;
      set('dr_roadpaint', { c: [0.05, 0.05, 0.05] }); const pts = []; for (let i = 0; i < 10; i++) pts.push([x + Math.cos((i / 10) * TAU) * 0.33, z + Math.sin((i / 10) * TAU) * 0.33]); decal(pts, 0.025);
      if (st.kind !== 'main') { const sd = R() < 0.5 ? 1 : -1, gx = q.x - q.tz * sd * (st.width / 2 - 0.25), gz = q.z + q.tx * sd * (st.width / 2 - 0.25);
        set('dr_roadpaint', { c: [0.03, 0.03, 0.03] }); decal([[gx - q.tx * 0.45 - q.tz * 0.15, gz - q.tz * 0.45 + q.tx * 0.15], [gx + q.tx * 0.45 - q.tz * 0.15, gz + q.tz * 0.45 + q.tx * 0.15], [gx + q.tx * 0.45 + q.tz * 0.15, gz + q.tz * 0.45 - q.tx * 0.15], [gx - q.tx * 0.45 + q.tz * 0.15, gz - q.tz * 0.45 - q.tx * 0.15]], 0.025); }
    }
  }

  lap('paint');
  // ================================================================================================ CLUTTER (art #4)
  // facade analysis: each lot's frontage edge, its outward normal and what is in front of it
  const fronts = [];
  for (const l of M.lots) {
    const [fa, fb] = l.frontage, dx = fb[0] - fa[0], dz = fb[1] - fa[1], L = Math.hypot(dx, dz); if (L < 2) continue;
    const tx = dx / L, tz = dz / L; let nx = tz, nz = -tx;
    const mx = (fa[0] + fb[0]) / 2, mz = (fa[1] + fb[1]) / 2;
    if (pip(mx + nx * 0.3, mz + nz * 0.3, l.footprint)) { nx = -nx; nz = -nz; }
    const st = M.byId.get(l.street);
    const free = M.freeRay(mx + nx * 0.05, mz + nz * 0.05, nx, nz, 30);
    fronts.push({ l, fa, fb, L, tx, tz, nx, nz, mx, mz, st, free, info: opts.lotInfo?.get ? opts.lotInfo.get(l.id) : null });
  }
  lap('fronts');
  // ---- awnings on ~40 % of shopfronts (retractable fabric, 2.5-2.9 m, under the fascia)
  {
    const R = rng('awn' + seed);
    const cols = [srgb(0x1d4d2b), srgb(0x7a1a1a), srgb(0x1b2a4a), srgb(0x3a3a3a), srgb(0xb06a1a), srgb(0x5a2a4a), srgb(0xd8d2c0)];
    for (const f of fronts) {
      if (f.info?.shutter || R() > 0.4 || f.L < 3 || !inCore(f.mx, f.mz)) continue;
      const depth = clamp(Math.min(1.3, (isFinite(f.free) ? f.free : 6) * 0.3), 0.7, 1.3), w = Math.min(f.L - 1.0, 3 + R() * 4);
      const s0 = 0.5 + R() * Math.max(0, f.L - 1 - w);
      const F = frameH([f.fa[0] + f.tx * (s0 + w / 2), 0, f.fa[1] + f.tz * (s0 + w / 2)], f.tx, f.tz);
      const zs = v3.dot(D(F, 0, 0, 1), [f.nx, 0, f.nz]) > 0 ? 1 : -1;
      const yTop = Math.min(shopTop - 0.08, fasciaY - 0.12), yLow = yTop - 0.35 - depth * 0.15, c = cols[Math.floor(R() * cols.length)];
      item(() => {
        set('dr_prop', { c });
        const a = W(F, -w / 2, yTop, zs * 0.03), b = W(F, w / 2, yTop, zs * 0.03), cc = W(F, w / 2, yLow, zs * depth), d = W(F, -w / 2, yLow, zs * depth);
        const n = v3.norm(v3.cross(v3.sub(b, a), v3.sub(d, a))), up = n[1] > 0 ? n : v3.mul(n, -1);
        quad(a, b, cc, d, up); quad(a, d, cc, b, v3.mul(up, -1));
        // valance + the roller box at the wall, side arms
        boxMM(F, -w / 2, yLow - 0.22, zs * depth - 0.015, w / 2, yLow, zs * depth + 0.015);
        set('dr_galv'); boxMM(F, -w / 2, yTop - 0.06, zs * 0.03 - 0.07, w / 2, yTop + 0.08, zs * 0.03 + 0.07);
        for (const sx of [-1, 1]) tube([W(F, sx * (w / 2 - 0.05), yTop - 0.7, zs * 0.04), W(F, sx * (w / 2 - 0.05), yLow - 0.02, zs * (depth - 0.05))], 0.02, 4);
        facts.awnings++;
      }, { margin: 0.35 });
    }
  }
  lap('awnings');
  // ---- B1 basement stairs (pits along the facade, club/bar/karaoke) and steel stairs up to 2F on open side walls
  {
    const R = rng('b1' + seed);
    for (const f of fronts) {
      if (!/club|bar|karaoke|pocha|restaurant|cafe/.test(f.l.use) || f.L < 6.5 || !inCore(f.mx, f.mz)) continue;
      if (M.ribbonD(f.mx + f.nx * 2.3, f.mz + f.nz * 2.3) < 0.1) continue;               // no pavement for a pit here
      if (R() > (f.l.use === 'club' ? 0.85 : f.l.use === 'bar' || f.l.use === 'karaoke' ? 0.55 : 0.2)) continue;
      // the pit runs along the facade at one end; it needs 1.75 m of pavement off any ribbon plus 1.2 m to walk past
      const end = R() < 0.5 ? 0 : 1, wP = 1.3, run = 15 * 0.28 + 1.3, dir = end ? -1 : 1;
      const sx = end ? f.L - 0.5 : 0.5;
      const ox = f.fa[0] + f.tx * sx + f.nx * (0.25 + 0.15 + wP / 2), oz = f.fa[1] + f.tz * sx + f.nz * (0.25 + 0.15 + wP / 2);
      const F = frameH([ox, 0, oz], f.tx * dir, f.tz * dir);
      const ok = rectFree(F, -0.4, run + 0.4, -wP / 2 - 0.3, wP / 2 + 0.3, (x, z) => M.ribbonD(x, z) > 0.15 && occFree(x, z, 0.2) && !M.lotAt(x, z))
        && rectFree(F, 0, run, -wP / 2 - 1.5, wP / 2 + 1.5, (x, z) => !M.lotAt(x, z) || M.lotAt(x, z) === f.l);
      if (!ok) continue;
      const glow = { club: [0.75, 0.3, 1.0], bar: [1.0, 0.55, 0.28], karaoke: [0.85, 0.4, 1.0], pocha: [1.0, 0.6, 0.3], restaurant: [1.0, 0.75, 0.5], cafe: [1.0, 0.8, 0.6] }[f.l.use];
      item(() => {
        const st = stairwell([ox, oz], [f.tx * dir, f.tz * dir], { W: wP, rise: 0.18, tread: 0.28, n1: 15, land: 1.3, hole: run, wallT: 0.15, parapet: 0.05, slab: 0.3, wallMat: 'concrete', tubeNits: 500, lightRGB: glow, endGlow: { rgb: glow, nits: 70 } });
        // railing around the open sides (not the facade side, not the head)
        set('dr_steel');
        const zr = (wP / 2 + 0.08) * (v3.dot(D(st.F, 0, 0, 1), [f.nx, 0, f.nz]) > 0 ? 1 : -1);
        tube([W(st.F, 0.05, 1.0, zr), W(st.F, run, 1.0, zr), W(st.F, run, 1.0, -zr)], 0.025, 4);
        for (let x = 0.05; x <= run + 1e-6; x += run / 4) boxMM(st.F, x - 0.02, 0.0, zr - 0.02, x + 0.02, 1.0, zr + 0.02);
        boxMM(st.F, run - 0.02, 0.0, -zr - 0.02, run + 0.02, 1.0, -zr + 0.02);
        // door at the bottom (the end wall's glow is the open door) + a sign light over the pit head
        emit({ id: 'dress:b1:' + f.l.id, kind: 'store', pos: W(st.F, st.xL - 0.3, st.y1 + 1.2, 0), normal: [0, 1, 0], w: wP, h: 1.2, rgb: glow, nits: 80, range: 6 });
        occRect(st.F, -0.3, run, -wP / 2, wP / 2, 0.2); facts.b1++;
      }, { margin: 0.35 });
    }
    // steel stairs to 2F on an exposed side wall (corner lots): a straight flight along the wall, landing at the 2F door
    for (const l of M.lots) {
      if (l.floors < 3 || R() > 0.22 || !inCore(l._bb[0], l._bb[2])) continue;
      const P = l.footprint, area = Math.abs(polyArea(P)); if (area < 80) continue;
      const ccw = polyArea(P) > 0;
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz); if (L < 7) continue;
        if (Math.hypot(a[0] - l.frontage[0][0], a[1] - l.frontage[0][1]) < 0.05 && Math.hypot(b[0] - l.frontage[1][0], b[1] - l.frontage[1][1]) < 0.05) continue;
        const tx = dx / L, tz = dz / L; let nx = tz, nz = -tx; if (pip((a[0] + b[0]) / 2 + nx * 0.3, (a[1] + b[1]) / 2 + nz * 0.3, P)) { nx = -nx; nz = -nz; }
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        if (M.freeRay(mx + nx * 0.05, mz + nz * 0.05, nx, nz, 4) < 3.0) continue;           // needs an open side (>= 3 m)
        const fh = l.floorH, nS = Math.round(fh / 0.19), rise = fh / nS, tread = 0.26, run = nS * tread, wS = 1.0;
        if (run + 1.6 > L - 0.6) continue;
        const ox = a[0] + tx * 0.4 + nx * (wS / 2 + 0.05), oz = a[1] + tz * 0.4 + nz * (wS / 2 + 0.05), F = frameH([ox, 0, oz], tx, tz);
        const zw = v3.dot(D(F, 0, 0, 1), [nx, 0, nz]) > 0 ? -1 : 1;    // the wall's side in local z
        if (!rectFree(F, 0, run + 1.4, -wS / 2, wS / 2, (x, z) => M.ribbonD(x, z) > 0.2 && occFree(x, z, 0.2) && !M.lotAt(x, z))) continue;
        item(() => {
          set('dr_steel');
          for (const zz of [-wS / 2 + 0.03, wS / 2 - 0.03]) tube([W(F, 0, 0, zz), W(F, run, fh, zz)], 0.05, 4);          // stringers
          for (let k = 0; k < nS; k++) boxMM(F, k * tread, (k + 1) * rise - 0.03, -wS / 2 + 0.05, (k + 1) * tread, (k + 1) * rise, wS / 2 - 0.05, null);
          boxMM(F, run, fh - 0.08, -wS / 2, run + 1.3, fh, wS / 2);                                                          // landing
          for (const x of [run, run + 1.3]) boxMM(F, x - 0.04, 0, -zw * (wS / 2 - 0.04) - 0.04, x + 0.04, fh, -zw * (wS / 2 - 0.04) + 0.04);
          tube([W(F, 0, 0.95, -zw * wS / 2), W(F, run, fh + 0.95, -zw * wS / 2), W(F, run + 1.3, fh + 0.95, -zw * wS / 2), W(F, run + 1.3, fh + 0.95, zw * wS / 2)], 0.022, 4);
          // the 2F door glow + a bulb
          set('dr_glow', { em: NI([1.0, 0.8, 0.55], 30), col: false }); const zz = zw * (wS / 2 + 0.04);
          quad(W(F, run + 0.2, fh + 0.02, zz), W(F, run + 1.1, fh + 0.02, zz), W(F, run + 1.1, fh + 2.1, zz), W(F, run + 0.2, fh + 2.1, zz), D(F, 0, 0, -zw));
          set('dr_glow', { em: NI([1.0, 0.82, 0.6], 800), col: false }); boxMM(F, run + 0.6, fh + 2.35, zz - zw * 0.1 - 0.05, run + 0.7, fh + 2.45, zz - zw * 0.1 + 0.05);
          emit({ id: 'dress:2f:' + l.id, kind: 'store', pos: W(F, run + 0.65, fh + 1.1, zz - zw * 0.06), normal: D(F, 0, 0, -zw), w: 0.9, h: 2.1, rgb: [1.0, 0.8, 0.55], nits: 30, range: 7 });
          occRect(F, 0, run + 1.3, -wS / 2, wS / 2); facts.stairs2f++;
        }, { margin: 0.35 });
        break;
      }
    }
  }
  lap('stairs');
  // ---- kerbside kit: scooters (clusters at restaurants / bars, ~2 per 10 m of alley), stools + crates, trash bags, cones, cabinets
  const scooter = (F, R) => {
    const body = [srgb(0x111111), srgb(0xe8e8e4), srgb(0xb3241f), srgb(0x5c6066), srgb(0x1d3f7a), srgb(0x2b2b2b)][Math.floor(R() * 6)];
    set('dr_prop', { c: [0.02, 0.02, 0.02] });
    const nb = ['ny'];
    for (const x of [-0.62, 0.64]) cyl(F, [x, 0.27, 0], 'z', 0.27, 0.11, 6);
    set('dr_prop', { c: body });
    boxMM(F, -0.78, 0.28, -0.2, 0.3, 0.6, 0.2, nb); boxMM(F, 0.28, 0.32, -0.21, 0.46, 1.0, 0.21, nb);
    set('dr_prop', { c: [0.03, 0.03, 0.03] }); boxMM(F, -0.68, 0.6, -0.17, -0.06, 0.78, 0.17, nb); boxMM(F, 0.42, 1.0, -0.34, 0.5, 1.05, 0.34); boxMM(F, 0.52, 0.3, -0.03, 0.6, 1.0, 0.03, ['ny', 'py']);
    if (R() < 0.6) { set('dr_prop', { c: [srgb(0xe8e8e4), srgb(0xc8261e), srgb(0xf2b705), srgb(0x161616)][Math.floor(R() * 4)] }); boxMM(F, -1.0, 0.78, -0.24, -0.52, 1.24, 0.24); }
    facts.scooters++;
  };
  {
    const R = rng('kit' + seed);
    for (const f of fronts) {
      if (!f.st || !inCore(f.mx, f.mz)) continue;
      const alley = f.st.kind !== 'main', busy = /restaurant|bar|pocha|cafe|club|conv/.test(f.l.use);
      // scooters: a cluster of 1-4 parked at the frontage, nose to the wall (alleys) or kerbside (main roads)
      const nClusters = alley ? Math.round((f.L / 10 * (busy ? 0.8 : 0.35)) * dens + R() * 0.5) : (busy && R() < 0.3 * dens ? 1 : 0);
      for (let k = 0; k < nClusters; k++) {
        const n = 1 + Math.floor(R() * (busy ? 3.5 : 2)), sAt = 0.8 + R() * Math.max(0.1, f.L - 1.6 - n * 0.75);
        for (let j = 0; j < n; j++) {
          const s = sAt + j * 0.75; if (s > f.L - 0.5) break;
          const perp = alley || R() < 0.5, off = alley ? 1.15 : (isFinite(f.free) ? Math.max(1.0, Math.min(f.free - 1.3, f.free * 0.8)) : 1.2);
          const x = f.fa[0] + f.tx * s + f.nx * off, z = f.fa[1] + f.tz * s + f.nz * off;
          if (!occFree(x, z, 0.38) || M.ribbonD(x, z, true) < 0.4 || !M.lotClear(x, z, 0.35) || M.lotAt(x + f.nx, z + f.nz)) continue;
          const yaw = perp ? [f.nx * (alley ? -1 : 1), f.nz * (alley ? -1 : 1)] : [f.tx, f.tz];
          const jit = (R() - 0.5) * 0.4, c = Math.cos(jit), sn = Math.sin(jit);
          const F = frameH([x, 0, z], yaw[0] * c - yaw[1] * sn, yaw[0] * sn + yaw[1] * c);
          if (item(() => scooter(F, R), { margin: 0.3 })) occAdd(x, z, 0.45);
        }
      }
      // stools / crates / bottle crates at busy frontages
      if (busy && R() < 0.45 * dens) {
        const s = 0.6 + R() * (f.L - 1.2), x = f.fa[0] + f.tx * s + f.nx * 0.45, z = f.fa[1] + f.tz * s + f.nz * 0.45;
        if (occFree(x, z, 0.4) && M.ribbonD(x, z, true) > 0.3) item(() => {
          const F = frameH([x, 0, z], f.tx, f.tz), n = 1 + Math.floor(R() * 3);
          for (let i = 0; i < n; i++) { const kind = R(), xo = (i - (n - 1) / 2) * 0.5;
            if (kind < 0.45) { set('dr_prop', { c: [srgb(0x1f7a3a), srgb(0x6b3d1d), srgb(0xd8a017)][Math.floor(R() * 3)] }); const h = 1 + Math.floor(R() * 4); for (let k = 0; k < h; k++) boxMM(F, xo - 0.22, k * 0.3, -0.16, xo + 0.22, k * 0.3 + 0.29, 0.16); }
            else { set('dr_prop', { c: [srgb(0xd23a2a), srgb(0x2f6fd6), srgb(0x2a9a5a)][Math.floor(R() * 3)] }); const h = 1 + Math.floor(R() * 5); for (let k = 0; k < h; k++) boxMM(F, xo - 0.15 + k * 0.004, k * 0.075, -0.15, xo + 0.15 + k * 0.004, k * 0.075 + 0.43, 0.15, k ? ['ny'] : null); } }
        }, { margin: 0.3 }) && occAdd(x, z, 0.6);
      }
      // trash bags + flattened boxes at ~1 in 4 frontages (pick-up piles at the kerb or the wall)
      if (R() < (alley ? 0.28 : 0.12) * dens) {
        const s = R() * f.L, off = alley ? 0.35 : (isFinite(f.free) ? Math.max(0.4, f.free - 0.6) : 0.4), x = f.fa[0] + f.tx * s + f.nx * off, z = f.fa[1] + f.tz * s + f.nz * off;
        if (occFree(x, z, 0.5) && M.ribbonD(x, z, true) > 0.3 && M.lotClear(x, z, 0.2)) item(() => { trashPile(x, z, R); }, { margin: 0.3 }) && occAdd(x, z, 0.6);
      }
    }
    // trash piles at C's poles (the bags go out at the pole), cable coils and telecom boxes on the poles
    for (const p of opts.poles || []) {
      if (!inCore(p.x, p.z)) continue;
      const Rp = rng('pole' + p.x.toFixed(1) + p.z.toFixed(1));
      if (Rp() < 0.45) item(() => trashPile(p.x + (Rp() - 0.5) * 0.4, p.z + (Rp() - 0.5) * 0.4, Rp, 0.3), { margin: 0.3 });
      if (Rp() < 0.55) item(() => { const y = 4.6 + Rp() * 2.2, r = 0.28 + Rp() * 0.2, a0 = Rp() * TAU, pts = []; for (let i = 0; i <= 14; i++) { const a = (i / 14) * TAU; pts.push([p.x + Math.cos(a0) * (0.22 + r * (1 + Math.cos(a)) * 0.5), y + Math.sin(a) * r, p.z + Math.sin(a0) * (0.22 + r * (1 + Math.cos(a)) * 0.5)]); }
        set('dark'); tube(pts, 0.025, 3); }, { margin: 0.3 });
      if (Rp() < 0.35) item(() => { set('dr_prop', { c: [0.32, 0.33, 0.33] }); const F = frameH([p.x, 0, p.z], p.tx || 1, p.tz || 0); boxMM(F, -0.2, 3.9, 0.2, 0.2, 4.5, 0.42); }, { margin: 0.3 });
    }
    // main-road pavements: electrical cabinets, cones, a few bollards at walking-street mouths
    for (const st of mainStreets) for (let s = 15 + R() * 20; s < st.len - 10; s += 40 + R() * 40) for (const sd of [-1, 1]) {
      const q = M.at(st, s), nx = -q.tz * sd, nz = q.tx * sd, off = st.width / 2 + 0.55 + R() * 0.3, x = q.x + nx * off, z = q.z + nz * off;
      if (!inCore(x, z) || !occFree(x, z, 0.8) || M.ribbonD(x, z) < 0.3 || !M.lotClear(x, z, 1.2)) continue;
      item(() => { const F = frameH([x, 0, z], q.tx, q.tz); if (R() < 0.6) { set('dr_prop', { c: srgb(0x6f7a6c) }); boxMM(F, -0.55, 0, -0.25, 0.55, 1.35, 0.25); set('dr_prop', { c: [0.05, 0.05, 0.05] }); boxMM(F, -0.6, 1.35, -0.3, 0.6, 1.4, 0.3); }
        else { for (let i = 0; i < 2 + Math.floor(R() * 3); i++) { set('dr_prop', { c: srgb(0xf05a1a) }); const F2 = frameH([x + q.tx * i * 0.7, 0, z + q.tz * i * 0.7], 1, 0); boxMM(F2, -0.2, 0, -0.2, 0.2, 0.04, 0.2); cyl(F2, [0, 0.38, 0], 'y', 0.13, 0.68, 8, 0.03); } }
        occAdd(x, z, 0.8); }, { margin: 0.3 });
    }
    for (const st of M.streets.filter((s) => s.kind === 'walking')) for (const end of [0, 1]) {
      const p = end ? [st.segs[st.segs.length - 1].bx, st.segs[st.segs.length - 1].bz] : [st.segs[0].ax, st.segs[0].az];
      const m = mainStreets.find((mm) => M.project(mm, p[0], p[1]).dist < mm.width / 2 + 6); if (!m) continue;
      const q = M.at(st, end ? st.len - 3.5 : 3.5); if (!inCore(q.x, q.z)) continue;
      for (let k = -2; k <= 2; k++) { const x = q.x - q.tz * k * 1.6, z = q.z + q.tx * k * 1.6; if (M.ribbonD(x, z, true) < 0.4 || !M.lotClear(x, z, 0.6)) continue;
        item(() => { set('concrete'); cyl(FW, [x, 0.4, z], 'y', 0.18, 0.8, 10, 0.16); set('dr_prop', { c: srgb(0xf2b705) }); cyl(FW, [x, 0.66, z], 'y', 0.165, 0.06, 10, 0.165, false); }, { margin: 0.3 }); }
    }
  }
  function trashPile(x, z, R, spread = 0.45) {
    const n = 3 + Math.floor(R() * 6);
    for (let i = 0; i < n; i++) {
      const a = R() * TAU, d = R() * spread, r = 0.2 + R() * 0.14, g = R();
      set('dr_prop', { c: g < 0.6 ? [0.62, 0.62, 0.6] : g < 0.8 ? [0.66, 0.5, 0.52] : g < 0.92 ? [0.7, 0.55, 0.18] : [0.08, 0.08, 0.08] });
      blob([x + Math.cos(a) * d, r * 0.85 + (i > 4 ? 0.3 : 0), z + Math.sin(a) * d], r, r * 0.85, r * 1.1, R, 0, 0.22);
    }
    if (R() < 0.5) { set('dr_prop', { c: [0.36, 0.25, 0.14] }); const F = frameH([x + 0.35, 0, z + 0.2], R() - 0.5, R() - 0.5); for (let k = 0; k < 2 + Math.floor(R() * 3); k++) boxMM(F, -0.35, k * 0.06, -0.28, 0.35, k * 0.06 + 0.055, 0.28); }
  }

  lap('kit');
  // ================================================================================================ CABLES (art #4)
  // C's spans carry 3-6 lines; real Hongdae spans carry 8-16 (power, telecom bundles, coax). Add 5-10 per span between
  // consecutive poles of a street, and a service drop to every facade on the alleys.
  if (opts.poles?.length) {
    const byStreet = new Map();
    for (const p of opts.poles) { if (!byStreet.has(p.street)) byStreet.set(p.street, []); byStreet.get(p.street).push(p); }
    const cat = (a, b, sag, n) => { const pts = []; for (let i = 0; i <= n; i++) { const t = i / n; pts.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t) - 4 * sag * t * (1 - t), lerp(a[2], b[2], t)]); } return pts; };
    set('dark');
    for (const [sid, ps] of byStreet) {
      for (let i = 0; i + 1 < ps.length; i++) {
        const p = ps[i], q = ps[i + 1], L = Math.hypot(q.x - p.x, q.z - p.z); if (L > 45 || L < 4) continue;
        const R = rng('span' + sid + i), nAdd = 4 + Math.floor(R() * 5), n = Math.max(4, Math.ceil(L / 3.5));
        for (let k = 0; k < nAdd; k++) {
          const tel = k >= 2, ya = (tel ? 4.6 + R() * 1.6 : p.h - 0.5 - R() * 1.4), yb = (tel ? 4.6 + R() * 1.6 : q.h - 0.5 - R() * 1.4);
          const sag = (tel ? 0.035 : 0.025) + R() * 0.035, r = tel ? (R() < 0.3 ? 0.035 : 0.012 + R() * 0.012) : 0.016;
          const ox = (R() - 0.5) * 0.35, oz = (R() - 0.5) * 0.35;
          const pts = cat([p.x + ox, ya, p.z + oz], [q.x + ox, yb, q.z + oz], sag * L, n);
          if (!polyGateOK(pts, 0.35)) { facts.rejectedByGates++; continue; }
          tube(pts, r, 3); cables.push({ pts: pts.map(r3), r }); facts.cablesExtra++;
          if (tel && R() < 0.35) { const p2 = pts.map((v, j) => [v[0], v[1] - 0.05 - 0.02 * Math.sin(j), v[2] + 0.03]); tube(p2, r * 0.7, 3); cables.push({ pts: p2.map(r3), r: r * 0.7 }); }
        }
      }
    }
    // service drops: from the nearest pole within 28 m to each alley facade (1-2 per lot), into the wall at 3.6-6 m
    for (const f of fronts) {
      if (!f.st || f.st.kind === 'main' || !inCore(f.mx, f.mz)) continue;
      const R = rng('drop' + f.l.id);
      let best = null; for (const p of byStreet.get(f.st.id) || opts.poles) { const d = Math.hypot(p.x - f.mx, p.z - f.mz); if (d < 28 && (!best || d < best.d)) best = { p, d }; }
      if (!best) continue;
      const nD = 1 + (R() < 0.5 ? 1 : 0);
      for (let k = 0; k < nD; k++) {
        const s = 0.6 + R() * (f.L - 1.2), wx = f.fa[0] + f.tx * s + f.nx * 0.05, wz = f.fa[1] + f.tz * s + f.nz * 0.05, wy = Math.min(f.l.floors * f.l.floorH - 0.6, 3.7 + R() * 2.4);
        const a = [best.p.x, best.p.h - 1.2 - R() * 2.2, best.p.z], b = [wx, wy, wz], L = Math.hypot(b[0] - a[0], b[2] - a[2]); if (L < 1.5) continue;
        const pts = cat(a, b, (0.03 + R() * 0.04) * L, Math.max(3, Math.ceil(L / 3)));
        if (!polyGateOK(pts, 0.35)) { facts.rejectedByGates++; continue; }
        tube(pts, 0.009 + R() * 0.006, 3); cables.push({ pts: pts.map(r3), r: 0.012 }); facts.drops++;
        set('dr_prop', { c: [0.3, 0.3, 0.3] }); boxMM(FW, wx - 0.08, wy - 0.12, wz - 0.08, wx + 0.08, wy + 0.08, wz + 0.08); set('dark');
      }
    }
  }

  lap('cables');
  // ================================================================================================ output
  const merged = {}; let tris = 0;
  for (const [k, a] of Object.entries(acc)) { const g = a.geometry(); if (g) { merged[k] = g; tris += g.getAttribute('position').count / 3; } }
  const colTris = new THREE.BufferGeometry(); colTris.setAttribute('position', new THREE.BufferAttribute(col.out(), 3)); colTris.computeBoundingBox();
  facts.tris = tris; facts.colTris = col.length / 9; facts.emitters = emitters.length; facts.holes = holes.length; facts.cables = cables.length; facts.labels = labels.length; facts.lamps = lamps.length; facts.setPieces = setPieces.map((s) => s.id); facts.ms = Date.now() - t0; facts.msParts = msParts;
  // ground footprints of what E placed (discs x, z, r): for G's crowd to walk around
  const obstacles = []; for (const v of occ.values()) for (const d of v) if (d[2] > 0.2) obstacles.push([+d[0].toFixed(2), +d[1].toFixed(2), +d[2].toFixed(2)]);
  const out = { merged, colTris, emitters, setPieces, holes, cables, labels, lamps, obstacles, facts, materials: DRESS_MATS };
  CACHE.set(layout, out);
  return out;
}

// the ground with the stairwell openings cut out: triangles [[x, z] x3] (CCW seen from above), uv = (x, z) as C's ground
export function groundTris(x0, z0, x1, z1, holes = []) {
  const outer = [new THREE.Vector2(x0, z0), new THREE.Vector2(x1, z0), new THREE.Vector2(x1, z1), new THREE.Vector2(x0, z1)];
  const hs = holes.map((h) => { const v = h.map(([x, z]) => new THREE.Vector2(x, z)); return THREE.ShapeUtils.isClockWise(v) === THREE.ShapeUtils.isClockWise(outer) ? v.reverse() : v; });
  const pts = [...outer, ...hs.flat()];
  return THREE.ShapeUtils.triangulateShape(outer, hs).map((t) => t.map((i) => [pts[i].x, pts[i].y]));
}

// ================================================================================================================
// build(layout, ctx) — runtime parts (browser): cable lines, labels, signal lamps
// ================================================================================================================
export async function build(layout, ctx = {}) {
  const geo = ctx.dressing || CACHE.get(layout) || geometry(layout, { seed: ctx.seed ?? 11, poles: ctx.poles, lotInfo: ctx.lotInfo, lines: ctx.lines });
  const group = new THREE.Group(); group.name = 'seoul.dressing';
  const nit = ctx.nitScale ?? ctx.NITS ?? NITS;
  const disposables = [];

  // ---- 1. cables as screen-space lines: >= 1.25 px wide, coverage alpha (true width / drawn width), a MeshStandardMaterial
  // so S3's grid lights it (glints off the signs; dark against lit facades). The tubes stay for collision and close-ups.
  const polys = geo.cables.slice();
  for (const c of ctx.cables || []) if (c.pts?.length > 1) polys.push({ pts: c.pts, r: c.r ?? 0.025 });
  let lineMesh = null;
  if (polys.length) {
    let nSeg = 0; for (const c of polys) nSeg += c.pts.length - 1;
    const pos = new Float32Array(nSeg * 4 * 3), oth = new Float32Array(nSeg * 4 * 3), side = new Float32Array(nSeg * 4), dir = new Float32Array(nSeg * 4), rad = new Float32Array(nSeg * 4), idx = new Uint32Array(nSeg * 6);
    let v = 0, t = 0;
    for (const c of polys) for (let i = 0; i < c.pts.length - 1; i++) {
      const a = c.pts[i], b = c.pts[i + 1];
      for (const [p, o, d] of [[a, b, 1], [b, a, -1]]) for (const s of [-1, 1]) { pos.set(p, v * 3); oth.set(o, v * 3); side[v] = s; dir[v] = d; rad[v] = c.r; v++; }
      const k = v - 4; idx.set([k, k + 1, k + 3, k, k + 3, k + 2], t); t += 6;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aOther', new THREE.BufferAttribute(oth, 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1)); g.setAttribute('aDir', new THREE.BufferAttribute(dir, 1)); g.setAttribute('aRad', new THREE.BufferAttribute(rad, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1)); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const uRes = { value: new THREE.Vector2(1280, 720) }, uMinPx = { value: ctx.cableMinPx ?? 1.25 };
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.03, 0.03, 0.032), roughness: 0.42, metalness: 0.0, transparent: true, depthWrite: false });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uRes = uRes; sh.uniforms.uMinPx = uMinPx;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec3 aOther; attribute float aSide; attribute float aDir; attribute float aRad; uniform vec2 uRes; uniform float uMinPx;
varying float vCov; varying float vSide; varying float vHw;`)
        .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
  vec3 cA = (modelViewMatrix * vec4(position, 1.0)).xyz, cB = (modelViewMatrix * vec4(aOther, 1.0)).xyz;
  vec3 tv = normalize(cB - cA + vec3(1e-6)) * aDir, ev = normalize(-cA), bv = normalize(cross(tv, ev) + vec3(1e-6));
  transformedNormal = normalize(bv * aSide * 0.8 + ev * 0.6);`)
        .replace('#include <project_vertex>', `#include <project_vertex>
  { vec3 pB = cB; if (pB.z > -0.05) pB = mix(cA, cB, clamp((-0.05 - cA.z) / (cB.z - cA.z + 1e-6), 0.0, 1.0));
    vec4 c1 = projectionMatrix * vec4(pB, 1.0);
    vec2 s0 = gl_Position.xy / gl_Position.w * 0.5 * uRes, s1 = c1.xy / c1.w * 0.5 * uRes;
    vec2 d = (s1 - s0) * aDir; float L = length(d); d = L > 1e-4 ? d / L : vec2(1.0, 0.0);
    vec2 nrm = vec2(-d.y, d.x);
    float rpx = aRad * projectionMatrix[1][1] * 0.5 * uRes.y / max(gl_Position.w, 1e-3);
    float hw = max(0.5 * uMinPx, rpx);
    vCov = clamp(rpx / hw, 0.0, 1.0); vSide = aSide; vHw = hw;
    gl_Position.xy += nrm * aSide * (hw + 0.5) / (0.5 * uRes) * gl_Position.w; }`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vCov; varying float vSide; varying float vHw;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= vCov * clamp((1.0 - abs(vSide)) * (vHw + 0.5), 0.0, 1.0);');
    };
    mat.customProgramCacheKey = () => 'seoul:cableline';
    mat.name = 'seoul:cables';
    lineMesh = new THREE.Mesh(g, mat); lineMesh.name = 'seoul:cableLines'; lineMesh.frustumCulled = false; lineMesh.renderOrder = 2;
    const _v = new THREE.Vector2();
    lineMesh.onBeforeRender = (r) => { const rt = r.getRenderTarget(); if (rt) uRes.value.set(rt.width, rt.height); else { r.getDrawingBufferSize(_v); uRes.value.copy(_v); } };
    group.add(lineMesh); disposables.push(g, mat);
  }

  // ---- 2. labels: one canvas atlas (road-name plates, station exits, tents, the bus stop, the stage)
  const labelMeshes = [];
  const canPaint = typeof document !== 'undefined';
  if (geo.labels.length && canPaint) {
    const fam = await loadFont(ctx.fontBase);
    const PX = 160, cells = geo.labels.map((L) => ({ L, w: Math.max(32, Math.round(L.w * PX * (L.kind === 'exitnum' ? 1.5 : 1))), h: Math.max(24, Math.round(L.h * PX * (L.kind === 'exitnum' ? 1.5 : 1))) }));
    const AW = 2048; let x = 0, y = 0, rowH = 0;
    for (const c of cells) { if (x + c.w > AW) { x = 0; y += rowH + 2; rowH = 0; } c.x = x; c.y = y; x += c.w + 2; rowH = Math.max(rowH, c.h); }
    const AH = Math.min(4096, THREE.MathUtils.ceilPowerOfTwo(y + rowH + 2));
    const cv = document.createElement('canvas'); cv.width = AW; cv.height = AH; const g2 = cv.getContext('2d');
    g2.clearRect(0, 0, AW, AH);
    for (const c of cells) paintLabel(g2, c, fam);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = ctx.renderer ? Math.min(16, ctx.renderer.capabilities.getMaxAnisotropy()) : 8;
    tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    const P = [], UV = [], C = [], I = [];
    for (const c of cells) {
      // the reader's right when facing the label (looking along -n) is up x n: text is never mirrored, whatever L.right says
      const L = c.L, n = new THREE.Vector3(...L.normal).normalize(), u = new THREE.Vector3(0, 1, 0), r = new THREE.Vector3().crossVectors(u, n).normalize();
      const o = new THREE.Vector3(...L.pos).addScaledVector(n, 0.003), hw = L.w / 2, hh = L.h / 2, b = P.length / 3;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const p = o.clone().addScaledVector(r, sx * hw).addScaledVector(u, sy * hh); P.push(p.x, p.y, p.z); UV.push((c.x + (sx > 0 ? c.w : 0)) / AW, 1 - (c.y + (sy > 0 ? 0 : c.h)) / AH); const k = (L.nits || 120) * nit; C.push(k, k, k); }
      I.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); g.setIndex(I);
    const mat = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, toneMapped: false });
    mat.userData.cityLight = false;
    const m = new THREE.Mesh(g, mat); m.name = 'seoul:dressLabels'; m.renderOrder = 3; group.add(m); labelMeshes.push(m); disposables.push(g, mat, tex);
  }

  // ---- 3. signal lamps (octagon lenses), colour from seoul-life's crossPhase on the take clock
  let lampMesh = null, lampCol = null, lastKey = '';
  if (geo.lamps.length) {
    const P = [], I = []; const n8 = 8;
    for (const L of geo.lamps) {
      const n = new THREE.Vector3(...L.normal), up = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), a = new THREE.Vector3().crossVectors(n, up).normalize(), b = new THREE.Vector3().crossVectors(a, n).normalize();
      const o = new THREE.Vector3(...L.pos).addScaledVector(n, 0.004), base = P.length / 3; P.push(o.x, o.y, o.z);
      for (let k = 0; k < n8; k++) { const th = (k / n8) * TAU, p = o.clone().addScaledVector(a, Math.cos(th) * L.r).addScaledVector(b, Math.sin(th) * L.r); P.push(p.x, p.y, p.z); }
      for (let k = 0; k < n8; k++) I.push(base, base + 1 + k, base + 1 + ((k + 1) % n8));
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); lampCol = new THREE.Float32BufferAttribute(new Float32Array(P.length), 3); g.setAttribute('color', lampCol); g.setIndex(I);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false }); mat.userData.cityLight = false;
    lampMesh = new THREE.Mesh(g, mat); lampMesh.name = 'seoul:signalLamps'; group.add(lampMesh); disposables.push(g, mat);
  }
  const LAMP = { carR: [1.0, 0.08, 0.04], carA: [1.0, 0.55, 0.02], carL: [0.2, 1.0, 0.5], carG: [0.15, 1.0, 0.65], walkR: [1.0, 0.1, 0.05], walkG: [0.2, 1.0, 0.6] };
  const lampState = (L, t) => {
    let ph; if (L.phase.kind === 'S') ph = { car: 'G', walk: false }; else { try { ph = LIFE.crossPhase ? LIFE.crossPhase(L.phase, t) : null; } catch (e) { ph = null; } ph ||= { car: 'G', walk: false }; }
    switch (L.role) { case 'carR': return ph.car === 'R'; case 'carA': return ph.car === 'A'; case 'carG': return ph.car === 'G'; case 'carL': return false;
      case 'walkG': return ph.walk && !(ph.tc > ph.w0 + ph.wlen - 6 && Math.floor(t * 2) % 2); case 'walkR': return !ph.walk; }
    return false;
  };
  function updateLamps(t) {
    if (!lampMesh) return;
    let key = ''; const on = geo.lamps.map((L) => { const s = lampState(L, t); key += s ? '1' : '0'; return s; });
    if (key === lastKey) return; lastKey = key;
    const a = lampCol.array; let v = 0;
    geo.lamps.forEach((L, i) => { const c = LAMP[L.role] || [1, 1, 1], k = (on[i] ? 1400 : 0.6) * nit; for (let j = 0; j < 9; j++) { a[v++] = c[0] * k; a[v++] = c[1] * k; a[v++] = c[2] * k; } });
    lampCol.needsUpdate = true;
  }
  updateLamps(0);

  // cable material: make sure S3's grid reaches it (if seoulLight.attach ran before us)
  let patched = false;
  const ensureLit = () => { if (patched || !lineMesh) return; const L = ctx.scene?.userData?.seoulLight; if (L?.patchMaterial) { L.patchMaterial(lineMesh.material); patched = true; } };
  const update = (t = 0) => { ensureLit(); updateLamps(t); };
  return {
    group, update, emitters: [], setPieces: geo.setPieces,
    stats: { cables: polys.length, cableSegs: lineMesh ? lineMesh.geometry.index.count / 6 : 0, labels: geo.labels.length, lamps: geo.lamps.length, ...geo.facts },
    dispose() { for (const d of disposables) d.dispose?.(); group.removeFromParent(); },
  };
}

// ---- font: E's own OFL subset (seoul/dressing/E-Sans.woff2, from Noto Sans KR), system sans-serif if it fails
let fontP = null;
function loadFont(base) {
  if (fontP) return fontP;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return (fontP = Promise.resolve('sans-serif'));
  const url = base ? base + 'E-Sans.woff2' : new URL('./seoul/dressing/E-Sans.woff2', import.meta.url).href;
  fontP = new FontFace('E Sans', `url(${url})`, { weight: '700' }).load().then((f) => { document.fonts.add(f); return '"E Sans", sans-serif'; }, () => 'sans-serif');
  return fontP;
}
const BADGE = { 2: ['#00a84d', '2'], K: ['#77c4a3', '경의'], A: ['#0090d2', '공항'] };
function paintLabel(g, c, fam) {
  const { L, x, y, w, h } = c;
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.textBaseline = 'middle';
  const fit = (txt, size, maxW, weight = 700) => { let s = size; g.font = `${weight} ${s}px ${fam}`; const m = g.measureText(txt).width; if (m > maxW) { s = Math.max(6, s * maxW / m); g.font = `${weight} ${s}px ${fam}`; } return s; };
  if (L.kind === 'plate') {                       // white text on the lit navy face (the face itself is geometry)
    g.fillStyle = '#ffffff'; g.strokeStyle = '#ffffff'; g.lineWidth = Math.max(1, h * 0.03); g.strokeRect(x + h * 0.06, y + h * 0.06, w - h * 0.12, h - h * 0.12);
    g.textAlign = 'center'; fit(L.lines[0], h * 0.46, w * 0.66); g.fillText(L.lines[0], x + w * 0.5, y + h * 0.4);
    fit(L.lines[1], h * 0.17, w * 0.66, 600); g.fillText(L.lines[1], x + w * 0.5, y + h * 0.76);
    g.textAlign = 'left'; fit(L.range || '', h * 0.2, w * 0.16, 600); g.fillText(L.range || '', x + h * 0.14, y + h * 0.5);
  } else if (L.kind === 'exitnum') {
    g.fillStyle = '#111111'; g.textAlign = 'center'; fit(L.lines[0], h * 0.86, w * 0.8, 800); g.fillText(L.lines[0], x + w / 2, y + h * 0.54);
  } else if (L.kind === 'station') {
    let bx = x + h * 0.25;
    for (const b of L.badges || []) { const [colr, t] = BADGE[b] || ['#888', b]; g.fillStyle = colr; g.beginPath(); g.arc(bx + h * 0.3, y + h / 2, h * 0.3, 0, TAU); g.fill(); g.fillStyle = '#fff'; g.textAlign = 'center'; fit(t, h * (t.length > 1 ? 0.2 : 0.38), h * 0.5); g.fillText(t, bx + h * 0.3, y + h * 0.52); bx += h * 0.7; }
    g.fillStyle = '#16181c'; g.textAlign = 'left'; fit(L.lines[0], h * 0.5, w - (bx - x) - h * 0.2, 800); g.fillText(L.lines[0], bx + h * 0.1, y + h * 0.36);
    fit(L.lines[1], h * 0.24, w - (bx - x) - h * 0.2, 600); g.fillText(L.lines[1], bx + h * 0.1, y + h * 0.78);
  } else if (L.kind === 'led') {
    g.fillStyle = '#ff9a1a'; g.textAlign = 'left'; L.lines.forEach((t, i) => { fit(t, h * 0.4, w * 0.92, 600); g.fillText(t, x + w * 0.04, y + h * (0.27 + i * 0.48)); });
  } else if (L.kind === 'busname') {
    g.fillStyle = '#ffffff'; g.textAlign = 'center'; fit(L.lines[0], h * 0.5, w * 0.9, 800); g.fillText(L.lines[0], x + w / 2, y + h * 0.36); fit(L.lines[1], h * 0.24, w * 0.9, 600); g.fillText(L.lines[1], x + w / 2, y + h * 0.78);
  } else if (L.kind === 'stage') {
    g.fillStyle = '#fff4f0'; g.textAlign = 'center'; fit(L.lines[0], h * 0.48, w * 0.92, 800); g.fillText(L.lines[0], x + w / 2, y + h * 0.36); fit(L.lines[1], h * 0.22, w * 0.92, 600); g.fillText(L.lines[1], x + w / 2, y + h * 0.78);
  } else if (L.kind === 'tent') {
    g.fillStyle = 'rgba(255,248,235,0.95)'; g.textAlign = 'center'; fit(L.lines[0], h * 0.8, w * 0.9, 800); g.fillText(L.lines[0], x + w / 2, y + h * 0.54);
  }
  g.restore();
}

// native export (H): the runtime content as plain data (geometry itself goes out through buildGeometry / export-world)
export function exportData(layout, opts = {}) {
  const g = CACHE.get(layout) || geometry(layout, opts);
  return { version: 1, setPieces: g.setPieces, emitters: g.emitters, holes: g.holes, cables: g.cables, labels: g.labels, lamps: g.lamps, obstacles: g.obstacles, materials: DRESS_MATS, facts: g.facts };
}

export const seoulDressing = { geometry, build, material, groundTris, exportData, DRESS_MATS, NITS };
export default seoulDressing;
