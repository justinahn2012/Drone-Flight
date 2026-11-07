// main.js — One Take FPV: world loading, game loop, scoring, clips, UI.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH } from 'three-mesh-bvh';
import { FPVCamera, LENSES, SHUTTERS } from './fpvcam.js';
import { Drone, CRAFTS } from './flight.js';
import { Controls } from './controls.js';
import { MotorAudio } from './audio.js';

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
const STAB = { off: 0, light: 0.03, heavy: 0.09 };

// ---------------- settings
const DEF = { v: 3, world: 'yard', mode: 'cine', craft: 'auto', shutter: 'nd16', lens: 'ref', stab: 'light', tilt: -1, frame: 'full', quality: 'auto', splats: '500k', fps: '60', hud: 'on', sound: 'on' };
let S = { ...DEF };
try { const saved = JSON.parse(localStorage.getItem('onetake.settings') || '{}'); if (saved.v !== 3) { delete saved.tilt; delete saved.world; saved.v = 3; } Object.assign(S, saved); } catch (e) {}
if (!['yard', 'yard-overcast', 'file', 'url'].includes(S.world)) S.world = 'yard';
const save = () => { try { localStorage.setItem('onetake.settings', JSON.stringify(S)); } catch (e) {} };
const params = new URLSearchParams(location.search);
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
  if (portrait) vh = Math.round(Math.min(H * 0.6, W * 1.12));
  $('view').style.height = vh + 'px';
  $('radio').style.top = vh + 'px';
  const q = QUALITY[S.quality];
  const dpr = Math.min(window.devicePixelRatio || 1, q.dpr);
  const w = Math.round(W * dpr), h = Math.round(vh * dpr);
  renderer.setSize(w, h, false);
  canvas.style.width = W + 'px'; canvas.style.height = vh + 'px';
  fpv.resize(w, h);
}
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 250));

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
  audio.on = S.sound === 'on';
  document.body.classList.toggle('nohud', S.hud === 'off');
  $('rMode').textContent = { cine: 'CINE', angle: 'ANGLE', acro: 'ACRO' }[S.mode];
  $('lblL').textContent = S.mode === 'cine' ? 'CLIMB · TURN' : 'THROTTLE · YAW';
  const rl = document.querySelectorAll('.wlabel')[1]; if (rl) rl.textContent = S.mode === 'cine' ? 'SPEED · CARVE' : 'PITCH · ROLL';
  $('modeHint').textContent = {
    cine: 'Easiest on a phone. Right thumb: push for speed, left/right to carve. Left thumb: climb and turn. Let go and it brakes to a hover.',
    angle: 'Self-levelling with manual throttle. Left stick up/down is throttle.',
    acro: 'Real FPV. Sticks command rotation rates (Betaflight actual rates). No self-levelling. Flips, dives, power loops.',
  }[S.mode];
  const craftKey = craftFor(world.def);
  if (drone.key !== craftKey) { drone.setCraft(craftKey); }
  const tilt = S.tilt >= 0 ? S.tilt : defTilt(CRAFTS[craftKey]);
  $('tilt').value = tilt; $('tiltV').textContent = tilt + '°';
  fpv.computeLens();
  syncSegs();
  save();
}
const craftFor = (def) => (S.craft !== 'auto' ? S.craft : def?.craft || 'freestyle5');

