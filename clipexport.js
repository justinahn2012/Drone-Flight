// clipexport.js — HQ offline clip render (art #6, FPV #4, PLAN4 decision 8), stream F24.
// The take is re-simulated from its input log (snapshot + quantised sticks, bit-exact with the live flight), each 30p
// output frame is rendered as N sub-frames spread over the 1/60 s shutter and averaged in linear light (real motion
// blur instead of the live 14-tap smear), the audio is re-synthesised on an OfflineAudioContext, and both are encoded
// with WebCodecs into an MP4 by mp4-muxer (import map, jsdelivr, MIT; loaded only when a clip is made).
// main.js falls back to the real-time MediaRecorder path when hqSupport() says no or renderHQ() throws.
//
//   hqSupport() -> Promise<{ video, audio } | null>      (codecs that will be used; cached)
//   renderHQ({ C, world, renderer, fpv, size:[w,h], sub, shutter, tiltFor, makeAudio, renderSub, composite, comp,
//              onProgress, cancelled }) -> Promise<{ blob, stats }>
// C (main.js buildClip): f (frames, stabilised), raw (the same frames unstabilised), ot (output s), seg, sigma, dur.
// Frames carry L (InputLog), k (ticks run in it), a (physAlpha), p/q (camera), mo, ... (pushReplay).
import * as THREE from 'three';
import { Drone } from './flight.js';
import { worldHash } from './inputlog.js';

const FPS = 30, SR = 48000;
let _support;
export function hqSupport() {
  if (_support) return _support;
  _support = (async () => {
    try {
      if (!window.VideoEncoder || !window.AudioEncoder || !window.VideoFrame || !window.AudioData || !(window.OfflineAudioContext)) return null;
      let video = null;
      for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028']) {
        const r = await VideoEncoder.isConfigSupported({ codec, width: 1080, height: 1920, bitrate: 14e6, framerate: FPS, avc: { format: 'avc' } }).catch(() => null);
        if (r?.supported) { video = codec; break; }
      }
      if (!video) return null;
      let audio = null;
      for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
        const r = await AudioEncoder.isConfigSupported({ codec, sampleRate: SR, numberOfChannels: 2, bitrate: 160e3 }).catch(() => null);
        if (r?.supported) { audio = { codec, mux }; break; }
      }
      if (!audio) return null;
      await import('mp4-muxer');                                   // prefetch; a failed CDN fetch = no HQ
      return { video, audio };
    } catch (e) { console.warn('HQ clips unavailable', e); return null; }
  })();
  return _support;
}

