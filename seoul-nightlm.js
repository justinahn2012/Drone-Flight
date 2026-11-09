// seoul-nightlm.js: night lightmaps for Neon Seoul's static light (P3 stream D, lighting #3: the L5 bake). Pure JS, no
// three.js, so it runs in seoul-light.js (node, tests, tools/bakelm.mjs --night) and in a module Worker (the browser,
// off the main thread: seoul-nightlm-worker.js) alike.
//
// A structured lightmap, no UV unwrap: Seoul's blocks are extruded footprints, so every wall lies on a footprint edge.
// - Ground: a top-down map over the light grid's bounds at `gres` m (texels inside a building are left invalid).
// - Facades: each exposed footprint edge gets a rect in one atlas, `fres` m per texel along the edge and up the wall
//   (texels with a neighbour's building in front at that height are left invalid).
// - Lookup: a 1 m raster holds the two nearest exposed edges of every cell within `near` m of a wall; the edge table
//   gives origin, direction, outward normal and the atlas rect. A fragment whose normal matches an edge's reads the
//   atlas; an up-facing fragment near the ground reads the ground map; anything else (props, people, roofs, invalid
//   texels) keeps the irradiance volume.
// - Content (scene-linear irradiance x NITS, rgb, alpha = valid): every STATIC emitter (not the in-place animated
//   screens, which stay per-fragment, nor the moving vehicles) on the texel's normal, through the same lobes and
//   geometry terms as the per-fragment grid, with no K limit, occluded by the heightfield (the binning's per-cell
//   occlusion bits at the bracketing probe heights), plus the volume's indirect part (ground and wall bounce, lit
//   windows, sky) at the texel. Lightmapped fragments take their static diffuse from here and only the specular of
//   the grid's static lights (seoul-light.js), so nothing is counted twice.

export const NIGHT_LM = { gres: 0.5, fres: 0.5, atlasW: 2048, rasterRes: 1, near: 1.25, version: 1 };

// ---- lobes (seoul-light.js imports these: one copy for JS, the GLSL mirror lives there)
export const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function lobeStreet(dx, dy, dz, fx, fz) {   // type-II forward throw: ~uniform ground illuminance out to a per-azimuth cutoff
  const c = -dy; if (c <= 1e-4) return 0;
  const hl = Math.hypot(dx, dz), t = hl / c, fw = hl > 1e-5 ? (dx * fx + dz * fz) / hl : 0;
  const tc = fw >= 0 ? 3.1 + (1.75 - 3.1) * fw : 3.1 + (0.7 - 3.1) * -fw;   // tan(cutoff): 72 deg along the road, 60 across, 35 back
  return Math.min(1 / (c * c * c), 30) * (1 - sstep(tc * 0.8, tc * 1.15, t));
}
export function lobeBeam(dx, dy, dz, fx, fz) {      // low beam: +-23 deg wide, peak 2 deg down, cut at +0.9 deg, long tail toward the bumper
  const fw = dx * fx + dz * fz; if (fw <= 1e-4) return 0;
  const th = (dx * fz - dz * fx) / fw, tv = dy / fw, dv = tv + 0.035, sv = dv > 0 ? 0.05 : 0.16;
  return Math.exp(-(th * th) / (0.42 * 0.42)) * Math.exp(-(dv * dv) / (sv * sv)) * (1 - sstep(-0.02, 0.015, tv));
}

