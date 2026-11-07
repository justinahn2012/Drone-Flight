// take.js — the game: one continuous take through the site's named lines.
// A take runs from the first stick input to a crash or a CUT (hands off, hovering, for 1.5 s).
// LINES are invisible portals in world.lines (a segment of flight crossing a rectangle). Each new line scores
// pts x FLOW into an unbanked chain and adds +1 FLOW (cap x8). 5 s with no line banks the chain and FLOW drops back
// to x1; a crash loses whatever is unbanked; a clean CUT banks the live chain at x1.5. A line already flown this
// take is a repeat: 25 % of its pts, no FLOW, and only after some other line (no ping-pong through one gate).
// Skimming solid geometry (world.skimBvh: structures only, no grass) is a small flow-keeper: a flat <=100 pts/s
// that holds the bank timer while a chain is live.
// No three.js import: plain vector maths, runs headless in node too.

export const TAKE_TUNING = {
  bankT: 5.0,          // s without a line (or a skim) before the chain banks
  cutT: 1.5,           // s of hands-off hover that ends the take
  cutSpeed: 2.5,       // m/s: slower than this is a hover
  flowMax: 8,
  repeat: 0.25,        // share of pts for a line already flown this take
  cutMult: 1.5,        // a clean CUT banks the live chain at x1.5
  skimRate: 100,       // pts/s at contact distance, flat (no FLOW)
  skimZone: 1.4,       // m from solid geometry (cinewhoop: 0.9)
  skimSpeed: 4,        // m/s
  cooldown: 1.5,       // s before the same line can fire again
  teleport: 25,        // m in one update = a reset/teleport, not flight
};
const T = TAKE_TUNING;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// gate: {c, n, w, h, u?}. Width runs along u (default: horizontal, across n), height along n x u.
function compileGate(g) {
  const n = norm(g.n);
  let u = g.u ? g.u.slice() : Math.abs(n[1]) > 0.9 ? [1, 0, 0] : cross([0, 1, 0], n);
  const k = dot(u, n); u = norm([u[0] - n[0] * k, u[1] - n[1] * k, u[2] - n[2] * k]);
  return { c: g.c, n, u, v: cross(n, u), hw: g.w / 2, hh: g.h / 2 };
}
// +1 / -1 if the segment a->b crosses the gate's rectangle along +n / -n, else 0
function crossGate(G, a, b) {
  const da = (a.x - G.c[0]) * G.n[0] + (a.y - G.c[1]) * G.n[1] + (a.z - G.c[2]) * G.n[2];
  const db = (b.x - G.c[0]) * G.n[0] + (b.y - G.c[1]) * G.n[1] + (b.z - G.c[2]) * G.n[2];
  let s = 0;
  if (da < 0 && db >= 0) s = 1; else if (da >= 0 && db < 0) s = -1; else return 0;
  const t = da / (da - db);
  const q = [a.x + (b.x - a.x) * t - G.c[0], a.y + (b.y - a.y) * t - G.c[1], a.z + (b.z - a.z) * t - G.c[2]];
  return Math.abs(dot(q, G.u)) <= G.hw && Math.abs(dot(q, G.v)) <= G.hh ? s : 0;
}
const plainCaption = (s) => String(s || '').replace(/\*/g, '');

export class Take {
  constructor({ free = false } = {}) {
    this.free = free;              // free fly: lines still fire (captions, pts 0), no scoring, no take end
    this._best = 0;
    try { this._best = +globalThis.localStorage?.getItem('onetake.best') || 0; } catch (e) {}
    this._src = null; this._lines = [];
    this.reset();
  }
  get state() { return this._state; }
  get total() { return Math.round(this._total); }
  get flow() { return this._flow; }                       // the multiplier the next line will score at
  get unbanked() { return Math.round(this._unbanked); }
  get best() { return Math.max(this._best, this._state === 'done' ? 0 : Math.round(this._total)); }
  get bankIn() { return this._unbanked > 0 ? Math.max(0, T.bankT - this._idle) : 0; }   // s until the chain banks
  get stats() { return { maxSpeed: this._maxSpeed, time: this._t, lines: this._log.slice(), maxFlow: this._maxFlow }; }

