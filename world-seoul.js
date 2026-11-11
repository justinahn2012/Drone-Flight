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
import { buildInteriorAtlas, ROOM, FRONT, ATLAS, NEAR } from './seoul-interiors.js';
import { moverDepth } from './seoul-depth.js';   // [P5 H, native #6]

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
  // [P4-C] art #2 (walls you can see): `color` is the gain that takes each scan's measured mean (tools/texmean.py) to the
  // albedo in `albedo` (texture mean x color); per-lot tint x grime x detail take ~16 % off that on the wall. Phase 3's
  // 'tile' was concrete_tile_facade, a charcoal tile with a 0.04 mean: 37 % of the low lots and 60 % of the towers (every
  // hero wall in walk0, walk180, w21, club90 and station) were black whatever the light did.
  tile: { grime: 1, id: 'rounded_square_tiled_wall', tile: 2.0, maps: ['diff', 'nor_gl'], color: [2.3, 2.7, 3.3], rough: 0.45, albedo: [0.541, 0.495, 0.431] },   // beige mosaic tile (2 m scan, 7 cm tiles)
  brick: { grime: 1, id: 'brown_brick_02', tile: 1.0, maps: ['diff', 'nor_gl'], color: [1.0, 0.85, 0.95], rough: 0.85, albedo: [0.476, 0.244, 0.137] },     // Hongdae's red-brown brick (1 m scan: 9 cm courses; P3's 2.2 m tile drew 20 cm bricks)
  plaster: { grime: 1, id: 'beige_wall_001', tile: 3.0, maps: ['diff', 'nor_gl'], color: [1.64, 2.02, 2.55], rough: 0.9, albedo: [0.559, 0.530, 0.479] },    // cream-white painted render
  concrete: { grime: 1, id: 'concrete_wall_008', tile: 3.0, maps: ['diff', 'nor_gl'], color: [1.35, 1.48, 2.0], rough: 0.9, albedo: [0.359, 0.350, 0.323] },
  stone: { grime: 1, id: 'granite_tile_03', tile: 1.8, maps: ['diff', 'nor_gl'], color: [3.2, 3.7, 4.3], rough: 0.5, albedo: [0.403, 0.379, 0.359] },        // [P4-C] grey granite cladding (towers, podiums): 60 cm panels
  roof: { grime: 1, id: 'concrete_floor_02', tile: 4.0, maps: ['diff', 'nor_gl'], color: [0.55, 0.75, 0.6], rough: 0.8, albedo: [0.17, 0.22, 0.18] },   // green roof paint (T5)
  metal: { grime: 1, id: 'blue_metal_plate', tile: 2.0, maps: ['diff', 'nor_gl'], color: [0.6, 0.62, 0.65], rough: 0.5, metal: 0.4, albedo: [0.20, 0.21, 0.22] },
  // [P4-C] roll shutters are painted galvanised slats (a 2 m scan of one), not P3's blue-black plate (0.04): club90's dead
  // ground floor was a shutter
  shutter: { grime: 1, id: 'painted_metal_shutter', tile: 2.0, maps: ['diff', 'nor_gl'], color: [1.05, 1.0, 0.98], rough: 0.45, metal: 0.3, albedo: [0.225, 0.228, 0.233] },
  white: { color: [0.42, 0.42, 0.40], rough: 0.6, albedo: [0.42, 0.42, 0.40], grime: 1 },          // AC units, tanks (ivory-grey enamel under grime)
  // [P2-C] the sign bed: aluminium composite panel above the shop glass, charcoal / grey / dull white per lot (vertex colour);
  // phase 1's 32 cm white slab showed round S2's boxes as pale plates
  fascia: { color: [1, 1, 1], rough: 0.5, metal: 0.25, albedo: [0.12, 0.12, 0.125], grime: 1 },
  frame: { color: [0.07, 0.072, 0.078], rough: 0.38, metal: 0.6, albedo: [0.07, 0.072, 0.078] },   // anodised mullions, door frames
  // [P3-C] facade kit (art #2, graphics #1), render only: downpipes, conduit, meter boxes (pipe); Korea's yellow gas risers
  pipe: { color: [0.5, 0.5, 0.48], rough: 0.55, albedo: [0.5, 0.5, 0.48], grime: 1 },
  shutterR: { grime: 1, id: 'painted_metal_shutter', tile: 2.0, maps: ['diff', 'nor_gl'], color: [1.05, 1.0, 0.98], rough: 0.45, metal: 0.3, albedo: [0.225, 0.228, 0.233] },   // corner-face shutters (render only)
  bed: { color: [1, 1, 1], rough: 0.5, metal: 0.25, albedo: [0.12, 0.12, 0.125], grime: 1 },   // a corner face's sign bed (render only: lines.json gates)
  gaspipe: { color: [0.72, 0.52, 0.05], rough: 0.5, albedo: [0.72, 0.52, 0.05] },
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
// [P4-C] fpv #2, graphics #2, color #6 (shops that hold exposure): 30-60 nits (P3: shops 70-110, the convenience store
// 110-130), restaurants 4500 K and cafes 4000 K (walk0's 3500 K cafe glass was salmon, 18 % clipped); lobby: a main-road
// tower's podium (lighting #3: 80-150 nits that render), its own room tile
const USE_LOOK = {
  club: { nits: [30, 40], rgb: [1.0, 0.42, 0.9], room: [3, 4], shut: 0.15 }, bar: { nits: [30, 42], cct: 2700, room: [3], shut: 0.1 },
  pocha: { nits: [40, 55], cct: 3100, room: [2], front: [4, 0.7], shut: 0.05 }, restaurant: { nits: [36, 52], cct: 4500, room: [2, 1], front: [6, 0.2], shut: 0.25 },
  cafe: { nits: [34, 50], cct: 5200, room: [1], shut: 0.35 }, shop: { nits: [40, 58], cct: 5800, room: [5, 6, 5], shut: 0.45 },
  conv: { nits: [52, 60], cct: 6200, room: [0], shut: 0 }, karaoke: { nits: [35, 50], rgb: [0.85, 0.6, 1.0], room: [4], shut: 0.05 },
  pc: { nits: [38, 52], cct: 6000, room: [7], shut: 0.05 }, motel: { nits: [35, 45], rgb: [1.0, 0.62, 0.7], room: [4], shut: 0.1 },
  office: { nits: [35, 50], cct: 5000, room: [8], shut: 0.8 }, hotel: { nits: [42, 58], cct: 3200, room: [1], shut: 0.1 },
  lobby: { nits: [85, 110], cct: 4300, room: [9] },
};
// upper-floor tenants (2F and up) by street kind, and the interior + luminance a lit floor shows (lit windows: 5-25 nits)
const UPPER = { walking: { bar: 3, karaoke: 2, cafe: 3, pc: 1, office: 1, home: 1, restaurant: 2 }, club: { bar: 4, karaoke: 2, pc: 1, home: 2, cafe: 1, restaurant: 1, motel: 1 },
  main: { office: 4, cafe: 2, pc: 1, karaoke: 1, bar: 1, restaurant: 1, home: 1 }, alley: { home: 5, office: 2, bar: 1, cafe: 1, karaoke: 1, study: 1 } };
const TENANT = { bar: { room: [3], nits: [6, 12], cct: 2700 }, karaoke: { room: [4], nits: [8, 14], rgb: [0.85, 0.6, 1.0] }, cafe: { room: [1], nits: [12, 20], cct: 3500 },
  pc: { room: [13, 7], nits: [6, 12], cct: 6000 }, office: { room: [8], nits: [15, 25], cct: 5000 }, home: { room: [12, 13, 11, 12], nits: [5, 12], cct: 2800 },
  study: { room: [11], nits: [8, 16], cct: 3500 }, restaurant: { room: [2], nits: [12, 20], cct: 3500 }, motel: { room: [12], nits: [6, 10], rgb: [1.0, 0.7, 0.75] },
  hotel: { room: [12], nits: [8, 14], cct: 3000 } };
