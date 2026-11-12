// tools/export-seoul-data.mjs: Neon Seoul's runtime content as data, for the native (Swift + Metal) port (P2 stream H,
// native #2 and #4). export-world --level seoul-hongdae calls exportSeoulData() and lists its files in world.json `data`;
// this CLI is the same thing on its own, plus the one-time texture vendoring.
//
//   node tools/export-seoul-data.mjs [--out DIR] [--seed N]   emitters / signs / screens / light / life / dressing / look
//                                                              JSON (+ signs.glb) to DIR (default export/seoul-hongdae)
//   node tools/export-seoul-data.mjs --textures               check seoul/tex/textures.json against SEOUL_MATS + sha256
//   node tools/export-seoul-data.mjs --vendor-textures [--src DIR] [--only id,...]
//        encode the Poly Haven 1k JPGs SEOUL_MATS uses to KTX2 (Basis ETC1S, mipmapped) in seoul/tex/ and rewrite
//        seoul/tex/textures.json. Needs ktx2-encoder@0.6.0 + jpeg-js@0.4.4 (not CI dependencies: the output is
//        committed). They resolve from node_modules, or from KTX2_NODE_MODULES=/dir/node_modules.
//        --src: a directory of <id>_<map>_1k.jpg (default $ONETAKE_PH_DIR, else downloaded from dl.polyhaven.org).
//
// Each file comes from its owning stream's exporter when the module has one, else from a shim here that reads the
// same objects the browser builds (world-seoul's buildSeoul runs headless in node: signs, life and light included):
//   emitters.json  every L3 record the game lights the city with (world.emitters after buildSeoul), in nits.
//   signs.json     B: seoul-signs exportData() | shim: the generator's spec table (+ signs.glb, the static sign
//                  geometry; the face atlas is browser-only until B's MSDF glyph runs).
//   screens.json   B: exportData() | shim: per screen pitch, resolution, scanHz, nits, playlist, + SCREEN_FRAG source.
//   light.json     D: seoul-light exportData() | shim: NITS, SOURCE_TYPES, NIGHT_SKY, grid cell / K, range rules, GLSL.
//   life.json      G: seoul-life exportData() | shim: LIFE, VEH, the lane graph, signals, seeds, parity vectors.
//   dressing.json  E (through C's buildGeometry): setPieces + what stays runtime-only. Pending until E lands.
//   look.json      the night camera look main.js applies to this level (GRADES.night + levels.json grade).
// Formats: PORTING.md, "Neon Seoul". Every output is deterministic (no dates), so --check compares bytes.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SEOUL_DATA_FORMAT = 'onetake.seoul-data/1';
export const TEX_DIR = 'seoul/tex';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const PH = 'https://dl.polyhaven.org/file/ph-assets';

// ================================================================================================================
// textures (native #4): vendored KTX2, listed in seoul/tex/textures.json
// ================================================================================================================
/** The (id, map) pairs SEOUL_MATS samples, with the materials that use each. */
export function textureNeeds(MATS) {
  const need = new Map();
  for (const [k, m] of Object.entries(MATS || {})) {
    if (!m?.id || !Array.isArray(m.maps)) continue;
    for (const map of m.maps) { const f = `${m.id}_${map}.ktx2`; if (!need.has(f)) need.set(f, { id: m.id, map, mats: [] }); need.get(f).mats.push(k); }
  }
  return need;
}

/** Read seoul/tex/textures.json and check it: every SEOUL_MATS map present, every file's sha256 as listed. */
export function textureManifest(root, MATS) {
  const dir = join(root, TEX_DIR), mf = join(dir, 'textures.json');
  const need = textureNeeds(MATS), problems = [];
  if (!existsSync(mf)) return { manifest: null, files: {}, problems: [`${TEX_DIR}/textures.json missing: run node tools/export-seoul-data.mjs --vendor-textures`], need };
  const manifest = JSON.parse(readFileSync(mf, 'utf8')), files = {};
  for (const [f, e] of Object.entries(manifest.files || {})) {
    const p = join(dir, f);
    if (!existsSync(p)) { problems.push(`${TEX_DIR}/${f} listed but missing`); continue; }
    const b = readFileSync(p);
    if (sha256(b) !== e.sha256) problems.push(`${TEX_DIR}/${f}: sha256 differs from textures.json (re-run --vendor-textures)`);
    files[f] = b;
  }
  const missing = [];   // a map SEOUL_MATS gained since the last vendoring: the game still has its JPG URL, so a note
  for (const [f, n] of need) if (!manifest.files?.[f]) missing.push(`${f} (${n.mats.join(', ')}) not vendored yet: KTX2_NODE_MODULES=... node tools/export-seoul-data.mjs --vendor-textures`);
  return { manifest, files, problems, missing, need };
}

async function loadEncoder() {
  const dirs = [process.env.KTX2_NODE_MODULES && resolve(process.env.KTX2_NODE_MODULES), join(ROOT, 'node_modules'), join(ROOT, 'ci', 'node_modules')].filter(Boolean);
  for (const nm of dirs) {
    const pkg = join(nm, 'ktx2-encoder');
    if (!existsSync(join(pkg, 'dist', 'node', 'index.js')) || !existsSync(join(nm, 'jpeg-js'))) continue;
    const enc = await import(pathToFileURL(join(pkg, 'dist', 'node', 'index.js')).href);
    const jpeg = createRequire(join(nm, 'x.js'))('jpeg-js');
    const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
    return { encodeToKTX2: enc.encodeToKTX2, jpeg, version };
  }
  throw new Error('ktx2-encoder / jpeg-js not found: npm i --prefix /some/dir ktx2-encoder@0.6.0 jpeg-js@0.4.4 and set KTX2_NODE_MODULES=/some/dir/node_modules');
}

// KTX2 encoding per map kind, transcoded to ASTC 4x4 on the phone (browser: three KTX2Loader; native: the Basis
// transcoder or a CI ASTC pass). Measured on concrete_tile_facade (mean |error| vs the JPG, 8-bit codes):
//   diffuse  ETC1S q255           ~7.7 codes, ~0.2 MB per 1k map
//   normals  ETC1S normal preset  ~13 codes (blocky specular on wet asphalt), ~0.2 MB
//            UASTC + RDO 4 + zstd  ~3.7 codes, ~0.7 MB   <- used
// The whole set (18 maps) is ~8 MB, against 10.5 MB of JPGs the browser fetched at runtime before.
export const KTX2_PARAMS = {
  diff: { isUASTC: false, qualityLevel: 255, compressionLevel: 2, isPerceptual: true, isSetKTX2SRGBTransferFunc: true, generateMipmap: true, isYFlip: true },
  nor_gl: { isUASTC: true, needSupercompression: true, enableRDO: true, rdoQualityLevel: 4, isNormalMap: true, isPerceptual: false, isSetKTX2SRGBTransferFunc: false, generateMipmap: true, isYFlip: true },
};
const paramsFor = (map) => KTX2_PARAMS[map] || { ...KTX2_PARAMS.diff, isPerceptual: false, isSetKTX2SRGBTransferFunc: false };   // arm / rough / ao: linear data

export async function vendorTextures({ root = ROOT, src = process.env.ONETAKE_PH_DIR, only = null, log = console.log } = {}) {
  const { SEOUL_MATS } = await import(pathToFileURL(join(root, 'world-seoul.js')).href);
  const { encodeToKTX2, jpeg, version } = await loadEncoder();
  const dir = join(root, TEX_DIR); mkdirSync(dir, { recursive: true });
  const need = textureNeeds(SEOUL_MATS), mfPath = join(dir, 'textures.json');
  const old = existsSync(mfPath) ? JSON.parse(readFileSync(mfPath, 'utf8')) : { files: {} };
  const decode = async (b) => { const r = jpeg.decode(b, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 }); return { width: r.width, height: r.height, data: new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength) }; };
  const files = {};
  for (const [f, n] of [...need].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const jpg = `${n.id}_${n.map}_1k.jpg`;
    let b = src && existsSync(join(src, jpg)) ? readFileSync(join(src, jpg)) : null;
    if (!b) { const url = `${PH}/Textures/jpg/1k/${n.id}/${jpg}`; log(`  fetch ${url}`); const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); b = Buffer.from(await r.arrayBuffer()); }
    const srcSha = sha256(b), prev = old.files?.[f], P = paramsFor(n.map);
    const same = prev && prev.sourceSha256 === srcSha && prev.encoder === `ktx2-encoder ${version}` && JSON.stringify(prev.params) === JSON.stringify(P) && existsSync(join(dir, f));
    if ((only && !only.includes(n.id)) || same) { if (prev) files[f] = { ...prev, mats: n.mats }; log(`  keep ${f}`); continue; }
    const t0 = performance.now();
    const img = await decode(b);
    const out = await encodeToKTX2(b, { ...P, isKTX2File: true, imageDecoder: async () => img });
    writeFileSync(join(dir, f), out);
    files[f] = { id: n.id, map: n.map, mats: n.mats, source: `${PH}/Textures/jpg/1k/${n.id}/${jpg}`, sourceSha256: srcSha, sourceBytes: b.byteLength,
      size: [img.width, img.height], bytes: out.byteLength, sha256: sha256(out), colorSpace: P.isSetKTX2SRGBTransferFunc ? 'srgb' : 'linear',
      codec: P.isUASTC ? 'UASTC' : 'ETC1S', mips: true, encoder: `ktx2-encoder ${version}`, params: P };
    log(`  ${f}: ${(b.byteLength / 1024).toFixed(0)} KB jpg -> ${(out.byteLength / 1024).toFixed(0)} KB ktx2 (${Math.round(performance.now() - t0)} ms)`);
  }
  const manifest = {
    format: 'onetake.textures/1', generator: 'tools/export-seoul-data.mjs --vendor-textures',
    license: 'CC0 1.0: Poly Haven (polyhaven.com), see seoul/tex/LICENSE.txt',
    orientation: 'rows are stored Y-flipped relative to the source JPG (isYFlip), so sampling the KTX2 at uv with no flip (three: KTX2Loader, flipY false; Metal: top-left origin) gives exactly what three TextureLoader (flipY true) gives for the JPG. Do not flip again.',
    sampling: 'repeat wrap, trilinear, anisotropy <= 8; site UVs are world metres: uv / SEOUL_MATS[mat].tile',
    transcode: 'Basis ETC1S (diffuse, sRGB) and UASTC + zstd (normal maps, linear, OpenGL +Y green, basisu normal-map preset) -> ASTC 4x4 on iOS, BC7 / ETC2 elsewhere.',
    files,
    bytes: Object.values(files).reduce((s, e) => s + e.bytes, 0),
  };
  writeFileSync(mfPath, JSON.stringify(manifest, null, 1) + '\n');
  if (!existsSync(join(dir, 'LICENSE.txt'))) writeFileSync(join(dir, 'LICENSE.txt'), 'The textures in this folder are re-encoded (KTX2, Basis Universal) from Poly Haven texture scans,\nreleased under CC0 1.0 Universal (public domain): https://polyhaven.com/license\nSources and checksums: textures.json.\n');
  log(`wrote ${TEX_DIR}/textures.json: ${Object.keys(files).length} maps, ${(manifest.bytes / 1e6).toFixed(2)} MB`);
  return manifest;
}


