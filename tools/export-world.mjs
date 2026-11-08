// tools/export-world.mjs — export the procedural site for the native (Swift + Metal) port and offline tools.
//
//   node tools/export-world.mjs                 writes world.glb, collider.glb, world.json, graffiti.png to the repo root
//   node tools/export-world.mjs --out DIR       ...to DIR instead
//   node tools/export-world.mjs --check         write nothing; exit 1 if the files in --out differ from a fresh export
//   node tools/export-world.mjs --level ID [--levels FILE]   [S0] another level of levels.json (or FILE) (default bando = everything below,
//                                               unchanged); writes to export/<ID>/ unless --out. See exportLevel().
//
// Source of truth: buildGeometry() in world-bando.js (pure CPU, no renderer), so this runs headless in node / CI.
//   world.glb     one node per render mesh: the merged site meshes per material (sorted by key), then terrain, far
//                 and path. Every vertex attribute is kept (position, normal, uv, aY -> _AY, uv1/uv2 if A1's lightmap
//                 UVs are there, color...). Materials carry MATS albedo / roughness, texture ids and URLs in extras.
//   collider.glb  the exact collision mesh (one primitive, three-mesh-bvh triangle order) with vertex ranges per source
//                 (solid / terrain / far / proxies) in extras; the skim / proximity set = triangles in the solid range.
//   world.json    lines, spawn, takeStart, startPoints, funnels, bounds, envelope, SKIES, MATS, paths, footprints,
//                 instance transforms (treeline crowns, trees), mesh table, hashes, file sizes + sha256.
//   groundmask.png / groundmask2.png   [P5] buildGroundMask's two RGBA masks (grass density / apron / AO / height;
//                 track distance / dry / flowers / lush), rows = z, first row at MASK.z0.
//   veg.*         [P5] the vegetation assets (veg.json manifest, veg.bin cards + wood, atlases, bark) copied as is;
//                 instances.veg = geo.vegInstances() (T5, contract C11) when world-bando.js has it.
// Still generated at load (world.json runtimeOnly, each with what a port needs to rebuild it): grass (shader-procedural
// from the masks + grass params), graffiti decal placement (raycasts), the per-vertex light fallback.
// world.json `coverage` maps every class of scene mesh buildBando draws to its export entry; tests/browser.mjs fails
// when the live scene has a mesh no rule covers. The exact formats are in PORTING.md.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    const ks = Object.keys(v).filter((k) => v[k] !== undefined);   // like JSON.stringify: undefined keys are dropped if (!ks.length) return '{}';
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

/** Merged-material keys buildBando builds but never draws (`if (mat === 'bark') continue;`: the legacy trunks). */
export function undrawnMerged(src) {
  const body = functionBody(src, 'buildBando') || '';
  return [...body.matchAll(/if\s*\(\s*mat\s*===\s*'(\w+)'\s*\)\s*continue/g)].map((m) => m[1]);
}

