// seoul/tools/osm-layout.mjs — build seoul/layout.json (contract L1) for the Hongdae block from OpenStreetMap.
//   node seoul/tools/osm-layout.mjs <a.osm> [b.osm ...] > seoul/layout.json
// Input: raw OSM XML from api.openstreetmap.org/api/0.6/map?bbox=... (ODbL, © OpenStreetMap contributors).
// Footprints and street centrelines are OSM's. Storeys: building:levels where mapped (~12 %), else an estimate from
// footprint area and street class (seeded per OSM id, so it never reshuffles). Carriageway widths from lanes x 3.25 m
// where tagged, else class defaults checked against the street photos (see seoul/survey.md). Uses from the POIs inside
// each footprint (amenity / shop), else a seeded draw weighted by street kind. Screens are placed by rule (tallest lots
// at the station front and the main junctions; small shopfront screens on the walking street) until reference.md
// gives measured ones.
import fs from 'node:fs';

// reference.md's recommended block: 37.5512-37.5552 N, 126.9207-126.9241 E (~300 x 440 m); origin at its centre.
// Plus the Yanghwa-ro station strip north of it (reference.md: "optional station strip", exits 9/1/8/2 and the OOH LED
// screens at nos. 151-176): lots within 45 m of the Yanghwa-ro centrelines up to 37.5573 N, tagged context.
const ORIGIN = { lat: 37.5532, lon: 126.9224 };
const CORE = { x0: -150, x1: 150, z0: -222, z1: 222 };
const STRIP = { x0: -150, x1: 265, z0: -470, z1: -150, reach: 45 };
const EXT = { x0: -170, x1: 285, z0: -490, z1: 242 };
const kx = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180), kz = 110574;
const proj = (lat, lon) => [+((lon - ORIGIN.lon) * kx).toFixed(2), +(-(lat - ORIGIN.lat) * kz).toFixed(2)];

