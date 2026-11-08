// flight.js — quadcopter flight model + collision against the world's collider.
// Body frame: +x right, +y up (thrust axis), -z forward (camera looks along -z).
//
// Determinism contract (native port, PORTING.md): step(dt, inp, mode, world) is a pure function of the Drone state
// (snapshot()/restore()), the input, the mode and the world. main.js calls it at a fixed 1/240 s tick with quantised
// inputs (inputlog.js); the only randomness is this.rng (rng.js), re-seeded on reset(). Geometry is reached only through
// the collider interface (bvhCollider below); world.funnels / world.envelope are plain data.
import * as THREE from 'three';
import { Rng } from './rng.js';

const G = 9.81, RHO_HALF = 0.6, DEG = Math.PI / 180;

// cdA: flat-plate drag area (m^2) along body x / y / z. Body y only sees the full value for air from below: inflow
// from above goes through the props and is already the thrust loss (`eff`), so it gets 0.3 of it.
// camTilt: uptilt (deg) in acro; main.js defTilt scales it for the assisted modes. maxAngle: angle-mode limit (deg).
// hoverHz: motor/prop frequency at hover (camera jello follows rpm ~ sqrt(thrust)).
// Cine Assist: stick = target velocity, release = brake to hover. cineClimb / cineDive = full-stick climb / descent
// (m/s); assistCrash = how much harder a tap the assisted modes forgive.
export const CRAFTS = {
  freestyle5: {
    label: '5" Freestyle', mass: 0.68, twr: 6.5, radius: 0.12, cdA: [0.026, 0.06, 0.016], pitchSpeed: 60,
    rates: { roll: [200, 720, 0.55], pitch: [200, 720, 0.55], yaw: [160, 520, 0.45] },
    tauRate: 0.022, tauMotor: 0.035, camTilt: 28, crashSpeed: 7.0, maxAngle: 55, hoverHz: 170,
    cineSpeed: 18, cineTilt: 40, cineYaw: 90, cineClimb: 6, cineDive: 12, assistCrash: 1.8,
  },
  cinewhoop: {
    label: '3" Cinewhoop', mass: 0.34, twr: 4.0, radius: 0.085, cdA: [0.022, 0.07, 0.022], pitchSpeed: 32,
    rates: { roll: [150, 520, 0.5], pitch: [150, 520, 0.5], yaw: [120, 380, 0.4] },
    tauRate: 0.03, tauMotor: 0.03, camTilt: 10, crashSpeed: 5.0, maxAngle: 35, hoverHz: 260,
    cineSpeed: 7, cineTilt: 26, cineYaw: 80, cineClimb: 3, cineDive: 5, assistCrash: 1.8,
  },
};

// Cine smoothing (s): the speed and turn commands are low-passed so thumb wobble doesn't become pitch/yaw snaps.
const CINE_TAU_SPEED = 0.35, CINE_TAU_YAW = 0.12, CINE_KV = 1.4;
// Un-stick window (s) and the minimum displacement (m) inside it that counts as "moving".
const STUCK_WIN = 0.4, STUCK_MOVE = 0.15;
// Cine wall memory: hold (s) after the last contact, refreshed while the wall is still within WALL_RAY (m) along -n.
const WALL_HOLD = 0.35, WALL_RAY = 1.6;
// Cine drop / climb assist. Funnels (world.funnels): steer onto the axis at <= FUN_V m/s (gain FUN_K /s). Before the
// opening (over the rim of a 'down' funnel, under the first hole of an 'up' one) the forward command bleeds off
// (tau FUN_TAU_V s), the steer runs at up to FUN_V_IN m/s (design r3 #6: a drifting entry is caught), and the descent /
// climb is held to FUN_HOLD m/s until within FUN_IN m of the axis. FUN_CLIMB / FUN_UP: stick that counts as a held
// dive / climb; FUN_REACH: m before the opening a funnel captures (a funnel's own `reach` overrides it).
// Drop lock (anywhere else): with the right stick centred (< LOCK_DZ) and the dive held (climb < LOCK_CLIMB), hold the
// spot where the drop began (gain LOCK_K /s, <= LOCK_V m/s), if it began slower than LOCK_ENGAGE m/s (a brake-and-drop
// from cruise isn't yanked back).
const FUN_V = 2.0, FUN_V_IN = 3.5, FUN_K = 2.7, FUN_TAU_V = 0.12, FUN_HOLD = 1.5, FUN_IN = 1.0;
const FUN_CLIMB = -0.3, FUN_UP = 0.3, FUN_REACH = 8;
const LOCK_K = 3.0, LOCK_V = 4.0, LOCK_DZ = 0.12, LOCK_CLIMB = -0.5, LOCK_ENGAGE = 3.5;
// Floor push (UX r3 #1). An up-facing contact keeps floorT alive for FLOOR_HOLD s; while it lasts, a right stick past
// LIFT_DZ climbs off at >= LIFT_VZ m/s (before, the altitude hold pinned a landed quad and the right stick moved it
// 8 cm in 3 s). With the right stick past LIFT_DZ the dive guard also levels a descent off GUARD_H m over the floor
// (skim) instead of landing. Landed with both sticks centred (climb < 0.05), it presses down at LAND_VZ m/s and stays.
const FLOOR_HOLD = 0.25, LIFT_DZ = 0.15, LIFT_VZ = 1.2, LAND_VZ = 0.5;
// Dive guard: target clearance GUARD_H m, approach gain GUARD_K /s (vz >= -GUARD_K (h - GUARD_H)), and the slowest
// descent it leaves alone / lets through at the floor (GUARD_MIN m/s, under take.js SCRAPE 2.5; design r3 #4: a held full dive used to touch
// down at 3.76 m/s, which read as a SCRAPE).
const GUARD_H = 0.6, GUARD_K = 2.0, GUARD_MIN = 1.8;
// Cine camera (main.js rigCamera via camView): pitch-follow smoothing (s; slower after an impact so bounces don't nod
// the view) and the counter-pitch (FPV r3 #5): CAM_KP x (body pitch low-passed at CAM_TF minus at CAM_TS), which trims
// the 1.5x-reference pitch nods but keeps the slow cruise lean and brake pitch-up.
const CAM_TAU = 0.2, CAM_TAU_BUMP = 0.8, CAM_KP = 0.45, CAM_TF = 0.12, CAM_TS = 1.5;
// proximity probe radius (m): turbulence near surfaces, and main.js's world.lastDist (audio, OLED bars)
const PROX_R = 2.0;
// snapshot format version (bump when fields change; committed input logs record it). 2: floorT, guard feed-forward and
// the camera state (camP/camD/camK + filters, pc* = the previous tick). restore() reads version 1 with those at rest.
export const SNAP_VERSION = 2;

