#!/usr/bin/env python3
"""tools/seoul-hudsnap.py (P5-F ui #3): seoulsnap --hud: page screenshots WITH the DOM HUD at the phone size, quality low (the phone preset).
Shots: spawn (READY tag + first toast), caption (a FAST street caption mid-street), pause (menu), end (CUT card).
For each OSD readout it also grabs the world-only canvas and reports the share of pixels > 0.6 luma under the readout.
Same lock / serving as /home/claude/scripts/seoulsnap.py (imported).
[P6-F] ui #2: the caption shot starts the take (a 'start' event, state 'live') before its line event (phase 5 fired it while
the take was 'ready', so the shot had no caption), and reports the luma p80 under the caption (#pop) and #live (gate <= 0.35, else the caption
needs a plate); ui #1: the spawn shot reports the frame's luma p50 (8-bit codes, gate >= 40) and the bracket labels on screen
(one at 'ready')."""
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

async def main(a):
    w, h = map(int, a.size.split('x')); os.makedirs(a.out, exist_ok=True)
    srv, port = S.serve(os.path.abspath(a.dir))
    lock = open('/tmp/onetake-browser.lock', 'w'); t_wait = time.time(); fcntl.flock(lock, fcntl.LOCK_EX)
    print(f'browser lock acquired after {time.time() - t_wait:.0f}s', flush=True)
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
            async def shot(name, setup, frames=8):
                await pg.evaluate(setup)
                d = None
                for i in range(frames):
                    d = await pg.evaluate(f"window.__onetake.step(33,1,{'true' if i == frames - 1 else 'false'})"); await pg.wait_for_timeout(30)
                world = Image.open(io.BytesIO(base64.b64decode(d.split(',')[1])))
                f = os.path.join(a.out, f'hud-{name}.png'); await pg.screenshot(path=f)
                ro = await pg.evaluate(READOUTS)
                rep[name] = {k: round(luma_share(world, bx, w, h), 3) for k, bx in ro.items()}
                rep[name]['_p80'] = {k: luma_p(world, bx, w, h) for k, bx in ro.items() if k in ('live', 'pop', 'toast')}
                rep[name]['_frameP50'] = frame_p50(world)
                rep[name]['_labels'] = await pg.evaluate("[...document.querySelectorAll('#osd .brl.on')].map((e) => e.textContent)")
                rep[name]['_pop'] = await pg.evaluate("(()=>{const e=document.getElementById('pop'); return e && e.classList.contains('show') ? {text: e.textContent.replace(/\\s+/g,' ').trim().slice(0,90), plate: e.classList.contains('plate')} : null})()")
                print(f'shot {name} -> {f}  luma>0.6 under readouts: {rep[name]}', flush=True)
            # 1. spawn: the take start, READY + its hint, the first toast
            await shot('spawn', "(()=>{const o=window.__onetake; o.respawn(true); o.ui.toast((o.world.takeStart?.hint?.text||'').toUpperCase(), 6);})()")
            # 2. a FAST street caption mid-street (the walking street's 4/7 gate, flying SE)
            await shot('caption', "(()=>{const o=window.__onetake; const L=o.world.lines.find(l=>l.name==='WALKING STREET 4/7'); const p=L.pre[0].c, n=L.n; o.tp(p[0]-n[0]*4,3.4,p[2]-n[2]*4,Math.atan2(-n[0],-n[2])*180/Math.PI,0); o.take.reset(); for (const e of o.take.update(0.01,o.drone,o.world,{hands:true,moved:true,steer:false})) o.ui.onTakeEvent(e); o.ui.onTakeEvent({type:'line',name:'WALKING STREET',caption:'THE WALKING *STREET*!',pts:58836,flow:2,clean:true,micro:false,dur:31.2,best:33.5,newBest:false,par:34.4,speed:1.9,fast:true,t0:1,ago:31,t:32});})()", 6)
            # 3. pause
            await shot('pause', "(()=>{window.__onetake.ui.openMenu();})()", 3)
            # 4. the CUT card of a careful long take
            await shot('end', "(()=>{const o=window.__onetake; const m=document.getElementById('menu'); if(m) m.classList.add('hidden'); const L=[]; ['UNDER THE STAGE','WALKING STREET','HONGIK-RO','BAR ALLEY','CABLE LATTICE','ROOFLINE'].forEach((n,i)=>{L.push({name:n,flow:i+1,clean:i!==2,micro:false}); for(let k=0;k<5;k++) L.push({name:n+' '+(k+1)+'/5',flow:1,clean:true,micro:true});}); o.ui.showSummary('cut',{type:'cut',total:162400,stars:2,pace:1.24,how:'hover',stats:{maxSpeed:9.4,time:212,maxFlow:6,lines:L,clean:5,scrapes:1}});})()", 3)
            await b.close()
            print('--- console errors ---'); print('\n'.join(errs) if errs else 'none')
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN); srv.shutdown()
    json.dump(rep, open(os.path.join(a.out, 'hud-luma.json'), 'w'), indent=1)
    # [P6-F] the gates
    sp, cp = rep.get('spawn', {}), rep.get('caption', {})
    print(f"GATE spawn frame p50 {sp.get('_frameP50')} (>= 40): {'PASS' if (sp.get('_frameP50') or 0) >= 40 else 'FAIL'}")
    print(f"GATE spawn labels {sp.get('_labels')} (one per line): {'PASS' if len(set(x.rsplit(' ', 1)[0] for x in sp.get('_labels') or [])) == len(sp.get('_labels') or []) else 'FAIL'}")
    p80, pop = (cp.get('_p80') or {}).get('pop'), cp.get('_pop')
    print(f"GATE caption shown {pop}, luma p80 under #pop {p80} (<= 0.35, or plated): {'PASS' if pop and ((p80 is not None and p80 <= 0.35) or pop.get('plate')) else 'FAIL'}")

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--dir', required=True); ap.add_argument('--size', default='844x390'); ap.add_argument('--quality', default='low'); ap.add_argument('--out', required=True)
    asyncio.run(main(ap.parse_args()))
