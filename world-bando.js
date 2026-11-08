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
  // [A2] sunDir is in the HDR's own frame. rotY (rad) turns the whole sky about +Y (scene.backgroundRotation and
  // environmentRotation), so the world sun is sunDir rotated by rotY: always use skySunDir(def). 0.87 puts 9 of the 13
  // lines side-lit and the spawn sun 74 deg front-right (was 4/13, spawn 124 deg = front-lit, no visible shadows).
  // bgI: background radiance scale (scene.backgroundIntensity; the fog colour gets the same factor so the horizon has
  // no seam). The photographed sky sits ~1 EV under our forced sun (sunI 10 vs the HDR's own 4.4), so sunny x2.0.
  // Overcast stays x1.0: under stream D's grade (clipEv 2.5, evBias +0.3) its cloud deck already clips 22.6% of the
  // spawn frame (ref 7.7-22%); x1.6 blew 37% (80% of the sky). disc: a 0.6 deg sun disc kept in the background at
  // this radiance (the energy over the clamp is carried by the DirectionalLight, so the env never sees it).
  sunny: { id: 'kloofendal_48d_partly_cloudy_puresky', label: 'Sunny', sunRatio: 7.5, sunDir: [0.5544, 0.7417, 0.3775], rotY: 0.87, bgI: 2.0, disc: 2000 },
  overcast: { id: 'overcast_soil_puresky', label: 'Overcast', sunRatio: 0, sunDir: [0.3813, 0.921, 0.0794], rotY: 0, bgI: 1.0, disc: 0 },
};
// [A2] world-space sun of a SKIES entry (three r180: a background/env rotation Euler(0, rotY, 0) samples the texture at
// R(-rotY) * worldDir, so a texture direction d shows at R(+rotY) * d). The bake, shadows, haze and exporters use this.
export function skySunDir(def) { return new THREE.Vector3(...def.sunDir).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), def.rotY || 0); }
// [A2] live shadow map: +-ext m, re-rendered only when its centre (the camera, no lead) moves a snapM light-space step.
// Lead 0 + 8 m snap: ~2-3 re-renders/s in carves instead of 13-20 (perf #1b). Exported for the frequency test.
export const LIVE_SHADOW = { ext: 52, snapM: 8, lead: 0, back: 150 };
// [B] surfaces. CC0 Poly Haven sets at 1k; `maps` = which maps are worth downloading.
// color = linear multiplier on the diffuse map (measured texture means, see report); w = weathering
// [streaks, base damp, up-facing grime, moss]; wx = [streak columns per m, cylinder radius (0 = planar walls),
// soot strength, soot depth from the element top in m]; roughMin = roughness floor (kills the glossy blue sky rim).
// albedo = linear mean RGB of the final shaded material (texture x color x mean weathering): the light bake reads it.
// Concrete is warm-neutral (R/G 1.03, B/G 0.915): the camera white balance supplies the warmth, not the albedo.
const MATS = {
  silo: { id: 'concrete_layers_02', tile: 3.0, maps: ['diff', 'nor_gl'], color: [1.523, 1.555, 1.576], rough: 0.95, roughMin: 0.86, w: [0.85, 0.34, 0.5, 0.35], wx: [0.28, 4.2, 0, 8], albedo: [0.300, 0.290, 0.265] },
  wall: { id: 'concrete_wall_006', tile: 3.0, maps: ['diff', 'nor_gl'], color: [2.885, 3.642, 4.584], rough: 0.95, roughMin: 0.86, w: [0.45, 0.36, 0.55, 0.3], albedo: [0.290, 0.2815, 0.2576] },
  slab: { id: 'concrete_floor_02', tile: 4.0, maps: ['diff', 'nor_gl'], color: [1.663, 1.939, 2.788], rough: 0.95, roughMin: 0.88, w: [0.35, 0.3, 0.6, 0.45], albedo: [0.280, 0.272, 0.249] },
  // chimney coping (art r3 #4): the same brick under a lime wash, x1.5 and toward neutral; radial headers (polar UVs)
  coping: { id: 'factory_brick', tile: 2.2, maps: ['diff', 'nor_gl'], color: [1.54, 1.8, 2.67], rough: 0.92, roughMin: 0.82, w: [0.3, 0.0, 0.3, 0.15], albedo: [0.352, 0.261, 0.243] },
  // brick: less pink (art #7), streakier, the top 8 m sooted (x0.55 at the rim)
  brick: { id: 'factory_brick', tile: 2.2, maps: ['diff', 'nor_gl'], color: [1.08, 1.0, 1.55], rough: 0.9, roughMin: 0.8, w: [0.6, 0.3, 0.4, 0.2], wx: [1.7, 0, 0.45, 8], albedo: [0.247, 0.145, 0.141] },
  rust: { id: 'rust_coarse_01', tile: 2.0, maps: ['diff'], color: [2.05, 3.2, 6.53], rough: 0.82, roughMin: 0.7, w: [0.25, 0.2, 0.35, 0.1], albedo: [0.245, 0.128, 0.089] },
  // ground and track: greener, darker, less chromatic (decision 3 / graphics #2: reference ground L39 C6)
  ground: { id: 'grass_ground', tile: 4.0, maps: ['diff'], color: [1.05, 1.3, 2.0], rough: 1, kind: 'ground', albedo: [0.128, 0.128, 0.068] },
  bark: { id: 'bark_brown_02', tile: 1.5, maps: ['diff'], color: [1.1, 1.1, 1.1], rough: 0.95, kind: 'bark', albedo: [0.136, 0.111, 0.066] },
  path: { id: 'grass_path_2', tile: 3.5, maps: ['diff'], color: [0.31, 0.345, 0.48], rough: 1, kind: 'track', albedo: [0.088, 0.080, 0.066] },
  // not merged-geometry materials: the paved apron is sampled inside the ground shader; grass and leaves are atlases
  apron: { id: 'asphalt_02', tile: 5.0, maps: ['diff'], color: [1.75, 1.72, 1.72], kind: 'aux', albedo: [0.176, 0.170, 0.152], radius: 9 },   // radius: mean paved reach around footprints (5-12 m)
  // grass: graphics #2's darker multiplier, then desaturated ~30 % toward its own luminance (Lab C 26-31 -> ~21 at
  // the same HSV hue; a bluer multiplier alone would push the foliage hue past 70)
  grass: { model: 'grass_medium_01', tile: 1, maps: ['diff', 'alpha'], color: [1.1, 1.1, 1.86], kind: 'aux', albedo: [0.112, 0.109, 0.052] },
  leaf: { model: 'tree_small_02', tile: 1, maps: ['leaves_diff', 'leaves_alpha'], color: [1.4, 1.3, 1.5], kind: 'aux', albedo: [0.099, 0.124, 0.035] },
};
// [B] treeline crowns get low-poly collision proxies (15.6k tris, appended after the terrain in the collider).
// They cost ~7% of A's light-bake time (terrain-edge rays hit them); false = fly-through treeline, cheaper bake.
const RING_COLLIDE = true;
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
function cylGeo(rTop, rBot, h, seg, open, hseg = Math.max(1, Math.round(h / 2.5))) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, hseg, open);
  const uv = g.attributes.uv, p = g.attributes.position, r = (rTop + rBot) / 2, side = (seg + 1) * (hseg + 1);
  // [B] the side wraps in metres; the caps (generated after the side) get planar metres in local XZ, not stripes
  for (let i = 0; i < uv.count; i++) if (i < side) uv.setXY(i, uv.getX(i) * 2 * Math.PI * r, p.getY(i)); else uv.setXY(i, p.getX(i), p.getZ(i));
  g.userData.cylR = r; g.userData.cylSide = side;   // Site.add snaps the side's wrap to whole texture tiles and offsets each cylinder
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
      const uv = g.attributes.uv, side = g.userData.cylSide ?? uv.count;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (i < side ? k : 1) + ou, uv.getY(i) + ov);
      delete g.userData.cylR; delete g.userData.cylSide;
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

