// tools/export-world.mjs — export the procedural site for the native (Swift + Metal) port and offline tools.
//
//   node tools/export-world.mjs                 writes world.glb, collider.glb, world.json, graffiti.png to the repo root
//   node tools/export-world.mjs --out DIR       ...to DIR instead
//   node tools/export-world.mjs --check         write nothing; exit 1 if the files in --out differ from a fresh export
//
// Source of truth: buildGeometry() in world-bando.js (pure CPU, no renderer), so this runs headless in node / CI.
//   world.glb     one node per render mesh: the merged site meshes per material (sorted by key), then terrain, far
//                 and path. Every vertex attribute is kept (position, normal, uv, aY -> _AY, uv1/uv2 if A1's lightmap
//                 UVs are there, color...). Materials carry MATS albedo / roughness, texture ids and URLs in extras.
//   collider.glb  the exact collision mesh (one primitive, three-mesh-bvh triangle order) with vertex ranges per source
//                 (solid / terrain / far / proxies) in extras; the skim / proximity set = triangles in the solid range.
//   world.json    lines, spawn, takeStart, startPoints, funnels, bounds, envelope, SKIES, MATS, paths, footprints,
//                 instance transforms (treeline crowns, trees), mesh table, hashes, file sizes + sha256.
// Not exportable from buildGeometry (built inside buildBando with textures / probes): grass (shader-procedural),
// foliage cards, graffiti, the light bake. world.json lists them under runtimeOnly.
// The exact formats are in PORTING.md.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { exposeAndImport, sourceLiteral, evalLiteral, literalFields, functionBody } from './expose.mjs';
import { GLBWriter, semanticsFor } from './glb.mjs';
import { encodePNG } from './png.mjs';
import { GeoHash, HASH_ALGO, attrArray, meshHash, setHash } from './geohash.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORLD_FORMAT = 'onetake.world/1';
const RESERVED = ['terrain', 'far', 'path'];

/** JSON-safe copy: Vector/Box/Color -> arrays, three objects / functions dropped, non-finite numbers -> null. */
export function plain(v, depth = 0) {
  if (v == null || typeof v === 'string' || typeof v === 'boolean') return v ?? null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'function' || depth > 12) return undefined;
  if (v.isVector2) return [v.x, v.y];
  if (v.isVector3) return [v.x, v.y, v.z];
  if (v.isVector4 || v.isQuaternion) return [v.x, v.y, v.z, v.w];
  if (v.isColor) return [v.r, v.g, v.b];
  if (v.isBox3) return { min: plain(v.min), max: plain(v.max) };
  if (v.isBufferGeometry || v.isObject3D || v.isMaterial || v.isTexture || v.isMeshBVH) return undefined;
  if (ArrayBuffer.isView(v)) return v.length <= 65536 ? Array.from(v) : undefined;
  if (Array.isArray(v)) return v.map((x) => { const p = plain(x, depth + 1); return p === undefined ? null : p; });
  const o = {};
  for (const [k, x] of Object.entries(v)) { const p = plain(x, depth + 1); if (p !== undefined) o[k] = p; }
  return o;
}

/** Pretty JSON with arrays of numbers kept on one line (instance tables stay compact). */
export function stringify(v, ind = '') {
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) return JSON.stringify(v);
    const n = ind + '  '; return '[\n' + v.map((x) => n + stringify(x, n)).join(',\n') + '\n' + ind + ']';
  }
  if (v && typeof v === 'object') {
    const ks = Object.keys(v); if (!ks.length) return '{}';
    const n = ind + '  '; return '{\n' + ks.map((k) => n + JSON.stringify(k) + ': ' + stringify(v[k], n)).join(',\n') + '\n' + ind + '}';
  }
  return JSON.stringify(v);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const boundsOf = (pos) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) { const c = i % 3, v = pos[i]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
  return { min: mn, max: mx };
};

/** The render set in canonical order: merged site meshes sorted by material key, then terrain, far, path. */
export function renderSet(geo, MATS = {}) {
  const out = [];
  for (const key of Object.keys(geo.merged).sort()) {
    if (RESERVED.includes(key)) throw new Error(`export-world: site material "${key}" collides with a reserved mesh name`);
    out.push({ name: key, geo: geo.merged[key], mat: MATS[key] ? key : 'wall', kind: 'site' });   // buildBando: mats[mat] || mats.wall
  }
  out.push({ name: 'terrain', geo: geo.terr, mat: 'ground', kind: 'terrain' });
  out.push({ name: 'far', geo: geo.far, mat: 'ground', kind: 'far' });
  if (geo.pathG) out.push({ name: 'path', geo: geo.pathG, mat: 'path', kind: 'path' });
  return out;
}

