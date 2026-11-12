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
#ifdef NIGHT
float decodeEv(vec4 c){ return c.r; }      // [S3] night: half-float AE state (r ev, g ev rate, b metered mean, a pin)
#else
float decodeEv(vec4 c){ return mix(-5.0, 5.0, c.r + c.g / 255.0); }
#endif
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
#ifdef NIGHT
uniform sampler2D tVel;   // [P2-A] FPV #6: movers' own motion over the exposure (rg: uv displacement, b: view depth, a: coverage), depth res
uniform float uVelOn;
#endif

vec3 tap(vec2 uv, float lod){
  vec2 h = 0.5 * exp2(lod) / uVp;     // keep the mip footprint inside the live viewport
  return textureLod(tColor, clamp(uv, h, 1.0 - h) * uScale, lod).rgb;
}
#ifdef NIGHT
// [P3-A] contract P3-B1: the scene alpha is 1 + w on true-source cores (B's channel stroke centres, tube axes, bulbs, LEDs);
// w = clamp(a - 1, 0, 1) per tap, carried through the shutter blur as alpha 1 + w for FINAL's white cores
vec4 tap4(vec2 uv, float lod){
  vec2 h = 0.5 * exp2(lod) / uVp;
  vec4 c = textureLod(tColor, clamp(uv, h, 1.0 - h) * uScale, lod);
  // [P4-A] a NaN/Inf texel (main's walk0 and w21 carry 123 and 30 NaN radiance pixels in shop glass) would poison the 1/8 block
  // the meter and the bloom read and spread through every PSF lobe: it reads as black (the compare is false for NaN)
  if (!(abs(c.r) + abs(c.g) + abs(c.b) < 1.0e5)) c = vec4(0.0, 0.0, 0.0, 1.0);
  return vec4(c.rgb, clamp(c.a - 1.0, 0.0, 1.0));
}
#endif
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
#ifdef NIGHT
  if (a.x < -5.0 || b.x < -5.0) { vec4 t0 = tap4(vUv, 0.0); fragColor = vec4(t0.rgb, 1.0 + t0.a); return; }
#else
  if (a.x < -5.0 || b.x < -5.0) { fragColor = vec4(tap(vUv, 0.0), 1.0); return; }
#endif
#ifdef NIGHT
  // [P2-A] object motion blur: on a mover's swept footprint (its geometry extruded along its velocity) in front of the static
  // surface, the smear is the camera's path plus the mover's own displacement (max of camera and object motion, combined)
  // [P4-A] FPV bug (steps on trailing edges): the fastest mover in the 3x3 velocity texels round this one (a max dilation at
  // depth res), so the footprint has no holes where the extruded silhouette splits and its edge isn't a half-res stair
  vec2 vo = vec2(0.0);
  if (uVelOn > 0.5) {
    ivec2 vc = ivec2(vUv * uDVp), vm = ivec2(uDVp) - 1; float vb = -1.0;
    for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
      vec4 vv = texelFetch(tVel, clamp(vc + ivec2(dx, dy), ivec2(0), vm), 0);
      float l2 = dot(vv.rg, vv.rg);
      if (vv.a > 0.5 && vv.b < zX * 1.03 && l2 > vb) { vb = l2; vo = vv.rg; }
    }
    a -= 0.5 * vo; b += 0.5 * vo;
  }
#endif
  float lenPx = length((b - a) * uVp);
  float n = clamp(ceil(lenPx / 1.6), 1.0, uMaxS);
#ifdef NIGHT
  if (dot(vo, vo) > 0.0 && length(vo * uVp) > 2.0) n = max(n, min(12.0, uMaxS));   // [P4-A] movers: >= 12 jittered taps (no stepped copies)
#endif
  float lod = clamp(log2(max(lenPx / n, 1.0) / 1.25), 0.0, uLodMax);   // prefilter: tap footprint ~ sample spacing
  float j = ign(gl_FragCoord.xy + uFrame * 5.588238);
  // 1) own surface along its own (curved, rolling-shutter, jello) path. With the reconstruction on, taps that land on
  //    something nearer than this surface would be at that instant are occluders: they come in through 2), not here.
  vec3 acc = vec3(0.0); float wsum = 0.0;
#ifdef NIGHT
  float accW = 0.0;
#endif
  for (int i = 0; i < 24; i++) {
    if (float(i) >= n) break;
    float fi = (n > 1.0) ? (float(i) + j) / n - 0.5 : 0.0;   // box shutter, jittered
    float ze; vec2 s = warpz(P, tauRow + fi * uExp, J, ze);
#ifdef NIGHT
    if (s.x > -5.0) s += vo * fi;
#endif
    float w = 1.0;
    if (s.x < -5.0) s = vUv;
    else if (uRecon > 0.5 && n > 1.0) w = 1.0 - nearer(ze, zAt(s));
#ifdef NIGHT
    vec4 t4 = tap4(s, lod); acc += t4.rgb * w; accW += t4.a * w; wsum += w;
#else
    acc += tap(s, lod) * w; wsum += w;
#endif
  }
  vec3 cs = wsum > 1e-3 ? acc / wsum : tap(vUv, 0.0);
#ifdef NIGHT
  float cw = wsum > 1e-3 ? accW / wsum : tap4(vUv, 0.0).a;
#endif
  // 2) foreground smeared over this pixel (McGuire 2012, scatter-as-gather): walk the neighbourhood's longest blur;
  //    a nearer surface Y covers X if X lies on Y's own smear, each tap carrying spacing / Y's smear length of coverage
  if (uRecon > 0.5) {
    vec4 nb = texelFetch(tNbr, ivec2(gl_FragCoord.xy / uTile), 0);
    if (nb.b > 0.75 && log2(zX / nb.a) > 0.07) {
      vec2 X = vUv * uVp;
      float R = nb.b, m = clamp(ceil(2.0 * R / 2.5), 4.0, 12.0), dl = 2.0 * R / m;
      float lf = clamp(log2(max(dl, 1.0) / 1.25), 0.0, uLodMax);
      float cov = 0.0; vec3 fg = vec3(0.0); float fw = 0.0;
#ifdef NIGHT
      float fgW = 0.0;
#endif
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
#ifdef NIGHT
        vec4 f4 = tap4(uy, lf); cov += w; fg += f4.rgb * w; fgW += f4.a * w; fw += w;
#else
        cov += w; fg += tap(uy, lf) * w; fw += w;
#endif
      }
      if (fw > 1e-4) cs = mix(cs, fg / fw, min(cov, 1.0));
#ifdef NIGHT
      if (fw > 1e-4) cw = mix(cw, fgW / fw, min(cov, 1.0));
#endif
    }
  }
#ifdef NIGHT
  fragColor = vec4(cs, 1.0 + cw);
#else
  fragColor = vec4(cs, 1.0);
#endif
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

