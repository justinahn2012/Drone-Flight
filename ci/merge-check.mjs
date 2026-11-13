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
//   node ci/merge-check.mjs --no-ci-logs     [P7 H] skip the last step: every FAIL row CI printed for the merge's parents must
//                                            be tolerated by the merge's ci/known-failures.json (gh; ci/known-guard.mjs)
//   node ci/merge-check.mjs --browser        [P9 H, panel8 native #1] + ci.yml's `browser` and `browser-seoul` jobs: the game in
//                                            headless Chromium (SwiftShader), the Seoul stills and goldens, budgets, and the
//                                            camera gate (tools/camgate.py) with CI's known-failure ratchet. ~15-25 min more on
//                                            the 8 GB box. REQUIRED for a push to main (ci/hooks/pre-push).
//   node ci/merge-check.mjs --browser-only   only the two browser jobs (a commit whose node run is already recorded green;
//                                            the record keeps both halves per sha)
//   --min-free 3072 --lock-wait 30           [P9 H] the browser steps wait for /tmp/onetake-browser.lock (the box's shared
//                                            browser lock: seoulsnap, hudsnap) and for MemAvailable >= min-free MB, at most
//                                            lock-wait minutes; past that the step is RED ("not run"), never skipped green
//   --hold-file PATH                         [P9 H] no step starts while PATH exists (env ONETAKE_HOLD_FILE)
//
// [P6 H, native #1] It runs in a fresh clone of the committed HEAD, fetched at the depth CI's checkout uses (the `test`
// job's `fetch-depth` in ci.yml: 0 = full history, absent = actions/checkout's default of 1). Phase 5's red main came
// from exactly that gap: CI's depth-1 checkout dated every file at HEAD, the full local clone did not, so the gate was
// green on a merge CI failed. The clone also has no untracked or ignored files (a local bake, exports/, a stale log), so
// a step that passes here passes on the runner. node_modules is linked from this tree's ci/node_modules.
//
// The steps come from .github/workflows/ci.yml itself, so this never drifts from CI. [P9 H] The browser jobs run with
// --browser (main 9850b8f went red in browser-seoul + camgate on a merge whose node-only check was green): Playwright is
// the version ci/package.json pins (installed once into ~/.cache/onetake-ci when ci/node_modules lacks it), with its own
// Chromium build, so the stills are drawn by the binary CI draws them with. Each step runs
// in bash from the repo root with RUNNER_TEMP set to a scratch dir; output goes to ci-merge-check/<n>-<step>.log and the
// table at the end names every red step. Exit 0 only when every step passed.
//
// On success it writes .git/onetake-merge-check.json {sha, tree, ok, at, steps}. ci/hooks/pre-push refuses a push to
// main whose commit has no green record (install once: git config core.hooksPath ci/hooks). The safer flow, which makes
// main's CI a real gate: push the merge to integ/<phase>, wait for CI green, then fast-forward main to that same commit
// (git push origin integ/<phase>:main); see PORTING.md section 10.
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, realpathSync, rmSync, readdirSync } from 'node:fs';
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
const BROWSER_ONLY = flag('--browser-only'), BROWSER = BROWSER_ONLY || flag('--browser');
const NODE_JOBS = ['test', 'audio'], BROWSER_JOBS = ['browser', 'browser-seoul'];
const JOBS = [...(BROWSER_ONLY ? [] : NODE_JOBS), ...(BROWSER ? BROWSER_JOBS : []), ...(HAS_SWIFT && !flag('--no-native') && !BROWSER_ONLY ? ['native-linux'] : [])];
// [P9 H] --hold-file PATH (or $ONETAKE_HOLD_FILE): while that file exists no step starts (a box-wide "heavy jobs wait"
// window, e.g. /home/claude/review/seoul/p9/HOLD-HEAVY while other streams verify in the browser)
const HOLD = opt('--hold-file') ?? process.env.ONETAKE_HOLD_FILE ?? null;
const MIN_FREE = +(opt('--min-free') ?? 3072), LOCK_WAIT = +(opt('--lock-wait') ?? 30), BROWSER_LOCK = '/tmp/onetake-browser.lock';

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
/** [P9 H] A browser job's step as it runs on the box: tests/browser.mjs takes the shared browser lock and waits for free
 *  memory (8 GB box: two SwiftShader runs at once have OOM-killed both); a pip install is skipped when the modules import. */
