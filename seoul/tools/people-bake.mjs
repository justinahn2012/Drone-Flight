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
THREE.TextureLoader.prototype.load = function () { return new THREE.Texture(); };   // node: no images (the atlas tool reads them)

// the order is the avatar index the crowd uses; 4 men, 4 women, November night clothing (jackets, suits, hoodies, trousers)
// (P6, life #1) + the library's six East Asian bodies (Hongdae on a Friday is 85 %+ Korean): Business_Male_02, Male_Adult_09,
// Male_Adult_10, Business_Female_03, Female_Adult_11, Female_Adult_05 (Female_Adult_03 tried: sleeveless,
// and its long hair cards stood off a bare scalp, 71 % on hair). 14 avatars in a 4 x 4 grid (atlas 2048 x 4096)
const AVATARS = [
  ['Business_Male_01', 'm'], ['Male_Adult_03', 'm'], ['Male_Adult_04', 'm'], ['Male_Adult_18', 'm'],
  ['Business_Female_04', 'f'], ['Female_Adult_07', 'f'], ['Female_Adult_09', 'f'], ['Female_Adult_13', 'f'],
  ['Business_Male_02', 'm', 'ea'], ['Male_Adult_09', 'm', 'ea'], ['Male_Adult_10', 'm', 'ea'],
  ['Business_Female_03', 'f', 'ea'], ['Female_Adult_11', 'f', 'ea'], ['Female_Adult_05', 'f', 'ea'],
];
const LODS = [{ name: 'near', tris: 3400 }, { name: 'lod1', tris: 1700 }, { name: 'mid', tris: 760 }];   // (P4 perf #2: lod1 for 8-18 m)

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

const out = { version: 1, source: 'Microsoft Rocketbox Avatar Library (MIT licence, (c) 2020 Microsoft)', atlas: { w: 2048, h: 4096, hairW: 1024, hairH: 1024 }, avatars: [] };
const chunks = []; let off = 0;
const push = (ta) => { const pad = (4 - (off % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); off += pad; } const b = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength); chunks.push(b.slice()); const o = off; off += b.byteLength; return o; };
const uvSamples = [];

