// controls.js — touch sticks, gamepad / USB radio, keyboard.
//
// Touch: floating origin in both orientations — wherever a thumb lands is stick centre, so a sloppy touchdown is never
// a jolt. Landscape draws a ring at the touch point (#fL/#fR); portrait drives the radio gimbal knobs (.top).
// Sizes are read from the live layout (wells may be re-gridded by CSS at any time), never hard-coded.
//
// Interface for index.html / CSS:
//  - `--R` (px) = full-deflection throw, set on #fL/#fR and on each .well. Knobs move x·R px (transform), so a gate
//    ring of radius var(--R) matches the travel exactly.
//  - controls.onStickStart = (side) => {}   called when a thumb lands on a stick ('L' | 'R')
//  - controls.cancelAll()                   drops every touch; also runs by itself on orientation change, page hide
//                                           and when `enabled` goes false
//  - controls.padKind                       'pad' | 'radio' | null — which device is driving the sticks
//  - ?radio=TAER (URL) overrides the USB-radio channel order (default AETR, the EdgeTX/OpenTX default)

const DZ = 0.07;            // touch deadzone (fraction of R)
const BOWTIE = 0.12;        // Cine: extra cross-axis deadzone per unit of the other axis (thumb arcs don't carve)
const PAD_DZ = 0.06;        // gamepad deadzone, rescaled so the output starts from 0
const RADIO_DZ = 0.01;      // USB radio deadzone (hall gimbals barely drift)
const RADIO_MID_DZ = 0.06;  // Cine on a radio: non-centring throttle, hold band around mid stick
const R_WELL = 0.34;        // portrait throw as a fraction of the well size
const R_MIN_VMIN = 0.13;    // ...but never below this fraction of the short screen side (small wells)
const EDGE = 8;             // px kept clear of a screen edge when computing reach
const REACH_MIN = 0.45;     // reach compensation never shrinks a throw below this fraction of R

const clamp1 = (v) => Math.max(-1, Math.min(1, v));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const dzr = (v, d) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
const ex = (v, e) => v * (1 - e) + v * v * v * e;