// ================================================================================================================
// modules: world-seoul + partners, with their module-private constants exposed (tools/expose.mjs, node only)
// ================================================================================================================
const EXPOSE = {
  'world-seoul.js': ['USE_LOOK', 'K'],
  'seoul-signs.js': ['SCREEN_VERT', 'SCREEN_FRAG', 'SCROLL_VERT', 'SCROLL_FRAG', 'SCREEN_PALETTES', 'PROG_TEXT', 'COVER', 'HEX', 'LIT_P', 'USE_PUSH'],
  'seoul-light.js': ['QUALITY', 'LPR', 'LW', 'E_MIN', 'CITY_HEAD', 'WET_HEAD'],
  'seoul-life.js': ['PAINT', 'VTYPES'],
  'fpvcam.js': ['GRADES'],
};
export const PARTNERS = { signs: 'seoul-signs.js', light: 'seoul-light.js', life: 'seoul-life.js', dressing: 'seoul-dressing.js' };
let MODS = null;
/** Import world-seoul.js and its partners once per process, with EXPOSE's names readable as mod.__G_EXPOSED. */
export async function seoulModules(root = ROOT, log = () => {}) {
  if (MODS) return MODS;
  const spec = Object.fromEntries(Object.entries(EXPOSE).filter(([f]) => existsSync(join(root, f))));
  const files = {};
  try { Object.assign(files, await (await import('./expose.mjs')).exposeAndImport(root, spec)); }
  catch (e) {   // one partner failed to load: the hook is registered, so load the rest one by one
    log(`  note: module load: ${e.message}`);
    for (const f of Object.keys(spec)) { try { files[f] = await import(pathToFileURL(join(root, f)).href); } catch (e2) { log(`  note: ${f} did not load in node: ${e2.message}`); } }
  }
  for (const f of [PARTNERS.dressing]) if (existsSync(join(root, f))) { try { files[f] = await import(pathToFileURL(join(root, f)).href); } catch (e) { log(`  note: ${f} did not load in node: ${e.message}`); } }
  MODS = { files, X: Object.fromEntries(Object.entries(files).map(([f, m]) => [f, m.__G_EXPOSED || {}])) };
  return MODS;
}
/** A stream's exporter: export function exportData(layout, ctx) on the module or on its named/default object. */
function exporterOf(mod) {
  if (!mod) return null;
  for (const o of [mod, mod.default, ...Object.values(mod).filter((v) => v && typeof v === 'object')]) if (typeof o?.exportData === 'function') return o.exportData.bind(o);
  return null;
}

// ================================================================================================================
// JSON writers: deterministic, compact where it matters
// ================================================================================================================
let _ew = null;
async function EW() { return (_ew ||= await import('./export-world.mjs')); }
/** JSON text: meta pretty (export-world stringify), each array in `tables` one record per line. */
async function jsonText(obj, tables = []) {
  const { plain, stringify } = await EW();
  const p = noTimes(plain(obj)), out = [];   // [P3 H] no wall-clock fields (light stats.marks, dressing facts.ms / msParts): --check compares bytes
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    if (tables.includes(k) && Array.isArray(v)) out.push(`  ${JSON.stringify(k)}: [\n${v.map((r) => '    ' + JSON.stringify(r)).join(',\n')}\n  ]`);
    else out.push(`  ${JSON.stringify(k)}: ${stringify(v, '  ')}`);
  }
  return new TextEncoder().encode('{\n' + out.join(',\n') + '\n}\n');
}
const fnSrc = (f) => (typeof f === 'function' ? f.toString() : null);
/** Drop wall-clock fields (buildMs, binMs, ms, msParts, marks...) so every output is byte-identical run to run. Apply to plain() output. */
export const TIME_KEY = /^(ms|marks)$|Ms$|^ms[A-Z]/;
export const noTimes = (o) => (Array.isArray(o) ? o.map(noTimes) : o && typeof o === 'object' && !ArrayBuffer.isView(o) ? Object.fromEntries(Object.entries(o).filter(([k]) => !TIME_KEY.test(k)).map(([k, v]) => [k, noTimes(v)])) : o);
const r6 = (v) => (typeof v === 'number' ? +v.toFixed(6) : v);

// ================================================================================================================
// pieces
// ================================================================================================================
/** emitters.json: every L3 record, struct-of-arrays (each column homogeneous, Codable-friendly). */
export function emitterTable(list, srcOf) {
  const kinds = [...new Set(list.map((e) => e.kind))].sort(), sources = [...new Set(list.map(srcOf))].sort();
  const col = { id: [], kind: [], source: [], pos: [], normal: [], w: [], h: [], rgb: [], nits: [], animated: [], lot: [] }, extra = {}, flicker = {};
  const known = new Set(['id', 'kind', 'pos', 'normal', 'w', 'h', 'rgb', 'nits', 'animated', 'lot', 'flicker']);
  list.forEach((e, i) => {
    col.id.push(String(e.id)); col.kind.push(kinds.indexOf(e.kind)); col.source.push(sources.indexOf(srcOf(e)));
    col.pos.push(...(e.pos || [0, 0, 0]).map(r6)); col.normal.push(...(e.normal || [0, 0, 1]).map(r6)); col.w.push(r6(e.w ?? 0)); col.h.push(r6(e.h ?? 0));
    col.rgb.push(...(e.rgb || [1, 1, 1]).map(r6)); col.nits.push(r6(e.nits ?? 0)); col.animated.push(e.animated ? 1 : 0); col.lot.push(e.lot == null ? '' : String(e.lot));
    if (e.flicker) flicker[i] = e.flicker;
    const x = Object.fromEntries(Object.entries(e).filter(([k, v]) => !known.has(k) && v != null && typeof v !== 'function' && typeof v !== 'object'));
    if (Object.keys(x).length) extra[i] = x;
  });
  const byKind = Object.fromEntries(kinds.map((k, j) => [k, col.kind.filter((v) => v === j).length]));
  const bySource = Object.fromEntries(sources.map((s, j) => [s, col.source.filter((v) => v === j).length]));
  return { count: list.length, kinds, sources, byKind, bySource, ...col, flicker, extra };
}

function signsShim(parts, X, signsMod) {
  const S = parts.signs; if (!S?.specs) return null;
  const specs = S.specs.map((s) => ({ ...s }));
  const signs = {
    format: 'onetake.signs/1', source: 'shim: seoul-signs build().specs (B has no exportData yet)', count: specs.length,
    units: 'nits = lit face luminance (cd/m2) of the sign (not the rect mean); emitters.json carries the rect mean (x cover)',
    frame: 'frame = the facade: o (x,z) origin at the reader\'s left end of the frontage, r reading direction, n outward normal, L length, top roof height; geo = {u along r, y up, w, h, d depth, out projection}',
    constants: { NIT_SCALE: signsMod?.NIT_SCALE, NITS: signsMod?.NITS, COVER: X.COVER, CENSUS: signsMod?.CENSUS, SHIPPED: signsMod?.SHIPPED, PUSH_BY_KIND: signsMod?.PUSH_BY_KIND, COLOR_CATS: signsMod?.COLOR_CATS, HEX: X.HEX, LIT_P: X.LIT_P, USE_PUSH: X.USE_PUSH },
    stats: noTimes(S.stats),
    atlas: { status: 'browser-only', size: S.stats?.atlas ?? null, pxPerM: S.stats?.pxPerM ?? null, note: 'the face atlas is painted on a Canvas2D (fonts); signs.glb UVs index it. Headless once B ships MSDF glyph runs (graphics #2).' },
    geometry: 'signs.glb: one mesh per bucket (signs-housing, signs-lit, signs-off, signs-neon, signs-scrollers); COLOR_0 = per-vertex face nits (lit) or albedo, _FLK = flicker (hz, depth, phase)',
    specs,
  };
  return signs;
}

