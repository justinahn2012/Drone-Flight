// seoul-life-client.js: the main-thread side of seoul-life-worker.js (P3 stream H, native #5 / perf #3).
//   const lw = await LifeWorker.create(layout, { seed, density, maxAgents, sites });   // null where no Worker exists
//   per frame:  lw.request(tNext, camPos);       // ask for the frame you will draw next (t = take clock + warm)
//               const f = lw.latest();            // the newest finished frame, or null: {seq, t, aT, X, Z, YAW, PH, WALK,
//                                                 //   POSE, VIS, veh, events, ms}; arrays as CrowdSim / pose() write them
//               ... read f, then lw.release(f)    // its buffers go back to the worker with the next request
//   lw.hash(t), lw.call('boxesAt', t)  -> Promise (pure LifeSim queries, for tests and tools)
//   lw.dispose()
// One request in flight at a time: a request while the worker is busy replaces the pending one (newest t wins), so a slow
// worker drops frames instead of queueing them. Results are a pure function of (t, cam): drawing the frame for t_k one
// frame late shows that frame's crowd at t_k, never a blend. The colliders stay on the main thread's own LifeSim.
// Browser: a module Worker; 'three' is resolved here through the page's import map (workers have none) and handed over.
// Node (tests/life-worker.mjs): worker_threads, the same worker file.
export const VEH_STRIDE = 8;

// (P5 G1) the camera goes over whole: [x, y, z, fx, fz] (its horizontal forward, or null). P4 sent only x, y, z, so the worker
// evaluated without the forward and kept every unit behind the camera that the inline path staggers: 7.9 % more people
// drawn than inline (tests/life-worker.mjs gates 2 %)
const camArr = (c) => (c ? [c.x ?? c[0], c.y ?? c[1], c.z ?? c[2], c.fx !== undefined ? c.fx : c[3] ?? null, c.fz !== undefined ? c.fz : c[4] ?? null] : null);
export class LifeWorker {
  static supported() { return typeof Worker !== 'undefined'; }

  /** -> a ready LifeWorker, or null when there is no Worker (or it failed to start: the caller keeps the inline sim). */
  static async create(layout, opts = {}, { url = new URL('./seoul-life-worker.js', import.meta.url), lifeURL = new URL('./seoul-life.js', import.meta.url).href,
    threeURL, WorkerImpl = typeof Worker !== 'undefined' ? Worker : null, timeoutMs = 20000 } = {}) {
    if (!WorkerImpl) return null;
    if (threeURL === undefined) { try { threeURL = import.meta.resolve?.('three'); } catch (e) { threeURL = undefined; } }
    let w;
    try { w = new WorkerImpl(url, { type: 'module' }); } catch (e) { return null; }
    const lw = new LifeWorker(w);
    try { lw.info = await lw._ask({ type: 'init', layout, opts, lifeURL, threeURL: /^https?:/.test(threeURL || '') ? threeURL : undefined }, 'ready', timeoutMs); }
    catch (e) { lw.dispose(); if (opts.throwOnError) throw e; console.warn('[life worker] off:', e.message); return null; }
    return lw;
  }

  constructor(w) {
    this.w = w; this.seq = 0; this.busy = false; this.pending = null; this.ready = null; this.free = null; this.waiters = new Map();
    this.stats = { requests: 0, frames: 0, dropped: 0, rtt: 0, workerMs: 0, allocs: 0 };
    const on = (f) => (w.on ? w.on('message', f) : w.addEventListener('message', (e) => f(e.data)));
    on((m) => this._onMessage(m));
    const err = (e) => { this.error = String(e?.message || e); for (const [, r] of this.waiters) r.reject(new Error(this.error)); this.waiters.clear(); };
    if (w.on) w.on('error', err); else w.addEventListener('error', err);
  }

  _post(m, transfer = []) { this.w.postMessage(m, transfer); }
  _ask(m, type, timeoutMs = 20000) {
    const seq = m.seq ?? ++this.seq; m.seq = seq;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { this.waiters.delete(seq); reject(new Error(`life worker: no '${type}' in ${timeoutMs} ms`)); }, timeoutMs) : null;
      this.waiters.set(seq, { type, resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); }, reject: (e) => { if (timer) clearTimeout(timer); reject(e); } });
      this._post(m);
    });
  }
  _onMessage(m) {
    if (m.type === 'frame') {
      this.busy = false; this.stats.frames++; this.stats.allocs = m.allocs;
      this.stats.rtt = performance.now() - this._sent; this.stats.workerMs = m.ms.sim + m.ms.crowd + m.ms.pack;
      if (this.ready) this.release(this.ready);   // never read: straight back
      this.ready = { seq: m.seq, t: m.t, aT: m.aT, events: m.events, ms: m.ms, ...m.buf, _buf: m.buf };
      if (this.pending) { const p = this.pending; this.pending = null; this._send(p.t, p.cam); }
      return;
    }
    const w = m.seq != null ? this.waiters.get(m.seq) : null;
    if (!w) { if (m.type === 'error') { this.error = m.message; this.busy = false; } return; }
    this.waiters.delete(m.seq);
    if (m.type === 'error') w.reject(new Error(m.message)); else w.resolve(m.type === 'call' ? m.value : m);
  }
  _send(t, cam) {
    const seq = ++this.seq, recycle = this.free; this.free = null;
    this.busy = true; this._sent = performance.now(); this.stats.requests++;
    this._post({ type: 'frame', seq, t, cam: camArr(cam), recycle }, recycle ? bufs(recycle) : []);
  }

  /** Ask for the crowd and traffic at take clock t seen from cam ({x,y,z} or [x,y,z]). Never blocks. */
  request(t, cam = null) {
    if (this.error) return false;
    if (this.busy) { if (this.pending) this.stats.dropped++; this.pending = { t, cam: camArr(cam) }; return false; }
    this._send(t, cam); return true;
  }
  /** The newest finished frame (yours until release(f)), or null. */
  latest() { const f = this.ready; this.ready = null; return f; }
  /** Give a frame's buffers back (the next request carries them to the worker: no allocation per frame). */
  release(f) { if (f?._buf && !this.free) this.free = f._buf; }
  hash(t) { return this._ask({ type: 'hash', t }, 'hash').then((m) => m.hash); }
  call(fn, ...args) { return this._ask({ type: 'call', fn, args }, 'call'); }
  dispose() { try { this._post({ type: 'dispose' }); } catch (e) { /* gone */ } try { this.w.terminate?.(); } catch (e) { /* gone */ } this.ready = this.free = null; }
}
const bufs = (b) => [b.X.buffer, b.Z.buffer, b.YAW.buffer, b.PH.buffer, b.WALK.buffer, b.POSE.buffer, b.VIS.buffer, b.veh.buffer];
