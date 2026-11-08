// world-seoul.js — "Neon Seoul": the Hongdae block at night (stream S1: site, geometry, collider, lines).
// The block is measured, not invented: footprints and street centrelines come from OpenStreetMap (seoul/layout.json,
// contract L1, built by seoul/tools/osm-layout.mjs); storeys from building:levels where mapped, else estimated.
// Every building is generated from its lot record: storey stack, ground-floor shopfront (lit or shuttered), a sign
// fascia band for S2, floor bands, windows (some lit), AC units on exposed walls, parapet, rooftop stair house and
// water tank. Streets get asphalt / pavers by kind, lane marks on the main roads, LED street lights, and the alleys
// get concrete utility poles with sagging cable bundles and service drops (D5: cables are 3-6 cm tubes in the BVH).
// Collision = the same geometry (exact), through a BVH, as in world-bando.js.
//
// Contract L2: buildSeoul(renderer, [scene], opts) returns the world object main.js uses for bando (scene,
// colliderScene, depthScene, bvh, skimBvh, update, spawn, yaw, takeStart, startPoints, funnels, lines, bounds,
// envelope, aoUniforms, rebakeShadows, grassAt, hdr, stats) plus look/sky ('night'), layout and emitters (L3).
// Optional partner modules, each tolerated missing: seoul-signs.js (S2), seoul-life.js (S4), seoul-light.js (S3).
// Units: metres, y up, x east, z south. Light: scene-linear radiance, NITS = 0.1 scene units per cd/m2 (integrator
// decision; passed to partners as ctx.nitScale). Pure-CPU part: buildSeoulGeometry(layout) (node, CI).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';

// Integrator decision (Seoul light units): 1 cd/m2 = 0.1 scene units (S3's NITS), which keeps night exposure inside
// the camera's EV range. Illuminance uses the same factor (three: radiance = E x albedo / PI).
export const NITS = 0.1;
export const NIT = NITS;            // alias used inside this file
export const LUX = NITS;            // three light intensity per lux
const PH = 'https://dl.polyhaven.org/file/ph-assets';
const IS_NODE = typeof window === 'undefined';

// CC0 Poly Haven scans (1k). color: tint on the texture (linear multiplier); albedo: the material's mean (for bakes/tests).
export const SEOUL_MATS = {
  road: { id: 'asphalt_02', tile: 6.0, maps: ['diff', 'nor_gl'], color: [0.9, 0.9, 0.92], rough: 0.55, albedo: [0.10, 0.10, 0.10] },     // wet-ish: S3 owns the reflection
  walk: { id: 'concrete_pavers_02', tile: 2.4, maps: ['diff', 'nor_gl'], color: [0.95, 0.95, 0.95], rough: 0.7, albedo: [0.25, 0.24, 0.23] },
  plaza: { id: 'brick_pavement_02', tile: 2.0, maps: ['diff', 'nor_gl'], color: [0.85, 0.8, 0.8], rough: 0.7, albedo: [0.22, 0.17, 0.15] },
  tile: { id: 'concrete_tile_facade', tile: 3.0, maps: ['diff', 'nor_gl'], color: [1.0, 0.98, 0.95], rough: 0.6, albedo: [0.40, 0.38, 0.35] },   // beige/white facade tile
  brick: { id: 'brown_brick_02', tile: 2.2, maps: ['diff', 'nor_gl'], color: [1.0, 0.95, 0.95], rough: 0.85, albedo: [0.26, 0.15, 0.12] },     // Hongdae's red-brown brick
  plaster: { id: 'beige_wall_001', tile: 3.0, maps: ['diff', 'nor_gl'], color: [0.95, 0.95, 0.95], rough: 0.9, albedo: [0.45, 0.42, 0.38] },
  concrete: { id: 'concrete_wall_008', tile: 3.0, maps: ['diff', 'nor_gl'], color: [0.9, 0.9, 0.9], rough: 0.9, albedo: [0.30, 0.29, 0.27] },
  roof: { id: 'concrete_floor_02', tile: 4.0, maps: ['diff', 'nor_gl'], color: [0.55, 0.75, 0.6], rough: 0.8, albedo: [0.17, 0.22, 0.18] },   // green roof paint (T5)
  metal: { id: 'blue_metal_plate', tile: 2.0, maps: ['diff'], color: [0.6, 0.62, 0.65], rough: 0.5, metal: 0.4, albedo: [0.20, 0.21, 0.22] },
  shutter: { id: 'blue_metal_plate', tile: 1.2, maps: ['diff', 'nor_gl'], color: [0.75, 0.75, 0.78], rough: 0.45, metal: 0.5, albedo: [0.24, 0.24, 0.25] },
  white: { color: [0.42, 0.42, 0.40], rough: 0.6, albedo: [0.42, 0.42, 0.40] },          // AC units, fascia, tanks (flat; ivory-grey enamel under grime)
  dark: { color: [0.035, 0.035, 0.04], rough: 0.45, albedo: [0.035, 0.035, 0.04] },        // cables, pole hardware
  pole: { color: [0.32, 0.31, 0.3], rough: 0.85, albedo: [0.32, 0.31, 0.30] },
  stripe: { color: [0.75, 0.75, 0.72], rough: 0.6, albedo: [0.75, 0.75, 0.72] },
  yellow: { color: [0.7, 0.5, 0.06], rough: 0.6, albedo: [0.7, 0.5, 0.06] },
  glass: { color: [0.02, 0.022, 0.026], rough: 0.08, metal: 0.0, emissive: true, albedo: [0.02, 0.022, 0.026] },   // windows: aEm carries the interior light
  shop: { color: [0.03, 0.03, 0.03], rough: 0.15, emissive: true, albedo: [0.03, 0.03, 0.03] },                    // lit shopfronts
  lamp: { color: [0.05, 0.05, 0.05], rough: 0.5, emissive: true, albedo: [0.05, 0.05, 0.05] },                     // street-light heads
};
// what each lot's use looks like at street level at ~23:00 (shopfront light: linear rgb, cd/m2 seen through the glass;
// shut: chance the shutter is down). Interiors 300-1500 cd/m2 through glass; convenience stores are the brightest and coldest.
const USE_LOOK = {
  club: { rgb: [0.9, 0.35, 1.0], nits: 250, shut: 0.15 }, bar: { rgb: [1.0, 0.55, 0.3], nits: 350, shut: 0.1 },
  pocha: { rgb: [1.0, 0.6, 0.25], nits: 500, shut: 0.05 }, restaurant: { rgb: [1.0, 0.78, 0.55], nits: 600, shut: 0.25 },
  cafe: { rgb: [1.0, 0.8, 0.6], nits: 500, shut: 0.35 }, shop: { rgb: [1.0, 0.95, 0.9], nits: 800, shut: 0.45 },
  conv: { rgb: [0.85, 0.95, 1.0], nits: 1500, shut: 0 }, karaoke: { rgb: [0.8, 0.5, 1.0], nits: 300, shut: 0.05 },
  pc: { rgb: [0.5, 0.8, 1.0], nits: 300, shut: 0.05 }, motel: { rgb: [1.0, 0.5, 0.6], nits: 200, shut: 0.1 },
  office: { rgb: [0.9, 0.95, 1.0], nits: 400, shut: 0.8 }, hotel: { rgb: [1.0, 0.85, 0.65], nits: 500, shut: 0.1 },
};
const K = { band: 0.12, fascia: [3.05, 1.0, 0.32], shopTop: 2.95, parapet: 0.9, poleH: 10.0, poleR: 0.17, poleStep: 26, cableR: 0.022 };

