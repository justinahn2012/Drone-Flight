// flight.js — quadcopter flight model + collision against the world's collider mesh.
// Body frame: +x right, +y up (thrust axis), -z forward (camera looks along -z).
import * as THREE from 'three';

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

// Betaflight "Actual" rates (centre sensitivity, max rate, expo) -> rad/s
export function actualRate(x, [center, max, expo]) {
  const ax = Math.abs(x);
  const expof = ax * (Math.pow(x, 5) * expo + x * (1 - expo));
  return (x * center + Math.max(0, max - center) * expof) * DEG;
}

function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _ray = new THREE.Ray();
const _cp = {};
const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const clamp1 = (v) => Math.max(-1, Math.min(1, v));
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);

export class Drone {
  constructor(craftKey = 'freestyle5') {
    this.pos = new THREE.Vector3(); this.prev = new THREE.Vector3();
    this.vel = new THREE.Vector3(); this.q = new THREE.Quaternion();
    this.w = new THREE.Vector3();      // body rates (rad/s)
    this.wDes = new THREE.Vector3();
    this.noise = new THREE.Vector3();  // OU turbulence state
    this.thrust = 0; this.motors = [0, 0, 0, 0];
    this.crashed = false; this.crashT = 0; this.lastImpact = 0; this.bump = 0; this.wash = 0;
    this.heading = 0; this.vzI = 0;
    this.contactT = 0; this.contactN = new THREE.Vector3(); this.limitHit = 0;
    this.vfS = 0; this.yawS = 0; this.camP = 0;                       // Cine smoothed commands, camera pitch-follow
    this.wallN = new THREE.Vector3(); this.wallT = 0;                 // Cine wall-slide: last two wall normals + hold
    this.wallN2 = new THREE.Vector3(); this.wallT2 = 0;
    this._sP = new THREE.Vector3(); this._sN = new THREE.Vector3(); this._sT = 0; this._sC = 0; this.unsticks = 0;
    this.setCraft(craftKey);
  }
  setCraft(key) { this.key = key; this.c = CRAFTS[key]; this.tMax = this.c.twr * this.c.mass * G; }

  reset(pos, yaw) {
    this.pos.copy(pos); this.prev.copy(pos); this.vel.set(0, 0, 0); this.w.set(0, 0, 0); this.noise.set(0, 0, 0);
    this.q.setFromAxisAngle(UP, yaw); this.heading = yaw;
    this.thrust = this.c.mass * G; this.crashed = false; this.crashT = 0; this.lastImpact = 0;
    this.vzI = 0; this.contactT = 0; this.bump = 0;
    this.vfS = 0; this.yawS = 0; this.camP = 0; this.wallT = 0; this.wallT2 = 0;
    this._sP.copy(pos); this._sN.set(0, 0, 0); this._sT = 0; this._sC = 0;
  }

  up(out = new THREE.Vector3()) { return out.copy(UP).applyQuaternion(this.q); }

  // Motor/prop frequency (Hz) for the camera's jello (main.js rigCamera -> motion.hz): rpm ~ sqrt(thrust).
  get rpmHz() { return (this.c.hoverHz || 170) * Math.sqrt(Math.max(0.35, this.thrust / (this.c.mass * G))); }

  // Cine camera pitch (rad, + looks up) following the flight path's climb/dive angle, for main.js rigCamera.
  // Cine flies level, so without it a chimney dive stares at the wall; a pilot would pitch into the dive.
  // Smoothed (tau 0.2 s, slower right after an impact so bounces don't nod the view); eases to 0 when `on` is false.
  camPitch(dt, on = true) {
    const vH = Math.hypot(this.vel.x, this.vel.z);
    const tgt = on && !this.crashed ? 0.85 * Math.max(-70 * DEG, Math.min(20 * DEG, Math.atan2(this.vel.y, Math.max(vH, 3)))) : 0;
    this.camP += (tgt - this.camP) * (1 - Math.exp(-dt / (this.bump > 0.05 ? 0.8 : 0.2)));
    return this.camP;
  }

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

