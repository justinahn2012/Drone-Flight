// tests/seoul-audio.mjs: offline renders of the Seoul soundscape (needs a Web Audio implementation for Node:
// NODE_WEB_AUDIO=/path/to/node_modules/node-web-audio-api). Phase 2 (stream G) and phase 3 (G2) checks, against the sound
// panel's numbers:
//   - the map: a path over the hero spots (levels per second, voices, no NaN, peaks in the brickwall's range, > 6 dB swing)
//   - the city UNDER the motors through MotorAudio's world path: city loudness vs a hover (walking street -10 LU), every
//     spot in reach, Yanghwa-ro the loudest; the duck at full throttle (<= 6 dB)
//   - P3 sound #1: peaks (momentary p95 - p50 >= 4 dB on the hero streets); calibrated one-shots and loops
//   - P3 sound #3: the babble's octave spectrum within 3 dB of a recorded crowd; #4: the club street through a phone
//   - P3 sound #6: horns, the crossing guide and exit 9 on Yanghwa-ro; no loops over 2.5-15 s lags
//   - P3 sound #5: the clip feed is in sync with the live sims and deterministic; P3 bug: the world brickwall
//   - P3 ux #1: movers speak (a bumped person yelps); the occluder; clip path renders
//   - P4 sound #2: Yanghwa-ro roars (station >= walking + 2 LU; energy-summed traffic bed, wet tyres, 6 engine voices);
//     #3: a hover breathes (p95 - p50 >= 4 dB; swells, names, phones, scooter horns); #4: babble rhythm (the 300-1000 Hz
//     envelope's 2-8 Hz share 0.35-0.5, CV 0.75-0.95); #5: the club doors cooled (spot <= -6 LU); bug: no 12 s loop
//   P6: the game's own city (P5 tested seed 7 without E's set pieces; the game plays seed 11 with them, 1.2 LU hotter at
//     the walking-street hover): the gates have margins there. #2 the roar in the low mids (centroid < 1200 Hz, 2 kHz
//     >= 3 dB under the loudest of 250 Hz-1 kHz); #4 exit 9's crossing guide, T-money beeps and train; #5 the club path's
//     door pops; #6 occlusion by building count, the traffic bed's occluded share, no voices for cars behind the alley
//   NODE_WEB_AUDIO=... node tests/seoul-audio.mjs [layout.json] [--wav out.wav]
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WA = require(process.env.NODE_WEB_AUDIO || 'node-web-audio-api');
globalThis.performance ??= { now: () => Date.now() };
const { build } = await import('../seoul-life.js');
const { MotorAudio } = await import('../audio.js');
const { makeOccluder } = await import('../seoul-audio.js');
if (process.env.G2_CLIP_ONCE) {   // child of the clip determinism check below (the game's seed; no set pieces: a pure-clock check)
  const L4 = build(JSON.parse(readFileSync('seoul/layout.json', 'utf8')), { seed: 11 }), ctx = new WA.OfflineAudioContext(2, 2 * 48000, 48000), ma = new MotorAudio(); ma.startOffline(ctx, 1234); const clip = L4.audio.clip(ctx, ma);
  for (let f = 0; f < 60; f++) { const at = f / 30; ma.update([0.45, 0.45, 0.45, 0.45], 4, 0.2, false, false, {}, at); if (f === 20) ma.hit(3, at); clip.feed({ x: -36, y: 3, z: -23 + f * 0.15 }, { x: 0, y: 0, z: 1 }, 20 + at, at); }
  const d = (await ctx.startRendering()).getChannelData(0), u = new Uint32Array(d.buffer, d.byteOffset, d.length); let h = 2166136261, e = 0;
  for (let i = 0; i < u.length; i++) { h = Math.imul(h ^ u[i], 16777619) >>> 0; e += d[i] * d[i]; }
  console.log(h.toString(16) + ' ' + e.toFixed(3)); process.exit(0);
}
const args = process.argv.slice(2), wavAt = args.indexOf('--wav'), wav = wavAt >= 0 ? args.splice(wavAt, 2)[1] : null;
const file = [args[0], 'seoul/layout.json', 'tests/seoul-life-layout.json'].find((f) => f && existsSync(f));
const layout = JSON.parse(readFileSync(file, 'utf8'));
const SR = 48000, FPS = 30;
// P6 (sound #3): the city as world-seoul builds it for the game: seed 11, E's set pieces, dressing discs and stairwell
// openings (geometry ~8 s). A test layout (not the Seoul one) falls back to seed 7 with no set pieces
const LIFE = await (async () => {
  if (!/seoul[\\/]layout\.json$/.test(file) || !existsSync('seoul/lines.json')) return { seed: 7 };
  const { buildSeoulGeometry } = await import('../world-seoul.js'), geo = buildSeoulGeometry(layout, { lineData: JSON.parse(readFileSync('seoul/lines.json', 'utf8')) });
  return { seed: 11, setPieces: geo.setPieces || [], obstacles: geo.dressingOut?.obstacles || null, holes: geo.dressingOut?.holes || null };
})();
console.log(`the city: seed ${LIFE.seed}${LIFE.setPieces ? `, ${LIFE.setPieces.length} set pieces, ${LIFE.holes?.length ?? 0} stairwell openings (as the game builds it)` : ''}`);
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
function acPeak(L, lo = 2.5, hi = 15) {   // normalised autocorrelation of the (decimated x4) mono signal, max over [lo, hi] s
  const D = 4, sr = SR / D, n = Math.floor(L.length / D), N = 1 << Math.ceil(Math.log2(2 * n)), re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < n; i++) { let a = 0; for (let k = 0; k < D; k++) a += L[i * D + k]; re[i] = a / D; }
  fft(re, im); for (let i = 0; i < N; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; } fft(re, im);   // (real power spectrum: forward FFT = inverse up to scale)
  const r0 = re[0]; let best = 0, at = 0; for (let k = Math.floor(lo * sr); k < Math.min(n, hi * sr); k++) { const r = re[k] / r0 * n / (n - k); if (r > best) { best = r; at = k / sr; } } return [best, at];
}
// ---- 2. under the motors (sound #1). The props' hover loudness after the camera chain is a reference measured with
// MotorAudio on this harness (freestyle5, motors 0.392: -7.8 LUFS, stable over 8 renders on 2026-11-08). The city is
// rendered alone into what the world path applies to it (a bus whose .world is the limiter's -0.57 dB make-up trim: the
// city out applies SND.world and the mic's 90 Hz wind-cut itself; no duck at a hover). node-web-audio-api intermittently
// returns silence or inf for MotorAudio graphs in a long process, so the props aren't re-rendered here; the duck comes
// from MotorAudio's own open-loop model (update(), no render).
const HOVER_LUFS = -7.8;
const { SND } = await import('../seoul-audio.js');
const worldBus = (ctx) => { const bus = ctx.createGain(), w = ctx.createGain(); w.gain.value = Math.pow(10, -0.57 / 20); w.connect(ctx.destination); bus.world = w; return bus; };
// a city render: a static camera or a path [[x, z], ...] at speed v; solo: 'crowd' (the babble bed alone) | 'beds'
async function cityAt(cam, secs = 12, { solo = null, path = null, v = 5, t0 = 30 } = {}) {
  const ctx = new WA.OfflineAudioContext(2, secs * SR, SR);
  const L2 = build(layout, LIFE); L2.audio.attach(ctx, worldBus(ctx), { offline: true }); const g = L2.audio.__g;
  if (solo) { for (const V of Object.values(g.pv)) for (const q of V) q.pn.disconnect(); g.mix.disconnect(g.sendA); g.mix.disconnect(g.sendR); }
  if (solo === 'crowd') for (const [k, b] of Object.entries(L2.audio.__beds)) if (k !== 'bCrowd') b.disconnect();
  const seg = []; let tot = 0; if (path) for (let i = 1; i < path.length; i++) { seg.push(Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])); tot += seg[seg.length - 1]; }
  const at0 = (u) => { let s = Math.min(u, tot); for (let i = 0; i < seg.length; i++) { if (s <= seg[i] || i === seg.length - 1) { const k = Math.min(1, s / seg[i]); return [path[i][0] + (path[i + 1][0] - path[i][0]) * k, path[i][1] + (path[i + 1][1] - path[i][1]) * k, (path[i + 1][0] - path[i][0]) / seg[i], (path[i + 1][1] - path[i][1]) / seg[i]]; } s -= seg[i]; } };
  for (let f = 0; f < secs * FPS; f++) {
    const at = f / FPS, p = path ? at0(v * at) : null, c = path ? { x: p[0], y: cam.y, z: p[1], copy() {} } : { ...cam, copy() {} };
    L2.update(t0 + at, c); if (solo) [...g.shots, ...(g.stepShots || []), ...(g.longShots || [])].forEach((q) => { try { q.disconnect(); } catch (e) {} });
    L2.audio.feed(c, path ? { x: p[2], y: 0, z: p[3] } : { x: 0, y: 0, z: -1 }, t0 + at + L2.colliders.warm, at);
  }
  const b = await ctx.startRendering(); return { L: b.getChannelData(0), R: b.getChannelData(1), stats: { ...L2.audio.stats } };
}
// momentary loudness (400 ms blocks, 100 ms hop) after the first second: p95 - p50 (sound #1: does the map have peaks?)
function spread(L, R) {
  const k = (x) => { const y = new Float64Array(x.length); let a1 = 0, a2 = 0, b1 = 0, b2 = 0, c1 = 0, c2 = 0, d1 = 0, d2 = 0;
    for (let i = 0; i < x.length; i++) { const v = x[i], s1 = 1.53512485958697 * v - 2.69169618940638 * a1 + 1.19839281085285 * a2 + 1.69065929318241 * b1 - 0.73248077421585 * b2; a2 = a1; a1 = v; b2 = b1; b1 = s1;
      const s2 = s1 - 2 * c1 + c2 + 1.99004745483398 * d1 - 0.99007225036621 * d2; c2 = c1; c1 = s1; d2 = d1; d1 = s2; y[i] = s2; } return y; };
  const l = k(L), r = k(R), blk = 0.4 * SR, hop = 0.1 * SR, B = [];
  for (let i = SR; i + blk <= l.length; i += hop) { let z = 0; for (let j = i; j < i + blk; j++) z += l[j] * l[j] + r[j] * r[j]; B.push(-0.691 + 10 * Math.log10(z / blk + 1e-12)); }
  const g = B.filter((v) => v > -70).sort((a, b) => a - b), q = (p) => g[Math.min(g.length - 1, Math.floor(p * g.length))]; return q(0.95) - q(0.5);
}
// octave bands 125 Hz-8 kHz re 250 Hz, and the share of power under 120 Hz
function octaves(L, R) {
  const N = 8192, P = new Float64Array(N / 2); for (let o = SR; o + N <= L.length; o += N / 2) { const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) re[i] = (L[o + i] + R[o + i]) * 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); fft(re, im); for (let k = 1; k < N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k]; }
  const band = (lo, hi) => { let s = 0; for (let k = 1; k < N / 2; k++) { const f = k * SR / N; if (f >= lo && f < hi) s += P[k]; } return s; };
  const v = [125, 250, 500, 1000, 2000, 4000, 8000].map((c) => 10 * Math.log10(band(c / Math.SQRT2, c * Math.SQRT2) + 1e-30)), tot = band(0, SR / 2);
  const v63 = 10 * Math.log10(band(63 / Math.SQRT2, 63 * Math.SQRT2) + 1e-30);   // P7: the 63 Hz octave, dB re the loudest of 63 Hz-8 kHz
  return { oct: v.map((x) => x - v[1]), low: band(0, 120) / tot, o63: v63 - Math.max(v63, ...v) };
}
// a 2nd-order 350 Hz high-pass (a phone speaker): what is left of the loudness
function phoneLU(L, R) { const hp = (x) => { const w = 2 * Math.PI * 350 / SR, c = Math.cos(w), al = Math.sin(w) / (2 * 0.7071), a0 = 1 + al, b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0; const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const o = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = o; y[i] = o; } return y; }; return lufs(hp(L), hp(R)); }
// P4 sound #4: the babble's rhythm, as the panel measures it (scipy: butter(4) 300-1000 Hz, |hilbert|, decimate 100,
// welch 4 s): [the 2-8 Hz share of the envelope's 0.5-32 Hz modulation, the envelope's CV]. A recorded crowd: 0.39 / 0.81.
function rhythm(L, R, lo = 300, hi = 1000) {
  const bq = (type, f, q) => { const w = 2 * Math.PI * f / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al; const b = type === 'hp' ? [(1 + c) / 2, -(1 + c), (1 + c) / 2] : [(1 - c) / 2, 1 - c, (1 - c) / 2]; const B0 = b[0] / a0, B1 = b[1] / a0, B2 = b[2] / a0, A1 = -2 * c / a0, A2 = (1 - al) / a0; let x1 = 0, x2 = 0, y1 = 0, y2 = 0; return (x) => { const y = B0 * x + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; }; };
  const fs = [bq('hp', lo, 0.5412), bq('hp', lo, 1.3066), bq('lp', hi, 0.5412), bq('lp', hi, 1.3066)];
  const n = L.length - SR, N = 1 << Math.ceil(Math.log2(n)), re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < n; i++) { let y = 0.5 * (L[SR + i] + R[SR + i]); for (const f of fs) y = f(y); re[i] = y; }
  fft(re, im); for (let k = 1; k < N / 2; k++) { re[k] *= 2; im[k] *= 2; } for (let k = N / 2 + 1; k < N; k++) { re[k] = 0; im[k] = 0; }
  for (let i = 0; i < N; i++) im[i] = -im[i]; fft(re, im);   // the analytic signal (inverse FFT via conjugation; |.| needs no sign)
  const D = 100, er = SR / D, m = Math.floor(n / D), e = new Float64Array(m);
  for (let j = 0; j < m; j++) { let z = 0; for (let i = j * D; i < (j + 1) * D; i++) z += Math.hypot(re[i], im[i]) / N; e[j] = z / D; }
  let mu = 0; for (const v of e) mu += v; mu /= m; let sd = 0; for (const v of e) sd += (v - mu) ** 2; sd = Math.sqrt(sd / m);
  const W = Math.round(4 * er), kmax = Math.ceil(32 * W / er); let p28 = 0, pall = 0;
  for (let o = 0; o + W <= m; o += W >> 1) {
    let sm = 0; for (let i = 0; i < W; i++) sm += e[o + i]; sm /= W; const a = new Float64Array(W); for (let i = 0; i < W; i++) a[i] = (e[o + i] - sm) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / W));
    for (let k = 1; k <= kmax; k++) { const f = k * er / W; if (f < 0.5 || f > 32) continue; let a1 = 0, a2 = 0; const w = 2 * Math.PI * k / W; for (let i = 0; i < W; i++) { a1 += a[i] * Math.cos(w * i); a2 -= a[i] * Math.sin(w * i); } const P = a1 * a1 + a2 * a2; pall += P; if (f >= 2 && f <= 8) p28 += P; }
  }
  return [p28 / pall, sd / mu];
}
const S065 = [[-21.17, -56.96], [-29.87, -40.03], [-36.09, -23.04], [-41.33, -8.23], [-50.95, 27.11]], CLUB = [[64.93, 125.07], [63.73, 129.56], [37.53, 216.53]];
{
  const spots = { walking: { x: -36, y: 3, z: -23 }, junction: { x: -40, y: 3, z: -150 }, club: { x: 63.7, y: 3, z: 129.6 }, station: { x: 31.8, y: 8, z: -309 }, alley: { x: -37.2, y: 3, z: -87.3 } }, res = {};
  const L0wet = (await import('../seoul-audio.js')).SND.wet;
  for (const [k, cam] of Object.entries(spots)) { const c = await cityAt(cam); const o = octaves(c.L, c.R); res[k] = { lu: lufs(c.L, c.R) - HOVER_LUFS, ph: phoneLU(c.L, c.R) - HOVER_LUFS, cen: centroid(c.L, c.R), low: o.low, oct: o.oct, o63: o.o63, sp: spread(c.L, c.R), cv: k === 'walking' ? rhythm(c.L, c.R, 300, 3000)[1] : 0, st: c.stats }; }
  console.log('city vs a hover (LU / through a phone LU / centroid / < 120 Hz / p95-p50): ' + Object.entries(res).map(([k, v]) => `${k} ${v.lu.toFixed(1)} / ${v.ph.toFixed(1)} / ${v.cen.toFixed(0)} Hz / ${(100 * v.low).toFixed(0)} % / ${v.sp.toFixed(1)} dB`).join(', '));
  ok(res.walking.lu > -11 && res.walking.lu < -9, `the city is audible under a hover on the walking street: ${res.walking.lu.toFixed(1)} LU (-10 +- 1; P1 -14, P4 main -7.6, P5 on the game's city -9.1, P6 -9.6: a 0.4 margin)`);
  const four = Object.entries(res).filter(([k]) => k !== 'alley');
  ok(four.every(([, v]) => v.lu > -14 && v.lu < -2), `every spot within reach and under the props (-14 to -2 LU: ${four.map(([k, v]) => k + ' ' + v.lu.toFixed(1)).join(', ')}; P2 Yanghwa-ro -17.5, club street -14.7; P3 junction -14.4)`);
  // P5 sound #2: the place contrast (P4 main: a 2.2 LU spread over the panel's 7 paths; Hongdae runs ~10 dB alley to arterial)
  ok(res.alley.lu <= res.walking.lu - 2 && res.alley.lu > -18, `the place contrast: a side alley (Hongik-ro 5an-gil) is ${res.alley.lu.toFixed(1)} LU, ${(res.alley.lu - res.walking.lu).toFixed(1)} under the walking street (<= -2; > -18), the station ${(res.station.lu - res.walking.lu).toFixed(1)} over it (>= +4.5): ${(res.station.lu - res.alley.lu).toFixed(1)} LU alley to arterial`);
  // P6 (sound #6): the alley hears the roads through its buildings: the occluded share of the traffic bed goes through the
  // 800 Hz path, and the cars behind the walls get no voices (P5: 6 engine voices at the alley, trafficNear 0.7)
  // P7 (sound bug: at t = 0 the alley voiced 3 engines and 2 scooters before the first occlusion scan): the first feed
  { const L0 = build(layout, LIFE), c0 = new WA.OfflineAudioContext(2, SR, SR), cam = { ...spots.alley, copy() {} }; L0.audio.attach(c0, worldBus(c0), { offline: true }); L0.update(30, cam); L0.audio.feed(cam, { x: 0, y: 0, z: -1 }, 30 + L0.colliders.warm, 0);
    const s0 = L0.audio.stats; ok(s0.engine + s0.bus + s0.scooter <= 1, `the alley's first frame: ${s0.engine} engine, ${s0.bus} bus, ${s0.scooter} scooter voices (<= 1; P6 3 + 2 before the first occlusion scan)`); }
  { const a = res.alley.st; ok(a.trafOcc >= 0.3 && a.engine + a.bus <= 2, `occlusion colour: ${(100 * a.trafOcc).toFixed(0)} % of the alley's traffic bed reaches it through buildings (>= 30 %: 800 Hz, -6 dB + 6 per building), engine voices ${a.engine + a.bus} (<= 2; P5 6), its centroid ${res.alley.cen.toFixed(0)} Hz`); }
  // P4 sound #2: an 8-lane arterial out-shouts the crowd street (P3: station -13.2 vs walking -10.4); #5: the club doors
  // no longer run hot (P3 club spot -3.4 LU, level with the props) but the club street is still heard
  // P7 (sound #4, margins): >= +4 -> +4.5 (P6 +4.7 on the merge: a 0.7 margin)
  ok(res.station.lu >= res.walking.lu + 4.5, `Yanghwa-ro roars: the station is ${res.station.lu.toFixed(1)} LU, ${(res.station.lu - res.walking.lu).toFixed(1)} over the walking street (>= +4.5; P3 -2.8, P4 main -0.8, P5 on the game's city +2.7, P6 +4.7), wet tyres ${L0wet}, engine voices ${res.station.st.engine}, traffic near ${(+res.station.st.trafficNear).toFixed(1)}`);
  // P5 sound #3: a roar, not a hiss (P4: flat to 4 kHz, 8 kHz -5.6 dB, centroid 1.5 kHz; traffic at 30 m: 0.5-1 kHz peak, <= -10 dB by 8 kHz)
  // P6 (sound #2): the weight in the low mids (P5: 2 kHz level with 1 kHz, the full-chain centroid 1.47-1.53 kHz)
  { const so = res.station.oct, mx = Math.max(...so), lm = Math.max(so[1], so[2], so[3]), st = res.station.st;
    // P7 (sound #2): the arterial has a floor: the buses' and trucks' diesel sub layer puts the 63 Hz octave within 6 dB of
    // the loudest (P6 -9.7 on the full chain, -8.6 here; trucks and buses at 20-30 m: within 3-4 dB of the peak)
    ok(res.station.o63 >= -6 && res.station.low < 0.3, `Yanghwa-ro has a sub floor: the 63 Hz octave ${res.station.o63.toFixed(1)} dB re the loudest (>= -6; P6 -8.6), ${(100 * res.station.low).toFixed(0)} % under 120 Hz (< 30, a phone)`);
    ok(so[6] - mx <= -10 && res.station.cen < 1200 && so[4] <= lm - 3 && st.passbys >= 1, `Yanghwa-ro roars, not hisses: 8 kHz ${(so[6] - mx).toFixed(1)} dB re the loudest octave (<= -10; P4 -5.6), centroid ${res.station.cen.toFixed(0)} Hz (< 1200; P4 1.5 k, P5 on the game's city 1.33 k), 2 kHz ${(so[4] - lm).toFixed(1)} dB re the loudest of 250 Hz-1 kHz (<= -3; P5 +1.8), pass-bys ${st.passbys} in 12 s (3-6 s apart), p95 - p50 ${res.station.sp.toFixed(1)} dB (P4 0.6)`); }
  // P5 sound #4: Hongdae's own voices: shop callers on the walking street, glasses and bottles at the tables
  ok(res.walking.st.callers >= 1 && res.club.st.clinks >= 1, `Hongdae's own voices: shop callers ${res.walking.st.callers} at the walking-street hover, clinks ${res.club.st.clinks} on the club street (12 s each)`);
  ok(res.club.lu <= -6 && res.club.lu > -12, `the club doors are cooled: the club spot is ${res.club.lu.toFixed(1)} LU (-12 to -6; P3 -3.4)`);
  const fv = four.map(([, v]) => v);   // (P5: the alley is meant to be quiet; its own row is above)
  ok(fv.every((v) => v.low < 0.3 && v.lu - v.ph < 5 && v.ph > -17), `voiced for a phone speaker (walking, junction, club, station): < 120 Hz ${fv.map((v) => (100 * v.low).toFixed(0)).join(' / ')} % (< 30; P2 club 53 %), through a 350 Hz high-pass ${fv.map((v) => v.ph.toFixed(1)).join(' / ')} LU (> -17; P2 club street -18.2), losing ${fv.map((v) => (v.lu - v.ph).toFixed(1)).join(' / ')} (< 5)`);
  // sound #1: peaks. Momentary loudness p95 - p50 on the hero streets (P2 0.7-1.3 dB everywhere; a recorded crowd 5.3)
  const walk = await cityAt({ y: 3 }, 20, { path: S065 }), club = await cityAt({ y: 3 }, 20, { path: CLUB }), sw = spread(walk.L, walk.R), sc = spread(club.L, club.R);
  ok(sw >= 4 && sc >= 4, `the map has peaks: p95 - p50 ${sw.toFixed(1)} dB along the walking street, ${sc.toFixed(1)} along the club street (>= 4 / 4; P2 0.7-1.3)`);
  // P4 sound #3: a hover breathes (group laughter swells, names called, a phone's K-pop, scooter horns; P3 2.5-2.9 dB)
  const ws = res.walking.st; ok(res.walking.sp >= 4.5 && res.walking.cv >= 0.7 && ws.swells >= 1, `a hover breathes: p95 - p50 ${res.walking.sp.toFixed(1)} dB at the walking-street hover (>= 4.5; P3 2.9), the 300-3000 Hz envelope's CV ${res.walking.cv.toFixed(2)} (>= 0.7; P4 full chain 0.44, recorded 0.80); in 12 s: laughter swells ${ws.swells}, names ${ws.names}, groups passing ${ws.groups}, phones ${ws.phones}, scooter horns ${ws.beeps}, chimes ${ws.chimes}`);
  const clubC = octaves(club.L, club.R); ok(clubC.low < 0.4, `club street: ${(100 * clubC.low).toFixed(0)} % of the energy under 120 Hz (P2 53 %), staff calls ${club.stats.calls}, queue chatter on`);
  // P6 (sound #5): the club path has dynamics: the doors pop open between their cycles (+9 dB for 0.5-2 s), the staff call
  // the line every 6-10 s (P5: the path's envelope CV 0.56 next to the walking street's 0.81)
  // P7 (sound #3, the club street's own character): the doors carry the bass (shut -22 dB, pops every 2.6-4.6 s with 1-3 s
  // gaps), the queues and the club streets' cars -3 dB: the path's CV >= 0.7 (P6 0.65 here, 0.61 on the full chain)
  { const cvC = rhythm(club.L, club.R, 300, 3000)[1]; ok(cvC >= 0.7 && club.stats.doorPops >= 3 && club.stats.calls >= 2 && sc >= 5, `the club path breathes: the 300-3000 Hz envelope's CV ${cvC.toFixed(2)} (>= 0.7; P5 0.56, P6 0.65), p95 - p50 ${sc.toFixed(1)} dB (>= 5), door pops ${club.stats.doorPops} (>= 3), staff calls ${club.stats.calls} in 20 s`); }
  // sound #3: the babble re-voiced. Octave spectrum of the crowd bed alone within 3 dB of a recorded crowd per octave,
  // reference: seoul/audio's P2 public-domain restaurant crowd (-3.9, 0, -1.6, -7.9, -14.3, -15.1, -18.6 dB re 250 Hz)
  const REF = [-3.9, 0, -1.6, -7.9, -14.3, -15.1, -18.6], cr = await cityAt(spots.walking, 16, { solo: 'crowd' }), co = octaves(cr.L, cr.R).oct, dev = co.map((v, i) => v - REF[i]);
  ok(dev.every((d) => Math.abs(d) <= 3), `the babble's octave spectrum is within 3 dB of a recorded crowd: ${dev.map((d) => (d >= 0 ? '+' : '') + d.toFixed(1)).join(' ')} dB at 125 Hz-8 kHz (P2: 1 kHz -5.6, 4 kHz +13.8)`);
  const [syl, cv] = rhythm(cr.L, cr.R);
  ok(syl >= 0.35 && syl <= 0.5 && cv >= 0.75 && cv <= 0.95, `the babble talks, not ticks: the 300-1000 Hz envelope's 2-8 Hz share ${syl.toFixed(2)} (0.35-0.5; P3 0.66, recorded 0.39), CV ${cv.toFixed(2)} (0.75-0.95; P3 0.61, recorded 0.80)`);
  const beds = await cityAt(spots.walking, 32, { solo: 'beds' }), [ac, lag] = acPeak(beds.L, 2.5, 15);
  ok(ac < 0.07, `no loops in the beds: autocorrelation peak ${ac.toFixed(2)} at ${lag.toFixed(2)} s over 2.5-15 s lags (< 0.07: the babble plays as grains; P3 0.08-0.10 at 11.99 s, the 12 s loop; P1 0.36-0.67 at 5.00 s)`);
  // sound #6: Yanghwa-ro and exit 9 have their events: horns from the nearest 100 m of road, the crossing guide at each
  // walk phase within 60 m (a 45 s hover 25 m off the Yanghwa-ro x Hongik-ro crossings), the exit 9 crowd and draught
  const yh = await cityAt({ x: -45, y: 6, z: -236 }, 45);
  ok(yh.stats.horns >= 1 && yh.stats.guides >= 1 && res.station.st.exit >= 1, `Yanghwa-ro and exit 9 (a 45 s hover): horns ${yh.stats.horns}, crossing guides ${yh.stats.guides}; the exit 9 crowd and stair draught play at the station front (P2: 0 horns and 0 guides in 96 s)`);
  // sound #6 (G1/F1 add a crossing at exit 9; the guide then plays within SND.guideR): a note, not a gate
  // P6 (sound #4/#6): exit 9 for real. The sound's own crosswalk at the stair mouth (the sim's nearest is 140 m off) keeps
  // its road's signal phase; a 45 s hover at the station front hears its guide, a line 2 train and the T-money gates after
  if (layout.hero?.some((h) => h.id === 'exit9')) {
    const ex = await cityAt(spots.station, 45, {}), st = ex.stats;
    ok(st.guides >= 1 && st.trains >= 1 && st.tmoney >= 5, `exit 9 (a 45 s hover at the station front): crossing guides ${st.guides} (>= 1; P5 0: the nearest sim crossing 140 m off), trains ${st.trains}, T-money beeps ${st.tmoney} (>= 5), the escalator under the exit's crowd`);
  }
  const ctx = new WA.OfflineAudioContext(2, SR, SR), ma = new MotorAudio(); ma.startOffline(ctx); ma.openWorld();
  for (let f = 0; f < 30; f++) ma.update([0.392, 0.392, 0.392, 0.392], 0, 0, false, false, {}, f / 30); const dHover = 20 * Math.log10(ma.duck);
  for (let f = 30; f < 60; f++) ma.update([0.85, 0.85, 0.85, 0.85], 12, 0, false, false, {}, f / 30); const dFull = 20 * Math.log10(ma.duck);
  ok(dHover > -0.5 && dFull >= -6.01 && dFull < -3, `world duck: ${dHover.toFixed(1)} dB at a hover, ${dFull.toFixed(1)} dB at full throttle (at most 6)`);
}
// ---- calibration (sound #1): one-shots and loops are rendered at unit active RMS, so SND figures are levels at 1 m
{
  const { makeBabble, synthLoop, unitRms } = await import('../seoul-audio.js');
  const rms = (c) => { let s = 0; for (const x of c) for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / (c.length * c[0].length)); };
  const bab = makeBabble(), club = synthLoop('club', 1), kp = synthLoop('kpop', 2), t = [new Float32Array(2205), new Float32Array(2205)]; t[0][100] = 1; unitRms(t, 22050);
  ok([rms(bab.out), rms([club.L, club.R]), rms([kp.L, kp.R])].every((v) => Math.abs(20 * Math.log10(v)) < 1.5), `loops at unit RMS: babble ${db(rms(bab.out))}, club ${db(rms([club.L, club.R]))}, kpop ${db(rms([kp.L, kp.R]))} dB`);
}
// ---- 1. the map: a path over the hero spots, city alone at its out
const life = build(layout, LIFE);
const pts = (layout.hero?.length >= 2 ? layout.hero.map((h) => [h.pos[0], h.pos[2]]) : layout.streets.slice(0, 2).flatMap((s) => [s.points[0], s.points[s.points.length - 1]]));
const DUR = +(process.env.DUR || 24);
{
  const ctx = new WA.OfflineAudioContext(2, DUR * SR, SR); life.audio.attach(ctx, worldBus(ctx), { offline: true });   // as on the world path
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
  ok(nan === 0, 'no NaN'); ok(pk < 1.6, `peaks at the city out stay within the brickwall's +4 dB range (peak ${db(pk)} dBFS; the limiter and brickwall follow in game)`);
  ok(log.every((e) => e.rms > 1e-4), 'never silent'); ok(Math.max(...log.map((e) => e.rms)) / Math.min(...log.map((e) => e.rms)) > 2, 'it is a map, not a loop: >6 dB swing along the path');
  ok(life.audio.stats.voices <= 28, `voice budget ${life.audio.stats.voices} (beds + reverbs + positional; P4: 6 engine voices for the arterials, was 4: 26)`);
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
  // P6 (sound #6): with `count` it says how many buildings: two 10 m blocks 10 m apart, a ray through one, then both
  { const sq = (x0) => ({ footprint: [[x0, 0], [x0 + 10, 0], [x0 + 10, 10], [x0, 10]], floors: 4 }), o2 = makeOccluder({ lots: [sq(0), sq(20)] });
    const n0 = o2(-5, 2, -5, -5, 2, 15, true), n1 = o2(-5, 2, 5, 15, 2, 5, true), n2 = o2(-5, 2, 5, 35, 2, 5, true), nOver = o2(-5, 20, 5, 35, 20, 5, true);
    ok(n0 === 0 && n1 === 1 && n2 === 2 && nOver === 0, `occluder counts buildings: ${n0} beside, ${n1} through one, ${n2} through two, ${nOver} over their roofs`); }
  const ctx = new WA.OfflineAudioContext(2, 3 * SR, SR), ma = new MotorAudio(); ma.startOffline(ctx);
  const clip = life.audio.clip(ctx, ma);
  for (let f = 0; f < 3 * FPS; f++) { const at = f / FPS, cam = { x: -36, y: 3, z: -23 + f * 0.1 }; ma.update([0.4, 0.4, 0.4, 0.4], 3, 0, false, false, {}, at); clip.feed(cam, { x: 0, y: 0, z: 1 }, 50 + at, at); }
  const b = await ctx.startRendering(); let s = 0; const L = b.getChannelData(0); for (let i = SR; i < L.length; i++) s += L[i] * L[i];
  ok(Math.sqrt(s / (L.length - SR)) > 1e-3, 'HQ clip path: the city renders on an offline context alongside the motors');
}
// ---- P3 sound #5: the clip feed takes the take clock (the warm start is added inside, as life.update does), and a clip
// renders the same twice (MotorAudio's offline noise is seeded; the city is a pure function of the clock)
{
  const L3 = build(layout, LIFE), T = 41.3, cam = { x: -36, y: 3, z: -23, copy() {} };
  L3.update(T, cam); const nLive = L3.sim.traffic.n;
  const ctx0 = new WA.OfflineAudioContext(2, SR, SR), clip0 = L3.audio.clip(ctx0, null); L3.sim.advanceTo(0); clip0.feed(cam, { x: 0, y: 0, z: -1 }, T, 0);
  ok(L3.sim.traffic.n === nLive && clip0.warm === L3.colliders.warm, `clip sync: the clip's city at take clock ${T} s is the live city's (traffic step ${L3.sim.traffic.n} vs ${nLive}; warm ${clip0.warm} s)`);
  // each render in a fresh process (node-web-audio-api returns junk for MotorAudio graphs late in a long process):
  // the child prints an FNV hash of the samples and their energy
  const { execFileSync } = await import('child_process'), { fileURLToPath } = await import('url');
  const once = () => { try { return execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, G2_CLIP_ONCE: '1' }, encoding: 'utf8', timeout: 120000 }).trim().split('\n').pop(); } catch (e) { return 'error ' + e.message.slice(0, 80); } };
  const a = once(), b = once();
  ok(a === b && /^[0-9a-f]+ [1-9]/.test(a), `clip determinism: two renders of the same clip (motors, a hit, the city) in fresh processes: ${a} / ${b} (P2: Math.random in MotorAudio)`);
}
// ---- P3 bug: the world path ends in a brickwall (P2: +0.9 dBFS overs on club-door kicks, +0.5-1.2 in the first second)
{
  const ctx = new WA.OfflineAudioContext(2, SR / 2, SR), ma = new MotorAudio(); ma.startOffline(ctx); const w = ma.openWorld();
  ma.update([0.392, 0.392, 0.392, 0.392], 0, 0, false, false, {}, 0); ma.master.gain.value = 1;
  const o = ctx.createOscillator(), e = ctx.createGain(); o.frequency.value = 60; e.gain.setValueAtTime(0, 0); e.gain.setValueAtTime(2.2, 0.05); e.gain.setValueAtTime(0, 0.25); o.connect(e); e.connect(w); o.start(0);   // a +7 dBFS kick, cold
  const b = await ctx.startRendering(); let pk = 0; for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) if (isFinite(d[i])) pk = Math.max(pk, Math.abs(d[i])); }
  ok(pk > 0.5 && pk <= 0.97, `brickwall: a cold +7 dBFS burst into the world path peaks at ${db(pk)} dBFS (ceiling -0.3)`);
}
// ---- P3 ux #1: movers speak. A person the drone bumps yelps (and the clip path hears it too)
{
  const L5 = build(layout, LIFE), ctx = new WA.OfflineAudioContext(2, SR, SR); L5.audio.attach(ctx, worldBus(ctx), { offline: true });
  const cam0 = { x: -36, y: 1.5, z: -23, copy() {} }; L5.update(30, cam0); const C = L5.crowd;
  let best = -1, bd = 1e9; for (let i = 0; i < C.people.length; i++) if (C.VIS[i] && C.WALK[i] < 0.3) { const d = (C.X[i] + 36) ** 2 + (C.Z[i] + 23) ** 2; if (d < bd) { bd = d; best = i; } }
  for (let f = 0; f < 10; f++) { const at = f / FPS; L5.update(30 + at, cam0); const cam = { x: C.X[best] + 0.2, y: 1.5, z: C.Z[best], copy() {} }; L5.audio.feed(cam, { x: 0, y: 0, z: -1 }, 30 + at + L5.colliders.warm, at); }
  ok(L5.audio.stats.yelps >= 1, `movers speak: a person the drone bumps yelps (${L5.audio.stats.yelps} yelp, ${L5.audio.stats.reacts} reactions)`);
}
process.exit(fail ? 1 : 0);
