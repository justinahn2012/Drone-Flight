// world-bando.js — an open abandoned industrial site ("bando") built for FPV:
// open grass field, silo battery on a column table with a head house and an open stair shaft,
// a hollow 50 m brick chimney (dive in, exit at the base), a 3-storey concrete frame hall with holes,
// a conveyor gallery you can fly inside, a workshop ruin, a pipe rack, a beam bridge and a tank.
// Realism comes from CC0 photo-scanned materials + a real sky photo for light (Poly Haven),
// sun shadows, baked sky-visibility occlusion, procedural weathering and graffiti.
// Collision = the same geometry (exact), through a BVH.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshBVH } from 'three-mesh-bvh';

const PH = 'https://dl.polyhaven.org/file/ph-assets';
export const SKIES = {
  // [A] pure skies (no photographed ground/treeline at infinity: it broke scale at altitude). sunRatio: direct sun
  // irradiance vs sky irradiance (HDR captures squash the sun; a clear 48 deg day runs ~5-7x horizontal).
  // sunDir: measured once from the HDR's sun pixels (2k), so the light bake can run before the HDR has downloaded.
  sunny: { id: 'kloofendal_48d_partly_cloudy_puresky', label: 'Sunny', sunRatio: 7.5, sunDir: [0.5544, 0.7417, 0.3775] },
  overcast: { id: 'overcast_soil_puresky', label: 'Overcast', sunRatio: 0, sunDir: [0.3813, 0.921, 0.0794] },
};
const MATS = {
  silo: { id: 'concrete_layers_02', tile: 3.0 },
  wall: { id: 'dirty_concrete', tile: 3.5 },
  slab: { id: 'concrete_floor_worn_001', tile: 4.0 },
  brick: { id: 'factory_brick', tile: 2.2 },
  rust: { id: 'rusty_metal_02', tile: 2.0, metal: true },
  ground: { id: 'forrest_ground_01', tile: 5.0, ground: true },
  bark: { id: 'bark_brown_02', tile: 1.5, foliage: true },
  path: { id: 'grass_path_2', tile: 3.5, ground: true },
};

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- geometry helpers
// UVs in metres, projected along each vertex's dominant normal axis (texture repeat set per material)
function planarUV(g, off) {
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + off.x, y = p.getY(i) + off.y, z = p.getZ(i) + off.z;
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    if (ay >= ax && ay >= az) uv.setXY(i, x, z); else if (ax >= az) uv.setXY(i, z, y); else uv.setXY(i, x, y);
  }
}
function boxGeo(sx, sy, sz) {
  return new THREE.BoxGeometry(sx, sy, sz, Math.max(1, Math.round(sx / 3)), Math.max(1, Math.round(sy / 2.2)), Math.max(1, Math.round(sz / 3)));
}
function cylGeo(rTop, rBot, h, seg, open) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, Math.max(1, Math.round(h / 2.5)), open);
  const uv = g.attributes.uv, p = g.attributes.position, r = (rTop + rBot) / 2;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * r, p.getY(i));
  return g;
}
function flip(g) {
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

class Site {
  constructor() { this.parts = {}; this.decalSpots = []; this.footprints = []; this.trunks = []; }
  add(mat, g, collide = true) {
    if (!g.index) g = indexify(g);
    (this.parts[mat] ||= []).push({ g, collide });
  }
  // axis-aligned (or Y-rotated) box; y0 = bottom
  box(mat, cx, y0, cz, sx, sy, sz, rotY = 0, opt = {}) {
    const g = boxGeo(sx, sy, sz);
    planarUV(g, { x: cx * 0.37, y: y0 + sy / 2, z: cz * 0.53 });
    if (rotY) g.rotateY(rotY);
    g.translate(cx, y0 + sy / 2, cz);
    this.add(mat, g, opt.collide !== false);
    return g;
  }
  // a box placed by an arbitrary basis matrix (for sloped / diagonal members); local box spans x:[0,L]
  beam(mat, M, x0, L, y, z, sy, sz) {
    const g = boxGeo(L, sy, sz);
    planarUV(g, { x: x0 + L / 2, y, z });
    g.translate(x0 + L / 2, y, z);
    g.applyMatrix4(M);
    this.add(mat, g);
  }
  spot(cx, cy, cz, nx, nz, w, h) { this.decalSpots.push({ c: new THREE.Vector3(cx, cy, cz), n: new THREE.Vector3(nx, 0, nz), w, h }); }
}
function indexify(g) {
  const n = g.attributes.position.count, idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1)); return g;
}

// a wall along x (length L) with rectangular openings [{x0, x1, y0, y1}] (local, from wall start)
function wallWithHoles(site, mat, ox, oy, oz, L, H, T, holes, rotY = 0) {
  // split into vertical strips at hole edges, then per strip fill the non-hole y ranges
  const xs = new Set([0, L]); holes.forEach((h) => { xs.add(Math.max(0, h.x0)); xs.add(Math.min(L, h.x1)); });
  const cuts = [...xs].sort((a, b) => a - b);
  const c = Math.cos(rotY), s = Math.sin(rotY);
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1]; if (b - a < 0.01) continue;
    const mid = (a + b) / 2;
    const ys = [[0, H]];
    holes.filter((h) => h.x0 <= mid && h.x1 >= mid).forEach((h) => {
      for (let k = ys.length - 1; k >= 0; k--) {
        const [y0, y1] = ys[k];
        if (h.y1 <= y0 || h.y0 >= y1) continue;
        ys.splice(k, 1);
        if (h.y0 > y0) ys.push([y0, h.y0]);
        if (h.y1 < y1) ys.push([h.y1, y1]);
      }
    });
    for (const [y0, y1] of ys) {
      if (y1 - y0 < 0.01) continue;
      const lx = mid, wx = ox + lx * c, wz = oz - lx * s;
      site.box(mat, wx, oy + y0, wz, b - a, y1 - y0, T, rotY);
    }
  }
}

