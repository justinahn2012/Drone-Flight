# seoul/tools/people-aux.py: the crowd avatars' head-map masks (stream G1, phase 4: life #1, graphics #3, art #3).
# Run after people-bake.mjs and people-atlas.py (it reads people.json, people.bin and atlas.jpg).
#   python3 seoul/tools/people-aux.py [people dir]
# aux.png 1024 x 512 RGB, avatar i's head map in a 256^2 cell (col i % 4, row i // 4), in the head map's own UV layout:
#   R  scalp hair: the hair painted on the head map (and brows, beards, buns). The shader re-tints it to the person's
#      hair colour like the hair cards (P3 tinted it toward the skin colour, so the near-black cards sat on brown or
#      blond painted hair: the "black patches" on ~1 head in 8, the "bars over the eyes" at 15-40 m).
#   G  face mask (KF94): bridge of the nose below the eyes, over the nose and mouth, round under the chin, out to the
#      cheeks. Placed from each head's own landmarks (P3 used neck joint + 3..12 cm and z > 4.5 cm in rest space:
#      a mouth band on the men, a dot under the nose on the women, whose faces sit 7.5 cm further back).
#   B  0
# The texels are filled by rasterising the near LOD's head-map triangles in UV space with their rest positions, so the
# mask follows the face's real surface on every avatar, and the mid LOD (same UVs) gets the same mask.
# people.json gets per avatar: face { noseY, noseZ, chinY, eyeY } (m, rest space) and meanScalp (linear rgb).
import json, os, sys
import numpy as np
from scipy import ndimage
from PIL import Image

pdir = sys.argv[1] if len(sys.argv) > 1 else 'seoul/people'
meta = json.load(open(os.path.join(pdir, 'people.json')))
binb = open(os.path.join(pdir, 'people.bin'), 'rb').read()
atlas = np.asarray(Image.open(os.path.join(pdir, 'atlas.jpg')).convert('RGB'), dtype=np.float32) / 255
A = meta['atlas']; CELL = 256
aux = np.zeros((2 * CELL, 4 * CELL, 3), np.float32)
lin = lambda c: np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
ss = lambda e0, e1, x: (lambda t: t * t * (3 - 2 * t))(np.clip((x - e0) / (e1 - e0), 0, 1))

def raster(uvpx, P, tris, W, H):
    """rest position map (H, W, 3) + coverage, by barycentric rasterisation in UV pixel space"""
    pos = np.zeros((H, W, 3), np.float32); cov = np.zeros((H, W), bool)
    for t in tris:
        (x0, y0), (x1, y1), (x2, y2) = uvpx[t]
        area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if abs(area) < 1e-9: continue
        xa, xb = max(0, int(np.floor(min(x0, x1, x2))) - 1), min(W - 1, int(np.ceil(max(x0, x1, x2))) + 1)
        ya, yb = max(0, int(np.floor(min(y0, y1, y2))) - 1), min(H - 1, int(np.ceil(max(y0, y1, y2))) + 1)
        if xa > xb or ya > yb: continue
        gx, gy = np.meshgrid(np.arange(xa, xb + 1) + 0.5, np.arange(ya, yb + 1) + 0.5)
        w0 = ((x1 - gx) * (y2 - gy) - (x2 - gx) * (y1 - gy)) / area
        w1 = ((x2 - gx) * (y0 - gy) - (x0 - gx) * (y2 - gy)) / area
        w2 = 1 - w0 - w1; e = -0.02
        m = (w0 >= e) & (w1 >= e) & (w2 >= e)
        if not m.any(): continue
        q = w0[..., None] * P[t[0]] + w1[..., None] * P[t[1]] + w2[..., None] * P[t[2]]
        sub = pos[ya:yb + 1, xa:xb + 1]; sub[m] = q[m]; cov[ya:yb + 1, xa:xb + 1] |= m
    return pos, cov

def dilate(a, cov, n):
    """grow covered values into the uncovered border (bilinear taps at island edges)"""
    a = a.copy(); cov = cov.copy()
    for _ in range(n):
        acc = np.zeros_like(a); cnt = np.zeros(cov.shape, np.float32)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            s = np.roll(np.roll(cov, dy, 0), dx, 1); v = np.roll(np.roll(a, dy, 0), dx, 1)
            acc += np.where(s[..., None], v, 0) if a.ndim == 3 else np.where(s, v, 0); cnt += s
        new = (~cov) & (cnt > 0)
        a[new] = (acc[new] / cnt[new][..., None]) if a.ndim == 3 else acc[new] / cnt[new]
        cov |= new
    return a

def blur(a, n=1):
    for _ in range(n):
        a = (a + np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1)) / 5
    return a