// ---------------- menu UI
function buildWorlds() {
  const box = $('worlds'); box.innerHTML = '';
  for (const w of WORLDS) {
    const b = document.createElement('button');
    b.className = 'world' + (w.id === S.world ? ' on' : '');
    b.innerHTML = `<b>${w.name}</b><small>${w.note} · ${CRAFTS[w.craft].label}</small>`;
    b.onclick = () => { S.world = w.id; buildWorlds(); $('custom').classList.remove('open'); save(); };
    box.appendChild(b);
  }
  const c = document.createElement('button');
  c.className = 'world custom' + (S.world === 'file' ? ' on' : '');
  c.innerHTML = `<b>Your own world</b><small>Load a splat + collider from this device</small>`;
  c.onclick = () => { S.world = 'file'; buildWorlds(); $('custom').classList.add('open'); };
  box.appendChild(c);
}
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
    applySettings();
    if (key === 'splats' && prev !== S[key]) loadedId = null;
  });
});
$('tilt').addEventListener('input', (e) => { S.tilt = +e.target.value; $('tiltV').textContent = S.tilt + '°'; save(); });
$('openSet').onclick = () => $('settings').classList.toggle('hidden');
$('fly').onclick = () => startFlight(true);
$('resume').onclick = () => startFlight(false);
$('btnMenu').onclick = () => openMenu();
$('rMode').onclick = () => { const order = ['cine', 'angle', 'acro']; S.mode = order[(order.indexOf(S.mode) + 1) % 3]; applySettings(); controls.resetThrottle(Math.sqrt(1 / drone.c.twr)); toast(S.mode.toUpperCase()); };
$('rReset').onclick = () => respawn(true);
$('rClip').onclick = () => saveClip();
$('cReset').onclick = () => respawn();
$('cClip').onclick = () => saveClip();
controls.onButton = (b) => { if (b === 'reset' && (state === 'fly' || state === 'crash')) respawn(state === 'fly'); if (b === 'menu') state === 'menu' ? startFlight(false) : openMenu(); };

function openMenu() {
  if (state === 'replay') return;
  if (state === 'fly' || state === 'crash') prevState = state;
  state = 'menu';
  $('menu').classList.remove('hidden');
  $('resume').style.display = loadedId ? '' : 'none';
  controls.enabled = false;
}
let prevState = 'fly';