// tapered hollow tube (chimney): outer + inner skins, jambs around skipped cells, top rim
function tubeGeo(rb, rt, h, th, seg, hseg, skip) {
  const pos = [], nor = [], uv = [], idx = [];
  const R = (y, inner) => (rb + (rt - rb) * (y / h)) - (inner ? th : 0);
  const keep = [];
  for (let j = 0; j < hseg; j++) { keep[j] = []; for (let i = 0; i < seg; i++) { const a = ((i + 0.5) / seg) * Math.PI * 2, y = ((j + 0.5) / hseg) * h; keep[j][i] = !skip(a, y); } }
  const vtx = (a, y, inner, nx, ny, nz, u, v) => { const r = R(y, inner); pos.push(Math.sin(a) * r, y, Math.cos(a) * r); nor.push(nx, ny, nz); uv.push(u, v); return pos.length / 3 - 1; };
  for (const inner of [false, true]) {
    for (let j = 0; j < hseg; j++) for (let i = 0; i < seg; i++) {
      if (!keep[j][i]) continue;
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, y0 = (j / hseg) * h, y1 = ((j + 1) / hseg) * h;
      const sgn = inner ? -1 : 1, cir = 2 * Math.PI * (rb + rt) / 2;
      const q = [[a0, y0], [a1, y0], [a1, y1], [a0, y1]].map(([a, y]) => vtx(a, y, inner, Math.sin(a) * sgn, 0, Math.cos(a) * sgn, (a / (2 * Math.PI)) * cir, y));
      if (inner) idx.push(q[0], q[2], q[1], q[0], q[3], q[2]); else idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
    }
  }
  // jambs: between a kept and a skipped cell, close the wall thickness
  const quad = (p0, p1, p2, p3, n) => { const b = pos.length / 3; [p0, p1, p2, p3].forEach((p) => { pos.push(...p); nor.push(...n); uv.push(p[0] + p[2], p[1]); }); idx.push(b, b + 1, b + 2, b, b + 2, b + 3); };
  const P = (a, y, inner) => { const r = R(y, inner); return [Math.sin(a) * r, y, Math.cos(a) * r]; };
  for (let j = 0; j < hseg; j++) for (let i = 0; i < seg; i++) {
    if (keep[j][i]) continue;
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, y0 = (j / hseg) * h, y1 = ((j + 1) / hseg) * h;
    if (keep[j][(i + seg - 1) % seg]) quad(P(a0, y0, false), P(a0, y1, false), P(a0, y1, true), P(a0, y0, true), [Math.cos(a0), 0, -Math.sin(a0)]);
    if (keep[j][(i + 1) % seg]) quad(P(a1, y0, true), P(a1, y1, true), P(a1, y1, false), P(a1, y0, false), [-Math.cos(a1), 0, Math.sin(a1)]);
    if (j + 1 < hseg && keep[j + 1][i]) quad(P(a0, y1, false), P(a1, y1, false), P(a1, y1, true), P(a0, y1, true), [0, -1, 0]);
    if (j > 0 && keep[j - 1][i]) quad(P(a0, y0, true), P(a1, y0, true), P(a1, y0, false), P(a0, y0, false), [0, 1, 0]);
  }
  for (let i = 0; i < seg; i++) {   // top rim
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    quad(P(a0, h, true), P(a0, h, false), P(a1, h, false), P(a1, h, true), [0, 1, 0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------- the site plan
const GROUND = 0;
function terrainHeight(x, z) {
  const d = Math.max(Math.abs(x + 5) - 95, Math.abs(z - 10) - 85, 0);    // flat working yard, rolling field beyond
  const n = Math.sin(x * 0.021) * Math.cos(z * 0.017) * 1.2 + Math.sin(x * 0.053 + z * 0.041) * 0.45 + Math.sin(z * 0.11 - x * 0.07) * 0.15;
  const ramp = Math.min(1, d / 40);
  return GROUND + n * ramp + Math.min(d, 180) * 0.012 * ramp - 0.05 * (1 - ramp);
}

function buildSite(R) {
  const S = new Site();
  // ---- silo battery: 2 rows x 4 silos (r 4.2, 1.0 m gaps), on a column table, head house on top
  const siloX = [-48, -38.6, -29.2, -19.8], siloZ = [-22, -6], sr = 4.2, tableTop = 5.2, siloTop = 32;
  S.footprints.push({ x0: -54.5, x1: -13.5, z0: -28.5, z1: 0.5 });
  S.box('slab', -34, 4.6, -14, 41, 0.6, 29);                          // table slab
  for (let x = -53; x <= -15.1; x += 4.75) for (let z = -27; z <= -0.9; z += 5.2) {
    S.box('wall', x, 0, z, 0.75, 4.6, 0.75);
    if (R() < 0.12) S.spot(x, 1.6, z + 0.38, 0, 1, 0.75, 1.4);
  }
  for (const x of siloX) for (const z of siloZ) {
    if (Math.abs(x + 33.9) < 6 && Math.abs(z + 14) < 1) continue;
    const g = cylGeo(sr, sr, siloTop - tableTop, 44, true); g.translate(x, (siloTop + tableTop) / 2, z); S.add('silo', g);
    const cap = new THREE.CircleGeometry(sr, 44); cap.rotateX(-Math.PI / 2); planarUV(cap, { x, y: 0, z }); cap.translate(x, siloTop, z); S.add('slab', cap);
  }
  // stair tower between the rows: open shaft, ring landings, big openings each storey, open top
  {
    const tx = -33.9, tz = -14, w = 4.4, top = 37.6, T = 0.3;
    S.footprints.push({ x0: tx - 2.5, x1: tx + 2.5, z0: tz - 2.5, z1: tz + 2.5 });
    const holes = []; for (let y = 1.2; y < top - 2; y += 4) holes.push({ x0: 1.0, x1: 3.4, y0: y, y1: y + 2.6 });
    wallWithHoles(S, 'wall', tx - w / 2, 0, tz - w / 2, w, top, T, holes.filter((_, i) => i % 2 === 0));
    wallWithHoles(S, 'wall', tx - w / 2, 0, tz + w / 2, w, top, T, holes);
    wallWithHoles(S, 'wall', tx - w / 2, 0, tz - w / 2, w, top, T, holes.filter((_, i) => i % 2 === 1), -Math.PI / 2);
    wallWithHoles(S, 'wall', tx + w / 2, 0, tz - w / 2, w, top, T, holes, -Math.PI / 2);
    const inner = w - 2 * T, ring = 0.65;
    for (let y = 4; y < top - 1; y += 4) {
      S.box('slab', tx, y, tz - inner / 2 + ring / 2, inner, 0.22, ring);
      S.box('slab', tx, y, tz + inner / 2 - ring / 2, inner, 0.22, ring);
      S.box('slab', tx - inner / 2 + ring / 2, y, tz, ring, 0.22, inner - 2 * ring);
      S.box('slab', tx + inner / 2 - ring / 2, y, tz, ring, 0.22, inner - 2 * ring);
    }
    S.spot(tx, 1.8, tz + w / 2 + 0.2, 0, 1, 3.6, 1.6);
  }
  // head house: floor over the silos, ribbon windows both sides, roof
  {
    const x0 = -54, x1 = -14, z0 = -28, z1 = 0, y = siloTop, H = 5.4, L = x1 - x0, D = z1 - z0;
    S.box('slab', -34, y, -14, L, 0.4, D);
    // floor opening over the stair shaft
    const band = (zz, rot) => {
      const holes = []; for (let x = 2; x < L - 3; x += 4) holes.push({ x0: x, x1: x + 3.0, y0: 1.0, y1: 3.6 });
      wallWithHoles(S, 'wall', x0, y + 0.4, zz, L, H, 0.3, holes, rot);
    };
    band(z0, 0); band(z1, 0);
    const endHoles = []; for (let z = 2; z < D - 3; z += 4.5) endHoles.push({ x0: z, x1: z + 3.2, y0: 1.0, y1: 3.6 });
    wallWithHoles(S, 'wall', x0, y + 0.4, z0, D, H, 0.3, endHoles, -Math.PI / 2);
    wallWithHoles(S, 'wall', x1, y + 0.4, z0, D, H, 0.3, endHoles, -Math.PI / 2);
    // roof with the stair shaft left open
    S.box('slab', -44, y + 5.8, -14, 20, 0.35, D); S.box('slab', -21.5, y + 5.8, -14, 15, 0.35, D);
    S.box('slab', -33.9, y + 5.8, -23, 4.2, 0.35, 10); S.box('slab', -33.9, y + 5.8, -5, 4.2, 0.35, 10);
  }

  // ---- chimney: hollow, tapered, brick; door at the base facing south
  {
    const cx = 44, cz = -40, h = 50, rb = 3.4, rt = 2.0, th = 0.35;
    const g = tubeGeo(rb, rt, h, th, 40, 25, (a, y) => y < 3.4 && (Math.abs(a) < 0.42 || Math.abs(a - Math.PI * 2) < 0.42));
    g.translate(cx, 0, cz); S.add('brick', g);
    S.box('slab', cx, 0, cz, 8.5, 0.5, 8.5);
    S.footprints.push({ x0: cx - 4.5, x1: cx + 4.5, z0: cz - 4.5, z1: cz + 4.5 });
    S.spot(cx + 2.4, 1.6, cz + 2.6, 0.67, 0.74, 2.0, 1.3);
  }

  // ---- factory hall: 64 x 22 m, three storeys of 5 m, column grid, holes, ribbon windows, roof slots
  {
    const x0 = 6, x1 = 70, z0 = 14, z1 = 36, fh = 5, levels = 3, cols = 11, rows = 5;
    const dx = (x1 - x0) / (cols - 1), dz = (z1 - z0) / (rows - 1);
    S.footprints.push({ x0: x0 - 1, x1: x1 + 1, z0: z0 - 1, z1: z1 + 1 });
    S.box('slab', (x0 + x1) / 2, 0, (z0 + z1) / 2, x1 - x0 + 1.2, 0.18, z1 - z0 + 1.2);
    for (let L = 0; L < levels; L++) {
      const yb = L * fh, slabY = (L + 1) * fh - 0.35;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) S.box('wall', x0 + i * dx, yb + (L ? 0 : 0.18), z0 + j * dz, 0.6, fh - 0.35 - (L ? 0 : 0.18), 0.6);
      // slab bays: some missing (holes), roof gets narrow slots instead
      for (let i = 0; i < cols - 1; i++) for (let j = 0; j < rows - 1; j++) {
        const cxb = x0 + (i + 0.5) * dx, czb = z0 + (j + 0.5) * dz;
        const roof = L === levels - 1;
        const r = R();
        if (!roof && r < 0.13) continue;                                  // a hole to drop through
        if (roof && r < 0.22) {                                            // slot ("the small gap")
          const slot = 1.25;
          S.box('slab', cxb - (dx + 0.02) / 4 - slot / 4, slabY, czb, (dx - slot) / 2 + 0.01, 0.35, dz + 0.02);
          S.box('slab', cxb + (dx + 0.02) / 4 + slot / 4, slabY, czb, (dx - slot) / 2 + 0.01, 0.35, dz + 0.02);
          continue;
        }
        S.box('slab', cxb, slabY, czb, dx + 0.02, 0.35, dz + 0.02);
      }
      // long facades: spandrel + lintel bands, open ribbon windows; some bays with rusty mullion grids
      for (const [zz, nz] of [[z0, -1], [z1, 1]]) {
        S.box('wall', (x0 + x1) / 2, yb + (L ? 0 : 0.18), zz, x1 - x0, 1.0, 0.25);
        S.box('wall', (x0 + x1) / 2, yb + 3.9, zz, x1 - x0, fh - 3.9 - 0.35, 0.25);
        for (let i = 0; i < cols - 1; i++) {
          const bx = x0 + (i + 0.5) * dx;
          if (R() < 0.12) S.box('wall', bx, yb + 1.0, zz, dx - 0.6, 2.9, 0.22);                // bricked-up bay
          else if (R() < 0.42) {
            for (let k = 1; k < 4; k++) S.box('rust', bx - dx / 2 + k * (dx / 4), yb + 1.0, zz, 0.09, 2.9, 0.09);
            S.box('rust', bx, yb + 2.45, zz, dx - 0.6, 0.08, 0.09);
          }
          if (L === 0 && R() < 0.45) S.spot(bx, 0.55, zz + nz * 0.15, 0, nz, dx * 0.8, 0.85);
        }
      }
      // gable ends: wall with windows, ground floor gets a big door
      for (const [xx, nx] of [[x0, -1], [x1, 1]]) {
        const holes = [];
        for (let j = 0; j < rows - 1; j++) holes.push({ x0: j * dz + 1.0, x1: (j + 1) * dz - 1.0, y0: 1.0, y1: 3.8 });
        if (L === 0) holes.push({ x0: dz * 1.4, x1: dz * 2.6, y0: 0, y1: 4.4 });
        wallWithHoles(S, 'wall', xx, yb + (L ? 0 : 0.18), z0, z1 - z0, fh - 0.35 - (L ? 0 : 0.18), 0.3, holes, -Math.PI / 2);
        if (L === 0) S.spot(xx + nx * 0.2, 1.9, z0 + dz * 0.6, nx, 0, 3.5, 1.5);
      }
      // interior partitions with doorways
      if (L < 2) {
        const px = x0 + dx * (3 + L * 4);
        wallWithHoles(S, 'wall', px, yb + 0.18, z0 + 0.3, z1 - z0 - 0.6, fh - 0.55, 0.25, [{ x0: 4, x1: 6.5, y0: 0, y1: 3.2 }, { x0: 13, x1: 15.5, y0: 0, y1: 3.2 }], -Math.PI / 2);
        S.spot(px + 0.2, 1.5, z0 + 8, 1, 0, 3.2, 1.4);
      }
    }
    // parapet
    S.box('wall', (x0 + x1) / 2, levels * fh, z0, x1 - x0, 0.9, 0.25); S.box('wall', (x0 + x1) / 2, levels * fh, z1, x1 - x0, 0.9, 0.25);
    // rubble piles on the ground floor
    for (let k = 0; k < 14; k++) { const s = 0.4 + R() * 0.9; S.box('slab', x0 + 3 + R() * (x1 - x0 - 6), 0.18, z0 + 2 + R() * (z1 - z0 - 4), s * 1.6, s * 0.6, s, R() * 3); }
  }

  // ---- conveyor gallery: sloped hollow tube from the head house east windows down to the hall roof
  {
    const A = new THREE.Vector3(-14.3, 33.4, -6.5), B = new THREE.Vector3(12.5, 15.35, 24.5);
    const dir = B.clone().sub(A); const L = dir.length(); dir.normalize();
    const zA = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const yA = new THREE.Vector3().crossVectors(zA, dir).normalize();
    const M = new THREE.Matrix4().makeBasis(dir, yA, zA).setPosition(A);
    const W = 3.0, H = 2.6;
    S.beam('slab', M, 0, L, 0.1, 0, 0.22, W);              // floor
    S.beam('wall', M, 0, L, H, 0, 0.22, W);                // roof
    for (let x = 0; x < L; x += 4) {                       // side walls in panels with window gaps
      const seg = Math.min(2.6, L - x);
      S.beam('wall', M, x, seg, H / 2 + 0.05, -W / 2, H, 0.18);
      S.beam('wall', M, x, seg, H / 2 + 0.05, W / 2, H, 0.18);
    }
    // support towers
    for (const t of [0.35, 0.68]) {
      const P = A.clone().lerp(B, t);
      for (const [ox, oz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) S.box('rust', P.x + ox, 0, P.z + oz, 0.32, P.y - 0.2, 0.32);
      for (let y = 4; y < P.y - 1; y += 5) { S.box('rust', P.x, y, P.z - 1.4, 3.1, 0.25, 0.25); S.box('rust', P.x, y, P.z + 1.4, 3.1, 0.25, 0.25); S.box('rust', P.x - 1.4, y, P.z, 0.25, 0.25, 3.1); S.box('rust', P.x + 1.4, y, P.z, 0.25, 0.25, 3.1); }
      S.footprints.push({ x0: P.x - 2, x1: P.x + 2, z0: P.z - 2, z1: P.z + 2 });
    }
  }

  // ---- workshop ruin: 2 storeys, windows, doorways, half the roof gone
  {
    const x0 = -64, z0 = 40, Lx = 22, Lz = 13, fh = 4.2, T = 0.35;
    S.footprints.push({ x0: x0 - 1, x1: x0 + Lx + 1, z0: z0 - 1, z1: z0 + Lz + 1 });
    for (let L = 0; L < 2; L++) {
      const yb = L * fh;
      const hx = []; for (let x = 1.5; x < Lx - 2; x += 3.4) hx.push({ x0: x, x1: x + 1.5, y0: 1.0, y1: 2.8 });
      if (L === 0) hx.push({ x0: 9.4, x1: 11.8, y0: 0, y1: 3.0 });
      wallWithHoles(S, 'wall', x0, yb, z0 + Lz, Lx, fh, T, hx);
      wallWithHoles(S, 'wall', x0, yb, z0, Lx, fh, T, hx.filter((_, i) => i % 2 === 0));
      const hz = [{ x0: 2, x1: 3.6, y0: 1.0, y1: 2.8 }, { x0: 6.2, x1: 7.8, y0: L ? 1.0 : 0, y1: 2.9 }, { x0: 9.6, x1: 11.2, y0: 1.0, y1: 2.8 }];
      wallWithHoles(S, 'wall', x0, yb, z0, Lz, fh, T, hz, -Math.PI / 2);
      wallWithHoles(S, 'wall', x0 + Lx, yb, z0, Lz, fh, T, hz, -Math.PI / 2);
      if (L === 0) { S.spot(x0 + 5, 1.4, z0 + Lz + 0.2, 0, 1, 3.4, 1.5); S.spot(x0 + 16, 1.2, z0 - 0.2, 0, -1, 3.0, 1.3); }
    }
    S.box('slab', x0 + 6, fh - 0.3, z0 + Lz / 2, 12, 0.3, Lz);                 // first floor, partial
    S.box('slab', x0 + 18.5, fh - 0.3, z0 + Lz / 2, 7, 0.3, Lz * 0.45);
    S.box('slab', x0 + 5.5, 2 * fh, z0 + Lz / 2, 11, 0.3, Lz + 0.4);         // half a roof
  }

  // ---- pipe rack between hall and chimney
  {
    const A = new THREE.Vector3(22, 0, 11), B = new THREE.Vector3(41, 0, -33);
    const n = 6; const yaw = Math.atan2(-(B.z - A.z), B.x - A.x);
    for (let k = 0; k <= n; k++) {
      const P = A.clone().lerp(B, k / n);
      S.box('rust', P.x - Math.sin(yaw) * 1.6, 0, P.z - Math.cos(yaw) * 1.6, 0.35, 7, 0.35);
      S.box('rust', P.x + Math.sin(yaw) * 1.6, 0, P.z + Math.cos(yaw) * 1.6, 0.35, 7, 0.35);
      S.box('rust', P.x, 7, P.z, 0.3, 0.3, 3.6, yaw);
    }
    const dir = B.clone().sub(A); const L = dir.length(); dir.normalize();
    for (const [off, r, y] of [[-0.9, 0.38, 7.7], [0.1, 0.28, 7.6], [0.95, 0.45, 7.8]]) {
      const g = cylGeo(r, r, L, 16, false); g.rotateZ(Math.PI / 2); g.rotateY(yaw);
      g.translate((A.x + B.x) / 2 + Math.sin(yaw) * off, y, (A.z + B.z) / 2 + Math.cos(yaw) * off); S.add('rust', g);
    }
  }

  // ---- beam bridge: two pylons and a narrow concrete beam to fly along
  {
    S.box('wall', -82, 0, 18, 2.4, 12, 2.4); S.box('wall', -82, 0, -18, 2.4, 12, 2.4);
    S.box('slab', -82, 12, 0, 0.9, 0.7, 38.4);
    S.spot(-80.6, 2, 18, 1, 0, 2.0, 1.4);
    S.footprints.push({ x0: -84, x1: -80, z0: -20, z1: 20 });
  }
  // ---- rusty tank
  {
    const g = cylGeo(5.5, 5.5, 8, 36, false); g.translate(-78, 4, -48); S.add('rust', g);
    S.footprints.push({ x0: -84, x1: -72, z0: -54, z1: -42 });
  }
  // ---- scattered concrete blocks and fallen slabs
  for (let k = 0; k < 40; k++) {
    const x = -90 + R() * 180, z = -60 + R() * 140;
    if (S.footprints.some((f) => x > f.x0 - 2 && x < f.x1 + 2 && z > f.z0 - 2 && z < f.z1 + 2)) continue;
    const s = 0.6 + R() * 1.4; S.box('slab', x, terrainHeight(x, z) - 0.1, z, s * 1.8, s * 0.7, s, R() * 3);
  }
  return S;
}

const PATHS = [
  [[0, 160], [0, 95], [6, 60], [18, 42], [30, 38]],
  [[6, 60], [-14, 30], [-30, 6], [-34, 2]],
  [[-14, 30], [-40, 40], [-52, 54]],
  [[18, 42], [30, 6], [40, -24], [44, -34]],
  [[-30, 6], [-60, 0], [-80, -8], [-84, -30], [-78, -40]],
];
function distToPaths(x, z) {
  let best = Infinity;
  for (const p of PATHS) for (let i = 0; i < p.length - 1; i++) {
    const [ax, az] = p[i], [bx, bz] = p[i + 1];
    const vx = bx - ax, vz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
    best = Math.min(best, Math.hypot(x - ax - t * vx, z - az - t * vz));
  }
  return best;
}

// ---------------------------------------------------------------- textures made on the fly
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); draw(g, w, h);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function grassTexture(R) {
  // a tuft, not a block: blade roots bunched in the middle, tall in the centre, splaying outwards, ragged tops
  return canvasTex(512, 512, (g, w, h) => {
    for (let i = 0; i < 170; i++) {
      const u = (R() + R() + R()) / 3 - 0.5;                 // roots near the centre
      const x = w / 2 + u * w * 0.55;
      const tall = 0.25 + 0.75 * (1 - Math.abs(u) * 1.7) * (0.55 + R() * 0.45);
      const top = h * (1 - Math.max(0.12, tall) * 0.97);
      const bend = u * 160 + (R() - 0.5) * 50, wd = 2.5 + R() * 4;
      const t = R(); const col = t < 0.4 ? [64 + R() * 35, 92 + R() * 45, 30 + R() * 22] : t < 0.78 ? [105 + R() * 40, 120 + R() * 40, 45 + R() * 28] : [165 + R() * 45, 155 + R() * 35, 90 + R() * 30];
      const gr = g.createLinearGradient(0, h, 0, top);
      gr.addColorStop(0, `rgb(${col[0] * 0.68 | 0},${col[1] * 0.72 | 0},${col[2] * 0.6 | 0})`); gr.addColorStop(1, `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`);
      g.fillStyle = gr; g.beginPath(); g.moveTo(x - wd / 2, h); g.quadraticCurveTo(x + bend * 0.25, (h + top) / 2, x + bend, top); g.quadraticCurveTo(x + bend * 0.25 + wd * 0.25, (h + top) / 2, x + wd / 2, h); g.fill();
    }
  });
}
function leafTexture(R) {
  return canvasTex(512, 512, (g, w, h) => {
    for (let i = 0; i < 900; i++) {
      const a = R() * Math.PI * 2, rr = Math.sqrt(R()) * w * 0.45, x = w / 2 + Math.cos(a) * rr, y = h / 2 + Math.sin(a) * rr;
      const s = 6 + R() * 10, sh = 0.35 + R() * 0.65;
      g.fillStyle = `rgb(${(35 + R() * 45) * sh + 10 | 0},${(70 + R() * 60) * sh + 15 | 0},${(20 + R() * 25) * sh | 0})`;
      g.save(); g.translate(x, y); g.rotate(R() * Math.PI); g.beginPath(); g.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2); g.fill(); g.restore();
    }
  });
}
const TAGS = ['FCU', 'MS', 'OX', 'SKEB', 'ZOMB', 'RISE', 'DOK', 'KAOS', 'VEX', 'NOPE', 'BANDO', 'GONZ', 'RAW', 'SEKT', 'MOHA', 'LUX'];
function graffitiAtlas(R) {
  const palette = [['#ff4f9a', '#ffd0e6'], ['#2ec4ff', '#c8f2ff'], ['#ffd23f', '#fff3b0'], ['#3ddc84', '#d6ffe8'], ['#ff6b35', '#ffd5c2'], ['#b388ff', '#ece0ff'], ['#f2f2f2', '#9ad'], ['#e63946', '#f4a261']];
  return canvasTex(2048, 1024, (g, W, Hh) => {
    g.clearRect(0, 0, W, Hh);
    for (let k = 0; k < 16; k++) {
      const cx = (k % 4) * 512, cy = Math.floor(k / 4) * 256, word = TAGS[k];
      const [c1, c2] = palette[Math.floor(R() * palette.length)];
      g.save(); g.translate(cx + 256, cy + 140); g.rotate((R() - 0.5) * 0.18); g.scale(0.85 + R() * 0.35, 1);
      g.font = `900 ${150 - word.length * 12}px "Futura", "Avenir Next Condensed", "Arial Black", Impact, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      const plain = R() < 0.3;
      if (plain) { g.lineWidth = 8; g.strokeStyle = c1; g.font = `italic 700 ${110}px "Snell Roundhand", "Brush Script MT", cursive`; g.strokeText(word.toLowerCase(), 0, 0); }
      else {
        g.lineWidth = 30; g.strokeStyle = '#111'; g.strokeText(word, 0, 0);
        const gr = g.createLinearGradient(0, -60, 0, 60); gr.addColorStop(0, c2); gr.addColorStop(0.55, c1); gr.addColorStop(1, c1);
        g.fillStyle = gr; g.fillText(word, 0, 0);
        g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,0.75)'; g.strokeText(word, -3, -3);
        g.fillStyle = c1; for (let d = 0; d < 6; d++) { const x = (R() - 0.5) * 300, len = 10 + R() * 50; g.fillRect(x, 50, 3, len); }
      }
      g.restore();
    }
  });
}

// ---------------------------------------------------------------- materials
function weatherPatch(mat, { ground = false, foliage = false, wind = false } = {}, uniforms) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float ao;
attribute vec3 bounce;
varying float vAO;
varying vec3 vBounce;
varying vec3 vWPos;
uniform float uTime;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${wind ? `#ifdef USE_INSTANCING
  vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float sway = sin(uTime * 1.9 + ip.x * 0.31 + ip.z * 0.23) + 0.4 * sin(uTime * 4.3 + ip.x * 1.7);
  transformed.x += sway * 0.07 * position.y; transformed.z += sway * 0.04 * position.y;
#endif` : ''}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vAO = ao; vBounce = bounce;
  vec4 wpp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wpp = instanceMatrix * wpp;
  #endif
  vWPos = (modelMatrix * wpp).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vAO;
varying vec3 vBounce;
varying vec3 vWPos;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
${ground ? `
  float patchy = vn(vWPos.xz * 0.045) * 0.6 + vn(vWPos.xz * 0.19) * 0.4;
  diffuseColor.rgb *= mix(vec3(0.82, 0.86, 0.72), vec3(1.08, 1.04, 0.9), patchy);
  vec3 meadow = mix(vec3(0.20, 0.25, 0.08), vec3(0.42, 0.40, 0.18), vn(vWPos.xz * 0.06));
  diffuseColor.rgb = mix(diffuseColor.rgb, meadow, 0.45 * smoothstep(0.25, 0.75, vn(vWPos.xz * 0.013 + 3.0) + 0.35));` : foliage ? '' : `
  float hgt = vWPos.y;
  float damp = mix(0.62, 1.0, smoothstep(0.0, 1.9, hgt - 0.05));
  float hc = vWPos.x + vWPos.z;
  float streak = smoothstep(0.55, 0.92, vn(vec2(hc * 1.3, hgt * 0.07)));
  float blot = vn(vec2(hc * 0.11, hgt * 0.09)) * 0.7 + vn(vec2(hc * 0.5, hgt * 0.5)) * 0.3;
  diffuseColor.rgb *= damp * (1.0 - 0.3 * streak) * (0.78 + 0.36 * blot);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.92, 0.62), (1.0 - smoothstep(0.0, 1.4, hgt)) * 0.55);`}`)
      .replace('#include <aomap_fragment>', `reflectedLight.indirectDiffuse = reflectedLight.indirectDiffuse * vAO + vBounce * BRDF_Lambert(material.diffuseColor);
  reflectedLight.indirectSpecular *= vAO * vAO;
#include <aomap_fragment>`);
    // [A-lighting] begin: baked sun/sky bounce, sun mask, far shadow map, forward-scatter haze (see aLightingPatch)
    aLightingPatch(sh, uniforms);
    // [A-lighting] end
  };
  return mat;
}

// ---------------------------------------------------------------- [A] light bake (sky-independent: runs before the HDR arrives)
// Needs only SKIES[sky].sunDir. Per render vertex it stores
//   ao       cosine-weighted openness (ray misses) -> scales the env (PMREM) light in weatherPatch
//   aBSun    multi-bounce irradiance per unit sun irradiance (rgb)  -> x uSunB (= sunColor * sunI)
//   aBSky    multi-bounce irradiance per unit sky irradiance (rgb)  -> x uSkyB (= skyE * envI)
//   aSunOcc  1 - dilated sun visibility, only where the mesh is fine enough to resolve it (chimney): no shadow-map leaks
// The bounce is a gather: each vertex's rays remember the triangle + barycentrics they hit, then three passes of
// pure arithmetic carry (direct sun + sky + far ground) x albedo from vertex to vertex. Albedo per material from MATS.
const DIRS = (() => { const d = []; const n = 10; for (let i = 0; i < n; i++) { const u = (i + 0.5) / n, phi = i * 2.399963; const r = Math.sqrt(u); d.push([Math.cos(phi) * r, Math.sqrt(1 - u), Math.sin(phi) * r]); } return d; })();
const _ray = new THREE.Ray(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _bx = new THREE.Vector3(), _by = new THREE.Vector3();
const _hn = new THREE.Vector3(), _sr = new THREE.Ray(), _P = new THREE.Vector3(), _N = new THREE.Vector3();
const ALB_DEFAULT = [0.3, 0.29, 0.27];
// mean linear albedo of today's textures after weathering (measured from the 1k diffuse maps), until MATS[key].albedo lands
const ALB_FALLBACK = { silo: [0.18, 0.17, 0.15], wall: [0.21, 0.19, 0.16], slab: [0.08, 0.08, 0.075], brick: [0.21, 0.13, 0.085], rust: [0.25, 0.17, 0.08], bark: [0.11, 0.09, 0.055], path: [0.22, 0.19, 0.11], ground: [0.19, 0.18, 0.12] };
const albedoOf = (k) => MATS[k]?.albedo ?? ALB_FALLBACK[k] ?? ALB_DEFAULT;
function groundAlbedo() { const g = MATS.ground?.albedo, s = MATS.grass?.albedo; return g && s ? g.map((v, i) => (v + s[i]) / 2) : g ?? s ?? ALB_FALLBACK.ground; }
const aoCurve = (v) => Math.pow(v, 1.15);
// legacy probe API (decals etc.): lightProbe() returns openness and leaves the final-unit bounce in LP.out
const LP = { sun: new THREE.Vector3(0, 1, 0), sunRGB: new THREE.Vector3(), skyRGB: new THREE.Vector3(), out: new THREE.Vector3() };
let BAKE = null;
function lightProbe(bvh, p, n, maxD, rays) {
  if (!BAKE) { LP.out.set(0, 0, 0); return skyVisibility(bvh, p, n, maxD, rays); }
  const r = BAKE.probe(p, n, Math.max(4, rays), maxD);
  LP.out.set(r.bs[0] * LP.sunRGB.x + r.bk[0] * LP.skyRGB.x, r.bs[1] * LP.sunRGB.y + r.bk[1] * LP.skyRGB.y, r.bs[2] * LP.sunRGB.z + r.bk[2] * LP.skyRGB.z);
  return r.open;
}
function skyVisibility(bvh, p, n, maxD, rays) {
  // cosine-weighted hemisphere around n
  const up = Math.abs(n.y) < 0.95 ? _t2.set(0, 1, 0) : _t2.set(1, 0, 0);
  _bx.crossVectors(up, n).normalize(); _by.crossVectors(n, _bx);
  let open = 0;
  for (let i = 0; i < rays; i++) {
    const [a, b, c] = DIRS[(i * 3 + 1) % DIRS.length];
    _t1.set(0, 0, 0).addScaledVector(_bx, a).addScaledVector(n, b).addScaledVector(_by, c).normalize();
    _ray.origin.copy(p).addScaledVector(n, 0.06); _ray.direction.copy(_t1);
    const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, maxD);
    open += hit ? 0.2 * (0.55 + 0.45 * Math.min(1, hit.distance / maxD)) : 1;
  }
  return open / rays;
}
// a fixed cosine-weighted pattern (same for every vertex: smooth, not noisy)
function cosPattern(n) { const d = []; for (let i = 0; i < n; i++) { const u = (i + 0.5) / n, ph = 2 * Math.PI * ((i * 0.618034 + 0.31) % 1), r = Math.sqrt(u); d.push([r * Math.cos(ph), Math.sqrt(1 - u), r * Math.sin(ph)]); } return d; }
// collider vertex -> render vertex. Assumes colGeo = [collidable parts in site.parts order..., terrain, anything else];
// every part is verified by position, and anything unmatched falls back to a per-hit estimate.
function colliderMap(site, terr, colGeo, list, base) {
  const cp = colGeo.attributes.position.array, NC = cp.length / 3, map = new Int32Array(NC).fill(-1);
  const same = (a, i, c) => Math.abs(a[i * 3] - cp[c * 3]) < 1e-4 && Math.abs(a[i * 3 + 1] - cp[c * 3 + 1]) < 1e-4 && Math.abs(a[i * 3 + 2] - cp[c * 3 + 2]) < 1e-4;
  let oc = 0, ok = true;
  const link = (a, n, r0) => { if (n === 0) return true; if (oc + n > NC || !same(a, 0, oc) || !same(a, n - 1, oc + n - 1)) return false; for (let i = 0; i < n; i++) map[oc + i] = r0 + i; oc += n; return true; };
  for (const [mat, parts] of Object.entries(site.parts)) {
    const gi = list.findIndex(([k]) => k === mat); let om = 0;
    for (const e of parts) { const n = e.g.attributes.position.count; if (ok && e.collide) ok = gi >= 0 && link(e.g.attributes.position.array, n, base[gi] + om); om += n; }
  }
  if (ok) ok = link(terr.attributes.position.array, terr.attributes.position.count, base[list.length - 1]);
  if (!ok) console.warn('[A-lighting] collider layout changed: bounce at unmatched hits is estimated per hit', oc, '/', NC);
  return { map, matched: oc };
}
// vertices whose longest adjacent edge is <= lim: there a per-vertex sun mask is trustworthy
function fineVerts(g, lim) {
  const idx = g.index.array, p = g.attributes.position.array, mx = new Float32Array(g.attributes.position.count);
  const d2 = (a, b) => { const x = p[a * 3] - p[b * 3], y = p[a * 3 + 1] - p[b * 3 + 1], z = p[a * 3 + 2] - p[b * 3 + 2]; return x * x + y * y + z * z; };
  for (let t = 0; t < idx.length; t += 3) { const a = idx[t], b = idx[t + 1], c = idx[t + 2], m = Math.max(d2(a, b), d2(b, c), d2(c, a)); if (m > mx[a]) mx[a] = m; if (m > mx[b]) mx[b] = m; if (m > mx[c]) mx[c] = m; }
  const out = new Uint8Array(mx.length); for (let i = 0; i < mx.length; i++) out[i] = mx[i] > 0 && mx[i] <= lim * lim ? 1 : 0; return out;
}
// welded vertex graph (same position within 2 mm + similar normal = one node), 1-ring CSR adjacency: smooths the
// baked light over neighbours (an irradiance filter: ~8 x (1 + ring) effective rays per vertex)
function weldGraph(list, base, NV) {
  const node = new Int32Array(NV), head = new Map(), nextN = new Int32Array(NV), nQ = new Int32Array(NV * 3), nN = new Float32Array(NV * 3); let nn = 0;
  for (let gi = 0; gi < list.length; gi++) {
    const g = list[gi][1], p = g.attributes.position.array, nr = g.attributes.normal.array, cnt = g.attributes.position.count;
    for (let li = 0; li < cnt; li++) {
      const x = Math.round(p[li * 3] * 500), y = Math.round(p[li * 3 + 1] * 500), z = Math.round(p[li * 3 + 2] * 500), h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
      const nx = nr[li * 3], ny = nr[li * 3 + 1], nz = nr[li * 3 + 2];
      let n = head.has(h) ? head.get(h) : -1, f = -1;
      while (n >= 0) { if (nQ[n * 3] === x && nQ[n * 3 + 1] === y && nQ[n * 3 + 2] === z && nN[n * 3] * nx + nN[n * 3 + 1] * ny + nN[n * 3 + 2] * nz > 0.8) { f = n; break; } n = nextN[n]; }
      if (f < 0) { f = nn++; nQ[f * 3] = x; nQ[f * 3 + 1] = y; nQ[f * 3 + 2] = z; nN[f * 3] = nx; nN[f * 3 + 1] = ny; nN[f * 3 + 2] = nz; nextN[f] = head.has(h) ? head.get(h) : -1; head.set(h, f); }
      node[base[gi] + li] = f;
    }
  }
  const deg = new Int32Array(nn + 1);
  const eachEdge = (fn) => { for (let gi = 0; gi < list.length; gi++) { const idx = list[gi][1].index.array, b = base[gi]; for (let t = 0; t < idx.length; t += 3) { const a = node[b + idx[t]], c = node[b + idx[t + 1]], d = node[b + idx[t + 2]]; if (a !== c) { fn(a, c); fn(c, a); } if (c !== d) { fn(c, d); fn(d, c); } if (d !== a) { fn(d, a); fn(a, d); } } } };
  eachEdge((a) => deg[a + 1]++);
  for (let i = 0; i < nn; i++) deg[i + 1] += deg[i];
  const adj = new Int32Array(deg[nn]), fill = deg.slice(0, nn); eachEdge((a, c) => { adj[fill[a]++] = c; });
  // dedupe each neighbour list (shared triangle edges appear twice)
  const off = new Int32Array(nn + 1); let w = 0;
  for (let i = 0; i < nn; i++) { off[i] = w; const s = adj.subarray(deg[i], deg[i + 1]).sort(); let prev = -1; for (let k = 0; k < s.length; k++) { const x = s[k]; if (x !== prev) { adj[w++] = x; prev = x; } } }
  off[nn] = w;
  const cntN = new Float32Array(nn); for (let v = 0; v < NV; v++) cntN[node[v]]++;
  // in place: arr (NV x comps) <- 1-ring mean over welded nodes, `rings` times
  const smooth = (arr, comps, rings = 1) => {
    let acc = new Float32Array(nn * comps);
    for (let v = 0; v < NV; v++) for (let c = 0; c < comps; c++) acc[node[v] * comps + c] += arr[v * comps + c];
    for (let n = 0; n < nn; n++) for (let c = 0; c < comps; c++) acc[n * comps + c] /= cntN[n];
    for (let r = 0; r < rings; r++) {
      const out = new Float32Array(nn * comps);
      for (let n = 0; n < nn; n++) { const k0 = off[n], k1 = off[n + 1], inv = 1 / (1 + k1 - k0);
        for (let c = 0; c < comps; c++) { let sum = acc[n * comps + c]; for (let k = k0; k < k1; k++) sum += acc[adj[k] * comps + c]; out[n * comps + c] = sum * inv; } }
      acc = out;
    }
    for (let v = 0; v < NV; v++) for (let c = 0; c < comps; c++) arr[v * comps + c] = acc[node[v] * comps + c];
  };
  return { nodes: nn, edges: w, smooth, node, off, adj };
}
function fastYield() {   // a MessageChannel hop: no 4 ms timer clamp, still lets network callbacks + the loader paint run
  if (typeof MessageChannel === 'undefined') return { y: yieldUI, close() {} };
  const ch = new MessageChannel(), q = []; ch.port1.onmessage = () => q.shift()?.();
  return { y: () => new Promise((r) => { q.push(r); ch.port2.postMessage(0); }), close() { ch.port1.close(); ch.port2.close(); } };
}

const SMOOTH_RINGS = 1;   // measured on visible hall/table surfaces vs 64-ray probes: RMS log err 0.71 (0 rings) / 0.66 (1) / 0.69 (2)
export async function bakeLight(geo, { sunDir, sun = true, quality = 'auto', onTick } = {}) {
  const t0 = performance.now();
  const { site, merged, terr, colGeo, bvh } = geo;
  const L = new THREE.Vector3(...(sunDir?.isVector3 ? sunDir.toArray() : sunDir || [0, 1, 0])).normalize();
  const list = [...Object.entries(merged), ['terr', terr]], base = []; let NV = 0;
  for (const [, g] of list) { base.push(NV); NV += g.attributes.position.count; }
  const rays = quality === 'low' ? 6 : quality === 'high' ? 10 : 8, raysT = quality === 'low' ? 4 : quality === 'high' ? 6 : 5;
  const R = rays, PAT = cosPattern(rays), PATT = cosPattern(raysT);
  const albTab = list.map(([k]) => (k === 'terr' ? groundAlbedo() : albedoOf(k))), albG = groundAlbedo();
  const gOf = new Uint8Array(NV); list.forEach(([, g], gi) => gOf.fill(gi, base[gi], base[gi] + g.attributes.position.count));
  // albedo index per vertex: the material's, except terrain under the dirt tracks (path) and, once stream B adds
  // MATS.apron, the concrete apron within MATS.apron.radius (default 9 m) of a footprint (what a window looks out on)
  const aOf = gOf.slice();
  {
    const ti = list.length - 1, tp = terr.attributes.position.array, iPath = albTab.push(albedoOf('path')) - 1, ap = MATS.apron?.albedo, rad = MATS.apron?.radius ?? 9;
    const iApron = ap ? albTab.push(ap) - 1 : -1, fps = site.footprints || [];
    for (let i = 0; i < terr.attributes.position.count; i++) {
      const x = tp[i * 3], z = tp[i * 3 + 2], v = base[ti] + i;
      if (iApron >= 0 && fps.some((f) => Math.max(f.x0 - x, 0, x - f.x1) ** 2 + Math.max(f.z0 - z, 0, z - f.z1) ** 2 < rad * rad)) aOf[v] = iApron;
      else if (distToPaths(x, z) < 2.6) aOf[v] = iPath;
    }
  }
  const invR = list.map(([k]) => 1 / (k === 'terr' ? raysT : rays));
  const { map: c2r } = colliderMap(site, terr, colGeo, list, base);
  const hV = new Int32Array(NV * R * 3).fill(-1), hW = new Float32Array(NV * R * 2);
  const open = new Float32Array(NV), S = new Float32Array(NV), occ = new Float32Array(NV);
  const K = new Float32Array(NV * 3), G = new Float32Array(NV * 3), X = new Float32Array(NV * 6);
  const sunMax = Math.min(400, 70 / Math.max(0.1, L.y) + 10), sinE = Math.max(0, L.y);
  const sunVis = (o) => { _sr.origin.copy(o); _sr.direction.copy(L); return !bvh.raycastFirst(_sr, THREE.DoubleSide, 0, sunMax); };
  const Q = new THREE.Vector3(), D = new THREE.Vector3();
  // a hit we can't map to a render vertex: estimate the light at the hit point itself (sun ray + unoccluded sky)
  const estimate = (hit, dir, out, o6, w) => {
    _hn.copy(hit.face.normal); if (_hn.dot(dir) > 0) _hn.negate();
    const hp = hit.point, a = hp.y < terrainHeight(hp.x, hp.z) + 0.35 ? albG : ALB_DEFAULT;
    let e = 0; if (sun) { const cs = _hn.dot(L); if (cs > 0 && sunVis(Q.copy(hp).addScaledVector(_hn, 0.05))) e = cs; }
    const sky = 0.5 + 0.5 * _hn.y;
    for (let c = 0; c < 3; c++) { out[o6 + c] += a[c] * e * w; out[o6 + 3 + c] += a[c] * sky * w; }
  };
  // trace one vertex/probe: openness + env split (up misses = sky, down misses = lit far ground) + hit records
  const trace = (P, N, pat, maxD, hv, hw, h0, kOut, gOut, o3, xOut, o6, rot = 0) => {
    const up = Math.abs(N.y) < 0.95 ? _t2.set(0, 1, 0) : _t2.set(1, 0, 0);
    _bx.crossVectors(up, N).normalize(); _by.crossVectors(N, _bx);
    if (rot) { const cr = Math.cos(rot), sr = Math.sin(rot); _t1.copy(_bx).multiplyScalar(cr).addScaledVector(_by, sr); _by.multiplyScalar(cr).addScaledVector(_bx, -sr); _bx.copy(_t1); }
    let nUp = 0, nDn = 0; const w = 1 / pat.length;
    for (let k = 0; k < pat.length; k++) {
      const [a, b, c] = pat[k];
      D.set(0, 0, 0).addScaledVector(_bx, a).addScaledVector(N, b).addScaledVector(_by, c).normalize();
      _ray.origin.copy(P).addScaledVector(N, 0.06); _ray.direction.copy(D);
      const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, maxD);
      if (!hit) { if (D.y >= 0) nUp++; else nDn++; continue; }
      const ra = c2r[hit.face.a], rb = c2r[hit.face.b], rc = c2r[hit.face.c];
      if (ra >= 0 && rb >= 0 && rc >= 0) { const j = h0 + k; hv[j * 3] = ra; hv[j * 3 + 1] = rb; hv[j * 3 + 2] = rc; hw[j * 2] = hit.barycoord.y; hw[j * 2 + 1] = hit.barycoord.z; }
      else estimate(hit, D, xOut, o6, w);
    }
    for (let c = 0; c < 3; c++) { kOut[o3 + c] = (nUp + nDn * albG[c]) * w; gOut[o3 + c] = sun ? nDn * albG[c] * sinE * w : 0; }
    return (nUp + nDn) * w;
  };
  const Y = fastYield(); let tY = performance.now(), done = 0;
  for (let gi = 0; gi < list.length; gi++) {
    const [key, g] = list[gi], p = g.attributes.position.array, nr = g.attributes.normal.array, cnt = g.attributes.position.count, isT = key === 'terr';
    const pat = isT ? PATT : PAT, maxD = isT ? 24 : 40, fine = isT ? null : fineVerts(g, 2.2);
    for (let li = 0; li < cnt; li++) {
      const v = base[gi] + li;
      _P.set(p[li * 3], p[li * 3 + 1], p[li * 3 + 2]); _N.set(nr[li * 3], nr[li * 3 + 1], nr[li * 3 + 2]).normalize();
      if (sun) {
        const nl = _N.dot(L);
        if (nl > 0 && sunVis(Q.copy(_P).addScaledVector(_N, 0.05))) S[v] = nl;
        if (fine && fine[li] && !(S[v] > 0)) {
          // dilated mask: lit if the sun reaches any of 5 points within ~1.2 m on this surface (back faces: dark)
          let m = 0;
          if (nl > -0.25) {
            const up = Math.abs(_N.y) < 0.95 ? _t2.set(0, 1, 0) : _t2.set(1, 0, 0);
            _bx.crossVectors(up, _N).normalize(); _by.crossVectors(_N, _bx);
            for (const [u, w] of [[0, 0], [1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) { if (sunVis(Q.copy(_P).addScaledVector(_N, 0.08).addScaledVector(_bx, u).addScaledVector(_by, w))) { m = 1; break; } }
          }
          occ[v] = 1 - m;
        }
      }
      open[v] = trace(_P, _N, pat, maxD, hV, hW, v * R, K, G, v * 3, X, v * 6, ((v * 0.618034) % 1) * 2 * Math.PI);   // decorrelated per vertex
      if ((++done & 255) === 0 && performance.now() - tY > 24) { onTick?.(done / NV); await Y.y(); tY = performance.now(); }
    }
  }
  Y.close();
  const t1 = performance.now();
  const WG = weldGraph(list, base, NV);
  WG.smooth(open, 1); WG.smooth(K, 3); WG.smooth(G, 3); WG.smooth(X, 6);
  // gather: B(v) = mean over v's ray hits of albedo x interp(direct sun + env + B) at the hit; 3 bounces
  let Bs = new Float32Array(NV * 3), Bk = new Float32Array(NV * 3);
  const Es = new Float32Array(NV * 3), Ek = new Float32Array(NV * 3);
  const evalE = () => { for (let v = 0; v < NV; v++) for (let c = 0; c < 3; c++) { const i = v * 3 + c; Es[i] = S[v] + G[i] + Bs[i]; Ek[i] = K[i] + Bk[i]; } };
  const gatherInto = (hv, hw, h0, n, inv, out, o3, x, o6) => {
    let s0 = 0, s1 = 0, s2 = 0, k0 = 0, k1 = 0, k2 = 0;
    for (let k = 0; k < n; k++) {
      const j = h0 + k, a = hv[j * 3]; if (a < 0) continue;
      const b = hv[j * 3 + 1], c = hv[j * 3 + 2], wb = hw[j * 2], wc = hw[j * 2 + 1], wa = 1 - wb - wc, al = albTab[aOf[a]];
      s0 += al[0] * (Es[a * 3] * wa + Es[b * 3] * wb + Es[c * 3] * wc); s1 += al[1] * (Es[a * 3 + 1] * wa + Es[b * 3 + 1] * wb + Es[c * 3 + 1] * wc); s2 += al[2] * (Es[a * 3 + 2] * wa + Es[b * 3 + 2] * wb + Es[c * 3 + 2] * wc);
      k0 += al[0] * (Ek[a * 3] * wa + Ek[b * 3] * wb + Ek[c * 3] * wc); k1 += al[1] * (Ek[a * 3 + 1] * wa + Ek[b * 3 + 1] * wb + Ek[c * 3 + 1] * wc); k2 += al[2] * (Ek[a * 3 + 2] * wa + Ek[b * 3 + 2] * wb + Ek[c * 3 + 2] * wc);
    }
    out[0][o3] = s0 * inv + x[o6]; out[0][o3 + 1] = s1 * inv + x[o6 + 1]; out[0][o3 + 2] = s2 * inv + x[o6 + 2];
    out[1][o3] = k0 * inv + x[o6 + 3]; out[1][o3 + 1] = k1 * inv + x[o6 + 4]; out[1][o3 + 2] = k2 * inv + x[o6 + 5];
  };
  for (let it = 0; it < 3; it++) {
    evalE();
    const nS = new Float32Array(NV * 3), nK = new Float32Array(NV * 3), out = [nS, nK];
    for (let v = 0; v < NV; v++) gatherInto(hV, hW, v * R, R, invR[gOf[v]], out, v * 3, X, v * 6);
    WG.smooth(nS, 3, SMOOTH_RINGS); WG.smooth(nK, 3, SMOOTH_RINGS);
    Bs = nS; Bk = nK;
  }
  evalE();   // final radiosity source for probes
  // write the attributes
  for (let gi = 0; gi < list.length; gi++) {
    const g = list[gi][1], n = g.attributes.position.count, o = base[gi];
    const ao = new Float32Array(n); for (let i = 0; i < n; i++) ao[i] = aoCurve(open[o + i]);
    g.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
    g.setAttribute('aBSun', new THREE.BufferAttribute(Bs.slice(o * 3, (o + n) * 3), 3));
    g.setAttribute('aBSky', new THREE.BufferAttribute(Bk.slice(o * 3, (o + n) * 3), 3));
    g.setAttribute('aSunOcc', new THREE.BufferAttribute(occ.slice(o, o + n), 1));
  }
  const t2 = performance.now();
  // probe anywhere (paths, decals): trace fresh rays, gather from the converged solution
  const pK = new Float32Array(3), pG = new Float32Array(3), pX = new Float32Array(6), pV = new Int32Array(64 * 3), pW = new Float32Array(64 * 2), pO = [new Float32Array(3), new Float32Array(3)];
  const pats = {};
  const probe = (P, N, n = rays, maxD = 26) => {
    n = Math.min(64, n); const pat = (pats[n] ||= cosPattern(n));
    pV.fill(-1); pX.fill(0);
    const op = trace(P, N, pat, maxD, pV, pW, 0, pK, pG, 0, pX, 0);
    gatherInto(pV, pW, 0, n, 1 / n, pO, 0, pX, 0);
    let sv = 0; if (sun) { const nl = N.dot(L); if (nl > 0 && sunVis(Q.copy(P).addScaledVector(N, 0.05))) sv = 1; }
    return { open: op, bs: [pO[0][0], pO[0][1], pO[0][2]], bk: [pO[1][0], pO[1][1], pO[1][2]], sun: sv };
  };
  // apply to any extra ground-hugging geometry (path ribbons...)
  const applyTo = (g, n = 4, maxD = 18) => {
    const p = g.attributes.position.array, nr = g.attributes.normal?.array, cnt = g.attributes.position.count;
    const ao = new Float32Array(cnt), bs = new Float32Array(cnt * 3), bk = new Float32Array(cnt * 3), P = new THREE.Vector3(), N = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < cnt; i++) { P.fromArray(p, i * 3); if (nr) N.fromArray(nr, i * 3).normalize(); const r = probe(P, N, n, maxD); ao[i] = aoCurve(r.open); bs.set(r.bs, i * 3); bk.set(r.bk, i * 3); }
    g.setAttribute('ao', new THREE.BufferAttribute(ao, 1)); g.setAttribute('aBSun', new THREE.BufferAttribute(bs, 3)); g.setAttribute('aBSky', new THREE.BufferAttribute(bk, 3));
  };
  const stats = { verts: NV, nodes: WG.nodes, rays, raysT, traceMs: Math.round(t1 - t0), gatherMs: Math.round(t2 - t1) };
  BAKE = { probe, applyTo, stats, sunDir: L, c2r, albedoAtCollider: (c) => (c2r[c] >= 0 ? albTab[aOf[c2r[c]]] : null) };
  return BAKE;
}

// ---------------------------------------------------------------- [A] shader patch (one hook inside weatherPatch)
// uniforms.aLight: uSunB/uSkyB scale the baked bounce once the HDR is measured; uFar* = static far shadow map that takes
// over where the live (camera-following) map ends; uSunW/uHaze = forward-scatter haze in the fog.
function lightUniforms() {
  return { uSunB: { value: new THREE.Vector3() }, uSkyB: { value: new THREE.Vector3() }, uFarSM: { value: null }, uFarMat: { value: new THREE.Matrix4() },
    uFarOn: { value: 0 }, uFarTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) }, uSunW: { value: new THREE.Vector3(0, 1, 0) }, uHaze: { value: 1.2 } };
}
const A_DIR_LINE = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
const A_LIGHTS_BEGIN = THREE.ShaderChunk.lights_fragment_begin.includes(A_DIR_LINE)
  ? THREE.ShaderChunk.lights_fragment_begin.replace(A_DIR_LINE, A_DIR_LINE.replace('? getShadow(', '? aDirShadow( getShadow(').replace(' ) : 1.0;', ' ), vDirectionalShadowCoord[ i ] ) : 1.0;'))
  : null;
if (!A_LIGHTS_BEGIN) console.warn('[A-lighting] three lights_fragment_begin changed: far shadows + sun mask disabled');
function aLightingPatch(sh, uniforms) {
  const U = uniforms?.aLight; if (!U) return;
  Object.assign(sh.uniforms, U);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>
attribute vec3 aBSun;
attribute vec3 aBSky;
attribute float aSunOcc;
uniform vec3 uSunB;
uniform vec3 uSkyB;
uniform mat4 uFarMat;
varying vec3 vBounceA;
varying vec4 vFarC;`)
    .replace('#include <fog_vertex>', `#include <fog_vertex>
  vBounceA = aBSun * uSunB + aBSky * uSkyB;
  {
    vec4 aW = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      aW = instanceMatrix * aW;
    #endif
    aW = modelMatrix * aW;
    vec3 aN = inverseTransformDirection( transformedNormal, viewMatrix );
    vFarC = vec4( ( uFarMat * vec4( aW.xyz + aN * 0.15, 1.0 ) ).xyz, 1.0 - aSunOcc );
  }`);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
uniform sampler2DShadow uFarSM;
uniform float uFarOn;
uniform vec2 uFarTexel;
uniform vec3 uSunW;
uniform float uHaze;
varying vec3 vBounceA;
varying vec4 vFarC;
float aFarShadow() {
  vec3 c = vFarC.xyz;
  if ( uFarOn < 0.5 || c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;
  vec2 t = uFarTexel * 0.5;
  return 0.25 * ( texture( uFarSM, vec3( c.xy - t, c.z ) ) + texture( uFarSM, vec3( c.xy + vec2( t.x, - t.y ), c.z ) )
    + texture( uFarSM, vec3( c.xy + vec2( - t.x, t.y ), c.z ) ) + texture( uFarSM, vec3( c.xy + t, c.z ) ) );
}
float aDirShadow( float live, vec4 sc ) {
  vec3 c = sc.xyz / sc.w;
  vec2 e = min( c.xy, 1.0 - c.xy );
  float wL = smoothstep( 0.0, 0.05, min( e.x, e.y ) ) * step( c.z, 1.0 );
  float s = wL > 0.999 ? live : mix( aFarShadow(), live, wL );
  return s * smoothstep( 0.05, 0.4, vFarC.w );
}`)
    .replace('#include <aomap_fragment>', `reflectedLight.indirectDiffuse += vBounceA * BRDF_Lambert( material.diffuseColor );
#include <aomap_fragment>`)
    .replace('#include <fog_fragment>', `#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  vec3 aVd = inverseTransformDirection( normalize( - vViewPosition ), viewMatrix );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * ( 1.0 + uHaze * pow( max( dot( aVd, uSunW ), 0.0 ), 6.0 ) ), fogFactor );
#endif`);
  if (A_LIGHTS_BEGIN) sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', A_LIGHTS_BEGIN);
}

// ---------------------------------------------------------------- [A] static far shadow map (rendered once at load)
// Covers every caster in light space at ~13 cm texels; the live map (+-48 m around the camera) fades into it, so the
// hall and silos cast shadows from the spawn and from altitude. Cost: one depth pass at load, 0 per frame, 16 MB.
function renderFarShadow(renderer, scene, merged, L, size, U) {
  const box = new THREE.Box3(); for (const g of Object.values(merged)) { if (!g.boundingBox) g.computeBoundingBox(); box.union(g.boundingBox); }
  box.expandByScalar(8);
  const lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), L).normalize(), ly = new THREE.Vector3().crossVectors(L, lx);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], c = new THREE.Vector3();
  for (let k = 0; k < 8; k++) {
    c.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z);
    [c.dot(lx), c.dot(ly), c.dot(L)].forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); });
  }
  const hx = Math.min(170, (hi[0] - lo[0]) / 2), hy = Math.min(170, (hi[1] - lo[1]) / 2), back = (hi[2] - lo[2]) / 2 + 60;
  const ctr = new THREE.Vector3().addScaledVector(lx, (lo[0] + hi[0]) / 2).addScaledVector(ly, (lo[1] + hi[1]) / 2).addScaledVector(L, (lo[2] + hi[2]) / 2);
  const cam = new THREE.OrthographicCamera(-hx, hx, hy, -hy, 1, 2 * back);
  cam.position.copy(ctr).addScaledVector(L, back); cam.up.set(0, 1, 0); cam.lookAt(ctr); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
  const dt = new THREE.DepthTexture(size, size); dt.type = THREE.UnsignedIntType; dt.compareFunction = THREE.LessEqualCompare; dt.minFilter = dt.magFilter = THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(size, size, { depthTexture: dt, depthBuffer: true, format: THREE.RedFormat, type: THREE.UnsignedByteType, generateMipmaps: false });
  // proxies of every shadow caster with a depth-only material (alpha-tested where the original is)
  const proxy = new THREE.Scene(), plain = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }), extra = [];
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh || !o.castShadow || !o.visible) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    let mat = plain;
    if (m && m.alphaTest > 0 && m.map) { mat = new THREE.MeshBasicMaterial({ map: m.map, alphaTest: m.alphaTest, side: THREE.DoubleSide, colorWrite: false }); extra.push(mat); }
    const p = o.isInstancedMesh ? new THREE.InstancedMesh(o.geometry, mat, o.count) : new THREE.Mesh(o.geometry, mat);
    if (o.isInstancedMesh) p.instanceMatrix = o.instanceMatrix;
    p.matrixAutoUpdate = false; p.matrix.copy(o.matrixWorld); p.matrixWorld.copy(o.matrixWorld); p.frustumCulled = false; proxy.add(p);
  });
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); renderer.clear(true, true, true); renderer.render(proxy, cam); renderer.setRenderTarget(prev);
  extra.forEach((m) => m.dispose()); plain.dispose();
  rt.depthTexture = null; rt.dispose();   // keep only the depth texture (frees the FBO and the colour plane)
  const M = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  M.elements[14] -= 0.08 / (2 * back - 1);   // 8 cm depth bias (plus the 15 cm normal offset in the shader)
  U.uFarMat.value.copy(M); U.uFarSM.value = dt; U.uFarOn.value = 1; U.uFarTexel.value.set(1 / size, 1 / size);
  return { tex: dt, texel: (2 * Math.max(hx, hy)) / size };
}

