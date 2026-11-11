// seoul-signs.js — Hongdae signs and LED video screens (contracts L1 / L2 / L3 in review/SEOUL-BUILD.md; phase 2 stream B).
//
//   import { seoulSigns } from './seoul-signs.js';
//   const signs = await seoulSigns.build(layout, { seed, neonPush, nitScale, renderer, quality });
//   scene.add(signs.group);  lights.attach(world, signs.emitters);  each frame: signs.update(t, camPos);
//   seoulSigns.exportData(layout, opts) -> { signs, screens }   (pure, node-safe: signs.json / screens.json for native)
//
// Phase 2 (panel 1: art #1, graphics #2, lighting #2, colour #2/#5, perf #6, native #2):
//   * The letters are the light, not the box. Every face is a list of elements: a box ground (light-box diffuser at
//     25-35 % of its letters, or a dark galva panel that only reflects), MSDF glyph runs (fill, neon tube on the outline,
//     exposed LED dots), bulb / LED borders and window film. Element kinds and their shading are listed in K below.
//   * Text is a multi-channel signed-distance glyph atlas (seoul/signs/msdf.png, 2048^2, 8 OFL faces at 36 px/em; made
//     by tools/seoul-msdf.py), laid out per sign at any size: sharp at 0.3 m, ~21 MB of GPU memory instead of the
//     4096^2 canvas atlas (89 MB + 64 MB canvas) that held 4,200 signs at 25 px/m. No Canvas2D is needed for signs.
//   * Luminance (cd/m^2) follows the panel's binding table: channel-letter / neon cores 600-2000, light-box letters
//     100-220 with a diffuser profile (centre +20 %, edges -30 %, LED rows at grazing angles), box ground 25-35 % of the
//     letters, window vinyl x0.3 of an 8-25 nit room, LED screens 180-350 with content whose mean is ~0.3 of peak.
// Phase 3 (panel 2: lighting #1/#2, colour #1, graphics #5, art #1):
//   * Filter model: coloured light is white light through a filter, rgb / max(rgb) x white-equivalent nits (85 % dye peak);
//     NITS is white-equivalent, so hue sets luminance. L3 records keep their contract (rgb Y = 1, nits = luminance), which
//     is now hue-aware. Hero mix warm-heavy with pink / cyan / violet as accents. Sign light budget R/G 1.4, B/G 0.95.
//   * Hot structure: channel / galva LED letters 1.0 at the stroke centre (0.04 em in) -> 0.45 at the edge; neon cos^2 across the tube
//     (core 3x the sleeve); bulbs 2 cm points (LEDs 1.2 cm) at 1800-2000 nits. Contract P3-B1: the scene target's alpha
//     is 1 + w on those cores (w in [0, 1]) and 1 elsewhere, so A's camera can white-core true sources only.
//   * Density: street-facing side walls of corner lots (as world-seoul finds them) get a wrapped fascia, a blade stack and
//     floor boxes; a floor box on ~80 % of lit 2F-5F tenants; main-road towers carry boxes to 8F and a lit roof crown;
//     hangul-only names on ~80 % of faces. Galva letters stand proud of their panel on returns; roof letters too.
//   * All faces draw with ONE MeshStandardMaterial (patched by seoul-light: haze + the city light grid on the unlit
//     parts), opaque, depth-writing, alpha-to-coverage edges; meshes are split into 80 m tiles so they frustum-cull.
//     The 120 LED screens are one instanced mesh (one draw) with per-instance program state.
//
// Emitter record (L3): { id, pos, normal, w, h, rgb (linear, luminance-normalised: Y = 1), nits (mean luminance over w*h; hue-aware),
//                        kind, flicker?, animated }. Animated records (screens, scrollers) are mutated in place by update().
import * as THREE from 'three';
import { Rng } from './rng.js';
import { MSDF } from './seoul/signs/msdf-meta.js';

export const NIT_SCALE = 0.01;
export const SIGNS_VERSION = 2;

// ---------------------------------------------------------------------------------------------------------------
// 1) colour: census vs shipped (T5 table), by category
// ---------------------------------------------------------------------------------------------------------------
export const COLOR_CATS = ['white', 'red', 'blue', 'ygo', 'pink', 'cyan', 'violet'];
export const CENSUS =  [0.45, 0.20, 0.15, 0.12, 0.04, 0.03, 0.01];
// Phase 3 (colour #1): the hero mix is the real Hongdae mix pushed toward warm (red, orange, amber, yellow) with pink, cyan
// and violet as accents, not a magenta field. Reference stills: 78 % of bright saturated pixels are warm, 4 % violet/magenta.
export const SHIPPED = [0.38, 0.12, 0.07, 0.24, 0.08, 0.07, 0.04];
export const NEON_SHARE = [0.04, 0.15];        // neon-tube share of nightlife-able signs at push 0 / 1
// default push by street kind; street.neonPush overrides. Phase 2 (colour #2): club/walking 1.0 -> 0.6, main 0.6 -> 0.4
export const PUSH_BY_KIND = { club: 0.6, walking: 0.6, main: 0.4, alley: 0.4 };
// how strongly a tenant takes the push: nightlife soaks it up, convenience stores keep chain colours
const USE_PUSH = { club: 1.35, bar: 1.3, pocha: 1.2, karaoke: 1.3, motel: 1.25, pc: 1.0, hotel: 0.8, cafe: 0.9, restaurant: 0.7,
  shop: 0.7, office: 0.4, conv: 0.0 };

const srgb = (h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };     // THREE.Color hex -> linear
const HEX = {
  white: '#f7f9ff', warm: '#fff2dc', black: '#0a0a0a', red: '#ff2414', blue: '#1e56ff', yellow: '#ffd21a', orange: '#ff7410', green: '#14d860',
  pink: '#ff3c9c', magenta: '#ff28d2', cyan: '#18e4ff', teal: '#10d8b0', violet: '#8a3cff', amber: '#ffa010',
  paleYellow: '#fff1b8', paleBlue: '#e2f2ff', bulb: '#ffc98a', roomWarm: '#ffd7a0', roomCool: '#e6efff', roomFluo: '#eaffef',
};
// category -> concrete light colours (weights)
// Phase 4 (colour #2): white light boxes read white (75 %), not khaki: warm white is #fff2dc on a quarter of them
const CAT_HUES = {
  white: [['white', 0.75], ['warm', 0.25]], red: [['red', 1]], blue: [['blue', 1]],
  ygo: [['yellow', 0.35], ['orange', 0.25], ['amber', 0.15], ['green', 0.25]], pink: [['pink', 0.6], ['magenta', 0.4]],
  cyan: [['cyan', 0.65], ['teal', 0.35]], violet: [['violet', 1]],
};
export const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const norm1 = (c) => { const y = Math.max(lum(c), 1e-4); return [c[0] / y, c[1] / y, c[2] / y]; };   // L3 records only
// Filter model (phase 3, lighting #1 / colour #1): a coloured sign is white light through a coloured filter (acrylic face,
// tinted tube, LED die at matched drive), so its emission is rgb / max(rgb) x the WHITE-EQUIVALENT nits of its class. Blue
// at 1000 white-equivalent has luminance 141 and B = 1000; the phase-2 luminance normalisation gave it B = 7070 (7.1x),
// which made the sign light budget magenta. Every nits value in NITS below is white-equivalent (the brightest channel).
// A dyed face or tinted tube passes ~85 % of its pass band (white diffusers ~100 %): peak transmission 1 - 0.15 x saturation.
export const filt = (c) => { const m = Math.max(c[0], c[1], c[2], 1e-4), k = (1 - 0.15 * (1 - Math.min(c[0], c[1], c[2]) / m)) / m; return [c[0] * k, c[1] * k, c[2] * k]; };

// Luminance, cd/m^2 (panel 1 binding table). Letters/cores are what clips; grounds and rooms sit well below them.
// Phase 3: white-equivalent (brightest channel, filter model); the hue sets the luminance. Cores are the stroke centre /
// tube axis / bulb point (the shader's profile peaks there; the mean over a letter is ~0.75 of the core).
export const NITS = {
  boxLetters: [110, 220], boxLettersColour: [100, 200],   // light-box letters: the brightest part of a box face (100-220)
  // Phase 4 (colour #3): a coloured light-box face is the letters' own diffuser behind a dyed film, so its dominant channel
  // runs at 75-90 % of the letters (phase 3's 25-35 % made muddy grounds: half Hongdae's saturated area)
  ground: [0.75, 0.9],                                     // lit coloured box face, white-equivalent share of the letters
  inverse: [250, 400],                                     // colour #2: white light-box face (it clips); film letters on it
  hot: 1.4,                                                // colour #3: red / orange / amber LED letters' drive
  channel: [700, 1400], channelColour: [600, 1100],        // LED channel letters / galva LED letters (cores; white modules drive hardest)
  neon: [900, 2000], bulb: [1800, 2000], dots: [800, 2000], // tube cores; 2 cm bulb points; exposed-LED letter dots
  scroller: [300, 600],                                    // LED dot board: mean of an "on" cell (dots peak at 2.6x)
  room: [8, 25], vinyl: 0.3,                               // window film: the lit room behind; vinyl transmits x0.3
  screen: [180, 350], screenSmall: [180, 300], banner: [0, 0],
};
// galva / painted panels behind LED letters (sRGB albedo; they only reflect)
const GALVA = ['#1a1a1c', '#26272a', '#101828', '#2e2219', '#102118', '#3a1212', '#5a5a5c', '#0c0c0e'];

// ---------------------------------------------------------------------------------------------------------------
// 2) invented names (real Korean; no brands). The font subsetter (tools/seoul-fonts.py) reads every hangul in this file.
// ---------------------------------------------------------------------------------------------------------------
const NAME_A = ['달빛', '별빛', '노을', '새벽', '청춘', '골목', '한잔', '우주', '고래', '여우', '토끼', '곰돌이', '은하', '파도', '바다',
  '소나무', '비밀', '오늘', '하루', '구름', '무지개', '다락', '마당', '정원', '온기', '불꽃', '번개', '낭만', '추억', '소풍', '첫눈',
  '동백', '레몬', '복숭아', '체리', '감귤', '꿀벌', '소금', '숯불', '화로', '철판', '가마솥', '할매', '이모네', '삼촌', '친구',
  '우리', '두근두근', '반짝', '몽글', '와우', '서교', '동교', '상수', '연남', '빛나는', '수상한', '즐거운', '따뜻한', '작은',
  '신난', '취한', '느린', '푸른', '붉은', '검은', '하얀', '노란', '보라', '고양이', '참새', '까치', '부엉이', '돌고래', '해녀',
  '장독대', '연탄', '골목길', '옥탑', '지하', '이층', '모퉁이', '언덕', '오후', '자정', '한밤', '열두시', '네온', '라디오'];
const NAME_EN = ['NOCTA', 'LUMEN', 'PULSE', 'DEEP ROOM', 'AFTER 4', 'NEON YARD', 'BASS LAB', 'MOONROOM', 'VELVET', 'OBLIQUE', 'HAZE',
  'STATIC', 'HALCYON', 'MIDNIGHT', 'ORBIT', 'SALT', 'EMBER', 'FERN', 'CORAL', 'TAPE', 'VINYL', 'SODA', 'KIWI', 'PLUM', 'MOSS',
  'NOVA', 'ECHO HALL', 'SLOW', 'WAVE', 'GRAIN', 'MONO', 'ROOM 7', 'B1 HOUSE', 'SIDE A', 'LOW KEY', 'NIGHTJAR'];
// category words by tenant use: [hangul, latin?]
const USE_WORDS = {
  club: ['클럽', '라운지', '하우스', '클럽', '라운지', 'CLUB'],
  bar: ['호프', '펍', '술집', '이자카야', '칵테일바', '와인바', '감성주점', '맥주집', 'BAR', 'PUB'],
  pocha: ['포차', '포장마차', '실내포차', '꼬치', '닭발', '오뎅바', '전집', '막걸리'],
  restaurant: ['삼겹살', '갈비', '곱창', '막창', '닭갈비', '족발', '보쌈', '국밥', '김밥', '분식', '떡볶이', '냉면', '칼국수', '마라탕',
    '라멘', '돈까스', '치킨', '횟집', '쌀국수', '부대찌개', '고기집', '숯불구이'],
  cafe: ['카페', '커피', '디저트', '베이커리', '브런치', '보드게임카페', '룸카페', '만화카페', '방탈출카페', '사주카페', '타로카페', 'CAFE', 'COFFEE', 'BAKERY'],
  shop: ['소품샵', '안경', '화장품', '휴대폰', '네일', '헤어', '미용실', '셀프사진관', '타투', '빈티지', '문구', '인형뽑기', '속눈썹', '코인빨래방', 'SHOP', 'STUDIO'],
  conv: ['편의점', '마트', '24시 편의점'],
  karaoke: ['코인노래방', '노래연습장', '노래방', '코인노래연습장'],
  pc: ['PC방', 'PC CAFE', '게임존', '오락실', '이스포츠', 'VR방'],
  motel: ['모텔', '무인텔', '모텔', '무인텔', 'HOTEL'],
  hotel: ['호텔', '게스트하우스', '호텔', '스테이', 'HOTEL'],
  office: ['학원', '부동산', '세무회계', '법무사', '치과', '의원', '약국', '연습실', '댄스학원', '실용음악학원', '스튜디오', '공방', '당구장', '스크린골프',
    '필라테스', '헬스장', '피부과', '한의원', '영어학원', '보컬학원'],
};
// upper-floor tenants (what sits above the ground-floor shop), by building use
const UPPER_USES = {
  club: ['bar', 'karaoke', 'pc', 'office'], bar: ['bar', 'karaoke', 'pocha', 'pc', 'office'], pocha: ['bar', 'karaoke', 'office'],
  restaurant: ['restaurant', 'bar', 'karaoke', 'pc', 'office', 'cafe'], cafe: ['cafe', 'office', 'shop', 'bar'],
  shop: ['office', 'cafe', 'shop', 'karaoke'], conv: ['pc', 'karaoke', 'office', 'restaurant'], karaoke: ['karaoke', 'pc', 'bar', 'office'],
  pc: ['pc', 'karaoke', 'office'], motel: ['motel'], hotel: ['hotel'], office: ['office', 'office', 'cafe', 'restaurant'],
};
// what sits next to a building's first shop on the ground floor
const GROUND_NEXT = {
  club: ['bar', 'pocha', 'conv', 'karaoke', 'restaurant'], bar: ['bar', 'pocha', 'restaurant', 'karaoke', 'cafe'], pocha: ['pocha', 'bar', 'restaurant'],
  restaurant: ['restaurant', 'restaurant', 'cafe', 'bar', 'shop', 'conv', 'pocha'], cafe: ['cafe', 'shop', 'restaurant', 'bar'], shop: ['shop', 'shop', 'cafe', 'restaurant'],
  conv: ['restaurant', 'cafe', 'shop'], karaoke: ['bar', 'pc', 'restaurant'], pc: ['restaurant', 'conv', 'cafe'],
};
const TAGS = ['24시', '영업중', 'OPEN', '단체석', '생맥주', '무한리필', '포장 가능', '심야영업', '새벽까지', '예약 환영', '주차 가능',
  '1인석', 'SINCE 2009', '본점', '2호점', '맛집', '신장개업', '연중무휴'];
const NEON_WORDS = ['술', '오늘 밤', '한잔 해', '취하고 싶은 밤', '사랑해', '청춘', 'OPEN', '포차', '노래', '짠', '낭만', '여기야', '어서와',
  'LOVE', '한잔', '오늘 밤 한잔'];
const BANNER_WORDS = ['신장개업 이벤트', '임대 문의', '전 메뉴 20% 할인', '점심 특선', '오픈 기념 1+1', '회원 모집', '수강생 모집',
  '분양 문의', '리모델링 오픈'];
export const SCROLL_TEXT = ['★ 오늘의 특가 생맥주 2500원 ★ 단체 환영 ★ 새벽 5시까지 영업 ★ ',
  '◆ 신메뉴 출시 ◆ 매운 닭발 + 주먹밥 세트 ◆ 포장 배달 가능 ◆ ', '♪ 코인노래방 1곡 500원 ♪ 신곡 매일 업데이트 ♪ 커플룸 완비 ♪ ',
  '■ 고사양 PC 최신 그래픽카드 ■ 심야 정액 할인 ■ 라면 · 음료 주문 가능 ■ ', '● 첫 방문 고객 음료 무료 ● 오픈 기념 이벤트 진행중 ● ',
  '▶ 금요일 밤 DJ 파티 ▶ 입장 무료 자정까지 ▶ 드레스코드 블랙 ▶ ', '※ 연중무휴 24시간 영업 ※ 카드 결제 가능 ※ '];
// LED screen text rows: invented products, artists, events. Row index = SCREEN_TEXT index.
export const SCREEN_TEXT = ['물빛 세럼', '촉촉함이 다르다', 'NEW SINGLE', '「밤의 정원」 달무리', '홍대 거리 버스킹 축제', 'D-3',
  '청량 한 잔', '레몬 스파클링', '신작 RPG 「별의 계승자」', '사전예약 진행중', '오늘 밤 서울 12°C 맑음', 'NEW SEASON',
  '가을 컬렉션 최대 30%', '안심 귀가 서비스', '마포구 · 밤길 안전', '번개배달', '30분 안에 문 앞까지', '0123456789:'];
// FIXED is a digit strip for the clock program; keep it last

// ---------------------------------------------------------------------------------------------------------------
// 3) small helpers
// ---------------------------------------------------------------------------------------------------------------
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const pick = (r, a) => a[Math.floor(r.next() * a.length) % a.length];
const range = (r, a, b) => a + (b - a) * r.next();
function pickW(u, pairs) { let s = 0; for (const [, w] of pairs) s += w; let x = u * s; for (const p of pairs) { x -= p[1]; if (x <= 0) return p[0]; } return pairs[pairs.length - 1][0]; }
export function mixDist(push) { return CENSUS.map((c, i) => c + (SHIPPED[i] - c) * push); }
function invCdf(u, dist) { let x = u; for (let i = 0; i < dist.length; i++) { x -= dist[i]; if (x <= 0) return i; } return dist.length - 1; }
const lerp = (a, b, k) => a + (b - a) * k;

// lit share at ~midnight by tenant use (T5 census: 20-30 % of signs unlit; Hongdae nightlife keeps its own lit)
const LIT_P = { club: 0.97, bar: 0.95, pocha: 0.95, karaoke: 0.96, pc: 0.95, motel: 0.97, hotel: 0.9, conv: 1.0, restaurant: 0.75,
  cafe: 0.6, shop: 0.45, office: 0.15 };
