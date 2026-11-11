// seoul-nightlm-worker.js: bakes Neon Seoul's night lightmap off the main thread (P3 stream D, lighting #3).
// seoul-light.js posts the job (see seoul-nightlm.js bakeLM) and uploads the maps it gets back.
// P4: the texels come back packed RGB9E5 (packLM: dilated, 4 bytes each), the format the shipped file has.
import { bakeLM, packLM } from './seoul-nightlm.js';
self.onmessage = (ev) => {
  const r = bakeLM(ev.data), p = packLM(r.atlas, ev.data.plan.atlasW, ev.data.plan.atlasH);
  self.postMessage({ data: p.data, texels: r.texels, ms: r.ms }, [p.data.buffer]);
};
