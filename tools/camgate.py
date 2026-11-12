#!/usr/bin/env python3
"""Neon Seoul camera gate (PLAN-P2 "binding numbers", panel 1 colour #6): frame stats on a seoulsnap shot set.

  python3 /home/claude/scripts/seoulsnap.py --dir . --shots walk0,club90,club270,station --size 960x540 --out /tmp/snap | tee /tmp/snap.log
  python3 tools/camgate.py --stills /tmp/snap --log /tmp/snap.log [--hero walk0,club90,club270,station] [--json out.json]
  [P3 H, colour #6] CI: python3 tools/camgate.py --stills browser-out-seoul-hongdae/camgate --evs browser-out-seoul-hongdae/stills.json
  (tests/browser.mjs writes lossless <shot>.png at the shipped grade and <shot>.r0.png at retro 0, and the AE EV per shot)

Gate (hero streets; exit 1 if any fails):
  clip        share of pixels with any channel >= 250            <= 3 %
  blob        largest 8-connected clipped blob                    <= 5 %
  ev          converged AE EV (from the seoulsnap log)            -4 .. +1.5  [P5-A: was -1, which assumed phase 3's scene
              radiance; since C's albedo x3 and D's floor the hero streets meter -2.5 .. -3.8 at the refs' p50, so the
              frame p50 row (35-50) now carries 'exposed right' and this row only catches a runaway meter; evMin is -4.5]
  ground      median luma of the shot's ground box (GROUND below) >= 40
  sky         median luma of the darkest half of the top quarter  <= 30 (near black; colour #4 wants 12-25)
  p50         [P5-A, panel-4 colour bug] frame median luma            35 .. 50 (refs' median 44; A, C and D each lifted the
              image in phase 4 and nobody re-fit: walk0 68, club90 57). A hard [exposure] row on the canyon shots
              (P50_SHOTS); station / station2 / high are open-sky frames whose p50 tracks the sky radiance (D's NIGHT_SKY,
              p5/A-to-D-sky.md): reported, not gated, until the sky lands.
              [P6-A, colour #2] the open shots (OPEN_SHOTS: station, station2, high) are gated too, on their own band 28 .. 45.
  [P6-A, PLAN-P6 "#1 for everyone": the frame went dark and hid the new detail; panel 5 colour/fpv/lighting/graphics bugs]
  gw          ground-to-wall: ground p50 over the median luma of the shot's lit wall box (WALL)    >= 0.45 (P5 walk0 0.25)
  lt16        share of the frame below code 16                                                       <= 18 % (refs' median 12 %)
  spawn       frame p50 of the 'spawn' shot (the take's first frame, F's pose)                       >= 40
Colour rows [P3 H, panel-2 colour #6], gated on hero shots; every FAIL line is tagged [exposure] or [colour] (CI's
ci/known-failures.json tolerates the [colour] rows until stream A lands the neutral base):
  neutral     mean R-G and B-G (8-bit codes) of the fill: luma 12..140, bright saturated sources excluded
              retro 0 (<shot>.r0): R-G <= +10, |B-G| <= 8 (colour #1); the shipped grade is reported
  roomsat     median saturation of lit warm surfaces (hue 15-60 deg, max > 120; >= 0.2 % of the frame)  <= 0.55 (target 0.4-0.5, colour #2)
  warm        warm share of the bright saturated pixels                                                45 .. 65 % (colour #2)
  white       share with a clipped channel or near-white (max > 200, sat < 0.15), sign frames only    2 .. 5 % (colour #3)
Reported (informational): bright-saturated area (>= 5 %), bright near-white
area (<= 4 %), magenta+cyan+violet share (30-45 %), dark-flat luma noise (3-6 DN).
Needs numpy, Pillow, scipy. Stills are 8-bit sRGB (seoulsnap JPEGs).
"""
import argparse, glob, json, os, re, sys
import numpy as np
from PIL import Image
from scipy import ndimage

# ground boxes [x0, x1, y0, y1] as fractions of the frame (top-down), per seoulsnap shot name
GROUND = {'walk0': [0.40, 0.70, 0.88, 1.0], 'walk180': [0.35, 0.65, 0.88, 1.0], 'club90': [0.02, 0.30, 0.86, 1.0], 'club270': [0.10, 0.60, 0.84, 1.0],
          'station': [0.00, 0.45, 0.86, 1.0], 'station2': [0.30, 0.70, 0.88, 1.0], 'w21': [0.35, 0.65, 0.86, 1.0]}