// tapered hollow tube (chimney): outer + inner skins, jambs around skipped cells, top rim.
// hseg: a row count (even rows) or the row boundaries [0, ..., h] (fine rows where the light changes fast)
function tubeGeo(rb, rt, h, th, seg, hseg, skip) {
  const pos = [], nor = [], uv = [], idx = [];
  const ys = Array.isArray(hseg) ? hseg : Array.from({ length: hseg + 1 }, (_, j) => (j / hseg) * h);
  hseg = ys.length - 1;
  const R = (y, inner) => (rb + (rt - rb) * (y / h)) - (inner ? th : 0);
  const keep = [];
  for (let j = 0; j < hseg; j++) { keep[j] = []; for (let i = 0; i < seg; i++) { const a = ((i + 0.5) / seg) * Math.PI * 2, y = (ys[j] + ys[j + 1]) / 2; keep[j][i] = !skip(a, y); } }
  const vtx = (a, y, inner, nx, ny, nz, u, v) => { const r = R(y, inner); pos.push(Math.sin(a) * r, y, Math.cos(a) * r); nor.push(nx, ny, nz); uv.push(u, v); return pos.length / 3 - 1; };
  for (const inner of [false, true]) {
    for (let j = 0; j < hseg; j++) for (let i = 0; i < seg; i++) {
      if (!keep[j][i]) continue;
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, y0 = ys[j], y1 = ys[j + 1];
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
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, y0 = ys[j], y1 = ys[j + 1];
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
// a closed flat ring (annulus with thickness) around the y axis: outer + inner skins, top + bottom faces, each with
// its own vertices (hard edges). Coping, corbel courses, silo parapets.
// polar: the top face gets polar UVs in metres, u = radial (r - rIn), v = arc at the mean radius stretched to a whole
// number of `polar` m tiles (no seam): a brick texture's courses then run radially (headers laid across the rim)
function ringGeo(rIn, rOut, y0, y1, seg, polar = 0) {
  const pos = [], nor = [], uv = [], idx = [];
  const quad = (p, n, uvs) => { const b = pos.length / 3; p.forEach((q, k) => { pos.push(...q); nor.push(...(typeof n === 'function' ? n(k) : n)); uv.push(...uvs[k]); }); idx.push(b, b + 1, b + 2, b, b + 2, b + 3); };
  const P = (a, r, y) => [Math.sin(a) * r, y, Math.cos(a) * r];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, A = [a0, a1, a1, a0];
    const uo = (a) => a * rOut, ui = (a) => a * rIn;
    quad([P(a0, rOut, y0), P(a1, rOut, y0), P(a1, rOut, y1), P(a0, rOut, y1)], (k) => [Math.sin(A[k]), 0, Math.cos(A[k])], [[uo(a0), y0], [uo(a1), y0], [uo(a1), y1], [uo(a0), y1]]);
    quad([P(a1, rIn, y0), P(a0, rIn, y0), P(a0, rIn, y1), P(a1, rIn, y1)], (k) => [-Math.sin([a1, a0, a0, a1][k]), 0, -Math.cos([a1, a0, a0, a1][k])], [[ui(a1), y0], [ui(a0), y0], [ui(a0), y1], [ui(a1), y1]]);
    const top = [P(a0, rIn, y1), P(a0, rOut, y1), P(a1, rOut, y1), P(a1, rIn, y1)], bot = [P(a1, rIn, y0), P(a1, rOut, y0), P(a0, rOut, y0), P(a0, rIn, y0)];
    if (polar) {
      const rm = (rIn + rOut) / 2, k = Math.max(1, Math.round((2 * Math.PI * rm) / polar)) * polar / (2 * Math.PI);
      quad(top, [0, 1, 0], [[0, a0 * k], [rOut - rIn, a0 * k], [rOut - rIn, a1 * k], [0, a1 * k]]);
    } else quad(top, [0, 1, 0], top.map((q) => [q[0], q[2]]));
    quad(bot, [0, -1, 0], bot.map((q) => [q[0], q[2]]));
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

// per-subsystem RNG streams: a draw added in one part of the site never reshuffles another part
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const subRng = (seed, name) => rng((hashStr(name) ^ Math.imul(seed | 0, 0x9E3779B1)) >>> 0);
const Y_UP = new THREE.Vector3(0, 1, 0);

// ---- layout. -z is north (silos, chimney), +z south (the hall, the spawn). The site is shaped around its named
// lines (see buildLines): chimney door -> pipe rack -> hall window is one straight line, the stair shaft is open
// top to bottom, the silo row has one 1.6 m gap lined up with the stair tower's openings.
// gaps 1.0 / 1.6 / 1.0 m. top = roof slab of the open north row; rim = its parapet (top at top + recess)
const SILO = { x: [-48.3, -38.9, -28.9, -19.5], z: [-22, -6], r: 4.2, table: 5.2, top: 32, rim: { band: 0.4, lip: 0.12, wall: 0.3, recess: 0.3 } };
const TOWER = { x: -33.9, z: -14, w: 4.4, T: 0.3 };
const SHAFT = { x0: TOWER.x - 2.05, x1: TOWER.x + 2.05, z0: TOWER.z - 2.05, z1: TOWER.z + 2.05 };   // inner faces
const HEAD = { x0: -54, x1: -14, z0: -17.8, z1: 0 };    // head house over the south row: the north row's caps stay open
// in line with the north row: mouth beside the caps. base: plinth top; cop / corb: coping and corbel course heights
const CHIM = { x: -8, z: -22, h: 50, rb: 3.4, rt: 2.0, th: 0.35, base: 0.5, cop: 0.45, corb: 0.25 };
const HALL = { x0: 6, x1: 70, z0: 14, z1: 36, fh: 5, levels: 3, cols: 11, rows: 5 };
const GAL = { A: [-14.3, 33.4, -6.5], B: [12.5, 15.35, 24.5], W: 3.0, H: 2.6 };
const STACK = [HALL.x0 + 1.5 * (HALL.x1 - HALL.x0) / (HALL.cols - 1), HALL.z0 + 0.5 * (HALL.z1 - HALL.z0) / (HALL.rows - 1)];   // the hall's stacked holes (FORCE 0:1:0 / 1:1:0 / 2:1:0): axis x, z
const ENTRY = [13.9, 14];       // hall window (north facade, bay 1) the chimney door + rack aim through, threading the columns
const DOOR = (() => { const x = ENTRY[0] - CHIM.x, z = ENTRY[1] - CHIM.z, l = Math.hypot(x, z); return [x / l, z / l]; })();
const RACK = { K: [CHIM.x + DOOR[0] * 6, CHIM.z + DOOR[1] * 6], H: [ENTRY[0] - DOOR[0] * 2.5, ENTRY[1] - DOOR[1] * 2.5] };
// bays the lines need, whatever the RNG says. Slab key `L:i:j` (slab over storey L; 2 = roof); facade key `fL:z0|z1:i`
const FORCE = {
  '0:1:0': 'hole', '1:1:0': 'hole', '2:1:0': 'slot',                              // TRIPLE POP / DROP behind the entry window
  '2:0:1': 'solid', '2:1:1': 'solid', '2:0:2': 'solid', '2:1:2': 'solid',          // the roof the gallery lands on
  'f0:z0:1': 'open', 'f0:z0:3': 'open', 'f0:z1:3': 'open',                         // rack entry; STRAIGHT THROUGH
};

// a horizontal slab (x0..x1, z0..z1, bottom y, thickness t) with rectangular holes [{x0, x1, z0, z1}]
function slabWithHoles(S, mat, x0, x1, z0, z1, y, t, holes) {
  const xs = new Set([x0, x1]); holes.forEach((h) => { xs.add(Math.max(x0, Math.min(x1, h.x0))); xs.add(Math.max(x0, Math.min(x1, h.x1))); });
  const cuts = [...xs].sort((a, b) => a - b);
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1]; if (b - a < 0.01) continue;
    const mid = (a + b) / 2; let zs = [[z0, z1]];
    for (const h of holes) {
      if (h.x0 > mid || h.x1 < mid) continue;
      zs = zs.flatMap(([p, q]) => (h.z1 <= p || h.z0 >= q ? [[p, q]] : [[p, Math.max(p, h.z0)], [Math.min(q, h.z1), q]].filter(([u, v]) => v - u > 0.01)));
    }
    for (const [p, q] of zs) S.box(mat, mid, y, (p + q) / 2, b - a, t, q - p);
  }
}
// a parapet / coping run along x or z: 1.5-6 m pieces, tops knocked down 0-0.6 m, ~10% of it missing
function brokenRun(S, R, mat, ax, az, bx, bz, y, H, T) {
  const alongX = Math.abs(bx - ax) >= Math.abs(bz - az), L = alongX ? bx - ax : bz - az;
  let s = 0;
  while (s < L - 0.05) {
    const len = Math.min(L - s, 1.5 + R() * 4.5), r = R();
    if (r < 0.1 && s > 0 && L - s > 2.5) { s += 0.6 + R() * 1.0; continue; }
    const h = Math.max(0.25, H - (r < 0.55 ? R() * 0.6 : 0)), c = s + len / 2;
    if (alongX) S.box(mat, ax + c, y, az, len, h, T); else S.box(mat, ax, y, az + c, T, h, len);
    s += len;
  }
}
// a placement matrix whose local +x runs along d (right-handed, local +y as close to world up as it can be)
function alongM(d, px, py, pz) {
  const side = new THREE.Vector3().crossVectors(d, Y_UP).normalize(), up = new THREE.Vector3().crossVectors(side, d);
  return new THREE.Matrix4().makeBasis(d, up, side).setPosition(px, py, pz);
}
// 3.5 cm rebar sticking out of a broken slab edge (a->b) into the hole (inward nx, nz), drooping
function rebar(S, R, ax, az, bx, bz, y, nx, nz, count, maxLen) {
  for (let k = 0; k < count; k++) {
    const t = 0.08 + R() * 0.84, px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
    const len = 0.22 + R() * (maxLen - 0.22), droop = 0.12 + R() * 0.7, yaw = (R() - 0.5) * 0.6, c = Math.cos(yaw), s = Math.sin(yaw);
    const d = new THREE.Vector3((nx * c - nz * s) * Math.cos(droop), -Math.sin(droop), (nx * s + nz * c) * Math.cos(droop));
    const g = new THREE.CylinderGeometry(0.02, 0.02, len + 0.15, 3, 1, true);   // 8 verts: cheap to bake
    g.translate(0, (len + 0.15) / 2, 0); g.applyQuaternion(_rq.setFromUnitVectors(Y_UP, d)); g.translate(px - nx * 0.15, y + (R() - 0.5) * 0.14, pz - nz * 0.15);
    S.add('rust', g);
  }
}
const _rq = new THREE.Quaternion();
// a long member with few vertices along it (beams in shadow need no 3 m bake resolution)
function lowBox(S, mat, cx, y0, cz, sx, sy, sz) {
  const g = new THREE.BoxGeometry(sx, sy, sz, Math.max(1, Math.round(sx / 6.5)), 1, Math.max(1, Math.round(sz / 6.5)));
  planarUV(g, { x: cx * 0.37, y: y0 + sy / 2, z: cz * 0.53 }); g.translate(cx, y0 + sy / 2, cz); S.add(mat, g);
}
// a hinged slab fragment hanging from a hole edge
function hangingChunk(S, R, ax, az, bx, bz, y, nx, nz) {
  const t = 0.25 + R() * 0.5, px = ax + (bx - ax) * t, pz = az + (bz - az) * t, tilt = 0.4 + R() * 0.5, depth = 0.5 + R() * 0.5;
  const d = new THREE.Vector3(nx * Math.cos(tilt), -Math.sin(tilt), nz * Math.cos(tilt));
  S.beam('slab', alongM(d, px, y, pz), -0.05, depth, 0, 0, 0.26, 0.8 + R() * 0.8);
}
// jittered, squashed icosahedron: a broken lump of concrete
function rock(R, s, x, y, z) {
  const g = s > 0.55 ? new THREE.IcosahedronGeometry(s, 0) : new THREE.OctahedronGeometry(s, 0), p = g.attributes.position, jit = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let j = jit.get(key); if (!j) jit.set(key, (j = [1 + (R() - 0.5) * 0.5, 1 + (R() - 0.5) * 0.5, 1 + (R() - 0.5) * 0.5]));
    p.setXYZ(i, p.getX(i) * j[0], p.getY(i) * j[1] * 0.6, p.getZ(i) * j[2]);
  }
  g.rotateY(R() * 6.28); g.translate(x, y + s * 0.3, z); g.computeVertexNormals(); planarUV(g, { x: 0, y: 0, z: 0 });
  return g;
}
function rubblePile(S, R, cx, cy, cz, rad, n) {
  for (let k = 0; k < n; k++) {
    const s = 0.2 + Math.pow(R(), 1.6) * 0.6, x = cx + (R() + R() - 1) * rad, z = cz + (R() + R() - 1) * rad;
    if (R() < 0.4) S.add('slab', rock(R, s, x, cy, z));
    else S.box('slab', x, cy - s * 0.12, z, s * (1.2 + R()), s * (0.4 + R() * 0.4), s * (0.8 + R() * 0.6), R() * 3);
  }
}
// a steep industrial flight (waist slab + treads) from (a, y0) to (b, y1) in a band wd wide
function stairFlight(S, [ax, az], y0, [bx, bz], y1, wd) {
  const dx = bx - ax, dz = bz - az, run = Math.hypot(dx, dz), rise = y1 - y0, L = Math.hypot(run, rise);
  S.beam('slab', alongM(new THREE.Vector3(dx / L, rise / L, dz / L), ax, y0, az), 0, L, -0.1, 0, 0.14, wd);
  const n = Math.max(3, Math.round(rise / 0.6)), tl = (run / n) * 1.25;
  for (let i = 1; i < n; i++) { const t = i / n; S.box('slab', ax + dx * t, y0 + rise * t - 0.04, az + dz * t, dx ? tl : wd, 0.06, dz ? tl : wd); }
}

function buildSite(seed = 7) {
  const S = new Site();
  const rSpot = subRng(seed, 'spots'), rBay = subRng(seed, 'hall-bays'), rFac = subRng(seed, 'hall-facade'), rRub = subRng(seed, 'rubble'),
    rBlk = subRng(seed, 'blocks'), rDet = subRng(seed, 'detail');
  // ---- silo battery: 2 rows x 4 silos on a column table, stair tower between the rows, head house over the south row
  const { r: sr, table: tableTop, top: siloTop } = SILO;
  const inTower = (x, z, m) => Math.abs(x - TOWER.x) < TOWER.w / 2 + m && Math.abs(z - TOWER.z) < TOWER.w / 2 + m;
  S.footprints.push({ x0: -54.5, x1: -13.5, z0: -28.5, z1: 0.5 });
  slabWithHoles(S, 'slab', -54.5, -13.5, -28.5, 0.5, 4.6, 0.6, [SHAFT]);        // table slab, open over the stair shaft
  for (let x = -53; x <= -15.1; x += 4.75) for (let z = -27; z <= -0.9; z += 5.2) {
    if (inTower(x, z, 0.55)) continue;                                          // these stood inside the tower's walls
    S.box('wall', x, 0, z, 0.75, 4.6, 0.75);
    if (rSpot() < 0.12) S.spot(x, 1.6, z + 0.38, 0, 1, 0.75, 1.4);
  }
  // downstand beams under the table on the column lines (split around the stair shaft)
  for (let z = -27; z <= -0.9; z += 5.2) lowBox(S, 'wall', -34, 4.1, z, 40.6, 0.5, 0.4);
  for (let x = -53; x <= -15.1; x += 4.75) {
    if (Math.abs(x - TOWER.x) < TOWER.w / 2) { lowBox(S, 'wall', x, 4.1, -22.35, 0.4, 0.5, 11.9); lowBox(S, 'wall', x, 4.1, -5.65, 0.4, 0.5, 11.9); }
    else lowBox(S, 'wall', x, 4.1, -14, 0.4, 0.5, 28.6);
  }
  // north row (open beside the chimney mouth): the shell ends in a 0.4 m parapet band (0.3 m wall + a 0.12 m lip)
  // with the roof slab recessed 0.3 m inside it, so the tops read as thick concrete, not open tubes with lids
  const { band, lip, wall, recess } = SILO.rim;
  for (const x of SILO.x) for (const z of SILO.z) {
    const open = z <= HEAD.z0, y1 = open ? siloTop - (band - recess) : siloTop;   // south row: capped by the head-house floor
    const g = cylGeo(sr, sr, y1 - tableTop, 44, true); g.translate(x, (y1 + tableTop) / 2, z); S.add('silo', g);
    if (!open) continue;
    const rim = ringGeo(sr - wall, sr + lip, y1, y1 + band, 44); rim.translate(x, 0, z); S.add('silo', rim);
    const cap = new THREE.CircleGeometry(sr - wall, 44); cap.rotateX(-Math.PI / 2); planarUV(cap, { x, y: 0, z }); cap.translate(x, siloTop, z); S.add('slab', cap);
    S.box('slab', x + (rDet() - 0.5) * 3, siloTop, z - 1.2 - rDet() * 1.5, 1.1, 0.35, 1.1, rDet() * 1.5);   // filling hatch
  }
  // stair tower between the rows: open shaft top to bottom, ring landings, steep flights, an opening each storey
  {
    const { x: tx, z: tz, w, T } = TOWER, top = siloTop + 0.4 + 5.4;              // up to the head-house roof
    S.footprints.push({ x0: tx - 2.5, x1: tx + 2.5, z0: tz - 2.5, z1: tz + 2.5 });
    const holes = []; for (let y = 1.2; y < top - 2; y += 4) holes.push({ x0: 1.0, x1: 3.4, y0: y, y1: y + 2.6 });
    wallWithHoles(S, 'wall', tx - w / 2, 0, tz - w / 2, w, top, T, holes.filter((_, i) => i % 2 === 0));                          // north
    wallWithHoles(S, 'wall', tx - w / 2, 0, tz + w / 2, w, top, T, holes);                                                         // south
    wallWithHoles(S, 'wall', tx - w / 2, 0, tz - w / 2, w, top, T, holes.filter((_, i) => i % 2 === 1 || i === 0), -Math.PI / 2);  // west
    wallWithHoles(S, 'wall', tx + w / 2, 0, tz - w / 2, w, top, T, holes, -Math.PI / 2);                                           // east
    const inner = w - 2 * T, ring = 0.65, e = inner / 2 - ring / 2, run = inner / 2 - ring;
    for (let y = 4; y < top - 1; y += 4) {
      S.box('slab', tx, y, tz - e, inner, 0.22, ring); S.box('slab', tx, y, tz + e, inner, 0.22, ring);
      S.box('slab', tx - e, y, tz, ring, 0.22, inner - 2 * ring); S.box('slab', tx + e, y, tz, ring, 0.22, inner - 2 * ring);
    }
    // flights in the side bands only: the 2.5 m well and the north-south openings stay clear. Ground flight on the
    // south band keeps the east and west ground doors open.
    for (let k = 0; k < 9; k++) {
      const y0 = k ? 4 * k + 0.22 : 0, y1 = 4 * k + 4;
      if (k === 0) stairFlight(S, [tx + run, tz + e], y0, [tx - run, tz + e], y1, ring - 0.04);
      else if (k % 2) stairFlight(S, [tx - e, tz + run], y0, [tx - e, tz - run], y1, ring - 0.04);
      else stairFlight(S, [tx + e, tz - run], y0, [tx + e, tz + run], y1, ring - 0.04);
    }
    S.spot(tx - w / 2 - 0.2, 10.5, tz, -1, 0, 3.6, 1.6);
  }
  // head house: floor over the south row (open over the shaft), ribbon windows, gallery door in the east end, roof
  {
    const { x0, x1, z0, z1 } = HEAD, y = siloTop, H = 5.4, L = x1 - x0, D = z1 - z0;
    slabWithHoles(S, 'slab', x0, x1, z0, z1, y, 0.4, [SHAFT]);
    const band = (zz) => { const holes = []; for (let x = 2; x < L - 3; x += 4) holes.push({ x0: x, x1: x + 3.0, y0: 1.0, y1: 3.6 }); wallWithHoles(S, 'wall', x0, y + 0.4, zz, L, H, 0.3, holes); };
    band(z0); band(z1);
    const endHoles = []; for (let z = 2; z < D - 3; z += 4.5) endHoles.push({ x0: z, x1: z + 3.2, y0: 1.0, y1: 3.6 });
    wallWithHoles(S, 'wall', x0, y + 0.4, z0, D, H, 0.3, endHoles, -Math.PI / 2);
    const gz = GAL.A[2] - z0;
    wallWithHoles(S, 'wall', x1, y + 0.4, z0, D, H, 0.3, [{ x0: 2, x1: 5.2, y0: 1.0, y1: 3.6 }, { x0: gz - 1.7, x1: gz + 1.7, y0: 0.7, y1: 3.9 }, { x0: D - 3.4, x1: D - 1.2, y0: 1.0, y1: 3.6 }], -Math.PI / 2);
    const ry = y + 5.8, slotX = -29.0;                                          // roof: open over the shaft, plus a slot across
    slabWithHoles(S, 'slab', x0, x1, z0, z1, ry, 0.35, [SHAFT, { x0: SHAFT.x1, x1: slotX, z0, z1 }]);
    for (const zz of [z0 + 0.125, z1 - 0.125]) { brokenRun(S, rDet, 'wall', x0, zz, SHAFT.x1, zz, ry + 0.35, 0.7, 0.25); brokenRun(S, rDet, 'wall', slotX, zz, x1, zz, ry + 0.35, 0.7, 0.25); }
    for (const xx of [x0 + 0.125, x1 - 0.125]) brokenRun(S, rDet, 'wall', xx, z0 + 0.25, xx, z1 - 0.25, ry + 0.35, 0.7, 0.25);
  }

  // ---- chimney: hollow, tapered, brick; the door faces the rack and the hall window.
  // The brick tube stands on the 0.5 m plinth (not buried in it: buried vertices lit the inside) and has its own
  // floor box; a corbelled brick course and a pale 0.9 m concrete coping make the rim read from the take start.
  // Rows are 0.5 m up to 4 m and 1 m up to 8 m, so the light pool from the door has vertices to land on.
  {
    const { x: cx, z: cz, h, rb, rt, th, base, cop, corb } = CHIM, aD = Math.atan2(DOOR[0], DOOR[1]);
    const off = (a) => Math.abs(Math.atan2(Math.sin(a - aD), Math.cos(a - aD)));
    const Ro = (y) => rb + (rt - rb) * (y / h);                                     // outer radius at world height y
    const yTop = h - cop - corb, hT = yTop - base;                                   // brick tube: base .. yTop
    const ys = []; for (let y = 0; y < 4; y += 0.5) ys.push(y); for (let y = 4; y < 8; y += 1) ys.push(y);
    const n2 = Math.max(1, Math.round((hT - 8) / 2)); for (let k = 0; k <= n2; k++) ys.push(8 + (hT - 8) * (k / n2));
    const g = tubeGeo(Ro(base), Ro(yTop), hT, th, 40, ys, (a, y) => y < 3.9 && off(a) < 0.42);     // door: 4 m tall
    g.translate(cx, base, cz); S.add('brick', g);
    const rIn = rt - th;                                                             // the mouth stays 1.65 m (the drop-in catch)
    const cb = ringGeo(rIn, Ro(yTop) + 0.12, yTop, yTop + corb, 40); cb.translate(cx, 0, cz); S.add('brick', cb);
    // coping: a 0.45 m lime-washed brick cap, 0.12 m proud (was a 0.9 m concrete collar 0.3 m proud: "a mushroom cap")
    const cp = ringGeo(rIn, rt + 0.12, h - cop, h, 40, MATS.coping.tile); cp.translate(cx, 0, cz); S.add('coping', cp);
    S.box('slab', cx, 0, cz, 8.5, base, 8.5);
    // inner floor: a 40-sided disc of r 3.07 (the bore is ~3.04 at the base), so no plinth top shows round its edge
    // (the old 4.2 m square left the plinth's sunlit lightmap texels visible inside: a ring of bright notches)
    { const n = 40, R = 3.07, y = base + 0.03, pos = [cx, y, cz], nor = [0, 1, 0], uv = [cx, cz], idx = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, x = cx + Math.sin(a) * R, z = cz + Math.cos(a) * R; pos.push(x, y, z); nor.push(0, 1, 0); uv.push(x, z); }
      for (let i = 0; i < n; i++) idx.push(0, 1 + i, 1 + ((i + 1) % n));
      const fl = new THREE.BufferGeometry();
      fl.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); fl.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      fl.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); fl.setIndex(idx); setAY(fl, base, y); S.add('slab', fl); }
    S.footprints.push({ x0: cx - 4.5, x1: cx + 4.5, z0: cz - 4.5, z1: cz + 4.5 });
    const sa = aD + 1.05; S.spot(cx + Math.sin(sa) * 3.45, 1.6, cz + Math.cos(sa) * 3.45, Math.sin(sa), Math.cos(sa), 2.0, 1.3);
  }

  // ---- factory hall: 64 x 22 m, three storeys of 5 m, column grid, holes, ribbon windows, roof slots
  {
    const { x0, x1, z0, z1, fh, levels, cols, rows } = HALL;
    const dx = (x1 - x0) / (cols - 1), dz = (z1 - z0) / (rows - 1);
    S.footprints.push({ x0: x0 - 1, x1: x1 + 1, z0: z0 - 1, z1: z1 + 1 });
    // ground slab split at the facades (inner slab + 4 skirts): no floor triangle spans inside and outside, so the
    // sunlit apron's vertices no longer light the hall floor (lighting r2 #4: near-window floor 3.4x -> 0.42x)
    { const e = 0.125, o = 0.6, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      S.box('slab', cx, 0, cz, x1 - x0 - 2 * e, 0.18, z1 - z0 - 2 * e);
      S.box('slab', cx, 0, z0 - (o - e) / 2, x1 - x0 + 2 * o, 0.18, o + e); S.box('slab', cx, 0, z1 + (o - e) / 2, x1 - x0 + 2 * o, 0.18, o + e);
      S.box('slab', x0 - (o - e) / 2, 0, cz, o + e, 0.18, z1 - z0 - 2 * e); S.box('slab', x1 + (o - e) / 2, 0, cz, o + e, 0.18, z1 - z0 - 2 * e); }
    const holes = [], kindOf = {};
    for (let L = 0; L < levels; L++) {
      const yb = L * fh, slabY = (L + 1) * fh - 0.35, cy0 = L ? yb - 0.15 : 0.18;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        if (L === 0 && j === 2 && (i === 0 || i === cols - 1)) continue;           // no column in the gable doors
        S.box('wall', x0 + i * dx, cy0, z0 + j * dz, 0.6, slabY - cy0, 0.6);
      }
      // slab bays: some missing (holes), the roof gets narrow slots instead; FORCE keeps the lines' bays
      for (let i = 0; i < cols - 1; i++) for (let j = 0; j < rows - 1; j++) {
        const cxb = x0 + (i + 0.5) * dx, czb = z0 + (j + 0.5) * dz, roof = L === levels - 1, r = rBay(), f = FORCE[`${L}:${i}:${j}`];
        const kind = f || (roof ? (r < 0.22 ? 'slot' : 'solid') : r < 0.13 ? 'hole' : 'solid');
        kindOf[`${L}:${i}:${j}`] = kind;
        if (kind === 'hole') { holes.push({ L, i, j, x0: cxb - dx / 2, x1: cxb + dx / 2, z0: czb - dz / 2, z1: czb + dz / 2, y: slabY, line: !!f }); continue; }
        if (kind === 'slot') {
          const slot = f ? 2.0 : 1.25, hw = (dx - slot) / 2;
          S.box('slab', cxb - dx / 2 + hw / 2, slabY, czb, hw, 0.35, dz); S.box('slab', cxb + dx / 2 - hw / 2, slabY, czb, hw, 0.35, dz);
          if (!f) for (const sgn of [-1, 1]) rebar(S, rDet, cxb + sgn * slot / 2, czb - dz / 2, cxb + sgn * slot / 2, czb + dz / 2, slabY + 0.17, -sgn, 0, 1, 0.35);
          continue;
        }
        S.box('slab', cxb, slabY, czb, dx, 0.35, dz);
      }
      // downstand beams on the interior column lines
      for (let i = 1; i < cols - 1; i++) lowBox(S, 'wall', x0 + i * dx, slabY - 0.55, (z0 + z1) / 2, 0.4, 0.55, z1 - z0 - 0.3);
      for (let j = 1; j < rows - 1; j++) lowBox(S, 'wall', (x0 + x1) / 2, slabY - 0.55, z0 + j * dz, x1 - x0 - 0.3, 0.55, 0.4);
      // long facades: spandrel (per bay, some sills broken) + lintel band, open ribbon windows; some bays bricked or with mullions
      for (const [zz, nz, side] of [[z0, -1, 'z0'], [z1, 1, 'z1']]) {
        const ys = yb + (L ? 0 : 0.18);
        for (let i = 0; i < cols - 1; i++) {
          const bx = x0 + (i + 0.5) * dx, a = rDet(), b = rDet(), c = rDet();
          if (a < 0.16) {                                                          // a chunk knocked out of the sill
            const nw = 0.8 + b * 1.4, nx = bx + (c - 0.5) * (dx - nw - 1.2), lw = nx - nw / 2 - (bx - dx / 2), rw = bx + dx / 2 - (nx + nw / 2);
            S.box('wall', bx - dx / 2 + lw / 2, ys, zz, lw, 1.0, 0.25); S.box('wall', bx + dx / 2 - rw / 2, ys, zz, rw, 1.0, 0.25);
            S.box('wall', nx, ys, zz, nw, 0.3 + b * 0.3, 0.25);
          } else S.box('wall', bx, ys, zz, dx, a < 0.4 ? 1.0 - (a - 0.16) * 1.1 : 1.0, 0.25);
        }
        S.box('wall', (x0 + x1) / 2, yb + 3.9, zz, x1 - x0, fh - 3.9 - 0.35, 0.25);
        for (let i = 0; i < cols - 1; i++) {
          const bx = x0 + (i + 0.5) * dx, r1 = rFac(), r2 = rFac(), r3 = rFac(), open = FORCE[`f${L}:${side}:${i}`] === 'open';
          if (!open && r1 < 0.12) S.box('wall', bx, yb + 0.5, zz, dx - 0.6, 3.4, 0.22);              // bricked-up bay
          else if (!open && r2 < 0.42) {
            for (let k = 1; k < 4; k++) S.box('rust', bx - dx / 2 + k * (dx / 4), yb + 1.0, zz, 0.09, 2.9, 0.09);
            S.box('rust', bx, yb + 2.45, zz, dx - 0.6, 0.08, 0.09);
          }
          if (L === 0 && r3 < 0.45) S.spot(bx, 0.55, zz + nz * 0.15, 0, nz, dx * 0.8, 0.85);
        }
      }
      // gable ends: wall with windows, ground floor gets a big door
      for (const [xx, nx] of [[x0, -1], [x1, 1]]) {
        const gh = [];
        for (let j = 0; j < rows - 1; j++) gh.push({ x0: j * dz + 1.0, x1: (j + 1) * dz - 1.0, y0: 1.0, y1: 3.8 });
        if (L === 0) gh.push({ x0: dz * 1.4, x1: dz * 2.6, y0: 0, y1: 4.4 });
        wallWithHoles(S, 'wall', xx, yb + (L ? 0 : 0.18), z0, z1 - z0, fh - 0.35 - (L ? 0 : 0.18), 0.3, gh, -Math.PI / 2);
        if (L === 0) S.spot(xx + nx * 0.2, 0.68, z0 + dz * 0.6, nx, 0, 3.5, 0.9);
      }
      // interior partitions with doorways (between the column rows, not on them)
      if (L < 2) {
        const px = x0 + dx * (3 + L * 4), py = L ? yb : yb + 0.18;
        wallWithHoles(S, 'wall', px, py, z0 + 0.3, z1 - z0 - 0.6, slabY - py, 0.25, [{ x0: 6.0, x1: 8.5, y0: 0, y1: 3.2 }, { x0: 13, x1: 15.5, y0: 0, y1: 3.2 }], -Math.PI / 2);
        S.spot(px + 0.2, 1.5, z0 + 11.05, 1, 0, 3.2, 1.4);
      }
    }
    // broken parapet all round
    brokenRun(S, rDet, 'wall', x0, z0, x1, z0, levels * fh, 0.9, 0.25); brokenRun(S, rDet, 'wall', x0, z1, x1, z1, levels * fh, 0.9, 0.25);
    brokenRun(S, rDet, 'wall', x0, z0 + 0.125, x0, z1 - 0.125, levels * fh, 0.7, 0.25); brokenRun(S, rDet, 'wall', x1, z0 + 0.125, x1, z1 - 0.125, levels * fh, 0.7, 0.25);
    // the holes: rebar along the broken edges, a hanging fragment now and then, rubble on the first floor below
    const piled = new Set();
    for (const h of holes) {
      const y = h.y + 0.17, len = h.line ? 0.45 : 0.7, n = h.line ? 1 : 2;
      rebar(S, rDet, h.x0, h.z0, h.x1, h.z0, y, 0, 1, n, len); rebar(S, rDet, h.x0, h.z1, h.x1, h.z1, y, 0, -1, n, len);
      rebar(S, rDet, h.x0, h.z0, h.x0, h.z1, y, 1, 0, n, len); rebar(S, rDet, h.x1, h.z0, h.x1, h.z1, y, -1, 0, n, len);
      if (!h.line && rDet() < 0.6) { const e = Math.floor(rDet() * 4), E = [[h.x0, h.z0, h.x1, h.z0, 0, 1], [h.x0, h.z1, h.x1, h.z1, 0, -1], [h.x0, h.z0, h.x0, h.z1, 1, 0], [h.x1, h.z0, h.x1, h.z1, -1, 0]][e]; hangingChunk(S, rDet, ...E.slice(0, 4), y, E[4], E[5]); }
      let L = h.L - 1; while (L >= 0 && kindOf[`${L}:${h.i}:${h.j}`] === 'hole') L--;
      const key = `${L}:${h.i}:${h.j}`; if (piled.has(key)) continue; piled.add(key);
      rubblePile(S, rRub, (h.x0 + h.x1) / 2, L < 0 ? 0.18 : (L + 1) * fh, (h.z0 + h.z1) / 2, 1.5, L < 0 ? 6 : 4);
    }
    // loose slab chunks on the ground floor
    for (let k = 0; k < 10; k++) { const s = 0.4 + rRub() * 0.9; S.box('slab', x0 + 3 + rRub() * (x1 - x0 - 6), 0.18, z0 + 2 + rRub() * (z1 - z0 - 4), s * 1.6, s * 0.6, s, rRub() * 3); }
  }

  // ---- conveyor gallery: sloped hollow tube from the head house east end down to the hall roof
  {
    const A = new THREE.Vector3(...GAL.A), B = new THREE.Vector3(...GAL.B);
    const dir = B.clone().sub(A); const L = dir.length(); dir.normalize();
    const zA = new THREE.Vector3().crossVectors(dir, Y_UP).normalize();
    const yA = new THREE.Vector3().crossVectors(zA, dir).normalize();
    const M = new THREE.Matrix4().makeBasis(dir, yA, zA).setPosition(A);
    const { W, H } = GAL;
    S.beam('slab', M, 0, L, 0.1, 0, 0.22, W);              // floor
    S.beam('wall', M, 0, L, H, 0, 0.22, W);                // roof
    for (let x = 0; x < L; x += 4) {                       // side walls in panels with window gaps
      const seg = Math.min(2.6, L - x);
      S.beam('wall', M, x, seg, H / 2 + 0.05, -W / 2, H, 0.18);
      S.beam('wall', M, x, seg, H / 2 + 0.05, W / 2, H, 0.18);
    }
    for (const t of [0.35, 0.68]) {                        // support towers
      const P = A.clone().lerp(B, t);
      for (const [ox, oz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) S.box('rust', P.x + ox, 0, P.z + oz, 0.32, P.y - 0.2, 0.32);
      for (let y = 4; y < P.y - 1; y += 5) { S.box('rust', P.x, y, P.z - 1.4, 3.1, 0.25, 0.25); S.box('rust', P.x, y, P.z + 1.4, 3.1, 0.25, 0.25); S.box('rust', P.x - 1.4, y, P.z, 0.25, 0.25, 3.1); S.box('rust', P.x + 1.4, y, P.z, 0.25, 0.25, 3.1); }
      S.footprints.push({ x0: P.x - 2, x1: P.x + 2, z0: P.z - 2, z1: P.z + 2 });
    }
  }

  // ---- workshop ruin: 2 storeys, windows, doorways in line on both long walls, half the roof gone
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
    rubblePile(S, rRub, x0 + 17.5, 0, z0 + 3.0, 1.5, 6);                      // under the missing roof, clear of the doors
    brokenRun(S, rDet, 'wall', x0 + 0.2, z0 + Lz, x0 + Lx - 0.2, z0 + Lz, 2 * fh, 0.5, T);
  }

  // ---- pipe rack: from the chimney door to the hall's entry window, on the same straight line
  {
    const A = new THREE.Vector3(RACK.H[0], 0, RACK.H[1]), B = new THREE.Vector3(RACK.K[0], 0, RACK.K[1]);
    const dir = B.clone().sub(A); const L = dir.length(); dir.normalize();
    const n = Math.max(3, Math.round(L / 6.5)), yaw = Math.atan2(-dir.z, dir.x);
    for (let k = 0; k <= n; k++) {
      const P = A.clone().lerp(B, k / n);
      S.box('rust', P.x - Math.sin(yaw) * 1.6, 0, P.z - Math.cos(yaw) * 1.6, 0.35, 7, 0.35);
      S.box('rust', P.x + Math.sin(yaw) * 1.6, 0, P.z + Math.cos(yaw) * 1.6, 0.35, 7, 0.35);
      S.box('rust', P.x, 7, P.z, 0.3, 0.3, 3.6, yaw);
    }
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
  // ---- scattered concrete blocks and fallen slabs (off the buildings and the tracks)
  for (let k = 0; k < 40; k++) {
    const x = -90 + rBlk() * 180, z = -60 + rBlk() * 140, s = 0.6 + rBlk() * 1.4, rot = rBlk() * 3;
    if (S.footprints.some((f) => x > f.x0 - 2 && x < f.x1 + 2 && z > f.z0 - 2 && z < f.z1 + 2) || distToPaths(x, z) < 3.5) continue;
    S.box('slab', x, terrainHeight(x, z) - 0.1, z, s * 1.8, s * 0.7, s, rot);
  }
  S.chimney = CHIM;
  S.lines = buildLines();
  // START AT points (pause menu) {name, pos, yaw}; yaw: forward = (-sin, 0, -cos). The take retries from the first.
  // Chimney: hovering 2.5 m over the mouth on its axis, nose on the door bearing: hold the dive and you drop in (DROP IN
  // ~1.1 s), push forward at the bottom and you're out of the door, under the rack and through the hall window.
  const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
  S.startPoints = [
    // hint (take.readyHint, UX r3 #3): what the UI says while the take is ready here, until `line` has been flown `until` times
    { name: 'Chimney', pos: [CHIM.x, CHIM.h + 2.5, CHIM.z], yaw: yawTo(DOOR[0], DOOR[1]), hint: { text: '▼ HOLD LEFT STICK · DROP IN', line: 'DROP IN', until: 3 } },
    // inside the hall under the first hole of the stack (design r3: first beat 7.4 s from the old spot by the rack),
    // nose towards the gallery foot: climb through TRIPLE POP, U-turn over the roof, up the gallery
    { name: 'Hall', pos: [STACK[0], 2.4, STACK[1]], yaw: yawTo(21 - STACK[0], 28 - STACK[1]), hint: { text: '▲ HOLD LEFT STICK UP · TRIPLE POP', line: 'TRIPLE POP', until: 3 } },
    // inside the head house, facing the stair tower's east opening: INTO THE TOWER, STAIRWELL DIVE, UNDER THE TABLE
    { name: 'Head house', pos: [-20, SILO.top + 2.6, TOWER.z], yaw: yawTo(-1, 0) },
    // north of the north row, lined up on the 1.6 m gaps: THE SMALL GAP, THREAD THE NEEDLE
    { name: 'Silos', pos: [TOWER.x, 10.5, -36], yaw: yawTo(0, 1) },
  ];
  S.takeStart = { pos: S.startPoints[0].pos.slice(), yaw: S.startPoints[0].yaw };
  // vertical lines the Cine dive assist steers onto (stream E's flight.js): axis c [x, z]; a dive is captured within r
  // of the axis from top - 0.5 up to top + 8 (chimney: its rim; stairwell: the head-house floor, so a dive entering
  // the tower from the head house is caught) and let go below `bottom` (chimney: 4 m, free to turn out of the door).
  // rIn = clear radius at the top (the mouth / the well between the landings). take.js: no touchdown CUT within r below top.
  // dir (C9): 'down' = a dive assist (above). 'up' = a climb assist, the mirror image: `bottom` is the opening (the
  // underside of the first hole a climb goes through), a held climb is captured within r of the axis below it, steered
  // onto the axis and let go above `top` (over the last opening); rIn = clear radius of the tightest opening (the hall
  // roof slot is 2.0 m across x). Read without dir (round-3 flight.js) the 'up' entry is a dive assist down the same
  // stack from over the roof slot (TRIPLE DROP), which is harmless. take.js: no CUT within r below `top` of any funnel.
  S.funnels = [
    { name: 'chimney', dir: 'down', c: [CHIM.x, CHIM.z], top: CHIM.h, bottom: 4, r: 3.5, rIn: CHIM.rt - CHIM.th },
    { name: 'stairwell', dir: 'down', c: [TOWER.x, TOWER.z], top: SILO.top + 0.4, bottom: 2, r: 3.0, rIn: (TOWER.w - 2 * TOWER.T) / 2 - 0.65 },
    { name: 'hall stack', dir: 'up', c: [STACK[0], STACK[1]], bottom: HALL.fh - 0.35, top: 3 * HALL.fh + 0.5, r: 2.5, rIn: 1.0 },
  ];
  return S;
}

