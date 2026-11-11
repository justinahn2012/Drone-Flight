// seoul/tools/test-facades.mjs — [P2-C] facades and layout against PLAN-P2's binding numbers (~5 s):  node seoul/tools/test-facades.mjs
//  1. window luminance: 2F-4F on commercial streets ~55 % lit, 5F and up 12-20 %, lit 5-25 nits, unlit 0.5-5 nits
//  2. shop interiors seen through glass 30-130 nits (store emitters), every lit shop has an emitter
//  3. the interior atlas: 24 tiles of 512 px (rooms, posters, mid-depth layers), deterministic, room means sane
//  4. layout: measured clearances on the Seogyo-365 fork (>= 6.3 m at walk0, >= 9 m by Hongik-ro), R1-R2 is 'walking',
//     Y151 faces Yanghwa-ro
//  5. the export entry: buildGeometry({seed}) returns the contract, and the dressing hook tolerates a throwing partner
import fs from 'node:fs';
import * as THREE from 'three';
import { buildSeoulGeometry, buildGeometry, NITS } from '../../world-seoul.js';
import { buildInteriorAtlas } from '../../seoul-interiors.js';

const ROOT = new URL('../', import.meta.url);
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const layout = JSON.parse(fs.readFileSync(new URL('layout.json', ROOT), 'utf8'));
const geo = buildSeoulGeometry(layout, { dressing: false });
const kind = new Map(layout.streets.map((s) => [s.id, s.kind]));

// 1. windows
const by = { low: [0, 0], high: [0, 0], tower: [0, 0] }, litN = [], unlitN = [], dimN = [];
for (const l of layout.lots) {
  const i = geo.lotInfo.get(l.id), comm = kind.get(l.street) !== 'alley';
  // [P4-C] a tall lot (8F+) on a main road or the walking street is an office tower, lit 35 % above 4F (lighting #3)
  const tw = l.floors >= 8 && ['main', 'walking'].includes(kind.get(l.street));
  for (const w of i.windows) { (w.lit ? litN : w.dim ? dimN : unlitN).push(w.nits); if (!comm) continue; const k = w.f <= 3 ? 'low' : tw ? 'tower' : 'high'; by[k][1]++; if (w.lit) by[k][0]++; }
}
const share = (k) => by[k][0] / by[k][1];
ok(share('low') > 0.48 && share('low') < 0.62, `2F-4F commercial lit share ${share('low').toFixed(3)} (55 %)`);
ok(share('high') >= 0.12 && share('high') <= 0.2, `5F+ commercial lit share ${share('high').toFixed(3)} (12-20 %, towers apart)`);
ok(share('tower') >= 0.27 && share('tower') <= 0.4, `5F+ tower lit share ${share('tower').toFixed(3)} (35 %, lighting #3)`);
ok(litN.every((n) => n >= 5 && n <= 25), `lit windows 5-25 nits (${Math.min(...litN)}-${Math.max(...litN)})`);
ok(unlitN.every((n) => n >= 0.5 && n <= 1.2), `unlit windows 0.5-1.2 nits (${Math.min(...unlitN)}-${Math.max(...unlitN)})`);
{ const d = dimN.length / (dimN.length + unlitN.length); ok(d > 0.1 && d < 0.2 && dimN.every((n) => n >= 1.5 && n <= 3), `dim-lit windows ${(d * 100).toFixed(1)} % of the dark ones at 1.5-3 nits (fpv #3)`); }
// the aEm channel really carries those luminances (rgb luminance / NITS)
{ const e = geo.merged.glass.getAttribute('aEm'), wk = geo.merged.glass.getAttribute('aWin'); let lo = Infinity, hi = 0;
  for (let i = 0; i < e.count; i += 6) { if (wk.getZ(i) >= 4) continue; const Y = (0.2126 * e.getX(i) + 0.7152 * e.getY(i) + 0.0722 * e.getZ(i)) / NITS; lo = Math.min(lo, Y); hi = Math.max(hi, Y); }
  ok(lo >= 0.45 && hi <= 26, `glass aEm luminance ${lo.toFixed(2)}-${hi.toFixed(2)} nits`); }

