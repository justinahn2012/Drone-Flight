#!/usr/bin/env python3
"""tools/seoul-hudsnap.py (P5-F ui #3): seoulsnap --hud: page screenshots WITH the DOM HUD at the phone size, quality low (the phone preset).
Shots: spawn (READY tag + first toast), caption (a FAST street caption mid-street), pause (menu), end (CUT card).
For each OSD readout it also grabs the world-only canvas and reports the share of pixels > 0.6 luma under the readout.
Same lock / serving as /home/claude/scripts/seoulsnap.py (imported).
[P6-F] ui #2: the caption shot starts the take (a 'start' event, state 'live') before its line event (phase 5 fired it while
the take was 'ready', so the shot had no caption), and reports the luma p80 under the caption (#pop) and #live (gate <= 0.35, else the caption
needs a plate); ui #1: the spawn shot reports the frame's luma p50 (8-bit codes, gate >= 40) and the bracket labels on screen
(one at 'ready').
[P7-F] ui #3: the pause shot lists any level card / LINES cell text under the sticky RESUME bar (gate: none).
[P8-F] --only picks shots (the browser budget: <= 4 per run); the spawn shot casts a 32 x 18 ray grid into the collider and gates
the share within 4 m (<= 5 %: ui #4, phase 7's blurred 화장품 disc filled ~12 % of the lower left); the end card is a CLEAN TAKE
(design #4: 3 stars, 468k, no SCRAPE, the medal); --thumb OUT.jpg [--ss 2] also shoots the level-card thumb still (ui #3) on a
second page, HUD off, at 1600 x 900 x ss with every texture at max anisotropy, at stills.json's thumb pose."""
import argparse, asyncio, base64, fcntl, json, os, sys, time, io
sys.path.insert(0, '/home/claude/scripts')
import seoulsnap as S
from playwright.async_api import async_playwright
from PIL import Image

READOUTS = "(() => { const o = {}; for (const [k, sel] of Object.entries({tag: '#takeTag', score: '#osd .tr', link: '#oLQ', next: '#oNext', alt: '#osd .rm', mode: '#osd .bl', timer: '#osd .bc', speed: '#osd .br', live: '#live', toast: '#toast', pop: '#pop'})) { const e = document.querySelector(sel); if (!e || !e.offsetParent && getComputedStyle(e).position !== 'fixed') continue; const r = e.getBoundingClientRect(); if (r.width > 2 && r.height > 2 && getComputedStyle(e).opacity !== '0') o[k] = [r.left, r.top, r.right, r.bottom]; } return o; })()"

def luma_p(img, box, W, H, q=0.8):
    sx, sy = img.width / W, img.height / H
    x0, y0, x1, y1 = [int(v) for v in (box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy)]
    c = img.crop((max(0, x0), max(0, y0), min(img.width, x1), min(img.height, y1))).convert('L')
    px = sorted(c.getdata()); return round(px[min(len(px) - 1, int(q * len(px)))] / 255, 3) if px else None

