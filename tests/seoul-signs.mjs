// usage: node tests/seoul-signs.mjs [layout.json]  — signs & screens: determinism, push invariants, colour shares, the panel's
// luminance hierarchy (letters are the light), sign density, MSDF glyph coverage, emitters (L3), screen content, native export.
import fs from 'node:fs';
const DIR = process.env.DIR || new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const M = await import(DIR + '/seoul-signs.js');
const { build, buildData, exportData, generateSigns, signStats, designFace, programMean, COLOR_CATS, NITS, K, lum, filt, sideFaces, SLOT, GLYPH_INSET } = M;
const mx = (c) => Math.max(c[0], c[1], c[2]);
const cand = [process.argv[2], DIR + '/seoul/layout.json', DIR + '/seoul/layout.provisional.json'].filter(Boolean);
const lp = cand.find((p) => fs.existsSync(p)); if (!lp) { console.log('no layout; skip'); process.exit(0); }
const layout = JSON.parse(fs.readFileSync(lp, 'utf8'));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const pct = (x) => `${(x * 100).toFixed(0)} %`;
// [P4-B] the game builds signs on C's slots (world-seoul lotInfo: sign beds, spandrels, windows, roof frames), so the suite
// does too: world-seoul's pure geometry build (node, ~15 s) supplies them. A bare layout still builds (synthesised slots).
let lotInfo = null;
try { const W = await import(DIR + '/world-seoul.js'); lotInfo = W.buildSeoulGeometry(layout, { seed: 11 }).lotInfo; } catch (e) { console.log('world-seoul geometry unavailable:', e.message); }
ok(lotInfo && lotInfo.size === (layout.lots || []).length, `C's lotInfo for every lot (${lotInfo?.size})`);
const LI = { lotInfo };

// --- determinism and push invariants ---
const a = generateSigns(layout, { seed: 1, ...LI }), b = generateSigns(layout, { seed: 1, ...LI });
ok(JSON.stringify(a.specs.map((s) => [s.id, s.cat, s.hue, s.nits, s.design])) === JSON.stringify(b.specs.map((s) => [s.id, s.cat, s.hue, s.nits, s.design])), 'deterministic');
const p0 = generateSigns(layout, { seed: 1, neonPush: 0, ...LI }), p1 = generateSigns(layout, { seed: 1, neonPush: 1, ...LI });
const strip = (sp) => JSON.stringify(sp.map((s) => [s.id, s.type, s.lit, s.geo]));
ok(strip(p0.specs) === strip(p1.specs), 'push changes only colour/style: ids, types, lit, geometry identical');
const out = {};
for (const [k, push] of [['census', 0], ['alley', 0.4], ['hero', 1], ['default', undefined]]) {
  const st = signStats(generateSigns(layout, { seed: 1, neonPush: push, ...LI }).specs); out[k] = st;
  console.log(k.padEnd(8), 'lit', st.litShare, 'neon', st.neonShare, COLOR_CATS.map((c) => `${c} ${(st.colourShare[c] * 100).toFixed(0)}%`).join(' '));
}
ok(out.census.litShare > 0.6 && out.census.litShare < 0.85, `lit share ${out.census.litShare} in 0.6..0.85 (T5: 20-30 % unlit)`);
{ const h = out.hero.colourShare, c = out.census.colourShare, acc = (x) => x.pink + x.cyan + x.violet;
  ok(h.red + h.ygo >= 0.33 && acc(h) <= 0.2 && acc(h) > acc(c), `colour #1: push 1 is warm-heavy (red+ygo ${pct(h.red + h.ygo)}) with accents (pink+cyan+violet ${pct(acc(h))}, census ${pct(acc(c))})`); }
ok(out.census.colourShare.white > 0.3, 'census keeps white majority-ish');
ok(M.PUSH_BY_KIND.club === 0.6 && M.PUSH_BY_KIND.walking === 0.6 && M.PUSH_BY_KIND.main === 0.4, 'colour #2: neonPush club/walking 0.6, main 0.4');

