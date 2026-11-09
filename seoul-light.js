// seoul-light.js: night light transport for Neon Seoul (S3 phase 1; stream D phase 2). Contracts: L2
// `seoulLight.attach(world, emitters, ctx)`, L3 emitter records (nits), and this file's exportData() for the native port.
//
// Units. Night worlds are scene-linear at NITS = 0.1 scene units per cd/m2 (and per lux: three's radiance = E x albedo / PI).
//
// What it builds (phase 2 changes marked P2):
// - A 2.5D clustered light grid over the block: XZ cells of `cell` m, each holding the K strongest STATIC emitters (score =
//   irradiance bound at the cell x visibility). P2: screens and other in-place animated emitters are binned ONCE with the
//   static ones; per frame only their colour row is uploaded (one texel each). P2: moving emitters (vehicles) go into a
//   camera-centred window grid: the NEAREST/BRIGHTEST Nd lamps (default 64 = the ~32 nearest vehicles) are rebinned into
//   typed scratch arrays every frame and uploaded with update ranges (a few KB, no allocation).
// - P2 records are 2 RGBA32UI texels (position, area/omni, oct normal, half-float intensity/range, lobe + colour index +
//   flicker bits); grid cells hold uint16 ids. Lights past the 4th in a cell (2nd dynamic) are Lambert-only (no GGX).
// - P2 lobes: 0 Lambert/omni face; 1 street head (type-II forward throw, flux from `lumens`); 2 low-beam fan (headlights,
//   25 m with a cutoff). Lobe integrals are normalised on load so every lamp emits exactly its declared flux.
// - P2 visibility: a 2.5D heightfield of the lots (2 m raster) is marched from each emitter to each cell it bins into
//   (4 heights), so light no longer leaks through buildings; occluded pairs are dropped or down-weighted.
// - P2 night irradiance volume (lighting #1): probes at every cell centre at VOLUME.heights (P3: 8 layers, 0.5-50 m) hold, as ambient + L1
//   direction, (a) the direct light of every emitter NOT in that cell's top-K (the grid's residual, so K can be 8),
//   (b) one bounce off the ground (by street kind) and the canyon walls, (c) the sky dome through the heightfield horizon.
//   Sampled with hardware trilinear filtering (RGBA16F 3D textures) as the materials' indirect diffuse, times the SSAO
//   fpvcam already computes (world.aoUniforms). The 1.5 lux hemisphere stand-in is retired.
// - Wet asphalt: a mirrored emitter-only pass (cards + black occluders + night sky) at 1/4 res, streak-blurred; P2 the
//   occluders are the collider split into cells, only those within 60 m drawn; every vehicle card is live.
// - P2 air (lighting #3): height haze 0.006/m over 30 m, in-scattering the volume's fluence (surface and ray midpoint), and
//   closed-form single-scatter airlight (point source, isotropic phase) round the 16 brightest emitters in view as
//   depth-tested camera sprites.
// - P2 headlight pools (lighting #4): G's 'headlight-pools' quads get this file's material: a 1.5-nit low-beam fan, 25 m,
//   with a cutoff, faded by wetness and faded OUT for the vehicles the grid already lights (no double count).
// - P2 city culling (perf #3): world meshes ('seoul:*') are vertex-deduped, indexed and split into `cullCell` m cells per
//   material (shared buffers + draw ranges, so one upload); the collider is split the same way for fpvcam's depth pass.
// - Night sky dome, steam (P2: 96 px cap, fade inside 1.5 m).
// P3 (stream D): radiometry stays luminance-true on the light side: L3 `nits` is the record's mean luminance and `rgb`
// its chromaticity (B's records carry the filter model in their nits: white-equivalent x luma(rgb/max)); brown-grey sky,
// haze by street kind, airlight halos <= 3 m, none within 4 m of the lens, channel-capped at 2x a street lamp; the
// volume at 8 layers; night lightmaps (seoul-nightlm.js, a Worker); one BatchedMesh per material for the city and one
// for the collider (draw calls); a visibility API for G1's crowd culling; world.qualityCap (scale 1.0, phone preset).
//
// Contract for C (world-seoul.js): call attach() after the world's materials exist and before warm-up; ctx.layout (lots
// with floors/floorH, streets) feeds the heightfield. Materials opt out with material.userData.cityLight === false; ground
// materials opt in to the wet path with userData.wet or a road/asphalt/ground/street/lane name. Emitters are L3 records;
// moving ones (kind 'vehicle', e.dynamic or e.moving) and in-place animated ones (e.animated) are re-read every update().
// Optional fields read here: lumens (street lamps), forward [x,0,z] (street lamp arm direction; else the nearest street),
// beam {lumens} (headlights, default 1400 lm at 20,000 nits), nitsMax (animated: binning nominal).
import * as THREE from 'three';
import { sstep, lobeStreet, lobeBeam, planLM, bakeLM, packMeta, MS as LM_MS, NIGHT_LM } from './seoul-nightlm.js';
export { NIGHT_LM };

export const NITS = 0.1;                      // scene units per cd/m2 (night worlds)
const LUMA = [0.2126, 0.7152, 0.0722];
const lumaOf = (c) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];

// Source types (P2: the panel's binding luminance hierarchy). Defaults when an emitter omits a field: luminance (cd/m2, rect
// mean), colour (linear), omni (0 = Lambertian one-sided face, 1 = all round), range (m).
export const SOURCE_TYPES = {
  channel:  { nits: 1000,  rgb: [1.0, 1.0, 1.0],   omni: 0.15, range: 26 },   // LED channel-letter cores 600-2000
  lightbox: { nits: 160,   rgb: [1.0, 0.97, 0.92], omni: 0.0,  range: 24 },   // light-box faces 100-220
  neon:     { nits: 1000,  rgb: [1.0, 0.25, 0.55], omni: 0.7,  range: 18 },   // glass neon / LED flex 600-2000
  screen:   { nits: 260,   rgb: [0.8, 0.9, 1.0],   omni: 0.0,  range: 32 },   // LED video walls 180-350
  street:   { nits: 9000,  rgb: [1.0, 0.82, 0.62], omni: 0.0,  range: 34 },   // LED street head (flux from `lumens`)
  store:    { nits: 80,    rgb: [0.9, 0.97, 1.0],  omni: 0.0,  range: 16 },   // shop interiors through glass 30-130
  tent:     { nits: 120,   rgb: [1.0, 0.55, 0.25], omni: 0.4,  range: 12 },   // pojangmacha tarp lit from inside
  vehicle:  { nits: 20000, rgb: [1.0, 0.95, 0.88], omni: 0.0,  range: 40 },   // head lamps (beam lobe, 25 m pool); tails ~250-1500 red
  // P3 lighting #4 (main-road architecture; C places them, contract P3-CD): a tower's glazed podium lobby (80-150 nits,
  // the record is the glass face) and a roof-crown flood (a wash up the top floors: the record faces the wall, tilted
  // up, w x h = the lit band; nits = the band's mean luminance as seen, ~15-40)
  lobby:    { nits: 110,   rgb: [1.0, 0.93, 0.82], omni: 0.1,  range: 22 },
  crown:    { nits: 30,    rgb: [0.95, 0.97, 1.0], omni: 0.0,  range: 30 },
};
// Night sky (plan-L5 2F; P3 lighting #5 / color #4): zenith and horizon radiance in cd/m2. Seoul's sky at 1 am is the
// city's own sodium/LED light scattered by a low deck: brown-grey overhead, orange-brown at the horizon, never blue.
export const NIGHT_SKY = { zenith: [0.07, 0.06, 0.05], horizon: [0.5, 0.32, 0.18], glowH: 0.18 };
// Air (lighting #3; P3 #5): haze extinction (1/m), scale height (m), scatter albedo, max opacity; byKind: the extinction
// over each street kind (grill smoke and a closed canyon on the walking and club streets, open air on the main road),
// blended over 8 m and stored per probe as a factor of `density`; airlight sprites. P3: an airlight sprite's radius is
// capped at maxR (3 m: a halo round the lamp, not a cloud over the facade), none within nearM of the camera (fades in
// over fadeM), and a source's brightest channel is capped at lampCap x the median street lamp's (no violet clouds).
export const HAZE = { density: 0.006, height: 30, scatter: 1.0, max: 0.6, byKind: { walking: 0.008, club: 0.0075, alley: 0.006, main: 0.004 } };
export const AIRLIGHT = { count: 16, maxR: 3, minL: 0.004, gain: 1.0, nearM: 4, fadeM: 2, lampCap: 2 };
// Irradiance volume (lighting #1): probe heights, albedos for the one bounce.
// windowNits: the mean emission of the facades a probe faces at each probe height (lit windows are not L3 emitters: binding
// table 55 % lit on floors 2-4, 12-20 % above, 5-25 nits, ~25 % of a wall is glass); multi: 1 / (1 - mean albedo) for the
// bounces past the first.
// P3 graphics #4: 8 layers (0.5 ... 50 m) so the upper facades and the towers get their own probes, not a 12-30 m blend.
export const VOLUME = { heights: [0.5, 2.5, 5, 8, 12, 18, 30, 50], rhoRoad: 0.12, rhoWalk: 0.22, rhoWall: 0.3, rasterM: 2, windowNits: [0.3, 1.2, 1.6, 1.5, 1.2, 0.8, 0.5, 0.3], windowRGB: [1.0, 0.86, 0.7], multi: 1.25 };
// fractional layer index of a height (piecewise linear between VOLUME.heights): JS and GLSL
export function layerOf(y, H = VOLUME.heights) { if (y <= H[0]) return 0; for (let k = 1; k < H.length; k++) if (y < H[k]) return k - 1 + (y - H[k - 1]) / (H[k] - H[k - 1]); return H.length - 1; }
const LAYER_GLSL = (H) => `float cityLayer(float y){ ${H.slice(1).map((h, k) => `if (y < ${h.toFixed(2)}) return ${k.toFixed(1)} + (y - ${H[k].toFixed(2)}) / ${(h - H[k]).toFixed(2)};`).join(' ')} return ${(H.length - 1).toFixed(1)}; }`;
// Headlights (lighting #4): low-beam flux per vehicle at the reference 20,000 nits; pool peak luminance (cd/m2 x I).
export const HEADLIGHT = { lumens: 1400, refNits: 20000, poolNits: 1.5, poolLen: 25 };

// Mean radiance over an emitter's w x h rect (scene units, linear rgb). L3 nits are the rect mean (S2: face x coverage).
export function emitterRadiance(e, out = [0, 0, 0], nitScale = NITS) {
  const T = SOURCE_TYPES[e.kind] || SOURCE_TYPES.lightbox;
  const c = e.rgb || T.rgb, l = Math.max(1e-4, lumaOf(c)), L = (e.nits ?? T.nits) * nitScale / l;
  out[0] = c[0] * L; out[1] = c[1] * L; out[2] = c[2] * L;
  return out;
}

// P3 perf #4/#6: Seoul's render-scale cap and the phone preset (contract for main.js: applySettings caps
// fpv.setQualityRange(q.min, min(q.max, world.qualityCap.max)) and takes msaa from the preset; perf.js &preset=phone).
export const SEOUL_QUALITY = { auto: { max: 1.0, msaa: 4, crowd: 'auto', light: 'auto' }, phone: { max: 0.9, msaa: 2, crowd: 'low', light: 'low' } };
const QUALITY = {
  low:  { K: 4,  Kd: 4, Nd: 32, refl: 0.2,  steam: 60,  air: 8 },
  auto: { K: 8,  Kd: 4, Nd: 64, refl: 0.25, steam: 120, air: 16 },
  high: { K: 12, Kd: 8, Nd: 96, refl: 0.33, steam: 200, air: 16 },
};
const LW = 256;             // lights per record-texture row (2 texels each)
const E_MIN = 0.01;         // irradiance (scene units, = 0.1 lux) below which a light is out of range
const NONE = 0xffff;        // empty grid slot
const DW = 48;              // dynamic window, cells per side (192 m at 4 m cells)
const LT = { lambert: 0, street: 1, beam: 2 };

// ------------------------------------------------------------------------------------------------- lobes (JS == GLSL)
// D = unit direction lamp -> point; f = the lamp's horizontal forward (street: arm toward the road; beam: heading).
// lobes: one JS copy in seoul-nightlm.js (pure, Worker-safe); the GLSL mirror is CITY_HEAD's cityStreet / cityBeam
// integral of a lobe over the sphere (sr), f = +x (tests/seoul-light.mjs re-derives the constants below)
export function lobeIntegral(fn) {
  const NT = 720, NP = 720; let s = 0;
  for (let i = 0; i < NT; i++) {
    const th = (i + 0.5) / NT * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    let r = 0; for (let j = 0; j < NP; j++) { const ph = (j + 0.5) / NP * 2 * Math.PI; r += fn(st * Math.cos(ph), ct, st * Math.sin(ph), 1, 0); }
    s += r * st;
  }
  return s * (Math.PI / NT) * (2 * Math.PI / NP);
}
const OMEGA = { street: 12.3205, beam: 0.110828 };   // sr: lobeIntegral(lobeStreet), lobeIntegral(lobeBeam) (~0.2 s to derive)
const omega = () => OMEGA;
export const LOBES = { street: lobeStreet, beam: lobeBeam };

// ------------------------------------------------------------------------------------------------- packing helpers
const _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
const fbits = (v) => { _f32[0] = v; return _u32[0]; };
const half = (v) => THREE.DataUtils.toHalfFloat(Math.max(-65000, Math.min(65000, v)));
const h2 = (a, b) => (half(a) | (half(b) << 16)) >>> 0;
const sn16 = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767) & 0xffff;
function oct(x, y, z) {
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1; let u = x / s, v = y / s;
  if (z < 0) { const ou = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1), ov = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1); u = ou; v = ov; }
  return (sn16(u) | (sn16(v) << 16)) >>> 0;
}

// ------------------------------------------------------------------------------------------------- heightfield (2.5D)
// Lots rasterised at `res` m (cell centre inside the footprint -> building height + parapet). Node-safe.
export function heightField(layout, x0, z0, x1, z1, res = VOLUME.rasterM) {
  const nx = Math.max(1, Math.ceil((x1 - x0) / res)), nz = Math.max(1, Math.ceil((z1 - z0) / res));
  const H = new Float32Array(nx * nz);
  for (const l of layout?.lots || []) {
    const P = l.footprint; if (!P || P.length < 3) continue;
    const h = (l.floors || 1) * (l.floorH || 3.2) + 0.9;
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const [x, z] of P) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
    const i0 = Math.max(0, Math.floor((bx0 - x0) / res)), i1 = Math.min(nx - 1, Math.floor((bx1 - x0) / res));
    const j0 = Math.max(0, Math.floor((bz0 - z0) / res)), j1 = Math.min(nz - 1, Math.floor((bz1 - z0) / res));
    for (let j = j0; j <= j1; j++) {
      const z = z0 + (j + 0.5) * res;
      for (let i = i0; i <= i1; i++) {
        const x = x0 + (i + 0.5) * res; let c = false;
        for (let a = 0, b = P.length - 1; a < P.length; b = a++) { const [xa, za] = P[a], [xb, zb] = P[b]; if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) c = !c; }
        if (c && h > H[j * nx + i]) H[j * nx + i] = h;
      }
    }
  }
  const at = (x, z) => { const i = Math.floor((x - x0) / res), j = Math.floor((z - z0) / res); return i < 0 || j < 0 || i >= nx || j >= nz ? 0 : H[j * nx + i]; };
  // visibility from a (light) to b (probe column) at heights ys[k]: bit k set = occluded. The first `skipA` m (the light's
  // own facade) and the last `skipB` m are not tested.
  function occ(ax, ay, az, bx, bz, ys, skipA = 1.5, skipB = 1.0) {
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz), nk = ys.length, all = (1 << nk) - 1;
    if (len < skipA + skipB) return 0;
    const t0 = skipA / len, t1 = 1 - skipB / len;
    let px = (ax + dx * t0 - x0) / res, pz = (az + dz * t0 - z0) / res;
    let i = Math.floor(px), j = Math.floor(pz);
    const ex = (ax + dx * t1 - x0) / res, ez = (az + dz * t1 - z0) / res, ie = Math.floor(ex), je = Math.floor(ez);
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const ddx = dx !== 0 ? res / Math.abs(dx) : Infinity, ddz = dz !== 0 ? res / Math.abs(dz) : Infinity;   // segment param per raster cell
    let tx = dx !== 0 ? (sx > 0 ? i + 1 - px : px - i) * ddx : Infinity, tz = dz !== 0 ? (sz > 0 ? j + 1 - pz : pz - j) * ddz : Infinity;
    let tc = 0, mask = 0; const T = t1 - t0;
    for (let n = 0; n < 4096; n++) {
      const tn = Math.min(tx, tz, T);
      if (i >= 0 && j >= 0 && i < nx && j < nz) {
        const h = H[j * nx + i];
        if (h > 0) {
          const ta = t0 + tc, tb = t0 + tn;
          for (let k = 0; k < nk; k++) { if (mask & (1 << k)) continue; const y = Math.min(ay + (ys[k] - ay) * ta, ay + (ys[k] - ay) * tb); if (h > y) mask |= 1 << k; }
          if (mask === all) return mask;
        }
      }
      if ((i === ie && j === je) || tn >= T) break;
      if (tx < tz) { i += sx; tc = tx; tx += ddx; } else { j += sz; tc = tz; tz += ddz; }
    }
    return mask;
  }
  // horizon per probe column: sky openness (mean cos^2 of the horizon elevation, 8 azimuths, 40 m) and canyon (share of
  // azimuths with a wall above the probe within 12 m), for each height
  function horizon(x, z, ys, oOut, cOut) {
    const nk = ys.length; for (let k = 0; k < nk; k++) { oOut[k] = 0; cOut[k] = 0; }
    for (let a = 0; a < 8; a++) {
      const ux = Math.cos(a * Math.PI / 4), uz = Math.sin(a * Math.PI / 4);
      const mt = new Float32Array(nk), wall = new Uint8Array(nk);
      for (let s = res; s <= 40; s += res) {
        const h = at(x + ux * s, z + uz * s); if (h <= 0) continue;
        for (let k = 0; k < nk; k++) { const t = (h - ys[k]) / s; if (t > mt[k]) mt[k] = t; if (s <= 12 && h > ys[k]) wall[k] = 1; }
      }
      for (let k = 0; k < nk; k++) { oOut[k] += 1 / (1 + mt[k] * mt[k]) / 8; cOut[k] += wall[k] / 8; }
    }
  }
  return { H, nx, nz, res, x0, z0, at, occ, horizon };
}