// [P5-C] lighting #5 (station2's office floors read amber): a tower's office floor is a 4500-5000 K LED panel grid at 40-60
// nits as the street sees it (a lit open-plan floor is the brightest window in the city; P4 gave it the 15-25 of a low office)
const TOWER_OFFICE = { room: [8], nits: [40, 60], cct: 4750 };
// station2's two 8F hotels were 3000 K top to bottom: a business hotel's rooms are LED-lit at 4000-4500 K on 60 % of its floors
const TOWER_HOTEL = { room: [12, 11], nits: [10, 18], cct: 4250 };
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
// [P3-C] (colorist #2) light colours are expressed against a 4300 K white point (the night camera's balance), not D65: a
// 2700 K room reads amber, not pumpkin, and a 4000 K street head reads near-white. Normalised to luminance 1.
export const WHITE_K = 4300;
const WB_RGB = cctRGB(WHITE_K);
export function lightRGB(K) { const c = cctRGB(K).map((v, i) => v / WB_RGB[i]), Y = lumOf(c); return c.map((v) => v / Y); }
// [P3-C] (colorist #1, the rooms part) coloured rooms are a filter on white light: rgb / max(rgb), and `nits` is the
// white-equivalent, so a magenta club room emits nits x lum(filter) (blue and violet no longer carry 6-7x their luminance)
const filterOf = (rgb) => { const m = Math.max(...rgb); return rgb.map((v) => v / m); };
const colourOf = (o, u) => o.rgb ? filterOf(o.rgb) : lightRGB(o.cct + (u - 0.5) * 500);
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
  const noCol = new Set(['stripe', 'yellow', 'glass', 'shop', 'sill', 'ao', 'frame', 'pipe', 'gaspipe', 'bed', 'shutterR']);
  const emitters = [], facts = { lots: layout.lots.length, windowsLit: 0, windows: 0, winNits: 0, shopsLit: 0, sideShops: 0, shutters: 0, ac: 0, grilles: 0, pipes: 0, gas: 0, rails: 0, roofLamps: 0, roofSigns: 0, tanks: 0, poles: 0, cableSpans: 0, streetLights: 0 };
  const streets = layout.streets, lots = layout.lots, streetById = new Map(streets.map((s) => [s.id, s]));
  const grid = lotGrid(lots);
  const B = boxOf(layout);
  const acE = opts.dressing !== false && !!(opts.dressing || DRESSING)?.acKit;   // [P3-E1] E's AC kit draws the condensers C places

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
  // [P4-C] art #2: beige tile or cream render (albedo 0.40-0.45 on the wall) on 48 % of the low lots, red-brown brick 28 %;
  // towers are granite, tile or render (a third of P3's towers were bare concrete)
  const facadeOf = (l) => { const r = hash(l.id + 'f'); if (l.floors >= 9) return r < 0.4 ? 'stone' : r < 0.7 ? 'tile' : r < 0.85 ? 'plaster' : 'concrete';
    return r < 0.28 ? 'brick' : r < 0.58 ? 'tile' : r < 0.76 ? 'plaster' : r < 0.9 ? 'concrete' : 'stone'; };
  const lotInfo = new Map();
  let nearKind = 'alley';
  const streetDist = (x, z) => { let d = Infinity; for (const s of streets) for (let i = 0; i < s.points.length - 1; i++) { const q = segD(x, z, s.points[i][0], s.points[i][1], s.points[i + 1][0], s.points[i + 1][1]) - s.width / 2; if (q < d) { d = q; nearKind = s.kind; } } return d; };
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
  // ---- [P3-C] facade kit (art #2, graphics #1): the clutter real Seoul walls carry. All render-only trim (keys pipe, gaspipe,
  // frame), except the AC unit bodies, which collide as before. W(s, y, d): a wall point s along, d out.
  const fan = (key, c, u, v, n, r, sides) => { for (let k = 0; k < sides; k++) { const a0 = (k / sides) * Math.PI * 2, a1 = ((k + 1) / sides) * Math.PI * 2;
    const p = (q) => [c[0] + (u[0] * Math.cos(q) + v[0] * Math.sin(q)) * r, c[1] + (u[1] * Math.cos(q) + v[1] * Math.sin(q)) * r, c[2] + (u[2] * Math.cos(q) + v[2] * Math.sin(q)) * r];
    const P0 = c, P1 = p(a0), P2 = p(a1), cr = [(P1[1] - P0[1]) * (P2[2] - P0[2]) - (P1[2] - P0[2]) * (P2[1] - P0[1]), (P1[2] - P0[2]) * (P2[0] - P0[0]) - (P1[0] - P0[0]) * (P2[2] - P0[2]), (P1[0] - P0[0]) * (P2[1] - P0[1]) - (P1[1] - P0[1]) * (P2[0] - P0[0])];
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] >= 0) A(key).tri(P0, P1, P2, [0, 0], [1, 0], [0, 1]); else A(key).tri(P0, P2, P1, [0, 0], [0, 1], [1, 0]); } };
  // an outdoor AC unit's face: fan grille (dark disc + guard bars), side louvres, and a steel bracket under it
  // flat quads only (~32 tris a unit with its body): the kit has to stay inside D's triangle budget
  const acFront = (a, t, n, sa, ay, d) => {
    const W3 = (s, y, o) => [a[0] + t[0] * s + n[0] * o, y, a[1] + t[1] * s + n[1] * o], N3 = [n[0], 0, n[1]];
    const flat = (key, s0, s1, y0, y1, o) => A(key).quad(W3(s0, y0, o), W3(s1, y0, o), W3(s1, y1, o), W3(s0, y1, o), N3);
    fan('frame', W3(sa + 0.07, ay, d + 0.004), [t[0], 0, t[1]], [0, 1, 0], N3, 0.24, 6);
    for (const dy of [-0.09, 0.09]) flat('pipe', sa - 0.17, sa + 0.31, ay + dy - 0.01, ay + dy + 0.01, d + 0.01);
    for (let k = 0; k < 3; k++) flat('frame', sa - 0.38, sa - 0.22, ay - 0.14 + k * 0.1, ay - 0.12 + k * 0.1, d + 0.003);
    for (const e of [-0.3, 0.3]) A('frame').quad(W3(sa + e - 0.02, ay - 0.33, 0.02), W3(sa + e + 0.02, ay - 0.33, 0.02), W3(sa + e + 0.02, ay - 0.33, d), W3(sa + e - 0.02, ay - 0.33, d), [0, -1, 0]);
  };
  // downpipes, conduit, yellow gas risers with meters, and spandrel anchors for B's floor boxes
  const facadeKit = (l, info, a, t, n, L, H, Ht, yaw, typ, rh, R, front, street) => {
    const W3 = (s, y, o) => [a[0] + t[0] * s + n[0] * o, y, a[1] + t[1] * s + n[1] * o];
    const got = { pipe: false, conduit: false };
    if (L > 3 && R() < 0.45) {   // a downpipe at one end, hopper head under the coping, a shoe at the foot
      facts.pipes++; got.pipe = true; const s0 = R() < 0.5 ? 0.14 : L - 0.14;
      A('pipe').tube([W3(s0, 0.08, 0.07), W3(s0, H - 0.15, 0.07)], 0.045, 5);
      A('pipe').box(W3(s0, H - 0.08, 0.1), [0.1, 0.09, 0.08], yaw, true);
      for (let y = 1.5; y < H - 0.5; y += 1.8) A('frame').quad(W3(s0 - 0.06, y - 0.015, 0.12), W3(s0 + 0.06, y - 0.015, 0.12), W3(s0 + 0.06, y + 0.015, 0.12), W3(s0 - 0.06, y + 0.015, 0.12), [n[0], 0, n[1]]);
    }
    if (front && L > 2 && R() < 0.5) {   // conduit along the top of the sign bed, a riser to the roof
      got.conduit = true; A('frame').tube([W3(0.3, K.fascia[0] + K.fascia[1] + 0.05, 0.06), W3(L - 0.3, K.fascia[0] + K.fascia[1] + 0.05, 0.06)], 0.022, 4);
      const sr = 0.3 + R() * (L - 0.6); A('frame').tube([W3(sr, K.fascia[0] + K.fascia[1] + 0.05, 0.06), W3(sr, Ht + 0.05, 0.06), W3(sr, Ht + 0.05, -0.3)], 0.02, 4);
    }
    if ((!front || typ === 'villa') && l.floors >= 3 && L > 4 && R() < 0.35) {   // gas: a run at 2.2-2.8 m, a riser, a meter per floor
      facts.gas++; const y0 = 2.2 + R() * 0.6, s0 = 0.4 + R() * 0.3 * L, s1 = Math.min(L - 0.4, s0 + 2 + R() * 4), top = (l.floors - 1) * l.floorH + 1.2;
      A('gaspipe').tube([W3(0.05, y0, 0.06), W3(s1, y0, 0.06), W3(s1, top, 0.06)], 0.026, 4);
      for (let f = 1; f < l.floors; f++) { const y = f * l.floorH + 0.9; A('pipe').box(W3(s1 - 0.28, y, 0.09), [0.15, 0.2, 0.08], yaw, true); A('gaspipe').tube([W3(s1, y + 0.1, 0.06), W3(s1 - 0.14, y + 0.1, 0.06)], 0.018, 3); }
    }
    if (street) for (let f = 1; f < Math.min(l.floors - 1, 7); f++) {   // spandrels between floors f and f+1 (B: floor boxes)
      const y0 = f * l.floorH + rh.sill + Math.min(rh.h, l.floorH - rh.sill - 0.3), y1 = (f + 1) * l.floorH + rh.sill;
      if (y1 - y0 > 0.35) { const c = W3(L / 2, (y0 + y1) / 2, 0.02); info.bands.push({ f, c: c.map((v) => +v.toFixed(2)), normal: [n[0], 0, n[1]], t: [t[0], 0, t[1]], w: +(L * 0.9).toFixed(2), h: +(y1 - y0).toFixed(2), side: !front }); }
    }
    return got;
  };
  // ---- [P5-C] art #2 / graphics #1 (walls that have weathered): what phase 4's kit left bare, from its own stream (R5, keyed
  // by lot and wall) so the phase 2-4 streams, and the collider they shape, are untouched. All render-only (ao, pipe, frame).
  // A drip streak: a multiply decal that is darkest under its source and fades out downward, ragged (2-3 strips of
  // different length and strength), and a little rust tint under steel.
  const drip = (a, t, n, s, w, yTop, len, k, R5, rust = false) => {
    const strips = 1 + (R5() < 0.5 ? 1 : 0);
    for (let q = 0; q < strips; q++) {
      const ww = w * (0.25 + R5() * 0.45), sc = s + (R5() - 0.5) * (w - ww), ll = len * (0.45 + R5() * 0.55), kk = 1 - (1 - k) * (0.6 + R5() * 0.4);
      const top = rust ? [kk * 1.0, kk * 0.9, kk * 0.8] : [kk, kk, kk * 0.98];
      const P = (u, y) => [a[0] + t[0] * u + n[0] * 0.016, y, a[1] + t[1] * u + n[1] * 0.016];
      const y0 = Math.max(0.15, yTop - ll);
      A('ao').quadC(P(sc - ww / 2, y0), P(sc + ww / 2, y0), P(sc + ww / 2, yTop), P(sc - ww / 2, yTop), [n[0], 0, n[1]], undefined, undefined, [WHITE, WHITE, top, top]);
    }
    facts.drips = (facts.drips || 0) + 1;
  };
  // the wall kit phase 4 rolled against: a downpipe on 60 % of open walls (P4 45 %), conduit on 60 % of fronts (P4 50 %),
  // empty sign brackets (a tenant who left) on a third of the street walls, a dirty soffit streak under every floor band
  const wallKit5 = (l, info, a, t, n, L, H, Ht, yaw, rh, got, front, street, age, slot) => {
    const R5 = rng(l.id + ':p5:' + a[0].toFixed(1) + ',' + a[1].toFixed(1)), W3 = (s, y, o) => [a[0] + t[0] * s + n[0] * o, y, a[1] + t[1] * s + n[1] * o];
    if (!got.pipe && L > 3 && R5() < 0.28) {
      facts.pipes++; const s0 = R5() < 0.5 ? 0.14 : L - 0.14;
      A('pipe').tube([W3(s0, 0.08, 0.07), W3(s0, H - 0.15, 0.07)], 0.045, 5);
      A('pipe').box(W3(s0, H - 0.08, 0.1), [0.1, 0.09, 0.08], yaw, true);
      for (let y = 1.5; y < H - 0.5; y += 1.8) A('frame').quad(W3(s0 - 0.06, y - 0.015, 0.12), W3(s0 + 0.06, y - 0.015, 0.12), W3(s0 + 0.06, y + 0.015, 0.12), W3(s0 - 0.06, y + 0.015, 0.12), [n[0], 0, n[1]]);
      drip(a, t, n, s0, 0.35, H - 0.2, 1.2 + R5() * 2.5, 0.8, R5);   // the hopper overflows
    }
    if (front && !got.conduit && L > 2 && R5() < 0.2) {
      const yc = K.fascia[0] + K.fascia[1] + 0.05; A('frame').tube([W3(0.3, yc, 0.06), W3(L - 0.3, yc, 0.06)], 0.022, 4);
      const sr = 0.3 + R5() * (L - 0.6); A('frame').tube([W3(sr, yc, 0.06), W3(sr, Ht + 0.05, 0.06), W3(sr, Ht + 0.05, -0.3)], 0.02, 4);
    }
    if (street && l.floors >= 3 && L > 3 && R5() < 0.35) {   // empty projecting-sign brackets: two arms and a brace, 2F-4F
      const nb = 1 + (R5() < 0.4 ? 1 : 0);
      for (let k = 0; k < nb; k++) {
        const s0 = 0.5 + R5() * (L - 1.0), f = 1 + Math.floor(R5() * Math.min(3, l.floors - 2)), y0 = f * l.floorH + 0.5, h = 0.9 + R5() * 0.6, out = 0.5 + R5() * 0.3;
        for (const y of [y0, y0 + h]) A('frame').tube([W3(s0, y, 0.0), W3(s0, y, out)], 0.018, 4);
        A('frame').tube([W3(s0, y0 + 0.05, 0.0), W3(s0, y0 + h, out * 0.9)], 0.012, 3);
        A('frame').quad(W3(s0 - 0.07, y0 - 0.08, 0.012), W3(s0 + 0.07, y0 - 0.08, 0.012), W3(s0 + 0.07, y0 + h + 0.08, 0.012), W3(s0 - 0.07, y0 + h + 0.08, 0.012), [n[0], 0, n[1]]);   // the wall plate
        drip(a, t, n, s0, 0.16, y0 - 0.08, 0.6 + R5() * 1.4, 0.82, R5, true);   // rust off the plate
        facts.brackets = (facts.brackets || 0) + 1;
      }
    }
    if (street && rh.bands) for (let f = 1; f < Math.min(l.floors, 7); f++) {   // soffit dirt: water runs off the band lip, ragged
      const y = f * l.floorH - 0.1;
      for (let s = 0.1; s < L - 0.3; s += 0.9 + R5() * 1.4) { if (R5() < 0.5) continue; const w = 0.4 + R5() * 1.1; if (s + w > L - 0.05) break;
        drip(a, t, n, s + w / 2, w, y, 0.4 + R5() * (0.8 + age * 1.6), 0.86 - age * 0.1, R5); }
    }
  };
  for (const l of lots) {
    // [P3-C] every phase-3 draw comes from R2, so phase 2's stream (R) and the collider it shapes stay as they were
    let R = rng(l.id); const R1 = R, R2 = rng(l.id + ':p3'), P = l.footprint, H = l.floors * l.floorH, fmat = facadeOf(l);
    const [fa, fb] = l.frontage;
    const skind = streetById.get(l.street)?.kind || 'alley', comm = skind !== 'alley';
    const info = { id: l.id, H, facade: fmat, shopLit: false, shutter: false, fascia: null, fascias: [], bands: [], edges: [], floors: [], windows: [] };
    lotInfo.set(l.id, info);
    // per-lot tint and age (vertex colour multiplies the scan texture): +-10 % value, a warm/cool cast, grime with age
    // [P5-C] art #2: +-15 % value and a wider warm/cool cast (P4: +-10 %), so neighbouring walls of one scan read as two buildings
    const age = hash(l.id + 'age'), tv = 0.85 + hash(l.id + 'tv') * 0.3, cast = (hash(l.id + 'tc') - 0.5) * 0.14;
    const tint = [tv * (1 - age * 0.2) * (1 + cast), tv * (1 - age * 0.22), tv * (1 - age * 0.25) * (1 - cast)], dim = (k) => tint.map((v) => v * k);
    // facade rhythm
    let typ = l.floors >= 8 ? (R() < 0.5 ? 'curtain' : 'punched') : comm && l.floors <= 7 && R() < 0.45 ? 'ribbon' : !comm && l.floors >= 3 && R() < 0.4 ? 'villa' : 'punched';
    const rh = { bay: typ === 'villa' ? 2.6 + R() * 1.0 : 2.4 + R() * 1.7, ratio: 0.42 + R() * 0.38, h: 1.15 + R() * 0.65, sill: 0.75 + R() * 0.25, paneW: 1.5 + R() * 1.1,
      ribbonTop: 1 + Math.floor(R() * 3), bands: R() < 0.55, depth: 3.5 + R() * 2.5 };
    // tenants: one per upper floor; lit floors are whole floors
    const tower = l.floors >= 8 && (skind === 'main' || skind === 'walking');   // [P3-C] art #1: the station towers were black above 2F
    const pLow = comm ? 0.61 : 0.46, pHigh = Math.max(0.06, (l.use === 'hotel' ? 0.22 : tower ? 0.15 : 0.13) + (hash(l.id + 'ph') - 0.5) * 0.08);   // x 0.9 per window below
    for (let f = 1; f < l.floors; f++) { let use = draw(UPPER[skind] || UPPER.alley, R()); if (l.use === 'hotel' || l.use === 'motel') use = l.use; info.floors[f] = { f, lit: R() < (f <= 3 ? pLow : pHigh), use }; }
    // [P4-C] art #4 / lighting #3 (main-road towers): a tall lot is an office slab in bands. Curtain wall (1.5 m panes) or
    // band windows (1.2-1.5 m panes, 1.5-1.9 m tall, a 1.2-1.6 m spandrel) on every floor and every open wall (P3 gave its
    // side walls a few service windows: station2's "sticker" squares), floors 3F+ office, lit 35 % (towers) / 22 % (other
    // tall lots) at 4000-5000 K. Its own stream R3, so the low-rise stays as it was.
    const tall = l.floors >= 8, R3 = rng(l.id + ':p4');
    if (tall) {
      const r = R3(); typ = r < 0.45 ? 'curtain' : r < 0.85 ? 'band' : 'punched';
      rh.paneW = 1.2 + R3() * 0.3; rh.bandH = 1.5 + R3() * 0.4; rh.bandSill = 0.75 + R3() * 0.2; rh.bands = rh.bands || typ === 'band';
      if (typ === 'punched') { rh.bay = Math.min(rh.bay, 2.6); rh.ratio = Math.max(rh.ratio, 0.6); rh.h = Math.max(rh.h, 1.5); }
      const pT = (tower ? 0.37 : 0.24) + (hash(l.id + 'pt') - 0.5) * 0.08;   // x 0.9 per window: 35 % / 22 %
      // [P5-C] lighting #5 (tower white): 63 % office; 15 % flats (officetels: the warm 2800 K windows) from 9F up, above the
      // signs; the rest keep their trade. One draw either way, so the stream holds
      for (let f = 1; f < l.floors; f++) { const T = info.floors[f]; T.lit = R3() < (f <= 3 ? pLow : pT); if (f >= 2 && l.use !== 'hotel' && l.use !== 'motel') { const u3 = R3(); if (u3 < 0.63 || (u3 < 0.78 && f < 8)) T.use = 'office'; else if (u3 < 0.78) T.use = 'home'; } }
    }
    info.typ = typ;
    // walls + parapet
    for (let i = 0; i < P.length; i++) {
      R = R1;
      const a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz); if (L < 0.05) continue;
      const tx = dx / L, tz = dz / L, nx = tz, nz = -tx, mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, t2 = [tx, tz], n2 = [nx, nz], yaw = Math.atan2(-tz, tx);
      const Ht = H + K.parapet, us = hash(l.id + i) * 7;
      // exposure: is the space 1.5 m in front of this wall open (a street or a gap), at its middle and quarter points?
      const open = [0.25, 0.5, 0.75].filter((t) => !grid.inside(a[0] + dx * t + nx * 1.5, a[1] + dz * t + nz * 1.5, l)).length >= 2;
      // a wall facing a gap under 3.2 m (the slot between two buildings): windows, but no AC units or lips in the slot
      const slot = open && [0.25, 0.5, 0.75].filter((t) => grid.inside(a[0] + dx * t + nx * 3.2, a[1] + dz * t + nz * 3.2, l)).length >= 2;
      const front = (Math.hypot(a[0] - fa[0], a[1] - fa[1]) < 0.05 && Math.hypot(b[0] - fb[0], b[1] - fb[1]) < 0.05);
      const streetSide = !front && open && !slot && streetDist(mx + nx * 2, mz + nz * 2) < 1.0;   // a corner lot's second street face
      const sideKind = streetSide ? nearKind : null;
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
      if (tall) R = R3;   // [P4-C] a tall lot's windows draw from its own stream
      const gridWall = front || streetSide || (tall && !slot && L > 4);   // [P4-C] a tower has windows on every open wall
      if (gridWall) {
        for (let f = 1; f < l.floors; f++) {
          const fy = f * l.floorH;
          if (typ === 'curtain') { const n = Math.max(1, Math.round((L - 0.4) / 1.5)), pw = (L - 0.4) / n; for (let k = 0; k < n; k++) wins.push({ f, s: 0.2 + (k + 0.5) * pw, w: pw - 0.08, h: l.floorH - 0.95, y0: fy + 0.1 }); }
          else if (typ === 'band') { const n = Math.max(1, Math.round((L - 0.6) / rh.paneW)), pw = (L - 0.6) / n; for (let k = 0; k < n; k++) wins.push({ f, s: 0.3 + (k + 0.5) * pw, w: pw - 0.06, h: Math.min(rh.bandH, l.floorH - rh.bandSill - 0.25), y0: fy + rh.bandSill, band: true }); }
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
          o = TENANT[T?.use] || TENANT.home; if (tall && o === TENANT.office) o = TOWER_OFFICE; else if (tall && o === TENANT.hotel && hash(l.id + ':ht' + W.f) < 0.6) o = TOWER_HOTEL; room = o.room[Math.floor(R() * o.room.length)]; lit = !!T?.lit && R() < 0.9;
          const r = R();
          if (lit && r < 0.15) fr = FRONT.blinds;                                       // a lit floor with this blind down
          else if (o === TENANT.home) fr = r < 0.5 ? FRONT.curtain : r < 0.65 ? FRONT.blinds : 0;
          else if (o === TENANT.office || o === TOWER_OFFICE) fr = r < 0.35 ? FRONT.blinds : 0;
          else if (!lit) fr = r < 0.3 ? FRONT.blinds : r < 0.45 ? FRONT.curtain : 0;
        }
        // [P4-C] fpv #3: 15 % of the dark windows are dim-lit at 1.5-3 nits (a TV in a dark room, a lamp left on, a corridor
        // light on an office floor), the rest 0.5-1.2 (spill), so a dark facade is not one flat value. Keyed by a hash, not R.
        const u = R(), wh = hash(l.id + ':w' + i + ':' + W.f + ':' + W.s.toFixed(1)), dimLit = !lit && !W.stair && wh < 0.15;
        if (dimLit) { if (o === TENANT.home || o === TENANT.study || W.small) { room = wh < 0.08 ? ROOM.tv : ROOM.home; fr = room === ROOM.tv ? 0 : fr; } facts.windowsDim = (facts.windowsDim || 0) + 1; }
        const nits = lit ? lerp(o.nits[0], o.nits[1], u) : dimLit ? 1.5 + u * 1.5 : 0.5 + u * 0.7;
        const em = emOf(lit ? o : dimLit ? (room === ROOM.tv ? { cct: 6500 } : { cct: room === ROOM.office ? 4500 : 2900 }) : SPILL, nits, R(), room + 32 * fr + Math.min(0.999, R()));
        facts.windows++; if (lit) facts.windowsLit++; facts.winNits += nits;
        const sillLocal = Math.max(0.05, Math.min(1.6, W.y0 - W.f * l.floorH - (W.stair ? l.floorH * 0.5 : 0)));
        // [P3-C] security grilles (방범창) on 2F-3F flats and service windows: drawn by the glass shader at the facade plane
        const homeLike = W.small || o === TENANT.home || o === TENANT.study || typ === 'villa';
        const grille = !W.stair && W.f <= 2 && homeLike && R2() < (front || streetSide ? 0.55 : 0.7);
        if (grille) facts.grilles++;
        pane('glass', [cx, cz], t2, n2, W.w, W.h, W.y0, em, [W.w, W.h, sillLocal, (W.stair ? 2.5 : rh.depth + u) + (grille ? 100 : 0)]);
        if (gridWall) info.windows.push({ f: W.f, c: [+cx.toFixed(2), +(W.y0 + W.h / 2).toFixed(2), +cz.toFixed(2)], n: [nx, 0, nz], t: [tx, 0, tz], w: +W.w.toFixed(2), h: +W.h.toFixed(2), lit, nits: +nits.toFixed(1), ...(dimLit ? { dim: true } : {}), ...(front || streetSide ? {} : { side: true }) });
        // sill (render only) and, on older buildings, a leak streak from one end of it
        if (W.sill && !W.stair) {
          { const hw = W.w / 2 + 0.06, y1 = W.y0 - 0.005, y0 = W.y0 - 0.075, o = 0.09, Q = (s, y, d) => [a[0] + tx * (W.s + s) + nx * d, y, a[1] + tz * (W.s + s) + nz * d];
            A('sill').quad(Q(-hw, y1, 0), Q(hw, y1, 0), Q(hw, y1, o), Q(-hw, y1, o), [0, 1, 0], [[0, 0], [2 * hw, 0], [2 * hw, o], [0, o]]);
            A('sill').quad(Q(-hw, y0, o), Q(hw, y0, o), Q(hw, y1, o), Q(-hw, y1, o), [nx, 0, nz], [[0, 0], [2 * hw, 0], [2 * hw, 0.07], [0, 0.07]]);
            A('sill').quad(Q(-hw, y0, 0), Q(hw, y0, 0), Q(hw, y0, o), Q(-hw, y0, o), [0, -1, 0], [[0, 0], [2 * hw, 0], [2 * hw, o], [0, o]]); }
          let dripped = false;
          if (age > 0.45 && R() < 0.4) { dripped = true; const side = R() < 0.5 ? -1 : 1, s = W.s + side * (W.w / 2 - 0.05), ww = 0.15 + R() * 0.25, len = 0.8 + R() * 1.6;
            wallDecal(a, t2, n2, s - ww / 2, s + ww / 2, Math.max(0.2, W.y0 - 0.07 - len), W.y0 - 0.07, 0.72 - age * 0.12, 1.0); }
          // [P5-C] art #2 / graphics #1: every other sill weeps too (its own stream): ragged streaks under both ends and the middle
          if (!dripped && (front || streetSide) && W.f <= 6) { const R5 = rng(l.id + ':sd' + i + ':' + W.f + ':' + W.s.toFixed(1));
            for (const e of [-0.42, 0.42]) if (R5() < 0.75) drip(a, t2, n2, W.s + e * W.w, 0.12 + R5() * 0.22, W.y0 - 0.075, 0.35 + R5() * (0.6 + age * 1.8), 0.82 - age * 0.12, R5); }
        } else if (!W.stair && !W.small && (front || streetSide) && W.f <= 6 && W.y0 - W.f * l.floorH > 0.3) {   // [P5-C] ribbon / band glass: the frame's bottom rail weeps
          const R5 = rng(l.id + ':rd' + i + ':' + W.f + ':' + W.s.toFixed(1));
          if (R5() < 0.7) drip(a, t2, n2, W.s + (R5() - 0.5) * W.w * 0.8, 0.15 + R5() * 0.3, W.y0 - 0.02, 0.3 + R5() * (0.5 + age * 1.5), 0.84 - age * 0.12, R5);
        }
        // AC units: side and back walls by a window, or high on older fronts (the real Seoul pattern), with a rust streak
        // [P3-C] art #2: ~1 unit per 2 windows on side and rear walls (phase 2's 30 % from R, the rest from R2)
        let Q = null;
        // [P4-C] no split units on a tower's glass
        if (W.f >= 1 && !slot && !W.stair && !(tall && typ !== 'punched')) { if (R() < (front || streetSide ? (age > 0.4 ? 0.1 : 0.03) : 0.3)) Q = R; else if (!front && !streetSide && R2() < 0.18) Q = R2; }
        if (Q) {
          facts.ac++; const sd = Q() < 0.5 ? -1 : 1, sa = W.s + (W.w / 2 + 0.55) * sd; if (sa < 0.5 || sa > L - 0.5) continue;
          const ax = a[0] + tx * sa + nx * 0.2, az = a[1] + tz * sa + nz * 0.2, ac = 0.8 + Q() * 0.25, ay = W.y0 - 0.25;
          Acc.tint = [ac, ac * 0.99, ac * (0.9 + Q() * 0.1)];
          if (acE) (info.ac ||= []).push({ c: [+ax.toFixed(3), +ay.toFixed(3), +az.toFixed(3)], n: [nx, 0, nz], size: [0.84, 0.64, 0.34], tint: Acc.tint.slice() });   // [P3-E1] E draws it
          else { A('white').box([ax, ay, az], [0.42, 0.32, 0.17], yaw, false); acFront(a, t2, n2, sa, ay, 0.37); }   // outdoor unit + its face (no E kit)
          Acc.tint = tint;
          wallDecal(a, t2, n2, sa - 0.06, sa + 0.06, Math.max(0.2, W.y0 - 1.6), W.y0 - 0.6, 0.8, 1.0);
        }
      }
      if (tall) R = R1;
      // [P3-C] art #1 / art bug (club90's 20 m dead frontage): a corner lot's second face on a commercial street is a shopfront too
      const sideShop = !front && streetSide && sideKind !== 'alley' && L > 3.2;
      if (front || streetSide || (open && !slot)) { const got = facadeKit(l, info, a, t2, n2, L, H, Ht, yaw, typ, rh, R2, front, front || streetSide);
        wallKit5(l, info, a, t2, n2, L, H, Ht, yaw, rh, got, front, front || streetSide, age, slot); }
      if (!front && !sideShop) { Acc.tint = WHITE; continue; }
      // ---- ground floor: shopfront bays (interior-mapped), a framed door, posters; or a shutter. Sign bed above.
      if (sideShop) R = R2;
      const look = USE_LOOK[l.use] || USE_LOOK.shop;
      let shut = R() < look.shut * (sideShop ? 0.4 : 1); if (front) { info.shutter = shut; info.shopLit = !shut; } else facts.sideShops++;
      // [P4-C] (club90's dead corner) a corner lot's second shopfront is its other door: shut on 30 % of the faces that drew
      // a shutter (shops that close keep their shutters; a cafe or bar open at 01:00 is open on both faces)
      if (sideShop && shut && hash(l.id + ':sd' + i) > 0.3) shut = false;
      const w0 = 0.4, w1 = L - 0.4, gw = w1 - w0, Pt = (s, y, o = 0) => [a[0] + tx * s + nx * o, y, a[1] + tz * s + nz * o];
      if (gw > 0.8) {
        if (shut) {
          facts.shutters++;
          const p0 = Pt(w0, 0, 0.04), p1 = Pt(w1, 0, 0.04);
          A(front ? 'shutter' : 'shutterR').quad([p0[0], 0.02, p0[2]], [p1[0], 0.02, p1[2]], [p1[0], K.shopTop, p1[2]], [p0[0], K.shopTop, p0[2]], [nx, 0, nz], [[0, 0], [gw, 0], [gw, K.shopTop], [0, K.shopTop]]);
          A(front ? 'metal' : 'shutterR').box(Pt((w0 + w1) / 2, K.shopTop + 0.15, 0.19), [gw / 2, 0.15, 0.15], yaw, false);   // the shutter box above (corner faces: render only)
        } else {
          facts.shopsLit++;
          let nitsS = lerp(look.nits[0], look.nits[1], R()), cu = R(), room = look.room[Math.floor(R() * look.room.length)];
          const lobF = tower && front, lk = lobF ? USE_LOOK.lobby : look;
          if (lobF) { nitsS = lerp(lk.nits[0], lk.nits[1], cu); room = ROOM.lobby; }   // [P4-C] the podium is a lobby that renders
          const fr = look.front && R() < look.front[1] ? look.front[0] : 0, D = 5 + R() * 4;
          const nb = Math.max(1, Math.round(gw / (1.8 + hash(l.id + 'bw') * 1.2))), bwid = gw / nb, door = nb === 1 ? 0 : nb >= 3 && R() < 0.4 ? Math.floor(nb / 2) : R() < 0.5 ? 0 : nb - 1;
          for (let k = 0; k < nb; k++) {
            const sc = w0 + (k + 0.5) * bwid, isDoor = k === door;
            pane('shop', [a[0] + tx * sc + nx * 0.04, a[1] + tz * sc + nz * 0.04], t2, n2, bwid - 0.02, K.shopTop, 0, emOf(lk, nitsS, cu, room + 32 * (lobF ? 0 : isDoor && fr === FRONT.cafeCurtain ? 0 : fr) + Math.min(0.999, R())), [bwid - 0.02, K.shopTop, (isDoor ? 2 : 1) * 4, D]);
            if (k < nb - 1) A('frame').box(Pt(w0 + (k + 1) * bwid, K.shopTop / 2, 0.08), [0.035, K.shopTop / 2, 0.05], yaw, true);
            if (isDoor) {   // door: jambs, header at 2.2 m, a push bar
              for (const e of [-1, 1]) A('frame').box(Pt(sc + e * (bwid / 2 - 0.05), 1.1, 0.09), [0.03, 1.1, 0.045], yaw, true);
              A('frame').box(Pt(sc, 2.2, 0.09), [bwid / 2 - 0.02, 0.035, 0.045], yaw, false);
              A('frame').box(Pt(sc, 1.02, 0.15), [Math.min(0.45, bwid * 0.35), 0.016, 0.02], yaw, false);
            } else if (R() < 0.55 && !lobF) {   // a poster or two on the glass, backlit by the shop
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
          const c = Pt((w0 + w1) / 2, K.shopTop / 2, 0.05), col = colourOf(lk, cu), cY = lumOf(col);   // L3: rgb at luminance 1, nits = luminance
          // [P3-C] contract P3-CD (D's lighting #4): a main-road tower's podium glass is a 'lobby' record (80-150 nits)
          const lob = tower && front, lobN = nitsS * cY;   // [P4-C] the record is what the glass renders (lobby 85-110)
          emitters.push({ id: (lob ? 'lobby:' : 'store:') + l.id + (front ? '' : ':' + i), pos: [+c[0].toFixed(2), +c[1].toFixed(2), +c[2].toFixed(2)], normal: [+nx.toFixed(3), 0, +nz.toFixed(3)], w: +gw.toFixed(2), h: K.shopTop,
            rgb: col.map((v) => +(v / cY).toFixed(3)), nits: Math.round(lobN), kind: lob ? 'lobby' : 'store', animated: false, lot: l.id });
        }
        // sign bed (aluminium composite panel), 2.9-4.0 m, 8 cm proud: charcoal on most lots, grey or dull white on some
        const [fy, fh, fd] = K.fascia, fc = [(a[0] + b[0]) / 2 + nx * fd / 2, fy + fh / 2, (a[1] + b[1]) / 2 + nz * fd / 2], fr2 = hash(l.id + 'bed');
        const bed = fr2 < 0.6 ? 0.06 + hash(l.id + 'bv') * 0.05 : fr2 < 0.85 ? 0.16 + hash(l.id + 'bv') * 0.08 : 0.32;
        Acc.tint = [bed * (1 - age * 0.15), bed * (1 - age * 0.17), bed * (1 - age * 0.15) * 1.03];
        A(front ? 'fascia' : 'bed').box(fc, [L / 2, fh / 2, fd / 2], yaw, false);
        Acc.tint = tint;
        const fx = { c: [fc[0] + nx * fd / 2, fc[1], fc[2] + nz * fd / 2], normal: [nx, 0, nz], t: [tx, 0, tz], w: L, h: fh, side: !front, lit: !shut };
        if (front) info.fascia = fx; info.fascias.push(fx);   // [P3-C] B: every sign bed, corner faces included
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
      const yaw = Math.atan2(-(fb[1] - fa[1]), fb[0] - fa[0]); A(fmat === 'brick' ? 'brick' : 'concrete').box([s[0], H + 1.3, s[1]], [1.5, 1.3, 1.6], yaw); A('roof').box([s[0], H + 2.65, s[1]], [1.7, 0.05, 1.8], yaw); info.roof.push({ kind: 'stair', x: s[0], z: s[1], top: H + 2.7 });
      // [P3-C] art #6 (aerial read): the door glows and a wall pack lights the roof (and its tank)
      if (R2() < 0.75) {
        const cs = Math.cos(yaw), sn = Math.sin(yaw), n2 = [cs, -sn], t2 = [sn, cs], dc = [s[0] + cs * 1.53, s[1] - sn * 1.53];
        pane('glass', dc, t2, n2, 0.9, 2.05, H + 0.02, emOf({ cct: 3500 }, 10 + R2() * 8, R2(), ROOM.stair + Math.min(0.999, R2())), [0.9, 2.05, 8, 2.5]);
        const lm = 900, lw = 0.22, lh = 0.1, ln = Math.round(lm / (Math.PI * lw * lh)), lc = lightRGB(3500), lp = [s[0] + cs * 1.62, H + 2.32, s[1] - sn * 1.62];
        A('pole').box([s[0] + cs * 1.58, H + 2.35, s[1] - sn * 1.58], [0.08, 0.06, 0.13], yaw, false);
        Acc.win = [lw, lh, 16, 0]; A('lamp').quad([lp[0] - sn * lw / 2 - cs * lh / 2, lp[1] - 0.06, lp[2] - cs * lw / 2 + sn * lh / 2], [lp[0] + sn * lw / 2 - cs * lh / 2, lp[1] - 0.06, lp[2] + cs * lw / 2 + sn * lh / 2], [lp[0] + sn * lw / 2 + cs * lh / 2, lp[1] - 0.06, lp[2] + cs * lw / 2 - sn * lh / 2], [lp[0] - sn * lw / 2 + cs * lh / 2, lp[1] - 0.06, lp[2] - cs * lw / 2 - sn * lh / 2], [0, -1, 0], undefined, [lc[0] * ln * NIT, lc[1] * ln * NIT, lc[2] * ln * NIT, 0]); Acc.win = WIN0;
        emitters.push({ id: 'roof:' + l.id, pos: [+lp[0].toFixed(2), +(lp[1] - 0.06).toFixed(2), +lp[2].toFixed(2)], normal: [+(cs * 0.45).toFixed(3), -0.893, +(-sn * 0.45).toFixed(3)], w: lw, h: lh, rgb: lc.map((v) => +v.toFixed(3)), nits: ln, kind: 'street', role: 'roof', animated: false, lumens: lm, cct: 3500, lot: l.id });
        facts.roofLamps++;
      } } }
    // [P3-C] roof rails on a third of the low roofs (render only: 2 cm steel), stair-house-free edges included
    if (l.floors <= 7 && R2() < 0.35) { facts.rails++;
      for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
        const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L, nx = tz, nz = -tx, o = -0.1, yt = H + K.parapet + 0.5, yaw = Math.atan2(-tz, tx);
        A('frame').tube([[a[0] + nx * o + tx * 0.1, yt, a[1] + nz * o + tz * 0.1], [b[0] + nx * o - tx * 0.1, yt, b[1] + nz * o - tz * 0.1]], 0.02, 4);
        for (let q = 0.1; q < L - 0.05; q += Math.max(1.6, (L - 0.2) / Math.ceil((L - 0.2) / 2.2))) A('frame').tube([[a[0] + nx * o + tx * q, H + K.parapet, a[1] + nz * o + tz * q], [a[0] + nx * o + tx * q, yt, a[1] + nz * o + tz * q]], 0.018, 3); } }
    // [P3-C] a rooftop sign frame facing the street on ~30 % of commercial roofs (B: lotInfo roofSign is the face to fill)
    { const fl = Math.hypot(fb[0] - fa[0], fb[1] - fa[1]), comm2 = (streetById.get(l.street)?.kind || 'alley') !== 'alley';
      if (comm2 && l.floors >= 4 && l.floors <= 9 && area > 60 && fl > 4 && R2() < 0.3) {
        const tx = (fb[0] - fa[0]) / fl, tz = (fb[1] - fa[1]) / fl, nx = tz, nz = -tx, yaw = Math.atan2(-tz, tx), w = Math.min(8, fl * 0.7), h = 1.6 + R2() * 1.0, y0 = H + K.parapet + 0.3;
        const c = [(fa[0] + fb[0]) / 2 - nx * 1.0, (fa[1] + fb[1]) / 2 - nz * 1.0];
        if (pip(c[0] - nx * 0.6, c[1] - nz * 0.6, P)) {
          facts.roofSigns++;
          for (const e of [-0.5, 0, 0.5]) { A('frame').box([c[0] + tx * e * (w - 0.1) - nx * 0.25, (H + y0 + h) / 2, c[1] + tz * e * (w - 0.1) - nz * 0.25], [0.04, (y0 + h - H) / 2, 0.04], yaw, false);
            A('frame').box([c[0] + tx * e * (w - 0.1) - nx * 0.55, (H + y0) / 2, c[1] + tz * e * (w - 0.1) - nz * 0.55], [0.03, (y0 - H) / 2, 0.03], yaw, false); }
          for (const y of [y0, y0 + h]) A('frame').box([c[0] - nx * 0.25, y, c[1] - nz * 0.25], [w / 2, 0.035, 0.035], yaw, false);
          A('frame').box([c[0] - nx * 0.15, y0 + h / 2, c[1] - nz * 0.15], [w / 2, h / 2, 0.03], yaw, false);   // the backing panel
          info.roofSign = { c: [+(c[0] - nx * 0.11).toFixed(2), +(y0 + h / 2).toFixed(2), +(c[1] - nz * 0.11).toFixed(2)], normal: [+nx.toFixed(3), 0, +nz.toFixed(3)], t: [+tx.toFixed(3), 0, +tz.toFixed(3)], w: +w.toFixed(2), h: +h.toFixed(2) };
        } } }
    // [P3-C] main-road towers: an LED wash line under the coping on their street faces (architectural lighting, 600 nits)
    if (tower) for (const e of info.edges) { if (!(e.front || e.streetSide) || e.L < 3) continue;
      const c = [(e.a[0] + e.b[0]) / 2 + e.nx * 0.05, (e.a[1] + e.b[1]) / 2 + e.nz * 0.05], lc = lightRGB(4300);
      pane('lamp', c, [e.tx, e.tz], [e.nx, e.nz], e.L - 0.3, 0.07, H + K.parapet - 0.2, [lc[0] * 600 * NIT, lc[1] * 600 * NIT, lc[2] * 600 * NIT, 0], [e.L - 0.3, 0.07, 16, 0]);
      // contract P3-CD: the crown wash on the top two floors, a record 1.5 m off the wall facing it, tilted up 35 degrees
      const bh = 2 * l.floorH, by = H - bh / 2, cw = lightRGB(4300), up = 0.574, hz = 0.819;
      emitters.push({ id: 'crown:' + l.id + ':' + e.tx.toFixed(2), pos: [+(c[0] + e.nx * 1.45).toFixed(2), +(by - bh / 2).toFixed(2), +(c[1] + e.nz * 1.45).toFixed(2)], normal: [+(-e.nx * hz).toFixed(3), up, +(-e.nz * hz).toFixed(3)],
        w: +(e.L - 0.4).toFixed(2), h: +bh.toFixed(2), rgb: cw.map((v) => +v.toFixed(3)), nits: 25, kind: 'crown', animated: false, lot: l.id }); facts.crowns = (facts.crowns || 0) + 1; }
    if (area > 40 && l.floors <= 8 && R() < 0.55) { const s = roofSpot(1.6); if (s) { // water tank on a steel stand (FRP / stainless)
      facts.tanks++; const r = 0.6 + R() * 0.5, h = 1.2 + R() * 0.6;
      A('metal').box([s[0], H + 0.25, s[1]], [r + 0.1, 0.25, r + 0.1], 0, false);
      A(R() < 0.5 ? 'white' : 'metal').cyl([s[0], H + 0.5, s[1]], r, h, 10); info.roof.push({ kind: 'tank', x: s[0], z: s[1], top: H + 0.5 + h }); } }
    if (area > 80 && R() < 0.5) { const s = roofSpot(1.2); if (s) { facts.ac++; const ya = R() * 3; if (acE) (info.ac ||= []).push({ c: [s[0], H + 0.55, s[1]], n: [Math.sin(ya), 0, Math.cos(ya)], size: [1.0, 1.1, 0.7], roof: true }); else A('white').box([s[0], H + 0.55, s[1]], [0.5, 0.55, 0.35], ya); } }   // condenser ([P3-E1] E draws it)
  }

  // ---------------- street lights. [P2-C] (lighting #6) nits from lumens for a Lambertian head (nits = lm / (pi x area)), so
  // the L3 records are self-consistent (12 klm cobra head: ~28,000 nits; phase 1 had 9,000, a third of its flux); main roads
  // get opposite pairs every 32 m (was staggered), pedestrian posts 4 klm, and every second alley pole a 3000 K security lamp.
  // [P5-A] colour #4 (mixed white balance): road and pedestrian posts are half 3000 K (old high-pressure sodium refits) and half
  // 4000 K LED, per pole by a hash of its position; security lamps stay 3000 K.
  const LAMP = { main: { lumens: 12000, cct: 4000, w: 0.56, h: 0.24, mix: [3000, 4000] }, ped: { lumens: 6000, cct: 3500, w: 0.56, h: 0.24, mix: [3000, 4000] }, security: { lumens: 3000, cct: 3000, w: 0.3, h: 0.15 } };
  const lampHead = (x, z, ox, oz, h, arm, spec = LAMP.main, pole = true) => {
    const cct = spec.mix ? spec.mix[hash(`lamp:${x.toFixed(1)}:${z.toFixed(1)}`) < 0.5 ? 0 : 1] : spec.cct;
    const px = x + ox * arm, pz = z + oz * arm, nits = Math.round(spec.lumens / (Math.PI * spec.w * spec.h)), rgb = lightRGB(cct), hw = spec.w / 2, hd = spec.h / 2;
    if (pole) A('pole').tube([[x, 0, z], [x, h, z], [x + ox * 0.4, h + 0.3, z + oz * 0.4], [px, h + 0.35, pz]], 0.09, 6);
    else A('pole').tube([[x, h + 0.35, z], [px, h + 0.35, pz]], 0.04, 4);
    A('pole').box([px, h + 0.3, pz], [hw + 0.04, 0.08, hd + 0.06], Math.atan2(-oz, ox), false);
    Acc.win = [spec.w, spec.h, 16, 0];   // [P3-C] kind 4: a flat emitter inside the glass mesh
    A('lamp').quad([px - ox * hw - oz * hd, h + 0.215, pz - oz * hw + ox * hd], [px + ox * hw - oz * hd, h + 0.215, pz + oz * hw + ox * hd], [px + ox * hw + oz * hd, h + 0.215, pz + oz * hw - ox * hd], [px - ox * hw + oz * hd, h + 0.215, pz - oz * hw - ox * hd], [0, -1, 0], undefined, [rgb[0] * nits * NIT, rgb[1] * nits * NIT, rgb[2] * nits * NIT, 0]);
    Acc.win = WIN0;
    emitters.push({ id: 'street:' + emitters.length, pos: [+px.toFixed(2), +(h + 0.2).toFixed(2), +pz.toFixed(2)], normal: [0, -1, 0], w: spec.w, h: spec.h, rgb: rgb.map((v) => +v.toFixed(3)), nits, kind: 'street', animated: false, lumens: spec.lumens, cct, ...(spec === LAMP.security ? { role: 'security' } : spec === LAMP.ped ? { role: 'pedestrian' } : {}) });
    facts.streetLights++;
  };
  const along = (pts, step, fn) => { let carry = step / 2; for (let i = 0; i < pts.length - 1; i++) { const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < 0.1) continue; const tx = (bx - ax) / L, tz = (bz - az) / L; let s = carry; for (; s < L; s += step) fn(ax + tx * s, az + tz * s, tx, tz); carry = s - L; } };
  const clearSpot = (x, z, r) => !grid.inside(x, z) && !grid.near(x, z).some((l) => polyD(x, z, l.footprint) < r) && x > B.x0 && x < B.x1 && z > B.z0 && z < B.z1;
  for (const s of streets) {
    if (s.kind !== 'main' || s.width < 7) continue;
    along(s.points, 32, (x, z, tx, tz) => { for (const side of [1, -1]) { const off = s.width / 2 + 0.7, ox = -tz * side, oz = tx * side, px = x + ox * off, pz = z + oz * off;
      if (clearSpot(px, pz, 0.8)) lampHead(px, pz, -ox, -oz, 8.5, 1.6, LAMP.main); } });
  }
  // walking and club streets: 4.5 m pedestrian posts, staggered, at the edge of the paving (pulled in where facades close in)
  // [P4-D] posts keep 2 m (post + arm) off every gate and pre-gate of lines.json (a gate's centre line, c +- u w/2)
  const gateSegs = []; for (const ln of lineData?.lines || []) for (const G of [ln, ...(ln.pre || [])]) if (G?.c && G.u && G.w) gateSegs.push([G.c[0] - G.u[0] * G.w / 2, G.c[2] - G.u[2] * G.w / 2, G.c[0] + G.u[0] * G.w / 2, G.c[2] + G.u[2] * G.w / 2]);
  // ... and 4 m off every start point (lines.json startPoints / takeStart, the layout spawn): nothing in the lens at a start
  for (const sp of [...(lineData?.startPoints || []), lineData?.takeStart, layout.spawn]) if (sp?.pos) gateSegs.push([sp.pos[0], sp.pos[2], sp.pos[0], sp.pos[2], 4.0]);
  const offGates = (x, z) => gateSegs.every(([ax, az, bx, bz, r = 2.0]) => { const vx = bx - ax, vz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz || 1))); return Math.hypot(ax + vx * t - x, az + vz * t - z) > r; });
  let side = 1;
  for (const s of streets) {
    if (s.kind !== 'walking' && s.kind !== 'club') continue;
    along(s.points, 16, (x, z, tx, tz) => { side = -side; const ox = -tz * side, oz = tx * side;   // [P4-D] lighting #1: 6 klm every 16 m (was 4 klm / 24 m)
      for (let off = s.width / 2 - 0.4; off >= 1.2; off -= 0.5) { const px = x + ox * off, pz = z + oz * off; if (clearSpot(px, pz, 0.6) && offGates(px, pz)) { lampHead(px, pz, -ox, -oz, 4.5, 0.5, LAMP.ped); break; } } });
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
      if (poles.length % 2 === 0) lampHead(px, pz, -ox, -oz, 6.0, 0.9, LAMP.security, false);   // 3000 K security lamp toward the lane
      if (prev && Math.hypot(prev.x - px, prev.z - pz) < 45) spanCables(prev, p, R);
      // service drops to the facades across the street (2-3 per pole)
      for (let k = 0; k < 2 + Math.floor(R() * 2); k++) {
        const along2 = (R() - 0.5) * 10, qx = x + tx * along2 - ox * (s.width / 2 + 0.05), qz = z + tz * along2 - oz * (s.width / 2 + 0.05);
        const hit = grid.near(qx, qz).find((l) => polyD(qx, qz, l.footprint) < 0.6);
        if (!hit) continue;
        const ya = p.h - 1.0 - R() * 1.5, yb = Math.min(hit._H - 0.5, 4.2 + R() * 2.5);
        { const r = 0.012 + R() * 0.01, pts = catenary([px, ya, pz], [qx, yb, qz], 0.03 + R() * 0.02, r); cables.push({ a: pts[0], b: pts[pts.length - 1], low: Math.min(...pts.map((v) => v[1])), pts, r, drop: true }); }
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
      cables.push({ a: [p.x, ya, p.z], b: [q.x, yb, q.z], low: Math.min(...pts.map((v) => v[1])), pts, r });   // pts, r: E's screen-space line renderer
    }
  }

  // ---------------- [P2-C] stream E's street dressing (contract P2-1), tolerated missing: render geometry by material, collider
  // triangles, emitters (L3) and set pieces. Keys that match ours merge into our meshes; new keys keep their own material
  // (seoul-dressing's MATS / materials, SEOUL_MATS schema).
  const merged = {}, dressing = { keys: [], colTris: 0, emitters: 0, setPieces: [], materials: {}, error: null, out: null };
  const DM = opts.dressing === false ? null : (opts.dressing || DRESSING);
  let d = null;
  if (DM && typeof DM.geometry === 'function') {
    try { d = DM.geometry(layout, { seed, lotInfo, poles, cables, streets, lines: lineData, emitters: emitters.slice(), shopTop: K.shopTop, fasciaY: K.fascia[0], NITS }) || {}; }
    catch (e) { dressing.error = String(e?.message || e); console.warn('seoulDressing.geometry', e); d = null; }
  }
  // E's ground openings (stairwells): the ground is re-cut around them
  if (d?.holes?.length && typeof DM.groundTris === 'function') {
    try { const x0 = B.x0 - 80, x1 = B.x1 + 80, z0 = B.z0 - 80, z1 = B.z1 + 80, g = new Acc(false);
      for (const [p, q, r] of DM.groundTris(x0, z0, x1, z1, d.holes)) { const P3 = (v) => [v[0], 0, v[1]]; const cr = (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]);
        if (cr >= 0) g.tri(P3(p), P3(q), P3(r), p, q, r); else g.tri(P3(p), P3(r), P3(q), p, r, q); }
      acc.walk = g; } catch (e) { console.warn('seoul ground holes', e); }
  }
  for (const [k, a] of Object.entries(acc)) { const g = a.geometry(); if (g) merged[k] = g; }
  const own = { ...merged };   // our part of each mesh: the collider (E's triangles collide through its colTris)
  let dressCol = null;
  if (d) {
    try {
      dressing.out = d;
      Object.assign(dressing.materials, DM.DRESS_MATS || DM.MATS || DM.materials || {}, d.materials || {});
      for (const [k, g0] of Object.entries(d.merged || {})) {
        if (!g0?.getAttribute?.('position')) continue;
        if (merged[k]) { const g = conform(g0, merged[k]); if (g) merged[k] = mergeGeometries([merged[k], g], false); else merged['E:' + k] = g0; }
        else merged[k] = g0;
        dressing.keys.push(k);
      }
      if (d.colTris?.getAttribute?.('position')) { dressCol = d.colTris.index ? d.colTris.toNonIndexed() : d.colTris; dressing.colTris = dressCol.getAttribute('position').count / 3; }
      for (const e of d.emitters || []) emitters.push(e);
      dressing.emitters = (d.emitters || []).length; dressing.setPieces = d.setPieces || [];
    } catch (e) { dressing.error = String(e?.message || e); console.warn('seoulDressing merge', e); }
  }
  facts.dressing = { keys: dressing.keys.length, colTris: dressing.colTris, emitters: dressing.emitters, setPieces: dressing.setPieces.length, ...(dressing.error ? { error: dressing.error } : {}) };
  // ---------------- merge per material, collider
  const posOnly = (g) => { const h = new THREE.BufferGeometry(); h.setAttribute('position', (g.index ? g.toNonIndexed() : g).getAttribute('position')); return h; };
  const dressNoCol = new Set(Object.entries(dressing.materials).filter(([, m]) => m.collide === false || m.noCol || m.decal).map(([k]) => k));
  // dressing meshes collide through E's colTris only (render meshes of E's own keys stay out of our collider)
  const colKeys = Object.keys(merged).filter((k) => !noCol.has(k) && !dressNoCol.has(k) && (SEOUL_MATS[k] && !k.startsWith('E:'))), colRanges = [];
  const colParts = colKeys.map((k) => posOnly(own[k] || merged[k]));
  if (dressCol) { colKeys.push('dressing'); colParts.push(posOnly(dressCol)); }
  // [P4-B] native #5: the sign housings (blades, light boxes, stands, raceways, screen cabinets), placed on this build's lotInfo
  // slots by seoul-signs' pure colliderTris. Always in the collider depth pass (buildSeoul's colliderScene: SSAO sees them);
  // in the physics BVH / colGeo / export only with SIGN_COLLIDE (or opts.signCollide), because they close 32 of lines.json's
  // 221 gates: flip it together with a re-run of seoul/tools/lines.mjs (F1), then re-record the Seoul parity vectors.
  let signCol = null;
  if (opts.signs !== false && SIGNS?.colliderTris) {
    try { const sp = SIGNS.colliderTris(layout, { seed, lotInfo }); if (sp?.length) { signCol = new THREE.BufferGeometry(); signCol.setAttribute('position', new THREE.BufferAttribute(sp, 3)); facts.signColTris = sp.length / 9; } }
    catch (e) { console.warn('seoulSigns.colliderTris', e); }
  }
  const signCollide = !!signCol && (opts.signCollide ?? SIGN_COLLIDE);
  if (signCollide) { colKeys.push('signs'); colParts.push(signCol); }
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

  // [P3-C] perf #1 (with D): draw by atlas group, not by scan. byKey keeps the per-material meshes (collider ranges, tests);
  // `merged` is what is drawn and exported: ground (road/walk/plaza) and city (every opaque facade, trim and prop layer,
  // with E's plain opaque keys folded in) carry aLay, a layer index into SEOUL_LAYERS / the KTX2 texture arrays; glass
  // holds windows, shops, posters and lamp heads (kind 4); lanepaint the stripes (colour baked); ao the multiply decals.
  const byKey = merged, grouped = groupMeshes(byKey, dressing.materials);
  facts.groups = Object.fromEntries(Object.entries(grouped.merged).map(([k, g]) => [k, g.getAttribute('position').count / 3]));
  const L = lineData || {};
  const v3 = (p) => p;
  return {
    merged: grouped.merged, byKey, layers: grouped.layers, groupMats: grouped.mats, colGeo, colRanges, colKeyOf, bvh, skimBvh, emitters, facts, lotInfo, poles, cables, layout,
    signDepth: signCol && !signCollide ? signCol : null,   // [P4-B] depth-only sign housings (colliderScene)
    lines: L.lines || [], funnels: L.funnels || [],
    startPoints: (L.startPoints || []).map(v3), takeStart: L.takeStart || null,
    spawn: layout.spawn, setPieces: dressing.setPieces, dressingMats: dressing.materials, dressing: DM, dressingOut: dressing.out,
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
// ---- [P3-C] atlas groups (perf #1, native #3). Layer order is fixed for our keys (ground 0-2, city 3-20); E's plain opaque
// keys (no texture, emission, transparency, alpha or decal; `fold: false` opts out) are appended per build.
export const SEOUL_GROUPS = {
  ground: ['road', 'walk', 'plaza'],
  city: ['tile', 'brick', 'plaster', 'concrete', 'roof', 'metal', 'shutter', 'white', 'fascia', 'frame', 'sill', 'dark', 'pole', 'pipe', 'gaspipe', 'bed', 'shutterR', 'stone'],   // [P4-C] stone appended: P3's indices hold
  glass: ['glass', 'shop', 'lamp'],
  lanepaint: ['stripe', 'yellow'],
  ao: ['ao'],
};
export const SEOUL_LAYER_MAX = 32;
const GROUP_OF = Object.fromEntries(Object.entries(SEOUL_GROUPS).flatMap(([g, ks]) => ks.map((k) => [k, g])));
const foldable = (m) => !!m && m.fold !== false && !m.emissive && !m.transparent && !m.decal && !m.double && !m.alphaTest && !m.map && !m.maps && !m.id && !m.tex && !m.texture && !m.shader && !m.side;
// one layer record: textures by id (KTX2 array slices: SEOUL_TEX_IDS order), uv scale, colour, roughness, metalness, grime
export const SEOUL_TEX_IDS = [...new Set(Object.values(SEOUL_MATS).filter((m) => m.id).map((m) => m.id))];
function layerOf(key, m) {
  const diff = m.id && m.maps?.includes('diff') ? SEOUL_TEX_IDS.indexOf(m.id) : -1, nor = m.id && m.maps?.includes('nor_gl') ? SEOUL_TEX_IDS.indexOf(m.id) : -1;
  return { key, diff, nor, id: m.id || null, tile: m.tile || 1, color: [...(m.color || [1, 1, 1])], rough: m.rough ?? 0.8, metal: m.metal || 0, grime: m.grime ? 1 : 0, albedo: m.albedo || m.color || [0.3, 0.3, 0.3] };
}
function groupMeshes(byKey, dmats = {}) {
  const layers = [...SEOUL_GROUPS.ground, ...SEOUL_GROUPS.city].map((k) => layerOf(k, SEOUL_MATS[k]));
  const parts = {}, out = {}, put = (g, k, geo) => (parts[g] ||= []).push([k, geo]);
  for (const [k, g] of Object.entries(byKey)) {
    if (GROUP_OF[k]) { put(GROUP_OF[k], k, g); continue; }
    const dm = dmats[k];
    if (!SEOUL_MATS[k] && foldable(dm) && layers.length < SEOUL_LAYER_MAX) { layers.push(layerOf(k, dm)); put('city', k, g); continue; }
    out[k] = g;   // E's own material (or an unconformable E: key)
  }
  const layerIx = new Map(layers.map((l, i) => [l.key, i]));
  const ATTR = { ground: ['position', 'normal', 'uv', 'color'], city: ['position', 'normal', 'uv', 'color'], glass: ['position', 'normal', 'uv', 'aEm', 'aWin'], lanepaint: ['position', 'normal', 'uv', 'color'], ao: ['position', 'normal', 'uv', 'color'] };
  for (const [gk, list] of Object.entries(parts)) {
    const geos = [];
    for (const [k, g0] of list) {
      const g = new THREE.BufferGeometry(), src = g0.index ? g0.toNonIndexed() : g0, n = src.getAttribute('position').count;
      for (const a of ATTR[gk]) {
        let at = src.getAttribute(a);
        if (!at) { if (a === 'normal') { const t = src.clone(); t.computeVertexNormals(); at = t.getAttribute('normal'); } else at = new THREE.Float32BufferAttribute(new Float32Array(n * ({ uv: 2, aEm: 4, aWin: 4 }[a] || 3)).fill(a === 'color' ? 1 : 0), { uv: 2, aEm: 4, aWin: 4 }[a] || 3); }
        g.setAttribute(a, at);
      }
      if (gk === 'lanepaint') { const c = g.getAttribute('color').clone(), m = SEOUL_MATS[k].color; for (let i = 0; i < n; i++) c.setXYZ(i, c.getX(i) * m[0], c.getY(i) * m[1], c.getZ(i) * m[2]); g.setAttribute('color', c); }
      if (gk === 'ground' || gk === 'city') g.setAttribute('aLay', new THREE.Float32BufferAttribute(new Float32Array(n).fill(layerIx.get(k)), 1));
      geos.push(g);
    }
    const m = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (m) { m.computeBoundingSphere(); m.computeBoundingBox(); out[gk] = m; }
  }
  const mats = {
    ground: { group: 'ground', layers: layers.filter((l) => SEOUL_GROUPS.ground.includes(l.key)).map((l) => l.key), attribute: 'aLay', vcol: true, wet: true, albedo: SEOUL_MATS.road.albedo, rough: 1, metal: 1 },
    city: { group: 'city', layers: layers.filter((l) => !SEOUL_GROUPS.ground.includes(l.key)).map((l) => l.key), attribute: 'aLay', vcol: true, albedo: SEOUL_MATS.tile.albedo, rough: 1, metal: 1 },
    glass: { ...SEOUL_MATS.glass, group: 'glass', layers: ['glass', 'shop', 'lamp'], kinds: 'aWin.z / 4: 0 window, 1 shop bay, 2 door, 3 poster, 4 lamp head (flat emitter)' },
    lanepaint: { group: 'lanepaint', layers: ['stripe', 'yellow'], vcol: true, rough: 0.6, color: [1, 1, 1], albedo: SEOUL_MATS.stripe.albedo, decal: 'offset', wet: true },
    ao: { ...SEOUL_MATS.ao },
  };
  return { merged: out, layers, mats };
}
// [P4-B] stream B's module, if present (top-level, as E's below): its sign housings join the collider (native #5).
// SIGN_COLLIDE: the housings are in the physics BVH too (off until lines.json is re-fitted around them; see buildSeoulGeometry)
export const SIGN_COLLIDE = false;
let SIGNS = null;
try { const m = await import('./seoul-signs.js'); SIGNS = typeof m.colliderTris === 'function' ? m : null; }
catch (e) { if (!/Cannot find|not found|404|Failed to fetch|ERR_MODULE_NOT_FOUND|Importing a module script failed|error loading dynamically/i.test(String(e?.message || e))) console.warn('seoul-signs.js', e); }
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
uniform sampler2D tSeoulInt; uniform float uSeoulNorm[16]; uniform float uSeoulTime;
varying vec4 sEm; varying vec4 sWin; varying vec3 sWPos; varying vec3 sONrm; varying vec2 sUv;
float sgMask = 0.0; vec3 sgEmit = vec3(0.0);
// [P4-C] A's bug (NaN / Inf radiance in shop glass, walk0 123 px, w21 30 px on main): the glass's own terms are finite, but
// D's analytic lights on a 0.06-rough pane seen and lit at grazing (shop fronts along a street) drive GGX past the half-float
// range (D ~ 1 / (pi a^2) ~ 4e4, V ~ 1 / (a dotNV)), Inf in the RT, then Inf - Inf = NaN in the haze and blur. The pane is
// floored at roughness 0.1 (sgEnv carries the sharp reflection) and its outgoing radiance is sanitised before the haze.
vec3 sgSafe(vec3 c) { if (any(isnan(c)) || !(c.r == c.r && c.g == c.g && c.b == c.b)) return vec3(0.0); return clamp(c, 0.0, 1.5e4); }
vec4 sgTile(float t, vec2 uv, float lod) {
  float pad = (0.5 * exp2(lod) + 0.5) / 512.0;
  uv = clamp(uv, vec2(pad), vec2(1.0 - pad));
  return textureLod(tSeoulInt, (vec2(mod(t, 4.0), floor(t / 4.0 + 0.001)) + uv) / vec2(4.0, 6.0), lod);
}
float sgHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float sgVN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sgHash(i), sgHash(i + vec2(1.0, 0.0)), f.x), mix(sgHash(i + vec2(0.0, 1.0)), sgHash(i + vec2(1.0, 1.0)), f.x), f.y); }
// [P3-C] what a pane reflects (art #3, graphics #5), scene-linear (NITS 0.1): the frontage across the street ~9 m away (a
// sign band at 2.8-4.2 m, lit shopfronts, lit windows by floor, a blade every ~11 m, a roofline), the wet street below and
// the dark sky above. Signs ~40-60 nits, lit windows ~10, walls ~0.2: at F = 0.04 neon shows on the glass as it does.
vec3 sgEnv(vec3 P, vec3 rf, vec3 n) {
  vec2 tn = vec2(-n.z, n.x);
  if (rf.y < -0.015) {
    vec2 gp = P.xz + rf.xz * (P.y / max(-rf.y, 0.015));
    return vec3(0.032, 0.029, 0.026) * (0.5 + 1.2 * sgVN(gp * 0.25));
  }
  float th = 9.0 / max(dot(rf, n), 0.06); vec3 hp = P + rf * th;
  float a = dot(hp.xz, tn), y = hp.y;
  float roof = 11.0 + 10.0 * sgHash(vec2(floor(a / 7.0), 3.0));
  if (y > roof) return vec3(0.004, 0.0036, 0.0032);
  vec3 c = vec3(0.018, 0.016, 0.015);
  float bs = fract(a / 11.0), bi = floor(a / 11.0);
  if (bs < 0.07 && y > 4.5 && y < 4.5 + 9.0 * sgHash(vec2(bi, 9.0))) {
    float hb = sgHash(vec2(bi, 5.0)); vec3 bc = hb < 0.35 ? vec3(1.0, 0.45, 0.15) : hb < 0.6 ? vec3(1.0, 0.85, 0.6) : hb < 0.8 ? vec3(1.0, 0.25, 0.4) : vec3(0.3, 0.7, 1.0);
    return bc * (12.0 * step(0.5, fract(y / 0.9)) + 2.0);   // [P5-C] blades at 120-200 nits (P4: 40-50)
  }
  if (y > 2.8 && y < 4.2) {
    float u = fract(a / 4.7), s = sgHash(vec2(floor(a / 4.7), 1.0)), v = (y - 2.8) / 1.4;
    vec3 sc = s < 0.3 ? vec3(1.0, 0.5, 0.18) : s < 0.55 ? vec3(1.0, 0.88, 0.7) : s < 0.68 ? vec3(0.25, 0.6, 1.0) : s < 0.82 ? vec3(1.0, 0.25, 0.45) : vec3(0.9, 0.9, 0.86);
    float on = step(0.1, u) * step(u, 0.9) * step(0.18, v) * step(v, 0.82) * step(0.15, s);
    return mix(c * 1.5, sc * 16.0, on);   // [P5-C] graphics #2 / fpv #2: box letters at ~160 nits, so neon reads on the glass
  }
  if (y < 2.8) { float u = fract(a / 3.1), h = sgHash(vec2(floor(a / 3.1), 2.0)); return mix(vec3(0.02), mix(vec3(1.0, 0.86, 0.7), vec3(0.85, 0.92, 1.0), step(0.75, h)) * 4.5, step(0.3, h) * step(0.08, u) * step(u, 0.92) * step(y, 2.4)); }
  vec2 cell = vec2(floor(a / 2.6), floor(y / 3.2)), f = vec2(fract(a / 2.6), fract(y / 3.2));
  float h1 = sgHash(cell), h2 = sgHash(cell + 17.3);
  if (f.x > 0.22 && f.x < 0.78 && f.y > 0.3 && f.y < 0.78) c = h1 < 0.4 ? mix(vec3(1.0, 0.85, 0.65), vec3(0.88, 0.93, 1.0), step(0.7, h2)) * (0.5 + 0.9 * h2) : vec3(0.025);
  return c;
}
// [P5-C] art #3 / graphics #2: shelf stock by trade (linear albedo; h a per-item hash): clothes are folded black, white,
// denim and camel; phones dark with a lit screen; a cafe's beans, cups and bottles; a convenience store's packaging
vec3 sgStock(float room, float h) {
  float k = fract(h * 5.17);
  vec3 c = abs(room - 5.0) < 0.5 ? (k < 0.3 ? vec3(0.03) : k < 0.45 ? vec3(0.75, 0.74, 0.7) : k < 0.62 ? vec3(0.1, 0.14, 0.3) : k < 0.75 ? vec3(0.45, 0.32, 0.18) : k < 0.85 ? vec3(0.6, 0.08, 0.08) : vec3(0.25, 0.4, 0.6))
    : abs(room - 6.0) < 0.5 ? (k < 0.5 ? vec3(0.04) : k < 0.7 ? vec3(0.8) : k < 0.85 ? vec3(0.1, 0.3, 0.85) : vec3(0.85, 0.2, 0.25))
    : abs(room - 1.0) < 0.5 ? (k < 0.4 ? vec3(0.35, 0.2, 0.1) : k < 0.7 ? vec3(0.85, 0.82, 0.75) : k < 0.85 ? vec3(0.1, 0.25, 0.15) : vec3(0.7, 0.45, 0.15))
    : (k < 0.15 ? vec3(0.75, 0.08, 0.06) : k < 0.3 ? vec3(0.85, 0.55, 0.05) : k < 0.42 ? vec3(0.08, 0.25, 0.7) : k < 0.54 ? vec3(0.1, 0.5, 0.15) : k < 0.7 ? vec3(0.85, 0.85, 0.82) : k < 0.8 ? vec3(0.9, 0.3, 0.05) : k < 0.9 ? vec3(0.6, 0.1, 0.45) : vec3(0.05));
  return c * (0.75 + 0.5 * fract(h * 11.3));
}
void seoulGlass(inout vec4 dc) {
  float gr = step(50.0, sWin.w);   // [P3-C] aWin.w + 100: a security grille in front of the pane
  float w = max(sWin.x, 0.05), h = max(sWin.y, 0.05), kind = floor(sWin.z * 0.25 + 0.001), sill = sWin.z - kind * 4.0, D = max(sWin.w - 100.0 * gr, 0.1);
  float code = floor(sEm.w + 0.0005), seed = sEm.w - code, room = mod(code, 32.0), front = floor(code / 32.0 + 0.001);
  vec3 L = sEm.rgb; float lit = step(0.2, dot(L, vec3(0.2126, 0.7152, 0.0722)));
  // [P4-C] fpv #3 / graphics #1: a TV room flickers (a cut every 1.5-4 s, a shimmer between), so a dark block has life in it
  if (kind < 0.5 && abs(room - 13.0) < 0.5) { float ph = floor(uSeoulTime * (0.25 + 0.4 * fract(seed * 5.3)) + seed * 17.0);
    L *= (0.5 + 0.9 * sgHash(vec2(ph, seed * 31.0))) * (0.92 + 0.08 * sin(uSeoulTime * 11.0 + seed * 50.0)) * mix(vec3(1.0), vec3(0.8, 0.9, 1.25), sgHash(vec2(ph, 7.0))); }
  if (kind > 3.5) { dc.rgb = vec3(0.05); sgEmit = L; sgMask = 4.0; return; }   // [P3-C] street-light heads (was its own mesh)
  if (kind > 2.5) {   // poster: flat, quadrant of a poster tile
    vec2 qd = vec2(mod(room, 2.0), floor(mod(room, 4.0) * 0.5 + 0.001));
    float lod = clamp(log2(max(length(dFdx(sUv)), length(dFdy(sUv))) * 256.0), 0.0, 5.0);
    vec4 c = sgTile(16.0 + floor(room / 4.0 + 0.001), (qd + clamp(sUv, 0.02, 0.98)) * 0.5, lod);
    dc.rgb = c.rgb * 0.5; sgEmit = c.rgb * L; sgMask = 3.0; return;
  }
  vec3 n = normalize(sONrm), T = vec3(-n.z, 0.0, n.x), rd = normalize(sWPos - cameraPosition);
  vec3 r = vec3(dot(rd, T), rd.y, max(-dot(rd, n), 0.03));
  vec2 q = vec2((sUv.x - 0.5) * w, sill + sUv.y * h);
  float gcov = 0.0;
  if (gr > 0.5) {   // 16 mm bars at 11 cm, two rails; fades to its average once a bar is under a pixel
    vec2 fq = fwidth(q);
    float bx = abs(fract(q.x / 0.11) - 0.5) * 0.11, by = min(abs(q.y - sill - h * 0.33), abs(q.y - sill - h * 0.67));
    gcov = max(1.0 - smoothstep(0.008 - fq.x, 0.008 + fq.x, bx), 1.0 - smoothstep(0.012 - fq.y, 0.012 + fq.y, by));
    gcov = mix(gcov, 0.22, smoothstep(0.02, 0.05, max(fq.x, fq.y)));
  }
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
  float px = max(max(length(dFdx(q)), length(dFdy(q))), 1e-4);
  float lod = clamp(log2(px * 512.0 / Wr), 0.0, 7.0);
  vec4 c = sgTile(room, tuv, lod);
  vec3 col = c.rgb * (1.0 + (1.0 - c.a) * 6.0 * lit) * uSeoulNorm[int(room)] * L;
  // [P5-C] graphics #2 / art #3 / fpv #2 (shops that aren't dioramas: club90's cream cubicles, walk0's white room): the
  // light has a source and the room has stuff in it. Every room: -1 EV into its corners and edges, brighter by the glass,
  // dimmer at the back. Shops: a paint per tenant (a third not cream), shelving to 1.8 m with stock, price-tag strips and
  // uprights on the side walls of 70 % of the retail shops (convenience, clothes, phone) and 35 % of the rest, and LED strip
  // fixtures in the ceiling with a pool on the floor under them.
  {
    vec3 hw = vec3(hit.x / (Wr * 0.5), hit.y / Hr, hit.z / D);
    float sideW = step(0.995, abs(hw.x)), floorW = step(hit.y, 0.005), ceilW = step(Hr - 0.005, hit.y), backW = step(D - 0.005, hit.z);
    float ex = smoothstep(0.6, 1.0, abs(hw.x)), ey = max(1.0 - smoothstep(0.0, 0.15, hw.y), smoothstep(0.88, 1.0, hw.y)), ez = smoothstep(0.65, 1.0, hw.z);
    float lf = mix(1.0, 0.5, max(max(ex * ey, ex * ez), ey * ez)) * mix(1.15, 0.8, hw.z);
    if (kind > 0.5) {
      float hs = fract(seed * 13.71), retail = (room < 0.5 || abs(room - 5.0) < 0.5 || abs(room - 6.0) < 0.5) ? 1.0 : 0.0;
      if (c.a > 0.98 && max(sideW, backW) > 0.5) { float tp = fract(seed * 29.3);
        col *= tp < 0.22 ? vec3(0.36, 0.35, 0.34) : tp < 0.34 ? vec3(0.78, 0.9, 0.8) : tp < 0.44 ? vec3(1.0, 0.82, 0.8) : tp < 0.56 ? vec3(0.85, 0.66, 0.48) : vec3(1.0, 0.96, 0.9); }
      if (sideW > 0.5 && hs < (retail > 0.5 ? 0.7 : 0.35) && hit.y > 0.12 && hit.y < 1.85 && hit.z > 0.5 && hit.z < D - 0.3) {
        float sy = (hit.y - 0.12) / 0.36, si = floor(sy), sf = fract(sy) * 0.36, z = hit.z + sign(hit.x) * 7.0;
        vec3 st;
        if (fract(z / 0.9) < 0.035) st = vec3(0.05);
        else if (sf < 0.022) st = vec3(0.5, 0.5, 0.48);
        else if (sf < 0.045) { float tg = fract(z / 0.17 + si * 0.37); st = tg < 0.32 ? (sgHash(vec2(floor(z / 0.17), si)) < 0.3 ? vec3(0.95, 0.78, 0.1) : vec3(0.9)) : vec3(0.12); }
        else { float pw = 0.07 + 0.12 * sgHash(vec2(si, floor(seed * 50.0))), pi = floor(z / pw), pf = fract(z / pw);
          float hp = sgHash(vec2(pi, si + floor(seed * 37.0))), ph = (0.45 + 0.45 * fract(hp * 7.3)) * 0.315;
          st = (pf > 0.1 && sf - 0.045 < ph) ? sgStock(room, hp) * (0.75 + 0.6 * (sf - 0.045) / 0.315) : vec3(0.05); }
        col = st * L * 1.4;
      }
      col *= lf;
      if (lit > 0.5 && (retail > 0.5 || hs > 0.6)) {
        float sx = abs(abs(hit.x) - Wr * 0.22);
        if (ceilW > 0.5) col = mix(col, L * 7.0, (1.0 - smoothstep(0.03, 0.05, sx)) * step(fract(hit.z / 1.5), 0.82) * step(0.3, hit.z));
        if (floorW > 0.5) col *= 0.75 + 0.6 * exp(-sx * sx * 4.0);
      }
    } else col *= lf;
  }
  // [P3-C] mid-depth layer (art #3): shelves, counters, menu boards, diners 1.2-2 m behind shop glass and office windows
  float mid = room < 6.5 ? room : (room > 7.5 && room < 8.5 ? 7.0 : -1.0);
  if (mid > -0.5) {
    float zm = 1.2 + fract(seed * 3.17) * 0.8, tm = zm / rr.z;
    if (zm < D - 0.4 && tm < t) {
      vec3 hm = p0 + rr * tm; float um = hm.x / Wr + 0.5;
      if (seed > 0.5) um = 1.0 - um;
      if (um > 0.0 && um < 1.0 && hm.y > 0.0 && hm.y < 3.0) {
        vec4 mc = sgTile(20.0 + floor(mid * 0.5 + 0.001), vec2((mod(mid, 2.0) + clamp(um, 0.01, 0.99)) * 0.5, hm.y / 3.0), clamp(log2(px * 256.0 / Wr), 0.0, 6.0));
        col = mix(col, mc.rgb * uSeoulNorm[int(room)] * L * 0.85, mc.a);
      }
    }
  }
  // [P4-C] fpv #2 / graphics #2: a near layer 0.5-0.9 m behind shop glass (the third depth): shoppers in a convenience store,
  // clothes or phone shop (one per 1 m of strip, half the cells empty), people at a cafe's window bar facing out
  float nl = (room < 0.5 || abs(room - 5.0) < 0.5 || abs(room - 6.0) < 0.5) ? 10.0 : abs(room - 1.0) < 0.5 ? 15.0 : -1.0;
  if (kind > 0.5 && nl > 0.0 && fract(seed * 5.91) < (nl > 12.0 ? 0.6 : 0.8)) {
    float zn = 0.5 + fract(seed * 2.37) * 0.4, tn = zn / rr.z;
    if (tn < t && zn < D - 1.0) {
      vec3 hn = p0 + rr * tn; float xm = hn.x + fract(seed * 7.7) * 3.0;
      if (hn.y > 0.0 && hn.y < 3.0 && (nl > 12.0 || sgHash(vec2(floor(xm), floor(seed * 97.0))) < 0.5)) {
        vec4 nc = sgTile(nl, vec2(fract(xm / 3.0), hn.y / 3.0), clamp(log2(px * 512.0 / 3.0), 0.0, 6.0));
        col = mix(col, nc.rgb * uSeoulNorm[int(room)] * L * 0.9, nc.a);
      }
    }
  }
  // [P4-C] fpv #3: per-window light falls off across the room from its lamp (a +-25 % ramp, mean kept)
  vec2 gu = e / vec2(w, h);
  if (kind < 0.5) col *= (1.0 + 0.5 * (fract(seed * 9.73) - 0.5) * (gu.x * 2.0 - 1.0)) * (0.88 + 0.24 * gu.y);
  // [P4-C] front layers are procedural (P3's tiles 9, 10, 15 hold the lobby and the near layers now): slats fade to their mean
  // once a slat is under a pixel
  float sv = gu.y * h * 13.75, fs = fwidth(sv);   // (derivatives outside the branches)
  if (front > 0.5 && front < 1.5) {           // blinds, lowered part way: 22 slats per 1.6 m
    if (gu.y > 0.55 - fract(seed * 7.13) * 0.55) { float sl = fract(sv);
      float on = mix(step(sl, 0.82), 0.82, smoothstep(0.3, 0.7, fs)); vec4 b = mix(vec4(0.3, 0.3, 0.3, 0.2), vec4(0.78, 0.75, 0.68, 0.94), on); col = mix(col, b.rgb * L * 0.55, b.a); }
  } else if (front > 1.5 && front < 2.5) {    // curtains from both sides
    if (abs(gu.x - 0.5) > fract(seed * 5.31) * 0.25) {
      float cu = fract(gu.x * w / 1.4), cf = 0.75 + 0.25 * sin(cu * 46.0 + sin(cu * 7.0) * 2.0) * (0.8 + 0.2 * sin(gu.y * 3.0)); vec4 cc = vec4(vec3(cf), 0.9);
      float k = fract(seed * 3.7);
      vec3 tint = k < 0.4 ? vec3(0.95, 0.88, 0.75) : k < 0.6 ? vec3(0.95, 0.95, 0.92) : k < 0.75 ? vec3(0.9, 0.55, 0.55) : k < 0.9 ? vec3(0.45, 0.5, 0.75) : vec3(0.7, 0.75, 0.6);
      col = mix(col, cc.rgb * tint * L * 0.75, cc.a);
    }
  } else if (front > 2.5 && front < 3.5) {    // frosted
    col = vec3(0.75 + 0.1 * sin(gu.x * 5.0 + 1.0) * sin(gu.y * 4.0) + 0.024 * sin(gu.x * 40.0)) * L * 1.1;
  } else if (front > 3.5 && front < 4.5) {    // pocha vinyl curtain: orange-clear PVC, soft folds
    float fold = 0.8 + 0.2 * sin(gu.x * w * 7.0 + sin(gu.y * 4.0 + seed * 6.0) * 1.5);
    col = mix(col, vec3(dot(col, vec3(0.3333))), 0.55) * vec3(1.18, 0.8, 0.45) * fold;
  } else if (front > 5.5 && front < 6.5) {    // cafe curtain on the lower 40 %
    if (gu.y < 0.4) { float cu = fract(gu.x * w / 0.9), cf = 0.75 + 0.25 * sin(cu * 46.0 + sin(cu * 7.0) * 2.0); col = mix(col, vec3(cf) * vec3(0.95, 0.92, 0.85) * L * 0.8, 0.9); }
  }
  // [P3-C] the glass itself: Fresnel 0.04 at normal incidence, raised by grime (smears, a dusty bottom edge), which also
  // costs a little transmission; it reflects the street it faces (sgEnv), so a lit shop is a window, not a plate
  vec3 rf = reflect(rd, n); float ci = clamp(-dot(rd, n), 0.0, 1.0);
  float grime = 0.55 * smoothstep(0.45, 0.85, sgVN(sWPos.xz * 1.7 + vec2(sWPos.y * 0.6, sWPos.y * 2.3))) + 0.45 * smoothstep(0.22, 0.0, gu.y);
  // [P4-C] art #5 / fpv #2: F0 0.05 (windows) / 0.06 (shop glass: film, two panes), so a 40 % street reflection survives at 45 deg
  // [P5-C] graphics #2 / fpv #2: shop glass F0 0.08 (laminated, film, two faces) rising to 0.25+ at grazing; P4's 0.06
  float F0 = kind > 0.5 ? 0.08 : 0.05, F = min(0.6, (F0 + (1.0 - F0) * pow(1.0 - ci, 5.0)) * (1.0 + 0.9 * grime));
  col = col * (1.0 - F) * (1.0 - 0.12 * grime) + F * sgEnv(sWPos, rf, n);
  sgEmit = col * (1.0 - gcov); dc.rgb = mix(dc.rgb, vec3(0.055, 0.055, 0.06), gcov); if (gcov > 0.5) sgMask = 1.0;
}
`;
// procedural grime on the scan textures: vertical streaks and blots in metres of uv (walls: along x, height y)
// [P5-C] art #2 / graphics #1 (grime on the lit walls; walk0 and walk180 were even cream from 2 m to 20 m): on walls (|n.y| <
// 0.5, uv = metres along the wall and up it) re-rendered repair patches ~1 per 20 m2 with trowelled edges a shade off the
// wall, a splash tide line over the bottom 0.4-0.9 m (world height) with speckle, soot mottling at 0.3-0.5 m, and a
// roughness that follows the dirt (+-0.15). Drip streaks under sills, brackets, hoppers and band lips are decals (ao).
const GRIME_HEAD = /* glsl */`
varying vec2 sUv; varying float sNy; varying float sWY;
float sgGR = 0.0;
float sgH(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float sgN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sgH(i), sgH(i + vec2(1.0, 0.0)), f.x), mix(sgH(i + vec2(0.0, 1.0)), sgH(i + vec2(1.0, 1.0)), f.x), f.y); }
float seoulGrime(vec2 uv) {
  float streak = smoothstep(0.55, 0.95, sgN(vec2(uv.x * 2.3, uv.y * 0.16))) * smoothstep(0.35, 0.85, sgN(vec2(uv.x * 0.37 + 7.1, uv.y * 0.05)));
  float k = 1.0 - 0.3 * streak - 0.12 * smoothstep(0.5, 1.0, sgN(uv * 0.9 + 3.3));
  sgGR = 0.12 * streak + (sgN(uv * 0.6 + 21.0) - 0.5) * 0.3;
  if (abs(sNy) < 0.5) {
    vec2 pc = vec2(uv.x / 1.7, uv.y / 1.25), ci = floor(pc), cf = fract(pc);
    if (sgH(ci + 31.7) < 0.11) {
      vec2 lo = vec2(sgH(ci + 3.1), sgH(ci + 5.3)) * 0.35, hi = 1.0 - vec2(sgH(ci + 7.9), sgH(ci + 9.4)) * 0.35, fw = fwidth(pc) + 1e-4;
      float m = smoothstep(lo.x - fw.x, lo.x + fw.x, cf.x) * smoothstep(lo.y - fw.y, lo.y + fw.y, cf.y) * (1.0 - smoothstep(hi.x - fw.x, hi.x + fw.x, cf.x)) * (1.0 - smoothstep(hi.y - fw.y, hi.y + fw.y, cf.y));
      float tone = sgH(ci + 13.3) < 0.55 ? 0.78 : 1.12;
      k *= mix(1.0, tone, m); sgGR += m * (tone > 1.0 ? -0.1 : 0.06);
    }
    float tide = 0.4 + 0.5 * sgN(vec2(uv.x * 1.3, 1.7)), g = 1.0 - smoothstep(0.0, tide, sWY);
    k *= 1.0 - 0.32 * g * (0.55 + 0.45 * sgN(uv * vec2(9.0, 14.0)));
    sgGR += 0.12 * g;
    k *= (0.84 + 0.32 * sgN(uv * vec2(3.1, 2.3) + 11.0)) * (0.9 + 0.2 * sgN(uv * vec2(11.0, 7.0) + 5.0));
  }
  return k;
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
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = sgMask > 3.5 ? 0.5 : sgMask > 2.5 ? 0.12 : sgMask > 1.5 ? 0.9 : sgMask > 0.5 ? 0.4 : max(roughnessFactor, 0.1);')
        .replace('#include <opaque_fragment>', '  outgoingLight = sgSafe(outgoingLight);\n#include <opaque_fragment>')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = sgMask > 0.5 && sgMask < 1.5 ? 0.6 : metalnessFactor;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += sgEmit;');
    } else if (mode === 'flat') {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aEm;\nvarying vec3 vEm;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvEm = aEm.rgb;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vEm;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEm;');
    } else if (mode === 'atlas') {   // [P3-C] ground / city: layer table + KTX2 arrays + two-scale detail
      Object.assign(sh.uniforms, ATLAS_UNIFORMS);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aLay;\nflat varying float sLay; varying vec2 sUv; varying float sNy; varying float sWY;').replace('#include <begin_vertex>', '#include <begin_vertex>\nsLay = aLay; sUv = uv; sNy = normal.y; sWY = (modelMatrix * vec4(transformed, 1.0)).y;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + GRIME_HEAD + ATLAS_HEAD)
        .replace('#include <map_fragment>', `
  sgLi = int(sLay + 0.5); sgLA = uLayA[sgLi]; sgLB = uLayB[sgLi]; sgLuv = sUv * sgLA.z;
  sgDet = texture(tCityDetail, sUv * 0.83) * 0.6 + texture(tCityDetail, sUv * 3.1 + 0.37) * 0.4;
  { vec3 td = texture(tCityDiff, vec3(sgLuv, max(sgLA.x, 0.0))).rgb; diffuseColor.rgb *= (sgLA.x > -0.5 ? td : vec3(1.0)) * sgLB.rgb * (0.86 + 0.28 * sgDet.a); }
  if (sgLA.w > 0.5) diffuseColor.rgb *= seoulGrime(sUv);`)
        .replace('#include <normal_fragment_maps>', `
  { vec3 tn = texture(tCityNor, vec3(sgLuv, max(sgLA.y, 0.0))).xyz * 2.0 - 1.0;
    vec3 mapN = sgLA.y > -0.5 ? tn : vec3(0.0, 0.0, 1.0);
    mapN.xy += (sgDet.xy * 2.0 - 1.0) * uSeoulDetail.x * mix(2.0, 1.0, smoothstep(6.0, 12.0, length(vViewPosition)));   // [P5-C] graphics #1: x2 under 10 m
    mapN.xy *= normalScale;
    normal = normalize(tbn * mapN); }`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor *= clamp(sgLB.a * (1.0 + (sgDet.z - 0.5) * uSeoulDetail.y * 2.0), 0.04, 1.0);\n  if (sgLA.w > 0.5) roughnessFactor = clamp(roughnessFactor + sgGR, 0.04, 1.0);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor *= uLayM[sgLi];');
    } else if (mode === 'grime') {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 sUv; varying float sNy; varying float sWY;').replace('#include <begin_vertex>', '#include <begin_vertex>\nsUv = uv; sNy = normal.y; sWY = (modelMatrix * vec4(transformed, 1.0)).y;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + GRIME_HEAD).replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= seoulGrime(sUv);');
    }
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + '|seoul:' + mode; };
  return mat;
}
const INTERIOR_UNIFORMS = { tSeoulInt: { value: null }, uSeoulNorm: { value: new Array(16).fill(1) }, uSeoulTime: { value: 0 } };
let interiorTex = null, interiorJob = null;
// [P3-C] the atlas is 512 px tiles now (graphics #5), 1-4 s of painting: in the browser a module Worker paints it while the
// geometry builds (buildSeoul starts it first), and the texture is swapped in when it lands. Node / no Worker: in line.
export function startInteriorAtlas() {
  if (interiorJob) return interiorJob;
  interiorJob = (async () => {
    if (!IS_NODE && typeof Worker !== 'undefined' && typeof Blob !== 'undefined') {
      let url = null;
      try {
        const src = `import { buildInteriorAtlas } from ${JSON.stringify(new URL('./seoul-interiors.js', import.meta.url).href)};\n` +
          'const A = buildInteriorAtlas(); postMessage({ data: A.data, mean: A.mean, width: A.width, height: A.height }, [A.data.buffer, A.mean.buffer]);';
        url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        return await new Promise((res, rej) => {
          const w = new Worker(url, { type: 'module' }), to = setTimeout(() => { w.terminate(); rej(new Error('timeout')); }, 30000);
          w.onmessage = (e) => { clearTimeout(to); w.terminate(); res(e.data); };
          w.onerror = (e) => { clearTimeout(to); w.terminate(); rej(new Error(e?.message || 'worker error')); };
        });
      } catch (e) { console.warn('seoul interiors: worker failed, painting on the main thread', e?.message || e); }
      finally { if (url) URL.revokeObjectURL(url); }
    }
    return buildInteriorAtlas();
  })();
  return interiorJob;
}
function interiorTexture() {
  if (interiorTex) return interiorTex;
  interiorTex = startInteriorAtlas().then((A) => {
    const t = new THREE.DataTexture(A.data, A.width, A.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.flipY = false; t.anisotropy = 4; t.name = 'seoul:interiors'; t.needsUpdate = true;
    t.onUpdate = () => { if (t.image) t.image.data = null; };   // perf #4: the GPU holds it; drop the 25 MB CPU copy
    if (!IS_NODE) A.data = null;   // [P5-D] perf #1: interiorJob's result held a second reference to those 25 MB for the session (node: A is seoul-interiors' cached atlas, which the export reads)
    INTERIOR_UNIFORMS.uSeoulNorm.value = Array.from({ length: 16 }, (_, i) => (i === NEAR.people || i === NEAR.bar ? 1 : 1 / Math.max(0.05, A.mean[i])));   // [P4-C] 9 is a room (lobby)
    INTERIOR_UNIFORMS.tSeoulInt.value = t;
    return t;
  }).catch((e) => { console.warn('seoul interiors', e); return null; });
  return interiorTex;
}
// ---- [P3-C] native #3 + perf #1: the scans as two KTX2 texture arrays (diffuse sRGB, normals linear; one slice per
// SEOUL_TEX_IDS entry), from the vendored seoul/tex/*.ktx2 through a vendored Basis transcoder (seoul/tex/basis/), so
// the browser and the native port sample the same texels and nothing is hot-linked. Fallbacks: the Poly Haven JPGs
// (decoded into RGBA arrays), then flat per-layer albedo. -> { diff, nor, source }
const TEX_BASE = new URL('./seoul/tex/', import.meta.url);
async function loadScanArrays(renderer, { jpg = true } = {}) {
  const ids = SEOUL_TEX_IDS, aniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 1);
  const finish = (t, srgb) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = aniso; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.needsUpdate = true;
    // [P5-D] perf #1: the GPU holds the slices once uploaded; drop the CPU copy (KTX2 mips / the JPG RGBA stack)
    t.onUpdate = () => { t.onUpdate = null; if (t.mipmaps?.length) t.mipmaps = t.mipmaps.map((m) => ({ width: m.width, height: m.height, data: new Uint8Array(0) })); else if (t.image) t.image.data = null; };
    return t; };
  // 1. KTX2 -> CompressedArrayTexture (every slice must transcode to one format, size and mip count)
  try {
    const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
    const kl = new KTX2Loader().setTranscoderPath(new URL('./basis/', TEX_BASE).href).detectSupport(renderer);
    const load = (f) => kl.loadAsync(new URL(f, TEX_BASE).href);
    const [D, N] = await Promise.all([Promise.all(ids.map((id) => load(`${id}_diff.ktx2`))), Promise.all(ids.map((id) => load(`${id}_nor_gl.ktx2`)))]);
    const stack = (T, srgb) => {
      const t0 = T[0], m0 = t0.mipmaps;
      if (T.some((t) => t.format !== t0.format || t.type !== t0.type || t.mipmaps.length !== m0.length || t.mipmaps[0].width !== m0[0].width || t.mipmaps[0].height !== m0[0].height)) throw new Error('KTX2 slices differ in format or size');
      const mips = m0.map((m, i) => { const sz = m.data.byteLength, data = new Uint8Array(sz * T.length);
        T.forEach((t, j) => { const d = t.mipmaps[i].data; data.set(new Uint8Array(d.buffer, d.byteOffset, sz), j * sz); }); return { data, width: m.width, height: m.height }; });
      const a = new THREE.CompressedArrayTexture(mips, m0[0].width, m0[0].height, T.length, t0.format, t0.type);
      a.generateMipmaps = false; T.forEach((t) => t.dispose());
      return finish(a, srgb);
    };
    const out = { diff: stack(D, true), nor: stack(N, false), source: 'ktx2' };
    kl.dispose();
    return out;
  } catch (e) { console.warn('seoul: KTX2 arrays failed, trying the JPGs', e?.message || e); }
  // 2. the JPGs (rows flipped to the KTX2 orientation: row 0 = v 0 = the image bottom)
  const S = 1024, rgbaArray = (layers, srgb) => { const t = new THREE.DataArrayTexture(layers, S, S, ids.length); t.generateMipmaps = true; return finish(t, srgb); };
  if (jpg && typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined') {
    try {
      const cv = new OffscreenCanvas(S, S), cx = cv.getContext('2d', { willReadFrequently: true });
      const one = async (id, map, buf, j) => {
        const r = await fetch(`${PH}/Textures/jpg/1k/${id}/${id}_${map}_1k.jpg`); if (!r.ok) throw new Error(`${id} ${map}: HTTP ${r.status}`);
        const bm = await createImageBitmap(await r.blob(), { imageOrientation: 'flipY', colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        cx.clearRect(0, 0, S, S); cx.drawImage(bm, 0, 0, S, S); buf.set(cx.getImageData(0, 0, S, S).data, j * S * S * 4); bm.close?.();
      };
      const dd = new Uint8Array(S * S * 4 * ids.length), nd = new Uint8Array(S * S * 4 * ids.length);
      for (let j = 0; j < ids.length; j++) { await one(ids[j], 'diff', dd, j); await one(ids[j], 'nor_gl', nd, j); }
      return { diff: rgbaArray(dd, true), nor: rgbaArray(nd, false), source: 'jpg' };
    } catch (e) { console.warn('seoul: scan JPGs failed, flat materials', e?.message || e); }
  }
  // 3. flat: each slice is its layer's albedo / tint, normals straight up
  const s1 = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
  const dd = new Uint8Array(16 * ids.length), nd = new Uint8Array(16 * ids.length);
  ids.forEach((id, j) => { const m = Object.values(SEOUL_MATS).find((q) => q.id === id); for (let p = 0; p < 4; p++) { for (let c = 0; c < 3; c++) dd[j * 16 + p * 4 + c] = s1(Math.min(1, m.albedo[c] / Math.max(0.05, m.color[c]))); dd[j * 16 + p * 4 + 3] = 255; nd.set([128, 128, 255, 255], j * 16 + p * 4); } });
  const flat = (d, srgb) => { const t = new THREE.DataArrayTexture(d, 2, 2, ids.length); t.generateMipmaps = false; t.minFilter = t.magFilter = THREE.NearestFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.needsUpdate = true; return t; };
  return { diff: flat(dd, true), nor: flat(nd, false), source: 'flat' };
}
// a tileable 512^2 detail map (graphics #1): RG a micro-normal (height gradient of 3 octaves of value noise: pits, trowel
// marks, aggregate), B a roughness variation, A an albedo variation (stains, patches). Sampled at two scales per fragment.
export function detailMap(N = 512) {
  const H = new Float32Array(N * N), hv = (x, y, p) => { x = ((x % p) + p) % p; y = ((y % p) + p) % p; let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(p, 2246822519); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const vn = (x, y, p) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hv(xi, yi, p), b = hv(xi + 1, yi, p), c = hv(xi, yi + 1, p), d = hv(xi + 1, yi + 1, p); return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy; };
  const A = new Float32Array(N * N), R = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = y * N + x;
    H[i] = vn(u * 8, v * 8, 8) * 0.5 + vn(u * 32, v * 32, 32) * 0.3 + vn(u * 128, v * 128, 128) * 0.2 + (hv(x, y, N) > 0.985 ? -0.35 : 0);
    A[i] = vn(u * 4 + 9, v * 4 + 3, 4) * 0.6 + vn(u * 16 + 1, v * 16, 16) * 0.4; R[i] = vn(u * 12 + 5, v * 12 + 7, 12);
  }
  const out = new Uint8Array(N * N * 4), q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, gx = H[y * N + ((x + 1) % N)] - H[y * N + ((x + N - 1) % N)], gy = H[((y + 1) % N) * N + x] - H[((y + N - 1) % N) * N + x];
    out[i * 4] = q(0.5 - gx * 2.2); out[i * 4 + 1] = q(0.5 - gy * 2.2); out[i * 4 + 2] = q(R[i]); out[i * 4 + 3] = q(A[i]);
  }
  return { data: out, width: N, height: N };
}
// the shared uniforms of the ground and city materials (layer table + arrays); textures land when loadScanArrays resolves
const ATLAS_UNIFORMS = { tCityDiff: { value: null }, tCityNor: { value: null }, tCityDetail: { value: null },
  uLayA: { value: Array.from({ length: SEOUL_LAYER_MAX }, () => new THREE.Vector4(-1, -1, 1, 0)) }, uLayB: { value: Array.from({ length: SEOUL_LAYER_MAX }, () => new THREE.Vector4(1, 1, 1, 0.8)) },
  uLayM: { value: new Array(SEOUL_LAYER_MAX).fill(0) }, uSeoulDetail: { value: new THREE.Vector2(0.35, 0.35) } };
