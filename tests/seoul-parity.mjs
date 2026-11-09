// tests/seoul-parity.mjs: Neon Seoul parity vectors for the Swift port (P2 stream H, native #3; PORTING.md G3/G4/G7).
//   node tests/seoul-parity.mjs            check: the committed Seoul log replays, its Take events match, traffic vectors match
//   node tests/seoul-parity.mjs --strict   (CI) a stale log / vector file fails (it says how to re-record)
//   node tests/seoul-parity.mjs --record   re-record tests/seoul/walking.otil + .take.json and tests/seoul/parity.json
//                                          (after an intentional change to world-seoul.js geometry, lines.json, flight.js,
//                                          take.js or seoul-life.js; the integrator does this after merging C / F1 / G)
// Checks:
//  1. tests/seoul/walking.otil: an autopilot flies the WALKING STREET line from its start point in Cine (recorded on the
//     Seoul collider: header.world = world.json hash.collider of the seoul-hongdae export). It replays within 1 mm,
//     continuous and re-synced, and two replays end identical (G3).
//  2. its Take events (ticked as main.js does, after every drone.step) equal tests/seoul/walking.take.json (G4).
//  3. traffic: LifeSim(layout, {seed: 11}) at t = 0, 5, 37.5, 90 s: LifeSim.hash() bit-exact and the first 12 vehicle
//     boxes within 1e-9 m equal tests/seoul/parity.json (G7: the Swift TrafficSim is held to the same vectors); the
//     same values twice, and after a rewind.
// Geometry comes from world-seoul.js buildGeometry({seed}) when it exists, else the same shim export-world uses.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';

