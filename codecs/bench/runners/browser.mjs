// Headless Chromium runner (playwright-core). Each build runs in a fresh dedicated Web Worker
// ("chromium-worker"); "chromium-main" runs the same loop on the page's main thread.
import { chromium } from "playwright-core";
import { serve } from "../lib/server.mjs";

export const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
export const CHROMIUM_ARGS = ["--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--enable-precise-memory-info"];

export async function withPage(fn, throttle = 1) {
  const { server, origin } = await serve();
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: CHROMIUM_ARGS });
  try {
    const page = await browser.newPage();
    if (throttle > 1) {
      // Reaches the page's main thread (chromium-main) only; dedicated workers run unthrottled.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${origin}/bench/web/index.html`);
    await page.waitForFunction(() => window.benchReady === true, null, { timeout: 15000 }).catch(() => {
      throw new Error(`bench page did not load: ${errors.join("; ") || "no page error reported"}`);
    });
    return await fn(page, browser);
  } finally {
    await browser.close();
    server.close();
  }
}

/** jobs: [{mode: "worker"|"main", builds: [..], cwasm?: bool}]; builds in a job are interleaved per
 *  case. With cwasm, the C/C++ codecs compiled to wasm (web/cwasm.mjs) run on each case right after
 *  our builds, in the same worker. */
export async function runBrowser(cases, jobs, opts, log = console.error, throttle = 1) {
  const records = [];
  let env = {};
  await withPage(async (page, browser) => {
    env = { chromium: browser.version(), args: CHROMIUM_ARGS, cpu_throttle: throttle };
    page.on("console", (m) => {
      const t = m.text();
      if (!t.startsWith("bench-progress ")) return;
      const p = JSON.parse(t.slice(15));
      log(`  chromium ${p.build.padEnd(18)} ${p.case.padEnd(70)} ${p.status === 0 ? (p.verify ? "ok" : "VERIFY FAILED") : "exit " + p.status}`);
    });
    page.setDefaultTimeout(0);
    for (const job of jobs) {
      log(`chromium-${job.mode} ${job.builds.join(",")}`);
      const config = {
        builds: job.builds, opts, marks: false, cwasm: !!job.cwasm,
        cases: cases.map(({ id, fmt, corpusId, max_abs, rows, columns, frames, spp, bits_allocated, bits_stored, signed }) =>
          ({ id, fmt, corpusId, max_abs, rows, columns, frames, spp, bits_allocated, bits_stored, signed })),
      };
      const res = await page.evaluate(([cfg, mode]) => window.benchRun(cfg, mode), [config, job.mode]);
      env.timer_resolution_ms = res.timer_resolution_ms;
      env.cross_origin_isolated = res.isolated;
      for (const { cwasm, ...r } of res.records) records.push({ ...r, runner: cwasm ? "chromium-cwasm" : `chromium-${job.mode}` });
    }
  }, throttle);
  return { records, env };
}
