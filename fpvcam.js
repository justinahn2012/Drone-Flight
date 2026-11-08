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
// Frame order: collider depth (+ world.depthScene) -> SSAO (feeds the scene's indirect light, contract C3)
//   -> scene (three clears after its shadow pass; a sentinel drops MSAA depth while the pass is open)
//   -> shutter blur -> meter/bloom (taps follow the lens) -> lens + grade + sensor.
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

// output uv -> rectilinear render uv through the barrel lens (one atan + one tan); FINAL and DOWN share it
const LENS = /* glsl */`
uniform vec2 uHalf;       // sensor crop half extents
uniform float uF;         // lens focal (sensor units)
uniform float uK;         // lens family: 1 = rectilinear, 0.5 = stereographic, ->0 equidistant
uniform vec2 uSrcTan;     // tan half-extents of the rectilinear render
vec2 lensD(vec2 uv, out float r, out float th){
  vec2 lq = (uv - 0.5) * 2.0 * uHalf;
  r = length(lq);
  th = (uK > 0.999) ? atan(r / uF) : atan(r * uK / uF) / uK;
  return (r > 1e-5 ? lq * (tan(th) / r) : lq / uF) * (0.5 / uSrcTan);
}
`;

// camera motion over the exposure (shared by the shutter blur and its TileMax pass)
const MOTION = /* glsl */`
uniform vec2 uProj;       // P[0][0], P[1][1]
uniform vec3 uVel;        // camera linear velocity, view space (m/s)
uniform vec3 uAng;        // camera angular velocity, view space (rad/s)
uniform float uExp;       // exposure time (s)
uniform float uRO;        // rolling-shutter readout time (s)
// small-angle rotation, 2nd order: < 0.3 px error at 720 deg/s over one exposure
vec3 rotv(vec3 v, vec3 a){ vec3 c = cross(a, v); return v + c + 0.5 * cross(a, c); }
// where does the point seen at this pixel by the camera at time tau appear in the rendered (t=0) frame? z: its t=0 depth
vec2 warpz(vec3 P, float tau, vec3 J, out float z){
  vec3 p0 = uVel * tau + rotv(P, uAng * tau + J);
  z = -p0.z;
  if (p0.z > -0.01) return vec2(-10.0);
  return 0.5 + 0.5 * vec2(uProj.x * p0.x, uProj.y * p0.y) / -p0.z;
}
vec2 warp(vec3 P, float tau, vec3 J){ float z; return warpz(P, tau, J, z); }
vec3 rayAt(vec2 uv){ vec2 n = uv * 2.0 - 1.0; return vec3(n.x / uProj.x, n.y / uProj.y, -1.0); }
`;

// TileMax (McGuire 2012): per tile of uTile render px, the nearest collider depth and the blur of that surface at the tile
// centre: rg = blur direction, b = reach (px: farthest a pixel of it can be smeared), a = nearest depth (m)
const TILE_FS = /* glsl */`precision highp float;
${COMMON}
${MOTION}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tDepth;
uniform vec2 uDVp;
uniform vec2 uVp;
uniform float uTile;      // render px per tile (even)
void main(){
  int t2 = int(uTile * 0.5);
  ivec2 b0 = ivec2(gl_FragCoord.xy) * t2, m = ivec2(uDVp) - 1;
  float dmin = 2.0;
  for (int y = 0; y < 32; y++) { if (y >= t2) break;
    for (int x = 0; x < 32; x++) { if (x >= t2) break;
      vec4 c = texelFetch(tDepth, min(b0 + ivec2(x, y), m), 0); dmin = min(dmin, c.r + c.g / 255.0); } }
  float z = 0.02 * exp2(dmin * LOGR);
  vec2 cpx = (vec2(ivec2(gl_FragCoord.xy)) + 0.5) * uTile, uv = cpx / uVp;
  float tr = ((1.0 - uv.y) - 0.5) * uRO;
  vec3 P = rayAt(uv) * z;
  vec2 a = warp(P, tr - 0.5 * uExp, vec3(0.0)), b = warp(P, tr + 0.5 * uExp, vec3(0.0));
  vec2 A = (a - uv) * uVp, B = (b - uv) * uVp;
  float reach = (a.x < -5.0 || b.x < -5.0) ? 0.0 : max(length(A), length(B));
  vec2 dir = length(B - A) > 1e-3 ? normalize(B - A) : vec2(1.0, 0.0);
  fragColor = vec4(dir, reach, z);
}`;

// NeighborMax: (2r+1)^2 tiles: the direction/reach of the farthest-reaching tile, and the nearest depth among them
const NBR_FS = /* glsl */`precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tTile;
uniform vec2 uTVp;
uniform float uR;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy), m = ivec2(uTVp) - 1, ri = ivec2(int(uR));
  vec4 best = vec4(1.0, 0.0, 0.0, 1e4); float zmin = 1e4;
  for (int y = -3; y <= 3; y++) { if (abs(y) > ri.y) continue;
    for (int x = -3; x <= 3; x++) { if (abs(x) > ri.x) continue;
      vec4 t = texelFetch(tTile, clamp(p + ivec2(x, y), ivec2(0), m), 0);
      if (t.b > best.b) best = t; zmin = min(zmin, t.a); } }
  fragColor = vec4(best.rg, best.b, zmin);
}`;

const BLUR_FS = /* glsl */`precision highp float;
${COMMON}
${MOTION}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNbr;   // NeighborMax tiles
uniform vec2 uScale;      // viewport / rt size (color)
uniform vec2 uDVp;        // depth viewport size, texels
uniform vec2 uVp;         // viewport size in px
uniform vec3 uJelloAmp;   // rad, already averaged over the exposure (sinc) on the CPU
uniform vec3 uJelloW;     // rad/s
uniform vec3 uJelloPh;    // phase at the rendered instant (CPU-integrated, wrapped to 2pi)
uniform vec3 uJello0;     // jello at the rendered instant: uJelloAmp * sin(uJelloPh)
uniform vec3 uJ2Amp;      // 45 Hz frame wobble (prop wash / bumps), exposure-averaged; absolute, it moves the whole frame
uniform vec3 uJ2W;
uniform vec3 uJ2Ph;
uniform float uFrame;     // wrapped 0..63
uniform float uMaxS;
uniform float uLodMax;    // 0 on frames whose mip chain wasn't rebuilt
uniform float uRecon;     // 1: reconstruction filter at silhouettes
uniform float uTile;      // render px per tile

vec3 tap(vec2 uv, float lod){
  vec2 h = 0.5 * exp2(lod) / uVp;     // keep the mip footprint inside the live viewport
  return textureLod(tColor, clamp(uv, h, 1.0 - h) * uScale, lod).rgb;
}
float zAt(vec2 uv){ vec4 c = texelFetch(tDepth, clamp(ivec2(uv * uDVp), ivec2(0), ivec2(uDVp) - 1), 0); return 0.02 * exp2((c.r + c.g / 255.0) * LOGR); }
// soft depth compare in log2 depth: 1 when b is >15% nearer than a, 0 within 5%
float nearer(float za, float zb){ return smoothstep(0.07, 0.2, log2(za / max(zb, 1e-3))); }
void main(){
  vec3 dir = rayAt(vUv);
  // own depth: the nearest half-res collider texel, no jitter, no blend (a blended depth invents a surface in between;
  // the reconstruction below makes the result independent of which side of the edge this texel falls)
  float zX = zAt(vUv);
  vec3 P = dir * zX;
  float tauRow = ((1.0 - vUv.y) - 0.5) * uRO;          // top rows are read out first
  vec3 J = uJelloAmp * sin(uJelloPh + uJelloW * tauRow) - uJello0   // prop jello, once per pixel (row time)
         + uJ2Amp * sin(uJ2Ph + uJ2W * tauRow);
  vec2 a = warp(P, tauRow - 0.5 * uExp, J);
  vec2 b = warp(P, tauRow + 0.5 * uExp, J);
  if (a.x < -5.0 || b.x < -5.0) { fragColor = vec4(tap(vUv, 0.0), 1.0); return; }
  float lenPx = length((b - a) * uVp);
  float n = clamp(ceil(lenPx / 1.6), 1.0, uMaxS);
  float lod = clamp(log2(max(lenPx / n, 1.0) / 1.25), 0.0, uLodMax);   // prefilter: tap footprint ~ sample spacing
  float j = ign(gl_FragCoord.xy + uFrame * 5.588238);
  // 1) own surface along its own (curved, rolling-shutter, jello) path. With the reconstruction on, taps that land on
  //    something nearer than this surface would be at that instant are occluders: they come in through 2), not here.
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = 0; i < 24; i++) {
    if (float(i) >= n) break;
    float fi = (n > 1.0) ? (float(i) + j) / n - 0.5 : 0.0;   // box shutter, jittered
    float ze; vec2 s = warpz(P, tauRow + fi * uExp, J, ze);
    float w = 1.0;
    if (s.x < -5.0) s = vUv;
    else if (uRecon > 0.5 && n > 1.0) w = 1.0 - nearer(ze, zAt(s));
    acc += tap(s, lod) * w; wsum += w;
  }
  vec3 cs = wsum > 1e-3 ? acc / wsum : tap(vUv, 0.0);
  // 2) foreground smeared over this pixel (McGuire 2012, scatter-as-gather): walk the neighbourhood's longest blur;
  //    a nearer surface Y covers X if X lies on Y's own smear, each tap carrying spacing / Y's smear length of coverage
  if (uRecon > 0.5) {
    vec4 nb = texelFetch(tNbr, ivec2(gl_FragCoord.xy / uTile), 0);
    if (nb.b > 0.75 && log2(zX / nb.a) > 0.07) {
      vec2 X = vUv * uVp;
      float R = nb.b, m = clamp(ceil(2.0 * R / 2.5), 4.0, 12.0), dl = 2.0 * R / m;
      float lf = clamp(log2(max(dl, 1.0) / 1.25), 0.0, uLodMax);
      float cov = 0.0; vec3 fg = vec3(0.0); float fw = 0.0;
      float j2 = fract(j + 0.5);
      for (int i = 0; i < 12; i++) {
        if (float(i) >= m) break;
        vec2 Y = X + nb.rg * (((float(i) + j2) / m) * 2.0 - 1.0) * R;
        vec2 uy = Y / uVp;
        float zY = zAt(uy), f = nearer(zX, zY);
        if (f <= 0.0) continue;
        vec3 PY = rayAt(uy) * zY;
        vec2 ay = warp(PY, tauRow - 0.5 * uExp, J), by = warp(PY, tauRow + 0.5 * uExp, J);
        if (ay.x < -5.0 || by.x < -5.0) continue;
        vec2 A = ay * uVp - Y, B = by * uVp - Y, q = Y - X, AB = B - A;   // X sees Y when Y - X = (warp - Y) at some tau
        float L = length(AB), u = clamp(dot(q - A, AB) / max(L * L, 1e-4), 0.0, 1.0);
        float perp = length(q - A - u * AB);
        float w = f * (1.0 - smoothstep(0.75, 1.5 + 0.15 * L, perp)) * min(1.0, dl / max(L, dl));
        cov += w; fg += tap(uy, lf) * w; fw += w;
      }
      if (fw > 1e-4) cs = mix(cs, fg / fw, min(cov, 1.0));
    }
  }
  fragColor = vec4(cs, 1.0);
}`;

