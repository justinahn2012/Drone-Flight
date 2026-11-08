// seoul-audio.js: the Hongdae night soundscape (stream S4). A map, not a loop: zone beds that follow where the
// camera is (traffic wash on the big roads, crowd babble that swells with the people around you, AC-unit hum in
// the alleys) plus positional emitters fed by the life sims (engines with Doppler, delivery scooters, bus air
// brakes when they kneel, storefront music behind glass, club bass leaking from doors, neon buzz, pocha sizzle,
// the crossing's walk pips). Everything is synthesised here; the music loops are original procedural pieces
// (no real songs, no samples). Recorded beds can replace the synthetic ones later: see BEDS.
//
//   const sa = createSeoulAudio(layout, life, { signs })   // life = seoul-life.js build() result (or null)
//   sa.attach(ctx, dest)            // dest = MotorAudio.bus, so the city goes through the same camera-mic chain
//   sa.feed(camPos, camFwd, t, at)  // every frame (life.update calls it); `at` = OfflineAudioContext time for clips
//   sa.setLevel(x) sa.setRain(on) sa.setSigns(emitters) sa.detach() sa.stats
//
// Voice budget: 6 bed sources + 14 positional voices (low: 9). iOS crackles past ~32 voices with the motor synth.
import { Rng } from './rng.js';

const C_SOUND = 343;
// level of each source in dB SPL (beds: at the street centre; emitters: at 1 m). 0 dBFS at the bus = 105 dB SPL, so the
// motor synth at hover (-16 dBFS measured, tests/seoul-audio.mjs) reads ~89 dB and a busy street bed ~70 dB sits ~19 dB
// under it: audible in a hover, buried at full throttle, brought up by the camera's auto-gain in dives (as on real FPV).
const dbA = (db) => Math.pow(10, (db - 105) / 20);
// measured RMS of each synthetic bed / loop at unit gain (tests: cal), so SND levels mean what they say
const NORM = { traffic: 15.1, crowd: 19.9, alley: 13.0, air: 10.7, rain: 7.2, music: 17, engine: 14, bus: 12, scooter: 8 };
const nrm = (k) => Math.pow(10, NORM[k] / 20);
export const SND = {
  level: 1,
  world: 1.33,    // trim on the world path, set so the city sits ~9 LU under a hover on the walking street (sound #1)
  beds: { traffic: 72, crowd: 70, alley: 56, air: 48, rain: 66 },          // at the street centre, full density
  car: 72, taxi: 70, truck: 76, bus: 80, scooter: 80, tyre: 70,          // pass-by at 1 m-equivalent
  music: 78, club: 86, neon: 44, sizzle: 62, pip: 66, hiss: 92, voice: 74,
  pools: { engine: 4, bus: 1, scooter: 2, music: 3, club: 2, neon: 1, sizzle: 1 },
  poolsLow: { engine: 2, bus: 1, scooter: 1, music: 2, club: 1, neon: 0, sizzle: 1 },
};
const MUSIC_USES = { cafe: ['cafe', 'citypop'], shop: ['kpop', 'kpop', 'citypop'], conv: ['kpop'], karaoke: ['kpop', 'citypop'], bar: ['citypop', 'kpop'], pc: ['kpop'], restaurant: ['cafe'], pocha: ['kpop'] };

