// main.js — One Take FPV: world loading, game loop, scoring, clips, UI.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH } from 'three-mesh-bvh';
import { FPVCamera, LENSES, SHUTTERS, GRADES } from './fpvcam.js';
import { Drone, CRAFTS } from './flight.js';
import { InputLog, quantize, worldHash } from './inputlog.js';
import { Controls } from './controls.js';
import { MotorAudio } from './audio.js';
import { renderHQ, hqSupport } from './clipexport.js';   // F24: HQ offline clips (WebCodecs + mp4-muxer)
import { Take, defaultTakeUI } from './take.js';
import * as TakeLib from './take.js';
import { lifeMovers } from './seoul-movers.js';   // [F1] movers hook (design #5): world.movers from the level's life sim
import { GhostKeeper } from './ghost.js';   // C12 (D5): best take as a ghost, CHALLENGE files   // F1: TAKE_TUNING (cutT/bankT/stars) for the HUD, read live; a namespace import never fails on a missing name

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const WORLDS = [
  { id: 'yard', name: 'Silo Yard', note: 'Open bando · silos, chimney, factory hall · sunny', craft: 'freestyle5', proc: true, sky: 'sunny', level: 'bando' },
  { id: 'yard-overcast', name: 'Silo Yard · Overcast', note: 'Same site under flat grey sky', craft: 'freestyle5', proc: true, sky: 'overcast', level: 'bando' },
];
// [S0] level manifest (levels.json, contract L4): [{id, name, note, lede, module, build, args, look, sky, grade, craft, tag...}].
// Bando is the 'yard' / 'yard-overcast' worlds (its Sky seg); every other level is one more procedural world, loaded by
// id from its module. A missing or broken levels.json leaves bando alone (the built-in entry below).
const LEVEL_BANDO = { id: 'bando', name: 'Silo Yard', module: './world-bando.js', build: 'buildBando', args: ['renderer', 'opts'], look: 'day', sky: 'sunny', craft: 'freestyle5' };
let LEVELS = [LEVEL_BANDO];
try {
  const alt = new URLSearchParams(location.search).get('levels');   // [S0] tests/tools: ?levels=tests/levels.test.json (same origin only)
  const r = await fetch(new URL(alt && /^[\w./-]+\.json$/.test(alt) && !alt.includes('..') ? alt : 'levels.json', import.meta.url), { cache: 'no-cache' });
  const j = r.ok ? await r.json() : null;
  if (Array.isArray(j) && j.length) LEVELS = j.filter((l) => l && typeof l.id === 'string' && (l.id === 'bando' || (l.module && l.build)));
  if (!LEVELS.some((l) => l.id === 'bando')) LEVELS.unshift(LEVEL_BANDO);
} catch (e) { console.warn('[S0] levels.json unreadable: bando only', e?.message || e); }
const levelOf = (id) => LEVELS.find((l) => l.id === id) || null;
const levelByName = (k) => { k = String(k || '').toLowerCase(); return LEVELS.find((l) => l.id === k || (l.alias || []).includes(k)) || null; };
for (const l of LEVELS) if (l.id !== 'bando') WORLDS.push({ id: l.id, name: l.name || l.id, note: l.note || '', craft: l.craft || 'freestyle5', proc: true, sky: l.sky || 'night', level: l.id, tag: l.tag || '' });
const levelIdOf = (worldId) => WORLDS.find((w) => w.id === worldId)?.level || null;
// [F2] per-level UI copy and art (levels.json, all optional): subtitle, thumb, backdrop (+ backdropPos), kicker, ui {accent,
// accentInk, ghost, hairline}, placeNames, guideUntil, firstTip, tips {take, free}, lineNames [name | {name, hint}], foot.
// Bando's copy is the built-in default; another level without a key gets neutral copy, never bando's (ux #3).
const selLevel = () => levelOf(levelIdOf(S.world) || 'bando') || LEVEL_BANDO;           // the level picked in the menu
const isBando = (L) => !L || L.id === 'bando';
const koHTML = (s) => esc(s).replace(/[가-힣][가-힣0-9 ]*[가-힣]|[가-힣]/g, (m) => `<span class="ko" lang="ko">${m}</span>`);   // hangul runs -> the KR face
// [D] max: render scale ceiling (auto 1.2: the MSAA/shadow-split savings go into centre sharpness, 0.46 -> 0.59 px/px);
// msaa: scene MSAA samples (0 = off); ao: contact SSAO (0 = off)
const QUALITY = {
  low: { dpr: 1.25, min: 0.5, max: 0.85, samples: 8, std: Math.sqrt(5), msaa: 0, ao: 0 },
  auto: { dpr: 1.6, min: 0.55, max: 1.2, samples: 14, std: Math.sqrt(5.5), msaa: 4, ao: 1 },
  high: { dpr: 2.0, min: 0.65, max: 1.12, samples: 20, std: Math.sqrt(7), msaa: 4, ao: 1 },
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
if (!['yard', 'yard-overcast', 'url'].includes(S.world) && !WORLDS.some((w) => w.id === S.world)) S.world = 'yard';   // a saved 'file' world can't reload (the file input is empty): no dead-end FLY; [S0] manifest levels can
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
// [S0] ?level=<id or alias> deep-links a level (seoul-hongdae, seoul, bando); ?level=bando&sky=overcast picks bando's sky
{
  const L = params.get('level') ? levelByName(params.get('level')) : null;
  if (L) S.world = L.id === 'bando' ? (params.get('sky') === 'overcast' ? 'yard-overcast' : 'yard') : L.id;
  else if (params.get('level')) console.warn('[S0] unknown level', params.get('level'), 'levels:', LEVELS.map((l) => l.id).join(', '));
}

// ---------------- renderer & scenes
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });   // [D] the canvas only takes fpvcam's final quad
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
  viewW = W; viewH = vh;   // CSS px of #view: the OSD gate brackets and ghost project into it
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
// [F2] P3 ux #6: the take rules of a level: its lines file's `tuning` merged over TAKE_TUNING, as the take merges it
// (Seoul banks at 10 s, bando at 5). Before the level's lines are known: TAKE_TUNING.
function LT(id = progLevel) { return dataFor(id)?.tuning || TT(); }
const secs = (v, d) => { const x = +v > 0 ? +v : d; return (Math.round(x * 10) / 10).toString(); };
// C: CUT = 3 s hands-off hover, or 0.6 s touched down (TAKE_TUNING.cutT / landT)
// ux #4: a thumb resting on the glass counts as hands on, so the copy says "lift both thumbs"
const cutRule = (T = TT()) => `lift both thumbs and hover ${secs(T.cutT, 3)} s, or touch down for ${secs(T.landT, 0.6)} s,`;
const GAME_HINT = {
  take: () => { const T = LT(selLevel().id); return `One take: fly through named lines to build FLOW. ${secs(T.bankT, 5)} s without a line banks it; a crash loses what isn't banked. To CUT, ${cutRule(T).replace(/,$/, '')}.`; },
  free: () => 'No clock, no take. Lines still caption. Crash and you fly on from where you last flew clear.',
};
const STICK_LBL = { cine: ['CLIMB · TURN', 'SPEED · CARVE'], angle: ['THROTTLE · YAW', 'PITCH · ROLL'], acro: ['THROTTLE · YAW', 'PITCH · ROLL'] };
function applySettings() {
  const q = QUALITY[S.quality];
  // [F2 for D] P3 perf #4/#6: a level's quality cap (seoul-light's world.qualityCap: render scale <= 1.0, presets auto | phone).
  // Quality Low (or ?preset=phone) runs the phone preset: MSAA 2, crowd and light low. No cap (bando): unchanged.
  const cap = world.qualityCap, pq = params.get('preset'), pn = cap ? (cap.presets?.[pq] ? pq : S.quality === 'low' ? 'phone' : 'auto') : null;
  if (cap && cap.current !== pn && cap.presets?.[pn]) cap.apply?.(pn);
  const P = cap ? cap.presets?.[pn] || cap : null;
  fpv.setQualityRange(q.min, P && +P.max > 0 ? Math.min(q.max, +P.max) : q.max);
  fpv.look.maxSamples = q.samples;
  fpv.look.msaa = P && P.msaa != null ? Math.min(q.msaa ?? 4, P.msaa) : q.msaa ?? 4; fpv.look.ssao = q.ao ?? 1;   // [D]
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
  $('gameHint').textContent = GAME_HINT[S.game]?.() || '';
  if (S.sound === 'mix' && !audio.setMode) audio.on = true;   // C6 'mix': F2's audio.setMode runs the ambient session; alone, it just plays
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
    if (w.proc && w.level === 'bando') continue;
    const b = document.createElement('button'), L = w.level ? levelOf(w.level) : null;
    b.className = 'world' + (w.level ? ' level' : '') + (w.id === S.world ? ' on' : '') + (L?.thumb ? ' hasth' : '') + (L?.ui?.hairline ? ' hair' : '');   // [S0] manifest levels: one card each
    b.dataset.level = w.level || '';
    if (L?.ui?.hairline) b.style.setProperty('--hairC', L.ui.hairline);
    // [F2] ui #1: still, name + tag, hangul subtitle, note
    b.innerHTML = (L?.thumb ? `<span class="th" style="background-image:url('${encodeURI(L.thumb)}')"></span>` : '') +
      `<b>${esc(w.name)}${w.tag ? `<em>${esc(w.tag)}</em>` : ''}</b>${L?.subtitle ? `<i class="ko" lang="ko">${esc(L.subtitle)}</i>` : ''}<small>${esc(w.note)} · ${CRAFTS[w.craft]?.label || ''}</small>` +
      `<span class="meta">${esc(cardMeta(L))}</span>`;   // [F2] P3 ui #6
    b.onclick = () => { S.world = w.id; buildWorlds(); $('custom').classList.remove('open'); save(); };
    box.appendChild(b);
  }
  // [F2] the Silo Yard card's still (levels.json bando thumb; hero.jpg) as the first grid cell
  const yc = $('yardCard'), yt = LEVELS.find((l) => l.id === 'bando')?.thumb ?? 'hero.jpg';
  if (yt && !yc.querySelector('.th')) { const t = document.createElement('span'); t.className = 'th'; t.style.backgroundImage = `url('${encodeURI(yt)}')`; yc.prepend(t); yc.classList.add('hasth'); }
  if (DEV) {
    const c = document.createElement('button');
    c.className = 'world custom' + (S.world === 'file' ? ' on' : '');
    c.innerHTML = `<b>Your own world</b><small>Load a splat + collider from this device</small>`;
    c.onclick = () => { S.world = 'file'; buildWorlds(); $('custom').classList.add('open'); };
    box.appendChild(c);
  }
  // [S0] the lede and the LINES checklist follow the selected level (its own PROG / BEST / stars)
  const L = levelOf(levelIdOf(S.world) || 'bando');
  if (L?.lede && $('lede')) $('lede').textContent = L.lede;
  if (state === 'menu' && !loadedId) { setProgressLevel(L?.id || 'bando'); renderProgress(); }
  applyLevelUI();
}
// [F2] ui #1 / ux #3: body[data-level] + body.night, the level's OSD accent / ghost / hairline as CSS vars, the canvas caption
// accent, the menu backdrop (cross-fade) and the credit line. The HUD follows the loaded level; before a load (and for
// the menu's art) the selected one.
let capAccent = '#E75211', mbgL = null, mbgK = 0, footDef = null;
function applyLevelUI() {
  const sel = selLevel(), hud = (loadedId && world.level && levelOf(world.level)) || (loadedId ? null : sel), B = document.body;
  B.dataset.level = hud?.id || '';
  B.classList.toggle('night', (hud?.look || 'day') === 'night');
  const u = hud?.ui || {}, st = B.style;
  const set = (k, v) => (v ? st.setProperty(k, v) : st.removeProperty(k));
  set('--acc', u.accent); set('--accBadge', u.accent); set('--accInk', u.accent ? u.accentInk || '#000' : null); set('--ghost', u.ghost);
  capAccent = u.accent || '#E75211';
  // menu still: the selected level's backdrop (bando: hero.jpg; a level without one: its thumb, else none)
  const bg = sel.backdrop || (isBando(sel) ? 'hero.jpg' : sel.thumb || null);
  if (bg !== mbgL) {
    mbgL = bg; const ls = $('mbg').children, nx = ls[mbgK ^= 1], pv = ls[mbgK ^ 1];
    if (bg) { nx.style.backgroundImage = `url('${encodeURI(bg)}')`; nx.style.backgroundPosition = sel.backdropPos || ''; }
    const show = () => { if (mbgL !== bg) return; nx.classList.toggle('on', !!bg); pv.classList.remove('on'); };
    if (bg) { const im = new Image(); im.onload = im.onerror = show; im.src = bg; } else show();   // cross-fade once decoded
  }
  if (footDef === null) footDef = $('footT').textContent;
  $('footT').textContent = sel.foot ?? (isBando(sel) ? footDef : '');
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
$('rClip').onclick = () => openClip();
$('cReset').onclick = () => respawn();
$('cClip').onclick = () => openClip();
// CHALLENGE (C12): the take's .otil + score through the share sheet (inside this tap), else a download
$('cChal').onclick = () => {
  const k = ghostKeeper; if (!k?.last) return;
  k.challenge(k.last).then((r) => { if (r === 'downloaded') toast('CHALLENGE SAVED · SEND THE .OTIL FILE', 2.5, true); else if (r === 'failed') toast('COULDN\'T SHARE THE CHALLENGE', 2.5, true); });
};
$('btnClip')?.addEventListener('click', () => openClip());   // F1's in-flight landscape CLIP, if present
$('recCancel').onclick = () => { if (hqJob?.bg) { hqJob.cancel = true; return; } if (replay) { endReplay(true); toast('CLIP CANCELLED', 1.8, true); } };
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
      applyLevelUI();                                   // [F2] the HUD's accent / halo follow the level now loaded
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
// [F2] ux #3: bando's lines and chimney only on bando; a level's own tips (levels.json tips.take / tips.free: <b> only,
// {bankT} and {cut} filled from TAKE_TUNING) replace the game's list
const LOAD_TIPS = {
  take: (L, T = TT()) => [
    isBando(L) ? '<b>Lines</b> are named gaps, holes and dives. Each one adds FLOW. Fly close to structure to keep the chain alive; ' + secs(T.bankT, 5) + ' s without a line banks it.'
      : '<b>Lines</b> are named runs through the level. Each one adds FLOW. Fly close to structure to keep the chain alive; ' + secs(T.bankT, 5) + ' s without a line banks it.',
    `<b>CUT</b>: ${cutRule(T)} to end the take and keep everything. The ring in the middle counts it down; touch a stick to cancel.`,
    'A crash loses the <b>unbanked</b> chain. The bar under FLOW shows when it banks. Bank it or push on: your call.',
    `<b>RESET</b> restarts the take ${isBando(L) ? 'at the chimney' : 'where it began'}, or where you chose to START AT on the pause menu; hold it to go back to the spawn.`,
  ],
  free: () => [
    '<b>Free fly</b>: no clock. Lines still caption. Crash and you fly on from where you last flew clear.',
    '<b>RESET</b> goes back to your last clear spot; hold it to go back to the spawn.',
  ],
  any: () => ['<b>CLIP</b> saves the last 20 s, the full take, or a captioned 9:16 <b>SHORT</b> of your lines to your camera roll.'],
};
const tipHTML = (s, T = TT()) => esc(String(s).replace(/\{bankT\}/g, secs(T.bankT, 5)).replace(/\{cut\}/g, cutRule(T))).replace(/&lt;(\/?)b&gt;/g, '<$1b>');
function levelTips(L, game) {
  const own = L?.tips?.[game], T = LT(L?.id || 'bando');
  return Array.isArray(own) && own.length ? own.map((s) => tipHTML(s, T)) : LOAD_TIPS[game]?.(L, T) || [];
}
// [F2] P3 ui #5: the build's steps ("Hongdae: signs") through the level's loadSteps {signs: '간판 · SIGNS', start: ...};
// a step the level doesn't name shows nothing, never an internal name. Bando keeps its own copy.
function stepText(L, t) {
  if (!L?.loadSteps || typeof t !== 'string') return t;
  const k = t.replace(/^[^:]*:\s*/, '').trim().toLowerCase();
  return L.loadSteps[k] ?? '';
}
let loadN = 0, ldLevel = null;   // ldLevel: the level being loaded (its tips, still, kicker); null = a splat world
try { loadN = +localStorage.getItem('onetake.loads') || 0; } catch (e) {}
function setLoad(title, frac, text) {
  const L = $('loading');
  if (L.classList.contains('hidden')) {
    // fresh card: the mode's stick diagram + one tip, no error buttons
    L.classList.remove('hidden'); $('ldErr').classList.remove('on'); $('ldCoach').classList.remove('hidden');
    const portrait = document.body.classList.contains('portrait');
    $('ldSticks').innerHTML = (STICK_COACH[S.mode] || STICK_COACH.cine).map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('') +
      (portrait ? '<dt>PORTRAIT</dt><dd>use the radio gimbals below</dd>' : '');
    const tips = [...levelTips(ldLevel, S.game), ...LOAD_TIPS.any()];
    $('ldTip').innerHTML = tips[loadN % tips.length];
    loadN++; try { localStorage.setItem('onetake.loads', String(loadN)); } catch (e) {}
    // [F2] ui #6: the level's still under the card, its kicker over the title, the bar in its hairline
    const still = ldLevel && !isBando(ldLevel) ? ldLevel.backdrop || ldLevel.thumb : null;
    L.classList.toggle('still', !!still);
    if (still) { L.style.setProperty('--ldbg', `url('${encodeURI(still)}')`); L.style.setProperty('--ldpos', ldLevel.backdropPos || '50% 50%'); }
    if (ldLevel?.ui?.hairline) L.style.setProperty('--ldhair', ldLevel.ui.hairline); else L.style.removeProperty('--ldhair');
    $('ldKick').innerHTML = ldLevel?.kicker ? koHTML(ldLevel.kicker) : '';
  }
  if (title) $('ldTitle').textContent = title;
  if (frac !== null) $('ldBar').style.width = Math.round(frac * 100) + '%';
  if (text !== undefined) $('ldText').innerHTML = koHTML(text ?? '');   // [F2] P3: hangul steps in the KR face
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

// [S0] full dispose on a level switch: the level's own dispose() first (audio buffers, workers, timers), then every
// geometry, material, texture and render target its scene, depth scene and collider scene hold (world-core.js
// disposeObject), the background / environment. lastDispose = the counts (window.__onetake.mem()).
let coreMod = null, lastDispose = null;
function clearWorld() {
  if (world.mesh) { splatScene.remove(world.mesh); world.mesh.dispose?.(); world.mesh = null; }
  if (world.scene) {
    try { world.dispose?.(); } catch (e) { console.warn('[S0] world.dispose threw', e); }
    const d = coreMod?.disposeObject;
    if (d) {
      const seen = d(world.scene);
      for (const sc of [world.depthScene, world.colliderScene]) if (sc && sc !== world.scene) d(sc, seen);
      lastDispose = { level: world.level || null, geometries: seen.geo.size, materials: seen.mat.size, textures: seen.tex.size, targets: seen.rt.size };
      console.info('[S0] disposed', JSON.stringify(lastDispose), 'renderer.info.memory', JSON.stringify(renderer.info.memory));
    } else {
      world.scene.traverse((o) => { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : m ? [m] : []).forEach((mm) => { Object.values(mm).forEach((v) => v?.isTexture && v.dispose()); mm.dispose(); }); });
      world.scene.background?.dispose?.(); world.scene.environment?.dispose?.();
    }
  }
  world.scene = null; world.bvh = null; world.colliderScene = null; world.bounds = null; world.envelope = null; world.update = null;
  world.skimBvh = null; world.lines = null; world.takeStart = null; world.startPoints = null; world.funnels = null;
  world.grassAt = null;                                                                    // [F24] C7
  try { world.audio?.detach?.(); } catch (e) {}                                             // [integ6] S4 city sound off with its level
  world.depthScene = null; world.aoUniforms = null; world.dispose = null; world.level = null; world.audio = null;   // [S0]
  world.movers = null; world.tuning = null; world.setPieces = null;                          // [F1] movers hook
  world.places = null;                                                                       // [F2]
  world.qualityCap = null;                                                                   // [F2 for D] P3 perf #4/#6
}

// [S0] the camera look of a level (contract L5). 'day' = bando's HDR look line below (unchanged); 'night' = S3's
// GRADES.night via fpv.setLook('night') when fpvcam has it, else GRADES.night applied as a grade, else NIGHT_FALLBACK;
// then the manifest's `grade` overrides (e.g. {"retro": 0.3}: the retrowave knob). Coming back to 'day' from another look
// re-applies GRADES.hdr first, so no night key survives into bando.
const NIGHT_FALLBACK = { evMin: -9, evMax: 2.5, evBias: 0, wb: [1, 1, 1], wbShade: null, hlMax: 0.6, bloom: 0.35, bloomCap: 8, grain: 0.012, saturation: 1.05 };
let curLook = 'day', dayLook = null;   // dayLook: fpv.look as the day look left it (restored, keys and all, on the way back)
const copyLook = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]));
function applyLook(level, def) {
  const look = level?.look || 'day';
  if (look === 'day') {
    if (curLook !== 'day') {
      fpv.setLook?.('day');
      if (dayLook) { for (const k of Object.keys(fpv.look)) if (!(k in dayLook)) delete fpv.look[k]; Object.assign(fpv.look, copyLook(dayLook)); }
      if (GRADES.hdr) fpv._applyGrade?.(GRADES.hdr);
      fpv.resetExposure = true;
    }
    curLook = 'day';
    // [D] HDR look (colorist r2/r3, PLAN4 decision 1): evMax 4.4 (integration: chimney walls to luma ~9–18); WB fitted to the puresky sun+sky (grey card R/G 1.015,
    // B/G 0.95); overcast shade WB = its WB (no sepia hall); with GRADES.hdr clipEv 3.0.
    // [L5] evBias sunny -0.10 (colour #4: p50 113 -> ~120, clip ~2 %; -0.20 measured only 116). Overcast evBias +0.2 and the highlight meter
    // capped at hlMax 0.4 EV (was 1 EV): 30-40 % of its taps are the bright cloud deck, so it took the full EV off and the
    // ground sat ~1.5 EV under (oc_01 lower-half p50 45, ref 237: 139). Both skies set every key, so a sky switch can't
    // inherit the other's. The integrator retunes this line against the golden stills; every other knob is a GRADES.hdr key.
    fpv.setHDR(true);   // (already on: a no-op; tools/camera-profile.mjs lifts the look line after this call)
    Object.assign(fpv.look, { evMin: -5.5, evMax: 4.4, invTone: 0, lift: 0, saturation: 1.1, expo: 0.85, wb: def.sky === 'overcast' ? [1.038, 0.998, 0.907] : [1.036, 0.994, 0.956],
      wbShade: def.sky === 'overcast' ? [1.038, 0.998, 0.907] : [1.125, 0.978, 0.845], evBias: def.sky === 'overcast' ? 0.2 : -0.10, hlMax: def.sky === 'overcast' ? 0.4 : 1 });
  } else {
    if (curLook === 'day') dayLook = copyLook(fpv.look);
    if (typeof fpv.setLook === 'function') fpv.setLook(look);
    else if (GRADES[look]) fpv._applyGrade?.(GRADES[look]);
    else { if (look === 'night') console.warn('[S0] GRADES.night not in fpvcam.js yet: fallback night look'); Object.assign(fpv.look, NIGHT_FALLBACK); }
    curLook = look; fpv.resetExposure = true;
  }
  if (level?.grade && typeof level.grade === 'object') for (const [k, v] of Object.entries(level.grade)) fpv.look[k] = Array.isArray(v) ? v.slice() : v;
  // [P4-A] colour bug: ?retro= is the A/B knob, so it wins over the manifest's grade.retro (which lands after setLook read the URL)
  if (look !== 'day' && params.has('retro') && params.get('retro') !== '' && Number.isFinite(+params.get('retro'))) fpv.look.retro = Math.max(0, Math.min(1, +params.get('retro')));
}

