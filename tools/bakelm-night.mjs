#!/usr/bin/env node
// tools/bakelm-night.mjs: Neon Seoul's shipped night lightmap (P4 stream D, perf #3). One command, from the repo root:
//
//   node tools/bakelm.mjs --night          (or node tools/bakelm-night.mjs)   ~20-40 s
//   options: --out FILE (default seoul/light/night-lm.bin)   --check (only report whether the committed file is current)
//
// Builds the level headless exactly as the game does (world-seoul.js buildSeoul: geometry, signs, life, dressing; the
// light's own wall packs), bakes the night lightmap in line (seoul-light.js attach, lightmapSync), packs it RGB9E5 and
// writes NIGHT_LM.file with the bake's key. The game fetches that file at load and uses it when the key matches its own
// inputs (emitters, layout, light-model constants); otherwise it bakes in a Worker as before. So: re-run this after
// any change to signs, buildings, dressing or the light model, and commit the file (tests/seoul-light.mjs warns when
// the committed file is stale).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const mod = (f) => import(pathToFileURL(path.join(ROOT, f)).href);

// the level as the browser builds it, without the light (attach is the caller's)
export async function buildNightWorld() {
  const THREE = await import('three'), ws = await mod('world-seoul.js');
  const P = THREE.ImageLoader.prototype, load0 = P.load; P.load = function (url) { return { src: url, width: 0, height: 0, headless: true }; };
  try { return await ws.buildSeoul(null, { seed: ws.SEOUL_SEED, takeClock: () => 0, quality: 'auto', light: false }); }
  finally { P.load = load0; }
}
// the same world the browser builds, with the lightmap baked in line
export async function bakeNight({ log = console.log } = {}) {
  const L = await mod('seoul-light.js'), N = await mod('seoul-nightlm.js');
  const t0 = Date.now();
  const world = await buildNightWorld();
  // seoul-light's attach as buildSeoul makes it (its ctx: layout, lotInfo, nitScale, quality), plus the in-line bake
  const ctl = L.attach(world, world.emitters, { layout: world.layout, lotInfo: world.lotInfo, nitScale: world.NITS, quality: 'auto', lightmap: true, lightmapSync: true, steam: false, airlight: false, reflect: false, cull: false });
  const d = ctl.lightmapData; if (!d) throw new Error('no lightmap: ' + JSON.stringify(ctl.stats.lightmap));
  const planes = N.lmPlanes(d.data, d.w, d.h), gz = zlib.gzipSync(planes, { level: 9 });
  const header = { key: d.key, w: d.w, h: d.h, version: N.NIGHT_LM.version, enc: 'rgb9e5 / 4 byte planes / row delta / gzip', texels: d.texels, emitters: world.emitters.length, wallPacks: ctl.stats.wallPacks, built: new Date().toISOString().slice(0, 10) };
  const file = N.lmFile(header, gz);
  log(`night lightmap: key ${d.key}, ${d.w} x ${d.h} RGB9E5 (${(d.w * d.h * 4 / 1048576).toFixed(1)} MB on the GPU), file ${(file.length / 1048576).toFixed(2)} MB, ${world.emitters.length} emitters, bake ${ctl.stats.lightmap.ms} ms, total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  ctl.dispose?.();
  return { file, header };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) || globalThis.__bakelmNight) {
  const N = await mod('seoul-nightlm.js');
  const out = path.resolve(ROOT, arg('--out', N.NIGHT_LM.file));
  const { file, header } = await bakeNight();
  if (argv.includes('--check')) {
    const cur = fs.existsSync(out) ? N.lmFileHeader(fs.readFileSync(out)) : null;
    console.log(cur?.header?.key === header.key ? `current: ${path.relative(ROOT, out)} matches (${header.key})` : `STALE: ${path.relative(ROOT, out)} has ${cur?.header?.key || 'nothing'}, this build ${header.key}`);
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, file);
  console.log(`wrote ${path.relative(ROOT, out)}`);
  process.exit(0);
}
