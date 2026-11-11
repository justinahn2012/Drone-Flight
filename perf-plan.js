// perf-plan.js: the one-tap phone measurement (P5 stream H, perf #4). Open the game with
//   ?level=seoul&perf=a18          (or &plan=a18 with any ?perf=N)
// tap START once, put the phone down, and about 15 minutes later tap SHARE once. In between it runs, without a tap:
//   1. auto     ?perf=180 at the full-quality preset (&preset=auto: what a desktop gets)       ~1 min
//   2. phone    ?perf=180 at the phone preset (&preset=phone: MSAA 2, light and crowd low)      ~1 min
//   3. soak     10 minutes at the preset an iPhone runs by default (Quality Auto on iOS = phone) ~11 min
// Each step reloads the page (a preset is chosen when the level builds), so each starts from a clean heap. The plan's
// state and each step's result live in this tab's sessionStorage (localStorage when that fails); SHARE sends one text
// (a table of the three runs) and one JSON file holding all three full results to Messages / Mail / Notes.
// The screen is held awake with the Screen Wake Lock API (iOS 16.4+); without it the page says to set Auto-Lock to Never.
// Nothing here changes the game outside ?perf. perf.js calls planHook() once the world is ready.
export const PLANS = {
  a18: {
    frames: 180,
    title: 'A18 PLAN',
    steps: [
      { id: 'auto', preset: 'auto', soak: 0, label: 'auto preset (full quality)' },
      { id: 'phone', preset: 'phone', soak: 0, label: 'phone preset' },
      { id: 'soak', preset: null, soak: 600, label: '10-min soak at the iPhone default' },
    ],
  },
};
const KEY = 'onetake.perf.plan';

/** The plan named in the URL, or null. */
export function planOf(params) {
  const id = params.get('perf') === 'a18' ? 'a18' : params.get('plan');
  if (!id || !PLANS[id]) return null;
  // test-only overrides (tests/browser smoke): &planframes=N, &plansoak=S shrink the plan; never in a shared link
  const fr = +params.get('planframes'), sk = params.get('plansoak');
  return { id, ...PLANS[id], frames: fr > 0 ? fr : PLANS[id].frames, steps: PLANS[id].steps.map((s) => ({ ...s, soak: s.soak && sk != null ? Math.max(0, +sk || 0) : s.soak })) };
}
/** The URL of a plan step: the current page with perf / preset / plan / step set (other parameters kept). */
export function stepURL(href, plan, k) {
  const u = new URL(href), st = plan.steps[k];
  u.searchParams.set('perf', String(PLANS[plan.id]?.frames ?? plan.frames)); u.searchParams.set('plan', plan.id); u.searchParams.set('step', String(k));
  u.searchParams.delete('soak');
  if (st.preset) u.searchParams.set('preset', st.preset); else u.searchParams.delete('preset');
  return u.toString();
}
/** Pure state machine: what the page should do now. -> {do: 'intro' | 'run' | 'done' | 'restart', step?} */
export function planAction(plan, state, stepParam) {
  if (!state || state.id !== plan.id || !state.started) return { do: 'intro' };
  if (state.runs.length >= plan.steps.length) return { do: 'done' };
  const k = state.runs.length;
  return stepParam === String(k) ? { do: 'run', step: k } : { do: 'restart', step: k };
}
/** A plan's three results as a short table (the shared text). digest: perf.js perfDigest. */
export function planText(plan, state, digest) {
  const f = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');
  const L = [`One Take FPV · ${plan.title} · ${state.runs[0]?.device?.renderer || ''} · ${state.runs[0]?.device?.at?.slice(0, 16) || ''}`];
  state.runs.forEach((r, k) => {
    const st = plan.steps[k], s1 = r.scales?.find((x) => x.scale === 1.0);
    L.push(`${k + 1}. ${st.label}: ${r.preset?.ran || r.device?.preset || '?'} · msaa ${r.msaa} · ${r.out?.join('×')}`);
    if (s1) L.push('   1.0× ' + Object.entries(s1.seg).map(([n, v]) => `${n} ${f(v.p50)}/${f(v.p90)} (cpu ${f(v.cpuP50)})`).join(' · '));
    if (r.soak) L.push(`   soak ${r.soak.seconds} s: first 30 s p90 ${f(r.soak.first30.p90)} · last 30 s p50 ${f(r.soak.last30.p50)} p90 ${f(r.soak.last30.p90)} gpu ${f(r.soak.last30.gpuP50)} · ×${r.soak.throttle}`);
    L.push(`   suggests auto max ${r.suggestMax ?? '< 1.0'}${r.suggestSustained ? ` · sustained ${r.suggestSustained}` : ''}${r.preset?.suggest ? ` · preset ${r.preset.suggest}` : ''}`);
  });
  L.push('', 'perf-digests ' + JSON.stringify(state.runs.map((r) => digest(r))));
  return L.join('\n');
}

