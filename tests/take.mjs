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
  // r5 (design r4 #5): a crawl with hands on still banks, at idleSlow (0.4x): 12.5 s; hands off it waits
  const tk3 = new Take(), d3 = mk(), e3 = [];
  flyTo(tk3, d3, 1, 10, true, e3); hold(tk3, d3, 10, true, e3, 1.5);
  ok(!types(e3).includes('bank') && near(tk3.bankIn, T.bankT - 10 * T.idleSlow, 0.25), `r5: at 1.5 m/s the bank timer runs at 0.4x (bankIn ${tk3.bankIn.toFixed(2)})`);
  hold(tk3, d3, 3, false, e3, 1.5);
  ok(!types(e3).includes('bank') && near(tk3.bankIn, T.bankT - 10 * T.idleSlow, 0.25), 'r5: crawling hands-off it waits');
  hold(tk3, d3, 3, true, e3, 1.5);
  ok(types(e3).includes('bank'), 'r5: a hands-on crawl banks after bankT / idleSlow s');
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
  ok(starsFor(59999) === 0 && starsFor(60000) === 1 && starsFor(179999) === 1 && starsFor(180000) === 2 && starsFor(324999) === 2 && starsFor(325000) === 3, 'r5 stars 60k/180k/325k');
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
  // r5 bestT: the take time a line was first reached at, best over takes (lower), in lineList
  ok(near(P.A.bestT, 2.0, 0.05) && near(P.B.bestT, 4.0, 0.05) && L[0].bestT === P.A.bestT && L[3].bestT === 0, `bestT splits (A ${P.A.bestT}, B ${P.B.bestT})`);
  const tk3 = new Take(), d3 = mk(); d3.pos = { x: 0, y: 2, z: -30 }; flyTo(tk3, d3, 1, 10, true);
  ok(near(JSON.parse(store['onetake.lines']).A.bestT, 2.0, 0.05), 'a slower take does not raise bestT');
  const tk4 = new Take(), d4 = mk(); d4.pos = { x: 0, y: 2, z: -10 }; flyTo(tk4, d4, 1, 10, true);
  ok(near(JSON.parse(store['onetake.lines']).A.bestT, 1.0, 0.05), 'a faster one lowers it');
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

// ---- 20b. [P8-F design #4] CLEAN TAKE (a CUT at >= tuning.cleanTake with 0 SCRAPE); [P8-F design #5 / ux #5] a street joined past
// its start gate sends one `missed` event per street per take (tuning.missedStart)
{
  resetProgress();
  const ct0 = T.cleanTake;
  const run = (scrape) => {
    const tk = new Take(), d = mk(), evs = [];
    flyTo(tk, d, 21, 10, true, evs);
    if (scrape) { d.lastImpact = 3.5; hold(tk, d, DT, true, evs, 3); d.lastImpact = 0; }
    hold(tk, d, 5, false, evs, 0);
    return { tk, cut: evs.find((e) => e.type === 'cut') };
  };
  T.cleanTake = 0; { const r = run(false); ok(r.cut && !('cleanTake' in r.cut) && !('cleanTake' in r.cut.stats) && r.tk.cleanTake === false, 'cleanTake 0 (bando): the cut event keeps its shape'); }
  T.cleanTake = 1000; { const r = run(false); ok(r.cut?.cleanTake === true && r.cut.stats.cleanTake === true && r.tk.cleanTake, `a CUT at ${r.cut?.total} >= 1000, no SCRAPE: CLEAN TAKE`); }
  { const r = run(true); ok(r.cut && r.cut.cleanTake === false && !r.tk.cleanTake, 'a SCRAPE: no CLEAN TAKE'); }
  T.cleanTake = 1e9; { const r = run(false); ok(r.cut && r.cut.cleanTake === false, 'under the bar: no CLEAN TAKE'); }
  T.cleanTake = ct0;
  const SL = [
    { name: 'S', caption: 'S', pts: 2000, ...gate(40), pre: [gate(-5)], within: 30 },
    { name: 'S 1/2', caption: 'S 1/2', pts: 750, micro: true, seg: 'S', ...gate(20), pre: [gate(-5)], within: 15 },
    { name: 'S 2/2', caption: 'S 2/2', pts: 750, micro: true, seg: 'S', ...gate(40), pre: [gate(20)], within: 15 },
  ];
  const W = { lines: SL, skimBvh };
  const fly = (z0, on, again = false) => {
    const m0 = T.missedStart; T.missedStart = on;
    const tk = new Take(), d = { ...mk(), pos: { x: 0, y: 2, z: z0 } }, evs = [];
    const go = (z1) => { d.vel = { x: 0, y: 0, z: 10 }; while (d.pos.z < z1) { d.pos = { ...d.pos, z: Math.min(z1, d.pos.z + 10 * DT) }; evs.push(...tk.update(DT, d, W, true)); } };
    go(41);
    if (again) { d.pos = { ...d.pos, z: 10 }; tk._last = null; go(41); }   // the same street joined late twice in one take
    T.missedStart = m0; return evs;
  };
  { const e = fly(10, true), m = e.filter((x) => x.type === 'missed');
    ok(m.length === 1 && m[0].name === 'S' && e.some((x) => x.name === 'S 2/2') && !e.some((x) => x.name === 'S' && x.type === 'line'), `joined past the start: one missed S (${JSON.stringify(m)})`); }
  { const e = fly(-20, true); ok(!e.some((x) => x.type === 'missed') && e.some((x) => x.type === 'line' && x.name === 'S'), 'flown from the start gate: S pays, no missed'); }
  { const e = fly(10, false); ok(!e.some((x) => x.type === 'missed'), 'missedStart off (bando): no missed'); }
  { const e = fly(10, true, true); ok(e.filter((x) => x.type === 'missed').length === 1, 'missed once per street per take'); }
  resetProgress();
}

