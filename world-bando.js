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

// per-subsystem RNG streams: a draw added in one part of the site never reshuffles another part
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const subRng = (seed, name) => rng((hashStr(name) ^ Math.imul(seed | 0, 0x9E3779B1)) >>> 0);
const Y_UP = new THREE.Vector3(0, 1, 0);

// ---- layout. -z is north (silos, chimney), +z south (the hall, the spawn). The site is shaped around its named
// lines (see buildLines): chimney door -> pipe rack -> hall window is one straight line, the stair shaft is open
// top to bottom, the silo row has one 1.6 m gap lined up with the stair tower's openings.
const SILO = { x: [-48.3, -38.9, -28.9, -19.5], z: [-22, -6], r: 4.2, table: 5.2, top: 32 };   // gaps 1.0 / 1.6 / 1.0 m
const TOWER = { x: -33.9, z: -14, w: 4.4, T: 0.3 };
const SHAFT = { x0: TOWER.x - 2.05, x1: TOWER.x + 2.05, z0: TOWER.z - 2.05, z1: TOWER.z + 2.05 };   // inner faces
const HEAD = { x0: -54, x1: -14, z0: -17.8, z1: 0 };    // head house over the south row: the north row's caps stay open
const CHIM = { x: -8, z: -22, h: 50, rb: 3.4, rt: 2.0, th: 0.35 };   // in line with the north row: mouth beside the caps
const HALL = { x0: 6, x1: 70, z0: 14, z1: 36, fh: 5, levels: 3, cols: 11, rows: 5 };
const GAL = { A: [-14.3, 33.4, -6.5], B: [12.5, 15.35, 24.5], W: 3.0, H: 2.6 };
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
  for (const x of SILO.x) for (const z of SILO.z) {
    const g = cylGeo(sr, sr, siloTop - tableTop, 44, true); g.translate(x, (siloTop + tableTop) / 2, z); S.add('silo', g);
    if (z > HEAD.z0) continue;                                                  // capped by the head-house floor
    const cap = new THREE.CircleGeometry(sr, 44); cap.rotateX(-Math.PI / 2); planarUV(cap, { x, y: 0, z }); cap.translate(x, siloTop, z); S.add('slab', cap);
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

  // ---- chimney: hollow, tapered, brick; the door faces the rack and the hall window
  {
    const { x: cx, z: cz, h, rb, rt, th } = CHIM, aD = Math.atan2(DOOR[0], DOOR[1]);
    const off = (a) => Math.abs(Math.atan2(Math.sin(a - aD), Math.cos(a - aD)));
    const g = tubeGeo(rb, rt, h, th, 40, 25, (a, y) => y < 3.4 && off(a) < 0.42);
    g.translate(cx, 0, cz); S.add('brick', g);
    S.box('slab', cx, 0, cz, 8.5, 0.5, 8.5);
    S.footprints.push({ x0: cx - 4.5, x1: cx + 4.5, z0: cz - 4.5, z1: cz + 4.5 });
    const sa = aD + 1.05; S.spot(cx + Math.sin(sa) * 3.45, 1.6, cz + Math.cos(sa) * 3.45, Math.sin(sa), Math.cos(sa), 2.0, 1.3);
  }

  // ---- factory hall: 64 x 22 m, three storeys of 5 m, column grid, holes, ribbon windows, roof slots
  {
    const { x0, x1, z0, z1, fh, levels, cols, rows } = HALL;
    const dx = (x1 - x0) / (cols - 1), dz = (z1 - z0) / (rows - 1);
    S.footprints.push({ x0: x0 - 1, x1: x1 + 1, z0: z0 - 1, z1: z1 + 1 });
    S.box('slab', (x0 + x1) / 2, 0, (z0 + z1) / 2, x1 - x0 + 1.2, 0.18, z1 - z0 + 1.2);
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
  // take retry point: hovering 12 m north-east of the chimney mouth, looking at it (aimed 12 deg right) with the north
  // row's silo caps receding on the right and the head house beyond: the reference's signature frame. The door is a
  // quarter turn left at the bottom of the dive.
  const ts = [0.8, -0.6];
  S.takeStart = { pos: [CHIM.x + ts[0] * 12, CHIM.h + 5, CHIM.z + ts[1] * 12], yaw: Math.atan2(ts[0], ts[1]) - 0.21 };
  return S;
}

// ---- named lines: invisible portals, each {name, caption (*accent* word), pts, c, n, w, h} (+ u: width axis, two: either way,
// pre: gates that must have been crossed (same way) within `within` s). A segment of flight crossing the rectangle
// along +n scores. Two entries with the same name are one line (both directions / both portals).
function buildLines() {
  const lines = [], g = (c, n, w, h, u) => ({ c, n, w, h, u }), neg = (G) => ({ ...G, n: G.n.map((v) => -v) });
  const add = (name, caption, pts, main, extra = {}) => lines.push({ name, caption, pts, ...main, ...extra });
  const [dx, dz] = DOOR, perp = [dz, 0, -dx];
  // chimney: in at the mouth, out of the door
  const mouth = g([CHIM.x, CHIM.h - 3, CHIM.z], [0, -1, 0], 2.4, 2.4, [1, 0, 0]);
  const door = g([CHIM.x + dx * (CHIM.rb + 0.15), 2.1, CHIM.z + dz * (CHIM.rb + 0.15)], [dx, 0, dz], 3.0, 4.2, perp);
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
  add('TRIPLE POP', 'TRIPLE *POP*!', 2500, slot, { pre: [l1], within: 5 });
  add('TRIPLE DROP', 'TRIPLE *DROP*!', 2500, neg(l1), { pre: [neg(slot)], within: 5 });
  // conveyor gallery, mouth to mouth
  {
    const A = new THREE.Vector3(...GAL.A), B = new THREE.Vector3(...GAL.B), dir = B.clone().sub(A), L = dir.length(); dir.normalize();
    const zA = new THREE.Vector3().crossVectors(dir, Y_UP).normalize(), yA = new THREE.Vector3().crossVectors(zA, dir).normalize();
    const at = (s, sg) => g(A.clone().addScaledVector(dir, s).addScaledVector(yA, 1.35).toArray(), dir.clone().multiplyScalar(sg).toArray(), 2.8, 2.2, zA.toArray());
    add('GALLERY CLIMB', 'UP THE *GALLERY*!', 2000, at(1.5, -1), { pre: [at(L - 1.5, -1)], within: 9 });
    add('GALLERY DROP', 'DOWN THE *GALLERY*!', 1500, at(L - 1.5, 1), { pre: [at(1.5, 1)], within: 9 });
  }
  // stair shaft: head-house floor -> under the table
  const sw = SHAFT.x1 - SHAFT.x0;
  add('STAIRWELL DIVE', 'STAIRWELL *DIVE*!', 3000, g([TOWER.x, 4.9, TOWER.z], [0, -1, 0], sw, sw, [1, 0, 0]), { pre: [g([TOWER.x, SILO.top + 0.2, TOWER.z], [0, -1, 0], sw, sw, [1, 0, 0])], within: 9 });
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
  // the hall's ground floor, gable door to gable door
  const gd = (x) => g([x, 2.3, z0 + 2 * hdz], [1, 0, 0], hdz * 1.2, 4.2, [0, 0, 1]);
  add('HALL RUN', 'HALL *RUN*!', 2000, gd(HALL.x1), { pre: [gd(x0)], within: 12 });
  add('HALL RUN', 'HALL *RUN*!', 2000, neg(gd(x0)), { pre: [neg(gd(HALL.x1))], within: 12 });
  // across the hall through the two open bays at the end of the track from the spawn
  const win = (z) => g([x0 + 3.5 * hdx, 2.55, z], [0, 0, -1], hdx - 0.6, 2.7, [1, 0, 0]);
  add('STRAIGHT THROUGH', 'STRAIGHT *THROUGH*!', 1000, win(z0), { pre: [win(HALL.z1)], within: 4 });
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
  const colGeo = mergeGeometries([solidGeo, posOnly(terr), farCol], false);
  colGeo.computeBoundingBox();
  const bvh = new MeshBVH(colGeo, { maxLeafTris: 5 });
  // proximity / skim scoring: built structures and trunks only, so skimming the grass scores nothing
  const skimBvh = new MeshBVH(solidGeo, { maxLeafTris: 5 });

  return { site, terr, far, pathG, treeSpots, merged, colGeo, bvh, skimBvh, lines: site.lines, takeStart: site.takeStart };
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
  let skyFrac = 0;
  const ticker = setInterval(() => prog(0.05 + 0.55 * (skyFrac * 0.5 + (texDone / texTotal) * 0.5), 'Streaming sky and materials'), 200);
  const skyP = loadSky(SKIES[sky]?.id || SKIES.sunny.id, renderer, (f) => (skyFrac = f));

  // geometry (CPU) while downloads run
  const { site, terr, far, pathG, treeSpots, merged, colGeo, bvh, skimBvh } = buildGeometry(R, seed);
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
    for (let i = 0; i < p.count; i++) { const rx = p.getX(i) - site.chimney.x, rz = p.getZ(i) - site.chimney.z; if (rx * n.getX(i) + rz * n.getZ(i) < 0) { ao.setX(i, ao.getX(i) * 0.3); bo.setXYZ(i, bo.getX(i) * 0.5, bo.getY(i) * 0.5, bo.getZ(i) * 0.5); } }
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
    grassU.uCam.value.copy(camPos);
    const alt = camPos.y - terrainHeight(camPos.x, camPos.z);
    const want = alt > 40 ? 4 : alt > 14 ? 2 : 1;                       // power-of-two steps, with hysteresis
    if (want !== grassLevel && (want > grassLevel ? true : alt < (grassLevel === 4 ? 34 : 11))) grassLevel = want;
    const cell = gCell * grassLevel;
    grassU.uCell.value = cell; grassU.uScale.value = grassLevel; grassU.uR.value = gN * cell * 0.5;
    grassU.uOrigin.value.set(Math.floor(camPos.x / cell) * cell - (gN / 2) * cell, Math.floor(camPos.z / cell) * cell - (gN / 2) * cell);
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
    scene, colliderScene: colScene, bvh, skimBvh, update, hdr: true,
    spawn: new THREE.Vector3(0, terrainHeight(0, 118) + 1.4, 118), yaw: 0,                       // first flight: the reveal
    takeStart: { pos: new THREE.Vector3(...site.takeStart.pos), yaw: site.takeStart.yaw },      // take retries: by the chimney mouth
    lines: site.lines,
    bounds: new THREE.Box3(new THREE.Vector3(-480, -5, -480), new THREE.Vector3(480, 260, 480)),
    envelope: { min: new THREE.Vector3(-440, -2, -440), max: new THREE.Vector3(440, 220, 440) },
  };
}
