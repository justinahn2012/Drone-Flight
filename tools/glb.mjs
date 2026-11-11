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

// ---- [P4 H, native #4] compression: EXT_meshopt_compression (lossless byte codec) over KHR_mesh_quantization
// (lossy, bounded) vertex formats. A packed mesh's attributes go through a meshopt filter first:
//   'expN'  float -> EXPONENTIAL filter, N-bit signed mantissa per component ('Separate': relative error 2^-(N-1));
//           integers below 2^(N-1) stay exact. The accessor stays FLOAT.
//   'octN'  unit vectors -> OCTAHEDRAL filter, N bits (<= 8: int8 x4, else int16 x4), accessor VEC3 BYTE / SHORT normalized
//   'raw'   the bytes as given (lossless), padded to a 4-byte stride
// then deduplicated (optional, on the quantized bytes), reordered (vertex cache / fetch) and meshopt-encoded. Decoders:
// meshoptimizer's C library (meshopt_decodeVertexBuffer / IndexBuffer / IndexSequence + decodeFilterExp / Oct), three's
// GLTFLoader with MeshoptDecoder. Same input -> same bytes (the encoder is deterministic).
export async function meshoptEncoder() {
  const { MeshoptEncoder } = await import('meshoptimizer');
  await MeshoptEncoder.ready;
  return MeshoptEncoder;
}
export async function meshoptDecoder() {
  const { MeshoptDecoder } = await import('meshoptimizer');
  await MeshoptDecoder.ready;
  return MeshoptDecoder;
}
const pad4 = (n) => (n + 3) & ~3;
/** One attribute in its packed element form: { bytes (count x stride), stride, comp, type, normalized, filter, note }. */
function packAttr(E, a, count, how) {
  const k = a.itemSize, arr = a.array;
  if (how.startsWith('oct') && arr instanceof Float32Array && (k === 3 || k === 4)) {
    const bits = +how.slice(3), wide = bits > 8, stride = wide ? 8 : 4, v4 = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) { v4[i * 4] = arr[i * k]; v4[i * 4 + 1] = arr[i * k + 1]; v4[i * 4 + 2] = arr[i * k + 2]; v4[i * 4 + 3] = k === 4 ? arr[i * k + 3] : 1; }
    return { bytes: E.encodeFilterOct(v4, count, stride, bits), stride, comp: wide ? 5122 : 5120, type: k, normalized: true, filter: 'OCTAHEDRAL', quant: true, note: `oct ${bits}-bit (${wide ? 'int16' : 'int8'} x4)` };
  }
  if (how.startsWith('exp') && arr instanceof Float32Array) {
    const bits = +how.slice(3), stride = 4 * k;
    return { bytes: E.encodeFilterExp(arr, count, stride, bits, 'Separate'), stride, comp: 5126, type: k, normalized: false, filter: 'EXPONENTIAL', note: `float, ${bits}-bit mantissa (exp filter)` };
  }
  let src = arr; if (!COMP(src) || src instanceof Uint32Array) src = Float32Array.from(src);
  const es = src.BYTES_PER_ELEMENT * k, stride = pad4(es), b = new Uint8Array(src.buffer, src.byteOffset, count * es);
  let bytes = b.slice();
  if (stride !== es) { bytes = new Uint8Array(count * stride); for (let i = 0; i < count; i++) bytes.set(b.subarray(i * es, i * es + es), i * stride); }
  return { bytes, stride, comp: COMP(src), type: k, normalized: !!a.normalized && COMP(src) !== 5126, filter: null, quant: COMP(src) !== 5126, note: 'lossless' };
}
/** Exact decode of an EXPONENTIAL-filtered float (int32: exponent byte, 24-bit signed mantissa). */
const expValue = (w) => Math.fround(((w << 8) >> 8) * 2 ** (w >> 24));