// Betaflight "Actual" rates (centre sensitivity, max rate, expo) -> rad/s
export function actualRate(x, [center, max, expo]) {
  const ax = Math.abs(x);
  const expof = ax * (Math.pow(x, 5) * expo + x * (1 - expo));
  return (x * center + Math.max(0, max - center) * expof) * DEG;
}

// ---- collider interface: the only way flight.js touches geometry (a native port implements these two calls on its
// own BVH). Results are reused objects: copy what you need before the next call.
//   raycast(o, d, max) -> {t, n} | null   first hit along the unit vector d within max (both faces); n = face normal,
//                                          either orientation
//   closest(p, max)    -> {p, d} | null   nearest surface point strictly within max
export function bvhCollider(bvh) {
  const ray = new THREE.Ray(), cp = {}, hit = { t: 0, n: new THREE.Vector3() }, near = { p: new THREE.Vector3(), d: 0 };
  return {
    bvh,
    raycast(o, d, max) {
      ray.origin.copy(o); ray.direction.copy(d);
      const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, max);
      if (!h || !h.face) return null;
      hit.t = h.distance; hit.n.copy(h.face.normal); return hit;
    },
    closest(p, max) {
      const r = bvh.closestPointToPoint(p, cp, 0, max);
      // three-mesh-bvh's maxThreshold only culls BVH nodes: it returns the nearest triangle of any leaf whose box is
      // within max, even when that triangle is metres away. Without this guard the quad got teleported onto it
      // ("phantom snaps" of up to 3.6 m, and the no-crossing guard then froze it in place).
      if (!r || r.distance >= max) return null;
      near.p.copy(r.point); near.d = r.distance; return near;
    },
  };
}
// world.collider if the world provides one, else an adapter over world.bvh (cached per BVH)
const _colliders = new WeakMap();
export function colliderOf(world) {
  if (!world) return null;
  if (world.collider) return world.collider;
  const bvh = world.bvh; if (!bvh) return null;
  let c = _colliders.get(bvh);
  if (!c) { c = bvhCollider(bvh); _colliders.set(bvh, c); }
  return c;
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const clamp1 = (v) => Math.max(-1, Math.min(1, v));
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);

export class Drone {
  constructor(craftKey = 'freestyle5', seed = 0x5EED) {
    this.seed = seed >>> 0; this.rng = new Rng(this.seed);   // turbulence + impact kicks; re-seeded by reset()
    this.pos = new THREE.Vector3(); this.prev = new THREE.Vector3();   // prev / prevQ = pose one tick ago (render lerp)
    this.vel = new THREE.Vector3(); this.q = new THREE.Quaternion(); this.prevQ = new THREE.Quaternion();
    this.w = new THREE.Vector3();      // body rates (rad/s)
    this.wDes = new THREE.Vector3();
    this.noise = new THREE.Vector3();  // OU turbulence state
    this.thrust = 0; this.motors = [0, 0, 0, 0];
    this.crashed = false; this.crashT = 0; this.lastImpact = 0; this.bump = 0; this.wash = 0;
    this.heading = 0; this.vzI = 0;
    this.contactT = 0; this.contactN = new THREE.Vector3(); this.limitHit = 0;
    this.vfS = 0; this.yawS = 0;                                      // Cine smoothed commands
    // Cine camera, integrated in step() (see _camStep): camP pitch-follow (rad, + up), camD drop factor (0-1), camK
    // counter-pitch (rad), camW Cine weight, camF / camS body-pitch filters; pcP / pcD / pcK = one tick ago (render lerp)
    this.camP = 0; this.camD = 0; this.camK = 0; this.camW = 0; this.camF = 0; this.camS = 0; this.pcP = 0; this.pcD = 0; this.pcK = 0;
    this.floorT = 0; this.guardFF = 0;                                // floor-push timer (s); dive-guard feed-forward (m/s^2)
    this.wallN = new THREE.Vector3(); this.wallT = 0;                 // Cine wall-slide: last two wall normals + hold
    this.wallN2 = new THREE.Vector3(); this.wallT2 = 0;
    this._sP = new THREE.Vector3(); this._sN = new THREE.Vector3(); this._sT = 0; this._sC = 0; this.unsticks = 0;
    this.prox = Infinity;                                             // gap (m) to the nearest surface within PROX_R
    this.dropOn = 0; this.dropP = new THREE.Vector3(); this.funI = -1;   // Cine drop lock (0 idle, 1 held, 2 declined) / funnel
    this.resets = 0;                                                  // bumped by reset(): lets main.js see a respawn
    this.setCraft(craftKey);
  }
  setCraft(key) { this.key = key; this.c = CRAFTS[key]; this.tMax = this.c.twr * this.c.mass * G; }

