// Determinism tests for the flight model (native-readiness #1.1-#1.3). Node 18+, run from the repo root:
//   node tests/replay.mjs            replay every committed tests/*.otil input log; fail beyond 1 mm
//   node tests/replay.mjs --record   re-record the scripted logs (after an intentional flight-model or world change)
// Needs three + three-mesh-bvh resolvable from the repo (node_modules), like the other node tools.
//
// Checks:
//  1. every committed log replays within 1 mm at each stored snapshot, both as one continuous run (the web build must
//     be exact: expect 0) and re-synced at each snapshot (what a port with different libm rounding is held to)
//  2. two replays of the same log end in identical state
//  3. the main.js tick loop is frame-rate independent: one tick-input stream driven by 60 Hz, jittery 60 Hz, 30 Hz and
//     144 Hz frame schedules gives bit-identical state (the old dt/steps sub-stepping drifted 19-73 cm)
//  4. snapshot() -> JSON -> restore() continues bit-identically
// A log recorded on another world (its header.world hash matches none of the candidate worlds) is reported as STALE
// and skipped, not failed: re-record it.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';
import { Drone } from '../flight.js';
import { Rng } from '../rng.js';
import { InputLog, quantize, replayLog, worldHash } from '../inputlog.js';
import { buildGeometry } from '../world-bando.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const TOL = 0.001, PHYS = 1 / 240;
const ENV = { min: new THREE.Vector3(-440, -2, -440), max: new THREE.Vector3(440, 220, 440) };   // = buildBando().envelope

const G = buildGeometry();
const funnels = G.funnels || G.site?.funnels || null;            // C1 world.funnels, once world-bando exports them
// candidate worlds a log may have been recorded on
const WORLDS = {
  air: { envelope: ENV },                                         // flight model only (no geometry)
  site: { bvh: G.bvh, envelope: ENV, ...(funnels ? { funnels } : {}) },
  siteNoFunnels: { bvh: G.bvh, envelope: ENV },
};
const byHash = new Map(Object.entries(WORLDS).map(([k, w]) => [worldHash(w), { name: k, world: w }]));

// ---- scripted pilots: a pure function of the tick index (seeded OU thumbs + a plan), so recording is reproducible
function pilot(seed, plan) {
  const r = new Rng(seed), ou = { p: 0, r: 0, y: 0, c: 0 };
  return (i) => {
    for (const k in ou) ou[k] += -ou[k] * 0.8 * PHYS + 1.9 * Math.sqrt(PHYS) * (r.next() * 2 - 1);
    return plan(i * PHYS, ou);
  };
}
const cl = (v) => Math.max(-1, Math.min(1, v));
const SCRIPTS = {
  // open air: Cine carve/climb, then Angle, then Acro (mode switches are logged)
  air: { world: 'air', start: [0, 40, 60], yaw: 0, secs: 15, seed: 11, plan: (t, o) =>
    t < 6 ? { mode: 'cine', thr: 0.4, pitch: cl(0.6 + o.p * 0.6), roll: cl(o.r), yaw: cl(o.y * 0.5), climb: cl(o.c * 0.8) }
    : t < 10 ? { mode: 'angle', thr: cl(0.45 + o.c * 0.2), pitch: cl(0.3 + o.p * 0.5), roll: cl(o.r * 0.6), yaw: cl(o.y * 0.4), climb: 0 }
    : { mode: 'acro', thr: cl(0.42 + o.c * 0.25), pitch: cl(o.p * 0.5), roll: cl(o.r * 0.5), yaw: cl(o.y * 0.4), climb: 0 } },
  // the site, contact-rich: drop into the chimney off-axis (drop lock / funnel, dive guard, tube walls), then thumbs
  site: { world: funnels ? 'site' : 'siteNoFunnels', start: [-6.6, 53, -21.2], yaw: 0.4, secs: 20, seed: 23, plan: (t, o) =>
    t < 0.5 ? { mode: 'cine', thr: 0.4, pitch: 0, roll: 0, yaw: 0, climb: 0 }
    : t < 7 ? { mode: 'cine', thr: 0.4, pitch: 0, roll: 0, yaw: 0, climb: -1 }
    : t < 9 ? { mode: 'cine', thr: 0.4, pitch: cl(0.35 + o.p * 0.3), roll: cl(o.r * 0.5), yaw: 0.6, climb: 0 }
    : { mode: 'cine', thr: 0.4, pitch: cl(0.55 + o.p * 0.7), roll: cl(o.r), yaw: cl(o.y * 0.6), climb: cl(o.c) } },
};

