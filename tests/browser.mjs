// tests/browser.mjs: the CI browser job (round 5, P5; native #2). Headless Chromium on SwiftShader (no GPU) loads the
// real game with ?perf and fails on anything a node test can't see:
//   1. any page error or console error while loading and flying (GLSL compile/link errors land here: three logs them
//      with console.error), and the load must reach the flying state;
//   2. the ?perf probe runs its segments (cruise, skim, carve, hover) and returns finite numbers;
//   3. coverage: every mesh in world.scene has an export entry in world.json (tests/coverage.js), and every world.glb
//      mesh is drawn;
//   4. the graffiti atlas came from the Worker and uploaded in strips (perf #1);
//   5. three golden stills (spawn, hall, chimney): luma p50 / p95 within tolerance of tests/golden.json;
//   6. [P5] (bando) a flight log recorded in this browser replays in node within 1 mm (tests/replay.mjs --log).
// Usage (repo root; needs `node tools/export-world.mjs --out exports` first):
//   node tests/browser.mjs [--exports exports] [--out browser-out] [--update] [--frames 3] [--size 480x270]
// --update rewrites tests/golden.json from this run (do it after an intentional look change; the commit shows it).
// [P3 H] Every run writes OUT/stills.json (the numbers the golden compares) and, for a level with a camera gate (Seoul),
// OUT/camgate/<shot>.png at the shipped grade plus <shot>.r0.png at retro 0 (one more frame), with the AE EV per shot,
// for tools/camgate.py (CI runs it after this). No 50-minute SwiftShader run to re-baseline: take stills.json from a CI
// artifact of the commit and
//   node tests/browser.mjs [--level ID] --golden-from browser-out-<ID>/stills.json     (writes the golden, no browser)
// Smoke runs (local, not CI): --skip perf,coverage  --shots walk0,club90  --camgate (camgate stills for any level)
// [P2 H] --level seoul-hongdae (native #3): the same job on another level of levels.json, loaded with ?level=ID. Exports
// default to exports/<ID> (node tools/export-world.mjs --level ID --out exports/<ID>); coverage applies that world.json
// (Seoul: city meshes, signs, screens, crowd, traffic, sky, steam... a mesh class with no export entry fails); ?perf runs
// the level's own segments (perf-levels.js); no graffiti check; stills from LEVEL_SHOTS against tests/golden-<ID>.json.
// Env: CHROME=/path/to/chrome (else Playwright's own Chromium: npx playwright install chromium),
//      ONETAKE_PH_DIR=dir of Poly Haven files (else fetched from dl.polyhaven.org), ONETAKE_TIMEOUT=s (default 900).
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const LEVEL = opt('--level', 'bando'), BANDO = LEVEL === 'bando';
const EXPORTS = resolve(ROOT, opt('--exports', BANDO ? 'exports' : `exports/${LEVEL}`)), OUT = resolve(ROOT, opt('--out', BANDO ? 'browser-out' : `browser-out-${LEVEL}`));
const GOLDEN_FROM = opt('--golden-from', null), SKIP = new Set((opt('--skip', '') || '').split(',').filter(Boolean)), ONLY = opt('--shots', null)?.split(',');
const UPDATE = a.includes('--update'), FRAMES = +opt('--frames', 1), [W, H] = opt('--size', '320x180').split('x').map(Number);
const TIMEOUT = 1000 * +(process.env.ONETAKE_TIMEOUT || 900), PH_DIR = process.env.ONETAKE_PH_DIR;
const GOLDEN = join(ROOT, 'tests', BANDO ? 'golden.json' : `golden-${LEVEL}.json`);
// smoke.py poses: tp(x, y, z, yawDeg, pitchDeg) and a velocity held for the 10 settle frames
const SHOTS = {
  spawn: ['o.tp(0,1.3,118,0,(4)-o.drone.c.camTilt)', [0, 0, -5]],
  hall: ['o.tp(10,2.4,22.2,-90,(-4)-o.drone.c.camTilt)', [10, 0, 0]],
  chimney: ['o.tp(-8,38,-22,0,-88)', [0, -12, 0]],
};
// [P2 H] Seoul: seoulsnap's shot set (walking street, club street, Exit 9), acro, exposure from the night look
const LEVEL_SHOTS = {
  'seoul-hongdae': {
    walk0: ['o.tp(-36,3,-23,0,(4)-o.drone.c.camTilt)', [0, 0, -3]],
    club90: ['o.tp(63.7,3,129.6,90,(4)-o.drone.c.camTilt)', [-3, 0, 0]],
    station: ['o.tp(31.8,8,-309,0,(0)-o.drone.c.camTilt)', [0, 0, -3]],
    // [P6 H, PLAN-P6 gates] the player's first frame: the game's own spawn (respawn to the start, F's pose and pitch), held
    // still. Last, so the three goldens above are shot exactly as before (respawn moves the take clock to a new city).
    spawn: ['o.respawn(true)', [0, 0, 0]],
  },
};
const SHOT_SET = Object.fromEntries(Object.entries(BANDO ? SHOTS : LEVEL_SHOTS[LEVEL] || {}).filter(([k]) => !ONLY || ONLY.includes(k)));
const ALLOW = [/favicon\.ico/];   // console errors that are not failures
const CAMGATE = { 'seoul-hongdae': true };   // [P3 H] levels whose stills feed tools/camgate.py (lossless PNG, retro 0 and shipped)
const TOL = { p50: 8, p95: 10 };
const HEAP_MAX = +(process.env.ONETAKE_HEAP_MAX || 450);   // [P5 D] MB, levels other than bando (perf #1, native #3)
// [P6 H, native #6 / perf #2 / perf #5] budgets as gates (Seoul): GL triangles per frame over every pass (WebGL hook,
// counted on each still's last frame), the largest single render target's share (the main pass), and the raw heap at
// 'settled' (before any GC: what Safari's ~1.5 GB tab has to hold). P5 (panel5 perf.md): 2.0-3.9 M, 0.8-2.0 M, 1005 MB.
const BUDGET = { tris: 2.6e6, mainTris: 1.3e6, rawSettledMB: +(process.env.ONETAKE_RAW_MAX || 700) };
function writeGolden(now, golden, src) {
  writeFileSync(GOLDEN, JSON.stringify({ note: 'tests/browser.mjs golden stills (SwiftShader, ' + `${W}x${H}, acro, scale 1.0, 10 frames of 33 ms after tp). Re-baseline with --update, or --golden-from <CI artifact>/stills.json, after an intentional look change.` + (src ? ` From ${src}.` : ''),
    shots: Object.fromEntries(Object.entries(now).map(([k, v]) => [k, { p5: v.p5, p50: v.p50, p95: v.p95, clip: v.clip, tol: golden.shots?.[k]?.tol || TOL }])) }, null, 1) + '\n');
  console.log(`wrote ${GOLDEN}`);
}
if (GOLDEN_FROM) {   // [P3 H] re-baseline from a CI artifact: no browser
  const st = JSON.parse(readFileSync(resolve(GOLDEN_FROM), 'utf8'));
  if (st.level && st.level !== LEVEL) { console.log(`FAIL ${GOLDEN_FROM} is level ${st.level}, not ${LEVEL}`); process.exit(1); }
  if (st.size && st.size !== `${W}x${H}`) { console.log(`FAIL ${GOLDEN_FROM} was shot at ${st.size}, not ${W}x${H}`); process.exit(1); }
  const inv = Object.entries(st.shots || {}).filter(([, v]) => v.up != null && v.up < -0.3).map(([k]) => k);
  if (inv.length) { console.log(`FAIL ${GOLDEN_FROM}: ${inv.join(', ')} shot with the craft upside down: not a golden`); process.exit(1); }
  writeGolden(st.shots, existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : { shots: {} }, `${GOLDEN_FROM.split(/[\/]/).slice(-2).join('/')}${st.commit ? ' @ ' + st.commit : ''}`);
  process.exit(0);
}

