# seoul/tools/people-atlas.py: the crowd's texture atlases from the Rocketbox avatars' colour maps (MIT licence, (c) 2020
# Microsoft; github.com/microsoft/Microsoft-Rocketbox). Run after seoul/tools/people-bake.mjs (same avatar order).
#   python3 seoul/tools/people-atlas.py <dir with <code>_{body,head,opacity}_color.tga> <people dir (people.json, uvsamples.json)>
# atlas.jpg 2048^2: avatar i in a 512 x 1024 cell (col i % 4, row i // 4): body map top, head map bottom, each 512^2.
# hair.png 1024 x 512 RGBA: avatar i's hair-card map (colour + alpha) in a 256^2 cell.
# people.json gets mean: per avatar, the linear mean colour of each class (0 skin, 1 hair, 2 top, 3 bottom, 4 shoes), measured
# at the vertices' UVs: the shader re-tints a class as instance colour x (texel / class mean), keeping the folds and prints.
import json, sys, os
from PIL import Image

tex_dir, pdir = sys.argv[1], sys.argv[2]
meta = json.load(open(os.path.join(pdir, 'people.json')))
samples = json.load(open(os.path.join(pdir, 'uvsamples.json')))
A = meta['atlas']
atlas = Image.new('RGB', (A['w'], A['h']), (40, 40, 40))
hair = Image.new('RGBA', (A['hairW'], A['hairH']), (0, 0, 0, 0))
lin = lambda c: (c / 255.0) / 12.92 if c <= 10 else ((c / 255.0 + 0.055) / 1.055) ** 2.4
for i, s in enumerate(samples):
    col, row = i % 4, i // 4
    imgs = {}
    for mi, mname in enumerate(s['tex']):
        kind = 'opacity' if 'opacity' in mname.lower() else 'head' if 'head' in mname.lower() else 'body'
        code = mname.split('_')[0]
        path = os.path.join(tex_dir, f'{code}_{kind}_color.tga')
        if not os.path.exists(path):
            print('missing', path); continue
        im = Image.open(path)
        imgs[mi] = im.convert('RGBA' if kind == 'opacity' else 'RGB')
        if kind == 'opacity':
            hair.paste(imgs[mi].resize((256, 256), Image.LANCZOS), (col * 256, row * 256))
        else:
            atlas.paste(imgs[mi].resize((512, 512), Image.LANCZOS), (col * 512, row * 1024 + (512 if kind == 'head' else 0)))
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
