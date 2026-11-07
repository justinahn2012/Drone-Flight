// fpvcam.js — "real camera" emulation for the mesh (scene-linear HDR) and Gaussian-splat (display sRGB) worlds.
// Everything here models what a GoPro on a drone physically does to light:
//   shutter (motion blur over a fixed exposure time), rolling-shutter readout + prop "jello",
//   a wide barrel lens (+ lateral chromatic aberration, optical vignetting, veiling glare),
//   auto-exposure with lag and a clipped highlight shoulder, halation/bloom,
//   in-camera sharpening, white balance, selective colour, and signal-dependent sensor noise.
// Cost tricks: blur is computed analytically from the drone's own motion + a cheap depth
// pass of the physics collider (no velocity buffer), sample count adapts per pixel to the
// blur length, the scene pass shrinks per axis when the frame is smeared anyway, and post
// targets carry no depth and are cleared up front so tile-based GPUs never load/store them.
import * as THREE from 'three';

const VS = /* glsl */`precision highp float;
in vec3 position;
out vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMMON = /* glsl */`
#define LOGR 12.28771238   // log2(5000): depth encodes 0.02 m .. 100 m
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float decodeDepth(vec4 c){ float d = c.r + c.g / 255.0; return 0.02 * exp2(d * LOGR); }
float decodeEv(vec4 c){ return mix(-5.0, 5.0, c.r + c.g / 255.0); }
vec4 encodeEv(float ev){ float v = clamp((ev + 5.0) / 10.0, 0.0, 1.0); float hi = floor(v * 255.0) / 255.0; return vec4(hi, fract(v * 255.0), 0.0, 1.0); }
vec3 srgb2lin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 lin2srgb(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
// LDR capture -> pseudo-HDR: expand only the top of the range so skies/windows become "light sources"
vec3 invTone(vec3 lin, float h){ float L = dot(lin, LUMA); float Lh = L / max(1.0 - h * L, 0.06); return lin * (Lh / max(L, 1e-4)); }
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

const BLUR_FS = /* glsl */`precision highp float;
${COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uScale;      // viewport / rt size (color)
uniform vec2 uDScale;     // viewport / rt size (depth)
uniform vec2 uDTexel;     // 2 depth texels, in depth-texture uv
uniform vec2 uVp;         // viewport size in px
uniform vec2 uProj;       // P[0][0], P[1][1]
uniform vec3 uVel;        // camera linear velocity, view space (m/s)
uniform vec3 uAng;        // camera angular velocity, view space (rad/s)
uniform float uExp;       // exposure time (s)
uniform float uRO;        // rolling-shutter readout time (s)
uniform vec3 uJelloAmp;   // rad, already averaged over the exposure (sinc) on the CPU
uniform vec3 uJelloW;     // rad/s
uniform vec3 uJelloPh;    // phase at the rendered instant (CPU-integrated, wrapped to 2pi)
uniform vec3 uJello0;     // jello at the rendered instant: uJelloAmp * sin(uJelloPh)
uniform float uFrame;     // wrapped 0..63
uniform float uMaxS;
uniform float uLodMax;    // 0 on frames whose mip chain wasn't rebuilt

// small-angle rotation, 2nd order: < 0.3 px error at 720 deg/s over one exposure
vec3 rotv(vec3 v, vec3 a){ vec3 c = cross(a, v); return v + c + 0.5 * cross(a, c); }
// where does the point seen at this pixel by the camera at time tau appear in the rendered (t=0) frame?
vec2 warp(vec3 P, float tau, vec3 J){
  vec3 p0 = uVel * tau + rotv(P, uAng * tau + J);
  if (p0.z > -0.01) return vec2(-10.0);
  return 0.5 + 0.5 * vec2(uProj.x * p0.x, uProj.y * p0.y) / -p0.z;
}
vec3 tap(vec2 uv, float lod){
  vec2 h = 0.5 * exp2(lod) / uVp;     // keep the mip footprint inside the live viewport
  return textureLod(tColor, clamp(uv, h, 1.0 - h) * uScale, lod).rgb;
}
float depthAt(vec2 uv){ return decodeDepth(texture(tDepth, uv)); }
void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 dir = vec3(ndc.x / uProj.x, ndc.y / uProj.y, -1.0);
  // nearest depth in a small cross: a near silhouette smears out over the background instead of keeping a cut-out edge
  vec2 duv = vUv * uDScale;
  float z = min(depthAt(duv), min(min(depthAt(duv + vec2(uDTexel.x, 0.0)), depthAt(duv - vec2(uDTexel.x, 0.0))),
                                  min(depthAt(duv + vec2(0.0, uDTexel.y)), depthAt(duv - vec2(0.0, uDTexel.y)))));
  vec3 P = dir * z;
  float tauRow = ((1.0 - vUv.y) - 0.5) * uRO;          // top rows are read out first
  vec3 J = uJelloAmp * sin(uJelloPh + uJelloW * tauRow) - uJello0;   // prop jello, once per pixel (row time)
  vec2 a = warp(P, tauRow - 0.5 * uExp, J);
  vec2 b = warp(P, tauRow + 0.5 * uExp, J);
  if (a.x < -5.0 || b.x < -5.0) { fragColor = vec4(tap(vUv, 0.0), 1.0); return; }
  float lenPx = length((b - a) * uVp);
  float n = clamp(ceil(lenPx / 1.6), 1.0, uMaxS);
  float lod = clamp(log2(max(lenPx / n, 1.0) / 1.25), 0.0, uLodMax);   // prefilter: tap footprint ~ sample spacing
  float j = ign(gl_FragCoord.xy + uFrame * 5.588238);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    if (float(i) >= n) break;
    float f = (n > 1.0) ? (float(i) + j) / n - 0.5 : 0.0;   // box shutter, jittered
    vec2 s = warp(P, tauRow + f * uExp, J);
    acc += tap(s.x < -5.0 ? vUv : s, lod);
  }
  fragColor = vec4(acc / n, 1.0);
}`;

const DOWN_FS = /* glsl */`precision highp float;
${COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tSrc;
uniform sampler2D tExp;
uniform vec2 uScale;
uniform vec2 uTexel;     // one destination texel, in source-viewport uv
uniform vec2 uClampLo;   // half a source pixel, in source-viewport uv
uniform float uInv;
uniform float uThresh;
uniform float uHdr;
uniform float uLumScale;
uniform float uF16;      // 1: half-float target, store raw radiance (no sqrt/8-bit encodings)
void main(){
  // 4x4 bilinear taps a quarter texel apart: each averages a 2x2 quad, together the whole block (exact for 8x8)
  vec3 c = vec3(0.0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    vec2 uv = vUv + (vec2(float(x), float(y)) - 1.5) * 0.25 * uTexel;
    c += texture(tSrc, clamp(uv, uClampLo, 1.0 - uClampLo) * uScale).rgb;
  }
  c *= 0.0625;
  vec3 lin = uHdr > 0.5 ? max(c, 0.0) : srgb2lin(c);
  float L = dot(lin, LUMA);
  float ev = decodeEv(texelFetch(tExp, ivec2(0), 0));
  vec3 e = (uHdr > 0.5 ? lin : invTone(lin, uInv)) * exp2(ev);
  vec3 bright = max(e - vec3(uThresh), 0.0);
  fragColor = uF16 > 0.5 ? vec4(min(bright, vec3(64.0)), min(L, 6.0e4))
                         : vec4(min(bright / 8.0, 1.0), sqrt(clamp(L / uLumScale, 0.0, 1.0)));
}`;

const METER_FS = /* glsl */`precision highp float;
${COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tSmall;
uniform sampler2D tPrev;
uniform float uDt;
uniform float uBias;
uniform float uInv;
uniform float uUp;
uniform float uDown;
uniform float uReset;
uniform float uLock;
uniform float uLockEv;
uniform float uEvMin;
uniform float uEvMax;
uniform float uHdr;
uniform float uLumScale;
uniform float uF16;
void main(){
  float prevEv = decodeEv(texelFetch(tPrev, ivec2(0), 0));
  float lsum = 0.0, asum = 0.0, wsum = 0.0;
  for (int y = 0; y < 7; y++) for (int x = 0; x < 9; x++) {
    vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(9.0, 7.0);
    float a = texture(tSmall, uv).a;
    float L = uF16 > 0.5 ? a : a * a * uLumScale;
    // the meter reads the sensor, which saturates: a blown sky can't drag exposure down on its own
    float Lh = uHdr > 0.5 ? min(L, 1.4 * exp2(-prevEv)) : min(invTone(vec3(L), uInv).r, 1.1);
    vec2 d = (uv - vec2(0.5, 0.45)) * vec2(1.6, 2.0);
    float w = exp(-dot(d, d) * 1.6);            // centre-weighted metering
    lsum += w * log2(Lh + 1e-3); asum += w * Lh; wsum += w;
  }
  float avg = exp2(mix(lsum / wsum, log2(asum / wsum + 1e-3), 0.15));
  float target = clamp(log2(0.24 / avg) + uBias, uEvMin, uEvMax);
  if (uLock > 0.5) target = uLockEv;
  float rate = target > prevEv ? uUp : uDown;
  float ev = uReset > 0.5 ? target : prevEv + (target - prevEv) * (1.0 - exp(-uDt * rate));
  vec4 o = encodeEv(ev);
  o.b = clamp(0.5 * asum / wsum * exp2(ev), 0.0, 1.0);   // metered mean of the exposed frame (lens veil reads it)
  fragColor = o;
}`;

const BLOOM_FS = /* glsl */`precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tSrc;
uniform vec2 uDir;
void main(){
  vec4 c = texture(tSrc, vUv) * 0.2270270270;
  c += texture(tSrc, vUv + uDir * 1.3846153846) * 0.3162162162;
  c += texture(tSrc, vUv - uDir * 1.3846153846) * 0.3162162162;
  c += texture(tSrc, vUv + uDir * 3.2307692308) * 0.0702702703;
  c += texture(tSrc, vUv - uDir * 3.2307692308) * 0.0702702703;
  fragColor = vec4(c.rgb, 1.0);
}`;

const FINAL_FS = /* glsl */`precision highp float;
${COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tSrc;
uniform sampler2D tBloom;
uniform sampler2D tExp;
uniform vec2 uScale;
uniform vec2 uSrcPx;      // viewport px of source
uniform vec2 uHalf;       // sensor crop half extents
uniform float uF;         // lens focal (sensor units)
uniform float uK;         // lens family: 1 = rectilinear, 0.5 = stereographic, ->0 equidistant
uniform vec2 uSrcTan;     // tan half-extents of the rectilinear render
uniform float uRc;        // corner radius (sensor units)
uniform float uCA;
uniform float uVig;
uniform float uSharp;
uniform float uGrain;
uniform vec2 uGrainEv;    // analog gain for noise: exp2(max(ev + x, 0) * y)
uniform float uSat;
uniform float uShSat;     // saturation multiplier in deep shadows (1 = off)
uniform float uInv;
uniform float uBloom;     // includes the bloom target's encoding scale
uniform float uExpo;      // exposure scale before the tone curve
uniform float uWhite;     // sensor clip: rescales camCurve so it reaches 1.0 at +clipEv over the AE target (1 = never)
uniform float uToe;       // 0 = off
uniform float uVeil;      // veiling glare, x (metered mean / 2)
uniform vec2 uSel;        // selective colour amounts: x = sky, y = foliage greens (0 = off)
uniform float uSkyBoost;  // sky chroma gain
uniform float uFrame;     // wrapped
uniform float uLetter;    // letterbox fraction (0 = none)
uniform vec3 uWB;
uniform vec3 uWBShade;    // white balance once exposure is pushed (shade/interiors); = uWB for splat worlds
uniform float uLift;
uniform float uHdr;

vec3 tex(vec2 s){ vec2 h = 0.5 / uSrcPx; return texture(tSrc, clamp(s, h, 1.0 - h) * uScale).rgb; }
// sensor-like response: ~linear toe, exponential shoulder that clips skies/windows
vec3 camCurve(vec3 x){ return 1.0 - exp(-max(x, 0.0) * 1.25); }
float hash(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }

void main(){
  if (uLetter > 0.0 && abs(vUv.y - 0.5) > 0.5 - uLetter) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // lens: one atan + one tan per pixel; lateral CA only rescales the radius per channel
  vec2 lq = (vUv - 0.5) * 2.0 * uHalf;
  float r = length(lq);
  float th = (uK > 0.999) ? atan(r / uF) : atan(r * uK / uF) / uK;
  float rn = r / uRc;
  vec2 d = (r > 1e-5 ? lq * (tan(th) / r) : lq / uF) * (0.5 / uSrcTan);
  float car = uCA * rn * rn;
  vec2 sG = 0.5 + d, sR = 0.5 + d * (1.0 + car), sB = 0.5 + d * (1.0 - car);
  vec3 c = vec3(tex(sR).r, tex(sG).g, tex(sB).b);
  // in-camera sharpening (luma unsharp mask, the "GoPro crunch")
  vec2 px = 1.0 / uSrcPx;
  float Ln = dot(tex(sG + vec2(px.x, 0.0)) + tex(sG - vec2(px.x, 0.0)) + tex(sG + vec2(0.0, px.y)) + tex(sG - vec2(0.0, px.y)), LUMA) * 0.25;
  float Lc = dot(c, LUMA);
  c = uHdr > 0.5 ? max(c + (Lc - Ln) * uSharp * 0.8, 0.0) : clamp(c + (Lc - Ln) * uSharp, 0.0, 1.0);

  vec3 lin = uHdr > 0.5 ? c : srgb2lin(c);
  vec4 X = texelFetch(tExp, ivec2(0), 0);
  float ev = decodeEv(X);
  vec3 e = (uHdr > 0.5 ? lin : invTone(lin, uInv)) * exp2(ev) * mix(uWB, uWBShade, smoothstep(0.6, 2.4, ev));
  e += texture(tBloom, clamp(sG, 0.0, 1.0)).rgb * uBloom;                 // halation / glare
  float vig = pow(max(cos(th), 0.0), 2.2);                                 // optical cos^n falloff
  e *= mix(1.0, vig, uVig);
  e += uVeil * X.b * vec3(1.0, 0.99, 0.97);                                // veiling glare from the metered mean
  vec3 t = min(camCurve(e * uExpo) * uWhite, 1.0);                         // per channel: skies clip blue-first
  if (uToe > 0.0) t = t * t / (t + uToe) * (1.0 + uToe);                   // sensor toe (real blacks)
  float l = dot(t, LUMA);
  t = max(mix(vec3(l), t, uSat * mix(uShSat, 1.0, smoothstep(0.01, 0.16, l))), 0.0);
  vec3 o = lin2srgb(t);
  if (uSel.x + uSel.y > 0.0) {
    // selective colour in display space, opponent (cb, cr) about luma: deepen/rotate blue sky, yellow the greens
    float Y = dot(o, LUMA);
    vec2 cq = vec2(o.b - Y, o.r - Y);
    float C = length(cq) + 1e-5;
    vec2 u = cq / C;
    float wS = uSel.x * smoothstep(0.80, 0.97, dot(u, vec2(0.788, -0.616))) * smoothstep(0.35, 0.55, Y) * smoothstep(0.09, 0.15, C / (Y + 1e-3));
    float wG = uSel.y * smoothstep(0.70, 0.95, dot(u, vec2(-0.819, -0.574))) * smoothstep(0.02, 0.05, C);
    float ang = -0.227 * wS - 0.209 * wG, gn = 1.0 + uSkyBoost * wS - 0.15 * wG;
    float ca = cos(ang), sa = sin(ang);
    cq = gn * vec2(ca * cq.x - sa * cq.y, sa * cq.x + ca * cq.y);
    Y *= 1.0 - 0.10 * wS;
    o = clamp(vec3(Y + cq.y, Y - (0.2126 * cq.y + 0.0722 * cq.x) / 0.7152, Y + cq.x), 0.0, 1.0);
  }
  o = mix(o, o * o * (3.0 - 2.0 * o), 0.22);          // mild display S-curve
  o = o * (1.0 - uLift) + uLift;
  // signal-dependent sensor noise: shot noise ~ sqrt(signal), scaled by analog gain (positive EV)
  float gain = exp2(max(ev + uGrainEv.x, 0.0) * uGrainEv.y);
  float n = hash(vec3(gl_FragCoord.xy, mod(uFrame, 997.0))) - 0.5;
  float nc = hash(vec3(gl_FragCoord.yx + 17.0, mod(uFrame, 991.0))) - 0.5;
  float sigma = uGrain * gain * sqrt(l + 0.025);
  o += n * sigma + vec3(nc, -nc, nc * 0.5) * sigma * 0.35;
  o += (ign(gl_FragCoord.xy + uFrame) - 0.5) / 255.0;
  fragColor = vec4(clamp(o, 0.0, 1.0), 1.0);
}`;

const TRI = new THREE.BufferGeometry();
TRI.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));