  reset(pos, yaw) {
    this.pos.copy(pos); this.prev.copy(pos); this.vel.set(0, 0, 0); this.w.set(0, 0, 0); this.noise.set(0, 0, 0);
    this.q.setFromAxisAngle(UP, yaw); this.prevQ.copy(this.q); this.heading = yaw;
    this.thrust = this.c.mass * G; this.crashed = false; this.crashT = 0; this.lastImpact = 0;
    this.vzI = 0; this.contactT = 0; this.bump = 0; this.wash = 0; this.limitHit = 0; this.contactN.set(0, 0, 0);
    this.vfS = 0; this.yawS = 0; this.wallT = 0; this.wallT2 = 0;
    this.camP = 0; this.camD = 0; this.camK = 0; this.camW = 0; this.camF = 0; this.camS = 0; this.pcP = 0; this.pcD = 0; this.pcK = 0;
    this.floorT = 0; this.guardFF = 0;
    this._sP.copy(pos); this._sN.set(0, 0, 0); this._sT = 0; this._sC = 0;
    this.prox = Infinity; this.dropOn = 0; this.funI = -1;
    this.rng.seed(this.seed); this.resets++;
  }

  // Full simulation state as plain JSON (numbers / arrays): restore(snapshot()) continues bit-identically.
  // Includes the outputs main.js reads (motors, wash, bump, contactN...) so a restored drone also renders and sounds
  // the same. prox: null = nothing within PROX_R.
  snapshot() {
    const v = (a) => [a.x, a.y, a.z], q = (a) => [a.x, a.y, a.z, a.w];
    return {
      ver: SNAP_VERSION, key: this.key, seed: this.seed, rng: this.rng.state,
      pos: v(this.pos), prev: v(this.prev), vel: v(this.vel), q: q(this.q), prevQ: q(this.prevQ), w: v(this.w), wDes: v(this.wDes),
      noise: v(this.noise), thrust: this.thrust, motors: this.motors.slice(), heading: this.heading, vzI: this.vzI,
      crashed: this.crashed ? 1 : 0, crashT: this.crashT, lastImpact: this.lastImpact, bump: this.bump, wash: this.wash,
      contactT: this.contactT, contactN: v(this.contactN), limitHit: this.limitHit,
      vfS: this.vfS, yawS: this.yawS, camP: this.camP,
      camD: this.camD, camK: this.camK, camW: this.camW, camF: this.camF, camS: this.camS, pcP: this.pcP, pcD: this.pcD, pcK: this.pcK,
      floorT: this.floorT, guardFF: this.guardFF,
      wallN: v(this.wallN), wallT: this.wallT, wallN2: v(this.wallN2), wallT2: this.wallT2,
      sP: v(this._sP), sN: v(this._sN), sT: this._sT, sC: this._sC, unsticks: this.unsticks,
      prox: Number.isFinite(this.prox) ? this.prox : null, dropOn: this.dropOn, dropP: v(this.dropP), funI: this.funI,
    };
  }
  restore(s) {
    if (s.key !== this.key) this.setCraft(s.key);
    const v = (a, b) => a.set(b[0], b[1], b[2]);
    this.seed = s.seed >>> 0; this.rng.state = s.rng;
    v(this.pos, s.pos); v(this.prev, s.prev); v(this.vel, s.vel); this.q.fromArray(s.q); this.prevQ.fromArray(s.prevQ);
    v(this.w, s.w); v(this.wDes, s.wDes); v(this.noise, s.noise); this.thrust = s.thrust; this.motors = s.motors.slice();
    this.heading = s.heading; this.vzI = s.vzI;
    this.crashed = !!s.crashed; this.crashT = s.crashT; this.lastImpact = s.lastImpact; this.bump = s.bump; this.wash = s.wash;
    this.contactT = s.contactT; v(this.contactN, s.contactN); this.limitHit = s.limitHit;
    this.vfS = s.vfS; this.yawS = s.yawS; this.camP = s.camP;
    // version 1 snapshots: no camera filters / floor timer (at rest), and the pitch-follow without a previous tick
    this.camD = s.camD ?? 0; this.camK = s.camK ?? 0; this.camW = s.camW ?? 0; this.camF = s.camF ?? 0; this.camS = s.camS ?? 0;
    this.pcP = s.pcP ?? s.camP; this.pcD = s.pcD ?? this.camD; this.pcK = s.pcK ?? this.camK;
    this.floorT = s.floorT ?? 0; this.guardFF = s.guardFF ?? 0;
    v(this.wallN, s.wallN); this.wallT = s.wallT; v(this.wallN2, s.wallN2); this.wallT2 = s.wallT2;
    v(this._sP, s.sP); v(this._sN, s.sN); this._sT = s.sT; this._sC = s.sC; this.unsticks = s.unsticks;
    this.prox = s.prox == null ? Infinity : s.prox; this.dropOn = s.dropOn | 0; v(this.dropP, s.dropP); this.funI = s.funI;
    this.resets++;                                                    // a discontinuity for main.js (new log, no blur spike)
    return this;
  }

  up(out = new THREE.Vector3()) { return out.copy(UP).applyQuaternion(this.q); }

  // Motor/prop frequency (Hz) for the camera's jello (main.js rigCamera -> motion.hz): rpm ~ sqrt(thrust).
  get rpmHz() { return (this.c.hoverHz || 170) * Math.sqrt(Math.max(0.35, this.thrust / (this.c.mass * G))); }

