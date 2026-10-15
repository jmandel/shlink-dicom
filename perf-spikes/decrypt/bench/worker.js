// Dedicated worker: runs the whole per-context benchmark, or acts as one member of a pool.
import * as B from "./bench.js";

let pool = null;
onmessage = async ({ data }) => {
  try {
    if (data.cmd === "context") {
      postMessage({ ok: true, result: await B.runContext(data.cfg) });
    } else if (data.cmd === "pool-init") {
      const raw = new Uint8Array(data.raw);
      let fn;
      if (data.path.startsWith("webcrypto")) fn = B.wcInFlight(await B.importKey(raw), data.K);
      else fn = B.wasmTuned(await B.loadWasm(data.path), raw);
      pool = { fn, ct: new Uint8Array(data.ct), first: data.first };
      await fn(pool.ct.subarray(0, Math.min(pool.ct.length, 4 * B.RC)), pool.first); // warm-up
      postMessage({ ok: true });
    } else if (data.cmd === "pool-run") {
      const t0 = performance.now();
      const pt = await pool.fn(pool.ct, pool.first);
      postMessage({ ok: true, ms: performance.now() - t0, n: pt.length });
    }
  } catch (e) {
    postMessage({ ok: false, error: String(e && e.stack || e) });
  }
};
