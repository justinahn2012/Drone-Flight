// seoul-interiors.js — [P2-C] the interior atlas behind Hongdae's glass (stream C: buildings, owned with world-seoul.js).
// Pure CPU and deterministic (node, CI, native export): buildInteriorAtlas() paints 16 rooms + 16 posters into a 1024 x 1280
// RGBA8 atlas (sRGB colour, linear alpha), 4 columns x 5 rows of 256 px tiles. world-seoul.js samples it with interior
// mapping (a ray-box room behind each pane), so shopfronts and windows show depth and parallax instead of flat plates.
//
// Room tiles are painted in one-point perspective through the room box: a room point (X, Y, Z), X,Y in [-1, 1] across the
// opening, Z in [0, 1] from the glass to the back wall, lands on the tile at (X, Y) / (1 + Z) (the back wall fills the
// central half). The shader maps its ray-box hit with the same formula, so the walls, floor and ceiling parallax exactly.
// Alpha < 1 marks light sources (lamps, fridges, screens): the shader boosts them by 1 + (1 - a) * BOOST.
//
// Tiles (index = row * 4 + col; row 0 is v = 0):
//   shops   0 convenience store   1 cafe        2 pocha / restaurant   3 bar (dark, backlit bottles)
//           4 karaoke lobby       5 clothes     6 phone shop           7 PC-bang stair
//   windows 8 office panels       9 blinds*    10 curtain*            11 study / bookshelves
//          12 lamp room (home)   13 TV / monitors (blue)  14 common stair  15 frosted glass*      (* front layers, flat)
//   16-19   posters, 4 per tile (2 x 2): menu, promo, for-lease (임대) paper, club flyer
// Every room tile is normalised in the shader by TILE_MEAN (its mean linear luminance with the boost), so a pane's aEm
// is the mean luminance the camera sees through it (nits x NITS).
export const ATLAS = { cols: 4, rows: 5, tile: 256, width: 1024, height: 1280, boost: 6 };
export const ROOM = { conv: 0, cafe: 1, pocha: 2, bar: 3, karaoke: 4, clothes: 5, phone: 6, pcstair: 7, office: 8, blinds: 9, curtain: 10,
  study: 11, home: 12, tv: 13, stair: 14, frosted: 15 };
export const FRONT = { none: 0, blinds: 1, curtain: 2, frosted: 3, vinyl: 4, lease: 5, cafeCurtain: 6 };

