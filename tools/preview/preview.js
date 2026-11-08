// S3 preview harness: a provisional night block (S1's synthetic L1 layout -> boxes) with fake L3 emitters, lit by seoul-light.js
// and shot through fpvcam.js's night camera. Not shipped; for tuning and A/B stills (tools/preview/shots.py drives it).
//   seoul-light-preview.html?shot=walk&retro=0.3[&day] [&auto]
import * as THREE from 'three';
import { FPVCamera, LENSES } from '../../fpvcam.js';
import { attach, emitterRadiance } from '../../seoul-light.js';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);

async function loadLayout() {
  for (const u of ['../../seoul/layout.json', '../../seoul/layout.provisional.json', './layout.provisional.json']) {
    try { const r = await fetch(u); if (r.ok) { const j = await r.json(); j._src = u; return j; } } catch (e) {}
  }
  throw new Error('no layout');
}

// seeded rng
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WHITE = [1, 0.97, 0.92], WARM = [1, 0.82, 0.58], RED = [1, 0.06, 0.04], BLUE = [0.08, 0.28, 1], YEL = [1, 0.72, 0.08], ORA = [1, 0.42, 0.08];
const PINK = [1, 0.12, 0.45], MAG = [1, 0.08, 0.85], CYAN = [0.08, 0.85, 1], VIO = [0.45, 0.15, 1];
const CENSUS = [WHITE, WHITE, WHITE, WARM, WARM, RED, RED, ORA, YEL, BLUE];   // ~78 % warm/white (G5 census)
const NEON = [PINK, MAG, CYAN, VIO];

function buildFake(layout, seed = 5) {
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length) % a.length];
  const em = [], street = Object.fromEntries(layout.streets.map((s) => [s.id, s]));
  let id = 0;
  const E = (o) => em.push({ id: 'f' + (id++), animated: false, ...o });
  for (const lot of layout.lots) {
    const st = street[lot.street], hero = st && (st.kind === 'walking' || st.kind === 'club');
    const colour = () => (R() < (hero ? 0.35 : 0.1) ? pick(NEON) : pick(CENSUS));
    const [a, b] = lot.frontage;
    const cx = lot.footprint.reduce((s, p) => s + p[0], 0) / lot.footprint.length, cz = lot.footprint.reduce((s, p) => s + p[1], 0) / lot.footprint.length;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, fl = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let nx = mx - cx, nz = mz - cz; const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    const tx = (b[0] - a[0]) / fl, tz = (b[1] - a[1]) / fl;
    const H = lot.floors * lot.floorH;
    // shopfront glow
    E({ kind: 'store', pos: [mx + nx * 0.05, 1.4, mz + nz * 0.05], normal: [nx, 0, nz], w: fl * 0.55, h: 1.9, rgb: lot.use === 'conv' ? [0.85, 0.95, 1] : (R() < 0.5 ? WARM : WHITE), nits: 50 + R() * 90 });
    // channel letters / light boxes per upper floor
    for (let f = 1; f < lot.floors; f++) {
      if (R() < 0.35) continue;
      const w = 2 + R() * Math.min(5, fl * 0.6), u = (R() - 0.5) * (fl - w) * 0.8, y = f * lot.floorH + lot.floorH * 0.5;
      const kind = R() < 0.5 ? 'channel' : 'lightbox';
      E({ kind, pos: [mx + tx * u + nx * 0.08, y, mz + tz * u + nz * 0.08], normal: [nx, 0, nz], w, h: 0.8 + R() * 0.6, rgb: colour(), nits: kind === 'channel' ? 500 + R() * 900 : 200 + R() * 350 });
    }
    // vertical blade signs (two faces along the street)
    const nb = 1 + Math.floor(R() * 2.5);
    for (let k = 0; k < nb; k++) {
      const u = (R() - 0.5) * fl * 0.8, h = Math.min(H - 4, 3 + R() * 6), y = 3.5 + h / 2 + R() * Math.max(0, H - h - 5);
      const p = [mx + tx * u + nx * 1.0, y, mz + tz * u + nz * 1.0], c = colour(), nits = 250 + R() * 500;
      E({ kind: 'lightbox', pos: [p[0] + tx * 0.15, p[1], p[2] + tz * 0.15], normal: [tx, 0, tz], w: 0.9, h, rgb: c, nits });
      E({ kind: 'lightbox', pos: [p[0] - tx * 0.15, p[1], p[2] - tz * 0.15], normal: [-tx, 0, -tz], w: 0.9, h, rgb: c, nits });
    }
    // lit windows above
    for (let f = 2; f < lot.floors; f++) if (R() < 0.3) E({ kind: 'store', pos: [mx + nx * 0.05 + tx * (R() - 0.5) * fl * 0.6, f * lot.floorH + 1.4, mz + nz * 0.05 + tz * (R() - 0.5) * fl * 0.6], normal: [nx, 0, nz], w: 1.6, h: 1.2, rgb: R() < 0.6 ? [0.9, 0.97, 1] : WARM, nits: 30 + R() * 50 });
    // club neon by the door
    if (lot.use === 'club' || (hero && R() < 0.3)) E({ kind: 'neon', pos: [mx + nx * 0.1, 3.1, mz + nz * 0.1], normal: [nx, 0, nz], w: 2.5, h: 0.12, rgb: pick(NEON), nits: 1200, flicker: R() < 0.2 ? { hz: 7 + R() * 5, depth: 0.25 } : undefined });
  }
  // street lights (LED on main/walking, sodium in alleys), every ~24 m, both sides
  for (const s of layout.streets) {
    for (let i = 0; i + 1 < s.points.length; i++) {
      const [ax, az] = s.points[i], [bx, bz] = s.points[i + 1], L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L;
      const step = s.kind === 'main' ? 24 : 18;
      for (let d = step / 2, side = 1; d < L; d += step, side = -side) {
        const off = (s.width / 2 - (s.kind === 'main' ? 3 : 1.2)) * side;
        const sod = s.kind === 'alley' || s.kind === 'club';
        E({ kind: 'street', pos: [ax + tx * d - tz * off, s.kind === 'main' ? 9 : 6, az + tz * d + tx * off], normal: [0, -1, 0], w: 0.5, h: 0.25, rgb: sod ? [1, 0.55, 0.18] : [1, 0.84, 0.66], nits: s.kind === 'main' ? 30000 : 15000 });
      }
    }
  }
  // tent bars in alley A
  const al = street.alleyA;
  if (al) for (let k = 0; k < 4; k++) { const z = al.points[0][1] - 12 - k * 9; E({ kind: 'tent', pos: [al.points[0][0] + (k % 2 ? 1.2 : -1.2), 1.4, z], normal: [k % 2 ? -1 : 1, 0, 0], w: 3, h: 2.2, rgb: [1, 0.5, 0.22], nits: 60 }); }
  // screens (animated)
  for (const sc of layout.screens || []) E({ id: sc.id, kind: 'screen', pos: sc.pos, normal: sc.normal, w: sc.w, h: sc.h, rgb: [0.6, 0.8, 1], nits: 700, animated: true });
  return em;
}