// ---- named lines: invisible portals, each {name, caption (*accent* word), pts, c, n, w, h} (+ u: width axis, two: either way,
// pre: gates that must have been crossed (same way) within `within` s). A segment of flight crossing the rectangle
// along +n scores. Two entries with the same name are one line (both directions / both portals).
// micro: true = a 500-pt beat that fills a dead stretch of the signature line (it scores and adds FLOW like a line;
// the UI may caption it smaller and leave it out of the LINES count).
// Carves have no gate: {name, caption, pts, micro, c (zone centre, for hints), carve} where carve is
//   {kind:'orbit', axes:[[x, z]...], r0, r1, in0, in1, y0, y1, sweep}: sweep rad around one axis, between in (the wall)
//     and r from it (both linear from y0 to y1)
//   {kind:'turn', box:[x0, x1, y0, y1, z0, z1], sweep}: the flight path turns sweep rad inside the box
function buildLines() {
  const lines = [], g = (c, n, w, h, u) => ({ c, n, w, h, u }), neg = (G) => ({ ...G, n: G.n.map((v) => -v) });
  const add = (name, caption, pts, main, extra = {}) => lines.push({ name, caption, pts, ...main, ...extra });
  const [dx, dz] = DOOR, perp = [dz, 0, -dx];
  // chimney: DROP IN at the mouth (3 m below the rim), CHIMNEY DIVE out of the door (0.5-4.5 m, on the plinth)
  const mouth = g([CHIM.x, CHIM.h - 3, CHIM.z], [0, -1, 0], 2.4, 2.4, [1, 0, 0]);
  const door = g([CHIM.x + dx * (CHIM.rb + 0.15), CHIM.base + 2.0, CHIM.z + dz * (CHIM.rb + 0.15)], [dx, 0, dz], 3.0, 3.9, perp);
  add('DROP IN', 'DROP *IN*!', 500, mouth, { micro: true });
  add('CHIMNEY DIVE', 'CHIMNEY *DIVE*!', 3000, door, { pre: [mouth], within: 16 });
  // under the pipe rack, end to end
  const rk = g([RACK.K[0] + dx * 0.3, 3.4, RACK.K[1] + dz * 0.3], [dx, 0, dz], 2.9, 6.6, perp);
  const rh = g([RACK.H[0] - dx * 0.3, 3.4, RACK.H[1] - dz * 0.3], [dx, 0, dz], 2.9, 6.6, perp);
  add('UNDER THE RACK', 'UNDER THE *RACK*!', 1500, rh, { pre: [rk], within: 7 });
  add('UNDER THE RACK', 'UNDER THE *RACK*!', 1500, neg(rk), { pre: [neg(rh)], within: 7 });
  // the hall stack: first-floor hole -> second-floor hole -> roof slot
  const { x0, z0, fh } = HALL, hdx = (HALL.x1 - x0) / (HALL.cols - 1), hdz = (HALL.z1 - z0) / (HALL.rows - 1);
  const sx = x0 + 1.5 * hdx, sz = z0 + 0.5 * hdz;
  const l1 = g([sx, fh - 0.18, sz], [0, 1, 0], hdx - 0.6, hdz - 0.6, [1, 0, 0]), slot = g([sx, 3 * fh - 0.18, sz], [0, 1, 0], 2.0, hdz, [1, 0, 0]);
  // via (take.nextHint): from outside, the arrow goes to the rack's entry window first (inside the hall: the hole)
  add('TRIPLE POP', 'TRIPLE *POP*!', 2500, slot, { pre: [l1], within: 5, via: [{ p: [ENTRY[0], 2.5, ENTRY[1] - 3], unless: [HALL.x0, HALL.x1, 0, 3 * fh + 0.5, z0, HALL.z1] }] });
  add('TRIPLE DROP', 'TRIPLE *DROP*!', 2500, neg(l1), { pre: [neg(slot)], within: 5 });
  // conveyor gallery, mouth to mouth
  {
    const A = new THREE.Vector3(...GAL.A), B = new THREE.Vector3(...GAL.B), dir = B.clone().sub(A), L = dir.length(); dir.normalize();
    const zA = new THREE.Vector3().crossVectors(dir, Y_UP).normalize(), yA = new THREE.Vector3().crossVectors(zA, dir).normalize();
    const at = (s, sg) => g(A.clone().addScaledVector(dir, s).addScaledVector(yA, 1.35).toArray(), dir.clone().multiplyScalar(sg).toArray(), 2.8, 2.2, zA.toArray());
    add('GALLERY CLIMB', 'UP THE *GALLERY*!', 2000, at(1.5, -1), { pre: [at(L - 1.5, -1)], within: 9 });
    add('GALLERY DROP', 'DOWN THE *GALLERY*!', 1500, at(L - 1.5, 1), { pre: [at(1.5, 1)], within: 9 });
  }
  // the hall roof between the slot and the gallery foot: swing round into the gallery (150 deg of track over the roof)
  add('ROOF U-TURN', 'ROOF *U-TURN*!', 500, { c: [(x0 + HALL.x1) / 2, 3 * fh + 1, (z0 + HALL.z1) / 2] },
    { micro: true, carve: { kind: 'turn', box: [x0 - 1, HALL.x1 + 1, 3 * fh - 0.4, 3 * fh + 6, z0 - 1, HALL.z1 + 1], sweep: 2.62 } });
  // the stair tower's head-house storey opening (east wall, y 33.2-35.8), on the way in to the stairwell
  add('INTO THE TOWER', 'INTO THE *TOWER*!', 500, g([TOWER.x + TOWER.w / 2, 34.5, TOWER.z], [-1, 0, 0], 2.3, 2.5, [0, 0, 1]), { micro: true });
  // stair shaft: head-house floor -> under the table
  const sw = SHAFT.x1 - SHAFT.x0;
  add('STAIRWELL DIVE', 'STAIRWELL *DIVE*!', 3000, g([TOWER.x, 4.9, TOWER.z], [0, -1, 0], sw, sw, [1, 0, 0]), { pre: [g([TOWER.x, SILO.top + 0.2, TOWER.z], [0, -1, 0], sw, sw, [1, 0, 0])], within: 9,
    // via: from outside, over the head-house roof's hole above the shaft (inside the head house: straight to the shaft)
    via: [{ p: [TOWER.x, SILO.top + 8.3, TOWER.z], unless: [HEAD.x0, HEAD.x1, SILO.top - 0.5, SILO.top + 5.8, HEAD.z0, HEAD.z1] }] });
  // under the silo table, edge to edge (or out of the tower's ground doors)
  const tE = g([-13.6, 2.35, -14], [1, 0, 0], 29, 4.3, [0, 0, 1]), tW = g([-54.4, 2.35, -14], [1, 0, 0], 29, 4.3, [0, 0, 1]);
  const twE = g([TOWER.x + TOWER.w / 2 + 0.2, 2.5, TOWER.z], [1, 0, 0], 2.4, 2.6, [0, 0, 1]), twW = g([TOWER.x - TOWER.w / 2 - 0.2, 2.5, TOWER.z], [-1, 0, 0], 2.4, 2.6, [0, 0, 1]);
  add('UNDER THE TABLE', 'UNDER THE *TABLE*!', 1500, tE, { pre: [tW, twE], within: 7 });
  add('UNDER THE TABLE', 'UNDER THE *TABLE*!', 1500, neg(tW), { pre: [neg(tE), twW], within: 7 });
  // the 1.6 m gap between silos 2 and 3, in either row; both rows in one go threads the tower between them
  const gx = (SILO.x[1] + SILO.x[2]) / 2, gw = SILO.x[2] - SILO.x[1] - 2 * SILO.r;
  const gap = (z) => g([gx, (SILO.table + SILO.top) / 2, z], [0, 0, 1], gw, SILO.top - SILO.table, [1, 0, 0]);
  add('THE SMALL GAP', 'THE SMALL *GAP*.', 2500, gap(SILO.z[0]), { two: true });
  add('THE SMALL GAP', 'THE SMALL *GAP*.', 2500, gap(SILO.z[1]), { two: true });
  add('THREAD THE NEEDLE', 'THREAD THE *NEEDLE*!', 3000, gap(SILO.z[1]), { pre: [gap(SILO.z[0])], within: 4 });
  add('THREAD THE NEEDLE', 'THREAD THE *NEEDLE*!', 3000, neg(gap(SILO.z[0])), { pre: [neg(gap(SILO.z[1]))], within: 4 });
  // carves: half way round one north-row silo within ~2 m of its wall (the end silos, or out of a gap), or 150 deg round
  // the chimney within ~3.5 m (the finale link from the table to the gaps)
  const sTop = SILO.top + SILO.rim.recess;
  add('SILO CARVE', 'SILO *CARVE*!', 500, { c: [(SILO.x[0] + SILO.x[3]) / 2, (SILO.table + sTop) / 2, SILO.z[0]] },
    { micro: true, carve: { kind: 'orbit', axes: SILO.x.map((x) => [x, SILO.z[0]]), r0: SILO.r + 2, r1: SILO.r + 2, in0: SILO.r, in1: SILO.r, y0: SILO.table, y1: sTop + 2, sweep: Math.PI } });
  add('CHIMNEY CARVE', 'CHIMNEY *CARVE*!', 500, { c: [CHIM.x, 12, CHIM.z] },
    { micro: true, carve: { kind: 'orbit', axes: [[CHIM.x, CHIM.z]], r0: CHIM.rb + 5.0, r1: CHIM.rt + 5.0, in0: CHIM.rb, in1: CHIM.rt, y0: CHIM.base, y1: CHIM.h + 1, sweep: 2.27 } });
  // along the north row's north faces, across silo 4's face to the 1.0 m gap between silos 3 and 4 (either way), within
  // 3.6 m of the faces: the beat between CHIMNEY CARVE and THE SMALL GAP (design r3 #2: that stretch was 8-9 s, no beat)
  { const fz = SILO.z[0] - SILO.r, xg = (SILO.x[2] + SILO.x[3]) / 2, xe = SILO.x[3] + 2.5;
    const nr = (x, s) => g([x, (SILO.table + SILO.top) / 2, fz - 1.8], [s, 0, 0], 3.6, SILO.top - SILO.table, [0, 0, 1]);
    add('NORTH ROW', 'THE NORTH *ROW*!', 500, nr(xg, -1), { micro: true, pre: [nr(xe, -1)], within: 5 });
    add('NORTH ROW', 'THE NORTH *ROW*!', 500, nr(xe, 1), { micro: true, pre: [nr(xg, 1)], within: 5 }); }
  // the hall's ground floor, gable door to gable door
  const gd = (x) => g([x, 2.3, z0 + 2 * hdz], [1, 0, 0], hdz * 1.2, 4.2, [0, 0, 1]);
  add('HALL RUN', 'HALL *RUN*!', 2000, gd(HALL.x1), { pre: [gd(x0)], within: 12 });
  add('HALL RUN', 'HALL *RUN*!', 2000, neg(gd(x0)), { pre: [neg(gd(HALL.x1))], within: 12 });
  // across the hall through the two open bays at the end of the track from the spawn
  const win = (z) => g([x0 + 3.5 * hdx, 2.55, z], [0, 0, -1], hdx - 0.6, 2.7, [1, 0, 0]);
  // first: the line the first-flight toast names ("follow the track into the hall's open bay"), hinted until any is flown
  add('STRAIGHT THROUGH', 'STRAIGHT *THROUGH*!', 1000, win(z0), { pre: [win(HALL.z1)], within: 4, first: true });
  add('STRAIGHT THROUGH', 'STRAIGHT *THROUGH*!', 1000, neg(win(HALL.z1)), { pre: [neg(win(z0))], within: 4 });
  // the workshop's two doors are in line
  const wd = (z) => g([-53.4, 1.5, z], [0, 0, 1], 2.4, 3.0, [1, 0, 0]);
  add('THROUGH THE WORKSHOP', 'IN AND *OUT*!', 1500, wd(53), { pre: [wd(40)], within: 4 });
  add('THROUGH THE WORKSHOP', 'IN AND *OUT*!', 1500, neg(wd(40)), { pre: [neg(wd(53))], within: 4 });
  return lines;
}

const PATHS = [
  [[0, 160], [0, 95], [6, 60], [18, 42], [30, 38]],
  [[6, 60], [-14, 30], [-30, 6], [-34, 2]],
  [[-14, 30], [-40, 40], [-52, 54]],
  [[6, 60], [-1, 38], [-1, 12], RACK.H, RACK.K],                // past the gallery tower, along the rack to the chimney door
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
  for (let i = 0; i < 420; i++) {         // [B] 420 leaves at 16-34 px (round 2: 230 at 28-58 px read 3x oversize)
    const back = i < 155, v = back ? 1 : (R() < 0.78 ? 0 : 2), [x0, y0, x1, y1] = LEAF_RECTS[Math.floor(R() * LEAF_RECTS.length)];
    const a = R() * 6.283, rr = Math.sqrt(R()) * S * (back ? 0.32 : 0.41), w = x1 - x0, h = y1 - y0, s = (16 + R() * 18) / Math.max(w, h);
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

// [B] graffiti atlas: 4 x 16 cells of 512 x 256 (2048 x 4096). Pieces (3D block, 6-10 px black outline, gradient fill,
// highlights, arrows and flares), throw-ups (bubble letters), tag clusters and buffed patches; drips, overspray.
// Nothing should read as a computer font: every word is skewed (+-0.35 rad) with per-letter jitter, and the decal
// shader warps every piece by a 2-octave sine remap (+-6 atlas px) with its own phases, so a cell never repeats the
// same way twice (WP_FRAG.decalMap). Little glow; the palette is desaturated 25 %.
const CREWS = ['FCU', 'MSK', 'OX', 'SKEB', 'ZOMB', 'RISE', 'DOK', 'KAOS', 'VEX', 'NOPE', 'BANDO', 'GONZ', 'RAW', 'SEKT', 'MOHA', 'LUX', 'TWS', 'AOK', 'KEMS', 'ROEK', 'MUTE', 'HAZE', 'ODE', 'KRASH', 'BLUR', 'DRIP', 'NUKE', 'OMEN', 'REAX', 'UFO', 'SINE', 'BOLT',
  'SMASH', 'TOPS', 'WERK', 'JOKER', 'GRIME', 'DUST', 'ZEPH', 'KILO', 'SOKE', 'MERZ', 'TRAK', 'VOID', 'ASKE', 'CREW', 'RUST', 'HYPE', 'NEKO', 'DAZE', 'FLUX', 'GORE', 'BRAT', 'SNOW', 'KRYM', 'ZYKO', 'PAX', 'WOLF', 'LOST', 'RIOT', 'MAZE', 'QUAK', 'SPOK', 'ECHO'];
const desat = (hex, k) => { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255, l = 0.299 * r + 0.587 * g + 0.114 * b, m = (c) => Math.round(c + (l - c) * k); return `rgb(${m(r)},${m(g)},${m(b)})`; };
const GPAL = [['#e8327c', '#ffb3d4', '#7a0f3c'], ['#1fa6e6', '#bdeeff', '#0b3f6e'], ['#f5c518', '#fff1a6', '#8a5a00'], ['#2fbf71', '#c9f7dc', '#0d5b33'], ['#f2641e', '#ffd0b5', '#7d2a05'],
  ['#8e5cf0', '#e3d6ff', '#3a1d7a'], ['#c9ced6', '#ffffff', '#6b7079'], ['#d7263d', '#f7a072', '#5e0a14'], ['#0fb5ae', '#a6f0ea', '#05504d'], ['#c3e21b', '#f0ffb0', '#4f5e00']].map((p) => p.map((c) => desat(c, 0.25)));
const GCOLS = 4, GROWS = 16, GCELLS = GCOLS * GROWS;
const GTYPE = (k) => (k < 28 ? 'piece' : k < 44 ? 'throw' : k < 56 ? 'tags' : 'buff');
function graffitiAtlas(R) {
  return canvasTex(GCOLS * 512, GROWS * 256, (gA, W, H) => {
    gA.clearRect(0, 0, W, H);
    const cv = () => { const c = document.createElement('canvas'); c.width = 512; c.height = 256; return c; };
    const cA = cv(), g = cA.getContext('2d');
    const fontB = (px) => `900 ${px | 0}px "Arial Rounded MT Bold", "Arial Black", Futura, "Helvetica Neue", "DejaVu Sans", sans-serif`;
    const fontT = (px) => `italic 700 ${px | 0}px "Marker Felt", Noteworthy, "Brush Script MT", "Snell Roundhand", "URW Chancery L", cursive`;
    const pick = (a) => a[Math.floor(R() * a.length)];
    const INK = '#0c0c0f';
    const layout = (word, size, maxW, font, skew = 0.35) => {
      g.font = font(size); const ws = [...word].map((ch) => g.measureText(ch).width * 0.86); let tot = ws.reduce((a, b) => a + b, 0);
      const k = Math.min(1, maxW / Math.max(1, tot)); g.font = font(size * k); tot *= k;
      let x = -tot / 2; const out = [...word].map((ch, i) => { const w = ws[i] * k, l = { ch, x: x + w / 2, y: (R() - 0.5) * size * k * 0.2, rot: (R() - 0.5) * 0.3, s: 0.9 + R() * 0.24 }; x += w; return l; });
      out.sz = size * k; out.sk = Math.tan((R() - 0.5) * 2 * skew); out.w = tot; return out;
    };
    const each = (L, fn) => L.forEach((l) => { g.save(); g.translate(l.x, l.y); g.transform(1, 0, L.sk, 1, 0, 0); g.rotate(l.rot); g.scale(l.s, l.s); fn(l.ch); g.restore(); });
    const drips = (col, n, x0, x1, y, w) => {
      g.strokeStyle = col; g.fillStyle = col;
      for (let i = 0; i < n; i++) { const x = x0 + R() * (x1 - x0), y0 = y + (R() - 0.5) * 24, len = 8 + R() * R() * 80; g.lineWidth = w * (0.6 + R() * 0.8);
        g.beginPath(); g.moveTo(x, y0); g.lineTo(x + (R() - 0.5) * 2, y0 + len); g.stroke(); g.beginPath(); g.arc(x, y0 + len, g.lineWidth * 0.75, 0, 6.283); g.fill(); }
    };
    // an arrow flying off the letters: curved tapered shaft + head, outlined like the letters
    const arrow = (x0, y0, ang, len, w, fill) => {
      const bend = (R() - 0.5) * 0.9, x1 = x0 + Math.cos(ang) * len, y1 = y0 + Math.sin(ang) * len;
      const qx = (x0 + x1) / 2 - Math.sin(ang) * len * bend, qy = (y0 + y1) / 2 + Math.cos(ang) * len * bend, ta = Math.atan2(y1 - qy, x1 - qx), hl = w * 2.1;
      const shaft = () => { g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(qx, qy, x1, y1); };
      const head = () => { g.beginPath(); g.moveTo(x1 + Math.cos(ta) * hl, y1 + Math.sin(ta) * hl); g.lineTo(x1 + Math.cos(ta + 2.3) * hl, y1 + Math.sin(ta + 2.3) * hl); g.lineTo(x1 + Math.cos(ta - 2.3) * hl, y1 + Math.sin(ta - 2.3) * hl); g.closePath(); };
      g.strokeStyle = INK; g.fillStyle = INK; g.lineWidth = w + 16; shaft(); g.stroke(); head(); g.lineWidth = 16; g.stroke(); g.fill();
      g.strokeStyle = fill; g.fillStyle = fill; g.lineWidth = w; shaft(); g.stroke(); head(); g.fill();
    };
    const flare = (x, y, s) => { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x - s, y); g.lineTo(x, y - 1.6); g.lineTo(x + s, y); g.lineTo(x, y + 1.6); g.moveTo(x, y - s); g.lineTo(x + 1.6, y); g.lineTo(x, y + s); g.lineTo(x - 1.6, y); g.fill(); };
    const piece = (word, pal, size, maxW) => {
      const [c1, c2, c3] = pal, L = layout(word, size, maxW, fontB), sz = L.sz;
      if (R() < 0.5) {                                                      // background cloud / bubbles
        g.save(); const bg = pick(GPAL)[R() < 0.5 ? 0 : 2]; g.fillStyle = bg; g.globalAlpha = 0.8; g.shadowColor = bg; g.shadowBlur = 3;
        for (let i = 0; i < 9; i++) { g.beginPath(); g.ellipse((R() - 0.5) * maxW, (R() - 0.5) * 70, 40 + R() * 60, 30 + R() * 40, 0, 0, 6.283); g.fill(); }
        g.restore();
      }
      for (let a = 0, na = R() < 0.75 ? 1 + Math.floor(R() * 2) : 0; a < na; a++) {   // arrows off the first / last letter
        const l = a ? L[0] : L[L.length - 1], dir = a ? Math.PI + (R() - 0.5) * 1.2 : (R() - 0.7) * 1.4;
        arrow(l.x, l.y - sz * 0.1, dir, sz * (0.55 + R() * 0.4), 10 + R() * 8, R() < 0.6 ? c1 : c2);
      }
      const dk = R() < 0.5 ? '#141418' : c3;
      each(L, (ch) => { g.fillStyle = dk; g.strokeStyle = dk; g.lineWidth = 22; for (let d = 12; d > 0; d -= 4) { g.strokeText(ch, d, d); g.fillText(ch, d, d); } });
      const ow = 7 + 2 * (6 + R() * 4);                                      // outline: 6-10 px outside the fill's 7 px stroke
      each(L, (ch) => { g.lineWidth = ow; g.strokeStyle = INK; g.strokeText(ch, 0, 0); });
      each(L, (ch) => {
        const gr = g.createLinearGradient(0, -sz * 0.4, 0, sz * 0.4); gr.addColorStop(0, c2); gr.addColorStop(0.45, c1); gr.addColorStop(1, R() < 0.5 ? c1 : c3);
        g.shadowColor = c1; g.shadowBlur = 3; g.fillStyle = gr; g.strokeStyle = gr; g.lineWidth = 7; g.strokeText(ch, 0, 0); g.fillText(ch, 0, 0); g.shadowBlur = 0;
      });
      each(L, (ch) => { g.save(); g.beginPath(); g.rect(-sz, -sz, 2 * sz, sz * 0.75); g.clip(); g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.8)'; g.strokeText(ch, -3, -4); g.restore(); });
      drips(c1, 4 + Math.floor(R() * 7), -maxW / 2, maxW / 2, sz * 0.3, 4);
      for (let i = 0; i < 4; i++) flare((R() - 0.5) * maxW, (R() - 0.5) * sz * 0.6, 5 + R() * 9);
    };
    const throwUp = (word, size, maxW) => {
      const fill = pick(['#efefeb', '#d9dde2', '#efefeb', desat('#ffd23f', 0.25), desat('#ff5fa2', 0.25), desat('#64d2ff', 0.25)]), line = R() < 0.8 ? '#101014' : pick(GPAL)[2];
      const L = layout(word.slice(0, 2 + Math.floor(R() * 3)), size, maxW, fontB);
      each(L, (ch) => { g.lineWidth = 24 + 2 * (6 + R() * 4); g.strokeStyle = line; g.strokeText(ch, 0, 0); });
      each(L, (ch) => { g.shadowColor = fill; g.shadowBlur = 3; g.lineWidth = 24; g.strokeStyle = fill; g.fillStyle = fill; g.strokeText(ch, 0, 0); g.fillText(ch, 0, 0); g.shadowBlur = 0; });
      g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(40,40,40,0.2)';     // patchy one-coat fill
      for (let i = 0; i < 16; i++) { g.beginPath(); g.ellipse((R() - 0.5) * maxW, (R() - 0.5) * 90, 10 + R() * 30, 6 + R() * 16, R() * 3, 0, 6.283); g.fill(); }
      g.globalCompositeOperation = 'source-over';
      if (R() < 0.4) arrow(L[L.length - 1].x + L.sz * 0.3, 0, (R() - 0.6) * 1.2, L.sz * 0.6, 12, fill);
      drips(fill, 3 + Math.floor(R() * 6), -maxW / 2, maxW / 2, size * 0.35, 3);
    };
    const tags = (n, spread) => {
      for (let i = 0; i < n; i++) {
        g.save(); g.translate((R() - 0.5) * spread, (R() - 0.5) * 150); g.rotate((R() - 0.5) * 0.6);
        const word = pick(CREWS), col = pick(['#111', '#111', '#111', '#c8ccd2', '#e5e5e5', desat('#d7263d', 0.25), desat('#1f6fe6', 0.25), desat('#f2641e', 0.25), desat('#2fbf71', 0.25)]);
        const L = layout(R() < 0.6 ? word.toLowerCase() : word, 64 + R() * 50, 150 + R() * 140, fontT, 0.45);
        const stroke = R() < 0.5, lw = 4 + R() * 3;
        each(L, (ch) => { g.lineWidth = lw; g.strokeStyle = col; g.fillStyle = col; if (stroke) g.strokeText(ch, 0, 0); else g.fillText(ch, 0, 0); });
        if (R() < 0.5) { g.lineWidth = 3; g.strokeStyle = col; g.beginPath(); g.moveTo(-90, 40); g.quadraticCurveTo(0, 60 + R() * 20, 110, 28); g.stroke(); }
        if (R() < 0.4) drips(col, 2 + Math.floor(R() * 3), -60, 60, 25, 2);
        g.restore();
      }
    };
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineCap = 'round';
    for (let k = 0; k < GCELLS; k++) {
      const type = GTYPE(k), word = CREWS[k % CREWS.length];
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 512, 256);
      g.save(); g.beginPath(); g.rect(10, 10, 492, 236); g.clip(); g.translate(256, 126);
      if (type === 'piece') { if (R() < 0.35) { g.save(); g.globalAlpha = 0.7; tags(3, 430); g.restore(); } piece(word, pick(GPAL), 150, 420); }
      else if (type === 'throw') throwUp(word, 165, 410);
      else if (type === 'tags') tags(4 + Math.floor(R() * 4), 370);
      else {
        g.save(); g.globalAlpha = 0.8; piece(word, pick(GPAL), 140, 410); g.restore();
        g.fillStyle = pick(['#8d8a82', '#a39c8c', '#77756f', '#9a948a']); g.globalAlpha = 0.95;
        const bw = 200 + R() * 220, bh = 120 + R() * 90, bx = (R() - 0.5) * (430 - bw);
        for (let i = 0; i < 6; i++) g.fillRect(bx - bw / 2 + (R() - 0.5) * 14, -bh / 2 + (R() - 0.5) * 14, bw, bh);
        g.globalAlpha = 1; tags(1 + Math.floor(R() * 2), 300);
      }
      g.restore();
      gA.drawImage(cA, (k % GCOLS) * 512, Math.floor(k / GCOLS) * 256);
    }
  });
}
// [B] treeline crown: 7 alpha-tested leaf-cluster cards on the lumps of a round-topped crown (base y = 0, height 1,
// width 1; the instance scales it), each card turned at random and rolled so the cluster never repeats the same way.
// Normals point out of the crown centre (it shades as one mass, both faces alike); uv.y doubles as height for AO.
function crownCards() {
  const lumps = [[0, 0.5, 0, 0.46], [0.12, 0.77, 0.06, 0.28], [0.27, 0.42, 0.1, 0.31], [-0.25, 0.4, -0.14, 0.31], [-0.14, 0.7, -0.04, 0.26], [0.06, 0.42, 0.28, 0.27], [-0.05, 0.44, -0.3, 0.27]];
  const P = [], N = [], UV = [], I = [], q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), c = new THREE.Vector3(0, 0.45, 0), CR = rng(1211);
  lumps.forEach(([x, y, z, r], k) => {
    e.set((CR() - 0.5) * 1.0, CR() * 6.283, CR() * 6.283, 'YXZ'); q.setFromEuler(e);
    const s = r * 1.15, b = P.length / 3;
    for (const [u, w] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      v.set(u * s, w * s, 0).applyQuaternion(q).add(new THREE.Vector3(x, y, z));
      v.y = Math.max(v.y, 0.02); P.push(v.x, v.y, v.z); UV.push((u + 1) / 2, (w + 1) / 2);
      v.sub(c).normalize(); v.y += 0.2; v.normalize(); N.push(v.x, v.y, v.z);
    }
    I.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2)); g.setIndex(I);
  return g;
}
// [B] ground mask over the yard terrain tile (0.625 m texels): R grass density, G paved apron/road,
// B terrain AO (baked), A grass height. Replaces the per-vertex footprint/path loops of the grass shader.
const MASK = { N: 512, x0: -165, z0: -150, size: 320 };
function buildGroundMask(site, terr) {
  const { N, x0, z0, size } = MASK, d = new Uint8Array(N * N * 4), sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const fh = (i, j) => { let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  // path segments with bounding boxes: only distances below ~7 m matter
  const segs = []; for (const p of PATHS) for (let k = 0; k < p.length - 1; k++) { const [ax, az] = p[k], [bx, bz] = p[k + 1]; segs.push([ax, az, bx - ax, bz - az, Math.min(ax, bx) - 7, Math.max(ax, bx) + 7, Math.min(az, bz) - 7, Math.max(az, bz) + 7, (bx - ax) ** 2 + (bz - az) ** 2]); }
  const pathD = (x, z) => {
    let best = 49;
    for (const [ax, az, vx, vz, xa, xb, za, zb, l2] of segs) {
      if (x < xa || x > xb || z < za || z > zb) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2)), dx = x - ax - t * vx, dz = z - az - t * vz, q = dx * dx + dz * dz; if (q < best) best = q;
    }
    return Math.sqrt(best);
  };
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
    for (const f of fps) { const dx = Math.max(f.x0 - x, x - f.x1), dz = Math.max(f.z0 - z, z - f.z1); const e = dx > 0 || dz > 0 ? Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dz, 0) ** 2) : Math.max(dx, dz); if (e < sd) sd = e; }
    const yard = Math.max(Math.abs(x + 5) - 95, Math.abs(z - 10) - 85), paved = 1 - sm(-14, 0, yard);
    const n1 = vno(x * 0.05, z * 0.05), n2 = vno(x * 0.17 + 3, z * 0.17 + 7), dP = pathD(x, z);
    const apW = 5 + 7 * n1;
    let ap = sd < 0 ? 1 : 1 - sm(apW - 2, apW + 2, sd + (n2 - 0.5) * 4);
    ap = Math.max(ap, (1 - sm(2.0, 3.6, dP + (n2 - 0.5) * 1.4 - vno(x * 0.03 + 11, z * 0.03) * 1.2)) * paved);
    const n3 = vno(x * 0.45 + 1, z * 0.45 + 2);
    let dens = (0.42 + 0.58 * vno(x * 0.09 + 5, z * 0.09)) * (1 - 0.8 * sm(0.7, 0.88, vno(x * 0.035 + 17, z * 0.035 + 3)));
    dens *= sm(0.0, 1.2, sd) * (1 - 0.88 * sm(0.25, 0.75, ap)) * sm(1.4, 4.4, dP + (n3 - 0.5) * 2.4);
    let ht = 0.45 + 0.8 * vno(x * 0.06 + 9, z * 0.06 + 1) + 0.35 * n3 + 0.5 * (1 - sm(0, 5, sd));
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
// foot, dust at storey floors, grime/moss on up-facing faces, warm dust where the weather can't reach (baked AO),
// soot over the top of the chimney. uWx2.y > 0 = the material is cylinders of about that radius (silos): the
// streak noise then runs on the azimuth (from the normal) with a whole number of cells round, so there's no seam.
const GLSL_WEATHER = `
uniform vec4 uWx;
uniform vec4 uWx2;
float vnP(vec2 p, float n){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); float i0 = mod(i.x, n), i1 = mod(i.x + 1.0, n);
  return mix(mix(h21(vec2(i0, i.y)), h21(vec2(i1, i.y)), f.x), mix(h21(vec2(i0, i.y + 1.0)), h21(vec2(i1, i.y + 1.0)), f.x), f.y); }
vec3 weather(vec3 c, vec3 nw, vec3 wp, vec2 ay, float ao) {
  float side = 1.0 - smoothstep(0.45, 0.8, abs(nw.y));
  float ht = max(ay.y - wp.y, 0.0), hb = max(wp.y - ay.x, 0.0);
  float L = clamp((ay.y - ay.x) * 0.45, 1.2, 16.0);
  float fq = uWx2.x, seed, nBase, nLen, nCol, nFine, nDamp;
  if (uWx2.y > 0.0) {
    float u = atan(nw.z, nw.x) * 0.15915494 + 0.5, C = 6.2831853 * uWx2.y;
    float n0 = max(1.0, floor(C * 0.13 + 0.5)), n1 = max(1.0, floor(C * fq + 0.5)), n2 = max(1.0, floor(C * 6.5 + 0.5)), n3 = max(1.0, floor(C * 0.45 + 0.5)), n4 = max(1.0, floor(C * fq * 0.6 + 0.5));
    seed = h21(vec2(ay.x * 1.31 + ay.y * 0.77, 0.5));
    nBase = vnP(vec2(u * n0, wp.y * 0.11 + seed * 17.0), n0);
    nLen = vnP(vec2(u * n4, seed * 9.0), n4);
    nCol = vnP(vec2(u * n1, 0.5 + seed * 5.0), n1);
    nFine = vnP(vec2(u * n2, ht * 0.7), n2);
    nDamp = vnP(vec2(u * n3, 2.0), n3);
  } else {
    float along = abs(nw.x) > abs(nw.z) ? wp.z : wp.x;
    seed = h21(vec2(ay.x * 1.31 + ay.y * 0.77, floor(along * 0.21) + 0.5));
    nBase = vn(vec2(along * 0.13 + seed * 17.0, wp.y * 0.11));
    nLen = vn(vec2(along * fq * 0.6, seed * 9.0));
    nCol = vn(vec2(along * fq, 0.5 + seed * 5.0));
    nFine = vn(vec2(along * 6.5, ht * 0.7));
    nDamp = vn(vec2(along * 0.45, 2.0));
  }
  c *= 0.86 + 0.28 * nBase;
  float Lc = L * (0.3 + 0.9 * nLen);
  float s = smoothstep(0.42, 0.8, nCol) * (0.5 + 0.5 * nFine);
  s *= 1.0 - smoothstep(0.15 * Lc, Lc, ht);
  float lip = (1.0 - smoothstep(0.0, 0.3, ht)) * 0.55;
  c *= 1.0 - uWx.x * max(s, lip) * side;
  c *= 1.0 - uWx2.z * smoothstep(uWx2.w, 0.5, ht) * side;                 // soot: the top uWx2.w m of the element
  float onG = 1.0 - step(0.6, ay.x);
  float damp = (1.0 - smoothstep(0.1, 1.0 + 0.7 * nDamp, wp.y)) * onG;
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
  decalMap: `
  #ifdef USE_MAP
  { vec2 lc = fract(vMapUv * vec2(${GCOLS}.0, ${GROWS}.0)) * vec2(512.0, 256.0);      // atlas px inside the piece's cell
    vec4 ph = fract(vSeed * vec4(1.0, 7.31, 3.17, 5.77)) * 6.2832; float fa = 0.018 + 0.02 * fract(vSeed * 11.3), fb = 0.055 + 0.04 * fract(vSeed * 13.7);
    vec2 dw = 6.0 * vec2(0.62 * sin(lc.y * fa + ph.x) + 0.38 * sin(lc.y * fb + ph.y), 0.62 * sin(lc.x * fa * 0.7 + ph.z) + 0.38 * sin(lc.x * fb * 0.8 + ph.w));
    diffuseColor *= textureGrad(map, vMapUv + dw / vec2(${GCOLS * 512}.0, ${GROWS * 256}.0), dFdx(vMapUv), dFdy(vMapUv)); }
  #endif`,
  decal: `
  { vec3 nwd = normalize(vNW); float along = abs(nwd.x) > abs(nwd.z) ? vWPos.z : vWPos.x;
    float wl = lum3(texture2D(uWallTex, vec2(along, vWPos.y) * uWallRep).rgb) / uWallMean;   // the concrete shows through
    diffuseColor.rgb *= clamp(wl, 0.55, 1.5);
    diffuseColor.rgb = weather(diffuseColor.rgb, nwd, vWPos, vAY, vAO);
    diffuseColor.a *= (0.55 + 0.45 * vn(vec2(along * 0.9, vWPos.y * 0.9))) * smoothstep(0.1, 0.3, vn(vec2(along * 5.0, vWPos.y * 5.0))); }`,
  ground: `
  { vec2 xz = vWPos.xz; float far = smoothstep(40.0, 140.0, distance(vWPos, cameraPosition));
    vec4 mk = texture2D(uMask, (xz - uMaskO) / uMaskS);
    vec3 base = mix(diffuseColor.rgb, uGMean, far);                       // no tiling grid from altitude
    float p1 = vn(xz * 0.045) * 0.6 + vn(xz * 0.19) * 0.4;
    float dry = smoothstep(0.3, 0.75, vn(xz * 0.021 + 7.0) * 0.65 + p1 * 0.35);
    base = mix(base * vec3(0.92, 1.03, 0.84), lum3(base) * vec3(1.42, 1.16, 0.62), dry * 0.35);
    base *= 1.0 - 0.45 * mk.r;                                            // soil under the grass is in the blades' shade
    vec3 dirt = lum3(base) * vec3(1.1, 1.0, 0.84) * (0.8 + 0.3 * p1);
    float bare = smoothstep(0.66, 0.82, vn(xz * 0.07 + 2.0) * 0.7 + vn(xz * 0.6) * 0.3);
    float cov = 1.0 - smoothstep(0.3, 0.78, vAO);                         // under slabs / inside: bare dirt
    base = mix(base, dirt, max(bare * 0.7, cov));
    // the landscape seen from altitude: green and straw fields, then continuous woodland under the treeline belt
    // (from ~140-175 m out), so the gaps between the crown cards show woodland floor, not a yellow plain
    float big = vn(xz * 0.0045 + 11.0) * 0.7 + vn(xz * 0.017) * 0.3, rr = length(xz - vec2(-5.0, 10.0));
    base *= mix(vec3(1.05, 0.98, 0.86), vec3(0.8, 0.96, 0.72), smoothstep(0.35, 0.7, big));
    float wood = smoothstep(0.3, 0.42, vn(xz * 0.0065 + 3.7) * 0.75 + vn(xz * 0.04) * 0.25) * smoothstep(140.0, 175.0, rr);
    base = mix(base, vec3(0.058, 0.064, 0.027) * (0.62 + 0.38 * vn(xz * 0.13) + 0.3 * vn(xz * 0.5)), wood);
    float ap = smoothstep(0.42, 0.58, mk.g + (vn(xz * 0.9) - 0.5) * 0.34 + (vn(xz * 3.7) - 0.5) * 0.12);
    // asphalt: each ~5 m cell (wavy borders) turned by a random quarter turn and offset, so its one long crack never
    // lines up into a grid; textureGrad with the continuous, equally turned derivatives (no mip seams at the borders)
    vec2 auv = xz * uApronRep, wq = auv + 0.3 * vec2(vn(xz * 0.23), vn(xz * 0.23 + 9.0));
    vec2 cid = floor(wq); float rq = floor(h21(cid + 0.37) * 4.0);
    mat2 Rm = rq < 1.0 ? mat2(1.0, 0.0, 0.0, 1.0) : rq < 2.0 ? mat2(0.0, 1.0, -1.0, 0.0) : rq < 3.0 ? mat2(-1.0, 0.0, 0.0, -1.0) : mat2(0.0, -1.0, 1.0, 0.0);
    vec3 at = textureGrad(uApron, Rm * auv + vec2(h21(cid + 1.7), h21(cid + 5.3)), Rm * dFdx(auv), Rm * dFdy(auv)).rgb;   // (outside any branch)
    float al = lum3(at) / uAMean.w;
    vec3 asph = mix(at * uApronCol, uAMean.rgb, far);
    asph *= 0.8 + 0.35 * vn(xz * 0.11 + 4.0);                             // patches of old repair and stain
    float crack = (1.0 - smoothstep(0.4, 0.68, al)) * (1.0 - far);         // weeds and moss in the cracks
    asph = mix(asph, vec3(0.045, 0.06, 0.02), crack * 0.45);
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
// [B] grass lighting (perf #5): diffuse only. No specular environment (the cube-UV radiance taps) and no sun
// specular at roughness 0.92; the env irradiance still lights it (energy as the physical model's diffuse lobe).
// The sun is shadowed down the blades (vGv = height on the card): the field gets depth instead of full sun on every blade.
const GRASS_LIGHTS = `
#undef RE_Direct
#define RE_Direct RE_Direct_Grass
void RE_Direct_Grass( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
  reflectedLight.directDiffuse += dotNL * directLight.color * BRDF_Lambert( material.diffuseColor ) * mix( 0.3, 1.0, smoothstep( 0.05, 0.85, vGv ) );
}
#undef RE_IndirectSpecular
#define RE_IndirectSpecular RE_IndirectSpecular_Grass
void RE_IndirectSpecular_Grass( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  reflectedLight.indirectDiffuse += material.diffuseColor * irradiance * ( 0.95 * RECIPROCAL_PI );
}`;
const LIGHT_MAPS_DIFFUSE = `
#if defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
  iblIrradiance += getIBLIrradiance( geometryNormal );
