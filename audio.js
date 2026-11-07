// audio.js — onboard-camera FPV audio: rotor-harmonic motors, turbulence FM, prop-wash flutter,
// mic wind, wall-reflection comb, room reverb / tube flutter, impacts, scrapes, crash, "GoPro" chain.
// From the sound panel's drop-in (review/panel/sound), integrated by stream F. API is backward compatible with the old MotorAudio:
//   start(), update(motors, speed, wash, crashed, mute, x?), thud(v), streamDest, on
// New: hit(v), kick(), idle(), setCraft(key). x = { dist, interior, hall, tube, tubeD, scrape, near }
const CRAFT = {
  freestyle5: { maxHz: 550, blades: 3, idle: 0.18, hover: 0.392 },   // 33k RPM loaded max, tri-blade 5"
  cinewhoop: { maxHz: 760, blades: 5, idle: 0.2, hover: 0.5 },        // 45k RPM, 5-blade ducted 3"
};
const DET = [1.0, 1.0045, 0.9962, 1.0071];       // static motor-to-motor spread (beats 1-7 Hz at hover)
const PAN = [-0.22, 0.22, -0.22, 0.22];          // motors 0,2 = left side (roll mixer sign), 1,3 = right
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);

function rotorWave(ctx, B) {
  // harmonics of SHAFT rate: 1x imbalance, B*k blade-pass family, 7/14/21 = motor electrical (7 pole pairs)
  const N = 7 * B + 1, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
  const amp = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) amp[n] = 0.025 / n;               // broadband fill (vortex noise proxy)
  amp[1] = 0.28; amp[2] = 0.09;
  [1.0, 0.55, 0.33, 0.21, 0.13, 0.08, 0.05].forEach((a, k) => { if ((k + 1) * B <= N) amp[(k + 1) * B] += a; });
  amp[7] += 0.16; amp[14] += 0.08; if (21 <= N) amp[21] += 0.05;
  let s = 12345; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let n = 1; n <= N; n++) { const ph = rnd() * 6.283; re[n] = amp[n] * Math.cos(ph); im[n] = amp[n] * Math.sin(ph); }
  return ctx.createPeriodicWave(re, im);                         // random phases: lower crest factor
}
function noiseBuf(ctx, secs, smoothHz = 0) {
  const sr = ctx.sampleRate, n = Math.floor(sr * secs), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
  if (!smoothHz) { for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; return b; }
  // band-limited random signal for modulators: 2-pole smoothing, normalised to RMS 1
  const k = Math.exp(-2 * Math.PI * smoothHz / sr), m = Math.floor(sr * 0.2), tmp = new Float32Array(n + m); let a = 0, c = 0, e = 0;
  for (let i = 0; i < n + m; i++) { a = a * k + (Math.random() * 2 - 1) * (1 - k); c = c * k + a * (1 - k); tmp[i] = c; }
  for (let i = 0; i < n; i++) { const w = i < m ? i / m : 1; d[i] = tmp[i] * w + (i < m ? tmp[n + i] * (1 - w) : 0); e += d[i] * d[i]; }   // seamless loop
  const g = 1 / Math.sqrt(e / n); for (let i = 0; i < n; i++) d[i] *= g; return b;
}
function hallIR(ctx, secs = 2.0, rt60 = 1.8, pre = 0.012) {
  const sr = ctx.sampleRate, n = Math.floor(sr * secs), b = ctx.createBuffer(2, n, sr);
  const taps = [[0.009, 0.5], [0.017, -0.4], [0.023, 0.35], [0.031, -0.3], [0.044, 0.22]];
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch); let lp = 0;
    for (let i = Math.floor(pre * sr); i < n; i++) {
      const t = i / sr - pre, k = Math.min(0.93, 0.15 + 0.8 * t / rt60);   // tail darkens over time
      lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
      d[i] = lp * Math.sqrt((1 + k) / (1 - k)) * Math.pow(10, -3 * t / rt60) * 0.5;
    }
    for (const [t, g] of taps) d[Math.floor((t + ch * 0.0013) * sr)] += g * (ch ? -1 : 1);
  }
  return b;
}