// [S3] Night camera (GRADES.night, plan-L5 2A-2E + plan-G5 2E-2F). Compiled only into the night variants of DOWN/FINAL (RawShaderMaterial
// defines {NIGHT: 1}) and the night meter: with the night preset off, the bando programs are the exact same GLSL as before.
const NIGHT_FINAL_HEAD = /* glsl */`
uniform sampler2D tHalo;  // wide halation, 1/16 res, from the bloom chain
uniform float uHalo;
uniform vec3 uHaloTint;   // red-orange bias, luma 1
uniform vec3 uNightK;     // x: exposed level that clips, y: white-core amount, z: Oklab L of the AE target after the curve
uniform float uRetro;     // retrowave grade, 0 = pure camera
uniform float uRetroVib;  // neon vibrance at uRetro 1
uniform float uRetroCA;   // extra lateral CA (already x uRetro)
uniform vec3 uNoise;      // x: shot sigma at mid-grey, y: read sigma (linear, both at full analog gain), z: chroma share
uniform vec3 uNoiseRGB;   // chroma noise per channel (blue noisiest)
uniform vec2 uNoiseEv;    // x: EV where base ISO ends, y: analog gain stops available
// [P2-A] night camera v2 (panel 1: colour #1/#3/#4/#6, graphics #1, FPV #2/#3)
uniform vec4 uTone;       // filmic shoulder (Lottes 2016) per channel: x contrast a, y shoulder d, z b, w c; reaches 1 at the white point uNightK.x
uniform float uTonePc;    // per-channel share of the shoulder (the rest is hue-preserving on max(rgb)): the path to white
uniform vec3 uCore;       // white cores: x sensor crosstalk (share of the max channel in the min), y..z EV over the white point where cores ramp in
uniform vec2 uMag;        // retro magenta roll-off: x amount (x uRetro), y Oklab chroma gate (neutral highlights stay neutral)
uniform vec4 uMagEv;      // [P4-A] its window: EV over the AE target where it ramps in (x..y) and out (z..w)
uniform sampler2D tSmall; // 1/8 lens-mapped frame (a: block-mean radiance): codec blocks
uniform vec4 uCodec;      // x flatten amount, y..z exposed block level where it fades out, w share of the luma grain it removes
uniform vec2 uSharpDark;  // exposed level where in-camera sharpening fades in (none in the shadows: no crunch on the noise)
uniform sampler2D tNoise; // 256^2 gaussian noise (r luma, gb chroma), repeat + bilinear: jittered grain, no grid
uniform vec4 uNoiseOff;   // luma lattice offsets (px): xy this frame, zw last frame (3DNR: half of the grain carries over)
uniform vec4 uNoiseOffC;  // chroma lattice offsets (px)
uniform vec4 uNoiseK;     // x luma cell (px), y chroma cell (px), z read floor (linear, gain-independent), w chroma kept in the deepest shadows
uniform vec4 uGhostS;     // lens ghosts: w on (the ghost pass renders them, aperture-shaped, into tGhost)
uniform sampler2D tGhost; // [P3-A] ghosts of the point sources, 1/8 res, output space (GHOST_FS)
uniform vec2 uCoreSrc;    // [P3-A] true sources: radiance floor (max channel, scene units) under B's P3-B1 core flag w (scene alpha 1 + w)
uniform vec2 uCoreW;      // [P3-A] P3-B1 flag ramp (B's stroke-centre w peaks ~0.5 once resolved)
uniform vec3 uCoreSrcK;   // [P3-A] the source path's x crosstalk, y..z EV over the white point where its cores ramp in
uniform vec2 uRetroSh;    // [P3-A] retro shadow split-tone: x Oklab hue (rad), y chroma at uRetro 1
uniform vec2 uVibGate;    // [P3-A] Oklab hue band (rad) the retro vibrance leaves alone (amber rooms)
uniform sampler2D tHaloM; // [P4-A] the PSF's middle lobe, 1/8 res: source-tinted halation 15-60 px out (colour #4, lighting #4)
uniform float uHaloM;     // [P4-A] its energy share of the bright pass (0 = off)
uniform vec3 uHaloMTint;  // [P4-A] its tint, luma 1 (neutral: the glow takes the source's colour)
uniform sampler2D tHaloW; // [P5-A] the PSF's second wide lobe, 1/16 res, source-tinted: the glow's skirt 80-150 px out (colour #5)
uniform float uHaloW;     // [P5-A] its energy share of the bright pass (0 = off)
uniform vec2 uRetroShG;   // [P6-A] split-tone gate: absolute Oklab L where it fades in (x..y): the ground and the deep darks stay untinted
uniform sampler2D tDepthN;// [P6-A] the collider depth (half res, packed as depthMat; cleared to 1 = sky / beyond 100 m)
uniform vec3 uDepthN;     // [P6-A] xy: source uv -> depth texture uv, z: 1 = no split-tone on the sky
uniform sampler2D tAir;   // [P7-A] canyon airlight, 1/8 res, output space, exposed (AIR_FS)
uniform vec3 uAirF;       // [P7-A] x: on, y: the exposed sky luma the airlight fills a dark slot up to (none over it); [P8-A] z: the cap
uniform vec4 uHaloE;      // [P8-A] zw: ring share and radius (1/8 texels); [P7-A] the PSF's edge lobe: x share of the 1/8 block radiance (all of it, no bright-pass threshold), y its
                          // exposed cap; unblurred (8 px box + bilinear: sigma ~5-6 px at 1280 wide)
vec3 nightTone(vec3 e){
  vec3 x = max(e, 0.0);
  vec3 pc = pow(x, vec3(uTone.x)) / (pow(x, vec3(uTone.x * uTone.y)) * uTone.z + uTone.w);
  float m = max(max(x.r, max(x.g, x.b)), 1e-8);
  float fm = pow(m, uTone.x) / (pow(m, uTone.x * uTone.y) * uTone.z + uTone.w);
  return mix(x * (min(fm, 1.0) / m), min(pc, 1.0), uTonePc);
}
float cbrt1(float x){ return sign(x) * pow(abs(x), 1.0 / 3.0); }
vec3 okLab(vec3 c){
  float l = cbrt1(dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)));
  float m = cbrt1(dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)));
  float s = cbrt1(dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
  return vec3(dot(vec3(l, m, s), vec3(0.2104542553, 0.7936177850, -0.0040720468)),
              dot(vec3(l, m, s), vec3(1.9779984951, -2.4285922050, 0.4505937099)),
              dot(vec3(l, m, s), vec3(0.0259040371, 0.7827717662, -0.8086757660)));
}
vec3 okLabInv(vec3 q){
  float l = q.x + 0.3963377774 * q.y + 0.2158037573 * q.z;
  float m = q.x - 0.1055613458 * q.y - 0.0638541728 * q.z;
  float s = q.x - 0.0894841775 * q.y - 1.2914855480 * q.z;
  vec3 c = vec3(l * l * l, m * m * m, s * s * s);
  return vec3(dot(c, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
              dot(c, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
              dot(c, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
}
`;
const NIGHT_FINAL_BODY = /* glsl */`
  // white cores: far past the clip the sensor's other channels saturate too (plus demosaic / highlight recovery), so a red LED
  // face goes pink-white and its colour survives only in the halo (plan-L5 2B: the single most important night cue)
  // [P2-A] keyed on the MIN channel (+ sensor crosstalk), not the max: a red letter 2 EV over the white point keeps its red
  // (its G and B are stops under); a narrowband neon tube whitens only when even its weakest channel saturates (colour #1)
  // [P3-A] colour #3 / FPV #5: true sources (tube and channel-letter cores, bulbs, lamps: >= 600 white-equivalent nits, against
  // faces <= 350) take a second path: more crosstalk (uCoreSrcK.x) and a ramp 2 EV earlier, so they bleach to white cores with
  // coloured rims at the exposures the street runs at; light boxes, screens and windows keep the colour path above
  {
    // [P3-A] contract P3-B1: the source path needs B's core flag w (blur alpha 1 + w) AND real radiance under it (additive
    // sprites raise the alpha too, and a sub-pixel tube averaged to a few hundred nits doesn't clip in a real sensor either)
    float wSrc = clamp(texture(tSrc, clamp(sG, 0.5 / uSrcPx, 1.0 - 0.5 / uSrcPx) * uScale).a - 1.0, 0.0, 1.0);
    float sw = smoothstep(uCoreW.x, uCoreW.y, wSrc) * smoothstep(uCoreSrc.x, uCoreSrc.y, max(lin.r, max(lin.g, lin.b)));
    float xt = mix(uCore.x, uCoreSrcK.x, sw);
    vec2 cev = mix(uCore.yz, uCoreSrcK.yz, sw);
    float mn = mix(min(eCore.r, min(eCore.g, eCore.b)), max(eCore.r, max(eCore.g, eCore.b)), xt);
    float over = log2(max(mn, 1e-6) / uNightK.x);
    float core = smoothstep(cev.x, cev.y, over) * uNightK.y;
    t = mix(t, vec3(1.0), core * smoothstep(0.6, 1.0, max(t.r, max(t.g, t.b))));
  }
  // retrowave grade (plan-G5 2F): one knob, linear light, after the clip, before the sensor noise (the grain is never graded)
  if (uRetro > 0.0) {
    vec3 lab = okLab(max(t, 0.0));
    float Lt = uNightK.z;
    // 1) split-tone: shadows toward cyan-teal (uRetroSh.x, 205 deg), uRetroSh.y chroma at uRetro 1. [P3-A] FPV #1: the deepest
    //    shadows no longer swing to blue-violet (255 deg): that was half of the purple veil's tint on the dark walls
    //    [P6-A] colour #4 / fpv #2 (the ground under the crowd read cyan, a dim warm sky went green-grey): the tint fades in over
    //    absolute Oklab L uRetroShG (off on the ground and in the deep darks) and is off where the collider depth is the sky
    float ws = 1.0 - smoothstep(0.35 * Lt, 0.8 * Lt, lab.x);
    ws *= smoothstep(uRetroShG.x, uRetroShG.y, lab.x);
    if (uDepthN.z > 0.0) ws *= 1.0 - smoothstep(0.985, 0.998, texture(tDepthN, clamp(sG, 0.0, 1.0) * uDepthN.xy).r);
    lab.yz += vec2(cos(uRetroSh.x), sin(uRetroSh.x)) * (uRetroSh.y * uRetro * ws * (0.2 + 0.8 * smoothstep(0.0, 0.3 * Lt, lab.x)));
    lab.x -= 0.25 * uRetroSh.y * uRetro * ws * smoothstep(0.0, 0.3 * Lt, lab.x);   // hold the shadows' luma: the tint, not a lift
    // 2) magenta roll-off: +1..+3 EV over the target shoulders into white through pink-magenta (330 deg); clipped cores stay white.
    //    [P2-A] keyed on the source (eCore), not source + halo: the glow ring round every sign no longer turns magenta; and only
    //    on highlights that already have colour (white windows and walls keep their white) (colour #3)
    //    [P4-A] colour #5: the window runs to uMagEv (the coloured rims of letters and tubes, +3..+5 EV, take it too) and amber
    //    (uVibGate) is left alone, so the amber rooms and the shop whites don't go salmon
    float evo = log2(max(dot(eCore, LUMA), 1e-6) / 0.24);
    float wc = 1.0 - smoothstep(0.92, 1.0, min(t.r, min(t.g, t.b)));
    float C0 = length(lab.yz), h0 = C0 > 1e-5 ? atan(lab.z, lab.y) : 0.0; h0 += h0 < 0.0 ? 6.2831853 : 0.0;
    float wh = smoothstep(uMagEv.x, uMagEv.y, evo) * (1.0 - smoothstep(uMagEv.z, uMagEv.w, evo)) * wc * smoothstep(uMag.y, uMag.y + 0.03, C0);
    wh *= 1.0 - smoothstep(uVibGate.x - 0.1745, uVibGate.x, h0) * (1.0 - smoothstep(uVibGate.y, uVibGate.y + 0.1745, h0));
    lab.yz += vec2(0.866, -0.5) * (uMag.x * uRetro * wh);
    // 3) neon vibrance: bright AND already saturated pixels only (skin, asphalt and grey concrete are left alone)
    float C = length(lab.yz);
    float wn = smoothstep(0.8 * Lt, 1.3 * Lt, lab.x) * smoothstep(0.05, 0.12, C) * wc;
    // [P3-A] colour #2: not on amber (Oklab hue uVibGate, soft 10 deg edges): the rooms stay amber, not pumpkin
    float hv = C > 1e-5 ? atan(lab.z, lab.y) : 0.0; hv += hv < 0.0 ? 6.2831853 : 0.0;   // atan(0, 0) is undefined
    wn *= 1.0 - smoothstep(uVibGate.x - 0.1745, uVibGate.x, hv) * (1.0 - smoothstep(uVibGate.y, uVibGate.y + 0.1745, hv));
    lab.yz *= 1.0 + uRetroVib * uRetro * wn;
    t = clamp(okLabInv(lab), 0.0, 1.0);
  }
  // sensor noise in linear (plan-L5 2E): shot ~ sqrt(signal x gain), read ~ gain; blue noisiest; luma clumped by the ISP
  // (grainPx), chroma in NR-smeared 2x blotches. Gain: analog gain past base ISO from where AE sits, plus the ISP's push
  // while AE is pinned (it lifts the toe too: pinEv/pinToe)
  // [P2-A] FPV #3: a gain-independent read floor (base ISO is not clean), luma grain on a jittered ~1.4 px lattice and chroma
  // blotches on ~8 px (bilinear noise texture, no grid squares), half of each carried into the next frame (3DNR crawl: the sum of
  // this frame's and last frame's lattice), the codec eating part of the luma grain in the shadow blocks; chroma NR in the deepest
  // shadows. Measured target: 3-6 DN luma sigma in dark flats (refs 2.8-6.5), chroma 1-2.
  {
    float G = exp2(clamp(ev - uNoiseEv.x, 0.0, uNoiseEv.y) - uNoiseEv.y) * exp2(X.a);   // 1 at full analog gain, up to 2 pinned
    float Ls = max(dot(t, LUMA), 0.0);
    float sg = sqrt(uNoise.x * uNoise.x * (Ls / 0.18) * G + uNoise.y * uNoise.y * G * G + uNoiseK.z * uNoiseK.z);
    vec2 fc = gl_FragCoord.xy;
    float nl = (texture(tNoise, (fc + uNoiseOff.xy) / (256.0 * uNoiseK.x)).r + texture(tNoise, (fc + uNoiseOff.zw) / (256.0 * uNoiseK.x)).r - 1.0) * 6.36;
    vec2 ca = texture(tNoise, (fc + uNoiseOffC.xy) / (256.0 * uNoiseK.y)).gb, cb = texture(tNoise, (fc + uNoiseOffC.zw) / (256.0 * uNoiseK.y)).gb;
    vec2 cc = (ca + cb - 1.0) * 6.36;
    vec3 cv = vec3(cc.x * uNoiseRGB.r, -0.5 * (cc.x + cc.y) * uNoiseRGB.g, cc.y * uNoiseRGB.b);
    cv -= dot(cv, LUMA);
    cv *= mix(uNoiseK.w, 1.0, smoothstep(0.002, 0.03, Ls));
    nl *= 1.0 - uCodec.w * codecK;
    t = max(t + sg * (vec3(nl) + cv * uNoise.z), 0.0);
  }
`;

// [S3] night auto-exposure (plan-L5 2A): 16x12 taps of the lens-mapped 1/8 frame; the brightest share (sign cores) is
// rejected through a log histogram, then a weighted log average; asymmetric second-order adaptation (darken fast,
// brighten slow, zeta ~0.7 overshoot = the visible hunt) with a deadband. State is a half-float texel: ev, ev rate, mean, pin.
// [P2-A] colour #6 / graphics #1: matrix metering (uMat: a flat field with a mild centre bias, not a centre spot), point
// sources rejected (aeReject 1 %), area sources (taps brighter than uArea.x scene units: sign faces, lit windows, screens)
// weighted uArea.y instead of dragging the street dark; the veil reads the glare under a fixed sensor level (uVeilL), not the
// white point; and a reset (teleport, respawn, a snapshot) settles at once: the sensor cap is re-solved at the new target.
const METER_N_FS = /* glsl */`precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tSmall;
uniform sampler2D tPrev;
uniform float uDt;
uniform float uBias;
uniform float uReset;
uniform float uLock;
uniform float uLockEv;
uniform float uEvMin;
uniform float uEvMax;
uniform float uClipL;     // sensor clip in exposed units (meter saturates there)
uniform float uVeilL;     // veil: per-tap cap in exposed units (the glare of what the lens passes; a blown face caps)
uniform vec4 uAe;         // x: tau darken (s), y: tau brighten (s), z: zeta, w: deadband (EV)
uniform float uReject;    // brightest share of taps dropped
uniform vec4 uArea;       // x: tap radiance (scene units) above which a tap is an area source, y: its weight; [P3-A] z: its weight once
                          // area sources cover more than w of the taps (FPV #4: a shopfront filling the frame doesn't set the street's EV)
float gAreaW;
uniform vec2 uMat;        // x: weighting centre (v), y: falloff (1.6 = the old centre-weighted spot)
float Lr[192];
float meterWant(float capEv){
  float hist[24];
  for (int i = 0; i < 24; i++) hist[i] = 0.0;
  float cap = uClipL * exp2(-capEv);
  for (int i = 0; i < 192; i++) hist[int(clamp(floor(log2(min(Lr[i], cap) + 1e-7) + 18.0), 0.0, 23.0))] += 1.0;
  // cut: the lowest bin edge above which at most uReject of the taps sit
  float cum = 0.0, cut = 1e9, lim = uReject * 192.0;
  for (int b = 23; b >= 0; b--) { if (cum + hist[b] > lim) break; cum += hist[b]; cut = exp2(float(b) - 18.0); }
  float lsum = 0.0, asum = 0.0, wsum = 0.0;
  for (int y = 0; y < 12; y++) for (int x = 0; x < 16; x++) {
    float L0 = Lr[y * 16 + x], L = min(L0, cap);   // the sensor saturates: a blown face reads as clip, not as its nits
    if (L >= cut) continue;
    vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(16.0, 12.0);
    vec2 d = (uv - vec2(0.5, uMat.x)) * vec2(1.6, 2.0);
    float w = exp(-dot(d, d) * uMat.y) * (L0 > uArea.x ? gAreaW : 1.0);
    lsum += w * log2(L + 1e-5); asum += w * L; wsum += w;
  }
  float avg = wsum > 0.0 ? exp2(mix(lsum / wsum, log2(asum / wsum + 1e-5), 0.15)) : 1.0;
  return log2(0.24 / avg) + uBias;
}
void main(){
  vec4 P = texelFetch(tPrev, ivec2(0), 0);
  float prevEv = P.r, vel = P.g;
  float aAll = 0.0;
  for (int y = 0; y < 12; y++) for (int x = 0; x < 16; x++) {
    vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(16.0, 12.0);
    float L = max(texture(tSmall, uv).a, 0.0);
    aAll += min(L, 4.0 * uVeilL * exp2(-prevEv));
    Lr[y * 16 + x] = L;
  }
  float na = 0.0; for (int i = 0; i < 192; i++) na += Lr[i] > uArea.x ? 1.0 : 0.0;
  gAreaW = mix(uArea.y, uArea.z, smoothstep(uArea.w - 0.05, uArea.w + 0.05, na / 192.0));
  float want = meterWant(prevEv);
  if (uReset > 0.5) { for (int k = 0; k < 3; k++) want = meterWant(clamp(want, uEvMin, uEvMax)); }
  float target = clamp(want, uEvMin, uEvMax);
  if (uLock > 0.5) target = uLockEv;
  float d = target - prevEv;
  float tgt = prevEv + sign(d) * max(abs(d) - uAe.w, 0.0);          // deadband: a 0.15 EV wobble doesn't move the iris
  float ev = prevEv;
  if (uReset > 0.5) { ev = target; vel = 0.0; }
  else {
    float w = 1.0 / (uAe.z * (tgt < prevEv ? uAe.x : uAe.y));      // 2nd order: ~1/(zeta w) = the tau of each direction
    int n = int(clamp(ceil(uDt * 240.0), 1.0, 24.0));
    float h = uDt / float(n);
    for (int i = 0; i < 24; i++) { if (i >= n) break;
      float acc = w * w * (tgt - ev) - 2.0 * uAe.z * w * vel;
      vel += acc * h; ev += vel * h; }
    ev = clamp(ev, uEvMin - 0.6, uEvMax + 0.3);
  }
  if (uReset > 0.5) aAll = 0.0;
  if (uReset > 0.5) for (int i = 0; i < 192; i++) aAll += min(Lr[i], 4.0 * uVeilL * exp2(-ev));
  float pin = clamp((want - uEvMax) * 0.25, 0.0, 1.0);
  float pk = uReset > 0.5 ? 1.0 : 1.0 - exp(-uDt * 2.5);
  fragColor = vec4(ev, vel, 0.5 * aAll / 192.0 * exp2(ev), P.a + (pin - P.a) * pk);
}`;

