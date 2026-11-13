#!/usr/bin/env python3
"""F2 (UI): the Seoul level-select / loading / caption assets -> seoul/ui/.

  python3 tools/seoul-ui-assets.py --font NotoSansKR.ttf [--backdrop STILL.jpg] [--thumb STILL.jpg]

- OT-KR800.woff2: Noto Sans KR (SIL OFL 1.1, variable) instanced at wght 800 and subset to the hangul in levels.json and
  seoul/layout.json (street / landmark `ko` names, the captions' place line) plus digits, space, '·' and '-'. Same face as
  B's S2-NotoSansKR800, subset on its own so the sign atlas can change without breaking the UI. Renamed "OT KR": a subset
  is a Modified Version, and Noto Sans KR carries the Reserved Font Name 'Source'.
- backdrop.jpg (1600x900, <= 180 KB): the menu still under the gradient. thumb.jpg (480x270): the level card.
  Both are graded the same way: a soft highlight shoulder (the SDR still's clipped plates roll off instead of reading as
  white cards behind the type), a slight lift of the blacks' blue and a vignette. Re-run with a fresh still from the build
  (seoulsnap) once the other streams land.
- glyphs.txt: the code points in the font (tests/seoul-ui.mjs checks every hangul string the UI can show against it).
- stills.json ([P4] ui #1 / #2): per still its sha256, source and pose, and the share of saturated-bright pixels (HSV
  s >= 0.5 and v >= 0.6: lit neon, not white boxes). tests/seoul-ui.mjs checks the hashes and the thumb's share (>= 3 %).
Re-run after adding hangul to levels.json or new street names to the layout.

Re-shooting the stills ([P4]). The P4 stills are crops of phase-3 seoulsnap stills (stills.json says which): the backdrop
is w21 above the crowd (no face, so no mask-band dots or hair hoods), the thumb walk0's sign column (3.6 % saturated-
bright; the Yanghwa-ro crossing had 0.4 %). Re-shoot once G1's mask fix lands (tests/seoul-ui.mjs fails until the stills
are newer than seoul-life.js): from a seoulsnap run of the build, 1280x720 or more, HUD off, quality auto, acro, held still.
Proposed poses, not yet shot (both P4 world runs were OOM-killed in the shared cgroup):
  thumb     o.tp(224.9, 3.2, -334.2, 107, 4 - camTilt): the walking street at the spawn, signs on both sides
  backdrop  o.tp(224.9, 7.5, -334.2, 107, -10 - camTilt): the same street from 7.5 m, so no face is over ~30 px at 1600 wide
            (or keep a crop above the crowd, as now)
  python3 tools/seoul-ui-assets.py --backdrop BD.jpg [--backdrop-crop ..] --backdrop-pose "..." --thumb TH.jpg --thumb-pose "..." --commit SHA
The thumb must keep >= 3 % saturated-bright pixels (crop to the signs if a pose falls short)."""
import argparse, json, os, re, sys
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'seoul', 'ui')
ap = argparse.ArgumentParser()
ap.add_argument('--font'); ap.add_argument('--backdrop'); ap.add_argument('--thumb')
ap.add_argument('--backdrop-crop', default='0,0,1,1', help='x0,y0,x1,y1 (fractions) of the source still')
ap.add_argument('--thumb-crop', default='0,0,1,1')
ap.add_argument('--backdrop-pose', default=''); ap.add_argument('--thumb-pose', default='')
ap.add_argument('--commit', default='', help='the build the stills were shot from (stills.json; default: git HEAD)')
ap.add_argument('--depth', default='', help='[P5-F] the stills-depth.json of the shoot (nearest hit per shot, from stillsnap)')
a = ap.parse_args()
os.makedirs(OUT, exist_ok=True)

def hangul_of(text):
    return {c for c in text if 0x1100 <= ord(c) <= 0x11FF or 0x3130 <= ord(c) <= 0x318F or 0xAC00 <= ord(c) <= 0xD7A3}

