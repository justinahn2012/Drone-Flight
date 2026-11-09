#!/usr/bin/env python3
"""Neon Seoul camera gate (PLAN-P2 "binding numbers", panel 1 colour #6): frame stats on a seoulsnap shot set.

  python3 /home/claude/scripts/seoulsnap.py --dir . --shots walk0,club90,club270,station --size 960x540 --out /tmp/snap | tee /tmp/snap.log
  python3 tools/camgate.py --stills /tmp/snap --log /tmp/snap.log [--hero walk0,club90,club270,station] [--json out.json]

Gate (hero streets; exit 1 if any fails):
  clip        share of pixels with any channel >= 250            <= 3 %
  blob        largest 8-connected clipped blob                    <= 5 %
  ev          converged AE EV (from the seoulsnap log)            -1 .. +1.5  (ISO ~1600-6400)
  ground      median luma of the shot's ground box (GROUND below) >= 40
  sky         median luma of the darkest half of the top quarter  <= 30 (near black; colour #4 wants 12-25)
Reported (colour targets, informational): p50, share below 16 (<= 25 %), bright-saturated area (>= 5 %), bright near-white
area (<= 4 %), warm share of bright saturated (40-55 %), magenta+cyan+violet share (30-45 %), dark-flat luma noise (3-6 DN).
Needs numpy, Pillow, scipy. Stills are 8-bit sRGB (seoulsnap JPEGs).
"""
import argparse, glob, json, os, re, sys
import numpy as np
from PIL import Image
from scipy import ndimage

# ground boxes [x0, x1, y0, y1] as fractions of the frame (top-down), per seoulsnap shot name
GROUND = {'walk0': [0.40, 0.70, 0.88, 1.0], 'walk180': [0.35, 0.65, 0.88, 1.0], 'club90': [0.02, 0.30, 0.86, 1.0], 'club270': [0.10, 0.60, 0.84, 1.0],
          'station': [0.00, 0.45, 0.86, 1.0], 'station2': [0.30, 0.70, 0.88, 1.0], 'w21': [0.35, 0.65, 0.86, 1.0]}
GATE = dict(clip=3.0, blob=5.0, ev=(-1.0, 1.5), ground=40.0, sky=30.0)
LUMA = np.array([0.2126, 0.7152, 0.0722])

def stats(path, name):
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    H, W = im.shape[:2]
    Y = im @ LUMA
    mx, mn = im.max(-1), im.min(-1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    clip = mx >= 250
    lab, n = ndimage.label(clip, structure=np.ones((3, 3)))
    blob = (np.bincount(lab.ravel())[1:].max() / clip.size * 100) if n else 0.0
    o = dict(p50=float(np.median(Y)), clip=float(clip.mean() * 100), blob=float(blob), lt16=float((Y < 16).mean() * 100))
    bs = (mx > 150) & (sat > 0.45)
    o['bsat'] = float(bs.mean() * 100); o['bwhite'] = float(((mx > 200) & (sat < 0.15)).mean() * 100)
    if bs.sum() > 50:
        r, g, b = (im[..., i][bs] / 255 for i in range(3))
        M = np.maximum(np.maximum(r, g), b); m = np.minimum(np.minimum(r, g), b); d = M - m + 1e-6
        h = np.where(M == r, ((g - b) / d) % 6, np.where(M == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
        o['warm'] = float((((h >= 345) | (h < 70))).mean() * 100)
        o['mcv'] = float(((((h >= 160) & (h < 200)) | ((h >= 255) & (h < 345)))).mean() * 100)
    gb = GROUND.get(name)
    if gb:
        x0, x1, y0, y1 = gb
        o['ground'] = float(np.median(Y[int(H * y0):int(H * y1), int(W * x0):int(W * x1)]))
    top = Y[: H // 4]
    o['sky'] = float(np.median(top[top <= np.median(top)]))
    # dark-flat luma noise (5 px high-pass in flat regions with local mean 12..80)
    Yd = Y.astype(np.float64)
    m5 = ndimage.uniform_filter(Yd, 5); v = ndimage.uniform_filter((Yd - m5) ** 2, 9)
    gy, gx = np.gradient(ndimage.uniform_filter(Yd, 7)); flat = (m5 > 12) & (m5 < 80) & (np.hypot(gx, gy) < 1.0)
    o['noise'] = float(np.sqrt(v[flat].mean())) if flat.sum() > 500 else None
    return o

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stills', required=True); ap.add_argument('--log', default=None)
    ap.add_argument('--hero', default='walk0,walk180,club90,club270,station,station2'); ap.add_argument('--json', default=None)
    a = ap.parse_args()
    evs = {}
    if a.log and os.path.exists(a.log):
        for m in re.finditer(r'shot (\w+) -> \S+\s+EV (-?[\d.]+)', open(a.log).read()): evs[m.group(1)] = float(m.group(2))
    hero = set(a.hero.split(','))
    rows, fails = {}, []
    for f in sorted(glob.glob(os.path.join(a.stills, '*.jpg')) + glob.glob(os.path.join(a.stills, '*.png'))):
        name = os.path.splitext(os.path.basename(f))[0]
        o = stats(f, name); o['ev'] = evs.get(name); rows[name] = o
        if name not in hero: continue
        if o['clip'] > GATE['clip']: fails.append(f'{name}: clip {o["clip"]:.2f} % > {GATE["clip"]}')
        if o['blob'] > GATE['blob']: fails.append(f'{name}: blob {o["blob"]:.2f} % > {GATE["blob"]}')
        if o['ev'] is not None and not (GATE['ev'][0] <= o['ev'] <= GATE['ev'][1]): fails.append(f'{name}: EV {o["ev"]:+.2f} outside {GATE["ev"]}')
        if o.get('ground') is not None and o['ground'] < GATE['ground']: fails.append(f'{name}: ground p50 {o["ground"]:.0f} < {GATE["ground"]:.0f}')
        if o['sky'] > GATE['sky']: fails.append(f'{name}: sky {o["sky"]:.0f} > {GATE["sky"]:.0f}')
    fmt = lambda v, s='{:6.1f}': (s.format(v) if v is not None else '     -')
    print(f'{"shot":10s} {"EV":>6s} {"clip%":>6s} {"blob%":>6s} {"ground":>6s} {"sky":>6s} {"p50":>6s} {"<16%":>6s} {"bsat%":>6s} {"bwht%":>6s} {"warm%":>6s} {"mcv%":>6s} {"noise":>6s}')
    for n, o in rows.items():
        print(f'{n:10s} ' + ' '.join(fmt(o.get(k), '{:+6.2f}' if k == 'ev' else '{:6.1f}') for k in ('ev', 'clip', 'blob', 'ground', 'sky', 'p50', 'lt16', 'bsat', 'bwhite', 'warm', 'mcv', 'noise')))
    if a.json: json.dump({'rows': rows, 'fails': fails, 'gate': GATE}, open(a.json, 'w'), indent=1)
    print('\nGATE ' + ('PASS' if not fails else 'FAIL\n  ' + '\n  '.join(fails)))
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    main()
