// tests/camera-night.mjs — guards for the night camera (stream P2-A):
//  1. bando stays bit-identical: every non-night program's GLSL, preprocessed with NIGHT undefined, hashes to the phase-1
//     value (fb6881a), and GRADES.hdr / GRADES.ldr / LENSES / SHUTTERS are unchanged;
//  2. the night tone curve passes grey and the white point, is monotonic, and lands the Rec.709 codes it was fitted to;
//  3. the night camera profile section exists only with the night preset on;
//  4. [P3-A] the phase-3 keys (true-source cores, point-source ghosts, retro shadow hue, AE area rule) and the mover kinds.
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
const want = { '-2': [45, 65], '0': [112, 135], '2': [180, 200], '4': [220, 235], '6': [240, 250], '7.5': [254, 255.1] };
for (const [ev, [lo, hi]] of Object.entries(want)) { const c0 = code(+ev); ok(c0 >= lo && c0 <= hi, `code at ${ev} EV = ${c0.toFixed(1)} not in [${lo}, ${hi}]`); }
ok(N.aeReject <= 0.01 && N.aeArea[1] === 0.75 && N.aeArea[0] === 0.5, 'AE: 1 % reject, area sources (>= 5 nits) at 75 % (P5 re-fit)');

// --- 3. profile
const cam = new M.FPVCamera(null); cam.hdr = true; cam._applyGrade(M.GRADES.hdr);
ok(!('night' in cam.profile({ w: 1920, h: 1080 })), 'bando profile has no night section');
cam._applyGrade(M.GRADES.night);
const pn = cam.profile({ w: 1920, h: 1080 });
ok(pn.night && Math.abs(pn.night.tone.bc[0] - b) < 1e-5, 'night profile carries the tone constants');

// --- 4. [P3-A] phase-3 night camera: true-source cores, point-source ghosts, retro shadow hue, AE area rule, mover kinds
ok(N.coreSrc && N.coreSrc[0] >= 35 && N.coreSrc[0] < N.coreSrc[1] && N.coreSrc[1] <= 60, 'coreSrc ramps between the faces (<= 350 nits) and the tubes (>= 600 nits)');
ok(/clamp\(c\.a - 1\.0, 0\.0, 1\.0\)/.test(pp(C.BLUR_FS, { NIGHT: 1 })) && /fragColor = vec4\(cs, 1\.0 \+ cw\)/.test(pp(C.BLUR_FS, { NIGHT: 1 })) && /wSrc/.test(C.NIGHT_FINAL_BODY), 'P3-B1: the night blur carries w = clamp(a - 1, 0, 1) and the cores read it');
ok(N.coreXtalkSrc >= N.coreXtalk && N.coreEvSrc[1] <= 0 && N.coreEvSrc[0] < N.coreEvSrc[1], 'true sources: more crosstalk, ramp under the white point');
ok(N.ghosts.every((g) => g[1] <= 0.0015 && typeof g[2] === 'number' && Array.isArray(g[3])) && N.ghostEv[0] >= 7 && N.ghostChroma <= 0.3, 'ghosts: <= 0.0015, aperture radius, point sources over +7 EV, chroma <= 0.3');
ok(N.retroShadow[0] === 230 && N.retroVibGate[0] >= 30 && N.retroVibGate[1] <= 110, 'retro: one shadow hue (230 deg, P4: blue-grey, not green-teal), vibrance off amber');
ok(N.aeArea.length === 4 && N.aeArea[2] < N.aeArea[1], 'AE: area sources weigh less once they fill the frame');
ok(/const GHOST_FS/.test(src) && !/uGhostT/.test(C.FINAL_FS), 'ghosts come from GHOST_FS, not mirrored bloom copies');
{
  const cam2 = new M.FPVCamera(null), A = (o) => ({ geometry: { attributes: o } });
  const inst = { isInstancedMesh: true, isMesh: true, ...A({ instanceVelocity: {} }) };
  const pose = { isMesh: true, geometry: { isInstancedBufferGeometry: true, attributes: { instanceVelocity: {}, iPos: { itemSize: 4 }, iAnim: { itemSize: 4 } } } };
  const ren = { isMesh: true, geometry: { isInstancedBufferGeometry: true, attributes: { iVel: {}, P: { itemSize: 4 } } }, userData: { motionPose: { pos: 'P' } } };
  const obj = { isMesh: true, ...A({ position: {} }), userData: { velocity: [3, 0, 1] } };
  const k = (o) => cam2._velKind(o);
  ok(k(inst)?.k === 'inst' && k(pose)?.k === 'pose' && k(pose).sa === 'iAnim' && k(ren)?.k === 'pose' && k(ren).va === 'iVel' && k(ren).sa === null && k(obj)?.k === 'obj', 'movers: instanced, posed (iPos) and rigid kinds');
  ok(k({ isMesh: true, ...A({ position: {} }) }) === null && k(null) === null, 'movers: untagged meshes are skipped');
}

