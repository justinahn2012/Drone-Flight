#!/usr/bin/env python3
"""S4 dev shots of tools/seoul-life-view.html in headless Chrome (shares /tmp/onetake-browser.lock with smoke.py).
  python3 tools/seoul-life-shots.py --out DIR [--size 960x480] [--q "layout=..&rain=1"] name:x,y,z,yaw,pitch,t ...
"""
import argparse, asyncio, base64, fcntl, http.server, os, socketserver, sys, threading, time, mimetypes, json
from functools import partial
from playwright.async_api import async_playwright
NM = '/home/claude/proj/node_modules'
LAYOUT = None
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

def serve(d):
    class H(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    s = socketserver.ThreadingTCPServer(('127.0.0.1', 0), partial(H, directory=d)); s.daemon_threads = True
    threading.Thread(target=s.serve_forever, daemon=True).start(); return s, s.server_address[1]

async def route(r):
    u = r.request.url; pre = 'https://cdn.jsdelivr.net/npm/three@0.180.0/'
    if u.startswith(pre):
        return await r.fulfill(path=NM + '/three/' + u[len(pre):].split('?')[0], content_type='application/javascript', headers={'access-control-allow-origin': '*'})
    if '/__layout.json' in u and LAYOUT: return await r.fulfill(path=LAYOUT, content_type='application/json')
    if u.startswith('http://127.0.0.1'): return await r.continue_()
    return await r.fulfill(status=404, body='')

async def main(a):
    global LAYOUT; LAYOUT = a.layout
    w, h = map(int, a.size.split('x')); os.makedirs(a.out, exist_ok=True)
    srv, port = serve(ROOT)
    lock = open('/tmp/onetake-browser.lock', 'w'); t0 = time.time(); fcntl.flock(lock, fcntl.LOCK_EX)
    print(f'lock after {time.time() - t0:.0f}s', flush=True)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'])
            pg = await b.new_page(viewport={'width': w, 'height': h}); pg.set_default_timeout(300000); errs = []
            pg.on('console', lambda m: m.type in ('error', 'warning') and errs.append(f'[{m.type}] {m.text[:400]}'))
            pg.on('pageerror', lambda e: errs.append(f'[pageerror] {e}'))
            await pg.route('**/*', route)
            await pg.goto(f'http://127.0.0.1:{port}/tools/seoul-life-view.html?manual&{a.q}' + ('&layout=/__layout.json' if a.layout else ''))
            await pg.wait_for_function('window.__ready === true')
            if a.js: print('js ->', json.dumps(await pg.evaluate(a.js)))
            for spec in a.shots:
                name, v = spec.split(':'); x, y, z, yaw, pitch, t = map(float, v.split(','))
                d = await pg.evaluate(f'window.__view.shot({x},{y},{z},{yaw},{pitch},{t})')
                f = os.path.join(a.out, name + '.jpg'); open(f, 'wb').write(base64.b64decode(d.split(',')[1])); print('shot', f, flush=True)
            print('stats', json.dumps(await pg.evaluate('window.__view.life.stats')))
            await b.close()
            print('errors:', '\n'.join(errs) if errs else 'none')
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN); srv.shutdown()

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--out', default='/tmp/s4shots'); ap.add_argument('--size', default='960x480'); ap.add_argument('--q', default=''); ap.add_argument('--js', default=''); ap.add_argument('--layout', default='')
    ap.add_argument('shots', nargs='+'); asyncio.run(main(ap.parse_args()))