function pass(fs, uniforms) {
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: fs, uniforms,
    depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(TRI, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { mat, scene, u: uniforms };
}

function rt(w, h, { filter = THREE.LinearFilter, mips = false, type = THREE.UnsignedByteType, depth = false, samples = 0 } = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    minFilter: mips ? THREE.LinearMipmapLinearFilter : filter, magFilter: filter, type, format: THREE.RGBAFormat,
    depthBuffer: depth, stencilBuffer: false, generateMipmaps: mips, samples,
  });
}

// Camera response per world type. setHDR() applies one of these as defaults; main.js may override any key after it.
// clipEv: highlights hard-clip this many EV over the auto-exposure target (null = old soft shoulder, never clips).
const GRADES = {
  // display-referred splat captures: the original look, unchanged
  ldr: { wb: [1.06, 1.0, 0.88], wbShade: null, lift: 0.07, clipEv: null, toe: 0, veil: 0, shadowSat: 1, skySel: 0, greenSel: 0, skyBoost: 0, grainEv: [0, 0.9] },
  // scene-linear mesh worlds: colorist's FINAL block (panel/color.md) with the PLAN's sky gain 0.6 and half shade-WB shift
  hdr: { wb: [1.063, 0.993, 0.883], wbShade: [1.145, 0.977, 0.80], lift: 0, clipEv: 3.0, toe: 0.012, veil: 0.07, shadowSat: 0.6, skySel: 1, greenSel: 1, skyBoost: 0.6, grainEv: [1, 0.55] },
};
const TAU = Math.PI * 2;
const JELLO_RATIO = [1, 1.077, 0.93], JELLO_AXIS = [1, 0.8, 0.5];
const sinc = (x) => (Math.abs(x) < 1e-4 ? 1 : Math.sin(x) / x);
// per-axis blur-aware render scale: a box smear of L px kills detail above ~1/L cycles/px along it
const axisScale = (L) => (L > 3 ? Math.max(0.6, Math.sqrt(3 / L)) : 1.0);

