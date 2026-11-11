// tests/life-worker.mjs: the LifeSim worker shell (P3 stream H, native #5 / perf #3), in node through worker_threads.
//   node tests/life-worker.mjs
// 1. the worker's traffic hash at the parity times equals tests/seoul/parity.json and a main-thread LifeSim;
// 2. a 60-frame camera path: every frame's crowd arrays (X, Z, YAW, PH, WALK, POSE, VIS) and vehicle poses equal the
//    main thread's crowd.evaluate / traffic.pose bit for bit;
// 3. buffers are transferred, not copied, and recycled: no allocation per frame after the first two;
// 4. a pure query (boxesAt) answers the same in the worker;
// 5. cost: what the main thread spends per frame with the worker (post + receive) against the inline evaluate.
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { LifeWorker, VEH_STRIDE } from '../seoul-life-client.js';
import { LifeSim } from '../seoul-life.js';

const root = new URL('../', import.meta.url);
const layout = JSON.parse(readFileSync(new URL('seoul/layout.json', root), 'utf8'));
const parity = JSON.parse(readFileSync(new URL('tests/seoul/parity.json', root), 'utf8'));
let pass = 0, fail = 0;
const ok = (c, msg) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${msg}`); c ? pass++ : fail++; return c; };
const opts = { seed: parity.seed ?? 11 };

const lw = await LifeWorker.create(layout, { ...opts, throwOnError: true }, { WorkerImpl: Worker });
ok(!!lw, `worker started: ${lw?.info?.agents} people, ${lw?.info?.vehicles} vehicles in ${lw?.info?.ms?.toFixed(0)} ms`);
if (!lw) process.exit(1);
const main = new LifeSim(layout, opts);

// 1. traffic parity
const vec = (parity.vectors || []).filter((v) => v.hash != null && Number.isFinite(v.t));
const bad = [];
for (const v of vec) { const h = await lw.hash(v.t); main.advanceTo(v.t); if (h !== v.hash || h !== main.hash()) bad.push(`t ${v.t}: worker ${h} main ${main.hash()} parity ${v.hash}`); }
ok(vec.length >= 3 && !bad.length, `traffic hash in the worker = parity.json = main thread at t = ${vec.map((v) => v.t).join(', ')}` + (bad.length ? `: ${bad.join('; ')}` : ''));

// 2. a frame sequence along a camera path (walking street, rising), main thread in lockstep
const main2 = new LifeSim(layout, opts), C = main2.crowd, T = main2.traffic;
const cam = (k) => ({ x: -36 + k * 0.4, y: 3 + k * 0.05, z: -23 - k * 0.6 });
const eq = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
let mism = [], frames = 0, transferred = true; const inlineMs = [], postMs = [], rttMs = [], workerMs = [];
const med = (A) => A.slice().sort((x, y) => x - y)[A.length >> 1];
const N = 60, t0 = 12.5;
for (let k = 0; k < N; k++) {
  const t = t0 + k / 60, c = cam(k);
  const a = performance.now();
  lw.request(t, c);
  postMs.push(performance.now() - a);
  const f = await new Promise((r) => { const poll = () => { const x = lw.latest(); if (x) r(x); else setImmediate(poll); }; poll(); });
  const b = performance.now();
  // inline, as seoul-life.js build() does it
  const i0 = performance.now(); main2.advanceTo(t); C.events.length = 0; C.evaluate(t, c); const i1 = performance.now();
  inlineMs.push(i1 - i0); workerMs.push(f.ms.sim + f.ms.crowd + f.ms.pack); rttMs.push(b - a);
  for (const key of ['X', 'Z', 'YAW', 'PH', 'WALK', 'POSE', 'VIS']) if (!eq(f[key], C[key])) mism.push(`frame ${k} ${key}`);
  const P = {}, V = f.veh;
  T.vehicles.forEach((v, i) => { const p = T.pose(v, main2.aT, P), o = i * VEH_STRIDE; if (!p.hidden && (V[o] !== Math.fround(p.x) || V[o + 1] !== Math.fround(p.z) || V[o + 2] !== Math.fround(p.hx) || V[o + 3] !== Math.fround(p.hz))) mism.push(`frame ${k} vehicle ${v.id}`); });
  if (f.seq == null || f.t !== t) mism.push(`frame ${k}: seq/t`);
  frames++;
  const held = f._buf;
  lw.release(f);
  if (k === N - 1) {   // the next request transfers the released buffers away: they must detach here
    lw.request(t + 1 / 60, c); transferred = held.X.byteLength === 0 && held.veh.byteLength === 0;
    await new Promise((r) => { const poll = () => (lw.latest() ? r() : setImmediate(poll)); poll(); });
  }
}
ok(!mism.length, `${frames} frames along a camera path: crowd arrays and vehicle poses equal the main thread's bit for bit` + (mism.length ? `: ${mism.slice(0, 6).join(', ')}${mism.length > 6 ? ` (+${mism.length - 6})` : ''}` : ''));
ok(transferred, 'buffers are transferred (detached on the sending side), not copied');
ok(lw.stats.allocs <= 2, `buffers recycled: ${lw.stats.allocs} allocations in ${lw.stats.frames} frames (<= 2)`);