// ---- the page side
const store = () => { for (const s of ['sessionStorage', 'localStorage']) { try { const x = globalThis[s]; x.setItem(KEY + '.t', '1'); x.removeItem(KEY + '.t'); return x; } catch (e) { /* off */ } } return null; };
const load = () => { try { const v = JSON.parse(store()?.getItem(KEY) || 'null'); return v && Array.isArray(v.runs) ? v : null; } catch (e) { return null; } };
const save = (v) => { try { store()?.setItem(KEY, JSON.stringify(v)); return true; } catch (e) { return false; } };
let lock = null;
async function wake() {
  // (a request can stay pending forever: headless Chrome, a page that isn't visible; never let it hold the plan up)
  try {
    if (navigator.wakeLock && (!lock || lock.released)) lock = await Promise.race([navigator.wakeLock.request('screen'), new Promise((r) => setTimeout(() => r(null), 1500))]);
    return !!lock && !lock.released;
  } catch (e) { return false; }
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && lock) wake(); });

/** perf.js: called once the world is ready. ui: { run(soak) -> res, say, btn, quick, share, bar, digest, sharePayload }.
 *  Returns true when the plan took over the probe's buttons. */
export async function planHook(o, ui, params = new URLSearchParams(location.search)) {
  const plan = planOf(params); if (!plan) return false;
  const st = load(), act = planAction(plan, st, params.get('step'));
  const { say, btn, quick, share, bar } = ui, total = plan.steps.reduce((a, s) => a + s.soak + 60, 0);
  o.perfPlan = { plan, get state() { return load(); }, action: act.do };
  quick.style.display = 'none';
  if (act.do === 'intro') {
    say(`${plan.title} · ${plan.steps.length} runs, about ${Math.round(total / 60)} min, no taps in between:\n` +
      plan.steps.map((s, k) => `  ${k + 1}. ${s.label}`).join('\n') +
      '\n\nBefore START: unplug the charger, Low Power Mode off, close other apps, brightness about half. ' +
      'Hold or prop the phone in landscape; the page reloads twice by itself. At the end, tap SHARE once.');
    btn.textContent = 'START'; bar.style.display = '';
    btn.onclick = async () => {
      await wake();
      save({ id: plan.id, started: new Date().toISOString(), runs: [] });
      location.replace(stepURL(location.href, plan, 0));
    };
    return true;
  }
  if (act.do === 'restart') { say(`${plan.title} · resuming at run ${act.step + 1}…`); setTimeout(() => location.replace(stepURL(location.href, plan, act.step)), 800); return true; }
  if (act.do === 'run') {
    const k = act.step, s = plan.steps[k], awake = await wake();
    bar.style.display = 'none';
    say(`${plan.title} · run ${k + 1} of ${plan.steps.length}: ${s.label}${awake ? '' : '\n(the screen may lock: set Settings › Display & Brightness › Auto-Lock to Never)'}`);
    await new Promise((r) => setTimeout(r, 3000));   // let the load's work (bakes, uploads) settle
    const res = await ui.run(s.soak);
    const cur = load() || { id: plan.id, started: new Date().toISOString(), runs: [] };
    cur.runs[k] = res; cur.runs.length = k + 1; save(cur);
    if (k + 1 < plan.steps.length) { say(`${plan.title} · run ${k + 1} done. Next: ${plan.steps[k + 1].label}…`); setTimeout(() => location.replace(stepURL(location.href, plan, k + 1)), 2500); return true; }
  }
  // done: one SHARE with all runs
  const fin = load();
  const text = planText(plan, fin, ui.digest);
  say(text.split('\n\nperf-digests')[0] + '\n\nDone. Tap SHARE to send all three (text + a JSON file). START OVER runs the plan again.');
  btn.textContent = 'START OVER'; bar.style.display = ''; share.style.display = '';
  btn.onclick = () => { save({ id: plan.id, started: null, runs: [] }); location.replace(stepURL(location.href, plan, 0).replace(/([?&])step=\d+&?/, '$1')); };
  share.onclick = () => ui.sharePayload({ text, name: `onetake-perf-${plan.id}-${(fin.runs[0]?.device?.at || '').replace(/[:.]/g, '-').slice(0, 16)}.json`, json: { format: 'onetake.perf/1', plan: plan.id, steps: plan.steps, runs: fin.runs } });
  o.perfPlanText = text;
  return true;
}
