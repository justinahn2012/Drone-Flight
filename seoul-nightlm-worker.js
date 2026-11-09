// seoul-nightlm-worker.js: bakes Neon Seoul's night lightmap off the main thread (P3 stream D, lighting #3).
// seoul-light.js posts the job (see seoul-nightlm.js bakeLM) and uploads the maps it gets back.
import { bakeLM } from './seoul-nightlm.js';
self.onmessage = (ev) => {
  const r = bakeLM(ev.data);
  self.postMessage(r, [r.atlas.buffer]);
};