// --- art #1 density list ---
const S = a.specs, lots = layout.lots || [];
const fasc = S.filter((s) => s.geo.bay); const wr = fasc.map((s) => s.geo.w / s.geo.bay); const wrOk = wr.filter((x) => x <= 0.96 && x >= 0.15).length / wr.length;
ok(wrOk > 0.97 && fasc.length > 400, `${fasc.length} ground shop signs, 0.62-0.95 of the bay on ${pct(wrOk)}`);
{ // [P4-B] art #1: C's slots are filled; nothing hangs where C built no sign bed (club90's 와도 반와가뻬)
  const ids = new Map(); for (const s of S) (ids.get(s.lot) || ids.set(s.lot, []).get(s.lot)).push(s);
  let beds = 0, bedOk = 0, roofs = 0, roofOk = 0, shutBad = 0, offBed = 0, bands = 0, bandOk = 0;
  const sameN = (F, n) => Math.abs(F.n[0] - n[0]) < 1e-6 && Math.abs(F.n[1] - n[2]) < 1e-6;
  for (const [id, info] of lotInfo || []) {
    const ss = ids.get(id) || [];
    for (const fx of info.fascias) { beds++; const on = ss.filter((s) => s.geo.bay && sameN(s.frame, fx.normal)); if (on.length) bedOk++;
      if (fx.lit === false) shutBad += on.filter((s) => s.geo.y < SLOT.shutterTop + 0.03).length; }
    if (info.roofSign) { roofs++; if (ss.some((s) => s.geo.cframe || s.geo.roofBox)) roofOk++; }
    for (const b of info.bands) { const t = info.floors[b.f]; if (!t || t.use === 'home' || !t.lit || b.side) continue; bands++; if (ss.some((s) => s.floor === b.f && (s.type === 'fascia' || s.type === 'channel') && sameN(s.frame, b.normal))) bandOk++; }
  }
  offBed = S.filter((s) => (s.type === 'fascia' || s.type === 'channel') && s.floor === 0 && !s.geo.bay && !s.geo.roofBox && s.use !== 'motel' && s.use !== 'hotel' && s.geo.y < 4.2).length;
  ok(beds === 474 && bedOk === beds, `art #1: signs on ${bedOk}/${beds} of C's sign beds`);
  ok(roofs > 30 && roofOk === roofs, `art #1: C's roof frames filled ${roofOk}/${roofs}`);
  ok(bands > 300 && bandOk / bands >= 0.8, `art #1: a floor box on ${pct(bandOk / Math.max(1, bands))} of lit business spandrels (${bands})`);
  ok(shutBad === 0, `shuttered beds: signs clear the housing box (${shutBad} below ${SLOT.shutterTop} m)`);
  ok(offBed === 0, `no ground sign off C's beds (${offBed})`);
  const vin = S.filter((s) => s.type === 'vinyl'); ok(vin.length > 500 && vin.every((s) => s.geo.y > 3), `window lettering on C's lit glass: ${vin.length} panes`);
  const corner = [...(lotInfo || [])].filter(([id, i]) => i.edges.some((e) => e.streetSide && e.L >= 3) && (layout.lots.find((l) => l.id === id)?.floors || 0) >= 2);
  ok(corner.length > 50 && corner.every(([id]) => (ids.get(id) || []).some((s) => s.type === 'blade' && s.frame.side)), `one blade stack per corner lot (${corner.length}, C's street-facing sides)`);
  const boxes = S.filter((s) => ['fascia', 'blade', 'stand', 'round'].includes(s.style) && s.lit), col = boxes.filter((s) => s.design === 'flex').length / boxes.length;
  const wb = boxes.filter((s) => s.cat === 'white' && s.use !== 'conv' && s.design !== 'dots'), inv = wb.filter((s) => s.design === 'inverse').length / Math.max(1, wb.length);
  ok(col >= 0.25 && col <= 0.4, `colour #3 / art #1: coloured faces (red, amber, blue, green, yellow) on ${pct(col)} of lit boxes (30 %)`);
  ok(inv >= 0.33 && inv <= 0.47, `colour #2: inverse white boxes on ${pct(inv)} of white boxes (40 %)`);
  const lg = generateSigns(layout, { seed: 1 }); ok(lg.specs.length > 4000 && lg.specs.every((s) => Number.isFinite(s.geo.y)), `bare layout (synthesised slots): ${lg.specs.length} signs`); }
