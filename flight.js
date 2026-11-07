// flight.js — quadcopter flight model + collision against the world's collider mesh.
// Body frame: +x right, +y up (thrust axis), -z forward (camera looks along -z).
import * as THREE from 'three';

const G = 9.81, RHO_HALF = 0.6, DEG = Math.PI / 180;

export const CRAFTS = {
  freestyle5: {
    label: '5" Freestyle', mass: 0.68, twr: 6.5, radius: 0.12, cdA: [0.026, 0.06, 0.026], pitchSpeed: 60,
    rates: { roll: [200, 720, 0.55], pitch: [200, 720, 0.55], yaw: [160, 520, 0.45] },
    tauRate: 0.022, tauMotor: 0.035, camTilt: 28, crashSpeed: 7.0, maxAngle: 50, cineSpeedTilt: 42,
  },
  cinewhoop: {
    label: '3" Cinewhoop', mass: 0.34, twr: 4.0, radius: 0.085, cdA: [0.022, 0.07, 0.022], pitchSpeed: 32,
    rates: { roll: [150, 520, 0.5], pitch: [150, 520, 0.5], yaw: [120, 380, 0.4] },
    tauRate: 0.03, tauMotor: 0.03, camTilt: 12, crashSpeed: 5.0, maxAngle: 35, cineSpeedTilt: 28,
  },
};

// Betaflight "Actual" rates (centre sensitivity, max rate, expo) -> rad/s
export function actualRate(x, [center, max, expo]) {
  const ax = Math.abs(x);
  const expof = ax * (Math.pow(x, 5) * expo + x * (1 - expo));
  return (x * center + Math.max(0, max - center) * expof) * DEG;
}

function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _ray = new THREE.Ray();
const _cp = {};
const UP = new THREE.Vector3(0, 1, 0);
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);

export class Drone {
  constructor(craftKey = 'freestyle5') {
    this.pos = new THREE.Vector3(); this.prev = new THREE.Vector3();
    this.vel = new THREE.Vector3(); this.q = new THREE.Quaternion();
    this.w = new THREE.Vector3();      // body rates (rad/s)
    this.noise = new THREE.Vector3();  // OU turbulence state
    this.thrust = 0; this.motors = [0, 0, 0, 0];
    this.crashed = false; this.crashT = 0; this.lastImpact = 0; this.bump = 0;
    this.heading = 0; this.throttleHold = 0.35;
    this.setCraft(craftKey);
  }
  setCraft(key) { this.key = key; this.c = CRAFTS[key]; this.tMax = this.c.twr * this.c.mass * G; }

  reset(pos, yaw) {
    this.pos.copy(pos); this.prev.copy(pos); this.vel.set(0, 0, 0); this.w.set(0, 0, 0); this.noise.set(0, 0, 0);
    this.q.setFromAxisAngle(UP, yaw); this.heading = yaw;
    this.thrust = this.c.mass * G; this.crashed = false; this.crashT = 0; this.lastImpact = 0;
    this.throttleHold = Math.sqrt(1 / this.c.twr); this.vzI = 0;
  }

  up(out = new THREE.Vector3()) { return out.copy(UP).applyQuaternion(this.q); }

  // Attitude controller for angle / cine modes: target tilt from sticks, heading integrates yaw.
  _rateForAttitude(pitchDeg, rollDeg, yawRate, dt) {
    this.heading += yawRate * dt;
    _q1.setFromAxisAngle(AY, this.heading);
    _q2.setFromAxisAngle(AX, -pitchDeg * DEG); _q1.multiply(_q2);
    _q2.setFromAxisAngle(AZ, -rollDeg * DEG); _q1.multiply(_q2);
    _q2.copy(this.q).invert().multiply(_q1);            // error in body frame
    if (_q2.w < 0) { _q2.x = -_q2.x; _q2.y = -_q2.y; _q2.z = -_q2.z; _q2.w = -_q2.w; }
    const k = 11;
    return _v3.set(2 * k * _q2.x, 2 * k * _q2.y + 0 * yawRate, 2 * k * _q2.z);
  }

  _syncHeading() {
    const f = _v1.set(0, 0, -1).applyQuaternion(this.q);
    if (Math.hypot(f.x, f.z) > 0.2) this.heading = Math.atan2(-f.x, -f.z);
  }