// [P3-A] lens ghosts (colour #5, FPV #6, graphics #3), night only, at 1/8 res in output space. A ghost is the source seen through a
// stray reflection path: mirrored through the frame centre at scale s, defocused into the 7-blade aperture's shape (radius R), with
// the coating's chroma fringe (red rim out, blue in). Only point sources far over the street feed it (block luma uGEv EV over
// grey: lamps, headlights; not neon or light boxes), desaturated to uGChroma. Gather: G(p) = w / s^2 * mean of the source over the
// aperture's footprint mapped back through the mirror, on a 37-tap hex lattice per ghost.
const GHOST_FS = /* glsl */`precision highp float;
${COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tSmall;   // rgb: bright pass (exposed), a: block-mean scene luma
uniform sampler2D tExp;
uniform vec2 uGEv;
uniform float uGChroma;
uniform float uFringe;
uniform float uBlades;
uniform float uAspect;
uniform vec4 uG[3];         // x mirror scale s, y weight / s^2, z radius (frame heights), w aperture rotation (rad)
uniform vec3 uGT[3];
uniform vec2 uLat[37];      // hex lattice in the unit disc
float hept(vec2 o, float R, float rot){
  if (dot(o, o) < 1e-12) return 1.0;                 // the centre tap (atan(0, 0) is undefined)
  float sec = 6.2831853 / uBlades, a = atan(o.y, o.x) - rot;
  float d = length(o) / R * cos(mod(a, sec) - 0.5 * sec) - cos(3.14159265 / uBlades);
  return 1.0 - smoothstep(-0.12, 0.12, d);
}
vec3 src(vec2 x, float ev){
  if (x.x < 0.0 || x.y < 0.0 || x.x > 1.0 || x.y > 1.0) return vec3(0.0);
  vec4 s = texture(tSmall, x);
  vec3 b = max(s.rgb, 0.0); float l = dot(b, LUMA);
  return (vec3(l) + (b - l) * uGChroma) * smoothstep(uGEv.x, uGEv.y, log2(max(s.a * exp2(ev), 1e-6) / 0.24));
}
void main(){
  float ev = decodeEv(texelFetch(tExp, ivec2(0), 0));
  vec3 acc = vec3(0.0);
  for (int g = 0; g < 3; g++) {
    vec4 G = uG[g];
    if (G.y <= 0.0) continue;
    vec3 sum = vec3(0.0), ws = vec3(0.0);
    for (int i = 0; i < 37; i++) {
      vec2 o = uLat[i] * G.z * (1.0 + uFringe);
      vec2 x = 0.5 + (vUv - vec2(o.x / uAspect, o.y) - 0.5) / G.x;
      vec3 wc = vec3(hept(o, G.z * (1.0 + uFringe), G.w), hept(o, G.z, G.w), hept(o, G.z * (1.0 - uFringe), G.w));
      sum += src(x, ev) * wc; ws += wc;
    }
    acc += sum / max(ws, vec3(1e-6)) * G.y * uGT[g];
  }
  fragColor = vec4(acc, 1.0);
}`;
// [P7-A] canyon airlight (colour #1, fpv #2; PLAN-P7: D builds the light term, A grades it), night only, 1/8 res, output space.
// Real sign streets glow in the gap above them (8e17, ccb0: 15-25 codes): the air between the roof lines in-scatters the lit
// canyon below. Gather, per 1/8 texel: 16 taps on two rings (uAir.z, uAir.z / 2 frame heights) of the 1/8 frame; a tap that is
// not sky (collider depth < ~90 m) is canyon: its exposed block luma (capped at uAir.w: one sign can't light the sky alone)
// feeds the mean, and the share of canyon taps is the enclosure (open sky -> 0, a slot between roof lines -> ~0.6-0.8).
// Out: a weight in its colour: smoothstep(uAirW, enclosure) x smoothstep(uAir.xy, the lit canyon's mean) (a dark alley gets
// none) x the warm city tint (uAirTint, luma 1) mixed uAirH toward the bright pass's own hue. FINAL lifts a dark sky by it.
const AIR_FS = /* glsl */`precision highp float;
${COMMON}
${LENS}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tSmall;   // rgb: bright pass (exposed), a: block-mean scene luma
uniform sampler2D tExp;
uniform sampler2D tDepthN;  // collider depth, half res (source space)
uniform vec2 uDepthS;       // source uv -> depth texture uv
uniform float uLens;        // 1: the 1/8 frame is in output space (meterLens)
uniform vec4 uAir;          // xy lit-canyon ramp (mean exposed luma), z ring radius (frame heights), w per-tap exposed cap
uniform float uAirH;        // share of the signs' own hue
uniform vec2 uAirW;         // enclosure ramp
uniform vec3 uAirTint;      // luma 1
uniform float uAspect;
void main(){
  float ev = decodeEv(texelFetch(tExp, ivec2(0), 0));
  float n = 0.0, nc = 0.0, sL = 0.0; vec3 sC = vec3(0.0);
  for (int k = 0; k < 2; k++) for (int i = 0; i < 8; i++) {
    float a = (float(i) + 0.5 * float(k)) * 0.78539816, rr = uAir.z * (k == 0 ? 0.5 : 1.0);
    vec2 o = vUv + vec2(cos(a) * rr / uAspect, sin(a) * rr);
    if (o.x < 0.0 || o.y < 0.0 || o.x > 1.0 || o.y > 1.0) continue;   // off the frame: no vote
    vec2 so = o;
    if (uLens > 0.5) { float r, th; so = 0.5 + lensD(o, r, th); }
    float ns = 1.0 - smoothstep(0.985, 0.998, texture(tDepthN, clamp(so, 0.0, 1.0) * uDepthS).r);
    vec4 s = texture(tSmall, o);
    n += 1.0; nc += ns;
    sL += ns * min(s.a * exp2(ev), uAir.w);
    sC += ns * max(s.rgb, 0.0);
  }
  float encl = nc / max(n, 1.0), w = smoothstep(uAirW.x, uAirW.y, encl);
  float mL = sL / max(nc, 1e-3);
  float lc = dot(sC, LUMA);
  vec3 hue = lc > 1e-5 ? sC / lc : uAirTint;
  hue = clamp(mix(vec3(1.0), hue, 0.5), 0.0, 2.0);                 // half the signs' chroma: a glow, not a coloured sky
  fragColor = vec4(mix(uAirTint, hue, uAirH) * (w * smoothstep(uAir.x, uAir.y, mL)), 1.0);
}`;
// 37-point hex lattice (3 rings) in the unit disc
const HEX37 = (() => { const p = [[0, 0]]; for (let k = 1; k <= 3; k++) for (let s6 = 0; s6 < 6; s6++) for (let j = 0; j < k; j++) { const f = j / k, a0 = Math.PI / 3 * s6, a1 = Math.PI / 3 * (s6 + 1); p.push([(k * ((1 - f) * Math.cos(a0) + f * Math.cos(a1))) / 3, (k * ((1 - f) * Math.sin(a0) + f * Math.sin(a1))) / 3]); } return p; })();

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
#ifdef NIGHT
${NIGHT_FINAL_HEAD}
#endif

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
#ifdef NIGHT
  float car = (uCA + uRetroCA) * rn * rn;
#else
  float car = uCA * rn * rn;
#endif
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
#ifdef NIGHT
  // [P2-A] no sharpening in the shadows (FPV #3): the ISP doesn't crunch its own noise floor
  c = c * clamp(1.0 + (Lc - Ln) * uSharp * smoothstep(uSharpDark.x, uSharpDark.y, Lc * exp2(decodeEv(texelFetch(tExp, ivec2(0), 0)))) * 0.8 / max(Lc, 1e-6), 0.6, 1.6);
#else
  c = uHdr > 0.5 ? c * clamp(1.0 + (Lc - Ln) * uSharp * 0.8 / max(Lc, 1e-6), 0.6, 1.6) : clamp(c + (Lc - Ln) * uSharp, 0.0, 1.0);
