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
import { buildInteriorAtlas, ROOM, FRONT, ATLAS } from './seoul-interiors.js';

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
  tile: { grime: 1, id: 'concrete_tile_facade', tile: 3.0, maps: ['diff', 'nor_gl'], color: [1.0, 0.98, 0.95], rough: 0.6, albedo: [0.40, 0.38, 0.35] },   // beige/white facade tile
  brick: { grime: 1, id: 'brown_brick_02', tile: 2.2, maps: ['diff', 'nor_gl'], color: [1.0, 0.95, 0.95], rough: 0.85, albedo: [0.26, 0.15, 0.12] },     // Hongdae's red-brown brick
  plaster: { grime: 1, id: 'beige_wall_001', tile: 3.0, maps: ['diff', 'nor_gl'], color: [0.95, 0.95, 0.95], rough: 0.9, albedo: [0.45, 0.42, 0.38] },
  concrete: { grime: 1, id: 'concrete_wall_008', tile: 3.0, maps: ['diff', 'nor_gl'], color: [0.9, 0.9, 0.9], rough: 0.9, albedo: [0.30, 0.29, 0.27] },
  roof: { grime: 1, id: 'concrete_floor_02', tile: 4.0, maps: ['diff', 'nor_gl'], color: [0.55, 0.75, 0.6], rough: 0.8, albedo: [0.17, 0.22, 0.18] },   // green roof paint (T5)
  metal: { grime: 1, id: 'blue_metal_plate', tile: 2.0, maps: ['diff'], color: [0.6, 0.62, 0.65], rough: 0.5, metal: 0.4, albedo: [0.20, 0.21, 0.22] },
  shutter: { grime: 1, id: 'blue_metal_plate', tile: 1.2, maps: ['diff', 'nor_gl'], color: [0.75, 0.75, 0.78], rough: 0.45, metal: 0.5, albedo: [0.24, 0.24, 0.25] },
  white: { color: [0.42, 0.42, 0.40], rough: 0.6, albedo: [0.42, 0.42, 0.40], grime: 1 },          // AC units, tanks (ivory-grey enamel under grime)
  // [P2-C] the sign bed: aluminium composite panel above the shop glass, charcoal / grey / dull white per lot (vertex colour);
  // phase 1's 32 cm white slab showed round S2's boxes as pale plates
  fascia: { color: [1, 1, 1], rough: 0.5, metal: 0.25, albedo: [0.12, 0.12, 0.125], grime: 1 },
  frame: { color: [0.07, 0.072, 0.078], rough: 0.38, metal: 0.6, albedo: [0.07, 0.072, 0.078] },   // anodised mullions, door frames
  sill: { id: 'concrete_wall_008', tile: 3.0, maps: ['diff'], color: [0.8, 0.8, 0.78], rough: 0.85, albedo: [0.28, 0.27, 0.25] },    // window sills (render only)
  ao: { decal: 'multiply', color: [1, 1, 1], albedo: [1, 1, 1] },   // contact darkening + leak streaks: dst *= vertex colour (render only)
  dark: { color: [0.035, 0.035, 0.04], rough: 0.45, albedo: [0.035, 0.035, 0.04] },        // cables, pole hardware
  pole: { color: [0.32, 0.31, 0.3], rough: 0.85, albedo: [0.32, 0.31, 0.30] },
  stripe: { color: [0.75, 0.75, 0.72], rough: 0.6, albedo: [0.75, 0.75, 0.72] },
  yellow: { color: [0.7, 0.5, 0.06], rough: 0.6, albedo: [0.7, 0.5, 0.06] },
  glass: { color: [0.02, 0.022, 0.026], rough: 0.06, metal: 0.0, emissive: true, interior: true, albedo: [0.02, 0.022, 0.026] },   // windows: interior-mapped rooms (seoul-interiors.js)
  shop: { color: [0.02, 0.02, 0.022], rough: 0.05, emissive: true, interior: true, albedo: [0.03, 0.03, 0.03] },                   // shopfront bays, doors, posters
  lamp: { color: [0.05, 0.05, 0.05], rough: 0.5, emissive: true, albedo: [0.05, 0.05, 0.05] },                     // street-light heads
};
// [P2-C] what each lot's use looks like at street level at ~01:00. Binding luminance (PLAN-P2): shop interiors seen
// through glass 30-130 cd/m2 (mean, as the camera sees them); `nits` is that mean, `cct` the lamp colour (K) or `rgb` a
// coloured interior, `room` the interior-atlas tile, `front` a front layer and its chance, `shut` the shutter chance.
const USE_LOOK = {
  club: { nits: [30, 40], rgb: [1.0, 0.42, 0.9], room: [3, 4], shut: 0.15 }, bar: { nits: [30, 45], cct: 2700, room: [3], shut: 0.1 },
  pocha: { nits: [55, 80], cct: 3000, room: [2], front: [4, 0.7], shut: 0.05 }, restaurant: { nits: [50, 75], cct: 3200, room: [2, 1], front: [6, 0.2], shut: 0.25 },
  cafe: { nits: [45, 70], cct: 2900, room: [1], shut: 0.35 }, shop: { nits: [70, 110], cct: 4500, room: [5, 6, 5], shut: 0.45 },
  conv: { nits: [110, 130], cct: 6000, room: [0], shut: 0 }, karaoke: { nits: [35, 50], rgb: [0.85, 0.6, 1.0], room: [4], shut: 0.05 },
  pc: { nits: [45, 60], cct: 5600, room: [7], shut: 0.05 }, motel: { nits: [35, 45], rgb: [1.0, 0.62, 0.7], room: [4], shut: 0.1 },
  office: { nits: [40, 60], cct: 5000, room: [8], shut: 0.8 }, hotel: { nits: [50, 70], cct: 3000, room: [1], shut: 0.1 },
};
// upper-floor tenants (2F and up) by street kind, and the interior + luminance a lit floor shows (lit windows: 5-25 nits)
const UPPER = { walking: { bar: 3, karaoke: 2, cafe: 3, pc: 1, office: 1, home: 1, restaurant: 2 }, club: { bar: 4, karaoke: 2, pc: 1, home: 2, cafe: 1, restaurant: 1, motel: 1 },
  main: { office: 4, cafe: 2, pc: 1, karaoke: 1, bar: 1, restaurant: 1, home: 1 }, alley: { home: 5, office: 2, bar: 1, cafe: 1, karaoke: 1, study: 1 } };
const TENANT = { bar: { room: [3], nits: [6, 12], cct: 2700 }, karaoke: { room: [4], nits: [8, 14], rgb: [0.85, 0.6, 1.0] }, cafe: { room: [1], nits: [12, 20], cct: 3000 },
  pc: { room: [13, 7], nits: [6, 12], cct: 6000 }, office: { room: [8], nits: [15, 25], cct: 5000 }, home: { room: [12, 13, 11, 12], nits: [5, 12], cct: 2800 },
  study: { room: [11], nits: [8, 16], cct: 3500 }, restaurant: { room: [2], nits: [12, 20], cct: 3200 }, motel: { room: [12], nits: [6, 10], rgb: [1.0, 0.7, 0.75] },
  hotel: { room: [12], nits: [8, 14], cct: 3000 } };
