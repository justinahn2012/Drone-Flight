// audio.js — onboard-camera FPV audio: rotor-harmonic motors, broadband prop rasp, turbulence FM, prop-wash flutter,
// mic wind (two capsules), wall-reflection comb, room reverb / tube flutter, impacts, scrapes, crash, "GoPro" chain.
// Sound panel drop-ins (review/panel/sound, panel2/sound/audio_fix.js, panel3r/sound/audio_fix3b.js), streams F, F2, F24.
//   start(), update(motors, speed, wash, crashed, mute, x?, at?), thud(v, at?), hit(v, at?), kick(force?), idle(),
//   setCraft(key), setMode('on' | 'mix' | 'off'), snap(), streamDest, on.   x = { dist, hall, tube, tubeD, scrape, grass }
//   startOffline(ctx): the same graph on an OfflineAudioContext (HQ clip export); then pass `at` (s) to update/hit/thud.
//   world (G, sound #1): openWorld() -> a GainNode for the level's city sound that joins AFTER the camera chain (no mic
//   AGC, no auto-gain ride), ducked by at most 6 dB (80 ms down / 400 ms up) when the props and wind get loud, then a
//   master limiter on the sum. Nothing is rewired until a level opens it, so bando's chain is bit-identical. bus.world
//   exposes it to code that only holds the bus (main.js passes audio.bus to the level's attach).
// No recorded layer: no genuinely CC0 onboard 5" recording could be found (see the F2 report), so the realism comes
// from synthesis plus the camera's own behaviour (auto-gain ride, two-capsule wind, AGC/limiter, noise floor).
const CRAFT = {
  freestyle5: { maxHz: 550, blades: 3, idle: 0.18, hover: 0.392 },   // 33k RPM loaded max, tri-blade 5"
  cinewhoop: { maxHz: 760, blades: 5, idle: 0.2, hover: 0.5 },        // 45k RPM, 5-blade ducted 3"
};
const DET = [1.0, 1.0045, 0.9962, 1.0071];       // static motor-to-motor spread (beats 1-7 Hz at hover)
const PAN = [-0.22, 0.22, -0.22, 0.22];          // motors 0,2 = left side (roll mixer sign), 1,3 = right
// Sound setting (C6) -> iOS audio session and speaker level. 'playback' plays with the silent switch on but pauses
// other apps' audio; 'ambient' mixes with music (and obeys the silent switch). Off still renders clip audio
// (speaker muted), so it uses 'ambient' too: saving a clip with Sound Off must not stop the player's music.
const MODES = { on: { session: 'playback', spk: 1 }, mix: { session: 'ambient', spk: 0.7 }, off: { session: 'ambient', spk: 0 } };
// Camera auto-gain ride: target bus RMS and the most it may add (+6 dB). See update().
const RIDE_REF = 0.040, RIDE_MAX = 2.0;
// rideEst at a still hover (freestyle5, motors 0.392): where the world duck starts (measured: tests/seoul-audio.mjs)
const RIDE_HOVER = 0.056;
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const gauss = (rnd = Math.random) => (rnd() + rnd() + rnd() - 1.5) * 2;   // ~N(0,1), cheap
// P3 (sound #5, determinism): offline renders (HQ clips) draw their noise from a seeded generator instead of
// Math.random, so a clip's sound is a pure function of its log (main.js passes a seed from the log); live play is unchanged
export const seededRandom = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

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
  // mean square after Web Audio's peak normalisation (for the auto-gain's level model)
  const M = 2048; let pk = 0, ms = 0;
  for (let k = 0; k < M; k++) {
    let x = 0; for (let n = 1; n <= N; n++) { const w = 2 * Math.PI * n * k / M; x += re[n] * Math.cos(w) + im[n] * Math.sin(w); }
    pk = Math.max(pk, Math.abs(x)); ms += x * x;
  }
  return { wave: ctx.createPeriodicWave(re, im), ms: ms / M / (pk * pk || 1) };   // random phases: lower crest factor
}
// pulse train (duty d) for the grass-strike gate: one blade tip per period
function pulseWave(ctx, d = 0.22, N = 16) {
  const re = new Float32Array(N + 1), im = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) re[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * d) * (1 - n / (N + 2));
  return ctx.createPeriodicWave(re, im);
}
function noiseBuf(ctx, secs, smoothHz = 0, rnd = Math.random) {
  const sr = ctx.sampleRate, n = Math.floor(sr * secs), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
  if (!smoothHz) { for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1; return b; }
  // band-limited random signal for modulators: 2-pole smoothing, normalised to RMS 1
  const k = Math.exp(-2 * Math.PI * smoothHz / sr), m = Math.floor(sr * 0.2), tmp = new Float32Array(n + m); let a = 0, c = 0, e = 0;
  for (let i = 0; i < n + m; i++) { a = a * k + (rnd() * 2 - 1) * (1 - k); c = c * k + a * (1 - k); tmp[i] = c; }
  for (let i = 0; i < n; i++) { const w = i < m ? i / m : 1; d[i] = tmp[i] * w + (i < m ? tmp[n + i] * (1 - w) : 0); e += d[i] * d[i]; }   // seamless loop
  const g = 1 / Math.sqrt(e / n); for (let i = 0; i < n; i++) d[i] *= g; return b;
}
function hallIR(ctx, secs = 2.0, rt60 = 1.8, pre = 0.012, rnd = Math.random) {
  const sr = ctx.sampleRate, n = Math.floor(sr * secs), b = ctx.createBuffer(2, n, sr);
  const taps = [[0.009, 0.5], [0.017, -0.4], [0.023, 0.35], [0.031, -0.3], [0.044, 0.22]];
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch); let lp = 0;
    for (let i = Math.floor(pre * sr); i < n; i++) {
      const t = i / sr - pre, k = Math.min(0.93, 0.15 + 0.8 * t / rt60);   // tail darkens over time
      lp = lp * k + (rnd() * 2 - 1) * (1 - k);
      d[i] = lp * Math.sqrt((1 + k) / (1 - k)) * Math.pow(10, -3 * t / rt60) * 0.5;
    }
    for (const [t, g] of taps) d[Math.floor((t + ch * 0.0013) * sr)] += g * (ch ? -1 : 1);
  }
  return b;
}