// ---- seeded helpers (no Math.random anywhere: geometry is part of the replay hash)
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
function rng(seed) { let s = (typeof seed === 'number' ? seed : Math.floor(hash(seed) * 4294967296)) >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const lerp = (a, b, t) => a + (b - a) * t;

// ---- geometry accumulator: non-indexed triangles per material key
class Acc {
  constructor(em) { this.p = []; this.n = []; this.uv = []; this.e = em ? [] : null; }
  tri(a, b, c, ua, ub, uc, em) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    this.p.push(...a, ...b, ...c); this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz); this.uv.push(...ua, ...ub, ...uc);
    if (this.e) { const v = em || [0, 0, 0]; this.e.push(...v, ...v, ...v); }
  }
  // quad p0..p3 (a loop), facing `nrm` (winding fixed to match), uv per corner
  quad(p0, p1, p2, p3, nrm, uvs = [[0, 0], [1, 0], [1, 1], [0, 1]], em) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * nrm[0] + cy * nrm[1] + cz * nrm[2] >= 0) { this.tri(p0, p1, p2, uvs[0], uvs[1], uvs[2], em); this.tri(p0, p2, p3, uvs[0], uvs[2], uvs[3], em); }
    else { this.tri(p0, p2, p1, uvs[0], uvs[2], uvs[1], em); this.tri(p0, p3, p2, uvs[0], uvs[3], uvs[2], em); }
  }
  // oriented box: centre c, half sizes h [x,y,z] in its frame, yaw about +y (frame x = (cos, -sin) ... see below)
  box(c, h, yaw = 0, skipBottom = true, em) {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const P = (x, y, z) => [c[0] + x * cs + z * sn, c[1] + y, c[2] - x * sn + z * cs];
    const N = (x, y, z) => [x * cs + z * sn, y, -x * sn + z * cs];
    const [hx, hy, hz] = h;
    const f = (a, b, cc, d, n, w, hh) => this.quad(P(...a), P(...b), P(...cc), P(...d), N(...n), [[0, 0], [w, 0], [w, hh], [0, hh]], em);
    f([-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [0, 0, 1], 2 * hx, 2 * hy);
    f([hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [0, 0, -1], 2 * hx, 2 * hy);
    f([hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [1, 0, 0], 2 * hz, 2 * hy);
    f([-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-1, 0, 0], 2 * hz, 2 * hy);
    f([-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz], [0, 1, 0], 2 * hx, 2 * hz);
    if (!skipBottom) f([-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz], [0, -1, 0], 2 * hx, 2 * hz);
  }
  // tube along a polyline (sides-gon), radius r
  tube(pts, r, sides = 4, cap = false) {
    const ring = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let t = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      const up = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const u = new THREE.Vector3().crossVectors(t, up).normalize(), v = new THREE.Vector3().crossVectors(u, t).normalize();
      ring.push([...Array(sides)].map((_, k) => { const th = (k / sides) * Math.PI * 2, c = Math.cos(th) * r, s = Math.sin(th) * r;
        return { p: [pts[i][0] + u.x * c + v.x * s, pts[i][1] + u.y * c + v.y * s, pts[i][2] + u.z * c + v.z * s], n: [u.x * Math.cos(th) + v.x * Math.sin(th), u.y * Math.cos(th) + v.y * Math.sin(th), u.z * Math.cos(th) + v.z * Math.sin(th)] }; }));
    }
    for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < sides; k++) {
      const a = ring[i][k], b = ring[i][(k + 1) % sides], c = ring[i + 1][(k + 1) % sides], d = ring[i + 1][k];
      const n = [(a.n[0] + b.n[0]) / 2, (a.n[1] + b.n[1]) / 2, (a.n[2] + b.n[2]) / 2];
      this.quad(a.p, b.p, c.p, d.p, n, [[k / sides, i], [(k + 1) / sides, i], [(k + 1) / sides, i + 1], [k / sides, i + 1]]);
    }
    if (cap) { const top = ring[ring.length - 1], c = pts[pts.length - 1]; for (let k = 0; k < sides; k++) this.tri(c, top[k].p, top[(k + 1) % sides].p, [0, 0], [1, 0], [1, 1]); }
  }
  // vertical cylinder (closed top), centre-bottom c
  cyl(c, r, h, sides = 10) {
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2, a1 = ((k + 1) / sides) * Math.PI * 2;
      const p0 = [c[0] + Math.cos(a0) * r, c[1], c[2] + Math.sin(a0) * r], p1 = [c[0] + Math.cos(a1) * r, c[1], c[2] + Math.sin(a1) * r];
      const am = (a0 + a1) / 2, s0 = (k / sides) * Math.PI * 2 * r, s1 = ((k + 1) / sides) * Math.PI * 2 * r;
      this.quad(p0, p1, [p1[0], c[1] + h, p1[2]], [p0[0], c[1] + h, p0[2]], [Math.cos(am), 0, Math.sin(am)], [[s0, 0], [s1, 0], [s1, h], [s0, h]]);
      this.tri([c[0], c[1] + h, c[2]], [p1[0], c[1] + h, p1[2]], [p0[0], c[1] + h, p0[2]], [0, 0], [1, 0], [0, 1]);
    }
  }
  geometry() {
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.e) g.setAttribute('aEm', new THREE.Float32BufferAttribute(this.e, 3));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