#endif`;
function weatherPatch(mat, opt = {}, uniforms) {
  const kind = opt.kind || (opt.ground ? 'ground' : opt.foliage ? 'leaf' : 'built');
  const usesAY = kind === 'built' || kind === 'decal' || kind === 'bark';
  const weathers = kind === 'built' || kind === 'decal';
  const foliage = kind === 'leaf' || kind === 'grass' || kind === 'treeline';
  const wu = { uWx: { value: new THREE.Vector4(...(opt.w || [0.4, 0.3, 0.5, 0.3])) }, uWx2: { value: new THREE.Vector4(...(opt.wx || [1.7, 0, 0, 8])) },
    uRoughMin: { value: opt.roughMin ?? 0 }, ...(opt.uniforms || {}) };
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
${kind === 'decal' ? 'attribute float aSeed;\nvarying float vSeed;' : ''}
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
  ${usesAY ? 'vAY = aY;' : ''}
  ${kind === 'decal' ? 'vSeed = aSeed;' : ''}`);
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
${kind === 'decal' ? 'uniform sampler2D uWallTex; uniform float uWallRep; uniform float uWallMean; varying float vSeed;' : ''}
${kind === 'ground' || kind === 'track' ? 'uniform sampler2D uMask; uniform vec2 uMaskO; uniform float uMaskS;' : ''}
${kind === 'ground' ? 'uniform sampler2D uApron; uniform float uApronRep; uniform vec3 uApronCol; uniform vec3 uGMean; uniform vec4 uAMean;' : ''}
${opt.fsHead || ''}`)
      .replace('#include <map_fragment>', `${kind === 'decal' ? WP_FRAG.decalMap : '#include <map_fragment>'}
${kind === 'track' ? '' : WP_FRAG[kind]}
${opt.fsMap || ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
${kind === 'track' ? WP_FRAG.track : ''}`)
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
${foliage ? `#ifdef DOUBLE_SIDED
  { vec3 fdn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));      // cards seen edge-on fade out (no planks):
    diffuseColor.a *= smoothstep(${kind === 'grass' ? '0.22, 0.5' : '0.12, 0.38'}, abs(dot(fdn, normalize(vViewPosition)))); }   // 2 of 3 tuft cards always face >= 0.5
  ${kind === 'leaf' ? 'diffuseColor.a *= smoothstep(0.25, 0.8, length(vViewPosition));      // leaves at the lens fade (no crisp cards, less overdraw)' : ''}
#endif` : ''}
${opt.fsAlpha || ''}`)
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>
${opt.fsLights || ''}`)
      .replace('#include <lights_fragment_maps>', opt.diffuseOnly ? LIGHT_MAPS_DIFFUSE : '#include <lights_fragment_maps>')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = max(roughnessFactor, uRoughMin);`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
${foliage ? `#ifdef DOUBLE_SIDED
  normal *= faceDirection; nonPerturbedNormal = normal;     // cards are lit like the canopy/ground they belong to, both faces
#endif` : ''}`)
      .replace('#include <aomap_fragment>', `reflectedLight.indirectDiffuse = reflectedLight.indirectDiffuse * vAO + vBounce * BRDF_Lambert(material.diffuseColor);
  reflectedLight.indirectSpecular *= vAO * vAO;
#include <aomap_fragment>`);
    if (opt.fsFog) sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', `${opt.fsFog}\n#include <fog_fragment>`);   // before, never instead of
    // [A-lighting] begin: baked sun/sky bounce, sun mask, far shadow map, forward-scatter haze (see aLightingPatch)
    aLightingPatch(sh, uniforms, mat, kind);   // [A1] + material (lightmap flag) and kind (SSAO surfaces)
    aSkyShadowPatch(sh, uniforms);   // [A2] treeline ring shadow map, multiplied into aLightingPatch's sun shadow
    // [A-lighting] end
  };
  return mat;
}

// [B] contract C2: depth-only material for the shutter blur's depth pass. It writes exactly what fpvcam.depthMat
// writes, d = clamp(log2(max(vZ, 0.02) / 0.02) / 12.28771238, 0, 1) -> vec4(floor(d * 255) / 255, fract(d * 255), 0, 1),
// and is alpha-tested like the visible material (the same mip-boosted alpha, edge-on fade, and near fade for leaves).
function depthC2Mat({ vsHead = '', vsMain = '', uniforms = {}, alphaTex = null, alphaCh = 0, alphaTest = 0.4, texN = 512, edge = [0.12, 0.38], near = false }) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uAlphaTex: { value: alphaTex }, uAlphaCh: { value: alphaCh }, uAT: { value: alphaTest }, uTexN: { value: texN }, uEdge: { value: new THREE.Vector2(...edge) } },
    vertexShader: `uniform float uTime;
${vsHead}
varying vec2 vUv;
varying vec3 vVP;
void main() {
  vec3 transformed = position;
  ${vsMain}
  vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
  vVP = -mv.xyz; gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: `uniform sampler2D uAlphaTex; uniform float uAlphaCh; uniform float uAT; uniform float uTexN; uniform vec2 uEdge;
