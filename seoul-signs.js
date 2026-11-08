// seoul-signs.js — S2: Hongdae signs and LED video screens (contracts L1 / L2 / L3 in review/SEOUL-BUILD.md).
//
//   import { seoulSigns } from './seoul-signs.js';
//   const signs = seoulSigns.build(layout, { seed, neonPush, nitScale, fontBase, quality });
//   scene.add(signs.group);  lights.attach(world, signs.emitters);  each frame: signs.update(t, camPos);
//
// What it makes (all seeded and deterministic; geometry, counts and emitters do not depend on fonts or the canvas):
//   signs   : 10 types: fascia light box, channel letters, vertical blade stack (돌출), window vinyl, neon tube,
//             rooftop sign, sidewalk standing box (입간판), LED dot scroller (전광판), round projecting box, flex banner
//             (unlit). Invented shop names in real Korean, typeset per sign type in OFL faces (seoul/fonts).
//   screens : LED video panels with procedural invented content (no brands / IP), rendered as a real LED panel:
//             SMD pixel grid up close, moire at mid range, louvre angle falloff, rolling-shutter refresh bands, and an
//             animated mean colour on the emitter record so S3 can spill it onto the street.
//   colour  : the T5 census mix, recoloured by `neonPush` 0..1 per street (faces and tubes only; geometry, counts and
//             lit share stay census). See CENSUS / SHIPPED below.
//   units   : emitters carry luminance in nits (cd/m^2). Materials output nits * nitScale in scene radiance
//             (default NIT_SCALE = 0.01, i.e. 1.0 scene = 100 nits). signs.setNitScale(k) retunes at runtime.
//
// Emitter record (L3): { id, pos, normal, w, h, rgb (linear, luminance-normalised: Y = 1), nits (mean over w*h),
//                        kind, flicker?, animated }. Animated records (screens, scrollers) are mutated in place by update().
import * as THREE from 'three';
import { Rng } from './rng.js';

export const NIT_SCALE = 0.01;
export const SIGNS_VERSION = 1;

// ---------------------------------------------------------------------------------------------------------------
// 1) colour: census vs shipped (T5 table), by category
// ---------------------------------------------------------------------------------------------------------------
export const COLOR_CATS = ['white', 'red', 'blue', 'ygo', 'pink', 'cyan', 'violet'];
export const CENSUS =  [0.45, 0.20, 0.15, 0.12, 0.04, 0.03, 0.01];
export const SHIPPED = [0.25, 0.14, 0.10, 0.08, 0.20, 0.14, 0.09];
export const NEON_SHARE = [0.04, 0.15];        // neon-tube share of nightlife-able signs at push 0 / 1
// default push by street kind (T5: hero streets 1.0, side alleys 0.4); street.neonPush overrides
export const PUSH_BY_KIND = { club: 1.0, walking: 1.0, main: 0.6, alley: 0.4 };
// how strongly a tenant takes the push: nightlife soaks it up, convenience stores keep chain colours
const USE_PUSH = { club: 1.35, bar: 1.3, pocha: 1.2, karaoke: 1.3, motel: 1.25, pc: 1.0, hotel: 0.8, cafe: 0.9, restaurant: 0.7,
  shop: 0.7, office: 0.4, conv: 0.0 };

const srgb = (h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };     // THREE.Color hex -> linear
const HEX = {
  white: '#f2f6ff', warm: '#ffe0b0', red: '#ff2414', blue: '#1e56ff', yellow: '#ffc414', orange: '#ff7410', green: '#14d860',
  pink: '#ff3c9c', magenta: '#ff28d2', cyan: '#18e4ff', teal: '#10d8b0', violet: '#8a3cff', amber: '#ffa010',
};
// category -> concrete light colours (weights)
const CAT_HUES = {
  white: [['white', 0.6], ['warm', 0.4]], red: [['red', 1]], blue: [['blue', 1]],
  ygo: [['yellow', 0.4], ['orange', 0.35], ['green', 0.25]], pink: [['pink', 0.6], ['magenta', 0.4]],
  cyan: [['cyan', 0.65], ['teal', 0.35]], violet: [['violet', 1]],
};
export const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const norm1 = (c) => { const y = Math.max(lum(c), 1e-4); return [c[0] / y, c[1] / y, c[2] / y]; };

// luminance by type (nits, the lit face / tube surface, not the rect mean). G5 / L5: channel 300-1500, boxes 150-600.
export const NITS = {
  lightbox: [300, 600], lightboxColour: [150, 350], channel: [400, 1500], channelColour: [300, 800],
  neon: [900, 2200], window: [40, 120], scroller: [400, 900], screen: [350, 700], screenSmall: [250, 500], banner: [0, 0],
};
// share of the rect that actually emits, for the emitter's mean nits
const COVER = { lightbox: 0.92, channel: 0.42, neon: 0.13, window: 0.35, scroller: 0.3, screen: 1 };

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
  club: ['클럽', '라운지', '하우스', 'CLUB', 'LOUNGE'],
  bar: ['호프', '펍', '술집', '이자카야', '칵테일바', '와인바', '감성주점', '맥주집', 'BAR', 'PUB'],
  pocha: ['포차', '포장마차', '실내포차', '꼬치', '닭발', '오뎅바', '전집', '막걸리'],
  restaurant: ['삼겹살', '갈비', '곱창', '막창', '닭갈비', '족발', '보쌈', '국밥', '김밥', '분식', '떡볶이', '냉면', '칼국수', '마라탕',
    '라멘', '돈까스', '치킨', '횟집', '쌀국수', '부대찌개', '고기집', '숯불구이'],
  cafe: ['카페', '커피', '디저트', '베이커리', '브런치', '보드게임카페', '룸카페', '만화카페', 'CAFE', 'COFFEE', 'BAKERY'],
  shop: ['소품샵', '안경', '화장품', '휴대폰', '네일', '헤어', '미용실', '셀프사진관', '타투', '빈티지', '문구', 'SHOP', 'STUDIO'],
  conv: ['편의점', '마트', '24시 편의점'],
  karaoke: ['코인노래방', '노래연습장', '노래방', '코인노래연습장'],
  pc: ['PC방', 'PC CAFE', '게임존', '오락실', '이스포츠'],
  motel: ['모텔', '무인텔', 'MOTEL', 'HOTEL'],
  hotel: ['호텔', '게스트하우스', 'HOTEL', 'GUEST HOUSE', '스테이'],
  office: ['학원', '부동산', '세무회계', '법무사', '치과', '의원', '약국', '연습실', '댄스학원', '실용음악학원', '스튜디오', '공방'],
};
// upper-floor tenants (what sits above the ground-floor shop), by building use
const UPPER_USES = {
  club: ['bar', 'karaoke', 'pc', 'office'], bar: ['bar', 'karaoke', 'pocha', 'pc', 'office'], pocha: ['bar', 'karaoke', 'office'],
  restaurant: ['restaurant', 'bar', 'karaoke', 'pc', 'office', 'cafe'], cafe: ['cafe', 'office', 'shop', 'bar'],
  shop: ['office', 'cafe', 'shop', 'karaoke'], conv: ['pc', 'karaoke', 'office', 'restaurant'], karaoke: ['karaoke', 'pc', 'bar', 'office'],
  pc: ['pc', 'karaoke', 'office'], motel: ['motel'], hotel: ['hotel'], office: ['office', 'office', 'cafe', 'restaurant'],
};
const TAGS = ['24시', '영업중', 'OPEN', '단체석', '생맥주', '무한리필', '포장 가능', '심야영업', '새벽까지', '예약 환영', '주차 가능',
  '1인석', 'SINCE 2009', '본점', '2호점', '맛집', '신장개업', '연중무휴'];
const NEON_WORDS = ['술', '오늘 밤', '한잔 해', '취하고 싶은 밤', '사랑해', '청춘', 'OPEN', 'BAR', 'LOVE', 'TONIGHT', '포차', '노래',
  'HAPPY HOUR', '짠', '낭만', '여기야', 'GOOD VIBES', '어서와'];
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

// lit share at ~midnight by tenant use (T5 census: 20-30 % of signs unlit; Hongdae nightlife keeps its own lit)
const LIT_P = { club: 0.97, bar: 0.95, pocha: 0.95, karaoke: 0.96, pc: 0.95, motel: 0.97, hotel: 0.9, conv: 1.0, restaurant: 0.75,
  cafe: 0.6, shop: 0.45, office: 0.15 };
const NIGHT_USES = new Set(['club', 'bar', 'pocha', 'karaoke', 'motel']);

// ---------------------------------------------------------------------------------------------------------------
// 4) the generator: layout -> sign specs (pure data; node-testable). A spec is one physical sign.
//    spec: { id, type, lot, use, lit, cat, hue, nits, flicker?, text: {...}, font, geo: {...}, design: {...} }
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

function makeName(r, use, latinBias) {
  const w = pick(r, USE_WORDS[use] || USE_WORDS.shop); const latinWord = /^[A-Z0-9 ]+$/.test(w);
  const latin = latinWord || r.next() < latinBias;
  if (latin) { const n = pick(r, NAME_EN); return { main: latinWord ? `${n} ${w}` : n, sub: latinWord ? '' : w }; }
  const a = pick(r, NAME_A);
  const form = r.next();
  if (form < 0.45) return { main: a + w.replace(/ /g, ''), sub: '' };       // 달빛포차
  if (form < 0.8) return { main: a, sub: w };                                 // 달빛 / 포차 (category set smaller)
  return { main: `${a} ${w}`, sub: '' };
}
const fakePhone = (r) => `02-0${Math.floor(r.next() * 90 + 10)}-${String(Math.floor(r.next() * 9000 + 1000))}`; // 02-0xx: no real exchange