// ---------------------------------------------------------------- [A] sky: real HDR photo, sun split out for shadows
// Returns: background (its lower hemisphere = fog x haze, so a puresky's mirrored "ground" never shows), a PMREM env
// from a 1024x512 copy whose lower hemisphere is the lit ground (albedo x (sun + sky) / pi), and the measured sun
// colour / intensity, sky irradiance and fog colour (mean of the sky 0.5-5 deg above the horizon).
async function loadSky(def, renderer, { envI = 0.85, groundAlb = ALB_FALLBACK.ground, haze = 1.2, onProgress } = {}) {
  const id = def.id, url = `${PH}/HDRIs/hdr/2k/${id}_2k.hdr`;
  const tex = await new HDRLoader().setDataType(THREE.FloatType).loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
  const { width: W, height: H, data } = tex.image; const ch = data.length / (W * H);
  const L = new THREE.Vector3(...def.sunDir).normalize();
  let maxL = 0, mi = 0;
  for (let i = 0; i < W * H; i++) { const l = 0.2126 * data[i * ch] + 0.7152 * data[i * ch + 1] + 0.0722 * data[i * ch + 2]; if (l > maxL) { maxL = l; mi = i; } }
  const cosP = new Float32Array(W), sinP = new Float32Array(W); for (let px = 0; px < W; px++) { const ph = ((px + 0.5) / W - 0.5) * 2 * Math.PI; cosP[px] = Math.cos(ph); sinP[px] = Math.sin(ph); }
  const latOf = (py) => (0.5 - (py + 0.5) / H) * Math.PI;
  { const px = mi % W, la = latOf(Math.floor(mi / W)), m = new THREE.Vector3(cosP[px] * Math.cos(la), Math.sin(la), sinP[px] * Math.cos(la));
    if (def.sunRatio > 0 && m.angleTo(L) > 0.05) console.warn('[A-lighting] SKIES.sunDir', def.sunDir, 'but the HDR sun is at', m.toArray().map((v) => +v.toFixed(4))); }
  const T = Math.max(8, Math.min(40, maxL * 0.05));
  const E = [0, 0, 0], skyE = new THREE.Vector3(), fog = [0, 0, 0]; let fogN = 0;
  for (let py = 0; py < H; py++) {
    const lat = latOf(py), cl = Math.cos(lat), sl = Math.sin(lat), dO = (2 * Math.PI / W) * (Math.PI / H) * cl, latD = lat * 180 / Math.PI;
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * ch, l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (l > T) {
        const k = (l - T) / l, cosT = Math.max(0, cosP[px] * cl * L.x + sl * L.y + sinP[px] * cl * L.z);
        for (let c = 0; c < 3; c++) { E[c] += data[i + c] * k * dO * cosT; data[i + c] *= 1 - k; }
      }
      if (lat > 0) { const w = dO * sl; skyE.x += data[i] * w; skyE.y += data[i + 1] * w; skyE.z += data[i + 2] * w; }
      if (latD >= 0.5 && latD <= 5) { fog[0] += data[i]; fog[1] += data[i + 1]; fog[2] += data[i + 2]; fogN++; }
    }
  }
  const Ei = Math.max(...E), skyLum = 0.2126 * skyE.x + 0.7152 * skyE.y + 0.0722 * skyE.z;
  const sunColor = Ei > 1e-2 ? new THREE.Color(E[0] / Ei, E[1] / Ei, E[2] / Ei) : new THREE.Color(1, 1, 1);
  const sunI = Math.min(16, Math.max(Ei > 1e-2 ? Ei : 0, (def.sunRatio || 0) * skyLum * envI));
  const fogC = new THREE.Color(fog[0] / fogN, fog[1] / fogN, fog[2] / fogN);
  const sst = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const H1 = THREE.DataUtils.toHalfFloat(1);
  // background: below the horizon = what the fog converges to (fog colour x forward-scatter haze)
  const half = new Uint16Array(W * H * 4);
  for (let py = 0; py < H; py++) {
    const lat = latOf(py), t = sst(0.5, -1.0, lat * 180 / Math.PI), cl = Math.cos(lat), sl = Math.sin(lat);
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * ch, o = (py * W + px) * 4;
      let r = data[i], g = data[i + 1], b = data[i + 2];
      if (t > 0) { const hz = 1 + haze * Math.pow(Math.max(0, cosP[px] * cl * L.x + sl * L.y + sinP[px] * cl * L.z), 6); r += (fogC.r * hz - r) * t; g += (fogC.g * hz - g) * t; b += (fogC.b * hz - b) * t; }
      half[o] = THREE.DataUtils.toHalfFloat(r); half[o + 1] = THREE.DataUtils.toHalfFloat(g); half[o + 2] = THREE.DataUtils.toHalfFloat(b); half[o + 3] = H1;
    }
  }
  // env source at 1024x512: lower hemisphere = the lit ground (radiance / envI, since the env is scaled by envI)
  const w2 = W >> 1, h2 = H >> 1, src = new Uint16Array(w2 * h2 * 4);
  const gR = [0, 1, 2].map((c) => (groundAlb[c] * (sunI * Math.max(0, L.y) * [sunColor.r, sunColor.g, sunColor.b][c] + [skyE.x, skyE.y, skyE.z][c] * envI)) / Math.PI / envI);
  for (let py = 0; py < h2; py++) {
    const latD = (0.5 - (py + 0.5) / h2) * 180, t = sst(0, -2, latD);
    for (let px = 0; px < w2; px++) {
      const o = (py * w2 + px) * 4;
      for (let c = 0; c < 3; c++) {
        const a = ((2 * py) * W + 2 * px) * ch + c, b = ((2 * py + 1) * W + 2 * px) * ch + c;
        const v = 0.25 * (data[a] + data[a + ch] + data[b] + data[b + ch]);
        src[o + c] = THREE.DataUtils.toHalfFloat(v + (gR[c] - v) * t);
      }
      src[o + 3] = H1;
    }
  }
  tex.dispose();
  const mk = (arr, w, h) => { const t = new THREE.DataTexture(arr, w, h, THREE.RGBAFormat, THREE.HalfFloatType); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.LinearSRGBColorSpace;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.flipY = true; t.needsUpdate = true; return t; };
  const sky = mk(half, W, H), envSrc = mk(src, w2, h2);
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromEquirectangular(envSrc).texture; pm.dispose(); envSrc.dispose();
  console.info('sky', id, 'sunI', +sunI.toFixed(2), 'sunE', +Ei.toFixed(2), 'sunColor', [sunColor.r, sunColor.g, sunColor.b].map((v) => +v.toFixed(3)), 'skyE', skyE.toArray().map((v) => +v.toFixed(3)),
    'fog', [fogC.r, fogC.g, fogC.b].map((v) => +v.toFixed(3)), 'ground', gR.map((v) => +v.toFixed(3)), 'maxL', +maxL.toFixed(0));
  return { sky, env, sunDir: L, sunColor, sunI, sunE: Ei, skyE, fogColor: fogC };
}


