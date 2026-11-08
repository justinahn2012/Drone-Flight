// usage: node tests/take.mjs  (HZ=240 for per-tick updates; DIR=<root> to test another tree)
// Unit tests for take.js (round 3): FLOW/bank/crash/CUT/repeats, holdZone, CUT rules (3 s, ring, cutSpeed, pre-gate
// block, touchdown), hands-off bank pause, DROP IN micro, SCRAPE / CLEAN, stars, progress + best in localStorage, t0/ago,
// nextHint, free instance, carves (orbit / turn), teleport.
const DIR = process.env.DIR || new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const store = {}; globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const { Take, TAKE_TUNING: T, starsFor, resetProgress, defaultTakeUI } = await import(DIR + '/take.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL:', msg); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// synthetic world: gates along +z at z = 0 (A, pre P at z=-5), z = 20 (B), z = 40 (C); a micro gate M at z = 60
const gate = (z, extra = {}) => ({ c: [0, 2, z], n: [0, 0, 1], w: 4, h: 4, ...extra });
const lines = [
  { name: 'A', caption: '*A*!', pts: 1000, ...gate(0), pre: [gate(-5)], within: 6 },
  { name: 'B', caption: 'B', pts: 2000, ...gate(20) },
  { name: 'C', caption: 'C', pts: 3000, ...gate(40) },
  { name: 'M', caption: 'M', pts: 500, micro: true, ...gate(60) },
  { name: 'ORB', caption: 'ORB', pts: 500, micro: true, c: [100, 5, 0], carve: { kind: 'orbit', axes: [[100, 0]], r0: 6, r1: 6, in0: 3, in1: 3, y0: 0, y1: 20, sweep: Math.PI } },
  { name: 'UT', caption: 'UT', pts: 500, micro: true, c: [-100, 5, 0], carve: { kind: 'turn', box: [-120, -80, 0, 20, -20, 20], sweep: 2.62 } },
];
// skimBvh mock: one wall plane at x = wallX
let wallX = 1e9;
const skimBvh = { closestPointToPoint(p, out, minT, maxT) { const d = Math.abs(p.x - wallX); if (d > maxT) return null; out.distance = d; out.point = { x: wallX, y: p.y, z: p.z }; return out; } };
const world = { lines, skimBvh };
const mk = () => ({ pos: { x: 0, y: 2, z: -20 }, vel: { x: 0, y: 0, z: 0 }, crashed: false, heading: Math.PI, lastImpact: 0, contactN: { x: 0, y: 0, z: 0 }, c: { radius: 0.12 }, key: 'freestyle5' });
const DT = 1 / +(process.env.HZ || 60);   // 60: per frame; 240: per physics tick (stream E)
// fly the drone along +z at speed v from its position to z1 (sticks on), collecting events
function flyTo(tk, d, z1, v = 10, sticks = true, evs = []) {
  d.vel = { x: 0, y: 0, z: Math.sign(z1 - d.pos.z) * v };
  while (Math.abs(z1 - d.pos.z) > 1e-6) { const s = Math.min(v * DT, Math.abs(z1 - d.pos.z)); d.pos = { ...d.pos, z: d.pos.z + Math.sign(z1 - d.pos.z) * s }; evs.push(...tk.update(DT, d, world, sticks)); }
  return evs;
}
function hold(tk, d, secs, sticks, evs = [], speed = 0) { d.vel = { x: speed, y: 0, z: 0 }; for (let i = 0; i < Math.round(secs / DT); i++) evs.push(...tk.update(DT, d, world, sticks)); return evs; }
const types = (evs) => evs.map((e) => e.type);

