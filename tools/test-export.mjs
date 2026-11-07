// tools/test-export.mjs — round-trip test for the native-readiness exports.
//   node tools/test-export.mjs        (exit 0 = pass; ~3 s)
// 1. runs the two CLIs exactly as the integrator / CI would (fresh processes, temp dir), twice: output must be
//    byte-identical (determinism);
// 2. parses world.glb / collider.glb with three's GLTFLoader (an independent reader) and checks every mesh against a
//    fresh buildGeometry(): names + order, vertex / triangle counts, attribute sets, bounds, and the geometry hash
//    recomputed from the loaded arrays (bit-exact data);
// 3. checks world.json (lines, takeStart, SKIES, instances, hashes, file sha256) and the GLB container layout;
// 4. writes a synthetic mesh with uv + uv2, an interleaved attribute and a uint32 index (what A1's lightmap UVs will
//    look like) and checks it round-trips with names restored;
// 5. checks camera.json's lens table against FPVCamera.computeLens().
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GeoHash, HASH_ALGO, meshHash, setHash } from './geohash.mjs';
import { GLBWriter, readGLB } from './glb.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log('  FAIL ' + msg); } return !!cond; };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)?.slice(0, 120)} != ${JSON.stringify(b)?.slice(0, 120)}`);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const run = (args) => { const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' }); if (r.status !== 0) console.log(r.stdout, r.stderr); return r; };

