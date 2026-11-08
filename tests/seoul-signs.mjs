// usage: node tests/seoul-signs.mjs [layout.json]  — signs & screens: determinism, push invariants, colour shares, the panel's
// luminance hierarchy (letters are the light), sign density, MSDF glyph coverage, emitters (L3), screen content, native export.
import fs from 'node:fs';
const DIR = process.env.DIR || new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const M = await import(DIR + '/seoul-signs.js');
const { build, buildData, exportData, generateSigns, signStats, designFace, programMean, COLOR_CATS, NITS, K, lum } = M;
const cand = [process.argv[2], DIR + '/seoul/layout.json', DIR + '/seoul/layout.provisional.json'].filter(Boolean);
const lp = cand.find((p) => fs.existsSync(p)); if (!lp) { console.log('no layout; skip'); process.exit(0); }
const layout = JSON.parse(fs.readFileSync(lp, 'utf8'));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const pct = (x) => `${(x * 100).toFixed(0)} %`;

// --- determinism and push invariants ---
const a = generateSigns(layout, { seed: 1 }), b = generateSigns(layout, { seed: 1 });
ok(JSON.stringify(a.specs.map((s) => [s.id, s.cat, s.hue, s.nits, s.design])) === JSON.stringify(b.specs.map((s) => [s.id, s.cat, s.hue, s.nits, s.design])), 'deterministic');
const p0 = generateSigns(layout, { seed: 1, neonPush: 0 }), p1 = generateSigns(layout, { seed: 1, neonPush: 1 });
const strip = (sp) => JSON.stringify(sp.map((s) => [s.id, s.type, s.lit, s.geo]));
ok(strip(p0.specs) === strip(p1.specs), 'push changes only colour/style: ids, types, lit, geometry identical');
const out = {};
for (const [k, push] of [['census', 0], ['alley', 0.4], ['hero', 1], ['default', undefined]]) {
  const st = signStats(generateSigns(layout, { seed: 1, neonPush: push }).specs); out[k] = st;
  console.log(k.padEnd(8), 'lit', st.litShare, 'neon', st.neonShare, COLOR_CATS.map((c) => `${c} ${(st.colourShare[c] * 100).toFixed(0)}%`).join(' '));
}
ok(out.census.litShare > 0.6 && out.census.litShare < 0.85, `lit share ${out.census.litShare} in 0.6..0.85 (T5: 20-30 % unlit)`);
ok(out.hero.colourShare.pink + out.hero.colourShare.cyan + out.hero.colourShare.violet > 0.3, 'push 1 raises magenta+cyan+violet > 30 %');
ok(out.census.colourShare.white > 0.3, 'census keeps white majority-ish');
ok(M.PUSH_BY_KIND.club === 0.6 && M.PUSH_BY_KIND.walking === 0.6 && M.PUSH_BY_KIND.main === 0.4, 'colour #2: neonPush club/walking 0.6, main 0.4');

// --- art #1 density list ---
const S = a.specs, lots = layout.lots || [];
const fasc = S.filter((s) => (s.type === 'fascia' || s.type === 'channel') && s.floor === 0 && !s.geo.small && s.id.endsWith(':fascia0') || s.id.endsWith(':channel0'));
const wr = fasc.map((s) => (s.geo.w / s.frame.L)); const wrOk = wr.filter((x) => x <= 0.86).length / wr.length;
ok(wrOk > 0.97, `ground fascia width <= 0.85 L on ${pct(wrOk)}`);
const rb = lots.filter((l) => l.use === 'restaurant' || l.use === 'bar'); const rbCh = rb.filter((l) => S.some((s) => s.id === `${l.id}:channel0`)).length / Math.max(1, rb.length);
ok(rbCh > 0.35 && rb.length > 20, `channel letters on ${pct(rbCh)} of restaurant/bar ground floors (target 45 %)`);
const tall = lots.filter((l) => (l.floors | 0) >= 3 && l.use !== 'motel' && l.use !== 'hotel');
const bladeLots = tall.filter((l) => S.some((s) => s.lot === l.id && s.type === 'blade'));
const twoStacks = bladeLots.filter((l) => new Set(S.filter((s) => s.lot === l.id && s.type === 'blade').map((s) => s.geo.u)).size >= 2);
ok(bladeLots.length / tall.length >= 0.68, `blades on ${pct(bladeLots.length / tall.length)} of 3F+ lots (>= 70 %)`);
ok(twoStacks.length / Math.max(1, bladeLots.length) > 0.2, `second blade stack on ${pct(twoStacks.length / Math.max(1, bladeLots.length))} of them (30 %)`);
const stands = S.filter((s) => s.type === 'stand').length; ok(stands / lots.length >= 0.5, `입간판 ${stands} for ${lots.length} shops (>= 1 per 2)`);
const upLit = S.filter((s) => s.type === 'window' && s.lit && s.floor >= 1 && s.floor <= 3);
const upTen = new Set(S.filter((s) => s.floor >= 1 && s.floor <= 3 && s.lit).map((s) => `${s.lot}/${s.floor}`));
const vin = new Set(upLit.map((s) => `${s.lot}/${s.floor}`)); ok(vin.size / upTen.size >= 0.55, `vinyl on ${pct(vin.size / upTen.size)} of lit 2F-4F tenants (60 %)`);
const st = signStats(S); ok(st.bulbShare > 0.22 && st.bulbShare < 0.4, `bulb / LED borders on ${pct(st.bulbShare)} of nightlife boxes (30 %)`);
console.log('designs', JSON.stringify(st.byDesign));