// ---- parse
const nodes = new Map(), ways = new Map(), poi = [];
for (const f of process.argv.slice(2)) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/<node id="(\d+)"[^>]*?lat="([\d.-]+)" lon="([\d.-]+)"(\/>|>([\s\S]*?)<\/node>)/g)) {
    nodes.set(m[1], proj(+m[2], +m[3]));
    if (m[5]) { const t = tags(m[5]); if (t.amenity || t.shop || t.tourism || t.leisure) poi.push({ id: m[1], p: nodes.get(m[1]), t }); }
  }
  for (const m of s.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
    if (ways.has(m[1])) continue;
    ways.set(m[1], { id: m[1], nd: [...m[2].matchAll(/<nd ref="(\d+)"/g)].map((x) => x[1]), t: tags(m[2]) });
  }
}
function tags(s) { const t = {}; for (const m of s.matchAll(/<tag k="([^"]+)" v="([^"]*)"/g)) t[m[1]] = m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"'); return t; }

// ---- helpers
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
const inRect = ([x, z], R, m = 0) => x >= R.x0 - m && x <= R.x1 + m && z >= R.z0 - m && z <= R.z1 + m;
const area = (P) => { let a = 0; for (let i = 0; i < P.length; i++) { const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % P.length]; a += x0 * z1 - x1 * z0; } return a / 2; };
const centroid = (P) => { let cx = 0, cz = 0, a = 0; for (let i = 0; i < P.length; i++) { const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % P.length], c = x0 * z1 - x1 * z0; a += c; cx += (x0 + x1) * c; cz += (z0 + z1) * c; } return [cx / (3 * a), cz / (3 * a)]; };
const segD = ([px, pz], [ax, az], [bx, bz]) => { const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1e-9; const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2)); return Math.hypot(px - ax - t * vx, pz - az - t * vz); };
const lineD = (p, pts) => { let d = Infinity; for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segD(p, pts[i], pts[i + 1])); return d; };
const pip = ([x, z], P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
const r2 = (v) => Math.round(v * 100) / 100;
// clip a polyline to the box (keeps the pieces inside; each piece becomes its own street entry)
function clipPoly(pts, R) {
  const out = []; let cur = [];
  const clipSeg = (a, b) => { let t0 = 0, t1 = 1; const dx = b[0] - a[0], dz = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - R.x0], [dx, R.x1 - a[0]], [-dz, a[1] - R.z0], [dz, R.z1 - a[1]]]) { if (p === 0) { if (q < 0) return null; continue; } const r = q / p; if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; } }
    return [[a[0] + dx * t0, a[1] + dz * t0], [a[0] + dx * t1, a[1] + dz * t1], t0 > 0, t1 < 1]; };
  for (let i = 0; i < pts.length - 1; i++) {
    const c = clipSeg(pts[i], pts[i + 1]);
    if (!c) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    if (!cur.length || c[2]) { if (cur.length > 1) out.push(cur); cur = [c[0]]; }
    cur.push(c[1]);
    if (c[3]) { out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out.map((p) => p.map(([x, z]) => [r2(x), r2(z)]));
}
// drop near-duplicate and collinear vertices (< 0.25 m off the line)
function simplify(P) {
  let Q = P.filter((p, i) => Math.hypot(p[0] - P[(i + P.length - 1) % P.length][0], p[1] - P[(i + P.length - 1) % P.length][1]) > 0.3);
  let changed = true;
  while (changed && Q.length > 3) { changed = false; for (let i = 0; i < Q.length; i++) { const a = Q[(i + Q.length - 1) % Q.length], b = Q[i], c = Q[(i + 1) % Q.length]; if (segD(b, a, c) < 0.25) { Q.splice(i, 1); changed = true; break; } } }
  return Q;
}

// ---- streets
const SKIP = new Set(['footway', 'steps', 'corridor', 'path', 'cycleway', 'elevator', 'platform', 'construction', 'proposed']);
// carriageway defaults (m). Yanghwa-ro is mapped as several one-way carriageways plus the median busway.
const WIDTH = { primary: 10.5, secondary: 9.5, tertiary: 8, residential: 6, unclassified: 6, living_street: 5, pedestrian: 9, service: 4, busway: 7 };
const CLUB_ST = new Set(['와우산로21길', '와우산로19길', '어울마당로 (클럽거리)']);
const streets = [];
let sid = 0;
for (const w of ways.values()) {
  const hw = w.t.highway; if (!hw || SKIP.has(hw) || w.t.area === 'yes') continue;
  if (hw === 'service' && (w.t.service === 'parking_aisle' || w.t.service === 'driveway') && !w.t.name) continue;
  const pts = w.nd.map((n) => nodes.get(n)).filter(Boolean); if (pts.length < 2) continue;
  for (const piece of clipPoly(pts, EXT)) {
    if (!piece.some((p) => inRect(p, CORE, 20)) && w.t.name !== '양화로') continue;   // outside the block: only Yanghwa-ro runs on
    let len = 0; for (let i = 0; i < piece.length - 1; i++) len += Math.hypot(piece[i + 1][0] - piece[i][0], piece[i + 1][1] - piece[i][1]);
    if (len < 6) continue;
    const name = w.t['name:en'] || w.t.name || '', ko = w.t.name || '';
    let kind = ['primary', 'secondary', 'tertiary', 'busway'].includes(hw) ? 'main' : hw === 'pedestrian' ? 'walking' : 'alley';
    if (CLUB_ST.has(ko)) kind = 'club';
    // Eoulmadang-ro between Hongik-ro and Wausan-ro 21-gil: the car-free "youth street" (Seoul traffic news, 220 m)
    if (ko === '어울마당로' && piece.some(([x, z]) => z > -124 && z < 106 && x > -127 && x < 13)) kind = 'walking';
    // [P2-C] Red Road R1-R2, the real Walking Street (걷고싶은거리: stage, busking zone, pine planters) runs on from Hongik-ro
    // to the station (Yanghwa-ro). OSM tags it highway=residential, which phase 1 drew as a 6 m alley; aerial and OSM
    // footprints give 13-24 m facade to facade between Hongik-ro and the R2 plaza.
    if (ko === '어울마당로' && piece.every(([x, z]) => z < -118 && x > -5)) kind = 'walking';
    let width = w.t.lanes ? Math.max(3, +w.t.lanes * 3.25) : WIDTH[hw] ?? 5;
    if (w.t.width && !isNaN(+w.t.width)) width = +w.t.width;
    if (kind === 'walking' && width < 9) width = 9;
    streets.push({ id: 's' + String(sid++).padStart(3, '0'), name, ko, kind, width: r2(width), points: piece, osm: +w.id, hw });
  }
}
const KRANK = { main: 0, walking: 1, club: 2, alley: 3 };

// ---- [P2-C] measured clearances (facade to facade, m). OSM footprints in Hongdae are traced roofs and sit 1-3 m into the
// lanes where the lanes are narrow. Measured on Bing aerial at 0.24 m/px (19 x 19 tiles, roof edge to roof edge, profiles
// every 5 m; reference only, nothing ships) and checked against the press: Seogyo 365 is a ~250 m row of 2-5 m wide
// buildings on the old Dangin-ri rail bed, between the wide 주차장길 (this fork of Eoulmadang-ro) and the narrow old
// 서교시장길 (Hongik-ro 3-gil) (Seoul Shinmun 2018-06-21; KOCIS "From railroad to festival alley"). The fork is the 220 m
// car-free stretch Hongik-ro -> Wausan-ro 21-gil (Seoul traffic news 11842). It is NOT the 10-14 m Walking Street: that
// is R1-R2 north of Hongik-ro (above), already 13-24 m in OSM. Vertices of lots inside half the clearance are pushed
// out, perpendicular to the centreline (lots only shrink, so nothing new intrudes on a lane or a gate).
const CLEAR = [
  { ko: '어울마당로', kind: 'walking', z: [-126, -45], w: 9.5, why: 'Seogyo 365 fork, Hongik-ro half: aerial 8.5-10.5 m (OSM 5.5-6.5)' },
  { ko: '어울마당로', kind: 'walking', z: [-45, 92], w: 6.5, why: 'Seogyo 365 fork, south half (walk0): aerial 5.5-6.5 m (OSM 3.6-7)' },
];
const nearestOn = (p, pts) => { let best = null; for (let i = 0; i < pts.length - 1; i++) { const [ax, az] = pts[i], [bx, bz] = pts[i + 1], vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - ax) * vx + (p[1] - az) * vz) / l2)), q = [ax + t * vx, az + t * vz], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
  if (!best || d < best.d) best = { q, d, tx: vx / Math.sqrt(l2), tz: vz / Math.sqrt(l2) }; } return best; };
