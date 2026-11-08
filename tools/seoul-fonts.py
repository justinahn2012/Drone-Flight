#!/usr/bin/env python3
"""S2: subset the OFL Korean sign faces to the glyphs seoul-signs.js can draw -> seoul/fonts/*.woff2.

  python3 tools/seoul-fonts.py SRC_DIR   (SRC_DIR holds the Google Fonts TTFs from github.com/google/fonts/ofl/*)

Re-run after adding words to seoul-signs.js. Every face is SIL OFL 1.1 (seoul/fonts/OFL.txt)."""
import os, sys
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = sys.argv[1]
text = open(os.path.join(ROOT, 'seoul-signs.js'), encoding='utf8').read()
chars = set(c for c in text if ord(c) >= 0x80) | set(chr(c) for c in range(0x20, 0x7f))
uni = sorted(ord(c) for c in chars)
FACES = [  # (source file, out name, variable weight or None)
    ('bhs.ttf', 'BlackHanSans', None), ('DoHyeon-Regular.ttf', 'DoHyeon', None), ('Jua-Regular.ttf', 'Jua', None),
    ('NanumBrushScript-Regular.ttf', 'NanumBrushScript', None), ('NanumPenScript-Regular.ttf', 'NanumPenScript', None),
    ('GothicA1-Black.ttf', 'GothicA1Black', None), ('NotoSerifKR', 'NotoSerifKR900', 900), ('NotoSansKR', 'NotoSansKR800', 800)]
out = os.path.join(ROOT, 'seoul', 'fonts'); os.makedirs(out, exist_ok=True)
for f, name, wght in FACES:
    font = TTFont(os.path.join(src, f))
    if wght is not None: font = instancer.instantiateVariableFont(font, {'wght': wght})
    o = subset.Options(); o.flavor = 'woff2'; o.layout_features = ['*']; o.name_IDs = ['*']; o.notdef_outline = True
    s = subset.Subsetter(o); s.populate(unicodes=uni); s.subset(font)
    p = os.path.join(out, name + '.woff2'); font.flavor = 'woff2'; font.save(p)
    print(f'{name:18s} {os.path.getsize(p)/1024:7.1f} KB')
print(len(uni), 'code points')