// [S0] build a procedural level by manifest id: import(level.module)[level.build](...level.args), args from
// 'renderer' | 'scene' (a fresh THREE.Scene the module fills, contract L2) | 'opts' ({sky, quality, seed, level, onProgress}).
// The old world is disposed before the new one builds (one world in memory at a time on the phone).
async function loadProcWorld(def) {
  const level = levelOf(def.level || 'bando') || LEVEL_BANDO;
  let mod;
  try { [mod, coreMod] = await Promise.all([import(level.module), coreMod || import('./world-core.js')]); }
  catch (e) { throw new Error(`${level.name || level.id} is not in this build yet (${level.module}: ${e.message || e})`); }
  const build = mod[level.build];
  if (typeof build !== 'function') throw new Error(`${level.module} has no ${level.build}()`);
  clearWorld(); loadedId = null;
  // [F1] movers hook: the drawn city runs on the drone's tick clock (flight.js drone.tick, the clock world.movers is
  // asked at, carried in snapshots), at the rendered pose's time (tick - 1 + physAlpha: the pose is lerped between the last
  // two ticks), so the bus you see is the bus you hit; the input log restarting (10 min) no longer rewinds the city
  const scene0 = new THREE.Scene(), opts = { takeClock: () => hqClock ?? Math.max(0, (drone.tick ?? (inputLog?.ticks ?? 0) + 1) - 1 + physAlpha) * PHYS,   // [integ6] deterministic: sim ticks ([P3-G2] hqClock: an HQ sub-frame)
    sky: def.sky, quality: S.quality, level: level.id, layout: level.layout, onProgress: (f, t) => setLoad(null, f, stepText(level, t)) };   // [P3-F2] real loading status
  const args = (Array.isArray(level.args) ? level.args : ['renderer', 'scene', 'opts']).map((a) => (a === 'renderer' ? renderer : a === 'scene' ? scene0 : a === 'opts' ? opts : undefined));
  const w = await build(...args);
  if (!w || !(w.scene || scene0.children.length)) throw new Error(`${level.build}() returned no world`);
  const wScene = w.scene || scene0;
  Object.assign(world, { scene: wScene, colliderScene: w.colliderScene || (w.colGeo ? coreMod.colliderScene(w.colGeo) : null), bvh: w.bvh || null, bounds: w.bounds || null, envelope: w.envelope || null, update: w.update || null, hdr: true });
  Object.assign(world, { skimBvh: w.skimBvh || w.bvh || null, lines: w.lines || [], takeStart: w.takeStart || null, startPoints: w.startPoints || null, funnels: w.funnels || null });   // C: the take (C1)
  world.grassAt = typeof w.grassAt === 'function' ? w.grassAt : null;                     // [F24] C7 (V2, optional): grass height (m) at x, z
  world.level = level.id; world.dispose = typeof w.dispose === 'function' ? w.dispose : null; world.audio = w.audio || null;   // [S0]
  world.places = level.placeNames && w.layout ? buildPlaces(w.layout) : null;              // [F2] ui #6: street names for captions
  // [integ6] S4: the level's city sound goes through the same camera-mic chain as the motors
  if (world.audio?.attach && audio.ctx) { try { world.audio.attach(audio.ctx, audio.bus); } catch (e) { console.warn('level audio', e); } }
  // [F1] movers hook (design #5, contract P2-F1): kinematic movers checked inside Drone.step on its tick clock (buses and
  // taxis crash, people are a SCRAPE + HEADS!), the level's take tuning (lines.json `tuning` over TAKE_TUNING) and E's set
  // pieces (lines coded against their ids fly once they exist). Each optional; bando has none.
  try { world.movers = w.movers || lifeMovers(w.parts?.life) || null; } catch (e) { console.warn('movers', e); world.movers = null; }
  world.tuning = w.tuning || null; world.setPieces = w.setPieces || w.parts?.dressing?.setPieces || null;
  world.qualityCap = w.qualityCap || w.scene?.userData?.seoulLight?.qualityCap || null;   // [F2 for D] P3 perf #4/#6 (applySettings)
  world.spawn.copy(w.spawn?.isVector3 ? w.spawn : w.spawn?.pos ? new THREE.Vector3(...(w.spawn.pos.toArray?.() ?? w.spawn.pos)) : new THREE.Vector3(0, 2, 0)); world.yaw = w.yaw ?? w.spawn?.yaw ?? 0;
  // scene-linear HDR in: the camera meters real light levels, with a GoPro-like ISO range
  fpv.setHDR(true);
  applyLook(level, def);
  Object.assign(world, { depthScene: w.depthScene || null, aoUniforms: w.aoUniforms || null });   // [D] contracts C2/C3 (optional inputs)
  fpv.warmup?.(world);                                                                              // [D] post + depth programs, textures
  fpv.cam.near = 0.06; fpv.cam.far = 3000; fpv.cam.updateProjectionMatrix();
  // [A] shader warm-up behind the loader: compile every world program now (in parallel where
  // KHR_parallel_shader_compile exists) instead of hitching the first frames. Compiled against a
  // half-float target so the program keys (linear output, no tone mapping) match the HDR scene pass.
  try {
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType }), prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt); const t = performance.now();
    if (renderer.extensions.has('KHR_parallel_shader_compile')) await renderer.compileAsync(wScene, fpv.cam); else renderer.compile(wScene, fpv.cam);
    renderer.setRenderTarget(prev); rt.dispose();
    console.info('shader warm-up ms', Math.round(performance.now() - t));
  } catch (e) { console.warn('shader warm-up skipped', e); }
  // [D] perf #2: depthScene/shadow programs, every texture uploaded, one full frame from the spawn (no first-frame freeze)
  fpv.warmup?.(world, { pos: world.spawn.clone().add(new THREE.Vector3(0, 1.2, 0)), quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), world.yaw || 0) });
}