/** The render set in canonical order: merged site meshes sorted by material key, then terrain, far, path. */
export function renderSet(geo, MATS = {}, skip = []) {
  const out = [];
  for (const key of Object.keys(geo.merged).sort()) {
    if (skip.includes(key)) continue;   // [P5] not drawn by the game: a port drawing world.glb would show ghosts
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

/**
 * [P5] instances.veg from geo.vegInstances() (contract C11: [{type, matrix, tint, ao, ...}], seeded, pure). Rows are
 * [type index, ...every numeric field of the first entry in its key order]; short aliases (t, m, c, bo, th) are named.
 */
const VEG_ALIAS = { t: 'type', m: 'matrix', c: 'tint', bo: 'bounce', th: 'lod' };
export function vegTable(list, man, warn) {
  const rows = list.map((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [VEG_ALIAS[k] || k, v])));
  if (!rows.length) return { count: 0, types: [], layout: [], data: [] };
  const width = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? 1 : 0;
    if (v?.isVector3) return 3;
    if (v?.isMatrix4) return 16;
    if ((Array.isArray(v) || ArrayBuffer.isView(v)) && v.length && Array.from(v).every((x) => typeof x === 'number')) return v.length;
    return 0;
  };
  const flat = (v) => (typeof v === 'number' ? [v] : v.isVector3 ? [v.x, v.y, v.z] : v.isMatrix4 ? Array.from(v.elements) : Array.from(v));
  // string fields (role...) become enum columns: an index into enums[field]
  const enums = Object.fromEntries(Object.entries(rows[0]).filter(([k, v]) => k !== 'type' && typeof v === 'string').map(([k]) => [k, [...new Set(rows.map((r) => String(r[k])))].sort()]));
  const cols = Object.entries(rows[0]).filter(([k, v]) => k !== 'type' && (width(v) > 0 || k in enums)).map(([k, v]) => [k, k in enums ? 1 : width(v)]);
  const dropped = Object.keys(rows[0]).filter((k) => k !== 'type' && !cols.some(([c]) => c === k));
  const types = [...new Set(rows.map((r) => String(r.type)))].sort();
  const data = [];
  let bad = 0;
  for (const r of rows) {
    const row = [types.indexOf(String(r.type))];
    for (const [k, w] of cols) {
      const v = r[k];
      if (k in enums) row.push(enums[k].indexOf(String(v)));
      else if (v == null || width(v) !== w) { bad++; for (let i = 0; i < w; i++) row.push(null); } else row.push(...flat(v));
    }
    data.push(...row);
  }
  if (bad) warn(`vegInstances: ${bad} fields missing or of another width than the first entry's`);
  const byType = Object.fromEntries(types.map((t) => [t, rows.filter((r) => String(r.type) === t).length]));
  const prototypes = Object.fromEntries(types.map((t) => [t, man?.types?.[t] ? { H: man.types[t].H, crown: man.types[t].crown, lods: man.types[t].lods } : null]));
  return {
    count: rows.length, source: 'geo.vegInstances() in world-bando.js (contract C11, seeded)', byType, types,
    layout: ['type', ...cols.flatMap(([k, w]) => (w === 1 ? [k] : Array.from({ length: w }, (_, i) => `${k}${i}`)))],
    fields: Object.fromEntries(cols), ...(Object.keys(enums).length ? { enums } : {}), ...(dropped.length ? { notExported: dropped } : {}),
    matrix: 'column-major (three Matrix4.elements = simd float4x4 columns); model units of veg.json, metres in the world',
    prototypes, meshes: 'veg.json meshes[name] = attribute (offset, count, itemSize) and index ranges into veg.bin', data,
  };
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

// [P5] every class of mesh buildBando puts in world.scene -> its export entry (tests/coverage.js applies these to the
// live scene; a mesh no rule matches fails the browser job). Rules are tried in order; the first match wins.
export const COVERAGE = [
  { id: 'site', match: { mesh: 'world.glb' }, export: 'world.glb meshes[] (vertex count + bounds equal a world.json meshes[] row)' },
  { id: 'graffiti', match: { program: '^wp:decal' }, export: 'graffiti.png + runtimeOnly.graffiti (placement)' },
  { id: 'grass', match: { name: '^grass-' }, export: 'runtimeOnly.grass (groundmask*.png + world.json grass)' },
  { id: 'veg', match: { name: '^veg$', instanced: true }, export: 'instances.veg (veg.json / veg.bin prototypes)', requires: 'instances.veg.count' },
  { id: 'treeline', match: { parent: '^treeline$', instanced: true }, export: 'instances.treelineCrown (veg.json types A/B lods[3])' },
];
const readdirSafe = (d) => { try { return readdirSync(d); } catch (e) { return []; } };

export async function exportWorld({ root = ROOT, out = root, seed = 7, check = false, log = console.log } = {}) {
  const t0 = performance.now();
  const warnings = [], warn = (s) => { warnings.push(s); log('  warning: ' + s); };
  const mods = await exposeAndImport(root, { 'world-bando.js': ['MATS', 'terrainHeight', 'PATHS', 'texURL', 'PH', 'rng', 'crownGeometry', 'buildGroundMask', 'MASK', 'TEX_MEAN'] });
  const wb = mods['world-bando.js'], X = wb.__G_EXPOSED || {};
  const MATS = X.MATS || {};
  if (!X.MATS) warn('MATS not found: materials exported without albedo / texture data');
  if (seed !== 7 && !X.rng) warn('rng() not found: buildGeometry ran with its default R (seed 7 layout RNG)');
  const geo = wb.buildGeometry(X.rng ? X.rng(seed) : undefined, seed);
  const tGeo = performance.now();

  // ---------------------------------------------------------------- hashes (see tools/geohash.mjs)
  const src = readFileSync(join(root, 'world-bando.js'), 'utf8');
  const notDrawn = undrawnMerged(src).filter((k) => geo.merged[k]);
  const render = renderSet(geo, MATS, notDrawn);
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

  // ---------------------------------------------------------------- ground masks (P5, native #1)
  let masks = null; const maskPngs = {};
  if (typeof X.buildGroundMask === 'function' && X.MASK) {
    try {
      const m = X.buildGroundMask(geo.site, geo.terr), M = X.MASK;
      const list = [['groundmask.png', m.t, 'R grass density, G paved apron/road, B terrain AO (baked), A grass height / 2 m'],
        ['groundmask2.png', m.t2, 'R distance to the nearest track centreline / 8 m, G dry (straw) field, B wildflowers, A lush field']];
      masks = { N: M.N, x0: M.x0, z0: M.z0, size: M.size, texel: M.size / M.N, uv: 'u = (x - x0) / size, v = (z - z0) / size; PNG row j (top-down) = v, i.e. load it top-left origin (the game uploads row 0 first, flipY false)', filter: 'linear, clamp, no mips', colorSpace: 'linear (data)', files: {} };
      for (const [f, t, ch] of list) {
        if (!t?.image?.data) continue;
        maskPngs[f] = encodePNG(t.image.data, t.image.width, t.image.height);
        masks.files[f] = { size: [t.image.width, t.image.height], channels: ch };
      }
    } catch (e) { warn('ground masks: buildGroundMask threw offline: ' + e.message); }
  } else warn('buildGroundMask / MASK not found: ground masks not exported');

  // ---------------------------------------------------------------- vegetation (P5: assets + C11 instances)
  let man = null; const vegFiles = {};
  try {
    man = JSON.parse(readFileSync(join(root, 'veg.json'), 'utf8'));
    for (const f of ['veg.json', 'veg.bin', man.atlas?.file, man.atlas?.alpha, ...readdirSafe(root).filter((f) => /^veg_bark_\w+\.jpg$/.test(f))]) if (f && existsSync(join(root, f))) vegFiles[f] = join(root, f);
  } catch (e) { warn('veg.json unreadable: ' + e.message); }
  let vegInst;
  if (typeof geo.vegInstances === 'function') {
    try {
      const list = await geo.vegInstances(man);
      if (!Array.isArray(list)) throw new Error('did not return an array');
      vegInst = vegTable(list, man, warn);
    } catch (e) { warn('geo.vegInstances() failed offline: ' + e.message); vegInst = { count: 0, status: 'error', error: e.message }; }
  } else {
    vegInst = { count: 0, status: 'pending', note: 'geo.vegInstances() (T5, contract C11) is not in this world-bando.js: trees/shrubs are placed inside buildBando (runtime). tools/test-export.mjs requires it once world-bando.js defines it.' };
  }

  // ---------------------------------------------------------------- world.json
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
      count: geo.treeline?.length ?? 0,
      prototype: 'veg.json types[A|B].lods[3].cards (camera-facing cards): type A when (tint * 7) mod 1 < 0.45, else B (buildBando, treeline block)',
      transform: 'M = T(x,y,z) * Ry(rotY) * S(sxz, sy, sxz) with sy = h / H, sxz = sy * clamp((w / h) / (2 max(crown.r.x, crown.r.z) / H), 0.85, 1.6); colour = greens[floor(tint * 4)] * (0.88 + 0.24 tint)',
      layout: ['x', 'y', 'z', 'rotY', 'w', 'h', 'd', 'tint'], outer: (geo.treeline || []).filter((t) => t.outer).length,
      data: (geo.treeline || []).flatMap((t) => [t.x, t.y, t.z, t.rot, t.w, t.h, t.d, t.tint]),
    },
    tree: {
      count: geo.treeSpots?.length ?? 0, prototype: 'tree spots (buildGeometry); the drawn trees are instances.veg',
      layout: ['x', 'y', 'z', 'h', 'r'], data: (geo.treeSpots || []).flatMap((t) => [t.x, t.y, t.z, t.h, t.r]),
    },
    veg: vegInst,
  };
  // grass: shader-procedural; what a port needs besides the masks (the per-quality tiers are a literal in buildBando)
  let grass = null;
  try {
    const body = functionBody(src, 'buildBando') || '', lit = sourceLiteral(body, 'const GQS', '{');
    grass = { tiers: lit ? evalLiteral(lit) : null, cell: Number(/gCell\s*=\s*([\d.]+)/.exec(body)?.[1]) || null, masks: masks ? Object.keys(masks.files) : [], shader: 'GRASS_VS_CORE / GRASS_SHADE in world-bando.js (integer cell hash -> tuft; every random number from the base cell)' };
  } catch (e) { warn('grass params did not evaluate offline: ' + e.message); }
  const texMean = X.TEX_MEAN || wb.TEX_MEAN || null;
  if (!texMean) warn('TEX_MEAN not found in world-bando.js');
  else for (const [k, m] of Object.entries(MATS)) if (m.id && (m.maps || []).includes('diff') && !texMean[m.id]) warn(`TEX_MEAN has no entry for ${m.id} (MATS.${k}); run python3 tools/texmean.py <dir of *_diff_1k.jpg>`);
  const siteOut = {}; for (const [k, v] of Object.entries(site)) if (!['parts', 'colliders', 'lines', 'takeStart'].includes(k)) { const p = plain(v); if (p !== undefined) siteOut[k] = p; }
  let lightmap = null;
  const lmPath = join(root, 'lm.json');
  if (existsSync(lmPath)) { try { lightmap = { file: 'lm.json', ...JSON.parse(readFileSync(lmPath, 'utf8')) }; } catch (e) { warn('lm.json unreadable: ' + e.message); } }
  const hasUV2 = render.some((r) => r.geo.attributes.uv1 || r.geo.attributes.uv2);

  const outFiles = { 'world.glb': worldGlb, 'collider.glb': colGlb, ...(graffitiPng ? { 'graffiti.png': graffitiPng } : {}), ...maskPngs };
  const vegBytes = Object.fromEntries(Object.entries(vegFiles).map(([f, p]) => [f, readFileSync(p)]));
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
    files: Object.fromEntries(Object.entries({ ...outFiles, ...vegBytes }).map(([f, b]) => [f, { bytes: b.byteLength, sha256: sha256(b) }])),
    textures: graffitiPng ? { graffiti: { file: 'graffiti.png', size: [GA.width, GA.height], cells: [4, GA.height / 256], cellPx: [512, 256], rows: 'top-down (PNG); the game uploads it bottom-up (flipY)', alpha: 'straight', colorSpace: 'sRGB', drawnBy: 'world-bando.js graffitiCells via raster2d.js (rng 1402)' } } : {},
    meshes: meshTable,
    notDrawn: notDrawn.length ? { meshes: notDrawn, why: 'built by buildGeometry (collider / lightmap hash) but never drawn by buildBando; left out of world.glb' } : undefined,
    collider: colInfo,
    groundMasks: masks,
    spawn,
    takeStart: pick('takeStart'),
    startPoints: pick('startPoints'),
    funnels: pick('funnels'),
    bounds: plain(ret.bounds ?? null),
    envelope: plain(ret.envelope ?? null),
    lines: plain(geo.lines ?? site.lines ?? []),
    skies,
    materials: Object.fromEntries(Object.entries(MATS).map(([k, m]) => [k, { ...plain(m), textures: texOf(m), ...(texMean?.[m.id] ? { texMean: texMean[m.id] } : {}) }])),
    paths: plain(X.PATHS ?? null),
    site: siteOut,
    instances,
    lightmap,
    uv2: hasUV2 ? 'present (lightmap UVs: see meshes[].attributes)' : 'absent (A1 adds it at the end of buildGeometry)',
    grass,
    runtimeOnly: {
      grass: 'two instanced tiers of geometric blades built in the vertex shader from an integer cell hash + groundmask*.png (world.json grass: tiers, cell)',
      graffiti: 'placement: ~260 decal grids conformed to walls by raycasts (buildBando, rng 1401); the atlas is graffiti.png',
      ...(vegInst.status === 'pending' ? { veg: 'trees / shrubs / saplings placed in buildBando (instances.veg pending, contract C11)' } : {}),
      light: 'the per-vertex light bake (bakeLight) when lm.json does not match; otherwise the committed lightmaps',
    },
    coverage: COVERAGE,
    warnings,
  };
  const worldJson = stringify(world) + '\n';
  const outputs = { ...outFiles, 'world.json': new TextEncoder().encode(worldJson), ...vegBytes };

  if (check) {   // the export is deterministic: up to date <=> every file on disk is byte-identical to a fresh one
    const stale = Object.entries(outputs).filter(([f, b]) => !existsSync(join(out, f)) || sha256(readFileSync(join(out, f))) !== sha256(b)).map(([f]) => f);
    log(stale.length ? `world export STALE in ${out}: ${stale.join(', ')} (hash now ${hWorld}); run node tools/export-world.mjs` : `world export up to date (${hWorld})`);
    return { ok: !stale.length, stale, hash, warnings };
  }
  mkdirSync(out, { recursive: true });
  for (const [f, b] of Object.entries(outputs)) if (!(f in vegBytes) || resolve(out) !== resolve(root)) writeFileSync(join(out, f), b);   // veg.* already live in the root
  const verts = meshTable.reduce((s, m) => s + m.vertices, 0), tris = meshTable.reduce((s, m) => s + m.triangles, 0);
  log(`world.glb ${(worldGlb.byteLength / 1e6).toFixed(2)} MB (${meshTable.length} meshes, ${verts} verts, ${tris} tris)` +
    ` | collider.glb ${(colGlb.byteLength / 1e6).toFixed(2)} MB (${colInfo.triangles} tris) | world.json ${(worldJson.length / 1e3).toFixed(0)} kB` +
    ` | hash ${hWorld} | buildGeometry ${Math.round(tGeo - t0)} ms, total ${Math.round(performance.now() - t0)} ms -> ${out}`);
  return { ok: true, hash, world, out, warnings };
}

