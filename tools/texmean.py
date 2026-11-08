#!/usr/bin/env python3
"""tools/texmean.py: the mean linear colour of each Poly Haven diffuse map, for TEX_MEAN in world-bando.js (native #5).

  python3 tools/texmean.py DIR [id ...]     DIR = a folder of <id>_diff_1k.jpg files (Poly Haven 1k JPGs)

Same measurement the game used to make at load with a canvas (texMean): the image box-filtered to 32 x 32 in sRGB,
each texel converted to linear, then averaged. Prints one `'id': [r, g, b],` line per map, ready to paste into
TEX_MEAN. tools/export-world.mjs warns (and tools/test-export.mjs fails) when a MATS diffuse map has no entry.
"""
import os, sys
from PIL import Image

def lin(v):
    v /= 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4

def mean(path):
    im = Image.open(path).convert('RGB').resize((32, 32), Image.BOX)
    b = im.tobytes(); m = [0.0, 0.0, 0.0]
    for i in range(0, len(b), 3):
        for k in range(3): m[k] += lin(b[i + k])
    return [round(v / (len(b) // 3), 4) for v in m]

if __name__ == '__main__':
    if len(sys.argv) < 2: print(__doc__); sys.exit(1)
    d = sys.argv[1]
    ids = sys.argv[2:] or sorted(f[:-len('_diff_1k.jpg')] for f in os.listdir(d) if f.endswith('_diff_1k.jpg'))
    for i in ids:
        f = os.path.join(d, i + '_diff_1k.jpg')
        if os.path.exists(f): print(f"  '{i}': {mean(f)},")
        else: print(f'  // {i}: {f} not found', file=sys.stderr)
