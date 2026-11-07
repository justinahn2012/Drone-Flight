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
  // sunRatio: direct sun vs sky irradiance. HDR captures squash a hazy low sun; a clear day runs ~4-7x
  sunny: { id: 'evening_meadow', label: 'Sunny', sunRatio: 4.2 },
  overcast: { id: 'farmland_overcast', label: 'Overcast', sunRatio: 0 },
};
// [B] surfaces. CC0 Poly Haven sets at 1k; `maps` = which maps are worth downloading.
// color = linear multiplier on the diffuse map (measured texture means, see report); w = weathering
// [streaks, base damp, up-facing grime, moss]; roughMin = roughness floor (kills the glossy blue sky rim).
// albedo = linear mean RGB of the final shaded material (texture x color x mean weathering): the light bake reads it.
const MATS = {
  silo: { id: 'concrete_layers_02', tile: 3.0, maps: ['diff', 'nor_gl'], color: [1.6, 1.6, 1.64], rough: 0.95, roughMin: 0.86, w: [0.42, 0.34, 0.5, 0.35], albedo: [0.285, 0.270, 0.250] },
  wall: { id: 'concrete_wall_006', tile: 3.0, maps: ['diff', 'nor_gl'], color: [3.65, 3.58, 3.22], rough: 0.95, roughMin: 0.86, w: [0.45, 0.36, 0.55, 0.3], albedo: [0.335, 0.252, 0.168] },
  slab: { id: 'concrete_floor_02', tile: 4.0, maps: ['diff', 'nor_gl'], color: [2.1, 1.94, 1.98], rough: 0.95, roughMin: 0.88, w: [0.35, 0.3, 0.6, 0.45], albedo: [0.322, 0.250, 0.170] },
  brick: { id: 'factory_brick', tile: 2.2, maps: ['diff', 'nor_gl'], color: [1.25, 1.2, 1.85], rough: 0.9, roughMin: 0.8, w: [0.3, 0.3, 0.4, 0.2], albedo: [0.288, 0.177, 0.170] },
  rust: { id: 'rust_coarse_01', tile: 2.0, maps: ['diff'], color: [2.16, 3.0, 5.52], rough: 0.82, roughMin: 0.7, w: [0.25, 0.2, 0.35, 0.1], albedo: [0.262, 0.122, 0.079] },
  ground: { id: 'grass_ground', tile: 4.0, maps: ['diff'], color: [1.25, 1.35, 1.6], rough: 1, kind: 'ground', albedo: [0.190, 0.158, 0.083] },
  bark: { id: 'bark_brown_02', tile: 1.5, maps: ['diff'], color: [1.1, 1.1, 1.1], rough: 0.95, kind: 'bark', albedo: [0.136, 0.111, 0.066] },
  path: { id: 'grass_path_2', tile: 3.5, maps: ['diff'], color: [0.8, 0.8, 0.82], rough: 1, kind: 'track', albedo: [0.223, 0.182, 0.109] },
  // not merged-geometry materials: the paved apron is sampled inside the ground shader; grass and leaves are atlases
  apron: { id: 'asphalt_02', tile: 5.0, maps: ['diff'], color: [1.75, 1.72, 1.72], kind: 'aux', albedo: [0.176, 0.170, 0.152] },
  grass: { model: 'grass_medium_01', tile: 1, maps: ['diff', 'alpha'], color: [1.7, 1.6, 1.9], kind: 'aux', albedo: [0.160, 0.150, 0.070] },
  leaf: { model: 'tree_small_02', tile: 1, maps: ['leaves_diff', 'leaves_alpha'], color: [1.4, 1.3, 1.5], kind: 'aux', albedo: [0.099, 0.124, 0.035] },
};
const texURL = (m, map) => m.model ? `${PH}/Models/jpg/1k/${m.model}/${m.model}_${map}_1k.jpg` : `${PH}/Textures/jpg/1k/${m.id}/${m.id}_${map}_1k.jpg`;

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
  g.userData.cylR = r;            // Site.add snaps the wrap to whole texture tiles and offsets each cylinder
  return g;
}
// [B] element extent for weathering: aY = (bottom, top) world height of the element each vertex belongs to
function setAY(g, y0, y1) {
  const n = g.attributes.position.count, a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = y0; a[i * 2 + 1] = y1; }
  g.setAttribute('aY', new THREE.BufferAttribute(a, 2));
}
const hash2 = (x, z) => { const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return s - Math.floor(s); };
function flip(g) {
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

class Site {
  constructor() { this.parts = {}; this.decalSpots = []; this.footprints = []; this.trunks = []; this.colliders = []; }
  add(mat, g, collide = true) {
    if (!g.index) g = indexify(g);
    // [B] cylinders: wrap the circumference in whole texture tiles (no seam) and give each one its own offset
    const tile = MATS[mat]?.tile;
    if (g.userData.cylR && tile) {
      const circ = 2 * Math.PI * g.userData.cylR, k = Math.max(1, Math.round(circ / tile)) * tile / circ;
      g.computeBoundingBox(); const bb = g.boundingBox;
      const ou = hash2(bb.min.x + bb.max.x, bb.min.z + bb.max.z) * 7 * tile, ov = hash2(bb.min.z, bb.max.x) * 5 * tile;
      const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k + ou, uv.getY(i) + ov);
      delete g.userData.cylR;
    }
    if (!g.attributes.aY) { g.computeBoundingBox(); setAY(g, g.boundingBox.min.y, g.boundingBox.max.y); }
    (this.parts[mat] ||= []).push({ g, collide });
  }
  // axis-aligned (or Y-rotated) box; y0 = bottom
  box(mat, cx, y0, cz, sx, sy, sz, rotY = 0, opt = {}) {
    const g = boxGeo(sx, sy, sz);
    planarUV(g, opt.uvOff || { x: cx * 0.37, y: y0 + sy / 2, z: cz * 0.53 });
    if (rotY) g.rotateY(rotY);
    g.translate(cx, y0 + sy / 2, cz);
    setAY(g, y0, y0 + sy);
    this.add(mat, g, opt.collide !== false);
    return g;
  }
  // a box placed by an arbitrary basis matrix (for sloped / diagonal members); local box spans x:[0,L]
  beam(mat, M, x0, L, y, z, sy, sz) {
    const g = boxGeo(L, sy, sz);
    planarUV(g, { x: x0 + L / 2, y, z });
    g.translate(x0 + L / 2, y, z);
    // aY per vertex: world height of this cross-section's underside and top (the member is sloped)
    const p = g.attributes.position, e = M.elements, a = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const lx = p.getX(i), lz = p.getZ(i), yb = e[1] * lx + e[5] * (y - sy / 2) + e[9] * lz + e[13], yt = e[1] * lx + e[5] * (y + sy / 2) + e[9] * lz + e[13];
      a[i * 2] = Math.min(yb, yt); a[i * 2 + 1] = Math.max(yb, yt);
    }
    g.setAttribute('aY', new THREE.BufferAttribute(a, 2));
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
  const u0 = hash2(ox, oz) * 11, w0 = hash2(oz, oy + ox) * 7;     // [B] one UV origin per wall: texture runs on across jambs
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
      site.box(mat, wx, oy + y0, wz, b - a, y1 - y0, T, rotY, { uvOff: { x: lx + u0, y: oy + (y0 + y1) / 2, z: w0 } });
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
// [B] leaf clusters stamped from the photographed leaves (Poly Haven tree_small_02 leaf atlas): shaded leaves at the
// back, sunlit and yellowed ones in front. Built as a DataTexture so transparent texels keep a leaf colour (no
// black fringes in the mips).
const LEAF_RECTS = [[62, 55, 200, 145], [235, 65, 350, 112], [33, 190, 180, 290], [250, 185, 375, 250], [62, 325, 210, 420], [250, 290, 350, 365], [62, 470, 180, 545],
  [250, 425, 405, 515], [45, 610, 200, 705], [268, 545, 425, 645], [285, 680, 425, 750], [77, 745, 225, 840], [270, 780, 430, 870], [80, 890, 200, 965], [290, 900, 445, 1000]];
function leafCluster(diffT, alphaT, R) {
  const N = 1024, cv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const src = cv(N, N), sg = src.getContext('2d', { willReadFrequently: true });
  sg.drawImage(alphaT.image, 0, 0, N, N); const A = sg.getImageData(0, 0, N, N).data;
  sg.clearRect(0, 0, N, N); sg.drawImage(diffT.image, 0, 0, N, N); const D = sg.getImageData(0, 0, N, N).data;
  const vars = [[1, 1, 1], [0.6, 0.68, 0.72], [1.15, 1.08, 0.66]].map(([r, gg, b]) => {
    const c = cv(N, N), cg = c.getContext('2d'), im = cg.createImageData(N, N), o = im.data;
    for (let i = 0; i < N * N * 4; i += 4) { o[i] = Math.min(255, D[i] * r); o[i + 1] = Math.min(255, D[i + 1] * gg); o[i + 2] = Math.min(255, D[i + 2] * b); o[i + 3] = A[i + 1]; }
    cg.putImageData(im, 0, 0); return c;
  });
  const S = 512, out = cv(S, S), g = out.getContext('2d', { willReadFrequently: true });
  for (let i = 0; i < 120; i++) {
    const back = i < 45, v = back ? 1 : (R() < 0.78 ? 0 : 2), [x0, y0, x1, y1] = LEAF_RECTS[Math.floor(R() * LEAF_RECTS.length)];
    const a = R() * 6.283, rr = Math.sqrt(R()) * S * (back ? 0.33 : 0.42), w = x1 - x0, h = y1 - y0, s = (44 + R() * 40) / Math.max(w, h);
    g.save(); g.translate(S / 2 + Math.cos(a) * rr, S / 2 + Math.sin(a) * rr); g.rotate(R() * 6.283); g.scale(s * (R() < 0.5 ? -1 : 1), s);
    g.drawImage(vars[v], x0, y0, w, h, -w / 2, -h / 2, w, h); g.restore();
  }
  const px = g.getImageData(0, 0, S, S).data, data = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]; data[i + 3] = a;
    if (a < 8) { data[i] = 46; data[i + 1] = 62; data[i + 2] = 22; } else { data[i] = px[i]; data[i + 1] = px[i + 1]; data[i + 2] = px[i + 2]; }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat); t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}
// mean linear colour of a loaded texture (for distance fades / normalisation)
function texMean(t, fallback) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(t.image, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data, m = [0, 0, 0], lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) m[k] += lin(d[i + k]);
    return m.map((v) => v / 1024);
  } catch (e) { return fallback; }
}

// [B] graffiti atlas: 4 x 8 cells of 512 x 256. Pieces (3D block, outline, gradient fill, highlights), throw-ups
// (bubble letters), tag clusters and buffed patches; overspray halos, drips and per-letter jitter.
const CREWS = ['FCU', 'MSK', 'OX', 'SKEB', 'ZOMB', 'RISE', 'DOK', 'KAOS', 'VEX', 'NOPE', 'BANDO', 'GONZ', 'RAW', 'SEKT', 'MOHA', 'LUX', 'TWS', 'AOK', 'KEMS', 'ROEK', 'MUTE', 'HAZE', 'ODE', 'KRASH', 'BLUR', 'DRIP', 'NUKE', 'OMEN', 'REAX', 'UFO', 'SINE', 'BOLT'];
const GPAL = [['#e8327c', '#ffb3d4', '#7a0f3c'], ['#1fa6e6', '#bdeeff', '#0b3f6e'], ['#f5c518', '#fff1a6', '#8a5a00'], ['#2fbf71', '#c9f7dc', '#0d5b33'], ['#f2641e', '#ffd0b5', '#7d2a05'],
  ['#8e5cf0', '#e3d6ff', '#3a1d7a'], ['#c9ced6', '#ffffff', '#6b7079'], ['#d7263d', '#f7a072', '#5e0a14'], ['#0fb5ae', '#a6f0ea', '#05504d'], ['#c3e21b', '#f0ffb0', '#4f5e00']];