for ai, av in enumerate(meta['avatars']):
    L = av['lods'][0]; nv = L['verts']; col, row = ai % 4, ai // 4
    P = np.frombuffer(binb, np.float32, nv * 3, L['pos']).reshape(-1, 3)
    UV = np.frombuffer(binb, np.float32, nv * 2, L['uv']).reshape(-1, 2)
    B = np.frombuffer(binb, np.uint8, nv * 4, L['bone']).reshape(-1, 4)
    I = np.frombuffer(binb, np.uint16, L['tris'] * 3, L['index']).reshape(-1, 3)
    # ---- landmarks (rest space): nose tip, chin, eye line, from the head's skin vertices
    head = (B[:, 0] == 1) & (B[:, 3] == 0)
    hv = P[head]
    mid = hv[np.abs(hv[:, 0]) < 0.012]
    nose = mid[np.argmax(mid[:, 2])]
    front = hv[(np.abs(hv[:, 0]) < 0.02) & (hv[:, 2] > nose[2] - 0.05) & (hv[:, 1] < nose[1])]
    chinY = float(front[:, 1].min())
    # head-map texel space for this avatar: atlas uv -> (u, v from the top of the head map) in [0, 1]
    vt = 1 - UV[:, 1]
    hu = UV[:, 0] * 4 - col; hvv = (vt - row * 0.5 - 0.25) * 4
    inmap = (hvv >= -1e-4) & (hvv <= 1 + 1e-4) & (hu >= -1e-4) & (hu <= 1 + 1e-4)
    tris = [t for t in I if inmap[t].all() and (B[t, 3] == 0).all()]
    uvpx = np.stack([hu * CELL, hvv * CELL], 1)
    pos, cov = raster(uvpx, P, tris, CELL, CELL)
    # eye line: the darkest texels of the face's upper half (pupils, lashes) on |x| 0.02-0.045, above the nose tip
    tex = atlas[row * 1024 + 512: row * 1024 + 1024, col * 512: col * 512 + 512]
    texc = np.asarray(Image.fromarray((tex * 255).astype(np.uint8)).resize((CELL, CELL), Image.BILINEAR), np.float32) / 255
    lum = texc @ np.array([0.3, 0.59, 0.11], np.float32)
    eyeZone = cov & (np.abs(np.abs(pos[..., 0]) - 0.032) < 0.014) & (pos[..., 1] > nose[1] + 0.015) & (pos[..., 1] < nose[1] + 0.065) & (pos[..., 2] > nose[2] - 0.06)
    ez = np.where(eyeZone)
    if len(ez[0]) > 8:
        k = np.argsort(lum[ez])[: max(4, len(ez[0]) // 12)]
        eyeY = float(np.median(pos[ez][k][:, 1]))
    else:
        eyeY = float(nose[1] + 0.038)
    eyeY = float(np.clip(eyeY, nose[1] + 0.028, nose[1] + 0.05))
    # ---- KF94 mask: top edge on the bridge 2 cm under the eye line, sweeping down over the cheeks; bottom edge round
    # under the chin; sides 6.8 cm out, in front of the ears
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]; ax = np.abs(x)
    top = eyeY - 0.021 - 0.012 * ss(0.01, 0.05, ax) - 0.01 * ss(0.045, 0.07, ax)       # 2.1 cm under the eyes at the bridge
    bot = chinY - 0.012                                                             # just under the chin
    mk = ss(-0.004, 0.004, top - y) * ss(-0.004, 0.004, y - bot) * (1 - ss(0.064, 0.072, ax)) * ss(nose[2] - 0.095, nose[2] - 0.082, z)
    mk = np.where(cov, mk, 0)
    # ---- scalp hair: colour against the skin and the crown, above the nose / on the buns
    skinZone = cov & (ax > 0.025) & (ax < 0.05) & (np.abs(y - (nose[1] - 0.005)) < 0.012) & (z > nose[2] - 0.05)
    crownZone = cov & (y > np.max(np.where(cov, y, -9)) - 0.035)
    lc = lin(texc)
    sk = lc[skinZone].mean(0) if skinZone.sum() > 5 else lc[cov].mean(0)
    hr = lc[crownZone].mean(0) if crownZone.sum() > 5 else sk * 0.3
    # chromaticity + log-luminance distance to each reference
    def feat(c):
        s = c.sum(-1, keepdims=True) + 1e-4
        return np.concatenate([c / s * 3, np.log(s + 0.01) * 0.5], -1)
    fs, fh, fc = feat(sk[None, None, :])[0, 0], feat(hr[None, None, :])[0, 0], feat(lc)
    ds = np.linalg.norm(fc - fs, axis=-1); dh = np.linalg.norm(fc - fh, axis=-1)
    hair = ss(-0.04, 0.04, ds - dh)
    # the face proper (forehead under the hairline, cheeks, nose, lips) is skin; brows and beards keep their colour vote
    faceCore = cov & (ax < 0.055) & (y < eyeY + 0.03) & (y > chinY + 0.005) & (z > nose[2] - 0.06)
    brows = cov & (ax > 0.012) & (ax < 0.055) & (y > eyeY + 0.006) & (y < eyeY + 0.03) & (z > nose[2] - 0.06)
    hair = np.where(faceCore & ~brows, hair * 0.35, hair)
    # where painted hair can be: above the cheekbones, or behind the ears down to the nape (not the throat or the jaw)
    allowed = ss(nose[1] - 0.03, nose[1] - 0.01, y) + ss(nose[2] - 0.115, nose[2] - 0.135, z) * ss(chinY - 0.06, chinY - 0.03, y)
    hair = hair * np.clip(allowed, 0, 1)
    sep = float(np.linalg.norm(fh - fs))
    if sep < 0.6:
        # grey or blond hair against light skin: the colours don't separate texel by texel, so the haircut is drawn in 3D:
        # a forehead hairline 5.5 cm over the eye line (lower at the temples), down in front of the ears to the cheekbone,
        # and round the back of the head to a nape line 3 cm under the nose tip
        band = (np.abs(hv[:, 1] - (eyeY + 0.02)) < 0.03)
        zc = 0.5 * (hv[band, 2].max() + hv[band, 2].min())
        fr = ss(zc - 0.01, zc + 0.02, z)                                            # 0 behind the ears .. 1 the face side
        lineF = eyeY + 0.055 - 0.03 * ss(0.035, 0.07, ax)                           # forehead / temples
        lineB = nose[1] - 0.03                                                      # nape
        geo = ss(-0.004, 0.004, y - (lineF * fr + lineB * (1 - fr)))
        hair = np.maximum(hair * 0.5, geo) * np.clip(allowed + (1 - fr), 0, 1)
    # a shaved or bald head (crown about the skin's colour) has no painted hair to re-tint
    if sep < 0.12: hair = hair * 0
    hair = np.where(cov, hair, 0)
    # close the speckles (blond or grey hair against light skin votes texel by texel) and soften the hairline
    hair = ss(0.3, 0.7, blur(hair, 4)); hair = np.where(cov, hair, 0)
    # fill the holes: a patch of skin-coloured texels ringed by hair (a parting, a grey or blond streak) is hair; the face,
    # the ears and the neck border uncovered texels or seams and stay skin
    lab, n = ndimage.label(cov & (hair < 0.5))
    for k in range(1, n + 1):
        comp = lab == k; ring = ndimage.binary_dilation(comp, iterations=2) & ~comp
        if ring.sum() and (hair[ring] > 0.5).mean() > 0.85 and not (comp & faceCore).any(): hair[comp] = 1.0
    hair = blur(hair, 1); mk = blur(mk, 2)
    hair = dilate(hair, cov, 3); mk = dilate(mk, cov, 3)
    meanScalp = (lc[cov & (hair > 0.6)].mean(0) if (cov & (hair > 0.6)).sum() > 10 else hr).tolist()
    aux[row * CELL:(row + 1) * CELL, col * CELL:(col + 1) * CELL, 0] = hair
    aux[row * CELL:(row + 1) * CELL, col * CELL:(col + 1) * CELL, 1] = mk
    av['face'] = { 'noseY': round(float(nose[1]), 4), 'noseZ': round(float(nose[2]), 4), 'chinY': round(chinY, 4), 'eyeY': round(eyeY, 4) }
    av['meanScalp'] = [round(float(v), 5) for v in meanScalp]
    print(f"{av['name']}: nose {nose[1]:.3f}/{nose[2]:.3f} chin {chinY:.3f} eyes {eyeY:.3f}; mask texels {(mk > 0.5).sum()}, hair {(hair > 0.5).sum()} of {cov.sum()}; scalp {np.round(meanScalp, 3)}")
meta['aux'] = { 'w': 4 * CELL, 'h': 2 * CELL, 'cell': CELL, 'channels': 'r scalp hair, g face mask' }
Image.fromarray((np.clip(aux, 0, 1) * 255 + 0.5).astype(np.uint8)).save(os.path.join(pdir, 'aux.png'), optimize=True)
json.dump(meta, open(os.path.join(pdir, 'people.json'), 'w'), indent=1)
print('aux.png', os.path.getsize(os.path.join(pdir, 'aux.png')) // 1024, 'KB')
