// seoul-life-worker.js: Neon Seoul's LifeSim off the main thread (P3 stream H, native #5 / perf #3). The worker shell
// and its messages only: the simulation is G1's seoul-life.js, unchanged and pure (a function of the take clock), so
// this worker's crowd and traffic equal the main thread's bit for bit (tests/life-worker.mjs). The main thread keeps its
// own LifeSim for the colliders (flight.js asks movers.hit on the 240 Hz tick: take parity never waits on a worker);
// the worker does the per-frame drawing work: traffic advanceTo(t) and crowd.evaluate(t, cam) for ~9,500 people.
// Client: seoul-life-client.js (LifeWorker). Browser: a module worker; node: worker_threads (the tests).
//
// Messages (main -> worker):
//   {type: 'init', layout, opts: {seed, density, maxAgents, sites, warmTo?}, lifeURL?, threeURL?}
//        -> {type: 'ready', seq, agents, vehicles, types, hash (as built, t = 0), ms, warmMs, first}   [P5] warmTo: advance first
//        [P8] opts.cam ([x, y, z, fx?, fz?]) and opts.fr: `first` is the frame at warmTo from cam (as a 'frame' reply's fields)
//   {type: 'frame', ...} while a fast-forward runs: it retargets that one (only the newest request is answered; the frame
//        carries `dropped`, `slices`, `retargets`)
//   {type: 'frame', seq, t, cam: [x, y, z] | null, recycle?: buffers}   (recycle = a previous frame's buffers, given back)
//        -> {type: 'frame', seq, t, aT, buf: {X, Z, YAW, PH, WALK (Float32), POSE, VIS (Uint8), veh (Float32, VEH_STRIDE per
//            vehicle in traffic.vehicles order: x, z, hx, hz, hidden, brake, hazard, type index)}, events, ms: {sim, crowd,
//            pack}, allocs}   every buffer transferred, none copied
//   {type: 'hash', seq, t}  -> {type: 'hash', seq, t, hash, n}   (LifeSim.hash() after advanceTo(t): parity checks)
//   {type: 'call', seq, fn, args}  -> {type: 'call', seq, value}  (a pure LifeSim query, e.g. boxesAt / hit / hitPeople)
//   {type: 'dispose'}
// Errors come back as {type: 'error', seq, message}.
// Browser workers have no import map, and seoul-life.js imports 'three' by name: given threeURL (the page resolves it,
// seoul-life-client.js does), the worker fetches seoul-life.js and imports it with 'three' and its relative imports made
// absolute. The sim itself never touches three; once G1 splits it into a three-free module this rewrite can go.
export const VEH_STRIDE = 8;
const isNode = typeof self === 'undefined' || typeof self.postMessage !== 'function';
const port = isNode ? (await import('node:worker_threads')).parentPort : self;
const send = (m, transfer = []) => port.postMessage(m, transfer);
const listen = (f) => (isNode ? port.on('message', f) : port.addEventListener('message', (e) => f(e.data)));
const now = () => performance.now();

let sim = null, types = [], pool = [], allocs = 0;

async function loadLife(m) {
  if (isNode || !m.threeURL) return import(m.lifeURL || new URL('./seoul-life.js', import.meta.url).href);
  const base = m.lifeURL || new URL('./seoul-life.js', import.meta.url).href;
  const src = await (await fetch(base)).text();
  const fix = (spec) => (spec === 'three' ? m.threeURL : /^\.{1,2}\//.test(spec) ? new URL(spec, base).href : spec);
  const out = src.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g, (all, pre, q, spec) => pre + q + fix(spec) + q);
  const url = URL.createObjectURL(new Blob([out], { type: 'text/javascript' }));
  try { return await import(url); } finally { URL.revokeObjectURL(url); }
}

function alloc() {
  allocs++;
  const N = sim.crowd.X.length, V = sim.traffic.vehicles.length;
  return { X: new Float32Array(N), Z: new Float32Array(N), YAW: new Float32Array(N), PH: new Float32Array(N), WALK: new Float32Array(N),
    POSE: new Uint8Array(N), VIS: new Uint8Array(N), veh: new Float32Array(V * VEH_STRIDE) };
}
const buffersOf = (b) => [b.X.buffer, b.Z.buffer, b.YAW.buffer, b.PH.buffer, b.WALK.buffer, b.POSE.buffer, b.VIS.buffer, b.veh.buffer];
const fits = (b) => b && b.X?.length === sim.crowd.X.length && b.veh?.length === sim.traffic.vehicles.length * VEH_STRIDE;

// [P5 H, perf #2 / native #4] seek-safe: a frame whose clock is far from the traffic's (the warm start, a teleport, a
// rewind past the snapshots) used to run advanceTo in one go: 2.65 s (22 s on a loaded box) in which no request was
// answered, so the page drew a stale crowd or the inline sim the whole time. Now the fast-forward runs in slices of at
// most SLICE_MS, yielding between them; a request that arrives meanwhile retargets it (the newest t wins, the older one
// is dropped and answered by the newer frame). Every step is the same TrafficSim.step in the same order, so the result
// is bit-identical to one advanceTo (tests/life-worker.mjs). Init warms to opts.warmTo (the main thread's clock + warm).
export const SLICE_MS = 40, SLICE_STEPS = 32;
let want = null, running = false;
const yieldNow = () => new Promise((r) => setTimeout(r, 0));
async function advanceSliced(target) {   // target(): the newest wanted t
  const T = sim.traffic, hz = 1 / T.dt;
  for (let t = target(), nt = Math.floor(t * hz + 1e-9); ; t = target(), nt = Math.floor(t * hz + 1e-9)) {
    if (nt < T.n) {   // a rewind: restore the newest snapshot at or before nt (advanceTo's own choice, zero steps), then step forward
      let best = -1; for (const k of sim.snaps.keys()) if (k <= nt && k > best) best = k;
      if (best >= 0) sim.advanceTo(best / hz); else { T.reset(); }
    }
    if (nt - T.n <= SLICE_STEPS) { sim.advanceTo(t); return t; }
    const t0 = now();
    while (T.n < nt && now() - t0 < SLICE_MS) sim.advanceTo(Math.min(nt, T.n + SLICE_STEPS) / hz);
    stats.slices++;
    if (T.n < nt) { await yieldNow(); }
  }
}
const stats = { slices: 0, retargets: 0, warmMs: 0 };

