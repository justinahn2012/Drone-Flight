// seoul-audio.js: the Hongdae night soundscape (S4, phase-2 stream G). A map, not a loop: zone beds that follow the
// camera (traffic wash, crowd babble that swells with the people around you, AC hum in the alleys, the city floor) and
// positional sources fed by the life sims: engines and tyres with Doppler, scooters, bus air brakes and the bus-stop
// chime, taxi horns, shop speakers in doorways, club kick leaking from doors, busking PAs with applause, laughs and
// shouts paced by the crowd, heels within a few metres, convenience-store door chimes, the crossing's voice guide and
// tick, neon buzz, pocha sizzle. Everything is synthesised here (original procedural pieces: no real songs, no samples)
// unless recorded beds are loaded (BEDS / loadBeds: CC0 or own recordings only).
//
//   const sa = createSeoulAudio(layout, life, { signs, rain })   // life = seoul-life.js build() result (or null)
//   sa.attach(ctx, dest, { offline, low, raw })   // dest = MotorAudio.bus: the city goes to its world path (sound #1):
//                                                  // after the camera chain, ducked <= 6 dB by the props; raw: the old
//                                                  // route through the camera mic chain ("raw cam audio")
//   sa.feed(camPos, camFwd, t, at)  // every frame (life.update calls it); `at` = OfflineAudioContext time for clips
//   sa.clip(actx, motorAudio, { raw }) -> { feed(cam, fwd, t, at) }   // the same city on an HQ clip's offline context
//   sa.loadBeds({ crowd, traffic, alley, rain }) -> Promise   // recorded beds (URLs), granular playback, replace synth
//   sa.setLevel(x) sa.setRain(on) sa.setSigns(emitters) sa.detach() sa.stats
//
// Voice budget: 5 beds + 2 reverbs + 16 positional voices (low: 10) + short one-shots (<= 7 live at once).
// Propagation (sound #5): one 2.5-D ray per positional voice at 10 Hz against the lot footprints and heights: an
// occluded source drops 15 dB behind a 600 Hz low-pass. Canyon sends: alley RT60 0.5 s, Yanghwa-ro 1.2 s.
import { Rng } from './rng.js';

const C_SOUND = 343;
// levels in dB SPL (beds at the street centre; sources at 1 m unless noted). 0 dBFS at the city out = 105 dB SPL.
const dbA = (db) => Math.pow(10, (db - 105) / 20);
// measured RMS of each synthetic bed / loop at unit gain, so SND levels mean what they say (tests/seoul-audio.mjs: cal)
const NORM = { traffic: 13.5, crowd: 17.0, alley: 13.0, air: 12.5, rain: 9.0, music: 17, engine: 14, bus: 12, scooter: 8 };
const nrm = (k) => Math.pow(10, NORM[k] / 20);
export const SND = {
  level: 1,
  world: 0.86,    // trim on the world path, set so the city sits ~9 LU under a hover on the walking street (sound #1)
  beds: { traffic: 77, crowd: 71, alley: 58, air: 54, rain: 66 },
  car: 72, taxi: 70, truck: 76, bus: 80, scooter: 80, tyre: 74,
  music: 85, club: 90, neon: 44, sizzle: 64, hiss: 92, horn: 98, chime: 84, voice: 72, laugh: 76, heel: 66, busk: 101, applause: 88, guide: 80,
  pools: { engine: 4, bus: 1, scooter: 2, music: 3, club: 2, busk: 2, neon: 1, sizzle: 1 },
  poolsLow: { engine: 2, bus: 1, scooter: 1, music: 2, club: 1, busk: 1, neon: 0, sizzle: 1 },
};
// recorded beds (sound #2, Justin decides): URLs per bed; null = synthesised. CC0 / own recordings only.
export const BEDS = { crowd: null, traffic: null, alley: null, rain: null };
const MUSIC_USES = { cafe: ['cafe', 'citypop'], shop: ['kpop', 'kpop', 'citypop'], conv: ['kpop'], karaoke: ['kpop', 'citypop'], bar: ['citypop', 'kpop'], pc: ['kpop'], restaurant: ['cafe'], pocha: ['kpop'] };

// ---------------------------------------------------------------- buffers
// seeded noise. Beds use long ones (13-29 s, own seeds, playback rate wandering +-2 %) so nothing repeats (sound #6)
function noise(ctx, secs, kind = 'white', seed = 1, sr = ctx.sampleRate) {
  const n = Math.floor(sr * secs), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0), R = new Rng(seed);
  let b0 = 0, b1 = 0, b2 = 0, br = 0;
  for (let i = 0; i < n; i++) {
    const w = R.next() * 2 - 1;
    if (kind === 'white') d[i] = w;
    else if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
    else { br = (br + 0.02 * w) / 1.02; d[i] = br * 3.5; }
  }
  const m = Math.floor(sr * 0.05); for (let i = 0; i < m; i++) { const u = i / m; d[i] = d[i] * u + d[n - m + i] * (1 - u); }
  return b;
}
function lfoBuf(ctx, secs, hz, seed) {
  const sr = 3000, n = Math.floor(sr * secs), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0), R = new Rng(seed);
  const k = Math.exp(-2 * Math.PI * hz / sr); let a = 0, c = 0, mx = 1e-6;
  for (let i = 0; i < n + 6000; i++) { a = a * k + (R.next() * 2 - 1) * (1 - k); c = c * k + a * (1 - k); if (i >= 6000) { d[i - 6000] = c; mx = Math.max(mx, Math.abs(c)); } }
  for (let i = 0; i < n; i++) d[i] /= mx;
  return b;
}
// biquad (RBJ) as a per-sample filter for the offline synths
function bq(type, f, q, sr) {
  const w = 2 * Math.PI * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q); let b0, b1, b2;
  const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
  if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; } else if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; } else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
  const B0 = b0 / a0, B1 = b1 / a0, B2 = b2 / a0, A1 = a1 / a0, A2 = a2 / a0; let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = B0 * x + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