// the layout's extent: layout.box {x0,x1,z0,z1}; older layouts: `half`, or the lots' bounds
export function boxOf(layout) {
  if (layout.box) return layout.box;
  if (layout.half) return { x0: -layout.half, x1: layout.half, z0: -layout.half, z1: layout.half };
  const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const l of layout.lots) for (const [x, z] of l.footprint) { b.x0 = Math.min(b.x0, x - 10); b.x1 = Math.max(b.x1, x + 10); b.z0 = Math.min(b.z0, z - 10); b.z1 = Math.max(b.z1, z + 10); }
  return b;
}
// ---- polygon helpers (footprints are CCW in x-z maths terms: outward normal of edge a->b is (dz, -dx))
const polyArea = (P) => { let a = 0; for (let i = 0; i < P.length; i++) { const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % P.length]; a += x0 * z1 - x1 * z0; } return a / 2; };
const pip = (x, z, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
const segD = (px, pz, ax, az, bx, bz) => { const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1e-9; const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2)); return Math.hypot(px - ax - t * vx, pz - az - t * vz); };
function polyD(px, pz, P) { let d = Infinity; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; d = Math.min(d, segD(px, pz, a[0], a[1], b[0], b[1])); } return d; }

// spatial hash of lots (for exposure tests and pole placement)
function lotGrid(lots, cell = 20) {
  const m = new Map(), key = (i, j) => i * 73856093 ^ j * 19349663;
  lots.forEach((l) => { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const [x, z] of l.footprint) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    l._bb = [x0, x1, z0, z1]; l._H = l.floors * l.floorH;
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) { const k = key(i, j); if (!m.has(k)) m.set(k, []); m.get(k).push(l); } });
  return { near: (x, z) => m.get(key(Math.floor(x / cell), Math.floor(z / cell))) || [],
    inside: (x, z, skip) => (m.get(key(Math.floor(x / cell), Math.floor(z / cell))) || []).find((l) => l !== skip && x >= l._bb[0] && x <= l._bb[1] && z >= l._bb[2] && z <= l._bb[3] && pip(x, z, l.footprint)) || null };
}