const MIME = { '.ktx2': 'image/ktx2', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.bin': 'application/octet-stream', '.otil': 'application/octet-stream', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const serveFile = (res, f) => { res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(readFileSync(f)); };
const server = createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const f = u.startsWith('/__exports/') ? join(EXPORTS, u.slice(11)) : join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) && !f.startsWith(EXPORTS)) { res.writeHead(403); res.end(); return; }
  if (existsSync(f) && statSync(f).isFile()) serveFile(res, f); else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port, BASE = `http://127.0.0.1:${PORT}`;

// CDN modules from node_modules when present (CI: ci/node_modules = the import map's versions), else the network
const NM = join(ROOT, 'node_modules');
const CDN = [['https://cdn.jsdelivr.net/npm/three@0.180.0/', join(NM, 'three')], ['https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.9.1/', join(NM, 'three-mesh-bvh')]];

let fails = 0;
const ok = (c, msg) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${msg}`); if (!c) fails++; return !!c; };
const errors = [];
mkdirSync(OUT, { recursive: true });
const t0 = Date.now(), sec = () => ((Date.now() - t0) / 1000).toFixed(0) + ' s';

const { chromium } = await import('playwright');   // [P3 H] dynamic: --golden-from needs no browser
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'] });   // [P5 D] precise heap
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(TIMEOUT);
  page.on('console', (m) => { if (m.type() === 'error' && !ALLOW.some((r) => r.test(m.text()))) errors.push(`[console.error] ${m.text().slice(0, 800)}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => { if (!/fonts\.g/.test(r.url())) errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !ALLOW.some((x) => x.test(r.url()))) errors.push(`[http ${r.status()}] ${r.url()}`); });
  await page.route('**/*', async (route) => {
    const u = route.request().url();
    for (const [pre, dir] of CDN) if (u.startsWith(pre)) { const f = join(dir, u.slice(pre.length).split('?')[0]); if (existsSync(f)) return route.fulfill({ path: f, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }); }
    if (PH_DIR && u.includes('dl.polyhaven.org')) { const f = join(PH_DIR, u.split('?')[0].split('/').pop()); if (existsSync(f)) return route.fulfill({ path: f, headers: { 'access-control-allow-origin': '*' } }); }
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return route.fulfill({ status: 200, body: '', contentType: 'text/css' });
    return route.continue();
  });
  // [P6 H] triangle counter: wraps the WebGL2 draw calls (and WEBGL_multi_draw, which three's BatchedMesh uses); counts only
  // while __tris.on (one frame per still), per bound draw framebuffer (null = the canvas)
  await page.addInitScript(() => {
    const T = window.__tris = { on: false, total: 0, draws: 0, fb: new Map() }, ids = new WeakMap(); let nid = 1;
    const tri = (m, n) => (m === 4 ? Math.floor(n / 3) : m === 5 || m === 6 ? Math.max(0, n - 2) : 0);
    const add = (gl, m, n, inst = 1) => { if (!T.on) return; const t = tri(m, n) * inst; T.total += t; T.draws++;
      const f = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING); let k = 0; if (f) { k = ids.get(f); if (!k) ids.set(f, (k = nid++)); } T.fb.set(k, (T.fb.get(k) || 0) + t); };
    const P = WebGL2RenderingContext.prototype, wrap = (o, name, f) => { const g = o[name]; if (g) o[name] = function (...a) { f(this, a); return g.apply(this, a); }; };
    wrap(P, 'drawArrays', (gl, a) => add(gl, a[0], a[2])); wrap(P, 'drawElements', (gl, a) => add(gl, a[0], a[1]));
    wrap(P, 'drawRangeElements', (gl, a) => add(gl, a[0], a[3]));
    wrap(P, 'drawArraysInstanced', (gl, a) => add(gl, a[0], a[2], a[3])); wrap(P, 'drawElementsInstanced', (gl, a) => add(gl, a[0], a[1], a[4]));
    const ge = P.getExtension;
    P.getExtension = function (n) {
      const x = ge.call(this, n), gl = this;
      if (x && n === 'WEBGL_multi_draw' && !x.__tris) {
        x.__tris = 1;
        const sum = (L, o, c, I, io) => { let t = 0; for (let i = 0; i < c; i++) t += L[o + i] * (I ? I[io + i] : 1); return t; };
        const many = (m, L, o, c, I, io) => { if (!T.on) return; for (let i = 0; i < c; i++) add(gl, m, L[o + i], I ? I[io + i] : 1); };
        wrap(x, 'multiDrawArraysWEBGL', (_, a) => many(a[0], a[3], a[4], a[5]));
        wrap(x, 'multiDrawElementsWEBGL', (_, a) => many(a[0], a[1], a[2], a[6]));
        wrap(x, 'multiDrawArraysInstancedWEBGL', (_, a) => many(a[0], a[3], a[4], a[7], a[5], a[6]));
        wrap(x, 'multiDrawElementsInstancedWEBGL', (_, a) => many(a[0], a[1], a[2], a[8], a[6], a[7]));
        void sum;
      }
      return x;
    };
  });
  await page.addInitScript((world) => localStorage.setItem('onetake.settings', JSON.stringify({ world, quality: 'auto', v: 3, mode: 'cine', hud: 'off' })), BANDO ? 'yard' : LEVEL);

  // ---- 1 + 2. load with ?perf, run the segments
  await page.goto(`${BASE}/index.html?perf=${FRAMES}&soak=0${BANDO ? '' : `&level=${encodeURIComponent(LEVEL)}`}`);
  const ready = await page.waitForFunction(() => window.__onetake?.perfReady === true || /failed/.test(document.getElementById('perfProbe')?.textContent || ''), null, { timeout: TIMEOUT, polling: 1000 }).then(() => true, () => false);
  const probeText = await page.evaluate(() => document.getElementById('perfProbe')?.textContent || '(no probe overlay)');
  if (!ready || !(await page.evaluate(() => window.__onetake?.perfReady === true))) {
    ok(false, `world did not load (${sec()}): ${probeText}\n     ${errors.join('\n     ')}`);
    throw new Error('load failed');
  }
  ok(await page.evaluate(() => window.__onetake.state === 'fly' || window.__onetake.state === 'crash'), `world loaded, flying (${sec()})`);
  if (!BANDO) ok(await page.evaluate(() => window.__onetake.levels?.loaded) === LEVEL, `level ${LEVEL} is the loaded world`);
  if (!SKIP.has('perf')) {
  const perf = await page.evaluate(() => window.__onetake.perfRun(0));
  const segOk = perf.scales.length === 2 && perf.scales.every((s) => perf.segments.every((n) => Number.isFinite(s.seg[n]?.p90) && Number.isFinite(s.seg[n]?.gpuP50)));
  ok(segOk && (BANDO ? perf.segments.length === 4 : perf.segments.length >= 3 && !perf.segments.includes('hover')), `?perf segments ${perf.segments.join(', ')} at ${perf.scales.map((s) => s.scale).join(' / ')} (${sec()}); ` +
    (BANDO ? `hover ${JSON.stringify(perf.hover)}` : `world.update ${perf.segments.map((n) => { const g = perf.scales[0].seg[n] || {}; return `${n} ${Number.isFinite(g.updP50) ? g.updP50.toFixed(1) + ' p50' : 'parts ' + JSON.stringify(g.parts || {})}`; }).join(', ')} ms`));
  writeFileSync(join(OUT, 'perf.json'), JSON.stringify(perf, null, 1));
  // [P4 H, perf #4] the shareable result: the update split reports (perf.js dropped it), the device block, a SHARE button,
  // and a digest small enough for a text message
  const sh = await page.evaluate(async () => { const m = await import('./perf.js'); const d = JSON.stringify(m.perfDigest(window.__onetake.perf)); return { len: d.length, btn: !!document.getElementById('perfShare') && document.getElementById('perfShare').style.display !== 'none', text: (window.__onetake.perfText || '').length }; });
  ok(perf.segments.every((n) => Number.isFinite(perf.scales[0].seg[n]?.updP50)) && perf.device?.at && sh.btn && sh.text > 0 && sh.len < 4000, `?perf result is shareable: updP50 per segment, device ${JSON.stringify(perf.device?.renderer || null)}, SHARE shown, digest ${sh.len} chars`);
  }

  // ---- [P5 D] native #3 / perf #1: the live JS heap once the level has settled (main.js heapMark 'settled', 10 s after the
  // build) <= HEAP_MAX MB, read after a forced GC (CDP), i.e. what a heap snapshot at 'settled' holds. The raw 'settled'
  // mark is printed beside it: it also counts the build's garbage until V8 next collects (phase 4: 877-946 raw, 407 live).
  if (!BANDO && !SKIP.has('heap')) {
    const st = await page.waitForFunction(() => window.__onetake.levels?.mem?.()?.steps?.find((s) => s.step === 'settled'), null, { timeout: 120000, polling: 1000 }).then((h) => h.jsonValue(), () => null);
    let gcMB = null; try { const cdp = await page.context().newCDPSession(page); await cdp.send('HeapProfiler.collectGarbage'); gcMB = await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576)); } catch (e) {}
    // [P6 H, native #6 / perf #5] the raw mark too: the build's peak garbage is what a phone tab must survive
    ok(Number.isFinite(st?.mb) && st.mb <= BUDGET.rawSettledMB, `budget: raw JS heap at settled ${st?.mb ?? '?'} MB <= ${BUDGET.rawSettledMB} MB (before any GC)`);
    ok(st && Number.isFinite(gcMB) && gcMB <= HEAP_MAX, `live JS heap at settled ${gcMB ?? '?'} MB <= ${HEAP_MAX} (raw mark ${st?.mb ?? '?'} MB before the GC; the build steps ${JSON.stringify(await page.evaluate(() => window.__onetake.levels.mem().steps.map((s) => [s.step, s.mb])))})`);
  }

  // ---- 3. coverage
  if (!SKIP.has('coverage') && ok(existsSync(join(EXPORTS, 'world.json')), `exports present (${EXPORTS})`)) {
    const { summarize } = await import('./coverage.js');
    const cov = await page.evaluate(async () => {
      const { coverage } = await import('/tests/coverage.js');
      const w = await (await fetch('/__exports/world.json')).json();
      return coverage(window.__onetake.world.scene, w);
    });
    writeFileSync(join(OUT, 'coverage.json'), JSON.stringify(cov, null, 1));
    // [P3 H] one line per class (the raw list, 900 KB on one line, cut the CI log short); the full list is in coverage.json
    ok(!cov.uncovered.length, `every scene mesh has an export entry (${cov.meshes} meshes; covered ${JSON.stringify(cov.byRule)})` + (cov.uncovered.length ? `\n     ${cov.uncovered.length} uncovered (coverage.json):\n     ` + summarize(cov).join('\n     ') : ''));
    ok(!cov.undrawnExports.length, `every world.glb mesh is drawn` + (cov.undrawnExports.length ? `: not drawn ${cov.undrawnExports.join(', ')}` : ''));
    ok(!cov.partialExports?.length, `every world.glb mesh drawn whole` + (cov.partialExports?.length ? `: in part ${cov.partialExports.map((p) => `${p.name} ${p.drawn}/${p.triangles} tris`).join(', ')}` : ''));
    if (cov.pending.length) console.log(`::warning::coverage pending (exporter waits on a contract): ${cov.pending.join(', ')} (${cov.pendingMeshes} meshes)`);
  }

  // ---- 4. graffiti from the worker (bando only)
  if (BANDO && !SKIP.has('coverage')) { const gu = await page.evaluate(async () => { const s = window.__onetake.world?.stats || window.__bandoStats || {}; for (let i = 0; i < 60 && !(s.graffitiUpload?.path && s.graffitiUpload.path !== 'pending'); i++) await new Promise((r) => setTimeout(r, 500)); return s.graffitiUpload || null; });
  ok(gu?.path === 'worker', `graffiti atlas drawn in the Worker, uploaded in strips: ${JSON.stringify(gu)}`); }

  // ---- 5. golden stills
  const golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : { shots: {} }, now = {}, gate = !!CAMGATE[LEVEL] || a.includes('--camgate');
  if (gate) mkdirSync(join(OUT, 'camgate'), { recursive: true });
  for (const [name, [tp, vel]] of Object.entries(SHOT_SET)) {
    const ts = Date.now();
    const shoot = () => page.evaluate(async ({ tp, vel, gate }) => {
      const o = window.__onetake; o.S.mode = 'acro'; o.applySettings(); o.fpv.setQualityRange?.(1, 1); o.fpv.scale = 1; o.controls.thr = 0.39;
      new Function('o', tp)(o);
      const cv = o.renderer?.domElement || document.querySelector('canvas');
      let url = null, png = null, png0 = null, ev = null, ev0 = null, retro = null; const fms = [];   // [P3 H] ms per step (where the still time goes)
      const evOf = () => { try { return o.fpv.readEv ? o.fpv.readEv(o.renderer) : null; } catch (e) { return null; } };
      for (let i = 0; i < 10; i++) {
        if (vel) o.drone.vel.set(vel[0], vel[1], vel[2]); o.controls.thr = 0.39;
        const T = window.__tris; if (T && i === 9) { T.total = 0; T.draws = 0; T.fb.clear(); T.on = true; }   // [P6 H] count the graded frame
        const f0 = performance.now(); o.step(33, 1, false); fms.push(Math.round(performance.now() - f0));
        if (T) T.on = false;   // = step(33, 1, i === 9): the grab below happens in the same task, before the buffer is presented
        if (i === 9) { url = cv.toDataURL('image/jpeg', 0.92); if (gate) png = cv.toDataURL('image/png'); }
        await new Promise((r) => setTimeout(r, 20));
      }
      if (gate) {   // camgate: the AE EV, then retro 0 (colour #6 rows at retro 0 and the shipped grade): one more frame
        ev = evOf(); retro = o.fpv.look?.retro ?? null;
        if (o.fpv.look) o.fpv.look.retro = 0;
        if (vel) o.drone.vel.set(vel[0], vel[1], vel[2]); o.controls.thr = 0.39;
        o.step(33, 1, false); png0 = cv.toDataURL('image/png'); ev0 = evOf();
        if (o.fpv.look) o.fpv.look.retro = retro;
      }
      const q = o.drone.q, up = 1 - 2 * (q.x * q.x + q.z * q.z);   // the craft's up . world up: < 0 = upside down
      const img = new Image(); img.src = url; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data, h = new Uint32Array(256);
      for (let i = 0; i < d.length; i += 4) h[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
      const n = d.length / 4, pct = (p) => { let s = 0; for (let k = 0; k < 256; k++) { s += h[k]; if (s >= p * n) return k; } return 255; };
      const T = window.__tris, tris = T ? { total: T.total, draws: T.draws, main: Math.max(0, ...T.fb.values()), passes: T.fb.size } : null;
      return { tris, url, png, png0, ev, ev0, retro, fms, up: +up.toFixed(3), p5: pct(0.05), p50: pct(0.5), p95: pct(0.95), clip: +(h[255] / n).toFixed(4) };
    }, { tp, vel, gate });
    // [P3 H] main bfe39b1's CI shot spawn upside down once (p50 83 against ~125 upright) and that became the golden:
    // an inverted craft is a harness state, not a look, so shoot it again once and say so
    let r = await shoot();
    if (r.up < -0.3) { console.log(`::warning::still ${name}: the craft was upside down (up ${r.up}); shooting it again`); r = await shoot(); }
    writeFileSync(join(OUT, `${name}.jpg`), Buffer.from(r.url.split(',')[1], 'base64'));
    if (r.png) writeFileSync(join(OUT, 'camgate', `${name}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
    if (r.png0) writeFileSync(join(OUT, 'camgate', `${name}.r0.png`), Buffer.from(r.png0.split(',')[1], 'base64'));
    now[name] = { p5: r.p5, p50: r.p50, p95: r.p95, clip: r.clip, up: r.up, ...(gate ? { ev: r.ev, ev0: r.ev0, retro: r.retro } : {}), ...(r.tris ? { tris: r.tris } : {}), s: +((Date.now() - ts) / 1000).toFixed(0), stepS: r.fms.map((x) => +(x / 1000).toFixed(1)) };
    if (!BANDO && r.tris?.draws) {   // [P6 H] budgets (Seoul): every pass, and the largest render target (the main pass)
      const M = (v) => (v / 1e6).toFixed(2);
      ok(r.tris.total <= BUDGET.tris, `budget ${name}: triangles ${M(r.tris.total)} M <= ${M(BUDGET.tris)} M (all passes, ${r.tris.draws} draws, ${r.tris.passes} targets)`);
      ok(r.tris.main <= BUDGET.mainTris, `budget ${name}: main pass ${M(r.tris.main)} M <= ${M(BUDGET.mainTris)} M (the largest render target)`);
    }
    const g = golden.shots[name];
    console.log(`  still ${name}: ${now[name].s} s, steps ${JSON.stringify(now[name].stepS)} s`);
    if (UPDATE || !g || SKIP.has('golden')) console.log(`  still ${name}: p5 ${r.p5} p50 ${r.p50} p95 ${r.p95} clip ${r.clip}${gate ? ` EV ${r.ev?.toFixed?.(2)}` : ''} (${now[name].s} s)${g ? '' : ' (no golden yet)'}`);
    else ok(Math.abs(r.p50 - g.p50) <= g.tol.p50 && Math.abs(r.p95 - g.p95) <= g.tol.p95,
      `still ${name}: p50 ${r.p50} (golden ${g.p50} ± ${g.tol.p50}), p95 ${r.p95} (golden ${g.p95} ± ${g.tol.p95}) (${now[name].s} s)` +
      (Math.abs(r.p50 - g.p50) <= g.tol.p50 && Math.abs(r.p95 - g.p95) <= g.tol.p95 ? '' : `\n     an intended look change? re-baseline: node tests/browser.mjs${BANDO ? '' : ' --level ' + LEVEL} --golden-from <this job's artifact>/stills.json`));
  }
  writeFileSync(join(OUT, 'stills.json'), JSON.stringify({ level: LEVEL, size: `${W}x${H}`, commit: process.env.GITHUB_SHA || null, shots: now }, null, 1) + '\n');
  if (UPDATE) writeGolden(now, golden, 'tests/browser.mjs --update');
  // ---- 6. [P5 H, native #1] a flight log recorded in this browser, replayed in node on the same world (browser -> node
  // parity every run; the committed tests/browser.otil went stale with every world change). ~6 s of flying from the
  // spawn on the keyboard path main.js logs (controls.keys -> poll -> the 240 Hz tick), then tests/replay.mjs --log.
  if (BANDO && !SKIP.has('otil')) {
    const rec = await page.evaluate(() => {
      const o = window.__onetake, K = o.controls.keys, run = (ms, keys) => { K.clear(); for (const k of keys) K.add(k); o.step(16.7, Math.round(ms / 16.7), false); };
      o.tp(0, 1.6, 118, 0, 0); run(100, []);
      run(1500, ['KeyW']); run(1200, ['KeyW', 'ArrowUp']); run(1200, ['KeyW', 'KeyA']); run(1000, ['ArrowDown', 'KeyD']); run(800, []);
      K.clear();
      const L = o.flight.log; if (!L || !L.ticks) return { ticks: 0 };
      const u8 = L.toBytes(); let bin = ''; for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192));
      return { ticks: L.ticks, b64: btoa(bin), pos: o.drone.pos.toArray().map((v) => +v.toFixed(2)) };
    });
    if (ok(rec.ticks > 240 * 4, `recorded a ${(rec.ticks / 240).toFixed(1)} s flight log in the browser (end ${JSON.stringify(rec.pos)})`)) {
      const lp = join(OUT, 'browser.otil'); writeFileSync(lp, Buffer.from(rec.b64, 'base64'));
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(process.execPath, [join(ROOT, 'tests/replay.mjs'), '--strict', '--log', lp], { cwd: ROOT, encoding: 'utf8' });
      const lines = (r.stdout || '').split('\n').filter((l) => l.includes('browser.otil'));
      ok(r.status === 0 && lines.some((l) => /continuous max error/.test(l)), `the browser's log replays in node on this world (tests/replay.mjs --log): ${lines.map((l) => l.replace(/^\s*(ok|FAIL)\s+/, '')).join(' | ').slice(0, 400) || (r.stdout || r.stderr || '').slice(-300)}`);
    }
  }
  ok(!errors.length, `no page / console / shader / request errors` + (errors.length ? `:\n     ${errors.join('\n     ')}` : ''));
} catch (e) {
  if (e.message !== 'load failed') { ok(false, `browser job threw: ${e.message}`); if (errors.length) console.log('     ' + errors.join('\n     ')); }
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `${fails} FAILED (${sec()})` : `all passed (${sec()})`);
process.exit(fails ? 1 : 0);
