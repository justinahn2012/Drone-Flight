// usage: node tests/seoul-signs.mjs [layout.json]  — S2 sign generator: determinism, push invariants, colour shares, emitters (L3)
import fs from 'node:fs';
const DIR = process.env.DIR || new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { build, generateSigns, signStats, CENSUS, SHIPPED, COLOR_CATS } = await import(DIR + '/seoul-signs.js');
const cand = [process.argv[2], DIR + '/seoul/layout.json', DIR + '/seoul/layout.provisional.json'].filter(Boolean);
const lp = cand.find((p) => fs.existsSync(p)); if (!lp) { console.log('no layout; skip'); process.exit(0); }
const layout = JSON.parse(fs.readFileSync(lp, 'utf8'));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const geoKey = (specs) => JSON.stringify(specs.map((s) => [s.id, s.style === 'neon' ? 'N' : s.type, s.lit, s.geo]));
const a = generateSigns(layout, { seed: 1 }), b = generateSigns(layout, { seed: 1 });
ok(JSON.stringify(a.specs.map((s) => [s.id, s.cat, s.hue, s.nits])) === JSON.stringify(b.specs.map((s) => [s.id, s.cat, s.hue, s.nits])), 'deterministic');
const p0 = generateSigns(layout, { seed: 1, neonPush: 0 }), p1 = generateSigns(layout, { seed: 1, neonPush: 1 });
const strip = (sp) => JSON.stringify(sp.map((s) => [s.id, s.type, s.lit, s.geo]));
ok(strip(p0.specs) === strip(p1.specs), 'push changes only colour/style: ids, types, lit, geometry identical');
const out = {};
for (const [k, push] of [['census', 0], ['alley', 0.4], ['hero', 1], ['default', undefined]]) {
  const st = signStats(generateSigns(layout, { seed: 1, neonPush: push }).specs); out[k] = st;
  console.log(k.padEnd(8), 'lit', st.litShare, 'neon', st.neonShare, COLOR_CATS.map((c) => `${c} ${(st.colourShare[c] * 100).toFixed(0)}%`).join(' '));
}
const s0 = out.census;
ok(s0.litShare > 0.6 && s0.litShare < 0.85, `lit share ${s0.litShare} in 0.6..0.85 (T5: 20-30 % unlit)`);
ok(out.hero.colourShare.pink + out.hero.colourShare.cyan + out.hero.colourShare.violet > 0.3, 'hero push raises magenta+cyan+violet > 30 %');
ok(out.census.colourShare.white > 0.3, 'census keeps white majority-ish');
const w = build(layout, { seed: 1 });
console.log('stats', JSON.stringify(w.stats));
const kinds = new Set(['neon', 'lightbox', 'channel', 'screen', 'street', 'store', 'tent', 'vehicle']);
ok(w.emitters.every((e) => e.id && e.pos.length === 3 && e.normal.length === 3 && e.w > 0 && e.h > 0 && e.rgb.length === 3 && Number.isFinite(e.nits) && kinds.has(e.kind) && typeof e.animated === 'boolean'), 'L3 emitter records');
ok(new Set(w.emitters.map((e) => e.id)).size === w.emitters.length, 'emitter ids unique');
ok(Object.keys(w.stats.byType).length >= 8, `>= 8 sign types (${Object.keys(w.stats.byType).length})`);
const scr = w.emitters.filter((e) => e.kind === 'screen' && e.screenKind); const n0 = scr.map((e) => e.nits).join();
w.update(3.7); const n1 = scr.map((e) => e.nits + e.rgb.join()).join(); w.update(3.7); const n2 = scr.map((e) => e.nits + e.rgb.join()).join();
ok(n0 !== n1 && n1 === n2, 'screen emitters animate and are a pure function of t');
const nonAscii = [...JSON.stringify(a.specs.map((s) => s.name))].filter((c) => c.charCodeAt(0) >= 0xac00 && c.charCodeAt(0) <= 0xd7a3).length;
ok(nonAscii > 100, 'names are hangul');
console.log(`${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
