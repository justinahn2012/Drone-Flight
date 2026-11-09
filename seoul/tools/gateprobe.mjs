// seoul/tools/gateprobe.mjs — [P3-F1 design #2] which take gates a vehicle can touch (stream F1).
// A gate is a rectangle {c, n, w, h, u?} (take.js). The drawn traffic (seoul-life.js LifeSim, world-seoul's seed 11) is
// stepped over 0..T s as world.movers sees it (seoul-movers.js lifeMovers, vehicles only: no people, so a person never
// hides a bus), and a grid of points on every low gate is asked movers.hit(p, r, t) every dt s. lines.mjs uses it to keep
// vehicles out of the gates (raise the floor, narrow, or drop the line); tests/movers.mjs asserts lines.json is clean.
//   vehicleTouches(sim, gates, {T = 600, dt = 0.25, r = 0.12, nu = 9, nv = 5}) -> [{i, n, top, cols: Set, rows: Set, t0, type}]
//     i: index into gates; n: touches; top: the highest roof (m) that touched; cols / rows: touched grid columns (along u)
//     / rows (along v); t0: the first touch (s); type: what touched first. Gates no vehicle can reach are skipped.
import { lifeMovers } from '../../seoul-movers.js';

const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// take.js compileGate's basis: u (width), v = n x u (height)
export function gateBasis(G) {
  const n = norm(G.n);
  let u = G.u ? G.u.slice() : Math.abs(n[1]) > 0.9 ? [1, 0, 0] : cross([0, 1, 0], n);
  const k = u[0] * n[0] + u[1] * n[1] + u[2] * n[2]; u = norm([u[0] - n[0] * k, u[1] - n[1] * k, u[2] - n[2] * k]);
  return { n, u, v: cross(n, u) };
}
// nu x nv points on the rectangle (inset 2 % from the edges), row-major by v
export function gateSamples(G, nu = 9, nv = 5) {
  const { u, v } = gateBasis(G), P = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = ((i + 0.5) / nu - 0.5) * G.w, b = ((j + 0.5) / nv - 0.5) * G.h;
    P.push({ i, j, p: [G.c[0] + u[0] * a + v[0] * b, G.c[1] + u[1] * a + v[1] * b, G.c[2] + u[2] * a + v[2] * b] });
  }
  return P;
}
export const VEH_REACH = 3.4;   // m: seoul-movers.js VEH_TOP (bus 3.15 m + slack): nothing drives higher

export function vehicleTouches(sim, gates, { T = 600, dt = 0.25, r = 0.12, nu = 9, nv = 5 } = {}) {
  const M = lifeMovers({ sim: { traffic: sim.traffic, net: sim.net } });   // vehicles only
  if (!M || !M.ts) return [];
  const low = [];
  gates.forEach((G, i) => {
    const S = gateSamples(G, nu, nv).filter((s) => s.p[1] - r < VEH_REACH);
    if (!S.length) return;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const s of S) { x0 = Math.min(x0, s.p[0]); x1 = Math.max(x1, s.p[0]); z0 = Math.min(z0, s.p[2]); z1 = Math.max(z1, s.p[2]); }
    low.push({ i, S, box: [x0 - r, x1 + r, z0 - r, z1 + r], rec: null });
  });
  if (!low.length) return [];
  const V = M.ts.vehicles;
  for (let k = 0; k * dt <= T + 1e-9; k++) {
    const t = k * dt;
    M._advance(t); const bb = M._broad();
    for (const L of low) {
      let near = false;
      for (let q = 0; q < V.length && !near; q++) if (!(L.box[1] < bb[q * 4] || L.box[0] > bb[q * 4 + 1] || L.box[3] < bb[q * 4 + 2] || L.box[2] > bb[q * 4 + 3])) near = true;
      if (!near) continue;
      for (const s of L.S) {
        const h = M.hit(s.p, r, t); if (!h || h.kind !== 'vehicle') continue;
        const v = V.find((x) => x.id === h.id);
        L.rec ||= { i: L.i, n: 0, top: 0, cols: new Set(), rows: new Set(), t0: t, type: h.type };
        L.rec.n++; L.rec.top = Math.max(L.rec.top, v?.H ?? 3.15); L.rec.cols.add(s.i); L.rec.rows.add(s.j);
      }
    }
  }
  return low.filter((L) => L.rec).map((L) => L.rec);
}