// ---- speech-like voice synth (no words): glottal pulses through vowel formants, consonant noise, syllable envelopes
// Korean-ish vowel set (F1, F2, F3 Hz, adult male; female x1.17)
const VOWELS = [[750, 1300, 2600], [480, 1900, 2600], [300, 2250, 3000], [480, 900, 2500], [330, 800, 2400], [380, 1400, 2500], [620, 1100, 2500]];
function voice(out, sr, t0, dur, { f0 = 120, female = false, rate = 5, pitch = 0, gain = 1, pan = 0, seed = 1, laugh = false, glide = 0 } = {}) {
  const L = out[0], Rch = out[1], n0 = Math.floor(t0 * sr), n = Math.min(L.length - n0, Math.floor(dur * sr)); if (n <= 0) return;
  const rnd = new Rng(seed), fk = female ? 1.17 : 1, gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
  const fn = bq('bp', 4500, 1.5, sr), lp = bq('lp', 5200, 0.7, sr);
  let ph = 0, syl = -1, sylT = 0, sylLen = 1 / rate, cons = 0, r1 = null, r2 = null, r3 = null;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if (syl < 0 || t >= sylT + sylLen) {
      syl++; sylT = t; sylLen = laugh ? 0.16 + rnd.next() * 0.05 : (0.7 + rnd.next() * 0.6) / rate;
      const vw = laugh ? VOWELS[0] : VOWELS[Math.floor(rnd.next() * VOWELS.length)]; cons = laugh ? 1 : rnd.next() < 0.7 ? 1 + Math.floor(rnd.next() * 3) : 0;
      r1 = bq('bp', vw[0] * fk, 5, sr); r2 = bq('bp', vw[1] * fk, 6, sr); r3 = bq('bp', vw[2] * fk, 7, sr);
    }
    const u = (t - sylT) / sylLen, env = Math.pow(Math.sin(Math.PI * Math.min(1, u)), 0.7);
    const phr = t / dur, into = 1 + pitch * (0.5 - phr) + glide * phr + 0.04 * Math.sin(2 * Math.PI * 0.7 * t + seed);
    const f = f0 * into * (laugh ? (1.15 - 0.25 * phr) : 1) * (1 + 0.012 * (rnd.next() - 0.5));
    ph += f / sr; if (ph >= 1) ph -= 1;
    const glot = (ph < 0.6 ? Math.sin(Math.PI * ph / 0.6) : 0) - 0.38;
    const nz = rnd.next() * 2 - 1, consE = cons && u < 0.22 ? (1 - u / 0.22) : 0;
    const voiced = (laugh ? (u > 0.2 ? 1 : 0.35) : 1) * (1 - consE * 0.8), exc = glot * voiced, breath = laugh ? 0.5 : 0.08;
    let y = r1(exc) + r2(exc) * 0.55 + r3(exc) * 0.28 + fn(nz) * (consE * (cons === 1 ? 0.9 : cons === 2 ? 0.5 : 0.25) + breath * env * 0.3);
    y = lp(y) * env * gain;
    L[n0 + i] += y * gl; Rch[n0 + i] += y * gr;
  }
}
// babble: ~10 talkers at different distances, phrases and pauses, 22.05 kHz stereo (pre-rendered once)
export function makeBabble(sr = 22050, secs = 12, seed = 5, talkers = 9) { const it = babbleSteps(sr, secs, seed, talkers); let r; while (!(r = it.next()).done); return r.value; }
// a generator: one phrase per step (~10-25 ms on a desktop), so a live attach can render it across frames
export function* babbleSteps(sr = 22050, secs = 12, seed = 5, talkers = 9) {
  const n = Math.floor(sr * secs), out = [new Float32Array(n), new Float32Array(n)], R = new Rng(seed);
  for (let k = 0; k < talkers; k++) {
    const female = R.next() < 0.5, f0 = female ? 185 + R.next() * 70 : 98 + R.next() * 40, pan = (R.next() * 2 - 1) * 0.85, far = R.next();
    let t = R.next() * 1.5;
    while (t < secs) {
      const len = 0.8 + R.next() * 2.6; voice(out, sr, t, Math.min(len, secs - t), { f0, female, rate: 4.4 + R.next() * 1.8, pitch: (R.next() - 0.3) * 0.25, gain: 0.25 + 0.75 * (1 - far), pan, seed: Math.floor(R.next() * 1e9) });
      t += len + 0.25 + R.next() * 1.4;
      yield k;   // one phrase per step (~10-25 ms)
    }
  }
  const m = Math.floor(sr * 0.08); let pk = 1e-6;
  for (const c of out) { for (let i = 0; i < m; i++) { const u = i / m; c[i] = c[i] * u + c[n - m + i] * (1 - u); } for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(c[i])); }
  for (const c of out) for (let i = 0; i < n; i++) c[i] *= 0.9 / pk;
  return { out, sr, secs };
}
// one-shot banks (laughs, shouts, cheers, clapping, voice guide, bus announcement, chimes, horns, heels): pre-rendered
function makeOneShots(sr = 22050, seed = 9) {
  const R = new Rng(seed), bank = { laugh: [], shout: [], horn: [], heel: [], step: [] };
  const mk = (secs) => [new Float32Array(Math.floor(secs * sr)), new Float32Array(Math.floor(secs * sr))];
  const norm = (o) => { let pk = 1e-6; for (const c of o) for (const v of c) pk = Math.max(pk, Math.abs(v)); for (const c of o) for (let i = 0; i < c.length; i++) c[i] *= 0.9 / pk; return o; };
  const speaker = (o, lo, hi, drive) => { const hp = [bq('hp', lo, 0.7, sr), bq('hp', lo, 0.7, sr)], lp = [bq('lp', hi, 0.7, sr), bq('lp', hi, 0.7, sr)]; for (let c = 0; c < 2; c++) for (let i = 0; i < o[c].length; i++) o[c][i] = Math.tanh(lp[c](hp[c](o[c][i])) * drive); };
  const tone = (o, f, t0, secs, dec, partial = 0) => { for (let i = 0; i < secs * sr; i++) { const t = i / sr, j = Math.floor(t0 * sr) + i; if (j >= o[0].length) break; const v = (Math.sin(2 * Math.PI * f * t) + partial * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t * 9)) * Math.exp(-t * dec) * 0.5; o[0][j] += v; o[1][j] += v; } };
  for (let k = 0; k < 6; k++) { const female = k % 2 === 0, o = mk(1.3); voice(o, sr, 0.02, 0.9 + R.next() * 0.35, { f0: female ? 260 : 150, female, laugh: true, seed: 100 + k }); bank.laugh.push(norm(o)); }
  for (let k = 0; k < 6; k++) { const female = k % 2 === 1, o = mk(0.8); voice(o, sr, 0.02, 0.35 + R.next() * 0.35, { f0: female ? 300 : 170, female, rate: 3, glide: k % 3 === 0 ? 0.4 : -0.3, seed: 200 + k }); bank.shout.push(norm(o)); }
  { const o = mk(2.4); for (let k = 0; k < 12; k++) voice(o, sr, R.next() * 0.3, 1.6 + R.next() * 0.4, { f0: (k % 2 ? 230 : 140) * (1 + 0.1 * R.next()), female: k % 2 === 1, rate: 1.2, glide: 0.3, gain: 0.6, pan: R.next() * 2 - 1, seed: 300 + k }); bank.cheer = norm(o); }
  { const o = mk(4);
    for (let c = 0; c < 40; c++) {
      let t = R.next() * 0.4; const rate = 3 + R.next() * 2, pan = R.next() * 2 - 1, gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4), f = bq('bp', 1100 + R.next() * 900, 1.2, sr);
      while (t < 3.6) { const i0 = Math.floor(t * sr), env = Math.min(1, (3.6 - t) / 1.2); for (let i = 0; i < 0.025 * sr && i0 + i < o[0].length; i++) { const v = f(R.next() * 2 - 1) * Math.exp(-i / (0.004 * sr)) * env; o[0][i0 + i] += v * gl; o[1][i0 + i] += v * gr; } t += (0.8 + 0.4 * R.next()) / rate; }
    }
    bank.clap = norm(o); }
  { const o = mk(2.6); tone(o, 1319, 0, 0.6, 5, 0.3); tone(o, 1047, 0.32, 0.6, 5, 0.3); voice(o, sr, 0.85, 1.6, { f0: 215, female: true, rate: 5.5, pitch: 0.1, gain: 0.8, seed: 404 }); speaker(o, 450, 3400, 2.2); bank.guide = norm(o); }
  { const o = mk(2.8); tone(o, 784, 0, 0.7, 4); tone(o, 659, 0.35, 0.7, 4); voice(o, sr, 0.9, 1.8, { f0: 225, female: true, rate: 5.8, pitch: -0.05, gain: 0.7, seed: 505 }); speaker(o, 500, 3200, 2); bank.bus = norm(o); }
  { const o = mk(1.4); tone(o, 1319, 0, 0.9, 3.5, 1); tone(o, 1047, 0.42, 0.9, 3.5, 1); bank.conv = norm(o); }
  // Korean car horns: dual-tone ~420/510 Hz, short; a double-beep variant; band-limited and a little driven
  for (let k = 0; k < 3; k++) {
    const o = mk(0.8), beeps = k === 2 ? [[0, 0.11], [0.2, 0.13]] : [[0, 0.16 + 0.12 * k]];
    for (const [t0, len] of beeps) for (let i = 0; i < len * sr; i++) { const t = i / sr, e = Math.min(1, t / 0.008) * Math.min(1, (len - t) / 0.02), v = Math.tanh(0.9 * (((((420 + 15 * k) * t) % 1) * 2 - 1) + ((((505 + 10 * k) * t) % 1) * 2 - 1))) * e, j = Math.floor(t0 * sr) + i; o[0][j] += v; o[1][j] += v; }
    const f = [bq('bp', 1300, 0.5, sr), bq('bp', 1300, 0.5, sr)]; for (let c = 0; c < 2; c++) for (let i = 0; i < o[c].length; i++) o[c][i] = f[c](o[c][i]) + 0.4 * o[c][i];
    bank.horn.push(norm(o));
  }
  for (let k = 0; k < 4; k++) { const o = mk(0.08), r1 = bq('bp', 2600 + 500 * k, 9, sr), r2 = bq('bp', 4300 + 300 * k, 7, sr); for (let i = 0; i < o[0].length; i++) { const x = (i < 30 ? R.next() * 2 - 1 : 0) + (i === 0 ? 4 : 0), v = (r1(x) + 0.6 * r2(x)) * Math.exp(-i / (0.012 * sr)); o[0][i] = v; o[1][i] = v; } bank.heel.push(norm(o)); }
  for (let k = 0; k < 4; k++) { const o = mk(0.12), f = bq('bp', 900 + 250 * k, 0.9, sr); for (let i = 0; i < o[0].length; i++) { const v = f(R.next() * 2 - 1) * Math.pow(Math.sin(Math.PI * i / o[0].length), 2); o[0][i] = v; o[1][i] = v; } bank.step.push(norm(o)); }
  { const o = mk(0.12); for (let i = 0; i < o[0].length; i++) { const t = i / sr, v = Math.sign(Math.sin(2 * Math.PI * 880 * t)) * Math.exp(-t * 40) * 0.4; o[0][i] = v; o[1][i] = v; } speaker(o, 500, 3000, 1.5); bank.tick = norm(o); }
  return bank;
}
// acoustic busker loop: Karplus-Strong guitar strums over a progression + a la-la vocal line (original, procedural)
function makeAcousticLoop(sr = 22050, seed = 3) {
  const R = new Rng(seed), beat = 60 / 92, bars = 8, secs = bars * 4 * beat, n = Math.ceil(secs * sr), out = [new Float32Array(n), new Float32Array(n)];
  const prog = [[57, 'M'], [52, 'M'], [54, 'm'], [50, 'M']], CHd = { M: [0, 4, 7, 12, 16, 19], m: [0, 3, 7, 12, 15, 19] };
  const pluck = (f, t0, amp, pan) => {
    const N = Math.max(2, Math.round(sr / f)), buf = new Float32Array(N); for (let i = 0; i < N; i++) buf[i] = R.next() * 2 - 1; let idx = 0;
    const i0 = Math.floor(t0 * sr), gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    for (let i = 0; i < 2.2 * sr; i++) { const j = (i0 + i) % n, v = 0.5 * (buf[idx] + buf[(idx + 1) % N]) * 0.996; buf[idx] = v; idx = (idx + 1) % N; out[0][j] += v * amp * gl; out[1][j] += v * amp * gr; }
  };
  for (let bar = 0; bar < bars; bar++) {
    const [root, q] = prog[bar % 4], tb = bar * 4 * beat;
    for (const [bt, down] of [[0, 1], [1, 1], [1.5, 0], [2.5, 0], [3, 1], [3.5, 0]]) CHd[q].forEach((iv, s) => pluck(440 * Math.pow(2, (root - 12 + iv - 69) / 12), tb + bt * beat + (down ? s : 5 - s) * 0.012, 0.18, -0.2));
  }
  const scale = [0, 2, 4, 7, 9, 12]; let t = 0.5;
  while (t < secs - 1) {
    const len = beat * (1 + Math.floor(R.next() * 3)), bar = Math.floor(t / (4 * beat)) % 4, m = prog[bar][0] + 12 + scale[Math.floor(R.next() * scale.length)];
    voice(out, sr, t, len * 0.95, { f0: 440 * Math.pow(2, (m - 69) / 12), female: R.next() < 0.5, rate: 1 / len, gain: 0.5, pan: 0.1, seed: Math.floor(R.next() * 1e9) });
    t += len + (R.next() < 0.15 ? beat : 0);
  }
  let pk = 1e-6; for (const c of out) for (const v of c) pk = Math.max(pk, Math.abs(v)); for (const c of out) for (let i = 0; i < n; i++) c[i] *= 0.9 / pk;
  return { L: out[0], R: out[1], sr, dur: secs };
}
function irBuf(ctx, rt60, secs, seed, sr = ctx.sampleRate) {   // a convolver needs the context rate
  const n = Math.floor(sr * secs), b = ctx.createBuffer(2, n, sr), R = new Rng(seed);
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); let lp = 0; for (let i = Math.floor(0.008 * sr); i < n; i++) { const t = i / sr, k = Math.min(0.9, 0.1 + 0.8 * t / rt60); lp = lp * k + (R.next() * 2 - 1) * (1 - k); d[i] = lp * Math.sqrt((1 + k) / (1 - k)) * Math.pow(10, -3 * t / rt60) * 0.35; } }
  return b;
}