function screensShim(parts, X, signsMod) {
  const objs = parts.signs?.screens; if (!Array.isArray(objs)) return null;
  const screens = objs.map((o) => {
    const sc = o.sc || {}, u = o.u || {};
    return { id: sc.id, lot: sc.lot, kind: sc.kind, synth: !!sc.synth, pos: sc.pos, normal: sc.normal, w: sc.w, h: sc.h, res: o.res, pitch: o.res ? r6(sc.w / o.res[0]) : null,
      scanHz: o.scanHz, nits: r6(o.nits), bandDepth: u.uBandDepth?.value, bandN: r6(u.uBandN?.value), bandRate: r6(u.uBandRate?.value), seed: r6(u.uSeed?.value), black: u.uBlack?.value, moire: u.uMoire?.value,
      playlist: { len: r6(o.pl?.len), phase: r6(o.pl?.phase), list: (o.pl?.list || []).map((s) => ({ prog: s.prog, t0: r6(s.t0), dur: r6(s.dur), pal: s.pal.map((c) => c.map(r6)), text: s.text, seed: r6(s.seed) })) } };
  });
  return {
    format: 'onetake.screens/1', source: 'shim: seoul-signs build().screens (B has no exportData yet)', count: screens.length,
    units: 'nits = panel peak luminance (cd/m2); the emitter mean = nits x luma(programMean) (x 0.15 on a cut frame)',
    clock: 'local time lt0 = fract((t + phase) / len) * len; the segment is the last with t0 <= lt0; lt = lt0 - t0; t = the take clock (s)',
    programs: signsMod?.PROG, textRows: signsMod?.SCREEN_TEXT, scrollRows: signsMod?.SCROLL_TEXT, palettes: X.SCREEN_PALETTES, progText: X.PROG_TEXT,
    uniforms: 'uT take clock, uLT segment time, uProg, uC0..2 palette (linear), uRow text rows (main, sub; -1 none), uNits, uNit scene units per nit, uRes LED grid, uMoire, uBandDepth/uBandN/uBandRate (rolling refresh bands: scanHz x readout 0.011 s), uViewH target height, uSeed, uBlack panel black level, uCut first 1/30 s of a segment',
    programMean: fnSrc(signsMod?.programMean),
    shaders: { SCREEN_VERT: X.SCREEN_VERT ?? null, SCREEN_FRAG: X.SCREEN_FRAG ?? null, SCROLL_VERT: X.SCROLL_VERT ?? null, SCROLL_FRAG: X.SCROLL_FRAG ?? null },
    screens,
  };
}

function lightShim(parts, X, lightMod) {
  if (!lightMod) return null;
  return {
    format: 'onetake.light/1', source: 'shim: seoul-light constants + attach() stats (D has no exportData yet)', count: 1,
    units: 'NITS scene units per cd/m2; emitter radiance = rgb / luma(rgb) x nits x NITS (emitterRadiance)',
    NITS: lightMod.NITS, SOURCE_TYPES: lightMod.SOURCE_TYPES, NIGHT_SKY: lightMod.NIGHT_SKY, QUALITY: X.QUALITY, LPR: X.LPR, LW: X.LW, E_MIN: X.E_MIN,
    grid: parts.light?.stats ? { cell: parts.light.stats.grid?.[2], size: parts.light.stats.grid?.slice(0, 2), K: parts.light.stats.K, Kd: parts.light.stats.Kd, static: parts.light.stats.static, dynamic: parts.light.stats.dynamic } : null,
    rules: {
      binning: 'XZ cells of `cell` m; each holds the K strongest static emitters by an irradiance bound at the cell (facing tested at the 4 corners), plus Kd dynamic slots (animated screens, vehicles) rebinned per frame',
      range: 'per emitter: distance where its irradiance bound falls under E_MIN scene units (SOURCE_TYPES[kind].range caps it)',
      shading: 'one-sided rectangular emitters, GGX + Lambert, near-field limit E <= pi L, windowed range; omni = share emitted all round',
    },
    emitterRadiance: fnSrc(lightMod.emitterRadiance),
    stats: noTimes(parts.light?.stats ?? null),
    shaders: { CITY_HEAD: X.CITY_HEAD ?? null, WET_HEAD: X.WET_HEAD ?? null },
    native: 'Metal: compute-clustered lights with no K cap; EDR output keeps sign cores above 1000 nits (PORTING.md, Neon Seoul)',
  };
}

/** The life sim's lane graph as plain data (shim; G's exportData replaces it). */
function lifeNetwork(sim) {
  const net = sim.net, tr = sim.traffic;
  const sid = (s) => s?.id ?? null;
  return {
    streets: net.streets.map((s) => ({ id: s.id, kind: s.kind, width: s.width, carHalf: s.carHalf ?? null, walk: s.walk ?? null, walkHalf: s.walkHalf ?? null, oneway: s.ow ?? 0, nodes: (s.n || []).map((n) => n.id), points: s.points })),
    nodes: net.nodes.map((n) => ({ id: n.id, x: r6(n.x), z: r6(n.z), boundary: !!n.boundary, ends: n.ends.map((e) => [sid(e.st), e.k]) })),
    crossings: net.crossings.map((c) => ({ id: c.id, kind: c.kind, street: sid(c.main), node: c.node?.id ?? null, s: r6(c.sc), toward: c.toward, axis: c.axis, offset: c.offset, cw: c.cw, halfSpan: r6(c.halfSpan), x: r6(c.x), z: r6(c.z) })),
    lanes: tr.lanes.map((l) => ({ id: l.id, street: sid(l.street), dir: l.dir, k: l.k, lat: r6(l.lat), shared: l.shared, bus: l.bus, curb: l.curb, s0: r6(l.s0), s1: r6(l.s1),
      start: l.start?.id ?? null, end: l.end?.id ?? null, stops: (l.stops || []).map((q) => [r6(q.s), q.c.id]), busStops: (l.busStops || []).map(r6), succ: (l.succ || []).map((g) => ({ turn: r6(g.turn), lanes: g.lanes.map((m) => m.id) })) })),
  };
}

export const PARITY_T = [0, 5, 37.5, 90];
/** Swift parity vectors: the traffic hash (bit-exact) and the first vehicle boxes (tolerance 1e-9) at PARITY_T. */
export function lifeParity(LifeSim, layout, seed, { boxes = 12 } = {}) {
  const sim = new LifeSim(layout, { seed }), out = [];
  for (const t of PARITY_T) {
    sim.advanceTo(t);
    const B = sim.boxesAt(t).slice(0, boxes).map((b) => ({ id: b.id, type: b.type, c: b.c, half: b.half, h: b.h }));
    out.push({ t, trafficStep: sim.traffic.n, crowdStep: sim.crowd.n, hash: sim.hash(), vehicles: sim.traffic.vehicles.filter((v) => !v.hidden).length, boxes: B });
  }
  return out;
}

function lifeShim(parts, X, lifeMod, layout, seed) {
  if (!lifeMod?.LifeSim) return null;
  const sim = parts.life?.sim || new lifeMod.LifeSim(layout, { seed });
  const L = lifeMod.LIFE || {};
  return {
    format: 'onetake.life/1', source: 'shim: seoul-life LifeSim network + constants (G has no exportData yet)', count: sim.traffic.lanes.length,
    seed, clock: 'the take clock (s) = sim ticks / 240; traffic steps at LIFE.trafficHz, the crowd at LIFE.crowdHz, rendered interpolated (alpha)',
    LIFE: Object.fromEntries(Object.entries(L).map(([k, v]) => [k, typeof v === 'function' ? { fn: fnSrc(v) } : v])),
    VEH: lifeMod.VEH, PAINT: X.PAINT, VTYPES: X.VTYPES,
    signal: { fn: fnSrc(lifeMod.signalPhase), crossPhase: fnSrc(lifeMod.crossPhase) },
    rng: 'rng.js (Mulberry32-style; PORTING.md determinism contract 2); TrafficSim seeds Rng(seed ^ 0x7a11c)',
    determinism: 'traffic: integer-seeded, fixed 60 Hz, no trig in the step; TrafficSim.pose() uses Math.sin for the alley scooter weave (seoul-life.js, G: replace with a polynomial for bit parity of poses)',
    counts: { lanes: sim.traffic.lanes.length, vehicles: sim.traffic.vehicles.length, agents: sim.crowd.agents?.length ?? null, crossings: sim.net.crossings.length },
    network: lifeNetwork(sim),
    parity: { note: 'traffic hash = LifeSim.hash() (FNV over every vehicle s, v as float64 words + id), bit-exact; boxes within 1e-9 m (pose uses libm)', vectors: lifeParity(lifeMod.LifeSim, layout, seed) },
  };
}