function buildWorld(layout, emitters) {
  const scene = new THREE.Scene(), colliderScene = new THREE.Scene();
  const R = rng(9);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: new THREE.Color(0.07, 0.07, 0.075), roughness: 0.75, metalness: 0 }));
  ground.material.userData.wet = 1;
  scene.add(ground);
  colliderScene.add(new THREE.Mesh(ground.geometry));
  // pavements (lighter concrete) under the lots' frontage band are skipped: the provisional block is street + boxes
  for (const lot of layout.lots) {
    const xs = lot.footprint.map((p) => p[0]), zs = lot.footprint.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs), H = lot.floors * lot.floorH;
    const g = new THREE.BoxGeometry(x1 - x0, H, z1 - z0).translate((x0 + x1) / 2, H / 2, (z0 + z1) / 2);
    const a = 0.10 + R() * 0.18, t = R();
    const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(a * (1 + 0.05 * t), a, a * (1 - 0.06 * t)), roughness: 0.88 });
    scene.add(new THREE.Mesh(g, m)); colliderScene.add(new THREE.Mesh(g));
  }
  // emitter faces
  const faces = [];
  for (const e of emitters) {
    const r = emitterRadiance(e);
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(r[0], r[1], r[2]), side: THREE.FrontSide });
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(e.w, e.h), m);
    const n = new THREE.Vector3(...e.normal).normalize();
    pl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    pl.position.set(...e.pos).addScaledVector(n, 0.03);
    scene.add(pl); faces.push({ e, m });
  }
  scene.updateMatrixWorld(true); colliderScene.updateMatrixWorld(true);
  return { scene, colliderScene, faces, hdr: true };
}

const SHOTS = {
  walk:  { pos: [-60, 2.6, 1.0], yaw: -90, pitch: -4 },
  main:  { pos: [-50, 11, 66], yaw: -80, pitch: -12 },
  alley: { pos: [-30, 1.8, 0], yaw: 180, pitch: -2 },
  high:  { pos: [-20, 28, -40], yaw: -150, pitch: -28 },
};

