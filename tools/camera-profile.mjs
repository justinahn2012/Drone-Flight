// tools/camera-profile.mjs — write camera.json: the FPV camera model (lens, shutter, rolling shutter, jello, tone /
// colour, auto-exposure, bloom, grain), resolved per world type exactly as the game sets it up, for the native port
// and for golden tests.
//
//   node tools/camera-profile.mjs              writes camera.json to the repo root
//   node tools/camera-profile.mjs --out DIR    ...to DIR instead
//
// How each look is resolved (mirrors main.js):
//   new FPVCamera -> setHDR(true|false) (applies GRADES.hdr|ldr) -> the main.js look line for that world type
//   (`Object.assign(fpv.look, {...})` after fpv.setHDR, evaluated per sky) -> applySettings() defaults (lens, shutter,
//   samples from DEF + QUALITY). If FPVCamera has profile() (contract C5, stream D) its output is stored per look too.
// main.js can't be imported in node (DOM at top level), so its constants are lifted from the source text; anything
// that can't be found is reported under `warnings` and the field is null.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exposeAndImport, sourceLiteral, evalLiteral } from './expose.mjs';
import { plain, stringify } from './export-world.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CAMERA_FORMAT = 'onetake.camera/1';
// output sizes the lens solve is tabulated at (the Swift port checks its computeLens against these)
export const SOLVE_SIZES = [[1920, 1080], [2868, 1320], [1320, 2868], [1080, 1920], [1080, 1080]];

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The first `Object.assign(fpv.look, ...)` call within ~1.2 kB after `anchor` in src: -> its argument list '(...)'. */
function lookLine(src, anchor) {
  const at = src.indexOf(anchor); if (at < 0) return null;
  const k = src.indexOf('Object.assign(fpv.look', at); if (k < 0 || k - at > 1200) return null;
  return sourceLiteral(src, '(', '(', k);
}