// Screen-space AO, half res, from the collider (+ depthScene) depth. SAO-style: normal from the flatter neighbour per
// axis (no smear across silhouettes), 8 Vogel-spiral taps in a world-size disc, cosine term with a range falloff so
// a pole metres in front of a wall leaves no halo. A 90 deg floor/wall corner lands near the physical 0.5.
// 4x4 Bayer spiral offset, cancelled by the bilateral 4x4 pass.
const SSAO_FS = /* glsl */`precision highp float;
${COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tDepth;
uniform vec2 uDVp;        // depth viewport, texels
uniform vec2 uProj;
uniform float uR;         // radius (m)
uniform float uMaxPx;     // radius cap (texels): near the lens the disc shrinks instead of thrashing the cache
uniform float uStrength;
vec3 posAt(vec2 p){
  ivec2 ip = ivec2(clamp(p, vec2(0.0), uDVp - 1.0));
  vec4 c = texelFetch(tDepth, ip, 0);
  return vec3(((vec2(ip) + 0.5) / uDVp * 2.0 - 1.0) / uProj, -1.0) * (0.02 * exp2((c.r + c.g / 255.0) * LOGR));
}
float bayer2(vec2 a){ a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
void main(){
  vec2 px = floor(gl_FragCoord.xy) + 0.5;
  vec4 c0 = texelFetch(tDepth, ivec2(px), 0);
  float z = decodeDepth(c0);
  vec3 P = vec3((px / uDVp * 2.0 - 1.0) / uProj, -1.0) * z;
  vec2 kxy = 0.5 * uProj * uDVp / z;                  // texels per metre at this depth
  float R = uR, rpx = R * kxy.y;
  if (rpx > uMaxPx) { R *= uMaxPx / rpx; rpx = uMaxPx; }
  float fade = smoothstep(1.5, 4.0, rpx) * (1.0 - smoothstep(40.0, 80.0, z));
  float ao = 1.0;
  if (fade > 0.0) {
    vec3 x1 = posAt(px + vec2(1.0, 0.0)) - P, x0 = P - posAt(px - vec2(1.0, 0.0));
    vec3 y1 = posAt(px + vec2(0.0, 1.0)) - P, y0 = P - posAt(px - vec2(0.0, 1.0));
    // flatter side per axis; at the viewport edge the clamped side is a zero vector, so take the other one
    vec3 dx = (dot(x0, x0) == 0.0 || (abs(x1.z) < abs(x0.z) && dot(x1, x1) > 0.0)) ? x1 : x0;
    vec3 dy = (dot(y0, y0) == 0.0 || (abs(y1.z) < abs(y0.z) && dot(y1, y1) > 0.0)) ? y1 : y0;
    vec3 cn = cross(dx, dy);
    vec3 n = dot(cn, cn) > 1e-14 ? normalize(cn) : -normalize(P);
    if (dot(n, P) > 0.0) n = -n;
    float nz = bayer2(0.5 * px) * 0.25 + bayer2(px) + 0.03125;   // 4x4 Bayer, 1/32 .. 31/32
    float sum = 0.0, R2 = R * R;
    for (int k = 0; k < 8; k++) {
      float t = (float(k) + nz) * 0.125;
      float an = (float(k) + nz) * 2.3999632;          // golden angle spiral
      vec3 v = posAt(px + vec2(cos(an), sin(an)) * (sqrt(t) * R) * kxy) - P;
      float vv = dot(v, v), fall = max(0.0, 1.0 - vv / R2);
      sum += fall * fall * max(0.0, dot(v, n) * inversesqrt(vv + 1e-4 * R2) - 0.1);
    }
    ao = mix(1.0, max(0.0, 1.0 - uStrength * sum * 0.125), fade);
  }
  fragColor = vec4(ao, c0.r, c0.g, 1.0);               // depth rides along for the bilateral blur
}`;

// 4x4 bilateral box: exactly one of each Bayer rotation, so the pattern cancels; taps across a >26% depth step drop out
const AOBLUR_FS = /* glsl */`precision highp float;
${COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tAO;
uniform vec2 uDVp;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy), m = ivec2(uDVp) - 1;
  vec4 c = texelFetch(tAO, min(p, m), 0);
  float dc = c.g + c.b / 255.0, s = 0.0, w = 0.0;
  for (int y = -2; y < 2; y++) for (int x = -2; x < 2; x++) {
    vec4 t = texelFetch(tAO, clamp(p + ivec2(x, y), ivec2(0), m), 0);
    float wt = max(0.0, 1.0 - abs(t.g + t.b / 255.0 - dc) * (LOGR * 3.0));
    s += t.r * wt; w += wt;
  }
  fragColor = vec4(s / max(w, 1e-3), 0.0, 0.0, 1.0);
}`;

