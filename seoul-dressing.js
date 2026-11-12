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
  // [P6-E perf] the low roof props (planters, pipe runs, solar panels: every top under the 0.9 m parapet): their own mesh,
  // drawn only with the camera at or above the lowest roof that carries one (facts.roofHideY; build() hides it below, where
  // the parapets hide them anyway). Same look as dr_prop / dr_galv / dr_steel through the vertex colour.
  // [P6-E fpv #6 / art bug] the posts' powder coat: semi-gloss, so a post 2 m from the lens (w21) carries the signs' highlights
  // down its length and reads as a painted steel tube, not a flat dark column (dr_prop's 0.6 kills every highlight)
  dr_paint: { color: [1, 1, 1], rough: 0.32, vcol: true, albedo: [0.06, 0.06, 0.065] },
  dr_roof: { color: [1, 1, 1], rough: 0.6, vcol: true, fold: false, roofOnly: true, albedo: [0.3, 0.3, 0.29] },
  dr_tarp: { color: [1, 1, 1], rough: 0.75, vcol: true, emissive: true, double: true, albedo: [0.35, 0.14, 0.05] },   // lit from inside
  dr_glow: { color: [0.02, 0.02, 0.02], rough: 0.35, emissive: true, albedo: [0.02, 0.02, 0.02] },    // lit faces, tubes, doors
  dr_roadpaint: { color: [1, 1, 1], rough: 0.5, vcol: true, decal: true, noCol: true, albedo: [0.6, 0.6, 0.58] },   // wet via S3's name rule
  dr_bark: { color: [0.30, 0.27, 0.24], rough: 0.92, map: 'veg_bark_a.jpg', mapRepeat: [0.5, 1], albedo: [0.11, 0.095, 0.08] },   // [P3-E] bando's CC0 bark (left tile)
  dr_leaf: { color: [1, 1, 1], rough: 0.8, vcol: true, albedo: [0.42, 0.33, 0.06] },
  // [P3-E art #4] ginkgo leaf cards: bando's V1 cluster tiles (CC0, tools/seoul-ginkgo-cards.py) as a luminance map, the
  // vertex colour = albedo / 0.5 (gold to yellow-green per card), alpha-tested, crown-mass normals on both faces
  dr_leafcard: { color: [1, 1, 1], rough: 0.78, vcol: true, map: 'seoul/dressing/ginkgo_cards.png', alphaTest: 0.42, double: true, cardNormals: true, noCol: true, albedo: [0.42, 0.31, 0.05] },
  // [P3-E graphics #2] the AC unit's face (tools/seoul-ac-face.py: louvres, fan grille, plate, grime), tinted per unit
  dr_ac: { color: [0.62, 0.62, 0.6], rough: 0.55, vcol: true, map: 'seoul/dressing/ac_face.png', noCol: true, albedo: [0.42, 0.42, 0.4] },
  // [P3-E fpv #3] background massing (procedural facades: the ring's building shader; uv = metres, colour = floorH, seed, H)
  // [P4-E bug] fold: false (+ shader) so C's groupMeshes keeps it out of the city atlas group: folded, its colour attribute
  // (floorH, seed, H) became a vertex tint of (3, 0.5, 12) and the 222 villas rendered violet (41, 28, 61) in the horizon still
  dr_mass: { color: [1, 1, 1], rough: 0.9, vcol: true, mass: true, fold: false, shader: true, albedo: [0.2, 0.19, 0.18] },
  // [P3-E] clear vinyl (pocha fronts)
  // [P4-E art #6] fogged vinyl: the inside light scatters in its condensation (aEm per vertex; seen x opacity), so the front
  // reads as a lit sheet with the tables behind it instead of an open box
  dr_vinyl: { color: [0.32, 0.30, 0.28], rough: 0.12, transparent: true, opacity: 0.4, double: true, noCol: true, emissive: true, vcol: true, albedo: [0.05, 0.05, 0.05] },
};
// [P7-E lighting #4] standing water at the post bases (see the posts): a transparent decal over the ground, drawn by
// seoul-light's wet path as a full puddle (material() raises cityPud to uCityWet inside the rim; uv.x is the rim's fade)
DRESS_MATS.dr_puddle = { color: [1, 1, 1], rough: 0.1, vcol: true, decal: true, noCol: true, transparent: true, opacity: 1, wet: true, puddle: true, fold: false, albedo: [0.07, 0.066, 0.062] };
// [P7-E perf #1] distance tiers. The busy kit (scooters, crates, awnings, post sleeves, AC brackets, tree limbs and crowns)
// is drawn in two versions: `lod: 'near'` keys (…N, the full model) and `lod: 'far'` keys (…F, a proxy: a few boxes, a
// single-band sleeve, half the leaf cards at 1.45x). seoul-light splits every key into 64 m cells (BatchedMesh instances);
// build().update shows a cell's N part and hides its F part when the camera is within LOD_R of the cell's square (with the
// camera's height over 10 m added), and the other way round beyond it. N-only parts (limbs, brackets, fallen leaves) have
// no proxy. Same draw for draw within LOD_R, so every close-up is unchanged; the collider is untouched (render only).
// A port draws the same rule: world.json materials[k].lod / .lodR.
export const LOD_R = 30;
{ const M = DRESS_MATS, T = (base, lod, o = {}) => ({ ...base, ...o, fold: false, lod, lodR: LOD_R });
  const metal = { color: [1, 1, 1], rough: 0.4, metal: 0.7, vcol: true, albedo: [0.2, 0.2, 0.21] };
  Object.assign(M, { dr_propN: T(M.dr_prop, 'near'), dr_propF: T(M.dr_prop, 'far'), dr_paintN: T(M.dr_paint, 'near'),
    dr_metalN: T(metal, 'near'), dr_barkN: T(M.dr_bark, 'near'), dr_leafcardN: T(M.dr_leafcard, 'near'), dr_leafcardF: T(M.dr_leafcard, 'far') }); }
// [P5-E art #6] the street carts' menu light boxes (one per cart menu above, in its order): items with 2026 prices, photo tones
const CART_MENU = [
  { items: ['떡볶이 5,000', '순대 5,000', '튀김 3,000'], cols: ['#c8321c', '#5a3a34', '#d89a3a'] },
  { items: ['호떡 2,000', '씨앗호떡 2,500', '어묵 1,500'], cols: ['#b8762c', '#9a6430', '#d8b88a'] },
  { items: ['어묵 1,500', '꼬치 3,000', '국물 무료'], cols: ['#d8b88a', '#a8642c', '#c89a5a'] },
  { items: ['타코야끼 6알 5,000', '10알 7,000', '음료 2,000'], cols: ['#8a5a2a', '#6a4a2a', '#2a6ab0'] },
  { items: ['닭꼬치 4,000', '매운맛 4,500', '소떡소떡 3,500'], cols: ['#a8441c', '#c8321c', '#b86a2a'] },
  { items: ['와플 3,000', '츄러스 3,000', '아이스크림 2,500'], cols: ['#d8a04a', '#b8742a', '#f0e0c8'] },
  { items: ['군고구마 5,000', '군밤 5,000', '옥수수 3,000'], cols: ['#7a3a2a', '#6a4424', '#e8c03a'] },
  { items: ['계란빵 2,500', '붕어빵 3개 2,000', '호떡 2,000'], cols: ['#e0b04a', '#b87a34', '#b8762c'] },
];
// S1/C keys this module writes into (attribute layout: position, normal, uv)
const C_KEYS = new Set(['concrete', 'tile', 'walk', 'metal', 'white', 'dark', 'pole', 'brick', 'plaster']);
const specOf = (k) => DRESS_MATS[k] || { emissive: false, vcol: false };

// browser: a ready material for an E key (C uses its own for C keys)
export function material(key, renderer) {
  const m = DRESS_MATS[key]; if (!m) return null;
  if (m.mass) {   // [P3-E] procedural facades (not lit by the city grid: their light is in the shader, like the ring's)
    // [P4-E] the ring's shared uniforms (haze on the sky's horizon, the take clock); kind from H: > 24 m a tower, < 3.2 m a rooftop room
    const mat = new THREE.ShaderMaterial({ uniforms: RING_U,
      vertexShader: 'attribute vec3 color; varying vec2 vUV; varying vec4 vB; varying vec3 vN; varying vec3 vW; void main(){ vUV = uv; vB = vec4(color.x, color.z > 24.0 ? 2.0 : color.z < 3.2 ? 3.0 : 0.0, color.y, color.z); vN = normal; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: BEYOND_HZ + BEYOND_BLD_FS });
    mat.userData.cityLight = false; mat.name = 'seoul:' + key; return mat;
  }
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...m.color), roughness: m.rough ?? 0.8, metalness: m.metal || 0, vertexColors: !!m.vcol });
  if (m.transparent) { mat.transparent = true; mat.opacity = m.opacity ?? 0.5; mat.depthWrite = false; }
  if (m.double) mat.side = THREE.DoubleSide;
  if (m.decal) { mat.polygonOffset = true; mat.polygonOffsetFactor = -3; mat.polygonOffsetUnits = -3; }
  if (m.map) {   // [P3-E] textured keys (ginkgo cards, bark): files next to this module's repo root
    mat.map = texOf(m.map, renderer, m.mapRepeat); mat.color.setRGB(...m.color);
    if (m.alphaTest) { mat.alphaTest = m.alphaTest; mat.side = THREE.DoubleSide; }
  }
  if (m.puddle) {
    // seoul-light's patchMaterial (wet) runs this first and then its own chunk edits: ours follows its roughness block, so
    // cityPud / cityWet (WET_HEAD) are set by then; inside the rim it is standing water (mirror sharp, roughness 0.12, the
    // ground under it darker), at the rim it fades out; dry (uCityWet 0) or unpatched, nothing draws
    mat.userData.wet = 1; mat.depthWrite = false;
    mat.onBeforeCompile = function (sh) {
      const wetOn = /cityW/.test(this.customProgramCacheKey?.() || '');
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vPudA;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvPudA = uv.x;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vPudA;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + (wetOn
          ? '  { float pa = smoothstep(0.0, 1.0, vPudA); cityPud = max(cityPud, uCityWet * pa); cityWet = max(cityWet, cityPud); diffuseColor.rgb *= mix(1.0, 0.7, pa); diffuseColor.a = pa * clamp(uCityWet * 1.6, 0.0, 1.0); }'
          : '  diffuseColor.a = 0.0;'));
    };
    mat.customProgramCacheKey = () => 'seoul:dr-puddle';
  }
  if (m.cardNormals) {
    // leaf cards keep their crown-mass normal on both faces (three flips it on back faces), and alpha holds up in the mips
    // (bando V1's alpha boost) so far crowns do not thin out to twigs
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev?.(sh, r);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(/normal \*= faceDirection;/g, '').replace(/bitangent \*= faceDirection;|tangent \*= faceDirection;/g, ''))
        .replace('#include <alphatest_fragment>', `#ifdef USE_MAP
  { vec2 tx = vMapUv * vec2(textureSize(map, 0)); diffuseColor.a *= 1.0 + 0.3 * clamp(0.5 * log2(min(dot(dFdx(tx), dFdx(tx)), dot(dFdy(tx), dFdy(tx)))), 0.0, 3.0); }
#endif
#include <alphatest_fragment>`);
    };
    mat.customProgramCacheKey = () => 'seoul:dr-card';
    mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1;   // fallen-leaf cards lie on the pavement
  }
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

const TEX = new Map();
function texOf(file, renderer, rep) {
  if (TEX.has(file)) return TEX.get(file);
  const t = new THREE.TextureLoader().load(new URL('./' + file, import.meta.url).href);
  t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = renderer?.capabilities ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  if (rep) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep[0], rep[1]); }
  TEX.set(file, t); return t;
}