// ---- 1. start, FLOW, CLEAN, t0/ago, micro
{
  resetProgress();
  const tk = new Take(), d = mk(), evs = [];
  hold(tk, d, 0.5, false, evs); ok(tk.state === 'ready' && evs.length === 0, 'ready until sticks');
  flyTo(tk, d, 1, 10, true, evs);
  ok(evs[0].type === 'start', 'start event');
  const a = evs.find((e) => e.type === 'line' && e.name === 'A');
  ok(a && a.flow === 1 && a.clean && a.pts === Math.round(1000 * T.cleanMult), `A clean x1 pts ${a?.pts}`);
  ok(a && near(a.ago, 0.5, 0.03) && near(a.t - a.t0, 0.5, 0.03), `A t0/ago from the pre-gate (ago ${a?.ago}, t ${a?.t}, t0 ${a?.t0})`);
  flyTo(tk, d, 21, 10, true, evs);
  const b = evs.find((e) => e.name === 'B');
  ok(b && b.flow === 2 && b.pts === Math.round(2000 * 2 * T.cleanMult) && b.ago === 0, 'B x2 clean, no pre: ago 0');
  ok(tk.flow === 3, 'flow 3 after two lines');
  // contact before C: not clean
  d.contactN = { x: 1, y: 0, z: 0 }; hold(tk, d, DT, true, evs, 5); d.contactN = { x: 0, y: 0, z: 0 };
  flyTo(tk, d, 41, 10, true, evs);
  const c = evs.find((e) => e.name === 'C');
  ok(c && !c.clean && c.pts === 3000 * 3, `C after a touch: not clean (${c?.pts})`);
  flyTo(tk, d, 61, 10, true, evs);
  const m = evs.find((e) => e.name === 'M');
  ok(m && m.micro && m.flow === 4 && m.pts === Math.round(500 * 4 * T.cleanMult), 'micro-line scores + FLOW, flagged micro');
  ok(tk.flow === 5 && tk.unbanked === a.pts + b.pts + c.pts + m.pts, 'unbanked = sum of the chain');
}

// ---- 2. bank after 5 s with sticks on; hands-off pauses the bank timer; bankIn
{
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, 1, 10, true, evs);
  ok(near(tk.bankIn, T.bankT - 0.0, 0.2), `bankIn just after a line ${tk.bankIn}`);
  hold(tk, d, 3, false, evs, 3);   // hands off but drifting (no CUT): bank timer waits
  ok(!types(evs).includes('bank') && near(tk.bankIn, T.bankT - 0.1, 0.25), `hands-off: no bank, bankIn ${tk.bankIn.toFixed(2)}`);
  hold(tk, d, 5.2, true, evs, 3);
  const bk = evs.find((e) => e.type === 'bank');
  ok(bk && bk.pts === Math.round(1000 * T.cleanMult) && tk.flow === 1 && tk.total === bk.pts && tk.bankIn === 0, 'bank after 5 s of sticks-on, FLOW back to 1');
}

// ---- 3. holdZone keeps the chain alive near structure (no points beyond skimZone), holding flag
{
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, 1, 10, true, evs);
  wallX = 1.8 + 0.12;                 // 1.8 m gap: inside holdZone 2.0, outside skimZone 1.4
  const u0 = tk.unbanked;
  hold(tk, d, 8, true, evs, 6);
  ok(!types(evs).includes('bank') && tk.unbanked === u0 && tk.holding, `holdZone: 8 s near a wall, no bank, no pts, holding (${tk.unbanked - u0})`);
  wallX = 2.5 + 0.12;                 // out of the hold zone
  hold(tk, d, 5.2, true, evs, 6);
  ok(types(evs).includes('bank') && !tk.holding, 'out of the hold zone: banks');
  wallX = 1e9;
  // too slow near the wall: no hold
  const tk2 = new Take(), d2 = mk(), e2 = [];
  flyTo(tk2, d2, 1, 10, true, e2); wallX = 1.0; hold(tk2, d2, 5.3, true, e2, 3); wallX = 1e9;
  ok(!types(e2).includes('bank') && tk2.holding, 'r4: the hold zone holds from 2 m/s (3 m/s here), no skim pts below skimSpeed');
  const tk3 = new Take(), d3 = mk(), e3 = [];
  flyTo(tk3, d3, 1, 10, true, e3); hold(tk3, d3, 30, true, e3, 1.5);
  ok(!types(e3).includes('bank') && near(tk3.bankIn, T.bankT, 0.25), `r4: at 1.5 m/s the bank timer waits (bankIn ${tk3.bankIn.toFixed(2)})`);
}

