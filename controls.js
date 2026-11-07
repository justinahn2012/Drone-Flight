// controls.js — touch sticks (floating in landscape, radio gimbals in portrait), gamepad, keyboard.
export class Controls {
  constructor({ view, radio, leftWell, rightWell, leftTop, rightTop, floatL, floatR }) {
    this.view = view; this.radio = radio;
    this.wells = { L: leftWell, R: rightWell }; this.tops = { L: leftTop, R: rightTop }; this.floats = { L: floatL, R: floatR };
    this.mode = 'cine';
    this.thr = 0.39; this.yaw = 0; this.pitch = 0; this.roll = 0; this.climb = 0;
    this.sticks = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };
    this.touches = new Map();          // touchId -> { side, ox, oy, thr0 }
    this.keys = new Set();
    this.padActive = false; this.enabled = true;
    this.onButton = null;
    this._bind();
  }

  get throttleCentering() { return this.mode === 'cine'; }

  _side(x, y) {
    const portrait = document.body.classList.contains('portrait');
    if (portrait) {
      const rr = this.radio.getBoundingClientRect();
      if (y < rr.top) return null;
      return x < rr.left + rr.width / 2 ? 'L' : 'R';
    }
    return x < window.innerWidth / 2 ? 'L' : 'R';
  }

  _bind() {
    const opts = { passive: false };
    const start = (e) => {
      if (!this.enabled) return;
      for (const t of e.changedTouches) {
        if (t.target.closest && t.target.closest('button, .ui, input, select')) continue;
        const side = this._side(t.clientX, t.clientY);
        if (!side || [...this.touches.values()].some(v => v.side === side)) continue;
        this.touches.set(t.identifier, { side, ox: t.clientX, oy: t.clientY, thr0: this.thr });
        this._move(t);
        e.preventDefault();
      }
    };
    const move = (e) => { for (const t of e.changedTouches) if (this.touches.has(t.identifier)) { this._move(t); e.preventDefault(); } };
    const end = (e) => {
      for (const t of e.changedTouches) {
        const s = this.touches.get(t.identifier); if (!s) continue;
        this.touches.delete(t.identifier);
        const st = this.sticks[s.side];
        st.x = 0;
        if (!(s.side === 'L' && !this.throttleCentering)) st.y = 0;
        if (this.floats[s.side]) this.floats[s.side].style.opacity = 0;
      }
    };
    document.addEventListener('touchstart', start, opts);
    document.addEventListener('touchmove', move, opts);
    document.addEventListener('touchend', end, opts);
    document.addEventListener('touchcancel', end, opts);
    // mouse drag for desktop testing
    let mouse = null;
    document.addEventListener('mousedown', (e) => {
      if (!this.enabled || e.target.closest('button, .ui, input, select')) return;
      const side = this._side(e.clientX, e.clientY); if (!side) return;
      mouse = { identifier: 'm', side, ox: e.clientX, oy: e.clientY, thr0: this.thr };
      this.touches.set('m', mouse); this._move({ identifier: 'm', clientX: e.clientX, clientY: e.clientY });
    });
    document.addEventListener('mousemove', (e) => { if (mouse) this._move({ identifier: 'm', clientX: e.clientX, clientY: e.clientY }); });
    document.addEventListener('mouseup', () => { if (mouse) { end({ changedTouches: [{ identifier: 'm' }] }); mouse = null; } });
    window.addEventListener('keydown', (e) => { this.keys.add(e.code); if (e.code === 'KeyR') this.onButton?.('reset'); if (e.code === 'Escape') this.onButton?.('menu'); });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  _move(t) {
    const s = this.touches.get(t.identifier); if (!s) return;
    const st = this.sticks[s.side];
    const portrait = document.body.classList.contains('portrait');
    let x, y;
    if (portrait) {
      const r = this.wells[s.side].getBoundingClientRect();
      const R = r.width * 0.42;
      x = (t.clientX - (r.left + r.width / 2)) / R;
      y = -(t.clientY - (r.top + r.height / 2)) / R;
    } else {
      const R = Math.min(95, window.innerHeight * 0.2);
      x = (t.clientX - s.ox) / R; y = -(t.clientY - s.oy) / R;
      const f = this.floats[s.side];
      if (f) { f.style.opacity = 1; f.style.transform = `translate(${s.ox}px, ${s.oy}px)`; f.querySelector('i').style.transform = `translate(${Math.max(-1, Math.min(1, x)) * R}px, ${Math.max(-1, Math.min(1, -y)) * R}px)`; }
      if (s.side === 'L' && !this.throttleCentering) {
        // relative throttle on a floating stick: drag up/down from where the thumb landed
        const thr = Math.max(0, Math.min(1, s.thr0 + y * 0.45));
        st.x = Math.max(-1, Math.min(1, x)); st.y = thr * 2 - 1; return;
      }
    }
    const dz = (v) => Math.abs(v) < 0.07 ? 0 : (v - Math.sign(v) * 0.07) / 0.93;
    st.x = dz(Math.max(-1, Math.min(1, x))); st.y = dz(Math.max(-1, Math.min(1, y)));
  }

  poll(dt) {
    let lx = this.sticks.L.x, ly = this.sticks.L.y, rx = this.sticks.R.x, ry = this.sticks.R.y;
    // gamepad (Mode 2)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v) => Math.abs(v) < 0.06 ? 0 : v;
      const ax = p.axes;
      if (ax.some(v => Math.abs(v) > 0.15)) this.padActive = true;
      if (this.padActive) { lx = dz(ax[0]); ly = -dz(ax[1]); rx = dz(ax[2] ?? 0); ry = -dz(ax[3] ?? 0); }
      if (p.buttons[0]?.pressed && !this._b0) this.onButton?.('reset'); this._b0 = p.buttons[0]?.pressed;
      if (p.buttons[9]?.pressed && !this._b9) this.onButton?.('menu'); this._b9 = p.buttons[9]?.pressed;
      break;
    }
    // keyboard
    const k = this.keys;
    if (k.size) {
      const a = (p, n) => (k.has(p) ? 1 : 0) - (k.has(n) ? 1 : 0);
      if (k.has('KeyA') || k.has('KeyD')) lx = a('KeyD', 'KeyA');
      if (k.has('ArrowLeft') || k.has('ArrowRight')) rx = a('ArrowRight', 'ArrowLeft');
      if (k.has('ArrowUp') || k.has('ArrowDown')) ry = a('ArrowUp', 'ArrowDown');
      if (this.throttleCentering) { if (k.has('KeyW') || k.has('KeyS')) ly = a('KeyW', 'KeyS'); }
      else if (k.has('KeyW') || k.has('KeyS')) { this.thr = Math.max(0, Math.min(1, this.thr + a('KeyW', 'KeyS') * dt * 0.6)); ly = this.thr * 2 - 1; this.sticks.L.y = ly; }
    }
    const ex = (v, e) => v * (1 - e) + v * v * v * e;
    this.yaw = ex(lx, 0.55); this.roll = ex(rx, 0.55); this.pitch = ex(ry, 0.45);
    if (this.throttleCentering) { this.climb = ex(ly, 0.35); }
    else { this.thr = (ly + 1) / 2; }
    // draw radio gimbals
    for (const side of ['L', 'R']) {
      const top = this.tops[side]; if (!top) continue;
      const x = side === 'L' ? lx : rx, y = side === 'L' ? ly : ry;
      top.style.transform = `translate(calc(-50% + ${x * 34}%), calc(-50% + ${-y * 34}%))`;
    }
    return this;
  }

  resetThrottle(hover) { this.thr = hover; this.sticks.L.y = this.throttleCentering ? 0 : hover * 2 - 1; }
}