// a black body's colour, normalised to luminance 1 (Tanner Helland's fit; 2700-6500 K is all we use)
export function cctRGB(K) {
  const t = K / 100; let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708 * Math.log(t) - 161.1196; b = t <= 19 ? 0 : 138.5177 * Math.log(t - 10) - 305.0448; }
  else { r = 329.6987 * Math.pow(t - 60, -0.1332); g = 288.1222 * Math.pow(t - 60, -0.0755); b = 255; }
  const lin = (v) => { v = Math.max(0, Math.min(255, v)) / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const c = [lin(r), lin(g), lin(b)], Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return c.map((v) => v / Y);
}
const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const colourOf = (o, u) => o.rgb ? o.rgb.map((v) => v / lumOf(o.rgb)) : cctRGB(o.cct + (u - 0.5) * 500);
const K = { band: 0.12, fascia: [2.9, 1.1, 0.08], shopTop: 2.9, parapet: 0.9, poleH: 10.0, poleR: 0.17, poleStep: 26, cableR: 0.022 };

// ---- seeded helpers (no Math.random anywhere: geometry is part of the replay hash)
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
function rng(seed) { let s = (typeof seed === 'number' ? seed : Math.floor(hash(seed) * 4294967296)) >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const lerp = (a, b, t) => a + (b - a) * t;
const draw = (w, r) => { let tot = 0; for (const v of Object.values(w)) tot += v; let x = r * tot; for (const [k, v] of Object.entries(w)) if ((x -= v) < 0) return k; return Object.keys(w)[0]; };

// ---- geometry accumulator: non-indexed triangles per material key
// [P2-C] emissive accs carry aEm (vec4: rgb radiance, w = interior code: room + 32 x front layer + seed fraction) and aWin
// (vec4: pane width, height, kind x 4 + sill, room depth) for the interior-mapping glass; the others carry vertex colour
// (per-lot tint, age and baked contact darkening: `Acc.tint`, or per-corner colours through quadC).
const WHITE = [1, 1, 1];
class Acc {
  constructor(em) { this.p = []; this.n = []; this.uv = []; this.e = em ? [] : null; this.w = em ? [] : null; this.c = em ? null : []; }
  tri(a, b, c, ua, ub, uc, em, ca, cb, cc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz); this.uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    if (this.e) { const v = em || EM0, w = v[3] || 0, q = Acc.win; this.e.push(v[0], v[1], v[2], w, v[0], v[1], v[2], w, v[0], v[1], v[2], w); this.w.push(q[0], q[1], q[2], q[3], q[0], q[1], q[2], q[3], q[0], q[1], q[2], q[3]); }
    if (this.c) { const t = Acc.tint; const A = ca || t, B = cb || t, C = cc || t; this.c.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]); }
  }
  // quad p0..p3 (a loop), facing `nrm` (winding fixed to match), uv per corner
  quad(p0, p1, p2, p3, nrm, uvs = [[0, 0], [1, 0], [1, 1], [0, 1]], em) { this.quadC(p0, p1, p2, p3, nrm, uvs, em, null); }
  quadC(p0, p1, p2, p3, nrm, uvs = [[0, 0], [1, 0], [1, 1], [0, 1]], em, cols) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, k = cols || [];
    if (cx * nrm[0] + cy * nrm[1] + cz * nrm[2] >= 0) { this.tri(p0, p1, p2, uvs[0], uvs[1], uvs[2], em, k[0], k[1], k[2]); this.tri(p0, p2, p3, uvs[0], uvs[2], uvs[3], em, k[0], k[2], k[3]); }
    else { this.tri(p0, p2, p1, uvs[0], uvs[2], uvs[1], em, k[0], k[2], k[1]); this.tri(p0, p3, p2, uvs[0], uvs[3], uvs[2], em, k[0], k[3], k[2]); }
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
    if (this.e) { g.setAttribute('aEm', new THREE.Float32BufferAttribute(this.e, 4)); g.setAttribute('aWin', new THREE.Float32BufferAttribute(this.w, 4)); }
    if (this.c) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