const clearLog = [];
function clearLanes(P, id) {
  let Q = P.map((p) => p.slice()), moved = 0;
  for (const c of CLEAR) for (const s of streets) {
    if (s.ko !== c.ko || s.kind !== c.kind) continue;
    const half = c.w / 2;
    Q = Q.map((p) => { const n = nearestOn(p, s.points); if (!n || n.d >= half || n.q[1] < c.z[0] || n.q[1] > c.z[1]) return p;
      // push along the lane's normal, on the vertex's side (a vertex on the centreline goes to the lot's side)
      let ox = -n.tz, oz = n.tx; const sd = (p[0] - n.q[0]) * ox + (p[1] - n.q[1]) * oz; if (sd < 0) { ox = -ox; oz = -oz; }
      const ds = half - Math.abs(sd); if (ds <= 0.01) return p; moved = Math.max(moved, ds); return [p[0] + ox * ds, p[1] + oz * ds]; });
  }
  if (!moved) return P;
  const a0 = area(P), a1 = area(Q);
  if (a1 < a0 * 0.3 || a1 <= 0) { clearLog.push(`${id}: would shrink to ${(a1 / a0 * 100).toFixed(0)} %, dropped`); return null; }
  clearLog.push(`${id}: ${moved.toFixed(2)} m`);
  return Q;
}