export class MotorAudio {
  constructor() {
    this.ctx = null; this.on = true; this.mode = 'on'; this.craft = CRAFT.freestyle5;
    this.drift = [0, 0, 0, 0]; this.lvlD = [0, 0, 0, 0]; this.spin = 1; this.ride = 1; this.rideEst = 0; this._snap = false;
    this.rnd = Math.random;
  }
  setCraft(key) {
    const c = CRAFT[key] || CRAFT.freestyle5; if (c === this.craft && this.motors) return;   // no re-apply: a phase click
    this.craft = c; if (this.motors) { const w = rotorWave(this.ctx, c.blades); this.waveMs = w.ms; this.motors.forEach((m) => m.o.setPeriodicWave(w.wave)); }
  }
  // 'on' | 'mix' | 'off' (S.sound, contract C6). Safe to call before start() and any number of times.
  setMode(mode) {
    this.mode = MODES[mode] ? mode : 'on'; this.on = this.mode !== 'off';
    this._session();
  }
  _session() {
    try { const a = navigator.audioSession, s = MODES[this.mode].session; if (a && a.type !== s) a.type = s; } catch (e) {}
  }
  // the next update() jumps straight to its targets (a hard cut in an edited clip: no glide across it)
  snap() { this._snap = true; }

  // call from inside a user gesture (Fly / Resume / any touchend)
  start() {
    if (this.ctx) { this.kick(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    this._session();                                                                            // before the context exists
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });                               // native rate (48k)
    const sil = ctx.createBufferSource(); sil.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); sil.connect(ctx.destination); sil.start(0);
    ctx.resume?.();
    this._build(ctx, true);
  }
  // HQ clip export: the same chain on an OfflineAudioContext, straight into its destination (no speaker, no stream).
  // Drive it with explicit times: update(..., at), hit(v, at), thud(v, at), then ctx.startRendering().
  // seed (P3): the clip's noise seed (main.js: from the input log); offline renders are deterministic either way
  startOffline(ctx, seed = 0x9e3779b9) { this.ctx = ctx; this.offline = true; this.on = true; this.rnd = seededRandom(seed); this._build(ctx, false); return this; }
  _build(ctx, live) {
    const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const F = (type, f, q, gain = 0) =>   // NB lowpass/highpass Q is in dB (-3 = Butterworth); bandpass/peaking Q is linear
      { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = gain; return b; };
    const R = this.rnd, src = (buf, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(0, R() * buf.duration); return s; };
    const P = (pan) => { const p = ctx.createStereoPanner(); p.pan.value = pan; return p; };

    // ---- "GoPro" camera chain: wind-cut HPF, housing presence peak, auto-gain ride, mic overload, AGC, limiter.
    // AGC attack 20 ms and the limiter at -1.5 dB let impacts through as transients (round-2 sound #7).
    this.master = G(0);
    const hpf = F('highpass', 110, -3), pres = F('peaking', 2800, 0.9, 4), box = F('lowshelf', 280, 0.7, 0), lpf = F('lowpass', 12500, -3);
    const shp = ctx.createWaveShaper(); const cv = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 511.5 - 1) * 1.6; cv[i] = Math.tanh(x) / Math.tanh(1.6); } shp.curve = cv; shp.oversample = '2x';
    const agc = ctx.createDynamicsCompressor(); agc.threshold.value = -24; agc.knee.value = 6; agc.ratio.value = 4; agc.attack.value = 0.02; agc.release.value = 0.35;
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
    const out = G(0.6);                                     // WebKit compressors add their own make-up gain
    this.bus = G(1); this.rideG = G(1);
    this.bus.connect(hpf); hpf.connect(box); box.connect(pres); pres.connect(lpf); lpf.connect(this.rideG); this.rideG.connect(shp);
    shp.connect(agc); agc.connect(lim); lim.connect(out); out.connect(this.master);
    this._out = out; this._wOpen = false; this.world = null; this.worldDuck = null; this.duck = 1;
    const self = this; Object.defineProperty(this.bus, 'world', { configurable: true, get: () => self.openWorld() });
    if (live) {
      this.spk = G(0); this.master.connect(this.spk); this.spk.connect(ctx.destination);   // speaker mute is separate from the clip feed
      this.streamDest = ctx.createMediaStreamDestination(); this.master.connect(this.streamDest);
    } else this.master.connect(ctx.destination);

    const white = noiseBuf(ctx, 4, 0, R), lfo = noiseBuf(ctx, 8, 14, R), lfoF = noiseBuf(ctx, 8, 30, R);
    // ---- motors: one PeriodicWave oscillator each (shaft rate), audio-rate turbulence FM
    this.motorBus = G(1); this.tone = F('lowpass', 5000, -1); this.am = G(1);
    this.motorBus.connect(this.tone); this.tone.connect(this.am);
    const wave = rotorWave(ctx, this.craft.blades); this.waveMs = wave.ms;
    const fmA = src(lfoF, 1), fmB = src(lfoF, 1.37);           // two decorrelated modulators (diagonal pairs)
    this.motors = DET.map((det, i) => {
      const o = ctx.createOscillator(); o.setPeriodicWave(wave.wave); o.frequency.value = 200;
      const g = G(0), p = P(PAN[i]);
      const fm = G(0); (i === 0 || i === 3 ? fmA : fmB).connect(fm); fm.connect(o.frequency);
      o.connect(g); g.connect(p); p.connect(this.motorBus); o.start();
      return { o, g, fm, det };
    });
    // broadband prop noise: band noise chopped at blade-pass (vortex/turbulence rasp the tonal model lacks)
    const pn = src(white, 1.13); this.raspF = F('bandpass', 2500, 0.55); this.raspAM = G(0.45); this.raspG = G(0);
    this.raspO = ctx.createOscillator(); this.raspO.frequency.value = 650; const rdp = G(0.55); this.raspO.connect(rdp); rdp.connect(this.raspAM.gain); this.raspO.start();
    pn.connect(this.raspF); this.raspF.connect(this.raspAM); this.raspAM.connect(this.raspG); this.raspG.connect(this.motorBus);
    // prop-wash flutter: same modulator drives amplitude
    this.amDepth = G(0); fmA.connect(this.amDepth); this.amDepth.connect(this.am.gain);
    // ---- wall/ground reflection: feed-forward comb y = x + g*x(t - 2d/c)
    this.refl = ctx.createDelay(0.05); this.reflG = G(0);
    this.am.connect(this.bus); this.am.connect(this.refl); this.refl.connect(this.reflG); this.reflG.connect(this.bus);

    // ---- wind: mic buffet (low, gusty) + air rush (band, speed-tracked). The camera has two capsules a few cm
    // apart and the turbulence at each is its own, so wind is decorrelated L/R while the props stay centred:
    // the stereo cue of a real onboard track. The gust (the airflow itself) is shared.
    const wnL = src(white), wnR = src(white, 0.93), gust = src(lfo, 0.07);
    this.buffetG = G(0); this.gustAM = G(1); this.gustD = G(0);
    gust.connect(this.gustD); this.gustD.connect(this.gustAM.gain);
    this.rush = [F('bandpass', 800, 0.7), F('bandpass', 800, 0.7)]; this.rushG = G(0);
    [wnL, wnR].forEach((wn, ch) => {
      const lp = F('lowpass', 400, -3), pb = P(ch ? 0.85 : -0.85), pr = P(ch ? 0.6 : -0.6);
      wn.connect(lp); lp.connect(pb); pb.connect(this.gustAM);
      wn.connect(this.rush[ch]); this.rush[ch].connect(pr); pr.connect(this.rushG);
    });
    this.gustAM.connect(this.buffetG); this.buffetG.connect(this.bus); this.rushG.connect(this.bus);
    // ---- camera noise floor + outdoor air: what the GoPro AGC brings up when the motors are low (dives, after a crash)
    const amb = src(white, 0.71), ambF = F('lowpass', 1800, -3); this.ambG = G(0.005); amb.connect(ambF); ambF.connect(this.ambG); this.ambG.connect(this.bus);
    // ---- scrape: grainy band noise
    const sn = src(white, 0.83), grain = src(lfo, 6);
    this.scr = F('bandpass', 2400, 0.9); this.scrG = G(0); this.scrAM = G(1); const gd = G(0.6); grain.connect(gd); gd.connect(this.scrAM.gain);
    sn.connect(this.scr); this.scr.connect(this.scrAM); this.scrAM.connect(this.scrG); this.scrG.connect(this.bus);

    // ---- rooms: hall convolver + tube flutter (feedback comb sized from probe distance)
    this.hallS = G(0); this.tubeS = G(0); const conv = ctx.createConvolver(); conv.buffer = hallIR(ctx, 2.0, 1.8, 0.012, R);
    this.am.connect(this.hallS);                  // props reverberate; mic wind does not
    this.hallS.connect(conv); conv.connect(this.bus);
    this.tubeD = ctx.createDelay(0.06); this.tubeD.delayTime.value = 0.0175; const tfb = G(0.62), tlp = F('lowpass', 3500, -3);
    this.am.connect(this.tubeS); this.tubeS.connect(this.tubeD); this.tubeD.connect(tlp); tlp.connect(tfb); tfb.connect(this.tubeD); tlp.connect(this.bus);

    // ---- grass strikes (C7): blade tips chopping grass. Band noise gated by a narrow pulse at blade-pass rate (one
    // strike per blade), a low thrash under it, both scaled by how deep the props are in it; update() sags the RPM.
    const gn = src(white, 1.29), gfl = src(lfo, 2.3);
    this.grassF = F('bandpass', 1900, 0.7); this.grassAM = G(0.3); this.grassFl = G(1); this.grassG = G(0); this.grassLo = G(0);
    this.chopO = ctx.createOscillator(); this.chopO.setPeriodicWave(pulseWave(ctx)); this.chopO.frequency.value = 600;
    const cdp = G(0.85); this.chopO.connect(cdp); cdp.connect(this.grassAM.gain); this.chopO.start();
    const fld = G(0.45); gfl.connect(fld); fld.connect(this.grassFl.gain);                  // clump density flutter
    gn.connect(this.grassF); this.grassF.connect(this.grassAM); this.grassAM.connect(this.grassFl); this.grassFl.connect(this.grassG); this.grassG.connect(this.motorBus);
    const glp = F('lowpass', 420, -3); gn.connect(glp); glp.connect(this.grassLo); this.grassLo.connect(this.bus);

    this.white = white;
    if (live) ctx.onstatechange = () => { this.state = ctx.state; };
  }
  // the world path (sound #1). Idempotent. out -> master becomes out -> limiter -> brickwall -> master, with
  // world -> duck -> limiter.
  openWorld() {
    if (this._wOpen) return this.world;
    const ctx = this.ctx; if (!ctx) return null;
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
    const trim = ctx.createGain(); trim.gain.value = Math.pow(10, -0.57 / 20);   // cancels the compressor's auto make-up (-1 dB, 20:1 -> +0.57 dB)
    this.world = ctx.createGain(); this.worldDuck = ctx.createGain();
    this.world.connect(this.worldDuck); this.worldDuck.connect(trim);
    try { this._out.disconnect(this.master); } catch (e) { try { this._out.disconnect(); } catch (e2) {} }
    // P3 (sound bug: +0.9 dBFS overs on club-door kicks, +0.5-1.2 in the first second: a compressor has no lookahead
    // here and its envelope starts at 0): a brickwall after it. A curve that is the identity up to -2 dBFS and bends
    // into a -0.3 dBFS ceiling over a +6 dB input range (pre 1/2, post x2); untouched below -2 dBFS, so a hover is too.
    const pre = ctx.createGain(), post = ctx.createGain(), bw = ctx.createWaveShaper(), N = 4097, cv = new Float32Array(N), T = 0.794, C = 0.966;
    for (let i = 0; i < N; i++) { const x = 2 * (i / (N - 1) * 2 - 1), a = Math.abs(x); cv[i] = Math.sign(x) * (a <= T ? a : T + (C - T) * Math.tanh((a - T) / (C - T))) / 2; }
    pre.gain.value = 0.5; post.gain.value = 2; bw.curve = cv; bw.oversample = 'none';
    this._out.connect(trim); trim.connect(lim); lim.connect(pre); pre.connect(bw); bw.connect(post); post.connect(this.master);
    this._wLim = lim; this._wClip = bw; this._wOpen = true;
    return this.world;
  }
  // resume after iOS 'interrupted'/'suspended' (call call/Siri/lock); must run inside a gesture.
  // force: run even with Sound Off (clip export needs samples; the speaker stays muted)
  kick(force) { const c = this.ctx; if (c && (this.on || force) && c.state !== 'running') { const p = c.resume?.(); p?.catch?.(() => {}); } }
  idle() { const c = this.ctx; if (c && c.state === 'running') c.suspend?.(); }   // menu / sound off: zero CPU

  _ok() { return !!this.ctx && (this.offline || this.ctx.state === 'running'); }
  update(motors, speed, wash, crashed, mute, x = {}, at) {
    if (!this._ok()) return;
    const t = at ?? this.ctx.currentTime, C = this.craft, dt = Math.max(0, Math.min(0.1, t - (this.lastT ?? t))); this.lastT = t;
    const k = this._snap ? 0.02 : 1; this._snap = false;
    const S = (p, v, tau) => p.setTargetAtTime(v, t, tau * k);
    S(this.master.gain, mute ? 0 : 1, 0.06); if (this.spk) S(this.spk.gain, mute || !this.on ? 0 : MODES[this.mode].spk, 0.06);
    // spool-down glide after a crash; re-arm (respawn) spools up over ~0.3 s and the camera's gain ride starts from
    // unity instead of the post-crash hush (it held x1.7 and the restart played +3.5 dB hot for 0.25 s)
    if (!crashed && this._cr && k === 1) this.ride = 1;
    this._cr = crashed;
    this.spin = crashed ? (k < 1 ? 0 : this.spin * Math.exp(-dt / 0.35)) : (k < 1 ? 1 : Math.min(1, this.spin + dt / 0.3));
    const near = clamp(1 - (x.dist ?? Infinity) / 1.5), hall = x.hall || 0, tube = x.tube || 0, gr0 = crashed ? 0 : clamp(+x.grass || 0);
    const jit = 0.008 + 0.012 * clamp(speed / 25) + 0.05 * wash + 0.02 * near + 0.03 * gr0;
    const sag = 1 - 0.07 * gr0;                                                    // grass loads the props: up to 7 % RPM sag   // fractional RPM jitter (PID + turbulence)
    const cr = this.spin * this.spin;
    const aL = Math.exp(-dt / 0.3), aN = Math.sqrt(1 - aL * aL) * 0.1;          // per-motor level flutter: ~±1 dB, 0.3 s
    let bpf = 0, rs = 0, pm = 0;
    this.motors.forEach((m, i) => {
      this.drift[i] += (-this.drift[i] * 0.02) + (this.rnd() - 0.5) * 0.0006;  // slow OU trim drift ±0.3 %
      this.lvlD[i] = this.lvlD[i] * aL + gauss(this.rnd) * aN;                             // prop/ESC asymmetry, turbulence ingestion
      const rpm = (crashed ? C.idle : Math.max(C.idle, motors[i])) * this.spin;
      const hz = C.maxHz * rpm * m.det * (1 + this.drift[i]) * sag;
      S(m.o.frequency, hz, 0.012);                                                 // physics already has spool lag
      S(m.fm.gain, hz * jit, 0.05);
      const lvl = 0.07 * Math.pow(rpm / C.hover, 1.6) * cr * (1 + this.lvlD[i]);  // ~+13 dB hover->full
      S(m.g.gain, lvl, 0.015);
      bpf += hz * C.blades / 4; rs += rpm / 4; pm += lvl * lvl;
    });
    S(this.tone.frequency, Math.min(16000, 1200 + 6 * bpf), 0.02);
    const fr = clamp(3.2 * bpf, 1500, 7000), rg = 0.12 * Math.pow(rs / C.hover, 2.5) * cr;   // tip-speed^5 power
    S(this.raspO.frequency, Math.max(20, bpf), 0.012); S(this.raspF.frequency, fr, 0.03); S(this.raspG.gain, rg, 0.015);
    S(this.amDepth.gain, 0.35 * wash, 0.05);
    const gk = gr0 * Math.pow(clamp(rs / C.hover, 0, 2.5), 1.2) * cr, gg = 0.8 * gk, gl = 0.35 * gk;
    S(this.chopO.frequency, Math.max(20, bpf), 0.012); S(this.grassG.gain, gg, 0.03); S(this.grassLo.gain, gl, 0.03);
    const d = clamp((x.dist ?? 9) + 0.12, 0.05, 2.1);                     // mic-to-surface; lastDist is Infinity past 2 m
    S(this.refl.delayTime, 2 * d / 343, 0.04);                            // moving image source = the only doppler onboard
    S(this.reflG.gain, 0.65 * clamp(1 - d / 2.0), 0.04);
    const v = clamp((speed - 2) / 25), gb = 0.9 * Math.pow(v, 1.2), gr = 0.15 * v * v + 0.35 * near * clamp(speed / 15), fw = 600 + 45 * speed;
    S(this.buffetG.gain, gb, 0.1); S(this.gustD.gain, 0.5 * v, 0.2);
    S(this.rushG.gain, gr, 0.08); this.rush.forEach((f) => S(f.frequency, fw, 0.1));
    const s = clamp((x.scrape || 0) / 8);
    S(this.scrG.gain, 0.3 * s, s ? 0.01 : 0.06); S(this.scr.frequency, 1600 + 1800 * s, 0.05);
    S(this.hallS.gain, 1.1 * hall, 0.25);
    S(this.tubeS.gain, 0.35 * tube, 0.2);
    const ga = 0.005 * (1 - 0.6 * Math.max(hall, tube));                  // indoors: less outdoor air
    S(this.ambG.gain, ga, 0.5);
    if (x.tubeD) S(this.tubeD.delayTime, clamp(2 * x.tubeD / 343, 0.008, 0.05), 0.3);
    // ---- camera auto-gain ride. An action camera's AGC slowly brings quiet passages up to recording level, so an
    // idle dive is carried by its wind roar and, after a crash, the hiss and outdoor air swell: the cue that says
    // "camera mic" more than any one layer. Open loop: the bus RMS is estimated from this frame's layer gains
    // (mean square of white noise 1/3, a filter passes ~bandwidth/nyquist of it), so it renders the same offline.
    // Up over ~1.2 s, down in ~0.12 s; a punch-out after a dive briefly overdrives the mic stage, as on a real camera.
    const ny = this.ctx.sampleRate / 2;
    const P = pm * this.waveMs + rg * rg * (fr / 0.55 / ny) * 0.354 / 3 + 2 * gb * gb * (240 / ny) * (1 + 0.25 * v * v) / 3 * 0.5 +
      2 * gr * gr * (fw / 0.7 / ny) / 3 * 0.5 + ga * ga * (1800 / ny) / 3 + gg * gg * (2700 / ny) / 3 * 0.35 + gl * gl * (420 / ny) / 3;
    this.rideEst = Math.sqrt(P);
    const want = !crashed && this.spin < 1 ? 1 : clamp(RIDE_REF / Math.max(1e-6, this.rideEst), 1, RIDE_MAX);   // no ride during a re-arm spool-up
    this.ride = k < 1 ? want : this.ride + (want - this.ride) * (1 - Math.exp(-dt / (want > this.ride ? 1.2 : 0.12)));
    S(this.rideG.gain, this.ride, 0.03);
    // world duck (sound #1): 0 dB up to the hover level of the props+wind, -6 dB at +12 dB over it; 80 ms down, 400 ms up
    if (this.worldDuck) {
      const over = 20 * Math.log10(Math.max(1e-6, this.rideEst) / RIDE_HOVER), want = Math.pow(10, -6 * clamp(over / 12) / 20);
      this.duck = k < 1 ? want : this.duck + (want - this.duck) * (1 - Math.exp(-dt / (want < this.duck ? 0.08 : 0.4)));
      // (offline: a linear ramp per frame. node-web-audio-api's setTargetAtTime on this param blew up a render: +60 dB)
      if (this.offline) this.worldDuck.gain.linearRampToValueAtTime(crashed ? 1 : this.duck, t + 0.033); else S(this.worldDuck.gain, crashed ? 1 : this.duck, 0.02);
    }
  }

  // non-crash touch: frame "tock" (carbon modes) + prop-tip chatter at blade-pass rate. v = impact speed, m/s
  hit(v, at) {
    if (!this._ok()) return;
    const ctx = this.ctx, t = at ?? ctx.currentTime, a = clamp(v / 10, 0.05, 1);
    for (const [f, dec, g] of [[740, 0.09, 0.5], [1630, 0.06, 0.4], [2950, 0.04, 0.3]]) {
      const o = ctx.createOscillator(), e = ctx.createGain(); o.frequency.value = f * (0.97 + this.rnd() * 0.06);
      e.gain.setValueAtTime(g * a, t); e.gain.exponentialRampToValueAtTime(0.0005, t + dec);
      o.connect(e); e.connect(this.bus); o.start(t); o.stop(t + dec + 0.02);
    }
    const n = ctx.createBufferSource(); n.buffer = this.white; const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3000; bp.Q.value = 1.1;
    const e = ctx.createGain(), chop = ctx.createOscillator(), cg = ctx.createGain(); const dur = 0.04 + 0.08 * a;
    chop.type = 'square'; chop.frequency.value = this.craft.maxHz * this.craft.hover * this.craft.blades; const cd = ctx.createGain(); cd.gain.value = 0.5; chop.connect(cd); cd.connect(cg.gain); cg.gain.value = 0.6;
    e.gain.setValueAtTime(0.9 * a, t); e.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(bp); bp.connect(cg); cg.connect(e); e.connect(this.bus); n.start(t, this.rnd() * 3); n.stop(t + dur + 0.02); chop.start(t); chop.stop(t + dur + 0.02);
  }
  // crash: hard hit + body crunch with speaker-audible harmonics + tumbling debris ticks; motors spool down in update()
  thud(v, at) {
    if (!this._ok()) return;
    const ctx = this.ctx, t = at ?? ctx.currentTime, a = clamp(v / 10, 0.4, 1);
    if (Math.abs(t - (this.thudAt ?? -9)) < 0.15) return;  // one crash = one thud (main.js may trigger it from two places)
    this.thudAt = t;
    this.hit(8, at);
    for (const [f0, f1, g] of [[150, 55, 0.8], [300, 110, 0.35]]) {      // 2nd partial so phone speakers carry it
      const o = ctx.createOscillator(), e = ctx.createGain(); o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + 0.16);
      e.gain.setValueAtTime(g * a, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.28); o.connect(e); e.connect(this.bus); o.start(t); o.stop(t + 0.3);
    }
    const n = ctx.createBufferSource(); n.buffer = this.white; const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 0.5;
    const e = ctx.createGain(); e.gain.setValueAtTime(0.7 * a, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    n.connect(bp); bp.connect(e); e.connect(this.bus); n.start(t, this.rnd() * 3); n.stop(t + 0.25);
    for (let k = 1; k <= 4; k++) {                                         // tumble
      const d = (90 * k + this.rnd() * 80) / 1000;
      if (at != null) this.hit(4 / k, t + d); else setTimeout(() => this.hit(4 / k), d * 1000);
    }
  }
}