export async function cameraProfile({ root = ROOT, out = root, log = console.log } = {}) {
  const warnings = [], warn = (s) => { warnings.push(s); log('  warning: ' + s); };
  const mods = await exposeAndImport(root, { 'fpvcam.js': ['GRADES', 'JELLO_RATIO', 'JELLO_AXIS'] });
  const fc = mods['fpvcam.js'], X = fc.__G_EXPOSED || {};
  const { FPVCamera, LENSES, SHUTTERS } = fc;
  const { CRAFTS } = await import(pathToFileURL(join(root, 'flight.js')).href);
  const main = readFileSync(join(root, 'main.js'), 'utf8'), fsrc = readFileSync(join(root, 'fpvcam.js'), 'utf8');
  const constOf = (name) => {
    const t = sourceLiteral(main, `const ${name} =`, '{');
    if (!t) { warn(`main.js: const ${name} not found`); return null; }
    try { return evalLiteral(t, { Math }); } catch (e) { warn(`main.js: const ${name} did not evaluate: ${e.message}`); return null; }
  };
  const QUALITY = constOf('QUALITY'), STAB = constOf('STAB'), STAB_REPLAY = constOf('STAB_REPLAY'), DEF = constOf('DEF') || {};
  if (!X.GRADES) warn('fpvcam.js: GRADES not found');

  // the per-world-type look lines in main.js
  const hdrAt = main.indexOf('fpv.setHDR(true)'), ldrAt = main.indexOf('fpv.setHDR(false)');
  const hdrLine = lookLine(main, 'fpv.setHDR(true)'), ldrLine = lookLine(main, 'fpv.setHDR(false)');
  if (!hdrLine) warn('main.js: HDR look line (Object.assign(fpv.look, {...}) after fpv.setHDR(true)) not found: GRADES.hdr only');
  if (!ldrLine) warn('main.js: LDR look line not found: GRADES.ldr only');
  const nearFar = (from) => { const m = /fpv\.cam\.near\s*=\s*([\d.]+);\s*fpv\.cam\.far\s*=\s*([\d.]+)/.exec(main.slice(from)); return m ? { near: +m[1], far: +m[2] } : null; };
  const projHDR = hdrAt >= 0 ? nearFar(hdrAt) : null, projLDR = ldrAt >= 0 ? nearFar(ldrAt) : null;
  if (!projHDR) warn('main.js: HDR near/far not found');

  const lensKey = (l) => Object.keys(LENSES).find((k) => LENSES[k] === l) ?? null;
  const snapLook = (look) => { const o = plain({ ...look, lens: undefined }); o.lens = { key: lensKey(look.lens), ...plain(look.lens) }; return o; };
  const lensSolve = (cam) => ({ ...cam.lens, fovYDeg: cam.cam.fov, aspect: cam.cam.aspect, centerRatio: cam.centerRatio });

  // upper-case constants a look line refers to (e.g. a future `const HDR_LOOK = {...}` in main.js) are lifted too
  const liftConsts = (text) => Object.fromEntries([...new Set(text.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || [])]
    .filter((n) => main.includes(`const ${n} =`)).map((n) => [n, constOf(n)]));
  const resolveLook = (hdr, sky) => {
    const cam = new FPVCamera(null);
    cam.setHDR(hdr);
    const line = hdr ? hdrLine : ldrLine;
    if (line) {
      try { evalLiteral('Object.assign' + line, { Math, S: DEF, LENSES, SHUTTERS, ...liftConsts(line), fpv: cam, def: { sky, proc: hdr } }); }
      catch (e) { warn(`look line (${sky}) did not evaluate: ${e.message}`); }
    }
    // applySettings() defaults
    const q = QUALITY?.[DEF.quality || 'auto'];
    if (q) cam.look.maxSamples = q.samples;
    cam.look.lens = LENSES[DEF.lens] || LENSES.ref;
    cam.look.shutter = (SHUTTERS[DEF.shutter] || SHUTTERS.nd16).t;
    cam.outW = 1920; cam.outH = 1080; cam.computeLens();
    const r = { look: snapLook(cam.look), projection: (hdr ? projHDR : projLDR) ?? { near: cam.cam.near, far: cam.cam.far }, lens1080p: lensSolve(cam) };
    if (typeof cam.profile === 'function') { try { r.profile = plain(cam.profile()); } catch (e) { warn(`fpv.profile() threw: ${e.message}`); } }
    return r;
  };
  const hasProfile = typeof FPVCamera.prototype.profile === 'function';
  if (!hasProfile) log('  note: FPVCamera.profile() not present (stream D, contract C5): profile built from GRADES + look + lens constants');

  // lens solve table: every lens at every size
  const solve = [];
  for (const [w, h] of SOLVE_SIZES) for (const key of Object.keys(LENSES)) {
    const cam = new FPVCamera(null); cam.setHDR(true); cam.look.lens = LENSES[key]; cam.outW = w; cam.outH = h; cam.computeLens();
    solve.push({ outW: w, outH: h, lens: key, ...lensSolve(cam) });
  }

  // camera mount + uptilt (main.js rigCamera / defTilt)
  let tiltDeg = null;
  const dt = sourceLiteral(main, 'function defTilt(c)', '{');
  if (dt) {
    try {
      const f = new Function('c', 'S', 'Math', dt.slice(1, -1));
      tiltDeg = Object.fromEntries(Object.entries(CRAFTS).map(([k, c]) => [k, Object.fromEntries(['acro', 'angle', 'cine'].map((mode) => [mode, f(c, { mode }, Math)]))]));
    } catch (e) { warn('defTilt did not evaluate: ' + e.message); }
  } else warn('main.js: defTilt not found');
  const mount = /camPose\.pos\.copy\((?:drone\.pos|rigP)\)\.add\(_v\.set\(([^)]*)\)/.exec(main);
  if (!mount) warn('main.js: camera mount offset not found');

  const camera = {
    format: CAMERA_FORMAT,
    generator: 'tools/camera-profile.mjs',
    source: { 'fpvcam.js': { sha256: sha256(fsrc) }, 'main.js': { sha256: sha256(main) }, profileFn: hasProfile },
    conventions: {
      angles: 'radians unless the key ends in Deg; thetaS = half-angle across the viewport SHORT side',
      lens: 'r = F * tan(k*theta)/k (k: 1 rectilinear, 0.5 stereographic, ->0 equidistant); the scene is rendered rectilinear with tan half-extents (tx, ty) and remapped per pixel in the final pass; lateral CA scales r per channel by (1 -/+ ca)',
      colour: 'scene-linear HDR in (HDR worlds); wb / wbShade are linear RGB gains; EV values are log2 stops; clipEv = highlights hard-clip this many EV over the AE target',
      time: 'seconds; shutter = exposure time, readout = rolling-shutter top-to-bottom time',
    },
    looks: {
      sunny: resolveLook(true, 'sunny'),
      overcast: resolveLook(true, 'overcast'),
      ldr: resolveLook(false, 'splat'),
    },
    grades: plain(X.GRADES ?? null),
    lenses: Object.fromEntries(Object.entries(LENSES).map(([k, l]) => [k, { ...plain(l), thetaSDeg: l.thetaS * 180 / Math.PI }])),
    shutters: plain(SHUTTERS),
    lensSolve: {
      method: 'fpvcam.js computeLens(): fit a crop of a 16:9 sensor into the viewport (short half-side = 1); F = max(focal for thetaS on the short side, focal that caps the corner at cornerCapRad); thc = corner angle; render frustum tan = tan(thc) * frustumMargin split by (hw, hh)/rc',
      constants: { cornerCapRad: 1.16, frustumMargin: 1.035 },
      table: solve,
    },
    jello: {
      ratio: plain(X.JELLO_RATIO ?? null), axis: plain(X.JELLO_AXIS ?? null), freqClampHz: [10, 1000],
      model: 'per axis i: w = 2*pi*hz*ratio[i]; phase += w*dt (CPU, mod 2pi); amp = jelloAmp*vib*axis[i]*sinc(w*shutter/2); hz = motion.hz (motor rpm, ~170 hover .. ~430 full), vib from rigCamera',
    },
    exposure: { model: 'GPU auto-exposure on a 1/8-res metering target with lag (aeUp / aeDown, s^-1), clamped to [evMin, evMax]; HDR luma pre-scale 16; uWhite = 1 / (1 - exp(-1.25*0.24*expo*2^clipEv))' },
    bloom: { model: 'bright-pass at the 1/8 metering target, separable 9-tap gaussian at unit tap spacing, run twice; strength look.bloom (x8 on 8-bit targets)' },
    depthEncoding: { glsl: 'd = clamp(log2(max(vZ,0.02)/0.02)/12.28771238, 0, 1); rgba = (floor(d*255)/255, fract(d*255), 0, 1)', nearM: 0.02, farM: 0.02 * 2 ** 12.28771238, note: 'contract C2: what fpvcam.depthMat writes into depthRT for the shutter blur' },
    rig: {
      mountOffset: mount ? evalLiteral('[' + mount[1] + ']', {}) : null,
      mountNote: 'camera position = drone.pos + mountOffset rotated by the drone attitude (body frame: +x right, +y up, -z forward)',
      tiltDeg, camTiltDeg: Object.fromEntries(Object.entries(CRAFTS).map(([k, c]) => [k, c.camTilt])),
      hoverHz: Object.fromEntries(Object.entries(CRAFTS).map(([k, c]) => [k, c.hoverHz])),
      stabTau: STAB, stabReplaySigma: STAB_REPLAY,
      note: 'Cine also pitches the view with the climb / dive angle, looks down the tube in a vertical drop and counter-pitches the fast nods (flight.js camView, advanced in step()). Live stabilisation = slerp with time constant stabTau[setting]',
    },
    quality: QUALITY,
    defaults: { lens: DEF.lens ?? null, shutter: DEF.shutter ?? null, stab: DEF.stab ?? null, quality: DEF.quality ?? null, mode: DEF.mode ?? null, fps: DEF.fps ?? null },
    pipeline: [
      'scene: HDR half-float, MSAA (look.msaa) where RGBA16F multisampling exists; per-axis blur-aware render scale',
      'depth: the collider (or world.depthScene) at half res into depthRT, packed log depth (depthEncoding)',
      'blur: box shutter over look.shutter with rolling shutter (readout) + jello, up to look.maxSamples jittered taps, depth-aware silhouettes',
      'down: 1/8 res metering luma + bloom bright-pass',
      'meter: auto-exposure (exposure.model)',
      'bloom: 2 x separable 9-tap',
      'final: barrel lens + CA + vignette, WB / shade WB, tone curve (expo, clipEv, toe, lift), veil, sky / green selection, saturation, sharpen, grain (grainEv), letterbox',
    ],
    warnings,
  };
  mkdirSync(out, { recursive: true });
  const text = stringify(camera) + '\n';
  writeFileSync(join(out, 'camera.json'), text);
  log(`camera.json ${(text.length / 1e3).toFixed(1)} kB (${Object.keys(camera.looks).length} looks, ${solve.length} lens solves, profile() ${hasProfile ? 'used' : 'absent'}) -> ${out}`);
  return { ok: true, camera, warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), i = a.indexOf('--out');
  if (a.includes('-h') || a.includes('--help')) { console.log('usage: node tools/camera-profile.mjs [--out DIR] [--quiet]'); process.exit(0); }
  cameraProfile({ out: resolve(i >= 0 ? a[i + 1] : ROOT), log: a.includes('--quiet') ? () => {} : console.log })
    .then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(2); });
}