// ------------------------------------------------------------------------------------------------- GLSL
const CITY_HEAD = /* glsl */`
uniform highp usampler2D tCityL;   // static light records, 2 RGBA32UI texels each
uniform highp usampler2D tCityG;   // static grid: K/4 RGBA16UI texels per cell (light ids, 65535 = none)
uniform highp usampler2D tCityLD;  // dynamic light records
uniform highp usampler2D tCityGD;  // dynamic window grid
uniform highp sampler2D tCityLC;   // animated colours (one texel per in-place animated light)
uniform highp sampler3D tCityIrrA; // volume: ambient rgb, haze fluence
uniform highp sampler3D tCityIrrB; // volume: L1 direction / ambient luminance, sky openness
uniform vec4 uCityGrid;            // x0, z0, 1/cell, cell
uniform vec4 uCityDim;             // gw, gh, K/4, KD/4
uniform vec4 uCityDyn;             // window origin cell x, z, window size, live static K/4 limit (0 = all; P3 phone preset)
uniform float uCityTime;
uniform float uCityGain;
uniform float uCityIrrGain;
uniform vec4 uCityHaze;            // density (1/m), height scale (m), scatter albedo, max
uniform vec3 uCitySkyGlow;         // haze colour with no local light (sky glow at the horizon, scene units)
uniform sampler2D uCityAO; uniform float uCityAOOn; uniform vec2 uCityAOScale;   // fpvcam's SSAO (contract C3)
uniform vec4 uCityLM;              // P3 night lightmap: on, ground m/texel, facade m/texel, near (m)
uniform vec4 uCityLMG;             // ground map x0, z0, texels w, h (the raster shares x0, z0 at 1 m)
uniform vec4 uCityLMA;             // facade atlas w, h, raster w, h
uniform highp sampler2D tCityLMG; uniform highp sampler2D tCityLMA; uniform highp usampler2D tCityLMR; uniform highp sampler2D tCityLME;
bool cityLMOn = false;
vec3 cityOct(vec2 e){ vec3 v = vec3(e, 1.0 - abs(e.x) - abs(e.y)); if (v.z < 0.0) v.xy = (1.0 - abs(v.yx)) * (step(0.0, v.xy) * 2.0 - 1.0); return normalize(v); }
float cityStreet(vec3 D, vec3 f){ float c = -D.y; if (c <= 1e-4) return 0.0; float hl = length(D.xz), t = hl / c;
  float fw = hl > 1e-5 ? dot(D.xz, f.xz) / hl : 0.0; float tc = fw >= 0.0 ? mix(3.1, 1.75, fw) : mix(3.1, 0.7, -fw);
  return min(1.0 / (c * c * c), 30.0) * (1.0 - smoothstep(tc * 0.8, tc * 1.15, t)); }
float cityBeam(vec3 D, vec3 f){ float fw = dot(D.xz, f.xz); if (fw <= 1e-4) return 0.0;
  float th = (D.x * f.z - D.z * f.x) / fw, tv = D.y / fw, dv = tv + 0.035, sv = dv > 0.0 ? 0.05 : 0.16;
  return exp(-(th * th) / 0.1764) * exp(-(dv * dv) / (sv * sv)) * (1.0 - smoothstep(-0.02, 0.015, tv)); }
vec3 cityWorldPos(vec3 pv){ return transpose(mat3(viewMatrix)) * (pv - viewMatrix[3].xyz); }
void cityOne(const in highp usampler2D tl, int idx, bool spec, bool lmSkip, vec3 wp, vec3 geometryPosition, vec3 geometryNormal, vec3 geometryViewDir, vec3 geometryClearcoatNormal, PhysicalMaterial material, inout ReflectedLight reflectedLight){
  ivec2 b0 = ivec2((idx & ${LW - 1}) * 2, idx >> 8);
  uvec4 ra = texelFetch(tl, b0, 0), rb = texelFetch(tl, b0 + ivec2(1, 0), 0);
  vec3 P = uintBitsToFloat(ra.xyz), n = cityOct(unpackSnorm2x16(rb.x));
  vec2 aa = unpackHalf2x16(ra.w);                                              // area, signed half length (+ horizontal, - vertical)
  float a = abs(aa.y);
  vec3 t = aa.y >= 0.0 ? normalize(vec3(n.z + 1e-5, 0.0, -n.x)) : vec3(0.0, 1.0, 0.0);
  vec3 v = wp - P; float x = dot(v, t);
  vec3 Lw = P + t * clamp(x, -a, a) - wp; float d2 = max(dot(Lw, Lw), 1e-4);   // representative point on the segment
  vec2 br = unpackHalf2x16(rb.z);                                              // I.b, range
  if (d2 >= br.y * br.y) return;
  float d = sqrt(d2); vec3 l = Lw / d;
  uint m = rb.w, ty = m & 3u, ci = (m >> 2u) & 16383u;
  bool dOff = lmSkip && ci == 0u && ((m >> 16u) & 63u) == 0u;                   // P3: baked into the lightmap (diffuse)
  if (dOff && !spec) return;
  vec3 I = ci > 0u ? texelFetch(tCityLC, ivec2(int(ci - 1u) & 255, int(ci - 1u) >> 8), 0).rgb : vec3(unpackHalf2x16(rb.y), br.x);
  float ce = -dot(l, n), omni = float(m >> 26u) / 63.0;
  float fe = ty == 0u ? mix(max(ce, 0.0), 0.55 + 0.45 * ce, omni) : ty == 1u ? cityStreet(-l, n) : cityBeam(-l, n);
  float q = d / br.y; q = 1.0 - q * q * q * q;
  uint fh = (m >> 16u) & 63u; float fl = 1.0;
  if (fh != 0u) fl = 1.0 - float((m >> 22u) & 15u) / 15.0 * (0.5 + 0.5 * sin(6.2831853 * float(fh) * 0.25 * uCityTime + mod(float(idx) * 2.399, 6.2831853)));
  float F;                                                                     // geometry: point (near field E -> pi L) or line
  if (a > 0.01) { float hs = sqrt(a * a + aa.x) - a, rp = sqrt(max(dot(v, v) - x * x, 0.0) + hs * hs * 0.3183);
    F = (atan((a - x) / rp) + atan((a + x) / rp)) / (2.0 * a * rp); }
  else F = 1.0 / (d2 + aa.x * 0.3183);
  vec3 E = I * (fe * q * q * fl * uCityGain * F);
  vec3 lv = normalize((viewMatrix * vec4(l, 0.0)).xyz);
  if (spec) { IncidentLight il; il.direction = lv; il.color = E; il.visible = true;
    if (dOff) { ReflectedLight t = ReflectedLight(vec3(0.0), vec3(0.0), vec3(0.0), vec3(0.0)); RE_Direct(il, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, t); reflectedLight.directSpecular += t.directSpecular; }
    else RE_Direct(il, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight); }
  else reflectedLight.directDiffuse += E * saturate(dot(geometryNormal, lv)) * BRDF_Lambert(material.diffuseColor);
}
void cityLights(vec3 geometryPosition, vec3 geometryNormal, vec3 geometryViewDir, vec3 geometryClearcoatNormal, PhysicalMaterial material, inout ReflectedLight reflectedLight){
  vec3 wp = cityWorldPos(geometryPosition);
  vec2 cg = (wp.xz - uCityGrid.xy) * uCityGrid.z;
  if (cg.x < 0.0 || cg.y < 0.0 || cg.x >= uCityDim.x || cg.y >= uCityDim.y) return;
  ivec2 ci = ivec2(cg);
  int ks = int(uCityDim.z), kd = int(uCityDim.w), rank = 0, kl = uCityDyn.w > 0.5 ? int(uCityDyn.w) : ks;
  for (int s = 0; s < 3; s++) { if (s >= kl) break;
    uvec4 ids = texelFetch(tCityG, ivec2(ci.x * ks + s, ci.y), 0);
    for (int j = 0; j < 4; j++) { uint id = ids[j]; if (id == 65535u) break;
      cityOne(tCityL, int(id), rank < 4, cityLMOn, wp, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight); rank++; }
    if (ids.w == 65535u) break;
  }
  ivec2 cd = ci - ivec2(uCityDyn.xy); int dw = int(uCityDyn.z);
  if (cd.x >= 0 && cd.y >= 0 && cd.x < dw && cd.y < dw) {
    rank = 0;
    for (int s = 0; s < 2; s++) { if (s >= kd) break;
      uvec4 ids = texelFetch(tCityGD, ivec2(cd.x * kd + s, cd.y), 0);
      for (int j = 0; j < 4; j++) { uint id = ids[j]; if (id == 65535u) break;
        cityOne(tCityLD, int(id), rank < 2, false, wp, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight); rank++; }
      if (ids.w == 65535u) break;
    }
  }
}
// the volume at a world point: probe layers at VOLUME.heights (P3: 8)
${LAYER_GLSL(VOLUME.heights)}
vec3 cityVolUVW(vec3 wp){
  float ly = max(cityLayer(wp.y), 0.0);
  vec2 g = (wp.xz - uCityGrid.xy) * uCityGrid.z / uCityDim.xy;
  return vec3(g, (ly + 0.5) / ${VOLUME.heights.length.toFixed(1)});
}
float cityAOf(){ return uCityAOOn > 0.5 ? mix(1.0, texture(uCityAO, gl_FragCoord.xy * uCityAOScale).r, 0.85) : 1.0; }
vec3 cityIrradiance(vec3 wp, vec3 nW){
  vec3 uvw = cityVolUVW(wp);
  vec4 A = texture(tCityIrrA, uvw), B = texture(tCityIrrB, uvw);
  return A.rgb * (max(0.0, 1.0 + dot(B.xyz, nW)) * uCityIrrGain * cityAOf());
}
// P3 lighting #3: the night lightmap (seoul-nightlm.js). Ground: up-facing below 0.6 m; walls: a raster of the two
// nearest exposed footprint edges, the edge whose outward normal matches. false = keep the volume.
bool cityLightmap(vec3 wp, vec3 nW, out vec3 E){
  E = vec3(0.0);
  if (uCityLM.x < 0.5) return false;
  if (nW.y > 0.7 && wp.y < 0.6) {
    vec4 t = texture(tCityLMG, (wp.xz - uCityLMG.xy) / uCityLM.y / uCityLMG.zw);
    if (t.a < 0.99) return false;
    E = t.rgb; return true;
  }
  if (abs(nW.y) > 0.35) return false;
  ivec2 rc = ivec2(floor(wp.xz - uCityLMG.xy));
  if (rc.x < 0 || rc.y < 0 || rc.x >= int(uCityLMA.z) || rc.y >= int(uCityLMA.w)) return false;
  uvec2 ids = texelFetch(tCityLMR, rc, 0).xy;
  for (int s = 0; s < 2; s++) {
    uint id = s == 0 ? ids.x : ids.y; if (id == 0u) continue;
    int e = int(id) - 1; ivec2 b = ivec2((e & 255) * 2, e >> 8);
    vec4 r0 = texelFetch(tCityLME, b, 0), r1 = texelFetch(tCityLME, b + ivec2(1, 0), 0);
    float sg = r1.z < 0.0 ? -1.0 : 1.0, len = abs(r1.z);
    vec2 n = sg * vec2(r0.w, -r0.z);
    if (dot(n, nW.xz) < 0.8) continue;
    vec2 d = wp.xz - r0.xy; if (abs(dot(d, n)) > uCityLM.w) continue;
    vec2 tc = vec2(clamp(dot(d, r0.zw), 0.0, len), clamp(wp.y, 0.0, r1.w));
    vec4 tx = texture(tCityLMA, (r1.xy + 1.0 + tc / uCityLM.z) / uCityLMA.xy);
    if (tx.a < 0.99) return false;
    E = tx.rgb; return true;
  }
  return false;
}
// height haze: optical depth of an exponential height fog along the view ray, in-scattering the volume's fluence
vec3 cityHaze(vec3 col, vec3 pv){
  vec3 wp = cityWorldPos(pv);
  float dist = length(pv), H = uCityHaze.y;
  float y0 = max(cameraPosition.y, 0.0), y1 = max(wp.y, 0.0), dy = y1 - y0;
  float od = uCityHaze.x * H * dist * (abs(dy) > 1e-3 ? (exp(-y0 / H) - exp(-y1 / H)) / dy : exp(-y0 / H) / H);
  vec3 uvm = cityVolUVW(mix(cameraPosition, wp, 0.5));
  od *= texture(tCityIrrB, uvm).w;                                              // P3: extinction by street kind (B.w)
  float a = min(1.0 - exp(-max(od, 0.0)), uCityHaze.w);
  vec4 A0 = texture(tCityIrrA, cityVolUVW(wp)), A1 = texture(tCityIrrA, uvm);
  vec3 tint = (A0.rgb + A1.rgb) / max(dot(A0.rgb + A1.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
  vec3 ins = uCitySkyGlow + tint * (min(A0.w + A1.w, 20.0) * 0.5 * uCityHaze.z * 0.0796);   // isotropic phase 1/4pi
  return mix(col, ins, a);
}
`;
const WET_HEAD = /* glsl */`
uniform vec4 uCityCar[${12}];     // contact: centre x, z, heading x, z
uniform vec4 uCityCarS[${12}];    // half width, half length, -, -
float cityContact(vec3 wp){       // soft footprint occlusion under the nearest vehicles (lighting #5)
  float o = 1.0;
  for (int i = 0; i < ${12}; i++) { vec4 c = uCityCar[i], s = uCityCarS[i]; if (s.x <= 0.0) break;
    vec2 d = wp.xz - c.xy; vec2 q = abs(vec2(d.x * c.w - d.y * c.z, dot(d, c.zw))) - s.xy;
    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    o *= 1.0 - 0.8 * (1.0 - smoothstep(-0.35, 0.9, sd)); }
  return o;
}
uniform sampler2D tCityMirror;
uniform mat4 uCityMirrorVP;
uniform float uCityWet;
uniform vec2 uCityMirrorTexel;
float cityWet = 0.0;
float cityHash(vec2 p){ p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float cityNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cityHash(i), cityHash(i + vec2(1, 0)), f.x), mix(cityHash(i + vec2(0, 1)), cityHash(i + vec2(1, 1)), f.x), f.y); }
`;