// ---------------------------------------------------------------- re-simulation + camera sampler
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qt = new THREE.Quaternion(), _va = new THREE.Vector3(), _X = new THREE.Vector3(1, 0, 0);
// a run: consecutive output frames in one segment, one input log, ticks advancing
function buildRuns(C) {
  const runs = []; let r = null;
  for (let i = 0; i < C.f.length; i++) {
    const fr = C.raw[i], L = fr.L || null;
    const join = r && C.seg[i] === C.seg[i - 1] && L === r.L && L && fr.k >= C.raw[i - 1].k && fr.k - C.raw[i - 1].k <= 48;
    if (!join) { r = { i0: i, i1: i, L, seg: C.seg[i] }; runs.push(r); } else r.i1 = i;
  }
  return runs;
}
// step a fresh Drone through the log; per tick k (state after k inputs): pos, quat, cam pitch (camView)
function resim(run, C, world, tiltFor, hash) {
  const L = run.L; if (!L || L.header.world !== hash || !L.header.start) return false;
  let kMin = Infinity, kMax = -Infinity;
  for (let i = run.i0; i <= run.i1; i++) { const k = C.raw[i].k; if (!(k >= 1)) return false; kMin = Math.min(kMin, k); kMax = Math.max(kMax, k); }
  const k0 = Math.max(0, kMin - 8), k1 = Math.min(L.ticks, kMax + 8);
  let s = L.header.start, sk = 0;
  for (const sn of L.snaps) if (sn.tick <= k0 && sn.tick > sk) { s = sn.s; sk = sn.tick; }
  const d = new Drone(L.header.craft || s.key, L.header.seed); d.restore(s);
  const n = k1 - k0 + 1, P = new Float64Array(n * 3), Q = new Float64Array(n * 4), CV = new Float64Array(n);
  let mode = L.header.mode, mi = 0; const inp = {};
  while (mi < L.modes.length && L.modes[mi].tick <= sk) mode = L.modes[mi++].mode;
  const hasCV = typeof d.camView === 'function' && d.camView.length >= 1 && 'pcP' in d;   // E4: camera state in step()
  const put = (k) => { const j = k - k0; P.set([d.pos.x, d.pos.y, d.pos.z], j * 3); Q.set([d.q.x, d.q.y, d.q.z, d.q.w], j * 4); CV[j] = hasCV ? d.camView(1, tiltFor(mode)) : 0; };
  if (sk >= k0) put(sk);
  for (let i = sk; i < k1; i++) {
    while (mi < L.modes.length && L.modes[mi].tick === i) mode = L.modes[mi++].mode;
    L.input(i, inp); d.step(1 / L.header.hz, inp, mode, world);
    if (i + 1 >= k0) put(i + 1);
  }
  run.sim = { k0, k1, P, Q, CV, tilt: tiltFor };
  run.modeAt = mode;
  return true;
}
// body pose (+ cam pitch) at continuous tick tau
function simAt(sim, tau, outP, outQ) {
  const t = Math.max(sim.k0, Math.min(sim.k1, tau)), a = Math.min(sim.k1 - sim.k0 - 1, Math.floor(t - sim.k0)), u = t - sim.k0 - a;
  const P = sim.P, Q = sim.Q;
  outP.set(P[a * 3] + (P[a * 3 + 3] - P[a * 3]) * u, P[a * 3 + 1] + (P[a * 3 + 4] - P[a * 3 + 1]) * u, P[a * 3 + 2] + (P[a * 3 + 5] - P[a * 3 + 2]) * u);
  _qa.fromArray(Q, a * 4); _qb.fromArray(Q, a * 4 + 4); outQ.slerpQuaternions(_qa, _qb, u);
  return sim.CV[a] + (sim.CV[a + 1] - sim.CV[a]) * u;
}
// camera base orientation from the sim: body x uptilt+camView pitch (the live rig's tiltQ); the residual (STAB lag,
// anything else main.js's rig adds) comes from the recorded frames
function baseAt(run, tau, outP, outQ) {
  const cv = simAt(run.sim, tau, outP, outQ);
  if (run.cvOn) outQ.multiply(_qt.setFromAxisAngle(_X, run.tiltK + cv));
  return outQ;
}
function prepRun(run, C) {
  const s = run.sim, n = run.i1 - run.i0 + 1;
  run.tau = new Float64Array(n); run.op = []; run.res = [];
  run.cvOn = s.CV.some((v) => v !== 0); run.tiltK = run.cvOn ? s.tilt(run.modeAt) : 0;
  const p = new THREE.Vector3(), q = new THREE.Quaternion(); let maxOff = 0;
  for (let j = 0; j < n; j++) {
    const fr = C.raw[run.i0 + j], tau = fr.k - 1 + (fr.a ?? 1);
    run.tau[j] = tau; baseAt(run, tau, p, q);
    const op = fr.p.clone().sub(p); maxOff = Math.max(maxOff, op.length());
    run.op.push(op); run.res.push(q.clone().invert().multiply(fr.q));
  }
  run.maxOff = maxOff;
  return maxOff < 0.3;                                   // mount offset is ~5 cm: more = the re-sim diverged
}

export function makeSampler(C, world, tiltFor) {
  const runs = buildRuns(C), hash = world?.bvh ? worldHash(world) : null, stats = { runs: runs.length, resim: 0, maxOff: 0 };
  const runOf = new Int32Array(C.f.length);
  runs.forEach((r, ri) => {
    for (let i = r.i0; i <= r.i1; i++) runOf[i] = ri;
    try { r.ok = resim(r, C, world, tiltFor, hash) && prepRun(r, C); } catch (e) { console.warn('resim', e); r.ok = false; }
    if (r.ok) { stats.resim++; stats.maxOff = Math.max(stats.maxOff, r.maxOff); }
  });
  const smooth = C.sigma > 0;
  const pA = new THREE.Vector3(), qA = new THREE.Quaternion();
  // camera {p, q} at output time T, inside segment `seg` (frame index hint i)
  function pose(T, i, outP, outQ) {
    const r = runs[runOf[i]];
    let j = i; while (j > r.i0 && C.ot[j] > T) j--; while (j < r.i1 && C.ot[j + 1] <= T) j++;
    const j1 = Math.min(j + 1, r.i1), span = C.ot[j1] - C.ot[j];
    const u = j1 > j && span > 0 ? (T - C.ot[j]) / span : 0, uc = Math.max(0, Math.min(1, u));
    const a = C.f[j], b = C.f[j1];
    if (!r.ok) {                                         // no log / diverged: the recorded 60 Hz poses
      outP.copy(a.p).lerp(b.p, uc); outQ.slerpQuaternions(a.q, b.q, uc); return;
    }
    const jj = j - r.i0, jj1 = j1 - r.i0;
    let tau;
    const e = T < C.ot[r.i0] ? r.i0 : T > C.ot[r.i1] ? r.i1 : -1;                // past the run's edge: keep simulating
    if (e >= 0) tau = r.tau[e - r.i0] + (T - C.ot[e]) * r.L.header.hz;
    else tau = r.tau[jj] + (r.tau[jj1] - r.tau[jj]) * uc;
    baseAt(r, tau, pA, qA);
    outP.copy(pA).add(_va.copy(r.op[jj]).lerp(r.op[jj1], uc));
    if (smooth) outQ.slerpQuaternions(a.q, b.q, uc);     // stabilised clip: the smoothed path (no 240 Hz shake back in)
    else outQ.copy(qA).multiply(_qt.slerpQuaternions(r.res[jj], r.res[jj1], uc));
  }
  return { pose, stats, runs };
}