/**
 * Collider vertex ranges per source. buildGeometry merges [solids, yard terrain, far terrain (subset index, full
 * positions), ...site.colliders]; each range is verified against its source positions, else null (+ warning).
 */
export function colliderRanges(geo, warn = () => {}) {
  const col = geo.colGeo, P = col.attributes.position.array, N = col.attributes.position.count;
  const solid = (geo.solidGeo || geo.skimBvh?.geometry)?.attributes.position,   // [V1] skimBvh = solids + tree tubes now
    terr = geo.terr.attributes.position, far = geo.far.attributes.position;
  if (!solid) { warn('collider ranges: no skimBvh geometry'); return null; }
  const same = (src, v0) => { const a = attrArray(src); if ((v0 + src.count) * 3 > P.length) return false; for (let i = 0; i < a.length; i++) if (P[v0 * 3 + i] !== a[i]) return false; return true; };
  const r = {}; let v = 0;
  for (const [k, src] of [['solid', solid], ['terrain', terr], ['far', far]]) {
    if (!same(src, v)) { warn(`collider ranges: "${k}" block doesn't match its source; composition changed? ranges omitted`); return null; }
    r[k] = [v, v + src.count]; v += src.count;
  }
  const tv = geo.treeColVerts || 0;
  r.proxies = [v, N - tv];   // site.colliders: treeline crown proxies (collision only, never drawn)
  if (tv) r.trees = [N - tv, N];   // [V1] the trees' trunk/limb tubes (collide, never drawn; in the skim set)
  return r;
}

function triCounts(index, ranges) {
  const out = Object.fromEntries(Object.keys(ranges).map((k) => [k, 0])), keys = Object.keys(ranges);
  for (let t = 0; t < index.length; t += 3) { const v = index[t]; for (const k of keys) if (v >= ranges[k][0] && v < ranges[k][1]) { out[k]++; break; } }
  return out;
}

/**
 * The world object buildBando returns, field by field: its final `return {...}` literal is lifted from the source and
 * each requested field's expression is evaluated with buildGeometry's results in scope (site, terr, treeline...,
 * THREE, terrainHeight). A field whose expression needs anything else (textures, the renderer) comes back undefined
 * and is reported. This keeps spawn / bounds / envelope / startPoints / funnels in sync with whatever C writes there.
 */
function buildBandoReturn(src, scope, fields, warn) {
  const out = {};
  const body = functionBody(src, 'buildBando');
  if (!body) { warn('buildBando not found in world-bando.js'); return out; }
  const at = body.lastIndexOf('return {');
  const lit = at >= 0 ? sourceLiteral(body, '{', '{', at) : null;
  if (!lit) { warn('buildBando: final `return {...}` not found'); return out; }
  const exprs = literalFields(lit);
  for (const f of fields) {
    if (!(f in exprs)) continue;
    try { out[f] = evalLiteral(exprs[f], scope); } catch (e) { warn(`buildBando return field "${f}" did not evaluate offline (${e.message}); put it on site or buildGeometry's return`); }
  }
  return out;
}

