// ci/run.mjs: run one suite and tolerate only its declared known failures (P3 H, native #1).
//   node ci/run.mjs tests/seoul-life.mjs [args...]        a node suite (.mjs / .js run with this node)
//   node ci/run.mjs python3 tools/camgate.py [args...]    any other command
// The suite's output streams through unchanged. Exit code:
//   0  the suite passed, or every FAIL line it printed matches a ci/known-failures.json entry for that suite (each one
//      becomes a ::warning:: annotation naming its owner), and it did not crash (no stack trace, exit 1);
//   else the suite's own code (an unknown FAIL, a crash, a signal).
// A known entry whose failure no longer shows prints a ::notice:: (remove it from the list); it never fails the build, so a
// partner's fix landing on main turns the entry stale rather than red. The list is the debt: each entry names an owner.
// [P4 H] Ratchet: an entry may carry `limit: { re, min?, max? }`. `re` captures one number from the FAIL line; outside
// [min, max] the line counts as a regression (it fails CI even though the row is known). A known failure may get better,
// never worse, so the gate stays binding while the owner works on it (panel3 native.md: the old "[colour]" and ": EV "
// entries tolerated any value of any shot).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (!argv.length) { console.error('usage: node ci/run.mjs <suite.mjs | command> [args...]'); process.exit(2); }
const [cmd, args] = /\.(m?js)$/.test(argv[0]) ? [process.execPath, argv] : [argv[0], argv.slice(1)];
const script = argv.find((x) => /\.(m?js|py)$/.test(x)) || argv[0];
const suite = relative(ROOT, resolve(script)).split('\\').join('/');
let known = [];
try { known = JSON.parse(readFileSync(resolve(ROOT, 'ci/known-failures.json'), 'utf8')).known.filter((k) => k.suite === suite); }
catch (e) { console.log(`::warning::ci/known-failures.json unreadable (${e.message}): no failures tolerated`); }
const isFail = (l) => /^\s*FAIL\b/.test(l);
const lines = { out: '', err: '' }, fails = [];
let crashed = false;
const scan = (k, chunk, sink) => {
  sink.write(chunk);
  lines[k] += chunk.toString();
  const parts = lines[k].split('\n'); lines[k] = parts.pop();
  for (const l of parts) { if (isFail(l)) fails.push(l.trim()); if (k === 'err' && /^\s+at .+\(.+:\d+:\d+\)$|^\s+at file:/.test(l)) crashed = true; }
};
const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
p.stdout.on('data', (c) => scan('out', c, process.stdout));
p.stderr.on('data', (c) => scan('err', c, process.stderr));
p.on('close', (code, signal) => {
  for (const k of ['out', 'err']) if (lines[k] && isFail(lines[k])) fails.push(lines[k].trim());
  const matchOf = (l) => known.find((k) => l.includes(k.match));
  const seen = new Set(fails.map(matchOf).filter(Boolean));
  for (const k of known) if (!seen.has(k)) console.log(`::notice title=known failure gone::${suite}: "${k.match}" no longer fails (${k.owner}); remove it from ci/known-failures.json`);
  // [P4 H] ratchet: a known row past its entry's limit is a regression
  const worse = (l) => { const k = matchOf(l), L = k?.limit; if (!L) return null; const m = new RegExp(L.re).exec(l), v = m ? +m[1] : NaN;
    if (!Number.isFinite(v)) return `the limit's pattern /${L.re}/ found no number`;
    if (L.min != null && v < L.min) return `${v} < the tolerated ${L.min}`; if (L.max != null && v > L.max) return `${v} > the tolerated ${L.max}`; return null; };
  const regressed = fails.filter((l) => worse(l));
  for (const l of regressed) console.log(`::error title=known failure got worse (${matchOf(l).owner})::${suite}: ${l.slice(0, 300)} | ${worse(l)} (ci/known-failures.json limit)`);
  if (code === 0) process.exit(0);
  const unknown = fails.filter((l) => !matchOf(l) || worse(l));
  if (signal || code !== 1 || crashed || !fails.length || unknown.length) {
    if (unknown.length) console.log(`::error title=${suite}::${unknown.length} failure(s) not tolerated by ci/known-failures.json (unlisted, or past a limit): ${unknown.slice(0, 5).join(' | ').slice(0, 900)}`);
    else if (!fails.length || crashed || signal) console.log(`::error title=${suite}::exited ${signal || code} ${crashed ? 'with a stack trace' : fails.length ? '' : 'without a FAIL line'}`);
    process.exit(code || 1);
  }
  for (const l of fails) { const k = matchOf(l); console.log(`::warning title=known failure (${k.owner})::${suite}: ${l.slice(0, 400)} | ${k.why}`); }
  console.log(`ci/run.mjs: ${suite}: ${fails.length} known failure(s) tolerated, nothing else failed`);
  process.exit(0);
});