const GTYPE = (k) => (k < 14 ? 'piece' : k < 22 ? 'throw' : k < 28 ? 'tags' : 'buff');
function graffitiAtlas(R) {
  return canvasTex(2048, 2048, (g, W, H) => {
    g.clearRect(0, 0, W, H);
    const fontB = (px) => `900 ${px | 0}px "Arial Rounded MT Bold", "Arial Black", Futura, "Helvetica Neue", "DejaVu Sans", sans-serif`;
    const fontT = (px) => `italic 700 ${px | 0}px "Marker Felt", Noteworthy, "Brush Script MT", "Snell Roundhand", "URW Chancery L", cursive`;
    const pick = (a) => a[Math.floor(R() * a.length)];
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineCap = 'round';
    const layout = (word, size, maxW, font) => {
      g.font = font(size); const ws = [...word].map((ch) => g.measureText(ch).width * 0.86); let tot = ws.reduce((a, b) => a + b, 0);
      const k = Math.min(1, maxW / Math.max(1, tot)); g.font = font(size * k); tot *= k;
      let x = -tot / 2; const out = [...word].map((ch, i) => { const w = ws[i] * k, l = { ch, x: x + w / 2, y: (R() - 0.5) * size * k * 0.16, rot: (R() - 0.5) * 0.24, s: 0.92 + R() * 0.2 }; x += w; return l; }); out.sz = size * k; return out;
    };
    const each = (L, fn) => L.forEach((l) => { g.save(); g.translate(l.x, l.y); g.rotate(l.rot); g.scale(l.s, l.s); fn(l.ch); g.restore(); });
    const drips = (col, n, x0, x1, y, w) => {
      g.strokeStyle = col; g.fillStyle = col;
      for (let i = 0; i < n; i++) { const x = x0 + R() * (x1 - x0), y0 = y + (R() - 0.5) * 24, len = 8 + R() * R() * 80; g.lineWidth = w * (0.6 + R() * 0.8);
        g.beginPath(); g.moveTo(x, y0); g.lineTo(x + (R() - 0.5) * 2, y0 + len); g.stroke(); g.beginPath(); g.arc(x, y0 + len, g.lineWidth * 0.75, 0, 6.283); g.fill(); }
    };
    const piece = (word, pal, size, maxW) => {
      const [c1, c2, c3] = pal, L = layout(word, size, maxW, fontB), sz = L.sz;
      if (R() < 0.55) {                                                     // background cloud / bubbles
        g.save(); const bg = pick(GPAL)[R() < 0.5 ? 0 : 2]; g.fillStyle = bg; g.globalAlpha = 0.85; g.shadowColor = bg; g.shadowBlur = 18;
        for (let i = 0; i < 9; i++) { g.beginPath(); g.ellipse((R() - 0.5) * maxW, (R() - 0.5) * 70, 40 + R() * 60, 30 + R() * 40, 0, 0, 6.283); g.fill(); }
        g.restore();
      }
      const dk = R() < 0.5 ? '#141418' : c3;
      each(L, (ch) => { g.fillStyle = dk; g.strokeStyle = dk; g.lineWidth = 22; for (let d = 12; d > 0; d -= 3) { g.strokeText(ch, d, d); g.fillText(ch, d, d); } });
      each(L, (ch) => { g.lineWidth = 24; g.strokeStyle = '#0d0d10'; g.strokeText(ch, 0, 0); });
      each(L, (ch) => {
        const gr = g.createLinearGradient(0, -sz * 0.4, 0, sz * 0.4); gr.addColorStop(0, c2); gr.addColorStop(0.45, c1); gr.addColorStop(1, R() < 0.5 ? c1 : c3);
        g.shadowColor = c1; g.shadowBlur = 10; g.fillStyle = gr; g.strokeStyle = gr; g.lineWidth = 7; g.strokeText(ch, 0, 0); g.fillText(ch, 0, 0); g.shadowBlur = 0;
      });
      each(L, (ch) => { g.save(); g.beginPath(); g.rect(-sz, -sz, 2 * sz, sz * 0.75); g.clip(); g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.85)'; g.strokeText(ch, -3, -4); g.restore(); });
      drips(c1, 4 + Math.floor(R() * 7), -maxW / 2, maxW / 2, sz * 0.3, 4);
      g.fillStyle = '#fff'; for (let i = 0; i < 4; i++) { const x = (R() - 0.5) * maxW, y = (R() - 0.5) * sz * 0.6, s = 5 + R() * 8; g.beginPath(); g.moveTo(x - s, y); g.lineTo(x, y - 1.5); g.lineTo(x + s, y); g.lineTo(x, y + 1.5); g.moveTo(x, y - s); g.lineTo(x + 1.5, y); g.lineTo(x, y + s); g.lineTo(x - 1.5, y); g.fill(); }
    };
    const throwUp = (word, size, maxW) => {
      const fill = pick(['#f4f4f0', '#d9dde2', '#f4f4f0', '#ffd23f', '#ff5fa2', '#64d2ff']), line = R() < 0.75 ? '#101014' : pick(GPAL)[2];
      const L = layout(word.slice(0, 2 + Math.floor(R() * 3)), size, maxW, fontB);
      each(L, (ch) => { g.lineWidth = 42; g.strokeStyle = line; g.strokeText(ch, 0, 0); });
      each(L, (ch) => { g.shadowColor = fill; g.shadowBlur = 8; g.lineWidth = 24; g.strokeStyle = fill; g.fillStyle = fill; g.strokeText(ch, 0, 0); g.fillText(ch, 0, 0); g.shadowBlur = 0; });
      g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(40,40,40,0.18)';     // patchy one-coat fill
      for (let i = 0; i < 14; i++) { g.beginPath(); g.ellipse((R() - 0.5) * maxW, (R() - 0.5) * 90, 10 + R() * 30, 6 + R() * 16, R() * 3, 0, 6.283); g.fill(); }
      g.globalCompositeOperation = 'source-over';
      drips(fill, 3 + Math.floor(R() * 6), -maxW / 2, maxW / 2, size * 0.35, 3);
    };
    const tags = (n, spread) => {
      for (let i = 0; i < n; i++) {
        g.save(); g.translate((R() - 0.5) * spread, (R() - 0.5) * 150); g.rotate((R() - 0.5) * 0.6);
        const word = pick(CREWS), col = pick(['#111', '#111', '#c8ccd2', '#e5e5e5', '#d7263d', '#1f6fe6', '#f2641e', '#2fbf71']);
        const L = layout(R() < 0.6 ? word.toLowerCase() : word, 64 + R() * 50, 150 + R() * 140, fontT);
        const stroke = R() < 0.5, lw = 4 + R() * 3;
        each(L, (ch) => { g.shadowColor = col; g.shadowBlur = 4; g.lineWidth = lw; g.strokeStyle = col; g.fillStyle = col; if (stroke) g.strokeText(ch, 0, 0); else g.fillText(ch, 0, 0); g.shadowBlur = 0; });
        if (R() < 0.5) { g.lineWidth = 3; g.strokeStyle = col; g.beginPath(); g.moveTo(-90, 40); g.quadraticCurveTo(0, 60 + R() * 20, 110, 28); g.stroke(); }
        if (R() < 0.4) drips(col, 2 + Math.floor(R() * 3), -60, 60, 25, 2);
        g.restore();
      }
    };
    for (let k = 0; k < 32; k++) {
      const cx = (k % 4) * 512, cy = Math.floor(k / 4) * 256, type = GTYPE(k), word = CREWS[k];
      g.save(); g.beginPath(); g.rect(cx + 6, cy + 6, 500, 244); g.clip(); g.translate(cx + 256, cy + 124);
      if (type === 'piece') { if (R() < 0.35) { g.save(); g.globalAlpha = 0.7; tags(3, 440); g.restore(); } piece(word, pick(GPAL), 150, 440); }
      else if (type === 'throw') throwUp(word, 165, 420);
      else if (type === 'tags') tags(4 + Math.floor(R() * 4), 380);
      else {
        g.save(); g.globalAlpha = 0.8; piece(word, pick(GPAL), 140, 420); g.restore();
        g.fillStyle = pick(['#8d8a82', '#a39c8c', '#77756f', '#9a948a']); g.globalAlpha = 0.95;
        const bw = 200 + R() * 220, bh = 120 + R() * 90, bx = (R() - 0.5) * (440 - bw);
        for (let i = 0; i < 6; i++) g.fillRect(bx - bw / 2 + (R() - 0.5) * 14, -bh / 2 + (R() - 0.5) * 14, bw, bh);
        g.globalAlpha = 1; tags(1 + Math.floor(R() * 2), 300);
      }
      g.restore();
    }
  });
}
// [B] treeline crown: a few lumps, normals from the crown centre (it shades as one mass), base at y = 0, height ~1
function crownGeometry() {
  const parts = [[0, 0.52, 0, 0.5, 1], [0.24, 0.36, 0.12, 0.34, 0], [-0.22, 0.4, -0.14, 0.33, 0], [0.04, 0.8, 0.03, 0.28, 0]];
  const g = mergeGeometries(parts.map(([x, y, z, r, d]) => { const p = new THREE.IcosahedronGeometry(r, d); p.translate(x, y, z); return p; }), false);
  const p = g.attributes.position, n = g.attributes.normal, v = new THREE.Vector3(), c = new THREE.Vector3(0, 0.5, 0);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i); const k = 1 + (hash2(v.x * 7.1 + v.y * 3.3, v.z * 5.7 - v.y) - 0.5) * 0.18; v.sub(c).multiplyScalar(k).add(c);
    v.y = Math.max(v.y, 0.0); p.setXYZ(i, v.x, v.y, v.z);
    v.sub(c).normalize(); v.y += 0.15; v.normalize(); n.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute('uv'); g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(p.count * 2), 2));
  return g;
}
// [B] ground mask over the yard terrain tile (0.625 m texels): R grass density, G paved apron/road,
// B terrain AO (baked), A grass height. Replaces the per-vertex footprint/path loops of the grass shader.
const MASK = { N: 512, x0: -165, z0: -150, size: 320 };
function buildGroundMask(site, terr) {
  const { N, x0, z0, size } = MASK, d = new Uint8Array(N * N * 4), sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const fh = (i, j) => hash2(i * 1.7 + 0.31, j * 2.3 + 0.77);
  const vno = (x, z) => { const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    return (fh(i, j) * (1 - u) + fh(i + 1, j) * u) * (1 - v) + (fh(i, j + 1) * (1 - u) + fh(i + 1, j + 1) * u) * v; };
  const tao = terr.attributes.ao, TS = 128;
  const aoAt = (x, z) => {
    if (!tao) return 1;
    const fx = Math.min(TS - 1e-3, Math.max(0, (x + 165) / 2.5)), fz = Math.min(TS - 1e-3, Math.max(0, (z + 150) / 2.5)), i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const a = (ii, jj) => tao.getX(jj * (TS + 1) + ii);
    return (a(i, j) * (1 - u) + a(i + 1, j) * u) * (1 - v) + (a(i, j + 1) * (1 - u) + a(i + 1, j + 1) * u) * v;
  };
  const fps = site.footprints;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = x0 + (i + 0.5) * size / N, z = z0 + (j + 0.5) * size / N, o = (j * N + i) * 4;
    let sd = Infinity;
    for (const f of fps) { const dx = Math.max(f.x0 - x, x - f.x1), dz = Math.max(f.z0 - z, z - f.z1); sd = Math.min(sd, dx > 0 || dz > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) : Math.max(dx, dz)); }
    const yard = Math.max(Math.abs(x + 5) - 95, Math.abs(z - 10) - 85), paved = 1 - sm(-14, 0, yard);
    const n1 = vno(x * 0.05, z * 0.05), n2 = vno(x * 0.17 + 3, z * 0.17 + 7), dP = distToPaths(x, z);
    const apW = 5 + 7 * n1;
    let ap = sd < 0 ? 1 : 1 - sm(apW - 2, apW + 2, sd + (n2 - 0.5) * 4);
    ap = Math.max(ap, (1 - sm(2.0, 3.6, dP + (n2 - 0.5) * 1.4 - vno(x * 0.03 + 11, z * 0.03) * 1.2)) * paved);
    let dens = (0.62 + 0.38 * vno(x * 0.09 + 5, z * 0.09)) * (1 - 0.75 * sm(0.72, 0.9, vno(x * 0.035 + 17, z * 0.035 + 3)));
    dens *= sm(0.0, 1.2, sd) * (1 - 0.88 * sm(0.25, 0.75, ap)) * sm(1.8, 3.0, dP);
    let ht = 0.7 + 0.6 * vno(x * 0.06 + 9, z * 0.06 + 1) + 0.5 * (1 - sm(0, 5, sd));
    ht *= 1 - 0.45 * sm(0.3, 0.8, ap);
    d[o] = dens * 255; d[o + 1] = ap * 255; d[o + 2] = Math.min(1, aoAt(x, z)) * 255; d[o + 3] = Math.min(1, ht / 2) * 255;
  }
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat); t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- materials
// [B] One shader patch for every world material. kind: built | decal | ground | track | bark | leaf | grass | treeline.
// Each kind compiles its own program (customProgramCacheKey: three keys programs on onBeforeCompile.toString(),
// which is the same for every patched material). Per-material numbers are uniforms, so one kind = one program.
// Optional hooks (grass, treeline): vsHead/vsBegin (vertex decls / code after begin_vertex), fsHead/fsMap, aoExpr.
// Stream A owns the lighting terms: the aomap block below, and may add an [A-lighting] block at
// lights_fragment_end / fog_fragment; nothing here touches those injection points.
const GLSL_NOISE = `
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float lum3(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`;
// built weathering: per-element run-off streaks from the element top (sills, slab edges, rims), rising damp at the
// foot, dust at storey floors, grime/moss on up-facing faces, warm dust where the weather can't reach (baked AO)
const GLSL_WEATHER = `
uniform vec4 uWx;
vec3 weather(vec3 c, vec3 nw, vec3 wp, vec2 ay, float ao) {
  float side = 1.0 - smoothstep(0.45, 0.8, abs(nw.y));
  float along = abs(nw.x) > abs(nw.z) ? wp.z : wp.x;
  float ht = max(ay.y - wp.y, 0.0), hb = max(wp.y - ay.x, 0.0);
  float L = clamp((ay.y - ay.x) * 0.3, 1.2, 9.0);
  float seed = h21(vec2(ay.x * 1.31 + ay.y * 0.77, floor(along * 0.21) + 0.5));
  c *= 0.86 + 0.28 * vn(vec2(along * 0.13 + seed * 17.0, wp.y * 0.11));
  float col = along * 1.7;
  float Lc = L * (0.3 + 0.9 * vn(vec2(col * 0.6, seed * 9.0)));
  float s = smoothstep(0.42, 0.8, vn(vec2(col, 0.5 + seed * 5.0))) * (0.5 + 0.5 * vn(vec2(along * 6.5, ht * 0.7)));
  s *= 1.0 - smoothstep(0.15 * Lc, Lc, ht);
  float lip = (1.0 - smoothstep(0.0, 0.3, ht)) * 0.55;
  c *= 1.0 - uWx.x * max(s, lip) * side;
  float onG = 1.0 - step(0.6, ay.x);
  float damp = (1.0 - smoothstep(0.1, 1.0 + 0.7 * vn(vec2(along * 0.45, 2.0)), wp.y)) * onG;
  c = mix(c, c * vec3(0.6, 0.66, 0.5), uWx.y * damp);
  float dust = (1.0 - smoothstep(0.0, 0.4, hb)) * (1.0 - onG) * side;
  c = mix(c, c * vec3(0.86, 0.8, 0.7), dust * 0.6);
  float up = smoothstep(0.55, 0.9, nw.y);
  float pt = vn(wp.xz * 0.6) * 0.6 + vn(wp.xz * 2.7) * 0.4;
  c = mix(c, c * vec3(0.64, 0.58, 0.48), up * uWx.z * (0.45 + 0.55 * pt));
  c = mix(c, c * vec3(0.5, 0.66, 0.3), up * uWx.w * smoothstep(0.5, 0.78, pt) * smoothstep(0.45, 0.85, ao));
  float cov = 1.0 - smoothstep(0.25, 0.7, ao);
  c = mix(c, c * vec3(1.05, 0.98, 0.86), cov * 0.7);
  return c;
}`;
const WP_FRAG = {
  built: `
  diffuseColor.rgb = weather(diffuseColor.rgb, normalize(vNW), vWPos, vAY, vAO);`,
  decal: `
  { vec3 nwd = normalize(vNW); float along = abs(nwd.x) > abs(nwd.z) ? vWPos.z : vWPos.x;
    float wl = lum3(texture2D(uWallTex, vec2(along, vWPos.y) * uWallRep).rgb) / uWallMean;   // the concrete shows through
    diffuseColor.rgb *= clamp(wl, 0.55, 1.5);
    diffuseColor.rgb = weather(diffuseColor.rgb, nwd, vWPos, vAY, vAO);
    diffuseColor.a *= (0.74 + 0.26 * vn(vec2(along * 0.9, vWPos.y * 0.9))) * smoothstep(0.1, 0.3, vn(vec2(along * 5.0, vWPos.y * 5.0))); }`,
  ground: `
  { vec2 xz = vWPos.xz; float far = smoothstep(40.0, 140.0, distance(vWPos, cameraPosition));
    vec3 base = mix(diffuseColor.rgb, uGMean, far);                       // no tiling grid from altitude
    float p1 = vn(xz * 0.045) * 0.6 + vn(xz * 0.19) * 0.4;
    float dry = smoothstep(0.3, 0.75, vn(xz * 0.021 + 7.0) * 0.65 + p1 * 0.35);
    base = mix(base * vec3(0.92, 1.03, 0.84), lum3(base) * vec3(1.42, 1.16, 0.62), dry * 0.75);
    vec3 dirt = lum3(base) * vec3(1.2, 0.98, 0.72) * (0.8 + 0.3 * p1);
    float bare = smoothstep(0.66, 0.82, vn(xz * 0.07 + 2.0) * 0.7 + vn(xz * 0.6) * 0.3);
    float cov = 1.0 - smoothstep(0.3, 0.78, vAO);                         // under slabs / inside: bare dirt
    base = mix(base, dirt, max(bare * 0.7, cov));
    vec4 mk = texture2D(uMask, (xz - uMaskO) / uMaskS);
    float ap = smoothstep(0.42, 0.58, mk.g + (vn(xz * 0.9) - 0.5) * 0.34 + (vn(xz * 3.7) - 0.5) * 0.12);
    vec3 at = texture2D(uApron, xz * uApronRep).rgb;                     // (sampled outside any branch: mip derivatives)
    float al = lum3(at) / uAMean.w;
    vec3 asph = mix(at * uApronCol, uAMean.rgb, far);
    asph *= 0.8 + 0.35 * vn(xz * 0.11 + 4.0);                             // patches of old repair and stain
    float crack = (1.0 - smoothstep(0.4, 0.68, al)) * (1.0 - far);         // weeds and moss in the cracks
    asph = mix(asph, vec3(0.045, 0.06, 0.02), crack * 0.8);
    asph = mix(asph, dirt, (1.0 - smoothstep(0.2, 0.75, ap)) * 0.55 + smoothstep(0.7, 0.9, vn(xz * 0.33)) * 0.35);
    diffuseColor.rgb = mix(base, asph, ap); }`,
  track: `
  { vec4 mk = texture2D(uMask, (vWPos.xz - uMaskO) / uMaskS);
    float a = diffuseColor.a + (vn(vWPos.xz * 0.9) - 0.5) * 0.6;
    diffuseColor.a = smoothstep(0.3, 0.65, a) * (1.0 - smoothstep(0.35, 0.6, mk.g));
    diffuseColor.rgb *= 0.88 + 0.24 * vn(vWPos.xz * 0.2); }`,
  bark: `
  diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(0.0, 1.2, vWPos.y - vAY.x));`,
  leaf: '', grass: '', treeline: '',
};
function weatherPatch(mat, opt = {}, uniforms) {
  const kind = opt.kind || (opt.ground ? 'ground' : opt.foliage ? 'leaf' : 'built');
  const usesAY = kind === 'built' || kind === 'decal' || kind === 'bark';
  const weathers = kind === 'built' || kind === 'decal';
  const foliage = kind === 'leaf' || kind === 'grass';
  const wu = { uWx: { value: new THREE.Vector4(...(opt.w || [0.4, 0.3, 0.5, 0.3])) }, uRoughMin: { value: opt.roughMin ?? 0 }, ...(opt.uniforms || {}) };
  mat.customProgramCacheKey = () => 'wp:' + kind + (opt.key || '');
  mat.userData.wu = wu;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    Object.assign(sh.uniforms, wu);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float ao;
attribute vec3 bounce;
varying float vAO;
varying vec3 vBounce;
varying vec3 vWPos;
uniform float uTime;
varying vec3 vNW;
${usesAY ? 'attribute vec2 aY;\nvarying vec2 vAY;' : ''}
${kind === 'leaf' ? 'attribute float aSway;' : ''}
${opt.vsHead || ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${kind === 'leaf' ? `  transformed += vec3(sin(uTime * 1.7 + position.x * 0.4 + position.z * 0.3), 0.3 * sin(uTime * 2.3 + position.y), cos(uTime * 1.3 + position.z * 0.35)) * aSway;` : ''}
${opt.vsBegin || ''}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vAO = ${opt.aoExpr || 'ao'}; vBounce = bounce;
  vec4 wpp = vec4(transformed, 1.0);
  vec3 nwo = objectNormal;
  #ifdef USE_INSTANCING
    wpp = instanceMatrix * wpp; nwo = mat3(instanceMatrix) * nwo;
  #endif
  vWPos = (modelMatrix * wpp).xyz;
  vNW = mat3(modelMatrix) * nwo;
  ${usesAY ? 'vAY = aY;' : ''}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vAO;
varying vec3 vBounce;
varying vec3 vWPos;
varying vec3 vNW;
uniform float uRoughMin;
${usesAY ? 'varying vec2 vAY;' : ''}
${GLSL_NOISE}
${weathers ? GLSL_WEATHER : ''}
${kind === 'decal' ? 'uniform sampler2D uWallTex; uniform float uWallRep; uniform float uWallMean;' : ''}
${kind === 'ground' || kind === 'track' ? 'uniform sampler2D uMask; uniform vec2 uMaskO; uniform float uMaskS;' : ''}
${kind === 'ground' ? 'uniform sampler2D uApron; uniform float uApronRep; uniform vec3 uApronCol; uniform vec3 uGMean; uniform vec4 uAMean;' : ''}
${opt.fsHead || ''}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
${kind === 'track' ? '' : WP_FRAG[kind]}
${opt.fsMap || ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
${kind === 'track' ? WP_FRAG.track : ''}`)
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
${opt.fsAlpha || ''}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = max(roughnessFactor, uRoughMin);`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
${foliage ? `#ifdef DOUBLE_SIDED
  normal *= faceDirection; nonPerturbedNormal = normal;     // cards are lit like the canopy/ground they belong to, both faces
#endif` : ''}`)
      .replace('#include <aomap_fragment>', `reflectedLight.indirectDiffuse = reflectedLight.indirectDiffuse * vAO + vBounce * BRDF_Lambert(material.diffuseColor);
  reflectedLight.indirectSpecular *= vAO * vAO;
#include <aomap_fragment>`);
  };
  return mat;
}

// ---------------------------------------------------------------- baked sky visibility
const DIRS = (() => { const d = []; const n = 10; for (let i = 0; i < n; i++) { const u = (i + 0.5) / n, phi = i * 2.399963; const r = Math.sqrt(u); d.push([Math.cos(phi) * r, Math.sqrt(1 - u), Math.sin(phi) * r]); } return d; })();
const _ray = new THREE.Ray(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _bx = new THREE.Vector3(), _by = new THREE.Vector3();
// one-bounce probe: the sky a point can see, plus the sun and sky light thrown back at it by
// everything around it (sunlit ground through a window is what lights a real interior)
const LP = { sun: new THREE.Vector3(0, 1, 0), sunRGB: new THREE.Vector3(), skyRGB: new THREE.Vector3(), out: new THREE.Vector3() };
const _hn = new THREE.Vector3(), _sr = new THREE.Ray(), _alb = new THREE.Vector3();
const ALB_GROUND = new THREE.Vector3(0.19, 0.19, 0.13), ALB_BUILT = new THREE.Vector3(0.36, 0.34, 0.3);
function lightProbe(bvh, p, n, maxD, rays) {
  const up = Math.abs(n.y) < 0.95 ? _t2.set(0, 1, 0) : _t2.set(1, 0, 0);
  _bx.crossVectors(up, n).normalize(); _by.crossVectors(n, _bx);
  let open = 0; const E = LP.out.set(0, 0, 0);
  for (let i = 0; i < rays; i++) {
    const [a, b, c] = DIRS[(i * 3 + 1) % DIRS.length];
    _t1.set(0, 0, 0).addScaledVector(_bx, a).addScaledVector(n, b).addScaledVector(_by, c).normalize();
    _ray.origin.copy(p).addScaledVector(n, 0.06); _ray.direction.copy(_t1);
    const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, maxD);
    if (!hit) { open += 1; continue; }
    _hn.copy(hit.face.normal); if (_hn.dot(_t1) > 0) _hn.negate();
    const gnd = hit.point.y < terrainHeight(hit.point.x, hit.point.z) + 0.35;
    _alb.copy(gnd ? ALB_GROUND : ALB_BUILT);
    let e = 0;
    const cs = _hn.dot(LP.sun);
    _sr.origin.copy(hit.point).addScaledVector(_hn, 0.05);
    if (cs > 0) { _sr.direction.copy(LP.sun); if (!bvh.raycastFirst(_sr, THREE.DoubleSide, 0, 160)) e = cs; }
    _sr.direction.copy(_hn).addScaledVector(_t2.set(0, 1, 0), 0.8).normalize();
    const skyHit = bvh.raycastFirst(_sr, THREE.DoubleSide, 0, 40) ? 0.06 : 0.55 + 0.4 * _hn.y;
    E.x += _alb.x * (LP.sunRGB.x * e + LP.skyRGB.x * skyHit);
    E.y += _alb.y * (LP.sunRGB.y * e + LP.skyRGB.y * skyHit);
    E.z += _alb.z * (LP.sunRGB.z * e + LP.skyRGB.z * skyHit);
  }
  E.multiplyScalar(1.25 / rays);           // 1.25: the second and later bounces
  return open / rays;
}
const aoCurve = (v) => Math.pow(v, 1.15) * 0.96 + 0.04;
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
async function bakeAO(g, bvh, maxD, rays, onTick) {
  const p = g.attributes.position, n = g.attributes.normal, ao = new Float32Array(p.count), bo = new Float32Array(p.count * 3);
  const P = new THREE.Vector3(), N = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    P.fromBufferAttribute(p, i); N.fromBufferAttribute(n, i);
    ao[i] = aoCurve(lightProbe(bvh, P, N, maxD, rays)); bo[i * 3] = LP.out.x; bo[i * 3 + 1] = LP.out.y; bo[i * 3 + 2] = LP.out.z;
    if ((i & 2047) === 0) { onTick?.(i / p.count); await yieldUI(); }
  }
  g.setAttribute('ao', new THREE.BufferAttribute(ao, 1)); g.setAttribute('bounce', new THREE.BufferAttribute(bo, 3));
}

