// tests/perf-plan.mjs: the one-tap A18 plan (P5 stream H, perf #4; perf-plan.js), its pure parts in node.
//   node tests/perf-plan.mjs
// The page side (START, the reloads, SHARE) is DOM; here: the URL of each step, the state machine across reloads, and
// that the shared text names every run and carries every digest.
import { PLANS, planOf, stepURL, planAction, planText } from '../perf-plan.js';
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); c ? pass++ : fail++; };
const P = (q) => new URLSearchParams(q);
const plan = planOf(P('level=seoul&perf=a18'));
ok(plan?.id === 'a18' && plan.frames === 180 && plan.steps.length === 3, '?perf=a18 names the plan: 180 frames, 3 steps');
ok(planOf(P('perf=120&plan=a18'))?.id === 'a18' && planOf(P('perf=120')) === null && planOf(P('plan=nope')) === null, '&plan=a18 too; nothing else starts it');
const base = 'https://game.example/?level=seoul&perf=a18&soak=30';
const u = [0, 1, 2].map((k) => new URL(stepURL(base, plan, k)).searchParams);
ok(u.every((q, k) => q.get('level') === 'seoul' && q.get('perf') === '180' && q.get('plan') === 'a18' && q.get('step') === String(k) && !q.has('soak')), 'each step URL keeps the level, sets perf=180, plan, step; drops a stray soak');
ok(u[0].get('preset') === 'auto' && u[1].get('preset') === 'phone' && !u[2].has('preset'), 'presets: auto, phone, then the device default (an iPhone on Auto runs phone)');
ok(PLANS.a18.steps.map((s) => s.soak).join() === '0,0,600', 'soak only on the last step: 600 s');
// the state machine across reloads
ok(planAction(plan, null, null).do === 'intro', 'no state: the intro (START)');
const st = { id: 'a18', started: 'x', runs: [] };
ok(planAction(plan, st, '0').do === 'run' && planAction(plan, st, '0').step === 0, 'started, step=0 in the URL: run 1');
ok(planAction(plan, st, '2').do === 'restart' && planAction(plan, st, '2').step === 0, 'a URL ahead of the stored runs resumes at the first missing run');
ok(planAction(plan, { ...st, runs: [{}, {}] }, '2').do === 'run', 'two runs stored, step=2: the soak');
ok(planAction(plan, { ...st, runs: [{}, {}, {}] }, '2').do === 'done', 'three runs stored: done (SHARE)');
ok(planAction(plan, { ...st, started: null }, '0').do === 'intro', 'START OVER clears it');
// the shared text
const seg = { p50: 9.1, p90: 12.3, cpuP50: 4.2 };
const run = (preset, soak) => ({ preset: { ran: preset, suggest: 'auto' }, msaa: preset === 'phone' ? 2 : 4, out: [1290, 596], device: { renderer: 'Apple GPU', at: '2026-11-12T10:00:00Z', preset }, suggestMax: 1.0,
  scales: [{ scale: 1.0, seg: { walk: seg, canyon: seg } }], soak: soak ? { seconds: 600, first30: { p90: 12 }, last30: { p50: 10, p90: 14.5, gpuP50: 9 }, throttle: 1.21 } : null });
const runs = [run('auto'), run('phone'), run('phone', 1)], text = planText(plan, { runs }, (r) => ({ msaa: r.msaa }));
ok(/1\. auto preset.*\n.*walk 9\.1\/12\.3/.test(text) && /2\. phone preset/.test(text) && /3\. 10-min soak/.test(text) && /soak 600 s: .*×1\.21/.test(text), 'the text has a block per run, the 1.0× segments and the soak line');
ok(JSON.parse(text.split('perf-digests ')[1]).length === 3, 'and the three digests');
console.log(`perf-plan tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
