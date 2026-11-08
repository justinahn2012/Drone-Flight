// main.js — One Take FPV: world loading, game loop, scoring, clips, UI.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH } from 'three-mesh-bvh';
import { FPVCamera, LENSES, SHUTTERS } from './fpvcam.js';
import { Drone, CRAFTS } from './flight.js';
import { Controls } from './controls.js';
import { MotorAudio } from './audio.js';
import { Take, defaultTakeUI } from './take.js';

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
}
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => { controls.cancelAll?.(); setTimeout(layout, 250); });   // stale touches = instant full stick

const MODE_HINT = {
  cine: 'Easiest on a phone. Right thumb: push for speed, left/right to carve. Left thumb: climb and turn. Let go and it brakes to a hover.',
  angle: 'Self-levelling with manual throttle. Left stick up/down is throttle; the orange tick on the OSD bar marks hover.',
  acro: 'Expert · best with a gamepad or USB radio. Sticks command rotation rates (Betaflight Actual 200 · 720 · 0.55). No self-levelling.',
};
const GAME_HINT = {
  take: 'One take: fly through named lines to build FLOW. 5 s without a line banks it; a crash loses what isn\'t banked. Hover hands-off for 1.5 s to CUT.',
  free: 'No clock, no take. Crash and you fly on from where you last flew clear.',
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
  if (audio.setMode) audio.setMode(S.sound); else audio.on = S.sound !== 'off';   // C6: on | mix (ambient session) | off
  const B = document.body.classList;
  B.toggle('nohud', S.hud === 'off'); B.toggle('hud-min', S.hud === 'min'); B.toggle('thr', S.mode !== 'cine');
  $('rMode').textContent = { cine: 'CINE', angle: 'ANGLE', acro: 'ACRO' }[S.mode];
  const [ll, rl] = STICK_LBL[S.mode] || STICK_LBL.cine;
  $('lblL').textContent = ll; $('lblR').textContent = rl; $('gLt').textContent = ll; $('gRt').textContent = rl;
  $('modeHint').textContent = MODE_HINT[S.mode];
  $('gameHint').textContent = GAME_HINT[S.game] || '';
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
  document.querySelectorAll('.seg').forEach((seg) => {
    const key = seg.dataset.key;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(S[key]) === b.dataset.v));
  });
}
document.querySelectorAll('.seg').forEach((seg) => {
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
$('cReset').onclick = () => respawn();
$('cClip').onclick = () => saveClip();
$('btnClip')?.addEventListener('click', () => saveClip());   // F1's in-flight landscape CLIP, if present
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
  coachStart();
}

// ---------------- loading
const STICK_COACH = {
  cine: [['LEFT THUMB', 'climb · turn'], ['RIGHT THUMB', 'speed · carve'], ['LET GO', 'brakes to a hover']],
  angle: [['LEFT THUMB', 'throttle · yaw'], ['RIGHT THUMB', 'pitch · roll'], ['LET GO', 'self-levels · you hold throttle']],
  acro: [['LEFT THUMB', 'throttle · yaw'], ['RIGHT THUMB', 'pitch · roll rates'], ['NO SELF-LEVEL', 'expert · gamepad or radio']],
};
const LOAD_TIPS = {
  take: ['<b>Lines</b> are named gaps, holes and dives. Each one adds FLOW; 5 s without one banks the chain.', '<b>CUT</b>: hover hands-off for 1.5 s to end the take and keep everything.', 'A crash loses the <b>unbanked</b> chain. Bank it or push on: your call.'],
  free: ['<b>Free fly</b>: no clock. Crash and you fly on from where you last flew clear.'],
  any: ['<b>CLIP</b> turns your last 60 s into a stabilised, captioned video for your camera roll.', '<b>RESET</b> goes back to your last clear spot; hold it to go back to the start.'],
};
function setLoad(title, frac, text) {
  const L = $('loading');
  if (L.classList.contains('hidden')) {
    // fresh card: the mode's stick diagram + one tip, no error buttons
    L.classList.remove('hidden'); $('ldErr').classList.remove('on'); $('ldCoach').classList.remove('hidden');
    const portrait = document.body.classList.contains('portrait');
    $('ldSticks').innerHTML = (STICK_COACH[S.mode] || STICK_COACH.cine).map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('') +
      (portrait ? '<dt>PORTRAIT</dt><dd>use the radio gimbals below</dd>' : '');
    const tips = [...(LOAD_TIPS[S.game] || []), ...LOAD_TIPS.any];
    $('ldTip').innerHTML = tips[Math.floor(Math.random() * tips.length)];
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

// ---------------- replay buffer + clip export (F2)
// Clips are the Short itself. The replay is re-rendered through the full camera at 1080x1080 and composited into a
// 1080x1920 frame laid out like the reference: the FPV picture on top, the radio's sticks below, captions burned in
// on the picture's bottom edge from each line's t0. Framing is smoothed Gyroflow-style to the reference's jitter and
// the audio is re-synthesised into the track. Output is stepped at a fixed 1/30 s (captureStream(0) + requestFrame),
// so a phone rendering at 45 fps still writes clean 30p. Cuts: LAST 20 S (default), FULL TAKE, SHORT (the lines).
const REPLAY_SEC = 120, CLIP_LAST = 20, CLIP_FPS = 30;
const newBuf = () => ({ frames: [], marks: [], startT: null, endT: null, w: null });   // w: the world it was flown in
let cur = newBuf(), prevBuf = null;            // the take in progress / the previous one: a retry no longer wipes the clip
// respawn() used to wipe the buffer with `replayBuf.length = 0`. C removes that line and uiRespawn() rotates the
// buffers instead; if the old line is still there, this setter turns it into the same rotation.
const replayBuf = { get length() { return cur.frames.length; }, set length(n) { if (!n) rotateClip(); } };
let replay = null, recorder = null, recChunks = [], lastClip = null;
let capNow = null, markNow = null, startNow = false, capEv = null;
let clipEndT = null;                           // end-of-clip trim of the current take (crash/cut + pad), page clock
let clipOpen = false, clipBuf = null, clipKind = 'last', clipWait = 0;
const comp = $('comp'), cctx = comp.getContext('2d');
const lowerT = (F, t) => { let lo = 0, hi = F.length; while (lo < hi) { const m = (lo + hi) >> 1; if (F[m].t < t) lo = m + 1; else hi = m; } return lo; };
// stick positions [Lx, Ly, Rx, Ry] in -1..1 (Mode 2), undoing controls.js's expo so the drawn sticks move like thumbs
const unex = (y, e) => { let v = y; if (e > 0) for (let k = 0; k < 4; k++) v -= (v * (1 - e) + e * v * v * v - y) / ((1 - e) + 3 * e * v * v); return Math.max(-1, Math.min(1, v)); };
function stickPos() {
  const c = controls;
  if (S.mode === 'cine') return [unex(c.yaw, 0.55), unex(c.climb, 0.35), unex(c.roll, 0.55), unex(c.pitch, 0.45)];
  const e = c.padActive ? 0 : 0.2; return [unex(c.yaw, e), c.thr * 2 - 1, unex(c.roll, e), unex(c.pitch, e)];
}
function pushReplay(t) {
  const F = cur.frames, mo = {};
  if (!cur.w) cur.w = world.scene || world.mesh;
  for (const k in motion) if (typeof motion[k] === 'number') mo[k] = motion[k];   // vib, hz (+ E's wash/bump for jello)
  F.push({ t, p: camPose.pos.clone(), q: camPose.quat.clone(), v: motion.vel.clone(), w: motion.ang.clone(), mo, m: drone.motors.slice(), s: drone.vel.length(), wash: drone.wash, c: drone.crashed,
    hit: hitNow, thud: thudNow, ax: { ...ax }, cap: capNow, st: stickPos() });
  if (startNow) { cur.startT = t; startNow = false; }
  if (markNow) { cur.marks.push({ t0: markNow.t0 ?? t, t }); markNow = null; }
  thudNow = 0; capNow = null;
  if (t - F[0].t > REPLAY_SEC + 1) {                       // trim in 1 s chunks (shift() is O(n) on some engines)
    let i = 0; while (i < F.length - 1 && t - F[i].t > REPLAY_SEC) i++;
    F.splice(0, i); const t0 = F[0].t;
    cur.marks = cur.marks.filter((m) => m.t0 >= t0); if (cur.startT != null && cur.startT < t0) cur.startT = t0;
  }
}
// take events (onTakeEvent calls this first): the take start for FULL TAKE, lines for captions and SHORT windows
function clipEvent(e) {
  if (e.type === 'start') startNow = true;
  capEv = e.type === 'line' || e.type === 'repeat' ? e : null;
}
// seconds from the line's pre-gate crossing to now. C1: line/repeat events carry {t0, ago, t} (t0, t on the take's
// stats.time clock, ago = t - t0). Older/partial events: t0 against e.t, the take's clocks, or the page clock.
function lineLag(e) {
  if (typeof e?.ago === 'number' && isFinite(e.ago)) return Math.max(0, Math.min(15, e.ago));
  const t0 = e?.t0; if (typeof t0 !== 'number' || !isFinite(t0)) return 0;
  const tk = curTake();
  for (const c of [e.t, tk?._now, tk?.stats?.time, performance.now() / 1000]) {
    if (typeof c !== 'number' || !isFinite(c)) continue;
    const d = c - t0; if (d >= -0.05 && d <= 15) return Math.max(0, d);
  }
  return 0;
}
// recorded into the replay buffer -> burned into the clip at the line's t0 (when the move began, as in the reference)
function caption(text, flow = 1) {
  const c = { text, flow }, lag = lineLag(capEv); capEv = null;
  const F = cur.frames, n = F.length;
  if (lag < 0.02 || n < 2) { capNow = c; markNow = { t0: null }; return; }
  // walk back `lag` s of flight time (steps clamped like the sim's, so a pause doesn't count); start from the frame
  // being built now (~ one step after the last one pushed)
  let i = n - 1, acc = Math.min(0.1, F[n - 1].t - F[n - 2].t);
  while (i > 0 && acc < lag - 1e-4) { acc += Math.min(0.1, F[i].t - F[i - 1].t); i--; }
  while (i < n - 1 && F[i].cap) i++;                          // two lines on one frame: the next one
  if (F[i].cap) { capNow = c; markNow = { t0: null }; return; }
  F[i].cap = c; markNow = { t0: F[i].t };
}
const bufEnd = (b) => { const F = b.frames, t = F[F.length - 1].t; return b.endT != null ? Math.min(b.endT, t) : t; };
// a take worth keeping: one that went live for 2 s (free fly: 3 s of flight)
function hasTake(b) {
  const F = b.frames; if (F.length < 30) return false;
  if (b.startT != null) return bufEnd(b) - b.startT >= 2;
  return S.game === 'free' && bufEnd(b) - F[0].t >= 3;
}
// respawn (uiRespawn, or the legacy `replayBuf.length = 0`): the finished take becomes the previous one
function rotateClip() {
  if (!cur.frames.length) return;
  if (cur.endT == null && clipEndT != null) cur.endT = clipEndT;
  if (hasTake(cur)) prevBuf = cur;
  cur = newBuf(); capNow = null; markNow = null; startNow = false;
}
// what a CLIP tap exports: the current take, or, when nothing has been flown since a retry, the previous one
function clipSource() {
  const F = cur.frames, tk = curTake();
  const live = { frames: F, marks: cur.marks, startT: cur.startT, endT: clipEndT };
  const idle = F.length < 30 || (S.game === 'free' ? F[F.length - 1].t - F[0].t < 3 : !tk || tk.state === 'ready');
  if (!idle) return live;
  const prev = prevBuf && prevBuf.w === (world.scene || world.mesh) ? prevBuf : null;   // never replay a take in another world/sky
  return prev || (F.length >= 30 ? live : null);
}
// the windows (page-clock s) a cut keeps
function clipPlan(b, kind) {
  const F = b?.frames; if (!F || F.length < 2) return null;
  const end = bufEnd(b), a0 = Math.max(F[0].t, (b.startT ?? F[0].t) - 1);   // 1 s of run-up before the take went live
  if (end - a0 < 0.5) return null;
  if (kind === 'full') return [[a0, end]];
  if (kind !== 'short') return [[Math.max(a0, end - CLIP_LAST), end]];
  // SHORT (design #6): [t0 - 1, t + 1] around each line, windows under 2 s apart merged, hard cuts between them
  const w = b.marks.filter((m) => m.t >= a0 && m.t0 <= end).map((m) => [Math.max(a0, m.t0 - 1), Math.min(end, m.t + 1)]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const x of w) { const L = out[out.length - 1]; if (L && x[0] - L[1] < 2) L[1] = Math.max(L[1], x[1]); else out.push(x.slice()); }
  return out.length ? out : null;
}
const planDur = (w) => (w ? w.reduce((s, [a, b]) => s + b - a, 0) : 0);
function pickMime() {
  const c = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d0028', 'video/mp4', 'video/mp4;codecs=avc1.42E01F', 'video/webm;codecs=vp9', 'video/webm'];
  return c.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}
// Gyroflow-style post stabilisation: Gaussian-smooth the view quaternions using frames before AND after each moment
// (horizon free) into out[4n]. Never blends across a teleport or a pause. Velocity/rotation for the blur stay raw, so
// motion blur keeps the physical shake.
function smoothQ(src, sigma, out) {
  const n = src.length, W = 3 * sigma, k = -1 / (2 * sigma * sigma), seg = new Int32Array(n);
  for (let i = 1, s = 0; i < n; i++) { if (src[i].t - src[i - 1].t > 0.25 || src[i].p.distanceToSquared(src[i - 1].p) > 9) s++; seg[i] = s; }
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const qi = src[i].q, ti = src[i].t;
    if (!(sigma > 1e-4)) { out[4 * i] = qi.x; out[4 * i + 1] = qi.y; out[4 * i + 2] = qi.z; out[4 * i + 3] = qi.w; continue; }
    while (lo < i && (src[lo].t < ti - W || seg[lo] !== seg[i])) lo++;
    let x = 0, y = 0, z = 0, w = 0;
    for (let j = lo; j < n && src[j].t <= ti + W && seg[j] === seg[i]; j++) {
      const q = src[j].q, d = src[j].t - ti, g0 = Math.exp(d * d * k);
      const g = (q.x * qi.x + q.y * qi.y + q.z * qi.z + q.w * qi.w) < 0 ? -g0 : g0;   // same hemisphere
      x += q.x * g; y += q.y * g; z += q.z * g; w += q.w * g;
    }
    const l = Math.hypot(x, y, z, w) || 1; out[4 * i] = x / l; out[4 * i + 1] = y / l; out[4 * i + 2] = z / l; out[4 * i + 3] = w / l;
  }
  return out;
}
function smoothReplay(src, sigma = 0.12) {
  const Q = smoothQ(src, sigma, new Float64Array(src.length * 4));
  return src.map((f, i) => ({ ...f, q: new THREE.Quaternion(Q[4 * i], Q[4 * i + 1], Q[4 * i + 2], Q[4 * i + 3]) }));
}
// Clip stabilisation strength (FPV round 2 #4): measure the clip's own camera jitter the way the FPV panel measured the
// reference (rotation rates between 30p frames, minus their 5-frame mean, RMS per axis, mean of the 3 axes) and bisect
// sigma in [0, 0.12] s to the reference's 3.9 deg/s (Heavy: 3.0). Calm Cine stays nearly raw (it already matches the
// reference: fixed sigmas made it look gimballed); hard acro gets more. Stabilize Off exports raw.
const JIT_TARGET = { light: 3.9, heavy: 3.0 }, SIGMA_MAX = 0.12;
const _ja = new THREE.Quaternion(), _jb = new THREE.Quaternion(), _jp = new THREE.Quaternion(), _jr = new THREE.Quaternion();
function clipJitter(F, wins, Q = null) {
  const qa = (j, o) => (Q ? o.fromArray(Q, 4 * j) : o.copy(F[j].q));
  const s = [0, 0, 0]; let n = 0;
  const flush = (R) => {
    for (let k = 2; k < R.length - 2; k++) {
      for (let a = 0; a < 3; a++) { let m = 0; for (let d = -2; d <= 2; d++) m += R[k + d][a] / 5; s[a] += (R[k][a] - m) ** 2; }
      n++;
    }
    R.length = 0;
  };
  for (const [a, b] of wins) {
    let j = Math.max(0, lowerT(F, a) - 1), have = false; const R = [];
    for (let T = a; T <= b; T += 1 / CLIP_FPS) {
      while (j < F.length - 2 && F[j + 1].t <= T) j++;
      const j1 = Math.min(j + 1, F.length - 1), dt = F[j1].t - F[j].t;
      if (dt > 0.25) { flush(R); have = false; continue; }   // a pause or teleport: a new run
      const u = dt > 0 ? Math.min(1, Math.max(0, (T - F[j].t) / dt)) : 0;
      qa(j, _ja).slerp(qa(j1, _jb), u);
      if (have) {
        _jr.copy(_jp).invert().multiply(_ja); if (_jr.w < 0) { _jr.x = -_jr.x; _jr.y = -_jr.y; _jr.z = -_jr.z; _jr.w = -_jr.w; }
        const ss = Math.sqrt(Math.max(1e-12, 1 - _jr.w * _jr.w)), r = 2 * Math.acos(Math.min(1, _jr.w)) * CLIP_FPS / DEG / ss;
        R.push([_jr.x * r, _jr.y * r, _jr.z * r]);
      }
      _jp.copy(_ja); have = true;
    }
    flush(R);
  }
  return n ? (Math.sqrt(s[0] / n) + Math.sqrt(s[1] / n) + Math.sqrt(s[2] / n)) / 3 : 0;
}
function clipSigma(src, wins) {
  const target = JIT_TARGET[S.stab], raw = clipJitter(src, wins);
  if (!target || raw <= target) return { sigma: 0, jit: raw, raw };
  const Q = new Float64Array(src.length * 4), jit = (sg) => clipJitter(src, wins, smoothQ(src, sg, Q));
  let lo = 0, hi = SIGMA_MAX, jh = jit(hi);
  if (jh >= target) return { sigma: hi, jit: jh, raw };
  for (let k = 0; k < 7; k++) { const m = (lo + hi) / 2, jm = jit(m); if (jm > target) lo = m; else { hi = m; jh = jm; } }
  return { sigma: hi, jit: jh, raw };
}
// a cut -> the output timeline: frames, output time (s), segment (hard cuts) and captions
function buildClip(b, kind) {
  const wins = clipPlan(b, kind); if (!wins) return null;
  const F = b.frames, i0 = Math.max(0, lowerT(F, wins[0][0] - 0.5)), i1 = Math.min(F.length, lowerT(F, wins[wins.length - 1][1] + 0.5) + 1);
  const src = F.slice(i0, i1), st = clipSigma(src, wins);
  const sm = st.sigma > 0 ? smoothReplay(src, st.sigma) : src;
  const f = [], ot = [], seg = [], caps = []; let T = 0, sg = -1, prevT = 0;
  for (const [a, e] of wins) {
    let first = true;
    for (let j = lowerT(sm, a); j < sm.length && sm[j].t <= e; j++) {
      const fr = sm[j];
      if (first || fr.t - prevT > 0.25) { if (f.length) T += 1 / CLIP_FPS; sg++; first = false; }   // hard cut (or a pause in the take)
      else T += Math.min(0.1, fr.t - prevT);                       // hitches collapse like the sim's dt clamp
      prevT = fr.t; f.push(fr); ot.push(T); seg.push(sg);
      if (fr.cap && S.caps !== 'off') caps.push({ t: T, seg: sg, text: fr.cap.text, flow: fr.cap.flow || 1 });
    }
  }
  if (f.length < 15) return null;
  return { kind, f, ot, seg, caps, dur: T, sigma: st.sigma, jit: st.jit, raw: st.raw, cuts: sg };
}
function saveClip(kind = 'last', from = null) {
  if (state === 'replay' || clipOpen) return;
  if (!window.MediaRecorder || !comp.captureStream) { toast('THIS BROWSER CAN\'T RECORD CLIPS'); return; }
  const b = from || clipSource(); if (!b) { toast('FLY FIRST'); return; }
  const C = buildClip(b, kind);
  if (!C) { toast(kind === 'short' ? 'NO LINES IN THIS TAKE YET' : 'FLY FIRST'); return; }
  audio.kick?.(true);                                         // inside the tap: clip audio even with Sound Off
  const mime = pickMime(), big = !mime.includes('42E01F');    // baseline L3.1 tops out at 720p
  const W = big ? 1080 : 720, H = big ? 1920 : 1280;
  comp.width = W; comp.height = H; clipLay = clipLayout(W, H); radioBg = makeRadioBg(clipLay);
  warmFonts(Math.round(W * 0.08));
  let stream = comp.captureStream(0), vt = stream.getVideoTracks()[0];
  if (!vt || typeof vt.requestFrame !== 'function') { stream.getTracks().forEach((t) => t.stop()); stream = comp.captureStream(CLIP_FPS); vt = null; }
  const at = audio.streamDest?.stream.getAudioTracks()[0]; if (at) stream.addTrack(at);
  try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: big ? 12e6 : 6e6, audioBitsPerSecond: 160e3 } : undefined); }
  catch (e) { stream.getVideoTracks().forEach((t) => t.stop()); toast('THIS BROWSER CAN\'T RECORD CLIPS'); return; }
  recChunks = [];
  const rec = recorder;
  rec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  rec.onstop = () => showClip(new Blob(recChunks, { type: rec.mimeType || mime || 'video/mp4' }), { dur: C.dur, caps: C.caps.map((c) => [c.t, c.text]), sigma: C.sigma, jit: C.jit, raw: C.raw, W, H, kind, fixed: !!vt });
  clipBuf = b; clipKind = kind;
  // the replay renders square at the clip width (endReplay -> layout() restores the live size)
  replay = { clip: C, k: -1, i: -1, t: 0, dur: C.dur, wall0: performance.now() / 1000, prev: state, stream, vt, st: null, W,
    letterbox: fpv.look.letterbox, targetMs: fpv.targetMs };
  renderer.setSize(W, W, false); fpv.resize(W, W); fpv.look.letterbox = 0; fpv.targetMs = 1000 / CLIP_FPS; fpv.resetExposure = true;
  const r0 = replay; r0.stopTm = setTimeout(() => { if (replay === r0) endReplay(); }, Math.round((C.dur + 1.5 / CLIP_FPS) * 1000));   // ends on time even if frames run slow
  state = 'replay'; controls.enabled = false; controls.cancelAll?.();
  $('crashBar').classList.add('hidden'); $('banner').classList.add('hidden');
  comp.classList.remove('hidden'); fitComp(true); document.body.classList.add('replaying');
  $('recT').textContent = `REPLAY 0:00 / ${fmtS(C.dur)}`; $('recP').style.width = '0%';
  rec.start(250);
}
// next 30p output frame, paced by the wall clock: null when none is due (nothing to render this rAF). A slow device
// skips output frames instead of stretching time, so the video stays in sync with the real-time audio.
function replayFrame() {
  const r = replay, C = r.clip;
  const due = Math.floor((performance.now() / 1000 - r.wall0) * CLIP_FPS + 1e-6);
  if (due <= r.k) return null;
  const T = due / CLIP_FPS;
  if (T > C.dur + 0.5 / CLIP_FPS) { endReplay(); return null; }
  const step = r.k < 0 ? 1 : due - r.k; r.k = due; r.t = Math.min(T, C.dur);
  let i = r.i; const n = C.f.length;
  if (i < 0) { i = 0; audio.snap?.(); }
  while (i < n - 1 && C.ot[i + 1] <= T) {
    i++; const fr = C.f[i];
    if (C.seg[i] !== C.seg[i - 1]) { audio.snap?.(); fpv.resetExposure = true; }   // hard cut: no glide or AE drift across it
    if (fr.hit) audio.hit(fr.hit); if (fr.thud) audio.thud(fr.thud);               // bumps + crash land in the clip
  }
  r.i = i;
  const a = C.f[i], b = i + 1 < n && C.seg[i + 1] === C.seg[i] ? C.f[i + 1] : null;
  const u = b ? Math.max(0, Math.min(1, (T - C.ot[i]) / Math.max(1e-6, C.ot[i + 1] - C.ot[i]))) : 0;
  return { a, b, u, dt: step / CLIP_FPS };
}
// replay pose at the output frame: positions/rates lerped, the view slerped between the two recorded frames
function replayPose(f) {
  const { a, b, u } = f;
  if (canvas.width !== replay.W || canvas.height !== replay.W) { renderer.setSize(replay.W, replay.W, false); fpv.resize(replay.W, replay.W); fitComp(true); }   // a rotate mid-replay
  if (b) {
    camPose.pos.copy(a.p).lerp(b.p, u); camPose.quat.copy(a.q).slerp(b.q, u); motion.vel.copy(a.v).lerp(b.v, u); motion.ang.copy(a.w).lerp(b.w, u);
    for (const k in a.mo) motion[k] = a.mo[k] + ((b.mo[k] ?? a.mo[k]) - a.mo[k]) * u;
    replay.st = a.st.map((v, k) => v + (b.st[k] - v) * u);
  } else {
    camPose.pos.copy(a.p); camPose.quat.copy(a.q); motion.vel.copy(a.v); motion.ang.copy(a.w); Object.assign(motion, a.mo); replay.st = a.st;
  }
  audio.update(a.m, a.s, a.wash, a.c, false, a.ax);
}
function endReplay(cancel = false) {
  if (!replay) return;
  const r = replay; replay = null; clearTimeout(r.stopTm);
  if (cancel && recorder) { recorder.onstop = null; recorder.ondataavailable = null; recChunks = []; }
  try { recorder?.stop(); } catch (e) {}
  r.stream?.getVideoTracks().forEach((t) => t.stop());   // the canvas track only: the audio track is shared by every clip
  document.body.classList.remove('replaying');
  fpv.look.letterbox = r.letterbox; fpv.targetMs = r.targetMs; layout();
  state = r.prev === 'crash' ? 'crash' : 'fly';
  if (sum.data || state === 'crash') showSummary(sum.kind || 'crash', sum.data);   // put the card back
  fpv.resetExposure = true;
  if (cancel) { comp.classList.add('hidden'); fitComp(false); controls.enabled = true; if (!audio.on) audio.idle?.(); return; }
  // the encode finishes in onstop -> showClip: stay paused (last composite on screen) until the modal is up
  pauseForClip();
  clearTimeout(clipWait); clipWait = setTimeout(() => { if ($('clip').classList.contains('hidden')) closeClip(); }, 6000);
}
// ---- 9:16 composite: FPV picture (square) on top, the radio's sticks below, the caption on the picture's bottom edge
let clipLay = null, radioBg = null;
function clipLayout(W, H) {
  const top = Math.round(H * 0.034), u = W / 1080, rad = { x: 0, y: top + W, w: W, h: H - top - W };
  const cy = rad.y + rad.h * 0.47, well = Math.round(330 * u);
  return { W, H, u, pic: { x: 0, y: top, w: W, h: W }, rad, well, wells: [[W * 0.255, cy], [W * 0.745, cy]], scr: { x: W / 2 - 84 * u, y: rad.y + 70 * u, w: 168 * u, h: 104 * u } };
}
const rrect = (g, x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
// the static part: black bands, a graphite radio face (as under the reference's stick cam), gimbal wells, the screen bezel
function makeRadioBg(L) {
  const c = document.createElement('canvas'); c.width = L.W; c.height = L.H;
  const g = c.getContext('2d'), R = L.rad, u = L.u;
  g.fillStyle = '#000'; g.fillRect(0, 0, L.W, L.H);
  const body = g.createLinearGradient(0, R.y, 0, R.y + R.h);
  body.addColorStop(0, '#2a2c30'); body.addColorStop(0.35, '#1c1d20'); body.addColorStop(1, '#0b0c0d');
  g.fillStyle = body; rrect(g, 18 * u, R.y + 22 * u, L.W - 36 * u, R.h + 80 * u, 70 * u); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 2 * u; g.stroke();
  for (const [cx, cy] of L.wells) {
    const s = L.well, x = cx - s / 2, y = cy - s / 2;
    const wg = g.createLinearGradient(0, y, 0, y + s); wg.addColorStop(0, '#060607'); wg.addColorStop(1, '#141517');
    g.fillStyle = wg; rrect(g, x, y, s, s, 40 * u); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 3 * u; g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 2 * u; g.beginPath();
    g.moveTo(cx, y + 26 * u); g.lineTo(cx, y + s - 26 * u); g.moveTo(x + 26 * u, cy); g.lineTo(x + s - 26 * u, cy); g.stroke();
    g.fillStyle = '#0d0e10'; g.beginPath(); g.arc(cx, cy, 64 * u, 0, 6.2832); g.fill();          // gimbal boot
  }
  const S2 = L.scr; g.fillStyle = '#050607'; rrect(g, S2.x - 8 * u, S2.y - 8 * u, S2.w + 16 * u, S2.h + 16 * u, 14 * u); g.fill();
  g.fillStyle = '#0d1a22'; rrect(g, S2.x, S2.y, S2.w, S2.h, 8 * u); g.fill();
  return c;
}
function drawSticks(g, L, st, t) {
  const u = L.u, travel = L.well / 2 - 70 * u;
  L.wells.forEach(([cx, cy], side) => {
    const x = cx + (st[side * 2] || 0) * travel, y = cy - (st[side * 2 + 1] || 0) * travel;
    g.strokeStyle = '#08090a'; g.lineCap = 'round'; g.lineWidth = 30 * u; g.beginPath(); g.moveTo(cx, cy); g.lineTo(x, y); g.stroke();   // shaft
    const k = g.createRadialGradient(x - 14 * u, y - 16 * u, 4 * u, x, y, 50 * u);
    k.addColorStop(0, '#7a7e85'); k.addColorStop(0.45, '#3a3d42'); k.addColorStop(1, '#151618');
    g.fillStyle = k; g.beginPath(); g.arc(x, y, 50 * u, 0, 6.2832); g.fill();                    // stick end
    g.setLineDash([5 * u, 5 * u]); g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 6 * u;
    g.beginPath(); g.arc(x, y, 40 * u, 0, 6.2832); g.stroke(); g.setLineDash([]);                  // knurl
  });
  const S2 = L.scr;
  g.fillStyle = 'rgba(190,225,255,.78)'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `600 ${Math.round(22 * u)}px ui-monospace, Menlo, monospace`;
  g.fillText({ cine: 'CINE', angle: 'ANGLE', acro: 'ACRO' }[S.mode] || 'CINE', S2.x + S2.w / 2, S2.y + S2.h * 0.3);
  g.font = `700 ${Math.round(34 * u)}px ui-monospace, Menlo, monospace`;
  g.fillText(fmt(t), S2.x + S2.w / 2, S2.y + S2.h * 0.68);
}
function compFrame() {
  const L = clipLay, g = cctx, r = replay, C = r.clip;
  g.drawImage(radioBg, 0, 0);
  g.drawImage(canvas, 0, 0, canvas.width, canvas.height, L.pic.x, L.pic.y, L.pic.w, L.pic.h);   // WebGL frame (still valid in this task)
  drawSticks(g, L, r.st || [0, 0, 0, 0], r.t);
  let cap = null;
  for (const c of C.caps) { if (c.t <= r.t + 1e-6) cap = c; else break; }
  if (cap && cap.seg === C.seg[r.i]) drawCaption(g, L.pic, cap.text, cap.flow, r.t - cap.t);   // never across a hard cut
  r.vt?.requestFrame?.();
}
// the composite on screen while it renders: 9:16 fitted in the view, black around it
function fitComp(on) {
  const s = comp.style;
  if (!on) { s.width = s.height = s.left = s.top = s.boxShadow = ''; return; }
  const V = $('view'), vw = V.clientWidth || innerWidth, vh = V.clientHeight || innerHeight, k = Math.min(vw / comp.width, vh / comp.height);
  s.width = Math.round(comp.width * k) + 'px'; s.height = Math.round(comp.height * k) + 'px';
  s.left = Math.round((vw - comp.width * k) / 2) + 'px'; s.top = Math.round((vh - comp.height * k) / 2) + 'px'; s.boxShadow = '0 0 0 100vmax #000';
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
// reference Shorts caption on the FPV picture's bottom edge: cap height ~5.5 % of the picture width, baseline 4 % up
function drawCaption(g, box, text, flow, age) {
  if (age < 0 || age > CAP_DUR) return;
  const fs = Math.round(box.w * 0.08);
  const parts = splitAccent(text).map((s, i) => [s, i === 1 ? ACC : '#fff']).filter((p) => p[0]);
  g.save();
  g.font = `900 ${fs}px Montserrat, "Barlow Condensed", system-ui, sans-serif`;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.lineJoin = 'round'; g.miterLimit = 2;
  const ws = parts.map((p) => g.measureText(p[0]).width), tw = ws.reduce((a, b) => a + b, 0);
  const fit = Math.min(1, (box.w * 0.9) / Math.max(1, tw));
  const k = Math.min(1, age / 0.16), popS = 1 + 0.25 * (1 - k) * (1 - k);
  g.globalAlpha = Math.max(0, Math.min(1, age / 0.05, (CAP_DUR - age) / 0.25));
  g.translate(box.x + box.w / 2, box.y + box.h * 0.96); g.scale(fit * popS, fit * popS);
  g.lineWidth = fs * 0.18; g.strokeStyle = '#000';
  g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = fs * 0.12; g.shadowOffsetY = fs * 0.05;
  let x = -tw / 2; parts.forEach((p, i) => { g.strokeText(p[0], x, 0); x += ws[i]; });
  g.shadowColor = 'transparent';
  x = -tw / 2; parts.forEach((p, i) => { g.fillStyle = p[1]; g.fillText(p[0], x, 0); x += ws[i]; });
  if (flow >= 6) { g.textAlign = 'center'; g.font = `${Math.round(fs * 1.3)}px system-ui, "Apple Color Emoji", sans-serif`; g.fillText('😮', 0, -fs * 1.12); }
  g.restore();
}
// ---- clip modal: pauses the game (frame() early-out, controls off, live audio muted); other cuts re-render from it
let clipURL = null;
function pauseForClip() {
  clipOpen = true; controls.enabled = false; controls.cancelAll?.();
  audio.update(drone.motors, 0, 0, drone.crashed, true, ax);                      // fade the live game sound out
  setTimeout(() => { if (clipOpen && state !== 'replay') audio.idle?.(); }, 250);
}
function showClip(blob, info = {}) {
  clearTimeout(clipWait);
  if (clipURL) URL.revokeObjectURL(clipURL);
  clipURL = URL.createObjectURL(blob); lastClip = { blob, info };
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const v = $('clipVid'); v.src = clipURL;
  v.muted = false; v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });   // with its sound where autoplay allows
  const a = $('clipSave'); a.href = clipURL; a.download = `onetake-${Date.now()}.${ext}`;
  const file = new File([blob], a.download, { type: blob.type });
  const canShare = !!navigator.canShare?.({ files: [file] });
  // the share sheet is the primary save on iOS ("Save Video" -> Photos); <a download> only reaches Files
  $('clipShare').textContent = canShare ? 'SAVE VIDEO' : 'DOWNLOAD';
  a.classList.toggle('hidden', !canShare);
  const nc = info.caps?.length || 0;
  $('clipMeta').textContent = `${fmtS(Math.round(info.dur || 0))} · ${info.W}×${info.H} · 30p${info.sigma > 0 ? ' · stabilised' : ''}${nc ? ` · ${nc} caption${nc > 1 ? 's' : ''}` : ''}`;
  syncCuts();
  pauseForClip();
  $('clip').classList.remove('hidden'); comp.classList.add('hidden'); fitComp(false);
  $('clipShare').onclick = async () => {
    if (canShare) { try { await navigator.share({ files: [file], title: 'One Take' }); } catch (e) {} }
    else a.click();
  };
}
const CUT_NAME = { short: 'SHORT', last: 'LAST 20 S', full: 'FULL TAKE' };
function syncCuts() {
  const b = clipBuf;
  $('clipCuts').querySelectorAll('button[data-cut]').forEach((el) => {
    const k = el.dataset.cut, w = b ? clipPlan(b, k) : null;
    el.disabled = !w; el.classList.toggle('on', k === clipKind);
    el.textContent = CUT_NAME[k] + (w && k !== 'last' ? ` ${fmtS(planDur(w))}` : '');
  });
}
function closeClip() {
  clearTimeout(clipWait);
  $('clip').classList.add('hidden'); $('clipVid').pause(); comp.classList.add('hidden'); fitComp(false);
  if (!clipOpen) return;
  clipOpen = false;
  if (state === 'fly' || state === 'crash') controls.enabled = true;
  audio.kick?.();                                              // inside the CLOSE tap
}
$('clipClose').onclick = () => closeClip();
$('clipCuts').addEventListener('click', (e) => {
  const el = e.target.closest('button[data-cut]'); if (!el || el.disabled || el.dataset.cut === clipKind) return;
  const b = clipBuf; closeClip(); saveClip(el.dataset.cut, b);
});

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
  setPop('line', (flow >= 6 ? '<span class="emo">😮</span>' : '') + accentHTML(text), subHTML, CAP_DUR);
}
function setPop(kind, capHTML, subHTML, dur) {
  const p = $('pop'); popKind = kind;
  p.querySelector('.cap').innerHTML = capHTML; p.querySelector('.sub').innerHTML = subHTML || '';
  p.className = kind; p.style.setProperty('--popDur', dur + 's');
  void p.offsetWidth; p.classList.add('show');
  clearTimeout(popTm); popTm = setTimeout(() => { p.classList.remove('show'); popKind = ''; }, dur * 1000);
  $('live').classList.remove('show');
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
  hudT += dt; if (hudT < 0.1) return; hudT = 0;
  if (state === 'replay' && replay) {
    $('recT').textContent = `REPLAY ${fmtS(replay.t)} / ${fmtS(replay.dur)}`;
    $('recP').style.width = Math.min(100, 100 * replay.t / Math.max(0.01, replay.dur)).toFixed(1) + '%';
    return;
  }
  const v = scoreView();
  const spd = drone.vel.length(), kmh = Math.round(spd * 3.6), time = v.time ?? flightT;
  thrS += ((drone.thrust / drone.tMax || 0) - thrS) * 0.3;
  // --- HD OSD (landscape)
  $('score').textContent = fmtN(v.total);
  $('best').textContent = v.best ? `BEST ${fmtN(Math.max(v.best, v.total))}` : '';
  $('spd').innerHTML = `${kmh} <small>KM/H</small>`;
  $('tmr').textContent = fmt(time);
  $('oAlt').innerHTML = `${Math.max(0, drone.pos.y).toFixed(1)}<small>M</small>`;
  $('oVolt').innerHTML = `${Math.max(13.6, 16.8 - 0.9 * thrS - 0.25 * flightT / 60).toFixed(1)}<small>V</small>`;
  $('oMode').textContent = { cine: 'CINE', angle: 'ANGL', acro: 'ACRO' }[S.mode];
  lqS += ((100 - 4 * room.roof - 9 * room.tube - (Math.random() < 0.1 ? 2 : 0)) - lqS) * 0.25;
  $('oLQ').textContent = `LQ ${Math.round(Math.min(100, lqS))}`;
  if (S.mode !== 'cine') {
    $('oThr').querySelector('i').style.height = (controls.thr * 100).toFixed(1) + '%';
    $('oThr').querySelector('u').style.bottom = (Math.sqrt(1 / drone.c.twr) * 100).toFixed(1) + '%';
  }
  const tag = $('takeTag'), ts = v.take ? v.state : null;
  tag.className = 'o tl' + (ts ? ' on' : '') + (ts === 'live' ? ' live' : '');
  if (ts) $('takeTxt').textContent = ts === 'live' ? `TAKE ${fmt(time)}` : ts === 'done' ? 'CUT' : 'READY';
  // live chain at the caption spot (0.7), only while no caption is up
  const L = $('live');
  if (v.unbanked > 0 && popKind !== 'line' && state === 'fly' && !summaryUp()) {
    L.innerHTML = `${v.take ? 'FLOW' : 'SKIM'}${v.flow >= 2 ? ` <em>×${v.flow}</em>` : ''} · ${fmtN(v.unbanked)}`; L.classList.add('show');
  } else L.classList.remove('show');
  if (drone.limitHit > 0 && performance.now() - lastLimitToast > 2500) { lastLimitToast = performance.now(); warn(drone.pos.y >= (world.envelope?.max.y ?? 1e9) - 0.01 ? 'CEILING' : 'WORLD EDGE'); }
  // --- radio OLED (portrait)
  $('oMd').textContent = { cine: 'CINE', angle: 'ANGLE', acro: 'ACRO' }[S.mode]; $('oT').textContent = fmt(time); $('oS').textContent = `${kmh} KM/H`;
  const bars = world.lastDist < 3 ? Math.max(0, Math.min(4, Math.round(4 - world.lastDist / 0.5))) : 0;
  $('oPx').querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', i < bars));
  $('oSc').textContent = fmtN(v.total);
  $('oSt').textContent = drone.crashed ? 'CRASHED' : drone.limitHit > 0 ? 'LIMIT' :
    v.unbanked > 0 ? `${v.take ? 'FLOW' : 'SKIM'}${v.flow >= 2 ? ' x' + v.flow : ''} +${fmtN(v.unbanked)}` :
    ts === 'live' ? '● TAKE' : ts === 'ready' ? 'READY · FLY A LINE' : ts === 'done' ? 'CUT' :
    S.mode !== 'cine' ? `THR ${Math.round(controls.thr * 100)}%  BEST ${fmtN(v.best)}` : `BEST ${fmtN(v.best)}`;
}