async function loadWorld(def) {
  state = 'loading';
  ldLevel = def.proc ? levelOf(def.level || 'bando') || LEVEL_BANDO : null;   // [F2] the loading card's tips and art
  try {
    setLoad(def.name, 0, def.proc ? (isBando(ldLevel) ? 'Building site…' : ldLevel.loadSteps?.start || `Building ${ldLevel.name || 'the level'}…`) : 'Fetching world…');
    if (def.proc) {
      setProgressLevel(def.level || 'bando');   // [S0] this level's PROG / BEST / stars
      await loadProcWorld(def);
      world.def = def;
      applySettings();
      $('loading').classList.add('hidden');
      return true;
    }
    await ensureSpark();
    if (curLook !== 'day') { fpv.setLook?.('day'); curLook = 'day'; }   // [S0] leaving a night level
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
    if (!world.scene && !world.mesh) loadedId = null;   // [S0] the old world is gone: FLY loads again, no RESUME into nothing
    else if (world.def && world.def.id !== S.world) { S.world = world.def.id; buildWorlds(); syncSegs(); setProgressLevel(world.level || 'bando'); save(); }   // [S0] still flying the old level
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
// take: a retry starts at once, hovering over the chimney mouth (the first line); toStart = the spawn and its reveal.
// startName (START AT on the pause menu): go to that world.startPoints entry; take retries keep going back there until
// the next START AT or a back-to-start. '' clears it.
const safePts = []; let safeT = 0, startAt = null, takeFrom = null;
function trackSafe(dt, now) {
  safeT += dt; if (safeT < 1.0 || drone.crashed) return; safeT = 0;
  if (world.lastDist > 1.2 && drone.vel.length() < 30) { safePts.push({ t: now, p: drone.pos.clone(), yaw: drone.heading }); if (safePts.length > 30) safePts.shift(); }
}
// where a take RETRY puts you ({pos, yaw, name}; the crash card's next-line hint can measure from it): the sticky
// START AT; else, until the player has flown any line (UX r3 #3: the first retry used to teleport a new player 52 m up
// over the chimney with no explanation), back to where the take started; else the take start over the chimney mouth.
function retryPose() {
  const named = findStart(startAt); if (named) return { pos: named.pos, yaw: named.yaw, name: named.name };
  let any = true; try { const pr = take.progress(world); any = pr.flown + pr.micro.flown > 0; } catch (e) {}
  if (!any && takeFrom) return { pos: takeFrom.pos, yaw: takeFrom.yaw, name: null };
  if (world.takeStart) return { pos: world.takeStart.pos, yaw: world.takeStart.yaw, name: world.startPoints?.[0]?.name ?? null };
  return { pos: world.spawn, yaw: world.yaw, name: null };
}
const findStart = (name) => { const k = String(name || '').toLowerCase(); return (k && world.startPoints?.find((s) => s.name.toLowerCase() === k)) || null; };
function respawn(toStart = false, startName = null) {
  drone.setCraft(craftFor(world.def));
  const now = performance.now() / 1000;
  const takeMode = S.game !== 'free';
  if (typeof startName === 'string') startAt = findStart(startName) ? startName : null;
  if (toStart === true) startAt = null;
  const named = typeof startName === 'string' ? findStart(startName) : takeMode && !toStart ? findStart(startAt) : null;
  const sp = named || toStart || takeMode ? null : [...safePts].reverse().find((s) => now - s.t > 2.0);
  const rp = !named && !sp && takeMode && !toStart ? retryPose() : null;
  if (named) { drone.reset(named.pos, named.yaw); flightT = 0; }
  else if (sp) drone.reset(sp.p, sp.yaw);
  else if (rp) { drone.reset(rp.pos, rp.yaw); flightT = 0; }
  else { drone.reset(world.spawn, world.yaw); flightT = 0; }
  takeFrom = { pos: drone.pos.clone(), yaw: drone.heading };
  if (toStart || takeMode || named) safePts.length = 0;
  take.reset(); freeTake.reset();
  controls.resetThrottle(Math.sqrt(1 / drone.c.twr)); thrRef = controls.thr;
  camQ.copy(drone.q); fpv.resetExposure = true;
  // the replay buffer is kept: F2's uiRespawn hands it on (lastBuf), so a clip of the take just ended survives a retry
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
// [S0] per-level progress: bando keeps the original keys (onetake.lines / .best / .perfect / .ui.progress / .ui.lineList),
// every other level suffixes them with @<level id>. Ghosts are keyed by world hash already (ghost.js), so they are per level.
let progLevel = 'bando';
const lkey = (base, id = progLevel) => (id === 'bando' ? base : `${base}@${id}`);
// the take (take.js): named lines, FLOW, bank / crash / CUT. Free fly runs its own free instance: lines still fire
// (captions, e.free, pts 0) and count as flown, nothing scores or ends.
const take = new Take(), freeTake = new Take({ free: true });
// C12: the stored best take (IndexedDB) re-flown as take.ghost; fed every take event; it reads the live input log
let ghostKeeper = null;
function keeper() {
  if (!ghostKeeper && (world.bvh || world.mesh)) { try { ghostKeeper = new GhostKeeper(take, () => inputLog, () => world); } catch (e) { console.warn('ghost', e); } }
  return ghostKeeper;
}
const _cp = {};
// proximity to anything (terrain included): flight turbulence, audio, OLED bars. Scoring uses world.skimBvh.
// [E] measured inside the physics tick (drone.prox, Infinity when crashed or clear); mirrored here for audio/HUD
function updateProx() { world.lastDist = world.bvh && !drone.crashed ? drone.prox : Infinity; }
// hands (decision 9, design r3 #3). The shaped stick outputs are exactly 0 inside each input's deadzone, so any output
// is raw deflection past it. moved: a stick past its deadzone or the (non-centring) throttle being moved: starts a take.
// steer: pitch / roll / yaw past it: blocks the touchdown CUT (holding the dive down is how you land). hands: moved,
// or E4's controls.active (a thumb on the screen, a key held, a raw stick past the deadzone; else controls.touches): blocks
// the hover CUT. Without either, hands = moved.
let thrRef = 0.39, takeGame = S.game;
const STICK_EPS = 2e-3;
function thumbsDown() {
  if (controls.active !== undefined) return !!controls.active;      // E4: thumb on the screen, key held or raw stick past the deadzone
  const t = controls.touches;
  return typeof t === 'number' ? t > 0 : t ? (t.size ?? t.length ?? 0) > 0 : false;
}
function sticksActive(inp, dt) {
  const d = inp.thr - thrRef; thrRef += d * Math.min(1, dt / 0.5);
  const steer = Math.max(Math.abs(inp.pitch), Math.abs(inp.roll), Math.abs(inp.yaw)) > STICK_EPS;
  const moved = steer || (S.mode === 'cine' ? Math.abs(inp.climb) > STICK_EPS : Math.abs(d) > 0.04);
  return { hands: moved || thumbsDown(), moved, steer };
}
const takeEvent = (e) => {
  if (S.game !== 'free') { try { keeper()?.event(e); } catch (err) { console.warn('ghost event', err); } }   // before the UI: the CUT card's CHALLENGE needs keeper.last
  return (typeof onTakeEvent === 'function' ? onTakeEvent : (ev) => defaultTakeUI(ev, pop))(e);
};
// one call per physics update (frame or tick): stream E may move it onto the fixed ticks as is
function updateTake(dt, inp) {
  const on = sticksActive(inp, dt);
  if (S.game !== takeGame) { takeGame = S.game; take.reset(); freeTake.reset(); }
  for (const e of (S.game === 'free' ? freeTake : take).update(dt, drone, world, on)) takeEvent(e);
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
// wash / bump (0-1, contract C4): prop-wash and impact intensity for D's 45 Hz jello band
const motion = { vel: new THREE.Vector3(), ang: new THREE.Vector3(), vib: 1, hz: 170, wash: 0, bump: 0 };
const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), rigP = new THREE.Vector3(), rigQ = new THREE.Quaternion();
const yawQ = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);   // D5 counter-yaw (not yawS: that is Cine's yaw smoothing)
let cpPrev = 0, cpResets = -1, cyPrev = 0;
function rigCamera(dt) {
  // [E] the body pose between the last two physics ticks (physAlpha = leftover accumulator / tick, see frame())
  rigP.lerpVectors(drone.prev, drone.pos, physAlpha); rigQ.slerpQuaternions(drone.prevQ, drone.q, physAlpha);
  const tilt = (S.tilt >= 0 ? S.tilt : defTilt(drone.c)) * DEG;
  // Cine: the view also pitches with the climb/dive angle, looks down the tube in a vertical drop and half-cancels the
  // fast pitch nods (flight.js camView: advanced inside the physics tick, read between the last two ticks like the pose,
  // so it replays from the input log; eases back to 0 in the other modes)
  const cp = drone.camView(physAlpha, tilt);
  tiltQ.setFromAxisAngle(_v.set(1, 0, 0), tilt + cp);
  _q.copy(rigQ).multiply(tiltQ);
  const cy = drone.camYaw?.(physAlpha) ?? 0;           // D5 (FPV r4 #5): cine counter-yaw about world up, from the tick state
  _q.premultiply(yawQ.setFromAxisAngle(UP, cy));
  const tau = STAB[S.stab] || 0;
  if (tau > 0) camQ.slerp(_q, 1 - Math.exp(-dt / tau)); else camQ.copy(_q);
  camPose.quat.copy(camQ);
  camPose.pos.copy(rigP).add(_v.set(0, 0.02, -0.04).applyQuaternion(rigQ));
  motion.vel.copy(drone.vel);
  motion.ang.copy(drone.w).applyQuaternion(rigQ);      // physical camera rotation (blur uses the raw motion)
  // ...plus the pitch-follow and counter-pitch, which turn the view about the body's x axis too (34-65 px of smear were missing on a
  // chimney entry). No spike across a respawn.
  if (drone.resets !== cpResets) { cpResets = drone.resets; cpPrev = cp; cyPrev = cy; }
  const cpd = dt > 0 ? (cp - cpPrev) / dt : 0; cpPrev = cp;
  motion.ang.addScaledVector(_v.set(1, 0, 0).applyQuaternion(rigQ), cpd);
  const cyd = dt > 0 ? (cy - cyPrev) / dt : 0; cyPrev = cy;   // the counter-yaw turns the view too (blur)
  motion.ang.addScaledVector(UP, cyd);
  motion.vib = drone.crashed ? 0.2 : 0.35 + 1.1 * Math.sqrt(drone.thrust / drone.tMax) + drone.wash * 3 + drone.bump * 4;
  motion.hz = drone.rpmHz;                             // ~170 Hz at hover, ~430 Hz at full throttle (rpm ~ sqrt(thrust))
  motion.wash = drone.crashed ? 0 : drone.wash; motion.bump = drone.bump;
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
    hit: hitNow, thud: thudNow, ax: { ...ax }, cap: capNow, st: stickPos(),
    // F24: where this frame sits in the input log (HQ re-sim): tick count run in it + the render's physAlpha
    L: inputLog && drone.resets === logResets ? inputLog : null, k: inputLog ? inputLog.ticks : 0, a: physAlpha });
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
  if (e.type === 'start') {
    // UX #4: a new take right after a CUT ("touch a stick for a new one") keeps the CUT take as the previous clip
    if (cur.startT != null) {
      const F = cur.frames, t1 = F.length ? F[F.length - 1].t : 0, run = F.filter((f) => f.t >= t1 - 1.2).map((f) => ({ ...f, cap: null }));
      rotateClip(); cur.frames.push(...run);                   // the run-up (FULL TAKE starts 1 s before the take)
    }
    startNow = true;
  }
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
function caption(text, flow = 1, place = '') {
  const c = { text, flow, place }, lag = lineLag(capEv), dup = capEv?.clip; capEv = null;
  if (dup === 'skip') return;                                  // C: shares its t0 with a bigger line's caption
  const F = cur.frames, n = F.length;
  if (lag < 0.02 || n < 2) { capNow = c; markNow = { t0: null }; return; }
  // walk back `lag` s of flight time (steps clamped like the sim's, so a pause doesn't count); start from the frame
  // being built now (~ one step after the last one pushed)
  let i = n - 1, acc = Math.min(0.1, F[n - 1].t - F[n - 2].t);
  while (i > 0 && acc < lag - 1e-4) { acc += Math.min(0.1, F[i].t - F[i - 1].t); i--; }
  if (dup === 'replace') {                                     // C: same t0 as an earlier, smaller line: take its frame
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) if (F[j].cap) { F[j].cap = c; return; }
  }
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
  const f = [], raw = [], ot = [], seg = [], caps = []; let T = 0, sg = -1, prevT = 0;   // raw: f unstabilised (HQ re-sim)
  for (const [a, e] of wins) {
    let first = true;
    for (let j = lowerT(sm, a); j < sm.length && sm[j].t <= e; j++) {
      const fr = sm[j];
      if (first || fr.t - prevT > 0.25) { if (f.length) T += 1 / CLIP_FPS; sg++; first = false; }   // hard cut (or a pause in the take)
      else T += Math.min(0.1, fr.t - prevT);                       // hitches collapse like the sim's dt clamp
      prevT = fr.t; f.push(fr); raw.push(src[j]); ot.push(T); seg.push(sg);
      if (fr.cap && S.caps !== 'off') caps.push({ t: T, seg: sg, text: fr.cap.text, flow: fr.cap.flow || 1, place: fr.cap.place || '' });
    }
  }
  if (f.length < 15) return null;
  return { kind, f, raw, ot, seg, caps, dur: T, sigma: st.sigma, jit: st.jit, rawJit: st.raw, cuts: sg };
}
// ---- clip modal first (UX #4): CLIP pauses and opens the modal with the cuts and their lengths; MAKE CLIP renders the
// chosen one once. SHORT is the default when the take has one of at least clipCfg.shortMin s (shorter: hidden).
// Output (PLAN4 decision 8): SHORT/LAST/FULL as a full-bleed 1080x1920 frame through the lens (default) or the radio
// layout (square picture over the sticks). HQ: offline re-render from the input log, 8 sub-frames per 1/60 s shutter,
// WebCodecs + mp4-muxer (clipexport.js); without WebCodecs (or if it fails) the real-time MediaRecorder path.
const clipCfg = { shortMin: 8, sub: 8, hqScale: 1.0, subSlow: 4, budget: 6 };   // hqScale: render scale of the HQ scene pass (tests lower it)
// U5 (ux #2): subSlow sub-frames when the live game was already slow (governor frame-time EMA over target, or the 30 Hz
// Low Power cap), and the render drops to it mid-way if its first frames project past budget x the clip's length
// (6x: 20 s of clip in <= 2 min, the FPV panel's phone target).
const clipPrefs = { lay: 'full', hq: true };
try { const p = JSON.parse(localStorage.getItem('onetake.clip') || '{}'); if (p.lay === 'radio' || p.lay === 'full') clipPrefs.lay = p.lay; if (typeof p.hq === 'boolean') clipPrefs.hq = p.hq; } catch (e) {}
const saveClipPrefs = () => { try { localStorage.setItem('onetake.clip', JSON.stringify(clipPrefs)); } catch (e) {} };
let clipSel = 'last', clipDone = null, hqJob = null, hqOK;    // hqOK: undefined until hqSupport() answers, then {..} | null
let clipReady = false;                                          // an HQ clip finished with the modal closed: CLIP opens it
const CUT_NAME = { short: 'SHORT', last: 'LAST 20 S', full: 'FULL TAKE' };
const CUT_HINT = { short: 'The lines, hard cuts between', last: 'The last 20 seconds', full: 'The whole take, from the run-up' };
const shortOK = (b) => { const w = clipPlan(b, 'short'); return !!w && planDur(w) >= clipCfg.shortMin; };
const tiltFor = (mode) => (S.tilt >= 0 ? S.tilt : Math.round(drone.c.camTilt * (mode === 'acro' ? 1 : mode === 'angle' ? 0.8 : 0.55))) * DEG;
// LAST is only a choice when it differs from FULL TAKE (ui #1, ux #1): within 0.5 s of it, it is hidden
const lastSame = (b) => { const l = clipPlan(b, 'last'), f = clipPlan(b, 'full'); return !l || !f || Math.abs(planDur(l) - planDur(f)) < 0.5; };
function openClip(from = null) {
  if (hqJob?.bg) { showRender(); return; }                      // rendering with the modal closed: back to its progress
  if (state === 'replay' || clipOpen || hqJob) return;
  if (clipReady && lastClip && !from) { clipReady = false; reopenDone(); return; }   // "CLIP READY": the finished clip
  const b = from || clipSource(); if (!b) { toast('FLY FIRST', 1.8, true); return; }
  clipBuf = b; clipSel = shortOK(b) ? 'short' : lastSame(b) ? 'full' : 'last';
  if (!clipPlan(b, clipSel)) { toast('FLY FIRST', 1.8, true); return; }
  clipDone = null; audio.kick?.(true);                          // inside the tap: a live fallback needs the context
  pauseForClip(); setPhase('choose');
  $('clip').classList.remove('hidden'); comp.classList.add('hidden'); fitComp(false);
  hqSupport().then((s) => { hqOK = s; syncCuts(); });
}
function setPhase(p) {
  const el = $('clip'); el.dataset.phase = p;
  const done = p === 'done', busy = p === 'render';
  $('clipShare').classList.toggle('hidden', !done); $('clipSave').classList.toggle('hidden', !done || !clipCanShare);
  $('clipClose').textContent = busy ? 'CANCEL' : 'CLOSE';
  $('clipHide').classList.toggle('hidden', !(busy && hqJob && !hqJob.prep));   // HQ: close the modal, the render carries on
  if (!done) $('clipVid').pause();
  syncCuts();
}
function syncCuts() {
  const b = clipBuf, busy = $('clip').dataset.phase === 'render';
  const same = b ? lastSame(b) : false;
  if (same && clipSel === 'last') clipSel = 'full';
  $('clipCuts').querySelectorAll('button[data-cut]').forEach((el) => {
    const k = el.dataset.cut, w = b ? clipPlan(b, k) : null, d = Math.round(planDur(w));
    el.classList.toggle('hidden', (k === 'short' && !(b && shortOK(b)) && clipSel !== 'short') || (k === 'last' && same));
    el.disabled = !w || busy; el.classList.toggle('on', k === clipSel);
    el.textContent = k === 'last' ? (w && d < CLIP_LAST - 0.5 ? `LAST ${fmtS(d)}` : CUT_NAME.last) : CUT_NAME[k] + (w ? ` ${fmtS(d)}` : '');
  });
  $('clipOpts').querySelectorAll('button[data-lay]').forEach((el) => { el.classList.toggle('on', el.dataset.lay === clipPrefs.lay); el.disabled = busy; });
  const hq = $('clipHQ'); hq.classList.toggle('hidden', hqOK === null); hq.classList.toggle('on', clipPrefs.hq); hq.disabled = busy;
  const made = clipDone && clipDone.kind === clipSel && clipDone.lay === clipPrefs.lay && clipDone.hq === useHQ();
  $('clipMake').classList.toggle('hidden', busy || !!made);
  // the header is the selected pill (ui #1): its own label, its own length, its own description
  const w = b ? clipPlan(b, clipSel) : null, d = Math.round(planDur(w));
  $('clipPickN').textContent = clipSel === 'last' && w && d < CLIP_LAST - 0.5 ? 'LAST' : CUT_NAME[clipSel]; $('clipPickD').textContent = w ? fmtS(d) : '';
  $('clipPickH').textContent = (clipSel === 'last' && w && d < CLIP_LAST - 0.5 ? `The last ${d} seconds` : CUT_HINT[clipSel]) + (clipSel === 'short' && w ? ` · ${w.length} part${w.length > 1 ? 's' : ''}` : '');
  if ($('clip').dataset.phase === 'choose') $('clipMeta').textContent = useHQ() ? 'HQ · real motion blur' : 'Standard';
}
const useHQ = () => clipPrefs.hq && hqOK !== null;
// render a cut now (MAKE CLIP; also the programmatic API). HQ when on and supported, else the live recorder.
function saveClip(kind = 'last', from = null) {
  if (state === 'replay' || hqJob) return;
  const b = from || clipBuf || clipSource(); if (!b) { toast('FLY FIRST', 1.8, true); return; }
  const C = buildClip(b, kind);
  if (!C) { toast(kind === 'short' ? 'NO LINES IN THIS TAKE YET' : 'FLY FIRST', 1.8, true); return; }
  audio.kick?.(true);                                         // inside the tap: clip audio even with Sound Off
  clipBuf = b; clipKind = kind; clipSel = kind;
  if (clipPrefs.hq && hqOK !== null && window.VideoEncoder) makeHQ(C, b, kind);
  else recordLive(C, b, kind);
}
// 9:16 layouts. cap: the box whose bottom edge carries the caption: the reference's square picture (~57 % down the
// frame), so a full-bleed Short keeps the caption where the reference has it, clear of the Shorts UI at the bottom.
function clipLayout(W, H, lay = 'radio') {
  const top = Math.round(H * 0.034), u = W / 1080, sq = { x: 0, y: top, w: W, h: W };
  if (lay === 'full') return { W, H, u, full: true, pic: { x: 0, y: 0, w: W, h: H }, cap: sq };
  const rad = { x: 0, y: top + W, w: W, h: H - top - W }, cy = rad.y + rad.h * 0.47, well = Math.round(330 * u);
  return { W, H, u, pic: sq, cap: sq, rad, well, wells: [[W * 0.255, cy], [W * 0.745, cy]], scr: { x: W / 2 - 84 * u, y: rad.y + 70 * u, w: 168 * u, h: 104 * u } };
}
function prepComp(W, H, lay) {
  comp.width = W; comp.height = H; clipLay = clipLayout(W, H, lay); radioBg = lay === 'radio' ? makeRadioBg(clipLay) : null;
  warmFonts(Math.round(W * 0.08));
  return clipLay.pic;
}
const capLabel = (C) => C.caps.length ? ` · ${C.caps.length} caption${C.caps.length > 1 ? 's' : ''}` : '';
// ---- HQ: offline, re-simulated, sub-frame accumulated, WebCodecs
let hqClock = null;   // [P3-G2] the take clock of the HQ sub-frame being rendered (world.update's takeClock), else null
async function makeHQ(C, b, kind) {
  const job = hqJob = { cancel: false, bg: false, needCtx: false }, lay = clipPrefs.lay;
  if (!clipOpen) pauseForClip();
  $('clip').classList.remove('hidden'); setPhase('render'); hqProgress(0, 0, 1, 0);
  const sup = hqOK === undefined ? (hqOK = await hqSupport()) : hqOK;
  if (job.cancel) { hqJob = null; setPhase(clipDone ? 'done' : 'choose'); return; }
  if (!sup) { hqJob = null; recordLive(C, b, kind); return; }
  job.needCtx = !sup.audio;                                     // the remux pass needs the live context: don't suspend it
  // slow device: the live game's governor was already over target (or capped at 30 Hz) -> clipCfg.subSlow sub-frames
  const slow = (fpv.autoMs || 0) > 0 || (fpv.ftEma || 0) > Math.max(fpv.targetMs || 16.7, fpv.autoMs || 0) * 1.14;
  let N = Math.max(1, clipCfg.sub | 0); if (slow && N > clipCfg.subSlow) N = clipCfg.subSlow;
  const W = 1080, H = 1920, pic = prepComp(W, H, lay), lk = fpv.look;
  const keep = { shutter: lk.shutter, grain: lk.grain, letterbox: lk.letterbox, scale: fpv.scale };
  renderer.setSize(pic.w, pic.h, false); fpv.resize(pic.w, pic.h); lk.letterbox = 0;
  lk.shutter = keep.shutter / N;                                // each sub-frame smears its slice of the shutter
  lk.grain = keep.grain * Math.sqrt(N);                         // grain is per sub-frame: N of them average to 1/sqrt(N)
  fpv.scale = Math.min(fpv.maxScale, clipCfg.hqScale ?? 1);
  const pv = $('clipPrev'), pg = pv.getContext('2d'), t0 = performance.now();
  const mo0 = { ...motion };
  const renderSub = (s) => {
    const a = C.f[s.i], n = C.f[s.i + 1], nb = n && C.seg[s.i + 1] === C.seg[s.i] ? n : null;
    const u = nb ? Math.max(0, Math.min(1, (s.T - C.ot[s.i]) / Math.max(1e-6, C.ot[s.i + 1] - C.ot[s.i]))) : 0;
    for (const k in a.mo) motion[k] = a.mo[k] + (((nb?.mo[k]) ?? a.mo[k]) - a.mo[k]) * u;
    camPose.pos.copy(s.p); camPose.quat.copy(s.q); motion.vel.copy(s.vel); motion.ang.copy(s.ang);
    // [P3-G2] sound #5: the city (traffic, crowd, sound) runs on this sub-frame's take clock, not the paused drone.tick
    const ka = (a.k || 0) + (a.a || 0); hqClock = (ka + (nb ? (nb.k || 0) + (nb.a || 0) - ka : 0) * u) * PHYS;
    if (s.reset) fpv.resetExposure = true;                     // start / hard cut: no AE drift across it
    world.update?.(camPose.pos, s.dt, camPose.quat);
    fpv.render(world, camPose, motion, s.dt);
  };
  const composite = (k, T, i) => {
    const a = C.f[i], n = C.f[i + 1], st = clipLay.full ? null : n && C.seg[i + 1] === C.seg[i] ? a.st.map((v, j) => v + (n.st[j] - v) * Math.max(0, Math.min(1, (T - C.ot[i]) / Math.max(1e-6, C.ot[i + 1] - C.ot[i])))) : a.st;
    const c = drawComp(C, T, i, st);
    if (k % 3 === 0) pg.drawImage(comp, 0, 0, pv.width, pv.height);
    return c;
  };
  let res = null, err = null;
  try {
    res = await renderHQ({ C, world, renderer, fpv, comp, size: [pic.w, pic.h], sub: N, shutter: keep.shutter, tiltFor, makeAudio: (actx) => clipAudio(actx, C),
      renderSub, composite, onProgress: (f, n, nF, ms) => hqProgress(f, n, nF, ms), cancelled: () => job.cancel,
      budgetMs: clipCfg.budget > 0 ? C.dur * clipCfg.budget * 1000 : 0, minSub: clipCfg.subSlow,
      onSub: (n) => { lk.shutter = keep.shutter / n; lk.grain = keep.grain * Math.sqrt(n); } });
  } catch (e) { err = e; console.warn('HQ clip failed', e); }
  finally {
    hqClock = null;   // [P3-G2]
    Object.assign(lk, { shutter: keep.shutter, grain: keep.grain, letterbox: keep.letterbox }); fpv.scale = keep.scale;
    Object.assign(motion, mo0); layout(); fpv.resetExposure = true;
  }
  // no AudioEncoder (Safari): a video-only MP4 + the offline-rendered sound -> one real-time remux pass
  if (res && res.audio && !job.cancel) {
    const blob = await remuxAudio(res.blob, res.audio, job);
    if (blob) res.blob = blob; else if (!job.cancel) toast('NO SOUND IN THIS CLIP', 2.5, true);
    res.stats.audio = blob ? 'remux' : 'none';
  }
  const bg = job.bg; hqJob = null;
  if (err) { hqOK = null; toast('HQ FAILED · RECORDING LIVE', 2.5, true); hqHome(); setPhase('choose'); recordLive(C, b, kind); return; }
  if (!res || job.cancel) {                                      // cancelled
    if (bg) { hqHome(); resumeAfterClip(); toast('CLIP CANCELLED', 1.8, true); } else setPhase(clipDone ? 'done' : 'choose');
    return;
  }
  const info = { dur: Math.floor(C.dur * CLIP_FPS + 1e-6) / CLIP_FPS + 1 / CLIP_FPS, caps: C.caps.map((c) => [c.t, c.text]), sigma: C.sigma, jit: C.jit, raw: C.rawJit, W, H, kind, lay, hq: res.stats, fixed: true };
  if (bg) {                                                      // the modal was closed: back to the game, "CLIP READY"
    hqHome(); showClip(res.blob, info, true); resumeAfterClip(); clipReady = true;
    toast('CLIP READY · TAP CLIP TO SAVE', 4, true);
  } else showClip(res.blob, info);
}
// U5 (ux #2): the ETA starts after 10 frames (the first ones carry shader compiles), timed from the video loop only
function hqProgress(f, n, nF, ms, what = 'RENDERING') {
  const pct = Math.round(100 * f), left = n >= 10 && ms > 0 ? (nF - n) * ms / 1000 : -1;
  const eta = what !== 'RENDERING' ? '' : left < 0 ? ' · ESTIMATING' : left > 1 ? ` · ${fmtS(Math.ceil(left))} LEFT` : '';
  $('clipProgB').style.width = (100 * f).toFixed(1) + '%';
  $('clipMeta').textContent = `${what} ${pct}%${eta}`;
  if (hqJob?.bg) { $('recT').textContent = `${what === 'RENDERING' ? 'HQ CLIP' : what} ${pct}%${eta}`; $('recP').style.width = (100 * f).toFixed(1) + '%'; }
}
// close the modal while the HQ render carries on: the clip being made plays full screen under a progress chip (the
// game can't run beside it: the render owns the renderer). Tap the chip to reopen, CANCEL to stop.
function hideRender() {
  if (!hqJob || hqJob.prep) return;
  hqJob.bg = true; $('clip').classList.add('hidden'); document.body.classList.add('replaying', 'hqbg');
  comp.classList.remove('hidden'); fitComp(true);
  $('recT').textContent = `HQ CLIP ${Math.round(parseFloat($('clipProgB').style.width) || 0)}%`;
}
function showRender() {
  if (!hqJob) return;
  hqJob.bg = false; hqHome(); $('clip').classList.remove('hidden'); setPhase('render');
}
function hqHome() { document.body.classList.remove('replaying', 'hqbg'); comp.classList.add('hidden'); fitComp(false); }
function resumeAfterClip() {
  clipOpen = false; document.body.classList.remove('clipopen');
  if (state === 'fly' || state === 'crash') controls.enabled = true;
  if (sum.data || state === 'crash') showSummary(sum.kind || 'crash', sum.data);
  if (!audio.on) audio.idle?.(); else audio.kick?.();
}
// the modal as it was when the clip finished
function reopenDone() {
  pauseForClip(); $('clip').classList.remove('hidden'); comp.classList.add('hidden'); fitComp(false); setPhase('done');
  const v = $('clipVid'); v.currentTime = 0; v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
}
// U5 (sound #5, fpv #4): HQ without AudioEncoder. The video-only MP4 plays (muted, decoded in hardware) into the
// composite canvas while an AudioBufferSourceNode plays the offline-rendered clip sound into a MediaStreamDestination;
// MediaRecorder writes both. Real time (the clip's length), at the HQ frames' quality minus one re-encode.
async function remuxAudio(blob, ab, job) {
  const ctx = audio.ctx;
  if (!ctx || ctx.state === 'closed' || !window.MediaRecorder || !comp.captureStream) return null;
  try { await Promise.race([Promise.resolve(ctx.resume?.()).catch(() => {}), new Promise((ok) => setTimeout(ok, 600))]); } catch (e) {}
  if (ctx.state !== 'running') return null;
  const url = URL.createObjectURL(blob), v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(v); v.src = url;
  let src = null, stream = null;
  try {
    await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error('decode')); setTimeout(() => no(new Error('decode timeout')), 10000); });
    const mime = pickMime(), W = comp.width, H = comp.height;
    stream = comp.captureStream(0); let vt = stream.getVideoTracks()[0];
    if (!vt || typeof vt.requestFrame !== 'function') { stream.getTracks().forEach((t) => t.stop()); stream = comp.captureStream(CLIP_FPS); vt = null; }
    const dest = ctx.createMediaStreamDestination(); src = ctx.createBufferSource(); src.buffer = ab; src.connect(dest);
    stream.addTrack(dest.stream.getAudioTracks()[0]);
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: W * H >= 1.5e6 ? 16e6 : 8e6, audioBitsPerSecond: 160e3 } : undefined);
    const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((ok) => { rec.onstop = ok; });
    let run = true;
    const draw = () => {
      if (!run) return;
      cctx.drawImage(v, 0, 0, W, H); vt?.requestFrame?.();
      const f = v.duration > 0 ? Math.min(1, v.currentTime / v.duration) : 0; hqProgress(f, 0, 1, 0, 'ADDING SOUND');
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(draw); else requestAnimationFrame(draw);
    };
    cctx.drawImage(v, 0, 0, W, H); vt?.requestFrame?.();
    rec.start(250);
    await v.play();
    src.start(); draw();
    await new Promise((ok) => { v.onended = ok; const iv = setInterval(() => { if (job.cancel || v.error) { clearInterval(iv); ok(); } else if (v.ended) { clearInterval(iv); ok(); } }, 200); });
    run = false; try { src.stop(); } catch (e) {}
    try { rec.stop(); } catch (e) {}
    await stopped;
    if (job.cancel || !chunks.length) return null;
    return new Blob(chunks, { type: rec.mimeType || mime || 'video/mp4' });
  } catch (e) { console.warn('clip remux failed', e); return null; }
  finally {
    try { src?.disconnect(); } catch (e) {}
    stream?.getVideoTracks().forEach((t) => t.stop());
    v.pause(); v.removeAttribute('src'); v.load(); v.remove(); URL.revokeObjectURL(url);
  }
}
// the clip's sound rendered offline (also the live fallback's track, sound #5): null where it can't be
async function offlineAudio(C) {
  if (!window.OfflineAudioContext) return null;
  try { const actx = new OfflineAudioContext(2, Math.ceil((C.dur + 0.5) * 48000), 48000); clipAudio(actx, C); return await actx.startRendering(); }
  catch (e) { console.warn('offline clip audio', e); return null; }
}
// the clip's sound, re-synthesised on an OfflineAudioContext along the output timeline (hits, crash, rooms, grass)
function clipAudio(actx, C) {
  // [P3-G2] sound #5: the motors' noise is seeded from the clip's log (seed, world, first tick), so a clip renders the same
  // sound every time; the city's clip feed takes the take clock (seoul-audio adds the sims' warm start itself)
  const L0 = (C.raw || C.f).find((f) => f && f.L)?.L, key = `${L0?.header?.seed ?? 0}:${L0?.header?.world ?? ''}:${C.f[0]?.k ?? 0}:${C.f.length}`;
  let seed = 2166136261; for (let i = 0; i < key.length; i++) seed = Math.imul(seed ^ key.charCodeAt(i), 16777619) >>> 0;
  const a = new MotorAudio(); a.setCraft(drone.key); a.startOffline(actx, seed);
  let city = null; try { city = world.audio?.clip?.(actx, a) || null; } catch (e) { city = null; }   // [integ7] G: the level's city sound on HQ clips too
  const cfw = new THREE.Vector3();
  for (let i = 0; i < C.f.length; i++) {
    const fr = C.f[i], at = C.ot[i];
    if (city && fr.p && fr.q) { try { city.feed(fr.p, cfw.set(0, 0, -1).applyQuaternion(fr.q), ((fr.k || 0) + (fr.a || 0)) * PHYS, at); } catch (e) { city = null; } }
    if (i === 0 || C.seg[i] !== C.seg[i - 1]) a.snap();
    if (i > 0) { if (fr.hit) a.hit(fr.hit, at); if (fr.thud) a.thud(fr.thud, at); }
    a.update(fr.m, fr.s, fr.wash, fr.c, false, fr.ax, at);
  }
  return a;
}
// ---- live (fallback): the replay plays in real time into MediaRecorder
// U5 (sound #5): the sound is the offline render (the same track HQ gets), played from an AudioBufferSourceNode into
// the recorder when it arms, and the 30p frames are paced by that audio clock instead of performance.now(), so a
// starved phone drops frames without the video running short of the audio. No OfflineAudioContext: the live synth.
async function recordLive(C, b, kind) {
  if (!window.MediaRecorder || !comp.captureStream) { toast('THIS BROWSER CAN\'T RECORD CLIPS', 2.5, true); setPhase(clipDone ? 'done' : 'choose'); return; }
  let ab = null;
  if (audio.ctx && audio.ctx.state !== 'closed') {
    const job = hqJob = { cancel: false, prep: true };
    if (!clipOpen) pauseForClip();
    $('clip').classList.remove('hidden'); setPhase('render'); $('clipMeta').textContent = 'PREPARING SOUND'; $('clipProgB').style.width = '0%';
    ab = await offlineAudio(C);
    hqJob = null;
    if (job.cancel) { setPhase(clipDone ? 'done' : 'choose'); return; }
  }
  const lay = clipPrefs.lay, mime = pickMime(), big = !mime.includes('42E01F');    // baseline L3.1 tops out at 720p
  const W = big ? 1080 : 720, H = big ? 1920 : 1280, pic = prepComp(W, H, lay);
  let stream = comp.captureStream(0), vt = stream.getVideoTracks()[0];
  if (!vt || typeof vt.requestFrame !== 'function') { stream.getTracks().forEach((t) => t.stop()); stream = comp.captureStream(CLIP_FPS); vt = null; }
  let dest = null;
  if (ab) { try { dest = audio.ctx.createMediaStreamDestination(); stream.addTrack(dest.stream.getAudioTracks()[0]); } catch (e) { dest = null; ab = null; } }
  if (!ab) { const at = audio.streamDest?.stream.getAudioTracks()[0]; if (at) stream.addTrack(at); }
  try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: big ? 12e6 : 6e6, audioBitsPerSecond: 160e3 } : undefined); }
  catch (e) { stream.getVideoTracks().forEach((t) => t.stop()); toast('THIS BROWSER CAN\'T RECORD CLIPS', 2.5, true); setPhase(clipDone ? 'done' : 'choose'); return; }
  recChunks = [];
  const rec = recorder;
  rec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  rec.onstop = () => showClip(new Blob(recChunks, { type: rec.mimeType || mime || 'video/mp4' }), { dur: C.dur, caps: C.caps.map((c) => [c.t, c.text]), sigma: C.sigma, jit: C.jit, raw: C.rawJit, W, H, kind, lay, fixed: !!vt });
  clipBuf = b; clipKind = kind;
  $('clip').classList.add('hidden'); clipOpen = false; document.body.classList.remove('clipopen');   // the composite plays on screen while it records
  replay = { clip: C, k: -1, i: -1, t: 0, dur: C.dur, wall0: 0, armed: false, prev: state, stream, vt, st: null, W, RW: pic.w, RH: pic.h,
    letterbox: fpv.look.letterbox, targetMs: fpv.targetMs, ab, dest, src: null, a0: 0 };
  renderer.setSize(pic.w, pic.h, false); fpv.resize(pic.w, pic.h); fpv.look.letterbox = 0; fpv.targetMs = 1000 / CLIP_FPS; fpv.resetExposure = true;
  state = 'replay'; controls.enabled = false; controls.cancelAll?.();
  $('crashBar').classList.add('hidden'); $('banner').classList.add('hidden');
  comp.classList.remove('hidden'); fitComp(true); document.body.classList.add('replaying');
  $('recT').textContent = `REPLAY 0:00 / ${fmtS(C.dur)}`; $('recP').style.width = '0%';
  // sound panel r3 #6: the modal suspended the context; start the clock and the recorder only once it runs again
  // (or after 300 ms), so the clip doesn't open with a gap or an audio offset
  const r0 = replay, res = audio.ctx?.state === 'running' ? Promise.resolve() : Promise.resolve(audio.ctx?.resume?.()).catch(() => {});
  Promise.race([res, new Promise((ok) => setTimeout(ok, 300))]).then(() => {
    if (replay !== r0) return;
    r0.armed = true; r0.wall0 = performance.now() / 1000;
    r0.stopTm = setTimeout(() => { if (replay === r0) endReplay(); }, Math.round((C.dur + 1.5 / CLIP_FPS) * 1000));   // ends on time even if frames run slow
    try { rec.start(250); } catch (e) { endReplay(true); toast('THIS BROWSER CAN\'T RECORD CLIPS', 2.5, true); return; }
    if (r0.ab) {                                                 // the clip's own sound, started with the recorder
      const ctx = audio.ctx, s = ctx.createBufferSource(); s.buffer = r0.ab; s.connect(r0.dest);
      if (audio.spk) s.connect(audio.spk);                       // heard as the game would be (Sound Off: silent)
      r0.src = s; r0.clk = ctx.state === 'running'; r0.a0 = ctx.currentTime; r0.wall0 = performance.now() / 1000; s.start();
      if (window.__onetakeClipDebug) r0.dbg = [];
    }
  });
}
// next 30p output frame, paced by the wall clock: null when none is due (nothing to render this rAF). A slow device
// skips output frames instead of stretching time, so the video stays in sync with the real-time audio.
function replayFrame() {
  const r = replay, C = r.clip;
  if (!r.armed) return null;
  // the audio clock while it runs and keeps up; if it stalls (suspended, or a device that doesn't advance it) by more
  // than 0.25 s against the wall clock, the wall clock takes over so the video never freezes
  const wall = performance.now() / 1000 - r.wall0;
  let el = wall;
  if (r.clk) { const ac = audio.ctx.state === 'running' ? audio.ctx.currentTime - r.a0 : -1; if (ac >= 0 && ac > wall - 0.25) el = ac; else r.clk = false; }
  if (r.dbg && r.dbg.length < 400) r.dbg.push([+wall.toFixed(3), +(audio.ctx ? audio.ctx.currentTime - r.a0 : -1).toFixed(3), r.clk ? 1 : 0, r.k]);
  const due = Math.floor(el * CLIP_FPS + 1e-6);
  if (due <= r.k) return null;
  const T = due / CLIP_FPS;
  if (T > C.dur + 0.5 / CLIP_FPS) { endReplay(); return null; }
  const step = r.k < 0 ? 1 : due - r.k; r.k = due; r.t = Math.min(T, C.dur);
  let i = r.i; const n = C.f.length;
  const live = !r.ab;                                           // the live synth plays the clip (no offline track)
  if (i < 0) { i = 0; if (live) audio.snap?.(); }
  while (i < n - 1 && C.ot[i + 1] <= T) {
    i++; const fr = C.f[i];
    if (C.seg[i] !== C.seg[i - 1]) { if (live) audio.snap?.(); fpv.resetExposure = true; }   // hard cut: no glide or AE drift across it
    if (live) { if (fr.hit) audio.hit(fr.hit); if (fr.thud) audio.thud(fr.thud); }        // bumps + crash land in the clip
  }
  r.i = i;
  const a = C.f[i], b = i + 1 < n && C.seg[i + 1] === C.seg[i] ? C.f[i + 1] : null;
  const u = b ? Math.max(0, Math.min(1, (T - C.ot[i]) / Math.max(1e-6, C.ot[i + 1] - C.ot[i]))) : 0;
  return { a, b, u, dt: step / CLIP_FPS };
}
// replay pose at the output frame: positions/rates lerped, the view slerped between the two recorded frames
function replayPose(f) {
  const { a, b, u } = f;
  if (canvas.width !== replay.RW || canvas.height !== replay.RH) { renderer.setSize(replay.RW, replay.RH, false); fpv.resize(replay.RW, replay.RH); fitComp(true); }   // a rotate mid-replay
  if (b) {
    camPose.pos.copy(a.p).lerp(b.p, u); camPose.quat.copy(a.q).slerp(b.q, u); motion.vel.copy(a.v).lerp(b.v, u); motion.ang.copy(a.w).lerp(b.w, u);
    for (const k in a.mo) motion[k] = a.mo[k] + ((b.mo[k] ?? a.mo[k]) - a.mo[k]) * u;
    replay.st = a.st.map((v, k) => v + (b.st[k] - v) * u);
  } else {
    camPose.pos.copy(a.p); camPose.quat.copy(a.q); motion.vel.copy(a.v); motion.ang.copy(a.w); Object.assign(motion, a.mo); replay.st = a.st;
  }
  audio.update(a.m, a.s, a.wash, a.c, !!replay.ab, a.ax);        // the offline track plays instead: the synth stays quiet
}
function endReplay(cancel = false) {
  if (!replay) return;
  const r = replay; replay = null; clearTimeout(r.stopTm);
  if (r.src) { try { r.src.stop(); } catch (e) {} try { r.src.disconnect(); } catch (e) {} }
  if (r.dbg) window.__onetakeClipDbg = r.dbg;
  if (cancel && recorder) { recorder.onstop = null; recorder.ondataavailable = null; recChunks = []; }
  try { if (recorder?.state !== 'inactive') recorder?.stop(); } catch (e) {}
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
let clipLay = null, radioBg = null;
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
// one output frame of the composite: the rendered picture (full bleed, or square over the radio), sticks, caption.
// Returns the index of the caption drawn (-1: none). Captions never carry across a hard cut.
function drawComp(C, T, i, st) {
  const L = clipLay, g = cctx;
  if (L.full) g.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, L.W, L.H);   // WebGL frame (still valid in this task)
  else { g.drawImage(radioBg, 0, 0); g.drawImage(canvas, 0, 0, canvas.width, canvas.height, L.pic.x, L.pic.y, L.pic.w, L.pic.h); drawSticks(g, L, st || [0, 0, 0, 0], T); }
  let ci = -1;
  for (let k = 0; k < C.caps.length; k++) { if (C.caps[k].t <= T + 1e-6) ci = k; else break; }
  const cap = C.caps[ci];
  if (cap && cap.seg === C.seg[i] && T - cap.t <= CAP_DUR) { drawCaption(g, L.cap, cap.text, cap.flow, T - cap.t, cap); return ci; }
  return -1;
}
function compFrame() {
  const r = replay;
  drawComp(r.clip, r.t, r.i, r.st);
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
const CAP_DUR = 1.6;   // [F2] the caption accent is capAccent (the level's, else #E75211)
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
// reference Shorts caption on the FPV picture's bottom edge: cap height ~5.5 % of the picture width, baseline 4 % up.
// [F2] ui #6: the street in hangul as a second line (the caption rises by it); ui #2: the level's accent, and the
// luma-gated plate (rgba(0,0,0,.35), radius ~10 px at the live size), metered once per caption on its first frame.
const CAP_KO = '"OT KR", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
// metered through a small CPU canvas: getImageData on the composite itself would count as readbacks against it (Chrome
// then moves a 2D canvas off the GPU, and every later frame's drawImage of the WebGL picture would read back)
let capMC = null;
function compLuma(g, x, y, w, h) {
  x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
  w = Math.min(g.canvas.width - x, Math.ceil(w)); h = Math.min(g.canvas.height - y, Math.ceil(h));
  if (w < 4 || h < 4) return 0;
  try {
    if (!capMC) { const c = document.createElement('canvas'); c.width = 128; c.height = 32; capMC = c.getContext('2d', { willReadFrequently: true }); }
    capMC.clearRect(0, 0, 128, 32); capMC.drawImage(g.canvas, x, y, w, h, 0, 0, 128, 32);
    return lumaP80(capMC.getImageData(0, 0, 128, 32).data, 128 * 32, 4);
  } catch (e) { return 0; }
}
function drawCaption(g, box, text, flow, age, cap = null) {
  if (age < 0 || age > CAP_DUR) return;
  const fs = Math.round(box.w * 0.08), place = cap?.place || '', pfs = Math.round(fs * 0.42);
  const parts = splitAccent(text).map((s, i) => [s, i === 1 ? capAccent : '#fff']).filter((p) => p[0]);
  g.save();
  g.font = `900 ${fs}px Montserrat, "Barlow Condensed", system-ui, sans-serif`;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.lineJoin = 'round'; g.miterLimit = 2;
  const ws = parts.map((p) => g.measureText(p[0]).width), tw = ws.reduce((a, b) => a + b, 0);
  let pw = 0; if (place) { g.font = `800 ${pfs}px ${CAP_KO}`; pw = g.measureText(place).width; g.font = `900 ${fs}px Montserrat, "Barlow Condensed", system-ui, sans-serif`; }
  const fit = Math.min(1, (box.w * 0.9) / Math.max(1, tw, pw));
  const lift = place ? pfs * 1.3 : 0, cx = box.x + box.w / 2, by = box.y + box.h * 0.96;
  // plate box in caption units (baseline of the place line, or of the caption, at 0)
  const px = Math.max(tw, pw) / 2 + fs * 0.3, py0 = -lift - fs * 0.86, py1 = (place ? pfs * 0.34 : fs * 0.2);
  if (cap && cap.plate === undefined) cap.plate = compLuma(g, cx - px * fit, by + py0 * fit, 2 * px * fit, (py1 - py0) * fit) > CAP_GATE;
  const k = Math.min(1, age / 0.16), popS = 1 + 0.25 * (1 - k) * (1 - k);
  g.globalAlpha = Math.max(0, Math.min(1, age / 0.05, (CAP_DUR - age) / 0.25));
  g.translate(cx, by); g.scale(fit * popS, fit * popS);
  if (cap?.plate) {
    g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath();
    if (g.roundRect) g.roundRect(-px, py0, 2 * px, py1 - py0, fs * 0.22); else g.rect(-px, py0, 2 * px, py1 - py0);
    g.fill();
  }
  g.lineWidth = fs * 0.18; g.strokeStyle = '#000';
  g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = fs * 0.12; g.shadowOffsetY = fs * 0.05;
  let x = -tw / 2; parts.forEach((p, i) => { g.strokeText(p[0], x, -lift); x += ws[i]; });
  if (place) { g.font = `800 ${pfs}px ${CAP_KO}`; g.textAlign = 'center'; g.lineWidth = pfs * 0.26; g.strokeText(place, 0, 0); }
  g.shadowColor = 'transparent';
  g.font = `900 ${fs}px Montserrat, "Barlow Condensed", system-ui, sans-serif`; g.textAlign = 'left';
  x = -tw / 2; parts.forEach((p, i) => { g.fillStyle = p[1]; g.fillText(p[0], x, -lift); x += ws[i]; });
  if (place) { g.font = `800 ${pfs}px ${CAP_KO}`; g.textAlign = 'center'; g.fillStyle = '#fff'; g.fillText(place, 0, 0); }
  if (flow >= 6) { g.textAlign = 'center'; g.font = `${Math.round(fs * 1.3)}px system-ui, "Apple Color Emoji", sans-serif`; g.fillText('😮', 0, -lift - fs * 1.12); }
  g.restore();
}
// ---- clip modal: pauses the game (frame() early-out, controls off, live audio muted); other cuts re-render from it
let clipURL = null;
function pauseForClip() {
  clipOpen = true; controls.enabled = false; controls.cancelAll?.();
  document.body.classList.add('clipopen');                                         // ui #1: no dimmed OSD through the modal
  audio.update(drone.motors, 0, 0, drone.crashed, true, ax);                      // fade the live game sound out
  setTimeout(() => { if (clipOpen && state !== 'replay' && !hqJob) audio.idle?.(); }, 250);
}
let clipCanShare = false;
function showClip(blob, info = {}, quiet = false) {
  clearTimeout(clipWait);
  if (clipURL) URL.revokeObjectURL(clipURL);
  clipURL = URL.createObjectURL(blob); lastClip = { blob, info };
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const v = $('clipVid'); v.src = clipURL;
  if (!quiet) { v.muted = false; v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); }   // with its sound where autoplay allows
  else v.muted = false;
  const a = $('clipSave'); a.href = clipURL; a.download = `onetake-${Date.now()}.${ext}`;
  const file = new File([blob], a.download, { type: blob.type });
  clipCanShare = !!navigator.canShare?.({ files: [file] });
  // the share sheet is the primary save on iOS ("Save Video" -> Photos); <a download> only reaches Files
  $('clipShare').textContent = clipCanShare ? 'SAVE VIDEO' : 'DOWNLOAD';
  const nc = info.caps?.length || 0;
  $('clipMeta').textContent = `${fmtS(Math.round(info.dur || 0))} · ${info.W}×${info.H} · 30p${info.hq ? ` · HQ ${info.hq.sub}× shutter` : ''}${info.sigma > 0 ? ' · stabilised' : ''}${nc ? ` · ${nc} caption${nc > 1 ? 's' : ''}` : ''}`;
  clipDone = { kind: info.kind, lay: info.lay, hq: !!info.hq }; clipSel = info.kind || clipSel;
  if (!quiet) {
    pauseForClip();
    $('clip').classList.remove('hidden'); comp.classList.add('hidden'); fitComp(false);
  }
  setPhase('done');
  $('clipShare').onclick = async () => {
    if (clipCanShare) { try { await navigator.share({ files: [file], title: 'One Take' }); } catch (e) {} }
    else a.click();
  };
}
function closeClip() {
  clearTimeout(clipWait);
  if (hqJob) hqJob.cancel = true;
  $('clip').classList.add('hidden'); $('clipVid').pause(); comp.classList.add('hidden'); fitComp(false);
  document.body.classList.remove('clipopen', 'hqbg', 'replaying');
  if (!clipOpen) return;
  clipOpen = false;
  if (state === 'fly' || state === 'crash') controls.enabled = true;
  audio.kick?.();                                              // inside the CLOSE tap
}
$('clipClose').onclick = () => { if (hqJob) { hqJob.cancel = true; return; } closeClip(); };   // rendering: CANCEL back to the cuts
$('clipHide').onclick = () => hideRender();                     // rendering: CLOSE, the render carries on (CLIP READY)
$('recT').addEventListener('click', () => { if (hqJob?.bg) showRender(); });
$('clipMake').onclick = () => saveClip(clipSel, clipBuf);
$('clipCuts').addEventListener('click', (e) => {
  const el = e.target.closest('button[data-cut]'); if (!el || el.disabled) return;
  clipSel = el.dataset.cut; syncCuts();
});
$('clipOpts').addEventListener('click', (e) => {
  const el = e.target.closest('button'); if (!el || el.disabled) return;
  if (el.dataset.lay) clipPrefs.lay = el.dataset.lay; else if (el.id === 'clipHQ') clipPrefs.hq = !clipPrefs.hq;
  saveClipPrefs(); syncCuts();
});

