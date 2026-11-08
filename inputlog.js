// inputlog.js: a compact, replayable record of a flight (native-readiness #1.3).
//
// A log holds everything Drone.step() consumed: the start state, then one quantised input per 1/240 s tick (and any
// mode switch). Replayed through the same flight.js on the same world (header.world = worldHash = world.json hash.collider) it reproduces the
// flight bit for bit; a port (Swift) replays it to within 1 mm, re-syncing on the snapshot stored every `every` ticks.
// Ghosts, challenge codes and clip re-renders can all be re-simulated from it instead of storing poses.
//
// Binary layout, little-endian (about 2.4 KB/s of input plus ~1.3 KB of snapshot per second):
//   'OTIL'  u32 version  u32 headerBytes  header JSON (utf-8, space-padded to 4 bytes)
//   u32 ticks  i16[ticks * 5] = (thr, pitch, roll, yaw, climb) * 32767, zero-padded to 4 bytes
//   u32 trailerBytes  trailer JSON {snaps: [{tick, s}], modes: [{tick, mode}]}
// header: {v, seed, world, craft, mode, hz, every, start: Drone.snapshot(), meta}
// snaps[k].s is the state before tick snaps[k].tick runs, i.e. after that many inputs.
//
// Caller contract (main.js frame()): per tick, quantize() the controls into a reusable object, record() it, then
// drone.step(1 / hz, thatObject, mode, world). The sim must see exactly the values the log stores.

import { setHash } from './geohash.js';

export const LOG_VERSION = 1;
export const CHANNELS = ['thr', 'pitch', 'roll', 'yaw', 'climb'];
const NC = CHANNELS.length, QMAX = 32767;
const MAGIC = 0x4C49544F;   // 'OTIL' read as a little-endian u32

const q16 = (v) => Math.round(Math.max(-1, Math.min(1, +v || 0)) * QMAX);

// stick values -> the exact values a replay will see (i16 / 32767)
export function quantize(src, out = {}) {
  for (let k = 0; k < NC; k++) out[CHANNELS[k]] = q16(src[CHANNELS[k]]) / QMAX;
  return out;
}

export class InputLog {
  constructor({ seed = 0, world = '', craft = 'freestyle5', mode = 'cine', start = null, hz = 240, every = 240, maxTicks = 240 * 60 * 10, meta = {} } = {}) {
    this.header = { v: LOG_VERSION, seed, world, craft, mode, hz, every, start, meta };
    this.maxTicks = maxTicks;
    this.ticks = 0;
    this.data = new Int16Array(NC * 240 * 30);
    this.snaps = []; this.modes = [];
    this._mode = mode;
  }
  get full() { return this.ticks >= this.maxTicks; }
  get seconds() { return this.ticks / this.header.hz; }

  // one tick, before drone.step(): `inp` already quantised; `drone` supplies the periodic snapshot
  record(inp, mode, drone) {
    if (this.ticks > 0 && this.ticks % this.header.every === 0 && drone) this.snaps.push({ tick: this.ticks, s: drone.snapshot() });
    if (mode !== this._mode) { this.modes.push({ tick: this.ticks, mode }); this._mode = mode; }
    const o = this.ticks * NC;
    if (o + NC > this.data.length) { const d = new Int16Array(this.data.length * 2); d.set(this.data); this.data = d; }
    for (let k = 0; k < NC; k++) this.data[o + k] = q16(inp[CHANNELS[k]]);
    this.ticks++;
  }

  input(i, out = {}) {
    const o = i * NC;
    for (let k = 0; k < NC; k++) out[CHANNELS[k]] = this.data[o + k] / QMAX;
    return out;
  }

