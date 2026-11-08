// tests/seoul-audio.mjs: offline render of the Seoul soundscape along a camera path (needs a Web Audio implementation
// for Node: NODE_WEB_AUDIO=/path/to/node_modules/node-web-audio-api). Prints per-zone levels (dBFS at the bus),
// voice counts, render speed, and the motor synth's level for reference; checks for NaN/silence/clipping.
//   NODE_WEB_AUDIO=... node tests/seoul-audio.mjs [layout.json] [--wav out.wav]
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WA = require(process.env.NODE_WEB_AUDIO || 'node-web-audio-api');
globalThis.performance ??= { now: () => Date.now() };
const { build } = await import('../seoul-life.js');
const { MotorAudio } = await import('../audio.js');
const args = process.argv.slice(2), wavAt = args.indexOf('--wav'), wav = wavAt >= 0 ? args.splice(wavAt, 2)[1] : null;
const file = [args[0], 'seoul/layout.json', 'tests/seoul-life-layout.json'].find((f) => f && existsSync(f));
const layout = JSON.parse(readFileSync(file, 'utf8'));
const life = build(layout, { seed: 7 });
// camera path: hero points if present (walk the hero list), else along the first two streets
const pts = (layout.hero?.length >= 2 ? layout.hero.map((h) => [h.pos[0], h.pos[2]]) : layout.streets.slice(0, 2).flatMap((s) => [s.points[0], s.points[s.points.length - 1]]));
const DUR = +(process.env.DUR || 24), SR = 48000, FPS = 30;
const ctx = new WA.OfflineAudioContext(2, DUR * SR, SR);
const bus = ctx.createGain(); bus.connect(ctx.destination);
life.audio.attach(ctx, bus, { offline: true });
if (process.env.SOLO) {   // debug: keep one group (beds | engine | bus | scooter | music | club | neon | sizzle | pip)
  const g = life.audio.__g, keep = process.env.SOLO;
  for (const [k, V] of Object.entries(g.pv)) if (k !== keep) for (const v of V) v.pn.disconnect();
  if (keep !== 'pip') g.pip.pn.disconnect();
  if (keep !== 'beds') for (const b of Object.values(life.audio.__beds)) b.disconnect();
}
const seg = []; let tot = 0; for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); tot += l; }
const camAt = (u) => { let s = u * tot; for (let i = 0; i < seg.length; i++) { if (s <= seg[i] || i === seg.length - 1) { const k = Math.min(1, s / seg[i]); return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, y: 2.5 + 6 * Math.max(0, Math.sin(u * 9)), z: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k, fx: (pts[i + 1][0] - pts[i][0]) / seg[i], fz: (pts[i + 1][1] - pts[i][1]) / seg[i] }; } s -= seg[i]; } };
const log = [], t0 = Date.now();
for (let f = 0; f < DUR * FPS; f++) {
  const at = f / FPS, c = camAt(at / DUR);
  life.update(30 + at, { x: c.x, y: c.y, z: c.z, copy() {} });
  life.audio.feed({ x: c.x, y: c.y, z: c.z }, { x: c.fx, y: 0, z: c.fz }, 30 + at, at);
  if (f % FPS === 0) log.push({ t: at, ...Object.fromEntries(Object.entries(life.audio.stats).map(([k, v]) => [k, +(+v).toFixed(2)])) });
}
const tFeed = Date.now() - t0, t1 = Date.now();
const buf = await ctx.startRendering(), tRender = Date.now() - t1;
const L = buf.getChannelData(0), R = buf.getChannelData(1);
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const db = (x) => (20 * Math.log10(x + 1e-9)).toFixed(1);
let nan = 0, pk = 0; for (let i = 0; i < L.length; i++) { if (!isFinite(L[i]) || !isFinite(R[i])) nan++; pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); }
console.log(`layout ${file}; ${DUR} s path over ${pts.length} points (${tot.toFixed(0)} m); feed ${tFeed} ms, render ${tRender} ms (${(DUR * 1000 / tRender).toFixed(1)}x real time)`);
console.log('t   rms dBFS  crowdNear trafficNear canyon | engine bus scooter music club hiss');
for (const e of log) {
  const i0 = Math.floor(e.t * SR), i1 = Math.min(L.length, i0 + SR); let s = 0; for (let i = i0; i < i1; i++) s += L[i] * L[i] + R[i] * R[i];
  e.rms = Math.sqrt(s / (2 * (i1 - i0)));
  console.log(`${String(e.t).padStart(3)} ${db(e.rms).padStart(6)}  ${String(e.crowdNear).padStart(8)} ${String(e.trafficNear).padStart(10)} ${String(e.canyon).padStart(6)} | ${e.engine} ${e.bus} ${e.scooter} ${e.music} ${e.club} ${e.hiss}`);
}
// reference: the motor synth at hover through its own chain (its bus input level)
const rc = new WA.OfflineAudioContext(2, 2 * SR, SR), ma = new MotorAudio(); ma.startOffline(rc);
const probe = rc.createAnalyser(); ma.bus.connect(probe);
for (let f = 0; f < 60; f++) ma.update([0.39, 0.39, 0.39, 0.39], 0, 0, false, false, {}, f / 30);
const ref = await rc.startRendering(); let rs = 0; const rl = ref.getChannelData(0); for (let i = SR; i < 2 * SR; i++) rs += rl[i] * rl[i];
console.log(`motor synth at hover (after its camera chain): ${db(Math.sqrt(rs / SR))} dBFS`);
ok(nan === 0, 'no NaN'); ok(pk < 1, `no clipping (peak ${db(pk)} dBFS)`);
ok(log.every((e) => e.rms > 1e-4), 'never silent'); ok(Math.max(...log.map((e) => e.rms)) / Math.min(...log.map((e) => e.rms)) > 2, 'it is a map, not a loop: >6 dB swing along the path');
ok(life.audio.stats.voices <= 26, `voice budget ${life.audio.stats.voices} (beds + positional)`);
if (wav) {   // 16-bit stereo
  const n = L.length, b = Buffer.alloc(44 + n * 4); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  const g = 0.5 / Math.max(1e-6, pk); for (let i = 0; i < n; i++) { b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g)) * 32767), 44 + i * 4); b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g)) * 32767), 46 + i * 4); }
  writeFileSync(wav, b); console.log('wrote', wav, '(normalised to -6 dBFS peak)');
}
process.exit(fail ? 1 : 0);