// colour for one sign: u (census draw) and the push of its street/use; returns { cat, hue, rgb }
function signColour(uCat, uHue, push, use) {
  const p = Math.min(1, push * (USE_PUSH[use] ?? 0.8));
  const cat = COLOR_CATS[invCdf(uCat, mixDist(p))];
  const hue = pickW(uHue, CAT_HUES[cat]);
  return { cat, hue, rgb: srgb(HEX[hue]) };
}

export function generateSigns(layout, opts = {}) {
  const seed = (opts.seed ?? 0x5e0a1) >>> 0, pushOverride = opts.neonPush, pushScale = opts.neonPushScale ?? 1;
  const streets = new Map((layout.streets || []).map((s) => [s.id, s]));
  const specs = [], screens = [];
  for (const lot of layout.lots || []) {
    const st = streets.get(lot.street) || { kind: 'alley' };
    const push = Math.max(0, Math.min(1, (pushOverride ?? st.neonPush ?? PUSH_BY_KIND[st.kind] ?? 0.4) * pushScale));
    const r = new Rng(seed ^ hashStr(lot.id));           // geometry stream (never depends on push)
    const rc = new Rng((seed * 31 + 7) ^ hashStr(lot.id + '#c')); // colour stream (fixed draws per sign)
    const F = facadeFrame(lot);
    const nFloors = Math.max(1, lot.floors | 0);
    // tenants per floor: 0 = ground (lot.use), basement club stays in the ground sign
    const tenants = [];
    for (let f = 0; f < nFloors; f++) {
      const use = f === 0 ? lot.use : pick(r, UPPER_USES[lot.use] || UPPER_USES.office);
      const name = makeName(r, use, use === 'club' ? 0.6 : use === 'cafe' ? 0.35 : use === 'shop' ? 0.4 : 0.12);
      const lit = r.next() < (LIT_P[use] ?? 0.5);
      tenants.push({ f, use, name, lit, phone: fakePhone(r), tag: pick(r, TAGS) });
    }
    if (lot.use === 'hotel' || lot.use === 'motel') for (const t of tenants) { t.use = lot.use; t.name = tenants[0].name; t.lit = tenants[0].lit; }
    let k = 0;
    const add = (type, t, geo, extra = {}) => {
      // fixed colour draws per sign, whatever the push, so geometry/count/lit never move with push
      const uCat = rc.next(), uHue = rc.next(), uNeon = rc.next(), uNit = rc.next(), uFlk = rc.next(), uAcc = rc.next();
      const c = signColour(uCat, uHue, push, t.use);
      const nightlife = NIGHT_USES.has(t.use) || t.use === 'restaurant' && lot.use === 'pocha';
      const pn = Math.min(1, push * (USE_PUSH[t.use] ?? 0.8));
      let style = type;
      // neon-tube share (T5: <5 % census -> 15 % hero) re-skins small nightlife faces as tube lettering on a black board
      if (nightlife && (type === 'fascia' || type === 'round' || type === 'window') && uNeon < (NEON_SHARE[0] + (NEON_SHARE[1] - NEON_SHARE[0]) * pn) * 3.4) style = 'neon';
      const acc = pickW(uAcc, [['white', 0.5], ['red', 0.2], ['blue', 0.15], ['yellow', 0.15]]);
      const kindNits = style === 'neon' ? NITS.neon : style === 'channel' || style === 'roof' ? (c.cat === 'white' ? NITS.channel : NITS.channelColour)
        : style === 'window' ? NITS.window : style === 'scroller' ? NITS.scroller : style === 'banner' ? NITS.banner
        : (c.cat === 'white' ? NITS.lightbox : NITS.lightboxColour);
      const nits = kindNits[0] + (kindNits[1] - kindNits[0]) * uNit;
      // ~3 % of lit tubes/boxes are failing: irregular flicker (S3 can light it; the face flickers in-shader)
      const flicker = t.lit && (style === 'neon' ? uFlk < 0.08 : uFlk < 0.02) ? { hz: 6 + uFlk * 60, depth: 0.7 } : null;
      specs.push({ id: `${lot.id}:${type}${k++}`, type, style, lot: lot.id, street: lot.street, use: t.use, floor: t.f, lit: t.lit,
        cat: c.cat, hue: c.hue, rgb: c.rgb, accent: srgb(HEX[acc]), nits, flicker, name: t.name, phone: t.phone, tag: t.tag, frame: F, geo,
        push, seed: r.next() * 1e9 >>> 0, ...extra });
    };
    const g = tenants[0];
    const L = F.L, fh = F.fh;
    // --- ground floor: fascia light box (most) or channel letters on a raceway (cafes, conv, clubs often) ---
    const fasciaW = Math.min(L - 0.3, L * range(r, 0.82, 0.97)), fasciaH = range(r, 0.85, 1.25);
    const fasciaY = Math.min(fh - fasciaH - 0.15, range(r, 2.55, 2.95));
    const channel = r.next() < ({ cafe: 0.55, club: 0.5, shop: 0.4, hotel: 0.7 }[g.use] ?? 0.2);
    add(channel ? 'channel' : 'fascia', g, { u: (L - fasciaW) / 2, y: fasciaY, w: fasciaW, h: fasciaH, d: channel ? 0.12 : 0.28 });
    // --- second fascia on the side-return or a smaller box over the door (pocha / restaurants stack boxes) ---
    if (r.next() < 0.35 && L > 6) add('fascia', g, { u: range(r, 0.2, 0.6), y: fasciaY - 0.95, w: Math.min(2.4, L * 0.25), h: 0.7, d: 0.2, small: true });
    // --- LED dot scroller over the door (bars, pocha, pc, karaoke, restaurants) ---
    if (r.next() < ({ bar: 0.5, pocha: 0.6, restaurant: 0.4, pc: 0.6, karaoke: 0.6, conv: 0.1 }[g.use] ?? 0.12)) {
      const sw = Math.min(L * 0.5, range(r, 1.6, 3.2));
      add('scroller', g, { u: range(r, 0.3, Math.max(0.35, L - sw - 0.3)), y: fasciaY - 0.36, w: sw, h: 0.26, d: 0.06 }, { scrollRow: Math.floor(r.next() * SCROLL_TEXT.length) });
    }
    // --- sidewalk standing sign (입간판): rotating cylinder / box, 1.2 m in front ---
    if (r.next() < ({ cafe: 0.6, bar: 0.7, pocha: 0.7, restaurant: 0.75, karaoke: 0.8, pc: 0.6, shop: 0.4, club: 0.5 }[g.use] ?? 0.15))
      add('stand', g, { u: range(r, 0.6, Math.max(0.7, L - 0.6)), y: 0.15, w: 0.55, h: range(r, 1.1, 1.5), d: 0.55, out: range(r, 0.8, 1.4) });
    // --- upper floors: spandrel boxes, window vinyl, channel letters ---
    for (let f = 1; f < nFloors; f++) {
      const t = tenants[f]; if (t.use === 'motel' || t.use === 'hotel') continue;
      const y0 = f * fh;
      const v = r.next();
      if (v < 0.55) add('fascia', t, { u: L * range(r, 0.04, 0.12), y: y0 + fh - range(r, 1.05, 1.3), w: L * range(r, 0.7, 0.9), h: range(r, 0.75, 1.0), d: 0.22 });
      else if (v < 0.75) add('channel', t, { u: L * range(r, 0.08, 0.2), y: y0 + fh - 1.0, w: L * range(r, 0.55, 0.8), h: 0.8, d: 0.1 });
      // window vinyl: hangul and floor number on the glass, lit by the room behind
      if (r.next() < 0.7) {
        const nw = r.next() < 0.5 ? 1 : 2;
        for (let j = 0; j < nw; j++) {
          const ww = Math.min(L / nw - 0.6, range(r, 2.0, 3.6));
          add('window', t, { u: (L / nw) * j + (L / nw - ww) / 2, y: y0 + range(r, 0.85, 1.05), w: ww, h: range(r, 0.9, 1.3), d: 0.0 });
        }
      }
      if (r.next() < 0.12 && t.lit === false) add('banner', t, { u: L * 0.15, y: y0 + 0.5, w: L * 0.7, h: 0.8, d: 0.02 });
    }
    // --- vertical blade stack (돌출간판): one tenant box per floor, at the facade edge ---
    if (nFloors >= 3 && r.next() < 0.75) {
      const side = r.next() < 0.5 ? 0.35 : L - 0.35, out = range(r, 0.45, 0.9), bw = range(r, 0.55, 0.75);
      for (let f = 1; f < nFloors; f++) {
        const t = tenants[f];
        add('blade', t, { u: side, y: f * fh + 0.25, w: bw, h: fh - 0.5, d: 0.32, out });
      }
      if (lot.use === 'motel' || lot.use === 'hotel') { // one tall continuous blade for the whole building name
        add('blade', tenants[0], { u: L - side, y: fh + 0.2, w: 0.9, h: Math.min(10, (nFloors - 1) * fh - 0.4), d: 0.4, out: 1.0, tall: true });
      }
    }
    // --- round projecting box (원형돌출) at 2F for cafes/restaurants ---
    if (nFloors >= 2 && r.next() < ({ cafe: 0.5, restaurant: 0.3, shop: 0.3, bar: 0.3 }[g.use] ?? 0.08))
      add('round', g, { u: r.next() < 0.5 ? 0.5 : L - 0.5, y: fh + 0.4, w: 0.8, h: 0.8, d: 0.18, out: 0.6 });
    // --- neon in the ground-floor window (bars, pocha, clubs) ---
    if (NIGHT_USES.has(g.use) && r.next() < 0.5) add('neon', g, { u: range(r, 0.5, Math.max(0.6, L - 2.2)), y: 1.0, w: range(r, 1.2, 1.8), h: range(r, 0.5, 0.8), d: 0.05 }, { neonText: pick(r, NEON_WORDS) });
    // --- rooftop sign on taller buildings: steel frame with letters or a box ---
    if (nFloors >= 5 && r.next() < 0.45) {
      const t = lot.use === 'office' ? tenants[nFloors - 1] : tenants[0];
      const rw = Math.min(L * 0.85, range(r, 6, 11));
      add('roof', t, { u: (L - rw) / 2, y: F.top + 0.6, w: rw, h: range(r, 1.6, 2.6), d: 0.3, out: -1.2 });
    }
    // --- motels: the classic heart/neon outline blade is covered by the tall blade; add a fascia with 휴게/숙박 tag ---
    if (lot.use === 'motel' || lot.use === 'hotel') add('fascia', g, { u: L * 0.1, y: fh * 2 - 1.1, w: L * 0.8, h: 0.9, d: 0.25 });
  }
  // --- LED screens: from the layout, plus small door screens synthesised for cafes / shops / clubs on hero streets ---
  const lotsById = new Map((layout.lots || []).map((l) => [l.id, l]));
  (layout.screens || []).forEach((s, i) => screens.push({ ...s, idx: i, seed: (seed ^ hashStr(s.id)) >>> 0 }));
  for (const lot of layout.lots || []) {
    const st = streets.get(lot.street); if (!st || st.kind === 'alley') continue;
    const r = new Rng(seed ^ hashStr(lot.id + '#scr'));
    if (!['cafe', 'shop', 'club', 'karaoke', 'pc'].includes(lot.use) || r.next() > 0.55) continue;
    const F = facadeFrame(lot); const w = range(r, 1.4, 2.2), h = w * 0.5625, u = range(r, 0.4, Math.max(0.5, F.L - w - 0.4));
    const cu = u + w / 2, y = range(r, 1.3, 1.8);
    screens.push({ id: `${lot.id}:door`, lot: lot.id, pos: [F.o[0] + F.r[0] * cu + F.n[0] * 0.03, y + h / 2, F.o[1] + F.r[1] * cu + F.n[1] * 0.03],
      normal: [F.n[0], 0, F.n[1]], w, h, kind: 'small', idx: screens.length, seed: (seed ^ hashStr(lot.id + '#door')) >>> 0, synth: true });
  }
  void lotsById;
  return { specs, screens };
}

