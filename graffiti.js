// graffiti.js: the graffiti atlas, drawn in plain JS (round 5, P5: split out of world-bando.js so a module Worker can
// draw it off the main thread; perf #1). No three.js, no DOM: world-bando.js (placement, upload), graffiti-worker.js
// (the browser draws it here) and tools/export-world.mjs (graffiti.png) all import this one module, so every path
// produces the same pixels.
import { Raster2D } from './raster2d.js';

// the same generator as world-bando.js rng() / rng.js
export function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const GRAFFITI_SEED = 1402;

// [B] graffiti atlas: 4 x 16 cells of 512 x 256 (2048 x 4096). Pieces (3D block, 6-10 px black outline, gradient fill,
// highlights, arrows and flares), throw-ups (bubble letters), tag clusters and buffed patches; drips, overspray.
// Nothing should read as a computer font: every word is skewed (+-0.35 rad) with per-letter jitter, and the decal
// shader warps every piece by a 2-octave sine remap (+-6 atlas px) with its own phases, so a cell never repeats the
// same way twice (WP_FRAG.decalMap). Little glow; the palette is desaturated 25 %.
const CREWS = ['FCU', 'MSK', 'OX', 'SKEB', 'ZOMB', 'RISE', 'DOK', 'KAOS', 'VEX', 'NOPE', 'BANDO', 'GONZ', 'RAW', 'SEKT', 'MOHA', 'LUX', 'TWS', 'AOK', 'KEMS', 'ROEK', 'MUTE', 'HAZE', 'ODE', 'KRASH', 'BLUR', 'DRIP', 'NUKE', 'OMEN', 'REAX', 'UFO', 'SINE', 'BOLT',
  'SMASH', 'TOPS', 'WERK', 'JOKER', 'GRIME', 'DUST', 'ZEPH', 'KILO', 'SOKE', 'MERZ', 'TRAK', 'VOID', 'ASKE', 'CREW', 'RUST', 'HYPE', 'NEKO', 'DAZE', 'FLUX', 'GORE', 'BRAT', 'SNOW', 'KRYM', 'ZYKO', 'PAX', 'WOLF', 'LOST', 'RIOT', 'MAZE', 'QUAK', 'SPOK', 'ECHO'];
const desat = (hex, k) => { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255, l = 0.299 * r + 0.587 * g + 0.114 * b, m = (c) => Math.round(c + (l - c) * k); return `rgb(${m(r)},${m(g)},${m(b)})`; };
const GPAL = [['#e8327c', '#ffb3d4', '#7a0f3c'], ['#1fa6e6', '#bdeeff', '#0b3f6e'], ['#f5c518', '#fff1a6', '#8a5a00'], ['#2fbf71', '#c9f7dc', '#0d5b33'], ['#f2641e', '#ffd0b5', '#7d2a05'],
  ['#8e5cf0', '#e3d6ff', '#3a1d7a'], ['#c9ced6', '#ffffff', '#6b7079'], ['#d7263d', '#f7a072', '#5e0a14'], ['#0fb5ae', '#a6f0ea', '#05504d'], ['#c3e21b', '#f0ffb0', '#4f5e00']].map((p) => p.map((c) => desat(c, 0.25)));