// ---- lots
const USE_OF = (t) => {
  const a = t.amenity, s = t.shop;
  if (a === 'nightclub' || a === 'theatre' || a === 'music_venue' || t.club) return 'club';
  if (a === 'bar' || a === 'pub' || a === 'biergarten') return 'bar';
  if (a === 'restaurant' || a === 'fast_food' || a === 'food_court') return 'restaurant';
  if (a === 'cafe' || a === 'ice_cream') return 'cafe';
  if (a === 'karaoke_box' || a === 'karaoke' || t.leisure === 'karaoke') return 'karaoke';
  if (a === 'internet_cafe' || t.leisure === 'amusement_arcade') return 'pc';
  if (s === 'convenience' || s === 'supermarket') return 'conv';
  if (t.tourism === 'hotel' || t.tourism === 'hostel' || t.tourism === 'guest_house') return 'hotel';
  if (t.tourism === 'motel') return 'motel';
  if (a === 'bank' || a === 'clinic' || a === 'dentist' || a === 'doctors' || t.office) return 'office';
  if (s) return 'shop';
  return null;
};
const WEIGHTS = { main: { shop: 4, restaurant: 3, cafe: 3, conv: 1, office: 3, hotel: 1, karaoke: 1, pc: 1, bar: 1 },
  walking: { shop: 4, restaurant: 3, cafe: 3, bar: 2, club: 1, karaoke: 1, conv: 1, pc: 1 },
  club: { club: 4, bar: 4, pocha: 2, restaurant: 2, karaoke: 1, conv: 1, motel: 1 },
  alley: { restaurant: 3, bar: 3, cafe: 2, pocha: 1, shop: 2, karaoke: 1, motel: 1, office: 1, club: 1 } };
const draw = (w, r) => { const tot = Object.values(w).reduce((a, b) => a + b, 0); let x = r * tot; for (const [k, v] of Object.entries(w)) if ((x -= v) < 0) return k; return 'shop'; };