#endif

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
#ifdef NIGHT
  vec3 eCore = e;                                                          // pre-halo exposure: the clip/core test reads the source, not its glow
  e += texture(tHalo, uBloomOut > 0.5 ? vUv : clamp(sG, 0.0, 1.0)).rgb * uHalo * uHaloTint;   // wide warm halation (lens glow + sensor scatter)
  // [P4-A] colour #4 / lighting #4: the middle lobe, in the source's own colour: a letter's glow falls off over 15-60 px
  // instead of stopping at a hard coloured rim (after eCore: the cores and the magenta key still read the source)
  if (uHaloM > 0.0) e += texture(tHaloM, uBloomOut > 0.5 ? vUv : clamp(sG, 0.0, 1.0)).rgb * uHaloM * uHaloMTint;
  // [P5-A] colour #5 / lighting #6: a second, wider source-tinted lobe (the middle lobe again at 1/16): the glow has a skirt
  if (uHaloW > 0.0) e += texture(tHaloW, uBloomOut > 0.5 ? vUv : clamp(sG, 0.0, 1.0)).rgb * uHaloW * uHaloMTint;
  // [P7-A] colour #3: the edge lobe. A lens's near PSF is linear in all the light, not only in what passes the bright-pass
  // threshold (4 EV over grey, ~236 codes): a letter at 225 fed no lobe at all, so its edge fell 225 -> 120 in 4 px. Here: the
  // 1/8 block radiance (tSmall.a, every pixel, capped), in the bright pass's hue where there is one; 8 px box + bilinear =
  // sigma ~5-6 px at 1280 wide, no extra pass. Over a flat wall it is a uniform few-% veil (the exposure fit absorbs it)
  if (uHaloE.x > 0.0) {
    vec4 sb = texture(tSmall, uBloomOut > 0.5 ? vUv : clamp(sG, 0.0, 1.0));
    float lb = dot(max(sb.rgb, 0.0), LUMA);
    vec3 hb = lb > 1e-4 ? clamp(mix(vec3(1.0), sb.rgb / lb, smoothstep(1e-4, 0.05, lb)), 0.0, 3.0) : vec3(1.0);
    e += hb * (min(sb.a * exp2(ev), uHaloE.y) * uHaloE.x);
    // [P8-A] colour #4 (the edge reached 120 at 4.5 px, the panel's 8): a ring of 4 taps at uHaloE.w 1/8 texels (8 px at
    // render res) on the same block radiance; with the bilinear footprint, a lobe of sigma ~8-10 px at uHaloE.z
    if (uHaloE.z > 0.0) {
      vec2 tx = uHaloE.w / vec2(textureSize(tSmall, 0)), c0 = uBloomOut > 0.5 ? vUv : clamp(sG, 0.0, 1.0);
      vec3 ring = vec3(0.0);
      for (int i = 0; i < 4; i++) {
        vec2 o = vec2(i < 2 ? 0.7071 : -0.7071, (i == 0 || i == 2) ? 0.7071 : -0.7071) * tx;
        vec4 sr = texture(tSmall, clamp(c0 + o, 0.0, 1.0)); float lr = dot(max(sr.rgb, 0.0), LUMA);
        vec3 hr = lr > 1e-4 ? clamp(mix(vec3(1.0), sr.rgb / lr, smoothstep(1e-4, 0.05, lr)), 0.0, 3.0) : vec3(1.0);
        ring += hr * min(sr.a * exp2(ev), uHaloE.y);
      }
      e += ring * (0.25 * uHaloE.z);
    }
  }
  // [P7-A] colour #1 / fpv #2: the canyon airlight, graded on top of D's light term (seoul-light.js citySkyAir, in the scene):
  // on sky-depth pixels a dark slot is lifted toward uAirF.y (exposed luma, ~19 codes) by AIR_FS's weight (enclosure x lit
  // canyon), in its warm tint; a sky D's term (or an open dome) already lifts past that is left alone
  if (uAirF.x > 0.0) {
    float sk = smoothstep(0.985, 0.998, texture(tDepthN, clamp(sG, 0.0, 1.0) * uDepthN.xy).r);
    if (sk > 0.0) {
      vec3 air = texture(tAir, uBloomOut > 0.5 ? vUv : clamp(sG, 0.0, 1.0)).rgb;
      e += air * (sk * max(uAirF.y - dot(e, LUMA), 0.0));
      // [P8-A] colour #5 (w21's slot read (34,25,22), over the refs' 28): the sum of D's in-scatter and this lift is held
      // to uAirF.z where AIR_FS weighs the sky as a lit canyon (its luma: enclosure x lit); open domes (weight 0) and bright
      // points over the sky (lamps, bulbs: 3-6x the cap) are left alone
      float la = dot(e, LUMA);
      if (uAirF.z > 0.0 && la > uAirF.z) e *= mix(1.0, uAirF.z / la, sk * clamp(dot(air, LUMA), 0.0, 1.0) * (1.0 - smoothstep(3.0 * uAirF.z, 6.0 * uAirF.z, la)));
    }
  }
  // [P2-A] FPV #2: tBloom is the PSF's narrow lobe, tHalo its wide lobe (energy fractions of the uncapped bright pass)
  // [P3-A] colour #5 / FPV #6 / graphics #3: ghosts come from GHOST_FS (point sources only, aperture-shaped, desaturated)
  if (uGhostS.w > 0.0) e += texture(tGhost, uBloomOut > 0.5 ? vUv : clamp(sG, 0.0, 1.0)).rgb;
  // [P2-A] codec (FPV #3): in the shadow 8x8 blocks the long-GOP encoder keeps little more than the block mean, so fine detail
  // flattens toward it (block-consistent mask: the block edges show) and part of the luma grain goes with it (below)
  float codecK = 0.0;
  if (uCodec.x > 0.0) {
    vec2 sz = vec2(textureSize(tSmall, 0));
    float Lb = texelFetch(tSmall, ivec2(min(vUv * sz, sz - 1.0)), 0).a * exp2(ev);
    float cr = clamp(Lb / max(dot(eCore, LUMA), 1e-6), 0.25, 4.0);
    codecK = uCodec.x * (1.0 - smoothstep(uCodec.y, uCodec.z, Lb)) * (1.0 - smoothstep(1.5, 3.0, max(cr, 1.0 / cr)));   // edges keep their bits
    e *= 1.0 + codecK * (cr - 1.0);
  }
#endif
  float vig = pow(max(cos(th), 0.0), 2.2);                                 // optical cos^n falloff
  e *= mix(1.0, vig, uVig);
  if (con != 1.0) e *= pow(max(dot(e, LUMA), 1e-6) / 0.24, con - 1.0);     // camera contrast about the AE target
  e += uVeil * X.b * vec3(1.0, 0.99, 0.97);                                // veiling glare from the metered mean
#ifdef NIGHT
  vec3 t = nightTone(e);                                                   // [P2-A] graphics #1: filmic shoulder to the white point
#else
  vec3 t = min(camCurve(e * uExpo) * uWhite, 1.0);                         // per channel: skies clip blue-first
#endif
  if (toe > 0.0) t = t * t / (t + toe) * (1.0 + toe);                       // sensor toe (real blacks)
  float l = dot(t, LUMA);
  t = max(mix(vec3(l), t, uSat * mix(uShSat, 1.0, smoothstep(0.01, 0.16, l))), 0.0);
#ifdef NIGHT
${NIGHT_FINAL_BODY}
#endif
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
#ifndef NIGHT
  // signal-dependent sensor noise: shot noise ~ sqrt(signal), scaled by analog gain (positive EV), clumped by NR/codec
  float gain = exp2(max(ev + uGrainEv.x, 0.0) * uGrainEv.y);
  vec2 gp = floor(gl_FragCoord.xy / uGrainPx);
  float n = hash(vec3(gp, mod(uFrame, 997.0))) - 0.5;
  float nc = hash(vec3(gp.yx + 17.0, mod(uFrame, 991.0))) - 0.5;
  float sigma = uGrain * gain * sqrt(l + 0.025);
  o += n * sigma + vec3(nc, -nc, nc * 0.5) * sigma * 0.35;