async function lookOf(root, X, L, log) {
  try {
    const fc = MODS?.files['fpvcam.js']; if (!fc?.FPVCamera) return null;
    const { sourceLiteral, evalLiteral } = await import('./expose.mjs');
    const main = readFileSync(join(root, 'main.js'), 'utf8');
    const cam = new fc.FPVCamera(null); cam.setHDR(true);
    const G = X['fpvcam.js']?.GRADES || {};
    let via;
    if (typeof cam.setLook === 'function') { cam.setLook(L.look || 'night'); via = 'fpv.setLook'; }
    else if (G[L.look || 'night']) { cam._applyGrade?.(G[L.look || 'night']); via = 'GRADES.' + (L.look || 'night'); }
    else { const t = sourceLiteral(main, 'const NIGHT_FALLBACK =', '{'); Object.assign(cam.look, t ? evalLiteral(t) : {}); via = 'main.js NIGHT_FALLBACK'; }
    if (L.grade && typeof L.grade === 'object') for (const [k, v] of Object.entries(L.grade)) cam.look[k] = Array.isArray(v) ? v.slice() : v;
    const { plain } = await EW();
    const look = plain({ ...cam.look, lens: undefined });
    return { format: 'onetake.look/1', level: L.id, look: L.look || 'night', via, grade: L.grade ?? null, resolved: look, grades: { night: G.night ?? null }, profile: typeof cam.profile === 'function' ? plain(cam.profile()) : null,
      note: 'FPVCamera -> setHDR(true) -> the level look (main.js applyLook) -> levels.json grade; lens / shutter / samples come from applySettings as in camera.json' };
  } catch (e) { log(`  note: look.json: ${e.message}`); return null; }
}

/** [P3 H] Node has no DOM: a module that loads a texture with THREE.TextureLoader while building (E's dressing materials)
 *  would throw `document is not defined` and take the whole headless build down. For the build only, ImageLoader.load
 *  returns an empty placeholder image (never loaded: the export reads geometry and data, never texels). */
async function headless(fn) {
  if (typeof document !== 'undefined') return fn();
  const THREE = await import('three'), P = THREE.ImageLoader.prototype, load0 = P.load;
  P.load = function (url) { return { src: url, width: 0, height: 0, headless: true }; };
  try { return await fn(); } finally { P.load = load0; }
}

// ================================================================================================================
// [P3 H, native #2] light tables and atlases
// ================================================================================================================
/** [P4 H, native #4] a binary table as a meshopt vertex stream (lossless): files[name] = encoded; the descriptor gains codec,
 *  stride, count, decodedBytes. Without an encoder (--raw) the bytes stay as they are. */
let MO = null;
const PACKED = {};
function packBin(files, name, bytes, stride, desc = {}) {
  if (!MO || bytes.byteLength % stride || stride % 4 || stride > 256) { files[name] = bytes; return desc; }
  const n = bytes.byteLength / stride, enc = MO.encodeGltfBuffer(bytes, n, stride, 'ATTRIBUTES');
  files[name] = enc; PACKED[name] = { stride, count: n, decodedBytes: bytes.byteLength, bytes: enc.byteLength };
  return Object.assign(desc, { codec: 'meshopt ATTRIBUTES v0 (meshopt_decodeVertexBuffer(dst, count, stride, src))', stride, count: n, decodedBytes: bytes.byteLength });
}

/** light.json from D's controller: the typed arrays leave the JSON for little-endian binary files under light/. */
async function lightTables(L, ctl, files) {
  const THREE = await import('three');
  const half = (f32) => { const o = new Uint16Array(f32.length); for (let i = 0; i < f32.length; i++) o[i] = THREE.DataUtils.toHalfFloat(f32[i]); return o; };
  const bytes = (ta) => new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength).slice();
  const out = { ...L }, tables = {};
  const v = L.volume;
  if (v?.A && v?.B) {
    const a = half(v.A), b = half(v.B), buf = new Uint8Array(a.byteLength + b.byteLength); buf.set(bytes(a), 0); buf.set(bytes(b), a.byteLength);
    const vd = packBin(files, 'light/volume.bin', buf, 8);
    out.volume = { ...vd, file: 'light/volume.bin', format: 'RGBA16F (IEEE half, little-endian)', dims: v.dims, heights: v.heights, layout: '[cz][cx][layer][4]: A block (count values) then B block', A: { byteOffset: 0, count: v.A.length }, B: { byteOffset: a.byteLength, count: v.B.length },
      meaning: 'A = ambient rgb + haze fluence, B = L1 direction / ambient luminance + sky openness; E(n) = A.rgb max(0, 1 + B.n) (exportParams().volume)' };
  }
  const U = ctl.uniforms || {};
  const tex = (name, key, fmt, meaning) => {
    const im = U[key]?.value?.image; if (!im?.data) return;
    const st = name === 'records' ? 16 : 8;   // RGBA32UI / RGBA16UI texels
    tables[name] = { file: `light/${name}.bin`, format: fmt, width: im.width, height: im.height, count: im.data.length, meaning, ...packBin(files, `light/${name}.bin`, bytes(im.data), st) };
    if (tables[name].codec) tables[name].count = im.data.length;   // components (the stream's element count is in `stride`/`decodedBytes`)
  };
  tex('records', 'tCityL', 'RGBA32UI, little-endian', 'static light records, 2 texels each (exportParams().record); texel 2i, 2i + 1 = light i; width = 2 x LW');
  tex('grid', 'tCityG', 'RGBA16UI, little-endian; 0xFFFF = none', 'per XZ cell (grid.cell m from grid.x0, z0) the K strongest static light ids, K4 texels wide per cell, strongest first');
  const HF = ctl.heightField;
  if (HF?.H) { files['light/height.bin'] = bytes(HF.H); tables.height = { file: 'light/height.bin', format: 'R32F, little-endian', width: HF.nx, height: HF.nz, x0: HF.x0, z0: HF.z0, res: HF.res, meaning: 'roof height (m) per res-m texel, row = z: occlusion of light paths and the volume (heightField)' }; }
  out.tables = tables;
  out.runtime = 'rebuilt per frame from life.json / screens.json: the dynamic window (tCityLD, tCityGD: DW x DW cells round the camera) and the light curves of animated emitters (tCityLC)';
  if (ctl.stats) out.stats = ctl.stats;
  return out;
}

/** B's MSDF atlas + metrics, C's interior atlas, and the fonts the Canvas2D atlases use (copied as is). -> data.atlases */
async function atlasFiles(root, files, mods, dressingData) {
  const A = {};
  const msdfPng = join(root, 'seoul/signs/msdf.png'), msdfMeta = join(root, 'seoul/signs/msdf-meta.js');
  if (existsSync(msdfPng)) {
    files['signs/msdf.png'] = readFileSync(msdfPng);
    let meta = null; try { meta = (await import(pathToFileURL(msdfMeta).href)).MSDF; } catch (e) { /* metrics missing */ }
    if (meta) files['signs/msdf.json'] = await jsonText({ format: 'onetake.msdf/1', source: 'seoul/signs/msdf-meta.js (tools/seoul-msdf.py)', ...meta, image: 'signs/msdf.png' });
    A.msdf = { image: 'signs/msdf.png', metrics: meta ? 'signs/msdf.json' : null, size: meta?.size ?? null, pxPerEm: meta?.px ?? null, range: meta?.range ?? null, faces: meta?.faces?.length ?? null, colorSpace: 'linear (distance field: no sRGB decode)', orientation: 'row 0 = atlas y 0 (y down, as the metrics), flipY false' };
  }
  const im = mods?.files?.['seoul-interiors.js'] || (existsSync(join(root, 'seoul-interiors.js')) ? await import(pathToFileURL(join(root, 'seoul-interiors.js')).href) : null);
  if (typeof im?.buildInteriorAtlas === 'function') {
    const at = im.buildInteriorAtlas(), { encodePNG } = await import('./png.mjs');
    files['interiors.png'] = encodePNG(at.data, at.width, at.height);
    files['interiors.json'] = await jsonText({ format: 'onetake.interiors/1', source: 'seoul-interiors.js buildInteriorAtlas() (C; pure CPU, deterministic)', image: 'interiors.png', width: at.width, height: at.height,
      colorSpace: 'rgb sRGB, alpha linear', orientation: 'PNG row 0 = v 0 (flipY false)', ATLAS: im.ATLAS, ROOM: im.ROOM, FRONT: im.FRONT, meanLuminance: Array.from(at.mean || []).map((x) => +x.toFixed(6)) });
    A.interiors = { image: 'interiors.png', meta: 'interiors.json', size: [at.width, at.height], tiles: im.ATLAS ? im.ATLAS.cols * im.ATLAS.rows : null };
  }
  const fonts = [];
  for (const [dir, to] of [['seoul/fonts', 'fonts'], ['seoul/dressing', 'dressing']]) {
    const d = join(root, dir); if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) if (/\.(woff2|txt)$/.test(f)) { files[`${to}/${f}`] = readFileSync(join(d, f)); if (/\.woff2$/.test(f)) fonts.push(`${to}/${f}`); }
  }
  A.fonts = { files: fonts, licence: 'OFL (fonts/OFL.txt, dressing/OFL.txt)', use: 'fonts/: the screen and scroller text atlases (Canvas2D at load: screens.json); dressing/E-Sans: E\'s label atlas, one cell per dressing.json labels[] entry' };
  A.labels = dressingData?.file ? { cells: `${dressingData.file} labels`, font: 'dressing/E-Sans.woff2', note: 'painted at load in the browser (Canvas2D); a port paints the same cells (CoreText)' } : null;
  return A;
}