// ---------------------------------------------------------------------------------------------------------- helpers
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
function rng(seed) { let s = (typeof seed === 'number' ? seed : Math.floor(hash(seed) * 4294967296)) >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep01 = (x, a, b) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
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
  tri(a, b, c, ua, ub, uc, ea, eb, ec, col, nOv) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    if (nOv) { nx = nOv[0]; ny = nOv[1]; nz = nOv[2]; }   // [P3-E] shading normal override (leaf cards: the crown-mass normal)
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
const slimOut = (o) => { const { merged, colTris, ...rest } = o; return rest; };   // [P5-D] what outlives the build
export function geometry(layout, opts = {}) {
  const t0 = Date.now();
  const seed = opts.seed ?? 11, R0 = rng('dress' + seed);
  const M = blockModel(layout);
  const gates = gatesOf(opts.lines);
  // [P5-E] flight corridors: the polyline through each line's pre-gates and gate, and on to the next entry of the same line
  // ("WALKING STREET 1/7" ...) or one within 40 m. Overhead and rooftop dressing keeps out of them (gates alone miss the run).
  const corr = [];
  { const L = (opts.lines?.lines || []).filter((l) => l.c && !l.carve), base = (n) => String(n || '').replace(/\s+\d+\/\d+$/, '');
    let prev = null;
    for (const l of L) { const pts = [...(l.pre || []).map((p) => p.c), l.c];
      if (prev && (base(prev.l.name) === base(l.name) || Math.hypot(...v3.sub(prev.p, pts[0])) < 40)) corr.push([prev.p, pts[0]]);
      for (let i = 0; i + 1 < pts.length; i++) corr.push([pts[i], pts[i + 1]]);
      prev = { l, p: pts[pts.length - 1] }; } }
  const segD3 = (p, a, b) => { const v = v3.sub(b, a), l2 = v3.dot(v, v) || 1e-9, t = clamp(v3.dot(v3.sub(p, a), v) / l2, 0, 1); return Math.hypot(...v3.sub(p, v3.add(a, v3.mul(v, t)))); };
  // an AABB (as aabbSince) within m of a corridor (sampled along the segment against the box grown by m)
  const corrHit = (b, m = 1.5) => { for (const [a, c] of corr) { if (Math.min(a[0], c[0]) > b[3] + m || Math.max(a[0], c[0]) < b[0] - m || Math.min(a[1], c[1]) > b[4] + m || Math.max(a[1], c[1]) < b[1] - m || Math.min(a[2], c[2]) > b[5] + m || Math.max(a[2], c[2]) < b[2] - m) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(...v3.sub(c, a)) / 0.5)); for (let k = 0; k <= n; k++) { const p = [lerp(a[0], c[0], k / n), lerp(a[1], c[1], k / n), lerp(a[2], c[2], k / n)];
      if (p[0] > b[0] - m && p[0] < b[3] + m && p[1] > b[1] - m && p[1] < b[4] + m && p[2] > b[2] - m && p[2] < b[5] + m) return true; } } return false; };
  // [P7-E] the take's start points (the drone spawns there): the phase-7 additions keep 1.5 m off them (test-seoul: 0.8 m)
  const starts = (opts.lines?.startPoints || []).map((sp) => sp.pos).filter(Boolean);
  const startOK = (pts, m = 1.5) => { for (const p of pts) for (const q of starts) if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < m) return false; return true; };
  const polyCorrOK = (pts, m = 1.2) => { for (const p of pts) for (const [a, c] of corr) if (segD3(p, a, c) < m) return false; return true; };
  const shopTop = opts.shopTop ?? 2.95, fasciaY = opts.fasciaY ?? 3.05;
  const dens = clamp(opts.density ?? 1, 0, 3);   // clutter density (scooters, stools, bags): a perf knob, 1 = the reference look
  const acc = {}; const A = (k) => (acc[k] ||= new Acc(specOf(k)));
  const col = new FBuf(1 << 16);       // collider positions (non-indexed)
  const emitters = [], setPieces = [], holes = [], cables = [], labels = [], lamps = [], anchors = {}, out_puddles = [];   // [P4-E] anchors: real objects a line hangs off (lines.mjs)
  const spPush = setPieces.push.bind(setPieces);
  setPieces.push = (...sps) => { for (const sp of sps) gates.push(...spGates(sp)); return spPush(...sps); };
  const msParts = {}, triParts = {}; let tLap = Date.now(), nLap = 0; const lap = (k) => { const t = Date.now(); msParts[k] = t - tLap; tLap = t; let n = 0; for (const a of Object.values(acc)) n += a.p.length / 9; triParts[k] = Math.round(n - nLap); nLap = n; if (opts.ranges) opts.ranges.push([k, Object.fromEntries(Object.entries(acc).map(([q, a]) => [q, a.p.length / 9]))]); };   // [P7-E] opts.ranges (debug): each lap's per-key triangle counts
  const facts = { tris: 0, colTris: 0, items: 0, rejectedByGates: 0, scooters: 0, tents: 0, trees: 0, awnings: 0, cablesExtra: 0, drops: 0, signals: 0, crossings: 0, plates: 0, doors: 0, b1: 0, stairs2f: 0 };

  // ---------------- kit state: material key, colour (vcol keys), emission (emissive keys), collidable
  // [P6-E perf] S.draw false: collider only (the cables: build() draws them as screen-space lines, which cover close-ups too)
  const S = { key: 'concrete', c: [0.5, 0.5, 0.5], em: null, col: true, n: null, draw: true };
  const set = (key, o = {}) => { S.key = key; S.c = o.c || S.c; S.em = o.em ?? null; S.col = o.col ?? !specOf(key).noCol; S.n = o.n || null; S.draw = true; return S; };
  // [P7-E perf #1] the tier in force (null: always drawn; 'N' near, 'F' far): near(fn) / far(fn) route what fn draws to the
  // tier keys (emissive, transparent and decal keys stay untiered); plain keys take their colour into the vertex colour
  let tier = null;
  const TIER_C = { dark: [0.03, 0.03, 0.032], concrete: [0.32, 0.31, 0.29], metal: [0.3, 0.3, 0.31], white: [0.7, 0.7, 0.68] };
  const tierKey = (k) => { const m = specOf(k); if (m.emissive || m.transparent || m.decal || m.mass || k === 'dr_roof' || k === 'dr_ac') return null;
    if (tier === 'F') return k === 'dr_leafcard' ? 'dr_leafcardF' : 'dr_propF';   // proxies: one vcol key (+ the crowns' cards)
    return (k === 'dr_bark' || k === 'dr_leafcard' || k === 'dr_paint' ? k : k === 'dr_steel' || k === 'dr_galv' ? 'dr_metal' : 'dr_prop') + tier; };
  const near = (fn) => { const t = tier; tier = 'N'; try { return fn(); } finally { tier = t; } };
  const far = (fn) => { const t = tier; tier = 'F'; try { return fn(); } finally { tier = t; } };
  const uvDef = [[0, 0], [1, 0], [1, 1], [0, 1]];
  function tri(a, b, c, ua = [0, 0], ub = [1, 0], uc = [1, 1], e) {
    const tk = tier && S.draw ? tierKey(S.key) : null;
    if (tk) { const m = specOf(S.key); A(tk).tri(a, b, c, ua, ub, uc, null, null, null, m.vcol && specOf(tk).vcol ? S.c : (m.map && !specOf(tk).map ? m.albedo : m.color) || TIER_C[S.key] || G3, S.n); }
    else if (S.draw) A(S.key).tri(a, b, c, ua, ub, uc, e ? e[0] : S.em, e ? e[1] : S.em, e ? e[2] : S.em, S.c, S.n);
    if (S.col && tier !== 'F') { col.need(9); col.p3(a[0], a[1], a[2]); col.p3(b[0], b[1], b[2]); col.p3(c[0], c[1], c[2]); }   // proxies never collide
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
  // [P6-E perf] a cable: collided (if S.col) but not rendered; the caller pushes it to `cables` (screen-space lines in build())
  // phase 5 drew every cable twice: the 3-4 sided tube (~50k tris) under the line that covered it
  function cable(pts, r, sides = 3, rLine = r) { const d = S.draw; S.draw = false; tube(pts, r, sides); S.draw = d; cables.push({ pts: pts.map(r3), r: rLine }); facts.cableColOnly = (facts.cableColOnly || 0) + 1; }
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
    if (o.corr && corrHit(aabbSince(m), o.corr)) { undo(); facts.rejectedByCorr = (facts.rejectedByCorr || 0) + 1; return false; }   // [P5-E]
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
  for (const e of opts.emitters || []) if (e.kind === 'street' && e.pos && !String(e.id).startsWith('dress:')) occAdd(e.pos[0], e.pos[2], 1.8);   // [P4-E] not E's own (fed back by a caller)
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
  // ---- 3. UNDER THE STAGE: the busking canopy on 걷고싶은거리 (Eoulmadang-ro walking street, s069: design #1 puts the hero line
  // on the real street). [P3-E] Canopy 3.2 m at the street edge (3.6 m at the back), 7 m deep; a low platform at the back,
  // the busk spot in front of it (pos/yaw/busk: G's ring stands there, the audience arc 2.6-4.1 m out toward the street), the
  // gates along the canopy over the audience's heads at 1.95-2.88 m (0.32 m under the edge beam). Off C's poles and lamps.
  {
    const walks = M.streets.filter((s) => s.kind === 'walking'), hero = walks.filter((s) => s.id === 's069');
    let best = null;
    const offOthers = (st, x, z) => M.streets.every((o) => o === st || M.project(o, x, z).dist > o.width / 2 + 9);   // not at a junction
    for (const st of hero.length ? hero : walks) for (let s = 12; s < st.len - 12; s += 2) {
      const q = M.at(st, s), nx = -q.tz, nz = q.tx;
      if (!offOthers(st, q.x, q.z) || !inCore(q.x, q.z)) continue;
      const fl = M.freeRay(q.x, q.z, nx, nz, 25), fr = M.freeRay(q.x, q.z, -nx, -nz, 25);
      const span = Math.min(fl, 20) + Math.min(fr, 20);
      if (!isFinite(span) || span < 12) continue;
      const sd = fl >= fr ? 1 : -1, free = Math.min(sd > 0 ? fl : fr, 12), dep = Math.min(7.0, span * 0.45), back = free - 0.5;
      const F = frameH([q.x + nx * sd * (back - dep / 2), 0, q.z + nz * sd * (back - dep / 2)], q.tx, q.tz);
      if (!rectFree(F, -5.1, 5.1, -dep / 2, dep / 2, (x, z) => occFree(x, z, 0.3) && !M.lotAt(x, z))) continue;
      const score = span - Math.hypot(q.x - 15, q.z + 142) * 0.06;   // toward G's busk[0] ring (15, -142), the Hongik-ro end (design #1)
      if (!best || score > best.score) best = { st, s, q, fl, fr, score, nx, nz, sd, back, dep };
    }
    if (best) {
      const { q, nx, nz, sd, back, dep } = best, len = 9.0, yE = 3.2, yB = 3.6;
      const cx = q.x + nx * sd * (back - dep / 2), cz = q.z + nz * sd * (back - dep / 2);
      const F = frameH([cx, 0, cz], q.tx, q.tz);                              // x along the street, z across (toward -sd = street centre)
      const zin = -sd * dep / 2, zback = sd * dep / 2;                        // street side, building side
      const zSpot = zback - sd * 2.1, zAud = zSpot - sd * 3.3;                 // the busk spot (in front of the platform), the audience's centre
      item(() => {
        // low platform at the back (speakers, amp; the busker stands in front of it, on the street)
        set('dr_prop', { c: [0.03, 0.03, 0.035] }); boxMM(F, -3.2, 0, zback - sd * 1.6, 3.2, 0.32, zback - sd * 0.15);
        set('dr_glow', { em: NI([1.0, 0.75, 0.45], 300), col: false }); boxMM(F, -3.2, 0.24, zback - sd * 1.61 - 0.01, 3.2, 0.27, zback - sd * 1.6 + 0.01);
        // truss columns (corners only at the street edge: a 9 m truss), the mono-pitch membrane roof
        set('dr_galv'); for (const z of [zin * 0.94, zback * 0.94]) for (const x of z === zin * 0.94 ? [-len / 2 + 0.2, len / 2 - 0.2] : [-len / 2 + 0.2, 0, len / 2 - 0.2]) { const yt = z === zin * 0.94 ? yE : yB; boxMM(F, x - 0.1, 0, z - 0.1, x + 0.1, yt, z + 0.1); }
        set('dr_steel'); for (const z of [zin * 0.94, zback * 0.94]) { const yt = z === zin * 0.94 ? yE : yB; boxMM(F, -len / 2, yt, z - 0.12, len / 2, yt + 0.28, z + 0.12); }
        for (const x of [-len / 2 + 0.2, 0, len / 2 - 0.2]) tube([W(F, x, yE + 0.14, zin * 0.94), W(F, x, yB + 0.14, zback * 0.94)], 0.06, 4);
        { const a = W(F, -len / 2 - 0.2, yE + 0.28, zin * 1.02), b = W(F, len / 2 + 0.2, yE + 0.28, zin * 1.02), c = W(F, len / 2 + 0.2, yB + 0.28, zback * 1.02), d = W(F, -len / 2 - 0.2, yB + 0.28, zback * 1.02);
          const up = v3.norm(v3.cross(v3.sub(b, a), v3.sub(d, a))), nU = up[1] > 0 ? up : v3.mul(up, -1);
          set('white'); quad(a, b, c, d, nU); quad(a, d, c, b, v3.mul(nU, -1));
          boxMM(F, -len / 2 - 0.2, yE + 0.22, zin * 1.02 - 0.03, len / 2 + 0.2, yE + 0.3, zin * 1.02 + 0.03); }
        // festoon bulbs along the street edge (under the beam) and down the middle (warm 2200 K point sources)
        set('dr_glow', { em: NI(srgb(0xffb46b), 1600), col: false });
        for (let x = -len / 2 + 0.3; x <= len / 2 - 0.2; x += 0.6) for (const [z, y] of [[zin * 0.97, yE - 0.12 - 0.07 * Math.cos((x / len) * TAU * 1.5)], [(zin + zback) * 0.5, (yE + yB) / 2 - 0.1 - 0.06 * Math.cos((x / len) * TAU * 1.5)]]) {
          const p = W(F, x, y, z); blob([p[0], p[1] - 0.06, p[2]], 0.05, 0.055, 0.05, R0, 0, 0.05); boxMM(FW, p[0] - 0.012, p[1] - 0.02, p[2] - 0.012, p[0] + 0.012, p[1] + 0.02, p[2] + 0.012); }
        set('dark'); for (const [z, y0] of [[zin * 0.97, yE - 0.07], [(zin + zback) * 0.5, (yE + yB) / 2 - 0.05]]) { const pts = []; for (let x = -len / 2 + 0.3; x <= len / 2 - 0.2; x += 0.3) pts.push(W(F, x, y0 - 0.07 * Math.cos((x / len) * TAU * 1.5), z)); tube(pts, 0.006, 3); }
        // PA: two speaker stacks on the platform, an amp, a mic stand at the spot; a portable LED panel lighting the busker
        set('dr_prop', { c: [0.02, 0.02, 0.022] });
        for (const x of [-2.7, 2.7]) { boxMM(F, x - 0.28, 0.32, zback - sd * 1.0 - 0.2, x + 0.28, 1.15, zback - sd * 1.0 + 0.2); cyl(F, [x, 1.5, zback - sd * 1.0], 'y', 0.025, 0.7, 6); boxMM(F, x - 0.22, 1.85, zback - sd * 1.0 - 0.16, x + 0.22, 2.4, zback - sd * 1.0 + 0.16); }
        boxMM(F, 1.2, 0.32, zback - sd * 0.6 - 0.2, 1.8, 0.75, zback - sd * 0.6 + 0.2);
        set('dr_galv'); cyl(F, [0.6, 0.72, zSpot], 'y', 0.012, 1.45, 5);
        set('dr_steel'); cyl(F, [-1.9, 1.2, zback - sd * 0.5], 'y', 0.02, 1.7, 5);
        set('dr_glow', { em: NI([1.0, 0.92, 0.82], 1500), col: false }); boxMM(F, -2.15, 1.95, zback - sd * 0.5 - 0.04, -1.65, 2.25, zback - sd * 0.5 + 0.04);
        // back wall: dark panel with the busking-zone sign
        set('dr_steel'); boxMM(F, -3.4, 0, zback - 0.06, 3.4, yB - 0.1, zback + 0.06);
        set('dr_glow', { em: NI([0.95, 0.35, 0.45], 140), col: false });
        quad(W(F, -1.6, 2.6, zback - sd * 0.065), W(F, 1.6, 2.6, zback - sd * 0.065), W(F, 1.6, 3.15, zback - sd * 0.065), W(F, -1.6, 3.15, zback - sd * 0.065), D(F, 0, 0, -sd));
        labels.push({ id: 'stage:sign', kind: 'stage', pos: r3(W(F, 0, 2.875, zback - sd * 0.07)), normal: r3(D(F, 0, 0, -sd)), right: r3(D(F, sd, 0, 0)), w: 3.2, h: 0.55, nits: 160, lines: ['걷고싶은거리 버스킹존', 'BUSKING ZONE · 홍대 걷고싶은거리'] });
        emit({ id: 'dress:stage:festoon', kind: 'neon', pos: W(F, 0, yE - 0.15, zin * 0.97), normal: D(F, 0, 0, -sd), w: len, h: 0.15, rgb: [1.0, 0.62, 0.32], nits: 600, omni: 0.8, range: 14 });
        emit({ id: 'dress:stage:panel', kind: 'lightbox', pos: W(F, -1.9, 2.1, zback - sd * 0.55), normal: D(F, 0.4, -0.3, -sd), w: 0.5, h: 0.3, rgb: [1.0, 0.92, 0.82], nits: 1500, range: 10 });
        emit({ id: 'dress:stage:sign', kind: 'lightbox', pos: W(F, 0, 2.87, zback - sd * 0.08), normal: D(F, 0, 0, -sd), w: 3.2, h: 0.55, rgb: [0.95, 0.35, 0.45], nits: 140 });
        occRect(F, -len / 2, len / 2, Math.min(zSpot, zback), Math.max(zSpot, zback));   // the audience area stays free for G's ring
        const y0 = 1.95, y1 = 2.88, yG = (y0 + y1) / 2, hG = y1 - y0, gz = -sd * Math.min(Math.abs(zAud), dep / 2 * 0.94 - 0.45 - 1.1);   // the gate's outer edge 0.45 m inside the posts
        const spot = W(F, 0, 0, zSpot), fwd = D(F, 0, 0, -sd);
        setPieces.push({ id: 'under-the-stage', kind: 'stage', name: 'UNDER THE STAGE', street: best.st.id, pos: r3(spot), yaw: +Math.atan2(fwd[0], fwd[2]).toFixed(4), roof: { low: yE, high: yB },
          busk: { pos: r3(spot), yaw: +Math.atan2(fwd[0], fwd[2]).toFixed(4), arc: 1.95, r: [2.6, 4.1] }, crowdRing: { c: r3(W(F, 0, 0, zAud)), r: 3.2 }, canopy: { c: r3([cx, 0, cz]), len, dep },
          gates: { pre: { c: r3(W(F, -len / 2 - 0.6, yG, gz)), n: r3(D(F, 1, 0, 0)), u: r3(D(F, 0, 0, 1)), w: 2.2, h: +hG.toFixed(2) }, gate: { c: r3(W(F, len / 2 + 0.6, yG, gz)), n: r3(D(F, 1, 0, 0)), u: r3(D(F, 0, 0, 1)), w: 2.2, h: +hG.toFixed(2) } },
          note: 'over the busking crowd (heads 1.8 m, phones up to 2 m) and under the 3.2 m canopy edge; G: performers at busk.pos facing busk.yaw (sin, cos), the ring centred on crowdRing' });
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
        cable(pts, d.r, 4);
        if (d.pair) { const p2 = pts.map((p) => [p[0], p[1] - 0.07, p[2]]); cable(p2, d.r * 0.8, 3); }
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
  // ---- trees: ginkgos on the main roads' pavements (Nov: half gold), tree pits with grates.
  // [P3-E art #4 / graphics #2] a real street ginkgo instead of polyhedra: a straight leader, pruned clear to ~3 m, ascending
  // limbs in a loose spiral (excurrent, columnar-conical, 8-12 m), leaf-card clusters (bando V1's CC0 tiles, two crossed
  // cards each, crown-mass normals, inner cards darker), November colour per tree (gold to yellow-green, the outer and
  // upper leaves first) and fallen leaves on the pavement. Leaves do not collide; the trunk and the limbs do.
  // Placement keeps phase 2's stream (R) so every tree stands where it stood; the shape has its own stream per tree.
  {
    const R = rng('trees' + seed);
    const GOLD = [1.04, 0.74, 0.07], YEL = [0.92, 0.82, 0.16], GRN = [0.36, 0.5, 0.1], BROWN = [0.55, 0.36, 0.08];
    const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    const card = (c, s, yaw, tilt, n, col, tile) => {   // two crossed cards, centre c, size s, crown normal n
      const u0 = (tile % 4) / 4, u1 = u0 + 0.25, vt = 1 - Math.floor(tile / 4) * 0.5, vb = vt - 0.5;
      const uv = [[u0, vb], [u1, vb], [u1, vt], [u0, vt]];
      set('dr_leafcard', { c: col, n });
      for (const k of [0, 1]) {
        const a = yaw + k * Math.PI / 2, dx = Math.cos(a) * s / 2, dz = Math.sin(a) * s / 2, ty = Math.sin(tilt * (k ? -1 : 1)) * s / 2, hy = Math.cos(tilt) * s / 2;
        const ox = -Math.sin(a) * ty, oz = Math.cos(a) * ty;
        quad([c[0] - dx - ox, c[1] - hy, c[2] - dz - oz], [c[0] + dx - ox, c[1] - hy, c[2] + dz - oz], [c[0] + dx + ox, c[1] + hy, c[2] + dz + oz], [c[0] - dx + ox, c[1] + hy, c[2] - dz + oz], [-Math.sin(a), 0, Math.cos(a)], uv);
      }
    };
    // [P4-E design #6] o.wide: crown radius x (a park zelkova, 느티나무), o.park: no grate, o.rust: November zelkova colour; returns the leaf clusters
    const ginkgo = (x, z, tx, tz, H, Rt, o = {}) => {
      const F = frameH([x, 0, z], tx, tz);
      if (!o.park) near(() => { set('dr_steel'); boxMM(F, -0.62, 0, -0.62, 0.62, 0.02, 0.62, ['ny']);       // cast grate ([P7-E] near only: 2-5 cm high)
        set('dr_steel'); for (const e of [-0.62, 0.62]) boxMM(F, e - 0.02, 0, -0.64, e + 0.02, 0.05, 0.64, ['ny']); });
      const turn = clamp(0.35 + Rt() * 0.75, 0, 1), bare = Rt() < 0.12, yB = 2.6 + Rt() * 0.7;   // crown base (pruned for buses)
      const lean = [(Rt() - 0.5) * 0.18, (Rt() - 0.5) * 0.18], ax = (y) => [x + lean[0] * y / H, y, z + lean[1] * y / H];
      const Rmax = ((bare ? 1.4 : 1.7) + Rt() * 0.8) * (o.wide || 1), Rof = (y) => { const t = clamp((y - yB) / (H - yB), 0, 1); return Rmax * Math.max(0.12, Math.sin(Math.min(1, t * 1.6 + 0.15) * Math.PI * 0.5) * (1 - t ** 1.6)); };
      // trunk (bark), straight leader to the top
      set('dr_bark');
      // [P7-E perf #1] past LOD_R the trunk is 4 sides x 2 (16 tris, the bark's albedo; 40 near)
      far(() => { for (let i = 0; i < 2; i++) { const y0 = H * 0.92 * i / 2, y1 = H * 0.92 * (i + 1) / 2, r0 = lerp(0.17, 0.035, i / 2), r1 = lerp(0.17, 0.035, (i + 1) / 2), p0 = ax(y0), p1 = ax(y1);
        for (let k = 0; k < 4; k++) { const a0 = k / 4 * TAU + 0.4, a1 = (k + 1) / 4 * TAU + 0.4, P = (p, r, a) => [p[0] + Math.cos(a) * r, p[1], p[2] + Math.sin(a) * r];
          quad(P(p0, r0, a0), P(p0, r0, a1), P(p1, r1, a1), P(p1, r1, a0), [Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)]); } } });
      near(() => { const n = 4; for (let i = 0; i < n; i++) { const y0 = H * 0.92 * i / n, y1 = H * 0.92 * (i + 1) / n, r0 = lerp(0.17, 0.035, i / n), r1 = lerp(0.17, 0.035, (i + 1) / n), p0 = ax(y0), p1 = ax(y1);
        for (let k = 0; k < 5; k++) { const a0 = k / 5 * TAU, a1 = (k + 1) / 5 * TAU, P = (p, r, a) => [p[0] + Math.cos(a) * r, p[1], p[2] + Math.sin(a) * r];
          quad(P(p0, r0, a0), P(p0, r0, a1), P(p1, r1, a1), P(p1, r1, a0), [Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)], [[k / 5, y0 / 1.2], [(k + 1) / 5, y0 / 1.2], [(k + 1) / 5, y1 / 1.2], [k / 5, y1 / 1.2]]); } } });
      // limbs: a loose spiral of ascending branches, shorter toward the top; leaf clusters along each
      const nB = bare ? 9 : 11 + Math.floor(Rt() * 4), clusters = [];
      let az = Rt() * TAU;
      for (let i = 0; i < nB; i++) {
        const t = (i + Rt() * 0.6) / nB, y = lerp(yB, H - 1.0, t), base = ax(y), L = Rof(y + 0.6) * (0.85 + Rt() * 0.3) + 0.3, up = lerp(0.85, 1.25, t) + (Rt() - 0.5) * 0.25;   // up: elevation (rad)
        az += 2.4 + (Rt() - 0.5) * 0.5;
        const dir = [Math.cos(az) * Math.cos(up), Math.sin(up), Math.sin(az) * Math.cos(up)], tip = [base[0] + dir[0] * L, base[1] + dir[1] * L, base[2] + dir[2] * L];
        const mid = [base[0] + dir[0] * L * 0.5 + Math.cos(az) * 0.08, base[1] + dir[1] * L * 0.5 - 0.05, base[2] + dir[2] * L * 0.5 + Math.sin(az) * 0.08];
        const r = lerp(0.055, 0.025, t);
        set('dr_bark', { col: r > 0.03 }); if (bare) tube([base, mid, tip], r, 3); else near(() => tube([base, mid, tip], r, 3));   // [P7-E] in leaf, the limbs sit in the crown: near only
        if (!bare) { const nc = 1 + Math.round(L * 1.1); for (let j = 0; j < nc; j++) { const f = 0.35 + 0.65 * (j + Rt() * 0.5) / nc; clusters.push([base[0] + dir[0] * L * f + (Rt() - 0.5) * 0.5, base[1] + dir[1] * L * f + (Rt() - 0.3) * 0.5, base[2] + dir[2] * L * f + (Rt() - 0.5) * 0.5]); } }
        else if (Rt() < 0.5) clusters.push(tip);
      }
      // the leader's own clusters, up to the spire, and a fill of the crown envelope (no hollow cone)
      const nFill = bare ? 4 : 18 + Math.floor(Rt() * 8);
      for (let i = 0; i < nFill; i++) { const y = lerp(yB + 0.4, H - 0.2, Math.sqrt(Rt())), rr = Rof(y) * Math.sqrt(Rt()) * 0.9, a = Rt() * TAU, p = ax(y); clusters.push([p[0] + Math.cos(a) * rr, y, p[2] + Math.sin(a) * rr]); }
      let nCard = 0;
      for (const c of clusters) {
        const p = ax(c[1]), dx = c[0] - p[0], dz = c[2] - p[2], rr = Math.hypot(dx, dz), R1 = Math.max(0.3, Rof(c[1])), out = clamp(rr / R1, 0, 1.2);
        const hT = clamp((c[1] - yB) / (H - yB), 0, 1), n = v3.norm([dx / R1, 0.45 + 0.4 * hT, dz / R1]);
        const ao = 0.5 + 0.5 * Math.min(1, out) * (0.8 + 0.2 * hT);                       // inner cards sit in the crown's shade
        const g = clamp(turn + (out - 0.6) * 0.35 + (hT - 0.5) * 0.25 + (Rt() - 0.5) * 0.35, 0, 1);
        let col = (bare ? mixc(GOLD, BROWN, Rt() * 0.6) : g < 0.35 ? mixc(GRN, YEL, g / 0.35) : mixc(YEL, GOLD, (g - 0.35) / 0.65)).map((v) => v * ao * (0.85 + Rt() * 0.3));
        if (o.rust) col = mixc(col, [0.5 * ao, 0.22 * ao, 0.06 * ao], 0.7 + 0.25 * g);   // November zelkova: rust to brown (pop1: pale cream under the floods)
        const cs = (bare ? 0.75 : 1.05) + Rt() * 0.5, cy = Rt() * Math.PI, ct = (Rt() - 0.5) * 0.8, tile = Math.floor(Rt() * 8);
        // [P7-E perf #1] the crown: every card near; past LOD_R every other card at 1.45x (the same crown envelope and colours)
        near(() => card(c, cs, cy, ct, n, col, tile)); if (!(nCard++ & 1)) far(() => card(c, cs * 1.45, cy, ct, n, col, tile));
      }
      // fallen leaves: flat cards on the pavement round the pit (more under a bare tree), off the carriageway
      const nF = bare ? 12 : Math.round(3 + turn * 6);
      for (let i = 0; i < nF; i++) {
        const a = Rt() * TAU, d = 0.5 + Rt() * (bare ? 2.6 : 1.9), fx = x + Math.cos(a) * d, fz = z + Math.sin(a) * d;
        if (M.ribbonD(fx, fz, true) < 0.2 || M.lotAt(fx, fz)) continue;
        const s2 = 0.45 + Rt() * 0.4, yw = Rt() * TAU, cx = Math.cos(yw) * s2 / 2, cz = Math.sin(yw) * s2 / 2, y = 0.004 + i * 0.0004, tile = Math.floor(Rt() * 8);
        const u0 = (tile % 4) / 4, vt = 1 - Math.floor(tile / 4) * 0.5;
        set('dr_leafcard', { c: mixc(GOLD, BROWN, Rt() * 0.5).map((v) => v * 0.8), n: [0, 1, 0] });
        near(() => quad([fx - cx + cz, y, fz - cz - cx], [fx + cx + cz, y, fz + cz - cx], [fx + cx - cz, y, fz + cz + cx], [fx - cx - cz, y, fz - cz + cx], [0, 1, 0], [[u0, vt - 0.5], [u0 + 0.25, vt - 0.5], [u0 + 0.25, vt], [u0, vt]]));
      }
      return clusters;
    };
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
          const H = 7.5 + R() * 3.5; R(); const bare2 = R() < 0.15; for (let k = 0; k < (bare2 ? 4 : 7) * 16; k++) R();   // phase 2's draws (H, lean, bare, 4 + 12 per blob): placement stays put
          const Rt = rng('ginkgo' + seed + ':' + x.toFixed(2) + ':' + z.toFixed(2));
          item(() => { ginkgo(x, z, q.tx, q.tz, H + 1.2, Rt); occAdd(x, z, 1.1); facts.trees++; }, { margin: 0.4 });
        }
      }
    }
    // ---- [P4-E design #6] Hongdae Playground (홍대 놀이터): zelkovas round the square and two light masts (10.5 m, twin LED
    // floods aimed at the busking ring), so PLAYGROUND POP hangs between a mast and a crown instead of 7 m up in open air.
    // anchors['playground-pop']: the slot between mast M1 and tree T1's crown at 7 m (lines.mjs makes the gate from it).
    const pg = (layout.hero || []).find((h) => h.id === 'playground')?.pos;
    if (pg) {
      const Rp = rng('playground' + seed), cx = pg[0], cz = pg[2];
      const okAt = (x, z, r) => !M.lotAt(x, z) && M.lotClear(x, z, r) && M.ribbonD(x, z) > r && occFree(x, z, r * 0.6);
      const mast = (x, z, aim) => item(() => {
        const F = frameH([x, 0, z], aim[0], aim[1]), Hm = 10.5;
        set('concrete'); boxMM(F, -0.35, 0, -0.35, 0.35, 0.35, 0.35, ['ny']);
        set('dr_galv'); cyl(F, [0, 0.35 + (Hm - 0.35) / 2, 0], 'y', 0.14, Hm - 0.35, 10, 0.08);
        set('dr_galv'); boxMM(F, -0.06, Hm - 0.12, -0.75, 0.06, Hm, 0.75);                                   // the cross-arm
        for (const zz of [-0.55, 0.55]) {                                                                  // twin floods, 30 deg down toward the ring
          set('dr_steel'); boxMM(F, 0.05, Hm - 0.48, zz - 0.26, 0.42, Hm - 0.14, zz + 0.26);
          set('dr_glow', { em: NI([1.0, 0.9, 0.78], 17000), col: false }); quad(W(F, 0.43, Hm - 0.44, zz - 0.22), W(F, 0.43, Hm - 0.44, zz + 0.22), W(F, 0.43, Hm - 0.18, zz + 0.22), W(F, 0.43, Hm - 0.18, zz - 0.22), D(F, 0.87, -0.5, 0));
        }
        emit({ id: 'dress:pgmast:' + x.toFixed(1), kind: 'street', pos: W(F, 0.45, Hm - 0.31, 0), normal: D(F, 0.5, -0.87, 0), w: 0.44, h: 0.52, rgb: [1.0, 0.9, 0.78], nits: 17000, lumens: 12000, cct: 4000 });
        occAdd(x, z, 0.5); facts.pgMasts = (facts.pgMasts || 0) + 1;
      }, { noGate: true });
      const zelkova = (x, z, H) => { let cl = null; const Rt = rng('zelkova' + seed + ':' + x.toFixed(2) + ':' + z.toFixed(2));
        const ok = item(() => { cl = ginkgo(x, z, 1, 0, H, Rt, { wide: 2.5, park: true, rust: true }); occAdd(x, z, 0.6); facts.trees++; facts.pgTrees = (facts.pgTrees || 0) + 1; }, { noGate: true });
        return ok ? cl : null; };
      // the pair over the busking ring: mast M1 west of the busker, tree T1 east, ~9 m apart
      const M1 = [cx - 2.6, cz + 1.8], T1 = [cx + 4.6, cz - 1.8];
      let pair = null;
      if (okAt(...M1, 0.6) && okAt(...T1, 1.0)) {
        mast(M1[0], M1[1], [T1[0] - M1[0], T1[1] - M1[1]]);
        const cl = zelkova(T1[0], T1[1], 11.2);
        if (cl) { const L = Math.hypot(T1[0] - M1[0], T1[1] - M1[1]), ux = (T1[0] - M1[0]) / L, uz = (T1[1] - M1[1]) / L;
          // the crown's widest band toward the mast between 6 and 8.5 m (leaf clusters + half a card), the gate at that height
          const edgeAt = (y) => { let e = 0; for (const c of cl) if (Math.abs(c[1] - y) < 0.9) e = Math.max(e, -((c[0] - T1[0]) * ux + (c[2] - T1[1]) * uz) + 0.6); return e; };
          let gy = 7, e = edgeAt(7); for (let y = 6; y <= 8.5; y += 0.5) { const ey = edgeAt(y); if (ey > e + 0.05) { e = ey; gy = y; } }
          const gap = L - 0.2 - e;
          if (gap > 3.2) { const w = Math.min(4.2, gap - 1.3), c0 = 0.2 + (gap - w) / 2 + w / 2;
            pair = { mast: r3([M1[0], 10.5, M1[1]]), tree: r3([T1[0], 11.2, T1[1]]), crownEdge: +e.toFixed(2), gap: +gap.toFixed(2),
              gate: { c: r3([M1[0] + ux * c0, gy, M1[1] + uz * c0]), n: [0, 1, 0], u: r3([ux, 0, uz]), w: +w.toFixed(2), h: 3.0 } }; } }
      }
      // round the square: zelkovas on the edges, the second mast to the north-east
      for (const [dx, dz, H] of [[-13, 9, 10.4], [-12, -8, 9.6], [15, 10, 10.8], [2, 15, 9.8], [-3, -14, 10.2], [16, -8, 9.4]]) { const x = cx + dx + (Rp() - 0.5) * 2, z = cz + dz + (Rp() - 0.5) * 2; if (okAt(x, z, 1.0)) zelkova(x, z, H); }
      { const x = cx + 9, z = cz + 7; if (okAt(x, z, 0.6)) mast(x, z, [cx - x, cz - z]); }
      if (pair) anchors['playground-pop'] = pair;
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
        // [P5-E art #6 / color #6] the canopy is lit by its bulbs, not by itself (phase 4: 75 nits on every face, the "blank cream
        // kiosk" of w21 at (111,100,91), brighter than the shops). Underside: the tarp's reflectance x the bulbs' cos / d^2 (a
        // hot spot over each bulb, a few nits at the eaves); top and outer faces: what a thin tarp transmits (3-5 nits).
        const bulbs = [-0.45, 0.1, 0.55].map((xx) => W(F, xx, 1.915, 0.15)), tl = 0.2126 * tarp[0] + 0.7152 * tarp[1] + 0.0722 * tarp[2], tN = tarp.map((v) => v / Math.max(0.05, tl));
        const lit = (p, n, k = 4.2, cap = 70) => { let s = 0; for (const b of bulbs) { const v = v3.sub(b, p), d2 = v3.dot(v, v), cs = Math.max(0, v3.dot(v, n) / Math.sqrt(d2)); s += cs / (d2 + 0.06); } return NI(tN, Math.min(cap, 0.6 + k * s)); };
        set('dr_tarp', { c: tarp.map((v) => v * 0.6), em: NI(tN, 3) });
        boxMM(F, -0.95, 2.05, -0.6, 0.95, 2.12, 0.62, ['ny']);                  // the canopy (top and edges)
        { const nD = D(F, 0, -1, 0), nu = 8, nv = 5;
          for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const xa = -0.95 + 1.9 * i / nu, xb = -0.95 + 1.9 * (i + 1) / nu, za = -0.6 + 1.22 * j / nv, zb = -0.6 + 1.22 * (j + 1) / nv;
            const q = [W(F, xa, 2.05, za), W(F, xb, 2.05, za), W(F, xb, 2.05, zb), W(F, xa, 2.05, zb)]; quad(q[0], q[1], q[2], q[3], nD, uvDef, q.map((p) => lit(p, nD))); } }
        set('dr_tarp', { c: tarp.map((v) => v * 0.6), em: NI(tN, 5) }); boxMM(F, -0.95, 1.85, 0.6, 0.95, 2.05, 0.62, ['nz', 'py']);   // valance over the counter
        { const nI = D(F, 0, 0, -1), q = [W(F, 0.95, 1.85, 0.599), W(F, -0.95, 1.85, 0.599), W(F, -0.95, 2.05, 0.599), W(F, 0.95, 2.05, 0.599)]; quad(q[0], q[1], q[2], q[3], nI, uvDef, q.map((p) => lit(p, nI, 2.5, 40))); }
        set('dr_glow', { em: NI(srgb(0xffb46b), 1500), col: false }); for (const b of bulbs) boxMM(FW, b[0] - 0.03, b[1] - 0.035, b[2] - 0.03, b[0] + 0.03, b[1] + 0.035, b[2] + 0.03);
        set('dr_glow', { em: NI([1.0, 0.78, 0.45], 45), col: false }); boxMM(F, -0.7, 0.55, 0.451, 0.7, 0.85, 0.455);   // the menu light box (its print: the label)
        // stock under the bulbs (baked: albedo x ~60 nits of bulb light, the tent table's level): a pan of 떡볶이, an 어묵 trough
        // with skewers, a tray of 튀김, cups, squeeze bottles; the glass sneeze guard at the front edge
        { const st = (c, k = 60) => set('dr_glow', { em: NI(c, k), col: false });
          set('dr_galv', { col: false }); cyl(F, [-0.38, 0.98, -0.05], 'y', 0.3, 0.06, 10); st([0.5, 0.07, 0.03]); cyl(F, [-0.38, 1.006, -0.05], 'y', 0.28, 0.012, 10);
          for (let k = 0; k < 7; k++) { st([0.62, 0.42, 0.25], 55); boxMM(F, -0.55 + (k % 4) * 0.1, 1.012, -0.18 + Math.floor(k / 4) * 0.12, -0.5 + (k % 4) * 0.1, 1.04, -0.1 + Math.floor(k / 4) * 0.12); }
          set('dr_galv', { col: false }); boxMM(F, 0.08, 0.95, -0.3, 0.68, 1.06, 0.05, ['ny']); st([0.55, 0.45, 0.3], 50); boxMM(F, 0.1, 1.06, -0.28, 0.66, 1.062, 0.03, ['ny']);
          for (let k = 0; k < 9; k++) { st([0.6, 0.48, 0.32], 70); const sx = 0.13 + k * 0.06, sz = -0.22 + (k % 3) * 0.1; boxMM(F, sx - 0.004, 1.06, sz - 0.004, sx + 0.004, 1.32, sz + 0.004, ['ny']); boxMM(F, sx - 0.022, 1.08, sz - 0.01, sx + 0.022, 1.2, sz + 0.01, ['ny']); }
          set('dr_steel', { col: false }); boxMM(F, 0.15, 0.95, 0.12, 0.6, 0.97, 0.4, ['ny']); for (let k = 0; k < 6; k++) { st([0.78, 0.5, 0.16], 60); boxMM(F, 0.18 + (k % 3) * 0.14, 0.97, 0.15 + Math.floor(k / 3) * 0.12, 0.29 + (k % 3) * 0.14, 1.02, 0.24 + Math.floor(k / 3) * 0.12, ['ny']); }
          st([0.85, 0.83, 0.78], 70); cyl(F, [0.74, 1.05, -0.3], 'y', 0.045, 0.2, 6); st([0.7, 0.05, 0.03], 60); cyl(F, [0.74, 1.04, -0.15], 'y', 0.03, 0.18, 6); st([0.8, 0.62, 0.05], 60); cyl(F, [0.74, 1.04, -0.06], 'y', 0.03, 0.18, 6);
          set('dr_glass'); quad(W(F, -0.78, 0.95, 0.43), W(F, 0.78, 0.95, 0.43), W(F, 0.78, 1.28, 0.43), W(F, -0.78, 1.28, 0.43), D(F, 0, 0, 1)); }
        labels.push({ id: 'cart:' + id, kind: 'tent', pos: r3(W(F, 0, 1.95, 0.625)), normal: r3(D(F, 0, 0, 1)), w: 1.8, h: 0.19, nits: 45, lines: [menus[id % menus.length]] });
        { const M2 = CART_MENU[id % CART_MENU.length]; labels.push({ id: 'cartmenu:' + id, kind: 'menu', pos: r3(W(F, 0, 0.7, 0.457)), normal: r3(D(F, 0, 0, 1)), w: 1.4, h: 0.3, nits: 110, lines: M2.items, colors: M2.cols, px: 220 }); }
        emit({ id: 'dress:cart:' + id, kind: 'tent', pos: W(F, 0, 1.6, 0.4), normal: D(F, 0, 0, 1), w: 1.6, h: 1.1, rgb: [1.0, 0.62, 0.3], nits: 110 });
      }, { margin: 0.35 })) { occAdd(x, z, 1.2); n++; facts.carts = n; }
    }
  }
  // tent: frame F (x along the kerb, +z away from it, toward the customers).
  // [P3-E art #4 / graphics #2] a pocha that reads as a pocha, not a cream box: a #ff7a1a-family tarp glowing from one bare
  // bulb inside (per-vertex: 90-110 nits luminance round the bulb, 40-60 on the walls, darker toward the ground), sewn
  // panels (dark seams where the steel frame shows through), the roof sagging between the rafters, a clear vinyl front with
  // its roll at the top, the lit inside seen through it (a steel table, green bottles, stools), stools and crates outside.
  // [P4-E art #6] phase 3's tarp glowed as a flat box (tent8). Now the bulb makes a hot spot: emission = fill + I cos(theta) / d^2
  // from the bulb, per vertex on a 6-8 x 5-6 grid (the roof over the bulb ~100 nits, the walls ~22, the low corners ~5), seams
  // where the frame shows through at a quarter of the tarp around them (2 stops) and 6 cm wide, a fogged vinyl front that
  // scatters the inside light (foggy below, clearer at the top, overlapping strips), and the inside lit by the bulb (table top,
  // bottles, stools), so the vinyl shows the tables.
  function tent(F, xo, w, d, R, idx) {
    const eave = 2.1, ridge = 2.62, hz = d / 2, hx = w / 2 - 0.05;
    const tarp = [srgb(0xff7a1a), srgb(0xf0641a), srgb(0xe8541c), srgb(0xff8a24)][idx % 4];
    const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], Nb = 22 / lumOf(tarp);   // 22 nits where k = 1 (60 clipped flat: tent0 at EV -2.25)
    const bulb = W(F, xo, 1.95, -0.1);
    const kAt = (p, n) => { const v = [p[0] - bulb[0], p[1] - bulb[1], p[2] - bulb[2]], d2 = v3.dot(v, v), cs = n ? Math.max(0.15, v3.dot(v, n) / Math.sqrt(d2)) : 0.7;
      return 0.15 + 1.4 * cs / (d2 + 0.12); };
    const emAt = (p, n) => NI(tarp, Nb * kAt(p, n));
    // a bilinear patch, nu x nv cells, per-vertex glow, optional sag (m) toward -nrm
    const patch = (P, nu, nv, nrm, sag = 0, kE = 1, col = tarp.map((v) => v * 0.55)) => {
      const at = (u, v) => { const q = [0, 1, 2].map((i) => lerp(lerp(P[0][i], P[1][i], u), lerp(P[3][i], P[2][i], u), v)); if (sag) { const sg = sag * Math.sin(Math.PI * u) * Math.sin(Math.PI * v); q[0] -= nrm[0] * sg; q[1] -= nrm[1] * sg; q[2] -= nrm[2] * sg; } return q; };
      set('dr_tarp', { c: col });
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const q = [at(i / nu, j / nv), at((i + 1) / nu, j / nv), at((i + 1) / nu, (j + 1) / nv), at(i / nu, (j + 1) / nv)];
        quad(q[0], q[1], q[2], q[3], nrm, uvDef, q.map((v) => emAt(v, nrm).map((e) => e * kE)));
      }
    };
    // a seam: the frame behind the tarp, 6 cm wide, 2 stops under the tarp around it (per end)
    const seam = (a, b, out) => { set('dr_tarp', { c: tarp.map((v) => v * 0.2) }); const t = v3.norm(v3.sub(b, a)), sd = v3.mul(v3.norm(v3.cross(t, out)), 0.03), o = v3.mul(out, 0.008);
      const ea = emAt(a, out).map((e) => e * 0.25), eb = emAt(b, out).map((e) => e * 0.25), m = v3.mul(v3.add(a, b), 0.5), em = emAt(m, out).map((e) => e * 0.25);
      quad(v3.add(v3.add(a, sd), o), v3.add(v3.sub(a, sd), o), v3.add(v3.sub(m, sd), o), v3.add(v3.add(m, sd), o), out, uvDef, [ea, ea, em, em]);
      quad(v3.add(v3.add(m, sd), o), v3.add(v3.sub(m, sd), o), v3.add(v3.sub(b, sd), o), v3.add(v3.add(b, sd), o), out, uvDef, [em, em, eb, eb]); };
    const L = (x, y, z) => W(F, xo + x, y, z), N = (x, y, z) => D(F, x, y, z);
    // walls: the back (kerb side) and both ends, tarp; seams where the posts and a mid rail stand
    patch([L(-hx, 0.02, -hz), L(hx, 0.02, -hz), L(hx, eave, -hz), L(-hx, eave, -hz)], 8, 6, N(0, 0, -1));
    for (const sx of [-1, 1]) patch([L(sx * hx, 0.02, hz), L(sx * hx, 0.02, -hz), L(sx * hx, eave, -hz), L(sx * hx, eave, hz)].map((p, i, A) => (sx > 0 ? p : A[[1, 0, 3, 2][i]])), 6, 6, N(sx, 0, 0));
    for (const sx of [-1, 0, 1]) seam(L(sx * hx * 0.999, 0.02, -hz - 0.002), L(sx * hx * 0.999, eave, -hz - 0.002), N(0, 0, -1));
    seam(L(-hx, 1.05, -hz - 0.002), L(hx, 1.05, -hz - 0.002), N(0, 0, -1));
    for (const sx of [-1, 1]) { seam(L(sx * (hx + 0.002), 0.02, 0), L(sx * (hx + 0.002), eave + 0.25, 0), N(sx, 0, 0)); seam(L(sx * (hx + 0.002), 1.05, -hz), L(sx * (hx + 0.002), 1.05, hz), N(sx, 0, 0)); }
    // gables (tarp triangles over the ends) and the roof: two pitches sagging between three rafters
    for (const sx of [-1, 1]) { set('dr_tarp', { c: tarp.map((v) => v * 0.55) }); const p0 = L(sx * (hx + 0.06), eave, -hz - 0.08), p1 = L(sx * (hx + 0.06), eave, hz + 0.08), p2 = L(sx * (hx + 0.06), ridge, 0), nG = N(sx, 0, 0);
      tri(p0, p1, p2, [0, 0], [1, 0], [0.5, 1], [emAt(p0, nG), emAt(p1, nG), emAt(p2, nG)]); tri(p0, p2, p1, [0, 0], [0.5, 1], [1, 0], [emAt(p0, nG), emAt(p2, nG), emAt(p1, nG)]); }
    for (const sz of [-1, 1]) {
      const e0 = L(-hx - 0.08, eave, sz * (hz + 0.1)), e1 = L(hx + 0.08, eave, sz * (hz + 0.1)), r1 = L(hx + 0.08, ridge, 0), r0 = L(-hx - 0.08, ridge, 0);
      const up = v3.norm(v3.cross(v3.sub(e1, e0), v3.sub(r0, e0))), nU = up[1] > 0 ? up : v3.mul(up, -1);
      for (const half of [0, 1]) { const u0 = half * 0.5, u1 = u0 + 0.5, P = (u, v) => [0, 1, 2].map((i) => lerp(lerp(e0[i], e1[i], u), lerp(r0[i], r1[i], u), v));
        patch([P(u0, 0), P(u1, 0), P(u1, 1), P(u0, 1)], 6, 5, nU, 0.07, 1.0, tarp.map((v) => v * 0.62)); }
      for (const u of [0, 0.5, 1]) seam(v3.add([0, 1, 2].map((i) => lerp(e0[i], e1[i], u)), v3.mul(nU, 0.004)), v3.add([0, 1, 2].map((i) => lerp(r0[i], r1[i], u)), v3.mul(nU, 0.004)), nU);
    }
    // the front: a tarp valance (the lettering band), the fogged vinyl (condensation below, clearer at the top; overlapping strips
    // every ~0.75 m scatter more), its roll; the inside lit behind it
    patch([L(-hx, eave - 0.27, hz), L(hx, eave - 0.27, hz), L(hx, eave, hz), L(-hx, eave, hz)], 6, 1, N(0, 0, 1), 0, 1.05);
    { const y0 = 0.3, y1 = eave - 0.36, nV = N(0, 0, 1), nu = 8, nv = 4, strip = 0.75;
      const vin = (x, y) => { const fog = 1 - smoothstep01((y - y0) / (y1 - y0), 0.45, 0.95), fr = ((x + hx) / strip) % 1, edge = fr < 0.08 || fr > 0.92 ? 1.6 : 1;
        const kb = kAt(L(x, y, hz - 0.01), v3.mul(nV, -1)); return NI([1.0, 0.72, 0.45], (10 + 34 * fog) * edge * Math.min(1.6, 0.35 + 0.55 * kb)); };
      set('dr_vinyl', { c: [0.6, 0.58, 0.55] });
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const xa = -hx + 2 * hx * i / nu, xb = -hx + 2 * hx * (i + 1) / nu, ya = y0 + (y1 - y0) * j / nv, yb = y0 + (y1 - y0) * (j + 1) / nv;
        quad(L(xa, ya, hz - 0.01), L(xb, ya, hz - 0.01), L(xb, yb, hz - 0.01), L(xa, yb, hz - 0.01), nV, uvDef, [vin(xa, ya), vin(xb, ya), vin(xb, yb), vin(xa, yb)]);
      } }
    set('dr_prop', { c: [0.5, 0.48, 0.44], col: false }); cyl(F, [xo, eave - 0.32, hz - 0.03], 'x', 0.045, 2 * hx - 0.1, 8);
    set('dr_steel'); for (const sx of [-1, 1]) for (const sz of [-1, 1]) boxMM(F, xo + sx * hx - 0.025, 0, sz * hz - 0.025, xo + sx * hx + 0.025, eave, sz * hz + 0.025, ['ny']);   // the frame's corner posts
    // inside, lit by the bulb 1.2 m over the table (~150 lux): a round steel table, green soju bottles, stools; the bare bulb
    set('dr_glow', { em: NI([1.0, 0.8, 0.6], 22), col: true }); cyl(F, [xo - 0.2, 0.7, 0.1], 'y', 0.42, 0.04, 12);
    set('dr_galv'); cyl(F, [xo - 0.2, 0.35, 0.1], 'y', 0.04, 0.66, 6, 0.04, false);
    set('dr_glow', { em: NI(srgb(0x2fbf55), 18), col: false }); for (let k = 0; k < 3; k++) cyl(F, [xo - 0.35 + k * 0.13, 0.82, 0.05 + (k % 2) * 0.12], 'y', 0.032, 0.2, 6);
    for (const [sx, sc] of [[-0.75, 0x2f6fd6], [0.35, 0xd23a2a], [-0.2, 0x2f6fd6]]) { set('dr_glow', { em: NI(srgb(sc), 9), col: true }); boxMM(F, xo + sx - 0.15, 0, (sx > 0 ? -0.55 : 0.6) - 0.15, xo + sx + 0.15, 0.43, (sx > 0 ? -0.55 : 0.6) + 0.15); }
    set('dark'); boxMM(F, xo - 0.006, 1.98, -0.106, xo + 0.006, ridge - 0.02, -0.094);
    set('dr_glow', { em: NI(srgb(0xffc27a), 1500), col: false }); blob(bulb, 0.045, 0.055, 0.045, R, 0, 0.05);
    // tarp lettering band on the front (runtime label)
    labels.push({ id: 'tent:' + idx + ':' + xo, kind: 'tent', pos: r3(W(F, xo, eave - 0.135, hz + 0.004)), normal: r3(D(F, 0, 0, 1)), right: r3(D(F, 1, 0, 0)), w: 2 * hx - 0.2, h: 0.23, nits: 60,
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
    const cols = [srgb(0x1d4d2b), srgb(0x7a1a1a), srgb(0x1b2a4a), srgb(0x3a3a3a), srgb(0xb06a1a), srgb(0x5a2a4a), srgb(0xb4ad9c)];   // [P5-E] the solid cream 0.69 -> 0.45
    for (const f of fronts) {
      if (f.info?.shutter || R() > 0.4 || f.L < 3 || !inCore(f.mx, f.mz)) continue;
      const depth = clamp(Math.min(1.3, (isFinite(f.free) ? f.free : 6) * 0.3), 0.7, 1.3), w = Math.min(f.L - 1.0, 3 + R() * 4);
      const s0 = 0.5 + R() * Math.max(0, f.L - 1 - w);
      const F = frameH([f.fa[0] + f.tx * (s0 + w / 2), 0, f.fa[1] + f.tz * (s0 + w / 2)], f.tx, f.tz);
      const zs = v3.dot(D(F, 0, 0, 1), [f.nx, 0, f.nz]) > 0 ? 1 : -1;
      const yTop = Math.min(shopTop - 0.08, fasciaY - 0.12), yLow = yTop - 0.35 - depth * 0.15, c = cols[Math.floor(R() * cols.length)];
      // [P3-E graphics #2] striped or solid fabric, a scalloped valance with the shop's name printed on it (not lit: ~6 nits
      // of reflected shop light), the roller box and the folding arms. Its own stream per awning (placement stays put).
      // [P5-E art #6 / color #6] cream at a fabric's 0.5 (was 0.81: under the lightmap's smear of the fascia above it read
      // (143,82,42) over the whole canopy, "a lightbox"); the top face carries the fascia's shade (0.35 at the wall to 0.7 at
      // the front bar), the underside keeps its albedo: lit from below by the shop glass, not from itself.
      const Ra = rng('awn2' + f.l.id), striped = Ra() < 0.55, c2 = Ra() < 0.7 ? srgb(0xc4bca8) : c.map((v) => v * 0.45);
      const light = (cc) => 0.2126 * cc[0] + 0.7152 * cc[1] + 0.0722 * cc[2] > 0.3;
      const USE_KO = { restaurant: ['식당', '분식', '김밥', '국밥', '치킨'], cafe: ['카페', '커피', '디저트'], bar: ['호프', '포차', '이자카야'], pocha: ['포장마차', '실내포차'], conv: ['편의점'], shop: ['옷가게', '잡화', '안경'], karaoke: ['노래방', '코인노래방'], club: ['라운지'] };
      const pool = USE_KO[f.l.use] || ['상회', '마트'], name = /[가-힣]/.test(f.l.osmName || '') && (f.l.osmName || '').length <= 9 ? f.l.osmName : pool[Math.floor(Ra() * pool.length)];
      item(() => near(() => {
        const a = W(F, -w / 2, yTop, zs * 0.03), b = W(F, w / 2, yTop, zs * 0.03), cc = W(F, w / 2, yLow, zs * depth), d = W(F, -w / 2, yLow, zs * depth);
        const n = v3.norm(v3.cross(v3.sub(b, a), v3.sub(d, a))), up = n[1] > 0 ? n : v3.mul(n, -1);
        const nS = striped ? Math.max(4, Math.round(w / 0.32)) : 1;
        for (let i = 0; i < nS; i++) {
          const t0 = i / nS, t1 = (i + 1) / nS, P = (t, v) => { const p = v3.add(a, v3.mul(v3.sub(b, a), t)), q = v3.add(d, v3.mul(v3.sub(cc, d), t)); return v3.add(p, v3.mul(v3.sub(q, p), v)); };
          const cs = striped && i % 2 ? c2 : c;
          for (let j = 0; j < 3; j++) { const v0 = j / 3, v1 = (j + 1) / 3, occ = 0.35 + 0.35 * (j + 0.5) / 3;
            set('dr_prop', { c: cs.map((x) => x * occ) }); quad(P(t0, v0), P(t1, v0), P(t1, v1), P(t0, v1), up); }
          set('dr_prop', { c: cs.map((x) => x * 0.9) }); quad(P(t0, 0), P(t0, 1), P(t1, 1), P(t1, 0), v3.mul(up, -1));
        }
        // valance (both faces) with scallops below it
        const zv = zs * depth, yv0 = yLow - 0.17, nV = Math.max(4, Math.round(w / 0.3)), sw = w / nV, out = D(F, 0, 0, zs);
        for (let i = 0; i < nV; i++) {
          const x0 = -w / 2 + i * sw, x1 = x0 + sw, cv = c;
          set('dr_prop', { c: cv }); quad(W(F, x0, yv0, zv), W(F, x1, yv0, zv), W(F, x1, yLow, zv), W(F, x0, yLow, zv), out); quad(W(F, x0, yv0, zv), W(F, x0, yLow, zv), W(F, x1, yLow, zv), W(F, x1, yv0, zv), v3.mul(out, -1));
          const m = (x0 + x1) / 2, pts = [0, 1, 2, 3, 4].map((k) => { const th = Math.PI * k / 4; return W(F, m - Math.cos(th) * sw / 2, yv0 - Math.sin(th) * 0.075, zv); });
          for (let k = 0; k < 4; k++) { tri(W(F, m, yv0, zv), pts[k], pts[k + 1]); tri(W(F, m, yv0, zv), pts[k + 1], pts[k]); }
        }
        set('dr_prop', { c: c.map((v) => v * 0.6) }); boxMM(F, -w / 2 - 0.02, yv0 - 0.005, zv - 0.012, w / 2 + 0.02, yLow + 0.01, zv + 0.012, ['py', 'ny', 'pz', 'nz']);   // hemmed ends
        set('dr_galv'); boxMM(F, -w / 2, yTop - 0.06, zs * 0.03 - 0.07, w / 2, yTop + 0.08, zs * 0.03 + 0.07);
        boxMM(F, -w / 2 + 0.05, yLow - 0.03, zv - zs * 0.03 - 0.02, w / 2 - 0.05, yLow + 0.01, zv - zs * 0.03 + 0.02);   // the front bar
        for (const sx of [-1, 1]) { const el = W(F, sx * (w / 2 - 0.35), yLow + 0.12, zs * depth * 0.5); tube([W(F, sx * (w / 2 - 0.05), yTop - 0.7, zs * 0.04), el, W(F, sx * (w / 2 - 0.08), yLow - 0.02, zs * (depth - 0.05))], 0.018, 4); }
        labels.push({ id: 'awn:' + f.l.id, kind: 'awning', pos: r3(W(F, 0, (yv0 + yLow) / 2, zv + zs * 0.004)), normal: r3(out), w: Math.min(w - 0.3, 0.16 * 1.1 * [...name].length + 0.4), h: 0.15, nits: 6, ink: light(c) ? '#2a2420' : '#f4efe4', lines: [name] });
        facts.awnings++;
        // [P7-E perf #1] past LOD_R: the stripes as one quad a face, a flat valance, the roller box (~4 tris a stripe + 14; ~300 near)
        far(() => {
          for (let i = 0; i < nS; i++) { const t0 = i / nS, t1 = (i + 1) / nS, P = (t, v) => { const p = v3.add(a, v3.mul(v3.sub(b, a), t)), q = v3.add(d, v3.mul(v3.sub(cc, d), t)); return v3.add(p, v3.mul(v3.sub(q, p), v)); }, cs = striped && i % 2 ? c2 : c;
            set('dr_prop', { c: cs.map((x) => x * 0.53) }); quad(P(t0, 0), P(t1, 0), P(t1, 1), P(t0, 1), up); set('dr_prop', { c: cs.map((x) => x * 0.9) }); quad(P(t0, 0), P(t0, 1), P(t1, 1), P(t1, 0), v3.mul(up, -1)); }
          set('dr_prop', { c }); quad(W(F, -w / 2, yv0 - 0.04, zv), W(F, w / 2, yv0 - 0.04, zv), W(F, w / 2, yLow, zv), W(F, -w / 2, yLow, zv), out); quad(W(F, -w / 2, yv0 - 0.04, zv), W(F, -w / 2, yLow, zv), W(F, w / 2, yLow, zv), W(F, w / 2, yv0 - 0.04, zv), v3.mul(out, -1));
          set('dr_galv'); boxMM(F, -w / 2, yTop - 0.06, zs * 0.03 - 0.07, w / 2, yTop + 0.08, zs * 0.03 + 0.07, ['ny']);
        });
      }), { margin: 0.35 });
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
        near(() => { for (let x = 0.05; x <= run + 1e-6; x += run / 4) boxMM(st.F, x - 0.02, 0.0, zr - 0.02, x + 0.02, 1.0, zr + 0.02);
          boxMM(st.F, run - 0.02, 0.0, -zr - 0.02, run + 0.02, 1.0, -zr + 0.02); });
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
          near(() => { for (let k = 0; k < nS; k++) boxMM(F, k * tread, (k + 1) * rise - 0.03, -wS / 2 + 0.05, (k + 1) * tread, (k + 1) * rise, wS / 2 - 0.05, null); });
          far(() => { const G = { o: W(F, run / 2, fh / 2, 0), x: v3.norm(D(F, run, fh, 0)), y: v3.norm(D(F, -fh, run, 0)), z: F.z };   // [P7-E] past LOD_R the flight is one sloped slab
            boxMM(G, -Math.hypot(run, fh) / 2, -0.06, -wS / 2 + 0.05, Math.hypot(run, fh) / 2, 0.02, wS / 2 - 0.05); });
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
  // [P3-E graphics #2] a delivery scooter (PCX / Super Cub class) instead of boxes on hexagons: tyres and hubs, a curved leg
  // shield, floorboard, a rounded seat, a tapered rear cowl, bars with mirrors, lamps, and on most a 배달통 (delivery box).
  // Local x = forward (the front wheel at +0.64), y up, z = right. Same R draws as phase 2 (placement stays put).
  const scooter = (F, R) => {
    const body = [srgb(0x111111), srgb(0xe8e8e4), srgb(0xb3241f), srgb(0x5c6066), srgb(0x1d3f7a), srgb(0x2b2b2b)][Math.floor(R() * 6)];
    const hasBox = R() < 0.6, boxC = hasBox ? [srgb(0xe8e8e4), srgb(0xc8261e), srgb(0xf2b705), srgb(0x161616), srgb(0x2ac1bc)][Math.floor(R() * 5)] : null;
    const Rs = rng('scoot' + F.o[0].toFixed(2) + F.o[2].toFixed(2)), lean = 0.06 + Rs() * 0.05;            // on the side stand
    const G = { o: F.o, x: F.x, y: v3.norm(v3.add([0, 1, 0], v3.mul(F.z, -lean))), z: v3.norm(v3.add(F.z, v3.mul([0, 1, 0], lean))) };
    near(() => {   // [P7-E perf #1] the full scooter within LOD_R; the proxy below past it
      const nb = ['ny'];
      for (const x of [-0.6, 0.62]) { set('dr_prop', { c: [0.018, 0.018, 0.018] }); cyl(G, [x, 0.25, 0], 'z', 0.25, 0.11, 8); }
      set('dr_prop', { c: body });
      // leg shield: three facets curving from the steering head down to the floor; the front fender over the wheel
      { const sh = [[0.42, 1.0], [0.47, 0.72], [0.44, 0.45], [0.3, 0.3]]; for (let i = 0; i < 3; i++) { const [x0, y0] = sh[i], [x1, y1] = sh[i + 1], w0 = 0.2 + i * 0.02, w1 = 0.22 + i * 0.02;
        quad(W(G, x0, y0, -w0), W(G, x0, y0, w0), W(G, x1, y1, w1), W(G, x1, y1, -w1), D(G, 1, 0.3, 0)); } }
      boxMM(G, 0.45, 0.47, -0.09, 0.82, 0.52, 0.09, ['ny']);
      boxMM(G, -0.3, 0.28, -0.19, 0.32, 0.34, 0.19, nb);                                                 // floorboard
      // rear cowl: tapered, elliptical (a scaled frame), and the seat on it
      { const C = { o: W(G, -0.42, 0.56, 0), x: G.x, y: v3.mul(G.y, 0.75), z: G.z }; cyl(C, [0, 0, 0], 'x', 0.27, 0.62, 6, 0.2); }
      set('dr_prop', { c: [0.025, 0.022, 0.02] }); { const C = { o: W(G, -0.36, 0.79, 0), x: G.x, y: v3.mul(G.y, 0.45), z: G.z }; cyl(C, [0, 0, 0], 'x', 0.17, 0.66, 6, 0.15); }
      // steering column, bars, mirrors, headlight; tail lamp (a red reflector, off)
      set('dr_steel', { col: false }); tube([W(G, 0.44, 0.95, 0), W(G, 0.52, 1.06, 0)], 0.035, 4); tube([W(G, 0.5, 1.06, -0.34), W(G, 0.53, 1.08, 0), W(G, 0.5, 1.06, 0.34)], 0.014, 3);
      for (const sz of [-1, 1]) { tube([W(G, 0.5, 1.07, sz * 0.24), W(G, 0.47, 1.28, sz * 0.3)], 0.007, 3); quad(W(G, 0.465, 1.27, sz * 0.3 - 0.05), W(G, 0.465, 1.27, sz * 0.3 + 0.05), W(G, 0.465, 1.33, sz * 0.3 + 0.05), W(G, 0.465, 1.33, sz * 0.3 - 0.05), D(G, -1, 0, 0)); }
      set('dr_prop', { c: body }); boxMM(G, 0.46, 0.98, -0.14, 0.58, 1.1, 0.14);
      set('dr_galv', { col: false }); quad(W(G, 0.585, 0.99, -0.06), W(G, 0.585, 0.99, 0.06), W(G, 0.585, 1.07, 0.06), W(G, 0.585, 1.07, -0.06), D(G, 1, 0, 0));
      set('dr_steel', { col: false }); tube([W(G, -0.1, 0.32, -0.2), W(G, -0.1, 0.02, -0.38)], 0.012, 3);                 // the side stand
      if (hasBox) {   // 배달통 on the rear rack, its lid seam a shade darker
        set('dr_steel', { col: false }); boxMM(G, -0.95, 0.86, -0.18, -0.55, 0.88, 0.18, ['ny']);
        set('dr_prop', { c: boxC }); boxMM(G, -1.0, 0.88, -0.24, -0.52, 1.24, 0.24, ['ny']);
      }
    });
    set('dr_glow', { em: NI([1, 0.1, 0.05], 2), col: false }); quad(W(G, -0.735, 0.6, 0.08), W(G, -0.735, 0.6, -0.08), W(G, -0.735, 0.66, -0.08), W(G, -0.735, 0.66, 0.08), D(G, -1, 0, 0));
    far(() => {    // ~60 tris (the full one ~215): tyres, leg shield, cowl, seat, the delivery box
      set('dr_prop', { c: [0.018, 0.018, 0.018] }); for (const x of [-0.6, 0.62]) boxMM(G, x - 0.25, 0, -0.055, x + 0.25, 0.5, 0.055, ['ny']);
      set('dr_prop', { c: body }); boxMM(G, 0.3, 0.3, -0.21, 0.47, 1.05, 0.21, ['ny']); boxMM(G, -0.73, 0.34, -0.2, -0.1, 0.74, 0.2, ['ny']);
      set('dr_prop', { c: [0.025, 0.022, 0.02] }); boxMM(G, -0.68, 0.74, -0.16, -0.04, 0.86, 0.16, ['ny']);
      if (hasBox) { set('dr_prop', { c: boxC }); boxMM(G, -1.0, 0.86, -0.24, -0.52, 1.24, 0.24, ['ny']); }
    });
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
            // [P7-E perf #1] a stack is one box past LOD_R
            if (kind < 0.45) { set('dr_prop', { c: [srgb(0x1f7a3a), srgb(0x6b3d1d), srgb(0xd8a017)][Math.floor(R() * 3)] }); const h = 1 + Math.floor(R() * 4); near(() => { for (let k = 0; k < h; k++) boxMM(F, xo - 0.22, k * 0.3, -0.16, xo + 0.22, k * 0.3 + 0.29, 0.16); }); far(() => boxMM(F, xo - 0.22, 0, -0.16, xo + 0.22, h * 0.3 - 0.01, 0.16, ['ny'])); }
            else { set('dr_prop', { c: [srgb(0xd23a2a), srgb(0x2f6fd6), srgb(0x2a9a5a)][Math.floor(R() * 3)] }); const h = 1 + Math.floor(R() * 5); near(() => { for (let k = 0; k < h; k++) boxMM(F, xo - 0.15 + k * 0.004, k * 0.075, -0.15, xo + 0.15 + k * 0.004, k * 0.075 + 0.43, 0.15, k ? ['ny'] : null); }); far(() => boxMM(F, xo - 0.15, 0, -0.15, xo + 0.15 + h * 0.004, (h - 1) * 0.075 + 0.43, 0.15, ['ny'])); } }
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
        set('dark'); near(() => tube(pts, 0.025, 3)); }, { margin: 0.3 });   // [P7-E] 5 cm coils: near only
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
      const c = [x + Math.cos(a) * d, r * 0.85 + (i > 4 ? 0.3 : 0), z + Math.sin(a) * d];
      near(() => blob(c, r, r * 0.85, r * 1.1, R, 0, 0.22)); far(() => octa(c, r, r * 0.85));   // [P7-E] a bag is 8 tris past LOD_R (20 near)
    }
    if (R() < 0.5) { set('dr_prop', { c: [0.36, 0.25, 0.14] }); const F = frameH([x + 0.35, 0, z + 0.2], R() - 0.5, R() - 0.5); let nk = 0; while (nk < 2 + Math.floor(R() * 3)) nk++;   // (the loop's own draws: one per test)
      near(() => { for (let k = 0; k < nk; k++) boxMM(F, -0.35, k * 0.06, -0.28, 0.35, k * 0.06 + 0.055, 0.28); }); far(() => boxMM(F, -0.35, 0, -0.28, 0.35, (nk - 1) * 0.06 + 0.055, 0.28, ['ny'])); }
  }

  lap('kit');
  // ---- [P5-E art #6] the frontage kit: lit standing signs (입간판), A-frame boards, wheelie bins, cones and 주차금지 stands, so
  // the street has a thing every ~6 m of frontage with the scooters, crates and bags above (phase 4: w21's frontage was bare).
  // Signs: an LED box (0.28 x 0.5 x 1.3 m on a weighted base), its wide faces along the pavement, printed (label) at 220 nits
  // white-equivalent, so a red face is ~30 nits: saturated under the white point (color #3), red and orange on 55 % of them.
  // Own stream (placement of everything before it stays put).
  {
    const R = rng('frontkit' + seed);
    const SIGN_TXT = { bar: ['칵테일 BAR', '맥주', '호프', 'LIVE BAR', '하이볼', '와인바'], pocha: ['실내포차', '포차', '안주 일체'], karaoke: ['코인노래방', '노래방', '노래연습장'], club: ['CLUB', '라운지', 'PARTY'],
      restaurant: ['삼겹살', '고기집', '곱창', '치킨', '국밥', '김치찌개', '24시', '닭갈비'], cafe: ['COFFEE', '카페', '디저트'], shop: ['SALE', '빈티지', '옷'], pc: ['PC방'], motel: ['MOTEL'], hotel: ['HOTEL'], conv: ['24시'], office: ['상가'] };
    const SIGN_BG = ['#d0201a', '#e85a10', '#c8102e', '#f08a00', '#d0201a', '#e85a10', '#1a5ad0', '#7a1ac8', '#108a4a', '#f2c200', '#f4f0e8'];
    const nitsS = 220;
    const standSign = (F, txt, bg) => {
      const ink = bg === '#f2c200' || bg === '#f4f0e8' ? '#c8102e' : '#ffffff', c = srgb(parseInt(bg.slice(1), 16));
      set('dr_prop', { c: [0.02, 0.02, 0.022] }); boxMM(F, -0.2, 0, -0.32, 0.2, 0.12, 0.32, ['ny']); boxMM(F, -0.15, 1.42, -0.27, 0.15, 1.47, 0.27, ['ny']);
      set('dr_glow', { em: NI(c, nitsS), col: true }); boxMM(F, -0.14, 0.12, -0.25, 0.14, 1.42, 0.25, ['py', 'ny']);
      for (const sx of [1, -1]) labels.push({ id: 'stand:' + F.o[0].toFixed(2) + ':' + F.o[2].toFixed(2) + ':' + sx, kind: 'standsign', pos: r3(W(F, sx * 0.141, 0.77, 0)), normal: r3(D(F, sx, 0, 0)), w: 0.5, h: 1.3, nits: nitsS, bg, ink, lines: [txt], px: 110 });
      emit({ id: 'dress:stand:' + F.o[0].toFixed(2) + ':' + F.o[2].toFixed(2), kind: 'lightbox', pos: W(F, 0.15, 0.8, 0), normal: D(F, 1, 0, 0), w: 0.5, h: 1.3, rgb: c.map((v) => v / Math.max(0.05, 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])).map((v) => Math.min(v, 8)), nits: Math.max(1, Math.round(nitsS * (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]))), omni: 0.6, range: 5 });
      facts.standSigns = (facts.standSigns || 0) + 1;
    };
    const aFrame = (F, Rr) => {   // two boards hinged at 1.0 m, 0.36 m apart at the foot: chalkboard or a printed poster
      const poster = Rr() < 0.5, face = poster ? [srgb(0xe8e0d0), srgb(0xd0201a), srgb(0x202020), srgb(0xf2c200)][Math.floor(Rr() * 4)] : [0.03, 0.035, 0.03];
      for (const sz of [-1, 1]) {
        const fr = (y, z) => W(F, 0, y, sz * z), nrm = v3.norm(D(F, 0, 0.18, sz));
        set('dr_prop', { c: [0.12, 0.08, 0.05] }); for (const sx of [-0.3, 0.3]) tube([W(F, sx, 0, sz * 0.18), W(F, sx, 1.0, sz * 0.01)], 0.015, 3);
        set('dr_prop', { c: face, col: true }); quad(W(F, -0.28, 0.15, sz * 0.153), W(F, 0.28, 0.15, sz * 0.153), W(F, 0.28, 0.98, sz * 0.02), W(F, -0.28, 0.98, sz * 0.02), nrm);
        // chalk (or print) blocks: a heading band and 3-4 lines
        const ink = poster ? [srgb(0xffffff), srgb(0x1a1a1a), srgb(0xd0201a)][Math.floor(Rr() * 3)] : [0.55, 0.55, 0.5];
        set('dr_prop', { c: ink, col: false });
        const lines = [[0.9, 0.82, 0.4], [0.7, 0.66, 0.34], [0.58, 0.55, 0.3], [0.47, 0.44, 0.36], [0.36, 0.33, 0.22]];
        for (const [y1, y0, wl] of lines) { if (Rr() < 0.15) continue; const t = (y) => 0.153 - (y - 0.15) / 0.83 * 0.133 + 0.004, x0 = -wl / 2 + (Rr() - 0.5) * 0.05;
          quad(W(F, x0, y0, sz * t(y0)), W(F, x0 + wl, y0, sz * t(y0)), W(F, x0 + wl, y1, sz * t(y1)), W(F, x0, y1, sz * t(y1)), nrm); }
        void fr;
      }
      facts.aFrames = (facts.aFrames || 0) + 1;
    };
    const bin = (F, Rr) => {      // a 120 L wheelie bin (grey, green or blue), lid a shade darker, two wheels at the back
      const c = [srgb(0x4a5a4a), srgb(0x2a5a9a), srgb(0x2a6a3a), srgb(0x6a6a6a)][Math.floor(Rr() * 4)];
      set('dr_prop', { c }); box(F, 0, 0.5, 0, 0.24, 0.47, 0.27, ['ny']);
      set('dr_prop', { c: c.map((v) => v * 0.7) }); boxMM(F, -0.26, 0.97, -0.3, 0.26, 1.02, 0.29, ['ny']); boxMM(F, -0.22, 0.88, -0.32, 0.22, 0.95, -0.27);
      set('dr_prop', { c: [0.02, 0.02, 0.02], col: false }); for (const sx of [-0.2, 0.2]) cyl(F, [sx, 0.1, -0.24], 'x', 0.1, 0.05, 6);
      facts.bins = (facts.bins || 0) + 1;
    };
    const cone = (F, Rr) => {     // a traffic cone (reflective band) or a 주차금지 stand: shop-reserved parking, the alley classic
      if (Rr() < 0.55) { set('dr_prop', { c: srgb(0xf05a1a) }); boxMM(F, -0.2, 0, -0.2, 0.2, 0.04, 0.2, ['ny']); cyl(F, [0, 0.38, 0], 'y', 0.13, 0.68, 8, 0.03);
        set('dr_prop', { c: [0.75, 0.75, 0.72], col: false }); cyl(F, [0, 0.45, 0], 'y', 0.087, 0.12, 8, 0.073, false); }
      else { set('dr_prop', { c: srgb(0xf08a00) }); for (const sz of [-1, 1]) quad(W(F, -0.22, 0, sz * 0.2), W(F, 0.22, 0, sz * 0.2), W(F, 0.2, 0.75, sz * 0.02), W(F, -0.2, 0.75, sz * 0.02), v3.norm(D(F, 0, 0.25, sz)));
        for (const sz of [-1, 1]) quad(W(F, -0.22, 0, sz * 0.2), W(F, -0.2, 0.75, sz * 0.02), W(F, 0.2, 0.75, sz * 0.02), W(F, 0.22, 0, sz * 0.2), v3.norm(D(F, 0, -0.25, -sz)));
        set('dr_prop', { c: [0.8, 0.8, 0.78], col: false }); for (const sz of [-1, 1]) quad(W(F, -0.21, 0.42, sz * 0.111), W(F, 0.21, 0.42, sz * 0.111), W(F, 0.21, 0.55, sz * 0.077), W(F, -0.21, 0.55, sz * 0.077), v3.norm(D(F, 0, 0.25, sz))); }
      facts.cones = (facts.cones || 0) + 1;
    };
    for (const f of fronts) {
      if (!f.st || f.st.kind === 'main' || f.L < 3 || !inCore(f.mx, f.mz) || f.info?.shutter) continue;
      const use = f.l.use, busy = /bar|pocha|karaoke|club|restaurant/.test(use), retail = /cafe|shop|conv/.test(use);
      const w = busy ? [0.45, 0.15, 0.2, 0.2] : retail ? [0.2, 0.4, 0.2, 0.2] : [0.3, 0, 0.4, 0.3];
      const n = Math.floor(f.L / 8 * dens + R());
      for (let k = 0; k < n; k++) {
        const u = R(), kind = u < w[0] ? 0 : u < w[0] + w[1] ? 1 : u < w[0] + w[1] + w[2] ? 2 : 3;
        const s = 0.5 + (k + R()) / Math.max(1, n) * (f.L - 1.0), off = kind === 0 ? 0.55 : kind === 1 ? 0.75 : kind === 2 ? 0.4 : 0.5 + R() * 0.8;
        const x = f.fa[0] + f.tx * s + f.nx * off, z = f.fa[1] + f.tz * s + f.nz * off, r = kind === 0 ? 0.4 : 0.38;
        if (!occFree(x, z, r) || M.ribbonD(x, z, true) < 0.3 || !M.lotClear(x, z, 0.15) || M.lotAt(x + f.nx * 0.6, z + f.nz * 0.6)) continue;
        const Rr = rng('fk' + x.toFixed(2) + ':' + z.toFixed(2)), F = frameH([x, 0, z], f.tx, f.tz);
        let txt = null, bg = null;
        if (kind === 0) { const pool = SIGN_TXT[use] || ['상가']; const nm = f.l.osmName || ''; txt = /^[가-힣 ]{2,5}$/.test(nm) && Rr() < 0.4 ? nm : pool[Math.floor(Rr() * pool.length)]; bg = SIGN_BG[Math.floor(Rr() * SIGN_BG.length)]; }
        if (item(() => { if (kind === 0) standSign(F, txt, bg); else if (kind === 1) aFrame(F, Rr); else if (kind === 2) bin(F, Rr); else cone(F, Rr); }, { margin: 0.35, corr: 0.5 })) occAdd(x, z, r);
      }
    }
  }
  lap('frontkit');
  // ---- [P5-E graphics #4] the rooftops: 3-6 props per lot past C's stair house, tank, condenser and sign frame, so the aerial
  // stops reading as bare slabs: sandwich-panel sheds (blue, white or rust roofs; a quarter with a lit window), styrofoam
  // vegetable boxes, dishes on stands, turbine vents, solar panels, laundry racks, black PE tanks, pipe runs and condenser rows
  // (drawn by the AC kit below). Bar and cafe roofs: a lit deck (festoon square, tables, a parasol) on a third of them.
  // Props keep 0.5 m inside the parapet, off C's items, 1.5 m off every flight corridor. Own stream per lot.
  const roofAC = [];
  {
    const eoul = M.streets.filter((st) => st.name === 'Eoulmadang-ro' && st.kind === 'walking'), eoulD = (x, z) => { let d = Infinity; for (const st of eoul) for (const g of st.segs) d = Math.min(d, segD(x, z, g.ax, g.az, g.bx, g.bz)); return d; };
    const W8 = [['shed', 0.17], ['planters', 0.17], ['dish', 0.12], ['vent', 0.12], ['solar', 0.09], ['laundry', 0.09], ['tank', 0.08], ['ac', 0.1], ['pipe', 0.06]];
    let nR = 0, nDeck = 0, lowH = Infinity, nShedLamp = 0;
    for (const l of M.lots) {
      const P = l.footprint, H = l._H, area = Math.abs(polyArea(P)), [x0, x1, z0, z1] = l._bb;
      if (area < 30 || !inCore((x0 + x1) / 2, (z0 + z1) / 2)) continue;
      const info = opts.lotInfo?.get ? opts.lotInfo.get(l.id) : null, Rl = rng('roofkit' + l.id);
      const taken = [];   // discs on this roof: C's items, then ours
      for (const r of info?.roof || []) taken.push([r.x, r.z, r.kind === 'stair' ? 2.4 : 1.5]);
      for (const u of info?.ac || []) if (u.roof) taken.push([u.c[0], u.c[2], 1.0]);
      if (info?.roofSign) { const s = info.roofSign; for (let t = -0.5; t <= 0.5; t += 0.25) taken.push([s.c[0] + s.t[0] * t * s.w, s.c[2] + s.t[2] * t * s.w, 1.6]); }
      const fa = l.frontage[0], fb = l.frontage[1], fl = Math.hypot(fb[0] - fa[0], fb[1] - fa[1]) || 1, tx = (fb[0] - fa[0]) / fl, tz = (fb[1] - fa[1]) / fl;
      const fits = (x, z, r) => pip(x, z, P) && polyD(x, z, P) > r + 0.5 && !taken.some((d) => Math.hypot(d[0] - x, d[1] - z) < d[2] + r);
      const spot = (r) => { for (let t = 0; t < 16; t++) { const x = lerp(x0, x1, Rl()), z = lerp(z0, z1, Rl()); if (fits(x, z, r)) return [x, z]; } return null; };
      const deckLot = /bar|cafe|pocha|restaurant/.test(l.use) && l.floors <= 6 && area > 70 && Rl() < 0.33;
      let n = clamp(Math.round(area / 120) + 2, 3, 4); if (deckLot) n -= 2;
      const placeIn = (r, fn) => { const s = spot(r); if (!s) return false; const yaw = Rl() < 0.7 ? [tx, tz] : [-tz, tx]; const F = frameH([s[0], H, s[1]], yaw[0], yaw[1]);
        if (item(() => fn(F), { margin: 0.4, corr: 1.5 })) { taken.push([s[0], s[1], r]); nR++; return true; } return false; };
      if (deckLot) placeIn(2.6, (F) => {   // a lit deck: a festoon square on four posts, two tables, a parasol, crates
        set('dr_steel'); for (const [a, b] of [[-2, -2], [2, -2], [2, 2], [-2, 2]]) cyl(F, [a, 1.25, b], 'y', 0.035, 2.5, 5);
        const cnr = [[-2, -2], [2, -2], [2, 2], [-2, 2]].map(([a, b]) => W(F, a, 2.45, b));
        for (let i = 0; i < 4; i++) { const a = cnr[i], b = cnr[(i + 1) % 4], pts = []; for (let k = 0; k <= 10; k++) { const t = k / 10; pts.push([lerp(a[0], b[0], t), a[1] - 0.25 * 4 * t * (1 - t), lerp(a[2], b[2], t)]); }
          set('dark', { col: false }); cable(pts, 0.006, 3);
          set('dr_glow', { em: NI(srgb(0xffb46b), 1400), col: false }); for (let k = 1; k < 10; k++) { const p = pts[k]; bulb([p[0], p[1] - 0.05, p[2]], 0.028, 0.04); } }
        for (const [a, b] of [[-0.9, -0.6], [0.9, 0.7]]) { set('dr_prop', { c: [0.5, 0.5, 0.52] }); cyl(F, [a, 0.72, b], 'y', 0.4, 0.04, 10); set('dr_steel', { col: false }); cyl(F, [a, 0.36, b], 'y', 0.03, 0.7, 5);
          for (const d of [[0.6, 0], [-0.6, 0], [0, 0.6]]) { set('dr_prop', { c: [srgb(0x2f6fd6), srgb(0xd23a2a), srgb(0x1f7a3a)][Math.floor(Rl() * 3)] }); boxMM(F, a + d[0] - 0.15, 0, b + d[1] - 0.15, a + d[0] + 0.15, 0.43, b + d[1] + 0.15, ['ny']); } }
        set('dr_prop', { c: srgb(0x1d4d2b), col: false }); { const c0 = W(F, 0, 2.2, 0); for (let k = 0; k < 8; k++) { const a0 = k / 8 * TAU, a1 = (k + 1) / 8 * TAU; tri(c0, W(F, Math.cos(a1) * 1.3, 1.85, Math.sin(a1) * 1.3), W(F, Math.cos(a0) * 1.3, 1.85, Math.sin(a0) * 1.3)); tri(c0, W(F, Math.cos(a0) * 1.3, 1.85, Math.sin(a0) * 1.3), W(F, Math.cos(a1) * 1.3, 1.85, Math.sin(a1) * 1.3)); } }
        set('dr_steel', { col: false }); cyl(F, [0, 1.1, 0], 'y', 0.02, 2.2, 4);
        emit({ id: 'dress:deck:' + l.id, kind: 'neon', pos: W(F, 0, 2.3, 0), normal: [0, -1, 0], w: 4, h: 4, rgb: [1.0, 0.62, 0.32], nits: 40, omni: 0.9, range: 9 });
        nDeck++;
      });
      for (let k = 0; k < n; k++) {
        let u = Rl(), kind = W8[W8.length - 1][0]; for (const [kk, p] of W8) { if (u < p) { kind = kk; break; } u -= p; }
        if (kind === 'shed') { if (taken.some((d) => d[3] === 'shed')) continue;
          const w = 2.4 + Rl() * 1.6, d = 2.0 + Rl() * 1.0, h = 2.3, roofC = [srgb(0x2a5aa8), srgb(0x2a5aa8), srgb(0xb8b8b4), srgb(0xa8402a)][Math.floor(Rl() * 4)], litW = Rl() < 0.4;   // [P6-E art #5] 25 -> 40 % lit
          placeIn(Math.hypot(w, d) / 2, (F) => {
            set('dr_prop', { c: [0.5, 0.5, 0.48] }); boxMM(F, -w / 2, 0, -d / 2, w / 2, h, d / 2, ['ny', 'py']);
            set('dr_prop', { c: [0.36, 0.36, 0.35], col: false }); for (let x = -w / 2 + 0.5; x < w / 2 - 0.2; x += 0.5) for (const sz of [-1, 1]) near(() => quad(W(F, x - 0.025, 0.02, sz * (d / 2 + 0.008)), W(F, x + 0.025, 0.02, sz * (d / 2 + 0.008)), W(F, x + 0.025, h - 0.02, sz * (d / 2 + 0.008)), W(F, x - 0.025, h - 0.02, sz * (d / 2 + 0.008)), D(F, 0, 0, sz)));   // [P7-E] panel seams: near only
            set('dr_prop', { c: roofC }); quad(W(F, -w / 2 - 0.12, h + 0.12, -d / 2 - 0.12), W(F, w / 2 + 0.12, h + 0.12, -d / 2 - 0.12), W(F, w / 2 + 0.12, h - 0.02, d / 2 + 0.12), W(F, -w / 2 - 0.12, h - 0.02, d / 2 + 0.12), [0, 1, 0]);
            set('dr_prop', { c: [0.3, 0.32, 0.34], col: false }); quad(W(F, -0.45, 0.02, d / 2 + 0.015), W(F, 0.45, 0.02, d / 2 + 0.015), W(F, 0.45, 2.0, d / 2 + 0.015), W(F, -0.45, 2.0, d / 2 + 0.015), D(F, 0, 0, 1));
            if (litW) { set('dr_glow', { em: NI([1.0, 0.86, 0.68], 28), col: false }); quad(W(F, w / 2 - 1.1, 1.1, d / 2 + 0.016), W(F, w / 2 - 0.4, 1.1, d / 2 + 0.016), W(F, w / 2 - 0.4, 1.7, d / 2 + 0.016), W(F, w / 2 - 1.1, 1.7, d / 2 + 0.016), D(F, 0, 0, 1));
              // [P6-E art #5 / graphics #4] an occupied shed has a bulkhead over its door (400 lm, 3000 K): from the air a lit
              // pane and a pool on the roof slab, which is how the reference roofs read at night (the props in it, not as black)
              set('dr_steel', { col: false }); boxMM(F, -0.1, 2.1, d / 2, 0.1, 2.2, d / 2 + 0.07, ['nz']);
              set('dr_glow', { em: NI([1.0, 0.8, 0.56], 7000), col: false }); boxMM(F, -0.08, 2.085, d / 2 + 0.005, 0.08, 2.1, d / 2 + 0.065, ['py', 'nz']);
              emit({ id: 'dress:shedlamp:' + l.id, kind: 'street', role: 'roof', pos: W(F, 0, 2.08, d / 2 + 0.04), normal: D(F, 0, -0.9, 0.44), w: 0.16, h: 0.06, rgb: [1.0, 0.8, 0.56], nits: Math.round(400 / (Math.PI * 0.16 * 0.06)), lumens: 400, cct: 3000, lot: l.id });
              nShedLamp++; }
          }) && (taken[taken.length - 1][3] = 'shed');
        } else if (kind === 'planters') { const nb = 3 + Math.floor(Rl() * 3), rows = Rl() < 0.3 ? 2 : 1;
          placeIn(Math.max(nb * 0.33, rows * 0.5), (F) => { lowH = Math.min(lowH, H); for (let r = 0; r < rows; r++) for (let i = 0; i < nb; i++) { const x = (i - (nb - 1) / 2) * 0.64, z = (r - (rows - 1) / 2) * 0.48, g = Rl();
            set('dr_roof', { c: g < 0.2 ? [0.12, 0.3, 0.6] : g < 0.3 ? [0.45, 0.2, 0.1] : [0.72, 0.72, 0.7] }); boxMM(F, x - 0.3, 0, z - 0.2, x + 0.3, 0.3, z + 0.2, ['ny', 'py']);
            set('dr_roof', { c: Rl() < 0.7 ? [0.05 + Rl() * 0.04, 0.13 + Rl() * 0.08, 0.03] : [0.12, 0.08, 0.05], col: false }); const hy = 0.3 + Rl() * 0.12; quad(W(F, x - 0.28, hy, z - 0.18), W(F, x + 0.28, hy, z - 0.18), W(F, x + 0.28, hy, z + 0.18), W(F, x - 0.28, hy, z + 0.18), [0, 1, 0]); } });
        } else if (kind === 'dish') placeIn(0.6, (F) => { set('dr_steel', { col: false }); cyl(F, [0, 0.6, 0], 'y', 0.025, 1.2, 4, 0.025, false);
            const G = { o: W(F, 0, 1.2, 0), x: v3.norm(D(F, 0.6, 0.8, 0)), y: v3.norm(D(F, -0.8, 0.6, 0)), z: F.z }; set('dr_prop', { c: [0.6, 0.6, 0.58], col: false }); cyl(G, [0.05, 0, 0], 'x', 0.05, 0.1, 7, 0.3, false);
            set('dr_steel', { col: false }); near(() => tube([W(G, 0.08, 0.25, 0), W(G, 0.45, 0, 0), W(G, 0.08, -0.25, 0)], 0.008, 3)); });
        else if (kind === 'vent') placeIn(0.4, (F) => { const turb = Rl() < 0.6; set('dr_galv', { col: false }); cyl(F, [0, 0.45, 0], 'y', 0.12, 0.9, 6, 0.12, false);
            if (turb) cyl(F, [0, 1.12, 0], 'y', 0.22, 0.44, 7, 0.08); else cyl(F, [0, 0.98, 0], 'y', 0.24, 0.12, 6, 0.08); });
        else if (kind === 'solar') placeIn(1.1, (F) => { lowH = Math.min(lowH, H); set('dr_roof', { c: DRESS_MATS.dr_steel.color }); for (const sx of [-0.8, 0.8]) { boxMM(F, sx - 0.03, 0, -0.5, sx + 0.03, 0.4, -0.44); boxMM(F, sx - 0.03, 0, 0.44, sx + 0.03, 1.0, 0.5); }
            { const a = W(F, -0.95, 0.42, -0.55), b = W(F, 0.95, 0.42, -0.55), c = W(F, 0.95, 1.02, 0.55), d = W(F, -0.95, 1.02, 0.55); set('dr_roof', { c: [0.02, 0.03, 0.07] }); quad(a, b, c, d, v3.norm(v3.cross(v3.sub(b, a), v3.sub(d, a))[1] > 0 ? v3.cross(v3.sub(b, a), v3.sub(d, a)) : v3.cross(v3.sub(d, a), v3.sub(b, a))));
              set('dr_roof', { c: [0.5, 0.5, 0.52], col: false }); for (const t of [0.33, 0.66]) { const p = (q, r) => v3.add(q, v3.mul(v3.sub(r, q), t)); const e0 = p(a, d), e1 = p(b, c); quad(v3.add(e0, [0, 0.006, 0]), v3.add(e1, [0, 0.006, 0]), v3.add(e1, [0, 0.026, 0]), v3.add(e0, [0, 0.026, 0]), [0, 1, 0]); } } });
        else if (kind === 'laundry') placeIn(1.0, (F) => { set('dr_galv', { col: false }); near(() => { for (const sx of [-0.8, 0.8]) tube([W(F, sx, 0, -0.35), W(F, sx, 1.3, 0), W(F, sx, 0, 0.35)], 0.012, 3);
            for (const z of [-0.12, 0, 0.12]) tube([W(F, -0.8, 1.28, z), W(F, 0.8, 1.28, z)], 0.006, 3); });
            for (let i = 0; i < 6; i++) { if (Rl() < 0.3) continue; const x = -0.65 + i * 0.26, z = [-0.12, 0, 0.12][i % 3], h = 0.35 + Rl() * 0.4; set('dr_prop', { c: [[0.7, 0.7, 0.68], [0.1, 0.1, 0.12], [0.2, 0.3, 0.55], [0.6, 0.2, 0.2], [0.55, 0.5, 0.4]][Math.floor(Rl() * 5)], col: false });
              quad(W(F, x - 0.11, 1.28 - h, z), W(F, x + 0.11, 1.28 - h, z), W(F, x + 0.11, 1.28, z), W(F, x - 0.11, 1.28, z), D(F, 0, 0, 1)); quad(W(F, x - 0.11, 1.28 - h, z), W(F, x - 0.11, 1.28, z), W(F, x + 0.11, 1.28, z), W(F, x + 0.11, 1.28 - h, z), D(F, 0, 0, -1)); } });
        else if (kind === 'tank') placeIn(0.7, (F) => { set('dr_prop', { c: Rl() < 0.6 ? [0.025, 0.025, 0.03] : [0.08, 0.18, 0.45] }); cyl(F, [0, 0.55, 0], 'y', 0.55, 1.1, 8); });
        else if (kind === 'ac') { const s = spot(1.6); if (!s) continue; const nu = 2 + Math.floor(Rl() * 3), ya = Math.atan2(tz, tx);
          for (let i = 0; i < nu; i++) { const x = s[0] + tx * (i - (nu - 1) / 2) * 1.0, z = s[1] + tz * (i - (nu - 1) / 2) * 1.0; if (!fits(x, z, 0.55) || corrHit([x - 0.6, H, z - 0.6, x + 0.6, H + 1.2, z + 0.6], 1.5)) continue;
            roofAC.push({ c: [x, H + 0.4, z], n: [Math.sin(ya), 0, -Math.cos(ya)].map((v) => (Rl() < 0.5 ? v : -v)), size: [0.84, 0.64, 0.32], roof: true, tint: [1, 1, 0.97] }); taken.push([x, z, 0.55]); } }
        else if (kind === 'pipe') placeIn(0.5, (F) => { lowH = Math.min(lowH, H); const L = 2 + Rl() * 3; set('dr_roof', { c: DRESS_MATS.dr_galv.color, col: false }); tube([W(F, -L / 2, 0.25, 0), W(F, L / 2, 0.25, 0), W(F, L / 2, 0.25, 0.01)], 0.05, 5); set('dr_roof', { c: [0.3, 0.29, 0.27], col: false }); for (let x = -L / 2 + 0.3; x < L / 2; x += 1.2) boxMM(F, x - 0.1, 0, -0.12, x + 0.1, 0.2, 0.12, ['ny']); });
      }
      // [P7-E art #5 / graphics #6] the roofs round Eoulmadang-ro (lot centre within 80 m of the walking street) carry what
      // the reference roofs do: a water tank (물탱크: an FRP panel tank, pale blue or cream, or a stainless drum) on a steel
      // stand, and a condenser pair. Albedo >= 0.35 (graphics #6's floor), so the near roofs read from the air. They collide.
      // The lot's own stream, after its props: nothing placed before moves.
      if (eoulD((x0 + x1) / 2, (z0 + z1) / 2) < 80 && area >= 45) {
        if (Rl() < 0.8) { const frp = Rl() < 0.65, w = frp ? 1.6 + Rl() * 0.8 : 1.3, dd = frp ? 1.2 + Rl() * 0.6 : 1.3, hh = frp ? 1.2 + Rl() * 0.5 : 1.7, col = frp ? (Rl() < 0.6 ? [0.42, 0.6, 0.7] : [0.7, 0.68, 0.6]) : [0.62, 0.63, 0.64];
          placeIn(Math.hypot(w, dd) / 2 + 0.1, (F) => {
            if (!startOK([W(F, 0, 0, 0), W(F, 0, 0.5 + hh, 0)], 1.5 + Math.hypot(w, dd) / 2)) return false;
            set('dr_steel'); boxMM(F, -w / 2 - 0.05, 0, -dd / 2 - 0.05, w / 2 + 0.05, 0.12, dd / 2 + 0.05, ['ny']);                       // the stand's frame
            near(() => { for (const sx of [-1, 1]) for (const sz of [-1, 1]) boxMM(F, sx * (w / 2 - 0.05) - 0.04, 0.12, sz * (dd / 2 - 0.05) - 0.04, sx * (w / 2 - 0.05) + 0.04, 0.5, sz * (dd / 2 - 0.05) + 0.04, ['ny', 'py']); });
            if (frp) { set('dr_prop', { c: col }); boxMM(F, -w / 2, 0.5, -dd / 2, w / 2, 0.5 + hh, dd / 2, ['ny']);
              near(() => { set('dr_prop', { c: col.map((v) => v * 0.78), col: false }); for (let x = -w / 2 + 0.5; x < w / 2 - 0.1; x += 0.5) for (const sz of [-1, 1]) quad(W(F, x - 0.02, 0.52, sz * (dd / 2 + 0.006)), W(F, x + 0.02, 0.52, sz * (dd / 2 + 0.006)), W(F, x + 0.02, 0.48 + hh, sz * (dd / 2 + 0.006)), W(F, x - 0.02, 0.48 + hh, sz * (dd / 2 + 0.006)), D(F, 0, 0, sz));
                set('dr_prop', { c: [0.36, 0.36, 0.37], col: false }); boxMM(F, -0.25, 0.5 + hh, -0.25, 0.25, 0.56 + hh, 0.25, ['ny']); });   // panel seams, the hatch
            } else { set('dr_prop', { c: col }); cyl(F, [0, 0.5 + hh / 2, 0], 'y', 0.62, hh, 10); near(() => { set('dr_prop', { c: col.map((v) => v * 0.8), col: false }); for (const y of [0.5 + hh * 0.33, 0.5 + hh * 0.66]) cyl(F, [0, y, 0], 'y', 0.632, 0.04, 10, 0.632, false); }); }
            facts.roofTanks = (facts.roofTanks || 0) + 1;
          }); }
        const s2 = spot(1.3); if (s2 && Rl() < 0.7) { const ya = Math.atan2(tz, tx), out = [Math.sin(ya), 0, -Math.cos(ya)].map((v) => (Rl() < 0.5 ? v : -v));
          for (let i = 0; i < 2; i++) { const x = s2[0] + tx * (i - 0.5) * 1.0, z = s2[1] + tz * (i - 0.5) * 1.0; if (!fits(x, z, 0.55) || corrHit([x - 0.6, H, z - 0.6, x + 0.6, H + 1.2, z + 0.6], 1.5) || !startOK([[x, H + 0.4, z]], 2.0)) continue;
            roofAC.push({ c: [x, H + 0.4, z], n: out, size: [0.84, 0.64, 0.32], roof: true, tint: [1, 1, 0.97] }); taken.push([x, z, 0.55]); facts.roofCondensers = (facts.roofCondensers || 0) + 1; } }
      }
    }
    facts.roofProps = nR + roofAC.length; facts.roofDecks = nDeck; facts.roofHideY = Number.isFinite(lowH) ? +lowH.toFixed(2) : 0; facts.shedLamps = nShedLamp;
  }
  lap('roofs');
  // ---- [P3-E graphics #2] AC condensers: C places them (its facade rules), E draws them. Contract P3-E1: C records each unit
  // as lotInfo.get(id).ac = [{ c: [x, y, z] centre, n: [nx, 0, nz] out of the wall, size: [w, h, d], tint, roof }] (or passes
  // opts.acUnits) and stops drawing its box; absent, nothing is drawn here. Kit: enamel housing with a lid, the fan opening
  // with a two-ring grille, spokes and hub, louvres, a steel bracket and strut, insulated pipes into the wall, a drain hose.
  {
    const units = (opts.acUnits || (opts.lotInfo?.values ? [...opts.lotInfo.values()].flatMap((i) => i.ac || []) : [])).concat(roofAC);   // [P5-E] + the roof kit's condenser rows
    for (const u of units) {
      if (!u?.c || !u?.n) continue;
      const [w, h, d] = u.size || [0.84, 0.64, 0.34], hx = w / 2, hy = h / 2, hz = d / 2, t = u.tint || [1, 1, 1];
      const F = frameH(u.c, u.n[2], -u.n[0]);           // local z = out of the wall
      const enamel = [0.45 * t[0], 0.45 * t[1], 0.43 * t[2]], Ru = rng('ac' + u.c[0].toFixed(2) + u.c[2].toFixed(2));
      set('dr_prop', { c: enamel }); box(F, 0, 0, 0, hx, hy, hz, ['pz', 'nz']);                         // housing (back to the wall)
      set('dr_ac', { c: t.map((v) => v * 0.95), col: true }); quad(W(F, -hx, -hy, hz), W(F, hx, -hy, hz), W(F, hx, hy, hz), W(F, -hx, hy, hz), D(F, 0, 0, 1));
      if (!u.roof) {   // wall bracket: two angles to the wall, their struts
        near(() => { set('dr_steel', { col: false }); for (const sx of [-1, 1]) { const x = sx * (hx - 0.08); tube([W(F, x, -hy - 0.45, -hz - 0.2), W(F, x, -hy - 0.02, hz - 0.03)], 0.014, 3); } });   // [P7-E] 3 cm struts: near only
      } else { set('dr_steel'); boxMM(F, -hx, -hy - 0.12, -hz, hx, -hy, hz, ['py', 'ny']); }
      // the insulated pipes out of the side and into the wall (one bundle)
      const side = Ru() < 0.5 ? 1 : -1;
      near(() => { set('dr_prop', { c: [0.5, 0.48, 0.42], col: false }); tube([W(F, side * hx, -0.06, -hz * 0.3), W(F, side * (hx + 0.07), -0.04, -hz - 0.21)], 0.024, 3); });
      facts.ac = (facts.ac || 0) + 1;
    }
  }
  lap('ac');
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
          cable(pts, r, 3); facts.cablesExtra++;
          if (tel && R() < 0.35) { const p2 = pts.map((v, j) => [v[0], v[1] - 0.05 - 0.02 * Math.sin(j), v[2] + 0.03]); cable(p2, r * 0.7, 3); }
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
        cable(pts, 0.009 + R() * 0.006, 3, 0.012); facts.drops++;
        set('dr_prop', { c: [0.3, 0.3, 0.3] }); near(() => boxMM(FW, wx - 0.08, wy - 0.12, wz - 0.08, wx + 0.08, wy + 0.08, wz + 0.08)); set('dark');
      }
    }
  }

  lap('cables');
  // ================================================================================================ OVERHEAD (P5-E art #4)
  // Phase 4's walking and club streets were a black void above 6 m. Hongdae's carry wall-to-wall lines: telecom bundles,
  // festoon strings (S14 bulbs at 0.4 m pitch, 2200 K) and pennant bunting. A station every 8-12 m where both walls stand
  // within 22 m: 2-4 sagging lines between 5.8 m and 0.6 m under the lower roof, their ends skewed along the street so the
  // lattice criss-crosses; 30 % of stations carry a festoon string, 15 % bunting. Lines render as the screen-space cables
  // (no tubes: >= 1.25 px, true width up close) and collide (3-sided tubes in colTris only); bulbs and flags do not.
  // Every line keeps 0.5 m off the gates and 1.2 m off every flight corridor.
  const colTube = (pts, r) => { for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1], t = v3.norm(v3.sub(b, a)), u = v3.norm(v3.cross(t, Math.abs(t[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), v = v3.cross(u, t);
    const ring = (p) => [0, 1, 2].map((k) => { const th = k / 3 * TAU; return v3.add(p, v3.add(v3.mul(u, Math.cos(th) * r), v3.mul(v, Math.sin(th) * r))); }), A2 = ring(a), B2 = ring(b);
    for (let k = 0; k < 3; k++) { const k1 = (k + 1) % 3; col.need(18); col.p3(...A2[k]); col.p3(...A2[k1]); col.p3(...B2[k1]); col.p3(...A2[k]); col.p3(...B2[k1]); col.p3(...B2[k]); } } };
  // [P7-E] a festoon bulb: a triangular bipyramid (6 tris; the octahedron's 8 for a 5 cm lamp: ~1700 of them now)
  function bulb(p, rx, ry) { const q = [0, 1, 2].map((k) => v3.add(p, [Math.cos(k * TAU / 3) * rx, 0, Math.sin(k * TAU / 3) * rx])), top = v3.add(p, [0, ry, 0]), bot = v3.add(p, [0, -ry, 0]);
    for (let k = 0; k < 3; k++) { const a = q[k], b = q[(k + 1) % 3]; tri(top, b, a); tri(bot, a, b); } }
  function octa(p, rx, ry) { const q = [[rx, 0, 0], [0, 0, rx], [-rx, 0, 0], [0, 0, -rx]].map((d) => v3.add(p, d)), top = v3.add(p, [0, ry, 0]), bot = v3.add(p, [0, -ry, 0]);
    for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; tri(top, b, a); tri(bot, a, b); } }
  {
    const R = rng('overhead' + seed); let nSt = 0, nFest = 0, nBunt = 0, nLines = 0;
    const sagLine = (a, b, sag) => { const L = Math.hypot(b[0] - a[0], b[2] - a[2]), n = Math.max(4, Math.ceil(L / 0.9)), pts = []; for (let i = 0; i <= n; i++) { const t = i / n; pts.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t) - 4 * sag * L * t * (1 - t), lerp(a[2], b[2], t)]); } return pts; };
    const hAt = (x, z) => { const l = M.lotAt(x, z); return l ? l._H : 0; };
    for (const st of M.streets.filter((s) => s.kind === 'walking' || s.kind === 'club')) for (let s = 4 + R() * 4; s < st.len - 4; s += 8 + R() * 4) {
      const q = M.at(st, s); if (!inCore(q.x, q.z)) continue;
      const nx = -q.tz, nz = q.tx, dl = M.freeRay(q.x, q.z, -nx, -nz, 22, 0.1), dr = M.freeRay(q.x, q.z, nx, nz, 22, 0.1);
      if (!isFinite(dl) || !isFinite(dr) || dl + dr < 4) continue;
      const nLn = 2 + Math.floor(R() * 3), fest = R() < 0.3, bunt = !fest && R() < 0.21;
      let placed = 0;
      for (let k = 0; k < nLn; k++) {
        const kind = k === 0 && fest ? 'fest' : k === 0 && bunt ? 'bunt' : 'cable';
        const sa = (R() - 0.5) * 3, sb = (R() - 0.5) * 3;
        const ax = q.x - nx * (dl - 0.03) + q.tx * sa, az = q.z - nz * (dl - 0.03) + q.tz * sa, bx = q.x + nx * (dr - 0.03) + q.tx * sb, bz = q.z + nz * (dr - 0.03) + q.tz * sb;
        // the ends must sit on a wall: re-cast from the street centre line to each end's side
        const Ha = hAt(ax - nx * 0.15, az - nz * 0.15), Hb = hAt(bx + nx * 0.15, bz + nz * 0.15), top = Math.min(Ha, Hb) - 0.6;
        if (top < 6.3 || !M.lotAt(ax - nx * 0.15, az - nz * 0.15) || !M.lotAt(bx + nx * 0.15, bz + nz * 0.15) || M.lotAt(ax + nx * 0.25, az + nz * 0.25) || M.lotAt(bx - nx * 0.25, bz - nz * 0.25)) continue;
        const ya = 5.8 + R() * Math.min(4, top - 5.8), yb = clamp(ya + (R() - 0.5) * 1.2, 5.8, top), sag = kind === 'fest' ? 0.05 + R() * 0.03 : kind === 'bunt' ? 0.03 + R() * 0.02 : 0.02 + R() * 0.025;
        const pts = sagLine([ax, ya, az], [bx, yb, bz], sag);
        if (!polyGateOK(pts, 0.5) || !polyCorrOK(pts, 1.2)) { facts.rejectedByGates++; continue; }
        const r = kind === 'cable' ? (R() < 0.3 ? 0.03 : 0.01 + R() * 0.008) : 0.005;
        if (!item(() => {
          cables.push({ pts: pts.map(r3), r }); colTube(pts, Math.max(r, 0.012));
          set('dr_steel', { col: false }); near(() => { for (const p of [pts[0], pts[pts.length - 1]]) box(FW, p[0], p[1], p[2], 0.04, 0.04, 0.04); });
          if (kind === 'fest') {
            const L = Math.hypot(bx - ax, bz - az), nb = Math.floor(L / 0.4);
            for (let i = 1; i < nb; i++) { const t = i / nb, j = t * (pts.length - 1), j0 = Math.floor(j), f2 = j - j0, a = pts[j0], b = pts[Math.min(pts.length - 1, j0 + 1)], p = [lerp(a[0], b[0], f2), lerp(a[1], b[1], f2), lerp(a[2], b[2], f2)];
              set('dark', { col: false }); near(() => box(FW, p[0], p[1] - 0.035, p[2], 0.012, 0.025, 0.012));   // the socket: near only (the bulb stays)
              set('dr_glow', { em: NI(srgb(0xffb46b), 1500), col: false }); bulb([p[0], p[1] - 0.1, p[2]], 0.03, 0.045); }
            const m = pts[Math.floor(pts.length / 2)];
            emit({ id: 'dress:festoon:' + st.id + ':' + s.toFixed(1), kind: 'neon', pos: [m[0], m[1] - 0.1, m[2]], normal: [0, -1, 0], w: +L.toFixed(2), h: 0.12, rgb: [1.0, 0.62, 0.32], nits: 400, omni: 0.8, range: 12 });
            nFest++;
          } else if (kind === 'bunt') {
            const pal = [[0.6, 0.05, 0.04], [0.85, 0.5, 0.03], [0.05, 0.25, 0.6], [0.75, 0.72, 0.65], [0.1, 0.45, 0.15], [0.55, 0.1, 0.45]], off = Math.floor(R() * 6);
            const L = Math.hypot(bx - ax, bz - az), nf = Math.floor(L / 0.32), dx = (bx - ax) / L, dz = (bz - az) / L;
            for (let i = 1; i < nf; i++) { const t = i / nf, j = t * (pts.length - 1), j0 = Math.floor(j), f2 = j - j0, a = pts[j0], b = pts[Math.min(pts.length - 1, j0 + 1)], p = [lerp(a[0], b[0], f2), lerp(a[1], b[1], f2), lerp(a[2], b[2], f2)];
              set('dr_prop', { c: pal[(i + off) % 6], col: false }); const p0 = [p[0] - dx * 0.11, p[1], p[2] - dz * 0.11], p1 = [p[0] + dx * 0.11, p[1], p[2] + dz * 0.11], p2 = [p[0], p[1] - 0.24, p[2]];
              tri(p0, p1, p2); tri(p0, p2, p1); }
            nBunt++;
          }
        }, { margin: 0.5, noGate: false })) continue;
        placed++; nLines++;
      }
      if (placed) nSt++;
    }
    // [P7-E, for D's festoon light] more festoon strings over the walking and club streets: phase 5's pass hung 18, so D's
    // string light (each bulb a source along the line) lifted the ground only 4-9 %. A second pass on its own stream (every
    // line above stays put): a station every 6-10 m between phase 5's, a string at ~3 of 4, skewed along the street, with
    // the same tests (both ends on a wall, 5.8 m up to 0.6 m under the lower roof, 0.5 m off every gate, 1.2 m off every
    // flight corridor). Bulbs at 0.4 m; the sockets are near-tier. Same emitter record as above (D parses dress:festoon:<street>:<s>).
    let nFest2 = 0;
    { const R2 = rng('festoon2' + seed);
      for (const st of M.streets.filter((x) => x.kind === 'walking' || x.kind === 'club')) for (let s = 2 + R2() * 6; s < st.len - 3; s += 6 + R2() * 4) {
        if (R2() > 0.75) continue;
        const q = M.at(st, s); if (!inCore(q.x, q.z)) continue;
        const nx = -q.tz, nz = q.tx, dl = M.freeRay(q.x, q.z, -nx, -nz, 22, 0.1), dr = M.freeRay(q.x, q.z, nx, nz, 22, 0.1);
        if (!isFinite(dl) || !isFinite(dr) || dl + dr < 4) continue;
        const sa = (R2() - 0.5) * 4, sb = (R2() - 0.5) * 4;
        const ax = q.x - nx * (dl - 0.03) + q.tx * sa, az = q.z - nz * (dl - 0.03) + q.tz * sa, bx = q.x + nx * (dr - 0.03) + q.tx * sb, bz = q.z + nz * (dr - 0.03) + q.tz * sb;
        const Ha = hAt(ax - nx * 0.15, az - nz * 0.15), Hb = hAt(bx + nx * 0.15, bz + nz * 0.15), top = Math.min(Ha, Hb) - 0.6;
        if (top < 6.3 || !M.lotAt(ax - nx * 0.15, az - nz * 0.15) || !M.lotAt(bx + nx * 0.15, bz + nz * 0.15) || M.lotAt(ax + nx * 0.25, az + nz * 0.25) || M.lotAt(bx - nx * 0.25, bz - nz * 0.25)) continue;
        const ya = 5.8 + R2() * Math.min(3.5, top - 5.8), yb = clamp(ya + (R2() - 0.5) * 1.2, 5.8, top), pts = sagLine([ax, ya, az], [bx, yb, bz], 0.05 + R2() * 0.03);
        if (!polyGateOK(pts, 0.5) || !polyCorrOK(pts, 1.2) || !startOK(pts, 1.5)) { facts.rejectedByGates++; continue; }
        item(() => {
          cables.push({ pts: pts.map(r3), r: 0.005 }); colTube(pts, 0.012);
          set('dr_steel', { col: false }); near(() => { for (const p of [pts[0], pts[pts.length - 1]]) box(FW, p[0], p[1], p[2], 0.04, 0.04, 0.04); });
          const L = Math.hypot(bx - ax, bz - az), nb = Math.floor(L / 0.4);
          for (let i = 1; i < nb; i++) { const j = i / nb * (pts.length - 1), j0 = Math.floor(j), f2 = j - j0, a = pts[j0], b = pts[Math.min(pts.length - 1, j0 + 1)], p = [lerp(a[0], b[0], f2), lerp(a[1], b[1], f2), lerp(a[2], b[2], f2)];
            set('dark', { col: false }); near(() => box(FW, p[0], p[1] - 0.035, p[2], 0.012, 0.025, 0.012));
            set('dr_glow', { em: NI(srgb(0xffb46b), 1500), col: false }); bulb([p[0], p[1] - 0.1, p[2]], 0.03, 0.045); }
          const m = pts[Math.floor(pts.length / 2)];
          emit({ id: 'dress:festoon:' + st.id + ':' + s.toFixed(2), kind: 'neon', pos: [m[0], m[1] - 0.1, m[2]], normal: [0, -1, 0], w: +L.toFixed(2), h: 0.12, rgb: [1.0, 0.62, 0.32], nits: 400, omni: 0.8, range: 12 });
          nFest2++;
        }, { margin: 0.5 });
      } }
    facts.overhead = { stations: nSt, lines: nLines, festoons: nFest + nFest2, festoons2: nFest2, bunting: nBunt };
  }
  lap('overhead');
  // ---- [P5-E art #4, fpv #6] the posts: C's lamp posts (walking and club streets: 4.5 m, main roads 8.5 m) and utility poles
  // were flat grey cylinders at 0.3-1 m (w21, roadE). E paints them: a sleeve over the post (charcoal on the walking streets,
  // grey on the roads) in 0.3 m bands where 1-2.4 m carries poster and sticker residue (paper whites, faded yellows, pinks,
  // torn edges), a base collar; utility poles get the anti-flyer sheet (bumpy, 0.9-2.6 m), the yellow-black reflective band and
  // a number plate. Half the walking-street posts hang two vinyl banners (0.45 x 1.3 m, printed both sides, ~10 nits: the
  // post's own light on them). Render only (the posts collide as C built them).
  {
    const R = rng('posts' + seed), paper = [[0.62, 0.6, 0.55], [0.55, 0.5, 0.36], [0.6, 0.42, 0.45], [0.4, 0.42, 0.45], [0.66, 0.64, 0.6], [0.5, 0.2, 0.15], [0.15, 0.25, 0.45]];
    const posts = [];
    for (const e of opts.emitters || []) {
      if (e.kind !== 'street' || !e.pos || String(e.id).startsWith('dress:') || e.role === 'security' || e.role === 'roof') continue;
      const ped = e.role === 'pedestrian', arm = ped ? 0.5 : 1.6, h = e.pos[1] - 0.2;
      // C hangs road heads w/2 - 0.9 m off a main's centre line, ped heads 0.5 m inside a post at w/2 - 0.4 - 0.5 k: the street whose
      // geometry matches that (not merely the nearest: carriageway pairs and junctions) gives the post; none matches, no sleeve
      let best = null; for (const st of M.streets) { if (ped ? st.kind !== 'walking' && st.kind !== 'club' : st.kind !== 'main') continue; const p = M.project(st, e.pos[0], e.pos[2]);
        const fit = ped ? (() => { const k = (st.width / 2 - 0.4 - (p.dist + 0.5)) / 0.5; return k > -0.1 && Math.abs(k - Math.round(k)) < 0.1 ? Math.abs(k - Math.round(k)) : null; })() : (Math.abs(p.dist - (st.width / 2 - 0.9)) < 0.1 ? Math.abs(p.dist - (st.width / 2 - 0.9)) : null);
        if (fit !== null && (!best || p.dist < best.p.dist)) best = { st, p }; }
      if (!best || best.p.dist > best.st.width / 2 + 2) continue;
      let ax = e.pos[0] - best.p.px, az = e.pos[2] - best.p.pz; const al = Math.hypot(ax, az); if (al < 1e-3) continue; ax /= al; az /= al;
      const x = e.pos[0] + ax * arm, z = e.pos[2] + az * arm; if (!inCore(x, z)) continue;
      posts.push({ x, z, h, r: 0.1, ped, away: [ax, az], st: best.st, walk: best.st.kind === 'walking' || best.st.kind === 'club' });
    }
    const sleeve = (x, z, r, y0, y1, base, bands, residue, sides = 8, bump = 0) => {
      const Rp = rng('sleeve' + x.toFixed(2) + ':' + z.toFixed(2)), ys = [y0]; for (const y of [0.9, 1.35, 1.8, 2.4, ...(residue === 2 ? [2.9, 3.4] : [])]) if (y > y0 + 0.05 && y < y1 - 0.05) ys.push(y); ys.push(y1);   // bands: flyers live at 0.9-2.4 m ([P6-E] stickers to 3.4 m on the walking-street posts)
      for (let j = 0; j + 1 < ys.length; j++) for (let k = 0; k < sides; k++) {
        const a0 = (k / sides) * TAU, a1 = ((k + 1) / sides) * TAU, r0 = r + (bump && k % 2 ? bump : 0), r1 = r + (bump && (k + 1) % 2 ? bump : 0), am = (a0 + a1) / 2;
        const yc = (ys[j] + ys[j + 1]) / 2, stick = residue && yc > 0.9 && (yc < 2.5 ? Rp() < 0.4 : yc < 3.45 && Rp() < 0.22);
        set(stick ? 'dr_prop' : 'dr_paint', { c: stick ? paper[Math.floor(Rp() * paper.length)].map((v) => v * (0.7 + Rp() * 0.3)) : base.map((v) => v * (0.9 + Rp() * 0.2)), col: false });
        const rr = stick ? 0.004 : 0;
        quad([x + Math.cos(a0) * (r0 + rr), ys[j], z + Math.sin(a0) * (r0 + rr)], [x + Math.cos(a1) * (r1 + rr), ys[j], z + Math.sin(a1) * (r1 + rr)], [x + Math.cos(a1) * (r1 + rr), ys[j + 1], z + Math.sin(a1) * (r1 + rr)], [x + Math.cos(a0) * (r0 + rr), ys[j + 1], z + Math.sin(a0) * (r0 + rr)], [Math.cos(am), 0, Math.sin(am)]);
      } };
    const BANNERS = [
      { lines: ['홍대 걷고싶은거리', 'HONGDAE'], bg: '#c8102e' }, { lines: ['버스킹 페스티벌', '2026 HONGDAE'], bg: '#f08a00' }, { lines: ['함께하는 마포', 'MAPO-GU'], bg: '#108a9a' },
      { lines: ['홍대 프리마켓', '매주 토요일'], bg: '#7a1ac8' }, { lines: ['인디음악축제', 'INDIE MUSIC'], bg: '#1a1a1a' }, { lines: ['금연구역', 'NO SMOKING'], bg: '#1a5ad0' }];
    let nP = 0, nB = 0;
    for (const p of posts) {
      const base = p.walk ? [0.055, 0.058, 0.062] : [0.26, 0.26, 0.25];
      item(() => { near(() => { sleeve(p.x, p.z, 0.1, 0, p.h - 0.05, base, 0.3, p.walk ? 2 : true); set('dr_paint', { c: base.map((v) => v * 0.8), col: false }); cyl(FW, [p.x, 0.15, p.z], 'y', 0.15, 0.3, 8, 0.12, false); });
        far(() => { set('dr_prop', { c: base, col: false }); cyl(FW, [p.x, (p.h - 0.05) / 2, p.z], 'y', 0.1, p.h - 0.05, 6, 0.1, false); }); nP++; }, { noGate: true });   // [P7-E] past LOD_R: one plain 6-sided band
      if (p.ped && p.walk && R() < 0.55) {
        const d = BANNERS[Math.floor(R() * BANNERS.length)], c = srgb(parseInt(d.bg.slice(1), 16)), [ax, az] = p.away, F = frameH([p.x, 0, p.z], -ax, -az);   // local x toward the street centre
        if (item(() => {
          set('dr_steel', { col: false }); for (const y of [2.62, 3.98]) boxMM(F, 0, y - 0.015, -0.015, 0.56, y + 0.015, 0.015);
          set('dr_prop', { c: c.map((v) => v * 0.6), col: false }); for (const sz of [-1, 1]) quad(W(F, 0.08, 2.64, sz * 0.006), W(F, 0.53, 2.64, sz * 0.006), W(F, 0.53, 3.94, sz * 0.006), W(F, 0.08, 3.94, sz * 0.006), D(F, 0, 0, sz));
          for (const sz of [-1, 1]) labels.push({ id: 'banner:' + p.x.toFixed(2) + ':' + p.z.toFixed(2) + ':' + sz, kind: 'banner', pos: r3(W(F, 0.305, 3.29, sz * 0.008)), normal: r3(D(F, 0, 0, sz)), w: 0.45, h: 1.3, nits: 10, bg: d.bg, lines: d.lines, px: 100 });
        }, { margin: 0.4, corr: 0.6 })) nB++;
      }
    }
    for (const p of opts.poles || []) {
      if (!inCore(p.x, p.z)) continue;
      item(() => { near(() => {
        sleeve(p.x, p.z, 0.18, 0.9, 2.6, [0.42, 0.4, 0.36], 0.34, true, 10, 0.012);                       // the anti-flyer sheet, flyers on it
        const Rp = rng('band' + p.x.toFixed(2) + p.z.toFixed(2));
        for (let j = 0; j < 2; j++) for (let k = 0; k < 10; k++) { const a0 = k / 10 * TAU, a1 = (k + 1) / 10 * TAU, y0 = 0.4 + j * 0.25, yy = y0 + 0.25, sh = (k + j) % 2;   // yellow-black chevrons
          set('dr_prop', { c: sh ? [0.7, 0.5, 0.03] : [0.03, 0.03, 0.03], col: false }); const r = 0.18;
          quad([p.x + Math.cos(a0) * r, y0, p.z + Math.sin(a0) * r], [p.x + Math.cos(a1) * r, y0, p.z + Math.sin(a1) * r], [p.x + Math.cos(a1) * r, yy, p.z + Math.sin(a1) * r], [p.x + Math.cos(a0) * r, yy, p.z + Math.sin(a0) * r], [Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)]); }
        const a = Rp() * TAU, F = frameH([p.x + Math.cos(a) * 0.18, 2.9, p.z + Math.sin(a) * 0.18], -Math.sin(a), Math.cos(a));
        set('dr_prop', { c: [0.7, 0.7, 0.68], col: false }); boxMM(F, -0.07, -0.13, 0, 0.07, 0.13, 0.008); });
        far(() => { set('dr_prop', { c: [0.37, 0.27, 0.03], col: false }); cyl(FW, [p.x, 0.65, p.z], 'y', 0.18, 0.5, 6, 0.18, false); set('dr_prop', { c: [0.42, 0.4, 0.36] }); cyl(FW, [p.x, 1.75, p.z], 'y', 0.185, 1.7, 6, 0.185, false); });
        nP++;
      }, { noGate: true });
    }
    facts.posts = nP; facts.banners = nB;
    // ---- [P7-E lighting #4 / graphics #3] standing water at the post bases: the kerb line round a pole base is the low point,
    // so every utility pole off the main roads and a third of the walking-street lamp posts stand in a puddle (club270's
    // lamp pole: P4's bright wet patch). dr_puddle is a soft-edged decal (uv.x: 1 inside, 0 at the rim) that seoul-light's
    // wet path draws as full standing water (material(): cityPud = uCityWet inside; gone when dry). They are listed in
    // `puddles` ([x, z, tx, tz, a, b]: centre, long axis, half-axes) for G1's walkers, not in `obstacles` (a disc there
    // moves the crowd, and G2's tuned walking-street level with it). Own stream: nothing else moves.
    const Rq = rng('puddle' + seed), puddles = out_puddles, streetOf = new Map(M.streets.map((s) => [s.id, s]));
    const inHole = (x, z) => holes.some((h) => pip(x, z, h));
    const puddle = (cx, cz, tx, tz, a, b) => {
      const N = 10, rad = [...Array(N)].map(() => 0.82 + Rq() * 0.3), y = 0.03;
      const P = (k, f) => { const th = (k % N) / N * TAU, r = rad[k % N] * f, u = Math.cos(th) * a * r, v = Math.sin(th) * b * r; return [cx + tx * u - tz * v, y, cz + tz * u + tx * v]; };
      for (let k = 0; k < N; k++) { const q = P(k, 1); if (M.lotAt(q[0], q[2]) || inHole(q[0], q[2]) || M.ribbonD(q[0], q[2], true) < -0.2) return false; }
      const up = (p, q, r, ua, ub, uc) => { const cy = (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]); if (cy >= 0) tri(p, q, r, ua, ub, uc); else tri(p, r, q, ua, uc, ub); };
      set('dr_puddle', { c: [0.07, 0.066, 0.062], col: false });
      const C0 = [cx, y, cz], I1 = [1, 0], O0 = [0, 0];
      for (let k = 0; k < N; k++) { const i0 = P(k, 0.7), i1 = P(k + 1, 0.7), o0 = P(k, 1), o1 = P(k + 1, 1); up(C0, i0, i1, I1, I1, I1); up(i0, o0, o1, I1, O0, O0); up(i0, o1, i1, I1, O0, I1); }
      puddles.push([+cx.toFixed(2), +cz.toFixed(2), +tx.toFixed(3), +tz.toFixed(3), +a.toFixed(2), +b.toFixed(2)]);
      facts.puddles = (facts.puddles || 0) + 1;
      return true;
    };
    const inward = (x, z, st) => { const p = M.project(st, x, z), dx = p.px - x, dz = p.pz - z, l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
    for (const p of opts.poles || []) {
      const st = streetOf.get(p.street); if (!st || st.kind === 'main' || !inCore(p.x, p.z)) continue;
      const a = 1.8 + Rq() * 0.6, b = 0.75 + Rq() * 0.25, s = (Rq() - 0.5) * 0.3, [ix, iz] = inward(p.x, p.z, st), tl = Math.hypot(p.tx || 1, p.tz || 0), tx = (p.tx || 1) / tl, tz = (p.tz || 0) / tl;
      puddle(p.x + ix * b * 0.55 + tx * s, p.z + iz * b * 0.55 + tz * s, tx, tz, a, b);
    }
    for (const p of posts) {
      if (!p.walk || Rq() > 0.35) continue;
      const a = 0.7 + Rq() * 0.5, b = 0.45 + Rq() * 0.2, [ix, iz] = [-p.away[0], -p.away[1]], tx = -iz, tz = ix;
      puddle(p.x + ix * (0.3 + b * 0.5), p.z + iz * (0.3 + b * 0.5), tx, tz, a, b);
    }
  }
  lap('posts');
  // ---- [P3-E fpv #3] background massing inside the block box where C built nothing (the strip's interior: 118 empty 24 m
  // cells, the "orange dots in a black void" of the high shot). Collidable villas and a few mid-rises on the local grid,
  // drawn by dr_mass: the same procedural facades as beyond()'s ring (uv = metres along the face / height, colour = floorH,
  // seed, H). >= 14 m from C's lots, >= 7 m off the streets, clear of gates and E's dressing.
  {
    const Rm = rng('mass' + seed), Bx = layout.box || layout.core;
    let th = 0, bl = 0; for (const st of mainStreets) for (const g of st.segs) if (st.ko === '양화로' && g.L > bl) { bl = g.L; th = Math.atan2(g.tz, g.tx); }
    const ux = Math.cos(th), uz = Math.sin(th);
    let nM = 0;
    for (let x = Bx.x0 + 8; x < Bx.x1 - 8; x += 13) for (let z = Bx.z0 + 8; z < Bx.z1 - 8; z += 13) {
      const px = x + (Rm() - 0.5) * 3, pz = z + (Rm() - 0.5) * 3, hw = 4.2 + Rm() * 2.2, hd = 4.2 + Rm() * 2.4, r = Math.hypot(hw, hd);
      if (!M.lotClear(px, pz, r + 8) || M.ribbonD(px, pz) < r + 4 || !occFree(px, pz, r)) continue;
      const nearMain = M.ribbonD(px, pz, true) < 40, floors = nearMain && Rm() < 0.35 ? 7 + Math.floor(Rm() * 8) : 3 + Math.floor(Rm() * 4), fh = 3.0 + Rm() * 0.3, H = floors * fh;
      const F = { o: [px, 0, pz], x: [ux, 0, uz], y: [0, 1, 0], z: [-uz, 0, ux] }, sd = Rm();
      item(() => {
        set('dr_mass', { c: [fh, sd, H] });
        const cn = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([a, b]) => W(F, a, 0, b));
        let u0 = sd * 7;
        for (let k = 0; k < 4; k++) { const a = cn[k], b = cn[(k + 1) % 4], L = Math.hypot(b[0] - a[0], b[2] - a[2]), out = v3.norm([b[2] - a[2], 0, -(b[0] - a[0])]);
          const o2 = v3.dot(out, [a[0] - px, 0, a[2] - pz]) > 0 ? out : v3.mul(out, -1);
          quad(a, b, [b[0], H, b[2]], [a[0], H, a[2]], o2, [[u0, 0], [u0 + L, 0], [u0 + L, H], [u0, H]]); u0 += L; }
        // [P4-E art #6] lit roofs in the block's interior: a stair house (옥탑, 3 x 2.6 x 3.2 m) on 70 % of the villas, its door
        // lit, a 900 lm wall pack over it whose pool the roof shades (roof uv = metres from the lamp; 1e3 = no lamp); its
        // walls are the same shader (kind 3 from H < 3.2 m: one window, lit on half). Own stream per villa: placement stays put.
        const Rr = rng('mroof' + px.toFixed(2) + ':' + pz.toFixed(2)), stair = H < 24 && Rr() < 0.7;
        let lamp = [1e3, 1e3];
        if (stair) {
          const sx = (Rr() < 0.5 ? -1 : 1) * (hw - 2.0), sz = (Rr() < 0.5 ? -1 : 1) * (hd - 2.1), o = W(F, sx, H, sz), G = { o, x: F.x, y: F.y, z: F.z }, sd2 = Rr();
          const dz = -Math.sign(sz) * 1.6, dp = W(G, 0, 2.3, dz + Math.sign(dz) * 0.12); lamp = [dp[0], dp[2]];
          set('dr_mass', { c: [2.6, sd2, 2.6] });
          const rc = [[-1.5, -1.6], [1.5, -1.6], [1.5, 1.6], [-1.5, 1.6]].map(([a, b]) => W(G, a, 0, b));
          let v0 = sd2 * 5;
          for (let k = 0; k < 4; k++) { const a = rc[k], b = rc[(k + 1) % 4], L = Math.hypot(b[0] - a[0], b[2] - a[2]), out = v3.norm([b[2] - a[2], 0, -(b[0] - a[0])]);
            const o2 = v3.dot(out, [a[0] - o[0], 0, a[2] - o[2]]) > 0 ? out : v3.mul(out, -1);
            quad(a, b, [b[0], H + 2.6, b[2]], [a[0], H + 2.6, a[2]], o2, [[v0, 0], [v0 + L, 0], [v0 + L, 2.6], [v0, 2.6]]); v0 += L; }
          quad(...rc.map((q) => [q[0], H + 2.6, q[2]]), [0, 1, 0], rc.map((q) => [q[0] - lamp[0], q[2] - lamp[1]]));
          const nD = D(G, 0, 0, Math.sign(dz));
          set('dr_glow', { em: NI([1.0, 0.8, 0.58], 14), col: false });                                     // the lit door (glass, a stair light behind)
          quad(W(G, -0.45, 0.02, dz + Math.sign(dz) * 0.01), W(G, 0.45, 0.02, dz + Math.sign(dz) * 0.01), W(G, 0.45, 2.05, dz + Math.sign(dz) * 0.01), W(G, -0.45, 2.05, dz + Math.sign(dz) * 0.01), nD);
          set('dr_glow', { em: NI([1.0, 0.78, 0.52], 9000), col: false });                                 // the wall pack's lens (900 lm / pi / 0.022 m2)
          boxMM(G, -0.11, 2.26, dz + Math.sign(dz) * 0.02 - 0.05, 0.11, 2.34, dz + Math.sign(dz) * 0.02 + 0.05);
          facts.massRoofs = (facts.massRoofs || 0) + 1;
        }
        set('dr_mass', { c: [fh, sd, H] });
        quad(...cn.map((q) => [q[0], H, q[2]]), [0, 1, 0], cn.map((q) => [q[0] - lamp[0], q[2] - lamp[1]]));
        occAdd(px, pz, r); nM++;
      }, { margin: 0.5 });
    }
    facts.massing = nM;
  }
  lap('massing');
  // ================================================================================================ output
  const merged = {}; let tris = 0;
  for (const [k, a] of Object.entries(acc)) { const g = a.geometry(); if (g) { merged[k] = g; tris += g.getAttribute('position').count / 3; } }
  const colTris = new THREE.BufferGeometry(); colTris.setAttribute('position', new THREE.BufferAttribute(col.out(), 3)); colTris.computeBoundingBox();
  facts.tris = tris; facts.colTris = col.length / 9; facts.emitters = emitters.length; facts.holes = holes.length; facts.cables = cables.length; facts.labels = labels.length; facts.lamps = lamps.length; facts.setPieces = setPieces.map((s) => s.id); facts.ms = Date.now() - t0; facts.msParts = msParts; facts.triParts = triParts;
  // ground footprints of what E placed (discs x, z, r): for G's crowd to walk around
  const obstacles = []; for (const v of occ.values()) for (const d of v) if (d[2] > 0.2) obstacles.push([+d[0].toFixed(2), +d[1].toFixed(2), +d[2].toFixed(2)]);
  // [P5-D] perf #1 (the heap): the gate-tracking push is a closure over this whole function's context (acc, col: ~75 MB
  // of build buffers), and world.setPieces outlives the build: back to Array.prototype.push. The cache keeps the data
  // build() and exportData() read, not the render / collider geometry (world-seoul has merged it by then: ~36 MB).
  delete setPieces.push;
  const out = { merged, colTris, emitters, setPieces, holes, cables, labels, lamps, obstacles, anchors, puddles: out_puddles, facts, materials: DRESS_MATS };
  CACHE.set(layout, slimOut(out));
  return out;
}