#endif
  o += (ign(gl_FragCoord.xy + uFrame) - 0.5) / 255.0;
  fragColor = vec4(clamp(o, 0.0, 1.0), 1.0);
}`;

const TRI = new THREE.BufferGeometry();
TRI.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));

function pass(fs, uniforms, defines) {
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: fs, uniforms,
    depthTest: false, depthWrite: false, ...(defines ? { defines } : {}),
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
  // [S3] Night (Neon Seoul, contract L5; plan-L5 + plan-G5 2E-F). A sensor model, not a look: GoPro/O4 at ISO 3200-6400, 1/60 s,
  // WB fixed ~4800 K, 11 ms readout. Applied on top of GRADES.hdr by fpv.setLook('night') (scene units: 1 = 10 cd/m2, see
  // seoul-light.js NITS). `night: 1` selects the night programs (half-float AE state, white cores, halation, linear sensor noise,
  // retrowave stage); every key below is otherwise read by the shared pipeline exactly as for bando.
  //   retro: the retrowave grade knob (0 = pure camera; ships 0.3; ?retro= overrides); retroVib: neon vibrance at retro 1;
  //   retroCA: extra edge CA at retro 1 (off by default, Justin decides); halo/haloR/haloTint: wide warm halation (x(1+0.8 retro),
  //   radius x(1+0.3 retro)); core: white-core amount; bloomKnee: bright pass starts this many EV under the clip;
  //   noise: [shot sigma at mid-grey, read sigma, chroma share] in linear at full analog gain; noiseRGB: chroma noise per channel; noiseSpan: analog gain stops
  //   (base ISO ends at evMax - noiseSpan); ae: [tau darken s, tau brighten s, zeta, deadband EV]; aeReject: brightest tap share
  //   the meter ignores; evMin..evMax: 6 stops.
  // Phase 2 [P2-A] (panel 1 colour #1/#3/#4/#6, graphics #1, FPV #2/#3; offline-fitted on HDR captures of the hero streets):
  //   clipEv 2.2 -> 7.5 is now the WHITE POINT of a filmic shoulder (Lottes 2016, `tone` [a, d, mid-out]) instead of a hard clip 2.2 EV
  //   over grey: grey (0.24) -> code ~123, ground (-2 EV) ~55, +2 ~190, +4 ~227, +5 ~238, +6 ~246, +7 ~252 (a log camera graded to Rec.709: light boxes at
  //   EV -1..0 hold under code 250, only true sources clip). tonePc: per-channel share of the shoulder (the rest preserves hue on max(rgb)).
  //   core keyed on the min channel (+ coreXtalk of the max: sensor crosstalk), ramping in coreEv EV over the white point.
  //   wb [1, 1, 0.96]: a small warm nudge (~ -300 K) on a scene that is already white-balanced at its emitters (cctRGB is relative
  //   to D65, so these gains alone are ~6000 K, not the 4300 K the phase-2 comment claimed; the 4300 K balance is C's colourOf = cctRGB(K)
  //   / cctRGB(4300) and B's filter model, panel 2 colour #1/#2). toe 0.08 -> 0.045, lift 0.02 (colour #4).
  //   veil 0.03 -> 0.012 with veilCapEv 3 (the wide PSF lobe carries the local glare now). mag/magC: retro magenta amount and chroma gate.
  //   PSF (FPV #2): bright pass over psfThEv EV above grey, uncapped (bloomCap 4096); narrow lobe = bloom (energy share) after psfNarrowIt
  //   blur passes at psfNarrowR texel spacing (sigma ~0.8 % of width); wide lobe = halo (sigma ~6 %, haloR); ghosts: [mirror scale,
  //   weight, tint] x 3. Noise (FPV #3): noise [shot, read, chroma] + noiseFloor (gain-independent), noiseCell [luma, chroma] px,
  //   chromaDark (chroma kept in the deepest shadows); codec [amount, exposed level where it fades from 1 .. to 0, share of the luma
  //   grain removed]; sharpDark: exposed level where sharpening fades in. AE (colour #6, graphics #1): aeReject 1 %, aeArea [scene
  //   units above which a tap is an area source, its weight, its weight once area taps exceed the share in [3]], aeMatrix [centre v, falloff].
  // Phase 3 [P3-A] (panel 2 colour #1/#3/#5, FPV #1/#2/#4/#5/#6, graphics #3; fitted offline on HDR captures of walk0/walk180/club90/club270):
  //   coreSrc [a, b]: true sources are pixels B flags as cores (contract P3-B1: scene alpha 1 + w on channel stroke centres, tube
  //   axes, bulbs and LEDs; carried through the shutter blur) whose max-channel radiance passes a..b scene units (350..550 nits:
  //   above screens and faces, so an additive sprite's alpha can't bleach a light box; w ramps in over coreW); they take coreXtalkSrc
  //   crosstalk and the ramp coreEvSrc [-4, -2] EV under the white point (a real sensor clips ~+4 EV over grey, 3.5 under this log
  //   white point; fitted on B's filter-model letters, walk0 white area 0.6 -> 4.6 %): letters and tubes white-core with coloured rims,
  //   faces, screens and windows keep their colour. Unflagged sources still clip through the base path (lamps, headlights).
  //   ghosts [mirror scale, weight, radius (frame heights), tint]: only point sources whose 1/8 block luma is ghostEv EV over grey feed
  //   them (lamps, headlights; neon and boxes don't), desaturated to ghostChroma, shaped by a ghostBlades-blade aperture with a
  //   ghostFringe chroma rim (GHOST_FS). retroShadow [Oklab hue deg, chroma]: one split-tone hue (the deep blue-violet swing is gone);
  //   retroVibGate [deg, deg]: the retro vibrance skips amber (rooms). aeArea 4th entry: area sources over 20 % of the taps weigh 0.3.
  // Phase 4 [P4-A] (panel 3 colour #1/#4/#5, lighting #4/#6; fitted offline on HDR captures of main 173666d: walk0/club270/w21/station):
  //   evBias -2.0 -> -1.5, toe 0.045 -> 0.035 (colour #1, recover the stop: converged p50 walk0 31 -> 45, club270 29 -> 43, w21 26 -> 39,
  //   station 39 -> 56; below 16 28/22/34/32 -> 16/9/20/26 %). aeArea unchanged: re-fit once C's shop nits and wall albedos land
  //   (lighting #6). coreEvSrc [-4, -2] -> [-4.5, -1]: the white-to-colour ramp spreads over the stroke (colour #4).
  //   haloM [energy, tap spacing (1/8 texels), passes]: the PSF's middle lobe, sigma ~2.5 texels at 1/8 (~20 px at 960 wide, visible
  //   15-60 px out), 2.5 % of the bright pass in the source's own colour (haloMTint neutral): letters glow instead of stopping at a rim.
  //   retroShadow 205 -> 230 deg (walls blue-grey, not green-teal); mag 0.035 -> 0.07 with its window magEv [in0, in1, out0, out1] EV
  //   over the AE target running to +4.2 (letter and tube rims) and amber (retroVibGate) left alone (rooms, shop whites).
  // Phase 5 [P5-A] (panel 4 colour #1/#5, lighting #6 and "Exposure"; fitted offline on HDR captures of A + D's p5 lighting):
  //   haloM [0.025, 1.4, 1] -> [0.04, 1.6, 2]: the middle lobe at 4 %, sigma ~30 px at 960 wide (2 passes); haloW [energy,
  //   spacing (1/16 texels), passes]: a second source-tinted lobe built from the middle one at 1/16, 1 % at sigma ~100 px
  //   (visible 80-150 px out): letters glow with a skirt instead of ending in a 3 px rim.
  //   Exposure re-fit (colour #1, lighting "Exposure") on A + D's p5 lighting (cityLux flipped, shop spill, re-baked):
  //   evBias -1.5 -> -2.05 and aeArea [0.8, 0.5, 0.3, 0.2] -> [0.5, 0.75, 0.45, 0.2] (lit glass and light walls from 5 nits
  //   count as area sources at 75 %, so a frame of bright shopfronts no longer opens the iris): converged frame p50 walk0
  //   76 -> 49, club90 58 -> 36, club270 56 -> 39, w21 64 -> 45 (refs' median 44); clip walk0 2.2 -> 0.3 %.
  //   coreEvSrc [-4.5, -1] -> [-5.2, -1.6]: the true-source ramp follows the stop down (~0.6 EV), so letters still white-core
  //   (walk0 white area 1.4 -> 1.7 %) without bleaching the coloured faces (bright-saturated 5.4 %).
  //   [P6-A] PLAN-P6 #1 (the frame went dark; the fix is C's albedo and D's light, then this re-fit, last): retroShadow chroma
  //   0.06 -> 0.03 with retroShGate [L0, L1] (absolute Oklab L: no tint on the ground or the deep darks, full by ~35 codes) and
  //   retroShSky (none where the collider depth is the sky: a dim warm sky no longer goes green-grey) (colour #4, fpv #2);
  //   toe 0.035 -> 0.025 (fpv #1); aeArea[1] 0.75 -> 0.55 (colour #2, the open shots); haloM spacing 1.6 -> 2.2 and haloW
  //   0.01 -> 0.02 (colour #6: the letter edge falls over more pixels). Exposure re-fit last, on a scratch merge of p6/A + C
  //   (walls x0.7, pavers 0.31) + D (sky dome in the bake, paver mirror, pools), re-baked: evBias -2.05 -> -1.85. GL at -2.05
  //   (960 wide): p50 walk0 42.8, club270 43.8, station 30.4, spawn 37.9 -> modelled at -1.85 47.4 / 48.6 / 34.2 / 42.1; walk0
  //   ground 19 -> 22 (P5 14), below 16 20.0 -> 16.8 % (P5 24.8), ground/wall 0.40 -> 0.42; walk0 ground (22,19,16), not cyan.
  //   GL check at -1.85 on the next merge (C's grime and roofs, lightmap from file): p50 walk0 45.5, club90 48.4, w21 46.7,
  //   station2 30.6 (P5 20); below 16 18.3 / 14.7 / 16.0 / 14.4 %; ground/wall walk0 0.42, w21 0.46, club90 0.73.
  // [P7-A] PLAN-P7 (panel 6 colour #1/#3/#5, fpv #2): air [target exposed luma, sign-hue share, ring radius (frame heights),
  //   per-tap cap] / airTint / airEncl / airLit: the canyon airlight (AIR_FS), graded on D's light term (seoul-light.js
  //   citySkyAir). On the merge D's term alone lifts walk0's slot 9 -> ~18 codes but walk180's only to ~10 (C's sign stacks stop
  //   AE down to EV -4.2); a dark slot is lifted toward 0.022 exposed (~19 codes), warm R > G > B, by enclosure x lit canyon;
  //   open skies (low enclosure) and skies D already lifts past the target are left alone.
  //   haloE [share, exposed cap]: the PSF's edge lobe (colour #3): 5 % of the 1/8 block radiance with no bright-pass threshold
  //   (unblurred, sigma ~5-6 px at 1280). A 3 % share of the bright pass moved nothing (letter edge 2-4 px band 125 -> 124);
  //   this one (merge run 2, walk0): 2-4 px 124 -> 136, 4-6 px 47 -> 65, 6-8 px 44 -> 53.
  //   airEncl [0.35, 0.8] -> [0.15, 0.45], airLit [0.01, 0.04] -> [0.005, 0.025] after merge run 2: walk180's slot (enclosure
  //   ~0.5, far dark facades round it) took only ~20 % of the lift (10 -> 11.5 codes); now it takes all of it (modelled ~18).
  //   evBias -1.85 -> -1.9: exposure re-fit last on a scratch merge of p7 A + C (sign stacks into the frame, cladding) + D (sky
  //   term, ground light, re-baked). GL at -1.85 (960 wide): p50 walk0 47.0, club90 49.8 (band top 50), walk180 39.7, station2
  //   32.6; below 16 13.5 / 14.1 / 22.4 / 12.4 %. Modelled at -1.9: 45.9 / 48.8 / 38.7 / 31.6. walk180 meters EV -4.1 (C's
  //   near boards fill a third of it) and its ground is 18: a light / content gap, not exposure (club90 caps any lift).
  //   wb red 1.0 -> 0.98 (colour #5: the fill went amber under the warmer dome, club270 R-G 2.7 -> 8.0, high 7.4 -> 11.5).
  // [P8-A] PLAN-P8 (panel 7 colour #4 / #5): haloE [share, exposed cap, ring share, ring radius (1/8 texels)] [0.05, 16] ->
  //   [0.09, 24, 0.03, 1.0]: the edge lobe at 9 % plus a ring of 4 taps 8 px out at 3 % (sigma ~8-10 px): the letter edge
  //   reaches 120 at ~8 px, not 4.5. air[4] = 0.028: the slot cap (exposed luma, ~24 codes, R ~28): on sky-depth pixels AIR_FS
  //   weighs as a lit canyon, D's in-scatter + the lift is held there (w21's slot read (34,25,22) against the refs' 28 top).
  night: { night: 1, retro: 0.3, retroVib: 0.5, retroCA: 0, wb: [0.98, 1.0, 0.96], wbShade: null, evBias: -1.9, lift: 0.02, clipEv: 7.5, con: 1.2, toe: 0.025,
    tone: [1.0839, 0.928, 0.2194], tonePc: 0.35, veil: 0.012, veilCapEv: 3.0, shadowSat: 0.8, skySel: 0, greenSel: 0, skyBoost: 0,
    bloom: 0.05, bloomCap: 4096, bloomKnee: 0.5, psfThEv: 4.0, psfNarrowIt: 1, psfNarrowR: 0.5, halo: 0.013, haloR: 1.4, haloTint: [1.0, 0.75, 0.6],
    haloM: [0.04, 2.2, 2], haloMTint: [1, 1, 1], haloW: [0.02, 2.2, 3], haloE: [0.09, 24, 0.03, 1.0],
    air: [0.022, 0.3, 0.2, 4, 0.028], airTint: [1.3, 0.75, 0.38], airEncl: [0.15, 0.45], airLit: [0.005, 0.025],
    ghosts: [[-0.55, 0.0015, 0.045, [0.95, 1.0, 0.9]], [-1.3, 0.001, 0.09, [1.0, 0.92, 1.0]]], ghostEv: [9, 10.5], ghostChroma: 0.3, ghostFringe: 0.08, ghostBlades: 7,
    core: 1, coreXtalk: 0.15, coreEv: [0, 2], coreSrc: [35, 55], coreW: [0.05, 0.35], coreXtalkSrc: 0.4, coreEvSrc: [-5.2, -1.6], retroShadow: [230, 0.03], retroShGate: [0.17, 0.26], retroShSky: 1, retroVibGate: [40, 100],
    mag: 0.07, magC: 0.04, magEv: [0.7, 1.6, 3.2, 4.2], grain: 0, grainEv: [0, 0], grainPx: 2,
    noise: [0.014, 0.0022, 1.8], noiseFloor: 0.0025, noiseRGB: [1.1, 0.8, 1.5], noiseCell: [1.4, 8], chromaDark: 0.4, noiseSpan: 6,
    codec: [0.4, 0.02, 0.08, 0.5], sharpDark: [0.03, 0.08], objBlur: 1, meterLens: 1, sharpen: 0.22, sharpPx: 2,
    recon: 0.7, chromaPx: 0.5, hlEv: null, hlGain: 0, pinEv: [0.4, 2.0], pinToe: 0.7, pinCon: 0.5, mbRecon: 1, lensMask: 1, evMin: -4.5, evMax: 1.5,
    saturation: 1.05, expo: 0.85, invTone: 0, ae: [0.25, 0.8, 0.7, 0.15], aeReject: 0.01, aeArea: [0.5, 0.55, 0.45, 0.2], aeMatrix: [0.45, 0.5],
    shutter: 1 / 60, readout: 0.011 },
};
// Lottes 2016 shoulder constants: x^a / (x^(a d) b + c) passes (0.24, mid) and reaches 1 at the white point hdrMax
export function nightToneBC(a, d, mid, hdrMax) {
  const mi = 0.24, ad = a * d, den = (Math.pow(hdrMax, ad) - Math.pow(mi, ad)) * mid;
  return [(-Math.pow(mi, a) + Math.pow(hdrMax, a) * mid) / den, (Math.pow(hdrMax, ad) * Math.pow(mi, a) - Math.pow(hdrMax, a) * Math.pow(mi, ad) * mid) / den];
}
// 256^2 RGBA8 gaussian noise (sigma 1 -> 1/6 of the range, clamped at 3 sigma), deterministic: the night grain's lattice
function noiseTexture() {
  const N = 256, a = new Uint8Array(N * N * 4);
  let s = 0x9e3779b9 >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < N * N * 4; i++) {
    const g = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    a[i] = Math.round((Math.max(-3, Math.min(3, g)) / 6 + 0.5) * 255);
  }
  const t = new THREE.DataTexture(a, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
const NIGHT_KEYS = Object.keys(GRADES.night);
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
  readEv(renderer) {
    if (this.look.night && this._nightP) { try { const b = new Uint16Array(4); renderer.readRenderTargetPixels(this._nightP.exp[this._nightP.idx], 0, 0, 1, 1, b); return THREE.DataUtils.fromHalfFloat(b[0]); } catch (e) { return NaN; } }
    const b = new Uint8Array(4); renderer.readRenderTargetPixels(this.exp[this.expIdx], 0, 0, 1, 1, b); return -5 + 10 * (b[0] / 255 + b[1] / 255 / 255); }
  setHDR(on) {
    on = !!on;
    if (this.look.night) this._leaveNight();      // [S3] a world switch always drops the night preset
    if (this.hdr === on) return;
    this.hdr = on; this.resetExposure = true;
    this._applyGrade(on ? GRADES.hdr : GRADES.ldr);
    if (this.outW > 2) this.resize(this.outW, this.outH);
  }

  // [S3] contract L5: main.js applies the manifest look ('night' for Seoul, 'hdr' / 'ldr' otherwise) after fpv.setHDR().
  setLook(name) {
    if (name === 'night') {
      if (!this.hdr) this.setHDR(true);
      if (!this.look.night) this._preNight = Object.fromEntries(NIGHT_KEYS.map((k) => [k, Array.isArray(this.look[k]) ? this.look[k].slice() : this.look[k]]));
      this._applyGrade(GRADES.night);
      try { const q = new URLSearchParams(globalThis.location?.search || ''); if (q.has('retro') && Number.isFinite(+q.get('retro'))) this.look.retro = Math.max(0, Math.min(1, +q.get('retro'))); } catch (e) {}
      this.resetExposure = true;
    } else {
      if (this.look.night) this._leaveNight();
      if (name === 'ldr' || name === 'hdr') { if (this.hdr !== (name === 'hdr')) this.setHDR(name === 'hdr'); }
    }
  }
  _leaveNight() {
    const pre = this._preNight || {};
    for (const k of NIGHT_KEYS) { if (k in pre && pre[k] !== undefined) this.look[k] = pre[k]; else delete this.look[k]; }
    this.look.night = 0; this._preNight = null; this.resetExposure = true;
  }
  // [S3] night programs + state, built on first use (bando never allocates them)
  _initNight() {
    if (this._nightP) return this._nightP;
    const D = { NIGHT: 1 }, V2 = THREE.Vector2, V3 = THREE.Vector3;
    const V4 = THREE.Vector4;
    const nfU = { ...this.final.u, tHalo: { value: null }, uHalo: { value: 0 }, uHaloTint: { value: new V3(1, 1, 1) }, uNightK: { value: new V3(1, 1, 0.5) },
      uRetro: { value: 0 }, uRetroVib: { value: 0 }, uRetroCA: { value: 0 }, uNoise: { value: new V3() }, uNoiseRGB: { value: new V3(1, 1, 1) }, uNoiseEv: { value: new V2(0, 6) },
      // [P2-A]
      uTone: { value: new V4(1, 1, 1, 1) }, uTonePc: { value: 1 }, uCore: { value: new V3(0, 0, 2) }, uMag: { value: new V2(0.05, 0) },
      tSmall: { value: null }, uCodec: { value: new V4(0, 0.02, 0.08, 0) }, uSharpDark: { value: new V2(0, 0) },
      tNoise: { value: null }, uNoiseOff: { value: new V4() }, uNoiseOffC: { value: new V4() }, uNoiseK: { value: new V4(1.4, 8, 0, 1) },
      uGhostS: { value: new V4(0, 0, 0, 0) },
      // [P3-A]
      tGhost: { value: null }, uCoreSrc: { value: new V2(1e9, 2e9) }, uCoreSrcK: { value: new V3(0, 0, 2) }, uCoreW: { value: new V2(0.05, 0.35) }, uRetroSh: { value: new V2(3.578, 0.06) }, uVibGate: { value: new V2(7, 7) },
      // [P4-A]
      tHaloM: { value: null }, uHaloM: { value: 0 }, uHaloMTint: { value: new V3(1, 1, 1) }, uMagEv: { value: new V4(0.7, 1.6, 2.6, 3.4) },
      // [P5-A]
      tHaloW: { value: null }, uHaloW: { value: 0 },
      // [P6-A]
      uRetroShG: { value: new V2(0, 0) }, tDepthN: { value: null }, uDepthN: { value: new V3(1, 1, 0) },
      // [P7-A]
      tAir: { value: null }, uAirF: { value: new V3(0, 0, 0) }, uHaloE: { value: new V4(0, 16, 0, 1) } };
    const fl = this.final.u;
    const bl = () => pass(BLOOM_FS, { tSrc: { value: null }, uDir: { value: new V2() } });
    this._nightP = {
      down: pass(DOWN_FS, this.down.u, D), final: pass(FINAL_FS, nfU, D),
      meter: pass(METER_N_FS, { tSmall: { value: null }, tPrev: { value: null }, uDt: { value: 0.016 }, uBias: { value: 0 }, uReset: { value: 1 }, uLock: { value: 0 },
        uLockEv: { value: 0 }, uEvMin: { value: -4.5 }, uEvMax: { value: 1.5 }, uClipL: { value: 1 }, uAe: { value: new THREE.Vector4(0.25, 0.8, 0.7, 0.15) }, uReject: { value: 0.02 },
        uVeilL: { value: 1 }, uArea: { value: new V4(1e9, 1, 1, 2) }, uMat: { value: new V2(0.45, 1.6) } }),
      copy: bl(), haloH: bl(), haloV: bl(), noise: noiseTexture(), noiseOff: [0, 0, 0, 0], noiseOffC: [0, 0, 0, 0],
      // [P3-A] lens ghosts (GHOST_FS) into a 1/8-res target
      ghost: pass(GHOST_FS, { tSmall: { value: null }, tExp: { value: null }, uGEv: { value: new V2(9, 10.5) }, uGChroma: { value: 0.3 }, uFringe: { value: 0.08 },
        uBlades: { value: 7 }, uAspect: { value: 16 / 9 }, uG: { value: [new V4(), new V4(), new V4()] }, uGT: { value: [new V3(1, 1, 1), new V3(1, 1, 1), new V3(1, 1, 1)] },
        uLat: { value: HEX37.map(([x, y]) => new V2(x, y)) } }, D), ghostRT: null,
      // [P7-A] canyon airlight at 1/8 res (AIR_FS); the lens uniforms are FINAL's own objects
      air: pass(AIR_FS, { tSmall: { value: null }, tExp: { value: null }, tDepthN: { value: null }, uDepthS: { value: new V2(1, 1) }, uLens: { value: 1 },
        uAir: { value: new V4(0.01, 0.04, 0.2, 4) }, uAirH: { value: 0 }, uAirW: { value: new V2(0.35, 0.8) }, uAirTint: { value: new V3(1, 1, 1) }, uAspect: { value: 16 / 9 },
        uHalf: fl.uHalf, uF: fl.uF, uK: fl.uK, uSrcTan: fl.uSrcTan }, D), airRT: null,
      // [P2-A] FPV #6 object motion blur: the night blur variant + a half-res velocity pass of the movers (contract P2-A1)
      blur: pass(BLUR_FS, { ...this.blur.u, tVel: { value: null }, uVelOn: { value: 0 } }, D),
      velRT: null, velScene: new THREE.Scene(), proxies: new Map(), velMats: new Map(), velMat: new THREE.ShaderMaterial({
        uniforms: { uHalfExp: { value: 1 / 120 } },
        vertexShader: /* glsl */`#ifndef VEL_ATTR
