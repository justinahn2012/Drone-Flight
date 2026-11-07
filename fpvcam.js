// fpvcam.js — "real camera" emulation for Gaussian-splat worlds.
// Everything here models what a GoPro on a drone physically does to light:
//   shutter (motion blur over a fixed exposure time), rolling-shutter readout + prop "jello",
//   a wide barrel lens (+ lateral chromatic aberration, optical vignetting),
//   auto-exposure with lag and a clipped highlight shoulder, halation/bloom,
//   in-camera sharpening, saturation, and signal-dependent sensor noise.
// Cost tricks: blur is computed analytically from the drone's own motion + a cheap depth
// pass of the physics collider (no velocity buffer), sample count adapts per pixel to the
// blur length, and the splat pass shrinks when the frame is blurred anyway.
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
uniform vec2 uVp;         // viewport size in px
uniform vec2 uProj;       // P[0][0], P[1][1]
uniform vec3 uVel;        // camera linear velocity, view space (m/s)
uniform vec3 uAng;        // camera angular velocity, view space (rad/s)
uniform float uExp;       // exposure time (s)
uniform float uRO;        // rolling-shutter readout time (s)
uniform vec3 uJelloAmp;   // rad
uniform vec3 uJelloFreq;  // Hz
uniform float uTime;
uniform float uFrame;
uniform float uMaxS;

