// main.js — One Take FPV: world loading, game loop, scoring, clips, UI.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH } from 'three-mesh-bvh';
import { FPVCamera, LENSES, SHUTTERS } from './fpvcam.js';
import { Drone, CRAFTS } from './flight.js';
import { Controls } from './controls.js';
import { MotorAudio } from './audio.js';
import { Take, defaultTakeUI } from './take.js';
import * as TakeLib from './take.js';   // F1: TAKE_TUNING (cutT/bankT/stars) for the HUD, read live; a namespace import never fails on a missing name

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const WORLDS = [
  { id: 'yard', name: 'Silo Yard', note: 'Open bando · silos, chimney, factory hall · sunny', craft: 'freestyle5', proc: true, sky: 'sunny' },
  { id: 'yard-overcast', name: 'Silo Yard · Overcast', note: 'Same site under flat grey sky', craft: 'freestyle5', proc: true, sky: 'overcast' },
];
const QUALITY = {
  low: { dpr: 1.25, min: 0.5, max: 0.85, samples: 8, std: Math.sqrt(5) },
  auto: { dpr: 1.6, min: 0.55, max: 1.0, samples: 14, std: Math.sqrt(5.5) },
  high: { dpr: 2.0, min: 0.65, max: 1.12, samples: 20, std: Math.sqrt(7) },
};
// Live display lag (s) per stabilisation setting. 'heavy' is replay-only: live it behaves like 'light' (a 90 ms lag
// makes acro pilots over-correct into oscillations); clips get its extra smoothing in the replay path (STAB_REPLAY,
// Gaussian sigma in s, for the Gyroflow-style pass over the replay quaternions).
const STAB = { off: 0, light: 0.03, heavy: 0.03 };
const STAB_REPLAY = { off: 0, light: 0.06, heavy: 0.12 };

// ---------------- settings
const DEF = { v: 3, world: 'yard', mode: 'cine', craft: 'auto', shutter: 'nd16', lens: 'ref', stab: 'light', tilt: -1, frame: 'full', quality: 'auto', splats: '500k', fps: '60', hud: 'osd', sound: 'on', game: 'take', caps: 'on' };
let S = { ...DEF };
try { const saved = JSON.parse(localStorage.getItem('onetake.settings') || '{}'); if (saved.v !== 3) { delete saved.tilt; delete saved.world; saved.v = 3; } Object.assign(S, saved); } catch (e) {}
if (!['yard', 'yard-overcast', 'url'].includes(S.world)) S.world = 'yard';   // a saved 'file' world can't reload (the file input is empty): no dead-end FLY
if (S.hud === 'on') S.hud = 'osd';                                            // overlay is now OSD | Minimal | Clean
if (!['take', 'free'].includes(S.game)) S.game = 'take';
if (!['on', 'mix', 'off'].includes(S.sound)) S.sound = 'on';                 // C6: On | Mix with music | Off
const save = () => { try { localStorage.setItem('onetake.settings', JSON.stringify(S)); } catch (e) {} };
const params = new URLSearchParams(location.search);
const DEV = params.has('dev');                        // developer items (own-world splats, splat density) only under ?dev
document.body.classList.toggle('dev', DEV);
if (params.get('splat')) {
  WORLDS.unshift({ id: 'url', name: params.get('name') || 'Your World', note: 'From link', craft: params.get('craft') || 'freestyle5', splat: params.get('splat'), collider: params.get('collider') || null, flip: params.get('flip') !== '0' });
  S.world = 'url';
}

// ---------------- renderer & scenes
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
renderer.setPixelRatio(1);
renderer.autoClear = false;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const splatScene = new THREE.Scene();
// Spark (Gaussian splats) only loads for custom splat worlds
let spark = null, SplatMesh = null;
async function ensureSpark() {
  if (spark) return;
  const mod = await import('@sparkjsdev/spark');
  SplatMesh = mod.SplatMesh;
  spark = new mod.SparkRenderer({ renderer, maxStdDev: QUALITY[S.quality].std });
  splatScene.add(spark);
  // Splats are trained (and blended) in display/sRGB space. Spark converts to linear whenever it renders
  // into an offscreen target; pin it to sRGB so our buffer matches the capture and keeps 8-bit shadow precision.
  try { Object.defineProperty(spark.uniforms.encodeLinear, 'value', { get: () => false, set: () => {} }); } catch (e) { console.warn('encodeLinear pin failed', e); }
}
const fpv = new FPVCamera(renderer);
const world = { scene: null, splatScene, colliderScene: null, bvh: null, mesh: null, bounds: null, spawn: new THREE.Vector3(), yaw: 0, def: null, lastDist: Infinity };
const drone = new Drone('freestyle5');
const audio = new MotorAudio();
const controls = new Controls({
  view: $('view'), radio: $('radio'), leftWell: $('wL'), rightWell: $('wR'), leftTop: $('tL'), rightTop: $('tR'), floatL: $('fL'), floatR: $('fR'),
});

let state = 'menu';        // menu | loading | fly | crash | replay
let loadedId = null;

// ---------------- layout
function layout() {
  const W = window.innerWidth, H = window.innerHeight;
  const portrait = H > W * 1.05;
  document.body.classList.toggle('portrait', portrait);
  let vh = H;
  if (portrait) vh = Math.round(Math.min(H * 0.6, W * 1.25));   // 4:5 view, the radio gets the rest
  $('view').style.height = vh + 'px';
  $('radio').style.top = vh + 'px';
  $('radio').style.setProperty('--radioH', (H - vh) + 'px');
  $('ghost').style.setProperty('--R', Math.round(Math.min(95, H * 0.2)) + 'px');   // same throw as the landscape floating sticks
  const q = QUALITY[S.quality];
  const dpr = Math.min(window.devicePixelRatio || 1, q.dpr);
  const w = Math.round(W * dpr), h = Math.round(vh * dpr);
  renderer.setSize(w, h, false);
  canvas.style.width = W + 'px'; canvas.style.height = vh + 'px';
  fpv.resize(w, h);
  menuFrames = 0;
  viewW = W; viewH = vh;   // CSS px of #view: the OSD chevron projects into it
}
let viewW = 1, viewH = 1;
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => { controls.cancelAll?.(); setTimeout(layout, 250); });   // stale touches = instant full stick

const MODE_HINT = {
  cine: 'Easiest on a phone. Right thumb: push for speed, left/right to carve. Left thumb: climb and turn. Let go and it brakes to a hover.',
  angle: 'Self-levelling with manual throttle. Left stick up/down is throttle; the orange tick on the OSD bar marks hover.',
  acro: 'Expert · best with a gamepad or USB radio. Sticks command rotation rates (Betaflight Actual 200 · 720 · 0.55). No self-levelling.',
};
// take rules for the copy, read live from C's TAKE_TUNING (cutT 3.0 / bankT 5.0 at integration)
const TT = () => TakeLib.TAKE_TUNING || {};
const secs = (v, d) => { const x = +v > 0 ? +v : d; return (Math.round(x * 10) / 10).toString(); };
// C: CUT = 3 s hands-off hover, or 0.6 s touched down (TAKE_TUNING.cutT / landT)
const cutRule = () => `let go and hover for ${secs(TT().cutT, 3)} s, or touch down for ${secs(TT().landT, 0.6)} s,`;
const GAME_HINT = {
  take: () => `One take: fly through named lines to build FLOW. ${secs(TT().bankT, 5)} s without a line banks it; a crash loses what isn't banked. To CUT, ${cutRule().replace(/,$/, '')}.`,
  free: () => 'No clock, no take. Lines still caption. Crash and you fly on from where you last flew clear.',
};
const STICK_LBL = { cine: ['CLIMB · TURN', 'SPEED · CARVE'], angle: ['THROTTLE · YAW', 'PITCH · ROLL'], acro: ['THROTTLE · YAW', 'PITCH · ROLL'] };
function applySettings() {
  const q = QUALITY[S.quality];
  fpv.setQualityRange(q.min, q.max);
  fpv.look.maxSamples = q.samples;
  if (spark) spark.maxStdDev = q.std;
  fpv.look.lens = LENSES[S.lens] || LENSES.ref;
  fpv.look.shutter = (SHUTTERS[S.shutter] || SHUTTERS.nd16).t;
  fpv.look.letterbox = S.frame === 'cine' ? 0.5 - (fpv.outW / fpv.outH) / 2.39 / 2 : 0;
  if (S.frame === 'cine' && fpv.look.letterbox < 0) fpv.look.letterbox = 0;
  fpv.targetMs = S.fps === '30' ? 33.3 : 16.7;
  controls.mode = S.mode;
  audio.on = S.sound !== 'off';
  // C6: 'mix' = ambient audio session (other apps' music keeps playing). F2 implements the switch in audio.js.
  audio.setSession?.(S.sound === 'mix' ? 'ambient' : 'playback');
  const B = document.body.classList;
  B.toggle('nohud', S.hud === 'off'); B.toggle('hud-min', S.hud === 'min'); B.toggle('thr', S.mode !== 'cine');
  $('rMode').textContent = { cine: 'CINE', angle: 'ANGLE', acro: 'ACRO' }[S.mode];
  const [ll, rl] = STICK_LBL[S.mode] || STICK_LBL.cine;
  $('lblL').textContent = ll; $('lblR').textContent = rl; $('gLt').textContent = ll; $('gRt').textContent = rl;
  $('modeHint').textContent = MODE_HINT[S.mode];
  $('gameHint').textContent = GAME_HINT[S.game]?.() || '';
  const craftKey = craftFor(world.def);
  if (drone.key !== craftKey) { drone.setCraft(craftKey); }
  audio.setCraft?.(craftKey);
  if (!audio.on) audio.idle?.();
  const tilt = S.tilt >= 0 ? S.tilt : defTilt(CRAFTS[craftKey]);
  $('tilt').value = tilt; $('tiltV').textContent = tilt + '°';
  fpv.computeLens();
  syncSegs();
  save();
  menuFrames = 0;   // paused: re-render one frame so the frozen view shows the new settings
}
const craftFor = (def) => (S.craft !== 'auto' ? S.craft : def?.craft || 'freestyle5');

// ---------------- menu UI
function buildWorlds() {
  // one Silo Yard card (Sky = Sun | Overcast seg inside it); link/dev worlds below
  $('yardCard').classList.toggle('on', S.world === 'yard' || S.world === 'yard-overcast');
  const box = $('worlds'); box.innerHTML = '';
  for (const w of WORLDS) {
    if (w.proc) continue;
    const b = document.createElement('button');
    b.className = 'world' + (w.id === S.world ? ' on' : '');
    b.innerHTML = `<b>${esc(w.name)}</b><small>${esc(w.note)} · ${CRAFTS[w.craft]?.label || ''}</small>`;
    b.onclick = () => { S.world = w.id; buildWorlds(); $('custom').classList.remove('open'); save(); };
    box.appendChild(b);
  }
  if (DEV) {
    const c = document.createElement('button');
    c.className = 'world custom' + (S.world === 'file' ? ' on' : '');
    c.innerHTML = `<b>Your own world</b><small>Load a splat + collider from this device</small>`;
    c.onclick = () => { S.world = 'file'; buildWorlds(); $('custom').classList.add('open'); };
    box.appendChild(c);
  }
}
$('yardCard').addEventListener('click', (e) => {
  if (e.target.closest('.seg')) return;
  if (S.world !== 'yard' && S.world !== 'yard-overcast') { S.world = 'yard'; buildWorlds(); syncSegs(); $('custom').classList.remove('open'); save(); }
});
function syncSegs() {
  document.querySelectorAll('.seg[data-key]').forEach((seg) => {
    const key = seg.dataset.key;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(S[key]) === b.dataset.v));
  });
}
document.querySelectorAll('.seg[data-key]').forEach((seg) => {   // settings segments only (START AT is a .seg without data-key)
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const key = seg.dataset.key; const prev = S[key];
    S[key] = b.dataset.v;
    if (key === 'quality') layout();
    if (key === 'craft' && state !== 'menu') respawn();
    if (key === 'world') { buildWorlds(); $('custom').classList.remove('open'); }
    applySettings();
    if (key === 'splats' && prev !== S[key]) loadedId = null;
  });
});
$('tilt').addEventListener('input', (e) => { S.tilt = +e.target.value; $('tiltV').textContent = S.tilt + '°'; save(); });
$('openSet').onclick = () => { const st = $('settings'); st.classList.toggle('hidden'); if (!st.classList.contains('hidden')) setTimeout(() => st.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); };
$('fly').onclick = () => startFlight(true);
$('resume').onclick = () => startFlight(false);
$('btnMenu').onclick = () => openMenu();

