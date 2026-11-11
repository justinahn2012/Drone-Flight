// perf.js: the ?perf frame-time probe (round 3 perf/native #2.1; round 5 P5 adds the stress segments + the soak).
// Real timings from Justin's phone. Open the game with ?perf (?perf=N: N timed frames per segment, default 120). The
// game's own rAF loop stays off (main.js). The world loads, then you tap RUN while holding the phone the way you fly.
//
// RUN = the four segments at each scale (about 40 s), then a 3-minute SOAK (QUICK skips the soak):
//   cruise  spawn, 1.6 m up, 5 m/s toward the site (round 4's only segment)
//   skim    1.5 m over the meadow at 10 m/s (grass at full density under the lens)
//   carve   a 120 deg/s turn at 8 m/s, 10 m up over the yard, the site sweeping through the frame
//   hover   still, 2 m outside the biggest tree crown in reach, looking into it (alpha-tested card overdraw)
// The drone is placed kinematically each frame (the paths are the same every run, nothing can crash). Per segment and
// scale (1.0, then 1.2): warm-up frames, then N timed frames, one per rAF, the resolution governor frozen. A sample =
// main.js frame() + a 1-pixel readPixels from the canvas, which waits until the GPU has finished the frame, so it is
// CPU + GPU serialised (an upper bound: the live game overlaps them). cpu = frame() alone; gpu ~ total - cpu.
// SOAK cycles the segments at scale 1.0 for 180 s (the phone heats and throttles) and reports p50/p90 over the first
// and the last 30 s: the last-30-s p90 is the number to size QUALITY.auto.max by.
// Results: the overlay, window.__onetake.perf, and the console line "perf {json}".
// A scale "fits 60 Hz" when every segment's p90 is under 14.2 ms (16.7 ms minus 15 % headroom).
// URL options: ?perf=N, &soak=S (seconds; default 180 for N >= 60, else 0), &seg=cruise,hover (a subset), &preset=phone
// (Seoul, P3 perf #6: MSAA 2 + the light's 'low' quality; the result suggests 'phone' when the GPU runs past 12 ms).
// Neon Seoul (?level=seoul&perf, phase 2 stream D perf #5): its own segments (walk: the Eoulmadang-ro walking street at
// 5 m/s; canyon: the Yanghwa-ro screen strip at 8 m, 8 m/s; club: Wausan-ro 19-gil at 4 m/s; high: 60 m over the block,
// 35 deg down), the same scales and soak, and world.update split per part (light / life / signs ms per frame) so the
// phone's CPU line names its owner.
const SCALES = [1.0, 1.2], WARM = 30, BUDGET = 14.2, TAIL = 30;
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');
const raf = () => new Promise((r) => requestAnimationFrame(r));
const DEG = Math.PI / 180;