const yanghwa = streets.filter((s) => s.ko === '양화로' && s.kind === 'main');
const r1r2 = streets.filter((s) => s.ko === '어울마당로' && s.kind === 'walking' && s.points.every(([x, z]) => z < -118)), WALK_REACH = 30;
const lots = [];
for (const w of ways.values()) {
  if (!w.t.building || w.nd.length < 4 || w.nd[0] !== w.nd[w.nd.length - 1]) continue;
  if (['roof', 'construction', 'ruins'].includes(w.t.building)) continue;
  let P = w.nd.slice(0, -1).map((n) => nodes.get(n)); if (P.some((p) => !p)) continue;
  P = simplify(P); if (P.length < 3) continue;
  if (area(P) < 0) P.reverse();                       // counter-clockwise in (x, z) maths terms
  const A = area(P); if (A < 12) continue;
  const c = centroid(P);
  const core = inRect(c, CORE, -2), strip = !core && inRect(c, STRIP) && yanghwa.some((s) => lineD(c, s.points) < STRIP.reach);
  // [P2-C] and both sides of the R1-R2 Walking Street up to the station (phase 1 left them out: a void east of Hongik-ro)
  const walk = !core && !strip && inRect(c, EXT) && r1r2.some((s) => lineD(c, s.points) < WALK_REACH);
  if (!core && !strip && !walk) continue;
  { const Q = clearLanes(P, w.id); if (!Q) continue; P = Q; }
  // street: nearest by edge distance, a better class wins within 3 m
  let best = null;
  for (const s of streets) {
    const d = Math.min(...P.map((p) => lineD(p, s.points))) + KRANK[s.kind] * 1.0 - Math.min(s.width / 2, 6);
    if (!best || d < best.d) best = { s, d };
  }
  const st = best.s;
  // frontage: the edge whose midpoint is nearest the street, preferring long edges
  let fr = null;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 2) continue;
    const d = lineD([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], st.points) - Math.min(L, 12) * 0.25;
    if (!fr || d < fr.d) fr = { a, b, d };
  }
  if (!fr) continue;
  // storeys
  const r = hash(w.id);
  let floors = +(w.t['building:levels'] || 0), measured = floors > 0;
  if (!measured) {
    const base = A < 80 ? 2 : A < 160 ? 3 : A < 350 ? 4 : A < 900 ? 5 : A < 2000 ? 7 : 9;
    floors = base + Math.floor(r * 3) + (st.kind === 'main' ? 1 + Math.floor(r * 3) : 0);
  }
  floors = Math.max(1, Math.min(floors, 30));
  // use: POIs inside the footprint (the most common), else seeded
  const uses = {}; for (const q of poi) if (Math.abs(q.p[0] - c[0]) < 60 && Math.abs(q.p[1] - c[1]) < 60 && pip(q.p, P)) { const u = USE_OF(q.t); if (u) uses[u] = (uses[u] || 0) + 1; }
  let use = Object.entries(uses).sort((a, b) => b[1] - a[1])[0]?.[0];
  const poiCount = Object.values(uses).reduce((a, b) => a + b, 0);
  if (!use) use = draw(WEIGHTS[st.kind], hash(w.id + 'u'));
  if (w.t.building === 'hotel') use = 'hotel';
  lots.push({ id: 'L' + w.id, footprint: P.map(([x, z]) => [r2(x), r2(z)]), floors, floorH: floors >= 8 ? 3.6 : 3.3, street: st.id,
    frontage: [[r2(fr.a[0]), r2(fr.a[1])], [r2(fr.b[0]), r2(fr.b[1])]], use, ...(measured ? { levelsOSM: true } : {}), ...(poiCount ? { pois: poiCount } : {}), ...(w.t.name ? { osmName: w.t.name } : {}), ...(w.t['addr:street'] ? { addr: w.t['addr:street'] + ' ' + (w.t['addr:housenumber'] || '') } : {}), ...(strip ? { context: 'station-strip' } : {}) });
}

// ---- [P2-C] club streets are shared surfaces (no kerbs): the asphalt runs facade to facade. Phase 1 drew Wausan-ro
// 19-gil as a 3.25 m strip between pavers. Ribbon = the 25th percentile of facade-to-facade where both sides are built.
function facadeWidths(s) {
  const out = [];
  const hit = (px, pz, dx, dz) => { let best = Infinity; for (const l of lots) { const P = l.footprint; for (let i = 0; i < P.length; i++) { const [ax, az] = P[i], [bx, bz] = P[(i + 1) % P.length];
    const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex; if (Math.abs(den) < 1e-9) continue; const t = ((ax - px) * ez - (az - pz) * ex) / den, u = ((ax - px) * dz - (az - pz) * dx) / den; if (t > 0 && u >= 0 && u <= 1 && t < best) best = t; } } return best; };
  for (let i = 0; i < s.points.length - 1; i++) { const [ax, az] = s.points[i], [bx, bz] = s.points[i + 1], L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L;
    for (let d = 1; d < L; d += 2) { const l = hit(ax + tx * d, az + tz * d, -tz, tx), r = hit(ax + tx * d, az + tz * d, tz, -tx); if (l < 12 && r < 12) out.push(l + r); } }
  return out.sort((a, b) => a - b);
}
for (const s of streets) if (s.kind === 'club' || s.kind === 'walking') {
  const W = facadeWidths(s); if (W.length < 4) continue;
  const p25 = W[Math.floor(W.length * 0.25)], p50 = W[Math.floor(W.length * 0.5)];
  const w = s.kind === 'club' ? Math.min(9, Math.max(s.width, p25)) : Math.min(22, Math.max(s.width, p50));
  if (Math.abs(w - s.width) > 0.2) { s.widthOSM = s.width; s.width = r2(w); s.widthFrom = 'facades p' + (s.kind === 'club' ? 25 : 50); }
}