async function startFlight(fresh) {
  audio.start();
  const want = S.world;
  const wantKey = want === 'file' ? 'file:' + ($('fSplat').files[0]?.name || '') : want + ':' + S.splats;
  if (fresh || loadedId !== wantKey) {
    let def;
    if (want === 'file') {
      const f = $('fSplat').files[0];
      if (!f) { alert('Choose a splat file first (.spz / .ply).'); return; }
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
  controls.enabled = true;
  if (state !== 'crash') state = 'fly';
}

// ---------------- loading
function setLoad(title, frac, text) {
  $('loading').classList.remove('hidden');
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

function clearWorld() {
  if (world.mesh) { splatScene.remove(world.mesh); world.mesh.dispose?.(); world.mesh = null; }
  if (world.scene) {
    world.scene.traverse((o) => { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : m ? [m] : []).forEach((mm) => { Object.values(mm).forEach((v) => v?.isTexture && v.dispose()); mm.dispose(); }); });
    world.scene.background?.dispose?.(); world.scene.environment?.dispose?.();
  }
  world.scene = null; world.bvh = null; world.colliderScene = null; world.bounds = null; world.envelope = null; world.update = null;
}

async function loadProcWorld(def) {
  const { buildBando } = await import('./world-bando.js');
  const w = await buildBando(renderer, { sky: def.sky, quality: S.quality, onProgress: (f, t) => setLoad(null, f, t) });
  clearWorld();
  Object.assign(world, { scene: w.scene, colliderScene: w.colliderScene, bvh: w.bvh, bounds: w.bounds, envelope: w.envelope, update: w.update, hdr: true });
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
    setLoad('Could not load world', 0, String(err.message || err));
    setTimeout(() => { $('loading').classList.add('hidden'); openMenu(); }, 2600);
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

// open world: after a crash you go back to where you last were flying clear, not to the start
const safePts = []; let safeT = 0;
function trackSafe(dt, now) {
  safeT += dt; if (safeT < 1.0 || drone.crashed) return; safeT = 0;
  if (world.lastDist > 1.2 && drone.vel.length() < 30) { safePts.push({ t: now, p: drone.pos.clone(), yaw: drone.heading }); if (safePts.length > 30) safePts.shift(); }
}
function respawn(toStart = false) {
  drone.setCraft(craftFor(world.def));
  const now = performance.now() / 1000;
  const sp = toStart ? null : [...safePts].reverse().find((s) => now - s.t > 2.0);
  if (sp) drone.reset(sp.p, sp.yaw); else { drone.reset(world.spawn, world.yaw); score.reset(); flightT = 0; }
  if (toStart) safePts.length = 0;
  controls.resetThrottle(Math.sqrt(1 / drone.c.twr));
  camQ.copy(drone.q); fpv.resetExposure = true;
  replayBuf.length = 0;
  state = 'fly';
  $('crashBar').classList.add('hidden'); $('banner').classList.add('hidden');
  $('fade').style.opacity = 0;
}

// ---------------- scoring: proximity "skims"
const score = {
  total: 0, streak: 0, mult: 1, streakT: 0, lastClose: 0, best: 0,
  reset() { this.total = 0; this.streak = 0; this.mult = 1; this.streakT = 0; },
};
try { score.best = +localStorage.getItem('onetake.best') || 0; } catch (e) {}
let popT = 0;
function pop(text) { const p = $('pop'); p.textContent = text; p.classList.add('show'); popT = 1.2; }
function toast(t) { pop(t); }
const _cp = {};
function updateScore(dt, now) {
  if (!world.bvh || drone.crashed) { world.lastDist = Infinity; return; }
  const res = world.bvh.closestPointToPoint(drone.pos, _cp, 0, 2.0);
  const gap = res ? res.distance - drone.c.radius : Infinity;
  world.lastDist = gap;
  const spd = drone.vel.length();
  const zone = drone.key === 'cinewhoop' ? 0.9 : 1.4;
  if (gap < zone && spd > 3) {
    const c = 1 - gap / zone;
    score.streakT += dt;
    score.mult = Math.min(8, 1 + Math.floor(score.streakT / 1.2));
    score.streak += dt * spd * c * c * 60 * score.mult;
    score.lastClose = now;
  } else if (score.streak > 0 && now - score.lastClose > 0.9) {
    const pts = Math.round(score.streak);
    score.total += pts; pop(`SKIM ×${score.mult}  +${pts.toLocaleString()}`);
    score.streak = 0; score.streakT = 0; score.mult = 1;
    if (score.total > score.best) { score.best = score.total; try { localStorage.setItem('onetake.best', score.best); } catch (e) {} }
  }
}
drone.onCrash = (impact) => {
  audio.thud(impact);
  if (score.streak > 0) pop('STREAK LOST');
  score.streak = 0; score.streakT = 0; score.mult = 1;
};

// ---------------- camera rig
const camQ = new THREE.Quaternion();
const tiltQ = new THREE.Quaternion();
// uptilt is matched to cruise attitude: assisted flight cruises at ~10-20 deg of lean, acro at 30+
function defTilt(c) { return Math.round(c.camTilt * (S.mode === 'acro' ? 1 : S.mode === 'angle' ? 0.8 : 0.55)); }
const camPose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
const motion = { vel: new THREE.Vector3(), ang: new THREE.Vector3(), vib: 1 };
const _q = new THREE.Quaternion(), _v = new THREE.Vector3();
function rigCamera(dt) {
  const tilt = (S.tilt >= 0 ? S.tilt : defTilt(drone.c)) * DEG;
  tiltQ.setFromAxisAngle(_v.set(1, 0, 0), tilt);
  _q.copy(drone.q).multiply(tiltQ);
  const tau = STAB[S.stab] || 0;
  if (tau > 0) camQ.slerp(_q, 1 - Math.exp(-dt / tau)); else camQ.copy(_q);
  camPose.quat.copy(camQ);
  camPose.pos.copy(drone.pos).add(_v.set(0, 0.02, -0.04).applyQuaternion(drone.q));
  motion.vel.copy(drone.vel);
  motion.ang.copy(drone.w).applyQuaternion(drone.q);   // physical camera rotation (blur uses the raw motion)
  motion.vib = drone.crashed ? 0.2 : 0.35 + 1.1 * Math.sqrt(drone.thrust / drone.tMax) + drone.wash * 3 + drone.bump * 4;
}

// ---------------- replay buffer + clip export
const replayBuf = []; const REPLAY_SEC = 20;
let replay = null, recorder = null, recChunks = [], recStart = 0;
function pushReplay(t) {
  replayBuf.push({ t, p: camPose.pos.clone(), q: camPose.quat.clone(), v: motion.vel.clone(), w: motion.ang.clone(), vib: motion.vib, m: drone.motors.slice(), s: drone.vel.length(), wash: drone.wash, c: drone.crashed });
  while (replayBuf.length && t - replayBuf[0].t > REPLAY_SEC) replayBuf.shift();
}
function pickMime() {
  const c = ['video/mp4;codecs=avc1.42E01F', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return c.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}
function saveClip() {
  if (state === 'replay' || replayBuf.length < 30) { toast('FLY FIRST'); return; }
  if (!window.MediaRecorder || !canvas.captureStream) { toast('NO RECORDER'); return; }
  const stream = canvas.captureStream(30);
  const at = audio.streamDest?.stream.getAudioTracks()[0]; if (at) stream.addTrack(at);
  const mime = pickMime();
  try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 14e6 } : undefined); }
  catch (e) { toast('NO RECORDER'); return; }
  recChunks = [];
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = () => showClip(new Blob(recChunks, { type: recorder.mimeType || mime || 'video/mp4' }));
  replay = { frames: replayBuf.slice(), t0: performance.now() / 1000, prev: state };
  replay.dur = replay.frames[replay.frames.length - 1].t - replay.frames[0].t;
  state = 'replay'; controls.enabled = false; fpv.resetExposure = true;
  $('crashBar').classList.add('hidden'); $('banner').classList.add('hidden');
  $('recDot').style.display = 'flex'; recStart = performance.now();
  recorder.start(250);
}
function replayFrame() {
  const t = performance.now() / 1000 - replay.t0;
  const f = replay.frames; const t0 = f[0].t;
  if (t >= replay.dur) { endReplay(); return null; }
  let i = 0; while (i < f.length - 1 && f[i + 1].t - t0 <= t) i++;
  return f[i];
}
function endReplay() {
  try { recorder?.stop(); } catch (e) {}
  $('recDot').style.display = 'none';
  state = replay.prev === 'crash' ? 'crash' : 'fly';
  if (state === 'crash') $('crashBar').classList.remove('hidden');
  replay = null; controls.enabled = true;
}
let clipURL = null;
function showClip(blob) {
  if (clipURL) URL.revokeObjectURL(clipURL);
  clipURL = URL.createObjectURL(blob);
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const v = $('clipVid'); v.src = clipURL; v.play().catch(() => {});
  const a = $('clipSave'); a.href = clipURL; a.download = `onetake-${Date.now()}.${ext}`;
  $('clip').classList.remove('hidden');
  $('clipShare').onclick = async () => {
    const file = new File([blob], a.download, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'One Take' }); } catch (e) {} }
    else a.click();
  };
}
$('clipClose').onclick = () => { $('clip').classList.add('hidden'); $('clipVid').pause(); };