function noise(ctx, secs, kind = 'white', seed = 1) {
  const sr = ctx.sampleRate, n = Math.floor(sr * secs), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0), R = new Rng(seed);
  let b0 = 0, b1 = 0, b2 = 0, br = 0;
  for (let i = 0; i < n; i++) {
    const w = R.next() * 2 - 1;
    if (kind === 'white') d[i] = w;
    else if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
    else { br = (br + 0.02 * w) / 1.02; d[i] = br * 3.5; }
  }
  // crossfade the loop seam
  const m = Math.floor(sr * 0.05); for (let i = 0; i < m; i++) { const u = i / m; d[i] = d[i] * u + d[n - m + i] * (1 - u); }
  return b;
}
// slow random control signal (normalised to ~[-1, 1])
function lfoBuf(ctx, secs, hz, seed) {
  const sr = 3000, n = Math.floor(sr * secs), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0), R = new Rng(seed);
  const k = Math.exp(-2 * Math.PI * hz / sr); let a = 0, c = 0, mx = 1e-6;
  for (let i = 0; i < n + 6000; i++) { a = a * k + (R.next() * 2 - 1) * (1 - k); c = c * k + a * (1 - k); if (i >= 6000) { d[i - 6000] = c; mx = Math.max(mx, Math.abs(c)); } }
  for (let i = 0; i < n; i++) d[i] /= mx;
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
  const add = (t0, len, pan, fn) => {   // fn(t) -> sample; t seconds into the note
    const i0 = Math.floor(t0 * sr), i1 = Math.min(n + Math.floor(len * sr), i0 + Math.floor(len * sr)), gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    for (let i = i0; i < i1; i++) { const v = fn((i - i0) / sr), j = i % n; L[j] += v * gl; Rr[j] += v * gr; }
  };
  const nz = new Rng(seed + 99);
  for (let bar = 0; bar < bars; bar++) {
    const [deg, q] = S.prog[bar % S.prog.length], chord = CH[q].map((x) => root + 12 + deg + x), bass = root - 12 + deg + (deg > 6 ? -12 : 0) + 12;
    const tb = bar * 4 * beat;
    // drums
    for (let b = 0; b < 4; b++) {
      const t = tb + b * beat;
      const kick = S.kick === 'four' || (S.kick === 'back' && (b === 0 || b === 2));
      if (kick) add(t, 0.32, 0, (x) => Math.sin(2 * Math.PI * (45 * x + 70 * (1 - Math.exp(-x * 30)) / 30)) * Math.exp(-x * 9) * 0.9);
      if (S.kick !== 'none' && (b === 1 || b === 3)) add(t, 0.18, 0.05, (x) => ((nz.next() * 2 - 1) * 0.55 + Math.sin(2 * Math.PI * 190 * x) * 0.3) * Math.exp(-x * 22) * 0.6);
      if (S.kick !== 'none') for (let h = 0; h < 2; h++) add(t + h * beat / 2 + (S.kick === 'back' ? beat / 4 : 0) * h, 0.04, 0.3, () => (nz.next() * 2 - 1) * 0.12);
      if (S.kick === 'back' && b === 3) add(t + beat / 2, 0.25, 0, (x) => Math.sin(2 * Math.PI * (48 * x)) * Math.exp(-x * 10) * 0.6);
    }
    // bass
    const bf = mtof(bass), bassNotes = S.bass === 'eighth' ? [0, .5, 1, 1.5, 2, 2.5, 3, 3.5] : S.bass === 'sync' ? [0, .75, 1.5, 2, 2.75, 3.5] : S.bass === 'offbeat' ? [.5, 1.5, 2.5, 3.5] : [0, 2];
    for (const bt of bassNotes) {
      const oct = S.bass === 'sync' && bt === 0.75 ? 2 : 1, len = S.bass === 'half' ? 1.8 * beat : 0.42 * beat;
      let lp = 0; add(tb + bt * beat, len, 0, (x) => { const ph = (bf * oct * x) % 1, s = 2 * ph - 1; lp += (s - lp) * 0.08; return lp * Math.min(1, x * 200) * Math.exp(-x * (S.bass === 'half' ? 1.5 : 5)) * 0.55; });
    }
    // keys / pad
    if (S.keys === 'ep') {
      const hits = style === 'cafe' ? [0, 2] : [0, 1.5, 2.5];
      for (const ht of hits) chord.forEach((m, k) => { const f = mtof(m); add(tb + ht * beat + k * 0.008, 1.6 * beat, (k - 1.5) * 0.25, (x) => (Math.sin(2 * Math.PI * f * x) + 0.25 * Math.sin(4 * Math.PI * f * x) * Math.exp(-x * 6)) * Math.exp(-x * 2.2) * 0.13); });
    } else if (S.keys === 'saw') {
      chord.forEach((m, k) => { const f = mtof(m); let lp = 0; add(tb, 4 * beat, (k - 1) * 0.4, (x) => { const s = ((f * x) % 1 + (f * 1.006 * x) % 1) - 1; lp += (s - lp) * 0.05; return lp * Math.min(1, x * 8) * 0.09; }); });
    } else if (S.keys === 'stab') {
      for (const st of [0.5, 2.5]) chord.forEach((m, k) => { const f = mtof(m); add(tb + st * beat, 0.25, 0, (x) => (((f * x) % 1) * 2 - 1) * Math.exp(-x * 14) * 0.12); });
    }
    // arpeggio (the synthwave / city-pop sparkle)
    if (S.arp) for (let k = 0; k < 16; k++) {
      const m = chord[(k * (R.next() < 0.8 ? 1 : 2)) % chord.length] + 12, f = mtof(m);
      add(tb + k * beat / 4, beat / 4, ((k % 4) - 1.5) * 0.3, (x) => (((f * x) % 1) < 0.5 ? 1 : -1) * Math.exp(-x * 18) * 0.05);
    }
  }
  let pk = 1e-6; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(Rr[i]));
  for (let i = 0; i < n; i++) { L[i] *= 0.9 / pk; Rr[i] *= 0.9 / pk; }
  return { L, R: Rr, sr, dur, bpm };
}