const NIGHT_USES = new Set(['club', 'bar', 'pocha', 'karaoke', 'motel']);
const BOX_STYLES = new Set(['fascia', 'blade', 'stand', 'round']);

// ---------------------------------------------------------------------------------------------------------------
// 4) the generator: layout -> sign specs (pure data; node-testable). A spec is one physical sign.
//    spec: { id, type, style, design, lot, use, lit, cat, hue, rgb, nits (letter / core luminance), groundK, bulbs, geo, ... }
// ---------------------------------------------------------------------------------------------------------------
function facadeFrame(lot) {
  const fp = lot.footprint; let cx = 0, cz = 0; for (const p of fp) { cx += p[0]; cz += p[1]; } cx /= fp.length; cz /= fp.length;
  const fr = lot.frontage || [fp[0], fp[1]];
  let [a, b] = fr; const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
  let tx = b[0] - a[0], tz = b[1] - a[1]; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
  let nx = -tz, nz = tx; if (nx * (mx - cx) + nz * (mz - cz) < 0) { nx = -nx; nz = -nz; }
  // reading direction r = up x n = (nz, 0, -nx); start at the end the reader sees on the left
  const rx = nz, rz = -nx; if (tx * rx + tz * rz < 0) { [a, b] = [b, a]; }
  return { o: [a[0], a[1]], r: [rx, rz], n: [nx, nz], L, top: lot.floors * (lot.floorH || 3.2), floors: lot.floors, fh: lot.floorH || 3.2 };
}

// street-facing side walls (art #1): a corner lot's second street face, found as world-seoul finds it (open 1.5 m out, not
// a slot under 3.2 m, a street within 1 m of a point 2 m out), from the layout alone so node and the browser agree.
const segDist = (px, pz, ax, az, bx, bz) => { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)); return Math.hypot(px - ax - dx * t, pz - az - dz * t); };
function inPoly(P, x, z) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
export function sideFaces(layout) {
  const lots = layout.lots || [], streets = layout.streets || [], CELL = 16, G = new Map(), out = new Map();
  lots.forEach((l, i) => { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const p of l.footprint) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++) { const k = gx + ',' + gz; (G.get(k) || G.set(k, []).get(k)).push(i); } });
  const inside = (x, z, self) => { for (const i of G.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL)) || []) if (lots[i] !== self && inPoly(lots[i].footprint, x, z)) return true; return false; };
  const streetD = (x, z) => { let d = Infinity; for (const s of streets) for (let i = 0; i < s.points.length - 1; i++) d = Math.min(d, segDist(x, z, s.points[i][0], s.points[i][1], s.points[i + 1][0], s.points[i + 1][1]) - s.width / 2); return d; };
  for (const l of lots) {
    const P = l.footprint, fr = l.frontage; if (!fr || !P || P.length < 3) continue; const list = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz); if (L < 3) continue;
      const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05;
      if ((same(a, fr[0]) && same(b, fr[1])) || (same(a, fr[1]) && same(b, fr[0]))) continue;
      let nx = dz / L, nz = -dx / L; const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      if (inPoly(P, mx + nx * 0.3, mz + nz * 0.3)) { nx = -nx; nz = -nz; }
      const at = (t, o) => [a[0] + dx * t + nx * o, a[1] + dz * t + nz * o];
      const open = [0.25, 0.5, 0.75].filter((t) => { const q = at(t, 1.5); return !inside(q[0], q[1], l) && !inPoly(P, q[0], q[1]); }).length >= 2;
      if (!open) continue;
      if ([0.25, 0.5, 0.75].filter((t) => { const q = at(t, 3.2); return inside(q[0], q[1], l); }).length >= 2) continue;   // a slot
      if (streetD(mx + nx * 2, mz + nz * 2) >= 1.0) continue;
      // frame as facadeFrame: reading direction r = up x n; o = the end the reader sees on the left; corner = the end nearer the frontage
      const rx = nz, rz = -nx; const [o, e] = dx * rx + dz * rz >= 0 ? [a, b] : [b, a];
      const fd = (p) => segDist(p[0], p[1], fr[0][0], fr[0][1], fr[1][0], fr[1][1]);
      list.push({ o: [o[0], o[1]], r: [rx, rz], n: [nx, nz], L, corner: fd(o) <= fd(e) ? 0 : L, top: l.floors * (l.floorH || 3.2), floors: l.floors, fh: l.floorH || 3.2, side: true });
    }
    if (list.length) out.set(l.id, list);
  }
  return out;
}

function makeName(r, use, latinBias) {
  const w = pick(r, USE_WORDS[use] || USE_WORDS.shop); const latinWord = /^[A-Z0-9 ]+$/.test(w);
  const latin = latinWord || r.next() < latinBias;
  if (latin) { const n = pick(r, NAME_EN); return { main: latinWord ? `${n} ${w}` : n, sub: latinWord ? '' : w, cat: w }; }
  const a = pick(r, NAME_A);
  const form = r.next();
  if (form < 0.45) return { main: a + w.replace(/ /g, ''), sub: '', cat: w };       // 달빛포차
  if (form < 0.8) return { main: a, sub: w, cat: w };                                 // 달빛 / 포차 (category set smaller)
  return { main: `${a} ${w}`, sub: '', cat: w };
}
const fakePhone = (r) => `02-0${Math.floor(r.next() * 90 + 10)}-${String(Math.floor(r.next() * 9000 + 1000))}`; // 02-0xx: no real exchange

// colour for one sign: u (census draw) and the push of its street/use; returns { cat, hue, rgb }
function signColour(uCat, uHue, push, use) {
  const p = Math.min(1, push * (USE_PUSH[use] ?? 0.8));
  const cat = COLOR_CATS[invCdf(uCat, mixDist(p))];
  const hue = pickW(uHue, CAT_HUES[cat]);
  return { cat, hue, rgb: srgb(HEX[hue]) };
}

// face design per sign (how the light is made). Real Hongdae: LED letters on galva panels and dark-ground flex boxes
// have replaced many white flex boxes, but the white light box with red / blue / black letters is still the commonest
// single sign, and red, amber, blue and green boxes glow as a whole face. Phase 4 (colour #2 / #3, art #1):
//   inverse   white (or warm-white) diffuser face at 250-400 nits, letters in red / blue / black film: 40 % of white boxes
//   flex      a coloured face (red, orange, amber, yellow, blue, green) lit as a whole, clear letters (yellow: dark film
//             letters); the face is the same diffuser behind a dye, so its dominant channel runs at 75-90 % of the letters
//   blackflex black face, coloured letters; galva: dark panel, LED letters; dots: exposed LEDs in letter bodies
export const GROUND_HUES = new Set(['red', 'orange', 'amber', 'yellow', 'blue', 'green']);
function chooseDesign(style, cat, hue, use, u, u2) {
  if (style === 'neon') return 'neon';
  if (style === 'channel' || style === 'roof') return 'channel';
  if (style === 'window') return u < 0.55 ? 'vinylA' : 'vinylB';
  if (style === 'vinyl') return 'film';
  if (style === 'banner' || style === 'scroller') return style;
  if ((style === 'fascia' || style === 'blade') && (use === 'pocha' || use === 'karaoke' || use === 'bar' || use === 'pc') && u < 0.2) return 'dots';
  if (use === 'conv') return 'flex';
  if (cat === 'white') return u2 < 0.4 ? 'inverse' : u2 < 0.75 ? 'galva' : 'blackflex';
  if (GROUND_HUES.has(hue)) return u2 < 0.7 ? 'flex' : 'galva';
  return u2 < 0.5 ? 'blackflex' : 'galva';          // pink, magenta, cyan, teal, violet: coloured letters on a dark face
}
// red and amber LED letters run at 1.4x drive (colour #3): R clips and the core shows an orange rim, as on camera
const HOT_HUES = new Set(['red', 'orange', 'amber']);
function designNits(design, cat, u, hue) {
  const R = design === 'neon' ? NITS.neon : design === 'channel' || design === 'galva' ? (cat === 'white' ? NITS.channel : NITS.channelColour)
    : design === 'dots' ? NITS.dots : design === 'vinylA' || design === 'vinylB' || design === 'film' ? NITS.room : design === 'scroller' ? NITS.scroller
      : design === 'banner' ? NITS.banner : design === 'inverse' ? NITS.inverse : (cat === 'white' ? NITS.boxLetters : NITS.boxLettersColour);
  const v = R[0] + (R[1] - R[0]) * u;
  return (design === 'channel' || design === 'galva') && HOT_HUES.has(hue) ? v * NITS.hot : v;
}

// ---------------------------------------------------------------------------------------------------------------
// 4b) C's sign slots (phase 4, art #1). world-seoul's lotInfo (contract P3-C, passed as ctx.lotInfo) says where each
//     building has room for signs; phase 3 placed signs from the layout alone and hung some over blank walls and shutter
//     housings (club90's "와도 반와가뻬" was 화로 만화카페 at 2.2-3.2 m with its top behind a closed shop's housing box).
//   fascias[]  { c (centre of the sign bed's front face), normal, w (= the wall), h (1.1), side, lit (false: shuttered) }:
//              the bed is y 2.9-4.0, 8 cm proud; a shuttered bay's housing box is y 2.9-3.2, 4-34 cm proud
//   bands[]    { f, c (2 cm off the wall), normal, w (= 0.9 of the wall), h, side }: the spandrel over floor f's windows
//   windows[]  { f, c (the pane, 3 cm out), n, w, h, lit, nits } on fronts and street-facing side walls
//   roofSign   { c (1 cm before C's backing panel), normal, w, h }: the steel frame on ~30 % of 4F-9F commercial roofs
//   floors[f]  { lit, use }: C's whole-floor tenants (bar karaoke cafe pc office home study restaurant motel hotel)
// Without lotInfo (a bare layout: old tools), the same slots are synthesised from the layout as phase 3 placed them.
// ---------------------------------------------------------------------------------------------------------------
export const SLOT = { bedOut: 0.08, shutterTop: 3.2, vinylOut: 0.045 };
// a sign frame on a slot: the wall line is `off` behind the slot's centre; reading direction r = up x n
function slotFrame(c, normal, L, off, base, side) {
  const l = Math.hypot(normal[0], normal[2]) || 1, n = [normal[0] / l, normal[2] / l], r = [n[1], -n[0]];
  const mx = c[0] - n[0] * off, mz = c[2] - n[1] * off;
  return { o: [mx - r[0] * L / 2, mz - r[1] * L / 2], r, n, L, top: base.top, floors: base.floors, fh: base.fh, side: !!side };
}
function synthSlots(lot, F, sides, st) {
  const at = (Fr, y, d, x) => ({ c: [Fr.o[0] + Fr.r[0] * Fr.L / 2 + Fr.n[0] * d, y, Fr.o[1] + Fr.r[1] * Fr.L / 2 + Fr.n[1] * d], normal: [Fr.n[0], 0, Fr.n[1]], ...x });
  const fascias = [at(F, 3.45, SLOT.bedOut, { w: F.L, h: 1.1, side: false, lit: true })];
  if (st.kind !== 'alley') for (const SF of sides) if (SF.L > 3.2) fascias.push(at(SF, 3.45, SLOT.bedOut, { w: SF.L, h: 1.1, side: true, lit: true }));
  const bands = [];
  for (const Fr of [F, ...sides]) for (let f = 1; f < Math.min(lot.floors - 1, 7); f++) bands.push(at(Fr, (f + 1) * F.fh - 0.6, 0.02, { f, w: Fr.L * 0.9, h: 1.2, side: Fr !== F }));
  return { fascias, bands, windows: [], roofSign: null, floors: [], synth: true };
}
const CUSE = { home: null, study: 'office' };       // C's floor use -> the sign tenant (null: flats carry no business sign)
const SINGLE = new Set(['hotel', 'motel', 'office']);
const CH_P = { cafe: 0.55, club: 0.5, shop: 0.4, hotel: 0.7, restaurant: 0.45, bar: 0.45, pocha: 0.45 };
const SCROLL_P = { bar: 0.5, pocha: 0.6, restaurant: 0.4, pc: 0.6, karaoke: 0.6, conv: 0.1 };
const STAND_P = { cafe: 0.6, bar: 0.75, pocha: 0.75, restaurant: 0.75, karaoke: 0.8, pc: 0.6, shop: 0.45, club: 0.5, conv: 0.3 };
// window lettering (시트지) on lit 2F-5F glass: what each trade puts on its windows
const VINYL_P = { karaoke: 0.85, pc: 0.8, office: 0.7, bar: 0.55, cafe: 0.5, restaurant: 0.45, shop: 0.55, club: 0.4, pocha: 0.5 };