export const GCOLS = 4, GROWS = 16, GCELLS = GCOLS * GROWS;
export const GTYPE = (k) => (k < 28 ? 'piece' : k < 44 ? 'throw' : k < 56 ? 'tags' : 'buff');
// [G4] drawn with raster2d.js (pure-JS Canvas2D subset, Hershey stroke fonts) into a plain RGBA array: the same pixels
// on every device, no 64 MB canvas kept alive, and node can write it as a PNG (tools/export-world.mjs, native #1.1).
// graffitiCells(R, out, flip) draws cell by cell into `out` (RGBA8 straight alpha, W x H), yielding after each cell;
// flip = rows bottom-up (texture order). graffitiPixels(R) -> {data, width, height} runs it to the end (node export).
export function graffitiPixels(R = rng(GRAFFITI_SEED), flip = false) {
  if (typeof R === 'number') R = rng(R);
  const data = new Uint8Array(GCOLS * 512 * GROWS * 256 * 4);
  for (const _ of graffitiCells(R, data, flip));
  return { data, width: GCOLS * 512, height: GROWS * 256 };
}
export function* graffitiCells(R, out, flip = false) {
  const W = GCOLS * 512, H = GROWS * 256;
  {
    const g = new Raster2D(512, 256);
    const fontB = (px) => `900 ${px | 0}px "Arial Rounded MT Bold", "Arial Black", Futura, "Helvetica Neue", "DejaVu Sans", sans-serif`;
    const fontT = (px) => `italic 700 ${px | 0}px "Marker Felt", Noteworthy, "Brush Script MT", "Snell Roundhand", "URW Chancery L", cursive`;
    const pick = (a) => a[Math.floor(R() * a.length)];
    const INK = '#0c0c0f';
    const layout = (word, size, maxW, font, skew = 0.35) => {
      g.font = font(size); const ws = [...word].map((ch) => g.measureText(ch).width * 0.86); let tot = ws.reduce((a, b) => a + b, 0);
      const k = Math.min(1, maxW / Math.max(1, tot)); g.font = font(size * k); tot *= k;
      let x = -tot / 2; const out = [...word].map((ch, i) => { const w = ws[i] * k, l = { ch, x: x + w / 2, y: (R() - 0.5) * size * k * 0.2, rot: (R() - 0.5) * 0.3, s: 0.9 + R() * 0.24 }; x += w; return l; });
      out.sz = size * k; out.sk = Math.tan((R() - 0.5) * 2 * skew); out.w = tot; return out;
    };
    const each = (L, fn) => L.forEach((l) => { g.save(); g.translate(l.x, l.y); g.transform(1, 0, L.sk, 1, 0, 0); g.rotate(l.rot); g.scale(l.s, l.s); fn(l.ch); g.restore(); });
    const drips = (col, n, x0, x1, y, w) => {
      g.strokeStyle = col; g.fillStyle = col;
      for (let i = 0; i < n; i++) { const x = x0 + R() * (x1 - x0), y0 = y + (R() - 0.5) * 24, len = 8 + R() * R() * 80; g.lineWidth = w * (0.6 + R() * 0.8);
        g.beginPath(); g.moveTo(x, y0); g.lineTo(x + (R() - 0.5) * 2, y0 + len); g.stroke(); g.beginPath(); g.arc(x, y0 + len, g.lineWidth * 0.75, 0, 6.283); g.fill(); }
    };
    // an arrow flying off the letters: curved tapered shaft + head, outlined like the letters
    const arrow = (x0, y0, ang, len, w, fill) => {
      const bend = (R() - 0.5) * 0.9, x1 = x0 + Math.cos(ang) * len, y1 = y0 + Math.sin(ang) * len;
      const qx = (x0 + x1) / 2 - Math.sin(ang) * len * bend, qy = (y0 + y1) / 2 + Math.cos(ang) * len * bend, ta = Math.atan2(y1 - qy, x1 - qx), hl = w * 2.1;
      const shaft = () => { g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(qx, qy, x1, y1); };
      const head = () => { g.beginPath(); g.moveTo(x1 + Math.cos(ta) * hl, y1 + Math.sin(ta) * hl); g.lineTo(x1 + Math.cos(ta + 2.3) * hl, y1 + Math.sin(ta + 2.3) * hl); g.lineTo(x1 + Math.cos(ta - 2.3) * hl, y1 + Math.sin(ta - 2.3) * hl); g.closePath(); };
      g.strokeStyle = INK; g.fillStyle = INK; g.lineWidth = w + 16; shaft(); g.stroke(); head(); g.lineWidth = 16; g.stroke(); g.fill();
      g.strokeStyle = fill; g.fillStyle = fill; g.lineWidth = w; shaft(); g.stroke(); head(); g.fill();
    };
    const flare = (x, y, s) => { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x - s, y); g.lineTo(x, y - 1.6); g.lineTo(x + s, y); g.lineTo(x, y + 1.6); g.moveTo(x, y - s); g.lineTo(x + 1.6, y); g.lineTo(x, y + s); g.lineTo(x - 1.6, y); g.fill(); };
    const piece = (word, pal, size, maxW) => {
      const [c1, c2, c3] = pal, L = layout(word, size, maxW, fontB), sz = L.sz;
      if (R() < 0.5) {                                                      // background cloud / bubbles
        g.save(); const bg = pick(GPAL)[R() < 0.5 ? 0 : 2]; g.fillStyle = bg; g.globalAlpha = 0.8; g.shadowColor = bg; g.shadowBlur = 3;
        for (let i = 0; i < 9; i++) { g.beginPath(); g.ellipse((R() - 0.5) * maxW, (R() - 0.5) * 70, 40 + R() * 60, 30 + R() * 40, 0, 0, 6.283); g.fill(); }
        g.restore();
      }
      for (let a = 0, na = R() < 0.75 ? 1 + Math.floor(R() * 2) : 0; a < na; a++) {   // arrows off the first / last letter
        const l = a ? L[0] : L[L.length - 1], dir = a ? Math.PI + (R() - 0.5) * 1.2 : (R() - 0.7) * 1.4;
        arrow(l.x, l.y - sz * 0.1, dir, sz * (0.55 + R() * 0.4), 10 + R() * 8, R() < 0.6 ? c1 : c2);
      }
      const dk = R() < 0.5 ? '#141418' : c3;
      each(L, (ch) => { g.fillStyle = dk; g.strokeStyle = dk; g.lineWidth = 22; for (let d = 12; d > 0; d -= 4) { g.strokeText(ch, d, d); g.fillText(ch, d, d); } });
      const ow = 7 + 2 * (6 + R() * 4);                                      // outline: 6-10 px outside the fill's 7 px stroke
      each(L, (ch) => { g.lineWidth = ow; g.strokeStyle = INK; g.strokeText(ch, 0, 0); });
      each(L, (ch) => {
        const gr = g.createLinearGradient(0, -sz * 0.4, 0, sz * 0.4); gr.addColorStop(0, c2); gr.addColorStop(0.45, c1); gr.addColorStop(1, R() < 0.5 ? c1 : c3);
        g.shadowColor = c1; g.shadowBlur = 3; g.fillStyle = gr; g.strokeStyle = gr; g.lineWidth = 7; g.strokeText(ch, 0, 0); g.fillText(ch, 0, 0); g.shadowBlur = 0;
      });
      each(L, (ch) => { g.save(); g.beginPath(); g.rect(-sz, -sz, 2 * sz, sz * 0.75); g.clip(); g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.8)'; g.strokeText(ch, -3, -4); g.restore(); });
      drips(c1, 4 + Math.floor(R() * 7), -maxW / 2, maxW / 2, sz * 0.3, 4);
      for (let i = 0; i < 4; i++) flare((R() - 0.5) * maxW, (R() - 0.5) * sz * 0.6, 5 + R() * 9);
    };
    const throwUp = (word, size, maxW) => {
      const fill = pick(['#efefeb', '#d9dde2', '#efefeb', desat('#ffd23f', 0.25), desat('#ff5fa2', 0.25), desat('#64d2ff', 0.25)]), line = R() < 0.8 ? '#101014' : pick(GPAL)[2];
      const L = layout(word.slice(0, 2 + Math.floor(R() * 3)), size, maxW, fontB);
      each(L, (ch) => { g.lineWidth = 24 + 2 * (6 + R() * 4); g.strokeStyle = line; g.strokeText(ch, 0, 0); });
      each(L, (ch) => { g.shadowColor = fill; g.shadowBlur = 3; g.lineWidth = 24; g.strokeStyle = fill; g.fillStyle = fill; g.strokeText(ch, 0, 0); g.fillText(ch, 0, 0); g.shadowBlur = 0; });
      g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(40,40,40,0.2)';     // patchy one-coat fill
      for (let i = 0; i < 16; i++) { g.beginPath(); g.ellipse((R() - 0.5) * maxW, (R() - 0.5) * 90, 10 + R() * 30, 6 + R() * 16, R() * 3, 0, 6.283); g.fill(); }
      g.globalCompositeOperation = 'source-over';
      if (R() < 0.4) arrow(L[L.length - 1].x + L.sz * 0.3, 0, (R() - 0.6) * 1.2, L.sz * 0.6, 12, fill);
      drips(fill, 3 + Math.floor(R() * 6), -maxW / 2, maxW / 2, size * 0.35, 3);
    };
    const tags = (n, spread) => {
      for (let i = 0; i < n; i++) {
        g.save(); g.translate((R() - 0.5) * spread, (R() - 0.5) * 150); g.rotate((R() - 0.5) * 0.6);
        const word = pick(CREWS), col = pick(['#111', '#111', '#111', '#c8ccd2', '#e5e5e5', desat('#d7263d', 0.25), desat('#1f6fe6', 0.25), desat('#f2641e', 0.25), desat('#2fbf71', 0.25)]);
        const L = layout(R() < 0.6 ? word.toLowerCase() : word, 64 + R() * 50, 150 + R() * 140, fontT, 0.45);
        const stroke = R() < 0.5, lw = 4 + R() * 3;
        each(L, (ch) => { g.lineWidth = lw; g.strokeStyle = col; g.fillStyle = col; if (stroke) g.strokeText(ch, 0, 0); else g.fillText(ch, 0, 0); });
        if (R() < 0.5) { g.lineWidth = 3; g.strokeStyle = col; g.beginPath(); g.moveTo(-90, 40); g.quadraticCurveTo(0, 60 + R() * 20, 110, 28); g.stroke(); }
        if (R() < 0.4) drips(col, 2 + Math.floor(R() * 3), -60, 60, 25, 2);
        g.restore();
      }
    };
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineCap = 'round';
    for (let k = 0; k < GCELLS; k++) {
      const type = GTYPE(k), word = CREWS[k % CREWS.length];
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 512, 256);
      g.save(); g.beginPath(); g.rect(10, 10, 492, 236); g.clip(); g.translate(256, 126);
      if (type === 'piece') { if (R() < 0.35) { g.save(); g.globalAlpha = 0.7; tags(3, 430); g.restore(); } piece(word, pick(GPAL), 150, 420); }
      else if (type === 'throw') throwUp(word, 165, 410);
      else if (type === 'tags') tags(4 + Math.floor(R() * 4), 370);
      else {
        g.save(); g.globalAlpha = 0.8; piece(word, pick(GPAL), 140, 410); g.restore();
        g.fillStyle = pick(['#8d8a82', '#a39c8c', '#77756f', '#9a948a']); g.globalAlpha = 0.95;
        const bw = 200 + R() * 220, bh = 120 + R() * 90, bx = (R() - 0.5) * (430 - bw);
        for (let i = 0; i < 6; i++) g.fillRect(bx - bw / 2 + (R() - 0.5) * 14, -bh / 2 + (R() - 0.5) * 14, bw, bh);
        g.globalAlpha = 1; tags(1 + Math.floor(R() * 2), 300);
      }
      g.restore();
      g.copyTo(out, W, (k % GCOLS) * 512, Math.floor(k / GCOLS) * 256, flip, H);
      yield k;
    }
  }
}