// ---- 4. CUT: 3 s hands-off hover, ring from 1 s, cutSpeed 1.0, x1.5, needs something to show
{
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, -2, 10, true, evs);            // live, nothing scored yet
  hold(tk, d, 4, false, evs);
  ok(!types(evs).includes('cut') && tk.cutIn === 0, 'no CUT with nothing to show');
  const tk2 = new Take(), d2 = mk(), e2 = [];
  flyTo(tk2, d2, 21, 10, true, e2);            // A (pre at -5 crossed at ~t 1.5) and B
  // past the pre-gate block: fly on 4 s with sticks (bank at 5 s? idle from B: 4 s < 5)
  hold(tk2, d2, 2.0, true, e2, 5);
  hold(tk2, d2, 3, false, e2, 1.5);            // 1.5 m/s drift: not a hover
  ok(!types(e2).includes('cut') && tk2.cutIn === 0, 'drifting at 1.5 m/s: no CUT');
  hold(tk2, d2, 0.9, false, e2, 0.5);
  ok(tk2.cutIn === 0 && tk2.cutKind === null, `no ring before 1 s of hover (cutIn ${tk2.cutIn})`);
  hold(tk2, d2, 0.3, false, e2, 0.5);
  ok(tk2.cutKind === 'hover' && near(tk2.cutIn, 1.8, 0.05) && tk2.cutFrac > 0 && tk2.cutFrac < 0.2, `ring shows after 1 s: cutIn ${tk2.cutIn.toFixed(2)} frac ${tk2.cutFrac.toFixed(2)}`);
  hold(tk2, d2, 0.3, true, e2, 0.5);           // a stick cancels it
  ok(tk2.cutIn === 0 && !types(e2).includes('cut'), 'a stick cancels the countdown');
  const u = tk2.unbanked;
  hold(tk2, d2, 3.05, false, e2, 0.5);
  const cut = e2.find((e) => e.type === 'cut');
  ok(cut && cut.how === 'hover' && cut.pace === 1.5 && cut.pts === Math.round(u * T.cutMult * 1.5) && cut.total === cut.pts, `CUT after 3 s, x1.5 x PACE 1.5 (${cut?.pts} vs ${u})`);
  ok(tk2.state === 'done' && cut.stars === starsFor(cut.total), 'done, stars on the cut event');
}

// ---- 5. no CUT within 4 s of crossing a pre-gate
{
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, 1, 10, true, evs);              // pre at z=-5 crossed, then A
  hold(tk, d, 3.2, false, evs);                // hover hands-off right after: blocked until 4 s after the pre-gate
  ok(!types(evs).includes('cut') && tk.cutIn === 0, 'no CUT (and no ring) within 4 s of a pre-gate');
  hold(tk, d, 3.5, false, evs);
  const c = evs.find((e) => e.type === 'cut');
  ok(c, 'CUT once the block lifts and 3 s of hover follow');
  const tCut = c ? evs.indexOf(c) : -1; ok(tCut > 0, 'cut after the block');
}

// ---- 6. touchdown CUT: 0.6 s on a floor, slow; walls don't count
{
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, 21, 10, true, evs); hold(tk, d, 2.5, true, evs, 5);
  d.contactN = { x: 1, y: 0.2, z: 0 }; hold(tk, d, 1.0, true, evs, 0.2);
  ok(!types(evs).includes('cut'), 'resting against a wall: no touchdown CUT');
  d.contactN = { x: 0, y: 1, z: 0 }; hold(tk, d, 0.3, true, evs, 0.2);
  ok(tk.cutKind === 'land' && near(tk.cutIn, 0.3, 0.05), `touchdown ring: cutIn ${tk.cutIn.toFixed(2)}`);
  hold(tk, d, 0.35, true, evs, 0.2);
  const c = evs.find((e) => e.type === 'cut');
  ok(c && c.how === 'land', 'touchdown CUT after 0.6 s, sticks on');
}

// ---- 6b. no touchdown CUT inside a funnel shaft (a full dive lands on the chimney floor); the hover CUT still works
{
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, 21, 10, true, evs); hold(tk, d, 2.5, true, evs, 5);
  world.funnels = [{ c: [d.pos.x + 1, d.pos.z], top: 50, bottom: 0, r: 3.5 }];
  d.contactN = { x: 0, y: 1, z: 0 }; hold(tk, d, 1.5, true, evs, 0.2);
  ok(!types(evs).includes('cut') && tk.cutKind === null, 'no touchdown CUT down a shaft');
  hold(tk, d, 3.5, false, evs, 0.2);
  ok(!types(evs).includes('cut') && tk.cutKind === null, 'r4: no hover CUT down a shaft either');
  world.funnels = [{ c: [d.pos.x + 1, d.pos.z], dir: 'up', top: 50, bottom: 4, r: 3.5 }];
  const t6 = new Take(), e6 = []; d.contactN = { x: 0, y: 0, z: 0 }; flyTo(t6, d, d.pos.z + 21, 10, true, e6); hold(t6, d, 2.5, true, e6, 5);
  world.funnels[0].c = [d.pos.x + 1, d.pos.z]; d.contactN = { x: 0, y: 1, z: 0 }; hold(t6, d, 0.7, true, e6, 0.2);
  ok(e6.find((e) => e.type === 'cut')?.how === 'land', "r4: an 'up' funnel does not block the touchdown CUT");
  delete world.funnels; d.contactN = { x: 0, y: 0, z: 0 };
}