if a.font:
    chars = set()
    chars |= hangul_of(open(os.path.join(ROOT, 'levels.json'), encoding='utf8').read())
    lay = json.load(open(os.path.join(ROOT, 'seoul', 'layout.json'), encoding='utf8'))
    for s in lay.get('streets', []) + lay.get('hero', []): chars |= hangul_of(s.get('ko') or '')
    chars |= set('0123456789 ·-')
    uni = sorted(ord(c) for c in chars)
    font = TTFont(a.font)
    if 'fvar' in font: font = instancer.instantiateVariableFont(font, {'wght': 800})
    o = subset.Options(); o.flavor = 'woff2'; o.layout_features = ['*']; o.name_IDs = ['*']; o.notdef_outline = True
    s = subset.Subsetter(o); s.populate(unicodes=uni); s.subset(font)
    nt = font['name']; nt.names = [n for n in nt.names if n.nameID not in (1, 2, 3, 4, 6, 16, 17)]
    for nid, v in ((1, 'OT KR'), (2, 'Regular'), (3, 'OT-KR800;subset'), (4, 'OT KR'), (6, 'OT-KR800')): nt.setName(v, nid, 3, 1, 0x409); nt.setName(v, nid, 1, 0, 0)
    p = os.path.join(OUT, 'OT-KR800.woff2'); font.flavor = 'woff2'; font.save(p)
    have = sorted(TTFont(p).getBestCmap().keys())
    open(os.path.join(OUT, 'glyphs.txt'), 'w', encoding='utf8').write(''.join(chr(c) for c in have) + '\n')
    print(f'OT-KR800.woff2 {os.path.getsize(p) / 1024:.1f} KB, {len(have)} code points')

def sat_bright(path):
    """share of pixels with HSV s >= 0.5 and v >= 0.6 (lit, saturated: neon) in an image"""
    from PIL import Image
    import numpy as np
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float32) / 255.0
    mx, mn = a.max(axis=2), a.min(axis=2)
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    return float(((s >= 0.5) & (mx >= 0.6)).mean())

