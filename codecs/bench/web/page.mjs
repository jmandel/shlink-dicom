import { runCases, timerResolution } from "./bench-core.mjs";

const log = (rec) => console.log(`bench-progress ${JSON.stringify({ case: rec.case, build: rec.build, status: rec.status, verify: rec.verify?.ok })}`);

/** mode "worker": one dedicated worker per call, so the page's main thread does not interfere. */
window.benchRun = async (config, mode = "worker") => {
  if (mode === "main") {
    const records = await runCases(config, log);
    return { records, timer_resolution_ms: timerResolution(), isolated: self.crossOriginIsolated };
  }
  const w = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
  try {
    return await new Promise((resolve, reject) => {
      w.onmessage = (ev) => {
        if (ev.data.type === "progress") log(ev.data.rec);
        else if (ev.data.type === "done") resolve(ev.data);
        else reject(new Error(ev.data.message));
      };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage(config);
    });
  } finally {
    w.terminate();
  }
};
window.benchReady = true;