// ---- segments: setup(o) once per run of the segment, then pose(o, i, dt) -> [x, y, z, yaw, pitchDeg, vx, vy, vz]
// yaw: radians about +Y, 0 looks along -Z (flight.js reset). pitchDeg is added to the camera uptilt compensation.
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
function findCrown(o) {
  // the biggest crown within 70 m of the site centre whose hover point has 1.5 m of clearance (veg cards: every
  // plant at LOD 1 for the scan, back to the camera LODs after). null: fall back to a fixed point.
  const sc = o.world?.scene, fill = sc?.userData?.vegShadowLod, V3 = o.drone.pos.constructor, best = { h: 0 };
  if (!sc) return null;
  try {
    fill?.(1);
    sc.traverse((m) => {
      if (!m.isInstancedMesh || m.name !== 'veg' || !m.count || !m.geometry.getAttribute('aCenter')) return;
      const g = m.geometry; if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox, e = m.instanceMatrix.array, c = new V3(), p = new V3();
      for (let i = 0; i < m.count; i++) {
        const k = i * 16, sx = Math.hypot(e[k], e[k + 1], e[k + 2]), sy = Math.hypot(e[k + 4], e[k + 5], e[k + 6]);
        const h = (b.max.y - b.min.y) * sy, r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5 * sx;
        c.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2).applyMatrix4({ elements: e.subarray(k, k + 16) });
        if (h <= best.h || Math.hypot(c.x + 5, c.z - 10) > 70 || h < 3) continue;
        for (let a = 0; a < 8; a++) {   // a hover point 2 m outside the crown with room around it
          const ang = a * Math.PI / 4; p.set(c.x + Math.cos(ang) * (r + 2), c.y, c.z + Math.sin(ang) * (r + 2));
          const hit = o.world.bvh?.closestPointToPoint?.(p, {}, 0, 1.5);
          if (!hit && p.y > 1) { Object.assign(best, { h, x: p.x, y: p.y, z: p.z, cx: c.x, cz: c.z, r }); break; }
        }
      }
    });
  } catch (e) { console.warn('perf: crown search failed', e); }
  finally { try { fill?.(-1); } catch (e) {} }
  return best.h ? best : null;
}
const SEGMENTS = {
  cruise: { pose: (o, t) => [0, 1.6, 118 - 5 * t, 0, 4, 0, 0, -5] },
  skim: (() => { const d = Math.hypot(3.4, 9.4), ux = -3.4 / d, uz = -9.4 / d;
    return { pose: (o, t) => [-14 + ux * 10 * t, 1.5, 40 + uz * 10 * t, yawTo(ux, uz), 2, ux * 10, 0, uz * 10] }; })(),
  carve: { pose: (o, t) => {   // 120 deg/s: radius v / w = 3.8 m at 8 m/s, counter-clockwise from above
    const w = 120 * DEG, v = 8, r = v / w, a = w * t, cx = -5, cz = 70, x = cx + Math.cos(a) * r, z = cz - Math.sin(a) * r;
    const vx = -Math.sin(a) * v, vz = -Math.cos(a) * v;
    return [x, 10, z, yawTo(vx, vz), -6, vx, 0, vz];
  } },
  hover: { setup: (o) => { SEGMENTS.hover.at = findCrown(o); },
    pose: (o) => { const c = SEGMENTS.hover.at; return c ? [c.x, c.y, c.z, yawTo(c.cx - c.x, c.cz - c.z), 0, 0, 0, 0] : [-20, 4, 60, 0, 0, 0, 0, 0]; } },
};

const SEOUL_SEGMENTS = {
  walk:   { pose: (o, t) => [-36, 3, -23 - 5 * t, 0, 4, 0, 0, -5] },
  canyon: { pose: (o, t) => [31.8, 8, -309 - 8 * t, 0, 0, 0, 0, -8] },
  club:   { pose: (o, t) => [63.7 - 4 * t, 3, 129.6, 90 * DEG, 4, -4, 0, 0] },
  high:   { pose: (o, t) => [0, 60, 60 - 6 * t, 0, -35, 0, 0, -6] },
};