// ------------------------------------------------------------------------------------------------- city culling (perf #3)
// Split a world mesh into `cell` m cells: vertices deduped against the previous two triangles (the quad pairs the geometry
// builders emit), an index sorted by cell, one geometry per cell sharing the attributes and the index (draw ranges), so
// the GPU holds one copy. Pure CPU (node-safe): returns [{ geometry, cell:[cx,cz], tris }].
export function splitCells(g, cell = 96, minTris = 12000) {
  const pos = g.getAttribute('position'); if (!pos) return null;
  const idx = g.index, nT = (idx ? idx.count : pos.count) / 3, vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  const P = pos.array, ps = pos.itemSize;
  // cell per triangle (centroid); small meshes: one cell
  const one = nT < minTris, key = new Int32Array(nT); let kmin = Infinity, kmax = -Infinity;
  const cx = new Int32Array(nT), cz = new Int32Array(nT);
  for (let t = 0; t < nT; t++) {
    const a = vi(t, 0) * ps, b = vi(t, 1) * ps, c = vi(t, 2) * ps;
    const x = (P[a] + P[b] + P[c]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    cx[t] = one ? 0 : Math.floor(x / cell); cz[t] = one ? 0 : Math.floor(z / cell);
  }
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let t = 0; t < nT; t++) { x0 = Math.min(x0, cx[t]); x1 = Math.max(x1, cx[t]); z0 = Math.min(z0, cz[t]); z1 = Math.max(z1, cz[t]); }
  const W = x1 - x0 + 1;
  for (let t = 0; t < nT; t++) { key[t] = (cz[t] - z0) * W + (cx[t] - x0); kmin = Math.min(kmin, key[t]); kmax = Math.max(kmax, key[t]); }
  // counting sort (stable: quad pairs stay adjacent)
  const nK = kmax + 1, cnt = new Int32Array(nK + 1);
  for (let t = 0; t < nT; t++) cnt[key[t] + 1]++;
  for (let k = 0; k < nK; k++) cnt[k + 1] += cnt[k];
  const order = new Int32Array(nT), fill = cnt.slice(0, nK);
  for (let t = 0; t < nT; t++) order[fill[key[t]]++] = t;
  // dedupe: compare each corner with the corners of the previous two emitted triangles
  const names = Object.keys(g.attributes), attrs = names.map((n) => g.getAttribute(n));
  const sizes = attrs.map((a) => a.itemSize), stride = sizes.reduce((s, v) => s + v, 0);
  const arrs = attrs.map((a) => a.array), nA = attrs.length;
  // P3: compared in the source arrays (no nT x 3 x stride staging buffer); output keeps each attribute's array type
  const srcOf = new Int32Array(nT * 3), index = new Uint32Array(nT * 3); let nV = 0;
  const same = (va, vb) => { if (va === vb) return true; for (let a = 0; a < nA; a++) { const A = arrs[a], s = sizes[a], x = va * s, y = vb * s; for (let c = 0; c < s; c++) if (A[x + c] !== A[y + c]) return false; } return true; };
  const recent = new Int32Array(6).fill(-1); let rp = 0;
  // P3: the dedupe restarts at every cell, so each cell's vertices are one contiguous range [vS, vE) (BatchedMesh parts)
  const vS = new Int32Array(nK), vE = new Int32Array(nK); let curK = -1;
  for (let o = 0; o < nT; o++) {
    const t = order[o];
    if (key[t] !== curK) { if (curK >= 0) vE[curK] = nV; curK = key[t]; vS[curK] = nV; recent.fill(-1); }
    for (let k = 0; k < 3; k++) {
      const v = idx ? idx.getX(t * 3 + k) : t * 3 + k;
      let found = -1;
      for (let r = 0; r < 6 && found < 0; r++) { const c = recent[r]; if (c >= 0 && same(srcOf[c], v)) found = c; }
      if (found < 0) { found = nV++; srcOf[found] = v; }
      index[o * 3 + k] = found; recent[rp] = found; rp = (rp + 1) % 6;
    }
  }
  if (curK >= 0) vE[curK] = nV;
  const shared = {};
  names.forEach((n, a) => {
    const sz = sizes[a], A = arrs[a], arr = new A.constructor(nV * sz);
    for (let v = 0; v < nV; v++) { const b = srcOf[v] * sz, o = v * sz; for (let k = 0; k < sz; k++) arr[o + k] = A[b + k]; }
    shared[n] = new THREE.BufferAttribute(arr, sz, attrs[a].normalized);
  });
  const ix = new THREE.BufferAttribute(nV > 65535 ? index : new Uint16Array(index), 1);
  const out = [];
  for (let k = 0; k < nK; k++) {
    const s = cnt[k], e = cnt[k + 1]; if (e <= s) continue;
    const geo = new THREE.BufferGeometry();
    for (const n of names) geo.setAttribute(n, shared[n]);
    geo.setIndex(ix); geo.setDrawRange(s * 3, (e - s) * 3);
    const p = shared.position.array; let a0 = Infinity, a1 = Infinity, a2 = Infinity, b0 = -Infinity, b1 = -Infinity, b2 = -Infinity;
    for (let q = s * 3; q < e * 3; q++) { const v = index[q] * 3, X = p[v], Y = p[v + 1], Z = p[v + 2]; if (X < a0) a0 = X; if (X > b0) b0 = X; if (Y < a1) a1 = Y; if (Y > b1) b1 = Y; if (Z < a2) a2 = Z; if (Z > b2) b2 = Z; }
    const bb = new THREE.Box3(new THREE.Vector3(a0, a1, a2), new THREE.Vector3(b0, b1, b2));
    geo.boundingBox = bb; geo.boundingSphere = bb.getBoundingSphere(new THREE.Sphere());
    out.push({ geometry: geo, cell: [(k % W) + x0, Math.floor(k / W) + z0], tris: e - s, i0: s * 3, v0: vS[k], v1: vE[k], box: bb, sphere: geo.boundingSphere });
  }
  return { parts: out, vertices: nV, srcVertices: idx ? pos.count : nT * 3, tris: nT, attributes: shared, index };
}

// P3 perf #1: one THREE.BatchedMesh per material: every cell is an instance, culled per instance and drawn with
// WEBGL_multi_draw (one draw call per material however many cells are in view; three loops drawElements without it).
// Cells are identity-matrix instances of their own geometry (a contiguous vertex range of splitCells' shared buffers).
export function batchCells(sp, material) {
  const A = sp.attributes, idx = sp.index, P = sp.parts;
  const bm = new THREE.BatchedMesh(P.length, sp.vertices, sp.tris * 3, material);
  const ids = [];
  for (const p of P) {
    const g = new THREE.BufferGeometry();
    for (const [n, a] of Object.entries(A)) g.setAttribute(n, new THREE.BufferAttribute(a.array.subarray(p.v0 * a.itemSize, p.v1 * a.itemSize), a.itemSize, a.normalized));
    const n = p.tris * 3, ia = (p.v1 - p.v0) > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) ia[i] = idx[p.i0 + i] - p.v0;
    g.setIndex(new THREE.BufferAttribute(ia, 1));
    const gid = bm.addGeometry(g); ids.push(bm.addInstance(gid));
    bm.getBoundingBoxAt(gid, new THREE.Box3()); bm.getBoundingSphereAt(gid, new THREE.Sphere());   // cached before the arrays go
  }
  bm.computeBoundingBox(); bm.computeBoundingSphere();
  bm.userData.cellSpheres = P.map((p) => p.sphere); bm.userData.cellTris = P.map((p) => p.tris); bm.userData.instanceIds = ids;
  return bm;
}