  reset() {
    this._state = 'ready'; this._t = 0; this._total = 0; this._unbanked = 0; this._flow = 1; this._idle = 0;
    this._hover = 0; this._maxSpeed = 0; this._maxFlow = 1; this._log = []; this._done = new Set(); this._lastName = null;
    this._cool = {}; this._pre = new Map(); this._last = null; this._released = false; this._skim = 0; this._skimOff = 0;
    this._now = 0;
  }
  // the take ends the hard way (out of bounds, a reset mid-take): same as a crash
  fail() {
    if (this.free || this._state !== 'live') return [];
    return this._end('crash');
  }

  _compile(world) {
    if (this._src === world.lines) return;
    this._src = world.lines;
    this._lines = (world.lines || []).map((l) => ({ l, main: compileGate(l), pre: (l.pre || []).map(compileGate) }));
    this._pre = new Map();
  }

  update(dt, drone, world, sticksActive) {
    const ev = [];
    this._now += dt;
    if (world) this._compile(world);
    const p = drone.pos, spd = Math.hypot(drone.vel.x, drone.vel.y, drone.vel.z);
    if (this.free) { this._gates(p, drone, ev); return ev; }

    if (this._state === 'done') {
      // after a CUT: let go, then touch a stick and a new take starts from where you are
      if (!sticksActive) this._released = true;
      if (!(this._released && sticksActive && !drone.crashed)) { this._last = { x: p.x, y: p.y, z: p.z }; return ev; }
      this.reset();
    }
    if (this._state === 'ready') {
      if (!sticksActive || drone.crashed) { this._last = { x: p.x, y: p.y, z: p.z }; return ev; }
      this._state = 'live'; ev.push({ type: 'start' });
    }
    // live
    this._t += dt; this._idle += dt;
    this._maxSpeed = Math.max(this._maxSpeed, spd);
    if (drone.crashed) { ev.push(...this._end('crash')); return ev; }
    this._gates(p, drone, ev);
    this._skimTick(dt, drone, world, spd, ev);
    // bank
    if (this._unbanked > 0 && this._idle >= T.bankT) {
      const pts = Math.round(this._unbanked); this._total += pts; this._unbanked = 0; this._flow = 1;
      ev.push({ type: 'bank', pts, total: this.total });
    }
    // cut: hands off, hovering, with something to show for it
    this._hover = !sticksActive && spd < T.cutSpeed ? this._hover + dt : 0;
    if (this._hover >= T.cutT && this._total + this._unbanked > 0) ev.push(...this._end('cut'));
    return ev;
  }

