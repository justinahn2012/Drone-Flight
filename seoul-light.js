// seoul-light.js: night lighting for Neon Seoul (stream S3; contracts L2 `seoulLight.attach(world, emitters, ctx)` and L3 emitters).
//
// Units. Night worlds are authored in scene-linear units of 10 cd/m2: radiance = nits x NITS. Bando's units are ~10,000 cd/m2
// (sunI 10 -> 100 klx), so the night scale is a fixed 10-stop offset, which is what a real camera spends between ISO 100 at
// 1/1000 s and ISO 6400 at 1/60 s. With it the night AE lands in the same EV range as the day one and nothing in the
// half-float scene target goes subnormal. Sign faces (300-1500 nits) are 30-150 units; lit asphalt is ~0.1-0.5.
//
// What it builds (web, plan-G5 2B-2D):
// - a 2.5D clustered light grid over the block: XZ cells of `cell` m, each holding the K strongest static emitters (score =
//   irradiance bound at the cell), plus Kd dynamic slots rebinned every frame (animated screens, vehicles, flicker that moves);
//   every MeshStandard/Physical material in the world gets them as extra direct lights through RE_Direct (GGX + Lambert),
//   one-sided rectangular emitters with a near-field soft limit (E <= pi L) and a windowed range;
// - wet asphalt: a mirrored emitter-only pass (emitter cards + black occluders from the collider + the night sky) at 1/4 res,
//   streak-blurred along the projected world vertical, sampled by the ground through the mirror camera's projection (exact,
//   viewport-independent), Fresnel-weighted by a puddle mask. Rendered from scene.onBeforeRender, i.e. before the scene pass
//   opens, so a tile GPU never splits the MSAA pass;
// - height haze lit by the grid (in-scatter from the local irradiance) over a city-glow sky colour, and steam puffs;
// - a measured night sky dome (light-pollution 0.02-0.05 cd/m2 at the zenith, orange-brown toward the horizon).
//
// Contract for S1 (world-seoul.js): call attach() after the world's materials exist and before warm-up. Materials opt out with
// material.userData.cityLight === false; ground/road materials opt in to the wet path with material.userData.wet = 0..1 (or
// mesh.userData.ground). Emitters are L3 records; dynamic ones (animated:true, kind 'vehicle' or e.dynamic) are re-read every
// update(), so S2/S4 may mutate pos/normal/rgb/nits in place. update(t) is called from world.update (S1) with the take clock.
import * as THREE from 'three';

export const NITS = 0.1;                      // scene units per cd/m2 (night worlds)
const LUMA = [0.2126, 0.7152, 0.0722];
const lumaOf = (c) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];

// Source types (plan-G5 2A, plan-L5 2F): default luminance (cd/m2), colour (linear, luma 1 after normalising), emission
// (omni: 0 = Lambertian one-sided face, 1 = all round, e.g. bare neon tube), and flicker. Used when an emitter omits a field.
export const SOURCE_TYPES = {
  channel:  { nits: 800,   rgb: [1.0, 1.0, 1.0],   omni: 0.15, range: 26 },   // LED channel letters, 300-1500
  lightbox: { nits: 400,   rgb: [1.0, 0.97, 0.92], omni: 0.0,  range: 24 },   // light boxes, 150-600
  neon:     { nits: 1000,  rgb: [1.0, 0.25, 0.55], omni: 0.7,  range: 18 },   // glass neon / LED flex
  screen:   { nits: 600,   rgb: [0.8, 0.9, 1.0],   omni: 0.0,  range: 32 },   // LED video walls (night-dimmed)
  street:   { nits: 16000, rgb: [1.0, 0.82, 0.62], omni: 0.0,  range: 30 },   // LED street head ~4000 K (sodium: [1, .55, .18])
  store:    { nits: 300,   rgb: [0.9, 0.97, 1.0],  omni: 0.0,  range: 16 },   // shopfront / convenience fluorescent
  tent:     { nits: 120,   rgb: [1.0, 0.55, 0.25], omni: 0.4,  range: 12 },   // pojangmacha tarp lit from inside
  vehicle:  { nits: 20000, rgb: [1.0, 0.95, 0.88], omni: 0.0,  range: 30 },   // head lamps (tail: rgb red, ~2000 nits)
};
// Night sky (plan-L5 2F): zenith and horizon radiance in cd/m2 (Seoul light pollution, low cloud lit orange-brown).
export const NIGHT_SKY = { zenith: [0.018, 0.020, 0.030], horizon: [0.22, 0.13, 0.07], glowH: 0.18 };