// 3. a pure query in the worker
const bw = await lw.call('boxesAt', 37.5), bm = new LifeSim(layout, opts).boxesAt(37.5);
ok(bw.length === bm.length && bw.every((x, i) => x.id === bm[i].id && x.c.every((v, j) => v === bm[i].c[j])), `boxesAt(37.5) in the worker = main thread (${bw.length} vehicles)`);

// 4. errors come back, they don't kill the worker
const err = await lw.call('dispose').then(() => null, (e) => e.message);
ok(/not a pure LifeSim query/.test(err || ''), 'an unknown call is refused with an error message');

// 5. cost
console.log(`cost per frame (node, median of ${frames}): inline advanceTo + evaluate ${med(inlineMs).toFixed(2)} ms on the main thread; ` +
  `with the worker: request() ${med(postMs).toFixed(3)} ms on the main thread (buffers move, nothing is copied), ` +
  `${med(workerMs).toFixed(2)} ms in the worker, round trip ${med(rttMs).toFixed(2)} ms (draw the frame requested one frame earlier)`);
lw.dispose();

// 6. [P4 H, perf #1 / native #3] wired: seoul-life.js build() with ctx.lifeWorker draws the worker's frames. Two builds
// fly the same 90-frame path (worker vs inline); the worker build must attach, draw from the worker on every frame after
// the first, draw the same people (tier counts within 2 %, the same instance positions within a frame's walk), and spend
// less of the main thread in update()
{
  const THREE = await import('three');
  const lifeMod = await import('../seoul-life.js');
  const lw2 = await LifeWorker.create(layout, { seed: 7, density: 1, maxAgents: lifeMod.LIFE.maxAgents, throwOnError: true }, { WorkerImpl: Worker });
  const mk = (w) => lifeMod.build(layout, { audio: false, people: false, scene: new THREE.Scene(), lifeWorker: w });
  const A = mk(lw2), B = mk(false), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
  ok(A.lifeWorker.state === 'on' && B.lifeWorker.state === 'off', `build() attaches a LifeWorker given in ctx.lifeWorker (state ${A.lifeWorker.state}; inline build ${B.lifeWorker.state})`);
  const NF = 90, tA = [], tB = [], dCount = [], dPos = [];
  const waitFrame = () => new Promise((r) => { const poll = () => (lw2.ready || lw2.error ? r() : setImmediate(poll)); poll(); });
  const tier = (L) => L.group.children.find((m) => /^crowd-near/.test(m.name) && m.geometry?.attributes?.iPos);
  for (let k = 0; k < NF; k++) {
    const t = 20 + k / 60, cam = new THREE.Vector3(-36 + k * 0.05, 2.5, -23 - k * 0.08);
    let a = performance.now(); A.update(t, cam, q); tA.push(performance.now() - a);
    a = performance.now(); B.update(t, cam, q); tB.push(performance.now() - a);
    if (k > 0) {
      const sa = A.stats, sb = B.stats; dCount.push(Math.abs(sa.drawn - sb.drawn) / Math.max(1, sb.drawn));
      const ga = tier(A)?.geometry, gb = tier(B)?.geometry;
      if (ga && gb && ga.instanceCount === gb.instanceCount && ga.instanceCount) { const pa = ga.attributes.iPos.array, pb = gb.attributes.iPos.array; let m = 0; for (let i = 0; i < ga.instanceCount; i++) m = Math.max(m, Math.hypot(pa[i * 4] - pb[i * 4], pa[i * 4 + 2] - pb[i * 4 + 2])); dPos.push(m); }
    }
    await waitFrame();
  }
  const LWs = A.lifeWorker;
  ok(LWs.used >= NF - 2 && !lw2.error, `the wired build drew ${LWs.used} of ${NF} frames from the worker (inline ${LWs.inline}: until the first frame lands)`);
  ok(Math.max(...dCount) <= 0.02, `same people drawn as inline: tier totals within ${(Math.max(...dCount) * 100).toFixed(2)} % (<= 2 %)`);
  ok(dPos.length > NF / 2 && med(dPos) <= 0.05, `near-tier instances where inline puts them: median of the per-frame worst ${med(dPos)?.toFixed(4)} m over ${dPos.length} frames (one frame's walk is ~0.025 m)`);
  const ma = med(tA.slice(5)), mb = med(tB.slice(5));
  ok(ma < mb, `main thread: update() ${ma.toFixed(2)} ms with the worker vs ${mb.toFixed(2)} ms inline (median, node)`);
  A.dispose(); B.dispose(); lw2.dispose();
}
console.log(`life-worker tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
