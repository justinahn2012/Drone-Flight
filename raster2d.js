// raster2d.js — a small software Canvas2D (pure JS, no DOM) so procedural textures come out as plain RGBA arrays:
// identical pixels in Safari, Chrome and node, and node can write them as PNGs (native #1.1). It covers the subset the
// graffiti atlas (world-bando.js graffitiAtlas) draws with:
//   state: save/restore, setTransform/translate/rotate/scale/transform, fillStyle/strokeStyle (CSS #rgb, #rrggbb,
//          rgb(), rgba() or a linear gradient), lineWidth (joins and caps are always round), globalAlpha,
//          globalCompositeOperation 'source-over' | 'source-atop', shadowColor + shadowBlur (no offset), font,
//          textAlign / textBaseline (always centred), clip() (nonzero, intersected)
//   paths: beginPath, moveTo, lineTo, quadraticCurveTo, arc, ellipse, rect, closePath, fill() (nonzero), stroke()
//   text:  fillText, strokeText, measureText. Glyphs are Hershey stroke fonts drawn with a round pen: Roman Simplex
//          for heavy weights (bubble letters) and Script Simplex for italic / cursive faces. No system fonts are used,
//          so text looks the same on every platform.
//   pixels: clearRect, fillRect, copyTo(dst RGBA8, dstW, x, y, flipRows) (straight alpha, sRGB bytes)
// Rasteriser: nonzero scanline fill with 4 sub-scanlines and exact horizontal span coverage. Strokes are unions of
// round-capped capsules, which a nonzero fill merges. A strokeText on its own is a ring (outer pen minus inner pen),
// as in Canvas2D. Pixels are float premultiplied RGBA internally.
//
// Hershey font data (A-Z, a-z of futural.jhf and scripts.jhf), converted. Acknowledgements as its licence requires:
//  - The Hershey Fonts were originally created by Dr. A. V. Hershey while working at the U. S. National Bureau of
//    Standards.
//  - The format of the Font data in this distribution was originally created by James Hurt, Cognition, Inc.,
//    900 Technology Park Drive, Billerica, MA 01821 (mit-eddie!ci-dandelion!hurt).

