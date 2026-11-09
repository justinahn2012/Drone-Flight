// tests/seoul-audio.mjs: offline renders of the Seoul soundscape (needs a Web Audio implementation for Node:
// NODE_WEB_AUDIO=/path/to/node_modules/node-web-audio-api). Phase 2 (stream G) checks, against the sound panel's numbers:
//   - the map: a path over the hero spots (levels per second, voices, no NaN / clipping / silence, > 6 dB swing)
//   - sound #1: the city UNDER the motors through MotorAudio's world path: city loudness vs a hover (target -9 LU) and the
//     duck at full throttle (<= 6 dB)
//   - sound #4: spectral centroid of the city on the walking street (target 0.9-1.5 kHz; P1 330-470 Hz)
//   - sound #6: no loops (autocorrelation peak at 2.5-8 s lags; P1 0.36-0.67 at 5.00 s)
//   - sound #5: the occluder; sound #3: signature layers fire; clip path renders
//   NODE_WEB_AUDIO=... node tests/seoul-audio.mjs [layout.json] [--wav out.wav]
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WA = require(process.env.NODE_WEB_AUDIO || 'node-web-audio-api');
globalThis.performance ??= { now: () => Date.now() };
const { build } = await import('../seoul-life.js');
const { MotorAudio } = await import('../audio.js');
const { makeOccluder } = await import('../seoul-audio.js');
const args = process.argv.slice(2), wavAt = args.indexOf('--wav'), wav = wavAt >= 0 ? args.splice(wavAt, 2)[1] : null;
const file = [args[0], 'seoul/layout.json', 'tests/seoul-life-layout.json'].find((f) => f && existsSync(f));
const layout = JSON.parse(readFileSync(file, 'utf8'));
const SR = 48000, FPS = 30;
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const db = (x) => (20 * Math.log10(x + 1e-9)).toFixed(1);
// ---- analysis helpers: BS.1770 loudness (K-weighting at 48 kHz, 400 ms blocks, gated), FFT centroid, autocorrelation
function lufs(L, R) {
  const kw = (x) => { const y = new Float64Array(x.length); let a1 = 0, a2 = 0, b1 = 0, b2 = 0, c1 = 0, c2 = 0, d1 = 0, d2 = 0;
    for (let i = 0; i < x.length; i++) { const v = x[i], s1 = 1.53512485958697 * v - 2.69169618940638 * a1 + 1.19839281085285 * a2 + 1.69065929318241 * b1 - 0.73248077421585 * b2; a2 = a1; a1 = v; b2 = b1; b1 = s1;
      const s2 = s1 - 2 * c1 + c2 + 1.99004745483398 * d1 - 0.99007225036621 * d2; c2 = c1; c1 = s1; d2 = d1; d1 = s2; y[i] = s2; } return y; };
  const l = kw(L), r = kw(R), blk = 0.4 * SR, hop = 0.1 * SR, B = [];
  for (let i = 0; i + blk <= l.length; i += hop) { let z = 0; for (let j = i; j < i + blk; j++) z += l[j] * l[j] + r[j] * r[j]; B.push(-0.691 + 10 * Math.log10(z / blk + 1e-12)); }
  const g1 = B.filter((v) => v > -70); if (!g1.length) return -99; const m1 = 10 * Math.log10(g1.reduce((a, v) => a + 10 ** ((v + 0.691) / 10), 0) / g1.length) - 0.691;
  const g2 = g1.filter((v) => v > m1 - 10); return 10 * Math.log10(g2.reduce((a, v) => a + 10 ** ((v + 0.691) / 10), 0) / g2.length) - 0.691;
}
function fft(re, im) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const ur = re[i + j], ui = im[i + j], vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr; re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } }
function centroid(L, R) { const N = 4096; const P = new Float64Array(N / 2); for (let o = 0; o + N <= L.length; o += N) { const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) re[i] = (L[o + i] + R[o + i]) * 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); fft(re, im); for (let k = 1; k < N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k]; }
  let s = 0, w = 0; for (let k = 1; k < N / 2; k++) { s += P[k]; w += P[k] * k * SR / N; } return w / s; }
