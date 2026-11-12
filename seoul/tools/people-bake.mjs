// seoul/tools/people-bake.mjs: bake Microsoft Rocketbox avatars (MIT licence, github.com/microsoft/Microsoft-Rocketbox) into
// the crowd's near/mid LODs (stream G1, life #1 / art #5 / graphics #6). Offline, once; the output is committed:
//   seoul/people/people.bin   per avatar x LOD: positions (m), normals, atlas UVs, two of the crowd's 15 bones + weight, region
//   seoul/people/people.json  layout of people.bin, each avatar's joints (the shader's pivots), height, sex
// then seoul/tools/people-atlas.py builds atlas.jpg / hair.png from the avatars' textures and adds the class mean colours.
//
//   node seoul/tools/people-bake.mjs <dir with the avatars' Export/*.fbx> <meshoptimizer/index.module.js> [out dir]
//
// Per avatar: A-pose -> arms hanging (upper arm and forearm rotated to the crowd's rest pose), CPU skinned, cm -> m; each
// vertex keeps its two strongest bones mapped onto the crowd rig (0 torso, 1 head, 2/3 L thigh/shin, 4/5 R, 6/7 L arm,
// 8/9 R arm, 13/14 feet; hands ride the forearms); classes from material and bone: 0 skin, 1 hair (alpha cards), 2 top,
// 3 bottom, 4 shoes; a phone (bone 10, regions 5/6) at the right hand; meshoptimizer simplifies to the LOD budgets.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

const [dir, meshoptPath, outDir = 'seoul/people'] = process.argv.slice(2);
if (!dir || !meshoptPath) { console.error('usage: node seoul/tools/people-bake.mjs <fbx dir> <meshoptimizer/index.module.js> [out]'); process.exit(1); }
const { MeshoptSimplifier } = await import(meshoptPath);
await MeshoptSimplifier.ready;
MeshoptSimplifier.useExperimentalFeatures = true;   // (P8: simplifyWithAttributes for vertex_lock)
THREE.TextureLoader.prototype.load = function () { return new THREE.Texture(); };   // node: no images (the atlas tool reads them)

// the order is the avatar index the crowd uses; 4 men, 4 women, November night clothing (jackets, suits, hoodies, trousers)
// (P6, life #1) + the library's six East Asian bodies (Hongdae on a Friday is 85 %+ Korean): Business_Male_02, Male_Adult_09,
// Male_Adult_10, Business_Female_03, Female_Adult_11, Female_Adult_05 (Female_Adult_03 tried: sleeveless,
// and its long hair cards stood off a bare scalp, 71 % on hair). 14 avatars in a 4 x 4 grid (atlas 2048 x 4096)
// (P8, life #1: 4 casual bodies carried 70 % of the crowd, 14 % of pairs within 8 m in one body) + 8 East Asian bodies made
// in the library: the clothes, hands and shoes (body material) of a donor whose clothes nobody wears yet, the head, neck
// and hair cards (head + opacity materials) of an East Asian avatar. Rocketbox avatars of one sex share one skeleton and
// one neck template (the head mesh ends at the same collar line: y 136.5 cm on the women), so the two halves meet as
// rigged; every body donor below keeps its own head mesh down to at least the head donor's (no gap at the collar).
// Two of the heads are new East Asian faces from the library's Professions set (Sports_Female_02, Medical_Female_01).
// [name, sex, ea, head donor]; the folder each FBX and its textures come from is DIRS (the Professions set differs)
const AVATARS = [
  ['Business_Male_01', 'm'], ['Male_Adult_03', 'm'], ['Male_Adult_04', 'm'], ['Male_Adult_18', 'm'],
  ['Business_Female_04', 'f'], ['Female_Adult_07', 'f'], ['Female_Adult_09', 'f'], ['Female_Adult_13', 'f'],
  ['Business_Male_02', 'm', 'ea'], ['Male_Adult_09', 'm', 'ea'], ['Male_Adult_10', 'm', 'ea'],
  ['Business_Female_03', 'f', 'ea'], ['Female_Adult_11', 'f', 'ea'], ['Female_Adult_05', 'f', 'ea'],
  ['Male_Adult_02', 'm', 'ea', 'Male_Adult_09'], ['Male_Adult_07', 'm', 'ea', 'Male_Adult_09'], ['Male_Adult_17', 'm', 'ea', 'Male_Adult_10'], ['Male_Adult_06', 'm', 'ea', 'Male_Adult_09'],
  ['Female_Adult_14', 'f', 'ea', 'Sports_Female_02'], ['Female_Adult_04', 'f', 'ea', 'Medical_Female_01'], ['Female_Adult_01', 'f', 'ea', 'Female_Adult_11'], ['Female_Adult_02', 'f', 'ea', 'Female_Adult_05'],
];
export const avatarName = ([name, , , head]) => (head ? `${name}+${head}` : name);
const TRIM_CARDS = new Set(['Sports_Female_02']);
const LOCK_SCALP = new Set(['Business_Female_04']);   // (P8) see vertex_lock below: the one body whose thinned near LOD lost it
const LODS = [{ name: 'near', tris: 3400 }, { name: 'lod1', tris: 1700 }, { name: 'mid', tris: 760 }];   // (P4 perf #2: lod1 for 8-18 m)
// (P8) atlas cells: avatar i's body map (top) and head map (bottom) in a CELL x 2 CELL cell, 4 per row; 22 avatars in 6 rows.
// CELL 384 (P6: 512): 1536 x 4608 is 7 MB less GPU memory than P6's 2048 x 4096 with 8 more avatars
const CELL = 384, COLS = 4, ROWS = Math.ceil(AVATARS.length / COLS), HCELL = 256;

