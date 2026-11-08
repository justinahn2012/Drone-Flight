#!/usr/bin/env node
// tools/test-lightmap.mjs — stream A1 checks (node, ~5 s): node tools/test-lightmap.mjs
//  1. uv2 is deterministic (two builds, same geometryHash) and sane (every lightmapped vertex inside the atlas,
//     every triangle inside its own chart rect, chart rects disjoint)
//  2. the committed lm.json matches this geometry (a mismatch is reported, not failed: expected right after other
//     streams merge, until `node tools/bakelm.mjs` is re-run)
//  3. hash-mismatch -> fallback: lmMatch() refuses a moved vertex, a changed triangle, a moved sun, a missing or
//     old lm.json, and accepts a cosmetic attribute change (aY / uv) — so buildBando bakes per vertex exactly when
//     the lightmap would be wrong
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THREE = await import('three');
const wb = await import(path.join(ROOT, 'world-bando.js'));
let fails = 0; const ok = (c, msg) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${msg}`); if (!c) fails++; };

const geo = wb.buildGeometry(), h = wb.geometryHash(geo), lay = geo.terr.userData.lm;
ok(wb.geometryHash(wb.buildGeometry()) === h, `deterministic geometryHash ${h} (atlas ${lay.W}x${lay.H}, texel ${lay.texel} m, ${lay.charts} charts)`);
{ // uv2 sanity, with the packer's chart detail
  const g2 = wb.buildGeometry(), L = wb.lightmapUV2(g2.merged, g2.terr, g2.pathG, { detail: true });
  let out = 0, outside = 0, overlap = 0; const rects = [];
  for (const G of L.geos) {
    const u = G.g.attributes.uv2.array, ix = G.g.index.array;
    for (let i = 0; i < u.length; i++) if (!(u[i] > 0 && u[i] < 1)) out++;
    for (const ch of G.C.charts) {
      const w = (ch.rot ? ch.ny : ch.nx) + 2, hh = (ch.rot ? ch.nx : ch.ny) + 2; rects.push([ch.ox, ch.oy, w, hh]);
      for (const t of ch.tris) for (let k = 0; k < 3; k++) { const v = ix[t * 3 + k], x = u[v * 2] * L.W, y = u[v * 2 + 1] * L.H; if (x < ch.ox + 1.49 || x > ch.ox + w - 1.49 || y < ch.oy + 1.49 || y > ch.oy + hh - 1.49) outside++; }
    }
  }
  rects.push([L.terr.ox, L.terr.oy, L.terr.n + 2, L.terr.n + 2]);
  const occ = new Uint8Array(L.W * L.H); for (const [x, y, w, hh] of rects) for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + w; xx++) { if (occ[yy * L.W + xx]) overlap++; occ[yy * L.W + xx] = 1; }
  ok(out === 0 && outside === 0 && overlap === 0, `uv2: ${out} coords outside the atlas, ${outside} triangle corners outside their chart, ${overlap} overlapping rect texels`);
}
const jf = path.join(ROOT, 'lm.json'), j = fs.existsSync(jf) ? JSON.parse(fs.readFileSync(jf, 'utf8')) : null;
const sun = (k) => new THREE.Vector3(...(j?.skies?.[k]?.sunDir || wb.SKIES[k].sunDir)).normalize();
if (!j) console.log('note: no lm.json in the repo root (run node tools/bakelm.mjs)');
else {
  const m = wb.lmMatch(j, geo, 'sunny', sun('sunny'));
  if (!m.ok && !process.argv.includes('--allow-stale')) fails++;   // a stale lightmap = a ~10 s phone load: fail unless explicitly allowed
  console.log(`${m.ok ? 'ok  ' : 'STALE'} committed lm.json (${j.mode}, ${j.date}) vs this geometry: ${m.ok ? 'matches, the game uses the lightmaps' : m.why + ' -> the game bakes per vertex until node tools/bakelm.mjs is re-run'}`);
}
// mismatch -> fallback (against a synthetic lm.json for this exact geometry)
const fake = { version: 1, hash: h, W: lay.W, H: lay.H, skies: { sunny: { file: 'lm_sunny.png', range: [-12, 3], sunDir: sun('sunny').toArray() }, overcast: { file: 'lm_overcast.png', range: [-12, 3], sunDir: sun('overcast').toArray() } } };
ok(wb.lmMatch(fake, geo, 'sunny', sun('sunny')).ok && wb.lmMatch(fake, geo, 'overcast', sun('overcast')).ok, 'matching geometry + sun -> lightmap');
const variant = (fn) => { const g = wb.buildGeometry(); fn(g); return wb.lmMatch(fake, g, 'sunny', sun('sunny')); };
let r = variant((g) => { g.merged.wall.attributes.position.array[7] += 0.01; }); ok(!r.ok, `vertex moved 1 cm -> fallback (${r.why})`);
r = variant((g) => { const ix = g.merged.slab.index.array; const t = ix[0]; ix[0] = ix[1]; ix[1] = t; }); ok(!r.ok, `triangle winding changed -> fallback (${r.why})`);
r = variant((g) => { g.terr.attributes.position.array[1] += 0.02; }); ok(!r.ok, `terrain moved -> fallback (${r.why})`);
r = variant((g) => { const a = g.merged.wall.attributes.aY.array; for (let i = 0; i < a.length; i++) a[i] += 0.3; const u = g.merged.silo.attributes.uv.array; for (let i = 0; i < u.length; i++) u[i] *= 1.1; }); ok(r.ok, 'aY / uv retuned (cosmetic) -> lightmap still used');
r = wb.lmMatch(fake, geo, 'sunny', sun('sunny').clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.87)); ok(!r.ok, `sun rotated (SKIES rotY 0.87) -> fallback (${r.why})`);
ok(!wb.lmMatch(null, geo, 'sunny', sun('sunny')).ok, 'no lm.json -> fallback');
ok(!wb.lmMatch({ ...fake, version: 0 }, geo, 'sunny', sun('sunny')).ok, 'old lm.json version -> fallback');
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