// stats for tests / report: lit share, colour shares of lit signs, counts by type
export function signStats(specs) {
  const byType = {}, cat = Object.fromEntries(COLOR_CATS.map((c) => [c, 0])); let lit = 0, litN = 0, neon = 0, eligible = 0;
  for (const s of specs) {
    byType[s.style] = (byType[s.style] || 0) + 1;
    if (s.type === 'banner') continue; eligible++;
    if (s.lit) { lit++; litN++; cat[s.cat]++; if (s.style === 'neon') neon++; }
  }
  const share = Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, +(v / Math.max(1, litN)).toFixed(3)]));
  return { total: specs.length, byType, litShare: +(lit / Math.max(1, eligible)).toFixed(3), colourShare: share, neonShare: +(neon / Math.max(1, litN)).toFixed(3) };
}

// ---------------------------------------------------------------------------------------------------------------
// 5) geometry: each spec -> housing boxes + face quads (atlas regions). Faces carry per-vertex nits + flicker.
// ---------------------------------------------------------------------------------------------------------------
class Buf {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.f = []; }
  quad(P, N, UV, C, Fk) { // P: 4 corners (bl, br, tr, tl), two triangles
    const idx = [0, 1, 2, 0, 2, 3];
    for (const i of idx) { this.p.push(...P[i]); this.n.push(...N); this.uv.push(...(UV ? UV[i] : [0, 0])); this.c.push(...C); this.f.push(...(Fk || [0, 0, 0])); }
  }
  geometry() {
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('flk', new THREE.Float32BufferAttribute(this.f, 3));
    g.computeBoundingSphere();
    return g;
  }
}
const UP = [0, 1, 0];
const add3 = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// face quad: centre c, normal m (horizontal or not), width w along r = up x m, height h along up; uv rect [u0,v0,u1,v1]
function faceQuad(buf, c, m, w, h, uvr, col, fk) {
  const r = cross(UP, m); const rl = Math.hypot(...r) || 1; r[0] /= rl; r[1] /= rl; r[2] /= rl;
  const bl = add3(add3(c, r, -w / 2), UP, -h / 2), br = add3(add3(c, r, w / 2), UP, -h / 2);
  const tr = add3(add3(c, r, w / 2), UP, h / 2), tl = add3(add3(c, r, -w / 2), UP, h / 2);
  const UV = uvr ? [[uvr[0], uvr[1]], [uvr[2], uvr[1]], [uvr[2], uvr[3]], [uvr[0], uvr[3]]] : null;
  buf.quad([bl, br, tr, tl], m, UV, col, fk);
}
// axis box: centre c, frame (r, up, n), half sizes (hw, hh, hd); colour per face; skip front if noFront
function box(buf, c, r, n, hw, hh, hd, col, noFront = false) {
  const P = (sx, sy, sz) => [c[0] + r[0] * sx * hw + n[0] * sz * hd, c[1] + sy * hh, c[2] + r[2] * sx * hw + n[2] * sz * hd];
  const F = [[[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], n], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1], [-n[0], 0, -n[2]]],
    [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1], [r[0], 0, r[2]]], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-r[0], 0, -r[2]]],
    [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1], [0, 1, 0]], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [0, -1, 0]]];
  F.forEach((f, i) => { if (noFront && i === 0) return; buf.quad(f.slice(0, 4).map((s) => P(...s)), f[4], null, col); });
}