// record a script exactly the way main.js frame() does: quantize -> record -> step(PHYS)
function record(name) {
  const sc = SCRIPTS[name], world = WORLDS[sc.world], drive = pilot(sc.seed, sc.plan);
  const d = new Drone('freestyle5'); d.reset(new THREE.Vector3(...sc.start), sc.yaw);
  const first = drive(0);
  const log = new InputLog({ seed: d.seed, world: worldHash(world), craft: d.key, mode: first.mode, hz: 240, start: d.snapshot(), meta: { script: name } });
  const inp = {};
  for (let i = 0; i < sc.secs * 240; i++) {
    const s = i ? drive(i) : first;
    quantize(s, inp); log.record(inp, s.mode, d);
    d.step(PHYS, inp, s.mode, world);
  }
  writeFileSync(join(DIR, `${name}.otil`), log.toBytes());
  return { log, d };
}

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };

if (process.argv.includes('--record')) {
  for (const name of Object.keys(SCRIPTS)) {
    const { log, d } = record(name);
    console.log(`recorded tests/${name}.otil: ${log.ticks} ticks, ${log.snaps.length} snapshots, world ${log.header.world}, ` +
      `end ${d.pos.toArray().map((v) => v.toFixed(2)).join(',')}, unsticks ${d.unsticks}, crashed ${d.crashed}`);
  }
}

// 1 + 2. committed logs
for (const f of readdirSync(DIR).filter((f) => f.endsWith('.otil')).sort()) {
  const log = InputLog.fromBytes(readFileSync(join(DIR, f)));
  const w = byHash.get(log.header.world);
  if (!w) { console.log(`STALE ${f}: recorded on world ${log.header.world}, which none of [${[...byHash.keys()].join(', ')}] match (re-record it)`); continue; }
  const a = replayLog(log, new Drone(log.header.craft), w.world);
  const b = replayLog(log, new Drone(log.header.craft), w.world, { resync: true });
  const c = replayLog(log, new Drone(log.header.craft), w.world);
  ok(a.maxErr <= TOL, `${f} (${w.name}, ${(log.ticks / 240).toFixed(1)} s, ${a.snaps} snapshots): continuous max error ${(a.maxErr * 1000).toFixed(3)} mm`);
  ok(b.maxErr <= TOL, `${f}: re-synced max error ${(b.maxErr * 1000).toFixed(3)} mm`);
  ok(JSON.stringify(a.final) === JSON.stringify(c.final), `${f}: two replays end in identical state`);
}

// 3. frame-rate independence of the main.js accumulator loop (inputs are per tick, as the log stores them)
{
  const world = WORLDS.siteNoFunnels, drive = pilot(5, SCRIPTS.site.plan);
  const ticks = 240 * 8, inputs = Array.from({ length: ticks }, (_, i) => quantize(drive(i)));
  let js = 99; const jr = () => { js = (Math.imul(js, 1103515245) + 12345) >>> 0; return js / 4294967296; };
  const schedules = {
    '60 Hz': () => 1 / 60, 'jittery 60 Hz (+-2 ms)': () => 1 / 60 + (jr() - 0.5) * 0.004, '30 Hz': () => 1 / 30, '144 Hz': () => 1 / 144,
  };
  const runs = {};
  for (const [name, next] of Object.entries(schedules)) {
    const d = new Drone('freestyle5'); d.reset(new THREE.Vector3(...SCRIPTS.site.start), SCRIPTS.site.yaw);
    let acc = 0, n = 0;
    while (n < ticks) {                                            // = main.js frame(): whole ticks, leftover carried
      acc += next();
      while (acc >= PHYS && n < ticks) { d.step(PHYS, inputs[n], inputs[n].mode ?? 'cine', world); acc -= PHYS; n++; }
    }
    runs[name] = JSON.stringify(d.snapshot());
  }
  const ref = runs['60 Hz'];
  for (const [name, s] of Object.entries(runs)) if (name !== '60 Hz') ok(s === ref, `tick loop: ${name} frames give the same state as 60 Hz (8 s, ${ticks} ticks)`);
}

// 4. snapshot -> JSON -> restore continues bit-identically
{
  const world = WORLDS.siteNoFunnels, drive = pilot(7, SCRIPTS.site.plan);
  const a = new Drone('freestyle5'); a.reset(new THREE.Vector3(...SCRIPTS.site.start), SCRIPTS.site.yaw);
  for (let i = 0; i < 240 * 4; i++) { const s = quantize(drive(i)); a.step(PHYS, s, 'cine', world); }
  const b = new Drone('cinewhoop').restore(JSON.parse(JSON.stringify(a.snapshot())));
  for (let i = 240 * 4; i < 240 * 8; i++) { const s = quantize(drive(i)); a.step(PHYS, s, 'cine', world); b.step(PHYS, s, 'cine', world); }
  ok(JSON.stringify(a.snapshot()) === JSON.stringify(b.snapshot()), 'snapshot -> JSON -> restore continues bit-identically (4 s)');
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