// [P3-C] atlas groups (perf #1): what is drawn is ground / city / glass / lanepaint / ao, layers resolve, KTX2 slices exist
{ const { SEOUL_GROUPS, SEOUL_TEX_IDS, SEOUL_LAYER_MAX } = await import('../../world-seoul.js');
  const keys = Object.keys(geo.merged).sort();
  ok(['ao', 'city', 'glass', 'ground', 'lanepaint'].every((k) => keys.includes(k)) && keys.length === 5, `drawn groups ${keys.join(', ')} (dressing off)`);
  for (const g of ['ground', 'city']) { const a = geo.merged[g].getAttribute('aLay'); let bad = 0; for (let i = 0; i < a.count; i++) { const l = geo.layers[a.getX(i)]; if (!l || (g === 'ground') !== SEOUL_GROUPS.ground.includes(l.key)) bad++; } ok(a && !bad, `${g}: every vertex has a valid aLay (${a?.count})`); }
  ok(geo.layers.length <= SEOUL_LAYER_MAX && geo.layers.every((l) => l.diff < SEOUL_TEX_IDS.length && l.nor < SEOUL_TEX_IDS.length), `${geo.layers.length} layers, slices in range`);
  const tris = (o) => Object.values(o).reduce((s, g) => s + g.getAttribute('position').count / 3, 0);
  ok(tris(geo.merged) === tris(geo.byKey), `grouping keeps every triangle (${tris(geo.merged)})`);
  const tex = new URL('../tex/', import.meta.url);
  ok(SEOUL_TEX_IDS.every((id) => fs.existsSync(new URL(`${id}_diff.ktx2`, tex)) && fs.existsSync(new URL(`${id}_nor_gl.ktx2`, tex))), `${SEOUL_TEX_IDS.length} x 2 KTX2 slices vendored`);
  ok(fs.existsSync(new URL('basis/basis_transcoder.wasm', tex)) && fs.existsSync(new URL('basis/basis_transcoder.js', tex)), 'Basis transcoder vendored (no hot-links)');
  ok(!fs.readFileSync(new URL('../../world-seoul.js', import.meta.url), 'utf8').includes('texLoader.load('), 'no JPG hot-link on the main path'); }

// 2. shops
const stores = geo.emitters.filter((e) => e.kind === 'store'), lobbies = geo.emitters.filter((e) => e.kind === 'lobby');
ok(stores.length + lobbies.length === geo.facts.shopsLit && stores.length > 150, `store + lobby emitters ${stores.length} + ${lobbies.length} = lit shops ${geo.facts.shopsLit}`);
ok(lobbies.every((e) => e.nits >= 80 && e.nits <= 150), `tower lobbies 80-150 nits (contract P3-CD, ${lobbies.length})`);
{ const cr = geo.emitters.filter((e) => e.kind === 'crown'); ok(cr.length > 0 && cr.every((e) => e.normal[1] > 0.5 && e.nits >= 15 && e.nits <= 40), `crown wash records face up the wall (${cr.length})`); }
ok(geo.emitters.filter((e) => e.role === 'roof').length === geo.facts.roofLamps && geo.facts.roofLamps > 100, `roof wall packs ${geo.facts.roofLamps} (art #6)`);
// [P3-C] coloured rooms (club, karaoke, motel) are a filter on 30-130 white-equivalent nits: luminance x lum(filter) >= 15
const isCol = (e) => { const L = layout.lots.find((l) => l.id === e.lot); return ['club', 'karaoke', 'motel'].includes(L?.use); };
ok(stores.every((e) => e.nits >= (isCol(e) ? 15 : 30) && e.nits <= 60), `shop interiors 30-60 nits (P4 fpv #2, graphics #2), coloured >= 15 (${Math.min(...stores.map((e) => e.nits))}-${Math.max(...stores.map((e) => e.nits))})`);
ok(stores.every((e) => Math.abs(0.2126 * e.rgb[0] + 0.7152 * e.rgb[1] + 0.0722 * e.rgb[2] - 1) < 0.02), 'store rgb has luminance 1 (rgb x nits = luminance)');
ok(!geo.colRanges.some((r) => ['glass', 'shop', 'sill', 'ao', 'frame'].includes(r.key)), 'glass, sills, frames and decals are render-only');

