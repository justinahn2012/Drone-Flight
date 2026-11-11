// tests/coverage.js: does the native export cover everything the game draws? (round 5, P5; native #1)
// Browser-safe ES module, no imports: tests/browser.mjs loads it into the game page and calls
//   coverage(world.scene, worldJson)
// with the live scene and the world.json written by tools/export-world.mjs. Every Mesh / InstancedMesh in the scene
// (visible now or not: LOD buckets toggle) must match one of worldJson.coverage's rules, else it is `uncovered` and
// the browser job fails: a new mesh in buildBando needs an export entry (or a declared runtime-only rule) first.
// Rules (tools/export-world.mjs COVERAGE), first match wins:
//   match.mesh 'world.glb'  a plain Mesh whose vertex count and bounds equal a world.json meshes[] row, or [P3 H] a
//                            cell of one: userData.exportKey / seoulKey names the row and its box lies inside the row's
//                            (D's splitCells: the row's deduped vertices, a draw range of a shared index); the
//                            cells' triangles must add up to the row's, else the row is reported in partialExports
//   match.program RE         material.customProgramCacheKey() matches
//   match.name RE            object.name matches;  match.parent RE: the parent's name matches
//   match.ancestor RE        [P2 H] some ancestor's name matches (a level's partner group: seoul-signs, seoul-life...)
//   match.instanced          must be (true) / must not be (false) an InstancedMesh
//   requires 'a.b.c'         a path in worldJson that must be truthy (e.g. instances.veg.count), else the match is
//                            `pending` when the target says status 'pending', otherwise uncovered
// Also reported: world.glb rows no scene mesh draws (`undrawnExports`, also a failure) and [P3 H] rows whose cells draw
// fewer triangles than the row holds (`partialExports`, a failure).
// summarize(cov) groups `uncovered` by class (name with digits stripped, parent, rule, why) for a short log line.
// [P2 H] worldJson.coverageObjects (e.g. ['Mesh', 'Points', 'Line']) widens what is checked beyond meshes, so a level's
// Points (steam) or line renderers (cables) need an entry too. Absent (bando): meshes only, as before.
// Runs in node as well (tools/export-world.mjs applies it to the headless Seoul scene).
export function coverage(scene, world) {
  const rules = world.coverage || [], rows = world.meshes || [];
  const get = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), world);
  const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-4 * Math.max(1, Math.abs(b[i])));
  const within = (mn, mx, b) => mn.every((v, i) => v >= b.min[i] - 1e-4 * Math.max(1, Math.abs(b.min[i]))) && mx.every((v, i) => v <= b.max[i] + 1e-4 * Math.max(1, Math.abs(b.max[i])));
  // [P3 H] bounds without touching the geometry: a cached box (BatchedMesh keeps its own), else computed here from the
  // positions, else null: D frees the CPU arrays once the GPU has them (count stays), and three's computeBoundingBox()
  // on a freed array logs a NaN error per mesh and leaves a NaN box behind (integ8: 33 console errors, 33 "uncovered")
  const fin = (b) => b && [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite);
  const boxOf = (m) => {
    const g = m.geometry, c = (m.isBatchedMesh && fin(m.boundingBox) && m.boundingBox) || (fin(g.boundingBox) && g.boundingBox);
    if (c) return [[c.min.x, c.min.y, c.min.z], [c.max.x, c.max.y, c.max.z]];
    const p = g.attributes.position; if (!p || p.isInterleavedBufferAttribute || !p.array || p.array.length < p.count * p.itemSize) return null;
    const A = p.array, k = p.itemSize, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.count; i++) for (let j = 0; j < 3; j++) { const v = A[i * k + j]; if (v < mn[j]) mn[j] = v; if (v > mx[j]) mx[j] = v; }
    return [mn, mx].every((a) => a.every(Number.isFinite)) ? [mn, mx] : null;
  };
  const trisOf = (g) => { const n = g.index ? g.index.count : g.attributes.position.count, s = Math.max(0, g.drawRange?.start || 0), c = g.drawRange?.count; return Math.floor(Math.max(0, Math.min(n - s, Number.isFinite(c) ? c : Infinity)) / 3); };
  const rowOf = (m) => {
    if (m.isInstancedMesh || !m.geometry?.attributes?.position) return null;
    const g = m.geometry, n = g.attributes.position.count;
    const key = m.userData?.exportKey ?? m.userData?.seoulKey;
    if (key != null) {   // [P3 H] a cell of a world.glb row (or the whole row under its own key)
      const r = rows.find((x) => x.name === key); if (!r) return null;
      const b = boxOf(m);   // a cell's (or batch's) box lies inside its row's; arrays freed and no cached box: the key decides
      return !b || within(b[0], b[1], r.bounds) ? r : null;
    }
    if (!rows.some((r) => r.vertices === n)) return null;
    const b = boxOf(m); if (!b) return null;
    return rows.find((r) => r.vertices === n && near(b[0], r.bounds.min) && near(b[1], r.bounds.max)) || null;
  };
  const progOf = (m) => { const mt = Array.isArray(m.material) ? m.material[0] : m.material; try { return mt?.customProgramCacheKey?.() || ''; } catch (e) { return ''; } };
  const out = { meshes: 0, byRule: {}, uncovered: [], pending: [], drawnRows: new Set(), rowTris: {} };
  const objs = world.coverageObjects || ['Mesh'];
  const counts = (m) => (m.isMesh && objs.includes('Mesh')) || (m.isPoints && objs.includes('Points')) || (m.isLine && objs.includes('Line'));
  const ancestorIs = (m, re) => { for (let p = m.parent; p; p = p.parent) if (re.test(p.name || '')) return true; return false; };
  scene.traverse((m) => {
    if (!counts(m)) return;
    out.meshes++;
    let hit = null, why = null;
    for (const r of rules) {
      const M = r.match || {};
      if (M.instanced !== undefined && !!m.isInstancedMesh !== M.instanced) continue;
      if (M.name && !new RegExp(M.name).test(m.name || '')) continue;
      if (M.parent && !new RegExp(M.parent).test(m.parent?.name || '')) continue;
      if (M.ancestor && !ancestorIs(m, new RegExp(M.ancestor))) continue;
      if (M.program && !new RegExp(M.program).test(progOf(m))) continue;
      if (M.mesh === 'world.glb') { const row = rowOf(m); if (!row) continue; out.drawnRows.add(row.name); out.rowTris[row.name] = (out.rowTris[row.name] || 0) + trisOf(m.geometry); }
      if (r.requires && !get(r.requires)) {
        const tgt = get(r.requires.split('.').slice(0, -1).join('.'));
        why = tgt?.status === 'pending' ? 'pending' : `requires ${r.requires}`;
        hit = r; break;
      }
      hit = r; break;
    }
    const desc = { name: m.name || '', type: m.isInstancedMesh ? 'InstancedMesh' : m.isPoints ? 'Points' : m.isLine ? 'Line' : 'Mesh', vertices: m.geometry?.attributes?.position?.count ?? 0, program: progOf(m), parent: m.parent?.name || '', visible: m.visible };
    if (!hit) out.uncovered.push(desc);
    else if (why === 'pending') { out.pending.push({ rule: hit.id, ...desc }); out.byRule[hit.id] = (out.byRule[hit.id] || 0) + 1; }
    else if (why) out.uncovered.push({ ...desc, rule: hit.id, why });
    else out.byRule[hit.id] = (out.byRule[hit.id] || 0) + 1;
  });
  const undrawnExports = rows.map((r) => r.name).filter((n) => !out.drawnRows.has(n));
  // [P3 H] a row drawn as cells must draw all its triangles (rows without a triangle count: skipped)
  const partialExports = rows.filter((r) => out.drawnRows.has(r.name) && Number.isFinite(r.triangles) && out.rowTris[r.name] < r.triangles).map((r) => ({ name: r.name, drawn: out.rowTris[r.name], triangles: r.triangles }));
  return { meshes: out.meshes, byRule: out.byRule, uncovered: out.uncovered, pending: [...new Set(out.pending.map((p) => p.rule))], pendingMeshes: out.pending.length, undrawnExports, partialExports, ok: !out.uncovered.length && !undrawnExports.length && !partialExports.length };
}

/** [P3 H] One line per class of uncovered object (the browser job logged the raw list: 900 KB on one line). */
export function summarize(cov, max = 12) {
  const by = new Map();
  for (const u of cov.uncovered || []) { const k = `${u.type} "${(u.name || '').replace(/-?\d+(,-?\d+)*$/, '*')}" parent "${u.parent}"${u.why ? ' (' + u.why + ')' : ''}`; by.set(k, (by.get(k) || 0) + 1); }
  const rows = [...by].sort((a, b) => b[1] - a[1]);
  return rows.slice(0, max).map(([k, n]) => `${n} x ${k}`).concat(rows.length > max ? [`... ${rows.length - max} more classes`] : []);
}