// ---------------- take events (contract #3), summary card, recovery
// main.js dispatch (C): (typeof onTakeEvent === 'function' ? onTakeEvent : (e) => defaultTakeUI(e, pop))(e)
const runStats = { maxSpeed: 0, maxFlow: 1 };
let pendingSum = null, bestAtStart = 0, uiWasCrashed = false, padArmed = false;
const sum = { kind: null, data: null };
function onTakeEvent(e) {
  if (!e || !e.type) return;
  clipEvent(e);                                          // F2: take start / line t0 for clips (caption() stamps at t0)
  const now = performance.now() / 1000;
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
  $('bSub').textContent = kind === 'cut' ? 'That\'s a take · touch a stick for a new one' : isTake ? 'Take over · touch a stick to retry' : 'Touch a stick to fly on';
  const row = (k, val) => `<span>${k}</span><b>${val}</b>`;
  $('bStats').innerHTML = row('MAX SPEED', `${Math.round(maxSp * 3.6)} KM/H`) + row('FLY TIME', fmt(time)) +
    row('SCORE', fmtN(total)) + row('BEST', newBest ? `<em>NEW</em> ${fmtN(best)}` : fmtN(best)) +
    row('MAX FLOW', `×${mf || 1}`) + (lines ? row('LINES', String(lines.length)) : '');
  $('bLines').textContent = lines && lines.length ? [...new Set(lines)].join(' · ') : '';
  $('cReset').textContent = isTake ? 'RETRY' : 'FLY ON';
  $('banner').classList.remove('hidden'); $('crashBar').classList.remove('hidden'); $('live').classList.remove('show');
  document.body.classList.add('sumup');
  padArmed = false;
}
function hideSummary() { $('banner').classList.add('hidden'); $('crashBar').classList.add('hidden'); document.body.classList.remove('sumup'); }
const summaryUp = () => !$('banner').classList.contains('hidden');
function uiRespawn() {
  rotateClip();                                          // F2: the finished take stays clippable after the retry
  hideSummary(); sum.kind = sum.data = null; pendingSum = null; clipEndT = null; capNow = null;
  runStats.maxSpeed = 0; runStats.maxFlow = 1; bestAtStart = scoreView().best || 0;
  lastLI = drone.lastImpact || 0; wasCrashed = uiWasCrashed = false;
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
  if (clipOpen) return;                                  // F2: the clip modal pauses the game (no retry under it)
  if (state === 'crash' && drone.crashT > 0.8) respawn();
  else if (state === 'fly' && sum.kind === 'cut' && summaryUp()) { hideSummary(); sum.kind = sum.data = null; }
}
function flyOnTouch(e) { if (!e.target?.closest?.('button, .ui, input, select, a')) stickStart(null); }