// ---- packed light metas (seoul-light.js meta() -> packMeta): MS floats per light
export const MS = 20;
export function packMeta(m, out, i, skip = 0) {
  const o = i * MS;
  out[o] = m.x; out[o + 1] = m.y; out[o + 2] = m.z; out[o + 3] = m.A; out[o + 4] = m.omni;
  out[o + 5] = m.n[0]; out[o + 6] = m.n[1]; out[o + 7] = m.n[2]; out[o + 8] = m.I[0]; out[o + 9] = m.I[1]; out[o + 10] = m.I[2];
  out[o + 11] = m.range; out[o + 12] = m.ty; out[o + 13] = m.hl; out[o + 14] = m.a; out[o + 15] = m.tx; out[o + 16] = m.ty_; out[o + 17] = m.tz; out[o + 18] = skip;
}
// irradiance factor (I x this = E on a face toward the light) at p, direction to the light in L (same as seoul-light kAt)
export function kAtP(M, i, px, py, pz, L) {
  const o = i * MS, mx = M[o], my = M[o + 1], mz = M[o + 2], a = M[o + 14], tx = M[o + 15], ty = M[o + 16], tz = M[o + 17], range = M[o + 11];
  let lx = mx - px, ly = my - py, lz = mz - pz, x = 0;
  if (a > 0) { x = -(lx * tx + ly * ty + lz * tz); const c = Math.max(-a, Math.min(a, x)); lx += tx * c; ly += ty * c; lz += tz * c; }
  const d2 = Math.max(lx * lx + ly * ly + lz * lz, 1e-4);
  if (d2 >= range * range) return 0;
  const d = Math.sqrt(d2), ux = lx / d, uy = ly / d, uz = lz / d; L[0] = ux; L[1] = uy; L[2] = uz;
  const ty0 = M[o + 12], n0 = M[o + 5], n1 = M[o + 6], n2 = M[o + 7];
  let fe;
  if (ty0 === 0) { const om = M[o + 4], ce = -(ux * n0 + uy * n1 + uz * n2); fe = Math.max(ce, 0) * (1 - om) + (0.55 + 0.45 * ce) * om; }
  else if (ty0 === 1) fe = lobeStreet(-ux, -uy, -uz, n0, n2);
  else fe = lobeBeam(-ux, -uy, -uz, n0, n2);
  if (fe <= 0) return 0;
  let q = d / range; q = 1 - q * q * q * q;
  const A = M[o + 3];
  if (a > 0.01) {
    const vx = px - mx, vy = py - my, vz = pz - mz, hs = Math.sqrt(a * a + A) - a;
    const rp = Math.sqrt(Math.max(vx * vx + vy * vy + vz * vz - x * x, 0) + hs * hs * 0.3183);
    return fe * q * q * (Math.atan((a - x) / rp) + Math.atan((a + x) / rp)) / (2 * a * rp);
  }
  return fe * q * q / (d2 + A * 0.3183);
}

// ---- half floats (no three.js)
const _hf = new Float32Array(1), _hu = new Uint32Array(_hf.buffer);
export function toHalf(v) {
  _hf[0] = Math.max(-65000, Math.min(65000, v)); const x = _hu[0], s = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
  if (e <= 0) { if (e < -10) return s; m |= 0x800000; const t = 14 - e; return s | ((m + (1 << (t - 1))) >> t); }
  const h = s | (e << 10) | ((m + 0x1000) >> 13); return e >= 31 ? s | 0x7bff : h;
}