const EM0 = [0, 0, 0, 0];
Acc.tint = WHITE; Acc.win = [0, 0, 0, 0];

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
export const SEOUL_SEED = 11;
export function buildSeoulGeometry(layout, opts = {}) {
  const { lineData = null, seed = SEOUL_SEED } = opts;
  const t0 = Date.now();
  const acc = {}; const A = (k) => (acc[k] ||= new Acc(!!SEOUL_MATS[k]?.emissive));
  // flush decals and sub-10 cm trim: render only (their wall / ground is in the collider)
  const noCol = new Set(['stripe', 'yellow', 'glass', 'shop', 'sill', 'ao', 'frame']);
  const emitters = [], facts = { lots: layout.lots.length, windowsLit: 0, windows: 0, winNits: 0, shopsLit: 0, shutters: 0, ac: 0, tanks: 0, poles: 0, cableSpans: 0, streetLights: 0 };
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
  // [P2-C] Facades are built per lot from a rhythm (typology, bay, glass ratio, sill height), with whole-floor tenants (a lit
  // floor is one bar, office or flat, so floors light together, not as a checkerboard), interior-mapped panes (a room behind
  // each pane, reveal and mullions in-shader), sills and leak streaks, a charcoal sign bed, shopfront bays with a framed door,
  // posters and a vinyl curtain on pochas. Per-lot tint and age and the contact darkening at the ground are vertex colour and
  // multiply decals ('ao'). Lit share (PLAN-P2): 2F-4F on commercial streets 55 %, 5F and up 12-20 %; lit 5-25 nits.
  const facadeOf = (l) => { const r = hash(l.id + 'f'); if (l.floors >= 9) return r < 0.6 ? 'tile' : 'concrete'; return r < 0.38 ? 'brick' : r < 0.75 ? 'tile' : r < 0.9 ? 'plaster' : 'concrete'; };
  const lotInfo = new Map();
  const streetDist = (x, z) => { let d = Infinity; for (const s of streets) for (let i = 0; i < s.points.length - 1; i++) d = Math.min(d, segD(x, z, s.points[i][0], s.points[i][1], s.points[i + 1][0], s.points[i + 1][1]) - s.width / 2); return d; };
  const WIN0 = [0, 0, 0, 0];
  // a vertical pane centred on (c x, c z) along t, facing n, from y0 to y0 + h (uv 0..1 across it)
  const pane = (key, c, t, n, w, h, y0, em, win) => {
    Acc.win = win;
    A(key).quad([c[0] - t[0] * w / 2, y0, c[1] - t[1] * w / 2], [c[0] + t[0] * w / 2, y0, c[1] + t[1] * w / 2], [c[0] + t[0] * w / 2, y0 + h, c[1] + t[1] * w / 2], [c[0] - t[0] * w / 2, y0 + h, c[1] - t[1] * w / 2], [n[0], 0, n[1]], undefined, em);
    Acc.win = WIN0;
  };
  // a multiply decal on a wall (x along t from s0 to s1, y0..y1, `top`/`bot` darkening), 1.5 cm proud
  const wallDecal = (a, t, n, s0, s1, y0, y1, top, bot) => {
    const P = (s, y) => [a[0] + t[0] * s + n[0] * 0.015, y, a[1] + t[1] * s + n[1] * 0.015];
    A('ao').quadC(P(s0, y0), P(s1, y0), P(s1, y1), P(s0, y1), [n[0], 0, n[1]], undefined, undefined, [[bot, bot, bot], [bot, bot, bot], [top, top, top], [top, top, top]]);
  };
  const emOf = (o, nits, cu, code) => { const c = colourOf(o, cu); return [c[0] * nits * NIT, c[1] * nits * NIT, c[2] * nits * NIT, code]; };
  const SPILL = { cct: 4000 };   // an unlit room: street spill and stand-by LEDs, neutral
  for (const l of lots) {
    const R = rng(l.id), P = l.footprint, H = l.floors * l.floorH, fmat = facadeOf(l);
    const [fa, fb] = l.frontage;
    const skind = streetById.get(l.street)?.kind || 'alley', comm = skind !== 'alley';
    const info = { id: l.id, H, facade: fmat, shopLit: false, shutter: false, fascia: null, edges: [], floors: [], windows: [] };
    lotInfo.set(l.id, info);
    // per-lot tint and age (vertex colour multiplies the scan texture): +-10 % value, a warm/cool cast, grime with age
    const age = hash(l.id + 'age'), tv = 0.9 + hash(l.id + 'tv') * 0.2, cast = (hash(l.id + 'tc') - 0.5) * 0.1;
    const tint = [tv * (1 - age * 0.2) * (1 + cast), tv * (1 - age * 0.22), tv * (1 - age * 0.25) * (1 - cast)], dim = (k) => tint.map((v) => v * k);
    // facade rhythm
    const typ = l.floors >= 8 ? (R() < 0.5 ? 'curtain' : 'punched') : comm && l.floors <= 7 && R() < 0.45 ? 'ribbon' : !comm && l.floors >= 3 && R() < 0.4 ? 'villa' : 'punched';
    const rh = { bay: typ === 'villa' ? 2.6 + R() * 1.0 : 2.4 + R() * 1.7, ratio: 0.42 + R() * 0.38, h: 1.15 + R() * 0.65, sill: 0.75 + R() * 0.25, paneW: 1.5 + R() * 1.1,
      ribbonTop: 1 + Math.floor(R() * 3), bands: R() < 0.55, depth: 3.5 + R() * 2.5 };
    // tenants: one per upper floor; lit floors are whole floors
    const pLow = comm ? 0.55 : 0.42, pHigh = Math.max(0.08, (l.use === 'hotel' ? 0.35 : 0.16) + (hash(l.id + 'ph') - 0.5) * 0.08);
    for (let f = 1; f < l.floors; f++) { let use = draw(UPPER[skind] || UPPER.alley, R()); if (l.use === 'hotel' || l.use === 'motel') use = l.use; info.floors[f] = { f, lit: R() < (f <= 3 ? pLow : pHigh), use }; }
    // walls + parapet
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz); if (L < 0.05) continue;
      const tx = dx / L, tz = dz / L, nx = tz, nz = -tx, mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, t2 = [tx, tz], n2 = [nx, nz], yaw = Math.atan2(-tz, tx);
      const Ht = H + K.parapet, us = hash(l.id + i) * 7;
      // exposure: is the space 1.5 m in front of this wall open (a street or a gap), at its middle and quarter points?
      const open = [0.25, 0.5, 0.75].filter((t) => !grid.inside(a[0] + dx * t + nx * 1.5, a[1] + dz * t + nz * 1.5, l)).length >= 2;
      // a wall facing a gap under 3.2 m (the slot between two buildings): windows, but no AC units or lips in the slot
      const slot = open && [0.25, 0.5, 0.75].filter((t) => grid.inside(a[0] + dx * t + nx * 3.2, a[1] + dz * t + nz * 3.2, l)).length >= 2;
      const front = (Math.hypot(a[0] - fa[0], a[1] - fa[1]) < 0.05 && Math.hypot(b[0] - fb[0], b[1] - fb[1]) < 0.05);
      const streetSide = !front && open && !slot && streetDist(mx + nx * 2, mz + nz * 2) < 1.0;   // a corner lot's second street face
      info.edges.push({ a, b, L, tx, tz, nx, nz, open, front, streetSide });
      Acc.tint = tint;
      if (open || front) {   // the bottom 1.1 m darkens toward the ground (splash, grime, contact)
        const yb = Math.min(1.1, Ht), c0 = dim(0.6);
        A(fmat).quadC([a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], yb, b[1]], [a[0], yb, a[1]], [nx, 0, nz], [[us, 0], [us + L, 0], [us + L, yb], [us, yb]], undefined, [c0, c0, tint, tint]);
        A(fmat).quad([a[0], yb, a[1]], [b[0], yb, b[1]], [b[0], Ht, b[1]], [a[0], Ht, a[1]], [nx, 0, nz], [[us, yb], [us + L, yb], [us + L, Ht], [us, Ht]]);
        // ground contact: a 0.55 m multiply strip at the wall's foot
        const o = 0.55, g = 0.03, k0 = [0.5, 0.5, 0.5];
        A('ao').quadC([a[0], g, a[1]], [b[0], g, b[1]], [b[0] + nx * o, g, b[1] + nz * o], [a[0] + nx * o, g, a[1] + nz * o], [0, 1, 0], undefined, undefined, [k0, k0, WHITE, WHITE]);
      } else A(fmat).quad([a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], Ht, b[1]], [a[0], Ht, a[1]], [nx, 0, nz], [[us, 0], [us + L, 0], [us + L, Ht], [us, Ht]]);
      // parapet inner face and coping
      const ia = [a[0] - nx * 0.2, a[1] - nz * 0.2], ib = [b[0] - nx * 0.2, b[1] - nz * 0.2];
      A('concrete').quad([ib[0], H, ib[1]], [ia[0], H, ia[1]], [ia[0], Ht, ia[1]], [ib[0], Ht, ib[1]], [-nx, 0, -nz], [[0, 0], [L, 0], [L, K.parapet], [0, K.parapet]]);
      A('concrete').quad([a[0], Ht, a[1]], [b[0], Ht, b[1]], [ib[0], Ht, ib[1]], [ia[0], Ht, ia[1]], [0, 1, 0], [[0, 0], [L, 0], [L, 0.2], [0, 0.2]]);
      if (!open && !front) { Acc.tint = WHITE; continue; }
      // floor bands on exposed walls of about half the lots (they collide: a 12 cm lip, a real thing to clip)
      if (!slot && rh.bands) for (let f = 1; f < l.floors; f++) {
        const y = f * l.floorH, o = K.band, a0 = [a[0] + nx * o, a[1] + nz * o], b0 = [b[0] + nx * o, b[1] + nz * o];
        A('concrete').quad([a0[0], y - 0.1, a0[1]], [b0[0], y - 0.1, b0[1]], [b0[0], y + 0.1, b0[1]], [a0[0], y + 0.1, a0[1]], [nx, 0, nz], [[0, 0], [L, 0], [L, 0.2], [0, 0.2]]);
        A('concrete').quad([a[0], y + 0.1, a[1]], [b[0], y + 0.1, b[1]], [b0[0], y + 0.1, b0[1]], [a0[0], y + 0.1, a0[1]], [0, 1, 0], [[0, 0], [L, 0], [L, o], [0, o]]);
        A('concrete').quad([a[0], y - 0.1, a[1]], [b[0], y - 0.1, b[1]], [b0[0], y - 0.1, b0[1]], [a0[0], y - 0.1, a0[1]], [0, -1, 0], [[0, 0], [L, 0], [L, o], [0, o]]);
      }
      // ---- window layout for this wall
      const wins = [];
      if (front || streetSide) {
        for (let f = 1; f < l.floors; f++) {
          const fy = f * l.floorH;
          if (typ === 'curtain') { const n = Math.max(1, Math.round((L - 0.4) / 1.5)), pw = (L - 0.4) / n; for (let k = 0; k < n; k++) wins.push({ f, s: 0.2 + (k + 0.5) * pw, w: pw - 0.08, h: l.floorH - 0.95, y0: fy + 0.1 }); }
          else if (typ === 'ribbon' && f <= rh.ribbonTop) { const n = Math.max(1, Math.round((L - 0.8) / rh.paneW)), pw = (L - 0.8) / n; for (let k = 0; k < n; k++) wins.push({ f, s: 0.4 + (k + 0.5) * pw, w: pw - 0.1, h: l.floorH - 0.85, y0: fy + 0.35 }); }
          else {
            const bays = Math.max(1, Math.floor((L - 0.6) / rh.bay)), bw = Math.min(typ === 'villa' ? 1.4 : 2.2, ((L - 0.6) / bays) * rh.ratio), h = Math.min(typ === 'villa' ? 1.25 : rh.h, l.floorH - rh.sill - 0.3);
            if (bw < 0.5) continue;
            for (let k = 0; k < bays; k++) { if (typ === 'villa' && R() < 0.15) continue; wins.push({ f, s: 0.3 + (k + 0.5) * ((L - 0.6) / bays), w: bw, h, y0: fy + rh.sill, sill: true }); }
          }
        }
      } else if (L > 2.5) {   // side and back walls facing a gap: a stair column and sparse service windows, never a grid
        let sStair = -9;
        if (L > 5 && l.floors >= 3 && R() < 0.55) { sStair = L * (0.2 + R() * 0.6); for (let f = 0; f < l.floors - 1; f++) wins.push({ f, s: sStair, w: 0.8, h: 1.0, y0: f * l.floorH + l.floorH * 0.5 + 0.4, stair: true }); }
        for (let f = 1; f < l.floors; f++) for (let k = 0; k < Math.max(1, Math.floor(L / 5)); k++) {
          if (R() > 0.42) continue; const w = 0.6 + R() * 0.5, s0 = 0.6 + w / 2 + R() * Math.max(0, L - 1.2 - w);
          if (Math.abs(s0 - sStair) < 1.3 || wins.some((q) => q.f === f && Math.abs(q.s - s0) < (q.w + w) / 2 + 0.4)) continue;
          wins.push({ f, s: s0, w, h: 0.7 + R() * 0.45, y0: f * l.floorH + 1.05, small: true });
        }
      }
      for (const W of wins) {
        if (W.s - W.w / 2 < 0.15 || W.s + W.w / 2 > L - 0.15) continue;
        const cx = a[0] + tx * W.s + nx * 0.03, cz = a[1] + tz * W.s + nz * 0.03, T = info.floors[W.f];
        let lit, o, room, fr = 0;
        if (W.stair) { lit = R() < 0.6; o = { nits: [8, 15], cct: 6000 }; room = ROOM.stair; }
        else if (W.small) { lit = R() < 0.3; o = TENANT.home; room = R() < 0.5 ? ROOM.home : ROOM.study; if (R() < 0.5) fr = FRONT.frosted; }
        else {
          o = TENANT[T?.use] || TENANT.home; room = o.room[Math.floor(R() * o.room.length)]; lit = !!T?.lit;
          const r = R();
          if (lit && r < 0.15) fr = FRONT.blinds;                                       // a lit floor with this blind down
          else if (o === TENANT.home) fr = r < 0.5 ? FRONT.curtain : r < 0.65 ? FRONT.blinds : 0;
          else if (o === TENANT.office) fr = r < 0.35 ? FRONT.blinds : 0;
          else if (!lit) fr = r < 0.3 ? FRONT.blinds : r < 0.45 ? FRONT.curtain : 0;
        }
        const u = R(), nits = lit ? lerp(o.nits[0], o.nits[1], u) : 0.5 + u * 1.3;
        const em = emOf(lit ? o : SPILL, nits, R(), room + 32 * fr + Math.min(0.999, R()));
        facts.windows++; if (lit) facts.windowsLit++; facts.winNits += nits;
        const sillLocal = Math.max(0.05, Math.min(1.6, W.y0 - W.f * l.floorH - (W.stair ? l.floorH * 0.5 : 0)));
        pane('glass', [cx, cz], t2, n2, W.w, W.h, W.y0, em, [W.w, W.h, sillLocal, W.stair ? 2.5 : rh.depth + u]);
        if (front || streetSide) info.windows.push({ f: W.f, c: [+cx.toFixed(2), +(W.y0 + W.h / 2).toFixed(2), +cz.toFixed(2)], n: [nx, 0, nz], t: [tx, 0, tz], w: +W.w.toFixed(2), h: +W.h.toFixed(2), lit, nits: +nits.toFixed(1) });
        // sill (render only) and, on older buildings, a leak streak from one end of it
        if (W.sill && !W.stair) {
          { const hw = W.w / 2 + 0.06, y1 = W.y0 - 0.005, y0 = W.y0 - 0.075, o = 0.09, Q = (s, y, d) => [a[0] + tx * (W.s + s) + nx * d, y, a[1] + tz * (W.s + s) + nz * d];
            A('sill').quad(Q(-hw, y1, 0), Q(hw, y1, 0), Q(hw, y1, o), Q(-hw, y1, o), [0, 1, 0], [[0, 0], [2 * hw, 0], [2 * hw, o], [0, o]]);
            A('sill').quad(Q(-hw, y0, o), Q(hw, y0, o), Q(hw, y1, o), Q(-hw, y1, o), [nx, 0, nz], [[0, 0], [2 * hw, 0], [2 * hw, 0.07], [0, 0.07]]);
            A('sill').quad(Q(-hw, y0, 0), Q(hw, y0, 0), Q(hw, y0, o), Q(-hw, y0, o), [0, -1, 0], [[0, 0], [2 * hw, 0], [2 * hw, o], [0, o]]); }
          if (age > 0.45 && R() < 0.4) { const side = R() < 0.5 ? -1 : 1, s = W.s + side * (W.w / 2 - 0.05), ww = 0.15 + R() * 0.25, len = 0.8 + R() * 1.6;
            wallDecal(a, t2, n2, s - ww / 2, s + ww / 2, Math.max(0.2, W.y0 - 0.07 - len), W.y0 - 0.07, 0.72 - age * 0.12, 1.0); }
        }
        // AC units: side and back walls by a window, or high on older fronts (the real Seoul pattern), with a rust streak
        if (W.f >= 1 && !slot && !W.stair && R() < (front || streetSide ? (age > 0.4 ? 0.1 : 0.03) : 0.3)) {
          facts.ac++; const sa = W.s + (W.w / 2 + 0.55) * (R() < 0.5 ? -1 : 1); if (sa < 0.5 || sa > L - 0.5) continue;
          const ax = a[0] + tx * sa + nx * 0.2, az = a[1] + tz * sa + nz * 0.2, ac = 0.8 + R() * 0.25;
          Acc.tint = [ac, ac * 0.99, ac * (0.9 + R() * 0.1)];
          A('white').box([ax, W.y0 - 0.25, az], [0.42, 0.32, 0.17], yaw, false);   // outdoor unit (its bracket is below the 1080p pixel)
          Acc.tint = tint;
          wallDecal(a, t2, n2, sa - 0.06, sa + 0.06, Math.max(0.2, W.y0 - 1.6), W.y0 - 0.6, 0.8, 1.0);
        }
      }
      if (!front) { Acc.tint = WHITE; continue; }
      // ---- ground floor: shopfront bays (interior-mapped), a framed door, posters; or a shutter. Sign bed above.
      const look = USE_LOOK[l.use] || USE_LOOK.shop;
      const shut = R() < look.shut; info.shutter = shut; info.shopLit = !shut;
      const w0 = 0.4, w1 = L - 0.4, gw = w1 - w0, Pt = (s, y, o = 0) => [a[0] + tx * s + nx * o, y, a[1] + tz * s + nz * o];
      if (gw > 0.8) {
        if (shut) {
          facts.shutters++;
          const p0 = Pt(w0, 0, 0.04), p1 = Pt(w1, 0, 0.04);
          A('shutter').quad([p0[0], 0.02, p0[2]], [p1[0], 0.02, p1[2]], [p1[0], K.shopTop, p1[2]], [p0[0], K.shopTop, p0[2]], [nx, 0, nz], [[0, 0], [gw, 0], [gw, K.shopTop], [0, K.shopTop]]);
          A('metal').box(Pt((w0 + w1) / 2, K.shopTop + 0.15, 0.19), [gw / 2, 0.15, 0.15], yaw, false);   // the shutter box above
        } else {
          facts.shopsLit++;
          const nitsS = lerp(look.nits[0], look.nits[1], R()), cu = R(), room = look.room[Math.floor(R() * look.room.length)];
          const fr = look.front && R() < look.front[1] ? look.front[0] : 0, D = 5 + R() * 4;
          const nb = Math.max(1, Math.round(gw / (1.8 + hash(l.id + 'bw') * 1.2))), bwid = gw / nb, door = nb === 1 ? 0 : nb >= 3 && R() < 0.4 ? Math.floor(nb / 2) : R() < 0.5 ? 0 : nb - 1;
          for (let k = 0; k < nb; k++) {
            const sc = w0 + (k + 0.5) * bwid, isDoor = k === door;
            pane('shop', [a[0] + tx * sc + nx * 0.04, a[1] + tz * sc + nz * 0.04], t2, n2, bwid - 0.02, K.shopTop, 0, emOf(look, nitsS, cu, room + 32 * (isDoor && fr === FRONT.cafeCurtain ? 0 : fr) + Math.min(0.999, R())), [bwid - 0.02, K.shopTop, (isDoor ? 2 : 1) * 4, D]);
            if (k < nb - 1) A('frame').box(Pt(w0 + (k + 1) * bwid, K.shopTop / 2, 0.08), [0.035, K.shopTop / 2, 0.05], yaw, true);
            if (isDoor) {   // door: jambs, header at 2.2 m, a push bar
              for (const e of [-1, 1]) A('frame').box(Pt(sc + e * (bwid / 2 - 0.05), 1.1, 0.09), [0.03, 1.1, 0.045], yaw, true);
              A('frame').box(Pt(sc, 2.2, 0.09), [bwid / 2 - 0.02, 0.035, 0.045], yaw, false);
              A('frame').box(Pt(sc, 1.02, 0.15), [Math.min(0.45, bwid * 0.35), 0.016, 0.02], yaw, false);
            } else if (R() < 0.55) {   // a poster or two on the glass, backlit by the shop
              const kind = { pocha: 0, restaurant: 0, cafe: 0, bar: 3, club: 3, shop: 1, pc: 1, karaoke: 3, conv: 1 }[l.use] ?? 1;
              const np = R() < 0.35 ? 2 : 1;
              for (let q = 0; q < np; q++) {
                const pw = 0.48 + R() * 0.14, ph = pw * 1.41, ps = sc + (np === 1 ? (R() - 0.5) * (bwid - pw - 0.2) : (q - 0.5) * (pw + 0.08));
                const pidx = (Math.floor(R() * 4) * 4 + kind) % 16;
                pane('shop', [a[0] + tx * ps + nx * 0.052, a[1] + tz * ps + nz * 0.052], t2, n2, pw, ph, 0.95 + R() * 0.25, emOf(look, nitsS * 0.35, cu, pidx), [pw, ph, 3 * 4, 0.1]);
              }
            }
          }
          A('frame').box(Pt((w0 + w1) / 2, 2.32, 0.08), [gw / 2, 0.03, 0.05], yaw, false);   // transom bar
          A('frame').box(Pt((w0 + w1) / 2, 0.1, 0.06), [gw / 2, 0.1, 0.025], yaw, false);   // kick plate
          const c = Pt((w0 + w1) / 2, K.shopTop / 2, 0.05), col = colourOf(look, cu);
          emitters.push({ id: 'store:' + l.id, pos: [+c[0].toFixed(2), +c[1].toFixed(2), +c[2].toFixed(2)], normal: [+nx.toFixed(3), 0, +nz.toFixed(3)], w: +gw.toFixed(2), h: K.shopTop,
            rgb: col.map((v) => +v.toFixed(3)), nits: Math.round(nitsS), kind: 'store', animated: false, lot: l.id });
        }
        // sign bed (aluminium composite panel), 2.9-4.0 m, 8 cm proud: charcoal on most lots, grey or dull white on some
        const [fy, fh, fd] = K.fascia, fc = [(a[0] + b[0]) / 2 + nx * fd / 2, fy + fh / 2, (a[1] + b[1]) / 2 + nz * fd / 2], fr2 = hash(l.id + 'bed');
        const bed = fr2 < 0.6 ? 0.06 + hash(l.id + 'bv') * 0.05 : fr2 < 0.85 ? 0.16 + hash(l.id + 'bv') * 0.08 : 0.32;
        Acc.tint = [bed * (1 - age * 0.15), bed * (1 - age * 0.17), bed * (1 - age * 0.15) * 1.03];
        A('fascia').box(fc, [L / 2, fh / 2, fd / 2], yaw, false);
        Acc.tint = tint;
        info.fascia = { c: [fc[0] + nx * fd / 2, fc[1], fc[2] + nz * fd / 2], normal: [nx, 0, nz], t: [tx, 0, tz], w: L, h: fh };
      }
      // piers
      for (const s of [0.2, L - 0.2]) A(fmat).box([a[0] + tx * s + nx * 0.06, K.shopTop / 2, a[1] + tz * s + nz * 0.06], [0.2, K.shopTop / 2, 0.06], yaw);
      Acc.tint = WHITE;
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

  // ---------------- [P2-C] stream E's street dressing (contract P2-1), tolerated missing: render geometry by material, collider
  // triangles, emitters (L3) and set pieces. Keys that match ours merge into our meshes; new keys keep their own material
  // (seoul-dressing's MATS / materials, SEOUL_MATS schema).
  const merged = {}, dressing = { keys: [], colTris: 0, emitters: 0, setPieces: [], materials: {}, error: null };
  for (const [k, a] of Object.entries(acc)) { const g = a.geometry(); if (g) merged[k] = g; }
  const own = { ...merged };   // our part of each mesh: the collider (E's triangles collide through its colTris)
  const DM = opts.dressing === false ? null : (opts.dressing || DRESSING);
  let dressCol = null;
  if (DM && typeof DM.geometry === 'function') {
    try {
      const d = DM.geometry(layout, { seed, lotInfo, poles, cables, streets, NITS }) || {};
      Object.assign(dressing.materials, DM.MATS || DM.materials || {}, d.materials || {});
      for (const [k, g0] of Object.entries(d.merged || {})) {
        if (!g0?.getAttribute?.('position')) continue;
        if (merged[k]) { const g = conform(g0, merged[k]); if (g) merged[k] = mergeGeometries([merged[k], g], false); else merged['E:' + k] = g0; }
        else merged[k] = g0;
        dressing.keys.push(k);
      }
      if (d.colTris?.getAttribute?.('position')) { dressCol = d.colTris.index ? d.colTris.toNonIndexed() : d.colTris; dressing.colTris = dressCol.getAttribute('position').count / 3; }
      for (const e of d.emitters || []) emitters.push(e);
      dressing.emitters = (d.emitters || []).length; dressing.setPieces = d.setPieces || [];
    } catch (e) { dressing.error = String(e?.message || e); console.warn('seoulDressing.geometry', e); }
  }
  facts.dressing = { keys: dressing.keys.length, colTris: dressing.colTris, emitters: dressing.emitters, setPieces: dressing.setPieces.length, ...(dressing.error ? { error: dressing.error } : {}) };
  // ---------------- merge per material, collider
  const posOnly = (g) => { const h = new THREE.BufferGeometry(); h.setAttribute('position', (g.index ? g.toNonIndexed() : g).getAttribute('position')); return h; };
  const dressNoCol = new Set(Object.entries(dressing.materials).filter(([, m]) => m.collide === false || m.decal).map(([k]) => k));
  // dressing meshes collide through E's colTris only (render meshes of E's own keys stay out of our collider)
  const colKeys = Object.keys(merged).filter((k) => !noCol.has(k) && !dressNoCol.has(k) && (SEOUL_MATS[k] && !k.startsWith('E:'))), colRanges = [];
  const colParts = colKeys.map((k) => posOnly(own[k] || merged[k]));
  if (dressCol) { colKeys.push('dressing'); colParts.push(posOnly(dressCol)); }
  { let t = 0; colKeys.forEach((k, i) => { const n = colParts[i].getAttribute('position').count / 3; colRanges.push({ key: k, tri0: t, tris: n }); t += n; }); }
  const colGeo = mergeGeometries(colParts, false);
  const bvh = new MeshBVH(colGeo, { maxLeafTris: 5 });
  // a BVH face index -> the material it came from (the BVH reorders the index, so go through it)
  const colKeyOf = (face) => { const ix = colGeo.index, tri = ix ? Math.floor(ix.getX(face * 3) / 3) : face; return colRanges.find((r) => tri >= r.tri0 && tri < r.tri0 + r.tris)?.key; };
  // skim: everything but the ground layers (a low pass down the street is a move, not a farm)
  const skimParts = colKeys.map((k, i) => [k, colParts[i]]).filter(([k]) => !['walk', 'road', 'plaza'].includes(k)).map(([, g]) => g);
  const skimBvh = new MeshBVH(mergeGeometries(skimParts, false), { maxLeafTris: 5 });
  let tris = 0; for (const g of Object.values(merged)) tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  facts.tris = tris; facts.colTris = colGeo.getAttribute('position').count / 3; facts.ms = Date.now() - t0;
  facts.winLitShare = +(facts.windowsLit / Math.max(1, facts.windows)).toFixed(3); facts.winMeanNits = +(facts.winNits / Math.max(1, facts.windows)).toFixed(2); delete facts.winNits;

  const L = lineData || {};
  const v3 = (p) => p;
  return {
    merged, colGeo, colRanges, colKeyOf, bvh, skimBvh, emitters, facts, lotInfo, poles, cables, layout,
    lines: L.lines || [], funnels: L.funnels || [],
    startPoints: (L.startPoints || []).map(v3), takeStart: L.takeStart || null,
    spawn: layout.spawn, setPieces: dressing.setPieces, dressingMats: dressing.materials, dressing: DM,
  };
}
// make a partner geometry match one of ours (non-indexed, same attribute set) so the two can merge; null if impossible
function conform(g0, like) {
  let g = g0.index ? g0.toNonIndexed() : g0.clone();
  const n = g.getAttribute('position').count;
  for (const [name, attr] of Object.entries(like.attributes)) {
    if (g.getAttribute(name)?.itemSize === attr.itemSize) continue;
    if (name === 'normal') { g.computeVertexNormals(); continue; }
    const fill = name === 'color' ? 1 : 0; g.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(n * attr.itemSize).fill(fill), attr.itemSize));
  }
  for (const name of Object.keys(g.attributes)) if (!like.attributes[name]) g.deleteAttribute(name);
  return g;
}
// stream E's module, if present (top-level, so node tests, the exporter and the game all get the same geometry)
let DRESSING = null;
try {
  const m = await import('./seoul-dressing.js');
  DRESSING = [m.seoulDressing, m.default, m].find((x) => x && typeof x.geometry === 'function') || null;
} catch (e) { if (!/Cannot find|not found|404|Failed to fetch|ERR_MODULE_NOT_FOUND|Importing a module script failed|error loading dynamically/i.test(String(e?.message || e))) console.warn('seoul-dressing.js', e); }