const bays = fasc.map((s) => s.geo.bay).sort((x, y) => x - y); ok(bays[bays.length >> 1] < 9, `median shop bay ${bays[bays.length >> 1].toFixed(1)} m (Hongdae 4-8 m)`);
const mainTower = new Set(lots.filter((l) => (layout.streets.find((x) => x.id === l.street) || {}).kind === 'main' && l.floors >= 8).map((l) => l.id));
ok(!S.some((s) => (s.type === 'blade' || s.type === 'fascia') && (s.floor >= 8 || (s.floor >= 7 && !mainTower.has(s.lot)))), 'no blades or boxes above 7F (8F on main-road towers)');
ok(mainTower.size > 5 && [...mainTower].every((id) => S.some((s) => s.lot === id && s.type === 'roof' && s.lit)) && [...mainTower].every((id) => S.some((s) => s.lot === id && s.floor === 7 && (s.type === 'fascia' || s.type === 'channel' || s.type === 'blade'))),
  `art #1: ${mainTower.size} main-road towers carry floor boxes to 8F and a lit roof crown`);
{ // art #1: street-facing side walls of corner lots are signed (blades on every corner lot)
  const SF = sideFaces(layout); const corner = lots.filter((l) => SF.has(l.id) && l.floors >= 2);
  const signed = corner.filter((l) => S.some((s) => s.lot === l.id && s.frame.side && s.type === 'blade')).length;
  const side = S.filter((s) => s.frame.side).length;
  ok(corner.length > 50 && signed === corner.length && side > 600, `side walls: blades on ${signed}/${corner.length} corner lots, ${side} side-wall signs`);
  const ten = new Map(); for (const s of S) if (s.floor >= 1 && s.floor <= 4 && s.lit && !s.frame.side && s.use !== 'motel' && s.use !== 'hotel') { const k = s.lot + '/' + s.floor; const v = ten.get(k) || 0; ten.set(k, v || +(s.type === 'fascia' || s.type === 'channel')); }
  const box = [...ten.values()].filter(Boolean).length / Math.max(1, ten.size); ok(box >= 0.75, `floor box on ${pct(box)} of lit 2F-5F tenants (80 %)`);
  const leg = S.filter((s) => s.lit && s.type !== 'banner' && s.style !== 'scroller'); const hg = leg.filter((s) => !/[A-Z]/.test(s.name.main + (s.name.sub || ''))).length / leg.length;
  ok(hg >= 0.75, `hangul-only names on ${pct(hg)} of lit faces (>= 75 %)`); }