// ---- 20. r5 PERFECT (CUT, 3 stars, every line CLEAN, 0 SCRAPE), perfectLive; C12 ghostPose
{
  resetProgress();
  const stars0 = T.stars; T.stars = [1, 2, 3];
  const run = (scrape, crash) => {
    const tk = new Take(), d = mk(), evs = [];
    flyTo(tk, d, 21, 10, true, evs);
    const live = tk.perfectLive;
    if (scrape) { d.lastImpact = 3.5; hold(tk, d, DT, true, evs, 3); d.lastImpact = 0; }
    if (crash) { d.crashed = true; hold(tk, d, DT, true, evs); return { tk, evs, live }; }
    hold(tk, d, 5, false, evs, 0);
    return { tk, evs, live };
  };
  const a = run(false, false), ca = a.evs.find((e) => e.type === 'cut');
  ok(a.live && a.tk.perfect && ca?.perfect === true && ca.stats.perfect === true && a.tk.progress(world).perfects === 1, 'clean CUT at 3 stars: PERFECT');
  const b = run(true, false), cb = b.evs.find((e) => e.type === 'cut');
  ok(cb && cb.perfect === false && !b.tk.perfect && !b.tk.perfectLive, 'a SCRAPE: no PERFECT');
  const c = run(false, true);
  ok(c.evs.find((e) => e.type === 'crash') && !c.tk.perfect, 'a crash: no PERFECT');
  T.stars = [1, 2, 1e9];
  const e = run(false, false); ok(e.evs.find((x) => x.type === 'cut') && !e.tk.perfect, 'under 3 stars: no PERFECT');
  T.stars = stars0;
  ok(a.tk.progress(world).perfects === 1, 'perfects counted once');
  // ghostPose: the attached ghost at the take clock (0 while ready), alpha passed through while live; null after
  const calls = [];
  const tk = new Take(), d = mk(); tk.ghost = { pose: (t, al) => { calls.push([t, al]); return { pos: [t, 0, 0] }; } };
  ok(tk.ghostPose(0.5).pos[0] === 0 && calls[0][1] === 1, 'ready: ghost at t 0');
  flyTo(tk, d, 1, 10, true);
  const gp = tk.ghostPose(0.25); ok(near(gp.pos[0], tk.stats.time) && calls.at(-1)[1] === 0.25, 'live: ghost at the take time, alpha');
  tk.fail(); ok(tk.ghostPose() === null, 'done: no ghost pose');
  tk.reset(); ok(tk.ghost && tk.ghostPose() !== null, 'the ghost survives reset()');
  ok(new Take().ghostPose() === null, 'no ghost: null');
  resetProgress();
}

// ---- 21. r5 ghost.js (C12): trimmed take log -> second Drone re-sim is bit-exact at the take clock, seeks both ways,
// survives the .otil round trip, refuses another world; GhostKeeper keeps the best CUT. Open air (no geometry), so it
// is quick; needs three (skipped, with a note, where the repo's node_modules aren't there).
{
  let mods = null;
  try { mods = { G: await import(DIR + '/ghost.js'), F: await import(DIR + '/flight.js'), I: await import(DIR + '/inputlog.js'), THREE: await import('three').catch(() => import(DIR + '/node_modules/three/build/three.module.js')) }; }
  catch (e) { console.log('ghost tests skipped (three not resolvable):', e.message); }
  if (mods) {
    const { G: GH, F, I, THREE } = mods, PH = 1 / 240;
    const world = { envelope: { min: new THREE.Vector3(-440, -2, -440), max: new THREE.Vector3(440, 220, 440) } };
    const d = new F.Drone('freestyle5'); d.reset(new THREE.Vector3(0, 40, 0), 0.3);
    const log = new I.InputLog({ seed: d.seed, world: I.worldHash(world), craft: d.key, mode: 'cine', hz: 240, start: d.snapshot() });
    const fake = { ghost: null }, keeper = new GH.GhostKeeper(fake, () => log, () => world);
    const inp = {}, poses = new Map(); let t = null, startK = 0, mode = 'cine';
    for (let i = 0; i < 240 * 12; i++) {
      const s = i / 240;
      mode = s < 7 ? 'cine' : 'angle';
      I.quantize({ thr: mode === 'cine' ? 0.4 : 0.45 + 0.1 * Math.sin(s), pitch: i < 300 ? 0 : 0.5 + 0.4 * Math.sin(s * 1.3), roll: 0.6 * Math.sin(s * 0.7), yaw: 0.3 * Math.cos(s * 0.5), climb: 0.5 * Math.sin(s * 0.9) }, inp);
      log.record(inp, mode, d); d.step(PH, inp, mode, world);
      if (i === 300) { keeper.event({ type: 'start' }); t = 0; startK = log.ticks - 1; }
      if (t !== null) { t += PH; poses.set(Math.round(t * 240), [d.pos.x, d.pos.y, d.pos.z]); }
    }
    const endK = log.ticks, e = { type: 'cut', total: 123456, stars: 2, perfect: false, stats: { time: t, lines: [{ name: 'A', t: 1.5 }] } };
    await keeper._loading;
    keeper.event(e);
    const rec = keeper.best;
    ok(rec && rec.total === 123456 && rec.startTick >= 0 && rec.startTick < 240 && rec.bytes.length < log.toBytes().length, `GhostKeeper keeps the CUT as best (startTick ${rec?.startTick}, ${rec?.bytes.length} B)`);
    ok(fake.ghost && fake.ghost.k === rec.startTick, 'the ghost is attached and parked at the take start');
    const same = (g, n) => { const p = g.pose(n / 240), q = poses.get(n); return p && q && p.pos[0] === q[0] && p.pos[1] === q[1] && p.pos[2] === q[2]; };
    const g = fake.ghost, ns = [1, 2, 240, 1000, 1700, 1690, 3, 2000, (endK - startK) - 1];
    ok(ns.every((n) => same(g, n)), 'ghost pose = the take, bit for bit, forwards, backwards and across the mode switch');
    const p0 = g.pose(10 / 240, 0), pa = poses.get(9); ok(p0.pos[0] === pa[0] && p0.pos[2] === pa[2], 'alpha 0 = the previous tick');
    ok(g.pose(1e4).done && !g.pose(1).done, 'done past its end');
    const r2 = await GH.recordFromBytes(rec.bytes);
    ok(r2.total === 123456 && r2.startTick === rec.startTick && r2.lines[0][0] === 'A' && same(new GH.Ghost(r2, world), 1500), '.otil round trip (a CHALLENGE file) replays the same');
    const bad = I.InputLog.fromBytes(rec.bytes); bad.header.world = 'other';
    const gs = new GH.Ghost({ ...rec, _log: bad }, world); ok(gs.stale && gs.pose(1) === null, 'another world: stale, no pose');
    keeper.event({ type: 'start' }); keeper.event({ ...e, total: 5 });
    ok(keeper.best.total === 123456 && keeper.last.total === 5, 'a lower CUT is kept as last, not best');
    ok(GH.challengeText(rec).includes('123,456') && GH.challengeText(rec).includes('★★'), 'challenge text');
    ok((await keeper.load(new Uint8Array([1, 2, 3]))) === null && keeper.error, 'garbage challenge refused');
    ok((await keeper.load(rec.bytes)) && keeper.rival && fake.ghost.rec.total === 123456, 'a challenge becomes the ghost');
  }
}