// ---------------------------------------------------------------------------------------------------------------
// 6) atlas: shelf packer + Canvas2D painter (fonts from seoul/fonts, system fallbacks)
// ---------------------------------------------------------------------------------------------------------------
export const FONTS = [ // family, file (seoul/fonts), role
  ['S2 BlackHan', 'BlackHanSans.woff2'], ['S2 DoHyeon', 'DoHyeon.woff2'], ['S2 Jua', 'Jua.woff2'], ['S2 Brush', 'NanumBrushScript.woff2'],
  ['S2 Pen', 'NanumPenScript.woff2'], ['S2 Gothic', 'GothicA1Black.woff2'], ['S2 Serif', 'NotoSerifKR900.woff2'], ['S2 Sans', 'NotoSansKR800.woff2'],
];
const FALLBACK = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
let fontsPromise = null;
export function loadFonts(base = './seoul/fonts/') {
  if (fontsPromise) return fontsPromise;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return (fontsPromise = Promise.resolve(false));
  fontsPromise = Promise.all(FONTS.map(([fam, file]) => new FontFace(fam, `url(${base}${file})`).load().then((f) => { document.fonts.add(f); return true; }, () => false)))
    .then((r) => r.every(Boolean));
  return fontsPromise;
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

function packShelves(items, size) { // items: {w,h} px (padding included) -> sets x,y; returns false if overflow
  const order = items.map((_, i) => i).sort((a, b) => items[b].h - items[a].h || items[b].w - items[a].w);
  let x = 0, y = 0, rowH = 0;
  for (const i of order) {
    const it = items[i]; if (it.w > size) it.w = size;
    if (x + it.w > size) { x = 0; y += rowH; rowH = 0; }
    if (y + it.h > size) return false;
    it.x = x; it.y = y; x += it.w; rowH = Math.max(rowH, it.h);
  }
  return true;
}

const css = (c, k = 1) => { const t = new THREE.Color(c[0] * k, c[1] * k, c[2] * k); return '#' + t.getHexString(); }; // linear -> sRGB hex
function fitText(g, text, family, weight, x, y, w, h, opts = {}) {
  // draw text centred in (x,y,w,h); shrink height-first, then condense horizontally (as Korean sign shops do) down to 55 %
  if (!text) return;
  let size = h * (opts.k ?? 0.78);
  g.font = `${weight || ''} ${size}px "${family}", ${FALLBACK}`;
  let m = g.measureText(text).width; let sx = 1;
  if (m > w) { sx = w / m; if (sx < 0.55) { size *= sx / 0.55; g.font = `${weight || ''} ${size}px "${family}", ${FALLBACK}`; m = g.measureText(text).width; sx = Math.min(1, w / m); } }
  g.save(); g.translate(x + w / 2, y + h / 2 + size * (opts.dy ?? 0.04)); g.scale(sx, 1);
  g.textAlign = opts.align || 'center'; g.textBaseline = 'middle';
  if (opts.stroke) { g.lineJoin = 'round'; g.lineWidth = opts.stroke; g.strokeStyle = opts.strokeStyle; g.strokeText(text, 0, 0); }
  if (opts.glow) { g.shadowColor = opts.glow; g.shadowBlur = opts.glowBlur || size * 0.25; }
  g.fillStyle = opts.fill || '#fff'; g.fillText(text, 0, 0);
  g.restore();
}
function verticalText(g, text, family, x, y, w, h, fill, opts = {}) { // one syllable per row (blade signs)
  const chars = [...text.replace(/ /g, '')]; if (!chars.length) return;
  const cell = Math.min(w * 0.92, h / chars.length);
  const y0 = y + (h - cell * chars.length) / 2;
  chars.forEach((ch, i) => fitText(g, ch, family, '', x + (w - cell) / 2, y0 + i * cell, cell, cell, { fill, k: 0.86, ...opts }));
}

// paint one design into its region. All colours here are sRGB display values; the material reads them as sRGB.
function paintSign(g, s, x, y, w, h, R) {
  const rr = R.next(), fam = fontFor(s, rr);
  const col = css(s.rgb), acc = css(s.accent);
  const lit = s.lit; const nm = s.name;
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  const diffuser = (bg) => { // light box face: flat with faint LED-row hot bands and darker frame edge
    g.fillStyle = bg; g.fillRect(x, y, w, h);
    if (lit) {
      const rows = Math.max(2, Math.round(h / 40));
      for (let i = 0; i < rows; i++) { const gy = y + (i + 0.5) * h / rows; const gr = g.createLinearGradient(0, gy - h / rows / 2, 0, gy + h / rows / 2);
        gr.addColorStop(0, 'rgba(0,0,0,0.10)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.10)'); gr.addColorStop(1, 'rgba(0,0,0,0.10)'); g.fillStyle = gr; g.fillRect(x, gy - h / rows / 2, w, h / rows); }
    }
    const e = Math.max(2, Math.min(w, h) * 0.05); const gr = g.createLinearGradient(x, 0, x + e * 3, 0);
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(x, y, e, h); g.fillRect(x + w - e, y, e, h); g.fillRect(x, y, w, e * 0.6); g.fillRect(x, y + h - e * 0.6, w, e * 0.6);
    void gr;
  };
  const whiteBox = s.cat === 'white';
  // text colour: white boxes get coloured vinyl (accent; never white-on-white), coloured boxes get white letters
  const vinyl = whiteBox ? (s.accent[0] + s.accent[1] + s.accent[2] > 2.4 ? css(srgb(HEX.red)) : acc) : '#ffffff';
  const bg = whiteBox ? col : css(s.rgb, 0.92);
  switch (s.style) {
    case 'fascia': case 'stand': {
      diffuser(bg);
      if (s.style === 'stand') { verticalText(g, nm.main.replace(/[A-Z ]/g, '').slice(0, 5) || nm.main.slice(0, 5), fam, x, y + h * 0.04, w, h * 0.92, vinyl); break; }
      const hasSub = !!nm.sub, sub = nm.sub;
      const mainW = w * (hasSub ? 0.66 : 0.8), pad = w * 0.04;
      if (hasSub) {
        fitText(g, nm.main, fam, '', x + pad, y + h * 0.06, mainW, h * 0.88, { fill: vinyl });
        // category word in a contrasting band at right; phone underneath (typical 가로형 layout)
        const bx = x + pad + mainW + w * 0.02, bw = w - (bx - x) - pad;
        g.fillStyle = whiteBox ? vinyl : 'rgba(255,255,255,0.92)'; g.fillRect(bx, y + h * 0.16, bw, h * 0.46);
        fitText(g, sub, 'S2 Sans', '800', bx, y + h * 0.16, bw, h * 0.46, { fill: whiteBox ? '#fff' : css(s.rgb, 0.8), k: 0.7 });
        fitText(g, s.phone, 'S2 Sans', '800', bx, y + h * 0.66, bw, h * 0.24, { fill: vinyl, k: 0.8 });
      } else {
        fitText(g, nm.main, fam, '', x + w * 0.1, y + h * 0.08, mainW, h * 0.84, { fill: vinyl });
        if (w > h * 4) { fitText(g, s.tag, 'S2 Sans', '800', x + w * 0.02, y + h * 0.25, w * 0.08, h * 0.5, { fill: vinyl, k: 0.55 });
          fitText(g, s.floor ? `${s.floor + 1}F` : '1F', 'S2 Sans', '800', x + w * 0.9, y + h * 0.2, w * 0.08, h * 0.6, { fill: vinyl, k: 0.7 }); }
      }
      break;
    }
    case 'channel': case 'roof': {
      // transparent background (alpha-tested): the letters are the sign. Faces in the light colour with a thin darker trim.
      const text = nm.sub && nm.main.length < 6 ? `${nm.main} ${nm.sub}` : nm.main;
      fitText(g, text, fam, '', x + w * 0.02, y + h * 0.04, w * 0.96, h * 0.92, { fill: col, stroke: Math.max(2, h * 0.04), strokeStyle: css(s.rgb, 0.35), k: 0.86 });
      break;
    }
    case 'blade': {
      diffuser(bg);
      // tenant: floor tag on top, name stacked vertically
      const t = s.geo.tall ? nm.main : (nm.sub ? nm.main + nm.sub : nm.main);
      const hangul = t.replace(/[^가-힣0-9]/g, '');
      if (hangul.length >= 2 || !/[A-Z]/.test(t)) { g.fillStyle = whiteBox ? vinyl : 'rgba(255,255,255,0.95)'; g.fillRect(x + w * 0.08, y + h * 0.02, w * 0.84, h * 0.1);
        fitText(g, s.geo.tall ? s.tag : `${s.floor + 1}층`, 'S2 Sans', '800', x + w * 0.08, y + h * 0.02, w * 0.84, h * 0.1, { fill: whiteBox ? '#fff' : css(s.rgb, 0.7), k: 0.7 });
        verticalText(g, (hangul || t).slice(0, 7), fam, x, y + h * 0.14, w, h * 0.84, vinyl); }
      else { g.save(); g.translate(x + w / 2, y + h / 2); g.rotate(-Math.PI / 2); fitText(g, t, fam, '', -h / 2 + h * 0.05, -w / 2, h * 0.9, w, { fill: vinyl }); g.restore(); }
      break;
    }
    case 'window': {
      // vinyl letters on glass: transparent glass (alpha 0), letters semi-opaque white/colour lit by the room
      fitText(g, nm.sub ? `${nm.main} ${nm.sub}` : nm.main, fam, '', x + w * 0.04, y + h * 0.05, w * 0.92, h * 0.55, { fill: whiteBox ? '#f4f2ea' : col, k: 0.85 });
      fitText(g, `${s.floor + 1}층 · ${s.tag}`, 'S2 Sans', '800', x + w * 0.1, y + h * 0.62, w * 0.8, h * 0.3, { fill: whiteBox ? '#f4f2ea' : col, k: 0.7 });
      break;
    }
    case 'neon': {
      // black board; tube = saturated colour halo + near-white core (real neon clips white at the centre of the tube)
      g.fillStyle = '#000'; g.fillRect(x, y, w, h);
      const text = s.neonText || (nm.sub || nm.main);
      const tube = Math.max(2, h * 0.045);
      const tf = s.neonText ? fam : 'S2 Pen';
      for (const [lw, st, a] of [[tube * 3.2, col, 0.18], [tube * 1.8, col, 0.55], [tube, col, 1], [tube * 0.45, css([1, 1, 1].map((v, i) => 0.55 + 0.45 * s.rgb[i])), 1]]) {
        g.globalAlpha = a; g.save(); g.translate(x + w / 2, y + h / 2); g.font = `${h * 0.62}px "${tf}", ${FALLBACK}`;
        const m = g.measureText(text).width; const sx = Math.min(1, (w * 0.9) / m); g.scale(sx, 1);
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineCap = 'round'; g.lineWidth = lw / sx; g.strokeStyle = st;
        g.strokeText(text, 0, 0); g.restore();
      }
      g.globalAlpha = 1;
      if (s.type !== 'neon') { // re-skinned box: also frame it with a tube border
        g.strokeStyle = css(s.accent); g.globalAlpha = 0.8; g.lineWidth = tube; g.strokeRect(x + h * 0.08, y + h * 0.08, w - h * 0.16, h - h * 0.16); g.globalAlpha = 1;
      }
      break;
    }
    case 'round': {
      g.fillStyle = 'rgba(0,0,0,0)'; g.clearRect(x, y, w, h);
      g.beginPath(); g.arc(x + w / 2, y + h / 2, Math.min(w, h) * 0.48, 0, Math.PI * 2); g.fillStyle = bg; g.fill();
      g.lineWidth = Math.min(w, h) * 0.04; g.strokeStyle = 'rgba(0,0,0,0.25)'; g.stroke();
      fitText(g, (nm.sub || nm.main).slice(0, 4), fam, '', x + w * 0.16, y + h * 0.3, w * 0.68, h * 0.4, { fill: vinyl });
      break;
    }
    case 'banner': {
      g.fillStyle = pick(R, ['#d8d2c4', '#e8e1cf', '#c9d6e0', '#f0e6c8']); g.fillRect(x, y, w, h);
      fitText(g, pick(R, BANNER_WORDS), 'S2 BlackHan', '', x + w * 0.04, y + h * 0.1, w * 0.92, h * 0.8, { fill: pick(R, ['#c81e1e', '#1d3fa8', '#111']) });
      break;
    }
    default: break;
  }
  g.restore();
}

// ---------------------------------------------------------------------------------------------------------------
// 7) LED screens: content programs + panel model (shader), mean colour on the CPU for the spill emitter
// ---------------------------------------------------------------------------------------------------------------
// palettes (sRGB hex) for screen programs; invented campaigns only
const SCREEN_PALETTES = [
  ['#1b6dff', '#21e6ff', '#ffffff'], ['#ff2fa0', '#7a2cff', '#ffd2f0'], ['#0b0b18', '#ff3cbe', '#2be8ff'], ['#ffb21a', '#ff3a1a', '#fff2c0'],
  ['#12c86a', '#d8ff3a', '#ffffff'], ['#0a1440', '#3a7bff', '#ffffff'], ['#ff6a3c', '#ffd23a', '#2a0a3a'], ['#00b4d8', '#ff4f9a', '#fafafa'],
  ['#e8e8f0', '#1a1a2a', '#ff2a4a'], ['#5a1aff', '#ff2ad2', '#fff'],
];
// program ids (keep in sync with the GLSL below)
export const PROG = { GRADIENT: 0, STAGE: 1, EVENT: 2, BUBBLES: 3, GRIDGAME: 4, CLOCK: 5, WIPE: 6, PSA: 7 };
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
// approximate mean linear colour of a program frame (mirrors the shader's area weights); for the light-spill emitter
export function programMean(seg, lt) {
  const [c0, c1, c2] = seg.pal; const W = [1, 1, 1];
  switch (seg.prog) {
    case 0: { const k = 0.5 + 0.25 * Math.sin(lt * 0.9 + seg.seed); return mix3(mix3(c0, c1, k), c2, 0.12); }
    case 1: { const beat = Math.pow(fract(lt * 2.0), 3); return mix3([0.01, 0.01, 0.02], mix3(c0, c1, 0.5 + 0.5 * Math.sin(lt)), 0.18 + 0.25 * (1 - beat)); }
    case 2: return mix3(c0, W, 0.15);
    case 3: return mix3(mix3(c0, [0, 0, 0], 0.35), c2, 0.1);
    case 4: return mix3([0.02, 0.0, 0.05], c1, 0.22);
    case 5: return mix3([0.004, 0.01, 0.04], W, 0.12);
    case 6: { const w = Math.min(1, lt / 1.2); const ph = Math.floor(lt / 2.5) % 3; const cs = [c0, c1, c2]; return mix3(cs[(ph + 2) % 3], cs[ph], w); }
    case 7: return mix3(c0, W, 0.2);
    default: return c0;
  }
}

const SCREEN_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w; }`;
const SCREEN_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv; varying vec3 vN; varying vec3 vW;
uniform float uT, uLT, uNits, uNit, uMoire, uBandDepth, uBandN, uBandRate, uViewH, uSeed, uBlack, uCut;
uniform vec2 uRes;          // LED pixels (cols, rows)
uniform int uProg;
uniform vec3 uC0, uC1, uC2;
uniform vec2 uRow;          // text rows (main, sub); -1 = none
uniform sampler2D uText; uniform float uRows;
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float txt(vec2 uv, float row){ // uv in [0,1]^2 of the text box -> alpha
  if (row < 0.0 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture2D(uText, vec2(uv.x, (row + 1.0 - uv.y) / uRows)).a; }
vec3 srgbToLin(vec3 c){ return pow(c, vec3(2.2)); }
// content in linear [0,1] at LED-pixel-quantised uv
vec3 content(vec2 uv, float t){
  vec3 c = vec3(0.0); float a = 0.0; float asp = uRes.x / uRes.y;
  if (uProg == 0) { // flowing gradient ad + product line
    float f = sin(uv.x*3.0 + t*0.7 + uSeed) + sin(uv.y*4.0 - t*0.5) + sin((uv.x+uv.y)*2.5 + t*0.9);
    c = mix(uC0, uC1, 0.5 + 0.25*f); c = mix(c, uC2, smoothstep(1.2, 2.6, f) * 0.6);
    float slide = clamp(t * 1.4, 0.0, 1.0); slide = 1.0 - pow(1.0 - slide, 3.0);
    a = txt(vec2((uv.x - 0.08) / 0.84 + (1.0 - slide), (uv.y - 0.45) / 0.3), uRow.x);
    float b = txt(vec2((uv.x - 0.2) / 0.6, (uv.y - 0.22) / 0.16), uRow.y) * smoothstep(0.8, 1.4, t);
    c = mix(c, vec3(1.0), max(a, b));
  } else if (uProg == 1) { // stage: beams + equaliser + title
    c = vec3(0.01, 0.008, 0.02);
    for (int i = 0; i < 5; i++) { float fi = float(i); float ang = sin(t*0.8 + fi*1.7 + uSeed) * 0.6;
      vec2 o = vec2(0.1 + fi*0.2, -0.05); vec2 d = uv - o; float aa = atan(d.x, d.y) - ang;
      c += mix(uC0, uC1, fi/4.0) * smoothstep(0.09, 0.0, abs(aa)) * (0.7 - 0.5*length(d)); }
    float bars = floor(uv.x * 24.0); float hgt = 0.08 + 0.22 * abs(sin(t*3.0 + bars*0.7 + sin(bars*1.3 + t)));
    float beat = pow(fract(t*2.0), 3.0);
    c += mix(uC1, uC2, uv.y*3.0) * step(uv.y, hgt) * step(0.15, fract(uv.x*24.0)) * (0.6 + 0.4*(1.0-beat));
    a = txt(vec2((uv.x - 0.1) / 0.8, (uv.y - 0.62) / 0.22), uRow.x); float b = txt(vec2((uv.x - 0.12)/0.76, (uv.y - 0.42)/0.18), uRow.y);
    c = mix(c, vec3(1.0), max(a, b * smoothstep(0.5, 1.0, t)));
  } else if (uProg == 2) { // event: big D-day, confetti
    c = uC0 * (0.75 + 0.25*uv.y);
    vec2 g = vec2(uv.x * asp, uv.y) * 14.0; g.y += t * 2.5; vec2 id = floor(g); float hh = h21(id);
    vec2 fp = fract(g) - 0.5; float conf = step(0.82, hh) * step(max(abs(fp.x), abs(fp.y)), 0.18 + 0.1*sin(t*5.0 + hh*20.0));
    c = mix(c, mix(uC1, uC2, fract(hh*7.0)), conf);
    a = txt(vec2((uv.x - 0.06) / 0.88, (uv.y - 0.6) / 0.24), uRow.x);
    float big = txt(vec2((uv.x - 0.3) / 0.4, (uv.y - 0.12) / 0.42), uRow.y) * (0.85 + 0.15*step(0.5, fract(t*1.5)));
    c = mix(c, vec3(1.0), max(a, big));
  } else if (uProg == 3) { // drink: deep gradient, rising bubbles
    c = mix(uC0 * 0.25, uC0, uv.y);
    for (int i = 0; i < 3; i++) { float s = 8.0 + float(i)*6.0; vec2 g = vec2(uv.x*asp, uv.y - t*(0.12 + 0.05*float(i))) * s;
      vec2 id = floor(g); vec2 fp = fract(g) - 0.5 - (vec2(h21(id), h21(id+3.1)) - 0.5) * 0.5; float r = 0.12 + 0.18*h21(id+7.7);
      c += uC2 * 0.55 * step(0.55, h21(id+1.3)) * smoothstep(r, r - 0.06, length(fp)) * smoothstep(r - 0.12, r, length(fp)); }
    a = txt(vec2((uv.x - 0.1) / 0.8, (uv.y - 0.5) / 0.3), uRow.x); float b = txt(vec2((uv.x - 0.2)/0.6, (uv.y - 0.28)/0.16), uRow.y);
    c = mix(c, vec3(1.0), max(a, b));
  } else if (uProg == 4) { // game pre-registration: perspective grid, title
    c = mix(vec3(0.02, 0.0, 0.05), uC0 * 0.4, uv.y);
    float hz = 0.42; if (uv.y < hz) { float z = 1.0 / max(hz - uv.y, 1e-3); float gx = (uv.x - 0.5) * z; float gz = z + t * 4.0;
      float line = max(smoothstep(0.06*z*0.05, 0.0, abs(fract(gx) - 0.5) - 0.47), smoothstep(0.0, 0.03, fract(gz*0.5) - 0.96));
      c += uC1 * line * smoothstep(0.0, 0.25, hz - uv.y + 0.05); }
    c += uC1 * 0.6 * smoothstep(0.012, 0.0, abs(uv.y - hz));
    a = txt(vec2((uv.x - 0.05) / 0.9, (uv.y - 0.58) / 0.24), uRow.x); float b = txt(vec2((uv.x - 0.25)/0.5, (uv.y - 0.82)/0.12), uRow.y) * step(0.5, fract(t*1.2));
    c = mix(c, uC2, max(a, b));
  } else if (uProg == 5) { // clock + weather (public info)
    c = mix(vec3(0.004, 0.01, 0.05), vec3(0.01, 0.03, 0.12), uv.y);
    // HH:MM from uT (starts 23:41), digits sampled from the digit strip row (last row: "0123456789:")
    float mins = 41.0 + floor(uT / 60.0); float hh = mod(23.0 + floor(mins / 60.0), 24.0); float mm = mod(mins, 60.0);
    float d[5]; d[0] = floor(hh/10.0); d[1] = mod(hh,10.0); d[2] = 10.0; d[3] = floor(mm/10.0); d[4] = mod(mm,10.0);
    vec2 box = vec2((uv.x - 0.2) / 0.6, (uv.y - 0.36) / 0.44);
    if (box.x > 0.0 && box.x < 1.0 && box.y > 0.0 && box.y < 1.0) { float k = floor(box.x * 5.0); float lx = fract(box.x * 5.0);
      float dig = k < 0.5 ? d[0] : k < 1.5 ? d[1] : k < 2.5 ? d[2] : k < 3.5 ? d[3] : d[4];
      float blink = (k > 1.5 && k < 2.5) ? step(0.5, fract(uT)) : 1.0;
      a = blink * texture2D(uText, vec2((dig + 0.5 + (lx - 0.5) * 0.95) / 11.0, (uRows - 1.0 + 1.0 - box.y) / uRows)).a; }
    float b = txt(vec2((uv.x - 0.1)/0.8, (uv.y - 0.1)/0.18), uRow.x);
    c = mix(c, vec3(1.0), max(a, b * 0.9));
  } else if (uProg == 6) { // fashion: diagonal colour-block wipes
    float ph = floor(t / 2.5); float lt = t - ph*2.5; float w = clamp(lt / 1.2, 0.0, 1.0);
    int pi = int(mod(ph, 3.0)); vec3 cs0 = pi == 0 ? uC0 : pi == 1 ? uC1 : uC2; vec3 cs1 = pi == 0 ? uC2 : pi == 1 ? uC0 : uC1;
    float edge = uv.x + uv.y*0.4; c = mix(cs1, cs0, step(edge, w * 1.5));
    a = txt(vec2((uv.x - 0.08) / 0.84, (uv.y - 0.5) / 0.28), uRow.x); float b = txt(vec2((uv.x - 0.15)/0.7, (uv.y - 0.25)/0.16), uRow.y);
    vec3 tc = dot(c, vec3(0.3, 0.6, 0.1)) > 0.5 ? vec3(0.02) : vec3(1.0);
    c = mix(c, tc, max(a, b));
  } else { // PSA: calm flat panel
    c = mix(uC0, uC0 * 0.6, uv.y);
    a = txt(vec2((uv.x - 0.08) / 0.84, (uv.y - 0.5) / 0.28), uRow.x); float b = txt(vec2((uv.x - 0.15)/0.7, (uv.y - 0.25)/0.16), uRow.y);
    c = mix(c, vec3(1.0), max(a, b));
  }
  c *= 1.0 - 0.85 * uCut; // one dark frame on a cut (players switch playlists)
  return clamp(c, 0.0, 1.0);
}
void main(){
  vec2 cell = vUv * uRes; vec2 id = floor(cell); vec2 f = fract(cell);
  vec3 col = content((id + 0.5) / uRes, uLT);
  // SMD panel: RGB dies in a triangle inside each pixel, black louvred face. fill ~ mean coverage of the mask.
  vec2 q = f - 0.5;
  float rr = 0.13;
  float mR = smoothstep(rr, rr*0.55, length(q - vec2(-0.14, 0.09)));
  float mG = smoothstep(rr, rr*0.55, length(q - vec2( 0.14, 0.09)));
  float mB = smoothstep(rr, rr*0.55, length(q - vec2( 0.0, -0.13)));
  vec3 mask = vec3(mR, mG, mB);
  const float FILL = 0.0385;  // area of one die / pixel area (pi * ~0.11^2), so mask/FILL averages to 1
  // The camera integrates each sensor pixel over its area (box filter) and then samples. A die grid of period P sensor px
  // keeps its fundamental at amplitude |sinc(1/P)|; sampled below Nyquist that cosine aliases into a smooth beat: the
  // moire. Each colour's dies sit at a different offset, so the beats are phase-shifted per channel (colour fringes).
  vec2 px2 = max(fwidth(cell), vec2(1e-4)); float px = max(px2.x, px2.y);   // LED pixels per sensor pixel
  float resolve = smoothstep(0.75, 0.3, px);                                // 1 = dies resolved (closer than ~1.5 px per LED)
  vec2 sx = 3.14159265 * px2; vec2 att = abs(sin(sx) / sx) * smoothstep(4.0, 1.5, px2);
  float k = 0.85 * uMoire;
  vec3 ox = vec3(-0.14, 0.14, 0.0), oy = vec3(0.09, 0.09, -0.13);
  vec3 far = (1.0 + k * att.x * cos(6.2831853 * (cell.x - 0.5 - ox))) * (1.0 + k * att.y * cos(6.2831853 * (cell.y - 0.5 - oy)));
  vec3 near = mask / FILL;
  vec3 m = mix(far, near, resolve);
  // louvre / viewing angle: horizontal +-70 deg ok, from above the louvres shade the dies
  vec3 V = normalize(cameraPosition - vW); float nd = max(dot(vN, V), 0.0);
  float above = clamp(V.y, -1.0, 1.0);
  float ang = mix(0.35, 1.0, sqrt(nd)) * mix(1.0, 0.45, smoothstep(0.35, 0.9, above));
  // rolling-shutter refresh bands (sensor rows: screen-space y) from the panel's scan/PWM rate
  float band = 1.0 - uBandDepth * (0.5 + 0.5 * sin(6.2831853 * (gl_FragCoord.y / uViewH * uBandN + uT * uBandRate)));
  vec3 lin = col * m * ang * band;
  lin += vec3(uBlack);  // black level: louvre face reflects a little, dies leak
  gl_FragColor = vec4(lin * uNits * uNit, 1.0);
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
void main(){
  float rows = 16.0; vec2 cell = vec2(vUv.x * vS.z, vUv.y * rows); vec2 id = floor(cell); vec2 f = fract(cell) - 0.5;
  float x = mod(id.x + floor(uT * vS.y + vS.w), uTexW);
  float on = step(0.5, texture2D(uText, vec2((x + 0.5) / uTexW, (vS.x + 1.0 - (id.y + 0.5) / rows) / uRows)).a);
  float px = max(fwidth(cell.x), fwidth(cell.y));
  float dotm = mix(smoothstep(0.42, 0.28, length(f)) / 0.38, 1.0, smoothstep(0.4, 1.2, px));
  vec3 c = vC * (on * dotm + 0.004);
  gl_FragColor = vec4(c * uNit, 1.0);
}`;