  step(dt, inp, mode, world) {
    const c = this.c, m = c.mass;
    this.prev.copy(this.pos);
    const up = this.up(_v2);
    let tCmd = 0;
    const wDes = new THREE.Vector3();

    if (this.crashed) {
      this.crashT += dt;
      tCmd = 0;
      wDes.copy(this.w).multiplyScalar(0.995);
    } else if (mode === 'acro') {
      this._syncHeading();
      wDes.set(-actualRate(inp.pitch, c.rates.pitch), -actualRate(inp.yaw, c.rates.yaw), -actualRate(inp.roll, c.rates.roll));
      tCmd = this.tMax * inp.thr * inp.thr;
    } else {
      // angle & cine: stick -> tilt; cine adds coordinated turns + vertical-speed hold
      const cine = mode === 'cine';
      const maxA = cine ? c.cineSpeedTilt : c.maxAngle;
      const yawRate = -actualRate(inp.yaw, c.rates.yaw) * (cine ? 0.55 : 1);
      let coord = 0;
      if (cine) {
        const vh = Math.max(3, Math.hypot(this.vel.x, this.vel.z));
        const bank = inp.roll * maxA * DEG;
        coord = -G * Math.tan(bank) / vh * Math.min(1, vh / 4);   // coordinated turn: psi_dot = g tan(phi) / V
      }
      wDes.copy(this._rateForAttitude(inp.pitch * maxA, inp.roll * maxA, yawRate + coord, dt));
      if (cine) {
        const vzCmd = inp.climb * 4.0;
        const err = vzCmd - this.vel.y;
        this.vzI = Math.max(-4, Math.min(4, (this.vzI || 0) + err * dt));
        const az = err * 3.2 + this.vzI * 2.0;
        const effFF = Math.min(1.3, Math.max(0.3, 1 - this.vel.dot(up) / c.pitchSpeed));   // feed-forward prop inflow loss
        tCmd = m * (G + az) / Math.max(up.y, 0.25) / effFF;
      } else {
        tCmd = this.tMax * inp.thr * inp.thr;
      }
    }
    tCmd = Math.min(Math.max(tCmd, 0), this.tMax);

    // rates: tight PID abstracted as first-order response + turbulence/prop-wash torque noise
    const kR = 1 - Math.exp(-dt / c.tauRate);
    this.w.x += (wDes.x - this.w.x) * kR; this.w.y += (wDes.y - this.w.y) * kR; this.w.z += (wDes.z - this.w.z) * kR;
    const vAx = this.vel.dot(up);
    const tFrac = this.thrust / this.tMax;
    const wash = Math.min(1, Math.max(0, (-vAx - 2.0) / 6)) * Math.min(1, tFrac * 4);
    const near = world?.lastDist !== undefined ? Math.max(0, 1 - world.lastDist / 0.6) : 0;
    const sigma = 2.0 + wash * 55 + near * 6 + this.bump * 30;
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
    // motor "rpm" for audio: collective + mixing from rate error
    const e = wDes.clone().sub(this.w);
    const base = Math.sqrt(this.thrust / this.tMax);
    const mix = (a, b, cc) => Math.min(1, Math.max(0, base + 0.02 * (a * e.x + b * e.z + cc * e.y)));
    this.motors[0] = mix(-1, -1, 1); this.motors[1] = mix(-1, 1, -1); this.motors[2] = mix(1, -1, -1); this.motors[3] = mix(1, 1, 1);

    // forces
    const F = _v1.copy(up).multiplyScalar(T);
    F.y -= m * G;
    _q1.copy(this.q).invert();
    const vb = _v3.copy(this.vel).applyQuaternion(_q1);
    vb.set(-RHO_HALF * c.cdA[0] * Math.abs(vb.x) * vb.x, -RHO_HALF * c.cdA[1] * Math.abs(vb.y) * vb.y, -RHO_HALF * c.cdA[2] * Math.abs(vb.z) * vb.z);
    vb.applyQuaternion(this.q);
    F.add(vb).addScaledVector(this.vel, -0.02);
    this.vel.addScaledVector(F, dt / m);
    this.pos.addScaledVector(this.vel, dt);

    if (world?.bvh) this._collide(world);
  }

  _collide(world) {
    const r = this.c.radius, bvh = world.bvh;
    let impact = 0;
    const resolve = (n) => {
      const vn = this.vel.dot(n);
      if (vn < 0) {
        impact = Math.max(impact, -vn);
        this.vel.addScaledVector(n, -(1 + 0.35) * vn);
        const vt = _v3.copy(this.vel).addScaledVector(n, -this.vel.dot(n));
        this.vel.addScaledVector(vt, -0.18);
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
      if (!res) break;
      const n = _v2.copy(this.pos).sub(res.point); const dist = n.length();
      if (dist < 1e-6) break;
      n.divideScalar(dist);
      this.pos.copy(res.point).addScaledVector(n, r + 0.002);
      resolve(n);
    }
    if (impact > 0.4) {
      this.lastImpact = impact;
      this.bump = Math.min(1, impact / 4);
      // a bump spins the quad — that's what makes wall taps look real
      this.w.x += gauss() * impact * 2.5; this.w.z += gauss() * impact * 2.5; this.w.y += gauss() * impact;
      if (!this.crashed && impact > this.c.crashSpeed) { this.crashed = true; this.crashT = 0; this.onCrash?.(impact); }
    }
  }
}