export class GLBWriter {
  constructor(generator, { meshopt = null } = {}) {
    this.json = { asset: { version: '2.0', generator }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }] };
    this.chunks = []; this.byteLength = 0; this.matIndex = new Map();
    this.E = meshopt; this.fallback = 0; this.quantized = false;   // [P4 H] meshopt encoder; fallback buffer length (no data)
  }
  /** [P4 H] a meshopt-compressed bufferView: data in buffer 0 (the BIN chunk), the view's own range in buffer 1 (fallback: no data). */
  _mview(raw, count, stride, mode, filter, target) {
    const enc = this.E.encodeGltfBuffer(raw, count, stride, mode);
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad) { this.chunks.push(new Uint8Array(pad)); this.byteLength += pad; }
    this.chunks.push(enc);
    const ext = { buffer: 0, byteOffset: this.byteLength, byteLength: enc.byteLength, byteStride: stride, count, mode };
    if (filter) ext.filter = filter;
    this.byteLength += enc.byteLength;
    const v = { buffer: 1, byteOffset: this.fallback, byteLength: count * stride, extensions: { EXT_meshopt_compression: ext } };
    if (mode === 'ATTRIBUTES') v.byteStride = stride;
    if (target) v.target = target;
    this.fallback += pad4(count * stride);
    this.json.bufferViews.push(v);
    return this.json.bufferViews.length - 1;
  }
  /**
   * [P4 H] A packed mesh (needs `meshopt` in the constructor). attrs as mesh(); pack: { quant: { threeName: 'exp20' |
   * 'oct12' | 'raw' }, dedupe (merge identical quantized vertices), reorder: 'cache' (vertex cache + fetch: triangle
   * order changes) | 'fetch' (vertex order only: triangles keep their order) | false, index: 'TRIANGLES' (triangle order
   * kept, a triangle's vertices may rotate) | 'INDICES' (the exact sequence) }. -> { mesh, vertices, indices, attributes }
   */
  meshPacked(name, attrs, index, { material, extras, nodeExtras, primExtras, mode = 4 } = {}, pack = {}) {
    if (!this.E) throw new Error('glb: meshPacked needs new GLBWriter(gen, { meshopt: await meshoptEncoder() })');
    const names = Object.keys(attrs), sem = semanticsFor(names), n = attrs.position.array.length / attrs.position.itemSize;
    const P = names.map((k) => [k, packAttr(this.E, attrs[k], n, pack.quant?.[k] || 'raw')]);
    // index over the packed vertices: the given one, or 0..n-1; then merge identical vertices (all attributes' bytes)
    let idx = index ? Uint32Array.from(index) : null, nv = n, src = null, toNew = null;   // toNew: original vertex -> packed vertex
    const idx0 = idx ? idx.slice() : null;
    if (pack.dedupe) {
      const key = new Map(), remap = new Uint32Array(n), first = []; const W = P.reduce((s, [, p]) => s + p.stride, 0), row = Buffer.alloc(W);
      for (let i = 0; i < n; i++) {
        let o = 0; for (const [, p] of P) { row.set(p.bytes.subarray(i * p.stride, i * p.stride + p.stride), o); o += p.stride; }
        const s = row.toString('latin1'); let id = key.get(s); if (id === undefined) { id = first.length; key.set(s, id); first.push(i); } remap[i] = id;
      }
      idx = idx ? idx.map((v) => remap[v]) : remap.slice(); nv = first.length; src = Uint32Array.from(first); toNew = remap;   // (a copy: reorderMesh rewrites idx in place)
    }
    if (idx && pack.reorder) {
      const [rm, nu] = this.E.reorderMesh(idx, pack.reorder === 'cache', true);   // rewrites idx in place (new vertex ids)
      const s2 = new Uint32Array(nu); for (let j = 0; j < nv; j++) if (rm[j] !== 0xffffffff) s2[rm[j]] = src ? src[j] : j;
      toNew = toNew ? toNew.map((v) => rm[v]) : rm;
      src = s2; nv = nu;
    }
    const views = [];   // for the self-check: [attribute name, view, packed attr] / ['index', view, it]
    const prim = { attributes: {}, mode }, map = {}, notes = {};
    for (const [k, p] of P) {
      let bytes = p.bytes;
      if (src) { bytes = new Uint8Array(nv * p.stride); for (let j = 0; j < nv; j++) bytes.set(p.bytes.subarray(src[j] * p.stride, src[j] * p.stride + p.stride), j * p.stride); }
      const view = this._mview(bytes, nv, p.stride, 'ATTRIBUTES', p.filter, 34962); views.push([k, view, p]);
      const acc = { bufferView: view, componentType: p.comp, count: nv, type: GLTF_TYPE[p.type] };
      if (p.normalized) acc.normalized = true;
      if (p.quant) this.quantized = true;
      if (sem[k] === 'POSITION') {   // exact bounds of the decoded values
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let j = 0; j < nv; j++) for (let c = 0; c < p.type; c++) { const w = p.filter === 'EXPONENTIAL' ? expValue(dv.getInt32(j * p.stride + c * 4, true)) : dv.getFloat32(j * p.stride + c * 4, true); if (w < mn[c]) mn[c] = w; if (w > mx[c]) mx[c] = w; }
        acc.min = mn; acc.max = mx;
      }
      this.json.accessors.push(acc);
      prim.attributes[sem[k]] = this.json.accessors.length - 1; map[sem[k]] = k; notes[sem[k]] = p.note;
    }
    if (idx) {
      const wide = nv > 65535, it = wide ? idx : Uint16Array.from(idx), es = wide ? 4 : 2;
      const raw = new Uint8Array(it.buffer, it.byteOffset, it.byteLength);
      const view = this._mview(raw, it.length, es, pack.index || 'TRIANGLES', null, 34963); views.push(['index', view, it]);
      this.json.accessors.push({ bufferView: view, componentType: wide ? 5125 : 5123, count: it.length, type: 'SCALAR' });
      prim.indices = this.json.accessors.length - 1;
    }
    if (material != null) prim.material = material;
    prim.extras = { attributes: map, ...(primExtras || {}) };
    const mesh = { name, primitives: [prim] }; if (extras) mesh.extras = extras;
    this.json.meshes.push(mesh);
    const node = { name, mesh: this.json.meshes.length - 1 }; if (nodeExtras) node.extras = nodeExtras;
    this.json.nodes.push(node);
    this.json.scenes[0].nodes.push(this.json.nodes.length - 1);
    const problems = pack.verify ? this._verify(pack.verify, name, attrs, n, nv, src, toNew, idx0, views, pack) : null;
    return { mesh: this.json.meshes.length - 1, vertices: nv, indices: idx ? idx.length : 0, attributes: notes, index: idx ? (pack.index || 'TRIANGLES') + (nv > 65535 ? ' uint32' : ' uint16') : null, problems };
  }
  /**
   * [P4 H] Decode what was just written with an independent decoder (three's MeshoptDecoder) and hold it to the source:
   * every packed vertex against the source vertex it stands for (floats within the filter's bound: 2^-(N-2) relative
   * plus 1e-6 absolute; oct normals within 0.25 deg; raw bytes exact); triangles: the source's (through the vertex
   * merge / reorder) as a multiset, rotation allowed for TRIANGLES; INDICES must give the exact sequence. -> [problem]
   */
  _verify(D, name, attrs, n, nv, src, toNew, idx0, views, pack) {
    const bad = [], chunk = (v) => { const e = this.json.bufferViews[v].extensions.EXT_meshopt_compression; let o = 0, off = 0; for (const c of this.chunks) { if (off === e.byteOffset) return { e, c }; off += c.byteLength; o++; } return { e, c: null }; };
    const S = (j) => (src ? src[j] : j);
    for (const [k, v, p] of views) {
      const { e, c } = chunk(v); if (!c) { bad.push(`${name}: view ${v} not found`); continue; }
      if (k === 'index') {
        const out = new Uint8Array(e.count * e.byteStride); D.decodeGltfBuffer(out, e.count, e.byteStride, c, e.mode);
        const got = e.byteStride === 4 ? new Uint32Array(out.buffer) : new Uint16Array(out.buffer);
        const want = idx0 ? Uint32Array.from(idx0, (x) => (toNew ? toNew[x] : x)) : Uint32Array.from({ length: n }, (_, i) => toNew[i]);
        if (got.length !== want.length) { bad.push(`${name}: index count ${got.length} != ${want.length}`); continue; }
        if (e.mode === 'INDICES') { let m = 0; for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) m++; if (m) bad.push(`${name}: ${m} indices differ (INDICES must be exact)`); continue; }
        const canon = (a, t) => { const x = a[t * 3], y = a[t * 3 + 1], z = a[t * 3 + 2], r = [[x, y, z], [y, z, x], [z, x, y]].sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2])[0]; return r.join(','); };   // rotation-free (degenerate ties too)
        const T = got.length / 3;
        if (pack.reorder !== 'cache') { let m = 0; for (let t = 0; t < T; t++) if (canon(got, t) !== canon(want, t)) m++; if (m) bad.push(`${name}: ${m} of ${T} triangles differ (order must be kept)`); }
        else { const A = Array.from({ length: T }, (_, t) => canon(got, t)).sort(), B = Array.from({ length: T }, (_, t) => canon(want, t)).sort(); let m = 0; for (let t = 0; t < T; t++) if (A[t] !== B[t]) m++; if (m) bad.push(`${name}: ${m} of ${T} triangles differ`); }
        continue;
      }
      const out = new Uint8Array(nv * p.stride); D.decodeGltfBuffer(out, nv, p.stride, c, 'ATTRIBUTES', p.filter || undefined);
      const a = attrs[k], A = a.array, it = a.itemSize, dv = new DataView(out.buffer);
      let worst = 0, cnt = 0;
      if (p.filter === 'OCTAHEDRAL') {
        const sc = p.comp === 5122 ? 32767 : 127, rd = p.comp === 5122 ? (o) => dv.getInt16(o, true) : (o) => dv.getInt8(o);
        for (let j = 0; j < nv; j++) { const s0 = S(j) * it; let d = 0, l1 = 0, l2 = 0; for (let q = 0; q < 3; q++) { const g = Math.max(-1, rd(j * p.stride + q * (p.comp === 5122 ? 2 : 1)) / sc), w = A[s0 + q]; d += g * w; l1 += g * g; l2 += w * w; }
          const cs = l1 > 0 && l2 > 0 ? d / Math.sqrt(l1 * l2) : 1; if (l2 > 1e-12 && cs < Math.cos(0.25 * Math.PI / 180)) cnt++; worst = Math.max(worst, Math.acos(Math.min(1, cs)) * 180 / Math.PI); }
        if (cnt) bad.push(`${name}.${k}: ${cnt} normals off by more than 0.25 deg (worst ${worst.toFixed(3)})`);
      } else if (p.filter === 'EXPONENTIAL') {
        const bits = +String(pack.quant?.[k] || 'exp24').slice(3), rel = 2 ** -(bits - 2);
        for (let j = 0; j < nv; j++) for (let q = 0; q < it; q++) { const g = dv.getFloat32((j * it + q) * 4, true), w = A[S(j) * it + q], err = Math.abs(g - w), lim = rel * Math.abs(w) + 1e-6; if (!(err <= lim)) cnt++; if (err > worst) worst = err; }
        if (cnt) bad.push(`${name}.${k}: ${cnt} values past the ${bits}-bit bound (worst ${worst})`);
      } else {
        const es = A.BYTES_PER_ELEMENT * it, sb = new Uint8Array(A.buffer, A.byteOffset, A.byteLength);
        for (let j = 0; j < nv && cnt < 1; j++) for (let b = 0; b < es; b++) if (out[j * p.stride + b] !== sb[S(j) * es + b]) { cnt++; break; }
        if (cnt) bad.push(`${name}.${k}: lossless stream differs from the source`);
      }
    }
    return bad;
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
    if (this.fallback) {   // [P4 H] meshopt: buffer 1 is the decoded address space (no data); both extensions required
      this.json.buffers[1] = { byteLength: this.fallback, extensions: { EXT_meshopt_compression: { fallback: true } } };
      const ex = ['EXT_meshopt_compression', ...(this.quantized ? ['KHR_mesh_quantization'] : [])];
      this.json.extensionsUsed = ex; this.json.extensionsRequired = ex;
    }
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
