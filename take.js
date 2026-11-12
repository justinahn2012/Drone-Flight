// take.js — the game: one continuous take through the site's named lines.
// A take runs from the first stick input to a crash or a CUT. CUT = 3 s hands-off hover (a countdown shows from 1 s)
// or 0.6 s sat on a floor (landing is how a pilot ends a DVR clip); never within 4 s of crossing a pre-gate (settling
// over a mouth or under a hole is not the end).
// LINES are invisible portals in world.lines (a segment of flight crossing a rectangle), or carves (half way round a
// silo / the chimney, a U-turn over the hall roof). Each new line scores pts x FLOW (x1.25 if CLEAN: no contact since
// the previous line) into an unbanked chain and adds +1 FLOW (cap x8). 5 s with no line banks the chain and FLOW drops
// back to x1; flying within 2 m of structure (holdZone) keeps the chain alive. The bank timer runs at 0.4x below 2 m/s
// with hands on (lining up under a hole is barely idling, but a crawl still banks: design r4 #5) and the hold only
// counts faster than 2 m/s. A crash loses whatever is unbanked; a CUT banks the live
// chain at x1.5 x PACE (x1.5 when the last new line came at <= 45 s of take time, x1.0 at >= 90 s). An impact over
// 2.5 m/s that isn't a crash or a floor contact (SCRAPE) costs 1 FLOW. A line already flown
// this take is a repeat: 25 % of its pts, no FLOW, and only after some other line (no ping-pong through one gate).
// Micro-lines (500 pts) are lines too: they fill the dead stretches of the signature line.
// Skimming solid geometry (world.skimBvh: structures only, no grass) pays a flat <=100 pts/s while a chain is live and
// within 5 s of the last line (orbiting a wall farms nothing).
// Hands (main.js sticksActive, decision 9): {hands: a thumb on the screen or any stick past its deadzone, moved: a stick
// past its deadzone, steer: pitch/roll/yaw past it}. A take starts on `moved`; the hover CUT needs no hands, and never
// fires down a shaft (world.funnels); the touchdown CUT needs `steer` idle (holding the dive down is landing). A plain
// boolean still works (hands = moved = it, steer = false: the round-3 behaviour).
// Progress (lines ever flown, best FLOW / pts / take time per line) and the best take persist in localStorage.
// PERFECT (design r4 #1): a take that ends in a CUT with 3 stars, every line CLEAN and no SCRAPE.
// Ghost (C12, ghost.js): `take.ghost` holds a Ghost (the best take re-simulated from its input log, or a CHALLENGE);
// take.ghostPose(alpha) is its pose at this take's clock, for the UI's OSD diamond (never drawn into clips).
// [P2-F1] Per level: world.tuning (lines.json `tuning`) merges over TAKE_TUNING (take.tuning; bando has none, so its numbers
// stay bit-exact): stars, bankT, holdZone, armHold (no bank while a line is armed: take.armed is the line in progress and
// its countdown, for the OSD), microFlow (Seoul: micros keep the chain but add no FLOW), firstR, pace. Lines with `piece`
// fly only while world.setPieces has that id. world.movers contacts come through the drone (flight.js moverN / moverKind /
// crashBy): a pedestrian is SCRAPE + HEADS! (event heads: true), a crash into a vehicle carries by: <type>.
// [P3-F1 design #6] heads with a stake: a line flagged `heads` (OVER THE QUEUE: a club queue's length at 1.95-2.6 m) is
// void if a HEADS! comes while it is armed (its pre-gate crossed, the gate not yet): the scrape event lists it in `voids`.
// [P4-F1 design #2 / UX #5] one HEADS! per contact cluster: a pedestrian contact within headsGrace s of the last HEADS!
// stamp is the same bump (no stamp, no FLOW); it still voids an armed `heads` line, as a {type: 'void', voids} event.
// [P4-F1 design #3 / UX #6] skill on timed lines: a line with `par` (its flown path at 8 m/s, s) and a pre-gate scores
// x(1 + fastBonus * clamp((within - t) / (within - par))), t = the move's time (pre-gate to gate): x1.5 at par, x1 at the
// end of its window. Its line / repeat event carries dur (s), speed (the multiplier), fast (speed >= 1 + fastAt *
// fastBonus: the FAST tag), best (the line's best time before this one, s; 0 = none) and newBest; the record keeps bd.
// [P5-F design #4 / UX #5] speed pays on the whole street: with tuning.bankBonus a timed named line's multiplier k also pays
// (k - 1) x the pts of its own micros flown since its pre-gate (the event's `bonus`), and those micros score x1 themselves
// (their events still carry dur / fast); Seoul sets fastBonus 1.0 (x2 at par). tuning.fastPar: FAST only within par x fastPar.
// [P6-F design #2 / ux #3] the opening's grace: with tuning.clipGrace > 0, in the first clipT s of a take the `first` line's
// gates also count a pass up to clipGrace m outside their edges; a move that used the grace scores x1 (no FLOW, CLEAN or
// speed multiplier) as CLIPPED (event clipped: true) but is flown: it adds its FLOW and keeps the chain, so one 9 cm miss
// under the stage no longer costs the whole street its x2 (phase 5: sharp short p25 50.7k < careful 52.3k).
// [P6-F design #5 / ux #1] a line flagged `blocked` (lines.json: unflyable for now, STATION STAIRS) is never guided to:
// nextHint skips it at every rule; lineList carries `blocked` for the UI's brackets and grid. It still scores if flown.
// No three.js import: plain vector maths, runs headless in node too.