// ---------------------------------------------------------------- linear-light sub-frame accumulator
const VS = 'precision highp float;\nin vec3 position;\nout vec2 vUv;\nvoid main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const S2L = 'vec3 s2l(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }\nvec3 l2s(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }\n';
function quad(fs, uniforms, blending) {
  const m = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
  if (blending) { m.transparent = true; m.blending = THREE.CustomBlending; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; m.blendEquation = THREE.AddEquation; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; const sc = new THREE.Scene(); sc.add(mesh); return { sc, m };
}
class Accum {
  constructor(r, w, h) {
    this.r = r; this.w = w; this.h = h; this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fb = new THREE.FramebufferTexture(w, h);
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.add_ = quad('precision highp float;\n' + S2L + 'in vec2 vUv; out vec4 o; uniform sampler2D t; uniform float w;\nvoid main(){ o = vec4(s2l(texture(t, vUv).rgb) * w, 1.0); }', { t: { value: this.fb }, w: { value: 1 } }, true);
    this.out_ = quad('precision highp float;\n' + S2L + 'in vec2 vUv; out vec4 o; uniform sampler2D t; uniform float f;\nfloat h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + f) * 43758.5453); }\nvoid main(){ vec3 c = l2s(texture(t, vUv).rgb); o = vec4(c + (h(gl_FragCoord.xy) + h(gl_FragCoord.yx + 17.0) - 1.0) / 255.0, 1.0); }', { t: { value: this.rt.texture }, f: { value: 0 } });
  }
  begin() { const r = this.r; r.setRenderTarget(this.rt); r.setClearColor(0x000000, 1); r.clear(true, false, false); }
  // after fpv.render() drew a sub-frame to the canvas
  add(weight) {
    const r = this.r; r.setRenderTarget(null); r.copyFramebufferToTexture(this.fb);
    this.add_.m.uniforms.w.value = weight; r.setRenderTarget(this.rt); r.render(this.add_.sc, this.cam);
  }
  resolve(k) { const r = this.r; this.out_.m.uniforms.f.value = k % 97; r.setRenderTarget(null); r.setViewport(0, 0, this.w, this.h); r.render(this.out_.sc, this.cam); }
  dispose() { this.fb.dispose(); this.rt.dispose(); for (const q of [this.add_, this.out_]) { q.m.dispose(); q.sc.children[0].geometry.dispose(); } }
}

// ---------------------------------------------------------------- render + encode
const tick = () => new Promise((ok) => setTimeout(ok, 0));
export async function renderHQ(o) {
  const sup = await hqSupport(); if (!sup) throw new Error('no WebCodecs');
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const { C, world, renderer, fpv, comp } = o, [RW, RH] = o.size, N = Math.max(1, o.sub | 0), sh = o.shutter;
  const OW = comp.width, OH = comp.height, t0 = performance.now();
  const nF = Math.floor(C.dur * FPS + 1e-6) + 1;
  const smp = makeSampler(C, world, o.tiltFor);
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: OW, height: OH, frameRate: FPS },
    audio: { codec: sup.audio.mux, numberOfChannels: 2, sampleRate: SR }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  let err = null; const fail = (e) => { err = err || e; };
  // ---- audio first (fast): the clip's own sound, re-synthesised offline on the output timeline
  const actx = new OfflineAudioContext(2, Math.ceil((nF / FPS) * SR), SR);
  o.makeAudio(actx);
  const ab = await actx.startRendering();
  if (o.cancelled()) return null;
  const aenc = new AudioEncoder({ output: (c, m) => { try { muxer.addAudioChunk(c, m); } catch (e) { fail(e); } }, error: fail });
  aenc.configure({ codec: sup.audio.codec, sampleRate: SR, numberOfChannels: 2, bitrate: 160e3 });
  const L = ab.getChannelData(0), R = ab.getChannelData(1), BL = 1024;
  let peak = 0, ss = 0;
  for (let i = 0; i < ab.length; i += BL) {
    const n = Math.min(BL, ab.length - i), d = new Float32Array(n * 2);
    d.set(L.subarray(i, i + n), 0); d.set(R.subarray(i, i + n), n);
    for (let j = 0; j < n; j++) { const v = (L[i + j] + R[i + j]) / 2; ss += v * v; peak = Math.max(peak, Math.abs(L[i + j]), Math.abs(R[i + j])); }
    const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / SR * 1e6), data: d });
    aenc.encode(ad); ad.close();
  }
  await aenc.flush(); aenc.close();
  const tA = performance.now();
  // ---- video: N sub-frames per output frame, accumulated, composited (captions), encoded
  const venc = new VideoEncoder({ output: (c, m) => { try { muxer.addVideoChunk(c, m); } catch (e) { fail(e); } }, error: fail });
  venc.configure({ codec: sup.video, width: OW, height: OH, bitrate: OW * OH >= 1.5e6 ? 14e6 : 8e6, framerate: FPS, latencyMode: 'quality', avc: { format: 'avc' } });
  const acc = new Accum(renderer, RW, RH), P = new THREE.Vector3(), Q = new THREE.Quaternion(), P2 = new THREE.Vector3(), Q2 = new THREE.Quaternion();
  let i = 0, lastT = null, capFrames = [];
  try {
    for (let k = 0; k < nF; k++) {
      if (err) throw err;
      if (o.cancelled()) return null;
      while (document.hidden) await new Promise((ok) => setTimeout(ok, 250));   // background: wait (rAF/timers are throttled)
      const T = Math.min(k / FPS, C.dur);
      const iPrev = i; while (i < C.f.length - 1 && C.ot[i + 1] <= T + 1e-9) i++;
      const cut = k === 0 || C.seg[i] !== C.seg[iPrev];
      acc.begin();
      for (let s = 0; s < N; s++) {
        const Ts = T + sh * ((s + 0.5) / N - 0.5), dd = sh / N / 2;
        smp.pose(Ts, i, P, Q);
        smp.pose(Ts + dd, i, P2, Q2); const vel = P2.clone(), q2 = Q2.clone();
        smp.pose(Ts - dd, i, P2, Q2); vel.sub(P2).divideScalar(2 * dd);
        const dq = q2.multiply(Q2.invert()); if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
        const sn = Math.sqrt(Math.max(1e-12, 1 - dq.w * dq.w)), ang = 2 * Math.acos(Math.min(1, dq.w)) / (2 * dd);
        const dt = lastT == null ? 1 / FPS : Math.max(1e-4, cut && s === 0 ? 1 / FPS : Ts - lastT); lastT = Ts;
        o.renderSub({ p: P, q: Q, vel, ang: new THREE.Vector3(dq.x / sn * ang, dq.y / sn * ang, dq.z / sn * ang), i, T: Ts, reset: cut && s === 0, dt });
        acc.add(1 / N);
      }
      acc.resolve(k);
      const capOn = o.composite(k, T, i);
      if (capOn && !capFrames.some((c) => c[1] === capOn)) capFrames.push([k, capOn]);
      const vf = new VideoFrame(comp, { timestamp: Math.round(k * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      venc.encode(vf, { keyFrame: k % 60 === 0 }); vf.close();
      while (venc.encodeQueueSize > 2) await new Promise((ok) => setTimeout(ok, 4));
      o.onProgress?.((k + 1) / nF);
      await tick();
    }
    await venc.flush();
  } finally { try { venc.state !== 'closed' && venc.close(); } catch (e) {} acc.dispose(); }
  if (err) throw err;
  muxer.finalize();
  const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
  return { blob, stats: { ...smp.stats, sub: N, frames: nF, video: sup.video, audio: sup.audio.codec, msAudio: Math.round(tA - t0), msTotal: Math.round(performance.now() - t0),
    audioRms: +(10 * Math.log10(ss / ab.length + 1e-12)).toFixed(1), audioPeak: +(20 * Math.log10(peak + 1e-12)).toFixed(1), capFrames } };
}