// ================================================================================================================
// buildSeoulGeometry(layout): pure CPU (node / CI / exporters). Returns merged geometry per material, the collider,
// emitters (L3), lines/funnels/startPoints (from `lineData`, seoul/lines.json), and per-lot facts.
// ================================================================================================================
export function buildSeoulGeometry(layout, { lineData = null, seed = 11 } = {}) {
  const t0 = Date.now();
  const acc = {}; const A = (k) => (acc[k] ||= new Acc(!!SEOUL_MATS[k]?.emissive));
  const noCol = new Set(['stripe', 'yellow', 'glass', 'shop']);   // flush decals: render only (their wall/ground is in the collider)
  const emitters = [], facts = { lots: layout.lots.length, windowsLit: 0, windows: 0, shopsLit: 0, shutters: 0, ac: 0, tanks: 0, poles: 0, cableSpans: 0, streetLights: 0 };
  const streets = layout.streets, lots = layout.lots, streetById = new Map(streets.map((s) => [s.id, s]));
  const grid = lotGrid(lots);
  const B = boxOf(layout);

  // ---------------- ground: sidewalk pavers everywhere, streets on top by kind
  { const x0 = B.x0 - 80, x1 = B.x1 + 80, z0 = B.z0 - 80, z1 = B.z1 + 80; A('walk').quad([x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0], [0, 1, 0], [[x0, z1], [x1, z1], [x1, z0], [x0, z0]]); }
  const ribbon = (key, pts, w, y, uvScale = 1) => {
    // mitred ribbon along a polyline at height y
    const n = pts.length; if (n < 2) return; const L = [], R = []; let s = 0; const S = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      let ox = -tz, oz = tx, m = 1;
      if (i > 0 && i < n - 1) { // mitre
        const t1x = pts[i][0] - pts[i - 1][0], t1z = pts[i][1] - pts[i - 1][1], l1 = Math.hypot(t1x, t1z) || 1;
        const d = (-t1z / l1) * ox + (t1x / l1) * oz; m = 1 / Math.max(0.5, d);
      }
      if (i > 0) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); S.push(s);
      L.push([pts[i][0] + ox * w / 2 * m, y, pts[i][1] + oz * w / 2 * m]); R.push([pts[i][0] - ox * w / 2 * m, y, pts[i][1] - oz * w / 2 * m]);
    }
    for (let i = 0; i < n - 1; i++) A(key).quad(R[i], L[i], L[i + 1], R[i + 1], [0, 1, 0], [[-w / 2 * uvScale, S[i] * uvScale], [w / 2 * uvScale, S[i] * uvScale], [w / 2 * uvScale, S[i + 1] * uvScale], [-w / 2 * uvScale, S[i + 1] * uvScale]]);
  };
  // y stacking (no z-fight): alleys 0.010, club 0.012, main 0.014, walking pavers 0.016, marks 0.022
  const Y = { alley: 0.010, club: 0.012, main: 0.014, walking: 0.016 };
  for (const s of [...streets].sort((a, b) => Y[a.kind] - Y[b.kind])) ribbon(s.kind === 'walking' ? 'plaza' : 'road', s.points, s.width, Y[s.kind]);
  // lane marks: dashed white lane lines on main roads (3 m dash, 5 m gap: Korean urban standard), solid edge lines
  const dashes = (pts, off, y, key, dash, gap, w) => {
    let carry = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < 0.1) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L, ox = -tz * off, oz = tx * off;
      for (let s = carry; s < L; s += dash + gap) {
        const e = Math.min(L, s + dash); if (e - s < 0.3) continue;
        const p0 = [ax + tx * s + ox, az + tz * s + oz], p1 = [ax + tx * e + ox, az + tz * e + oz];
        A(key).quad([p0[0] + tz * w / 2, y, p0[1] - tx * w / 2], [p1[0] + tz * w / 2, y, p1[1] - tx * w / 2], [p1[0] - tz * w / 2, y, p1[1] + tx * w / 2], [p0[0] - tz * w / 2, y, p0[1] + tx * w / 2], [0, 1, 0]);
      }
      carry = ((carry - L) % (dash + gap) + (dash + gap)) % (dash + gap);
    }
  };
  for (const s of streets) {
    if (s.kind !== 'main' || s.width < 6) continue;
    const lanes = Math.max(1, Math.round(s.width / 3.25));
    for (let k = 1; k < lanes; k++) dashes(s.points, -s.width / 2 + k * (s.width / lanes), 0.022, 'stripe', 3, 5, 0.15);
    dashes(s.points, s.width / 2 - 0.25, 0.022, 'stripe', 1e4, 0, 0.15); dashes(s.points, -s.width / 2 + 0.25, 0.022, 'stripe', 1e4, 0, 0.15);
  }
  // alleys: the yellow "slow / no parking" edge lines Seoul paints along shared alleys
  for (const s of streets) if (s.kind === 'alley' || s.kind === 'club') { dashes(s.points, s.width / 2 - 0.2, 0.02, 'yellow', 1e4, 0, 0.12); }

  // ---------------- buildings
  const facadeOf = (l) => { const r = hash(l.id + 'f'); if (l.floors >= 9) return r < 0.6 ? 'tile' : 'concrete'; return r < 0.38 ? 'brick' : r < 0.75 ? 'tile' : r < 0.9 ? 'plaster' : 'concrete'; };
  const lotInfo = new Map();
  for (const l of lots) {
    const R = rng(l.id), P = l.footprint, H = l.floors * l.floorH, fmat = facadeOf(l), look = USE_LOOK[l.use] || USE_LOOK.shop;
    const [fa, fb] = l.frontage;
    const info = { id: l.id, H, facade: fmat, shopLit: false, shutter: false, fascia: null, edges: [] };
    lotInfo.set(l.id, info);
    // walls + parapet
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz); if (L < 0.05) continue;
      const tx = dx / L, tz = dz / L, nx = tz, nz = -tx, mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const Ht = H + K.parapet, us = hash(l.id + i) * 7;
      A(fmat).quad([a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], Ht, b[1]], [a[0], Ht, a[1]], [nx, 0, nz], [[us, 0], [us + L, 0], [us + L, Ht], [us, Ht]]);
      // parapet inner face and coping
      const ia = [a[0] - nx * 0.2, a[1] - nz * 0.2], ib = [b[0] - nx * 0.2, b[1] - nz * 0.2];
      A('concrete').quad([ib[0], H, ib[1]], [ia[0], H, ia[1]], [ia[0], Ht, ia[1]], [ib[0], Ht, ib[1]], [-nx, 0, -nz], [[0, 0], [L, 0], [L, K.parapet], [0, K.parapet]]);
      A('concrete').quad([a[0], Ht, a[1]], [b[0], Ht, b[1]], [ib[0], Ht, ib[1]], [ia[0], Ht, ia[1]], [0, 1, 0], [[0, 0], [L, 0], [L, 0.2], [0, 0.2]]);
      // exposure: is the space 1.5 m in front of this wall open (a street or a gap), at its middle and quarter points?
      const open = [0.25, 0.5, 0.75].filter((t) => !grid.inside(a[0] + dx * t + nx * 1.5, a[1] + dz * t + nz * 1.5, l)).length >= 2;
      // a wall facing a gap under 3.2 m (the slot between two buildings): windows, but no AC units or lips in the slot
      const slot = open && [0.25, 0.5, 0.75].filter((t) => grid.inside(a[0] + dx * t + nx * 3.2, a[1] + dz * t + nz * 3.2, l)).length >= 2;
      const front = (Math.hypot(a[0] - fa[0], a[1] - fa[1]) < 0.05 && Math.hypot(b[0] - fb[0], b[1] - fb[1]) < 0.05);
      info.edges.push({ a, b, L, tx, tz, nx, nz, open, front });
      if (!open && !front) continue;
      // floor bands on exposed walls (they collide: a 12 cm lip, a real thing to clip)
      if (!slot) for (let f = 1; f < l.floors; f++) { // a 12 cm x 20 cm lip: face, top and soffit (its ends are flush with the neighbours)
        const y = f * l.floorH, o = K.band, a0 = [a[0] + nx * o, a[1] + nz * o], b0 = [b[0] + nx * o, b[1] + nz * o];
        A('concrete').quad([a0[0], y - 0.1, a0[1]], [b0[0], y - 0.1, b0[1]], [b0[0], y + 0.1, b0[1]], [a0[0], y + 0.1, a0[1]], [nx, 0, nz], [[0, 0], [L, 0], [L, 0.2], [0, 0.2]]);
        A('concrete').quad([a[0], y + 0.1, a[1]], [b[0], y + 0.1, b[1]], [b0[0], y + 0.1, b0[1]], [a0[0], y + 0.1, a0[1]], [0, 1, 0], [[0, 0], [L, 0], [L, o], [0, o]]);
        A('concrete').quad([a[0], y - 0.1, a[1]], [b[0], y - 0.1, b[1]], [b0[0], y - 0.1, b0[1]], [a0[0], y - 0.1, a0[1]], [0, -1, 0], [[0, 0], [L, 0], [L, o], [0, o]]);
      }
      // windows per storey: bays ~3 m, 1.5 m tall, the sill 0.9 m above the floor; some lit (warm / cool / dim)
      const bays = Math.max(1, Math.floor((L - 0.6) / 3.0)), bw = Math.min(2.0, (L - 0.6) / bays - 0.7);
      if (bw > 0.5) for (let f = front ? 1 : 0; f < l.floors; f++) {
        const y0 = f * l.floorH + 0.9, y1 = Math.min(y0 + 1.5, (f + 1) * l.floorH - 0.25);
        for (let k = 0; k < bays; k++) {
          const s = 0.3 + (k + 0.5) * ((L - 0.6) / bays), cx = a[0] + tx * s + nx * 0.03, cz = a[1] + tz * s + nz * 0.03;
          const r = R(); facts.windows++;
          let em = [0, 0, 0];
          if (r < 0.42) { facts.windowsLit++; const warm = R() < 0.6, n = (80 + R() * 220) * NIT; em = warm ? [n, n * 0.78, n * 0.55] : [n * 0.85, n * 0.95, n]; }
          A('glass').quad([cx - tx * bw / 2, y0, cz - tz * bw / 2], [cx + tx * bw / 2, y0, cz + tz * bw / 2], [cx + tx * bw / 2, y1, cz + tz * bw / 2], [cx - tx * bw / 2, y1, cz - tz * bw / 2], [nx, 0, nz], [[0, 0], [1, 0], [1, 1], [0, 1]], em);
          // AC units under some windows on side and back walls, or high on the front (the real Seoul pattern)
          if (f >= 1 && !slot && R() < (front ? 0.12 : 0.3)) {
            facts.ac++; const ax = cx + tx * (bw / 2 + 0.55) + nx * 0.2, az = cz + tz * (bw / 2 + 0.55) + nz * 0.2;
            A('white').box([ax, y0 - 0.25, az], [0.42, 0.32, 0.17], Math.atan2(-tz, tx), false);   // outdoor unit (its bracket is below the 1080p pixel)
          }
        }
      }
      if (!front) continue;
      // ground floor shopfront: glass between 0.4 m piers, lit or shuttered by use; the fascia band above it (S2's sign bed)
      const shut = R() < look.shut; info.shutter = shut; info.shopLit = !shut;
      const w0 = 0.4, w1 = L - 0.4;
      if (w1 - w0 > 0.8) {
        const p0 = [a[0] + tx * w0 + nx * 0.04, a[1] + tz * w0 + nz * 0.04], p1 = [a[0] + tx * w1 + nx * 0.04, a[1] + tz * w1 + nz * 0.04];
        if (shut) {
          facts.shutters++;
          A('shutter').quad([p0[0], 0.02, p0[1]], [p1[0], 0.02, p1[1]], [p1[0], K.shopTop, p1[1]], [p0[0], K.shopTop, p0[1]], [nx, 0, nz], [[0, 0], [w1 - w0, 0], [w1 - w0, K.shopTop], [0, K.shopTop]]);
          // the shutter box above
          A('metal').box([(p0[0] + p1[0]) / 2 + nx * 0.15, K.shopTop + 0.15, (p0[1] + p1[1]) / 2 + nz * 0.15], [(w1 - w0) / 2, 0.15, 0.15], Math.atan2(-tz, tx), false);
        } else {
          facts.shopsLit++;
          const n = look.nits * (0.7 + R() * 0.6) * NIT, em = look.rgb.map((c) => c * n);
          A('shop').quad([p0[0], 0.05, p0[1]], [p1[0], 0.05, p1[1]], [p1[0], K.shopTop, p1[1]], [p0[0], K.shopTop, p0[1]], [nx, 0, nz], [[0, 0], [1, 0], [1, 1], [0, 1]], em);
          const c = [(p0[0] + p1[0]) / 2, K.shopTop / 2, (p0[1] + p1[1]) / 2];
          emitters.push({ id: 'store:' + l.id, pos: [+(c[0] + nx * 0.05).toFixed(2), +c[1].toFixed(2), +(c[2] + nz * 0.05).toFixed(2)], normal: [+nx.toFixed(3), 0, +nz.toFixed(3)], w: +(w1 - w0).toFixed(2), h: K.shopTop - 0.05,
            rgb: look.rgb, nits: Math.round(n / NIT), kind: 'store', animated: false, lot: l.id });
        }
        // fascia (sign band) 3.05-4.05 m, 32 cm proud: S2 mounts channel letters / light boxes on it
        const [fy, fh, fd] = K.fascia, fc = [(a[0] + b[0]) / 2 + nx * fd / 2, fy + fh / 2, (a[1] + b[1]) / 2 + nz * fd / 2];
        A('white').box(fc, [L / 2, fh / 2, fd / 2], Math.atan2(-tz, tx), false);
        info.fascia = { c: [fc[0] + nx * fd / 2, fc[1], fc[2] + nz * fd / 2], normal: [nx, 0, nz], t: [tx, 0, tz], w: L, h: fh };
      }
      // piers
      for (const s of [0.2, L - 0.2]) A(fmat).box([a[0] + tx * s + nx * 0.06, K.shopTop / 2, a[1] + tz * s + nz * 0.06], [0.2, K.shopTop / 2, 0.06], Math.atan2(-tz, tx));
    }
    // roof (triangulated) and rooftop dressing
    { const contour = P.map(([x, z]) => new THREE.Vector2(x, z)), tris = THREE.ShapeUtils.triangulateShape(contour, []);
      for (const [i, j, k] of tris) { const a = [P[i][0], H, P[i][1]], b = [P[j][0], H, P[j][1]], c = [P[k][0], H, P[k][1]];
        const cr = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);   // y of (b-a) x (c-a)
        if (cr >= 0) A('roof').tri(a, b, c, [a[0], a[2]], [b[0], b[2]], [c[0], c[2]]); else A('roof').tri(a, c, b, [a[0], a[2]], [c[0], c[2]], [b[0], b[2]]); } }
    const area = Math.abs(polyArea(P)), [x0, x1, z0, z1] = l._bb;
    // a point inside the roof at least `m` from its edge (sampled)
    const roofSpot = (m) => { for (let t = 0; t < 14; t++) { const x = lerp(x0, x1, R()), z = lerp(z0, z1, R()); if (pip(x, z, P) && polyD(x, z, P) > m) return [x, z]; } return null; };
    info.roof = [];
    if (area > 60 && R() < 0.7) { const s = roofSpot(2.2); if (s) { // stair house (penthouse) 2.6 m
      const yaw = Math.atan2(-(fb[1] - fa[1]), fb[0] - fa[0]); A(fmat === 'brick' ? 'brick' : 'concrete').box([s[0], H + 1.3, s[1]], [1.5, 1.3, 1.6], yaw); A('roof').box([s[0], H + 2.65, s[1]], [1.7, 0.05, 1.8], yaw); info.roof.push({ kind: 'stair', x: s[0], z: s[1], top: H + 2.7 }); } }
    if (area > 40 && l.floors <= 8 && R() < 0.55) { const s = roofSpot(1.6); if (s) { // water tank on a steel stand (FRP / stainless)
      facts.tanks++; const r = 0.6 + R() * 0.5, h = 1.2 + R() * 0.6;
      A('metal').box([s[0], H + 0.25, s[1]], [r + 0.1, 0.25, r + 0.1], 0, false);
      A(R() < 0.5 ? 'white' : 'metal').cyl([s[0], H + 0.5, s[1]], r, h, 10); info.roof.push({ kind: 'tank', x: s[0], z: s[1], top: H + 0.5 + h }); } }
    if (area > 80 && R() < 0.5) { const s = roofSpot(1.2); if (s) { facts.ac++; A('white').box([s[0], H + 0.55, s[1]], [0.5, 0.55, 0.35], R() * 3); } }   // condenser
  }

  // ---------------- street lights on main roads: LED cobra heads, ~30 m apart, both sides staggered
  const lampHead = (x, z, ox, oz, h, arm) => {
    const px = x + ox * arm, pz = z + oz * arm;
    A('pole').tube([[x, 0, z], [x, h, z], [x + ox * 0.4, h + 0.3, z + oz * 0.4], [px, h + 0.35, pz]], 0.09, 6);
    A('pole').box([px, h + 0.3, pz], [0.32, 0.08, 0.18], Math.atan2(-oz, ox), false);
    A('lamp').quad([px - ox * 0.28 - oz * 0.12, h + 0.215, pz - oz * 0.28 + ox * 0.12], [px + ox * 0.28 - oz * 0.12, h + 0.215, pz + oz * 0.28 + ox * 0.12], [px + ox * 0.28 + oz * 0.12, h + 0.215, pz + oz * 0.28 - ox * 0.12], [px - ox * 0.28 + oz * 0.12, h + 0.215, pz - oz * 0.28 - ox * 0.12], [0, -1, 0], undefined, [1.0 * 9000 * NIT, 0.93 * 9000 * NIT, 0.82 * 9000 * NIT]);
    emitters.push({ id: 'street:' + emitters.length, pos: [+px.toFixed(2), +(h + 0.2).toFixed(2), +pz.toFixed(2)], normal: [0, -1, 0], w: 0.56, h: 0.24, rgb: [1.0, 0.93, 0.82], nits: 9000, kind: 'street', animated: false, lumens: 12000 });
    facts.streetLights++;
  };
  const along = (pts, step, fn) => { let carry = step / 2; for (let i = 0; i < pts.length - 1; i++) { const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < 0.1) continue; const tx = (bx - ax) / L, tz = (bz - az) / L; let s = carry; for (; s < L; s += step) fn(ax + tx * s, az + tz * s, tx, tz); carry = s - L; } };
  const clearSpot = (x, z, r) => !grid.inside(x, z) && !grid.near(x, z).some((l) => polyD(x, z, l.footprint) < r) && x > B.x0 && x < B.x1 && z > B.z0 && z < B.z1;
  let side = 1;
  for (const s of streets) {
    if (s.kind !== 'main' || s.width < 7) continue;
    along(s.points, 32, (x, z, tx, tz) => { side = -side; const off = s.width / 2 + 0.7, ox = -tz * side, oz = tx * side, px = x + ox * off, pz = z + oz * off;
      if (clearSpot(px, pz, 0.8)) lampHead(px, pz, -ox, -oz, 8.5, 1.6); });
  }
  // walking street and club streets: short pedestrian lamp posts (4.5 m), warm
  for (const s of streets) {
    if (s.kind !== 'walking' && s.kind !== 'club') continue;
    along(s.points, 24, (x, z, tx, tz) => { side = -side; const off = s.width / 2 - 0.4, ox = -tz * side, oz = tx * side, px = x + ox * off, pz = z + oz * off;
      if (clearSpot(px, pz, 0.6)) lampHead(px, pz, -ox, -oz, 4.5, 0.5); });
  }

  // ---------------- utility poles and cables along alleys and club streets (overhead lines are the norm off the main roads)
  const poles = [], cables = [];
  for (const s of streets) {
    if (s.kind === 'main' || s.kind === 'walking') continue;
    const R = rng('poles' + s.id); let prev = null; let sd = R() < 0.5 ? 1 : -1;
    along(s.points, K.poleStep * (0.85 + R() * 0.3), (x, z, tx, tz) => {
      const off = s.width / 2 - 0.25, ox = -tz * sd, oz = tx * sd; let px = x + ox * off, pz = z + oz * off;
      if (!clearSpot(px, pz, 0.35)) { px = x - ox * off; pz = z - oz * off; if (!clearSpot(px, pz, 0.35)) { prev = null; return; } }
      if (poles.some((p) => Math.hypot(p.x - px, p.z - pz) < 12)) { prev = null; return; }
      const p = { x: px, z: pz, h: K.poleH - R() * 1.2, street: s.id, tx, tz };
      poles.push(p); facts.poles++;
      A('pole').tube([[px, 0, pz], [px, p.h, pz]], K.poleR, 8, true);
      // cross arm + transformer on some
      A('dark').box([px, p.h - 0.6, pz], [0.9, 0.05, 0.06], Math.atan2(-tz, tx), false);
      if (R() < 0.3) { A('pole').cyl([px + ox * 0.45, p.h - 2.6, pz + oz * 0.45], 0.28, 1.0, 8); }
      if (prev && Math.hypot(prev.x - px, prev.z - pz) < 45) spanCables(prev, p, R);
      // service drops to the facades across the street (2-3 per pole)
      for (let k = 0; k < 2 + Math.floor(R() * 2); k++) {
        const along2 = (R() - 0.5) * 10, qx = x + tx * along2 - ox * (s.width / 2 + 0.05), qz = z + tz * along2 - oz * (s.width / 2 + 0.05);
        const hit = grid.near(qx, qz).find((l) => polyD(qx, qz, l.footprint) < 0.6);
        if (!hit) continue;
        const ya = p.h - 1.0 - R() * 1.5, yb = Math.min(hit._H - 0.5, 4.2 + R() * 2.5);
        catenary([px, ya, pz], [qx, yb, qz], 0.03 + R() * 0.02, 0.012 + R() * 0.01);
      }
      prev = p;
    });
  }
  function catenary(a, b, sagFrac, r) {
    const L = Math.hypot(b[0] - a[0], b[2] - a[2]), sag = sagFrac * L, pts = [], n = Math.max(4, Math.ceil(L / 3));
    for (let i = 0; i <= n; i++) { const t = i / n; pts.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t) - 4 * sag * t * (1 - t), lerp(a[2], b[2], t)]); }
    A('dark').tube(pts, r, 4);
    return pts;
  }

  function spanCables(p, q, R) {
    facts.cableSpans++;
    const nb = 3 + Math.floor(R() * 4);   // 3-6 lines in a span, 2-4 % sag (T5)
    for (let k = 0; k < nb; k++) {
      const ya = p.h - 0.7 - k * 0.35 - R() * 0.2, yb = q.h - 0.7 - k * 0.35 - R() * 0.2, sag = 0.02 + R() * 0.02, r = k < 2 ? 0.03 : 0.02 + R() * 0.015;
      const ox = (R() - 0.5) * 0.5, oz = (R() - 0.5) * 0.5;
      const pts = catenary([p.x + ox, ya, p.z + oz], [q.x + ox, yb, q.z + oz], sag, r);
      cables.push({ a: [p.x, ya, p.z], b: [q.x, yb, q.z], low: Math.min(...pts.map((v) => v[1])) });
    }
  }

  // ---------------- merge per material, collider
  const merged = {};
  for (const [k, a] of Object.entries(acc)) { const g = a.geometry(); if (g) merged[k] = g; }
  const posOnly = (g) => { const h = new THREE.BufferGeometry(); h.setAttribute('position', g.getAttribute('position')); return h; };
  const colKeys = Object.keys(merged).filter((k) => !noCol.has(k)), colRanges = [];
  { let t = 0; for (const k of colKeys) { const n = merged[k].getAttribute('position').count / 3; colRanges.push({ key: k, tri0: t, tris: n }); t += n; } }
  const colGeo = mergeGeometries(colKeys.map((k) => posOnly(merged[k])), false);
  const bvh = new MeshBVH(colGeo, { maxLeafTris: 5 });
  // a BVH face index -> the material it came from (the BVH reorders the index, so go through it)
  const colKeyOf = (face) => { const ix = colGeo.index, tri = ix ? Math.floor(ix.getX(face * 3) / 3) : face; return colRanges.find((r) => tri >= r.tri0 && tri < r.tri0 + r.tris)?.key; };
  // skim: everything but the ground layers (a low pass down the street is a move, not a farm)
  const skimParts = Object.entries(merged).filter(([k]) => !noCol.has(k) && !['walk', 'road', 'plaza'].includes(k)).map(([, g]) => posOnly(g));
  const skimBvh = new MeshBVH(mergeGeometries(skimParts, false), { maxLeafTris: 5 });
  let tris = 0; for (const g of Object.values(merged)) tris += g.getAttribute('position').count / 3;
  facts.tris = tris; facts.colTris = colGeo.getAttribute('position').count / 3; facts.ms = Date.now() - t0;

  const L = lineData || {};
  const v3 = (p) => p;
  return {
    merged, colGeo, colRanges, colKeyOf, bvh, skimBvh, emitters, facts, lotInfo, poles, cables, layout,
    lines: L.lines || [], funnels: L.funnels || [],
    startPoints: (L.startPoints || []).map(v3), takeStart: L.takeStart || null,
    spawn: layout.spawn,
  };
}