const myBone = (n) => {
  if (/L_Thigh/.test(n)) return 2; if (/L_Calf/.test(n)) return 3; if (/L_Foot|L_Toe/.test(n)) return 13;
  if (/R_Thigh/.test(n)) return 4; if (/R_Calf/.test(n)) return 5; if (/R_Foot|R_Toe/.test(n)) return 14;
  if (/L_UpperArm/.test(n)) return 6; if (/L_Forearm|L_Hand|L_Finger/.test(n)) return 7;
  if (/R_UpperArm/.test(n)) return 8; if (/R_Forearm|R_Hand|R_Finger/.test(n)) return 9;
  if (/Neck|Head|Eye|Lip|Cheek|Mouth|Caninus|brow|Jaw|Tongue|Nose|Masseter|Pony|Hair/i.test(n)) return 1;
  return 0;
};
const classOf = (mat, boneName) => {
  if (/opacity/i.test(mat)) return 1;
  if (/head/i.test(mat)) return 0;
  if (/Hand|Finger/.test(boneName)) return 0;
  if (/Foot|Toe/.test(boneName)) return 4;
  if (/Thigh|Calf/.test(boneName)) return 3;
  if (/Head/.test(boneName)) return 0;
  return 2;
};

const out = { version: 1, source: 'Microsoft Rocketbox Avatar Library (MIT licence, (c) 2020 Microsoft)', atlas: { w: COLS * CELL, h: ROWS * 2 * CELL, cell: CELL, cols: COLS, hairW: COLS * HCELL, hairH: ROWS * HCELL }, avatars: [] };
const chunks = []; let off = 0;
const push = (ta) => { const pad = (4 - (off % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); off += pad; } const b = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength); chunks.push(b.slice()); const o = off; off += b.byteLength; return o; };
const uvSamples = [];