// --- 5. [P4-A] phase-4 night camera: stop recovered, source-tinted middle lobe, magenta window + amber gate, NaN guard, mover dilation
ok(N.evBias === -2.05 && N.toe === 0.035, 'P5 colour #1 / exposure re-fit: evBias -2.05, toe 0.035');
ok(N.coreEvSrc[0] === -5.2 && N.coreEvSrc[1] === -1.6, 'P4 colour #4 / P5 re-fit: true-source ramp [-5.2, -1.6]');
ok(Array.isArray(N.haloM) && N.haloM[0] >= 0.035 && N.haloM[0] <= 0.045 && N.haloM[1] > 0 && N.haloMTint.every((v) => v === 1), 'P4 colour #4 / P5 colour #5: middle lobe 3.5-4.5 %, source-tinted');
ok(/uHaloM > 0\.0\) e \+= texture\(tHaloM/.test(C.NIGHT_FINAL_BODY ?? '') || /uHaloM > 0\.0\) e \+= texture\(tHaloM/.test(pp(C.FINAL_FS, { NIGHT: 1 })), 'P4: FINAL adds the middle lobe after eCore');
ok(!/tHaloM|uMagEv/.test(pp(C.FINAL_FS, {})), 'P4: bando FINAL has no middle lobe or magenta window');
ok(N.mag === 0.07 && N.magEv.length === 4 && N.magEv[3] > N.magEv[2] && /uMagEv/.test(C.NIGHT_FINAL_BODY) && /h0/.test(C.NIGHT_FINAL_BODY), 'P4 colour #5: magenta x2, window to the rims, amber gated');
ok(/1\.0e5\)\) c = vec4\(0\.0, 0\.0, 0\.0, 1\.0\)/.test(pp(C.BLUR_FS, { NIGHT: 1 })), 'P4: night blur taps drop NaN/Inf radiance');
ok(/for \(int dy = -1; dy <= 1; dy\+\+\)/.test(pp(C.BLUR_FS, { NIGHT: 1 })) && /min\(12\.0, uMaxS\)/.test(pp(C.BLUR_FS, { NIGHT: 1 })), 'P4 FPV bug: mover velocity 3x3 dilation, >= 12 taps on movers');
{ const pn4 = cam.profile({ w: 1920, h: 1080 }); ok(pn4.night && pn4.night.psf.mid.energy === N.haloM[0] && JSON.stringify(pn4.night.retro.magenta.ev) === JSON.stringify(N.magEv), 'P4: profile carries the middle lobe and the magenta window'); }

// --- 6. [P5-A] phase-5 night camera: the second wide lobe
ok(Array.isArray(N.haloW) && N.haloW[0] >= 0.005 && N.haloW[0] <= 0.015 && N.haloW[1] >= 1.5 && N.haloW[2] >= 2, 'P5 colour #5: a ~1 % wide lobe, sigma ~100 px');
ok(/uHaloW > 0\.0\) e \+= texture\(tHaloW/.test(pp(C.FINAL_FS, { NIGHT: 1 })) && /uniform sampler2D tHaloW/.test(C.NIGHT_FINAL_HEAD) && !/tHaloW/.test(pp(C.FINAL_FS, {})), 'P5: night FINAL adds the wide lobe; bando FINAL does not');
{ const pn5 = cam.profile({ w: 1920, h: 1080 }); ok(pn5.night.psf.mid2 && pn5.night.psf.mid2.energy === N.haloW[0], 'P5: profile carries the wide lobe'); }

console.log(`camera-night tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