const GLYPHS = {
  futural: "I[RFJ[ RRFZ[ RMTWT\nG\\KFK[ RKFTFWGXHYJYLXNWOTP RKPTPWQXRYTYWXYWZT[K[\nH]ZKYIWGUFQFOGMILKKNKSLVMXOZQ[U[WZYXZV\nG\\KFK[ RKFRFUGWIXKYNYSXVWXUZR[K[\nH[LFL[ RLFYF RLPTP RL[Y[\nHZLFL[ RLFYF RLPTP\nH]ZKYIWGUFQFOGMILKKNKSLVMXOZQ[U[WZYXZVZS RUSZS\nG]KFK[ RYFY[ RKPYP\nNVRFR[\nJZVFVVUYTZR[P[NZMYLVLT\nG\\KFK[ RYFKT RPOY[\nHYLFL[ RL[X[\nF^JFJ[ RJFR[ RZFR[ RZFZ[\nG]KFK[ RKFY[ RYFY[\nG]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF\nG\\KFK[ RKFTFWGXHYJYMXOWPTQKQ\nG]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF RSWY]\nG\\KFK[ RKFTFWGXHYJYLXNWOTPKP RRPY[\nH\\YIWGTFPFMGKIKKLMMNOOUQWRXSYUYXWZT[P[MZKX\nJZRFR[ RKFYF\nG]KFKULXNZQ[S[VZXXYUYF\nI[JFR[ RZFR[\nF^HFM[ RRFM[ RRFW[ R\\FW[\nH\\KFY[ RYFK[\nI[JFRPR[ RZFRP\nH\\YFK[ RKFYF RK[Y[\nI\\XMX[ RXPVNTMQMONMPLSLUMXOZQ[T[VZXX\nH[LFL[ RLPNNPMSMUNWPXSXUWXUZS[P[NZLX\nI[XPVNTMQMONMPLSLUMXOZQ[T[VZXX\nI\\XFX[ RXPVNTMQMONMPLSLUMXOZQ[T[VZXX\nI[LSXSXQWOVNTMQMONMPLSLUMXOZQ[T[VZXX\nMYWFUFSGRJR[ ROMVM\nI\\XMX]W`VaTbQbOa RXPVNTMQMONMPLSLUMXOZQ[T[VZXX\nI\\MFM[ RMQPNRMUMWNXQX[\nNVQFRGSFREQF RRMR[\nMWRFSGTFSERF RSMS^RaPbNb\nIZMFM[ RWMMW RQSX[\nNVRFR[\nCaGMG[ RGQJNLMOMQNRQR[ RRQUNWMZM\\N]Q][\nI\\MMM[ RMQPNRMUMWNXQX[\nI\\QMONMPLSLUMXOZQ[T[VZXXYUYSXPVNTMQM\nH[LMLb RLPNNPMSMUNWPXSXUWXUZS[P[NZLX\nI\\XMXb RXPVNTMQMONMPLSLUMXOZQ[T[VZXX\nKXOMO[ ROSPPRNTMWM\nJ[XPWNTMQMNNMPNRPSUTWUXWXXWZT[Q[NZMX\nMYRFRWSZU[W[ ROMVM\nI\\MMMWNZP[S[UZXW RXMX[\nJZLMR[ RXMR[\nG]JMN[ RRMN[ RRMV[ RZMV[\nJ[MMX[ RXMM[\nJZLMR[ RXMR[P_NaLbKb\nJ[XMM[ RMMXM RM[X[\n",
  scripts: "G[G[IZLWOSSLVFV[UXSUQSNQLQKRKTLVNXQZT[Y[\nF]SHTITLSPRSQUOXMZK[J[IZIWJRKOLMNJPHRGUFXFZG[I[KZMYNWOTP RSPTPWQXRYTYWXYWZU[R[PZOX\nH\\TLTMUNWNYMZKZIYGWFTFQGOIMLLNKRKVLYMZO[Q[TZVXWV\nG^TFRGQIPMOSNVMXKZI[G[FZFXGWIWKXMZP[S[VZXXZT[O[KZHYGWFTFRHRJSMUPWRZT\\U\nH\\VJVKWLYLZKZIYGVFRFOGNINLONPOSPPPMQLRKTKWLYMZP[S[VZXXYV\nH\\RLPLNKMINGQFTFXG[G]F RXGVNTTRXPZN[L[JZIXIVJULUNV RQPZP\nG^G[IZMVPQQNRJRGQFPFOGNINLONQOUOXNYMZKZQYVXXVZS[O[LZJXIVIT\nF^MMKLJJJIKGMFNFPGQIQKPONULYJ[H[GZGX RMRVOXN[L]J^H^G]F\\FZHXLVRUWUZV[W[YZZY\\V\nIZWVUTSQROQLQIRGSFUFVGWIWLVQTVSXQZO[M[KZJXJVKUMUOV\nJYT^R[PVOPOJPGRFTFUGVJVMURR[PaOdNfLgKfKdLaN^P\\SZWX\nF^MMKLJJJIKGMFNFPGQIQKPONULYJ[H[GZGX R^I^G]F\\FZGXIVLTNROPO RROSQSXTZU[V[XZYY[V\nI\\MRORSQVOXMYKYHXFVFUGTISNRSQVPXNZL[J[IZIXJWLWNXQZT[V[YZ[X\n@aEMCLBJBICGEFFFHGIIIKHPGTE[ RGTJLLHMGOFPFRGSISKRPQTO[ RQTTLVHWGYFZF\\G]I]K\\PZWZZ[[\\[^Z_YaV\nE]JMHLGJGIHGJFKFMGNINKMPLTJ[ RLTOLQHRGTFVFXGYIYKXPVWVZW[X[ZZ[Y]V\nH]TFQGOIMLLNKRKVLYMZO[Q[TZVXXUYSZOZKYHXGVFTFRHRKSNUQWSZU\\V\nF_SHTITLSPRSQUOXMZK[J[IZIWJRKOLMNJPHRGUFZF\\G]H^J^M]O\\PZQWQUPTO\nH^ULTNSOQPOPNNNLOIQGTFWFYGZIZMYPWSSWPYNZK[I[HZHXIWKWMXPZS[V[YZ[X\nF_SHTITLSPRSQUOXMZK[J[IZIWJRKOLMNJPHRGUFYF[G\\H]J]M\\O[PYQVQSPTQUSUXVZX[ZZ[Y]V\nH\\H[JZLXOTQQSMTJTGSFRFQGPIPKQMSOVQXSYUYWXYWZT[P[MZKXJVJT\nH[RLPLNKMINGQFTFXG[G]F RXGVNTTRXPZN[L[JZIXIVJULUNV\nE]JMHLGJGIHGJFKFMGNINKMOLRKVKXLZN[P[RZSYUUXMZF RXMWQVWVZW[X[ZZ[Y]V\nF]KMILHJHIIGKFLFNGOIOKNOMRLVLYM[O[QZTWVTXPYMZIZGYFXFWGVIVKWNYP[Q\nC_HMFLEJEIFGHFIFKGLILLK[ RUFK[ RUFS[ RaF_G\\JYNVTS[\nF^NLLLKKKILGNFPFRGSISLQUQXRZT[V[XZYXYVXUVU R]I]G\\FZFXGVITLPUNXLZJ[H[GZGX\nF]KMILHJHIIGKFLFNGOIOKNOMRLVLXMZN[P[RZTXVUWSYM R[FYMVWT]RbPfNgMfMdNaP^S[VY[V\nH]ULTNSOQPOPNNNLOIQGTFWFYGZIZMYPWTTWPZN[K[JZJXKWNWPXQYR[R^QaPcNfLgKfKdLaN^Q[TYZV\nL\\UUTSRRPRNSMTLVLXMZO[Q[SZTXVRUWUZV[W[YZZY\\V\nM[MVOSRNSLTITGSFQGPIOMNTNZO[P[RZTXUUURVVWWYW[V\nMXTTTSSRQROSNTMVMXNZP[S[VYXV\nL\\UUTSRRPRNSMTLVLXMZO[Q[SZTXZF RVRUWUZV[W[YZZY\\V\nNXOYQXRWSUSSRRQROSNUNXOZQ[S[UZVYXV\nOWOVSQUNVLWIWGVFTGSIQQNZKaJdJfKgMfNcOZP[R[TZUYWV\nL[UUTSRRPRNSMTLVLXMZO[Q[SZTY RVRTYPdOfMgLfLdMaP^S\\U[XY[V\nM\\MVOSRNSLTITGSFQGPIOMNSM[ RM[NXOVQSSRURVSVUUXUZV[W[YZZY\\V\nPWSMSNTNTMSM RPVRRPXPZQ[R[TZUYWV\nPWSMSNTNTMSM RPVRRLdKfIgHfHdIaL^O\\Q[TYWV\nM[MVOSRNSLTITGSFQGPIOMNSM[ RM[NXOVQSSRURVSVUTVQV RQVSWTZU[V[XZYY[V\nOWOVQSTNULVIVGUFSGRIQMPTPZQ[R[TZUYWV\nE^EVGSIRJSJTIXH[ RIXJVLSNRPRQSQTPXO[ RPXQVSSURWRXSXUWXWZX[Y[[Z\\Y^V\nJ\\JVLSNROSOTNXM[ RNXOVQSSRURVSVUUXUZV[W[YZZY\\V\nLZRRPRNSMTLVLXMZO[Q[SZTYUWUUTSRRQSQURWTXWXYWZV\nKZKVMSNQMUGg RMUNSPRRRTSUUUWTYSZQ[ RMZO[R[UZWYZV\nL[UUTSRRPRNSMTLVLXMZO[Q[SZ RVRUUSZPaOdOfPgRfScS\\U[XY[V\nMZMVOSPQPSSSTTTVSYSZT[U[WZXYZV\nNYNVPSQQQSSVTXTZR[ RNZP[T[VZWYYV\nOXOVQSSO RVFPXPZQ[S[UZVYXV RPNWN\nL[LVNRLXLZM[O[QZSXUU RVRTXTZU[V[XZYY[V\nL[LVNRMWMZN[O[RZTXUUUR RURVVWWYW[V\nI^LRJTIWIYJ[L[NZPX RRRPXPZQ[S[UZWXXUXR RXRYVZW\\W^V\nJZJVLSNRPRQSQZR[U[XYZV RWSVRTRSSOZN[L[KZ\nL[LVNRLXLZM[O[QZSXUU RVRPdOfMgLfLdMaP^S\\U[XY[V\nLZLVNSPRRRTTTVSXQZN[P\\Q^QaPdOfMgLfLdMaP^S\\WYZV\n",
};
const SUB = 4;                       // sub-scanlines per pixel row