// ================================================================================================================
// [P3-E fpv #3] beyond(layout, opts) — the city past the modelled block (pure CPU, deterministic, node-safe): a 2.5 km impostor
// ring of Mapo-gu outside C's ground (box + 85 m). Roads on the local grid (Yanghwa-ro's bearing) and the modelled main roads
// carried on to the horizon, lamp chains on all of them (LED 4000 K on the arterials, warm on the alleys), car light streams
// on the arterials (white toward the camera, red away), low-rise villas with towers along the arterials, Hapjeong's towers,
// Sinchon to the east, the Han to the south with the Gangbyeon expressway on its bank and two bridges, red church crosses,
// tower beacons. Walls 0.5-2 nits with procedural windows (12-25 % lit, 5-25 nits) and ground-floor sign bands; all of it
// non-colliding, past the flight bounds (box + 60). Returns typed arrays (also for H's export) and facts.
// ================================================================================================================
// [P3-E fpv #3] shared by the ring's buildings and the in-block massing (dr_mass).
// [P4-E art #6 / fpv #4 / lighting bug] the ring was self-lit: walls 0.5-2 nits, 13-25 % of windows lit at random (a starfield
// up close, a flat grey block at the horizon: (89, 85, 79), 4-8x the near facades). Now: walls 0.05-0.15 nits (sky glow and
// city bounce, x a villa / tower tint), street spill on the lowest floors only; windows lit by UNIT (villas 2 bays, apartments
// 3, offices and shop buildings the whole floor) in three colour temperatures (2700 / 4000 / 6500 K, a few TVs), 18-26 % of
// residential windows and 11 % of office floors at 1 am; apartment corridors (north faces) and brand crowns, villa pilotis
// lights, closed shutters on half the shops; dark glass 0.035 nits. Far LOD in two steps: a window under ~1/2 px takes its
// cell's mean (lit cells stay dots), a cell under ~1 px the row's mean. Roofs: green paint or concrete at 0.5-1.1 lux, and the
// pool of a 900 lm wall pack over the stair-house door (uv = metres from the lamp). Haze toward the sky's own horizon
// radiance (RING_U.uHaze, copied from seoul-light's sky at runtime), so the ring sinks into the skyglow with distance.
const BEYOND_HZ = `uniform vec3 uHaze; uniform float uHazeD; uniform float uNits; uniform float uTime;
float h1(vec2 p){ p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
vec3 haze(vec3 c, float d){ return mix(c, uHaze, 1.0 - exp(-d / uHazeD)); }`;
// the far-LOD means, also used by tests/seoul-dressing.mjs (ringMean) to hold the ring's luminance budget
export const RING_LOOK = {
  wall: [0.07, 0.16], spill: { villa: 0.35, comm: 0.6, tower: 0.25 }, unlit: 0.035,
  villa: { A: 0.26, p: 0.3 * 0.62, nits: 5.25 }, apt: { A: 0.588, p: 0.22 * 0.62, nits: 6.5 }, office: { A: 0.594, p: 0.1 * 0.88, nits: 11 }, comm: { A: 0.488, p: 0.13 * 0.88, nits: 10 },
  hazeD: 1600, horizon: [0.5, 0.32, 0.18], hazeK: 0.85,
};
const RL = RING_LOOK, gf = (v) => v.toFixed(4);
const BEYOND_BLD_FS = `
varying vec2 vUV; varying vec4 vB; varying vec3 vN; varying vec3 vW;
vec3 cctC(float t){ return t < 0.5 ? vec3(1.0, 0.64, 0.36) : t < 0.82 ? vec3(1.0, 0.85, 0.68) : vec3(0.84, 0.92, 1.0); }   // 2700 / 4000 / 6500 K
void main(){
  float fh = vB.x, kind = vB.y, sd = vB.z, H = vB.w;
  float tower = step(1.5, kind) * step(kind, 2.5), comm = step(0.5, kind) * step(kind, 1.5), room = step(2.5, kind), villa = clamp(1.0 - tower - comm - room, 0.0, 1.0);
  float apt = tower * step(h1(vec2(sd * 7.7, 2.0)), 0.55), office = tower - apt, work = clamp(office + comm, 0.0, 1.0);
  float ts = h1(vec2(sd * 23.0, 5.0));
  vec3 tint = ts < 0.42 ? vec3(0.70, 0.44, 0.34) : ts < 0.72 ? vec3(0.86, 0.80, 0.68) : ts < 0.9 ? vec3(0.66, 0.66, 0.64) : vec3(0.92, 0.91, 0.88);   // brick, beige tile, grey, white
  if (tower > 0.5) tint = apt > 0.5 ? vec3(0.88, 0.86, 0.80) : vec3(0.46, 0.50, 0.55);
  vec3 c;
  if (vN.y > 0.5) {
    float rs = h1(vec2(sd * 91.0, 3.0));
    vec3 rc = (villa + room > 0.5 && rs < 0.6) ? vec3(0.30, 0.50, 0.36) : vec3(0.52, 0.51, 0.48);   // green waterproof paint (villas), concrete
    float E = 0.5 + 0.6 * h1(vec2(sd * 13.0, 9.0)) + 1518.0 / pow(dot(vUV, vUV) + 5.29, 1.5);   // lux: skyglow + the wall pack's pool (290 cd, 2.3 m up)
    c = rc * 0.3 * E / 3.14159;
  } else {
    float amb = ${gf(RL.wall[0])} + ${gf(RL.wall[1] - RL.wall[0])} * h1(vec2(sd * 13.0, 7.0));
    float spill = room > 0.5 ? 0.0 : (tower > 0.5 ? ${gf(RL.spill.tower)} : comm > 0.5 ? ${gf(RL.spill.comm)} : ${gf(RL.spill.villa)}) * exp(-vUV.y / 5.0);
    vec3 wallC = tint * (amb + spill);
    float bay = office > 0.5 ? 1.5 + 0.5 * h1(vec2(sd * 17.0, 1.0)) : apt > 0.5 ? 2.9 : room > 0.5 ? 3.0 : 2.6 + 1.2 * h1(vec2(sd * 17.0, 1.0));
    vec2 g = vec2(vUV.x / bay, vUV.y / fh), cell = floor(g), f = fract(g), fw = fwidth(g);
    float north = step(vN.z, -0.5), south = step(0.5, vN.z), face = floor(atan(vN.z, vN.x) * 0.6366 + 2.5);
    vec4 wr = office > 0.5 ? vec4(0.05, 0.95, 0.2, 0.86) : apt > 0.5 ? vec4(0.08, 0.92, 0.14, 0.84) : comm > 0.5 ? vec4(0.1, 0.9, 0.25, 0.86) : vec4(0.24, 0.76, 0.32, 0.82);
    vec2 unit = vec2(floor(cell.x / (work > 0.5 ? 64.0 : apt > 0.5 ? 3.0 : 2.0)), cell.y);
    float pU = office > 0.5 ? ${gf(RL.office.p / 0.88)} : comm > 0.5 ? ${gf(RL.comm.p / 0.88)} : apt > 0.5 ? ${gf(RL.apt.p / 0.62)} : ${gf(RL.villa.p / 0.62)}, pW = work > 0.5 ? 0.88 : 0.62;
    float ru = h1(unit * vec2(1.37, 2.71) + sd * vec2(31.7, 17.3) + face * 7.1), rw = h1(cell * vec2(0.93, 1.71) + sd * vec2(5.1, 9.3) + face * 3.3);
    float tc = h1(unit * 3.3 + sd * 7.0 + face), sB = apt * south > 0.5 ? 1.4 : 1.0;
    vec3 lc = work > 0.5 ? (tc < 0.6 ? vec3(0.86, 0.93, 1.0) : vec3(1.0, 0.9, 0.78)) : cctC(tc);
    float ln = office > 0.5 ? 7.0 + 8.0 * h1(unit + 4.0) : comm > 0.5 ? 8.0 + 4.0 * h1(unit + 4.0) : (2.5 + 5.5 * h1(cell * 2.3 + sd * 3.1)) * sB;
    float on = step(ru, pU) * step(rw, pW);
    vec3 unlit = vec3(0.8, 0.85, 1.0) * ${gf(RL.unlit)};
    vec3 wc = mix(unlit, lc * ln, on);
    if (on > 0.5 && work < 0.5 && h1(unit + sd * 11.0) < 0.05) wc = vec3(0.55, 0.7, 1.0) * ln * (0.7 + 0.3 * sin(uTime * 6.0 + ru * 40.0));   // a TV
    vec3 rowMean = mix(unlit, work > 0.5 ? vec3(0.92) * (office > 0.5 ? ${gf(RL.office.nits)} : ${gf(RL.comm.nits)}) : vec3(0.95, 0.8, 0.62) * (apt > 0.5 ? ${gf(RL.apt.nits)} : ${gf(RL.villa.nits)}) * sB, pU * pW);
    float A0 = (wr.y - wr.x) * (wr.w - wr.z);
    if (room > 0.5) {                                                                                         // rooftop room: one window, lit on half
      wr = mod(cell.x, 2.0) < 0.5 ? vec4(0.3, 0.7, 0.3, 0.75) : vec4(0.0); wc = mix(unlit, cctC(h1(vec2(sd, 4.0)) * 0.8) * 9.0, step(h1(vec2(sd * 3.7, face)), 0.5));
    } else if (cell.y < 0.5) {                                                                                // ground floor
      float s = h1(cell + sd * 5.0), open = step(h1(cell * 0.7 + sd * 2.0), 0.5);
      if (comm > 0.5) { wr = vec4(0.06, 0.94, 0.08, 0.92);
        wc = mix(tint * 0.25, (s < 0.32 ? vec3(1.0, 0.36, 0.12) : s < 0.58 ? vec3(1.0, 0.78, 0.42) : s < 0.74 ? vec3(1.0, 0.95, 0.88) : s < 0.84 ? vec3(0.95, 0.2, 0.22) : s < 0.93 ? vec3(0.3, 0.75, 1.0) : vec3(1.0, 0.3, 0.75)) * (20.0 + 25.0 * h1(cell * 3.0 + sd)), open); }
      else if (tower > 0.5) { wr = vec4(0.04, 0.96, 0.06, 0.94); wc = mix(unlit, vec3(1.0, 0.86, 0.68) * (office > 0.5 ? 30.0 : 14.0), step(s, office > 0.5 ? 0.5 : 0.3)); }
      else { wr = vec4(0.02, 0.98, 0.0, 0.86); wc = mix(tint * 0.06, vec3(0.86, 0.93, 1.0) * 5.0, step(h1(vec2(sd * 4.1, face)), 0.35)); }   // pilotis parking, a tube on 35 %
    } else if (comm > 0.5 && cell.y < 2.5 && h1(vec2(cell.x, sd)) < 0.3) {                                  // 2F-3F fascia signs
      float s = h1(cell * 1.3 + sd); wc = (s < 0.5 ? vec3(1.0, 0.55, 0.2) : s < 0.78 ? vec3(1.0, 0.95, 0.85) : vec3(0.95, 0.25, 0.3)) * (20.0 + 15.0 * s); wr = vec4(0.04, 0.96, 0.2, 0.8);
    } else if (apt > 0.5 && north > 0.5 && h1(vec2(sd * 5.5, 3.0)) < 0.5) {                                 // corridor-type (복도식): a lit band per floor
      wr = vec4(0.0, 1.0, 0.58, 0.9); wc = vec3(0.86, 0.93, 1.0) * (5.0 + 3.0 * h1(vec2(sd, cell.y))) * step(h1(vec2(cell.y, sd * 9.0)), 0.85);
    } else if (apt > 0.5 && vUV.y > H - fh * 1.6 && vUV.y < H - 0.9 && abs(vN.x) > 0.5 && h1(vec2(sd * 2.9, 6.0)) < 0.6) {   // the brand crown
      wr = vec4(0.1, 0.9, 0.1, 0.9); wc = (h1(vec2(sd, 8.0)) < 0.5 ? vec3(1.0, 0.97, 0.92) : vec3(0.3, 0.6, 1.0)) * 30.0 * step(0.35, h1(vec2(cell.x * 0.37, sd)));
    }
    if (vUV.y > H - 0.9) wr = vec4(0.0);                                                                       // parapet
    float A = (wr.y - wr.x) * (wr.w - wr.z);
    vec2 aa = fw * 1.5 + 1e-4;
    float win = smoothstep(wr.x, wr.x + aa.x, f.x) * (1.0 - smoothstep(wr.y - aa.x, wr.y, f.x)) * smoothstep(wr.z, wr.z + aa.y, f.y) * (1.0 - smoothstep(wr.w - aa.y, wr.w, f.y)) * step(1e-4, A);
    vec3 det = mix(wallC, wc, win), cellC = mix(wallC, wc, A), far = mix(tint * amb, rowMean, room > 0.5 ? 0.0 : A0);
    float px = max(fw.x, fw.y);
    c = mix(det, cellC, smoothstep(0.25, 0.6, px));
    c = mix(c, far, smoothstep(0.75, 1.5, px));
  }
  gl_FragColor = vec4(haze(c, length(vW - cameraPosition)) * uNits, 1.0);
}`;
// one uniform set for every ring material and dr_mass (build() keeps uHaze on the sky's horizon and uTime on the take clock)
const RING_U = { uNits: { value: NITS }, uHaze: { value: new THREE.Vector3(...RL.horizon).multiplyScalar(RL.hazeK) }, uHazeD: { value: RL.hazeD }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1280, 720) } };
// the facade's far-LOD mean luminance (nits) for a building record, before haze (mirrors BEYOND_BLD_FS's `far` term)
export function ringMean(kind, H, apt = false) {
  const amb = (RL.wall[0] + RL.wall[1]) / 2, tint = kind === 2 ? (apt ? 0.86 : 0.5) : 0.75, k = kind === 2 ? (apt ? RL.apt : RL.office) : kind === 1 ? RL.comm : RL.villa;
  const lit = k.p * k.nits * (kind === 2 && !apt || kind === 1 ? 0.92 : 0.82) + (1 - k.p) * RL.unlit;
  return tint * amb * (1 - k.A) + lit * k.A;
}
const BEYOND_CACHE = new WeakMap();
export function beyond(layout, opts = {}) {
  const dens = clamp(opts.density ?? 1, 0.25, 2), key = layout;
  if (BEYOND_CACHE.has(key) && (BEYOND_CACHE.get(key).dens === dens)) return BEYOND_CACHE.get(key).out;
  const R = rng('beyond' + (opts.seed ?? 11)), B = layout.box || layout.core, PAD = 85, RMAX = opts.rmax ?? 2500;
  const cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2;
  const outside = (x, z, m = 0) => x < B.x0 - PAD - m || x > B.x1 + PAD + m || z < B.z0 - PAD - m || z > B.z1 + PAD + m;
  const inR = (x, z) => Math.hypot(x - cx, z - cz) < RMAX;
  // the Han's north bank (layout metres, from lat/lon: Mangwon park, Yanghwa / Seogang / Mapo bridge heads)
  const BANK = [[-3200, -900], [-2600, -500], [-2460, -220], [-2100, 350], [-1700, 900], [-1570, 1117], [-1200, 1330], [-600, 1250], [0, 1150], [670, 1084], [1300, 1250], [2040, 1515], [3200, 1800]];
  const bankZ = (x) => { for (let i = 0; i < BANK.length - 1; i++) { const [ax, az] = BANK[i], [bx, bz] = BANK[i + 1]; if (x >= ax && x <= bx) return az + (bz - az) * (x - ax) / (bx - ax); } return 1e9; };
  const river = (x, z, m = 0) => z > bankZ(x) - m;
  // grid bearing: Yanghwa-ro's longest piece
  let th = -43 * Math.PI / 180, best = 0;
  for (const st of layout.streets) if (st.kind === 'main' && st.ko === '양화로') for (let i = 0; i + 1 < st.points.length; i++) { const [ax, az] = st.points[i], [bx, bz] = st.points[i + 1], l = Math.hypot(bx - ax, bz - az); if (l > best) { best = l; th = Math.atan2(bz - az, bx - ax); } }
  const ux = Math.cos(th), uz = Math.sin(th), vx = -uz, vz = ux;   // grid axes
  // ---- roads: [ax, az, bx, bz, halfWidth, kind (0 arterial, 1 street, 2 expressway, 3 bridge)]
  const roads = [];
  const addClipped = (ax, az, bx, bz, hw, kind, keep = (x, z) => outside(x, z) && inR(x, z) && !river(x, z, hw + 4)) => {
    const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 20)); let run = null;
    for (let i = 0; i <= n; i++) { const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t, k = keep(x, z);
      if (k && !run) run = [x, z]; if ((!k || i === n) && run) { const ex = k ? x : ax + (bx - ax) * (i - 1) / n, ez = k ? z : az + (bz - az) * (i - 1) / n; if (Math.hypot(ex - run[0], ez - run[1]) > 30) roads.push([run[0], run[1], ex, ez, hw, kind]); run = null; } }
  };
  // the modelled main roads, carried on from where they leave the block. [P4-E fpv bug] no longer dead straight for 3 km: a
  // bend of 4-12 deg every 260-420 m (Yanghwa-ro swings west at Hapjeong, Sinchon-ro east), so 150 lamps and the car streams
  // don't stack on one vanishing point (the white "fountain" at the end of the street in the horizon still)
  const Rb = rng('beyondBend' + (opts.seed ?? 11));
  for (const st of layout.streets) {
    if (st.kind !== 'main') continue;
    for (const end of [0, 1]) {
      const P = st.points, a = end ? P[P.length - 2] : P[1], b = end ? P[P.length - 1] : P[0], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      if (!(b[0] < B.x0 + 5 || b[0] > B.x1 - 5 || b[1] < B.z0 + 5 || b[1] > B.z1 - 5)) continue;   // ends inside the block
      let x = b[0], z = b[1], ang = Math.atan2(b[1] - a[1], b[0] - a[0]), run = 0, turn = Rb() < 0.5 ? -1 : 1;
      while (run < RMAX * 1.2) { const seg = 260 + Rb() * 160, nx = x + Math.cos(ang) * seg, nz = z + Math.sin(ang) * seg;
        addClipped(x, z, nx, nz, Math.max(6, st.width * 0.6), 0); x = nx; z = nz; run += seg; if (Rb() < 0.3) turn = -turn; ang += turn * (4 + Rb() * 8) * Math.PI / 180; }
    }
  }
  // the local grid: arterials ~380 m, streets ~95 m (some broken: Mapo's grid is not a lattice)
  const span = RMAX * 1.3;
  for (const [ax, az, bxn, bzn] of [[ux, uz, vx, vz], [vx, vz, ux, uz]]) {
    for (let o = -span; o <= span; o += 95 + (R() - 0.5) * 30) {
      const art = Math.abs(((o / 380) % 1 + 1) % 1 - 0.5) > 0.38, ox = cx + bxn * o, oz = cz + bzn * o;
      if (art) addClipped(ox - ax * span, oz - az * span, ox + ax * span, oz + az * span, 7 + R() * 4, 0);
      else for (let s0 = -span; s0 < span; s0 += 180 + R() * 260) { if (R() < 0.22 / dens) continue; const s1 = s0 + 120 + R() * 240; addClipped(ox + ax * s0, oz + az * s0, ox + ax * s1, oz + az * s1, 3 + R() * 1.5, 1); }
    }
  }
  // Gangbyeon-buk-ro on the bank, two bridges over the river
  for (let i = 0; i + 1 < BANK.length; i++) { const [ax, az] = BANK[i], [bx, bz] = BANK[i + 1]; addClipped(ax, az - 25, bx, bz - 25, 12, 2, (x, z) => outside(x, z) && inR(x, z)); }
  for (const [ax, az, bx, bz] of [[-1572, 1117, -1720, 2400], [671, 1084, 380, 2400]]) addClipped(ax, az, bx, bz, 13, 3, (x, z) => inR(x, z));
  // road index (60 m cells)
  const RC = 60, rg = new Map(), rk = (i, j) => i * 73856 + j;
  roads.forEach((r, ri) => { const x0 = Math.min(r[0], r[2]) - 20, x1 = Math.max(r[0], r[2]) + 20, z0 = Math.min(r[1], r[3]) - 20, z1 = Math.max(r[1], r[3]) + 20;
    for (let i = Math.floor(x0 / RC); i <= Math.floor(x1 / RC); i++) for (let j = Math.floor(z0 / RC); j <= Math.floor(z1 / RC); j++) { const k = rk(i, j); if (!rg.has(k)) rg.set(k, []); rg.get(k).push(ri); } });
  const roadD = (x, z, kinds = null) => { let d = 1e9, w = 0, kk = -1; for (const ri of rg.get(rk(Math.floor(x / RC), Math.floor(z / RC))) || []) { const r = roads[ri]; if (kinds && !kinds.includes(r[5])) continue; const q = segD(x, z, r[0], r[1], r[2], r[3]) - r[4]; if (q < d) { d = q; w = r[4]; kk = r[5]; } } return { d, w, kind: kk }; };
  // ---- buildings: [x, z, hw, hd, yaw, H, floorH, kind (0 villa, 1 commercial frontage, 2 tower/office), seed]
  const bld = [], LAND = [[-773, 410, 3, 38, 'Mecenatpolis'], [-700, 470, 2, 30], [1280, -221, 4, 20], [1350, -150, 3, 24], [274, 320, 3, 12], [-1150, 760, 2, 25], [900, 700, 2, 22]];
  const put = (x, z, hw, hd, yaw, floors, kind, fh = 3.2) => { bld.push(x, z, hw, hd, yaw, floors * fh, fh, kind, R()); };
  for (const [lx, lz, n, fl] of LAND) for (let k = 0; k < n; k++) { const x = lx + (R() - 0.5) * 90, z = lz + (R() - 0.5) * 90; if (outside(x, z, 30) && !river(x, z, 40) && roadD(x, z).d > 14) put(x, z, 14 + R() * 8, 12 + R() * 8, th, Math.round(fl * (0.8 + R() * 0.3)), 2, 3.5); }
  for (let gi = -RMAX; gi <= RMAX; gi += 26) for (let gj = -RMAX; gj <= RMAX; gj += 26) {
    const far = Math.hypot(gi, gj); if (far > RMAX) continue;
    const step = far > 1300 ? 2 : 1; if (step > 1 && ((Math.round(gi / 26) & 1) || (Math.round(gj / 26) & 1))) continue;   // past 1.3 km, blocks twice the size
    if (R() > 0.86 * dens) continue;
    const x = cx + ux * gi + vx * gj + (R() - 0.5) * 6, z = cz + uz * gi + vz * gj + (R() - 0.5) * 6;
    if (!outside(x, z, 6) || river(x, z, 30)) continue;
    const size = 26 * step, rd = roadD(x, z), hw = (size * (0.36 + R() * 0.12)), hd = (size * (0.34 + R() * 0.14));
    if (rd.d < Math.max(hw, hd) * 0.75 + 2) continue;
    const onArt = rd.kind === 0 && rd.d < size, east = Math.min(1, Math.max(0, (x - 700) / 900)), hap = Math.exp(-Math.hypot(x + 500, z - 500) / 500);
    const tower = R() < (onArt ? 0.14 : 0.025) + 0.12 * east + 0.15 * hap;
    const floors = tower ? 12 + Math.floor(R() * 18 + 10 * east) : onArt ? 4 + Math.floor(R() * 7) : 3 + Math.floor(R() * 3.2);
    put(x, z, hw, hd, th + (R() - 0.5) * 0.06, floors, tower ? 2 : onArt ? 1 : 0, tower ? 3.4 : 3.0);
  }
  // ---- lamps [x, y, z, r, g, b, cd]  (cd toward the viewer; a 1-2 px sprite in the renderer; the renderer applies the
  // cut-off optics). [P4-E] roadLamps [phase, spacing] per road: the ground shader draws each lamp's pool on the road
  const lamps = [], LED = [1.0, 0.9, 0.78], WARM = [1.0, 0.72, 0.42], roadLamps = [];
  for (const r of roads) {
    const L = Math.hypot(r[2] - r[0], r[3] - r[1]), dx = (r[2] - r[0]) / L, dz = (r[3] - r[1]) / L, art = r[5] !== 1, sp = art ? 32 : 26, y = art ? 9 : 6.5, ph = R() * sp;
    roadLamps.push(ph, sp);
    for (let s0 = ph; s0 < L; s0 += sp) for (const sd of art ? [-1, 1] : [R() < 0.5 ? -1 : 1]) {
      const x = r[0] + dx * s0 - dz * sd * (r[4] + 0.5), z = r[1] + dz * s0 + dx * sd * (r[4] + 0.5); if (art || R() < 0.75) lamps.push(x, y, z, ...(art ? LED : WARM), art ? 1400 : 500);
      if (r[5] === 3) lamps.push(x, -2 * 6 - y, z, ...LED, 260);   // bridge lamps mirrored in the river
    }
  }
  // ---- car streams: [ax, y, az, dx, dz, L, phase, speed]. [P4-E fpv #4] on every road (phase 3: arterials only): the
  // arterials every 55 m per direction, the expressway 28 m, the local streets one car per ~150 m at 5-8 m/s
  const cars = [], Rc = rng('beyondCars' + (opts.seed ?? 11));
  for (const r of roads) { const L = Math.hypot(r[2] - r[0], r[3] - r[1]), dx = (r[2] - r[0]) / L, dz = (r[3] - r[1]) / L, loc = r[5] === 1;
    const nPer = loc ? Math.round(L / 150 * dens + Rc() * 0.8) : Math.max(1, Math.round(L / (r[5] === 2 ? 28 : 55) * dens));
    for (const sd of [-1, 1]) for (let k = 0; k < nPer; k++) { const off = sd * r[4] * 0.45, ax = sd > 0 ? r[0] : r[2], az = sd > 0 ? r[1] : r[3]; cars.push(ax - dz * off, 0.75, az + dx * off, dx * sd, dz * sd, L, Rc() * L, loc ? 5 + Rc() * 3 : (r[5] === 2 ? 17 : 9) + Rc() * 5); } }
  // ---- red church crosses on low roofs, tower beacons, [P4-E art #6] rooftop wall packs: [x, y, z, kind (0 cross, 1 beacon,
  // 2 roof lamp), phase]. roofLamp [x, z] per building (1e5: none): the building shader draws its pool on the roof.
  const marks = [], roofLamp = new Float32Array(bld.length / 9 * 2).fill(1e5), Rr = rng('beyondRoofs' + (opts.seed ?? 11));
  for (let i = 0; i < bld.length; i += 9) { const k = bld[i + 7], H = bld[i + 5];
    if (k === 0 && R() < 0.022) marks.push(bld[i], H + 3.2, bld[i + 1], 0, R());
    if (k === 2 && H > 55) marks.push(bld[i], H + 1.5, bld[i + 1], 1, R());
    if (k < 2 && Rr() < 0.45) { const hw = bld[i + 2], hd = bld[i + 3], yw = bld[i + 4], a = (Rr() < 0.5 ? -1 : 1) * hw * 0.55, c2 = (Rr() < 0.5 ? -1 : 1) * hd * 0.5;
      const x = bld[i] + Math.cos(yw) * a - Math.sin(yw) * c2, z = bld[i + 1] + Math.sin(yw) * a + Math.cos(yw) * c2;
      marks.push(x, H + 2.3, z, 2, Rr()); roofLamp[i / 9 * 2] = x; roofLamp[i / 9 * 2 + 1] = z; } }
  const out = { version: 2, bearing: th, rmax: RMAX, pad: PAD, bank: BANK, roads: new Float32Array(roads.flat()), roadLamps: new Float32Array(roadLamps), buildings: new Float32Array(bld), lamps: new Float32Array(lamps), cars: new Float32Array(cars), marks: new Float32Array(marks), roofLamp,
    look: RING_LOOK,
    facts: { roads: roads.length, buildings: bld.length / 9, lamps: lamps.length / 7, cars: cars.length / 8, crosses: marks.filter((_, i) => i % 5 === 3).filter((v) => v === 0).length, roofLamps: marks.filter((_, i) => i % 5 === 3).filter((v) => v === 2).length } };
  BEYOND_CACHE.set(key, { dens, out });
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
  const geo = slimOut(ctx.dressing || CACHE.get(layout) || geometry(layout, { seed: ctx.seed ?? 11, poles: ctx.poles, lotInfo: ctx.lotInfo, lines: ctx.lines }));   // [P5-D] the closures below keep it
  if (ctx.dressing) ctx.dressing = geo;   // [P5-D] ...and ctx (world-seoul's own copy): not the merged meshes and colTris (~36 MB)
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
    // [P5-E] L.px (pixels per metre) overrides 160; labels that print the same thing share one atlas cell (banners, standing
    // signs and cart menus repeat a few designs: the atlas stays at phase 4's size)
    const PX = 160, cells = geo.labels.map((L) => { const k = (L.px || PX) * (L.kind === 'exitnum' ? 1.5 : 1); return { L, w: Math.max(32, Math.round(L.w * k)), h: Math.max(24, Math.round(L.h * k)), key: /^(banner|standsign|menu)$/.test(L.kind) ? [L.kind, L.w, L.h, L.bg, L.ink, ...(L.lines || [])].join('|') : null }; });
    const AW = 2048; let x = 0, y = 0, rowH = 0; const shared = new Map();
    for (const c of cells) { const s0 = c.key && shared.get(c.key); if (s0) { c.x = s0.x; c.y = s0.y; c.dup = true; continue; } if (c.key) shared.set(c.key, c);
      if (x + c.w > AW) { x = 0; y += rowH + 2; rowH = 0; } c.x = x; c.y = y; x += c.w + 2; rowH = Math.max(rowH, c.h); }
    const AH = Math.min(4096, THREE.MathUtils.ceilPowerOfTwo(y + rowH + 2));
    const cv = document.createElement('canvas'); cv.width = AW; cv.height = AH; const g2 = cv.getContext('2d');
    g2.clearRect(0, 0, AW, AH);
    for (const c of cells) if (!c.dup) paintLabel(g2, c, fam);
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

  // ---- 4. [P3-E fpv #3] the city beyond the block: beyond() as three draws (ground + roads + river, buildings, light points)
  // [P4-E fpv #4] one uniform set (RING_U, shared with dr_mass): uHaze follows the sky's horizon radiance (update()), roads
  // carry their lamps' pools, street lamps and head lamps have cut-off optics (seen from above they drop to ~7-10 %),
  // rooftop wall packs, cars on every road.
  let beyondU = null; const beyondStats = {};
  if (ctx.beyond !== false) {
    const BY = beyond(layout, { seed: ctx.seed ?? 11, density: ctx.quality === 'low' ? 0.6 : 1 });
    RING_U.uNits.value = nit; beyondU = RING_U;
    const HZ = BEYOND_HZ;
    // ground tiles (80 m, off C's ground and off the river), roads (aRd: s along, lamp phase, spacing), the river
    { const P = [], C = [], RDa = [], B0 = layout.box || layout.core, x0 = B0.x0 - 78, x1 = B0.x1 + 78, z0 = B0.z0 - 78, z1 = B0.z1 + 78, cxx = (B0.x0 + B0.x1) / 2, czz = (B0.z0 + B0.z1) / 2, T = 80;
      const bz = (x) => { const K = BY.bank; for (let i = 0; i < K.length - 1; i++) if (x >= K[i][0] && x <= K[i + 1][0]) return K[i][1] + (K[i + 1][1] - K[i][1]) * (x - K[i][0]) / (K[i + 1][0] - K[i][0]); return 1e9; };
      const q = (a, b, c2, d, y, col, rd = null) => { const V = [a, b, c2, a, c2, d], S = rd ? [rd[0], rd[1], rd[1], rd[0], rd[1], rd[0]] : null; V.forEach((v, j) => { P.push(v[0], y, v[1]); C.push(...col); RDa.push(S ? S[j] : 0, rd ? rd[2] : 0, rd ? rd[3] : 0); }); };
      const G0 = [0.13, 0.12, 0.11];
      for (let x = cxx - BY.rmax - 200; x < cxx + BY.rmax + 200; x += T) for (let z = czz - BY.rmax - 200; z < czz + BY.rmax + 200; z += T) {
        const ins = (px, pz) => px > x0 && px < x1 && pz > z0 && pz < z1; if (ins(x, z) && ins(x + T, z) && ins(x, z + T) && ins(x + T, z + T)) continue;
        if ([[x, z], [x + T, z], [x, z + T], [x + T, z + T]].every(([px, pz]) => pz > bz(px) + 10)) continue;
        if (Math.hypot(x + T / 2 - cxx, z + T / 2 - czz) > BY.rmax + 300) continue;
        // clip the tile against C's ground (keep only the part outside it)
        const xa = Math.max(x, x0), xb = Math.min(x + T, x1), za = Math.max(z, z0), zb = Math.min(z + T, z1);
        if (xa < xb && za < zb) { for (const [p0, p1, p2, p3] of [[[x, z], [x + T, z], [x + T, za], [x, za]], [[x, zb], [x + T, zb], [x + T, z + T], [x, z + T]], [[x, za], [xa, za], [xa, zb], [x, zb]], [[xb, za], [x + T, za], [x + T, zb], [xb, zb]]]) if (Math.abs((p1[0] - p0[0]) * (p3[1] - p0[1])) > 1) q(p0, p3, p2, p1, -0.03, G0); }
        else q([x, z], [x, z + T], [x + T, z + T], [x + T, z], -0.03, G0);
      }
      // road means in nits (0.6 on the arterials, 0.3 on the local streets: horizon1 still read the carried-on road as a white
      // streak at 0.9); the pools add the shape
      const RD = BY.roads, RLp = BY.roadLamps || null;
      for (let i = 0, ri = 0; i < RD.length; i += 6, ri++) { const ax = RD[i], az = RD[i + 1], bx2 = RD[i + 2], bz2 = RD[i + 3], hw = RD[i + 4], k = RD[i + 5], L = Math.hypot(bx2 - ax, bz2 - az), nx = -(bz2 - az) / L * hw, nz = (bx2 - ax) / L * hw;
        const col = [[1.0, 0.92, 0.82].map((v) => v * 0.6), [1.0, 0.82, 0.62].map((v) => v * 0.3), [1.0, 0.92, 0.82].map((v) => v * 0.8), [0.9, 0.9, 0.9].map((v) => v * 0.6)][k];
        q([ax + nx, az + nz], [bx2 + nx, bz2 + nz], [bx2 - nx, bz2 - nz], [ax - nx, az - nz], k === 3 ? 0.4 : 0.0, col, RLp ? [0, L, RLp[ri * 2], RLp[ri * 2 + 1]] : null); }
      { const K = BY.bank; for (let i = 0; i < K.length - 1; i++) q([K[i][0], K[i][1]], [K[i + 1][0], K[i + 1][1]], [K[i + 1][0], 4200], [K[i][0], 4200], -0.6, [0.02, 0.025, 0.03]); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); g.setAttribute('aRd', new THREE.Float32BufferAttribute(RDa, 3)); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cxx, 0, czz), BY.rmax + 600);
      const m = new THREE.ShaderMaterial({ uniforms: beyondU, vertexShader: 'attribute vec3 color; attribute vec3 aRd; varying vec3 vC; varying vec3 vW; varying vec3 vR; void main(){ vC = color; vR = aRd; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: HZ + `
varying vec3 vC; varying vec3 vW; varying vec3 vR;
void main(){
  vec3 c = vC;
  if (vR.z > 0.5) { float a = (fract((vR.x - vR.y) / vR.z + 0.5) - 0.5) * vR.z, sg = 0.16 * vR.z; c *= 0.35 + 1.7 * exp(-a * a / (2.0 * sg * sg)); }   // lamp pools, mean ~1
  gl_FragColor = vec4(haze(c, length(vW - cameraPosition)) * uNits, 1.0);
}`, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
      m.userData.cityLight = false; const mesh = new THREE.Mesh(g, m); mesh.name = 'seoul:beyondGround'; mesh.matrixAutoUpdate = false; mesh.renderOrder = -2; group.add(mesh); disposables.push(g, m); beyondStats.groundTris = P.length / 9; }
    // buildings: boxes (4 walls + roof), u along the face and height in metres, per-building (floorH, kind, seed, H); the roof's
    // uv = metres from its wall pack (BY.roofLamp; 1e3 away: none)
    { const Bd = BY.buildings, RLm = BY.roofLamp, n = Bd.length / 9, P = new Float32Array(n * 30 * 3), N = new Float32Array(n * 30 * 3), U = new Float32Array(n * 30 * 2), A4 = new Float32Array(n * 30 * 4); let v = 0;
      const push = (p, nn, u, b) => { P.set(p, v * 3); N.set(nn, v * 3); U.set(u, v * 2); A4.set(b, v * 4); v++; };
      for (let i = 0; i < n; i++) { const [x, z, hw, hd, yaw, H, fh, kind, sd] = Bd.subarray(i * 9, i * 9 + 9), cs = Math.cos(yaw), sn = Math.sin(yaw), b = [fh, kind, sd, H];
        const cn = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([a, c2]) => [x + cs * a - sn * c2, z + sn * a + cs * c2]);
        const lx = RLm && RLm[i * 2] < 1e4 ? RLm[i * 2] : x + 1e3, lz = RLm && RLm[i * 2] < 1e4 ? RLm[i * 2 + 1] : z + 1e3;
        let u0 = sd * 37 % 11;
        for (let k = 0; k < 4; k++) { const a = cn[k], c2 = cn[(k + 1) % 4], L = Math.hypot(c2[0] - a[0], c2[1] - a[1]), nn = [(c2[1] - a[1]) / L, 0, -(c2[0] - a[0]) / L];
          const out = (nn[0] * (a[0] - x) + nn[2] * (a[1] - z)) > 0 ? nn : [-nn[0], 0, -nn[2]];
          const V = [[a[0], 0, a[1], u0, 0], [c2[0], 0, c2[1], u0 + L, 0], [c2[0], H, c2[1], u0 + L, H], [a[0], H, a[1], u0, H]];
          for (const j of [0, 1, 2, 0, 2, 3]) push([V[j][0], V[j][1], V[j][2]], out, [V[j][3], V[j][4]], b); u0 += L; }
        for (const j of [0, 2, 1, 0, 3, 2]) push([cn[j][0], H, cn[j][1]], [0, 1, 0], [cn[j][0] - lx, cn[j][1] - lz], b); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3)); g.setAttribute('aUV', new THREE.BufferAttribute(U, 2)); g.setAttribute('aB', new THREE.BufferAttribute(A4, 4));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
      const m = new THREE.ShaderMaterial({ uniforms: beyondU, side: THREE.DoubleSide,
        vertexShader: 'attribute vec2 aUV; attribute vec4 aB; varying vec2 vUV; varying vec4 vB; varying vec3 vN; varying vec3 vW; void main(){ vUV = aUV; vB = aB; vN = normal; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: BEYOND_HZ + BEYOND_BLD_FS });
      m.userData.cityLight = false; const mesh = new THREE.Mesh(g, m); mesh.name = 'seoul:beyondCity'; mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; group.add(mesh); disposables.push(g, m); beyondStats.buildingTris = v / 3; }
    // light points: lamps, cars (moving, white toward the camera / red away), crosses (a cross-shaped sprite), beacons (blink),
    // [P4-E] roof wall packs (aEx.x 4: a warm dot, no cut-off)
    { const Lm = BY.lamps, Cr = BY.cars, Mk = BY.marks, n = Lm.length / 7 + Cr.length / 8 + Mk.length / 5;
      const P = new Float32Array(n * 3), Col = new Float32Array(n * 4), Mv = new Float32Array(n * 4), Ex = new Float32Array(n * 2); let v = 0;
      for (let i = 0; i < Lm.length; i += 7) { P.set([Lm[i], Lm[i + 1], Lm[i + 2]], v * 3); Col.set([Lm[i + 3], Lm[i + 4], Lm[i + 5], Lm[i + 6]], v * 4); Ex.set([0, 0], v * 2); v++; }
      for (let i = 0; i < Cr.length; i += 8) { P.set([Cr[i], Cr[i + 1], Cr[i + 2]], v * 3); Col.set([1, 1, 1, 2500], v * 4); Mv.set([Cr[i + 3], Cr[i + 4], Cr[i + 5], Cr[i + 7]], v * 4); Ex.set([1, Cr[i + 6]], v * 2); v++; }
      for (let i = 0; i < Mk.length; i += 5) { const k = Mk[i + 3]; P.set([Mk[i], Mk[i + 1], Mk[i + 2]], v * 3);
        Col.set(k === 2 ? [1, 0.76, 0.5, 120] : k === 1 ? [1, 0.08, 0.04, 900] : [1, 0.12, 0.08, 260], v * 4); Ex.set([k + 2, Mk[i + 4]], v * 2); v++; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('aCol', new THREE.BufferAttribute(Col, 4)); g.setAttribute('aMove', new THREE.BufferAttribute(Mv, 4)); g.setAttribute('aEx', new THREE.BufferAttribute(Ex, 2));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
      const m = new THREE.ShaderMaterial({ uniforms: beyondU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: `uniform float uTime; uniform vec2 uRes; uniform float uNits; uniform float uHazeD;
attribute vec4 aCol; attribute vec4 aMove; attribute vec2 aEx; varying vec3 vC; varying float vK;
void main(){
  vec3 p = position; float I = aCol.w; vec3 col = aCol.rgb; vK = aEx.x;
  if (aEx.x > 0.5 && aEx.x < 1.5) {                                   // a car on its lane: head lamps toward the camera, tail lamps away
    float s = mod(aEx.y + uTime * aMove.w, aMove.z); p.xz += aMove.xy * s;
    vec3 tc = cameraPosition - p; float dl = max(length(tc), 1.0);
    float f = dot(normalize(vec3(aMove.x, 0.0, aMove.y)), tc / dl);
    float lowBeam = mix(1.0, 0.1, smoothstep(0.0, 0.08, tc.y / dl));  // low beams: little light above the horizontal
    float head = smoothstep(-0.05, 0.6, f) * lowBeam, tail = smoothstep(0.05, -0.6, f);
    col = (vec3(1.0, 0.93, 0.82) * 2500.0 * head + vec3(1.0, 0.06, 0.03) * 90.0 * tail) / max(1e-3, 2500.0 * head + 90.0 * tail); I = 2500.0 * head + 90.0 * tail;
  }
  if (aEx.x < 0.5) { float vy = (cameraPosition.y - p.y) / max(length(cameraPosition - p), 1.0); I *= mix(1.0, 0.07, smoothstep(-0.03, 0.06, vy)); }   // cut-off optics: nothing above ~3 deg over the horizontal
  if (aEx.x > 2.5 && aEx.x < 3.5) I *= step(0.82, fract(uTime / 1.6 + aEx.y));   // tower beacons blink
  vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
  float d = max(1.0, -mv.z), pa = 2.0 / (projectionMatrix[1][1] * uRes.y);                // radians per pixel
  float s = aEx.x > 1.5 && aEx.x < 2.5 ? clamp(2.4 / (d * pa), 2.5, 28.0) : 3.0;             // crosses: their true size (2.4 m), at least a dot
  gl_PointSize = s;
  float foot = aEx.x > 1.5 && aEx.x < 2.5 ? 0.22 * s * s : 0.098 * s * s;
  float L = I / (d * d * pa * pa * foot);                                                    // nits: the source's light spread over its sprite
  if (aEx.x > 1.5 && aEx.x < 2.5) L = min(L, 260.0);                                        // a resolved neon cross is its own luminance
  vC = col * min(L, 40000.0) * exp(-d / uHazeD) * uNits;
}`,
        fragmentShader: `varying vec3 vC; varying float vK;
void main(){
  vec2 q = gl_PointCoord - 0.5; float a;
  if (vK > 1.5 && vK < 2.5) { vec2 aq = abs(q); a = (aq.x < 0.07 && q.y > -0.48 && q.y < 0.48) || (aq.y < 0.07 && q.y > 0.0 && q.y < 0.14 && aq.x < 0.3) || (abs(q.y - 0.12) < 0.07 && aq.x < 0.3) ? 1.0 : 0.0; }
  else a = exp(-32.0 * dot(q, q));
  if (a < 0.003) discard;
  gl_FragColor = vec4(vC * a, 1.0);
}` });
      m.userData.cityLight = false; const pts = new THREE.Points(g, m); pts.name = 'seoul:beyondLights'; pts.frustumCulled = false; pts.matrixAutoUpdate = false; pts.renderOrder = 1;
      const _v2 = new THREE.Vector2(); pts.onBeforeRender = (r) => { const rt = r.getRenderTarget(); if (rt) beyondU.uRes.value.set(rt.width, rt.height); else { r.getDrawingBufferSize(_v2); beyondU.uRes.value.copy(_v2); } };
      group.add(pts); disposables.push(g, m); beyondStats.points = v; }
    Object.assign(beyondStats, BY.facts);
  }

  // cable material: make sure S3's grid reaches it (if seoulLight.attach ran before us)
  let patched = false;
  const ensureLit = () => { if (patched || !lineMesh) return; const L = ctx.scene?.userData?.seoulLight; if (L?.patchMaterial) { L.patchMaterial(lineMesh.material); patched = true; } };
  // [P4-E fpv #4] haze toward the sky's own horizon (seoul-light's 'seoul.sky' uHor, scene units): the ring fades into the skyglow
  let skyHor = null;
  // [P6-E perf] the low roof props (dr_roof) draw only with the camera at or above the lowest roof carrying one: below it,
  // every one of them is behind its parapet. world-seoul names the mesh, seoul-light may swap it for a BatchedMesh (same
  // name) after this build: look it up again when the one held has left the scene.
  const roofY = geo.facts?.roofHideY ?? 0; let roofMeshes = [], roofSeen = 0;
  const _cp = new THREE.Vector3();
  const updateRoof = (camPos) => {
    if (!ctx.scene || !roofY) return;
    if (!roofMeshes.length || roofMeshes.some((m) => !m.parent) || (++roofSeen % 600) === 0) roofMeshes = ctx.scene.getObjectsByProperty ? ctx.scene.getObjectsByProperty('name', 'seoul:dr_roof') : [];
    let y = camPos?.y; if (y == null) { const cam = ctx.camera; if (cam) { cam.getWorldPosition(_cp); y = _cp.y; } }
    if (y == null) return;
    const vis = y >= roofY - 0.25; for (const m of roofMeshes) m.visible = vis;
  };
  // [P7-E perf #1] the distance tiers (DRESS_MATS[k].lod): per seoul-light cell (a BatchedMesh instance; its square is the
  // cell its bounding-sphere centre falls in), N parts draw within LOD_R of the square (the camera's height over 10 m added),
  // F parts beyond it. A far key left whole (no seoul-light, or under splitCells' 12k-tri floor): N everywhere, F never.
  const TIERS = Object.entries(DRESS_MATS).filter(([, m]) => m.lod).map(([k, m]) => ['seoul:' + k, m.lod === 'near']);
  let tierM = [], tierSeen = 0, tierOff = false; const tierCam = new THREE.Vector3(), tierLast = new THREE.Vector3(1e9, 0, 0);
  const tierStats = { near: 0, far: 0, off: false, cell: 0 };
  const updateTiers = (camPos) => {
    if (!ctx.scene?.getObjectsByProperty) return;
    if (!tierM.length || tierM.some((t) => !t.m.parent) || (++tierSeen % 600) === 0) {
      const prev = tierM; tierM = [];
      for (const [name, isN] of TIERS) for (const m of ctx.scene.getObjectsByProperty('name', name)) tierM.push(prev.find((t) => t.m === m) || { m, isN, vis: [] });
      const parts = (name) => { const ms = tierM.filter((t) => t.m.name === name).map((t) => t.m); return ms.reduce((n, m) => n + (m.isBatchedMesh ? (m.userData.cellSpheres?.length || 1) : 1), 0); };
      tierOff = TIERS.some(([name, isN]) => !isN && tierM.some((t) => t.m.name === name) && parts(name) < 2);
      tierStats.off = tierOff; tierLast.set(1e9, 0, 0);
    }
    if (!tierM.length) return;
    if (camPos) tierCam.copy(camPos); else if (ctx.camera) ctx.camera.getWorldPosition(tierCam); else return;
    const off = tierOff || group.userData.lodOff === true;   // (debug / A-B: group.userData.lodOff = true draws N everywhere)
    if (tierCam.distanceToSquared(tierLast) < 0.25 && off === tierStats.offNow) return;
    tierLast.copy(tierCam); tierStats.offNow = off;
    const cell = ctx.scene.userData?.seoulLight?.stats?.cull?.cell || 64, hy = Math.max(0, tierCam.y - 10); tierStats.cell = cell;
    const nearSq = (ix, iz) => { const x0 = ix * cell, z0 = iz * cell, dx = Math.max(x0 - tierCam.x, 0, tierCam.x - x0 - cell), dz = Math.max(z0 - tierCam.z, 0, tierCam.z - z0 - cell); return dx * dx + dz * dz + hy * hy < LOD_R * LOD_R; };
    let nN = 0, nF = 0;
    for (const t of tierM) {
      const m = t.m;
      if (off || !(m.isBatchedMesh && m.userData.cellSpheres) && !m.userData.cell) {   // whole: the full model only
        m.visible = t.isN; if (m.isBatchedMesh) { const I = m.userData.instanceIds || []; for (let i = 0; i < I.length; i++) if (t.vis[i] === false) { m.setVisibleAt(I[i], true); t.vis[i] = true; } } continue; }
      if (m.isBatchedMesh) {
        const S = m.userData.cellSpheres, I = m.userData.instanceIds; m.visible = true;
        for (let i = 0; i < S.length; i++) { const c = S[i].center, v = nearSq(Math.floor(c.x / cell), Math.floor(c.z / cell)) === t.isN; if (t.vis[i] !== v) { m.setVisibleAt(I[i], v); t.vis[i] = v; } if (v) { if (t.isN) nN++; else nF++; } }
      } else { m.visible = nearSq(m.userData.cell[0], m.userData.cell[1]) === t.isN; if (m.visible) { if (t.isN) nN++; else nF++; } }
    }
    tierStats.near = nN; tierStats.far = nF;
  };
  const update = (t = 0, camPos = null) => { ensureLit(); updateLamps(t); updateRoof(camPos); updateTiers(camPos); RING_U.uTime.value = t;
    if (!skyHor) skyHor = ctx.scene?.getObjectByName?.('seoul.sky')?.material?.uniforms?.uHor?.value || null;
    if (skyHor) RING_U.uHaze.value.copy(skyHor).multiplyScalar(RING_LOOK.hazeK / nit); };
  return {
    group, update, emitters: [], setPieces: geo.setPieces,
    stats: { cables: polys.length, cableSegs: lineMesh ? lineMesh.geometry.index.count / 6 : 0, labels: geo.labels.length, lamps: geo.lamps.length, beyond: beyondStats, tiers: tierStats, ...geo.facts },
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
  } else if (L.kind === 'awning') {                // printed on the valance: paint over transparent (the fabric is geometry)
    g.fillStyle = L.ink || '#f4efe4'; g.textAlign = 'center'; fit(L.lines[0], h * 0.78, w * 0.94, 700); g.fillText(L.lines[0], x + w / 2, y + h * 0.54);
  } else if (L.kind === 'standsign') {          // [P5-E] a standing LED box: the face colour, the name stacked (hangul) or along it
    g.fillStyle = L.bg || '#d0201a'; g.fillRect(x, y, w, h); g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = Math.max(1, w * 0.04); g.strokeRect(x + w * 0.08, y + w * 0.08, w * 0.84, h - w * 0.16);
    g.fillStyle = L.ink || '#ffffff'; g.textAlign = 'center'; const t = L.lines[0], ch = [...t.replace(/\s+/g, '')];
    if (/[가-힣]/.test(t) && ch.length <= 6) { const step = Math.min(w * 0.72, (h * 0.8) / ch.length); ch.forEach((c2, i) => { fit(c2, step * 0.92, w * 0.74, 800); g.fillText(c2, x + w / 2, y + h * 0.1 + step * (i + 0.5) + (h * 0.8 - step * ch.length) / 2); }); }
    else { g.save(); g.translate(x + w / 2, y + h / 2); g.rotate(-Math.PI / 2); fit(t, w * 0.6, h * 0.8, 800); g.fillText(t, 0, w * 0.03); g.restore(); }
  } else if (L.kind === 'banner') {             // [P5-E] a lamp-post vinyl banner: colour field, a white band, the title stacked
    g.fillStyle = L.bg || '#c8102e'; g.fillRect(x, y, w, h); g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillRect(x, y + h * 0.84, w, h * 0.1);
    g.fillStyle = L.bg === '#1a1a1a' ? '#f2c200' : '#ffffff'; g.textAlign = 'center'; const ch = [...L.lines[0].replace(/\s+/g, '')], step = Math.min(w * 0.7, (h * 0.72) / ch.length);
    ch.forEach((c2, i) => { fit(c2, step * 0.92, w * 0.8, 800); g.fillText(c2, x + w / 2, y + h * 0.06 + step * (i + 0.5)); });
    g.fillStyle = L.bg || '#c8102e'; fit(L.lines[1] || '', h * 0.06, w * 0.9, 700); g.fillText(L.lines[1] || '', x + w / 2, y + h * 0.89);
  } else if (L.kind === 'menu') {               // [P5-E] a cart's menu light box: yellow field, three photo tiles, names and prices
    g.fillStyle = '#f2c230'; g.fillRect(x, y, w, h); g.fillStyle = '#c8102e'; g.fillRect(x, y, w, h * 0.16);
    const n = L.lines.length, cw = w / n;
    L.lines.forEach((t, i) => { const cx = x + cw * i; g.fillStyle = (L.colors || [])[i] || '#a8441c'; g.beginPath(); g.ellipse(cx + cw / 2, y + h * 0.47, cw * 0.36, h * 0.24, 0, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.ellipse(cx + cw * 0.42, y + h * 0.4, cw * 0.12, h * 0.06, -0.4, 0, TAU); g.fill();
      g.fillStyle = '#1a1410'; g.textAlign = 'center'; fit(t, h * 0.15, cw * 0.92, 800); g.fillText(t, cx + cw / 2, y + h * 0.86); });
  } else if (L.kind === 'tent') {
    g.fillStyle = 'rgba(255,248,235,0.95)'; g.textAlign = 'center'; fit(L.lines[0], h * 0.8, w * 0.9, 800); g.fillText(L.lines[0], x + w / 2, y + h * 0.54);
  }
  g.restore();
}

// native export (H): the runtime content as plain data (geometry itself goes out through buildGeometry / export-world)
export function exportData(layout, opts = {}) {
  const g = CACHE.get(layout) || geometry(layout, opts);
  const by = beyond(layout, opts);   // [P3-E fpv #3] the city ring as plain arrays (layouts in beyond()'s header)
  return { version: 1, setPieces: g.setPieces, emitters: g.emitters, holes: g.holes, cables: g.cables, labels: g.labels, lamps: g.lamps, obstacles: g.obstacles, materials: DRESS_MATS, facts: g.facts,
    beyond: { version: by.version, bearing: by.bearing, rmax: by.rmax, bank: by.bank, roads: [...by.roads], roadLamps: [...by.roadLamps], buildings: [...by.buildings], roofLamp: [...by.roofLamp], lamps: [...by.lamps], cars: [...by.cars], marks: [...by.marks], look: by.look,
      notes: 'P4: roadLamps [phase, spacing] per road (lamp pools on the road, mean = the road colour); roofLamp [x, z] per building (1e5 none: the roof pool); marks kind 2 = rooftop wall pack; lamps dim to 7 % seen from above (cut-off), head lamps to 10 % (low beam); haze toward the sky horizon x look.hazeK over look.hazeD m', facts: by.facts } };
}

export const acKit = true;   // [P3-E1] C hands its AC placements to E (lotInfo .ac) when this is set
export const seoulDressing = { geometry, build, material, groundTris, exportData, beyond, DRESS_MATS, NITS, acKit };
export default seoulDressing;