// ---------------------------------------------------------------- sky: real HDR photo, sun split out for shadows
async function loadSky(id, renderer, onProgress) {
  const url = `${PH}/HDRIs/hdr/2k/${id}_2k.hdr`;
  const tex = await new HDRLoader().setDataType(THREE.FloatType).loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
  const { width: W, height: H, data } = tex.image; const ch = data.length / (W * H);
  // find the sun, measure its irradiance, clamp it out of the map (the directional light carries it, with shadows)
  let maxL = 0, mi = 0;
  for (let i = 0; i < W * H; i++) { const L = 0.2126 * data[i * ch] + 0.7152 * data[i * ch + 1] + 0.0722 * data[i * ch + 2]; if (L > maxL) { maxL = L; mi = i; } }
  const dirOf = (px, py) => { const u = (px + 0.5) / W, v = 1 - (py + 0.5) / H; const lat = (v - 0.5) * Math.PI, phi = (u - 0.5) * 2 * Math.PI; return new THREE.Vector3(Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)); };
  const sunDir = dirOf(mi % W, Math.floor(mi / W));
  const T = Math.max(8, Math.min(40, maxL * 0.05));
  const E = new THREE.Vector3();
  let horizon = new THREE.Vector3(), hn = 0; const skyE = new THREE.Vector3();
  for (let py = 0; py < H; py++) {
    const lat = (0.5 - (py + 0.5) / H) * Math.PI, dO = (2 * Math.PI / W) * (Math.PI / H) * Math.cos(lat);
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * ch, L = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (Math.abs(lat) < 0.06 && px % 4 === 0) { horizon.x += data[i]; horizon.y += data[i + 1]; horizon.z += data[i + 2]; hn++; }
      if (L > T) {
        const k = (L - T) / L, cosT = Math.max(0, dirOf(px, py).dot(sunDir));
        E.x += data[i] * k * dO * cosT; E.y += data[i + 1] * k * dO * cosT; E.z += data[i + 2] * k * dO * cosT;
        data[i] *= 1 - k; data[i + 1] *= 1 - k; data[i + 2] *= 1 - k;
      }
      if (lat > 0) { const w = dO * Math.sin(lat); skyE.x += data[i] * w; skyE.y += data[i + 1] * w; skyE.z += data[i + 2] * w; }
    }
  }
  horizon.divideScalar(Math.max(1, hn));
  // upload as half float (linear filtering is core in WebGL2; float32 filtering isn't guaranteed on iOS)
  const half = new Uint16Array(W * H * 4);
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 4; c++) half[i * 4 + c] = THREE.DataUtils.toHalfFloat(c < 3 ? data[i * ch + c] : 1);
  const sky = new THREE.DataTexture(half, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  sky.mapping = THREE.EquirectangularReflectionMapping; sky.colorSpace = THREE.LinearSRGBColorSpace;
  sky.magFilter = THREE.LinearFilter; sky.minFilter = THREE.LinearFilter; sky.generateMipmaps = false; sky.flipY = true; sky.needsUpdate = true;
  tex.dispose();
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromEquirectangular(sky).texture; pm.dispose();
  const Ei = Math.max(E.x, E.y, E.z, 1e-3);
  console.info('sky', id, 'sun irradiance', E.toArray().map((v) => +v.toFixed(2)), 'maxL', +maxL.toFixed(1), 'T', +T.toFixed(1), 'sunDir', sunDir.toArray().map((v) => +v.toFixed(2)), 'horizon', horizon.toArray().map((v) => +v.toFixed(2)), 'skyE', skyE.toArray().map((v) => +v.toFixed(2)));
  return { sky, env, sunDir, sunColor: new THREE.Color(E.x / Ei, E.y / Ei, E.z / Ei), sunE: Ei, horizon, skyE };
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

  // [B] trees: thickets hugging the buildings plus lone field trees. Own RNG, so layout edits elsewhere
  // don't reshuffle them. Trunks collide, canopies don't.
  const TR = rng(1101), treeSpots = [];
  const clearOf = (x, z, m) => !site.footprints.some((f) => x > f.x0 - m && x < f.x1 + m && z > f.z0 - m && z < f.z1 + m);
  const okTree = (x, z) => clearOf(x, z, 2.5) && distToPaths(x, z) > 4.5 && Math.hypot(x, z - 120) > 14 && !treeSpots.some((t) => Math.hypot(t.x - x, t.z - z) < 2.4 + t.h * 0.12);
  const addTree = (x, z, h) => {
    const y = terrainHeight(x, z), r = 0.09 + h * 0.02;
    treeSpots.push({ x, z, h, r, y });
    const g = cylGeo(r * 0.55, r, h * 0.62, 7, false); g.translate(x, y + h * 0.31 - 0.1, z); site.add('bark', g);
  };
  const bigF = site.footprints.filter((f) => (f.x1 - f.x0) * (f.z1 - f.z0) > 60);
  for (let k = 0; k < 9 && bigF.length; k++) {
    const f = bigF[Math.floor(TR() * bigF.length)], side = Math.floor(TR() * 4), off = 3 + TR() * 5, t = TR();
    const cx = side < 2 ? f.x0 + t * (f.x1 - f.x0) : (side === 2 ? f.x0 - off : f.x1 + off);
    const cz = side < 2 ? (side === 0 ? f.z0 - off : f.z1 + off) : f.z0 + t * (f.z1 - f.z0);
    for (let i = 0, n = 3 + Math.floor(TR() * 4); i < n; i++) {
      const x = cx + (TR() - 0.5) * 10, z = cz + (TR() - 0.5) * 10;
      if (okTree(x, z)) addTree(x, z, 5 + TR() * 8);
    }
  }
  for (let k = 0; k < 60 && treeSpots.length < 62; k++) {
    const x = -135 + TR() * 255, z = -105 + TR() * 235;
    if (okTree(x, z) && clearOf(x, z, 9)) addTree(x, z, 7 + TR() * 8);
  }

  // [B] distant treeline ring (r ~150-420 m around the site): the horizon for skies with no photographed ground.
  // Crowns are instanced in buildBando; low-poly proxies keep the drone out of them (site.colliders).
  const treeline = [];
  {
    const LR = rng(1201), fb = new MeshBVH(far.clone()), ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    const groundAt = (x, z) => {
      ray.origin.set(x, 400, z); const h = fb.raycastFirst(ray, THREE.DoubleSide);
      let y = h ? h.point.y : 0; if (Math.abs(x + 5) < 158 && Math.abs(z - 10) < 158) y = Math.max(y, terrainHeight(x, z)); return y;
    };
    const belt = (a) => 0.5 + 0.5 * Math.sin(a * 3 + 1.3) * Math.cos(a * 5 - 0.4);
    const groves = Array.from({ length: 12 }, () => { const a = LR() * 6.283, r = 250 + LR() * 150; return [-5 + Math.cos(a) * r, 10 + Math.sin(a) * r]; });
    const proxy = new THREE.IcosahedronGeometry(1, 0);
    for (let k = 0; k < 780; k++) {
      let x, z;
      if (k < 600) { const a = LR() * Math.PI * 2, r = 150 + Math.pow(LR(), 1.5) * (35 + 95 * belt(a)); x = -5 + Math.cos(a) * r; z = 10 + Math.sin(a) * r; }
      else { const g = groves[k % groves.length]; x = g[0] + (LR() - 0.5) * 50; z = g[1] + (LR() - 0.5) * 50; }
      const h = 8 + Math.pow(LR(), 0.8) * 13, w = h * (0.55 + LR() * 0.35), y = groundAt(x, z) - 0.6;
      treeline.push({ x, y, z, h, w, d: w * (0.8 + LR() * 0.4), rot: LR() * 6.283, tint: LR() });
      const c = proxy.clone(); c.scale(w * 0.42, h * 0.42, w * 0.42); c.translate(x, y + h * 0.5, z); site.colliders.push(indexify(c));
    }
  }

  // merge structures per material + one collision geometry
  const solids = [];
  const merged = {};
  for (const [mat, list] of Object.entries(site.parts)) {
    merged[mat] = mergeGeometries(list.map((e) => { const g = e.g; for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'aY'].includes(k)) g.deleteAttribute(k); return g; }), false);
    list.forEach((e) => e.collide && solids.push(e.g));
  }
  const colGeo = mergeGeometries([...[...solids, ...site.colliders].map((g) => { const c = new THREE.BufferGeometry(); c.setAttribute('position', g.attributes.position); c.setIndex(g.index); return c; }),
    (() => { const c = new THREE.BufferGeometry(); c.setAttribute('position', terr.attributes.position); c.setIndex(terr.index); return c; })()], false);
  colGeo.computeBoundingBox();
  const bvh = new MeshBVH(colGeo);

  return { site, terr, far, pathG, treeSpots, treeline, merged, colGeo, bvh };
}

