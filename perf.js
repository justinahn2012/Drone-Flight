// perf.js — the ?perf frame-time probe (round-3 perf/native review #2.1): real timings from Justin's phone.
// Open the game with ?perf (?perf=60 for a quicker run). The game's own rAF loop stays off (main.js). The world
// loads, then you tap RUN while holding the phone the way you fly. The probe then:
//   - flies a fixed cruise (spawn, 1.6 m up, 5 m/s toward the site, Cine) with the resolution governor frozen,
//   - per scale (1.0, then 1.2): 30 warm-up frames, then N timed frames (default 120), one per rAF,
//   - times each frame as main.js frame() + a 1-pixel readPixels from the canvas. The readPixels waits until the
//     GPU has finished the frame, so a sample = CPU + GPU work, serialised (an upper bound: the live game overlaps them),
//   - shows p50 / p90 / mean (the mean is exact even under Safari's 1 ms timer) and the CPU-only p50 in its own
//     overlay. Results are also on window.__onetake.perf and in the console as "perf {json}".
// A scale "fits 60 Hz" when its p90 is under 14.2 ms (16.7 ms minus 15 % headroom). Use that to set QUALITY.auto.max.
const SCALES = [1.0, 1.2], WARM = 30, BUDGET = 14.2;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f1 = (v) => v.toFixed(1);
const raf = () => new Promise((r) => requestAnimationFrame(r));

export function perfProbe(o, frames = 120) {
  const box = document.createElement('div');
  box.id = 'perfProbe';
  box.style.cssText = 'position:fixed;left:8px;right:8px;top:calc(8px + env(safe-area-inset-top));z-index:99999;padding:10px 12px;' +
    'background:rgba(8,9,11,0.88);color:#f2f2ee;font:15px/1.45 ui-monospace,Menlo,monospace;border-radius:8px;white-space:pre-wrap;pointer-events:auto';
  const txt = document.createElement('div'), btn = document.createElement('button');
  btn.style.cssText = 'margin-top:8px;font:600 16px ui-monospace,Menlo,monospace;padding:10px 18px;border-radius:6px;border:0;background:#C9450C;color:#fff;display:none';
  for (const ev of ['touchstart', 'mousedown', 'pointerdown']) btn.addEventListener(ev, (e) => e.stopPropagation());
  box.append(txt, btn); document.body.appendChild(box);
  const say = (s) => { txt.textContent = s; };

  const run = async () => {
    btn.style.display = 'none';
    const fpv = o.fpv, r = o.renderer, gl = r.getContext(), px = new Uint8Array(4), S = o.S;
    const sync = () => { r.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    const saved = { mode: S.mode, fps: S.fps };
    S.mode = 'cine'; S.fps = '60'; o.applySettings();
    if (fpv.maxScale < Math.max(...SCALES)) fpv.setQualityRange(fpv.minScale, Math.max(...SCALES));   // targets big enough for 1.2
    fpv.frameTiming = () => {};                                                                        // governor frozen (own-property shadow)
    const res = { frames, scales: [], out: [fpv.outW, fpv.outH], dpr: devicePixelRatio, quality: S.quality, msaa: fpv.samples | 0, ua: navigator.userAgent };
    try {
      for (const s of SCALES) {
        o.tp(0, 1.6, 118, 0, 4 - o.drone.c.camTilt);
        const tot = [], cpu = [];
        for (let i = 0; i < WARM + frames; i++) {
          await raf();
          fpv.scale = s; o.drone.vel.set(0, 0, -5);
          const t0 = performance.now();
          o.step(1000 / 60, 1, false);
          const t1 = performance.now();
          sync();
          const t2 = performance.now();
          if (i >= WARM) { tot.push(t2 - t0); cpu.push(t1 - t0); }
          if (i % 10 === 0) say(`PERF · scale ${s.toFixed(1)} · ${i < WARM ? 'warm-up' : `frame ${i - WARM}/${frames}`}`);
        }
        const mean = tot.reduce((a, b) => a + b, 0) / tot.length;
        res.scales.push({ scale: s, px: [Math.round(fpv.outW * s), Math.round(fpv.outH * s)], p50: q(tot, 0.5), p90: q(tot, 0.9), mean, cpuP50: q(cpu, 0.5), max: Math.max(...tot) });
      }
    } finally {
      delete fpv.frameTiming;
      S.mode = saved.mode; S.fps = saved.fps; o.applySettings();
    }
    const fits = res.scales.filter((x) => x.p90 <= BUDGET).map((x) => x.scale);
    res.suggestMax = fits.length ? Math.max(...fits) : null;
    o.perf = res;
    console.info('perf ' + JSON.stringify(res));
    say(['PERF · ms per frame (CPU+GPU, synced)', ...res.scales.map((x) => `${x.scale.toFixed(1)}×  ${x.px[0]}×${x.px[1]}\n  p50 ${f1(x.p50)}  p90 ${f1(x.p90)}  mean ${f1(x.mean)}  cpu ${f1(x.cpuP50)}  ${x.p90 <= BUDGET ? 'fits 60 Hz' : 'over budget'}`),
      `out ${res.out[0]}×${res.out[1]} · dpr ${res.dpr} · ${res.quality} · msaa ${res.msaa}`,
      `suggested auto max: ${res.suggestMax ?? '< 1.0'}  (p90 ≤ ${BUDGET} ms)`, 'Screenshot this. Reload without ?perf to fly.'].join('\n'));
    btn.textContent = 'RUN AGAIN'; btn.style.display = '';
  };
  btn.onclick = run;

  say('PERF · loading the world…');
  (async () => {
    await o.startFlight(true);
    while (o.state !== 'fly' && o.state !== 'crash') await new Promise((r) => setTimeout(r, 250));
    o.step(1000 / 60, 1, false);
    say(`PERF · ready. Hold the phone the way you fly, then tap RUN.\n${SCALES.length} × (${WARM} + ${frames}) frames, about ${Math.ceil(SCALES.length * (WARM + frames) / 40)} s.`);
    btn.textContent = 'RUN'; btn.style.display = '';
  })().catch((e) => say('PERF · failed: ' + (e?.message || e)));
}
