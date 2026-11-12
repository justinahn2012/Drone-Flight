// seoul-nightlm.js: night lightmaps for Neon Seoul's static light (P3 stream D, lighting #3: the L5 bake). Pure JS, no
// three.js, so it runs in seoul-light.js (node, tests, tools/bakelm.mjs --night) and in a module Worker (the browser,
// off the main thread: seoul-nightlm-worker.js) alike.
//
// A structured lightmap, no UV unwrap: Seoul's blocks are extruded footprints, so every wall lies on a footprint edge.
// - Ground: a top-down map over the light grid's bounds at `gres` m (texels inside a building are left invalid).
// - Facades: each exposed footprint edge gets a rect in one atlas, `fres` m per texel along the edge and up the wall
//   (texels with a neighbour's building in front at that height are left invalid).
// - One texture: the ground map sits at the atlas's origin and the wall rects are packed round it (one sampler; the
//   raster and the edge table ride as extra rows of seoul-light's static record texture, so the lightmap costs the
//   material one texture unit, not four).
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

// version: the light model's revision (part of the shipped file's key: bump it whenever the model changes in a way the
// constants hashed by lmKey() don't capture). P4: 2 (spill lobe, urban floor, wall packs, RGB9E5).
// P5: 3 (store spill 0.5 and SPILL codes, omni 0.3 on signs, the falling urban floor, no floor within packFloorM of a wall
// pack, the sign wash: a Lambert record with omni >= washOmni lights its own wall within washM as if the wall faced it at
// washCos x (1 - d / washM)^2: the colour of a box or a letter on the wall round it).
// P6: 4 (the drawn sky dome in the bake, the wall-pack pool lobe, the store spill's trapezoid).
// P8: 5 (the store spill 0.7 and its trapezoid matched with a tolerance: Float32(0.7) !== 0.7; wall packs on shuttered and dark fronts).
export const NIGHT_LM = { gres: 0.5, fres: 0.5, atlasW: 2048, rasterRes: 1, near: 1.25, version: 5, file: './seoul/light/night-lm.bin', dilate: 6,
  packFloorM: 3, washM: 1.5, washCos: 0.25, washOmni: 0.25 };

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

// P6 (lighting #3, plan #1 "light pools from the wall lamps"): a wall pack is not a type-II street head (that lobe lays an
// even sheet of light to its cutoff, so P5's packs drew no pool and no scallop). A full-cutoff wall pack is a 120 deg cone
// about an axis 20 deg out from straight down, brightest on the axis (0.3 + 0.7 cos^2): with the plain 1/d^2 that is a
// pool on the pavers that falls to ~1/8 at 7 m out, and a V scallop on the wall under it (the wall 1 m below the fixture
// gets ~4x the pavers under it). D = lamp -> point, f = the forward off the wall.
export function lobePack(dx, dy, dz, fx, fz) {
  const c = -dy * 0.9397 + (dx * fx + dz * fz) * 0.342;   // cos to the axis
  if (c <= 0.42) return 0;
  return (0.3 + 0.7 * c * c) * sstep(0.42, 0.58, c);
}