// ---- materials (browser)
function emissivePatch(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aEm;\nvarying vec3 vEm;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvEm = aEm;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vEm;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEm;');
  };
  mat.customProgramCacheKey = () => 'seoul:em';
  return mat;
}
function makeMaterials(renderer, texLoader) {
  const mats = {}, pending = [];
  const aniso = renderer?.capabilities?.getMaxAnisotropy?.() || 1;
  for (const [k, m] of Object.entries(SEOUL_MATS)) {
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...m.color), roughness: m.rough ?? 0.8, metalness: m.metal || 0 });
    if (m.id && texLoader) for (const map of m.maps) {
      const url = `${PH}/Textures/jpg/1k/${m.id}/${m.id}_${map}_1k.jpg`;
      pending.push(new Promise((res) => texLoader.load(url, (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / m.tile, 1 / m.tile); t.anisotropy = Math.min(8, aniso);
        if (map === 'diff') { t.colorSpace = THREE.SRGBColorSpace; mat.map = t; } else { mat.normalMap = t; mat.normalScale.set(1, 1); }
        mat.needsUpdate = true; res();
      }, undefined, () => { console.warn('seoul texture failed', url); res(); })));
    }
    if (m.emissive) { mat.emissive = new THREE.Color(0, 0, 0); emissivePatch(mat); }
    if (['stripe', 'yellow'].includes(k)) { mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2; }
    if (k === 'glass' || k === 'shop') { mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1; }
    mat.name = 'seoul:' + k; mats[k] = mat;
  }
  return { mats, ready: Promise.all(pending) };
}