// ---- 7. crash loses the unbanked chain; scrape costs FLOW (cooldown), small hits only dirty
{
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, 41, 10, true, evs);             // A, B, C -> flow 4
  ok(tk.flow === 4, 'flow 4');
  d.lastImpact = 1.8; hold(tk, d, DT, true, evs, 5);
  ok(!types(evs).includes('scrape') && tk.flow === 4, 'a 1.8 m/s bump is not a scrape');
  d.lastImpact = 3.1; hold(tk, d, DT, true, evs, 5);
  const s = evs.find((e) => e.type === 'scrape');
  ok(s && s.lost === 1 && s.flow === 3 && tk.flow === 3, 'SCRAPE: FLOW -1');
  d.lastImpact = 3.3; hold(tk, d, DT, true, evs, 5);
  ok(evs.filter((e) => e.type === 'scrape').length === 1, 'scrape cooldown');
  hold(tk, d, 0.7, true, evs, 5); d.lastImpact = 4.0; hold(tk, d, DT, true, evs, 5);
  ok(evs.filter((e) => e.type === 'scrape').length === 2 && tk.flow === 2, 'second scrape after the cooldown');
  const u = tk.unbanked;
  d.crashed = true; hold(tk, d, DT, true, evs, 0);
  const lost = evs.find((e) => e.type === 'lost'), cr = evs.find((e) => e.type === 'crash');
  ok(lost && lost.pts === u && cr && cr.lost === u && cr.total === 0 && tk.state === 'done', 'crash loses the unbanked chain');
}

// ---- 8. repeats: 25 %, no FLOW, only after another line; cooldown
{
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, 21, 10, true, evs);              // A, B
  flyTo(tk, d, 19, 10, true, evs); flyTo(tk, d, 21, 10, true, evs);   // back through B (ping-pong): nothing
  ok(evs.filter((e) => e.name === 'B').length === 1, 'no ping-pong repeat through one gate');
  flyTo(tk, d, 41, 10, true, evs);               // C
  d.pos = { x: 0, y: 2, z: 15 }; hold(tk, d, DT, true, evs);   // small jump back (< teleport)
  flyTo(tk, d, 21, 10, true, evs);               // B again after C: repeat
  const r = evs.find((e) => e.type === 'repeat');
  ok(r && r.name === 'B' && r.pts === Math.round(2000 * T.repeat * T.cleanMult) && tk.flow === 4, `repeat 25 % (x1.25 clean), no FLOW (${r?.pts})`);
}

// ---- 9. stars, best, progress, lineList
{
  ok(starsFor(59999) === 0 && starsFor(60000) === 1 && starsFor(149999) === 1 && starsFor(150000) === 2 && starsFor(260000) === 3, 'r4 stars 60k/150k/260k');
  resetProgress();
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, 41, 10, true, evs); hold(tk, d, 4.5, true, evs, 5); hold(tk, d, 3.1, false, evs, 0);
  const cut = evs.find((e) => e.type === 'cut');
  ok(cut && +store['onetake.best'] === cut.total && tk.best === cut.total, 'best saved on CUT');
  const P = JSON.parse(store['onetake.lines']);
  ok(P.A.n === 1 && P.B.flow === 2 && P.C.pts === 3000 * 3 * T.cleanMult, 'per-line progress: n, best flow, best pts');
  const pr = tk.progress(world);
  ok(pr.flown === 3 && pr.total === 3 && pr.micro.total === 3 && pr.micro.flown === 0 && pr.best === cut.total, `progress counts ${JSON.stringify(pr)}`);
  const L = tk.lineList(world);
  ok(L.length === 6 && L[0].name === 'A' && L[0].flown && L[3].micro && !L[3].flown && L[1].bestFlow === 2, 'lineList');
  // a new instance (page reload) sees the stored progress and best
  const tk2 = new Take(); ok(tk2.best === cut.total && tk2.progress(world).flown === 3, 'progress + best persist');
}