export function generateSigns(layout, opts = {}) {
  const seed = (opts.seed ?? 0x5e0a1) >>> 0, pushOverride = opts.neonPush, pushScale = opts.neonPushScale ?? 1;
  const LI = opts.lotInfo || opts.world?.lotInfo || null;
  const streets = new Map((layout.streets || []).map((s) => [s.id, s]));
  const specs = [], screens = [], SIDES = sideFaces(layout);
  const shut = new Set();   // lots whose front bed is shuttered (no door screen)
  for (const lot of layout.lots || []) {
    const st = streets.get(lot.street) || { kind: 'alley' };
    const sides = SIDES.get(lot.id) || [];
    const push = Math.max(0, Math.min(1, (pushOverride ?? st.neonPush ?? PUSH_BY_KIND[st.kind] ?? 0.4) * pushScale));
    const r = new Rng(seed ^ hashStr(lot.id));           // geometry stream (never depends on push)
    const rc = new Rng((seed * 31 + 7) ^ hashStr(lot.id + '#c')); // colour stream (fixed draws per sign)
    const F = facadeFrame(lot);
    const nFloors = Math.max(1, lot.floors | 0), fh = F.fh, base = { top: F.top, floors: F.floors, fh };
    const info = LI && typeof LI.get === 'function' ? LI.get(lot.id) : null;
    const S = info ? { fascias: info.fascias || (info.fascia ? [info.fascia] : []), bands: info.bands || [], windows: info.windows || [], roofSign: info.roofSign || null, floors: info.floors || [] }
      : synthSlots(lot, F, sides, st);
    // tenants per floor: 0 = ground (lot.use; a basement club stays in the ground sign). Upper floors follow C's whole-floor
    // tenants when given: a flat carries no sign; a lit floor's sign is on (97 %), a dark floor's as often as its trade
    // keeps late hours (x 0.8: signs run on timers, rooms face the back)
    const tenants = [];
    for (let f = 0; f < nFloors; f++) {
      const cf = f > 0 ? S.floors[f] : null, cu = cf ? (cf.use in CUSE ? CUSE[cf.use] : cf.use) : undefined;
      if (cu === null) { tenants.push({ f, use: 'home', home: true, lit: false, name: { main: '', sub: '', cat: '' }, phone: '', tag: '' }); continue; }
      const use = f === 0 ? lot.use : cu !== undefined ? cu : pick(r, UPPER_USES[lot.use] || UPPER_USES.office);
      const name = makeName(r, use, use === 'club' ? 0.3 : use === 'cafe' ? 0.15 : use === 'shop' ? 0.15 : 0.05);
      const u = r.next(), lp = LIT_P[use] ?? 0.5;
      tenants.push({ f, use, name, lit: cf ? (cf.lit ? u < 0.97 : u < lp * 0.8) : u < lp, phone: fakePhone(r), tag: pick(r, TAGS) });
    }
    if (lot.use === 'hotel' || lot.use === 'motel') for (const t of tenants) { t.use = lot.use; t.name = tenants[0].name; t.lit = tenants[0].lit; t.home = false; }
    const biz = (f) => { for (let k = Math.min(f, nFloors - 1); k >= 0; k--) if (!tenants[k].home) return tenants[k]; return tenants[0]; };
    let k = 0;
    const add = (type, t, geo, extra = {}) => {
      // fixed colour draws per sign, whatever the push, so geometry/count/lit never move with push
      const uCat = rc.next(), uHue = rc.next(), uNeon = rc.next(), uNit = rc.next(), uFlk = rc.next(), uAcc = rc.next();
      const uDes = rc.next(), uBulb = rc.next(), uGr = rc.next(), uLet = rc.next(), uDes2 = rc.next(), uFilm = rc.next();
      const c = signColour(uCat, uHue, push, t.use);
      const nightlife = NIGHT_USES.has(t.use) || t.use === 'restaurant' && lot.use === 'pocha';
      const pn = Math.min(1, push * (USE_PUSH[t.use] ?? 0.8));
      let style = type;
      // neon-tube share (T5: <5 % census -> 15 % hero) re-skins small nightlife faces as tube lettering on a black board
      if (nightlife && (type === 'fascia' || type === 'round' || type === 'window') && !geo.roofBox && uNeon < (NEON_SHARE[0] + (NEON_SHARE[1] - NEON_SHARE[0]) * pn) * 3.4) style = 'neon';
      const acc = pickW(uAcc, [['white', 0.5], ['red', 0.2], ['blue', 0.15], ['yellow', 0.15]]);
      const design = chooseDesign(style, c.cat, c.hue, t.use, uDes, uDes2);
      const nits = designNits(design, c.cat, uNit, c.hue);
      // ~3 % of lit tubes/boxes are failing: irregular flicker (seoul-light can light it; the face flickers in-shader)
      const flicker = t.lit && (style === 'neon' ? uFlk < 0.08 : uFlk < 0.02) ? { hz: 6 + uFlk * 60, depth: 0.7 } : null;
      // bulb / LED borders on ~30 % of nightlife boxes (art #1)
      const bulbs = BOX_STYLES.has(style) && (nightlife || t.use === 'pc') && design !== 'dots' && uBulb < 0.3
        ? (uBulb < 0.11 ? 'chase' : uBulb < 0.19 ? 'bulbs' : 'led') : null;
      const letter = pickW(uLet, [['white', 0.58], ['paleYellow', 0.24], ['paleBlue', 0.18]]);
      // film letters (inverse boxes, yellow faces): red, blue or black vinyl over the diffuser
      const film = pickW(uFilm, c.hue === 'yellow' ? [['red', 0.35], ['black', 0.65]] : [['red', 0.45], ['blue', 0.3], ['black', 0.25]]);
      specs.push({ id: `${lot.id}:${type}${k++}`, type, style, design, lot: lot.id, street: lot.street, use: t.use, floor: t.f, lit: t.lit,
        cat: c.cat, hue: c.hue, rgb: c.rgb, accent: srgb(HEX[acc]), accentName: acc, letter, film, nits, groundK: lerp(NITS.ground[0], NITS.ground[1], uGr),
        bulbs, galva: GALVA[Math.floor(uGr * GALVA.length) % GALVA.length], flicker, name: t.name, phone: t.phone, tag: t.tag, frame: F, geo,
        push, seed: r.next() * 1e9 >>> 0, ...extra });
    };
    const g = tenants[0];
    const L = F.L;
    // --- ground floor: every sign bed C built (fronts, and corner shops' second frontage) holds 1-4 shop bays (Hongdae:
    //     4-8 m each), each with its sign on the bed. A shuttered bay keeps its sign (mostly dark) above the housing box ---
    let fasciaY = 3.0;
    for (const bed of S.fascias) {
      const BF = slotFrame(bed.c, bed.normal, bed.w, SLOT.bedOut, base, bed.side), Lb = BF.L, xf = { frame: BF }, open = bed.lit !== false;
      if (!open && !bed.side) shut.add(lot.id);
      const by0 = bed.c[1] - bed.h / 2, by1 = bed.c[1] + bed.h / 2;
      const nShops = SINGLE.has(lot.use) ? 1 : Math.max(1, Math.min(4, Math.round(Lb / 6.5))), bay = Lb / nShops;
      for (let i = 0; i < nShops; i++) {
        let sh = g;
        if (i > 0) { const use = pick(r, GROUND_NEXT[lot.use] || GROUND_NEXT.restaurant);
          sh = { f: 0, use, name: makeName(r, use, use === 'club' ? 0.3 : use === 'cafe' ? 0.15 : use === 'shop' ? 0.15 : 0.05), lit: r.next() < (LIT_P[use] ?? 0.5), phone: fakePhone(r), tag: pick(r, TAGS) }; }
        const on = r.next(), shop = sh.lit && !open && on >= 0.15 ? { ...sh, lit: false } : sh;
        const u0 = bay * i;
        // art #1: the sign fills the bed (60-95 % of the bay; the bed is the slot the building gives it)
        const lo = open ? by0 + 0.05 : Math.max(by0 + 0.05, SLOT.shutterTop + 0.04), hi = by1 - 0.04;
        const w = Math.max(1.0, Math.min(bay - 0.4, bay * range(r, 0.62, 0.95))), h = Math.min(hi - lo, range(r, 0.8, 1.02)), y = lo + (hi - lo - h) / 2;
        if (i === 0 && !bed.side) fasciaY = y;
        const channel = r.next() < (CH_P[sh.use] ?? 0.25);
        add(channel ? 'channel' : 'fascia', shop, { u: u0 + (bay - w) / 2, y, w, h, d: channel ? 0.12 : range(r, 0.2, 0.3), z0: SLOT.bedOut - 0.02, bay }, xf);
        if (!open) continue;
        // LED dot scroller on the glass under the bed (bars, pocha, pc, karaoke, restaurants)
        if (r.next() < (SCROLL_P[sh.use] ?? 0.12)) {
          const sw = Math.min(bay * 0.6, range(r, 1.6, 3.2));
          add('scroller', shop, { u: u0 + range(r, 0.3, Math.max(0.35, bay - sw - 0.3)), y: 2.46, w: sw, h: 0.26, d: 0.06 }, { ...xf, scrollRow: Math.floor(r.next() * SCROLL_TEXT.length) });
        }
        // sidewalk standing sign (입간판): ~0.6 per open shop
        if (r.next() < (STAND_P[sh.use] ?? 0.25)) add('stand', shop, { u: u0 + range(r, 0.6, Math.max(0.7, bay - 0.6)), y: 0.15, w: 0.55, h: range(r, 1.1, 1.5), d: 0.55, out: range(r, 0.8, 1.4) }, xf);
        // neon in the shop window (bars, pocha, clubs)
        if (NIGHT_USES.has(sh.use) && r.next() < 0.5) add('neon', shop, { u: u0 + range(r, 0.4, Math.max(0.5, bay - 2.2)), y: 1.0, w: range(r, 1.2, 1.8), h: range(r, 0.5, 0.8), d: 0.05 }, { ...xf, neonText: pick(r, NEON_WORDS) });
      }
    }
    // --- upper floors (signs stop around 6-7F; main-road towers 8F): a floor box on the spandrel over each tenant's windows
    //     (C's bands, trimmed to the real window heads and sills), on ~88 % of lit 2F-7F tenants and ~35 % of dark ones ---
    const tower = st.kind === 'main' && nFloors >= 8;
    const signTop = tower ? 8 : Math.min(nFloors, 7);
    const wallWins = (n, c) => S.windows.filter((w) => w.n[0] * n[0] + w.n[2] * n[2] > 0.995 && Math.abs((w.c[0] - c[0]) * n[0] + (w.c[2] - c[2]) * n[2]) < 0.25);
    let motelBand = null;
    const floorBox = (t, BF, y0, H, side, bw) => {
      const v = r.next(), p = t.lit ? (side ? 0.78 : 0.88) : (side ? 0.25 : 0.35);
      if (v < p) {
        const w = Math.min(bw, 10, Math.max(2.2, BF.L * range(r, 0.5, 0.9))), h = Math.min(H - 0.1, range(r, 0.75, 1.05)), y = y0 + (H - h) / 2;
        const u = (BF.L - w) / 2 + (r.next() - 0.5) * Math.max(0, bw - w) * 0.6;
        if (v < p * 0.75) add('fascia', t, { u, y, w, h, d: 0.22 }, { frame: BF }); else add('channel', t, { u, y, w, h, d: 0.1 }, { frame: BF });
      } else if (!t.lit && r.next() < 0.15) { const bw2 = Math.min(BF.L * 0.7, 8), bh = Math.min(0.8, H - 0.1); add('banner', t, { u: (BF.L - bw2) / 2, y: y0 + (H - bh) / 2, w: bw2, h: bh, d: 0.02 }, { frame: BF }); }
    };
    const planeKey = (n, c, off) => `${n[0].toFixed(2)},${n[2].toFixed(2)}|${(c[0] * n[0] + c[2] * n[2] - off).toFixed(1)}`;
    const walls = new Map();   // the sign walls (fronts, street-facing sides) for the top floor's parapet band below
    for (const b of S.bands) {
      const t = tenants[b.f]; if (!walls.has(planeKey(b.normal, b.c, 0.02))) walls.set(planeKey(b.normal, b.c, 0.02), { c: b.c, normal: b.normal, L: b.w / 0.9, off: 0.02, side: b.side, bw: b.w });
      if (!t || b.f >= signTop) continue;
      const BF = slotFrame(b.c, b.normal, b.w / 0.9, 0.02, base, b.side);
      let y0 = b.c[1] - b.h / 2, y1 = b.c[1] + b.h / 2;
      if (S.windows.length) { const ww = wallWins(b.normal, b.c), tops = ww.filter((w) => w.f === b.f).map((w) => w.c[1] + w.h / 2), bots = ww.filter((w) => w.f === b.f + 1).map((w) => w.c[1] - w.h / 2);
        if (tops.length) y0 = Math.max(...tops) + 0.06; if (bots.length) y1 = Math.min(...bots) - 0.06; }
      const H = y1 - y0;
      if (t.use === 'motel' || t.use === 'hotel') { if (b.f === 1 && !b.side && H > 0.6) motelBand = { BF, y0, H }; continue; }
      if (t.home || H < 0.45) continue;
      floorBox(t, BF, y0, H, b.side, b.w);
    }
    // the top floor's box sits on the parapet band (C's bands stop a floor short: 3F-4F buildings lost their top tenant)
    const topF = nFloors - 1, tt = tenants[topF];
    if (topF >= 1 && topF < signTop && !tt.home && tt.use !== 'motel' && tt.use !== 'hotel') {
      for (const fx of S.fascias) { const kk = planeKey(fx.normal, fx.c, SLOT.bedOut); if (!walls.has(kk)) walls.set(kk, { c: fx.c, normal: fx.normal, L: fx.w, off: SLOT.bedOut, side: fx.side, bw: fx.w * 0.9 }); }
      for (const wl of walls.values()) {
        const BF = slotFrame(wl.c, wl.normal, wl.L, wl.off, base, wl.side);
        const tops = S.windows.length ? wallWins(wl.normal, wl.c).filter((w) => w.f === topF).map((w) => w.c[1] + w.h / 2) : [];
        const y0 = tops.length ? Math.max(...tops) + 0.06 : topF * fh + fh * 0.72, H = F.top + 0.75 - y0;
        if (H >= 0.45) floorBox(tt, BF, y0, Math.min(H, 1.3), wl.side, wl.bw);
      }
    }
    // --- window lettering (시트지) on C's lit 2F-5F glass: the trade word one syllable per pane across the floor
    //     (코 인 노 래 방), or the name and phone on each pane. Translucent vinyl, lit by the room behind ---
    if (S.windows.length) {
      const groups = new Map();
      for (const w of S.windows) {
        if (!w.lit || w.f < 1 || w.f > 4) continue; const t = tenants[w.f]; if (!t || t.home || t.use === 'motel' || t.use === 'hotel') continue;
        const key = `${w.f}|${w.n[0].toFixed(2)},${w.n[2].toFixed(2)}|${(w.c[0] * w.n[0] + w.c[2] * w.n[2]).toFixed(1)}`;
        (groups.get(key) || groups.set(key, []).get(key)).push(w);
      }
      for (const ws of groups.values()) {
        const t = tenants[ws[0].f], n = ws[0].n, rx = n[2], rz = -n[0];
        ws.sort((a, b) => (a.c[0] * rx + a.c[2] * rz) - (b.c[0] * rx + b.c[2] * rz));
        // a neon piece hung in one window of a bar / pocha / karaoke floor (술, OPEN, 노래), 45 %
        if ((NIGHT_USES.has(t.use) || t.use === 'pc') && r.next() < 0.45) {
          const w = ws[Math.floor(r.next() * ws.length)], NF = slotFrame(w.c, w.n, w.w, 0.03, base, false), nw = Math.min(w.w * 0.8, range(r, 0.9, 1.5)), nh = Math.min(w.h * 0.6, range(r, 0.45, 0.7));
          add('neon', t, { u: (w.w - nw) / 2, y: w.c[1] - nh / 2 + w.h * 0.08, w: nw, h: nh, d: 0.05, z0: 0.012 }, { frame: NF, neonText: pick(r, NEON_WORDS) });
        }
        if (r.next() > (VINYL_P[t.use] ?? 0.5)) continue;
        const word = (t.name.cat || t.name.sub || t.name.main).replace(/ /g, ''), syl = [...word];
        const perPane = ws.length >= syl.length && syl.length >= 2 && syl.length <= 7 && HANGUL.test(word) && !/[A-Z]/.test(word) && r.next() < 0.6;
        const i0 = perPane ? Math.floor((ws.length - syl.length) / 2) : 0;
        ws.forEach((w, i) => {
          let text, mode;
          if (perPane) { if (i < i0 || i >= i0 + syl.length) return; text = syl[i - i0]; mode = 'syl'; }
          else { if (i > 1 && r.next() < 0.5) return; text = i === 0 ? (t.name.sub ? `${t.name.main} ${t.name.sub}` : t.name.main) : word; mode = 'full'; }
          const WF = slotFrame(w.c, w.n, w.w, 0.03, base, false);
          add('vinyl', t, { u: 0, y: w.c[1] - w.h / 2, w: w.w, h: w.h, d: 0 }, { frame: WF, vText: text, vMode: mode, nits: w.nits, lit: true });
        });
      }
    } else for (let f = 1; f < nFloors; f++) {   // no window data (a bare layout): phase 3's film panels on the facade
      const t = tenants[f]; if (t.home || t.use === 'motel' || t.use === 'hotel') continue;
      const y0 = f * fh;
      if (f >= signTop) { if (r.next() < 0.12) { const ww = Math.min(L - 0.6, range(r, 2.0, 3.6)); add('window', t, { u: range(r, 0.3, Math.max(0.35, L - ww - 0.3)), y: y0 + range(r, 0.85, 1.05), w: ww, h: range(r, 0.9, 1.3), d: 0.0 }); } continue; }
      if (r.next() < 0.7) {
        const nw = Math.max(1, Math.min(3, Math.round(L / 6) + (r.next() < 0.5 ? 0 : 1)));
        for (let j = 0; j < nw; j++) { const ww = Math.min(L / nw - 0.6, range(r, 2.0, 3.6)); add('window', t, { u: (L / nw) * j + (L / nw - ww) / 2, y: y0 + range(r, 0.85, 1.05), w: ww, h: range(r, 0.9, 1.3), d: 0.0 }); }
      }
    }
    // --- vertical blade stacks (돌출간판): one tenant box per floor at the facade edge (a flat's floor shows the business
    //     below it); every corner lot carries one; a second stack on ~30 % ---
    const bladeRoll = r.next();
    if ((nFloors >= 3 && bladeRoll < 0.75) || (sides.length && nFloors >= 2) || tower) {
      const side = r.next() < 0.5 ? 0.35 : L - 0.35, out = range(r, 0.45, 0.9), bw = range(r, 0.55, 0.75);
      for (let f = 1; f < signTop; f++) add('blade', biz(f), { u: side, y: f * fh + 0.25, w: bw, h: fh - 0.5, d: 0.32, out });
      if (lot.use === 'motel' || lot.use === 'hotel') { // one tall continuous blade for the whole building name
        add('blade', tenants[0], { u: L - side, y: fh + 0.2, w: 0.9, h: Math.min(10, (nFloors - 1) * fh - 0.4), d: 0.4, out: 1.0, tall: true });
      } else if ((r.next() < 0.3 || tower) && L > 5) {
        const side2 = L - side, out2 = range(r, 0.45, 0.8), bw2 = range(r, 0.5, 0.7);
        for (let f = 1; f < signTop; f++) add('blade', biz(f), { u: side2, y: f * fh + 0.3, w: bw2, h: fh - 0.6, d: 0.3, out: out2 });
      }
    }
    // --- round projecting box (원형돌출) at 2F for cafes/restaurants ---
    if (nFloors >= 2 && r.next() < ({ cafe: 0.5, restaurant: 0.3, shop: 0.3, bar: 0.3 }[g.use] ?? 0.08))
      add('round', g, { u: r.next() < 0.5 ? 0.5 : L - 0.5, y: fh + 0.4, w: 0.8, h: 0.8, d: 0.18, out: 0.6 });
    // --- rooftop sign: C's steel frame when the building has one (LED letters on its panel, or a light box filling it);
    //     else a frame of our own on taller buildings; a main-road tower's crown is always lit ---
    if (S.roofSign) {
      const rs = S.roofSign, RF = slotFrame(rs.c, rs.normal, rs.w, 0, base, false), xf = { frame: RF };
      const t = { ...(lot.use === 'office' ? biz(nFloors - 1) : g) }; t.lit = r.next() < 0.88 || tower;   // a tower's crown is always lit
      if (r.next() < 0.55 || tower) add('roof', t, { u: rs.w * 0.04, y: rs.c[1] - rs.h * 0.45, w: rs.w * 0.92, h: rs.h * 0.9, d: 0.3, out: 0.11, cframe: true }, xf);
      else add('fascia', t, { u: 0.05, y: rs.c[1] - rs.h / 2 + 0.06, w: rs.w - 0.1, h: rs.h - 0.12, d: 0.25, z0: -0.01, roofBox: true }, xf);
    } else if ((nFloors >= 5 && r.next() < 0.45) || tower) {
      const t = lot.use === 'office' ? biz(nFloors - 1) : tenants[0], tc = tower ? { ...t, lit: true } : t;
      const rw = Math.min(L * 0.85, range(r, 6, 11));
      add('roof', tc, { u: (L - rw) / 2, y: F.top + 0.6, w: rw, h: range(r, 1.6, 2.6), d: 0.3, out: -1.2 });
    }
    // --- street-facing side walls of corner lots: a blade stack 0.9 m from the corner (and at the far end of a long wall);
    //     their shop beds and floor boxes come from the slots above ---
    for (const SF of sides) {
      const Ls = SF.L, xf = { frame: SF };
      if (nFloors >= 2) {
        const ends = Ls > 12 ? [0.9, Ls - 0.9] : [0.9];
        for (const e of ends) { const out = range(r, 0.45, 0.85), bw = range(r, 0.55, 0.72), bu = SF.corner === 0 ? e : Ls - e;
          for (let f = 1; f < Math.max(2, signTop); f++) add('blade', biz(f), { u: bu, y: f * fh + 0.28, w: bw, h: fh - 0.56, d: 0.3, out }, xf); }
      }
      if (tower) { const rw = Math.min(Ls * 0.8, range(r, 6, 10)); add('roof', { ...tenants[0], lit: true }, { u: (Ls - rw) / 2, y: SF.top + 0.6, w: rw, h: range(r, 1.6, 2.4), d: 0.3, out: -1.2 }, xf); }
    }
    // --- motels: the name box with the 휴게/숙박 tag over the first floor's windows ---
    if (lot.use === 'motel' || lot.use === 'hotel') {
      if (motelBand) { const { BF, y0, H } = motelBand, h = Math.min(0.9, H - 0.1); add('fascia', g, { u: BF.L * 0.1, y: y0 + (H - h) / 2, w: BF.L * 0.8, h, d: 0.25 }, { frame: BF }); }
      else if (S.synth) add('fascia', g, { u: L * 0.1, y: fh * 2 - 1.1, w: L * 0.8, h: 0.9, d: 0.25 });
    }
    void fasciaY;
  }
  // --- LED screens: from the layout, plus small door screens synthesised for cafes / shops / clubs on hero streets ---
  (layout.screens || []).forEach((s, i) => screens.push({ ...s, idx: i, seed: (seed ^ hashStr(s.id)) >>> 0 }));
  for (const lot of layout.lots || []) {
    const st = streets.get(lot.street); if (!st || st.kind === 'alley') continue;
    const r = new Rng(seed ^ hashStr(lot.id + '#scr'));
    if (!['cafe', 'shop', 'club', 'karaoke', 'pc'].includes(lot.use) || r.next() > 0.55 || shut.has(lot.id)) continue;
    const F = facadeFrame(lot); const w = range(r, 1.4, 2.2), h = w * 0.5625, u = range(r, 0.4, Math.max(0.5, F.L - w - 0.4));
    const cu = u + w / 2, y = range(r, 1.3, 1.8);
    screens.push({ id: `${lot.id}:door`, lot: lot.id, pos: [F.o[0] + F.r[0] * cu + F.n[0] * 0.03, y + h / 2, F.o[1] + F.r[1] * cu + F.n[1] * 0.03],
      normal: [F.n[0], 0, F.n[1]], w, h, kind: 'small', idx: screens.length, seed: (seed ^ hashStr(lot.id + '#door')) >>> 0, synth: true });
  }
  return { specs, screens };
}