// ------------------------------------------------------------------------------------------------- build
export function attach(world, emitters = [], ctx = {}) {
  const T00 = (globalThis.performance || Date).now(), now = () => (globalThis.performance || Date).now();
  const renderer = ctx.renderer || null;
  const NS = ctx.nitScale ?? NITS;
  const rad = (e, o) => emitterRadiance(e, o, NS);
  const scene = world.scene;
  const Q = { ...(QUALITY[ctx.quality] || QUALITY.auto), ...(ctx.K ? { K: ctx.K } : {}) };
  const cell = ctx.cell || 4;
  const OM = omega();
  const all = (emitters || []).filter((e) => e && e.pos);
  const isMov = (e) => !!(e.kind === 'vehicle' || e.dynamic || e.moving);
  const isAnim = (e) => !!e.animated && !isMov(e);
  const mov = all.filter(isMov), anim = all.filter(isAnim), still = all.filter((e) => !isMov(e) && !isAnim(e));
  const stat = still.concat(anim);                       // static records: fixed first, in-place animated last
  const nAnim = anim.length, animBase = still.length;

  // grid bounds: layout bounds or the fixed emitters' bounds, + a range margin
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const grow = (x, z) => { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); };
  for (const l of ctx.layout?.lots || []) for (const [x, z] of l.footprint) grow(x, z);
  for (const s of ctx.layout?.streets || []) for (const [x, z] of s.points) grow(x, z);
  for (const e of stat) grow(e.pos[0], e.pos[2]);
  if (!Number.isFinite(x0)) { x0 = -100; z0 = -100; x1 = 100; z1 = 100; }
  x0 -= 16; z0 -= 16; x1 += 16; z1 += 16;
  const gw = Math.min(256, Math.ceil((x1 - x0) / cell)), gh = Math.min(256, Math.ceil((z1 - z0) / cell));
  const K4 = Math.max(1, Math.min(3, Q.K / 4)), K = K4 * 4, KD4 = Math.max(1, Math.min(2, Q.Kd / 4)), KD = KD4 * 4;
  const HF = heightField(ctx.layout, x0, z0, x0 + gw * cell, z0 + gh * cell, VOLUME.rasterM);
  const YS = VOLUME.heights, NL = YS.length;

  // forward direction of a street lamp: e.forward, else toward the nearest street centreline
  const segs = []; for (const s of ctx.layout?.streets || []) for (let i = 0; i + 1 < s.points.length; i++) segs.push([s.points[i], s.points[i + 1]]);
  function streetForward(e) {
    if (e.forward) { const l = Math.hypot(e.forward[0], e.forward[2]) || 1; return [e.forward[0] / l, e.forward[2] / l]; }
    let best = Infinity, fx = 0, fz = 1;
    for (const [a, b] of segs) {
      const vx = b[0] - a[0], vz = b[1] - a[1], l2 = vx * vx + vz * vz || 1e-9, t = Math.max(0, Math.min(1, ((e.pos[0] - a[0]) * vx + (e.pos[2] - a[1]) * vz) / l2));
      const qx = a[0] + vx * t - e.pos[0], qz = a[1] + vz * t - e.pos[2], d = Math.hypot(qx, qz);
      if (d < best) { best = d; if (d > 0.05) { fx = qx / d; fz = qz / d; } else { fx = -vz / Math.sqrt(l2); fz = vx / Math.sqrt(l2); } }
    }
    return [fx, fz];
  }

  // ------------------------------------------------------------------------------------- light records (JS mirror)
  // m: { x,y,z, A, omni, n:[3] (street/beam: horizontal forward), I:[3] (scene cd), range, ty, peak }
  const _r = [0, 0, 0];
  function meta(e, nominal = false, out = null) {
    const T = SOURCE_TYPES[e.kind] || SOURCE_TYPES.lightbox;
    const A = Math.max(1e-3, (e.w || 0.5) * (e.h || 0.5));
    const n = out ? out.n : [0, 0, 1], I = out ? out.I : [0, 0, 0];
    { const n0 = e.normal || [0, 0, 1], nl = Math.hypot(n0[0], n0[1], n0[2]) || 1; n[0] = n0[0] / nl; n[1] = n0[1] / nl; n[2] = n0[2] / nl; }
    const c = e.rgb || T.rgb, cl = Math.max(1e-4, lumaOf(c));
    let nits = e.nits ?? T.nits; if (nominal) nits = Math.max(nits, e.nitsMax ?? 0, T.nits * 0.6);
    let ty = LT.lambert, I0, peak;
    if (e.kind === 'street' && n[1] < -0.7) {
      const [fx, fz] = streetForward(e), flux = e.lumens ?? nits * Math.PI * A;
      I0 = flux / OM.street * NS / cl; n[0] = fx; n[1] = 0; n[2] = fz; ty = LT.street; peak = I0 * cl * 30;
    } else if (e.beam) {
      const h = Math.hypot(n[0], n[2]) || 1, flux = (e.beam.lumens ?? HEADLIGHT.lumens) * Math.max(0, Math.min(1, nits / HEADLIGHT.refNits));
      I0 = flux / OM.beam * NS / cl; n[0] /= h; n[1] = 0; n[2] /= h; ty = LT.beam; peak = I0 * cl;
    } else { I0 = nits * NS / cl * A; peak = nits * NS * A; }
    I[0] = c[0] * I0; I[1] = c[1] * I0; I[2] = c[2] * I0;
    const range = Math.min(e.range ?? T.range, Math.sqrt(Math.max(peak, 1e-6) / E_MIN));
    const m = out || {};
    // elongated faces are line lights along their long axis (+ horizontal tangent of the normal, - vertical)
    let hl = 0; if (ty === LT.lambert) { const w = e.w || 0.5, h = e.h || 0.5, lo = Math.max(w, h), sh = Math.min(w, h); if (lo - sh > 0.5) hl = (w >= h ? 1 : -1) * (lo - sh) / 2; }
    m.x = e.pos[0]; m.y = e.pos[1]; m.z = e.pos[2]; m.A = A; m.omni = e.omni ?? T.omni; m.n = n; m.I = I; m.range = range; m.ty = ty; m.peak = peak; m.flick = e.flicker;
    m.hl = hl; m.a = Math.abs(hl);
    if (hl > 0) { const tl = Math.hypot(n[2] + 1e-5, n[0]); m.tx = (n[2] + 1e-5) / tl; m.ty_ = 0; m.tz = -n[0] / tl; } else { m.tx = 0; m.ty_ = 1; m.tz = 0; }
    return m;
  }
  // irradiance factor at a point (I x this = E), with the direction toward the light in L[0..2]
  const L3 = [0, 0, 0];
  function kAt(m, px, py, pz) {
    let lx = m.x - px, ly = m.y - py, lz = m.z - pz, x = 0, a = m.a;
    if (a > 0) { x = -(lx * m.tx + ly * m.ty_ + lz * m.tz); const c = Math.max(-a, Math.min(a, x)); lx += m.tx * c; ly += m.ty_ * c; lz += m.tz * c; }
    const d2 = Math.max(lx * lx + ly * ly + lz * lz, 1e-4);
    if (d2 >= m.range * m.range) return 0;
    const d = Math.sqrt(d2), ux = lx / d, uy = ly / d, uz = lz / d; L3[0] = ux; L3[1] = uy; L3[2] = uz;
    let fe;
    if (m.ty === LT.lambert) { const ce = -(ux * m.n[0] + uy * m.n[1] + uz * m.n[2]); fe = Math.max(ce, 0) * (1 - m.omni) + (0.55 + 0.45 * ce) * m.omni; }
    else if (m.ty === LT.street) fe = lobeStreet(-ux, -uy, -uz, m.n[0], m.n[2]);
    else fe = lobeBeam(-ux, -uy, -uz, m.n[0], m.n[2]);
    if (fe <= 0) return 0;
    let q = d / m.range; q = 1 - q * q * q * q;
    if (a > 0.01) {
      const vx = px - m.x, vy = py - m.y, vz = pz - m.z, hs = Math.sqrt(a * a + m.A) - a;
      const rp = Math.sqrt(Math.max(vx * vx + vy * vy + vz * vz - x * x, 0) + hs * hs * 0.3183);
      return fe * q * q * (Math.atan((a - x) / rp) + Math.atan((a + x) / rp)) / (2 * a * rp);
    }
    return fe * q * q / (d2 + m.A * 0.3183);
  }
  function pack(m, u32, i, ci = 0) {   // misc: lobe 2 | colour index 14 | flicker hz x4 6 | depth x15 4 | omni x63 6
    const k = ((i >> 8) * LW * 2 + (i & (LW - 1)) * 2) * 4;
    let hz = Math.min(63, Math.round((m.flick?.hz || 0) * 4)), dep = Math.min(15, Math.round(Math.min(1, m.flick?.depth || 0) * 15));
    if (!hz || !dep) hz = dep = 0;
    u32[k] = fbits(m.x); u32[k + 1] = fbits(m.y); u32[k + 2] = fbits(m.z); u32[k + 3] = h2(m.A, m.hl);
    u32[k + 4] = oct(m.n[0], m.n[1], m.n[2]); u32[k + 5] = h2(m.I[0], m.I[1]); u32[k + 6] = h2(m.I[2], m.range);
    u32[k + 7] = (m.ty | (ci << 2) | (hz << 16) | (dep << 22) | (Math.min(63, Math.round(m.omni * 63)) << 26)) >>> 0;
  }
  const recTex = (n) => {
    const w = LW * 2, h = Math.max(1, Math.ceil(n / LW));
    const t = new THREE.DataTexture(new Uint32Array(w * h * 4), w, h, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
    t.internalFormat = 'RGBA32UI'; t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  };
  const gridTex = (w, h) => {
    const t = new THREE.DataTexture(new Uint16Array(w * h * 4).fill(NONE), w, h, THREE.RGBAIntegerFormat, THREE.UnsignedShortType);
    t.internalFormat = 'RGBA16UI'; t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  };
  const tL = recTex(Math.max(1, stat.length)), tLD = recTex(Math.max(1, Q.Nd));
  const tG = gridTex(gw * K4, gh), tGD = gridTex(DW * KD4, DW);
  const tLC = new THREE.DataTexture(new Float32Array(LW * Math.max(1, Math.ceil(nAnim / LW)) * 4), LW, Math.max(1, Math.ceil(nAnim / LW)), THREE.RGBAFormat, THREE.FloatType);
  tLC.minFilter = tLC.magFilter = THREE.NearestFilter; tLC.generateMipmaps = false; tLC.needsUpdate = true;
  const metas = stat.map((e, i) => meta(e, i >= animBase));
  metas.forEach((m, i) => pack(m, tL.image.data, i, i >= animBase ? i - animBase + 1 : 0));

  // ------------------------------------------------------------------------------------- static bin + volume
  const tB0 = now(), marks = { pre: +(tB0 - T00).toFixed(0) };
  const NC = gw * gh, kS = new Float32Array(NC * K), kI = new Int32Array(NC * K).fill(-1), kV = new Uint8Array(NC * K), kN = new Uint8Array(NC);
  // probe interior flags (inside a building at that height) and per-probe accumulators
  const NP = NC * NL, inner = new Uint8Array(NP);
  for (let cz = 0; cz < gh; cz++) for (let cx = 0; cx < gw; cx++) { const h = HF.at(x0 + (cx + 0.5) * cell, z0 + (cz + 0.5) * cell); for (let k = 0; k < NL; k++) if (h > YS[k]) inner[(cz * gw + cx) * NL + k] = 1; }
  const tA = new Float32Array(NP * 3), tBv = new Float32Array(NP * 3), Eg = new Float32Array(NC * 3);
  const PROBE_H = YS, V4 = 1 << YS.reduce((b, h, k) => (Math.abs(h - 4) < Math.abs(YS[b] - 4) ? k : b), 0);   // the probe nearest 4 m
  // the hot loops live in their own closures (fresh JIT feedback per attach: a second visit to the level stays fast)
  let pc = new Int32Array(1 << 18), pi = new Int32Array(1 << 18), pb = new Uint8Array(1 << 18);   // every (cell, light, occ bits) pair (lightmap bake)
  const { pairs, occl } = (function binPass() {
  let pairs = 0, occl = 0;
  for (let i = 0; i < stat.length; i++) {
    const m = metas[i], r = m.range + (m.hl > 0 ? m.a : 0);
    const cx0 = Math.max(0, Math.floor((m.x - r - x0) / cell)), cx1 = Math.min(gw - 1, Math.floor((m.x + r - x0) / cell));
    const cz0 = Math.max(0, Math.floor((m.z - r - z0) / cell)), cz1 = Math.min(gh - 1, Math.floor((m.z + r - z0) / cell));
    // nominal luminance colour for the volume (animated: their binning nominal at ~half average content)
    const cw = i >= animBase ? 0.5 : 1, Ir = m.I[0] * cw, Ig = m.I[1] * cw, Ib = m.I[2] * cw, Il = LUMA[0] * Ir + LUMA[1] * Ig + LUMA[2] * Ib;
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      const ax = x0 + cx * cell, az = z0 + cz * cell, mx = ax + cell * 0.5, mz = az + cell * 0.5;
      const nx = Math.min(Math.max(m.x, ax), ax + cell), nz = Math.min(Math.max(m.z, az), az + cell);
      const hd2 = (nx - m.x) ** 2 + (nz - m.z) ** 2; if (hd2 >= r * r) continue;   // (r includes a line light's half length)
      // score: the best of the nearest point and the centre at 1.5 m, and (x0.5) the nearest point at the light's height
      let s = Math.max(kAt(m, nx, 1.5, nz), kAt(m, mx, 1.5, mz), 0.5 * kAt(m, nx, Math.max(0.5, m.y - 0.5), nz));
      s *= LUMA[0] * m.I[0] + LUMA[1] * m.I[1] + LUMA[2] * m.I[2];
      if (s < E_MIN) continue;
      const c = cz * gw + cx, pin = c * NL;
      const occBits = HF.occ(m.x, m.y, m.z, mx, mz, PROBE_H);
      if (occBits) occl++;
      if (pairs >= pc.length) { const g2 = (A) => { const B = new A.constructor(A.length * 2); B.set(A); return B; }; pc = g2(pc); pi = g2(pi); pb = g2(pb); }
      pc[pairs] = c; pi[pairs] = i; pb[pairs] = occBits; pairs++;
      // binning visibility: the 0.5 m and 4 m probes; an interior column (facade fragments only) counts as visible
      const vis = inner[pin] ? 1 : ((occBits & 1) ? 0 : 0.6) + ((occBits & V4) ? 0 : 0.4);
      if (vis > 0) {
        const sv = s * Math.max(vis, 0.15), o = c * K, n = kN[c];
        if (n < K) { kS[o + n] = sv; kI[o + n] = i; kV[o + n] = occBits; kN[c] = n + 1; }
        else { let mi = 0; for (let j = 1; j < K; j++) if (kS[o + j] < kS[o + mi]) mi = j; if (sv > kS[o + mi]) { kS[o + mi] = sv; kI[o + mi] = i; kV[o + mi] = occBits; } }
      }
      // volume: every visible exterior probe of the column accumulates this light (ambient + L1)
      for (let k = 0; k < NL; k++) {
        if (inner[pin + k] || (occBits & (1 << k))) continue;
        const f = kAt(m, mx, YS[k], mz); if (f <= 0) continue;
        const p = (pin + k) * 3;
        tA[p] += 0.25 * Ir * f; tA[p + 1] += 0.25 * Ig * f; tA[p + 2] += 0.25 * Ib * f;
        const fl = 0.5 * Il * f; tBv[p] += fl * L3[0]; tBv[p + 1] += fl * L3[1]; tBv[p + 2] += fl * L3[2];
        if (k === 0) { const fg = kAt(m, mx, 0.05, mz) * Math.max(0, L3[1]); Eg[c * 3] += Ir * fg; Eg[c * 3 + 1] += Ig * fg; Eg[c * 3 + 2] += Ib * fg; }
      }
    }
  }
  return { pairs, occl };
  })();
  // write the grid (sorted by score) and the residual: total minus each cell's top-K (those are evaluated per fragment)
  const rA = tA.slice(), rB = tBv.slice();
  let used = 0, full = 0, cellsUsed = 0;
  { const gd = tG.image.data, rowW = gw * K4 * 4, ord = new Int32Array(K);
    for (let c = 0; c < NC; c++) {
      const n = kN[c]; if (!n) continue; cellsUsed++; used += n; if (n === K) full++;
      const o = c * K; for (let j = 0; j < n; j++) ord[j] = j;
      const os = Array.from(ord.subarray(0, n)).sort((a, b) => kS[o + b] - kS[o + a]);
      const cx = c % gw, cz = (c / gw) | 0;
      for (let j = 0; j < n; j++) gd[cz * rowW + cx * K4 * 4 + j] = kI[o + os[j]];
      const mx = x0 + (cx + 0.5) * cell, mz = z0 + (cz + 0.5) * cell;
      for (let j = 0; j < n; j++) {
        const i = kI[o + j], m = metas[i], ob = kV[o + j], cw = i >= animBase ? 0.5 : 1;
        const Ir = m.I[0] * cw, Ig = m.I[1] * cw, Ib = m.I[2] * cw, Il = LUMA[0] * Ir + LUMA[1] * Ig + LUMA[2] * Ib;
        for (let k = 0; k < NL; k++) {
          if (inner[c * NL + k] || (ob & (1 << k))) continue;
          const f = kAt(m, mx, YS[k], mz); if (f <= 0) continue;
          const p = (c * NL + k) * 3;
          rA[p] -= 0.25 * Ir * f; rA[p + 1] -= 0.25 * Ig * f; rA[p + 2] -= 0.25 * Ib * f;
          const fl = 0.5 * Il * f; rB[p] -= fl * L3[0]; rB[p + 1] -= fl * L3[1]; rB[p + 2] -= fl * L3[2];
        }
      }
    }
    tG.needsUpdate = true; }
  const binMs = now() - tB0;

  // bounce + sky, then fill the interior probes from their neighbours, then pack (RGBA16F 3D textures)
  const tV0 = now();
  const roadMask = new Uint8Array(NC);   // 1 = asphalt road, 2 = walking-street pavers, 0 = sidewalk
  const hazeK = new Float32Array(NC), HK = { ...HAZE.byKind, ...(ctx.haze?.byKind || {}) }, hd0 = ctx.haze?.density ?? HAZE.density;
  for (const s of ctx.layout?.streets || []) {
    const w = s.width || 6, P = s.points, hk = (HK[s.kind] ?? hd0) / hd0;
    for (let i = 0; i + 1 < P.length; i++) {
      const [ax, az] = P[i], [bx, bz] = P[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < 0.01) continue;
      for (let t = 0; t <= L; t += cell * 0.5) for (let u = -w / 2; u <= w / 2; u += cell * 0.5) {
        const x = ax + (bx - ax) * t / L - (bz - az) / L * u, z = az + (bz - az) * t / L + (bx - ax) / L * u;
        const cx = Math.floor((x - x0) / cell), cz = Math.floor((z - z0) / cell);
        if (cx >= 0 && cz >= 0 && cx < gw && cz < gh) { roadMask[cz * gw + cx] = s.kind === 'walking' ? 2 : 1; hazeK[cz * gw + cx] = Math.max(hazeK[cz * gw + cx], hk); }
      }
    }
  }
  // haze factor per column (P3 lighting #5): the street kinds' extinction / HAZE.density, 1 off the streets, box-blurred 8 m
  { const src = hazeK.slice(); for (let c = 0; c < NC; c++) if (!src[c]) src[c] = 1;
    for (let cz = 0; cz < gh; cz++) for (let cx = 0; cx < gw; cx++) { let s0 = 0, n = 0;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) { const x = cx + dx, z = cz + dz; if (x < 0 || z < 0 || x >= gw || z >= gh) continue; s0 += src[z * gw + x]; n++; }
      hazeK[cz * gw + cx] = s0 / n; } }
  const blur = (src, r) => {   // box blur of the ground irradiance over exterior columns
    if (r <= 0) return src;
    const out = new Float32Array(NC * 3);
    for (let cz = 0; cz < gh; cz++) for (let cx = 0; cx < gw; cx++) {
      let s0 = 0, s1 = 0, s2 = 0, n = 0;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx, z = cz + dz; if (x < 0 || z < 0 || x >= gw || z >= gh) continue; const c = z * gw + x; if (inner[c * NL]) continue;
        s0 += src[c * 3]; s1 += src[c * 3 + 1]; s2 += src[c * 3 + 2]; n++;
      }
      const c = cz * gw + cx; if (n) { out[c * 3] = s0 / n; out[c * 3 + 1] = s1 / n; out[c * 3 + 2] = s2 / n; }
    }
    return out;
  };
  // the ground a probe sees widens with its height: blur radius (cells) ~ height / 2 cells, capped at 6 (P3: per layer)
  const blurR = YS.map((h) => Math.min(6, Math.round(h / (2 * cell)))), blurs = new Map();
  const EgL = blurR.map((r) => { if (!blurs.has(r)) blurs.set(r, blur(Eg, r)); return blurs.get(r); }); marks.blur = +(now() - tV0).toFixed(0);
  const skyL = [0, 1, 2].map((j) => 0.5 * (NIGHT_SKY.zenith[j] + NIGHT_SKY.horizon[j]) * NS * Math.PI);   // pi L of the dome
  const skyLum = lumaOf(skyL);
  const VA = new Float32Array(NP * 4), VB = new Float32Array(NP * 4), ok = new Uint8Array(NP);
  const VI = new Float32Array(NP * 4);   // P3: the indirect part alone (bounce, windows, sky) + its vertical L1, for the lightmap bake
  const oo = new Float32Array(NL), cc = new Float32Array(NL);
  (function assemble() {
  for (let cz = 0; cz < gh; cz++) for (let cx = 0; cx < gw; cx++) {
    const c = cz * gw + cx; let any = false; for (let k = 0; k < NL; k++) if (!inner[c * NL + k]) any = true;
    if (!any) continue;
    HF.horizon(x0 + (cx + 0.5) * cell, z0 + (cz + 0.5) * cell, YS, oo, cc);
    const rho = roadMask[c] === 1 ? VOLUME.rhoRoad : VOLUME.rhoWalk;
    for (let k = 0; k < NL; k++) {
      const p = c * NL + k; if (inner[p]) continue;
      const q = p * 3;
      const ta0 = tA[q], ta1 = tA[q + 1], ta2 = tA[q + 2], tal = LUMA[0] * ta0 + LUMA[1] * ta1 + LUMA[2] * ta2;
      let a0 = Math.max(0, rA[q]), a1 = Math.max(0, rA[q + 1]), a2 = Math.max(0, rA[q + 2]);
      let bx = rB[q], by = rB[q + 1], bz = rB[q + 2];
      // ground bounce: a lower hemisphere at pi L = rho Eg
      const G = EgL[k], g0 = rho * G[c * 3], g1 = rho * G[c * 3 + 1], g2 = rho * G[c * 3 + 2], gl = LUMA[0] * g0 + LUMA[1] * g1 + LUMA[2] * g2;
      const mb = VOLUME.multi; a0 += mb * g0 / 2; a1 += mb * g1 / 2; a2 += mb * g2 / 2; by -= mb * gl / 2;
      // wall bounce: the canyon walls at pi L = rho_w x their irradiance (the probe's, toward its brighter side)
      const bh = Math.hypot(tBv[q], tBv[q + 2]), ew = tal > 0 ? 1 + bh / tal : 0, wk = 0.5 * cc[k] * VOLUME.rhoWall * ew * mb;
      a0 += wk * ta0; a1 += wk * ta1; a2 += wk * ta2;
      // the lit windows of the walls around (pi L x the walls' share of the view, half of it facing any one side)
      const wn = 0.5 * cc[k] * Math.PI * VOLUME.windowNits[k] * NS / lumaOf(VOLUME.windowRGB);
      a0 += wn * VOLUME.windowRGB[0]; a1 += wn * VOLUME.windowRGB[1]; a2 += wn * VOLUME.windowRGB[2];
      // sky: an upper hemisphere through the horizon
      a0 += oo[k] * skyL[0] / 2; a1 += oo[k] * skyL[1] / 2; a2 += oo[k] * skyL[2] / 2; by += oo[k] * skyLum / 2;
      const al = Math.max(1e-7, LUMA[0] * a0 + LUMA[1] * a1 + LUMA[2] * a2);
      VA[p * 4] = a0; VA[p * 4 + 1] = a1; VA[p * 4 + 2] = a2; VA[p * 4 + 3] = 4 * tal + oo[k] * skyLum;   // haze fluence
      // direction / ambient, clamped (|b|/a <= 2 is a single delta source)
      let bl = Math.hypot(bx, by, bz) / al; const sc = bl > 2 ? 2 / bl : 1;
      VB[p * 4] = bx / al * sc; VB[p * 4 + 1] = by / al * sc; VB[p * 4 + 2] = bz / al * sc;
      VB[p * 4 + 3] = k < 2 ? hazeK[c] : k === 2 ? 0.5 * (hazeK[c] + 1) : 1;   // haze extinction factor (smoke stays low)
      { const i0 = a0 - Math.max(0, rA[q]), i1 = a1 - Math.max(0, rA[q + 1]), i2 = a2 - Math.max(0, rA[q + 2]), il = Math.max(1e-7, LUMA[0] * i0 + LUMA[1] * i1 + LUMA[2] * i2);
        VI[p * 4] = i0; VI[p * 4 + 1] = i1; VI[p * 4 + 2] = i2; VI[p * 4 + 3] = Math.max(-1, Math.min(1, (oo[k] * skyLum / 2 - mb * gl / 2) / il)); }
      ok[p] = 1;
    }
  }
  })();
  marks.assemble = +(now() - tV0).toFixed(0);
  // interior probes: average of filled 8-neighbours, a few passes (facade fragments interpolate toward them)
  { const addP = new Int32Array(NP), addV = new Float32Array(NP * 12);
    for (let pass = 0; pass < 8; pass++) {
      let na = 0;
      for (let cz = 0; cz < gh; cz++) for (let cx = 0; cx < gw; cx++) for (let k = 0; k < NL; k++) {
        const p = (cz * gw + cx) * NL + k; if (ok[p]) continue;
        let n = 0; const o = na * 12; for (let j = 0; j < 12; j++) addV[o + j] = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx, z = cz + dz; if ((!dx && !dz) || x < 0 || z < 0 || x >= gw || z >= gh) continue;
          const pq = (z * gw + x) * NL + k; if (!ok[pq]) continue;
          for (let j = 0; j < 4; j++) { addV[o + j] += VA[pq * 4 + j]; addV[o + 4 + j] += VB[pq * 4 + j]; addV[o + 8 + j] += VI[pq * 4 + j]; } n++;
        }
        if (n) { for (let j = 0; j < 12; j++) addV[o + j] /= n; addP[na++] = p; }
      }
      for (let i = 0; i < na; i++) { const p = addP[i], o = i * 12; for (let j = 0; j < 4; j++) { VA[p * 4 + j] = addV[o + j]; VB[p * 4 + j] = addV[o + 4 + j]; VI[p * 4 + j] = addV[o + 8 + j]; } ok[p] = 1; }
      if (!na) break;
    } }
  for (let p = 0; p < NP; p++) if (!ok[p]) { VA[p * 4] = skyL[0] * 0.1; VA[p * 4 + 1] = skyL[1] * 0.1; VA[p * 4 + 2] = skyL[2] * 0.1; VB[p * 4 + 1] = 1; VB[p * 4 + 3] = 1; }
  marks.fill = +(now() - tV0).toFixed(0);
  const vol3 = (src) => {   // [cz][cx][k] -> 3D texture (x = cx, y = cz, z = layer)
    const d = new Uint16Array(NP * 4);
    for (let k = 0; k < NL; k++) for (let cz = 0; cz < gh; cz++) for (let cx = 0; cx < gw; cx++) {
      const s = ((cz * gw + cx) * NL + k) * 4, o = ((k * gh + cz) * gw + cx) * 4;
      for (let j = 0; j < 4; j++) d[o + j] = half(src[s + j]);
    }
    const t = new THREE.Data3DTexture(d, gw, gh, NL); t.format = THREE.RGBAFormat; t.type = THREE.HalfFloatType;
    t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping; t.generateMipmaps = false; t.unpackAlignment = 1; t.needsUpdate = true;
    return t;
  };
  const tIrrA = vol3(VA), tIrrB = vol3(VB);
  const volMs = now() - tV0;

  // ------------------------------------------------------------------------------------- night lightmap (P3 lighting #3)
  // seoul-nightlm.js bakes every static emitter (no K limit, heightfield-occluded) + the volume's indirect onto the
  // ground (0.5 m) and the exposed walls (0.5 m atlas). Browser: in a module Worker, so the level opens on the volume and
  // the lightmap fades in when it lands (~1-3 s); node / ctx.lightmapSync: in line. ctx.lightmap === false: off.
  // node (tests, tools): off unless ctx.lightmap === true (the bake is seconds of CPU the suites don't need)
  const lm = { on: (typeof window === 'undefined' ? ctx.lightmap === true : ctx.lightmap !== false) && !!ctx.layout?.lots?.length, ready: false, ms: 0, texels: null, mode: 'off', worker: null };
  const half4 = (w, h, data) => { const t = new THREE.DataTexture(data || new Uint16Array(w * h * 4), w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.generateMipmaps = false; t.needsUpdate = true; return t; };
  let tLMG = half4(1, 1), tLMA = half4(1, 1), tLMR, tLME;
  { const t = new THREE.DataTexture(new Uint16Array(2), 1, 1, THREE.RGIntegerFormat, THREE.UnsignedShortType); t.internalFormat = 'RG16UI'; t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; tLMR = t; }
  { const t = new THREE.DataTexture(new Float32Array(8), 2, 1, THREE.RGBAFormat, THREE.FloatType); t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; tLME = t; }
  const uLM = { value: new THREE.Vector4(0, NIGHT_LM.gres, NIGHT_LM.fres, NIGHT_LM.near) }, uLMG = { value: new THREE.Vector4() }, uLMA = { value: new THREE.Vector4(1, 1, 1, 1) };
  if (lm.on) {
    const tP = now();
    const plan = planLM(ctx.layout, HF, { x0, z0, x1: x0 + gw * cell, z1: z0 + gh * cell });
    const cs = new Int32Array(NC + 1); for (let q = 0; q < pairs; q++) cs[pc[q] + 1]++; for (let c = 0; c < NC; c++) cs[c + 1] += cs[c];
    const fillc = cs.slice(0, NC), pe = new Int32Array(pairs), po = new Uint8Array(pairs);
    for (let q = 0; q < pairs; q++) { const o = fillc[pc[q]]++; pe[o] = pi[q]; po[o] = pb[q]; }
    const M = new Float32Array(stat.length * LM_MS);
    metas.forEach((m, i) => packMeta(m, M, i, i >= animBase || (m.flick?.hz > 0 && m.flick?.depth > 0) ? 1 : 0));   // screens and flicker stay per fragment
    const job = { plan, M, cs, pe, po, grid: { x0, z0, cell, gw, gh }, YS, H: { H: HF.H.slice(), nx: HF.nx, nz: HF.nz, res: HF.res, x0: HF.x0, z0: HF.z0 }, VI };
    // the lookup textures now (the raster and the edge table), the maps when the bake lands
    tLMR.image = { data: plan.raster, width: plan.rw, height: plan.rh }; tLMR.needsUpdate = true;
    { const ER = Math.max(1, Math.ceil(plan.nE / 256)), d = new Float32Array(512 * ER * 4), E = plan.edges;
      for (let e = 0; e < plan.nE; e++) { const o = ((e >> 8) * 512 + (e & 255) * 2) * 4, ux = E[e * 8 + 2], uz = E[e * 8 + 3], nx = E[e * 8 + 4], nz = E[e * 8 + 5];
        const sg = nx * uz - nz * ux > 0 ? 1 : -1;
        d[o] = E[e * 8]; d[o + 1] = E[e * 8 + 1]; d[o + 2] = ux; d[o + 3] = uz; d[o + 4] = plan.rect[e * 4]; d[o + 5] = plan.rect[e * 4 + 1]; d[o + 6] = E[e * 8 + 6] * sg; d[o + 7] = E[e * 8 + 7]; }
      tLME.image = { data: d, width: 512, height: ER }; tLME.needsUpdate = true; }
    uLMG.value.set(plan.x0, plan.z0, plan.gw, plan.gh); uLMA.value.set(plan.atlasW, plan.atlasH, plan.rw, plan.rh);
    lm.plan = { edges: plan.nE, atlas: [plan.atlasW, plan.atlasH], ground: [plan.gw, plan.gh], planMs: +(now() - tP).toFixed(0) };
    const apply = (res) => {
      if (!res?.ground || lm.disposed) return;
      tLMG.dispose(); tLMA.dispose();
      tLMG = half4(plan.gw, plan.gh, res.ground); tLMA = half4(plan.atlasW, plan.atlasH, res.atlas);
      U.tCityLMG.value = tLMG; U.tCityLMA.value = tLMA; uLM.value.x = 1;
      lm.ready = true; lm.ms = res.ms; lm.texels = res.texels;
    };
    const IS_NODE = typeof window === 'undefined';
    lm.apply = apply;
    if (ctx.lightmapSync || IS_NODE || typeof Worker === 'undefined') { lm.mode = 'sync'; lm.pending = bakeLM(job); }   // applied once U exists
    else {
      try {
        lm.mode = 'worker';
        const w = lm.worker = new Worker(new URL('./seoul-nightlm-worker.js', import.meta.url), { type: 'module' });
        w.onmessage = (ev) => { apply(ev.data); w.terminate(); lm.worker = null; };
        w.onerror = (e) => { console.warn('[D] night lightmap worker failed; the volume stays', e?.message || e); w.terminate(); lm.worker = null; lm.mode = 'failed'; };
        w.postMessage(job, [job.M.buffer, job.cs.buffer, job.pe.buffer, job.po.buffer, job.H.H.buffer]);
      } catch (e) { console.warn('[D] no lightmap worker', e); lm.mode = 'failed'; }
    }
  }
  // volume statistics (exterior probes at 0.5 m on streets): irradiance on an up and a side face, lux
  const volStat = (() => { let n = 0, up = 0, side = 0; for (let c = 0; c < NC; c++) { if (!roadMask[c] || inner[c * NL]) continue; const p = c * NL; const a = lumaOf([VA[p * 4], VA[p * 4 + 1], VA[p * 4 + 2]]); up += a * Math.max(0, 1 + VB[p * 4 + 1]); side += a; n++; } return { streetProbes: n, upLux: +(up / Math.max(1, n) / NS).toFixed(2), sideLux: +(side / Math.max(1, n) / NS).toFixed(2) }; })();

  // ------------------------------------------------------------------------------------- uniforms
  const aoU = world.aoUniforms || scene.userData?.aoUniforms || null;
  const blackTex = (() => { const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); t.needsUpdate = true; return t; })();
  const U = {
    tCityL: { value: tL }, tCityG: { value: tG }, tCityLD: { value: tLD }, tCityGD: { value: tGD }, tCityLC: { value: tLC },
    tCityIrrA: { value: tIrrA }, tCityIrrB: { value: tIrrB },
    uCityGrid: { value: new THREE.Vector4(x0, z0, 1 / cell, cell) }, uCityDim: { value: new THREE.Vector4(gw, gh, K4, KD4) },
    uCityDyn: { value: new THREE.Vector4(0, 0, DW, 0) },
    uCityTime: { value: 0 }, uCityGain: { value: ctx.gain ?? 1 }, uCityIrrGain: { value: ctx.irrGain ?? 1 },
    uCityHaze: { value: new THREE.Vector4(ctx.haze?.density ?? HAZE.density, ctx.haze?.height ?? HAZE.height, ctx.haze?.scatter ?? HAZE.scatter, ctx.haze?.max ?? HAZE.max) },
    uCitySkyGlow: { value: new THREE.Vector3(...NIGHT_SKY.horizon.map((v) => v * NS * 0.6)) },
    uCityAO: aoU?.uAO || { value: blackTex }, uCityAOOn: aoU?.uAOOn || { value: 0 }, uCityAOScale: aoU?.uAOScale || { value: new THREE.Vector2(1, 1) },
    uCityCar: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) }, uCityCarS: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) },
    uCityLM: uLM, uCityLMG: uLMG, uCityLMA: uLMA, tCityLMG: { value: tLMG }, tCityLMA: { value: tLMA }, tCityLMR: { value: tLMR }, tCityLME: { value: tLME },
    tCityMirror: { value: null }, uCityMirrorVP: { value: new THREE.Matrix4() }, uCityWet: { value: ctx.wet ?? 0.7 }, uCityMirrorTexel: { value: new THREE.Vector2(1, 1) },
  };
  if (!aoU?.uAO) U.uCityAO.value = U.uCityAO.value || blackTex;
  if (lm.pending) { lm.apply(lm.pending); lm.pending = null; }

  // ------------------------------------------------------------------------------------- material patch
  const patched = new Set();
  function patchMaterial(mat, opt = {}) {
    if (!mat || patched.has(mat) || !(mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) || mat.userData.cityLight === false) return false;
    patched.add(mat);
    const wet = !!(opt.wet ?? mat.userData.wet);
    const prevOBC = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
    mat.onBeforeCompile = function (sh, r) {
      if (prevOBC) prevOBC.call(this, sh, r);
      Object.assign(sh.uniforms, U);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${CITY_HEAD}${wet ? WET_HEAD : ''}`)
        .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
  vec3 cityNW = normalize(transpose(mat3(viewMatrix)) * geometryNormal), cityLMv;
  cityLMOn = cityLightmap(cityWorldPos(geometryPosition), cityNW, cityLMv);
  cityLights(geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  ${wet ? `float cityCC = cityContact(cityWorldPos(geometryPosition)); reflectedLight.directDiffuse *= mix(1.0, cityCC, 0.75); reflectedLight.directSpecular *= mix(1.0, cityCC, 0.75);` : 'float cityCC = 1.0;'}
  #if defined( RE_IndirectDiffuse )
  irradiance += (cityLMOn ? cityLMv * (uCityGain * cityAOf()) : cityIrradiance(cityWorldPos(geometryPosition), cityNW)) * cityCC;
  #endif`)
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n  gl_FragColor.rgb = cityHaze(gl_FragColor.rgb, -vViewPosition);`);
      if (wet) {
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  { vec3 wpw = cityWorldPos(-vViewPosition);
    float pn = cityNoise(wpw.xz * 0.21) * 0.6 + cityNoise(wpw.xz * 0.83 + 7.1) * 0.3 + cityNoise(wpw.xz * 3.1) * 0.1;
    cityWet = uCityWet * smoothstep(0.38, 0.62, pn);                               // puddles + damp film
    cityWet = max(cityWet, uCityWet * 0.35);
    diffuseColor.rgb *= mix(1.0, 0.55, cityWet); }                                  // wet asphalt darkens`)
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  { vec3 wpw = cityWorldPos(-vViewPosition);
    vec2 rip = (vec2(cityNoise(wpw.xz * 2.3 + uCityTime * 0.2), cityNoise(wpw.zx * 2.3 - uCityTime * 0.17)) - 0.5) * 0.06 * (1.0 - cityWet);
    vec4 mc = uCityMirrorVP * vec4(wpw + vec3(rip.x, 0.0, rip.y), 1.0);
    vec2 muv = mc.xy / mc.w * 0.5 + 0.5;
    float inb = step(0.0, mc.w) * step(0.0, muv.x) * step(muv.x, 1.0) * step(0.0, muv.y) * step(muv.y, 1.0);
    float nv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
    float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
    totalEmissiveRadiance += texture(tCityMirror, muv).rgb * (F * cityWet * inb); }`);
      }
    };
    mat.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + (wet ? '|cityW3' : '|city3'); };
    mat.needsUpdate = true;
    return true;
  }

  // ------------------------------------------------------------------------------------- city culling (perf #3)
  // P3 perf #1: each material's cells are one BatchedMesh (ctx.batch === false: one Mesh per cell, the P2 path)
  const batch = ctx.batch !== false && !!THREE.BatchedMesh;
  const cull = { on: ctx.cull !== false && !!scene, batch, cell: ctx.cullCell || (batch ? 64 : 96), colCell: ctx.colCell || 64, meshes: 0, from: 0, vertsBefore: 0, vertsAfter: 0, col: 0, ms: 0, freed: 0, batches: [] };
  const freeOnUpload = (g) => { if (!renderer || ctx.freeArrays === false) return; for (const a of [...Object.values(g.attributes), g.index]) if (a && !a.onUploadCallback?.__d) { const f = function () { this.array = new this.array.constructor(0); cull.freed += 1; }; f.__d = 1; a.onUpload(f); } };
  let colBatch = null;
  if (cull.on) {
    const tc0 = now(), olds = [];
    for (const o of [...scene.children]) {
      if (!o.isMesh || o.isInstancedMesh || o.isBatchedMesh || !/^seoul:/.test(o.name || '') || !o.geometry?.getAttribute?.('position')) continue;
      if (o.geometry.groups?.length > 1 || Array.isArray(o.material)) continue;
      const ts = now(), sp = splitCells(o.geometry, cull.cell); cull.tSplit = (cull.tSplit || 0) + now() - ts; if (!sp) continue;
      cull.from++; cull.vertsBefore += sp.srcVertices; cull.vertsAfter += sp.vertices;
      const ud = { ...o.userData, seoulKey: o.name.slice(6) };
      if (batch) {
        const tb = now(), bm = batchCells(sp, o.material); cull.tBatch = (cull.tBatch || 0) + now() - tb;
        bm.name = o.name; bm.userData = { ...ud, ...bm.userData, cells: sp.parts.length };
        bm.receiveShadow = o.receiveShadow; bm.castShadow = o.castShadow; bm.renderOrder = o.renderOrder;
        if (o.frustumCulled === false) { bm.frustumCulled = false; bm.perObjectFrustumCulled = false; }
        bm.matrixAutoUpdate = false; bm.updateMatrix(); bm.updateMatrixWorld(true);
        freeOnUpload(bm.geometry);   // perf #4: the CPU copy goes once the GPU has it (bounds are cached)
        scene.add(bm); cull.meshes += sp.parts.length; cull.batches.push(bm);
      } else {
        if (sp.parts.length) freeOnUpload(sp.parts[0].geometry);
        for (const p of sp.parts) {
          const m = new THREE.Mesh(p.geometry, o.material);
          m.name = o.name; m.userData = { ...ud, cell: p.cell }; m.receiveShadow = o.receiveShadow; m.castShadow = o.castShadow;
          m.matrixAutoUpdate = false; m.renderOrder = o.renderOrder; m.updateMatrix(); m.updateMatrixWorld(true);
          if (o.frustumCulled === false) m.frustumCulled = false;
          scene.add(m); cull.meshes++;
        }
      }
      olds.push(o);
    }
    for (const o of olds) { scene.remove(o); o.geometry.dispose(); }
    marks.split = +(now() - tc0).toFixed(0); marks.splitCells = +(cull.tSplit || 0).toFixed(0); marks.batch = +(cull.tBatch || 0).toFixed(0);
    // the collider for fpvcam's depth pass and the mirror: cells (P3: one BatchedMesh, one draw; else a Mesh per cell)
    const cs = world.colliderScene;
    const cm = cs?.children?.find((c) => c.isMesh && !c.isBatchedMesh && c.geometry?.getAttribute('position'));
    if (cm) {
      const g = cm.geometry;
      if (batch) {
        const g0 = new THREE.BufferGeometry(); g0.setAttribute('position', g.getAttribute('position')); if (g.index) g0.setIndex(g.index);
        const sp = splitCells(g0, cull.colCell, 0);
        colBatch = batchCells(sp, cm.material); colBatch.name = 'seoul:col'; colBatch.userData.colCell = true; colBatch.matrixAutoUpdate = false;
        freeOnUpload(colBatch.geometry);
        cs.remove(cm); cs.add(colBatch); cull.col = sp.parts.length;
      } else {
        const pos = g.getAttribute('position'), idx = g.index, nT = (idx ? idx.count : pos.count) / 3, P = pos.array;
        const vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
        const keyOf = new Map(), keys = new Int32Array(nT), cc = cull.colCell;
        for (let t = 0; t < nT; t++) { const a = vi(t, 0) * 3, b = vi(t, 1) * 3, c = vi(t, 2) * 3; const kx = Math.floor((P[a] + P[b] + P[c]) / 3 / cc), kz = Math.floor((P[a + 2] + P[b + 2] + P[c + 2]) / 3 / cc); const k = kx * 4096 + kz; if (!keyOf.has(k)) keyOf.set(k, keyOf.size); keys[t] = keyOf.get(k); }
        const nk = keyOf.size, cnt = new Int32Array(nk + 1); for (let t = 0; t < nT; t++) cnt[keys[t] + 1]++; for (let k = 0; k < nk; k++) cnt[k + 1] += cnt[k];
        const fillc = cnt.slice(0, nk), ix = new Uint32Array(nT * 3);
        for (let t = 0; t < nT; t++) { const o = fillc[keys[t]]++; ix[o * 3] = vi(t, 0); ix[o * 3 + 1] = vi(t, 1); ix[o * 3 + 2] = vi(t, 2); }
        const ia = new THREE.BufferAttribute(ix, 1);
        cs.remove(cm);
        for (let k = 0; k < nk; k++) {
          const s = cnt[k], e = cnt[k + 1]; if (e <= s) continue;
          const geo = new THREE.BufferGeometry(); geo.setAttribute('position', pos); geo.setIndex(ia); geo.setDrawRange(s * 3, (e - s) * 3);
          let a0 = Infinity, a1 = Infinity, a2 = Infinity, b0 = -Infinity, b1 = -Infinity, b2 = -Infinity;
          for (let q = s * 3; q < e * 3; q++) { const v = ix[q] * 3, X = P[v], Y = P[v + 1], Z = P[v + 2]; if (X < a0) a0 = X; if (X > b0) b0 = X; if (Y < a1) a1 = Y; if (Y > b1) b1 = Y; if (Z < a2) a2 = Z; if (Z > b2) b2 = Z; }
          const bb = new THREE.Box3(new THREE.Vector3(a0, a1, a2), new THREE.Vector3(b0, b1, b2));
          geo.boundingBox = bb; geo.boundingSphere = bb.getBoundingSphere(new THREE.Sphere());
          const m = new THREE.Mesh(geo, cm.material); m.name = 'seoul:col'; m.matrixAutoUpdate = false; m.userData.colCell = true; cs.add(m); cull.col++;
        }
      }
    }
    cull.ms = +(now() - tc0).toFixed(0);
  }

  // patch every world material (after the split: same materials)
  let nMat = 0, nWet = 0;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const wet = !!(m?.userData?.wet || o.userData.ground || (ctx.wetNames ?? /road|asphalt|ground|street|lane/i).test(o.name || ''));
      if (wet && m) m.userData.wet = m.userData.wet ?? 1;
      if (patchMaterial(m, { wet })) { nMat++; if (wet) nWet++; }
    }
  });
  // the hemisphere stand-in gives way to the volume (it carries the sky and the bounce)
  const base = scene.userData.seoul?.baseLight;
  if (base?.isLight && ctx.keepBaseLight !== true) { base.intensity *= ctx.baseLightScale ?? 0; if (base.intensity <= 0) base.visible = false; }

  // ------------------------------------------------------------------------------------- sky
  const skyMat = () => new THREE.ShaderMaterial({
    uniforms: { uZen: { value: new THREE.Vector3(...NIGHT_SKY.zenith.map((v) => v * NS)) }, uHor: { value: new THREE.Vector3(...NIGHT_SKY.horizon.map((v) => v * NS)) },
      uGlowH: { value: NIGHT_SKY.glowH } },
    vertexShader: 'varying vec3 vD; void main(){ vD = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
    fragmentShader: `uniform vec3 uZen; uniform vec3 uHor; uniform float uGlowH; varying vec3 vD;
      float h2(vec2 p){ p = fract(p * vec2(0.1031, 0.103)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
      void main(){ vec3 d = normalize(vD); float e = max(d.y, 0.0);
        vec3 c = mix(uHor, uZen, smoothstep(0.0, uGlowH * 3.0, e));
        float cl = h2(floor(d.xz / max(d.y, 0.05) * 0.35)) * 0.15 + 0.92;                 // faint lit cloud deck texture
        c *= mix(1.0, cl, smoothstep(0.05, 0.4, e));
        gl_FragColor = vec4(d.y < 0.0 ? uHor * 0.6 : c, 1.0); }`,
    side: THREE.BackSide, depthWrite: false, depthTest: true,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2000, 32, 16), skyMat());
  Object.assign(sky, { frustumCulled: false, renderOrder: -1000, name: 'seoul.sky' });
  if (ctx.sky !== false) scene.add(sky);

  // ------------------------------------------------------------------------------------- mirror (wet ground)
  const mirror = { scene: new THREE.Scene(), cam: new THREE.PerspectiveCamera(), rt: null, rt2: null, on: nWet > 0 && !!renderer && ctx.reflect !== false, y: ctx.groundY ?? 0, occR: ctx.mirrorOccR ?? 60 };
  const cardGeo = new THREE.PlaneGeometry(1, 1);
  const cardMat = new THREE.ShaderMaterial({
    uniforms: { uT: U.uCityTime },
    vertexShader: `attribute vec3 aRad; attribute vec3 aFl; varying vec3 vRad; uniform float uT;
      void main(){ vRad = aRad * (1.0 - aFl.y * (0.5 + 0.5 * sin(6.2831853 * aFl.x * uT + aFl.z)));
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: 'varying vec3 vRad; void main(){ gl_FragColor = vec4(vRad, 1.0); }',
    side: THREE.DoubleSide,
  });
  // cards: static (fixed + animated) first, then every moving emitter
  const cardList = stat.concat(mov), NCard = Math.max(1, cardList.length);
  const cards = new THREE.InstancedMesh(cardGeo, cardMat, NCard);
  const aRad = new THREE.InstancedBufferAttribute(new Float32Array(NCard * 3), 3), aFl = new THREE.InstancedBufferAttribute(new Float32Array(NCard * 3), 3);
  cardGeo.setAttribute('aRad', aRad); cardGeo.setAttribute('aFl', aFl);
  cards.frustumCulled = false; cards.count = cardList.length;
  const IM = cards.instanceMatrix.array;
  function setCard(i, e) {   // plane facing e.normal (written directly: no Matrix4/Quaternion per call)
    const n = e.normal || [0, 0, 1], nl = Math.hypot(n[0], n[1], n[2]) || 1, nx = n[0] / nl, ny = n[1] / nl, nz = n[2] / nl;
    // tangent: horizontal right of the normal (or x for up/down faces)
    let tx = nz, tz = -nx, tl = Math.hypot(tx, tz); if (tl < 1e-4) { tx = 1; tz = 0; tl = 1; } tx /= tl; tz /= tl;
    const bx = ny * tz, by = nz * tx - nx * tz, bz = -ny * tx;   // n x t
    const w = e.w || 0.5, h = e.h || 0.5, o = i * 16;
    IM[o] = tx * w; IM[o + 1] = 0; IM[o + 2] = tz * w; IM[o + 3] = 0;
    IM[o + 4] = bx * h; IM[o + 5] = by * h; IM[o + 6] = bz * h; IM[o + 7] = 0;
    IM[o + 8] = nx; IM[o + 9] = ny; IM[o + 10] = nz; IM[o + 11] = 0;
    IM[o + 12] = e.pos[0] + nx * 0.05; IM[o + 13] = e.pos[1] + ny * 0.05; IM[o + 14] = e.pos[2] + nz * 0.05; IM[o + 15] = 1;
    const r = rad(e, _r); aRad.array[i * 3] = r[0]; aRad.array[i * 3 + 1] = r[1]; aRad.array[i * 3 + 2] = r[2];
    aFl.array[i * 3] = e.flicker?.hz || 0; aFl.array[i * 3 + 1] = Math.min(1, e.flicker?.depth || 0); aFl.array[i * 3 + 2] = (i * 2.399) % 6.283;
  }
  cardList.forEach((e, i) => setCard(i, e));
  cards.instanceMatrix.needsUpdate = true; aRad.needsUpdate = true; aFl.needsUpdate = true;
  cards.instanceMatrix.setUsage(THREE.DynamicDrawUsage); aRad.setUsage(THREE.DynamicDrawUsage);
  const clipUp = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -(mirror.y + 0.05))];
  const occMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, clippingPlanes: clipUp });
  const mskyMat = skyMat(); mskyMat.side = THREE.DoubleSide;
  const msky = new THREE.Mesh(sky.geometry, mskyMat); msky.frustumCulled = false; msky.renderOrder = -1000;
  mirror.scene.add(msky, cards);
  const occ = world.colliderScene || null;
  const blurMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() }, uTexel: { value: new THREE.Vector2() } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D tSrc; uniform vec2 uDir; uniform vec2 uTexel; varying vec2 vUv;
      void main(){ vec3 c = vec3(0.0); float w = 0.0;
        for (int i = -6; i <= 6; i++) { float k = exp(-float(i * i) / 18.0); c += texture(tSrc, vUv + uDir * uTexel * float(i)).rgb * k; w += k; }
        gl_FragColor = vec4(c / w, 1.0); }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat); quad.frustumCulled = false;
  const quadScene = new THREE.Scene(); quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const Rm = new THREE.Matrix4().set(1, 0, 0, 0, 0, -1, 0, 2 * mirror.y, 0, 0, 1, 0, 0, 0, 0, 1);
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _sz = new THREE.Vector2(), _cp = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  const hidden = [];
  function renderMirror(r, cam) {
    const prev = r.getRenderTarget();
    const W = Math.max(64, Math.round((prev ? prev.viewport.z : r.getDrawingBufferSize(_sz).x) * Q.refl)), H = Math.max(36, Math.round((prev ? prev.viewport.w : _sz.y) * Q.refl));
    if (!mirror.rt || mirror.rt.width !== W || mirror.rt.height !== H) {
      mirror.rt?.dispose(); mirror.rt2?.dispose();
      const o = { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false };
      mirror.rt = new THREE.WebGLRenderTarget(W, H, o); mirror.rt2 = new THREE.WebGLRenderTarget(W, H, { ...o, depthBuffer: false });
    }
    const mc = mirror.cam;
    mc.projectionMatrix.copy(cam.projectionMatrix); mc.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
    mc.matrixWorld.multiplyMatrices(Rm, cam.matrixWorld); mc.matrixWorldInverse.copy(mc.matrixWorld).invert();
    mc.matrixAutoUpdate = false; mc.matrixWorldAutoUpdate = false;
    const ac = r.autoClear, cc = r.getClearAlpha(); r.autoClear = true;
    r.setRenderTarget(mirror.rt);
    if (occ) {
      // occluders within occR m only (perf #3): the collider cells farther away are hidden for this pass
      _cp.setFromMatrixPosition(cam.matrixWorld); hidden.length = 0;
      for (const m of occ.children) {
        if (m.isBatchedMesh && m.userData.colCell) {   // P3: hide the far cells (instances) of the batched collider
          const S = m.userData.cellSpheres, I = m.userData.instanceIds;
          for (let i = 0; i < S.length; i++) if (S[i].center.distanceTo(_cp) - S[i].radius > mirror.occR) { m.setVisibleAt(I[i], false); hidden.push([m, I[i]]); }
        } else if (m.userData.colCell && m.visible && m.geometry.boundingSphere && m.geometry.boundingSphere.center.distanceTo(_cp) - m.geometry.boundingSphere.radius > mirror.occR) { m.visible = false; hidden.push(m); }
      }
      const lc = r.localClippingEnabled; r.localClippingEnabled = true;
      r.clear(true, true, false); occ.overrideMaterial = occMat; r.autoClear = false; r.render(occ, mc); occ.overrideMaterial = null;
      r.localClippingEnabled = lc;
      for (const h of hidden) { if (Array.isArray(h)) h[0].setVisibleAt(h[1], true); else h.visible = true; }
    }
    r.render(mirror.scene, mc);
    _v.set(0, 0, -20).applyMatrix4(cam.matrixWorld); _v.y = mirror.y;
    _v2.copy(_v).add(UP).project(mc); _v.project(mc);
    let dx = _v2.x - _v.x, dy = _v2.y - _v.y; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    blurMat.uniforms.uTexel.value.set(1 / W, 1 / H);
    r.autoClear = true;
    blurMat.uniforms.tSrc.value = mirror.rt.texture; blurMat.uniforms.uDir.value.set(dx * 2.2, dy * 2.2);
    r.setRenderTarget(mirror.rt2); r.render(quadScene, quadCam);
    blurMat.uniforms.tSrc.value = mirror.rt2.texture; blurMat.uniforms.uDir.value.set(-dy * 0.6, dx * 0.6);
    r.setRenderTarget(mirror.rt); r.render(quadScene, quadCam);
    r.autoClear = ac; r.setClearAlpha(cc);
    r.setRenderTarget(prev);
    U.tCityMirror.value = mirror.rt.texture;
    U.uCityMirrorVP.value.multiplyMatrices(mc.projectionMatrix, mc.matrixWorldInverse);
  }
  if (mirror.on) {
    const prevOBR = scene.onBeforeRender;
    scene.onBeforeRender = function (r, sc, cam, target) {
      prevOBR?.call(this, r, sc, cam, target);
      if (!mirror.on || !cam?.isPerspectiveCamera) return;
      try { renderMirror(r, cam); } catch (e) { mirror.on = false; console.warn('[D] wet mirror off', e); }
    };
  }
  if (!mirror.on) { const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true; U.tCityMirror.value = black; }

  // ------------------------------------------------------------------------------------- airlight sprites (lighting #3)
  // Closed-form single scattering of a point source along the view ray (isotropic phase, attenuation to the source):
  // L = sigma I e^(-sigma d) / (4 pi h) x [atan(s0 / h) + atan((t1 - s0) / h)], h = the ray's distance to the source,
  // s0 = its projection; integrated to the source's depth (+3 m behind a free-hanging lamp). Depth-tested sprites, so
  // anything in front cuts the glow; pushed toward the camera so the facade the source hangs on doesn't.
  const air = { n: ctx.airlight === false ? 0 : Q.air, mesh: null, every: 3, frame: 0, list: [], cand: null };
  const airI = new Float32Array(all.length), airCol = [];   // per emitter: effective intensity (scene cd, luminance) + colour
  const glowOf = (e, m) => {
    const c = e.rgb || (SOURCE_TYPES[e.kind] || SOURCE_TYPES.lightbox).rgb, cl = Math.max(1e-4, lumaOf(c));
    const I = m.ty === LT.lambert ? (e.nits ?? 0) * NS * m.A * 0.5 : m.ty === LT.street ? m.peak / 30 * 2.2 : m.peak * 0.3;
    return [I, [c[0] / cl, c[1] / cl, c[2] / cl]];
  };
  if (air.n > 0) {
    const g = new THREE.InstancedBufferGeometry(); g.copy(new THREE.PlaneGeometry(2, 2)); g.instanceCount = 0;
    const iP = new THREE.InstancedBufferAttribute(new Float32Array(air.n * 4), 4), iC = new THREE.InstancedBufferAttribute(new Float32Array(air.n * 4), 4), iX = new THREE.InstancedBufferAttribute(new Float32Array(air.n * 4), 4);
    for (const a of [iP, iC, iX]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iP', iP); g.setAttribute('iC', iC); g.setAttribute('iX', iX);
    const m = new THREE.ShaderMaterial({
      uniforms: { uSigma: { value: U.uCityHaze.value.x }, uGain: { value: ctx.airGain ?? AIRLIGHT.gain } },
      vertexShader: `attribute vec4 iP; attribute vec4 iC; attribute vec4 iX; varying vec3 vW; varying vec4 vP; varying vec4 vC; varying vec4 vX; varying vec2 vQ;
        void main(){ vec3 c = iP.xyz, toC = cameraPosition - c; float dc = length(toC); vec3 f = toC / max(dc, 1e-3);
          vec3 r = normalize(cross(abs(f.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0), f)), u = cross(f, r);
          vec3 cen = c + f * min(iX.x, dc * 0.5);                                       // pushed toward the camera
          vec3 w = cen + (r * position.x + u * position.y) * iP.w;
          vW = w; vP = iP; vC = iC; vX = iX; vQ = position.xy; gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`,
      fragmentShader: `uniform float uSigma; uniform float uGain; varying vec3 vW; varying vec4 vP; varying vec4 vC; varying vec4 vX; varying vec2 vQ;
        void main(){ vec3 v = normalize(vW - cameraPosition), pc = vP.xyz - cameraPosition; float s0 = dot(pc, v), d2 = dot(pc, pc);
          float h = sqrt(max(d2 - s0 * s0, vX.y * vX.y)), d = sqrt(d2);
          float L = uSigma * vC.w * exp(-uSigma * d) / (12.566 * h) * (atan(s0 / h) + atan(vX.z / h));
          float edge = 1.0 - smoothstep(0.6, 1.0, length(vQ));
          gl_FragColor = vec4(vC.rgb * (L * uGain * edge), 1.0); }`,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    air.mesh = new THREE.Mesh(g, m); air.mesh.frustumCulled = false; air.mesh.renderOrder = 9; air.mesh.name = 'seoul.airlight';
    Object.assign(air, { g, iP, iC, iX, mat: m });
    scene.add(air.mesh);
  }
  const allMeta = new Map(); stat.forEach((e, i) => allMeta.set(e, metas[i]));
  all.forEach((e, i) => { const m = allMeta.get(e) || meta(e); const [I, c] = glowOf(e, m); airI[i] = I; airCol[i] = c; });
  // P3 lighting #5: no source's airlight outshines lampCap x a street lamp's in any channel (the brightest channel of a
  // luminance-normalised blue is 7-14x its luminance: that made the violet clouds)
  { const ref = []; all.forEach((e, i) => { if (e.kind === 'street' && airI[i] > 0) ref.push(airI[i] * Math.max(...airCol[i])); });
    ref.sort((a, b) => a - b); const cap = (ctx.airLampCap ?? AIRLIGHT.lampCap) * (ref.length ? ref[ref.length >> 1] : 100);
    let nc = 0; all.forEach((e, i) => { const pk = airI[i] * Math.max(...airCol[i]); if (pk > cap) { airI[i] *= cap / pk; nc++; } });
    air.cap = +cap.toFixed(1); air.capped = nc; }
  const airIdx = new Int32Array(64), airKey = new Float32Array(64), _fw = new THREE.Vector3(), _camY = [0];
  const airKind = new Uint8Array(all.length), airPos = new Float32Array(all.length * 3);   // 0 fixed, 1 animated, 2 moving
  all.forEach((e, i) => { airKind[i] = isMov(e) ? 2 : isAnim(e) ? 1 : 0; airPos[i * 3] = e.pos[0]; airPos[i * 3 + 1] = e.pos[1]; airPos[i * 3 + 2] = e.pos[2]; });
  { const lim = 8 * AIRLIGHT.minL * 0.5 / HAZE.density; air.cand = Int32Array.from(all.map((e, i) => i).filter((i) => airI[i] >= lim)); }
  function updateAir(camPos, cam) {
    if (!air.mesh || !camPos) return;
    const sig = U.uCityHaze.value.x; air.mat.uniforms.uSigma.value = sig;
    if (air.frame++ % air.every === 0) {   // re-pick the brightest sources every other frame
      let n = 0;
      const cq = cam?.isQuaternion ? cam : cam?.quaternion;   // world-seoul passes the camera quaternion; tests may pass a camera
      if (cq) _fw.set(0, 0, -1).applyQuaternion(cq); else _fw.set(0, 0, 0);
      const cand = air.cand;
      for (let ii = 0; ii < cand.length; ii++) {
        const i = cand[ii], kd = airKind[i]; let I = airI[i], px, py, pz;
        if (kd) { const e = all[i]; if (!(e.nits > 0)) continue; if (kd === 1) I *= Math.min(1, e.nits / Math.max(1, (e.nitsMax ?? SOURCE_TYPES.screen.nits))); if (kd === 2) { px = e.pos[0]; py = e.pos[1]; pz = e.pos[2]; } }
        if (kd !== 2) { px = airPos[i * 3]; py = airPos[i * 3 + 1]; pz = airPos[i * 3 + 2]; }
        const dx = px - camPos.x, dy = py - camPos.y, dz = pz - camPos.z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 140 * 140 || d2 < AIRLIGHT.nearM * AIRLIGHT.nearM) continue;   // P3: none within nearM of the lens
        const d = Math.sqrt(d2);
        if (cq && dx * _fw.x + dy * _fw.y + dz * _fw.z < -0.3 * d) continue;
        const key = I * (1 - sig * d) / d;
        if (n < 64) { airIdx[n] = i; airKey[n] = key; n++; }
        else { let mi = 0; for (let j = 1; j < 64; j++) if (airKey[j] < airKey[mi]) mi = j; if (key > airKey[mi]) { airIdx[mi] = i; airKey[mi] = key; } }
      }
      const ord = Array.from({ length: n }, (_, j) => j).sort((a, b) => airKey[b] - airKey[a]);
      air.list.length = 0;
      for (const j of ord) {
        if (air.list.length >= air.n) break;
        const e = all[airIdx[j]];
        // occluded by the heightfield (camera -> source)? then it gets no sprite
        _camY[0] = camPos.y; if (HF.occ(e.pos[0], e.pos[1], e.pos[2], camPos.x, camPos.z, _camY, 1.2, 0.5)) continue;
        air.list.push(airIdx[j]);
      }
    }
    let k = 0; const P = air.iP.array, C = air.iC.array, X = air.iX.array, minL = AIRLIGHT.minL;
    for (const i of air.list) {
      const e = all[i], m = allMeta.get(e); let I = airI[i];
      if (isMov(e) || isAnim(e)) { if (!(e.nits > 0)) continue; if (isAnim(e)) I *= Math.min(1, e.nits / Math.max(1, (e.nitsMax ?? SOURCE_TYPES.screen.nits))); }
      const d = Math.hypot(e.pos[0] - camPos.x, e.pos[1] - camPos.y, e.pos[2] - camPos.z);
      if (d < AIRLIGHT.nearM) continue;
      I *= sstep(AIRLIGHT.nearM, AIRLIGHT.nearM + AIRLIGHT.fadeM, d);              // fades in past nearM
      const R = Math.min(AIRLIGHT.maxR, 0.4 * d + 0.5, sig * I / (8 * minL));
      if (R < 0.2) continue;
      const hmin = Math.max(0.08, 0.5 * Math.sqrt(m ? m.A : (e.w || 0.5) * (e.h || 0.5)));
      const back = m?.ty === LT.street ? 3 : 0;
      P[k * 4] = e.pos[0]; P[k * 4 + 1] = e.pos[1]; P[k * 4 + 2] = e.pos[2]; P[k * 4 + 3] = R;
      const c = isAnim(e) && e.rgb ? e.rgb : airCol[i]; const cl = Math.max(1e-4, lumaOf(c));
      C[k * 4] = c[0] / cl; C[k * 4 + 1] = c[1] / cl; C[k * 4 + 2] = c[2] / cl; C[k * 4 + 3] = I;
      X[k * 4] = Math.min(R * 0.7, 4); X[k * 4 + 1] = hmin; X[k * 4 + 2] = back; X[k * 4 + 3] = 0;
      k++;
    }
    air.g.instanceCount = k;
    air.iP.clearUpdateRanges(); air.iP.addUpdateRange(0, k * 4); air.iP.needsUpdate = true;
    air.iC.clearUpdateRanges(); air.iC.addUpdateRange(0, k * 4); air.iC.needsUpdate = true;
    air.iX.clearUpdateRanges(); air.iX.addUpdateRange(0, k * 4); air.iX.needsUpdate = true;
  }

  // ------------------------------------------------------------------------------------- headlight pools (lighting #4)
  // G's pools (one quad per vehicle, iPool = x, z, yaw, I) get a physically sized low-beam fan; the vehicles the grid
  // lights (the dynamic set, within uPoolR) fade out of it, so no light is counted twice.
  const pool = { mesh: null, R: { value: 0 } };
  const poolMesh = (() => { let p = null; scene.traverse((o) => { if (!p && o.name === 'headlight-pools' && o.geometry?.getAttribute?.('iPool')) p = o; }); return p; })();
  if (poolMesh && ctx.pools !== false) {
    const nitU = poolMesh.material?.uniforms?.uNit || { value: NS };
    const pm = new THREE.ShaderMaterial({
      uniforms: { uNit: nitU, uWet: U.uCityWet, uPoolR: pool.R, uPeak: { value: HEADLIGHT.poolNits }, uLen: { value: HEADLIGHT.poolLen } },
      vertexShader: `attribute vec4 iPool; uniform float uLen; varying vec2 vF; varying float vI; varying float vD;
        void main(){ vec3 p = position;                                               // G's quad: x +-1.7, z 0..14 ahead of the bumper
          vec2 q = vec2(p.x / 1.7, p.z / 14.0);                                       // -> across -1..1, along 0..1
          vec2 lp = vec2(q.x * (1.0 + 4.5 * q.y) * 1.6, q.y * uLen);                    // widen into a fan, uLen long
          float c = cos(iPool.z), s = sin(iPool.z);
          vec3 w = vec3(c * lp.x + s * lp.y, 0.0, -s * lp.x + c * lp.y) + vec3(iPool.x, 0.03, iPool.y);
          vF = vec2(q.x, q.y); vI = iPool.w; vD = distance(cameraPosition.xz, iPool.xy);
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`,
      fragmentShader: `uniform float uNit; uniform float uWet; uniform float uPoolR; uniform float uPeak; uniform float uLen; varying vec2 vF; varying float vI; varying float vD;
        void main(){ float a = vF.y * uLen;                                            // metres ahead
          float along = smoothstep(1.0, 4.0, a) * (1.0 - smoothstep(0.45, 1.0, vF.y)) * (0.35 + 0.65 * exp(-a / 9.0));
          float across = 1.0 - smoothstep(0.55, 1.0, abs(vF.x));
          float far = smoothstep(uPoolR * 0.85, uPoolR * 1.1 + 1.0, vD);               // near ones: the grid lights them
          float f = along * across * far * (1.0 - 0.6 * uWet);
          gl_FragColor = vec4(vec3(1.0, 0.95, 0.85) * f * vI * uPeak * uNit, 1.0); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    poolMesh.material?.dispose?.(); poolMesh.material = pm; pool.mesh = poolMesh;
  }

  // ------------------------------------------------------------------------------------- steam
  let steam = null;
  if (ctx.steam !== false && Q.steam > 0) {
    const vents = [];
    for (const e of stat) if (e.kind === 'tent' || e.kind === 'store') vents.push(e);
    for (const l of ctx.layout?.lots || []) if (/pocha|restaurant/.test(l.use) && l.frontage) vents.push({ pos: [(l.frontage[0][0] + l.frontage[1][0]) / 2, 0.4, (l.frontage[0][1] + l.frontage[1][1]) / 2] });
    if (vents.length) {
      const N = Q.steam, pos = new Float32Array(N * 3), seed = new Float32Array(N * 4), lit = new Float32Array(N * 3);
      let s = 12345; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      for (let i = 0; i < N; i++) {
        const v = vents[i % vents.length];
        pos.set([v.pos[0] + (rnd() - 0.5) * 2, Math.max(0.3, Math.min(v.pos[1], 2.5)), v.pos[2] + (rnd() - 0.5) * 2], i * 3);
        seed.set([rnd(), rnd(), rnd(), 0.6 + rnd()], i * 4);
        // lit by the static lights at the vent (steam scatters forward: the halo around shopfronts)
        let er = 0, eg = 0, eb = 0;
        for (let j = 0; j < stat.length; j++) { const m = metas[j], f = kAt(m, pos[i * 3], pos[i * 3 + 1] + 1.5, pos[i * 3 + 2]); if (f > 0) { er += m.I[0] * f; eg += m.I[1] * f; eb += m.I[2] * f; } }
        lit.set([er, eg, eb].map((x) => x * 0.6 / (4 * Math.PI)), i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4)); g.setAttribute('aLit', new THREE.BufferAttribute(lit, 3));
      const m = new THREE.ShaderMaterial({
        uniforms: { uT: U.uCityTime, uScale: { value: 300 } },
        vertexShader: `attribute vec4 aSeed; attribute vec3 aLit; uniform float uT; uniform float uScale; varying vec3 vLit; varying float vA;
          void main(){ float life = 6.0 * aSeed.w; float ph = fract(uT / life + aSeed.x);
            vec3 p = position + vec3(sin(uT * 0.3 + aSeed.y * 6.0) * 0.6 * ph, ph * 4.5, cos(uT * 0.25 + aSeed.z * 6.0) * 0.6 * ph);
            vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
            float sz = (0.5 + 1.8 * ph) * aSeed.w; gl_PointSize = min(uScale * sz / max(-mv.z, 0.3), 96.0);
            vA = sin(ph * 3.14159) * 0.22 * smoothstep(1.5, 3.0, -mv.z); vLit = aLit; }`,
        fragmentShader: `varying vec3 vLit; varying float vA; void main(){ vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q); if (r > 1.0) discard;
            float a = vA * (1.0 - r) * (1.0 - r); gl_FragColor = vec4(vLit, a); }`,
        transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      });
      steam = new THREE.Points(g, m); steam.frustumCulled = false; steam.renderOrder = 10; steam.name = 'seoul.steam';
      scene.add(steam);
    }
  }

  // ------------------------------------------------------------------------------------- per frame
  // scratch (no allocation per frame)
  const nMov = mov.length, movKey = new Float32Array(Math.max(1, nMov)), movOrd = new Int32Array(Math.max(1, nMov));
  const dS = new Float32Array(DW * DW * KD), dI = new Uint16Array(DW * DW * KD), dN = new Uint8Array(DW * DW);
  const movMeta = mov.map(() => null), cardOn = new Uint8Array(Math.max(1, nMov)).fill(1);
  const uStats = { ms: 0, dyn: 0, contact: 0 };
  // vehicles for contact shadows: G's head/tail emitter pairs ('<id>:head' / '<id>:tail')
  const cars = []; { const byId = new Map(); for (const e of mov) { const m = /^(.*):(head|tail)$/.exec(e.id || ''); if (!m) continue; const r = byId.get(m[1]) || {}; r[m[2]] = e; byId.set(m[1], r); }
    for (const r of byId.values()) if (r.head && r.tail) cars.push(r); }
  const carD = new Float32Array(Math.max(1, cars.length)), carI = new Int32Array(Math.max(1, cars.length));
  let lastCam = null;
  function update(t, camPos, cam) {
    const t0 = now();
    U.uCityTime.value = (t ?? 0) % 3600;
    if (steam && renderer) steam.material.uniforms.uScale.value = 0.5 * (renderer.getDrawingBufferSize(_sz).y || 600);
    if (camPos) lastCam = camPos;
    const cp = camPos || lastCam || { x: (x0 + x1) / 2, y: 2, z: (z0 + z1) / 2 };
    // (1) in-place animated (screens): colour row + their mirror cards, nothing rebinned
    if (nAnim) {
      const C = tLC.image.data;
      for (let j = 0; j < nAnim; j++) {
        const e = anim[j], m = metas[animBase + j], r = rad(e, _r);
        const A = m.A; C[j * 4] = r[0] * A; C[j * 4 + 1] = r[1] * A; C[j * 4 + 2] = r[2] * A;
        const ci = (animBase + j) * 3; aRad.array[ci] = r[0]; aRad.array[ci + 1] = r[1]; aRad.array[ci + 2] = r[2];
      }
      tLC.clearUpdateRanges(); tLC.addUpdateRange(0, Math.min(nAnim, LW) * 4); for (let row = 1; row * LW < nAnim; row++) tLC.addUpdateRange(row * LW * 4, Math.min(LW, nAnim - row * LW) * 4);
      tLC.needsUpdate = true;
      aRad.clearUpdateRanges(); aRad.addUpdateRange(animBase * 3, nAnim * 3);
    } else aRad.clearUpdateRanges();
    // (2) moving: every card follows its emitter; the Nd brightest-nearest are the dynamic lights
    if (nMov) {
      let nc = 0;
      for (let j = 0; j < nMov; j++) {
        const e = mov[j], dx = e.pos[0] - cp.x, dz = e.pos[2] - cp.z, d2 = dx * dx + dz * dz, ci = stat.length + j;
        if (d2 < 160 * 160 && e.nits > 0) { setCard(ci, e); cardOn[j] = 1; }
        else if (cardOn[j]) { IM.fill(0, ci * 16, ci * 16 + 16); cardOn[j] = 0; }
        if (!(e.nits > 0) || d2 > 120 * 120) continue;
        const w = e.beam ? 4 : (e.nits || 0) / 5000;            // head lamps first, then the brighter tails
        movKey[nc] = w / (d2 + 25); movOrd[nc++] = j;
      }
      // partial selection of the Nd largest keys
      const nd = Math.min(Q.Nd, nc);
      for (let a = 0; a < nd; a++) { let bi = a; for (let b = a + 1; b < nc; b++) if (movKey[b] > movKey[bi]) bi = b; if (bi !== a) { const tk = movKey[a]; movKey[a] = movKey[bi]; movKey[bi] = tk; const to = movOrd[a]; movOrd[a] = movOrd[bi]; movOrd[bi] = to; } }
      // window origin: the camera's cell minus half the window
      const ox = Math.floor((cp.x - x0) / cell) - (DW >> 1), oz = Math.floor((cp.z - z0) / cell) - (DW >> 1);
      U.uCityDyn.value.set(ox, oz, DW, U.uCityDyn.value.w);
      dN.fill(0); const gd = tGD.image.data; gd.fill(NONE);
      let poolR = 0;
      for (let a = 0; a < nd; a++) {
        const j = movOrd[a], e = mov[j];
        const m = movMeta[j] = meta(e, false, movMeta[j]);   // refreshed in place
        pack(m, tLD.image.data, a, 0);
        if (e.beam) poolR = Math.max(poolR, Math.hypot(e.pos[0] - cp.x, e.pos[2] - cp.z));
        const r = m.range + (m.hl > 0 ? m.a : 0);
        const cx0 = Math.max(0, Math.floor((m.x - r - x0) / cell) - ox), cx1 = Math.min(DW - 1, Math.floor((m.x + r - x0) / cell) - ox);
        const cz0 = Math.max(0, Math.floor((m.z - r - z0) / cell) - oz), cz1 = Math.min(DW - 1, Math.floor((m.z + r - z0) / cell) - oz);
        const Il = LUMA[0] * m.I[0] + LUMA[1] * m.I[1] + LUMA[2] * m.I[2], oneSided = m.ty === LT.beam || (m.ty === LT.lambert && m.omni < 0.3 && Math.abs(m.n[1]) < 0.7);
        for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
          const ax = x0 + (cx + ox) * cell, az = z0 + (cz + oz) * cell;
          if (oneSided) {   // all four corners behind the lamp's forward plane: nothing to light here
            const fx = m.n[0], fz = m.n[2], b0 = (ax - m.x) * fx + (az - m.z) * fz, du = cell * fx, dv = cell * fz;
            if (b0 < -0.5 && b0 + du < -0.5 && b0 + dv < -0.5 && b0 + du + dv < -0.5) continue;
            if (m.ty === LT.beam) {   // outside the fan's wedge (|lateral| > forward, plus the cell's half diagonal)
              const qx = ax + cell * 0.5 - m.x, qz = az + cell * 0.5 - m.z, fw = qx * fx + qz * fz, lat = Math.abs(qx * fz - qz * fx);
              if (lat > fw + cell * 0.75 * 1.42) continue;
            }
          }
          let s = kAt(m, ax + cell * 0.5, 0.3, az + cell * 0.5);
          if (s * Il < E_MIN) { const nx = Math.min(Math.max(m.x, ax), ax + cell), nz = Math.min(Math.max(m.z, az), az + cell); s = kAt(m, nx, 0.3, nz); }
          s *= Il;
          if (s < E_MIN) continue;
          const c = cz * DW + cx, o = c * KD, n = dN[c];
          if (n < KD) { dS[o + n] = s; dI[o + n] = a; dN[c] = n + 1; }
          else { let mi = 0; for (let q = 1; q < KD; q++) if (dS[o + q] < dS[o + mi]) mi = q; if (s > dS[o + mi]) { dS[o + mi] = s; dI[o + mi] = a; } }
        }
      }
      for (let c = 0; c < DW * DW; c++) {   // sort each cell's slots by score (the first 2 get GGX)
        const n = dN[c]; if (!n) continue; const o = c * KD;
        for (let a = 1; a < n; a++) for (let b = a; b > 0 && dS[o + b] > dS[o + b - 1]; b--) { const ts = dS[o + b]; dS[o + b] = dS[o + b - 1]; dS[o + b - 1] = ts; const ti = dI[o + b]; dI[o + b] = dI[o + b - 1]; dI[o + b - 1] = ti; }
        const cx = c % DW, cz = (c / DW) | 0, row = cz * DW * KD4 * 4 + cx * KD4 * 4;
        for (let a = 0; a < n; a++) gd[row + a] = dI[o + a];
      }
      tGD.needsUpdate = true;
      tLD.clearUpdateRanges(); if (nd) tLD.addUpdateRange(0, nd * 2 * 4); tLD.needsUpdate = nd > 0;
      pool.R.value = nd >= Q.Nd ? poolR : 120;   // every lamp within 120 m is a grid light: pools only past it
      cards.instanceMatrix.clearUpdateRanges(); cards.instanceMatrix.addUpdateRange(stat.length * 16, nMov * 16); cards.instanceMatrix.needsUpdate = true;
      aRad.addUpdateRange(stat.length * 3, nMov * 3);
      uStats.dyn = nd;
    }
    if (nAnim || nMov) aRad.needsUpdate = true;
    // contact shadows: the 12 nearest vehicles within 45 m
    if (cars.length) {
      let nc = 0;
      for (let i = 0; i < cars.length; i++) { const h = cars[i].head, t = cars[i].tail; if (!(h.nits > 0) && !(t.nits > 0)) continue; const dx = (h.pos[0] + t.pos[0]) / 2 - cp.x, dz = (h.pos[2] + t.pos[2]) / 2 - cp.z, d2 = dx * dx + dz * dz; if (d2 < 45 * 45) { carD[nc] = d2; carI[nc++] = i; } }
      const nk = Math.min(12, nc), CA = U.uCityCar.value, CS = U.uCityCarS.value;
      for (let a = 0; a < nk; a++) { let bi = a; for (let b = a + 1; b < nc; b++) if (carD[b] < carD[bi]) bi = b; const td = carD[a]; carD[a] = carD[bi]; carD[bi] = td; const ti = carI[a]; carI[a] = carI[bi]; carI[bi] = ti;
        const { head: h, tail: t } = cars[carI[a]], lx = h.pos[0] - t.pos[0], lz = h.pos[2] - t.pos[2], L = Math.hypot(lx, lz) || 1;
        CA[a].set((h.pos[0] + t.pos[0]) / 2, (h.pos[2] + t.pos[2]) / 2, lx / L, lz / L); CS[a].set((h.w || 1.4) / 0.8 / 2, L / 2 + 0.1, 0, 0); }
      for (let a = nk; a < 12; a++) CS[a].x = 0;
      uStats.contact = nk;
    }
    updateAir(camPos || null, cam || null);
    uStats.ms = uStats.ms * 0.9 + (now() - t0) * 0.1;
  }
  update(0);

  // ------------------------------------------------------------------------------------- visibility (P3 perf #2)
  // For G1's crowd and traffic (seoul-life.js owns the culling; this is the API): the render camera's frustum, captured
  // in scene.onBeforeRender (so a query in world.update sees the previous frame's camera: spheres are inflated by
  // `margin`), and heightfield occlusion from the camera, memoised per 4 m cell per frame. Lookup:
  //   const V = scene.userData.seoulLight?.visibility;   // null until attach; every method answers true before a frame
  //   V.sphere(x, y, z, r)    in the (inflated) frustum
  //   V.occluded(x, y, z)     a building stands between the camera and both 0.3 m and 1.8 m above (x, y, z)
  //   V.visible(x, y, z, r)   sphere && !occluded: cull a person or a car when false
  //   V.cam (Vector3), V.frame (count), V.stats {tests, culled, occluded}
  const visI = { margin: ctx.visMargin ?? 1.5, frame: 0, ok: false, cam: new THREE.Vector3(), fr: new THREE.Frustum(), M: new THREE.Matrix4(),
    memoF: new Int32Array(NC).fill(-1), memoV: new Uint8Array(NC), ys: [0, 0], sph: new THREE.Sphere(), stats: { tests: 0, culled: 0, occluded: 0 } };
  const visibility = {
    get cam() { return visI.cam; }, get frame() { return visI.frame; }, get ready() { return visI.ok; }, get stats() { return visI.stats; },
    sphere(x, y, z, r = 0.5) { if (!visI.ok) return true; visI.sph.center.set(x, y, z); visI.sph.radius = r + visI.margin; return visI.fr.intersectsSphere(visI.sph); },
    occluded(x, y, z) {
      if (!visI.ok) return false;
      const cx = Math.floor((x - x0) / cell), cz = Math.floor((z - z0) / cell);
      const c = cx >= 0 && cz >= 0 && cx < gw && cz < gh ? cz * gw + cx : -1;
      if (c >= 0 && visI.memoF[c] === visI.frame) return visI.memoV[c] === 1;
      visI.ys[0] = y + 0.3; visI.ys[1] = y + 1.8;
      const px = c >= 0 ? x0 + (cx + 0.5) * cell : x, pz = c >= 0 ? z0 + (cz + 0.5) * cell : z;   // the cell centre (memo)
      const o = HF.occ(visI.cam.x, visI.cam.y, visI.cam.z, px, pz, visI.ys, 0.5, cell * 0.75) === 3;
      if (c >= 0) { visI.memoF[c] = visI.frame; visI.memoV[c] = o ? 1 : 0; }
      return o;
    },
    visible(x, y, z, r = 0.5) { const st = visI.stats; st.tests++; if (!this.sphere(x, y, z, r)) { st.culled++; return false; } if (this.occluded(x, y, z)) { st.occluded++; return false; } return true; },
  };
  { const prevOBR = scene.onBeforeRender;
    scene.onBeforeRender = function (r, sc, cam, target) {
      prevOBR?.call(this, r, sc, cam, target);
      if (!cam?.isPerspectiveCamera) return;
      visI.M.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); visI.fr.setFromProjectionMatrix(visI.M);
      visI.cam.setFromMatrixPosition(cam.matrixWorld); visI.frame++; visI.ok = true;
      visI.stats.tests = visI.stats.culled = visI.stats.occluded = 0;
    }; }

  // ------------------------------------------------------------------------------------- stats, export, dispose
  const stats = {
    emitters: all.length, static: still.length, animated: nAnim, moving: nMov, dynamicSlots: Q.Nd, grid: [gw, gh, cell], K, Kd: KD,
    binMs: +binMs.toFixed(1), volMs: +volMs.toFixed(1), attachMs: 0, pairs, occludedPairs: occl,
    cells: cellsUsed, mean: +(used / Math.max(1, cellsUsed)).toFixed(2), full, volume: volStat,
    materials: nMat, wetMaterials: nWet, mirror: mirror.on, cull: { meshes: cull.meshes, from: cull.from, batched: cull.batch ? cull.batches.length : 0, vertsBefore: cull.vertsBefore, vertsAfter: cull.vertsAfter, colliderCells: cull.col, ms: cull.ms, cell: cull.cell },
    get lightmap() { return { mode: lm.mode, ready: lm.ready, ms: lm.ms, texels: lm.texels, ...(lm.plan || {}) }; },
    pools: !!pool.mesh, airlight: air.n, airCap: air.cap, airCapped: air.capped, update: uStats, marks,
  };
  function exportData() {   // native #2: the model (exportParams) + this level's grid and baked volume
    return {
      ...exportParams(), HAZE: { ...HAZE, density: U.uCityHaze.value.x }, NITS: NS,
      grid: { x0, z0, cell, gw, gh, K, Kd: KD, Nd: Q.Nd, window: DW, eMin: E_MIN },
      volume: { dims: [gw, gh, NL], heights: YS, A: VA, B: VB },   // Float32Array [cz][cx][layer][4]
    };
  }
  // CPU probe (tests, diagnostics): irradiance in lux at a point for a world normal, split into the per-fragment grid
  // lights (static top-K of the cell, Lambert) and the volume (nearest probe column, layer-interpolated).
  function probe(px, py, pz, nx = 0, ny = 1, nz = 0, detail = false) {
    const cx = Math.floor((px - x0) / cell), cz = Math.floor((pz - z0) / cell); if (cx < 0 || cz < 0 || cx >= gw || cz >= gh) return null;
    const gd = tG.image.data, row = gw * K4 * 4; let Ed = 0, n = 0; const list = detail ? [] : null;
    for (let j = 0; j < K; j++) {
      const id = gd[cz * row + cx * K4 * 4 + j]; if (id === NONE) break; n++;
      const m = metas[id], f = kAt(m, px, py, pz); if (f <= 0) continue;
      const cw = id >= animBase ? 0.5 : 1;
      const El = (LUMA[0] * m.I[0] + LUMA[1] * m.I[1] + LUMA[2] * m.I[2]) * cw * f * Math.max(0, L3[0] * nx + L3[1] * ny + L3[2] * nz);
      Ed += El; if (list) list.push({ id: stat[id].id, kind: stat[id].kind, lux: +(El / NS).toFixed(1) });
    }
    const l = Math.max(0, Math.min(NL - 1, layerOf(py, YS))), k0 = Math.floor(l), k1 = Math.min(NL - 1, k0 + 1), u = l - k0;
    const ev = (k) => { const p = (cz * gw + cx) * NL + k, a = LUMA[0] * VA[p * 4] + LUMA[1] * VA[p * 4 + 1] + LUMA[2] * VA[p * 4 + 2]; return a * Math.max(0, 1 + VB[p * 4] * nx + VB[p * 4 + 1] * ny + VB[p * 4 + 2] * nz); };
    const Ev = ev(k0) * (1 - u) + ev(k1) * u;
    return { direct: Ed / NS, volume: Ev / NS, lights: n, ...(list ? { list } : {}) };
  }
  // P3 perf #4/#6: the cap and presets (world.qualityCap); apply() switches the light's live knobs (static K, mirror
  // resolution, airlight count) without a rebuild
  const Q0 = { ...Q }, qualityCap = { ...SEOUL_QUALITY.auto, presets: SEOUL_QUALITY, gpuMs: 12, current: 'auto',
    apply(name) { const P = SEOUL_QUALITY[name]; if (!P) return false; const L = QUALITY[P.light] || Q0;
      U.uCityDyn.value.w = P.light === 'low' ? Math.max(1, (L.K / 4) | 0) : 0; Q.refl = L.refl ?? Q0.refl; air.n = Math.min(Q0.air, L.air ?? Q0.air);
      qualityCap.current = name; return true; } };
  world.qualityCap = qualityCap;
  const ctl = {
    update, patchMaterial, qualityCap, uniforms: U, sky, steam, mirror, stats, exportData, heightField: HF, probe, visibility,
    setWet(v) { U.uCityWet.value = v; }, setHaze(d) { U.uCityHaze.value.x = d; }, setIrrGain(g) { U.uCityIrrGain.value = g; },
    dispose() {
      for (const t of [tL, tLD, tG, tGD, tLC, tIrrA, tIrrB, blackTex, tLMR, tLME, U.tCityLMG.value, U.tCityLMA.value]) t.dispose();
      lm.disposed = true; lm.worker?.terminate();
      U.tCityMirror.value?.dispose?.();
      mirror.rt?.dispose(); mirror.rt2?.dispose(); sky.geometry.dispose(); sky.material.dispose(); mskyMat.dispose(); cards.dispose(); cardGeo.dispose(); cardMat.dispose(); blurMat.dispose(); occMat.dispose(); quad.geometry.dispose();
      if (steam) { steam.geometry.dispose(); steam.material.dispose(); scene.remove(steam); }
      if (air.mesh) { air.g.dispose(); air.mat.dispose(); scene.remove(air.mesh); }
      if (pool.mesh) pool.mesh.material.dispose();
      scene.remove(sky); mirror.on = false;
      for (const bm of cull.batches) bm.dispose?.(); colBatch?.dispose?.();
    },
  };
  // the world had no dispose(): chain ours in (main.js calls world.dispose on a level switch; the city textures leaked)
  const prevDispose = world.dispose;
  world.dispose = function () { try { prevDispose?.call(this); } finally { ctl.dispose(); } };
  stats.attachMs = +(now() - T00).toFixed(0);
  scene.userData.seoulLight = ctl;
  return ctl;
}

// native #2: the light model as data, without a scene (H: tools/export-seoul-data.mjs -> light.json). The per-level grid
// (bounds, K, the baked volume) comes from a live controller's exportData().
export function exportParams() {
  const OM = omega();
  return {
    version: 2, NITS, SOURCE_TYPES, NIGHT_SKY, HAZE, AIRLIGHT, VOLUME, HEADLIGHT, QUALITY, cell: 4, window: DW, eMin: E_MIN,
    lobes: {
      lambert: { id: 0, f: 'mix(max(ce,0), 0.55 + 0.45 ce, omni); ce = dot(lamp->point, normal)' },
      street: { id: 1, omega: OM.street, f: 'min(1/cos^3, 30) x (1 - smoothstep(0.8 tc, 1.15 tc, tan)); tc = 3.1 along the road, 1.75 forward, 0.7 back', flux: 'lumens' },
      beam: { id: 2, omega: OM.beam, f: 'exp(-(th/0.42)^2) exp(-((tv+0.035)/sv)^2) (1 - smoothstep(-0.02, 0.015, tv)); sv 0.05 up, 0.16 down', flux: 'beam.lumens (1400) x min(1, nits/20000)' },
    },
    geometry: 'point: E = I fe / (d^2 + A/pi); line (long faces, |w-h| > 0.5 m): representative point, E = I fe (atan((a-x)/r) + atan((a+x)/r)) / (2 a r), r^2 = perp^2 + hs^2/pi',
    record: '2 x RGBA32UI: [pos.xyz f32, half(area, signed half length)], [oct snorm16 normal|forward, half(I.r, I.g), half(I.b, range), lobe 2 | colour idx 14 | flicker hz x4 6 | depth x15 4 | omni x63 6]',
    volume: 'probes at cell centres x VOLUME.heights; A = ambient rgb + haze fluence, B = L1 direction / ambient luminance + haze extinction factor (x HAZE.density, by street kind); E(n) = A.rgb max(0, 1 + B.n) x SSAO',
    glsl: CITY_HEAD,
  };
}

export const seoulLight = { attach, NITS, SOURCE_TYPES, NIGHT_SKY, HAZE, VOLUME, HEADLIGHT, AIRLIGHT, emitterRadiance, heightField, splitCells, exportParams };
export default seoulLight;