// P6 (lighting #5, plan #1 "shop spill on the pavers"): a shop's glass spill (SPILL code 3, 0.5) was a broad Lambert lobe,
// a wash with no shape. Now it lands as the window's trapezoid: within ~1.6-2.4 x the drop below the glass's centre out from
// the facade (~3 m for a ground-floor shop) and within the glass's half width + 0.4-0.8 x the distance out to the side (the
// jambs' spread), at gain x the lobe so the spill's flux is unchanged (2.2: tests/seoul-light.mjs integrates it).
// v = point - light centre, n = the face's horizontal normal, A / a / hl = the record's area, half length, signed half length.
// P7 (lighting #1, plan "ground light": the spill died at the kerb, 3 m): the trapezoid reaches ~5 m (far 2.8-3.6 x the
// drop, ~4.5-5.5 m for a ground-floor shop) and its floor flattens with `lift` (x (1 + lift r^2), r = out / drop: the
// glass's upper rows throw farther than the lower), at gain 0.98 so the flux on the ground is the P6 spill's (tested):
// 1 m out ~0.6x, 3 m out ~7x, 4 m out from 0 to ~0.4x the 1 m value. Same flux, a longer pool.
export const SPILL_TRAP = { side: [0.4, 0.8, 0.15], far: [2.8, 3.6], gain: 0.98, lift: 0.6 };
// P8 (lighting #1, the first 15 m of the walking-street floor: the lit glass had no pool in front of it; the panel's 0.7 x the
// glass's exitance): a shop's glass spills 0.7 of its face flux down through the trapezoid (was 0.5). SPILL code 3.
export const SHOP_SPILL = 0.7;
export function spillTrap(vx, vy, vz, nx, nz, A, a, hl) {
  const out = vx * nx + vz * nz, drop = -vy; if (out <= 0 || drop <= 0) return 0;
  const sh = Math.sqrt(a * a + A) - a, Wh = hl > 0 ? a + sh / 2 : sh / 2, T = SPILL_TRAP;
  const le = Math.max(0, Math.abs(vx * nz - vz * nx) - Wh);
  const r = out / Math.max(drop, 0.3);
  return T.gain * (1 + T.lift * r * r) * (1 - sstep(T.side[0] * out, T.side[1] * out + T.side[2], le)) * (1 - sstep(T.far[0], T.far[1], r));
}

// ---- packed light metas (seoul-light.js meta() -> packMeta): MS floats per light
export const MS = 20;
export function packMeta(m, out, i, skip = 0) {
  const o = i * MS;
  out[o] = m.x; out[o + 1] = m.y; out[o + 2] = m.z; out[o + 3] = m.A; out[o + 4] = m.omni;
  out[o + 5] = m.n[0]; out[o + 6] = m.n[1]; out[o + 7] = m.n[2]; out[o + 8] = m.I[0]; out[o + 9] = m.I[1]; out[o + 10] = m.I[2];
  out[o + 11] = m.range; out[o + 12] = m.ty; out[o + 13] = m.hl; out[o + 14] = m.a; out[o + 15] = m.tx; out[o + 16] = m.ty_; out[o + 17] = m.tz; out[o + 18] = skip; out[o + 19] = m.down || 0;   // P4: down spill
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
  if (ty0 === 0) { const om = M[o + 4], ce = -(ux * n0 + uy * n1 + uz * n2), sp = M[o + 19]; fe = Math.max(ce, 0) * (1 - om) + (0.55 + 0.45 * ce) * om;
    if (sp > 0) fe += sp * Math.max(0.857 * uy + 0.515 * ce, 0) * (Math.abs(sp - SHOP_SPILL) < 1e-3 ? spillTrap(px - mx, py - my, pz - mz, n0, n2, M[o + 3], a, M[o + 13]) : 1); }
  else if (ty0 === 1) fe = lobeStreet(-ux, -uy, -uz, n0, n2);
  else if (ty0 === 3) fe = lobePack(-ux, -uy, -uz, n0, n2);
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
  // atlas: the ground map at (0, 0), then shelf packing round it, tallest first, 1 texel gutter round each rect
  const g = P.gres, gw = Math.ceil((B.x1 - B.x0) / g), gh = Math.ceil((B.z1 - B.z0) / g);
  const f = P.fres, W = Math.max(P.atlasW, gw + 256), ord = E.map((_, i) => i).sort((p, q) => E[q][7] - E[p][7]);
  const left = (y) => (y < gh + 2 ? gw + 2 : 0);
  const rect = new Int32Array(E.length * 4); let sx = left(0), sy = 0, sh = 0;
  for (const i of ord) {
    const w = Math.ceil(E[i][6] / f) + 2, h = Math.ceil(E[i][7] / f) + 2;
    if (w > W) { rect[i * 4 + 2] = 0; continue; }
    if (sx + w > W) { sy += sh; sh = 0; sx = left(sy); if (sx + w > W) { sy = Math.max(sy, gh + 2); sx = 0; } }
    rect[i * 4] = sx; rect[i * 4 + 1] = sy; rect[i * 4 + 2] = w; rect[i * 4 + 3] = h; sx += w; sh = Math.max(sh, h);
  }
  const atlasH = Math.max(gh, sy + sh);
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
  return { edges: Float32Array.from(E.flat()), nE: E.length, rect, atlasW: W, atlasH, raster: ras, rw, rh, rr, x0: B.x0, z0: B.z0, gres: g, fres: f, gw, gh };
}