// 3. atlas
const A = buildInteriorAtlas();
ok(A.width === 2048 && A.height === 3072 && A.data.length === 2048 * 3072 * 4, 'atlas 2048 x 3072 RGBA (512 px tiles, P3)');
ok([...A.mean].every((m, i) => i >= 20 || i === 10 || i === 15 || (m > 0.05 && m < 2.5)), `tile means ${[...A.mean].map((m) => m.toFixed(2)).join(' ')}`);
// [P4-C] near layers (10 people, 15 window bar) carry figures: coverage between 5 and 60 %
for (const t of [10, 15]) { let cov = 0; const ox = (t % 4) * 512, oy = Math.floor(t / 4) * 512; for (let j = 0; j < 512; j += 4) for (let i = 0; i < 512; i += 4) cov += A.data[((oy + j) * 2048 + ox + i) * 4 + 3] / 255; cov /= 128 * 128;
  ok(cov > 0.05 && cov < 0.6, `near layer ${t} coverage ${(cov * 100).toFixed(1)} %`); }

// 4. layout
const segD = (p, a, b) => { const vx = b[0] - a[0], vz = b[1] - a[1], l2 = vx * vx + vz * vz || 1e-9, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / l2)); return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vz); };
const clearAt = (x, z) => { let d = Infinity; for (const l of layout.lots) { const P = l.footprint; for (let i = 0; i < P.length; i++) d = Math.min(d, segD([x, z], P[i], P[(i + 1) % P.length])); } return d; };
ok(clearAt(-36.09, -23.04) >= 3.15, `walk0 (Seogyo-365 fork) half-clearance ${clearAt(-36.09, -23.04).toFixed(2)} m (>= 3.15)`);
ok(clearAt(-9.43, -78.92) >= 4.5, `fork by Hongik-ro half-clearance ${clearAt(-9.43, -78.92).toFixed(2)} m (>= 4.5)`);
ok(layout.streets.some((s) => s.ko === '어울마당로' && s.kind === 'walking' && s.points.every(([, z]) => z < -118)), 'R1-R2 Walking Street is kind walking');
{ const y = layout.screens.find((s) => s.id === 'Y151'); ok(y && y.normal[0] > 0.5 && y.normal[2] > 0.5, `Y151 faces Yanghwa-ro (normal ${y?.normal})`); }

// 5. export entry + dressing tolerance
const ex = await buildGeometry({ seed: 11 });
ok(ex.merged && ex.colGeo && ex.spawn?.pos && ex.lines?.length && ex.materials?.glass && ex.bounds?.min, 'buildGeometry returns the export contract');
const bad = buildSeoulGeometry(layout, { dressing: { geometry() { throw new Error('boom'); } } });
ok(bad.facts.dressing.error === 'boom' && bad.facts.colTris === geo.facts.colTris, 'a throwing dressing module is tolerated');
const mock = buildSeoulGeometry(layout, { dressing: { geometry: () => ({ merged: { metal: new THREE.BoxGeometry(1, 1, 1) }, colTris: new THREE.BoxGeometry(1, 1, 1).translate(0, 50, 0), emitters: [{ id: 'm', kind: 'tent', pos: [0, 50, 0], nits: 50 }], setPieces: [{ id: 'x' }] }) } });
ok(mock.facts.colTris === geo.facts.colTris + 12 && mock.setPieces.length === 1 && mock.emitters.length === geo.emitters.length + 1, 'dressing colTris, emitters and set pieces merge');

console.log(`lit share 2F-4F ${(share('low') * 100).toFixed(1)} %, 5F+ ${(share('high') * 100).toFixed(1)} %, towers 5F+ ${(share('tower') * 100).toFixed(1)} %; windows ${geo.facts.windows}, tris ${geo.facts.tris}, collider ${geo.facts.colTris}`);
console.log(`facade tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