# [P6-A] lit-wall boxes [x0, x1, y0, y1] for the ground-to-wall row: walk0 the 2F plaster above the yellow letters, walk180 the 2F
# wall top left, club90 the fascia wall between MONO BAR and the board-game sign, club270 the near right wall, w21 the brick base
WALL = {'walk0': [0.30, 0.52, 0.04, 0.27], 'walk180': [0.02, 0.20, 0.0, 0.10], 'club90': [0.12, 0.34, 0.20, 0.36], 'club270': [0.70, 0.92, 0.15, 0.80],
        'w21': [0.0, 0.14, 0.78, 0.98]}
GATE = dict(clip=3.0, blob=5.0, ev=(-4.0, 1.5), ground=40.0, sky=30.0, p50=(35.0, 50.0), p50open=(28.0, 45.0), gw=0.45, lt16=18.0, spawn=40.0)
COLOUR = dict(rg=10.0, bg=8.0, roomsat=0.55, warm=(45.0, 65.0), white=(2.0, 5.0))
P50_SHOTS = {'walk0', 'walk180', 'club90', 'club270', 'w21'}   # [P5-A] canyon frames: the p50 band is binding here
OPEN_SHOTS = {'station', 'station2', 'high'}                     # [P6-A] open-sky frames: their own p50 band (colour #2)
SIGN_FRAMES = {'walk0', 'walk180', 'club90', 'club270', 'w21'}   # frames where signs dominate (colour #3's white-core target)
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
    # [P3 H] colour rows
    fill = (Y >= 12) & (Y <= 140) & ~bs
    if fill.sum() > 200:
        o['rg'] = float((im[..., 0][fill] - im[..., 1][fill]).mean()); o['bg'] = float((im[..., 2][fill] - im[..., 1][fill]).mean())
    r_, g_, b_ = (im[..., i] / 255 for i in range(3)); Mx = mx / 255; d_ = (mx - mn) / 255 + 1e-6
    hue = np.where(Mx == r_, ((g_ - b_) / d_) % 6, np.where(Mx == g_, (b_ - r_) / d_ + 2, (r_ - g_) / d_ + 4)) * 60
    room = (hue >= 15) & (hue < 60) & (mx > 120) & (mx - mn > 8)
    if room.mean() >= 0.002: o['roomsat'] = float(np.median(sat[room])); o['room'] = float(room.mean() * 100)
    o['white'] = float(((mx >= 250) | ((mx > 200) & (sat < 0.15))).mean() * 100)
    gb = GROUND.get(name)
    if gb:
        x0, x1, y0, y1 = gb
        o['ground'] = float(np.median(Y[int(H * y0):int(H * y1), int(W * x0):int(W * x1)]))
    wb = WALL.get(name)
    if wb and gb:
        x0, x1, y0, y1 = wb
        o['wall'] = float(np.median(Y[int(H * y0):int(H * y1), int(W * x0):int(W * x1)]))
        o['gw'] = o['ground'] / max(o['wall'], 1.0)
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
    ap.add_argument('--evs', default=None, help='tests/browser.mjs stills.json: AE EV per shot (ev, and ev0 at retro 0)')
    a = ap.parse_args()
    evs = {}
    if a.log and os.path.exists(a.log):
        for m in re.finditer(r'shot (\w+) -> \S+\s+EV (-?[\d.]+)', open(a.log).read()): evs[m.group(1)] = float(m.group(2))
    if a.evs and os.path.exists(a.evs):
        for k, v in json.load(open(a.evs)).get('shots', {}).items():
            if v.get('ev') is not None: evs[k] = float(v['ev'])
            if v.get('ev0') is not None: evs[k + '.r0'] = float(v['ev0'])
    hero = set(a.hero.split(','))
    rows, fails = {}, []
    for f in sorted(glob.glob(os.path.join(a.stills, '*.jpg')) + glob.glob(os.path.join(a.stills, '*.png'))):
        name = os.path.splitext(os.path.basename(f))[0]
        base, r0 = (name[:-3], True) if name.endswith('.r0') else (name, False)   # <shot>.r0 = the same shot at retro 0
        o = stats(f, base); o['ev'] = evs.get(name); rows[name] = o
        if base not in hero: continue
        X = lambda msg: fails.append('[exposure] ' + msg)
        C = lambda msg: fails.append('[colour] ' + msg)
        if not r0:   # exposure rows: the shipped grade (retro only grades; the r0 frame repeats them)
            if o['clip'] > GATE['clip']: X(f'{name}: clip {o["clip"]:.2f} % > {GATE["clip"]}')
            if o['blob'] > GATE['blob']: X(f'{name}: blob {o["blob"]:.2f} % > {GATE["blob"]}')
            if o['ev'] is not None and not (GATE['ev'][0] <= o['ev'] <= GATE['ev'][1]): X(f'{name}: EV {o["ev"]:+.2f} outside {GATE["ev"]}')
            if o.get('ground') is not None and o['ground'] < GATE['ground']: X(f'{name}: ground p50 {o["ground"]:.0f} < {GATE["ground"]:.0f}')
            if o['sky'] > GATE['sky']: X(f'{name}: sky {o["sky"]:.0f} > {GATE["sky"]:.0f}')
            if base in P50_SHOTS and not (GATE['p50'][0] <= o['p50'] <= GATE['p50'][1]): X(f'{name}: frame p50 {o["p50"]:.0f} outside {GATE["p50"][0]:.0f}-{GATE["p50"][1]:.0f}')
            if base in OPEN_SHOTS and not (GATE['p50open'][0] <= o['p50'] <= GATE['p50open'][1]): X(f'{name}: open p50 {o["p50"]:.0f} outside {GATE["p50open"][0]:.0f}-{GATE["p50open"][1]:.0f}')
            if base == 'spawn' and o['p50'] < GATE['spawn']: X(f'{name}: spawn p50 {o["p50"]:.0f} < {GATE["spawn"]:.0f}')
            if o.get('gw') is not None and o['gw'] < GATE['gw']: X(f'{name}: ground/wall {o["gw"]:.2f} < {GATE["gw"]}')
            if o['lt16'] > GATE['lt16']: X(f'{name}: below 16 {o["lt16"]:.1f} % > {GATE["lt16"]:.0f}')
            if o.get('roomsat') is not None and o['roomsat'] > COLOUR['roomsat']: C(f'{name}: room saturation {o["roomsat"]:.2f} > {COLOUR["roomsat"]}')
            if o.get('warm') is not None and not (COLOUR['warm'][0] <= o['warm'] <= COLOUR['warm'][1]): C(f'{name}: warm share {o["warm"]:.0f} % outside {COLOUR["warm"]}')
            if base in SIGN_FRAMES and not (COLOUR['white'][0] <= o['white'] <= COLOUR['white'][1]): C(f'{name}: white area {o["white"]:.1f} % outside {COLOUR["white"]}')
        else:        # neutral base at retro 0 (colour #1)
            if o.get('rg') is not None and o['rg'] > COLOUR['rg']: C(f'{name}: neutral R-G {o["rg"]:+.1f} > +{COLOUR["rg"]:.0f}')
            if o.get('bg') is not None and abs(o['bg']) > COLOUR['bg']: C(f'{name}: neutral B-G {o["bg"]:+.1f}, |B-G| > {COLOUR["bg"]:.0f}')
    fmt = lambda v, s='{:6.1f}': (s.format(v) if v is not None else '     -')
    cols = [('EV', 'ev', '{:+6.2f}'), ('clip%', 'clip', None), ('blob%', 'blob', None), ('ground', 'ground', None), ('wall', 'wall', None), ('g/w', 'gw', '{:6.2f}'), ('sky', 'sky', None), ('p50', 'p50', None), ('<16%', 'lt16', None),
            ('bsat%', 'bsat', None), ('bwht%', 'bwhite', None), ('warm%', 'warm', None), ('mcv%', 'mcv', None), ('noise', 'noise', None), ('R-G', 'rg', '{:+6.1f}'), ('B-G', 'bg', '{:+6.1f}'), ('roomS', 'roomsat', '{:6.2f}'), ('white%', 'white', None)]
    print(f'{"shot":12s} ' + ' '.join(f'{h:>6s}' for h, _, _ in cols))
    for n, o in rows.items():
        print(f'{n:12s} ' + ' '.join(fmt(o.get(k), f or '{:6.1f}') for _, k, f in cols))
    if a.json: json.dump({'rows': rows, 'fails': fails, 'gate': GATE, 'colour': COLOUR}, open(a.json, 'w'), indent=1)
    for f_ in fails: print('FAIL ' + f_)
    print('\nGATE ' + ('PASS' if not fails else f'FAIL ({sum(f_.startswith("[exposure]") for f_ in fails)} exposure, {sum(f_.startswith("[colour]") for f_ in fails)} colour)'))
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    main()