export const LENSES = {
  // thetaS = half-angle across the viewport's SHORT side; k: 1 rectilinear, 0.5 stereographic, ->0 equidistant
  ref:    { label: 'Fisheye (ref)', thetaS: 50 * Math.PI / 180, k: 0.28, ca: 0.006 },
  wide:   { label: 'GoPro Wide',    thetaS: 40 * Math.PI / 180, k: 0.48, ca: 0.005 },
  linear: { label: 'Linear',        thetaS: 33 * Math.PI / 180, k: 1.00, ca: 0.004 },
};
export const SHUTTERS = {
  // reference clip: 30p with ~180 deg shutter -> 1/60 s (blur ~= half the per-frame travel)
  nd16: { label: 'ND · 1/60 (ref)', t: 1 / 60 },
  nd8:  { label: 'ND · 1/120',      t: 1 / 120 },
  none: { label: 'No ND · 1/1600',  t: 1 / 1600 },
};

export class FPVCamera {
  constructor(renderer) {
    this.r = renderer;
    this.cam = new THREE.PerspectiveCamera(90, 16 / 9, 0.04, 300);
    this.frame = 0;
    this.time = 0;
    this.look = {
      // calibrated against 389 frames of the reference clip (see design doc)
      shutter: 1 / 60, readout: 0.0085, jelloAmp: 0.0007, jelloFreq: 170,
      lens: LENSES.ref, vignette: 0.35, sharpen: 0.2, grain: 0.015, saturation: 0.95,
      invTone: 0.84, bloom: 0.45, expo: 0.85, evBias: 0.0, letterbox: 0,
      evMin: -1.2, evMax: 1.8, aeUp: 3.3, aeDown: 7.5,
      maxSamples: 14,
      msaa: 4,                 // scene MSAA for mesh worlds (0 = off); used only where RGBA16F multisampling is supported
    };
    this._applyGrade(GRADES.ldr);
    // dynamic resolution
    this.scale = 0.9; this.minScale = 0.55; this.maxScale = 1.0;
    this.blurScale = 1.0; this.blurSX = 1.0; this.blurSY = 1.0;
    this.ftEma = 16.7; this.slowT = 0; this.fastT = 0; this.capT = 0; this.ceilLock = 0;
    this.targetMs = 16.7;      // the user's target (main.js); autoMs raises it when the display is capped at 30 Hz
    this.autoMs = 0; this.pinT = 0; this.pinScale = 0; this.fastRT = 0;
    this.settleN = 60;
    this.resetExposure = true;
    this.samples = 0;          // MSAA samples actually in use on the scene target (B can key alphaToCoverage off it)

    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: `varying float vZ; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vZ; void main(){ float d = clamp(log2(max(vZ, 0.02) / 0.02) / 12.28771238, 0.0, 1.0); float hi = floor(d * 255.0) / 255.0; gl_FragColor = vec4(hi, fract(d * 255.0), 0.0, 1.0); }`,
      side: THREE.DoubleSide,
    });

    this.blur = pass(BLUR_FS, {
      tColor: { value: null }, tDepth: { value: null }, uScale: { value: new THREE.Vector2(1, 1) },
      uDScale: { value: new THREE.Vector2(1, 1) }, uDTexel: { value: new THREE.Vector2() }, uVp: { value: new THREE.Vector2(1, 1) },
      uProj: { value: new THREE.Vector2(1, 1) }, uVel: { value: new THREE.Vector3() }, uAng: { value: new THREE.Vector3() },
      uExp: { value: 1 / 120 }, uRO: { value: 0.008 }, uJelloAmp: { value: new THREE.Vector3() },
      uJelloW: { value: new THREE.Vector3() }, uJelloPh: { value: new THREE.Vector3() }, uJello0: { value: new THREE.Vector3() },
      uFrame: { value: 0 }, uMaxS: { value: 12 }, uLodMax: { value: 4 },
    });
    this.down = pass(DOWN_FS, {
      tSrc: { value: null }, tExp: { value: null }, uScale: { value: new THREE.Vector2(1, 1) },
      uTexel: { value: new THREE.Vector2() }, uClampLo: { value: new THREE.Vector2() }, uInv: { value: 0.82 }, uThresh: { value: 1.0 },
      uHdr: { value: 0 }, uLumScale: { value: 1 }, uF16: { value: 0 },
    });
    this.meter = pass(METER_FS, {
      tSmall: { value: null }, tPrev: { value: null }, uDt: { value: 0.016 }, uBias: { value: 0 }, uInv: { value: 0.82 },
      uUp: { value: 3.3 }, uDown: { value: 7.5 }, uReset: { value: 1 }, uLock: { value: 0 }, uLockEv: { value: 0 },
      uEvMin: { value: -1.2 }, uEvMax: { value: 1.3 }, uHdr: { value: 0 }, uLumScale: { value: 1 }, uF16: { value: 0 },
    });
    this.bloomH = pass(BLOOM_FS, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.bloomV = pass(BLOOM_FS, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.final = pass(FINAL_FS, {
      tSrc: { value: null }, tBloom: { value: null }, tExp: { value: null }, uScale: { value: new THREE.Vector2(1, 1) },
      uSrcPx: { value: new THREE.Vector2(1, 1) }, uHalf: { value: new THREE.Vector2(1, 1) }, uF: { value: 1 }, uK: { value: 0.5 },
      uSrcTan: { value: new THREE.Vector2(1, 1) }, uRc: { value: 1 }, uCA: { value: 0.01 }, uVig: { value: 0.5 }, uSharp: { value: 0.5 },
      uGrain: { value: 0.04 }, uGrainEv: { value: new THREE.Vector2(0, 0.9) }, uSat: { value: 1.2 }, uShSat: { value: 1 },
      uInv: { value: 0.82 }, uBloom: { value: 0.5 }, uExpo: { value: 1 }, uWhite: { value: 1 }, uToe: { value: 0 }, uVeil: { value: 0 },
      uSel: { value: new THREE.Vector2() }, uSkyBoost: { value: 0 }, uFrame: { value: 0 }, uLetter: { value: 0 },
      uWB: { value: new THREE.Vector3(1, 1, 1) }, uWBShade: { value: new THREE.Vector3(1, 1, 1) }, uLift: { value: 0 }, uHdr: { value: 0 },
    });
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.exp = [rt(1, 1, { filter: THREE.NearestFilter }), rt(1, 1, { filter: THREE.NearestFilter })];
    this.expIdx = 0;
    this.outW = 1; this.outH = 1;
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._jph = [0, 0, 0]; this._jJ = [0, 0, 0]; this._jW = [0, 0, 0]; this._jA = [0, 0, 0];
    this._inv = [];
    this._msaaReq = -1;
  }

  _applyGrade(g) { for (const k in g) this.look[k] = Array.isArray(g[k]) ? g[k].slice() : g[k]; }

  // HDR worlds (lit meshes) hand us scene-linear radiance in half-float; splat worlds hand us display sRGB.
  // Switching applies that world type's camera-response defaults (GRADES); callers override keys afterwards.
  readEv(renderer) { const b = new Uint8Array(4); renderer.readRenderTargetPixels(this.exp[this.expIdx], 0, 0, 1, 1, b); return -5 + 10 * (b[0] / 255 + b[1] / 255 / 255); }
  setHDR(on) {
    on = !!on;
    if (this.hdr === on) return;
    this.hdr = on; this.resetExposure = true;
    this._applyGrade(on ? GRADES.hdr : GRADES.ldr);
    if (this.outW > 2) this.resize(this.outW, this.outH);
  }

  setQualityRange(min, max) {
    this.minScale = min; this.maxScale = max; this.scale = Math.min(Math.max(this.scale, min), max);
    if (this.outW > 2) this._allocScene();
  }

  // MSAA sample count the scene target can use for this format (0 when RGBA16F multisampling isn't supported)
  _msaaFor(type) {
    const want = this.look.msaa | 0;
    if (want < 2 || !this.hdr) return 0;      // splats are soft blended gaussians: no geometric edges to resolve
    try {
      const gl = this.r.getContext();
      if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return 0;
      const half = type === THREE.HalfFloatType;
      const ext = this.r.extensions;
      if (half && !(ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'))) return 0;
      const list = gl.getInternalformatParameter(gl.RENDERBUFFER, half ? gl.RGBA16F : gl.RGBA8, gl.SAMPLES);
      let best = 0;
      if (list) for (const s of list) if (s <= want && s > best) best = s;
      return Math.min(best, this.r.capabilities.maxSamples || 0);
    } catch (e) { return 0; }
  }

  // scene / blur / collider-depth targets: sized to the largest viewport the governor may use (out x maxScale)
  _allocScene() {
    const cap = Math.max(0.3, this.maxScale);
    const cw = Math.ceil(this.outW * cap), ch = Math.ceil(this.outH * cap);
    const type = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this._msaaReq = this.look.msaa | 0;
    const samples = this._msaaFor(type);
    const c = this.colorRT;
    if (c && c.width === cw && c.height === ch && c.texture.type === type && c.samples === samples) return;
    this.colorRT?.dispose(); this.blurRT?.dispose(); this.depthRT?.dispose();
    this.colorRT = rt(cw, ch, { mips: true, type, depth: true, samples });
    this.colorRT.resolveDepthBuffer = false;    // the resolve only needs colour
    this.blurRT = rt(cw, ch, { type });
    this.depthRT = rt(Math.ceil(cw / 2), Math.ceil(ch / 2), { filter: THREE.NearestFilter, depth: true });
    this.samples = samples;
    this._colorFresh = true;                    // first frame allocates the full mip chain
    this.settleN = Math.max(this.settleN, 60);
  }

  resize(w, h) {
    this.outW = Math.max(2, Math.round(w)); this.outH = Math.max(2, Math.round(h));
    this._allocScene();
    // metering + bloom at 1/8: half-float in HDR (8-bit stepped ~0.65 EV at interior levels and banded the halos)
    const sw = Math.max(16, Math.round(this.outW / 8)), sh = Math.max(9, Math.round(this.outH / 8));
    const st = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.smallRT?.dispose(); this.bloomA?.dispose(); this.bloomB?.dispose();
    this.smallRT = rt(sw, sh, { type: st }); this.bloomA = rt(sw, sh, { type: st }); this.bloomB = rt(sw, sh, { type: st });
    this.f16 = !!this.hdr;
    this.computeLens();
    this.settleN = Math.max(this.settleN, 60);
  }

  // Fit a crop of a 16:9 sensor into the viewport, then solve the rectilinear render
  // frustum that exactly covers the barrel-distorted output corners (+ margin for blur/RS warps).
  computeLens() {
    const Ls = this.look.lens; const A = this.outW / this.outH;
    const hw = A >= 1 ? A : 1, hh = A >= 1 ? 1 : 1 / A;     // short half-side = 1
    const k = Ls.k, rc = Math.hypot(hw, hh), thMax = 1.16;    // ~66 deg corner cap
    const rect = k > 0.999;
    const Fs = rect ? 1 / Math.tan(Ls.thetaS) : k / Math.tan(k * Ls.thetaS);
    const Fc = rect ? rc / Math.tan(thMax) : rc * k / Math.tan(k * thMax);
    const F = Math.max(Fs, Fc);
    const thc = rect ? Math.atan(rc / F) : Math.atan(rc * k / F) / k;
    const Tc = Math.tan(thc) * 1.035;
    const tx = Tc * hw / rc, ty = Tc * hh / rc;
    this.lens = { hw, hh, F, k, tx, ty, thc };
    this.cam.fov = 2 * Math.atan(ty) * 180 / Math.PI;
    this.cam.aspect = tx / ty;
    this.cam.updateProjectionMatrix();
    this.centerRatio = (1 / ty) / (F / hh);
  }

  frameTiming(ms) {
    // GPU-load governor: back off fast, creep up slowly, never chase a ceiling we just fell from
    if (!(ms > 0)) return;
    if (this.settleN > 0) { this.settleN--; return; }        // load / respawn / resize: shader compiles and uploads aren't load
    const tgt = Math.max(this.targetMs, this.autoMs);
    const m = Math.min(ms, tgt * 2.5);                         // one-off hitches (GC, tab switch) aren't a GPU-load signal
    this.ftEma += (m - this.ftEma) * 0.08;
    const band30 = this.ftEma > 30 && this.ftEma < 37;
    if (tgt < 30) {
      // iOS Low Power Mode caps rAF at 30 Hz: still pinned at ~33 ms at minScale means the display, not the GPU, is the limit
      if (!band30) this.pinScale = 0;
      this.pinT = band30 && Math.abs(ms - 33.3) < 4 && this.scale <= this.minScale * 1.001 ? this.pinT + ms : 0;
      if (this.pinT > 1500) {
        this.autoMs = 33.3; this.pinT = 0; this.capT = 0; this.slowT = 0; this.fastT = 0; this.ftEma = 33.3;
        this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.pinScale || this.scale));
        return;
      }
    } else if (this.autoMs > 0) {
      // the 30 Hz cap lifted (frames at ~60 Hz again): back to the user's target
      this.fastRT = this.ftEma < 21 ? this.fastRT + ms : 0;
      if (this.fastRT > 3000) { this.autoMs = 0; this.fastRT = 0; this.ftEma = this.targetMs; return; }
    }
    const over = this.ftEma > tgt * 1.14, under = this.ftEma < tgt * 1.04;
    if (over) { if (m > tgt * 1.14) this.slowT += m; this.fastT = 0; }   // only frames that are themselves slow count
    else if (under) { this.slowT = 0; if (this.blurScale > 0.97) this.fastT += m; }   // a blur-shrunk frame proves nothing
    if (this.slowT > 450) {
      if (band30 && !this.pinScale) this.pinScale = this.scale;
      this.ceilLock = this.scale; this.scale = Math.max(this.minScale, this.scale * 0.9); this.slowT = 0; this.capT = 60000;
    }
    this.capT = Math.max(0, this.capT - ms);
    if (this.fastT > 2500) {
      const ceil = this.capT > 0 ? this.ceilLock * 0.97 : this.maxScale;
      this.scale = Math.min(this.maxScale, Math.max(this.scale, Math.min(ceil, this.scale * 1.02))); this.fastT = 0;
    }
  }

  // Tell a tile-based GPU these attachments are dead so it never writes them back to memory.
  _discard(target, color) {
    const r = this.r, gl = r.getContext();
    if (!gl.invalidateFramebuffer) return;
    r.setRenderTarget(target);
    const a = this._inv; a.length = 0;
    // only the explicit-MSAA path has a separate (already resolved) sample buffer; never invalidate a texture attachment
    if (color && r.properties.get(target).__webglMultisampledFramebuffer) a.push(gl.COLOR_ATTACHMENT0);
    a.push(gl.DEPTH_ATTACHMENT);
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, a);
  }

  // world: { scene|splatScene, colliderScene|null }
  // pose: { pos, quat } of the camera actually displayed
  // motion: { vel (world m/s), ang (world rad/s), vib, hz } of the physical camera during exposure
  render(world, pose, motion, dt) {
    const r = this.r, lk = this.look;
    this.frame++; this.time += dt;
    if ((lk.msaa | 0) !== this._msaaReq) this._allocScene();
    if (this.resetExposure) this.settleN = Math.max(this.settleN, 60);
    const cam = this.cam;
    cam.position.copy(pose.pos); cam.quaternion.copy(pose.quat); cam.updateMatrixWorld(true);

    // motion in view space
    this._q.copy(pose.quat).invert();
    const vView = this._v.copy(motion.vel).applyQuaternion(this._q);
    const aView = this._a.copy(motion.ang).applyQuaternion(this._q);

    // Blur-aware resolution, per axis: yaw smears horizontally, pitch vertically (roll is tangential: ignored).
    // A box blur of length L kills detail above ~1/L cycles/px along it, so rendering finer than that is wasted.
    const L = this.lens;
    const fpx = (this.outH * this.scale / 2) / L.ty;
    const kpx = lk.shutter * fpx;
    const tsx = axisScale(Math.abs(aView.y) * kpx), tsy = axisScale(Math.abs(aView.x) * kpx);
    this.blurSX += (tsx - this.blurSX) * (tsx < this.blurSX ? 0.35 : 0.08);
    this.blurSY += (tsy - this.blurSY) * (tsy < this.blurSY ? 0.35 : 0.08);
    this.blurScale = Math.min(this.blurSX, this.blurSY);
    const sx = this.scale * this.blurSX, sy = this.scale * this.blurSY;
    const vw = Math.min(this.colorRT.width, Math.max(32, Math.round(this.outW * sx)));
    const vh = Math.min(this.colorRT.height, Math.max(18, Math.round(this.outH * sy)));
    this.vw = vw; this.vh = vh;

    // Mips are only needed once blur taps get capped (spacing > 1.6 px). Bound this frame's longest smear on the CPU
    // (pitch+yaw and roll at the frame corner, translation at 0.15 m) and skip the chain on calm frames.
    const rc = Math.hypot(L.tx, L.ty);
    const fpxMax = Math.max((vw / 2) / L.tx, (vh / 2) / L.ty);
    const smear = lk.shutter * fpxMax * ((Math.abs(aView.x) + Math.abs(aView.y)) * (1 + rc * rc) + Math.abs(aView.z) * rc + vView.length() * (1 + rc) / 0.15);
    const needMips = this._colorFresh || smear > 1.25 * lk.maxSamples;
    this._colorFresh = false;
    this.colorRT.texture.generateMipmaps = needMips;

    // 1) scene (MSAA where supported; three resolves + builds mips at the end of render())
    this.colorRT.viewport.set(0, 0, vw, vh);
    r.setRenderTarget(this.colorRT);
    r.setClearColor(0x000000, 1); r.clear(true, true, false);
    r.render(world.scene || world.splatScene, cam);
    this._discard(this.colorRT, true);

    // 2) depth from the physics collider (cheap: ~100k tris, half res, flat shader)
    const dw = Math.max(16, Math.round(vw / 2)), dh = Math.max(9, Math.round(vh / 2));
    this.depthRT.viewport.set(0, 0, dw, dh);
    r.setRenderTarget(this.depthRT);
    r.setClearColor(0xffff00, 1); r.clear(true, true, false);
    if (world.colliderScene) {
      world.colliderScene.overrideMaterial = this.depthMat;
      r.render(world.colliderScene, cam);
    }
    this._discard(this.depthRT, false);
    r.setClearColor(0x000000, 1);              // post passes: full clears so nothing is loaded from memory

    // 3) shutter + rolling shutter + jello
    const bu = this.blur.u;
    bu.tColor.value = this.colorRT.texture; bu.tDepth.value = this.depthRT.texture;
    bu.uScale.value.set(vw / this.colorRT.width, vh / this.colorRT.height);
    bu.uDScale.value.set(dw / this.depthRT.width, dh / this.depthRT.height);
    bu.uDTexel.value.set(2 / this.depthRT.width, 2 / this.depthRT.height);
    bu.uVp.value.set(vw, vh);
    bu.uProj.value.set(cam.projectionMatrix.elements[0], cam.projectionMatrix.elements[5]);
    bu.uVel.value.copy(vView); bu.uAng.value.copy(aView);
    bu.uExp.value = lk.shutter; bu.uRO.value = lk.readout;
    // prop jello: phase integrated on the CPU (seamless for any time-varying motion.hz, no fp32 drift with play time);
    // amplitude averaged over the exposure, so an ND shutter washes it out the way a real one does
    let hz = +(motion.hz ?? lk.jelloFreq ?? 170);
    if (!Number.isFinite(hz)) hz = 170;
    hz = Math.min(1000, Math.max(10, hz));
    const ja = lk.jelloAmp * (motion.vib ?? 1), ph = this._jph, J = this._jJ, W = this._jW, A = this._jA;
    for (let i = 0; i < 3; i++) {
      W[i] = TAU * hz * JELLO_RATIO[i];
      ph[i] = (ph[i] + W[i] * Math.min(dt, 0.1)) % TAU;
      A[i] = ja * JELLO_AXIS[i] * sinc(W[i] * lk.shutter * 0.5);
      J[i] = A[i] * Math.sin(ph[i]);
    }
    bu.uJelloAmp.value.fromArray(A); bu.uJelloW.value.fromArray(W); bu.uJelloPh.value.fromArray(ph); bu.uJello0.value.fromArray(J);
    bu.uFrame.value = this.frame % 64; bu.uMaxS.value = lk.maxSamples; bu.uLodMax.value = needMips ? 4 : 0;
    this.blurRT.viewport.set(0, 0, vw, vh);
    r.setRenderTarget(this.blurRT); r.clear(true, false, false); r.render(this.blur.scene, this.quadCam);

    // 4) downsample (metering luma + bloom bright-pass)
    const prevExp = this.exp[this.expIdx], nextExp = this.exp[1 - this.expIdx];
    const H = this.hdr ? 1 : 0, LS = this.hdr ? 16 : 1, F16 = this.f16 ? 1 : 0;
    const du = this.down.u;
    du.tSrc.value = this.blurRT.texture; du.tExp.value = prevExp.texture;
    du.uScale.value.set(vw / this.blurRT.width, vh / this.blurRT.height);
    du.uTexel.value.set(1 / this.smallRT.width, 1 / this.smallRT.height);
    du.uClampLo.value.set(0.5 / vw, 0.5 / vh);
    du.uInv.value = lk.invTone; du.uThresh.value = 1.0;
    du.uHdr.value = H; du.uLumScale.value = LS; du.uF16.value = F16;
    r.setRenderTarget(this.smallRT); r.clear(true, false, false); r.render(this.down.scene, this.quadCam);

    // 5) auto-exposure with lag (GPU-side, no readback stalls)
    const mu = this.meter.u;
    mu.tSmall.value = this.smallRT.texture; mu.tPrev.value = prevExp.texture;
    mu.uDt.value = Math.min(dt, 0.1); mu.uBias.value = lk.evBias; mu.uInv.value = lk.invTone;
    mu.uHdr.value = H; mu.uLumScale.value = LS; mu.uF16.value = F16; this.final.u.uHdr.value = H;
    mu.uEvMin.value = lk.evMin; mu.uEvMax.value = lk.evMax; mu.uUp.value = lk.aeUp; mu.uDown.value = lk.aeDown;
    mu.uReset.value = this.resetExposure ? 1 : 0; this.resetExposure = false;
    r.setRenderTarget(nextExp); r.clear(true, false, false); r.render(this.meter.scene, this.quadCam);
    this.expIdx = 1 - this.expIdx;

    // 6) bloom: separable 9-tap gaussian at unit tap spacing (the linear-sampling offsets assume it), run twice
    const bw = this.smallRT.width, bh = this.smallRT.height;
    let src = this.smallRT;
    for (let it = 0; it < 2; it++) {
      this.bloomH.u.tSrc.value = src.texture; this.bloomH.u.uDir.value.set(1 / bw, 0);
      r.setRenderTarget(this.bloomA); r.clear(true, false, false); r.render(this.bloomH.scene, this.quadCam);
      this.bloomV.u.tSrc.value = this.bloomA.texture; this.bloomV.u.uDir.value.set(0, 1 / bh);
      r.setRenderTarget(this.bloomB); r.clear(true, false, false); r.render(this.bloomV.scene, this.quadCam);
      src = this.bloomB;
    }

    // 7) lens + colour science + sensor -> screen
    const fu = this.final.u;
    fu.tSrc.value = this.blurRT.texture; fu.tBloom.value = this.bloomB.texture; fu.tExp.value = nextExp.texture;
    fu.uScale.value.set(vw / this.blurRT.width, vh / this.blurRT.height);
    fu.uSrcPx.value.set(vw, vh);
    fu.uHalf.value.set(L.hw, L.hh); fu.uF.value = L.F; fu.uK.value = L.k; fu.uSrcTan.value.set(L.tx, L.ty); fu.uRc.value = Math.hypot(L.hw, L.hh);
    fu.uCA.value = lk.lens.ca; fu.uVig.value = lk.vignette;
    fu.uSharp.value = lk.sharpen * Math.min(1.25, 1.0 / Math.max(0.55, Math.sqrt(sx * sy)));
    fu.uGrain.value = lk.grain; fu.uGrainEv.value.fromArray(lk.grainEv || [0, 0.9]);
    fu.uSat.value = lk.saturation; fu.uShSat.value = lk.shadowSat ?? 1; fu.uInv.value = lk.invTone;
    fu.uBloom.value = lk.bloom * (this.f16 ? 1 : 8); fu.uExpo.value = lk.expo;
    const ce = lk.clipEv;
    fu.uWhite.value = Number.isFinite(ce) ? 1 / (1 - Math.exp(-1.25 * 0.24 * lk.expo * Math.pow(2, ce))) : 1;
    fu.uToe.value = lk.toe || 0; fu.uVeil.value = lk.veil || 0;
    fu.uSel.value.set(lk.skySel || 0, lk.greenSel || 0); fu.uSkyBoost.value = lk.skyBoost || 0;
    fu.uFrame.value = this.frame % 4096;
    fu.uLetter.value = lk.letterbox; fu.uWB.value.fromArray(lk.wb); fu.uWBShade.value.fromArray(lk.wbShade || lk.wb); fu.uLift.value = lk.lift;
    r.setRenderTarget(null);
    r.setViewport(0, 0, this.outW, this.outH);
    r.clear(true, true, false);
    r.render(this.final.scene, this.quadCam);
  }
}
