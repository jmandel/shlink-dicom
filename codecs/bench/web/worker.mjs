import { runCases, timerResolution } from "./bench-core.mjs";

self.onmessage = async (ev) => {
  try {
    const records = await runCases(ev.data, (rec) => self.postMessage({ type: "progress", rec }));
    self.postMessage({ type: "done", records, timer_resolution_ms: timerResolution(), isolated: self.crossOriginIsolated });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e?.stack ?? e) });
  }
};
