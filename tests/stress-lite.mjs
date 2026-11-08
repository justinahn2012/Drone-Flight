// tests/stress-lite.mjs: collision stress test for CI (~3 s). node tests/stress-lite.mjs [--flights N]
// Random seeded pilots (OU thumbs) fly Cine, Acro and Angle from random clear points around the site at 240 Hz.
// Every tick, the swept segment from the previous to the new position is raycast against the collider. Any hit is a
// pass-through, and the test fails on even one. It also fails on NaN state.
// It is a lighter, deterministic copy of the integration stress run (/home/claude/scripts/stress.mjs: 280 flights).
import * as THREE from 'three';
import { buildGeometry } from '../world-bando.js';
import { Drone } from '../flight.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? +process.argv[i + 1] : d; };
const N = arg('--flights', 40);
const { bvh, funnels } = buildGeometry();
const world = { bvh, lastDist: Infinity, envelope: { min: new THREE.Vector3(-440, -2, -440), max: new THREE.Vector3(440, 220, 440) }, ...(funnels ? { funnels } : {}) };
let seed = 4242; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const ray = new THREE.Ray(), cp = {}, DOWN = new THREE.Vector3(0, -1, 0), seg = new THREE.Vector3(), prev = new THREE.Vector3();
const cl = (v) => Math.max(-1, Math.min(1, v));
const stats = {}, examples = [];
let fail = 0;

function flight(mode, secs, st) {
  const d = new Drone('freestyle5'); let crashed = false; d.onCrash = () => { crashed = true; st.crashes++; };
  let p;
  for (let t = 0; t < 50; t++) {
    p = new THREE.Vector3(-70 + rnd() * 150, 0.6 + rnd() * 34, -48 + rnd() * 90);
    if (!bvh.closestPointToPoint(p, cp, 0, 0.6) && bvh.raycastFirst(new THREE.Ray(p.clone(), DOWN), THREE.DoubleSide)) break;
  }
  d.reset(p, rnd() * Math.PI * 2);
  const ou = { p: 0, r: 0, y: 0, c: 0 };
  for (let i = 0; i < secs * 240; i++) {
    for (const k in ou) ou[k] += -ou[k] * 0.8 / 240 + 1.87 * Math.sqrt(1 / 240) * (rnd() * 2 - 1);
    const inp = mode === 'cine' ? { thr: 0.4, pitch: cl(0.55 + ou.p * 0.7), roll: cl(ou.r), yaw: cl(ou.y * 0.6), climb: cl(ou.c) }
      : mode === 'angle' ? { thr: cl(0.45 + ou.c * 0.25), pitch: cl(0.35 + ou.p * 0.6), roll: cl(ou.r * 0.7), yaw: cl(ou.y * 0.5), climb: 0 }
      : { thr: cl(0.42 + ou.c * 0.3), pitch: cl(ou.p * 0.6), roll: cl(ou.r * 0.6), yaw: cl(ou.y * 0.5), climb: 0 };
    prev.copy(d.pos);
    d.step(1 / 240, inp, crashed ? 'acro' : mode, world);
    st.steps++;
    if (!Number.isFinite(d.pos.x + d.pos.y + d.pos.z + d.vel.x + d.vel.y + d.vel.z)) { st.nan++; break; }
    seg.subVectors(d.pos, prev); const L = seg.length();
    if (L > 1e-5) {
      ray.set(prev, seg.divideScalar(L));
      const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, L);
      if (h) { st.passThrough++; if (examples.length < 6) examples.push({ mode, at: d.pos.toArray().map((v) => +v.toFixed(2)), L: +L.toFixed(3), hit: +h.distance.toFixed(3) }); }
    }
    if (bvh.closestPointToPoint(d.pos, cp, 0, d.c.radius + 0.05)) st.contactSteps++;
    if (crashed && d.crashT > 1.2) break;
  }
  st.flights++;
}

const t0 = performance.now();
for (const [mode, n, secs] of [['cine', N, 12], ['acro', Math.round(N * 0.75), 8], ['angle', Math.round(N * 0.5), 10]]) {
  const st = stats[mode] = { flights: 0, steps: 0, passThrough: 0, nan: 0, crashes: 0, contactSteps: 0 };
  for (let f = 0; f < n; f++) flight(mode, secs, st);
  const bad = st.passThrough || st.nan;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${mode.padEnd(5)} ${JSON.stringify(st)}`);
  if (bad) fail++;
}
if (examples.length) console.log('pass-throughs:', JSON.stringify(examples));
console.log(`${fail ? `${fail} FAILED` : 'all passed'} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