  toBytes() {
    const enc = new TextEncoder();
    const pad4 = (s) => s + ' '.repeat((4 - (enc.encode(s).length % 4)) % 4);
    const head = enc.encode(pad4(JSON.stringify(this.header)));
    const tail = enc.encode(JSON.stringify({ snaps: this.snaps, modes: this.modes }));
    const ib = this.ticks * NC * 2, ibp = (ib + 3) & ~3;
    const buf = new ArrayBuffer(12 + head.length + 4 + ibp + 4 + tail.length), dv = new DataView(buf), u8 = new Uint8Array(buf);
    let o = 0;
    dv.setUint32(o, MAGIC, true); dv.setUint32(o + 4, LOG_VERSION, true); dv.setUint32(o + 8, head.length, true); o += 12;
    u8.set(head, o); o += head.length;
    dv.setUint32(o, this.ticks, true); o += 4;
    for (let i = 0; i < this.ticks * NC; i++) dv.setInt16(o + i * 2, this.data[i], true);
    o += ibp;
    dv.setUint32(o, tail.length, true); o += 4;
    u8.set(tail, o);
    return u8;
  }

  static fromBytes(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), dec = new TextDecoder();
    if (dv.getUint32(0, true) !== MAGIC) throw new Error('not an input log');
    const ver = dv.getUint32(4, true); if (ver > LOG_VERSION) throw new Error(`input log v${ver} is newer than this reader`);
    let o = 12; const hl = dv.getUint32(8, true);
    const header = JSON.parse(dec.decode(u8.subarray(o, o + hl))); o += hl;
    const ticks = dv.getUint32(o, true); o += 4;
    const log = new InputLog({ ...header, maxTicks: Infinity });
    log.header = header; log.ticks = ticks; log.data = new Int16Array(Math.max(NC, ticks * NC));
    for (let i = 0; i < ticks * NC; i++) log.data[i] = dv.getInt16(o + i * 2, true);
    o += (ticks * NC * 2 + 3) & ~3;
    const tl = dv.getUint32(o, true); o += 4;
    const tail = JSON.parse(dec.decode(u8.subarray(o, o + tl)));
    log.snaps = tail.snaps || []; log.modes = tail.modes || [];
    return log;
  }
}

// Replays a log into `drone` on `world` (step() is the Drone's own). Compares the position with every stored snapshot.
//   resync: false = one continuous run from the start state (what the web build must match exactly)
//           true  = restart from each snapshot (what a port with different libm rounding is held to)
// Returns {ticks, snaps, maxErr (m), worstTick, final: drone.snapshot()}.
export function replayLog(log, drone, world, { resync = false, onTick = null } = {}) {
  const h = log.header, dt = 1 / h.hz, inp = {};
  drone.restore(h.start);
  let mode = h.mode, mi = 0, si = 0, maxErr = 0, worstTick = -1;
  for (let i = 0; i < log.ticks; i++) {
    while (si < log.snaps.length && log.snaps[si].tick === i) {
      const s = log.snaps[si++].s, p = drone.pos;
      const e = Math.hypot(p.x - s.pos[0], p.y - s.pos[1], p.z - s.pos[2]);
      if (e > maxErr) { maxErr = e; worstTick = i; }
      if (resync) drone.restore(s);
    }
    while (mi < log.modes.length && log.modes[mi].tick === i) mode = log.modes[mi++].mode;
    log.input(i, inp);
    drone.step(dt, inp, mode, world);
    onTick?.(i, drone, inp, mode);
  }
  return { ticks: log.ticks, snaps: log.snaps.length, maxErr, worstTick, final: drone.snapshot() };
}

// [G4] header.world = world.json `hash.collider` (geohash.js "mm3x2/1" over the collider mesh: positions + index in
// three-mesh-bvh order), so a port computes it from collider.glb without copying JS number formatting (native #1.5).
// A log only replays exactly on the collider it was recorded on. Funnels / envelope are not hashed: they are part of
// world.json, and changing them means re-recording (node tests/replay.mjs --record). No collider (open air) hashes
// the empty set. Cached per BVH.
const _hashes = new WeakMap();
export function worldHash(world) {
  const bvh = world?.bvh || world?.collider?.bvh;
  const geo = bvh?.geometry;
  if (!geo) return setHash('collider', []);
  if (!_hashes.has(bvh)) _hashes.set(bvh, setHash('collider', [['collider', geo]]));
  return _hashes.get(bvh);
}