// ---------------------------------------------------------------- [S0] other levels (levels.json)
// A level other than bando exports from a CPU-only geometry entry its module names in the manifest (`geometry`, default
// `buildGeometry`). It returns, headless (no renderer, no textures):
//   { merged: {material: BufferGeometry}, colGeo, lines, spawn, takeStart?, startPoints?, funnels?, bounds?, envelope?,
//     materials?: {material: {albedo, rough, ...}}, colRanges?: [{key, tri0, tris}], emitters?, setPieces?, layout?,
//     site?: {...plain data}, extra?: {...plain data} }
// Written: world.glb (one mesh per merged material, sorted), collider.glb, world.json (same format id; level, hashes,
// lines, spawn...), plus the level's data files (LEVEL_DATA: Seoul = tools/export-seoul-data.mjs). Deterministic, so
// --check works the same way. [P2 H] Until a module exports its entry, LEVEL_SHIMS adapt what it has (noted, not a
// warning), and the level's runtime scene is built headless to apply world.json `coverage` in node.
export const LEVEL_DEFAULTS = { 'seoul-hongdae': { seed: 11 } };   // = the seed the game's build uses (buildSeoul opts.seed ?? 11)
export const LEVEL_DATA = { 'seoul-hongdae': './export-seoul-data.mjs' };
export const LEVEL_SHIMS = {
  // world-seoul.js before C's buildGeometry: the same calls buildSeoul makes, minus the renderer (native #1)
  'seoul-hongdae': async (mod, { seed }) => {
    if (typeof mod.buildSeoulGeometry !== 'function' || typeof mod.loadSeoulJSON !== 'function') return null;
    const layout = (await mod.loadSeoulJSON('./seoul/layout.json')) || (await mod.loadSeoulJSON('./seoul/layout.provisional.json'));
    if (!layout) throw new Error('seoul/layout.json missing');
    const lineData = await mod.loadSeoulJSON('./seoul/lines.json');
    const geo = mod.buildSeoulGeometry(layout, { lineData, seed });
    const B = mod.boxOf(layout), sp = geo.takeStart || layout.spawn || { pos: [0, 6, 0], yaw: 0 };
    return { ...geo, layout, seed, materials: mod.SEOUL_MATS, spawn: { pos: sp.pos, yaw: sp.yaw ?? 0 },
      bounds: { min: [B.x0 - 60, -5, B.z0 - 60], max: [B.x1 + 60, 200, B.z1 + 60] }, envelope: { min: [B.x0 - 30, -2, B.z0 - 30], max: [B.x1 + 30, 160, B.z1 + 30] } };
  },
};

