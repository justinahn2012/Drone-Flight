#!/usr/bin/env node
// tools/bakelm.mjs — offline lightmaps for One Take FPV (round 3, stream A1). One command, from the repo root:
//
//   node tools/bakelm.mjs             full bake: 32 + 32 + 256 rays per texel (3 bounces), both skies, ~10-15 min on 2 cores
//   node tools/bakelm.mjs --quick     the same files at 8 + 8 + 48 rays (noisier): checks the pipeline in ~2-3 min
//   options: --threads N   --fresh (ignore checkpoints)   --verify (only compare the committed maps with a reference
//            path tracer)   --out DIR (default: the repo root)   --hdr DIR (Poly Haven 2k .hdr cache)
//
// Writes, flat in the repo root: lm_sunny.png, lm_overcast.png (RGB, per-channel log2 indirect irradiance),
// lm_aux.png (R = sky openness^1.15 within 40 m (24 m terrain) = the old per-vertex `ao`; G = dilated sun visibility
// for the sunny sky: kills shadow-map leaks), lm.json (geometryHash, atlas, ranges, effective sun directions, the sky
// light it was baked with). world-bando.js uses them when lm.json's hash matches its geometry, else it bakes per vertex.
//
// Method: the world comes from buildGeometry() (the exact runtime geometry and uv2). Every atlas texel gets a sample
// point on its surface. Pass 0: sun visibility (4 sub-texel shadow rays). Passes 1-3: a cosine gather per texel; a ray
// that leaves the world reads the HDR (sun clamped out exactly as loadSky does, x envI, rotated by SKIES[sky].rotY), a
// ray that hits a lightmapped surface reads that texel's albedo x (direct sun + the previous pass's indirect) — so
// pass k carries k bounces. Both skies share every ray. Between passes: chart-aware denoise, then the texels inside
// geometry and the gutters are filled from their chart. Custom BVH (binned SAH) in worker threads; resumable: each
// finished chunk is checkpointed under $TMPDIR/bakelm-<hash>-<mode>/ and a re-run continues where it stopped.
import { isMainThread, Worker, parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..');
const PI = Math.PI;

// ================================================================ ray tracing kernel (main + workers)
// BVH: NB = node bounds [minx miny minz maxx maxy maxz], NC = [first, count>0] for leaves, [left child, -(axis+1)]
// for inner nodes (right child = left + 1). TV = [v0, e1, e2] per triangle in leaf order, TO = original triangle id.
function makeTracer(S) {
  const { NB, NC, TV, TO, TK, TOp } = S, ST = new Int32Array(256), SD = new Float64Array(256), R = { t: 0, tri: -1, u: 0, v: 0 };
  // [A4] vegetation proxies (TK 3) in shadow rays: veg 0 = see through them, 1 = blocked with their opacity (stochastic)
  let vh = 0x2545f491; const vr = () => { vh = hash32(vh + 0x9e3779b9); return vh / 4294967296; };
  // closest hit: both children's boxes are tested at the parent, the nearer is visited first, and each stacked node
  // carries its entry distance so it is skipped without a box test once a closer hit is known
  let Ox = 0, Oy = 0, Oz = 0, Ix = 0, Iy = 0, Iz = 0, Sx = 0, Sy = 1, Sz = 2, Best = 0;
  function box(o) {   // entry distance or Infinity
    let t0 = (NB[o + Sx] - Ox) * Ix, t1 = (NB[o + 3 - Sx] - Ox) * Ix;
    const a0 = (NB[o + Sy] - Oy) * Iy, a1 = (NB[o + 5 - Sy] - Oy) * Iy; if (a0 > t0) t0 = a0; if (a1 < t1) t1 = a1;
    const b0 = (NB[o + Sz] - Oz) * Iz, b1 = (NB[o + 7 - Sz] - Oz) * Iz; if (b0 > t0) t0 = b0; if (b1 < t1) t1 = b1;
    return t0 <= t1 && t1 >= 0 && t0 <= Best ? t0 : Infinity;
  }
  function closest(ox, oy, oz, dx, dy, dz, tmax) {
    if (dx > -1e-12 && dx < 1e-12) dx = 1e-12; if (dy > -1e-12 && dy < 1e-12) dy = 1e-12; if (dz > -1e-12 && dz < 1e-12) dz = 1e-12;
    Ox = ox; Oy = oy; Oz = oz; Ix = 1 / dx; Iy = 1 / dy; Iz = 1 / dz; Sx = Ix < 0 ? 3 : 0; Sy = Iy < 0 ? 4 : 1; Sz = Iz < 0 ? 5 : 2; Best = tmax;
    let bk = -1, bu = 0, bv = 0;
    if (box(0) === Infinity) return false;
    let sp = 0; ST[sp] = 0; SD[sp++] = 0;
    while (sp > 0) {
      const n = ST[--sp]; if (SD[sp] > Best) continue;
      const c = NC[n * 2 + 1];
      if (c <= 0) {
        const l = NC[n * 2], tl = box(l * 6), tr = box(l * 6 + 6);
        if (tl === Infinity) { if (tr !== Infinity) { ST[sp] = l + 1; SD[sp++] = tr; } }
        else if (tr === Infinity) { ST[sp] = l; SD[sp++] = tl; }
        else if (tl <= tr) { ST[sp] = l + 1; SD[sp++] = tr; ST[sp] = l; SD[sp++] = tl; }
        else { ST[sp] = l; SD[sp++] = tl; ST[sp] = l + 1; SD[sp++] = tr; }
        continue;
      }
      for (let k = NC[n * 2], e = k + c; k < e; k++) {
        const b = k * 9, e1x = TV[b + 3], e1y = TV[b + 4], e1z = TV[b + 5], e2x = TV[b + 6], e2y = TV[b + 7], e2z = TV[b + 8];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-14 && det < 1e-14) continue;
        const inv = 1 / det, wx = ox - TV[b], wy = oy - TV[b + 1], wz = oz - TV[b + 2], u = (wx * px + wy * py + wz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = wy * e1z - wz * e1y, qy = wz * e1x - wx * e1z, qz = wx * e1y - wy * e1x, v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-5 && t < Best) { Best = t; bk = k; bu = u; bv = v; }
      }
    }
    if (bk < 0) return false;
    R.t = Best; R.tri = TO[bk]; R.u = bu; R.v = bv; return true;
  }
  function any(ox, oy, oz, dx, dy, dz, tmax, veg = 1, seed = 0) {
    if (seed) vh = seed;
    if (dx > -1e-12 && dx < 1e-12) dx = 1e-12; if (dy > -1e-12 && dy < 1e-12) dy = 1e-12; if (dz > -1e-12 && dz < 1e-12) dz = 1e-12;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    let sp = 0; ST[sp++] = 0;
    while (sp > 0) {
      const n = ST[--sp], o = n * 6;
      let t0 = (NB[o] - ox) * ix, t1 = (NB[o + 3] - ox) * ix; if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
      let a0 = (NB[o + 1] - oy) * iy, a1 = (NB[o + 4] - oy) * iy; if (a0 > a1) { const s = a0; a0 = a1; a1 = s; }
      if (a0 > t0) t0 = a0; if (a1 < t1) t1 = a1;
      a0 = (NB[o + 2] - oz) * iz; a1 = (NB[o + 5] - oz) * iz; if (a0 > a1) { const s = a0; a0 = a1; a1 = s; }
      if (a0 > t0) t0 = a0; if (a1 < t1) t1 = a1;
      if (t0 > t1 || t1 < 0 || t0 > tmax) continue;
      const c = NC[n * 2 + 1];
      if (c > 0) {
        for (let k = NC[n * 2], e = k + c; k < e; k++) {
          const b = k * 9, e1x = TV[b + 3], e1y = TV[b + 4], e1z = TV[b + 5], e2x = TV[b + 6], e2y = TV[b + 7], e2z = TV[b + 8];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-14 && det < 1e-14) continue;
          const inv = 1 / det, sx = ox - TV[b], sy = oy - TV[b + 1], sz = oz - TV[b + 2], u = (sx * px + sy * py + sz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t > 1e-5 && t < tmax) {
            if (TK[TO[k]] === 3 && (!veg || vr() >= TOp[TO[k]])) continue;
            return true;
          }
        }
      } else { ST[sp++] = NC[n * 2]; ST[sp++] = NC[n * 2] + 1; }
    }
    return false;
  }
  return { closest, any, R };
}
const hash32 = (x) => { x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16; return x >>> 0; };

