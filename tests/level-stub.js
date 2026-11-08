// tests/level-stub.js — a minimal level module for the S0 level-switch tests (tests/levels.test.json, ?levels=...).
// It implements the world contract main.js loads (contract L2, the same shape buildBando returns) on world-core.js, so it
// is also the smallest reference for a new level: scene, colliderScene, bvh, skimBvh, update, spawn / yaw, takeStart,
// startPoints, lines (take.js gates), funnels, bounds, envelope, aoUniforms, depthScene, dispose.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { Site, aoUniforms, colliderScene, rng } from '../world-core.js';

// CPU-only geometry (tools/export-world.mjs --level stub --levels tests/levels.test.json)
export function buildStubGeometry() {
  const MATS = { wall: { tile: 2, albedo: [0.25, 0.24, 0.22], rough: 0.9 }, ground: { tile: 4, albedo: [0.05, 0.05, 0.06], rough: 1 } };
  const S = new Site(MATS), R = rng(42);
  S.box('ground', 0, -0.5, 0, 200, 0.5, 200);
  for (let i = 0; i < 24; i++) S.box('wall', (R() - 0.5) * 120, 0, (R() - 0.5) * 120 - 20, 4 + R() * 8, 6 + R() * 30, 4 + R() * 8);
  S.box('wall', -6, 0, -30, 2, 8, 2); S.box('wall', 6, 0, -30, 2, 8, 2); S.box('wall', 0, 8, -30, 14, 1.5, 2);   // a gate
  const merged = {}, solid = [];
  for (const [k, parts] of Object.entries(S.parts)) {
    merged[k] = mergeGeometries(parts.map((p) => p.g)); merged[k].computeBoundingSphere();
    for (const p of parts) if (p.collide) solid.push(p.g);
  }
  const posOnly = (g) => { const q = new THREE.BufferGeometry(); q.setAttribute('position', g.attributes.position); q.setIndex(g.index); return q; };
  const colGeo = mergeGeometries(solid.map(posOnly));
  const lines = [{ name: 'STUB GATE', caption: 'STUB *GATE*!', pts: 1500, c: [0, 4, -30], n: [0, 0, -1], w: 10, h: 7.5, u: [1, 0, 0] }];
  return { merged, colGeo, lines, materials: MATS, spawn: new THREE.Vector3(0, 2, 30), yaw: 0, takeStart: { pos: new THREE.Vector3(0, 3, 20), yaw: 0 },
    startPoints: [{ name: 'Gate', pos: new THREE.Vector3(0, 3, 20), yaw: 0 }], funnels: [],
    bounds: new THREE.Box3(new THREE.Vector3(-120, -5, -120), new THREE.Vector3(120, 120, 120)),
    envelope: { min: new THREE.Vector3(-100, -1, -100), max: new THREE.Vector3(100, 100, 100) } };
}

export async function buildStub(renderer, scene, { onProgress } = {}) {
  scene ||= new THREE.Scene();
  onProgress?.(0.2, 'Stub level');
  const G = buildStubGeometry(), bvh = new MeshBVH(G.colGeo, { maxLeafTris: 5 });
  const mats = { wall: new THREE.MeshStandardMaterial({ color: 0x8a8580, roughness: 0.9 }), ground: new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 1 }) };
  for (const [k, g] of Object.entries(G.merged)) { const m = new THREE.Mesh(g, mats[k]); m.castShadow = m.receiveShadow = true; scene.add(m); }
  scene.background = new THREE.Color(0x0a0b14);
  scene.add(new THREE.HemisphereLight(0x8090ff, 0x201010, 1.2));
  const sun = new THREE.DirectionalLight(0xffd0a0, 2.5); sun.position.set(30, 60, 20); scene.add(sun);
  onProgress?.(0.95, 'Ready');
  let disposed = 0;
  return {
    scene, colliderScene: colliderScene(G.colGeo), depthScene: null, bvh, skimBvh: bvh, hdr: true, stats: { stub: true },
    update: () => {},
    spawn: G.spawn, yaw: G.yaw, takeStart: G.takeStart, startPoints: G.startPoints, funnels: G.funnels, lines: G.lines,
    bounds: G.bounds, envelope: G.envelope,
    aoUniforms: aoUniforms(),
    dispose: () => { disposed++; globalThis.__stubDisposed = disposed; },
  };
}