// ---------------------------------------------------------------- fonts
const FONTS = {};
function font(name) {
  if (FONTS[name]) return FONTS[name];
  const lines = GLYPHS[name].split('\n'), map = {};
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < chars.length; i++) {
    const s = lines[i], v = (k) => s.charCodeAt(k) - 82;
    const strokes = []; let cur = null;
    for (let k = 2; k < s.length; k += 2) {
      if (s[k] === ' ' && s[k + 1] === 'R') { cur = null; continue; }
      if (!cur) strokes.push(cur = []);
      cur.push(v(k), v(k + 1));
    }
    map[chars[i]] = { l: v(0), r: v(1), strokes };
  }
  return (FONTS[name] = map);
}
// CSS font -> {face, px, pen (fraction of px), slant}
function parseFont(css) {
  const px = +(/([\d.]+)px/.exec(css)?.[1] || 10), italic = /italic|oblique/.test(css), w = +(/\b([1-9]00)\b/.exec(css)?.[1] || 400);
  const script = /cursive|Marker|Brush|Script|Chancery|Noteworthy/i.test(css);
  return { face: script ? 'scripts' : 'futural', px, pen: script ? 0.03 + w / 18000 : 0.05 + w / 6000, slant: italic ? 0.21 : 0 };
}
const UNIT = 0.034;                  // px per Hershey unit at 1 px font size (caps 21 units = 0.71 em)