#define VEL_ATTR instanceVelocity
#endif
#ifdef VEL_OBJ
uniform vec3 uObjVel;
#else
attribute vec3 VEL_ATTR;
#endif
#ifdef VEL_POSE
attribute vec4 POSE_ATTR;
#ifdef VEL_SCALE
attribute vec4 SCALE_ATTR;
#endif
#endif
uniform float uHalfExp;
varying vec3 vV;
void main(){
  mat4 m = modelMatrix;
#ifdef USE_INSTANCING
  m = m * instanceMatrix;
#endif
  vec3 lp = position, ln = normal;
#ifdef VEL_POSE
  // [P3-A] seoul-life's crowd placement: scale, then yaw about +y in its (z, x) convention, then the instance position
#ifdef VEL_SCALE
  lp *= SCALE_ATTR.w;
#endif
  float cy = cos(POSE_ATTR.w), sy = sin(POSE_ATTR.w);
  lp = vec3(sy * lp.z + cy * lp.x, lp.y, cy * lp.z - sy * lp.x) + POSE_ATTR.xyz;
  ln = vec3(sy * ln.z + cy * ln.x, ln.y, cy * ln.z - sy * ln.x);
#endif
  vec4 wp = m * vec4(lp, 1.0);
#ifdef VEL_OBJ
  vec3 v = uObjVel;
#else
  vec3 v = VEL_ATTR;
#endif
  vec3 wn = normalize(mat3(m) * ln);
  vec4 c0 = projectionMatrix * viewMatrix * vec4(wp.xyz - v * uHalfExp, 1.0), c1 = projectionMatrix * viewMatrix * vec4(wp.xyz + v * uHalfExp, 1.0);
  vec2 d = (c0.w > 0.02 && c1.w > 0.02) ? 0.5 * (c1.xy / c1.w - c0.xy / c0.w) : vec2(0.0);
  vec4 mv = viewMatrix * wp;
  vV = vec3(d, -mv.z);
  gl_Position = projectionMatrix * (viewMatrix * vec4(wp.xyz + v * uHalfExp * (dot(wn, v) >= 0.0 ? 1.0 : -1.0), 1.0));   // swept footprint
}`,
        fragmentShader: /* glsl */`varying vec3 vV;