// ---------------- [F2] ui #6: place names. The street (OSM `ko`, e.g. 와우산로21길) or landmark (layout.hero, e.g. 홍대입구역
// 9번 출구, within 20 m) under a point, from the level's layout. Captions carry it as their second line, live and in clips.
function buildPlaces(layout) {
  const segs = [], marks = [];
  for (const s of layout.streets || []) {
    const P = s.points || [], hw = (+s.width || 6) / 2; if (!s.ko || P.length < 2) continue;
    for (let i = 0; i + 1 < P.length; i++) segs.push([P[i][0], P[i][1], P[i + 1][0], P[i + 1][1], hw, s.ko]);
  }
  for (const h of layout.hero || []) if (h.ko && Array.isArray(h.pos)) marks.push([h.pos[0], h.pos[2], h.ko]);
  return { segs, marks };
}
function placeAt(p) {
  const P = world.places; if (!P || !p) return '';
  let best = '', bd = 20;
  for (const [x, z, ko] of P.marks) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd && !P.segs.some((s) => s[5] === ko)) { bd = d; best = ko; } }
  if (best) return best;                                        // a landmark that isn't a street name wins (놀이터, 9번 출구)
  bd = Infinity;
  for (const [ax, az, bx, bz, hw, ko] of P.segs) {
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / L2)) : 0;
    const d = Math.hypot(p.x - ax - t * dx, p.z - az - t * dz) - hw;   // from the street's edge
    if (d < bd) { bd = d; best = ko; }
  }
  return bd <= 6 ? best : '';
}

