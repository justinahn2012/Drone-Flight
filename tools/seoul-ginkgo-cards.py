#!/usr/bin/env python3
# [P3-E art #4] seoul/dressing/ginkgo_cards.png: the Hongdae ginkgo's leaf-card atlas, cut from bando's V1 vegetation atlas
# (veg_atlas.jpg + veg_atlas_a.png: leaf-cluster tiles baked from CC0 Poly Haven tree_small_02, its small round leaves on
# twigs are the nearest fit to a ginkgo's spur-shoot clusters). 8 tiles of 256 px -> 1024 x 512 RGBA, colour turned into
# a near-neutral luminance map (mean linear 0.5) so the per-card vertex colour sets the hue (November: gold to yellow-green).
# Run from the repo root: python3 tools/seoul-ginkgo-cards.py
import numpy as np
from PIL import Image

TILES = [(0, 1), (0, 2), (0, 7), (1, 1), (1, 2), (1, 4), (2, 5), (3, 5)]   # (row, col) of 256 px tiles: alpha cover 0.29-0.39
rgb = np.asarray(Image.open('veg_atlas.jpg').convert('RGB'), dtype=np.float32) / 255.0
alp = np.asarray(Image.open('veg_atlas_a.png').convert('L'), dtype=np.float32) / 255.0
lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
out = np.zeros((512, 1024, 4), dtype=np.float32)
for k, (r, c) in enumerate(TILES):
    L = lin[r * 256:(r + 1) * 256, c * 256:(c + 1) * 256]
    A = alp[r * 256:(r + 1) * 256, c * 256:(c + 1) * 256]
    Y = L @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    m = (Y * A).sum() / max(1e-6, A.sum())
    Yn = np.clip(Y / m * 0.5, 0.0, 1.0) ** 0.85                       # leaf-to-leaf shading kept, contrast eased a little
    tint = np.array([1.0, 0.97, 0.9], dtype=np.float32)                 # a warm white: the vertex colour does the rest
    col = Yn[..., None] * tint
    # dilate colour into the transparent texels (mip bleed would otherwise drag the black background into the edges)
    filled = col.copy(); have = A > 0.05
    for _ in range(8):
        acc = np.zeros_like(filled); n = np.zeros(have.shape, dtype=np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh = np.roll(np.roll(filled, dy, 0), dx, 1); hv = np.roll(np.roll(have, dy, 0), dx, 1)
            acc += sh * hv[..., None]; n += hv
        new = (~have) & (n > 0)
        filled[new] = acc[new] / n[new][:, None]; have = have | new
    filled[~have] = 0.5
    y0, x0 = (k // 4) * 256, (k % 4) * 256
    out[y0:y0 + 256, x0:x0 + 256, :3] = filled
    out[y0:y0 + 256, x0:x0 + 256, 3] = A
srgb = np.where(out[..., :3] <= 0.0031308, out[..., :3] * 12.92, 1.055 * np.power(np.clip(out[..., :3], 0, 1), 1 / 2.4) - 0.055)
img = np.concatenate([srgb, out[..., 3:]], axis=2)
Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA').save('seoul/dressing/ginkgo_cards.png', optimize=True)
print('seoul/dressing/ginkgo_cards.png', [float(out[..., 3].mean())])