const layout = await loadLayout();
const emitters = buildFake(layout);
const world = buildWorld(layout, emitters);
const light = attach(world, emitters, { renderer, layout, quality: q.get('q') || 'high' });
const fpv = new FPVCamera(renderer);
fpv.setHDR(true);
fpv.look.lens = LENSES[q.get('lens') || 'ref'];
const night = !q.has('day');
if (night) fpv.setLook('night');
else Object.assign(fpv.look, { evMin: -5.5, evMax: 4.4, invTone: 0, lift: 0, saturation: 1.1, expo: 0.85 });
fpv.cam.near = 0.06; fpv.cam.far = 3000; fpv.cam.updateProjectionMatrix();
function size() { const w = canvas.clientWidth | 0, h = canvas.clientHeight | 0; renderer.setSize(w, h, false); fpv.resize(w, h); fpv.setQualityRange(1, 1); fpv.scale = 1; }
size(); addEventListener('resize', size);

let shot = SHOTS[q.get('shot')] ? q.get('shot') : 'walk', T = 0;
const pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() }, zero = new THREE.Vector3();
const motion = { vel: new THREE.Vector3(), ang: new THREE.Vector3(), vib: 0.3, hz: 170 };
function setPose(name, dyaw = 0) {
  const s = SHOTS[name]; pose.pos.set(...s.pos);
  pose.quat.setFromEuler(new THREE.Euler(s.pitch * Math.PI / 180, (s.yaw + dyaw) * Math.PI / 180, 0, 'YXZ'));
}
const hsv = (h) => { const f = (n) => { const k = (n + h * 6) % 6; return 1 - Math.max(0, Math.min(k, 4 - k, 1)); }; return [f(5), f(3), f(1)]; };
function animate(t) {
  for (const f of world.faces) if (f.e.kind === 'screen') {
    const c = hsv((t * 0.05 + f.e.pos[0] * 0.01) % 1).map((v) => 0.25 + 0.75 * v); f.e.rgb = c;
    const r = emitterRadiance(f.e); f.m.color.setRGB(r[0], r[1], r[2]);
  }
  light.update(t);
}
function frame(dt, yawRate = 0) {
  T += dt; animate(T);
  motion.ang.set(0, yawRate * Math.PI / 180, 0); motion.vel.set(0, 0, 0);
  fpv.render(world, pose, motion, dt);
}
// automation: render n frames of a shot at a retro level; returns EV
window.__h = {
  stats: light.stats, layoutSrc: layout._src, emitters: emitters.length,
  shot(name, retro = 0.3, n = 12, yawRate = 0) {
    shot = name; setPose(name); fpv.look.retro = retro; fpv.resetExposure = true;
    for (let i = 0; i < n; i++) frame(1 / 60, i === n - 1 ? yawRate : 0);
    return fpv.readEv(renderer);
  },
  // AE step response: hold shot a (dark), cut to shot b, sample EV per frame
  aeStep(a, b, nA = 30, nB = 90) {
    setPose(a); fpv.resetExposure = true; for (let i = 0; i < nA; i++) frame(1 / 60);
    const ev = []; setPose(b); for (let i = 0; i < nB; i++) { frame(1 / 60); ev.push(+fpv.readEv(renderer).toFixed(3)); } return ev;
  },
  timing(name, n = 20) { setPose(name); const t0 = performance.now(); for (let i = 0; i < n; i++) frame(1 / 60); renderer.getContext().finish(); return (performance.now() - t0) / n; },
};
document.getElementById('info').textContent = `${layout._src} · ${emitters.length} emitters · grid ${light.stats.grid} · mean ${light.stats.mean?.toFixed(1)}/cell`;
const sel = document.getElementById('shot'); for (const k in SHOTS) sel.add(new Option(k, k)); sel.value = shot;
sel.onchange = () => { shot = sel.value; fpv.resetExposure = true; };
const rr = document.getElementById('retro'); rr.value = fpv.look.retro ?? 0; document.getElementById('rv').textContent = rr.value;
rr.oninput = () => { fpv.look.retro = +rr.value; document.getElementById('rv').textContent = rr.value; };
document.getElementById('night').onchange = (ev) => { fpv.setLook(ev.target.checked ? 'night' : 'hdr'); };
if (!q.has('auto')) {
  let last = performance.now();
  const loop = (now) => { const dt = Math.min(0.1, (now - last) / 1000); last = now; setPose(shot, Math.sin(T * 0.3) * 20); frame(dt, Math.cos(T * 0.3) * 6); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
} else window.__ready = true;
