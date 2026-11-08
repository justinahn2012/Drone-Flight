// graffiti-worker.js: draws the graffiti atlas off the main thread (round 5, P5; perf #1). world-bando.js starts it
// at the top of buildBando and uploads the returned pixels in strips. Pure JS (graffiti.js + raster2d.js): no
// three.js, no import map needed inside the worker.
import { graffitiPixels } from './graffiti.js';

self.onmessage = (e) => {
  const { seed = 1402, flip = true } = e.data || {};
  const t0 = performance.now();
  const g = graffitiPixels(seed, flip);
  self.postMessage({ data: g.data, width: g.width, height: g.height, ms: Math.round(performance.now() - t0) }, [g.data.buffer]);
};
