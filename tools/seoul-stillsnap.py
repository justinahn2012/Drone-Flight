#!/usr/bin/env python3
"""tools/seoul-stillsnap.py --dir . --shots tools/seoul-stills-poses.json --out DIR (P5-F ui #1 / #2): identity stills from the build, HUD off, quality auto, acro, held still (seoulsnap's serving + lock).
Per shot it also casts a 32 x 18 grid of camera rays into the collider BVH and reports the nearest hit (the depth check: a
frame with anything within 3 m of the camera is rejected: phase 4's backdrop had a blurred pole through it), the share of
rays within 8 m, and the share of near-black pixels (P6-F ui #3: nearest >= 3 m and <= 20 % under 0.05 luma)."""
import argparse, asyncio, base64, fcntl, json, os, sys, time
sys.path.insert(0, '/home/claude/scripts')
import seoulsnap as S
from playwright.async_api import async_playwright

# [P6-F ui #3] the depth check casts the grid into the collider BVH (world.bvh: every building, prop and pole the quad can
# hit, built once and never freed), not the scene's meshes: phase 5's version skipped meshes whose CPU arrays were freed after
# upload (every building), so it read "nearest 99 m" while a wall filled the left 28 % of the backdrop. It also reports the
# share of rays that hit within 8 m (`wall8`: a near wall across the frame) and, from the still, the share of pixels under
# 0.05 luma (`dark`). Gate (panel 5): nearest >= 3 m and dark <= 20 %.
DEPTH = """(async () => { const T = await import('three'); const o = window.__onetake, cam = o.fpv.cam; cam.updateMatrixWorld();
  const bvh = o.world.bvh; if (!bvh) return { err: 'no world.bvh' };
  const rc = new T.Raycaster(); let near = 999, n3 = 0, n8 = 0, N = 0; const v = new T.Vector2();
  for (let i = 0; i < 32; i++) for (let j = 0; j < 18; j++) { v.set((i + 0.5) / 16 - 1, (j + 0.5) / 9 - 1); rc.setFromCamera(v, cam);
    const h = bvh.raycastFirst(rc.ray, T.DoubleSide, 0.05, 400); N++; if (h) { near = Math.min(near, h.distance); if (h.distance < 3) n3++; if (h.distance < 8) n8++; } }
  return { near: +near.toFixed(2), within3: n3, wall8: +(n8 / N).toFixed(3), rays: N, via: 'bvh', pos: cam.position.toArray().map((x) => +x.toFixed(2)) }; })()"""

def dark_share(path, thr=0.05):
    from PIL import Image
    im = Image.open(path).convert('L'); px = im.getdata(); n = len(px) or 1
    return round(sum(1 for y in px if y / 255 < thr) / n, 3)

async def main(a):
    w, h = map(int, a.size.split('x')); os.makedirs(a.out, exist_ok=True)
    shots = json.loads(open(a.shots).read())
    srv, port = S.serve(os.path.abspath(a.dir))
    lock = open('/tmp/onetake-browser.lock', 'w'); t_wait = time.time(); fcntl.flock(lock, fcntl.LOCK_EX)
    print(f'browser lock acquired after {time.time() - t_wait:.0f}s', flush=True)
    rep = {}
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'])
            pg = await b.new_page(viewport={'width': w, 'height': h}); pg.set_default_timeout(600000)
            errs = []
            pg.on('console', lambda m: (m.type == 'error' or 'ERROR' in m.text) and errs.append(f'[{m.type}] {m.text[:300]}'))
            pg.on('pageerror', lambda e: errs.append(f'[pageerror] {e}'))
            await pg.route('**/*', S.route)
            st = {'world': 'seoul-hongdae', 'quality': a.quality, 'v': 3, 'mode': 'cine', 'hud': 'off', 'sound': 'off'}
            await pg.add_init_script(f"localStorage.setItem('onetake.settings', JSON.stringify({json.dumps(st)}));")
            await pg.goto(f'http://127.0.0.1:{port}/index.html?manual&level=seoul-hongdae'); await pg.wait_for_timeout(800)
            t0 = time.time(); await pg.evaluate('window.__onetake.startFlight(true)')
            state = None
            for i in range(400):
                state = await pg.evaluate('window.__onetake && window.__onetake.state')
                if state in ('fly', 'crash'): break
                await pg.wait_for_timeout(500)
            print(f'load {time.time() - t0:.1f}s state={state}', flush=True)
            for name, (js, vel) in shots.items():
                await pg.evaluate("(()=>{const o=window.__onetake; o.S.mode='acro'; o.applySettings(); o.fpv.setQualityRange&&o.fpv.setQualityRange(1.05,1.05); o.fpv.scale=1.05; o.controls.thr=0.39; " + js + "})()")
                d = None
                for i in range(10):
                    setv = f"window.__onetake.drone.vel.set({vel[0]},{vel[1]},{vel[2]});" if vel else "window.__onetake.drone.vel.set(0,0,0);"
                    d = await pg.evaluate(f"(()=>{{{setv} window.__onetake.controls.thr=0.39; return window.__onetake.step(33,1,{'true' if i == 9 else 'false'})}})()")
                    await pg.wait_for_timeout(40)
                f = os.path.join(a.out, f'{name}.jpg'); open(f, 'wb').write(base64.b64decode(d.split(',')[1]))
                dep = await pg.evaluate(DEPTH)
                dep['dark'] = dark_share(f)
                dep['pass'] = bool(dep.get('near', 0) >= 3 and dep['dark'] <= 0.20)
                rep[name] = {'js': js, **dep}
                print(f'shot {name} -> {f}  depth {dep}', flush=True)
            await b.close()
            print('--- console errors ---'); print('\n'.join(errs) if errs else 'none')
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN); srv.shutdown()
    json.dump(rep, open(os.path.join(a.out, 'stills-depth.json'), 'w'), indent=1)

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--dir', required=True); ap.add_argument('--size', default='1600x900'); ap.add_argument('--quality', default='auto')
    ap.add_argument('--out', required=True); ap.add_argument('--shots', required=True)
    asyncio.run(main(ap.parse_args()))