// ---------------- [F2] ui #2: the luma-gated caption plate. One async readback of the picture under the caption per caption
// (WebGL2 PBO + fence: no pipeline stall), read a frame or two later. Gate: the box's 80th-percentile luma > 0.6, i.e. a
// fifth of it is lit sign / window (club90 had 39 % over 0.85, station2 23 %). Clips meter their own frame (drawCaption).
const CAP_GATE = 0.6;
const capM = { want: 0, pbo: null, cap: 0, sync: null, n: 0, buf: null, luma: -1, plate: false };
function lumaP80(px, n, stride = 4 * 2) {
  const h = new Uint32Array(64); let c = 0;
  for (let i = 0; i < n * 4; i += stride) { h[Math.min(63, (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) >> 2)]++; c++; }
  let k = 0, a = 0; for (; k < 64; k++) { a += h[k]; if (a >= 0.8 * c) break; }
  return c ? (k * 4 + 2) / 255 : 0;
}
function capMeterFrame() {
  const gl = renderer.getContext();
  if (typeof gl.fenceSync !== 'function') return;                       // WebGL1: no plate (three r180 is WebGL2 anyway)
  if (capM.sync) {
    const r = gl.clientWaitSync(capM.sync, 0, 0);
    if (r === gl.TIMEOUT_EXPIRED) return;
    gl.deleteSync(capM.sync); capM.sync = null; if (r === gl.WAIT_FAILED) return;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, capM.pbo); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, capM.buf, 0, capM.n * 4); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    capM.luma = lumaP80(capM.buf, capM.n); capM.plate = capM.luma > CAP_GATE;
    $('pop').classList.toggle('plate', capM.plate && !!popKind);
    return;
  }
  if (!capM.want || --capM.want > 0 || state !== 'fly') return;          // a frame after setPop: the caption is laid out
  const P = $('pop'), r = P.getBoundingClientRect(), v = canvas.getBoundingClientRect();
  const sx = canvas.width / Math.max(1, v.width), sy = canvas.height / Math.max(1, v.height);
  const x0 = Math.max(0, Math.floor((r.left - v.left) * sx)), x1 = Math.min(canvas.width, Math.ceil((r.right - v.left) * sx));
  const y0 = Math.max(0, Math.floor((v.bottom - r.bottom) * sy)), y1 = Math.min(canvas.height, Math.ceil((v.bottom - r.top) * sy));
  const w = x1 - x0, h = y1 - y0; if (w < 4 || h < 4) return;
  const bytes = w * h * 4;
  if (!capM.pbo) capM.pbo = gl.createBuffer();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, capM.pbo);
  if (bytes > capM.cap) { capM.cap = bytes; gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ); capM.buf = new Uint8Array(bytes); }
  renderer.setRenderTarget(null);                                       // the canvas: the frame just shown (graded, lens-mapped)
  gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  capM.n = w * h; capM.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
}

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
  try { document.fonts?.load?.(`800 ${Math.round(px * 0.42)}px "OT KR"`, '홍대 9')?.catch?.(() => {}); } catch (e) {}   // [F2] the place line's hangul face (7 KB)
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
function showLine(text, subHTML = '', flow = 1, place = '') {
  if (/^\+0(?!\d)/.test(subHTML)) subHTML = '';   // free fly: lines caption with pts 0, so no "+0" sub-line
  else if (subHTML && lineTag) subHTML += lineTag;  // C: a line flown with no contact since the last one (×1.25)
  lineTag = '';
  setPop('line', (flow >= 6 ? '<span class="emo">😮</span>' : '') + accentHTML(text), subHTML, CAP_DUR, place);
}
function setPop(kind, capHTML, subHTML, dur, place = '') {
  const p = $('pop'); popKind = kind;
  p.querySelector('.cap').innerHTML = capHTML; p.querySelector('.sub').innerHTML = subHTML || '';
  p.querySelector('.place').textContent = place || '';               // [F2] ui #6
  p.className = kind + (capM.plate && kind === 'line' && p.classList.contains('show') ? ' plate' : '');   // a caption over a caption keeps its plate until re-metered
  p.style.setProperty('--popDur', dur + 's');
  void p.offsetWidth; p.classList.add('show');
  capM.want = 2;                                                        // [F2] ui #2: meter the picture under it next frame
  clearTimeout(popTm); popTm = setTimeout(() => { p.classList.remove('show', 'plate'); popKind = ''; }, dur * 1000);
  // the live chain + drain bar stay up under the caption (design #1): it sits below it now, so no hiding
}
let warnTm = 0, toastTm = 0;
function warn(text, secs = 1.6) {
  const w = $('warn'); w.textContent = String(text).toUpperCase(); w.classList.remove('show'); void w.offsetWidth; w.classList.add('show');
  clearTimeout(warnTm); warnTm = setTimeout(() => w.classList.remove('show'), secs * 1000);
}
// imp: also shown over the Clean overlay (body.nohud hides the rest, e.g. LOW POWER)
let toastTxt = '', toastEnd = 0;
function toast(text, secs = 1.8, imp = false) {
  const t = $('toast'); t.textContent = text; t.classList.toggle('warn', !!imp); t.classList.add('show');
  toastTxt = String(text).toUpperCase(); toastEnd = performance.now() + secs * 1000;
  clearTimeout(toastTm); toastTm = setTimeout(() => t.classList.remove('show'), secs * 1000);
}
const toastSays = (s) => !!s && toastTxt === String(s).toUpperCase() && performance.now() < toastEnd;
// [F2] P3 ui #3 / ux #1: a person hit is HEADS! in the caption face, hot pink, a 12-way stroke, held 0.9 s, at any FLOW
// (at ×1 it was silent: the SCRAPE warning only shows when FLOW was lost). The sub-line says what it cost.
let headsTm = 0;
function headsStamp(e) {
  const h = $('heads'); if (!h) { warn('HEADS!'); return; }
  h.querySelector('small').textContent = e.lost ? `FLOW ×${e.flow || 1} · −${e.lost}` : 'SCRAPE';   // what it cost
  h.classList.remove('show'); void h.offsetWidth; h.classList.add('show');
  clearTimeout(headsTm); headsTm = setTimeout(() => h.classList.remove('show'), 1250);
  try { navigator.vibrate?.(20); } catch (er) {}   // Android; iOS Safari has none (native: a haptic tick)
}
// [F2] P3 ui #3: what a crash hit (take.js crash.by, flight.js crashBy: the world.movers body's type)
const BY = { bus: 'A BUS', taxi: 'A TAXI', car: 'A CAR', truck: 'A TRUCK', van: 'A VAN', scooter: 'A SCOOTER', moped: 'A SCOOTER', motorbike: 'A MOTORBIKE', bike: 'A BIKE', bicycle: 'A BIKE', pedestrian: 'SOMEONE', person: 'SOMEONE', vehicle: 'TRAFFIC' };
const byText = (b) => { const k = String(b || '').trim().toLowerCase(); if (!k) return ''; const u = k.toUpperCase().replace(/[^A-Z0-9 -]/g, ''); return 'HIT ' + (BY[k] || `${/^[AEIOU]/.test(u) ? 'AN' : 'A'} ${u}`); };

function updateHud(dt) {
  hudFast(dt);
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
  $('score').textContent = fmtN(v.total);   // BEST is on the cards and the menu only (UX #5)
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
  // live chain under the caption spot, with the bank drain bar (hudFast). Not below ×2 (UX #5: a game element in the
  // OSD that says nothing yet). ×N is a persistent node that pops when FLOW goes up (UI #2).
  const L = $('live');
  if (v.unbanked > 0 && state === 'fly' && !summaryUp() && (!v.take || v.flow >= 2)) {
    const X = $('liveX'), x = v.flow >= 2 ? `×${v.flow}` : '';
    $('liveK').textContent = v.take ? 'FLOW' : 'SKIM';
    if (X.textContent !== x) { X.textContent = x; if (v.flow > liveFlow) { X.classList.remove('up'); void X.offsetWidth; X.classList.add('up'); } }
    $('liveU').textContent = fmtN(v.unbanked);
    L.classList.add('show');
  } else L.classList.remove('show');
  liveFlow = v.flow;
  readyNow = readyHint();
  if (drone.limitHit > 0 && performance.now() - lastLimitToast > 2500) { lastLimitToast = performance.now(); warn(drone.pos.y >= (world.envelope?.max.y ?? 1e9) - 0.01 ? 'CEILING' : 'WORLD EDGE'); }
  // --- next line: Betaflight-style home arrow (8 steps) + name + distance, until the level's guideUntil lines have ever
  // been flown (bando 3; [F2] Seoul: all of them, the city is too big to find them by eye). Gate brackets are per frame in
  // hudFast. The ready hint at the retry start says the same thing (▼ · DROP IN), so the arrow steps aside while it shows.
  // [F2] ux #2: armed (a start gate crossed, the end gate not yet): the same slot reads "HONGIK-RO · 0:18", counting down.
  const live = state === 'fly' && !summaryUp() && ts !== 'done' && !drone.crashed;
  nextNow = live ? nextLine() : null;
  armNow = live ? armedLine(curTake()) : null;
  const gu = levelOf(world.level)?.guideUntil ?? 3, arm = armNow; let bk = false;
  const nx = arm ? (nextNow?.name === arm.name ? nextNow : armTarget(arm)) : nextNow;
  const guide = !!nx && (!!arm || (flownCount() < gu && !(readyNow && ts === 'ready'))), dir = nx ? octant(nx) : 0, vt = nx ? vertOf(nx) : null;
  guideNow = guide;
  if (guide) {
    $('oNext').classList.toggle('v', !!vt);
    if (vt) $('oNextV').style.transform = vt === 'up' ? 'rotate(180deg)' : '';
    else $('oNextA').style.transform = `rotate(${dir * 45}deg)`;
    $('oNextN').textContent = arm ? arm.name : nx.name;
    const D = $('oNextD');
    // [F2] P3 ui #4 / ux #5: the target is bracketed on screen: the bracket's label names it, so the guide keeps its arrow
    // (and, armed, the countdown) and drops the repeat ("THE GAP 9M" twice, 16 px apart)
    bk = bracketed(arm ? arm.name : nx.name);
    D.textContent = arm ? (arm.left != null ? `${bk ? '' : '· '}${fmtS(Math.ceil(arm.left))}` : '') : `${Math.round(nx.dist)}M${vt ? '' : elevTxt(nx)}`;
    D.classList.toggle('low', !!arm && arm.left != null && arm.left <= 5);
  }
  $('oNext').classList.toggle('on', guide); $('oNext').classList.toggle('armed', guide && !!arm); $('oNext').classList.toggle('bk', guide && bk);
  brCands = live ? bracketCands(arm) : [];
  // --- radio OLED (portrait)
  $('oMd').textContent = { cine: 'CINE', angle: 'ANGLE', acro: 'ACRO' }[S.mode]; $('oT').textContent = fmt(time); $('oS').textContent = `${kmh} KM/H`;
  const bars = world.lastDist < 3 ? Math.max(0, Math.min(4, Math.round(4 - world.lastDist / 0.5))) : 0;
  $('oPx').querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', i < bars));
  $('oSc').textContent = fmtN(v.total);
  $('oSt').classList.toggle('wrap', !!(readyNow && ts === 'ready'));
  $('oSt').textContent = drone.crashed ? 'CRASHED' : cutLeft > 0 ? (cutLand ? 'LANDED · CUT…' : `CUT ${Math.ceil(cutLeft)}…`) : drone.limitHit > 0 ? 'LIMIT' :
    v.unbanked > 0 ? `${v.take ? 'FLOW' : 'SKIM'}${v.flow >= 2 ? ' ×' + v.flow : ''} +${fmtN(v.unbanked)}` :
    readyNow && ts === 'ready' ? readyNow :
    guide && arm ? `${vt ? (vt === 'up' ? '▲' : '▼') : HOME_ARROWS[dir]} ${arm.name}${arm.left != null ? ' ' + fmtS(Math.ceil(arm.left)) : ''}` :
    guide ? `${vt ? (vt === 'up' ? '▲' : '▼') : HOME_ARROWS[dir]} ${nx.name} ${Math.round(nx.dist)}M` :
    ts === 'live' ? '● REC' : ts === 'ready' ? 'READY · FLY A LINE' : ts === 'done' ? (crashedTake() ? 'CRASHED' : 'CUT') :
    S.mode !== 'cine' ? `THR ${Math.round(controls.thr * 100)}%  BEST ${fmtN(v.best)}` : `BEST ${fmtN(v.best)}`;
}

