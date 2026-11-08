// tests/camera-night.mjs — guards for the night camera (stream P2-A):
//  1. bando stays bit-identical: every non-night program's GLSL, preprocessed with NIGHT undefined, hashes to the phase-1
//     value (fb6881a), and GRADES.hdr / GRADES.ldr / LENSES / SHUTTERS are unchanged;
//  2. the night tone curve passes grey and the white point, is monotonic, and lands the Rec.709 codes it was fitted to;
//  3. the night camera profile section exists only with the night preset on.
//   node tests/camera-night.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(ROOT, 'fpvcam.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// --- 1. bando GLSL
function consts(s) {
  const env = {};
  for (const m of s.matchAll(/^const ([A-Z_0-9]+) = \/\* glsl \*\/`/gm)) {
    const i = m.index + m[0].length - 1, j = s.indexOf('`', i + 1);
    env[m[1]] = Function(...Object.keys(env), `return ${s.slice(i, j + 1)};`)(...Object.values(env));
  }
  return env;
}
function pp(glsl, defs) {
  const out = [], st = [];
  for (const line of glsl.split('\n')) {
    const t = line.trim(); let m;
    if ((m = /^#ifdef\s+(\w+)/.exec(t))) { st.push(!!defs[m[1]]); continue; }
    if ((m = /^#ifndef\s+(\w+)/.exec(t))) { st.push(!defs[m[1]]); continue; }
    if (/^#else/.test(t)) { st[st.length - 1] = !st[st.length - 1]; continue; }
    if (/^#endif/.test(t)) { st.pop(); continue; }
    if (st.every(Boolean)) out.push(line);
  }
  return out.join('\n');
}
// sha256[0:16] of each program at fb6881a (phase 1), NIGHT undefined
const BANDO = { VS: 'c3e23de6b87cda99', TILE_FS: '99d621c2c74e51f8', NBR_FS: '0263099c889d0049', BLUR_FS: '40afc09220989ea4', SSAO_FS: '9c4e302b869174d7',
  AOBLUR_FS: '3caec4b544823509', DOWN_FS: '8acdd692c04a3fee', METER_FS: '5a659f2b028df320', BLOOM_FS: '9e1d6118d8fb257b', FINAL_FS: '72c4faa205cdad03' };
const C = consts(src);
const got = Object.fromEntries(Object.keys(BANDO).map((k) => [k, sha(pp(C[k], {}))]));
if (process.argv.includes('--print')) console.log(JSON.stringify(got));
for (const k in BANDO) ok(got[k] === BANDO[k], `bando ${k} GLSL changed (${got[k]} != ${BANDO[k]})`);

const M = await import(resolve(ROOT, 'fpvcam.js'));
const J = (o) => sha(JSON.stringify(o));
const TABLES = { hdr: '736ebb961142185f', ldr: '6f4229dea409694f', LENSES: 'a7dd3004f0ed42ad', SHUTTERS: '41f97110c9a23faa' };
const gotT = { hdr: J(M.GRADES.hdr), ldr: J(M.GRADES.ldr), LENSES: J(M.LENSES), SHUTTERS: J(M.SHUTTERS) };
if (process.argv.includes('--print')) console.log(JSON.stringify(gotT));
for (const k in TABLES) ok(gotT[k] === TABLES[k], `bando table ${k} changed (${gotT[k]} != ${TABLES[k]})`);

// --- 2. night tone curve
const N = M.GRADES.night, [a, d, mid] = N.tone, wp = 0.24 * 2 ** N.clipEv, [b, c] = M.nightToneBC(a, d, mid, wp);
const f = (x) => x ** a / (x ** (a * d) * b + c);
ok(Math.abs(f(0.24) - mid) < 1e-9, 'tone passes grey');
ok(Math.abs(f(wp) - 1) < 1e-9, 'tone reaches 1 at the white point');
const lin2srgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const code = (ev) => { let t = Math.min(1, f(0.24 * 2 ** ev)); const to = N.toe; t = t * t / (t + to) * (1 + to); let o = lin2srgb(t); o += (o * o * (3 - 2 * o) - o) * 0.22; return (o * (1 - N.lift) + N.lift) * 255; };
let prev = -1, mono = true; for (let ev = -8; ev <= 8; ev += 0.25) { const c0 = code(ev); if (c0 < prev - 1e-9) mono = false; prev = c0; }
ok(mono, 'tone monotonic');
const want = { '-2': [45, 65], '0': [112, 135], '2': [180, 200], '4': [222, 238], '6': [246, 254] };
for (const [ev, [lo, hi]] of Object.entries(want)) { const c0 = code(+ev); ok(c0 >= lo && c0 <= hi, `code at ${ev} EV = ${c0.toFixed(1)} not in [${lo}, ${hi}]`); }
ok(N.aeReject <= 0.01 && N.aeArea[1] === 0.5, 'AE: 1 % reject, area sources at 50 %');

// --- 3. profile
const cam = new M.FPVCamera(null); cam.hdr = true; cam._applyGrade(M.GRADES.hdr);
ok(!('night' in cam.profile({ w: 1920, h: 1080 })), 'bando profile has no night section');
cam._applyGrade(M.GRADES.night);
const pn = cam.profile({ w: 1920, h: 1080 });
ok(pn.night && Math.abs(pn.night.tone.bc[0] - b) < 1e-5, 'night profile carries the tone constants');

console.log(`camera-night tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