  _gates(p, drone, ev) {
    const a = this._last; this._last = { x: p.x, y: p.y, z: p.z };
    if (!a) return;
    if (Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) > T.teleport) return;
    const now = this._now;
    // pre-gates first (a fast pass can cross a pre-gate and its line in the same frame)
    this._lines.forEach((L, li) => L.pre.forEach((G, gi) => { const s = crossGate(G, a, p); if (s) this._pre.set(li * 8 + gi, { t: now, s }); }));
    this._lines.forEach((L, li) => {
      const s = crossGate(L.main, a, p);
      if (!s || (!L.l.two && s < 0)) return;
      if (L.pre.length) {
        const ok = L.pre.some((_, gi) => { const r = this._pre.get(li * 8 + gi); return r && now - r.t <= (L.l.within ?? 6) && r.s === (L.l.two ? s : 1); });
        if (!ok) return;
        L.pre.forEach((_, gi) => this._pre.delete(li * 8 + gi));
      }
      const e = this._award(L.l, now);
      if (e) ev.push(e);
    });
  }

  _award(l, now) {
    const name = l.name, caption = l.caption || name;
    if (now - (this._cool[name] ?? -99) < T.cooldown) return null;
    if (this.free) { this._cool[name] = now; return { type: 'line', name, caption, pts: 0, flow: 1, free: true }; }
    if (this._done.has(name)) {
      if (this._lastName === name) return null;                     // fly something else first
      this._cool[name] = now;
      const pts = Math.round((l.pts || 0) * T.repeat);
      this._unbanked += pts; this._idle = 0; this._lastName = name;
      this._log.push({ name, pts, t: +this._t.toFixed(2), flow: 1, repeat: true });
      return { type: 'repeat', name, caption, pts };
    }
    this._cool[name] = now;
    const flow = this._flow, pts = Math.round((l.pts || 0) * flow);
    this._unbanked += pts; this._idle = 0; this._lastName = name; this._done.add(name);
    this._flow = Math.min(T.flowMax, flow + 1); this._maxFlow = Math.max(this._maxFlow, flow);
    this._log.push({ name, pts, t: +this._t.toFixed(2), flow });
    return { type: 'line', name, caption, pts, flow };
  }

  _skimTick(dt, drone, world, spd, ev) {
    const bvh = world?.skimBvh;
    let on = false;
    if (bvh && this._unbanked > 0 && spd > T.skimSpeed) {
      const r = drone.c?.radius ?? 0.12, zone = drone.key === 'cinewhoop' ? 0.9 : T.skimZone;
      const res = bvh.closestPointToPoint(drone.pos, this._cp || (this._cp = {}), 0, zone + r);
      const gap = res && res.distance <= zone + r ? res.distance - r : Infinity;
      if (gap < zone) { const c = 1 - Math.max(0, gap) / zone; const pts = T.skimRate * c * c * dt; this._unbanked += pts; this._skim += pts; this._idle = 0; on = true; }
    }
    this._skimOff = on ? 0 : this._skimOff + dt;
    if (!on && this._skim > 0 && this._skimOff > 0.4) { if (this._skim >= 10) ev.push({ type: 'skim', pts: Math.round(this._skim) }); this._skim = 0; }
  }

  _end(kind) {
    const ev = [];
    if (kind === 'crash') {
      const lost = Math.round(this._unbanked);
      if (lost > 0) ev.push({ type: 'lost', pts: lost });
      this._unbanked = 0;
      this._finish();
      ev.push({ type: 'crash', total: this.total, stats: this.stats, lost });
    } else {
      const pts = Math.round(this._unbanked * T.cutMult);
      this._total += pts; this._unbanked = 0;
      if (pts > 0) ev.push({ type: 'bank', pts, total: this.total, cut: true });
      this._finish();
      ev.push({ type: 'cut', total: this.total, stats: this.stats, pts });
    }
    return ev;
  }
  _finish() {
    this._state = 'done'; this._flow = 1; this._released = false; this._skim = 0;
    if (this._total > this._best) { this._best = Math.round(this._total); try { globalThis.localStorage?.setItem('onetake.best', String(this._best)); } catch (e) {} }
  }
}

// fallback UI until main.js defines onTakeEvent (pop(text, kind), contract #5; the old pop ignores kind)
export function defaultTakeUI(e, pop) {
  const n = (v) => Math.round(v || 0).toLocaleString('en-US');
  switch (e.type) {
    case 'line': pop(e.pts ? `${plainCaption(e.caption)}  ${e.flow > 1 ? `×${e.flow}  ` : ''}+${n(e.pts)}` : plainCaption(e.caption), 'line'); break;
    case 'repeat': pop(`${plainCaption(e.caption || e.name)}  REPEAT +${n(e.pts)}`, 'line'); break;
    case 'bank': if (!e.cut) pop(`BANKED +${n(e.pts)}`, 'score'); break;
    case 'cut': pop(`CUT!  ${e.pts ? `+${n(e.pts)}  ` : ''}${n(e.total)} PTS`, 'score'); break;
    case 'crash': pop(e.lost ? `CRASHED · CHAIN LOST −${n(e.lost)}` : `CRASHED · ${n(e.total)} PTS`, 'warn'); break;
    default: break;
  }
}