// one avatar's FBX, posed (A-pose -> arms hanging, 4 deg out, forearm 6 deg forward) and skinned on the CPU (world space,
// cm -> m): per vertex (non-indexed, three per triangle) position, normal, uv, the two strongest crowd bones + weight,
// class and material name; and the crowd joints after the pose
function posed(name) {
  const buf = readFileSync(join(dir, name + '.fbx'));
  const obj = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  obj.updateMatrixWorld(true);
  const mesh = obj.getObjectByProperty('isSkinnedMesh', true), g = mesh.geometry, mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const B = (n) => obj.getObjectByName('Bip01_' + n), W = (b) => b.getWorldPosition(new THREE.Vector3());
  const aim = (bone, child, target) => {
    const d = W(child).sub(W(bone)).normalize(), q = new THREE.Quaternion().setFromUnitVectors(d, target.clone().normalize());
    const wq = bone.getWorldQuaternion(new THREE.Quaternion()), pq = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    bone.quaternion.copy(pq.invert().multiply(q.multiply(wq))); obj.updateMatrixWorld(true);
  };
  for (const s of ['L', 'R']) {
    const sx = s === 'L' ? 1 : -1;
    aim(B(s + '_UpperArm'), B(s + '_Forearm'), new THREE.Vector3(sx * 0.07, -1, -0.02));
    aim(B(s + '_Forearm'), B(s + '_Hand'), new THREE.Vector3(sx * 0.02, -1, 0.1));
  }
  mesh.skeleton.update();
  const P = g.attributes.position, N = g.attributes.normal, UV = g.attributes.uv, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, nV = P.count;
  const bones = mesh.skeleton.bones, bm = bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, mesh.skeleton.boneInverses[i]));
  const M = new THREE.Matrix4(), tmp = new THREE.Matrix4(), v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
  const pos = new Float32Array(nV * 3), nrm = new Float32Array(nV * 3), uv = new Float32Array(nV * 2), b1 = new Uint8Array(nV), b2 = new Uint8Array(nV), bw = new Float32Array(nV), cls = new Uint8Array(nV), matN = new Array(nV);
  const matOf = new Uint8Array(nV); for (const gr of g.groups) for (let i = gr.start; i < gr.start + gr.count; i++) matOf[i] = gr.materialIndex;
  const bind = mesh.bindMatrix.clone().invert().premultiply(mesh.matrixWorld);
  for (let i = 0; i < nV; i++) {
    M.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0); const acc = new Map(); let top = -1, topW = -1;
    for (let k = 0; k < 4; k++) {
      const w = SW.getComponent(i, k); if (w <= 0) continue; const bi = SI.getComponent(i, k);
      tmp.copy(bm[bi]).multiplyScalar(w); for (let e = 0; e < 16; e++) M.elements[e] += tmp.elements[e];
      const id = myBone(bones[bi].name); acc.set(id, (acc.get(id) || 0) + w); if (w > topW) { topW = w; top = bi; }
    }
    M.premultiply(bind).multiply(mesh.bindMatrix);
    v.fromBufferAttribute(P, i).applyMatrix4(M).multiplyScalar(0.01); nm.getNormalMatrix(M); n.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
    pos.set([v.x, v.y, v.z], i * 3); nrm.set([n.x, n.y, n.z], i * 3); uv.set([UV.getX(i), UV.getY(i)], i * 2);
    const ids = [...acc.entries()].sort((a, b) => b[1] - a[1]); const w1 = ids[0][1], w2 = ids[1] ? ids[1][1] : 0;
    b1[i] = ids[0][0]; b2[i] = ids[1] ? ids[1][0] : ids[0][0]; bw[i] = w2 / (w1 + w2);
    matN[i] = mats[matOf[i]].name; cls[i] = classOf(matN[i], bones[top].name);
  }
  const J = (nm2) => W(B(nm2)).multiplyScalar(0.01);
  const avg = (a, b) => ({ x: (Math.abs(a.x) + Math.abs(b.x)) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
  const hip = avg(J('L_Thigh'), J('R_Thigh')), knee = avg(J('L_Calf'), J('R_Calf')), ankle = avg(J('L_Foot'), J('R_Foot'));
  const sh = avg(J('L_UpperArm'), J('R_UpperArm')), el = avg(J('L_Forearm'), J('R_Forearm')), wr = avg(J('L_Hand'), J('R_Hand')), neck = J('Neck');
  return { nV, pos, nrm, uv, b1, b2, bw, cls, matN, hip, knee, ankle, sh, el, wr, neck };
}

// (P8, life #1) rigid accessories, the same on every avatar, fitted to its body: a cap (style 5) and a beanie (style 7) on
// the head bone, a backpack (accessory bit 2) and a shoulder tote with its strap (bag flag) on the torso. Regions the shader
// shows or hides per person (seoul-life.js HUMAN_ANIM): 8 cap, 11 beanie (both take the headwear colour), 10 backpack,
// 6 tote. res 0..2: the LOD (near, lod1, mid). -> { P, N, B (bone), R (region), I }
function accessories(S, res) {
  const P = [], N = [], B = [], R = [], I = [];
  const vtx = (p, n, bone, reg) => { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); B.push(bone); R.push(reg); return P.length / 3 - 1; };
  const box = (x0, y0, z0, x1, y1, z1, bone, reg) => {
    const F = [[[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]], [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
      [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]], [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
      [[0, 0, 1], [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]]], [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]]];
    for (const [n, vs] of F) { const o = vs.map((q) => vtx(q, n, bone, reg)); I.push(o[0], o[2], o[1], o[0], o[3], o[2]); }
  };
  // a slab along the segment a -> b (width w across, thickness t along `up`), for the tote's strap
  const slab = (a, b, w, t, side, bone, reg) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(...d), u = d.map((x) => x / L);
    const s = side, c = [u[1] * s[2] - u[2] * s[1], u[2] * s[0] - u[0] * s[2], u[0] * s[1] - u[1] * s[0]], cl = Math.hypot(...c) || 1, nn = c.map((x) => x / cl);
    const ws = [nn[1] * u[2] - nn[2] * u[1], nn[2] * u[0] - nn[0] * u[2], nn[0] * u[1] - nn[1] * u[0]];
    const q = (p, sw, sn) => [p[0] + ws[0] * sw * w / 2 + nn[0] * sn * t / 2, p[1] + ws[1] * sw * w / 2 + nn[1] * sn * t / 2, p[2] + ws[2] * sw * w / 2 + nn[2] * sn * t / 2];
    for (const sn of [1, -1]) { const nv = nn.map((x) => x * sn), o = [q(a, -1, sn), q(a, 1, sn), q(b, 1, sn), q(b, -1, sn)].map((p) => vtx(p, nv, bone, reg)); sn > 0 ? I.push(o[0], o[1], o[2], o[0], o[2], o[3]) : I.push(o[0], o[2], o[1], o[0], o[3], o[2]); }
  };
  // an ellipsoid cap round the skull: kept below the crown down to th(azimuth) (front low over the forehead, back to the nape)
  const shell = (c, r, thF, thB, reg, nth, nph) => {
    const base = P.length / 3;
    for (let i = 0; i <= nth; i++) for (let k = 0; k <= nph; k++) {
      const ph = (k / nph) * Math.PI * 2, front = 0.5 + 0.5 * Math.sin(ph), th = (i / nth) * (thB + (thF - thB) * front);
      const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
      const nv = [x / r[0], y / r[1], z / r[2]], l = Math.hypot(...nv);
      vtx([c[0] + x * r[0], c[1] + y * r[1], c[2] + z * r[2]], nv.map((q) => q / l), 1, reg);
    }
    const Wd = nph + 1;
    for (let i = 0; i < nth; i++) for (let k = 0; k < nph; k++) { const a = base + i * Wd + k, b = a + 1, cc = a + Wd, d = cc + 1; I.push(a, b, cc, b, d, cc); }
  };
  const [nth, nph] = [[4, 10], [3, 8], [2, 6]][res];
  const D = (deg) => (deg * Math.PI) / 180;
  shell(S.hc, S.hr.map((q) => q + 0.006), D(68), D(98), 8, nth, nph);   // cap crown
  { const r = S.hr, y = S.hc[1] + r[1] * Math.cos(D(68)) - 0.004, zf = S.hc[2] + r[2] * Math.sin(D(68)) - 0.01, wx = r[0] * 0.82;   // brim, tipped down 8 deg
    box(-wx, y - 0.012, zf, wx, y, zf + 0.075, 1, 8); }
  shell([S.hc[0], S.hc[1] + 0.004, S.hc[2]], [S.hr[0] + 0.007, S.hr[1] + 0.014, S.hr[2] + 0.007], D(80), D(104), 11, nth, nph);   // beanie (knit, a little slouch on top)
  // backpack: 30 x 40 x 15 cm on the shoulder blades, a front pocket
  { const zb = S.zBack, w = 0.14 * S.shX / 0.21, y1 = S.sh.y - 0.06, y0 = y1 - 0.4;
    box(-w, y0, zb - 0.15, w, y1, zb + 0.01, 0, 10);
    if (res < 2) box(-w * 0.72, y0 + 0.03, zb - 0.2, w * 0.72, y0 + 0.2, zb - 0.15, 0, 10); }
  // tote on the left hip, hanging from the left shoulder: 6 cm thick, 30 x 34 cm, just behind the hanging arm; the strap
  // runs up over the shoulder to the bag's front and back
  { const x0 = S.hipW + 0.005, x1 = x0 + 0.055, y0 = S.hip.y - 0.12, y1 = y0 + 0.32, z0 = S.zBackHip - 0.03, z1 = z0 + 0.3;
    box(x0, y0, z0, x1, y1, z1, 0, 6);
    if (res < 2) { const top = [S.sh.x - 0.08, S.sh.y + 0.065, S.zSh];
      slab([x0 + 0.03, y1 - 0.01, z1 - 0.05], [top[0], top[1], top[2] + 0.06], 0.035, 0.008, [1, 0, 0], 0, 6);
      slab([x0 + 0.03, y1 - 0.01, z0 + 0.05], [top[0], top[1], top[2] - 0.06], 0.035, 0.008, [1, 0, 0], 0, 6); } }
  return { P, N, B, R, I };
}