// ---------------------------------------------------------------------------------------------------------------
// 8) build
// ---------------------------------------------------------------------------------------------------------------
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

export function build(layout, ctx = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const nit = { value: ctx.nitScale ?? NIT_SCALE };
  const uTime = { value: 0 };
  const { specs, screens } = generateSigns(layout, ctx);
  const group = new THREE.Group(); group.name = 'seoul-signs';
  const emitters = [];
  const litBuf = new Buf(), offBuf = new Buf(), neonBuf = new Buf(), houseBuf = new Buf(), scrollItems = [];
  const atlasItems = []; // { spec, wpx, hpx } per design
  const quality = ctx.quality || 'high';
  const ATLAS = ctx.atlasSize || (quality === 'low' ? 2048 : 4096);
  let density = ctx.pxPerM || (quality === 'low' ? 64 : 110);

  // housing colours (linear albedo, multiplied by S3's light; kept dark)
  const HOUSE = [0.035, 0.036, 0.04], STEEL = [0.06, 0.06, 0.065], RACE = [0.02, 0.02, 0.022];
  const pos3 = (F, u, y, d) => [F.o[0] + F.r[0] * u + F.n[0] * d, y, F.o[1] + F.r[1] * u + F.n[1] * d];

  for (const s of specs) {
    if (s.style === 'scroller') { scrollItems.push(s); continue; }
    const F = s.frame, G = s.geo; const n = [F.n[0], 0, F.n[1]], r = [F.r[0], 0, F.r[1]];
    const item = { spec: s, quads: [] }; atlasItems.push(item);
    const fk = s.flicker ? [s.flicker.hz, s.flicker.depth, (s.seed % 1000) / 1000] : [0, 0, 0];
    const lit = s.lit && s.style !== 'banner';
    const faceNits = lit ? s.nits / Math.max(0.05, lum(s.style === 'channel' || s.style === 'roof' || s.style === 'neon' ? s.rgb : (s.cat === 'white' ? [1, 1, 1] : s.rgb))) : 0;
    const col = lit ? [faceNits, faceNits, faceNits] : [1, 1, 1];
    const tgt = s.style === 'neon' ? neonBuf : lit ? litBuf : offBuf;
    const emit = (c, m, w, h, kind, cover) => { if (!lit) return;
      emitters.push({ id: `${s.id}${item.quads.length > 1 ? ':' + item.quads.length : ''}`, pos: c.map((v) => +v.toFixed(3)), normal: m.map((v) => +v.toFixed(3)), w: +w.toFixed(3), h: +h.toFixed(3),
        rgb: norm1(s.cat === 'white' && s.style !== 'neon' && s.style !== 'channel' ? srgb(HEX[s.hue]) : s.rgb).map((v) => +v.toFixed(4)),
        nits: Math.round(s.nits * cover), kind, ...(s.flicker ? { flicker: s.flicker } : {}), animated: false, use: s.use, lot: s.lot }); };
    const kindOf = { fascia: 'lightbox', stand: 'lightbox', blade: 'lightbox', round: 'lightbox', channel: 'channel', roof: 'channel', window: 'store', neon: 'neon', banner: 'lightbox' };
    const cover = COVER[{ fascia: 'lightbox', stand: 'lightbox', blade: 'lightbox', round: 'lightbox', channel: 'channel', roof: 'channel', window: 'window', neon: 'neon' }[s.style]] ?? 1;
    item.w = G.w; item.h = G.h;
    if (s.type === 'blade' || s.type === 'round') {
      // perpendicular to the facade: plane spanned by n and up, double-sided faces normal +-r
      const c = pos3(F, G.u, G.y + G.h / 2, G.out + G.w / 2);
      box(houseBuf, c, n, [-r[0], 0, -r[2]], G.w / 2 + 0.03, G.h / 2 + 0.03, G.d / 2, HOUSE, false);
      // support arm to the wall
      box(houseBuf, pos3(F, G.u, G.y + G.h - 0.1, G.out / 2), r, n, 0.03, 0.03, G.out / 2, STEEL);
      box(houseBuf, pos3(F, G.u, G.y + 0.1, G.out / 2), r, n, 0.03, 0.03, G.out / 2, STEEL);
      for (const sg of [1, -1]) { const m = [r[0] * sg, 0, r[2] * sg]; const fc = add3(c, m, G.d / 2 + 0.031 + 0.002);
        item.quads.push({ buf: tgt, c: fc, m, w: G.w, h: G.h, col, fk }); emit(fc, m, G.w, G.h, kindOf[s.style], cover); }
    } else if (s.type === 'stand') {
      const c = pos3(F, G.u, G.y + G.h / 2, G.out);
      box(houseBuf, [c[0], 0.075, c[2]], r, n, 0.32, 0.075, 0.32, RACE);
      box(houseBuf, c, r, n, G.w / 2, G.h / 2, G.d / 2, HOUSE, false);
      for (const m of [n, [-n[0], 0, -n[2]]]) { const fc = add3(c, m, G.d / 2 + 0.003); item.quads.push({ buf: tgt, c: fc, m, w: G.w * 0.92, h: G.h * 0.94, col, fk }); emit(fc, m, G.w, G.h, 'lightbox', cover); }
    } else if (s.type === 'roof') {
      const c = pos3(F, G.u + G.w / 2, G.y + G.h / 2, G.out);
      // steel frame: legs + bracing behind the letters
      for (const k of [0.1, 0.5, 0.9]) box(houseBuf, pos3(F, G.u + G.w * k, (F.top + G.y + G.h) / 2, G.out - 0.35), r, n, 0.05, (G.y + G.h - F.top) / 2, 0.05, STEEL);
      box(houseBuf, pos3(F, G.u + G.w / 2, G.y + G.h * 0.25, G.out - 0.35), r, n, G.w / 2, 0.04, 0.04, STEEL);
      box(houseBuf, pos3(F, G.u + G.w / 2, G.y + G.h * 0.75, G.out - 0.35), r, n, G.w / 2, 0.04, 0.04, STEEL);
      const fc = add3(c, n, 0.02); item.quads.push({ buf: tgt, c: fc, m: n, w: G.w, h: G.h, col, fk, back: STEEL }); emit(fc, n, G.w, G.h, 'channel', cover);
    } else {
      const c = pos3(F, G.u + G.w / 2, G.y + G.h / 2, G.d / 2 + 0.02);
      if (s.style === 'channel') { // raceway bar behind letters; letters stand 0.1 m proud
        box(houseBuf, pos3(F, G.u + G.w / 2, G.y + G.h * 0.45, 0.06), r, n, G.w * 0.48, 0.06, 0.04, RACE);
        const fc = add3(c, n, G.d / 2); item.quads.push({ buf: tgt, c: fc, m: n, w: G.w, h: G.h, col, fk, back: RACE }); emit(fc, n, G.w, G.h, 'channel', cover);
      } else if (s.type === 'window' || s.type === 'banner') {
        const fc = pos3(F, G.u + G.w / 2, G.y + G.h / 2, 0.025); item.quads.push({ buf: tgt, c: fc, m: n, w: G.w, h: G.h, col, fk }); emit(fc, n, G.w, G.h, kindOf[s.style], cover);
      } else {
        if (G.d > 0.07) box(houseBuf, c, r, n, G.w / 2 + 0.03, G.h / 2 + 0.03, G.d / 2, HOUSE, true);
        else box(houseBuf, add3(c, n, -0.01), r, n, G.w / 2 + 0.03, G.h / 2 + 0.03, 0.012, RACE, true); // neon backboard
        const fc = add3(c, n, G.d / 2 + 0.002); item.quads.push({ buf: tgt, c: fc, m: n, w: G.w, h: G.h, col, fk }); emit(fc, n, G.w, G.h, kindOf[s.style], cover);
      }
    }
  }

  // --- atlas packing: px per metre, shrink until it fits ---
  const PAD = 4;
  for (let attempt = 0; attempt < 12; attempt++) {
    for (const it of atlasItems) {
      const wpx = Math.max(16, Math.round(it.w * density)), hpx = Math.max(16, Math.round(it.h * density));
      const k = Math.min(1, 1024 / wpx, 1024 / hpx);  // cap one face at 1024 px
      it.pw = Math.round(wpx * k); it.ph = Math.round(hpx * k); it.wp = it.pw + PAD * 2; it.hp = it.ph + PAD * 2;
    }
    const boxes = atlasItems.map((it) => ({ w: it.wp, h: it.hp }));
    if (packShelves(boxes, ATLAS)) { atlasItems.forEach((it, i) => { it.x = boxes[i].x + PAD; it.y = boxes[i].y + PAD; }); break; }
    density *= 0.85;
  }
  for (const it of atlasItems) {
    const uvr = [it.x / ATLAS, 1 - (it.y + it.ph) / ATLAS, (it.x + it.pw) / ATLAS, 1 - it.y / ATLAS];
    for (const q of it.quads) {
      if (q.back) faceQuad(houseBuf, add3(q.c, q.m, -0.04), q.m, q.w, q.h, null, q.back); // dark returns behind letters (parallax)
      faceQuad(q.buf, q.c, q.m, q.w, q.h, uvr, q.col, q.fk);
    }
  }

  // --- atlas canvas ---
  const canvas = makeCanvas(ATLAS, ATLAS);
  const atlasTex = canvas ? new THREE.CanvasTexture(canvas) : null;
  const paintAtlas = () => {
    if (!canvas) return 0;
    const t = (typeof performance !== 'undefined' ? performance.now() : 0);
    const g = canvas.getContext('2d'); g.clearRect(0, 0, ATLAS, ATLAS);
    for (const it of atlasItems) {
      const R = new Rng(it.spec.seed);
      // bleed pad for mips: fill the padded rect with the design's edge colour first (channel/neon/window keep alpha 0 / black)
      paintSign(g, it.spec, it.x, it.y, it.pw, it.ph, R);
    }
    if (atlasTex) { atlasTex.needsUpdate = true; }
    return (typeof performance !== 'undefined' ? performance.now() : 0) - t;
  };
  if (atlasTex) { atlasTex.colorSpace = THREE.SRGBColorSpace; atlasTex.anisotropy = ctx.anisotropy ?? 8; atlasTex.generateMipmaps = true; atlasTex.minFilter = THREE.LinearMipmapLinearFilter; }

  // --- materials ---
  const flickerPatch = (m) => {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime; sh.uniforms.uNit = nit;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 flk; uniform float uTime; uniform float uNit;')
        .replace('#include <color_vertex>', `#include <color_vertex>
          float fl = 1.0;
          if (flk.y > 0.0) { float tt = uTime * flk.x + flk.z * 37.0; float n = fract(sin(floor(tt) * 12.9898 + flk.z * 78.233) * 43758.5453);
            fl = 1.0 - flk.y * step(0.55, n) * (0.6 + 0.4 * fract(tt * 3.7)); }
          vColor.rgb *= fl * uNit;`);
    };
    m.customProgramCacheKey = () => 'seoul-signs-flk';
    return m;
  };
  const litMat = flickerPatch(new THREE.MeshBasicMaterial({ map: atlasTex, vertexColors: true, alphaTest: 0.35, side: THREE.FrontSide, fog: false }));
  const neonMat = flickerPatch(new THREE.MeshBasicMaterial({ map: atlasTex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  const offMat = new THREE.MeshStandardMaterial({ map: atlasTex, color: new THREE.Color(0.55, 0.55, 0.55), roughness: 0.55, metalness: 0, alphaTest: 0.35 });
  const houseMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 });
  const meshes = {};
  const addMesh = (name, buf, mat, order = 0) => { const g = buf.geometry(); if (!g) return; if (mat === offMat || mat === houseMat) g.deleteAttribute('flk');
    const m = new THREE.Mesh(g, mat); m.name = 'signs-' + name; m.renderOrder = order; m.matrixAutoUpdate = false; group.add(m); meshes[name] = m; };
  addMesh('housing', houseBuf, houseMat); addMesh('lit', litBuf, litMat); addMesh('off', offBuf, offMat); addMesh('neon', neonBuf, neonMat, 2);

  // --- text atlas for screens + scrollers ---
  const TROWS = SCREEN_TEXT.length, TW = 1024, TH = 96;
  const tcan = makeCanvas(TW, TROWS * TH); const textTex = tcan ? new THREE.CanvasTexture(tcan) : null;
  const SROWS = SCROLL_TEXT.length, SW = 2048, SH = 16;
  const scan = makeCanvas(SW, SROWS * SH); const scrollTex = scan ? new THREE.CanvasTexture(scan) : null;
  if (textTex) { textTex.colorSpace = THREE.NoColorSpace; textTex.generateMipmaps = false; textTex.minFilter = THREE.LinearFilter; }
  if (scrollTex) { scrollTex.colorSpace = THREE.NoColorSpace; scrollTex.generateMipmaps = false; scrollTex.minFilter = THREE.NearestFilter; scrollTex.magFilter = THREE.NearestFilter; }
  const paintText = () => {
    if (tcan) {
      const g = tcan.getContext('2d'); g.clearRect(0, 0, TW, TROWS * TH);
      SCREEN_TEXT.forEach((s, i) => {
        if (i === TROWS - 1) { for (let k = 0; k < 11; k++) fitText(g, s[k], 'S2 Gothic', '', k * TW / 11, i * TH, TW / 11, TH, { k: 0.95 }); }
        else fitText(g, s, i % 2 ? 'S2 Sans' : 'S2 BlackHan', i % 2 ? '800' : '', 8, i * TH + 4, TW - 16, TH - 8, { k: 0.8 });
      });
      textTex.needsUpdate = true;
    }
    if (scan) {
      const g = scan.getContext('2d'); g.clearRect(0, 0, SW, SROWS * SH); g.textBaseline = 'middle';
      SCROLL_TEXT.forEach((s, i) => { g.font = `15px "S2 DoHyeon", ${FALLBACK}`; g.fillStyle = '#fff'; g.fillText(s + s + s, 0, i * SH + SH / 2 + 1); });
      // hard-threshold so dots are on/off like a real 16-row matrix
      const im = g.getImageData(0, 0, SW, SROWS * SH); for (let i = 3; i < im.data.length; i += 4) im.data[i] = im.data[i] > 110 ? 255 : 0; g.putImageData(im, 0, 0);
      scrollTex.needsUpdate = true;
    }
  };

  // --- scrollers mesh ---
  if (scrollItems.length) {
    const p = [], uv = [], aS = [], aC = [], nrm = [];
    for (const s of scrollItems) {
      const F = s.frame, G = s.geo, n = [F.n[0], 0, F.n[1]], r = [F.r[0], 0, F.r[1]];
      const c = pos3(F, G.u + G.w / 2, G.y + G.h / 2, 0.08);
      box(houseBuf, add3(c, n, -0.04), r, n, G.w / 2 + 0.04, G.h / 2 + 0.04, 0.04, RACE, true); // (housing built before mesh? add below)
      const cols = Math.round(G.w / (G.h / 16));
      const hue = s.lit ? pick(new Rng(s.seed), [['red', 0.6], ['amber', 0.25], ['green', 0.15]].flatMap(([h, w]) => Array(Math.round(w * 20)).fill(h))) : 'red';
      const cl = srgb(HEX[hue]); const k = s.lit ? s.nits / Math.max(0.05, lum(cl)) : 0;
      const rr = cross(UP, n); const P = [add3(add3(c, rr, -G.w / 2), UP, -G.h / 2), add3(add3(c, rr, G.w / 2), UP, -G.h / 2), add3(add3(c, rr, G.w / 2), UP, G.h / 2), add3(add3(c, rr, -G.w / 2), UP, G.h / 2)];
      const U = [[0, 0], [1, 0], [1, 1], [0, 1]];
      for (const i of [0, 1, 2, 0, 2, 3]) { p.push(...P[i]); uv.push(...U[i]); nrm.push(...n); aS.push(s.scrollRow, 7 + (s.seed % 6), cols, s.seed % 500); aC.push(cl[0] * k, cl[1] * k, cl[2] * k); }
      if (s.lit) emitters.push({ id: s.id, pos: c.map((v) => +v.toFixed(3)), normal: n, w: G.w, h: G.h, rgb: norm1(cl).map((v) => +v.toFixed(4)), nits: Math.round(s.nits * COVER.scroller), kind: 'screen', animated: true, use: s.use, lot: s.lot });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 4)); g.setAttribute('aC', new THREE.Float32BufferAttribute(aC, 3)); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: SCROLL_VERT, fragmentShader: SCROLL_FRAG, extensions: { derivatives: true },
      uniforms: { uText: { value: scrollTex }, uT: uTime, uRows: { value: SROWS }, uTexW: { value: SW }, uNit: nit } }));
    m.name = 'signs-scrollers'; m.matrixAutoUpdate = false; group.add(m); meshes.scrollers = m;
    // the scroller housings were appended to houseBuf after its mesh was built: rebuild housing geometry
    if (meshes.housing) { meshes.housing.geometry.dispose(); const hg = houseBuf.geometry(); hg.deleteAttribute('flk'); meshes.housing.geometry = hg; }
  }

  // --- LED screens ---
  const screenObjs = [];
  for (const sc of screens) {
    const pl = makePlaylist(sc.seed, sc.kind);
    const pitch = sc.kind === 'billboard' ? 0.016 : sc.kind === 'facade' ? 0.010 : 0.0025;      // m per LED pixel
    const res = [Math.round(sc.w / pitch), Math.round(sc.h / pitch)];
    const r = new Rng(sc.seed ^ 0x9e37);
    const scanHz = sc.kind === 'small' ? pick(r, [960, 1920, 3840]) : pick(r, [240, 480, 960, 1920]);
    const bandDepth = { 240: 0.42, 480: 0.3, 960: 0.18, 1920: 0.09, 3840: 0.04 }[scanHz];
    const nitsRange = sc.kind === 'small' ? NITS.screenSmall : NITS.screen; const nits = nitsRange[0] + (nitsRange[1] - nitsRange[0]) * r.next();
    const u = {
      uT: { value: 0 }, uLT: { value: 0 }, uNits: { value: nits }, uNit: nit, uMoire: { value: ctx.moire ?? 0.6 }, uBandDepth: { value: bandDepth },
      uBandN: { value: scanHz * (ctx.readout ?? 0.011) }, uBandRate: { value: 0.35 + r.next() * 0.9 }, uViewH: { value: 1080 }, uSeed: { value: r.next() * 10 },
      uBlack: { value: 0.0015 }, uCut: { value: 0 }, uRes: { value: new THREE.Vector2(res[0], res[1]) }, uProg: { value: 0 },
      uC0: { value: new THREE.Vector3() }, uC1: { value: new THREE.Vector3() }, uC2: { value: new THREE.Vector3() }, uRow: { value: new THREE.Vector2(-1, -1) },
      uText: { value: textTex }, uRows: { value: TROWS },
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: SCREEN_VERT, fragmentShader: SCREEN_FRAG, uniforms: u, extensions: { derivatives: true } });
    const geo = new THREE.PlaneGeometry(sc.w, sc.h);
    const mesh = new THREE.Mesh(geo, mat); mesh.name = 'screen-' + sc.id;
    const nn = new THREE.Vector3(sc.normal[0], sc.normal[1] || 0, sc.normal[2]).normalize();
    mesh.position.set(sc.pos[0], sc.pos[1], sc.pos[2]).addScaledVector(nn, 0.05);
    mesh.lookAt(mesh.position.clone().add(nn));
    mesh.onBeforeRender = (renderer) => { const rt = renderer.getRenderTarget(); u.uViewH.value = rt ? rt.height : renderer.domElement.height; };
    group.add(mesh);
    // cabinet behind the panel, and a truss for rooftop billboards
    const fr = [nn.z, 0, -nn.x], c = [sc.pos[0] - nn.x * 0.15, sc.pos[1], sc.pos[2] - nn.z * 0.15];
    box(houseBuf, c, fr, [nn.x, 0, nn.z], sc.w / 2 + 0.12, sc.h / 2 + 0.12, 0.2, HOUSE);
    if (sc.kind === 'billboard') { const bot = sc.pos[1] - sc.h / 2; const lot = (layout.lots || []).find((l) => l.id === sc.lot); const roof = lot ? lot.floors * (lot.floorH || 3.2) : bot - 3;
      for (const k of [-0.4, 0, 0.4]) box(houseBuf, [c[0] + fr[0] * sc.w * k - nn.x * 0.6, (bot + roof) / 2, c[2] + fr[2] * sc.w * k - nn.z * 0.6], fr, [nn.x, 0, nn.z], 0.08, Math.max(0.1, (bot - roof) / 2), 0.08, STEEL); }
    const em = { id: sc.id, pos: [sc.pos[0] + nn.x * 0.05, sc.pos[1], sc.pos[2] + nn.z * 0.05].map((v) => +v.toFixed(3)), normal: [nn.x, 0, nn.z], w: sc.w, h: sc.h,
      rgb: [1, 1, 1], nits: 0, kind: 'screen', animated: true, lot: sc.lot, screenKind: sc.kind };
    emitters.push(em);
    screenObjs.push({ sc, pl, u, mesh, em, nits, res, scanHz });
  }
  if (meshes.housing && screens.length) { meshes.housing.geometry.dispose(); const hg = houseBuf.geometry(); hg.deleteAttribute('flk'); meshes.housing.geometry = hg; }

  const tmp = [0, 0, 0];
  function update(t, camPos) {
    uTime.value = t;
    for (const o of screenObjs) {
      const { pl, u, em } = o; const lt0 = fract((t + pl.phase) / pl.len) * pl.len;
      let seg = pl.list[0]; for (const s of pl.list) if (lt0 >= s.t0) seg = s;
      const lt = lt0 - seg.t0;
      u.uT.value = t; u.uLT.value = lt; u.uProg.value = seg.prog; u.uCut.value = lt < 1 / 30 ? 1 : 0;
      u.uC0.value.set(...seg.pal[0]); u.uC1.value.set(...seg.pal[1]); u.uC2.value.set(...seg.pal[2]);
      u.uRow.value.set(seg.text[0], seg.text[1]);
      const m = programMean(seg, lt); const y = lum(m);
      tmp[0] = m[0]; tmp[1] = m[1]; tmp[2] = m[2];
      const nn = norm1(tmp); em.rgb[0] = nn[0]; em.rgb[1] = nn[1]; em.rgb[2] = nn[2];
      em.nits = Math.round(o.nits * y * (1 - 0.85 * u.uCut.value) + 0.5);
    }
    void camPos;
  }

  let fontsReady = false;
  const repaint = () => { const ms = paintAtlas(); paintText(); return ms; };
  const paintMs = repaint();
  if (ctx.loadFonts !== false && canvas) loadFonts(ctx.fontBase).then((ok) => { fontsReady = ok; repaint(); if (ctx.onFonts) ctx.onFonts(ok); });

  const stats = { ...signStats(specs), emitters: emitters.length, screens: screens.length, atlas: ATLAS, pxPerM: +density.toFixed(1),
    drawCalls: group.children.length, tris: group.children.reduce((a, m) => a + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0),
    buildMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0), paintMs: Math.round(paintMs) };
  update(0);
  return {
    group, emitters, update, specs, screens: screenObjs, stats, atlas: atlasTex, canvas,
    setNitScale(k) { nit.value = k; }, get nitScale() { return nit.value; },
    setMoire(k) { for (const o of screenObjs) o.u.uMoire.value = k; },
    get fontsReady() { return fontsReady; }, repaint,
    dispose() { group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); atlasTex?.dispose(); textTex?.dispose(); scrollTex?.dispose(); },
  };
}

export const seoulSigns = { build, generateSigns, signStats, loadFonts, NIT_SCALE, CENSUS, SHIPPED, PUSH_BY_KIND };
export default seoulSigns;