// ---------------------------------------------------------------- build everything
export async function buildBando(renderer, { sky = 'sunny', quality = 'auto', seed = 7, onProgress } = {}) {
  const R = rng(seed);
  const prog = (f, t) => onProgress?.(f, t);
  const scene = new THREE.Scene();
  const uniforms = { uTime: { value: 0 } };

  // textures (stream in parallel with the sky)
  const tl = new THREE.TextureLoader(); tl.setCrossOrigin('anonymous');
  let texDone = 0; const texTotal = Object.values(MATS).reduce((s, m) => s + (m.maps?.length || 0), 0);
  const loadTex = (url, srgb) => new Promise((res) => tl.load(url, (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; texDone++; res(t); }, undefined, () => { texDone++; res(null); }));
  const texJobs = {};
  for (const [k, m] of Object.entries(MATS)) {
    const maps = m.maps || [];
    texJobs[k] = Promise.all(maps.map((map) => loadTex(texURL(m, map), /diff/.test(map))))
      .then((ts) => Object.fromEntries(maps.map((map, i) => [map.replace(/^leaves_/, ''), ts[i]])));
  }
  let skyFrac = 0;
  const ticker = setInterval(() => prog(0.05 + 0.55 * (skyFrac * 0.5 + (texDone / texTotal) * 0.5), 'Streaming sky and materials'), 200);
  const skyP = loadSky(SKIES[sky]?.id || SKIES.sunny.id, renderer, (f) => (skyFrac = f));

  // geometry (CPU) while downloads run
  const { site, terr, far, pathG, treeSpots, treeline, merged, colGeo, bvh } = buildGeometry(R);
  prog(0.62, 'Building collision');
  await yieldUI();

  const sk = await skyP;
  const envI = 0.85, skyLum = 0.2126 * sk.skyE.x + 0.7152 * sk.skyE.y + 0.0722 * sk.skyE.z;
  const sunI = Math.min(16, Math.max(sk.sunE, (SKIES[sky]?.sunRatio || 0) * skyLum * envI));
  LP.sun.copy(sk.sunDir); if (LP.sun.y < 0.12) { LP.sun.y = 0.12; LP.sun.normalize(); } LP.sunRGB.set(sk.sunColor.r, sk.sunColor.g, sk.sunColor.b).multiplyScalar(sunI); LP.skyRGB.copy(sk.skyE).multiplyScalar(envI);
  prog(0.62, 'Baking light');
  // baked light: sky visibility (what can't reach under slabs, into the chimney, into corners) + one bounce
  const rays = quality === 'low' ? 4 : quality === 'high' ? 8 : 6;
  const bakeList = [...Object.values(merged), terr];
  const totalV = bakeList.reduce((s, g) => s + g.attributes.position.count, 0); let doneV = 0;
  for (const g of bakeList) {
    await bakeAO(g, bvh, g === terr ? 18 : 26, g === terr ? Math.max(4, rays - 3) : rays, (f) => prog(0.62 + 0.26 * ((doneV + f * g.attributes.position.count) / totalV), 'Baking light'));
    doneV += g.attributes.position.count;
  }
  if (merged.brick) {
    const g = merged.brick, p = g.attributes.position, n = g.attributes.normal, ao = g.attributes.ao;
    const bo = g.attributes.bounce;
    for (let i = 0; i < p.count; i++) { const rx = p.getX(i) - 44, rz = p.getZ(i) + 40; if (rx * n.getX(i) + rz * n.getZ(i) < 0) { ao.setX(i, ao.getX(i) * 0.3); bo.setXYZ(i, bo.getX(i) * 0.5, bo.getY(i) * 0.5, bo.getZ(i) * 0.5); } }
  }
  const farAO = new Float32Array(far.attributes.position.count).fill(1); far.setAttribute('ao', new THREE.BufferAttribute(farAO, 1));
  const zeroB = (g) => g.setAttribute('bounce', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
  zeroB(far);
  const pathAO = new Float32Array(pathG.attributes.position.count);
  const pathB = new Float32Array(pathG.attributes.position.count * 3);
  { const p = pathG.attributes.position, P = new THREE.Vector3(), N = new THREE.Vector3(0, 1, 0); for (let i = 0; i < p.count; i++) { P.fromBufferAttribute(p, i); pathAO[i] = aoCurve(lightProbe(bvh, P, N, 18, 4)); LP.out.toArray(pathB, i * 3); } }
  pathG.setAttribute('ao', new THREE.BufferAttribute(pathAO, 1)); pathG.setAttribute('bounce', new THREE.BufferAttribute(pathB, 3));

  const texSets = await Promise.all(Object.values(texJobs));
  clearInterval(ticker);
  const texOf = {}; Object.keys(MATS).forEach((k, i) => (texOf[k] = texSets[i]));
  prog(0.9, 'Lighting');

  scene.background = sk.sky; scene.environment = sk.env;
  scene.fog = new THREE.Fog(new THREE.Color(sk.horizon.x, sk.horizon.y, sk.horizon.z), 180, 2200);

  const bStats = {}; globalThis.__bandoStats = bStats;    // [B] counts for the smoke harness / integrator
  // [B] ground mask (grass density, paved apron, terrain AO, grass height) shared by the ground, tracks and grass
  const gmask = buildGroundMask(site, terr);
  const maskU = { uMask: { value: gmask }, uMaskO: { value: new THREE.Vector2(MASK.x0, MASK.z0) }, uMaskS: { value: MASK.size } };
  const lin3 = (a) => new THREE.Color().setRGB(a[0], a[1], a[2]);
  const meanOf = (key) => { const m = MATS[key], t = texOf[key]?.diff, raw = t ? texMean(t, null) : null; return raw ? { raw, col: raw.map((v, i) => v * m.color[i]) } : { raw: [0.1, 0.1, 0.1], col: m.albedo }; };
  const kindU = (key) => {
    const m = MATS[key];
    if (m.kind === 'ground') {
      const gm = meanOf('ground'), am = meanOf('apron'), at = texOf.apron?.diff;
      return { ...maskU, uApron: { value: at || gmask }, uApronRep: { value: 1 / MATS.apron.tile }, uApronCol: { value: lin3(MATS.apron.color) },
        uGMean: { value: lin3(gm.col) }, uAMean: { value: new THREE.Vector4(...am.col, Math.max(0.02, 0.2126 * am.raw[0] + 0.7152 * am.raw[1] + 0.0722 * am.raw[2])) } };
    }
    return m.kind === 'track' ? maskU : {};
  };
  const mkMat = (key, extra = {}) => {
    const m = MATS[key], t = texOf[key] || {};
    const rep = 1 / m.tile;
    Object.values(t).forEach((tx) => tx && tx.repeat.set(rep, rep));
    const mat = new THREE.MeshStandardMaterial({ map: t.diff || null, normalMap: t.nor_gl || null, roughness: m.rough ?? 1, metalness: 0,
      color: t.diff ? lin3(m.color) : new THREE.Color(0x9a9690), normalScale: new THREE.Vector2(1, 1), ...extra });
    return weatherPatch(mat, { kind: m.kind || 'built', w: m.w, roughMin: m.roughMin, uniforms: kindU(key) }, uniforms);
  };
  const mats = {}; for (const [k, m] of Object.entries(MATS)) if (m.kind !== 'aux') mats[k] = mkMat(k);
  mats.path.transparent = true; mats.path.vertexColors = true; mats.path.depthWrite = false; mats.path.polygonOffset = true; mats.path.polygonOffsetFactor = -2;

  for (const [mat, g] of Object.entries(merged)) {
    const mesh = new THREE.Mesh(g, mats[mat] || mats.wall); mesh.castShadow = true; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false; scene.add(mesh);
  }
  const terrMesh = new THREE.Mesh(terr, mats.ground); terrMesh.receiveShadow = true; scene.add(terrMesh);
  const farMat = mkMat('ground'); const farMesh = new THREE.Mesh(far, farMat); farMesh.receiveShadow = false; scene.add(farMesh);
  const pathMesh = new THREE.Mesh(pathG, mats.path); pathMesh.receiveShadow = true; pathMesh.renderOrder = 1; scene.add(pathMesh);

  // [B] graffiti: ~100 big pieces placed by a raycast pass on ground-storey walls (outside and in), in the hall, the
  // stair shaft and under the silo table, plus Site.decalSpots as hints. Each piece is a grid conformed to the surface
  // by rays (so it also wraps silos and the chimney) and is rejected over openings, edges and steps. The paint
  // multiplies the wall texture and gets the same weathering as the wall under it.
  {
    const GR = rng(1401), atlas = graffitiAtlas(rng(1402));
    const pos = [], uv = [], nor = [], aoA = [], boA = [], ayA = [], idx = [], placed = [];
    const ray = new THREE.Ray(), UP = new THREE.Vector3(0, 1, 0), DN = new THREE.Vector3(0, -1, 0), U = new THREE.Vector3(), V = new THREE.Vector3(), Q = new THREE.Vector3(), nd = new THREE.Vector3();
    const cast = (o, d, maxD) => { ray.origin.copy(o); ray.direction.copy(d); return bvh.raycastFirst(ray, THREE.DoubleSide, 0, maxD); };
    const cellsBy = { piece: [], throw: [], tags: [], buff: [] }; for (let k = 0; k < 32; k++) cellsBy[GTYPE(k)].push(k);
    const kindPref = () => { const r = GR(); return r < 0.5 ? 'piece' : r < 0.82 ? 'throw' : r < 0.92 ? 'buff' : 'tags'; };
    const tryPiece = (P, n, w, h, kind) => {
      U.crossVectors(UP, n).normalize(); V.crossVectors(n, U); nd.copy(n).negate();
      for (const p of placed) { const dv = P.clone().sub(p.c); if (p.n.dot(n) > 0.7 && Math.abs(dv.dot(n)) < 0.7 && Math.abs(dv.dot(U)) < (p.w + w) * 0.46 && Math.abs(dv.y) < (p.h + h) * 0.5) return false; }
      const nx = Math.max(3, Math.round(w / 0.55)), ny = Math.max(2, Math.round(h / 0.55)), grid = [];
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        Q.copy(P).addScaledVector(U, (i / nx - 0.5) * w).addScaledVector(V, (j / ny - 0.5) * h).addScaledVector(n, 0.45);
        const hit = cast(Q, nd, 1.0); if (!hit) return false;
        const hn = hit.face.normal.clone(); if (hn.dot(n) < 0) hn.negate(); if (hn.dot(n) < 0.6) return false;
        grid.push({ p: hit.point.clone().addScaledVector(hn, 0.012), n: hn, d: hit.distance });
      }
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        const a = grid[j * (nx + 1) + i];
        if (i < nx && Math.abs(a.d - grid[j * (nx + 1) + i + 1].d) > 0.12) return false;
        if (j < ny && Math.abs(a.d - grid[(j + 1) * (nx + 1) + i].d) > 0.12) return false;
      }
      // the element under the paint: from just inside the surface, the first hits up and down are its top and bottom
      const S = grid[Math.floor(grid.length / 2)].p.clone().addScaledVector(n, -0.1);
      const hu = cast(S, UP, 60), hd = cast(S, DN, 60), top = hu ? S.y + hu.distance : P.y + h, bot = hd ? S.y - hd.distance : 0;
      const list = cellsBy[kind], cell = list[Math.floor(GR() * list.length)], cu = (cell % 4) / 4, cv = 1 - (Math.floor(cell / 4) + 1) / 8;
      const b = pos.length / 3;
      grid.forEach((q, k) => {
        const i = k % (nx + 1), j = Math.floor(k / (nx + 1));
        pos.push(q.p.x, q.p.y, q.p.z); nor.push(q.n.x, q.n.y, q.n.z); uv.push(cu + (i / nx) * 0.25, cv + (j / ny) * 0.125); ayA.push(bot, top);
        aoA.push(aoCurve(lightProbe(bvh, q.p, q.n, 22, 4))); boA.push(LP.out.x, LP.out.y, LP.out.z);
      });
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = b + j * (nx + 1) + i; idx.push(a, a + 1, a + nx + 2, a, a + nx + 2, a + nx + 1); }
      placed.push({ c: P.clone(), n: n.clone(), w, h });
      return true;
    };
    // H: a hit point on a wall, hn: its normal. Big first, then smaller; the last try is a tag-sized piece (columns).
    const place = (H, hn, wMin, wMax) => {
      const n = hn.clone().setY(0); if (n.lengthSq() < 0.5) return false; n.normalize();
      const fl = cast(H.clone().addScaledVector(n, 0.3), DN, 14), floorY = fl ? fl.point.y : H.y - 1.5;
      let w = wMin + GR() * (wMax - wMin);
      for (let t = 0; t < 4; t++) {
        if (t === 3) w = 0.7;
        const h = w * 0.5, kind = w < 1.6 ? 'tags' : kindPref(), P = H.clone();
        P.y = Math.max(H.y, floorY + 0.3 + h / 2 + GR() * 0.5);
        if (tryPiece(P, n, w, h, kind)) return true;
        w *= 0.72;
      }
      return false;
    };
    const shoot = (o, d, maxD, minD, wMin, wMax) => {
      const hit = cast(o, d, maxD); if (!hit || hit.distance < minD) return false;
      const hn = hit.face.normal.clone(); if (hn.dot(d) > 0) hn.negate(); if (Math.abs(hn.y) > 0.3) return false;
      return place(hit.point, hn, wMin, wMax);
    };
    const hdir = () => { const a = GR() * 6.283; return new THREE.Vector3(Math.cos(a), 0, Math.sin(a)); };
    const zone = (quota, tries, gen) => { let n = 0; for (let t = 0; t < tries && n < quota; t++) if (gen()) n++; return n; };
    const counts = {};
    // hints from the site plan
    counts.spots = site.decalSpots.reduce((n, s) => n + (shoot(s.c.clone().addScaledVector(s.n, 0.8), s.n.clone().negate(), 2.0, 0, Math.max(2.2, s.w), Math.max(3.2, s.w * 1.5)) ? 1 : 0), 0);
    const bigF = site.footprints.filter((f) => (f.x1 - f.x0) * (f.z1 - f.z0) > 30);
    const ring = (yLo, yHi) => () => {
      const f = bigF[Math.floor(GR() * bigF.length)], side = Math.floor(GR() * 4), t = 0.08 + GR() * 0.84, off = 4 + GR() * 3;
      const x = side < 2 ? f.x0 + t * (f.x1 - f.x0) : side === 2 ? f.x0 - off : f.x1 + off, z = side < 2 ? (side === 0 ? f.z0 - off : f.z1 + off) : f.z0 + t * (f.z1 - f.z0);
      const d = side === 0 ? new THREE.Vector3(0, 0, 1) : side === 1 ? new THREE.Vector3(0, 0, -1) : side === 2 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(-1, 0, 0);
      return shoot(new THREE.Vector3(x, terrainHeight(x, z) + yLo + GR() * (yHi - yLo), z), d, off + 12, 0.5, 2.4, 6);
    };
    counts.outside = zone(44, 500, ring(1.5, 3.0));
    counts.upper = zone(9, 200, ring(6.2, 10));
    const inBox = (x0, x1, z0, z1, ys, minD) => () => shoot(new THREE.Vector3(x0 + GR() * (x1 - x0), ys(), z0 + GR() * (z1 - z0)), hdir(), 25, minD, 2.2, 5.5);
    const hall = site.footprints.find((f) => f.x1 - f.x0 > 50) || bigF[0];
    counts.hall = zone(26, 400, inBox(hall.x0 + 2, hall.x1 - 2, hall.z0 + 2, hall.z1 - 2, () => { const r = GR(); return (r < 0.6 ? 0 : r < 0.85 ? 5 : 10) + 1.4 + GR() * 1.3; }, 1.5));
    counts.table = zone(10, 200, inBox(-53, -15, -27, -1, () => 1.3 + GR() * 1.8, 1.0));
    counts.shaft = zone(9, 120, () => { const a = Math.floor(GR() * 4) * Math.PI / 2 + (GR() - 0.5) * 0.3; return shoot(new THREE.Vector3(-33.9, 1.6 + Math.floor(GR() * 9) * 4 + GR() * 1.4, -14), new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 3, 0.3, 1.6, 2.6); });
    const shop = site.footprints.find((f) => f.x0 < -55 && f.z0 > 30);
    if (shop) counts.workshop = zone(8, 150, inBox(shop.x0 + 2, shop.x1 - 2, shop.z0 + 2, shop.z1 - 2, () => (GR() < 0.7 ? 1.3 : 5.5) + GR() * 1.2, 1.2));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('ao', new THREE.Float32BufferAttribute(aoA, 1)); g.setAttribute('bounce', new THREE.Float32BufferAttribute(boA, 3)); g.setAttribute('aY', new THREE.Float32BufferAttribute(ayA, 2)); g.setIndex(idx);
    const wallT = texOf.wall?.diff, wm = wallT ? texMean(wallT, null) : null;
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
    const m = weatherPatch(new THREE.MeshStandardMaterial({ map: atlas, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 0.85, metalness: 0 }),
      { kind: 'decal', w: MATS.wall.w, roughMin: 0.8, uniforms: { uWallTex: { value: wallT || white }, uWallRep: { value: 1 / MATS.wall.tile }, uWallMean: { value: wm ? Math.max(0.01, 0.2126 * wm[0] + 0.7152 * wm[1] + 0.0722 * wm[2]) : 1 } } }, uniforms);
    const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; mesh.renderOrder = 2; scene.add(mesh);
    bStats.graffiti = { pieces: placed.length, ...counts };
  }

  // [B] grass: photographed clumps (Poly Haven grass_medium_01: 9 sub-rects of its clump strip) on trapezoid cross
  // cards, one tuft per world-anchored base cell (no swimming), straw-to-green by low-frequency noise.
  // Perf (pixel-identical): cells are stored in rings around the camera cell, so the draw is front-to-back from every
  // heading; instanceCount stops at the fade radius; the vertex shader drops tufts outside the 4 side frustum planes.
  // A load-time mask replaces the per-vertex footprint/path loops. Altitude: hashes come from the integer base-cell
  // index, so level-2 tufts are exactly a subset of level-1 tufts; the others shrink away before the switch, width and
  // radius change continuously, and the field fades out above ~30 m AGL (the ground shader carries it from there).
  const gN = { low: 120, auto: 170, high: 220 }[quality] || 170, gCell = 0.45, baseR = gN * gCell * 0.5;
  const GRECTS = [[205, 765, 345, 898], [335, 765, 478, 898], [598, 772, 722, 872], [712, 772, 842, 872], [28, 888, 206, 998], [238, 905, 378, 999], [365, 905, 508, 999], [588, 882, 705, 1020], [695, 882, 812, 1020]];
  const gtx = texOf.grass || {}, atlasOK = !!(gtx.diff && gtx.alpha);
  const grassU = { uOrigin: { value: new THREE.Vector2() }, uCam: { value: new THREE.Vector3() }, uCell: { value: gCell }, uCell0: { value: gCell }, uR: { value: baseR },
    uWide: { value: 1 }, uOddK: { value: 1 }, uFade: { value: 1 }, uFr: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 0, 1e6)) },
    uRects: { value: GRECTS.map(([x0, y0, x1, y1]) => (atlasOK ? new THREE.Vector4(x0 / 1024, 1 - y1 / 1024, (x1 - x0) / 1024, (y1 - y0) / 1024) : new THREE.Vector4(0, 0, 1, 1))) }, ...maskU };
  let grass, ringR = null;
  {
    const card = new THREE.InstancedBufferGeometry();
    const P = [], UV = [], N = [], I = [], bw = 0.72;                      // trapezoid: base 0.72 x the top width
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI / 3 + 0.2, cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5, b = P.length / 3;
      P.push(-cx * bw, 0, -cz * bw, cx * bw, 0, cz * bw, cx, 1, cz, -cx, 1, -cz); UV.push(0.5 - bw / 2, 0, 0.5 + bw / 2, 0, 1, 1, 0, 1); N.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      I.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    card.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); card.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    card.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); card.setIndex(I);
    card.setAttribute('ao', new THREE.Float32BufferAttribute(new Array(12).fill(1), 1));
    const order = []; for (let i = 0; i < gN; i++) for (let j = 0; j < gN; j++) order.push([i, j, Math.hypot(i - gN / 2, j - gN / 2)]);
    order.sort((a, b) => a[2] - b[2]);
    const cells = new Float32Array(gN * gN * 2); ringR = new Float32Array(order.length);
    order.forEach(([i, j, r], k) => { cells[k * 2] = i; cells[k * 2 + 1] = j; ringR[k] = r; });
    card.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    card.instanceCount = gN * gN;
    const gm = new THREE.MeshStandardMaterial({ map: atlasOK ? gtx.diff : grassTexture(rng(1501)), alphaMap: atlasOK ? gtx.alpha : null, alphaTest: 0.38, alphaToCoverage: true,
      side: THREE.DoubleSide, roughness: 0.92, metalness: 0, color: atlasOK ? lin3(MATS.grass.color) : new THREE.Color(1, 1, 1) });
    if (atlasOK) [gtx.diff, gtx.alpha].forEach((t) => { t.repeat.set(1, 1); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; });
    weatherPatch(gm, { kind: 'grass', aoExpr: 'gAO', uniforms: grassU,
      vsHead: `attribute vec2 aCell;
uniform vec2 uOrigin; uniform vec3 uCam; uniform float uCell; uniform float uCell0; uniform float uR; uniform float uWide; uniform float uOddK; uniform float uFade;
uniform vec4 uRects[9]; uniform vec4 uFr[4];
uniform sampler2D uMask; uniform vec2 uMaskO; uniform float uMaskS;
varying vec3 vTint; varying float vDry;
float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gvn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(gh(i), gh(i + vec2(1, 0)), f.x), mix(gh(i + vec2(0, 1)), gh(i + vec2(1, 1)), f.x), f.y); }
float terrH(vec2 p){ float x = p.x, z = p.y; float d = max(max(abs(x + 5.0) - 95.0, abs(z - 10.0) - 85.0), 0.0);
  float n = sin(x * 0.021) * cos(z * 0.017) * 1.2 + sin(x * 0.053 + z * 0.041) * 0.45 + sin(z * 0.11 - x * 0.07) * 0.15;
  float ramp = min(1.0, d / 40.0); return n * ramp + min(d, 180.0) * 0.012 * ramp - 0.05 * (1.0 - ramp); }`,
      vsBegin: `
  vec2 bi = floor((uOrigin + aCell * uCell) / uCell0 + 0.5);            // integer base-cell index: same tuft at every level
  vec2 bp = bi * uCell0 + (vec2(gh(bi), gh(bi + 17.3)) - 0.5) * uCell0 * 0.95;
  vec4 mk = textureLod(uMask, (bp - uMaskO) / uMaskS, 0.0);
  float r1 = gh(bi + 7.7), r2 = gh(bi + 3.3), r3 = gh(bi + 11.1), r4 = gh(bi + 23.9), r5 = gh(bi + 5.5);
  float member = step(mod(bi.x, 2.0) + mod(bi.y, 2.0), 0.5);
  float keep = (1.0 - smoothstep(uR * 0.7, uR, distance(bp, uCam.xz))) * step(r5, mk.r) * mix(uOddK, 1.0, member) * uFade;
  vec4 rc = uRects[int(r4 * 8.999)];
  float hh = (0.3 + 0.75 * pow(r1, 1.3)) * (0.45 + 1.1 * mk.a) * keep;
  float wd = hh * (rc.z / rc.w) * (0.85 + 0.3 * r2) * uWide;
  vec3 gbase = vec3(bp.x, terrH(bp) - 0.04, bp.y);
  vec3 gc = gbase + vec3(0.0, hh * 0.5, 0.0); float grad = 0.62 * wd + 0.5 * hh + 0.12;
  bool cull = keep < 0.002;
  for (int i = 0; i < 4; i++) cull = cull || dot(uFr[i].xyz, gc) + uFr[i].w < -grad;
  if (cull) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float ang = r3 * 6.2832, ca = cos(ang), sa = sin(ang);
  vec3 lp = vec3(position.x * wd, position.y * hh, position.z * wd);
  lp = vec3(ca * lp.x - sa * lp.z, lp.y, sa * lp.x + ca * lp.z);
  float sway = sin(uTime * 1.9 + bp.x * 0.31 + bp.y * 0.23) + 0.4 * sin(uTime * 4.3 + bp.x * 1.7);
  lp.x += sway * 0.06 * lp.y; lp.z += sway * 0.035 * lp.y;
  transformed = lp + gbase;
  #ifdef USE_MAP
  vMapUv = rc.xy + uv * rc.zw;
  #endif
  #ifdef USE_ALPHAMAP
  vAlphaMapUv = rc.xy + uv * rc.zw;
  #endif
  vDry = smoothstep(0.3, 0.68, gvn(bp * 0.035 + 3.0) * 0.65 + gvn(bp * 0.21) * 0.35) * (0.5 + 0.5 * r2);
  vTint = vec3(0.9 + r2 * 0.22, 0.93 + r1 * 0.16, 0.8 + r3 * 0.25);
  float gAO = mix(0.42, 1.0, uv.y) * (0.3 + 0.7 * mk.b);`,
      fsHead: 'varying vec3 vTint; varying float vDry;',
      fsMap: `
  diffuseColor.rgb = mix(diffuseColor.rgb, lum3(diffuseColor.rgb) * vec3(1.55, 1.22, 0.6), vDry) * vTint;`,
      fsAlpha: `
  #ifdef USE_MAP
  { vec2 tx = vMapUv * 1024.0; diffuseColor.a *= 1.0 + 0.3 * max(0.0, 0.5 * log2(max(dot(dFdx(tx), dFdx(tx)), dot(dFdy(tx), dFdy(tx))))); }
  #endif` }, uniforms);
    grass = new THREE.Mesh(card, gm); grass.frustumCulled = false; grass.receiveShadow = true; grass.renderOrder = 1; scene.add(grass);
    const fr = new THREE.Frustum(), pm = new THREE.Matrix4();
    grass.onBeforeRender = (r, s, cam) => {
      pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); fr.setFromProjectionMatrix(pm);
      for (let i = 0; i < 4; i++) { const p = fr.planes[i]; grassU.uFr.value[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant); }
    };
  }
  const ringCount = (r) => { let lo = 0, hi = ringR.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ringR[m] <= r) lo = m + 1; else hi = m; } return lo; };
  // [B] trees, wall thickets, field shrubs and saplings on slab edges: one merged mesh of leaf-card balls with the
  // photographed leaves. Normals point out of the whole crown (it shades as one mass, both card faces alike);
  // light is baked per plant with the same probe as the buildings, so nothing glows under the silo table.
  const foliageStats = bStats.foliage = {};
  {
    const FR = rng(1301), lt = texOf.leaf || {}, UPV = new THREE.Vector3(0, 1, 0), fray = new THREE.Ray();
    const leafOK = !!(lt.diff && lt.alpha), leafMap = leafOK ? leafCluster(lt.diff, lt.alpha, FR) : leafTexture(FR);
    const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const tpl = [];
    for (let k = 0; k < 9; k++) {
      const qq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(FR() - 0.5, FR() - 0.5, FR() - 0.5).normalize(), FR() * Math.PI);
      tpl.push([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => ({ p: new THREE.Vector3(u * 0.6, v * 0.6, 0).applyQuaternion(qq), uv: [(u + 1) / 2, (v + 1) / 2] })));
    }
    const P = [], N = [], UV = [], C = [], AO = [], BO = [], SW = [], I = [];
    const q = new THREE.Quaternion(), eu = new THREE.Euler(), v = new THREE.Vector3(), n = new THREE.Vector3(), d = new THREE.Vector3();
    const ball = (c, s, cc, rad, pr, tint, swayK, baseY) => {
      eu.set(FR() * 6.28, FR() * 6.28, FR() * 6.28); q.setFromEuler(eu); const sy = s * (0.8 + FR() * 0.35);
      for (const quad of tpl) {
        const b = P.length / 3;
        for (const { p, uv } of quad) {
          v.copy(p).applyQuaternion(q); v.set(v.x * s, v.y * sy, v.z * s).add(c);
          d.copy(v).sub(cc); const dl = d.length() / rad; d.normalize();
          n.copy(v).sub(c).normalize().lerp(d, 0.7); n.y += 0.25; n.normalize();
          const occ = 0.42 + 0.58 * sm(0.1, 1.0, dl * 0.7 + (d.y * 0.5 + 0.5) * 0.4);
          P.push(v.x, v.y, v.z); N.push(n.x, n.y, n.z); UV.push(uv[0], uv[1]); C.push(tint[0], tint[1], tint[2]);
          AO.push(pr.ao * occ); BO.push(pr.bo.x * occ, pr.bo.y * occ, pr.bo.z * occ); SW.push(Math.max(0, v.y - baseY) * swayK);
        }
        I.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
    };
    const probe = (p) => { const vis = lightProbe(bvh, p, UPV, 18, 4); return { vis, ao: aoCurve(vis), bo: LP.out.clone() }; };
    const tintOf = () => (FR() < 0.12 ? [1.25, 1.12, 0.62] : [0.85 + FR() * 0.3, 0.9 + FR() * 0.2, 0.8 + FR() * 0.3]);
    const clear = (x, y, z) => { let m = 6; for (let k = 0; k < 6; k++) { const a = k * 1.047; fray.origin.set(x, y, z); fray.direction.set(Math.cos(a), 0, Math.sin(a)); const h = bvh.raycastFirst(fray, THREE.DoubleSide, 0, 6); if (h) m = Math.min(m, h.distance); } return m; };
    const shrub = (x, z, s, nb, swayK) => {
      const y = terrainHeight(x, z), cl = clear(x, y + 0.6 * s, z); if (cl < 0.35) return false;
      s = Math.min(s, (cl + 0.3) / 0.6);
      const pr = probe(new THREE.Vector3(x, y + s, z)); if (pr.vis < 0.3) return false;       // no light, no growth
      const cc = new THREE.Vector3(x, y + s * 0.55, z), tint = tintOf();
      for (let b = 0; b < nb; b++) ball(new THREE.Vector3(x + (FR() - 0.5) * s * 0.9, y + s * (0.3 + FR() * 0.5), z + (FR() - 0.5) * s * 0.9), s * (0.65 + FR() * 0.4), cc, s * 1.2, pr, tint, swayK, y);
      return true;
    };
    // trees: 7-13 balls in an irregular crown from ~0.3 h up, ~1.3x taller than wide
    for (const t of treeSpots) {
      const cc = new THREE.Vector3(t.x + (FR() - 0.5) * 0.8, t.y + t.h * 0.64, t.z + (FR() - 0.5) * 0.8), rx = t.h * (0.24 + FR() * 0.1), ry = t.h * 0.33;
      const pr = probe(cc.clone().addScaledVector(UPV, ry * 0.6)), tint = tintOf();
      for (let b = 0, nb = 7 + Math.floor(FR() * 7); b < nb; b++) {
        const th = FR() * 6.283, cp = FR() * 2 - 1, sp = Math.sqrt(1 - cp * cp), r = 0.45 + 0.55 * FR();
        ball(new THREE.Vector3(cc.x + Math.cos(th) * sp * rx * r, cc.y + cp * ry * r, cc.z + Math.sin(th) * sp * rx * r), t.h * (0.2 + FR() * 0.12), cc, Math.max(rx, ry), pr, tint, 0.012, t.y + t.h * 0.3);
      }
    }
    // thickets hugging the walls: runs that come and go along every side of every footprint
    let nBush = 0, nField = 0, nSap = 0;
    for (const f of site.footprints) {
      if ((f.x1 - f.x0) * (f.z1 - f.z0) < 20) continue;
      for (let side = 0; side < 4; side++) {
        const len = side < 2 ? f.x1 - f.x0 : f.z1 - f.z0; let on = FR() < 0.5;
        for (let t = FR() * 2; t < len; t += 1.2 + FR() * 1.4) {
          if (FR() < 0.22) on = !on; if (!on) continue;
          const o = -0.6 + FR() * 2.2, x = side < 2 ? f.x0 + t : side === 2 ? f.x0 - o : f.x1 + o, z = side < 2 ? (side === 0 ? f.z0 - o : f.z1 + o) : f.z0 + t;
          if (distToPaths(x, z) < 3.2) continue;
          if (shrub(x, z, 0.8 + FR() * 1.5, 2 + Math.floor(FR() * 3), 0.03)) nBush++;
        }
      }
    }
    const outside = (x, z, m) => !site.footprints.some((f) => x > f.x0 - m && x < f.x1 + m && z > f.z0 - m && z < f.z1 + m);
    for (let k = 0; k < 90; k++) {
      const x = -125 + FR() * 240, z = -100 + FR() * 225;
      if (!outside(x, z, 3) || distToPaths(x, z) < 4 || Math.hypot(x, z - 118) < 12) continue;
      if (shrub(x, z, 1.2 + FR() * 1.4, 3 + Math.floor(FR() * 3), 0.025)) nField++;
    }
    // saplings where slabs and roofs end (rain, a crack, a little soil)
    const bigF = site.footprints.filter((f) => (f.x1 - f.x0) * (f.z1 - f.z0) > 60);
    for (let k = 0; k < 300 && nSap < 30 && bigF.length; k++) {
      const f = bigF[Math.floor(FR() * bigF.length)], x = f.x0 + FR() * (f.x1 - f.x0), z = f.z0 + FR() * (f.z1 - f.z0);
      fray.origin.set(x, 90, z); fray.direction.set(0, -1, 0); const h = bvh.raycastFirst(fray, THREE.DoubleSide, 0, 120);
      if (!h || h.point.y < 3.5 || Math.abs(h.face.normal.y) < 0.9) continue;
      let edge = false;
      for (const [dx, dz] of [[1.1, 0], [-1.1, 0], [0, 1.1], [0, -1.1]]) { fray.origin.set(x + dx, h.point.y + 0.4, z + dz); if (!bvh.raycastFirst(fray, THREE.DoubleSide, 0, 1.5)) edge = true; }
      if (!edge) continue;
      const s = 0.45 + FR() * 0.8, base = h.point.clone(), cc = base.clone().addScaledVector(UPV, s * 0.5), pr = probe(cc.clone().addScaledVector(UPV, s * 0.5));
      for (let b = 0, nb = 1 + Math.floor(FR() * 2); b < nb; b++) ball(cc.clone().add(new THREE.Vector3((FR() - 0.5) * s * 0.6, FR() * s * 0.4, (FR() - 0.5) * s * 0.6)), s, cc, s, pr, tintOf(), 0.04, base.y);
      nSap++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); g.setAttribute('ao', new THREE.Float32BufferAttribute(AO, 1)); g.setAttribute('bounce', new THREE.Float32BufferAttribute(BO, 3));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(SW, 1)); g.setIndex(I); g.computeBoundingSphere();
    const lm = weatherPatch(new THREE.MeshStandardMaterial({ map: leafMap, alphaTest: 0.42, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.8, metalness: 0, vertexColors: true,
      color: leafOK ? lin3(MATS.leaf.color) : new THREE.Color(1, 1, 1) }), { kind: 'leaf', fsAlpha: `
  #ifdef USE_MAP
  { vec2 tx = vMapUv * 512.0; diffuseColor.a *= 1.0 + 0.3 * max(0.0, 0.5 * log2(max(dot(dFdx(tx), dFdx(tx)), dot(dFdy(tx), dFdy(tx))))); }
  #endif` }, uniforms);
    const mesh = new THREE.Mesh(g, lm); mesh.castShadow = true; mesh.receiveShadow = true; mesh.renderOrder = 1; scene.add(mesh);
    Object.assign(foliageStats, { trees: treeSpots.length, thickets: nBush, shrubs: nField, saplings: nSap, cards: I.length / 6 });
  }

  // [B] distant treeline ring: instanced low-poly crowns in 6 sectors (frustum-culled), fogged by the scene fog,
  // shrinking into the ground before the camera's 300 m far plane so no crown is ever cut in half
  {
    const crown = crownGeometry(), SEC = 6, by = Array.from({ length: SEC }, () => []), UPV = new THREE.Vector3(0, 1, 0);
    for (const t of treeline) { const a = (Math.atan2(t.z - 10, t.x + 5) / (2 * Math.PI) + 1) % 1; by[Math.min(SEC - 1, Math.floor(a * SEC))].push(t); }
    const tm = weatherPatch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }), { kind: 'treeline', aoExpr: 'gAO',
      vsBegin: `
  vec3 ipos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float shr = 1.0 - smoothstep(245.0, 282.0, distance(ipos.xz, cameraPosition.xz));
  transformed.y *= shr; transformed.xz *= mix(0.4, 1.0, shr);
  float gAO = mix(0.32, 1.0, smoothstep(0.0, 0.85, position.y)) * (0.8 + 0.2 * normal.y);`,
      fsMap: `
  diffuseColor.rgb *= 0.6 + 0.65 * vn(vWPos.xz * 0.55 + vWPos.y * 0.7) * (0.55 + 0.45 * vn(vec2(vWPos.x + vWPos.z, vWPos.y) * 1.9));` }, uniforms);
    const M = new THREE.Matrix4(), qq = new THREE.Quaternion(), col = new THREE.Color(), P = new THREE.Vector3(), S = new THREE.Vector3();
    const greens = [[0.034, 0.052, 0.018], [0.05, 0.062, 0.026], [0.026, 0.038, 0.02], [0.062, 0.07, 0.03]];
    for (const list of by) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(crown, tm, list.length);
      list.forEach((t, i) => {
        qq.setFromAxisAngle(UPV, t.rot); M.compose(P.set(t.x, t.y, t.z), qq, S.set(t.w, t.h, t.d)); im.setMatrixAt(i, M);
        const gc = greens[Math.min(3, Math.floor(t.tint * 4))], k = 0.85 + t.tint * 0.3; col.setRGB(gc[0] * k, gc[1] * k, gc[2] * k); im.setColorAt(i, col);
      });
      im.computeBoundingSphere(); im.castShadow = false; im.receiveShadow = false; im.renderOrder = 1; scene.add(im);
    }
    foliageStats.treeline = treeline.length;
  }

  // sun with shadows that follow the drone
  const sun = new THREE.DirectionalLight(sk.sunColor, sunI);
  scene.environmentIntensity = envI;
  sun.castShadow = true;
  const sm = quality === 'low' ? 1024 : 2048; sun.shadow.mapSize.set(sm, sm);
  const ext = 55; Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 400 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05; sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun); scene.add(sun.target);
  const texel = (2 * ext) / sm;
  const sunDir = sk.sunDir.clone(); if (sunDir.y < 0.12) { sunDir.y = 0.12; sunDir.normalize(); }
  const lightBasisX = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize(), lightBasisY = new THREE.Vector3().crossVectors(sunDir, lightBasisX);
  let grassLevel = 1;
  const update = (camPos, dt) => {
    uniforms.uTime.value += dt;
    // [B] grass LOD: level 2 (2x cells) is a subset of level 1; non-members shrink away between 8 and 11 m AGL,
    // the switch happens at 14 m (back at 11), width/radius change continuously, the field fades out at 24-32 m
    grassU.uCam.value.copy(camPos);
    const alt = camPos.y - terrainHeight(camPos.x, camPos.z), sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    if (grassLevel === 1 && alt > 14) grassLevel = 2; else if (grassLevel === 2 && alt < 11) grassLevel = 1;
    const cell = gCell * grassLevel;
    grassU.uCell.value = cell; grassU.uOddK.value = 1 - sm(8, 11, alt); grassU.uWide.value = 1 + 0.45 * sm(8, 26, alt); grassU.uFade.value = 1 - sm(24, 32, alt);
    grassU.uR.value = Math.min(baseR * (1 + sm(14, 30, alt)), gN * cell * 0.5);
    grassU.uOrigin.value.set(Math.floor(camPos.x / cell) * cell - (gN / 2) * cell, Math.floor(camPos.z / cell) * cell - (gN / 2) * cell);
    grass.visible = alt < 32.5;
    grass.geometry.instanceCount = Math.min(gN * gN, ringCount(grassU.uR.value / cell + 2.2));
    // snap the shadow frustum to texels so edges don't crawl
    const ax = Math.round(camPos.dot(lightBasisX) / texel) * texel, ay = Math.round(camPos.dot(lightBasisY) / texel) * texel, az = camPos.dot(sunDir);
    const c = lightBasisX.clone().multiplyScalar(ax).addScaledVector(lightBasisY, ay).addScaledVector(sunDir, az);
    sun.target.position.copy(c); sun.position.copy(c).addScaledVector(sunDir, 200);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
  };
  update(new THREE.Vector3(0, 0, 100), 0);

  // depth for the shutter blur = the solid geometry
  const colScene = new THREE.Scene();
  const cm = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial()); cm.frustumCulled = false; colScene.add(cm);
  prog(0.98, 'Ready');
  return {
    scene, colliderScene: colScene, bvh, update, hdr: true, stats: bStats,
    spawn: new THREE.Vector3(0, terrainHeight(0, 118) + 1.4, 118), yaw: 0,
    bounds: new THREE.Box3(new THREE.Vector3(-480, -5, -480), new THREE.Vector3(480, 260, 480)),
    envelope: { min: new THREE.Vector3(-440, -2, -440), max: new THREE.Vector3(440, 220, 440) },
  };
}