export async function exportWorld({ root = ROOT, out = root, seed = 7, check = false, log = console.log } = {}) {
  const t0 = performance.now();
  const warnings = [], warn = (s) => { warnings.push(s); log('  warning: ' + s); };
  const mods = await exposeAndImport(root, { 'world-bando.js': ['MATS', 'terrainHeight', 'PATHS', 'texURL', 'PH', 'rng', 'crownGeometry'] });
  const wb = mods['world-bando.js'], X = wb.__G_EXPOSED || {};
  const MATS = X.MATS || {};
  if (!X.MATS) warn('MATS not found: materials exported without albedo / texture data');
  if (seed !== 7 && !X.rng) warn('rng() not found: buildGeometry ran with its default R (seed 7 layout RNG)');
  const geo = wb.buildGeometry(X.rng ? X.rng(seed) : undefined, seed);
  const tGeo = performance.now();

  // ---------------------------------------------------------------- hashes (see tools/geohash.mjs)
  const render = renderSet(geo, MATS);
  const colList = [['collider', geo.colGeo]];
  const hRender = setHash('render', render.map((r) => [r.name, r.geo])), hCol = setHash('collider', colList);
  const hWorld = new GeoHash().str(hRender).str(hCol).hex();
  const hash = { algo: HASH_ALGO, world: hWorld, render: hRender, collider: hCol, meshes: Object.fromEntries(render.map((r) => [r.name, meshHash(r.name, r.geo)])) };
  for (const fn of ['geometryHash', 'geoHash', 'hashGeometry']) if (typeof wb[fn] === 'function') { try { hash.worldBando = { fn, value: await wb[fn](geo) }; } catch (e) { warn(`${fn}() threw: ${e.message}`); } break; }

  // ---------------------------------------------------------------- graffiti.png (G4: drawn in pure JS, raster2d.js)
  let GA = null, graffitiPng = null;
  if (typeof wb.graffitiPixels === 'function') { GA = wb.graffitiPixels(); graffitiPng = encodePNG(GA.data, GA.width, GA.height); }
  else warn('graffitiPixels() not found: graffiti.png not exported');

  // ---------------------------------------------------------------- world.glb
  const texOf = (m) => {
    if (!m || !m.maps) return undefined;
    const url = X.texURL || ((mm, map) => mm.model ? `${X.PH}/Models/jpg/1k/${mm.model}/${mm.model}_${map}_1k.jpg` : `${X.PH}/Textures/jpg/1k/${mm.id}/${mm.id}_${map}_1k.jpg`);
    return Object.fromEntries(m.maps.map((map) => [map, url(m, map)]));
  };
  const matDef = (key) => {
    const m = MATS[key] || {}, alb = m.albedo || [0.3, 0.29, 0.27];
    const d = { name: key, pbrMetallicRoughness: { baseColorFactor: [alb[0], alb[1], alb[2], 1], metallicFactor: 0, roughnessFactor: m.rough ?? 1 }, extras: { mat: key, ...plain(m), textures: texOf(m) } };
    if (key === 'path') d.alphaMode = 'BLEND';          // soft-edged ribbons: COLOR_0.a is the edge fade
    return d;
  };
  const W = new GLBWriter('One Take FPV tools/export-world.mjs');
  const meshTable = [];
  for (const r of render) {
    const g = r.geo, attrs = {};
    for (const [k, a] of Object.entries(g.attributes)) attrs[k] = { array: attrArray(a), itemSize: a.itemSize, normalized: a.normalized };
    const material = W.material(r.mat, matDef(r.mat));
    W.mesh(r.name, attrs, g.index ? g.index.array : null, { material, extras: { kind: r.kind, material: r.mat } });
    const sem = semanticsFor(Object.keys(g.attributes));
    meshTable.push({
      name: r.name, kind: r.kind, material: r.mat, vertices: g.attributes.position.count, triangles: (g.index ? g.index.count : g.attributes.position.count) / 3,
      attributes: Object.fromEntries(Object.entries(g.attributes).map(([k, a]) => [k, { gltf: sem[k], itemSize: a.itemSize }])),
      bounds: boundsOf(attrArray(g.attributes.position)), hash: hash.meshes[r.name],
    });
  }
  const worldGlb = W.toGLB();

  // ---------------------------------------------------------------- collider.glb
  const col = geo.colGeo, ranges = colliderRanges(geo, warn);
  const CW = new GLBWriter('One Take FPV tools/export-world.mjs');
  const colAttrs = {}; for (const [k, a] of Object.entries(col.attributes)) colAttrs[k] = { array: attrArray(a), itemSize: a.itemSize };
  const colInfo = {
    vertices: col.attributes.position.count, triangles: col.index.count / 3, bounds: boundsOf(attrArray(col.attributes.position)), hash: hCol,
    ranges, triangleCounts: ranges ? triCounts(col.index.array, ranges) : null,
    skim: 'triangles whose first vertex lies in ranges.solid or ranges.trees (world.skimBvh: structures + tree trunks, no terrain / grass)',
    note: 'double-sided; index in three-mesh-bvh order (MeshBVH reorders it in place); proxies = site.colliders (treeline crown proxies, never drawn)',
  };
  CW.mesh('collider', colAttrs, col.index.array, { extras: { kind: 'collider' }, primExtras: { ranges, triangleCounts: colInfo.triangleCounts } });
  const colGlb = CW.toGLB();

  // ---------------------------------------------------------------- world.json
  const src = readFileSync(join(root, 'world-bando.js'), 'utf8');
  const site = geo.site || {};
  // buildBando destructures these from buildGeometry; the return literal may use any of them
  const scope = { THREE, Math, terrainHeight: X.terrainHeight, geo, seed, ...Object.fromEntries(Object.entries(geo).filter(([k]) => /^[A-Za-z_$][\w$]*$/.test(k))) };
  const ret = buildBandoReturn(src, scope, ['spawn', 'yaw', 'takeStart', 'startPoints', 'funnels', 'bounds', 'envelope'], warn);
  const pick = (k) => plain(geo[k] ?? site[k] ?? ret[k] ?? null);   // data on geo / site first, then buildBando's literal
  const spawnRaw = geo.spawn ?? site.spawn ?? ret.spawn;
  const spawn = spawnRaw == null ? null : spawnRaw.pos ? plain(spawnRaw) : { pos: plain(spawnRaw), yaw: plain(ret.yaw ?? 0) };
  if (!spawn) warn('spawn not found (buildGeometry, site or buildBando return)');
  for (const k of ['bounds', 'envelope']) if (ret[k] == null) warn(`${k} not found in buildBando's return`);
  const hdrTpl = /`\$\{PH\}(\/HDRIs\/[^`]*)`/.exec(src)?.[1];
  const skies = plain(wb.SKIES || {});
  if (hdrTpl && X.PH) for (const s of Object.values(skies)) if (s.id) s.hdr = X.PH + hdrTpl.replace(/\$\{id\}/g, s.id).replace(/\$\{def\.id\}/g, s.id);
  const instances = {
    treelineCrown: {
      count: geo.treeline?.length ?? 0, prototype: X.crownGeometry ? 'crownGeometry(5) in world-bando.js (instanced in buildBando)' : 'treeline crown (world-bando.js)',
      transform: 'M = T(x,y,z) * Ry(rotY) * S(sx,sy,sz); tint 0..1 picks one of 4 greens', layout: ['x', 'y', 'z', 'rotY', 'sx', 'sy', 'sz', 'tint'],
      data: (geo.treeline || []).flatMap((t) => [t.x, t.y, t.z, t.rot, t.w, t.h, t.d, t.tint]),
    },
    tree: {
      count: geo.treeSpots?.length ?? 0, prototype: 'trunk is in the bark mesh; crown = leaf-card balls built in buildBando (runtime)',
      layout: ['x', 'y', 'z', 'h', 'r'], data: (geo.treeSpots || []).flatMap((t) => [t.x, t.y, t.z, t.h, t.r]),
    },
  };
  const siteOut = {}; for (const [k, v] of Object.entries(site)) if (!['parts', 'colliders', 'lines', 'takeStart'].includes(k)) { const p = plain(v); if (p !== undefined) siteOut[k] = p; }
  let lightmap = null;
  const lmPath = join(root, 'lm.json');
  if (existsSync(lmPath)) { try { lightmap = { file: 'lm.json', ...JSON.parse(readFileSync(lmPath, 'utf8')) }; } catch (e) { warn('lm.json unreadable: ' + e.message); } }
  const hasUV2 = render.some((r) => r.geo.attributes.uv1 || r.geo.attributes.uv2);

  const world = {
    format: WORLD_FORMAT,
    generator: 'tools/export-world.mjs',
    source: { 'world-bando.js': { sha256: sha256(src) }, seed },
    conventions: {
      units: 'metres; right-handed, +Y up; the drone / camera look along -Z (three.js)',
      uv: 'three.js: images are uploaded with flipY = true (v = 0 at the image bottom). Site UVs are planar world metres: sample at uv / MATS[mat].tile with repeat wrap. A stock glTF viewer shows such textures flipped vertically.',
      winding: 'counter-clockwise front faces; materials are single-sided except the brick shadow side (buildBando)',
      attributes: '_AY (aY) = (bottom, top) world height of the element a vertex belongs to (weathering); COLOR_0 on path = (1,1,1,edge alpha)',
    },
    hash,
    files: { 'world.glb': { bytes: worldGlb.byteLength, sha256: sha256(worldGlb) }, 'collider.glb': { bytes: colGlb.byteLength, sha256: sha256(colGlb) },
      ...(graffitiPng ? { 'graffiti.png': { bytes: graffitiPng.byteLength, sha256: sha256(graffitiPng) } } : {}) },
    textures: graffitiPng ? { graffiti: { file: 'graffiti.png', size: [GA.width, GA.height], cells: [4, GA.height / 256], cellPx: [512, 256], rows: 'top-down (PNG); the game uploads it bottom-up (flipY)', alpha: 'straight', colorSpace: 'sRGB', drawnBy: 'world-bando.js graffitiCells via raster2d.js (rng 1402)' } } : {},
    meshes: meshTable,
    collider: colInfo,
    spawn,
    takeStart: pick('takeStart'),
    startPoints: pick('startPoints'),
    funnels: pick('funnels'),
    bounds: plain(ret.bounds ?? null),
    envelope: plain(ret.envelope ?? null),
    lines: plain(geo.lines ?? site.lines ?? []),
    skies,
    materials: Object.fromEntries(Object.entries(MATS).map(([k, m]) => [k, { ...plain(m), textures: texOf(m) }])),
    paths: plain(X.PATHS ?? null),
    site: siteOut,
    instances,
    lightmap,
    uv2: hasUV2 ? 'present (lightmap UVs: see meshes[].attributes)' : 'absent (A1 adds it at the end of buildGeometry)',
    runtimeOnly: [
      'grass: instanced cross cards placed in the vertex shader from an integer cell hash + the ground mask (buildBando, buildGroundMask)',
      'foliage: tree crowns, wall thickets, field shrubs, saplings (leaf-card balls; placement uses BVH probes in buildBando)',
      'graffiti placement: ~260 decal grids conformed to walls by raycasts (buildBando; the atlas itself is graffiti.png)',
      'ground mask texture, canvas atlases (grass / leaf), the per-vertex light bake (bakeLight)',
    ],
    warnings,
  };
  const worldJson = stringify(world) + '\n';
  const outputs = { 'world.glb': worldGlb, 'collider.glb': colGlb, 'world.json': new TextEncoder().encode(worldJson), ...(graffitiPng ? { 'graffiti.png': graffitiPng } : {}) };

  if (check) {   // the export is deterministic: up to date <=> every file on disk is byte-identical to a fresh one
    const stale = Object.entries(outputs).filter(([f, b]) => !existsSync(join(out, f)) || sha256(readFileSync(join(out, f))) !== sha256(b)).map(([f]) => f);
    log(stale.length ? `world export STALE in ${out}: ${stale.join(', ')} (hash now ${hWorld}); run node tools/export-world.mjs` : `world export up to date (${hWorld})`);
    return { ok: !stale.length, stale, hash, warnings };
  }
  mkdirSync(out, { recursive: true });
  for (const [f, b] of Object.entries(outputs)) writeFileSync(join(out, f), b);
  const verts = meshTable.reduce((s, m) => s + m.vertices, 0), tris = meshTable.reduce((s, m) => s + m.triangles, 0);
  log(`world.glb ${(worldGlb.byteLength / 1e6).toFixed(2)} MB (${meshTable.length} meshes, ${verts} verts, ${tris} tris)` +
    ` | collider.glb ${(colGlb.byteLength / 1e6).toFixed(2)} MB (${colInfo.triangles} tris) | world.json ${(worldJson.length / 1e3).toFixed(0)} kB` +
    ` | hash ${hWorld} | buildGeometry ${Math.round(tGeo - t0)} ms, total ${Math.round(performance.now() - t0)} ms -> ${out}`);
  return { ok: true, hash, world, out, warnings };
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  if (a.includes('-h') || a.includes('--help')) { console.log('usage: node tools/export-world.mjs [--out DIR] [--seed N] [--check] [--quiet]'); process.exit(0); }
  const quiet = a.includes('--quiet');
  exportWorld({ out: resolve(opt('--out') ?? ROOT), seed: +(opt('--seed') ?? 7), check: a.includes('--check'), log: quiet ? () => {} : console.log })
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => { console.error(e); process.exit(2); });
}