const TMP = mkdtempSync(join(tmpdir(), 'onetake-export-'));
const A = join(TMP, 'a'), B = join(TMP, 'b');
const t0 = performance.now();
try {
  // ------------------------------------------------------------ 1. CLIs, determinism
  ok(run(['tools/export-world.mjs', '--out', A, '--quiet']).status === 0, 'export-world exits 0');
  ok(run(['tools/export-world.mjs', '--out', B, '--quiet']).status === 0, 'export-world (second run) exits 0');
  ok(run(['tools/camera-profile.mjs', '--out', A, '--quiet']).status === 0, 'camera-profile exits 0');
  ok(run(['tools/camera-profile.mjs', '--out', B, '--quiet']).status === 0, 'camera-profile (second run) exits 0');
  for (const f of ['world.glb', 'collider.glb', 'world.json', 'camera.json']) ok(existsSync(join(A, f)) && sha(readFileSync(join(A, f))) === sha(readFileSync(join(B, f))), `${f} byte-identical across runs`);
  ok(run(['tools/export-world.mjs', '--out', A, '--check', '--quiet']).status === 0, 'export-world --check passes on a fresh export');
  const tCli = performance.now();

  // ------------------------------------------------------------ 2. GLB vs buildGeometry
  const { buildGeometry, SKIES } = await import(pathToFileURL(join(ROOT, 'world-bando.js')).href);
  const geo = buildGeometry();
  const expected = [...Object.keys(geo.merged).sort().map((k) => [k, geo.merged[k]]), ['terrain', geo.terr], ['far', geo.far], ['path', geo.pathG]];
  const world = JSON.parse(readFileSync(join(A, 'world.json'), 'utf8'));
  const loader = new GLTFLoader();
  const GLTF2THREE = { POSITION: 'position', NORMAL: 'normal', TANGENT: 'tangent', TEXCOORD_0: 'uv', TEXCOORD_1: 'uv1', TEXCOORD_2: 'uv2', TEXCOORD_3: 'uv3', COLOR_0: 'color' };
  const load = (buf) => new Promise((res, rej) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
  const meshesOf = async (file) => {
    const gltf = await load(readFileSync(join(A, file))), out = [];
    gltf.scene.traverse((o) => { if (o.isMesh) out.push(o); });
    for (const m of out) {   // restore three.js attribute names from primitive extras (GLTFLoader lowercases _AY -> _ay)
      const g = m.geometry, map = g.userData.attributes || {};
      for (const [sem, name] of Object.entries(map)) { const ln = GLTF2THREE[sem] || sem.toLowerCase(); if (ln !== name && g.attributes[ln]) { g.setAttribute(name, g.attributes[ln]); g.deleteAttribute(ln); } }
    }
    return out;
  };
  const meshes = await meshesOf('world.glb');
  eq(meshes.map((m) => m.name), expected.map((e) => e[0]), 'world.glb mesh names / order');
  const box = (g) => { g.computeBoundingBox(); return [g.boundingBox.min.toArray(), g.boundingBox.max.toArray()]; };
  let verts = 0, tris = 0;
  for (const [i, [name, eg]] of expected.entries()) {
    const m = meshes[i]; if (!ok(m, `mesh ${name} present`)) continue;
    const g = m.geometry, row = world.meshes[i];
    const ev = eg.attributes.position.count, et = (eg.index ? eg.index.count : ev) / 3;
    verts += ev; tris += et;
    eq(g.attributes.position.count, ev, `${name} vertex count`);
    eq((g.index ? g.index.count : g.attributes.position.count) / 3, et, `${name} triangle count`);
    eq(Object.keys(g.attributes).sort(), Object.keys(eg.attributes).sort(), `${name} attribute set`);
    for (const k of Object.keys(eg.attributes)) eq(g.attributes[k]?.itemSize, eg.attributes[k].itemSize, `${name}.${k} itemSize`);
    eq(box(g), box(eg.clone()), `${name} bounds`);
    eq(meshHash(name, g), meshHash(name, eg), `${name} geometry hash (bit-exact arrays)`);
    eq([row?.name, row?.vertices, row?.triangles, row?.hash], [name, ev, et, meshHash(name, eg)], `world.json meshes[${i}]`);
    eq([row?.bounds?.min, row?.bounds?.max], box(eg.clone()), `world.json ${name} bounds`);
  }
  const hRender = setHash('render', expected);
  eq(setHash('render', meshes.map((m) => [m.name, m.geometry])), hRender, 'render hash from loaded GLB == buildGeometry');
  eq(world.hash.render, hRender, 'world.json hash.render == buildGeometry');
  eq(world.hash.algo, HASH_ALGO, 'hash algo');

  const [colMesh] = await meshesOf('collider.glb');
  const cg = colMesh.geometry, col = geo.colGeo;
  const hCol = setHash('collider', [['collider', col]]);
  eq(cg.attributes.position.count, col.attributes.position.count, 'collider vertex count');
  eq(cg.index.count / 3, col.index.count / 3, 'collider triangle count');
  eq(box(cg), [col.boundingBox.min.toArray(), col.boundingBox.max.toArray()], 'collider bounds == colGeo.boundingBox');
  eq(setHash('collider', [['collider', cg]]), hCol, 'collider hash from loaded GLB == buildGeometry');
  eq(world.hash.collider, hCol, 'world.json hash.collider');
  eq(world.hash.world, new GeoHash().str(hRender).str(hCol).hex(), 'world.json hash.world');
  const R = world.collider.ranges;
  if (ok(R, 'collider ranges present')) {
    eq(R.solid, [0, geo.skimBvh.geometry.attributes.position.count], 'collider solid range == skim geometry');
    eq(Object.values(R).at(-1)[1], col.attributes.position.count, 'collider ranges cover every vertex');
    eq(Object.values(world.collider.triangleCounts).reduce((s, n) => s + n, 0), col.index.count / 3, 'collider range triangle counts sum');
    eq(world.collider.triangleCounts.solid, geo.skimBvh.geometry.index.count / 3, 'solid triangles == skim triangles');
    eq(cg.userData.ranges, R, 'collider.glb primitive extras carry the ranges');
  }

  // ------------------------------------------------------------ 3. world.json content + container layout
  eq(world.lines, JSON.parse(JSON.stringify(geo.lines)), 'lines');
  eq(world.takeStart, JSON.parse(JSON.stringify(geo.takeStart)), 'takeStart');
  ok(world.spawn && world.spawn.pos.length === 3 && world.spawn.pos.every(Number.isFinite) && Math.abs(world.spawn.pos[1] - 1.4) < 5, 'spawn finite, near the ground');
  eq(world.skies, Object.fromEntries(Object.entries(world.skies).map(([k, s]) => [k, { ...JSON.parse(JSON.stringify(SKIES[k])), ...(s.hdr ? { hdr: s.hdr } : {}) }])), 'SKIES');
  ok(world.bounds && world.envelope, 'bounds + envelope');
  for (const r of world.meshes) ok(world.materials[r.material]?.albedo?.length === 3, `material ${r.material} has an albedo`);
  eq(world.instances.treelineCrown.data.length, geo.treeline.length * world.instances.treelineCrown.layout.length, 'treeline instance table size');
  eq(world.instances.tree.count, geo.treeSpots.length, 'tree instance count');
  eq(world.warnings, [], 'no export warnings');
  for (const f of ['world.glb', 'collider.glb']) { const b = readFileSync(join(A, f)); eq([world.files[f].bytes, world.files[f].sha256], [b.byteLength, sha(b)], `world.json files.${f}`); }
  for (const f of ['world.glb', 'collider.glb']) {
    const { json } = readGLB(readFileSync(join(A, f)));
    ok(json.bufferViews.every((v) => v.byteOffset % 4 === 0), `${f}: bufferViews 4-byte aligned`);
    for (const m of json.meshes) for (const p of m.primitives) {
      const a = json.accessors[p.attributes.POSITION]; ok(a.min && a.max, `${f} ${m.name}: POSITION min/max`);
      const tc = Object.keys(p.attributes).filter((k) => k.startsWith('TEXCOORD_')).map((k) => +k.slice(9)).sort((x, y) => x - y);
      eq(tc, tc.map((_, i) => i), `${f} ${m.name}: TEXCOORD sets contiguous`);
      ok(Object.keys(p.attributes).every((k) => /^(POSITION|NORMAL|TANGENT|TEXCOORD_\d|COLOR_\d|_[A-Z0-9_]+)$/.test(k)), `${f} ${m.name}: attribute semantics valid`);
    }
  }

  // ------------------------------------------------------------ 4. synthetic: uv + uv2, interleaved, uint32 index
  {
    const n = 70000, g = new THREE.BufferGeometry(), r = (i, k) => Math.fround(Math.sin(i * 12.9898 + k * 78.233) * 437.5);
    const P = new Float32Array(n * 3).map((_, i) => r(i, 1)), U = new Float32Array(n * 2).map((_, i) => r(i, 2)), U2 = new Float32Array(n * 2).map((_, i) => r(i, 3));
    const ib = new THREE.InterleavedBuffer(new Float32Array(n * 4).map((_, i) => r(i, 4)), 4);
    g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    g.setAttribute('uv2', new THREE.BufferAttribute(U2, 2)); g.setAttribute('aY', new THREE.InterleavedBufferAttribute(ib, 2, 1));
    const idx = new Uint32Array(n * 3).map((_, i) => (i * 7919) % n); g.setIndex(new THREE.BufferAttribute(idx, 1));
    const W = new GLBWriter('test'); const attrs = {};
    for (const [k, a] of Object.entries(g.attributes)) attrs[k] = { array: a.isInterleavedBufferAttribute ? Float32Array.from({ length: a.count * 2 }, (_, i) => a.getComponent(i >> 1, i & 1)) : a.array, itemSize: a.itemSize };
    W.mesh('synthetic', attrs, idx, {});
    const glb = W.toGLB(), { json } = readGLB(glb);
    eq(json.meshes[0].primitives[0].extras.attributes, { POSITION: 'position', TEXCOORD_0: 'uv', TEXCOORD_1: 'uv2', _AY: 'aY' }, 'synthetic semantics (uv2 -> TEXCOORD_1, aY -> _AY)');
    eq(json.accessors[json.meshes[0].primitives[0].indices].componentType, 5125, 'synthetic uint32 index kept');
    const gl = await load(glb); let sm; gl.scene.traverse((o) => { if (o.isMesh) sm = o; });
    const sg = sm.geometry; sg.setAttribute('uv2', sg.attributes.uv1); sg.deleteAttribute('uv1'); sg.setAttribute('aY', sg.attributes._ay); sg.deleteAttribute('_ay');
    eq(meshHash('s', sg), meshHash('s', g), 'synthetic round-trip bit-exact (incl. interleaved source)');
  }

  // ------------------------------------------------------------ 5. camera.json
  {
    const cam = JSON.parse(readFileSync(join(A, 'camera.json'), 'utf8'));
    const { FPVCamera, LENSES } = await import(pathToFileURL(join(ROOT, 'fpvcam.js')).href);
    eq(cam.format, 'onetake.camera/1', 'camera.json format');
    for (const k of ['sunny', 'overcast', 'ldr']) { const l = cam.looks[k]?.look; ok(l && [l.shutter, l.readout, l.evMin, l.evMax, l.expo, ...l.wb].every(Number.isFinite) && l.lens?.key, `camera look ${k} complete`); }
    let worst = 0;
    for (const row of cam.lensSolve.table) {
      const c = new FPVCamera(null); c.setHDR(true); c.look.lens = LENSES[row.lens]; c.outW = row.outW; c.outH = row.outH; c.computeLens();
      for (const k of ['F', 'tx', 'ty', 'thc']) worst = Math.max(worst, Math.abs(c.lens[k] - row[k]));
    }
    ok(worst === 0, `camera.json lens table == computeLens (max diff ${worst})`);
    ok(cam.rig.tiltDeg && cam.rig.mountOffset?.length === 3, 'camera rig (tilt, mount)');
    eq(cam.warnings, [], 'no camera-profile warnings');
  }
  const total = performance.now() - t0;
  console.log(`export round-trip: ${checks - fails}/${checks} checks passed | ${expected.length} meshes, ${verts} verts, ${tris} tris, collider ${col.index.count / 3} tris | hash ${world.hash.world} | CLIs ${Math.round(tCli - t0)} ms, total ${Math.round(total)} ms`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(fails ? 1 : 0);