// ---------------------------------------------------------------- original music loops (procedural, never a real song)
const STYLES = {
  kpop: { bpm: [122, 128], minor: true, prog: [[0, 'm'], [8, 'M'], [3, 'M'], [10, 'M']], kick: 'four', bass: 'eighth', keys: 'saw', arp: true },
  citypop: { bpm: [100, 112], minor: false, prog: [[5, 'M7'], [4, 'm7'], [9, 'm9'], [0, 'M7']], kick: 'back', bass: 'sync', keys: 'ep', arp: true },
  cafe: { bpm: [78, 88], minor: false, prog: [[0, 'M7'], [7, 'M'], [9, 'm7'], [5, 'M7']], kick: 'none', bass: 'half', keys: 'ep', arp: false },
  club: { bpm: [124, 130], minor: true, prog: [[0, 'm'], [0, 'm'], [8, 'M'], [10, 'M']], kick: 'four', bass: 'offbeat', keys: 'stab', arp: false },
};
const CH = { m: [0, 3, 7], M: [0, 4, 7], M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m9: [0, 3, 7, 10, 14] };
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
export function synthLoop(style, seed, sr = 22050) {
  const S = STYLES[style] || STYLES.kpop, R = new Rng(seed * 7919 + 13);
  const bpm = S.bpm[0] + R.next() * (S.bpm[1] - S.bpm[0]), beat = 60 / bpm, bars = 4, dur = bars * 4 * beat, n = Math.ceil(dur * sr);
  const L = new Float32Array(n), Rr = new Float32Array(n), root = 45 + Math.floor(R.next() * 7);
  const add = (t0, len, pan, fn) => {
    const i0 = Math.floor(t0 * sr), i1 = Math.min(n + Math.floor(len * sr), i0 + Math.floor(len * sr)), gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    for (let i = i0; i < i1; i++) { const v = fn((i - i0) / sr), j = i % n; L[j] += v * gl; Rr[j] += v * gr; }
  };
  const nz = new Rng(seed + 99);
  for (let bar = 0; bar < bars; bar++) {
    const [deg, q] = S.prog[bar % S.prog.length], chord = CH[q].map((x) => root + 12 + deg + x), bass = root - 12 + deg + (deg > 6 ? -12 : 0) + 12;
    const tb = bar * 4 * beat;
    for (let b = 0; b < 4; b++) {
      const t = tb + b * beat;
      const kick = S.kick === 'four' || (S.kick === 'back' && (b === 0 || b === 2));
      // kick: body + a 1-3 kHz beater click (what a phone speaker and a closed door let through: sound #4)
      if (kick) add(t, 0.32, 0, (x) => Math.sin(2 * Math.PI * (45 * x + 70 * (1 - Math.exp(-x * 30)) / 30)) * Math.exp(-x * 9) * 0.9 + (nz.next() * 2 - 1) * Math.exp(-x * 160) * 0.35 + Math.sin(2 * Math.PI * 1800 * x) * Math.exp(-x * 90) * 0.25);
      if (S.kick !== 'none' && (b === 1 || b === 3)) add(t, 0.18, 0.05, (x) => ((nz.next() * 2 - 1) * 0.55 + Math.sin(2 * Math.PI * 190 * x) * 0.3) * Math.exp(-x * 22) * 0.6);
      if (S.kick !== 'none') for (let h = 0; h < 2; h++) add(t + h * beat / 2 + (S.kick === 'back' ? beat / 4 : 0) * h, 0.05, 0.3, (x) => (nz.next() * 2 - 1) * 0.22 * Math.exp(-x * 60));
      if (S.kick === 'back' && b === 3) add(t + beat / 2, 0.25, 0, (x) => Math.sin(2 * Math.PI * (48 * x)) * Math.exp(-x * 10) * 0.6);
    }
    const bf = mtof(bass), bassNotes = S.bass === 'eighth' ? [0, .5, 1, 1.5, 2, 2.5, 3, 3.5] : S.bass === 'sync' ? [0, .75, 1.5, 2, 2.75, 3.5] : S.bass === 'offbeat' ? [.5, 1.5, 2.5, 3.5] : [0, 2];
    for (const bt of bassNotes) {
      const oct = S.bass === 'sync' && bt === 0.75 ? 2 : 1, len = S.bass === 'half' ? 1.8 * beat : 0.42 * beat;
      let lp = 0; add(tb + bt * beat, len, 0, (x) => { const ph = (bf * oct * x) % 1, s = 2 * ph - 1; lp += (s - lp) * 0.12; return lp * Math.min(1, x * 200) * Math.exp(-x * (S.bass === 'half' ? 1.5 : 5)) * 0.55; });
    }
    if (S.keys === 'ep') {
      const hits = style === 'cafe' ? [0, 2] : [0, 1.5, 2.5];
      for (const ht of hits) chord.forEach((m, k) => { const f = mtof(m); add(tb + ht * beat + k * 0.008, 1.6 * beat, (k - 1.5) * 0.25, (x) => (Math.sin(2 * Math.PI * f * x) + 0.25 * Math.sin(4 * Math.PI * f * x) * Math.exp(-x * 6)) * Math.exp(-x * 2.2) * 0.13); });
    } else if (S.keys === 'saw') {
      chord.forEach((m, k) => { const f = mtof(m); let lp = 0; add(tb, 4 * beat, (k - 1) * 0.4, (x) => { const s = ((f * x) % 1 + (f * 1.006 * x) % 1) - 1; lp += (s - lp) * 0.08; return lp * Math.min(1, x * 8) * 0.09; }); });
    } else if (S.keys === 'stab') {
      for (const st of [0.5, 2.5]) chord.forEach((m, k) => { const f = mtof(m); add(tb + st * beat, 0.25, 0, (x) => (((f * x) % 1) * 2 - 1) * Math.exp(-x * 14) * 0.12); });
    }
    // a wordless vocal hook (la-la on chord tones) in pop styles: the mids a shop speaker actually carries
    if ((style === 'kpop' || style === 'citypop') && bar % 2 === 0) { const vr = new Rng(seed * 31 + bar); let tv = tb + beat * 0.5; const out2 = [L, Rr];
      while (tv < tb + 3.5 * beat) { const len = beat * (0.5 + 0.5 * Math.floor(vr.next() * 3)), m = chord[Math.floor(vr.next() * chord.length)] + 12;
        voice(out2, sr, tv, Math.min(len * 0.92, n / sr - tv), { f0: mtof(m), female: true, rate: 1 / len, gain: 0.55, pan: 0.05, seed: Math.floor(vr.next() * 1e9) }); tv += len; } }
    if (S.arp) for (let k = 0; k < 16; k++) {
      const m = chord[(k * (R.next() < 0.8 ? 1 : 2)) % chord.length] + 12, f = mtof(m);
      add(tb + k * beat / 4, beat / 4, ((k % 4) - 1.5) * 0.3, (x) => (((f * x) % 1) < 0.5 ? 1 : -1) * Math.exp(-x * 18) * 0.05);
    }
  }
  let pk = 1e-6; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(Rr[i]));
  for (let i = 0; i < n; i++) { L[i] *= 0.9 / pk; Rr[i] *= 0.9 / pk; }
  return { L, R: Rr, sr, dur, bpm };
}