// ---- plan: exposed edges, atlas rects, the lookup raster, the ground map's frame
// HF: { at(x, z) } (seoul-light's heightField); B: the light grid's bounds { x0, z0, x1, z1 }
export function planLM(layout, HF, B, P = NIGHT_LM) {
  const E = [];   // [ox, oz, dx, dz, nx, nz, len, hgt]
  for (const l of layout?.lots || []) {
    const F = l.footprint; if (!F || F.length < 3) continue;
    let ar = 0; for (let i = 0; i < F.length; i++) { const a = F[i], b = F[(i + 1) % F.length]; ar += a[0] * b[1] - b[0] * a[1]; }
    const sg = ar > 0 ? 1 : -1, h = (l.floors || 1) * (l.floorH || 3.2);
    for (let i = 0; i < F.length; i++) {
      const a = F[i], b = F[(i + 1) % F.length], dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz); if (len < 0.8) continue;
      const ux = dx / len, uz = dz / len, nx = uz * sg, nz = -ux * sg;   // outward (x right of z-forward for a CCW ring in x/z)
      // exposed somewhere: sample the air 1 m outside at the top third of the wall along the edge
      let open = false; for (let t = 0.1; t <= 0.9 && !open; t += 0.2) { const ox = a[0] + dx * t + nx * 1.0, oz = a[1] + dz * t + nz * 1.0; if (HF.at(ox, oz) < h - 0.5) open = true; }
      if (open) E.push([a[0], a[1], ux, uz, nx, nz, len, h]);
    }
  }
  // the outward test: a point just outside must be air at ground level for most walls; flip edges whose "outside" is
  // inside their own lot (footprints with an unexpected winding)
  for (const e of E) { const mx = e[0] + e[2] * e[6] / 2, mz = e[1] + e[3] * e[6] / 2, inA = HF.at(mx + e[4] * 0.6, mz + e[5] * 0.6), inB = HF.at(mx - e[4] * 0.6, mz - e[5] * 0.6); if (inA >= e[7] - 0.1 && inB < inA) { e[4] = -e[4]; e[5] = -e[5]; } }
  // atlas: shelf packing, tallest first, 1 texel gutter round each rect
  const f = P.fres, W = P.atlasW, ord = E.map((_, i) => i).sort((p, q) => E[q][7] - E[p][7]);
  const rect = new Int32Array(E.length * 4); let sx = 0, sy = 0, sh = 0;
  for (const i of ord) {
    const w = Math.ceil(E[i][6] / f) + 2, h = Math.ceil(E[i][7] / f) + 2;
    if (w > W) { rect[i * 4 + 2] = 0; continue; }
    if (sx + w > W) { sy += sh; sx = 0; sh = 0; }
    rect[i * 4] = sx; rect[i * 4 + 1] = sy; rect[i * 4 + 2] = w; rect[i * 4 + 3] = h; sx += w; sh = Math.max(sh, h);
  }
  const atlasH = Math.max(1, sy + sh);
  // lookup raster: two nearest edges (with different normals) per cell within `near` m
  const rr = P.rasterRes, rw = Math.ceil((B.x1 - B.x0) / rr), rh = Math.ceil((B.z1 - B.z0) / rr);
  const ras = new Uint16Array(rw * rh * 2), rd = new Float32Array(rw * rh * 2).fill(1e9);
  E.forEach((e, i) => {
    if (!rect[i * 4 + 2]) return;
    const [ox, oz, ux, uz, nx, nz, len] = e, nr = P.near;
    const xa = Math.min(ox, ox + ux * len) - nr, xb = Math.max(ox, ox + ux * len) + nr, za = Math.min(oz, oz + uz * len) - nr, zb = Math.max(oz, oz + uz * len) + nr;
    for (let j = Math.max(0, Math.floor((za - B.z0) / rr)); j <= Math.min(rh - 1, Math.floor((zb - B.z0) / rr)); j++)
      for (let k = Math.max(0, Math.floor((xa - B.x0) / rr)); k <= Math.min(rw - 1, Math.floor((xb - B.x0) / rr)); k++) {
        const px = B.x0 + (k + 0.5) * rr - ox, pz = B.z0 + (j + 0.5) * rr - oz, t = Math.max(0, Math.min(len, px * ux + pz * uz));
        const d = Math.hypot(px - ux * t, pz - uz * t); if (d > nr + 0.71 * rr) continue;
        const c = (j * rw + k) * 2, id = i + 1;
        if (d < rd[c]) { if (ras[c] && (E[ras[c] - 1][4] * nx + E[ras[c] - 1][5] * nz) < 0.7) { ras[c + 1] = ras[c]; rd[c + 1] = rd[c]; } ras[c] = id; rd[c] = d; }
        else if (d < rd[c + 1] && (E[ras[c] - 1][4] * nx + E[ras[c] - 1][5] * nz) < 0.7) { ras[c + 1] = id; rd[c + 1] = d; }
      }
  });
  const g = P.gres, gw = Math.ceil((B.x1 - B.x0) / g), gh = Math.ceil((B.z1 - B.z0) / g);
  return { edges: Float32Array.from(E.flat()), nE: E.length, rect, atlasW: W, atlasH, raster: ras, rw, rh, rr, x0: B.x0, z0: B.z0, gres: g, fres: f, gw, gh };
}