def frame_p50(img):
    px = sorted(img.convert('L').getdata()); return px[len(px) // 2]

def luma_share(img, box, W, H):
    sx, sy = img.width / W, img.height / H
    x0, y0, x1, y1 = [int(v) for v in (box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy)]
    c = img.crop((max(0, x0), max(0, y0), min(img.width, x1), min(img.height, y1))).convert('RGB')
    px = list(c.getdata()); n = len(px) or 1
    return sum(1 for r, g, b in px if (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6) / n

NEAR = """(async () => { const T = await import('three'); const o = window.__onetake, cam = o.fpv.cam; cam.updateMatrixWorld();
  const bvh = o.world.bvh; if (!bvh) return null; const rc = new T.Raycaster(), v = new T.Vector2(); let n = 0, N = 0;
  for (let i = 0; i < 32; i++) for (let j = 0; j < 18; j++) { v.set((i + 0.5) / 16 - 1, (j + 0.5) / 9 - 1); rc.setFromCamera(v, cam);
    const h = bvh.raycastFirst(rc.ray, T.DoubleSide, 0.05, 4); N++; if (h && h.distance < 4) n++; }
  return +(n / N).toFixed(3); })()"""

def edge_energy(path):
    """[P8-F ui #3] mean |Laplacian| of the luma (8-bit codes): glyph strokes on the blades are the thumb's high frequencies"""
    from PIL import Image
    import numpy as np
    a = np.asarray(Image.open(path).convert('L')).astype(np.float32)
    lap = np.abs(4 * a[1:-1, 1:-1] - a[:-2, 1:-1] - a[2:, 1:-1] - a[1:-1, :-2] - a[1:-1, 2:])
    return round(float(lap.mean()), 3)

def cg_headroom_gb():
    """memory-cgroup limit - usage (v1 or v2) for this process, GB; inf when unknown"""
    try:
        for ln in open('/proc/self/cgroup'):
            h, ctl, path = ln.strip().split(':', 2)
            for base, lim, use in ((f'/sys/fs/cgroup/memory{path}', 'memory.limit_in_bytes', 'memory.usage_in_bytes'), (f'/sys/fs/cgroup{path}', 'memory.max', 'memory.current')):
                if ('memory' in ctl.split(',') or h == '0') and os.path.exists(os.path.join(base, use)):
                    L = open(os.path.join(base, lim)).read().strip(); U = int(open(os.path.join(base, use)).read())
                    if L != 'max' and int(L) < 1 << 50: return (int(L) - U) / 2**30
    except Exception: pass
    return float('inf')

async def thumb_shot(p, a, port, errs):
    pose = json.load(open(os.path.join(a.dir, 'seoul', 'ui', 'stills.json'), encoding='utf8'))['thumb']['pose']
    W, H = int(1600 * a.ss), int(900 * a.ss)
    b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'])
    pg = await b.new_page(viewport={'width': W, 'height': H}); pg.set_default_timeout(600000)
    pg.on('pageerror', lambda e: errs.append(f'[pageerror thumb] {e}'))
    await pg.route('**/*', S.route)
    st = {'world': 'seoul-hongdae', 'quality': 'auto', 'v': 3, 'mode': 'cine', 'hud': 'off', 'sound': 'off'}
    await pg.add_init_script(f"localStorage.setItem('onetake.settings', JSON.stringify({json.dumps(st)}));")
    await pg.goto(f'http://127.0.0.1:{port}/index.html?manual&level=seoul-hongdae'); await pg.wait_for_timeout(800)
    await pg.evaluate('window.__onetake.startFlight(true)')
    for i in range(400):
        if await pg.evaluate('window.__onetake && window.__onetake.state') in ('fly', 'crash'): break
        await pg.wait_for_timeout(500)
    # as stillsnap: acro, held still, render scale 1.05; every texture at the GPU's max anisotropy (the blades are seen edge-on)
    an = await pg.evaluate("(()=>{const o=window.__onetake, mx=o.renderer.capabilities.getMaxAnisotropy(), seen=new Set(); let n=0; const up=(t)=>{if(t&&t.isTexture&&!seen.has(t)){seen.add(t); if(t.anisotropy<mx){t.anisotropy=mx; t.needsUpdate=true; n++;}}}; o.world.scene?.traverse((m)=>{for(const mt of [].concat(m.material||[])){for(const k in mt) up(mt[k]); for(const u of Object.values(mt.uniforms||{})) up(u&&u.value);}}); return [mx,n];})()")
    print(f'thumb {W}x{H}: anisotropy {an[0]} on {an[1]} textures', flush=True)
    await pg.evaluate("(()=>{const o=window.__onetake; o.S.mode='acro'; o.applySettings(); o.fpv.setQualityRange&&o.fpv.setQualityRange(1.05,1.05); o.fpv.scale=1.05; o.controls.thr=0.39; " + pose + "})()")
    d = None
    for i in range(10):
        d = await pg.evaluate(f"(()=>{{window.__onetake.drone.vel.set(0,0,0); window.__onetake.controls.thr=0.39; return window.__onetake.step(33,1,{'true' if i == 9 else 'false'})}})()")
        await pg.wait_for_timeout(40)
    open(a.thumb, 'wb').write(base64.b64decode(d.split(',')[1]))
    await b.close()
    print(f'thumb still -> {a.thumb}', flush=True)

async def main(a):
    w, h = map(int, a.size.split('x')); os.makedirs(a.out, exist_ok=True)
    srv, port = S.serve(os.path.abspath(a.dir))
    lock = open('/tmp/onetake-browser.lock', 'w'); t_wait = time.time(); fcntl.flock(lock, fcntl.LOCK_EX)
    print(f'browser lock acquired after {time.time() - t_wait:.0f}s', flush=True)
    # [P8-F] the box's `free -m` overstates room: the shell's memory cgroup is ~6.2 GB of the 8, and both phase-8 retries were
    # OOM-killed loading with free -m at 3.8 GB but ~1.8 GB of cgroup headroom. Checked after the lock (a 12 min lock wait moved
    # it): wait up to a.wait_mem s for >= a.need_gb, else release the lock and exit without launching
    t_m = time.time()
    while cg_headroom_gb() < a.need_gb:
        if time.time() - t_m > a.wait_mem:
            print(f'cgroup headroom {cg_headroom_gb():.2f} GB < {a.need_gb} GB after {a.wait_mem}s: not launching', flush=True)
            fcntl.flock(lock, fcntl.LOCK_UN); srv.shutdown(); sys.exit(2)
        time.sleep(15)
    print(f'cgroup headroom {cg_headroom_gb():.2f} GB', flush=True)
    rep = {}
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'])
            pg = await b.new_page(viewport={'width': w, 'height': h}, device_scale_factor=1, has_touch=True); pg.set_default_timeout(600000)
            errs = []
            pg.on('console', lambda m: (m.type == 'error' or 'ERROR' in m.text) and errs.append(f'[{m.type}] {m.text[:300]}'))
            pg.on('pageerror', lambda e: errs.append(f'[pageerror] {e}'))
            await pg.route('**/*', S.route)
            st = {'world': 'seoul-hongdae', 'quality': a.quality, 'v': 3, 'mode': 'cine', 'hud': 'osd', 'sound': 'off'}
            await pg.add_init_script(f"localStorage.setItem('onetake.settings', JSON.stringify({json.dumps(st)}));")
            await pg.goto(f'http://127.0.0.1:{port}/index.html?manual&level=seoul-hongdae'); await pg.wait_for_timeout(800)
            t0 = time.time(); await pg.evaluate('window.__onetake.startFlight(true)')
            state = None
            for i in range(400):
                state = await pg.evaluate('window.__onetake && window.__onetake.state')
                if state in ('fly', 'crash'): break
                await pg.wait_for_timeout(500)
            print(f'load {time.time() - t0:.1f}s state={state}', flush=True)
            print('mem', await pg.evaluate('JSON.stringify(window.__onetake.levels.mem())'))
            only = set((a.only or 'spawn,caption,pause,end').split(','))
            async def shot(name, setup, frames=8, last=None):
                if name not in only: return
                await pg.evaluate(setup)
                d = None
                for i in range(frames):
                    # [P6-F] `last` runs before the final frame: #pop hides on a wall-clock timer (CAP_DUR), and a swiftshader
                    # frame takes ~1 s, so a caption fired in `setup` was gone by the screenshot (phase 5 and 6's caption shots)
                    # [P7-F] phase 6's fix still lost it: the last frame plus the screenshot take > CAP_DUR (1.6 s) on swiftshader. The
                    # caption now fires 3 frames before the end (so the plate meter's readback lands) with the page's timers made in
                    # that call stretched x 30 (its hide timer), then restored, and #pop's CSS animation (popA: fades out by 100 %)
                    # held at 40 % (opacity 1). The run-2 shot of phase 7 had #pop.show in the DOM but faded to 0 in the picture.
                    if last and i == max(0, frames - 3): await pg.evaluate("(()=>{const st=window.setTimeout; window.setTimeout=(f,ms,...a)=>st(f,(ms||0)*30,...a); try {" + last + "} finally { window.setTimeout=st; } for (const an of document.getElementById('pop').getAnimations()) { an.currentTime = 0.4 * (an.effect.getComputedTiming().duration || 1300); an.pause(); }})()")
                    d = await pg.evaluate(f"window.__onetake.step(33,1,{'true' if i == frames - 1 else 'false'})"); await pg.wait_for_timeout(30)
                world = Image.open(io.BytesIO(base64.b64decode(d.split(',')[1])))
                f = os.path.join(a.out, f'hud-{name}.png'); await pg.screenshot(path=f)
                ro = await pg.evaluate(READOUTS)
                rep[name] = {k: round(luma_share(world, bx, w, h), 3) for k, bx in ro.items()}
                rep[name]['_p80'] = {k: luma_p(world, bx, w, h) for k, bx in ro.items() if k in ('live', 'pop', 'toast')}
                rep[name]['_frameP50'] = frame_p50(world)
                if name == 'spawn': rep[name]['_near4'] = await pg.evaluate(NEAR)
                rep[name]['_labels'] = await pg.evaluate("[...document.querySelectorAll('#osd .brl.on')].map((e) => e.textContent)")
                # [P7-F ui #3] the pause card: no level card's text (name, meta) under the sticky RESUME bar
                rep[name]['_underBar'] = await pg.evaluate("(()=>{const m=document.getElementById('menu'); if(!m||m.classList.contains('hidden')) return null; const c=document.querySelector('#menu .cta'); if(!c) return null; const B=c.getBoundingClientRect(); const top=B.top+parseFloat(getComputedStyle(c).paddingTop||0)*0.5; return [...document.querySelectorAll('#menu .world b, #menu .world .meta, #menu .ln')].filter(e=>e.offsetParent).map(e=>{const r=e.getBoundingClientRect(); return r.bottom>top && r.top<B.bottom && r.height>0 ? (e.textContent||'').trim().slice(0,24) : null}).filter(Boolean)})()")
                rep[name]['_stars'] = await pg.evaluate("(()=>{const e=document.getElementById('bStars'); return e && e.offsetParent ? e.textContent.trim() + (e.querySelector('.medal') ? ' [medal]' : '') : null})()")
                rep[name]['_pop'] = await pg.evaluate("(()=>{const e=document.getElementById('pop'); return e && e.classList.contains('show') ? {text: e.textContent.replace(/\\s+/g,' ').trim().slice(0,90), plate: e.classList.contains('plate'), opacity: +getComputedStyle(e).opacity} : null})()")
                print(f'shot {name} -> {f}  luma>0.6 under readouts: {rep[name]}', flush=True)
            # 1. spawn: the take start, READY + its hint, the first toast
            await shot('spawn', "(()=>{const o=window.__onetake; o.respawn(true); o.ui.toast((o.world.takeStart?.hint?.text||'').toUpperCase(), 6);})()")
            # 2. a FAST street caption mid-street (the walking street's 4/7 gate, flying SE)
            await shot('caption', "(()=>{const o=window.__onetake; const L=o.world.lines.find(l=>l.name==='WALKING STREET 4/7'); const p=L.pre[0].c, n=L.n; o.tp(p[0]-n[0]*4,3.4,p[2]-n[2]*4,Math.atan2(-n[0],-n[2])*180/Math.PI,0); o.take.reset(); for (const e of o.take.update(0.01,o.drone,o.world,{hands:true,moved:true,steer:false})) o.ui.onTakeEvent(e);})()", 6, "(()=>{const o=window.__onetake; o.ui.onTakeEvent({type:'line',name:'WALKING STREET',caption:'THE WALKING *STREET*!',pts:58836,flow:2,clean:true,micro:false,dur:31.2,best:33.5,newBest:false,par:34.4,speed:1.9,fast:true,t0:1,ago:31,t:32});})()")
            # 3. pause
            await shot('pause', "(()=>{window.__onetake.ui.openMenu();})()", 3)
            # 4. the CUT card of a careful long take
            await shot('end', "(()=>{const o=window.__onetake; const m=document.getElementById('menu'); if(m) m.classList.add('hidden'); const L=[]; ['UNDER THE STAGE','WALKING STREET','HONGIK-RO','BAR ALLEY','CABLE LATTICE','ROOFLINE'].forEach((n,i)=>{L.push({name:n,flow:i+1,clean:i!==2,micro:false}); for(let k=0;k<5;k++) L.push({name:n+' '+(k+1)+'/5',flow:1,clean:true,micro:true});}); o.ui.showSummary('cut',{type:'cut',total:468200,stars:3,pace:1.31,how:'hover',cleanTake:true,stats:{maxSpeed:11.2,time:236,maxFlow:6,lines:L,clean:6,scrapes:0,cleanTake:true}});})()", 3)
            await b.close()
            if a.thumb: await thumb_shot(p, a, port, errs)
            print('--- console errors ---'); print('\n'.join(errs) if errs else 'none')
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN); srv.shutdown()
    json.dump(rep, open(os.path.join(a.out, 'hud-luma.json'), 'w'), indent=1)
    # [P6-F] the gates
    sp, cp = rep.get('spawn', {}), rep.get('caption', {})
    if sp.get('_near4') is not None: print(f"GATE spawn: rays within 4 m {sp.get('_near4')} (<= 0.05, no near blob): {'PASS' if sp['_near4'] <= 0.05 else 'FAIL'}")
    ed = rep.get('end', {})
    if 'end' in rep: print(f"end card stars row: {ed.get('_stars')}")
    if a.thumb and os.path.exists(a.thumb): print(f"thumb still edge energy {edge_energy(a.thumb)} (mean |Laplacian|, full frame)")
    print(f"GATE spawn frame p50 {sp.get('_frameP50')} (>= 40): {'PASS' if (sp.get('_frameP50') or 0) >= 40 else 'FAIL'}")
    print(f"GATE spawn labels {sp.get('_labels')} (one per line): {'PASS' if len(set(x.rsplit(' ', 1)[0] for x in sp.get('_labels') or [])) == len(sp.get('_labels') or []) else 'FAIL'}")
    pz = rep.get('pause', {}).get('_underBar')
    print(f"GATE pause: text under the RESUME bar {pz} (none): {'PASS' if pz == [] else 'FAIL'}")
    p80, pop = (cp.get('_p80') or {}).get('pop'), cp.get('_pop')
    print(f"GATE caption shown {pop}, luma p80 under #pop {p80} (<= 0.35, or plated): {'PASS' if pop and (pop.get('opacity') or 0) >= 0.5 and ((p80 is not None and p80 <= 0.35) or pop.get('plate')) else 'FAIL'}")

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--dir', required=True); ap.add_argument('--size', default='844x390'); ap.add_argument('--quality', default='low'); ap.add_argument('--out', required=True)
    ap.add_argument('--only', default=''); ap.add_argument('--thumb', default=''); ap.add_argument('--ss', type=float, default=2.0); ap.add_argument('--need-gb', type=float, default=3.0); ap.add_argument('--wait-mem', type=float, default=1800)
    asyncio.run(main(ap.parse_args()))