const fract = (x) => x - Math.floor(x);
const hh = (a, b = 0, c = 0) => fract(Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const band = (x, a, b) => x >= a && x < b;
const toS = (v) => SRGB[Math.round(clamp(v) * 4095)];
// saturated product / poster colours (linear)
const PROD = [[0.75, 0.08, 0.06], [0.85, 0.55, 0.05], [0.08, 0.25, 0.7], [0.1, 0.5, 0.15], [0.85, 0.85, 0.82], [0.9, 0.3, 0.05], [0.6, 0.1, 0.45], [0.05, 0.05, 0.06], [0.2, 0.6, 0.75]];
const pick = (arr, u) => arr[Math.min(arr.length - 1, Math.floor(u * arr.length))];

const K0 = [0, 0, 0, 0];
const K1 = [1, 1, 1];
const K2 = [0.72, 0.73, 0.74];
const K3 = [0.4, 0.4, 0.4];
const K4 = [0.62, 0.62, 0.6];
const K5 = [0.05, 0.45, 0.25];
const K6 = [0.8, 0.8, 0.8];
const K7 = [0.12, 0.12, 0.13];
const K8 = [0.85, 0.85, 0.9];
const K9 = [0.6, 0.62, 0.66];
const K10 = [0.82, 0.82, 0.8];
const K11 = [0.85, 0.75, 0.2];
const K12 = [0.85, 0.85, 0.85];
const K13 = [0.3, 0.3, 0.3];
const K14 = [1, 0.8, 0.5];
const K15 = [0.16, 0.16, 0.16];
const K16 = [0.18, 0.1, 0.05];
const K17 = [0.34, 0.2, 0.1];
const K18 = [0.1, 0.06, 0.03];
const K19 = [0.24, 0.14, 0.07];
const K20 = [0.85, 0.82, 0.7];
const K21 = [0.04, 0.04, 0.04];
const K22 = [0.5, 0.5, 0.52];
const K23 = [0.42, 0.41, 0.4];
const K24 = [0.55, 0.47, 0.37];
const K25 = [0.08, 0.06, 0.04];
const K26 = [0.5, 0.3, 0.2];
const K27 = [0.2, 0.3, 0.35];
const K28 = [0.6, 0.55, 0.4];
const K29 = [0.15, 0.3, 0.12];
const K30 = [0.58, 0.5, 0.4];
const K31 = [1, 0.75, 0.4];
const K32 = [0.3, 0.24, 0.18];
const K33 = [0.45, 0.45, 0.48];
const K34 = [0.16, 0.13, 0.11];
const K35 = [0.12, 0.07, 0.04];
const K36 = [0.3, 0.18, 0.09];
const K37 = [0.9, 0.8, 0.25];
const K38 = [0.7, 0.05, 0.03];
const K39 = [0.08, 0.06, 0.05];
const K40 = [0.55, 0.45, 0.32];
const K41 = [1, 0.7, 0.4];
const K42 = [0.02, 0.02, 0.02];
const K43 = [0.05, 0.04, 0.035];
const K44 = [1, 0.6, 0.25];
const K45 = [0.7, 0.4, 0.08];
const K46 = [0.15, 0.4, 0.12];
const K47 = [0.75, 0.75, 0.7];
const K48 = [0.5, 0.15, 0.05];
const K49 = [0.25, 0.15, 0.06];
const K50 = [0.09, 0.05, 0.03];
const K51 = [0.08, 0.05, 0.035];
const K52 = [0.6, 0.3, 1];
const K53 = [0.08, 0.04, 0.1];
const K54 = [0.5, 0.35, 0.1];
const K55 = [0.22, 0.05, 0.12];
const K56 = [0.9, 0.2, 0.8];
const K57 = [0.2, 0.4, 1];
const K58 = [1, 0.6, 0.2];
const K59 = [0.32, 0.12, 0.08];
const K60 = [0.6, 0.45, 0.12];
const K61 = [0.25, 0.08, 0.32];
const K62 = [1, 0.95, 0.85];
const K63 = [0.1, 0.1, 0.1];
const K64 = [0.8, 0.8, 0.79];
const K65 = [0.3, 0.25, 0.2];
const K66 = [0.5, 0.42, 0.33];
const K67 = [0.06, 0.05, 0.05];
const K68 = [0.75, 0.55, 0.45];
const K69 = [0.2, 0.2, 0.2];
const K70 = [0.1, 0.1, 0.12];
const K71 = [0.75, 0.72, 0.65];
const K72 = [0.4, 0.3, 0.2];
const K73 = [0.2, 0.25, 0.4];
const K74 = [0.55, 0.1, 0.1];
const K75 = [0.5, 0.5, 0.5];
const K76 = [0.83, 0.83, 0.81];
const K77 = [0.95, 0.97, 1];
const K78 = [0.85, 0.85, 0.86];
const K79 = [0.7, 0.7, 0.72];
const K80 = [0.1, 0.3, 0.85];
const K81 = [0.85, 0.2, 0.25];
const K82 = [0.15, 0.45, 0.9];
const K83 = [0.95, 0.75, 0.2];
const K84 = [0.2, 0.2, 0.25];
const K85 = [0.88, 0.88, 0.88];
const K86 = [0.85, 1, 0.9];
const K87 = [0.35, 0.38, 0.36];
const K88 = [0.32, 0.3, 0.28];
const K89 = [0.6, 0.55, 0.2];
const K90 = [0.18, 0.18, 0.17];
const K91 = [0.1, 0.35, 0.95];
const K92 = [0.3, 0.33, 0.31];
const K93 = [0.6, 0.05, 0.1];
const K94 = [0.05, 0.2, 0.5];
const K95 = [0.85, 0.5, 0.05];
const K96 = [0.35, 0.39, 0.37];
const K97 = [0.68, 0.68, 0.68];
const K98 = [0.22, 0.24, 0.27];
const K99 = [0.05, 0.06, 0.09];
const K100 = [0.32, 0.34, 0.38];
const K101 = [0.45, 0.45, 0.42];
const K102 = [0.66, 0.66, 0.63];
const K103 = [1, 0.92, 0.8];
const K104 = [0.5, 0.5, 0.48];
const K105 = [0.3, 0.22, 0.14];
const K106 = [0.35, 0.25, 0.15];
const K107 = [0.1, 0.08, 0.06];
const K108 = [1, 0.85, 0.6];
const K109 = [0.6, 0.58, 0.52];
const K110 = [0.35, 0.32, 0.28];
const K111 = [0.25, 0.16, 0.09];
const K112 = [0.4, 0.27, 0.15];
const K113 = [1, 0.8, 0.55];
const K114 = [0.6, 0.5, 0.38];
const K115 = [0.85, 0.68, 0.45];
const K116 = [0.12, 0.08, 0.05];
const K117 = [0.38, 0.25, 0.15];
const K118 = [0.55, 0.48, 0.38];
const K119 = [0.6, 0.53, 0.42];
const K120 = [0.15, 0.3, 0.6];
const K121 = [0.7, 0.75, 0.85];
const K122 = [0.03, 0.035, 0.05];
const K123 = [0.18, 0.24, 0.38];
const K124 = [0.9, 1, 0.95];
const K125 = [0.5, 0.52, 0.5];
const K126 = [0.42, 0.42, 0.4];
const K127 = [0.28, 0.28, 0.27];
const K128 = [0.1, 0.9, 0.3];
const K129 = [0.15, 0.15, 0.15];
const K130 = [0.38, 0.45, 0.4];
const K131 = [0.6, 0.62, 0.58];
const K132 = [0.78, 0.75, 0.68, 0.94];
const K133 = [0.3, 0.3, 0.3, 0.2];
const K134 = [0.5, 0.5, 0.5, 1];
const K135 = [0.9, 0.9, 0.9];
const K136 = [0.75, 0.06, 0.04];
const K137 = [0.9, 0.7, 0.1];
const K138 = [0.06, 0.06, 0.06];
const K139 = [0.95, 0.92, 0.85];
const K140 = [0.15, 0.4, 0.08];
const K141 = [0.55, 0.12, 0.04];
const K142 = [0.85, 0.55, 0.2];
const K143 = [0.1, 0.05, 0.03];
const K144 = [0.95, 0.9, 0.8];
const K145 = [0.08, 0.07, 0.07];
const K146 = [0.75, 0.04, 0.03];
const K147 = [0.08, 0.08, 0.08];
const K148 = [0.92, 0.92, 0.88];
const K149 = [0.9, 0.1, 0.6];
const K150 = [0.1, 0.8, 0.9];
const K151 = [0.6, 0.2, 1];
const K152 = [0.03, 0.03, 0.04];
const PL0 = [K26, K27, K28];
const PL1 = [K45, K46, K47, K48];
const PL2 = [K56, K57, K58];
const PL3 = [K70, K71, K72, K73, K74];
const PL4 = [K81, K82, K83, K84];
const PL5 = [K93, K94, K95, K70];
const PL6 = [K136, K137, K138, K139];
const PL7 = [K149, K150, K151];
// one room sample: wall 0 back, 1 left, 2 right, 3 floor, 4 ceiling; X, Y in [-1, 1], Z in [0, 1]. Returns [r, g, b, emit 0..1]
const OUT = K0; let lightZ = 1;
const E = (c, e) => { OUT[0] = c[0]; OUT[1] = c[1]; OUT[2] = c[2]; OUT[3] = e; return OUT; };
const S = (c, k = 1) => { k *= lightZ; OUT[0] = c[0] * k; OUT[1] = c[1] * k; OUT[2] = c[2] * k; OUT[3] = 0; return OUT; };
const near3 = (X, a, b, c, r) => Math.abs(X - a) < r || Math.abs(X - b) < r || Math.abs(X - c) < r;
function room(v, wall, X, Y, Z) {
  lightZ = 1 - 0.35 * Z;                                             // falloff away from the window side lights
  switch (v) {
    case 0: { // convenience store: white ceiling with tube rows, tiled floor, product shelves, a fridge wall at the back
      if (wall === 4) { const row = near3(X, -0.55, 0, 0.55, 0.07) && fract(Z * 5) < 0.8; return row ? E(K1, 1) : S(K2); }
      if (wall === 3) { const g = fract(X * 3) < 0.04 || fract(Z * 7) < 0.05; return S(g ? K3 : K4); }
      if (wall === 0) {
        if (Y > 0.55) return S(band(Y, 0.62, 0.74) ? K5 : K6);
        const door = Math.floor((X + 1) * 3), dx = fract((X + 1) * 3);
        if (dx < 0.05 || dx > 0.95 || Y < -0.85) return S(K7);
        const shelf = fract((Y + 0.85) * 3.6); if (shelf < 0.08) return E(K8, 0.4);
        const b = Math.floor(dx * 7), c = pick(PROD, hh(door, b, Math.floor((Y + 1) * 3.6)));
        return E(fract(dx * 7) < 0.65 ? mix(c, K1, 0.25) : K9, 0.45);
      }
      if (Y > 0.35) return S(band(Y, 0.5, 0.62) ? K5 : K10);
      { const sh = fract((Y + 1) / 0.27); if (sh < 0.1) return S(sh < 0.04 ? K11 : K12);
        const c = pick(PROD, hh(wall, Math.floor((Y + 1) / 0.27), Math.floor(Z * 16))); return S(fract(Z * 16) < 0.85 ? c : K13, 0.9); }
    }
    case 1: { // cafe: warm, wood floor, exposed concrete ceiling, pendant bulbs, counter + menu board at the back
      if (wall === 4) { const p = Math.hypot(X + 0.45, (Z - 0.35) * 2) < 0.06 || Math.hypot(X - 0.45, (Z - 0.35) * 2) < 0.06 || Math.hypot(X, (Z - 0.75) * 2) < 0.05; return p ? E(K14, 1) : S(K15); }
      if (wall === 3) return S(fract(X * 5 + hh(Math.floor(Z * 9)) * 0.3) < 0.04 ? K16 : K17);
      if (wall === 0) {
        if (Y < -0.35) return S(fract(X * 8) < 0.03 ? K18 : K19);
        if (band(Y, 0.15, 0.7) && Math.abs(X) < 0.75) { const t = band(fract((Y - 0.15) * 9), 0.3, 0.55) && fract(X * 6) < 0.8 && hh(Math.floor(X * 6), Math.floor(Y * 9)) > 0.2; return E(t ? K20 : K21, t ? 0.15 : 0); }
        if (band(Y, -0.35, -0.05) && band(X, -0.55, -0.25)) return S(K22);
        return S(Y > 0 ? K23 : K24);
      }
      if (band(Y, -0.1, 0.35) && fract(Z * 4) < 0.6) { const fr = fract(Z * 4) < 0.05 || fract(Z * 4) > 0.55 || Y < -0.05 || Y > 0.3; return S(fr ? K25 : pick(PL0, hh(wall, Math.floor(Z * 4)))); }
      if (band(Y, -1, -0.6) && fract(Z * 3) < 0.4) return S(K29);   // planters
      return S(Y > 0.4 ? K23 : K30);
    }
    case 2: { // pocha / Korean restaurant: menu sheets papering the walls, bare bulbs, wood wainscot, steel tables
      if (wall === 4) { const b = Math.hypot(fract(X * 1.5 + 0.5) - 0.5, (fract(Z * 3) - 0.5) * 0.7) < 0.06; return b ? E(K31, 1) : S(K32); }
      if (wall === 3) { const t = Math.hypot(fract(X * 1.2 + 0.5) - 0.5, fract(Z * 2.2) - 0.5) < 0.22; return S(t ? K33 : K34); }
      if (Y < -0.45) return S(fract((wall ? Z : X) * 12) < 0.06 ? K35 : K36);
      const u = wall ? Z * 3 : X * 2.2, cu = Math.floor(u), cv = Math.floor((Y + 0.45) * 2.3), fu = fract(u), fv = fract((Y + 0.45) * 2.3);
      if (fu > 0.08 && fu < 0.92 && fv > 0.08 && fv < 0.92 && hh(cu, cv, wall) > 0.25) {
        const paper = hh(cu, cv, 9) < 0.5 ? K20 : K37;
        const line = fract(fv * 6) < 0.45 && band(fu, 0.15, 0.85) && fv < 0.85;
        return S(line ? (fv > 0.7 ? K38 : K39) : paper, 1.05);
      }
      return S(K40);
    }
    case 3: { // bar: dark wood, a backlit bottle wall, spots in a black ceiling
      if (wall === 4) return Math.hypot(fract(X * 2 + 0.5) - 0.5, fract(Z * 3) - 0.5) < 0.05 ? E(K41, 0.8) : S(K42);
      if (wall === 3) return S(K43);
      if (wall === 0 && Y > -0.4 && Y < 0.65) {
        const sh = fract((Y + 0.4) * 3.2); if (sh < 0.08) return E(K44, 0.9);           // LED strip under each shelf
        const b = fract(X * 14), bc = pick(PL1, hh(Math.floor(X * 14), Math.floor((Y + 0.4) * 3.2)));
        return b > 0.25 && b < 0.75 && sh < 0.75 ? E(bc, 0.55) : E(K49, 0.25);
      }
      if (wall === 0 && Y < -0.4) return S(K50);
      return S(fract(Z * 6) < 0.04 ? K42 : K51);
    }
    case 4: { // karaoke lobby: violet walls, gold trims, a corridor of room doors with lit portholes, LED cove lines
      if (wall === 4) { const l = Math.abs(Math.abs(X) - 0.8) < 0.025; return l ? E(K52, 1) : S(K53); }
      if (wall === 3) return S(hh(Math.floor(X * 10), Math.floor(Z * 14)) > 0.85 ? K54 : K55);
      { const u = wall ? Z * 3.5 : X * 1.6, fu = fract(u);
        if (band(fu, 0.2, 0.8) && Y < 0.35) { const win = Math.hypot((fu - 0.5) * 2.2, (Y - 0.05) * 1.5) < 0.17; return win ? E(pick(PL2, hh(Math.floor(u), wall)), 0.9) : S(K59); }
        if (fu < 0.04 || fu > 0.96) return S(K60);
        return S(K61); }
    }
    case 5: { // clothes shop: white box, racks on the side walls, a campaign poster at the back, track spots
      if (wall === 4) return Math.abs(X) < 0.03 ? (fract(Z * 5) < 0.2 ? E(K62, 1) : S(K63)) : S(K64);
      if (wall === 3) return S(fract(Z * 4 + X * 0.2) < 0.03 ? K65 : K66);
      if (wall === 0) { if (band(X, -0.45, 0.45) && band(Y, -0.3, 0.75)) { const fig = Math.hypot(X * 1.6, Y - 0.45) < 0.12 || (Math.abs(X) < 0.16 && band(Y, -0.3, 0.3)); return E(fig ? K67 : K68, 0.25); } return S(K10); }
      if (Math.abs(Y - 0.3) < 0.015) return S(K69);
      if (band(Y, -0.55, 0.3) && fract(Z * 26) < 0.8) return S(mix(pick(PL3, hh(Math.floor(Z * 26), wall)), K75, 0.1));
      return S(K76);
    }
    case 6: { // phone shop: very white, backlit promo walls, a blue brand band, square ceiling panels
      if (wall === 4) return (fract(X * 1.5 + 0.25) < 0.5 && fract(Z * 3) < 0.6) ? E(K77, 1) : S(K78);
      if (wall === 3) return S(K79);
      if (band(Y, 0.55, 0.75)) return E(K80, 0.4);
      { const u = wall ? Z * 2.2 : X * 1.4, fu = fract(u);
        if (band(fu, 0.1, 0.9) && band(Y, -0.35, 0.45)) { const c = pick(PL4, hh(Math.floor(u), wall)); const t = band(Y, -0.25, -0.12) && band(fu, 0.2, 0.7); return E(t ? K1 : c, 0.45); }
        return S(K85); }
    }
    case 7: { // PC-bang stair: treads climbing away, game posters, a green-white tube
      if (wall === 4) return Math.abs(X) < 0.05 && fract(Z * 2) < 0.7 ? E(K86, 1) : S(K87);
      if (wall === 3) { const t = fract(Z * 9); return S(t < 0.65 ? K88 : t < 0.72 ? K89 : K90); }
      if (wall === 0) { if (band(X, -0.6, 0.6) && band(Y, 0.1, 0.55)) return E(K91, 0.8); return S(K92); }
      if (Math.abs(Y - (-0.3 + Z * 0.6)) < 0.02) return S(K75);   // handrail
      { const u = Z * 3, fu = fract(u), fv = (Y + 0.1) * 1.8; if (band(fu, 0.12, 0.88) && band(fv, 0, 1)) { const c = pick(PL5, hh(Math.floor(u), wall)); return E(mix(c, K1, band(fv, 0.75, 0.85) ? 0.8 : 0), 0.3); } }
      return S(K96);
    }
    case 8: { // office: 2 x 2 panel grid, off-white walls, partitions and dark monitors, blue-grey carpet
      if (wall === 4) { const p = fract(X * 1.5 + 0.5) < 0.42 && fract(Z * 2.5) < 0.42; return p ? E(K77, 1) : S(fract(X * 3) < 0.03 || fract(Z * 5) < 0.03 ? K3 : K97); }
      if (wall === 3) return S(K98);
      if (Y < -0.42) { const u = wall ? Z * 4 : X * 2.5; const mon = band(fract(u), 0.3, 0.7) && Y > -0.6; return mon ? E(K99, 0.05) : S(K100); }
      if (wall === 0 && band(X, -0.9, -0.3) && Y < 0.4) return S(K101);   // cabinets
      return S(K102);
    }
    case 11: { // study: bookshelves, desk lamp, ceiling lamp off
      if (wall === 4) return Math.hypot(X, Z - 0.5) < 0.12 ? E(K103, 0.6) : S(K104);
      if (wall === 3) return S(K105);
      if (wall !== 0 && Y < 0.55) { const sh = fract((Y + 1) * 3); if (sh < 0.1) return S(K106); return S(fract(Z * 30) < 0.85 ? pick(PROD, hh(Math.floor(Z * 30), Math.floor((Y + 1) * 3), wall)) : K107, 0.7); }
      if (wall === 0 && Math.hypot(X - 0.4, Y + 0.25) < 0.08) return E(K108, 1);
      return S(K109);
    }
    case 12: { // home: warm wallpaper, a wardrobe, a floor-lamp glow at the back
      if (wall === 4) return S(K110);
      if (wall === 3) return S(fract(X * 4 + Z * 0.1) < 0.03 ? K111 : K112);
      if (wall === 0) { const d = Math.hypot(X + 0.55, Y - 0.1); if (d < 0.09) return E(K113, 1); return S(mix(K114, K115, clamp(1 - d * 1.2))); }
      if (wall === 1 && band(Z, 0.3, 0.75) && Y < 0.55) return S(fract(Z * 6) < 0.03 ? K116 : K117);
      return S(fract(Y * 8 + Z * 0.5) < 0.5 ? K118 : K119);
    }
    case 13: { // TV / monitors in a dark room: the screen is the light
      if (wall === 0 && band(X, -0.45, 0.45) && band(Y, -0.3, 0.25)) { const b = hh(Math.floor(X * 6), Math.floor(Y * 4)); return E(mix(K120, K121, b * 0.6), 0.9); }
      const d = wall === 0 ? Math.hypot(X, Y + 0.02) : 1.2 - Z * 0.8;
      return S(mix(K122, K123, clamp(1 - d * 0.9)));
    }
    case 14: { // common stair: grey-green concrete, treads, tube, a green exit sign
      if (wall === 4) return Math.abs(X - 0.1) < 0.05 && band(Z, 0.2, 0.6) ? E(K124, 1) : S(K125);
      if (wall === 3) { const t = fract(Z * 7); return S(t < 0.7 ? K126 : K127); }
      if (wall === 0 && band(X, 0.35, 0.65) && band(Y, 0.55, 0.72)) return E(K128, 1);
      if (wall !== 0 && Math.abs(Y - (-0.2 + Z * 0.7)) < 0.025) return S(K129);
      return S(Y < -0.3 ? K130 : K131);
    }
    default: return S(K75);
  }
}
// flat layers (no perspective): u, v in [0, 1]. Returns [r, g, b, coverage]
function flat(v, u, w) {
  switch (v) {
    case 9: { const s = fract(w * 22); return s < 0.82 ? K132 : K133; }       // blinds: slats
    case 10: { const f = 0.75 + 0.25 * Math.sin(u * 46 + Math.sin(u * 7) * 2) * (0.8 + 0.2 * Math.sin(w * 3)); return [f, f, f, 0.9]; }   // curtain folds (tinted in shader)
    case 15: { const b = 0.75 + 0.1 * Math.sin(u * 5 + 1) * Math.sin(w * 4) + 0.08 * Math.sin(u * 40) * 0.3; return [b, b, b * 1.02, 1]; } // frosted
    default: return K134;
  }
}
// posters 128 px in a 2 x 2 tile: menus, promos, 임대 (for lease), club flyers. Text is drawn as type bars.
function poster(p, u, v) {
  const k = p % 4, s = (a) => hh(p, a);
  const bars = (y0, y1, n, x0 = 0.12, x1 = 0.88) => { if (v < y0 || v > y1) return false; const f = fract((v - y0) / (y1 - y0) * n); const row = Math.floor((v - y0) / (y1 - y0) * n); return f < 0.55 && u > x0 && u < x0 + (x1 - x0) * (0.55 + 0.45 * hh(p, row)); };
  if (u < 0.03 || u > 0.97 || v < 0.02 || v > 0.98) return K135;
  if (k === 0) { // menu: colour header, a food photo, price lines
    const bg = pick(PL6, s(1));
    if (v > 0.8) return bars(0.83, 0.95, 1, 0.1, 0.9) ? K1 : mul(bg, 0.8);
    const d = Math.hypot(u - 0.5, (v - 0.55) * 1.2); if (d < 0.26) { const g = hh(Math.floor(u * 9), Math.floor(v * 9), p); return g > 0.8 ? K140 : mix(K141, K142, g); }
    return bars(0.08, 0.28, 3) ? (bg[0] + bg[1] > 1.2 ? K143 : K144) : bg;
  }
  if (k === 1) { // promo: gradient + figure + headline
    const c0 = pick(PROD, s(2)), c1 = pick(PROD, s(3)); const bg = mix(c0, c1, v);
    if (Math.hypot(u - 0.62, v - 0.62) < 0.12 || (Math.abs(u - 0.62) < 0.15 && band(v, 0.2, 0.52))) return K145;
    return bars(0.1, 0.3, 2, 0.1, 0.6) || bars(0.78, 0.92, 1) ? K1 : bg;
  }
  if (k === 2) { // for lease: white paper, big red characters, phone line
    if (bars(0.45, 0.85, 2, 0.12, 0.88)) return K146;
    return bars(0.15, 0.3, 2) ? K147 : K148;
  }
  const c = pick(PL7, s(4));    // club flyer: black, neon shapes
  if (Math.abs(Math.hypot(u - 0.5, v - 0.6) - 0.22) < 0.03) return c;
  return bars(0.1, 0.3, 3) ? mul(c, 0.9) : K152;
}

const LIN = Float32Array.from({ length: 256 }, (_, x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
const SRGB = Uint8Array.from({ length: 4096 }, (_, i) => { const v = i / 4095; return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255); });
let cached = null;
// -> { width, height, data: Uint8Array RGBA (sRGB rgb, linear a; row 0 = v 0), mean: Float32Array(20) linear luminance per tile }
export function buildInteriorAtlas() {
  if (cached) return cached;
  const { width: W, height: H, tile: T, boost } = ATLAS, data = new Uint8Array(W * H * 4), mean = new Float32Array(20);
  for (let t = 0; t < 20; t++) {
    const ox = (t % 4) * T, oy = Math.floor(t / 4) * T; let sum = 0;
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
      let c;
      if (t >= 16) { const p = (t - 16) * 4 + (j >= T / 2 ? 2 : 0) + (i >= T / 2 ? 1 : 0); const u = ((i % (T / 2)) + 0.5) / (T / 2), v = ((j % (T / 2)) + 0.5) / (T / 2); c = poster(p, u, v); }
      else if (t === 9 || t === 10 || t === 15) c = flat(t, (i + 0.5) / T, (j + 0.5) / T);
      else {
        const ix = ((i + 0.5) / T) * 2 - 1, iy = ((j + 0.5) / T) * 2 - 1, s = Math.max(Math.abs(ix), Math.abs(iy));
        let r;
        if (s <= 0.5) r = room(t, 0, ix / 0.5, iy / 0.5, 1);
        else { const z = Math.min(1, 1 / s - 1); r = Math.abs(ix) >= Math.abs(iy) ? room(t, ix < 0 ? 1 : 2, Math.sign(ix), iy / s, z) : room(t, iy < 0 ? 3 : 4, ix / s, Math.sign(iy), z); }
        c = r; c[3] = 1 - clamp(r[3]);
      }
      const k = ((oy + j) * W + ox + i) * 4;
      data[k] = toS(c[0]); data[k + 1] = toS(c[1]); data[k + 2] = toS(c[2]); data[k + 3] = t >= 16 ? 255 : Math.round(clamp(c[3]) * 255);
      const a = data[k + 3] / 255;
      sum += (0.2126 * LIN[data[k]] + 0.7152 * LIN[data[k + 1]] + 0.0722 * LIN[data[k + 2]]) * (t < 16 && t !== 9 && t !== 10 && t !== 15 ? 1 + (1 - a) * boost : 1);
    }
    mean[t] = sum / (T * T);
  }
  cached = { width: W, height: H, data, mean, ...ATLAS };
  return cached;
}
