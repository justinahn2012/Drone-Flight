#!/usr/bin/env node
// ci/known-guard.mjs: [P7 H, panel6 native #1] a merge may not drop the CI tolerances a branch relied on.
// Phase 6's integ11 merge kept A's ci/known-failures.json and lost H's entries (raw heap, triangle budgets, spawn): main's
// browser-seoul went red on rows that had a ratchet on the branch. Two checks:
//
//   node ci/known-guard.mjs              [static, git only; a CI step of the `test` job, so merge-check runs it too]
//     When HEAD is a merge, every known entry (suite + match) of any parent must still be in HEAD's list, or the merge
//     commit's message must name it on a line `known-drop: <match>` (the integrator's word that the row now passes).
//     An entry whose match text changed carries "replaces": "<old match>" and counts as kept.
//     Also: every entry is well formed (suite, match, owner, why; a limit has re and min / max) and no two share a match.
//
//   node ci/known-guard.mjs --rev <commit>    the same for another commit (default HEAD and the working file)
//   node ci/known-guard.mjs --ci-logs [--sha <commit>...]    [needs gh; merge-check runs it when gh answers]
//     Takes the FAIL lines that CI printed for HEAD's parents (or the given commits): the latest run of each commit whose
//     job got past its gated steps. Every FAIL line of a step that runs through ci/run.mjs must be tolerated by HEAD's
//     list (an entry matches it and its value is inside the entry's limit), else it is a row with neither a pass nor a
//     known entry: the merge would turn main red on it. FAIL lines of steps without ci/run.mjs are reported as hard reds.
// Exit 0 = clean; 1 = a dropped or uncovered row (each printed as FAIL ...).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), flag = (f) => argv.includes(f);
const shaArgs = argv.flatMap((a, i) => (argv[i - 1] === '--sha' ? [a] : []));
const REV = argv[argv.indexOf('--rev') + 1] && argv.includes('--rev') ? argv[argv.indexOf('--rev') + 1] : 'HEAD';   // --rev <commit>: judge that commit (default HEAD and the working file)
const sh = (c) => { try { return execSync(c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 }).trim(); } catch (e) { return null; } };
const KF = 'ci/known-failures.json';
const listAt = (rev) => { const s = rev ? sh(`git show ${rev}:${KF}`) : readFileSync(resolve(ROOT, KF), 'utf8'); if (s == null) return null; try { return JSON.parse(s).known || []; } catch (e) { return null; } };
const key = (k) => `${k.suite}\u0000${k.match}`;
const fails = [];
const FAIL = (m) => { fails.push(m); console.log(`FAIL ${m}`); };

/** The value a known entry's limit captures from a FAIL line, and whether it is inside the limit (ci/run.mjs's rule). */
export function tolerated(line, known) {
  const k = known.find((e) => line.includes(e.match));
  if (!k) return { ok: false, why: 'no known entry matches' };
  const L = k.limit; if (!L) return { ok: true, k };
  const m = new RegExp(L.re).exec(line), v = m ? +m[1] : NaN;
  if (!Number.isFinite(v)) return { ok: false, k, why: `the limit's /${L.re}/ finds no number` };
  if (L.min != null && v < L.min) return { ok: false, k, why: `${v} < the tolerated ${L.min}` };
  if (L.max != null && v > L.max) return { ok: false, k, why: `${v} > the tolerated ${L.max}` };
  return { ok: true, k };
}