for (const [ai, spec] of AVATARS.entries()) {
  const [bodyName, sex, ea, headName] = spec, name = avatarName(spec);
  // ---- the donors: one FBX, or the body material of one and the head + opacity materials of another
  const SB = posed(bodyName), SH = headName ? posed(headName) : SB;
  const keepB = (i) => !headName || /body/i.test(SB.matN[i]), keepH = (i) => /head|opacity/i.test(SH.matN[i]);
  const src = []; for (let i = 0; i < SB.nV; i += 3) if (keepB(i)) src.push([SB, i]);
  if (headName) for (let i = 0; i < SH.nV; i += 3) if (keepH(i)) src.push([SH, i]);
  // (P8) TRIM_CARDS: a donor's hair cards that hang down the back of the neck below the nape (Sports_Female_02's ponytail,
  // to the shoulder blades) are dropped: they lie over the bare neck (no painted hair under them: the scalp gate), and the
  // crowd rig swings them with the head through the collar
  if (TRIM_CARDS.has(headName || bodyName)) {
    const H = headName ? SH : SB; let ny = 0, nz = -9; for (let i = 0; i < H.nV; i++) if (/head/i.test(H.matN[i]) && Math.abs(H.pos[i * 3]) < 0.012 && H.pos[i * 3 + 2] > nz) { nz = H.pos[i * 3 + 2]; ny = H.pos[i * 3 + 1]; }
    const low = (i) => H.pos[i * 3 + 1] < ny - 0.035 && H.pos[i * 3 + 2] < nz - 0.12;
    const n0 = src.length;
    for (let k = src.length - 1; k >= 0; k--) { const [S0, t] = src[k]; if (S0 !== H || !/opacity/i.test(H.matN[t])) continue; if (low(t) || low(t + 1) || low(t + 2)) src.splice(k, 1); }
    console.log(`  ${headName || bodyName}: ${n0 - src.length} hair-card triangles off the scalp dropped`);
  }
  const nV = src.length * 3;
  const texOf = []; const texDonor = []; const matIdx = (S, mname) => { let k = texOf.indexOf(mname); if (k < 0) { k = texOf.length; texOf.push(mname); texDonor.push(S === SH && headName ? headName : bodyName); } return k; };
  const pos = new Float32Array(nV * 3), nrm = new Float32Array(nV * 3), uv = new Float32Array(nV * 2), b1 = new Uint8Array(nV), b2 = new Uint8Array(nV), bw = new Float32Array(nV), cls = new Uint8Array(nV), mat = new Uint8Array(nV);
  { let o = 0; for (const [S, t] of src) for (let k = 0; k < 3; k++, o++) { const i = t + k;
    pos.set(S.pos.subarray(i * 3, i * 3 + 3), o * 3); nrm.set(S.nrm.subarray(i * 3, i * 3 + 3), o * 3); uv.set(S.uv.subarray(i * 2, i * 2 + 2), o * 2);
    b1[o] = S.b1[i]; b2[o] = S.b2[i]; bw[o] = S.bw[i]; cls[o] = S.cls[i]; mat[o] = matIdx(S, S.matN[i]); } }
  // ---- joints (m, after the pose): the shader's pivots for this avatar (the body donor's; one skeleton per sex)
  const { hip, knee, ankle, sh, el, wr, neck } = SB;
  let top = 0; for (let i = 0; i < nV; i++) top = Math.max(top, pos[i * 3 + 1]);
  const joints = { hipX: hip.x, hipY: hip.y, kneeY: knee.y, kneeZ: knee.z, ankleY: ankle.y, shX: sh.x, shY: sh.y, elY: el.y, elZ: el.z, wristY: wr.y, wristZ: wr.z, neckY: neck.y, top };
  // ---- the body's measures the accessories fit to
  const S = { sh, hip, shX: sh.x };
  { let zb = 0, zbh = 0, hw = 0, zs = [9, -9]; const hv = [], cards = [];
    for (let i = 0; i < nV; i++) { const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (b1[i] === 0 && cls[i] !== 0 && Math.abs(x) < 0.12 && y > sh.y - 0.4 && y < sh.y - 0.05) zb = Math.min(zb, z);
      if (b1[i] === 0 && Math.abs(x) < 0.15 && y > hip.y - 0.1 && y < hip.y + 0.2) zbh = Math.min(zbh, z);
      if ((b1[i] === 0 || b1[i] === 2 || b1[i] === 4) && y > hip.y - 0.1 && y < hip.y + 0.15) hw = Math.max(hw, Math.abs(x));
      if (Math.abs(x - (sh.x - 0.08)) < 0.03 && y > sh.y - 0.02 && cls[i] !== 1 && b1[i] !== 1) { zs[0] = Math.min(zs[0], z); zs[1] = Math.max(zs[1], z); }
      if (b1[i] === 1 && cls[i] === 0 && mat[i] !== undefined && /head/i.test(texOf[mat[i]])) hv.push([x, y, z]); else if (cls[i] === 1) cards.push([x, y, z]); }
    const mid = hv.filter((q) => Math.abs(q[0]) < 0.012), nose = mid.reduce((a, q) => (q[2] > a[2] ? q : a), [0, 0, -9]), eyeY = nose[1] + 0.038;
    const sk = hv.filter((q) => q[1] > eyeY + 0.01), all = sk.concat(cards.filter((q) => q[1] > eyeY + 0.01 && Math.abs(q[0]) < 0.13 && q[2] > nose[2] - 0.26));
    const zr = (L) => [Math.min(...L.map((q) => q[2])), Math.max(...L.map((q) => q[2]))], zA = zr(sk), zB = zr(all), yTop = Math.max(...all.map((q) => q[1]));
    const cy = eyeY + 0.012, cz = (zA[0] + zA[1]) / 2, rx = Math.min(0.105, Math.max(...all.map((q) => Math.abs(q[0])))) + 0.004;
    const rz = Math.min(0.13, Math.max(zA[1] - cz, cz - zB[0])) + 0.004, ry = Math.min(0.14, yTop - cy) + 0.004;
    // (a hood (Male_Adult_18) hides the skull: the head mesh above the eyes is the face alone; fit the sex's typical skull)
    const ok = rx > 0.08 && rz > 0.09 && ry > 0.08, hc = ok ? [0, cy, cz] : [0, cy, sex === 'm' ? 0.012 : -0.05], hr = ok ? [rx, ry, rz] : sex === 'm' ? [0.1, 0.125, 0.118] : [0.098, 0.112, 0.124];
    Object.assign(S, { zBack: zb, zBackHip: zbh, hipW: hw, zSh: (zs[0] + zs[1]) / 2, hc, hr }); }
  // ---- material/uv rect in the atlas (people-atlas.py): body / head CELL^2 in a CELL x 2 CELL cell, hair HCELL^2 in the hair atlas
  const col = ai % COLS, row = Math.floor(ai / COLS), A = out.atlas;
  const rect = (mname) => /opacity/i.test(mname) ? [col * HCELL / A.hairW, row * HCELL / A.hairH, HCELL / A.hairW, HCELL / A.hairH, 1]
    : /head/i.test(mname) ? [col * CELL / A.w, (row * 2 * CELL + CELL) / A.h, CELL / A.w, CELL / A.h, 0] : [col * CELL / A.w, row * 2 * CELL / A.h, CELL / A.w, CELL / A.h, 0];
  // ---- weld, then per LOD: simplify, compact, pack
  const key = new Map(), remap = new Uint32Array(nV), uniq = [];
  for (let i = 0; i < nV; i++) {
    const k = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], uv[i * 2], uv[i * 2 + 1], mat[i]].map((x) => Math.round(x * 1e5)).join(',');
    let j = key.get(k); if (j === undefined) { j = uniq.length; key.set(k, j); uniq.push(i); }
    remap[i] = j;
  }
  const nU = uniq.length, uPos = new Float32Array(nU * 3), uN = new Float32Array(nU * 3);
  for (let i = 0; i < nV; i++) { const j = remap[i]; uN[j * 3] += nrm[i * 3]; uN[j * 3 + 1] += nrm[i * 3 + 1]; uN[j * 3 + 2] += nrm[i * 3 + 2]; }
  uniq.forEach((i, j) => { uPos.set(pos.subarray(i * 3, i * 3 + 3), j * 3); const l = Math.hypot(uN[j * 3], uN[j * 3 + 1], uN[j * 3 + 2]) || 1; uN[j * 3] /= l; uN[j * 3 + 1] /= l; uN[j * 3 + 2] /= l; });
  const idx0 = new Uint32Array(nV); for (let i = 0; i < nV; i++) idx0[i] = remap[i];
  const lock = new Uint8Array(nU);
  { const cards = []; for (let j = 0; j < nU; j++) if (cls[uniq[j]] === 1) cards.push(j);
    const G = new Map(), key3 = (x, y, z) => `${Math.floor(x / 0.03)},${Math.floor(y / 0.03)},${Math.floor(z / 0.03)}`;
    for (const j of cards) { const k = key3(uPos[j * 3], uPos[j * 3 + 1], uPos[j * 3 + 2]); (G.get(k) || G.set(k, []).get(k)).push(j); }
    for (let j = 0; j < nU; j++) { const i = uniq[j]; if (b1[i] !== 1 || cls[i] !== 0) continue; const x = uPos[j * 3], y = uPos[j * 3 + 1], z = uPos[j * 3 + 2];
      let hit = false; for (let a = -1; a <= 1 && !hit; a++) for (let b = -1; b <= 1 && !hit; b++) for (let c = -1; c <= 1 && !hit; c++) { const l = G.get(key3(x + a * 0.03, y + b * 0.03, z + c * 0.03)); if (l) for (const q of l) if ((uPos[q * 3] - x) ** 2 + (uPos[q * 3 + 1] - y) ** 2 + (uPos[q * 3 + 2] - z) ** 2 < 0.0004) { hit = true; break; } }
      if (hit) lock[j] = 1; } }
  // UV samples for the atlas tool's class means (body/head/hair textures in their own UV space), each texture with its donor
  const smp = { name, tex: texOf, donor: texDonor, s: [] }; for (let j = 0; j < nU; j += 3) { const i = uniq[j]; smp.s.push([mat[i], cls[i], +uv[i * 2].toFixed(4), +uv[i * 2 + 1].toFixed(4)]); } uvSamples.push(smp);
  const av = { name, sex, ...(ea ? { ea: true } : {}), ...(headName ? { body: bodyName, head: headName } : {}), joints, lods: [], materials: texOf, tris0: nV / 3 };
  for (const [li, L] of LODS.entries()) {
    const ACC = accessories(S, li), accTris = ACC.I.length / 3;
    let idx = idx0;
    const target = L.tris - accTris;   // (P8) the accessories come out of the LOD's budget
    // (P8) the scalp under the hair cards is kept (vertex_lock): the cards' painted-hair mask (people-aux.py) is read at the
    // nearest scalp vertex, and with the accessories' triangles out of the budget the near LOD thinned it (a suit's cards 71 %
    // over hair, gate 75 %); near LOD only (locked, the mid LOD can't reach its 760), and only where it was lost (locking
    // every near LOD moves the other faces' mask raster, people-aux.py, enough to fail two mid LODs' lower-face rows)
    if (nV / 3 > target) { const [r, err] = MeshoptSimplifier.simplifyWithAttributes(idx0, uPos, 3, new Float32Array(nU), 1, [0], li === 0 && LOCK_SCALP.has(name) ? lock : null, target * 3, 0.05, []); idx = r; av['err_' + L.name] = +err.toFixed(5); }
    // compact
    const used = new Map(), list = []; for (const j of idx) if (!used.has(j)) { used.set(j, list.length); list.push(j); }
    // + the phone (bone 10): a 7 x 15 x 1.2 cm slab in the right hand, screen facing the body (regions 5 screen, 6 case)
    const phone = [];
    { const cx = -wr.x - 0.035, cy = wr.y - 0.06, cz = wr.z + 0.01, hx = 0.035, hy = 0.075, hz = 0.006;
      const F = [[[0, 0, -1], 5], [[0, 0, 1], 6], [[1, 0, 0], 6], [[-1, 0, 0], 6], [[0, 1, 0], 6], [[0, -1, 0], 6]];
      for (const [nn, rg] of F) { const ax = nn.map(Math.abs), u = ax[0] ? [0, 1, 0] : [1, 0, 0], w = [nn[1] * u[2] - nn[2] * u[1], nn[2] * u[0] - nn[0] * u[2], nn[0] * u[1] - nn[1] * u[0]];
        const c = [cx + nn[0] * hx, cy + nn[1] * hy, cz + nn[2] * hz], su = [hx, hy, hz][u.indexOf(1)], sw = [hx, hy, hz][w.findIndex((q) => q !== 0)];
        const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [c[0] + u[0] * a * su + w[0] * b * sw, c[1] + u[1] * a * su + w[1] * b * sw, c[2] + u[2] * a * su + w[2] * b * sw]);
        phone.push({ q, n: nn, rg }); } }
    const nAcc = ACC.P.length / 3, nv = list.length + phone.length * 4 + nAcc, ni = idx.length + phone.length * 6 + ACC.I.length;
    const oP = new Float32Array(nv * 3), oN = new Int8Array(nv * 4), oUV = new Float32Array(nv * 2), oB = new Uint8Array(nv * 4), oI = new Uint16Array(ni);
    list.forEach((j, k) => { const i = uniq[j], r = rect(texOf[mat[i]]);
      oP.set(uPos.subarray(j * 3, j * 3 + 3), k * 3); oN.set([Math.round(uN[j * 3] * 127), Math.round(uN[j * 3 + 1] * 127), Math.round(uN[j * 3 + 2] * 127), r[4] ? 127 : 0], k * 4);
      const u0 = uv[i * 2] - Math.floor(uv[i * 2]), v0 = uv[i * 2 + 1] - Math.floor(uv[i * 2 + 1]);
      oUV.set([r[0] + u0 * r[2], 1 - (r[1] + (1 - v0) * r[3])], k * 2);
      oB.set([b1[i], b2[i], Math.round(bw[i] * 255), cls[i]], k * 4); });
    idx.forEach((j, k) => { oI[k] = used.get(j); });
    phone.forEach((f, pI) => { const base = list.length + pI * 4; f.q.forEach((p, c) => { oP.set(p, (base + c) * 3); oN.set([f.n[0] * 127, f.n[1] * 127, f.n[2] * 127, 0], (base + c) * 4); oB.set([10, 10, 0, f.rg], (base + c) * 4); });
      oI.set([base, base + 1, base + 2, base, base + 2, base + 3], idx.length + pI * 6); });
    { const base = list.length + phone.length * 4;
      for (let k = 0; k < nAcc; k++) { oP.set(ACC.P.slice(k * 3, k * 3 + 3), (base + k) * 3); oN.set([Math.round(ACC.N[k * 3] * 127), Math.round(ACC.N[k * 3 + 1] * 127), Math.round(ACC.N[k * 3 + 2] * 127), 0], (base + k) * 4); oB.set([ACC.B[k], ACC.B[k], 0, ACC.R[k]], (base + k) * 4); }
      ACC.I.forEach((q, k) => { oI[idx.length + phone.length * 6 + k] = base + q; }); }
    av.lods.push({ name: L.name, verts: nv, tris: ni / 3, acc: accTris, pos: push(oP), nrm: push(oN), uv: push(oUV), bone: push(oB), index: push(oI) });
  }
  out.avatars.push(av);
  console.log(`${name}: ${nV / 3} tris -> ${av.lods.map((l) => `${l.name} ${l.tris} (acc ${l.acc})`).join(', ')}; height ${top.toFixed(3)} m, hip ${joints.hipY.toFixed(3)}, shoulder ${joints.shY.toFixed(3)}; head ${S.hc.map((q) => q.toFixed(3))} r ${S.hr.map((q) => q.toFixed(3))}, back ${S.zBack.toFixed(3)}`);
}
mkdirSync(outDir, { recursive: true });
const bin = new Uint8Array(off); let o2 = 0; for (const c of chunks) { bin.set(c, o2); o2 += c.byteLength; }
writeFileSync(join(outDir, 'people.bin'), bin);
out.bytes = off;
writeFileSync(join(outDir, 'people.json'), JSON.stringify(out, null, 1));
writeFileSync(join(outDir, 'uvsamples.json'), JSON.stringify(uvSamples));
console.log(`people.bin ${(off / 1024).toFixed(0)} KB; uvsamples.json for seoul/tools/people-atlas.py`);
void readdirSync;