// [S0] per-level progress: bando keeps the original keys, another level gets its own (@id) and they never mix
{
  const TL = await import(DIR + '/take.js');
  if (typeof TL.setProgressLevel === 'function') {
    TL.setProgressLevel('bando'); resetProgress();
    store['onetake.lines'] = JSON.stringify({ 'CHIMNEY DIVE': { n: 2, flow: 3, pts: 9000 } }); store['onetake.best'] = '150000';
    TL.setProgressLevel('bando');
    const tb = new Take();
    ok(tb.best === 150000, 'bando best from onetake.best (the original key)');
    TL.setProgressLevel('seoul-hongdae'); tb.reloadBest();
    ok(tb.best === 0 && TL.progressLevel() === 'seoul-hongdae', 'another level starts with no best');
    store['onetake.best@seoul-hongdae'] = '7000'; tb.reloadBest();
    ok(tb.best === 7000, 'its best is onetake.best@seoul-hongdae');
    resetProgress();
    ok(!('onetake.best@seoul-hongdae' in store) && store['onetake.best'] === '150000' && 'onetake.lines' in store, 'resetting one level leaves bando alone');
    TL.setProgressLevel('bando'); tb.reloadBest();
    ok(tb.best === 150000, 'back on bando: its best again');
    resetProgress();
  }
}