// ---------------------------------------------------------------- colours
function parseColor(c) {
  if (typeof c !== 'string') return [0, 0, 0, 1];
  c = c.trim();
  if (c[0] === '#') {
    const h = c.slice(1), x = h.length === 3 ? h.split('').map((d) => d + d).join('') : h, n = parseInt(x.slice(0, 6), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, x.length === 8 ? parseInt(x.slice(6), 16) / 255 : 1];
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) { const p = m[1].split(',').map(Number); return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1]; }
  if (c === 'white') return [1, 1, 1, 1];
  return [0, 0, 0, 1];
}
class LinearGradient {
  constructor(x0, y0, x1, y1) { this.p = [x0, y0, x1, y1]; this.stops = []; this.lut = null; }
  addColorStop(o, c) { this.stops.push([o, parseColor(c)]); this.stops.sort((a, b) => a[0] - b[0]); this.lut = null; }
  table() {           // 256 premultiplied entries
    if (this.lut) return this.lut;
    const L = new Float32Array(256 * 4), S = this.stops;
    for (let i = 0; i < 256; i++) {
      const t = i / 255; let a = S[0], b = S[S.length - 1];
      for (let k = 0; k < S.length - 1; k++) if (t >= S[k][0] && t <= S[k + 1][0]) { a = S[k]; b = S[k + 1]; break; }
      const f = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : (t < a[0] ? 0 : 1), c = [0, 0, 0, 0];
      for (let j = 0; j < 4; j++) c[j] = a[1][j] * a[1][3] * (1 - f) + b[1][j] * b[1][3] * f;
      c[3] = a[1][3] * (1 - f) + b[1][3] * f;
      L.set(c, i * 4);
    }
    return (this.lut = L);
  }
}

// ---------------------------------------------------------------- the context
export class Raster2D {
  constructor(w, h) {
    this.width = w; this.height = h;
    this.px = new Float32Array(w * h * 4);
    this._masks = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
    this._cov = new Float32Array(w + 2); this._del = new Float32Array(w + 2);
    this._st = { m: [1, 0, 0, 1, 0, 0], fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over',
      shadowColor: 'rgba(0,0,0,0)', shadowBlur: 0, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', lineJoin: 'miter', lineCap: 'butt', clip: null };
    this._stack = []; this._path = []; this._sub = null;
    for (const k of Object.keys(this._st)) if (k !== 'm' && k !== 'clip') Object.defineProperty(this, k, { get: () => this._st[k], set: (v) => { this._st[k] = v; }, enumerable: true });
  }
  // state
  save() { this._stack.push({ ...this._st, m: this._st.m.slice() }); }
  restore() { if (this._stack.length) this._st = this._stack.pop(); }
  setTransform(a, b, c, d, e, f) { this._st.m = [a, b, c, d, e, f]; }
  transform(a, b, c, d, e, f) {
    const [A, B, C, D, E, F] = this._st.m;
    this._st.m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
  }
  translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
  scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }
  rotate(a) { const c = Math.cos(a), s = Math.sin(a); this.transform(c, s, -s, c, 0, 0); }
  createLinearGradient(x0, y0, x1, y1) { return new LinearGradient(x0, y0, x1, y1); }
  measureText(s) { const F = parseFont(this._st.font), G = font(F.face); let w = 0; for (const ch of String(s)) w += this._adv(G[ch], F); return { width: w }; }
  _adv(g, F) { return g ? (g.r - g.l) * UNIT * F.px + F.pen * F.px * 0.5 : F.px * 0.35; }