// ---------------- onboarding: ghost gates until each stick has been held 1 s; rotate tip in portrait
const coach = { on: false, held: { L: 0, R: 0 } };
try { coach.done = localStorage.getItem('onetake.coached') === '1'; } catch (e) { coach.done = false; }
let rotateTipped = false;
function coachStart() {
  coach.on = !coach.done; document.body.classList.toggle('coach', coach.on);
  if (!rotateTipped && document.body.classList.contains('portrait')) { rotateTipped = true; setTimeout(() => toast('Full screen: turn off Rotation Lock and turn sideways.', 4.5), 900); }
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
    coach.on = false; coach.done = true; document.body.classList.remove('coach');
    try { localStorage.setItem('onetake.coached', '1'); } catch (e) {}
  }
}

// ---------------- audio glue (sound panel main-glue2.js): rooms, proximity, impacts, scrapes
// Room probe: 10 BVH rays (60 m), 2 per frame -> hall convolver / tube flutter. The hall isn't killed by windows
// (roof^2 * (0.55 + 0.45 * share of walls hit)); the tube needs a shaft (walls close all round: chimney, stair shaft)
// or a low narrow corridor (the conveyor gallery), so column bays no longer read as a tube.
// Impacts: every change of drone.lastImpact (true m/s, uncapped: taps and crashes no longer sound alike).
// Scrapes: proximity contact (world.lastDist < 5 cm), which holds across the physics substeps (contactN only shows
// the last one, so 99 % of scrapes were 1-frame ticks). No flight.js change.
const room = { i: 0, up: [0, 0, 0, 0], ud: [60, 60, 60, 60], h: [60, 60, 60, 60, 60, 60], hall: 0, tube: 0, tubeD: 3, roof: 0 };
const _rr = new THREE.Ray(), c01 = (x) => Math.max(0, Math.min(1, x));
const RD = [[0, 1, 0], [0.707, 0.707, 0], [-0.354, 0.707, 0.612], [-0.354, 0.707, -0.612]];
for (let k = 0; k < 6; k++) RD.push([Math.cos(k * Math.PI / 3), 0, Math.sin(k * Math.PI / 3)]);
function probeRoom() {
  if (!world.bvh) { room.hall = room.tube = room.roof = 0; return; }
  for (let k = 0; k < 2; k++) {
    const j = room.i++ % 10, d = RD[j];
    _rr.origin.copy(drone.pos); _rr.direction.set(d[0], d[1], d[2]);
    const hit = world.bvh.raycastFirst(_rr, THREE.DoubleSide, 0, 60);
    if (j < 4) { room.up[j] = hit ? 1 : 0; room.ud[j] = hit ? hit.distance : 60; } else room.h[j - 4] = hit ? hit.distance : 60;
  }
  const u = room.up, h = room.h, roof = Math.max((2 * u[0] + u[1] + u[2] + u[3]) / 5, 0.9 * (u[1] + u[2] + u[3]) / 3);   // chimney top is open
  const hs = h.slice().sort((a, b) => a - b), hHit = hs.filter((v) => v < 60).length / 6, mean = Math.min(40, hs.reduce((a, b) => a + b, 0) / 6);
  const wmin = Math.min(h[0] + h[3], h[1] + h[4], h[2] + h[5]);                      // narrowest wall-to-wall width (opposite rays)
  const shaft = c01((5 - hs[4]) / 2);                                                  // walls close all round
  const corridor = c01((3.5 - room.ud[0]) / 1.5) * c01((5 - wmin) / 2);                // low ceiling + narrow
  room.roof = roof;
  room.tube = roof * Math.max(shaft, corridor);
  room.hall = roof * roof * (0.55 + 0.45 * hHit) * c01((mean - 3) / 9) * (1 - room.tube);
  room.tubeD = Math.max(1.2, shaft >= corridor ? (hs[0] + hs[1] + hs[2]) / 3 : wmin / 2);
}
let lastLI = 0, hitNow = 0, thudNow = 0, wasCrashed = false;
const ax = { dist: Infinity, hall: 0, tube: 0, tubeD: 3, scrape: 0 };
function audioFrame(now) {
  probeRoom();
  hitNow = 0;
  if (drone.lastImpact !== lastLI) { lastLI = drone.lastImpact; if (!drone.crashed && lastLI > 0.4) { hitNow = lastLI; audio.hit(hitNow); } }
  if (drone.crashed && !wasCrashed) {                                       // crash edge: thud (audio.js de-dupes onCrash's), trim the clip
    thudNow = Math.max(4, drone.lastImpact || 0); audio.thud(thudNow);
    if (!clipEndT || clipEndT < now) clipEndT = now + 1.2;
  }
  wasCrashed = drone.crashed;
  ax.dist = world.lastDist; ax.hall = room.hall; ax.tube = room.tube; ax.tubeD = room.tubeD;
  ax.scrape = world.lastDist < 0.05 && !drone.crashed ? drone.vel.length() : 0;
}