export class Controls {
  constructor({ view, radio, leftWell, rightWell, leftTop, rightTop, floatL, floatR }) {
    this.view = view; this.radio = radio;
    this.wells = { L: leftWell, R: rightWell }; this.tops = { L: leftTop, R: rightTop }; this.floats = { L: floatL, R: floatR };
    this.mode = 'cine';
    this.thr = 0.39; this.yaw = 0; this.pitch = 0; this.roll = 0; this.climb = 0;
    this.sticks = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };
    this.touches = new Map();          // touchId -> { side, ox, oy, thr0, R, rL, rR, rU, rD, portrait }
    this.keys = new Set();
    this.padActive = false; this.padKind = null; this._padRef = null; this._en = true;
    this.radioMap = 'AETR';
    try { const m = new URLSearchParams(location.search).get('radio'); if (m && /^[AETR]{4}$/i.test(m) && new Set(m.toUpperCase()).size === 4) this.radioMap = m.toUpperCase(); } catch (e) {}
    this.onButton = null; this.onStickStart = null;
    this.Rland = 76; this.Rwell = { L: 0, R: 0 }; this.insets = { t: 0, r: 0, b: 0, l: 0 };
    this._knob = { L: '', R: '' };
    this._wasPortrait = this._portraitNow();
    this._bind();
    this.measure();
    requestAnimationFrame(() => this.measure());   // after main.js's first layout()
  }

  get throttleCentering() { return this.mode === 'cine'; }
  get enabled() { return this._en; }
  set enabled(v) { this._en = !!v; if (!v) this.cancelAll(); }

  _portrait() { return document.body.classList.contains('portrait'); }
  _portraitNow() { return window.innerHeight > window.innerWidth * 1.05; }   // same rule as main.js layout()

  // Read the throws from the live layout and publish them as --R. Cheap; runs on resize and at every touch-down.
  measure() {
    const W = window.innerWidth, H = window.innerHeight;
    this.Rland = Math.max(40, Math.min(95, H * 0.2));
    const rMin = R_MIN_VMIN * Math.min(W, H);
    for (const s of ['L', 'R']) {
      const w = this.wells[s];
      const ww = w ? w.getBoundingClientRect().width : 0;   // 0 while the radio is hidden (landscape)
      if (ww > 0) {
        this.Rwell[s] = Math.max(R_WELL * ww, rMin);
        w.style.setProperty('--R', this.Rwell[s].toFixed(1) + 'px');
      }
      const f = this.floats[s];
      if (f) f.style.setProperty('--R', (this._portrait() && this.Rwell[s] ? this.Rwell[s] : this.Rland).toFixed(1) + 'px');
    }
    this.insets = this._readInsets();
  }

  _readInsets() {
    try {
      if (!this._probe) {
        const p = document.createElement('div');
        p.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
          'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
        document.body.appendChild(p); this._probe = p;
      }
      const cs = getComputedStyle(this._probe);
      return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
    } catch (e) { return { t: 0, r: 0, b: 0, l: 0 }; }
  }

  _side(x, y) {
    if (this._portrait()) {
      const rr = this.radio.getBoundingClientRect();
      if (y < rr.top) return null;
      return x < rr.left + rr.width / 2 ? 'L' : 'R';
    }
    return x < window.innerWidth / 2 ? 'L' : 'R';
  }

  // A thumb landed: that point is stick centre. Throw R from the live layout; each direction's throw shrinks to the room
  // left before the screen edge (a thumb landing near the bottom can still reach full down), but never below REACH_MIN·R.
  _begin(id, side, x, y) {
    this.measure();
    const portrait = this._portrait();
    const R = portrait && this.Rwell[side] ? this.Rwell[side] : this.Rland;
    const W = window.innerWidth, H = window.innerHeight, ins = this.insets, lo = REACH_MIN * R;
    const room = (d) => Math.max(lo, Math.min(R, d - EDGE));
    this.touches.set(id, {
      side, ox: x, oy: y, thr0: this.thr, R, portrait,
      rL: room(x - ins.l), rR: room(W - ins.r - x), rU: room(y - ins.t), rD: room(H - ins.b - y),
    });
    this.padActive = false; this._padRef = null;          // touch takes over from a pad until the pad moves again
    this._move({ identifier: id, clientX: x, clientY: y });
    this.onStickStart?.(side);
  }

  _release(s) {
    const st = this.sticks[s.side];
    st.x = 0;
    if (!(s.side === 'L' && !this.throttleCentering)) st.y = 0;   // manual throttle stays where it was left
    const f = this.floats[s.side]; if (f) f.style.opacity = 0;
  }

  cancelAll() {
    for (const s of this.touches.values()) this._release(s);
    this.touches.clear();
  }

  _bind() {
    const opts = { passive: false };
    const start = (e) => {
      if (!this._en) return;
      for (const t of e.changedTouches) {
        if (t.target.closest && t.target.closest('button, .ui, input, select')) continue;
        const side = this._side(t.clientX, t.clientY);
        if (!side || [...this.touches.values()].some((v) => v.side === side)) continue;
        this._begin(t.identifier, side, t.clientX, t.clientY);
        e.preventDefault();
      }
    };
    const move = (e) => { for (const t of e.changedTouches) if (this.touches.has(t.identifier)) { this._move(t); e.preventDefault(); } };
    const end = (e) => {
      for (const t of e.changedTouches) {
        const s = this.touches.get(t.identifier); if (!s) continue;
        this.touches.delete(t.identifier);
        this._release(s);
      }
    };
    document.addEventListener('touchstart', start, opts);
    document.addEventListener('touchmove', move, opts);
    document.addEventListener('touchend', end, opts);
    document.addEventListener('touchcancel', end, opts);
    // mouse drag for desktop testing
    let mouse = false;
    document.addEventListener('mousedown', (e) => {
      if (!this._en || e.target.closest('button, .ui, input, select')) return;
      const side = this._side(e.clientX, e.clientY);
      if (!side || this.touches.has('m') || [...this.touches.values()].some((v) => v.side === side)) return;
      mouse = true; this._begin('m', side, e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', (e) => { if (mouse) this._move({ identifier: 'm', clientX: e.clientX, clientY: e.clientY }); });
    document.addEventListener('mouseup', () => { if (mouse) { end({ changedTouches: [{ identifier: 'm' }] }); mouse = false; } });
    window.addEventListener('keydown', (e) => { this.keys.add(e.code); if (e.code === 'KeyR') this.onButton?.('reset'); if (e.code === 'Escape') this.onButton?.('menu'); });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // Stale touches survive a rotation / app switch on iOS (no touchend), which reads as instant full stick: drop them.
    const cancel = () => { this.cancelAll(); this.keys.clear(); };
    window.addEventListener('orientationchange', () => { cancel(); setTimeout(() => this.measure(), 300); });
    try { screen.orientation?.addEventListener?.('change', cancel); } catch (e) {}
    window.addEventListener('blur', cancel);
    window.addEventListener('pagehide', cancel);
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
    window.addEventListener('resize', () => {
      const p = this._portraitNow();
      if (p !== this._wasPortrait) { this._wasPortrait = p; cancel(); }
      requestAnimationFrame(() => this.measure());        // after main.js layout() has re-flowed the radio
    });
  }

  _move(t) {
    const s = this.touches.get(t.identifier); if (!s) return;
    const st = this.sticks[s.side];
    const dx = t.clientX - s.ox, dy = t.clientY - s.oy;
    const x = clamp1(dx / (dx < 0 ? s.rL : s.rR)), y = clamp1(-dy / (dy > 0 ? s.rD : s.rU));
    if (!s.portrait) {
      const f = this.floats[s.side];
      if (f) {
        f.style.opacity = 1; f.style.transform = `translate(${s.ox}px, ${s.oy}px)`;
        const k = f.querySelector('i'); if (k) k.style.transform = `translate(${(x * s.R).toFixed(1)}px, ${(-y * s.R).toFixed(1)}px)`;
      }
    }
    if (s.side === 'L' && !this.throttleCentering) {
      // relative throttle on a floating stick: drag up/down from where the thumb landed (a full throw = 0.45 throttle)
      st.x = dzr(x, DZ); st.y = clamp01(s.thr0 + y * 0.45) * 2 - 1; return;
    }
    // Cine "bowtie": the cross-axis deadzone widens with deflection, so a thumb arcing on full speed doesn't carve
    // (and on the left stick a hard turn doesn't drift the altitude)
    const cine = this.mode === 'cine';
    st.x = dzr(x, cine ? DZ + BOWTIE * Math.abs(y) : DZ);
    st.y = dzr(y, cine && s.side === 'L' ? DZ + BOWTIE * Math.abs(x) : DZ);
  }

  poll(dt) {
    let lx = this.sticks.L.x, ly = this.sticks.L.y, rx = this.sticks.R.x, ry = this.sticks.R.y;
    // gamepad (Mode 2) or USB radio
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const ax = p.axes;
      // An EdgeTX/OpenTX radio in USB-joystick mode has no standard mapping: channels on axes 0-3 (AETR by default),
      // full-range non-centring throttle, and switches as buttons (never mapped: an arm switch must not reset).
      const radio = p.mapping !== 'standard' && ax.length >= 4;
      // The pad takes over when a stick moves away from where it was when touch last had control (a change, not an
      // absolute value, because a radio's throttle rests at -1).
      if (!this.padActive) {
        if (!this._padRef) this._padRef = Array.from(ax.slice(0, 4));
        else if (ax.slice(0, 4).some((v, i) => Math.abs(v - this._padRef[i]) > 0.15)) this.padActive = true;
      }
      if (this.padActive) {
        if (radio) {
          const m = this.radioMap, g = (ch) => { const v = clamp1(ax[m.indexOf(ch)] ?? 0); return Math.abs(v) < RADIO_DZ ? 0 : v; };
          rx = g('A'); ry = g('E'); lx = g('R');
          const t = clamp1(ax[m.indexOf('T')] ?? -1);
          ly = this.throttleCentering ? dzr(t, RADIO_MID_DZ) : t;   // Cine: mid stick = hold altitude
          this.padKind = 'radio';
        } else {
          const dz = (v) => dzr(clamp1(v ?? 0), PAD_DZ);
          lx = dz(ax[0]); ly = -dz(ax[1]); rx = dz(ax[2]); ry = -dz(ax[3]);
          this.padKind = 'pad';
        }
      }
      if (!radio) {
        if (p.buttons[0]?.pressed && !this._b0) this.onButton?.('reset');
        if (p.buttons[9]?.pressed && !this._b9) this.onButton?.('menu');
      }
      this._b0 = p.buttons[0]?.pressed; this._b9 = p.buttons[9]?.pressed;
      break;
    }
    if (!this.padActive) this.padKind = null;
    // keyboard
    const k = this.keys;
    if (k.size) {
      const a = (p, n) => (k.has(p) ? 1 : 0) - (k.has(n) ? 1 : 0);
      if (k.has('KeyA') || k.has('KeyD')) lx = a('KeyD', 'KeyA');
      if (k.has('ArrowLeft') || k.has('ArrowRight')) rx = a('ArrowRight', 'ArrowLeft');
      if (k.has('ArrowUp') || k.has('ArrowDown')) ry = a('ArrowUp', 'ArrowDown');
      if (this.throttleCentering) { if (k.has('KeyW') || k.has('KeyS')) ly = a('KeyW', 'KeyS'); }
      else if (k.has('KeyW') || k.has('KeyS')) { this.thr = clamp01(this.thr + a('KeyW', 'KeyS') * dt * 0.6); ly = this.thr * 2 - 1; this.sticks.L.y = ly; }
    }
    if (this.throttleCentering) {
      // Cine: this expo is the only stick shaping (flight.js maps it to speeds)
      this.yaw = ex(lx, 0.55); this.roll = ex(rx, 0.55); this.pitch = ex(ry, 0.45); this.climb = ex(ly, 0.35);
    } else {
      // Angle/Acro: Betaflight Actual rates already carry the expo; touch gets a little extra for thumb precision,
      // a gamepad or radio gets none (no double expo = no mushy centre)
      const e = this.padActive ? 0 : 0.2;
      this.yaw = ex(lx, e); this.roll = ex(rx, e); this.pitch = ex(ry, e);
      this.thr = (ly + 1) / 2;
    }
    // draw radio gimbals: knob travel x·R px
    for (const side of ['L', 'R']) {
      const top = this.tops[side]; if (!top) continue;
      const R = this.Rwell[side] || 0;
      const x = side === 'L' ? lx : rx, y = side === 'L' ? ly : ry;
      const tr = `translate(calc(-50% + ${(x * R).toFixed(1)}px), calc(-50% + ${(-y * R).toFixed(1)}px))`;
      if (tr !== this._knob[side]) { top.style.transform = tr; this._knob[side] = tr; }
    }
    return this;
  }

  resetThrottle(hover) { this.thr = hover; this.sticks.L.y = this.throttleCentering ? 0 : hover * 2 - 1; }
}