def thirds(path):
    """[P5-F ui #2] mean luma of the lower third over the top third (>= 2: some street in frame, not a sign on a wall)"""
    from PIL import Image
    import numpy as np
    a = np.asarray(Image.open(path).convert('L')).astype(np.float32); h = a.shape[0]
    return float(a[2 * h // 3:].mean() / max(1e-3, a[:h // 3].mean()))

def edge_energy(path):
    """[P9-F ui #1] mean |Laplacian| of the luma (8-bit codes), as tools/seoul-hudsnap.py: the blades' glyph strokes are the
    thumb's high frequencies (P8's 480 x 270 thumb: 17.0)"""
    from PIL import Image
    import numpy as np
    a = np.asarray(Image.open(path).convert('L')).astype(np.float32)
    return round(float(np.abs(4 * a[1:-1, 1:-1] - a[:-2, 1:-1] - a[2:, 1:-1] - a[1:-1, :-2] - a[1:-1, 2:]).mean()), 2)

def git(*args, raw=False):
    import subprocess
    try:
        if raw: r = subprocess.run(['git', *args], cwd=ROOT, capture_output=True); return r.stdout if r.returncode == 0 else None
        return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    except Exception: return None if raw else ''
import hashlib

def grade(src, size, crop, out, kb):
    from PIL import Image, ImageFilter
    import numpy as np
    im = Image.open(src).convert('RGB'); W, H = im.size
    x0, y0, x1, y1 = (float(v) for v in crop.split(','))
    im = im.crop((round(x0 * W), round(y0 * H), round(x1 * W), round(y1 * H))).resize(size, Image.LANCZOS)
    f = np.asarray(im).astype(np.float32) / 255.0
    lin = np.where(f <= 0.04045, f / 12.92, ((f + 0.055) / 1.055) ** 2.4)
    # soft shoulder: linear to 0.35, then x / (1 + x) style roll-off to ~0.82 at the old clip (keeps the neon's hue)
    k = 0.35; over = np.maximum(lin - k, 0); lin = np.minimum(lin, k) + over / (1 + over / (0.82 - k))
    lin[..., 2] += 0.0025 * (1 - lin[..., 2])                       # night blacks a hair blue, not neutral grey
    h, w = lin.shape[:2]; yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot((xx - w / 2) / (w / 2), (yy - h / 2) / (h / 2)); lin *= (1 - 0.35 * np.clip(r - 0.45, 0, 1) ** 1.5)[..., None]
    f = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(np.maximum(lin, 0), 1 / 2.4) - 0.055)
    im = Image.fromarray((np.clip(f, 0, 1) * 255 + 0.5).astype(np.uint8))
    if size[0] <= 640: im = im.filter(ImageFilter.UnsharpMask(radius=1.0, percent=40, threshold=2))
    for q in range(86, 50, -3):
        im.save(out, 'JPEG', quality=q, optimize=True, progressive=True)
        if os.path.getsize(out) <= kb * 1024: break
    print(f'{os.path.basename(out)} {size[0]}x{size[1]} q{q} {os.path.getsize(out) / 1024:.0f} KB')

if a.backdrop: grade(a.backdrop, (1600, 900), a.backdrop_crop, os.path.join(OUT, 'backdrop.jpg'), 172)
if a.thumb: grade(a.thumb, (480, 270), a.thumb_crop, os.path.join(OUT, 'thumb.jpg'), 40)

# stills.json: refreshed for every still on disk (a still not re-shot keeps its pose / source / commit)
sp = os.path.join(OUT, 'stills.json')
rec = json.load(open(sp, encoding='utf8')) if os.path.exists(sp) else {}
# [P5-F ui #1] the build: HEAD (or --commit) and the commit of seoul-life.js / world-seoul.js it carried, so tests/seoul-ui.mjs
# checks the stills against the crowd's file, not only the look's date (phase 4: pose and commit were empty)
commit = a.commit or git('rev-parse', '--short', 'HEAD')
life = git('log', '-1', '--format=%h', commit or 'HEAD', '--', 'seoul-life.js')
depth = json.load(open(a.depth)) if a.depth else {}
for k, src, crop, pose in (('backdrop', a.backdrop, a.backdrop_crop, a.backdrop_pose), ('thumb', a.thumb, a.thumb_crop, a.thumb_pose)):
    f = os.path.join(OUT, k + '.jpg')
    if not os.path.exists(f): continue
    r = rec.get(k, {})
    if src:
        r.update({'source': os.path.basename(src), 'crop': crop, 'pose': pose, 'commit': commit, 'lifeCommit': life})
        # [P7-F ui #4] the content hash of the seoul-life.js the stills were shot with (a git rev of it read wrong in a depth-1
        # clone: H's P6 note), from the shot's commit, else the working tree
        lh = git('show', f'{commit or "HEAD"}:seoul-life.js', raw=True)
        if lh is None and os.path.exists(os.path.join(ROOT, 'seoul-life.js')): lh = open(os.path.join(ROOT, 'seoul-life.js'), 'rb').read()
        if lh is not None: r['lifeHash'] = hashlib.sha256(lh).hexdigest()[:16]
        dp = depth.get(os.path.splitext(os.path.basename(src))[0])
        if dp:
            r['nearest'] = dp.get('near')                       # m: the nearest scene hit in frame (>= 3: no blurred pole)
            # [P7-F ui #4] the whole depth check, not only `nearest` (phase 6 dropped these): rays within 8 m, near-black share
            for kk in ('wall8', 'dark', 'pass'):
                if kk in dp: r[kk] = dp[kk]
        else:
            for kk in ('nearest', 'wall8', 'dark', 'pass'): r.pop(kk, None)   # a re-shoot without --depth: no stale depth
    r['sha256'] = hashlib.sha256(open(f, 'rb').read()).hexdigest()
    r['satBright'] = round(sat_bright(f), 4)
    r['lowerTop'] = round(thirds(f), 2)
    r['edge'] = edge_energy(f)
    rec[k] = r
    print(f'{k}.jpg saturated-bright {100 * r["satBright"]:.1f} %')
if rec: open(sp, 'w', encoding='utf8').write(json.dumps(rec, indent=1, ensure_ascii=False) + '\n')