export function boxStep(s, minFree = MIN_FREE, lockWait = LOCK_WAIT, lock = BROWSER_LOCK) {
  if (!BROWSER_JOBS.includes(s.job)) return s;
  let run = s.run.replace(/^(\s*)python3? -m pip install ([^\n]*?)((?:\s+[\w-]+)+)\s*$/m, (m, ind, opts, mods) => {
    const im = mods.trim().split(/\s+/).filter((x) => !x.startsWith('-')).map((x) => (x === 'pillow' ? 'PIL' : x));
    return `${ind}python -c 'import ${im.join(', ')}' 2>/dev/null || ${m.trim()}`;
  });
  if (/tests\/browser\.mjs/.test(run)) {
    const wait = Math.round(lockWait * 60);
    // memwait: MemAvailable >= minFree, polled; the step runs once more when Chromium was killed (the box's memory cgroup
    // OOM-kills chrome first, oom_score_adj 300: "Target crashed" while a neighbour's node job grew), never on a test FAIL
    const guard = `memwait() { t0=$(date +%s); while :; do a=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo); [ "$a" -ge ${minFree} ] && ${HOLD ? `[ ! -e '${HOLD}' ] && ` : ''}break; ` +
      `[ $(( $(date +%s) - t0 )) -ge ${wait} ] && { echo "FAIL merge-check: browser step not run: MemAvailable $a MB < ${minFree} MB after ${lockWait} min (free -m; stop the other browser / heavy node job)"; exit 3; }; sleep 15; done; ` +
      `echo "merge-check: browser lock held, MemAvailable $a MB"; }\n` +
      `memwait; o=$(mktemp); set +e\n( ${run.replace(/\n/g, '\n')} ) 2>&1 | tee "$o"; c=\${PIPESTATUS[0]}\n` +
      `if [ $c != 0 ] && grep -qE "Target crashed|[Bb]rowser has been closed|Browser closed|Target page, context or browser has been closed" "$o"; then ` +
      `echo "::warning::merge-check: Chromium was killed (the box's OOM killer?), not a test FAIL: one more run once memory is back"; ` +
      `dmesg 2>/dev/null | grep -i "killed process" | tail -1; memwait; ( ${run.replace(/\n/g, '\n')} ) 2>&1 | tee "$o"; c=\${PIPESTATUS[0]}; fi\n` +
      `rm -f "$o"; exit $c`;
    const q = (x) => `'${x.replace(/'/g, `'\\''`)}'`;
    run = `flock -E 75 -w ${wait} ${lock} bash -o pipefail -c ${q(guard)} || { c=$?; [ $c = 75 ] && echo "FAIL merge-check: browser step not run: ${lock} still held after ${lockWait} min"; exit $c; }`;
  }
  return { ...s, run };
}
let steps = workflowSteps(yml, JOBS)
  .filter((s) => !/npm ci|apt-get|playwright install/.test(s.run))   // installs: the local tree has its node_modules
  .map((s) => boxStep(s))
  .filter((s) => !ONLY.length || ONLY.some((w) => s.name.toLowerCase().includes(w)))
  .filter((s) => !SKIP.some((w) => s.name.toLowerCase().includes(w) || s.job === w));
// [P7 H, panel6 native #1] the merge's parents' CI rows, judged against the merge's known list (needs gh; ci/known-guard.mjs)
const HAS_GH = (() => { try { execSync('gh run list -R justinahn2012/Drone-Flight -L 1', { stdio: 'ignore', timeout: 20000 }); return true; } catch (e) { return false; } })();
if (HAS_GH && !flag('--no-ci-logs') && (!ONLY.length || ONLY.some((w) => 'known'.includes(w) || w.includes('known'))) && !SKIP.some((w) => w.includes('known')))
  steps.push({ job: 'merge', name: "Parents' CI rows are covered by this merge's known list (H; ci/known-guard.mjs --ci-logs)", run: 'node ci/known-guard.mjs --ci-logs' });
if (flag('--list') || !steps.length) { for (const s of steps) console.log(`[${s.job}] ${s.name}\n    ${s.run.split('\n').join('\n    ')}`); if (!steps.length) console.log('no steps matched'); process.exit(steps.length ? 0 : 2); }

const MODS = existsSync(join(ROOT, 'ci/node_modules')) ? join(ROOT, 'ci/node_modules') : existsSync(join(ROOT, 'node_modules')) ? realpathSync(join(ROOT, 'node_modules')) : null;
if (!MODS) { console.log('FAIL no node_modules: npm ci --prefix ci && ln -s ci/node_modules node_modules'); process.exit(1); }
const LOGS = join(ROOT, 'ci-merge-check'), TEMP = join(tmpdir(), `onetake-merge-check-${process.pid}`);
mkdirSync(LOGS, { recursive: true }); mkdirSync(TEMP, { recursive: true });
// [P9 H] --browser: Playwright at ci/package.json's version and the Chromium build it pins (CI's binary; the box's
// /opt/pw-browsers is another revision). Installed once into ~/.cache/onetake-ci (or $ONETAKE_PW_CACHE); the clone's
// node_modules becomes an overlay of MODS + playwright, so nothing is written to ci/ or the shared node_modules.
let NM = MODS, BROWSER_ENV = {};
if (BROWSER) {
  const want = JSON.parse(readFileSync(join(ROOT, 'ci/package.json'), 'utf8')).devDependencies.playwright;
  const ver = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'playwright/package.json'), 'utf8')).version; } catch (e) { return null; } };
  const CACHE = process.env.ONETAKE_PW_CACHE || join(process.env.HOME || tmpdir(), '.cache/onetake-ci');
  let pwDir = ver(MODS) === want ? MODS : ver(join(CACHE, 'node_modules')) === want ? join(CACHE, 'node_modules') : null;
  const sh = (c, t = 900) => { try { execSync(c, { stdio: ['ignore', 'pipe', 'pipe'], timeout: t * 1000 }); return true; } catch (e) { console.log(String(e.stderr || e.message).trim().split('\n').slice(-3).join('\n')); return false; } };
  if (!pwDir) {
    console.log(`merge-check: installing playwright@${want} into ${CACHE} (once)`);
    mkdirSync(CACHE, { recursive: true });
    if (sh(`npm install --prefix "${CACHE}" --no-audit --no-fund --ignore-scripts --no-save playwright@${want}`) && ver(join(CACHE, 'node_modules')) === want) pwDir = join(CACHE, 'node_modules');
  }
  if (!pwDir) { console.log(`FAIL --browser: no playwright@${want} (npm install --prefix ~/.cache/onetake-ci playwright@${want})`); process.exit(1); }
  // CI's Chromium build: the browsers dir that holds this playwright's revision, else download it next to the cache
  const exe = (bp) => { try { return execSync(`node -e "process.stdout.write(require('playwright').chromium.executablePath())"`, { cwd: dirname(pwDir), env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: bp }, encoding: 'utf8' }); } catch (e) { return ''; } };
  const shell = (bp) => existsSync(exe(bp).replace(/chromium-(\d+)\/chrome-linux64\/chrome$/, 'chromium_headless_shell-$1')) && existsSync(exe(bp));
  const own = join(CACHE, 'browsers');
  let BP = [process.env.PLAYWRIGHT_BROWSERS_PATH, own].filter(Boolean).find(shell);
  if (!BP) { console.log(`merge-check: downloading playwright@${want}'s Chromium into ${own} (once, ~300 MB)`); if (sh(`PLAYWRIGHT_BROWSERS_PATH="${own}" node "${join(pwDir, 'playwright/cli.js')}" install chromium`) && shell(own)) BP = own; }
  if (BP) BROWSER_ENV.PLAYWRIGHT_BROWSERS_PATH = BP;
  else if (existsSync('/usr/bin/google-chrome')) { BROWSER_ENV.CHROME = '/usr/bin/google-chrome'; console.log("::warning::merge-check: CI's Chromium build is not on this box; using /usr/bin/google-chrome (stills may differ from CI's by a little)"); }
  if (pwDir !== MODS) {
    NM = join(TEMP, 'node_modules'); mkdirSync(NM, { recursive: true });
    for (const e of readdirSync(MODS)) if (!e.startsWith('.') && e !== 'playwright' && e !== 'playwright-core') symlinkSync(join(MODS, e), join(NM, e));
    for (const e of ['playwright', 'playwright-core']) symlinkSync(join(pwDir, e), join(NM, e));
  }
  console.log(`merge-check: --browser: playwright ${want} (${pwDir === MODS ? 'ci/node_modules' : pwDir}), ${BP ? `Chromium from ${BP}` : `CHROME=${BROWSER_ENV.CHROME}`}; browser steps take ${BROWSER_LOCK} and wait for ${MIN_FREE} MB free (<= ${LOCK_WAIT} min)`);
  if (IN_PLACE && pwDir !== MODS) { console.log('FAIL --browser --in-place needs playwright in ci/node_modules (the clone mode overlays it)'); process.exit(1); }
}
const git = (c, cwd = ROOT) => { try { return execSync(`git ${c}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return null; } };
const sha = git('rev-parse HEAD'), dirty = !!git('status --porcelain --untracked-files=no');
// [P6 H] the tree the steps run in: a clone of HEAD at CI's depth (default), or this tree (--in-place)
let WORK = ROOT, depth = null;
if (!IN_PLACE) {
  if (!sha) { console.log('FAIL not a git checkout: run with --in-place'); process.exit(1); }
  depth = DEPTH_OPT != null ? +DEPTH_OPT : checkoutDepth(yml, 'test');
  WORK = join(TEMP, 'repo'); mkdirSync(WORK, { recursive: true });
  const t0 = Date.now();
  // [P9 H] full history (CI's depth 0) borrows this repository's objects (git alternates, as `git clone --shared`): the
  // same commits and file dates in ~1 s, where a file:// fetch packed 220 MB for 10+ min on the loaded 8 GB box
  const shared = () => { const common = resolve(ROOT, git('rev-parse --git-common-dir')); mkdirSync(join(WORK, '.git/objects/info'), { recursive: true });
    writeFileSync(join(WORK, '.git/objects/info/alternates'), join(common, 'objects') + '\n');
    if (existsSync(join(common, 'shallow'))) writeFileSync(join(WORK, '.git/shallow'), readFileSync(join(common, 'shallow')));
    return git(`update-ref refs/heads/merge-check ${sha}`, WORK) !== null && git('checkout -q merge-check', WORK) !== null; };
  const okClone = git('init -q', WORK) !== null && (depth === 0 ? shared() : git(`fetch -q --depth ${depth} "file://${ROOT}" ${sha}`, WORK) !== null && git('checkout -q FETCH_HEAD', WORK) !== null);
  if (!okClone) { console.log(`FAIL could not clone ${sha.slice(0, 7)} into ${WORK}`); process.exit(1); }
  symlinkSync(NM, join(WORK, 'node_modules'));
  if (depth === 0 && git('rev-parse --is-shallow-repository') === 'true') console.log(`::warning::merge-check: this repository is itself shallow (${git('rev-list --count HEAD')} commits): "full history" is all it has; CI's clone of GitHub has every commit`);
  console.log(`merge-check: a fresh clone of ${sha.slice(0, 7)} at ${depth > 0 ? `depth ${depth}` : 'full history'} (CI's test checkout: ${checkoutDepth(yml, 'test') || 'full'}; ${git('rev-parse --is-shallow-repository', WORK) === 'true' ? 'shallow' : 'not shallow'}), ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${WORK}`);
} else if (!existsSync(join(ROOT, 'node_modules'))) symlinkSync('ci/node_modules', join(ROOT, 'node_modules'));
console.log(`merge-check: ${steps.length} steps of ${JOBS.join(', ')} on ${sha?.slice(0, 7) ?? '(no git)'}` + (IN_PLACE ? (dirty ? ' in place (uncommitted changes: the record will not count for a push)' : ' in place') : (dirty ? ' (the clone holds HEAD only: your uncommitted changes are not tested)' : '')));

const holdWait = async () => { if (!HOLD || !existsSync(HOLD)) return; const t0 = Date.now(); process.stdout.write(`(waiting: ${HOLD} exists) `);
  while (existsSync(HOLD)) await new Promise((r) => setTimeout(r, 15000)); process.stdout.write(`(${Math.round((Date.now() - t0) / 1000)} s) `); };
const run = async (s, n) => { await holdWait(); return run1(s, n); };
const run1 = (s, n) => new Promise((res) => {
  const t0 = Date.now(), log = join(LOGS, `${String(n).padStart(2, '0')}-${s.name.replace(/[^\w]+/g, '-').slice(0, 50)}.log`);
  const p = spawn('bash', ['-eo', 'pipefail', '-c', s.run], { cwd: s.cwd ? join(WORK, s.cwd) : WORK, env: { ...process.env, ...(BROWSER_JOBS.includes(s.job) ? BROWSER_ENV : {}), RUNNER_TEMP: TEMP, GITHUB_WORKSPACE: WORK, CI: 'merge-check' } });
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
  // [P9 H] the record holds both halves per sha: `node` (test + audio + the parents' CI rows) and `browser` (browser +
  // browser-seoul + camgate). A --browser-only run on a commit whose node half is recorded completes it; pre-push wants both.
  const gitDir = git('rev-parse --git-dir'), file = gitDir && resolve(ROOT, gitDir, 'onetake-merge-check.json');
  let prev = null; try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {}
  if (prev?.sha !== sha || !prev.ok) prev = null;
  const node = !BROWSER_ONLY || !!prev?.node, browser = BROWSER || !!prev?.browser;
  const rec = { sha, tree: git('rev-parse HEAD^{tree}'), ok, node, browser, at: new Date().toISOString(), mode: IN_PLACE ? 'in-place' : `clone depth ${depth || 'full'}`,
    steps: [...(prev?.steps || []).filter((x) => !results.some((r) => r.job === x.job)), ...results.map((r) => ({ job: r.job, name: r.name, sec: r.sec }))] };
  if (file) writeFileSync(file, JSON.stringify(rec, null, 1));
  console.log(`recorded: ${sha.slice(0, 7)} node ${node ? 'green' : 'NOT RUN'}, browser ${browser ? 'green' : 'NOT RUN'}` +
    (node && browser ? ' (ci/hooks/pre-push lets it reach main)' : ` (pre-push wants both: run node ci/merge-check.mjs ${node ? '--browser-only' : '--browser'})`));
} else if (ok) console.log('(not recorded: a partial run (--only / --skip), a --depth other than CI\'s, or uncommitted changes in place)');
if (!IN_PLACE && !flag('--keep-clone')) { try { rmSync(TEMP, { recursive: true, force: true }); } catch (e) {} }
process.exit(ok ? 0 : 1);