// [P2-F1] per-level tuning, armed lines + armHold, firstR, set-piece gating, microFlow, movers (HEADS / crash by)
{
  const TL = await import(DIR + '/take.js');
  if (typeof TL.mergeTuning === 'function') {
    resetProgress();
    ok(TL.mergeTuning(null) === T && TL.mergeTuning(undefined) === T, 'no tuning: TAKE_TUNING itself (bando bit-exact)');
    const mt = TL.mergeTuning({ stars: [10, 20, 30], bankT: 7, bogus: 1, holdZone: 'x', pace: [1, 2] });
    ok(mt.bankT === 7 && mt.stars[2] === 30 && !('bogus' in mt) && mt.holdZone === T.holdZone && mt.pace === T.pace && T.bankT === 5, 'merge: known keys of the right type only; TAKE_TUNING untouched');
    ok(starsFor(25, [10, 20, 30]) === 2 && starsFor(70000) === 1, 'starsFor takes a threshold list');
    // a level world: micro M adds no FLOW, the bank timer waits while A is armed, stars [1000, 2000, 3000]
    const tun = { stars: [1000, 2000, 3000], armHold: true, bankT: 2, microFlow: 0, firstR: 30 };
    const W = { lines: [
      { name: 'A', caption: 'A', pts: 1000, ...gate(0), pre: [gate(-5)], within: 20 },
      { name: 'M', caption: 'M', pts: 500, micro: true, ...gate(-2, { two: true }) },
      { name: 'P', caption: 'P', pts: 500, piece: 'station-stairs', ...gate(10) },
    ], skimBvh, tuning: tun, takeStart: { pos: { x: 0, y: 2, z: -20 } } };
    const tk = new Take(), d = mk(), evs = [];
    const fly = (z1, v = 10) => { d.vel = { x: 0, y: 0, z: Math.sign(z1 - d.pos.z) * v }; while (Math.abs(z1 - d.pos.z) > 1e-6) { const s = Math.min(v * DT, Math.abs(z1 - d.pos.z)); d.pos = { ...d.pos, z: d.pos.z + Math.sign(z1 - d.pos.z) * s }; evs.push(...tk.update(DT, d, W, true)); } };
    fly(-4);
    const ar = tk.armed;
    ok(ar && ar.name === 'A' && ar.within === 20 && ar.left > 19 && ar.left <= 20 && !ar.repeat, `armed after the pre-gate: ${JSON.stringify(ar)}`);
    ok(tk.tuning.bankT === 2 && tk.tuning.stars[0] === 1000, 'take.tuning = the level tuning after an update');
    fly(-1);
    const m = evs.find((e) => e.name === 'M');
    ok(m && m.flow === 1 && tk.flow === 1, 'microFlow 0: the micro scores at x1 and FLOW stays x1');
    // crawl 5 s (hands on, slow): armed, so no bank (bankT 2)
    for (let i = 0; i < Math.round(5 / DT); i++) evs.push(...tk.update(DT, d, W, true));
    ok(!evs.some((e) => e.type === 'bank') && tk.unbanked > 0, 'armHold: no bank while A is armed');
    fly(1);
    const a = evs.find((e) => e.name === 'A');
    ok(a && a.flow === 1 && tk.flow === 2 && tk.armed === null, 'A scores, FLOW +1, nothing armed');
    fly(12);
    ok(!evs.some((e) => e.name === 'P'), 'a set-piece line without world.setPieces is skipped');
    for (let i = 0; i < Math.round(3 / DT); i++) evs.push(...tk.update(DT, d, W, true));
    ok(evs.some((e) => e.type === 'bank'), 'disarmed: the bank timer runs again');
    ok(tk.stars === starsFor(tk.total, [1000, 2000, 3000]) && tk.progress(W).stars === starsFor(tk.best, [1000, 2000, 3000]), 'stars from the level thresholds');
    // the piece exists: P flies
    const W2 = { ...W, setPieces: [{ id: 'station-stairs', kind: 'stairs', pos: [0, 0, 10] }] }, tk2 = new Take(), d2 = mk(), e2 = [];
    d2.pos = { x: 0, y: 2, z: 8 }; d2.vel = { x: 0, y: 0, z: 10 };
    for (let z = 8; z < 12; z += 10 * DT) { d2.pos = { ...d2.pos, z }; e2.push(...tk2.update(DT, d2, W2, true)); }
    ok(e2.some((e) => e.name === 'P'), 'with its set piece in world.setPieces the line flies');
    // firstR: a fresh profile far from the start is guided to the nearest line, not the `first` one
    resetProgress();
    const W3 = { lines: [{ name: 'F', caption: 'F', pts: 1000, first: true, ...gate(0) }, { name: 'N', caption: 'N', pts: 1000, ...gate(200) }], skimBvh, tuning: { firstR: 60 }, takeStart: { pos: { x: 0, y: 2, z: -5 } } };
    const tk3 = new Take(), d3 = mk();
    ok(tk3.nextHint(d3, W3)?.name === 'F', 'near the start: the first line');
    d3.pos = { x: 0, y: 2, z: 190 };
    ok(tk3.nextHint(d3, W3)?.name === 'N', 'past firstR: the nearest line');
    ok(new Take().nextHint(d3, { ...W3, tuning: null })?.name === 'F', 'no firstR (bando): the first line from anywhere');
    // movers: a new pedestrian contact is SCRAPE + HEADS! (once per scrapeCool), a vehicle crash names its type
    const tk4 = new Take(), d4 = mk(); d4.moverN = 0; d4.moverKind = null; const e4 = [];
    const W4 = { lines: [{ name: 'B', caption: 'B', pts: 2000, ...gate(20) }], skimBvh };
    d4.pos = { x: 0, y: 2, z: 15 }; d4.vel = { x: 0, y: 0, z: 10 };
    for (let z = 15; z < 22; z += 10 * DT) { d4.pos = { ...d4.pos, z }; e4.push(...tk4.update(DT, d4, W4, true)); }
    d4.moverN = 1; d4.moverKind = 'pedestrian'; d4.moverImpact = 1.2; e4.push(...tk4.update(DT, d4, W4, true));
    d4.moverN = 2; e4.push(...tk4.update(DT, d4, W4, true));
    const hs = e4.filter((e) => e.type === 'scrape' && e.heads);
    ok(hs.length === 1 && hs[0].lost === 1 && hs[0].flow === 1 && hs[0].impact === 1.2, `a pedestrian: one HEADS! scrape, FLOW -1 (${JSON.stringify(hs[0])})`);
    d4.crashed = true; d4.crashBy = 'bus'; const ce = tk4.update(DT, d4, W4, true).find((e) => e.type === 'crash');
    ok(ce && ce.by === 'bus', 'a crash into a mover names it (by: bus)');
    const tk5 = new Take(), d5 = mk(); d5.crashed = false; tk5.update(DT, d5, W4, true); d5.crashed = true;
    ok(!('by' in tk5.update(DT, d5, W4, true).find((e) => e.type === 'crash')), 'a plain crash has no `by` (event shape unchanged)');
    // [P3-F1 design #6] a `heads` line (pre-gate at z 10, gate at z 20): a HEADS! between them voids it; a plain line is kept
    for (const heads of [true, false]) {
      resetProgress();
      const tk6 = new Take(), d6 = mk(); d6.moverN = 0; d6.moverKind = null; const e6 = [];
      const W6 = { lines: [{ name: 'Q', caption: 'Q', pts: 750, micro: true, ...(heads ? { heads: true } : {}), ...gate(20), pre: [gate(10)], within: 6 }], skimBvh };
      d6.pos = { x: 0, y: 2, z: 5 }; d6.vel = { x: 0, y: 0, z: 10 };
      for (let z = 5; z < 24; z += 10 * DT) { d6.pos = { ...d6.pos, z }; if (Math.abs(z - 15) < 1e-3 + 10 * DT / 2) { d6.moverN = 1; d6.moverKind = 'pedestrian'; d6.moverImpact = 0.8; } e6.push(...tk6.update(DT, d6, W6, true)); }
      const sc = e6.find((e) => e.type === 'scrape' && e.heads), fired = e6.some((e) => e.type === 'line' && e.name === 'Q');
      if (heads) ok(sc && JSON.stringify(sc.voids) === '["Q"]' && !fired, `a HEADS! over the queue voids the move (voids ${JSON.stringify(sc?.voids)}, line ${fired ? 'fired' : 'void'})`);
      else ok(sc && !sc.voids && fired, 'a HEADS! on a plain line: the line still fires (no voids)');
    }
    resetProgress();
  }
}