for (const [ai, [name, sex, ea]] of AVATARS.entries()) {
  const buf = readFileSync(join(dir, name + '.fbx'));
  const obj = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  obj.updateMatrixWorld(true);
  const mesh = obj.getObjectByProperty('isSkinnedMesh', true), g = mesh.geometry, mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const B = (n) => obj.getObjectByName('Bip01_' + n), W = (b) => b.getWorldPosition(new THREE.Vector3());
  // ---- pose: arms hang (A-pose -> rest), 4 deg out, forearm 6 deg forward
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
  // ---- skin on the CPU (positions and normals), world space, cm -> m
  const P = g.attributes.position, N = g.attributes.normal, UV = g.attributes.uv, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, nV = P.count;
  const bones = mesh.skeleton.bones, bm = bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, mesh.skeleton.boneInverses[i]));
  const M = new THREE.Matrix4(), tmp = new THREE.Matrix4(), v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
  const pos = new Float32Array(nV * 3), nrm = new Float32Array(nV * 3), uv = new Float32Array(nV * 2), b1 = new Uint8Array(nV), b2 = new Uint8Array(nV), bw = new Float32Array(nV), cls = new Uint8Array(nV), mat = new Uint8Array(nV);
  const matOf = new Uint8Array(nV); for (const gr of g.groups) for (let i = gr.start; i < gr.start + gr.count; i++) matOf[i] = gr.materialIndex;
  for (let i = 0; i < nV; i++) {
    M.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0); const acc = new Map(); let top = -1, topW = -1;
    for (let k = 0; k < 4; k++) {
      const w = SW.getComponent(i, k); if (w <= 0) continue; const bi = SI.getComponent(i, k);
      tmp.copy(bm[bi]).multiplyScalar(w); for (let e = 0; e < 16; e++) M.elements[e] += tmp.elements[e];
      const id = myBone(bones[bi].name); acc.set(id, (acc.get(id) || 0) + w); if (w > topW) { topW = w; top = bi; }
    }
    M.premultiply(mesh.bindMatrix.clone().invert().premultiply(mesh.matrixWorld)).multiply(mesh.bindMatrix);
    v.fromBufferAttribute(P, i).applyMatrix4(M).multiplyScalar(0.01); nm.getNormalMatrix(M); n.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
    pos.set([v.x, v.y, v.z], i * 3); nrm.set([n.x, n.y, n.z], i * 3); uv.set([UV.getX(i), UV.getY(i)], i * 2);
    const ids = [...acc.entries()].sort((a, b) => b[1] - a[1]); const w1 = ids[0][1], w2 = ids[1] ? ids[1][1] : 0;
    b1[i] = ids[0][0]; b2[i] = ids[1] ? ids[1][0] : ids[0][0]; bw[i] = w2 / (w1 + w2);
    mat[i] = matOf[i]; cls[i] = classOf(mats[matOf[i]].name, bones[top].name);
  }
  // ---- joints (m, after the pose): the shader's pivots for this avatar
  const J = (nm2) => W(B(nm2)).multiplyScalar(0.01);
  const avg = (a, b) => ({ x: (Math.abs(a.x) + Math.abs(b.x)) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
  const hip = avg(J('L_Thigh'), J('R_Thigh')), knee = avg(J('L_Calf'), J('R_Calf')), ankle = avg(J('L_Foot'), J('R_Foot'));
  const sh = avg(J('L_UpperArm'), J('R_UpperArm')), el = avg(J('L_Forearm'), J('R_Forearm')), wr = avg(J('L_Hand'), J('R_Hand')), neck = J('Neck');
  let top = 0; for (let i = 0; i < nV; i++) if (cls[i] !== 1 || true) top = Math.max(top, pos[i * 3 + 1]);
  const joints = { hipX: hip.x, hipY: hip.y, kneeY: knee.y, kneeZ: knee.z, ankleY: ankle.y, shX: sh.x, shY: sh.y, elY: el.y, elZ: el.z, wristY: wr.y, wristZ: wr.z, neckY: neck.y, top };
  // ---- material/uv rect in the atlas (people-atlas.py): body / head 512^2 in a 512 x 1024 cell, hair 256^2 in the hair atlas
  const col = ai % 4, row = ai >> 2, A = out.atlas;
  const rect = (mname) => /opacity/i.test(mname) ? [col * 256 / A.hairW, row * 256 / A.hairH, 256 / A.hairW, 256 / A.hairH, 1]
    : /head/i.test(mname) ? [col * 512 / A.w, (row * 1024 + 512) / A.h, 512 / A.w, 512 / A.h, 0] : [col * 512 / A.w, row * 1024 / A.h, 512 / A.w, 512 / A.h, 0];
  const texOf = mats.map((m) => m.name);
  // ---- weld, then per LOD: simplify, compact, pack
  const key = new Map(), remap = new Uint32Array(nV), uniq = [];
  for (let i = 0; i < nV; i++) {
    const k = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], uv[i * 2], uv[i * 2 + 1], mat[i]].map((x) => Math.round(x * 1e5)).join(',');
    let j = key.get(k); if (j === undefined) { j = uniq.length; key.set(k, j); uniq.push(i); } else { n.set(nrm[j * 3], nrm[j * 3 + 1], nrm[j * 3 + 2]); }
    remap[i] = j;
  }
  const nU = uniq.length, uPos = new Float32Array(nU * 3), uN = new Float32Array(nU * 3);
  for (let i = 0; i < nV; i++) { const j = remap[i]; uN[j * 3] += nrm[i * 3]; uN[j * 3 + 1] += nrm[i * 3 + 1]; uN[j * 3 + 2] += nrm[i * 3 + 2]; }
  uniq.forEach((i, j) => { uPos.set(pos.subarray(i * 3, i * 3 + 3), j * 3); const l = Math.hypot(uN[j * 3], uN[j * 3 + 1], uN[j * 3 + 2]) || 1; uN[j * 3] /= l; uN[j * 3 + 1] /= l; uN[j * 3 + 2] /= l; });
  const idx0 = new Uint32Array(nV); for (let i = 0; i < nV; i++) idx0[i] = remap[i];
  // UV samples for the atlas tool's class means (body/head/hair textures in their own UV space)
  const smp = { name, tex: texOf, s: [] }; for (let j = 0; j < nU; j += 3) { const i = uniq[j]; smp.s.push([mat[i], cls[i], +uv[i * 2].toFixed(4), +uv[i * 2 + 1].toFixed(4)]); } uvSamples.push(smp);
  const av = { name, sex, ...(ea ? { ea: true } : {}), joints, lods: [], materials: texOf, tris0: nV / 3 };
  for (const L of LODS) {
    let idx = idx0;
    if (nV / 3 > L.tris) { const [r, err] = MeshoptSimplifier.simplify(idx0, uPos, 3, L.tris * 3, 0.05, []); idx = r; av['err_' + L.name] = +err.toFixed(5); }
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
    const nv = list.length + phone.length * 4, ni = idx.length + phone.length * 6;
    const oP = new Float32Array(nv * 3), oN = new Int8Array(nv * 4), oUV = new Float32Array(nv * 2), oB = new Uint8Array(nv * 4), oI = new Uint16Array(ni);
    list.forEach((j, k) => { const i = uniq[j], r = rect(texOf[mat[i]]);
      oP.set(uPos.subarray(j * 3, j * 3 + 3), k * 3); oN.set([Math.round(uN[j * 3] * 127), Math.round(uN[j * 3 + 1] * 127), Math.round(uN[j * 3 + 2] * 127), r[4] ? 127 : 0], k * 4);
      const u0 = uv[i * 2] - Math.floor(uv[i * 2]), v0 = uv[i * 2 + 1] - Math.floor(uv[i * 2 + 1]);
      oUV.set([r[0] + u0 * r[2], 1 - (r[1] + (1 - v0) * r[3])], k * 2);
      oB.set([b1[i], b2[i], Math.round(bw[i] * 255), cls[i]], k * 4); });
    idx.forEach((j, k) => { oI[k] = used.get(j); });
    phone.forEach((f, pI) => { const base = list.length + pI * 4; f.q.forEach((p, c) => { oP.set(p, (base + c) * 3); oN.set([f.n[0] * 127, f.n[1] * 127, f.n[2] * 127, 0], (base + c) * 4); oB.set([10, 10, 0, f.rg], (base + c) * 4); });
      oI.set([base, base + 1, base + 2, base, base + 2, base + 3], idx.length + pI * 6); });
    av.lods.push({ name: L.name, verts: nv, tris: ni / 3, pos: push(oP), nrm: push(oN), uv: push(oUV), bone: push(oB), index: push(oI) });
  }
  out.avatars.push(av);
  console.log(`${name}: ${nV / 3} tris -> ${av.lods.map((l) => `${l.name} ${l.tris}`).join(', ')}; height ${top.toFixed(3)} m, hip ${joints.hipY.toFixed(3)}, shoulder ${joints.shY.toFixed(3)}, elbow ${joints.elY.toFixed(3)}, wrist ${joints.wristY.toFixed(3)}`);
}
mkdirSync(outDir, { recursive: true });
const bin = new Uint8Array(off); let o2 = 0; for (const c of chunks) { bin.set(c, o2); o2 += c.byteLength; }
writeFileSync(join(outDir, 'people.bin'), bin);
out.bytes = off;
writeFileSync(join(outDir, 'people.json'), JSON.stringify(out, null, 1));
writeFileSync(join(outDir, 'uvsamples.json'), JSON.stringify(uvSamples));
console.log(`people.bin ${(off / 1024).toFixed(0)} KB; uvsamples.json for seoul/tools/people-atlas.py`);
void readdirSync;