  // ---- Cine camera (FPV r3 #1A and #5, and the camP determinism bug). Advanced once per tick at the end of step(), so
  // the camera is a pure function of the start state + input log like the pose (golden stills, HQ clip re-render,
  // native port); main.js rigCamera reads camView(physAlpha, uptilt) between the last two ticks, as it does the pose.
  //  - pitch-follow: Cine flies level, so the view pitches with the flight path's climb/dive angle (0.85x, -70..+20 deg;
  //    without it a chimney dive stares at the wall). In a vertical drop (camD -> 1: descending faster than 4 m/s with
  //    little horizontal speed) it goes all the way: the full path angle, down to -90 deg, minus the uptilt (camD x tilt,
  //    applied in camView: the uptilt is a render setting), so the tube's far end sits in the frame (ref_017), not the
  //    wall. Smoothed (CAM_TAU, CAM_TAU_BUMP right after an impact); eases to 0 out of Cine or crashed.
  //  - counter-pitch: + CAM_KP x (body pitch, nose-down +, through a CAM_TF low-pass minus a CAM_TS one): the camera
  //    half-cancels the velocity loop's fast pitch nods and keeps the slow lean. Cine only (camW eases in and out).
  _camStep(dt, on) {
    this.pcP = this.camP; this.pcD = this.camD; this.pcK = this.camK;
    const live = on && !this.crashed, vH = Math.hypot(this.vel.x, this.vel.z), vy = this.vel.y;
    let tP = 0, tD = 0;
    if (live) {
      tD = Math.min(1, Math.max(0, (-vy - 4) / 6)) * Math.min(1, Math.max(0, 1 - vH / 6));
      const path = Math.atan2(vy, Math.max(vH, 3 - 1.5 * tD));
      tP = Math.max(-100 * DEG, Math.min(20 * DEG, (0.85 + 0.15 * tD) * Math.max(path, -70 * DEG - 20 * DEG * tD)));
    }
    const k = 1 - Math.exp(-dt / (this.bump > 0.05 ? CAM_TAU_BUMP : CAM_TAU));
    this.camP += (tP - this.camP) * k; this.camD += (tD - this.camD) * k;
    const fy = _v1.set(0, 0, -1).applyQuaternion(this.q).y, th = -Math.asin(Math.max(-1, Math.min(1, fy)));
    this.camF += (th - this.camF) * (1 - Math.exp(-dt / CAM_TF));
    this.camS += (th - this.camS) * (1 - Math.exp(-dt / CAM_TS));
    this.camW += ((live ? 1 : 0) - this.camW) * (1 - Math.exp(-dt / CAM_TAU));
    this.camK = this.camW * CAM_KP * (this.camF - this.camS);
  }
  // The camera's pitch offset (rad, + looks up) on top of an uptilt of `tilt` rad, at `alpha` between the previous tick
  // (0) and the last one (1): main.js passes physAlpha, as for the pose.
  camView(alpha = 1, tilt = 0) {
    const a = alpha, P = this.pcP + (this.camP - this.pcP) * a, D = this.pcD + (this.camD - this.pcD) * a;
    return Math.max(-100 * DEG, Math.min(20 * DEG, P - D * tilt)) + this.pcK + (this.camK - this.pcK) * a;
  }
  // round-3 name (labs, tools): no longer integrates anything; step() advances the camera
  camPitch(dt, on = true, tilt = 0) { return this.camView(1, tilt); }

  // Attitude controller: target pitch/roll (deg, nose-down / right-down positive) at the current heading.
  _rateForAttitude(pitchDeg, rollDeg, yawRate, dt, k) {
    this.heading += yawRate * dt;
    _q1.setFromAxisAngle(AY, this.heading);
    _q2.setFromAxisAngle(AX, -pitchDeg * DEG); _q1.multiply(_q2);
    _q2.setFromAxisAngle(AZ, -rollDeg * DEG); _q1.multiply(_q2);
    _q2.copy(this.q).invert().multiply(_q1);            // error in body frame
    if (_q2.w < 0) { _q2.x = -_q2.x; _q2.y = -_q2.y; _q2.z = -_q2.z; _q2.w = -_q2.w; }
    return this.wDes.set(2 * k * _q2.x, 2 * k * _q2.y, 2 * k * _q2.z);
  }

  _syncHeading() {
    const f = _v1.set(0, 0, -1).applyQuaternion(this.q);
    if (Math.hypot(f.x, f.z) > 0.2) this.heading = Math.atan2(-f.x, -f.z);
  }