// ---- materials (browser)
// [P2-C] glass and shopfronts: interior mapping into seoul-interiors.js's atlas. Per pane: aEm (rgb = mean luminance the camera
// sees through it, x NITS; w = room + 32 x front layer + seed) and aWin (width, height, kind x 4 + sill, room depth). The
// pane sits on the facade; the glass is 14 cm (shop 4 cm) behind it, so a reveal hides part of it at an angle, then frame
// and mullions, then a ray-box room (5 painted walls in one-point perspective), then blinds, curtains, frosting or a pocha
// vinyl curtain. Posters (kind 3) are flat. Unlit rooms (< 2 nits) never light their lamps.
const SG_HEAD = /* glsl */`
uniform sampler2D tSeoulInt; uniform float uSeoulNorm[16];
varying vec4 sEm; varying vec4 sWin; varying vec3 sWPos; varying vec3 sONrm; varying vec2 sUv;
float sgMask = 0.0; vec3 sgEmit = vec3(0.0);
vec4 sgTile(float t, vec2 uv, float lod) {
  float pad = (0.5 * exp2(lod) + 0.5) / 256.0;
  uv = clamp(uv, vec2(pad), vec2(1.0 - pad));
  return textureLod(tSeoulInt, (vec2(mod(t, 4.0), floor(t / 4.0 + 0.001)) + uv) / vec2(4.0, 5.0), lod);
}
void seoulGlass(inout vec4 dc) {
  float w = max(sWin.x, 0.05), h = max(sWin.y, 0.05), kind = floor(sWin.z * 0.25 + 0.001), sill = sWin.z - kind * 4.0, D = max(sWin.w, 0.1);
  float code = floor(sEm.w + 0.0005), seed = sEm.w - code, room = mod(code, 32.0), front = floor(code / 32.0 + 0.001);
  vec3 L = sEm.rgb; float lit = step(0.2, dot(L, vec3(0.2126, 0.7152, 0.0722)));
  if (kind > 2.5) {   // poster: flat, quadrant of a poster tile
    vec2 qd = vec2(mod(room, 2.0), floor(mod(room, 4.0) * 0.5 + 0.001));
    float lod = clamp(log2(max(length(dFdx(sUv)), length(dFdy(sUv))) * 128.0), 0.0, 5.0);
    vec4 c = sgTile(16.0 + floor(room / 4.0 + 0.001), (qd + clamp(sUv, 0.02, 0.98)) * 0.5, lod);
    dc.rgb = c.rgb * 0.5; sgEmit = c.rgb * L; sgMask = 3.0; return;
  }
  vec3 n = normalize(sONrm), T = vec3(-n.z, 0.0, n.x), rd = normalize(sWPos - cameraPosition);
  vec3 r = vec3(dot(rd, T), rd.y, max(-dot(rd, n), 0.03));
  vec2 q = vec2((sUv.x - 0.5) * w, sill + sUv.y * h);
  vec2 g = q + r.xy * ((kind > 0.5 ? 0.04 : 0.14) / r.z);
  if (abs(g.x) > w * 0.5 || g.y < sill || g.y > sill + h) { dc.rgb = vec3(0.17, 0.165, 0.16); sgMask = 2.0; sgEmit = L * (0.06 * lit); return; }
  vec2 e = vec2(g.x + w * 0.5, g.y - sill);
  float fw = kind > 0.5 ? 0.03 : 0.045, m = step(e.x, fw) + step(w - fw, e.x) + step(e.y, fw) + step(h - fw, e.y);
  if (kind < 0.5) {
    float nm = floor(w / 1.25);
    if (nm > 0.5) { float cell = w / (nm + 1.0); m += step(abs(fract(e.x / cell + 0.5) - 0.5) * cell, fw * 0.55); }
    if (h > 1.7) m += step(abs(e.y - h * 0.72), fw * 0.55);
  }
  if (m > 0.5) { dc.rgb = vec3(0.07, 0.072, 0.078); sgMask = 1.0; sgEmit = L * (0.03 * lit); return; }
  // the room: x in [-Wr/2, Wr/2], y in [0, Hr] (floor), z in [0, D] behind the glass
  float Wr = kind > 0.5 ? w : max(w + 1.6, 3.2), Hr = kind > 0.5 ? 3.0 : max(2.7, sill + h + 0.15);
  vec3 rr = r; rr.x = abs(rr.x) < 1e-4 ? 1e-4 : rr.x; rr.y = abs(rr.y) < 1e-4 ? 1e-4 : rr.y;
  vec3 p0 = vec3(g, 0.0);
  float t = min(min(((rr.x > 0.0 ? 0.5 : -0.5) * Wr - p0.x) / rr.x, ((rr.y > 0.0 ? Hr : 0.0) - p0.y) / rr.y), D / rr.z);
  vec3 hit = p0 + rr * t;
  vec3 nb = vec3(hit.x / (Wr * 0.5), hit.y / (Hr * 0.5) - 1.0, clamp(hit.z / D, 0.0, 1.0));
  if (seed > 0.5) nb.x = -nb.x;
  vec2 tuv = clamp(nb.xy / (1.0 + nb.z) * 0.5 + 0.5, 0.0, 1.0);
  float lod = clamp(log2(max(max(length(dFdx(q)), length(dFdy(q))) * 256.0 / Wr, 1e-4)), 0.0, 6.0);
  vec4 c = sgTile(room, tuv, lod);
  vec3 col = c.rgb * (1.0 + (1.0 - c.a) * 6.0 * lit) * uSeoulNorm[int(room)] * L;
  vec2 gu = e / vec2(w, h);
  if (front > 0.5 && front < 1.5) {           // blinds, lowered part way
    if (gu.y > 0.55 - fract(seed * 7.13) * 0.55) { vec4 b = sgTile(9.0, vec2(gu.x * w * 0.5, gu.y * h / 1.6), lod); col = mix(col, b.rgb * L * 0.55, b.a); }
  } else if (front > 1.5 && front < 2.5) {    // curtains from both sides
    if (abs(gu.x - 0.5) > fract(seed * 5.31) * 0.25) {
      vec4 cc = sgTile(10.0, vec2(fract(gu.x * w / 1.4), gu.y), lod);
      float k = fract(seed * 3.7);
      vec3 tint = k < 0.4 ? vec3(0.95, 0.88, 0.75) : k < 0.6 ? vec3(0.95, 0.95, 0.92) : k < 0.75 ? vec3(0.9, 0.55, 0.55) : k < 0.9 ? vec3(0.45, 0.5, 0.75) : vec3(0.7, 0.75, 0.6);
      col = mix(col, cc.rgb * tint * L * 0.75, cc.a);
    }
  } else if (front > 2.5 && front < 3.5) {    // frosted
    col = sgTile(15.0, gu, lod).rgb * L * 1.1;
  } else if (front > 3.5 && front < 4.5) {    // pocha vinyl curtain: orange-clear PVC, soft folds
    float fold = 0.8 + 0.2 * sin(gu.x * w * 7.0 + sin(gu.y * 4.0 + seed * 6.0) * 1.5);
    col = mix(col, vec3(dot(col, vec3(0.3333))), 0.55) * vec3(1.18, 0.8, 0.45) * fold;
  } else if (front > 5.5 && front < 6.5) {    // cafe curtain on the lower 40 %
    if (gu.y < 0.4) { vec4 cc = sgTile(10.0, vec2(fract(gu.x * w / 0.9), gu.y), lod); col = mix(col, cc.rgb * vec3(0.95, 0.92, 0.85) * L * 0.8, cc.a); }
  }
  sgEmit = col;
}
`;
// procedural grime on the scan textures: vertical streaks and blots in metres of uv (walls: along x, height y)
const GRIME_HEAD = /* glsl */`
varying vec2 sUv;
float sgH(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float sgN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sgH(i), sgH(i + vec2(1.0, 0.0)), f.x), mix(sgH(i + vec2(0.0, 1.0)), sgH(i + vec2(1.0, 1.0)), f.x), f.y); }
float seoulGrime(vec2 uv) {
  float streak = smoothstep(0.55, 0.95, sgN(vec2(uv.x * 2.3, uv.y * 0.16))) * smoothstep(0.35, 0.85, sgN(vec2(uv.x * 0.37 + 7.1, uv.y * 0.05)));
  return 1.0 - 0.3 * streak - 0.12 * smoothstep(0.5, 1.0, sgN(uv * 0.9 + 3.3));
}
`;
function patchSeoul(mat, mode) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    if (mode === 'glass') {
      Object.assign(sh.uniforms, INTERIOR_UNIFORMS);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aEm; attribute vec4 aWin;\nvarying vec4 sEm; varying vec4 sWin; varying vec3 sWPos; varying vec3 sONrm; varying vec2 sUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nsEm = aEm; sWin = aWin; sONrm = normal; sUv = uv; sWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + SG_HEAD)
        .replace('#include <color_fragment>', '#include <color_fragment>\n  seoulGlass(diffuseColor);')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = sgMask > 2.5 ? 0.12 : sgMask > 1.5 ? 0.9 : sgMask > 0.5 ? 0.4 : roughnessFactor;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = sgMask > 0.5 && sgMask < 1.5 ? 0.6 : metalnessFactor;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += sgEmit;');
    } else if (mode === 'flat') {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aEm;\nvarying vec3 vEm;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvEm = aEm.rgb;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vEm;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEm;');
    } else if (mode === 'grime') {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 sUv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nsUv = uv;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + GRIME_HEAD).replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= seoulGrime(sUv);');
    }
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + '|seoul:' + mode; };
  return mat;
}
const INTERIOR_UNIFORMS = { tSeoulInt: { value: null }, uSeoulNorm: { value: new Array(16).fill(1) } };
let interiorTex = null;
function interiorTexture() {
  if (interiorTex) return interiorTex;
  const A = buildInteriorAtlas();
  const t = new THREE.DataTexture(A.data, A.width, A.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.flipY = false; t.anisotropy = 4; t.name = 'seoul:interiors'; t.needsUpdate = true;
  INTERIOR_UNIFORMS.uSeoulNorm.value = Array.from({ length: 16 }, (_, i) => (i === 9 || i === 10 || i === 15 ? 1 : 1 / Math.max(0.05, A.mean[i])));
  INTERIOR_UNIFORMS.tSeoulInt.value = t;
  return (interiorTex = t);
}
function makeMaterials(renderer, texLoader, extra = {}) {
  const mats = {}, pending = [];
  const aniso = renderer?.capabilities?.getMaxAnisotropy?.() || 1;
  for (const [k, m] of Object.entries({ ...SEOUL_MATS, ...extra })) {
    if (m.decal === 'multiply') {   // contact darkening and leak streaks: dst *= vertex colour
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, fog: false, toneMapped: false });
      mat.userData.cityLight = false; mat.name = 'seoul:' + k; mats[k] = mat; continue;
    }
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...m.color), roughness: m.rough ?? 0.8, metalness: m.metal || 0, vertexColors: !m.emissive });
    if (m.id && texLoader) for (const map of m.maps) {
      const url = `${PH}/Textures/jpg/1k/${m.id}/${m.id}_${map}_1k.jpg`;
      pending.push(new Promise((res) => texLoader.load(url, (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / m.tile, 1 / m.tile); t.anisotropy = Math.min(8, aniso);
        if (map === 'diff') { t.colorSpace = THREE.SRGBColorSpace; mat.map = t; } else { mat.normalMap = t; mat.normalScale.set(1, 1); }
        mat.needsUpdate = true; res();
      }, undefined, () => { console.warn('seoul texture failed', url); res(); })));
    }
    if (m.emissive) { mat.emissive = new THREE.Color(0, 0, 0); if (m.interior) { interiorTexture(); patchSeoul(mat, 'glass'); } else patchSeoul(mat, 'flat'); }
    else if (m.grime) patchSeoul(mat, 'grime');
    if (k === 'plaza') mat.userData.wet = 0.8;   // [P2-C] the walking streets are wet too (seoul-light's wet path; phase 1 matched only 'road')
    if (['stripe', 'yellow'].includes(k)) { mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2; }
    if (k === 'glass' || k === 'shop') { mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1; }
    mat.name = 'seoul:' + k; mats[k] = mat;
  }
  return { mats, ready: Promise.all(pending) };
}