export function perfProbe(o, frames = 120) {
  const params = new URLSearchParams(location.search);
  const soakS = Math.max(0, +(params.get('soak') ?? (frames >= 60 ? 180 : 0)) || 0);
  const level = String(o.S?.world || '');
  const TABLE = /seoul/i.test(level) ? SEOUL_SEGMENTS : SEGMENTS;
  let segs = (params.get('seg') || Object.keys(TABLE).join(',')).split(',').filter((s) => TABLE[s]);
  const box = document.createElement('div');
  box.id = 'perfProbe';
  box.style.cssText = 'position:fixed;left:8px;right:8px;top:calc(8px + env(safe-area-inset-top));z-index:99999;padding:10px 12px;max-height:calc(100% - 16px);overflow:auto;' +
    'background:rgba(8,9,11,0.88);color:#f2f2ee;font:13px/1.4 ui-monospace,Menlo,monospace;border-radius:8px;white-space:pre-wrap;pointer-events:auto';
  const txt = document.createElement('div'), bar = document.createElement('div');
  const mkBtn = (label, bg) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = `margin:8px 8px 0 0;font:600 16px ui-monospace,Menlo,monospace;padding:10px 18px;border-radius:6px;border:0;background:${bg};color:#fff`;
    for (const ev of ['touchstart', 'mousedown', 'pointerdown']) b.addEventListener(ev, (e) => e.stopPropagation()); return b; };
  const btn = mkBtn('RUN', '#C9450C'), quick = mkBtn('QUICK', '#3a3d44'), share = mkBtn('SHARE', '#1f6f5c');
  bar.style.display = 'none'; share.style.display = 'none'; bar.append(btn, quick, share); box.append(txt, bar); document.body.appendChild(box);
  btn.id = 'perfRun'; quick.id = 'perfQuick'; share.id = 'perfShare';
  const say = (s) => { txt.textContent = s; };
  const warm = Math.min(WARM, frames);   // a short ?perf=N test run gets a short warm-up too

  const run = async (soak) => {
    bar.style.display = 'none';
    const fpv = o.fpv, r = o.renderer, gl = r.getContext(), px = new Uint8Array(4), S = o.S, d = o.drone;
    const V3 = d.pos.constructor, Q = d.q.constructor, UP = new V3(0, 1, 0), RX = new V3(1, 0, 0), qp = new Q();
    const sync = () => { r.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    const saved = { mode: S.mode, fps: S.fps };
    S.mode = 'cine'; S.fps = '60'; o.applySettings();
    if (fpv.maxScale < Math.max(...SCALES)) fpv.setQualityRange(fpv.minScale, Math.max(...SCALES));   // targets big enough for 1.2
    // P3 perf #6: &preset=phone runs Seoul at the phone preset (MSAA 2, light 'low' where it can be switched live)
    const cap = o.world?.scene?.userData?.seoulLight?.qualityCap || null, preset = params.get('preset');
    const P = preset && cap?.presets?.[preset];
    if (P) { fpv.look.msaa = P.msaa ?? fpv.look.msaa; cap.apply?.(preset); }
    fpv.frameTiming = () => {};                                                                        // governor frozen (own-property shadow)
    const tilt = d.c.camTilt;
    const place = (seg, t, first) => {
      const [x, y, z, yaw, pitch, vx, vy, vz] = seg.pose(o, t);
      if (first) o.tp(x, y, z, yaw / DEG, pitch - tilt);
      d.pos.set(x, y, z); d.prev.copy(d.pos); d.vel.set(vx, vy, vz); d.crashed = false;
      d.q.setFromAxisAngle(UP, yaw).multiply(qp.setFromAxisAngle(RX, (pitch - tilt) * DEG)); d.prevQ?.copy(d.q); d.heading = yaw;
    };
    // [P2 H] world.update() timed on its own (wrapped for the run, restored in finally)
    const w = o.world, upd0 = w?.update; let updMs = 0; const UPD = [];
    if (typeof upd0 === 'function') w.update = function (...args) { const t = performance.now(); try { return upd0.apply(this, args); } finally { updMs += performance.now() - t; } };
    const frame = () => { updMs = 0; const t0 = performance.now(); o.step(1000 / 60, 1, false); const t1 = performance.now(); sync(); const t2 = performance.now(); UPD.push(updMs); return [t2 - t0, t1 - t0]; };
    const stats = (tot, cpu, upd = []) => {
      const gpu = tot.map((v, i) => v - cpu[i]);
      return { p50: q(tot, 0.5), p90: q(tot, 0.9), mean: tot.reduce((a, b) => a + b, 0) / Math.max(1, tot.length), max: Math.max(...tot), cpuP50: q(cpu, 0.5), gpuP50: q(gpu, 0.5), gpuP90: q(gpu, 0.9), n: tot.length,
        ...(upd.length ? { updP50: q(upd, 0.5), updP90: q(upd, 0.9) } : {}) };
    };
    const res = { frames, warm, level, segments: segs, scales: [], out: [fpv.outW, fpv.outH], dpr: devicePixelRatio, quality: S.quality, msaa: fpv.samples | 0, ua: navigator.userAgent, hover: null, soak: null };
    // world.update split (Seoul): time each part's update() for the run, restored after
    const parts = o.world?.scene?.userData?.seoul?.parts || null, wrapped = [];
    const split = { on: false, acc: {}, n: {}, reset() { this.acc = {}; this.n = {}; }, read() { const r = {}; for (const k in this.acc) r[k] = +(this.acc[k] / Math.max(1, this.n[k])).toFixed(2); return r; } };
    if (parts) for (const k of ['light', 'life', 'signs']) {
      const p = parts[k]; if (!p || typeof p.update !== 'function') continue;
      const f = p.update; wrapped.push([p, f]); split.on = true;
      p.update = function (...a) { const t0 = performance.now(); try { return f.apply(this, a); } finally { split.acc[k] = (split.acc[k] || 0) + performance.now() - t0; split.n[k] = (split.n[k] || 0) + 1; } };
    }
    try {
      for (const s of SCALES) {
        const row = { scale: s, px: [Math.round(fpv.outW * s), Math.round(fpv.outH * s)], seg: {} };
        for (const name of segs) {
          const seg = TABLE[name]; seg.setup?.(o); split.reset();
          if (name === 'hover') res.hover = seg.at ? { x: +seg.at.x.toFixed(1), y: +seg.at.y.toFixed(1), z: +seg.at.z.toFixed(1), crownH: +seg.at.h.toFixed(1) } : 'no crown found: fixed point';
          const tot = [], cpu = [], upd = [];
          for (let i = 0; i < warm + frames; i++) {
            await raf();
            fpv.scale = s; place(seg, i / 60, i === 0);
            const [a, b] = frame();
            if (i >= warm) { tot.push(a); cpu.push(b); if (upd0) upd.push(UPD[UPD.length - 1]); }
            if (i % 10 === 0) say(`PERF · ${s.toFixed(1)}× · ${name} · ${i < warm ? 'warm-up' : `frame ${i - warm}/${frames}`}`);
          }
          row.seg[name] = stats(tot, cpu, upd); if (split.on) row.seg[name].parts = split.read();   // [P4 H] upd was dropped (panel3 perf.md bugs)
        }
        const all = Object.values(row.seg);
        row.p90 = Math.max(...all.map((x) => x.p90)); row.worst = Object.keys(row.seg).find((k) => row.seg[k].p90 === row.p90);
        res.scales.push(row);
      }
      if (soak > 0) {   // the phone heats up: cycle the segments at 1.0 for `soak` s, keep every sample with its time
        const T = [], tot = [], cpu = [], t0 = performance.now(); let k = 0, i = 0;
        for (const name of segs) TABLE[name].setup?.(o);
        while ((performance.now() - t0) / 1000 < soak) {
          const name = segs[Math.floor(k / 120) % segs.length], seg = TABLE[name];
          await raf(); fpv.scale = 1.0; place(seg, (k % 120) / 60, k % 120 === 0); k++;
          const [a, b] = frame(); T.push((performance.now() - t0) / 1000); tot.push(a); cpu.push(b);
          if (i++ % 30 === 0) say(`PERF · SOAK ${Math.floor((performance.now() - t0) / 1000)} / ${soak} s · ${name}`);
        }
        const end = T[T.length - 1], pick = (lo, hi) => { const a = [], c = []; T.forEach((t, j) => { if (t >= lo && t < hi) { a.push(tot[j]); c.push(cpu[j]); } }); return stats(a, c); };
        res.soak = { seconds: soak, frames: T.length, first30: pick(0, TAIL), last30: pick(end - TAIL, end + 1) };
        res.soak.throttle = +(res.soak.last30.p90 / res.soak.first30.p90).toFixed(2);
      }
    } finally {
      for (const [p, f] of wrapped) p.update = f;
      if (typeof upd0 === 'function') w.update = upd0;   // [integ7] H's whole-update timer off too
      delete fpv.frameTiming;
      S.mode = saved.mode; S.fps = saved.fps; o.applySettings();
    }
    const fits = res.scales.filter((x) => x.p90 <= BUDGET).map((x) => x.scale);
    res.suggestMax = fits.length ? Math.max(...fits) : null;
    // sustained: scale the 1.0 p90 by the soak's throttle (frame time ~ pixels for the GPU-bound part)
    if (res.soak) { const sus = res.soak.last30.p90; res.sustainedP90 = sus; res.suggestSustained = sus > 0 ? +Math.min(1.2, Math.sqrt(BUDGET / sus)).toFixed(2) : null; }
    // P3 perf #6: Seoul's preset from the numbers: the phone preset when the GPU runs past cap.gpuMs (12) sustained
    if (cap) {
      const g1 = res.scales.find((x) => x.scale === 1.0), gpu = Math.max(res.soak?.last30?.gpuP50 || 0, ...Object.values(g1?.seg || {}).map((v) => v.gpuP50 || 0));
      res.preset = { ran: P ? preset : 'auto', gpuP50: +gpu.toFixed(1), suggest: gpu > (cap.gpuMs || 12) ? 'phone' : 'auto' };
    }
    res.device = deviceInfo(r, params);   // [P4 H, perf #4] what the shared result needs to name the phone and the build
    o.perf = res;
    console.info('perf ' + JSON.stringify(res));
    remember(res);
    const lines = ['PERF · ms per frame (CPU+GPU synced; gpu ≈ total − cpu)'];
    for (const x of res.scales) {
      lines.push(`${x.scale.toFixed(1)}×  ${x.px[0]}×${x.px[1]}  ${x.p90 <= BUDGET ? 'fits 60 Hz' : `over budget (${x.worst})`}`);
      for (const [n, v] of Object.entries(x.seg)) lines.push(`  ${n.padEnd(6)} p50 ${f1(v.p50).padStart(5)}  p90 ${f1(v.p90).padStart(5)}  cpu ${f1(v.cpuP50)}  gpu ${f1(v.gpuP50)}` + (v.parts ? `  [${Object.entries(v.parts).map(([k, ms]) => `${k} ${ms}`).join(' · ')}]` : ''));
    }
    if (res.soak) lines.push(`SOAK ${res.soak.seconds} s · ${res.soak.frames} frames · 1.0×`, `  first 30 s p50 ${f1(res.soak.first30.p50)}  p90 ${f1(res.soak.first30.p90)}`,
      `  last 30 s  p50 ${f1(res.soak.last30.p50)}  p90 ${f1(res.soak.last30.p90)}  gpu ${f1(res.soak.last30.gpuP50)}  (×${res.soak.throttle})`);
    lines.push(`out ${res.out[0]}×${res.out[1]} · dpr ${res.dpr} · ${res.quality} · msaa ${res.msaa}`,
      `suggested auto max: ${res.suggestMax ?? '< 1.0'} (every p90 ≤ ${BUDGET} ms)` + (res.soak ? ` · sustained ≈ ${res.suggestSustained}` : ''),
      ...(res.preset ? [`Seoul preset: ran ${res.preset.ran} · gpu ${res.preset.gpuP50} ms → suggest ${res.preset.suggest}`] : []),
      'Tap SHARE to send this (text + a JSON file) to Messages, Mail or Notes. Reload without ?perf to fly.');
    say(lines.join('\n'));
    o.perfText = lines.slice(0, -1).join('\n');
    btn.textContent = 'RUN AGAIN'; bar.style.display = ''; share.style.display = '';
    return res;
  };
  share.onclick = () => sharePerf(o, say);
  btn.onclick = () => run(params.has('soak') ? soakS : 180);
  quick.onclick = () => run(0);
  o.perfRun = (soak = soakS) => run(soak);   // test hook (CI: tests/browser.mjs)

  say('PERF · loading the world…');
  (async () => {
    await o.startFlight(true);
    while (o.state !== 'fly' && o.state !== 'crash') await new Promise((r) => setTimeout(r, 250));
    // [P2 H] a level other than bando brings its own segments (perf-levels.js), unless ?seg= picked bando ones
    if (o.world?.level && o.world.level !== 'bando' && TABLE !== SEOUL_SEGMENTS) {   // [integ7] Seoul uses D's SEOUL_SEGMENTS; perf-levels.js serves any other level
      try {
        const ls = await (await import('./perf-levels.js')).levelSegments(o);
        if (ls) { for (const k of Object.keys(SEGMENTS)) delete SEGMENTS[k]; Object.assign(SEGMENTS, ls); segs = (params.get('seg') || Object.keys(ls).join(',')).split(',').filter((s) => SEGMENTS[s]); if (!segs.length) segs = Object.keys(ls); }
      } catch (e) { console.warn('perf: level segments', e); }
    }
    o.step(1000 / 60, 1, false);
    const n = SCALES.length * segs.length * (warm + frames);
    say(`PERF · ready. Hold the phone the way you fly, then tap RUN.\n${segs.join(', ')} × ${SCALES.length} scales × (${warm} + ${frames}) frames, about ${Math.ceil(n / 40)} s` +
      (params.has('soak') && !soakS ? '.' : `, then a ${params.has('soak') ? soakS : 180} s soak (QUICK: no soak).`));
    btn.textContent = 'RUN'; bar.style.display = '';
    o.perfReady = true;
  })().catch((e) => say('PERF · failed: ' + (e?.message || e)));
}

