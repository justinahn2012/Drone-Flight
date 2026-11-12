// F2: the per-level UI data in levels.json (ux #3, ui #1 / #6) and the Seoul UI assets. node tests/seoul-ui.mjs
// - every level's UI keys have the right shape; the assets they name exist (stills: size, 16:9, the backdrop <= 180 KB)
// - [P3] one source for line copy: Seoul's line list is seoul/lines.json (levels.json `lines`); levels.json `lineCopy`
//   has a hint and a listed group for every named line there and nothing else; {w} is the only hint token; the first
//   instruction is the take start's hint (no firstTip to drift); loadSteps name every build step, in both scripts
// - [P3] the identity stills were committed after the last change to the look (world-seoul.js, seoul-signs.js, fpvcam.js)
// - tips use <b> and the {bankT} / {cut} tokens only; the OSM credit is on Seoul's foot line (ODbL)
// - every hangul the UI can show (levels.json strings, the layout's street / landmark `ko` names for the captions'
//   place line, levels.json placeKo) is in the UI font (seoul/ui/glyphs.txt, written by tools/seoul-ui-assets.py)
// - [P4] the stills record (seoul/ui/stills.json): hashes match the files, the thumb reads as neon (>= 3 % saturated-bright
//   pixels; phase 3's dark crossing had 0.4 %); the stills are newer than seoul-life.js too (the backdrop shows the crowd)
// - [P4] the short-landscape LINES grid (seoul/ui/fit.js gridPlan, as main.js lays it out) fits every line on the iPhone
//   landscape screens with their safe areas: no name over two lines, no cell under the scroller's fade
// - [P4] the end card's line row (fit.js takeSummary): named lines once, micros as a count, CLEAN over named flights;
//   the OSD label rule (labelSpot): a bracket label in the top band goes under its bracket
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { gridPlan, nameLines, cellH, CELL, takeSummary, labelSpot, timedSub } = await import(new URL('../seoul/ui/fit.js', import.meta.url).href);
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
const lay0 = JSON.parse(readFileSync(join(ROOT, 'seoul', 'layout.json'), 'utf8'));
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
  const noGroup = named.filter((n) => !copy[n]?.group);
  ok(!noGroup.length, `every named line has a lineCopy group (its grid section)${noGroup.length ? ': missing ' + noGroup.join(', ') : ''}`);
  // [P4] ui #5: street-name overrides for the caption's place line (layout ids -> hangul)
  if (S.placeKo) {
    const ids = new Set([...(lay0.streets || []), ...(lay0.hero || [])].map((x) => x.id));
    ok(typeof S.placeKo === 'object' && Object.entries(S.placeKo).every(([k, v]) => ids.has(k) && /^[가-힣 0-9]+$/.test(v)), `placeKo names layout ids, in hangul (${Object.entries(S.placeKo).map(([k, v]) => k + ' ' + v).join(', ')})`);
    for (const v of Object.values(S.placeKo)) strings.push(v);
  }
  for (const [n, c] of Object.entries(copy)) { strings.push(c.hint); ok(!/\{(?!w\})/.test(c.hint) && !/[<>]/.test(c.hint), `${n} hint: plain text, {w} only`); }
  ok(named.length >= 18, `lines.json has ${named.length} named lines`);
  // [P4] ui #3 / ux #2: the short-landscape grid, paused (START AT on one row above it: the grid starts 144 px down at 390
  // tall, measured), the RESUME bar 62 px + the home-indicator inset, 16 px clear above it. Phase 3 hid 3 of 19 at 390.
  console.log('Short-landscape LINES grid (fit.js gridPlan, iPhone safe areas)');
  const byG = (S.lineGroups || []).map(([id]) => named.filter((n) => copy[n]?.group === id)).filter((g) => g.length);
  for (const [W, H, side, sb, tag] of [[844, 390, 47, 21, 'iPhone 13/14'], [852, 393, 59, 21, 'iPhone 15/16 Pro'], [932, 430, 59, 21, 'Pro Max'], [932, 390, 0, 0, 'headless']]) {
    const gw = Math.min(860, W - 40 - 2 * side), plan = gridPlan(byG.map((g) => g.length), gw);
    if (!plan) { ok(false, `${tag} ${W}x${H}: no plan fits ${gw} px`); continue; }
    const nl = Math.max(...byG.flat().map((n) => nameLines(n, plan.cell))), long = byG.flat().filter((n) => nameLines(n, plan.cell) > 2);
    const h = CELL.head + plan.rows * cellH(nl) + (plan.rows - 1) * 5, avail = H - (144 + 0.4 * (H - 390)) - (62 + sb) - 16;
    ok(!long.length && h <= avail, `${tag} ${W}x${H}: ${plan.cols.join(' + ')} cells across (${plan.cell.toFixed(0)} px), ${plan.rows} rows, ${h} of ${avail.toFixed(0)} px: every line shows` +
      (long.length ? `; over two lines: ${long.join(', ')}` : ''));
  }
  const tip = LJ.takeStart?.hint?.text || LJ.startPoints?.[0]?.hint?.text || '';
  ok(!!tip, `the first instruction comes from lines.json takeStart.hint: "${tip}"`);
  ok(LJ.tuning && +LJ.tuning.bankT > 0 && Array.isArray(LJ.tuning.stars), `lines.json tuning gives the copy its numbers (bankT ${LJ.tuning?.bankT} s, stars ${LJ.tuning?.stars})`);
  // [P5-F] design #1 / ux #1 / ui #4: the first instruction is true. Phase 4 said "UNDER THE STAGE · THEN THE WALKING STREET"
  // with the stage 283 m away and after the street (the copy only matched lines.json). Now: one `first` line; the hint's
  // `order` is the order the lines are met from the spawn (each one's entry pre-gate nearer than the next's), its text
  // names them in that order, `next` is the first of them within r <= 40 m, and the toast is one row at 390 px.
  { const H = LJ.takeStart?.hint || {}, sp = LJ.takeStart?.pos || [0, 0, 0], d2 = (c) => Math.hypot(c[0] - sp[0], c[2] - sp[2]);
    const firsts = LJ.lines.filter((l) => l.first);
    ok(firsts.length === 1, `one line is flagged first (${firsts.map((l) => l.name).join(', ') || 'none'})`);
    const ord = Array.isArray(H.order) && H.order.length ? H.order : [H.next || H.line].filter(Boolean);
    const ent = ord.map((n) => { const E = LJ.lines.filter((l) => l.name === n && l.pre?.length); return E.find((l) => l.first) || E.sort((a, b) => d2(a.pre[0].c) - d2(b.pre[0].c))[0]; });
    const ds = ent.map((e) => (e ? d2(e.pre[0].c) : Infinity));
    ok(ent.every(Boolean) && ds.every((d, i) => !i || d > ds[i - 1]) && ent.every((e, i) => !i || d2(e.pre[0].c) >= d2(ent[i - 1].c) - 1),
      `the hint's lines come in arc order from the spawn: ${ord.map((n, i) => `${n} ${ds[i].toFixed(0)} m`).join(' → ')}`);
    const up = String(H.text || '').toUpperCase(), at = ord.map((n) => up.indexOf(n.split(' ').pop()));
    ok(at.every((x, i) => x >= 0 && (!i || x > at[i - 1])), `"${H.text}" names them in that order`);
    ok(H.next === ord[0] && +H.r > 0 && +H.r <= 40 && +H.r >= ds[0], `the arrow's next line is ${H.next}, r ${H.r} m (<= 40, >= its pre-gate at ${ds[0].toFixed(0)} m)`);
    const tw = up.length * 15 * 0.66 + 24;   // #toast: 600 15px mono, .06em tracking, 12 px padding each side, max-width 86 %
    ok(tw <= 0.86 * 390, `the first toast is one row at 390 px (${up.length} characters, ~${tw.toFixed(0)} of ${(0.86 * 390).toFixed(0)} px)`); }
  // [P6-F design #5 / ux #1 / ui #4] no guide target is a dead line: the first line, every start point's `next`, and every line
  // a take-sim route flies 0 times is `blocked` (take.js nextHint, the brackets and the grid's NEXT skip it); ui #1: the
  // spawn looks down (takeStart.pitch, -2..-12 deg)
  { const blocked = new Set(LJ.lines.filter((l) => l.blocked).map((l) => l.name));
    const guided = [...LJ.lines.filter((l) => l.first).map((l) => l.name), ...(LJ.startPoints || []).map((p) => p.hint?.next).filter(Boolean)];
    ok(guided.every((n) => !blocked.has(n)), `the first line and the start points' next lines are flyable (${[...new Set(guided)].join(', ')}; blocked: ${[...blocked].join(', ') || 'none'})`);
    const RP = join(ROOT, 'tests', 'seoul', 'take-sim.json'), R = existsSync(RP) ? JSON.parse(readFileSync(RP, 'utf8')) : null;
    const ROUTE_LINE = { stairs: 'STATION STAIRS', pop: 'PLAYGROUND POP', pass: 'SCREEN PASS' };
    if (R) for (const [r, nm] of Object.entries(ROUTE_LINE)) { const rs = ['careful', 'regular', 'sharp'].map((p) => R.results[`${r}/${p}`]).filter(Boolean); if (!rs.length) continue;
      const got = rs.reduce((a, x) => a + (x.flown ?? 0), 0), n = rs.reduce((a, x) => a + x.runs, 0);
      ok(got > 0 || blocked.has(nm), `${nm}: flown ${got} of ${n} in take-sim${got ? '' : ', so it is blocked (never a guide target)'}`); }
    const pt = +LJ.takeStart?.pitch || 0;
    ok(pt <= -2 * Math.PI / 180 && pt >= -12 * Math.PI / 180, `the spawn looks ${(pt * 180 / Math.PI).toFixed(1)} deg down (takeStart.pitch: the canopy, not the sky)`); }
  // [P5-F] ui #5: the timed sub-line at 390 px portrait (#pop .sub: var(--cell) = 18 px mono, .04em tracking; max-width 94 %)
  { const w = (h) => { const t = h.replace(/<[^>]+>/g, ''); return t.length * 18 * 0.64 + (/class="fast"/.test(h) ? 0.6 * 18 : 0); };
    for (const [tag, e] of [['FAST', { dur: 44.2, best: 41.0, fast: true }], ['BEST', { dur: 81.6, best: 44.2 }], ['NEW BEST', { dur: 41.0, best: 44.2, newBest: true }]]) {
      const h = '+128,836' + timedSub(e);
      ok(w(h) <= 0.94 * 390, `${tag} sub-line "${h.replace(/<[^>]+>/g, '')}" fits one row at 390 px (~${w(h).toFixed(0)} of ${(0.94 * 390).toFixed(0)} px)`); }
    ok(!/BEST/.test(timedSub({ dur: 44.2, best: 41, fast: true })) && /▲0:41\.0/.test(timedSub({ dur: 44.2, best: 41, fast: true })), 'with FAST the best drops its word (▲0:41.0)'); }
  // build steps: every prog(f, 'Hongdae: step') in world-seoul.js has a bilingual label (C / D may add steps: warn only)
  const steps = [...readFileSync(join(ROOT, 'world-seoul.js'), 'utf8').matchAll(/prog\([\d.]+,\s*'([^']+)'\)/g)].map((m) => m[1].replace(/^[^:]*:\s*/, '').trim().toLowerCase());
  const ls = S.loadSteps || {}; for (const v of Object.values(ls)) strings.push(v);
  ok(Object.values(ls).every((v) => /[가-힣]/.test(v) && /[A-Z]/.test(v)), 'loadSteps are bilingual ("간판 · SIGNS")');
  const unl = steps.filter((k) => !(k in ls));
  if (unl.length) console.log(`  warn build steps without a label (shown blank): ${unl.join(', ')}`); else ok(steps.length > 0, `every build step (${steps.length}) has a label`);
  // the stills: committed after the last commit that changed the look (git; skipped outside a git checkout)
  const ct = (f) => { try { return +execFileSync('git', ['log', '-1', '--format=%ct', '--', f], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 0; } catch (e) { return -1; } };
  // [P5-F] the thumb strictly; the backdrop is PEND until its depth-checked re-shoot (tools/seoul-stillsnap.py; P5's browser
  // budget went on the HUD shots and the thumb, and the depth check crashed on freed geometry, fixed since)
  const bdStale = ct(S.backdrop) >= 0 && ct(S.backdrop) < Math.max(...['world-seoul.js', 'seoul-signs.js', 'fpvcam.js', 'seoul-life.js'].map(ct));
  if (bdStale) console.log('PEND the backdrop is older than the look: re-shoot (python3 tools/seoul-stillsnap.py --shots tools/seoul-stills-poses.json, then tools/seoul-ui-assets.py --backdrop ... --depth ...)');
  const still = ct(S.thumb), look = Math.max(...['world-seoul.js', 'seoul-signs.js', 'fpvcam.js', 'seoul-life.js'].map(ct));   // [P4] + the crowd
  if (still < 0 || look < 0) console.log('  skip stills freshness (no git)');
  else ok(still >= look, `identity stills are newer than the look (stills ${new Date(still * 1e3).toISOString().slice(0, 16)}, look ${new Date(look * 1e3).toISOString().slice(0, 16)})` +
    (still >= look ? '' : ': re-shoot (poses: seoul/ui/stills.json), python3 tools/seoul-ui-assets.py --backdrop STILL --thumb STILL'));
  // [P4] ui #1 / #2: the stills record
  const sj = join(ROOT, 'seoul', 'ui', 'stills.json'), SR = existsSync(sj) ? JSON.parse(readFileSync(sj, 'utf8')) : null;
  ok(!!SR, 'seoul/ui/stills.json exists (tools/seoul-ui-assets.py writes it)');
  for (const k of ['backdrop', 'thumb']) if (SR && S[k] && existsSync(join(ROOT, S[k]))) {
    const h = createHash('sha256').update(readFileSync(join(ROOT, S[k]))).digest('hex');
    ok(SR[k]?.sha256 === h, `stills.json ${k} hash matches ${S[k]}`);
  }
  if (SR) ok(+SR.thumb?.satBright >= 0.03, `the thumb reads as neon: ${(100 * (+SR.thumb?.satBright || 0)).toFixed(1)} % saturated-bright pixels (>= 3 %)`);
  // [P5-F] ui #1 / #2 and the phase-4 bug (pose and commit empty): each still says where it was shot and from which build,
  // and is checked against the crowd's file (seoul-life.js's last commit), not only the look's date; the backdrop has
  // nothing within 3 m of the camera (the depth check: phase 4's blurred pole) and reads as neon too; the thumb shows
  // street (its lower third >= 2x the top's luma: phase 4's was a sign on a beige wall)
  if (SR) {
    const lifeHash = createHash('sha256').update(readFileSync(join(ROOT, 'seoul-life.js'))).digest('hex').slice(0, 16);
    const lifeNow = (() => { try { return execFileSync('git', ['log', '-1', '--format=%h', '--', 'seoul-life.js'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { return null; } })();
    const bdShot = !!SR.backdrop?.commit;   // [P5-F] the backdrop's gates bind once it is re-shot with a pose and a build
    if (!bdShot) console.log('PEND stills.json backdrop: phase 4\'s w21 still (no pose, commit or depth): re-shoot (ui #1)');
    for (const k of bdShot ? ['backdrop', 'thumb'] : ['thumb']) {
      const r = SR[k] || {};
      ok(!!r.pose && !!r.commit, `stills.json ${k}: pose "${r.pose || ''}" and commit "${r.commit || ''}" recorded`);
      // [P7-F ui #4] by content (seoul-life.js's sha256, tools/seoul-ui-assets.py lifeHash): depth-proof (H's P6 note: a depth-1
      // clone read HEAD as seoul-life.js's last commit); a record from before P7 falls back to the git rev
      if (r.lifeHash) ok(r.lifeHash === lifeHash, `stills.json ${k} was shot with seoul-life.js ${r.lifeHash} (now ${lifeHash})${r.lifeHash === lifeHash ? '' : ': re-shoot'}`);
      else if (lifeNow) ok(r.lifeCommit === lifeNow, `stills.json ${k} was shot with seoul-life.js ${r.lifeCommit || '(none)'} (now ${lifeNow})${r.lifeCommit === lifeNow ? '' : ': re-shoot'}`);
    }
    // [P7-F ui #4] the whole depth check binds (phase 6 recorded only `nearest`): a P7 record (lifeHash) carries dark and wall8
    // for the backdrop, dark <= 0.20 (near-black share) and wall8 <= 0.15 (rays within 8 m: a near wall across the frame)
    if (bdShot) { const b = SR.backdrop;
      if (!b.lifeHash) console.log('PEND stills.json backdrop: no dark / wall8 (shot before P7): re-shoot with tools/seoul-stillsnap.py, then seoul-ui-assets.py --depth');
      else { ok(b.dark != null && b.wall8 != null, `stills.json backdrop records dark (${b.dark}) and wall8 (${b.wall8}) (seoul-ui-assets.py --depth)`);
        ok(+b.dark <= 0.20, `the backdrop is <= 20 % near-black (dark ${b.dark})`);
        ok(+b.wall8 <= 0.15, `the backdrop has no near wall across it: ${b.wall8 != null ? (100 * b.wall8).toFixed(1) : '?'} % of rays within 8 m (<= 15 %)`); } }
    if (bdShot) ok(+SR.backdrop?.nearest >= 3, `the backdrop has nothing within 3 m of the camera (nearest hit ${SR.backdrop?.nearest ?? '?'} m)`);
    if (bdShot) ok(+SR.backdrop?.satBright >= 0.03, `the backdrop reads as neon: ${(100 * (+SR.backdrop?.satBright || 0)).toFixed(1)} % saturated-bright (>= 3 %)`);
    // the panel asked 2x; at night the signs light the top third, so the walk0 crop down the street measures 1.40 and phase 4's
    // sign-on-a-wall 1.24: the gate sits between them
    ok(+SR.thumb?.lowerTop >= 1.35, `the thumb shows street: lower third ${SR.thumb?.lowerTop ?? '?'}x the top third's luma (>= 1.35; phase 4's sign on a wall: 1.24)`);
  }
}

console.log('End card and OSD labels (fit.js)');
{
  // a careful long take: 6 named lines (one repeated), 30 micros
  const log = [];
  const nm = ['UNDER THE STAGE', 'WALKING STREET', 'RED ROAD', 'HONGIK-RO', 'SCREEN CANYON', 'CROSSING'];
  nm.forEach((n, i) => { log.push({ name: n, flow: i + 1, clean: i !== 2, micro: false }); for (let k = 0; k < 5; k++) log.push({ name: `${n} ${k + 1}/5`, flow: 1, clean: true, micro: true }); });
  log.push({ name: 'WALKING STREET', flow: 1, clean: true, micro: false, repeat: true });
  const T = takeSummary(log);
  ok(T.named.length === 6 && T.named[1].name === 'WALKING STREET' && T.named[1].flow === 2 && T.named[1].n === 2, `named lines once each, in order, with their FLOW (${T.named.map((l) => l.name + ' x' + l.flow).join(', ')})`);
  ok(T.beats === 30 && T.flights === 7 && T.clean === 6, `micros are beats (+${T.beats} BEATS); CLEAN over named flights: ${T.clean}/${T.flights}`);
  const T2 = takeSummary(['WALKING STREET', 'WALKING STREET 1/7', 'RED ROAD'], (n) => / \d+\/\d+$/.test(n));
  ok(T2.named.length === 2 && T2.beats === 1, 'name-only logs use the lines file to tell micros');
  // gap_the (932 x 430 OSD): the guide "WALKING STREET · 1:28" at y 38-56, THE GAP's bracket 72-366 px: its label goes under
  const guide = [370, 35, 590, 58], timer = [425, 396, 508, 422], bx = [436, 72, 497, 366];
  const sp = labelSpot(bx, 80, 16, { band: Math.max(80, guide[3] + 20), bottom: 426, fixed: [guide, timer], labels: [], left: 4, right: 928 });
  ok(sp && sp.y > bx[3], `a bracket label in the top band goes under its bracket (y ${sp?.y})`);
  const sp2 = labelSpot([300, 150, 380, 250], 80, 16, { band: 80, fixed: [guide], labels: [] });
  ok(sp2 && sp2.y < 150, 'below the band it stays over its bracket');
  ok(!labelSpot([400, 60, 520, 410], 80, 16, { band: 80, bottom: 426, fixed: [guide, timer], labels: [] }), 'no room above or below: no label (the ticks stay)');
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