// stats for tests / report: lit share, colour shares of lit signs, counts by type and design
export function signStats(specs) {
  const byType = {}, byDesign = {}, cat = Object.fromEntries(COLOR_CATS.map((c) => [c, 0])); let lit = 0, litN = 0, neon = 0, eligible = 0, bulbs = 0, nlBoxes = 0;
  for (const s of specs) {
    byType[s.style] = (byType[s.style] || 0) + 1; byDesign[s.design] = (byDesign[s.design] || 0) + 1;
    if (s.bulbs) bulbs++;
    if (BOX_STYLES.has(s.style) && (NIGHT_USES.has(s.use) || s.use === 'pc') && s.design !== 'dots') nlBoxes++;
    if (s.type === 'banner' || s.type === 'vinyl') continue; eligible++;
    if (s.lit) { lit++; litN++; cat[s.cat]++; if (s.style === 'neon') neon++; }
  }
  const share = Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, +(v / Math.max(1, litN)).toFixed(3)]));
  return { total: specs.length, byType, byDesign, litShare: +(lit / Math.max(1, eligible)).toFixed(3), colourShare: share,
    neonShare: +(neon / Math.max(1, litN)).toFixed(3), bulbShare: +(bulbs / Math.max(1, nlBoxes)).toFixed(3) };
}

// ---------------------------------------------------------------------------------------------------------------
// 5) MSDF text layout -> face elements (local metres, origin at the face centre, x right, y up)
// ---------------------------------------------------------------------------------------------------------------
// element kinds (the shader in section 7 switches on these; native ports implement the same list):
//   BOX   light-box ground: diffuser profile (centre +20 %, edges -30 %), LED rows stronger at grazing angles, p.z=1 round
//   PANEL flat panel (galva, black board, band, tube border): emits col, reflects alb
//   FILL  MSDF glyph fill; p.x=1: LED letter profile (edges dimmer), p.x=2: script neon (the stroke is the tube)
//   TUBE  MSDF neon tube traced inside the glyph outline: half width p.x em, centre p.y em inside the edge
//   DOTS  MSDF glyph filled with exposed LED dots at pitch p.x em on a dark letter body
//   BULBS border strip of bulbs / LEDs: uv.x metres along, p = (pitch m, mode 0 static | 1 chase | 2 LED, strip width m)
//   ROOM  lit room behind window film: ceiling-light gradient, p.z=1 blinds
export const K = { BOX: 0, PANEL: 1, FILL: 2, TUBE: 3, DOTS: 4, BULBS: 5, ROOM: 6 };
const AW = MSDF.size[0], AH = MSDF.size[1];
const FACE_IDX = new Map(MSDF.faces.map((f, i) => [f.name, i]));
const GLYPH_OFS = MSDF.faces.map((f) => { const m = new Map(); [...f.chars].forEach((c, i) => m.set(c, i * 10)); return m; });
const FALLBACK_FACES = ['S2 Sans', 'S2 Gothic', 'S2 BlackHan'].map((n) => FACE_IDX.get(n));
const missingGlyphs = new Set();
function glyphOf(fi, ch) {
  for (const f of [fi, ...FALLBACK_FACES]) {
    const o = GLYPH_OFS[f]?.get(ch); if (o === undefined) continue;
    const g = MSDF.faces[f].g; if (g[o + 7] === 0 && g[o + 8] === 0) continue;   // no outline in the atlas
    return { adv: g[o] / 1000, l: g[o + 1] / 1000, b: g[o + 2] / 1000, r: g[o + 3] / 1000, t: g[o + 4] / 1000,
      u0: g[o + 5] / AW, v1: g[o + 6] / AH, u1: g[o + 7] / AW, v0: g[o + 8] / AH, ink: g[o + 9] / 1000 };
  }
  missingGlyphs.add(ch); return null;
}
const HANGUL = /[가-힣]/;
// art bug "MOÖNROÖM" (phase 4): atlas cells are packed edge to edge and some neighbours' fields read "inside" at their
// border, so bilinear (and mip) taps at a quad's edge picked up a dot from the next cell. Glyph quads and their uvs are
// inset by GLYPH_INSET texels: the 6 px distance range keeps 4 px of outside field for anti-aliasing.
export const GLYPH_INSET = 2;
const IE = GLYPH_INSET / MSDF.px, IU = GLYPH_INSET / AW, IV = GLYPH_INSET / AH;
// lay one line of text into the box centred (cx, cy), size (w, h). Letter height = h * k (hangul height, or cap height
// for Latin-only runs); too long -> condense horizontally to 55 % (as Korean sign shops do), then shrink.
function textRun(els, text, face, cx, cy, w, h, o = {}) {
  if (!text) return null;
  const fi = FACE_IDX.get(face) ?? FACE_IDX.get('S2 Sans'); const F = MSDF.faces[fi];
  const track = o.track ?? 0.03; const items = []; let adv = 0;
  for (const ch of text) {
    if (ch === ' ') { items.push(null); adv += 0.3; continue; }
    const g = glyphOf(fi, ch); items.push(g || false); adv += g ? g.adv + track : 0.5;
  }
  if (adv <= 0) return null;
  const latin = !HANGUL.test(text);
  let em = (h * (o.k ?? 0.74)) / (latin ? F.cap : F.hh);
  let sx = Math.min(1, w / (adv * em)); const minSx = o.minSx ?? 0.55;
  if (sx < minSx) { em *= sx / minSx; sx = Math.min(1, w / (adv * em)); }
  const base = cy - (latin ? F.cap / 2 : F.mid) * em, tw = adv * em * sx;
  let x = o.align === 'l' ? cx - w / 2 : o.align === 'r' ? cx + w / 2 - tw : cx - tw / 2;
  let ink = 0; const start = els.length;
  for (const g of items) {
    if (!g) { x += (g === null ? 0.3 : 0.5) * em * sx; continue; }
    const x0 = x + (g.l + IE) * em * sx, x1 = x + (g.r - IE) * em * sx, y0 = base + (g.b + IE) * em, y1 = base + (g.t - IE) * em;
    const gi = g.ink * em * em * sx, area = (x1 - x0) * (y1 - y0), u0 = g.u0 + IU, u1 = g.u1 - IU, v0 = g.v0 - IV, v1 = g.v1 + IV;
    els.push({ k: o.kind ?? K.FILL, layer: o.layer ?? 1, z: o.z ?? 0, q: [x0, y0, x1, y0, x1, y1, x0, y1], uv: [u0, v0, u1, v0, u1, v1, u0, v1],
      col: o.col || [0, 0, 0], alb: o.alb || [0.5, 0.5, 0.5], p: [o.pitchM ? o.pitchM / em : (o.p0 ?? 0), o.p1 ?? 0, area > 0 ? Math.min(1, gi / area) : 0], ink: gi, glyph: true });
    ink += gi; x += (g.adv + track) * em * sx;
  }
  return { ink, w: tw, em, start, end: els.length };
}
// one syllable per row (blade signs, 입간판)
function vStack(els, text, face, cx, cy, w, h, o = {}) {
  const chars = [...text.replace(/ /g, '')]; if (!chars.length) return 0;
  const cell = Math.min(w * 0.88, h / chars.length), top = cy + (cell * chars.length) / 2; let ink = 0;
  chars.forEach((ch, i) => { const r = textRun(els, ch, face, cx, top - (i + 0.5) * cell, cell, cell, { k: 0.8, ...o }); if (r) ink += r.ink; });
  return ink;
}
// rotate elements [a, b) by 90 deg clockwise about (cx, cy): Latin names on blades read top to bottom
function rotCW(els, a, b, cx, cy) {
  for (let i = a; i < b; i++) { const q = els[i].q; for (let j = 0; j < 8; j += 2) { const x = q[j], y = q[j + 1]; q[j] = cx + (y - cy); q[j + 1] = cy - (x - cx); } }
}
function rect(els, k, x0, y0, x1, y1, col, alb, p, layer = 0, z = 0) {
  els.push({ k, layer, z, q: [x0, y0, x1, y0, x1, y1, x0, y1], uv: [0, 0, 1, 0, 1, 1, 0, 1], col, alb, p: p || [x1 - x0, y1 - y0, 0] });
}
// bulb / LED border: four strips just outside (x0, y0)-(x1, y1); uv.x runs along in metres
function bulbBorder(els, x0, y0, x1, y1, col, mode, pitch) {
  const t = 0.055, alb = [0.03, 0.03, 0.03];
  const strip = (ax, ay, bx, by, vert) => { const len = vert ? by - ay : bx - ax;
    els.push({ k: K.BULBS, layer: 1, z: 0.01, q: [ax, ay, bx, ay, bx, by, ax, by], uv: vert ? [0, 0, 0, 1, len, 1, len, 0] : [0, 0, len, 0, len, 1, 0, 1],
      col, alb, p: [pitch, mode, t], bulb: true }); };
  strip(x0 - t, y0 - t, x1 + t, y0, false); strip(x0 - t, y1, x1 + t, y1 + t, false);
  strip(x0 - t, y0, x0, y1, true); strip(x1, y0, x1 + t, y1, true);
}

const fontFor = (spec, rr) => {
  const s = spec.style, u = spec.use;
  if (s === 'neon') return rr < 0.5 ? 'S2 Brush' : 'S2 Pen';
  if (u === 'cafe') return rr < 0.5 ? 'S2 Jua' : rr < 0.8 ? 'S2 Sans' : 'S2 Serif';
  if (u === 'restaurant' || u === 'pocha') return rr < 0.35 ? 'S2 Brush' : rr < 0.55 ? 'S2 Serif' : 'S2 BlackHan';
  if (s === 'channel' || s === 'roof') return rr < 0.5 ? 'S2 Gothic' : rr < 0.8 ? 'S2 DoHyeon' : 'S2 BlackHan';
  if (u === 'office') return rr < 0.6 ? 'S2 Sans' : 'S2 Gothic';
  return rr < 0.45 ? 'S2 BlackHan' : rr < 0.7 ? 'S2 DoHyeon' : rr < 0.85 ? 'S2 Gothic' : 'S2 Sans';
};
const E = (lit, c, nits) => { if (!lit || !(nits > 0)) return [0, 0, 0]; const n = filt(c); return [n[0] * nits, n[1] * nits, n[2] * nits]; };
const scaleC = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

