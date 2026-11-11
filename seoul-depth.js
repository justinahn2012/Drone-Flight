// seoul-depth.js: movers into the depth pass (P5 stream H, native #6 / panel4 bug "depthScene is empty").
// fpvcam renders world.depthScene into the half-res packed log depth after the collider (contract C2): the SSAO reads
// it (contact occlusion, contract C3) and so does the shutter blur. Seoul's depthScene was empty, so the traffic had no
// contact shadow and the blur's depth saw the road through every car. Here each vehicle InstancedMesh the life part
// lists (group.userData.motionMeshes, contract P2-A1) gets a depth proxy: the same geometry and the same instanceMatrix
// buffer (nothing is copied or uploaded twice), drawn with depthC2Opaque (the identical packing). update() syncs count
// and the parent transform each frame. The crowd (bone-skinned in its own vertex shader) is not proxied: its near tier
// would need its skinning in a depth program, and at 0.5-0.6 M triangles it would double the depth pass on a phone.
// The Metal port does the same with one depth-only pipeline over the traffic instance buffer (PARITY.md).
import * as THREE from 'three';
import { depthC2Opaque } from './world-core.js';

export function moverDepth(depthScene, meshes) {
  const list = (meshes || []).filter((m) => m?.isInstancedMesh && m.geometry?.attributes?.position);
  if (!depthScene || !list.length) return { update() {}, proxies: 0, dispose() {} };
  const mat = depthC2Opaque({ vsMain: '#ifdef USE_INSTANCING\n  transformed = (instanceMatrix * vec4(transformed, 1.0)).xyz;\n#endif' });
  mat.side = THREE.FrontSide;   // closed bodies: the front faces are the depth
  const P = list.map((src) => {
    const p = new THREE.InstancedMesh(src.geometry, mat, 1);
    p.instanceMatrix = src.instanceMatrix; p.count = 0;
    p.name = 'depth-' + (src.name || 'mover'); p.frustumCulled = false; p.matrixAutoUpdate = false;
    depthScene.add(p); return [src, p];
  });
  return {
    proxies: P.length,
    update() {
      for (const [src, p] of P) {
        let vis = true; for (let o = src; o; o = o.parent) if (!o.visible) { vis = false; break; }
        p.instanceMatrix = src.instanceMatrix; p.count = src.count; p.visible = vis && src.count > 0;
        p.matrix.copy(src.matrixWorld); p.matrixWorldNeedsUpdate = true;
      }
    },
    dispose() { for (const [, p] of P) depthScene.remove(p); mat.dispose(); },
  };
}