  // Floor-safe dive: never command a descent that can't be stopped before the floor (vz >= -GUARD_K (h - GUARD_H), a
  // 0.5 s exponential approach that needs ~2.4 g at 12 m/s; the quad has 5.5 g). h = clearance straight down, or along
  // the flight path when that hits an up-facing surface first (diving onto a lower roof ahead).
  // A floor that slopes away under the flight path (the gallery's 22 deg tube) also falls away at
  // vFloor = -(n.x vx + n.z vz) / n.y, so that much descent is free: without it the guard held the quad 1.2 m over the
  // gallery floor at 1.2 m/s of descent while the floor dropped at 0.44 vH, and it rode the roof.
  // While the profile binds, its own deceleration (-GUARD_K dh/dt) goes to the altitude hold as feed-forward
  // (this.guardFF): the PI loop alone lagged ~2.7 m/s behind it and a held dive hit the floor at 3.76 m/s; now it
  // follows the profile down to GUARD_MIN m/s and touches down at about that (the altitude hold's integral, wound to
  // -4 m/s by the free fall's lag, is cleared when the guard takes over).
  // skim (right stick on, UX r3 #1): no minimum descent, so a held dive (or any sink) levels off GUARD_H m over the
  // floor and flies on instead of landing.
  _diveGuard(vzCmd, col, skim = false) {
    this.guardFF = 0;
    if (!col || vzCmd >= (skim ? 0 : -GUARD_MIN)) return vzCmd;
    let h = 40, vFloor = 0;
    const hd = col.raycast(this.pos, DOWN, 40);
    if (hd) {
      h = hd.t;
      const s = hd.n.y < 0 ? -1 : 1, nx = hd.n.x * s, ny = hd.n.y * s, nz = hd.n.z * s;   // face normal, up side
      if (ny > 0.5) vFloor = Math.min(0, -(nx * this.vel.x + nz * this.vel.z) / ny);
    }
    const sp = this.vel.length();
    if (sp > 3 && this.vel.y < -1) {
      const dir = _v4.copy(this.vel).divideScalar(sp);
      const hp = col.raycast(this.pos, dir, 40);
      if (hp && Math.abs(hp.n.y) > 0.5) h = Math.min(h, hp.t * -dir.y);
    }
    const prof = (h - GUARD_H) * GUARD_K, lim = vFloor - (skim ? Math.max(0, prof) : Math.max(GUARD_MIN, prof));
    if (vzCmd >= lim) return vzCmd;
    this.vzI = Math.max(0, this.vzI);                               // the free dive's wound-down integral would fight it
    if (prof > (skim ? 0 : GUARD_MIN)) this.guardFF = GUARD_K * Math.max(0, vFloor - this.vel.y);
    return lim;
  }

  // Cine drop / climb assist (C1 + C9 world.funnels [{c:[x,z], top, bottom, r, dir?, reach?}]; top > bottom, both y).
  //  dir 'down' (default): holding the dive within r of the axis, from the rim (top - 0.5) up to `reach` (FUN_REACH) m
  //    over it, captures; the quad is steered onto the axis down to `bottom`, where it lets go.
  //  dir 'up' (C9, the mirror): holding the climb within r of the axis, from `reach` m under the first opening
  //    (`bottom` = underside of the lowest hole) up to bottom + 0.5, captures; steered onto the axis up to `top` (the
  //    exit), where it lets go.
  // Captured only from the opening's side (flying past the outside of a chimney or up beside a stack never pulls you
  // in); released when the stick lets go, the quad leaves r, or a wall comes between it and the axis inside.
  // Returns the funnel or null; sets this._fdx/_fdz (to the axis), this._fdh and this._fOut (before the opening).
  _funnel(world, col, cz) {
    const fs = world?.funnels, dive = cz < FUN_CLIMB, climb = cz > FUN_UP;
    if (!fs || !fs.length || !(dive || climb)) { this.funI = -1; return null; }
    const p = this.pos;
    if (this.funI >= 0) {                                          // captured: keep it while inside its span and r
      const f = fs[this.funI], up = f?.dir === 'up', reach = f?.reach ?? FUN_REACH;
      if (!f || up !== climb || Math.hypot(f.c[0] - p.x, f.c[1] - p.z) >= f.r ||
          (up ? p.y >= f.top || p.y <= f.bottom - reach : p.y <= f.bottom || p.y >= f.top + reach)) this.funI = -1;
    }
    if (this.funI < 0) {
      for (let i = 0; i < fs.length; i++) {
        const f = fs[i], up = f.dir === 'up', reach = f.reach ?? FUN_REACH;
        if (up !== climb || Math.hypot(f.c[0] - p.x, f.c[1] - p.z) >= f.r) continue;
        if (up ? p.y > f.bottom - reach && p.y < f.bottom + 0.5 : p.y > f.top - 0.5 && p.y < f.top + reach) { this.funI = i; break; }
      }
      if (this.funI < 0) return null;
    }
    const f = fs[this.funI], up = f.dir === 'up', dx = f.c[0] - p.x, dz = f.c[1] - p.z, dh = Math.hypot(dx, dz);
    const inside = up ? p.y > f.bottom : p.y < f.top;
    if (inside && dh > 0.05 && col && col.raycast(p, _v4.set(dx / dh, 0, dz / dh), dh)) { this.funI = -1; return null; }
    this._fdx = dx; this._fdz = dz; this._fdh = dh; this._fOut = up ? p.y < f.bottom + 0.5 : p.y > f.top - 0.5;
    return f;
  }

  _altitudeHold(vzCmd, up, dt) {
    const c = this.c, err = vzCmd - this.vel.y;
    this.vzI = Math.max(-4, Math.min(4, this.vzI + err * dt));
    const az = err * 3.2 + this.vzI * 2.0 + this.guardFF;          // + the dive guard's profile deceleration
    const effFF = Math.min(1.3, Math.max(0.3, 1 - this.vel.dot(up) / c.pitchSpeed));   // prop inflow loss feed-forward
    return c.mass * (G + az) / Math.max(up.y, 0.25) / effFF;
  }