// one frame's arrays, packed into a pooled buffer set (the frame loop, and [P8] the first frame sent with 'ready')
function pack(t, cam, fr) {
  const t0 = now(), C = sim.crowd, T = sim.traffic;
  C.events.length = 0;
  if (fr != null) C.frame = fr - 1;   // [P5 H] the main thread's stagger phase (evaluate increments it)
  C.evaluate(t, cam ? { x: cam[0], y: cam[1], z: cam[2], fx: cam[3] ?? null, fz: cam[4] ?? null } : null);
  const t1 = now();
  const b = pool.pop() || alloc();
  b.X.set(C.X); b.Z.set(C.Z); b.YAW.set(C.YAW); b.PH.set(C.PH); b.WALK.set(C.WALK); b.POSE.set(C.POSE); b.VIS.set(C.VIS);
  const P = {}, aT = sim.aT, V = b.veh;
  T.vehicles.forEach((v, i) => {
    const p = T.pose(v, aT, P), o = i * VEH_STRIDE;
    V[o] = p.x; V[o + 1] = p.z; V[o + 2] = p.hx; V[o + 3] = p.hz; V[o + 4] = p.hidden ? 1 : 0; V[o + 5] = v.brake || 0; V[o + 6] = v.hazard ? 1 : 0; V[o + 7] = types.indexOf(v.type);
  });
  return { b, aT, events: C.events.slice(), crowdMs: t1 - t0, packMs: now() - t1 };
}

async function frameLoop() {
  if (running) return; running = true;
  try {
    while (want) {
      const t0 = now();
      const t = await advanceSliced(() => Math.max(0, +want.t || 0));
      const m = want; want = null;
      const tt = Math.max(0, +m.t || 0);
      if (tt !== t) { want = m; continue; }   // (retargeted during the last slice)
      const t1 = now(), F = pack(t, m.cam, m.fr), b = F.b;
      send({ type: 'frame', seq: m.seq, t, aT: F.aT, buf: b, events: F.events, ms: { sim: t1 - t0, crowd: F.crowdMs, pack: F.packMs }, allocs, slices: stats.slices, retargets: stats.retargets, dropped: m.dropped || 0 }, buffersOf(b));
    }
  } finally { running = false; }
}
function frame(m) {
  if (m.recycle && fits(m.recycle)) pool.push(m.recycle);
  if (want) { stats.retargets++; m.dropped = (want.dropped || 0) + 1; }
  want = m;
  return frameLoop();
}

const QUERIES = new Set(['boxesAt', 'hit', 'hitPeople', 'hash']);
listen(async (m) => {
  try {
    if (m.type === 'init') {
      const t0 = now(), mod = await loadLife(m), LifeSim = mod.LifeSim || mod.default?.LifeSim;
      if (!LifeSim) throw new Error('seoul-life.js exports no LifeSim');
      sim = new LifeSim(m.layout, m.opts || {}); pool = []; allocs = 0;
      types = [...new Set(sim.traffic.vehicles.map((v) => v.type))].sort();
      const hash = sim.hash(), tw = now();   // (the hash as built, t = 0: what the main thread compares)
      if (m.opts?.warmTo > 0) { want = null; await advanceSliced(() => +m.opts.warmTo); }   // [P5 H] warm before 'ready': the first frame is cheap
      stats.warmMs = now() - tw;
      // [P8 G1, perf #3: the panel's first worker frame came back 657 s after its request] the first frame rides on 'ready':
      // the crowd and traffic at warmTo seen from opts.cam (the spawn), in the main thread's first stagger phase (opts.fr),
      // so the main thread draws the worker's frame from its first update instead of waiting a request's round trip
      const F = m.opts?.cam ? pack(+m.opts.warmTo || 0, m.opts.cam, m.opts.fr ?? 1) : null;
      const first = F ? { t: +m.opts.warmTo || 0, aT: F.aT, buf: F.b, events: F.events, ms: { sim: 0, crowd: F.crowdMs, pack: F.packMs } } : null;
      send({ type: 'ready', seq: m.seq, agents: sim.crowd.X.length, vehicles: sim.traffic.vehicles.length, types, hash, ms: now() - t0, warmMs: stats.warmMs, warmTo: m.opts?.warmTo ?? 0, first }, first ? buffersOf(first.buf) : []);
    } else if (!sim) throw new Error(`'${m.type}' before 'init'`);
    else if (m.type === 'frame') await frame(m);
    else if (m.type === 'hash') { sim.advanceTo(m.t); send({ type: 'hash', seq: m.seq, t: m.t, hash: sim.hash(), n: sim.traffic.n }); }
    else if (m.type === 'call') {
      if (!QUERIES.has(m.fn)) throw new Error(`call: ${m.fn} is not a pure LifeSim query`);
      send({ type: 'call', seq: m.seq, value: sim[m.fn](...(m.args || [])) });
    } else if (m.type === 'dispose') { sim = null; pool = []; if (isNode) port.close(); else self.close(); }
  } catch (e) { send({ type: 'error', seq: m?.seq ?? null, message: String(e?.stack || e?.message || e) }); }
});