// per-texel work (workers). C = constants, S = shared arrays.
function makeWorker(S, C) {
  const tr = makeTracer(S), R = tr.R;
  const { SP, SN, SG, SD, TK, TFo, TU, BS, BO, ENVS, ENVO, OS, OO, OA, OB, OV1, OV2, OVO, TOp, TOcc, TAlb } = S;
  const { W, H, EW, EH } = C;
  const envIdx = (cr, sr, dx, dy, dz) => {   // texel of the (rotated) pi * radiance table
    const x = dx * cr - dz * sr, z = dx * sr + dz * cr;
    let px = Math.floor((Math.atan2(z, x) / (2 * PI) + 0.5) * EW); if (px >= EW) px -= EW; if (px < 0) px += EW;
    let py = Math.floor((0.5 - Math.asin(dy < -1 ? -1 : dy > 1 ? 1 : dy) / PI) * EH); if (py >= EH) py = EH - 1; if (py < 0) py = 0;
    return (py * EW + px) * 3;
  };
  const sameRot = C.crs === C.cro && C.srs === C.sro;
  const frame = (nx, ny, nz, out) => {   // branchless orthonormal basis (Duff et al. 2017)
    const s = nz >= 0 ? 1 : -1, a = -1 / (s + nz), b = nx * ny * a;
    out[0] = 1 + s * nx * nx * a; out[1] = s * b; out[2] = -s * nx; out[3] = b; out[4] = s + ny * ny * a; out[5] = -ny;
  };
  const F = new Float64Array(6);
  function sun(i, eps) {   // pass 0: mean and any of 4 sub-texel shadow rays, sunny (and overcast when it casts)
    const px = SP[i * 3], py = SP[i * 3 + 1], pz = SP[i * 3 + 2], nx = SN[i * 3], ny = SN[i * 3 + 1], nz = SN[i * 3 + 2], gx = SG[i * 3], gy = SG[i * 3 + 1], gz = SG[i * 3 + 2];
    frame(nx, ny, nz, F);
    // [A4] m (bounce radiosity) counts vegetation proxies as partial blockers; a (the runtime sun mask, aux.g) ignores
    // them, so leaf shadows stay the shadow map's (alpha-tested cards), never a proxy hull's blob
    const one = (L, shadowed) => {
      if (nx * L[0] + ny * L[1] + nz * L[2] <= 0) return [0, 0];
      if (!shadowed) return [1, 1];
      let m = 0, a = 0;
      for (let k = 0; k < 4; k++) {
        const sa = (k & 1 ? 0.25 : -0.25) * C.texel, sb = (k & 2 ? 0.25 : -0.25) * C.texel;
        const ox = px + gx * eps + F[0] * sa + F[3] * sb, oy = py + gy * eps + F[1] * sa + F[4] * sb, oz = pz + gz * eps + F[2] * sa + F[5] * sb;
        if (!tr.any(ox, oy, oz, L[0], L[1], L[2], 1e4, 0)) { a = 1; if (!C.hasVeg || !tr.any(ox, oy, oz, L[0], L[1], L[2], 1e4, 1, (i * 4 + k + 1) >>> 0)) m += 0.25; }
      }
      return [m, a];
    };
    const s = one(C.Ls, true); OV1[i] = s[0]; OV2[i] = s[1];
    OVO[i] = one(C.Lo, C.oShadow)[0];
    return C.oShadow ? 8 : 4;
  }
  function gather(i, rays, nu, nv, seed, eps) {
    const px = SP[i * 3], py = SP[i * 3 + 1], pz = SP[i * 3 + 2], nx = SN[i * 3], ny = SN[i * 3 + 1], nz = SN[i * 3 + 2], gx = SG[i * 3], gy = SG[i * 3 + 1], gz = SG[i * 3 + 2];
    frame(nx, ny, nz, F);
    const ox = px + gx * eps, oy = py + gy * eps, oz = pz + gz * eps, maxD = SD[i];
    let s0 = 0, s1 = 0, s2 = 0, o0 = 0, o1 = 0, o2 = 0, open = 0, back = 0;
    let h = hash32((i * 9781 + seed * 6271 + 1) >>> 0);
    for (let k = 0; k < rays; k++) {
      h = hash32(h + 0x9e3779b9); const r1 = h / 4294967296; h = hash32(h + 0x9e3779b9); const r2 = h / 4294967296;
      const u1 = ((k % nu) + r1) / nu, u2 = (((k / nu) | 0) + r2) / nv, rr = Math.sqrt(u1), ph = 2 * PI * u2, lx = rr * Math.cos(ph), ly = rr * Math.sin(ph), lz = Math.sqrt(Math.max(0, 1 - u1));
      let dx = F[0] * lx + F[3] * ly + nx * lz, dy = F[1] * lx + F[4] * ly + ny * lz, dz = F[2] * lx + F[5] * ly + nz * lz;
      const dg = dx * gx + dy * gy + dz * gz;
      if (dg < 1e-3) { dx -= (dg - 1e-3) * 2 * gx; dy -= (dg - 1e-3) * 2 * gy; dz -= (dg - 1e-3) * 2 * gz; const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l; }
      // [A4] vegetation proxies (TK 3): a front-face hit stops the ray with the proxy's opacity, a back-face hit (the
      // texel sits inside a crown or shrub hull) with half of it; otherwise the ray goes on through (<= 6 crossings)
      let hit = false, vegBack = false, trav = 0, qx = ox, qy = oy, qz = oz;
      for (let pass = 0; pass < 6; pass++) {
        if (!tr.closest(qx, qy, qz, dx, dy, dz, 1e5)) break;
        const tt = R.tri;
        if (TK[tt] !== 3) { hit = true; break; }
        const fdot = dx * TFo[tt * 3] + dy * TFo[tt * 3 + 1] + dz * TFo[tt * 3 + 2];
        h = hash32(h + 0x632be5ab);
        if (h / 4294967296 < TOp[tt] * (fdot > 0 ? 0.5 : 1)) { hit = true; vegBack = fdot > 0; break; }
        trav += R.t + 1e-3; qx += dx * (R.t + 1e-3); qy += dy * (R.t + 1e-3); qz += dz * (R.t + 1e-3);
      }
      if (!hit) {
        open++;
        const es = envIdx(C.crs, C.srs, dx, dy, dz), eo = sameRot ? es : envIdx(C.cro, C.sro, dx, dy, dz);
        s0 += ENVS[es]; s1 += ENVS[es + 1]; s2 += ENVS[es + 2]; o0 += ENVO[eo]; o1 += ENVO[eo + 1]; o2 += ENVO[eo + 2];
        continue;
      }
      if (R.t + trav > maxD) open++;
      const t = R.tri, fx = TFo[t * 3], fy = TFo[t * 3 + 1], fz = TFo[t * 3 + 2];
      if (TK[t] === 3) {   // inside: shaded sky only; outside: the proxy's own estimate (as the treeline's, its albedo x occ)
        const a = t * 3, oc = TOcc[t] * (vegBack ? 0.5 : 1), cs = vegBack ? 0 : Math.max(0, fx * C.Ls[0] + fy * C.Ls[1] + fz * C.Ls[2]), co = vegBack ? 0 : Math.max(0, fx * C.Lo[0] + fy * C.Lo[1] + fz * C.Lo[2]), sk = vegBack ? 0.5 : 0.5 + 0.5 * fy;
        s0 += TAlb[a] * oc * (C.SUNs[0] * cs + C.SKYs[0] * sk); s1 += TAlb[a + 1] * oc * (C.SUNs[1] * cs + C.SKYs[1] * sk); s2 += TAlb[a + 2] * oc * (C.SUNs[2] * cs + C.SKYs[2] * sk);
        o0 += TAlb[a] * oc * (C.SUNo[0] * co + C.SKYo[0] * sk); o1 += TAlb[a + 1] * oc * (C.SUNo[1] * co + C.SKYo[1] * sk); o2 += TAlb[a + 2] * oc * (C.SUNo[2] * co + C.SKYo[2] * sk);
        continue;
      }
      if (dx * fx + dy * fy + dz * fz > 0) { if (TK[t] === 0) back++; continue; }
      if (TK[t] === 0) {
        const b = t * 6, w1 = R.u, w2 = R.v;
        let tx = Math.floor(TU[b] + w1 * (TU[b + 2] - TU[b]) + w2 * (TU[b + 4] - TU[b])), ty = Math.floor(TU[b + 1] + w1 * (TU[b + 3] - TU[b + 1]) + w2 * (TU[b + 5] - TU[b + 1]));
        if (tx < 0) tx = 0; if (tx >= W) tx = W - 1; if (ty < 0) ty = 0; if (ty >= H) ty = H - 1;
        const q = (ty * W + tx) * 3;
        s0 += BS[q]; s1 += BS[q + 1]; s2 += BS[q + 2]; o0 += BO[q]; o1 += BO[q + 1]; o2 += BO[q + 2];
      } else {   // far field / treeline proxies: open and sunlit, estimated
        const a = TK[t] === 1 ? C.aFar : C.aLeaf, occ = TK[t] === 1 ? 1 : 0.6;
        const cs = Math.max(0, fx * C.Ls[0] + fy * C.Ls[1] + fz * C.Ls[2]), co = Math.max(0, fx * C.Lo[0] + fy * C.Lo[1] + fz * C.Lo[2]), sk = 0.5 + 0.5 * fy;
        s0 += a[0] * occ * (C.SUNs[0] * cs + C.SKYs[0] * sk); s1 += a[1] * occ * (C.SUNs[1] * cs + C.SKYs[1] * sk); s2 += a[2] * occ * (C.SUNs[2] * cs + C.SKYs[2] * sk);
        o0 += a[0] * occ * (C.SUNo[0] * co + C.SKYo[0] * sk); o1 += a[1] * occ * (C.SUNo[1] * co + C.SKYo[1] * sk); o2 += a[2] * occ * (C.SUNo[2] * co + C.SKYo[2] * sk);
      }
    }
    const iv = 1 / rays;
    OS[i * 3] = s0 * iv; OS[i * 3 + 1] = s1 * iv; OS[i * 3 + 2] = s2 * iv; OO[i * 3] = o0 * iv; OO[i * 3 + 1] = o1 * iv; OO[i * 3 + 2] = o2 * iv;
    OA[i] = open * iv; OB[i] = back * iv;
    return rays;
  }
  return { sun, gather, tracer: tr, envIdx };
}

function workerMain() {
  const { S, C } = workerData, w = makeWorker(S, C), ctrl = S.ctrl;
  parentPort.on('message', (m) => {
    if (m.cmd !== 'pass') return;
    const { pass, rays, nu, nv, cs, nChunks, NS, done } = m;
    for (;;) {
      const c = Atomics.add(ctrl, 0, 1); if (c >= nChunks) break;
      if (done[c]) continue;
      const i0 = c * cs, i1 = Math.min(NS, i0 + cs); let n = 0;
      for (let i = i0; i < i1; i++) n += pass === 0 ? w.sun(i, C.eps) : w.gather(i, rays, nu, nv, pass, C.eps);
      parentPort.postMessage({ cmd: 'chunk', c, rays: n });
    }
    parentPort.postMessage({ cmd: 'idle' });
  });
}

// ================================================================ main
if (!isMainThread) workerMain();
else await main();