export const TAKE_TUNING = {
  bankT: 5.0,          // s without a line (or structure within holdZone) before the chain banks
  holdZone: 2.0,       // m from structure: flying faster than skimSpeed this close keeps the chain alive (no points)
  cutT: 3.0,           // s of hands-off hover that ends the take
  cutShow: 1.0,        // s of hover before the CUT countdown shows (cutIn > 0)
  cutSpeed: 1.0,       // m/s: slower than this is a hover
  cutGate: 4.0,        // s after crossing any pre-gate during which no CUT fires
  landT: 0.6,          // s sat on a floor (touchdown) that CUTs at once
  landSpeed: 0.5,      // m/s
  landNy: 0.7,         // contact normal y: a floor, not a wall
  flowMax: 8,
  repeat: 0.25,        // share of pts for a line already flown this take
  cutMult: 1.5,        // a CUT banks the live chain at x1.5
  scrapeV: 2.5,        // m/s impact short of a crash: SCRAPE, FLOW -1
  scrapeCool: 0.6,     // s: one scrape per contact, not one per bounce
  cleanMult: 1.25,     // a line flown with no contact since the previous line (or the take start)
  skimRate: 100,       // pts/s at contact distance, flat (no FLOW)
  skimZone: 1.4,       // m from solid geometry (cinewhoop: 0.9)
  skimSpeed: 4,        // m/s
  carveSpeed: 1.5,     // m/s horizontal: a turn carve only reads the flight path faster than this
  carveGap: 1.0,       // s out of a carve's zone before its sweep resets
  cooldown: 1.5,       // s before the same line can fire again
  teleport: 25,        // m in one update = a reset/teleport, not flight
  stars: [60000, 180000, 325000],  // 1 / 2 / 3 stars: design r4 #1's 60k/160k/290k scaled by the +12 % the r5 micros add at the top
  idleSpeed: 2.0,      // m/s: the hold zone only counts faster than this; slower, the bank timer runs at idleSlow
  idleSlow: 0.4,       // bank-timer rate below idleSpeed with hands on (a crawl banks in 12.5 s, not never)
  pace: [45, 90, 1.5], // PACE at CUT: x1.5 when the last new line is at <= 45 s take time, x1.0 at >= 90 s (linear)
  skimNear: 5.0,       // s after a line during which skimming pays
  sameT0: 0.06,        // s: two lines whose t0 agree this closely share one clip caption (the bigger one)
  hintVert: 3.0,       // m: nextHint gives vert ('down' | 'up') instead of an arrow when the target is this close across
  viaR: 3.0,           // m: default radius around a via point (across) inside which the hint moves on to the gate
  // [P2-F1] off for bando (its numbers above stay bit-exact); a level turns them on in its lines.json `tuning`
  armHold: false,      // UX #2: true = the bank timer stops while a line is armed (pre-gate crossed, window open)
  firstR: Infinity,    // m: nextHint's "first line of a new profile" rule only within this of world.takeStart
  headsCost: 1,        // FLOW lost to a pedestrian contact (world.movers, flight.js moverN): SCRAPE + HEADS!
  microFlow: 1,        // FLOW a new micro-line adds (bando: 1, like a line; a level dense with micros: 0, they keep the chain)
  // [P4-F1] (bando has no movers and no `par`: its numbers stay bit-exact)
  headsGrace: 1.0,     // s after a HEADS! stamp during which another pedestrian contact is the same cluster (design #2, UX #5)
  fastBonus: 0.5,      // design #3: a line with `par` scores up to x(1 + fastBonus) when flown at par
  fastAt: 0.5,         // the FAST tag from this share of fastBonus up (x1.25)
  timed: false,        // UX #6: line events carry the move's time and best (dur, best, newBest) for lines with a pre-gate
  // [P5-F] (bando has no `par`: off / unused there)
  bankBonus: false,    // design #4: a timed named line's speed multiplier also pays on the micros flown along it since its pre-gate
                       // (its segments and features: seg / on = its name), and those micros take no speed multiplier of their own
  slowPar: 0,          // design #4: > 0: the speed multiplier is x1 from dur = par x slowPar (not the end of the window): a
                       // careful 5 m/s pass (par x 1.6 at the 8 m/s par) earns the base, the bonus is for flying fast
  fastPar: 0,          // UX #5: > 0: the FAST tag only at dur <= par x fastPar (0: from fastAt x fastBonus up, phase 4's rule)
  // [P6-F] (bando: off)
  clipGrace: 0,        // design #2: m of grace round the `first` line's gates in the first clipT s of a take (CLIPPED, x1)
  clipT: 20,           // s of take time the grace lasts
  hintVertReady: 3,    // ux #3: nextHint's hintVert while the take is 'ready' (Seoul 6: the DOWN cue at the spawn's descent)
};
const T = TAKE_TUNING;

