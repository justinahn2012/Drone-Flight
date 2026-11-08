// Synthetic provisional layout (contract L1) so S2/S3/S4 can start before the real Hongdae survey lands.
// node seoul/tools/gen-provisional.mjs > seoul/layout.provisional.json
let s = 12345; const R = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
const streets = [
  { id: 'main', name: 'Main road (synthetic)', ko: '큰길', kind: 'main', width: 26, points: [[-120, 70], [120, 70]] },
  { id: 'walk', name: 'Walking street (synthetic)', ko: '걷고싶은거리', kind: 'walking', width: 10, points: [[-120, 0], [120, 0]] },
  { id: 'alleyA', name: 'Alley A (synthetic)', ko: '골목A', kind: 'alley', width: 4, points: [[-30, 57], [-30, -60]] },
  { id: 'alleyB', name: 'Club alley B (synthetic)', ko: '클럽골목', kind: 'club', width: 6, points: [[40, 57], [40, -60]] },
];
const uses = ['club', 'bar', 'pocha', 'restaurant', 'cafe', 'shop', 'conv', 'karaoke', 'pc', 'motel', 'office', 'hotel'];
const lots = [], screens = [];
// 3 rows of 10 lots: north of the walking street (z -5..-25), between walking and main (5..30 and 32..57)
const rows = [{ z0: -25, z1: -5, street: 'walk', fz: -5 }, { z0: 5, z1: 27, street: 'walk', fz: 5 }, { z0: 33, z1: 57, street: 'main', fz: 57 }];
let id = 0;
for (const r of rows) {
  let x = -110;
  const cap = lots.length + 10; while (x < 110 && lots.length < cap) {
    const w = 8 + Math.floor(R() * 10);
    let x0 = x, x1 = Math.min(x + w, 110); x = x1 + 0.4;
    // keep the alleys open
    if ((x0 < -28 && x1 > -32) || (x0 < 43 && x1 > 37)) continue;
    const floors = r.street === 'main' ? 6 + Math.floor(R() * 7) : 3 + Math.floor(R() * 4);
    const L = { id: 'L' + String(id++).padStart(3, '0'), footprint: [[x0, r.z0], [x1, r.z0], [x1, r.z1], [x0, r.z1]], floors, floorH: 3.2,
      street: r.street, frontage: [[x0, r.fz], [x1, r.fz]], use: uses[Math.floor(R() * uses.length)] };
    lots.push(L);
    if (r.street === 'main' && floors >= 8 && screens.length < 3) {
      screens.push({ id: 'S' + screens.length, lot: L.id, pos: [(x0 + x1) / 2, floors * 3.2 * 0.6, r.fz + 0.3], normal: [0, 0, 1], w: Math.min(12, x1 - x0 - 1), h: 7, kind: 'facade' });
    }
  }
  if (lots.length >= 30) break;
}
screens.push({ id: 'S_bill', lot: lots[lots.length - 1].id, pos: [lots[lots.length - 1].frontage[0][0] + 4, 30, 50], normal: [0, 0, 1], w: 10, h: 6, kind: 'billboard' });
const out = { version: 1, name: 'Hongdae (provisional synthetic)', provisional: true, origin: { lat: 37.5535, lon: 126.9235 },
  streets, lots, screens,
  hero: [{ id: 'walk-mid', name: 'Walking street middle', pos: [0, 2, 0] }, { id: 'club-alley', name: 'Club alley', pos: [40, 2, 20] }],
  spawn: { pos: [-80, 6, 0], yaw: -Math.PI / 2 } };
console.log(JSON.stringify(out, null, 1));