// ================================================================================================================
// [P4 H, native #4] tables -> binary columns (signs.json's designs were 18 MB of JSON)
// ================================================================================================================
export const SIGN_TABLES = ['faces', 'designs', 'housings', 'scrollers', 'emitters'];
export const PACKED_TABLES = 'onetake.columns/1';
/**
 * Each listed table (an array of records, or of arrays of records: designs) becomes columns. A key whose every value is
 * a finite number, or a fixed-length array of them, goes to `file` as one meshopt vertex stream (EXT_meshopt
 * ATTRIBUTES codec, v0; stride 4 x comps): Int32 when every value is an integer in range, else Float32 (lossless for
 * integers; JSON decimals round to the nearest float32). Every other key stays a JSON column array. Nested tables
 * (array of arrays) are flattened, with `offsets` (Int32, rows + 1) marking where each inner list starts.
 * -> { json (the object with the tables replaced by their column descriptions), bytes, info }
 */
export function packTables(obj, tables, E, file) {
  const out = { ...obj }, chunks = [], info = { format: PACKED_TABLES, file, tables: [] }; let off = 0;
  const pushStream = (arr, comps) => {
    const raw = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), n = arr.length / comps, stride = 4 * comps;
    const enc = E.encodeGltfBuffer(raw, n, stride, 'ATTRIBUTES'), pad = (4 - (off % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); off += pad; }
    chunks.push(enc); const d = { byteOffset: off, byteLength: enc.byteLength, count: n, stride, codec: 'meshopt ATTRIBUTES v0' }; off += enc.byteLength; return d;
  };
  for (const t of tables) {
    const T = obj[t]; if (!Array.isArray(T) || T.length < 64) continue;
    const nested = T.every(Array.isArray), rows = nested ? T.flat() : T;
    if (!rows.length || !rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) continue;
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))], cols = {}, json = {};
    for (const k of keys) {
      const vals = rows.map((r) => r[k]), first = vals[0];
      const len = Array.isArray(first) ? first.length : 1;
      const numeric = len >= 1 && len <= 64 && vals.every((v) => (len === 1 && !Array.isArray(v) ? typeof v === 'number' && Number.isFinite(v) : Array.isArray(v) && v.length === len && v.every((x) => typeof x === 'number' && Number.isFinite(x))));
      if (!numeric) { json[k] = vals; continue; }
      const flat = len === 1 && !Array.isArray(first) ? vals : vals.flat(), int = flat.every((x) => Number.isInteger(x) && x >= -2147483648 && x <= 2147483647);
      // decimals the JSON was rounded to (B writes 2-4): fixed point, exact against the JSON, and far smaller once encoded
      let dec = -1; if (!int) for (let d = 1; d <= 6 && dec < 0; d++) { const m = 10 ** d; if (flat.every((x) => Math.abs(x * m) < 2e9 && Math.abs(x * m - Math.round(x * m)) < 1e-6 * Math.max(1, Math.abs(x * m)))) dec = d; }
      const arr = int ? Int32Array.from(flat) : dec > 0 ? Int32Array.from(flat, (x) => Math.round(x * 10 ** dec)) : Float32Array.from(flat);
      cols[k] = { type: int || dec > 0 ? 'i32' : 'f32', comps: len, ...(dec > 0 ? { scale: +(10 ** -dec).toFixed(dec), note: `fixed point: value = i32 x 1e-${dec} (exact: the JSON had ${dec} decimals)` } : {}), ...(Array.isArray(first) ? { array: true } : {}), ...pushStream(arr, len) };
    }
    const desc = { packed: PACKED_TABLES, file, rows: rows.length, columns: cols, json };
    if (nested) { const o = new Int32Array(T.length + 1); T.forEach((a, i) => { o[i + 1] = o[i] + a.length; }); desc.lists = T.length; desc.offsets = { type: 'i32', comps: 1, ...pushStream(o, 1) }; }
    out[t] = desc; info.tables.push({ table: t, rows: rows.length, ...(nested ? { lists: T.length } : {}), binary: Object.keys(cols), json: Object.keys(json) });
  }
  if (!chunks.length) return { json: obj, bytes: null, info: null };
  const bytes = new Uint8Array(off); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.byteLength; }
  info.decode = 'per column: meshopt_decodeVertexBuffer(dst, count, stride, file[byteOffset, byteLength]) -> count x comps little-endian i32 / f32 (three: MeshoptDecoder.decodeGltfBuffer(dst, count, stride, src, "ATTRIBUTES")); row r of a nested table belongs to list i where offsets[i] <= r < offsets[i + 1]';
  out.binary = info;
  return { json: out, bytes, info: { tables: info.tables.map((x) => x.table), bytes: bytes.byteLength } };
}

/** Decode packTables' columns with an independent decoder and hold every value to the source table. -> [problem] */
export function unpackCheck(orig, packed, bytes, D) {
  const bad = [];
  for (const t of Object.keys(packed)) {
    const P = packed[t]; if (P?.packed !== PACKED_TABLES) continue;
    const T = orig[t], rows = T.every(Array.isArray) ? T.flat() : T;
    const col = (c) => { const out = new Uint8Array(c.count * c.stride); D.decodeGltfBuffer(out, c.count, c.stride, bytes.subarray(c.byteOffset, c.byteOffset + c.byteLength), 'ATTRIBUTES'); return c.type === 'i32' ? new Int32Array(out.buffer) : new Float32Array(out.buffer); };
    for (const [k, c] of Object.entries(P.columns)) {
      const v = col(c), want = rows.flatMap((r) => (c.array ? r[k] : [r[k]])); let m = 0;
      for (let i = 0; i < want.length; i++) { const g = c.scale ? v[i] * c.scale : v[i], w = want[i]; if (!(c.type === 'f32' ? g === Math.fround(w) : Math.abs(g - w) <= (c.scale ? c.scale * 0.5 + 1e-9 : 0))) m++; }
      if (v.length !== want.length || m) bad.push(`${t}.${k}: ${m} of ${want.length} values differ after decoding`);
    }
    if (P.offsets) { const o = col(P.offsets); let acc = 0; const ok = T.every((a, i) => { const r = o[i] === acc; acc += a.length; return r; }) && o[T.length] === acc; if (!ok) bad.push(`${t}: offsets differ`); }
    for (const [k, vals] of Object.entries(P.json)) if (vals.length !== rows.length) bad.push(`${t}.${k}: json column length`);
  }
  return bad;
}

// ================================================================================================================
// [P4 H, native #2] phase-3 content: avatars, dressing card textures, menu art; the night lightmap; asset coverage
// ================================================================================================================
/** Whole folders the runtime fetches from, copied as is (every file but dotfiles): repo dir -> export dir. */
export const CONTENT_DIRS = [
  { from: 'seoul/people', to: 'people', id: 'people', what: 'G1\'s crowd bodies (Rocketbox, MIT): people.json + people.bin + atlas.jpg + hair.png (seoul-life.js attachAvatars)' },
  { from: 'seoul/dressing', to: 'dressing', id: 'dressing', what: 'E\'s card textures (ginkgo_cards.png, ac_face.png: world.json materials[dr_*].mapFile) and label font' },
  { from: 'seoul/ui', to: 'ui', id: 'ui', what: 'the level\'s menu art (levels.json thumb / backdrop) and the OFL hangul subset index.html loads' },
];
async function contentFiles(root, files, assetMap) {
  const out = {};
  for (const D of CONTENT_DIRS) {
    const d = join(root, D.from); if (!existsSync(d)) continue;
    const list = [];
    for (const f of readdirSync(d).sort()) { if (f.startsWith('.')) continue; const p = join(d, f); if (!statSync(p).isFile()) continue;
      files[`${D.to}/${f}`] = readFileSync(p); assetMap[`${D.from}/${f}`] = `${D.to}/${f}`; list.push(`${D.to}/${f}`); }
    out[D.id] = { dir: D.to + '/', files: list, what: D.what };
  }
  const pj = join(root, 'seoul/people/people.json');
  if (out.people && existsSync(pj)) {
    const meta = JSON.parse(readFileSync(pj, 'utf8'));
    out.people.avatars = (meta.avatars || []).map((a) => ({ name: a.name, sex: a.sex, lods: (a.lods || []).map((L) => ({ name: L.name, verts: L.verts, tris: L.tris })) }));
    out.people.atlas = meta.atlas;
    out.people.layout = 'people.bin, per avatar per LOD (people.json avatars[].lods[]: byte offsets): pos Float32 x3 (rest pose, metres, y up), nrm Int8 x4 (snorm xyz + pad), uv Float32 x2 (atlas.jpg; hair cards: hair.png), bone Uint8 x4 (crowd-rig bone ids + weights, seoul-life.js makeHumanMat), index Uint16 x3 per triangle';
    out.people.textures = 'atlas.jpg (sRGB, body + head 512^2 tiles) and hair.png (sRGB + alpha cards). RGBA8 on the GPU as shipped: KTX2 / ASTC is a G1 + H follow-up (panel3 native.md bugs)';
    out.people.rig = 'the crowd\'s procedural 13-bone rig (life.json LIFE, seoul-life.js) skins these meshes; joints per avatar in people.json';
  }
  return out;
}