const DOWN_FS = /* glsl */`precision highp float;
${COMMON}
${LENS}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tSrc;
uniform sampler2D tExp;
uniform vec2 uScale;
uniform vec2 uTexel;     // one destination texel, in destination uv
uniform vec2 uClampLo;   // half a source pixel, in source-viewport uv
uniform float uInv;
uniform float uThresh;
uniform float uHdr;
uniform float uLumScale;
uniform float uF16;      // 1: half-float target, store raw radiance (no sqrt/8-bit encodings)
uniform float uLens;     // 1: destination is the displayed (lens-mapped) frame: meter + bloom see exactly what's shown
uniform float uBloomCap;
uniform vec3 uWB;
uniform vec3 uWBShade;
void main(){
  // 4x4 bilinear taps a quarter texel apart: each averages a 2x2 quad, together the whole block (exact for 8x8)
  vec3 c = vec3(0.0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    vec2 uv = vUv + (vec2(float(x), float(y)) - 1.5) * 0.25 * uTexel;
    if (uLens > 0.5) { float r, th; uv = 0.5 + lensD(uv, r, th); }
    c += texture(tSrc, clamp(uv, uClampLo, 1.0 - uClampLo) * uScale).rgb;
  }
  c *= 0.0625;
  vec3 lin = uHdr > 0.5 ? max(c, 0.0) : srgb2lin(c);
  float L = dot(lin, LUMA);
  float ev = decodeEv(texelFetch(tExp, ivec2(0), 0));
  vec3 e = (uHdr > 0.5 ? lin : invTone(lin, uInv)) * exp2(ev);
  // HDR: the bright pass sees the white-balanced exposure (halos take the image's WB, not the raw sky's blue)
  if (uHdr > 0.5) e *= mix(uWB, uWBShade, smoothstep(1.5, 3.0, ev));
  vec3 bright = max(e - vec3(uThresh), 0.0);
  fragColor = uF16 > 0.5 ? vec4(min(bright, vec3(uBloomCap)), min(L, 6.0e4))
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
uniform vec4 uHl;         // highlight meter: x = clip level (EV over target), y = gain, z = share threshold, w = max cut (EV)
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
  float want = log2(0.24 / avg) + uBias;
  float target = clamp(want, uEvMin, uEvMax);
  // highlight-aware: share of taps (unweighted, soft +-1/4 EV edge) that would clip at the un-reduced target. Measured at
  // that target, not at the lagged EV, so the cut can't feed back on itself.
  if (uHl.y > 0.0) {
    float thr = 0.24 * exp2(uHl.x - target), fs = 0.0;
    for (int y = 0; y < 7; y++) for (int x = 0; x < 9; x++) {
      float a = texture(tSmall, (vec2(float(x), float(y)) + 0.5) / vec2(9.0, 7.0)).a;
      fs += smoothstep(thr * 0.84, thr * 1.19, uF16 > 0.5 ? a : a * a * uLumScale);
    }
    float fr = fs / 63.0;
    if (fr > uHl.z) target = clamp(target - min(uHl.w, uHl.y * log2(fr / uHl.z)), uEvMin, uEvMax);
  }
  if (uLock > 0.5) target = uLockEv;
  float rate = target > prevEv ? uUp : uDown;
  float k = 1.0 - exp(-uDt * rate);
  float ev = uReset > 0.5 ? target : prevEv + (target - prevEv) * k;
  vec4 o = encodeEv(ev);
  o.b = clamp(0.5 * asum / wsum * exp2(ev), 0.0, 1.0);   // metered mean of the exposed frame (lens veil reads it)
  // how hard AE is pinned: EV wanted beyond evMax (0..4 -> 0..1), with the AE lag; FINAL relaxes toe/contrast from it
  float pin = clamp((want - uEvMax) * 0.25, 0.0, 1.0), pin0 = texelFetch(tPrev, ivec2(0), 0).a;
  o.a = uReset > 0.5 ? pin : pin0 + (pin - pin0) * min(1.0, max(k, 1.0 / 255.0 / max(abs(pin - pin0), 1e-3)));   // >= 1 code step: 8 bits can't stall
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
${LENS}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tSrc;
uniform sampler2D tBloom;
uniform sampler2D tExp;
uniform vec2 uScale;
uniform vec2 uSrcPx;      // viewport px of source
uniform float uRc;        // corner radius (sensor units)
uniform float uCA;
uniform float uVig;
uniform float uSharp;
uniform float uGrain;
uniform vec2 uGrainEv;    // analog gain for noise: exp2(max(ev + x, 0) * y)
uniform float uGrainPx;   // grain clump size (px): phone NR + codec leave ~2 px grain, not per-pixel noise
uniform float uSat;
uniform float uShSat;     // saturation multiplier in deep shadows (1 = off)
uniform float uInv;
uniform float uBloom;     // includes the bloom target's encoding scale
uniform float uBloomOut;  // 1: bloom target is in output (lens-mapped) space
uniform float uExpo;      // exposure scale before the tone curve
uniform float uWhite;     // sensor clip: rescales camCurve so it reaches 1.0 at +clipEv over the AE target (1 = never)
uniform float uToe;       // 0 = off
uniform float uCon;       // camera contrast about the AE target (1 = off)
uniform float uVeil;      // veiling glare, x (metered mean / 2)
uniform vec2 uSel;        // selective colour amounts: x = sky, y = foliage greens (0 = off)
uniform float uSkyBoost;  // sky chroma gain
uniform vec2 uSkyK;       // sky hue rotation (rad), sky darken
uniform float uFrame;     // wrapped
uniform float uLetter;    // letterbox fraction (0 = none)
uniform vec3 uWB;
uniform vec3 uWBShade;    // white balance once exposure is pushed (shade/interiors); = uWB for splat worlds
uniform float uLift;
uniform float uHdr;
uniform float uRecon;     // rotated-grid reconstruct radius, source px (0 = single tap)
uniform float uChroma;    // chroma block half-size, output px (0 = off)
uniform float uSharpPx;   // unsharp offset, source px
uniform vec2 uPinEv;      // pin depth (EV wanted past evMax) where toe/contrast start / finish relaxing
uniform vec2 uPinK;       // x: toe relax, y: contrast relax (0..1)

vec3 tex(vec2 s){ vec2 h = 0.5 / uSrcPx; return texture(tSrc, clamp(s, h, 1.0 - h) * uScale).rgb; }
// sensor-like response: ~linear toe, exponential shoulder that clips skies/windows
vec3 camCurve(vec3 x){ return 1.0 - exp(-max(x, 0.0) * 1.25); }
float hash(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }

void main(){
  if (uLetter > 0.0 && abs(vUv.y - 0.5) > 0.5 - uLetter) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // lens: one atan + one tan per pixel; lateral CA only rescales the radius per channel
  float r, th;
  vec2 d = lensD(vUv, r, th);
  float rn = r / uRc;
  float car = uCA * rn * rn;
  vec2 sG = 0.5 + d, sR = 0.5 + d * (1.0 + car), sB = 0.5 + d * (1.0 - car);
  vec2 jx = dFdx(sG), jy = dFdy(sG);                    // source uv per output px (chroma block)
  vec2 px = 1.0 / uSrcPx;
  vec3 c, g4;
  if (uRecon > 0.0) {
    // 4-tap rotated grid at +-uRecon source px: the lens + ISP + codec MTF a GoPro frame has (no texel-level speckle);
    // lateral CA rides along per channel
    vec2 o0 = vec2(0.3333, 1.0) * uRecon * px, o1 = vec2(1.0, -0.3333) * uRecon * px;
    vec3 tg = tex(sG + o0) + tex(sG - o0) + tex(sG + o1) + tex(sG - o1);
    float tr = tex(sR + o0).r + tex(sR - o0).r + tex(sR + o1).r + tex(sR - o1).r;
    float tb = tex(sB + o0).b + tex(sB - o0).b + tex(sB + o1).b + tex(sB - o1).b;
    g4 = tg * 0.25; c = vec3(tr * 0.25, g4.g, tb * 0.25);
  } else { g4 = tex(sG); c = vec3(tex(sR).r, g4.g, tex(sB).b); }
  if (uChroma > 0.0) {
    // 4:2:0-like: chroma from a 2x2 output-px block, luma kept; the CA fringe (c - g4) survives at its own resolution
    vec2 a = (jx + jy) * uChroma, b = (jx - jy) * uChroma;
    vec3 cb = (tex(sG + a) + tex(sG - a) + tex(sG + b) + tex(sG - b)) * 0.25 + (c - g4);
    c = max(cb + (dot(c, LUMA) - dot(cb, LUMA)), 0.0);
  }
  // in-camera sharpening (luma unsharp mask, the "GoPro crunch"); at uSharpPx it lifts the mid band the codec keeps
  vec2 sp = px * uSharpPx;
  float Ln = dot(tex(sG + vec2(sp.x, 0.0)) + tex(sG - vec2(sp.x, 0.0)) + tex(sG + vec2(0.0, sp.y)) + tex(sG - vec2(0.0, sp.y)), LUMA) * 0.25;
  float Lc = dot(c, LUMA);
  // [L5] HDR: as a luma ratio held to 0.6..1.6 (ui 12d): an interior exposed for concrete puts the sky through a slab
  // hole 5+ EV over it, and the additive mask drove the 2 px ring round every hole to 0 (black-rimmed white blotches)
  c = uHdr > 0.5 ? c * clamp(1.0 + (Lc - Ln) * uSharp * 0.8 / max(Lc, 1e-6), 0.6, 1.6) : clamp(c + (Lc - Ln) * uSharp, 0.0, 1.0);

  vec3 lin = uHdr > 0.5 ? c : srgb2lin(c);
  vec4 X = texelFetch(tExp, ivec2(0), 0);
  float ev = decodeEv(X);
  // AE pinned hard (dark tube): the sensor has no stops left, so the camera stops crushing (lighting #2)
  float pin = smoothstep(uPinEv.x, uPinEv.y, X.a * 4.0);
  float con = mix(uCon, 1.0, pin * uPinK.y), toe = uToe * (1.0 - pin * uPinK.x);
  // [L5] shade WB only for real interiors (EV 1.5..3.0, hall ~3.1): at 0.6..2.4 an outdoor shaded gap (silo gap EV ~1.4)
  // got ~40 % of the interior's warm correction (R/B x1.13) and the sky-blue shade went neutral (colour #2)
  vec3 wbm = mix(uWB, uWBShade, smoothstep(1.5, 3.0, ev));
  vec3 e = (uHdr > 0.5 ? lin : invTone(lin, uInv)) * exp2(ev) * wbm;
  e += texture(tBloom, uBloomOut > 0.5 ? vUv : clamp(sG, 0.0, 1.0)).rgb * uBloom;   // halation / glare (HDR: WB'd in its bright pass)
  float vig = pow(max(cos(th), 0.0), 2.2);                                 // optical cos^n falloff
  e *= mix(1.0, vig, uVig);
  if (con != 1.0) e *= pow(max(dot(e, LUMA), 1e-6) / 0.24, con - 1.0);     // camera contrast about the AE target
  e += uVeil * X.b * vec3(1.0, 0.99, 0.97);                                // veiling glare from the metered mean
  vec3 t = min(camCurve(e * uExpo) * uWhite, 1.0);                         // per channel: skies clip blue-first
  if (toe > 0.0) t = t * t / (t + toe) * (1.0 + toe);                       // sensor toe (real blacks)
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
    float ang = uSkyK.x * wS - 0.209 * wG, gn = 1.0 + uSkyBoost * wS - 0.15 * wG;
    float ca = cos(ang), sa = sin(ang);
    cq = gn * vec2(ca * cq.x - sa * cq.y, sa * cq.x + ca * cq.y);
    Y *= 1.0 - uSkyK.y * wS;
    o = clamp(vec3(Y + cq.y, Y - (0.2126 * cq.y + 0.0722 * cq.x) / 0.7152, Y + cq.x), 0.0, 1.0);
  }
  o = mix(o, o * o * (3.0 - 2.0 * o), 0.22);          // mild display S-curve
  o = o * (1.0 - uLift) + uLift;
  // signal-dependent sensor noise: shot noise ~ sqrt(signal), scaled by analog gain (positive EV), clumped by NR/codec
  float gain = exp2(max(ev + uGrainEv.x, 0.0) * uGrainEv.y);
  vec2 gp = floor(gl_FragCoord.xy / uGrainPx);
  float n = hash(vec3(gp, mod(uFrame, 997.0))) - 0.5;
  float nc = hash(vec3(gp.yx + 17.0, mod(uFrame, 991.0))) - 0.5;
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

function rt(w, h, { filter = THREE.LinearFilter, mips = false, type = THREE.UnsignedByteType, depth = false, samples = 0, format = THREE.RGBAFormat } = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    minFilter: mips ? THREE.LinearMipmapLinearFilter : filter, magFilter: filter, type, format,
    depthBuffer: depth, stencilBuffer: false, generateMipmaps: mips, samples,
  });
}

// Camera response per world type. setHDR() applies one of these as defaults; main.js may override any key after it.
// clipEv: highlights hard-clip this many EV over the auto-exposure target (null = old soft shoulder, never clips).
export const GRADES = {
  // display-referred splat captures: the original look, unchanged (also resets every key the HDR grade sets)
  ldr: { wb: [1.06, 1.0, 0.88], wbShade: null, evBias: 0, lift: 0.07, clipEv: null, con: 1, toe: 0, veil: 0, shadowSat: 1, skySel: 0, greenSel: 0,
    skyBoost: 0, skyRot: -0.227, skyDark: 0.10, bloom: 0.45, bloomCap: 64, grain: 0.015, grainEv: [0, 0.9], grainPx: 1, meterLens: 0,
    sharpen: 0.2, sharpPx: 1, recon: 0, chromaPx: 0, hlEv: null, hlFrac: 0.04, hlGain: 0, hlMax: 1, pinEv: [0.5, 1.5], pinToe: 0, pinCon: 0, mbRecon: 0, lensMask: 0 },
  // scene-linear mesh worlds: colorist's round-2 FINAL (panel2/color.md) + PLAN3 decisions 2/4/6/7 (sunny defaults;
  // main.js's HDR look line sets the per-sky wb/wbShade/evBias)
  // Round 4 (PLAN4 decisions 1, 3-5; colorist r3 #1/#3-#6, lighting #2, FPV #2/#3, art #2):
  //   clipEv 3.0 / evBias -0.30 (sunny; main.js sets overcast 0.0), sky 0.35/0.04, bloom 0.15 cap 2, grain 0.005;
  //   hl*: highlight-aware meter: if a share f > hlFrac of the 9x7 taps would sit over hlEv EV above the AE target
  //        (null = clipEv/con: where the contrast-then-clip curve really clips), lower EV by min(hlMax, hlGain*log2(f/hlFrac));
  //   pin*: when the meter WANTS pinEv[0]..pinEv[1] EV more than evMax (chimney, not the hall), relax toe (x(1-pinToe))
  //         and contrast (-> 1 by pinCon);
  //   recon: 4-tap rotated-grid reconstruct (+-recon source px) in FINAL; sharpPx: unsharp offset (source px);
  //   chromaPx: 4:2:0-like chroma average over +-chromaPx OUTPUT px (0 = off);
  //   mbRecon: McGuire-style reconstruction at silhouettes (TileMax/NeighborMax, soft depth compare, no depth jitter);
  //   lensMask: early-Z mask over the render area the lens never shows (inset by the frame's blur reach).
  // Round 5 [L5]: shadowSat 0.6 -> 0.85 (its luma window 0.01-0.16 is exactly shade: 0.6 greyed the sky-blue out of it,
  //   silo shade R/B 0.97 vs ref 0.79); pinEv [0.5, 1.5] -> [0.8, 1.8] (lighting #1: the toe/contrast relax starts later,
  //   rim at 3 m ~48 -> ~40 per D4; the bore walls get their level from the portal-sampled bake instead).
  hdr: { wb: [1.036, 0.994, 0.956], wbShade: [1.125, 0.978, 0.845], evBias: -0.30, lift: 0, clipEv: 3.0, con: 1.3, toe: 0.012, veil: 0.05, shadowSat: 0.85,
    skySel: 1, greenSel: 0, skyBoost: 0.35, skyRot: -0.40, skyDark: 0.04, bloom: 0.15, bloomCap: 2, grain: 0.005, grainEv: [1, 0.15], grainPx: 2, meterLens: 1,
    sharpen: 0.3, sharpPx: 2, recon: 0.6, chromaPx: 0.5, hlEv: null, hlFrac: 0.04, hlGain: 0.5, hlMax: 1, pinEv: [0.8, 1.8], pinToe: 1, pinCon: 1, mbRecon: 1, lensMask: 1 },
};
const TAU = Math.PI * 2;
const JELLO_RATIO = [1, 1.077, 0.93], JELLO_AXIS = [1, 0.8, 0.5];
// low band: frame wobble from prop wash / hits (FPV #7). Per-axis detune so pitch/yaw/roll beat instead of moving as one.
const JELLO2_RATIO = [1, 1.13, 0.89], JELLO2_AXIS = [1, 0.7, 0.6];
const sinc = (x) => (Math.abs(x) < 1e-4 ? 1 : Math.sin(x) / x);
const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);
// per-axis blur-aware render scale: a box smear of L px kills detail above ~1/L cycles/px along it
const axisScale = (L) => (L > 3 ? Math.max(0.6, Math.sqrt(3 / L)) : 1.0);
const MSAA_OFF_BELOW = 0.9, MSAA_ON_ABOVE = 0.93;
const MASK_N = 64;   // lens mask boundary points   // blurScale hysteresis for the non-MSAA scene target

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

// Fit a crop of a 16:9 sensor into the viewport, then solve the rectilinear render frustum that exactly covers the
// barrel-distorted output corners (+ margin for blur/RS warps). Pure: the native port and tools can call it.
export function solveLens(Ls, outW, outH) {
  const A = outW / outH;
  const hw = A >= 1 ? A : 1, hh = A >= 1 ? 1 : 1 / A;     // short half-side = 1
  const k = Ls.k, rc = Math.hypot(hw, hh), thMax = 1.16;    // ~66 deg corner cap
  const rect = k > 0.999;
  const Fs = rect ? 1 / Math.tan(Ls.thetaS) : k / Math.tan(k * Ls.thetaS);
  const Fc = rect ? rc / Math.tan(thMax) : rc * k / Math.tan(k * thMax);
  const F = Math.max(Fs, Fc);
  const thc = rect ? Math.atan(rc / F) : Math.atan(rc * k / F) / k;
  const Tc = Math.tan(thc) * 1.035;
  const tx = Tc * hw / rc, ty = Tc * hh / rc;
  return { hw, hh, F, k, tx, ty, thc, rc };
}

export class FPVCamera {
  constructor(renderer) {
    this.r = renderer;
    this.cam = new THREE.PerspectiveCamera(90, 16 / 9, 0.04, 300);
    this.frame = 0;
    this.time = 0;
    this.look = {
      // calibrated against 389 frames of the reference clip (see design doc)
      shutter: 1 / 60, readout: 0.0085, jelloAmp: 0.0007, jelloFreq: 170,
      jello2Hz: 45, jello2Wash: 0.012, jello2Bump: 0.004,   // rad of 45 Hz wobble per unit motion.wash / motion.bump
      lens: LENSES.ref, vignette: 0.35, sharpen: 0.2, grain: 0.015, saturation: 0.95,
      invTone: 0.84, bloom: 0.45, expo: 0.85, evBias: 0.0, letterbox: 0,
      evMin: -1.2, evMax: 1.8, aeUp: 3.3, aeDown: 7.5,
      maxSamples: 14,
      msaa: 4,                 // scene MSAA for mesh worlds (0 = off); used only where RGBA16F multisampling is supported
      ssao: 1,                 // contact AO for mesh worlds that expose world.aoUniforms (0 = off)
      aoRadius: 0.5,           // m
      aoStrength: 2.5,         // 2.5: a 90 deg corner reads ~0.5 (the cosine-weighted sky it really loses)
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
    this.samples = 0;          // MSAA samples of the scene target (0 when unsupported/off)
    this.msaaActive = false;   // this frame drew into the MSAA target (false while a hard smear uses the plain one)
    this._noMS = false;

    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: `varying float vZ; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vZ; void main(){ float d = clamp(log2(max(vZ, 0.02) / 0.02) / 12.28771238, 0.0, 1.0); float hi = floor(d * 255.0) / 255.0; gl_FragColor = vec4(hi, fract(d * 255.0), 0.0, 1.0); }`,
      side: THREE.DoubleSide,
    });
    // Drawn last in the scene pass: drops the scene target's depth while ANGLE/Metal still has the pass open, so the
    // (MSAA) depth is never stored. Invalidating after render() is too late: the resolve/mips already ended the pass.
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)); sg.setDrawRange(0, 0);
    this.sentinel = new THREE.Mesh(sg, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, transparent: true, depthTest: false, depthWrite: false, colorWrite: false,
      vertexShader: 'precision highp float;\nin vec3 position;\nvoid main(){ gl_Position = vec4(position, 1.0); }',
      fragmentShader: 'precision highp float;\nout vec4 o;\nvoid main(){ o = vec4(0.0); }',
    }));
    Object.assign(this.sentinel, { frustumCulled: false, renderOrder: 1e9, castShadow: false, receiveShadow: false, name: 'fpvcam.sentinel' });
    this.sentinel.onAfterRender = (renderer) => {
      const gl = renderer.getContext();
      if (gl.invalidateFramebuffer) { this._invD[0] = gl.DEPTH_ATTACHMENT; gl.invalidateFramebuffer(gl.FRAMEBUFFER, this._invD); }
    };
    this._invD = [0];

    this.blur = pass(BLUR_FS, {
      tColor: { value: null }, tDepth: { value: null }, uScale: { value: new THREE.Vector2(1, 1) },
      uDVp: { value: new THREE.Vector2(1, 1) }, uVp: { value: new THREE.Vector2(1, 1) },
      uProj: { value: new THREE.Vector2(1, 1) }, uVel: { value: new THREE.Vector3() }, uAng: { value: new THREE.Vector3() },
      uExp: { value: 1 / 120 }, uRO: { value: 0.008 }, uJelloAmp: { value: new THREE.Vector3() },
      uJelloW: { value: new THREE.Vector3() }, uJelloPh: { value: new THREE.Vector3() }, uJello0: { value: new THREE.Vector3() },
      uJ2Amp: { value: new THREE.Vector3() }, uJ2W: { value: new THREE.Vector3() }, uJ2Ph: { value: new THREE.Vector3() },
      uFrame: { value: 0 }, uMaxS: { value: 12 }, uLodMax: { value: 4 }, tNbr: { value: null }, uRecon: { value: 0 }, uTile: { value: 16 },
    });
    // TileMax / NeighborMax share the blur's motion uniforms (same objects: set once per frame)
    const B = this.blur.u;
    this.tile = pass(TILE_FS, { tDepth: { value: null }, uDVp: B.uDVp, uVp: B.uVp, uTile: B.uTile, uProj: B.uProj, uVel: B.uVel, uAng: B.uAng, uExp: B.uExp, uRO: B.uRO });
    this.nbr = pass(NBR_FS, { tTile: { value: null }, uTVp: { value: new THREE.Vector2(1, 1) }, uR: { value: 2 } });
    // early-Z mask over the render area the lens never shows (perf #3): depth 0 there, drawn first (after three's sky)
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(MASK_N * 2 * 3), 3));
    const mi = []; for (let i = 0; i < MASK_N; i++) { const a = 2 * i, b = 2 * ((i + 1) % MASK_N); mi.push(a, a + 1, b, b, a + 1, b + 1); }
    mg.setIndex(mi);
    this.lensMask = new THREE.Mesh(mg, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true, colorWrite: false, side: THREE.DoubleSide,
      vertexShader: 'precision highp float;\nin vec3 position;\nvoid main(){ gl_Position = vec4(position.xy, -1.0, 1.0); }',
      fragmentShader: 'precision highp float;\nout vec4 o;\nvoid main(){ o = vec4(0.0); }',
    }));
    Object.assign(this.lensMask, { frustumCulled: false, renderOrder: -1e9, castShadow: false, receiveShadow: false, name: 'fpvcam.lensMask' });
    this._maskKey = '';
    this.ssao = pass(SSAO_FS, {
      tDepth: { value: null }, uDVp: { value: new THREE.Vector2(1, 1) }, uProj: { value: new THREE.Vector2(1, 1) },
      uR: { value: 0.5 }, uMaxPx: { value: 24 }, uStrength: { value: 2.5 },
    });
    this.aoBlur = pass(AOBLUR_FS, { tAO: { value: null }, uDVp: { value: new THREE.Vector2(1, 1) } });
    const lensU = () => ({ uHalf: { value: new THREE.Vector2(1, 1) }, uF: { value: 1 }, uK: { value: 0.5 }, uSrcTan: { value: new THREE.Vector2(1, 1) } });
    this.down = pass(DOWN_FS, {
      tSrc: { value: null }, tExp: { value: null }, uScale: { value: new THREE.Vector2(1, 1) },
      uTexel: { value: new THREE.Vector2() }, uClampLo: { value: new THREE.Vector2() }, uInv: { value: 0.82 }, uThresh: { value: 1.0 },
      uHdr: { value: 0 }, uLumScale: { value: 1 }, uF16: { value: 0 }, uLens: { value: 0 }, uBloomCap: { value: 64 },
      uWB: { value: new THREE.Vector3(1, 1, 1) }, uWBShade: { value: new THREE.Vector3(1, 1, 1) }, ...lensU(),
    });
    this.meter = pass(METER_FS, {
      tSmall: { value: null }, tPrev: { value: null }, uDt: { value: 0.016 }, uBias: { value: 0 }, uInv: { value: 0.82 },
      uUp: { value: 3.3 }, uDown: { value: 7.5 }, uReset: { value: 1 }, uLock: { value: 0 }, uLockEv: { value: 0 },
      uEvMin: { value: -1.2 }, uEvMax: { value: 1.3 }, uHdr: { value: 0 }, uLumScale: { value: 1 }, uF16: { value: 0 },
      uHl: { value: new THREE.Vector4(3, 0, 0.04, 1) },
    });
    this.bloomH = pass(BLOOM_FS, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.bloomV = pass(BLOOM_FS, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.final = pass(FINAL_FS, {
      tSrc: { value: null }, tBloom: { value: null }, tExp: { value: null }, uScale: { value: new THREE.Vector2(1, 1) },
      uSrcPx: { value: new THREE.Vector2(1, 1) }, ...lensU(), uRc: { value: 1 }, uCA: { value: 0.01 }, uVig: { value: 0.5 }, uSharp: { value: 0.5 },
      uGrain: { value: 0.04 }, uGrainEv: { value: new THREE.Vector2(0, 0.9) }, uGrainPx: { value: 1 }, uSat: { value: 1.2 }, uShSat: { value: 1 },
      uInv: { value: 0.82 }, uBloom: { value: 0.5 }, uBloomOut: { value: 0 }, uExpo: { value: 1 }, uWhite: { value: 1 }, uToe: { value: 0 },
      uCon: { value: 1 }, uVeil: { value: 0 }, uSel: { value: new THREE.Vector2() }, uSkyBoost: { value: 0 },
      uSkyK: { value: new THREE.Vector2(-0.227, 0.10) }, uFrame: { value: 0 }, uLetter: { value: 0 },
      uWB: { value: new THREE.Vector3(1, 1, 1) }, uWBShade: { value: new THREE.Vector3(1, 1, 1) }, uLift: { value: 0 }, uHdr: { value: 0 },
      uRecon: { value: 0 }, uChroma: { value: 0 }, uSharpPx: { value: 1 }, uPinEv: { value: new THREE.Vector2(0.5, 1.5) }, uPinK: { value: new THREE.Vector2() },
    });
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.exp = [rt(1, 1, { filter: THREE.NearestFilter }), rt(1, 1, { filter: THREE.NearestFilter })];
    this.expIdx = 0;
    this.outW = 1; this.outH = 1;
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._jph = [0, 0, 0]; this._jJ = [0, 0, 0]; this._jW = [0, 0, 0]; this._jA = [0, 0, 0];
    this._j2ph = [0, 0, 0]; this._j2W = [0, 0, 0]; this._j2A = [0, 0, 0];
    this._inv = [];
    this._msaaReq = -1;
    this._fresh = new Set();     // scene targets whose mip chain hasn't been built yet
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
    this.minScale = min; this.maxScale = max; this.scale = Math.min(Math.max(this.scale, min), max); this.allocScale = max; this._realloc = 0;
    if (this.outW > 2) this._allocScene();
  }

  // MSAA sample count the scene target can use for this format (0 when RGBA16F multisampling isn't supported)
  _msaaFor(type) {
    const want = this.look.msaa | 0;
    if (want < 2 || !this.hdr || !this.r) return 0;      // splats are soft blended gaussians: no geometric edges to resolve
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

  // scene / blur / collider-depth / AO targets: sized to the largest viewport the governor may use (out x maxScale)
  _allocScene() {
    // sized to the governor's ceiling (perf #3): a throttled phone stops clearing/storing the 1.2x targets it can't use
    const cap = Math.max(0.3, Math.min(this.maxScale, this.allocScale || this.maxScale));
    const cw = Math.ceil(this.outW * cap), ch = Math.ceil(this.outH * cap);
    const type = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this._msaaReq = this.look.msaa | 0;
    const samples = this._msaaFor(type);
    const c = this.colorRT;
    if (c && c.width === cw && c.height === ch && c.texture.type === type && c.samples === samples) return;
    for (const t of [this.colorRT, this.colorRT1, this.blurRT, this.depthRT, this.aoRT, this.aoRT2]) t?.dispose();
    this.colorRT = rt(cw, ch, { mips: true, type, depth: true, samples });
    this.colorRT.resolveDepthBuffer = false;    // the resolve only needs colour
    if (samples > 0 && this.r?.initRenderTarget) { const r = this.r, gl = r.getContext(), p = (r.initRenderTarget(this.colorRT), r.properties.get(this.colorRT)); if (p.__webglDepthbuffer && !Array.isArray(p.__webglFramebuffer)) { r.state.bindFramebuffer(gl.FRAMEBUFFER, p.__webglFramebuffer); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null); r.state.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteRenderbuffer(p.__webglDepthbuffer); p.__webglDepthbuffer = undefined; } }   // [P5] perf #4: drop the resolve target's single-sample depth (three allocates it; never written or read with resolveDepthBuffer false; ~6 MB)
    // hard smears (blurScale < 0.9) hide edges anyway: draw those frames without MSAA (~2 ms of sample store + resolve)
    this.colorRT1 = samples > 0 ? rt(cw, ch, { mips: true, type, depth: true }) : null;
    this.blurRT = rt(cw, ch, { type });
    const dw = Math.ceil(cw / 2), dh = Math.ceil(ch / 2);
    this.depthRT = rt(dw, dh, { filter: THREE.NearestFilter, depth: true });
    this.aoRT = rt(dw, dh, { filter: THREE.NearestFilter });                         // ao + packed depth, for the bilateral pass
    this.aoRT2 = rt(dw, dh, { format: THREE.RedFormat });                             // what the scene samples (bilinear)
    // motion-blur tiles: ~1/21 of the frame height (16 px at 336), so 5x5 neighbours reach ~2.5 tiles of smear
    this.tilePx = 2 * Math.max(8, Math.min(32, Math.round(ch / 42)));
    for (const t of [this.tileRT, this.nbrRT]) t?.dispose();
    const tw = Math.ceil(cw / this.tilePx), th = Math.ceil(ch / this.tilePx), tt = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.tileRT = rt(tw, th, { filter: THREE.NearestFilter, type: tt }); this.nbrRT = rt(tw, th, { filter: THREE.NearestFilter, type: tt });
    this.samples = samples;
    this._fresh.clear(); this._fresh.add(this.colorRT); if (this.colorRT1) this._fresh.add(this.colorRT1);
    this._noMS = false;
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

  computeLens() {
    const L = this.lens = solveLens(this.look.lens, this.outW, this.outH);
    this.cam.fov = 2 * Math.atan(L.ty) * 180 / Math.PI;
    this.cam.aspect = L.tx / L.ty;
    this.cam.updateProjectionMatrix();
    this.centerRatio = (1 / L.ty) / (L.F / L.hh);
  }

  // Lens mask geometry (render NDC): ring between the lens footprint pushed out by `margin` px and far outside the frame.
  _updateMask(vw, vh, margin) {
    const L = this.lens, key = `${vw}|${vh}|${Math.round(margin)}|${L.F}|${L.k}|${L.tx}|${L.hw}`;
    if (key === this._maskKey) return;
    this._maskKey = key;
    const pos = this.lensMask.geometry.attributes.position, a = pos.array, N = MASK_N;
    for (let i = 0; i < N; i++) {
      // walk the output frame's perimeter
      const t = i / N * 4, side = Math.floor(t), f = t - side;
      const u = side === 0 ? f : side === 1 ? 1 : side === 2 ? 1 - f : 0, v = side === 0 ? 0 : side === 1 ? f : side === 2 ? 1 : 1 - f;
      const lx = (u - 0.5) * 2 * L.hw, ly = (v - 0.5) * 2 * L.hh, rr = Math.hypot(lx, ly);
      const th = L.k > 0.999 ? Math.atan(rr / L.F) : Math.atan(rr * L.k / L.F) / L.k;
      const g = rr > 1e-5 ? Math.tan(th) / rr : 1 / L.F;
      let px = lx * g / L.tx * vw / 2, py = ly * g / L.ty * vh / 2;   // render px from the centre
      const d = Math.hypot(px, py) || 1, sc = (d + margin) / d;
      px *= sc; py *= sc;
      a[6 * i] = px / (vw / 2); a[6 * i + 1] = py / (vh / 2); a[6 * i + 2] = 0;
      a[6 * i + 3] = 4 * px / (vw / 2); a[6 * i + 4] = 4 * py / (vh / 2); a[6 * i + 5] = 0;
    }
    pos.needsUpdate = true;
  }

  // Compile every program now (behind the loader) instead of on the first flying frames (perf #2): the post passes, the
  // collider/depthScene depth programs (keyed on rendering into a target), every texture uploaded (initTexture), and,
  // given a pose, one full frame with a forced shadow update so the shadow-depth programs and MSAA paths exist too.
  warmup(world, pose) {
    const r = this.r; if (!r) return;
    const prev = r.getRenderTarget();
    try {
      for (const p of [this.blur, this.tile, this.nbr, this.ssao, this.aoBlur, this.down, this.meter, this.bloomH, this.final]) r.compile(p.scene, this.quadCam);
      if (!this._warmScene) {
        this._warmScene = new THREE.Scene();
        for (const m of [this.depthMat, this.sentinel.material, this.lensMask.material]) { const o = new THREE.Mesh(TRI, m); o.frustumCulled = false; this._warmScene.add(o); }
      }
      if (this.depthRT) r.setRenderTarget(this.depthRT);     // the depth program's key depends on rendering into a target
      r.compile(this._warmScene, this.cam);
      const ds = world && (world.depthScene ?? world.scene?.userData?.depthScene);
      if (ds?.isScene) r.compile(ds, this.cam);
      if (world?.scene) {
        const seen = new Set();
        const up = (v) => { if (v?.isTexture && !seen.has(v)) { seen.add(v); try { r.initTexture(v); } catch (e) {} } };
        world.scene.traverse((o) => {
          for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
            for (const k in m) up(m[k]);
            if (m.uniforms) for (const k in m.uniforms) up(m.uniforms[k]?.value);
          }
        });
        this.texturesWarmed = seen.size;
      }
    } catch (e) { console.warn('fpv warmup', e); }
    finally { r.setRenderTarget(prev); }
    if (world && pose && this.colorRT) {
      try {
        r.shadowMap.needsUpdate = true;
        const z = new THREE.Vector3();
        this.render(world, pose, { vel: z, ang: z, vib: 0 }, 1 / 60);
        this.resetExposure = true; this.settleN = Math.max(this.settleN, 60);
      } catch (e) { console.warn('fpv warmup frame', e); }
    }
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
      // capped for 60 s at <= ceilLock*0.97: shrink the targets once that is worth a realloc (>8%)
      const want = this.ceilLock * 0.97;
      if (want < (this.allocScale || this.maxScale) * 0.92) this._realloc = want;
    }
    this.capT = Math.max(0, this.capT - ms);
    if (this.fastT > 2500) {
      const ceil = this.capT > 0 ? this.ceilLock * 0.97 : this.maxScale;
      this.scale = Math.min(this.maxScale, Math.max(this.scale, Math.min(ceil, this.scale * 1.02))); this.fastT = 0;
      // climbing past the shrunk targets: grow them back to the full ceiling (scale is clamped to them until then)
      const al = this.allocScale || this.maxScale;
      if (this.scale > al * 0.999 && al < this.maxScale) { this.scale = al; this._realloc = this.capT > 0 ? Math.min(this.maxScale, this.ceilLock) : this.maxScale; }
    }
  }

  // Tell a tile-based GPU these attachments are dead so it never writes them back to memory.
  // Only effective while the target's pass is still open (no resolve, mips or other target since its last draw).
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

  // world: { scene|splatScene, colliderScene|null, depthScene? (C2), aoUniforms? (C3) }
  // pose: { pos, quat } of the camera actually displayed
  // motion: { vel (world m/s), ang (world rad/s), vib, hz, wash? 0-1, bump? 0-1 (C4) } of the physical camera during exposure
  render(world, pose, motion, dt) {
    const r = this.r, lk = this.look;
    this.frame++; this.time += dt;
    if (this._realloc > 0) { this.allocScale = this._realloc; this._realloc = 0; this._allocScene(); }
    if ((lk.msaa | 0) !== this._msaaReq) this._allocScene();
    if (this.resetExposure) this.settleN = Math.max(this.settleN, 60);
    const cam = this.cam;
    cam.position.copy(pose.pos); cam.quaternion.copy(pose.quat); cam.updateMatrixWorld(true);
    const meshWorld = !!world.scene;

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

    // scene target: MSAA, except while a hard smear hides the edges (hysteresis so it doesn't flicker between them)
    if (this.colorRT1) {
      if (this._noMS) { if (this.blurScale > MSAA_ON_ABOVE) this._noMS = false; }
      else if (this.blurScale < MSAA_OFF_BELOW) this._noMS = true;
    } else this._noMS = false;
    const sceneRT = this._noMS ? this.colorRT1 : this.colorRT;
    this.sceneRT = sceneRT; this.msaaActive = sceneRT.samples > 0;

    // Mips are only needed once blur taps get capped (spacing > 1.6 px). Bound this frame's longest smear on the CPU
    // (pitch+yaw and roll at the frame corner, translation at 0.15 m) and skip the chain on calm frames.
    const rc = Math.hypot(L.tx, L.ty);
    const fpxMax = Math.max((vw / 2) / L.tx, (vh / 2) / L.ty);
    const smear = lk.shutter * fpxMax * ((Math.abs(aView.x) + Math.abs(aView.y)) * (1 + rc * rc) + Math.abs(aView.z) * rc + vView.length() * (1 + rc) / 0.15);
    const needMips = this._fresh.has(sceneRT) || smear > 1.25 * lk.maxSamples;
    this._fresh.delete(sceneRT);
    sceneRT.texture.generateMipmaps = needMips;
    const P = cam.projectionMatrix.elements;

    // 1) depth from the physics collider (cheap: ~100k tris, half res, flat shader) + world.depthScene (near grass,
    //    leaves: contract C2, packed like depthMat). First, so the SSAO is ready for the scene's indirect light.
    const dw = Math.max(16, Math.round(vw / 2)), dh = Math.max(9, Math.round(vh / 2));
    this.depthRT.viewport.set(0, 0, dw, dh);
    r.setRenderTarget(this.depthRT);
    r.setClearColor(0xffff00, 1); r.clear(true, true, false);
    if (world.colliderScene) {
      world.colliderScene.overrideMaterial = this.depthMat;
      r.render(world.colliderScene, cam);
    }
    const dScene = meshWorld ? (world.depthScene ?? world.scene.userData?.depthScene) : null;
    if (dScene?.isScene) r.render(dScene, cam);
    this._discard(this.depthRT, false);
    r.setClearColor(0x000000, 1);              // post passes: full clears so nothing is loaded from memory

    // 2) SSAO (half res) -> world.aoUniforms (contract C3): the scene samples texture(uAO, gl_FragCoord.xy * uAOScale)
    const aoU = meshWorld ? (world.aoUniforms ?? world.scene.userData?.aoUniforms) : null;
    const aoOn = !!(aoU && aoU.uAO && this.hdr && world.colliderScene && lk.ssao > 0);
    if (aoOn) {
      const su = this.ssao.u;
      su.tDepth.value = this.depthRT.texture; su.uDVp.value.set(dw, dh); su.uProj.value.set(P[0], P[5]);
      su.uR.value = lk.aoRadius || 0.5; su.uMaxPx.value = Math.max(6, dh * 0.07); su.uStrength.value = lk.aoStrength ?? 2.5;
      this.aoRT.viewport.set(0, 0, dw, dh);
      r.setRenderTarget(this.aoRT); r.clear(true, false, false); r.render(this.ssao.scene, this.quadCam);
      const au = this.aoBlur.u;
      au.tAO.value = this.aoRT.texture; au.uDVp.value.set(dw, dh);
      // one extra column/row (edge-replicated) so bilinear lookups at the viewport edge never read stale texels
      this.aoRT2.viewport.set(0, 0, Math.min(dw + 1, this.aoRT2.width), Math.min(dh + 1, this.aoRT2.height));
      r.setRenderTarget(this.aoRT2); r.clear(true, false, false); r.render(this.aoBlur.scene, this.quadCam);
      aoU.uAO.value = this.aoRT2.texture;
      if (aoU.uAOOn) aoU.uAOOn.value = 1;
      if (aoU.uAOScale) { if (!aoU.uAOScale.value?.isVector2) aoU.uAOScale.value = new THREE.Vector2(); aoU.uAOScale.value.set(dw / vw / this.aoRT2.width, dh / vh / this.aoRT2.height); }
    } else if (aoU?.uAOOn) aoU.uAOOn.value = 0;
    this.aoOn = aoOn;

    // 3) scene (MSAA where supported; three resolves + builds mips at the end of render())
    sceneRT.viewport.set(0, 0, vw, vh);
    r.setRenderTarget(sceneRT);
    if (meshWorld) {
      // three clears after its shadow pass (autoClear), so a shadow-map update can't split the scene pass into
      // clear -> store -> reload (52 MB on MSAA). The sentinel drops depth before the pass closes. While drawing,
      // the target's size reads as the viewport: three's MSAA resolve blits width x height, i.e. only what was drawn.
      const sc = world.scene, ac = r.autoClear, acc = r.autoClearColor, acd = r.autoClearDepth, acs = r.autoClearStencil;
      const W0 = sceneRT.width, H0 = sceneRT.height;
      sc.add(this.sentinel);
      // lens mask: inset from the displayed footprint by this frame's blur reach (taps never land in the masked area)
      // reach bound: rotation exact, translation for surfaces >= lk.maskNear m (closer ones are near the frame centre in
      // practice); a frame that would need more than 1/5 of the view skips the mask (it's a calm-frame saving: MSAA frames)
      const reach = lk.shutter * fpxMax * ((Math.abs(aView.x) + Math.abs(aView.y)) * (1 + rc * rc) + Math.abs(aView.z) * rc + vView.length() * (1 + rc) / (lk.maskNear || 1));
      const margin = Math.max(lk.maxSamples * 1.6, reach + 4);
      const useMask = !!lk.lensMask && margin < 0.2 * Math.min(vw, vh);
      if (useMask) { this._updateMask(vw, vh, margin); sc.add(this.lensMask); }
      this.maskOn = useMask;
      r.autoClear = true; r.autoClearColor = true; r.autoClearDepth = true; r.autoClearStencil = false;
      if (sceneRT.samples > 0) { sceneRT.width = vw; sceneRT.height = vh; }
      try { r.render(sc, cam); }
      finally {
        sceneRT.width = W0; sceneRT.height = H0;
        r.autoClear = ac; r.autoClearColor = acc; r.autoClearDepth = acd; r.autoClearStencil = acs;
        sc.remove(this.sentinel); sc.remove(this.lensMask);
      }
    } else {
      r.clear(true, true, false);
      r.render(world.splatScene, cam);
      this._discard(sceneRT, true);
    }
    r.setClearColor(0x000000, 1);

    // 4) shutter + rolling shutter + jello
    const bu = this.blur.u;
    bu.tColor.value = sceneRT.texture; bu.tDepth.value = this.depthRT.texture;
    bu.uScale.value.set(vw / sceneRT.width, vh / sceneRT.height);
    bu.uDVp.value.set(dw, dh);
    bu.uVp.value.set(vw, vh);
    bu.uProj.value.set(P[0], P[5]);
    bu.uVel.value.copy(vView); bu.uAng.value.copy(aView);
    bu.uExp.value = lk.shutter; bu.uRO.value = lk.readout;
    // prop jello: phase integrated on the CPU (seamless for any time-varying motion.hz, no fp32 drift with play time);
    // amplitude averaged over the exposure, so an ND shutter washes it out the way a real one does
    let hz = +(motion.hz ?? lk.jelloFreq ?? 170);
    if (!Number.isFinite(hz)) hz = 170;
    hz = Math.min(1000, Math.max(10, hz));
    const tdt = Math.min(dt, 0.1);
    const ja = lk.jelloAmp * (motion.vib ?? 1), ph = this._jph, J = this._jJ, W = this._jW, A = this._jA;
    for (let i = 0; i < 3; i++) {
      W[i] = TAU * hz * JELLO_RATIO[i];
      ph[i] = (ph[i] + W[i] * tdt) % TAU;
      A[i] = ja * JELLO_AXIS[i] * sinc(W[i] * lk.shutter * 0.5);
      J[i] = A[i] * Math.sin(ph[i]);
    }
    bu.uJelloAmp.value.fromArray(A); bu.uJelloW.value.fromArray(W); bu.uJelloPh.value.fromArray(ph); bu.uJello0.value.fromArray(J);
    // 45 Hz band (contract C4): prop wash and bumps shake the whole frame; the 1/60 s exposure keeps ~30% of it at 45 Hz,
    // and the readout bends it across rows (~4-5 px wobble at full wash)
    const wash = clamp01(+motion.wash || 0), bump = clamp01(+motion.bump || 0);
    const ja2 = (lk.jello2Wash ?? 0.012) * wash + (lk.jello2Bump ?? 0.004) * bump, hz2 = lk.jello2Hz || 45;
    const ph2 = this._j2ph, W2 = this._j2W, A2 = this._j2A;
    for (let i = 0; i < 3; i++) {
      W2[i] = TAU * hz2 * JELLO2_RATIO[i];
      ph2[i] = (ph2[i] + W2[i] * tdt) % TAU;
      A2[i] = ja2 * JELLO2_AXIS[i] * sinc(W2[i] * lk.shutter * 0.5);
    }
    bu.uJ2Amp.value.fromArray(A2); bu.uJ2W.value.fromArray(W2); bu.uJ2Ph.value.fromArray(ph2);
    bu.uFrame.value = this.frame % 64; bu.uMaxS.value = lk.maxSamples; bu.uLodMax.value = needMips ? 4 : 0;
    // reconstruction at silhouettes (art #2): TileMax -> NeighborMax -> gather. Half-float tiles only (HDR worlds).
    const recon = !!(lk.mbRecon && this.hdr && world.colliderScene) && lk.shutter > 0;
    bu.uRecon.value = recon ? 1 : 0; bu.uTile.value = this.tilePx;
    if (recon) {
      const tw = Math.ceil(vw / this.tilePx), th = Math.ceil(vh / this.tilePx);
      this.tile.u.tDepth.value = this.depthRT.texture;
      this.tileRT.viewport.set(0, 0, tw, th);
      r.setRenderTarget(this.tileRT); r.clear(true, false, false); r.render(this.tile.scene, this.quadCam);
      this.nbr.u.tTile.value = this.tileRT.texture; this.nbr.u.uTVp.value.set(tw, th); this.nbr.u.uR.value = Math.min(3, Math.max(1, lk.mbNbr ?? 2));
      this.nbrRT.viewport.set(0, 0, tw, th);
      r.setRenderTarget(this.nbrRT); r.clear(true, false, false); r.render(this.nbr.scene, this.quadCam);
      bu.tNbr.value = this.nbrRT.texture;
    } else bu.tNbr.value = this.tileRT.texture;
    this.blurRT.viewport.set(0, 0, vw, vh);
    r.setRenderTarget(this.blurRT); r.clear(true, false, false); r.render(this.blur.scene, this.quadCam);

    // 5) downsample (metering luma + bloom bright-pass), taps mapped through the lens: the meter and the halos see the
    //    displayed frame (output space), not the rectilinear render's corners and edge margins
    const prevExp = this.exp[this.expIdx], nextExp = this.exp[1 - this.expIdx];
    const H = this.hdr ? 1 : 0, LS = this.hdr ? 16 : 1, F16 = this.f16 ? 1 : 0, LM = lk.meterLens ? 1 : 0;
    const du = this.down.u;
    du.tSrc.value = this.blurRT.texture; du.tExp.value = prevExp.texture;
    du.uScale.value.set(vw / this.blurRT.width, vh / this.blurRT.height);
    du.uTexel.value.set(1 / this.smallRT.width, 1 / this.smallRT.height);
    du.uClampLo.value.set(0.5 / vw, 0.5 / vh);
    du.uInv.value = lk.invTone; du.uThresh.value = 1.0;
    du.uHdr.value = H; du.uLumScale.value = LS; du.uF16.value = F16; du.uLens.value = LM; du.uBloomCap.value = lk.bloomCap ?? 16;
    du.uWB.value.fromArray(lk.wb); du.uWBShade.value.fromArray(lk.wbShade || lk.wb);
    du.uHalf.value.set(L.hw, L.hh); du.uF.value = L.F; du.uK.value = L.k; du.uSrcTan.value.set(L.tx, L.ty);
    r.setRenderTarget(this.smallRT); r.clear(true, false, false); r.render(this.down.scene, this.quadCam);

    // 6) auto-exposure with lag (GPU-side, no readback stalls)
    const mu = this.meter.u;
    mu.tSmall.value = this.smallRT.texture; mu.tPrev.value = prevExp.texture;
    mu.uDt.value = tdt; mu.uBias.value = lk.evBias; mu.uInv.value = lk.invTone;
    mu.uHdr.value = H; mu.uLumScale.value = LS; mu.uF16.value = F16; this.final.u.uHdr.value = H;
    mu.uEvMin.value = lk.evMin; mu.uEvMax.value = lk.evMax; mu.uUp.value = lk.aeUp; mu.uDown.value = lk.aeDown;
    mu.uReset.value = this.resetExposure ? 1 : 0; this.resetExposure = false;
    mu.uHl.value.set(Number.isFinite(lk.hlEv) ? lk.hlEv : (Number.isFinite(lk.clipEv) ? lk.clipEv / (lk.con || 1) : 3), lk.hlGain || 0, lk.hlFrac || 0.04, lk.hlMax ?? 1);
    r.setRenderTarget(nextExp); r.clear(true, false, false); r.render(this.meter.scene, this.quadCam);
    this.expIdx = 1 - this.expIdx;

    // 7) bloom: separable 9-tap gaussian at unit tap spacing (the linear-sampling offsets assume it), run twice
    const bw = this.smallRT.width, bh = this.smallRT.height;
    let src = this.smallRT;
    for (let it = 0; it < 2; it++) {
      this.bloomH.u.tSrc.value = src.texture; this.bloomH.u.uDir.value.set(1 / bw, 0);
      r.setRenderTarget(this.bloomA); r.clear(true, false, false); r.render(this.bloomH.scene, this.quadCam);
      this.bloomV.u.tSrc.value = this.bloomA.texture; this.bloomV.u.uDir.value.set(0, 1 / bh);
      r.setRenderTarget(this.bloomB); r.clear(true, false, false); r.render(this.bloomV.scene, this.quadCam);
      src = this.bloomB;
    }

    // 8) lens + colour science + sensor -> screen
    const fu = this.final.u;
    fu.tSrc.value = this.blurRT.texture; fu.tBloom.value = this.bloomB.texture; fu.tExp.value = nextExp.texture;
    fu.uScale.value.set(vw / this.blurRT.width, vh / this.blurRT.height);
    fu.uSrcPx.value.set(vw, vh);
    fu.uHalf.value.set(L.hw, L.hh); fu.uF.value = L.F; fu.uK.value = L.k; fu.uSrcTan.value.set(L.tx, L.ty); fu.uRc.value = L.rc;
    fu.uCA.value = lk.lens.ca; fu.uVig.value = lk.vignette;
    fu.uSharp.value = lk.sharpen * Math.min(1.25, 1.0 / Math.max(0.55, Math.sqrt(sx * sy)));
    fu.uGrain.value = lk.grain; fu.uGrainEv.value.fromArray(lk.grainEv || [0, 0.9]); fu.uGrainPx.value = Math.max(1, lk.grainPx || 1);
    fu.uSat.value = lk.saturation; fu.uShSat.value = lk.shadowSat ?? 1; fu.uInv.value = lk.invTone;
    fu.uBloom.value = lk.bloom * (this.f16 ? 1 : 8); fu.uBloomOut.value = LM; fu.uExpo.value = lk.expo;
    const ce = lk.clipEv;
    fu.uWhite.value = Number.isFinite(ce) ? 1 / (1 - Math.exp(-1.25 * 0.24 * lk.expo * Math.pow(2, ce))) : 1;
    fu.uToe.value = lk.toe || 0; fu.uVeil.value = lk.veil || 0; fu.uCon.value = lk.con ?? 1;
    fu.uSel.value.set(lk.skySel || 0, lk.greenSel || 0); fu.uSkyBoost.value = lk.skyBoost || 0;
    fu.uSkyK.value.set(lk.skyRot ?? -0.227, lk.skyDark ?? 0.10);
    fu.uFrame.value = this.frame % 4096;
    fu.uRecon.value = lk.recon || 0; fu.uChroma.value = lk.chromaPx || 0; fu.uSharpPx.value = lk.sharpPx || 1;
    fu.uPinEv.value.fromArray(lk.pinEv || [0.5, 1.5]); fu.uPinK.value.set(lk.pinToe || 0, lk.pinCon || 0);
    fu.uLetter.value = lk.letterbox; fu.uWB.value.fromArray(lk.wb); fu.uWBShade.value.fromArray(lk.wbShade || lk.wb); fu.uLift.value = lk.lift;
    r.setRenderTarget(null);
    r.setViewport(0, 0, this.outW, this.outH);
    r.clear(true, false, false);
    r.render(this.final.scene, this.quadCam);
  }

  // Camera profile as plain JSON (contract C5): every constant and live setting the native port needs to rebuild this
  // camera (tools/camera-profile.mjs -> camera.json). Works headless: pass {w, h} when no renderer has sized us.
  profile({ w, h } = {}) {
    const lk = this.look, W = w || this.outW || 1920, Hh = h || this.outH || 1080;
    const L = solveLens(lk.lens, W, Hh);
    const r6 = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? +v.toPrecision(7) : null) : v);
    const plain = (o) => JSON.parse(JSON.stringify(o, (k, v) => r6(v)));
    const look = {};
    for (const k in lk) { const v = lk[k]; if (k !== 'lens' && (v === null || ['number', 'boolean', 'string'].includes(typeof v) || Array.isArray(v))) look[k] = v; }
    const ce = lk.clipEv;
    return plain({
      schema: 'onetake.camera/1',
      world: this.hdr ? 'hdr' : 'ldr',
      output: { w: W, h: Hh, renderScale: { scale: this.scale, min: this.minScale, max: this.maxScale } },
      pipeline: ['depth(collider+depthScene, half res, log-packed rg8)', 'ssao(8 taps, half res) + 4x4 bilateral', 'scene(HDR half-float, MSAA)',
        'tilemax + neighbormax (nearest depth, reach)', 'shutter blur(analytic, rolling shutter, jello; McGuire-style silhouette reconstruction)', 'downsample 1/8 (lens-mapped taps, WB bright pass)', 'meter(9x7, AE lag)', 'bloom(2x separable 9-tap)',
        'final(lens, CA, sharpen, WB, bloom, vignette, contrast, veil, camCurve+clip, toe, saturation, selective colour, S-curve, lift, grain)'],
      lens: { ...lk.lens, cornerCapRad: 1.16, renderMargin: 1.035, solved: L, mapping: 'theta = atan(r*k/F)/k (k>0.999: atan(r/F)); render = tan(theta)/r', vignette: { amount: lk.vignette, cosPow: 2.2 }, caRadial: 'r_ch = r * (1 +- ca * (r/rc)^2)' },
      shutter: { exposure: lk.shutter, readout: lk.readout, shape: 'box, jittered (IGN)', tapSpacingPx: 1.6, maxSamples: lk.maxSamples, depthEncoding: 'd = clamp(log2(max(z,0.02)/0.02)/12.28771238,0,1) -> (floor(d*255)/255, fract(d*255))' },
      jello: { amp: lk.jelloAmp, hz: lk.jelloFreq, hzSource: 'motion.hz (motor rpm), clamped 10..1000', ratio: JELLO_RATIO, axis: JELLO_AXIS, vibScale: 'motion.vib', relativeToFrameCentre: true,
        band2: { hz: lk.jello2Hz, perWash: lk.jello2Wash, perBump: lk.jello2Bump, ratio: JELLO2_RATIO, axis: JELLO2_AXIS, relativeToFrameCentre: false }, exposureAverage: 'amp * sinc(w * exposure / 2)' },
      exposure: { target: 0.24, evMin: lk.evMin, evMax: lk.evMax, evBias: lk.evBias, aeUp: lk.aeUp, aeDown: lk.aeDown, sensorCapStops: Math.log2(1.4),
        meter: { grid: [9, 7], centre: [0.5, 0.45], scale: [1.6, 2.0], falloff: 1.6, logArithMix: 0.15, space: lk.meterLens ? 'output (lens-mapped)' : 'render' } },
      tone: { camCurveK: 1.25, expo: lk.expo, clipEv: ce, white: Number.isFinite(ce) ? 1 / (1 - Math.exp(-1.25 * 0.24 * lk.expo * Math.pow(2, ce))) : 1,
        toe: lk.toe, con: lk.con, conPivot: 0.24, veil: lk.veil, veilTint: [1, 0.99, 0.97], sCurve: 0.22, lift: lk.lift, invTone: lk.invTone },
      colour: { wb: lk.wb, wbShade: lk.wbShade || lk.wb, wbShadeEv: [1.5, 3.0], saturation: lk.saturation, shadowSat: lk.shadowSat, shadowSatLuma: [0.01, 0.16],
        selective: { sky: lk.skySel, green: lk.greenSel, skyBoost: lk.skyBoost, skyRot: lk.skyRot, skyDark: lk.skyDark, greenRot: -0.209, greenGain: -0.15,
          skyAxis: [0.788, -0.616], skyHue: [0.80, 0.97], skyLuma: [0.35, 0.55], skyChroma: [0.09, 0.15], greenAxis: [-0.819, -0.574], greenHue: [0.70, 0.95], greenChroma: [0.02, 0.05] } },
      bloom: { amount: lk.bloom, threshold: 1.0, cap: lk.bloomCap, resolution: 1 / 8, iterations: 2, kernelWeights: [0.2270270270, 0.3162162162, 0.0702702703], kernelOffsets: [0, 1.3846153846, 3.2307692308], whiteBalanced: true, space: lk.meterLens ? 'output' : 'render' },
      grain: { amount: lk.grain, ev: lk.grainEv, clumpPx: lk.grainPx, chroma: 0.35, model: 'sigma = grain * exp2(max(ev + ev0, 0) * slope) * sqrt(luma + 0.025)', dither: 1 / 255 },
      sharpen: { amount: lk.sharpen, hdrScale: 0.8, kernel: '4-neighbour luma unsharp' },
      ssao: { enabled: lk.ssao, radius: lk.aoRadius, strength: lk.aoStrength, taps: 8, resolution: 0.5, method: 'SAO-style: depth-derived normal, cos term, (1-vv/R^2)^2 falloff, bias 0.1, golden-angle spiral', blur: '4x4 bilateral (1/3 stop)', apply: 'indirect *= mix(1, ao, 0.8) (world shader, contract C3)' },
      msaa: { requested: lk.msaa, samples: this.samples, offBelowBlurScale: MSAA_OFF_BELOW, onAboveBlurScale: MSAA_ON_ABOVE },
      look, grades: GRADES, lenses: LENSES, shutters: SHUTTERS,
    });
  }

  // Dev only (golden frames for the native port): render one deterministic frame (AE converged, fixed noise seed,
  // jello phases zeroed) and read back every stage as floats, rows bottom-up (GL order). Stalls the GPU: never in play.
  renderGolden(world, pose, motion, { frame = 1, dt = 1 / 60, stages = ['depth', 'ao', 'scene', 'blur', 'small', 'exp', 'bloom', 'final'] } = {}) {
    const keep = { frame: this.frame, time: this.time, jph: this._jph.slice(), j2ph: this._j2ph.slice() };
    this.frame = frame - 1; this._jph.fill(0); this._j2ph.fill(0); this.resetExposure = true;
    this.render(world, pose, motion, dt);
    const want = new Set(stages), S = {};
    const vw = this.vw, vh = this.vh, dw = this.depthRT.viewport.z, dh = this.depthRT.viewport.w;
    const rd = (t, w, h) => this._readRT(t, w, h);
    if (want.has('final')) S.final = this._readRT(null, this.outW, this.outH);
    if (want.has('depth')) { const d = rd(this.depthRT, dw, dh); if (d) { const m = new Float32Array(dw * dh); for (let i = 0; i < m.length; i++) m[i] = 0.02 * Math.pow(2, (d.data[i * 4] + d.data[i * 4 + 1] / 255) * 12.28771238); S.depth = { w: dw, h: dh, c: 1, unit: 'm (view z)', data: m }; } }
    if (want.has('ao') && this.aoOn) { const a = rd(this.aoRT2, dw, dh); if (a) { const m = new Float32Array(dw * dh); for (let i = 0; i < m.length; i++) m[i] = a.data[i * 4]; S.ao = { w: dw, h: dh, c: 1, data: m }; } }
    if (want.has('scene')) S.scene = rd(this.sceneRT, vw, vh);
    if (want.has('blur')) S.blur = rd(this.blurRT, vw, vh);
    if (want.has('small')) S.small = rd(this.smallRT, this.smallRT.width, this.smallRT.height);
    if (want.has('exp')) { const e = rd(this.exp[this.expIdx], 1, 1); if (e) S.exp = { ev: -5 + 10 * (e.data[0] + e.data[1] / 255), veilMean: e.data[2] }; }
    if (want.has('bloom')) S.bloom = rd(this.bloomB, this.bloomB.width, this.bloomB.height);
    this.frame = keep.frame; this.time = keep.time; this._jph = keep.jph; this._j2ph = keep.j2ph;
    return { profile: this.profile(), frame, dt, viewport: [vw, vh], msaa: this.msaaActive, stages: S };
  }

  // Dev only: the expanded GLSL of every program three has linked (world materials with all patches + these passes),
  // so the Metal port can match world shading line for line (native #1.5).
  shaderDump() {
    const r = this.r, gl = r?.getContext(); if (!gl) return [];
    return (r.info.programs || []).map((p) => ({ name: p.name, key: p.cacheKey, usedTimes: p.usedTimes,
      vs: p.vertexShader ? gl.getShaderSource(p.vertexShader) : null, fs: p.fragmentShader ? gl.getShaderSource(p.fragmentShader) : null }));
  }

  _readRT(target, w, h) {
    const r = this.r, gl = r.getContext();
    try {
      let fb = null;
      if (target) { fb = r.properties.get(target).__webglFramebuffer; if (Array.isArray(fb)) fb = fb[0]; if (!fb) return null; }
      r.state.bindFramebuffer(gl.FRAMEBUFFER, fb);
      const flt = !!target && (target.texture.type === THREE.HalfFloatType || target.texture.type === THREE.FloatType);
      let data;
      if (flt) { data = new Float32Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, data); }
      else { const u = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, u); data = new Float32Array(u.length); for (let i = 0; i < u.length; i++) data[i] = u[i] / 255; }
      return { w, h, c: 4, data };
    } catch (e) { console.warn('fpv golden read', e); return null; }
    finally { r.state.bindFramebuffer(gl.FRAMEBUFFER, null); r.setRenderTarget(null); }
  }
}
