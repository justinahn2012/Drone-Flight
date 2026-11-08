// ghost.js — rivalry (design r4 #2): the best take as a ghost, and CHALLENGE files.
//
// A take is stored as its input log (inputlog.js), trimmed to the take: no poses, just the start state + one quantised
// input per 1/240 s tick, which re-simulates bit for bit in a second Drone on the same world (the replay contract,
// tests/replay.mjs). The ghost is that second Drone, stepped lazily to the current take's clock.
//
// Contract C12 (consumed by main.js / the UI; all of it optional, the UI must tolerate its absence):
//   const keeper = new GhostKeeper(take, () => inputLog, () => world);   // main.js: its live log + world
//   keeper.event(e)            call with every take event (main.js takeEvent): remembers where the take started in the
//                              log; on a CUT that beats the stored best, saves the take (IndexedDB) and makes it the ghost
//   take.ghostPose(physAlpha)  per frame: {pos:[x,y,z], q:[x,y,z,w], heading, t, done, crashed} or null. Draw it as an
//                              OSD diamond (screen space, never into the 3D scene, so never into clips)
//   keeper.best / keeper.last  the stored best take / the take just finished (records, see ghostRecord), or null
//   keeper.challenge(rec?)     CHALLENGE (call from the button's click handler: navigator.share needs the gesture):
//                              shares rec (default keeper.last) as a .otil + score text; 'shared' | 'cancelled' |
//                              'downloaded' | 'failed'
//   keeper.load(bytesOrFile)   a received challenge -> the ghost to race (Promise of the record, or null + keeper.error)
//   keeper.clear()             drop the ghost (take.ghost = null)
// A record: {v, key (world hash), craft, mode, total, stars, perfect, t (take s), lines, date, startTick, bytes (the
// trimmed .otil, Uint8Array)}. In the .otil the take's facts ride in header.meta.take, so a shared file is self-contained.
import { Drone } from './flight.js';
import { InputLog, CHANNELS, worldHash } from './inputlog.js';

export const GHOST_VERSION = 1;
const NC = CHANNELS.length;
const MAX_STEPS = 960;          // ticks one pose() call may simulate (4 s of flight): a seek never stalls a frame long

// mode in force before tick k of a log
function modeAt(log, k) { let m = log.header.mode; for (const x of log.modes) { if (x.tick <= k) m = x.mode; else break; } return m; }

// A copy of `log` holding ticks [from, to): it starts at the last snapshot at or before `from` (header.start if none),
// so it replays exactly. Returns {log, offset} (offset = ticks dropped from the front).
export function trimLog(log, from, to = log.ticks) {
  to = Math.min(to, log.ticks); from = Math.max(0, Math.min(from, to));
  let k0 = 0, start = log.header.start;
  for (const s of log.snaps) { if (s.tick <= from) { k0 = s.tick; start = s.s; } else break; }
  const out = new InputLog({ ...log.header, mode: modeAt(log, k0), start, maxTicks: Infinity, meta: { ...(log.header.meta || {}) } });
  out.header.mode = modeAt(log, k0); out.header.start = start;
  out.data = log.data.slice(k0 * NC, to * NC); if (out.data.length < NC) out.data = new Int16Array(NC);
  out.ticks = to - k0;
  out.snaps = log.snaps.filter((s) => s.tick > k0 && s.tick < to).map((s) => ({ tick: s.tick - k0, s: s.s }));
  out.modes = log.modes.filter((m) => m.tick > k0 && m.tick < to).map((m) => ({ tick: m.tick - k0, mode: m.mode }));
  return { log: out, offset: k0 };
}

// The record of a finished take flown in `log`: startTick = the log's tick count before the take's first live tick (the
// tick whose input started it; main.js: inputLog.ticks - 1 at the 'start' event), endTick = its tick count at the end.
// e = the take's 'cut' (or 'crash') event.
export function ghostRecord(log, startTick, endTick, e = {}) {
  const { log: L, offset } = trimLog(log, startTick, endTick);
  const st = e.stats || {};
  const take = { v: GHOST_VERSION, startTick: startTick - offset, total: e.total | 0, stars: e.stars | 0, perfect: !!e.perfect,
    t: +(st.time ?? (endTick - startTick) / log.header.hz).toFixed(3), lines: (st.lines || []).filter((l) => !l.repeat).map((l) => [l.name, l.t]) };
  L.header.meta = { ...L.header.meta, take };
  return recordFromLog(L, Date.now());
}
function recordFromLog(L, date = 0) {
  const tk = L.header.meta?.take;
  if (!tk || !(tk.startTick >= 0)) return null;
  return { v: tk.v || 1, key: L.header.world, craft: L.header.craft, mode: L.header.mode, total: tk.total | 0, stars: tk.stars | 0, perfect: !!tk.perfect,
    t: tk.t || 0, lines: tk.lines || [], date, startTick: tk.startTick, bytes: L.toBytes(), _log: L };
}
// a .otil (bytes / ArrayBuffer / Blob or File) -> record, or throws
export async function recordFromBytes(src) {
  const buf = typeof src?.arrayBuffer === 'function' ? new Uint8Array(await src.arrayBuffer()) : src instanceof Uint8Array ? src : new Uint8Array(src);
  const r = recordFromLog(InputLog.fromBytes(buf));
  if (!r) throw new Error('not a One Take challenge (no take in this log)');
  return r;
}