/** [P5 H, native #1 / #2] One lightmap, one key. The game fetches seoul/light/night-lm.bin (D's bake: RGB9E5, NLM2 header +
 *  gzip of 4 row-delta byte planes) and uses it when the file's key equals lmKey over this build's bake inputs (emitters,
 *  layout, model constants). The export ships that same file, byte for byte, as light/night-lm.bin, with the same key in
 *  light.json: a port reads exactly what the browser reads (RGB9E5 is MTLPixelFormatRGB9E5Float on Apple GPUs). The
 *  headless build computes the key (ctl.stats.lightmap.key); a stale or missing file is a warning (--strict fails: re-run
 *  node tools/bakelm.mjs --night and commit it). P4's second bake (RGBA16F light/lightmap.bin) is gone: it was a
 *  different file with no key the game knew. Only when the committed file is stale does the in-line bake still ship as
 *  light/lightmap.bin, marked stale-fallback, so a port has a map while the warning stands. */
async function lightmapFile(root, ctl, files, layoutSha) {
  const N = await import(pathToFileURL(join(root, 'seoul-nightlm.js')).href), NL = N.NIGHT_LM || {};
  const st = ctl?.stats?.lightmap, U = ctl?.uniforms || {}, key = st?.key ?? null;
  const v4 = (k) => (U[k]?.value?.toArray ? U[k].value.toArray().map((x) => +x.toFixed(6)) : null);
  const common = {
    uniforms: { uCityLM: v4('uCityLM'), uCityLMG: v4('uCityLMG'), uCityLMA: v4('uCityLMA'), uCityLMR: v4('uCityLMR') },
    lookup: 'the ground map sits at the atlas origin (uCityLMG: x0, z0, gw, gh); wall rects pack round it (uCityLMA: atlas w, h, raster w, h); the 1 m raster of the two nearest exposed edges and the edge table are rows uCityLMR.x.. of light/records.bin (seoul-light.js CITY_HEAD cityLM)',
    content: 'scene-linear irradiance x NITS (rgb); static emitters (no K limit, heightfield-occluded) + the volume\'s indirect part (seoul-nightlm.js); invalid texels dilated from valid neighbours (NIGHT_LM.dilate)',
    plan: st?.edges != null ? { edges: st.edges, atlas: st.atlas, ground: st.ground } : null, NIGHT_LM: NL, layoutSha256: layoutSha,
  };
  const rel = String(NL.file || './seoul/light/night-lm.bin').replace(/^\.\//, ''), p = join(root, rel);
  const F = existsSync(p) ? N.lmFileHeader(readFileSync(p)) : null;
  if (F && key && F.header.key === key) {
    files['light/night-lm.bin'] = readFileSync(p);
    // [P6 H, native #2] the decoded texels' hash, so a port proves it reads the same map (native/OneTakeSeoul NightLM)
    const { gunzipSync } = await import('node:zlib'), { GeoHash } = await import(pathToFileURL(join(root, 'geohash.js')).href);
    const texelHash = new GeoHash().str('nlm').array(N.lmUnplanes(gunzipSync(F.payload), F.header.w, F.header.h)).hex();
    return { file: 'light/night-lm.bin', key, texelHash, texelHashOf: 'GeoHash mm3x2/1: str("nlm"), then the w x h decoded RGB9E5 u32 texels (count, then each)', keyOf: 'seoul-nightlm.js lmKey over the bake inputs (the game uses the file only when its header key equals its own)', source: `${rel} (D, shipped; byte for byte what the game fetches)`,
      format: 'NLM2: "NLM2" | u32 LE header bytes | header JSON {key, w, h, version, enc, texels, bytes} | gzip payload: the w x h RGB9E5 texels (u32 LE, rows bottom-up as a GL DataTexture) as 4 byte planes, each delta-coded along the rows (seoul-nightlm.js lmUnplanes)',
      width: F.header.w, height: F.header.h, version: F.header.version, texels: F.header.texels, bytes: files['light/night-lm.bin'].length, gpu: 'RGB9E5 (MTLPixelFormatRGB9E5Float / GL_RGB9_E5), 4 bytes per texel', ...common };
  }
  const why = !key ? `the headless build computed no key (lightmap mode ${st?.mode ?? 'none'})` : !F ? `${rel} is missing or not an NLM2 file` : `${rel} is stale (file key ${F.header.key}, this build ${key})`;
  const out = { status: 'stale', key, note: `${why}: re-run node tools/bakelm.mjs --night and commit ${rel}` };
  const tex = ctl?.uniforms?.tCityLM?.value;   // the stale fallback: this build's in-line bake, so the port still has a map
  if (st?.ready && tex?.image?.data && tex.image.width >= 2) {
    const im = tex.image, d = im.data, bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice();
    const pk = packBin(files, 'light/lightmap.bin', bytes, 4);
    Object.assign(out, { file: 'light/lightmap.bin', fallback: true, format: 'the in-line bake as the GPU holds it (RGB9E5 u32 LE when NIGHT_LM ships RGB9E5), rows bottom-up', width: im.width, height: im.height, ...common, ...pk });
  }
  return out;
}

/** Asset coverage (native #2): every file a Seoul runtime module (or the level's levels.json entry) names that exists in
 *  the repo must be in the export, byte for byte, or be listed in ASSET_EXCEPTIONS with a reason. A literal ending in an
 *  asset extension resolves against the repo root, then against each 'seoul/<dir>/' base the same module names. */
export const ASSET_EXCEPTIONS = {
  'seoul/audio/crowd-chicken-yangjae-pd.mp3': 'opt-in ?beds A/B only (sound #1: Justin decides on recorded beds); the port synthesises the beds as the browser does',
  'seoul/audio/crowd-restaurant-pd.mp3': 'opt-in ?beds A/B only (sound #1)',
  'seoul/layout.provisional.json': 'fallback when layout.json is missing (it is not: layout.json ships)',
  'levels.json': 'the game\'s level list; the level entry ships as world.json level',
};
const ASSET_EXT = /\.(png|jpe?g|bin|json|ktx2|woff2?|mp3|ogg|wav|glb|txt)$/i;
export function assetRefs(root, modules) {
  const refs = new Map();
  for (const mm of modules) {   // a repo path, or { name, src } (the level's levels.json entry)
    const m = mm.name ?? mm, p = join(root, m); if (mm.src == null && !existsSync(p)) continue;
    const src = mm.src ?? readFileSync(p, 'utf8');
    const lits = [...src.matchAll(/['"`]([^'"`\s${}()]+)['"`]/g)].map((x) => x[1]);
    const bases = [...new Set(lits.filter((s) => /^(\.\/)?seoul\/[\w./-]*\/$/.test(s)).map((s) => s.replace(/^\.\//, '')))];
    for (const s of lits) {
      if (!ASSET_EXT.test(s) || /^https?:/.test(s)) continue;
      const rel = s.replace(/^\.\//, ''), cands = rel.includes('/') ? [rel] : bases.map((b) => b + rel);
      for (const c of cands) if (existsSync(join(root, c)) && statSync(join(root, c)).isFile()) { if (!refs.has(c)) refs.set(c, new Set()); refs.get(c).add(m); }
    }
  }
  return refs;
}
export function assetCoverage(root, files, modules, warn) {
  const bySha = new Map(); for (const [f, b] of Object.entries(files)) bySha.set(sha256(b), f);
  const refs = assetRefs(root, modules), rows = [];
  for (const [asset, by] of [...refs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const hit = bySha.get(sha256(readFileSync(join(root, asset)))), exc = ASSET_EXCEPTIONS[asset];
    rows.push({ asset, by: [...by].sort(), export: hit ?? null, ...(exc && !hit ? { exception: exc } : {}) });
    if (!hit && !exc) warn(`asset coverage: ${[...by].join(', ')} fetches ${asset}, which the export does not ship (add it to the export, or to ASSET_EXCEPTIONS in tools/export-seoul-data.mjs with a reason)`);
  }
  return rows;
}

// ================================================================================================================
// exportSeoulData: called by export-world exportLevel (or this CLI). Returns files + the world.json `data` section.
// ================================================================================================================
export const SEOUL_COVERAGE = [
  { id: 'city', match: { mesh: 'world.glb' }, export: 'world.glb meshes[] (one per material key; vertex count + bounds equal a world.json meshes[] row)' },
  { id: 'signs', match: { name: '^signs-', ancestor: '^seoul-signs$' }, export: 'signs.json (spec table) + signs.glb (static sign geometry)', requires: 'data.signs.count' },
  { id: 'screens', match: { name: '^screen-', ancestor: '^seoul-signs$' }, export: 'screens.json (panel model, playlists, SCREEN_FRAG)', requires: 'data.screens.count' },
  { id: 'crowd', match: { name: '^crowd-', ancestor: '^seoul-life$' }, export: 'life.json (crowd sim) + people/ (avatar meshes, atlases: data.content.people) + runtimeOnly.crowd', requires: 'data.life.count' },
  { id: 'traffic', match: { name: '^traffic-', instanced: true, ancestor: '^seoul-life$' }, export: 'life.json (traffic sim, VEH, PAINT)', requires: 'data.life.count' },
  { id: 'life-props', match: { name: '^pocha-', instanced: true, ancestor: '^seoul-life$' }, export: 'life.json (pocha tables / stools at the tents)', requires: 'data.life.count' },
  { id: 'headlight-pools', match: { name: '^headlight-pools$', ancestor: '^seoul-life$' }, export: 'runtimeOnly.headlightPools (life.json vehicles + light.json)', requires: 'data.life.count' },
  { id: 'sky', match: { name: '^seoul\\.sky$' }, export: 'light.json NIGHT_SKY (dome)', requires: 'data.light.count' },
  { id: 'airlight', match: { name: '^seoul\\.airlight$' }, export: 'runtimeOnly.airlight (light.json AIRLIGHT + HAZE: single-scatter sprites round the brightest emitters in view)', requires: 'data.light.count' },
  { id: 'steam', match: { name: '^seoul\\.steam$' }, export: 'runtimeOnly.steam (light.json QUALITY.steam)', requires: 'data.light.count' },
  { id: 'wallpacks', match: { name: '^seoul\\.wallpack' }, export: 'emitters.json (role wallpack) + light.json WALLPACK (the fixture: a 0.36 x 0.2 x 0.3 m housing, the lens at the record) [P4-D]', requires: 'data.light.count' },
  { id: 'dressing', match: { ancestor: '^seoul[-.]dressing' }, export: 'dressing.json (E: runtime parts, cable renderer)', requires: 'data.dressing.count' },
];
export const SEOUL_RUNTIME_ONLY = {
  crowd: 'CrowdSim (seoul-life.js) at 10 Hz, interpolated; near / mid: 8 Rocketbox avatars x 2 LODs (people/: people.json + people.bin, atlas.jpg, hair.png; data.content.people), skinned on the crowd\'s procedural 13-bone rig and instanced; far: the procedural human (life.json LIFE)',
  traffic: 'TrafficSim at 60 Hz on the life.json lane graph; instanced low-poly bodies, emissive lamps (emitters.json source life = their t = 0 state)',
  screens: 'screen content is procedural per frame (screens.json playlists + SCREEN_FRAG); the emitter colour follows programMean',
  signsAtlas: 'sign glyphs: signs/msdf.png + signs/msdf.json (B\'s MSDF atlas); screen and scroller text: Canvas2D atlases painted at load from fonts/ (screens.json)',
  headlightPools: 'additive pools under each vehicle head lamp (life)',
  steam: 'steam puffs (Points), count QUALITY[q].steam (light)',
  airlight: 'closed-form single-scatter airlight sprites (one instanced quad) round the AIRLIGHT.n brightest emitters in view, re-picked every 3 frames (light)',
  light: 'the clustered light grid is binned at load from emitters.json (light.json rules); the night lightmap ships as the file the game fetches (light/night-lm.bin, RGB9E5, keyed: light.json lightmap.key)',
};

export async function exportSeoulData({ root = ROOT, geo, L, seed, mods, log = console.log, note = log, warn = log, meshopt = null } = {}) {
  mods ||= await seoulModules(root, log);
  MO = meshopt; for (const k of Object.keys(PACKED)) delete PACKED[k];
  const MDEC = meshopt ? (await import('three/addons/libs/meshopt_decoder.module.js')).MeshoptDecoder : null; if (MDEC) await MDEC.ready;
  const ws = mods.files['world-seoul.js'], X = mods.X;
  const signsMod = mods.files[PARTNERS.signs], lightMod = mods.files[PARTNERS.light], lifeMod = mods.files[PARTNERS.life], dressMod = mods.files[PARTNERS.dressing];
  const files = {}, data = {}, layout = geo.layout || (await ws.loadSeoulJSON('./seoul/layout.json')), assetMap = {};
  const layoutSha = existsSync(join(root, 'seoul/layout.json')) ? sha256(readFileSync(join(root, 'seoul/layout.json'))) : null;
  const put = async (name, obj, tables) => { files[name] = await jsonText(obj, tables); };

  // ---- the runtime build, headless: what the browser builds (emitters, signs, life, light)
  let world = null;
  try { world = await headless(() => ws.buildSeoul(null, { seed, takeClock: () => 0, quality: 'auto', lightmap: true })); }   // [P4 H] lightmap: D's night bake, in line in node
  catch (e) { warn(`buildSeoul() failed in node (${e.message}): emitters from the geometry entry only, partner data from the modules`); }
  const parts = world?.parts || {};
  const ctx = { layout, seed, nitScale: ws.NITS ?? 0.1, NIT: ws.NITS ?? 0.1, quality: 'auto', headless: true, world, emitters: world?.emitters || geo.emitters };

  // ---- emitters.json
  const geoIds = new Set((geo.emitters || []).map((e) => e.id)), signIds = new Set((parts.signs?.emitters || []).map((e) => e.id)), lifeIds = new Set((parts.life?.emitters || []).map((e) => e.id));
  const srcOf = (e) => (signIds.has(e.id) ? 'signs' : lifeIds.has(e.id) ? 'life' : geoIds.has(e.id) ? (String(e.id).startsWith('dress') ? 'dressing' : 'geometry') : 'other');
  const allE = world?.emitters || geo.emitters || [];
  const dup = allE.length - new Set(allE.map((e) => e.id)).size;
  if (dup) warn(`emitters: ${dup} duplicate ids`);
  const et = emitterTable(allE, srcOf);
  await put('emitters.json', { format: 'onetake.emitters/1', units: 'pos m (x east, y up, z south); nits = cd/m2 averaged over the w x h rect (L3); rgb linear, luma-normalised; radiance = rgb x nits x NITS (light.json)',
    layout: 'struct of arrays: record i = id[i], kinds[kind[i]], sources[source[i]], pos[3i..3i+2], normal[3i..], w[i], h[i], rgb[3i..], nits[i], animated[i] (1 = updated per frame: screens from screens.json, vehicles from life.json; values here are t = 0), lot[i]; flicker / extra keyed by i',
    snapshot: 'take clock t = 0, quality auto', ...et });
  data.emitters = { file: 'emitters.json', count: et.count, byKind: et.byKind, bySource: et.bySource };

  // ---- signs.json + screens.json (+ signs.glb)
  const bx = exporterOf(signsMod);
  let signs = null, screens = null, extraFiles = {};
  if (bx) {
    try {
      const r = await bx(layout, ctx) || {};
      signs = r['signs.json'] ?? r.signs ?? null; screens = r['screens.json'] ?? r.screens ?? null;
      for (const [k, v] of Object.entries(r.files || r)) if (/\.(png|bin|glb|ktx2|json)$/.test(k) && !['signs.json', 'screens.json'].includes(k)) extraFiles[k] = v;
      data.signsSource = 'seoul-signs exportData()';
    } catch (e) { warn(`seoul-signs exportData() threw: ${e.message}; using the shim`); }
  } else note('seoul-signs has no exportData() yet (B, native #2): signs.json / screens.json from the shim');
  signs ||= signsShim(parts, X[PARTNERS.signs] || {}, signsMod); screens ||= screensShim(parts, X[PARTNERS.signs] || {}, signsMod);
  if (signs) {
    const count = signs.count ?? signs.specs?.length ?? signs.faces?.length ?? 0;
    let packed = null;   // [P4 H, native #4] the big tables leave the JSON for meshopt column streams in signs.bin
    if (meshopt) { const r = packTables(signs, SIGN_TABLES, meshopt, 'signs.bin'); if (r.bytes) { for (const p of unpackCheck(signs, r.json, r.bytes, MDEC)) warn(`signs.bin: ${p}`); signs = r.json; files['signs.bin'] = r.bytes; packed = r.info; } }
    await put('signs.json', signs, ['specs', ...SIGN_TABLES]);
    data.signs = { file: 'signs.json', count, source: signs.source ?? data.signsSource, ...(packed ? { bin: 'signs.bin', packed } : {}) };
  }
  else data.signs = { status: 'pending', count: 0, note: 'seoul-signs did not build in node' };
  if (screens) { await put('screens.json', screens, ['screens']); data.screens = { file: 'screens.json', count: screens.count ?? screens.screens?.length ?? 0, source: screens.source ?? data.signsSource }; }
  else data.screens = { status: 'pending', count: 0 };
  // static sign geometry: B's geometry, else the node-built group's meshes (minus the per-screen planes)
  try {
    const { GLBWriter } = await import('./glb.mjs'), { attrArray } = await import('./geohash.mjs'), { PACK } = await EW();
    const meshes = [];
    const gsrc = signs?.geometryMeshes || null;
    if (gsrc) for (const [name, g] of Object.entries(gsrc)) meshes.push([name, g]);
    else parts.signs?.group?.traverse((m) => { if (m.isMesh && /^signs-/.test(m.name) && m.geometry?.attributes?.position) meshes.push([m.name, m.geometry]); });
    if (meshes.length) {
      const W = new GLBWriter('One Take FPV tools/export-seoul-data.mjs', { meshopt });
      for (const [name, g] of meshes.sort(([a], [b]) => (a < b ? -1 : 1))) {
        const attrs = {}; for (const [k, a] of Object.entries(g.attributes)) attrs[k] = { array: attrArray(a), itemSize: a.itemSize, normalized: a.normalized };
        // [P4 H, native #4] packed like world.glb, but the triangle order is kept (layered sign faces); instanced
        // attributes (screens: per-panel rows) cannot share the vertex stream: those meshes stay plain
        const n = g.attributes.position.count, flat = Object.values(g.attributes).every((a) => a.count === n && !a.isInstancedBufferAttribute);
        if (meshopt && flat) { const r = W.meshPacked(name, attrs, g.index ? g.index.array : null, { extras: { kind: 'signs', bucket: name } }, { dedupe: false, reorder: 'fetch', index: 'TRIANGLES', quant: PACK.quant(attrs), verify: MDEC }); for (const p of r.problems || []) warn(`signs.glb packing: ${p}`); }
        else W.mesh(name, attrs, g.index ? g.index.array : null, { extras: { kind: 'signs', bucket: name } });
      }
      extraFiles['signs.glb'] = W.toGLB();
      data.signs.glb = { file: 'signs.glb', meshes: meshes.map(([n, g]) => ({ name: n, vertices: g.attributes.position.count })) };
    }
  } catch (e) { warn(`signs.glb: ${e.message}`); }

  // ---- light.json [P3 H, native #2]: D's live controller (world.parts.light.exportData(): model, grid, baked volume) plus
  // its GPU tables as binary files (light/*.bin), else a module-level exportData, else the shim
  const lctl = typeof parts.light?.exportData === 'function' ? parts.light : null;
  const dx = lctl ? () => lctl.exportData() : exporterOf(lightMod);
  let light = null;
  if (dx) {
    try { const r = await dx(layout, ctx); light = r?.['light.json'] ?? r; if (light && lctl) light = { ...(await lightTables(light, lctl, files)), source: 'seoul-light attach() -> exportData() (live controller, headless)' };
      if (light && lctl) { light.lightmap = await lightmapFile(root, lctl, files, layoutSha); if (light.lightmap.status) warn(`light lightmap: ${light.lightmap.note}`); } }
    catch (e) { warn(`seoul-light exportData() threw: ${e.stack || e.message}; using the shim`); light = null; }
  }
  else note('seoul-light has no exportData() yet (D, native #2): light.json from the shim');
  light ||= lightShim(parts, X[PARTNERS.light] || {}, lightMod);
  if (light) { await put('light.json', light); data.light = { file: 'light.json', count: light.count ?? 1, source: light.source ?? 'seoul-light exportData()', ...(light.lightmap ? { lightmap: light.lightmap.status ? `${light.lightmap.status}${light.lightmap.file ? ' (' + light.lightmap.file + ')' : ''}` : light.lightmap.file, lightmapKey: light.lightmap.key ?? null } : {}) }; } else data.light = { status: 'pending', count: 0 };

  // ---- life.json
  const gx = exporterOf(lifeMod);
  let life = null;
  if (gx) { try { const r = await gx(layout, ctx); life = r?.['life.json'] ?? r; } catch (e) { warn(`seoul-life exportData() threw: ${e.message}; using the shim`); } }
  else note('seoul-life has no exportData() yet (G, native #2): life.json from the shim');
  try { life ||= lifeShim(parts, X[PARTNERS.life] || {}, lifeMod, layout, parts.life?.sim?.traffic?.seed ?? seed); } catch (e) { warn(`life.json shim: ${e.message}`); }
  if (life) { await put('life.json', life); data.life = { file: 'life.json', count: life.count ?? 1, source: life.source ?? 'seoul-life exportData()' }; } else data.life = { status: 'pending', count: 0 };

  // ---- dressing.json (E's set pieces arrive through C's buildGeometry, contract P2-1)
  const ex = exporterOf(dressMod);
  let dressing = null;
  if (ex) { try { const r = await ex(layout, ctx); dressing = r?.['dressing.json'] ?? r; } catch (e) { warn(`seoul-dressing exportData() threw: ${e.message}`); } }
  if (!dressing && (geo.setPieces || dressMod)) dressing = { format: 'onetake.dressing/1', source: 'geometry entry setPieces (contract P2-1)', count: (geo.setPieces || []).length, setPieces: geo.setPieces || [], runtime: dressMod ? 'seoulDressing.build(layout, ctx): cable renderer (screen-space lines >= 1.25 px) and animated bits' : null };
  if (dressing) { await put('dressing.json', dressing, ['setPieces']); data.dressing = { file: 'dressing.json', count: dressing.count ?? (dressing.setPieces || []).length, source: dressing.source }; }
  else { data.dressing = { status: 'pending', count: 0, note: 'seoul-dressing.js (E) not in this tree; C merges its geometry into buildGeometry' }; }

  // ---- atlases and fonts the runtime paints with [P3 H, native #2]: B's MSDF glyph atlas, C's interior atlas, the fonts of
  // the Canvas2D atlases (screens / scrollers: B; E's labels, whose cells are dressing.json labels)
  try { data.atlases = await atlasFiles(root, files, mods, data.dressing); } catch (e) { warn(`atlases: ${e.stack || e.message}`); }

  // ---- [P4 H, native #2] phase 3's content: avatars, dressing card textures, menu art (whole folders, as fetched)
  try { data.content = await contentFiles(root, files, assetMap); } catch (e) { warn(`content: ${e.stack || e.message}`); }

  // ---- look.json
  const look = await lookOf(root, X, L, note);
  if (look) { await put('look.json', look); data.look = { file: 'look.json', via: look.via }; }

  // ---- inputs copied as is (the port reads the same layout / lines the generator did)
  for (const f of ['layout.json', 'lines.json']) if (existsSync(join(root, 'seoul', f))) files[f] = readFileSync(join(root, 'seoul', f));
  data.inputs = { layout: existsSync(join(root, 'seoul/layout.json')) ? 'layout.json (contract L1)' : null, lines: existsSync(join(root, 'seoul/lines.json')) ? 'lines.json (take lines, F1)' : null };

  // ---- textures (native #4)
  const tm = textureManifest(root, ws.SEOUL_MATS);
  for (const p of tm.problems) warn(`textures: ${p}`);
  for (const p of tm.missing || []) note(`textures: ${p}`);
  const textures = { dir: 'tex/', manifest: tm.manifest ? 'tex/textures.json' : null, files: {} };
  for (const [f, b] of Object.entries(tm.files)) { files['tex/' + f] = b; const e = tm.manifest.files[f]; textures.files[f] = { id: e.id, map: e.map, mats: e.mats, size: e.size, codec: e.codec, colorSpace: e.colorSpace, mips: e.mips }; }
  if (tm.manifest) { files['tex/textures.json'] = readFileSync(join(root, TEX_DIR, 'textures.json')); textures.orientation = tm.manifest.orientation; textures.transcode = tm.manifest.transcode; textures.license = tm.manifest.license; }

  for (const [k, v] of Object.entries(extraFiles)) {
    if (v instanceof Uint8Array || Buffer.isBuffer(v)) files[k] = v;
    else if (v?.data && v.width && v.height) files[k] = (await import('./png.mjs')).encodePNG(v.data, v.width, v.height);
    else files[k] = await jsonText(v);
  }
  // ---- [P4 H, native #2] asset coverage: every repo file a Seoul module (or the level entry) fetches is in `files`
  const mods2 = ['world-seoul.js', ...readdirSync(root).filter((f) => /^seoul-.*\.js$/.test(f)).sort(), 'seoul/signs/msdf-meta.js', { name: 'levels.json#' + L.id, src: JSON.stringify(L) }];
  data.assets = assetCoverage(root, files, mods2, warn);
  if (Object.keys(PACKED).length) data.packed = { codec: 'meshopt vertex codec v0 (EXT_meshopt_compression ATTRIBUTES): lossless; decode each file to `decodedBytes` with meshopt_decodeVertexBuffer(dst, count, stride, src); the file\'s own descriptor (light.json) gives the decoded format', files: { ...PACKED } };
  return { files, data, textures, coverage: SEOUL_COVERAGE, coverageObjects: ['Mesh', 'Points', 'Line'], runtimeOnly: SEOUL_RUNTIME_ONLY, scene: world?.scene || null, world, assetMap };
}

// ================================================================================================================
// CLI
// ================================================================================================================
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const done = (p) => p.then((r) => process.exit(r?.ok === false ? 1 : 0), (e) => { console.error(e); process.exit(2); });
  if (a.includes('-h') || a.includes('--help')) { console.log('usage: node tools/export-seoul-data.mjs [--out DIR] [--seed N] [--check] | --textures | --vendor-textures [--src DIR] [--only id,...]'); process.exit(0); }
  if (a.includes('--vendor-textures')) done(vendorTextures({ src: opt('--src') ?? process.env.ONETAKE_PH_DIR, only: opt('--only')?.split(',') ?? null }));
  else if (a.includes('--textures')) done((async () => {
    const { SEOUL_MATS } = await import(pathToFileURL(join(ROOT, 'world-seoul.js')).href);
    const t = textureManifest(ROOT, SEOUL_MATS);
    for (const m of t.missing || []) console.log('note ' + m);
    console.log(t.problems.length ? t.problems.map((p) => 'FAIL ' + p).join('\n') : `ok   ${Object.keys(t.files).length} KTX2 maps match textures.json${t.missing?.length ? '' : ' and cover SEOUL_MATS'} (${(Object.values(t.files).reduce((s, b) => s + b.length, 0) / 1e6).toFixed(2)} MB)`);
    return { ok: !t.problems.length };
  })());
  else done((async () => {   // data only = exportLevel's data files (same code path), written to --out
    const { exportLevel } = await EW();
    return exportLevel({ id: 'seoul-hongdae', out: opt('--out') ? resolve(opt('--out')) : undefined, seed: opt('--seed') != null ? +opt('--seed') : undefined, check: a.includes('--check'), dataOnly: true });
  })());
}