const rb = lots.filter((l) => l.use === 'restaurant' || l.use === 'bar'); const rbCh = rb.filter((l) => S.some((s) => s.id === `${l.id}:channel0`)).length / Math.max(1, rb.length);
ok(rbCh > 0.35 && rb.length > 20, `channel letters on ${pct(rbCh)} of restaurant/bar ground floors (target 45 %)`);
const tall = lots.filter((l) => (l.floors | 0) >= 3 && l.use !== 'motel' && l.use !== 'hotel');
const bladeLots = tall.filter((l) => S.some((s) => s.lot === l.id && s.type === 'blade'));
const twoStacks = bladeLots.filter((l) => new Set(S.filter((s) => s.lot === l.id && s.type === 'blade').map((s) => s.geo.u)).size >= 2);
ok(bladeLots.length / tall.length >= 0.68, `blades on ${pct(bladeLots.length / tall.length)} of 3F+ lots (>= 70 %)`);
ok(twoStacks.length / Math.max(1, bladeLots.length) > 0.2, `second blade stack on ${pct(twoStacks.length / Math.max(1, bladeLots.length))} of them (30 %)`);
const stands = S.filter((s) => s.type === 'stand').length, openShops = S.filter((s) => s.geo.bay && s.geo.y < SLOT.shutterTop).length;
ok(stands / openShops >= 0.5, `입간판 ${stands} for ${openShops} open shops (>= 1 per 2; none outside a shutter)`);
const upLit = S.filter((s) => s.type === 'vinyl' && s.lit && s.floor >= 1 && s.floor <= 3);
const upTen = new Set(S.filter((s) => s.floor >= 1 && s.floor <= 3 && s.lit).map((s) => `${s.lot}/${s.floor}`));
const vin = new Set(upLit.map((s) => `${s.lot}/${s.floor}`)); ok(vin.size / upTen.size >= 0.4, `vinyl on ${pct(vin.size / upTen.size)} of lit 2F-4F tenants`);
const st = signStats(S); ok(st.bulbShare > 0.22 && st.bulbShare < 0.4, `bulb / LED borders on ${pct(st.bulbShare)} of nightlife boxes (30 %)`);
console.log('designs', JSON.stringify(st.byDesign));

// --- lighting #2: the binding luminance hierarchy, per lit design ---
const inR = (v, r) => v >= r[0] - 1e-6 && v <= r[1] + 1e-6;
let hier = 0, hierBad = []; const ratios = [];
for (const s of S.filter((x) => x.lit && x.type !== 'banner' && x.style !== 'scroller').slice(0, 1500)) {
  const D = designFace(s, s.geo.w, s.geo.h);
  // phase 3: the table is white-equivalent (the brightest channel, filter model); the hue sets the luminance
  const glyphLum = Math.max(0, ...D.els.filter((e) => e.glyph && !e.ret).map((e) => mx(e.col)));
  const groundLum = Math.max(0, ...D.els.filter((e) => !e.glyph && !e.bulb && e.layer === 0).map((e) => mx(e.col)));
  const bulbLum = Math.max(0, ...D.els.filter((e) => e.bulb).map((e) => mx(e.col)));
  let good = true;
  if (s.design === 'flex' && s.hue === 'yellow') good = glyphLum <= 220 && inR(groundLum, [100 * 0.75 * 0.85, 220 * 0.9]);   // film letters; clear cut-outs on a band
  else if (s.design === 'flex') { const k = groundLum / glyphLum; ratios.push(k); good = k >= 0.75 * 0.85 - 1e-3 && k <= 0.9 + 1e-3 && inR(glyphLum, [100 * 0.85, 220]); }
  else if (s.design === 'inverse') good = inR(groundLum, [NITS.inverse[0] * 0.95, NITS.inverse[1]]) && glyphLum <= groundLum * 1.05;   // clear cut-outs on its band run at the face
  else if (s.design === 'film') good = groundLum === 0 && inR(glyphLum, [5 * 0.8 * 0.85 - 1e-3, 25 * 1.15 + 1e-3]);
  else if (s.design === 'blackflex') good = groundLum <= 0.35 * glyphLum && inR(glyphLum, [100 * 0.85, 220]);
  else if (s.design === 'galva' || s.design === 'channel') good = groundLum === 0 && inR(glyphLum, [600 * 0.85, 2000]);
  else if (s.design === 'neon') good = groundLum === 0 && inR(glyphLum, [600 * 0.85, 2000]);
  else if (s.design === 'dots') good = inR(glyphLum, [600 * 0.85, 2000]);
  else if (s.design === 'vinylA') good = inR(glyphLum / groundLum, [NITS.vinyl * 0.85 - 1e-3, NITS.vinyl / 0.85 + 1e-3]) && inR(groundLum, [5, 25]);
  else if (s.design === 'vinylB') good = inR(groundLum / glyphLum, [NITS.vinyl * 0.85 - 1e-3, NITS.vinyl / 0.85 + 1e-3]) && inR(glyphLum, [5, 25]);
  if (bulbLum && !inR(bulbLum, [1800 * 0.85, 2000])) good = false;
  if (good) hier++; else if (hierBad.length < 4) hierBad.push(`${s.id} ${s.design} g${glyphLum.toFixed(0)} b${groundLum.toFixed(0)}`);
}
ok(hierBad.length === 0, `luminance hierarchy (letters 600-2000 / box letters 100-220, coloured face 75-90 %, inverse face 250-400, vinyl x0.3, bulbs 600-2000): ${hier} ok ${hierBad.join('; ')}`);
{ // lighting #1 / colour #1: filter model (blue at 1000 white-equivalent has luminance ~120-141, not 1000) and a neutral-warm budget
  const blue = filt([0.013, 0.093, 1.0]); ok(Math.abs(mx(blue) - 0.85) < 0.01 && lum(blue) < 0.14, `filter model: blue luminance ${lum(blue).toFixed(3)} of its white-equivalent`);
  const DD = buildData(layout, { seed: 11, ...LI }); const Bg = [0, 0, 0];
  for (const e of DD.emitters) { if (e.screenKind) continue; const k = e.nits * e.w * e.h / (lum(e.rgb) || 1); for (let i = 0; i < 3; i++) Bg[i] += e.rgb[i] * k; }
  const rg = Bg[0] / Bg[1], bg = Bg[2] / Bg[1]; ok(rg >= 1.1 && rg <= 1.6 && bg >= 0.7 && bg <= 1.05, `sign light budget neutral-warm: R/G ${rg.toFixed(2)}, B/G ${bg.toFixed(2)} (phase 2: 2.72, 2.57)`); }
