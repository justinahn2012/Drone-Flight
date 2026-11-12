#!/usr/bin/env node
// ci/merge-check.mjs: run CI's node suites on a merge BEFORE it is pushed to main (P5 H, native #1: main was red three
// phases running because every branch was green alone and nobody ran the suites on the merge).
//
//   node ci/merge-check.mjs                  every `run:` step of the workflow's `test` and `audio` jobs, in order, as CI
//                                            runs them (ci/run.mjs where CI uses it, so the known-failure ratchet applies)
//   node ci/merge-check.mjs --list           print the steps and exit
//   node ci/merge-check.mjs --only export,lightmap   steps whose name contains any of these words (case-insensitive)
//   node ci/merge-check.mjs --skip audio     leave out steps or jobs by name
//   node ci/merge-check.mjs --keep-going     (default) run every step even after one failed; --bail stops at the first
//   node ci/merge-check.mjs --depth 1        [P6 H] clone at this depth instead of the workflow's own (0 = full history)
//   node ci/merge-check.mjs --in-place       run in this working tree (phase 5's mode: sees untracked / ignored files)
//
// [P6 H, native #1] It runs in a fresh clone of the committed HEAD, fetched at the depth CI's checkout uses (the `test`
// job's `fetch-depth` in ci.yml: 0 = full history, absent = actions/checkout's default of 1). Phase 5's red main came
// from exactly that gap: CI's depth-1 checkout dated every file at HEAD, the full local clone did not, so the gate was
// green on a merge CI failed. The clone also has no untracked or ignored files (a local bake, exports/, a stale log), so
// a step that passes here passes on the runner. node_modules is linked from this tree's ci/node_modules.
//
// The steps come from .github/workflows/ci.yml itself, so this never drifts from CI. The browser jobs (headless
// Chromium, 25-180 min) are left out: run them with --browser if the merge touched a shader or the page. Each step runs
// in bash from the repo root with RUNNER_TEMP set to a scratch dir; output goes to ci-merge-check/<n>-<step>.log and the
// table at the end names every red step. Exit 0 only when every step passed.
//
// On success it writes .git/onetake-merge-check.json {sha, tree, ok, at, steps}. ci/hooks/pre-push refuses a push to
// main whose commit has no green record (install once: git config core.hooksPath ci/hooks). The safer flow, which makes
// main's CI a real gate: push the merge to integ/<phase>, wait for CI green, then fast-forward main to that same commit
// (git push origin integ/<phase>:main); see PORTING.md section 10.
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), flag = (f) => argv.includes(f), opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const words = (s) => (s ? s.toLowerCase().split(',').map((x) => x.trim()).filter(Boolean) : []);
const ONLY = words(opt('--only')), SKIP = words(opt('--skip'));
const IN_PLACE = flag('--in-place'), DEPTH_OPT = opt('--depth');
// [P6 H] native-linux (swift build + swift test on the export the test steps just built) joins when swift is on PATH
const HAS_SWIFT = (() => { try { execSync('swift --version', { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
const JOBS = [...(flag('--browser') ? ['test', 'audio', 'browser', 'browser-seoul'] : ['test', 'audio']), ...(HAS_SWIFT && !flag('--no-native') ? ['native-linux'] : [])];

/** The `run:` steps of the given jobs in a GitHub workflow (the subset of YAML ci.yml uses: `- name:` / `run: |` blocks,
 *  `run: cmd` one-liners, `if:` lines). -> [{ job, name, run }] */
export function workflowSteps(yml, jobs) {
  const out = [], L = yml.split('\n');
  let job = null, step = null, block = null, keyInd = 0;
  const flush = () => { if (step && step.run != null && jobs.includes(step.job)) out.push(step); step = null; };
  const endBlock = () => { const ind = Math.min(...block.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length)); step.run = block.map((l) => l.slice(ind)).join('\n').trim(); block = null; };
  for (const line of L) {
    const ind = line.match(/^ */)[0].length, t = line.trim();
    if (block) { if (!t || ind > keyInd) { block.push(line); continue; } endBlock(); }
    let m;
    if (ind === 2 && (m = /^ {2}([\w-]+):/.exec(line))) { flush(); job = m[1]; continue; }
    if (t.startsWith('- ') && ind >= 4) { flush(); m = /^- name: (.*)$/.exec(t); step = { job, name: (m ? m[1] : t.slice(2)).replace(/^['"]|['"]$/g, '') }; }
    if (!step) continue;
    const wd = /^(?:- )?working-directory: (.*)$/.exec(t); if (wd) step.cwd = wd[1].trim();   // [P6 H] native jobs
    const r = /^(?:- )?run: (.*)$/.exec(t);
    if (r) { if (/^\|/.test(r[1])) { block = []; keyInd = line.indexOf('run:'); } else step.run = r[1]; }
  }
  if (block && step) endBlock();
  flush();
  return out;
}

const yml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
/** [P6 H] actions/checkout's fetch-depth in a job of the workflow (1 when the job does not set it, as actions/checkout). */
export function checkoutDepth(yml, job) {
  const L = yml.split('\n'); let inJob = false;
  for (const line of L) {
    const m = /^ {2}([\w-]+):/.exec(line);
    if (m) { if (inJob) break; inJob = m[1] === job; continue; }
    const d = inJob && /^\s+fetch-depth:\s*(\d+)/.exec(line);
    if (d) return +d[1];
  }
  return 1;
}
let steps = workflowSteps(yml, JOBS)
  .filter((s) => !/npm ci|apt-get|playwright install/.test(s.run))   // installs: the local tree has its node_modules
  .filter((s) => !ONLY.length || ONLY.some((w) => s.name.toLowerCase().includes(w)))
  .filter((s) => !SKIP.some((w) => s.name.toLowerCase().includes(w) || s.job === w));
if (flag('--list') || !steps.length) { for (const s of steps) console.log(`[${s.job}] ${s.name}\n    ${s.run.split('\n').join('\n    ')}`); if (!steps.length) console.log('no steps matched'); process.exit(steps.length ? 0 : 2); }

const MODS = existsSync(join(ROOT, 'ci/node_modules')) ? join(ROOT, 'ci/node_modules') : existsSync(join(ROOT, 'node_modules')) ? realpathSync(join(ROOT, 'node_modules')) : null;
if (!MODS) { console.log('FAIL no node_modules: npm ci --prefix ci && ln -s ci/node_modules node_modules'); process.exit(1); }
const LOGS = join(ROOT, 'ci-merge-check'), TEMP = join(tmpdir(), `onetake-merge-check-${process.pid}`);
mkdirSync(LOGS, { recursive: true }); mkdirSync(TEMP, { recursive: true });
const git = (c, cwd = ROOT) => { try { return execSync(`git ${c}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return null; } };
const sha = git('rev-parse HEAD'), dirty = !!git('status --porcelain --untracked-files=no');
// [P6 H] the tree the steps run in: a clone of HEAD at CI's depth (default), or this tree (--in-place)
let WORK = ROOT, depth = null;
if (!IN_PLACE) {
  if (!sha) { console.log('FAIL not a git checkout: run with --in-place'); process.exit(1); }
  depth = DEPTH_OPT != null ? +DEPTH_OPT : checkoutDepth(yml, 'test');
  WORK = join(TEMP, 'repo'); mkdirSync(WORK, { recursive: true });
  const t0 = Date.now();
  const okClone = git('init -q', WORK) !== null && git(`fetch -q ${depth > 0 ? `--depth ${depth} ` : '--update-shallow '}"file://${ROOT}" ${sha}`, WORK) !== null && git('checkout -q FETCH_HEAD', WORK) !== null;
  if (!okClone) { console.log(`FAIL could not clone ${sha.slice(0, 7)} into ${WORK}`); process.exit(1); }
  symlinkSync(MODS, join(WORK, 'node_modules'));
  if (depth === 0 && git('rev-parse --is-shallow-repository') === 'true') console.log(`::warning::merge-check: this repository is itself shallow (${git('rev-list --count HEAD')} commits): "full history" is all it has; CI's clone of GitHub has every commit`);
  console.log(`merge-check: a fresh clone of ${sha.slice(0, 7)} at ${depth > 0 ? `depth ${depth}` : 'full history'} (CI's test checkout: ${checkoutDepth(yml, 'test') || 'full'}; ${git('rev-parse --is-shallow-repository', WORK) === 'true' ? 'shallow' : 'not shallow'}), ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${WORK}`);
} else if (!existsSync(join(ROOT, 'node_modules'))) symlinkSync('ci/node_modules', join(ROOT, 'node_modules'));
console.log(`merge-check: ${steps.length} steps of ${JOBS.join(', ')} on ${sha?.slice(0, 7) ?? '(no git)'}` + (IN_PLACE ? (dirty ? ' in place (uncommitted changes: the record will not count for a push)' : ' in place') : (dirty ? ' (the clone holds HEAD only: your uncommitted changes are not tested)' : '')));

const run = (s, n) => new Promise((res) => {
  const t0 = Date.now(), log = join(LOGS, `${String(n).padStart(2, '0')}-${s.name.replace(/[^\w]+/g, '-').slice(0, 50)}.log`);
  const p = spawn('bash', ['-eo', 'pipefail', '-c', s.run], { cwd: s.cwd ? join(WORK, s.cwd) : WORK, env: { ...process.env, RUNNER_TEMP: TEMP, GITHUB_WORKSPACE: WORK, CI: 'merge-check' } });
  let buf = '';
  const tee = (c) => { buf += c; if (flag('--verbose')) process.stdout.write(c); };
  p.stdout.on('data', tee); p.stderr.on('data', tee);
  p.on('close', (code) => {
    writeFileSync(log, buf);
    const fails = buf.split('\n').filter((l) => /^\s*FAIL\b|::error/.test(l)).slice(0, 4);
    res({ ...s, code, sec: Math.round((Date.now() - t0) / 1000), log, fails });
  });
});
const results = [];
for (const [i, s] of steps.entries()) {
  process.stdout.write(`  ${String(i + 1).padStart(2)}/${steps.length} [${s.job}] ${s.name.slice(0, 90)} ... `);
  const r = await run(s, i + 1); results.push(r);
  console.log(r.code === 0 ? `ok (${r.sec} s)` : `RED (exit ${r.code}, ${r.sec} s) -> ${r.log}` + (r.fails.length ? '\n        ' + r.fails.map((l) => l.trim().slice(0, 220)).join('\n        ') : ''));
  if (r.code !== 0 && flag('--bail')) break;
}
const red = results.filter((r) => r.code !== 0), ok = !red.length && results.length === steps.length;
console.log(`\nmerge-check: ${results.length - red.length} green, ${red.length} red${red.length ? ': ' + red.map((r) => `[${r.job}] ${r.name}`).join('; ') : ''}`);
if (ok && sha && (!dirty || !IN_PLACE) && !ONLY.length && !SKIP.length && (IN_PLACE || depth === checkoutDepth(yml, 'test'))) {
  const gitDir = git('rev-parse --git-dir');
  if (gitDir) writeFileSync(resolve(ROOT, gitDir, 'onetake-merge-check.json'), JSON.stringify({ sha, tree: git('rev-parse HEAD^{tree}'), ok, at: new Date().toISOString(), mode: IN_PLACE ? 'in-place' : `clone depth ${depth || 'full'}`, steps: results.map((r) => ({ job: r.job, name: r.name, sec: r.sec })) }, null, 1));
  console.log(`recorded: ${sha.slice(0, 7)} is green (ci/hooks/pre-push lets it reach main)`);
} else if (ok) console.log('(not recorded: a partial run (--only / --skip), a --depth other than CI\'s, or uncommitted changes in place)');
if (!IN_PLACE && !flag('--keep-clone')) { try { rmSync(TEMP, { recursive: true, force: true }); } catch (e) {} }
process.exit(ok ? 0 : 1);