  step(dt, inp, mode, world) {
    const c = this.c, m = c.mass, col = colliderOf(world);
    this.prev.copy(this.pos); this.prevQ.copy(this.q);
    const up = this.up(_v2);
    let tCmd = 0;
    let wDes;

    if (mode !== 'cine' || this.crashed) {
      // keep Cine's smoothed commands in step with the real motion, so switching into Cine doesn't jolt
      this.vfS = -this.vel.x * Math.sin(this.heading) - this.vel.z * Math.cos(this.heading); this.yawS = 0;
      this.dropOn = 0; this.funI = -1; this.guardFF = 0;
    }
    if (this.crashed) {
      this.crashT += dt;
      wDes = this.wDes.copy(this.w).multiplyScalar(0.995);
    } else if (mode === 'acro') {
      this._syncHeading();
      wDes = this.wDes.set(-actualRate(inp.pitch, c.rates.pitch), -actualRate(inp.yaw, c.rates.yaw), -actualRate(inp.roll, c.rates.roll));
      tCmd = this.tMax * inp.thr * inp.thr;
    } else if (mode === 'angle') {
      const yawRate = -actualRate(inp.yaw, c.rates.yaw) * 0.6;
      wDes = this._rateForAttitude(inp.pitch * c.maxAngle, inp.roll * c.maxAngle, yawRate, dt, 9);
      tCmd = this.tMax * inp.thr * inp.thr;
    } else {
      // CINE ASSIST — velocity control. Right stick: forward speed + carve; left: climb + yaw.
      // Let go and it brakes to a hover. Banking falls out of the velocity loop (coordinated turns).
      const kv = CINE_KV, amax = G * Math.tan(c.cineTilt * DEG);
      const vH = Math.hypot(this.vel.x, this.vel.z);
      // turn rate shrinks with speed so the carve stays inside what the tilt limit can hold (r = v / psi_dot)
      const yawMax = Math.min(c.cineYaw * DEG, 1.3 * amax / Math.max(vH, 1));
      const yawCmd = -clamp1(inp.roll + inp.yaw * 0.7) * yawMax;
      this.yawS += (yawCmd - this.yawS) * (1 - Math.exp(-dt / CINE_TAU_YAW));
      const yawRate = this.yawS;
      const h = this.heading;
      const fx = -Math.sin(h), fz = -Math.cos(h);           // forward on the ground plane
      const rx = Math.cos(h), rz = -Math.sin(h);            // right
      const vfCmd = inp.pitch >= 0 ? inp.pitch * c.cineSpeed : inp.pitch * c.cineSpeed * 0.35;
      this.vfS += (vfCmd - this.vfS) * (1 - Math.exp(-dt / CINE_TAU_SPEED));
      let vdx = fx * this.vfS, vdz = fz * this.vfS;
      // drop / climb assist: a funnel (shaft axis) if one has captured the quad, else the drop lock
      const cz = clamp1(inp.climb);
      const fun = this._funnel(world, col, cz);
      let holdV = false;
      if (fun) {
        // before the opening: the forward command bleeds off and the steer is stronger (a drifting entry is caught)
        if (this._fOut) { this.vfS *= Math.exp(-dt / FUN_TAU_V); vdx = fx * this.vfS; vdz = fz * this.vfS; }
        const dh = this._fdh, k = Math.min(this._fOut ? FUN_V_IN : FUN_V, FUN_K * dh) / Math.max(dh, 1e-3);
        vdx += this._fdx * k; vdz += this._fdz * k;
        holdV = this._fOut && dh > FUN_IN;                            // before the opening but off the axis: settle in first
        this.dropOn = 0;
      } else if (cz < LOCK_CLIMB && Math.abs(inp.pitch) < LOCK_DZ && Math.abs(inp.roll) < LOCK_DZ) {
        // decided when the drop begins: from a hover or a slow drift it holds that spot; a brake-and-drop from cruise
        // speed is left alone for the whole dive (it would otherwise be pulled back to where it slowed down)
        if (this.dropOn === 0) { this.dropOn = vH < LOCK_ENGAGE ? 1 : 2; this.dropP.copy(this.pos); }
        if (this.dropOn === 1) {
          let lx = (this.dropP.x - this.pos.x) * LOCK_K, lz = (this.dropP.z - this.pos.z) * LOCK_K;
          const ll = Math.hypot(lx, lz); if (ll > LOCK_V) { lx *= LOCK_V / ll; lz *= LOCK_V / ll; }
          vdx += lx; vdz += lz;
        }
      } else this.dropOn = 0;
      // wall-slide: just after touching a wall, drop the into-wall part of the target so pushing into it slides along
      // it (two walls remembered, so a corner holds a calm hover instead of pressing into one of them)
      let wallHeld = false;
      for (let k = 0; k < 2; k++) {
        const wn = k ? this.wallN2 : this.wallN;
        if ((k ? this.wallT2 : this.wallT) <= 0) continue;
        const into = vdx * wn.x + vdz * wn.z;
        if (into < 0) { vdx -= into * wn.x; vdz -= into * wn.z; if (fx * wn.x + fz * wn.z < 0) wallHeld = true; }
      }
      // anti-windup: while a wall eats the forward command, the smoothed speed may not charge up behind it (pull-back
      // or a carve then answers at once instead of first bleeding up to 18 m/s of stored command)
      if (wallHeld && this.vfS > 0) this.vfS = Math.min(this.vfS, vH + 3);
      // velocity error + centripetal feed-forward for the turning target (omega_y x v_des)
      let ax = (vdx - this.vel.x) * kv + yawRate * vdz;
      let az = (vdz - this.vel.z) * kv - yawRate * vdx;
      const an = Math.hypot(ax, az); if (an > amax) { ax *= amax / an; az *= amax / an; }
      const pitchDeg = Math.atan((ax * fx + az * fz) / G) / DEG;
      const rollDeg = Math.atan((ax * rx + az * rz) / G) / DEG;
      wDes = this._rateForAttitude(pitchDeg, rollDeg, yawRate, dt, 7);
      // vertical: progressive curve, half stick ~ the old 4.5 m/s-linear feel, full stick cineClimb up / cineDive down
      let vz = cz >= 0 ? c.cineClimb * cz * (0.6 + 0.4 * cz) : c.cineDive * cz * (0.15 - 0.85 * cz);
      if (holdV) vz = fun.dir === 'up' ? Math.min(vz, FUN_HOLD) : Math.max(vz, -FUN_HOLD);
      // floor push: on (or just off) a floor the right stick means go, and with it on a dive skims instead of landing
      const rs = Math.max(Math.abs(inp.pitch), Math.abs(inp.roll));
      if (rs > LIFT_DZ && this.floorT > 0) vz = Math.max(vz, LIFT_VZ);
      // ...and landed with the sticks centred it stays landed (a gentle press, not a hover that drifts back up)
      else if (this.floorT > 0 && cz < 0.05) vz = Math.min(vz, -LAND_VZ);
      tCmd = this._altitudeHold(this._diveGuard(vz, col, rs > LIFT_DZ), up, dt);
    }
    tCmd = Math.min(Math.max(tCmd, 0), this.tMax);

    // rates: tight PID abstracted as first-order response + turbulence/prop-wash torque noise
    const kR = 1 - Math.exp(-dt / c.tauRate);
    this.w.x += (wDes.x - this.w.x) * kR; this.w.y += (wDes.y - this.w.y) * kR; this.w.z += (wDes.z - this.w.z) * kR;
    const vAx = this.vel.dot(up);
    const tFrac = this.thrust / this.tMax;
    const wash = Math.min(1, Math.max(0, (-vAx - 2.0) / 6)) * Math.min(1, tFrac * 4);
    const near = Math.max(0, 1 - this.prox / 0.6);
    const assist = mode === 'acro' ? 1 : 0.45;               // assisted modes are steadier
    const sigma = (2.0 + wash * 55 + near * 6) * assist + this.bump * 30;
    const th = 0.06;
    const rng = this.rng;
    this.noise.x += (-this.noise.x / th) * dt + sigma * Math.sqrt(dt) * rng.gauss();
    this.noise.y += (-this.noise.y / th) * dt + sigma * 0.4 * Math.sqrt(dt) * rng.gauss();
    this.noise.z += (-this.noise.z / th) * dt + sigma * Math.sqrt(dt) * rng.gauss();
    if (!this.crashed) this.w.addScaledVector(this.noise, dt * 6);
    this.bump = Math.max(0, this.bump - dt * 4);
    this.wash = wash;

    // integrate attitude (body-frame increment)
    const wl = this.w.length();
    if (wl > 1e-7) { _q1.setFromAxisAngle(_v1.copy(this.w).divideScalar(wl), wl * dt); this.q.multiply(_q1).normalize(); }

    // motors: spool lag, thrust falls off as inflow approaches prop pitch speed
    this.thrust += (tCmd - this.thrust) * (1 - Math.exp(-dt / c.tauMotor));
    const eff = Math.min(1.3, Math.max(0.15, 1 - vAx / c.pitchSpeed));
    const T = this.thrust * eff;
    const ex = wDes.x - this.w.x, ey = wDes.y - this.w.y, ez = wDes.z - this.w.z;
    const base = Math.sqrt(this.thrust / this.tMax);
    const mix = (a, b, cc) => Math.min(1, Math.max(0, base + 0.02 * (a * ex + b * ez + cc * ey)));
    this.motors[0] = mix(-1, -1, 1); this.motors[1] = mix(-1, 1, -1); this.motors[2] = mix(1, -1, -1); this.motors[3] = mix(1, 1, 1);

    // forces
    const F = _v1.copy(up).multiplyScalar(T);
    F.y -= m * G;
    _q1.copy(this.q).invert();
    const vb = _v3.copy(this.vel).applyQuaternion(_q1);
    const cdY = vb.y > 0 ? c.cdA[1] * 0.3 : c.cdA[1];      // air from above is already the inflow thrust loss
    vb.set(-RHO_HALF * c.cdA[0] * Math.abs(vb.x) * vb.x, -RHO_HALF * cdY * Math.abs(vb.y) * vb.y, -RHO_HALF * c.cdA[2] * Math.abs(vb.z) * vb.z);
    vb.applyQuaternion(this.q);
    F.add(vb).addScaledVector(this.vel, -0.02);
    this.vel.addScaledVector(F, dt / m);
    this.pos.addScaledVector(this.vel, dt);

    if (col) this._collide(col, mode, dt);
    if (world?.envelope) this._envelope(world.envelope, dt);
    // proximity, inside the tick (it feeds the next tick's turbulence; main.js mirrors it into world.lastDist)
    let prox = Infinity;
    if (col && !this.crashed) { const r = col.closest(this.pos, PROX_R); if (r) prox = r.d - c.radius; }
    this.prox = prox;
    this._camStep(dt, mode === 'cine');
  }