varying vec2 vUv;
varying vec3 vVP;
void main() {
  vec4 t = texture2D(uAlphaTex, vUv); float a = mix(t.a, t.g, uAlphaCh);
  vec2 tx = vUv * uTexN; a *= 1.0 + 0.3 * clamp(0.5 * log2(min(dot(dFdx(tx), dFdx(tx)), dot(dFdy(tx), dFdy(tx)))), 0.0, 3.0);
  vec3 fdn = normalize(cross(dFdx(vVP), dFdy(vVP))); a *= smoothstep(uEdge.x, uEdge.y, abs(dot(fdn, normalize(vVP))));
  ${near ? 'a *= smoothstep(0.25, 0.8, length(vVP));' : ''}
  if (a < uAT) discard;
  float vZ = vVP.z;
  float d = clamp(log2(max(vZ, 0.02) / 0.02) / 12.28771238, 0.0, 1.0); float hi = floor(d * 255.0) / 255.0;
  gl_FragColor = vec4(hi, fract(d * 255.0), 0.0, 1.0);
}`,
    side: THREE.DoubleSide,
  });
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
  if (r.out) LP.out.set(r.out[0], r.out[1], r.out[2]);   // [A1] lightmap probe: final units already
  else LP.out.set(r.bs[0] * LP.sunRGB.x + r.bk[0] * LP.skyRGB.x, r.bs[1] * LP.sunRGB.y + r.bk[1] * LP.skyRGB.y, r.bs[2] * LP.sunRGB.z + r.bk[2] * LP.skyRGB.z);
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
    uFarOn: { value: 0 }, uFarTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) }, uSunW: { value: new THREE.Vector3(0, 1, 0) }, uHaze: { value: 1.2 },
    // [A1] committed lightmap (see lmLoad): indirect irradiance, aux = (openness, sun mask), log2 range, live scale
    uLM: { value: null }, uLMAux: { value: null }, uLMRange: { value: new THREE.Vector2(-12, 3) }, uLMScale: { value: new THREE.Vector3(1, 1, 1) } };
}
// [A1] contract C3: SSAO from stream D. world.aoUniforms; D fills uAO (the SSAO texture), uAOOn and uAOScale (1 / the
// scene RT size in pixels) every frame, so texture(uAO, gl_FragCoord.xy * uAOScale).r is the AO under this pixel.
// Indirect diffuse x mix(1, ao, 0.8) on the surfaces that are in D's depth pass (not foliage, grass, treeline).
function aoUniforms() { return { uAO: { value: null }, uAOOn: { value: 0 }, uAOScale: { value: new THREE.Vector2(1, 1) } }; }
const AO_KINDS = new Set(['built', 'ground', 'track', 'bark', 'decal']);
const A_DIR_LINE = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
const A_LIGHTS_BEGIN = THREE.ShaderChunk.lights_fragment_begin.includes(A_DIR_LINE)
  ? THREE.ShaderChunk.lights_fragment_begin.replace(A_DIR_LINE, A_DIR_LINE.replace('? getShadow(', '? aDirShadow( getShadow(').replace(' ) : 1.0;', ' ), vDirectionalShadowCoord[ i ] ) : 1.0;'))
  : null;
if (!A_LIGHTS_BEGIN) console.warn('[A-lighting] three lights_fragment_begin changed: far shadows + sun mask disabled');
function aLightingPatch(sh, uniforms, mat, kind) {
  const U = uniforms?.aLight; if (!U) return;
  // [A1] lightmapped material (mat.userData.aLM, set by lmEnable with its own program key): the indirect diffuse is
  // the committed lightmap, vAO (B's weathering + specular occlusion) its aux openness, the sun mask its aux.g
  const lm = !!(mat?.userData?.aLM && U.uLM.value), AO = uniforms.aAO, ssao = !!AO && AO_KINDS.has(kind);
  Object.assign(sh.uniforms, U); if (AO) Object.assign(sh.uniforms, AO);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>
attribute vec3 aBSun;
attribute vec3 aBSky;
attribute float aSunOcc;
uniform vec3 uSunB;
uniform vec3 uSkyB;
uniform mat4 uFarMat;
varying vec3 vBounceA;
varying vec4 vFarC;
${lm ? `#ifndef USE_UV2
attribute vec2 uv2;
#endif
centroid varying vec2 vLmUv;` : ''}`)
    .replace('#include <fog_vertex>', `#include <fog_vertex>
  vBounceA = aBSun * uSunB + aBSky * uSkyB;${lm ? '\n  vLmUv = uv2;' : ''}
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
${ssao ? `uniform sampler2D uAO;
uniform float uAOOn;
uniform vec2 uAOScale;
float aSSAO() { return uAOOn > 0.5 ? mix( 1.0, texture2D( uAO, gl_FragCoord.xy * uAOScale ).r, 0.8 ) : 1.0; }` : 'float aSSAO() { return 1.0; }'}
${lm ? `uniform sampler2D uLM;
uniform sampler2D uLMAux;
uniform vec2 uLMRange;
uniform vec3 uLMScale;
centroid varying vec2 vLmUv;
float aLmAO;
vec4 aLmX;
vec3 aLmIrr() { return exp2( mix( vec3( uLMRange.x ), vec3( uLMRange.y ), texture2D( uLM, vLmUv ).rgb ) ) * uLMScale; }` : ''}
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
  return s * smoothstep( 0.05, 0.4, ${lm ? 'aLmX.g' : 'vFarC.w'} );
}`)
    .replace('#include <aomap_fragment>', `${lm ? 'reflectedLight.indirectDiffuse = aLmIrr() * BRDF_Lambert( material.diffuseColor ) * aSSAO();'
      : 'reflectedLight.indirectDiffuse += vBounceA * BRDF_Lambert( material.diffuseColor );\n  reflectedLight.indirectDiffuse *= aSSAO();'}
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
  if (lm) {   // vAO -> the lightmap's openness from here on (after B's `varying float vAO;`, before any use in main)
    if (!sh.fragmentShader.includes('void main() {')) console.warn('[A1] fragment main() not found: lightmap openness not applied');
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', `#define vAO aLmAO
void main() {
  aLmX = texture2D( uLMAux, vLmUv ); aLmAO = aLmX.r;`);
  }
}

// ---------------------------------------------------------------- [A1] lightmap UV2: deterministic charts + skyline packer
// Every lightmapped mesh (the merged structures, the yard terrain, the path ribbons) gets a `uv2` attribute into one
// atlas. Charts: triangles that share a welded edge, a continuous `uv` (the metric planar / cylinder unwrap every Site
// part already carries) and normals within 60 deg are one chart, unwrapped by that uv. A chart whose uv is degenerate,
// flipped or stretched (> 2.2x) is re-charted into near-planar patches (25 deg from a seed) projected on their plane.
// A chart maps its texel centres onto its edges (neighbouring charts sample the same seam points) inside a 1-texel
// gutter. Terrain = one top-down chart, packed first; then the rest, tallest first, bottom-left on a skyline. The
// structure texel starts at LMUV.texel and coarsens 8 % per try until the atlas fits W x maxH. Pure function of the
// geometry, append-only: vertices shared by two charts are duplicated at the END of a geometry (the bake's
// collider->render vertex map stays valid). tools/bakelm.mjs gets the chart detail via { detail: true }.
export const LMUV = { ver: 1, W: 2048, maxH: 2048, texel: 0.2, terrTexel: 0.25 };
function lmWeld(p, NV) {
  const wid = new Int32Array(NV), head = new Map(), nxt = new Int32Array(NV), wq = []; let nw = 0;
  for (let v = 0; v < NV; v++) {
    const x = Math.round(p[v * 3] * 1000), y = Math.round(p[v * 3 + 1] * 1000), z = Math.round(p[v * 3 + 2] * 1000);
    const h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
    let w = head.has(h) ? head.get(h) : -1;
    while (w >= 0 && !(wq[w * 3] === x && wq[w * 3 + 1] === y && wq[w * 3 + 2] === z)) w = nxt[w];
    if (w < 0) { w = nw++; wq.push(x, y, z); nxt[w] = head.has(h) ? head.get(h) : -1; head.set(h, w); }
    wid[v] = w;
  }
  return { wid, nw };
}
function lmCharts(g) {
  const idx = g.index.array, p = g.attributes.position.array, uv = g.attributes.uv.array, NT = idx.length / 3, NV = p.length / 3;
  const { wid, nw } = lmWeld(p, NV);
  const tn = new Float64Array(NT * 3), ta = new Float64Array(NT), tuv = new Float64Array(NT);
  for (let t = 0; t < NT; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    ta[t] = l / 2; if (l > 0) { tn[t * 3] = nx / l; tn[t * 3 + 1] = ny / l; tn[t * 3 + 2] = nz / l; }
    tuv[t] = ((uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) - (uv[c * 2] - uv[a * 2]) * (uv[b * 2 + 1] - uv[a * 2 + 1])) / 2;
  }
  const dotN = (s, t) => tn[s * 3] * tn[t * 3] + tn[s * 3 + 1] * tn[t * 3 + 1] + tn[s * 3 + 2] * tn[t * 3 + 2];
  // welded edges -> the triangles on them
  const edges = new Map(), eKey = (a, b) => (a < b ? a * nw + b : b * nw + a);
  for (let t = 0; t < NT; t++) for (let e = 0; e < 3; e++) {
    const k = eKey(wid[idx[t * 3 + e]], wid[idx[t * 3 + (e + 1) % 3]]), l = edges.get(k);
    if (l === undefined) edges.set(k, t * 3 + e); else if (typeof l === 'number') edges.set(k, [l, t * 3 + e]); else l.push(t * 3 + e);
  }
  const par = new Int32Array(NT); for (let t = 0; t < NT; t++) par[t] = t;
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const uvEq = (i, j) => Math.abs(uv[i * 2] - uv[j * 2]) < 1e-3 && Math.abs(uv[i * 2 + 1] - uv[j * 2 + 1]) < 1e-3;
  const e1 = (te) => idx[te - (te % 3) + ((te % 3) + 1) % 3];   // second endpoint of edge te (= tri * 3 + e)
  const sameUV = (te, se) => {   // the uv agrees at both welded endpoints of the shared edge
    const a0 = idx[te], a1 = e1(te), b0 = idx[se], b1 = e1(se);
    return wid[a0] === wid[b0] ? uvEq(a0, b0) && uvEq(a1, b1) : uvEq(a0, b1) && uvEq(a1, b0);
  };
  for (const l of edges.values()) {
    if (typeof l === 'number') continue;
    for (let i = 1; i < l.length; i++) for (let j = 0; j < i; j++) {
      const s = (l[i] / 3) | 0, t = (l[j] / 3) | 0;
      if (ta[s] > 0 && ta[t] > 0 && dotN(s, t) > 0.5 && sameUV(l[i], l[j])) { const rs = find(s), rt = find(t); if (rs !== rt) par[Math.max(rs, rt)] = Math.min(rs, rt); }
    }
  }
  // validate each uv chart: one orientation, linear stretch within 1/2.2 .. 2.2, no overlap by area
  const groups = new Map(); for (let t = 0; t < NT; t++) { const r = find(t); let a = groups.get(r); if (!a) groups.set(r, (a = [])); a.push(t); }
  const charts = [], triChart = new Int32Array(NT).fill(-1), bad = [];
  for (const tris of groups.values()) {
    let pos = 0, neg = 0, ok = true, sA = 0, u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const t of tris) {
      if (!(ta[t] > 1e-7)) continue;
      const r = Math.abs(tuv[t]) / ta[t]; if (r < 0.2 || r > 4.84) { ok = false; break; }
      if (tuv[t] > 0) pos += ta[t]; else neg += ta[t];
      sA += Math.abs(tuv[t]);
      for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k], u = uv[v * 2], w = uv[v * 2 + 1]; if (u < u0) u0 = u; if (u > u1) u1 = u; if (w < v0) v0 = w; if (w > v1) v1 = w; }
    }
    if (ok && pos > 0 && neg > 0) ok = false;
    if (ok && sA > (u1 - u0) * (v1 - v0) * 1.001 + 1e-6) ok = false;
    if (!ok) { bad.push(...tris); continue; }
    const c = charts.length; charts.push({ tris, kind: 0 }); for (const t of tris) triChart[t] = c;
  }
  // re-chart the rest: near-planar patches grown from the lowest triangle index, projected on the seed plane
  if (bad.length) {
    bad.sort((a, b) => a - b);
    const isBad = new Uint8Array(NT); for (const t of bad) isBad[t] = 1;
    for (const seed of bad) {
      if (triChart[seed] >= 0) continue;
      const c = charts.length, tris = [seed], nx = tn[seed * 3], ny = tn[seed * 3 + 1], nz = tn[seed * 3 + 2]; triChart[seed] = c;
      for (let q = 0; q < tris.length; q++) {
        const t = tris[q];
        for (let e = 0; e < 3; e++) {
          const l = edges.get(eKey(wid[idx[t * 3 + e]], wid[idx[t * 3 + (e + 1) % 3]])); if (typeof l !== 'object') continue;
          for (const se of l) { const s = (se / 3) | 0; if (isBad[s] && triChart[s] < 0 && ta[s] > 0 && tn[s * 3] * nx + tn[s * 3 + 1] * ny + tn[s * 3 + 2] * nz > 0.906) { triChart[s] = c; tris.push(s); } }
        }
      }
      // basis: horizontal tangent for walls, x/z for floors (tight boxes on the axis-aligned world)
      let ax, ay, az; if (Math.abs(ny) > 0.9 || !(ta[seed] > 0)) { ax = 1; ay = 0; az = 0; } else { const l = Math.hypot(nz, nx); ax = nz / l; ay = 0; az = -nx / l; }
      if (Math.abs(ny) > 0.9 || !(ta[seed] > 0)) { const d = ax * nx; ax -= d * nx; ay -= d * ny; az -= d * nz; const l = Math.hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l; }
      const bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax;
      tris.sort((a, b) => a - b);
      charts.push({ tris, kind: 1, basis: [ax, ay, az, bx, by, bz] });
    }
  }
  return { charts, triChart, NT, NV };
}
// skyline bottom-left packer (deterministic): rects [{w, h}] -> sets r.x, r.y; returns the used height or -1
function lmPack(rects, W, maxH) {
  let sky = [[0, 0, W]];   // [x, y, width] segments, left to right
  let top = 0;
  for (const r of rects) {
    let best = -1, bx = 0, by = Infinity;
    for (let i = 0; i < sky.length; i++) {
      const x = sky[i][0]; if (x + r.w > W) break;
      let y = 0, wl = r.w, j = i;
      while (wl > 0) { y = Math.max(y, sky[j][1]); wl -= sky[j][2]; j++; if (wl > 0 && j >= sky.length) { y = Infinity; break; } }
      if (y < by || (y === by && x < bx)) { by = y; bx = x; best = i; }
    }
    if (best < 0 || by + r.h > maxH) return -1;
    r.x = bx; r.y = by; top = Math.max(top, by + r.h);
    // replace the covered span [bx, bx + w) with one segment at by + h (segments stay sorted and contiguous)
    const ns = [], x1 = bx + r.w, nh = by + r.h; let put = false;
    for (const s of sky) {
      const s0 = s[0], s1 = s[0] + s[2];
      if (s1 <= bx) { ns.push(s); continue; }
      if (s0 >= x1) { if (!put) { ns.push([bx, nh, r.w]); put = true; } ns.push(s); continue; }
      if (s0 < bx) ns.push([s0, s[1], bx - s0]);
      if (!put) { ns.push([bx, nh, r.w]); put = true; }
      if (s1 > x1) ns.push([x1, s[1], s1 - x1]);
    }
    if (!put) ns.push([bx, nh, r.w]);
    sky = [];   // merge equal-height neighbours
    for (const s of ns) { const l = sky[sky.length - 1]; if (l && l[1] === s[1] && l[0] + l[2] === s[0]) l[2] += s[2]; else sky.push(s.slice()); }
  }
  return top;
}
export function lightmapUV2(merged, terr, pathG, opt = {}) {
  const W = LMUV.W, entries = Object.entries(merged), out = { ver: LMUV.ver, W, H: 0, texel: 0, terrTexel: LMUV.terrTexel, geos: [] };
  // charts per merged geometry; per (vertex, chart) one uv2 vertex (duplicates appended at the end)
  const all = [];
  for (const [key, g] of entries) {
    const C = lmCharts(g), idx = g.index.array, NV0 = g.attributes.position.count;
    const vChart = new Int32Array(NV0).fill(-1), dup = new Map(), extra = [];
    for (let t = 0; t < C.NT; t++) for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k], c = C.triChart[t];
      if (vChart[v] < 0 || vChart[v] === c) { vChart[v] = c; continue; }
      const dk = v * 65536 + c; let nv = dup.get(dk);   // (c < 65536 charts per geometry)
      if (nv === undefined) { nv = NV0 + extra.length; extra.push(v); dup.set(dk, nv); }
      idx[t * 3 + k] = nv;
    }
    if (extra.length) {   // append the duplicated vertices (every attribute copied)
      for (const [name, a] of Object.entries(g.attributes)) {
        const n = a.itemSize, arr = new a.array.constructor((NV0 + extra.length) * n); arr.set(a.array.subarray(0, NV0 * n));
        extra.forEach((v, i) => { for (let c = 0; c < n; c++) arr[(NV0 + i) * n + c] = a.array[v * n + c]; });
        g.setAttribute(name, new THREE.BufferAttribute(arr, n, a.normalized));
      }
      g.index.needsUpdate = true;
    }
    const NV = g.attributes.position.count, vc = new Int32Array(NV).fill(-1);
    for (let t = 0; t < C.NT; t++) for (let k = 0; k < 3; k++) vc[idx[t * 3 + k]] = C.triChart[t];
    // chart parameter (metres) per vertex: its uv, or the seed-plane projection
    const p = g.attributes.position.array, uv = g.attributes.uv.array, par = new Float64Array(NV * 2);
    for (let v = 0; v < NV; v++) {
      const ch = C.charts[vc[v]]; if (!ch) continue;
      if (ch.kind === 0) { par[v * 2] = uv[v * 2]; par[v * 2 + 1] = uv[v * 2 + 1]; }
      else { const b = ch.basis; par[v * 2] = p[v * 3] * b[0] + p[v * 3 + 1] * b[1] + p[v * 3 + 2] * b[2]; par[v * 2 + 1] = p[v * 3] * b[3] + p[v * 3 + 1] * b[4] + p[v * 3 + 2] * b[5]; }
    }
    for (const ch of C.charts) {
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (const t of ch.tris) for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k], a = par[v * 2], b = par[v * 2 + 1]; if (a < u0) u0 = a; if (a > u1) u1 = a; if (b < v0) v0 = b; if (b > v1) v1 = b; }
      ch.u0 = u0; ch.v0 = v0; ch.du = Math.round((u1 - u0) * 1e4) / 1e4; ch.dv = Math.round((v1 - v0) * 1e4) / 1e4;
      all.push(ch);
    }
    out.geos.push({ key, g, C, vc, par });
  }
  // terrain: one top-down chart over its x/z extent
  const tp = terr.attributes.position.array; let tx0 = Infinity, tz0 = Infinity, tx1 = -Infinity, tz1 = -Infinity;
  for (let i = 0; i < tp.length; i += 3) { tx0 = Math.min(tx0, tp[i]); tx1 = Math.max(tx1, tp[i]); tz0 = Math.min(tz0, tp[i + 2]); tz1 = Math.max(tz1, tp[i + 2]); }
  const tn = Math.round(Math.max(tx1 - tx0, tz1 - tz0) / LMUV.terrTexel) + 1, tRect = { w: tn + 2, h: tn + 2, terr: true };
  // texel size: coarsen until it packs
  let texel = LMUV.texel, H = -1, rects;
  for (let tries = 0; ; tries++) {
    const s = 1 / texel;
    rects = all.map((ch, i) => {
      const nx = Math.round(ch.du * s) + 1, ny = Math.round(ch.dv * s) + 1, rot = ny > nx;
      return { ch, i, nx, ny, rot, w: (rot ? ny : nx) + 2, h: (rot ? nx : ny) + 2 };
    });
    rects.sort((a, b) => b.h - a.h || b.w - a.w || a.i - b.i);
    H = lmPack([tRect, ...rects], W, LMUV.maxH);
    if (H >= 0) break;
    if (tries > 24) throw new Error('[A1] lightmap atlas overflow');
    texel = Math.round(texel * 1.08 * 1e5) / 1e5;
  }
  H = Math.ceil(H / 8) * 8; out.H = H; out.texel = texel;
  out.terr = { x0: tx0, z0: tz0, n: tn, ox: tRect.x, oy: tRect.y, s: (tn - 1) / Math.max(tx1 - tx0, tz1 - tz0) };
  for (const r of rects) { const ch = r.ch; ch.ox = r.x; ch.oy = r.y; ch.rot = r.rot; ch.nx = r.nx; ch.ny = r.ny; ch.sx = r.nx > 1 ? (r.nx - 1) / ch.du : 0; ch.sy = r.ny > 1 ? (r.ny - 1) / ch.dv : 0; }
  // write uv2 (texel centres: chart edges land on the first/last texel centre)
  for (const G of out.geos) {
    const { g, C, vc, par } = G, NV = g.attributes.position.count, a = new Float32Array(NV * 2);
    for (let v = 0; v < NV; v++) {
      const ch = C.charts[vc[v]]; if (!ch) continue;
      const cu = 1.5 + (par[v * 2] - ch.u0) * ch.sx, cv = 1.5 + (par[v * 2 + 1] - ch.v0) * ch.sy;
      a[v * 2] = (ch.ox + (ch.rot ? cv : cu)) / W; a[v * 2 + 1] = (ch.oy + (ch.rot ? cu : cv)) / H;
    }
    g.setAttribute('uv2', new THREE.BufferAttribute(a, 2));
  }
  const T = out.terr, terrUV2 = (geo) => {
    const q = geo.attributes.position.array, n = q.length / 3, a = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const cu = Math.min(T.n + 0.5, Math.max(1.5, 1.5 + (q[i * 3] - T.x0) * T.s)), cv = Math.min(T.n + 0.5, Math.max(1.5, 1.5 + (q[i * 3 + 2] - T.z0) * T.s));
      a[i * 2] = (T.ox + cu) / W; a[i * 2 + 1] = (T.oy + cv) / H;
    }
    geo.setAttribute('uv2', new THREE.BufferAttribute(a, 2));
  };
  terrUV2(terr); if (pathG) terrUV2(pathG);
  out.charts = all.length;
  if (!opt.detail) delete out.geos;
  return out;
}
// geometry hash of what the lightmaps depend on: per lightmapped mesh (merged materials in order, then the terrain)
// its name (= material assignment), vertex count, position, normal, uv2 and index, plus the atlas layout. Cosmetic
// attributes (uv, aY) are left out, so surface retunes don't stale the bake. Algorithm "mm3x2/1" = tools/geohash.mjs
// (stream G), inlined so the runtime doesn't load anything from tools/: same words, same value (bakelm.mjs checks).
// G's export-world.mjs records it as world.json hash.worldBando; lm.json stores it as `hash`. ~5 ms.
const _C1 = 0xcc9e2d51, _C2 = 0x1b873593, _rotl = (x, r) => (x << r) | (x >>> (32 - r));
const _fmix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
class GeoHash {
  constructor() { this.a = 0x9747b28c | 0; this.b = 0x2f0f5d1b | 0; this.n = 0; }
  word(w) { this._w(w); return this; }
  str(s) { s = String(s); this.word(s.length); for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i)); return this; }
  array(arr) {   // typed arrays only: count, then Float32 bit patterns / integer values
    const n = arr.length; this._w(n);
    const w = arr instanceof Float32Array ? new Uint32Array(arr.buffer, arr.byteOffset, n) : arr;
    for (let i = 0; i < n; i++) this._w(w[i]);
    return this;
  }
  _w(x) {
    let k = Math.imul(x | 0, _C1); k = _rotl(k, 15); k = Math.imul(k, _C2);
    let a = this.a ^ k; a = _rotl(a, 13); this.a = (Math.imul(a, 5) + 0xe6546b64) | 0;
    let b = this.b ^ k; b = _rotl(b, 13); this.b = (Math.imul(b, 5) + 0xe6546b64) | 0;
    this.n++;
  }
  hex() { const a = _fmix((this.a ^ this.n) >>> 0), b = _fmix((this.b ^ this.n) >>> 0); return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'); }
}
// what tools/bakelm.mjs needs from module scope: the bake's albedo rules (same as bakeLight's) and constants
export function lmBakeInputs(geo) {
  const fps = geo.site.footprints || [], ap = MATS.apron?.albedo, rad = MATS.apron?.radius ?? 9, gA = groundAlbedo(), pA = albedoOf('path');
  return {
    albedo: Object.fromEntries(Object.keys(geo.merged).map((k) => [k, albedoOf(k)])), ground: gA, leaf: MATS.leaf?.albedo ?? [0.1, 0.12, 0.04],
    terrainAlbedo: (x, z) => (ap && fps.some((f) => Math.max(f.x0 - x, 0, x - f.x1) ** 2 + Math.max(f.z0 - z, 0, z - f.z1) ** 2 < rad * rad) ? ap : distToPaths(x, z) < 2.6 ? pA : gA),
    envI: 0.85, aoExp: 1.15, PH,
  };
}
export function geometryHash(geo) {
  const lay = geo.terr.userData.lm, h = new GeoHash().str('lightmap').str(`${lay.ver}:${lay.W}x${lay.H}:${lay.texel}:${lay.terrTexel}`);
  const list = [...Object.entries(geo.merged), ['terr', geo.terr]];
  h.word(list.length);
  for (const [name, g] of list) {
    h.str(name).word(g.attributes.position.count);
    for (const k of ['position', 'normal', 'uv2']) h.str(k).word(g.attributes[k].itemSize).array(g.attributes[k].array);
    h.str('index').array(g.index.array);
  }
  return h.hex();
}

// ---------------------------------------------------------------- [A1] runtime: the committed lightmaps
// lm.json (tools/bakelm.mjs) is fetched while the geometry builds. If its hash equals geometryHash() and its sun
// direction equals this sky's, buildBando loads lm_<sky>.png + lm_aux.png and skips bakeLight (the 2-4 s per-vertex
// bake); otherwise (other streams changed the geometry, no files, a load error) it bakes per vertex exactly as before.
// Decals and foliage still probe the light at load (lightProbe); the lightmap probe below answers those queries:
// openness = the same rays as bakeLight's probe (so foliage placement is identical on both paths), bounce = albedo x
// (lightmap + direct sun) at the ray hits.
const lmURL = (f) => new URL(f, import.meta.url).href;
async function lmFetchJSON() {
  try { const r = await fetch(lmURL('lm.json'), { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch (e) { return null; }
}
export function lmMatch(j, geo, sky, sunDir) {
  if (!j || j.version !== 1) return { ok: false, why: j ? `lm.json version ${j.version}` : 'no lm.json' };
  const s = j.skies?.[sky]; if (!s) return { ok: false, why: `no ${sky} lightmap` };
  const h = geometryHash(geo), lay = geo.terr.userData.lm;
  if (h !== j.hash) return { ok: false, why: `geometry hash ${h} != lm.json ${j.hash}` };
  if (j.W !== lay.W || j.H !== lay.H) return { ok: false, why: 'atlas size' };
  const L = s.sunDir || [0, 1, 0], d = Math.hypot(L[0] - sunDir.x, L[1] - sunDir.y, L[2] - sunDir.z);
  if (d > 2e-3) return { ok: false, why: `sun direction moved (${d.toFixed(4)}): re-run node tools/bakelm.mjs` };
  return { ok: true, j, s, hash: h };
}
async function lmImage(file, cpu) {
  const r = await fetch(lmURL(file)); if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  const blob = await r.blob();
  let img;
  if (typeof createImageBitmap === 'function') img = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  else { img = new Image(); img.src = URL.createObjectURL(blob); await img.decode(); }
  const tex = new THREE.Texture(img);
  tex.flipY = false; tex.colorSpace = THREE.NoColorSpace; tex.generateMipmaps = false; tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.premultiplyAlpha = false; tex.needsUpdate = true;
  let pix = null;
  if (cpu) {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(img.width, img.height) : Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
    const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0); pix = cx.getImageData(0, 0, img.width, img.height).data;
  }
  return { tex, pix, w: img.width, h: img.height };
}
async function lmLoad(m) {
  const [irr, aux] = await Promise.all([lmImage(m.s.file, true), lmImage(m.j.aux?.file || 'lm_aux.png', false)]);
  if (irr.w !== m.j.W || irr.h !== m.j.H || aux.w !== m.j.W || aux.h !== m.j.H) throw new Error('lightmap size mismatch');
  return { ...m, irr, aux };
}
// CPU side of the shader's lookup: bilinear on the encoded bytes, then decoded (exactly what the GPU does)
function lmSampler(lm) {
  const { pix } = lm.irr, W = lm.j.W, H = lm.j.H, [lo, hi] = lm.s.range, k = (hi - lo) / 255;
  return (u, v, out) => {
    const x = Math.min(W - 1.001, Math.max(0, u * W - 0.5)), y = Math.min(H - 1.001, Math.max(0, v * H - 0.5)), x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
    for (let c = 0; c < 3; c++) {
      const e = (pix[i00 + c] * (1 - fx) + pix[i10 + c] * fx) * (1 - fy) + (pix[i01 + c] * (1 - fx) + pix[i11 + c] * fx) * fy;
      out[c] = Math.pow(2, lo + e * k);
    }
    return out;
  };
}
// the lightmap as the build-time light probe (BAKE interface of bakeLight: probe, applyTo, stats)
function lmProbeBake(geo, L, sun, lm) {
  const t0 = performance.now(), { site, merged, terr, colGeo, bvh } = geo;
  const list = [...Object.entries(merged), ['terr', terr]], base = []; let NV = 0;
  for (const [, g] of list) { base.push(NV); NV += g.attributes.position.count; }
  const { map: c2r } = colliderMap(site, terr, colGeo, list, base);
  const uv2 = new Float32Array(NV * 2), pos = new Float32Array(NV * 3), alb = new Float32Array(NV * 3);
  const fps = site.footprints || [], ap = MATS.apron?.albedo, rad = MATS.apron?.radius ?? 9, gA = groundAlbedo(), pA = albedoOf('path');
  list.forEach(([k, g], gi) => {
    uv2.set(g.attributes.uv2.array, base[gi] * 2); pos.set(g.attributes.position.array, base[gi] * 3);
    const a = albedoOf(k), p = g.attributes.position.array;
    for (let i = 0; i < g.attributes.position.count; i++) {
      const v = base[gi] + i, x = p[i * 3], z = p[i * 3 + 2];
      const q = k !== 'terr' ? a : ap && fps.some((f) => Math.max(f.x0 - x, 0, x - f.x1) ** 2 + Math.max(f.z0 - z, 0, z - f.z1) ** 2 < rad * rad) ? ap : distToPaths(x, z) < 2.6 ? pA : gA;
      alb[v * 3] = q[0]; alb[v * 3 + 1] = q[1]; alb[v * 3 + 2] = q[2];
    }
  });
  const smp = lmSampler(lm), W = lm.j.W, E = [0, 0, 0], pats = {}, D = new THREE.Vector3(), Q = new THREE.Vector3(), hn = new THREE.Vector3(), up = new THREE.Vector3();
  const sunMax = Math.min(400, 70 / Math.max(0.1, L.y) + 10);
  const sunVis = (o) => { _sr.origin.copy(o); _sr.direction.copy(L); return !bvh.raycastFirst(_sr, THREE.DoubleSide, 0, sunMax); };
  // uv2 at a collider hit: the render vertices of its corners (null when they lie in different charts: a vertex
  // that lightmapUV2 duplicated, rare)
  const uvAt = (hit, out) => {
    const a = c2r[hit.face.a], b = c2r[hit.face.b], c = c2r[hit.face.c]; if (a < 0 || b < 0 || c < 0) return -1;
    const wb = hit.barycoord.y, wc = hit.barycoord.z, wa = 1 - wb - wc;
    const span = Math.max(Math.abs(uv2[a * 2] - uv2[b * 2]), Math.abs(uv2[a * 2] - uv2[c * 2]), Math.abs(uv2[a * 2 + 1] - uv2[b * 2 + 1]), Math.abs(uv2[a * 2 + 1] - uv2[c * 2 + 1])) * W;
    const ext = Math.max(Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]), Math.hypot(pos[a * 3] - pos[c * 3], pos[a * 3 + 1] - pos[c * 3 + 1], pos[a * 3 + 2] - pos[c * 3 + 2]));
    if (span > ext * 7 + 4) return -1;
    out[0] = wa * uv2[a * 2] + wb * uv2[b * 2] + wc * uv2[c * 2]; out[1] = wa * uv2[a * 2 + 1] + wb * uv2[b * 2 + 1] + wc * uv2[c * 2 + 1];
    return a;
  };
  const UV = [0, 0];
  const probe = (P, N, n = 8, maxD = 26) => {
    n = Math.min(64, n); const pat = (pats[n] ||= cosPattern(n));
    // the frame, pattern, origin and range of bakeLight's trace(): identical openness on both paths
    up.set(...(Math.abs(N.y) < 0.95 ? [0, 1, 0] : [1, 0, 0]));
    _bx.crossVectors(up, N).normalize(); _by.crossVectors(N, _bx);
    let nOpen = 0; const out = [0, 0, 0];
    for (let k = 0; k < pat.length; k++) {
      const [a, b, c] = pat[k];
      D.set(0, 0, 0).addScaledVector(_bx, a).addScaledVector(N, b).addScaledVector(_by, c).normalize();
      _ray.origin.copy(P).addScaledVector(N, 0.06); _ray.direction.copy(D);
      const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, maxD);
      if (!hit) { nOpen++; continue; }
      hn.copy(hit.face.normal); if (hn.dot(D) > 0) hn.negate();
      let es = 0; if (sun) { const cs = hn.dot(L); if (cs > 0 && sunVis(Q.copy(hit.point).addScaledVector(hn, 0.05))) es = cs; }
      const v = uvAt(hit, UV);
      if (v >= 0) { smp(UV[0], UV[1], E); for (let q = 0; q < 3; q++) out[q] += alb[v * 3 + q] * (E[q] + es * LP.sunRGB.getComponent(q)); }
      else { const ga = hit.point.y < terrainHeight(hit.point.x, hit.point.z) + 0.35 ? gA : ALB_DEFAULT, sk = 0.5 + 0.5 * hn.y; for (let q = 0; q < 3; q++) out[q] += ga[q] * (es * LP.sunRGB.getComponent(q) + sk * LP.skyRGB.getComponent(q)); }
    }
    return { open: nOpen / pat.length, out: out.map((x) => x / pat.length) };
  };
  // decals: lightmap uv2 from the surface under each vertex (a short ray back along -n); null if too many miss
  const decalUV2 = (g) => {
    const p = g.attributes.position.array, nr = g.attributes.normal.array, cnt = g.attributes.position.count, a = new Float32Array(cnt * 2), ok = new Uint8Array(cnt);
    const P = new THREE.Vector3(), N = new THREE.Vector3(); let miss = 0;
    for (let i = 0; i < cnt; i++) {
      P.fromArray(p, i * 3); N.fromArray(nr, i * 3).normalize();
      _ray.origin.copy(P).addScaledVector(N, 0.05); _ray.direction.copy(N).negate();
      const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, 0.2);
      if (hit && uvAt(hit, UV) >= 0) { a[i * 2] = UV[0]; a[i * 2 + 1] = UV[1]; ok[i] = 1; } else miss++;
    }
    if (miss > cnt * 0.03) return null;
    for (let i = 0; i < cnt; i++) if (!ok[i]) { const j = i > 0 && ok[i - 1] ? i - 1 : ok[i + 1] ? i + 1 : -1; if (j >= 0) { a[i * 2] = a[j * 2]; a[i * 2 + 1] = a[j * 2 + 1]; } }
    g.setAttribute('uv2', new THREE.BufferAttribute(a, 2));
    return { verts: cnt, missed: miss };
  };
  const stats = { lightmap: lm.s.file, hash: lm.hash, rays: lm.j.rays, bakedSec: lm.j.bakeSec, setupMs: Math.round(performance.now() - t0) };
  return { probe, applyTo() {}, decalUV2, stats, sunDir: L, c2r };
}
// a material that reads the lightmap: own program key (three must not share it with an unlit twin, e.g. far vs terrain)
function lmEnable(mat) {
  if (!mat || mat.userData.aLM) return;
  const k = mat.customProgramCacheKey; mat.userData.aLM = true;
  mat.customProgramCacheKey = () => (k ? k.call(mat) : '') + '|lm';
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
  scene.updateMatrixWorld(true);
  const casters = []; scene.traverse((o) => { if (o.isMesh && o.castShadow && o.visible) casters.push(o); });
  const px = shadowProxies(casters);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); renderer.clear(true, true, true); renderer.render(px.scene, cam); renderer.setRenderTarget(prev);
  px.dispose();
  rt.depthTexture = null; rt.dispose();   // keep only the depth texture (frees the FBO and the colour plane)
  const M = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  M.elements[14] -= 0.08 / (2 * back - 1);   // 8 cm depth bias (plus the 15 cm normal offset in the shader)
  U.uFarMat.value.copy(M); U.uFarSM.value = dt; U.uFarOn.value = 1; U.uFarTexel.value.set(1 / size, 1 / size);
  return { tex: dt, texel: (2 * Math.max(hx, hy)) / size };
}

// [A2] depth-only stand-ins for shadow casters, sharing geometry and instance matrices. A mesh's customDepthMaterial
// (three's own hook for shadow passes) wins; otherwise alpha-tested materials keep their map/alphaMap cut-out.
// Caveat: vertex animation or atlas UVs done in onBeforeCompile are not seen here, so such a caster should set
// customDepthMaterial.
function shadowProxies(list) {
  const scene = new THREE.Scene(), plain = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }), extra = [];
  for (const o of list) {
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    let mat = plain;
    if (o.customDepthMaterial) mat = o.customDepthMaterial;
    else if (m && m.alphaTest > 0 && (m.map || m.alphaMap)) {
      mat = new THREE.MeshBasicMaterial({ map: m.map || null, alphaMap: m.alphaMap || null, alphaTest: m.alphaTest, side: THREE.DoubleSide, colorWrite: false }); extra.push(mat);
    }
    const p = o.isInstancedMesh ? new THREE.InstancedMesh(o.geometry, mat, o.count) : new THREE.Mesh(o.geometry, mat);
    if (o.isInstancedMesh) p.instanceMatrix = o.instanceMatrix;
    p.matrixAutoUpdate = false; p.matrix.copy(o.matrixWorld); p.matrixWorld.copy(o.matrixWorld); p.frustumCulled = false; scene.add(p);
  }
  return { scene, dispose: () => { extra.forEach((m) => m.dispose()); plain.dispose(); } };
}

// ---------------------------------------------------------------- [A2] static ring shadow map (treeline crowns)
// The crowns stand 120-420 m out, beyond the far map (site casters only) and the live map, so the belt floated in
// 07b/09. One depth pass at load into a 1024^2 compare texture fitted to the crowns in light space (<= +-470 m,
// ~0.9 m texels); every weatherPatch material multiplies its sun shadow by one hardware-compare tap of it, but only
// beyond uRingG.z (the closest any crown shadow can land), so site and grass fragments never pay for it.
function skyShadowUniforms() {
  return { uRingSM: { value: null }, uRingMat: { value: new THREE.Matrix4() }, uRingG: { value: new THREE.Vector4(0, 0, 0, 0) } };
}
const A2_RING_GLSL = `
uniform sampler2DShadow uRingSM;
uniform mat4 uRingMat;
uniform vec4 uRingG;   // xy: ring centre (world xz), z: inner radius^2 (no crown shadow inside), w: 1 = on
float aRingShadow() {
  vec2 dr = vWPos.xz - uRingG.xy;
  if ( uRingG.w < 0.5 || dot( dr, dr ) < uRingG.z ) return 1.0;
  vec3 c = ( uRingMat * vec4( vWPos + vNW * ( 0.8 * inversesqrt( max( dot( vNW, vNW ), 1e-8 ) ) ), 1.0 ) ).xyz;
  if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;
  return texture( uRingSM, c );
}
`;
// Runs right after aLightingPatch (inside weatherPatch's [A-lighting] block): needs its aDirShadow( getShadow( ... call.
function aSkyShadowPatch(sh, uniforms) {
  const U = uniforms?.aSky; if (!U || !sh.fragmentShader.includes('aDirShadow( getShadow(')) return;
  Object.assign(sh.uniforms, U);
  sh.fragmentShader = sh.fragmentShader.replace('void main() {', `${A2_RING_GLSL}\nvoid main() {`)
    .replace('? aDirShadow( getShadow(', '? aRingShadow() * aDirShadow( getShadow(');
}
// hole: world xz the ring surrounds (the site centre; the crowns' own bounding box is lopsided by the outer groves)
function renderRingShadow(renderer, root, L, size, U, hole = null) {
  root.updateMatrixWorld(true);
  const meshes = []; root.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });
  if (!meshes.length || !U) return null;
  const box = new THREE.Box3().setFromObject(root); if (box.isEmpty()) return null;
  // light-space fit (same basis as the live map)
  const lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), L).normalize(), ly = new THREE.Vector3().crossVectors(L, lx);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], c = new THREE.Vector3();
  for (let k = 0; k < 8; k++) {
    c.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z);
    [c.dot(lx), c.dot(ly), c.dot(L)].forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); });
  }
  const hx = Math.min(470, (hi[0] - lo[0]) / 2 + 4), hy = Math.min(470, (hi[1] - lo[1]) / 2 + 4), back = (hi[2] - lo[2]) / 2 + 60;
  const ctr = new THREE.Vector3().addScaledVector(lx, (lo[0] + hi[0]) / 2).addScaledVector(ly, (lo[1] + hi[1]) / 2).addScaledVector(L, (lo[2] + hi[2]) / 2);
  const cam = new THREE.OrthographicCamera(-hx, hx, hy, -hy, 1, 2 * back);
  cam.position.copy(ctr).addScaledVector(L, back); cam.up.set(0, 1, 0); cam.lookAt(ctr); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
  const dt = new THREE.DepthTexture(size, size); dt.type = THREE.UnsignedIntType; dt.compareFunction = THREE.LessEqualCompare; dt.minFilter = dt.magFilter = THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(size, size, { depthTexture: dt, depthBuffer: true, format: THREE.RedFormat, type: THREE.UnsignedByteType, generateMipmaps: false });
  const px = shadowProxies(meshes), prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); renderer.clear(true, true, true); renderer.render(px.scene, cam); renderer.setRenderTarget(prev);
  px.dispose(); rt.depthTexture = null; rt.dispose();
  const M = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  M.elements[14] -= 0.4 / (2 * back - 1);   // 40 cm depth bias (+ the 80 cm normal offset in the shader; texels ~0.9 m)
  // inner radius: the closest any crown's shadow can reach toward the ring centre (horizontal reach = height x tan(zenith))
  const cx = hole ? hole.x : (box.min.x + box.max.x) / 2, cz = hole ? hole.y : (box.min.z + box.max.z) / 2, tanZ = Math.sqrt(Math.max(0, 1 - L.y * L.y)) / Math.max(0.05, L.y);
  // each caster's shadow is swept from it along -L (horizontal) for (height over the lowest ground) x tan(zenith)
  const yFloor = Math.min(box.min.y, -15) - 5;   // the far ground can sit well below a crown's base
  const hl = Math.hypot(L.x, L.z) || 1, sdx = -L.x / hl, sdz = -L.z / hl;
  const segDist = (px, pz, len) => { const t = Math.max(0, Math.min(len, (cx - px) * sdx + (cz - pz) * sdz)); return Math.hypot(px + sdx * t - cx, pz + sdz * t - cz); };
  let rIn = Infinity; const v = new THREE.Vector3(), Mi = new THREE.Matrix4(), sph = new THREE.Sphere();
  for (const o of meshes) {
    const g = o.geometry;
    if (o.isInstancedMesh) {
      if (!g.boundingSphere) g.computeBoundingSphere();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, Mi); Mi.premultiply(o.matrixWorld); sph.copy(g.boundingSphere).applyMatrix4(Mi);
        rIn = Math.min(rIn, segDist(sph.center.x, sph.center.z, (sph.center.y + sph.radius - yFloor) * tanZ) - sph.radius);
      }
    } else {
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); rIn = Math.min(rIn, segDist(v.x, v.z, (v.y - yFloor) * tanZ)); }
    }
  }
  rIn = Math.max(0, rIn - 10);
  U.uRingSM.value = dt; U.uRingMat.value.copy(M); U.uRingG.value.set(cx, cz, rIn * rIn, 1);
  return { tex: dt, info: { meshes: meshes.length, texel: +((2 * Math.max(hx, hy)) / size).toFixed(2), half: [+hx.toFixed(0), +hy.toFixed(0)], rIn: +rIn.toFixed(1) } };
}

// ---------------------------------------------------------------- [A] sky: real HDR photo, sun split out for shadows
// Returns: background (its lower hemisphere = fog x haze, so a puresky's mirrored "ground" never shows), a PMREM env
// from a 1024x512 copy whose lower hemisphere is the lit ground (albedo x (sun + sky) / pi), and the measured sun
// colour / intensity, sky irradiance and fog colour (mean of the sky 0.5-5 deg above the horizon).
// Everything here is in the HDR's own frame (def.sunDir); buildBando rotates the sky by def.rotY.
// [A2] equirect texel <-> direction, exactly as three samples it (equirectUv; row 0 = zenith with flipY): shared by
// loadSky and the node checks
export function equirectDir(px, py, W, H, out = new THREE.Vector3()) {
  const ph = ((px + 0.5) / W - 0.5) * 2 * Math.PI, la = (0.5 - (py + 0.5) / H) * Math.PI;
  return out.set(Math.cos(ph) * Math.cos(la), Math.sin(la), Math.sin(ph) * Math.cos(la));
}
export function equirectTexel(d, W, H) {
  const u = Math.atan2(d.z, d.x) / (2 * Math.PI) + 0.5, v = Math.asin(Math.max(-1, Math.min(1, d.y))) / Math.PI + 0.5;
  return [u * W - 0.5, (1 - v) * H - 0.5];
}
// [A2] sun disc: 0.6 deg across (the real sun is 0.53; a bit more survives the cube conversion), radiance capped at
// def.disc (the physical E/omega is ~1e5, far past half float's useful range and the bloom cap). Anti-aliased over
// one texel. Returns the disc coverage (0..1) of the texel at direction cosine cd with the sun.
const SUN_R = 0.3 * Math.PI / 180;
function sunDiscCover(cd, texAng) { const a = Math.acos(Math.min(1, cd)); return Math.min(1, Math.max(0, (SUN_R - a) / texAng + 0.5)); }
// [A2] a loadSky result into a scene: the sky turns by rotY (background and env together, so the env's bright side and
// the disc sit on the light); the background alone is brightened by bgI, and the fog (= the horizon it converges to)
// by the same factor. Returns bgI.
export function applySky(scene, def, sk) {
  const bgI = def.bgI ?? 1, rot = def.rotY || 0;
  scene.background = sk.sky; scene.environment = sk.env;
  scene.backgroundRotation.set(0, rot, 0); scene.environmentRotation.set(0, rot, 0);
  scene.backgroundIntensity = bgI;
  scene.fog = new THREE.Fog(sk.fogColor.clone().multiplyScalar(bgI), 40, 2600);
  return bgI;
}
export async function loadSky(def, renderer, { envI = 0.85, groundAlb = ALB_FALLBACK.ground, haze = 1.2, onProgress } = {}) {
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
  // [A2] plus the capped sun disc (stored / bgI, so it shows at def.disc after scene.backgroundIntensity)
  const half = new Uint16Array(W * H * 4);
  const discL = def.sunRatio > 0 && def.disc > 0 ? def.disc / (def.bgI || 1) : 0, texAng = Math.PI / H, latSun = Math.asin(L.y);
  let discN = 0;
  for (let py = 0; py < H; py++) {
    const lat = latOf(py), t = sst(0.5, -1.0, lat * 180 / Math.PI), cl = Math.cos(lat), sl = Math.sin(lat);
    const discRow = discL > 0 && Math.abs(lat - latSun) < SUN_R + 2 * texAng;
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * ch, o = (py * W + px) * 4;
      let r = data[i], g = data[i + 1], b = data[i + 2];
      if (t > 0) { const hz = 1 + haze * Math.pow(Math.max(0, cosP[px] * cl * L.x + sl * L.y + sinP[px] * cl * L.z), 6); r += (fogC.r * hz - r) * t; g += (fogC.g * hz - g) * t; b += (fogC.b * hz - b) * t; }
      if (discRow) {
        const k = sunDiscCover(cosP[px] * cl * L.x + sl * L.y + sinP[px] * cl * L.z, texAng);
        if (k > 0) { r += (discL * sunColor.r - r) * k; g += (discL * sunColor.g - g) * k; b += (discL * sunColor.b - b) * k; discN++; }
      }
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
    'fog', [fogC.r, fogC.g, fogC.b].map((v) => +v.toFixed(3)), 'ground', gR.map((v) => +v.toFixed(3)), 'maxL', +maxL.toFixed(0), 'disc texels', discN);
  return { sky, env, sunDir: L, sunColor, sunI, sunE: Ei, skyE, fogColor: fogC, discTexels: discN };
}


// pure geometry + collision (no DOM): shared by the game and the headless physics tests
// R drives the decorative extras (trees, foliage, textures); the site layout has its own seeded streams (seed)
export function buildGeometry(R = rng(7), seed = 7) {
  const site = buildSite(seed);

  // terrain: detailed yard + coarse far field
  const tSize = 320, tSeg = 128;
  const terr = new THREE.PlaneGeometry(tSize, tSize, tSeg, tSeg); terr.rotateX(-Math.PI / 2); terr.translate(-5, 0, 10);
  { const p = terr.attributes.position, uv = terr.attributes.uv; for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); p.setY(i, terrainHeight(x, z)); uv.setXY(i, x, z); } terr.computeVertexNormals(); }
  const far = new THREE.PlaneGeometry(6000, 6000, 60, 60); far.rotateX(-Math.PI / 2);
  { const p = far.attributes.position, uv = far.attributes.uv; for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); const d = Math.hypot(x + 5, z - 10); p.setY(i, d < 150 ? -1.4 : terrainHeight(x, z) - 0.4 + Math.min(1, (d - 150) / 400) * (Math.sin(x * 0.004) * Math.cos(z * 0.005) * 9 + Math.sin(x * 0.011 + z * 0.007) * 3)); uv.setXY(i, x, z); } far.computeVertexNormals(); }
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

  // [B] trees: thickets hugging the buildings plus lone field trees. Own RNG streams (positions TR as in round 2,
  // shapes TS), so layout edits elsewhere don't reshuffle them. Each tree: a trunk in two segments with a 0.3-0.8 m
  // lean (collides), 3-5 tapered 5-sided branches from 0.35-0.6 h on the trunk out to the limb centres (render only),
  // and the limbs themselves, which buildBando fills with 7-11 small leaf balls each.
  const TR = rng(1101), TS = rng(1102), treeSpots = [];
  const clearOf = (x, z, m) => !site.footprints.some((f) => x > f.x0 - m && x < f.x1 + m && z > f.z0 - m && z < f.z1 + m);
  const okTree = (x, z) => clearOf(x, z, 2.5) && distToPaths(x, z) > 4.5 && Math.hypot(x, z - 120) > 14 && !treeSpots.some((t) => Math.hypot(t.x - x, t.z - z) < 2.4 + t.h * 0.12);
  const limbGeo = (a, b, r0, r1, seg, hseg, y0, y1) => {
    const d = new THREE.Vector3().subVectors(b, a), L = d.length(), g = cylGeo(r1, r0, L, seg, true, hseg);
    g.translate(0, L / 2, 0); g.applyQuaternion(_rq.setFromUnitVectors(Y_UP, d.normalize())); g.translate(a.x, a.y, a.z); setAY(g, y0, y1); return g;
  };
  const addTree = (x, z, h) => {
    const y = terrainHeight(x, z), r = 0.09 + h * 0.02, la = TS() * 6.283, lean = 0.3 + TS() * 0.5, lx = Math.cos(la) * lean, lz = Math.sin(la) * lean;
    const B0 = new THREE.Vector3(x, y - 0.1, z), B1 = new THREE.Vector3(x + lx * 0.3, y + h * 0.4, z + lz * 0.3), B2 = new THREE.Vector3(x + lx, y + h * 0.8, z + lz);
    const onTrunk = (f) => (f <= 0.4 ? B0.clone().lerp(B1, f / 0.4) : B1.clone().lerp(B2, (f - 0.4) / 0.4));
    site.add('bark', limbGeo(B0, B1, r, r * 0.78, 7, Math.max(1, Math.round(h * 0.4 / 2.5)), y - 0.1, y + h));
    site.add('bark', limbGeo(B1, B2, r * 0.78, r * 0.4, 7, Math.max(1, Math.round(h * 0.4 / 2.5)), y - 0.1, y + h));
    // the crown: limb clumps around a centre on the leaning trunk (~1.3x taller than wide), a leader at the top
    const cc = onTrunk(0.64), rx = h * (0.24 + TS() * 0.1), ry = h * 0.3, limbs = [], nl = 3 + Math.floor(TS() * 3);
    for (let l = 0; l < nl; l++) {
      const lead = l === 0, th = TS() * 6.283, cp = lead ? 0.85 : TS() * 1.3 - 0.45, sp = Math.sqrt(Math.max(0, 1 - cp * cp)), rr = lead ? 0.35 : 0.55 + 0.4 * TS();
      const lc = new THREE.Vector3(cc.x + Math.cos(th) * sp * rx * rr, cc.y + cp * ry * rr, cc.z + Math.sin(th) * sp * rx * rr);
      limbs.push([lc.x, lc.y, lc.z, h * (0.12 + TS() * 0.06)]);
      const f = lead ? 0.6 : 0.35 + TS() * 0.25, bp = onTrunk(f), end = bp.clone().lerp(lc, 0.85);
      site.add('bark', limbGeo(bp, end, r * (lead ? 0.42 : 0.4), r * 0.12, 5, 1, y - 0.1, y + h), false);
    }
    treeSpots.push({ x, z, h, r, y, cc: cc.toArray(), rx, ry, limbs });
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
  // Crowns (round-topped, w = 0.8-1.1 h) are leaf-card instances in buildBando; low-poly proxies keep the drone out of
  // them (site.colliders). Beyond the flight envelope (450-950 m) a looser scatter, no proxies, gives the woodland
  // floor some relief from altitude.
  const treeline = [];
  {
    const LR = rng(1201), fb = new MeshBVH(far.clone()), ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    const groundAt = (x, z) => {
      ray.origin.set(x, 400, z); const h = fb.raycastFirst(ray, THREE.DoubleSide);
      let y = h ? h.point.y : 0; if (Math.abs(x + 5) < 158 && Math.abs(z - 10) < 158) y = Math.max(y, terrainHeight(x, z)); return y;
    };
    // a belt with a ragged inner edge (125-185 m) and uneven depth, groves breaking out of it on both sides,
    // and tall/short stands so the skyline isn't a hedge
    const belt = (a) => 0.5 + 0.5 * Math.sin(a * 3 + 1.3) * Math.cos(a * 5 - 0.4);
    const inner = (a) => 150 + 22 * Math.sin(a * 4 + 0.7) + 13 * Math.sin(a * 11 - 1.9);
    const stand = (a) => 0.75 + 0.5 * (0.5 + 0.5 * Math.sin(a * 7 + 2.1) * Math.sin(a * 2.3));
    const groves = Array.from({ length: 16 }, (_, i) => { const a = LR() * 6.283, r = i < 5 ? 118 + LR() * 25 : 250 + LR() * 150; return [-5 + Math.cos(a) * r, 10 + Math.sin(a) * r, i < 5 ? 14 : 30]; });
    const proxy = new THREE.IcosahedronGeometry(1, 0);
    for (let k = 0; k < 780; k++) {
      let x, z, a;
      if (k < 590) { a = LR() * Math.PI * 2; const r = inner(a) + Math.pow(LR(), 1.6) * (30 + 100 * belt(a)); x = -5 + Math.cos(a) * r; z = 10 + Math.sin(a) * r; }
      else { const g = groves[k % groves.length]; x = g[0] + (LR() - 0.5) * 2 * g[2]; z = g[1] + (LR() - 0.5) * 2 * g[2]; a = Math.atan2(z - 10, x + 5); }
      if (!clearOf(x, z, 12) || distToPaths(x, z) < 8 || Math.hypot(x, z - 118) < 25) continue;
      const h = (7 + Math.pow(LR(), 0.8) * 13) * stand(a), w = h * (0.8 + LR() * 0.3), y = groundAt(x, z) - 0.6;
      treeline.push({ x, y, z, h, w, d: w * (0.8 + LR() * 0.4), rot: LR() * 6.283, tint: LR() });
      if (RING_COLLIDE) { const c = proxy.clone(); c.scale(w * 0.36, h * 0.4, w * 0.36); c.translate(x, y + h * 0.5, z); site.colliders.push(indexify(c)); }
    }
    const OR = rng(1202);
    for (let k = 0; k < 480; k++) {
      const a = OR() * Math.PI * 2, r = 450 + Math.pow(OR(), 1.4) * 500, x = -5 + Math.cos(a) * r, z = 10 + Math.sin(a) * r;
      const h = (9 + Math.pow(OR(), 0.8) * 13) * stand(a), w = h * (0.85 + OR() * 0.3);
      treeline.push({ x, y: groundAt(x, z) - 0.8, z, h, w, d: w * (0.8 + OR() * 0.4), rot: OR() * 6.283, tint: OR(), outer: true });
    }
  }

  // merge structures per material + one collision geometry
  const solids = [];
  const merged = {};
  for (const [mat, list] of Object.entries(site.parts)) {
    merged[mat] = mergeGeometries(list.map((e) => { const g = e.g; for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'aY'].includes(k)) g.deleteAttribute(k); return g; }), false);
    list.forEach((e) => e.collide && solids.push(e.g));
  }
  const posOnly = (g) => { const c = new THREE.BufferGeometry(); c.setAttribute('position', g.attributes.position); c.setIndex(g.index); return c; };
  const solidGeo = mergeGeometries(solids.map(posOnly), false);
  // collision = everything you can see: structures, the yard terrain and the far field (both terrain meshes are
  // drawn, so the visible ground is the higher of the two; colliding with both matches it)
  // (far triangles lying wholly over the yard tile sit under it, out of sight and reach: leaving them out keeps their
  // 100 m bounding boxes off every query in the yard, which costs the light bake ~40 % in ray time)
  const farCol = (() => {
    const p = far.attributes.position, src = far.index.array, keep = [];
    const inTile = (i) => { const x = p.getX(i), z = p.getZ(i); return x >= -165 && x <= 155 && z >= -150 && z <= 170; };
    for (let k = 0; k < src.length; k += 3) if (!(inTile(src[k]) && inTile(src[k + 1]) && inTile(src[k + 2]))) keep.push(src[k], src[k + 1], src[k + 2]);
    const c = new THREE.BufferGeometry(); c.setAttribute('position', p); c.setIndex(keep); return c;
  })();
  // [B] collision-only treeline proxies go last (A's collider map: solids, then terrain, then anything else)
  const colGeo = mergeGeometries([solidGeo, posOnly(terr), farCol, ...(site.colliders || []).map(posOnly)], false);
  colGeo.computeBoundingBox();
  const bvh = new MeshBVH(colGeo, { maxLeafTris: 5 });
  // proximity / skim scoring: built structures and trunks only, so skimming the grass scores nothing
  const skimBvh = new MeshBVH(solidGeo, { maxLeafTris: 5 });
  terr.userData.lm = lightmapUV2(merged, terr, pathG);   // [A1] lightmap uv2 on merged/terr/pathG (append-only; layout on terr.userData.lm)

  return { site, terr, far, pathG, treeSpots, treeline, merged, colGeo, bvh, skimBvh, lines: site.lines, takeStart: site.takeStart, startPoints: site.startPoints, funnels: site.funnels };
}

// ---------------------------------------------------------------- build everything
export async function buildBando(renderer, { sky = 'sunny', quality = 'auto', seed = 7, onProgress } = {}) {
  const R = rng(seed);
  const prog = (f, t) => onProgress?.(f, t);
  const scene = new THREE.Scene();
  const uniforms = { uTime: { value: 0 } };
  uniforms.aAO = aoUniforms();          // [A1] contract C3 (world.aoUniforms): stream D fills it each frame
  const lmJP = lmFetchJSON();           // [A1] lm.json, fetched while the geometry builds

  // textures (stream in parallel with the sky)
  const tl = new THREE.TextureLoader(); tl.setCrossOrigin('anonymous');
  // one load per URL (the coping shares the brick's maps: same texture objects, same tile, no extra GPU memory)
  const texURLs = new Set(Object.values(MATS).flatMap((m) => (m.maps || []).map((map) => texURL(m, map))));
  let texDone = 0; const texTotal = texURLs.size, texByURL = {};
  const loadTex = (url, srgb) => (texByURL[url] ||= new Promise((res) => tl.load(url, (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; texDone++; res(t); }, undefined, () => { texDone++; res(null); })));
  const texJobs = {};
  for (const [k, m] of Object.entries(MATS)) {
    const maps = m.maps || [];
    texJobs[k] = Promise.all(maps.map((map) => loadTex(texURL(m, map), /diff/.test(map))))
      .then((ts) => Object.fromEntries(maps.map((map, i) => [map.replace(/^leaves_/, ''), ts[i]])));
  }
  // [A] sky + light. The bake needs only the per-sky sun direction, so it runs right after the geometry while the HDR
  // and textures stream; the HDR's measured sun/sky intensities then scale it through uniforms (uniforms.aLight).
  // [A2] sunDir is the WORLD sun (the sky's own sunDir turned by rotY), for the bake, the light, shadows and haze
  const skyDef = SKIES[sky] || SKIES.sunny, hasSun = skyDef.sunRatio > 0, envI = 0.85, sunDir = skySunDir(skyDef);
  const aLight = (uniforms.aLight = lightUniforms());
  uniforms.aSky = skyShadowUniforms();   // [A2] ring shadow map (treeline crowns)
  aLight.uSunW.value.copy(sunDir); aLight.uHaze.value = hasSun ? 1.2 : 0;
  let skyFrac = 0, bakeFrac = 0;
  const ticker = setInterval(() => prog(0.05 + 0.85 * (skyFrac * 0.3 + (texDone / texTotal) * 0.3 + bakeFrac * 0.4), bakeFrac < 1 ? 'Baking light' : 'Streaming sky and materials'), 200);
  const skyP = loadSky(skyDef, renderer, { envI, groundAlb: groundAlbedo(), haze: aLight.uHaze.value, onProgress: (f) => (skyFrac = f) });

  // geometry (CPU) while downloads run
  const geo = buildGeometry(R, seed);
  const { site, terr, far, pathG, treeSpots, treeline, merged, colGeo, bvh, skimBvh } = geo;
  prog(0.1, 'Baking light');
  await yieldUI();
  // [A1] the committed lightmap when it was baked for exactly this geometry + sun; else the per-vertex bake (2-4 s)
  let lm = null;
  {
    const m = lmMatch(await lmJP, geo, SKIES[sky] ? sky : 'sunny', sunDir);
    if (m.ok) { try { lm = await lmLoad(m); } catch (e) { console.warn('[A1] lightmap load failed, baking per vertex:', e.message); } }
    else console.info('[A1] lightmap not used (per-vertex bake):', m.why);
  }
  const bake = lm ? (BAKE = lmProbeBake(geo, sunDir, hasSun, lm)) : await bakeLight(geo, { sunDir, sun: hasSun, quality, onTick: (f) => (bakeFrac = f) });
  if (lm) { aLight.uLM.value = lm.irr.tex; aLight.uLMAux.value = lm.aux.tex; aLight.uLMRange.value.set(lm.s.range[0], lm.s.range[1]); }
  else bake.applyTo(pathG, 4, 18);
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

  const bgI = applySky(scene, skyDef, sk);

  const bStats = { ms: {} }; globalThis.__bandoStats = bStats;    // [B] counts + CPU ms per block, for the smoke harness / integrator
  let tLap = performance.now(); const lap = (k) => { const n = performance.now(); bStats.ms[k] = Math.round(n - tLap); tLap = n; };
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
  const farMat = mkMat('ground'); const farMesh = new THREE.Mesh(far, farMat); farMesh.receiveShadow = true; scene.add(farMesh);   // [A2] treeline shadows land on it
  const pathMesh = new THREE.Mesh(pathG, mats.path); pathMesh.receiveShadow = true; pathMesh.renderOrder = 1; scene.add(pathMesh);

  lap('mask+materials');
  // [B] graffiti: ~260 pieces (~900 m2) placed by a raycast pass, so they follow whatever geometry the site builds:
  // big pieces (3.5-8 m) on the ground storey outside, the hall's ground storey densest, tags (0.4-1 m) on the hall and
  // table columns, the silo bases, the stair shaft and the workshop, plus Site.decalSpots as hints. Each piece is a grid
  // conformed to the surface by rays (it wraps silos and the chimney) and is rejected over openings, edges and steps.
  // The paint multiplies the wall texture and gets the same weathering as the wall under it.
  {
    const GR = rng(1401), atlas = graffitiAtlas(rng(1402)); lap('graffitiAtlas');
    const pos = [], uv = [], nor = [], aoA = [], boA = [], ayA = [], sdA = [], idx = [], placed = [];
    const ray = new THREE.Ray(), UP = new THREE.Vector3(0, 1, 0), DN = new THREE.Vector3(0, -1, 0), U = new THREE.Vector3(), V = new THREE.Vector3(), Q = new THREE.Vector3(), nd = new THREE.Vector3();
    const cast = (o, d, maxD) => { ray.origin.copy(o); ray.direction.copy(d); return bvh.raycastFirst(ray, THREE.DoubleSide, 0, maxD); };
    const cellsBy = { piece: [], throw: [], tags: [], buff: [] }; for (let k = 0; k < GCELLS; k++) cellsBy[GTYPE(k)].push(k);
    const kindPref = () => { const r = GR(); return r < 0.5 ? 'piece' : r < 0.82 ? 'throw' : r < 0.92 ? 'buff' : 'tags'; };
    const iu = 2 / (GCOLS * 512), iv = 2 / (GROWS * 256);                 // 2 px inset: no bleed from the next cell in the mips
    const tryPiece = (P, n, w, h, kind) => {
      U.crossVectors(UP, n).normalize(); V.crossVectors(n, U); nd.copy(n).negate();
      for (const p of placed) { const dv = P.clone().sub(p.c); if (p.n.dot(n) > 0.7 && Math.abs(dv.dot(n)) < 0.7 && Math.abs(dv.dot(U)) < (p.w + w) * 0.46 && Math.abs(dv.y) < (p.h + h) * 0.5) return false; }
      const st = w < 1.2 ? 0.3 : 0.55, nx = Math.max(2, Math.round(w / st)), ny = Math.max(2, Math.round(h / st)), grid = [];
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        Q.copy(P).addScaledVector(U, (i / nx - 0.5) * w).addScaledVector(V, (j / ny - 0.5) * h).addScaledVector(n, 0.45);
        const hit = cast(Q, nd, 1.0); if (!hit) return false;
        const hn = hit.face.normal.clone(); if (hn.dot(n) < 0) hn.negate(); if (hn.dot(n) < 0.6) return false;
        grid.push({ p: hit.point.clone().addScaledVector(hn, 0.012), n: hn, d: hit.distance });
      }
      // steps and edges: no vertical jumps, and no kinks across (smooth curvature is fine: silos, the chimney, the tank)
      const D = (i, j) => grid[j * (nx + 1) + i].d;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        if (i < nx && Math.abs(D(i, j) - D(i + 1, j)) > 0.45) return false;
        if (j < ny && Math.abs(D(i, j) - D(i, j + 1)) > 0.12) return false;
        if (i > 0 && i < nx && Math.abs(D(i - 1, j) - 2 * D(i, j) + D(i + 1, j)) > 0.12) return false;
      }
      // the element under the paint: from just inside the surface, the first hits up and down are its top and bottom
      const S = grid[Math.floor(grid.length / 2)].p.clone().addScaledVector(n, -0.1);
      const hu = cast(S, UP, 60), hd = cast(S, DN, 60), top = hu ? S.y + hu.distance : P.y + h, bot = hd ? S.y - hd.distance : 0;
      const list = cellsBy[kind], cell = list[Math.floor(GR() * list.length)], cu = (cell % GCOLS) / GCOLS, cv = 1 - (Math.floor(cell / GCOLS) + 1) / GROWS;
      // light: probe every other grid vertex (and the last row/column), interpolate the rest
      const pr = new Array(grid.length), at = (i, j) => pr[j * (nx + 1) + i];
      const sI = (i, m) => i % 2 === 0 || i === m;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) if (sI(i, nx) && sI(j, ny)) { const q = grid[j * (nx + 1) + i]; pr[j * (nx + 1) + i] = [aoCurve(lightProbe(bvh, q.p, q.n, 22, 4)), LP.out.x, LP.out.y, LP.out.z]; }
      const mix4 = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        if (pr[j * (nx + 1) + i]) continue;
        const i0 = sI(i, nx) ? i : i - 1, i1 = sI(i, nx) ? i : i + 1, j0 = sI(j, ny) ? j : j - 1, j1 = sI(j, ny) ? j : j + 1;
        pr[j * (nx + 1) + i] = mix4(mix4(at(i0, j0), at(i1, j0), i1 > i0 ? 0.5 : 0), mix4(at(i0, j1), at(i1, j1), i1 > i0 ? 0.5 : 0), j1 > j0 ? 0.5 : 0);
      }
      const b = pos.length / 3, seed = GR();
      grid.forEach((q, k) => {
        const i = k % (nx + 1), j = Math.floor(k / (nx + 1)), l = pr[k];
        pos.push(q.p.x, q.p.y, q.p.z); nor.push(q.n.x, q.n.y, q.n.z); ayA.push(bot, top);
        uv.push(cu + iu + (i / nx) * (1 / GCOLS - 2 * iu), cv + iv + (j / ny) * (1 / GROWS - 2 * iv));
        aoA.push(l[0]); boA.push(l[1], l[2], l[3]); sdA.push(seed);
      });
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = b + j * (nx + 1) + i; idx.push(a, a + 1, a + nx + 2, a, a + nx + 2, a + nx + 1); }
      placed.push({ c: P.clone(), n: n.clone(), w, h, kind });
      return true;
    };
    // the flat (or gently curved) span of surface around H along axis A, probing in `st` steps up to lim each way
    const span = (H, n, A, lim, st = 0.2) => {
      const o = new THREE.Vector3(), nn = n.clone().negate(), r = [0, 0];
      const d0 = cast(o.copy(H).addScaledVector(n, 0.45), nn, 1.0); if (!d0) return r;
      for (const s of [-1, 1]) {
        let prev = d0.distance, t = 0;
        while (t < lim) {
          const h = cast(o.copy(H).addScaledVector(A, s * (t + st)).addScaledVector(n, 0.45), nn, 1.0);
          if (!h || Math.abs(h.distance - prev) > 0.4 * st || Math.abs(h.face.normal.dot(n)) < 0.6) break;
          prev = h.distance; t += st;
        }
        r[s < 0 ? 0 : 1] = s * t;
      }
      return r;
    };
    // H: a hit point on a wall, hn: its normal. Fit the piece into the free span around H (bands under ribbon
    // windows get wide, low pieces up to 3.2:1), then try smaller; tag-sized pieces go on narrow piers.
    const covered = (H, n) => { U.crossVectors(UP, n).normalize(); for (const p of placed) { const dv = H.clone().sub(p.c); if (p.n.dot(n) > 0.7 && Math.abs(dv.dot(n)) < 0.5 && Math.abs(dv.dot(U)) < p.w * 0.5 + 0.3 && Math.abs(dv.y) < p.h * 0.5 + 0.2) return true; } return false; };
    const place = (H, hn, wMin, wMax, minW = 0.6) => {
      const n = hn.clone().setY(0); if (n.lengthSq() < 0.5) return false; n.normalize();
      if (covered(H, n)) return false;
      U.crossVectors(UP, n).normalize();
      const Ua = U.clone(), sv = span(H, n, UP, 3.2), C0 = H.clone().addScaledVector(UP, (sv[0] + sv[1]) / 2);
      const su = span(C0, n, Ua, 4.2), C = C0.clone().addScaledVector(Ua, (su[0] + su[1]) / 2);
      const spanV = sv[1] - sv[0] - 0.12, spanU = su[1] - su[0] - 0.15;
      let w = Math.min(wMin + GR() * (wMax - wMin), spanU);
      for (let t = 0; t < 3 && w >= minW; t++, w *= 0.8) {
        const h = Math.min(w * (0.5 + 0.1 * GR()), spanV); if (h < w * 0.31) w = h / 0.31;
        if (w < minW || h < 0.3) return false;
        const kind = w < 1.7 ? 'tags' : kindPref();
        if (tryPiece(C, n, w, h, kind)) return true;
      }
      return false;
    };
    // a tag (0.4-1 m) on a column or narrow pier: only where the face is narrow
    const placeTag = (H, hn) => {
      const n = hn.clone().setY(0); if (n.lengthSq() < 0.5) return false; n.normalize();
      if (covered(H, n)) return false;
      U.crossVectors(UP, n).normalize();
      const Ua = U.clone(), su = span(H, n, Ua, 1.0, 0.08), spanU = su[1] - su[0] - 0.06;
      if (spanU > 1.5 || spanU < 0.36) return false;
      const w = Math.min(spanU, 0.4 + GR() * 0.6), h = w * (0.45 + GR() * 0.25);
      return tryPiece(H.clone().addScaledVector(Ua, (su[0] + su[1]) / 2), n, w, h, 'tags');
    };
    const shoot = (o, d, maxD, minD, wMin, wMax, tag = false, minW = Math.min(1.7, wMin * 0.5)) => {
      const hit = cast(o, d, maxD); if (!hit || hit.distance < minD) return false;
      const hn = hit.face.normal.clone(); if (hn.dot(d) > 0) hn.negate(); if (Math.abs(hn.y) > 0.3) return false;
      if (tag === true) return placeTag(hit.point, hn);
      return place(hit.point, hn, wMin, wMax, minW) || (tag === 'both' && GR() < 0.3 && placeTag(hit.point, hn));
    };
    const hdir = () => { const a = GR() * 6.283; return new THREE.Vector3(Math.cos(a), 0, Math.sin(a)); };
    const zone = (quota, tries, gen) => { let n = 0; for (let t = 0; t < tries && n < quota; t++) if (gen()) n++; return n; };
    const counts = {};
    // hints from the site plan
    counts.spots = site.decalSpots.reduce((n, s) => n + (shoot(s.c.clone().addScaledVector(s.n, 0.8), s.n.clone().negate(), 2.0, 0, Math.max(2.4, s.w), Math.max(3.6, s.w * 1.5)) ? 1 : 0), 0);
    const bigF = site.footprints.filter((f) => (f.x1 - f.x0) * (f.z1 - f.z0) > 30);
    const ring = (yLo, yHi, wMin, wMax) => () => {
      const f = bigF[Math.floor(GR() * bigF.length)], side = Math.floor(GR() * 4), t = 0.05 + GR() * 0.9, off = 4 + GR() * 3;
      const x = side < 2 ? f.x0 + t * (f.x1 - f.x0) : side === 2 ? f.x0 - off : f.x1 + off, z = side < 2 ? (side === 0 ? f.z0 - off : f.z1 + off) : f.z0 + t * (f.z1 - f.z0);
      const d = side === 0 ? new THREE.Vector3(0, 0, 1) : side === 1 ? new THREE.Vector3(0, 0, -1) : side === 2 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(-1, 0, 0);
      return shoot(new THREE.Vector3(x, terrainHeight(x, z) + yLo + GR() * (yHi - yLo), z), d, off + 12, 0.5, wMin, wMax);
    };
    counts.outside = zone(105, 1500, ring(0.6, 3.2, 3.5, 8));
    counts.upper = zone(45, 700, ring(6.2, 11, 3, 6.5));
    const inBox = (x0, x1, z0, z1, ys, minD, wMin = 2.2, wMax = 5.5, tag = false, dir = hdir) => () => shoot(new THREE.Vector3(x0 + GR() * (x1 - x0), ys(), z0 + GR() * (z1 - z0)), dir(), 25, minD, wMin, wMax, tag);
    const hall = site.footprints.find((f) => f.x1 - f.x0 > 50) || bigF[0];
    const hx0 = hall.x0 + 2, hx1 = hall.x1 - 2, hz0 = hall.z0 + 2, hz1 = hall.z1 - 2;
    // half the rays run along the hall (onto the partitions and gables), half anywhere (spandrels, bricked-up bays)
    const hallDir = () => { if (GR() < 0.5) return hdir(); const a = (GR() < 0.5 ? 0 : Math.PI) + (GR() - 0.5) * 0.6; return new THREE.Vector3(Math.cos(a), 0, Math.sin(a)); };
    counts.hall = zone(80, 900, inBox(hx0, hx1, hz0, hz1, () => 0.18 + 0.3 + GR() * 3.6, 1.0, 2.4, 7, 'both', hallDir));    // ground storey, densest
    counts.hallUp = zone(24, 260, inBox(hx0, hx1, hz0, hz1, () => (GR() < 0.6 ? 5 : 10) + 0.3 + GR() * 3.6, 1.0, 2, 5, 'both', hallDir));
    counts.hallCols = zone(45, 500, inBox(hx0, hx1, hz0, hz1, () => 0.18 + 0.8 + GR() * 1.4, 0.4, 0, 0, true));        // column tags
    counts.table = zone(14, 200, inBox(-53, -15, -27, -1, () => 1.3 + GR() * 1.8, 1.0, 2.2, 5, 'both'));
    counts.tableCols = zone(40, 500, inBox(-53, -15, -27, -1, () => 0.8 + GR() * 2.2, 0.3, 0, 0, true));
    // silo bases: from the table top toward a silo's axis (either row), just above the table slab
    counts.silo = zone(20, 180, () => {
      const sx = SILO.x[Math.floor(GR() * SILO.x.length)], sz = SILO.z[Math.floor(GR() * SILO.z.length)], a = GR() * 6.283, rr = SILO.r + 2.2;
      const o = new THREE.Vector3(sx + Math.cos(a) * rr, SILO.table + 0.7 + GR() * 2.2, sz + Math.sin(a) * rr);
      return shoot(o, new THREE.Vector3(sx - o.x, 0, sz - o.z).normalize(), 4, 0.3, 2.4, 3.6);
    });
    counts.shaft = zone(9, 120, () => { const a = Math.floor(GR() * 4) * Math.PI / 2 + (GR() - 0.5) * 0.3; return shoot(new THREE.Vector3(TOWER.x, 1.6 + Math.floor(GR() * 9) * 4 + GR() * 1.4, TOWER.z), new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 3, 0.3, 1.6, 2.6); });
    const shop = site.footprints.find((f) => f.x0 < -55 && f.z0 > 30);
    if (shop) counts.workshop = zone(14, 220, inBox(shop.x0 + 2, shop.x1 - 2, shop.z0 + 2, shop.z1 - 2, () => (GR() < 0.7 ? 1.3 : 5.5) + GR() * 1.2, 1.2));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('ao', new THREE.Float32BufferAttribute(aoA, 1)); g.setAttribute('bounce', new THREE.Float32BufferAttribute(boA, 3)); g.setAttribute('aY', new THREE.Float32BufferAttribute(ayA, 2)); g.setAttribute('aSeed', new THREE.Float32BufferAttribute(sdA, 1)); g.setIndex(idx);
    const wallT = texOf.wall?.diff, wm = wallT ? texMean(wallT, null) : null;
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
    const m = weatherPatch(new THREE.MeshStandardMaterial({ map: atlas, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 0.85, metalness: 0 }),
      { kind: 'decal', w: MATS.wall.w, roughMin: 0.8, uniforms: { uWallTex: { value: wallT || white }, uWallRep: { value: 1 / MATS.wall.tile }, uWallMean: { value: wm ? Math.max(0.01, 0.2126 * wm[0] + 0.7152 * wm[1] + 0.0722 * wm[2]) : 1 } } }, uniforms);
    const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; mesh.renderOrder = 2; scene.add(mesh);
    bStats.graffiti = { pieces: placed.length, big: placed.filter((p) => p.w >= 1.7).length, tags: placed.filter((p) => p.kind === 'tags').length, m2: Math.round(placed.reduce((s, p) => s + p.w * p.h, 0)), verts: pos.length / 3, tris: idx.length / 3, ...counts };
  }

  lap('graffiti');
  // [B] grass: photographed clumps (Poly Haven grass_medium_01: its 5 whole clumps, graphics #3; round 2's 9 sub-rects
  // sliced 8 of them in half) on trapezoid cross cards, one tuft per world-anchored base cell (no swimming),
  // green with a little straw (decision 3: <= 30 % straw). Lit diffuse-only with the sun shaded down the blades.
  // Perf (pixel-identical): cells are stored in rings around the camera cell, so the draw is front-to-back from every
  // heading; instanceCount stops at the fade radius; the vertex shader drops tufts outside the 4 side frustum planes.
  // A load-time mask replaces the per-vertex footprint/path loops. Altitude: hashes come from the integer base-cell
  // index, so level-2 tufts are exactly a subset of level-1 tufts; the others shrink away before the switch, width and
  // radius change continuously, and the field fades out above ~30 m AGL (the ground shader carries it from there).
  const gN = { low: 150, auto: 210, high: 260 }[quality] || 210, gCell = 0.34, baseR = gN * gCell * 0.5;   // narrow tufts, denser cells
  const GRECTS = [[205, 765, 478, 898], [598, 772, 842, 872], [28, 888, 206, 998], [238, 905, 508, 999], [588, 882, 812, 1000]];
  const gtx = texOf.grass || {}, atlasOK = !!(gtx.diff && gtx.alpha);
  const grassU = { uOrigin: { value: new THREE.Vector2() }, uCam: { value: new THREE.Vector3() }, uCell: { value: gCell }, uCell0: { value: gCell }, uR: { value: baseR },
    uWide: { value: 1 }, uOddK: { value: 1 }, uFade: { value: 1 }, uFr: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 0, 1e6)) },
    uRects: { value: GRECTS.map(([x0, y0, x1, y1]) => (atlasOK ? new THREE.Vector4(x0 / 1024, 1 - y1 / 1024, (x1 - x0) / 1024, (y1 - y0) / 1024) : new THREE.Vector4(0, 0, 1, 1))) }, ...maskU };
  // shared by the grass material and its blur-depth twin (contract C2)
  const GRASS_VS_HEAD = `attribute vec2 aCell;
uniform vec2 uOrigin; uniform vec3 uCam; uniform float uCell; uniform float uCell0; uniform float uR; uniform float uWide; uniform float uOddK; uniform float uFade;
uniform vec4 uRects[5]; uniform vec4 uFr[4];
uniform sampler2D uMask; uniform vec2 uMaskO; uniform float uMaskS;
float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gvn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(gh(i), gh(i + vec2(1, 0)), f.x), mix(gh(i + vec2(0, 1)), gh(i + vec2(1, 1)), f.x), f.y); }
float terrH(vec2 p){ float x = p.x, z = p.y; float d = max(max(abs(x + 5.0) - 95.0, abs(z - 10.0) - 85.0), 0.0);
  float n = sin(x * 0.021) * cos(z * 0.017) * 1.2 + sin(x * 0.053 + z * 0.041) * 0.45 + sin(z * 0.11 - x * 0.07) * 0.15;
  float ramp = min(1.0, d / 40.0); return n * ramp + min(d, 180.0) * 0.012 * ramp - 0.05 * (1.0 - ramp); }`;
  const GRASS_VS_CORE = `
  vec2 bi = floor((uOrigin + aCell * uCell) / uCell0 + 0.5);            // integer base-cell index: same tuft at every level
  vec2 bp = bi * uCell0 + (vec2(gh(bi), gh(bi + 17.3)) - 0.5) * uCell0 * 0.95;
  vec4 mk = textureLod(uMask, (bp - uMaskO) / uMaskS, 0.0);
  float r1 = gh(bi + 7.7), r2 = gh(bi + 3.3), r3 = gh(bi + 11.1), r4 = gh(bi + 23.9), r5 = gh(bi + 5.5);
  float member = step(mod(bi.x, 2.0) + mod(bi.y, 2.0), 0.5);
  float dcam = distance(bp, uCam.xz);
  // (r5 + 0.005: the fp32 hash is quantised to 1/256, so r5 == 0 happens and would keep tufts where density is 0)
  // near fade 0.6-1.5 m: blades at the lens would float as crisp sticks against the sky (the blur can't smear them)
  float keep = (1.0 - smoothstep(uR * 0.7, uR, dcam)) * step(r5 + 0.005, mk.r) * mix(uOddK, 1.0, member) * uFade * smoothstep(0.6, 1.5, dcam);
  vec4 rc = uRects[int(r4 * 4.999)];
  float hh = (0.32 + 0.8 * pow(r1, 1.3)) * (0.45 + 1.1 * mk.a) * keep;
  // the clumps are ~30 cm grass: squeeze them ~3x horizontally so blades stay blade-thin on 0.4-1.6 m tufts
  float wd = hh * (rc.z / rc.w) * 0.32 * (0.85 + 0.3 * r2) * uWide;
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
  vec2 gUv = rc.xy + uv * rc.zw;`;
  let grass, ringR = null, grassDepth = null;
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
    weatherPatch(gm, { kind: 'grass', aoExpr: 'gAO', uniforms: grassU, fsLights: GRASS_LIGHTS, diffuseOnly: true,
      vsHead: GRASS_VS_HEAD + '\nvarying vec3 vTint; varying float vDry; varying float vGv;',
      vsBegin: GRASS_VS_CORE + `
  #ifdef USE_MAP
  vMapUv = gUv;
  #endif
  #ifdef USE_ALPHAMAP
  vAlphaMapUv = gUv;
  #endif
  // straw: x0.4 and a later onset (decision 3), so dry tufts stay a minority patch, not the field
  vDry = 0.4 * clamp(smoothstep(0.40, 0.85, gvn(bp * 0.035 + 3.0) * 0.65 + gvn(bp * 0.21) * 0.35) * (0.45 + 0.55 * r2) + 0.2 * r1 * r1, 0.0, 1.0);
  vTint = vec3(0.9 + r2 * 0.22, 0.93 + r1 * 0.16, 0.8 + r3 * 0.25);
  vGv = uv.y;
  float gAO = mix(0.5, 1.0, uv.y) * (0.3 + 0.7 * mk.b);`,
      fsHead: 'varying vec3 vTint; varying float vDry; varying float vGv;',
      fsMap: `
  diffuseColor.rgb = mix(diffuseColor.rgb, lum3(diffuseColor.rgb) * vec3(1.3, 1.15, 0.8), vDry) * vTint;`,
      fsAlpha: `
  #ifdef USE_MAP
  { vec2 tx = vMapUv * 1024.0; diffuseColor.a *= 1.0 + 0.3 * clamp(0.5 * log2(min(dot(dFdx(tx), dFdx(tx)), dot(dFdy(tx), dFdy(tx)))), 0.0, 3.0); }
  #endif` }, uniforms);
    grass = new THREE.Mesh(card, gm); grass.frustumCulled = false; grass.receiveShadow = true; grass.renderOrder = 1; scene.add(grass);
    const fr = new THREE.Frustum(), pm = new THREE.Matrix4();
    const setFr = (r, s, cam) => {
      pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); fr.setFromProjectionMatrix(pm);
      for (let i = 0; i < 4; i++) { const p = fr.planes[i]; grassU.uFr.value[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant); }
    };
    grass.onBeforeRender = setFr;
    // [B] C2 blur depth: the same tufts, only the ring within ~8 m (its own instanceCount), alpha-tested like the grass
    const dcard = new THREE.InstancedBufferGeometry();
    for (const k of ['position', 'uv', 'aCell']) dcard.setAttribute(k, card.getAttribute(k));
    dcard.setIndex(card.index); dcard.instanceCount = 0;
    grassDepth = new THREE.Mesh(dcard, depthC2Mat({ vsHead: GRASS_VS_HEAD, vsMain: GRASS_VS_CORE + '\n  vUv = gUv;', uniforms: { ...grassU, uTime: uniforms.uTime },
      alphaTex: atlasOK ? gtx.alpha : gm.map, alphaCh: atlasOK ? 1 : 0, alphaTest: 0.38, texN: 1024, edge: [0.22, 0.5] }));
    grassDepth.frustumCulled = false; grassDepth.onBeforeRender = setFr;   // planes for this camera, whichever pass runs first
  }
  const ringCount = (r) => { let lo = 0, hi = ringR.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ringR[m] <= r) lo = m + 1; else hi = m; } return lo; };
  lap('grass');
  // [B] trees, wall thickets, field shrubs and saplings on slab edges: leaf-card balls with the photographed leaves,
  // merged per ~75 m tile (frustum culling in the scene, shadow and blur-depth passes). Normals point out of the whole
  // crown (it shades as one mass, both card faces alike); light is baked per plant with the same probe as the
  // buildings, so nothing glows under the silo table.
  const foliageStats = bStats.foliage = {}, leafTiles = [];
  let leafMap = null, leafOK = false;
  {
    const FR = rng(1301), lt = texOf.leaf || {}, UPV = new THREE.Vector3(0, 1, 0), fray = new THREE.Ray();
    leafOK = !!(lt.diff && lt.alpha); leafMap = leafOK ? leafCluster(lt.diff, lt.alpha, FR) : leafTexture(FR);
    const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const tpl = [];
    for (let k = 0; k < 9; k++) {
      const qq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(FR() - 0.5, FR() - 0.5, FR() - 0.5).normalize(), FR() * Math.PI);
      tpl.push([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => ({ p: new THREE.Vector3(u * 0.6, v * 0.6, 0).applyQuaternion(qq), uv: [(u + 1) / 2, (v + 1) / 2] })));
    }
    const TL = { x0: -150, z0: -125, n: 4, size: 75 }, tiles = new Map();
    const tileOf = (x, z) => {
      const i = Math.min(TL.n - 1, Math.max(0, Math.floor((x - TL.x0) / TL.size))), j = Math.min(TL.n - 1, Math.max(0, Math.floor((z - TL.z0) / TL.size))), k = j * TL.n + i;
      let t = tiles.get(k); if (!t) tiles.set(k, (t = { P: [], N: [], UV: [], C: [], AO: [], BO: [], SW: [], I: [] })); return t;
    };
    const q = new THREE.Quaternion(), eu = new THREE.Euler(), v = new THREE.Vector3(), n = new THREE.Vector3(), d = new THREE.Vector3();
    // nq cards per ball (of the 9 templates; the ball's own random turn keeps them from lining up)
    const ball = (c, s, cc, rad, pr, tint, swayK, baseY, nq = 9) => {
      eu.set(FR() * 6.28, FR() * 6.28, FR() * 6.28); q.setFromEuler(eu); const sy = s * (0.8 + FR() * 0.35), T = tileOf(cc.x, cc.z);   // a plant never straddles two tiles
      for (let k = 0; k < nq; k++) {
        const quad = tpl[k], b = T.P.length / 3;
        for (const { p, uv } of quad) {
          v.copy(p).applyQuaternion(q); v.set(v.x * s, v.y * sy, v.z * s).add(c);
          d.copy(v).sub(cc); const dl = d.length() / rad; d.normalize();
          n.copy(v).sub(c).normalize().lerp(d, 0.7); n.y += 0.25; n.normalize();
          const occ = 0.42 + 0.58 * sm(0.1, 1.0, dl * 0.7 + (d.y * 0.5 + 0.5) * 0.4);
          T.P.push(v.x, v.y, v.z); T.N.push(n.x, n.y, n.z); T.UV.push(uv[0], uv[1]); T.C.push(tint[0], tint[1], tint[2]);
          T.AO.push(pr.ao * occ); T.BO.push(pr.bo.x * occ, pr.bo.y * occ, pr.bo.z * occ); T.SW.push(Math.max(0, v.y - baseY) * swayK);
        }
        T.I.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
    };
    const probe = (p) => { const vis = lightProbe(bvh, p, UPV, 18, 4); return { vis, ao: aoCurve(vis), bo: LP.out.clone() }; };
    const tintOf = () => (FR() < 0.12 ? [1.18, 1.08, 0.7] : [0.85 + FR() * 0.3, 0.9 + FR() * 0.2, 0.8 + FR() * 0.3]);
    const clear = (x, y, z) => { let m = 6; for (let k = 0; k < 6; k++) { const a = k * 1.047; fray.origin.set(x, y, z); fray.direction.set(Math.cos(a), 0, Math.sin(a)); const h = bvh.raycastFirst(fray, THREE.DoubleSide, 0, 6); if (h) m = Math.min(m, h.distance); } return m; };
    const shrub = (x, z, s, nb, swayK, nq = 9) => {
      const y = terrainHeight(x, z), cl = clear(x, y + 0.6 * s, z); if (cl < 0.35) return false;
      s = Math.min(s, (cl + 0.3) / 0.6);
      const pr = probe(new THREE.Vector3(x, y + s, z)); if (pr.vis < 0.3) return false;       // no light, no growth
      const cc = new THREE.Vector3(x, y + s * 0.55, z), tint = tintOf();
      for (let b = 0; b < nb; b++) ball(new THREE.Vector3(x + (FR() - 0.5) * s * 0.9, y + s * (0.3 + FR() * 0.5), z + (FR() - 0.5) * s * 0.9), s * (0.65 + FR() * 0.4), cc, s * 1.2, pr, tint, swayK, y, nq);
      return true;
    };
    // trees: the limb clumps buildGeometry laid out on each leaning trunk, 7-11 small balls (0.08-0.13 h) per limb,
    // so the crown is lumpy with sky gaps and the branches show between the clumps
    for (const t of treeSpots) {
      const cc = new THREE.Vector3(...t.cc), pr = probe(cc.clone().addScaledVector(UPV, t.ry * 0.6)), tint = tintOf(), rad = Math.max(t.rx, t.ry);
      for (const [lx, ly, lz, lr] of t.limbs) {
        for (let b = 0, nb = 7 + Math.floor(FR() * 5); b < nb; b++)
          ball(new THREE.Vector3(lx + (FR() - 0.5) * 2 * lr, ly + (FR() - 0.5) * 1.5 * lr, lz + (FR() - 0.5) * 2 * lr), t.h * (0.08 + FR() * 0.05), cc, rad, pr, tint, 0.012, t.y + t.h * 0.3, 6);
      }
    }
    // overgrowth against the walls (art #1): ~250 shrub masses (1.5-3 m, 5-8 balls) in a 1-4 m band along ~40 % of every
    // footprint edge, in runs; clear of the tracks and of every low line gate (the doors and openings stay visible)
    let nBush = 0, nField = 0, nSap = 0, nTrack = 0;
    // doors and openings (gates up to 6 m wide) stay clear; along the wide ones (the silo table's edges) only small,
    // sparse shrubs, so the line stays flyable and readable
    const gates = (site.lines || []).filter((l) => l.c[1] - l.h / 2 < 4);
    const gateK = (x, z, s) => {
      let k = 0;
      for (const l of gates) {
        const u = l.u || [1, 0, 0], dx = x - l.c[0], dz = z - l.c[2], du = dx * u[0] + dz * u[2], dn = Math.hypot(dx - du * u[0], dz - du * u[2]);
        const along = Math.max(0, Math.abs(du) - l.w / 2);
        if (Math.hypot(along, dn) < 1.5 + s * 0.8) k = Math.max(k, l.w > 6 ? 1 : 2);
      }
      return k;   // 0 free, 1 by a wide gate, 2 in a door
    };
    const inFoot = (x, z, m) => site.footprints.some((f) => x > f.x0 - m && x < f.x1 + m && z > f.z0 - m && z < f.z1 + m);
    const masses = [], roomy = (x, z, s) => !masses.some(([mx, mz, ms]) => Math.hypot(x - mx, z - mz) < (s + ms) * 0.36);
    for (const f of site.footprints) {
      if ((f.x1 - f.x0) * (f.z1 - f.z0) < 20) continue;
      for (let side = 0; side < 4; side++) {
        const len = side < 2 ? f.x1 - f.x0 : f.z1 - f.z0;
        for (let t = -1 - FR() * 2; t < len + 1;) {
          const run = 3 + FR() * 7, on = FR() < 0.4;
          if (on) for (let u = t; u < Math.min(len + 1, t + run); u += (0.35 + FR() * 0.5) * 0.5) {
            const o = 1 + FR() * 3; let s = 1.5 + FR() * 1.5;
            const x = side < 2 ? f.x0 + u : side === 2 ? f.x0 - o : f.x1 + o, z = side < 2 ? (side === 0 ? f.z0 - o : f.z1 + o) : f.z0 + u;
            const gk = gateK(x, z, 1.2); if (gk === 2 || (gk === 1 && FR() < 0.7)) continue;
            if (gk === 1) s = Math.min(s, 1.6);
            if (inFoot(x, z, 0.4) || distToPaths(x, z) < 2.4 + s * 0.5 || !roomy(x, z, s)) continue;
            if (shrub(x, z, s, 5 + Math.floor(FR() * 4), 0.03, 5)) { nBush++; masses.push([x, z, s]); }
          }
          t += run;
        }
      }
    }
    // the reveal track from the spawn: thickets 4.5-7 m off its centreline, in runs (the corridor stays open)
    for (let z = 112; z > 64; z -= 1.4 + FR() * 1.6) {
      if (FR() < 0.45) continue;
      for (const sgn of [-1, 1]) {
        if (FR() < 0.35) continue;
        const x0 = z > 95 ? 0 : 6 * (95 - z) / 35, x = x0 + sgn * (4.5 + FR() * 2.5), s = 1.2 + FR() * 1.4;
        if (distToPaths(x, z) < 3.8 + s * 0.4 || !roomy(x, z, s)) continue;
        if (shrub(x, z, s, 4 + Math.floor(FR() * 4), 0.03, 5)) { nTrack++; masses.push([x, z, s]); }
      }
    }
    for (let k = 0; k < 90; k++) {
      const x = -125 + FR() * 240, z = -100 + FR() * 225;
      if (inFoot(x, z, 3) || distToPaths(x, z) < 4 || Math.hypot(x, z - 118) < 12) continue;
      if (shrub(x, z, 1.2 + FR() * 1.4, 3 + Math.floor(FR() * 3), 0.025, 6)) nField++;
    }
    // saplings where slabs and roofs end (rain, a crack, a little soil)
    const bigF = site.footprints.filter((f) => (f.x1 - f.x0) * (f.z1 - f.z0) > 60);
    for (let k = 0; k < 300 && nSap < 30 && bigF.length; k++) {
      const f = bigF[Math.floor(FR() * bigF.length)], x = f.x0 + FR() * (f.x1 - f.x0), z = f.z0 + FR() * (f.z1 - f.z0);
      fray.origin.set(x, 90, z); fray.direction.set(0, -1, 0); const h = bvh.raycastFirst(fray, THREE.DoubleSide, 0, 120);
      if (!h || h.point.y < 3.5 || Math.abs(h.face.normal.y) < 0.9) continue;
      // an edge or a corner of a real slab: 3 of the 4 probes land on it, or 2 at right angles (a corner). A narrow
      // member (the 0.9 m bridge beam, parapet tops) has its 2 hits opposite each other, and gets no saplings.
      let hits = 0, hx = 0, hz = 0;
      for (const [dx, dz] of [[1.1, 0], [-1.1, 0], [0, 1.1], [0, -1.1]]) { fray.origin.set(x + dx, h.point.y + 0.4, z + dz); if (bvh.raycastFirst(fray, THREE.DoubleSide, 0, 1.5)) { hits++; hx += dx; hz += dz; } }
      if (hits < 2 || hits === 4 || (hits === 2 && hx === 0 && hz === 0)) continue;
      const s = 0.45 + FR() * 0.8, base = h.point.clone(), cc = base.clone().addScaledVector(UPV, s * 0.5), pr = probe(cc.clone().addScaledVector(UPV, s * 0.5));
      if (pr.vis < 0.6) continue;                                   // roofs and outer edges only, not interior hole rims
      for (let b = 0, nb = 1 + Math.floor(FR() * 2); b < nb; b++) ball(cc.clone().add(new THREE.Vector3((FR() - 0.5) * s * 0.6, FR() * s * 0.4, (FR() - 0.5) * s * 0.6)), s, cc, s, pr, tintOf(), 0.04, base.y);
      nSap++;
    }
    const lm = weatherPatch(new THREE.MeshStandardMaterial({ map: leafMap, alphaTest: 0.42, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.8, metalness: 0, vertexColors: true,
      color: leafOK ? lin3(MATS.leaf.color) : new THREE.Color(1, 1, 1) }), { kind: 'leaf', fsAlpha: `
  #ifdef USE_MAP
  { vec2 tx = vMapUv * 512.0; diffuseColor.a *= 1.0 + 0.3 * clamp(0.5 * log2(min(dot(dFdx(tx), dFdx(tx)), dot(dFdy(tx), dFdy(tx)))), 0.0, 3.0); }
  #endif` }, uniforms);
    const ldm = depthC2Mat({ vsHead: 'attribute float aSway;', vsMain: `
  transformed += vec3(sin(uTime * 1.7 + position.x * 0.4 + position.z * 0.3), 0.3 * sin(uTime * 2.3 + position.y), cos(uTime * 1.3 + position.z * 0.35)) * aSway;
  vUv = uv;`, uniforms: { uTime: uniforms.uTime }, alphaTex: leafMap, alphaCh: 0, alphaTest: 0.42, texN: 512, edge: [0.12, 0.38], near: true });
    let cards = 0;
    for (const T of [...tiles.keys()].sort((a, b) => a - b).map((k) => tiles.get(k))) {
      if (!T.I.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(T.P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(T.N, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(T.UV, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(T.C, 3)); g.setAttribute('ao', new THREE.Float32BufferAttribute(T.AO, 1)); g.setAttribute('bounce', new THREE.Float32BufferAttribute(T.BO, 3));
      g.setAttribute('aSway', new THREE.Float32BufferAttribute(T.SW, 1)); g.setIndex(T.I); g.computeBoundingSphere(); g.boundingSphere.radius += 0.6;   // + sway
      const mesh = new THREE.Mesh(g, lm); mesh.castShadow = true; mesh.receiveShadow = true; mesh.renderOrder = 1; mesh.matrixAutoUpdate = false; mesh.name = 'foliage'; scene.add(mesh);
      const dm = new THREE.Mesh(g, ldm); dm.matrixAutoUpdate = false; leafTiles.push(dm);
      cards += T.I.length / 6;
    }
    Object.assign(foliageStats, { trees: treeSpots.length, thickets: nBush, track: nTrack, shrubs: nField, saplings: nSap, cards, tiles: leafTiles.length });
  }

  lap('foliage');
  // [B] distant treeline: each crown is 7 alpha-tested leaf-cluster cards (crownCards) on a round-topped crown, one
  // InstancedMesh named 'treeline' (A2 renders it into the static ring shadow map; its material is plain map +
  // alphaTest, so a depth proxy with the same map works). No shrink with distance: the camera far plane is 3000 m.
  // Haze = the physical amount at that range, 0.15 (1 - exp(-d / 600)) (decision 12), on top of the scene fog.
  // Instances run near to far from the site centre (front-to-back for the alpha-tested pass).
  {
    const crown = crownCards(), UPV = new THREE.Vector3(0, 1, 0), list = treeline.slice().sort((a, b) => Math.hypot(a.x + 5, a.z - 10) - Math.hypot(b.x + 5, b.z - 10));
    const tm = weatherPatch(new THREE.MeshStandardMaterial({ map: leafMap, alphaTest: 0.42, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 1, metalness: 0,
      color: leafOK ? lin3(MATS.leaf.color) : new THREE.Color(1, 1, 1) }), { kind: 'treeline', aoExpr: 'gAO',
      vsBegin: `
  float gAO = mix(0.35, 1.0, smoothstep(0.0, 0.85, position.y)) * (0.78 + 0.22 * normal.y);`,
      fsFog: `#ifdef USE_FOG
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, 0.15 * (1.0 - exp(-vFogDepth / 600.0)));   // aerial perspective of a distant wood
#endif`,
      fsAlpha: `
  #ifdef USE_MAP
  { vec2 tx = vMapUv * 512.0; diffuseColor.a *= 1.0 + 0.3 * clamp(0.5 * log2(min(dot(dFdx(tx), dFdx(tx)), dot(dFdy(tx), dFdy(tx)))), 0.0, 3.0); }
  #endif` }, uniforms);
    const M = new THREE.Matrix4(), qq = new THREE.Quaternion(), col = new THREE.Color(), P = new THREE.Vector3(), S = new THREE.Vector3();
    // relative to the leaf atlas: round 2's crown greens x1.5, a few darker/bluer and yellower stands
    const greens = [[0.72, 0.74, 0.82], [0.84, 0.82, 0.78], [0.62, 0.66, 0.76], [0.92, 0.88, 0.7]];
    const im = new THREE.InstancedMesh(crown, tm, list.length);
    list.forEach((t, i) => {
      qq.setFromAxisAngle(UPV, t.rot); M.compose(P.set(t.x, t.y, t.z), qq, S.set(t.w, t.h, t.d)); im.setMatrixAt(i, M);
      const gc = greens[Math.min(3, Math.floor(t.tint * 4))], k = 0.88 + t.tint * 0.24; im.setColorAt(i, col.setRGB(gc[0] * k, gc[1] * k, gc[2] * k));
    });
    // depth stand-in for A2's static ring shadow map (it uses customDepthMaterial when present): the same map cut-out
    // with the same mip alpha boost as the visible cards, so at ~0.9 m shadow texels the crowns' shadows keep their
    // fill. castShadow stays false: three's own live shadow pass never draws the treeline (it is A2's ring map's).
    const tdm = new THREE.MeshBasicMaterial({ map: leafMap, alphaTest: 0.42, side: THREE.DoubleSide, colorWrite: false });
    tdm.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <alphatest_fragment>', `#ifdef USE_MAP
  { vec2 tx = vMapUv * 512.0; diffuseColor.a *= 1.0 + 0.3 * clamp(0.5 * log2(min(dot(dFdx(tx), dFdx(tx)), dot(dFdy(tx), dFdy(tx)))), 0.0, 3.0); }
#endif
#include <alphatest_fragment>`); };
    tdm.customProgramCacheKey = () => 'treelineDepth';
    im.customDepthMaterial = tdm;
    im.computeBoundingSphere(); im.castShadow = false; im.receiveShadow = false; im.renderOrder = 1; im.matrixAutoUpdate = false; im.name = 'treeline'; scene.add(im);
    foliageStats.treeline = treeline.filter((t) => !t.outer).length; foliageStats.treelineOuter = treeline.length - foliageStats.treeline; lap('treeline');
  }
  // [B] contract C2: the blur depth's alpha-tested extras (fpvcam renders this after the collider, same camera, no
  // override material): near grass (<= 8 m ring) and the leaf tiles within 40 m. world.update() keeps them current.
  const depthScene = new THREE.Scene(); depthScene.name = 'depthScene';
  depthScene.add(grassDepth); leafTiles.forEach((m) => depthScene.add(m));
  depthScene.matrixWorldAutoUpdate = false; depthScene.updateMatrixWorld(true);
  scene.userData.depthScene = depthScene;
  const _ds = new THREE.Sphere();

  // [A1] lightmapped materials: the merged structures, the yard terrain, the path ribbons and, when every vertex
  // finds its wall, the graffiti (it then gets exactly the wall's indirect light). The far field keeps env x ao.
  if (lm) {
    for (const k of Object.keys(merged)) lmEnable(mats[k] || mats.wall);
    lmEnable(mats.ground); lmEnable(mats.path);
    const dm = scene.children.find((o) => o.isMesh && o.material?.customProgramCacheKey?.() === 'wp:decal');
    const dr = dm && bake.decalUV2(dm.geometry); if (dr) lmEnable(dm.material);
    if (lm.j.skies?.[SKIES[sky] ? sky : 'sunny']?.light) {   // the sky the map was baked with vs the one measured now
      const b = lm.s.light, d = Math.abs(b.sunI - sunI) / Math.max(1, sunI) + Math.abs(b.skyB[1] - aLight.uSkyB.value.y) / Math.max(0.1, aLight.uSkyB.value.y);
      if (d > 0.02) console.warn('[A1] lightmap baked with sunI', b.sunI, 'skyB', b.skyB, 'but the sky measures sunI', +sunI.toFixed(3), 'skyB', aLight.uSkyB.value.toArray().map((v) => +v.toFixed(3)), ': re-run node tools/bakelm.mjs');
    }
    bake.stats.decals = dr || 'probe';
  }
  // [A] sun: a shadowed DirectionalLight carrying the energy clamped out of the HDR.
  // [A2] Live map: +-52 m (5.1 cm texels at 2048) centred on the camera (no lead), snapped to a texel-aligned 8 m
  // light-space grid and re-rendered only when that snapped centre moves (autoUpdate off): >= 48 m of cover all round.
  // Beyond it the static far map (site casters), and over the far ground the static ring map (treeline crowns).
  const sun = new THREE.DirectionalLight(sk.sunColor, sunI);
  scene.environmentIntensity = envI;
  sun.castShadow = sunI > 0.5;                       // overcast: no shadow pass at all
  const sm = quality === 'low' ? 1024 : 2048; sun.shadow.mapSize.set(sm, sm);
  const { ext, back, snapM, lead } = LIVE_SHADOW;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 2 * back });
  sun.shadow.bias = -0.00008; sun.shadow.normalBias = 0.04; sun.shadow.camera.updateProjectionMatrix();   // 2.4 cm depth bias
  sun.shadow.autoUpdate = false; sun.shadow.needsUpdate = true;
  if (mats.brick) mats.brick.shadowSide = THREE.DoubleSide;   // the chimney tube casts with both skins (no leak down its throat)
  scene.add(sun); scene.add(sun.target);
  const texel = (2 * ext) / sm, snap = texel * Math.max(1, Math.round(snapM / texel));
  const lightBasisX = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize(), lightBasisY = new THREE.Vector3().crossVectors(sunDir, lightBasisX);
  const _fwd = new THREE.Vector3(), _ctr = new THREE.Vector3(); let shAx = NaN, shAy = NaN, shN = 0;
  if (sun.castShadow) {
    const fs = renderFarShadow(renderer, scene, merged, sunDir, quality === 'low' ? 1024 : 2048, aLight);
    if (mats.slab) mats.slab.aFarShadowTex = fs.tex;   // so clearWorld()'s material sweep disposes it with the world
    console.info('far shadow texel m', +fs.texel.toFixed(3));
    // [A2] treeline crowns (stream B's mesh or group named 'treeline'; absent = no ring map) into a static ring map
    // A sampler2DShadow must always see an allocated compare texture (three's null fallback is never uploaded, and
    // ANGLE then drops every draw), so without a treeline the far map stands in and uRingG.w stays 0.
    const tl = scene.getObjectByName('treeline');
    const siteBox = new THREE.Box3(); for (const g of Object.values(merged)) { if (!g.boundingBox) g.computeBoundingBox(); siteBox.union(g.boundingBox); }
    const rs = tl ? renderRingShadow(renderer, tl, sunDir, 1024, uniforms.aSky, new THREE.Vector2((siteBox.min.x + siteBox.max.x) / 2, (siteBox.min.z + siteBox.max.z) / 2)) : null;
    if (rs) { if (mats.slab) mats.slab.aRingShadowTex = rs.tex; console.info('ring shadow', rs.info); }
    else { uniforms.aSky.uRingSM.value = fs.tex; uniforms.aSky.uRingG.value.w = 0; console.info('ring shadow: no treeline object, off'); }
  }
  let grassLevel = 1;
  const update = (camPos, dt, camQuat) => {
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
    // [B] C2 depth: the grass ring within ~8 m, the leaf tiles within 40 m
    grassDepth.visible = grass.visible; grassDepth.geometry.instanceCount = Math.min(grass.geometry.instanceCount, ringCount(8 / cell + 1.5));
    for (const m of leafTiles) { _ds.copy(m.geometry.boundingSphere); m.visible = _ds.distanceToPoint(camPos) < 40; }
    // [A2] live shadow map follows the camera (lead 0: a heading-dependent centre re-rendered on every turn);
    // re-render only when its snapped centre moves
    _ctr.copy(camPos);
    if (camQuat && lead > 0) { _fwd.set(0, 0, -1).applyQuaternion(camQuat); _fwd.y = 0; const l = _fwd.length(); if (l > 1e-3) _ctr.addScaledVector(_fwd, (lead * ext) / l); }
    const ax = Math.round(_ctr.dot(lightBasisX) / snap) * snap, ay = Math.round(_ctr.dot(lightBasisY) / snap) * snap;
    if (ax !== shAx || ay !== shAy) {
      shAx = ax; shAy = ay; shN++;
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
  if (lm) lm.irr.pix = null;   // [A1] the CPU copy of the lightmap (14 MB) served the build-time probes only
  scene.userData.aLight = aLight; scene.userData.lightBake = bake.stats; scene.userData.aoUniforms = uniforms.aAO;   // [A] live tuning hooks (uSunB, uSkyB, uFarOn, uHaze...)
  // [A2] sky/shadow hooks: ring map uniforms, live-map re-render count (for perf checks), the world sun
  scene.userData.aSky = { u: uniforms.aSky, shadowUpdates: () => shN, sunDir: sunDir.clone(), rotY: skyDef.rotY || 0, bgI };
  return {
    scene, colliderScene: colScene, depthScene, bvh, skimBvh, update, hdr: true, stats: bStats,      // [B] depthScene: contract C2
    spawn: new THREE.Vector3(0, terrainHeight(0, 118) + 1.4, 118), yaw: 0,                       // first flight: the reveal
    takeStart: { pos: new THREE.Vector3(...site.takeStart.pos), yaw: site.takeStart.yaw },      // take retries: over the chimney mouth
    startPoints: site.startPoints.map((s) => ({ name: s.name, pos: new THREE.Vector3(...s.pos), yaw: s.yaw, ...(s.hint ? { hint: s.hint } : {}) })),   // START AT (C1)
    funnels: site.funnels,                                                                      // dive assist axes (C1, stream E)
    lines: site.lines,
    bounds: new THREE.Box3(new THREE.Vector3(-480, -5, -480), new THREE.Vector3(480, 260, 480)),
    envelope: { min: new THREE.Vector3(-440, -2, -440), max: new THREE.Vector3(440, 220, 440) },
    aoUniforms: uniforms.aAO,   // [A1] contract C3
  };
}