// ---------------------------------------------------------------- 2.5-D occlusion from the lots (sound #5)
export function makeOccluder(layout) {
  const cell = 8, grid = new Map(), key = (i, j) => i * 65536 + j;
  for (const l of layout.lots || []) {
    const f = l.footprint; if (!f || f.length < 3) continue; const h = (l.floors || 3) * (l.floorH || 3.3);
    for (let e = 0; e < f.length; e++) {
      const a = f[e], b = f[(e + 1) % f.length], seg = [a[0], a[1], b[0], b[1], h];
      const i0 = Math.floor(Math.min(a[0], b[0]) / cell), i1 = Math.floor(Math.max(a[0], b[0]) / cell), j0 = Math.floor(Math.min(a[1], b[1]) / cell), j1 = Math.floor(Math.max(a[1], b[1]) / cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); let L = grid.get(k); if (!L) grid.set(k, (L = [])); L.push(seg); }
    }
  }
  let stamp = 0; const seen = new Map();
  // does the segment a -> b cross a building wall below that building's roof?
  return (ax, ay, az, bx, by, bz) => {
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz); if (L < 1) return false;
    stamp++; const steps = Math.ceil(L / (cell * 0.5));
    for (let s = 0; s <= steps; s++) {
      const x = ax + dx * s / steps, z = az + dz * s / steps, L2 = grid.get(key(Math.floor(x / cell), Math.floor(z / cell))); if (!L2) continue;
      for (const g of L2) {
        if (seen.get(g) === stamp) continue; seen.set(g, stamp);
        const sx = g[2] - g[0], sz = g[3] - g[1], den = dx * sz - dz * sx; if (Math.abs(den) < 1e-9) continue;
        const u = ((g[0] - ax) * sz - (g[1] - az) * sx) / den, v = ((g[0] - ax) * dz - (g[1] - az) * dx) / den;
        if (u <= 0.02 || u >= 0.98 || v < 0 || v > 1) continue;
        if (ay + (by - ay) * u < g[4]) return true;
      }
    }
    return false;
  };
}

