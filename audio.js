// audio.js — synthesized quad: four detuned motor tones + prop wash + wind.
export class MotorAudio {
  constructor() { this.ctx = null; this.on = true; }
  start() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 4;
    this.master.connect(comp); comp.connect(ctx.destination);
    this.streamDest = ctx.createMediaStreamDestination(); comp.connect(this.streamDest);
    this.motors = [0, 1, 2, 3].map((i) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      const o2 = ctx.createOscillator(); o2.type = 'square';
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 2.5;
      const g = ctx.createGain(); g.gain.value = 0.06;
      const g2 = ctx.createGain(); g2.gain.value = 0.25;
      o.connect(f); o2.connect(g2); g2.connect(f); f.connect(g); g.connect(this.master);
      o.start(); o2.start();
      return { o, o2, f, g, det: 1 + (i - 1.5) * 0.013 };
    });
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const mk = (type, freq, q) => {
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0; s.connect(f); f.connect(g); g.connect(this.master); s.start();
      return { f, g };
    };
    this.wind = mk('bandpass', 700, 0.6);
    this.wash = mk('lowpass', 300, 1.0);
  }
  update(motors, speed, wash, crashed, mute) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = 0.05;
    this.master.gain.setTargetAtTime(mute || !this.on ? 0 : 0.55, t, 0.08);
    this.motors.forEach((m, i) => {
      const cmd = crashed ? 0 : motors[i];
      const hz = (70 + 520 * Math.sqrt(cmd)) * m.det;
      m.o.frequency.setTargetAtTime(hz, t, k); m.o2.frequency.setTargetAtTime(hz * 2.01, t, k);
      m.f.frequency.setTargetAtTime(hz * 3.2 + 300, t, k);
      m.g.gain.setTargetAtTime(crashed ? 0 : 0.025 + 0.06 * cmd, t, k);
    });
    this.wind.g.gain.setTargetAtTime(Math.min(0.5, speed * speed * 0.0006), t, 0.1);
    this.wind.f.frequency.setTargetAtTime(400 + speed * 40, t, 0.1);
    this.wash.g.gain.setTargetAtTime(crashed ? 0 : wash * 0.5, t, 0.05);
  }
  thud(v) {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(120, ctx.currentTime); o.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.18);
    g.gain.setValueAtTime(Math.min(0.9, v * 0.12), ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    o.connect(g); g.connect(this.master); o.start(); o.stop(ctx.currentTime + 0.3);
  }
}