// ---- screens (reference.md section 2 and 5): the building-scale LED screens are all on the Yanghwa-ro frontage
// (OOH listings, by address); sizes listed for no. 151 (14 x 15.8 m, facing exit 9) and no. 165 (curved 16 x 14 m),
// the others ~12 x 10 m until measured. In the alleys: small LED message boards (~0.3 x 1-2 m) on ~1 in 5 shopfronts.
const screens = [];
const stById = new Map(streets.map((s) => [s.id, s]));
const frontInfo = (l) => { const [a, b] = l.frontage, L = Math.hypot(b[0] - a[0], b[1] - a[1]), tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
  return { a, b, L, tx, tz, nx: tz, nz: -tx, mx: (a[0] + b[0]) / 2, mz: (a[1] + b[1]) / 2 }; };
// the lot's edge that faces Yanghwa-ro best (longest edge whose outward normal points at the road within 40 m)
function yanghwaFace(l) {
  let best = null; const P = l.footprint;
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 6) continue;
    const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L, nx = tz, nz = -tx, mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const d0 = Math.min(...yanghwa.map((s) => lineD([mx, mz], s.points))), d1 = Math.min(...yanghwa.map((s) => lineD([mx + nx * 5, mz + nz * 5], s.points)));
    // [P2-C] it must face the road, not run along it (Y151 sat on its side-street wall, edge-on from SCREEN CANYON)
    const nq = yanghwa.map((s) => nearestOn([mx, mz], s.points)).sort((p, q) => p.d - q.d)[0], fx = (nq.q[0] - mx) / (nq.d || 1), fz = (nq.q[1] - mz) / (nq.d || 1), cos = nx * fx + nz * fz;
    if (d1 >= d0 || d0 > 40 || cos < 0.6) continue; const sc = L * cos - d0 * 0.5; if (!best || sc > best.sc) best = { a, b, L, tx, tz, nx, nz, mx, mz, sc }; }
  return best;
}
const OOH = [['151', 14, 15.8, 'exit 9'], ['165', 16, 14, 'curved, exit 2'], ['136', 12, 10], ['140', 12, 10], ['148', 12, 10], ['152', 12, 10], ['166', 12, 10], ['175', 12, 10], ['176', 12, 10]];
const unplaced = [];
for (const [no, w0, h0, note] of OOH) {
  const l = lots.find((q) => q.addr === '양화로 ' + no);
  if (!l) { unplaced.push(no); continue; }
  const f = yanghwaFace(l); if (!f) { unplaced.push(no + ' (no Yanghwa-ro face)'); continue; }
  // an unmapped building that carries a listed 15 m screen has at least the storeys to hold it (screen + 6 m)
  if (!l.levelsOSM && l.floors * l.floorH < h0 + 6) { l.floors = Math.ceil((h0 + 6) / l.floorH); l.floorsFrom = 'screen'; }
  const H = l.floors * l.floorH, w = Math.min(w0, f.L - 1), h = Math.min(h0, H - 5);
  screens.push({ id: 'Y' + no, lot: l.id, pos: [r2(f.mx + f.nx * 0.4), r2(Math.max(4 + h / 2, H - 1.5 - h / 2)), r2(f.mz + f.nz * 0.4)], normal: [r2(f.nx), 0, r2(f.nz)], w: r2(w), h: r2(h), kind: 'facade',
    src: `OOH listing Yanghwa-ro ${no}` + (note ? ` (${note})` : '') + (w0 === 12 ? ', size assumed' : '') });
}
if (unplaced.length) console.error('screens not placed (no OSM building with that address):', unplaced.join(', '));
for (const l of lots.filter((l) => ['walking', 'club', 'alley'].includes(stById.get(l.street).kind) && !l.context && hash(l.id + 's') < 0.2)) {
  const f = frontInfo(l); if (f.L < 3) continue;
  const w = Math.min(2.0, Math.max(1.0, f.L * 0.3));
  screens.push({ id: 'M' + l.id.slice(1), lot: l.id, pos: [r2(f.mx + f.nx * 0.36), r2(2.75), r2(f.mz + f.nz * 0.36)], normal: [r2(f.nx), 0, r2(f.nz)], w: r2(w), h: 0.3, kind: 'small', src: 'LED message board (census: ~1 in 5 shopfronts)' });
}

