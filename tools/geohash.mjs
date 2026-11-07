// tools/geohash.mjs — the geometry hash shared by the exporter, its round-trip test and (if wanted) the runtime /
// lightmap check. Dependency-free: runs in node and the browser. ~3 ms per million words.
//
// Algorithm "mm3x2/1" (simple to re-implement in Swift for the native golden tests):
//   two MurmurHash3_x86_32 body lanes over a stream of uint32 words, seeds 0x9747b28c and 0x2f0f5d1b;
//   per word k:  k = k*0xcc9e2d51; k = rotl(k,15); k = k*0x1b873593; h ^= k; h = rotl(h,13); h = h*5 + 0xe6546b64
//   (all mod 2^32). Finish each lane with h ^= wordCount, then fmix32; output = hex8(lane1) + hex8(lane2).
// Word streams:
//   string  -> length, then each UTF-16 code unit
//   array   -> element count, then per element: Float32 -> its IEEE-754 bit pattern; integer types -> value as uint32
//   mesh    -> name, vertex count, then per attribute in sorted name order: name, itemSize, data;
//              then 'index' + the index array, or 'noindex'
// Attribute names are three.js names (position, normal, uv, aY, uv1/uv2, color...), not glTF semantics.

const C1 = 0xcc9e2d51, C2 = 0x1b873593;
const rotl = (x, r) => (x << r) | (x >>> (32 - r));
const fmix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };

export class GeoHash {
  constructor() { this.a = 0x9747b28c | 0; this.b = 0x2f0f5d1b | 0; this.n = 0; }
  word(w) {
    let k = Math.imul(w | 0, C1); k = rotl(k, 15); k = Math.imul(k, C2);
    let a = this.a ^ k; a = rotl(a, 13); this.a = (Math.imul(a, 5) + 0xe6546b64) | 0;
    let b = this.b ^ k; b = rotl(b, 13); this.b = (Math.imul(b, 5) + 0xe6546b64) | 0;
    this.n++;
    return this;
  }
  str(s) { s = String(s); this.word(s.length); for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i)); return this; }
  array(arr) {
    const n = arr.length; this.word(n);
    let w = arr;
    if (arr instanceof Float32Array) w = new Uint32Array(arr.buffer, arr.byteOffset, n);
    else if (arr instanceof Float64Array) w = new Uint32Array(new Float32Array(arr).buffer);   // hashed as float32
    // inline the body for speed on big arrays
    let a = this.a, b = this.b;
    for (let i = 0; i < n; i++) {
      let k = Math.imul(w[i] | 0, C1); k = rotl(k, 15); k = Math.imul(k, C2);
      a ^= k; a = rotl(a, 13); a = (Math.imul(a, 5) + 0xe6546b64) | 0;
      b ^= k; b = rotl(b, 13); b = (Math.imul(b, 5) + 0xe6546b64) | 0;
    }
    this.a = a; this.b = b; this.n += n;
    return this;
  }
  hex() {
    const a = fmix((this.a ^ this.n) >>> 0), b = fmix((this.b ^ this.n) >>> 0);
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
}
export const HASH_ALGO = 'mm3x2/1';

/** Raw (de-interleaved, unnormalised) component array of a three.js BufferAttribute-like {array, itemSize, count}. */
export function attrArray(a) {
  if (!a.isInterleavedBufferAttribute) return a.array;
  const T = a.array.constructor, out = new T(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.data.array[i * a.data.stride + a.offset + c];
  return out;
}

/** Feed one mesh: name + a three.js BufferGeometry (or {attributes:{name:{array,itemSize,count}}, index:{array}}). */
export function hashMesh(h, name, geo) {
  const attrs = geo.attributes, names = Object.keys(attrs).sort();
  h.str(name).word(attrs.position.count);
  for (const k of names) { const a = attrs[k]; h.str(k).word(a.itemSize).array(attrArray(a)); }
  if (geo.index) h.str('index').array(geo.index.array); else h.str('noindex');
  return h;
}

/** Hash of one mesh on its own (for per-mesh diffs). */
export const meshHash = (name, geo) => hashMesh(new GeoHash(), name, geo).hex();

/** Hash of an ordered list of [name, geometry] (the render set, or the collider). */
export function setHash(tag, list) {
  const h = new GeoHash().str(tag).word(list.length);
  for (const [name, geo] of list) hashMesh(h, name, geo);
  return h.hex();
}
