// tests/coverage.js: does the native export cover everything the game draws? (round 5, P5; native #1)
// Browser-safe ES module, no imports: tests/browser.mjs loads it into the game page and calls
//   coverage(world.scene, worldJson)
// with the live scene and the world.json written by tools/export-world.mjs. Every Mesh / InstancedMesh in the scene
// (visible now or not: LOD buckets toggle) must match one of worldJson.coverage's rules, else it is `uncovered` and
// the browser job fails: a new mesh in buildBando needs an export entry (or a declared runtime-only rule) first.
// Rules (tools/export-world.mjs COVERAGE), first match wins:
//   match.mesh 'world.glb'  a plain Mesh whose vertex count and bounds equal a world.json meshes[] row
//   match.program RE         material.customProgramCacheKey() matches
//   match.name RE            object.name matches;  match.parent RE: the parent's name matches
//   match.instanced          must be (true) / must not be (false) an InstancedMesh
//   requires 'a.b.c'         a path in worldJson that must be truthy (e.g. instances.veg.count), else the match is
//                            `pending` when the target says status 'pending', otherwise uncovered
// Also reported: world.glb rows no scene mesh draws (`undrawnExports`, also a failure).
export function coverage(scene, world) {
  const rules = world.coverage || [], rows = world.meshes || [];
  const get = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), world);
  const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-4 * Math.max(1, Math.abs(b[i])));
  const rowOf = (m) => {
    if (m.isInstancedMesh || !m.geometry?.attributes?.position) return null;
    const g = m.geometry, n = g.attributes.position.count;
    if (!rows.some((r) => r.vertices === n)) return null;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox, mn = [b.min.x, b.min.y, b.min.z], mx = [b.max.x, b.max.y, b.max.z];
    return rows.find((r) => r.vertices === n && near(mn, r.bounds.min) && near(mx, r.bounds.max)) || null;
  };
  const progOf = (m) => { const mt = Array.isArray(m.material) ? m.material[0] : m.material; try { return mt?.customProgramCacheKey?.() || ''; } catch (e) { return ''; } };
  const out = { meshes: 0, byRule: {}, uncovered: [], pending: [], drawnRows: new Set() };
  scene.traverse((m) => {
    if (!m.isMesh) return;
    out.meshes++;
    let hit = null, why = null;
    for (const r of rules) {
      const M = r.match || {};
      if (M.instanced !== undefined && !!m.isInstancedMesh !== M.instanced) continue;
      if (M.name && !new RegExp(M.name).test(m.name || '')) continue;
      if (M.parent && !new RegExp(M.parent).test(m.parent?.name || '')) continue;
      if (M.program && !new RegExp(M.program).test(progOf(m))) continue;
      if (M.mesh === 'world.glb') { const row = rowOf(m); if (!row) continue; out.drawnRows.add(row.name); }
      if (r.requires && !get(r.requires)) {
        const tgt = get(r.requires.split('.').slice(0, -1).join('.'));
        why = tgt?.status === 'pending' ? 'pending' : `requires ${r.requires}`;
        hit = r; break;
      }
      hit = r; break;
    }
    const desc = { name: m.name || '', type: m.isInstancedMesh ? 'InstancedMesh' : 'Mesh', vertices: m.geometry?.attributes?.position?.count ?? 0, program: progOf(m), parent: m.parent?.name || '', visible: m.visible };
    if (!hit) out.uncovered.push(desc);
    else if (why === 'pending') { out.pending.push({ rule: hit.id, ...desc }); out.byRule[hit.id] = (out.byRule[hit.id] || 0) + 1; }
    else if (why) out.uncovered.push({ ...desc, rule: hit.id, why });
    else out.byRule[hit.id] = (out.byRule[hit.id] || 0) + 1;
  });
  const undrawnExports = rows.map((r) => r.name).filter((n) => !out.drawnRows.has(n));
  return { meshes: out.meshes, byRule: out.byRule, uncovered: out.uncovered, pending: [...new Set(out.pending.map((p) => p.rule))], pendingMeshes: out.pending.length, undrawnExports, ok: !out.uncovered.length && !undrawnExports.length };
}