void main(){ gl_FragColor = vec4(vV, 1.0); }`,
      }),
      exp: [rt(1, 1, { filter: THREE.NearestFilter, type: THREE.HalfFloatType }), rt(1, 1, { filter: THREE.NearestFilter, type: THREE.HalfFloatType })], idx: 0,
      haloA: null, haloB: null, midRT: null, wideA: null, wideRT: null,
    };
    return this._nightP;
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
      if (this.look.night) { const N = this._initNight(); for (const p of [N.down, N.final, N.meter, N.blur, N.ghost]) r.compile(p.scene, this.quadCam); }
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

  // [P2-A] contract P2-A1 (object motion blur): the world lists its movers as InstancedMeshes in world.motionMeshes (or
  // scene.userData.motionMeshes); each geometry carries an `instanceVelocity` InstancedBufferAttribute (itemSize 3, world m/s, same
  // instance order as instanceMatrix, flagged needsUpdate with it). We draw proxies that share their geometry and instanceMatrix with
  // a velocity material into a half-res target; the night blur adds each mover's own smear. Absent: no object blur, no cost.
  // [P3-A] FPV #2: three kinds of mover (contract P3-A1, a superset of P2-A1), each with an `instanceVelocity` (or `iVel`) vec3 in m/s:
  //   'inst' an InstancedMesh (instanceMatrix order: vehicles);
  //   'pose' a Mesh on an InstancedBufferGeometry whose instances are placed by a vec4 (x, y, z, yaw) attribute (default `iPos`,
  //          seoul-life's crowd), optionally scaled by a vec4's .w (default `iAnim`); userData.motionPose = {pos, scale} renames them;
  //   'obj'  any Mesh with userData.velocity (Vector3 or [x, y, z], m/s): one rigid mover.
  // The proxies draw the source's geometry undeformed (no skinning or gait): the swept footprint only has to be about right.
  _velKind(src) {
    const g = src?.geometry, at = g?.attributes; if (!at) return null;
    const va = at.instanceVelocity ? 'instanceVelocity' : at.iVel ? 'iVel' : null;
    if (src.isInstancedMesh && va) return { k: 'inst', va };
    const mp = src.userData?.motionPose || {}, pa = mp.pos || 'iPos', sa = mp.scale || 'iAnim';
    if (src.isMesh && g.isInstancedBufferGeometry && va && at[pa]?.itemSize === 4) return { k: 'pose', va, pa, sa: at[sa]?.itemSize === 4 ? sa : null };
    const v = src.userData?.velocity;
    if (src.isMesh && v && (v.isVector3 || (Array.isArray(v) && v.length === 3))) return { k: 'obj' };
    return null;
  }
  _velMatFor(NP, kind) {
    const key = kind.k === 'obj' ? null : `${kind.k}|${kind.va}|${kind.pa || ''}|${kind.sa || ''}`;
    if (key && NP.velMats.has(key)) return NP.velMats.get(key);
    const defines = { VEL_ATTR: kind.va || 'instanceVelocity' };
    if (kind.k === 'pose') { defines.VEL_POSE = 1; defines.POSE_ATTR = kind.pa; if (kind.sa) { defines.VEL_SCALE = 1; defines.SCALE_ATTR = kind.sa; } }
    if (kind.k === 'obj') defines.VEL_OBJ = 1;
    const m = new THREE.ShaderMaterial({ defines, uniforms: { uHalfExp: NP.velMat.uniforms.uHalfExp, uObjVel: { value: new THREE.Vector3() } },
      vertexShader: NP.velMat.vertexShader, fragmentShader: NP.velMat.fragmentShader });
    if (key) NP.velMats.set(key, m);
    return m;
  }
  _velocityPass(world, NP, dw, dh, shutter) {
    const list = world.motionMeshes ?? world.scene?.userData?.motionMeshes;
    if (!Array.isArray(list) || !list.length) { if (NP.proxies.size) { for (const p of NP.proxies.values()) NP.velScene.remove(p); NP.proxies.clear(); } return false; }
    const r = this.r, seen = new Set(); let any = false;
    for (const src of list) {
      const kind = this._velKind(src); if (!kind) continue;
      let vis = true; for (let o = src; o; o = o.parent) if (!o.visible) { vis = false; break; }
      let p = NP.proxies.get(src);
      if (p && p.userData.velK !== kind.k) { NP.velScene.remove(p); NP.proxies.delete(src); p = null; }
      if (!p) {
        p = kind.k === 'inst' ? new THREE.InstancedMesh(src.geometry, this._velMatFor(NP, kind), 1) : new THREE.Mesh(src.geometry, this._velMatFor(NP, kind));
        p.matrixAutoUpdate = false; p.frustumCulled = false; p.userData.velK = kind.k; NP.proxies.set(src, p); NP.velScene.add(p);
      }
      p.geometry = src.geometry; p.matrix.copy(src.matrixWorld); p.matrixWorldNeedsUpdate = true;
      let n = 1;
      if (kind.k === 'inst') { p.instanceMatrix = src.instanceMatrix; p.count = src.count; n = src.count; }
      else if (kind.k === 'pose') n = src.geometry.instanceCount ?? 0;
      else { const v = src.userData.velocity; p.material.uniforms.uObjVel.value.set(v.isVector3 ? v.x : v[0], v.isVector3 ? v.y : v[1], v.isVector3 ? v.z : v[2]); }
      p.visible = vis && n > 0 && Number.isFinite(n); any ||= p.visible; seen.add(src);
    }
    for (const [s, p] of NP.proxies) if (!seen.has(s)) { NP.velScene.remove(p); NP.proxies.delete(s); if (p.userData.velK === 'obj') p.material.dispose(); }
    if (!any) return false;
    if (!NP.velRT || NP.velRT.width !== this.depthRT.width || NP.velRT.height !== this.depthRT.height) {
      NP.velRT?.dispose(); NP.velRT = rt(this.depthRT.width, this.depthRT.height, { filter: THREE.NearestFilter, type: THREE.HalfFloatType, depth: true });
    }
    NP.velMat.uniforms.uHalfExp.value = 0.5 * shutter;
    NP.velRT.viewport.set(0, 0, dw, dh);
    r.setRenderTarget(NP.velRT); r.setClearColor(0x000000, 0); r.clear(true, true, false);
    r.render(NP.velScene, this.cam);
    this._discard(NP.velRT, false);
    r.setClearColor(0x000000, 1);
    return true;
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
    const NI = !!(lk.night && this.hdr), NP = NI ? this._initNight() : null;      // [S3] night programs (L5)
    // [P2-A] FPV #6: the movers' own motion (contract P2-A1: world.motionMeshes or scene.userData.motionMeshes)
    const velOn = NI && lk.objBlur !== 0 && lk.shutter > 0 ? this._velocityPass(world, NP, dw, dh, lk.shutter) : false;

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
    if (NI) { NP.blur.u.tVel.value = velOn ? NP.velRT.texture : null; NP.blur.u.uVelOn.value = velOn ? 1 : 0; }
    r.setRenderTarget(this.blurRT); r.clear(true, false, false); r.render((NI ? NP.blur : this.blur).scene, this.quadCam);

    // 5) downsample (metering luma + bloom bright-pass), taps mapped through the lens: the meter and the halos see the
    //    displayed frame (output space), not the rectilinear render's corners and edge margins
    const prevExp = NI ? NP.exp[NP.idx] : this.exp[this.expIdx], nextExp = NI ? NP.exp[1 - NP.idx] : this.exp[1 - this.expIdx];
    const H = this.hdr ? 1 : 0, LS = this.hdr ? 16 : 1, F16 = this.f16 ? 1 : 0, LM = lk.meterLens ? 1 : 0;
    const du = this.down.u;
    du.tSrc.value = this.blurRT.texture; du.tExp.value = prevExp.texture;
    du.uScale.value.set(vw / this.blurRT.width, vh / this.blurRT.height);
    du.uTexel.value.set(1 / this.smallRT.width, 1 / this.smallRT.height);
    du.uClampLo.value.set(0.5 / vw, 0.5 / vh);
    du.uInv.value = lk.invTone; du.uThresh.value = NI ? 0.24 * Math.pow(2, Number.isFinite(lk.psfThEv) ? lk.psfThEv : (lk.clipEv ?? 3) - (lk.bloomKnee ?? 0.5)) : 1.0;
    du.uHdr.value = H; du.uLumScale.value = LS; du.uF16.value = F16; du.uLens.value = LM; du.uBloomCap.value = lk.bloomCap ?? 16;
    du.uWB.value.fromArray(lk.wb); du.uWBShade.value.fromArray(lk.wbShade || lk.wb);
    du.uHalf.value.set(L.hw, L.hh); du.uF.value = L.F; du.uK.value = L.k; du.uSrcTan.value.set(L.tx, L.ty);
    r.setRenderTarget(this.smallRT); r.clear(true, false, false); r.render((NI ? NP.down : this.down).scene, this.quadCam);

    // 6) auto-exposure with lag (GPU-side, no readback stalls)
    if (NI) {
      const nu = NP.meter.u;
      nu.tSmall.value = this.smallRT.texture; nu.tPrev.value = prevExp.texture; nu.uDt.value = tdt; nu.uBias.value = lk.evBias || 0;
      nu.uReset.value = this.resetExposure ? 1 : 0; this.resetExposure = false; this.final.u.uHdr.value = H;
      nu.uLock.value = lk.aeLock ? 1 : 0; nu.uLockEv.value = lk.aeLockEv || 0;
      nu.uEvMin.value = lk.evMin; nu.uEvMax.value = lk.evMax; nu.uClipL.value = 0.24 * Math.pow(2, lk.clipEv ?? 3);
      nu.uAe.value.fromArray(lk.ae || [0.25, 0.8, 0.7, 0.15]); nu.uReject.value = lk.aeReject ?? 0.02;
      nu.uVeilL.value = 0.24 * Math.pow(2, Number.isFinite(lk.veilCapEv) ? lk.veilCapEv : (lk.clipEv ?? 3));   // [P2-A]
      const aa = lk.aeArea; if (aa) nu.uArea.value.set(aa[0], aa[1], aa[2] ?? aa[1], aa[3] ?? 2); else nu.uArea.value.set(1e9, 1, 1, 2);
      if (lk.aeMatrix) nu.uMat.value.fromArray(lk.aeMatrix); else nu.uMat.value.set(0.45, 1.6);
      r.setRenderTarget(nextExp); r.clear(true, false, false); r.render(NP.meter.scene, this.quadCam);
      NP.idx = 1 - NP.idx;
    } else {
    const mu = this.meter.u;
    mu.tSmall.value = this.smallRT.texture; mu.tPrev.value = prevExp.texture;
    mu.uDt.value = tdt; mu.uBias.value = lk.evBias; mu.uInv.value = lk.invTone;
    mu.uHdr.value = H; mu.uLumScale.value = LS; mu.uF16.value = F16; this.final.u.uHdr.value = H;
    mu.uEvMin.value = lk.evMin; mu.uEvMax.value = lk.evMax; mu.uUp.value = lk.aeUp; mu.uDown.value = lk.aeDown;
    mu.uReset.value = this.resetExposure ? 1 : 0; this.resetExposure = false;
    mu.uHl.value.set(Number.isFinite(lk.hlEv) ? lk.hlEv : (Number.isFinite(lk.clipEv) ? lk.clipEv / (lk.con || 1) : 3), lk.hlGain || 0, lk.hlFrac || 0.04, lk.hlMax ?? 1);
    r.setRenderTarget(nextExp); r.clear(true, false, false); r.render(this.meter.scene, this.quadCam);
    this.expIdx = 1 - this.expIdx;
    }

    // 7) bloom: separable 9-tap gaussian at unit tap spacing (the linear-sampling offsets assume it), run twice
    const bw = this.smallRT.width, bh = this.smallRT.height;
    let src = this.smallRT;
    // [P2-A] night: the PSF's narrow lobe (FPV #2): psfNarrowIt passes at psfNarrowR texel spacing (bando: 2 passes at 1, as before)
    const nIt = NI ? Math.max(1, Math.min(2, lk.psfNarrowIt ?? 2)) : 2, nSp = NI ? (lk.psfNarrowR ?? 1) : 1;
    for (let it = 0; it < nIt; it++) {
      this.bloomH.u.tSrc.value = src.texture; this.bloomH.u.uDir.value.set(nSp / bw, 0);
      r.setRenderTarget(this.bloomA); r.clear(true, false, false); r.render(this.bloomH.scene, this.quadCam);
      this.bloomV.u.tSrc.value = this.bloomA.texture; this.bloomV.u.uDir.value.set(0, nSp / bh);
      r.setRenderTarget(this.bloomB); r.clear(true, false, false); r.render(this.bloomV.scene, this.quadCam);
      src = this.bloomB;
    }
    if (NI) {
      // [S3] wide halation: the bloom result at 1/16, blurred twice more (radius x haloR x (1 + 0.3 retro)); tinted in FINAL
      const hw = Math.max(8, Math.ceil(bw / 2)), hh = Math.max(5, Math.ceil(bh / 2));
      if (!NP.haloA || NP.haloA.width !== hw || NP.haloA.height !== hh) {
        NP.haloA?.dispose(); NP.haloB?.dispose();
        NP.haloA = rt(hw, hh, { type: THREE.HalfFloatType }); NP.haloB = rt(hw, hh, { type: THREE.HalfFloatType });
      }
      NP.copy.u.tSrc.value = this.bloomB.texture; NP.copy.u.uDir.value.set(0, 0);
      r.setRenderTarget(NP.haloB); r.clear(true, false, false); r.render(NP.copy.scene, this.quadCam);
      const rr = (lk.haloR ?? 1) * (1 + 0.3 * (lk.retro || 0));
      for (let it = 0; it < 2; it++) {
        NP.haloH.u.tSrc.value = NP.haloB.texture; NP.haloH.u.uDir.value.set(rr / hw, 0);
        r.setRenderTarget(NP.haloA); r.clear(true, false, false); r.render(NP.haloH.scene, this.quadCam);
        NP.haloV.u.tSrc.value = NP.haloA.texture; NP.haloV.u.uDir.value.set(0, rr / hh);
        r.setRenderTarget(NP.haloB); r.clear(true, false, false); r.render(NP.haloV.scene, this.quadCam);
      }
      // [P3-A] lens ghosts: point sources only, aperture-shaped, at 1/8 res (colour #5, FPV #6, graphics #3)
      const gs = (lk.ghosts || []).filter((g) => g && g[1] > 0);
      if (gs.length) {
        if (!NP.ghostRT || NP.ghostRT.width !== bw || NP.ghostRT.height !== bh) { NP.ghostRT?.dispose(); NP.ghostRT = rt(bw, bh, { type: THREE.HalfFloatType }); }
        const gu = NP.ghost.u;
        gu.tSmall.value = this.smallRT.texture; gu.tExp.value = nextExp.texture; gu.uGEv.value.fromArray(lk.ghostEv || [9, 10.5]);
        gu.uGChroma.value = lk.ghostChroma ?? 0.3; gu.uFringe.value = lk.ghostFringe ?? 0.08; gu.uBlades.value = lk.ghostBlades || 7; gu.uAspect.value = this.outW / this.outH;
        for (let i = 0; i < 3; i++) {
          const g = gs[i], G = gu.uG.value[i];
          // [scale, weight, radius (frame heights), tint]; the phase-2 form [scale, weight, tint] still reads (radius 0.05)
          if (g) { G.set(g[0], g[1] / (g[0] * g[0]), typeof g[2] === 'number' ? g[2] : 0.05, g[0] < 0 ? 0.3 + Math.PI : 0.3); gu.uGT.value[i].fromArray(Array.isArray(g[3]) ? g[3] : Array.isArray(g[2]) ? g[2] : [1, 1, 1]); } else G.set(1, 0, 0, 0);
        }
        r.setRenderTarget(NP.ghostRT); r.clear(true, false, false); r.render(NP.ghost.scene, this.quadCam);
      }
      NP.ghostOn = gs.length > 0;
      // [P4-A] the PSF's middle lobe (colour #4, lighting #4): the narrow lobe blurred again at 1/8 (haloM [energy, tap spacing
      // in 1/8 texels, passes]; sigma ~1.7 x spacing texels per pass), kept in the source's colour
      const hm = lk.haloM;
      NP.midOn = !!(hm && hm[0] > 0);
      if (NP.midOn) {
        if (!NP.midRT || NP.midRT.width !== bw || NP.midRT.height !== bh) { NP.midRT?.dispose(); NP.midRT = rt(bw, bh, { type: THREE.HalfFloatType }); }
        let ms = this.bloomB;
        for (let it = 0; it < Math.max(1, Math.min(3, hm[2] || 1)); it++) {
          NP.haloH.u.tSrc.value = ms.texture; NP.haloH.u.uDir.value.set((hm[1] ?? 1.5) / bw, 0);
          r.setRenderTarget(this.bloomA); r.clear(true, false, false); r.render(NP.haloH.scene, this.quadCam);
          NP.haloV.u.tSrc.value = this.bloomA.texture; NP.haloV.u.uDir.value.set(0, (hm[1] ?? 1.5) / bh);
          r.setRenderTarget(NP.midRT); r.clear(true, false, false); r.render(NP.haloV.scene, this.quadCam);
          ms = NP.midRT;
        }
      }
      // [P5-A] the second wide lobe (colour #5, lighting #6): the middle lobe at 1/16, blurred haloW[2] more passes at haloW[1]
      // 1/16 texels (3 passes at 2.2: sigma ~6 texels, ~100 px at 960 wide), in the source's colour
      const hwl = lk.haloW;
      NP.wideOn = NP.midOn && !!(hwl && hwl[0] > 0);
      if (NP.wideOn) {
        const ww = Math.max(8, Math.ceil(bw / 2)), wh = Math.max(5, Math.ceil(bh / 2));
        if (!NP.wideRT || NP.wideRT.width !== ww || NP.wideRT.height !== wh) {
          NP.wideA?.dispose(); NP.wideRT?.dispose();
          NP.wideA = rt(ww, wh, { type: THREE.HalfFloatType }); NP.wideRT = rt(ww, wh, { type: THREE.HalfFloatType });
        }
        NP.copy.u.tSrc.value = NP.midRT.texture; NP.copy.u.uDir.value.set(0, 0);
        r.setRenderTarget(NP.wideRT); r.clear(true, false, false); r.render(NP.copy.scene, this.quadCam);
        const ws = hwl[1] ?? 2.2;
        for (let it = 0; it < Math.max(1, Math.min(4, hwl[2] || 3)); it++) {
          NP.haloH.u.tSrc.value = NP.wideRT.texture; NP.haloH.u.uDir.value.set(ws / ww, 0);
          r.setRenderTarget(NP.wideA); r.clear(true, false, false); r.render(NP.haloH.scene, this.quadCam);
          NP.haloV.u.tSrc.value = NP.wideA.texture; NP.haloV.u.uDir.value.set(0, ws / wh);
          r.setRenderTarget(NP.wideRT); r.clear(true, false, false); r.render(NP.haloV.scene, this.quadCam);
        }
      }
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
    if (NI) {
      const nf = NP.final.u, rt0 = lk.retro || 0, ex = lk.expo;
      nf.tHalo.value = NP.haloB.texture; nf.uHalo.value = (lk.halo ?? 0.3) * (1 + 0.8 * rt0);
      const ht = lk.haloTint || [1, 0.62, 0.45], hl = 0.2126 * ht[0] + 0.7152 * ht[1] + 0.0722 * ht[2];
      nf.uHaloTint.value.set(ht[0] / hl, ht[1] / hl, ht[2] / hl);
      // AE target grey through the camera curve + toe -> Oklab L (the grade's shadow/highlight pivots)
      // [P2-A] the night curve is the filmic shoulder: grey maps to tone[2] by construction
      const tn = lk.tone || [1.0839, 0.928, 0.2194], wp = 0.24 * Math.pow(2, ce ?? 7.5), bc = nightToneBC(tn[0], tn[1], tn[2], wp);
      nf.uTone.value.set(tn[0], tn[1], bc[0], bc[1]); nf.uTonePc.value = lk.tonePc ?? 1;
      let tg = Math.min(1, tn[2]); const to = lk.toe || 0; if (to > 0) tg = tg * tg / (tg + to) * (1 + to);
      nf.uNightK.value.set(wp, lk.core ?? 1, Math.cbrt(tg));
      const cev = lk.coreEv || [1, 3]; nf.uCore.value.set(lk.coreXtalk ?? 0, cev[0], cev[1]);
      // [P3-A] true-source cores (off without coreSrc), retro shadow hue, vibrance gate
      const cs = lk.coreSrc, ces = lk.coreEvSrc || cev;
      if (cs) nf.uCoreSrc.value.set(cs[0], cs[1]); else nf.uCoreSrc.value.set(1e9, 2e9);
      nf.uCoreSrcK.value.set(lk.coreXtalkSrc ?? lk.coreXtalk ?? 0, ces[0], ces[1]); nf.uCoreW.value.fromArray(lk.coreW || [0.05, 0.35]);
      const rsh = lk.retroShadow || [205, 0.06]; nf.uRetroSh.value.set(rsh[0] * Math.PI / 180, rsh[1]);
      // [P6-A] split-tone gate: Oklab L fade-in (none: [0, 0] = always on) and the sky cut from this frame's collider depth
      const rg = lk.retroShGate || [0, 0]; nf.uRetroShG.value.set(rg[0], rg[1]);
      nf.tDepthN.value = this.depthRT.texture; nf.uDepthN.value.set(dw / this.depthRT.width, dh / this.depthRT.height, lk.retroShSky && world.colliderScene ? 1 : 0);
      const vg = lk.retroVibGate; if (vg) nf.uVibGate.value.set(vg[0] * Math.PI / 180, vg[1] * Math.PI / 180); else nf.uVibGate.value.set(7, 7);
      nf.uMag.value.set(lk.mag ?? 0.05, lk.magC ?? 0); nf.uMagEv.value.fromArray(lk.magEv || [0.7, 1.6, 2.6, 3.4]);
      nf.tSmall.value = this.smallRT.texture;
      const cd = lk.codec || [0, 0.02, 0.08, 0]; nf.uCodec.value.set(cd[0], cd[1], cd[2], cd[3]);
      nf.uSharpDark.value.fromArray(lk.sharpDark || [0, 0]);
      // noise lattice: a fresh random offset per frame (no fixed grid), last frame's offset kept for the 3DNR carry
      const nc = lk.noiseCell || [1.4, 8], fh = (k) => { let h = Math.imul((this.frame + 1) ^ k, 0x9e3779b1) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x85ebca77) >>> 0; h ^= h >>> 13; return (h >>> 0) / 4294967296; };
      const o = NP.noiseOff, oc = NP.noiseOffC;
      o[2] = o[0]; o[3] = o[1]; o[0] = fh(0x51) * 256 * nc[0]; o[1] = fh(0x7a) * 256 * nc[0];
      oc[2] = oc[0]; oc[3] = oc[1]; oc[0] = fh(0x13) * 256 * nc[1]; oc[1] = fh(0x2f) * 256 * nc[1];
      nf.tNoise.value = NP.noise; nf.uNoiseOff.value.fromArray(o); nf.uNoiseOffC.value.fromArray(oc);
      nf.uNoiseK.value.set(nc[0], nc[1], lk.noiseFloor ?? 0, lk.chromaDark ?? 1);
      nf.uGhostS.value.set(0, 0, 0, NP.ghostOn ? 1 : 0); nf.tGhost.value = NP.ghostOn ? NP.ghostRT.texture : NP.haloB.texture;
      // [P4-A] middle lobe: energy x8 when the bright pass is stored /8 (no half-float targets), as uBloom
      nf.tHaloM.value = NP.midOn ? NP.midRT.texture : NP.haloB.texture; nf.uHaloM.value = NP.midOn ? lk.haloM[0] * (this.f16 ? 1 : 8) : 0;
      const mt = lk.haloMTint || [1, 1, 1], ml = 0.2126 * mt[0] + 0.7152 * mt[1] + 0.0722 * mt[2];
      nf.uHaloMTint.value.set(mt[0] / ml, mt[1] / ml, mt[2] / ml);
      nf.tHaloW.value = NP.wideOn ? NP.wideRT.texture : NP.haloB.texture; nf.uHaloW.value = NP.wideOn ? lk.haloW[0] * (this.f16 ? 1 : 8) : 0;
      // [P7-A] the edge lobe (colour #3) and the canyon airlight (colour #1, fpv #2): air [target exposed luma, sign-hue share,
      // radius, tap cap], airLit [lit-canyon ramp]
      const he = lk.haloE; nf.uHaloE.value.set(Array.isArray(he) ? he[0] : he || 0, Array.isArray(he) ? he[1] ?? 16 : 16, Array.isArray(he) ? he[2] ?? 0 : 0, Array.isArray(he) ? he[3] ?? 1 : 1);
      const ai = lk.air, airOn = !!(ai && ai[0] > 0 && world.colliderScene);
      if (airOn) {
        const bw = this.smallRT.width, bh = this.smallRT.height;
        if (!NP.airRT || NP.airRT.width !== bw || NP.airRT.height !== bh) { NP.airRT?.dispose(); NP.airRT = rt(bw, bh, { type: THREE.HalfFloatType }); }
        const au = NP.air.u, at = lk.airTint || [1, 1, 1], al = 0.2126 * at[0] + 0.7152 * at[1] + 0.0722 * at[2];
        au.tSmall.value = this.smallRT.texture; au.tExp.value = nextExp.texture; au.tDepthN.value = this.depthRT.texture;
        au.uDepthS.value.set(dw / this.depthRT.width, dh / this.depthRT.height); au.uLens.value = LM;
        const lit = lk.airLit || [0.01, 0.04];
        au.uAir.value.set(lit[0], lit[1], ai[2] ?? 0.2, ai[3] ?? 4); au.uAirH.value = ai[1] ?? 0; au.uAirW.value.fromArray(lk.airEncl || [0.35, 0.8]);
        au.uAirTint.value.set(at[0] / al, at[1] / al, at[2] / al); au.uAspect.value = this.outW / this.outH;
        r.setRenderTarget(NP.airRT); r.clear(true, false, false); r.render(NP.air.scene, this.quadCam);
      }
      nf.tAir.value = airOn ? NP.airRT.texture : NP.haloB.texture; nf.uAirF.value.set(airOn ? 1 : 0, airOn ? ai[0] : 0, airOn ? ai[4] ?? 0 : 0);
      nf.uRetro.value = rt0; nf.uRetroVib.value = lk.retroVib ?? 0.5; nf.uRetroCA.value = (lk.retroCA || 0) * rt0 * 0.004;
      nf.uNoise.value.fromArray(lk.noise || [0.010, 0.0011, 1.6]); nf.uNoiseRGB.value.fromArray(lk.noiseRGB || [1.1, 0.8, 1.5]);
      nf.uNoiseEv.value.set(lk.evMax - (lk.noiseSpan ?? 6), lk.noiseSpan ?? 6);
      fu.uVeil.value = (lk.veil || 0) * (1 + rt0);
    }
    r.setRenderTarget(null);
    r.setViewport(0, 0, this.outW, this.outH);
    r.clear(true, false, false);
    r.render((NI ? NP.final : this.final).scene, this.quadCam);
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
      // [P2-A] night camera v2 (only when the night preset is on: bando's profile is unchanged)
      ...(lk.night ? { night: {
        tone: { curve: 'lottes2016 per channel: t = x^a / (x^(a d) b + c), x = exposed radiance; mix(hue-preserving on max(rgb), per-channel, tonePc); clamp 1',
          a: (lk.tone || [])[0], d: (lk.tone || [])[1], midIn: 0.24, midOut: (lk.tone || [])[2], whitePoint: 0.24 * Math.pow(2, ce ?? 7.5), bc: lk.tone ? nightToneBC(lk.tone[0], lk.tone[1], lk.tone[2], 0.24 * Math.pow(2, ce ?? 7.5)) : null, tonePc: lk.tonePc },
        core: { key: 'mix(min(rgb), max(rgb), xtalk) of the pre-halo exposure, EV over the white point; xtalk/ev blend to the source path by smoothstep(coreW, w) * smoothstep(coreSrc, max(scene rgb)), w = clamp(scene alpha - 1, 0, 1) (contract P3-B1, per tap through the shutter blur)', xtalk: lk.coreXtalk, ev: lk.coreEv,
          source: { radiance: lk.coreSrc, flagRamp: lk.coreW, xtalk: lk.coreXtalkSrc, ev: lk.coreEvSrc } },
        ghosts: { list: lk.ghosts, sourceEv: lk.ghostEv, chroma: lk.ghostChroma, fringe: lk.ghostFringe, blades: lk.ghostBlades, resolution: 1 / 8, taps: 37,
          model: 'G(p) = w / s^2 * mean over the aperture (radius R, per channel R * (1 +- fringe)) of S(0.5 + (p - o - 0.5) / s); S = desat(bright pass) * smoothstep(sourceEv, log2(block luma / 0.24))' },
        air: lk.air ? { target: lk.air[0], signHue: lk.air[1], ringRadius: lk.air[2], tapCap: lk.air[3], cap: lk.air[4] ?? null, tint: lk.airTint, enclosure: lk.airEncl, litCanyon: lk.airLit, model: 'on sky-depth pixels (collider depth >= ~90 m): e += max(target - luma(e), 0) x smoothstep(enclosure, share of 16 ring taps that are not sky) x smoothstep(litCanyon, mean exposed luma of those taps, each capped at tapCap) x mix(tint, signs hue, signHue) (luma 1) (contract P7-A)' } : null,
        retro: { shadow: lk.retroShadow, shadowGate: lk.retroShGate, shadowSkyCut: !!lk.retroShSky, vibGate: lk.retroVibGate, magenta: { amount: lk.mag, chromaGate: lk.magC, ev: lk.magEv, amberGate: lk.retroVibGate } },
        meter: { grid: [16, 12], reject: lk.aeReject, areaSource: lk.aeArea, areaRule: '[thr, weight, weight when > share of taps are area, share] (soft +-0.05)', matrix: lk.aeMatrix, veilCapEv: lk.veilCapEv, resetSolvesCap: true },
        psf: { brightPassEv: lk.psfThEv, narrow: { energy: lk.bloom, passes: lk.psfNarrowIt, spacing: lk.psfNarrowR }, wide: { energy: lk.halo, radius: lk.haloR, tint: lk.haloTint }, mid: { energy: lk.haloM?.[0] ?? 0, spacing: lk.haloM?.[1], passes: lk.haloM?.[2], tint: lk.haloMTint || [1, 1, 1] }, mid2: { energy: lk.haloW?.[0] ?? 0, spacing16: lk.haloW?.[1], passes: lk.haloW?.[2], tint: lk.haloMTint || [1, 1, 1], from: 'mid at 1/16' }, edge: { energy: Array.isArray(lk.haloE) ? lk.haloE[0] : lk.haloE || 0, cap: Array.isArray(lk.haloE) ? lk.haloE[1] : 16, ring: Array.isArray(lk.haloE) ? { energy: lk.haloE[2] ?? 0, radius8: lk.haloE[3] ?? 1 } : null, from: 'the 1/8 block radiance (no threshold), bright-pass hue, unblurred' }, ghosts: lk.ghosts, cap: lk.bloomCap },
        noise: { shot: (lk.noise || [])[0], read: (lk.noise || [])[1], chroma: (lk.noise || [])[2], floor: lk.noiseFloor, cellPx: lk.noiseCell, chromaDark: lk.chromaDark, temporal: 'mean of this and last frame lattice (corr 0.5)', texture: '256^2 gaussian, seed 0x9e3779b9 mulberry32' },
        codec: lk.codec, sharpDark: lk.sharpDark, objectBlur: { on: lk.objBlur, contract: 'P2-A1: world.motionMeshes / scene.userData.motionMeshes, geometry attribute instanceVelocity (m/s)' },
      } } : {}),
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
    if (want.has('exp')) {
      if (this.look.night && this._nightP) { const e = rd(this._nightP.exp[this._nightP.idx], 1, 1); if (e) S.exp = { ev: e.data[0], evRate: e.data[1], veilMean: e.data[2], pin: e.data[3] }; }
      else { const e = rd(this.exp[this.expIdx], 1, 1); if (e) S.exp = { ev: -5 + 10 * (e.data[0] + e.data[1] / 255), veilMean: e.data[2] }; }
    }
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