const head = listAt(REV === 'HEAD' ? null : REV);
if (!head) { FAIL(`${KF} is unreadable`); process.exit(1); }
// ---- well-formed entries
const seen = new Map();
for (const k of head) {
  for (const f of ['suite', 'match', 'owner', 'why']) if (!k[f]) FAIL(`${KF}: an entry has no ${f} (${JSON.stringify(k).slice(0, 120)})`);
  if (k.limit && (!k.limit.re || (k.limit.min == null && k.limit.max == null))) FAIL(`${KF}: "${k.match}" has a limit without re or min / max`);
  if (k.limit) { try { new RegExp(k.limit.re); } catch (e) { FAIL(`${KF}: "${k.match}" limit re does not compile`); } }
  if (seen.has(key(k))) FAIL(`${KF}: "${k.match}" is listed twice for ${k.suite}`);
  seen.set(key(k), k);
}
// ---- a merge keeps its parents' entries
const parents = (sh(`git rev-list --parents -n 1 ${REV}`) || '').split(' ').slice(1);
const msg = sh(`git log -1 --format=%B ${REV}`) || '';
const dropped = new Set([...msg.matchAll(/^known-drop:\s*(.+?)\s*$/gm)].map((m) => m[1]));
if (parents.length > 1) {
  for (const p of parents) {
    const L = listAt(p); if (!L) continue;
    const renamed = new Set(head.filter((k) => k.replaces).map((k) => `${k.suite}\u0000${k.replaces}`));   // an entry may carry "replaces": "<old match>"
    for (const k of L) if (!seen.has(key(k)) && !renamed.has(key(k)) && !dropped.has(k.match))
      FAIL(`merge ${sh(`git rev-parse --short ${REV}`)} drops parent ${p.slice(0, 7)}'s known entry ${k.suite}: "${k.match}" (owner ${k.owner}). Keep it (merge both lists), or add a line "known-drop: ${k.match}" to the merge message once the row passes`);
  }
  console.log(`known-guard: merge of ${parents.map((p) => p.slice(0, 7)).join(' + ')}: ${head.length} entries, ${dropped.size} dropped by name`);
} else console.log(`known-guard: ${head.length} entries, well formed (HEAD is not a merge: no parent lists to compare)`);

// ---- --ci-logs: the FAIL rows CI printed for the parents, judged against HEAD's list
if (flag('--ci-logs')) {
  const R = 'justinahn2012/Drone-Flight';
  const shas = shaArgs.length ? shaArgs : parents.length > 1 ? parents : [sh(`git rev-parse ${REV}`)];
  // ci.yml steps -> the suite ci/run.mjs gates them with (null: a plain step, any FAIL is red)
  const yml = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8'), suiteOf = {};
  let name = null;
  for (const l of yml.split('\n')) {
    const n = /^\s*- name: (.*)$/.exec(l); if (n) { name = n[1].replace(/^['"]|['"]$/g, ''); continue; }
    const r = name && /ci\/run\.mjs (.*)$/.exec(l);   // [P8 H] the suite = run.mjs's: the first .mjs / .js / .py word, else the first
    if (r) { const w = r[1].trim().split(/\s+/); suiteOf[name] = w.find((x) => /\.(m?js|py)$/.test(x)) || w[0]; }
  }
  if (sh('gh --version') == null) { console.log('known-guard --ci-logs: gh not on PATH: skipped'); }
  else for (const sha0 of shas) {
    const sha = sh(`git rev-parse ${sha0}`) || sha0;   // gh --commit needs the full sha
    const runs = JSON.parse(sh(`gh run list -R ${R} --commit ${sha} -L 20 --json databaseId,status,conclusion,headBranch`) || '[]');
    let used = 0;
    for (const run of runs) {
      const jobs = JSON.parse(sh(`gh run view ${run.databaseId} -R ${R} --json jobs`) || '{"jobs":[]}').jobs;
      for (const j of jobs) {
        if (!j.steps?.some((s) => s.conclusion === 'success' || s.conclusion === 'failure')) continue;
        const gated = j.steps.filter((s) => suiteOf[s.name] && (s.conclusion === 'success' || s.conclusion === 'failure'));
        if (!gated.length) continue;
        const log = sh(`gh run view -R ${R} --job ${j.databaseId} --log`); if (!log) continue;
        used++;
        for (const line of log.split('\n')) {
          const [jn, step, rest] = line.split('\t'); if (rest == null) continue;
          const t = rest.replace(/^\S+Z /, ''); if (!/^\s*FAIL\b/.test(t)) continue;
          const suite = suiteOf[step];
          if (!suite) { if (j.conclusion === 'failure') FAIL(`${sha.slice(0, 7)} run ${run.databaseId} [${jn}] ${step}: ${t.trim().slice(0, 200)} (a step without ci/run.mjs: a hard red)`); continue; }
          const v = tolerated(t, head.filter((k) => k.suite === suite));
          if (!v.ok) FAIL(`${sha.slice(0, 7)} run ${run.databaseId} ${suite}: ${t.trim().slice(0, 200)} | ${v.why} in HEAD's ${KF}`);
        }
      }
      if (used) break;   // the latest run that reached its gated steps
    }
    console.log(`known-guard --ci-logs: ${sha.slice(0, 7)}: ${used ? `${used} job log(s) judged` : 'no run of this commit reached a gated step'}`);
  }
}
console.log(fails.length ? `known-guard: ${fails.length} problem(s)` : 'known-guard: ok');
process.exit(fails.length ? 1 : 0);