// Mean radiance over an emitter's w x h rect (scene units, linear rgb). L3 nits are the rect mean (S2: face x coverage), so
// flux = this x area; S2 draws its own faces at the face luminance.
export function emitterRadiance(e, out = [0, 0, 0], nitScale = NITS) {
  const T = SOURCE_TYPES[e.kind] || SOURCE_TYPES.lightbox;
  const c = e.rgb || T.rgb, l = Math.max(1e-4, lumaOf(c)), L = (e.nits ?? T.nits) * nitScale / l;
  out[0] = c[0] * L; out[1] = c[1] * L; out[2] = c[2] * L;
  return out;
}

const QUALITY = { low: { K: 8, Kd: 4, refl: 0.2, steam: 60 }, auto: { K: 12, Kd: 4, refl: 0.25, steam: 120 }, high: { K: 16, Kd: 8, refl: 0.33, steam: 200 } };
const LPR = 4;              // texels per light record
const LW = 256;             // lights per texture row
const E_MIN = 0.01;         // irradiance (scene units) below which a light is out of range (~1 % of a lit street's level)

// ------------------------------------------------------------------------------------------------------------------ GLSL
const CITY_HEAD = /* glsl */`
uniform highp sampler2D tCityL;   // static light records (LPR texels each)
uniform highp sampler2D tCityG;   // static grid: K/4 RGBA texels per cell, light index or -1
uniform highp sampler2D tCityLD;  // dynamic light records
uniform highp sampler2D tCityGD;  // dynamic grid: KD/4 texels per cell
uniform vec4 uCityGrid;           // x0, z0, 1/cell, cell
uniform vec4 uCityDim;            // gw, gh, K/4, KD/4
uniform float uCityTime;
uniform float uCityGain;
uniform vec4 uCityHaze;           // density (1/m), height scale (m), in-scatter, max
uniform vec3 uCitySkyGlow;        // haze colour with no local light (sky glow at the horizon, scene units)
vec3 cityE = vec3(0.0);           // irradiance from the grid at this fragment (haze in-scatter reads it)
void cityOne(const in highp sampler2D tl, int idx, vec3 wp, vec3 geometryPosition, vec3 geometryNormal, vec3 geometryViewDir, vec3 geometryClearcoatNormal, PhysicalMaterial material, inout ReflectedLight reflectedLight){
  ivec2 b = ivec2((idx % ${LW}) * ${LPR}, idx / ${LW});
  vec4 p = texelFetch(tl, b, 0), n = texelFetch(tl, b + ivec2(1, 0), 0), c = texelFetch(tl, b + ivec2(2, 0), 0), f = texelFetch(tl, b + ivec2(3, 0), 0);
  vec3 Lw = p.xyz - wp; float d2 = max(dot(Lw, Lw), 1e-4); float d = sqrt(d2); vec3 l = Lw / d;
  if (d >= c.w) return;
  float ce = -dot(l, n.xyz);                                                   // emitter facing the point
  float fe = mix(max(ce, 0.0), 0.55 + 0.45 * ce, n.w);
  float q = d / c.w; q = 1.0 - q * q * q * q; float win = q * q;
  float fl = 1.0 - f.y * (0.5 + 0.5 * sin(6.2831853 * f.x * uCityTime + f.z));
  vec3 E = c.rgb * (fe * win * fl * uCityGain / (d2 + p.w * 0.3183));         // near field: E -> pi L at the face
  cityE += E;
  IncidentLight il; il.direction = normalize((viewMatrix * vec4(l, 0.0)).xyz); il.color = E; il.visible = true;
  RE_Direct(il, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
}
vec3 cityWorldPos(vec3 pv){ return transpose(mat3(viewMatrix)) * (pv - viewMatrix[3].xyz); }
void cityLights(vec3 geometryPosition, vec3 geometryNormal, vec3 geometryViewDir, vec3 geometryClearcoatNormal, PhysicalMaterial material, inout ReflectedLight reflectedLight){
  vec3 wp = cityWorldPos(geometryPosition);
  vec2 cg = (wp.xz - uCityGrid.xy) * uCityGrid.z;
  if (cg.x < 0.0 || cg.y < 0.0 || cg.x >= uCityDim.x || cg.y >= uCityDim.y) return;
  ivec2 ci = ivec2(cg);
  int ks = int(uCityDim.z), kd = int(uCityDim.w);
  for (int s = 0; s < 4; s++) { if (s >= ks) break;
    vec4 ids = texelFetch(tCityG, ivec2(ci.x * ks + s, ci.y), 0);
    for (int j = 0; j < 4; j++) { float id = ids[j]; if (id < 0.0) break;
      cityOne(tCityL, int(id + 0.5), wp, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight); }
    if (ids.w < 0.0) break;
  }
  for (int s = 0; s < 2; s++) { if (s >= kd) break;
    vec4 ids = texelFetch(tCityGD, ivec2(ci.x * kd + s, ci.y), 0);
    for (int j = 0; j < 4; j++) { float id = ids[j]; if (id < 0.0) break;
      cityOne(tCityLD, int(id + 0.5), wp, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight); }
    if (ids.w < 0.0) break;
  }
}
// height haze: optical depth of an exponential height fog along the view ray, in-scattering the grid's local light
vec3 cityHaze(vec3 col, vec3 pv){
  vec3 wp = cityWorldPos(pv);
  float dist = length(pv), H = uCityHaze.y;
  float y0 = cameraPosition.y, y1 = wp.y, dy = y1 - y0;
  float od = uCityHaze.x * H * dist * (abs(dy) > 1e-3 ? (exp(-y0 / H) - exp(-y1 / H)) / dy : exp(-y0 / H) / H);
  float a = min(1.0 - exp(-max(od, 0.0)), uCityHaze.w);
  vec3 ins = uCitySkyGlow + min(cityE, vec3(2.0)) * (uCityHaze.z * 0.0796);   // isotropic phase 1/4pi; E at the surface over-reads the ray's mean: capped
  return mix(col, ins, a);
}
`;
const WET_HEAD = /* glsl */`
uniform sampler2D tCityMirror;
uniform mat4 uCityMirrorVP;
uniform float uCityWet;
uniform vec2 uCityMirrorTexel;
float cityWet = 0.0;
float cityHash(vec2 p){ p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float cityNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cityHash(i), cityHash(i + vec2(1, 0)), f.x), mix(cityHash(i + vec2(0, 1)), cityHash(i + vec2(1, 1)), f.x), f.y); }
`;

