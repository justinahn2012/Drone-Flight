// rng.js: seeded random numbers shared by the flight model and the world build. Deterministic across runs and
// platforms: mulberry32 on uint32 state (integer ops only), so a Swift port reproduces the exact sequence.
//
//   const r = new Rng(seed);  r.next() -> [0, 1)   r.gauss() -> N(0, 1)   r.state / r.state = s  (snapshot/restore)
//   rng(seed) -> () => [0, 1)   same sequence as world-bando.js's local rng() (drop-in replacement)
//
// gauss() is Box-Muller, cosine branch only (one normal per two uniforms, no cached spare), so the state is the single
// uint32 and a snapshot is exact.

export class Rng {
  constructor(seed = 1) { this.s = seed >>> 0; }
  seed(s) { this.s = s >>> 0; return this; }
  get state() { return this.s; }
  set state(s) { this.s = s >>> 0; }
  next() {
    this.s = (this.s + 0x6D2B79F5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gauss() {
    let u = 0, v = 0;
    while (!u) u = this.next();
    while (!v) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

export function rng(seed) { const r = new Rng(seed); return () => r.next(); }
