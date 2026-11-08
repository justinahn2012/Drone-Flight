// tests/seoul-light.mjs: stream D checks for seoul-light.js (phase 2), node only (~20 s):  node tests/seoul-light.mjs
// 1 lobes conserve flux (a 12 klm street head puts ~its flux on the ground; a low beam ~1400 lm)
// 2 the heightfield stops light at a building; 3 animated screens are binned once (only their colour row changes)
// 4 the moving window takes the nearest lamps, ids in range; 5 a record decodes back to its light; 6 the volume is finite,
// non-negative and fills interior probes; 7 splitCells keeps every triangle; 8 the real block: attach + update budget.
import fs from 'node:fs';
import * as THREE from 'three';
import { attach, splitCells, heightField, SOURCE_TYPES } from '../seoul-light.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const approx = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const world = (extra = {}) => ({ scene: new THREE.Scene(), ...extra });
const flat = { lots: [], streets: [{ id: 's', points: [[-60, 0], [60, 0]], width: 10, kind: 'main' }, { id: 't', points: [[0, -60], [0, 60]], width: 10, kind: 'main' }] };

// 1 flux
{
  const C = attach(world(), [{ id: 'street:0', pos: [20, 8.7, -6], normal: [0, -1, 0], w: 0.56, h: 0.24, rgb: [1, 0.93, 0.82], nits: 9000, kind: 'street', lumens: 12000 }], { layout: flat, steam: false, airlight: false, cull: false });
  let flux = 0; for (let x = -25; x <= 65; x += 1) for (let z = -50; z <= 40; z += 1) { const p = C.probe(x + 0.5, 0.0, z + 0.5); if (p) flux += p.direct; }
  console.log(`street head: ${flux.toFixed(0)} lm on the ground of 12000 (range ${C.exportData().grid.cell} m cells)`);
  ok(flux > 0.7 * 12000 && flux < 1.05 * 12000, 'street lobe flux ' + flux.toFixed(0));
  // under the lamp vs 15 m along the road: type-II spreads the light (not a Lambertian hot spot)
  const a = C.probe(20.5, 0, -5.5).direct, b = C.probe(35.5, 0, -5.5).direct;
  ok(b > 0.3 * a, `type-II spread: ${a.toFixed(1)} lux under, ${b.toFixed(1)} at 15 m`);
  C.dispose();
}
{
  const head = { id: 'veh0:head', pos: [0, 0.68, 0], normal: [0, 0, -1], w: 1.4, h: 0.15, rgb: [1, 0.97, 0.92], nits: 20000, kind: 'vehicle', animated: true, dynamic: true, beam: {} };
  const C = attach(world(), [head, { id: 'store:x', pos: [50, 1.5, 50], normal: [0, 0, 1], w: 2, h: 2, nits: 80, kind: 'store' }], { layout: flat, steam: false, airlight: false, cull: false });
  C.update(0, { x: 0, y: 2, z: 0 });
  // integrate through the dynamic record with the same JS mirror: probe() only reads the static grid, so sample the
  // beam via a static twin instead
  const C2 = attach(world(), [{ ...head, kind: 'beamtest', range: 40, animated: false, dynamic: false }], { layout: flat, steam: false, airlight: false, cull: false });
  let flux = 0; for (let x = -30; x <= 30; x += 0.5) for (let z = -40; z <= 2; z += 0.5) { const p = C2.probe(x + 0.25, 0.0, z + 0.25); if (p) flux += p.direct * 0.25; }
  console.log(`low beam: ${flux.toFixed(0)} lm on the road of 1400`);
  ok(flux > 0.6 * 1400 && flux < 1.05 * 1400, 'beam flux ' + flux.toFixed(0));
  const e5 = C2.probe(0.25, 0, -5).direct, e25 = C2.probe(0.25, 0, -25).direct, back = C2.probe(0.25, 0, 4).direct;
  ok(e5 > 10 && e5 < 120 && e25 > 0.15 && e25 < 3 && back < 0.01, `beam profile: 5 m ${e5.toFixed(1)} lux, 25 m ${e25.toFixed(2)}, behind ${back.toFixed(3)}`);
  ok(C.stats.update.dyn === 1, 'one dynamic lamp selected');
  C.dispose(); C2.dispose();
}
// 2 occlusion: a 12 m tall block between a sign facing east and the street beyond it
{
  const layout = { lots: [{ id: 'B', footprint: [[0, -20], [10, -20], [10, 20], [0, 20]], floors: 4, floorH: 3 }], streets: [{ id: 's', points: [[-30, 0], [30, 0]], width: 8, kind: 'alley' }] };
  const sign = { id: 'sign', pos: [-3, 3, 0], normal: [1, 0, 0], w: 2, h: 1, nits: 1000, kind: 'channel', omni: 0 };   // faces the block's west wall
  const lamp = { id: 'neon', pos: [-3, 3, 0], normal: [1, 0, 0], w: 0.5, h: 0.5, nits: 1000, kind: 'neon', omni: 1 };
  const C = attach(world(), [sign, lamp], { layout, steam: false, airlight: false, cull: false });
  const west = C.probe(-1, 0.5, 0), east = C.probe(14, 0.5, 0);
  ok(west.lights >= 1 && west.direct > 1, `lit in front of the wall: ${west.direct.toFixed(1)} lux`);
  ok(east.lights === 0 && east.volume < 0.5, `nothing behind the block: ${east.lights} lights, volume ${east.volume.toFixed(2)} lux`);
  ok(C.stats.occludedPairs > 0, 'occluded pairs counted');
  const HF = C.heightField; ok(HF.occ(-3, 3, 0, 14, 0, [0.5, 4, 60]) === 0b011, 'heightfield: blocked at 0.5 and 4 m, clear at 60 m');
  C.dispose();
}
// 3 screens binned once; 4 moving window
{
  const scr = { id: 'scr', pos: [0, 4, -5], normal: [0, 0, 1], w: 4, h: 2.5, rgb: [1, 1, 1], nits: 200, kind: 'screen', animated: true };
  const vehicles = []; for (let i = 0; i < 200; i++) vehicles.push({ id: 'v' + i, pos: [-100 + i, 0.7, 3], normal: [1, 0, 0], w: 1.4, h: 0.15, rgb: [1, 0.97, 0.92], nits: 40000, kind: 'vehicle', animated: true, dynamic: true, beam: {} });
  const C = attach(world(), [scr, ...vehicles, { id: 'st', pos: [10, 1.5, -5], normal: [0, 0, 1], w: 3, h: 3, nits: 80, kind: 'store' }], { layout: flat, steam: false, airlight: false, cull: false, quality: 'auto' });
  const g0 = C.uniforms.tCityG.value.image.data.slice(), r0 = C.uniforms.tCityL.value.image.data.slice();
  scr.nits = 50; scr.rgb = [1, 0, 0];
  C.update(1, { x: 0, y: 3, z: 3 });
  const g1 = C.uniforms.tCityG.value.image.data, r1 = C.uniforms.tCityL.value.image.data, lc = C.uniforms.tCityLC.value.image.data;
  ok(g0.every((v, i) => v === g1[i]) && r0.every((v, i) => v === r1[i]), 'static grid and records untouched by update()');
  ok(lc[1] === 0 && lc[0] > 0, 'screen colour row follows the content');
  ok(C.stats.update.dyn === 64, 'dynamic slots filled (64 of 200 lamps)');
  const gd = C.uniforms.tCityGD.value.image.data; let maxId = 0, used = 0; for (const v of gd) if (v !== 0xffff) { used++; maxId = Math.max(maxId, v); }
  ok(used > 0 && maxId < 64, `window grid ids in range (${used} slots, max ${maxId})`);
  // the selected lamps are the nearest: the record positions all lie within 40 m of the camera
  const ld = C.uniforms.tCityLD.value.image.data, f = new Float32Array(ld.buffer); let far = 0;
  for (let a = 0; a < 64; a++) { const x = f[a * 8], z = f[a * 8 + 2]; if (Math.hypot(x, z - 3) > 40) far++; }
  ok(far === 0, 'nearest lamps selected');
  // allocation-free-ish and fast
  const t0 = performance.now(); for (let i = 0; i < 200; i++) { for (const v of vehicles) v.pos[0] += 0.05; C.update(1 + i / 60, { x: 0, y: 3, z: 3 }); }
  const per = (performance.now() - t0) / 200; console.log(`update with 200 lamps + 1 screen: ${per.toFixed(2)} ms`);
  ok(per < 10, 'update budget (loose: the CI box is shared)');
  // 5 a record decodes back
  const u = C.uniforms.tCityL.value.image.data, ff = new Float32Array(u.buffer.slice(0));
  const half = THREE.DataUtils.fromHalfFloat, id = 0;   // the store (static records: fixed first, animated last)
  const k = id * 8;
  ok(approx(ff[k], 10, 1e-6) && approx(ff[k + 1], 1.5, 1e-6) && approx(ff[k + 2], -5, 1e-6), 'record position');
  ok(approx(half(u[k + 3] & 0xffff), 9, 0.01), 'record area');
  ok(approx(half(u[k + 6] >>> 16), Math.min(SOURCE_TYPES.store.range, Math.sqrt(80 * 0.1 * 9 / 0.01)), 0.01), 'record range');
  ok((u[k + 7] & 3) === 0 && (u[k + 7] >>> 26) === 0, 'record lobe + omni');
  const ks = 8; ok(((u[ks + 7] >>> 2) & 16383) === 1, 'animated record points at colour row 0');
  C.dispose();
}
// 6 volume: finite, non-negative ambient; interior probes filled
{
  const layout = { lots: [{ id: 'B', footprint: [[0, -10], [10, -10], [10, 10], [0, 10]], floors: 3, floorH: 3 }], streets: [{ id: 's', points: [[-30, 0], [30, 0]], width: 8, kind: 'walking' }] };
  const em = []; for (let i = -3; i <= 3; i++) em.push({ id: 'f' + i, pos: [-0.3, 3.5, i * 3], normal: [-1, 0, 0], w: 2.5, h: 0.8, nits: 600, kind: 'lightbox' });
  const C = attach(world(), em, { layout, steam: false, airlight: false, cull: false, K: 4 });
  const A = C.uniforms.tCityIrrA.value.image.data, B = C.uniforms.tCityIrrB.value.image.data, half = THREE.DataUtils.fromHalfFloat;
  let bad = 0, neg = 0; for (let i = 0; i < A.length; i++) { const v = half(A[i]), w = half(B[i]); if (!Number.isFinite(v) || !Number.isFinite(w)) bad++; if ((i & 3) < 3 && v < 0) neg++; }
  ok(!bad && !neg, `volume finite (${bad}) and non-negative (${neg})`);
  const inside = C.probe(5, 0.5, 0), street = C.probe(-6, 0.5, 0, 1, 0, 0);
  ok(inside.volume > 0, 'interior probe filled from its neighbours');
  ok(street.volume > 0.05, `bounce reaches a wall facing away from the signs: ${street.volume.toFixed(2)} lux`);
  ok(C.stats.volume.streetProbes > 0, 'volume stats');
  C.dispose();
}
// 7 splitCells
{
  const g = new THREE.PlaneGeometry(400, 400, 40, 40).rotateX(-Math.PI / 2).toNonIndexed();
  const sp = splitCells(g, 96, 100);
  const tris = sp.parts.reduce((s, p) => s + p.tris, 0);
  ok(tris === g.getAttribute('position').count / 3, 'every triangle kept');
  ok(sp.vertices < sp.srcVertices * 0.75, `vertices deduped ${sp.srcVertices} -> ${sp.vertices}`);
  ok(sp.parts.length >= 16 && sp.parts.every((p) => p.geometry.boundingSphere.radius < 120), `cells (${sp.parts.length}) with tight bounds`);
  const hf = heightField({ lots: [{ footprint: [[0, 0], [4, 0], [4, 4], [0, 4]], floors: 1, floorH: 3 }] }, -10, -10, 10, 10, 2);
  ok(hf.at(2, 2) > 3 && hf.at(-5, -5) === 0, 'heightfield raster');
}
// 8 the real block (signs + C's emitters), when the partner modules are present
{
  const R = new URL('..', import.meta.url).pathname;
  if (fs.existsSync(R + 'seoul/layout.json') && fs.existsSync(R + 'world-seoul.js')) {
    const { buildSeoulGeometry } = await import('../world-seoul.js');
    const layout = JSON.parse(fs.readFileSync(R + 'seoul/layout.json', 'utf8'));
    const geo = buildSeoulGeometry(layout, {});
    let em = geo.emitters.slice();
    try { const S = await import('../seoul-signs.js'); const s = await S.seoulSigns.build(layout, { layout, nitScale: 0.1, lotInfo: geo.lotInfo, seed: 11, loadFonts: false, streetById: new Map(layout.streets.map((x) => [x.id, x])), lotById: new Map(layout.lots.map((l) => [l.id, l])) }); em = em.concat(s.emitters); } catch (e) { console.log('signs skipped:', e.message); }
    const scene = new THREE.Scene(); for (const [k, g] of Object.entries(geo.merged)) scene.add(Object.assign(new THREE.Mesh(g, new THREE.MeshStandardMaterial()), { name: 'seoul:' + k }));
    const w = { scene };
    const C = attach(w, em, { layout, steam: false, nitScale: 0.1 });
    const st = C.stats;
    console.log(`block: ${st.emitters} emitters, attach ${st.attachMs} ms (bin ${st.binMs}, volume ${st.volMs}, cull ${st.cull.ms}), K ${st.K}, ${st.pairs} pairs (${st.occludedPairs} occluded), cells ${st.cells} (full ${st.full}), volume ${JSON.stringify(st.volume)}, world ${st.cull.vertsBefore} -> ${st.cull.vertsAfter} verts in ${st.cull.meshes} meshes`);
    ok(st.volume.upLux > 0.3 && st.volume.upLux < 60, 'street volume in a sane range');
    ok(st.cull.meshes > st.cull.from && st.cull.vertsAfter < st.cull.vertsBefore, 'city split and deduped');
    ok(typeof w.dispose === 'function', 'world.dispose chained');
    const t0 = performance.now(); for (let i = 0; i < 60; i++) C.update(i / 60, { x: -36, y: 3, z: -23 - i * 0.1 });
    console.log(`block update ${((performance.now() - t0) / 60).toFixed(2)} ms`);
    w.dispose();
  }
}
console.log(`seoul-light tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