/** The level's CPU geometry: its own entry when it has one, else its shim. -> { geo, entry } */
export async function levelGeometry(mod, L, seed) {
  const fn = [L.geometry, 'buildGeometry'].find((k) => k && typeof mod[k] === 'function');
  if (fn) return { geo: await mod[fn]({ seed, level: L.id, headless: true }), entry: fn };
  const shim = LEVEL_SHIMS[L.id] && (await LEVEL_SHIMS[L.id](mod, { seed }));
  if (shim) return { geo: shim, entry: `shim (${L.module} has no buildGeometry yet: tools/export-world.mjs LEVEL_SHIMS)` };
  throw new Error(`${L.module} has no CPU geometry entry (levels.json "geometry", or export buildGeometry)`);
}

const toV = (v) => (v == null ? null : v.isVector3 ? [v.x, v.y, v.z] : Array.isArray(v) ? v : v);
const toBox = (b) => (b == null ? null : b.isBox3 ? { min: toV(b.min), max: toV(b.max) } : { min: toV(b.min), max: toV(b.max) });

export async function exportLevel({ root = ROOT, id, out, seed, check = false, log = console.log, levelsFile = 'levels.json', dataOnly = false, coverageCheck = true } = {}) {
  const t0 = performance.now(), warnings = [], notes = [], warn = (s) => { warnings.push(s); log('  warning: ' + s); }, note = (s) => { notes.push(s); log('  note: ' + s); };
  const levels = JSON.parse(readFileSync(join(root, levelsFile), 'utf8')), L = levels.find((l) => l.id === id || (l.alias || []).includes(id));
  if (!L) throw new Error(`level ${id} not in levels.json (${levels.map((l) => l.id).join(', ')})`);
  out ??= join(root, 'export', L.id);
  seed ??= L.seed ?? LEVEL_DEFAULTS[L.id]?.seed ?? 7;
  const file = L.module.replace(/^\.\//, ''), path = join(root, file);
  if (!existsSync(path)) throw new Error(`${L.module} not in this tree yet`);
  const dataPath = LEVEL_DATA[L.id], dataMod = dataPath ? await import(dataPath) : null;
  const mods = dataMod?.seoulModules ? await dataMod.seoulModules(root, (s) => note(s.trim())) : null;   // exposes module-private constants: before any import of the level
  const mod = mods?.files[file] || (await import(pathToFileURL(path).href));
  const { geo, entry } = await levelGeometry(mod, L, seed);
  if (!geo?.merged || !geo.colGeo) throw new Error(`${entry}() must return { merged, colGeo, ... }`);
  if (/^shim/.test(entry)) note(`geometry from the ${entry}`);
  const src = readFileSync(path, 'utf8'), MATS = geo.materials || {};
  const render = Object.keys(geo.merged).sort().map((k) => ({ name: k, geo: geo.merged[k], mat: k, kind: 'site' }));
  const hRender = setHash('render', render.map((r) => [r.name, r.geo])), hCol = setHash('collider', [['collider', geo.colGeo]]);
  const hWorld = new GeoHash().str(hRender).str(hCol).hex();
  const hash = { algo: HASH_ALGO, world: hWorld, render: hRender, collider: hCol, meshes: Object.fromEntries(render.map((r) => [r.name, meshHash(r.name, r.geo)])) };
  const W = new GLBWriter('One Take FPV tools/export-world.mjs'), meshTable = [];
  for (const r of render) {
    const g = r.geo, attrs = {};
    for (const [k, a] of Object.entries(g.attributes)) attrs[k] = { array: attrArray(a), itemSize: a.itemSize, normalized: a.normalized };
    const m = MATS[r.mat] || {}, alb = m.albedo || [0.3, 0.29, 0.27];
    const material = W.material(r.mat, { name: r.mat, pbrMetallicRoughness: { baseColorFactor: [alb[0], alb[1], alb[2], 1], metallicFactor: m.metal || 0, roughnessFactor: m.rough ?? 1 }, extras: { mat: r.mat, ...plain(m) } });
    W.mesh(r.name, attrs, g.index ? g.index.array : null, { material, extras: { kind: r.kind, material: r.mat } });
    const sem = semanticsFor(Object.keys(g.attributes));
    meshTable.push({ name: r.name, kind: r.kind, material: r.mat, vertices: g.attributes.position.count, triangles: (g.index ? g.index.count : g.attributes.position.count) / 3,
      attributes: Object.fromEntries(Object.entries(g.attributes).map(([k, a]) => [k, { gltf: sem[k], itemSize: a.itemSize }])), bounds: boundsOf(attrArray(g.attributes.position)), hash: hash.meshes[r.name] });
  }
  // collider: per-material vertex ranges when the entry reports colRanges ([{key, tri0, tris}] over the non-indexed merge)
  const col = geo.colGeo, CW = new GLBWriter('One Take FPV tools/export-world.mjs'), colAttrs = {};
  for (const [k, a] of Object.entries(col.attributes)) colAttrs[k] = { array: attrArray(a), itemSize: a.itemSize };
  const ranges = Array.isArray(geo.colRanges) && geo.colRanges.length ? Object.fromEntries(geo.colRanges.map((r) => [r.key, [r.tri0 * 3, (r.tri0 + r.tris) * 3]])) : null;
  const triangleCounts = ranges && col.index ? triCounts(col.index.array, ranges) : null;
  CW.mesh('collider', colAttrs, col.index ? col.index.array : null, { extras: { kind: 'collider' }, ...(ranges ? { primExtras: { ranges, triangleCounts } } : {}) });
  const outFiles = { 'world.glb': W.toGLB(), 'collider.glb': CW.toGLB() };
  const spawn = geo.spawn == null ? null : geo.spawn.pos ? { pos: toV(geo.spawn.pos), yaw: plain(geo.spawn.yaw ?? geo.yaw ?? 0) } : { pos: plain(toV(geo.spawn)), yaw: plain(geo.yaw ?? 0) };
  if (!spawn) warn('spawn not found on the geometry entry');
  for (const k of ['bounds', 'envelope']) if (geo[k] == null) warn(`${k} not on the geometry entry (buildGeometry should return what buildSeoul's world has)`);
  // the level's runtime content as data (Seoul: emitters, signs, screens, light, life, dressing, look, textures)
  let D = null;
  if (dataMod?.exportSeoulData) {
    try { D = await dataMod.exportSeoulData({ root, geo, L, seed, mods, log, note, warn }); }
    catch (e) { warn(`level data export threw: ${e.stack || e.message}`); }
  }
  const matOut = Object.fromEntries(Object.entries(MATS).map(([k, m]) => {
    const tex = m?.id && m.maps ? Object.fromEntries(m.maps.map((map) => [map, { url: `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${m.id}/${m.id}_${map}_1k.jpg`, ktx2: D?.textures?.files?.[`${m.id}_${map}.ktx2`] ? `tex/${m.id}_${map}.ktx2` : null }])) : undefined;
    return [k, { ...plain(m), ...(tex ? { textures: tex } : {}) }];
  }));
  const L1 = geo.layout;
  const world = {
    format: WORLD_FORMAT, generator: 'tools/export-world.mjs --level', level: plain(L), source: { [file]: { sha256: sha256(src) }, seed, entry },
    conventions: { units: 'metres; right-handed, +Y up; the drone / camera look along -Z (three.js)' + (L1 ? '; x east, z south (layout L1)' : ''), ...(D ? { light: 'emitters and data in nits (cd/m2); NITS = 0.1 scene units per cd/m2 (light.json)', uv: 'site UVs are planar world metres: sample at uv / materials[mat].tile, repeat wrap (KTX2 rows pre-flipped: tex/textures.json orientation)' } : {}) },
    hash, files: null,
    meshes: meshTable,
    collider: { vertices: col.attributes.position.count, triangles: (col.index ? col.index.count : col.attributes.position.count) / 3, bounds: boundsOf(attrArray(col.attributes.position)), hash: hCol,
      ...(ranges ? { ranges, triangleCounts, skim: 'triangles whose first vertex lies in a range other than the ground layers (walk, road, plaza): world.skimBvh', note: 'double-sided; index in three-mesh-bvh order; ranges = vertex ranges per material key (a triangle belongs to the range holding its first vertex); flush decals (stripe, yellow, glass, shop) are render-only' } : {}) },
    spawn, takeStart: plain(geo.takeStart ?? null), startPoints: plain(geo.startPoints ?? null), funnels: plain(geo.funnels ?? null),
    bounds: plain(toBox(geo.bounds)), envelope: plain(toBox(geo.envelope)), lines: plain(geo.lines ?? []),
    materials: matOut, site: plain(geo.site ?? null), extra: plain(geo.extra ?? null),
    ...(L1 ? { layout: { file: 'layout.json', origin: plain(L1.origin ?? null), box: plain(L1.box ?? null), lots: L1.lots?.length ?? 0, streets: L1.streets?.length ?? 0, screens: L1.screens?.length ?? 0 } } : {}),
    ...(geo.facts ? { facts: plain(Object.fromEntries(Object.entries(geo.facts).filter(([k]) => !/^ms$|Ms$/.test(k)))) } : {}),   // no wall-clock fields: --check compares bytes
    ...(D ? { data: D.data, textures: D.textures, runtimeOnly: D.runtimeOnly, coverage: D.coverage, coverageObjects: D.coverageObjects } : {}),
    notes, warnings,
  };
  // node-side coverage: the headless runtime scene against world.json `coverage` (the browser job does it on the real page)
  if (D?.scene && coverageCheck) {
    try {
      const { coverage } = await import(pathToFileURL(join(root, 'tests', 'coverage.js')).href);
      const cov = coverage(D.scene, world);
      world.coverageNode = { meshes: cov.meshes, byRule: cov.byRule, pending: cov.pending };
      for (const u of cov.uncovered) warn(`coverage: ${u.type} "${u.name}" (parent "${u.parent}", ${u.vertices} verts${u.why ? ', ' + u.why : ''}) has no export entry`);
      for (const n of cov.undrawnExports) warn(`coverage: world.glb mesh "${n}" is not drawn by the game`);
    } catch (e) { warn('coverage in node: ' + e.message); }
  }
  const dataFiles = D?.files || {};
  const all = { ...outFiles, ...dataFiles };
  world.files = Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, b]) => [f, { bytes: b.byteLength, sha256: sha256(b) }]));
  const outputs = dataOnly ? { ...dataFiles } : { ...all, 'world.json': new TextEncoder().encode(stringify(world) + '\n') };
  if (check) {
    const stale = Object.entries(outputs).filter(([f, b]) => !existsSync(join(out, f)) || sha256(readFileSync(join(out, f))) !== sha256(b)).map(([f]) => f);
    log(stale.length ? `${L.id} export STALE in ${out}: ${stale.join(', ')} (hash now ${hWorld})` : `${L.id} export up to date (${hWorld}, ${Object.keys(outputs).length} files)`);
    return { ok: !stale.length, stale, hash, warnings, notes, world };
  }
  for (const [f, b] of Object.entries(outputs)) { mkdirSync(dirname(join(out, f)), { recursive: true }); writeFileSync(join(out, f), b); }
  const bytes = Object.values(outputs).reduce((s, b) => s + b.byteLength, 0);
  log(`${L.id}: world.glb ${(outFiles['world.glb'].byteLength / 1e6).toFixed(2)} MB (${meshTable.length} meshes) | collider ${world.collider.triangles} tris | ${Object.keys(dataFiles).length} data files | ${Object.keys(outputs).length} files, ${(bytes / 1e6).toFixed(1)} MB | hash ${hWorld} | ${warnings.length} warnings | ${Math.round(performance.now() - t0)} ms -> ${out}`);
  return { ok: true, hash, world, out, warnings, notes };
}