// ---- 10. nextHint: nearest never-flown line by its first gate; bearing + = right, elev
{
  resetProgress();
  const tk = new Take(), d = mk();
  d.pos = { x: 0, y: 2, z: -20 }; d.heading = Math.PI;   // facing +z (forward = (-sin h, -cos h) = (0, 1))
  let h = tk.nextHint(d, world);
  ok(h && h.name === 'A' && near(h.dist, 15) && near(h.bearing, 0, 1e-9) && near(h.elev, 0) && h.fresh, `hint to A's pre-gate ${JSON.stringify(h)}`);
  d.pos = { x: -10, y: 2, z: -5 };                   // A's pre-gate at (0,2,-5): 10 m to the east = to the right when facing +z (south)?
  h = tk.nextHint(d, world);
  // facing +z (south): east (+x) is on the left (right-handed, y up: looking along +z, +x is to the left)
  ok(h && near(h.bearing, -Math.PI / 2, 1e-9), `bearing sign: +x while facing +z is left (${h.bearing})`);
  d.heading = 0; h = tk.nextHint(d, world);         // facing -z (north): +x is to the right
  ok(near(h.bearing, Math.PI / 2, 1e-9), `facing north, east is right (${h.bearing})`);
  d.pos = { x: 0, y: -8, z: -5 }; h = tk.nextHint(d, world);
  ok(near(h.elev, Math.PI / 2, 1e-9), 'elev straight up');
  d.pos = { x: 0, y: 2, z: -20 }; d.heading = Math.PI; const e = []; flyTo(tk, d, 1, 10, true, e);
  h = tk.nextHint(d, world); ok(h.name === 'B' && h.fresh, 'after flying A the hint moves on to B');
  ok(!tk.nextHint(d, world).name.startsWith('M'), 'micro-lines are never hinted');
}

// ---- 11. free instance: lines fire (pts 0, free), progress counted, no state machine
{
  resetProgress();
  const tk = new Take({ free: true }), d = mk(), evs = [];
  flyTo(tk, d, 41, 10, false, evs); hold(tk, d, 5, false, evs);
  ok(types(evs).join() === 'line,line,line' && evs.every((e) => e.free && e.pts === 0 && e.t0 !== undefined), 'free: lines only, pts 0, free flag, t0');
  ok(tk.state === 'ready' && tk.total === 0, 'free: no take state');
  ok(JSON.parse(store['onetake.lines']).B.n === 1, 'free flights count as flown');
}