// pure geometry + collision (no DOM): shared by the game and the headless physics tests
export function buildGeometry(R = rng(7)) {
  const site = buildSite(R);

  // terrain: detailed yard + coarse far field
  const tSize = 320, tSeg = 128;
  const terr = new THREE.PlaneGeometry(tSize, tSize, tSeg, tSeg); terr.rotateX(-Math.PI / 2); terr.translate(-5, 0, 10);
  { const p = terr.attributes.position, uv = terr.attributes.uv; for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); p.setY(i, terrainHeight(x, z)); uv.setXY(i, x, z); } terr.computeVertexNormals(); }
  const far = new THREE.PlaneGeometry(6000, 6000, 60, 60); far.rotateX(-Math.PI / 2);
  { const p = far.attributes.position, uv = far.attributes.uv; for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); const d = Math.hypot(x + 5, z - 10); p.setY(i, d < 150 ? -0.6 : terrainHeight(x, z) - 0.4 + Math.min(1, (d - 150) / 400) * (Math.sin(x * 0.004) * Math.cos(z * 0.005) * 9 + Math.sin(x * 0.011 + z * 0.007) * 3)); uv.setXY(i, x, z); } far.computeVertexNormals(); }
  // dirt tracks as soft-edged ribbons on the ground
  const pathPos = [], pathUV = [], pathCol = [], pathIdx = [];
  for (const pl of PATHS) {
    const pts = []; for (let i = 0; i < pl.length - 1; i++) { const [ax, az] = pl[i], [bx, bz] = pl[i + 1]; const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 2); for (let k = 0; k < n; k++) pts.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]); }
    pts.push(pl[pl.length - 1]);
    const base = pathPos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i], [x2, z2] = pts[Math.min(i + 1, pts.length - 1)], [x1, z1] = pts[Math.max(i - 1, 0)];
      let tx = x2 - x1, tz = z2 - z1; const tl2 = Math.hypot(tx, tz) || 1; tx /= tl2; tz /= tl2;
      const w = 2.2 + Math.sin(i * 0.7) * 0.4;
      for (const [s, a] of [[-w - 1.4, 0], [-w, 1], [w, 1], [w + 1.4, 0]]) { const px = x - tz * s, pz = z + tx * s; pathPos.push(px, terrainHeight(px, pz) + 0.03, pz); pathUV.push(px, pz); pathCol.push(1, 1, 1, a); }
      if (i < pts.length - 1) for (let c = 0; c < 3; c++) { const a = base + i * 4 + c, b = a + 4; pathIdx.push(a, b, a + 1, a + 1, b, b + 1); }
    }
  }
  const pathG = new THREE.BufferGeometry();
  pathG.setAttribute('position', new THREE.Float32BufferAttribute(pathPos, 3)); pathG.setAttribute('uv', new THREE.Float32BufferAttribute(pathUV, 2));
  pathG.setAttribute('color', new THREE.Float32BufferAttribute(pathCol, 4)); pathG.setIndex(pathIdx); pathG.computeVertexNormals();

  // trees: trunks collide, canopies don't
  const treeSpots = [];
  for (let k = 0; k < 70; k++) {
    let x, z, ok = false;
    for (let t = 0; t < 20 && !ok; t++) {
      x = -110 + R() * 230; z = -80 + R() * 200;
      ok = !site.footprints.some((f) => x > f.x0 - 4 && x < f.x1 + 4 && z > f.z0 - 4 && z < f.z1 + 4) && distToPaths(x, z) > 5 && Math.hypot(x, z - 120) > 12;
    }
    if (!ok) continue;
    const h = 4 + R() * 7; treeSpots.push({ x, z, h, r: 0.15 + h * 0.025 });
    const g = cylGeo(0.12 + h * 0.02, 0.18 + h * 0.03, h * 0.75, 7, false); g.translate(x, terrainHeight(x, z) + h * 0.375, z); site.add('bark', g);
  }

  // merge structures per material + one collision geometry
  const solids = [];
  const merged = {};
  for (const [mat, list] of Object.entries(site.parts)) {
    merged[mat] = mergeGeometries(list.map((e) => { const g = e.g; for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k); return g; }), false);
    list.forEach((e) => e.collide && solids.push(e.g));
  }
  const colGeo = mergeGeometries([...solids.map((g) => { const c = new THREE.BufferGeometry(); c.setAttribute('position', g.attributes.position); c.setIndex(g.index); return c; }),
    (() => { const c = new THREE.BufferGeometry(); c.setAttribute('position', terr.attributes.position); c.setIndex(terr.index); return c; })()], false);
  colGeo.computeBoundingBox();
  const bvh = new MeshBVH(colGeo);

  return { site, terr, far, pathG, treeSpots, merged, colGeo, bvh };
}