// --- lighting #2: the binding luminance hierarchy, per lit design ---
const inR = (v, r) => v >= r[0] - 1e-6 && v <= r[1] + 1e-6;
let hier = 0, hierBad = []; const ratios = [];
for (const s of S.filter((x) => x.lit && x.type !== 'banner' && x.style !== 'scroller').slice(0, 1500)) {
  const D = designFace(s, s.geo.w, s.geo.h);
  const glyphLum = Math.max(0, ...D.els.filter((e) => e.glyph && !e.ret).map((e) => lum(e.col)));
  const groundLum = Math.max(0, ...D.els.filter((e) => !e.glyph && !e.bulb && e.layer === 0).map((e) => lum(e.col)));
  const bulbLum = Math.max(0, ...D.els.filter((e) => e.bulb).map((e) => lum(e.col)));
  let good = true;
  if (s.design === 'flex') { const k = groundLum / glyphLum; ratios.push(k); good = k >= 0.25 - 1e-6 && k <= 0.35 + 1e-6 && inR(glyphLum, [100, 220]); }
  else if (s.design === 'blackflex') good = groundLum <= 0.35 * glyphLum && inR(glyphLum, [100, 220]);
  else if (s.design === 'galva' || s.design === 'channel') good = groundLum === 0 && inR(glyphLum, [600, 2000]);
  else if (s.design === 'neon') good = groundLum === 0 && inR(glyphLum, [600, 2000]);
  else if (s.design === 'dots') good = inR(glyphLum, [600, 2000]);
  else if (s.design === 'vinylA') good = Math.abs(glyphLum / groundLum - NITS.vinyl) < 1e-3 && inR(groundLum, [5, 25]);
  else if (s.design === 'vinylB') good = Math.abs(groundLum / glyphLum - NITS.vinyl) < 1e-3 && inR(glyphLum, [5, 25]);
  if (bulbLum && !inR(bulbLum, [600, 2000])) good = false;
  if (good) hier++; else if (hierBad.length < 4) hierBad.push(`${s.id} ${s.design} g${glyphLum.toFixed(0)} b${groundLum.toFixed(0)}`);
}
ok(hierBad.length === 0, `luminance hierarchy (letters 600-2000 / box letters 100-220, ground 25-35 %, vinyl x0.3, bulbs 600-2000): ${hier} ok ${hierBad.join('; ')}`);
ok(ratios.length > 50, `flex grounds at ${ratios.length ? Math.min(...ratios).toFixed(2) : '-'}-${ratios.length ? Math.max(...ratios).toFixed(2) : '-'} of their letters`);

// --- screens: 180-350 nits, content mean ~0.3 of peak (never a white plate) ---
const D = buildData(layout, { seed: 1 });
ok(D.screens.every((o) => inR(o.nits, [180, 350])), `screen nits ${Math.min(...D.screens.map((o) => o.nits)).toFixed(0)}-${Math.max(...D.screens.map((o) => o.nits)).toFixed(0)} in 180-350`);
let mSum = 0, mN = 0, mMax = 0;
for (const o of D.screens) for (const seg of o.playlist.list) for (let t = 0.2; t < seg.dur; t += 0.7) { const y = lum(programMean(seg, t)); mSum += y; mN++; mMax = Math.max(mMax, y); }
ok(mSum / mN < 0.35 && mMax < 0.6, `screen content mean ${(mSum / mN).toFixed(2)} (max ${mMax.toFixed(2)}) of the white peak`);

// --- graphics #2: every glyph in the MSDF atlas; uvs valid ---
ok(D.stats.missingGlyphs === '', `MSDF atlas covers every glyph (missing: "${D.stats.missingGlyphs}")`);
let uvOk = true; for (const f of D.faces.slice(0, 3000)) for (const e of f.els) if (e.glyph && e.uv.some((v) => !(v >= 0 && v <= 1))) uvOk = false;
ok(uvOk, 'glyph uvs inside the atlas');
ok(D.stats.glyphs > 20000, `${D.stats.glyphs} glyph quads laid out`);

// --- build (node: no textures), emitters (L3), screens animate ---
const w = await build(layout, { seed: 1 });
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
const ex = exportData(layout, { seed: 1 }); const sj = JSON.parse(JSON.stringify(ex.signs)), cj = JSON.parse(JSON.stringify(ex.screens));
ok(sj.faces.length === D.faces.length && sj.designs.length > 1000 && sj.faces.every((f) => f.design < sj.designs.length), `signs.json: ${sj.faces.length} faces, ${sj.designs.length} designs`);
ok(cj.screens.length === D.screens.length && cj.screens.every((o) => o.playlist.length >= 3 && o.res[0] > 0), `screens.json: ${cj.screens.length} screens with playlists`);
ok(JSON.stringify(exportData(layout, { seed: 1 }).signs.faces.slice(0, 50)) === JSON.stringify(sj.faces.slice(0, 50)), 'export deterministic');
console.log(`${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