vec3 rotv(vec3 v, vec3 a){ // Rodrigues
  float t = length(a);
  if (t < 1e-6) return v + cross(a, v);
  vec3 k = a / t; float c = cos(t), s = sin(t);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
vec3 jello(float tau){
  float t = uTime + tau;
  return uJelloAmp * sin(6.2831853 * uJelloFreq * t + vec3(0.0, 1.3, 2.1));
}
// where does the point seen at this pixel by the camera at time tau appear in the rendered (t=0) frame?
vec2 warp(vec3 P, float tau){
  vec3 p0 = uVel * tau + rotv(P, uAng * tau + jello(tau) - jello(0.0));
  if (p0.z > -0.01) return vec2(-10.0);
  return 0.5 + 0.5 * vec2(uProj.x * p0.x, uProj.y * p0.y) / -p0.z;
}
vec3 tap(vec2 uv, float lod){
  vec2 h = 0.5 * exp2(lod) / uVp;     // keep the mip footprint inside the live viewport
  return textureLod(tColor, clamp(uv, h, 1.0 - h) * uScale, lod).rgb;
}
void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 dir = vec3(ndc.x / uProj.x, ndc.y / uProj.y, -1.0);
  float z = decodeDepth(texture(tDepth, vUv * uDScale));
  vec3 P = dir * z;
  float tauRow = ((1.0 - vUv.y) - 0.5) * uRO;          // top rows are read out first
  vec2 a = warp(P, tauRow - 0.5 * uExp);
  vec2 b = warp(P, tauRow + 0.5 * uExp);
  if (a.x < -5.0 || b.x < -5.0) { fragColor = vec4(tap(vUv, 0.0), 1.0); return; }
  float lenPx = length((b - a) * uVp);
  float n = clamp(ceil(lenPx / 1.6), 1.0, uMaxS);
  float lod = clamp(log2(max(lenPx / n, 1.0) / 1.25), 0.0, 4.0);   // prefilter: tap footprint ~ sample spacing
  float j = ign(gl_FragCoord.xy + uFrame * 5.588238);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    if (float(i) >= n) break;
    float f = (n > 1.0) ? (float(i) + j) / n - 0.5 : 0.0;   // box shutter, jittered
    vec2 s = warp(P, tauRow + f * uExp);
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
uniform vec2 uTexel;     // source texel in viewport-uv
uniform float uInv;
uniform float uThresh;
void main(){
  vec3 c = vec3(0.0);
  c += texture(tSrc, clamp(vUv + vec2(-uTexel.x, -uTexel.y), 0.0, 1.0) * uScale).rgb;
  c += texture(tSrc, clamp(vUv + vec2( uTexel.x, -uTexel.y), 0.0, 1.0) * uScale).rgb;
  c += texture(tSrc, clamp(vUv + vec2(-uTexel.x,  uTexel.y), 0.0, 1.0) * uScale).rgb;
  c += texture(tSrc, clamp(vUv + vec2( uTexel.x,  uTexel.y), 0.0, 1.0) * uScale).rgb;
  c *= 0.25;
  vec3 lin = srgb2lin(c);
  float L = dot(lin, LUMA);
  float ev = decodeEv(texelFetch(tExp, ivec2(0), 0));
  vec3 e = invTone(lin, uInv) * exp2(ev);
  vec3 bright = max(e - vec3(uThresh), 0.0);
  fragColor = vec4(min(bright / 8.0, 1.0), sqrt(L));
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
void main(){
  float lsum = 0.0, asum = 0.0, wsum = 0.0;
  for (int y = 0; y < 7; y++) for (int x = 0; x < 9; x++) {
    vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(9.0, 7.0);
    float L = texture(tSmall, uv).a; L *= L;
    float Lh = min(invTone(vec3(L), uInv).r, 1.1);
    vec2 d = (uv - vec2(0.5, 0.45)) * vec2(1.6, 2.0);
    float w = exp(-dot(d, d) * 1.6);            // centre-weighted metering
    lsum += w * log2(Lh + 1e-3); asum += w * Lh; wsum += w;
  }
  float avg = exp2(mix(lsum / wsum, log2(asum / wsum + 1e-3), 0.15));
  float target = clamp(log2(0.24 / avg) + uBias, uEvMin, uEvMax);
  if (uLock > 0.5) target = uLockEv;
  float prev = decodeEv(texelFetch(tPrev, ivec2(0), 0));
  float rate = target > prev ? uUp : uDown;
  float ev = uReset > 0.5 ? target : prev + (target - prev) * (1.0 - exp(-uDt * rate));
  fragColor = encodeEv(ev);
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
uniform float uSat;
uniform float uInv;
uniform float uBloom;
uniform float uExpo;      // exposure scale before the tone curve
uniform float uTime;
uniform float uFrame;
uniform float uLetter;    // letterbox fraction (0 = none)
uniform vec3 uWB;
uniform float uLift;

vec2 lensMap(vec2 uv, float ca, out float theta){
  vec2 q = (uv - 0.5) * 2.0 * uHalf;
  float r = length(q);
  theta = (uK > 0.999) ? atan(r / uF) : atan(r * uK / uF) / uK;
  float rn = r / uRc;
  float t = tan(theta) * (1.0 + ca * rn * rn);
  vec2 s = r > 1e-5 ? q * (t / r) : q / uF;
  return 0.5 + 0.5 * s / uSrcTan;
}
vec3 tex(vec2 s){ vec2 h = 0.5 / uSrcPx; return texture(tSrc, clamp(s, h, 1.0 - h) * uScale).rgb; }
// sensor-like response: ~linear toe (keeps lifted GoPro shadows), exponential shoulder that clips skies/windows
vec3 camCurve(vec3 x){ return 1.0 - exp(-max(x, 0.0) * 1.25); }
float hash(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }

void main(){
  if (uLetter > 0.0 && abs(vUv.y - 0.5) > 0.5 - uLetter) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float th, thR, thB;
  vec2 sG = lensMap(vUv, 0.0, th);
  vec2 sR = lensMap(vUv, uCA, thR);
  vec2 sB = lensMap(vUv, -uCA, thB);
  vec3 c = vec3(tex(sR).r, tex(sG).g, tex(sB).b);
  // in-camera sharpening (luma unsharp mask, the "GoPro crunch")
  vec2 px = 1.0 / uSrcPx;
  float Ln = dot(tex(sG + vec2(px.x, 0.0)) + tex(sG - vec2(px.x, 0.0)) + tex(sG + vec2(0.0, px.y)) + tex(sG - vec2(0.0, px.y)), LUMA) * 0.25;
  float Lc = dot(c, LUMA);
  c = clamp(c + (Lc - Ln) * uSharp, 0.0, 1.0);

  vec3 lin = srgb2lin(c);
  float ev = decodeEv(texelFetch(tExp, ivec2(0), 0));
  vec3 e = invTone(lin, uInv) * exp2(ev) * uWB;
  e += texture(tBloom, clamp(sG, 0.0, 1.0)).rgb * 8.0 * uBloom;           // halation / glare
  float vig = pow(max(cos(th), 0.0), 2.2);                                   // optical cos^n falloff
  e *= mix(1.0, vig, uVig);
  vec3 t = camCurve(e * uExpo);
  float l = dot(t, LUMA);
  t = max(mix(vec3(l), t, uSat), 0.0);
  vec3 o = lin2srgb(t);
  o = mix(o, o * o * (3.0 - 2.0 * o), 0.22);          // mild display S-curve
  o = o * (1.0 - uLift) + uLift;
  // signal-dependent sensor noise: shot noise ~ sqrt(signal), scaled by analog gain (positive EV)
  float gain = exp2(max(ev, 0.0) * 0.9);
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

function rt(w, h, filter = THREE.LinearFilter, mips = false) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    minFilter: mips ? THREE.LinearMipmapLinearFilter : filter, magFilter: filter, type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    depthBuffer: true, stencilBuffer: false, generateMipmaps: mips,
  });
}

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
      evMin: -1.2, evMax: 1.8, aeUp: 3.3, aeDown: 7.5, wb: [1.06, 1.0, 0.88], lift: 0.07,
      maxSamples: 14,
    };
    // dynamic resolution
    this.scale = 0.9; this.minScale = 0.55; this.maxScale = 1.0;
    this.blurScale = 1.0;
    this.ftEma = 16.7; this.slowT = 0; this.fastT = 0; this.capT = 0; this.ceilLock = 0;
    this.targetMs = 16.7;
    this.resetExposure = true;

    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: `varying float vZ; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vZ; void main(){ float d = clamp(log2(max(vZ, 0.02) / 0.02) / 12.28771238, 0.0, 1.0); float hi = floor(d * 255.0) / 255.0; gl_FragColor = vec4(hi, fract(d * 255.0), 0.0, 1.0); }`,
      side: THREE.DoubleSide,
    });

    this.blur = pass(BLUR_FS, {
      tColor: { value: null }, tDepth: { value: null }, uScale: { value: new THREE.Vector2(1, 1) },
      uDScale: { value: new THREE.Vector2(1, 1) }, uVp: { value: new THREE.Vector2(1, 1) },
      uProj: { value: new THREE.Vector2(1, 1) }, uVel: { value: new THREE.Vector3() }, uAng: { value: new THREE.Vector3() },
      uExp: { value: 1 / 120 }, uRO: { value: 0.008 }, uJelloAmp: { value: new THREE.Vector3() },
      uJelloFreq: { value: new THREE.Vector3(170, 183, 157) }, uTime: { value: 0 }, uFrame: { value: 0 }, uMaxS: { value: 12 },
    });
    this.down = pass(DOWN_FS, {
      tSrc: { value: null }, tExp: { value: null }, uScale: { value: new THREE.Vector2(1, 1) },
      uTexel: { value: new THREE.Vector2() }, uInv: { value: 0.82 }, uThresh: { value: 1.0 },
    });
    this.meter = pass(METER_FS, {
      tSmall: { value: null }, tPrev: { value: null }, uDt: { value: 0.016 }, uBias: { value: 0 }, uInv: { value: 0.82 },
      uUp: { value: 3.3 }, uDown: { value: 7.5 }, uReset: { value: 1 }, uLock: { value: 0 }, uLockEv: { value: 0 },
      uEvMin: { value: -1.2 }, uEvMax: { value: 1.3 },
    });
    this.bloomH = pass(BLOOM_FS, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.bloomV = pass(BLOOM_FS, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.final = pass(FINAL_FS, {
      tSrc: { value: null }, tBloom: { value: null }, tExp: { value: null }, uScale: { value: new THREE.Vector2(1, 1) },
      uSrcPx: { value: new THREE.Vector2(1, 1) }, uHalf: { value: new THREE.Vector2(1, 1) }, uF: { value: 1 }, uK: { value: 0.5 },
      uSrcTan: { value: new THREE.Vector2(1, 1) }, uRc: { value: 1 }, uCA: { value: 0.01 }, uVig: { value: 0.5 }, uSharp: { value: 0.5 },
      uGrain: { value: 0.04 }, uSat: { value: 1.2 }, uInv: { value: 0.82 }, uBloom: { value: 0.5 }, uExpo: { value: 1 },
      uTime: { value: 0 }, uFrame: { value: 0 }, uLetter: { value: 0 },
      uWB: { value: new THREE.Vector3(1, 1, 1) }, uLift: { value: 0 },
    });
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.exp = [rt(1, 1, THREE.NearestFilter), rt(1, 1, THREE.NearestFilter)];
    this.expIdx = 0;
    this.outW = 1; this.outH = 1;
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  setQualityRange(min, max) { this.minScale = min; this.maxScale = max; this.scale = Math.min(Math.max(this.scale, min), max); }

  resize(w, h) {
    this.outW = Math.max(2, Math.round(w)); this.outH = Math.max(2, Math.round(h));
    const cap = 1.15;
    const cw = Math.ceil(this.outW * cap), ch = Math.ceil(this.outH * cap);
    if (!this.colorRT || this.colorRT.width !== cw || this.colorRT.height !== ch) {
      this.colorRT?.dispose(); this.blurRT?.dispose(); this.depthRT?.dispose();
      this.colorRT = rt(cw, ch, THREE.LinearFilter, true); this.blurRT = rt(cw, ch);
      this.depthRT = rt(Math.ceil(cw / 2), Math.ceil(ch / 2), THREE.NearestFilter);
    }
    const sw = Math.max(16, Math.round(this.outW / 8)), sh = Math.max(9, Math.round(this.outH / 8));
    this.smallRT?.dispose(); this.bloomA?.dispose(); this.bloomB?.dispose();
    this.smallRT = rt(sw, sh); this.bloomA = rt(sw, sh); this.bloomB = rt(sw, sh);
    this.computeLens();
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
    this.ftEma += (ms - this.ftEma) * 0.08;
    const over = this.ftEma > this.targetMs * 1.14, under = this.ftEma < this.targetMs * 1.04;
    if (over) { this.slowT += ms; this.fastT = 0; } else if (under) { this.fastT += ms; this.slowT = 0; }
    if (this.slowT > 450) { this.ceilLock = this.scale; this.scale = Math.max(this.minScale, this.scale * 0.9); this.slowT = 0; this.capT = 6000; }
    this.capT = Math.max(0, this.capT - ms);
    if (this.fastT > 2500) {
      const ceil = this.capT > 0 ? this.ceilLock * 0.97 : this.maxScale;
      this.scale = Math.min(ceil, this.maxScale, this.scale * 1.04); this.fastT = 0;
    }
  }

  // world: { splatScene, colliderScene|null }
  // pose: { pos, quat } of the camera actually displayed
  // motion: { vel (world m/s), ang (world rad/s) } of the physical camera during exposure
  render(world, pose, motion, dt) {
    const r = this.r, lk = this.look;
    this.frame++; this.time += dt;
    const cam = this.cam;
    cam.position.copy(pose.pos); cam.quaternion.copy(pose.quat); cam.updateMatrixWorld(true);

    // motion in view space
    this._q.copy(pose.quat).invert();
    const vView = this._v.copy(motion.vel).applyQuaternion(this._q);
    const aView = new THREE.Vector3().copy(motion.ang).applyQuaternion(this._q);

    // Blur-aware resolution: rotation smears the WHOLE frame (incl. centre) by L px along the motion.
    // A box blur of length L kills detail above ~1/L cycles/px, so rendering finer than that is wasted.
    const vpH0 = this.outH * this.scale;
    const fpx = (vpH0 / 2) / this.lens.ty;
    const Lrot = Math.hypot(aView.x, aView.y) * lk.shutter * fpx;
    const target = Lrot > 3 ? Math.max(0.72, Math.sqrt(3 / Lrot)) : 1.0;
    this.blurScale += (target - this.blurScale) * (target < this.blurScale ? 0.35 : 0.08);
    const s = this.scale * this.blurScale;
    const vw = Math.max(32, Math.round(this.outW * s)), vh = Math.max(18, Math.round(this.outH * s));
    this.vw = vw; this.vh = vh;

    // 1) splats
    this.colorRT.viewport.set(0, 0, vw, vh);
    r.setRenderTarget(this.colorRT);
    r.setClearColor(0x000000, 1); r.clear(true, true, false);
    r.render(world.splatScene, cam);

    // 2) depth from the physics collider (cheap: ~100k tris, half res, flat shader)
    const dw = Math.max(16, Math.round(vw / 2)), dh = Math.max(9, Math.round(vh / 2));
    this.depthRT.viewport.set(0, 0, dw, dh);
    r.setRenderTarget(this.depthRT);
    r.setClearColor(0xffff00, 1); r.clear(true, true, false);
    if (world.colliderScene) {
      world.colliderScene.overrideMaterial = this.depthMat;
      r.render(world.colliderScene, cam);
    }

    // 3) shutter + rolling shutter + jello
    const bu = this.blur.u;
    bu.tColor.value = this.colorRT.texture; bu.tDepth.value = this.depthRT.texture;
    bu.uScale.value.set(vw / this.colorRT.width, vh / this.colorRT.height);
    bu.uDScale.value.set(dw / this.depthRT.width, dh / this.depthRT.height);
    bu.uVp.value.set(vw, vh);
    bu.uProj.value.set(cam.projectionMatrix.elements[0], cam.projectionMatrix.elements[5]);
    bu.uVel.value.copy(vView); bu.uAng.value.copy(aView);
    bu.uExp.value = lk.shutter; bu.uRO.value = lk.readout;
    const ja = lk.jelloAmp * (motion.vib ?? 1);
    bu.uJelloAmp.value.set(ja, ja * 0.8, ja * 0.5);
    bu.uJelloFreq.value.set(lk.jelloFreq, lk.jelloFreq * 1.077, lk.jelloFreq * 0.93);
    bu.uTime.value = this.time; bu.uFrame.value = this.frame; bu.uMaxS.value = lk.maxSamples;
    this.blurRT.viewport.set(0, 0, vw, vh);
    r.setRenderTarget(this.blurRT); r.render(this.blur.scene, this.quadCam);

    // 4) downsample (metering luma + bloom bright-pass)
    const prevExp = this.exp[this.expIdx], nextExp = this.exp[1 - this.expIdx];
    const du = this.down.u;
    du.tSrc.value = this.blurRT.texture; du.tExp.value = prevExp.texture;
    du.uScale.value.set(vw / this.blurRT.width, vh / this.blurRT.height);
    du.uTexel.value.set(2 / this.smallRT.width * 0.5, 2 / this.smallRT.height * 0.5);
    du.uInv.value = lk.invTone; du.uThresh.value = 1.0;
    r.setRenderTarget(this.smallRT); r.render(this.down.scene, this.quadCam);

    // 5) auto-exposure with lag (GPU-side, no readback stalls)
    const mu = this.meter.u;
    mu.tSmall.value = this.smallRT.texture; mu.tPrev.value = prevExp.texture;
    mu.uDt.value = Math.min(dt, 0.1); mu.uBias.value = lk.evBias; mu.uInv.value = lk.invTone;
    mu.uEvMin.value = lk.evMin; mu.uEvMax.value = lk.evMax; mu.uUp.value = lk.aeUp; mu.uDown.value = lk.aeDown;
    mu.uReset.value = this.resetExposure ? 1 : 0; this.resetExposure = false;
    r.setRenderTarget(nextExp); r.render(this.meter.scene, this.quadCam);
    this.expIdx = 1 - this.expIdx;

    // 6) bloom
    this.bloomH.u.tSrc.value = this.smallRT.texture; this.bloomH.u.uDir.value.set(1.6 / this.smallRT.width, 0);
    r.setRenderTarget(this.bloomA); r.render(this.bloomH.scene, this.quadCam);
    this.bloomV.u.tSrc.value = this.bloomA.texture; this.bloomV.u.uDir.value.set(0, 1.6 / this.smallRT.height);
    r.setRenderTarget(this.bloomB); r.render(this.bloomV.scene, this.quadCam);

    // 7) lens + colour science + sensor -> screen
    const fu = this.final.u, L = this.lens;
    fu.tSrc.value = this.blurRT.texture; fu.tBloom.value = this.bloomB.texture; fu.tExp.value = nextExp.texture;
    fu.uScale.value.set(vw / this.blurRT.width, vh / this.blurRT.height);
    fu.uSrcPx.value.set(vw, vh);
    fu.uHalf.value.set(L.hw, L.hh); fu.uF.value = L.F; fu.uK.value = L.k; fu.uSrcTan.value.set(L.tx, L.ty); fu.uRc.value = Math.hypot(L.hw, L.hh);
    fu.uCA.value = lk.lens.ca; fu.uVig.value = lk.vignette;
    fu.uSharp.value = lk.sharpen * Math.min(1.25, 1.0 / Math.max(0.55, s));
    fu.uGrain.value = lk.grain; fu.uSat.value = lk.saturation; fu.uInv.value = lk.invTone;
    fu.uBloom.value = lk.bloom; fu.uExpo.value = lk.expo; fu.uTime.value = this.time; fu.uFrame.value = this.frame;
    fu.uLetter.value = lk.letterbox; fu.uWB.value.set(...lk.wb); fu.uLift.value = lk.lift;
    r.setRenderTarget(null);
    r.setViewport(0, 0, this.outW, this.outH);
    r.render(this.final.scene, this.quadCam);
  }
}