// ================================================================================================================
// [P2-C] buildGeometry({seed}) — the CPU-only entry for tools/export-world.mjs --level seoul-hongdae (native #1).
// Loads layout.json and lines.json next to this module; returns the export contract { merged, colGeo, spawn, takeStart,
// startPoints, lines, funnels, materials, bounds, envelope, site, extra }. The world seed is SEOUL_SEED (11), what the game
// uses; geometry depends on the layout only (lot ids), so other seeds change nothing here except E's dressing, if it uses one.
// ================================================================================================================
export async function buildGeometry({ seed = SEOUL_SEED, layout = null, lines = null } = {}) {
  layout ||= await loadSeoulJSON('./seoul/layout.json'); if (!layout) throw new Error('seoul/layout.json missing');
  const lineData = lines || (await loadSeoulJSON('./seoul/lines.json'));
  const geo = buildSeoulGeometry(layout, { lineData, seed });
  const B = boxOf(layout), sp = geo.takeStart || layout.spawn || { pos: [0, 6, 0], yaw: 0 };
  const A = buildInteriorAtlas();
  const lots = [...geo.lotInfo.values()].map((i) => ({ id: i.id, H: i.H, facade: i.facade, shopLit: i.shopLit, shutter: i.shutter, fascia: i.fascia,
    floors: i.floors.filter(Boolean), windows: i.windows }));
  return {
    merged: geo.merged, colGeo: geo.colGeo, spawn: { pos: sp.pos, yaw: sp.yaw ?? 0 }, takeStart: geo.takeStart, startPoints: geo.startPoints, lines: geo.lines, funnels: geo.funnels,
    materials: { ...SEOUL_MATS, ...(geo.dressingMats || {}) },
    bounds: { min: [B.x0 - 60, -5, B.z0 - 60], max: [B.x1 + 60, 200, B.z1 + 60] }, envelope: { min: [B.x0 - 30, -2, B.z0 - 30], max: [B.x1 + 30, 160, B.z1 + 30] },
    site: { level: 'seoul-hongdae', seed, NITS, facts: (({ ms, ...f }) => f)(geo.facts), colRanges: geo.colRanges.map(({ key, tri0, tris }) => ({ key, tri0, tris })) },
    extra: { emitters: geo.emitters, setPieces: geo.setPieces, lots,
      interiorAtlas: { module: 'seoul-interiors.js', fn: 'buildInteriorAtlas', width: A.width, height: A.height, tile: A.tile, cols: A.cols, rows: A.rows, boost: A.boost, colour: 'sRGB rgb, linear alpha (1 - light boost / boost)', mean: [...A.mean] },
      attributes: { aEm: 'rgb = mean luminance seen through the pane x NITS; w = room + 32 x front + seed', aWin: 'width, height, kind x 4 + sill (kind 0 window, 1 shop bay, 2 door, 3 poster), room depth', color: 'vertex colour: per-lot tint, age, contact darkening (multiply on albedo)' } },
  };
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
  const geo = buildSeoulGeometry(layout, { lineData, seed: opts.seed ?? SEOUL_SEED });
  prog(0.55, 'Hongdae: materials');
  const texLoader = IS_NODE ? null : new THREE.TextureLoader();
  const { mats, ready } = makeMaterials(renderer, texLoader, geo.dressingMats);
  for (const [k, g] of Object.entries(geo.merged)) {
    let mat = mats[k] || mats[k.replace(/^E:/, '')] || mats.concrete;
    if (mat.vertexColors && !g.getAttribute('color')) { mat = mat.clone(); mat.vertexColors = false; }   // a partner mesh without vertex colour
    const mesh = new THREE.Mesh(g, mat); mesh.name = 'seoul:' + k; mesh.matrixAutoUpdate = false; mesh.receiveShadow = true;
    if (k === 'ao') { mesh.renderOrder = -10; mesh.frustumCulled = false; }
    scene.add(mesh);
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
  // [P2-C] stream E's runtime part (cable renderer, animated bits), contract P2-1: build(layout, ctx) -> { group, update }
  if (geo.dressing && typeof geo.dressing.build === 'function' && opts.dressing !== false) {
    try { parts.dressing = await geo.dressing.build(layout, { ...ctx, setPieces: geo.setPieces }); if (parts.dressing?.group) scene.add(parts.dressing.group); emitters.push(...(parts.dressing?.emitters || [])); }
    catch (e) { console.warn('seoulDressing.build', e); }
  }
  await Promise.race([ready, new Promise((r) => setTimeout(r, 8000))]);

  const depthScene = new THREE.Scene(); depthScene.name = 'depthScene';   // C2: no alpha-tested extras in Seoul (yet)
  const colScene = new THREE.Scene(); { const cm = new THREE.Mesh(geo.colGeo, new THREE.MeshBasicMaterial()); cm.frustumCulled = false; colScene.add(cm); }
  const B = boxOf(layout);
  const sp = geo.takeStart || layout.spawn || { pos: [0, 6, 0], yaw: 0 };   // the first start point (the walking street) when lines exist
  const stats = { ...geo.facts, ms: { geometry: geo.facts.ms, total: 0 }, emitters: emitters.length };
  const update = (camPos, dt = 1 / 60, camQuat) => {
    uniforms.uTime.value += dt || 0;
    const t = ctx.takeClock ? ctx.takeClock() : uniforms.uTime.value;
    parts.signs?.update?.(t, camPos, camQuat); parts.life?.update?.(t, camPos, camQuat); parts.dressing?.update?.(t, camPos, camQuat); parts.light?.update?.(t, camPos, camQuat);
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
    setPieces: geo.setPieces || [], lotInfo: geo.lotInfo,   // [P2-C] E's set pieces (F1 codes lines against their ids); per-lot facade facts (B: lit windows)
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