// ---------------------------------------------------------------- the soundscape
export function createSeoulAudio(layout, life, opts = {}) {
  const lots = (layout.lots || []).filter((l) => l.frontage);
  const front = (l, out = 1.2, y = 1.5) => {
    const [a, b] = l.frontage, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; let cx = 0, cz = 0;
    (l.footprint || [a, b]).forEach((p) => { cx += p[0]; cz += p[1]; }); cx /= (l.footprint || [a, b]).length; cz /= (l.footprint || [a, b]).length;
    let nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L; if ((cx - a[0]) * nx + (cz - a[1]) * nz > 0) { nx = -nx; nz = -nz; }
    return { x: (a[0] + b[0]) / 2 + nx * out, y, z: (a[1] + b[1]) / 2 + nz * out, nx, nz };
  };
  const hero = new Set((layout.streets || []).filter((s) => s.kind === 'walking' || s.kind === 'club').map((s) => s.id));
  const sites = { music: [], club: [], neon: [], sizzle: [] };
  lots.forEach((l, i) => {
    const h = ((i * 2654435761) >>> 0) / 4294967296;
    if (l.use === 'club') sites.club.push({ ...front(l, 0.6, 1.2), id: l.id, phase: h * 97, style: 'club', seed: i });
    else if (MUSIC_USES[l.use] && h < (l.use === 'restaurant' ? 0.3 : 0.75)) {
      const st = MUSIC_USES[l.use], style = hero.has(l.street) && h * 3 % 1 < 0.34 ? 'citypop' : st[Math.floor(h * 7) % st.length];
      // ~45 % play from a doorway speaker (open: full band, 82-88 dB at 2 m); the rest leak through glass
      sites.music.push({ ...front(l, 1.0, 2.4), id: l.id, phase: h * 53, style, seed: i, open: h * 11 % 1 < 0.45 });
    }
    if (l.use === 'pocha') sites.sizzle.push({ ...front(l, 1.6, 0.9), id: l.id });
    if (['bar', 'club', 'karaoke', 'motel', 'pc'].includes(l.use) && h * 5 % 1 < 0.5) sites.neon.push({ ...front(l, 0.3, 3.2), id: l.id, hz: 0 });
  });
  const crossings = life?.sim ? life.sim.net.crossings : [];
  const S = { music: 0, club: 0, busk: 0, engine: 0, scooter: 0, bus: 0, hiss: 0, horns: 0, laughs: 0, applause: 0, steps: 0, chimes: 0, guides: 0, occluded: 0, voices: 0, crowdNear: 0, trafficNear: 0, canyon: 0 };
  const api = { stats: S, sites, attached: false };
  const occl = makeOccluder(layout);
  let A = null;   // the live graph
  let bank = null, babble = null, acoustic = null;   // pre-rendered material (made once, on the first attach)
  const recorded = {};

  api.setSigns = (emitters) => {
    const fl = (emitters || []).filter((e) => e.flicker || e.kind === 'neon');
    if (fl.length) sites.neon = fl.map((e) => ({ x: e.pos[0], y: e.pos[1], z: e.pos[2], id: e.id, hz: e.flicker?.hz || 0, depth: e.flicker?.depth || 0 }));
  };
  if (opts.signs) api.setSigns(opts.signs);

  const toBuf = (ctx, L, R, sr) => { const b = ctx.createBuffer(2, L.length, sr); b.getChannelData(0).set(L); b.getChannelData(1).set(R); return b; };
  function build(ctx, dest, { offline = false, low = false, raw = false } = {}) {
    const G = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const F = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const loop = (buf, rate = 1, off = 0, wander = 0, wseed = 1) => {
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(0, off % buf.duration);
      if (wander) { const l = ctx.createBufferSource(); l.buffer = lfoBuf(ctx, 37, 0.05, wseed); l.loop = true; const d = G(rate * wander); l.connect(d); d.connect(s.playbackRate); l.start(0); }
      return s;
    };
    // pre-rendered material: up front offline (clips, tests); live, in idle slices after attach so the level load
    // doesn't stall (babble ~0.5 s of CPU in 9 steps, one-shots, the acoustic loop, then the shop loops one by one)
    const live = !offline && typeof setTimeout === 'function';
    if (!live) { if (!bank) bank = makeOneShots(); if (!babble) babble = makeBabble(); if (!acoustic) acoustic = makeAcousticLoop(); }
    const target = raw ? dest : (dest && dest.world) || dest, viaWorld = target !== dest;
    const out = G(SND.level * (viaWorld ? SND.world : 1)); out.connect(target);
    // canyon reverbs (sends from the mix)
    const sendA = G(0), sendR = G(0), cvA = ctx.createConvolver(), cvR = ctx.createConvolver();
    cvA.buffer = irBuf(ctx, 0.5, 0.45, 71); cvR.buffer = irBuf(ctx, 1.2, 0.9, 72);
    const mix = G(1); mix.connect(out); mix.connect(sendA); mix.connect(sendR); sendA.connect(cvA); sendR.connect(cvR); cvA.connect(out); cvR.connect(out);
    const g = { ctx, out, mix, sendA, sendR, offline, viaWorld, pv: {}, lastT: null, camV: [0, 0, 0], camPrev: null, rain: !!opts.rain, shots: [], feetPh: new Map(), guideC: null, guideWalk: false, nextTick: 0, buskState: [], occT: -1 };
    const B = (o) => toBuf(ctx, o[0], o[1], 22050);
    const setBank = () => { g.buf = { laugh: bank.laugh.map(B), shout: bank.shout.map(B), cheer: B(bank.cheer), clap: B(bank.clap), guide: B(bank.guide), bus: B(bank.bus), conv: B(bank.conv), tick: B(bank.tick), horn: bank.horn.map(B), heel: bank.heel.map(B), step: bank.step.map(B) }; };
    g.buf = { laugh: [], shout: [], horn: [], heel: [], step: [] }; if (bank) setBank();
    const white = noise(ctx, 3, 'white', 11), bed = () => { const gg = G(0); gg.connect(mix); return gg; };
    g.white = white;
    // ---- beds (voiced for a phone speaker: sound #4; long seeded noise + rate wander: sound #6)
    g.bTraffic = bed();
    {
      const r = loop(noise(ctx, 23.3, 'brown', 13, 16000), 1, 0.3, 0.02, 31), lp = F('lowpass', 180), rg = G(0.55);
      const p = loop(noise(ctx, 19.1, 'pink', 14, 22050), 1, 1.1, 0.02, 32), bp = F('bandpass', 1050, 0.55), p2 = loop(noise(ctx, 17.7, 'pink', 15, 22050), 0.97, 2.3, 0.02, 33), bp2 = F('bandpass', 1250, 0.5);
      const hs = loop(noise(ctx, 13.1, 'white', 16, 22050), 1, 0.4, 0.02, 34), hp = F('bandpass', 3800, 0.7), hg = G(0.12);
      const pl = ctx.createStereoPanner(), pr = ctx.createStereoPanner(); pl.pan.value = -0.55; pr.pan.value = 0.55;
      r.connect(lp); lp.connect(rg); rg.connect(g.bTraffic); p.connect(bp); bp.connect(pl); p2.connect(bp2); bp2.connect(pr); pl.connect(g.bTraffic); pr.connect(g.bTraffic); hs.connect(hp); hp.connect(hg); hg.connect(g.bTraffic); g.hissG = hg;
    }
    g.bCrowd = bed();
    {
      const pa = ctx.createStereoPanner(), pb = ctx.createStereoPanner(); pa.pan.value = -0.35; pb.pan.value = 0.4;
      const hp = F('highpass', 260, 0.7), eq = F('highshelf', 1500); eq.gain.value = 10;   // consonants 2-5 kHz carry on a phone speaker
      pa.connect(hp); pb.connect(hp); hp.connect(eq); eq.connect(g.bCrowd); g.crowdSrc = [pa, pb];
      g.startBabble = () => { const bb = toBuf(ctx, babble.out[0], babble.out[1], babble.sr); loop(bb, 1, 0, 0.02, 41).connect(pa); loop(bb, 0.94, babble.secs * 0.53, 0.02, 42).connect(pb); };
      if (babble) g.startBabble();
    }
    g.bAlley = bed();
    {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 120; const bp = F('bandpass', 480, 2), og = G(0.25); o.connect(bp); bp.connect(og); og.connect(g.bAlley); o.start();
      const fn = loop(noise(ctx, 17.1, 'pink', 17, 16000), 0.8, 2, 0.02, 51), lp = F('lowpass', 1400), fam = G(0.7), fo = ctx.createOscillator(); fo.frequency.value = 23; const fd = G(0.3); fo.connect(fd); fd.connect(fam.gain); fo.start();
      fn.connect(lp); lp.connect(fam); fam.connect(g.bAlley);
    }
    g.bAir = bed(); { const s = loop(noise(ctx, 29.3, 'pink', 18, 16000), 0.6, 0.7, 0.02, 61), lp = F('lowpass', 1100); s.connect(lp); lp.connect(g.bAir); }
    g.bRain = bed(); { const s = loop(noise(ctx, 13.9, 'white', 19, 22050), 1, 0.2, 0.02, 62), hp = F('highpass', 1800), lp = F('lowpass', 9000); s.connect(hp); hp.connect(lp); lp.connect(g.bRain); }
    // ---- positional voices: source chain -> gain -> occlusion low-pass -> air/behind low-pass -> panner -> mix
    const pvoice = (make) => {
      const gi = G(0), oc = F('lowpass', 16000, 0.5), lp = F('lowpass', 12000, 0.5), pn = ctx.createStereoPanner(); gi.connect(oc); oc.connect(lp); lp.connect(pn); pn.connect(mix);
      const v = { g: gi, oc, lp, pn, who: null, occ: 0, occN: 0 }; v.ctl = make(v, gi); return v;
    };
    const P = low ? SND.poolsLow : SND.pools;
    const tyreBuf = noise(ctx, 11.3, 'pink', 21, 22050);
    g.pv.engine = Array.from({ length: P.engine }, (_, k) => pvoice((v, dst) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 30; const lp = F('lowpass', 620), og = G(0.5); o.connect(lp); lp.connect(og); og.connect(dst); o.start();
      const ty = loop(tyreBuf, 1, k * 2.7), bp = F('bandpass', 1000, 0.7), tg = G(0); ty.connect(bp); bp.connect(tg); tg.connect(dst);
      return { o, og, tg, ty, bp };
    }));
    g.pv.bus = Array.from({ length: P.bus }, () => pvoice((v, dst) => {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 34; const lp = F('lowpass', 500), og = G(0.35); o.connect(lp); lp.connect(og); og.connect(dst); o.start();
      const w = ctx.createOscillator(); w.type = 'sine'; w.frequency.value = 700; const wg = G(0.02); w.connect(wg); wg.connect(dst); w.start();
      const ty = loop(tyreBuf, 0.8, 5.1), bp = F('bandpass', 800, 0.6), tg = G(0); ty.connect(bp); bp.connect(tg); tg.connect(dst);
      return { o, og, w, wg, tg, ty };
    }));
    g.pv.scooter = Array.from({ length: P.scooter }, (_, k) => pvoice((v, dst) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 40;
      const sh = ctx.createWaveShaper(), cv = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = i / 127.5 - 1; cv[i] = x > 0.6 ? 1 : x < -0.2 ? -0.3 : x; } sh.curve = cv;
      const bp = F('bandpass', 420, 0.9), og = G(0.6); o.connect(sh); sh.connect(bp); bp.connect(og); og.connect(dst); o.start();
      const ex = loop(white, 1, 0.5 + k), eb = F('bandpass', 1400, 1.2), eam = G(0), od = G(0.6); ex.connect(eb); eb.connect(eam); o.connect(od); od.connect(eam.gain); eam.connect(dst);
      const cvt = ctx.createOscillator(); cvt.frequency.value = 900; const cg = G(0.04); cvt.connect(cg); cg.connect(dst); cvt.start();
      return { o, og, cvt, ex };
    }));
    // shop music: a small doorway speaker (no real bass: 180 Hz high-pass) or the same through glass (2.5 kHz low-pass)
    g.pv.music = Array.from({ length: P.music }, () => pvoice((v, dst) => ({ src: null, glass: (() => { const hp = F('highpass', 380, 0.7), sh = F('highshelf', 2000), f = F('lowpass', 2500, 0.4); sh.gain.value = 9; hp.connect(sh); sh.connect(f); f.connect(dst); f.inp = hp; return f; })() })));
    g.pv.club = Array.from({ length: P.club }, () => pvoice((v, dst) => ({ src: null, glass: (() => { const f = F('lowpass', 400, 0.6); f.connect(dst); return f; })() })));
    // busking PA: band-limited, a little driven, presence peak (a battery PA on a stand)
    g.pv.busk = Array.from({ length: P.busk }, () => pvoice((v, dst) => {
      const hp = F('highpass', 110, 0.7), pk = F('peaking', 2800, 1.0), sh = ctx.createWaveShaper(), cv = new Float32Array(512); for (let i = 0; i < 512; i++) { const x = i / 255.5 - 1; cv[i] = Math.tanh(1.6 * x) / Math.tanh(1.6); } sh.curve = cv; pk.gain.value = 3;
      hp.connect(pk); pk.connect(sh); sh.connect(dst); return { src: null, inp: hp };
    }));
    g.pv.neon = Array.from({ length: P.neon }, () => pvoice((v, dst) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 120; const bp = F('bandpass', 360, 1.5), og = G(0.6); o.connect(bp); bp.connect(og); og.connect(dst); o.start();
      const cr = loop(white, 1.3, 0.1), hp = F('highpass', 3000), cg = G(0.05), cl = loop(lfoBuf(ctx, 4, 12, 81), 1), cd = G(0.05); cl.connect(cd); cd.connect(cg.gain); cr.connect(hp); hp.connect(cg); cg.connect(dst);
      return { o, og };
    }));
    g.pv.sizzle = Array.from({ length: P.sizzle }, () => pvoice((v, dst) => {
      const s = loop(white, 0.9, 0.4), hp = F('highpass', 2500), gg = G(0.4), cr = loop(lfoBuf(ctx, 5, 40, 91), 1), cd = G(0.4); cr.connect(cd); cd.connect(gg.gain);
      s.connect(hp); hp.connect(gg); gg.connect(dst); return {};
    }));
    g.music = { buf: new Map(), acoustic: acoustic ? toBuf(ctx, acoustic.L, acoustic.R, acoustic.sr) : null };
    if (live) {   // idle slices: ~one task per 30 ms until everything is rendered
      const q = [];
      if (!babble) { const it = babbleSteps(); q.push(function step() { const r = it.next(); if (r.done) { babble = r.value; if (!g.dead) g.startBabble(); } else q.unshift(step); }); }
      if (!bank) q.push(() => { bank = makeOneShots(); setBank(); });
      if (!acoustic) q.push(() => { acoustic = makeAcousticLoop(); g.music.acoustic = toBuf(ctx, acoustic.L, acoustic.R, acoustic.sr); });
      const run = () => { if (!q.length || g.dead) { g.idleOn = false; return; } q.shift()(); setTimeout(run, 20); };
      g.idle = (fn, key) => { if (key && g.idleKeys.has(key)) return; if (key) g.idleKeys.add(key); q.push(fn); if (!g.idleOn) { g.idleOn = true; setTimeout(run, 20); } };
      g.idleKeys = new Set(); g.idleOn = true; setTimeout(run, 200);
    }
    S.voices = Object.values(g.pv).reduce((n, a) => n + a.length, 0) + 5 + 2;
    return g;
  }

  api.attach = (ctx, dest, o = {}) => { if (A) api.detach(); A = build(ctx, dest, o); api.__g = A; api.__beds = { bTraffic: A.bTraffic, bCrowd: A.bCrowd, bAlley: A.bAlley, bAir: A.bAir, bRain: A.bRain }; api.attached = true; applyRecorded(A); return api; };
  api.detach = () => { if (!A) return; A.dead = true; try { A.out.disconnect(); } catch (e) {} A = null; api.attached = false; };
  api.setLevel = (x) => { SND.level = x; if (A) A.out.gain.value = x * (A.viaWorld ? SND.world : 1); };
  api.setRain = (on) => { if (A) A.rain = !!on; };
  // HQ clips (sound bug: clipAudio built only MotorAudio): the same city on the clip's OfflineAudioContext, driven per
  // output frame with that frame's camera pose and take clock (main.js clipAudio: see the G report for the 4 lines)
  api.clip = (actx, motor, o = {}) => {
    const g = build(actx, motor ? motor.bus : actx.destination, { offline: true, raw: !!o.raw });
    g.isClip = true; if (!motor) g.out.connect(actx.destination);
    return { graph: g, feed: (cam, fwd, t, at) => { if (life?.sim) { life.sim.advanceTo(t); if (life.crowd) { life.crowd.evaluate(t, cam); refreshFeet(cam); } } feedGraph(g, cam, fwd, t, at); } };
  };
  // recorded beds (sound #2): fetch + decode; played as overlapping 6-9 s grains from seeded offsets (no audible loop)
  api.loadBeds = async (urls = BEDS) => {
    const ctx = A?.ctx; if (!ctx) return {};
    const got = {};
    for (const [k, u] of Object.entries(urls || {})) {
      if (!u) continue;
      try { const r = await fetch(u); const ab = await r.arrayBuffer(); recorded[k] = await ctx.decodeAudioData(ab); got[k] = recorded[k].duration; } catch (e) { console.warn('[seoul-audio] bed', k, u, e); }
    }
    if (A) applyRecorded(A);
    return got;
  };
  function applyRecorded(g) {
    for (const k of Object.keys(recorded)) {
      const bedG = g['b' + k[0].toUpperCase() + k.slice(1)]; if (!bedG || g['rec_' + k]) continue;
      const rb = g.ctx.createGain(); rb.gain.value = 1; rb.connect(bedG); g['rec_' + k] = { bus: rb, buf: recorded[k], next: g.ctx.currentTime, seed: 1 };
      if (k === 'crowd' && g.crowdSrc) g.crowdSrc.forEach((s) => { try { s.disconnect(); } catch (e) {} });
    }
  }
  function grains(g, at) {
    for (const k of ['crowd', 'traffic', 'alley', 'rain']) {
      const r = g['rec_' + k]; if (!r) continue;
      while (r.next < at + 1.0) {
        const len = 6 + 3 * ((r.seed * 0.618) % 1), off = ((r.seed * 7.31) % 1) * Math.max(0.1, r.buf.duration - len), s = g.ctx.createBufferSource(), e = g.ctx.createGain();
        s.buffer = r.buf; e.gain.setValueAtTime(0, r.next); e.gain.linearRampToValueAtTime(1, r.next + 1.2); e.gain.setValueAtTime(1, r.next + len - 1.2); e.gain.linearRampToValueAtTime(0, r.next + len);
        s.connect(e); e.connect(r.bus); s.start(Math.max(r.next, 0), off, len); r.next += len - 1.2; r.seed++;
      }
    }
  }

  // ---- per-frame helpers
  const musicBuf = (g, site, cachedOnly = false) => {
    const key = site.style + ':' + (site.seed % 6); let b = g.music.buf.get(key);
    if (!b && !cachedOnly) { const m = synthLoop(site.style, site.seed % 6); b = toBuf(g.ctx, m.L, m.R, m.sr); g.music.buf.set(key, b); }
    return b || null;
  };
  const nearList = [], clipFeet = [];
  function refreshNear(cam) {   // people within 3-25 m (for laughs / shouts), from the crowd arrays
    nearList.length = 0; const C = life?.crowd; if (!C) return;
    const n = C.people.length, start = Math.floor((cam.x * 7.1 + cam.z * 3.3) % n + n) % n;
    for (let q = 0; q < n && nearList.length < 48; q++) { const i = (start + q) % n; if (!C.VIS[i]) continue; const dx = C.X[i] - cam.x, dz = C.Z[i] - cam.z, d2 = dx * dx + dz * dz; if (d2 < 625 && d2 > 9) nearList.push(i); }
  }
  function refreshFeet(cam) {   // clip path: what life.update's near.feet gives the live path
    clipFeet.length = 0; const C = life.crowd;
    for (let i = 0; i < C.people.length && clipFeet.length < 16; i++) if (C.VIS[i] && C.WALK[i] > 0.5 && (C.X[i] - cam.x) ** 2 + (C.Z[i] - cam.z) ** 2 < 25) clipFeet.push(i);
  }
  const PO = {};
  function feedGraph(g, cam, fwd, t, atIn) {
    if (g.offline && atIn == null) return;
    const ctx = g.ctx, at = atIn ?? ctx.currentTime;
    if (!g.offline && ctx.state !== 'running') return;
    const T = (p, v, tc = 0.06) => { if (g.offline) p.linearRampToValueAtTime(v, at + 0.033); else p.setTargetAtTime(v, at, tc); };
    if (g.camPrev && g.lastT != null && t > g.lastT) { const dt = t - g.lastT, k = Math.min(1, dt * 8); for (let i = 0; i < 3; i++) g.camV[i] += (([cam.x, cam.y, cam.z][i] - g.camPrev[i]) / dt - g.camV[i]) * k; }
    const dtF = g.lastT != null ? Math.max(0, Math.min(0.2, t - g.lastT)) : 0;
    g.camPrev = [cam.x, cam.y, cam.z]; g.lastT = t;
    let fx = fwd.x, fz = fwd.z; const fl = Math.hypot(fx, fz); if (fl < 1e-3) { fx = 0; fz = -1; } else { fx /= fl; fz /= fl; }
    const rx = -fz, rz = fx;
    const doOcc = Math.floor(t * 10) !== g.occT; if (doOcc) { g.occT = Math.floor(t * 10); S.occluded = 0; }
    const place = (v, x, y, z, gain, extraLp = 1, minD = 1) => {
      const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z, d = Math.max(minD, 0.5, Math.hypot(dx, dy, dz));
      if (doOcc || v.occN === 0) { v.occ = d > 3 && occl(cam.x, cam.y, cam.z, x, y, z) ? 1 : 0; v.occN = 1; if (v.occ) S.occluded++; }
      const pan = Math.max(-0.85, Math.min(0.85, (dx * rx + dz * rz) / d)), behind = (dx * fx + dz * fz) / d < -0.2 ? 0.55 : 1;
      T(v.g.gain, gain / Math.max(1, d) * (v.occ ? 0.178 : 1)); T(v.pn.pan, pan); T(v.oc.frequency, v.occ ? 600 : 16000, 0.12);
      T(v.lp.frequency, Math.min(16000, 22000 / (1 + d / 35)) * behind * extraLp);
      return d;
    };
    const doppler = (x, z, vx, vz) => {
      const dx = cam.x - x, dz = cam.z - z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d;
      const vs = vx * ux + vz * uz, vl = g.camV[0] * ux + g.camV[2] * uz;
      return Math.max(0.6, Math.min(1.6, (C_SOUND - vl) / (C_SOUND - vs)));
    };
    // one-shot: buffer at a world point, gain at 1 m, rate, delay; occluded like the voices
    const shot = (buf, x, y, z, gain, rate = 1, delay = 0) => {
      if (!buf) return null;
      if (g.shots.length > 6) { const o = g.shots.shift(); try { o.stop(at); } catch (e) {} }
      const dx = x - cam.x, dz = z - cam.z, d = Math.max(1, Math.hypot(dx, y - cam.y, dz)), pan = Math.max(-0.85, Math.min(0.85, (dx * rx + dz * rz) / d)), oc = d > 3 && occl(cam.x, cam.y, cam.z, x, y, z);
      const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
      const gg = ctx.createGain(); gg.gain.value = gain / d * (oc ? 0.178 : 1); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = oc ? 600 : Math.min(16000, 22000 / (1 + d / 35)); const pn = ctx.createStereoPanner(); pn.pan.value = pan;
      s.connect(lp); lp.connect(gg); gg.connect(pn); pn.connect(g.mix); s.start(at + delay); s.stop(at + delay + buf.duration / rate + 0.05);
      g.shots.push(s); s.onended = () => { const i = g.shots.indexOf(s); if (i >= 0) g.shots.splice(i, 1); };
      return s;
    };
    const sim = life?.sim, alt = Math.max(0, cam.y - 1.5);
    // ---- context (10 Hz): crowd, traffic, canyon, vehicle candidates
    if (g.scanT == null || Math.abs(t - g.scanT) > 0.1 || Math.hypot(cam.x - g.scanP[0], cam.z - g.scanP[1]) > 4) {
      g.scanT = t; g.scanP = [cam.x, cam.z];
      const crowdN = life?.near ? life.near.crowdN : 0; let trafN = 0; const cand = { engine: [], bus: [], scooter: [] };
      if (sim) for (const v of sim.traffic.vehicles) {
        if (v.hidden) continue; const p = sim.traffic.pose(v, 1, PO), d = Math.hypot(p.x - cam.x, p.z - cam.z, cam.y - 0.6);
        if (d < 150) trafN += (0.3 + v.v / 12) / (1 + (d / 15) * (d / 15));
        if (d > 120) continue; const pool = v.type === 'bus' ? 'bus' : v.type === 'scooter' ? 'scooter' : 'engine';
        cand[pool].push({ v, d, score: (SND[v.type] + 10 * Math.log10(0.2 + v.v / 10)) - 20 * Math.log10(d + 1) });
      }
      const ac = life?.acoustics ? life.acoustics(cam) : { canyon: 0, streetW: 30 };
      g.ctxv = { crowdN, trafN, canyon: ac.canyon, cand };
      S.crowdNear = crowdN; S.trafficNear = trafN; S.canyon = ac.canyon;
      const lift = 1 / (1 + alt / 25);
      T(g.bTraffic.gain, nrm('traffic') * dbA(SND.beds.traffic) * Math.min(1.4, 0.12 + Math.sqrt(trafN / 4)) * (0.5 + 0.5 * lift), 0.3);
      T(g.hissG.gain, g.rain ? 0.5 : 0.12, 0.5);
      T(g.bCrowd.gain, nrm('crowd') * dbA(SND.beds.crowd) * Math.min(1.6, Math.pow(crowdN / 30, 0.8)) * lift, 0.3);   // crowdN ~30-110 on hero streets now (P2 density)
      T(g.bAlley.gain, nrm('alley') * dbA(SND.beds.alley) * ac.canyon * lift, 0.4);
      T(g.bAir.gain, nrm('air') * dbA(SND.beds.air) * (1 + Math.min(1, alt / 60)), 0.5);
      T(g.bRain.gain, g.rain ? nrm('rain') * dbA(SND.beds.rain) : 0, 0.5);
      // canyon reverb sends: narrow alleys (RT60 0.5 s) vs the Yanghwa-ro canyon (1.2 s), less as the drone climbs
      const wide = Math.max(0, Math.min(1, ((ac.streetW ?? 30) - 14) / 12));
      T(g.sendA.gain, 0.32 * ac.canyon * lift, 0.4); T(g.sendR.gain, 0.22 * wide * lift + 0.05, 0.4);
    }
    if (g.offline || !g.lastRec || at > g.lastRec + 0.2) { grains(g, at); g.lastRec = at; }
    // ---- vehicles -> engine / bus / scooter pools, nearest-loudest with hysteresis
    if (sim && g.ctxv) {
      const cand = g.ctxv.cand;
      for (const pool of ['engine', 'bus', 'scooter']) {
        const V = g.pv[pool]; if (!V.length) continue;
        const C = cand[pool].sort((a, b) => b.score - a.score), byId = new Map(C.map((c) => [c.v.id, c]));
        const keep = new Set();
        for (const vo of V) { const c = vo.who != null ? byId.get(vo.who) : null; if (c && C.indexOf(c) < V.length + 1) keep.add(c.v.id); else vo.who = null; }
        for (const c of C) { if (keep.size >= V.length) break; if (keep.has(c.v.id)) continue; const vo = V.find((q) => q.who == null); if (!vo) break; vo.who = c.v.id; vo.occN = 0; keep.add(c.v.id); }
        S[pool] = 0;
        for (const vo of V) {
          const c = vo.who != null ? byId.get(vo.who) : null;
          if (!c || c.v.hidden) { T(vo.g.gain, 0, 0.15); continue; }
          S[pool]++;
          c.p = sim.traffic.pose(c.v, sim.aT ?? 1, c.p || {});
          const v = c.v, p = c.p, vx = p.hx * v.v, vz = p.hz * v.v, dop = doppler(p.x, p.z, vx, vz), load = Math.max(0, v.acc) / 2;
          place(vo, p.x, 0.6, p.z, nrm(pool) * dbA(SND[v.type]) * 2);
          const k = vo.ctl;
          if (pool === 'engine') {
            const rpmHz = (v.type === 'truck' ? 22 : 26) + v.v * 2.2 + load * 10;
            T(k.o.frequency, rpmHz * dop); T(k.og.gain, (v.type === 'taxi' ? 0.25 : 0.5) * (0.6 + load));
            // tyre roar 0.5-2 kHz, linear in speed (P1: (v/12)^2 put cars at -53 to -60 LUFS)
            T(k.tg.gain, Math.min(1.5, 0.08 + v.v / 12) * dbA(SND.tyre) / dbA(SND[v.type]) * (g.rain ? 2.2 : 1)); T(k.ty.playbackRate, dop); T(k.bp.frequency, 700 + v.v * 45);
          } else if (pool === 'bus') {
            T(k.o.frequency, (28 + v.v * 1.4 + load * 6) * dop); T(k.w.frequency, (300 + v.v * 85) * dop); T(k.wg.gain, 0.01 + 0.02 * Math.min(1, v.v / 8));
            T(k.tg.gain, Math.min(1.4, 0.1 + v.v / 11) * 0.5); T(k.ty.playbackRate, dop);
          } else {
            const rpm = 1700 + Math.min(1, v.v / 12) * 5200 + load * 900, f = rpm / 120;
            T(k.o.frequency, f * dop); T(k.cvt.frequency, (500 + v.v * 70) * dop); T(k.og.gain, 0.4 + 0.6 * load + 0.2 * Math.min(1, v.v / 8)); T(k.ex.playbackRate, dop);
          }
        }
      }
      // traffic events: bus air brakes + the bus-stop chime and announcement; horns
      for (const e of sim.traffic.events) {
        const v = sim.traffic.vehicles.find((q) => q.id === e.id); if (!v) continue;
        const p = sim.traffic.pose(v, 1, {}), d = Math.hypot(p.x - cam.x, p.z - cam.z); if (d > 90) continue;
        if (e.type === 'kneel' || e.type === 'doors') {
          const s = ctx.createBufferSource(); s.buffer = g.white; const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = e.type === 'kneel' ? 1800 : 2600;
          const gg = ctx.createGain(), pn = ctx.createStereoPanner(), dx = p.x - cam.x, dz = p.z - cam.z;
          pn.pan.value = Math.max(-0.85, Math.min(0.85, (dx * rx + dz * rz) / Math.max(1, d)));
          const A0 = dbA(SND.hiss) / Math.max(1, d) * (e.type === 'kneel' ? 1 : 0.5), dur = e.type === 'kneel' ? 1.4 : 0.6;
          gg.gain.setValueAtTime(0, at); gg.gain.linearRampToValueAtTime(A0, at + 0.03); gg.gain.setTargetAtTime(0, at + 0.12, dur / 4);
          s.connect(hp); hp.connect(gg); gg.connect(pn); pn.connect(g.mix); s.start(at, (e.id * 0.37) % 2); s.stop(at + dur + 0.6);
          S.hiss++;
          if (e.type === 'kneel' && d < 50) { shot(g.buf.bus, p.x, 2.2, p.z, dbA(SND.voice + 8) * 2, 1, 0.6); S.chimes++; }
        } else if (e.type === 'horn') { shot(g.buf.horn[e.id % 3], p.x, 0.9, p.z, dbA(SND.horn) * (e.k ? 1 : 0.8), 1); S.horns++; }
      }
    }
    // ---- static sites: shop music, club doors, busking PAs, neon, sizzle
    const assignSites = (V, list, radius, gainOf, setup) => {
      if (!V.length) return 0;
      const C = []; for (const s of list) { const d = Math.hypot(s.x - cam.x, s.y - cam.y, s.z - cam.z); if (d < radius) C.push({ s, d }); }
      C.sort((a, b) => a.d - b.d); const want = C.slice(0, V.length), ids = new Set(want.map((c) => c.s.id));
      for (const vo of V) if (vo.who && !ids.has(vo.who)) { vo.who = null; T(vo.g.gain, 0, 0.12); if (vo.ctl.src) { try { vo.ctl.src.stop(at + 0.5); } catch (e) {} vo.ctl.src = null; } }
      let n = 0;
      for (const c of want) {
        let vo = V.find((q) => q.who === c.s.id);
        if (!vo) { vo = V.find((q) => !q.who); if (!vo) continue; vo.who = c.s.id; vo.occN = 0; if (setup) setup(vo, c.s); }
        place(vo, c.s.x, c.s.y, c.s.z, gainOf(c.s, c.d), 1, c.s.minD || 1); n++;
      }
      return n;
    };
    const startLoop = (vo, s, dst = vo.ctl.glass.inp || vo.ctl.glass, buf = musicBuf(g, s, !g.offline)) => {
      if (!buf) { vo.pending = [s, dst]; if (g.idle && s.style !== 'acoustic') g.idle(() => musicBuf(g, s), s.style + ':' + (s.seed % 6)); return; }
      vo.pending = null;   // live: a loop not rendered yet is queued for an idle slice and starts when it is
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.connect(dst);
      src.start(at, ((t + s.phase) % buf.duration + buf.duration) % buf.duration); vo.ctl.src = src;
    };
    // doorway speakers (82-88 dB at 2 m, full band when open) vs music behind glass
    for (const V of [g.pv.music, g.pv.club, g.pv.busk]) for (const vo of V) if (vo.pending && vo.who) { const [s0, dst] = vo.pending; const b = s0.style === 'acoustic' ? g.music.acoustic : musicBuf(g, s0, true); if (b) startLoop(vo, s0, dst, b); }
    S.music = assignSites(g.pv.music, sites.music, 50, (s) => nrm('music') * dbA(SND.music) * 2 * (s.open ? 1 : 0.5), (vo, s) => { startLoop(vo, s); T(vo.ctl.glass.frequency, s.open ? 7000 : 2500, 0.01); });
    S.club = assignSites(g.pv.club, sites.club, 70, (s) => nrm('music') * dbA(SND.club) * 2, (vo, s) => startLoop(vo, s));
    // club doors open on their own rhythm: the kick's beater click (1-3 kHz) leaks shut, full band open
    for (const vo of g.pv.club) if (vo.who) { const s = sites.club.find((q) => q.id === vo.who); const ph = ((t + s.phase) % 23) / 23; T(vo.ctl.glass.frequency, ph < 0.18 ? 6000 : 400, 0.08); }
    // busking: the PA plays while the song runs, then applause and a cheer from the ring at the end of each song
    const busk = life?.near?.busk || life?.crowd?.busk || [];
    const bsites = busk.map((b) => ({ x: b.x, y: 1.4, z: b.z, id: 'busk' + b.id, phase: b.off, style: b.kind === 'dance' ? 'kpop' : 'acoustic', seed: 40 + b.id, minD: 3, b }));
    S.busk = assignSites(g.pv.busk, bsites, 130, (s) => { const sp = ((t + s.b.off) / s.b.song) % 1; return dbA(SND.busk) * 2 * (sp < 0.94 ? 1 : 0); },
      (vo, s) => startLoop(vo, s, vo.ctl.inp, s.style === 'acoustic' ? g.music.acoustic : musicBuf(g, s, !g.offline)));
    busk.forEach((b, i) => {
      const sp = ((t + b.off) / b.song) % 1, end = sp > 0.94, d = Math.hypot(b.x - cam.x, b.z - cam.z);
      if (end && g.buskState[i] === false && d < 120) { const n = b.aud.length / 40; shot(g.buf.clap, b.x, 1.4, b.z, dbA(SND.applause) * 2 * n); shot(g.buf.cheer, b.x, 1.6, b.z, dbA(SND.applause - 4) * 2 * n, 1, 0.3); S.applause++; }
      g.buskState[i] = end;
    });
    assignSites(g.pv.neon, sites.neon, 9, (s) => dbA(SND.neon) * 2 * (s.hz ? (0.6 + 0.4 * Math.sin(t * 6.283 * s.hz)) : 1));
    assignSites(g.pv.sizzle, sites.sizzle, 18, () => dbA(SND.sizzle) * 2);
    // ---- the crowd up close: laughs and shouts paced by crowdN, footsteps within 5 m, shop door chimes
    if (life?.crowd && g.ctxv && dtF > 0) {
      refreshNear(cam);
      const rate = Math.min(1.2, 0.03 * g.ctxv.crowdN), slot = Math.floor(t * 10), prevSlot = Math.floor((t - dtF) * 10);
      for (let sl = prevSlot + 1; sl <= slot; sl++) {
        const h = ((Math.imul(sl, 2654435761) ^ 0x5bd1e995) >>> 0) / 4294967296;
        if (h < rate * 0.1 && nearList.length) {
          const C = life.crowd, i = nearList[Math.floor(((h * 7919) % 1) * nearList.length)], laugh = (h * 104729) % 1 < 0.6;
          const arr = laugh ? g.buf.laugh : g.buf.shout, k = Math.floor(((h * 31337) % 1) * arr.length);
          shot(arr[k], C.X[i], 1.55, C.Z[i], dbA(laugh ? SND.laugh : SND.laugh + 4) * 2, 0.94 + ((h * 997) % 1) * 0.12); S.laughs++;
        }
      }
      // footsteps: heel strikes (gait phase crossing 0 / 0.5) of walkers within 5 m, when the drone is low
      const feet = g.isClip ? clipFeet : (life.near?.feet || []), C = life.crowd, low = cam.y < 4.5, seen = new Set();
      for (const i of feet) {
        seen.add(i); const ph = C.PH[i], prev = g.feetPh.get(i); g.feetPh.set(i, ph);
        if (prev == null || !low) continue;
        if ((prev < 0.5 && ph >= 0.5) || ph < prev - 0.3) { const p = C.people[i], heel = !p.male && p.id % 3 === 0, arr = heel ? g.buf.heel : g.buf.step; shot(arr[p.id % arr.length], C.X[i], 0.05, C.Z[i], dbA(heel ? SND.heel : SND.heel - 8) * 2, 0.95 + (p.id % 7) * 0.015); S.steps++; }
      }
      for (const k of g.feetPh.keys()) if (!seen.has(k)) g.feetPh.delete(k);
      for (const e of life.near?.doors || []) if (e.use === 'conv' || (e.use === 'cafe' && e.type === 'in')) { shot(g.buf.conv, e.x, 2.3, e.z, dbA(SND.chime) * 2 * (e.use === 'conv' ? 1 : 0.5)); S.chimes++; }
    }
    // ---- the crossing's voice guide when the walk phase starts, then a soft tick (twice as fast in the last 8 s)
    if (life?.crossPhase && crossings.length) {
      let best = null, bd = 30; for (const c of crossings) { const d = Math.hypot(c.x - cam.x, c.z - cam.z); if (d < bd) { bd = d; best = c; } }
      if (best) {
        const ph = life.crossPhase(best, t);
        if (ph.walk && g.guideC === best && !g.guideWalk) { shot(g.buf.guide, best.x, 2.6, best.z, dbA(SND.guide) * 2); g.nextTick = t + 2.4; S.guides++; }
        if (ph.walk && g.guideC === best && t >= g.nextTick) { const left = ph.wlen - (ph.tc - ph.w0); shot(g.buf.tick, best.x, 2.6, best.z, dbA(SND.guide - 12) * 2); g.nextTick = t + (left < 8 ? 0.5 : 1.0); }
        g.guideC = best; g.guideWalk = ph.walk;
      }
    }
  }
  api.feed = (cam, fwd, t, atIn) => { if (A) feedGraph(A, cam, fwd, t, atIn); };
  return api;
}
export default { createSeoulAudio, synthLoop, makeBabble, makeOccluder, SND, BEDS };