const DIR = dirname(fileURLToPath(import.meta.url)), ROOT = join(DIR, '..'), OUT = join(DIR, 'seoul');
const TOL = 0.001, PHYS = 1 / 240, BOX_TOL = 1e-9, SEED = 11;
const STRICT = process.argv.includes('--strict'), RECORD = process.argv.includes('--record');
const sha = (f) => (existsSync(join(ROOT, f)) ? createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex').slice(0, 16) : null);
let fail = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const stale = (m) => { if (STRICT) ok(false, m); else console.log(`STALE ${m}`); };

const { Drone } = await import('../flight.js');
const { Take } = await import('../take.js');
const { InputLog, quantize, replayLog, worldHash } = await import('../inputlog.js');
const { levelGeometry } = await import('../tools/export-world.mjs');
const levels = JSON.parse(readFileSync(join(ROOT, 'levels.json'), 'utf8')), L = levels.find((l) => l.id === 'seoul-hongdae');
const ws = await import(pathToFileURL(join(ROOT, L.module.replace(/^\.\//, ''))).href);
const { geo, entry } = await levelGeometry(ws, L, SEED);
const toV = (v) => (v?.isVector3 ? v : new THREE.Vector3(...v));
const env = geo.envelope ? { min: toV(geo.envelope.min), max: toV(geo.envelope.max) } : null;
const WORLD = { bvh: geo.bvh, envelope: env, ...(geo.funnels?.length ? { funnels: geo.funnels } : {}) };
const HASH = worldHash(WORLD);
const SOURCES = { geometry: sha('world-seoul.js'), lines: sha('seoul/lines.json'), layout: sha('seoul/layout.json'), flight: sha('flight.js'), take: sha('take.js'), life: sha('seoul-life.js') };
console.log(`seoul collider ${HASH} (${entry}), ${geo.lines?.length ?? 0} lines`);

// ---------------------------------------------------------------- 1 + 2. the WALKING STREET log
// autopilot: Cine, steer the heading at the next waypoint (start -> pre-gates -> gate -> 25 m past it), hold the
// waypoint height, moderate stick. It reads the drone state only while recording; the log stores the inputs.
const cl = (v) => Math.max(-1, Math.min(1, v));
function route(name) {
  const l = (geo.lines || []).find((x) => x.name === name && x.pre?.length) || (geo.lines || []).find((x) => x.pre?.length);
  if (!l) return null;
  const sp = (geo.startPoints || []).find((s) => s.hint?.line === l.name) || geo.startPoints?.[0] || geo.takeStart || geo.spawn;
  const a = l.pre[l.pre.length - 1].c, wps = [...l.pre.map((p) => p.c), ...streetBetween(a, l.c), l.c, [l.c[0] + l.n[0] * 25, l.c[1], l.c[2] + l.n[2] * 25]];
  return { line: l.name, start: sp.pos, yaw: sp.yaw ?? 0, wps };
}
// the centreline vertices of the street that runs from gate a to gate b (layout L1), at the gates' height: the line
// follows the street's bends, a straight a -> b cuts through the corner buildings
function streetBetween(a, b) {
  const proj = (P, x, z) => { let best = { d: Infinity, s: 0 }, s = 0;
    for (let i = 0; i < P.length - 1; i++) { const [ax, az] = P[i], [bx, bz] = P[i + 1], vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1e-9, t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2)), d = Math.hypot(x - ax - t * vx, z - az - t * vz), L = Math.sqrt(l2);
      if (d < best.d) best = { d, s: s + t * L }; s += L; } return best; };
  let best = null;
  for (const st of geo.layout?.streets || []) { const pa = proj(st.points, a[0], a[2]), pb = proj(st.points, b[0], b[2]), d = Math.max(pa.d, pb.d); if (!best || d < best.d) best = { d, st, sa: pa.s, sb: pb.s }; }
  if (!best || best.d > best.st.width) return [];
  const out = []; let s = 0; const P = best.st.points, lo = Math.min(best.sa, best.sb), hi = Math.max(best.sa, best.sb);
  for (let i = 0; i < P.length; i++) { if (i) s += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); if (s > lo + 3 && s < hi - 3) out.push({ s, p: P[i] }); }
  if (best.sa > best.sb) out.reverse();
  return out.map(({ s: si, p }) => [p[0], a[1] + (b[1] - a[1]) * (si - best.sa) / (best.sb - best.sa || 1), p[1]]);
}
function record(R) {
  const d = new Drone('freestyle5'); d.reset(new THREE.Vector3(...R.start), R.yaw);
  const log = new InputLog({ seed: d.seed, world: HASH, craft: d.key, mode: 'cine', hz: 240, start: d.snapshot(), meta: { script: 'seoul-walking', line: R.line, level: 'seoul-hongdae' } });
  let k = 0, last = -1; const inp = {}, secs = 40;
  for (let i = 0; i < secs * 240; i++) {
    let w = R.wps[k];
    while (k < R.wps.length - 1 && Math.hypot(d.pos.x - w[0], d.pos.z - w[2]) < 4) w = R.wps[++k];
    if (k === R.wps.length - 1 && last < 0) last = i;
    if (last >= 0 && i - last > 240 * 5) break;   // 5 s past the run-out point: the line banks
    const want = Math.atan2(-(w[0] - d.pos.x), -(w[2] - d.pos.z));
    let err = want - d.heading; err = Math.atan2(Math.sin(err), Math.cos(err));
    const s = { mode: 'cine', thr: 0.4, pitch: cl(0.55 * Math.max(0.2, Math.cos(err))), roll: 0, yaw: cl(-err * 1.6), climb: cl((w[1] - d.pos.y) * 0.6) };
    quantize(s, inp); log.record(inp, 'cine', d);
    d.step(PHYS, inp, 'cine', WORLD);
    if (d.crashed && i > 240) { log.record(inp, 'cine', d); break; }
  }
  return { log, d };
}
const STICK_EPS = 2e-3;
function takeEvents(log) {
  const take = new Take(), tw = { lines: geo.lines || [], skimBvh: geo.skimBvh, funnels: WORLD.funnels ?? null };
  const ev = [], first = {}; log.input(0, first);
  let thrRef = first.thr ?? 0;
  replayLog(log, new Drone(log.header.craft), WORLD, { onTick: (i, d, inp, mode) => {
    const dt = 1 / log.header.hz, dth = inp.thr - thrRef; thrRef += dth * Math.min(1, dt / 0.5);
    const steer = Math.max(Math.abs(inp.pitch), Math.abs(inp.roll), Math.abs(inp.yaw)) > STICK_EPS;
    const moved = steer || (mode === 'cine' ? Math.abs(inp.climb) > STICK_EPS : Math.abs(dth) > 0.04);
    for (const e of take.update(dt, d, tw, { hands: moved, moved, steer })) ev.push({ tick: i, ...JSON.parse(JSON.stringify(e)) });
  } });
  return { events: ev, total: take.total, state: take.state };
}
const sameEv = (a, b) => {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.join() === kb.join() && ka.every((k) => sameEv(a[k], b[k]));
};

const LOG = join(OUT, 'walking.otil'), TAKE = join(OUT, 'walking.take.json'), PAR = join(OUT, 'parity.json');
if (RECORD) {
  mkdirSync(OUT, { recursive: true });
  const R = route('WALKING STREET');
  if (!R) ok(false, 'no line with a pre-gate in lines.json: nothing to fly');
  else {
    const { log, d } = record(R);
    writeFileSync(LOG, log.toBytes());
    const t = takeEvents(log);
    writeFileSync(TAKE, JSON.stringify({ log: 'walking.otil', world: HASH, sources: SOURCES, sticks: 'main.js sticksActive, no touches; thrRef starts at the first tick', ...t }, null, 1) + '\n');
    console.log(`recorded tests/seoul/walking.otil: ${log.ticks} ticks (${(log.ticks / 240).toFixed(1)} s), end ${d.pos.toArray().map((v) => v.toFixed(1))}, crashed ${d.crashed}; ` +
      `${t.events.length} take events (${[...new Set(t.events.map((e) => e.type))].join(', ') || 'none'}), lines ${t.events.filter((e) => e.type === 'line').map((e) => e.name).join(', ') || 'none'}, total ${t.total}`);
  }
}
if (!existsSync(LOG)) stale('tests/seoul/walking.otil missing: node tests/seoul-parity.mjs --record');
else {
  const log = InputLog.fromBytes(readFileSync(LOG));
  if (log.header.world !== HASH) stale(`tests/seoul/walking.otil was recorded on collider ${log.header.world}, the Seoul collider is now ${HASH} (geometry changed): re-record with --record`);
  else {
    const a = replayLog(log, new Drone(log.header.craft), WORLD), b = replayLog(log, new Drone(log.header.craft), WORLD, { resync: true }), c = replayLog(log, new Drone(log.header.craft), WORLD);
    ok(a.maxErr <= TOL, `walking.otil (${(log.ticks / 240).toFixed(1)} s, ${a.snaps} snapshots): continuous max error ${(a.maxErr * 1000).toFixed(3)} mm`);
    ok(b.maxErr <= TOL, `walking.otil: re-synced max error ${(b.maxErr * 1000).toFixed(3)} mm`);
    ok(JSON.stringify(a.final) === JSON.stringify(c.final), 'walking.otil: two replays end in identical state');
    const exp = existsSync(TAKE) ? JSON.parse(readFileSync(TAKE, 'utf8')) : null;
    if (!exp) stale('tests/seoul/walking.take.json missing: --record');
    else {
      const got = takeEvents(log), k = got.events.findIndex((e, i) => !sameEv(e, exp.events[i]));
      const same = k < 0 && got.events.length === exp.events.length && got.total === exp.total;
      const changed = Object.keys(SOURCES).filter((s) => exp.sources?.[s] !== SOURCES[s]);
      const msg = `walking.otil: Take parity, ${got.events.length} events (${[...new Set(got.events.map((e) => e.type))].join(', ') || 'none'}), total ${got.total}`;
      if (same) ok(true, msg);
      else if (changed.length) stale(`${msg}: differs at event ${k}, and ${changed.join(', ')} changed since recorded: if intentional, --record`);
      else ok(false, `${msg}: first difference at event ${k} (sources unchanged: a determinism bug)`);
    }
  }
}

// ---------------------------------------------------------------- 3. traffic vectors
const lifeMod = existsSync(join(ROOT, 'seoul-life.js')) ? await import('../seoul-life.js') : null;
if (!lifeMod?.LifeSim) console.log('no seoul-life.js LifeSim: traffic vectors skipped');
else {
  const { lifeParity } = await import('../tools/export-seoul-data.mjs');
  const layout = geo.layout || JSON.parse(readFileSync(join(ROOT, 'seoul/layout.json'), 'utf8'));
  const v1 = lifeParity(lifeMod.LifeSim, layout, SEED), v2 = lifeParity(lifeMod.LifeSim, layout, SEED);
  ok(JSON.stringify(v1) === JSON.stringify(v2), `traffic vectors identical across two sims (hash at t=${v1.map((v) => v.t).join(', ')}: ${v1.map((v) => v.hash).join(' ')})`);
  { const s = new lifeMod.LifeSim(layout, { seed: SEED }); s.advanceTo(90); s.advanceTo(10); s.advanceTo(90); ok(s.hash() === v1[v1.length - 1].hash, 'rewind + re-simulate reproduces t=90'); }
  if (RECORD) { writeFileSync(PAR, JSON.stringify({ format: 'onetake.parity/1', level: 'seoul-hongdae', seed: SEED, sources: { life: SOURCES.life, layout: SOURCES.layout }, note: 'LifeSim(layout, {seed}).advanceTo(t): hash() bit-exact; boxesAt(t)[0..11] within 1e-9 m (TrafficSim.pose uses Math.sin for the scooter weave)', vectors: v1 }, null, 1) + '\n'); console.log('recorded tests/seoul/parity.json'); }
  const exp = existsSync(PAR) ? JSON.parse(readFileSync(PAR, 'utf8')) : null;
  if (!exp) stale('tests/seoul/parity.json missing: --record');
  else {
    const bad = [];
    exp.vectors.forEach((e, i) => {
      const g = v1[i];
      if (!g || g.t !== e.t || g.hash !== e.hash || g.trafficStep !== e.trafficStep) { bad.push(`t=${e.t}: hash ${g?.hash} expected ${e.hash}`); return; }
      e.boxes.forEach((b, j) => { const q = g.boxes[j]; const d = !q || q.id !== b.id ? Infinity : Math.max(...[...b.c, ...b.h].map((v, n) => Math.abs(v - [...q.c, ...q.h][n]))); if (!(d <= BOX_TOL)) bad.push(`t=${e.t} box ${j} (vehicle ${b.id}) off by ${d}`); });
    });
    const changed = ['life', 'layout'].filter((s) => exp.sources?.[s] !== SOURCES[s]);
    const msg = `traffic parity vectors (${exp.vectors.length} times, ${exp.vectors.reduce((s, v) => s + v.boxes.length, 0)} boxes)`;
    if (!bad.length) ok(true, msg);
    else if (changed.length) stale(`${msg}: ${bad[0]}; ${changed.join(', ')} changed since recorded: if intentional, --record`);
    else ok(false, `${msg}: ${bad.slice(0, 3).join('; ')} (sources unchanged: a determinism bug)`);
  }
}
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