// ---- 12. carves: orbit (and not from inside the flue), turn in a box; teleport resets
{
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, -2, 10, true, evs);              // live
  // orbit r = 5 around (100, 0) at y 5: half a turn at 8 m/s
  d.pos = { x: 100, y: 5, z: 5 }; hold(tk, d, DT, true, evs);   // teleport there (> 25 m): no crossing
  const w = 8 / 5; let a = 0, fired = null, firedA = null;
  for (let i = 0; i < Math.ceil(3.3 / DT) && !fired; i++) { a += w * DT; d.pos = { x: 100 + 5 * Math.sin(a), y: 5, z: 5 * Math.cos(a) }; d.vel = { x: 8 * Math.cos(a), y: 0, z: -8 * Math.sin(a) }; const e = tk.update(DT, d, world, true); evs.push(...e); fired = e.find((x) => x.name === 'ORB'); if (fired) firedA = a; }
  ok(fired && near(firedA, Math.PI, 0.05) && fired.micro, `orbit fires at 180 deg (${(firedA * 57.3).toFixed(0)} deg)`);
  // inside the "flue" (r < in0): circling at r 1 never fires
  const tk2 = new Take(), d2 = mk(), e2 = []; flyTo(tk2, d2, -2, 10, true, e2);
  d2.pos = { x: 101, y: 5, z: 0 }; tk2.update(DT, d2, world, true);
  for (let i = 0; i < Math.round(400 / 60 / DT); i++) { const b = i * 3 * DT; d2.pos = { x: 100 + Math.cos(b), y: 5, z: Math.sin(b) }; d2.vel = { x: -Math.sin(b) * 3, y: 0, z: Math.cos(b) * 3 }; e2.push(...tk2.update(DT, d2, world, true)); }
  ok(!e2.some((e) => e.name === 'ORB'), 'circling inside the wall radius never fires');
  // turn: a U-turn at 6 m/s in the box, with a slow pivot in the middle
  const tk3 = new Take(), d3 = mk(), e3 = []; flyTo(tk3, d3, -2, 10, true, e3);
  d3.pos = { x: -100, y: 5, z: 0 }; tk3.update(DT, d3, world, true);
  const steps = [[0, 6, 30], [1.4, 1.0, 20], [2.8, 6, 30]];  // heading (rad from +z), speed, frames
  for (const [hd, sp, n] of steps) for (let i = 0; i < Math.round(n / 60 / DT); i++) { d3.vel = { x: Math.sin(hd) * sp, y: 0, z: Math.cos(hd) * sp }; d3.pos = { x: d3.pos.x + d3.vel.x * DT, y: 5, z: d3.pos.z + d3.vel.z * DT }; e3.push(...tk3.update(DT, d3, world, true)); }
  const ut = e3.find((e) => e.name === 'UT');
  ok(ut, 'turn carve: a U-turn with a slow pivot still counts');
  // teleport mid-orbit resets it
  const tk4 = new Take(), d4 = mk(), e4 = []; flyTo(tk4, d4, -2, 10, true, e4);
  d4.pos = { x: 100, y: 5, z: 5 }; tk4.update(DT, d4, world, true); a = 0;
  for (let i = 0; i < Math.round(1 / DT); i++) { a += w * DT; d4.pos = { x: 100 + 5 * Math.sin(a), y: 5, z: 5 * Math.cos(a) }; d4.vel = { x: 8 * Math.cos(a), y: 0, z: -8 * Math.sin(a) }; e4.push(...tk4.update(DT, d4, world, true)); }
  tk4.reset();
  ok(tk4._carves[0].st[0].ref === null && tk4._carves[0].st[0].acc === 0, 'reset clears carve state');
}

// ---- 13. after a CUT: let go, touch a stick -> a new take; defaultTakeUI handles every event
{
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, 21, 10, true, evs); hold(tk, d, 4.5, true, evs, 5); hold(tk, d, 3.1, false, evs);
  ok(tk.state === 'done', 'done after CUT');
  hold(tk, d, 0.2, false, evs); hold(tk, d, DT, true, evs);
  ok(tk.state === 'live' && evs.at(-1).type === 'start', 'new take after release + stick');
  const out = []; for (const e of [{ type: 'line', name: 'X', caption: '*X*', pts: 10, flow: 2, clean: true }, { type: 'scrape', lost: 1, flow: 2 }, { type: 'cut', pts: 5, total: 50000, stars: 1 }, { type: 'crash', lost: 0, total: 3 }, { type: 'repeat', name: 'X', pts: 1 }, { type: 'bank', pts: 3 }]) defaultTakeUI(e, (t, k) => out.push(k + ':' + t));
  ok(out.length === 6 && out[0].includes('CLEAN') && out[2].includes('★'), 'defaultTakeUI: ' + out.join(' | '));
}