async function main() {
  const argv = process.argv.slice(2), has = (f) => argv.includes(f), arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const quick = has('--quick'), fresh = has('--fresh'), verifyOnly = has('--verify');
  const threads = Math.max(1, +arg('--threads', Math.min(8, os.availableParallelism?.() ?? os.cpus().length)));
  const OUT = path.resolve(arg('--out', ROOT)), HDRDIR = arg('--hdr', '/home/claude/dl/ph/files');
  // [A4] the final pass filters r 1 (full) / r 2 (quick), cross-bilateral (lighting #3); [r, sigma, range sigma log2]
  const RAYS = quick ? [8, 8, 48] : [32, 32, 256], FILT = quick ? [[5, 2.5, 0], [5, 2.5, 0], [2, 1.2, 0.9]] : [[4, 2.0, 0], [4, 2.0, 0], [1, 0.8, 0.7]];
  const T0 = performance.now(), log = (...a) => console.log(`[${((performance.now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

  const THREE = await import('three');
  const { HDRLoader } = await import('three/addons/loaders/HDRLoader.js');
  const wb = await import(path.join(ROOT, 'world-bando.js'));
  const { buildGeometry, lightmapUV2, geometryHash, lmBakeInputs, SKIES, LMUV } = wb;

  // ---------------------------------------------------------------- world + atlas
  const geo = buildGeometry();
  const hash = geometryHash(geo);
  const lay = lightmapUV2(geo.merged, geo.terr, geo.pathG, { detail: true });   // same layout again, with chart detail
  if (geometryHash(geo) !== hash) throw new Error('lightmapUV2 is not idempotent: the hash moved');
  { // cross-check against stream G's tools/geohash.mjs (world.json hash.worldBando must equal lm.json hash)
    const G = await import(path.join(HERE, 'geohash.mjs')).catch(() => null);
    if (G) {
      const L = geo.terr.userData.lm, h = new G.GeoHash().str('lightmap').str(`${L.ver}:${L.W}x${L.H}:${L.texel}:${L.terrTexel}`), list = [...Object.entries(geo.merged), ['terr', geo.terr]];
      h.word(list.length);
      for (const [n, g] of list) { h.str(n).word(g.attributes.position.count); for (const k of ['position', 'normal', 'uv2']) h.str(k).word(g.attributes[k].itemSize).array(g.attributes[k].array); h.str('index').array(g.index.array); }
      if (h.hex() !== hash) throw new Error(`geometryHash ${hash} != tools/geohash.mjs ${h.hex()}`);
    }
  }
  const IN = lmBakeInputs(geo), W = lay.W, H = lay.H, WH = W * H;
  log(`world ${hash}: atlas ${W}x${H}, texel ${lay.texel} m (terrain ${lay.terrTexel} m), ${lay.charts} charts`);

  // ---------------------------------------------------------------- skies (loadSky's measurement, replicated)
  const skyOf = async (key) => {
    const def = SKIES[key], file = path.join(HDRDIR, `${def.id}_2k.hdr`);
    const envI = IN.envIOf ? IN.envIOf(def) : IN.envI;   // [A4] decision 2: 0.85 x bgI (sunny 1.7)
    let buf;
    if (fs.existsSync(file)) buf = fs.readFileSync(file);
    else {
      const url = `${IN.PH}/HDRIs/hdr/2k/${def.id}_2k.hdr`, tmp = path.join(os.tmpdir(), `${def.id}_2k.hdr`);
      if (!fs.existsSync(tmp)) { log('downloading', url); const r = await fetch(url); if (!r.ok) throw new Error(`HDR download failed ${r.status}`); fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer())); }
      buf = fs.readFileSync(tmp);
    }
    const tex = new HDRLoader().setDataType(THREE.FloatType).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const Wh = tex.width, Hh = tex.height, D = tex.data, ch = D.length / (Wh * Hh);
    const L = new THREE.Vector3(...def.sunDir).normalize(), rotY = def.rotY || 0;
    let maxL = 0, mi = 0; for (let i = 0; i < Wh * Hh; i++) { const l = 0.2126 * D[i * ch] + 0.7152 * D[i * ch + 1] + 0.0722 * D[i * ch + 2]; if (l > maxL) { maxL = l; mi = i; } }
    const cosP = new Float64Array(Wh), sinP = new Float64Array(Wh); for (let px = 0; px < Wh; px++) { const ph = ((px + 0.5) / Wh - 0.5) * 2 * PI; cosP[px] = Math.cos(ph); sinP[px] = Math.sin(ph); }
    const latOf = (py) => (0.5 - (py + 0.5) / Hh) * PI, T = Math.max(8, Math.min(40, maxL * 0.05)), E = [0, 0, 0], skyE = [0, 0, 0];
    for (let py = 0; py < Hh; py++) {
      const lat = latOf(py), cl = Math.cos(lat), sl = Math.sin(lat), dO = (2 * PI / Wh) * (PI / Hh) * cl;
      for (let px = 0; px < Wh; px++) {
        const i = (py * Wh + px) * ch, l = 0.2126 * D[i] + 0.7152 * D[i + 1] + 0.0722 * D[i + 2];
        if (l > T) { const k = (l - T) / l, cosT = Math.max(0, cosP[px] * cl * L.x + sl * L.y + sinP[px] * cl * L.z); for (let c = 0; c < 3; c++) { E[c] += D[i + c] * k * dO * cosT; D[i + c] *= 1 - k; } }
        if (lat > 0) { const w = dO * sl; skyE[0] += D[i] * w; skyE[1] += D[i + 1] * w; skyE[2] += D[i + 2] * w; }
      }
    }
    const Ei = Math.max(...E), skyLum = 0.2126 * skyE[0] + 0.7152 * skyE[1] + 0.0722 * skyE[2];
    const sunColor = Ei > 1e-2 ? E.map((v) => v / Ei) : [1, 1, 1], sunI = Math.min(16, Math.max(Ei > 1e-2 ? Ei : 0, (def.sunRatio || 0) * skyLum * envI));
    const gA = IN.ground, gR = [0, 1, 2].map((c) => (gA[c] * (sunI * Math.max(0, L.y) * sunColor[c] + skyE[c] * envI)) / PI);   // ground radiance
    // pi * radiance table, 256 x 128, box-filtered; below the horizon -> the lit ground (as the PMREM source)
    const EW = 256, EH = 128, tab = new Float32Array(EW * EH * 3), fx = Wh / EW, fy = Hh / EH;
    for (let ty = 0; ty < EH; ty++) for (let tx = 0; tx < EW; tx++) {
      const acc = [0, 0, 0]; let n = 0;
      for (let y = ty * fy; y < (ty + 1) * fy; y++) for (let x = tx * fx; x < (tx + 1) * fx; x++) { const i = (y * Wh + x) * ch; acc[0] += D[i]; acc[1] += D[i + 1]; acc[2] += D[i + 2]; n++; }
      const latD = (0.5 - (ty + 0.5) / EH) * 180, t0 = Math.min(1, Math.max(0, (0 - latD) / 2)), t = t0 * t0 * (3 - 2 * t0);
      for (let c = 0; c < 3; c++) tab[(ty * EW + tx) * 3 + c] = PI * envI * (acc[c] / n + (gR[c] / envI - acc[c] / n) * t);
    }
    // world sun: stream A2's skySunDir() when present (same as here: the HDR's sun turned by +rotY about Y); the sky
    // is looked up at R(-rotY) * w (envIdx), exactly as three samples a background/env with rotation (0, rotY, 0)
    if (def.sunRatio > 0) {   // the HDR's brightest pixel, turned by +rotY, must sit on the world sun (rotation sign check)
      const ph = ((mi % Wh + 0.5) / Wh - 0.5) * 2 * PI, la = (0.5 - (Math.floor(mi / Wh) + 0.5) / Hh) * PI;
      const m = new THREE.Vector3(Math.cos(ph) * Math.cos(la), Math.sin(la), Math.sin(ph) * Math.cos(la)).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
      const Lc = typeof wb.skySunDir === 'function' ? wb.skySunDir(def) : L.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
      if (m.angleTo(Lc) > 0.05) throw new Error(`${key}: HDR sun pixel lands at ${m.toArray().map((v) => v.toFixed(3))} but the world sun is ${Lc.toArray().map((v) => v.toFixed(3))}`);
    }
    const Lw = typeof wb.skySunDir === 'function' ? wb.skySunDir(def).normalize() : L.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    return { key, id: def.id, rotY, sunDir: Lw.toArray(), sunI, sunColor, SUN: sunColor.map((v) => v * sunI), skyB: skyE.map((v) => v * envI), tab, EW, EH, shadows: sunI > 0.5, envI, sunRatio: def.sunRatio || 0, bgI: def.bgI ?? 1 };
  };
  const SKY = { sunny: await skyOf('sunny'), overcast: await skyOf('overcast') };
  for (const s of Object.values(SKY)) log(`sky ${s.key} (${s.id}): envI ${s.envI.toFixed(3)} sunI ${s.sunI.toFixed(2)} sun [${s.sunColor.map((v) => v.toFixed(3))}] skyB [${s.skyB.map((v) => v.toFixed(3))}] sunDir [${s.sunDir.map((v) => v.toFixed(4))}] rotY ${s.rotY}`);

  // ---------------------------------------------------------------- trace scene: merged + terrain (lightmapped), far field + treeline proxies
  const parts = [];   // [kind, positions, normals|null, uv2|null, index]
  for (const G of lay.geos) parts.push([0, G.g.attributes.position.array, G.g.attributes.normal.array, G.g.attributes.uv2.array, G.g.index.array]);
  parts.push([0, geo.terr.attributes.position.array, geo.terr.attributes.normal.array, geo.terr.attributes.uv2.array, geo.terr.index.array]);
  { // the collider's tail after the solids + terrain: the far field and the treeline proxies
    // MeshBVH reorders colGeo.index (built without `indirect`), so the tail is found by VERTEX index, never by
    // triangle position (that picked up a spatial chunk of the hall as shadowless 'leaf': panel round 3, lighting #1)
    let solidV = 0; for (const list of Object.values(geo.site.parts)) for (const e of list) if (e.collide) solidV += e.g.attributes.position.count;
    const ci = geo.colGeo.index.array, cp = geo.colGeo.attributes.position.array, vStart = solidV + geo.terr.attributes.position.count;
    const far = [], prox = [];
    let inSite = 0;
    for (let k = 0; k < ci.length; k += 3) {
      const a = ci[k], b = ci[k + 1], c = ci[k + 2];
      if (a < vStart) continue;
      const cx = (cp[a * 3] + cp[b * 3] + cp[c * 3]) / 3, cz = (cp[a * 3 + 2] + cp[b * 3 + 2] + cp[c * 3 + 2]) / 3;
      if (Math.abs(cx) < 95 && Math.abs(cz) < 65) inSite++;
      const ux = cp[b * 3] - cp[a * 3], uz = cp[b * 3 + 2] - cp[a * 3 + 2], vx = cp[c * 3] - cp[a * 3], vz = cp[c * 3 + 2] - cp[a * 3 + 2];
      (Math.abs(ux * vz - uz * vx) / 2 > 500 ? far : prox).push(a, b, c);
    }
    if (inSite) throw new Error(`far-field/proxy selection has ${inSite} triangles inside the site: collider tail mis-selected`);
    log(`collider tail: ${far.length / 3} far-field + ${prox.length / 3} proxy triangles, 0 inside the site`);
    parts.push([1, cp, null, null, Uint32Array.from(far)], [2, cp, null, null, Uint32Array.from(prox)]);
  }
  // [A4] contract C10: vegetation proxies (stream V1, optional) = geo.vegProxies or geo.site.vegProxies. Each entry is a
  // BufferGeometry in world space (position, optional index; userData.occ / opacity / albedo) or a plain object
  // { position: [x, y, z, ...], index?: [...], occ?: 0.6, opacity?: 1, albedo?: [r, g, b] }. occ = how much of the light
  // reaching the crown it sends back (self-shading, lighting #5: 0.6), opacity = the share of rays the hull stops (1 = a
  // solid crown, ~0.6 for a loose shrub). They occlude the bounce light and the sky (and dim the bounce radiosity under
  // them), but never the runtime sun mask (aux.g): leaf shadows stay the shadow map's.
  const vegList = wb.vegProxyList ? wb.vegProxyList(geo) : [];
  let vegTris = 0;
  for (const v of vegList) { parts.push([3, v.position, null, null, v.index, v]); vegTris += v.index.length / 3; }
  if (vegList.length) log(`vegetation proxies: ${vegList.length} entries, ${vegTris} triangles`);
  let NVg = 0, NT = 0; for (const p of parts) { NVg += p[1].length / 3; NT += p[4].length / 3; }
  const SAB = (T, n) => new T(new SharedArrayBuffer(T.BYTES_PER_ELEMENT * Math.max(1, n)));
  const VP = new Float32Array(NVg * 3), TI = new Uint32Array(NT * 3), TK = SAB(Uint8Array, NT), TFo = SAB(Float32Array, NT * 3), TU = SAB(Float32Array, NT * 6);
  const TOp = SAB(Float32Array, NT), TOcc = SAB(Float32Array, NT), TAlb = SAB(Float32Array, NT * 3);   // [A4] per-triangle veg proxy data
  {
    let vo = 0, to = 0;
    for (const [kind, p, n, u, ix, meta] of parts) {
      VP.set(p, vo * 3);
      for (let k = 0; k < ix.length; k += 3, to++) {
        const a = ix[k], b = ix[k + 1], c = ix[k + 2];
        TI[to * 3] = a + vo; TI[to * 3 + 1] = b + vo; TI[to * 3 + 2] = c + vo; TK[to] = kind;
        const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2], vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
        let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx; const l = Math.hypot(fx, fy, fz) || 1; fx /= l; fy /= l; fz /= l;
        if (n) { const sx = n[a * 3] + n[b * 3] + n[c * 3], sy = n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1], sz = n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2]; if (fx * sx + fy * sy + fz * sz < 0) { fx = -fx; fy = -fy; fz = -fz; } }
        TFo[to * 3] = fx; TFo[to * 3 + 1] = fy; TFo[to * 3 + 2] = fz;
        if (meta) { TOp[to] = meta.opacity; TOcc[to] = meta.occ; TAlb[to * 3] = meta.albedo[0]; TAlb[to * 3 + 1] = meta.albedo[1]; TAlb[to * 3 + 2] = meta.albedo[2]; }
        if (u) for (let j = 0; j < 3; j++) { const v = ix[k + j]; TU[to * 6 + j * 2] = u[v * 2] * W; TU[to * 6 + j * 2 + 1] = u[v * 2 + 1] * H; }
      }
      vo += p.length / 3;
    }
  }
  let t1 = performance.now();
  const bvh = buildBVH(VP, TI, SAB);
  log(`trace scene: ${NT} triangles, BVH ${bvh.nodes} nodes in ${Math.round(performance.now() - t1)} ms`);

  // ---------------------------------------------------------------- texel samples
  t1 = performance.now();
  const smp = makeSamples(lay, geo, IN, W, H, SAB);
  const NS = smp.NS;
  log(`samples: ${NS} texels (${(NS / WH * 100).toFixed(1)} % of the atlas) in ${Math.round(performance.now() - t1)} ms`);

  const S = {
    NB: bvh.NB, NC: bvh.NC, TV: bvh.TV, TO: bvh.TO, TK, TFo, TU, TOp, TOcc, TAlb, SP: smp.SP, SN: smp.SN, SG: smp.SG, SD: smp.SD,
    BS: SAB(Float32Array, WH * 3), BO: SAB(Float32Array, WH * 3), ENVS: SAB(Float32Array, SKY.sunny.tab.length), ENVO: SAB(Float32Array, SKY.overcast.tab.length),
    OS: SAB(Float32Array, NS * 3), OO: SAB(Float32Array, NS * 3), OA: SAB(Float32Array, NS), OB: SAB(Float32Array, NS),
    OV1: SAB(Float32Array, NS), OV2: SAB(Float32Array, NS), OVO: SAB(Float32Array, NS), ctrl: SAB(Int32Array, 16),
  };
  S.ENVS.set(SKY.sunny.tab); S.ENVO.set(SKY.overcast.tab);
  const C = {
    W, H, EW: SKY.sunny.EW, EH: SKY.sunny.EH, texel: lay.texel, eps: 0.004,
    Ls: SKY.sunny.sunDir, Lo: SKY.overcast.sunDir, oShadow: SKY.overcast.shadows,
    crs: Math.cos(SKY.sunny.rotY), srs: Math.sin(SKY.sunny.rotY), cro: Math.cos(SKY.overcast.rotY), sro: Math.sin(SKY.overcast.rotY),
    SUNs: SKY.sunny.SUN, SUNo: SKY.overcast.SUN, SKYs: SKY.sunny.skyB, SKYo: SKY.overcast.skyB, aFar: IN.ground, aLeaf: IN.leaf,
    hasVeg: vegTris > 0,
  };

  if (verifyOnly) { await verify({ THREE, wb, geo, lay, S, C, SKY, smp, OUT, log, W, H }); return; }
  if (has('--bench')) {   // single-thread kernel throughput in rays per cpu-second (load-independent), every 97th texel
    const wk = makeWorker(S, C), go = (label, fn) => { const c0 = process.cpuUsage(); let n = 0; for (let i = 0; i < NS; i += 97) n += fn(i); const cu = process.cpuUsage(c0), s = (cu.user + cu.system) / 1e6; log(`bench ${label}: ${(n / 1e6).toFixed(2)} M rays, ${s.toFixed(1)} cpu-s, ${(n / s / 1e6).toFixed(3)} Mrays/cpu-s`); return n / s; };
    go('warm-up', (i) => wk.gather(i, 4, 2, 2, 9, C.eps));
    const g = go('gather 64', (i) => wk.gather(i, 64, 8, 8, 1, C.eps)), sv = go('sun x4', (i) => wk.sun(i, C.eps));
    const full = NS * (32 + 32 + 256) / g + NS * 4 / sv, quickT = NS * (8 + 8 + 48) / g + NS * 4 / sv;
    log(`extrapolated ray time on 2 idle cores: full ${fmtT(full / 2)}, --quick ${fmtT(quickT / 2)} (+ ~1 min setup/denoise/encode)`);
    return;
  }

  // ---------------------------------------------------------------- passes (resumable)
  const CS = 2048, nChunks = Math.ceil(NS / CS), mode = quick ? 'quick' : 'full';
  const CK = path.join(os.tmpdir(), `bakelm-${hash}-${mode}-${RAYS.join('.')}`);
  if (fresh) fs.rmSync(CK, { recursive: true, force: true });
  fs.mkdirSync(CK, { recursive: true });
  const ck = (n) => path.join(CK, n);
  const saveF = (n, arrs) => { const tmp = ck(n + '.tmp'); const fd = fs.openSync(tmp, 'w'); for (const a of arrs) fs.writeSync(fd, new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); fs.closeSync(fd); fs.renameSync(tmp, ck(n)); };
  const loadF = (n, arrs) => { if (!fs.existsSync(ck(n))) return false; const b = fs.readFileSync(ck(n)); let o = 0; for (const a of arrs) { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); if (o + u.length > b.length) return false; u.set(b.subarray(o, o + u.length)); o += u.length; } return true; };
  log(`checkpoints: ${CK}`);

  const workers = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url), { workerData: { S, C } }));
  const runPass = (pass, rays) => new Promise((resolve) => {
    const nu = Math.max(1, Math.floor(Math.sqrt(rays))), nv = Math.ceil(rays / nu), rs = nu * nv;
    const done = SAB(Uint8Array, nChunks), outs = pass === 0 ? [S.OV1, S.OV2, S.OVO] : [S.OS, S.OO, S.OA, S.OB];
    const raw = `p${pass}.raw`, dn = `p${pass}.done`;
    if (loadF(raw, outs) && loadF(dn, [done])) log(`pass ${pass}: resuming, ${done.reduce((a, b) => a + b, 0)}/${nChunks} chunks done`);
    Atomics.store(S.ctrl, 0, 0);
    let left = nChunks - done.reduce((a, b) => a + b, 0), idle = 0, nr = 0, tLast = performance.now(), tSave = tLast; const tP = tLast, doneAtStart = nChunks - left, cpu0 = process.cpuUsage();
    const label = pass === 0 ? 'sun visibility (4 shadow rays)' : `bounce ${pass}/3, ${rs} rays/texel`;
    if (!left) { log(`pass ${pass} ${label}: already done`); return resolve(); }
    const onMsg = (m) => {
      if (m.cmd === 'chunk') {
        done[m.c] = 1; left--; nr += m.rays;
        const now = performance.now();
        if (now - tLast > 10000 || left === 0) {
          const f = 1 - left / nChunks, el = (now - tP) / 1000, rate = nr / el, eta = el / Math.max(1e-9, (nChunks - left - doneAtStart)) * left;
          log(`pass ${pass} ${label}: ${(f * 100).toFixed(1).padStart(5)} %  ${(rate / 1e6).toFixed(2)} Mrays/s  ETA ${fmtT(eta)}`);
          tLast = now;
        }
        if (now - tSave > 20000 && left > 0) { saveF(raw, outs); saveF(dn, [done]); tSave = now; }
      } else if (m.cmd === 'idle' && ++idle === workers.length) {
        workers.forEach((w) => w.off('message', onMsg));
        saveF(raw, outs); saveF(dn, [done]);
        const cu = process.cpuUsage(cpu0), cpu = (cu.user + cu.system) / 1e6;
        log(`pass ${pass} done: ${(nr / 1e6).toFixed(1)} M rays in ${fmtT((performance.now() - tP) / 1000)}, ${cpu.toFixed(0)} cpu-s = ${(nr / cpu / 1e6).toFixed(2)} Mrays per cpu-s`);
        resolve({ rays: nr, sec: (performance.now() - tP) / 1000, cpu });
      }
    };
    workers.forEach((w) => { w.on('message', onMsg); w.postMessage({ cmd: 'pass', pass, rays: rs, nu, nv, cs: CS, nChunks, NS, done }); });
  });

  const stats = { passes: [] };
  const P0 = await runPass(0, 4); if (P0) stats.passes.push(P0);
  const EsunS = new Float32Array(NS), EsunO = new Float32Array(NS);   // irradiance factor x SUN rgb
  for (let i = 0; i < NS; i++) {
    const n0 = smp.SN[i * 3], n1 = smp.SN[i * 3 + 1], n2 = smp.SN[i * 3 + 2];
    EsunS[i] = Math.max(0, n0 * C.Ls[0] + n1 * C.Ls[1] + n2 * C.Ls[2]) * S.OV1[i];
    EsunO[i] = Math.max(0, n0 * C.Lo[0] + n1 * C.Lo[1] + n2 * C.Lo[2]) * S.OVO[i];
  }
  const valid = new Uint8Array(NS).fill(1), Es = new Float32Array(NS * 3), Eo = new Float32Array(NS * 3), open = new Float32Array(NS);
  const PP = { smp, W, H, valid };
  const setB = () => {   // radiosity for the next gather: albedo x (sun + indirect), filled into gutters / buried texels
    const bs = new Float32Array(WH * 3), bo = new Float32Array(WH * 3), hasB = new Uint8Array(WH);
    for (let i = 0; i < NS; i++) {
      if (!valid[i]) continue;
      const p = smp.SPIX[i], a = smp.SALB;
      for (let c = 0; c < 3; c++) { bs[p * 3 + c] = a[i * 3 + c] * (C.SUNs[c] * EsunS[i] + Es[i * 3 + c]); bo[p * 3 + c] = a[i * 3 + c] * (C.SUNo[c] * EsunO[i] + Eo[i * 3 + c]); }
      hasB[p] = 1;
    }
    dilate([bs, bo], 3, hasB, smp.chartOf, W, H);
    S.BS.set(bs); S.BO.set(bo);
  };
  setB();
  for (let k = 1; k <= 3; k++) {
    const post = `p${k}.post`;
    if (loadF(post, [Es, Eo, open, valid])) log(`pass ${k}: loaded from checkpoint`);
    else {
      const r = await runPass(k, RAYS[k - 1]); if (r) stats.passes.push(r);
      for (let i = 0; i < NS; i++) valid[i] = S.OB[i] < 0.25 ? 1 : 0;
      Es.set(S.OS); Eo.set(S.OO); open.set(S.OA);
      t1 = performance.now();
      const gd = { open: S.OA.slice(), back: S.OB.slice(), range: FILT[k - 1][2] };
      denoise(PP, [Es, Eo], 3, FILT[k - 1][0], FILT[k - 1][1], gd);
      if (k === 3) denoise(PP, [open], 1, FILT[k - 1][0], FILT[k - 1][1], { ...gd, range: 0 });
      saveF(post, [Es, Eo, open, valid]);
      log(`pass ${k}: denoised (r ${FILT[k - 1][0]}, sigma ${FILT[k - 1][1]}) in ${Math.round(performance.now() - t1)} ms; ${NS - valid.reduce((a, b) => a + b, 0)} texels inside geometry`);
    }
    if (k < 3) setB();
  }
  workers.forEach((w) => w.terminate());

  // ---------------------------------------------------------------- encode
  const enc = encodeAll({ smp, W, H, valid, Es, Eo, open, EsunS, OV2: S.OV2, C, aoExp: IN.aoExp });
  const files = {};
  const writePNG = (name, data) => { const b = pngEncode(W, H, 3, data); fs.writeFileSync(path.join(OUT, name), b); files[name] = b.length; return b.length; };
  writePNG('lm_sunny.png', enc.sunny.bytes); writePNG('lm_overcast.png', enc.overcast.bytes); writePNG('lm_aux.png', enc.aux);
  const bakeSec = (performance.now() - T0) / 1000;
  const sky = (s, e) => ({ file: `lm_${s.key}.png`, id: s.id, range: e.range, sunDir: s.sunDir.map((v) => +v.toFixed(6)), rotY: s.rotY,
    light: { sunI: +s.sunI.toFixed(5), sunColor: s.sunColor.map((v) => +v.toFixed(5)), skyB: s.skyB.map((v) => +v.toFixed(5)), envI: +s.envI.toFixed(5), sunRatio: s.sunRatio, bgI: s.bgI } });
  const json = {
    version: 1, hash, hashAlgo: 'mm3x2/1 (tools/geohash.mjs) over name, position, normal, uv2, index + layout', W, H, texel: lay.texel, terrTexel: lay.terrTexel, charts: lay.charts,
    encoding: 'rgb = (log2(E) - range[0]) / (range[1] - range[0]), E = indirect irradiance (pi-included, linear), bilinear',
    aux: { file: 'lm_aux.png', r: `openness^${IN.aoExp} (40 m, terrain 24 m)`, g: 'sunny sun visibility, dilated 3 texels' },
    skies: { sunny: sky(SKY.sunny, enc.sunny), overcast: sky(SKY.overcast, enc.overcast) },
    vegHash: wb.vegProxyHash ? wb.vegProxyHash(geo) : null, vegTris, denoise: 'cross-bilateral (openness, back hits, log luminance)',
    rays: RAYS, bounces: 3, mode, bakeSec: Math.round(bakeSec), threads, date: new Date().toISOString().slice(0, 10), files,
  };
  fs.writeFileSync(path.join(OUT, 'lm.json'), JSON.stringify(json, null, 1) + '\n');
  log(`wrote ${Object.entries(files).map(([k, v]) => `${k} ${(v / 1048576).toFixed(2)} MB`).join(', ')}, lm.json -> ${OUT}`);
  log(`total ${fmtT(bakeSec)} (${stats.passes.map((p) => `${(p.rays / 1e6).toFixed(0)}M rays ${fmtT(p.sec)} / ${p.cpu.toFixed(0)} cpu-s`).join(' | ')})`);
  const cpuAll = stats.passes.reduce((a, p) => a + p.cpu, 0), raysAll = stats.passes.reduce((a, p) => a + p.rays, 0);
  if (cpuAll > 0) log(`throughput ${(raysAll / cpuAll / 1e6).toFixed(2)} Mrays per cpu-s -> a full bake (${(NS * (4 + 32 + 32 + 256) / 1e6).toFixed(0)} M rays) ~ ${fmtT(NS * (4 + 32 + 32 + 256) / (raysAll / cpuAll) / 2)} on 2 idle cores`);
  if (has('--and-verify')) await verify({ THREE, wb, geo, lay, S, C, SKY, smp, OUT, log, W, H });
}

function fmtT(s) { s = Math.max(0, Math.round(s)); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; }

// ================================================================ BVH build (binned SAH, 16 bins, leaves <= 4)
function buildBVH(V, I, SAB) {
  const NT = I.length / 3, bmin = new Float32Array(NT * 3), bmax = new Float32Array(NT * 3), cen = new Float32Array(NT * 3);
  for (let t = 0; t < NT; t++) for (let c = 0; c < 3; c++) {
    const a = V[I[t * 3] * 3 + c], b = V[I[t * 3 + 1] * 3 + c], d = V[I[t * 3 + 2] * 3 + c];
    bmin[t * 3 + c] = Math.min(a, b, d); bmax[t * 3 + c] = Math.max(a, b, d); cen[t * 3 + c] = (a + b + d) / 3;
  }
  const order = new Int32Array(NT); for (let i = 0; i < NT; i++) order[i] = i;
  const maxN = 2 * NT, NBt = new Float32Array(maxN * 6), NCt = new Int32Array(maxN * 2); let nn = 1;
  const BIN = 16, bc = new Int32Array(BIN), bb = new Float64Array(BIN * 6), la = new Float64Array(BIN), lc = new Int32Array(BIN);
  const area = (x0, y0, z0, x1, y1, z1) => { const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0; return dx < 0 ? 0 : 2 * (dx * dy + dy * dz + dz * dx); };
  const stack = [[0, 0, NT]];
  while (stack.length) {
    const [node, s, e] = stack.pop(), n = e - s;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = s; i < e; i++) {
      const t = order[i] * 3;
      if (bmin[t] < x0) x0 = bmin[t]; if (bmin[t + 1] < y0) y0 = bmin[t + 1]; if (bmin[t + 2] < z0) z0 = bmin[t + 2];
      if (bmax[t] > x1) x1 = bmax[t]; if (bmax[t + 1] > y1) y1 = bmax[t + 1]; if (bmax[t + 2] > z1) z1 = bmax[t + 2];
      if (cen[t] < cx0) cx0 = cen[t]; if (cen[t + 1] < cy0) cy0 = cen[t + 1]; if (cen[t + 2] < cz0) cz0 = cen[t + 2];
      if (cen[t] > cx1) cx1 = cen[t]; if (cen[t + 1] > cy1) cy1 = cen[t + 1]; if (cen[t + 2] > cz1) cz1 = cen[t + 2];
    }
    NBt.set([x0, y0, z0, x1, y1, z1], node * 6);
    const ex = [cx1 - cx0, cy1 - cy0, cz1 - cz0], ax = ex[0] >= ex[1] && ex[0] >= ex[2] ? 0 : ex[1] >= ex[2] ? 1 : 2, c0 = [cx0, cy0, cz0][ax], ext = ex[ax];
    let split = -1;
    if (n > 4 && ext > 1e-7) {
      bc.fill(0); for (let b = 0; b < BIN; b++) bb.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], b * 6);
      for (let i = s; i < e; i++) {
        const t = order[i] * 3, b = Math.min(BIN - 1, Math.floor((cen[t + ax] - c0) / ext * BIN)); bc[b]++;
        for (let c = 0; c < 3; c++) { if (bmin[t + c] < bb[b * 6 + c]) bb[b * 6 + c] = bmin[t + c]; if (bmax[t + c] > bb[b * 6 + 3 + c]) bb[b * 6 + 3 + c] = bmax[t + c]; }
      }
      let a0 = Infinity, a1 = Infinity, a2 = Infinity, a3 = -Infinity, a4 = -Infinity, a5 = -Infinity, cnt = 0;
      for (let b = 0; b < BIN - 1; b++) {
        if (bc[b]) { a0 = Math.min(a0, bb[b * 6]); a1 = Math.min(a1, bb[b * 6 + 1]); a2 = Math.min(a2, bb[b * 6 + 2]); a3 = Math.max(a3, bb[b * 6 + 3]); a4 = Math.max(a4, bb[b * 6 + 4]); a5 = Math.max(a5, bb[b * 6 + 5]); }
        cnt += bc[b]; la[b] = cnt ? area(a0, a1, a2, a3, a4, a5) : 0; lc[b] = cnt;
      }
      a0 = Infinity; a1 = Infinity; a2 = Infinity; a3 = -Infinity; a4 = -Infinity; a5 = -Infinity; cnt = 0;
      let best = Infinity;
      for (let b = BIN - 1; b > 0; b--) {
        if (bc[b]) { a0 = Math.min(a0, bb[b * 6]); a1 = Math.min(a1, bb[b * 6 + 1]); a2 = Math.min(a2, bb[b * 6 + 2]); a3 = Math.max(a3, bb[b * 6 + 3]); a4 = Math.max(a4, bb[b * 6 + 4]); a5 = Math.max(a5, bb[b * 6 + 5]); }
        cnt += bc[b];
        const cost = lc[b - 1] && cnt ? la[b - 1] * lc[b - 1] + area(a0, a1, a2, a3, a4, a5) * cnt : Infinity;
        if (cost < best) { best = cost; split = b; }
      }
      const leafCost = area(x0, y0, z0, x1, y1, z1) * n;
      if (n <= 8 && best >= leafCost) split = -1;
    }
    let mid = -1;
    if (split > 0) {
      let i = s, j = e - 1;
      while (i <= j) { const t = order[i] * 3, b = Math.min(BIN - 1, Math.floor((cen[t + ax] - c0) / ext * BIN)); if (b < split) i++; else { const tmp = order[i]; order[i] = order[j]; order[j] = tmp; j--; } }
      mid = i; if (mid === s || mid === e) mid = -1;
    }
    if (mid < 0 && n > 4) mid = s + (n >> 1);   // degenerate centroids: plain halving
    if (mid < 0) { NCt[node * 2] = s; NCt[node * 2 + 1] = n; continue; }
    const l = nn; nn += 2; NCt[node * 2] = l; NCt[node * 2 + 1] = -(ax + 1);
    stack.push([l + 1, mid, e], [l, s, mid]);
  }
  const NB = SAB(Float32Array, nn * 6), NC = SAB(Int32Array, nn * 2), TV = SAB(Float32Array, NT * 9), TO = SAB(Int32Array, NT);
  NB.set(NBt.subarray(0, nn * 6)); NC.set(NCt.subarray(0, nn * 2));
  for (let k = 0; k < NT; k++) {
    const t = order[k], a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3; TO[k] = t;
    for (let j = 0; j < 3; j++) { TV[k * 9 + j] = V[a + j]; TV[k * 9 + 3 + j] = V[b + j] - V[a + j]; TV[k * 9 + 6 + j] = V[c + j] - V[a + j]; }
  }
  return { NB, NC, TV, TO, nodes: nn };
}

// ================================================================ texel samples: one surface point per atlas texel
// Charts are rasterised in their own parameter space (metres), so charts squashed to one texel row still find
// their triangles. Texels of a chart rect that no triangle covers (diagonal edges) sample the nearest chart point.
function makeSamples(lay, geo, IN, W, H, SAB) {
  const charts = []; for (const G of lay.geos) for (const ch of G.C.charts) charts.push([G, ch]);
  const T = lay.terr, tg = geo.terr;
  const terrPar = new Float64Array(tg.attributes.position.count * 2); { const p = tg.attributes.position.array; for (let v = 0; v < terrPar.length / 2; v++) { terrPar[v * 2] = p[v * 3]; terrPar[v * 2 + 1] = p[v * 3 + 2]; } }
  const terrChart = { tris: Array.from({ length: tg.index.count / 3 }, (_, i) => i), ox: T.ox, oy: T.oy, rot: false, nx: T.n, ny: T.n, u0: T.x0, v0: T.z0, sx: T.s, sy: T.s, du: (T.n - 1) / T.s, dv: (T.n - 1) / T.s };
  charts.push([{ key: 'terr', g: tg, par: terrPar, terr: true }, terrChart]);
  let NS = 0; for (const [, ch] of charts) NS += ch.nx * ch.ny;
  const SP = SAB(Float32Array, NS * 3), SN = SAB(Float32Array, NS * 3), SG = SAB(Float32Array, NS * 3), SD = SAB(Float32Array, NS);
  const SPIX = new Int32Array(NS), SALB = new Float32Array(NS * 3), SCH = new Int32Array(NS), chartOf = new Int32Array(W * H).fill(-1), pixS = new Int32Array(W * H).fill(-1);
  let s = 0;
  charts.forEach(([G, ch], cid) => {
    const g = G.g, idx = g.index.array, p = g.attributes.position.array, nr = g.attributes.normal.array, par = G.par, nx = ch.nx, ny = ch.ny, n = nx * ny;
    const rw = (ch.rot ? ny : nx) + 2, rh = (ch.rot ? nx : ny) + 2;
    for (let y = 0; y < rh; y++) chartOf.fill(cid, (ch.oy + y) * W + ch.ox, (ch.oy + y) * W + ch.ox + rw);
    const best = new Float64Array(n).fill(-Infinity), bt = new Int32Array(n).fill(-1), bw = new Float64Array(n * 3);
    const uAt = (i) => (ch.sx > 0 ? ch.u0 + i / ch.sx : ch.u0 + ch.du / 2), vAt = (j) => (ch.sy > 0 ? ch.v0 + j / ch.sy : ch.v0 + ch.dv / 2);
    for (const t of ch.tris) {
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      const ax = par[a * 2], ay = par[a * 2 + 1], bx = par[b * 2], by = par[b * 2 + 1], cx = par[c * 2], cy = par[c * 2 + 1];
      const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay); if (Math.abs(d) < 1e-14) continue;
      const umin = Math.min(ax, bx, cx), umax = Math.max(ax, bx, cx), vmin = Math.min(ay, by, cy), vmax = Math.max(ay, by, cy);
      const i0 = ch.sx > 0 ? Math.max(0, Math.ceil((umin - ch.u0) * ch.sx - 1e-6)) : 0, i1 = ch.sx > 0 ? Math.min(nx - 1, Math.floor((umax - ch.u0) * ch.sx + 1e-6)) : 0;
      const j0 = ch.sy > 0 ? Math.max(0, Math.ceil((vmin - ch.v0) * ch.sy - 1e-6)) : 0, j1 = ch.sy > 0 ? Math.min(ny - 1, Math.floor((vmax - ch.v0) * ch.sy + 1e-6)) : 0;
      for (let j = j0; j <= j1; j++) {
        const v = vAt(j);
        for (let i = i0; i <= i1; i++) {
          const u = uAt(i), w1 = ((u - ax) * (cy - ay) - (cx - ax) * (v - ay)) / d, w2 = ((bx - ax) * (v - ay) - (u - ax) * (by - ay)) / d, w0 = 1 - w1 - w2, m = Math.min(w0, w1, w2), k = j * nx + i;
          if (m > -1e-4 && m > best[k]) { best[k] = m; bt[k] = t; bw[k * 3] = w0; bw[k * 3 + 1] = w1; bw[k * 3 + 2] = w2; }
        }
      }
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (bt[k] < 0) {   // nearest point of the chart (2D, parameter space)
        const u = uAt(i), v = vAt(j); let bd = Infinity;
        for (const t of ch.tris) {
          const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2], w = closest2D(u, v, par[a * 2], par[a * 2 + 1], par[b * 2], par[b * 2 + 1], par[c * 2], par[c * 2 + 1]);
          if (w && w[3] < bd) { bd = w[3]; bt[k] = t; bw[k * 3] = w[0]; bw[k * 3 + 1] = w[1]; bw[k * 3 + 2] = w[2]; }
        }
        if (bt[k] < 0) { bt[k] = ch.tris[0]; bw[k * 3] = bw[k * 3 + 1] = bw[k * 3 + 2] = 1 / 3; }
      }
      const t = bt[k], a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2], w0 = bw[k * 3], w1 = bw[k * 3 + 1], w2 = bw[k * 3 + 2];
      let nX = 0, nY = 0, nZ = 0;
      for (let q = 0; q < 3; q++) {
        SP[s * 3 + q] = w0 * p[a * 3 + q] + w1 * p[b * 3 + q] + w2 * p[c * 3 + q];
        const nn = w0 * nr[a * 3 + q] + w1 * nr[b * 3 + q] + w2 * nr[c * 3 + q]; if (q === 0) nX = nn; else if (q === 1) nY = nn; else nZ = nn;
      }
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2], vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
      let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx; const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      let nl = Math.hypot(nX, nY, nZ); if (nl < 1e-6) { nX = fx; nY = fy; nZ = fz; nl = 1; } nX /= nl; nY /= nl; nZ /= nl;
      if (fx * nX + fy * nY + fz * nZ < 0) { fx = -fx; fy = -fy; fz = -fz; }
      SN[s * 3] = nX; SN[s * 3 + 1] = nY; SN[s * 3 + 2] = nZ; SG[s * 3] = fx; SG[s * 3 + 1] = fy; SG[s * 3 + 2] = fz;
      const alb = G.terr ? IN.terrainAlbedo(SP[s * 3], SP[s * 3 + 2]) : IN.albedo[G.key];
      SALB[s * 3] = alb[0]; SALB[s * 3 + 1] = alb[1]; SALB[s * 3 + 2] = alb[2];
      SD[s] = G.terr ? 24 : 40; SCH[s] = cid;
      const px = ch.ox + 1 + (ch.rot ? j : i), py = ch.oy + 1 + (ch.rot ? i : j);
      SPIX[s] = py * W + px; pixS[py * W + px] = s;
      s++;
    }
  });
  return { NS, SP, SN, SG, SD, SPIX, SALB, SCH, chartOf, pixS, nCharts: charts.length };
}
function closest2D(px, py, ax, ay, bx, by, cx, cy) {   // closest point of triangle abc to p: [w0, w1, w2, dist^2]
  const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay); if (Math.abs(d) < 1e-14) return null;
  let best = null;
  const seg = (x0, y0, x1, y1, ia, ib) => {
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy, t = l2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0;
    const qx = x0 + dx * t - px, qy = y0 + dy * t - py, d2 = qx * qx + qy * qy;
    if (!best || d2 < best[3]) { best = [0, 0, 0, d2]; best[ia] = 1 - t; best[ib] = t; }
  };
  const w1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / d, w2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / d;
  if (w1 >= 0 && w2 >= 0 && w1 + w2 <= 1) return [1 - w1 - w2, w1, w2, 0];
  seg(ax, ay, bx, by, 0, 1); seg(bx, by, cx, cy, 1, 2); seg(cx, cy, ax, ay, 2, 0);
  return best;
}

// ================================================================ denoise + dilate (atlas space, chart-aware)
// Normalised separable Gaussian over valid texels of the same chart (weights x normal agreement on curved charts).
// [A4] cross-bilateral (lighting #3): x exp(-d^2 / 2 s^2) on the texels' openness (rays escaping 40 m), back-hit share
// and, when g.range > 0, log2 luminance of the first array (the sunny irradiance), so a real step (a beam side under the
// table next to its sunlit end, a column foot against the floor) is not smeared across the step. Guides are per sample.
const DN = { sOpen: 0.18, sBack: 0.12 };
function denoise(PP, arrs, comps, r, sigma, g = null) {
  const { smp, W, H, valid } = PP, { NS, SPIX, SCH, SN, chartOf, pixS } = smp, WH = W * H;
  const K = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const nC = arrs.length * comps, val = new Float32Array(WH * nC), wgt = new Float32Array(WH), tv = new Float32Array(WH * nC), tw = new Float32Array(WH);
  for (let i = 0; i < NS; i++) { if (!valid[i]) continue; const p = SPIX[i]; wgt[p] = 1; let o = 0; for (const a of arrs) for (let c = 0; c < comps; c++) val[p * nC + o++] = a[i * comps + c]; }
  const acc = new Float64Array(nC);
  const iO = 1 / (2 * DN.sOpen * DN.sOpen), iB = 1 / (2 * DN.sBack * DN.sBack), iR = g && g.range > 0 ? 1 / (2 * g.range * g.range) : 0;
  const lum0 = (src, q, w) => (0.2126 * src[q * nC] + 0.7152 * src[q * nC + 1] + 0.0722 * src[q * nC + 2]) / w;
  const pass = (src, sw, dst, dw, step, len, lines, lstep) => {
    for (let L = 0; L < lines; L++) {
      const base = L * lstep;
      for (let x = 0; x < len; x++) {
        const p = base + x * step, ch = chartOf[p]; if (ch < 0) continue;
        const s0 = pixS[p], n0 = s0 >= 0 ? s0 * 3 : -1;
        let w = 0; acc.fill(0);
        for (let k = -r; k <= r; k++) {
          const xx = x + k; if (xx < 0 || xx >= len) continue;
          const q = base + xx * step; if (chartOf[q] !== ch || sw[q] === 0) continue;
          let kw = K[k + r] * sw[q];
          const sq = pixS[q];
          if (n0 >= 0 && sq >= 0) { const d = SN[n0] * SN[sq * 3] + SN[n0 + 1] * SN[sq * 3 + 1] + SN[n0 + 2] * SN[sq * 3 + 2]; if (d < 0.9) kw *= Math.max(0, (d - 0.5) / 0.4); }
          if (g && s0 >= 0 && sq >= 0 && k !== 0) {
            const dO = g.open[s0] - g.open[sq], dB = g.back[s0] - g.back[sq];
            let e = (dO * dO) * iO + (dB * dB) * iB;
            if (g.range > 0 && sw[p] > 0) { const lp = lum0(src, p, sw[p]), lq = lum0(src, q, sw[q]), dl = Math.log2(Math.max(lp, 1e-6) / Math.max(lq, 1e-6)); e += dl * dl * iR; }
            kw *= Math.exp(-e);
          }
          if (kw <= 0) continue;
          w += kw; for (let c = 0; c < nC; c++) acc[c] += kw * src[q * nC + c] / sw[q];
        }
        dw[p] = w > 0 ? 1 : 0; if (w > 0) for (let c = 0; c < nC; c++) dst[p * nC + c] = acc[c] / w;
      }
    }
  };
  pass(val, wgt, tv, tw, 1, W, H, W);       // rows
  pass(tv, tw, val, wgt, W, H, W, 1);       // columns
  for (let i = 0; i < NS; i++) { if (!valid[i]) continue; const p = SPIX[i]; if (!wgt[p]) continue; let o = 0; for (const a of arrs) for (let c = 0; c < comps; c++) a[i * comps + c] = val[p * nC + o++]; }
}
// Fill every chart-rect pixel without a value (gutters, texels inside geometry) from its 8 neighbours, same chart first.
function dilate(arrs, comps, has, chartOf, W, H, maxIt = 24) {
  let front = []; for (let p = 0; p < W * H; p++) if (!has[p] && chartOf[p] >= 0) front.push(p);
  const nb = [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1];
  for (let it = 0; it < maxIt + 4 && front.length; it++) {
    const anyChart = it >= maxIt, got = [], next = [];
    for (const p of front) {
      const x = p % W, ch = chartOf[p]; let n = 0; const acc = new Float64Array(arrs.length * comps);
      for (const d of nb) {
        const q = p + d; if (q < 0 || q >= W * H) continue; const qx = q % W; if (Math.abs(qx - x) > 1) continue;
        if (!has[q] || (!anyChart && chartOf[q] !== ch)) continue;
        n++; let o = 0; for (const a of arrs) for (let c = 0; c < comps; c++) acc[o++] += a[q * comps + c];
      }
      if (n) { got.push([p, acc, n]); } else next.push(p);
    }
    for (const [p, acc, n] of got) { let o = 0; for (const a of arrs) for (let c = 0; c < comps; c++) a[p * comps + c] = acc[o++] / n; has[p] = 1; }
    front = next;
  }
}

// ================================================================ encoding
function encodeAll({ smp, W, H, valid, Es, Eo, open, EsunS, OV2, C, aoExp }) {
  const { NS, SPIX, SN, chartOf } = smp, WH = W * H;
  const one = (E, key) => {
    const pix = new Float32Array(WH * 3), has = new Uint8Array(WH);
    for (let i = 0; i < NS; i++) if (valid[i]) { const p = SPIX[i]; for (let c = 0; c < 3; c++) pix[p * 3 + c] = E[i * 3 + c]; has[p] = 1; }
    dilate([pix], 3, has, chartOf, W, H);
    const vals = []; for (let i = 0; i < NS; i += 7) if (valid[i]) vals.push(Math.max(E[i * 3], E[i * 3 + 1], E[i * 3 + 2]));
    vals.sort((a, b) => a - b);
    const hi = Math.ceil(Math.log2(Math.max(1e-6, vals[vals.length - 1])) * 4) / 4, lo = Math.max(hi - 16, Math.floor(Math.log2(Math.max(1e-7, vals[Math.floor(vals.length * 0.0005)])) * 4) / 4 - 1);
    const bytes = new Uint8Array(WH * 3), k = 255 / (hi - lo);
    for (let p = 0; p < WH * 3; p++) { const v = pix[p] > 0 ? (Math.log2(pix[p]) - lo) * k : 0; bytes[p] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v); }
    return { bytes, range: [lo, hi], stats: { p50: vals[vals.length >> 1], max: vals[vals.length - 1] } };
  };
  const sunny = one(Es, 'sunny'), overcast = one(Eo, 'overcast');
  // aux: openness (old `ao` curve) and the sunny sun-visibility mask, dilated 3 texels within the chart
  const ao = new Float32Array(WH), mk = new Float32Array(WH), has = new Uint8Array(WH);
  for (let i = 0; i < NS; i++) if (valid[i]) { const p = SPIX[i]; ao[p] = Math.pow(Math.min(1, Math.max(0, open[i])), aoExp); mk[p] = OV2[i] > 0 && (SN[i * 3] * C.Ls[0] + SN[i * 3 + 1] * C.Ls[1] + SN[i * 3 + 2] * C.Ls[2]) > 0 ? 1 : 0; has[p] = 1; }
  const m2 = mk.slice();
  for (let it = 0; it < 3; it++) {
    const src = m2.slice();
    for (let p = 0; p < WH; p++) {
      if (!has[p] || src[p] >= 1) continue; const ch = chartOf[p], x = p % W;
      for (const d of [-1, 1, -W, W]) { const q = p + d; if (q < 0 || q >= WH || Math.abs((q % W) - x) > 1) continue; if (has[q] && chartOf[q] === ch && src[q] >= 1) { m2[p] = 1; break; } }
    }
  }
  const pair = new Float32Array(WH * 2); for (let p = 0; p < WH; p++) { pair[p * 2] = ao[p]; pair[p * 2 + 1] = m2[p]; }
  dilate([pair], 2, has, chartOf, W, H);
  const aux = new Uint8Array(WH * 3); for (let p = 0; p < WH; p++) { aux[p * 3] = Math.round(255 * pair[p * 2]); aux[p * 3 + 1] = Math.round(255 * pair[p * 2 + 1]); }
  console.log(`  sunny E p50 ${sunny.stats.p50.toFixed(4)} max ${sunny.stats.max.toFixed(3)} range [${sunny.range}]; overcast p50 ${overcast.stats.p50.toFixed(4)} max ${overcast.stats.max.toFixed(3)} range [${overcast.range}]`);
  return { sunny, overcast, aux };
}

// ================================================================ PNG (8-bit RGB / grey, best-of-5 filter per row, zlib 9)
function pngEncode(W, H, ch, data) {
  const stride = W * ch, raw = Buffer.alloc(H * (stride + 1)), cand = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < H; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride), up = y ? data.subarray((y - 1) * stride, y * stride) : null;
    let bestF = 0, bestS = Infinity;
    for (let f = 0; f < 5; f++) {
      const o = cand[f]; let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? row[i - ch] : 0, b = up ? up[i] : 0, c = up && i >= ch ? up[i - ch] : 0;
        let pr = 0;
        if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1; else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const v = (row[i] - pr) & 255; o[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestS) { bestS = sum; bestF = f; }
    }
    raw[y * (stride + 1)] = bestF; cand[bestF].copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(tb) >>> 0); return Buffer.concat([len, tb, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = ch === 3 ? 2 : ch === 4 ? 6 : 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function pngDecode(buf) {   // 8-bit, non-interlaced greyscale / RGB / RGBA only (what pngEncode writes)
  let o = 8, W = 0, H = 0, ch = 3; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), body = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { W = body.readUInt32BE(0); H = body.readUInt32BE(4); ch = { 0: 1, 2: 3, 6: 4 }[body[9]]; if (body[8] !== 8 || body[12]) throw new Error('png: unsupported'); }
    else if (type === 'IDAT') idat.push(body);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = W * ch, out = new Uint8Array(W * H * ch);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = out.subarray(y * stride, (y + 1) * stride), up = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? row[i - ch] : 0, b = up ? up[i] : 0, c = up && i >= ch ? up[i - ch] : 0;
      let pr = 0; if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1; else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[i] = (src[i] + pr) & 255;
    }
  }
  return { W, H, ch, data: out };
}

// ================================================================ --verify: the committed maps vs a reference path tracer
// Probe lines (hall bay, chimney throat, under the silo table, as in the lighting panel's gi2.mjs). Per probe: the
// surface hit, the lightmap there decoded like the GPU (bilinear on the bytes), the old per-vertex bake there
// (env x ao + aBSun x uSunB + aBSky x uSkyB, interpolated), and a reference: a plain recursive path tracer (no
// texels, no filtering, no lookups) with the same sky, sun, albedos and 3 bounces, 4096 paths.
async function verify({ THREE, wb, geo, lay, S, C, SKY, smp, OUT, log, W, H }) {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, 'lm.json'), 'utf8'));
  if (j.hash !== wb.geometryHash(geo)) log(`WARNING: lm.json hash ${j.hash} != geometry ${wb.geometryHash(geo)} (verifying a stale map)`);
  const img = { sunny: pngDecode(fs.readFileSync(path.join(OUT, j.skies.sunny.file))), overcast: pngDecode(fs.readFileSync(path.join(OUT, j.skies.overcast.file))) };
  const wk = makeWorker(S, C), tr = makeTracer(S), R = tr.R, IN = wb.lmBakeInputs(geo);
  // per trace-triangle albedo source: merged key / terrain / far / proxy (triangle ranges in the order bakelm built them)
  const ranges = []; let t0 = 0;
  for (const G of lay.geos) { const n = G.g.index.count / 3; ranges.push([t0, t0 + n, IN.albedo[G.key], G.g]); t0 += n; }
  ranges.push([t0, t0 + geo.terr.index.count / 3, null, geo.terr]); t0 += geo.terr.index.count / 3;
  const rangeOf = (t) => ranges.find((r) => t >= r[0] && t < r[1]);
  const albAt = (t, x, z) => { const r = rangeOf(t); return r ? (r[2] || IN.terrainAlbedo(x, z)) : TKa(t); };
  const TKa = (t) => (S.TK[t] === 1 ? C.aFar : S.TK[t] === 3 ? [0, 1, 2].map((c) => S.TAlb[t * 3 + c] * S.TOcc[t]) : C.aLeaf.map((v) => v * 0.6));
  let seed = 12345; const rnd = () => (seed = hash32(seed + 0x9e3779b9)) / 4294967296;
  const F = new Float64Array(6), frame = (n) => { const s = n[2] >= 0 ? 1 : -1, a = -1 / (s + n[2]), b = n[0] * n[1] * a; return [1 + s * n[0] * n[0] * a, s * b, -s * n[0], b, s + n[1] * n[1] * a, -n[1]]; };
  const cosDir = (n) => { const f = frame(n), u = rnd(), v = rnd(), r = Math.sqrt(u), ph = 2 * PI * v, x = r * Math.cos(ph), y = r * Math.sin(ph), z = Math.sqrt(1 - u); return [f[0] * x + f[3] * y + n[0] * z, f[1] * x + f[4] * y + n[1] * z, f[2] * x + f[5] * y + n[2] * z]; };
  const envAt = (d, sky) => { const e = sky === 'sunny' ? wk.envIdx(C.crs, C.srs, ...d) : wk.envIdx(C.cro, C.sro, ...d), T = sky === 'sunny' ? S.ENVS : S.ENVO; return [T[e], T[e + 1], T[e + 2]]; };
  // one path sample of indirect irradiance at (p, n), depth bounces, both skies: returns [sunny rgb, overcast rgb]
  const ind = (p, n, depth) => {
    const d = cosDir(n), o = [p[0] + n[0] * 0.004, p[1] + n[1] * 0.004, p[2] + n[2] * 0.004];
    if (!tr.closest(o[0], o[1], o[2], d[0], d[1], d[2], 1e5)) return [envAt(d, 'sunny'), envAt(d, 'overcast')];
    const t = R.tri, f = [S.TFo[t * 3], S.TFo[t * 3 + 1], S.TFo[t * 3 + 2]];
    if (d[0] * f[0] + d[1] * f[1] + d[2] * f[2] > 0) return [[0, 0, 0], [0, 0, 0]];
    const q = [o[0] + d[0] * R.t, o[1] + d[1] * R.t, o[2] + d[2] * R.t];
    if (S.TK[t] !== 0) {
      const a = TKa(t), cs = Math.max(0, f[0] * C.Ls[0] + f[1] * C.Ls[1] + f[2] * C.Ls[2]), co = Math.max(0, f[0] * C.Lo[0] + f[1] * C.Lo[1] + f[2] * C.Lo[2]), sk = 0.5 + 0.5 * f[1];
      return [[0, 1, 2].map((c) => a[c] * (C.SUNs[c] * cs + C.SKYs[c] * sk)), [0, 1, 2].map((c) => a[c] * (C.SUNo[c] * co + C.SKYo[c] * sk))];
    }
    const a = albAt(t, q[0], q[2]), qo = [q[0] + f[0] * 0.004, q[1] + f[1] * 0.004, q[2] + f[2] * 0.004];
    const cs = f[0] * C.Ls[0] + f[1] * C.Ls[1] + f[2] * C.Ls[2], vs = cs > 0 && !tr.any(qo[0], qo[1], qo[2], C.Ls[0], C.Ls[1], C.Ls[2], 1e4) ? cs : 0;
    const co = f[0] * C.Lo[0] + f[1] * C.Lo[1] + f[2] * C.Lo[2], vo = co > 0 && (!C.oShadow || !tr.any(qo[0], qo[1], qo[2], C.Lo[0], C.Lo[1], C.Lo[2], 1e4)) ? co : 0;
    const rec = depth > 1 ? ind(q, f, depth - 1) : [[0, 0, 0], [0, 0, 0]];
    return [[0, 1, 2].map((c) => a[c] * (C.SUNs[c] * vs + rec[0][c])), [0, 1, 2].map((c) => a[c] * (C.SUNo[c] * vo + rec[1][c]))];
  };
  // the old per-vertex bake, for comparison
  const sunDirV = new THREE.Vector3(...SKY.sunny.sunDir);
  await wb.bakeLight(geo, { sunDir: sunDirV, sun: true, quality: 'auto' });
  const envIrr = (n, sky) => { const acc = [0, 0, 0]; for (let k = 0; k < 4096; k++) { const e = envAt(cosDir(n), sky); acc[0] += e[0]; acc[1] += e[1]; acc[2] += e[2]; } return acc.map((v) => v / 4096); };
  const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  const lmAt = (t, w1, w2, sky) => {   // GPU path: uv2 interp -> bilinear on the bytes -> decode
    const b = t * 6, x = S.TU[b] + w1 * (S.TU[b + 2] - S.TU[b]) + w2 * (S.TU[b + 4] - S.TU[b]) - 0.5, y = S.TU[b + 1] + w1 * (S.TU[b + 3] - S.TU[b + 1]) + w2 * (S.TU[b + 5] - S.TU[b + 1]) - 0.5;
    const I = img[sky], x0 = Math.max(0, Math.min(W - 2, Math.floor(x))), y0 = Math.max(0, Math.min(H - 2, Math.floor(y))), fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0)), [lo, hi] = j.skies[sky].range;
    return [0, 1, 2].map((c) => { const p = (yy, xx) => I.data[(yy * W + xx) * 3 + c]; const e = (p(y0, x0) * (1 - fx) + p(y0, x0 + 1) * fx) * (1 - fy) + (p(y0 + 1, x0) * (1 - fx) + p(y0 + 1, x0 + 1) * fx) * fy; return 2 ** (lo + e / 255 * (hi - lo)); });
  };
  const legacyAt = (t, w1, w2, n) => {
    const r = rangeOf(t); if (!r) return null; const g = r[3], lt = t - r[0], ix = g.index.array, a = ix[lt * 3], b = ix[lt * 3 + 1], c = ix[lt * 3 + 2], w0 = 1 - w1 - w2;
    const at = (name, k) => { const A = g.attributes[name].array, s = A.length / g.attributes.position.count; return w0 * A[a * s + k] + w1 * A[b * s + k] + w2 * A[c * s + k]; };
    const ao = at('ao', 0), env = envIrr(n, 'sunny');
    return [0, 1, 2].map((k) => env[k] * ao + at('aBSun', k) * C.SUNs[k] + at('aBSky', k) * C.SKYs[k]);
  };
  const probes = [];
  for (const z of [14.6, 15.5, 16.5, 18, 20, 22.5, 25, 27.5, 30, 32, 33.5, 34.5, 35.4]) probes.push([`hall floor z=${z}`, [34.8, 2.0, z], [0, -1, 0]]);
  for (const z of [14.6, 16.5, 20, 25, 30, 33.5, 35.4]) probes.push([`hall ceiling z=${z}`, [34.8, 2.0, z], [0, 1, 0]]);
  for (const z of [19.5, 25, 30.5]) probes.push([`hall column z=${z}`, [30.5, 1.5, z], [1, 0, 0]]);
  for (const y of [49, 47.5, 46, 44, 42, 38, 33, 28, 22, 16, 10, 6, 4, 2.5]) probes.push([`chimney back y=${y}`, [-8, y, -22], [-0.52, 0, -0.854]]);
  for (const y of [47, 45, 33, 16, 6, 2.5]) probes.push([`chimney side y=${y}`, [-8, y, -22], [0.854, 0, -0.52]]);
  for (const z of [-27, -24, -20, -14, -8, -3, 0]) probes.push([`table floor z=${z}`, [-34, 2, z], [0, -1, 0]]);
  for (const z of [-24, -14, -3]) probes.push([`table ceiling z=${z}`, [-34, 2, z], [0, 1, 0]]);
  const PATHS = +process.env.VERIFY_PATHS || 4096, rows = [], err = { lm: [], old: [], oc: [] };
  log(`verify: ${probes.length} probes x ${PATHS} paths (3 bounces) vs ${j.mode} map baked ${j.date}`);
  for (const [name, o, d] of probes) {
    const l = Math.hypot(...d), dd = d.map((v) => v / l);
    if (!tr.closest(o[0], o[1], o[2], dd[0], dd[1], dd[2], 60) || S.TK[R.tri] !== 0) { log(`  ${name.padEnd(22)} no lightmapped surface`); continue; }
    const t = R.tri, w1 = R.u, w2 = R.v, p = [o[0] + dd[0] * R.t, o[1] + dd[1] * R.t, o[2] + dd[2] * R.t], f = [S.TFo[t * 3], S.TFo[t * 3 + 1], S.TFo[t * 3 + 2]];
    if (f[0] * dd[0] + f[1] * dd[1] + f[2] * dd[2] > 0) { log(`  ${name.padEnd(22)} back face`); continue; }
    const refS = [0, 0, 0], refO = [0, 0, 0];
    for (let k = 0; k < PATHS; k++) { const r = ind(p, f, 3); for (let c = 0; c < 3; c++) { refS[c] += r[0][c] / PATHS; refO[c] += r[1][c] / PATHS; } }
    const lmS = lmAt(t, w1, w2, 'sunny'), lmO = lmAt(t, w1, w2, 'overcast'), old = legacyAt(t, w1, w2, f);
    const rS = lum(lmS) / lum(refS), rO = lum(lmO) / lum(refO), rL = old ? lum(old) / lum(refS) : NaN;
    err.lm.push(Math.log2(rS)); err.oc.push(Math.log2(rO)); if (old) err.old.push(Math.log2(rL));
    rows.push(`  ${name.padEnd(22)} p ${p.map((v) => v.toFixed(1)).join(',').padEnd(17)} sunny ref ${lum(refS).toFixed(4)} lm ${lum(lmS).toFixed(4)} (x${rS.toFixed(2)}) old ${old ? lum(old).toFixed(4) : '-'} (x${rL.toFixed(2)}) | overcast ref ${lum(refO).toFixed(4)} lm x${rO.toFixed(2)}`);
    console.log(rows[rows.length - 1]);
  }
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length)), rmsLn = (a) => rms(a) * Math.LN2;
  log(`RMS log error vs reference (natural log; log2 in brackets): lightmap sunny ${rmsLn(err.lm).toFixed(3)} (${rms(err.lm).toFixed(3)}), overcast ${rmsLn(err.oc).toFixed(3)} (${rms(err.oc).toFixed(3)}); old per-vertex bake sunny ${rmsLn(err.old).toFixed(3)} (${rms(err.old).toFixed(3)}); n=${err.lm.length}`);
  return { err, rows };
}
