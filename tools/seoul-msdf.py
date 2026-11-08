#!/usr/bin/env python3
"""B (phase 2): multi-channel signed-distance (MSDF) glyph atlas for seoul-signs.js.

  PYTHONPATH=<dir with skia-pathops> python3 tools/seoul-msdf.py [--size 2048] [--range 6] [--jobs 2]

Reads the 8 renamed OFL subsets in seoul/fonts (tools/seoul-fonts.py makes them), removes contour overlaps
(skia-pathops, needed because the Noto faces are instanced variable fonts), and writes
  seoul/signs/msdf.png      RGB atlas, `size` x `size`, one cell per (face, glyph)
  seoul/signs/msdf-meta.js  ES module: per face the glyph metrics (em x 1000) and atlas rects (px)

The generator follows msdfgen (Chlumsky 2015): edges are coloured between corners (simple colouring,
3 rad angle threshold); each channel holds the signed pseudo-distance to the nearest edge of its colour;
the median of the three channels rebuilds the outline with sharp corners at any magnification. Curves are
flattened finely (< 0.03 px error) and the legacy clash correction plus a sign check against the exact
winding-number SDF clean up interpolation artefacts. The px/em is the largest that packs into the atlas.
Re-run after tools/seoul-fonts.py (i.e. after adding words to seoul-signs.js).
"""
import argparse, math, os, sys, json
from multiprocessing import Pool
import numpy as np
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.basePen import decomposeQuadraticSegment, decomposeSuperBezierSegment

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FACES = [('S2 BlackHan', 'S2-BlackHanSans.woff2'), ('S2 DoHyeon', 'S2-DoHyeon.woff2'), ('S2 Jua', 'S2-Jua.woff2'),
         ('S2 Brush', 'S2-BrushScript.woff2'), ('S2 Pen', 'S2-PenScript.woff2'), ('S2 Gothic', 'S2-GothicA1Black.woff2'),
         ('S2 Serif', 'S2-NotoSerifKR900.woff2'), ('S2 Sans', 'S2-NotoSansKR800.woff2')]
SYMBOLS = set('·★◆♪■●▶※「」°…~+-%:/&!?.,#()\'"@*')
RED, GREEN, BLUE, YELLOW, MAGENTA, CYAN, WHITE = 1, 2, 4, 3, 5, 6, 7


def wanted(cp):
    c = chr(cp)
    return 0xac00 <= cp <= 0xd7a3 or 'A' <= c <= 'Z' or 'a' <= c <= 'z' or '0' <= c <= '9' or c == ' ' or c in SYMBOLS


# ------------------------------------------------------------------------------------------------ outlines
def outline(glyphset, gname):
    """-> list of contours; each contour a list of segments ('L', p0, p1) | ('Q', p0, c, p1) | ('C', p0, c1, c2, p1)"""
    pen = DecomposingRecordingPen(glyphset)
    glyphset[gname].draw(pen)
    contours, cur, start, last = [], [], None, None
    for op, args in pen.value:
        if op == 'moveTo':
            cur, start, last = [], args[0], args[0]
        elif op == 'lineTo':
            if args[0] != last: cur.append(('L', last, args[0]))
            last = args[0]
        elif op == 'qCurveTo':
            if args[-1] is None:  # all off-curve closed contour (rare)
                pts = list(args[:-1]); mid = ((pts[-1][0] + pts[0][0]) / 2, (pts[-1][1] + pts[0][1]) / 2)
                start = last = mid; args = tuple(pts) + (mid,)
            for c, p in decomposeQuadraticSegment(args):
                cur.append(('Q', last, c, p)); last = p
        elif op == 'curveTo':
            for c1, c2, p in decomposeSuperBezierSegment(args):
                cur.append(('C', last, c1, c2, p)); last = p
        elif op in ('closePath', 'endPath'):
            if last is not None and start is not None and last != start: cur.append(('L', last, start))
            if cur: contours.append(cur)
            cur, start, last = [], None, None
    if cur: contours.append(cur)
    return contours


def seg_dir(s, end):
    """tangent at start (end=0) or end (end=1), font units"""
    P = s[1:]
    if end == 0:
        for q in P[1:]:
            d = (q[0] - P[0][0], q[1] - P[0][1])
            if d != (0, 0): return d
    else:
        for q in reversed(P[:-1]):
            d = (P[-1][0] - q[0], P[-1][1] - q[1])
            if d != (0, 0): return d
    return (P[-1][0] - P[0][0], P[-1][1] - P[0][1])