function acPeak(L, lo = 2.5, hi = 8) {   // normalised autocorrelation of the (decimated x4) mono signal, max over [lo, hi] s
  const D = 4, sr = SR / D, n = Math.floor(L.length / D), N = 1 << Math.ceil(Math.log2(2 * n)), re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < n; i++) { let a = 0; for (let k = 0; k < D; k++) a += L[i * D + k]; re[i] = a / D; }
  fft(re, im); for (let i = 0; i < N; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; } fft(re, im);   // (real power spectrum: forward FFT = inverse up to scale)
  const r0 = re[0]; let best = 0, at = 0; for (let k = Math.floor(lo * sr); k < Math.min(n, hi * sr); k++) { const r = re[k] / r0 * n / (n - k); if (r > best) { best = r; at = k / sr; } } return [best, at];
}
// ---- 2. under the motors (sound #1). The props' hover loudness after the camera chain is a reference measured with
// MotorAudio on this harness (freestyle5, motors 0.392: -7.8 LUFS, stable over 8 renders on 2026-11-08). The city is
// rendered alone into what the world path applies to it (SND.world, the limiter's -0.57 dB make-up trim, no duck at a
// hover). node-web-audio-api intermittently returns silence or inf for MotorAudio graphs in a long process, so the
// props aren't re-rendered here; the duck comes from MotorAudio's own open-loop model (update(), no render).
const HOVER_LUFS = -7.8;
const { SND } = await import('../seoul-audio.js');
async function cityAt(cam, secs = 12, bedsOnly = false) {
  const ctx = new WA.OfflineAudioContext(2, secs * SR, SR), bus = ctx.createGain(); bus.gain.value = SND.world * Math.pow(10, -0.57 / 20); bus.connect(ctx.destination);
  const L2 = build(layout, { seed: 7 }); L2.audio.attach(ctx, bus, { offline: true });
  if (bedsOnly) for (const V of Object.values(L2.audio.__g.pv)) for (const v of V) v.pn.disconnect();   // beds only (music is periodic by nature)
  for (let f = 0; f < secs * FPS; f++) { const at = f / FPS, c = { ...cam, copy() {} }; L2.update(30 + at, c); L2.audio.feed(c, { x: 0, y: 0, z: -1 }, 30 + at + L2.colliders.warm, at); }
  const b = await ctx.startRendering(); return { L: b.getChannelData(0), R: b.getChannelData(1) };
}
{
  const spots = { walking: { x: -36, y: 3, z: -23 }, junction: { x: -40, y: 3, z: -150 }, station: { x: 31.8, y: 8, z: -309 } }, res = {};
  for (const [k, cam] of Object.entries(spots)) { const c = await cityAt(cam); res[k] = { lu: lufs(c.L, c.R) - HOVER_LUFS, cen: centroid(c.L, c.R) }; }
  console.log('city vs a hover (LU) and centroid (Hz): ' + Object.entries(res).map(([k, v]) => `${k} ${v.lu.toFixed(1)} LU / ${v.cen.toFixed(0)} Hz`).join(', '));
  ok(res.walking.lu > -11 && res.walking.lu < -7, `the city is audible under a hover on the walking street: ${res.walking.lu.toFixed(1)} LU (target -9; P1 -14)`);
  ok(Object.values(res).every((v) => v.lu > -24), 'and on the quieter spots it stays within reach (> -24 LU; P1 Yanghwa-ro -27)');
  ok(Object.values(res).every((v) => v.cen > 850 && v.cen < 1800), `voiced for a phone speaker: centroids ${Object.values(res).map((v) => v.cen.toFixed(0)).join(' / ')} Hz (target 0.9-1.5 kHz; P1 330-470)`);
  const beds = await cityAt(spots.walking, 16, true), [ac, lag] = acPeak(beds.L);
  ok(ac < 0.3, `no loops in the beds: autocorrelation peak ${ac.toFixed(2)} at ${lag.toFixed(2)} s (P1 0.36-0.67 at 5.00 s)`);
  const ctx = new WA.OfflineAudioContext(2, SR, SR), ma = new MotorAudio(); ma.startOffline(ctx); ma.openWorld();
  for (let f = 0; f < 30; f++) ma.update([0.392, 0.392, 0.392, 0.392], 0, 0, false, false, {}, f / 30); const dHover = 20 * Math.log10(ma.duck);
  for (let f = 30; f < 60; f++) ma.update([0.85, 0.85, 0.85, 0.85], 12, 0, false, false, {}, f / 30); const dFull = 20 * Math.log10(ma.duck);
  ok(dHover > -0.5 && dFull >= -6.01 && dFull < -3, `world duck: ${dHover.toFixed(1)} dB at a hover, ${dFull.toFixed(1)} dB at full throttle (at most 6)`);
}
// ---- 1. the map: a path over the hero spots, city alone at its out
const life = build(layout, { seed: 7 });
const pts = (layout.hero?.length >= 2 ? layout.hero.map((h) => [h.pos[0], h.pos[2]]) : layout.streets.slice(0, 2).flatMap((s) => [s.points[0], s.points[s.points.length - 1]]));
const DUR = +(process.env.DUR || 24);
{
  const ctx = new WA.OfflineAudioContext(2, DUR * SR, SR), bus = ctx.createGain(); bus.gain.value = SND.world; bus.connect(ctx.destination);   // as on the world path
  life.audio.attach(ctx, bus, { offline: true });
  const seg = []; let tot = 0; for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); tot += l; }
  const camAt = (u) => { let s = u * tot; for (let i = 0; i < seg.length; i++) { if (s <= seg[i] || i === seg.length - 1) { const k = Math.min(1, s / seg[i]); return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, y: 2.5 + 6 * Math.max(0, Math.sin(u * 9)), z: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k, fx: (pts[i + 1][0] - pts[i][0]) / seg[i], fz: (pts[i + 1][1] - pts[i][1]) / seg[i] }; } s -= seg[i]; } };
  const log = [], t0 = Date.now();
  for (let f = 0; f < DUR * FPS; f++) {
    const at = f / FPS, c = camAt(at / DUR), cam = { x: c.x, y: c.y, z: c.z, copy() {} };
    life.update(30 + at, cam); life.audio.feed(cam, { x: c.fx, y: 0, z: c.fz }, 30 + at + life.colliders.warm, at);
    if (f % FPS === 0) log.push({ t: at, ...Object.fromEntries(Object.entries(life.audio.stats).map(([k, v]) => [k, +(+v).toFixed(1)])) });
  }
  const tFeed = Date.now() - t0, t1 = Date.now(), buf = await ctx.startRendering(), tRender = Date.now() - t1;
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let nan = 0, pk = 0; for (let i = 0; i < L.length; i++) { if (!isFinite(L[i]) || !isFinite(R[i])) nan++; pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); }
  console.log(`layout ${file}; ${DUR} s path over ${pts.length} points (${tot.toFixed(0)} m); feed ${tFeed} ms, render ${tRender} ms (${(DUR * 1000 / tRender).toFixed(1)}x real time)`);
  console.log('t   rms dBFS  crowdN trafN canyon | eng bus sct music club busk | laughs steps horns chimes guides applause occl');
  for (const e of log) {
    const i0 = Math.floor(e.t * SR), i1 = Math.min(L.length, i0 + SR); let s = 0; for (let i = i0; i < i1; i++) s += L[i] * L[i] + R[i] * R[i];
    e.rms = Math.sqrt(s / (2 * (i1 - i0)));
    console.log(`${String(e.t).padStart(3)} ${db(e.rms).padStart(6)}  ${String(e.crowdNear).padStart(6)} ${String(e.trafficNear).padStart(5)} ${String(e.canyon).padStart(5)} | ${e.engine} ${e.bus} ${e.scooter} ${e.music} ${e.club} ${e.busk} | ${e.laughs} ${e.steps} ${e.horns} ${e.chimes} ${e.guides} ${e.applause} ${e.occluded}`);
  }
  ok(nan === 0, 'no NaN'); ok(pk < 1, `no clipping at the city out, world trim applied (peak ${db(pk)} dBFS; the master limiter follows in game)`);
  ok(log.every((e) => e.rms > 1e-4), 'never silent'); ok(Math.max(...log.map((e) => e.rms)) / Math.min(...log.map((e) => e.rms)) > 2, 'it is a map, not a loop: >6 dB swing along the path');
  ok(life.audio.stats.voices <= 26, `voice budget ${life.audio.stats.voices} (beds + reverbs + positional)`);
  const S = life.audio.stats; ok(S.laughs > 3 && S.music > 0 && S.occluded >= 0, `signature layers fire on the hero path (laughs/shouts ${S.laughs}, steps ${S.steps}, horns ${S.horns}, chimes ${S.chimes}, guides ${S.guides}, applause ${S.applause})`);
  if (wav) {
    const n = L.length, b = Buffer.alloc(44 + n * 4); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
    const g = 0.5 / Math.max(1e-6, pk); for (let i = 0; i < n; i++) { b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g)) * 32767), 44 + i * 4); b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g)) * 32767), 46 + i * 4); }
    writeFileSync(wav, b); console.log('wrote', wav, '(normalised to -6 dBFS peak)');
  }
}
// ---- 3. occlusion (2.5-D rays against the lots) and the HQ clip path
{
  const occ = makeOccluder(layout), lot = layout.lots.find((l) => l.footprint && (l.floors || 3) >= 4);
  let cx = 0, cz = 0; lot.footprint.forEach((p) => { cx += p[0]; cz += p[1]; }); cx /= lot.footprint.length; cz /= lot.footprint.length;
  const a = lot.footprint[0], d = [a[0] - cx, a[1] - cz], k = 1 + 25 / Math.hypot(d[0], d[1]);
  const through = occ(cx - d[0] * k, 2, cz - d[1] * k, cx + d[0] * k, 2, cz + d[1] * k), over = occ(cx - d[0] * k, 200, cz - d[1] * k, cx + d[0] * k, 200, cz + d[1] * k);
  ok(through && !over, 'occluder: a ray through a building at 2 m is blocked, the same ray at 200 m is not');
  const ctx = new WA.OfflineAudioContext(2, 3 * SR, SR), ma = new MotorAudio(); ma.startOffline(ctx);
  const clip = life.audio.clip(ctx, ma);
  for (let f = 0; f < 3 * FPS; f++) { const at = f / FPS, cam = { x: -36, y: 3, z: -23 + f * 0.1 }; ma.update([0.4, 0.4, 0.4, 0.4], 3, 0, false, false, {}, at); clip.feed(cam, { x: 0, y: 0, z: 1 }, 50 + at, at); }
  const b = await ctx.startRendering(); let s = 0; const L = b.getChannelData(0); for (let i = SR; i < L.length; i++) s += L[i] * L[i];
  ok(Math.sqrt(s / (L.length - SR)) > 1e-3, 'HQ clip path: the city renders on an offline context alongside the motors');
}
process.exit(fail ? 1 : 0);