// ---------------- HUD / radio OLED
let hudT = 0, flightT = 0, lastLimitToast = 0;
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function updateHud(dt) {
  popT -= dt; if (popT <= 0) $('pop').classList.remove('show');
  hudT += dt; if (hudT < 0.1) return; hudT = 0;
  const kmh = Math.round(drone.vel.length() * 3.6);
  $('spd').textContent = `${kmh} km/h`;
  $('tmr').textContent = fmt(flightT);
  $('score').textContent = Math.round(score.total).toLocaleString();
  $('streak').textContent = score.streak > 0 ? `SKIM ×${score.mult}  ${Math.round(score.streak).toLocaleString()}` : (score.best ? `BEST ${score.best.toLocaleString()}` : '');
  if (state === 'replay') $('recT').textContent = fmt((performance.now() - recStart) / 1000);
  const bars = Math.max(0, Math.min(4, Math.round(4 - world.lastDist / 0.5)));
  const prox = world.lastDist < 3 ? '▮'.repeat(bars).padEnd(4, '▯') : '▯▯▯▯';
  if (drone.limitHit > 0 && performance.now() - lastLimitToast > 2500) { lastLimitToast = performance.now(); pop(drone.pos.y >= (world.envelope?.max.y ?? 1e9) - 0.01 ? 'CEILING' : 'WORLD EDGE'); }
  $('oled').textContent =
    `${{ cine: 'CINE ', angle: 'ANGLE', acro: 'ACRO ' }[S.mode]}  ${fmt(flightT)}\n` +
    `${String(kmh).padStart(3)} km/h  ${prox}\n` +
    `SCORE ${Math.round(score.total).toLocaleString()}\n` +
    (score.streak > 0 ? `SKIM x${score.mult} +${Math.round(score.streak)}` : state === 'replay' ? '● REC REPLAY' : drone.crashed ? 'CRASHED' : drone.limitHit > 0 ? '▲ LIMIT' : `BEST ${score.best.toLocaleString()}`);
}