def flatten(s, scale, tol=0.03):
    """segment -> polyline points (font units) with error below tol px at `scale` px/unit"""
    if s[0] == 'L': return [s[1], s[2]]
    if s[0] == 'Q':
        p0, c, p1 = (np.array(v, float) for v in s[1:])
        dd = np.linalg.norm(p0 - 2 * c + p1) * scale
        n = int(min(64, max(2, math.ceil(math.sqrt(dd / (8 * tol))))))
        t = np.linspace(0, 1, n + 1)[:, None]
        pts = (1 - t) ** 2 * p0 + 2 * (1 - t) * t * c + t ** 2 * p1
    else:
        p0, c1, c2, p1 = (np.array(v, float) for v in s[1:])
        dd = max(np.linalg.norm(p0 - 2 * c1 + c2), np.linalg.norm(c1 - 2 * c2 + p1)) * scale
        n = int(min(96, max(2, math.ceil(math.sqrt(3 * dd / (4 * tol))))))
        t = np.linspace(0, 1, n + 1)[:, None]
        pts = (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * c1 + 3 * (1 - t) * t ** 2 * c2 + t ** 3 * p1
    return [tuple(p) for p in pts]


# ------------------------------------------------------------------------------------------------ edge colouring (msdfgen simple)
class Seed:
    def __init__(self, v): self.v = v


def switch_color(color, seed, banned=0):
    combined = color & banned
    if combined in (RED, GREEN, BLUE): return combined ^ WHITE
    if color in (0, WHITE):
        c = (CYAN, MAGENTA, YELLOW)[seed.v % 3]; seed.v //= 3; return c
    shifted = color << (1 + (seed.v & 1)); seed.v >>= 1
    return (shifted | shifted >> 3) & WHITE


def is_corner(a, b, cross_thr=math.sin(3.0)):
    la, lb = math.hypot(*a), math.hypot(*b)
    if la == 0 or lb == 0: return False
    a = (a[0] / la, a[1] / la); b = (b[0] / lb, b[1] / lb)
    return a[0] * b[0] + a[1] * b[1] <= 0 or abs(a[0] * b[1] - a[1] * b[0]) > cross_thr


def color_edges(contours, seed_v=0):
    """-> per contour a list of colours, one per segment (edges split for the teardrop case are handled by the caller
    through sub-segment colouring: returns ('frac', colours) for single-corner contours)"""
    seed = Seed(seed_v); color = WHITE; out = []
    for segs in contours:
        m = len(segs); corners = []
        prev = seg_dir(segs[-1], 1)
        for i, s in enumerate(segs):
            if is_corner(prev, seg_dir(s, 0)): corners.append(i)
            prev = seg_dir(s, 1)
        if not corners:
            color = switch_color(color, seed); out.append(('all', [color] * m, corners))
        elif len(corners) == 1:
            color = switch_color(color, seed); c0 = color; color = switch_color(color, seed); c2 = color
            out.append(('tear', (c0, WHITE, c2), corners))
        else:
            n = len(corners); spline = 0; start = corners[0]
            color = switch_color(color, seed); initial = color; cols = [0] * m
            for i in range(m):
                idx = (start + i) % m
                if spline + 1 < n and corners[spline + 1] == idx:
                    spline += 1
                    color = switch_color(color, seed, initial if spline == n - 1 else 0)
                cols[idx] = color
            out.append(('seg', cols, corners))
    return out


# ------------------------------------------------------------------------------------------------ one glyph
def render_glyph(job):
    """job: (contours (font units), scale px/unit, ox, oy (cell px of the em origin, y down), cw, ch, rng)
    -> (msdf uint8 [ch, cw, 3], ink px^2)"""
    contours, scale, ox, oy, cw, ch, rng = job
    if not contours:
        return np.full((ch, cw, 3), 0, np.uint8), 0.0
    colours = color_edges(contours)
    A, B, COL, EDGE, FIRST, LAST = [], [], [], [], [], []
    eid = 0
    for segs, (mode, cols, corners) in zip(contours, colours):
        if mode == 'tear':
            # one corner: colour by position along the contour (sub-segments), split into three runs (msdfgen splits edges)
            subs = []
            for s in segs: pts = flatten(s, scale); subs += list(zip(pts[:-1], pts[1:]))
            k0 = corners[0]; pre = sum(len(flatten(s, scale)) - 1 for s in segs[:k0]); subs = subs[pre:] + subs[:pre]
            n = len(subs)
            for j, (a, b) in enumerate(subs):
                part = min(2, int(3 * j / n)); c = cols[part]
                A.append(a); B.append(b); COL.append(c); EDGE.append(eid + part)
                FIRST.append(j == 0 or int(3 * (j - 1) / n) != part); LAST.append(j == n - 1 or int(3 * (j + 1) / n) != part)
            eid += 3
            continue
        for s, c in zip(segs, cols):
            pts = flatten(s, scale)
            for j in range(len(pts) - 1):
                A.append(pts[j]); B.append(pts[j + 1]); COL.append(c); EDGE.append(eid)
                FIRST.append(j == 0); LAST.append(j == len(pts) - 2)
            eid += 1
    A = np.array(A, float) * scale; B = np.array(B, float) * scale
    # font (y up) -> cell px (y down)
    A[:, 0] += ox; B[:, 0] += ox; A[:, 1] = oy - A[:, 1]; B[:, 1] = oy - B[:, 1]
    COL = np.array(COL); FIRST = np.array(FIRST); LAST = np.array(LAST)
    keep = np.hypot(*(B - A).T) > 1e-9
    A, B, COL, FIRST, LAST = A[keep], B[keep], COL[keep], FIRST[keep], LAST[keep]
    ys, xs = np.mgrid[0:ch, 0:cw]
    P = np.stack([xs.ravel() + 0.5, ys.ravel() + 0.5], 1)                       # pixel centres
    D = B - A; L2 = (D ** 2).sum(1); Lr = np.sqrt(L2)
    PA = P[:, None, :] - A[None, :, :]                                          # [m, n, 2]
    traw = (PA * D[None]).sum(2) / L2[None]
    t = np.clip(traw, 0, 1)
    Q = A[None] + t[..., None] * D[None]
    dist = np.sqrt(((P[:, None, :] - Q) ** 2).sum(2))                          # true distance to each sub-segment
    cr = (D[None, :, 0] * PA[..., 1] - D[None, :, 1] * PA[..., 0])             # cross (y down)
    # orthogonality tie-break (msdfgen SignedDistance.dot): prefer the segment the point is most perpendicular to
    PQ = P[:, None, :] - Q; pql = np.maximum(np.sqrt((PQ ** 2).sum(2)), 1e-9)
    dot = np.abs((PQ * D[None]).sum(2)) / (pql * Lr[None])
    score = dist + dot * 1e-4
    # inside test: non-zero winding of the flattened outline (exact SDF sign)
    ay, by = A[:, 1][None], B[:, 1][None]; px_, py_ = P[:, 0:1], P[:, 1:2]
    up = (ay <= py_) & (by > py_); dn = (ay > py_) & (by <= py_)
    xint = A[:, 0][None] + (py_ - ay) / np.where(by - ay == 0, 1, by - ay) * (B[:, 0] - A[:, 0])[None]
    left = xint > px_
    wind = (np.where(up & left, 1, 0) - np.where(dn & left, 1, 0)).sum(1)
    inside = wind != 0
    jall = np.argmin(score, 1); m = np.arange(len(P))
    sdf = np.where(inside, 1, -1) * dist[m, jall]                               # exact, px, + inside
    # orientation: which cross sign means inside for this font (y flipped already)
    sgn_seg = np.sign(cr[m, jall]); agree = (sgn_seg == np.where(inside, 1, -1)).mean()
    orient = 1.0 if agree >= 0.5 else -1.0
    out = np.zeros((len(P), 3))
    for ci, bit in enumerate((RED, GREEN, BLUE)):
        sel = (COL & bit) != 0
        if not sel.any():
            out[:, ci] = sdf; continue
        sc = np.where(sel[None], score, np.inf); j = np.argmin(sc, 1)
        d = dist[m, j] * np.sign(cr[m, j]) * orient
        d = np.where(cr[m, j] == 0, np.where(inside, 1, -1) * dist[m, j], d)
        # pseudo-distance beyond the edge's end points: distance to the edge's tangent line
        tr = traw[m, j]
        before = FIRST[j] & (tr < 0); after = LAST[j] & (tr > 1)
        ext = before | after
        pd = cr[m, j] / Lr[j] * orient
        use = ext & (np.abs(pd) <= np.abs(d))
        d = np.where(use, pd, d)
        out[:, ci] = d
    msd = out.reshape(ch, cw, 3); sd = sdf.reshape(ch, cw)
    # error correction 1: legacy clash detection between neighbours (threshold ~1 px per texel)
    norm = msd / rng + 0.5; thr = 1.001 / rng
    med = np.median(norm, 2)
    clash = np.zeros((ch, cw), bool)

    def pairs(dy, dx):
        y0, y1 = 0, ch - dy; x0, x1 = max(0, -dx), cw - max(0, dx)
        return (slice(y0, y1), slice(x0, x1)), (slice(y0 + dy, y1 + dy), slice(x0 + dx, x1 + dx))
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        sa, sb = pairs(dy, dx); a = norm[sa]; b = norm[sb]
        diff = np.abs(b - a); order = np.argsort(-diff, 2)
        a_s = np.take_along_axis(a, order, 2); b_s = np.take_along_axis(b, order, 2)
        t_ = thr * (1.4142 if dx and dy else 1.0)
        eqb = (b_s[..., 0] == b_s[..., 1]) & (b_s[..., 0] == b_s[..., 2])
        eqa = (a_s[..., 0] == a_s[..., 1]) & (a_s[..., 0] == a_s[..., 2])
        big = np.abs(b_s[..., 0] - a_s[..., 0]) >= t_
        ca = big & ~eqb & (np.abs(a_s[..., 2] - 0.5) >= np.abs(b_s[..., 2] - 0.5))
        cb = big & ~eqa & (np.abs(b_s[..., 2] - 0.5) >= np.abs(a_s[..., 2] - 0.5))
        clash[sa] |= ca; clash[sb] |= cb
    norm[clash] = med[clash][:, None]
    # error correction 2: the median must agree in sign with the exact SDF away from the outline
    med = np.median(norm, 2)
    bad = (np.sign(med - 0.5) != np.sign(sd)) & (np.abs(sd) > 0.6)
    norm[bad] = (sd[bad] / rng + 0.5)[:, None]
    img = np.clip(np.round(norm * 255), 0, 255).astype(np.uint8)
    ink = float(np.clip(sd + 0.5, 0, 1).sum())
    return img, ink


# ------------------------------------------------------------------------------------------------ packing
def pack(sizes, W, H):
    order = sorted(range(len(sizes)), key=lambda i: (-sizes[i][1], -sizes[i][0]))
    x = y = rowh = 0; pos = [None] * len(sizes)
    for i in order:
        w, h = sizes[i]
        if x + w > W: x = 0; y += rowh; rowh = 0
        if y + h > H: return None
        pos[i] = (x, y); x += w; rowh = max(rowh, h)
    return pos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=2048); ap.add_argument('--range', type=float, default=6.0)
    ap.add_argument('--jobs', type=int, default=2); ap.add_argument('--px', type=float, default=0)
    ap.add_argument('--out', default=os.path.join(ROOT, 'seoul', 'signs'))
    a = ap.parse_args()
    from fontTools.ttLib.removeOverlaps import removeOverlaps
    rng = a.range; pad = math.ceil(rng / 2) + 1
    faces = []
    for name, file in FACES:
        f = TTFont(os.path.join(ROOT, 'seoul', 'fonts', file))
        try: removeOverlaps(f)
        except Exception as e: print('removeOverlaps', name, e, file=sys.stderr)
        upm = f['head'].unitsPerEm; cmap = f.getBestCmap(); gs = f.getGlyphSet(); hmtx = f['hmtx']
        glyphs = []
        for cp in sorted(cp for cp in cmap if wanted(cp)):
            gn = cmap[cp]; cont = outline(gs, gn)
            pts = [p for c in cont for s in c for p in s[1:]]
            bb = (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)) if pts else None
            glyphs.append({'cp': cp, 'adv': hmtx[gn][0] / upm, 'cont': cont, 'bb': bb})
        hang = [g for g in glyphs if 0xac00 <= g['cp'] <= 0xd7a3 and g['bb']]
        hh = float(np.median([(g['bb'][3] - g['bb'][1]) / upm for g in hang]))
        mid = float(np.median([(g['bb'][3] + g['bb'][1]) / 2 / upm for g in hang]))
        caps = [g for g in glyphs if 'A' <= chr(g['cp']) <= 'Z' and g['bb']]
        capH = float(np.median([g['bb'][3] / upm for g in caps])) if caps else hh
        faces.append({'name': name, 'upm': upm, 'glyphs': glyphs, 'hh': hh, 'mid': mid, 'cap': capH})
        print(f'{name:12s} {len(glyphs):4d} glyphs  hangul h {hh:.3f} em  mid {mid:.3f}', flush=True)
    allg = [(fi, g) for fi, F in enumerate(faces) for g in F['glyphs'] if g['bb']]

    def sizes_for(px):
        out = []
        for fi, g in allg:
            s = px / faces[fi]['upm']; b = g['bb']
            out.append((math.ceil((b[2] - b[0]) * s) + 2 * pad, math.ceil((b[3] - b[1]) * s) + 2 * pad))
        return out
    if a.px: px = a.px; pos = pack(sizes_for(px), a.size, a.size); assert pos, 'does not fit'
    else:
        lo, hi = 16.0, 96.0
        for _ in range(14):
            mid = (lo + hi) / 2
            if pack(sizes_for(mid), a.size, a.size): lo = mid
            else: hi = mid
        px = math.floor(lo * 4) / 4; pos = pack(sizes_for(px), a.size, a.size)
    sz = sizes_for(px)
    print(f'{len(allg)} glyphs at {px} px/em, range {rng} px, pad {pad} px -> {a.size}^2', flush=True)
    jobs = []
    for (fi, g), (w, h) in zip(allg, sz):
        s = px / faces[fi]['upm']; b = g['bb']
        ox = pad - b[0] * s; oy = pad + b[3] * s                     # cell px of the em origin (y down)
        jobs.append((g['cont'], s, ox, oy, w, h, rng)); g['cell'] = (ox, oy, w, h)
    with Pool(a.jobs) as pool:
        res = pool.map(render_glyph, jobs, chunksize=8)
    atlas = np.zeros((a.size, a.size, 3), np.uint8)
    for (fi, g), (x, y), (img, ink) in zip(allg, pos, res):
        ox, oy, w, h = g['cell']; atlas[y:y + h, x:x + w] = img
        g['atlas'] = (x, y, x + w, y + h)
        # plane bounds (em, y up, relative to the pen origin on the baseline)
        g['plane'] = (-ox / px, (oy - h) / px, (w - ox) / px, oy / px)
        g['ink'] = ink / (px * px)
    os.makedirs(a.out, exist_ok=True)
    from PIL import Image
    Image.fromarray(atlas, 'RGB').save(os.path.join(a.out, 'msdf.png'), optimize=True)
    meta = {'version': 1, 'image': 'seoul/signs/msdf.png', 'size': [a.size, a.size], 'px': px, 'range': rng, 'faces': []}
    for F in faces:
        chars, nums = [], []
        for g in F['glyphs']:
            chars.append(chr(g['cp']))
            if 'atlas' in g:
                pl = g['plane']; at = g['atlas']
                nums += [round(g['adv'] * 1000), *(round(v * 1000) for v in pl), *at, round(g['ink'] * 1000)]
            else:
                nums += [round(g['adv'] * 1000), 0, 0, 0, 0, 0, 0, 0, 0, 0]
        meta['faces'].append({'name': F['name'], 'hh': round(F['hh'], 4), 'mid': round(F['mid'], 4), 'cap': round(F['cap'], 4),
                              'chars': ''.join(chars), 'g': nums})
    js = ('// generated by tools/seoul-msdf.py: MSDF glyph atlas metrics for seoul-signs.js. Do not edit.\n'
          '// g: 10 numbers per char of `chars`: advance, plane l b r t (em x 1000, y up from the baseline), atlas x0 y0 x1 y1 (px, y down), ink (em^2 x 1000)\n'
          'export const MSDF = ' + json.dumps(meta, ensure_ascii=False, separators=(',', ':')) + ';\nexport default MSDF;\n')
    open(os.path.join(a.out, 'msdf-meta.js'), 'w', encoding='utf8').write(js)
    print('wrote', os.path.join(a.out, 'msdf.png'), os.path.getsize(os.path.join(a.out, 'msdf.png')) // 1024, 'KB;',
          'msdf-meta.js', len(js) // 1024, 'KB', flush=True)


if __name__ == '__main__':
    main()