export class MotorAudio {
  constructor() { this.ctx = null; this.on = true; this.craft = CRAFT.freestyle5; this.drift = [0, 0, 0, 0]; this.spin = 1; }
  setCraft(key) { this.craft = CRAFT[key] || CRAFT.freestyle5; if (this.motors) { const w = rotorWave(this.ctx, this.craft.blades); this.motors.forEach((m) => m.o.setPeriodicWave(w)); } }

  // call from inside a user gesture (Fly / Resume / any touchend)
  start() {
    if (this.ctx) { this.kick(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}   // play with silent mode on
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });                               // native rate (48k)
    const sil = ctx.createBufferSource(); sil.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); sil.connect(ctx.destination); sil.start(0);
    ctx.resume?.();
    const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const F = (type, f, q, gain = 0) =>   // NB lowpass/highpass Q is in dB (-3 = Butterworth); bandpass/peaking Q is linear
      { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = gain; return b; };
    const src = (buf, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(0, Math.random() * buf.duration); return s; };

    // ---- "GoPro" camera chain: wind-cut HPF, housing presence peak, mic overload, AGC, limiter
    this.master = G(0);
    const hpf = F('highpass', 110, -3), pres = F('peaking', 2800, 0.9, 4), box = F('lowshelf', 280, 0.7, -3), lpf = F('lowpass', 12500, -3);
    const shp = ctx.createWaveShaper(); const cv = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 511.5 - 1) * 1.6; cv[i] = Math.tanh(x) / Math.tanh(1.6); } shp.curve = cv; shp.oversample = '2x';
    const agc = ctx.createDynamicsCompressor(); agc.threshold.value = -24; agc.knee.value = 6; agc.ratio.value = 4; agc.attack.value = 0.008; agc.release.value = 0.35;
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
    const out = G(0.7);                                     // WebKit compressors add their own make-up gain
    this.bus = G(1);
    this.bus.connect(hpf); hpf.connect(box); box.connect(pres); pres.connect(lpf); lpf.connect(shp); shp.connect(agc); agc.connect(lim); lim.connect(out); out.connect(this.master);
    this.master.connect(ctx.destination);
    this.streamDest = ctx.createMediaStreamDestination(); this.master.connect(this.streamDest);

    const white = noiseBuf(ctx, 4), lfo = noiseBuf(ctx, 8, 14);
    // ---- motors: one PeriodicWave oscillator each (shaft rate), audio-rate turbulence FM
    this.motorBus = G(1); this.tone = F('lowpass', 5000, -1); this.am = G(1);
    this.motorBus.connect(this.tone); this.tone.connect(this.am);
    const wave = rotorWave(ctx, this.craft.blades);
    const fmA = src(lfo, 1), fmB = src(lfo, 1.37);           // two decorrelated modulators (diagonal pairs)
    this.motors = DET.map((det, i) => {
      const o = ctx.createOscillator(); o.setPeriodicWave(wave); o.frequency.value = 200;
      const g = G(0), p = ctx.createStereoPanner(); p.pan.value = PAN[i];
      const fm = G(0); (i === 0 || i === 3 ? fmA : fmB).connect(fm); fm.connect(o.frequency);
      o.connect(g); g.connect(p); p.connect(this.motorBus); o.start();
      return { o, g, fm, det };
    });
    // prop-wash flutter: same modulator drives amplitude
    this.amDepth = G(0); fmA.connect(this.amDepth); this.amDepth.connect(this.am.gain);
    // ---- wall/ground reflection: feed-forward comb y = x + g*x(t - 2d/c)
    this.refl = ctx.createDelay(0.05); this.reflG = G(0);
    this.am.connect(this.bus); this.am.connect(this.refl); this.refl.connect(this.reflG); this.reflG.connect(this.bus);

    // ---- wind: mic buffet (low, gusty) + air rush (band, speed-tracked)
    const wn = src(white), gust = src(lfo, 0.07);
    this.buffet = F('lowpass', 240, -3); this.buffetG = G(0); this.gustAM = G(1); this.gustD = G(0);
    gust.connect(this.gustD); this.gustD.connect(this.gustAM.gain);
    wn.connect(this.buffet); this.buffet.connect(this.gustAM); this.gustAM.connect(this.buffetG); this.buffetG.connect(this.bus);
    this.rush = F('bandpass', 800, 0.7); this.rushG = G(0); wn.connect(this.rush); this.rush.connect(this.rushG); this.rushG.connect(this.bus);
    // ---- scrape: grainy band noise
    const sn = src(white, 0.83), grain = src(lfo, 6);
    this.scr = F('bandpass', 2400, 0.9); this.scrG = G(0); this.scrAM = G(1); const gd = G(0.6); grain.connect(gd); gd.connect(this.scrAM.gain);
    sn.connect(this.scr); this.scr.connect(this.scrAM); this.scrAM.connect(this.scrG); this.scrG.connect(this.bus);

    // ---- rooms: hall convolver + tube flutter (feedback comb sized from probe distance)
    this.hallS = G(0); this.tubeS = G(0); const conv = ctx.createConvolver(); conv.buffer = hallIR(ctx);
    this.am.connect(this.hallS);                  // props reverberate; mic wind does not
    this.hallS.connect(conv); conv.connect(this.bus);   // (drop-in had this line swallowed by the comment above: hall reverb was never wired)
    this.tubeD = ctx.createDelay(0.06); this.tubeD.delayTime.value = 0.0175; const tfb = G(0.62), tlp = F('lowpass', 3500, -3);
    this.am.connect(this.tubeS); this.tubeS.connect(this.tubeD); this.tubeD.connect(tlp); tlp.connect(tfb); tfb.connect(this.tubeD); tlp.connect(this.bus);

    this.white = white;
    ctx.onstatechange = () => { this.state = ctx.state; };
  }
  // resume after iOS 'interrupted'/'suspended' (call call/Siri/lock); must run inside a gesture
  kick() { const c = this.ctx; if (c && this.on && c.state !== 'running') { const p = c.resume?.(); p?.catch?.(() => {}); } }
  idle() { const c = this.ctx; if (c && c.state === 'running') c.suspend?.(); }   // menu / sound off: zero CPU

  update(motors, speed, wash, crashed, mute, x = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime, C = this.craft, dt = Math.min(0.1, t - (this.lastT ?? t)); this.lastT = t;
    this.master.gain.setTargetAtTime(mute || !this.on ? 0 : 1, t, 0.06);
    this.spin = crashed ? this.spin * Math.exp(-dt / 0.35) : 1;           // spool-down glide after a crash
    const near = clamp(1 - (x.dist ?? Infinity) / 1.5);
    const jit = 0.004 + 0.012 * clamp(speed / 25) + 0.05 * wash + 0.02 * near;   // fractional RPM jitter (PID + turbulence)
    let bpf = 0;
    this.motors.forEach((m, i) => {
      this.drift[i] += (-this.drift[i] * 0.02) + (Math.random() - 0.5) * 0.0006;  // slow OU trim drift ±0.3 %
      const rpm = Math.max(C.idle, crashed ? 0 : motors[i]) * this.spin;
      const hz = C.maxHz * rpm * m.det * (1 + this.drift[i]);
      m.o.frequency.setTargetAtTime(hz, t, 0.012);                         // physics already has spool lag
      m.fm.gain.setTargetAtTime(hz * jit, t, 0.05);
      const lvl = 0.07 * Math.pow(rpm / C.hover, 1.6) * (crashed ? this.spin * this.spin : 1);   // ~+13 dB hover->full
      m.g.gain.setTargetAtTime(lvl, t, 0.015);
      bpf += hz * C.blades / 4;
    });
    this.tone.frequency.setTargetAtTime(Math.min(16000, 1200 + 6 * bpf), t, 0.02);
    this.amDepth.gain.setTargetAtTime(0.35 * wash, t, 0.05);
    const d = clamp((x.dist ?? 9) + 0.12, 0.05, 2.1);                     // mic-to-surface; lastDist is Infinity past 2 m
    this.refl.delayTime.setTargetAtTime(2 * d / 343, t, 0.04);            // moving image source = the only doppler onboard
    this.reflG.gain.setTargetAtTime(0.65 * clamp(1 - d / 2.0), t, 0.04);
    const v = clamp((speed - 2) / 25);
    this.buffetG.gain.setTargetAtTime(0.9 * v * v, t, 0.1); this.gustD.gain.setTargetAtTime(0.5 * v, t, 0.2);
    this.rushG.gain.setTargetAtTime(0.22 * v * v + 0.35 * near * clamp(speed / 15), t, 0.08);
    this.rush.frequency.setTargetAtTime(600 + 45 * speed, t, 0.1);
    const s = clamp((x.scrape || 0) / 8);
    this.scrG.gain.setTargetAtTime(0.3 * s, t, s ? 0.01 : 0.06); this.scr.frequency.setTargetAtTime(1600 + 1800 * s, t, 0.05);
    this.hallS.gain.setTargetAtTime(0.5 * (x.hall || 0), t, 0.25);
    this.tubeS.gain.setTargetAtTime(0.35 * (x.tube || 0), t, 0.2);
    if (x.tubeD) this.tubeD.delayTime.setTargetAtTime(clamp(2 * x.tubeD / 343, 0.008, 0.05), t, 0.3);
  }

  // non-crash touch: frame "tock" (carbon modes) + prop-tip chatter at blade-pass rate
  hit(v) {
    if (!this.ctx || !this.on || this.ctx.state !== 'running') return;
    const ctx = this.ctx, t = ctx.currentTime, a = clamp(v / 6, 0.05, 1);
    for (const [f, dec, g] of [[740, 0.09, 0.5], [1630, 0.06, 0.4], [2950, 0.04, 0.3]]) {
      const o = ctx.createOscillator(), e = ctx.createGain(); o.frequency.value = f * (0.97 + Math.random() * 0.06);
      e.gain.setValueAtTime(g * a, t); e.gain.exponentialRampToValueAtTime(0.0005, t + dec);
      o.connect(e); e.connect(this.bus); o.start(t); o.stop(t + dec + 0.02);
    }
    const n = ctx.createBufferSource(); n.buffer = this.white; const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3000; bp.Q.value = 1.1;
    const e = ctx.createGain(), chop = ctx.createOscillator(), cg = ctx.createGain(); const dur = 0.04 + 0.08 * a;
    chop.type = 'square'; chop.frequency.value = this.craft.maxHz * this.craft.hover * this.craft.blades; const cd = ctx.createGain(); cd.gain.value = 0.5; chop.connect(cd); cd.connect(cg.gain); cg.gain.value = 0.6;
    e.gain.setValueAtTime(0.9 * a, t); e.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(bp); bp.connect(cg); cg.connect(e); e.connect(this.bus); n.start(t, Math.random() * 3); n.stop(t + dur + 0.02); chop.start(t); chop.stop(t + dur + 0.02);
  }
  // crash: hard hit + body crunch with speaker-audible harmonics + tumbling debris ticks; motors spool down in update()
  thud(v) {
    if (!this.ctx || !this.on || this.ctx.state !== 'running') return;
    const ctx = this.ctx, t = ctx.currentTime, a = clamp(v / 10, 0.4, 1);
    if (t - (this.thudAt ?? -9) < 0.15) return;            // one crash = one thud (main.js may trigger it from two places)
    this.thudAt = t;
    this.hit(8);
    for (const [f0, f1, g] of [[150, 55, 0.8], [300, 110, 0.35]]) {      // 2nd partial so phone speakers carry it
      const o = ctx.createOscillator(), e = ctx.createGain(); o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + 0.16);
      e.gain.setValueAtTime(g * a, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.28); o.connect(e); e.connect(this.bus); o.start(t); o.stop(t + 0.3);
    }
    const n = ctx.createBufferSource(); n.buffer = this.white; const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 0.5;
    const e = ctx.createGain(); e.gain.setValueAtTime(0.7 * a, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    n.connect(bp); bp.connect(e); e.connect(this.bus); n.start(t, Math.random() * 3); n.stop(t + 0.25);
    for (let k = 1; k <= 4; k++) setTimeout(() => this.hit(4 / k), 90 * k + Math.random() * 80);   // tumble
  }
}