// ---------------------------------------------------------------- build everything
export async function buildBando(renderer, { sky = 'sunny', quality = 'auto', seed = 7, onProgress } = {}) {
  const R = rng(seed);
  const prog = (f, t) => onProgress?.(f, t);
  const scene = new THREE.Scene();
  const uniforms = { uTime: { value: 0 } };

  // textures (stream in parallel with the sky)
  const tl = new THREE.TextureLoader(); tl.setCrossOrigin('anonymous');
  let texDone = 0; const texTotal = Object.keys(MATS).length * 3;
  const loadTex = (url, srgb) => new Promise((res) => tl.load(url, (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; texDone++; res(t); }, undefined, () => { texDone++; res(null); }));
  const texJobs = {};
  for (const [k, m] of Object.entries(MATS)) {
    const b = `${PH}/Textures/jpg/1k/${m.id}/${m.id}_`;
    texJobs[k] = Promise.all([loadTex(b + 'diff_1k.jpg', true), loadTex(b + 'nor_gl_1k.jpg', false), loadTex(b + 'arm_1k.jpg', false)]);
  }
  // [A] sky + light. The bake needs only the per-sky sun direction, so it runs right after the geometry while the HDR
  // and textures stream; the HDR's measured sun/sky intensities then scale it through uniforms (uniforms.aLight).
  const skyDef = SKIES[sky] || SKIES.sunny, hasSun = skyDef.sunRatio > 0, envI = 0.85, sunDir = new THREE.Vector3(...skyDef.sunDir).normalize();
  const aLight = (uniforms.aLight = lightUniforms());
  aLight.uSunW.value.copy(sunDir); aLight.uHaze.value = hasSun ? 1.2 : 0;
  let skyFrac = 0, bakeFrac = 0;
  const ticker = setInterval(() => prog(0.05 + 0.85 * (skyFrac * 0.3 + (texDone / texTotal) * 0.3 + bakeFrac * 0.4), bakeFrac < 1 ? 'Baking light' : 'Streaming sky and materials'), 200);
  const skyP = loadSky(skyDef, renderer, { envI, groundAlb: groundAlbedo(), haze: aLight.uHaze.value, onProgress: (f) => (skyFrac = f) });

  // geometry (CPU) while downloads run
  const geo = buildGeometry(R);
  const { site, terr, far, pathG, treeSpots, merged, colGeo, bvh } = geo;
  prog(0.1, 'Baking light');
  await yieldUI();
  const bake = await bakeLight(geo, { sunDir, sun: hasSun, quality, onTick: (f) => (bakeFrac = f) });
  bake.applyTo(pathG, 4, 18);
  far.setAttribute('ao', new THREE.BufferAttribute(new Float32Array(far.attributes.position.count).fill(1), 1));
  bakeFrac = 1;
  console.info('light bake', bake.stats);

  const sk = await skyP;
  const sunI = sk.sunI;
  aLight.uSunB.value.set(sk.sunColor.r, sk.sunColor.g, sk.sunColor.b).multiplyScalar(sunI);
  aLight.uSkyB.value.copy(sk.skyE).multiplyScalar(envI);
  LP.sun.copy(sunDir); LP.sunRGB.copy(aLight.uSunB.value); LP.skyRGB.copy(aLight.uSkyB.value);   // legacy lightProbe() callers

  const texSets = await Promise.all(Object.values(texJobs));
  clearInterval(ticker);
  const texOf = {}; Object.keys(MATS).forEach((k, i) => (texOf[k] = texSets[i]));
  prog(0.9, 'Lighting');

  scene.background = sk.sky; scene.environment = sk.env;
  scene.fog = new THREE.Fog(sk.fogColor, 40, 2600);

  const mkMat = (key, extra = {}) => {
    const m = MATS[key], [d, n, arm] = texOf[key] || [];
    const rep = 1 / m.tile;
    [d, n, arm].forEach((t) => t && t.repeat.set(rep, rep));
    const mat = new THREE.MeshStandardMaterial({ map: d || null, normalMap: n || null, roughnessMap: arm || null, metalnessMap: m.metal ? arm : null, aoMap: arm || null, aoMapIntensity: 0.8,
      roughness: 1, metalness: m.metal ? 1 : 0, color: d ? 0xffffff : 0x9a9690, normalScale: new THREE.Vector2(1, 1), ...extra });
    return weatherPatch(mat, { ground: !!m.ground, foliage: !!m.foliage }, uniforms);
  };
  const mats = {}; for (const k of Object.keys(MATS)) mats[k] = mkMat(k);
  mats.path.transparent = true; mats.path.vertexColors = true; mats.path.depthWrite = false; mats.path.polygonOffset = true; mats.path.polygonOffsetFactor = -2;

  for (const [mat, g] of Object.entries(merged)) {
    const mesh = new THREE.Mesh(g, mats[mat]); mesh.castShadow = true; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false; scene.add(mesh);
  }
  const terrMesh = new THREE.Mesh(terr, mats.ground); terrMesh.receiveShadow = true; scene.add(terrMesh);
  const farMat = mkMat('ground'); const farMesh = new THREE.Mesh(far, farMat); farMesh.receiveShadow = false; scene.add(farMesh);
  const pathMesh = new THREE.Mesh(pathG, mats.path); pathMesh.receiveShadow = true; pathMesh.renderOrder = 1; scene.add(pathMesh);

  // graffiti decals
  {
    const atlas = graffitiAtlas(R);
    const pos = [], uv = [], nor = [], aoA = [], boA = [], idx = [];
    const Q = new THREE.Vector3(), U = new THREE.Vector3(), V = new THREE.Vector3(0, 1, 0);
    site.decalSpots.forEach((s, k) => {
      const cell = Math.floor(R() * 16), cu = (cell % 4) / 4, cv = 1 - (Math.floor(cell / 4) + 1) / 4;
      U.crossVectors(V, s.n).normalize();
      const w = s.w, h = Math.min(s.h, w * 0.5), c = s.c.clone().addScaledVector(s.n, 0.035);
      const b = pos.length / 3;
      for (const [a, bb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        Q.copy(c).addScaledVector(U, a * w / 2).addScaledVector(V, bb * h / 2);
        pos.push(Q.x, Q.y, Q.z); nor.push(s.n.x, s.n.y, s.n.z); uv.push(cu + (a + 1) / 2 / 4, cv + (bb + 1) / 2 / 4);
        aoA.push(aoCurve(lightProbe(bvh, Q, s.n, 26, 6))); boA.push(LP.out.x, LP.out.y, LP.out.z);
      }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('ao', new THREE.Float32BufferAttribute(aoA, 1)); g.setAttribute('bounce', new THREE.Float32BufferAttribute(boA, 3)); g.setIndex(idx);
    const m = weatherPatch(new THREE.MeshStandardMaterial({ map: atlas, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.85, metalness: 0 }), { foliage: true }, uniforms);
    const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; mesh.renderOrder = 2; scene.add(mesh);
  }

  // grass: a dense field of tufts that travels with the drone. Each tuft is anchored to a world grid cell
  // (snapped origin + per-cell hash), so nothing swims; tufts fade out at the edge of the patch.
  const gN = { low: 120, auto: 170, high: 220 }[quality] || 170, gCell = 0.45;
  const grassU = { uOrigin: { value: new THREE.Vector2() }, uCam: { value: new THREE.Vector3() }, uCell: { value: gCell }, uR: { value: gN * gCell * 0.5 }, uScale: { value: 1 },
    uFoot: { value: site.footprints.slice(0, 24).map((f) => new THREE.Vector4(f.x0, f.z0, f.x1, f.z1)) }, uSeg: { value: [] } };
  for (const pl of PATHS) for (let i = 0; i < pl.length - 1; i++) grassU.uSeg.value.push(new THREE.Vector4(pl[i][0], pl[i][1], pl[i + 1][0], pl[i + 1][1]));
  while (grassU.uFoot.value.length < 24) grassU.uFoot.value.push(new THREE.Vector4(1e5, 1e5, 1e5, 1e5));
  const nSeg = grassU.uSeg.value.length;
  {
    const card = new THREE.InstancedBufferGeometry();
    const P = [], UV = [], N = [], I = [];
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI / 3, cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5, b = P.length / 3;
      P.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz); UV.push(0, 0, 1, 0, 1, 1, 0, 1); N.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      I.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    card.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); card.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    card.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); card.setIndex(I);
    card.setAttribute('ao', new THREE.Float32BufferAttribute(new Array(12).fill(1), 1));
    const cells = new Float32Array(gN * gN * 2); for (let i = 0; i < gN; i++) for (let j = 0; j < gN; j++) { cells[(i * gN + j) * 2] = i; cells[(i * gN + j) * 2 + 1] = j; }
    card.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    card.instanceCount = gN * gN;
    const gm = new THREE.MeshStandardMaterial({ map: grassTexture(R), alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
    weatherPatch(gm, { foliage: true }, uniforms);
    const base = gm.onBeforeCompile;
    gm.onBeforeCompile = (sh) => {
      base(sh);
      Object.assign(sh.uniforms, grassU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
attribute vec2 aCell;
uniform vec2 uOrigin; uniform vec3 uCam; uniform float uCell; uniform float uR; uniform float uScale;
uniform vec4 uFoot[24]; uniform vec4 uSeg[${nSeg}];
varying vec3 vTint;
float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float terrH(vec2 p){ float x = p.x, z = p.y; float d = max(max(abs(x + 5.0) - 95.0, abs(z - 10.0) - 85.0), 0.0);
  float n = sin(x * 0.021) * cos(z * 0.017) * 1.2 + sin(x * 0.053 + z * 0.041) * 0.45 + sin(z * 0.11 - x * 0.07) * 0.15;
  float ramp = min(1.0, d / 40.0); return n * ramp + min(d, 180.0) * 0.012 * ramp - 0.05 * (1.0 - ramp); }`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  vec2 cw = uOrigin + aCell * uCell;
  vec2 bp = cw + (vec2(gh(cw), gh(cw + 17.3)) - 0.5) * uCell * 0.95;
  float keep = 1.0 - smoothstep(uR * 0.7, uR, distance(bp, uCam.xz));
  for (int i = 0; i < 24; i++) { vec4 f = uFoot[i]; if (bp.x > f.x && bp.x < f.z && bp.y > f.y && bp.y < f.w) keep *= 0.0; }
  for (int i = 0; i < ${nSeg}; i++) { vec4 sg = uSeg[i]; vec2 a = sg.xy, b = sg.zw, ab = b - a; float t = clamp(dot(bp - a, ab) / dot(ab, ab), 0.0, 1.0);
    if (distance(bp, a + ab * t) < 2.3 + gh(bp + 3.1) * 0.8) keep = 0.0; }
  float r1 = gh(bp + 7.7), r2 = gh(bp + 3.3), r3 = gh(bp + 11.1);
  float hh = (0.32 + 0.85 * pow(r1, 1.4)) * keep * mix(1.0, uScale, 0.6), wd = (0.7 + 0.7 * r2) * keep * uScale, ang = r3 * 3.14159;
  float ca = cos(ang), sa = sin(ang);
  vec3 lp = vec3(position.x * wd, position.y * hh, position.z * wd);
  lp = vec3(ca * lp.x - sa * lp.z, lp.y, sa * lp.x + ca * lp.z);
  float sway = sin(uTime * 1.9 + bp.x * 0.31 + bp.y * 0.23) + 0.4 * sin(uTime * 4.3 + bp.x * 1.7);
  lp.x += sway * 0.07 * lp.y; lp.z += sway * 0.04 * lp.y;
  transformed = lp + vec3(bp.x, terrH(bp) - 0.03, bp.y);
  vTint = vec3(0.92 + r2 * 0.25, 0.95 + r1 * 0.18, 0.78 + r3 * 0.2);`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
        .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb *= vTint;');
    };
    const grass = new THREE.Mesh(card, gm); grass.frustumCulled = false; grass.receiveShadow = true; scene.add(grass);
  }
  // bushes + tree canopies: instanced leaf-card balls
  {
    const ball = new THREE.BufferGeometry(); const P = [], UV = [], N = [], I = [];
    for (let k = 0; k < 9; k++) {
      const ax = new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).normalize(), ang = R() * Math.PI;
      const qq = new THREE.Quaternion().setFromAxisAngle(ax, ang), b = P.length / 3;
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const vv = new THREE.Vector3(u * 0.6, v * 0.6, 0).applyQuaternion(qq); P.push(vv.x, vv.y, vv.z); const nn = vv.clone().normalize(); N.push(nn.x, nn.y * 0.7 + 0.3, nn.z); UV.push((u + 1) / 2, (v + 1) / 2); }
      I.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    ball.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); ball.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    ball.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); ball.setIndex(I); ball.setAttribute('ao', new THREE.Float32BufferAttribute(new Array(P.length / 3).fill(1), 1));
    const lm = weatherPatch(new THREE.MeshStandardMaterial({ map: leafTexture(R), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.85 }), { foliage: true, wind: false }, uniforms);
    const spots = [];
    for (const t of treeSpots) for (let k = 0; k < 4; k++) spots.push({ x: t.x + (R() - 0.5) * t.h * 0.35, y: terrainHeight(t.x, t.z) + t.h * (0.6 + R() * 0.35), z: t.z + (R() - 0.5) * t.h * 0.35, s: t.h * (0.3 + R() * 0.18) });
    for (let k = 0; k < 160; k++) {
      const f = site.footprints[Math.floor(R() * site.footprints.length)];
      const side = R() < 0.5; const x = side ? (R() < 0.5 ? f.x0 - 1.2 : f.x1 + 1.2) : f.x0 + R() * (f.x1 - f.x0), z = side ? f.z0 + R() * (f.z1 - f.z0) : (R() < 0.5 ? f.z0 - 1.2 : f.z1 + 1.2);
      if (distToPaths(x, z) < 3) continue;
      spots.push({ x, y: terrainHeight(x, z) + 0.5 + R() * 0.6, z, s: 0.9 + R() * 1.8 });
    }
    const inst = new THREE.InstancedMesh(ball, lm, spots.length); const M = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    spots.forEach((b, i) => { q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * 6.28); M.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.s, b.s * (0.8 + R() * 0.4), b.s)); inst.setMatrixAt(i, M);
      const vis = Math.pow(skyVisibility(bvh, new THREE.Vector3(b.x, b.y + b.s * 0.6, b.z), new THREE.Vector3(0, 1, 0), 16, 3), 1.2); col.setRGB(0.8 + R() * 0.3, 0.85 + R() * 0.3, 0.75 + R() * 0.2).multiplyScalar(0.4 + 0.6 * vis); inst.setColorAt(i, col); });
    inst.castShadow = true; inst.receiveShadow = true; scene.add(inst);
  }

  // [A] sun: a shadowed DirectionalLight carrying the energy clamped out of the HDR.
  // Live map: +-48 m (4.7 cm texels at 2048), centred 0.3*ext ahead of the camera, snapped to a texel-aligned ~4 m
  // light-space grid and re-rendered only when that snapped centre moves (autoUpdate off). Beyond it the static far map.
  const sun = new THREE.DirectionalLight(sk.sunColor, sunI);
  scene.environmentIntensity = envI;
  sun.castShadow = sunI > 0.5;                       // overcast: no shadow pass at all
  const sm = quality === 'low' ? 1024 : 2048; sun.shadow.mapSize.set(sm, sm);
  const ext = 48, back = 150;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 2 * back });
  sun.shadow.bias = -0.00008; sun.shadow.normalBias = 0.04; sun.shadow.camera.updateProjectionMatrix();   // 2.4 cm depth bias
  sun.shadow.autoUpdate = false; sun.shadow.needsUpdate = true;
  if (mats.brick) mats.brick.shadowSide = THREE.DoubleSide;   // the chimney tube casts with both skins (no leak down its throat)
  scene.add(sun); scene.add(sun.target);
  const texel = (2 * ext) / sm, snap = texel * Math.max(1, Math.round(4 / texel));
  const lightBasisX = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize(), lightBasisY = new THREE.Vector3().crossVectors(sunDir, lightBasisX);
  const _fwd = new THREE.Vector3(), _ctr = new THREE.Vector3(); let shAx = NaN, shAy = NaN;
  if (sun.castShadow) {
    const fs = renderFarShadow(renderer, scene, merged, sunDir, quality === 'low' ? 1024 : 2048, aLight);
    if (mats.slab) mats.slab.aFarShadowTex = fs.tex;   // so clearWorld()'s material sweep disposes it with the world
    console.info('far shadow texel m', +fs.texel.toFixed(3));
  }
  let grassLevel = 1;
  const update = (camPos, dt, camQuat) => {
    uniforms.uTime.value += dt;
    grassU.uCam.value.copy(camPos);
    const alt = camPos.y - terrainHeight(camPos.x, camPos.z);
    const want = alt > 40 ? 4 : alt > 14 ? 2 : 1;                       // power-of-two steps, with hysteresis
    if (want !== grassLevel && (want > grassLevel ? true : alt < (grassLevel === 4 ? 34 : 11))) grassLevel = want;
    const cell = gCell * grassLevel;
    grassU.uCell.value = cell; grassU.uScale.value = grassLevel; grassU.uR.value = gN * cell * 0.5;
    grassU.uOrigin.value.set(Math.floor(camPos.x / cell) * cell - (gN / 2) * cell, Math.floor(camPos.z / cell) * cell - (gN / 2) * cell);
    // [A] live shadow map follows a point ahead of the camera; re-render only when its snapped centre moves
    _ctr.copy(camPos);
    if (camQuat) { _fwd.set(0, 0, -1).applyQuaternion(camQuat); _fwd.y = 0; const l = _fwd.length(); if (l > 1e-3) _ctr.addScaledVector(_fwd, (0.3 * ext) / l); }
    const ax = Math.round(_ctr.dot(lightBasisX) / snap) * snap, ay = Math.round(_ctr.dot(lightBasisY) / snap) * snap;
    if (ax !== shAx || ay !== shAy) {
      shAx = ax; shAy = ay;
      const c = _ctr.set(0, 0, 0).addScaledVector(lightBasisX, ax).addScaledVector(lightBasisY, ay).addScaledVector(sunDir, camPos.dot(sunDir));
      sun.target.position.copy(c); sun.position.copy(c).addScaledVector(sunDir, back);
      sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
      sun.shadow.needsUpdate = true;
    }
  };
  update(new THREE.Vector3(0, 0, 100), 0);

  // depth for the shutter blur = the solid geometry
  const colScene = new THREE.Scene();
  const cm = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial()); cm.frustumCulled = false; colScene.add(cm);
  prog(0.98, 'Ready');
  BAKE = null;   // [A] the probe solution was only needed while building (decals); free it
  scene.userData.aLight = aLight; scene.userData.lightBake = bake.stats;   // [A] live tuning hooks (uSunB, uSkyB, uFarOn, uHaze...)
  return {
    scene, colliderScene: colScene, bvh, update, hdr: true,
    spawn: new THREE.Vector3(0, terrainHeight(0, 118) + 1.4, 118), yaw: 0,
    bounds: new THREE.Box3(new THREE.Vector3(-480, -5, -480), new THREE.Vector3(480, 260, 480)),
    envelope: { min: new THREE.Vector3(-440, -2, -440), max: new THREE.Vector3(440, 220, 440) },
  };
}
