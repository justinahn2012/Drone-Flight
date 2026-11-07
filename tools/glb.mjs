// tools/glb.mjs — a minimal, deterministic glTF 2.0 binary (GLB) writer for static meshes, plus a header reader.
// Why not three's GLTFExporter: in node it needs FileReader/Blob shims, and it names a lone `uv2` TEXCOORD_2
// (glTF requires TEXCOORD_n to be contiguous from 0). Here: same input -> byte-identical output, every attribute kept.
//
// Attribute naming (three.js -> glTF):
//   position POSITION, normal NORMAL, tangent TANGENT, color COLOR_0,
//   uv / uv1 / uv2 / uv3 -> TEXCOORD_0.. in that order, numbered contiguously over the ones present,
//   anything else -> '_' + NAME.toUpperCase() (aY -> _AY), per the spec's application-specific rule.
// Each primitive's `extras.attributes` maps glTF semantic -> three.js name, so loaders can restore the exact names.

const GLTF_TYPE = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4', 9: 'MAT3', 16: 'MAT4' };
const COMP = (arr) =>
  arr instanceof Float32Array ? 5126 : arr instanceof Uint32Array ? 5125 : arr instanceof Uint16Array ? 5123 :
  arr instanceof Int16Array ? 5122 : arr instanceof Uint8Array ? 5121 : arr instanceof Int8Array ? 5120 : 0;
const UV_ORDER = ['uv', 'uv1', 'uv2', 'uv3'];
const FIXED = { position: 'POSITION', normal: 'NORMAL', tangent: 'TANGENT', color: 'COLOR_0' };

/** glTF semantic for each three.js attribute name of one geometry: { threeName: semantic }. */
export function semanticsFor(names) {
  const out = {}; let t = 0;
  for (const k of UV_ORDER) if (names.includes(k)) out[k] = 'TEXCOORD_' + t++;
  for (const k of names) if (!out[k]) out[k] = FIXED[k] || '_' + k.toUpperCase();
  return out;
}

export class GLBWriter {
  constructor(generator) {
    this.json = { asset: { version: '2.0', generator }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }] };
    this.chunks = []; this.byteLength = 0; this.matIndex = new Map();
  }
  _view(typed, target) {
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad) { this.chunks.push(new Uint8Array(pad)); this.byteLength += pad; }
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    this.chunks.push(bytes.slice());            // copy: the caller's buffers may be views into shared memory
    const v = { buffer: 0, byteOffset: this.byteLength, byteLength: bytes.byteLength };
    if (target) v.target = target;
    this.byteLength += bytes.byteLength;
    this.json.bufferViews.push(v);
    return this.json.bufferViews.length - 1;
  }
  /** typed: TypedArray (de-interleaved). itemSize: components per element. */
  accessor(typed, itemSize, { target, minmax = false, normalized = false } = {}) {
    let arr = typed, comp = COMP(arr);
    if (!comp || (comp === 5125 && target !== 34963)) { arr = Float32Array.from(arr); comp = 5126; }   // UNSIGNED_INT is index-only in glTF
    const count = arr.length / itemSize;
    if (!Number.isInteger(count)) throw new Error('glb: array length not a multiple of itemSize');
    const acc = { bufferView: this._view(arr, target), componentType: comp, count, type: GLTF_TYPE[itemSize] };
    if (normalized && comp !== 5126 && comp !== 5125) acc.normalized = true;   // not allowed on float / uint32
    if (minmax && count) {
      const mn = new Array(itemSize).fill(Infinity), mx = new Array(itemSize).fill(-Infinity);
      for (let i = 0; i < arr.length; i++) { const c = i % itemSize, v = arr[i]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
      acc.min = mn; acc.max = mx;
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }
  material(key, def) {
    if (this.matIndex.has(key)) return this.matIndex.get(key);
    this.json.materials.push(def);
    this.matIndex.set(key, this.json.materials.length - 1);
    return this.json.materials.length - 1;
  }
  /**
   * Add a node + single-primitive mesh. attrs: { threeName: { array, itemSize, normalized? } }, index: TypedArray|null.
   * POSITION may be shared by passing { accessor: n } instead of { array }.
   */
  mesh(name, attrs, index, { material, extras, nodeExtras, primExtras, mode = 4 } = {}) {
    const sem = semanticsFor(Object.keys(attrs));
    const prim = { attributes: {}, mode };
    const map = {};
    for (const k of Object.keys(attrs)) {
      const a = attrs[k];
      prim.attributes[sem[k]] = a.accessor ?? this.accessor(a.array, a.itemSize, { target: 34962, minmax: a.array instanceof Float32Array, normalized: !!a.normalized });
      map[sem[k]] = k;
    }
    if (index) {
      let idx = index;
      if (!(idx instanceof Uint16Array || idx instanceof Uint32Array || idx instanceof Uint8Array)) idx = Uint32Array.from(idx);
      prim.indices = this.accessor(idx, 1, { target: 34963 });
    }
    if (material != null) prim.material = material;
    prim.extras = { attributes: map, ...(primExtras || {}) };
    const mesh = { name, primitives: [prim] }; if (extras) mesh.extras = extras;
    this.json.meshes.push(mesh);
    const node = { name, mesh: this.json.meshes.length - 1 }; if (nodeExtras) node.extras = nodeExtras;
    this.json.nodes.push(node);
    this.json.scenes[0].nodes.push(this.json.nodes.length - 1);
    return this.json.meshes.length - 1;
  }
  /** -> Uint8Array of the .glb */
  toGLB() {
    const enc = new TextEncoder();
    this.json.buffers[0].byteLength = this.byteLength;
    if (!this.json.materials.length) delete this.json.materials;
    let js = enc.encode(JSON.stringify(this.json));
    const jsPad = (4 - (js.length % 4)) % 4, binPad = (4 - (this.byteLength % 4)) % 4;
    const jsLen = js.length + jsPad, binLen = this.byteLength + binPad;
    const total = 12 + 8 + jsLen + (binLen ? 8 + binLen : 0);
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jsLen, true); dv.setUint32(16, 0x4e4f534a, true);
    out.set(js, 20); out.fill(0x20, 20 + js.length, 20 + jsLen);
    if (binLen) {
      let o = 20 + jsLen; dv.setUint32(o, binLen, true); dv.setUint32(o + 4, 0x004e4942, true); o += 8;
      for (const c of this.chunks) { out.set(c, o); o += c.byteLength; }
    }
    return out;
  }
}

/** Parse a .glb container: -> { json, bin: Uint8Array|null }. Throws on a malformed header or chunk layout. */
export function readGLB(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('glb: bad magic');
  if (dv.getUint32(4, true) !== 2) throw new Error('glb: version != 2');
  if (dv.getUint32(8, true) !== u8.byteLength) throw new Error('glb: length mismatch');
  const jl = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a || jl % 4) throw new Error('glb: bad JSON chunk');
  const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + jl)));
  let bin = null, o = 20 + jl;
  if (o < u8.byteLength) {
    const bl = dv.getUint32(o, true);
    if (dv.getUint32(o + 4, true) !== 0x004e4942 || bl % 4) throw new Error('glb: bad BIN chunk');
    bin = u8.subarray(o + 8, o + 8 + bl);
  }
  return { json, bin };
}