// ---- [P4 H, perf #4] a result Justin can send from his iPhone: SHARE opens the iOS share sheet (Web Share API) with the
// overlay's text plus the run as compact JSON, and a .json file holding this run and the last runs on this phone (so an
// auto run and a &preset=phone run go out together). No share sheet: the clipboard; no clipboard: a text box to copy.
// The history lives in this browser's localStorage only (a convenience: it can be empty, and nothing else reads it).
const HIST = 'onetake.perf.history', KEEP = 6;
function deviceInfo(r, params) {
  const gl = r?.getContext?.(), dbg = gl?.getExtension?.('WEBGL_debug_renderer_info');
  const scr = globalThis.screen || {};
  return { at: new Date().toISOString(), url: location.pathname + location.search, renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl?.getParameter?.(gl.RENDERER) ?? null,
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null, screen: [scr.width, scr.height], dpr: globalThis.devicePixelRatio, cores: navigator.hardwareConcurrency ?? null,
    memoryGB: navigator.deviceMemory ?? null, preset: params.get('preset') || 'auto', standalone: !!(navigator.standalone || globalThis.matchMedia?.('(display-mode: standalone)')?.matches),
    build: document.querySelector('meta[name="onetake-build"]')?.content || null };
}
function readHist() { try { const a = JSON.parse(localStorage.getItem(HIST) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function remember(res) { try { const a = readHist(); a.push(res); localStorage.setItem(HIST, JSON.stringify(a.slice(-KEEP))); } catch (e) { /* private mode / storage off: share still has this run */ } }
/** The run in a few hundred bytes (what a text message can carry): per scale and segment p50 / p90 / cpu / gpu (+ parts). */
export function perfDigest(res) {
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  return { v: 1, lvl: res.level, at: res.device?.at, gpu: res.device?.renderer, scr: res.device?.screen, dpr: res.dpr, out: res.out, q: res.quality, msaa: res.msaa, preset: res.preset ?? res.device?.preset,
    s: res.scales.map((x) => ({ k: x.scale, px: x.px, seg: Object.fromEntries(Object.entries(x.seg).map(([n, v]) => [n, [r1(v.p50), r1(v.p90), r1(v.cpuP50), r1(v.gpuP50), r1(v.updP50), ...(v.parts ? [v.parts] : [])]])) })),
    soak: res.soak ? { s: res.soak.seconds, f30: [r1(res.soak.first30.p50), r1(res.soak.first30.p90)], l30: [r1(res.soak.last30.p50), r1(res.soak.last30.p90), r1(res.soak.last30.gpuP50)], x: res.soak.throttle } : null,
    max: res.suggestMax, sus: res.suggestSustained ?? null, ua: res.ua };
}
async function sharePerf(o, say) {
  const res = o.perf; if (!res) return;
  const text = `One Take FPV perf · ${res.level || 'bando'} · ${res.device?.at || ''}\n${o.perfText || ''}\n\nperf-digest ${JSON.stringify(perfDigest(res))}`;
  const name = `onetake-perf-${(res.level || 'bando').replace(/[^\w-]/g, '')}-${(res.device?.at || '').replace(/[:.]/g, '-').slice(0, 19)}.json`;
  const runs = readHist(); if (!runs.some((x) => x.device?.at === res.device?.at)) runs.push(res);
  let file = null; try { file = new File([JSON.stringify({ format: 'onetake.perf/1', runs }, null, 1)], name, { type: 'application/json' }); } catch (e) { file = null; }
  try {
    if (navigator.share) {
      const withFile = file && navigator.canShare?.({ files: [file] }) ? { files: [file] } : {};
      await navigator.share({ title: 'One Take FPV perf', text, ...withFile });
      return;
    }
  } catch (e) { if (e?.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); say((o.perfText || '') + '\n\nCopied: paste it into a message.'); return; } catch (e) { /* no clipboard */ }
  const ta = document.createElement('textarea'); ta.value = text; ta.readOnly = true;
  ta.style.cssText = 'display:block;width:100%;height:9em;margin-top:8px;font:11px ui-monospace,Menlo,monospace;background:#111;color:#eee;border:1px solid #444';
  document.getElementById('perfProbe')?.appendChild(ta); ta.focus(); ta.select();
}