// ---------------- main loop
let last = performance.now(), acc30 = 0, frameN = 0;
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
    if (state === 'crash' && drone.crashT > 1.1 && $('crashBar').classList.contains('hidden')) {
      $('crashBar').classList.remove('hidden'); $('bTitle').textContent = 'CRASHED'; $('bSub').textContent = `${Math.round(score.total).toLocaleString()} pts`; $('banner').classList.remove('hidden');
    }
    if (world.bounds && !world.bounds.containsPoint(drone.pos)) {
      $('fade').style.opacity = 1; setTimeout(respawn, 380); state = 'loading';
    }
    updateScore(dt, now / 1000);
    rigCamera(dt);
    trackSafe(dt, now / 1000);
    pushReplay(now / 1000);
  }
  if (!world.mesh && !world.scene) return;

  if (state === 'replay') {
    const f = replayFrame();
    if (f) {
      camPose.pos.copy(f.p); camPose.quat.copy(f.q); motion.vel.copy(f.v); motion.ang.copy(f.w); motion.vib = f.vib;
      audio.update(f.m, f.s, f.wash, f.c, false);
    }
  } else {
    audio.update(drone.motors, drone.vel.length(), drone.wash ?? 0, drone.crashed, state === 'menu' || state === 'loading');
  }
  if (state === 'menu' && !loadedId) return;
  world.update?.(camPose.pos, dt, camPose.quat);   // [A] quat: the live shadow map leads the view
  fpv.render(world, camPose, motion, dt);
  updateHud(dt);
}

// ---------------- boot
buildWorlds();
layout();
applySettings();
syncSegs();
document.addEventListener('visibilitychange', () => { if (document.hidden && (state === 'fly' || state === 'crash')) openMenu(); });
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); setLoad('Graphics reset', 0, 'The GPU context was lost — reload the page.'); });
window.__onetake = {
  S, drone, fpv, world, controls, renderer, get spark() { return spark; }, startFlight, respawn, applySettings, get state() { return state; },
  tp(x, y, z, yawDeg = 0, pitchDeg = 0) { drone.reset(drone.pos.clone().set(x, y, z), yawDeg * DEG); if (pitchDeg) drone.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchDeg * DEG)); camQ.copy(drone.q); fpv.resetExposure = true; state = 'fly'; },
  // test hook (?manual): advance n frames of dtMs each and return the canvas
  step(dtMs = 16.7, n = 1, grab = true) { for (let i = 0; i < n; i++) { last = performance.now() - dtMs; frame(performance.now()); } return grab ? canvas.toDataURL('image/jpeg', 0.92) : null; },
};
if (MANUAL) { setInterval(() => { if (state === 'loading') { last = performance.now() - 16; } }, 500); }
else requestAnimationFrame(frame);