  // paths (points stored in device space, as Canvas2D does)
  _dev(x, y) { const m = this._st.m; return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  _scaleOf() { const m = this._st.m; return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1; }
  beginPath() { this._path = []; this._sub = null; }
  moveTo(x, y) { this._sub = { pts: this._dev(x, y), closed: false }; this._path.push(this._sub); }
  lineTo(x, y) { if (!this._sub) return this.moveTo(x, y); this._sub.pts.push(...this._dev(x, y)); }
  closePath() { if (this._sub) { this._sub.closed = true; const p = this._sub.pts; this._sub = { pts: [p[0], p[1]], closed: false }; this._path.push(this._sub); } }
  quadraticCurveTo(cx, cy, x, y) {
    if (!this._sub) this.moveTo(cx, cy);
    const p = this._sub.pts, x0 = p[p.length - 2], y0 = p[p.length - 1], [qx, qy] = this._dev(cx, cy), [x1, y1] = this._dev(x, y);
    const n = Math.max(4, Math.min(64, Math.ceil((Math.hypot(qx - x0, qy - y0) + Math.hypot(x1 - qx, y1 - qy)) / 4)));
    for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; p.push(u * u * x0 + 2 * u * t * qx + t * t * x1, u * u * y0 + 2 * u * t * qy + t * t * y1); }
  }
  ellipse(x, y, rx, ry, rot, a0, a1, ccw = false) {
    let sweep = a1 - a0;
    if (!ccw && sweep < 0) sweep = sweep % (2 * Math.PI) + 2 * Math.PI; if (ccw && sweep > 0) sweep = sweep % (2 * Math.PI) - 2 * Math.PI;
    if (Math.abs(a1 - a0) >= 2 * Math.PI) sweep = ccw ? -2 * Math.PI : 2 * Math.PI;
    const r = Math.max(rx, ry) * this._scaleOf(), n = Math.max(8, Math.min(96, Math.ceil((r * 0.7 + 8) * Math.abs(sweep) / (2 * Math.PI))));
    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (let i = 0; i <= n; i++) {
      const a = a0 + sweep * i / n, ex = Math.cos(a) * rx, ey = Math.sin(a) * ry, px = x + ex * cr - ey * sr, py = y + ex * sr + ey * cr;
      if (i === 0) { if (this._sub) this.lineTo(px, py); else this.moveTo(px, py); } else this.lineTo(px, py);
    }
  }
  arc(x, y, r, a0, a1, ccw) { this.ellipse(x, y, r, r, 0, a0, a1, ccw); }
  rect(x, y, w, h) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); }
  _fillPolys() { return this._path.filter((s) => s.pts.length >= 6).map((s) => s.pts); }

  fill() { this._paint(this._cover(this._fillPolys(), 0), this._st.fillStyle); }
  stroke() {
    // pen built in the current user space (the CTM is the one the path was made under in all callers)
    const inv = this._inv(), polys = [], r = this._st.lineWidth / 2;
    for (const s of this._path) {
      const u = []; for (let i = 0; i < s.pts.length; i += 2) u.push(...this._apply(inv, s.pts[i], s.pts[i + 1]));
      if (s.closed && u.length >= 4) u.push(u[0], u[1]);
      this._capsules(u, r, polys);
    }
    this._paint(this._cover(polys, 0), this._st.strokeStyle);
  }
  clip() {
    const c = this._cover(this._fillPolys(), 2), old = this._st.clip, out = new Float32Array(this.width * this.height);
    for (let y = c.y0; y < c.y1; y++) for (let i = y * this.width + c.x0, e = y * this.width + c.x1; i < e; i++) out[i] = old ? c.m[i] * old[i] : c.m[i];
    this._clearMask(c);
    this._st.clip = out;
  }
  fillRect(x, y, w, h) { const keep = this._path; this.beginPath(); this.rect(x, y, w, h); this.fill(); this._path = keep; }
  clearRect(x, y, w, h) {
    const [ax, ay] = this._dev(x, y), [bx, by] = this._dev(x + w, y + h), W = this.width;
    const x0 = Math.max(0, Math.round(Math.min(ax, bx))), x1 = Math.min(W, Math.round(Math.max(ax, bx))), y0 = Math.max(0, Math.round(Math.min(ay, by))), y1 = Math.min(this.height, Math.round(Math.max(ay, by)));
    for (let yy = y0; yy < y1; yy++) this.px.fill(0, (yy * W + x0) * 4, (yy * W + x1) * 4);
  }

  // text: one glyph run, centred on (x, y)
  _glyphPolys(s, x, y, rad) {
    const F = parseFont(this._st.font), G = font(F.face), u = UNIT * F.px, out = [];
    let w = 0; for (const ch of String(s)) w += this._adv(G[ch], F);
    let cx = x - w / 2;
    for (const ch of String(s)) {
      const g = G[ch], adv = this._adv(g, F);
      if (g) for (const st of g.strokes) {
        const p = [];
        for (let k = 0; k < st.length; k += 2) { const gy = (st[k + 1] + 1.5) * u; p.push(cx + adv / 2 + (st[k] - (g.l + g.r) / 2) * u - F.slant * gy, y + gy); }
        this._capsules(p, rad, out);
      }
      cx += adv;
    }
    return { out, pen: F.pen * F.px };
  }
  fillText(s, x, y) { const pen = parseFont(this._st.font).pen * parseFont(this._st.font).px; this._paint(this._cover(this._glyphPolys(s, x, y, pen / 2).out, 0), this._st.fillStyle); }
  strokeText(s, x, y) {
    const F = parseFont(this._st.font), pen = F.pen * F.px, L = this._st.lineWidth;
    const outer = this._cover(this._glyphPolys(s, x, y, pen / 2 + L / 2).out, 0);
    const ri = pen / 2 - L / 2;
    if (ri > 0.25) {                                    // a ring: Canvas2D strokes the glyph outline, it doesn't fill it
      const inner = this._cover(this._glyphPolys(s, x, y, ri).out, 1);
      for (let yy = inner.y0; yy < inner.y1; yy++) for (let i = yy * this.width + inner.x0, e = yy * this.width + inner.x1; i < e; i++) outer.m[i] = Math.max(0, outer.m[i] - inner.m[i]);
      this._clearMask(inner);
    }
    this._paint(outer, this._st.strokeStyle);
  }

  // ---------------------------------------------------------------- geometry helpers
  _inv() { const [a, b, c, d, e, f] = this._st.m, det = a * d - b * c || 1e-12; return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]; }
  _apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  // round-capped capsules along a user-space polyline (radius r in user units), pushed as device-space polygons
  _capsules(p, r, out) {
    const m = this._st.m, sc = this._scaleOf(), n = Math.max(4, Math.min(24, Math.ceil(Math.sqrt(r * sc) * 2.2 + 2)));   // points per half circle (chord error < ~0.15 px)
    const push = (poly) => {
      let area = 0; for (let i = 0, L = poly.length; i < L; i += 2) { const j = (i + 2) % L; area += poly[i] * poly[j + 1] - poly[j] * poly[i + 1]; }
      if (area < 0) for (let i = 0, j = poly.length - 2; i < j; i += 2, j -= 2) { const tx = poly[i], ty = poly[i + 1]; poly[i] = poly[j]; poly[i + 1] = poly[j + 1]; poly[j] = tx; poly[j + 1] = ty; }
      out.push(poly);
    };
    const dev = (x, y, o) => { o.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]); };
    if (p.length === 2) { const o = []; for (let i = 0; i < 2 * n; i++) { const a = Math.PI * i / n; dev(p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r, o); } push(o); return; }
    for (let k = 0; k + 3 < p.length; k += 2) {
      const x0 = p[k], y0 = p[k + 1], x1 = p[k + 2], y1 = p[k + 3], a = Math.atan2(y1 - y0, x1 - x0), o = [];
      for (let i = 0; i <= n; i++) { const t = a - Math.PI / 2 + Math.PI * i / n; dev(x1 + Math.cos(t) * r, y1 + Math.sin(t) * r, o); }
      for (let i = 0; i <= n; i++) { const t = a + Math.PI / 2 + Math.PI * i / n; dev(x0 + Math.cos(t) * r, y0 + Math.sin(t) * r, o); }
      push(o);
    }
  }

  // ---------------------------------------------------------------- coverage (nonzero), into scratch mask `slot`
  _cover(polys, slot) {
    const W = this.width, H = this.height, M = this._masks[slot];
    let n = 0; for (const p of polys) n += p.length / 2;
    const ey0 = new Float32Array(n), ey1 = new Float32Array(n), ex = new Float32Array(n), dx = new Float32Array(n), dir = new Int8Array(n);
    let E = 0, bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (const p of polys) {
      const L = p.length;
      for (let i = 0; i < L; i += 2) {
        const xa = p[i], ya = p[i + 1], j = (i + 2) % L, xb = p[j], yb = p[j + 1];
        if (xa < bx0) bx0 = xa; if (xa > bx1) bx1 = xa; if (ya < by0) by0 = ya; if (ya > by1) by1 = ya;
        if (ya === yb) continue;
        const up = yb > ya, y0 = up ? ya : yb, y1 = up ? yb : ya, x0 = up ? xa : xb;
        ey0[E] = y0; ey1[E] = y1; dx[E] = (xb - xa) / (yb - ya); ex[E] = x0; dir[E] = up ? 1 : -1; E++;
      }
    }
    const res = { m: M, x0: Math.max(0, Math.floor(bx0)), x1: Math.min(W, Math.ceil(bx1) + 1), y0: Math.max(0, Math.floor(by0)), y1: Math.min(H, Math.ceil(by1) + 1) };
    if (!E || res.x0 >= res.x1 || res.y0 >= res.y1) { res.x1 = res.x0; res.y1 = res.y0; return res; }
    const order = Array.from({ length: E }, (_, i) => i).sort((a, b) => ey0[a] - ey0[b]);
    const act = [], xs = new Float64Array(E), ds = new Int8Array(E), cov = this._cov, del = this._del, w8 = 1 / SUB;
    let next = 0;
    for (let y = res.y0; y < res.y1; y++) {
      for (let s = 0; s < SUB; s++) {
        const yc = y + (s + 0.5) * w8;
        while (next < E && ey0[order[next]] <= yc) act.push(order[next++]);
        let k = 0;
        for (let i = 0; i < act.length; i++) {
          const e = act[i];
          if (ey1[e] <= yc) { act[i] = act[act.length - 1]; act.pop(); i--; continue; }
          if (ey0[e] > yc) continue;
          // insertion into the sorted crossing list
          const x = ex[e] + (yc - ey0[e]) * dx[e]; let j = k++;
          while (j > 0 && xs[j - 1] > x) { xs[j] = xs[j - 1]; ds[j] = ds[j - 1]; j--; }
          xs[j] = x; ds[j] = dir[e];
        }
        let wn = 0, xa = 0;
        for (let i = 0; i < k; i++) {
          const was = wn; wn += ds[i];
          if (was === 0 && wn !== 0) xa = xs[i];
          else if (was !== 0 && wn === 0) {
            let a = Math.max(res.x0, xa), b = Math.min(res.x1, xs[i]);
            if (b <= a) continue;
            const ia = Math.floor(a), ib = Math.floor(b);
            if (ia === ib) cov[ia] += (b - a) * w8;
            else { cov[ia] += (ia + 1 - a) * w8; del[ia + 1] += w8; del[ib] -= w8; cov[ib] += (b - ib) * w8; }
          }
        }
      }
      let run = 0;
      for (let x = res.x0, o = y * W; x < res.x1; x++) { run += del[x]; const c = cov[x] + run; M[o + x] = c > 1 ? 1 : c < 0 ? 0 : c; cov[x] = 0; del[x] = 0; }
      cov[res.x1] = 0; del[res.x1] = 0;
    }
    return res;
  }
  _clearMask(c) { for (let y = c.y0; y < c.y1; y++) c.m.fill(0, y * this.width + c.x0, y * this.width + c.x1); }

  // ---------------------------------------------------------------- compositing
  _paint(c, style) {
    const st = this._st;
    if (c.x1 > c.x0 && st.shadowBlur > 0) {
      const sc = parseColor(st.shadowColor);
      if (sc[3] > 0) this._shadow(c, sc);
    }
    this._blend(c, style, c.m);
    this._clearMask(c);
  }
  _shadow(c, col) {
    // ~Gaussian of sigma shadowBlur / 2: two running-sum box passes per axis (radius r, sigma ~ 0.82 r), over the box
    // grown by 2 r. O(1) per pixel per pass whatever the blur.
    const W = this.width, H = this.height, r = Math.max(1, Math.round(this._st.shadowBlur / 2 / 0.82)), g = 2 * r;
    const s = { m: this._masks[2], x0: Math.max(0, c.x0 - g), x1: Math.min(W, c.x1 + g), y0: Math.max(0, c.y0 - g), y1: Math.min(H, c.y1 + g) };
    const B = s.m, S = c.m, n = 2 * r + 1, line = this._shLine && this._shLine.length >= Math.max(W, H) + 2 * g ? this._shLine : (this._shLine = new Float32Array(Math.max(W, H) + 2 * g));
    for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) B[y * W + x] = S[y * W + x];
    const box = (len, base, step) => {               // in place on B[base + i * step], i in [0, len)
      for (let i = 0; i < len; i++) line[i] = B[base + i * step];
      let acc = 0; for (let i = 0; i < r && i < len; i++) acc += line[i];
      for (let i = 0; i < len; i++) { if (i + r < len) acc += line[i + r]; if (i - r - 1 >= 0) acc -= line[i - r - 1]; B[base + i * step] = acc / n; }
    };
    for (let it = 0; it < 2; it++) {
      for (let y = s.y0; y < s.y1; y++) box(s.x1 - s.x0, y * W + s.x0, 1);
      for (let x = s.x0; x < s.x1; x++) box(s.y1 - s.y0, s.y0 * W + x, W);
    }
    this._blend(s, `rgba(${col[0] * 255},${col[1] * 255},${col[2] * 255},${col[3]})`, B);
    this._clearMask(s);
  }
  _blend(c, style, M) {
    const st = this._st, W = this.width, P = this.px, ga = st.globalAlpha, clip = st.clip, atop = st.globalCompositeOperation === 'source-atop';
    let solid = null, lut = null, gi = null;
    if (style instanceof LinearGradient) {
      lut = style.table(); const m = this._inv(), [x0, y0, x1, y1] = style.p, vx = x1 - x0, vy = y1 - y0, l2 = vx * vx + vy * vy || 1, ux = vx / l2, uy = vy / l2;
      gi = [m[0] * ux + m[1] * uy, m[2] * ux + m[3] * uy, (m[4] - x0) * ux + (m[5] - y0) * uy];   // t = gx * px + gy * py + g0
    } else { const k = parseColor(style); solid = [k[0] * k[3], k[1] * k[3], k[2] * k[3], k[3]]; }
    for (let y = c.y0; y < c.y1; y++) {
      for (let x = c.x0, i = y * W + c.x0; x < c.x1; x++, i++) {
        let cv = M[i]; if (cv <= 0) continue;
        cv *= ga; if (clip) { cv *= clip[i]; if (cv <= 0) continue; }
        let sr, sg, sb, sa;
        if (solid) { sr = solid[0]; sg = solid[1]; sb = solid[2]; sa = solid[3]; }
        else {
          const tt = (gi[0] * (x + 0.5) + gi[1] * (y + 0.5) + gi[2]) * 255, t = (tt <= 0 ? 0 : tt >= 255 ? 255 : Math.round(tt)) * 4;
          sr = lut[t]; sg = lut[t + 1]; sb = lut[t + 2]; sa = lut[t + 3];
        }
        const o = i * 4, a = sa * cv;
        if (atop) { const da = P[o + 3]; P[o] = sr * cv * da + P[o] * (1 - a); P[o + 1] = sg * cv * da + P[o + 1] * (1 - a); P[o + 2] = sb * cv * da + P[o + 2] * (1 - a); }
        else { P[o] = sr * cv + P[o] * (1 - a); P[o + 1] = sg * cv + P[o + 1] * (1 - a); P[o + 2] = sb * cv + P[o + 2] * (1 - a); P[o + 3] = a + P[o + 3] * (1 - a); }
      }
    }
  }

  /** Copy the whole surface into an RGBA8 array of width dstW at (dx, dy): straight alpha, rounded bytes. flip = rows
   *  bottom-up in the destination of height dstH (WebGL texture order, same as a flipY canvas upload). */
  copyTo(dst, dstW, dx, dy, flip = false, dstH = 0) {
    const W = this.width, H = this.height, P = this.px;
    for (let y = 0; y < H; y++) {
      const row = flip ? dstH - 1 - (dy + y) : dy + y;
      for (let x = 0, i = y * W * 4, o = (row * dstW + dx) * 4; x < W; x++, i += 4, o += 4) {
        const a = P[i + 3];
        if (a <= 0.5 / 255) { dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0; continue; }
        const k = 255 / a;
        dst[o] = Math.min(255, Math.round(P[i] * k)); dst[o + 1] = Math.min(255, Math.round(P[i + 1] * k)); dst[o + 2] = Math.min(255, Math.round(P[i + 2] * k)); dst[o + 3] = Math.round(Math.min(1, a) * 255);
      }
    }
  }
}