// [P2-F1] stars against a threshold list (default TAKE_TUNING.stars; a Take passes its level's, take.tuning.stars)
export const starsFor = (pts, stars = T.stars) => stars.reduce((n, s) => n + (pts >= s ? 1 : 0), 0);
// [P2-F1 design #1] a level's tuning ({stars, bankT, holdZone, ...} from lines.json `tuning`, as world.tuning) merged over
// TAKE_TUNING; unknown keys are ignored, so a stale lines.json can't break the take. No tuning: TAKE_TUNING itself.
export function mergeTuning(t) {
  if (!t || typeof t !== 'object') return TAKE_TUNING;
  const o = { ...TAKE_TUNING };
  for (const k of Object.keys(t)) if (k in TAKE_TUNING && typeof t[k] === typeof TAKE_TUNING[k] && (!Array.isArray(TAKE_TUNING[k]) || (Array.isArray(t[k]) && t[k].length === TAKE_TUNING[k].length))) o[k] = t[k];
  return Object.freeze(o);
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// gate: {c, n, w, h, u?}. Width runs along u (default: horizontal, across n), height along n x u.
function compileGate(g) {
  const n = norm(g.n);
  let u = g.u ? g.u.slice() : Math.abs(n[1]) > 0.9 ? [1, 0, 0] : cross([0, 1, 0], n);
  const k = dot(u, n); u = norm([u[0] - n[0] * k, u[1] - n[1] * k, u[2] - n[2] * k]);
  return { c: g.c, n, u, v: cross(n, u), hw: g.w / 2, hh: g.h / 2 };
}
// +1 / -1 if the segment a->b crosses the gate's rectangle along +n / -n, else 0 ([P6-F] m: grace, metres added to each edge)
function crossGate(G, a, b, m = 0) {
  const da = (a.x - G.c[0]) * G.n[0] + (a.y - G.c[1]) * G.n[1] + (a.z - G.c[2]) * G.n[2];
  const db = (b.x - G.c[0]) * G.n[0] + (b.y - G.c[1]) * G.n[1] + (b.z - G.c[2]) * G.n[2];
  let s = 0;
  if (da < 0 && db >= 0) s = 1; else if (da >= 0 && db < 0) s = -1; else return 0;
  const t = da / (da - db);
  const q = [a.x + (b.x - a.x) * t - G.c[0], a.y + (b.y - a.y) * t - G.c[1], a.z + (b.z - a.z) * t - G.c[2]];
  return Math.abs(dot(q, G.u)) <= G.hw + m && Math.abs(dot(q, G.v)) <= G.hh + m ? s : 0;
}
const plainCaption = (s) => String(s || '').replace(/\*/g, '');
// down one of world.funnels' shafts ({c:[x, z], top, r}): within r of the axis, anywhere below its top (its floor
// included: E's `bottom` is where the dive assist lets go, not the floor)
// 'down' funnels only (E4): an 'up' funnel's column includes the hall's ground floor, where a landing must still CUT
const inShaft = (p, world) => (world?.funnels || []).some((f) => f.dir !== 'up' && p.y <= f.top && Math.hypot(p.x - f.c[0], p.z - f.c[1]) < f.r);

// ---- progress, shared by every Take instance (take + free fly): {name: {n: times flown, flow: best FLOW, pts: best pts,
// bestT: best take time (s, stats.time clock) at which it was first flown in a scored take: a split, lower is better;
// bd: [P4-F1] the line's own best time (s, pre-gate to gate) in a scored take, lines with a pre-gate only}}
// [S0] per level: bando keeps the original keys, any other level suffixes them with @<level id> (setProgressLevel)
let LVL = 'bando';
const lk = (base) => (LVL === 'bando' ? base : `${base}@${LVL}`);
let PKEY = 'onetake.lines';
const readProg = () => { try { const o = JSON.parse(globalThis.localStorage?.getItem(PKEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } };
const PROG = readProg();
const saveProg = () => { try { globalThis.localStorage?.setItem(PKEY, JSON.stringify(PROG)); } catch (e) {} };
export function resetProgress() {
  for (const k of Object.keys(PROG)) delete PROG[k];
  try { for (const k of [PKEY, lk('onetake.best'), lk('onetake.perfect')]) globalThis.localStorage?.removeItem(k); } catch (e) {}
}
// [S0] switch the progress store (lines flown, best take, perfects) to level `id`; Take instances then reloadBest()
export function setProgressLevel(id) {
  LVL = id || 'bando'; PKEY = lk('onetake.lines');
  for (const k of Object.keys(PROG)) delete PROG[k];
  Object.assign(PROG, readProg());
}
export const progressLevel = () => LVL;

export class Take {
  constructor({ free = false } = {}) {
    this.free = free;              // free fly: lines still fire (captions, pts 0), no scoring, no take end
    this._best = 0;
    this.reloadBest();
    this._src = null; this._lines = []; this._carves = []; this._T = TAKE_TUNING; this._tsrc = null; this._psrc = null;
    this.ghost = null;             // C12: a ghost.js Ghost (main.js / GhostKeeper sets it); survives reset()
    this.reset();
  }
  reloadBest() { this._best = 0; try { this._best = +globalThis.localStorage?.getItem(lk('onetake.best')) || 0; } catch (e) {} }   // [S0] per level
  get state() { return this._state; }
  get total() { return Math.round(this._total); }
  get flow() { return this._flow; }                       // the multiplier the next line will score at
  get unbanked() { return Math.round(this._unbanked); }
  get best() { return Math.max(this._best, this._state === 'done' ? 0 : Math.round(this._total)); }
  get bankIn() { return this._unbanked > 0 ? Math.max(0, this._T.bankT - this._idle) : 0; }   // s until the chain banks (0: no chain)
  get holding() { return this._holding; }                 // the chain is being kept alive by proximity right now
  // CUT countdown: s until the CUT fires while its ring shows (>= cutShow s of hover, or a touchdown), else 0
  get cutIn() { return this._cutIn; }
  get cutFrac() { return this._cutFrac; }                 // 0..1 ring fill (1 = CUT)
  get cutKind() { return this._cutKind; }                 // 'hover' | 'land' | null
  get stars() { return starsFor(this._total, this._T.stars); }           // of the banked total (0-3, take.tuning.stars)
  // [P2-F1] the tuning in force (TAKE_TUNING merged with world.tuning at the last update / lineList): the UI reads its
  // stars, bankT and cutT from here (TAKE_TUNING is bando's)
  get tuning() { return this._T; }
  // [P2-F1 UX #2] the line in progress: its pre-gate crossed the right way and its window (`within`) still open; a named
  // line before a micro (a street's segments arm and fire under its named line), then the most recently armed:
  // {name, caption, left (s to its main gate), within (s), frac (0..1 of the window used), repeat (already flown this
  // take), micro, t (s since its pre-gate), par (s, a timed line's), best (s, its best time; 0 = none)} or null. The OSD
  // shows "HONGIK-RO · 0:18". With tuning.armHold the bank timer waits while any is armed.
  get armed() {
    let best = null;
    for (const [k, r] of this._pre) {
      const L = this._lines[(k / 8) | 0]; if (!L || (!L.l.two && r.s !== 1)) continue;
      const within = L.l.within ?? 6, left = within - (this._now - r.t), named = !L.l.micro;
      if (left > 0 && (!best || (named && !best.named) || (named === best.named && r.t > best.t))) best = { t: r.t, L, within, left, named };
    }
    if (!best || this._state === 'done') return null;
    const l = best.L.l;
    return { name: l.name, caption: l.caption || l.name, left: +best.left.toFixed(2), within: best.within, frac: +Math.min(1, 1 - best.left / best.within).toFixed(3), repeat: this._done.has(l.name), micro: !!l.micro,
      t: +(this._now - best.t).toFixed(2), par: l.par || 0, best: PROG[l.name]?.bd || 0 };
  }
  // [P3-F1] a HEADS! voids the armed moves of `heads` lines: their pre-gate records go; returns their names
  _voidHeads() {
    const out = [];
    for (const [k, r] of this._pre) { const L = this._lines[(k / 8) | 0]; if (!L || !L.l.heads) continue; this._pre.delete(k); if (!out.includes(L.l.name)) out.push(L.l.name); }
    return out;
  }
  _armedAny() {
    for (const [k, r] of this._pre) { const L = this._lines[(k / 8) | 0]; if (L && (L.l.two || r.s === 1) && this._now - r.t < (L.l.within ?? 6)) return true; }
    return false;
  }
  // PACE: the multiplier a CUT now would apply to the live chain (on top of cutMult), from the take time of the last
  // new (non-repeat) line: x1.5 up to pace[0] s, x1.0 from pace[1] s. 1 with no line yet. Rounded to 0.01.
  get pace() {
    let lastT = null; for (let i = this._log.length - 1; i >= 0; i--) if (!this._log[i].repeat) { lastT = this._log[i].t; break; }
    if (lastT === null) return 1;
    const [p0, p1, pm] = this._T.pace, f = Math.min(1, Math.max(0, (p1 - lastT) / (p1 - p0)));
    return Math.round((1 + (pm - 1) * f) * 100) / 100;
  }
  get cutValue() { return Math.round(this._unbanked * this._T.cutMult * this.pace); }   // what a CUT now would bank
  // C12 PERFECT: this take ended in a CUT at 3 stars with every line (repeats too) CLEAN and 0 SCRAPEs
  get perfect() { return this._state === 'done' && this._how === 'cut' && this._perfectSoFar() && starsFor(this._total, this._T.stars) === 3; }
  // still on for PERFECT (live: no SCRAPE and nothing but CLEAN lines yet, at least one line): a HUD may tint gold
  get perfectLive() { return this._state === 'live' && this._perfectSoFar(); }
  _perfectSoFar() { return this._log.length > 0 && this._scrapes === 0 && this._log.every((l) => l.clean); }
  get stats() {
    return { maxSpeed: this._maxSpeed, time: this._t, lines: this._log.slice(), maxFlow: this._maxFlow, stars: starsFor(this._total, this._T.stars),
      scrapes: this._scrapes, clean: this._log.filter((l) => l.clean).length, perfect: this.perfect };
  }
  // C12 ghost: the attached Ghost's pose at this take's clock ({pos:[x,y,z], q:[x,y,z,w], heading, t, done, crashed}),
  // alpha = main.js physAlpha (the render sits between the last two ticks, like the drone). While ready: the ghost's
  // take-start pose. null with no ghost, after the take, or when the ghost can't be shown (another world).
  ghostPose(alpha = 1) {
    const g = this.ghost; if (!g || this.free || this._state === 'done') return null;
    return g.pose(this._state === 'live' ? this._t : 0, this._state === 'live' ? alpha : 1);
  }

  reset() {
    this._state = 'ready'; this._t = 0; this._total = 0; this._unbanked = 0; this._flow = 1; this._idle = 0;
    this._hover = 0; this._land = 0; this._gndAgo = 9; this._maxSpeed = 0; this._maxFlow = 1; this._log = []; this._done = new Set(); this._lastName = null;
    this._cool = {}; this._pre = new Map(); this._preT = -99; this._last = null; this._released = false; this._skim = 0; this._skimOff = 0;
    this._now = 0; this._holding = false; this._cutIn = 0; this._cutFrac = 0; this._cutKind = null;
    this._dirty = false; this._bonusEv = {}; this._imp = null; this._mvN = null; this._scrapeT = -99; this._headsT = -99; this._scrapes = 0; this._skimAcc = 0; this._lineAt = -99; this._how = null;
    for (const C of this._carves || []) C.st.forEach((s) => { s.ref = null; s.acc = 0; s.out = 0; });
  }
  // the take ends the hard way (out of bounds, a reset mid-take): same as a crash
  fail() {
    if (this.free || this._state !== 'live') return [];
    return this._end('crash');
  }

  // [P2-F1] world.tuning (lines.json `tuning`) merges over TAKE_TUNING; a world loader that passes only lines[] still
  // gets it from the line that carries a copy (lines.mjs stamps it on the `first` line). A line with `piece` (one of E's
  // set pieces) is skipped unless world.setPieces holds that id (lines are coded against the ids before the pieces exist).
  _compile(world) {
    const tun = world.tuning || (Array.isArray(world.lines) && world.lines.find((l) => l && l.tuning)?.tuning) || null, sp = world.setPieces || null;
    if (this._tsrc !== tun) { this._tsrc = tun; this._T = mergeTuning(tun); }
    if (this._src === world.lines && this._psrc === sp) return;
    this._src = world.lines; this._psrc = sp;
    const has = new Set((sp || []).map((p) => p && p.id));
    const all = (world.lines || []).filter((l) => !l.piece || has.has(l.piece));
    this._ord = null; this._lines = all.filter((l) => !l.carve).map((l) => ({ l, main: compileGate(l), pre: (l.pre || []).map(compileGate) }));
    this._carves = all.filter((l) => l.carve).map((l) => ({ l, st: (l.carve.axes || [0]).map(() => ({ ref: null, acc: 0, out: 0, t0: 0 })) }));
    this._names = [...new Map(all.map((l) => [l.name, l])).values()]; this._blocked = null;
    this._pre = new Map();
  }

  update(dt, drone, world, sticks) {
    const ev = [];
    const H = typeof sticks === 'object' && sticks ? sticks : { hands: !!sticks, moved: !!sticks, steer: false };
    const hands = !!(H.hands ?? H.moved), moved = !!(H.moved ?? H.hands), steer = !!H.steer;
    this._now += dt;
    if (world) this._compile(world);
    const p = drone.pos, spd = Math.hypot(drone.vel.x, drone.vel.y, drone.vel.z);
    const hit = this._contact(drone);                     // {touch, impact, floor}: this frame's contact, read every state
    if (this.free) { this._t += dt; this._gates(p, drone, ev, dt); return ev; }

    if (this._state === 'done') {
      // after a CUT: let go, then touch a stick and a new take starts from where you are
      if (!moved) this._released = true;
      if (!(this._released && moved && !drone.crashed)) { this._last = { x: p.x, y: p.y, z: p.z }; return ev; }
      this.reset(); this._imp = drone.lastImpact ?? null;
    }
    if (this._state === 'ready') {
      if (!moved || drone.crashed) { this._last = { x: p.x, y: p.y, z: p.z }; return ev; }
      this._state = 'live'; this._dirty = false; ev.push({ type: 'start' });
    }
    // live (hands off, the bank timer waits: letting go settles into a CUT, which banks the chain at x1.5; hands on below
    // idleSpeed it runs at idleSlow)
    this._t += dt; if (hands && !(this._T.armHold && this._armedAny())) this._idle += spd > this._T.idleSpeed ? dt : dt * this._T.idleSlow;
    this._maxSpeed = Math.max(this._maxSpeed, spd);
    if (drone.crashed) { ev.push(...this._end('crash', 'hover', drone.crashBy)); return ev; }
    if (hit.touch) this._dirty = true;
    // [P2-F1 design #5] a pedestrian (world.movers via flight.js: drone.moverN counts contacts, moverKind says with what)
    // is a SCRAPE at any speed, captioned HEADS!; it takes the scrape cooldown so the bump isn't counted twice
    // [P4-F1 design #2 / UX #5] one stamp per contact cluster: within headsGrace of the last stamp a contact is the same
    // bump (phase 3: two HEADS! 0.7 s apart cost 2 FLOW in BAR ALLEY); it still voids an armed `heads` line
    if (hit.mover === 'pedestrian') {
      this._dirty = true;
      if (this._now - this._headsT >= this._T.headsGrace && this._now - this._scrapeT >= this._T.scrapeCool) {
        this._scrapeT = this._now; this._headsT = this._now; this._scrapes++;
        const lost = Math.min(this._flow - 1, this._T.headsCost); this._flow -= lost;
        const voids = this._voidHeads();
        ev.push({ type: 'scrape', impact: +(+drone.moverImpact || 0).toFixed(2), flow: this._flow, lost, heads: true, ...(voids.length ? { voids } : {}) });
      } else {
        const voids = this._voidHeads();
        if (voids.length) ev.push({ type: 'void', voids, heads: true });
      }
    }
    if (hit.impact > this._T.scrapeV && !hit.floor && this._now - this._scrapeT >= this._T.scrapeCool) {
      this._scrapeT = this._now; this._scrapes++;
      const lost = this._flow > 1 ? 1 : 0; this._flow -= lost;
      ev.push({ type: 'scrape', impact: +hit.impact.toFixed(2), flow: this._flow, lost });
    }
    this._gates(p, drone, ev, dt);
    this._skimTick(dt, drone, world, spd, ev);
    // bank
    if (this._unbanked > 0 && this._idle >= this._T.bankT) {
      const pts = Math.round(this._unbanked); this._total += pts; this._unbanked = 0; this._flow = 1;
      ev.push({ type: 'bank', pts, total: this.total });
    }
    // CUT: hands off and hovering, or sat on a floor; only with something to show and not just after a pre-gate.
    // No touchdown CUT down a shaft (world.funnels): a full dive lands on the chimney floor / a stairwell landing.
    const canCut = this._total + this._unbanked > 0 && this._now - this._preT >= this._T.cutGate;
    this._gndAgo = hit.floor ? 0 : this._gndAgo + dt;
    const shaft = inShaft(p, world);
    this._hover = canCut && !hands && spd < this._T.cutSpeed && !shaft ? this._hover + dt : 0;
    this._land = canCut && !steer && this._gndAgo < 0.15 && spd < this._T.landSpeed && !shaft ? this._land + dt : 0;
    this._cutIn = 0; this._cutFrac = 0; this._cutKind = null;
    if (this._land > 0) { this._cutIn = Math.max(0, this._T.landT - this._land); this._cutFrac = Math.min(1, this._land / this._T.landT); this._cutKind = 'land'; }
    if (this._hover >= this._T.cutShow && (!this._cutKind || this._T.cutT - this._hover < this._cutIn)) {
      this._cutIn = Math.max(0, this._T.cutT - this._hover); this._cutFrac = Math.min(1, (this._hover - this._T.cutShow) / (this._T.cutT - this._T.cutShow)); this._cutKind = 'hover';
    }
    if (this._hover >= this._T.cutT || this._land >= this._T.landT) ev.push(...this._end('cut', this._land >= this._T.landT ? 'land' : 'hover'));
    return ev;
  }

  // contact this frame: touch = any contact normal or a new impact; impact = its speed (m/s); floor = an up-facing contact.
  // A new impact shows as drone.lastImpact changing (set on every impact > 0.4 m/s), so several physics ticks per update
  // still register; drone.contactN is the last tick's summed contact normal.
  _contact(drone) {
    const out = { touch: false, impact: 0, floor: false, mover: null };
    const mn = drone.moverN;                              // [P2-F1] a new contact with a world.movers body
    if (mn !== undefined) { if (this._mvN !== null && mn !== this._mvN) { out.mover = drone.moverKind || 'vehicle'; out.touch = true; } this._mvN = mn; }
    const li = drone.lastImpact;
    if (li !== undefined) { if (this._imp !== null && li !== this._imp && li > 0) { out.impact = li; out.touch = true; } this._imp = li; }
    const n = drone.contactN;
    if (n) {
      const l = Math.hypot(n.x, n.y, n.z);
      if (l > 1e-6) { out.touch = true; out.floor = n.y / l > this._T.landNy; }
    }
    return out;
  }

  _gates(p, drone, ev, dt) {
    const a = this._last; this._last = { x: p.x, y: p.y, z: p.z };
    if (!a) return;
    if (Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) > this._T.teleport) { this._carveReset(); return; }
    const now = this._now;
    // [P6-F design #2] the opening's grace: the `first` line, in the first clipT s of a scored take
    const cg = !this.free && this._T.clipGrace > 0 && this._t <= this._T.clipT ? this._T.clipGrace : 0;
    // pre-gates first (a fast pass can cross a pre-gate and its line in the same frame)
    this._lines.forEach((L, li) => L.pre.forEach((G, gi) => { let s = crossGate(G, a, p), clip = false;
      if (!s && cg && L.l.first) { s = crossGate(G, a, p, cg); clip = !!s; }
      if (s) { this._pre.set(li * 8 + gi, clip ? { t: now, s, clip } : { t: now, s }); this._preT = now; } }));
    // [P5-F] under bankBonus a street's micros are scored before the named lines in the same frame (its last segment ends
    // on the street's own gate, so the street pays on it too); otherwise the lines' order (bando bit-exact)
    const order = this._T.bankBonus ? (this._ord ||= [...this._lines.keys()].sort((x, y) => (this._lines[y].l.micro ? 1 : 0) - (this._lines[x].l.micro ? 1 : 0) || x - y)) : null;
    (order ? order.map((li) => [this._lines[li], li]) : this._lines.map((L, li) => [L, li])).forEach(([L, li]) => {
      let s = crossGate(L.main, a, p), clip = false;
      if (!s && cg && L.l.first) { s = crossGate(L.main, a, p, cg); clip = !!s; }
      if (!s || (!L.l.two && s < 0)) return;
      let t0 = now;
      if (L.pre.length) {
        let rec = null;
        L.pre.forEach((_, gi) => { const r = this._pre.get(li * 8 + gi); if (r && now - r.t <= (L.l.within ?? 6) && r.s === (L.l.two ? s : 1) && (!rec || r.t < rec.t)) rec = r; });
        if (!rec) return;
        t0 = rec.t; if (rec.clip) clip = true;
        L.pre.forEach((_, gi) => this._pre.delete(li * 8 + gi));
      }
      const e = this._award(L.l, now, t0, clip);
      if (e) ev.push(e);
    });
    for (const C of this._carves) {
      const t0 = this._carveTick(C, p, drone, dt, now);
      if (t0 !== null) { const e = this._award(C.l, now, t0); if (e) ev.push(e); }
    }
  }

  // a carve's sweep: around an axis (orbit: the angle the position sweeps round it) or of the flight path (turn: the
  // change of the horizontal velocity's direction), signed, while inside the zone and moving; returns t0 when it fires
  // (a turn only reads the path while it is faster than carveSpeed: a slow pivot neither counts nor resets it; leaving
  // the zone for carveGap s resets either kind)
  _carveTick(C, p, drone, dt, now) {
    const K = C.l.carve, vx = drone.vel.x, vz = drone.vel.z, fast = Math.hypot(vx, vz) > this._T.carveSpeed;
    let fired = null;
    C.st.forEach((s, k) => {
      let inZone = false, ang = null;
      if (K.kind === 'orbit') {
        const [ax, az] = K.axes[k], dx = p.x - ax, dz = p.z - az;
        const f = Math.min(1, Math.max(0, (p.y - K.y0) / ((K.y1 - K.y0) || 1))), rMax = K.r0 + (K.r1 - K.r0) * f;
        const rMin = (K.in0 ?? 0) + ((K.in1 ?? K.in0 ?? 0) - (K.in0 ?? 0)) * f, d = Math.hypot(dx, dz);   // outside the wall (not in the flue)
        if (p.y >= K.y0 && p.y <= K.y1 && d <= rMax && d >= rMin) { inZone = true; ang = Math.atan2(dx, dz); }
      } else if (K.kind === 'turn') {
        const b = K.box;
        if (p.x >= b[0] && p.x <= b[1] && p.y >= b[2] && p.y <= b[3] && p.z >= b[4] && p.z <= b[5]) { inZone = true; if (fast) ang = Math.atan2(vx, vz); }
      }
      if (!inZone) { s.out += dt; if (s.out > this._T.carveGap) { s.ref = null; s.acc = 0; } return; }
      s.out = 0;
      if (ang === null) return;
      if (s.ref === null) { s.ref = ang; s.acc = 0; s.t0 = now; }
      else { s.acc += wrap(ang - s.ref); s.ref = ang; }
      if (Math.abs(s.acc) >= K.sweep) { if (fired === null || s.t0 < fired) fired = s.t0; s.ref = null; s.acc = 0; }
    });
    return fired;
  }
  _carveReset() { for (const C of this._carves) C.st.forEach((s) => { s.ref = null; s.acc = 0; s.out = 0; }); }

  // events carry t0 = take time (s, the clock of stats.time) of the move's start (its pre-gate / the carve's start),
  // ago = s from then to now (the replay frame to caption is the event's wall time - ago), t = take time now
  _award(l, now, t0, clip = false) {
    const name = l.name, caption = l.caption || name, micro = !!l.micro;
    if (now - (this._cool[name] ?? -99) < this._T.cooldown) return null;
    const ago = +Math.max(0, now - t0).toFixed(3), tt = +this._t.toFixed(2), tt0 = +Math.max(0, this._t - ago).toFixed(2);
    const rec = (PROG[name] ||= { n: 0, flow: 0, pts: 0 });
    if (this.free) {
      this._cool[name] = now; rec.n++; saveProg();
      return { type: 'line', name, caption, pts: 0, flow: 1, free: true, micro, t0: tt0, ago, t: tt };
    }
    const clean = !this._dirty && !clip; this._dirty = false;
    const cm = clean ? this._T.cleanMult : 1;
    // [P4-F1 design #3 / UX #6] a timed move (pre-gate to gate): its time, the best before it, and with `par` the speed bonus
    const tm = this._timed(l, rec, ago);
    if (clip) { tm.k = 1; tm.ev = { ...tm.ev, clipped: true }; tm.log = { ...tm.log, clipped: true }; }   // [P6-F] CLIPPED: x1
    if (this._done.has(name)) {
      if (this._lastName === name) return null;                     // fly something else first
      this._cool[name] = now;
      const pts = Math.round((l.pts || 0) * this._T.repeat * cm * tm.k) + this._bankBonus(l, tm.k, tt0);
      this._unbanked += pts; this._idle = 0; this._lastName = name; this._lineAt = now;
      const e = this._dedupe({ type: 'repeat', name, caption, pts, clean, micro, t0: tt0, ago, t: tt, ...tm.ev, ...this._bonusEv });
      this._log.push({ name, pts, t: tt, t0: tt0, flow: 1, repeat: true, clean, micro, ...(micro && (l.seg || l.on) ? { of: l.seg || l.on } : {}), ...tm.log });
      rec.n++; saveProg();
      return e;
    }
    this._cool[name] = now;
    const flow = this._flow, pts = Math.round((l.pts || 0) * (clip ? 1 : flow) * cm * tm.k) + this._bankBonus(l, tm.k, tt0);
    this._unbanked += pts; this._idle = 0; this._lastName = name; this._done.add(name); this._lineAt = now;
    this._flow = Math.min(this._T.flowMax, flow + (micro ? this._T.microFlow : 1)); this._maxFlow = Math.max(this._maxFlow, flow);
    const e = this._dedupe({ type: 'line', name, caption, pts, flow, clean, micro, t0: tt0, ago, t: tt, ...tm.ev, ...this._bonusEv });
    this._log.push({ name, pts, t: tt, t0: tt0, flow, clean, micro, ...(micro && (l.seg || l.on) ? { of: l.seg || l.on } : {}), ...tm.log });
    rec.n++; rec.flow = Math.max(rec.flow, flow); rec.pts = Math.max(rec.pts, pts);
    if (!(rec.bestT > 0) || tt < rec.bestT) rec.bestT = tt;
    saveProg();
    return e;
  }
  // with tuning.timed (or a `par`), a line with a pre-gate is a timed move: dur = ago (s); with `par` (and its window
  // `within`) the speed multiplier k. Updates the record's best time (rec.bd). Bando (not timed, no `par`): nothing, so its
  // events keep their shape. -> {k, ev: fields for the event, log: fields for stats.lines}
  _timed(l, rec, ago) {
    if (!l.pre || !l.pre.length || !(this._T.timed || l.par > 0)) return { k: 1, ev: {}, log: {} };
    const dur = +ago.toFixed(2), best = rec.bd > 0 ? rec.bd : 0, newBest = !(best > 0) || dur < best;
    if (newBest && dur > 0) rec.bd = dur;
    const W = l.within ?? 6, par = +l.par || 0;
    let k = 1;
    const W0 = this._T.slowPar > 0 ? Math.min(W, par * this._T.slowPar) : W;   // [P5-F] where the bonus starts
    if (par > 0 && W0 > par) k = 1 + this._T.fastBonus * Math.min(1, Math.max(0, (W0 - dur) / (W0 - par)));
    k = Math.round(k * 100) / 100;
    const fast = par > 0 && (this._T.fastPar > 0 ? dur <= par * this._T.fastPar + 1e-9 : k >= 1 + this._T.fastAt * this._T.fastBonus - 1e-9);
    // [P5-F design #4] a street's micro takes no multiplier of its own under bankBonus: its named line pays on it
    if (this._T.bankBonus && l.micro && (l.seg || l.on)) k = 1;
    return { k, ev: { dur, best, newBest, ...(par > 0 ? { par, speed: k, fast } : {}) }, log: { dur, ...(par > 0 ? { speed: k, fast } : {}) } };
  }
  // [P5-F design #4] with bankBonus, a timed named line (k > 1) pays (k - 1) x the pts of its own micros (log `of` = its
  // name) flown since its pre-gate (t0, take time); sets this._bonusEv ({bonus} or {}) for the event
  _bankBonus(l, k, t0) {
    this._bonusEv = {};
    if (!this._T.bankBonus || l.micro || !(k > 1) || !l.pre?.length) return 0;
    let sum = 0; for (let i = this._log.length - 1; i >= 0; i--) { const o = this._log[i]; if (o.t0 < t0 - 0.05) break; if (o.of === l.name) sum += o.pts; }
    const b = Math.round(sum * (k - 1)); if (b > 0) this._bonusEv = { bonus: b };
    return b;
  }
  // two lines that began at the same moment (CHIMNEY DIVE's pre-gate is DROP IN's gate; THREAD THE NEEDLE's is THE
  // SMALL GAP's) would be captioned one frame apart in the clip. The later event says which caption the clip keeps:
  // sameT0 = the earlier line's name, clip = 'replace' (this one is worth at least as much: it takes the earlier
  // caption's frame) or 'skip' (no clip caption for this one). The live HUD shows both as they fire.
  _dedupe(e) {
    for (let i = this._log.length - 1; i >= 0; i--) {
      const o = this._log[i];
      if (o.t0 < e.t0 - 1) break;
      if (Math.abs(o.t0 - e.t0) <= this._T.sameT0 && o.name !== e.name) { e.sameT0 = o.name; e.clip = e.pts >= o.pts ? 'replace' : 'skip'; break; }
    }
    return e;
  }

  // the proximity query runs at most every 1/60 s on the accumulated dt (take.update may be called per 1/240 s tick)
  _skimTick(dt, drone, world, spd, ev) {
    this._skimAcc += dt;
    if (this._skimAcc < 1 / 60 - 1e-9) return;
    dt = this._skimAcc; this._skimAcc = 0;
    const bvh = world?.skimBvh;
    let on = false; this._holding = false;
    if (bvh && this._unbanked > 0 && spd > this._T.idleSpeed) {
      const r = drone.c?.radius ?? 0.12, zone = drone.key === 'cinewhoop' ? 0.9 : this._T.skimZone, qz = Math.max(zone, this._T.holdZone);
      const res = bvh.closestPointToPoint(drone.pos, this._cp || (this._cp = {}), 0, qz + r);
      const gap = res && res.distance <= qz + r ? res.distance - r : Infinity;
      if (gap < this._T.holdZone) { this._idle = 0; this._holding = true; }
      if (gap < zone && spd > this._T.skimSpeed && this._now - this._lineAt <= this._T.skimNear) { const c = 1 - Math.max(0, gap) / zone; const pts = this._T.skimRate * c * c * dt; this._unbanked += pts; this._skim += pts; this._idle = 0; on = true; }
    }
    this._skimOff = on ? 0 : this._skimOff + dt;
    if (!on && this._skim > 0 && this._skimOff > 0.4) { if (this._skim >= 10) ev.push({ type: 'skim', pts: Math.round(this._skim) }); this._skim = 0; }
  }

  _end(kind, how = 'hover', by = null) {
    const ev = [];
    if (kind === 'crash') {
      const lost = Math.round(this._unbanked);
      if (lost > 0) ev.push({ type: 'lost', pts: lost });
      this._unbanked = 0;
      this._how = 'crash'; this._finish();
      // by: what the quad hit when it was a world.movers body (drone.crashBy: 'bus', 'taxi', ... 'pedestrian')
      ev.push({ type: 'crash', total: this.total, stats: this.stats, lost, stars: starsFor(this._total, this._T.stars), ...(by ? { by } : {}) });
    } else {
      const pace = this.pace, pts = Math.round(this._unbanked * this._T.cutMult * pace);
      this._total += pts; this._unbanked = 0;
      if (pts > 0) ev.push({ type: 'bank', pts, total: this.total, cut: true, pace });
      this._how = 'cut'; this._finish();
      const perfect = this.perfect;
      if (perfect) { try { const L = globalThis.localStorage; L?.setItem(lk('onetake.perfect'), String((+L.getItem(lk('onetake.perfect')) || 0) + 1)); } catch (e) {} }
      ev.push({ type: 'cut', total: this.total, stats: this.stats, pts, how, pace, stars: starsFor(this._total, this._T.stars), perfect });
    }
    return ev;
  }
  _finish() {
    this._state = 'done'; this._flow = 1; this._released = false; this._skim = 0;
    this._hover = 0; this._land = 0; this._cutIn = 0; this._cutFrac = 0; this._cutKind = null; this._holding = false;
    if (this._total > this._best) { this._best = Math.round(this._total); try { globalThis.localStorage?.setItem(lk('onetake.best'), String(this._best)); } catch (e) {} }
  }

  // ---- discovery
  // every line once, in world order: [{name, caption, pts, micro, flown (ever), n, bestFlow, bestPts, bestT (s, best take
  // time it was first reached at in a scored take; 0 = never), bestDur (s, [P4-F1] its own best time, pre-gate to gate;
  // 0 = none), par (s, a timed line's; 0 = none), inTake}]
  lineList(world) {
    if (world) this._compile(world);
    return (this._names || []).map((l) => { const r = PROG[l.name]; return { name: l.name, caption: l.caption || l.name, pts: l.pts || 0, micro: !!l.micro,
      flown: !!r?.n, n: r?.n || 0, bestFlow: r?.flow || 0, bestPts: r?.pts || 0, bestT: r?.bestT || 0, bestDur: r?.bd || 0, par: l.par || 0, inTake: this._done.has(l.name), ...(l.blocked ? { blocked: true } : {}) }; });
  }
  // {flown, total}: named lines (not micro) ever flown; micro: the same for micro-lines; best: best take; stars: its stars;
  // perfects: PERFECT takes ever
  progress(world) {
    const L = this.lineList(world), main = L.filter((l) => !l.micro), mic = L.filter((l) => l.micro);
    return { flown: main.filter((l) => l.flown).length, total: main.length, micro: { flown: mic.filter((l) => l.flown).length, total: mic.length },
      best: this.best, stars: starsFor(this.best, this._T.stars), perfects: (() => { try { return +globalThis.localStorage?.getItem(lk('onetake.perfect')) || 0; } catch (e) { return 0; } })() };
  }
  // The line to fly next and where to point: {name, caption, pos:[x,y,z] (the point to steer at), dist (m to pos),
  // bearing (rad from the nose, + = right), elev (rad above level), fresh (never flown), vert ('down' | 'up' | null:
  // show a down / up triangle instead of the arrow), stage ('via' | 'gate' | 'main'), inProgress} or null.
  // Which line, in order:
  //   1. a line in progress: its pre-gate was crossed the right way (within its `within`) -> its main gate (stage 'main')
  //   1b. within hint.r (default 6) m of a world.startPoints entry whose hint names `next`: that line (the arrow agrees
  //       with the hint)
  //   2. on a profile that has never flown a named line, the line flagged `first` in world.lines (the one the
  //      onboarding toast names)
  //   3. the nearest line never flown, else the nearest not yet flown this take (route length through its via)
  // Where: a line's first gate, or before that its `via` [{p:[x,y,z], r?, unless?:[x0,x1,y0,y1,z0,z1]}] (in order; a
  // via is skipped once within r (default viaR) of it across, or while inside its `unless` box, from where the gate is
  // straight ahead). vert: the target is under hintVert m away across and over 1 m above/below (in progress: also when
  // it is steep, across < half the drop, e.g. the door at the bottom of the chimney seen from the mouth).
  // Named lines only (micro-lines are never hinted).
  nextHint(drone, world) {
    if (world) this._compile(world);
    const p = drone.pos, now = this._now;
    const blk = this._blocked || (this._blocked = new Set((this._names || []).filter((l) => l.blocked).map((l) => l.name)));
    const eligible = (n) => (blk.has(n) ? 0 : !PROG[n]?.n ? 1 : !this._done.has(n) ? 2 : 0);    // 1 fresh, 2 not this take, 0 no ([P6-F] or blocked)
    const d3 = (c) => Math.hypot(c[0] - p.x, c[1] - p.y, c[2] - p.z);
    // where to steer for line L's first gate G: [target, stage, route length]
    const aim = (L, G) => {
      for (const v of L.l.via || []) {
        const q = v.p || v, u = v.unless;
        if (Math.hypot(q[0] - p.x, q[2] - p.z) < (v.r ?? this._T.viaR)) continue;
        if (u && p.x >= u[0] && p.x <= u[1] && p.y >= u[2] && p.y <= u[3] && p.z >= u[4] && p.z <= u[5]) continue;
        return [q, 'via', d3(q) + Math.hypot(G.c[0] - q[0], G.c[1] - q[1], G.c[2] - q[2])];
      }
      return [G.c, 'gate', d3(G.c)];
    };
    let pick = null;
    // 1. in progress
    this._lines.forEach((L, li) => {
      if (L.l.micro || !L.pre.length) return;
      const el = eligible(L.l.name); if (!el) return;
      L.pre.forEach((_, gi) => {
        const r = this._pre.get(li * 8 + gi);
        if (r && now - r.t <= (L.l.within ?? 6) && (L.l.two || r.s === 1) && (!pick || r.t > pick.t)) pick = { L, tgt: L.main.c, stage: 'main', fresh: el === 1, t: r.t, prog: true };
      });
    });
 // 1b. at a START AT point whose hint names a line to fly from there (hint.next), within hint.r m (default 6; [P4-F1
    // design #4] Seoul's spawn: up to UNDER THE STAGE's pre-gate, so the arrow holds on the stage, not the walking street)
    if (!pick) for (const sp of world?.startPoints || []) {
      const nx = sp.hint?.next, q = sp.pos; if (!nx || !q || !eligible(nx)) continue;
      if (Math.hypot(p.x - (q.x ?? q[0]), p.y - (q.y ?? q[1]), p.z - (q.z ?? q[2])) > (sp.hint.r ?? 6)) continue;
      const L = this._lines.find((x) => x.l.name === nx); if (!L) continue;
      const [tgt, stage] = aim(L, L.pre.length ? L.pre[0] : L.main); pick = { L, tgt, stage, fresh: eligible(nx) === 1 }; break;
    }
    // 2. the first line of a new profile (with tuning.firstR: only within firstR m of world.takeStart; further out, the
    // nearest line: design #4, the guide pointed at WALKING STREET from 393 m away with SCREEN CANYON 10 m ahead)
    const ts = world?.takeStart?.pos, nearStart = !(this._T.firstR < Infinity) || !ts || Math.hypot(p.x - (ts.x ?? ts[0]), p.z - (ts.z ?? ts[2])) <= this._T.firstR;
    if (!pick && nearStart && !this._names?.some((l) => !l.micro && PROG[l.name]?.n)) {
      const L = this._lines.find((x) => x.l.first && !x.l.micro && !blk.has(x.l.name));
      if (L) { const G = L.pre.length ? L.pre[0] : L.main, [tgt, stage] = aim(L, G); pick = { L, tgt, stage, fresh: true }; }
    }
    // 3. nearest fresh, else nearest not flown this take
    if (!pick) for (const want of [1, 2]) {
      let best = null;
      for (const L of this._lines) {
        if (L.l.micro || eligible(L.l.name) !== want) continue;
        for (const G of L.pre.length ? L.pre : [L.main]) { const [tgt, stage, d] = aim(L, G); if (!best || d < best.d) best = { L, tgt, stage, d }; }
      }
      if (best) { pick = { ...best, fresh: want === 1 }; break; }
    }
    if (!pick) return null;
    const c = pick.tgt, dx = c[0] - p.x, dy = c[1] - p.y, dz = c[2] - p.z, hd = Math.hypot(dx, dz);
    const h = drone.heading ?? Math.atan2(-drone.vel.x, -drone.vel.z);
    const hv = this._state === 'ready' ? this._T.hintVertReady : this._T.hintVert;   // [P6-F ux #3]
    const vert = Math.abs(dy) > 1 && (hd < hv || (pick.prog && hd < 0.5 * Math.abs(dy))) ? (dy < 0 ? 'down' : 'up') : null;
    return { name: pick.L.l.name, caption: pick.L.l.caption || pick.L.l.name, pos: c.slice(), dist: +Math.hypot(dx, dy, dz).toFixed(2),
      bearing: -wrap(Math.atan2(-dx, -dz) - h), elev: Math.atan2(dy, hd), fresh: pick.fresh, vert, stage: pick.stage, inProgress: !!pick.prog };
  }
  // First-retry explanation (UX r3 #3, data for the UI): while this take is 'ready' within 3 m of a world.startPoints
  // entry that carries hint {text, line, until}, and that line has been flown fewer than `until` times ever:
  // {text, line, n (times flown), until, start (the start point's name)}; else null. The UI shows `text` in the take tag
  // and on the portrait OLED instead of READY.
  readyHint(drone, world) {
    if (this.free || this._state !== 'ready' || !drone?.pos) return null;
    const p = drone.pos;
    for (const s of world?.startPoints || []) {
      const h = s.hint, q = s.pos; if (!h || !q) continue;
      const qx = q.x ?? q[0], qy = q.y ?? q[1], qz = q.z ?? q[2];
      if (Math.hypot(p.x - qx, p.y - qy, p.z - qz) > 3) continue;
      const n = PROG[h.line]?.n || 0;
      if (n < (h.until ?? 3)) return { text: h.text, line: h.line, n, until: h.until ?? 3, start: s.name };
    }
    return null;
  }
}

// fallback UI until main.js defines onTakeEvent (pop(text, kind), contract #5; the old pop ignores kind)
export function defaultTakeUI(e, pop) {
  const n = (v) => Math.round(v || 0).toLocaleString('en-US');
  switch (e.type) {
    case 'line': pop(e.pts ? `${plainCaption(e.caption)}  ${e.flow > 1 && !e.clipped ? `×${e.flow}  ` : ''}+${n(e.pts)}${e.clipped ? '  CLIPPED' : e.clean ? '  CLEAN' : ''}` : plainCaption(e.caption), 'line'); break;
    case 'repeat': pop(`${plainCaption(e.caption || e.name)}  REPEAT +${n(e.pts)}`, 'line'); break;
    case 'bank': if (!e.cut) pop(`BANKED +${n(e.pts)}`, 'score'); break;
    case 'scrape': if (e.lost) pop(`SCRAPE · FLOW ×${e.flow}`, 'warn'); break;
    case 'cut': pop(`CUT!  ${e.pts ? `+${n(e.pts)}  ` : ''}${n(e.total)} PTS${e.stars ? '  ' + '★'.repeat(e.stars) : ''}${e.perfect ? '  PERFECT' : ''}`, 'score'); break;
    case 'crash': pop(e.lost ? `CRASHED · CHAIN LOST −${n(e.lost)}` : `CRASHED · ${n(e.total)} PTS`, 'warn'); break;
    default: break;
  }
}
