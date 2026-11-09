#!/usr/bin/env python3
"""E: subset Noto Sans KR (OFL) to the glyphs seoul-dressing.js draws -> seoul/dressing/E-Sans.woff2.

  python3 tools/seoul-dressing-font.py NotoSansKR[wght].ttf   (github.com/google/fonts/tree/main/ofl/notosanskr)

Glyphs: every non-ASCII character in seoul-dressing.js, every street name (ko) in seoul/layout.json, printable ASCII.
Re-run after the layout's street names change. A subset is a Modified Version under the OFL: renamed "E Sans"."""
import json, os, sys
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
text = open(os.path.join(ROOT, 'seoul-dressing.js'), encoding='utf8').read()
lay = json.load(open(os.path.join(ROOT, 'seoul', 'layout.json'), encoding='utf8'))
chars = set(c for c in text if ord(c) >= 0x80) | set(chr(c) for c in range(0x20, 0x7f)) | set('→←·')
for s in lay['streets']: chars |= set(s.get('ko', '')) | set(s.get('name', ''))
uni = sorted(ord(c) for c in chars if not c.isspace() or c == ' ')
font = TTFont(sys.argv[1])
if 'fvar' in font: font = instancer.instantiateVariableFont(font, {'wght': 700})
o = subset.Options(); o.flavor = 'woff2'; o.layout_features = ['*']; o.name_IDs = ['*']; o.notdef_outline = True
s = subset.Subsetter(o); s.populate(unicodes=uni); s.subset(font)
fam, ps = 'E Sans', 'E-Sans'
nt = font['name']; nt.names = [n for n in nt.names if n.nameID not in (1, 2, 3, 4, 6, 16, 17)]
for nid, v in ((1, fam), (2, 'Bold'), (3, ps + ';subset'), (4, fam + ' Bold'), (6, ps)): nt.setName(v, nid, 3, 1, 0x409); nt.setName(v, nid, 1, 0, 0)
out = os.path.join(ROOT, 'seoul', 'dressing', 'E-Sans.woff2'); font.flavor = 'woff2'; font.save(out)
print(f'E-Sans.woff2 {os.path.getsize(out) / 1024:.1f} KB, {len(uni)} code points')