// tap vs long-press (pointer events; touches on .ui never reach the sticks)
function press(el, tap, hold, ms = 600) {
  let tm = null, fired = false;
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); fired = false; clearTimeout(tm); tm = setTimeout(() => { fired = true; tm = null; hold?.(); }, ms); });
  el.addEventListener('pointerup', () => { if (tm === null) return; clearTimeout(tm); tm = null; if (!fired) tap?.(); });
  const cancel = () => { clearTimeout(tm); tm = null; };
  el.addEventListener('pointercancel', cancel); el.addEventListener('pointerleave', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
const canReset = () => state === 'fly' || state === 'crash';
// RESET = back to the last safe point; hold = back to the start
const doReset = () => { if (canReset()) respawn(false); };
const doStart = () => { if (canReset()) { respawn(true); toast('BACK TO START'); } };
press($('rReset'), doReset, doStart);
press($('btnReset'), doReset, doStart);
// portrait mode button: hold 0.5 s, toggles Cine <-> Angle only (Acro lives in the menu)
press($('rMode'), () => toast('HOLD TO SWITCH CINE / ANGLE'), () => {
  S.mode = S.mode === 'cine' ? 'angle' : 'cine'; applySettings(); controls.resetThrottle(Math.sqrt(1 / drone.c.twr)); toast(S.mode === 'cine' ? 'CINE ASSIST' : 'ANGLE');
}, 500);
$('rClip').onclick = () => saveClip();
$('btnClip').onclick = () => saveClip();   // landscape in-flight CLIP (UX #4); what it exports is F2's saveClip
$('cReset').onclick = () => respawn();
$('cClip').onclick = () => saveClip();
$('recCancel').onclick = () => { if (replay) { endReplay(true); toast('CLIP CANCELLED'); } };
controls.onButton = (b) => { if (b === 'reset' && (state === 'fly' || state === 'crash')) respawn(false); if (b === 'menu') state === 'menu' ? startFlight(false) : openMenu(); };

function openMenu() {
  if (state === 'replay') return;
  if (state === 'fly' || state === 'crash') prevState = state;
  state = 'menu';
  $('menu').classList.remove('hidden');
  // paused: RESUME is the hot button, FLY becomes a ghost RESTART
  const paused = !!loadedId;
  document.body.classList.toggle('paused', paused);
  $('resume').classList.toggle('hidden', !paused);
  $('fly').className = paused ? 'ghost' : 'hotbtn';
  $('fly').textContent = paused ? 'Restart' : 'FLY';
  $('resume').parentNode.insertBefore(paused ? $('resume') : $('fly'), paused ? $('fly') : $('resume'));
  renderProgress();
  $('menu').scrollTop = 0;   // paused: START AT + LINES are what you see first
  controls.enabled = false;
  controls.cancelAll?.();
  menuFrames = 0;
  setTimeout(() => { if (state === 'menu') audio.idle?.(); }, 250);   // after the mute fade: stop the audio thread
}
let prevState = 'fly';

async function startFlight(fresh) {
  audio.start();
  armBack();
  warmFonts();
  const want = S.world;
  const wantKey = want === 'file' ? 'file:' + ($('fSplat').files[0]?.name || '') : want + ':' + S.splats;
  if (fresh || loadedId !== wantKey) {
    let def;
    if (want === 'file') {
      const f = $('fSplat').files[0];
      if (!f) { toast('CHOOSE A SPLAT FILE FIRST (.SPZ / .PLY)'); return; }
      const cf = $('fCol').files[0];
      def = { id: 'file', name: f.name, craft: 'freestyle5', splatFile: f, colliderFile: cf || null, flip: true };
    } else def = WORLDS.find((w) => w.id === want) || WORLDS[0];
    if (loadedId !== wantKey) {
      const ok = await loadWorld(def);
      if (!ok) return;
      loadedId = wantKey;
    }
    respawn(true);
  } else {
    state = prevState === 'crash' ? 'crash' : 'fly';
  }
  $('menu').classList.add('hidden');
  document.body.classList.remove('paused');
  controls.enabled = true;
  if (state !== 'crash') state = 'fly';
  coachStart(fresh);
}

// ---------------- loading
const STICK_COACH = {
  cine: [['LEFT THUMB', 'climb · turn'], ['RIGHT THUMB', 'speed · carve'], ['LET GO', 'brakes to a hover']],
  angle: [['LEFT THUMB', 'throttle · yaw'], ['RIGHT THUMB', 'pitch · roll'], ['LET GO', 'self-levels · you hold throttle']],
  acro: [['LEFT THUMB', 'throttle · yaw'], ['RIGHT THUMB', 'pitch · roll rates'], ['NO SELF-LEVEL', 'expert · gamepad or radio']],
};
// shown in this order, one per load (the CUT rule comes second, not 1-in-5 at random)
const LOAD_TIPS = {
  take: () => [
    '<b>Lines</b> are named gaps, holes and dives. Each one adds FLOW. Fly close to structure to keep the chain alive; ' + secs(TT().bankT, 5) + ' s without a line banks it.',
    `<b>CUT</b>: ${cutRule()} to end the take and keep everything. The ring by REC counts it down; touch a stick to cancel.`,
    'A crash loses the <b>unbanked</b> chain. The bar under FLOW shows when it banks. Bank it or push on: your call.',
    '<b>RESET</b> restarts the take at the chimney, or where you chose to START AT on the pause menu; hold it to go back to the spawn.',
  ],
  free: () => [
    '<b>Free fly</b>: no clock. Lines still caption. Crash and you fly on from where you last flew clear.',
    '<b>RESET</b> goes back to your last clear spot; hold it to go back to the spawn.',
  ],
  any: () => ['<b>CLIP</b> turns your take into a stabilised, captioned video for your camera roll.'],
};
let loadN = 0;
try { loadN = +localStorage.getItem('onetake.loads') || 0; } catch (e) {}
function setLoad(title, frac, text) {
  const L = $('loading');
  if (L.classList.contains('hidden')) {
    // fresh card: the mode's stick diagram + one tip, no error buttons
    L.classList.remove('hidden'); $('ldErr').classList.remove('on'); $('ldCoach').classList.remove('hidden');
    const portrait = document.body.classList.contains('portrait');
    $('ldSticks').innerHTML = (STICK_COACH[S.mode] || STICK_COACH.cine).map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('') +
      (portrait ? '<dt>PORTRAIT</dt><dd>use the radio gimbals below</dd>' : '');
    const tips = [...(LOAD_TIPS[S.game]?.() || []), ...LOAD_TIPS.any()];
    $('ldTip').innerHTML = tips[loadN % tips.length];
    loadN++; try { localStorage.setItem('onetake.loads', String(loadN)); } catch (e) {}
  }
  if (title) $('ldTitle').textContent = title;
  if (frac !== null) $('ldBar').style.width = Math.round(frac * 100) + '%';
  if (text !== undefined) $('ldText').textContent = text;
}
async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader(); let buf = new Uint8Array(total); let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    if (got + value.length > buf.length) { const nb = new Uint8Array(Math.max(buf.length * 2, got + value.length)); nb.set(buf); buf = nb; }
    buf.set(value, got); got += value.length; onProgress?.(got, total);
  }
  return buf.subarray(0, got);
}
const mb = (b) => (b / 1048576).toFixed(1);

// errors stay up until the player acts: BACK to the menu, or RELOAD
function loadError(title, msg, back) {
  setLoad(title, 0, msg);
  $('ldCoach').classList.add('hidden'); $('ldTip').innerHTML = '';
  $('ldErr').classList.add('on'); $('ldBack').classList.toggle('hidden', !back);
  $('ldReload').className = back ? 'pill ui' : 'pill hot ui';
}
$('ldBack').onclick = () => { $('loading').classList.add('hidden'); openMenu(); };
$('ldReload').onclick = () => location.reload();

function clearWorld() {
  if (world.mesh) { splatScene.remove(world.mesh); world.mesh.dispose?.(); world.mesh = null; }
  if (world.scene) {
    world.scene.traverse((o) => { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : m ? [m] : []).forEach((mm) => { Object.values(mm).forEach((v) => v?.isTexture && v.dispose()); mm.dispose(); }); });
    world.scene.background?.dispose?.(); world.scene.environment?.dispose?.();
  }
  world.scene = null; world.bvh = null; world.colliderScene = null; world.bounds = null; world.envelope = null; world.update = null;
  world.skimBvh = null; world.lines = null; world.takeStart = null;
}

async function loadProcWorld(def) {
  const { buildBando } = await import('./world-bando.js');
  const w = await buildBando(renderer, { sky: def.sky, quality: S.quality, onProgress: (f, t) => setLoad(null, f, t) });
  clearWorld();
  Object.assign(world, { scene: w.scene, colliderScene: w.colliderScene, bvh: w.bvh, bounds: w.bounds, envelope: w.envelope, update: w.update, hdr: true });
  Object.assign(world, { skimBvh: w.skimBvh, lines: w.lines, takeStart: w.takeStart });   // C: the take
  world.spawn.copy(w.spawn); world.yaw = w.yaw;
  // scene-linear HDR in: the camera meters real light levels, with a GoPro-like ISO range
  fpv.setHDR(true);
  // [A] evMax 4.0: a real hall interior sits ~6 stops under open ground; the camera may open up 4 EV over outdoors.
  // Look line from stream D; overcast wb rescaled from D's farmland_overcast value by the sky change (skyE rgb/G
  // farmland 0.889/1/1.202 -> overcast_soil_puresky 1.009/1/1.004), so the rendered grey lands where D put it.
  Object.assign(fpv.look, { evMin: -5.5, evMax: 4.0, invTone: 0, lift: 0, saturation: 1.1, expo: 0.85, wb: def.sky === 'overcast' ? [0.990, 0.985, 0.941] : [1.063, 0.993, 0.883], evBias: def.sky === 'overcast' ? 0.3 : 0 });
  fpv.cam.near = 0.06; fpv.cam.far = 3000; fpv.cam.updateProjectionMatrix();
  // [A] shader warm-up behind the loader: compile every world program now (in parallel where
  // KHR_parallel_shader_compile exists) instead of hitching the first frames. Compiled against a
  // half-float target so the program keys (linear output, no tone mapping) match the HDR scene pass.
  try {
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType }), prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt); const t = performance.now();
    if (renderer.extensions.has('KHR_parallel_shader_compile')) await renderer.compileAsync(w.scene, fpv.cam); else renderer.compile(w.scene, fpv.cam);
    renderer.setRenderTarget(prev); rt.dispose();
    console.info('shader warm-up ms', Math.round(performance.now() - t));
  } catch (e) { console.warn('shader warm-up skipped', e); }
}

