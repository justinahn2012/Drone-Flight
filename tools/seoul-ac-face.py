#!/usr/bin/env python3
# [P3-E graphics #2] seoul/dressing/ac_face.png: the front of a Korean split-AC outdoor unit (256 x 192, sRGB), painted
# procedurally (own work): ivory enamel, louvres on the left, the fan opening on the right with its two-ring grille,
# spokes and hub, a maker's plate, grime toward the bottom. The vertex colour tints it per unit. Run from the repo root.
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
W, H = 256, 192
im = Image.new('RGB', (W, H), (226, 224, 214)); d = ImageDraw.Draw(im)
d.rectangle([0, 0, W - 1, H - 1], outline=(150, 148, 140), width=3)
for k in range(9):   # louvres
    y = 26 + k * 16; d.rectangle([14, y, 92, y + 7], fill=(92, 90, 86)); d.line([14, y + 8, 92, y + 8], fill=(246, 244, 236), width=1)
cx, cy, r = 172, 96, 76
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(18, 18, 20))
d.ellipse([cx - r + 18, cy - r + 18, cx + r - 18, cy + r - 18], fill=(30, 30, 32))   # fan blades' blur
for rr, wdt in ((r - 3, 4), (r - 26, 3), (r - 50, 3)): d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(150, 150, 146), width=wdt)
for a in (0.3, 0.3 + np.pi / 2):
    dx, dy = np.cos(a) * r, np.sin(a) * r; d.line([cx - dx, cy - dy, cx + dx, cy + dy], fill=(150, 150, 146), width=4)
d.ellipse([cx - 11, cy - 11, cx + 11, cy + 11], fill=(120, 120, 116))
d.rectangle([22, 170, 70, 180], fill=(70, 90, 140))   # maker's plate
a = np.asarray(im.filter(ImageFilter.GaussianBlur(0.6)), dtype=np.float32)
yy = np.linspace(0, 1, H)[:, None, None]; grime = 1 - 0.28 * yy ** 2.2   # dirt toward the bottom edge
rng = np.random.default_rng(7); n = rng.normal(0, 5, (H, W, 1))
Image.fromarray(np.clip(a * grime + n, 0, 255).astype(np.uint8)).save('seoul/dressing/ac_face.png', optimize=True)
print('seoul/dressing/ac_face.png')