// ---- bake. job = { plan, M (packed metas), cs/pe/po (per light-grid cell CSR: emitter ids + occlusion bits at YS),
// grid {x0, z0, cell, gw, gh}, YS, H {H, nx, nz, res, x0, z0}, VI (indirect per probe: rgb + vertical L1, NP x 4) }
export function bakeLM(job) {
  const t0 = Date.now(), { plan, M, cs, pe, po, grid, YS, VI } = job, NL = YS.length, Hr = job.H;
  const at = (x, z) => { const i = Math.floor((x - Hr.x0) / Hr.res), j = Math.floor((z - Hr.z0) / Hr.res); return i < 0 || j < 0 || i >= Hr.nx || j >= Hr.nz ? 0 : Hr.H[j * Hr.nx + i]; };
  const layer = (y) => { if (y <= YS[0]) return 0; for (let k = 1; k < NL; k++) if (y < YS[k]) return k - 1 + (y - YS[k - 1]) / (YS[k] - YS[k - 1]); return NL - 1; };
  const L = [0, 0, 0], out = [0, 0, 0, 0];
  // irradiance at p (normal n) from cell c's light list + the indirect at that column; alpha 1
  function texel(px, py, pz, nx, ny, nz, cx, cz) {
    out[0] = out[1] = out[2] = 0; out[3] = 0;
    if (cx < 0 || cz < 0 || cx >= grid.gw || cz >= grid.gh) return out;
    const c = cz * grid.gw + cx, ly = Math.max(0, Math.min(NL - 1, layer(py))), k0 = Math.floor(ly), k1 = Math.min(NL - 1, k0 + 1), u = ly - k0;
    for (let q = cs[c], qe = cs[c + 1]; q < qe; q++) {
      const ob = po[q], v = ((ob >> k0) & 1 ? 0 : 1 - u) + ((ob >> k1) & 1 ? 0 : u); if (v <= 0) continue;
      const i = pe[q]; if (M[i * MS + 18]) continue;
      const f = kAtP(M, i, px, py, pz, L); if (f <= 0) continue;
      const cl = L[0] * nx + L[1] * ny + L[2] * nz; if (cl <= 0) continue;
      const w = f * cl * v, o = i * MS; out[0] += M[o + 8] * w; out[1] += M[o + 9] * w; out[2] += M[o + 10] * w;
    }
    // indirect: the column's probes at the bracketing layers, L1 vertical term on the normal
    const p0 = (c * NL + k0) * 4, p1 = (c * NL + k1) * 4;
    for (let j = 0; j < 3; j++) { const a = VI[p0 + j] * (1 - u) + VI[p1 + j] * u; out[j] += a * Math.max(0, 1 + (VI[p0 + 3] * (1 - u) + VI[p1 + 3] * u) * ny); }
    out[3] = 1; return out;
  }
  // ground
  const gw = plan.gw, gh = plan.gh, G = new Uint16Array(gw * gh * 4); let nG = 0;
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const x = plan.x0 + (i + 0.5) * plan.gres, z = plan.z0 + (j + 0.5) * plan.gres;
    if (at(x, z) > 0) continue;
    const r = texel(x, 0.02, z, 0, 1, 0, Math.floor((x - grid.x0) / grid.cell), Math.floor((z - grid.z0) / grid.cell)); if (!r[3]) continue;
    const o = (j * gw + i) * 4; G[o] = toHalf(r[0]); G[o + 1] = toHalf(r[1]); G[o + 2] = toHalf(r[2]); G[o + 3] = toHalf(1); nG++;
  }
  // facades
  const AW = plan.atlasW, AH = plan.atlasH, A = new Uint16Array(AW * AH * 4), E = plan.edges, f = plan.fres; let nA = 0;
  for (let e = 0; e < plan.nE; e++) {
    const R = plan.rect, u0 = R[e * 4], v0 = R[e * 4 + 1], w = R[e * 4 + 2], h = R[e * 4 + 3]; if (!w) continue;
    const ox = E[e * 8], oz = E[e * 8 + 1], ux = E[e * 8 + 2], uz = E[e * 8 + 3], nx = E[e * 8 + 4], nz = E[e * 8 + 5], len = E[e * 8 + 6], hg = E[e * 8 + 7];
    for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) {
      // gutter texels clamp to the edge's own surface (bilinear reads at the rim stay on the wall)
      const t = Math.max(0.05, Math.min(len - 0.05, (a - 0.5) * f)), y = Math.max(0.05, Math.min(hg - 0.05, (b - 0.5) * f));
      const px = ox + ux * t + nx * 0.05, pz = oz + uz * t + nz * 0.05;
      if (at(px + nx * 0.9, pz + nz * 0.9) > y) continue;   // a neighbour's wall in front at this height: not exposed
      const qx = px + nx * 1.0, qz = pz + nz * 1.0;         // the street-side cell's light list
      const r = texel(px, y, pz, nx, 0, nz, Math.floor((qx - grid.x0) / grid.cell), Math.floor((qz - grid.z0) / grid.cell)); if (!r[3]) continue;
      const o = ((v0 + b) * AW + u0 + a) * 4; A[o] = toHalf(r[0]); A[o + 1] = toHalf(r[1]); A[o + 2] = toHalf(r[2]); A[o + 3] = toHalf(1); nA++;
    }
  }
  return { ground: G, atlas: A, texels: { ground: nG, facade: nA }, ms: Date.now() - t0 };
}