function setLayers(layers) {
  layers.forEach((l, i) => { if (i >= SEOUL_LAYER_MAX) return; ATLAS_UNIFORMS.uLayA.value[i].set(l.diff, l.nor, 1 / l.tile, l.grime); ATLAS_UNIFORMS.uLayB.value[i].set(l.color[0], l.color[1], l.color[2], l.rough); ATLAS_UNIFORMS.uLayM.value[i] = l.metal; });
}
const ATLAS_HEAD = /* glsl */`
uniform highp sampler2DArray tCityDiff; uniform highp sampler2DArray tCityNor; uniform sampler2D tCityDetail;
uniform vec4 uLayA[${SEOUL_LAYER_MAX}]; uniform vec4 uLayB[${SEOUL_LAYER_MAX}]; uniform float uLayM[${SEOUL_LAYER_MAX}]; uniform vec2 uSeoulDetail;
flat varying float sLay;
int sgLi = 0; vec4 sgLA = vec4(-1.0); vec4 sgLB = vec4(1.0); vec2 sgLuv = vec2(0.0); vec4 sgDet = vec4(0.5);
`;
function makeMaterials(renderer, layers, groupMats = {}, extra = {}) {
  const mats = {}, pending = [];
  setLayers(layers);
  if (!IS_NODE) {
    pending.push(loadScanArrays(renderer).then((A) => { ATLAS_UNIFORMS.tCityDiff.value = A.diff; ATLAS_UNIFORMS.tCityNor.value = A.nor; mats.texSource = A.source; }));
    const d = detailMap(), t = new THREE.DataTexture(d.data, d.width, d.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4; t.needsUpdate = true; t.name = 'seoul:detail';
    ATLAS_UNIFORMS.tCityDetail.value = t;
  }
  const flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1); flatNormal.needsUpdate = true;
  for (const g of ['ground', 'city']) {   // vertex colour x layer (scan x tint x grime), per-layer roughness / metalness, scan + detail normals
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 1, vertexColors: true });
    mat.normalMap = flatNormal; mat.normalScale.set(1, 1);   // turns on three's tangent-space path; the slices are sampled in patchSeoul
    patchSeoul(mat, 'atlas'); if (g === 'ground') mat.userData.wet = 1;
    mat.name = 'seoul:' + g; mats[g] = mat;
  }
  { const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...SEOUL_MATS.glass.color), roughness: SEOUL_MATS.glass.rough, metalness: 0 });
    mat.emissive = new THREE.Color(0, 0, 0); pending.push(interiorTexture()); patchSeoul(mat, 'glass');
    mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1; mat.name = 'seoul:glass'; mats.glass = mat; }
  { const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0, vertexColors: true });
    mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2; mat.userData.wet = 1; mat.name = 'seoul:lanepaint'; mats.lanepaint = mat; }
  { const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, fog: false, toneMapped: false });
    mat.userData.cityLight = false; mat.name = 'seoul:ao'; mats.ao = mat; }   // contact darkening and leak streaks: dst *= vertex colour
  // partner keys that were not folded (their own material comes from the partner; this is the fallback)
  for (const [k, m] of Object.entries(extra)) if (!mats[k]) { const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...(m.color || [0.3, 0.3, 0.3])), roughness: m.rough ?? 0.8, metalness: m.metal || 0, vertexColors: !!m.vcol }); mat.name = 'seoul:' + k; mats[k] = mat; }
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
    materials: { ...SEOUL_MATS, ...(geo.dressingMats || {}), ...geo.groupMats },
    bounds: { min: [B.x0 - 60, -5, B.z0 - 60], max: [B.x1 + 60, 200, B.z1 + 60] }, envelope: { min: [B.x0 - 30, -2, B.z0 - 30], max: [B.x1 + 30, 160, B.z1 + 30] },
    site: { level: 'seoul-hongdae', seed, NITS, facts: (({ ms, ...f }) => f)(geo.facts), colRanges: geo.colRanges.map(({ key, tri0, tris }) => ({ key, tri0, tris })) },
    extra: { emitters: geo.emitters, setPieces: geo.setPieces, lots,
      // [P3-C] the ground and city meshes draw from two texture arrays (seoul/tex/<id>_diff.ktx2 and _nor_gl.ktx2, slice = textures.ids
      // order) through aLay -> layers[i]: diff / nor slice (-1 none), uv scale 1 / tile, tint colour, roughness, metalness, grime
      layers: geo.layers.map((l) => ({ key: l.key, diff: l.diff, nor: l.nor, id: l.id, tile: l.tile, color: l.color, rough: l.rough, metal: l.metal, grime: l.grime, albedo: l.albedo })),
      textures: { ids: SEOUL_TEX_IDS, diff: SEOUL_TEX_IDS.map((id) => `tex/${id}_diff.ktx2`), nor: SEOUL_TEX_IDS.map((id) => `tex/${id}_nor_gl.ktx2`), detail: { fn: 'world-seoul.js detailMap(512)', scales: [0.83, 3.1], weights: [0.6, 0.4] } },
      interiorAtlas: { module: 'seoul-interiors.js', fn: 'buildInteriorAtlas', width: A.width, height: A.height, tile: A.tile, cols: A.cols, rows: A.rows, boost: A.boost, colour: 'sRGB rgb, linear alpha (1 - light boost / boost)', mean: [...A.mean], near: A.near, strip: A.strip, backEV: A.backEV, roomTiles: '0-9, 11-14 (9 = tower lobby); 10 / 15 near layers (u = strip metres, v = 0..3 m); front layers 1-3, 6 procedural (sgFront in the glass shader)' },
      attributes: { aLay: 'ground / city: layer index into extra.layers', aEm: 'rgb = mean luminance seen through the pane x NITS; w = room + 32 x front + seed', aWin: 'width, height, kind x 4 + sill (kind 0 window, 1 shop bay, 2 door, 3 poster), room depth', color: 'vertex colour: per-lot tint, age, contact darkening (multiply on albedo)' } },
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
  if (opts.interiors !== false) startInteriorAtlas();   // [P3-C] paints in a Worker while the geometry builds
  const geo = buildSeoulGeometry(layout, { lineData, seed: opts.seed ?? SEOUL_SEED });
  prog(0.55, 'Hongdae: materials');
  const { mats, ready } = makeMaterials(renderer, geo.layers, geo.groupMats, geo.dressingMats);
  for (const [k, g] of Object.entries(geo.merged)) {
    let mat = SEOUL_GROUPS[k] ? mats[k] : (geo.dressing?.material?.(k.replace(/^E:/, ''), renderer) || mats[k.replace(/^E:/, '')] || mats.city);
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
    streetById: new Map(layout.streets.map((s) => [s.id, s])), lotById: new Map(layout.lots.map((l) => [l.id, l])), takeClock: opts.takeClock || null,
    setPieces: geo.setPieces || [], obstacles: geo.dressingOut?.obstacles || null, holes: geo.dressingOut?.holes || null };   // ([P5-G1] + stairwell openings: nobody stands in one)   // [P3-G1] life #5/#6: busk under E's stage, walk round E's dressing
  if (opts.lightmap != null) ctx.lightmap = opts.lightmap;   // [P4 H] node tools (the export) ask for D's night lightmap, baked in line
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
    try { parts.dressing = await geo.dressing.build(layout, { ...ctx, dressing: geo.dressingOut, lines: lineData, setPieces: geo.setPieces }); if (parts.dressing?.group) scene.add(parts.dressing.group); emitters.push(...(parts.dressing?.emitters || [])); }
    catch (e) { console.warn('seoulDressing.build', e); }
  }
  await Promise.race([ready, new Promise((r) => setTimeout(r, 8000))]);

  const depthScene = new THREE.Scene(); depthScene.name = 'depthScene';   // C2: no alpha-tested extras in Seoul (yet)
  const moverD = moverDepth(depthScene, parts.life?.group?.userData?.motionMeshes);   // [P5 H, native #6] the traffic in the depth pass (SSAO contact, blur depth)
  const colScene = new THREE.Scene(); { const cm = new THREE.Mesh(geo.colGeo, new THREE.MeshBasicMaterial()); cm.frustumCulled = false; colScene.add(cm); }
  if (geo.signDepth) { const sm = new THREE.Mesh(geo.signDepth, new THREE.MeshBasicMaterial()); sm.name = 'signs-depth'; sm.frustumCulled = false; colScene.add(sm); }   // [P4-B] native #5
  const B = boxOf(layout);
  const sp = geo.takeStart || layout.spawn || { pos: [0, 6, 0], yaw: 0 };   // the first start point (the walking street) when lines exist
  const stats = { ...geo.facts, ms: { geometry: geo.facts.ms, total: 0 }, emitters: emitters.length, textures: mats.texSource || 'pending' };
  const update = (camPos, dt = 1 / 60, camQuat) => {
    uniforms.uTime.value += dt || 0;
    const t = ctx.takeClock ? ctx.takeClock() : uniforms.uTime.value;
    INTERIOR_UNIFORMS.uSeoulTime.value = t % 3600;   // [P4-C] TV flicker
    parts.signs?.update?.(t, camPos, camQuat); parts.life?.update?.(t, camPos, camQuat); parts.dressing?.update?.(t, camPos, camQuat); parts.light?.update?.(t, camPos, camQuat);
    moverD.update();   // [P5 H]
  };
  const world = {
    scene, colliderScene: colScene, depthScene, bvh: geo.bvh, skimBvh: geo.skimBvh, update, hdr: true, stats,
    spawn: new THREE.Vector3(...sp.pos), yaw: sp.yaw,
    takeStart: geo.takeStart ? { pos: new THREE.Vector3(...geo.takeStart.pos), yaw: geo.takeStart.yaw, ...(geo.takeStart.hint ? { hint: geo.takeStart.hint } : {}) } : { pos: new THREE.Vector3(...sp.pos), yaw: sp.yaw },
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