// one face design -> { els, nits: emitter mean over w*h, rgb, letterNits, groundNits }
export function designFace(s, w, h) {
  const R = new Rng(s.seed ^ 0x51a7); const rr = R.next(), fam = fontFor(s, rr);
  const els = []; const lit = s.lit && s.design !== 'banner'; const nm = s.name;
  const hx = w / 2, hy = h / 2, N = s.nits;
  const hueC = s.cat === 'white' ? srgb(HEX[s.hue]) : s.rgb;
  const letterC = srgb(HEX[s.letter] || HEX.white);
  let groundNits = 0, letterNits = N;
  const design = s.design;
  // phase 4: film letters (red / blue / black vinyl over a lit diffuser: inverse boxes, yellow faces) pass the face's own
  // light through the film (filter model), so red film letters on a white face clip R like the face; black passes 2 %
  const filmLetters = design === 'inverse' || (design === 'flex' && s.hue === 'yellow');
  const filmC = srgb(HEX[s.film] || HEX.red), faceN = design === 'inverse' ? N : N * s.groundK;
  const filmOf = (k = 1) => (s.film === 'black' ? { col: E(lit, [1, 1, 1], faceN * 0.02 * k), alb: [0.03, 0.03, 0.03] } : { col: E(lit, filmC, faceN * k), alb: scaleC(filmC, 0.6) });
  const accentFilm = s.film === 'black' ? srgb(HEX.red) : filmC;           // a band on an inverse face: coloured film, clear letters
  const lettersOn = (dz) => {           // letter colour, emission, albedo per design
    if (filmLetters) return filmOf();
    if (dz === 'flex') return { col: E(lit, letterC, N), alb: [0.8, 0.8, 0.78] };
    if (dz === 'blackflex') return { col: E(lit, hueC, N), alb: scaleC(hueC, 0.6) };
    return { col: E(lit, hueC, N), alb: scaleC(hueC, 0.55) };   // galva / channel: LED letters in the light colour
  };
  const small = (k) => (filmLetters ? filmOf(1) : { col: E(lit, letterC, N * k), alb: [0.7, 0.7, 0.7] });   // phone, tag, floor
  const ground = (dz, round) => {
    if (dz === 'flex') { groundNits = N * s.groundK; rect(els, K.BOX, -hx, -hy, hx, hy, E(lit, s.rgb, groundNits), scaleC(s.rgb, 0.5), [w, h, round ? 1 : 0]); }
    else if (dz === 'inverse') { groundNits = N; letterNits = s.film === 'black' ? N * 0.02 : N * lum(filt(filmC)) / Math.max(1e-4, lum(filt(hueC)));
      rect(els, K.BOX, -hx, -hy, hx, hy, E(lit, hueC, N), [0.82, 0.82, 0.8], [w, h, round ? 1 : 0]); }
    else if (dz === 'blackflex') { groundNits = N * 0.03; rect(els, K.BOX, -hx, -hy, hx, hy, E(lit, scaleC(hueC, 0.5).map((v) => v + 0.02), groundNits), [0.035, 0.035, 0.04], [w, h, round ? 1 : 0]); }
    else { const g = srgb(s.galva); rect(els, K.PANEL, -hx, -hy, hx, hy, [0, 0, 0], g, [w, h, round ? 1 : 0]); }
  };
  switch (s.style) {
    case 'fascia': case 'round': {
      if (design === 'dots') { // exposed LED bulbs inside letter-shaped bodies on a dark board (포차, 노래방)
        rect(els, K.PANEL, -hx, -hy, hx, hy, [0, 0, 0], [0.025, 0.025, 0.03]);
        const bc = s.cat === 'white' ? srgb(HEX.bulb) : s.rgb;
        textRun(els, nm.sub && nm.main.length < 5 ? nm.main + nm.sub : nm.main, 'S2 BlackHan', 0, 0, w * 0.9, h * 0.86, { k: 0.8, kind: K.DOTS, col: E(lit, bc, N), alb: [0.05, 0.05, 0.05], pitchM: 0.045 });
        letterNits = N; break;
      }
      const round = s.style === 'round'; ground(design, round);
      const L = lettersOn(design);
      if (round) { textRun(els, (nm.sub || nm.main).slice(0, 4), fam, 0, 0, w * 0.66, h * 0.4, { col: L.col, alb: L.alb, p0: design === 'galva' ? 1 : 0 }); break; }
      const pad = w * 0.04, hasSub = !!nm.sub && w > h * 2.2;
      if (hasSub) {
        const mainW = w * 0.64;
        textRun(els, nm.main, fam, -hx + pad + mainW / 2, 0, mainW, h * 0.86, { col: L.col, alb: L.alb, p0: design === 'galva' ? 1 : 0 });
        // category word on a band at the right end, phone underneath (typical 가로형 layout); the band is a ground, not a light
        const bx0 = -hx + pad + mainW + w * 0.02, bx1 = hx - pad, by0 = hy - h * 0.62, by1 = hy - h * 0.16;
        const inv = design === 'inverse', lb = design === 'flex' || inv;
        const bandC = inv ? accentFilm : s.accentName !== 'white' && s.accentName !== s.hue ? s.accent : hueC;
        const bandN = inv ? faceN : design === 'flex' ? groundNits * 0.9 : 0;
        rect(els, lb ? K.BOX : K.PANEL, bx0, by0, bx1, by1, E(lit, bandC, bandN), lb ? scaleC(bandC, 0.5) : scaleC(bandC, 0.35), [bx1 - bx0, by1 - by0, 0], 1);
        textRun(els, nm.sub, 'S2 Sans', (bx0 + bx1) / 2, (by0 + by1) / 2, (bx1 - bx0) * 0.9, by1 - by0, { k: 0.66, layer: 2, col: E(lit, letterC, inv ? faceN : N * 0.9), alb: [0.8, 0.8, 0.8] });
        textRun(els, s.phone, 'S2 Sans', (bx0 + bx1) / 2, -hy + h * 0.2, bx1 - bx0, h * 0.22, { k: 0.8, ...small(0.7) });
      } else {
        const text = nm.sub ? `${nm.main} ${nm.sub}` : nm.main;
        textRun(els, text, fam, 0, 0, w * 0.78, h * 0.84, { col: L.col, alb: L.alb, p0: design === 'galva' ? 1 : 0 });
        if (w > h * 4 && !s.geo.roofBox) {
          textRun(els, s.tag, 'S2 Sans', -hx + w * 0.06, 0, w * 0.09, h * 0.42, { k: 0.6, ...small(0.6) });
          textRun(els, s.floor ? `${s.floor + 1}F` : '1F', 'S2 Sans', hx - w * 0.05, 0, w * 0.07, h * 0.5, { k: 0.7, ...small(0.6) });
        }
      }
      break;
    }
    case 'blade': case 'stand': {
      if (design === 'dots') {
        rect(els, K.PANEL, -hx, -hy, hx, hy, [0, 0, 0], [0.025, 0.025, 0.03]);
        const bc = s.cat === 'white' ? srgb(HEX.bulb) : s.rgb; const t = (nm.main + (nm.sub || '')).replace(/[^가-힣0-9A-Z]/g, '').slice(0, 6);
        if (t) vStack(els, t, 'S2 BlackHan', 0, -h * 0.02, w, h * 0.92, { kind: K.DOTS, col: E(lit, bc, N), alb: [0.05, 0.05, 0.05], pitchM: 0.042 });
        break;
      }
      ground(design, false); const L = lettersOn(design);
      const full = s.geo.tall ? nm.main : (nm.sub ? nm.main + nm.sub : nm.main);
      const hangul = full.replace(/[^가-힣0-9]/g, '');
      if (s.style === 'stand') { vStack(els, (hangul || full).slice(0, 5), fam, 0, 0, w, h * 0.92, { col: L.col, alb: L.alb }); break; }
      if (hangul.length >= 2 || !/[A-Z]/.test(full)) {
        // floor tag on a band at the top, name stacked one syllable per row
        const by0 = hy - h * 0.12, by1 = hy - h * 0.02;
        const inv = design === 'inverse', lb = design === 'flex' || inv;
        rect(els, lb ? K.BOX : K.PANEL, -hx * 0.84, by0, hx * 0.84, by1, E(lit, inv ? accentFilm : design === 'flex' ? scaleC(s.rgb, 1) : hueC, inv ? faceN : design === 'flex' ? groundNits * 0.7 : 0),
          inv ? scaleC(accentFilm, 0.5) : design === 'flex' ? scaleC(s.rgb, 0.35) : [0.06, 0.06, 0.06], [w * 0.84, by1 - by0, 0], 1);
        textRun(els, s.geo.tall ? s.tag : `${s.floor + 1}층`, 'S2 Sans', 0, (by0 + by1) / 2, w * 0.8, by1 - by0, { k: 0.66, layer: 2, ...(filmLetters && !inv ? filmOf() : { col: E(lit, letterC, inv ? faceN : N * 0.85), alb: [0.8, 0.8, 0.8] }) });
        vStack(els, (hangul || full).slice(0, 7), fam, 0, -h * 0.07, w, h * 0.84, { col: L.col, alb: L.alb, p0: design === 'galva' ? 1 : 0 });
      } else {
        const a = els.length; const r = textRun(els, full, fam, 0, 0, h * 0.9, w * 0.9, { col: L.col, alb: L.alb, k: 0.7 }); if (r) rotCW(els, a, els.length, 0, 0);
      }
      break;
    }
    case 'channel': case 'roof': {
      // letters are the sign: LED channel letters on a raceway (fascia) or a steel frame (roof); returns 6 cm behind
      const text = nm.sub && nm.main.length < 6 ? `${nm.main} ${nm.sub}` : nm.main;
      const r = textRun(els, text, fam, 0, 0, w * 0.96, h * 0.95, { k: 0.86, col: E(lit, hueC, N), alb: scaleC(hueC, 0.55), p0: 1 });
      if (r && s.style === 'channel') for (let i = r.start; i < r.end; i++) { const e = els[i]; els.push({ ...e, q: e.q.slice(), layer: 0, z: -0.06, col: [0, 0, 0], alb: [0.03, 0.03, 0.035], p: [0, 0, e.p[2]], ink: 0, ret: true }); }
      break;
    }
    case 'neon': {
      // black acrylic board, tubes along the letter outlines; re-skinned boxes get a tube frame in the accent colour
      rect(els, K.PANEL, -hx, -hy, hx, hy, [0, 0, 0], [0.018, 0.018, 0.02]);
      // thin script faces: the stroke itself is the tube (FILL with a tube profile); bold faces: a tube traced on the outline
      const text = s.neonText || (nm.sub || nm.main);
      const tf = s.neonText ? fam : (R.next() < 0.5 ? 'S2 Pen' : 'S2 BlackHan');
      const script = tf === 'S2 Pen' || tf === 'S2 Brush';
      textRun(els, text, tf, 0, 0, w * 0.88, h * 0.8, { k: script ? 0.78 : 0.72, kind: script ? K.FILL : K.TUBE, col: E(lit, s.rgb, N), alb: scaleC(s.rgb, 0.3), p0: script ? 2 : 0.022, p1: 0.032 });
      if (s.type !== 'neon') {
        const ins = Math.min(w, h) * 0.08, tw = 0.016, ac = E(lit, s.accentName === 'white' ? s.rgb : s.accent, N * 0.8), al = [0.2, 0.2, 0.2];
        rect(els, K.PANEL, -hx + ins, -hy + ins, hx - ins, -hy + ins + tw, ac, al, null, 1); rect(els, K.PANEL, -hx + ins, hy - ins - tw, hx - ins, hy - ins, ac, al, null, 1);
        rect(els, K.PANEL, -hx + ins, -hy + ins, -hx + ins + tw, hy - ins, ac, al, null, 1); rect(els, K.PANEL, hx - ins - tw, -hy + ins, hx - ins, hy - ins, ac, al, null, 1);
      }
      break;
    }
    case 'window': {
      // film on a lit room's glass: A = applied vinyl letters (x0.3 of the room), B = coloured film with clear cut-out letters
      const roomC = srgb(HEX[s.use === 'pc' || s.use === 'office' ? (rr < 0.7 ? 'roomCool' : 'roomFluo') : s.use === 'karaoke' ? 'roomFluo' : (rr < 0.6 ? 'roomWarm' : 'roomCool')]);
      const vinylC = s.cat === 'white' ? [0.95, 0.95, 0.92] : s.rgb;
      const text = nm.sub ? `${nm.main} ${nm.sub}` : nm.main, sub = `${s.floor + 1}층 · ${s.tag}`;
      if (design === 'vinylA') {
        groundNits = N; rect(els, K.ROOM, -hx, -hy, hx, hy, E(lit, roomC, N), [0.04, 0.045, 0.05], [w, h, rr > 0.75 ? 1 : 0]);
        const o = { col: E(lit, vinylC, N * NITS.vinyl), alb: scaleC(vinylC, 0.75) };
        textRun(els, text, fam, 0, hy - h * 0.34, w * 0.92, h * 0.55, { k: 0.82, ...o });
        textRun(els, sub, 'S2 Sans', 0, -hy + h * 0.22, w * 0.8, h * 0.28, { k: 0.7, ...o });
        letterNits = N * NITS.vinyl;
      } else {
        groundNits = N * NITS.vinyl; rect(els, K.ROOM, -hx, -hy, hx, hy, E(lit, vinylC, groundNits), scaleC(vinylC, 0.45), [w, h, 0]);
        const o = { col: E(lit, roomC, N), alb: [0.05, 0.05, 0.05] };
        textRun(els, text, fam, 0, hy - h * 0.34, w * 0.92, h * 0.55, { k: 0.82, ...o });
        textRun(els, sub, 'S2 Sans', 0, -hy + h * 0.22, w * 0.8, h * 0.28, { k: 0.7, ...o });
      }
      break;
    }
    case 'vinyl': {
      // translucent cut vinyl on C's lit glass (no ground: the room shows through): white / pale film scatters the room
      // light toward the street (x1.15), coloured film passes its band (x0.8). One syllable per pane, or name + trade word
      const vc = s.cat === 'white' ? srgb(HEX[s.letter] || HEX.white) : s.rgb, T = s.cat === 'white' ? 1.15 : 0.8;
      const o = { col: E(lit, vc, N * T), alb: scaleC(vc, 0.7), layer: 1 };
      if (s.vMode === 'syl') textRun(els, s.vText, fam, 0, h * 0.04, w * 0.78, h * 0.6, { k: 0.86, ...o });
      else { textRun(els, s.vText, fam, 0, hy - h * 0.3, w * 0.86, h * 0.36, { k: 0.82, ...o }); textRun(els, s.phone, 'S2 Sans', 0, -hy + h * 0.24, w * 0.7, h * 0.16, { k: 0.8, ...o }); }
      letterNits = N * T; break;
    }
    case 'banner': {
      const cl = srgb(pick(R, ['#d8d2c4', '#e8e1cf', '#c9d6e0', '#f0e6c8'])).map((v) => v * 0.8);
      rect(els, K.PANEL, -hx, -hy, hx, hy, [0, 0, 0], cl);
      textRun(els, pick(R, BANNER_WORDS), 'S2 BlackHan', 0, 0, w * 0.92, h * 0.8, { k: 0.74, col: [0, 0, 0], alb: srgb(pick(R, ['#c81e1e', '#1d3fa8', '#111111'])) });
      letterNits = 0; break;
    }
    default: break;
  }
  // graphics #5: channel letters are acrylic faces on returns. Galva LED letters on box faces stand 3.5 cm proud of their
  // panel over a dark return copy; roof letters get 10 cm returns (fascia channel letters have theirs above, 6 cm)
  if (s.style === 'roof' || (s.design === 'galva' && (s.style === 'fascia' || s.style === 'round'))) {
    const roof = s.style === 'roof', n0 = els.length;
    for (let i = 0; i < n0; i++) { const e = els[i]; if (!e.glyph || e.p[0] !== 1 || e.ret) continue; if (!roof) e.z = 0.035;
      els.push({ ...e, q: e.q.slice(), layer: roof ? 0 : 1, z: roof ? -0.1 : 0.004, col: [0, 0, 0], alb: [0.03, 0.03, 0.035], p: [0, 0, e.p[2]], ink: 0, ret: true }); }
  }
  if (s.bulbs && lit) {
    const mode = s.bulbs === 'chase' ? 1 : s.bulbs === 'bulbs' ? 0 : 2;
    const c = mode === 2 ? (s.accentName === 'white' ? s.rgb : s.accent) : srgb(HEX.bulb);
    bulbBorder(els, -hx, -hy, hx, hy, E(true, c, NITS.bulb[0] + (NITS.bulb[1] - NITS.bulb[0]) * ((s.seed % 997) / 997)), mode, mode === 2 ? 0.05 : 0.11);
  }
  // emitter mean over w*h (what lights the street): letters by their ink, grounds minus the ink they carry, bulbs by fill
  let Y = 0; const C = [0, 0, 0]; let inkLit = 0;
  for (const e of els) if (e.glyph && !e.ret && lum(e.col) > 0) inkLit += e.ink;
  for (const e of els) {
    const ly = lum(e.col); if (!(ly > 0)) continue;
    let a;
    // area x the shader's profile mean: tube ink 0.3 x cos^2 tube 0.67; LED channel stroke 0.78; script tube 0.6; bulbs pi (0.72 r)^2 / cell
    if (e.glyph) a = e.ink * (e.k === K.TUBE ? 0.2 : e.k === K.DOTS ? 0.3 : e.p[0] === 1 ? 0.78 : e.p[0] === 2 ? 0.6 : 1);
    else if (e.bulb) { const rad = e.p[1] > 1.5 ? 0.006 : 0.010; a = Math.abs((e.q[2] - e.q[0]) * (e.q[5] - e.q[1])) * 1.634 * rad * rad / (e.p[0] * e.p[2]); }
    else { a = Math.abs((e.q[2] - e.q[0]) * (e.q[5] - e.q[1])); if (e.layer === 0) a = Math.max(0, a - inkLit); }
    Y += ly * a; C[0] += e.col[0] * a; C[1] += e.col[1] * a; C[2] += e.col[2] * a;
  }
  const area = Math.max(1e-4, w * h);
  return { els, nits: Y / area, rgb: Y > 0 ? norm1(C) : [1, 1, 1], letterNits: lit ? letterNits : 0, groundNits: lit ? groundNits : 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// 6) LED screens: content programs, playlists, CPU mean colour for the spill emitter
// ---------------------------------------------------------------------------------------------------------------
// palettes (sRGB hex) for screen programs; invented campaigns only. c0/c1 are grounds (never near-white: a screen at
// 180-350 nits must not read as a white plate), c2 is the accent; text is white.
const SCREEN_PALETTES = [
  ['#1b6dff', '#21e6ff', '#ffffff'], ['#ff2fa0', '#7a2cff', '#ffd2f0'], ['#0b0b18', '#ff3cbe', '#2be8ff'], ['#ffb21a', '#ff3a1a', '#fff2c0'],
  ['#12c86a', '#d8ff3a', '#ffffff'], ['#0a1440', '#3a7bff', '#ffffff'], ['#ff6a3c', '#ffd23a', '#2a0a3a'], ['#00b4d8', '#ff4f9a', '#fafafa'],
  ['#ff2a4a', '#1a1a2a', '#e8e8f0'], ['#5a1aff', '#ff2ad2', '#ffffff'],
];
// program ids (keep in sync with the GLSL below)
export const PROG = { GRADIENT: 0, STAGE: 1, EVENT: 2, BUBBLES: 3, GRIDGAME: 4, CLOCK: 5, WIPE: 6, PSA: 7 };
// content level of grounds relative to the white text peak (colour #5: mean ~0.3 x peak, soft knee)
export const SCREEN_BG = 0.3;
// text rows used by each program (main, sub)
const PROG_TEXT = { 0: [[0, 1], [11, 12]], 1: [[2, 3]], 2: [[4, 5]], 3: [[6, 7]], 4: [[8, 9]], 5: [[10, -1]], 6: [[11, 12], [15, 16]], 7: [[13, 14]] };

function makePlaylist(seed, kind) {
  const r = new Rng(seed); const n = kind === 'small' ? 3 : 4; const list = []; const used = new Set();
  const pool = kind === 'small' ? [0, 3, 6, 5, 2] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = 0; i < n; i++) {
    let p = pick(r, pool); let guard = 0; while (used.has(p) && guard++ < 10) p = pick(r, pool); used.add(p);
    const pal = SCREEN_PALETTES[Math.floor(r.next() * SCREEN_PALETTES.length)].map(srgb);
    const tx = pick(r, PROG_TEXT[p]);
    list.push({ prog: p, dur: p === PROG.CLOCK ? 5 : range(r, 6, 10), pal, text: tx, seed: r.next() * 100 });
  }
  let t0 = 0; for (const s of list) { s.t0 = t0; t0 += s.dur; }
  return { list, len: t0, phase: r.next() * t0 };
}
const fract = (x) => x - Math.floor(x);
const mix3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const W1 = [1, 1, 1];
// approximate mean linear colour of a program frame relative to the peak (mirrors the shader's area weights)
export function programMean(seg, lt) {
  const [c0, c1, c2] = seg.pal; const B = SCREEN_BG;
  switch (seg.prog) {
    case 0: { const k = 0.5 + 0.25 * Math.sin(lt * 0.9 + seg.seed); return mix3(scaleC(mix3(mix3(c0, c1, k), c2, 0.12), B), W1, 0.07); }
    case 1: { const beat = Math.pow(fract(lt * 2.0), 3); return mix3(mix3([0.01, 0.01, 0.02], scaleC(mix3(c0, c1, 0.5 + 0.5 * Math.sin(lt)), 0.6), 0.18 + 0.25 * (1 - beat)), W1, 0.05); }
    case 2: return mix3(scaleC(c0, 0.875 * B), W1, 0.1);
    case 3: return mix3(scaleC(c0, 0.625 * B), W1, 0.07);
    case 4: return mix3(mix3([0.02, 0.0, 0.05], scaleC(c1, 0.7), 0.16), c2, 0.05);
    case 5: return mix3([0.004, 0.01, 0.04], W1, 0.12);
    case 6: { const w = Math.min(1, lt / 1.2); const ph = Math.floor(lt / 2.5) % 3; const cs = [c0, c1, scaleC(c2, 0.4)]; return mix3(scaleC(mix3(cs[(ph + 2) % 3], cs[ph], w), B), W1, 0.08); }
    case 7: return mix3(scaleC(c0, 0.8 * B), W1, 0.1);
    default: return scaleC(c0, B);
  }
}

// GLSL: content programs in linear [0,1] at LED-pixel-quantised uv (globals set per fragment from the instance)
export const SCREEN_CONTENT_GLSL = /* glsl */`
int gProg; float gSeed, gCut, gT; vec3 gC0, gC1, gC2; vec2 gRow, gRes;
uniform sampler2D uText; uniform float uRows, uT, uBg;
float sdn(float a, float b, float x){ return 1.0 - smoothstep(b, a, x); } // falling edge, a > b
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float txt(vec2 uv, float row){
  if (row < 0.0 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture2D(uText, vec2(uv.x, (row + 1.0 - uv.y) / uRows)).a; }
vec3 content(vec2 uv, float t){
  vec3 c = vec3(0.0); float a = 0.0; float asp = gRes.x / gRes.y;
  if (gProg == 0) { // flowing gradient ad + product line
    float f = sin(uv.x*3.0 + t*0.7 + gSeed) + sin(uv.y*4.0 - t*0.5) + sin((uv.x+uv.y)*2.5 + t*0.9);
    c = mix(gC0, gC1, 0.5 + 0.25*f); c = mix(c, gC2, smoothstep(1.2, 2.6, f) * 0.6); c *= uBg;
    float slide = clamp(t * 1.4, 0.0, 1.0); slide = 1.0 - pow(1.0 - slide, 3.0);
    a = txt(vec2((uv.x - 0.08) / 0.84 + (1.0 - slide), (uv.y - 0.45) / 0.3), gRow.x);
    float b = txt(vec2((uv.x - 0.2) / 0.6, (uv.y - 0.22) / 0.16), gRow.y) * smoothstep(0.8, 1.4, t);
    c = mix(c, vec3(1.0), max(a, b));
  } else if (gProg == 1) { // stage: beams + equaliser + title
    c = vec3(0.01, 0.008, 0.02);
    for (int i = 0; i < 5; i++) { float fi = float(i); float ang = sin(t*0.8 + fi*1.7 + gSeed) * 0.6;
      vec2 o = vec2(0.1 + fi*0.2, -0.05); vec2 d = uv - o; float aa = atan(d.x, d.y) - ang;
      c += mix(gC0, gC1, fi/4.0) * 0.6 * sdn(0.09, 0.0, abs(aa)) * (0.7 - 0.5*length(d)); }
    float bars = floor(uv.x * 24.0); float hgt = 0.08 + 0.22 * abs(sin(t*3.0 + bars*0.7 + sin(bars*1.3 + t)));
    float beat = pow(fract(t*2.0), 3.0);
    c += mix(gC1, gC2, uv.y*3.0) * 0.55 * step(uv.y, hgt) * step(0.15, fract(uv.x*24.0)) * (0.6 + 0.4*(1.0-beat));
    a = txt(vec2((uv.x - 0.1) / 0.8, (uv.y - 0.62) / 0.22), gRow.x); float b = txt(vec2((uv.x - 0.12)/0.76, (uv.y - 0.42)/0.18), gRow.y);
    c = mix(c, vec3(1.0), max(a, b * smoothstep(0.5, 1.0, t)));
  } else if (gProg == 2) { // event: big D-day, confetti
    c = gC0 * (0.75 + 0.25*uv.y) * uBg;
    vec2 g = vec2(uv.x * asp, uv.y) * 14.0; g.y += t * 2.5; vec2 id = floor(g); float hh = h21(id);
    vec2 fp = fract(g) - 0.5; float conf = step(0.82, hh) * step(max(abs(fp.x), abs(fp.y)), 0.18 + 0.1*sin(t*5.0 + hh*20.0));
    c = mix(c, mix(gC1, gC2, fract(hh*7.0)) * 0.7, conf);
    a = txt(vec2((uv.x - 0.06) / 0.88, (uv.y - 0.6) / 0.24), gRow.x);
    float big = txt(vec2((uv.x - 0.3) / 0.4, (uv.y - 0.12) / 0.42), gRow.y) * (0.85 + 0.15*step(0.5, fract(t*1.5)));
    c = mix(c, vec3(1.0), max(a, big));
  } else if (gProg == 3) { // drink: deep gradient, rising bubbles
    c = mix(gC0 * 0.25, gC0, uv.y) * uBg;
    for (int i = 0; i < 3; i++) { float s = 8.0 + float(i)*6.0; vec2 g = vec2(uv.x*asp, uv.y - t*(0.12 + 0.05*float(i))) * s;
      vec2 id = floor(g); vec2 fp = fract(g) - 0.5 - (vec2(h21(id), h21(id+3.1)) - 0.5) * 0.5; float r = 0.12 + 0.18*h21(id+7.7);
      c += gC2 * 0.4 * step(0.55, h21(id+1.3)) * sdn(r, r - 0.06, length(fp)) * smoothstep(r - 0.12, r, length(fp)); }
    a = txt(vec2((uv.x - 0.1) / 0.8, (uv.y - 0.5) / 0.3), gRow.x); float b = txt(vec2((uv.x - 0.2)/0.6, (uv.y - 0.28)/0.16), gRow.y);
    c = mix(c, vec3(1.0), max(a, b));
  } else if (gProg == 4) { // game pre-registration: perspective grid, title
    c = mix(vec3(0.02, 0.0, 0.05), gC0 * 0.4 * uBg, uv.y);
    float hz = 0.42; if (uv.y < hz) { float z = 1.0 / max(hz - uv.y, 1e-3); float gx = (uv.x - 0.5) * z; float gz = z + t * 4.0;
      float line = max(sdn(0.06*z*0.05, 0.0, abs(fract(gx) - 0.5) - 0.47), smoothstep(0.0, 0.03, fract(gz*0.5) - 0.96));
      c += gC1 * 0.7 * line * smoothstep(0.0, 0.25, hz - uv.y + 0.05); }
    c += gC1 * 0.42 * sdn(0.012, 0.0, abs(uv.y - hz));
    a = txt(vec2((uv.x - 0.05) / 0.9, (uv.y - 0.58) / 0.24), gRow.x); float b = txt(vec2((uv.x - 0.25)/0.5, (uv.y - 0.82)/0.12), gRow.y) * step(0.5, fract(t*1.2));
    c = mix(c, mix(gC2, vec3(1.0), 0.5), max(a, b));
  } else if (gProg == 5) { // clock + weather (public info)
    c = mix(vec3(0.004, 0.01, 0.05), vec3(0.01, 0.03, 0.12), uv.y);
    float mins = 41.0 + floor(uT / 60.0); float hh = mod(23.0 + floor(mins / 60.0), 24.0); float mm = mod(mins, 60.0);
    vec2 box = vec2((uv.x - 0.2) / 0.6, (uv.y - 0.36) / 0.44);
    if (box.x > 0.0 && box.x < 1.0 && box.y > 0.0 && box.y < 1.0) { float k = floor(box.x * 5.0); float lx = fract(box.x * 5.0);
      float dig = k < 0.5 ? floor(hh/10.0) : k < 1.5 ? mod(hh,10.0) : k < 2.5 ? 10.0 : k < 3.5 ? floor(mm/10.0) : mod(mm,10.0);
      float blink = (k > 1.5 && k < 2.5) ? step(0.5, fract(uT)) : 1.0;
      a = blink * texture2D(uText, vec2((dig + 0.5 + (lx - 0.5) * 0.95) / 11.0, (uRows - 1.0 + 1.0 - box.y) / uRows)).a; }
    float b = txt(vec2((uv.x - 0.1)/0.8, (uv.y - 0.1)/0.18), gRow.x);
    c = mix(c, vec3(1.0), max(a, b * 0.9));
  } else if (gProg == 6) { // fashion: diagonal colour-block wipes (accent dimmed: never a white field)
    float ph = floor(t / 2.5); float lt = t - ph*2.5; float w = clamp(lt / 1.2, 0.0, 1.0);
    vec3 cA = gC2 * 0.4; int pi = int(mod(ph, 3.0)); vec3 cs0 = pi == 0 ? gC0 : pi == 1 ? gC1 : cA; vec3 cs1 = pi == 0 ? cA : pi == 1 ? gC0 : gC1;
    float edge = uv.x + uv.y*0.4; c = mix(cs1, cs0, step(edge, w * 1.5)) * uBg;
    a = txt(vec2((uv.x - 0.08) / 0.84, (uv.y - 0.5) / 0.28), gRow.x); float b = txt(vec2((uv.x - 0.15)/0.7, (uv.y - 0.25)/0.16), gRow.y);
    c = mix(c, vec3(1.0), max(a, b));
  } else { // PSA: calm flat panel
    c = mix(gC0, gC0 * 0.6, uv.y) * uBg;
    a = txt(vec2((uv.x - 0.08) / 0.84, (uv.y - 0.5) / 0.28), gRow.x); float b = txt(vec2((uv.x - 0.15)/0.7, (uv.y - 0.25)/0.16), gRow.y);
    c = mix(c, vec3(1.0), max(a, b));
  }
  c *= 1.0 - 0.85 * gCut; // one dark frame on a cut (players switch playlists)
  return clamp(c, 0.0, 1.0);
}`;
// SMD panel model per fragment: dies resolved up close, sensor-box-filter moire at mid range, louvre falloff, rolling
// refresh bands. Inputs: cell = uv * res; returns the multiplier on the content colour.
const SCREEN_PANEL_GLSL = /* glsl */`
vec3 ledPanel(vec2 cell, float moire){
  vec2 f = fract(cell); vec2 q = f - 0.5; float rr = 0.13;
  vec3 mask = vec3(sdn(rr, rr*0.55, length(q - vec2(-0.14, 0.09))), sdn(rr, rr*0.55, length(q - vec2( 0.14, 0.09))), sdn(rr, rr*0.55, length(q - vec2( 0.0, -0.13))));
  const float FILL = 0.0385;
  vec2 px2 = max(fwidth(cell), vec2(1e-4)); float px = max(px2.x, px2.y);
  float resolve = sdn(0.75, 0.3, px);
  vec2 sx = 3.14159265 * px2; vec2 att = abs(sin(sx) / sx) * (vec2(1.0) - smoothstep(vec2(1.5), vec2(4.0), px2));
  float k = 0.85 * moire;
  vec3 ox = vec3(-0.14, 0.14, 0.0), oy = vec3(0.09, 0.09, -0.13);
  vec3 far = (1.0 + k * att.x * cos(6.2831853 * (cell.x - 0.5 - ox))) * (1.0 + k * att.y * cos(6.2831853 * (cell.y - 0.5 - oy)));
  return mix(far, mask / FILL, resolve);
}`;

// LED dot scroller (전광판): one merged mesh; per-vertex row/speed/colour/dot count
const SCROLL_VERT = /* glsl */`
attribute vec4 aS; // row, speed (dots/s), cols, phase
attribute vec3 aC; // linear colour * nits
varying vec2 vUv; varying vec4 vS; varying vec3 vC;
void main(){ vUv = uv; vS = aS; vC = aC; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const SCROLL_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv; varying vec4 vS; varying vec3 vC;
uniform sampler2D uText; uniform float uT, uRows, uTexW, uNit;
float sdn(float a, float b, float x){ return 1.0 - smoothstep(b, a, x); }
void main(){
  float rows = 16.0; vec2 cell = vec2(vUv.x * vS.z, vUv.y * rows); vec2 id = floor(cell); vec2 f = fract(cell) - 0.5;
  float x = mod(id.x + floor(uT * vS.y + vS.w), uTexW);
  float on = step(0.5, texture2D(uText, vec2((x + 0.5) / uTexW, (vS.x + 1.0 - (id.y + 0.5) / rows) / uRows)).a);
  float px = max(fwidth(cell.x), fwidth(cell.y));
  float dotm = mix(sdn(0.42, 0.28, length(f)) / 0.38, 1.0, smoothstep(0.4, 1.2, px));
  vec3 c = vC * (on * dotm + 0.004);
  gl_FragColor = vec4(c * uNit, 1.0 + on * sdn(0.3, 0.12, length(f)) * (1.0 - smoothstep(0.4, 1.2, px)));   // P3-B1 core flag
}`;

// ---------------------------------------------------------------------------------------------------------------
// 7) CPU data: specs -> faces (elements), housing boxes, emitters, screens, scrollers. Pure and node-safe; build()
//    turns it into GPU meshes and exportData() into signs.json / screens.json for the native port.
// ---------------------------------------------------------------------------------------------------------------
const HOUSE = [0.035, 0.036, 0.04], STEEL = [0.06, 0.06, 0.065], RACE = [0.02, 0.02, 0.022];
const UP = [0, 1, 0];
const add3 = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const r3 = (v) => v.map((x) => +x.toFixed(3));

export function buildData(layout, opts = {}) {
  missingGlyphs.clear();
  const { specs, screens } = generateSigns(layout, opts);
  const faces = [], boxes = [], emitters = [], scrollers = [];
  const pos3 = (F, u, y, d) => [F.o[0] + F.r[0] * u + F.n[0] * d, y, F.o[1] + F.r[1] * u + F.n[1] * d];
  const kindOf = { fascia: 'lightbox', stand: 'lightbox', blade: 'lightbox', round: 'lightbox', channel: 'channel', roof: 'channel', window: 'store', neon: 'neon', banner: 'lightbox', vinyl: 'store' };
  const B = (c, r, n, hw, hh, hd, col, noFront = false, collide = true) => boxes.push({ c: r3(c), r: r3(r), n: r3(n), hw, hh, hd, col, noFront, collide });
  let glyphs = 0, elements = 0;
  for (const s of specs) {
    const F = s.frame, G = s.geo; const n = [F.n[0], 0, F.n[1]], r = [F.r[0], 0, F.r[1]];
    if (s.style === 'scroller') {
      const c = pos3(F, G.u + G.w / 2, G.y + G.h / 2, 0.08);
      B(add3(c, n, -0.04), r, n, G.w / 2 + 0.04, G.h / 2 + 0.04, 0.04, RACE, true);
      const hue = pick(new Rng(s.seed), [['red', 0.6], ['amber', 0.25], ['green', 0.15]].flatMap(([h, w]) => Array(Math.round(w * 20)).fill(h)));
      const cl = srgb(HEX[s.lit ? hue : 'red']);
      scrollers.push({ id: s.id, c, n, w: G.w, h: G.h, row: s.scrollRow, speed: 7 + (s.seed % 6), cols: Math.round(G.w / (G.h / 16)), phase: s.seed % 500, rgb: cl, nits: s.lit ? s.nits : 0 });
      // filter model: s.nits is white-equivalent (the lit dot's brightest channel); ~30 % of the cells are on
      if (s.lit) emitters.push({ id: s.id, pos: r3(c), normal: n, w: G.w, h: G.h, rgb: norm1(cl).map((v) => +v.toFixed(4)), nits: Math.round(s.nits * 0.3 * lum(filt(cl))), kind: 'screen', animated: true, use: s.use, lot: s.lot });
      continue;
    }
    const fw = s.type === 'stand' ? G.w * 0.92 : G.w, fhh = s.type === 'stand' ? G.h * 0.94 : G.h;
    const D = designFace(s, fw, fhh);
    const fk = s.flicker ? [s.flicker.hz, (s.seed % 1000) / 1000] : [0, 0];
    const lit = s.lit && s.style !== 'banner' && s.type !== 'vinyl' && D.nits > 0;   // window film: the pane is C's emitter
    let nf = 0;
    const face = (c, m) => {
      faces.push({ id: s.id, c: r3(c), m: r3(m), w: fw, h: fhh, els: D.els, flk: fk });
      glyphs += D.els.filter((e) => e.glyph).length; elements += D.els.length;
      if (lit) emitters.push({ id: `${s.id}${nf ? ':' + (nf + 1) : ''}`, pos: r3(c), normal: r3(m), w: +fw.toFixed(3), h: +fhh.toFixed(3),
        rgb: D.rgb.map((v) => +v.toFixed(4)), nits: Math.round(D.nits), kind: kindOf[s.style], ...(s.flicker ? { flicker: s.flicker } : {}), animated: false, use: s.use, lot: s.lot });
      nf++;
    };
    if (s.type === 'blade' || s.type === 'round') {
      // perpendicular to the facade: double-sided, faces normal +-r; two steel arms to the wall
      const c = pos3(F, G.u, G.y + G.h / 2, G.out + G.w / 2);
      B(c, n, [-r[0], 0, -r[2]], G.w / 2 + 0.03, G.h / 2 + 0.03, G.d / 2, HOUSE, false);
      B(pos3(F, G.u, G.y + G.h - 0.1, G.out / 2), r, n, 0.03, 0.03, G.out / 2, STEEL, false, false);
      B(pos3(F, G.u, G.y + 0.1, G.out / 2), r, n, 0.03, 0.03, G.out / 2, STEEL, false, false);
      for (const sg of [1, -1]) { const m = [r[0] * sg, 0, r[2] * sg]; face(add3(c, m, G.d / 2 + 0.031 + 0.002), m); }
    } else if (s.type === 'stand') {
      const c = pos3(F, G.u, G.y + G.h / 2, G.out);
      B([c[0], 0.075, c[2]], r, n, 0.32, 0.075, 0.32, RACE);
      B(c, r, n, G.w / 2, G.h / 2, G.d / 2, HOUSE, false);
      for (const m of [n, [-n[0], 0, -n[2]]]) face(add3(c, m, G.d / 2 + 0.003), m);
    } else if (s.type === 'roof') {
      const c = pos3(F, G.u + G.w / 2, G.y + G.h / 2, G.out);
      if (!G.cframe) {   // our own steel; on C's frame (roofSign) the letters' 10 cm returns stand on its backing panel
        for (const k of [0.1, 0.5, 0.9]) B(pos3(F, G.u + G.w * k, (F.top + G.y + G.h) / 2, G.out - 0.35), r, n, 0.05, (G.y + G.h - F.top) / 2, 0.05, STEEL);
        B(pos3(F, G.u + G.w / 2, G.y + G.h * 0.25, G.out - 0.35), r, n, G.w / 2, 0.04, 0.04, STEEL);
        B(pos3(F, G.u + G.w / 2, G.y + G.h * 0.75, G.out - 0.35), r, n, G.w / 2, 0.04, 0.04, STEEL);
      }
      face(add3(c, n, 0.02), n);
    } else {
      // z0: the slot's own depth (C's sign bed is 8 cm proud: a bed sign's back sits on it)
      const z0 = G.z0 || 0, c = pos3(F, G.u + G.w / 2, G.y + G.h / 2, z0 + G.d / 2 + 0.02);
      if (s.style === 'channel') { // raceway bar behind letters; letters stand 0.1 m proud
        B(pos3(F, G.u + G.w / 2, G.y + G.h * 0.45, z0 + 0.06), r, n, G.w * 0.48, 0.06, 0.04, RACE);
        face(add3(c, n, G.d / 2), n);
      } else if (s.type === 'vinyl') {   // on the pane: C's window quad is 3 cm out (the frame's wall line), the film 1.5 cm before it
        face(pos3(F, G.u + G.w / 2, G.y + G.h / 2, SLOT.vinylOut), n);
      } else if (s.type === 'window' || s.type === 'banner') {
        face(pos3(F, G.u + G.w / 2, G.y + G.h / 2, z0 + 0.025), n);
      } else {
        if (G.d > 0.07) B(c, r, n, G.w / 2 + 0.03, G.h / 2 + 0.03, G.d / 2, HOUSE, true);
        else B(add3(c, n, -0.01), r, n, G.w / 2 + 0.03, G.h / 2 + 0.03, 0.012, RACE, true, false); // neon backboard
        face(add3(c, n, G.d / 2 + 0.002), n);
      }
    }
  }
  // --- LED screens ---
  const scr = [];
  for (const sc of screens) {
    const pl = makePlaylist(sc.seed, sc.kind);
    const pitch = sc.kind === 'billboard' ? 0.016 : sc.kind === 'facade' ? 0.010 : 0.0025;      // m per LED pixel
    const res = [Math.round(sc.w / pitch), Math.round(sc.h / pitch)];
    const r = new Rng(sc.seed ^ 0x9e37);
    const scanHz = sc.kind === 'small' ? pick(r, [960, 1920, 3840]) : pick(r, [240, 480, 960, 1920]);
    const bandDepth = { 240: 0.42, 480: 0.3, 960: 0.18, 1920: 0.09, 3840: 0.04 }[scanHz];
    const nitsRange = sc.kind === 'small' ? NITS.screenSmall : NITS.screen; const nits = nitsRange[0] + (nitsRange[1] - nitsRange[0]) * r.next();
    const bandRate = 0.35 + r.next() * 0.9, seedU = r.next() * 10;
    const nl = Math.hypot(sc.normal[0], sc.normal[2]) || 1; const N = [sc.normal[0] / nl, 0, sc.normal[2] / nl];
    const fr = [N[2], 0, -N[0]], cab = [sc.pos[0] - N[0] * 0.25, sc.pos[1], sc.pos[2] - N[2] * 0.25];
    B(cab, fr, N, sc.w / 2 + 0.12, sc.h / 2 + 0.12, 0.2, HOUSE, false, sc.kind !== 'small');
    if (sc.kind === 'billboard') { const bot = sc.pos[1] - sc.h / 2; const lot = (layout.lots || []).find((l) => l.id === sc.lot); const roof = lot ? lot.floors * (lot.floorH || 3.2) : bot - 3;
      for (const k of [-0.4, 0, 0.4]) B([cab[0] + fr[0] * sc.w * k - N[0] * 0.6, (bot + roof) / 2, cab[2] + fr[2] * sc.w * k - N[2] * 0.6], fr, N, 0.08, Math.max(0.1, (bot - roof) / 2), 0.08, STEEL); }
    const em = { id: sc.id, pos: r3([sc.pos[0] + N[0] * 0.05, sc.pos[1], sc.pos[2] + N[2] * 0.05]), normal: N, w: sc.w, h: sc.h,
      rgb: [1, 1, 1], nits: 0, kind: 'screen', animated: true, lot: sc.lot, screenKind: sc.kind };
    emitters.push(em);
    scr.push({ id: sc.id, lot: sc.lot, kind: sc.kind, pos: sc.pos, normal: N, w: sc.w, h: sc.h, pitch, res, scanHz, bandDepth, bandRate, seedU, nits, playlist: pl, em });
  }
  const stats = { ...signStats(specs), faces: faces.length, elements, glyphs, boxes: boxes.length, emitters: emitters.length, screens: scr.length,
    scrollers: scrollers.length, missingGlyphs: [...missingGlyphs].join(''), msdf: { size: MSDF.size[0], pxPerEm: MSDF.px, range: MSDF.range } };
  return { specs, faces, boxes, emitters, screens: scr, scrollers, stats };
}

// screen state at time t (pure): program, local time, cut, palette, rows, emitter mean colour / nits
function screenState(o, t) {
  const pl = o.playlist; const lt0 = fract((t + pl.phase) / pl.len) * pl.len;
  let seg = pl.list[0]; for (const s of pl.list) if (lt0 >= s.t0) seg = s;
  const lt = lt0 - seg.t0; const cut = lt < 1 / 30 ? 1 : 0;
  const m = programMean(seg, lt); const y = lum(m);
  return { seg, lt, cut, rgb: norm1(m), nits: o.nits * y * (1 - 0.85 * cut) };
}

// ---------------------------------------------------------------------------------------------------------------
// 8) native export (native #2): signs.json + screens.json. Positions in metres (x east, y up, z south), luminance in
//    cd/m^2, element quads in face-local metres (x right, y up) with atlas uvs; shading per kind is K above.
// ---------------------------------------------------------------------------------------------------------------
export function exportData(layout, opts = {}) {
  const D = buildData(layout, opts);
  const rq = (a) => a.map((v) => Math.round(v * 1e4) / 1e4);
  const designs = new Map(); const faceRecs = [];
  for (const f of D.faces) {
    let di = designs.get(f.els); if (di === undefined) { di = designs.size; designs.set(f.els, di); }
    faceRecs.push({ id: f.id, c: f.c, n: f.m, w: +f.w.toFixed(3), h: +f.h.toFixed(3), design: di, flicker: f.flk[0] ? { hz: +f.flk[0].toFixed(2), phase: f.flk[1], depth: 0.7 } : null });
  }
  const designList = [...designs.keys()].map((els) => els.map((e) => ({ k: e.k, layer: e.layer, z: e.z || 0, q: rq(e.q), uv: rq(e.uv),
    col: e.col.map((v) => +v.toFixed(2)), alb: e.alb.map((v) => +v.toFixed(3)), p: e.p.map((v) => +(+v).toFixed(4)) })));
  const signs = {
    version: SIGNS_VERSION, units: { length: 'm', luminance: 'cd/m^2', frame: 'x east, y up, z south' },
    kinds: K, kindDoc: 'BOX light-box ground (diffuser: centre +20 %, edges -30 %, LED rows 0.12 m at grazing angles; p=[w,h,round]); PANEL flat (emits col, reflects alb); FILL MSDF glyph fill (p.x=1 LED channel letter: 0.45 + 0.55 smoothstep(0, 0.04 em, d) across the stroke, mean 0.78 when unresolved; p.x=2 script neon: (1 + 2 sin^2(pi/2 min(d / 0.028 em, 1))) / 3; p.z = mean coverage of the quad); TUBE neon tube on the glyph outline (p.x half width, em; (1 + 2 cos^2(pi/2 |dc| / hw)) / 3: core 3x the sleeve); DOTS exposed LEDs inside the glyph (p.x pitch, em); BULBS border strip (uv.x metres along; p=[pitch m, 0 static|1 chase|2 LED, width m]; points of radius 1.0 cm (LED 0.6 cm), filtered to the pixel footprint (a one-pixel tent carrying the disc energy when sub-pixel), several per pixel: mean pi (0.72 r)^2 / (pitch x width)); ROOM lit room behind window film (ceiling gradient; p.z=1 blinds). layer: draw order on the face plane (pull toward the eye 6e-4 x depth per layer); z: offset along the normal (m). Face frame: right = up x n. col is linear cd/m^2 under the filter model (rgb / max x white-equivalent nits). True-source cores (channel stroke centres, tube axes, bulb / LED / dot points) write scene alpha 1 + w (contract P3-B1).',
    msdf: { image: MSDF.image, meta: 'seoul/signs/msdf-meta.js', size: MSDF.size, pxPerEm: MSDF.px, range: MSDF.range, median: 'max(min(r,g),min(max(r,g),b)) - 0.5, x range px' },
    faces: faceRecs, designs: designList,
    housings: D.boxes.map((b) => ({ c: b.c, r: b.r, n: b.n, half: [+b.hw.toFixed(3), +b.hh.toFixed(3), +b.hd.toFixed(3)], albedo: b.col, noFront: b.noFront, collide: b.collide })),
    scrollers: D.scrollers.map((s) => ({ id: s.id, c: r3(s.c), n: s.n, w: s.w, h: s.h, text: SCROLL_TEXT[s.row], speed: s.speed, cols: s.cols, rows: 16, phase: s.phase, rgb: s.rgb.map((v) => +v.toFixed(4)), nits: Math.round(s.nits) })),
    emitters: D.emitters.filter((e) => !e.screenKind), stats: D.stats,
  };
  const screens = {
    version: SIGNS_VERSION, programs: PROG, text: SCREEN_TEXT, bg: SCREEN_BG, contentGLSL: SCREEN_CONTENT_GLSL, panelGLSL: SCREEN_PANEL_GLSL,
    doc: 'emission = content(uv quantised to res) * ledPanel(uv*res) * louvre * band * nits; louvre = mix(0.35,1,sqrt(n.v)) * mix(1,0.45,smoothstep(0.35,0.9,v.y)); band = 1 - bandDepth*(0.5+0.5 sin(2pi(rowY/viewH * scanHz*0.011 + t*bandRate))); black level 0.0015. Playlist segments loop from phase; a cut darkens one frame by 85 %.',
    screens: D.screens.map((o) => ({ id: o.id, lot: o.lot, kind: o.kind, pos: o.pos, normal: o.normal, w: o.w, h: o.h, pitch: o.pitch, res: o.res, scanHz: o.scanHz,
      bandDepth: o.bandDepth, bandRate: +o.bandRate.toFixed(4), seed: +o.seedU.toFixed(4), nits: Math.round(o.nits), phase: +o.playlist.phase.toFixed(3), len: +o.playlist.len.toFixed(3),
      playlist: o.playlist.list.map((s) => ({ prog: s.prog, t0: +s.t0.toFixed(3), dur: +s.dur.toFixed(3), pal: s.pal.map((c) => c.map((v) => +v.toFixed(4))), text: s.text, seed: +s.seed.toFixed(4) })) })),
  };
  return { signs, screens };
}

// ---------------------------------------------------------------------------------------------------------------
// 9) GPU: fonts (screen / scroller text only), the face material, tiles, screens, scrollers
// ---------------------------------------------------------------------------------------------------------------
export const FONTS = [ // family (as drawn), file in seoul/fonts (renamed OFL subsets; see seoul/fonts/FONTS.txt)
  ['S2 BlackHan', 'S2-BlackHanSans.woff2'], ['S2 DoHyeon', 'S2-DoHyeon.woff2'], ['S2 Jua', 'S2-Jua.woff2'], ['S2 Brush', 'S2-BrushScript.woff2'],
  ['S2 Pen', 'S2-PenScript.woff2'], ['S2 Gothic', 'S2-GothicA1Black.woff2'], ['S2 Serif', 'S2-NotoSerifKR900.woff2'], ['S2 Sans', 'S2-NotoSansKR800.woff2'],
];
const FALLBACK = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
let fontsPromise = null;
export function loadFonts(base = './seoul/fonts/') {
  if (fontsPromise) return fontsPromise;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return (fontsPromise = Promise.resolve(false));
  // screens and scrollers only need three faces now (sign faces are MSDF)
  fontsPromise = Promise.all(FONTS.filter(([f]) => /BlackHan|DoHyeon|Gothic|Sans/.test(f)).map(([fam, file]) => new FontFace(fam, `url(${base}${file})`).load().then((f) => { document.fonts.add(f); return true; }, () => false)))
    .then((r) => r.every(Boolean));
  return fontsPromise;
}
function fitText(g, text, family, weight, x, y, w, h, opts = {}) {
  if (!text) return;
  let size = h * (opts.k ?? 0.78);
  g.font = `${weight || ''} ${size}px "${family}", ${FALLBACK}`;
  let m = g.measureText(text).width; let sx = 1;
  if (m > w) { sx = w / m; if (sx < 0.55) { size *= sx / 0.55; g.font = `${weight || ''} ${size}px "${family}", ${FALLBACK}`; m = g.measureText(text).width; sx = Math.min(1, w / m); } }
  g.save(); g.translate(x + w / 2, y + h / 2 + size * 0.04); g.scale(sx, 1);
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = opts.fill || '#fff'; g.fillText(text, 0, 0);
  g.restore();
}
function makeCanvas(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// --- sign faces: one MeshStandardMaterial; per-vertex element attributes; MSDF glyphs; alpha-to-coverage edges ---
const FACE_VERT_HEAD = /* glsl */`
attribute vec2 aUv; attribute vec3 aCol; attribute vec4 aAlb; attribute vec4 aK; attribute vec2 aF;
varying vec2 vSUv; varying vec3 vSCol; varying vec3 vSAlb; varying vec4 vSK;
uniform float uTime;`;
const FACE_VERT_BODY = /* glsl */`
  { float layer = floor(aK.x / 16.0);
    mvPosition.xyz *= 1.0 - layer * 6.0e-4;            // decal layers on the face plane: pull toward the eye (no z-fight to ~500 m)
    gl_Position = projectionMatrix * mvPosition;
    vSUv = aUv; vSAlb = aAlb.rgb; vSK = vec4(aK.x - layer * 16.0, aK.yzw);
    float fl = 1.0;
    if (aF.x > 0.0) { float tt = uTime * aF.x + aF.y * 37.0; float nz = fract(sin(floor(tt) * 12.9898 + aF.y * 78.233) * 43758.5453);
      fl = 1.0 - 0.7 * step(0.55, nz) * (0.6 + 0.4 * fract(tt * 3.7)); }
    vSCol = aCol * fl; }`;
const FACE_FRAG_HEAD = /* glsl */`
varying vec2 vSUv; varying vec3 vSCol; varying vec3 vSAlb; varying vec4 vSK;
uniform sampler2D uAtlas; uniform vec4 uAtlasP; uniform float uNit, uTime, uMS;
float sgMed(vec3 s){ return max(min(s.r, s.g), min(max(s.r, s.g), s.b)); }`;
const FACE_FRAG_BODY = /* glsl */`
  vec3 sgEm = vec3(0.0); float sgA = 1.0; float sgCore = 0.0;   // sgCore: true-source core weight (scene alpha = 1 + core)
  { int kind = int(vSK.x + 0.5);
    vec3 fN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    float facing = abs(dot(fN, normalize(vViewPosition)));
    // MSDF terms (sampled for every kind: uniform control flow for the derivatives)
    vec3 ms = texture2D(uAtlas, vSUv, -0.5).rgb;
    float sd = sgMed(ms) - 0.5;                                   // signed distance, range units (+ inside)
    vec2 tx = vSUv * uAtlasP.xy; vec2 fw = fwidth(tx); float tpp = max(max(fw.x, fw.y), 1e-5);   // atlas texels per screen px
    float dEm = sd * uAtlasP.z / uAtlasP.w;                       // em
    float emPx = uAtlasP.w / tpp;                                 // em size on screen, px
    float far = smoothstep(7.0, 2.5, emPx) * uMS;                 // too small to resolve: fade to the mean coverage (MSAA only)
    vec2 u = vSUv; vec2 sz = vSK.yz;
    if (kind == 0) {          // light-box ground: diffuser profile + LED rows
      vec2 c = u * 2.0 - 1.0; float ex = min(u.x, 1.0 - u.x) * sz.x, ey = min(u.y, 1.0 - u.y) * sz.y;
      float edge = smoothstep(0.0, 0.12, min(ex, ey));
      float prof = 0.7 + 0.5 * edge * (1.0 - 0.35 * c.y * c.y - 0.15 * c.x * c.x);
      float rows = 0.5 + 0.5 * cos(6.2831853 * u.y * sz.y / 0.12);
      prof *= 1.0 + mix(0.06, 0.32, 1.0 - facing) * (rows - 0.5);
      sgEm = vSCol * prof;
      if (vSK.w > 0.5) { float r = length(c); sgA = 1.0 - smoothstep(1.0 - fwidth(r), 1.0, r); }
    } else if (kind == 1) {   // flat panel (emissive only as a neon frame tube)
      sgEm = vSCol; sgCore = 0.6;
    } else if (kind == 6) {   // lit room behind film: ceiling light, optional blinds, darker frame
      float ex = min(u.x, 1.0 - u.x) * sz.x, ey = min(u.y, 1.0 - u.y) * sz.y;
      float prof = 0.72 + 0.5 * u.y * u.y;
      if (vSK.w > 0.5) prof *= 0.8 + 0.2 * step(0.35, fract(u.y * sz.y / 0.045));
      prof *= 0.55 + 0.45 * smoothstep(0.0, 0.06, min(ex, ey));
      sgEm = vSCol * prof;
    } else if (kind == 5) {   // bulb / LED border strip
      float pitch = vSK.y; float i = floor(u.x / pitch);
      vec2 f = vec2((fract(u.x / pitch) - 0.5) * pitch, (u.y - 0.5) * vSK.w);
      float rad = vSK.z > 1.5 ? 0.006 : 0.010; float d = length(f);          // 2 cm bulbs, 1.2 cm LEDs: hot points
      // pixel-footprint filtered point: an anti-aliased disc while it covers a pixel, then a one-pixel tent carrying the
      // disc's energy (the peak survives, so a far bulb run still reads as a string of points, not a dim strip)
      float mpp = max(fwidth(u.x), 1.0e-5), r0 = rad * 0.72;
      float core = r0 > mpp ? clamp((r0 - d) / mpp + 0.5, 0.0, 1.0) : max(0.0, 1.0 - d / mpp) * min(1.0, 3.14159 * r0 * r0 / (mpp * mpp));
      float cmean = 1.634 * rad * rad / (pitch * vSK.w);                       // pi (0.72 r)^2 / cell: several bulbs per pixel
      float on = 1.0;
      if (vSK.z > 0.5 && vSK.z < 1.5) on = step(0.5, mod(i + floor(uTime * 5.0), 3.0));             // chase
      if (vSK.z > 1.5) on = 0.35 + 0.65 * step(0.5, mod(i + floor(uTime * 8.0), 4.0) * 0.5);          // LED run
      float ppp = pitch / max(fwidth(u.x), 1e-5);
      float unres = smoothstep(1.5, 0.75, ppp);
      sgEm = vSCol * mix(core * on, cmean * (vSK.z > 0.5 ? 0.66 : 1.0), unres);
      sgCore = clamp(core * 2.0, 0.0, 1.0) * on * (1.0 - unres);
    } else {                  // glyphs
      float cov;
      if (kind == 3) {        // neon tube on the outline
        float hw = vSK.y; float dc = dEm - vSK.z; float dd = hw - abs(dc);    // tube centre inset vSK.z em inside the outline
        cov = clamp(dd * emPx + 0.5, 0.0, 1.0);
        float e = cos(1.5707963 * clamp(abs(dc) / hw, 0.0, 1.0)); e *= e;     // cos^2 tube: the core 3x the glass sleeve
        sgEm = vSCol * (1.0 + 2.0 * e) / 3.0;
        sgCore = smoothstep(0.55, 0.9, e) * (1.0 - far);
        cov = mix(cov, vSK.w * 0.35, far);
      } else {
        cov = clamp(sd * uAtlasP.z / tpp + 0.5, 0.0, 1.0);
        cov = mix(cov, vSK.w, far);
        if (kind == 2) {
          float pr = 1.0;
          float res = smoothstep(10.0, 28.0, emPx);                                  // stroke profile resolved on screen
          if (vSK.y > 1.5) {         // script neon: the stroke is the tube; cos^2 across it, core 3x the sleeve
            float e = sin(1.5707963 * clamp(dEm / 0.028, 0.0, 1.0)); e *= e;
            pr = mix(0.6, (1.0 + 2.0 * e) / 3.0, res); sgCore = mix(0.4, smoothstep(0.55, 0.9, e), res);
          } else if (vSK.y > 0.5) {  // LED channel letter: modules behind an acrylic face, 1.0 at the stroke centre -> 0.45 at the edge
            float e = smoothstep(0.0, 0.04, dEm);                                    // bold sign faces: stroke half-width 0.035-0.08 em
            pr = mix(0.78, 0.45 + 0.55 * e, res); sgCore = mix(0.45, smoothstep(0.022, 0.038, dEm), res);
          }
          sgEm = vSCol * pr;
        } else {              // exposed LED dots inside the letter body
          float pt = vSK.y * uAtlasP.w; vec2 f = fract(tx / pt) - 0.5;
          float dotm = 1.0 - smoothstep(0.2, 0.33, length(f)), unres = smoothstep(4.0, 1.5, pt / tpp);
          sgEm = vSCol * mix(dotm, 0.22, unres); sgCore = dotm * (1.0 - unres);
        }
      }
      sgA = cov;
    }
    if (uMS < 0.5) { if (sgA < 0.5) discard; sgA = 1.0; } else if (sgA < 0.02) discard;
    // contract P3-B1 (for A's white cores): the scene target's alpha is 1 + w on true-source cores (channel-letter stroke
    // centres, neon tube axes, bulb and LED points), w in [0, 1]; 1 everywhere else. Only fully covered fragments carry it.
    float sgOn = step(1.0e-4, max(max(vSCol.r, vSCol.g), vSCol.b));
    diffuseColor = vec4(vSAlb, sgA + sgCore * sgOn * step(0.98, sgA)); }`;

// --- LED screens: one instanced mesh; static + per-frame instance attributes ---
const SCR_VERT_HEAD = /* glsl */`
attribute vec4 iP; attribute vec4 iA; attribute vec4 iR; attribute vec4 iB; attribute vec4 iD; attribute vec4 iE; attribute vec3 iC0; attribute vec3 iC1; attribute vec3 iC2;
varying vec2 vQUv; varying vec4 vQ0; varying vec4 vQ1; varying vec4 vQ2; varying vec3 vQC0; varying vec3 vQC1; varying vec3 vQC2; varying vec3 vQW; varying vec3 vQN;`;
const SCR_FRAG_HEAD = /* glsl */`
varying vec2 vQUv; varying vec4 vQ0; varying vec4 vQ1; varying vec4 vQ2; varying vec3 vQC0; varying vec3 vQC1; varying vec3 vQC2; varying vec3 vQW; varying vec3 vQN;
uniform float uNit, uMoire, uViewH, uBlack;
${SCREEN_CONTENT_GLSL}
${SCREEN_PANEL_GLSL}`;
const SCR_FRAG_BODY = /* glsl */`
  vec3 scrEm;
  { gProg = int(vQ0.x + 0.5); gT = vQ0.y; gCut = vQ0.z; gSeed = vQ0.w; gRes = vQ1.xy; gRow = vQ2.zw; gC0 = vQC0; gC1 = vQC1; gC2 = vQC2;
    vec2 cell = vQUv * gRes; vec2 id = floor(cell);
    vec3 col = content((id + 0.5) / gRes, gT);
    vec3 m = ledPanel(cell, uMoire);
    vec3 V = normalize(cameraPosition - vQW); float nd = max(dot(vQN, V), 0.0);
    float ang = mix(0.35, 1.0, sqrt(nd)) * mix(1.0, 0.45, smoothstep(0.35, 0.9, V.y));
    float band = 1.0 - vQ1.w * (0.5 + 0.5 * sin(6.2831853 * (gl_FragCoord.y / uViewH * vQ2.x + uT * vQ2.y)));
    scrEm = (col * m * ang * band + vec3(uBlack)) * vQ1.z * uNit;
    diffuseColor.rgb = vec3(0.012); }`;

export async function build(layout, ctx = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const nit = { value: ctx.nitScale ?? ctx.NIT ?? NIT_SCALE };   // world-seoul passes nitScale = NITS (0.1 scene units per cd/m^2)
  const uTime = { value: 0 }, uMS = { value: 1 };
  const D = buildData(layout, ctx);
  const group = new THREE.Group(); group.name = 'seoul-signs';
  const emitters = D.emitters;
  const browser = typeof document !== 'undefined';

  // --- MSDF atlas (browser only: node builds geometry + emitters without textures) ---
  let atlas = null;
  if (browser && ctx.atlas !== false) {
    const url = (ctx.signsBase ?? './seoul/signs/') + 'msdf.png';
    atlas = await new Promise((res) => {
      const tex = new THREE.TextureLoader().load(url, () => res(tex), undefined, () => { console.warn('seoul-signs: atlas missing', url); res(tex); });
      setTimeout(() => res(tex), ctx.atlasTimeout ?? 15000);
    });
    atlas.flipY = false; atlas.colorSpace = THREE.NoColorSpace; atlas.generateMipmaps = true; atlas.premultiplyAlpha = false;
    atlas.minFilter = THREE.LinearMipmapLinearFilter; atlas.magFilter = THREE.LinearFilter;
    atlas.anisotropy = ctx.anisotropy ?? (ctx.renderer ? Math.min(16, ctx.renderer.capabilities.getMaxAnisotropy()) : 16);
    atlas.needsUpdate = true;
  }
  const uAtlas = { value: atlas }, uAtlasP = { value: new THREE.Vector4(MSDF.size[0], MSDF.size[1], MSDF.range, MSDF.px) };

  const faceMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0, flatShading: true, alphaToCoverage: true, fog: false });
  faceMat.name = 'seoul-signs-faces';
  faceMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uAtlas, uAtlasP, uNit: nit, uTime, uMS });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${FACE_VERT_HEAD}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${FACE_VERT_BODY}`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${FACE_FRAG_HEAD}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FACE_FRAG_BODY}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance = sgEm * uNit;');
  };
  faceMat.customProgramCacheKey = () => 'seoul-signs-msdf-2';

  // --- tiles (80 m): faces + housings, so the city's signs frustum-cull ---
  const TILE = ctx.tileSize ?? 80; const tiles = new Map();
  const tileOf = (p) => { const k = `${Math.floor(p[0] / TILE)},${Math.floor(p[2] / TILE)}`; let t = tiles.get(k); if (!t) { t = { key: k, faces: [], nq: 0, h: [] }; tiles.set(k, t); } return t; };
  for (const f of D.faces) { const t = tileOf(f.c); t.faces.push(f); t.nq += f.els.length; }
  const colP = [];
  const boxInto = (H, b, P) => {
    const { c, r, n, hw, hh, hd, col } = b;
    const Pt = (sx, sy, sz) => [c[0] + r[0] * sx * hw + n[0] * sz * hd, c[1] + sy * hh, c[2] + r[2] * sx * hw + n[2] * sz * hd];
    const Fc = [[[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], n], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1], [-n[0], 0, -n[2]]],
      [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1], [r[0], 0, r[2]]], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-r[0], 0, -r[2]]],
      [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1], [0, 1, 0]], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [0, -1, 0]]];
    Fc.forEach((fc, i) => { const q = fc.slice(0, 4).map((s) => Pt(...s));
      if (H && !(b.noFront && i === 0)) { H.push(q, col); }
      if (P) for (const j of [0, 1, 2, 0, 2, 3]) P.push(...q[j]); });
  };
  // housings ride in the face meshes as unlit PANEL quads (one material, one draw per tile: phase 3 perf, was 2 per tile)
  for (const b of D.boxes) { const t = tileOf(b.c); const n0 = t.h.length; boxInto(t.h, b, b.collide ? colP : null); t.nq += (t.h.length - n0) / 2; }
  // fill typed arrays directly (two passes: count, then write) — this runs once at load on the phone
  for (const t of tiles.values()) {
    if (!t.nq) continue;
    const nv = t.nq * 4, T = t.f = { p: new Float32Array(nv * 3), uv: new Float32Array(nv * 2), col: new Float32Array(nv * 3), alb: new Uint8Array(nv * 4),
      k: new Float32Array(nv * 4), fl: new Float32Array(nv * 2), idx: nv > 65535 ? new Uint32Array(t.nq * 6) : new Uint16Array(t.nq * 6), n: nv };
    let v = 0, ii = 0;
    for (const f of t.faces) {
      const m = f.m; const rr = cross(UP, m); const rl = Math.hypot(...rr) || 1; const rx = rr[0] / rl, rz = rr[2] / rl;
      for (const e of f.els) {
        const z = e.z || 0, a0 = Math.round(Math.min(1, e.alb[0]) * 255), a1 = Math.round(Math.min(1, e.alb[1]) * 255), a2 = Math.round(Math.min(1, e.alb[2]) * 255), kk = e.k + 16 * (e.layer || 0);
        T.idx[ii++] = v; T.idx[ii++] = v + 1; T.idx[ii++] = v + 2; T.idx[ii++] = v; T.idx[ii++] = v + 2; T.idx[ii++] = v + 3;
        for (let j = 0; j < 4; j++, v++) {
          const x = e.q[j * 2], y = e.q[j * 2 + 1];
          T.p[v * 3] = f.c[0] + rx * x + m[0] * z; T.p[v * 3 + 1] = f.c[1] + y; T.p[v * 3 + 2] = f.c[2] + rz * x + m[2] * z;
          T.uv[v * 2] = e.uv[j * 2]; T.uv[v * 2 + 1] = e.uv[j * 2 + 1];
          T.col[v * 3] = e.col[0]; T.col[v * 3 + 1] = e.col[1]; T.col[v * 3 + 2] = e.col[2];
          T.alb[v * 4] = a0; T.alb[v * 4 + 1] = a1; T.alb[v * 4 + 2] = a2; T.alb[v * 4 + 3] = 255;
          T.k[v * 4] = kk; T.k[v * 4 + 1] = e.p[0]; T.k[v * 4 + 2] = e.p[1]; T.k[v * 4 + 3] = e.p[2];
          T.fl[v * 2] = f.flk[0]; T.fl[v * 2 + 1] = f.flk[1];
        }
      }
    }
    for (let i = 0; i < t.h.length; i += 2) {   // housing quads: kind PANEL, no emission, albedo = the housing colour
      const q = t.h[i], c = t.h[i + 1], a0 = Math.round(c[0] * 255), a1 = Math.round(c[1] * 255), a2 = Math.round(c[2] * 255);
      T.idx[ii++] = v; T.idx[ii++] = v + 1; T.idx[ii++] = v + 2; T.idx[ii++] = v; T.idx[ii++] = v + 2; T.idx[ii++] = v + 3;
      for (let j = 0; j < 4; j++, v++) { T.p.set(q[j], v * 3); T.alb[v * 4] = a0; T.alb[v * 4 + 1] = a1; T.alb[v * 4 + 2] = a2; T.alb[v * 4 + 3] = 255; T.k[v * 4] = K.PANEL; T.k[v * 4 + 1] = 1; T.k[v * 4 + 2] = 1; }
    }
  }
  const meshes = []; let tris = 0;
  for (const t of [...tiles.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    if (t.f) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(t.f.p, 3));
      g.setAttribute('aUv', new THREE.BufferAttribute(t.f.uv, 2));
      g.setAttribute('aCol', new THREE.BufferAttribute(t.f.col, 3));
      g.setAttribute('aAlb', new THREE.BufferAttribute(t.f.alb, 4, true));
      g.setAttribute('aK', new THREE.BufferAttribute(t.f.k, 4));
      g.setAttribute('aF', new THREE.BufferAttribute(t.f.fl, 2));
      g.setIndex(new THREE.BufferAttribute(t.f.idx, 1));
      g.computeBoundingSphere(); g.computeBoundingBox();
      // free the CPU copies once on the GPU (~45 MB of renderer memory on the phone; node never uploads, so exports keep them)
      if (ctx.keepArrays !== true) { const free = function () { this.array = null; }; for (const at of Object.values(g.attributes)) at.onUpload(free); g.index.onUpload(free); }
      const m = new THREE.Mesh(g, faceMat); m.name = `signs-faces-${t.key}`; m.matrixAutoUpdate = false;
      m.onBeforeRender = (renderer) => { const rt = renderer.getRenderTarget(); uMS.value = rt && rt.samples > 0 ? 1 : 0; };
      group.add(m); meshes.push(m); tris += t.f.idx.length / 3;
    }
  }
  tiles.clear();   // the closures below keep this scope alive: drop the staging arrays (the meshes own their attributes)
  // collider triangles for the integrator (blades, boxes, stands, cabinets): not added to any collider here
  const collider = new THREE.BufferGeometry(); collider.setAttribute('position', new THREE.Float32BufferAttribute(colP, 3));

  // --- text atlases for screens + scrollers (Canvas2D, small) ---
  const TROWS = SCREEN_TEXT.length, TW = 1024, TH = 64;
  const tcan = makeCanvas(TW, TROWS * TH); const textTex = tcan ? new THREE.CanvasTexture(tcan) : null;
  const SROWS = SCROLL_TEXT.length, SW = 2048, SH = 16;
  const scan = makeCanvas(SW, SROWS * SH); const scrollTex = scan ? new THREE.CanvasTexture(scan) : null;
  if (textTex) { textTex.flipY = false; textTex.colorSpace = THREE.NoColorSpace; textTex.generateMipmaps = false; textTex.minFilter = THREE.LinearFilter; }
  if (scrollTex) { scrollTex.flipY = false; scrollTex.colorSpace = THREE.NoColorSpace; scrollTex.generateMipmaps = false; scrollTex.minFilter = THREE.NearestFilter; scrollTex.magFilter = THREE.NearestFilter; }
  const paintText = () => {
    if (tcan) {
      const g = tcan.getContext('2d'); g.clearRect(0, 0, TW, TROWS * TH);
      SCREEN_TEXT.forEach((s, i) => {
        if (i === TROWS - 1) { for (let k = 0; k < 11; k++) fitText(g, s[k], 'S2 Gothic', '', k * TW / 11, i * TH, TW / 11, TH, { k: 0.95 }); }
        else fitText(g, s, i % 2 ? 'S2 Sans' : 'S2 BlackHan', i % 2 ? '800' : '', 8, i * TH + 3, TW - 16, TH - 6, { k: 0.8 });
      });
      textTex.needsUpdate = true;
    }
    if (scan) {
      const g = scan.getContext('2d'); g.clearRect(0, 0, SW, SROWS * SH); g.textBaseline = 'middle';
      SCROLL_TEXT.forEach((s, i) => { g.font = `15px "S2 DoHyeon", ${FALLBACK}`; g.fillStyle = '#fff'; g.fillText(s + s + s, 0, i * SH + SH / 2 + 1); });
      const im = g.getImageData(0, 0, SW, SROWS * SH); for (let i = 3; i < im.data.length; i += 4) im.data[i] = im.data[i] > 110 ? 255 : 0; g.putImageData(im, 0, 0);
      scrollTex.needsUpdate = true;
    }
  };

  // --- scrollers: one mesh ---
  if (D.scrollers.length) {
    const p = [], uv = [], aS = [], aC = [];
    for (const s of D.scrollers) {
      const rr = cross(UP, s.n), c = s.c, f = filt(s.rgb), k = s.nits;   // filter model: white-equivalent dot nits
      const P = [add3(add3(c, rr, -s.w / 2), UP, -s.h / 2), add3(add3(c, rr, s.w / 2), UP, -s.h / 2), add3(add3(c, rr, s.w / 2), UP, s.h / 2), add3(add3(c, rr, -s.w / 2), UP, s.h / 2)];
      const U = [[0, 0], [1, 0], [1, 1], [0, 1]];
      for (const i of [0, 1, 2, 0, 2, 3]) { p.push(...P[i]); uv.push(...U[i]); aS.push(s.row, s.speed, s.cols, s.phase); aC.push(f[0] * k, f[1] * k, f[2] * k); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 4)); g.setAttribute('aC', new THREE.Float32BufferAttribute(aC, 3)); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: SCROLL_VERT, fragmentShader: SCROLL_FRAG, extensions: { derivatives: true },
      uniforms: { uText: { value: scrollTex }, uT: uTime, uRows: { value: SROWS }, uTexW: { value: SW }, uNit: nit } }));
    m.name = 'signs-scrollers'; m.matrixAutoUpdate = false; group.add(m); meshes.push(m); tris += p.length / 9;
  }

  // --- LED screens: one instanced mesh (perf #6: was one material + draw per screen) ---
  const S = D.screens, NS = S.length;
  const scrU = { uNit: nit, uMoire: { value: ctx.moire ?? 0.6 }, uViewH: { value: 1080 }, uBlack: { value: 0.0015 }, uText: { value: textTex }, uRows: { value: TROWS }, uT: uTime, uBg: { value: SCREEN_BG } };
  let scrMesh = null, dyn = null;
  if (NS) {
    const plane = new THREE.PlaneGeometry(1, 1);
    const ig = new THREE.InstancedBufferGeometry(); ig.index = plane.index;
    for (const k of ['position', 'normal', 'uv']) ig.setAttribute(k, plane.attributes[k]);
    const A = (name, size, fill, dynamic = false) => { const arr = new Float32Array(NS * size); S.forEach((o, i) => fill(o, arr, i * size)); const at = new THREE.InstancedBufferAttribute(arr, size); if (dynamic) at.setUsage(THREE.DynamicDrawUsage); ig.setAttribute(name, at); return at; };
    A('iP', 4, (o, a, j) => { a[j] = o.pos[0]; a[j + 1] = o.pos[1]; a[j + 2] = o.pos[2]; a[j + 3] = o.nits; });
    A('iA', 4, (o, a, j) => { a[j] = o.normal[0]; a[j + 1] = o.normal[2]; a[j + 2] = o.w; a[j + 3] = o.h; });
    A('iR', 4, (o, a, j) => { a[j] = o.res[0]; a[j + 1] = o.res[1]; a[j + 2] = o.seedU; a[j + 3] = o.bandDepth; });
    A('iB', 4, (o, a, j) => { a[j] = o.scanHz * (ctx.readout ?? 0.011); a[j + 1] = o.bandRate; });
    dyn = { iD: A('iD', 4, () => {}, true), iE: A('iE', 4, () => {}, true), iC0: A('iC0', 3, () => {}, true), iC1: A('iC1', 3, () => {}, true), iC2: A('iC2', 3, () => {}, true) };
    ig.instanceCount = NS;
    const smat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.55, metalness: 0, fog: false });
    smat.name = 'seoul-screens';
    smat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, scrU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${SCR_VERT_HEAD}`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(iA.x, 0.0, iA.y);')
        .replace('#include <begin_vertex>', `vec3 qn = vec3(iA.x, 0.0, iA.y); vec3 qr = vec3(iA.y, 0.0, -iA.x);
  vec3 transformed = iP.xyz + qr * (position.x * iA.z) + vec3(0.0, position.y * iA.w, 0.0) + qn * 0.05;
  vQUv = uv; vQ0 = vec4(iD.xyz, iR.z); vQ1 = vec4(iR.xy, iP.w, iR.w); vQ2 = vec4(iB.xy, iD.w, iE.x); vQC0 = iC0; vQC1 = iC1; vQC2 = iC2; vQW = transformed; vQN = qn;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${SCR_FRAG_HEAD}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${SCR_FRAG_BODY}`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance = scrEm;');
    };
    smat.customProgramCacheKey = () => 'seoul-screens-2';
    scrMesh = new THREE.Mesh(ig, smat); scrMesh.name = 'signs-screens'; scrMesh.frustumCulled = false; scrMesh.matrixAutoUpdate = false;
    scrMesh.onBeforeRender = (renderer) => { const rt = renderer.getRenderTarget(); scrU.uViewH.value = rt ? rt.height : renderer.domElement.height; };
    group.add(scrMesh); meshes.push(scrMesh); tris += 2 * NS;
  }

  function update(t, camPos) {
    uTime.value = t;
    if (!dyn) return;
    const d = dyn.iD.array, e = dyn.iE.array, c0 = dyn.iC0.array, c1 = dyn.iC1.array, c2 = dyn.iC2.array;
    for (let i = 0; i < NS; i++) {
      const o = S[i]; const st = screenState(o, t); const sg = st.seg;
      d[i * 4] = sg.prog; d[i * 4 + 1] = st.lt; d[i * 4 + 2] = st.cut; d[i * 4 + 3] = sg.text[0]; e[i * 4] = sg.text[1];
      c0.set(sg.pal[0], i * 3); c1.set(sg.pal[1], i * 3); c2.set(sg.pal[2], i * 3);
      const em = o.em; em.rgb[0] = st.rgb[0]; em.rgb[1] = st.rgb[1]; em.rgb[2] = st.rgb[2]; em.nits = Math.round(st.nits + 0.5);
    }
    for (const k in dyn) dyn[k].needsUpdate = true;
    void camPos;
  }

  let fontsReady = false;
  paintText();
  if (ctx.loadFonts !== false && browser) loadFonts(ctx.fontBase).then((ok) => { fontsReady = ok; paintText(); if (ctx.onFonts) ctx.onFonts(ok); });

  const gpuBytes = meshes.reduce((a, m) => a + Object.values(m.geometry.attributes).reduce((s, at) => s + at.array.byteLength, 0) + (m.geometry.index ? m.geometry.index.array.byteLength : 0), 0)
    + (atlas ? MSDF.size[0] * MSDF.size[1] * 4 * 4 / 3 : 0) + TW * TROWS * TH * 4 + SW * SROWS * SH * 4;
  const stats = { ...D.stats, drawCalls: meshes.length, tris: Math.round(tris), gpuMB: +(gpuBytes / 1048576).toFixed(1),
    buildMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) };
  update(0);
  return {
    group, emitters, update, specs: D.specs, screens: S, stats, atlas, collider,
    get data() { return buildData(layout, ctx); },   // rebuilt on demand: the ~100k face elements don't stay resident
    setNitScale(k) { nit.value = k; }, get nitScale() { return nit.value; },
    setMoire(k) { scrU.uMoire.value = k; },
    get fontsReady() { return fontsReady; }, repaint: paintText,
    exportData: () => exportData(layout, ctx),
    dispose() { group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); collider.dispose(); atlas?.dispose(); textTex?.dispose(); scrollTex?.dispose(); },
  };
}

export const seoulSigns = { build, buildData, exportData, generateSigns, signStats, designFace, loadFonts, NIT_SCALE, NITS, CENSUS, SHIPPED, PUSH_BY_KIND, K };
export default seoulSigns;
