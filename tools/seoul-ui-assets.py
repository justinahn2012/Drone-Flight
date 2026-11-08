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
Re-run after adding hangul to levels.json or new street names to the layout."""
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