async function loadWorld(def) {
  state = 'loading';
  try {
    setLoad(def.name, 0, def.proc ? 'Building site…' : 'Fetching world…');
    if (def.proc) {
      await loadProcWorld(def);
      world.def = def;
      applySettings();
      $('loading').classList.add('hidden');
      return true;
    }
    await ensureSpark();
    fpv.setHDR(false);
    Object.assign(fpv.look, { evMin: -1.2, evMax: 1.8, invTone: 0.84, lift: 0.07, saturation: 0.95, expo: 0.85 });
    fpv.cam.near = 0.04; fpv.cam.far = 300; fpv.cam.updateProjectionMatrix();
    let bytes, fname;
    if (def.splatFile) { bytes = new Uint8Array(await def.splatFile.arrayBuffer()); fname = def.splatFile.name; }
    else {
      const url = S.splats === '2m' && def.splatHQ ? def.splatHQ : def.splat;
      fname = url.split('/').pop().split('?')[0];
      bytes = await fetchBytes(url, (g, t) => setLoad(null, 0.85 * g / t, `Splats ${mb(g)} / ${mb(t)} MB`));
    }
    setLoad(null, 0.86, 'Decoding splats…');
    const mesh = new SplatMesh({ fileBytes: bytes, fileName: fname });
    await mesh.initialized;
    if (def.flip) mesh.quaternion.set(1, 0, 0, 0);   // Marble/OpenCV (+y down, +z fwd) -> three.js
    clearWorld(); world.hdr = false;
    world.mesh = mesh; splatScene.add(mesh);

    world.bvh = null; world.colliderScene = null; world.bounds = null;
    let colBuf = null;
    if (def.colliderFile) colBuf = await def.colliderFile.arrayBuffer();
    else if (def.collider) { setLoad(null, 0.9, 'Collider…'); colBuf = (await fetchBytes(def.collider)).buffer; }
    if (colBuf) {
      setLoad(null, 0.93, 'Building collision…');
      const gltf = await new GLTFLoader().parseAsync(colBuf, '');
      gltf.scene.updateMatrixWorld(true);
      const pos = []; const idx = []; let base = 0;
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry; const p = g.attributes.position; const v = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); pos.push(v.x, v.y, v.z); }
        if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + base);
        else for (let i = 0; i < p.count; i++) idx.push(i + base);
        base += p.count;
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      if (def.flip) geo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
      geo.computeBoundingBox();
      world.bvh = new MeshBVH(geo);
      const cs = new THREE.Scene();
      const cm = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      cm.frustumCulled = false; cs.add(cm);
      world.colliderScene = cs;
      world.bounds = geo.boundingBox.clone().expandByScalar(4);
      setLoad(null, 0.96, 'Mapping flyable space…');
      await new Promise((r) => setTimeout(r, 30));
      world.envelope = measureEnvelope(mesh, world.bvh, geo.boundingBox);
    } else world.envelope = null;
    world.def = def;
    world.spawn.set(0, 0, 0); world.yaw = 0;
    applySettings();
    findSpawn();
    $('loading').classList.add('hidden');
    return true;
  } catch (err) {
    console.error(err);
    loadError('Could not load world', String(err.message || err), true);
    return false;
  }
}