  // Floor-safe dive: never command a descent that can't be stopped before the floor (vz >= -2(h - 0.6), i.e. a
  // 0.5 s exponential approach that needs ~2.4 g at 12 m/s; the quad has 5.5 g). h = clearance straight down, or along
  // the flight path when that hits an up-facing surface first (diving onto a lower roof ahead).
  _diveGuard(vzCmd, world) {
    if (vzCmd >= -1 || !world?.bvh) return vzCmd;
    const bvh = world.bvh;
    let h = 40;
    _ray.set(this.pos, DOWN);
    const hd = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, 40);
    if (hd) h = hd.distance;
    const sp = this.vel.length();
    if (sp > 3 && this.vel.y < -1) {
      _ray.set(this.pos, _v4.copy(this.vel).divideScalar(sp));
      const hp = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, 40);
      if (hp && hp.face && Math.abs(hp.face.normal.y) > 0.5) h = Math.min(h, hp.distance * -_ray.direction.y);
    }
    return Math.max(vzCmd, -Math.max(1, (h - 0.6) * 2.0));
  }

  _altitudeHold(vzCmd, up, dt) {
    const c = this.c, err = vzCmd - this.vel.y;
    this.vzI = Math.max(-4, Math.min(4, this.vzI + err * dt));
    const az = err * 3.2 + this.vzI * 2.0;
    const effFF = Math.min(1.3, Math.max(0.3, 1 - this.vel.dot(up) / c.pitchSpeed));   // prop inflow loss feed-forward
    return c.mass * (G + az) / Math.max(up.y, 0.25) / effFF;
  }

  step(dt, inp, mode, world) {
    const c = this.c, m = c.mass;
    this.prev.copy(this.pos);
    const up = this.up(_v2);
    let tCmd = 0;
    let wDes;

    if (mode !== 'cine' || this.crashed) {
      // keep Cine's smoothed commands in step with the real motion, so switching into Cine doesn't jolt
      this.vfS = -this.vel.x * Math.sin(this.heading) - this.vel.z * Math.cos(this.heading); this.yawS = 0;
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
      // wall-slide: just after touching a wall, drop the into-wall part of the target so pushing into it slides along
      // it (two walls remembered, so a corner holds a calm hover instead of pressing into one of them)
      for (let k = 0; k < 2; k++) {
        const wn = k ? this.wallN2 : this.wallN;
        if ((k ? this.wallT2 : this.wallT) <= 0) continue;
        const into = vdx * wn.x + vdz * wn.z;
        if (into < 0) { vdx -= into * wn.x; vdz -= into * wn.z; }
      }
      // velocity error + centripetal feed-forward for the turning target (omega_y x v_des)
      let ax = (vdx - this.vel.x) * kv + yawRate * vdz;
      let az = (vdz - this.vel.z) * kv - yawRate * vdx;
      const an = Math.hypot(ax, az); if (an > amax) { ax *= amax / an; az *= amax / an; }
      const pitchDeg = Math.atan((ax * fx + az * fz) / G) / DEG;
      const rollDeg = Math.atan((ax * rx + az * rz) / G) / DEG;
      wDes = this._rateForAttitude(pitchDeg, rollDeg, yawRate, dt, 7);
      // vertical: progressive curve, half stick ~ the old 4.5 m/s-linear feel, full stick cineClimb up / cineDive down
      const cz = clamp1(inp.climb);
      const vz = cz >= 0 ? c.cineClimb * cz * (0.6 + 0.4 * cz) : c.cineDive * cz * (0.15 - 0.85 * cz);
      tCmd = this._altitudeHold(this._diveGuard(vz, world), up, dt);
    }
    tCmd = Math.min(Math.max(tCmd, 0), this.tMax);

    // rates: tight PID abstracted as first-order response + turbulence/prop-wash torque noise
    const kR = 1 - Math.exp(-dt / c.tauRate);
    this.w.x += (wDes.x - this.w.x) * kR; this.w.y += (wDes.y - this.w.y) * kR; this.w.z += (wDes.z - this.w.z) * kR;
    const vAx = this.vel.dot(up);
    const tFrac = this.thrust / this.tMax;
    const wash = Math.min(1, Math.max(0, (-vAx - 2.0) / 6)) * Math.min(1, tFrac * 4);
    const near = world && world.lastDist !== undefined ? Math.max(0, 1 - world.lastDist / 0.6) : 0;
    const assist = mode === 'acro' ? 1 : 0.45;               // assisted modes are steadier
    const sigma = (2.0 + wash * 55 + near * 6) * assist + this.bump * 30;
    const th = 0.06;
    this.noise.x += (-this.noise.x / th) * dt + sigma * Math.sqrt(dt) * gauss();
    this.noise.y += (-this.noise.y / th) * dt + sigma * 0.4 * Math.sqrt(dt) * gauss();
    this.noise.z += (-this.noise.z / th) * dt + sigma * Math.sqrt(dt) * gauss();
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

    if (world?.bvh) this._collide(world, mode, dt);
    if (world?.envelope) this._envelope(world.envelope, dt);
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

  _collide(world, mode, dt) {
    const r = this.c.radius, bvh = world.bvh, e = 0.3, mu = 0.25;
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
      _ray.set(this.prev, d);
      const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, len + r);
      if (hit && hit.face) {
        const n = _v2.copy(hit.face.normal); if (n.dot(d) > 0) n.negate();
        this.pos.copy(this.prev).addScaledVector(d, Math.max(0, hit.distance - r - 0.002));
        resolve(n);
      }
    }
    // penetration push-out
    for (let it = 0; it < 3; it++) {
      const res = bvh.closestPointToPoint(this.pos, _cp, 0, r);
      // three-mesh-bvh's maxThreshold only culls BVH nodes: it returns the nearest triangle of any leaf whose box is
      // within r, even when that triangle is metres away. Without this check the quad got teleported onto it
      // ("phantom snaps" of up to 3.6 m, and the no-crossing guard then froze it in place).
      if (!res || res.distance >= r) break;
      const n = _v2.copy(this.pos).sub(res.point); const dist = n.length();
      if (dist < 1e-6) break;
      n.divideScalar(dist);
      this.pos.copy(res.point).addScaledVector(n, r + 0.003);
      resolve(n);
    }
    // final guard: whatever the push-outs did, the step may never cross a surface
    {
      const seg = _v1.copy(this.pos).sub(this.prev), L = seg.length();
      if (L > 1e-5) {
        seg.divideScalar(L); _ray.set(this.prev, seg);
        const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, L);
        if (hit && hit.face) {
          const n = _v2.copy(hit.face.normal); if (n.dot(seg) > 0) n.negate();
          this.pos.copy(this.prev);
          const vn = this.vel.dot(n); if (vn < 0) this.vel.addScaledVector(n, -1.3 * vn);
          touched = true; n0.add(n);
        }
      }
    }
    // Cine wall-slide memory: horizontal normals of the last two wall-ish contacts (not floors), held for 0.35 s
    this.wallT = Math.max(0, this.wallT - dt); this.wallT2 = Math.max(0, this.wallT2 - dt);
    if (touched) {
      const nl = n0.length(), hl = Math.hypot(n0.x, n0.z);
      if (nl > 1e-6 && hl > 0.5 * nl) {
        const nx = n0.x / hl, nz = n0.z / hl;
        if (this.wallT > 0 && nx * this.wallN.x + nz * this.wallN.z < 0.85) { this.wallN2.copy(this.wallN); this.wallT2 = this.wallT; }
        this.wallN.set(nx, 0, nz); this.wallT = 0.35;
      }
      this._sN.add(n0); this._sC += dt;
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
      this.w.x += gauss() * impact * 2.0; this.w.z += gauss() * impact * 2.0; this.w.y += gauss() * impact * 0.8;
      if (!this.crashed && impact > crashAt) { this.crashed = true; this.crashT = 0; this.onCrash?.(impact); }
    }
  }
}