// ---- bake. job = { plan, M (packed metas), cs/pe/po (per light-grid cell CSR: emitter ids + occlusion bits at YS),
// grid {x0, z0, cell, gw, gh}, YS, H {H, nx, nz, res, x0, z0}, VI (indirect per probe: rgb + vertical L1, NP x 4) }
export function bakeLM(job) {
  const t0 = Date.now(), { plan, M, cs, pe, po, grid, YS, VI } = job, NL = YS.length, Hr = job.H, P = NIGHT_LM;
  // P5: the wall packs in 4 m buckets (the urban floor is dropped within packFloorM of one)
  const CF = job.CF || null, WP = job.WP || new Float32Array(0), WB = new Map(), wk = (x, z) => (Math.floor(x / 4) + 8192) * 16384 + Math.floor(z / 4) + 8192;
  for (let i = 0; i < WP.length; i += 3) { const k = wk(WP[i], WP[i + 2]); if (!WB.has(k)) WB.set(k, []); WB.get(k).push(i); }
  const floorW = (px, py, pz) => { let d2 = Infinity; const r = P.packFloorM; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const i of WB.get(wk(px + a * 4, pz + b * 4)) || []) d2 = Math.min(d2, (WP[i] - px) ** 2 + (WP[i + 1] - py) ** 2 + (WP[i + 2] - pz) ** 2);
    return d2 >= r * r ? 1 : sstep(0.5 * r, r, Math.sqrt(d2)); };
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
      let cl = L[0] * nx + L[1] * ny + L[2] * nz;
      if (M[i * MS + 12] === 0 && M[i * MS + 4] >= P.washOmni) {   // P5 lighting #4: the sign's own colour on the wall round it
        const o = i * MS, dw = Math.hypot(M[o] - px, M[o + 1] - py, M[o + 2] - pz); if (dw < P.washM) cl = Math.max(cl, P.washCos * (1 - dw / P.washM) ** 2); }
      if (cl <= 0) continue;
      const w = f * cl * v, o = i * MS; out[0] += M[o + 8] * w; out[1] += M[o + 9] * w; out[2] += M[o + 10] * w;
    }
    // indirect: the column's probes at the bracketing layers, L1 vertical term on the normal
    const p0 = (c * NL + k0) * 4, p1 = (c * NL + k1) * 4;
    for (let j = 0; j < 3; j++) { const a = VI[p0 + j] * (1 - u) + VI[p1 + j] * u; out[j] += a * Math.max(0, 1 + (VI[p0 + 3] * (1 - u) + VI[p1 + 3] * u) * ny); }
    if (CF && WP.length) { const w = floorW(px, py, pz); if (w < 1) for (let j = 0; j < 3; j++) out[j] = Math.max(0, out[j] - (1 - w) * (CF[k0 * 3 + j] * (1 - u) + CF[k1 * 3 + j] * u)); }   // P5 lighting #3
    out[3] = 1; return out;
  }
  // ground: the atlas's top-left gw x gh texels
  const gw = plan.gw, gh = plan.gh, AW = plan.atlasW, AH = plan.atlasH, A = new Uint16Array(AW * AH * 4), G = A; let nG = 0;
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const x = plan.x0 + (i + 0.5) * plan.gres, z = plan.z0 + (j + 0.5) * plan.gres;
    if (at(x, z) > 0) continue;
    const r = texel(x, 0.02, z, 0, 1, 0, Math.floor((x - grid.x0) / grid.cell), Math.floor((z - grid.z0) / grid.cell)); if (!r[3]) continue;
    const o = (j * AW + i) * 4; G[o] = toHalf(r[0]); G[o + 1] = toHalf(r[1]); G[o + 2] = toHalf(r[2]); G[o + 3] = toHalf(1); nG++;
  }
  // dilate 2 texels into the buildings, so a bilinear read at a wall's foot stays on the map (no seam to the volume)
  for (let pass = 0; pass < 2; pass++) {
    const src = G.slice(0, gh * AW * 4);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const o = (j * AW + i) * 4; if (src[o + 3]) continue;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = i + di, y = j + dj; if (x < 0 || y < 0 || x >= gw || y >= gh) continue; const q = (y * AW + x) * 4; if (src[q + 3]) { G[o] = src[q]; G[o + 1] = src[q + 1]; G[o + 2] = src[q + 2]; G[o + 3] = src[q + 3]; break; } }
    }
  }
  // facades
  const E = plan.edges, f = plan.fres; let nA = 0;
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
  return { atlas: A, texels: { ground: nG, facade: nA }, ms: Date.now() - t0 };
}