// The ghost: a record re-simulated in its own Drone on `world` (the world main.js flies: bvh, funnels, envelope).
export class Ghost {
  constructor(rec, world) {
    this.rec = rec; this.world = world;
    this.log = rec._log || InputLog.fromBytes(rec.bytes);
    this.stale = !!world && worldHash(world) !== this.log.header.world;    // recorded on another collider: can't replay
    this.d = new Drone(this.log.header.craft);
    this.k = -1; this._inp = {}; this._mode = this.log.header.mode; this._mi = 0;
    this.hz = this.log.header.hz || 240;
    this.end = this.log.ticks;
  }
  get startTick() { return this.rec.startTick; }
  // run the ghost to k ticks into its log (rewinding to a snapshot when k is behind); false if it ran out of budget
  seek(k, budget = MAX_STEPS) {
    const L = this.log; k = Math.max(0, Math.min(k, this.end));
    // the latest exact state at or before k: a stored snapshot (or the start); jump to it when rewinding or when it is
    // ahead of where the ghost is (snapshots restore bit-identically, so this is exact)
    let s = L.header.start, k0 = 0;
    for (const x of L.snaps) { if (x.tick <= k) { s = x.s; k0 = x.tick; } else break; }
    if (this.k < 0 || k < this.k || k0 > this.k) {
      this.d.restore(s); this.k = k0; this._mode = modeAt(L, k0);     // prev / prevQ come with it (the tick before)
      this._mi = L.modes.findIndex((m) => m.tick >= k0); if (this._mi < 0) this._mi = L.modes.length;
    }
    let n = 0;
    while (this.k < k && n < budget) {
      while (this._mi < L.modes.length && L.modes[this._mi].tick === this.k) this._mode = L.modes[this._mi++].mode;
      L.input(this.k, this._inp);
      this.d.step(1 / this.hz, this._inp, this._mode, this.world);
      this.k++; n++;
    }
    return this.k === k;
  }
  // pose at take time t (s; the take's stats.time clock), alpha between the previous tick and that one; null if stale.
  // done: the ghost's take is over (it holds its last pose).
  pose(t, alpha = 1, out = {}) {
    if (this.stale) return null;
    const want = this.rec.startTick + Math.round(Math.max(0, t) * this.hz), done = want >= this.end;
    this.seek(want);
    const d = this.d, a = done ? 1 : alpha, p = d.pos, q = d.prev;
    out.pos = [q.x + (p.x - q.x) * a, q.y + (p.y - q.y) * a, q.z + (p.z - q.z) * a];
    const r = d.prevQ.clone().slerp(d.q, a); out.q = [r.x, r.y, r.z, r.w];
    out.heading = d.heading; out.t = (this.k - this.rec.startTick) / this.hz; out.done = done; out.crashed = d.crashed;
    out.total = this.rec.total;
    return out;
  }
  // park at the take start (call between takes so the next start costs nothing)
  prime() { if (!this.stale) this.seek(this.rec.startTick, Infinity); }
}

// ---- storage: one best take per world (IndexedDB 'onetake' / 'ghosts', key = world hash); memory fallback
const mem = new Map();
let dbP = null;
function db() {
  if (dbP) return dbP;
  dbP = new Promise((res) => {
    try {
      const idb = globalThis.indexedDB; if (!idb) return res(null);
      const rq = idb.open('onetake', 1);
      rq.onupgradeneeded = () => { try { rq.result.createObjectStore('ghosts'); } catch (e) {} };
      rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); rq.onblocked = () => res(null);
    } catch (e) { res(null); }
  });
  return dbP;
}
const strip = (rec) => { const { _log, ...r } = rec; return r; };
export async function loadBest(key) {
  const d = await db();
  if (!d) return mem.get(key) || null;
  return new Promise((res) => {
    try { const rq = d.transaction('ghosts', 'readonly').objectStore('ghosts').get(key); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(mem.get(key) || null); }
    catch (e) { res(mem.get(key) || null); }
  });
}
export async function saveBest(rec) {
  const r = strip(rec); mem.set(r.key, r);
  const d = await db(); if (!d) return false;
  return new Promise((res) => {
    try { const tx = d.transaction('ghosts', 'readwrite'); tx.objectStore('ghosts').put(r, r.key); tx.oncomplete = () => res(true); tx.onerror = () => res(false); }
    catch (e) { res(false); }
  });
}