ok(ratios.length > 50, `flex grounds at ${ratios.length ? Math.min(...ratios).toFixed(2) : '-'}-${ratios.length ? Math.max(...ratios).toFixed(2) : '-'} of their letters`);

// --- screens: 180-350 nits, content mean ~0.3 of peak (never a white plate) ---
const D = buildData(layout, { seed: 1, ...LI });
ok(D.screens.every((o) => inR(o.nits, [180, 350])), `screen nits ${Math.min(...D.screens.map((o) => o.nits)).toFixed(0)}-${Math.max(...D.screens.map((o) => o.nits)).toFixed(0)} in 180-350`);
let mSum = 0, mN = 0, mMax = 0;
for (const o of D.screens) for (const seg of o.playlist.list) for (let t = 0.2; t < seg.dur; t += 0.7) { const y = lum(programMean(seg, t)); mSum += y; mN++; mMax = Math.max(mMax, y); }
ok(mSum / mN < 0.35 && mMax < 0.6, `screen content mean ${(mSum / mN).toFixed(2)} (max ${mMax.toFixed(2)}) of the white peak`);

// --- graphics #2: every glyph in the MSDF atlas; uvs valid ---
ok(D.stats.missingGlyphs === '', `MSDF atlas covers every glyph (missing: "${D.stats.missingGlyphs}")`);
let uvOk = true; for (const f of D.faces.slice(0, 3000)) for (const e of f.els) if (e.glyph && e.uv.some((v) => !(v >= 0 && v <= 1))) uvOk = false;
ok(uvOk, 'glyph uvs inside the atlas');
ok(D.stats.glyphs > 20000, `${D.stats.glyphs} glyph quads laid out`);
{ // [P4-B] art bug MOÖNROÖM: glyph quads sample GLYPH_INSET texels inside their atlas cell (no neighbour bleed)
  const src = fs.readFileSync(DIR + '/seoul/signs/msdf-meta.js', 'utf8'), meta = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
  const cells = []; for (const f of meta.faces) for (let i = 0; i < f.g.length; i += 10) if (f.g[i + 7] || f.g[i + 8]) cells.push(f.g.slice(i + 5, i + 9));
  let bad = 0, n = 0; const W = meta.size[0], H = meta.size[1];
  for (const f of D.faces.slice(0, 2000)) for (const e of f.els) { if (!e.glyph) continue; n++;
    const u0 = Math.min(e.uv[0], e.uv[2]) * W, u1 = Math.max(e.uv[0], e.uv[2]) * W, v0 = Math.min(e.uv[1], e.uv[5]) * H, v1 = Math.max(e.uv[1], e.uv[5]) * H;
    const c = cells.find((q) => u0 > q[0] - 0.01 && u1 < q[2] + 0.01 && v0 > q[1] - 0.01 && v1 < q[3] + 0.01);
    if (!c || u0 - c[0] < GLYPH_INSET - 1e-3 || c[2] - u1 < GLYPH_INSET - 1e-3 || v0 - c[1] < GLYPH_INSET - 1e-3 || c[3] - v1 < GLYPH_INSET - 1e-3) bad++; }
  ok(n > 1000 && bad === 0, `glyph quads ${GLYPH_INSET} texels inside their cells (${n - bad}/${n})`); }

