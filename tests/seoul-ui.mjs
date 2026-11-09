// F2: the per-level UI data in levels.json (ux #3, ui #1 / #6) and the Seoul UI assets. node tests/seoul-ui.mjs
// - every level's UI keys have the right shape; the assets they name exist (stills: size, 16:9, the backdrop <= 180 KB)
// - [P3] one source for line copy: Seoul's line list is seoul/lines.json (levels.json `lines`); levels.json `lineCopy`
//   has a hint and a listed group for every named line there and nothing else; {w} is the only hint token; the first
//   instruction is the take start's hint (no firstTip to drift); loadSteps name every build step, in both scripts
// - [P3] the identity stills were committed after the last change to the look (world-seoul.js, seoul-signs.js, fpvcam.js)
// - tips use <b> and the {bankT} / {cut} tokens only; the OSM credit is on Seoul's foot line (ODbL)
// - every hangul the UI can show (levels.json strings, the layout's street / landmark `ko` names for the captions'
//   place line) is in the UI font (seoul/ui/glyphs.txt, written by tools/seoul-ui-assets.py)
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (c, msg) => { if (c) console.log('  ok  ' + msg); else { fails++; console.log('  FAIL ' + msg); } };
const levels = JSON.parse(readFileSync(join(ROOT, 'levels.json'), 'utf8'));
const hangul = (s) => [...String(s)].filter((c) => /[ᄀ-ᇿ㄰-㆏가-힣]/.test(c));
function jpegSize(p) {
  const b = readFileSync(p); let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null; const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

console.log('levels.json UI keys');
const strings = [];
for (const L of levels) {
  const tag = L.id;
  for (const k of ['subtitle', 'kicker', 'firstTip', 'foot', 'backdropPos', 'lines']) if (k in L) { ok(typeof L[k] === 'string' && L[k].length > 0, `${tag}.${k} is a string`); strings.push(L[k]); }
  for (const k of ['thumb', 'backdrop']) if (L[k]) {
    const p = join(ROOT, L[k]); ok(existsSync(p), `${tag}.${k} ${L[k]} exists`);
    if (existsSync(p) && /\.jpe?g$/i.test(p)) {
      const s = jpegSize(p), kb = statSync(p).size / 1024;
      if (tag !== 'bando') ok(s && Math.abs(s.w / s.h - 16 / 9) < 0.02, `${tag}.${k} is 16:9 (${s?.w}x${s?.h})`);   // bando: hero.jpg (2:1) predates this
      if (k === 'backdrop') ok(kb <= 180 && s?.w >= 1280, `${tag}.backdrop ${kb.toFixed(0)} KB <= 180, >= 1280 wide`);
    }
  }
  if (L.ui) {
    for (const k of ['accent', 'accentInk', 'ghost']) if (k in L.ui) ok(/^#[0-9a-f]{6}$/i.test(L.ui[k]), `${tag}.ui.${k} is #rrggbb`);
    if ('hairline' in L.ui) ok(/gradient\(|^#/.test(L.ui.hairline), `${tag}.ui.hairline is a colour or gradient`);
  }
  if ('guideUntil' in L) ok(Number.isFinite(L.guideUntil) && L.guideUntil >= 0, `${tag}.guideUntil is a number`);
  if ('placeNames' in L) ok(typeof L.placeNames === 'boolean', `${tag}.placeNames is a boolean`);
  if (L.tips) for (const [g, arr] of Object.entries(L.tips)) {
    ok(['take', 'free'].includes(g) && Array.isArray(arr) && arr.length > 0, `${tag}.tips.${g} is a non-empty list`);
    for (const t of arr || []) { strings.push(t); ok(!/<(?!\/?b>)/.test(t) && !/\{(?!bankT\}|cut\})/.test(t), `${tag}.tips.${g}: <b> and {bankT}/{cut} only: "${t.slice(0, 40)}…"`); }
    ok(!(arr || []).some((t) => /chimney|silo|hall/i.test(t)) || tag === 'bando', `${tag}.tips.${g} has no bando copy`);
  }
  if (L.lineNames) {
    ok(Array.isArray(L.lineNames) && L.lineNames.every((x) => typeof x === 'string' || (x && typeof x.name === 'string')), `${tag}.lineNames are names or {name, hint}`);
    for (const x of L.lineNames) if (x?.hint) strings.push(x.hint);
  }
  if (L.firstTip && tag !== 'bando') ok(!/chimney|hall|track/i.test(L.firstTip), `${tag}.firstTip has no bando copy`);
}

console.log('Seoul');
const S = levels.find((l) => l.id === 'seoul-hongdae');
ok(!!S, 'seoul-hongdae is in levels.json');
if (S) {
  for (const k of ['subtitle', 'thumb', 'backdrop', 'kicker', 'tips', 'lines', 'lineCopy', 'lineGroups', 'loadSteps', 'foot']) ok(k in S, `seoul has ${k}`);
  ok(!('lineNames' in S) && !('firstTip' in S), 'seoul keeps no second line list (lineNames) or first tip (firstTip): lines.json is the source');
  ok(/OpenStreetMap/.test(S.foot || ''), 'seoul foot credits OpenStreetMap (ODbL)');
  ok(S.lines === 'seoul/lines.json' && existsSync(join(ROOT, S.lines)), 'seoul.lines names seoul/lines.json');
  const LJ = JSON.parse(readFileSync(join(ROOT, 'seoul', 'lines.json'), 'utf8')), lines = LJ.lines || [];
  const isMicro = (l) => !!l.micro || (typeof l.pts === 'number' && l.pts > 0 && l.pts < 1000);
  const named = [...new Set(lines.filter((l) => l.name && !isMicro(l) && !l.carve).map((l) => l.name))];
  const copy = S.lineCopy || {}, groups = new Set((S.lineGroups || []).map((g) => Array.isArray(g) && g[0]));
  ok(Array.isArray(S.lineGroups) && S.lineGroups.every((g) => Array.isArray(g) && g.length === 2 && typeof g[1] === 'string'), 'seoul.lineGroups are [id, LABEL] pairs');
  const noCopy = named.filter((n) => !copy[n]?.hint && !lines.find((l) => l.name === n && l.hint)), stale = Object.keys(copy).filter((n) => !named.includes(n));
  ok(!noCopy.length, `every named line in lines.json has a hint (${named.length - noCopy.length}/${named.length})${noCopy.length ? ': missing ' + noCopy.join(', ') : ''}`);
  ok(!stale.length, `lineCopy names only lines.json lines${stale.length ? ': stale ' + stale.join(', ') : ''}`);
  ok(Object.values(copy).every((c) => groups.has(c.group)), 'every lineCopy group is in lineGroups');
  for (const [n, c] of Object.entries(copy)) { strings.push(c.hint); ok(!/\{(?!w\})/.test(c.hint) && !/[<>]/.test(c.hint), `${n} hint: plain text, {w} only`); }
  ok(named.length >= 18, `lines.json has ${named.length} named lines (the grid is laid out for 18)`);
  const tip = LJ.takeStart?.hint?.text || LJ.startPoints?.[0]?.hint?.text || '';
  ok(!!tip, `the first instruction comes from lines.json takeStart.hint: "${tip}"`);
  ok(LJ.tuning && +LJ.tuning.bankT > 0 && Array.isArray(LJ.tuning.stars), `lines.json tuning gives the copy its numbers (bankT ${LJ.tuning?.bankT} s, stars ${LJ.tuning?.stars})`);
  // build steps: every prog(f, 'Hongdae: step') in world-seoul.js has a bilingual label (C / D may add steps: warn only)
  const steps = [...readFileSync(join(ROOT, 'world-seoul.js'), 'utf8').matchAll(/prog\([\d.]+,\s*'([^']+)'\)/g)].map((m) => m[1].replace(/^[^:]*:\s*/, '').trim().toLowerCase());
  const ls = S.loadSteps || {}; for (const v of Object.values(ls)) strings.push(v);
  ok(Object.values(ls).every((v) => /[가-힣]/.test(v) && /[A-Z]/.test(v)), 'loadSteps are bilingual ("간판 · SIGNS")');
  const unl = steps.filter((k) => !(k in ls));
  if (unl.length) console.log(`  warn build steps without a label (shown blank): ${unl.join(', ')}`); else ok(steps.length > 0, `every build step (${steps.length}) has a label`);
  // the stills: committed after the last commit that changed the look (git; skipped outside a git checkout)
  const ct = (f) => { try { return +execFileSync('git', ['log', '-1', '--format=%ct', '--', f], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 0; } catch (e) { return -1; } };
  const still = Math.min(ct(S.backdrop), ct(S.thumb)), look = Math.max(...['world-seoul.js', 'seoul-signs.js', 'fpvcam.js'].map(ct));
  if (still < 0 || look < 0) console.log('  skip stills freshness (no git)');
  else ok(still >= look, `identity stills are newer than the look (stills ${new Date(still * 1e3).toISOString().slice(0, 16)}, look ${new Date(look * 1e3).toISOString().slice(0, 16)})` +
    (still >= look ? '' : ': re-shoot, python3 tools/seoul-ui-assets.py --backdrop STILL --thumb STILL'));
}

console.log('UI font coverage');
const gp = join(ROOT, 'seoul', 'ui', 'glyphs.txt'), font = join(ROOT, 'seoul', 'ui', 'OT-KR800.woff2');
ok(existsSync(font) && statSync(font).size < 64 * 1024, 'seoul/ui/OT-KR800.woff2 exists (< 64 KB)');
ok(existsSync(join(ROOT, 'seoul', 'ui', 'OFL.txt')), 'seoul/ui/OFL.txt (licence) exists');
const have = new Set(existsSync(gp) ? [...readFileSync(gp, 'utf8')] : []);
const lay = JSON.parse(readFileSync(join(ROOT, 'seoul', 'layout.json'), 'utf8'));
for (const s of [...(lay.streets || []), ...(lay.hero || [])]) if (s.ko) strings.push(s.ko);
const need = new Set(strings.flatMap(hangul)), miss = [...need].filter((c) => !have.has(c));
ok(!miss.length, `${need.size} hangul glyphs the UI can show are in the font${miss.length ? ': missing ' + miss.join('') + ' (re-run tools/seoul-ui-assets.py)' : ''}`);
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
ok(html.includes("url(seoul/ui/OT-KR800.woff2)"), 'index.html @font-face points at the UI font');

console.log(fails ? `\n${fails} failed` : '\nall ok');
process.exit(fails ? 1 : 0);