// ---- CHALLENGE: share the take's .otil + its score (Web Share level 2 with files), else download it
const fmt = (n) => Math.round(n || 0).toLocaleString('en-US');
export function challengeText(rec) {
  return `Beat my take: ${fmt(rec.total)} pts${rec.stars ? ' ' + '★'.repeat(rec.stars) : ''}${rec.perfect ? ' PERFECT' : ''} in ${rec.t.toFixed(1)} s. One Take FPV`;
}
// No await before navigator.share: it must run inside the click's user activation.
export function shareChallenge(rec, { url = globalThis.location?.href?.split(/[?#]/)[0] } = {}) {
  const name = `onetake-${rec.total}.otil`, text = challengeText(rec);
  let file = null;
  try { file = new File([rec.bytes], name, { type: 'application/octet-stream' }); } catch (e) {}
  const nav = globalThis.navigator;
  const download = () => {
    try {
      const a = document.createElement('a'); a.href = URL.createObjectURL(file || new Blob([rec.bytes])); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); return 'downloaded';
    } catch (e) { return 'failed'; }
  };
  if (file && nav?.share && nav.canShare?.({ files: [file] })) {
    return nav.share({ files: [file], title: 'One Take FPV challenge', text: url ? `${text}\n${url}` : text })
      .then(() => 'shared', (e) => (e?.name === 'AbortError' ? 'cancelled' : download()));
  }
  return Promise.resolve(download());
}

// ---- the glue main.js needs (see the contract at the top)
export class GhostKeeper {
  constructor(take, getLog, getWorld) {
    this.take = take; this.getLog = getLog; this.getWorld = getWorld;
    this.best = null; this.last = null; this.rival = null; this.error = null;
    this._key = null; this._log = null; this._k0 = -1; this._loading = null;
    this.sync();
  }
  // (re)load the stored best when the world changes; attaches it as the ghost unless a challenge is loaded
  sync() {
    const w = this.getWorld?.(); if (!w) return;
    const key = worldHash(w); if (key === this._key) return;
    this._key = key; this.best = null; if (!this.rival) this._attach(null);
    this._loading = loadBest(key).then((r) => { if (r && this._key === key) { this.best = r; if (!this.rival) this._attach(r); } }).catch(() => {});
  }
  _attach(rec) {
    const w = this.getWorld?.();
    this.take.ghost = rec && w ? new Ghost(rec, w) : null;
    if (this.take.ghost?.stale) this.take.ghost = null;
    try { this.take.ghost?.prime(); } catch (e) { this.take.ghost = null; }
  }
  event(e) {
    if (!e) return;
    this.sync();
    if (e.type === 'start') {
      const log = this.getLog?.(); this._log = log || null; this._k0 = log ? log.ticks - 1 : -1;
    } else if (e.type === 'cut' || e.type === 'crash') {
      const log = this.getLog?.();
      if (log && log === this._log && this._k0 >= 0 && e.type === 'cut' && e.total > 0) {
        try {
          const rec = ghostRecord(log, this._k0, log.ticks, e);
          this.last = rec;
          if (rec && rec.key === this._key && (!this.best || rec.total > this.best.total)) {
            this.best = rec; saveBest(rec).catch(() => {});
            if (!this.rival) { this._attach(rec); return; }
          }
        } catch (err) { this.error = String(err?.message || err); }
      }
      this._log = null; this._k0 = -1;
      try { this.take.ghost?.prime(); } catch (err) {}
    }
  }
  challenge(rec = this.last || this.best) { return rec ? shareChallenge(rec) : Promise.resolve('failed'); }
  async load(src) {
    this.error = null;
    try {
      const r = await recordFromBytes(src);
      const w = this.getWorld?.();
      if (w && r.key !== worldHash(w)) { this.error = 'This challenge was flown on another version of the site.'; return null; }
      this.rival = r; this._attach(r); return r;
    } catch (err) { this.error = String(err?.message || err); return null; }
  }
  clear() { this.rival = null; this.take.ghost = null; }
  // back to racing the stored best after a challenge
  unrival() { this.rival = null; this._attach(this.best); }
}