// ---------------------------------------------------------------- the soundscape
export function createSeoulAudio(layout, life, opts = {}) {
  const lots = (layout.lots || []).filter((l) => l.frontage);
  // static emitter sites from the layout
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
      const st = MUSIC_USES[l.use], style = hero.has(l.street) && h * 3 % 1 < 0.34 ? 'citypop' : st[Math.floor(h * 7) % st.length];   // ~1 in 3 on hero streets lean city-pop/synthwave
      sites.music.push({ ...front(l, 1.0, 1.4), id: l.id, phase: h * 53, style, seed: i, open: h * 11 % 1 < 0.3 });
    }
    if (l.use === 'pocha') sites.sizzle.push({ ...front(l, 1.6, 0.9), id: l.id });
    if (['bar', 'club', 'karaoke', 'motel', 'pc'].includes(l.use) && h * 5 % 1 < 0.5) sites.neon.push({ ...front(l, 0.3, 3.2), id: l.id, hz: 0 });
  });
  let pipSites = [];
  if (life?.sim) for (const c of life.sim.net.crossings) for (const sd of [1, -1]) {
    const o = c.main.path.at(c.sc, {}); pipSites.push({ x: o.x + o.nx * sd * (c.halfSpan + 0.3), y: 1.2, z: o.z + o.nz * sd * (c.halfSpan + 0.3), c });
  }
  const S = { music: 0, club: 0, engine: 0, scooter: 0, bus: 0, hiss: 0, voices: 0, crowdNear: 0, trafficNear: 0, canyon: 0 };
  const api = { stats: S, sites, attached: false };
  let A = null;   // the live graph

  api.setSigns = (emitters) => {   // S2's emitters: flickering neon becomes buzz sites (replaces the layout guess)
    const fl = (emitters || []).filter((e) => e.flicker || e.kind === 'neon');
    if (fl.length) sites.neon = fl.map((e) => ({ x: e.pos[0], y: e.pos[1], z: e.pos[2], id: e.id, hz: e.flicker?.hz || 0, depth: e.flicker?.depth || 0 }));
  };
  if (opts.signs) api.setSigns(opts.signs);

  api.attach = (ctx, dest, { offline = false, low = false, raw = false } = {}) => {
    if (A) api.detach();
    const G = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const F = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const loop = (buf, rate = 1, off = 0) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(0, off % buf.duration); return s; };
    const white = noise(ctx, 3, 'white', 11), pink = noise(ctx, 4, 'pink', 12), brown = noise(ctx, 5, 'brown', 13);
    // routing (sound #1): into MotorAudio's world path (after the camera chain, ducked <= 6 dB by the props) when the
    // destination offers it; { raw: true } keeps P1's route through the camera mic chain ("raw cam audio")
    const target = raw ? dest : (dest && dest.world) || dest, viaWorld = target !== dest;
    const out = G(SND.level * (viaWorld ? SND.world : 1)); out.connect(target);
    const g = { ctx, out, offline, viaWorld, white, pink, brown, nodes: [], pv: {}, music: new Map(), lastT: null, camV: [0, 0, 0], camPrev: null, rain: !!opts.rain };
    A = g;
    // ---- beds
    const bed = (name) => { const gg = G(0); gg.connect(out); return gg; };
    // traffic wash: brown rumble + pink road roar, slightly wide
    g.bTraffic = bed();
    { const r = loop(brown, 1, 0.3), lp = F('lowpass', 220), p = loop(pink, 0.9, 1.1), bp = F('bandpass', 520, 0.45), pl = ctx.createStereoPanner(), pr = ctx.createStereoPanner(); pl.pan.value = -0.5; pr.pan.value = 0.5;
      r.connect(lp); lp.connect(pl); p.connect(bp); bp.connect(pr); pl.connect(g.bTraffic); pr.connect(g.bTraffic); }
    // crowd babble: speech-shaped noise streams, formants wandering at syllable rates, syllabic AM; plus voiced murmur
    g.bCrowd = bed();
    for (let k = 0; k < (low ? 2 : 3); k++) {
      const src = loop(pink, 1 + k * 0.07, k * 0.9), f1 = F('bandpass', 550, 2.2), f2 = F('bandpass', 1500, 2.5), am = G(0.5), pn = ctx.createStereoPanner(); pn.pan.value = [-0.6, 0.6, 0][k];
      const l1 = loop(lfoBuf(ctx, 7, 5 + k * 0.6, 20 + k), 1), l2 = loop(lfoBuf(ctx, 9, 4 + k * 0.5, 30 + k), 1), la = loop(lfoBuf(ctx, 6, 4.5 + k * 0.4, 40 + k), 1);
      const d1 = G(220), d2 = G(500), da = G(0.5); l1.connect(d1); d1.connect(f1.frequency); l2.connect(d2); d2.connect(f2.frequency); la.connect(da); da.connect(am.gain);
      src.connect(f1); src.connect(f2); f1.connect(am); f2.connect(am); am.connect(pn); pn.connect(g.bCrowd);
    }
    { // voiced murmur: two glottal-ish oscillators through vowel formants, pitch wandering (no words)
      for (let k = 0; k < 2; k++) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = k ? 210 : 125;
        const pl = loop(lfoBuf(ctx, 8, 3, 50 + k), 1), pd = G(k ? 40 : 22); pl.connect(pd); pd.connect(o.frequency);
        const f1 = F('bandpass', 600, 4), f2 = F('bandpass', 1700, 5), am = G(0.25), al = loop(lfoBuf(ctx, 5, 5, 60 + k), 1), ad = G(0.25); al.connect(ad); ad.connect(am.gain);
        const fl = loop(lfoBuf(ctx, 6, 4, 70 + k), 1), fd = G(250); fl.connect(fd); fd.connect(f1.frequency);
        o.connect(f1); o.connect(f2); f1.connect(am); f2.connect(am); const lp = F('lowpass', 2500); am.connect(lp); lp.connect(g.bCrowd); o.start();
      }
    }
    // alley: outdoor AC condensers (mains 60 Hz -> 120 Hz hum family) + fan wash with blade-rate flutter
    g.bAlley = bed();
    { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 120; const bp = F('bandpass', 240, 3), og = G(0.25); o.connect(bp); bp.connect(og); og.connect(g.bAlley); o.start();
      const fn = loop(pink, 0.8, 2), lp = F('lowpass', 900), fam = G(0.7), fo = ctx.createOscillator(); fo.frequency.value = 23; const fd = G(0.3); fo.connect(fd); fd.connect(fam.gain); fo.start();
      fn.connect(lp); lp.connect(fam); fam.connect(g.bAlley); }
    // air: the city's far-off floor (always there, rises a little with altitude: more of the city in view)
    g.bAir = bed(); { const s = loop(pink, 0.6, 0.7), lp = F('lowpass', 700); s.connect(lp); lp.connect(g.bAir); }
    // rain (optional mode): hiss + drops
    g.bRain = bed(); { const s = loop(white, 1, 0.2), hp = F('highpass', 1800), lp = F('lowpass', 9000); s.connect(hp); hp.connect(lp); lp.connect(g.bRain); }

    // ---- positional voices: source chain -> gain -> lowpass (air + behind) -> panner -> out
    const pvoice = (build) => {
      const gi = G(0), lp = F('lowpass', 12000, 0.5), pn = ctx.createStereoPanner(); gi.connect(lp); lp.connect(pn); pn.connect(out);
      const v = { g: gi, lp, pn, who: null, score: 0 }; v.ctl = build(v, gi); return v;
    };
    const P = low ? SND.poolsLow : SND.pools;
    // engines (cars, taxis, trucks): low firing tone + tyre roar
    g.pv.engine = Array.from({ length: P.engine }, () => pvoice((v, dst) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 30; const lp = F('lowpass', 260), og = G(0.5); o.connect(lp); lp.connect(og); og.connect(dst); o.start();
      const ty = loop(pink, 1, Math.random() * 3), bp = F('bandpass', 850, 0.6), tg = G(0); ty.connect(bp); bp.connect(tg); tg.connect(dst);
      return { o, og, tg, ty, bp };
    }));
    g.pv.bus = Array.from({ length: P.bus }, () => pvoice((v, dst) => {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 34; const lp = F('lowpass', 200), og = G(0.4); o.connect(lp); lp.connect(og); og.connect(dst); o.start();
      const w = ctx.createOscillator(); w.type = 'sine'; w.frequency.value = 700; const wg = G(0.02); w.connect(wg); wg.connect(dst); w.start();   // e-bus inverter whine
      const ty = loop(pink, 0.8, 1.7), bp = F('bandpass', 600, 0.6), tg = G(0); ty.connect(bp); bp.connect(tg); tg.connect(dst);
      return { o, og, w, wg, tg, ty };
    }));
    // scooters: 125 cc four-stroke single: pulse at firing rate, exhaust bark, CVT whine
    g.pv.scooter = Array.from({ length: P.scooter }, () => pvoice((v, dst) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 40;
      const sh = ctx.createWaveShaper(), cv = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = i / 127.5 - 1; cv[i] = x > 0.6 ? 1 : x < -0.2 ? -0.3 : x; } sh.curve = cv;
      const bp = F('bandpass', 380, 0.9), og = G(0.6); o.connect(sh); sh.connect(bp); bp.connect(og); og.connect(dst); o.start();
      const ex = loop(white, 1, 0.5), eb = F('bandpass', 1200, 1.2), eam = G(0), od = G(0.6); ex.connect(eb); eb.connect(eam); o.connect(od); od.connect(eam.gain); eam.connect(dst);
      const cvt = ctx.createOscillator(); cvt.frequency.value = 900; const cg = G(0.03); cvt.connect(cg); cg.connect(dst); cvt.start();
      return { o, og, cvt, ex };
    }));
    // music: a loop per assignment (BufferSource made on (re)assignment, phase-locked to the take clock)
    g.pv.music = Array.from({ length: P.music }, () => pvoice((v, dst) => ({ src: null, glass: (() => { const f = F('lowpass', 1600, 0.4); f.connect(dst); return f; })() })));
    g.pv.club = Array.from({ length: P.club }, () => pvoice((v, dst) => ({ src: null, glass: (() => { const f = F('lowpass', 160, 0.6); f.connect(dst); return f; })() })));
    g.pv.neon = Array.from({ length: P.neon }, () => pvoice((v, dst) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 120; const bp = F('bandpass', 360, 1.5), og = G(0.6); o.connect(bp); bp.connect(og); og.connect(dst); o.start();
      const cr = loop(white, 1.3, 0.1), hp = F('highpass', 3000), cg = G(0.05), cl = loop(lfoBuf(ctx, 4, 12, 81), 1), cd = G(0.05); cl.connect(cd); cd.connect(cg.gain); cr.connect(hp); hp.connect(cg); cg.connect(dst);
      return { o, og };
    }));
    g.pv.sizzle = Array.from({ length: P.sizzle }, () => pvoice((v, dst) => {
      const s = loop(white, 0.9, 0.4), hp = F('highpass', 2500), gg = G(0.4), cr = loop(lfoBuf(ctx, 5, 40, 91), 1), cd = G(0.4); cr.connect(cd); cd.connect(gg.gain);
      s.connect(hp); hp.connect(gg); gg.connect(dst); return {};
    }));
    // pips at the crossing during the walk phase (one voice, nearest kerb)
    g.pip = pvoice((v, dst) => { const o = ctx.createOscillator(); o.frequency.value = 2400; const am = G(0), lo = ctx.createOscillator(); lo.type = 'square'; lo.frequency.value = 1.6; const ld = G(0.5); lo.connect(ld); ld.connect(am.gain); o.connect(am); am.connect(dst); o.start(); lo.start(); return {}; });
    api.__g = g;
    api.__beds = { bTraffic: g.bTraffic, bCrowd: g.bCrowd, bAlley: g.bAlley, bAir: g.bAir, bRain: g.bRain };
    S.voices = Object.values(g.pv).reduce((n, a) => n + a.length, 0) + 1 + 6;
    api.attached = true;
    return api;
  };
  api.detach = () => { if (!A) return; try { A.out.disconnect(); } catch (e) {} A = null; api.attached = false; };
  api.setLevel = (x) => { SND.level = x; if (A) A.out.gain.value = x * (A.viaWorld ? SND.world : 1); };
  api.setRain = (on) => { if (A) A.rain = !!on; };

  // music buffers: generated lazily, cached per (style, seed)
  const bufCache = new Map();
  const musicBuf = (ctx, site) => {
    const key = site.style + ':' + (site.seed % 6); let b = bufCache.get(key);
    if (!b) { const m = synthLoop(site.style, site.seed % 6); b = ctx.createBuffer(2, m.L.length, m.sr); b.getChannelData(0).set(m.L); b.getChannelData(1).set(m.R); bufCache.set(key, b); }
    return b;
  };

  // ---- per frame
  const T = (p, v, at, tc = 0.06) => { if (A.offline) p.linearRampToValueAtTime(v, at); else p.setTargetAtTime(v, at, tc); };
  const PO = {};
  api.feed = (cam, fwd, t, atIn) => {
    if (!A) return;
    if (A.offline && atIn == null) return;   // offline (clip) graphs are driven only with explicit times
    const ctx = A.ctx, at = atIn ?? ctx.currentTime;
    if (!A.offline && ctx.state !== 'running') return;
    // camera velocity (for Doppler) from successive positions
    if (A.camPrev && A.lastT != null && t > A.lastT) { const dt = t - A.lastT, k = Math.min(1, dt * 8); for (let i = 0; i < 3; i++) A.camV[i] += (([cam.x, cam.y, cam.z][i] - A.camPrev[i]) / dt - A.camV[i]) * k; }
    A.camPrev = [cam.x, cam.y, cam.z]; A.lastT = t;
    let fx = fwd.x, fz = fwd.z; const fl = Math.hypot(fx, fz); if (fl < 1e-3) { fx = 0; fz = -1; } else { fx /= fl; fz /= fl; }
    const rx = -fz, rz = fx;   // right
    const place = (v, x, y, z, gain, extraLp = 1) => {
      const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z, d = Math.max(0.5, Math.hypot(dx, dy, dz));
      const pan = Math.max(-0.85, Math.min(0.85, (dx * rx + dz * rz) / d)), behind = (dx * fx + dz * fz) / d < -0.2 ? 0.55 : 1;
      T(v.g.gain, gain / Math.max(1, d), at); T(v.pn.pan, pan, at); T(v.lp.frequency, Math.min(16000, 22000 / (1 + d / 35)) * behind * extraLp, at);
      return d;
    };
    const doppler = (x, z, vx, vz) => {   // received/emitted frequency ratio
      const dx = cam.x - x, dz = cam.z - z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d;
      const vs = vx * ux + vz * uz, vl = A.camV[0] * ux + A.camV[2] * uz;
      return Math.max(0.6, Math.min(1.6, (C_SOUND + vl * -1) / (C_SOUND - vs)));
    };
    // ---- context (10 Hz scan): crowd and traffic around the camera, canyon, vehicle candidates
    const sim = life?.sim, alt = Math.max(0, cam.y - 1.5);
    if (A.scanT == null || Math.abs(t - A.scanT) > 0.1 || Math.hypot(cam.x - A.scanP[0], cam.z - A.scanP[1]) > 4) {
      A.scanT = t; A.scanP = [cam.x, cam.z];
      let crowdN = 0, trafN = 0; const cand = { engine: [], bus: [], scooter: [] };
      if (sim) {
        crowdN = life.near ? life.near.crowdN : 0;
        for (const v of sim.traffic.vehicles) {
          if (v.hidden) continue; const p = sim.traffic.pose(v, 1, PO), d = Math.hypot(p.x - cam.x, p.z - cam.z, cam.y - 0.6);
          if (d < 150) trafN += (0.3 + v.v / 12) / (1 + (d / 15) * (d / 15));
          if (d > 120) continue; const pool = v.type === 'bus' ? 'bus' : v.type === 'scooter' ? 'scooter' : 'engine';
          cand[pool].push({ v, d, score: (SND[v.type] + 10 * Math.log10(0.2 + v.v / 10)) - 20 * Math.log10(d + 1) });
        }
      }
      const ac = life?.acoustics ? life.acoustics(cam) : { canyon: 0 };
      A.ctxv = { crowdN, trafN, canyon: ac.canyon, cand };
      S.crowdNear = crowdN; S.trafficNear = trafN; S.canyon = ac.canyon;
      const lift = 1 / (1 + alt / 25);   // street-level beds fall off with height
      T(A.bTraffic.gain, nrm('traffic') * dbA(SND.beds.traffic) * Math.min(1.4, 0.12 + Math.sqrt(trafN / 4)) * (0.5 + 0.5 * lift), at, 0.3);
      T(A.bCrowd.gain, nrm('crowd') * dbA(SND.beds.crowd) * Math.min(1.6, Math.pow(crowdN / 20, 0.8)) * lift, at, 0.3);
      T(A.bAlley.gain, nrm('alley') * dbA(SND.beds.alley) * ac.canyon * lift, at, 0.4);
      T(A.bAir.gain, nrm('air') * dbA(SND.beds.air) * (1 + Math.min(1, alt / 60)), at, 0.5);
      T(A.bRain.gain, A.rain ? nrm('rain') * dbA(SND.beds.rain) : 0, at, 0.5);
    }

    // ---- vehicles -> engine / bus / scooter pools, nearest-loudest with hysteresis (poses fresh every frame)
    if (sim && A.ctxv) {
      const cand = A.ctxv.cand;
      for (const pool of ['engine', 'bus', 'scooter']) {
        const V = A.pv[pool]; if (!V.length) continue;
        const C = cand[pool].sort((a, b) => b.score - a.score), byId = new Map(C.map((c) => [c.v.id, c]));
        const keep = new Set();
        for (const vo of V) { const c = vo.who != null ? byId.get(vo.who) : null; if (c && C.indexOf(c) < V.length + 1) keep.add(c.v.id); else vo.who = null; }
        for (const c of C) { if (keep.size >= V.length) break; if (keep.has(c.v.id)) continue; const vo = V.find((q) => q.who == null); if (!vo) break; vo.who = c.v.id; keep.add(c.v.id); }
        S[pool] = 0;
        for (const vo of V) {
          const c = vo.who != null ? byId.get(vo.who) : null;
          if (!c || c.v.hidden) { T(vo.g.gain, 0, at, 0.15); continue; }
          S[pool]++;
          c.p = sim.traffic.pose(c.v, sim.aT ?? 1, c.p || {});
          const v = c.v, p = c.p, vx = p.hx * v.v, vz = p.hz * v.v, dop = doppler(p.x, p.z, vx, vz), load = Math.max(0, v.acc) / 2;
          place(vo, p.x, 0.6, p.z, nrm(pool) * dbA(SND[v.type]) * 2);
          const k = vo.ctl;
          if (pool === 'engine') {
            const rpmHz = (v.type === 'truck' ? 22 : 26) + v.v * 2.2 + load * 10;   // firing frequency
            T(k.o.frequency, rpmHz * dop, at); T(k.og.gain, (v.type === 'taxi' ? 0.25 : 0.5) * (0.6 + load), at);
            T(k.tg.gain, Math.min(1.5, (v.v / 12) ** 2) * dbA(SND.tyre) / dbA(SND[v.type]) * (A.rain ? 2.5 : 1), at); T(k.ty.playbackRate, dop, at);
          } else if (pool === 'bus') {
            T(k.o.frequency, (28 + v.v * 1.4 + load * 6) * dop, at); T(k.w.frequency, (300 + v.v * 85) * dop, at); T(k.wg.gain, 0.01 + 0.02 * Math.min(1, v.v / 8), at);
            T(k.tg.gain, Math.min(1.4, (v.v / 11) ** 2) * 0.5, at); T(k.ty.playbackRate, dop, at);
          } else {
            const rpm = 1700 + Math.min(1, v.v / 12) * 5200 + load * 900, f = rpm / 120;   // 4-stroke single: one firing per 2 revs
            T(k.o.frequency, f * dop, at); T(k.cvt.frequency, (500 + v.v * 70) * dop, at); T(k.og.gain, 0.4 + 0.6 * load + 0.2 * Math.min(1, v.v / 8), at); T(k.ex.playbackRate, dop, at);
          }
        }
      }
      // bus air brakes / kneel: one-shot hiss at the bus
      for (const e of sim.traffic.events) {
        const v = sim.traffic.vehicles.find((q) => q.id === e.id); if (!v) continue;
        const p = sim.traffic.pose(v, 1, {}), d = Math.hypot(p.x - cam.x, p.z - cam.z); if (d > 80) continue;
        const s = ctx.createBufferSource(); s.buffer = A.white; const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = e.type === 'kneel' ? 1800 : 2600;
        const gg = ctx.createGain(), pn = ctx.createStereoPanner(), dx = p.x - cam.x, dz = p.z - cam.z;
        pn.pan.value = Math.max(-0.85, Math.min(0.85, (dx * rx + dz * rz) / Math.max(1, d)));
        const A0 = dbA(SND.hiss) / Math.max(1, d) * (e.type === 'kneel' ? 1 : 0.5), dur = e.type === 'kneel' ? 1.4 : 0.6;
        gg.gain.setValueAtTime(0, at); gg.gain.linearRampToValueAtTime(A0, at + 0.03); gg.gain.setTargetAtTime(0, at + 0.12, dur / 4);
        s.connect(hp); hp.connect(gg); gg.connect(pn); pn.connect(A.out); s.start(at, Math.random() * 2); s.stop(at + dur + 0.6);
        S.hiss++;
      }
    }

    // ---- static sites: music, club doors, neon, sizzle
    const assignSites = (V, list, radius, gainOf, setup) => {
      if (!V.length) return 0;
      const C = []; for (const s of list) { const d = Math.hypot(s.x - cam.x, s.y - cam.y, s.z - cam.z); if (d < radius) C.push({ s, d }); }
      C.sort((a, b) => a.d - b.d); const want = C.slice(0, V.length), ids = new Set(want.map((c) => c.s.id));
      for (const vo of V) if (vo.who && !ids.has(vo.who)) { vo.who = null; T(vo.g.gain, 0, at, 0.12); if (vo.ctl.src) { try { vo.ctl.src.stop(at + 0.5); } catch (e) {} vo.ctl.src = null; } }
      let n = 0;
      for (const c of want) {
        let vo = V.find((q) => q.who === c.s.id);
        if (!vo) { vo = V.find((q) => !q.who); if (!vo) continue; vo.who = c.s.id; if (setup) setup(vo, c.s); }
        place(vo, c.s.x, c.s.y, c.s.z, gainOf(c.s, c.d)); n++;
      }
      return n;
    };
    const startLoop = (vo, s) => {
      const b = musicBuf(ctx, s), src = ctx.createBufferSource(); src.buffer = b; src.loop = true; src.connect(vo.ctl.glass);
      src.start(at, ((t + s.phase) % b.duration + b.duration) % b.duration); vo.ctl.src = src;
    };
    S.music = assignSites(A.pv.music, sites.music, 45, (s) => nrm('music') * dbA(SND.music) * 2, (vo, s) => { startLoop(vo, s); T(vo.ctl.glass.frequency, s.open ? 5000 : 1500, at, 0.01); });
    S.club = assignSites(A.pv.club, sites.club, 70, (s) => nrm('music') * dbA(SND.club) * 2, startLoop);
    // club doors open on their own deterministic rhythm: a few seconds open every ~20 s
    for (const vo of A.pv.club) if (vo.who) { const s = sites.club.find((q) => q.id === vo.who); const ph = ((t + s.phase) % 23) / 23; T(vo.ctl.glass.frequency, ph < 0.18 ? 2400 : 170, at, 0.08); }
    assignSites(A.pv.neon, sites.neon, 9, (s) => dbA(SND.neon) * 2 * (s.hz ? (0.6 + 0.4 * Math.sin(t * 6.283 * s.hz)) : 1));
    assignSites(A.pv.sizzle, sites.sizzle, 18, () => dbA(SND.sizzle) * 2);
    // crossing pips while the nearest crossing walks
    let best = null, bd = 25; for (const p of pipSites) { const d = Math.hypot(p.x - cam.x, p.z - cam.z, p.y - cam.y); if (d < bd) { bd = d; best = p; } }
    if (best) { const walk = life?.crossPhase ? life.crossPhase(best.c, t).walk : false; place(A.pip, best.x, best.y, best.z, walk ? dbA(SND.pip) * 2 : 0); }
    else T(A.pip.g.gain, 0, at, 0.1);
  };
  return api;
}
export default { createSeoulAudio, synthLoop, SND };