// ---- data loading (browser: fetch next to this module; node: fs)
export async function loadSeoulJSON(name) {
  const url = new URL(name, import.meta.url);
  if (IS_NODE) { const fs = await import('node:fs'); const { fileURLToPath } = await import('node:url'); const p = fileURLToPath(url); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch (e) { return null; }
}
async function tryModule(path, name) {
  try { const m = await import(path); return m[name] || m.default || (typeof m.build === 'function' || typeof m.attach === 'function' ? m : null); }
  catch (e) { if (!/Failed to fetch|Cannot find|not found|404|Importing a module script failed|error loading dynamically/i.test(String(e?.message || e))) console.warn(path, e); return null; }
}

// ================================================================================================================
// buildSeoul(renderer, [scene], opts) — contract L2
// ================================================================================================================
export async function buildSeoul(renderer, a, b) {
  const scene = a && a.isScene ? a : new THREE.Scene();
  const opts = (a && a.isScene ? b : a) || {};
  const prog = (f, t) => opts.onProgress?.(f, t);
  const T0 = (globalThis.performance || Date).now();
  prog(0.05, 'Hongdae: survey');
  const layout = opts.layout || (await loadSeoulJSON('./seoul/layout.json')) || (await loadSeoulJSON('./seoul/layout.provisional.json'));
  if (!layout) throw new Error('seoul/layout.json missing');
  const lineData = opts.lines || (await loadSeoulJSON('./seoul/lines.json'));
  prog(0.15, 'Hongdae: buildings');
  const geo = buildSeoulGeometry(layout, { lineData, seed: opts.seed ?? 11 });
  prog(0.55, 'Hongdae: materials');
  const texLoader = IS_NODE ? null : new THREE.TextureLoader();
  const { mats, ready } = makeMaterials(renderer, texLoader);
  for (const [k, g] of Object.entries(geo.merged)) {
    const mesh = new THREE.Mesh(g, mats[k] || mats.concrete); mesh.name = 'seoul:' + k; mesh.matrixAutoUpdate = false; mesh.receiveShadow = true; scene.add(mesh);
  }
  // night sky: light-polluted, ~0.03 cd/m2 overhead (L5), brown-orange at the horizon is S3's dome; this is the floor
  scene.background = new THREE.Color(0.030 * 1.3, 0.030, 0.030 * 1.15).multiplyScalar(NIT * 1.0);
  // base light (S3 replaces it: scene.userData.seoul.baseLight): city sky glow + the average spill of the street,
  // ~6 lux on the ground (lit Seoul streets measure 10-50 lux under lamps, 1-5 lux in back alleys)
  const baseLight = new THREE.HemisphereLight(new THREE.Color(0.75, 0.8, 1.0), new THREE.Color(1.0, 0.75, 0.55), 6 * LUX);
  baseLight.name = 'seoul:base'; if (opts.baseLight !== false) scene.add(baseLight);
  const emitters = geo.emitters.slice();
  const uniforms = { uTime: { value: 0 } };
  const ctx = { THREE, renderer, scene, layout, NIT, NITS, nitScale: NITS, LUX, rng, hash, seed: opts.seed ?? 11, quality: opts.quality || 'auto', bvh: geo.bvh, lotInfo: geo.lotInfo, poles: geo.poles, cables: geo.cables, uniforms,
    streetById: new Map(layout.streets.map((s) => [s.id, s])), lotById: new Map(layout.lots.map((l) => [l.id, l])), takeClock: opts.takeClock || null };
  // partner modules (each optional)
  prog(0.65, 'Hongdae: signs');
  const parts = {};
  const signsMod = opts.signs === false ? null : await tryModule('./seoul-signs.js', 'seoulSigns');
  if (signsMod?.build) { try { parts.signs = await signsMod.build(layout, ctx); if (parts.signs?.group) scene.add(parts.signs.group); emitters.push(...(parts.signs?.emitters || [])); } catch (e) { console.warn('seoulSigns.build', e); } }
  prog(0.75, 'Hongdae: life');
  const lifeMod = opts.life === false ? null : await tryModule('./seoul-life.js', 'seoulLife');
  if (lifeMod?.build) { try { parts.life = await lifeMod.build(layout, ctx); if (parts.life?.group) scene.add(parts.life.group); emitters.push(...(parts.life?.emitters || [])); } catch (e) { console.warn('seoulLife.build', e); } }
  await Promise.race([ready, new Promise((r) => setTimeout(r, 8000))]);

  const depthScene = new THREE.Scene(); depthScene.name = 'depthScene';   // C2: no alpha-tested extras in Seoul (yet)
  const colScene = new THREE.Scene(); { const cm = new THREE.Mesh(geo.colGeo, new THREE.MeshBasicMaterial()); cm.frustumCulled = false; colScene.add(cm); }
  const B = boxOf(layout);
  const sp = geo.takeStart || layout.spawn || { pos: [0, 6, 0], yaw: 0 };   // the first start point (the walking street) when lines exist
  const stats = { ...geo.facts, ms: { geometry: geo.facts.ms, total: 0 }, emitters: emitters.length };
  const update = (camPos, dt = 1 / 60, camQuat) => {
    uniforms.uTime.value += dt || 0;
    const t = ctx.takeClock ? ctx.takeClock() : uniforms.uTime.value;
    parts.signs?.update?.(t, camPos, camQuat); parts.life?.update?.(t, camPos, camQuat); parts.light?.update?.(t, camPos, camQuat);
  };
  const world = {
    scene, colliderScene: colScene, depthScene, bvh: geo.bvh, skimBvh: geo.skimBvh, update, hdr: true, stats,
    spawn: new THREE.Vector3(...sp.pos), yaw: sp.yaw,
    takeStart: geo.takeStart ? { pos: new THREE.Vector3(...geo.takeStart.pos), yaw: geo.takeStart.yaw } : { pos: new THREE.Vector3(...sp.pos), yaw: sp.yaw },
    startPoints: geo.startPoints.map((s) => ({ name: s.name, pos: new THREE.Vector3(...s.pos), yaw: s.yaw, ...(s.hint ? { hint: s.hint } : {}) })),
    funnels: geo.funnels, lines: geo.lines,
    bounds: new THREE.Box3(new THREE.Vector3(B.x0 - 60, -5, B.z0 - 60), new THREE.Vector3(B.x1 + 60, 200, B.z1 + 60)),
    envelope: { min: new THREE.Vector3(B.x0 - 30, -2, B.z0 - 30), max: new THREE.Vector3(B.x1 + 30, 160, B.z1 + 30) },
    aoUniforms: { uAO: { value: null }, uAOOn: { value: 0 }, uAOScale: { value: new THREE.Vector2(1, 1) } },
    rebakeShadows: () => {}, grassAt: null,
    look: 'night', sky: 'night', layout, emitters, parts, audio: parts.life?.audio || null,   // [integ6] S4 city sound (main.js attaches it)
    NIT, NITS, nitScale: NITS, LUX,
  };
  scene.userData.seoul = { baseLight, emitters, parts, NIT, NITS, nitScale: NITS, LUX, stats, lotInfo: geo.lotInfo };
  scene.userData.depthScene = depthScene; scene.userData.aoUniforms = world.aoUniforms;
  prog(0.9, 'Hongdae: light');
  const lightMod = opts.light === false ? null : await tryModule('./seoul-light.js', 'seoulLight');
  if (lightMod?.attach) { try { parts.light = await lightMod.attach(world, emitters, ctx); } catch (e) { console.warn('seoulLight.attach', e); } }
  update(world.spawn, 0);
  stats.ms.total = Math.round((globalThis.performance || Date).now() - T0);
  globalThis.__seoulStats = stats;
  prog(0.98, 'Ready');
  return world;
}
