#!/usr/bin/env python3
"""tools/parity-de.py --metal walk0-metal.png --ref native/OneTakeSeoul/Tests/SeoulBundleTests/ref/walk0.r0.png [--name walk0] [--max 3] [--out side.png]

[P8 H, PLAN-P8 native parity / panel7 native #2] Delta E 2000 between the Metal frame (MetalFrameTests: the browser's camera,
its retro-0 grade at the browser's EV, through the fisheye; alpha 255 = Metal drew geometry under all four taps) and the
browser's still of the same camera (camgate's <shot>.r0.png, 320 x 180, sRGB). Gated on the mean over the pixels Metal drew:
<= 3 (PARITY.md section 4). Exit 1 and a `FAIL [parity] ...` line past it (CI runs it through ci/run.mjs: ratcheted there).
Also prints the median / p90, the share of the frame compared, and the mean signed difference in L*, a*, b* (where the
gap is: too dark, too warm ...). --out writes browser | Metal | dE (x10, clipped) side by side.
Needs numpy, Pillow.
"""
import argparse, sys
import numpy as np
from PIL import Image

def srgb_to_lab(rgb):   # rgb 0..1, D65
    c = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = c @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)

def de2000(a, b):   # Sharma, Wu, Dalal (2005)
    L1, a1, b1 = a[..., 0], a[..., 1], a[..., 2]; L2, a2, b2 = b[..., 0], b[..., 1], b[..., 2]
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2); Cm = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cm ** 7 / (Cm ** 7 + 25.0 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p, h2p = np.degrees(np.arctan2(b1, a1p)) % 360, np.degrees(np.arctan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dh = h2p - h1p; dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh)); dh = np.where(C1p * C2p == 0, 0, dh)
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2))
    Lpm, Cpm = (L1 + L2) / 2, (C1p + C2p) / 2
    hs = h1p + h2p
    hpm = np.where(C1p * C2p == 0, hs, np.where(np.abs(h1p - h2p) <= 180, hs / 2, np.where(hs < 360, (hs + 360) / 2, (hs - 360) / 2)))
    T = 1 - 0.17 * np.cos(np.radians(hpm - 30)) + 0.24 * np.cos(np.radians(2 * hpm)) + 0.32 * np.cos(np.radians(3 * hpm + 6)) - 0.20 * np.cos(np.radians(4 * hpm - 63))
    dth = 30 * np.exp(-(((hpm - 275) / 25) ** 2)); Rc = 2 * np.sqrt(Cpm ** 7 / (Cpm ** 7 + 25.0 ** 7))
    SL = 1 + 0.015 * (Lpm - 50) ** 2 / np.sqrt(20 + (Lpm - 50) ** 2); SC = 1 + 0.045 * Cpm; SH = 1 + 0.015 * Cpm * T
    RT = -np.sin(np.radians(2 * dth)) * Rc
    return np.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--metal', required=True); ap.add_argument('--ref', required=True)
    ap.add_argument('--name', default='walk0'); ap.add_argument('--max', type=float, default=3.0); ap.add_argument('--out', default=None)
    a = ap.parse_args()
    m = np.asarray(Image.open(a.metal).convert('RGBA'), dtype=np.float64) / 255
    r = np.asarray(Image.open(a.ref).convert('RGB'), dtype=np.float64) / 255
    if m.shape[:2] != r.shape[:2]: print(f'FAIL [parity] {a.name}: Metal {m.shape[1]}x{m.shape[0]} against the still {r.shape[1]}x{r.shape[0]}'); sys.exit(1)
    mask = m[..., 3] > 0.99
    lm, lr = srgb_to_lab(m[..., :3]), srgb_to_lab(r)
    d = de2000(lr, lm)
    if mask.sum() < 0.3 * mask.size: print(f'FAIL [parity] {a.name}: Metal drew only {100 * mask.mean():.0f} % of the frame'); sys.exit(1)
    dv = d[mask]; diff = (lm - lr)[mask].mean(0)
    print(f'parity {a.name}: dE00 mean {dv.mean():.2f}, median {np.median(dv):.2f}, p90 {np.percentile(dv, 90):.2f} over {100 * mask.mean():.0f} % of the frame '
          f'(Metal - browser: L* {diff[0]:+.1f}, a* {diff[1]:+.1f}, b* {diff[2]:+.1f}); whole frame mean {d.mean():.2f}')
    if a.out:
        vis = np.clip(d / 10, 0, 1)[..., None] * np.ones(3); vis[~mask] = [0, 0, 0.3]
        Image.fromarray((np.concatenate([r, m[..., :3] * mask[..., None], vis], 1) * 255).round().astype(np.uint8)).save(a.out)
    if dv.mean() > a.max:
        print(f'FAIL [parity] {a.name}: mean dE00 {dv.mean():.2f} > {a.max:g} (Metal-drawn pixels, against the browser still)'); sys.exit(1)
    print(f'PASS [parity] {a.name}')

if __name__ == '__main__':
    main()