// [P4-F1] one HEADS! per contact cluster (headsGrace), a void inside the grace, the speed bonus on `par` lines (timed events,
// best times), a start point's hint.r
{
  const TL = await import(DIR + '/take.js');
  if ('headsGrace' in T && 'fastBonus' in T) {
    resetProgress();
    // two pedestrian contacts 0.7 s apart (phase 3: two stamps, 2 FLOW in BAR ALLEY), then one 1.2 s after the first
    const W = { lines: [{ name: 'A', caption: 'A', pts: 1000, ...gate(10) }, { name: 'B', caption: 'B', pts: 1000, ...gate(20) }, { name: 'C', caption: 'C', pts: 1000, ...gate(30) }], skimBvh };
    const tk = new Take(), d = mk(), ev = []; d.moverN = 0; d.moverKind = null;
    d.pos = { x: 0, y: 2, z: 5 }; d.vel = { x: 0, y: 0, z: 10 };
    for (let z = 5; z < 34; z += 10 * DT) { d.pos = { ...d.pos, z }; ev.push(...tk.update(DT, d, W, true)); }
    ok(tk.flow === 4, `three lines: FLOW x${tk.flow}`);
    const touch = (n) => { d.moverN = n; d.moverKind = 'pedestrian'; d.moverImpact = 0.9; ev.push(...tk.update(DT, d, W, true)); };
    const wait = (s) => { for (let i = 0; i < Math.round(s / DT); i++) ev.push(...tk.update(DT, d, W, true)); };
    touch(1); wait(0.7); touch(2);
    let hs = ev.filter((e) => e.type === 'scrape' && e.heads);
    ok(hs.length === 1 && tk.flow === 3 && tk.stats.scrapes === 1, `two contacts 0.7 s apart: one HEADS!, FLOW -1 once (${hs.length} stamps, FLOW x${tk.flow})`);
    wait(0.5); touch(3);
    hs = ev.filter((e) => e.type === 'scrape' && e.heads);
    ok(hs.length === 2 && tk.flow === 2, `a contact 1.2 s after the stamp is a new HEADS! (${hs.length} stamps, FLOW x${tk.flow})`);
    // a heads line armed inside the grace: the contact voids it with a 'void' event (no stamp)
    resetProgress();
    const W2 = { lines: [{ name: 'Q', caption: 'Q', pts: 750, micro: true, heads: true, ...gate(20), pre: [gate(10)], within: 6 }], skimBvh };
    const tk2 = new Take(), d2 = mk(), e2 = []; d2.moverN = 0; d2.moverKind = null;
    d2.pos = { x: 0, y: 2, z: 5 }; d2.vel = { x: 0, y: 0, z: 10 };
    for (let z = 5; z < 24; z += 10 * DT) {
      d2.pos = { ...d2.pos, z };
      if (Math.abs(z - 8) < 1e-3 + 10 * DT / 2) { d2.moverN = 1; d2.moverKind = 'pedestrian'; }        // a stamp before the pre-gate
      if (Math.abs(z - 15) < 1e-3 + 10 * DT / 2) d2.moverN = 2;                                         // 0.7 s later, armed
      e2.push(...tk2.update(DT, d2, W2, true));
    }
    const v = e2.find((e) => e.type === 'void');
    ok(e2.filter((e) => e.type === 'scrape').length === 1 && v && JSON.stringify(v.voids) === '["Q"]' && !e2.some((e) => e.name === 'Q' && e.type === 'line'),
      `inside the grace a contact still voids the armed heads line: {type: 'void', voids: ${JSON.stringify(v?.voids)}}, one stamp`);
    // the speed bonus: a 40 m `par` line (par 5 s, within 15 s) flown in 5 s pays x1.5 and is FAST; in 13 s x1.1, not FAST
    const run = (v, tun) => {
      const Wp = { lines: [{ name: 'S', caption: 'S', pts: 1000, ...gate(40), pre: [gate(0)], within: 15, par: 5 }], skimBvh, tuning: tun };
      const t = new Take(), dd = mk(), out = []; dd.pos = { x: 0, y: 2, z: -2 }; dd.vel = { x: 0, y: 0, z: v };
      for (let z = -2; z < 42; z += v * DT) { dd.pos = { ...dd.pos, z }; out.push(...t.update(DT, dd, Wp, true)); }
      return out.find((e) => e.name === 'S');
    };
    resetProgress();
    const fast = run(8, { timed: true }), slow = run(40 / 13, { timed: true });
    ok(fast && Math.abs(fast.dur - 5) < 0.05 && fast.speed === 1.5 && fast.fast && fast.pts === Math.round(1000 * 1.25 * 1.5) && fast.best === 0 && fast.newBest,
      `at par: x1.5, FAST (${JSON.stringify(fast && { dur: fast.dur, speed: fast.speed, fast: fast.fast, pts: fast.pts, best: fast.best })})`);
    ok(slow && slow.speed === 1.1 && !slow.fast && Math.abs(slow.best - fast.dur) < 1e-9 && !slow.newBest && slow.pts === Math.round(1000 * 1.25 * 1.1),
      `13 s of a 15 s window: x1.1, no FAST, best = the 5 s run (${JSON.stringify(slow && { dur: slow.dur, speed: slow.speed, best: slow.best })})`);
    ok(new Take().lineList({ lines: [{ name: 'S', caption: 'S', pts: 1000, ...gate(40), pre: [gate(0)], within: 15, par: 5 }], skimBvh }).find((l) => l.name === 'S').bestDur === fast.dur, 'lineList carries the best time (bestDur)');
    // [P5-F design #4 / UX #5] bankBonus: the street's k pays on its micros too (they score x1 themselves); fastPar: FAST
    // only within par x fastPar
    if ('bankBonus' in T) {
      const runB = (v, tun) => {
        const Wb = { lines: [{ name: 'S', caption: 'S', pts: 1000, ...gate(40), pre: [gate(0)], within: 15, par: 5 },
          { name: 'S 1/2', caption: 'S 1/2', pts: 500, micro: true, seg: 'S', ...gate(20), pre: [gate(0)], within: 8, par: 2.5 },
          { name: 'S 2/2', caption: 'S 2/2', pts: 500, micro: true, seg: 'S', ...gate(40), pre: [gate(20)], within: 8, par: 2.5 }], skimBvh, tuning: tun };
        const t = new Take(), dd = mk(), out = []; dd.pos = { x: 0, y: 2, z: -2 }; dd.vel = { x: 0, y: 0, z: v };
        for (let z = -2; z < 42; z += v * DT) { dd.pos = { ...dd.pos, z }; out.push(...t.update(DT, dd, Wb, true)); }
        return out;
      };
      resetProgress();
      const B = runB(8, { timed: true, bankBonus: true, fastBonus: 1.0, fastPar: 1.15, microFlow: 0 }), s = B.find((e) => e.name === 'S'), m = B.filter((e) => e.micro);
      const mp = m.reduce((a, e) => a + e.pts, 0);
      ok(m.length === 2 && m.every((e) => e.speed === 1 && e.fast) && s && s.speed === 2 && s.bonus === mp && s.pts === Math.round(1000 * 1.25 * 2) + mp,
        `bankBonus at par: micros x1 (${m.map((e) => e.pts)}), the street x2 + its micros again (bonus ${s?.bonus}, pts ${s?.pts})`);
      resetProgress();
      const Bs = runB(40 / 7, { timed: true, bankBonus: true, fastBonus: 1.0, fastPar: 1.15, microFlow: 0 }), ss = Bs.find((e) => e.name === 'S');
      ok(ss && !ss.fast && ss.dur > 5 * 1.15 && ss.speed > 1 && ss.bonus > 0, `7 s for a 5 s par: paid x${ss?.speed} but no FAST (par x 1.15 = 5.75 s)`);
      resetProgress();
      const Bo = runB(8, { timed: true }), so = Bo.find((e) => e.name === 'S');
      resetProgress();
      const Bc = runB(40 / 8.4, { timed: true, bankBonus: true, fastBonus: 1.0, slowPar: 1.6, fastPar: 1.15, microFlow: 0 }), sc = Bc.find((e) => e.name === 'S');
      ok(sc && sc.speed === 1 && !sc.bonus, `slowPar 1.6: 8.4 s for a 5 s par (a careful pilot) pays x${sc?.speed}, no bonus`);
      ok(so && !('bonus' in so) && so.speed === 1.5 && Bo.filter((e) => e.micro).every((e) => e.speed === 1.5), 'bankBonus off (phase 4): every timed line its own x1.5, no bonus');
    }
    // no par, not timed (bando): the event keeps its shape
    resetProgress();
    const plain = (() => { const Wp = { lines: [{ name: 'S', caption: 'S', pts: 1000, ...gate(40), pre: [gate(0)], within: 15 }], skimBvh }, t = new Take(), dd = mk(), out = [];
      dd.pos = { x: 0, y: 2, z: -2 }; dd.vel = { x: 0, y: 0, z: 8 }; for (let z = -2; z < 42; z += 8 * DT) { dd.pos = { ...dd.pos, z }; out.push(...t.update(DT, dd, Wp, true)); } return out.find((e) => e.name === 'S'); })();
    ok(plain && !('dur' in plain) && !('speed' in plain) && plain.pts === 1250, 'no par and not timed: no speed bonus, no timing fields');
    // hint.r: the start point's `next` line holds the arrow within r m (default 6)
    resetProgress();
    const W5 = { lines: [{ name: 'F', caption: 'F', pts: 1000, ...gate(60), pre: [gate(50)], within: 20 }, { name: 'N', caption: 'N', pts: 1000, ...gate(30) }], skimBvh,
      startPoints: [{ name: 'S', pos: [0, 2, 0], hint: { text: 'N FIRST', line: 'N', until: 2, next: 'N', r: 20 } }] };
    const tk5 = new Take(), d5 = mk(); d5.pos = { x: 0, y: 2, z: 15 };
    ok(tk5.nextHint(d5, W5)?.name === 'N', 'within hint.r of the start: its `next` line');
    d5.pos = { x: 0, y: 2, z: 48 };
    ok(tk5.nextHint(d5, W5)?.name === 'F', 'beyond hint.r: the nearest line again');
    d5.pos = { x: 0, y: 2, z: 15 };
    ok(tk5.nextHint(d5, { ...W5, startPoints: [{ ...W5.startPoints[0], hint: { ...W5.startPoints[0].hint, r: undefined } }] })?.name === 'N' && new Take().nextHint({ ...d5, pos: { x: 0, y: 2, z: 7 } }, { ...W5, startPoints: [{ ...W5.startPoints[0], hint: { ...W5.startPoints[0].hint, r: undefined } }] })?.name === 'N', 'no r: 6 m (then the nearest, N here too)');
    resetProgress();
    // [P6-F design #5 / ux #1] a `blocked` line is never the guide's target: not as the nearest, not as `first`, not as a start
    // point's `next`; lineList marks it; it still scores when flown
    if ('clipGrace' in T) {
      const Wb = { lines: [{ name: 'X', caption: 'X', pts: 2000, blocked: true, first: true, ...gate(10), pre: [gate(5)], within: 8 }, { name: 'Y', caption: 'Y', pts: 1000, ...gate(60), pre: [gate(50)], within: 20 }], skimBvh,
        takeStart: { pos: [0, 2, 0] }, startPoints: [{ name: 'S', pos: [0, 2, 0], hint: { text: 'X', line: 'X', until: 2, next: 'X', r: 30 } }] };
      const tb = new Take(), db = mk(); db.pos = { x: 0, y: 2, z: 0 };
      ok(tb.nextHint(db, Wb)?.name === 'Y', `a blocked line is skipped by every rule (got ${tb.nextHint(db, Wb)?.name}, the 10 m X is blocked)`);
      ok(tb.lineList(Wb).find((l) => l.name === 'X')?.blocked === true && !('blocked' in tb.lineList(Wb).find((l) => l.name === 'Y')), 'lineList marks the blocked line');
      const eb = []; db.vel = { x: 0, y: 0, z: 8 }; for (let z = 0; z < 12; z += 8 * DT) { db.pos = { ...db.pos, z }; eb.push(...tb.update(DT, db, Wb, true)); }
      ok(eb.some((e) => e.type === 'line' && e.name === 'X'), 'a blocked line still scores when flown');
      resetProgress();
      // [P6-F design #2] the opening's grace: the `first` line's gates count up to clipGrace m outside their edges in the first
      // clipT s: CLIPPED, x1, but flown (FLOW +1, the chain kept); a line without `first`, or later than clipT, gets none
      const runC = (y, first, tun, t0 = 0) => {
        const Wc = { lines: [{ name: 'O', caption: 'O', pts: 1500, ...(first ? { first: true } : {}), ...gate(10, { h: 1 }), pre: [gate(5, { h: 1 })], within: 8 }, { name: 'P', caption: 'P', pts: 1000, ...gate(30), pre: [gate(25)], within: 8 }], skimBvh, tuning: tun };
        const t = new Take(), dd = mk(), out = []; dd.pos = { x: 0, y, z: -40 }; dd.vel = { x: 0, y: 0, z: 8 };
        out.push(...t.update(DT, dd, Wc, true)); for (let k = 0; k < t0 / DT; k++) out.push(...t.update(DT, dd, Wc, true));
        for (let z = -2; z < 32; z += 8 * DT) { dd.pos = { ...dd.pos, z }; out.push(...t.update(DT, dd, Wc, true)); }
        return out;
      };
      const tun = { clipGrace: 0.6, clipT: 20 };
      resetProgress(); const c1 = runC(2.9, true, tun), o1 = c1.find((e) => e.name === 'O'), p1 = c1.find((e) => e.name === 'P');
      ok(o1 && o1.clipped && o1.pts === 1500 && !o1.clean && p1 && p1.flow === 2, `0.4 m over the first gate's top: CLIPPED x1 (${o1?.pts}), and the next line is at FLOW x${p1?.flow}`);
      resetProgress(); const c2 = runC(2.0, true, tun), o2 = c2.find((e) => e.name === 'O');
      ok(o2 && !o2.clipped && o2.pts === Math.round(1500 * 1.25), 'through the middle: a plain line (CLEAN, no CLIPPED)');
      resetProgress(); ok(!runC(2.9, false, tun).some((e) => e.name === 'O'), 'no grace for a line that is not `first`');
      resetProgress(); ok(!runC(2.9, true, tun, 21).some((e) => e.name === 'O'), 'no grace after clipT s of take time');
      resetProgress(); ok(!runC(2.9, true, {}).some((e) => e.name === 'O'), 'no grace without tuning.clipGrace (bando)');
      resetProgress(); ok(!runC(3.2, true, tun).some((e) => e.name === 'O'), '0.7 m over: outside the 0.6 m grace');
      // [P6-F ux #3] hintVertReady: at 'ready' a target 5 m across and 2 m down is DOWN; once live, the 3 m rule again
      const Wv = { lines: [{ name: 'V', caption: 'V', pts: 1000, ...gate(5, { c: [0, 0, 5] }) }], skimBvh, tuning: { hintVertReady: 6 } };
      const tv = new Take(), dv = mk(); dv.pos = { x: 0, y: 2, z: 0 };
      ok(tv.nextHint(dv, Wv)?.vert === 'down', `ready: DOWN within 6 m (got ${tv.nextHint(dv, Wv)?.vert})`);
      tv.update(DT, dv, Wv, true);
      ok(tv.state === 'live' && tv.nextHint(dv, Wv)?.vert === null, 'live: the 3 m rule (no DOWN at 5 m across)');
      resetProgress();
    }
  }
}