// ---------------------------------------------------------------- CLI
// --strict: any warning fails (exit 1). CI runs the Seoul export with it, so a mesh class with no export entry, a stale
// texture, or a data exporter that throws stops the build; a missing partner exporter (a shim was used) is only a note.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  if (a.includes('-h') || a.includes('--help')) { console.log('usage: node tools/export-world.mjs [--level ID] [--out DIR] [--seed N] [--check] [--strict] [--quiet]'); process.exit(0); }
  const quiet = a.includes('--quiet'), level = opt('--level'), strict = a.includes('--strict'), seed = opt('--seed') != null ? +opt('--seed') : undefined;
  (level && level !== 'bando' ? exportLevel({ id: level, levelsFile: opt('--levels') ?? 'levels.json', out: opt('--out') ? resolve(opt('--out')) : undefined, seed, check: a.includes('--check'), log: quiet ? () => {} : console.log }) : exportWorld({ out: resolve(opt('--out') ?? ROOT), seed: seed ?? 7, check: a.includes('--check'), log: quiet ? () => {} : console.log })
  ).then((r) => {
    if (strict && r.warnings?.length) { console.log(`FAIL --strict: ${r.warnings.length} warning(s):\n  ` + r.warnings.join('\n  ')); process.exit(1); }
    process.exit(r.ok ? 0 : 1);
  })
    .catch((e) => { console.error(e); process.exit(2); });
}