// ================= round 4 =================
const H = (hands, moved = hands, steer = false) => ({ hands, moved, steer });
// ---- 14. hands object: a resting thumb is hands-on (no hover CUT, no start); moved starts; steer blocks touchdown CUT
{
  const tk = new Take(), d = mk(), evs = [];
  hold(tk, d, 0.5, H(true, false), evs);
  ok(tk.state === 'ready', 'a thumb resting on the screen does not start the take');
  flyTo(tk, d, 21, 10, H(true, true), evs);
  ok(tk.state === 'live', 'deflection starts it');
  hold(tk, d, 2.5, H(true), evs, 5);
  hold(tk, d, 5, H(true, false), evs, 0.3);
  ok(!types(evs).includes('cut') && tk.cutIn === 0, 'thumbs resting, hovering 5 s: no CUT, no ring');
  hold(tk, d, 3.1, H(false), evs, 0.3);
  ok(evs.find((e) => e.type === 'cut')?.how === 'hover', 'thumbs off: hover CUT');
  // touchdown with the right stick deflected: no CUT; climb (dive) held is still a landing
  const t2 = new Take(), d2 = mk(), e2 = [];
  flyTo(t2, d2, 21, 10, true, e2); hold(t2, d2, 2.5, true, e2, 5);
  d2.contactN = { x: 0, y: 1, z: 0 }; hold(t2, d2, 1.5, H(true, true, true), e2, 0.2);
  ok(!types(e2).includes('cut') && t2.cutKind === null, 'touchdown with pitch/roll/yaw deflected: no CUT');
  hold(t2, d2, 0.7, H(true, true, false), e2, 0.2);
  ok(e2.find((e) => e.type === 'cut')?.how === 'land', 'touchdown with only the dive held: CUT');
  // after a land CUT with the dive held: released only once no stick is deflected
  hold(t2, d2, 0.3, H(true, true, false), e2, 0);
  ok(t2.state === 'done', 'stick still held after the CUT: no new take');
  hold(t2, d2, 0.1, H(true, false), e2, 0); hold(t2, d2, DT, H(true, true), e2, 0);
  ok(t2.state === 'live', 'centre, then move: new take');
}
// ---- 15. no SCRAPE on a floor contact
{
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, 41, 10, true, evs);
  d.contactN = { x: 0, y: 1, z: 0 }; d.lastImpact = 3.8; hold(tk, d, DT, true, evs, 3);
  ok(!types(evs).includes('scrape') && tk.flow === 4, 'a 3.8 m/s floor touchdown is not a SCRAPE');
  d.contactN = { x: 1, y: 0, z: 0 }; d.lastImpact = 3.9; hold(tk, d, DT, true, evs, 3); d.contactN = { x: 0, y: 0, z: 0 };
  ok(types(evs).includes('scrape') && tk.flow === 3, 'a wall hit still is');
}
// ---- 16. skim pays only within skimNear of a line
{
  const tk = new Take(), d = mk(), evs = [];
  flyTo(tk, d, 1, 10, true, evs);
  wallX = 0.3 + 0.12; const u0 = tk.unbanked;
  hold(tk, d, 4, true, evs, 6); const u1 = tk.unbanked;
  hold(tk, d, 6, true, evs, 6); const u2 = tk.unbanked;
  hold(tk, d, 30, true, evs, 6); wallX = 1e9;
  ok(u1 > u0 + 150 && u2 - u1 < (u1 - u0) * 0.3 && tk.unbanked === u2 && !types(evs).includes('bank'), `skim pays for 5 s after the line (+${u1 - u0}, then +${u2 - u1}, then +${tk.unbanked - u2}); the hold keeps the chain`);
}
// ---- 17. PACE
{
  const T0 = (tk) => tk.pace;
  const tk = new Take(), d = mk(), evs = [];
  ok(T0(tk) === 1, 'pace 1 with no line');
  flyTo(tk, d, 1, 10, true, evs);
  ok(tk.pace === 1.5, 'pace x1.5 for an early line');
  tk._log[tk._log.length - 1].t = 67.5; ok(tk.pace === 1.25, `pace x1.25 at 67.5 s (${tk.pace})`);
  tk._log[tk._log.length - 1].t = 95; ok(tk.pace === 1, 'pace x1 from 90 s');
  tk._log.push({ name: 'B', t: 120, repeat: true }); ok(tk.pace === 1, 'repeats do not move it');
  tk._log[0].t = 30; ok(tk.pace === 1.5 && tk.cutValue === Math.round(tk.unbanked * T.cutMult * 1.5), 'a late repeat does not lower PACE; cutValue');
}
// ---- 18. captions that share a t0: the later event says which one the clip keeps
{
  const w2 = { lines: [
    { name: 'IN', pts: 500, micro: true, c: [0, 2, 0], n: [0, 0, 1], w: 4, h: 4 },
    { name: 'BIG', pts: 3000, c: [0, 2, 10], n: [0, 0, 1], w: 4, h: 4, pre: [{ c: [0, 2, 0], n: [0, 0, 1], w: 4, h: 4 }], within: 6 },
    { name: 'SMALL', pts: 200, c: [0, 2, 20], n: [0, 0, 1], w: 4, h: 4, pre: [{ c: [0, 2, 0], n: [0, 0, 1], w: 4, h: 4 }], within: 6 },
  ] };
  const tk = new Take(), d = mk(), evs = [];
  d.vel = { x: 0, y: 0, z: 10 };
  while (d.pos.z < 21) { d.pos = { ...d.pos, z: d.pos.z + 10 * DT }; evs.push(...tk.update(DT, d, w2, true)); }
  const a = evs.find((e) => e.name === 'IN'), b = evs.find((e) => e.name === 'BIG'), c = evs.find((e) => e.name === 'SMALL');
  ok(a && !a.clip && b && b.sameT0 === 'IN' && b.clip === 'replace' && c && c.clip === 'skip', `same t0: ${b?.clip} / ${c?.clip}`);
}
// ---- 19. nextHint: in progress -> main gate; vert; via; first; readyHint
{
  resetProgress();
  const vgate = { c: [0, 2, 40], n: [0, -1, 0], w: 4, h: 4 };
  const w3 = { lines: [
    { name: 'SHAFT', pts: 1000, c: [0, -30, 40], n: [0, -1, 0], w: 4, h: 4, pre: [vgate], within: 10, via: [{ p: [0, 10, 40], unless: [-5, 5, -40, 0, 30, 50] }] },
    { name: 'FAR', pts: 1000, first: true, c: [200, 2, 0], n: [0, 0, 1], w: 4, h: 4 },
    { name: 'NEAR', pts: 1000, c: [0, 2, 5], n: [0, 0, 1], w: 4, h: 4 },
  ], startPoints: [{ name: 'Top', pos: [0, 12, 40], hint: { text: '▼ HOLD LEFT STICK · DROP IN', line: 'SHAFT', until: 3, next: 'SHAFT' } }] };
  const tk = new Take(), d = mk();
  d.pos = { x: 0, y: 2, z: -20 }; d.heading = Math.PI;
  let h = tk.nextHint(d, w3);
  ok(h.name === 'FAR' && h.fresh, 'new profile: the line flagged first');
  PROG_fly: { const t9 = new Take({ free: true }), dd = mk(); dd.pos = { x: 0, y: 2, z: 0 }; t9.update(DT, dd, w3, false); dd.pos = { x: 0, y: 2, z: 6 }; t9.update(DT, dd, w3, false); }
  h = tk.nextHint(d, w3); ok(h.name === 'SHAFT' && h.stage === 'via', `once a line is flown: nearest fresh by route through its via (${h.name})`);
  d.pos = { x: 0, y: 2, z: 10 }; h = tk.nextHint(d, w3);
  ok(h.name === 'SHAFT' && h.stage === 'via' && near(h.pos[1], 10) && h.vert === null, `outside: the via first (${h.stage} ${h.pos})`);
  d.pos = { x: 1, y: 14, z: 40.5 }; h = tk.nextHint(d, w3);
  ok(h.stage === 'gate' && h.vert === 'down', `over the via: the gate, down (${h.stage} ${h.vert})`);
  // fly down through the pre-gate: in progress -> main gate, still down
  const e = []; tk.update(DT, d, w3, true); d.pos = { x: 0.5, y: 1, z: 40 }; e.push(...tk.update(DT, d, w3, true));
  h = tk.nextHint(d, w3); ok(h.inProgress && h.stage === 'main' && near(h.pos[1], -30) && h.vert === 'down', 'past the pre-gate: the main gate below');
  d.pos = { x: 6, y: -10, z: 40 }; h = tk.nextHint(d, w3); ok(h.inProgress && h.vert === 'down', 'in progress: steep counts as down');
  { resetProgress(); const t5 = new Take(), d5 = mk(); d5.pos = { x: 0, y: 12, z: 40.5 };
    const h5 = t5.nextHint(d5, w3); ok(h5.name === 'SHAFT' && h5.vert === 'down', `at a start with hint.next: that line, not the first-flight line (${h5.name})`);
    d5.pos = { x: 0, y: 2, z: -20 }; ok(t5.nextHint(d5, w3).name === 'FAR', 'away from it: the first-flight line'); }
  // readyHint
  const t2 = new Take(), d2 = mk(); d2.pos = { x: 0, y: 12, z: 40.5 };
  let r = t2.readyHint(d2, w3); ok(r && r.text.startsWith('▼') && r.n === 0 && r.start === 'Top', 'readyHint at the start');
  d2.pos = { x: 0, y: 12, z: 46 }; ok(t2.readyHint(d2, w3) === null, 'not away from the start');
  d2.pos = { x: 0, y: 12, z: 40.5 }; t2.update(DT, d2, w3, true); ok(t2.readyHint(d2, w3) === null, 'not once live');
  const P = JSON.parse(store['onetake.lines'] || '{}'); P.SHAFT = { n: 3, flow: 1, pts: 1 }; store['onetake.lines'] = JSON.stringify(P);
  resetProgress();
}

console.log(`take tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