// ---------------- per-frame HUD: take tag (REC / CUT countdown / CRASHED), bank drain bar, gate brackets, LOW POWER
const CUT_RING = 2 * Math.PI * 28;                                // #cutArc circumference (r 28: the 64 px centre ring)
const HOME_ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];     // OLED home arrow, clockwise from the nose
let cutLeft = 0, cutLand = false, tagKey = '', nextNow = null, lowPow = false, batLvl = 0, drainK = -2, armNow = null, brCands = [], brOn = 0;
let liveFlow = 1, readyNow = '', guideNow = false, restT = 0, odOn = false, ghostOn = false, ghostFar = false;
const crashedTake = () => drone.crashed || sum.kind === 'crash' || pendingSum?.type === 'crash';
// C12 (D5): where the best take's ghost is now: take.ghostPose(t) / take.ghost.pose(t) / take.ghost.pos, as {pos|p} or
// [x,y,z] or {x,y,z}. Absent (or not flying a take): null.
function ghostPos(t) {
  if (!t || S.game === 'free') return null;
  let g = null;
  try {
    const tt = typeof t.time === 'number' ? t.time : +t._t || 0;
    if (typeof t.ghostPose === 'function') g = t.ghostPose(physAlpha);   // D5: alpha between the last two ticks; take clock inside
    else if (t.ghost && typeof t.ghost.pose === 'function') g = t.ghost.pose(tt);
    else if (typeof ghostPose === 'function') g = ghostPose(tt);   // eslint-disable-line no-undef (main.js-level, if D5 puts it there)
    else g = t.ghost?.pos ?? null;
  } catch (e) { return null; }
  const p = g?.pos ?? g?.p ?? g?.position ?? g;
  if (Array.isArray(p) || ArrayBuffer.isView(p)) return p.length >= 3 && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]) ? { x: +p[0], y: +p[1], z: +p[2] } : null;
  return p && isFinite(p.x) && isFinite(p.y) && isFinite(p.z) ? p : null;
}
function hudFast(dt = 0) {
  capMeterFrame();                                                  // [F2] ui #2: right after the frame was drawn
  const t = curTake(), ts = t && S.game !== 'free' ? t.state : null;   // free fly: no take, no tag
  // CUT countdown, decision 10. C: take.cutIn = s until the CUT while the ring shows (after cutShow 1 s of hands-off
  // hover, or at once on a touchdown), else 0; take.cutFrac = ring fill 0..1; take.cutKind 'hover' | 'land'.
  // Any stick cancels it (C resets the hover). Without C: the round-2 hover timer, ring from 1 s.
  const cutT = +LT().cutT || 3, from = Math.max(0.3, cutT - 1);
  let ci = 0, frac = 0;
  if (t && ts === 'live' && state === 'fly') {
    if (typeof t.cutIn === 'number') { if (t.cutIn > 0) { ci = t.cutIn; frac = typeof t.cutFrac === 'number' ? t.cutFrac : 1 - ci / from; } }
    else { const c = t._hover > 0 && (t.total || 0) + (t.unbanked || 0) > 0 ? cutT - t._hover : 0; if (c > 0 && c <= from) { ci = c; frac = 1 - c / from; } }
  }
  cutLeft = ci; cutLand = !!ci && t.cutKind === 'land';
  // LIFT THUMBS (ux #4): 2 s of hovering with a live chain and a thumb resting (centred) on the glass, which counts as
  // hands on and never CUTs: a greyed full ring that says why
  if (!ci && t && ts === 'live' && state === 'fly' && !drone.crashed && !summaryUp()) {
    const tn = controls.touches?.size ?? 0, eps = 0.02;
    const centred = Math.max(Math.abs(tickInp.pitch), Math.abs(tickInp.roll), Math.abs(tickInp.yaw)) <= eps && (S.mode !== 'cine' || Math.abs(tickInp.climb) <= eps);
    const hov = drone.vel.length() < (+LT().cutSpeed || 1) && (t.total || 0) + (t.unbanked || 0) > 0;
    restT = tn > 0 && centred && hov ? restT + dt : 0;
  } else restT = 0;
  const rest = restT >= 2;
  // the countdown is the 64 px ring at the centre of the view (design #3); the tag keeps saying REC until the CUT lands.
  // Ready at the retry start: the tag's second line says how to begin (UX #3, readyHint).
  const rh = ts === 'ready' && !toastSays(readyNow) ? readyNow : '';   // [F2] P3: said once, by the toast, while it shows
  const txt = !ts ? '' : crashedTake() ? 'CRASHED' : ts === 'live' ? 'REC' : ts === 'done' ? 'CUT' : 'READY';
  const cls = 'o tl' + (ts ? ' on' : '') + (ts === 'live' ? ' live' : '') + (rh ? ' hint' : '');
  const key = cls + txt + rh + (ci ? (cutLand ? '|L' : '|' + Math.ceil(ci)) : rest ? '|R' : '');
  if (key !== tagKey) {
    tagKey = key; $('takeTag').className = cls; $('takeTxt').textContent = txt; $('takeHint').textContent = rh;
    document.body.classList.toggle('cutting', !!ci || rest);
    $('cutC').classList.toggle('rest', !ci && rest);
    if (ci) { $('cutN').textContent = cutLand ? '' : String(Math.ceil(ci)); $('cutL').textContent = cutLand ? 'LANDED' : 'CUT'; }
    else if (rest) { $('cutN').textContent = ''; $('cutL').textContent = 'LIFT THUMBS'; }
  }
  if (ci) {   // drains as it fills; the keyline follows the white arc, so the drained part is only the dark track
    const off = (CUT_RING * Math.max(0, Math.min(1, frac))).toFixed(2);
    $('cutArc').style.strokeDashoffset = off; $('cutArcK').style.strokeDashoffset = off;
  }
  // bank drain bar under the live chain: bankIn / bankT. C's take.holding (hugging structure keeps the chain alive) glows it.
  const L = $('live'), d = $('drain');
  const k = L.classList.contains('show') && t && typeof t.bankIn === 'number' ? Math.max(0, Math.min(1, t.bankIn / (+(t.tuning || LT()).bankT || 5))) : -1;   // [F2] P3: the level's bankT (Seoul 10 s)
  if (k !== drainK) {
    if ((k < 0) !== (drainK < 0)) d.style.display = k < 0 ? 'none' : '';
    drainK = k;
    if (k >= 0) { d.style.transform = `scaleX(${k.toFixed(3)})`; d.classList.toggle('low', t.bankIn < 1.5); }
  }
  if (k >= 0) d.classList.toggle('hold', !!t.holding);
  // portrait: the same drain as a 2 px rule under the OLED chain line (ui #2)
  const po = k >= 0 && document.body.classList.contains('portrait'), od = $('oDrain');
  if (po !== odOn) { odOn = po; od.classList.toggle('on', po); }
  if (po) { od.style.transform = `scaleX(${k.toFixed(3)})`; od.classList.toggle('low', t.bankIn < 1.5); }
  // ghost (C12): the best take, re-flown, as a hollow diamond over where it is now
  let gOn = false;
  const gp = ts === 'live' && state === 'fly' ? ghostPos(t) : null;
  if (gp) {
    const p = projectView(gp);
    if (p && p.d > 0.6) {
      gOn = true; $('oGhost').style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-50%,-50%)`;
      const far = p.d > 30; if (far !== ghostFar) { ghostFar = far; $('oGhost').classList.toggle('far', far); }
    }
  }
  if (gOn !== ghostOn) { ghostOn = gOn; $('oGhost').classList.toggle('on', gOn); }
  drawBrackets();
  // iOS Low Power Mode pins rAF at 30 Hz; fpvcam notices and sets autoMs 33.3 (UX #6)
  if (state === 'fly') { const lp = (fpv.autoMs || 0) > 30; if (lp && !lowPow) toast('LOW POWER · 30 FPS', 3); lowPow = lp; }
}
// world point -> CSS px in #view through the fpvcam lens (inverse of the output pass: th = atan(r k / F) / k), or null.
// projectRaw: the same without the frame-edge test (a gate's corners may sit just outside the frame); u, v in 0..1.
const _iq = new THREE.Quaternion(), _pv = new THREE.Vector3();
function projectRaw(x, y, z, minLen = 0.3) {
  const L = fpv.lens; if (!L) return null;
  _pv.set(x, y, z).sub(camPose.pos).applyQuaternion(_iq.copy(camPose.quat).invert());
  const len = _pv.length(); if (len < minLen || _pv.z > -0.05) return null;
  const th = Math.acos(Math.min(1, -_pv.z / len)); if (th > L.thc) return null;
  const r = L.k > 0.999 ? L.F * Math.tan(th) : L.F * Math.tan(L.k * th) / L.k;
  const h = Math.hypot(_pv.x, _pv.y), s = h > 1e-6 ? r / h : 0;
  const u = 0.5 + _pv.x * s / (2 * L.hw), v = 0.5 + _pv.y * s / (2 * L.hh);
  return { x: u * viewW, y: (1 - v) * viewH, u, v, d: len };
}
function projectView(p) {
  const q = projectRaw(p.x, p.y, p.z);
  return q && q.u >= 0.03 && q.u <= 0.97 && q.v >= 0.06 && q.v <= 0.94 ? q : null;
}

// ---------------- [F2] ux #2: the armed line. F1's take.armed ({name, left | in, within, gate?}, or a function returning it)
// when take.js serves it; else read from the take's own pre-gate record (as nextHint's rule 1: crossed the right way,
// within the line's `within`, its end gate not flown yet). left: s until the start gate's crossing expires.
function armedLine(t) {
  if (!t || S.game === 'free' || t.state === 'done') return null;
  try {
    if ('armed' in t) {
      const a = typeof t.armed === 'function' ? t.armed() : t.armed; if (!a || !a.name) return null;
      const left = +(a.left ?? a.in ?? a.timeLeft ?? NaN);
      return { name: a.name, left: isFinite(left) ? Math.max(0, left) : null, gate: a.gate || a.line || null };
    }
    if (!(t._pre instanceof Map) || !Array.isArray(t._lines)) return null;
    let best = null;
    t._pre.forEach((r, k) => {
      const L = t._lines[Math.floor(k / 8)]; if (!L || L.l.micro) return;
      const left = (L.l.within ?? 6) - ((t._now || 0) - r.t);
      if (left > 0 && (L.l.two || r.s === 1) && (!best || r.t > best.t)) best = { name: L.l.name, left, t: r.t, gate: L.l };
    });
    return best;
  } catch (e) { return null; }
}
// the arrow's target while armed when nextHint points elsewhere: the armed line's end gate
const armGate = (arm) => (arm.gate?.c ? arm.gate : (world.lines || []).filter((l) => l?.name === arm.name && l.c).sort((a, b) => dist3(a.c) - dist3(b.c))[0] || null);
function armTarget(arm) {
  const g = armGate(arm);
  return g ? { name: arm.name, pos: new THREE.Vector3(g.c[0], g.c[1], g.c[2]), dist: dist3(g.c), fresh: false } : null;
}
const dist3 = (c) => Math.hypot(c[0] - camPose.pos.x, c[1] - camPose.pos.y, c[2] - camPose.pos.z);

// ---------------- [F2] ui #3 / ux #1: gate brackets. Candidates at 10 Hz (updateHud): the start gates (a line without one:
// its gate) of every never-flown named line within 34 m, and the armed line's end gate. Per frame: the nearest 3 whose
// centre is in frame within 30 m and not behind a wall (a BVH ray, re-tested every 0.15 s per gate), drawn as corner ticks
// on the gate's projected w x h, labelled "NAME 23M" ("23M" on the armed end gate).
const BR_N = 3, BR_R = 30, _br = new THREE.Ray(), brOcc = new Map();
function bracketCands(arm) {
  const out = [], flown = new Set(lineList().filter((l) => l.flown).map((l) => l.name));
  const armG = arm ? armGate(arm) : null;
  if (armG?.c && dist3(armG.c) < BR_R + 4) out.push({ g: armG, name: arm.name, end: true });
  for (const l of world.lines || []) {
    if (!l?.name || isMicro(l) || l.carve || flown.has(l.name) || (arm && l.name === arm.name)) continue;
    for (const g of l.pre?.length ? l.pre : [l]) if (g?.c && dist3(g.c) < BR_R + 4) out.push({ g, name: l.name, end: false });
  }
  return out;
}
function gateCorners(g) {
  const c = g.c, n = g.n || [0, 0, 1];
  let u = g.u || (Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [-n[2], 0, n[0]]);
  let ul = Math.hypot(u[0], u[1], u[2]) || 1; u = [u[0] / ul, u[1] / ul, u[2] / ul];
  let v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]], vl = Math.hypot(v[0], v[1], v[2]) || 1; v = [v[0] / vl, v[1] / vl, v[2] / vl];
  const hw = (+g.w || 2) / 2, hh = (+g.h || 2) / 2, P = [];
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const q = projectRaw(c[0] + u[0] * a * hw + v[0] * b * hh, c[1] + u[1] * a * hw + v[1] * b * hh, c[2] + u[2] * a * hw + v[2] * b * hh, 0.05);
    if (!q) return null; P.push(q);
  }
  return P;
}
function gateOccluded(cd, d) {
  const now = performance.now(), m = brOcc.get(cd.g);
  if (m && now - m.t < 150) return m.occ;
  let occ = false;
  if (world.bvh) {
    const c = cd.g.c; _br.origin.copy(camPose.pos); _br.direction.set(c[0] - camPose.pos.x, c[1] - camPose.pos.y, c[2] - camPose.pos.z).normalize();
    try { const hit = world.bvh.raycastFirst(_br, THREE.DoubleSide, 0, Math.max(0, d - 0.6)); occ = !!hit; } catch (e) {}
  }
  brOcc.set(cd.g, { t: now, occ }); if (brOcc.size > 64) brOcc.clear();
  return occ;
}
// [F2] P3 ui #4 / ux #5: collision rules. Nearest first; a farther bracket whose box overlaps a nearer one's by more than
// 30 % (of the smaller box) is skipped (cable_lat: CABLE THREAD nested in CABLE LATTICE); a label that would overlap a
// nearer label by more than 30 % is dropped, its ticks stay. The guide's text steps aside for a bracketed target (updateHud).
const ovl = (a, b) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? (w * h) / Math.max(1, Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))) : 0;
};
let brEls = null, brPx = 0, brPxH = 0;
const brSeenT = new Map();
function drawBrackets() {
  brEls ||= { G: $('oBr').children, L: document.querySelectorAll('#osd .brl') };
  const G = brEls.G, labels = brEls.L;
  let n = 0; const boxes = [], tags = [], now = performance.now();
  if (state === 'fly' && brCands.length && !summaryUp()) {
    if (brPxH !== viewH) { brPxH = viewH; brPx = parseFloat(getComputedStyle(labels[0]).fontSize) || 12; }   // label px (calc(--cell * .78), vh-based)
    const C = brCands.map((cd) => ({ cd, d: dist3(cd.g.c) })).filter((x) => x.d <= BR_R).sort((a, b) => a.d - b.d);
    for (const { cd, d } of C) {
      if (n >= BR_N) break;
      const c = cd.g.c; if (!projectView({ x: c[0], y: c[1], z: c[2] }) || gateOccluded(cd, d)) continue;
      const P = gateCorners(cd.g); if (!P) continue;
      const bx = [Math.min(P[0].x, P[1].x, P[2].x, P[3].x), Math.min(P[0].y, P[1].y, P[2].y, P[3].y), Math.max(P[0].x, P[1].x, P[2].x, P[3].x), Math.max(P[0].y, P[1].y, P[2].y, P[3].y)];
      if (boxes.some((b) => ovl(b, bx) > 0.3)) continue;
      boxes.push(bx); brSeenT.set(cd.name, now);
      let path = '';
      for (let i = 0; i < 4; i++) {
        const a = P[i], pv = P[(i + 3) % 4], nx = P[(i + 1) % 4];
        const tp = Math.max(6, Math.min(16, 0.28 * Math.hypot(pv.x - a.x, pv.y - a.y))) / Math.max(1, Math.hypot(pv.x - a.x, pv.y - a.y));
        const tn = Math.max(6, Math.min(16, 0.28 * Math.hypot(nx.x - a.x, nx.y - a.y))) / Math.max(1, Math.hypot(nx.x - a.x, nx.y - a.y));
        path += `M${(a.x + (pv.x - a.x) * tp).toFixed(1)} ${(a.y + (pv.y - a.y) * tp).toFixed(1)}L${a.x.toFixed(1)} ${a.y.toFixed(1)}L${(a.x + (nx.x - a.x) * tn).toFixed(1)} ${(a.y + (nx.y - a.y) * tn).toFixed(1)}`;
      }
      const g = G[n], near = d < 8;
      g.children[0].setAttribute('d', path); g.children[1].setAttribute('d', path);
      if (!g.classList.contains('on')) g.classList.add('on'); g.classList.toggle('near', near);
      const lb = labels[n], top = bx[1], cx = (P[0].x + P[1].x + P[2].x + P[3].x) / 4;
      const txt = `${cd.name} ${Math.round(d)}M`;                     // the armed end gate is named too ("HONGIK-RO 8M")
      // the label's box from its text (mono, ~0.64 em a glyph with the tracking): no layout read per frame
      const ly = Math.max(14, top - 4), lw = txt.length * brPx * 0.64 + 6, tg = [cx - lw / 2, ly - brPx * 1.25, cx + lw / 2, ly];
      if (tags.some((b) => ovl(b, tg) > 0.3)) { lb.classList.remove('on'); }
      else {
        tags.push(tg);
        if (lb.textContent !== txt) lb.textContent = txt;
        lb.style.transform = `translate(${cx.toFixed(1)}px,${ly.toFixed(1)}px) translate(-50%,-100%)`;
        if (!lb.classList.contains('on')) lb.classList.add('on'); lb.classList.toggle('near', near);
      }
      n++;
    }
  }
  for (let i = n; i < Math.max(brOn, n); i++) { G[i].classList.remove('on'); labels[i].classList.remove('on'); }
  brOn = n;
}
// a line bracketed on screen in the last 0.3 s (the guide's text steps aside; the hold keeps it from flickering)
const bracketed = (name) => now3() - (brSeenT.get(name) ?? -1e9) < 300;
const now3 = () => performance.now();
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
// [F14] ▼ / ▲ instead of the arrow when the target is under or over you (UX #2: less than 3 m across, at least 1 m up or
// down). C4's nextHint may decide it: hint.vert 'down' | 'up' (also '▼' / '▲' or -1 / 1); null / absent = work it out.
function vertOf(h) {
  const v = h.vert;
  if (v === 'down' || v === '▼' || v === -1) return 'down';
  if (v === 'up' || v === '▲' || v === 1) return 'up';
  if (v === null || v === false || !h.pos) return null;   // C4 said "no", or there's nothing to measure
  const dy = h.pos.y - camPose.pos.y;
  return Math.hypot(h.pos.x - camPose.pos.x, h.pos.z - camPose.pos.z) < 3 && Math.abs(dy) >= 1 ? (dy < 0 ? 'down' : 'up') : null;
}
// [F14] UX #3: a retry leaves you hovering over the chimney mouth, which is out of frame. While the take is ready there,
// until DROP IN has been flown 3 times, the tag (2nd line) and the portrait OLED say how to begin. C4 may serve it:
// take.readyHint (a function (drone, world) or a value: a string, {text}, or null = no hint), or world.takeStart.hint /
// .line / .hintN (the copy, the line that retires it, how many times). Absent: this rule with the default copy.
const READY_HINT = '▼ HOLD LEFT STICK · DROP IN';
const v3 = (c) => (Array.isArray(c) ? { x: c[0], y: c[1], z: c[2] } : c);
function flownN(name) {
  const c = cLines()?.find((l) => l.name === name)?.n || 0, s = +cStore()[name]?.n || 0;
  return Math.max(c, s, uiProg.lines[name]?.n || 0);
}
function readyHint() {
  const t = curTake(), ts = world.takeStart;
  if (!t || S.game === 'free' || t.state !== 'ready' || state !== 'fly' || drone.crashed) return '';
  if ('readyHint' in t) {
    let h = null; try { h = typeof t.readyHint === 'function' ? t.readyHint(drone, world) : t.readyHint; } catch (e) {}
    return typeof h === 'string' ? h : (h && typeof h.text === 'string' ? h.text : '');
  }
  const p = v3(ts?.pos); if (!p || !isFinite(p.x)) return '';
  if (Math.hypot(drone.pos.x - p.x, drone.pos.z - p.z) > 3 || Math.abs(drone.pos.y - p.y) > 3) return '';
  return flownN(ts.line || 'DROP IN') < (+ts.hintN || 3) ? String(ts.hint || READY_HINT) : '';
}

// ---------------- line progress: LINES checklist, best FLOW per line, stars.
// C (take.js) keeps the record (localStorage onetake.lines) and serves it as take.lineList(world)
// [{name, micro, flown, n, bestFlow, ...}] and take.progress(world). The UI also keeps a copy from the take events
// (onetake.ui.progress) so it works on its own; both are read (union), so nothing is lost either way.
// [F2] P3 ux #2: one source for the line list. A level's lines are its lines file (levels.json `lines`, seoul/lines.json:
// names in world order, tuning, start points): the menu fetches it when the level is picked (the build loads the same
// file), the take flies world.lines once loaded (set-piece lines only while their piece exists). The copy is levels.json
// `lineCopy` {NAME: {hint, group}} keyed by those names ({w} in a hint = the line's narrowest gate, m); `lineGroups`
// [[id, LABEL], ...] heads the LINES grid. A line's own `hint` (lines.json) wins over the copy.
const lvData = new Map();               // level id -> digest | 0 (fetching) | null (none / failed)
function digestLines(src, L, pieces = null) {
  const by = new Map(), has = Array.isArray(pieces) ? new Set(pieces.map((p) => p && p.id)) : null;
  for (const l of src?.lines || []) {
    if (!l || !l.name || isMicro(l) || l.carve || (l.piece && has && !has.has(l.piece))) continue;
    let e = by.get(l.name);
    if (!e) by.set(l.name, (e = { name: l.name, piece: l.piece || null, run: !!l.pre?.length, w: Infinity, own: l.hint || '' }));
    for (const g of [l, ...(l.pre || [])]) if (+g.w > 0) e.w = Math.min(e.w, +g.w);
  }
  const copy = L?.lineCopy || {}, legacy = Array.isArray(L?.lineNames) ? L.lineNames : [];
  const names = [...by.values()].map((e) => {
    const c = copy[e.name] || {}, raw = e.own || c.hint || legacy.find((x) => x?.name === e.name)?.hint || '';
    const w = isFinite(e.w) ? (Math.round(e.w * 10) / 10).toFixed(1) : '';
    return { name: e.name, piece: e.piece, group: c.group || (e.piece ? 'pieces' : e.run ? 'streets' : 'gaps'), hint: String(raw).replace(/\{w\}/g, w) };
  });
  const tun = src?.tuning || (src?.lines || []).find((l) => l && l.tuning)?.tuning || null;
  const tip = src?.takeStart?.hint?.text || src?.startPoints?.[0]?.hint?.text || '';
  return { names, tuning: TakeLib.mergeTuning ? TakeLib.mergeTuning(tun) : TT(), firstTip: tip };
}
function levelData(L) {
  if (!L?.lines) return null;
  const d = lvData.get(L.id);
  if (d !== undefined) return d || null;
  lvData.set(L.id, 0);
  fetch(new URL(L.lines, import.meta.url)).then((r) => (r.ok ? r.json() : null)).then((j) => {
    lvData.set(L.id, j && Array.isArray(j.lines) ? digestLines(j, L) : null);
    if (state === 'menu') { baseSrc = null; buildWorlds(); renderProgress(); $('gameHint').textContent = GAME_HINT[S.game]?.() || ''; }
  }).catch((e) => { lvData.set(L.id, null); console.warn('[F2] level lines', L.lines, e?.message || e); });
  return null;
}
let wdK = null, wdP = null, wdV = null;
function worldData() {                  // the loaded level's lines as the take flies them
  if (!loadedId || !world.level || !Array.isArray(world.lines) || !world.lines.length) return null;
  if (wdK !== world.lines || wdP !== world.setPieces) {
    wdK = world.lines; wdP = world.setPieces;
    wdV = digestLines({ lines: world.lines, tuning: world.tuning, takeStart: world.takeStart, startPoints: world.startPoints }, levelOf(world.level), world.setPieces);
  }
  return wdV;
}
const dataFor = (id) => (world.level === id ? worldData() : null) || levelData(levelOf(id));
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
const loadUiProg = () => { uiProg.lines = {}; try { const p = JSON.parse(localStorage.getItem(lkey('onetake.ui.progress')) || 'null'); if (p && p.lines && typeof p.lines === 'object') uiProg.lines = p.lines; } catch (e) {} };
loadUiProg();
const saveUiProg = () => { try { localStorage.setItem(lkey('onetake.ui.progress'), JSON.stringify(uiProg)); } catch (e) {} };
// [S0] switch every progress store to level `id` (menu selection before a load, and every level load)
function setProgressLevel(id) {
  id = id || 'bando'; if (id === progLevel) return;
  progLevel = id;
  TakeLib.setProgressLevel?.(id);                     // take.js PROG + best + perfects
  take.reloadBest?.(); freeTake.reloadBest?.();
  try { score.best = +localStorage.getItem(lkey('onetake.best')) || 0; } catch (e) { score.best = 0; }
  loadUiProg(); newLines.clear(); baseCache = null; baseSrc = null;
}
// C's list (needs the world's lines), else null
function cLines() {
  const t = curTake(); if (typeof t?.lineList !== 'function' || !Array.isArray(world.lines) || !world.lines.length) return null;
  try { const L = t.lineList(world); return Array.isArray(L) ? L : null; } catch (e) { return null; }
}
// C's store before a world is loaded (first menu): {NAME: {n, flow, pts}}
function cStore() { try { const o = JSON.parse(localStorage.getItem(lkey('onetake.lines')) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } }
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
  const d = dataFor(progLevel);          // [F2] P3: the level's own lines (loaded world, else its fetched lines file)
  if (d) {
    if (baseSrc !== d) { baseSrc = d; baseCache = d.names.map((x) => x.name); try { localStorage.setItem(lkey('onetake.ui.lineList'), JSON.stringify(baseCache)); } catch (e) {} }
    return baseCache;
  }
  if (Array.isArray(world.lines) && world.lines.length) {
    if (baseSrc !== world.lines) {
      baseSrc = world.lines; const m = new Set();
      for (const l of world.lines) if (l && l.name && !isMicro(l)) m.add(l.name);
      baseCache = [...m];
      try { localStorage.setItem(lkey('onetake.ui.lineList'), JSON.stringify(baseCache)); } catch (e) {}
    }
    return baseCache;
  }
  if (!baseCache) {
    let names = null; try { names = JSON.parse(localStorage.getItem(lkey('onetake.ui.lineList')) || 'null'); } catch (e) {}
    // [F2] ux #3: a level's lineNames (levels.json) before its first load; bando's built-in list only for bando
    const own = (levelOf(progLevel)?.lineNames || []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
    baseCache = Array.isArray(names) && names.length ? names : own.length ? own : progLevel === 'bando' ? DEFAULT_LINES : [];
  }
  return baseCache;
}
// [{name, hint, flown, f (best FLOW)}]
function lineList() {
  const C = cLines(), m = C ? new Map(C.map((l) => [l.name, { n: l.n || (l.flown ? 1 : 0), f: l.bestFlow || 0, t: +l.bestT || 0 }])) : null;
  const S0 = m ? null : !Array.isArray(world.lines) ? cStore() : null, S1 = m ? cStore() : S0;
  return baseLines().map((name) => {
    const c = m ? m.get(name) : S0?.[name] ? { n: +S0[name].n || 0, f: +S0[name].flow || 0, t: +S0[name].bestT || 0 } : null, r = uiProg.lines[name];
    // C12 (D5): PROG[name].bestT, the line's best time (s), via lineList or the stored record
    const bt = c?.t > 0 ? c.t : +S1?.[name]?.bestT > 0 ? +S1[name].bestT : 0;
    return { name, hint: hintFor(name), flown: !!(c?.n || r), f: Math.max(c?.f || 0, r?.f || 0), bt };
  });
}
const flownCount = () => lineList().filter((l) => l.flown).length;
// [S0] a level's lines may carry their own hint; [F2] else its levels.json lineNames hint; bando's LINE_HINT only on bando
const hintFor = (name) => (progLevel === 'bando' && LINE_HINT[name]) || dataFor(progLevel)?.names.find((x) => x.name === name)?.hint ||
  (Array.isArray(world.lines) && world.level === progLevel ? world.lines.find((l) => l?.name === name && l.hint)?.hint : '') ||
  levelOf(progLevel)?.lineNames?.find?.((x) => x?.name === name)?.hint || '';
// the nearest never-flown line's first gate. C: take.nextHint(drone, world) -> {name, caption, pos:[x,y,z], dist, bearing
// (rad from the nose, + right), elev, fresh} or null. The arrow uses pos against the view (so it follows the camera).
function nearestGate(name, at = camPose.pos) {
  let best = null, bd = Infinity;
  for (const l of world.lines || []) {
    if (!l || (name ? l.name !== name : isMicro(l) || uiProg.lines[l.name])) continue;
    const g = l.pre?.[0]?.c || l.c; if (!g) continue;
    const d = Math.hypot(g[0] - at.x, g[1] - at.y, g[2] - at.z);
    if (d < bd) { bd = d; best = { name: l.name, pos: new THREE.Vector3(g[0], g[1], g[2]), dist: d, fresh: true }; }
  }
  return best;
}
// from: null = where you are (the OSD); {pos, yaw} = a stand-in drone there (the crash card asks from the retry start)
const _zero = new THREE.Vector3();
function nextLine(from = null) {
  if (!Array.isArray(world.lines) || !world.lines.length) return null;
  const t = curTake(), at = from ? v3(from.pos) : camPose.pos;
  if (typeof t?.nextHint === 'function') {
    const who = from ? { pos: new THREE.Vector3(at.x, at.y, at.z), prev: new THREE.Vector3(at.x, at.y, at.z), vel: _zero, heading: +from.yaw || 0, crashed: false, lastImpact: 0 } : drone;
    let h = null; try { h = t.nextHint(who, world); } catch (e) {}
    if (!h || !h.name) return from ? nearestGate(null, at) : null;
    // [F2] ux #1: a new profile is pointed at the level's `first` line; once 60 m from the spawn (START AT Exit 9, or just
    // wandering), point at the nearest never-flown line instead (cap_station: WALKING STREET 393M, SCREEN CANYON 10 m away)
    if (!from && !h.inProgress && camPose.pos.distanceTo(world.spawn) > 60 && (world.lines || []).some((l) => l?.first && l.name === h.name)) {
      const g = nearestGate(null, at); if (g && g.name !== h.name && g.dist < (+h.dist || Infinity)) return g;
    }
    const c = h.pos || h.c, fresh = h.fresh !== false, vert = h.vert ?? h.glyph;
    if (c) { const pos = Array.isArray(c) ? new THREE.Vector3(c[0], c[1], c[2]) : new THREE.Vector3(c.x, c.y, c.z); return { name: h.name, pos, dist: Math.hypot(pos.x - at.x, pos.y - at.y, pos.z - at.z), fresh, vert }; }
    const g = nearestGate(h.name, at); if (g) { g.fresh = fresh; g.vert = vert; return g; }
    return { name: h.name, pos: null, dist: +h.dist || 0, bearing: +h.bearing || 0, elev: +h.elev || 0, fresh, vert };
  }
  return nearestGate(null, at);
}
// 3-star targets per take (C's TAKE_TUNING.stars; round 4: 60k / 150k / 260k)
function starTargets(id) { const s = LT(id).stars; return Array.isArray(s) && s.length ? s : [60000, 150000, 260000]; }
const starCount = (total) => starTargets().filter((v) => total >= v).length;
const starsHTML = (n, of) => Array.from({ length: of }, (_, i) => `<svg viewBox="0 0 16 16"${i < n ? ' class="on"' : ''} aria-hidden="true"><path d="${STAR}"/></svg>`).join('');
const fmtBT = (t) => (t >= 60 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}` : `${t.toFixed(t < 10 ? 2 : 1)} S`);   // best line time
const kfmt = (v) => (v >= 1000 ? Math.round(v / 1000) + 'K' : String(v));
// menu: BEST + stars (of the best take) + LINES strip, the LINES checklist, START AT (paused)
function renderProgress() {
  const L = lineList(), fl = L.filter((l) => l.flown).length, best = scoreView().best || 0;
  $('mStrip').innerHTML = `<span>BEST <b>${best ? fmtN(best) : '—'}</b></span><i>·</i><span class="stars">${starsHTML(starCount(best), starTargets().length)}</span><i>·</i><span>LINES <b>${fl}/${L.length}</b></span>`;
  const nx = loadedId ? nextLine() : null;
  $('lnCount').textContent = `${fl}/${L.length}`;
  const cell = (l) => {
    const next = !l.flown && nx?.name === l.name;
    const sub = l.flown ? (l.f >= 1 ? `FLOW ×${l.f}` : 'FLOWN') : l.hint, bt = l.flown && l.bt > 0 ? `<i> · ${fmtBT(l.bt)}</i>` : '';
    return `<div class="ln${l.flown ? ' on' : ''}${next ? ' next' : ''}"><svg viewBox="0 0 14 14" aria-hidden="true"><rect x=".75" y=".75" width="12.5" height="12.5" rx="3"/><path d="M3.6 7.2l2.3 2.3 4.6-4.8"/></svg><b>${esc(l.name)}</b><small>${esc(sub)}${bt}</small></div>`;
  };
  // [F2] P3 ui #2 / ux #3: the level's groups (lineGroups) under 11 px mono heads, each with its own count; a line in no
  // listed group goes last, under no head
  const G = levelOf(progLevel)?.lineGroups, D = dataFor(progLevel);
  if (Array.isArray(G) && G.length && D) {
    const grp = new Map(D.names.map((x) => [x.name, x.group])), ids = new Set(G.map((g) => g[0]));
    const rest = L.filter((l) => !ids.has(grp.get(l.name)));
    $('lnGrid').innerHTML = [...G, ['', '']].map(([id, label]) => {
      const ls = id ? L.filter((l) => grp.get(l.name) === id) : rest;
      return ls.length ? `<section class="lgrp">${label ? `<div class="lg"><span>${esc(label)}</span><i>${ls.filter((l) => l.flown).length}/${ls.length}</i></div>` : ''}<div class="lgg">${ls.map(cell).join('')}</div></section>` : '';
    }).join('');
    $('lnGrid').classList.add('grouped');
  } else { $('lnGrid').innerHTML = L.map(cell).join(''); $('lnGrid').classList.remove('grouped'); }
  fitLines();
  // START AT (C: world.startPoints [{name, pos, yaw}] + respawn(false, name)); hidden until C provides them. C keeps the
  // choice for retries in its module-level `startAt`; the active one is lit. Hold RESET (back to the spawn) clears it.
  const sp = Array.isArray(world.startPoints) && loadedId ? world.startPoints.filter((s) => s && s.name) : [];
  const cur = typeof startAt === 'string' ? startAt.toLowerCase() : '';
  $('startSec').classList.toggle('hidden', !sp.length || !document.body.classList.contains('paused'));
  $('starts').innerHTML = sp.map((s) => `<button data-n="${esc(s.name)}"${s.name.toLowerCase() === cur ? ' class="on"' : ''}>${esc(s.name)}</button>`).join('');
}
// [F2] P3 ui #2 / ux #3: short landscape (< 500 px tall) the LINES grid scrolls inside itself and stops 16 px above the
// FLY / RESUME bar, so no row hides under it (paused it sits right under START AT: it gets the rest of the screen)
const SHORT_LAND = window.matchMedia?.('(orientation:landscape) and (max-height:500px)');
function fitLines() {
  const g = $('lnGrid'); if (!g) return;
  if (!SHORT_LAND?.matches || $('menu').classList.contains('hidden')) { g.style.maxHeight = ''; g.classList.remove('scroll'); return; }
  const bar = document.querySelector('#menu .cta')?.offsetHeight || 62, paused = document.body.classList.contains('paused');
  const top = paused ? g.getBoundingClientRect().top + $('menu').scrollTop : 40;
  g.style.maxHeight = Math.max(96, Math.round(window.innerHeight - top - bar - 16)) + 'px';
  g.classList.toggle('scroll', g.scrollHeight > g.clientHeight + 2);
}
window.addEventListener('resize', () => { if (state === 'menu') setTimeout(fitLines, 60); });
// [F2] P3 ui #6: a level card's second line: "18 LINES · 3★ 150K" (its lines file: the count and the 3-star target), with
// the flown count once there is one
function cardMeta(L) {
  const d = L && dataFor(L.id); if (!d || !d.names.length) return '';
  const s = d.tuning?.stars, top = Array.isArray(s) && s.length ? s[s.length - 1] : 0, fl = L.id === progLevel ? flownCount() : 0;
  return `${fl ? fl + '/' : ''}${d.names.length} LINES${top ? ` · ${s.length}★ ${kfmt(top)}` : ''}`;
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
window.__onetakeUI = { uiProg, lineList, nextLine, renderProgress, goStartAt, projectView, retryFrom, readyHint, vertOf, get hint() { return nextNow; },
  // [F2] test hooks: armed line, brackets on screen, the caption meter, place names, the level UI
  armedLine, placeAt, applyLevelUI, dataFor, fitLines, byText, headsStamp, showSummary, get armed() { return armNow; }, get brackets() { return { n: brOn, cands: brCands.length, labels: [...document.querySelectorAll('#osd .brl.on')].map((e) => e.textContent) }; },
  get capMeter() { return { luma: capM.luma, plate: capM.plate }; },
  // the live frame composited as one 1080x1920 clip frame with a caption (no recording): the burned-in caption + plate
  capTest(text, place = '', lay = 'radio') {
    frame(performance.now()); prepComp(1080, 1920, lay);
    const C = { caps: [{ t: 0, seg: 0, text, flow: 1, place }], seg: [0] };
    drawComp(C, 0.5, 0, [0, 0, 0, 0]);
    return { url: comp.toDataURL('image/jpeg', 0.9), plate: C.caps[0].plate };
  } };

// ---------------- take events (contract #3), summary card, recovery
// main.js dispatch (C): (typeof onTakeEvent === 'function' ? onTakeEvent : (e) => defaultTakeUI(e, pop))(e)
const runStats = { maxSpeed: 0, maxFlow: 1 };
let pendingSum = null, bestAtStart = 0, uiWasCrashed = false, padArmed = false;
const sum = { kind: null, data: null };
function onTakeEvent(e) {
  if (!e || !e.type) return;
  clipEvent(e);                                          // F2: take start / line t0 for clips (caption() stamps at t0)
  const now = performance.now() / 1000;
  // F1: line progress / NEW badges, CLEAN on the caption, SCRAPE warning (C: scrape {impact, flow, lost})
  if (e.type === 'start') newLines.clear();
  if (e.type === 'line' || e.type === 'repeat') { noteLine(e); lineTag = e.clean && !e.free ? ' · <b>CLEAN</b>' : ''; }
  if (e.type === 'scrape' && e.heads) headsStamp(e);                  // [F2] P3: HEADS! at any FLOW
  else if (e.type === 'scrape' && e.lost) warn(`SCRAPE · FLOW ×${e.flow || 1}`, 1.2);
  switch (e.type) {
    case 'start':
      hideSummary(); sum.kind = sum.data = null; pendingSum = null; clipEndT = null;
      bestAtStart = scoreView().best || 0; runStats.maxSpeed = 0; runStats.maxFlow = 1;
      break;
    case 'line': {
      const text = e.caption || e.name || 'NICE!', flow = e.flow || 1, pl = placeAt(drone.pos);   // [F2] ui #6: where it was flown
      showLine(text, `+${fmtN(e.pts)}`, flow, pl);   // ×N lives on the FLOW line only (UI #2)
      caption(text, flow, pl); runStats.maxFlow = Math.max(runStats.maxFlow, flow);
      break;
    }
    case 'repeat': {
      const text = world.lines?.find?.((l) => l.name === e.name)?.caption || e.name || 'AGAIN', pl = placeAt(drone.pos);
      showLine(text, `REPEAT +${fmtN(e.pts)}`, 1, pl); caption(text, 1, pl);
      break;
    }
    case 'bank': pop(`BANKED <em>+${fmtN(e.pts)}</em>`, 'score'); break;
    case 'lost': if (e.pts > 0) warn(`CHAIN LOST -${fmtN(e.pts)}`, 2); break;
    case 'skim': break;                                   // the live FLOW line on the HUD already reflects it
    case 'cut': clipEndT = now + 0.6; showSummary('cut', e); break;
    case 'crash': clipEndT = now + 1.2; pendingSum = e; break;   // card appears 0.8 s after the hit (uiFrame)
  }
}
// [F14] the crash card's "next:" is measured from where RETRY puts you (C4's retryPose() in main.js: {pos, yaw, name});
// without it, from where you are. Free fly flies on from near here.
function retryFrom() {
  if (S.game === 'free') return null;
  try { if (typeof retryPose === 'function') { const r = retryPose(); if (r && r.pos) return r; } } catch (e) {}
  return null;
}
function showSummary(kind, e) {
  const v = scoreView(), st = (e && e.stats) || {};
  const isTake = !!(e && 'total' in e) || v.take;
  const total = e?.total ?? v.total ?? 0;
  const best = Math.max(v.best || 0, total), newBest = total > 0 && total > bestAtStart;
  const maxSp = st.maxSpeed ?? runStats.maxSpeed, time = st.time ?? v.time ?? flightT, mf = st.maxFlow ?? runStats.maxFlow;
  const lines = Array.isArray(st.lines) ? st.lines.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : null;
  sum.kind = kind; sum.data = e || null;
  // C12 (D5): gold PERFECT on a CUT with every line CLEAN and no scrapes (cut.perfect, else take.perfect)
  const tk = curTake(), perfect = kind === 'cut' && !!(e?.perfect ?? st.perfect ?? (tk && 'perfect' in tk ? tk.perfect : false));
  const by = kind === 'crash' ? byText(e?.by) : '';                  // [F2] P3 ui #3: "CRASHED  HIT A BUS"
  const T = $('bTitle'); T.className = kind; T.innerHTML = kind === 'cut' ? 'CUT<em>.</em>' + (perfect ? '<span class="perf">PERFECT</span>' : '') : 'CRASHED' + (by ? `<span class="by">${esc(by)}</span>` : '');
  const lost = kind === 'crash' && e?.lost > 0 ? `Chain lost −${fmtN(e.lost)}` : 'Take ended';   // the CHAIN LOST warning hides under the card
  const cutHow = e?.how === 'land' ? 'Landed · that\'s a take' : 'That\'s a take';   // C: cut.how 'hover' | 'land'
  const pace = kind === 'cut' && typeof e?.pace === 'number' && e.pace > 0 ? ` · PACE ×${(Math.round(e.pace * 100) / 100).toFixed(2)}` : '';   // ui #3: in the subtitle
  // with PACE, the CUT. title already says it's a take: the line stays one line on the 440 px card
  $('bSub').textContent = kind === 'cut' ? `${pace ? (e?.how === 'land' ? 'Landed' : '') + pace : cutHow}`.replace(/^ · /, '') + ' · touch a stick for a new one' : isTake ? `${lost} · touch a stick to retry` : 'Touch a stick to fly on';
  const row = (k, val) => `<span>${k}</span><b>${val}</b>`;
  // ui #3: six even cells. The 6th is CLEAN lines (x/n) when C has it, else SCRAPES; LINES no longer repeats the list below
  const nL = lines ? lines.length : 0;
  const sixth = typeof st.clean === 'number' && nL ? row('CLEAN', `${Math.min(st.clean, nL)}/${nL}`) : typeof st.scrapes === 'number' ? row('SCRAPES', String(st.scrapes)) : lines ? row('LINES', String(nL)) : '';
  $('bStats').innerHTML = row('MAX SPEED', `${Math.round(maxSp * 3.6)} KM/H`) + row('FLY TIME', fmt(time)) +
    row('SCORE', fmtN(total)) + row('BEST', newBest ? `<em>NEW</em> ${fmtN(best)}` : fmtN(best)) +
    row('MAX FLOW', `×${mf || 1}`) + sixth;
  // stars for this take + the next target; this take's lines (NEW = first time ever); the checklist and what to fly next
  const tg = starTargets(), ns = typeof e?.stars === 'number' ? e.stars : starCount(total), nextT = tg.find((s) => total < s);
  $('bStars').innerHTML = isTake ? starsHTML(ns, tg.length) + (nextT ? `<small>NEXT ${kfmt(nextT)}</small>` : '') : '';
  $('bLines').innerHTML = lines && lines.length ? [...new Set(lines)].map((n) => esc(n) + (newLines.has(n) ? ' <em>NEW</em>' : '')).join(' · ') : '';
  const LL = lineList(), nx = nextLine(kind === 'crash' && isTake ? retryFrom() : null), nh = nx ? hintFor(nx.name) : '';
  $('bNext').innerHTML = LL.length ? `LINES <b>${flownCount()}/${LL.length}</b>` + (nx ? ` · next: <b>${esc(nx.name)}</b>${nh ? ` – ${esc(nh)}` : ''}` : '') : '';
  $('cReset').textContent = isTake ? 'RETRY' : 'FLY ON';
  // a CUT is the take you want to keep: CLIP is the hot button there (UX #4), RETRY after a crash
  $('cReset').classList.toggle('hot', kind !== 'cut'); $('cClip').classList.toggle('hot', kind === 'cut');
  $('cChal').classList.toggle('hidden', !(kind === 'cut' && ghostKeeper?.last));   // C12: share this take as a ghost to beat
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
const firstTipped = new Set();   // [F2] once per level per session
// body.coaching (not .coach: that's the loading card's stick-diagram box, whose rule made the page ~50 px too tall)
function coachStart(fresh) {
  coach.on = !coach.done; document.body.classList.toggle('coaching', coach.on);
  const portrait = document.body.classList.contains('portrait');
  if (!rotateTipped && portrait) { rotateTipped = true; setTimeout(() => toast('ROTATE FOR FULL SCREEN', 2.5), 900); }
  // first flight ever, from the spawn: where the first line is (UX #2). The OSD arrow takes over from there.
  // [F2] ux #3: the level's own firstTip (levels.json); bando's built-in one only on bando
  // [F2] P3 ux #6: one first instruction: a level without its own firstTip says its take start's hint (lines.json
  // takeStart.hint.text, the READY tag's words), so the toast and the tag never disagree
  const L = levelOf(world.level), tip = L?.firstTip ?? (world.level === 'bando' ? 'FIRST LINE: FOLLOW THE TRACK INTO THE HALL\'S OPEN BAY · STAY LOW' : worldData()?.firstTip || '');
  if (fresh && !firstTipped.has(world.level) && S.game !== 'free' && !flownCount() && tip) {
    firstTipped.add(world.level);
    setTimeout(() => { if (state === 'fly') toast(String(tip).toUpperCase(), 4.5); }, portrait ? 3600 : 1200);
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

// ---------------- audio glue (sound panel main-glue2.js): rooms, proximity, impacts, scrapes
// Room probe (sound panel main-glue3.js): 11 BVH rays (60 m), 2 per frame -> hall convolver / tube flutter. The hall
// isn't killed by windows (roof^2 * (0.55 + 0.45 * share of walls hit)); the tube needs a shaft (walls close all round:
// chimney, stair shaft) or a low corridor: under 3.4 m floor to ceiling (the 11th ray, straight down) with half the
// horizontal rays within 5 m, so a window gap in the conveyor gallery no longer flips it to the hall's tail.
// Impacts: every change of drone.lastImpact (true m/s, uncapped: taps and crashes no longer sound alike).
// Scrapes: proximity contact (world.lastDist < 5 cm), which holds across the physics substeps.
// Grass strikes (C7): world.grassAt(x, z) = grass height (m) over the ground, if the world has it; depth from a ray down.
const room = { i: 0, up: [0, 0, 0, 0], ud: [60, 60, 60, 60], h: [60, 60, 60, 60, 60, 60], dd: 1, hall: 0, tube: 0, tubeD: 3, roof: 0 };
const _rr = new THREE.Ray(), c01 = (x) => Math.max(0, Math.min(1, x));
const RD = [[0, 1, 0], [0.707, 0.707, 0], [-0.354, 0.707, 0.612], [-0.354, 0.707, -0.612]];
for (let k = 0; k < 6; k++) RD.push([Math.cos(k * Math.PI / 3), 0, Math.sin(k * Math.PI / 3)]);
RD.push([0, -1, 0]);                                                                     // [10] floor: room height
function probeRoom() {
  if (!world.bvh) { room.hall = room.tube = room.roof = 0; return; }
  for (let k = 0; k < 2; k++) {
    const j = room.i++ % 11, d = RD[j];
    _rr.origin.copy(drone.pos); _rr.direction.set(d[0], d[1], d[2]);
    const hit = world.bvh.raycastFirst(_rr, THREE.DoubleSide, 0, 60), dist = hit ? hit.distance : 60;
    if (j === 10) room.dd = dist;
    else if (j < 4) { room.up[j] = hit ? 1 : 0; room.ud[j] = dist; } else room.h[j - 4] = dist;
  }
  const u = room.up, h = room.h, roof = Math.max((2 * u[0] + u[1] + u[2] + u[3]) / 5, 0.9 * (u[1] + u[2] + u[3]) / 3);   // chimney top is open
  const hs = h.slice().sort((a, b) => a - b), hHit = hs.filter((v) => v < 60).length / 6, mean = Math.min(40, hs.reduce((a, b) => a + b, 0) / 6);
  const wmin = Math.min(h[0] + h[3], h[1] + h[4], h[2] + h[5]);                      // narrowest wall-to-wall width (opposite rays)
  const shaft = c01((5 - hs[4]) / 2);                                                  // walls close all round
  const corridor = c01((3.4 - room.ud[0] - room.dd) / 0.6) * c01((5 - hs[2]) / 2);     // < 3.4 m tall, half the walls < 5 m (gallery 2.5 m; hall floors 3.9-4.6 m)
  room.roof = roof;
  room.tube = roof * Math.max(shaft, corridor);
  room.hall = roof * roof * (0.55 + 0.45 * hHit) * c01((mean - 3) / 9) * (1 - room.tube);
  room.tubeD = Math.max(1.2, shaft >= corridor ? (hs[0] + hs[1] + hs[2]) / 3 : wmin / 2);
}
// props in grass: 0 (clear) .. 1 (12 cm deep). Props sit ~4 cm under the body centre.
function grassDepth() {
  const g = world.grassAt; if (typeof g !== 'function' || drone.crashed || !world.bvh) return 0;
  let gh = 0; try { gh = +g.call(world, drone.pos.x, drone.pos.z) || 0; } catch (e) { return 0; }
  if (!(gh > 0.02)) return 0;
  _rr.origin.copy(drone.pos); _rr.direction.set(0, -1, 0);
  const hit = world.bvh.raycastFirst(_rr, THREE.DoubleSide, 0, gh + 0.3);
  return hit ? c01((gh + 0.04 - hit.distance) / 0.12) : 0;
}
let lastLI = 0, hitNow = 0, thudNow = 0, wasCrashed = false;
const ax = { dist: Infinity, hall: 0, tube: 0, tubeD: 3, scrape: 0, grass: 0 };
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
  ax.grass = grassDepth();
}

// ---------------- iOS lifecycle: swipe-back guard
function armBack() { try { if (!history.state?.onetake) history.pushState({ onetake: 1 }, ''); } catch (e) {} }

// ---------------- main loop
let last = performance.now(), acc30 = 0, frameN = 0, menuFrames = 0;
// [E] Fixed-step physics: whole 1/240 s ticks from an accumulator, the sticks quantised once per tick (exactly what the
// input log stores), the render interpolated between the last two ticks by physAlpha. The flight is then a pure
// function of (start state, input log, world): the same on any frame rate, replayable, and portable (native #1.1).
const PHYS = 1 / 240, MAX_TICKS = 30;              // backstop only: dt is clamped to 0.1 s (24 ticks) below
let physAcc = 0, physAlpha = 1;
const tickInp = { thr: 0, pitch: 0, roll: 0, yaw: 0, climb: 0 };
// input log of the current flight segment (a new one at every respawn/teleport), and the previous one
let inputLog = null, lastInputLog = null, logResets = -1;
function logTick(inp) {
  if (!inputLog || drone.resets !== logResets || inputLog.full) {
    if (inputLog && inputLog.ticks > 0) lastInputLog = inputLog;
    inputLog = new InputLog({ seed: drone.seed, world: worldHash(world), craft: drone.key, mode: S.mode, hz: 1 / PHYS, start: drone.snapshot(), meta: { def: world.def?.id ?? null } });
    logResets = drone.resets;
  }
  inputLog.record(inp, S.mode, drone);
}
const MANUAL = new URLSearchParams(location.search).has('manual');
function frame(now) {
  if (!MANUAL) requestAnimationFrame(frame);
  if (clipOpen) { last = now; return; }             // F2: clip modal up (or encoding): the game is paused
  // [H] never a negative dt: a rAF timestamp can be older than `last` when step() (performance.now()) ran in between, and a
  // dt of -21 s made rigCamera's slerp factor 1 - exp(-dt / 0.03) = -Infinity: a NaN camera (black frame) and a NaN
  // listener (seoul-audio AudioParam page errors). Same-clock frames are unchanged.
  let dt = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = Math.max(last, now);
  if (S.fps === '30') { acc30 += dt; if (acc30 < 1 / 30 - 0.006) return; dt = Math.min(0.1, acc30); acc30 = 0; }
  frameN++;
  fpv.frameTiming(dt * 1000);
  const inp = controls.poll(dt);

  if (state === 'fly' || state === 'crash') {
    flightT += state === 'fly' ? dt : 0;
    physAcc += dt;
    let ticks = 0;
    while (physAcc >= PHYS && ticks < MAX_TICKS) {
      quantize(inp, tickInp); logTick(tickInp);
      drone.step(PHYS, tickInp, S.mode, world);
      if (state !== 'loading') updateTake(PHYS, tickInp);
      physAcc -= PHYS; ticks++;
    }
    if (ticks === MAX_TICKS) physAcc = Math.min(physAcc, PHYS);
    physAlpha = physAcc / PHYS;
    if (drone.crashed && state === 'fly') { state = 'crash'; }
    if (world.bounds && !world.bounds.containsPoint(drone.pos)) {
      for (const e of take.fail()) takeEvent(e);      // leaving the world ends a take like a crash
      $('fade').style.opacity = 1; setTimeout(respawn, 380); state = 'loading';
    }
    updateProx();
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
  if (state === 'replay') { endReplay(true); toast('CLIP CANCELLED', 1.8, true); }   // rAF stops in the background: the recording would be junk
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
  if (state === 'replay') { endReplay(true); toast('CLIP CANCELLED', 1.8, true); }
  if (clipOpen || !$('clip').classList.contains('hidden')) closeClip();
  if (state === 'fly' || state === 'crash') openMenu();
});
window.__onetake = {
  S, drone, fpv, world, controls, renderer, take, freeTake, get spark() { return spark; }, startFlight, respawn, applySettings, get state() { return state; },
  ui: { onTakeEvent, pop, warn, toast, showSummary, hideSummary, saveClip, openClip, clipCfg, clipPrefs, get clipPhase() { return $('clip').dataset.phase; }, get hqJob() { return hqJob; }, endReplay, openMenu, bindTake, scoreView, smoothReplay, splitAccent, get replay() { return replay; }, room, audio,
    replayBuf, get frames() { return cur.frames; }, get prevBuf() { return prevBuf; }, get curBuf() { return cur; }, clipSource, clipPlan, buildClip, clipJitter, closeClip, get clipOpen() { return clipOpen; }, get lastClip() { return lastClip; } },
  tp(x, y, z, yawDeg = 0, pitchDeg = 0) { drone.reset(drone.pos.clone().set(x, y, z), yawDeg * DEG); if (pitchDeg) drone.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchDeg * DEG)); camQ.copy(drone.q); fpv.resetExposure = true; state = 'fly'; },
  // test hook (?manual): advance n frames of dtMs each and return the canvas
  step(dtMs = 16.7, n = 1, grab = true) { for (let i = 0; i < n; i++) { last = performance.now() - dtMs; frame(performance.now()); } return grab ? canvas.toDataURL('image/jpeg', 0.92) : null; },
};
// [S0] levels: the manifest, the loaded level, progress level, switch by id (menu select + FLY), memory readout
window.__onetake.levels = {
  get list() { return LEVELS; }, get loaded() { return world.level || null; }, get progress() { return progLevel; }, get look() { return curLook; },
  select(id) { const L = levelByName(id); if (!L) return false; S.world = L.id === 'bando' ? 'yard' : L.id; buildWorlds(); return true; },
  mem() { const pm = performance.memory; return { renderer: { ...renderer.info.memory, programs: renderer.info.programs?.length ?? null }, heapMB: pm ? Math.round(pm.usedJSHeapSize / 1048576) : null, lastDispose }; },
};
window.__onetake.flight = { PHYS, get log() { return inputLog; }, get lastLog() { return lastInputLog; }, get alpha() { return physAlpha; } };   // [E] input logs
if (MANUAL) { setInterval(() => { if (state === 'loading') { last = performance.now() - 16; } }, 500); }
else if (params.has('perf')) import('./perf.js').then((m) => m.perfProbe(window.__onetake, +params.get('perf') || 120));   // [G4] ?perf drives its own frames
else requestAnimationFrame(frame);