// ---- P4 perf #3 / #5: the shipped lightmap. RGB9E5 (WebGL2 RGB9_E5: 4 bytes a texel, filterable; half of RGBA16F):
// invalid texels are filled from their valid neighbours first (NIGHT_LM.dilate passes), so the shader needs no alpha.
const E5MAX = 65408;   // (511 / 512) x 2^15
export function encodeRGB9E5(r, g, b) {
  r = Math.min(Math.max(r, 0), E5MAX) || 0; g = Math.min(Math.max(g, 0), E5MAX) || 0; b = Math.min(Math.max(b, 0), E5MAX) || 0;
  const m = Math.max(r, g, b); if (m < 5.97e-8) return 0;     // under 2^-24: black
  let e = Math.max(-16, Math.floor(Math.log2(m))) + 1;          // shared exponent (bias 15, stored 0..31): m < 2^e
  let sc = Math.pow(2, 9 - e); if (Math.floor(m * sc + 0.5) >= 512) { e += 1; sc *= 0.5; }
  return ((Math.floor(r * sc + 0.5) & 511) | ((Math.floor(g * sc + 0.5) & 511) << 9) | ((Math.floor(b * sc + 0.5) & 511) << 18) | ((e + 15) << 27)) >>> 0;
}
export function decodeRGB9E5(u, out = [0, 0, 0]) {
  const sc = Math.pow(2, (u >>> 27) - 15 - 9);
  out[0] = (u & 511) * sc; out[1] = ((u >>> 9) & 511) * sc; out[2] = ((u >>> 18) & 511) * sc; return out;
}
const _h2f = (() => { const t = new Float32Array(65536); for (let h = 0; h < 65536; h++) { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); } return t; })();
// bakeLM's RGBA16F atlas (alpha = valid) -> { data: RGB9E5 Uint32Array, valid: Uint8Array }; invalid texels take the mean
// of their valid 4-neighbours, `passes` times (what is left stays black: nothing samples it)
export function packLM(A16, W, H, passes = NIGHT_LM.dilate) {
  const N = W * H, R = new Float32Array(N * 3), V = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (A16[i * 4 + 3]) { V[i] = 1; R[i * 3] = _h2f[A16[i * 4]]; R[i * 3 + 1] = _h2f[A16[i * 4 + 1]]; R[i * 3 + 2] = _h2f[A16[i * 4 + 2]]; }
  const F = V.slice(), add = [];
  for (let p = 0; p < passes; p++) {
    add.length = 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i; if (F[k]) continue;
      let n = 0, r = 0, g = 0, b = 0;
      if (i > 0 && F[k - 1]) { r += R[k * 3 - 3]; g += R[k * 3 - 2]; b += R[k * 3 - 1]; n++; }
      if (i < W - 1 && F[k + 1]) { r += R[k * 3 + 3]; g += R[k * 3 + 4]; b += R[k * 3 + 5]; n++; }
      if (j > 0 && F[k - W]) { const q = (k - W) * 3; r += R[q]; g += R[q + 1]; b += R[q + 2]; n++; }
      if (j < H - 1 && F[k + W]) { const q = (k + W) * 3; r += R[q]; g += R[q + 1]; b += R[q + 2]; n++; }
      if (n) add.push(k, r / n, g / n, b / n);
    }
    if (!add.length) break;
    for (let q = 0; q < add.length; q += 4) { const k = add[q]; R[k * 3] = add[q + 1]; R[k * 3 + 1] = add[q + 2]; R[k * 3 + 2] = add[q + 3]; F[k] = 1; }
  }
  const D = new Uint32Array(N); for (let i = 0; i < N; i++) if (F[i]) D[i] = encodeRGB9E5(R[i * 3], R[i * 3 + 1], R[i * 3 + 2]);
  return { data: D, valid: V };
}
// the file: 'NLM2' | u32 header bytes | header JSON | payload (gzip of the texels as 4 byte planes, each delta-coded
// along the rows: smooth light compresses ~3-5x). Header: { key, w, h, version, enc, bytes, texels }.
export function lmPlanes(D, W, H) {   // RGB9E5 texels -> filtered planes (Uint8Array W x H x 4)
  const N = W * H, P = new Uint8Array(N * 4), b = new Uint8Array(D.buffer, D.byteOffset, N * 4);
  for (let p = 0; p < 4; p++) { const o = p * N; for (let j = 0; j < H; j++) { let prev = 0; for (let i = 0; i < W; i++) { const k = j * W + i, v = b[k * 4 + p]; P[o + k] = (v - prev) & 255; prev = v; } } }
  return P;
}
export function lmUnplanes(P, W, H) {  // inverse of lmPlanes -> Uint32Array (little-endian hosts)
  const N = W * H, D = new Uint32Array(N), b = new Uint8Array(D.buffer);
  for (let p = 0; p < 4; p++) { const o = p * N; for (let j = 0; j < H; j++) { let prev = 0; for (let i = 0; i < W; i++) { const k = j * W + i; prev = (prev + P[o + k]) & 255; b[k * 4 + p] = prev; } } }
  return D;
}
export function lmFile(header, gz) {   // gz: the gzipped planes
  const hj = new TextEncoder().encode(JSON.stringify({ ...header, bytes: gz.length })), out = new Uint8Array(8 + hj.length + gz.length);
  out.set([78, 76, 77, 50], 0); new DataView(out.buffer).setUint32(4, hj.length, true); out.set(hj, 8); out.set(gz, 8 + hj.length);
  return out;
}
export function lmFileHeader(buf) {    // -> { header, payload (Uint8Array view) } or null
  const u = new Uint8Array(buf); if (u.length < 8 || u[0] !== 78 || u[1] !== 76 || u[2] !== 77 || u[3] !== 50) return null;
  const n = new DataView(u.buffer, u.byteOffset).getUint32(4, true); if (8 + n > u.length) return null;
  let header; try { header = JSON.parse(new TextDecoder().decode(u.subarray(8, 8 + n))); } catch (e) { return null; }
  return { header, payload: u.subarray(8 + n) };
}
// the key: FNV-1a (two lanes) over the model constants and everything the bake reads, quantised (1/1024) so float
// noise between JS engines (V8 here, JavaScriptCore on the phone) can't split it. inputs: { consts (JSON-able), metas
// (packed MS floats), skip (per light), layout, grid }
export function lmKey({ consts, M, n, layout, grid }) {
  let a = 0x811c9dc5 | 0, b = 0x01000193 ^ 0x5bd1e995;
  const w = (v) => { v |= 0; a = Math.imul(a ^ v, 16777619); b = Math.imul(b ^ (v + 0x9e3779b9), 0x01000193) ^ (b >>> 15); };
  const q = (x) => w(Math.round((Number.isFinite(x) ? x : 0) * 1024));
  const str = (t) => { for (let i = 0; i < t.length; i++) w(t.charCodeAt(i)); };
  str(JSON.stringify(consts));
  w(n); for (let i = 0; i < n; i++) { const o = i * MS, skip = M[o + 18]; for (let k = 0; k < MS; k++) { if (skip && k >= 8 && k <= 10) continue; q(M[o + k]); } }   // (a skipped light's intensity: runtime-driven)
  for (const l of layout?.lots || []) { q(l.floors || 1); q(l.floorH || 3.2); for (const [x, z] of l.footprint || []) { q(x); q(z); } }
  for (const s of layout?.streets || []) { str(s.kind || ''); q(s.width || 6); for (const [x, z] of s.points || []) { q(x); q(z); } }
  for (const v of grid) q(v);
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