// [P5-F design #3] the star fit's evidence: tests/seoul/take-sim.json (seoul/tools/take-sim.mjs --record) against lines.json's
// stars. Phase 4's [18k, 60k, 150k] gave a careful long take 3 stars in 3 of 4 runs: careful long <= 2 stars in every run (its
// p75 of 4 is the best run), regular long 3 at its p50, and the record is of these lines (else: re-record)
{
  const fs = await import('node:fs'), { createHash } = await import('node:crypto');
  const LJp = DIR + '/seoul/lines.json', Rp = DIR + '/tests/seoul/take-sim.json';
  if (fs.existsSync(LJp) && fs.existsSync(Rp)) {
    const LJ = JSON.parse(fs.readFileSync(LJp, 'utf8')), R = JSON.parse(fs.readFileSync(Rp, 'utf8')), st = LJ.tuning.stars;
    const h = createHash('sha256').update(JSON.stringify({ lines: LJ.lines, tuning: LJ.tuning, takeStart: LJ.takeStart })).digest('hex').slice(0, 16);
    ok(R.lines === h, `tests/seoul/take-sim.json is of this lines.json (${R.lines} vs ${h}; re-record: node seoul/tools/take-sim.mjs --runs 8 --record)`);
    // [P7-F design #6] every route of the record's set, none dropped (phase 6: stage1 printed NO PATH and quietly left the record)
    { const SET = ['short', 'walk', 'loop', 'long', 'hongik', 'hub', 'stairs', 'stairs-nodive', 'pop', 'pass', 'stage0', 'stage1', 'thread0', 'thread1', 'shelter0', 'shelter2', 'slot0', 'gap'];
      ok(Array.isArray(R.dropped) && R.dropped.length === 0, `take-sim dropped no route x pilot (${JSON.stringify(R.dropped)}: NO PATH fails the record)`);
      const miss = SET.flatMap((r) => ['careful', 'regular', 'sharp'].map((p) => `${r}/${p}`)).filter((k) => !(R.results[k]?.runs >= R.runs));
      ok(miss.length === 0, `the record has every route of the set at ${R.runs}+ runs per pilot (missing or short: ${miss.join(', ') || 'none'})`); }
    const cl = R.results['long/careful'], rl = R.results['long/regular'], sl = R.results['long/sharp'];
    // [P6-F design #3] 8 runs, and the 3-star cut with margin both ways (phase 5: regular p50 291k against a 290k cut)
    ok(R.runs >= 8, `the record is of ${R.runs} runs per pilot x route (>= 8: 4 hid the sharp pilot's bimodal opening)`);
    ok(cl && cl.p75 <= 0.95 * st[2], `careful long p75 ${cl?.p75} <= 0.95 x the 3-star cut ${st[2]}`);
    ok(rl && rl.p50 >= 1.05 * st[2], `regular long p50 ${rl?.p50} >= 1.05 x the 3-star cut ${st[2]}`);
    ok(cl && cl.stars.every((n) => n <= 2) && rl && starsFor(rl.p50, st) === 3, `a careful long take is <= 2 stars in every run (${cl?.stars}); regular 3 at its p50`);
    // [P6-F design #2] monotone skill: sharp p25 >= regular p25 >= careful p25 on the short and long takes
    // [P7-F design #2] + hongik (phase 6: sharp p25 75.2k under regular's 81.1k, scraping the bar alley's pinch)
    for (const r of ['short', 'long', 'hongik']) { const [c, g, s] = ['careful', 'regular', 'sharp'].map((p) => R.results[`${r}/${p}`]?.p25);
      ok(c != null && s >= g && g >= c, `${r}: p25 sharp ${s} >= regular ${g} >= careful ${c}`); }
    // [P6-F design #4 / #6] hongik careful <= 1 crash in 8; hub and hongik caption gaps <= 15 s
    { const hc = R.results['hongik/careful']; ok(hc && hc.crash <= 1, `hongik/careful: ${hc?.crash} crashes in ${hc?.runs} (<= 1; ${JSON.stringify(hc?.by)})`); }
    for (const k of ['hub/careful', 'hub/regular', 'hub/sharp', 'hongik/careful', 'hongik/regular', 'hongik/sharp']) if (R.results[k]) ok(R.results[k].gapMax <= 15, `${k}: caption gap max ${R.results[k].gapMax} s (<= 15)`);
    // [P6-F design #5 / ux #1] no guide target is unflyable: a line the sims fly 0 of N is `blocked` in lines.json, and a blocked
    // line the sims fly >= 10 of 12 should be unblocked (the stair dive, once G1 clears the mouth)
    // [P7-F ux #2 / design #3] the stair dive is guided to only when thumbs can fly it: open needs the dive-model sims >= 10 of 12
    // AND phase 5's pilot (stairs-nodive, no dive model) regular >= 8 of 12; blocked, the no-dive regular must be under 8 of 12
    // (else unblock it)
    { const st0 = ['careful', 'regular', 'sharp'].map((p) => R.results[`stairs/${p}`]).filter(Boolean), n = st0.reduce((a, r) => a + r.runs, 0), got = st0.reduce((a, r) => a + (r.flown ?? 0), 0);
      const nd = R.results['stairs-nodive/regular'], thumbs = !!nd && nd.flown >= Math.ceil(nd.runs * 8 / 12);
      const bl = LJ.lines.some((l) => l.name === 'STATION STAIRS' && l.blocked);
      if (n) ok(bl ? !thumbs : got >= Math.ceil(n * 10 / 12) && thumbs, `STATION STAIRS ${bl ? 'blocked' : 'open'}: dive-model sims ${got} of ${n}, no-dive regular ${nd?.flown} of ${nd?.runs} (${bl ? 'unblock once no-dive regular >= 8 of 12' : 'open needs >= 10 of 12 and no-dive >= 8 of 12'})`); }
    const cw = R.results['walk/careful'], sw = R.results['short/sharp'], cs = R.results['short/careful'];
    ok(cw && starsFor(cw.p50, st) >= 1, `the walking street alone at a careful pace is 1 star (${cw?.p50})`);
    // design #4: speed pays (phase 4: sharp +18 % on WALKING STREET's own pts)
    ok(cs && sw && sw.wsPts >= 1.5 * cs.wsPts, `WALKING STREET pays a sharp pilot >= 1.5x a careful one (${sw?.wsPts} vs ${cs?.wsPts})`);
    // design #1 / #5 / #6: the opening's first x2 by 20 s, no caption gap over 15 s on long and loop, the portals and the stair dive flown
    ok(cs && cs.x2 <= 20, `the first x2 comes at ${cs?.x2} s (careful, short route; phase 4: 211 s following the hint)`);
    for (const k of ['long/careful', 'long/regular', 'long/sharp', 'loop/careful', 'loop/regular', 'loop/sharp']) if (R.results[k]) ok(R.results[k].gapMax <= 15, `${k}: caption gap max ${R.results[k].gapMax} s (<= 15)`);
    // [P7-F design #6] every set-piece line in the record (phase 6: CABLE THREAD, BUS SHELTER, ROOF SLOT and THE GAP weren't), open
    for (const r of ['pop', 'pass', 'stage0', 'stage1', 'thread0', 'thread1', 'shelter0', 'shelter2', 'slot0', 'gap']) { const n = ['careful', 'regular', 'sharp'].reduce((a, p) => a + (R.results[`${r}/${p}`]?.stars ? R.results[`${r}/${p}`].stars.length : 0), 0);
      const got = ['careful', 'regular', 'sharp'].reduce((a, p) => a + (R.results[`${r}/${p}`]?.flown ?? 0), 0);
      ok(n > 0 && got >= Math.ceil(n * 10 / 12), `${r}: flown in ${got} of ${n} sim takes (>= 10 of 12)`);
      // [P8-F design #3] and every pilot >= 7 of 8 on its own (the pooled rule hid pop/regular at 6 of 8)
      for (const pl of ['careful', 'regular', 'sharp']) { const x = R.results[`${r}/${pl}`]; ok(x && x.flown >= Math.ceil(x.runs * 7 / 8), `${r}/${pl}: flown in ${x?.flown} of ${x?.runs} (>= 7 of 8 per pilot)`); } }
    // [P7-F design #1] ROOFLINE joined at its start: long/sharp flies it in >= 7 of 8 (phase 6: 5 of 8, joining at 3/4 off TO THE
    // ROOFLINE 1), and speed pays on the long take at the median (phase 6: sharp 352k, regular 351k)
    { const ls = R.results['long/sharp'], lr = R.results['long/regular'];
      ok(ls && ls.flown >= Math.ceil(ls.runs * 7 / 8), `long/sharp flies ROOFLINE in ${ls?.flown} of ${ls?.runs} (>= 7 of 8)`);
      ok(ls && lr && ls.p50 >= 1.08 * lr.p50, `long: sharp p50 ${ls?.p50} >= 1.08 x regular ${lr?.p50} (${ls && lr ? (ls.p50 / lr.p50).toFixed(3) : '?'}x)`); }
    // [P8-F design #4] CLEAN TAKE is the tier above 3 stars: no careful long run wins it, a sharp one can (>= 1 of 8), and its bar
    // sits over the 3-star cut
    { const ctAt = +LJ.tuning.cleanTake || 0, lc = R.results['long/careful'], ls = R.results['long/sharp'];
      ok(ctAt >= 1.25 * st[2], `CLEAN TAKE at ${ctAt} >= 1.25 x the 3-star cut ${st[2]}`);
      ok(lc && lc.cleanTakes === 0 && ls && ls.cleanTakes >= 1, `CLEAN TAKE: careful long ${lc?.cleanTakes} of ${lc?.runs} (0), sharp long ${ls?.cleanTakes} of ${ls?.runs} (>= 1)`); }
    // [P7-F design #3] the no-dive record is there, at 12 runs (the STATION STAIRS check above reads it)
    { const nd = R.results['stairs-nodive/regular']; ok(nd && nd.runs >= 12, `stairs-nodive/regular recorded at ${nd?.runs} runs (>= 12)`); }
  } else console.log('skip: tests/seoul/take-sim.json or seoul/lines.json missing');
}

console.log(`take tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
