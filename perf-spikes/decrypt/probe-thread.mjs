// Does crypto.subtle.decrypt leave the calling thread free? Counts MessageChannel pings that run
// on the page main thread during one 64 MiB call and during 800 record-sized calls (K=16).
// Run: node perf-spikes/decrypt/probe-thread.mjs
import { createRequire } from "node:module";
const require = createRequire("/home/jmandel/hobby/shlink-dicom/package.json");
const { chromium } = require("playwright-core");
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
const p = await b.newPage();
await p.route("http://localhost:9/", (r) => r.fulfill({ body: "<p>x", contentType: "text/html" })); await p.goto("http://localhost:9/");
console.log(await p.evaluate(async () => {
  const vis = document.visibilityState;
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt", "decrypt"]);
  const iv = new Uint8Array(12);
  const big = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array(64 << 20)));
  const rec = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array(65520)));
  const res = { visibility: vis };
  for (const mode of ["one 64MiB call", "800 records K=16"]) {
    const ch = new MessageChannel(); let ticks = 0, run = true, last = performance.now(), gap = 0;
    ch.port1.onmessage = () => { const t = performance.now(); gap = Math.max(gap, t - last); last = t; ticks++; if (run) ch.port2.postMessage(0); };
    ch.port2.postMessage(0);
    await new Promise((r) => setTimeout(r, 10));
    const pre = ticks; const t0 = performance.now(); ticks = 0; gap = 0; last = t0;
    if (mode.startsWith("one")) await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, big);
    else { let n = 0; await Promise.all(Array.from({ length: 16 }, async () => { while (n++ < 800) await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, rec); })); }
    res[mode] = { pre, ms: performance.now() - t0, ticks, maxGapMs: gap }; run = false;
  }
  return res;
}));
await b.close();