// ------------------------------------------------------------------------------------------------------------------ build
export function attach(world, emitters = [], ctx = {}) {
  const renderer = ctx.renderer || null;
  const NS = ctx.nitScale ?? NITS;                       // integrator decision: 1 nit = 0.1 scene units (S1 passes ctx.nitScale)
  const rad = (e, o) => emitterRadiance(e, o, NS);
  const scene = world.scene;
  const Q = QUALITY[ctx.quality] || QUALITY.auto;
  const cell = ctx.cell || 4;
  const all = (emitters || []).filter((e) => e && e.pos);
  const isDyn = (e) => !!(e.animated || e.dynamic || e.kind === 'vehicle');
  const stat = all.filter((e) => !isDyn(e)), dyn = all.filter(isDyn).slice(0, 256);

  // grid bounds: layout bounds or emitter bounds, + a range margin
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const grow = (x, z) => { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); };
  for (const l of ctx.layout?.lots || []) for (const [x, z] of l.footprint) grow(x, z);
  for (const s of ctx.layout?.streets || []) for (const [x, z] of s.points) grow(x, z);
  for (const e of all) grow(e.pos[0], e.pos[2]);
  if (!Number.isFinite(x0)) { x0 = -100; z0 = -100; x1 = 100; z1 = 100; }
  x0 -= 16; z0 -= 16; x1 += 16; z1 += 16;
  const gw = Math.min(256, Math.ceil((x1 - x0) / cell)), gh = Math.min(256, Math.ceil((z1 - z0) / cell));
  const K4 = Q.K / 4, KD4 = Q.Kd / 4;

  // light records
  const rec = (e, a, i) => {
    const T = SOURCE_TYPES[e.kind] || SOURCE_TYPES.lightbox;
    const A = Math.max(1e-3, (e.w || 0.5) * (e.h || 0.5));
    const rd = rad(e);
    const n = e.normal || [0, 0, 1], nl = Math.hypot(n[0], n[1], n[2]) || 1;
    const I = Math.max(rd[0], rd[1], rd[2]) * A;
    const range = Math.min(e.range ?? T.range, Math.sqrt(I / E_MIN));
    const k = ((Math.floor(i / LW) * LW * LPR) + (i % LW) * LPR) * 4;
    a.set([e.pos[0], e.pos[1], e.pos[2], A, n[0] / nl, n[1] / nl, n[2] / nl, e.omni ?? T.omni, rd[0] * A, rd[1] * A, rd[2] * A, range,
      e.flicker?.hz || 0, Math.min(1, e.flicker?.depth || 0), (i * 2.399) % 6.283, 0], k);
    return { I, range, A, n: [n[0] / nl, n[1] / nl, n[2] / nl] };
  };
  const lightTex = (n) => {
    const w = LW * LPR, h = Math.max(1, Math.ceil(n / LW));
    const t = new THREE.DataTexture(new Float32Array(w * h * 4), w, h, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  };
  const gridTex = (k4) => {
    const t = new THREE.DataTexture(new Float32Array(gw * k4 * gh * 4).fill(-1), gw * Math.max(1, k4), gh, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  };
  const tL = lightTex(Math.max(1, stat.length)), tLD = lightTex(Math.max(1, dyn.length));
  const tG = gridTex(K4), tGD = gridTex(Math.max(1, KD4));
  const meta = stat.map((e, i) => rec(e, tL.image.data, i));

  // bin: per cell, the K strongest by an irradiance bound (horizontal distance to the cell, emitter facing at the corners)
  function bin(list, metas, tex, k4) {
    const K = k4 * 4, data = tex.image.data; data.fill(-1);
    const best = new Array(gw * gh);
    for (let i = 0; i < list.length; i++) {
      const e = list[i], m = metas[i], r = m.range;
      const cx0 = Math.max(0, Math.floor((e.pos[0] - r - x0) / cell)), cx1 = Math.min(gw - 1, Math.floor((e.pos[0] + r - x0) / cell));
      const cz0 = Math.max(0, Math.floor((e.pos[2] - r - z0) / cell)), cz1 = Math.min(gh - 1, Math.floor((e.pos[2] + r - z0) / cell));
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
        const ax = x0 + cx * cell, az = z0 + cz * cell;
        const dx = Math.max(ax - e.pos[0], 0, e.pos[0] - ax - cell), dz = Math.max(az - e.pos[2], 0, e.pos[2] - az - cell);
        const d2 = dx * dx + dz * dz; if (d2 >= r * r) continue;
        // one-sided: skip cells wholly behind the face (all four corners > 0.5 m behind its plane)
        if (m.n[1] > -0.7 && (e.omni ?? SOURCE_TYPES[e.kind]?.omni ?? 0) < 0.3) {
          let front = false;
          for (const [qx, qz] of [[ax, az], [ax + cell, az], [ax, az + cell], [ax + cell, az + cell]]) if ((qx - e.pos[0]) * m.n[0] + (qz - e.pos[2]) * m.n[2] > -0.5) { front = true; break; }
          if (!front) continue;
        }
        const q = Math.sqrt(d2) / r, w = (1 - q ** 4) ** 2;
        const s = m.I * w / (d2 + 4 + m.A / Math.PI);                         // +4: points are ~2 m off the light's height
        if (s < E_MIN) continue;
        const c = cz * gw + cx;
        const b = best[c] || (best[c] = []);
        if (b.length < K) b.push([s, i]);
        else { let mi = 0; for (let j = 1; j < K; j++) if (b[j][0] < b[mi][0]) mi = j; if (s > b[mi][0]) b[mi] = [s, i]; }
      }
    }
    let used = 0, full = 0;
    for (let c = 0; c < best.length; c++) {
      const b = best[c]; if (!b) continue;
      b.sort((u, v) => v[0] - u[0]); used += b.length; if (b.length === K) full++;
      const cx = c % gw, cz = (c / gw) | 0, rowW = gw * k4 * 4;
      for (let j = 0; j < b.length; j++) data[cz * rowW + cx * k4 * 4 + j] = b[j][1];
    }
    tex.needsUpdate = true;
    return { cells: best.filter(Boolean).length, mean: used / Math.max(1, best.filter(Boolean).length), full };
  }
  // S1's base hemisphere light (a stand-in for the city spill) gives way to the grid: keep ~1.5 lux of sky glow
  const base = scene.userData.seoul?.baseLight;
  if (base?.isLight && ctx.keepBaseLight !== true) base.intensity *= ctx.baseLightScale ?? 0.25;
  const t0 = (globalThis.performance || Date).now();
  const binStats = bin(stat, meta, tG, K4);
  const binMs = (globalThis.performance || Date).now() - t0;

  const U = {
    tCityL: { value: tL }, tCityG: { value: tG }, tCityLD: { value: tLD }, tCityGD: { value: tGD },
    uCityGrid: { value: new THREE.Vector4(x0, z0, 1 / cell, cell) }, uCityDim: { value: new THREE.Vector4(gw, gh, K4, Math.max(1, KD4)) },
    uCityTime: { value: 0 }, uCityGain: { value: ctx.gain ?? 1 },
    uCityHaze: { value: new THREE.Vector4(ctx.haze?.density ?? 0.0025, ctx.haze?.height ?? 18, ctx.haze?.scatter ?? 0.12, ctx.haze?.max ?? 0.5) },
    uCitySkyGlow: { value: new THREE.Vector3(...NIGHT_SKY.horizon.map((v) => v * NS * 0.6)) },
    tCityMirror: { value: null }, uCityMirrorVP: { value: new THREE.Matrix4() }, uCityWet: { value: ctx.wet ?? 0.7 }, uCityMirrorTexel: { value: new THREE.Vector2(1, 1) },
  };

  // ---------------------------------------------------------------------------------------------- material patch
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
        .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>\n  cityLights(geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);`)
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
    mat.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + (wet ? '|cityW' : '|city'); };
    mat.needsUpdate = true;
    return true;
  }
  let nMat = 0, nWet = 0;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const wet = !!(m?.userData?.wet || o.userData.ground || (ctx.wetNames ?? /road|asphalt|ground|street|lane/i).test(o.name || ''));
      if (wet && m) m.userData.wet = m.userData.wet ?? 1;
      if (patchMaterial(m, { wet })) { nMat++; if (wet) nWet++; }
    }
  });

  // ---------------------------------------------------------------------------------------------- sky
  const skyMat = (mirror) => new THREE.ShaderMaterial({
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
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2000, 32, 16), skyMat(false));
  Object.assign(sky, { frustumCulled: false, renderOrder: -1000, name: 'seoul.sky' });
  if (ctx.sky !== false) scene.add(sky);

  // ---------------------------------------------------------------------------------------------- mirror (wet ground)
  const mirror = { scene: new THREE.Scene(), cam: new THREE.PerspectiveCamera(), rt: null, rt2: null, on: nWet > 0 && !!renderer && ctx.reflect !== false, y: ctx.groundY ?? 0 };
  const cardGeo = new THREE.PlaneGeometry(1, 1);
  const cardMat = new THREE.ShaderMaterial({
    uniforms: { uT: U.uCityTime },
    vertexShader: `attribute vec3 aRad; attribute vec3 aFl; varying vec3 vRad; uniform float uT;
      void main(){ vRad = aRad * (1.0 - aFl.y * (0.5 + 0.5 * sin(6.2831853 * aFl.x * uT + aFl.z)));
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: 'varying vec3 vRad; void main(){ gl_FragColor = vec4(vRad, 1.0); }',
    side: THREE.DoubleSide,
  });
  const cards = new THREE.InstancedMesh(cardGeo, cardMat, Math.max(1, all.length));
  const aRad = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, all.length) * 3), 3), aFl = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, all.length) * 3), 3);
  cardGeo.setAttribute('aRad', aRad); cardGeo.setAttribute('aFl', aFl);
  cards.frustumCulled = false; cards.count = all.length;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _z = new THREE.Vector3(0, 0, 1), _n = new THREE.Vector3(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  function setCard(i, e) {
    _n.set(...(e.normal || [0, 0, 1])).normalize(); _q.setFromUnitVectors(_z, _n);
    _p.set(e.pos[0], e.pos[1], e.pos[2]).addScaledVector(_n, 0.05); _s.set(e.w || 0.5, e.h || 0.5, 1);
    cards.setMatrixAt(i, _m.compose(_p, _q, _s));
    const r = rad(e); aRad.setXYZ(i, r[0], r[1], r[2]);
    aFl.setXYZ(i, e.flicker?.hz || 0, Math.min(1, e.flicker?.depth || 0), (i * 2.399) % 6.283);
  }
  all.forEach((e, i) => setCard(i, e));
  cards.instanceMatrix.needsUpdate = true; aRad.needsUpdate = true; aFl.needsUpdate = true;
  // occluders: the collider above the water line only (the ground itself would cover the whole mirror view)
  const clipUp = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -(mirror.y + 0.05))];
  const occMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, clippingPlanes: clipUp });
  const mskyMat = skyMat(true); mskyMat.side = THREE.DoubleSide;
  const msky = new THREE.Mesh(sky.geometry, mskyMat); msky.frustumCulled = false; msky.renderOrder = -1000;
  mirror.scene.add(msky, cards);
  const occ = world.colliderScene || null;
  // streak blur along the projected world vertical (wet asphalt: long vertical, short across), 2 passes
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
  const R = new THREE.Matrix4().set(1, 0, 0, 0, 0, -1, 0, 2 * mirror.y, 0, 0, 1, 0, 0, 0, 0, 1);
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _sz = new THREE.Vector2();
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
    mc.matrixWorld.multiplyMatrices(R, cam.matrixWorld); mc.matrixWorldInverse.copy(mc.matrixWorld).invert();
    mc.matrixAutoUpdate = false; mc.matrixWorldAutoUpdate = false;
    const ac = r.autoClear, cc = r.getClearAlpha(); r.autoClear = true;
    r.setRenderTarget(mirror.rt);
    if (occ) {
      const lc = r.localClippingEnabled; r.localClippingEnabled = true;
      r.clear(true, true, false); occ.overrideMaterial = occMat; r.autoClear = false; r.render(occ, mc); occ.overrideMaterial = null;
      r.localClippingEnabled = lc;
    }
    r.render(mirror.scene, mc);
    // streak direction: the world vertical as the mirror image sees it, at the frame centre
    _v.set(0, 0, -20).applyMatrix4(cam.matrixWorld); _v.y = mirror.y;
    _v2.copy(_v).add(new THREE.Vector3(0, 1, 0)).project(mc); _v.project(mc);
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
      try { renderMirror(r, cam); } catch (e) { mirror.on = false; console.warn('[S3] wet mirror off', e); }
    };
  }
  if (!mirror.on) {
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true; U.tCityMirror.value = black;
  }

  // ---------------------------------------------------------------------------------------------- steam
  let steam = null;
  if (ctx.steam !== false && Q.steam > 0) {
    const vents = [];
    for (const e of all) if (e.kind === 'tent' || e.kind === 'store') vents.push(e);
    for (const l of ctx.layout?.lots || []) if (/pocha|restaurant/.test(l.use) && l.frontage) vents.push({ pos: [(l.frontage[0][0] + l.frontage[1][0]) / 2, 0.4, (l.frontage[0][1] + l.frontage[1][1]) / 2] });
    if (vents.length) {
      const N = Q.steam, pos = new Float32Array(N * 3), seed = new Float32Array(N * 4), lit = new Float32Array(N * 3);
      let s = 12345; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      const _e = [0, 0, 0];
      for (let i = 0; i < N; i++) {
        const v = vents[i % vents.length];
        pos.set([v.pos[0] + (rnd() - 0.5) * 2, Math.max(0.3, Math.min(v.pos[1], 2.5)), v.pos[2] + (rnd() - 0.5) * 2], i * 3);
        seed.set([rnd(), rnd(), rnd(), 0.6 + rnd()], i * 4);
        // lit by the static grid on the CPU at the vent (steam scatters forward: the halo around shopfronts)
        let er = 0, eg = 0, eb = 0;
        for (let j = 0; j < stat.length; j++) {
          const e = stat[j], m = meta[j];
          const dx = e.pos[0] - pos[i * 3], dy = e.pos[1] - pos[i * 3 + 1] - 1.5, dz = e.pos[2] - pos[i * 3 + 2], d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > m.range * m.range) continue;
          rad(e, _e); const k = m.A / (d2 + m.A / Math.PI);
          er += _e[0] * k; eg += _e[1] * k; eb += _e[2] * k;
        }
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
            float sz = (0.5 + 1.8 * ph) * aSeed.w; gl_PointSize = min(uScale * sz / max(-mv.z, 0.3), 256.0);
            vA = sin(ph * 3.14159) * 0.22 * smoothstep(0.5, 2.5, -mv.z); vLit = aLit; }`,
        fragmentShader: `varying vec3 vLit; varying float vA; void main(){ vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q); if (r > 1.0) discard;
            float a = vA * (1.0 - r) * (1.0 - r); gl_FragColor = vec4(vLit, a); }`,
        transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      });
      steam = new THREE.Points(g, m); steam.frustumCulled = false; steam.renderOrder = 10; steam.name = 'seoul.steam';
      scene.add(steam);
    }
  }

  // ---------------------------------------------------------------------------------------------- per frame
  let dynMeta = [];
  function update(t, camPos, cam) {
    U.uCityTime.value = (t ?? 0) % 3600;
    if (steam && renderer) steam.material.uniforms.uScale.value = 0.5 * (renderer.getDrawingBufferSize(_sz).y || 600);
    if (dyn.length) {
      const d = tLD.image.data;
      dynMeta = dyn.map((e, i) => rec(e, d, i));
      tLD.needsUpdate = true;
      bin(dyn, dynMeta, tGD, Math.max(1, KD4));
      for (let i = 0; i < dyn.length; i++) setCard(stat.length + i, dyn[i]);
      cards.instanceMatrix.needsUpdate = true; aRad.needsUpdate = true;
    }
  }
  // order cards static-first so dynamic ones sit at stat.length + i
  if (dyn.length) { stat.forEach((e, i) => setCard(i, e)); dyn.forEach((e, i) => setCard(stat.length + i, e)); }
  update(0);

  const ctl = {
    update, patchMaterial, uniforms: U, sky, steam, mirror,
    setWet(v) { U.uCityWet.value = v; }, setHaze(d) { U.uCityHaze.value.x = d; },
    stats: { emitters: all.length, static: stat.length, dynamic: dyn.length, grid: [gw, gh, cell], K: Q.K, Kd: Q.Kd, binMs: +binMs.toFixed(1), ...binStats, materials: nMat, wetMaterials: nWet, mirror: mirror.on },
    dispose() {
      for (const t of [tL, tLD, tG, tGD]) t.dispose();
      mirror.rt?.dispose(); mirror.rt2?.dispose(); sky.geometry.dispose(); sky.material.dispose(); mskyMat.dispose(); cards.dispose(); cardGeo.dispose(); cardMat.dispose(); blurMat.dispose(); occMat.dispose();
      if (steam) { steam.geometry.dispose(); steam.material.dispose(); scene.remove(steam); }
      scene.remove(sky); mirror.on = false;
    },
  };
  scene.userData.seoulLight = ctl;
  return ctl;
}

export const seoulLight = { attach, NITS, SOURCE_TYPES, NIGHT_SKY, emitterRadiance };
export default seoulLight;
