# seoul/tools/people-atlas.py: the crowd's texture atlases from the Rocketbox avatars' colour maps (MIT licence, (c) 2020
# Microsoft; github.com/microsoft/Microsoft-Rocketbox). Run after seoul/tools/people-bake.mjs (same avatar order).
#   python3 seoul/tools/people-atlas.py <dir with <code>_{body,head,opacity}_color.tga> <people dir (people.json, uvsamples.json)>
# atlas.jpg: avatar i in a CELL x 2 CELL cell (people.json atlas.cell; col i % 4, row i // 4): body map top, head map bottom.
# hair.png RGBA: avatar i's hair-card map (colour + alpha) in a (hairW / 4)^2 cell.
#   python3 seoul/tools/people-atlas.py <tex dir> <people dir> [previous people dir]   (P8)
# people.json gets mean: per avatar, the linear mean colour of each class (0 skin, 1 hair, 2 top, 3 bottom, 4 shoes), measured
# at the vertices' UVs: the shader re-tints a class as instance colour x (texel / class mean), keeping the folds and prints.
import json, sys, os
from PIL import Image

tex_dir, pdir = sys.argv[1], sys.argv[2]
# (P8) <tex dir>/<donor>/<code>_<kind>_color.tga per avatar donor (a made avatar takes its body map from one donor and its
# head and hair maps from another: uvsamples.json `donor` per texture); a donor with no TGA there is read back from a
# previous bake's atlas.jpg / hair.png (argv[3]: its people dir), cell by cell
old_dir = sys.argv[3] if len(sys.argv) > 3 else None
old_meta = json.load(open(os.path.join(old_dir, 'people.json'))) if old_dir else None
old_atlas = Image.open(os.path.join(old_dir, 'atlas.jpg')).convert('RGB') if old_dir else None
old_hair = Image.open(os.path.join(old_dir, 'hair.png')).convert('RGBA') if old_dir else None
meta = json.load(open(os.path.join(pdir, 'people.json')))
samples = json.load(open(os.path.join(pdir, 'uvsamples.json')))
A = meta['atlas']; CELL = A.get('cell', 512); COLS = A.get('cols', 4); HC = A['hairW'] // COLS
atlas = Image.new('RGB', (A['w'], A['h']), (40, 40, 40))
hair = Image.new('RGBA', (A['hairW'], A['hairH']), (0, 0, 0, 0))
lin = lambda c: (c / 255.0) / 12.92 if c <= 10 else ((c / 255.0 + 0.055) / 1.055) ** 2.4

def source(donor, mname, kind):
    """the donor's colour map for this material: its TGA, else its cell of the previous atlas"""
    code = mname.split('_')[0]
    for path in (os.path.join(tex_dir, donor, f'{code}_{kind}_color.tga'), os.path.join(tex_dir, f'{code}_{kind}_color.tga') if donor is None else None):
        if path and os.path.exists(path): return Image.open(path).convert('RGBA' if kind == 'opacity' else 'RGB'), path
    if old_meta:
        names = [a['name'] for a in old_meta['avatars']]
        if donor in names:
            j = names.index(donor); OA = old_meta['atlas']; oc = OA.get('cell', 512); ocols = OA.get('cols', 4); ohc = OA['hairW'] // ocols
            c, r = j % ocols, j // ocols
            if kind == 'opacity': return old_hair.crop((c * ohc, r * ohc, (c + 1) * ohc, (r + 1) * ohc)), 'old hair.png'
            y = r * 2 * oc + (oc if kind == 'head' else 0)
            return old_atlas.crop((c * oc, y, (c + 1) * oc, y + oc)), 'old atlas.jpg'
    return None, None

old_means = {a['name']: a for a in old_meta['avatars']} if old_meta else {}
for i, s in enumerate(samples):
    col, row = i % COLS, i // COLS
    imgs = {}; fromOld = True
    for mi, mname in enumerate(s['tex']):
        kind = 'opacity' if 'opacity' in mname.lower() else 'head' if 'head' in mname.lower() else 'body'
        donor = (s.get('donor') or [None] * len(s['tex']))[mi]
        im, src = source(donor, mname, kind)
        if im is None:
            print('missing', donor, mname); continue
        if src and not src.startswith('old'): fromOld = False
        imgs[mi] = im
        if kind == 'opacity':
            hair.paste(im.resize((HC, HC), Image.LANCZOS), (col * HC, row * HC))
        else:
            atlas.paste(im.resize((CELL, CELL), Image.LANCZOS), (col * CELL, row * 2 * CELL + (CELL if kind == 'head' else 0)))
    if fromOld and s['name'] in old_means and old_means[s['name']].get('mean'):
        meta['avatars'][i]['mean'] = old_means[s['name']]['mean']; print(s['name'], 'means kept'); continue
    # class means at the vertex UVs (linear rgb; alpha-weighted for the hair cards)
    acc = [[0.0, 0.0, 0.0, 0.0] for _ in range(5)]
    for m, c, u, v in s['s']:
        im = imgs.get(m)
        if im is None: continue
        W, H = im.size
        x = min(W - 1, max(0, int((u - int(u)) * W))); y = min(H - 1, max(0, int((1 - (v - int(v))) * H)))
        px = im.getpixel((x, y)); w = (px[3] / 255.0) if len(px) == 4 else 1.0
        if w < 0.3: continue
        for k in range(3): acc[c][k] += lin(px[k]) * w
        acc[c][3] += w
    mean = [[round(a[k] / a[3], 5) if a[3] > 0 else 0.1 for k in range(3)] for a in acc]
    meta['avatars'][i]['mean'] = mean
    print(s['name'], 'means', mean)
atlas.save(os.path.join(pdir, 'atlas.jpg'), quality=88, optimize=True)
hair.save(os.path.join(pdir, 'hair.png'), optimize=True)
json.dump(meta, open(os.path.join(pdir, 'people.json'), 'w'), indent=1)
os.remove(os.path.join(pdir, 'uvsamples.json'))
print('atlas.jpg', os.path.getsize(os.path.join(pdir, 'atlas.jpg')) // 1024, 'KB; hair.png', os.path.getsize(os.path.join(pdir, 'hair.png')) // 1024, 'KB')