// ---------------- iOS lifecycle: swipe-back guard
function armBack() { try { if (!history.state?.onetake) history.pushState({ onetake: 1 }, ''); } catch (e) {} }

// ---------------- main loop
let last = performance.now(), acc30 = 0, frameN = 0, menuFrames = 0;
const PHYS = 1 / 240;
const MANUAL = new URLSearchParams(location.search).has('manual');
function frame(now) {
  if (!MANUAL) requestAnimationFrame(frame);
  if (clipOpen) { last = now; return; }             // F2: clip modal up (or encoding): the game is paused
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
    const f = replayFrame();                        // F2: fixed 30p, paced by the wall clock
    if (!f) { updateHud(dt); return; }              // no output frame due (or the replay just ended): nothing to render
    replayPose(f); dt = f.dt;
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
  if (clipOpen || !$('clip').classList.contains('hidden')) closeClip();
  if (state === 'fly' || state === 'crash') openMenu();
});
window.__onetake = {
  S, drone, fpv, world, controls, renderer, take, get spark() { return spark; }, startFlight, respawn, applySettings, get state() { return state; },
  ui: { onTakeEvent, pop, warn, toast, showSummary, hideSummary, saveClip, endReplay, openMenu, bindTake, scoreView, smoothReplay, splitAccent, get replay() { return replay; }, room, audio,
    replayBuf, get frames() { return cur.frames; }, get prevBuf() { return prevBuf; }, get curBuf() { return cur; }, clipSource, clipPlan, buildClip, clipJitter, closeClip, get clipOpen() { return clipOpen; }, get lastClip() { return lastClip; } },
  tp(x, y, z, yawDeg = 0, pitchDeg = 0) { drone.reset(drone.pos.clone().set(x, y, z), yawDeg * DEG); if (pitchDeg) drone.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchDeg * DEG)); camQ.copy(drone.q); fpv.resetExposure = true; state = 'fly'; },
  // test hook (?manual): advance n frames of dtMs each and return the canvas
  step(dtMs = 16.7, n = 1, grab = true) { for (let i = 0; i < n; i++) { last = performance.now() - dtMs; frame(performance.now()); } return grab ? canvas.toDataURL('image/jpeg', 0.92) : null; },
};
if (MANUAL) { setInterval(() => { if (state === 'loading') { last = performance.now() - 16; } }, 500); }
else requestAnimationFrame(frame);
