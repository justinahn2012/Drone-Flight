// world-core.js — the shared world engine every level builds on (split out of world-bando.js, S0 seoul phase 1).
// A level module (world-bando.js, world-seoul.js) is site data plus site-specific builders; it imports from here:
//   materials   makeWeatherPatch({ GLSL_WEATHER, WP_FRAG }) -> weatherPatch(mat, opt, uniforms); glslWeather(caps),
//               wpFrag(gcols, grows); the shared GLSL (GLSL_NOISE, GRASS_HASH, GRASS_LIGHTS, VEG_*); depthC2Mat /
//               depthC2Opaque (contract C2 blur depth); px1 / flatTex / flatNorm stand-ins
//   lighting    lightUniforms, aoUniforms (C3), aLightingPatch, aSkyShadowPatch, skyShadowUniforms, SUN_MAPS, LIVE_SHADOW
//   light bake  siteBake({ MATS, terrainHeight, distToPaths }) -> { bakeLight, lmProbeBake, lightProbe, albedoOf,
//               groundAlbedo, setBake }; skyVisibility, LP, aoCurve, ALB_DEFAULT / ALB_FALLBACK
//   lightmaps   LMUV, lightmapUV2, GeoHash, geometryHash, lmFetchJSON(file, base), lmMatch, lmLoad, lmSampler, lmEnable
//   shadows     renderSunMap, blankSunMap, shadowProxies, renderRingShadow (static sun maps rendered once at load)
//   sky         SKIES, skySunDir, skyEnvI, loadSky, applySky, equirectDir / equirectTexel, PH (Poly Haven CDN)
//   geometry    Site (per-material part lists + collide flags; new Site(MATS)), boxGeo, cylGeo, tubeGeo, ringGeo,
//               wallWithHoles, planarUV, setAY, indexify, flip; rng, subRng, hashStr, hash2, Y_UP, yieldUI, fastYield
//   collider    colliderScene(colGeo) (the take/proximity scene), disposeObject(root) (level switch, S0 dispose)
// Everything here moved verbatim from world-bando.js; bando's output is bit-exact (replays --strict, export hash).
// The grass and vegetation runtime systems still live inside buildBando (their GLSL hard-codes bando's terrain).
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

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
  // [A4] decision 2: the sky light that falls on the world is the sky you see: envI = 0.85 x bgI (skyEnvI), so sunny
  // runs envI 1.7. sunRatio 7.5 -> 3.75 keeps sunI at 10.0 (sunI = sunRatio x skyLum x envI); shade goes blue.
  sunny: { id: 'kloofendal_48d_partly_cloudy_puresky', label: 'Sunny', sunRatio: 3.75, sunDir: [0.5544, 0.7417, 0.3775], rotY: 0.87, bgI: 2.0, disc: 2000 },
  overcast: { id: 'overcast_soil_puresky', label: 'Overcast', sunRatio: 0, sunDir: [0.3813, 0.921, 0.0794], rotY: 0, bgI: 1.0, disc: 0 },
};
// [A2] world-space sun of a SKIES entry (three r180: a background/env rotation Euler(0, rotY, 0) samples the texture at
// R(-rotY) * worldDir, so a texture direction d shows at R(+rotY) * d). The bake, shadows, haze and exporters use this.
export function skySunDir(def) { return new THREE.Vector3(...def.sunDir).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), def.rotY || 0); }
// [A4] sky light on the world (scene.environmentIntensity, the bake's sky, uSkyB): 0.85 of the visible sky (decision 2)
export function skyEnvI(def) { return 0.85 * ((def && def.bgI) ?? 1); }
// [A2] live shadow map: +-ext m, re-rendered only when its centre (the camera, no lead) moves a snapM light-space step.
// Lead 0 + 8 m snap: ~2-3 re-renders/s in carves instead of 13-20 (perf #1b). Exported for the frequency test.
// [A4] only used when some caster opts out of the static maps (userData.liveShadow, e.g. foliage whose shadow sways):
// then the live map renders those casters alone. By default every caster is static and there is no live map.
export const LIVE_SHADOW = { ext: 52, snapM: 8, lead: 0, back: 150 };
// [A4] static sun shadow maps, rendered once at load (perf #1, decision 6). near: 4096^2 hardware-compare depth (16 bit)
// fitted to the site's casters in light space, capped at +-half m (5.4 cm texels at 110); far: every caster (+-170 m);
// ring: the treeline crowns (A2). normal/bias: receiver offset along the normal and depth bias, metres.
export const SUN_MAPS = { near: { size: 4096, sizeLow: 2048, half: 110, normal: 0.05, bias: 0.03, raw: 1024 }, far: { size: 2048, sizeLow: 1024, half: 170, normal: 0.15, bias: 0.08 } };

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