// Generated worlds are built in 3D only near where they were generated; above that the collider stops
// and the splats turn into a painted backdrop. Find the height where visible splats lose their collision
// surface (sampled in 0.5 m bands) and cap flight just below it. Same for the sides: the collider's box.
function measureEnvelope(mesh, bvh, bb) {
  // Two signals per 0.5 m height band, sampled from the splats inside the collider's box:
  //  - coverage: share of visible splats with a collision surface within 0.4 m
  //  - quality: median splat size. Well-observed surfaces are ~1 cm blobs; the backdrop the generator
  //    only guessed at is 2-6 cm smears. The ceiling is the first band that fails either test.
  mesh.updateMatrixWorld(true);
  const V = mesh.matrixWorld, P = new THREE.Vector3(), t = {};
  const y0 = bb.min.y, band = 0.5, bins = Math.max(1, Math.ceil((bb.max.y - y0) / band));
  const tot = new Array(bins).fill(0), miss = new Array(bins).fill(0), sizes = Array.from({ length: bins }, () => []);
  try {
    mesh.forEachSplat((i, c, sc, q, a) => {
      if (i % 8 || a < 0.4) return;
      P.copy(c).applyMatrix4(V);
      if (P.x < bb.min.x || P.x > bb.max.x || P.y < bb.min.y || P.y > bb.max.y || P.z < bb.min.z || P.z > bb.max.z) return;
      const b = Math.min(bins - 1, Math.floor((P.y - y0) / band));
      const mx = Math.max(sc.x, sc.y, sc.z);
      if (sizes[b].length < 6000) sizes[b].push(mx);
      if (i % 16 === 0 && a >= 0.5 && mx <= 0.5) { tot[b]++; if (!bvh.closestPointToPoint(P, t, 0, 0.4)) miss[b]++; }
    });
  } catch (e) { console.warn('envelope scan failed', e); }
  const med = (arr) => { if (!arr.length) return NaN; const a = arr.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
  const meds = sizes.map((a) => (a.length >= 60 ? med(a) : NaN));
  const ref = med(meds.slice(1, 4).filter((v) => !isNaN(v))) || meds[0] || 0.012;   // bands 0.5-2.0 m up: the good stuff
  let top = y0 + 1.5;
  for (let b = 0; b < bins; b++) {
    const covOK = tot[b] < 25 || miss[b] / tot[b] <= 0.1;
    const qualOK = isNaN(meds[b]) || b < 1 || meds[b] <= ref * 1.8;
    if (!covOK || !qualOK) break;
    if (sizes[b].length >= 60 || tot[b] >= 25) top = y0 + (b + 1) * band;
  }
  const r = 0.15;
  const env = { min: new THREE.Vector3(bb.min.x + r, bb.min.y + r, bb.min.z + r), max: new THREE.Vector3(bb.max.x - r, Math.min(top, bb.max.y) - r, bb.max.z - r) };
  env.max.y = Math.max(env.max.y, 0.9);           // always room above the spawn
  console.info('flyable envelope', env.min.toArray().map((v) => +v.toFixed(2)), env.max.toArray().map((v) => +v.toFixed(2)),
    'size cm', meds.map((v) => (isNaN(v) ? '-' : (v * 100).toFixed(1))).join(' '), 'miss%', tot.map((n, i) => (n ? Math.round(100 * miss[i] / n) : '-')).join(' '));
  return env;
}

function findSpawn() {
  // Marble worlds are generated around the origin (best detail there); nudge up until clear.
  if (!world.bvh) return;
  const r = CRAFTS[craftFor(world.def)].radius * 2.2;
  const p = new THREE.Vector3(0, 0, 0); const t = {};
  for (let i = 0; i < 30; i++) {
    if (!world.bvh.closestPointToPoint(p, t, 0, r)) break;
    p.y += 0.1;
  }
  if (world.envelope) p.y = Math.min(p.y, world.envelope.max.y - 0.1);
  world.spawn.copy(p);
}

// free fly (open world): after a crash you go back to where you last were flying clear, not to the start.
// take: a retry starts at once, hovering by the chimney mouth (the first line); toStart = the spawn and its reveal.
const safePts = []; let safeT = 0;
function trackSafe(dt, now) {
  safeT += dt; if (safeT < 1.0 || drone.crashed) return; safeT = 0;
  if (world.lastDist > 1.2 && drone.vel.length() < 30) { safePts.push({ t: now, p: drone.pos.clone(), yaw: drone.heading }); if (safePts.length > 30) safePts.shift(); }
}
function respawn(toStart = false) {
  drone.setCraft(craftFor(world.def));
  const now = performance.now() / 1000;
  const takeMode = S.game !== 'free';
  const sp = toStart || takeMode ? null : [...safePts].reverse().find((s) => now - s.t > 2.0);
  if (sp) drone.reset(sp.p, sp.yaw);
  else if (takeMode && !toStart && world.takeStart) { drone.reset(world.takeStart.pos, world.takeStart.yaw); flightT = 0; }
  else { drone.reset(world.spawn, world.yaw); flightT = 0; }
  if (toStart || takeMode) safePts.length = 0;
  take.reset();
  controls.resetThrottle(Math.sqrt(1 / drone.c.twr)); thrRef = controls.thr;
  camQ.copy(drone.q); fpv.resetExposure = true;
  replayBuf.length = 0;
  state = 'fly';
  $('crashBar').classList.add('hidden'); $('banner').classList.add('hidden');
  $('fade').style.opacity = 0;
  uiRespawn();   // F: summary card, run stats, clip trim, coaching
}

// ---------------- scoring: proximity "skims"
const score = {
  total: 0, streak: 0, mult: 1, streakT: 0, lastClose: 0, best: 0,
  reset() { this.total = 0; this.streak = 0; this.mult = 1; this.streakT = 0; },
};
try { score.best = +localStorage.getItem('onetake.best') || 0; } catch (e) {}
// the take (take.js): named lines, FLOW, bank / crash / CUT
const take = new Take();
const _cp = {};
// proximity to anything (terrain included): flight turbulence, audio, OLED bars. Scoring uses world.skimBvh.
function updateProx() {
  if (!world.bvh || drone.crashed) { world.lastDist = Infinity; return; }
  const res = world.bvh.closestPointToPoint(drone.pos, _cp, 0, 2.0);
  world.lastDist = res && res.distance <= 2.0 ? res.distance - drone.c.radius : Infinity;
}
// "hands on": any centred stick deflected, or the (non-centring) throttle being moved
let thrRef = 0.39, takeGame = S.game;
function sticksActive(inp, dt) {
  const d = inp.thr - thrRef; thrRef += d * Math.min(1, dt / 0.5);
  const m = Math.max(Math.abs(inp.pitch), Math.abs(inp.roll), Math.abs(inp.yaw), S.mode === 'cine' ? Math.abs(inp.climb) : 0);
  return m > 0.12 || (S.mode !== 'cine' && Math.abs(d) > 0.04);
}
const takeEvent = (e) => (typeof onTakeEvent === 'function' ? onTakeEvent : (ev) => defaultTakeUI(ev, pop))(e);
function updateTake(dt, inp) {
  const on = sticksActive(inp, dt);
  if (S.game !== takeGame) { takeGame = S.game; take.reset(); }
  if (S.game === 'free') return;                      // free fly: no take, safe-point respawn
  for (const e of take.update(dt, drone, world, on)) takeEvent(e);
}
drone.onCrash = (impact) => { audio.thud(impact); };

// ---------------- camera rig
const camQ = new THREE.Quaternion();
const tiltQ = new THREE.Quaternion();
// uptilt is matched to cruise attitude (5" camTilt 28): Cine cruises at ~10-20 deg of lean -> 15, angle 22, acro 28
// (horizon near frame centre at 20-22 m/s acro cruise)
function defTilt(c) { return Math.round(c.camTilt * (S.mode === 'acro' ? 1 : S.mode === 'angle' ? 0.8 : 0.55)); }
const camPose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
// hz: jello/vibration frequency (motor rpm), read by fpvcam as `motion.hz ?? 170`
const motion = { vel: new THREE.Vector3(), ang: new THREE.Vector3(), vib: 1, hz: 170 };
const _q = new THREE.Quaternion(), _v = new THREE.Vector3();
function rigCamera(dt) {
  const tilt = (S.tilt >= 0 ? S.tilt : defTilt(drone.c)) * DEG;
  // Cine: the view also pitches with the climb/dive angle (flight.js camPitch; eases back to 0 in the other modes)
  tiltQ.setFromAxisAngle(_v.set(1, 0, 0), tilt + drone.camPitch(dt, S.mode === 'cine'));
  _q.copy(drone.q).multiply(tiltQ);
  const tau = STAB[S.stab] || 0;
  if (tau > 0) camQ.slerp(_q, 1 - Math.exp(-dt / tau)); else camQ.copy(_q);
  camPose.quat.copy(camQ);
  camPose.pos.copy(drone.pos).add(_v.set(0, 0.02, -0.04).applyQuaternion(drone.q));
  motion.vel.copy(drone.vel);
  motion.ang.copy(drone.w).applyQuaternion(drone.q);   // physical camera rotation (blur uses the raw motion)
  motion.vib = drone.crashed ? 0.2 : 0.35 + 1.1 * Math.sqrt(drone.thrust / drone.tMax) + drone.wash * 3 + drone.bump * 4;
  motion.hz = drone.rpmHz;                             // ~170 Hz at hover, ~430 Hz at full throttle (rpm ~ sqrt(thrust))
}

// ---------------- replay buffer + clip export
// Clips are the Short itself: the replay is re-rendered through the full camera, composited on a 2D canvas with
// burned-in captions (reference Shorts style), framing smoothed Gyroflow-style, audio re-synthesised into the track.
const replayBuf = []; const REPLAY_SEC = 60;
let replay = null, recorder = null, recChunks = [];
let capNow = null, clipEndT = null;              // caption to stamp on the next replay frame; end-of-clip trim (crash/cut + pad)
const comp = $('comp'), cctx = comp.getContext('2d');
function pushReplay(t) {
  replayBuf.push({ t, p: camPose.pos.clone(), q: camPose.quat.clone(), v: motion.vel.clone(), w: motion.ang.clone(), vib: motion.vib, m: drone.motors.slice(), s: drone.vel.length(), wash: drone.wash, c: drone.crashed,
    hz: motion.hz, hit: hitNow, thud: thudNow, ax: { ...ax }, cap: capNow });
  thudNow = 0; capNow = null;
  while (replayBuf.length && t - replayBuf[0].t > REPLAY_SEC) replayBuf.shift();
}
function pickMime() {
  const c = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d0028', 'video/mp4', 'video/mp4;codecs=avc1.42E01F', 'video/webm;codecs=vp9', 'video/webm'];
  return c.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}
// Gyroflow-style post stabilisation: Gaussian-smooth the view quaternions using frames before AND after each moment
// (sigma 0.12 s, horizon free). Velocity/rotation for the blur stay raw, so motion blur keeps the physical shake.
function smoothReplay(src, sigma = 0.12) {
  const n = src.length, out = new Array(n), seg = new Int32Array(n), W = 3 * sigma, k = -1 / (2 * sigma * sigma);
  for (let i = 1, s = 0; i < n; i++) { if (src[i].t - src[i - 1].t > 0.25 || src[i].p.distanceToSquared(src[i - 1].p) > 9) s++; seg[i] = s; }   // never blend across a teleport
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const qi = src[i].q, ti = src[i].t;
    while (lo < i && (src[lo].t < ti - W || seg[lo] !== seg[i])) lo++;
    let x = 0, y = 0, z = 0, w = 0;
    for (let j = lo; j < n && src[j].t <= ti + W && seg[j] === seg[i]; j++) {
      const q = src[j].q, d = src[j].t - ti, g0 = Math.exp(d * d * k);
      const g = (q.x * qi.x + q.y * qi.y + q.z * qi.z + q.w * qi.w) < 0 ? -g0 : g0;   // same hemisphere
      x += q.x * g; y += q.y * g; z += q.z * g; w += q.w * g;
    }
    out[i] = { ...src[i], q: new THREE.Quaternion(x, y, z, w).normalize() };
  }
  return out;
}
const CLIP_SIGMA = { off: 0, light: 0.06, heavy: 0.12 };   // fallback if E's STAB_REPLAY isn't in this build
function clipSigma() {
  let t = CLIP_SIGMA; try { if (typeof STAB_REPLAY !== 'undefined' && STAB_REPLAY) t = STAB_REPLAY; } catch (e) {}
  const v = t[S.stab]; return typeof v === 'number' ? v : 0.12;
}
function saveClip() {
  if (state === 'replay') return;
  const src = clipEndT ? replayBuf.filter((f) => f.t <= clipEndT) : replayBuf.slice();
  if (src.length < 30) { toast('FLY FIRST'); return; }
  if (!window.MediaRecorder || !comp.captureStream) { toast('THIS BROWSER CAN\'T RECORD CLIPS'); return; }
  audio.kick?.();                                            // inside the tap: make sure the clip gets sound
  const mime = pickMime();
  const cap = mime.includes('42E01F') ? 1280 : 1920;         // baseline L3.1 tops out at 720p
  const sc = Math.min(1, cap / Math.max(canvas.width, canvas.height));
  comp.width = Math.max(2, Math.round(canvas.width * sc / 2) * 2); comp.height = Math.max(2, Math.round(canvas.height * sc / 2) * 2);
  const sigma = clipSigma();
  const frames = sigma > 0 ? smoothReplay(src, sigma) : src;
  const t0 = frames[0].t, caps = [];
  if (S.caps !== 'off') for (const f of frames) if (f.cap) caps.push({ t: f.t - t0, text: f.cap.text, flow: f.cap.flow || 1 });
  warmFonts(Math.round(comp.height * 0.085));
  const stream = comp.captureStream(30);
  const at = audio.streamDest?.stream.getAudioTracks()[0]; if (at) stream.addTrack(at);
  try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 14e6 } : undefined); }
  catch (e) { toast('THIS BROWSER CAN\'T RECORD CLIPS'); return; }
  recChunks = [];
  const rec = recorder;
  rec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  rec.onstop = () => showClip(new Blob(recChunks, { type: rec.mimeType || mime || 'video/mp4' }), { dur: replayDur, caps: caps.length, smooth: sigma > 0 });
  replay = { frames, caps, t0: performance.now() / 1000, prev: state, i: -1, t: 0, stream };
  replay.dur = frames[frames.length - 1].t - t0;
  const replayDur = replay.dur;
  state = 'replay'; controls.enabled = false; controls.cancelAll?.(); fpv.resetExposure = true;
  $('crashBar').classList.add('hidden'); $('banner').classList.add('hidden');
  comp.classList.remove('hidden'); document.body.classList.add('replaying');
  $('recT').textContent = `REPLAY 0:00 / ${fmtS(replay.dur)}`; $('recP').style.width = '0%';
  rec.start(250);
}
function replayFrame() {
  const t = performance.now() / 1000 - replay.t0;
  const f = replay.frames; const t0 = f[0].t;
  if (t >= replay.dur) { endReplay(); return null; }
  let i = Math.max(0, replay.i); while (i < f.length - 1 && f[i + 1].t - t0 <= t) i++;
  for (let k = replay.i + 1; k <= i; k++) { if (f[k].hit) audio.hit(f[k].hit); if (f[k].thud) audio.thud(f[k].thud); }   // bumps + crash land in the clip
  replay.i = i; replay.t = t;
  return f[i];
}
function endReplay(cancel = false) {
  if (!replay) return;
  const r = replay; replay = null;
  if (cancel && recorder) { recorder.onstop = null; recorder.ondataavailable = null; recChunks = []; }
  try { recorder?.stop(); } catch (e) {}
  r.stream?.getVideoTracks().forEach((t) => t.stop());   // the canvas track only: the audio track is shared by every clip
  comp.classList.add('hidden'); document.body.classList.remove('replaying');
  state = r.prev === 'crash' ? 'crash' : 'fly';
  if (sum.data || state === 'crash') showSummary(sum.kind || 'crash', sum.data);   // put the card back
  controls.enabled = true; fpv.resetExposure = true;
}
// composite one replay frame: WebGL frame (still valid in this task, so no preserveDrawingBuffer needed) + caption
function compFrame() {
  const W = comp.width, H = comp.height;
  cctx.drawImage(canvas, 0, 0, W, H);
  let cap = null;
  for (const c of replay.caps) { if (c.t <= replay.t) cap = c; else break; }
  if (cap) drawCaption(cctx, W, H, cap.text, cap.flow, replay.t - cap.t);
}
const ACC = '#E75211', CAP_DUR = 1.6;
// split "THE SMALL GAP!" into [white, accent, white]. *WORD* in a caption picks the accent explicitly.
function splitAccent(text) {
  text = String(text || '').toUpperCase();
  const m = text.match(/\*([^*]+)\*/);
  if (m) return [text.slice(0, m.index), m[1], text.slice(m.index + m[0].length)].map((s) => s.replace(/\*/g, ''));
  const words = text.split(/\s+/).filter(Boolean); if (!words.length) return ['', '', ''];
  const core = (w) => w.replace(/[^A-Z0-9'×]/g, '');
  let k = words.length - 1;                                           // 1-2 words: the last (CHIMNEY *DIVE*, *SICK*!)
  if (words.length >= 3) {                                            // 3+: the shortest real word (IN *THE* TUNNEL)
    let best = 99; words.forEach((w, i) => { const L = core(w).length; if (L >= 3 && L < best) { best = L; k = i; } });
  }
  const w = words[k], tail = w.match(/[^A-Z0-9'×]+$/)?.[0] || '';
  const pre = words.slice(0, k).join(' ') + (k ? ' ' : ''), acc = w.slice(0, w.length - tail.length);
  const post = tail + (k < words.length - 1 ? ' ' + words.slice(k + 1).join(' ') : '');
  return [pre, acc, post];
}
function drawCaption(g, W, H, text, flow, age) {
  if (age < 0 || age > CAP_DUR) return;
  const lb = Math.max(0, fpv.look.letterbox || 0) * H, ih = H - 2 * lb;
  const fs = Math.round(ih * 0.085);                                   // cap height ~6 % of the frame
  const parts = splitAccent(text).map((s, i) => [s, i === 1 ? ACC : '#fff']).filter((p) => p[0]);
  g.save();
  g.font = `900 ${fs}px Montserrat, "Barlow Condensed", system-ui, sans-serif`;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.lineJoin = 'round'; g.miterLimit = 2;
  const ws = parts.map((p) => g.measureText(p[0]).width), tw = ws.reduce((a, b) => a + b, 0);
  const fit = Math.min(1, (W * 0.9) / Math.max(1, tw));
  const k = Math.min(1, age / 0.16), popS = 1 + 0.25 * (1 - k) * (1 - k);
  g.globalAlpha = Math.max(0, Math.min(1, age / 0.05, (CAP_DUR - age) / 0.25));
  g.translate(W / 2, H - lb - ih * 0.07); g.scale(fit * popS, fit * popS);
  g.lineWidth = fs * 0.18; g.strokeStyle = '#000';
  g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = fs * 0.12; g.shadowOffsetY = fs * 0.05;
  let x = -tw / 2; parts.forEach((p, i) => { g.strokeText(p[0], x, 0); x += ws[i]; });
  g.shadowColor = 'transparent';
  x = -tw / 2; parts.forEach((p, i) => { g.fillStyle = p[1]; g.fillText(p[0], x, 0); x += ws[i]; });
  if (flow >= 6) { g.textAlign = 'center'; g.font = `${Math.round(fs * 1.3)}px system-ui, "Apple Color Emoji", sans-serif`; g.fillText('😮', 0, -fs * 1.12); }
  g.restore();
}
let clipURL = null;
function showClip(blob, info = {}) {
  if (clipURL) URL.revokeObjectURL(clipURL);
  clipURL = URL.createObjectURL(blob);
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const v = $('clipVid'); v.src = clipURL; v.play().catch(() => {});
  const a = $('clipSave'); a.href = clipURL; a.download = `onetake-${Date.now()}.${ext}`;
  const file = new File([blob], a.download, { type: blob.type });
  const canShare = !!navigator.canShare?.({ files: [file] });
  // the share sheet is the primary save on iOS ("Save Video" -> Photos); <a download> only reaches Files
  $('clipShare').textContent = canShare ? 'SAVE VIDEO' : 'DOWNLOAD';
  a.classList.toggle('hidden', !canShare);
  $('clipMeta').textContent = `${fmtS(info.dur || 0)} · 30p · 1/60 · 180°${info.smooth ? ' · smoothed' : ''}${info.caps ? ` · ${info.caps} caption${info.caps > 1 ? 's' : ''}` : ''}`;
  $('clip').classList.remove('hidden');
  $('clipShare').onclick = async () => {
    if (canShare) { try { await navigator.share({ files: [file], title: 'One Take' }); } catch (e) {} }
    else a.click();
  };
}
$('clipClose').onclick = () => { $('clip').classList.add('hidden'); $('clipVid').pause(); };

// ---------------- HUD: HD-OSD, captions (pop), warnings, toasts
let hudT = 0, flightT = 0, lastLimitToast = 0, lqS = 100, thrS = 0.39;
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtS = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtN = (n) => Math.round(n || 0).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const accentHTML = (text) => { const [a, b, c] = splitAccent(text); return `${esc(a)}<em>${esc(b)}</em>${esc(c)}`; };
const fontsWarm = new Set();
function warmFonts(px = 40) {       // canvas captions need the face loaded before the first draw
  const f = `900 ${px}px Montserrat`; if (fontsWarm.has(f)) return; fontsWarm.add(f);
  try { document.fonts?.load?.(f, 'THE SMALL GAP!')?.catch?.(() => {}); } catch (e) {}
}
// Take (C, take.js): name the instance `take` or call bindTake(instance). Falls back to the legacy skim score.
let takeRef = null;
function bindTake(t) { takeRef = t; }
function curTake() {
  if (takeRef) return takeRef;
  try { if (typeof take !== 'undefined' && take && typeof take === 'object' && 'total' in take) return take; } catch (e) {}
  return null;
}
function scoreView() {
  const t = curTake();
  if (t) return { take: true, total: t.total || 0, flow: t.flow || 1, unbanked: t.unbanked || 0, best: t.best || 0, state: t.state, time: t.stats?.time };
  try { if (typeof score !== 'undefined' && score) return { take: false, total: score.total, flow: score.mult, unbanked: score.streak, best: score.best }; } catch (e) {}
  return { take: false, total: 0, flow: 1, unbanked: 0, best: 0 };
}

// pop(text, kind) — contract #5. kind: 'line' (Shorts caption) | 'score' (mono sub-line) | 'warn' (blinking) | 'info' (toast)
let popKind = '', popTm = 0;
function pop(text, kind = 'score') {
  if (kind === 'line') return showLine(text, '', 1);
  if (kind === 'warn') return warn(text);
  if (kind === 'info') return toast(text);
  const p = $('pop');
  if (popKind === 'line' && p.classList.contains('show')) { p.querySelector('.sub').innerHTML = text; return; }   // don't stomp a caption
  setPop('score', '', text, 1.2);
}
function showLine(text, subHTML = '', flow = 1) {
  if (/^\+0(?!\d)/.test(subHTML)) subHTML = '';   // free fly: lines caption with pts 0, so no "+0" sub-line
  else if (subHTML && lineTag) subHTML += lineTag;  // C: a line flown with no contact since the last one (×1.25)
  lineTag = '';
  setPop('line', (flow >= 6 ? '<span class="emo">😮</span>' : '') + accentHTML(text), subHTML, CAP_DUR);
}
function setPop(kind, capHTML, subHTML, dur) {
  const p = $('pop'); popKind = kind;
  p.querySelector('.cap').innerHTML = capHTML; p.querySelector('.sub').innerHTML = subHTML || '';
  p.className = kind; p.style.setProperty('--popDur', dur + 's');
  void p.offsetWidth; p.classList.add('show');
  clearTimeout(popTm); popTm = setTimeout(() => { p.classList.remove('show'); popKind = ''; }, dur * 1000);
  // the live chain + drain bar stay up under the caption (design #1): it sits below it now, so no hiding
}
let warnTm = 0, toastTm = 0;
function warn(text, secs = 1.6) {
  const w = $('warn'); w.textContent = String(text).toUpperCase(); w.classList.remove('show'); void w.offsetWidth; w.classList.add('show');
  clearTimeout(warnTm); warnTm = setTimeout(() => w.classList.remove('show'), secs * 1000);
}
function toast(text, secs = 1.8) {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toastTm); toastTm = setTimeout(() => t.classList.remove('show'), secs * 1000);
}

function updateHud(dt) {
  hudFast();
  hudT += dt; if (hudT < 0.1) return; hudT = 0;
  if (state === 'replay' && replay) {
    $('recT').textContent = `REPLAY ${fmtS(replay.t)} / ${fmtS(replay.dur)}`;
    $('recP').style.width = Math.min(100, 100 * replay.t / Math.max(0.01, replay.dur)).toFixed(1) + '%';
    return;
  }
  const v = scoreView();
  const spd = drone.vel.length(), kmh = Math.round(spd * 3.6), time = v.time ?? flightT;
  thrS += ((drone.thrust / drone.tMax || 0) - thrS) * 0.3;
  // --- HD OSD (landscape): the glyphs are static markup, only the value spans change
  $('score').textContent = fmtN(v.total);
  $('best').textContent = v.best ? `BEST ${fmtN(Math.max(v.best, v.total))}` : '';
  $('spd').textContent = kmh;
  $('tmr').textContent = fmt(time);
  $('oAlt').textContent = Math.max(0, drone.pos.y).toFixed(1);
  // 6S pack (the 2026 5" freestyle norm): 25.2 V full, sags under throttle, ~0.45 V/min. The glyph fills in 5 steps
  // from the resting voltage, so it doesn't flicker with every punch.
  $('oVolt').textContent = Math.max(21.0, 25.2 - 1.4 * thrS - 0.45 * flightT / 60).toFixed(1);
  const lvl = Math.max(1, Math.min(5, Math.ceil(5 * (Math.max(21.0, 25.2 - 0.45 * flightT / 60) - 21.0) / 4.2)));
  if (lvl !== batLvl) { batLvl = lvl; $('oBat').querySelectorAll('rect').forEach((r, i) => { r.style.opacity = i < lvl ? '1' : '0'; }); }
  $('oMode').textContent = { cine: 'CINE', angle: 'ANGL', acro: 'ACRO' }[S.mode];
  lqS += ((100 - 4 * room.roof - 9 * room.tube - (Math.random() < 0.1 ? 2 : 0)) - lqS) * 0.25;
  $('oLQv').textContent = Math.round(Math.min(100, lqS));
  if (S.mode !== 'cine') {
    $('oThr').querySelector('i').style.height = (controls.thr * 100).toFixed(1) + '%';
    $('oThr').querySelector('u').style.bottom = (Math.sqrt(1 / drone.c.twr) * 100).toFixed(1) + '%';
  }
  const ts = v.take && S.game !== 'free' ? v.state : null;   // the take tag itself is per frame (hudFast): REC / CUT countdown / CRASHED / CUT
  // live chain under the caption spot, with the bank drain bar (hudFast)
  const L = $('live');
  if (v.unbanked > 0 && state === 'fly' && !summaryUp()) {
    $('liveT').innerHTML = `${v.take ? 'FLOW' : 'SKIM'}${v.flow >= 2 ? ` <em>×${v.flow}</em>` : ''} · ${fmtN(v.unbanked)}`; L.classList.add('show');
  } else L.classList.remove('show');
  if (drone.limitHit > 0 && performance.now() - lastLimitToast > 2500) { lastLimitToast = performance.now(); warn(drone.pos.y >= (world.envelope?.max.y ?? 1e9) - 0.01 ? 'CEILING' : 'WORLD EDGE'); }
  // --- next line: Betaflight-style home arrow (8 steps) + name + distance, until 3 lines have ever been flown.
  // The chevron over the gate (< 25 m) is per frame in hudFast and shows for any unflown line.
  nextNow = state === 'fly' && !summaryUp() && ts !== 'done' && !drone.crashed ? nextLine() : null;
  const nx = nextNow, guide = !!nx && flownCount() < 3, dir = nx ? octant(nx) : 0;
  if (guide) {
    $('oNextA').style.transform = `rotate(${dir * 45}deg)`;
    $('oNextN').textContent = nx.name;
    $('oNextD').textContent = `${Math.round(nx.dist)}M${elevTxt(nx)}`;
  }
  $('oNext').classList.toggle('on', guide);
  // --- radio OLED (portrait)
  $('oMd').textContent = { cine: 'CINE', angle: 'ANGLE', acro: 'ACRO' }[S.mode]; $('oT').textContent = fmt(time); $('oS').textContent = `${kmh} KM/H`;
  const bars = world.lastDist < 3 ? Math.max(0, Math.min(4, Math.round(4 - world.lastDist / 0.5))) : 0;
  $('oPx').querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', i < bars));
  $('oSc').textContent = fmtN(v.total);
  $('oSt').textContent = drone.crashed ? 'CRASHED' : cutLeft > 0 ? (cutLand ? 'LANDED · CUT…' : `CUT ${Math.ceil(cutLeft)}…`) : drone.limitHit > 0 ? 'LIMIT' :
    v.unbanked > 0 ? `${v.take ? 'FLOW' : 'SKIM'}${v.flow >= 2 ? ' x' + v.flow : ''} +${fmtN(v.unbanked)}` :
    guide ? `${HOME_ARROWS[dir]} ${nx.name} ${Math.round(nx.dist)}M` :
    ts === 'live' ? '● REC' : ts === 'ready' ? 'READY · FLY A LINE' : ts === 'done' ? (crashedTake() ? 'CRASHED' : 'CUT') :
    S.mode !== 'cine' ? `THR ${Math.round(controls.thr * 100)}%  BEST ${fmtN(v.best)}` : `BEST ${fmtN(v.best)}`;
}

// ---------------- per-frame HUD: take tag (REC / CUT countdown / CRASHED), bank drain bar, near-line chevron, LOW POWER
const CUT_RING = 2 * Math.PI * 7.5;                               // #cutArc circumference (r 7.5)
const HOME_ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];     // OLED home arrow, clockwise from the nose
let cutLeft = 0, cutLand = false, tagKey = '', nextNow = null, lowPow = false, batLvl = 0, drainK = -2, chevOn = false, chevD = -1;
const crashedTake = () => drone.crashed || sum.kind === 'crash' || pendingSum?.type === 'crash';
function hudFast() {
  const t = curTake(), ts = t && S.game !== 'free' ? t.state : null;   // free fly: no take, no tag
  // CUT countdown, decision 10. C: take.cutIn = s until the CUT while the ring shows (after cutShow 1 s of hands-off
  // hover, or at once on a touchdown), else 0; take.cutFrac = ring fill 0..1; take.cutKind 'hover' | 'land'.
  // Any stick cancels it (C resets the hover). Without C: the round-2 hover timer, ring from 1 s.
  const cutT = +TT().cutT || 3, from = Math.max(0.3, cutT - 1);
  let ci = 0, frac = 0;
  if (t && ts === 'live' && state === 'fly') {
    if (typeof t.cutIn === 'number') { if (t.cutIn > 0) { ci = t.cutIn; frac = typeof t.cutFrac === 'number' ? t.cutFrac : 1 - ci / from; } }
    else { const c = t._hover > 0 && (t.total || 0) + (t.unbanked || 0) > 0 ? cutT - t._hover : 0; if (c > 0 && c <= from) { ci = c; frac = 1 - c / from; } }
  }
  cutLeft = ci; cutLand = !!ci && t.cutKind === 'land';
  const txt = !ts ? '' : ci ? (cutLand ? 'LANDED' : `CUT ${Math.ceil(ci)}`) : crashedTake() ? 'CRASHED' : ts === 'live' ? 'REC' : ts === 'done' ? 'CUT' : 'READY';
  const cls = 'o tl' + (ts ? ' on' : '') + (ts === 'live' && !ci ? ' live' : '') + (ci ? ' cut' : '');
  if (cls + txt !== tagKey) {
    tagKey = cls + txt; $('takeTag').className = cls; $('takeTxt').textContent = txt;
    document.body.classList.toggle('cutting', !!ci);
  }
  if (ci) $('cutArc').style.strokeDashoffset = (CUT_RING * Math.max(0, Math.min(1, frac))).toFixed(2);   // drains as it fills
  // bank drain bar under the live chain: bankIn / bankT. C's take.holding (hugging structure keeps the chain alive) glows it.
  const L = $('live'), d = $('drain');
  const k = L.classList.contains('show') && t && typeof t.bankIn === 'number' ? Math.max(0, Math.min(1, t.bankIn / (+TT().bankT || 5))) : -1;
  if (k !== drainK) {
    if ((k < 0) !== (drainK < 0)) d.style.display = k < 0 ? 'none' : '';
    drainK = k;
    if (k >= 0) { d.style.transform = `scaleX(${k.toFixed(3)})`; d.classList.toggle('low', t.bankIn < 1.5); }
  }
  if (k >= 0) d.classList.toggle('hold', !!t.holding);
  // chevron over the next never-flown line's first gate (C: hint.fresh), projected through the lens. OSD only, never in clips.
  const nx = nextNow;
  let on = false;
  if (nx && nx.pos && nx.fresh !== false && state === 'fly' && nx.dist < 27) {
    const p = projectView(nx.pos);
    if (p && p.d < 25) {
      on = true;
      $('oChev').style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-50%,calc(-100% - 4px))`;
      const dm = Math.round(p.d); if (dm !== chevD) { chevD = dm; $('oChevD').textContent = `${dm}M`; }
    }
  }
  if (on !== chevOn) { chevOn = on; $('oChev').classList.toggle('on', on); }
  // iOS Low Power Mode pins rAF at 30 Hz; fpvcam notices and sets autoMs 33.3 (UX #6)
  if (state === 'fly') { const lp = (fpv.autoMs || 0) > 30; if (lp && !lowPow) toast('LOW POWER · 30 FPS', 3); lowPow = lp; }
}
// world point -> CSS px in #view through the fpvcam lens (inverse of the output pass: th = atan(r k / F) / k), or null
const _iq = new THREE.Quaternion(), _pv = new THREE.Vector3();
function projectView(p) {
  const L = fpv.lens; if (!L) return null;
  _pv.set(p.x, p.y, p.z).sub(camPose.pos).applyQuaternion(_iq.copy(camPose.quat).invert());
  const len = _pv.length(); if (len < 0.3 || _pv.z > -0.05) return null;
  const th = Math.acos(Math.min(1, -_pv.z / len)); if (th > L.thc) return null;
  const r = L.k > 0.999 ? L.F * Math.tan(th) : L.F * Math.tan(L.k * th) / L.k;
  const h = Math.hypot(_pv.x, _pv.y), s = h > 1e-6 ? r / h : 0;
  const u = 0.5 + _pv.x * s / (2 * L.hw), v = 0.5 + _pv.y * s / (2 * L.hh);
  if (u < 0.03 || u > 0.97 || v < 0.06 || v > 0.94) return null;
  return { x: u * viewW, y: (1 - v) * viewH, d: len };
}
// bearing of a world point relative to the view's heading, + = right. YXZ yaw ignores pitch, so it stays put while
// you look up at the sky or straight down a shaft.
const _eu = new THREE.Euler();
function relBearing(p) {
  const yaw = _eu.setFromQuaternion(camPose.quat, 'YXZ').y, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const tx = p.x - camPose.pos.x, tz = p.z - camPose.pos.z;
  return Math.atan2(-tx * fz + tz * fx, tx * fx + tz * fz);
}
const octant = (h) => { const b = h.pos ? relBearing(h.pos) : +h.bearing || 0; return ((Math.round(b / (Math.PI / 4)) % 8) + 8) % 8; };
const elevTxt = (h) => { const dy = h.pos ? h.pos.y - camPose.pos.y : (+h.elev || 0) * (h.dist || 0); return Math.abs(dy) >= 5 ? ` ${dy > 0 ? '▲' : '▼'}${Math.round(Math.abs(dy))}` : ''; };

// ---------------- line progress: LINES checklist, best FLOW per line, stars.
// C (take.js) keeps the record (localStorage onetake.lines) and serves it as take.lineList(world)
// [{name, micro, flown, n, bestFlow, ...}] and take.progress(world). The UI also keeps a copy from the take events
// (onetake.ui.progress) so it works on its own; both are read (union), so nothing is lost either way.
const LINE_HINT = {
  'CHIMNEY DIVE': 'in at the top of the chimney, out of its door', 'DROP IN': 'into the chimney mouth',
  'UNDER THE RACK': 'under the pipe rack, end to end', 'TRIPLE POP': 'up through the hall\'s three stacked holes',
  'TRIPLE DROP': 'down the hall\'s three stacked holes', 'GALLERY CLIMB': 'up inside the conveyor gallery',
  'GALLERY DROP': 'down inside the conveyor gallery', 'STAIRWELL DIVE': 'down the head-house stair shaft',
  'UNDER THE TABLE': 'under the silo table, edge to edge', 'THE SMALL GAP': 'the 1.6 m gap between two silos',
  'THREAD THE NEEDLE': 'both silo gaps in one go', 'HALL RUN': 'the hall\'s ground floor, door to door',
  'STRAIGHT THROUGH': 'across the hall, open bay to open bay', 'THROUGH THE WORKSHOP': 'in one workshop door, out the other',
};
const DEFAULT_LINES = ['CHIMNEY DIVE', 'UNDER THE RACK', 'TRIPLE POP', 'TRIPLE DROP', 'GALLERY CLIMB', 'GALLERY DROP', 'STAIRWELL DIVE',
  'UNDER THE TABLE', 'THE SMALL GAP', 'THREAD THE NEEDLE', 'HALL RUN', 'STRAIGHT THROUGH', 'THROUGH THE WORKSHOP'];   // menu before the first load
const STAR = 'M8 1.2l2.1 4.4 4.8.6-3.5 3.3.9 4.8L8 11.9l-4.3 2.4.9-4.8L1.1 6.2l4.8-.6z';
const uiProg = { lines: {} };           // NAME -> { n: times flown, f: best FLOW (0 = only in free fly) }
try { const p = JSON.parse(localStorage.getItem('onetake.ui.progress') || 'null'); if (p && p.lines && typeof p.lines === 'object') uiProg.lines = p.lines; } catch (e) {}
const saveUiProg = () => { try { localStorage.setItem('onetake.ui.progress', JSON.stringify(uiProg)); } catch (e) {} };
// C's list (needs the world's lines), else null
function cLines() {
  const t = curTake(); if (typeof t?.lineList !== 'function' || !Array.isArray(world.lines) || !world.lines.length) return null;
  try { const L = t.lineList(world); return Array.isArray(L) ? L : null; } catch (e) { return null; }
}
// C's store before a world is loaded (first menu): {NAME: {n, flow, pts}}
function cStore() { try { const o = JSON.parse(localStorage.getItem('onetake.lines') || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } }
const newLines = new Set();             // first time ever, this take: NEW on the card
let lineTag = '';                       // CLEAN tag for the next caption's sub-line (showLine)
function noteLine(e) {
  const name = e.name; if (!name) return;
  const c = cLines()?.find((l) => l.name === name), r = uiProg.lines[name];
  if (e.type === 'line' && (c ? c.n <= 1 : !r)) newLines.add(name);   // C counts the line before dispatching it
  uiProg.lines[name] = { n: (r?.n || 0) + 1, f: Math.max(r?.f || 0, e.free ? 0 : e.flow || 1) };
  saveUiProg();
}
// 500-pt micro-lines (C: DROP IN, roof U-turn, SILO CARVE...: l.micro) are beats, not checklist lines
const isMicro = (l) => !!l.micro || (typeof l.pts === 'number' && l.pts > 0 && l.pts < 1000);
let baseCache = null, baseSrc = null;
function baseLines() {                  // checklist names in world order (cached for the menu before the next load)
  if (Array.isArray(world.lines) && world.lines.length) {
    if (baseSrc !== world.lines) {
      baseSrc = world.lines; const m = new Set();
      for (const l of world.lines) if (l && l.name && !isMicro(l)) m.add(l.name);
      baseCache = [...m];
      try { localStorage.setItem('onetake.ui.lineList', JSON.stringify(baseCache)); } catch (e) {}
    }
    return baseCache;
  }
  if (!baseCache) {
    let names = null; try { names = JSON.parse(localStorage.getItem('onetake.ui.lineList') || 'null'); } catch (e) {}
    baseCache = Array.isArray(names) && names.length ? names : DEFAULT_LINES;
  }
  return baseCache;
}
// [{name, hint, flown, f (best FLOW)}]
function lineList() {
  const C = cLines(), m = C ? new Map(C.map((l) => [l.name, { n: l.n || (l.flown ? 1 : 0), f: l.bestFlow || 0 }])) : null;
  const S0 = m ? null : !Array.isArray(world.lines) ? cStore() : null;
  return baseLines().map((name) => {
    const c = m ? m.get(name) : S0?.[name] ? { n: +S0[name].n || 0, f: +S0[name].flow || 0 } : null, r = uiProg.lines[name];
    return { name, hint: LINE_HINT[name] || '', flown: !!(c?.n || r), f: Math.max(c?.f || 0, r?.f || 0) };
  });
}
const flownCount = () => lineList().filter((l) => l.flown).length;
const hintFor = (name) => LINE_HINT[name] || '';
// the nearest never-flown line's first gate. C: take.nextHint(drone, world) -> {name, caption, pos:[x,y,z], dist, bearing
// (rad from the nose, + right), elev, fresh} or null. The arrow uses pos against the view (so it follows the camera).
function nearestGate(name) {
  let best = null, bd = Infinity;
  for (const l of world.lines || []) {
    if (!l || (name ? l.name !== name : isMicro(l) || uiProg.lines[l.name])) continue;
    const g = l.pre?.[0]?.c || l.c; if (!g) continue;
    const d = Math.hypot(g[0] - camPose.pos.x, g[1] - camPose.pos.y, g[2] - camPose.pos.z);
    if (d < bd) { bd = d; best = { name: l.name, pos: new THREE.Vector3(g[0], g[1], g[2]), dist: d, fresh: true }; }
  }
  return best;
}
function nextLine() {
  if (!Array.isArray(world.lines) || !world.lines.length) return null;
  const t = curTake();
  if (typeof t?.nextHint === 'function') {
    let h = null; try { h = t.nextHint(drone, world); } catch (e) {}
    if (!h || !h.name) return null;
    const c = h.pos || h.c, fresh = h.fresh !== false;
    if (c) { const pos = Array.isArray(c) ? new THREE.Vector3(c[0], c[1], c[2]) : new THREE.Vector3(c.x, c.y, c.z); return { name: h.name, pos, dist: pos.distanceTo(camPose.pos), fresh }; }
    const g = nearestGate(h.name); if (g) { g.fresh = fresh; return g; }
    return { name: h.name, pos: null, dist: +h.dist || 0, bearing: +h.bearing || 0, elev: +h.elev || 0, fresh };
  }
  return nearestGate(null);
}
// 3-star targets per take (design #3: 40k / 80k / 130k = C's TAKE_TUNING.stars)
function starTargets() { const s = TT().stars; return Array.isArray(s) && s.length ? s : [40000, 80000, 130000]; }
const starCount = (total) => starTargets().filter((v) => total >= v).length;
const starsHTML = (n, of) => Array.from({ length: of }, (_, i) => `<svg viewBox="0 0 16 16"${i < n ? ' class="on"' : ''} aria-hidden="true"><path d="${STAR}"/></svg>`).join('');
const kfmt = (v) => (v >= 1000 ? Math.round(v / 1000) + 'K' : String(v));
// menu: BEST + stars (of the best take) + LINES strip, the LINES checklist, START AT (paused)
function renderProgress() {
  const L = lineList(), fl = L.filter((l) => l.flown).length, best = scoreView().best || 0;
  $('mStrip').innerHTML = `<span>BEST <b>${best ? fmtN(best) : '—'}</b></span><i>·</i><span class="stars">${starsHTML(starCount(best), starTargets().length)}</span><i>·</i><span>LINES <b>${fl}/${L.length}</b></span>`;
  const nx = loadedId ? nextLine() : null;
  $('lnCount').textContent = `${fl}/${L.length}`;
  $('lnGrid').innerHTML = L.map((l) => {
    const next = !l.flown && nx?.name === l.name;
    const sub = l.flown ? (l.f >= 1 ? `FLOW ×${l.f}` : 'FLOWN') : l.hint;
    return `<div class="ln${l.flown ? ' on' : ''}${next ? ' next' : ''}"><svg viewBox="0 0 14 14" aria-hidden="true"><rect x=".75" y=".75" width="12.5" height="12.5" rx="3"/><path d="M3.6 7.2l2.3 2.3 4.6-4.8"/></svg><b>${esc(l.name)}</b><small>${esc(sub)}</small></div>`;
  }).join('');
  // START AT (C: world.startPoints [{name, pos, yaw}] + respawn(false, name)); hidden until C provides them. C keeps the
  // choice for retries in its module-level `startAt`; the active one is lit. Hold RESET (back to the spawn) clears it.
  const sp = Array.isArray(world.startPoints) && loadedId ? world.startPoints.filter((s) => s && s.name) : [];
  const cur = typeof startAt === 'string' ? startAt.toLowerCase() : '';
  $('startSec').classList.toggle('hidden', !sp.length || !document.body.classList.contains('paused'));
  $('starts').innerHTML = sp.map((s) => `<button data-n="${esc(s.name)}"${s.name.toLowerCase() === cur ? ' class="on"' : ''}>${esc(s.name)}</button>`).join('');
}
$('starts').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) goStartAt(b.dataset.n); });
// (not `startAt`: that name is C's sticky START AT choice in respawn)
function goStartAt(name) {
  if (!loadedId || state !== 'menu' || !name) return;
  respawn(false, name); prevState = 'fly';
  startFlight(false);
  toast(`START AT ${String(name).toUpperCase()}`);
}
// F1 test hooks (uishots), kept off window.__onetake so that shared object stays merge-clean
window.__onetakeUI = { uiProg, lineList, nextLine, renderProgress, goStartAt, projectView, get hint() { return nextNow; } };

// ---------------- take events (contract #3), summary card, recovery
// main.js dispatch (C): (typeof onTakeEvent === 'function' ? onTakeEvent : (e) => defaultTakeUI(e, pop))(e)
const runStats = { maxSpeed: 0, maxFlow: 1 };
let pendingSum = null, bestAtStart = 0, uiWasCrashed = false, padArmed = false;
const sum = { kind: null, data: null };
function caption(text, flow = 1) { capNow = { text, flow }; }   // recorded into the replay buffer -> burned into the clip
function onTakeEvent(e) {
  if (!e || !e.type) return;
  const now = performance.now() / 1000;
  // F1: line progress / NEW badges, CLEAN on the caption, SCRAPE warning (C: scrape {impact, flow, lost})
  if (e.type === 'start') newLines.clear();
  if (e.type === 'line' || e.type === 'repeat') { noteLine(e); lineTag = e.clean && !e.free ? ' · <b>CLEAN</b>' : ''; }
  if (e.type === 'scrape' && e.lost) warn(`SCRAPE · FLOW ×${e.flow || 1}`, 1.2);
  switch (e.type) {
    case 'start':
      hideSummary(); sum.kind = sum.data = null; pendingSum = null; clipEndT = null;
      bestAtStart = scoreView().best || 0; runStats.maxSpeed = 0; runStats.maxFlow = 1;
      break;
    case 'line': {
      const text = e.caption || e.name || 'NICE!', flow = e.flow || 1;
      showLine(text, `+${fmtN(e.pts)}${flow >= 2 ? ` <em>×${flow}</em>` : ''}`, flow);
      caption(text, flow); runStats.maxFlow = Math.max(runStats.maxFlow, flow);
      break;
    }
    case 'repeat': {
      const text = world.lines?.find?.((l) => l.name === e.name)?.caption || e.name || 'AGAIN';
      showLine(text, `REPEAT +${fmtN(e.pts)}`, 1); caption(text, 1);
      break;
    }
    case 'bank': pop(`BANKED <em>+${fmtN(e.pts)}</em>`, 'score'); break;
    case 'lost': if (e.pts > 0) warn(`CHAIN LOST -${fmtN(e.pts)}`, 2); break;
    case 'skim': break;                                   // the live FLOW line on the HUD already reflects it
    case 'cut': clipEndT = now + 0.6; showSummary('cut', e); break;
    case 'crash': clipEndT = now + 1.2; pendingSum = e; break;   // card appears 0.8 s after the hit (uiFrame)
  }
}
function showSummary(kind, e) {
  const v = scoreView(), st = (e && e.stats) || {};
  const isTake = !!(e && 'total' in e) || v.take;
  const total = e?.total ?? v.total ?? 0;
  const best = Math.max(v.best || 0, total), newBest = total > 0 && total > bestAtStart;
  const maxSp = st.maxSpeed ?? runStats.maxSpeed, time = st.time ?? v.time ?? flightT, mf = st.maxFlow ?? runStats.maxFlow;
  const lines = Array.isArray(st.lines) ? st.lines.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : null;
  sum.kind = kind; sum.data = e || null;
  const T = $('bTitle'); T.className = kind; T.innerHTML = kind === 'cut' ? 'CUT<em>.</em>' : 'CRASHED';
  const lost = kind === 'crash' && e?.lost > 0 ? `Chain lost −${fmtN(e.lost)}` : 'Take over';   // the CHAIN LOST warning hides under the card
  const cutHow = e?.how === 'land' ? 'Landed · that\'s a take' : 'That\'s a take';   // C: cut.how 'hover' | 'land'
  $('bSub').textContent = kind === 'cut' ? `${cutHow} · touch a stick for a new one` : isTake ? `${lost} · touch a stick to retry` : 'Touch a stick to fly on';
  const row = (k, val) => `<span>${k}</span><b>${val}</b>`;
  $('bStats').innerHTML = row('MAX SPEED', `${Math.round(maxSp * 3.6)} KM/H`) + row('FLY TIME', fmt(time)) +
    row('SCORE', fmtN(total)) + row('BEST', newBest ? `<em>NEW</em> ${fmtN(best)}` : fmtN(best)) +
    row('MAX FLOW', `×${mf || 1}`) + (lines ? row('LINES', String(lines.length)) : '');
  // stars for this take + the next target; this take's lines (NEW = first time ever); the checklist and what to fly next
  const tg = starTargets(), ns = typeof e?.stars === 'number' ? e.stars : starCount(total), nextT = tg.find((s) => total < s);
  $('bStars').innerHTML = isTake ? starsHTML(ns, tg.length) + (nextT ? `<small>NEXT ${kfmt(nextT)}</small>` : '') : '';
  $('bLines').innerHTML = lines && lines.length ? [...new Set(lines)].map((n) => esc(n) + (newLines.has(n) ? ' <em>NEW</em>' : '')).join(' · ') : '';
  const LL = lineList(), nx = nextLine(), nh = nx ? hintFor(nx.name) : '';
  $('bNext').innerHTML = LL.length ? `LINES <b>${flownCount()}/${LL.length}</b>` + (nx ? ` · next: <b>${esc(nx.name)}</b>${nh ? ` – ${esc(nh)}` : ''}` : '') : '';
  $('cReset').textContent = isTake ? 'RETRY' : 'FLY ON';
  $('banner').classList.remove('hidden'); $('crashBar').classList.remove('hidden'); $('live').classList.remove('show');
  document.body.classList.add('sumup');
  padArmed = false;
}
function hideSummary() { $('banner').classList.add('hidden'); $('crashBar').classList.add('hidden'); document.body.classList.remove('sumup'); }
const summaryUp = () => !$('banner').classList.contains('hidden');
function uiRespawn() {
  hideSummary(); sum.kind = sum.data = null; pendingSum = null; clipEndT = null; capNow = null;
  runStats.maxSpeed = 0; runStats.maxFlow = 1; bestAtStart = scoreView().best || 0;
  lastBump = drone.bump; wasCrashed = uiWasCrashed = false;
}
// per-frame UI: crash card timing, fly-on, run stats, coaching
function uiFrame(dt) {
  if (uiWasCrashed && !drone.crashed) { pendingSum = null; if (sum.kind === 'crash') { hideSummary(); sum.kind = sum.data = null; } }
  uiWasCrashed = drone.crashed;
  if (state === 'fly') {
    const v = scoreView();
    runStats.maxSpeed = Math.max(runStats.maxSpeed, drone.vel.length()); runStats.maxFlow = Math.max(runStats.maxFlow, v.flow || 1);
  }
  if (state === 'crash' && drone.crashT > 0.8) {
    if (!summaryUp() || sum.kind !== 'crash') showSummary('crash', pendingSum);
    // gamepad / keyboard / held thumb: re-centre then move a stick = fly on
    const m = Math.abs(controls.yaw) + Math.abs(controls.roll) + Math.abs(controls.pitch) + (S.mode === 'cine' ? Math.abs(controls.climb) : 0);
    if (m < 0.12) padArmed = true; else if (padArmed && m > 0.35) respawn();
  }
  coachFrame(dt);
}
// after a crash, any fresh stick touch flies on (0.8 s grace so the hit registers); after a CUT it clears the card
function stickStart(side) {
  if (state === 'crash' && drone.crashT > 0.8) respawn();
  else if (state === 'fly' && sum.kind === 'cut' && summaryUp()) { hideSummary(); sum.kind = sum.data = null; }
}
function flyOnTouch(e) { if (!e.target?.closest?.('button, .ui, input, select, a')) stickStart(null); }

// ---------------- onboarding: ghost gates until each stick has been held 1 s; rotate tip in portrait
const coach = { on: false, held: { L: 0, R: 0 } };
try { coach.done = localStorage.getItem('onetake.coached') === '1'; } catch (e) { coach.done = false; }
let rotateTipped = false, firstTipped = false;
// body.coaching (not .coach: that's the loading card's stick-diagram box, whose rule made the page ~50 px too tall)
function coachStart(fresh) {
  coach.on = !coach.done; document.body.classList.toggle('coaching', coach.on);
  const portrait = document.body.classList.contains('portrait');
  if (!rotateTipped && portrait) { rotateTipped = true; setTimeout(() => toast('ROTATE FOR FULL SCREEN', 2.5), 900); }
  // first flight ever, from the spawn: where the first line is (UX #2). The OSD arrow takes over from there.
  if (fresh && !firstTipped && S.game !== 'free' && !flownCount()) {
    firstTipped = true;
    setTimeout(() => { if (state === 'fly') toast('FIRST LINE: FOLLOW THE TRACK INTO THE HALL\'S OPEN BAY · STAY LOW', 4.5); }, portrait ? 3600 : 1200);
  }
}
function coachFrame(dt) {
  if (!coach.on) return;
  const touching = { L: false, R: false };
  for (const t of controls.touches?.values?.() || []) touching[t.side] = true;
  for (const s of ['L', 'R']) {
    if (touching[s] && state === 'fly') coach.held[s] += dt;
    const g = $('g' + s); g.classList.toggle('held', touching[s]); g.classList.toggle('done', coach.held[s] >= 1);
  }
  if ((coach.held.L >= 1 && coach.held.R >= 1) || controls.padActive || controls.keys?.size) {
    coach.on = false; coach.done = true; document.body.classList.remove('coaching');
    try { localStorage.setItem('onetake.coached', '1'); } catch (e) {}
  }
}

// ---------------- audio glue (sound panel main-glue.js): rooms, proximity, bumps, scrapes
// Room probe: 10 BVH rays, 2 per frame -> hall convolver / tube flutter. Impacts from drone.bump rising, scrapes
// from drone.contactN; no flight.js change. Proximity comb reads world.lastDist (set by the skim/take code).
const room = { i: 0, up: [0, 0, 0, 0], h: [40, 40, 40, 40, 40, 40], hall: 0, tube: 0, tubeD: 3, roof: 0 };
const _rr = new THREE.Ray(), c01 = (x) => Math.max(0, Math.min(1, x));
const RD = [[0, 1, 0], [0.707, 0.707, 0], [-0.354, 0.707, 0.612], [-0.354, 0.707, -0.612]];
for (let k = 0; k < 6; k++) RD.push([Math.cos(k * Math.PI / 3), 0, Math.sin(k * Math.PI / 3)]);
function probeRoom() {
  if (!world.bvh) { room.hall = room.tube = room.roof = 0; return; }
  for (let k = 0; k < 2; k++) {
    const j = room.i++ % 10, d = RD[j];
    _rr.origin.copy(drone.pos); _rr.direction.set(d[0], d[1], d[2]);
    const hit = world.bvh.raycastFirst(_rr, THREE.DoubleSide, 0, 40);
    if (j < 4) room.up[j] = hit ? 1 : 0; else room.h[j - 4] = hit ? hit.distance : 40;
  }
  const u = room.up, roof = Math.max((2 * u[0] + u[1] + u[2] + u[3]) / 5, 0.9 * (u[1] + u[2] + u[3]) / 3);   // chimney top is open
  const hs = room.h.slice().sort((a, b) => a - b), hHit = hs.filter((v) => v < 40).length / 6;
  const narrow = (hs[0] + hs[1]) / 2, mean = hs.reduce((a, b) => a + b, 0) / 6;
  room.roof = roof;
  room.tube = roof * c01((6 - narrow) / 4) * c01((15 - mean) / 8);          // chimney, conveyor gallery
  room.hall = roof * hHit * c01((mean - 3) / 9) * (1 - room.tube);          // factory hall, workshop
  room.tubeD = Math.max(1.2, narrow);
}
let lastBump = 0, hitNow = 0, thudNow = 0, wasCrashed = false;
const ax = { dist: Infinity, hall: 0, tube: 0, tubeD: 3, scrape: 0 };
function audioFrame(now) {
  probeRoom();
  const bumpUp = drone.bump - lastBump; lastBump = drone.bump;
  hitNow = bumpUp > 0.03 && !drone.crashed ? drone.bump * 4 : 0;             // bump = min(1, impact/4) on every impact > 0.4 m/s
  if (hitNow) audio.hit(hitNow);
  if (drone.crashed && !wasCrashed) {                                       // crash edge: thud (audio.js de-dupes onCrash's), trim the clip
    thudNow = Math.max(4, drone.lastImpact || 0); audio.thud(thudNow);
    if (!clipEndT || clipEndT < now) clipEndT = now + 1.2;
  }
  wasCrashed = drone.crashed;
  ax.dist = world.lastDist; ax.hall = room.hall; ax.tube = room.tube; ax.tubeD = room.tubeD;
  ax.scrape = drone.contactN.lengthSq() > 0 && !drone.crashed ? drone.vel.length() : 0;
}

// ---------------- iOS lifecycle: swipe-back guard
function armBack() { try { if (!history.state?.onetake) history.pushState({ onetake: 1 }, ''); } catch (e) {} }

// ---------------- main loop
let last = performance.now(), acc30 = 0, frameN = 0, menuFrames = 0;
const PHYS = 1 / 240;
const MANUAL = new URLSearchParams(location.search).has('manual');
function frame(now) {
  if (!MANUAL) requestAnimationFrame(frame);
  let dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (S.fps === '30') { acc30 += dt; if (acc30 < 1 / 30 - 0.006) return; dt = Math.min(0.1, acc30); acc30 = 0; }
  frameN++;
  fpv.frameTiming(dt * 1000);
  const inp = controls.poll(dt);

  if (state === 'fly' || state === 'crash') {
    flightT += state === 'fly' ? dt : 0;
    const steps = Math.max(1, Math.ceil(dt / PHYS)); const h = dt / steps;
    for (let i = 0; i < steps; i++) drone.step(h, inp, S.mode, world);
    if (drone.crashed && state === 'fly') { state = 'crash'; }
    if (world.bounds && !world.bounds.containsPoint(drone.pos)) {
      for (const e of take.fail()) takeEvent(e);      // leaving the world ends a take like a crash
      $('fade').style.opacity = 1; setTimeout(respawn, 380); state = 'loading';
    }
    updateProx();
    if (state !== 'loading') updateTake(dt, inp);
    rigCamera(dt);
    trackSafe(dt, now / 1000);
    audioFrame(now / 1000);
    uiFrame(dt);
    pushReplay(now / 1000);
  }
  if (!world.mesh && !world.scene) return;

  if (state === 'replay') {
    const f = replayFrame();
    if (f) {
      camPose.pos.copy(f.p); camPose.quat.copy(f.q); motion.vel.copy(f.v); motion.ang.copy(f.w); motion.vib = f.vib; motion.hz = f.hz;
      audio.update(f.m, f.s, f.wash, f.c, false, f.ax);
    }
  } else {
    audio.update(drone.motors, drone.vel.length(), drone.wash ?? 0, drone.crashed, state === 'menu' || state === 'loading', ax);
  }
  // paused: render one frame under the menu blur, then stop (battery + no GPU work behind the blur)
  if (state === 'menu' && (!loadedId || menuFrames++ > 1)) return;
  if (state !== 'menu') menuFrames = 0;
  world.update?.(camPose.pos, dt, camPose.quat);   // [A] quat: the live shadow map leads the view
  fpv.render(world, camPose, motion, dt);
  if (state === 'replay' && replay) compFrame();
  updateHud(dt);
}

// ---------------- boot
buildWorlds();
layout();
applySettings();
syncSegs();
renderProgress();
// iOS Safari can't hide its bars (no Fullscreen API on iPhone); the Home Screen app has none and no swipe-back.
// navigator.standalone is false only in iOS WebKit browsers outside the Home Screen. Dismissal is remembered.
{
  let off = false; try { off = localStorage.getItem('onetake.a2hs') === '1'; } catch (e) {}
  $('a2hs').classList.toggle('hidden', !(navigator.standalone === false || params.has('a2hs')) || off);
  $('a2hsX').onclick = () => { $('a2hs').classList.add('hidden'); try { localStorage.setItem('onetake.a2hs', '1'); } catch (e) {} };
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (state === 'replay') { endReplay(true); toast('CLIP CANCELLED'); }   // rAF stops in the background: the recording would be junk
  if (state === 'fly' || state === 'crash') openMenu();
  audio.idle?.();
});
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); loadError('Graphics reset', 'The GPU context was lost. Reload to keep flying.', false); });
// iOS: calls / Siri / Control Center leave the context 'interrupted' without visibilitychange; any touch recovers it
document.addEventListener('touchend', () => { if (state === 'fly' || state === 'crash' || state === 'replay') audio.kick?.(); }, { passive: true });
if ('onStickStart' in controls) controls.onStickStart = (side) => stickStart(side);   // E's controls.js hook
else { document.addEventListener('touchstart', flyOnTouch, { passive: true }); document.addEventListener('mousedown', flyOnTouch); }
window.addEventListener('keydown', (e) => { if (/^(Key[WASD]|Arrow)/.test(e.code)) flyOnTouch(e); });
// iOS: a left-edge swipe-back pauses instead of leaving the page
window.addEventListener('popstate', () => {
  if (state === 'replay') { endReplay(true); toast('CLIP CANCELLED'); }
  if (!$('clip').classList.contains('hidden')) { $('clip').classList.add('hidden'); $('clipVid').pause(); }
  if (state === 'fly' || state === 'crash') openMenu();
});
window.__onetake = {
  S, drone, fpv, world, controls, renderer, take, get spark() { return spark; }, startFlight, respawn, applySettings, get state() { return state; },
  ui: { onTakeEvent, pop, warn, toast, showSummary, hideSummary, saveClip, endReplay, openMenu, bindTake, scoreView, smoothReplay, splitAccent, get replay() { return replay; }, replayBuf, room },
  tp(x, y, z, yawDeg = 0, pitchDeg = 0) { drone.reset(drone.pos.clone().set(x, y, z), yawDeg * DEG); if (pitchDeg) drone.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchDeg * DEG)); camQ.copy(drone.q); fpv.resetExposure = true; state = 'fly'; },
  // test hook (?manual): advance n frames of dtMs each and return the canvas
  step(dtMs = 16.7, n = 1, grab = true) { for (let i = 0; i < n; i++) { last = performance.now() - dtMs; frame(performance.now()); } return grab ? canvas.toDataURL('image/jpeg', 0.92) : null; },
};
if (MANUAL) { setInterval(() => { if (state === 'loading') { last = performance.now() - 16; } }, 500); }
else requestAnimationFrame(frame);