// --- build (node: no textures), emitters (L3), screens animate ---
const w = await build(layout, { seed: 1, ...LI });
console.log('stats', JSON.stringify({ ...w.stats, byType: undefined, byDesign: undefined, colourShare: undefined }));
const kinds = new Set(['neon', 'lightbox', 'channel', 'screen', 'street', 'store', 'tent', 'vehicle']);
ok(w.emitters.every((e) => e.id && e.pos.length === 3 && e.normal.length === 3 && e.w > 0 && e.h > 0 && e.rgb.length === 3 && Number.isFinite(e.nits) && kinds.has(e.kind) && typeof e.animated === 'boolean'), 'L3 emitter records');
ok(new Set(w.emitters.map((e) => e.id)).size === w.emitters.length, 'emitter ids unique');
ok(Object.keys(w.stats.byType).length >= 8, `>= 8 sign types (${Object.keys(w.stats.byType).length})`);
ok(w.stats.drawCalls < 100, `draw calls ${w.stats.drawCalls} (< 100; screens are one instanced draw)`);
ok(w.group.children.filter((m) => m.name === 'signs-screens').length === 1, 'one screen mesh');
const scr = w.emitters.filter((e) => e.kind === 'screen' && e.screenKind); const n0 = scr.map((e) => e.nits).join();
w.update(3.7); const n1 = scr.map((e) => e.nits + e.rgb.join()).join(); w.update(3.7); const n2 = scr.map((e) => e.nits + e.rgb.join()).join();
ok(n0 !== n1 && n1 === n2, 'screen emitters animate and are a pure function of t');
ok(w.collider.attributes.position.count > 1000, `collider triangles exported (${w.collider.attributes.position.count / 3})`);
const nonAscii = [...JSON.stringify(a.specs.map((s) => s.name))].filter((c) => c.charCodeAt(0) >= 0xac00 && c.charCodeAt(0) <= 0xd7a3).length;
ok(nonAscii > 100, 'names are hangul');

// --- native #2: signs.json / screens.json ---
const ex = exportData(layout, { seed: 1, ...LI }); const sj = JSON.parse(JSON.stringify(ex.signs)), cj = JSON.parse(JSON.stringify(ex.screens));
ok(sj.faces.length === D.faces.length && sj.designs.length > 1000 && sj.faces.every((f) => f.design < sj.designs.length), `signs.json: ${sj.faces.length} faces, ${sj.designs.length} designs`);
ok(cj.screens.length === D.screens.length && cj.screens.every((o) => o.playlist.length >= 3 && o.res[0] > 0), `screens.json: ${cj.screens.length} screens with playlists`);
ok(JSON.stringify(exportData(layout, { seed: 1, world: { lotInfo } }).signs.faces.slice(0, 50)) === JSON.stringify(sj.faces.slice(0, 50)), 'export deterministic');
console.log(`${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
