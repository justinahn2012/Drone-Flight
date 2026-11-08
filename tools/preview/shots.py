#!/usr/bin/env python3
"""S3 night preview stills + frame stats (plan-G5 section 4) in headless Chrome (SwiftShader), sharing the smoke lock.

  python3 tools/preview/shots.py --dir <worktree> --out DIR [--shots walk,club] [--retro 0,0.3] [--size 640x360] [--aestep] [--timing]

Stats per still (8-bit sRGB output): luma p5/p50/p95, % clipped (any channel 255), % luma < 16, hue census of bright saturated
pixels (warm = red/orange/yellow, neon = magenta/pink + cyan + violet), shadow hue/chroma (Oklab, luma < 16), lit-pixel saturation.
"""
import argparse, asyncio, base64, fcntl, http.server, io, json, math, mimetypes, os, socketserver, sys, threading, time
from functools import partial
from playwright.async_api import async_playwright
import numpy as np
from PIL import Image

NM = '/home/claude/proj/node_modules'
MAP = [('https://cdn.jsdelivr.net/npm/three@0.180.0/', NM + '/three/')]

def serve(d):
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    s = socketserver.ThreadingTCPServer(('127.0.0.1', 0), partial(Q, directory=d)); s.daemon_threads = True
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s, s.server_address[1]

async def route(r):
    u = r.request.url
    for pre, loc in MAP:
        if u.startswith(pre):
            f = loc + u[len(pre):].split('?')[0]
            return await r.fulfill(path=f, content_type='application/javascript', headers={'access-control-allow-origin': '*'})
    if u.startswith('http://127.0.0.1'): return await r.continue_()
    return await r.fulfill(status=404, body='')

def oklab(rgb):
    c = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]])
    M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]])
    return np.cbrt(c @ M1.T) @ M2.T

def stats(img):
    a = np.asarray(img.convert('RGB')).astype(np.float64)
    Y = a @ np.array([0.2126, 0.7152, 0.0722])
    lab = oklab(a / 255.0)
    C = np.hypot(lab[..., 1], lab[..., 2]); h = (np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) + 360) % 360
    bs = (Y > 110) & (C > 0.10)
    def share(lo, hi): m = bs & (((h >= lo) & (h < hi)) if lo < hi else ((h >= lo) | (h < hi))); return 100 * m.sum() / max(1, bs.sum())
    warm = share(0, 115) + share(345, 360)
    neon = share(300, 345) + share(180, 300)
    sh = Y < 16
    sa, sb = lab[..., 1][sh].mean() if sh.any() else 0, lab[..., 2][sh].mean() if sh.any() else 0
    lit = Y > 40
    return {'p5': round(float(np.percentile(Y, 5)), 1), 'p50': round(float(np.percentile(Y, 50)), 1), 'p95': round(float(np.percentile(Y, 95)), 1),
            'clip%': round(100 * float((a.max(-1) >= 254.5).mean()), 2), 'lt16%': round(100 * float(sh.mean()), 1),
            'warm%': round(warm, 1), 'neon%': round(neon, 1), 'brightSat%px': round(100 * float(bs.mean()), 2),
            'shadowHue': round(float((math.degrees(math.atan2(sb, sa)) + 360) % 360), 0), 'shadowC': round(float(math.hypot(sa, sb)), 4),
            'litSat': round(float(C[lit].mean()) if lit.any() else 0, 4)}

async def main(a):
    w, h = map(int, a.size.split('x'))
    os.makedirs(a.out, exist_ok=True)
    srv, port = serve(os.path.abspath(a.dir))
    lock = open('/tmp/onetake-browser.lock', 'w'); fcntl.flock(lock, fcntl.LOCK_EX)
    out = {}
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
            pg = await b.new_page(viewport={'width': w, 'height': h}); pg.set_default_timeout(600000)
            errs = []
            pg.on('console', lambda m: m.type in ('error', 'warning') and errs.append(f'[{m.type}] {m.text[:400]}'))
            pg.on('pageerror', lambda e: errs.append(f'[pageerror] {e}'))
            await pg.route('**/*', route)
            extra = ('&' + a.query) if a.query else ''
            await pg.goto(f'http://127.0.0.1:{port}/tools/preview/seoul-light-preview.html?auto{extra}')
            for i in range(240):
                if await pg.evaluate('!!window.__ready') or errs and any('pageerror' in e for e in errs): break
                await pg.wait_for_timeout(500)
            print('stats', await pg.evaluate('JSON.stringify(window.__h && window.__h.stats)'), 'layout', await pg.evaluate('window.__h && window.__h.layoutSrc'), flush=True)
            for s in [x for x in a.shots.split(',') if x]:
                for r in [float(x) for x in a.retro.split(',')]:
                    ev = await pg.evaluate(f'window.__h.shot("{s}", {r}, {a.frames}, {a.yaw})')
                    d = await pg.evaluate('document.getElementById("c").toDataURL("image/png")')
                    img = Image.open(io.BytesIO(base64.b64decode(d.split(',')[1])))
                    f = os.path.join(a.out, f'{s}_r{r:g}{a.tag}.png'); img.save(f)
                    st = stats(img); st['EV'] = round(ev, 2) if ev is not None else None
                    out[f'{s}_r{r:g}'] = st
                    print(f'{f}  {json.dumps(st)}', flush=True)
            if a.aestep:
                print('aestep', await pg.evaluate('JSON.stringify(window.__h.aeStep("alley","walk"))'), flush=True)
            if a.timing:
                print('ms/frame (swiftshader)', await pg.evaluate('window.__h.timing("walk", 10)'), flush=True)
            await b.close()
            print('--- console ---'); print('\n'.join(errs) if errs else 'none')
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN); srv.shutdown()
    json.dump(out, open(os.path.join(a.out, f'stats{a.tag}.json'), 'w'), indent=1)

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True); ap.add_argument('--out', default='/tmp/s3-shots'); ap.add_argument('--shots', default='walk,club')
    ap.add_argument('--retro', default='0,0.3'); ap.add_argument('--size', default='640x360'); ap.add_argument('--frames', type=int, default=12)
    ap.add_argument('--yaw', type=float, default=0); ap.add_argument('--query', default=''); ap.add_argument('--tag', default='')
    ap.add_argument('--aestep', action='store_true'); ap.add_argument('--timing', action='store_true')
    asyncio.run(main(ap.parse_args()))
