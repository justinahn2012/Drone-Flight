// perf-levels.js: ?perf segments for the levels other than bando (P2 stream H for D's perf #5: "?perf for Seoul, for
// Justin's phone"). perf.js swaps its bando segments for these once the level has loaded. Each segment is a kinematic
// path built from the level's own data, so it follows the street when C / F1 move it:
//   walk    the WALKING STREET line at 6 m/s, at gate height, along the street's centreline (layout L1), not the chord
//   canyon  SCREEN CANYON at 8 m/s (the LED screens, the most dynamic emitters)
//   club    CLUB STREET at 6 m/s (signs, crowds, cables)
//   high    60 m (or 15 m over the tallest roof) over the block centre at 10 m/s, looking 25 deg down (far LODs)
// A segment ping-pongs along its path (pose(o, t) at any t), like perf.js's own. Missing line -> that segment is left out.
const DEG = Math.PI / 180;
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
export const LEVEL_SEGMENTS = {
  'seoul-hongdae': {
    layout: './seoul/layout.json',
    segments: [
      { name: 'walk', line: 'WALKING STREET', v: 6, pitch: 4 },
      { name: 'canyon', line: 'SCREEN CANYON', v: 8, pitch: 6 },
      { name: 'club', line: 'CLUB STREET', v: 6, pitch: 4 },
      { name: 'high', high: 60, v: 10, pitch: -25 },
    ],
  },
};

// centreline vertices of the street joining gates a and b (the chord cuts through corner buildings)
export function streetBetween(layout, a, b) {
  const proj = (P, x, z) => { let best = { d: Infinity, s: 0 }, s = 0;
    for (let i = 0; i < P.length - 1; i++) { const [ax, az] = P[i], [bx, bz] = P[i + 1], vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1e-9, t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2)), d = Math.hypot(x - ax - t * vx, z - az - t * vz), L = Math.sqrt(l2);
      if (d < best.d) best = { d, s: s + t * L }; s += L; } return best; };
  let best = null;
  for (const st of layout?.streets || []) { const pa = proj(st.points, a[0], a[2]), pb = proj(st.points, b[0], b[2]), d = Math.max(pa.d, pb.d); if (!best || d < best.d) best = { d, st, sa: pa.s, sb: pb.s }; }
  if (!best || best.d > best.st.width) return [];
  const out = []; let s = 0; const P = best.st.points, lo = Math.min(best.sa, best.sb), hi = Math.max(best.sa, best.sb);
  for (let i = 0; i < P.length; i++) { if (i) s += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); if (s > lo + 3 && s < hi - 3) out.push({ s, p: P[i] }); }
  if (best.sa > best.sb) out.reverse();
  return out.map(({ s: si, p }) => [p[0], a[1] + (b[1] - a[1]) * (si - best.sa) / (best.sb - best.sa || 1), p[1]]);
}

// a ping-pong walk along polyline pts (x, y, z) at v m/s -> pose(o, t) = [x, y, z, yaw, pitchDeg, vx, vy, vz]
function pathSegment(pts, v, pitch) {
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const len = cum[cum.length - 1] || 1;
  return { len, pose: (o, t) => {
    const u = (v * t) % (2 * len), back = u > len, s = back ? 2 * len - u : u;
    let i = 0; while (i < pts.length - 2 && cum[i + 1] < s) i++;
    const a = pts[i], b = pts[i + 1], f = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1), sg = back ? -1 : 1;
    const dx = (b[0] - a[0]) * sg, dy = (b[1] - a[1]) * sg, dz = (b[2] - a[2]) * sg, l = Math.hypot(dx, dy, dz) || 1;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, yawTo(dx, dz), pitch, dx / l * v, dy / l * v, dz / l * v];
  } };
}

/** perf.js segments ({name: {pose}}) for the loaded level, or null (bando, or a level with none defined). */
export async function levelSegments(o) {
  const id = o.world?.level, cfg = LEVEL_SEGMENTS[id];
  if (!cfg) return null;
  let layout = null;
  try { const r = await fetch(new URL(cfg.layout, import.meta.url)); layout = r.ok ? await r.json() : null; } catch (e) { layout = null; }
  const lines = o.world.lines || [], out = {};
  for (const sg of cfg.segments) {
    if (sg.high) {
      const b = o.world.bounds, cx = b ? (b.min.x + b.max.x) / 2 : 0, cz = b ? (b.min.z + b.max.z) / 2 : 0, half = b ? Math.min(150, (b.max.x - b.min.x) / 3) : 100;
      // 60 m, or 15 m over the tallest roof (a few Hongdae towers pass 60 m; the path must stay in open air)
      const top = Math.max(0, ...(layout?.lots || []).map((l) => (l.floors || 0) * (l.floorH || 3.2) + 4)), y = Math.max(sg.high, top + 15);
      out[sg.name] = pathSegment([[cx - half, y, cz], [cx + half, y, cz]], sg.v, sg.pitch);
      continue;
    }
    const l = lines.find((x) => x.name === sg.line && x.pre?.length) || lines.find((x) => x.name === sg.line);
    if (!l) continue;
    const pre = (l.pre || []).map((p) => p.c), a = pre[pre.length - 1] || [l.c[0] - l.n[0] * 40, l.c[1], l.c[2] - l.n[2] * 40];
    const pts = [...(pre.length ? pre : [a]), ...(layout ? streetBetween(layout, a, l.c) : []), l.c, [l.c[0] + l.n[0] * 15, l.c[1], l.c[2] + l.n[2] * 15]];
    out[sg.name] = pathSegment(pts, sg.v, sg.pitch);
  }
  return Object.keys(out).length ? out : null;
}
void DEG;