// ---- hero points and spawn
const pt = (ko, kind, near) => { const c = streets.filter((s) => s.ko === ko && (!kind || s.kind === kind)); let best = null;
  for (const s of c) for (const p of s.points) { const d = Math.hypot(p[0] - near[0], p[1] - near[1]); if (!best || d < best.d) best = { p, d }; } return best?.p || near; };
const walkMid = pt('어울마당로', 'walking', [-27, -14]);
const P3 = (p, y = 2) => [p[0], y, p[1]];
const hero = [   // reference.md section 2 (its frame: metres from 37.5540 N, 126.9230 E, y north; converted here)
  { id: 'walking-street', name: 'Eoulmadang-ro car-free street (Red Road R2-R4)', ko: '어울마당로', pos: P3(walkMid) },
  { id: 'hongik-junction', name: 'Hongik-ro x Eoulmadang-ro', ko: '홍익로', pos: P3(pt('홍익로', null, [-17, -124])) },
  { id: 'wausan21', name: 'Wausan-ro 21-gil bar and club alley', ko: '와우산로21길', pos: P3(pt('와우산로21길', null, [-77, 96])) },
  { id: 'clubstreet', name: 'Wausan-ro 19-gil club street', ko: '와우산로19길', pos: P3(pt('와우산로19길', null, [60, 140])) },
  { id: 'playground', name: 'Hongdae Playground (Hongik Culture Park)', ko: '홍대 놀이터', pos: [80, 2, 97] },
  { id: 'exit9', name: 'Hongik Univ. Station exit 9', ko: '홍대입구역 9번 출구', pos: [46, 2, -313] },
  { id: 'station-front', name: 'Yanghwa-ro LED-screen canyon', ko: '양화로', pos: P3(pt('양화로', null, [0, -300]), 8) },
];
const out = {
  version: 1, name: 'Hongdae', origin: ORIGIN, core: CORE, strip: STRIP,
  box: { x0: Math.min(CORE.x0, STRIP.x0), x1: Math.max(CORE.x1, STRIP.x1), z0: Math.min(CORE.z0, STRIP.z0), z1: Math.max(CORE.z1, STRIP.z1) },
  source: 'Footprints and street centrelines © OpenStreetMap contributors (ODbL 1.0), fetched 2026-11-08 via api.openstreetmap.org bbox 126.9170,37.5470..126.9280,37.5585. Storeys: building:levels where mapped, else estimated. Screens: placed by rule.',
  streets: streets.map(({ hw, ...s }) => s), lots, screens, hero,
  spawn: { pos: [walkMid[0], 7, walkMid[1]], yaw: 0 },
};
process.stdout.write(JSON.stringify(out));
console.error(`streets ${streets.length}, lots ${lots.length} (levels mapped ${lots.filter((l) => l.levelsOSM).length}, with POIs ${lots.filter((l) => l.pois).length}), screens ${screens.length}`);
console.error('clearances:', clearLog.length, 'lots trimmed;', clearLog.filter((x) => /dropped/.test(x)).join('; ') || 'none dropped');
console.error('ribbons:', streets.filter((s) => s.widthFrom).map((s) => `${s.id} ${s.ko} ${s.widthOSM}->${s.width}`).join(', '));
console.error('kinds', JSON.stringify(streets.reduce((m, s) => ((m[s.kind] = (m[s.kind] || 0) + 1), m), {})), 'uses', JSON.stringify(lots.reduce((m, s) => ((m[s.use] = (m[s.use] || 0) + 1), m), {})));