export class Site {
  #mats;
  constructor(mats = {}) { this.#mats = mats; this.parts = {}; this.decalSpots = []; this.footprints = []; this.trunks = []; this.colliders = []; }
  add(mat, g, collide = true) {
    if (!g.index) g = indexify(g);
    // [B] cylinders: wrap the circumference in whole texture tiles (no seam) and give each one its own offset
    const tile = this.#mats[mat]?.tile;
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

// per-subsystem RNG streams: a draw added in one part of the site never reshuffles another part
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const subRng = (seed, name) => rng((hashStr(name) ^ Math.imul(seed | 0, 0x9E3779B1)) >>> 0);
const Y_UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------- texture means
// [G5] 1x1 stand-ins when a download fails (flatTex was referenced but never defined: a failed meadow download threw)
const px1 = (r, g, b) => { const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1, THREE.RGBAFormat); t.needsUpdate = true; return t; };
function flatTex() { const t = px1(255, 255, 255); t.colorSpace = THREE.SRGBColorSpace; return t; }
function flatNorm() { return px1(128, 128, 255); }

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
// [G5] the grass cell hash and the meadow fields shared by the blades (VS), the ground and the track (FS), so the
// matted floor, the bare strip gaps and the tufts agree texel for texel. gClump: 0.5-1.5 m tuft clumps, a density
// multiplier 0.2-1.8 with mean 1 (art #1); gBreak: 1-2 m runs of grass on the track's centre strip (1 = grass, art #3).
// The CPU twin is grassFields() (world.grassAt, contract C7).
const GRASS_HASH = `
uint gPcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
vec4 gU4(uint h) { return vec4(uvec4(h, h >> 8u, h >> 16u, h >> 24u) & 255u) * (1.0 / 255.0); }
float gh(vec2 p) { vec3 q = fract(p.xyx * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float gvn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(gh(i), gh(i + vec2(1, 0)), f.x), mix(gh(i + vec2(0, 1)), gh(i + vec2(1, 1)), f.x), f.y); }
float gClump(vec2 p) { return 0.2 + 1.6 * smoothstep(0.3, 0.7, gvn(p * 0.9 + vec2(3.7, 1.3)) * 0.62 + gvn(p * 1.9 + vec2(7.1, 3.3)) * 0.38); }
float gBreak(vec2 p) { return smoothstep(0.4, 0.6, gvn(p * 0.55 + vec2(13.0, 5.0) + 0.7 * vec2(gvn(p * 1.4), gvn(p * 1.4 + 4.0)))); }
uvec3 gTuft(vec2 bi) { ivec2 ib = ivec2(bi); uint h0 = gPcg(uint(ib.x + 32768) * 65599u + gPcg(uint(ib.y + 32768))); uint h1 = gPcg(h0); return uvec3(h0, h1, gPcg(h1)); }`;
// built weathering: per-element run-off streaks from the element top (sills, slab edges, rims), rising damp at the
// foot, dust at storey floors, grime/moss on up-facing faces, warm dust where the weather can't reach (baked AO),
// soot over the top of the chimney. uWx2.y > 0 = the material is cylinders of about that radius (silos): the
// streak noise then runs on the azimuth (from the normal) with a whole number of cells round, so there's no seam.
// [S0] site hook: caps = extra GLSL run at the end of weather() (bando: its open silo caps), '' for none
export const glslWeather = (caps = '') => `
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
  // [G5] floors and roofs (planar, up-facing; graphics #3: the hall floor was one uniform gravel): 3-8 m patches of
  // wear, saw-cut joints every 6 m (anti-aliased), oil / damp stains, drifts of dust where the weather can't reach
  float fl = up * (1.0 - step(0.5, uWx2.y));
  { float pv = vn(wp.xz * 0.15 + 3.0) * 0.65 + vn(wp.xz * 0.6 + 1.0) * 0.35;
    vec2 jg = abs(fract(wp.xz / 6.0 + 0.5) - 0.5) * 6.0; float jw = min(jg.x, jg.y), fwj = max(fwidth(wp.x) + fwidth(wp.z), 1e-4);
    float jl = (1.0 - smoothstep(0.008, 0.008 + fwj, jw)) * min(1.0, 0.012 / fwj);
    float stn = smoothstep(0.7, 0.88, vn(wp.xz * 0.35 + 17.0) * 0.75 + vn(wp.xz * 1.7) * 0.25);
    c *= mix(1.0, (0.78 + 0.44 * pv) * (1.0 - 0.4 * jl) * (1.0 - 0.32 * stn), fl);
    c = mix(c, c * vec3(1.12, 1.06, 0.94), fl * cov * smoothstep(0.45, 0.7, vn(wp.xz * 0.5 + 5.0)) * 0.6); }
${caps}  return c;
}`;
// [S0] gcols / grows: the decal atlas grid (bando: graffiti.js GCOLS x GROWS cells of 512 x 256 px)
export const wpFrag = (GCOLS = 4, GROWS = 4) => ({
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
  vec3 gBump = vec3(0.0); float gRough = 1.0;      // [G5] apron normal (world xz tilt) and wet-patch roughness, used below
  { vec2 xz = vWPos.xz; float dist = distance(vWPos, cameraPosition), far = smoothstep(40.0, 140.0, dist);
    vec2 muv = (xz - uMaskO) / uMaskS;
    vec4 mk = texture2D(uMask, muv), m2 = texture2D(uMask2, muv);
    float inM = smoothstep(0.0, 0.04, min(min(muv.x, muv.y), min(1.0 - muv.x, 1.0 - muv.y)));
    // [V2] the meadow seen from above. Scanned detail: turf (grass_ground, the 4 m map) and straw (withered_grass),
    // each times a second sample 2.7x larger and turned 30 deg (no repeat grid from altitude), normalised to unit
    // mean so the palette sets the colour; half the detail survives to the horizon (no felt). Dry / lush patch
    // fields are the blades' own (mask2) inside the yard tile, the same noise beyond it.
    mat2 Rq = mat2(0.866, 0.5, -0.5, 0.866);
    vec3 gB = vec3(1.0);
    #ifdef USE_MAP
    gB = texture2D(map, Rq * xz * 0.093 + 0.37).rgb * diffuse / uGMean;
    #endif
    vec3 gD = mix(sqrt(max(diffuseColor.rgb / uGMean, 0.0) * gB), vec3(1.0), far * 0.5);
    vec3 mD = mix(sqrt(texture2D(uMeadow, xz * uMeadowRep).rgb * texture2D(uMeadow, Rq * xz * (uMeadowRep * 0.37) + 0.61).rgb) / uMMean, vec3(1.0), far * 0.5);
    float cl = vn(xz * 0.47) * 0.55 + vn(xz * 1.9 + 5.0) * 0.45;           // 0.5-2 m clumps
    float p1 = vn(xz * 0.045) * 0.6 + vn(xz * 0.19) * 0.4;
    float dry = mix(smoothstep(0.47, 0.72, vn(xz * 0.021 + 31.0) * 0.7 + vn(xz * 0.11 + 3.0) * 0.3), m2.g, inM);
    float lush = mix(smoothstep(0.52, 0.8, vn(xz * 0.045 + 71.0)), m2.a, inM) * (1.0 - dry);
    float dryF = smoothstep(0.15, 0.85, dry + (cl - 0.5) * 0.6 + (p1 - 0.5) * 0.3);
    vec3 cG = mix(vec3(0.074, 0.086, 0.032), vec3(0.048, 0.07, 0.024), lush);
    vec3 meadow = mix(cG * gD, vec3(0.15, 0.13, 0.078) * mD, dryF) * (0.66 + 0.68 * cl * cl) * (0.78 + 0.44 * vn(xz * 0.12 + 17.0));   // + 5-15 m swells
    // out to ~8 m the blades stand on it (NEAR tier): there the ground is the shaded thatch between tufts. Further
    // out they thin away, and the ground IS the meadow: no dark felt under a fading field. Track profile = the VS's.
    // [G5] the track and meadow profile exactly as the blades' (VS): verges, broken centre strip, bare ruts
    float dP = mix(8.0, m2.r * 8.0, inM);
    float tStrip = 1.0 - smoothstep(0.26, 0.44, dP), tRut = 1.0 - smoothstep(0.16, 0.36, abs(dP - 0.8));
    float prof = max(smoothstep(1.45, 2.6, dP + (gvn(xz * 1.1) - 0.5) * 1.0), 0.55 * tStrip * gBreak(xz)) * (1.0 - tRut);
    float gDen = mk.r * inM * prof;
    // [G5] the matted floor (lighting #3, graphics #2): under the canopy the ground gets x(1 - 0.45 density) of the light
    // (the clumps' own density), browner, plus a 0.15-0.3 m contact shadow round each tuft's root (the VS's cell hash:
    // it sits where the tufts stand). Fades with the blades (24-40 m), so the meadow seen from afar is unchanged.
    float gNear = 1.0 - smoothstep(24.0, 40.0, dist), fD = min(gDen * gClump(xz), 1.25) * gNear * mix(1.0, 0.7, smoothstep(8.0, 18.0, dist));
    float spot = 0.0;
    if (dist < 16.0 && gDen > 0.02) {
      vec2 c0 = floor(xz / 0.34);
      for (int q = 0; q < 4; q++) {
        vec2 bi = c0 + vec2(float(q & 1), float(q >> 1));
        uvec3 th = gTuft(bi); vec4 tA = gU4(th.x), tB = gU4(th.y);
        vec2 bp = bi * 0.34 + (tA.xy - 0.5) * 0.306;
        spot = max(spot, step(tB.z * 0.75 + 0.004, gDen * gClump(bp)) * (1.0 - smoothstep(0.08, 0.17 + 0.1 * tA.w, distance(xz, bp))));
      }
      spot *= 1.0 - smoothstep(10.0, 16.0, dist);
    }
    vec3 base = meadow * mix(vec3(1.0), vec3(0.93, 0.9, 0.8), min(fD, 1.0)) * (1.0 - 0.45 * fD) * (1.0 - 0.4 * spot);
    vec3 dirt = vec3(0.118, 0.104, 0.078) * (0.74 + 0.5 * cl) * mix(vec3(1.0), gD, 0.6);
    // [G5] the track's dirt under (and between) the ribbon's bare bands: the same neutral dirt as WP_FRAG.track
    vec3 tDirt = vec3(0.13, 0.128, 0.124) * (0.8 + 0.4 * vn(xz * 0.2)) * mix(vec3(1.0), vec3(lum3(gD)), 0.5) * mix(1.0, 0.8, tRut);
    base = mix(base, tDirt, inM * (1.0 - prof) * (1.0 - smoothstep(1.7, 2.9, dP)) * (1.0 - smoothstep(0.4, 0.6, mk.g)));
    float bare = smoothstep(0.7, 0.86, vn(xz * 0.07 + 2.0) * 0.7 + vn(xz * 0.6) * 0.3);
    float cov = 1.0 - smoothstep(0.3, 0.78, vAO);                         // under slabs / inside: bare dirt
    base = mix(base, dirt, max(bare * 0.6, cov));
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
    vec2 auvR = Rm * auv + vec2(h21(cid + 1.7), h21(cid + 5.3));
    vec3 at = textureGrad(uApron, auvR, Rm * dFdx(auv), Rm * dFdy(auv)).rgb;   // (outside any branch)
    vec2 an = textureGrad(uApronN, auvR, Rm * dFdx(auv), Rm * dFdy(auv)).rg * 2.0 - 1.0;
    float al = lum3(at) / uAMean.w;
    vec3 asph = mix(at * uApronCol, uAMean.rgb, far) * 0.78;               // [V2] old asphalt ~0.14 (was a flat white plane)
    asph *= 0.86 + 0.28 * h21(cid + 9.1);                                  // [G5] each laid cell its own age / tone
    asph *= 0.7 + 0.36 * vn(xz * 0.11 + 4.0) + 0.14 * vn(xz * 0.9 + 6.0); // patches of old repair and stain
    asph *= 1.0 - 0.28 * smoothstep(0.62, 0.82, vn(xz * 0.27 + 8.0));     // oil and damp
    float crack = (1.0 - smoothstep(0.4, 0.68, al)) * (1.0 - far);         // weeds and moss in the cracks
    // [G5] a crack network over the slab: the edges of a warped ~2.5 m Voronoi, 1-2.5 cm wide, anti-aliased in metres
    // (a thinner line fades instead of crawling); the wider ones carry moss and weeds
    { vec2 cq = xz * 0.4 + 0.35 * vec2(vn(xz * 0.7), vn(xz * 0.7 + 5.0)), ci = floor(cq), cf = fract(cq);
      float f1 = 8.0, f2 = 8.0;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 o = vec2(float(i), float(j)); vec2 r = o + vec2(h21(ci + o), h21(ci + o + 7.7)) * 0.8 + 0.1 - cf; float dd = dot(r, r); if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd; }
      float e = (sqrt(f2) - sqrt(f1)) * 1.25, cw = 0.01 + 0.015 * vn(xz * 0.9 + 3.0), fw = max(length(fwidth(xz)), 1e-4);   // e: metres to the crack
      float ln = (1.0 - smoothstep(cw, cw + fw, e)) * min(1.0, (cw + 0.004) / fw) * smoothstep(0.25, 0.5, vn(xz * 0.3 + 1.0));
      asph *= 1.0 - 0.6 * ln;
      crack = max(crack, (1.0 - smoothstep(0.0, 0.12, e)) * smoothstep(0.55, 0.75, vn(xz * 0.5 + 9.0)) * (1.0 - far)); }
    asph = mix(asph, vec3(0.045, 0.06, 0.02), crack * 0.45);
    // [G5] standing water in the low spots: darker, smooth (it shows the sky), the asphalt normal flattened
    float wet = smoothstep(0.76, 0.84, vn(xz * 0.16 + 21.0) * 0.8 + vn(xz * 1.3) * 0.2) * (1.0 - far);
    asph *= 1.0 - 0.4 * wet;
    vec2 anR = an * Rm;                                                     // tangent (uv') -> world xz: Rm^T
    gBump = vec3(anR.x, 0.0, anR.y) * 0.85 * (1.0 - far) * (1.0 - wet);
    gRough = mix(1.0, 0.25, wet);
    asph = mix(asph, dirt, (1.0 - smoothstep(0.2, 0.75, ap)) * 0.55 + smoothstep(0.7, 0.9, vn(xz * 0.33)) * 0.35);
    diffuseColor.rgb = mix(base, asph, ap); gBump *= ap; gRough = mix(1.0, gRough, ap); }`,
  track: `
  { vec2 xz = vWPos.xz, muv = (xz - uMaskO) / uMaskS;
    vec4 mk = texture2D(uMask, muv), m2 = texture2D(uMask2, muv);
    float dP = m2.r * 8.0, n1 = vn(xz * 0.9), n2 = vn(xz * 2.7);
    // [V2] a two-track, not a carpet. [G5] dirt, not lawn (art #3: was (123,126,79) sat 0.37; ref 237 (154,152,141) sat
    // 0.09): a neutral dirt albedo (sat ~0.1, ~1.5x the meadow) carrying only the scan's luminance detail, two bare
    // compacted wheel ruts ~0.8 m either side of the centreline, a centre strip of grass broken into 1-2 m runs (bare
    // dirt between: gBreak, as the blades and the ground) and ragged grassy verges (the blades follow the same profile)
    float dl = clamp(lum3(diffuseColor.rgb) / 0.081, 0.45, 1.7);
    vec3 c = vec3(0.13, 0.128, 0.124) * mix(1.0, dl, 0.85) * (0.88 + 0.24 * vn(xz * 9.0));   // + pebble grain
    c *= 0.78 + 0.44 * vn(xz * 0.2) * (0.6 + 0.4 * n1);
    float rut = 1.0 - smoothstep(0.13, 0.27, abs(dP - 0.8 - (vn(xz * 0.11 + 3.0) - 0.5) * 0.16) + (n2 - 0.5) * 0.07);
    c = mix(c, vec3(0.112, 0.111, 0.108) * (0.9 + 0.2 * n1), rut * 0.6);    // ruts: compacted, smoother, a touch darker
    float strip = (1.0 - smoothstep(0.26, 0.46, dP + (n2 - 0.5) * 0.25)) * gBreak(xz);
    float verge = smoothstep(1.5, 2.7, dP + (n1 - 0.5) * 0.9 + (n2 - 0.5) * 0.3);
    float a = diffuseColor.a + (n1 - 0.5) * 0.6;
    diffuseColor.a = smoothstep(0.3, 0.65, a) * (1.0 - max(0.85 * strip, verge) * (1.0 - rut)) * (1.0 - smoothstep(0.35, 0.6, mk.g));
    diffuseColor.rgb = c; }`,
  bark: `
  diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(0.0, 1.2, vWPos.y - vAY.x));`,
  leaf: '', grass: '', treeline: '',
});
// [B] grass lighting (perf #5): diffuse only. No specular environment (the cube-UV radiance taps) and no sun
// specular at roughness 0.92; the env irradiance still lights it (energy as the physical model's diffuse lobe).
// The sun is shadowed down the blades (vGv = height in the canopy): the field gets depth instead of full sun on every blade.
// [V2] blades: wrap lighting (thin, rounded leaves), and the sun through the blade when the camera looks into it
// (graphics #2: forward scatter x the blade colour, yellowed; vThin = 0.6 for dead straw, 0.4 for broad weeds).
const GRASS_LIGHTS = `
#undef RE_Direct
#define RE_Direct RE_Direct_Grass
void RE_Direct_Grass( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  float self = mix( 0.28, 1.0, smoothstep( 0.05, 0.9, vGv ) );
  float wrap = saturate( ( dot( geometryNormal, directLight.direction ) + 0.35 ) / 1.35 );
  float bt = pow( saturate( dot( - geometryViewDir, directLight.direction ) ), 3.0 ) * vThin;
  reflectedLight.directDiffuse += directLight.color * self * ( wrap * BRDF_Lambert( material.diffuseColor ) + bt * 0.35 * material.diffuseColor * vec3( 1.1, 1.25, 0.6 ) );
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
// [V1] vegetation vertex code (leaf cards, treeline, wood, and their depth twins). aSway = displacement scale (model
// units, grows with height): whole-plant sway (per-instance phase, slow gusts) + per-card flutter. Facing cards
// (VEG_FACE) are spherical billboards around aCenter, sized by the instance scale; `position` keeps a fixed
// orientation for three's shadow depth pass and the far/ring shadow proxies.
const VEG_GLSL = `
uniform vec4 uWind;
#ifdef VEG_CARDS
attribute vec3 aCenter;
attribute vec4 aCard;   // (offset u, offset v, sway, crown occlusion): one slot, the cards sit at WebGL's 16-attribute limit
#define aOff aCard.xy
#define aSway aCard.z
#define aOcc aCard.w
#else
attribute float aSway;
#endif
vec3 vegWind(vec3 p, vec3 c, float fl) {
  vec3 ip = vec3(0.0);
  #ifdef USE_INSTANCING
  ip = instanceMatrix[3].xyz;
  #endif
  float ph = dot(ip.xz, vec2(0.173, 0.291)), t = uTime * uWind.z, gust = 0.6 + 0.4 * sin(t * 0.23 + ip.x * 0.011);
  vec3 d = vec3(sin(t * 0.83 + ph) + 0.45 * sin(t * 1.91 + ph * 1.7), 0.0, cos(t * 0.61 + ph * 1.3) + 0.4 * sin(t * 1.57 + ph * 0.6)) * (uWind.x * gust);
  d += vec3(sin(t * 4.1 + c.x * 7.0 + c.y * 5.0 + ph), 0.6 * sin(t * 5.3 + c.z * 6.0 + ph), cos(t * 3.7 + c.y * 8.0 + ph)) * (uWind.y * fl * gust);
  return p + d * aSway;
}
#ifdef VEG_CARDS
vec3 vegFace() {
  mat3 im = mat3(modelMatrix);
  #ifdef USE_INSTANCING
  im = im * mat3(instanceMatrix);
  #endif
  #ifdef VEG_NEAR
  // [T5] near LOD: each card turns to the camera about world up (no spin with camera roll)
  vec3 wc = (modelMatrix * vec4(aCenter, 1.0)).xyz;
  #ifdef USE_INSTANCING
  wc = (modelMatrix * (instanceMatrix * vec4(aCenter, 1.0))).xyz;
  #endif
  vec3 tc = cameraPosition - wc; tc = length(tc.xz) > 1e-3 ? normalize(tc) : vec3(0.0, 0.0, 1.0);
  vec3 cr = normalize(vec3(tc.z, 0.0, -tc.x)), cu = cross(tc, cr);
  #else
  vec3 cr = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), cu = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  #endif
  return aCenter + inverse(im) * ((cr * aOff.x + cu * aOff.y) * pow(abs(determinant(im)), 1.0 / 3.0));
}
#endif`;
const VEG_CARD_VS = `
#ifdef VEG_FACE
  transformed = vegFace();
#endif
  transformed = vegWind(transformed, aCenter, 1.0);`;
// [V1] leaf lighting: wrap diffuse (light reaches round the crown), sun transmission toward the viewer (backlit leaves
// glow yellow-green instead of going black; the shadow map already darkens leaves inside the crown) and a little
// waxy specular. uLeafL = (transmission, wrap, specular, crown occlusion on direct light).
const VEG_LEAF_LIGHTS = `
uniform vec4 uLeafL;
#undef RE_Direct
#define RE_Direct RE_Direct_Leaf
void RE_Direct_Leaf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  float ndl = dot( geometryNormal, directLight.direction );
  vec3 lam = BRDF_Lambert( material.diffuseColor ) * mix( 1.0, vAO, uLeafL.w );   // leaves deep in the crown see less sun
  float bk = mix( 1.0, 0.5, smoothstep( 0.1, -0.3, ndl ) );   // [T5] cards facing away from the sun: half the wrap and glow
  float wr = uLeafL.y * bk;
  reflectedLight.directDiffuse += saturate( ( ndl + wr ) / ( 1.0 + wr ) ) * directLight.color * lam;
  float vdl = saturate( dot( -geometryViewDir, directLight.direction ) );
  float tr = uLeafL.x * bk * ( 1.4 * pow( vdl, 4.0 ) + 0.4 * saturate( -ndl ) );
  reflectedLight.directDiffuse += tr * directLight.color * lam * vec3( 1.0, 1.08, 0.75 );   // [T5] less lime (graphics #1)
  reflectedLight.directSpecular += saturate( ndl ) * directLight.color * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material ) * uLeafL.z;
}`;
// [S0] makeWeatherPatch({ GLSL_WEATHER, WP_FRAG }) -> weatherPatch(mat, opt, uniforms): one per site module
export function makeWeatherPatch({ GLSL_WEATHER = glslWeather(), WP_FRAG = wpFrag() } = {}) {
return function weatherPatch(mat, opt = {}, uniforms) {
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
${kind === 'leaf' || kind === 'treeline' ? VEG_GLSL : ''}
${kind === 'decal' ? 'attribute float aSeed;\nvarying float vSeed;' : ''}
${opt.vsHead || ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${kind === 'leaf' || kind === 'treeline' ? VEG_CARD_VS : ''}
${opt.vsBegin || ''}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vAO = ${opt.aoExpr || 'ao'}; vBounce = bounce;
  ${opt.vsPost || ''}
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
${kind === 'ground' || kind === 'track' ? 'uniform sampler2D uMask; uniform sampler2D uMask2; uniform vec2 uMaskO; uniform float uMaskS;' : ''}
${kind === 'ground' || kind === 'track' ? GRASS_HASH : ''}
${kind === 'ground' ? 'uniform sampler2D uApron; uniform sampler2D uApronN; uniform float uApronRep; uniform vec3 uApronCol; uniform vec3 uGMean; uniform vec4 uAMean;\nuniform sampler2D uMeadow; uniform float uMeadowRep; uniform vec3 uMMean;' : ''}
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
  roughnessFactor = max(roughnessFactor, uRoughMin);${kind === 'ground' ? '\n  roughnessFactor = min(roughnessFactor, gRough);' : ''}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>${kind === 'ground' ? '\n  normal = normalize(normal + (viewMatrix * vec4(gBump, 0.0)).xyz);   // [G5] apron normal map' : ''}`)
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
};
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
// [V2] the same contract for opaque geometry (the grass blades): no alpha, the identical packed log depth.
function depthC2Opaque({ vsHead = '', vsMain = '', uniforms = {} }) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `uniform float uTime;
${vsHead}
varying vec3 vVP;
void main() {
  vec3 transformed = position;
  ${vsMain}
  vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
  vVP = -mv.xyz; gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: `varying vec3 vVP;
void main() {
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
const aoCurve = (v) => Math.pow(v, 1.15);
// legacy probe API (decals etc.): lightProbe() returns openness and leaves the final-unit bounce in LP.out
const LP = { sun: new THREE.Vector3(0, 1, 0), sunRGB: new THREE.Vector3(), skyRGB: new THREE.Vector3(), out: new THREE.Vector3() };
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

// ---------------------------------------------------------------- [A] shader patch (one hook inside weatherPatch)
// uniforms.aLight: uSunB/uSkyB scale the baked bounce once the HDR is measured; uSunW/uHaze = forward-scatter haze in
// the fog. [A4] Sun shadows: uNear* = the static near map (4096^2, the site), uFar* = the static far map (every caster),
// both rendered once at load (renderSunMap); uSunShOn = 0 when the sky casts no shadow. uHz/uHzI = the horizon table
// (loadSky) that the fog converges to, x bgI.
function lightUniforms() {
  return { uSunB: { value: new THREE.Vector3() }, uSkyB: { value: new THREE.Vector3() }, uFarSM: { value: null }, uFarMat: { value: new THREE.Matrix4() },
    uFarOn: { value: 0 }, uFarTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) }, uSunW: { value: new THREE.Vector3(0, 1, 0) }, uHaze: { value: 1.2 },
    uNearSM: { value: null }, uNearMat: { value: new THREE.Matrix4() }, uNearTexel: { value: new THREE.Vector2(1 / 4096, 1 / 4096) }, uSunShOn: { value: 0 },
    // [L5] PCSS on the static near map: uNearRaw = a low-res plain depth copy (blocker search), uPcss = (depth range m,
    // uv per m, on, 0)
    uNearRaw: { value: null }, uPcss: { value: new THREE.Vector4(1, 0, 0, 0) },
    uHz: { value: null }, uHzI: { value: 1 }, uHzOn: { value: 0 },
    // [A1] committed lightmap (see lmLoad): indirect irradiance, aux = (openness, sun mask), log2 range, live scale
    uLM: { value: null }, uLMAux: { value: null }, uLMRange: { value: new THREE.Vector2(-12, 3) }, uLMScale: { value: new THREE.Vector3(1, 1, 1) } };
}
// [A1] contract C3: SSAO from stream D. world.aoUniforms; D fills uAO (the SSAO texture), uAOOn and uAOScale (1 / the
// scene RT size in pixels) every frame, so texture(uAO, gl_FragCoord.xy * uAOScale).r is the AO under this pixel.
// Indirect diffuse x mix(1, ao, 0.8) on the surfaces that are in D's depth pass (not foliage, grass, treeline).
function aoUniforms() { return { uAO: { value: null }, uAOOn: { value: 0 }, uAOScale: { value: new THREE.Vector2(1, 1) } }; }
const AO_KINDS = new Set(['built', 'ground', 'track', 'bark', 'decal']);
// [A4] the sun's static shadow goes in right after getDirectionalLightInfo, whether or not three has a shadow map
// (by default it has none: no live pass). If some caster keeps a live map (userData.liveShadow), three's own getShadow
// line below still multiplies it in. Only the first directional light (the sun).
const A_DIR_INFO = 'getDirectionalLightInfo( directionalLight, directLight );';
const A_SUN_LINE = 'directLight.color *= receiveShadow ? aSunShadow() : 1.0;';
const A_LIGHTS_BEGIN = THREE.ShaderChunk.lights_fragment_begin.split(A_DIR_INFO).length === 2
  ? THREE.ShaderChunk.lights_fragment_begin.replace(A_DIR_INFO, `${A_DIR_INFO}
		#if UNROLLED_LOOP_INDEX == 0
		${A_SUN_LINE}
		#endif`)
  : null;
if (!A_LIGHTS_BEGIN) console.warn('[A-lighting] three lights_fragment_begin changed: static sun shadows + sun mask disabled');
function aLightingPatch(sh, uniforms, mat, kind) {
  const U = uniforms?.aLight; if (!U) return;
  // [A1] lightmapped material (mat.userData.aLM, set by lmEnable with its own program key): the indirect diffuse is
  // the committed lightmap, vAO (B's weathering + specular occlusion) its aux openness, the sun mask its aux.g
  const lm = !!(mat?.userData?.aLM && U.uLM.value), AO = uniforms.aAO, ssao = !!AO && AO_KINDS.has(kind), pcss = AO_KINDS.has(kind);   // [L5] PCSS: the kinds keyed per program
  Object.assign(sh.uniforms, U); if (AO) Object.assign(sh.uniforms, AO);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>
attribute vec3 aBSun;
attribute vec3 aBSky;
attribute float aSunOcc;
uniform vec3 uSunB;
uniform vec3 uSkyB;
uniform mat4 uFarMat;
uniform mat4 uNearMat;
varying vec3 vBounceA;
varying vec4 vFarC;
varying vec3 vNearC;
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
    vFarC = vec4( ( uFarMat * vec4( aW.xyz + aN * ${SUN_MAPS.far.normal.toFixed(3)}, 1.0 ) ).xyz, 1.0 - aSunOcc );
    vNearC = ( uNearMat * vec4( aW.xyz + aN * ${SUN_MAPS.near.normal.toFixed(3)}, 1.0 ) ).xyz;
  }`);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
uniform sampler2DShadow uFarSM;
uniform sampler2DShadow uNearSM;
uniform sampler2D uNearRaw;
uniform vec4 uPcss;
uniform float uFarOn;
uniform float uSunShOn;
uniform vec2 uFarTexel;
uniform vec2 uNearTexel;
uniform vec3 uSunW;
uniform float uHaze;
uniform sampler2D uHz;
uniform float uHzI;
uniform float uHzOn;
varying vec3 vBounceA;
varying vec4 vFarC;
varying vec3 vNearC;
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
vec3 aLmIrr() { return exp2( mix( vec3( uLMRange.x ), vec3( uLMRange.y ), texture2D( uLM, vLmUv ).rgb ) ) * uLMScale; }
vec3 aUpV() { return normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ); }` : ''}
float aFarShadow() {
  vec3 c = vFarC.xyz;
  if ( uFarOn < 0.5 || c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;
  vec2 t = uFarTexel * 0.5;
  return 0.25 * ( texture( uFarSM, vec3( c.xy - t, c.z ) ) + texture( uFarSM, vec3( c.xy + vec2( t.x, - t.y ), c.z ) )
    + texture( uFarSM, vec3( c.xy + vec2( - t.x, t.y ), c.z ) ) + texture( uFarSM, vec3( c.xy + t, c.z ) ) );
}
// [A4] static near map: 4 hardware-compare bilinear taps at +-0.5 texel (a 3x3-texel tent, ~0.1 m at 5.4 cm texels),
// fading into the far map over the outer 3 % of the near map
float aNearShadow4() {
  vec3 c = vNearC;
  vec2 t = uNearTexel * 0.5;
  return 0.25 * ( texture( uNearSM, vec3( c.xy - t, c.z ) ) + texture( uNearSM, vec3( c.xy + vec2( t.x, - t.y ), c.z ) )
    + texture( uNearSM, vec3( c.xy + vec2( - t.x, t.y ), c.z ) ) + texture( uNearSM, vec3( c.xy + t, c.z ) ) );
}
${pcss ? `// [L5] lighting #4: PCSS on the static near map (built surfaces, ground, tracks, decals). Blocker search: 3x3 plain
// depth taps over +-0.35 m of the low-res copy; none = lit (most sunlit texels stop here). Penumbra = blocker distance
// x 0.012 (sun disc 0.0093 rad + aureole), 1.5 near texels .. 0.6 m, then 16 hardware-compare Poisson taps, rotated
// per pixel (interleaved gradient noise) so the 16 taps band into grain, not rings. Tree shadows soften with height.
const vec2 aPD[16] = vec2[16]( vec2(-0.942, -0.399), vec2(0.946, -0.769), vec2(-0.094, -0.929), vec2(0.345, 0.294),
  vec2(-0.916, 0.458), vec2(-0.815, -0.879), vec2(-0.383, 0.277), vec2(0.975, 0.756), vec2(0.443, -0.975), vec2(0.537, -0.474),
  vec2(-0.265, -0.419), vec2(0.792, 0.191), vec2(-0.242, 0.997), vec2(-0.814, 0.914), vec2(0.200, 0.786), vec2(0.144, -0.141) );
float aNearShadow() {
  if ( uPcss.z < 0.5 ) return aNearShadow4();
  vec3 c = vNearC;
  float rs = 0.35 * uPcss.y, zb = 0.0, nb = 0.0;
  for ( int j = -1; j <= 1; j ++ ) for ( int i = -1; i <= 1; i ++ ) {
    float z = texture2D( uNearRaw, c.xy + vec2( float( i ), float( j ) ) * rs ).r;
    if ( z < c.z - 0.0005 ) { zb += z; nb += 1.0; }
  }
  if ( nb < 0.5 ) return 1.0;
  float d = max( c.z - zb / nb, 0.0 ) * uPcss.x;
  float w = clamp( d * 0.012, 1.5 * uNearTexel.x / uPcss.y, 0.6 ) * 0.5 * uPcss.y;
  float a = 6.2831853 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  mat2 rot = mat2( cos( a ), sin( a ), - sin( a ), cos( a ) );
  float s = 0.0;
  for ( int k = 0; k < 16; k ++ ) s += texture( uNearSM, vec3( c.xy + rot * aPD[k] * w, c.z ) );
  return s * 0.0625;
}` : 'float aNearShadow() { return aNearShadow4(); }'}
float aSunShadow() {
  float s = 1.0;
  if ( uSunShOn > 0.5 ) {
    vec2 e = min( vNearC.xy, 1.0 - vNearC.xy );
    float wN = vNearC.z <= 1.0 ? smoothstep( 0.0, 0.03, min( e.x, e.y ) ) : 0.0;
    s = wN > 0.999 ? aNearShadow() : wN > 0.0 ? mix( aFarShadow(), aNearShadow(), wN ) : aFarShadow();
  }
  return s * smoothstep( 0.05, 0.4, ${lm ? 'aLmX.g' : 'vFarC.w'} );
}`)
    // [L5] the lightmap is non-directional, so a normal map vanished wherever only indirect light falls (the chimney
    // bore showed no brick or mortar). aRel: the normal-mapped normal against the flat one under a sky-from-above
    // irradiance (1 + 0.6 n.up): mortar joints and brick edges read again in shade, flat surfaces are unchanged.
    .replace('#include <aomap_fragment>', `${lm ? `float aRel = clamp( ( 1.0 + 0.6 * dot( normal, aUpV() ) ) / max( 1.0 + 0.6 * dot( nonPerturbedNormal, aUpV() ), 0.2 ), 0.6, 1.5 );
  reflectedLight.indirectDiffuse = aLmIrr() * aRel * BRDF_Lambert( material.diffuseColor ) * aSSAO();`
      : 'reflectedLight.indirectDiffuse += vBounceA * BRDF_Lambert( material.diffuseColor );\n  reflectedLight.indirectDiffuse *= aSSAO();'}
#include <aomap_fragment>`)
    .replace('#include <fog_fragment>', `#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  vec3 aVd = inverseTransformDirection( normalize( - vViewPosition ), viewMatrix );
  // [A4] the horizon sky of this view azimuth (x bgI), so far ground meets the sky and the below-horizon fill without
  // a band; the forward-scatter lobe fades out as the fog closes in (at full fog the colour is exactly the table)
  vec3 aFc = uHzOn > 0.5 ? texture2D( uHz, vec2( atan( aVd.z, aVd.x ) * 0.15915494 + 0.5, 0.5 ) ).rgb * uHzI : fogColor;
  gl_FragColor.rgb = mix( gl_FragColor.rgb, aFc * ( 1.0 + uHaze * pow( max( dot( aVd, uSunW ), 0.0 ), 6.0 ) * ( 1.0 - fogFactor ) ), fogFactor );
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
export const LMUV = { ver: 1, W: 2048, maxH: 2048, texel: 0.2, terrTexel: 0.25, under: 1.5, beam: 2 };   // [L5] under/beam: lmDensity
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
// [L5] lighting #5: texel density multiplier per chart. Slab undersides above 1 m (ceilings, the table, the gallery
// soffits) get LMUV.under, the sides of the downstand beams (vertical 'wall' charts 0.45-0.6 m tall, 1 m+ up) LMUV.beam:
// at 0.2 m the beam sides stepped x2.5-3.6 next to the ceiling (A4's edge probes). Bounded by the atlas: the structure
// texel must stay 0.2 m (lightmapUV2 coarsens everything 8 % per try when the charts don't fit 2048 x maxH).
function lmDensity(key, g, tris) {
  if (key !== 'slab' && key !== 'wall') return 1;
  const p = g.attributes.position.array, idx = g.index.array; let nx = 0, ny = 0, nz = 0, y0 = Infinity, y1 = -Infinity;
  for (const t of tris) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    nx += uy * vz - uz * vy; ny += uz * vx - ux * vz; nz += ux * vy - uy * vx;
    y0 = Math.min(y0, p[a + 1], p[b + 1], p[c + 1]); y1 = Math.max(y1, p[a + 1], p[b + 1], p[c + 1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1; ny /= l;
  if (y0 < 1) return 1;
  if (key === 'slab' && ny < -0.7) return LMUV.under;                            // ceiling / soffit
  if (key === 'wall' && Math.abs(ny) < 0.3 && y1 - y0 > 0.45 && y1 - y0 <= 0.6) return LMUV.beam;   // downstand beam side
  return 1;
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
      ch.dens = lmDensity(key, g, ch.tris);
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
      const nx = Math.round(ch.du * s * ch.dens) + 1, ny = Math.round(ch.dv * s * ch.dens) + 1, rot = ny > nx;
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
const lmURL = (f, base = import.meta.url) => new URL(f, base).href;
export async function lmFetchJSON(file = 'lm.json', base = import.meta.url) {
  try { const r = await fetch(lmURL(file, base), { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch (e) { return null; }
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
// a material that reads the lightmap: own program key (three must not share it with an unlit twin, e.g. far vs terrain)
function lmEnable(mat) {
  if (!mat || mat.userData.aLM) return;
  const k = mat.customProgramCacheKey; mat.userData.aLM = true;
  mat.customProgramCacheKey = () => (k ? k.call(mat) : '') + '|lm';
}

// ---------------------------------------------------------------- [A4] static sun shadow maps (rendered once at load)
// Perf #1 / decision 6: every caster is static, so the camera-following live map (re-rendered 2-5x/s, ~4 ms each, 16
// RGBA-unpack taps per lit fragment) is gone. Two depth maps are rendered once from proxies of the casters:
//   near: fitted in light space to the casters inside `fit` (the site), capped at +-half m, 4096^2 x 16 bit (5.4 cm
//         texels at 110 m), sampled with 4 hardware-compare taps;
//   far:  every caster (+-170 m cap, 2048^2), where the near map ends (as round 3's far map).
// casters: meshes; fit: a Box3 the map must cover (null = the casters' own bounds); opt: { size, half, bias, bits }.
function renderSunMap(renderer, casters, L, fit, opt) {
  const box = fit ? fit.clone() : new THREE.Box3(); if (!fit) for (const o of casters) box.expandByObject(o);
  box.expandByScalar(4);
  const lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), L).normalize(), ly = new THREE.Vector3().crossVectors(L, lx);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], c = new THREE.Vector3();
  for (let k = 0; k < 8; k++) {
    c.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z);
    [c.dot(lx), c.dot(ly), c.dot(L)].forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); });
  }
  const size = opt.size, hx = Math.min(opt.half, (hi[0] - lo[0]) / 2), hy = Math.min(opt.half, (hi[1] - lo[1]) / 2), back = (hi[2] - lo[2]) / 2 + 60;
  const ctr = new THREE.Vector3().addScaledVector(lx, (lo[0] + hi[0]) / 2).addScaledVector(ly, (lo[1] + hi[1]) / 2).addScaledVector(L, (lo[2] + hi[2]) / 2);
  const cam = new THREE.OrthographicCamera(-hx, hx, hy, -hy, 1, 2 * back);
  cam.position.copy(ctr).addScaledVector(L, back); cam.up.set(0, 1, 0); cam.lookAt(ctr); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
  const dt = new THREE.DepthTexture(size, size); dt.type = opt.bits === 16 ? THREE.UnsignedShortType : THREE.UnsignedIntType;
  dt.compareFunction = THREE.LessEqualCompare; dt.minFilter = dt.magFilter = THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(size, size, { depthTexture: dt, depthBuffer: true, format: THREE.RedFormat, type: THREE.UnsignedByteType, generateMipmaps: false });
  const px = shadowProxies(casters), prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); renderer.clear(true, true, true); renderer.render(px.scene, cam); renderer.setRenderTarget(prev);
  px.dispose();
  rt.depthTexture = null; rt.dispose();   // keep only the depth texture (frees the FBO and the colour plane)
  let raw = null;
  if (opt.raw) {   // [L5] a plain (no compare) low-res depth copy of the same view for the PCSS blocker search
    raw = new THREE.DepthTexture(opt.raw, opt.raw); raw.type = THREE.UnsignedShortType; raw.minFilter = raw.magFilter = THREE.NearestFilter;
    const rr = new THREE.WebGLRenderTarget(opt.raw, opt.raw, { depthTexture: raw, depthBuffer: true, format: THREE.RedFormat, type: THREE.UnsignedByteType, generateMipmaps: false });
    const pr = shadowProxies(casters);
    renderer.setRenderTarget(rr); renderer.clear(true, true, true); renderer.render(pr.scene, cam); renderer.setRenderTarget(prev);
    pr.dispose(); rr.depthTexture = null; rr.dispose();
  }
  const M = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  M.elements[14] -= opt.bias / (2 * back - 1);   // depth bias in metres (plus the normal offset in the shader)
  return { tex: dt, raw, M, size, texel: (2 * Math.max(hx, hy)) / size, half: [+hx.toFixed(1), +hy.toFixed(1)], depthM: 2 * back - 1, uvPerM: 1 / (2 * Math.max(hx, hy)) };
}
// a 1x1 compare texture cleared to the far plane: what a sampler2DShadow sees when there is no map (an unbound shadow
// sampler makes ANGLE drop the draw; three never uploads its null fallback)
function blankSunMap(renderer) {
  const dt = new THREE.DepthTexture(1, 1); dt.type = THREE.UnsignedShortType; dt.compareFunction = THREE.LessEqualCompare; dt.minFilter = dt.magFilter = THREE.NearestFilter;
  const rt = new THREE.WebGLRenderTarget(1, 1, { depthTexture: dt, depthBuffer: true, format: THREE.RedFormat, type: THREE.UnsignedByteType, generateMipmaps: false });
  const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.clear(true, true, true); renderer.setRenderTarget(prev);
  rt.depthTexture = null; rt.dispose();
  return dt;
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
// Runs right after aLightingPatch (inside weatherPatch's [A-lighting] block): needs its sun line ([A4] A_SUN_LINE).
function aSkyShadowPatch(sh, uniforms) {
  const U = uniforms?.aSky; if (!U || !sh.fragmentShader.includes(A_SUN_LINE)) return;
  Object.assign(sh.uniforms, U);
  sh.fragmentShader = sh.fragmentShader.replace('void main() {', `${A2_RING_GLSL}\nvoid main() {`)
    .replace(A_SUN_LINE, A_SUN_LINE.replace('? aSunShadow()', '? aRingShadow() * aSunShadow()'));
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
  scene.fog = new THREE.Fog(sk.fogColor.clone().multiplyScalar(bgI), 40, 2600);   // [A4] = the horizon table's mean (non-patched materials)
  return bgI;
}
// [A4] horizon colour per azimuth (decision 7, lighting #4, graphics #4). One fog colour averaged over every direction
// was up to 1.7x the horizon sky on the dim side (the HDR's horizon runs 0.25-0.85 by azimuth), so from altitude the
// fogged far ground and the below-horizon fill showed as a white band (luma 227 over sky 188). Now the fog converges, per
// view azimuth, to the sky 0.25-1.5 deg above the horizon in that azimuth (blurred +-3 deg so clouds don't streak), and
// the background below the horizon is the same table: far ground, fill and the sky row above meet without a seam.
// HZ_N bins over atan2(z, x); `world` is in the world frame (rotY applied), for the shader; `hdr` in the HDR's own frame.
const HZ_N = 512, HZ_LAT = [0.25, 1.5], HZ_BLUR = 3;
function horizonTable(data, W, H, ch, rotY) {
  const hdr = new Float64Array(HZ_N * 3), cnt = new Float64Array(HZ_N);
  const r0 = Math.floor((0.5 - HZ_LAT[1] / 180) * H), r1 = Math.ceil((0.5 - HZ_LAT[0] / 180) * H);
  for (let py = r0; py <= r1; py++) for (let px = 0; px < W; px++) {
    const b = Math.min(HZ_N - 1, Math.floor((px + 0.5) / W * HZ_N)), i = (py * W + px) * ch;
    hdr[b * 3] += data[i]; hdr[b * 3 + 1] += data[i + 1]; hdr[b * 3 + 2] += data[i + 2]; cnt[b]++;
  }
  for (let b = 0; b < HZ_N; b++) for (let c = 0; c < 3; c++) hdr[b * 3 + c] /= Math.max(1, cnt[b]);
  // circular Gaussian blur in azimuth
  const sig = HZ_BLUR / 360 * HZ_N, R = Math.ceil(sig * 3), K = Array.from({ length: 2 * R + 1 }, (_, k) => Math.exp(-((k - R) ** 2) / (2 * sig * sig)));
  const ks = K.reduce((a, v) => a + v, 0), bl = new Float32Array(HZ_N * 3);
  for (let b = 0; b < HZ_N; b++) for (let c = 0; c < 3; c++) { let s = 0; for (let k = -R; k <= R; k++) s += K[k + R] * hdr[(((b + k) % HZ_N + HZ_N) % HZ_N) * 3 + c]; bl[b * 3 + c] = s / ks; }
  // HDR bin of texture azimuth phi: bin = (phi / 2pi + 0.5) * N (equirectDir: phi = ((px + 0.5) / W - 0.5) * 2pi).
  // A world direction at azimuth phiW shows texture azimuth phiW + rotY (R(-rotY) turns atan2(z, x) by +rotY).
  const at = (tab, phi) => { let u = (phi / (2 * Math.PI) + 0.5) * HZ_N - 0.5; u -= Math.floor(u / HZ_N) * HZ_N; const i0 = Math.floor(u), f = u - i0, i1 = (i0 + 1) % HZ_N; return [0, 1, 2].map((c) => tab[i0 * 3 + c] * (1 - f) + tab[i1 * 3 + c] * f); };
  const world = new Float32Array(HZ_N * 3);
  for (let b = 0; b < HZ_N; b++) { const v = at(bl, ((b + 0.5) / HZ_N - 0.5) * 2 * Math.PI + rotY); world[b * 3] = v[0]; world[b * 3 + 1] = v[1]; world[b * 3 + 2] = v[2]; }
  const mean = [0, 1, 2].map((c) => { let s = 0; for (let b = 0; b < HZ_N; b++) s += bl[b * 3 + c]; return s / HZ_N; });
  return { hdr: bl, world, mean, at: (phi) => at(bl, phi) };
}
export async function loadSky(def, renderer, { envI = skyEnvI(def), groundAlb = ALB_FALLBACK.ground, haze = 1.2, onProgress } = {}) {
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
  // [A4] the horizon table (sun already clamped out of `data`); fogC = its azimuth mean (round 3: 0.5-5 deg mean, `fog`)
  const hzT = horizonTable(data, W, H, ch, def.rotY || 0);
  const fogC = new THREE.Color(...hzT.mean), fogOld = [fog[0] / fogN, fog[1] / fogN, fog[2] / fogN];
  const sst = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const H1 = THREE.DataUtils.toHalfFloat(1);
  // background: below the horizon = what the fog converges to: [A4] the horizon table of that azimuth (round 3: one
  // mean fog colour x the haze lobe), blended in from 1 deg above the horizon
  // [A2] plus the capped sun disc (stored / bgI, so it shows at def.disc after scene.backgroundIntensity)
  const half = new Uint16Array(W * H * 4);
  const discL = def.sunRatio > 0 && def.disc > 0 ? def.disc / (def.bgI || 1) : 0, texAng = Math.PI / H, latSun = Math.asin(L.y);
  const hzPx = new Float32Array(W * 3); for (let px = 0; px < W; px++) { const v = hzT.at(((px + 0.5) / W - 0.5) * 2 * Math.PI); hzPx[px * 3] = v[0]; hzPx[px * 3 + 1] = v[1]; hzPx[px * 3 + 2] = v[2]; }
  let discN = 0;
  for (let py = 0; py < H; py++) {
    const lat = latOf(py), t = sst(1.0, 0.0, lat * 180 / Math.PI), cl = Math.cos(lat), sl = Math.sin(lat);
    const discRow = discL > 0 && Math.abs(lat - latSun) < SUN_R + 2 * texAng;
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * ch, o = (py * W + px) * 4;
      let r = data[i], g = data[i + 1], b = data[i + 2];
      if (t > 0) { r += (hzPx[px * 3] - r) * t; g += (hzPx[px * 3 + 1] - g) * t; b += (hzPx[px * 3 + 2] - b) * t; }
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
    'fog', [fogC.r, fogC.g, fogC.b].map((v) => +v.toFixed(3)), 'fog r3 (0.5-5 deg mean)', fogOld.map((v) => +v.toFixed(3)), 'envI', +envI.toFixed(3), 'ground', gR.map((v) => +v.toFixed(3)), 'maxL', +maxL.toFixed(0), 'disc texels', discN);
  // [A4] the world-frame horizon table as a 512x1 half-float texture (linear, wraps in azimuth) for the fog patch
  const hzHalf = new Uint16Array(HZ_N * 4);
  for (let b = 0; b < HZ_N; b++) { for (let c = 0; c < 3; c++) hzHalf[b * 4 + c] = THREE.DataUtils.toHalfFloat(hzT.world[b * 3 + c]); hzHalf[b * 4 + 3] = H1; }
  const hzTex = new THREE.DataTexture(hzHalf, HZ_N, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  hzTex.colorSpace = THREE.LinearSRGBColorSpace; hzTex.magFilter = hzTex.minFilter = THREE.LinearFilter; hzTex.generateMipmaps = false; hzTex.wrapS = THREE.RepeatWrapping; hzTex.wrapT = THREE.ClampToEdgeWrapping; hzTex.needsUpdate = true;
  return { sky, env, sunDir: L, sunColor, sunI, sunE: Ei, skyE, fogColor: fogC, discTexels: discN, horizon: { tex: hzTex, world: hzT.world, mean: hzT.mean } };
}
// ---------------------------------------------------------------- [S0] site bake kit
// The per-vertex light bake, the lightmap probe bake and the build-time light probe read the site's materials
// (MATS[k].albedo, MATS.apron / ground / grass / path), its terrain height and its path distance field. One kit per
// site module: siteBake({ MATS, terrainHeight, distToPaths }) -> { albedoOf, groundAlbedo, lightProbe, bakeLight,
// lmProbeBake, setBake }. setBake(b) sets (and returns) the probe solution lightProbe() reads (null frees it).
export function siteBake({ MATS = {}, terrainHeight = () => 0, distToPaths = () => Infinity } = {}) {
const albedoOf = (k) => MATS[k]?.albedo ?? ALB_FALLBACK[k] ?? ALB_DEFAULT;
function groundAlbedo() { const g = MATS.ground?.albedo, s = MATS.grass?.albedo; return g && s ? g.map((v, i) => (v + s[i]) / 2) : g ?? s ?? ALB_FALLBACK.ground; }
let BAKE = null;
function lightProbe(bvh, p, n, maxD, rays) {
  if (!BAKE) { LP.out.set(0, 0, 0); return skyVisibility(bvh, p, n, maxD, rays); }
  const r = BAKE.probe(p, n, Math.max(4, rays), maxD);
  if (r.out) LP.out.set(r.out[0], r.out[1], r.out[2]);   // [A1] lightmap probe: final units already
  else LP.out.set(r.bs[0] * LP.sunRGB.x + r.bk[0] * LP.skyRGB.x, r.bs[1] * LP.sunRGB.y + r.bk[1] * LP.skyRGB.y, r.bs[2] * LP.sunRGB.z + r.bk[2] * LP.skyRGB.z);
  return r.open;
}
async function bakeLight(geo, { sunDir, sun = true, quality = 'auto', onTick } = {}) {
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
const setBake = (b) => (BAKE = b);
return { albedoOf, groundAlbedo, lightProbe, bakeLight, lmProbeBake, setBake };
}

// ---------------------------------------------------------------- [S0] collider + dispose
// the take / proximity scene: the exact collision mesh, never drawn (main.js renders it for the OLED proximity bars)
export function colliderScene(colGeo) {
  const s = new THREE.Scene(), m = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial()); m.frustumCulled = false; s.add(m);
  return s;
}
// Free everything a world put on the GPU: geometries, materials, every texture a material holds (maps, uniforms, the
// aNearShadowTex-style slots), render targets, scene background / environment. Returns counts (the ?perf readout).
export function disposeObject(root, seen = { geo: new Set(), mat: new Set(), tex: new Set(), rt: new Set() }) {
  if (!root) return seen;
  const tex = (v) => {
    if (!v) return;
    if (v.isTexture) seen.tex.add(v);
    else if (v.isWebGLRenderTarget || v.isRenderTarget) seen.rt.add(v);
    else if (Array.isArray(v)) v.forEach(tex);
  };
  const mat = (m) => {
    if (!m || seen.mat.has(m)) return; seen.mat.add(m);
    for (const v of Object.values(m)) tex(v);
    for (const u of Object.values(m.uniforms || {})) tex(u?.value);
    for (const u of Object.values(m.userData?.wu || {})) tex(u?.value);
  };
  root.traverse?.((o) => {
    if (o.geometry) seen.geo.add(o.geometry);
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(mat);
    if (o.customDepthMaterial) mat(o.customDepthMaterial);
    if (o.isLight && o.shadow?.map) seen.rt.add(o.shadow.map);
  });
  tex(root.background); tex(root.environment);
  for (const g of seen.geo) g.dispose?.();
  for (const m of seen.mat) m.dispose?.();
  for (const t of seen.tex) t.dispose?.();
  for (const r of seen.rt) r.dispose?.();
  return seen;
}

export { PH, rng, yieldUI, fastYield, planarUV, boxGeo, cylGeo, setAY, hash2, flip, indexify, wallWithHoles, tubeGeo, ringGeo, hashStr, subRng, Y_UP,
  px1, flatTex, flatNorm, GLSL_NOISE, GRASS_HASH, GRASS_LIGHTS, LIGHT_MAPS_DIFFUSE, VEG_GLSL, VEG_CARD_VS, VEG_LEAF_LIGHTS, depthC2Mat, depthC2Opaque,
  ALB_DEFAULT, ALB_FALLBACK, aoCurve, LP, skyVisibility, cosPattern, colliderMap, fineVerts, weldGraph, lightUniforms, aoUniforms, AO_KINDS,
  aLightingPatch, GeoHash, lmImage, lmLoad, lmSampler, lmEnable, renderSunMap, blankSunMap, shadowProxies, skyShadowUniforms, aSkyShadowPatch,
  renderRingShadow, horizonTable };
