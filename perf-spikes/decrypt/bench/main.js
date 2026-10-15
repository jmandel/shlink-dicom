import * as B from "./bench.js";

const call = (w, msg, transfer = []) =>
  new Promise((res, rej) => {
    w.onmessage = ({ data }) => (data.ok ? res(data) : rej(new Error(data.error)));
    w.onerror = (e) => rej(new Error(e.message));
    w.postMessage(msg, transfer);
  });

window.runMain = (cfg) => B.runContext(cfg);

window.runWorker = async (cfg) => {
  const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  try { return (await call(w, { cmd: "context", cfg })).result; } finally { w.terminate(); }
};

/** W workers each decrypt a contiguous share of the records; wall time from "run" to the last "done". */
window.runPool = async ({ paths, workerCounts, sizes, K = 16 }) => {
  const raw = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i);
  const maxRecords = Math.max(...sizes.map((s) => s.records));
  const all = await B.makeCiphertext(maxRecords, raw);
  const out = [];
  for (const path of paths) for (const s of sizes) for (const W of workerCounts) {
    const workers = Array.from({ length: W }, () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }));
    const per = Math.ceil(s.records / W);
    await Promise.all(workers.map((w, j) => {
      const a = Math.min(s.records, j * per), b = Math.min(s.records, (j + 1) * per);
      const share = all.slice(a * B.RC, b * B.RC);
      return call(w, { cmd: "pool-init", path, K, raw: raw.buffer.slice(0), ct: share.buffer, first: a }, [share.buffer]);
    }));
    const times = [];
    const reps = B.repsFor(s.records * B.RC);
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now();
      await Promise.all(workers.map((w) => call(w, { cmd: "pool-run" })));
      times.push(performance.now() - t0);
    }
    workers.forEach((w) => w.terminate());
    times.sort((a, b) => a - b);
    const ms = times[times.length >> 1];
    out.push({ path: `${path}${path.startsWith("webcrypto") ? ` K=${K}` : " tuned"} × ${W} workers`, size: s.label, workers: W, bytes: s.records * B.RC, ms, MBps: (s.records * B.RC) / 1e6 / (ms / 1000), runs: reps });
  }
  return out;
};

window.ready = true;

window.runJank = async () => {
  const raw = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i);
  const ct = await B.makeCiphertext(763, raw);
  const key = await B.importKey(raw);
  const ex = await B.loadWasm("wasm-simd-opt");
  const out = {};
  for (const [name, fn] of [["webcrypto sequential", B.wcSequential(key)], ["webcrypto K=16", B.wcInFlight(key, 16)], ["wasm-simd-opt tuned", B.wasmTuned(ex, raw)]]) {
    await fn(ct.subarray(0, 4 * B.RC), 0);
    out[name] = await B.probeJank(fn, ct);
  }
  return out;
};