  // Keep the quad inside the part of the world that was actually built in 3D.
  _envelope(env, dt) {
    let hit = false;
    for (const k of ['x', 'y', 'z']) {
      if (this.pos[k] > env.max[k]) { this.pos[k] = env.max[k]; if (this.vel[k] > 0) this.vel[k] *= -0.2; hit = true; }
      if (this.pos[k] < env.min[k]) { this.pos[k] = env.min[k]; if (this.vel[k] < 0) this.vel[k] *= -0.2; hit = true; }
    }
    this.limitHit = hit ? 0.6 : Math.max(0, this.limitHit - dt);
  }

  _collide(col, mode, dt) {
    const r = this.c.radius, e = 0.3, mu = 0.25;
    let impact = 0, touched = false;
    const n0 = this.contactN.set(0, 0, 0);
    const resolve = (n) => {
      touched = true; n0.add(n);
      const vn = this.vel.dot(n);
      if (vn < 0) {
        impact = Math.max(impact, -vn);
        // Coulomb friction: tangential loss bounded by the normal impulse -> glancing touches slide, they don't stick
        const vt = _v4.copy(this.vel).addScaledVector(n, -vn);
        const vtl = vt.length();
        this.vel.addScaledVector(n, -(1 + e) * vn);
        if (vtl > 1e-5) this.vel.addScaledVector(vt, -Math.min(vtl, mu * (1 + e) * -vn) / vtl);
      }
    };
    // swept test: catches thin geometry at speed (no tunnelling)
    const d = _v1.copy(this.pos).sub(this.prev); const len = d.length();
    if (len > 1e-5) {
      d.divideScalar(len);
      const hit = col.raycast(this.prev, d, len + r);
      if (hit) {
        const n = _v2.copy(hit.n); if (n.dot(d) > 0) n.negate();
        this.pos.copy(this.prev).addScaledVector(d, Math.max(0, hit.t - r - 0.002));
        resolve(n);
      }
    }
    // penetration push-out (the collider's closest() only reports surfaces strictly within r)
    for (let it = 0; it < 3; it++) {
      const res = col.closest(this.pos, r);
      if (!res) break;
      const n = _v2.copy(this.pos).sub(res.p); const dist = n.length();
      if (dist < 1e-6) break;
      n.divideScalar(dist);
      this.pos.copy(res.p).addScaledVector(n, r + 0.003);
      resolve(n);
    }
    // final guard: whatever the push-outs did, the step may never cross a surface
    {
      const seg = _v1.copy(this.pos).sub(this.prev), L = seg.length();
      if (L > 1e-5) {
        seg.divideScalar(L);
        const hit = col.raycast(this.prev, seg, L);
        if (hit) {
          const n = _v2.copy(hit.n); if (n.dot(seg) > 0) n.negate();
          this.pos.copy(this.prev);
          const vn = this.vel.dot(n); if (vn < 0) this.vel.addScaledVector(n, -1.3 * vn);
          touched = true; n0.add(n);
        }
      }
    }
    // floor push timer: refreshed by any up-facing contact (a floor or a roof under the quad)
    this.floorT = Math.max(0, this.floorT - dt);
    if (touched && n0.y > 0.7 * n0.length()) this.floorT = FLOOR_HOLD;
    // Cine wall-slide memory: horizontal normals of the last two wall-ish contacts (not floors), held for WALL_HOLD
    this.wallT = Math.max(0, this.wallT - dt); this.wallT2 = Math.max(0, this.wallT2 - dt);
    if (touched) {
      const nl = n0.length(), hl = Math.hypot(n0.x, n0.z);
      if (nl > 1e-6 && hl > 0.5 * nl) {
        const nx = n0.x / hl, nz = n0.z / hl;
        if (this.wallT > 0 && nx * this.wallN.x + nz * this.wallN.z < 0.85) { this.wallN2.copy(this.wallN); this.wallT2 = this.wallT; }
        this.wallN.set(nx, 0, nz); this.wallT = WALL_HOLD;
      }
      this._sN.add(n0); this._sC += dt;
    }
    // ...and kept alive while that wall is still there, within WALL_RAY along -n (a ray, so a window opening or the end
    // of the wall releases it). Before, it lapsed WALL_HOLD after the rebound, the target swung back into the wall and
    // the quad pinballed (a 3-8 m/s tock + camera shake every ~1 s while the stick was held).
    if (mode === 'cine') for (let k = 0; k < 2; k++) {
      const wn = k ? this.wallN2 : this.wallN;
      if ((k ? this.wallT2 : this.wallT) <= 0) continue;
      const h = col.raycast(this.pos, _v3.copy(wn).negate(), WALL_RAY);
      if (h && Math.abs(h.n.x * wn.x + h.n.z * wn.z) > 0.85) { if (k) this.wallT2 = WALL_HOLD; else this.wallT = WALL_HOLD; }
    }
    // un-stick, judged on displacement (velocity lies: the no-crossing guard can cancel every step while |v| stays
    // high). Every 0.4 s: in contact for over half the window and moved < 0.15 m -> wedged, pop out along the mean
    // contact normal. The velocity is replaced, not added to (adding to a big into-wall velocity doesn't free it).
    // Sitting on a floor is a landing, not stuck, unless the velocity says it should be moving.
    this._sT += dt;
    if (this._sT >= STUCK_WIN) {
      if (!this.crashed && this._sC > STUCK_WIN * 0.5 && this.pos.distanceTo(this._sP) < STUCK_MOVE && this._sN.lengthSq() > 1e-6) {
        const n = this._sN.normalize();
        if (n.y < 0.85 || this.vel.length() > 1) {
          this.vel.copy(n).multiplyScalar(2.2); this.vel.y += 1.2;
          this.unsticks++;
        }
      }
      this._sP.copy(this.pos); this._sN.set(0, 0, 0); this._sT = 0; this._sC = 0;
    }
    const crashAt = this.c.crashSpeed * (mode === 'acro' ? 1 : (this.c.assistCrash ?? 1.35));   // assisted modes forgive harder taps
    if (impact > 0.4) {
      this.lastImpact = impact;
      this.bump = Math.min(1, impact / 4);
      const rng = this.rng;
      this.w.x += rng.gauss() * impact * 2.0; this.w.z += rng.gauss() * impact * 2.0; this.w.y += rng.gauss() * impact * 0.8;
      if (!this.crashed && impact > crashAt) { this.crashed = true; this.crashT = 0; this.onCrash?.(impact); }
    }
  }
}
