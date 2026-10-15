// Headless Chromium (playwright-core, /usr/bin/chromium) on the harness page.
import { chromium } from "playwright-core";
import { serve } from "./serve.mjs";

export const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
// GPU flags: without them headless Chromium may fall back to SwiftShader (software GL).
// VK_GPU=0 runs with Chromium's defaults instead.
export const CHROMIUM_ARGS = [
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--enable-precise-memory-info",
  ...(process.env.VK_GPU === "0" ? [] : ["--ignore-gpu-blocklist", "--enable-gpu", ...(process.env.VK_ANGLE ? ["--use-gl=angle", `--use-angle=${process.env.VK_ANGLE}`] : [])]),
];

export async function withHarness(fn, { page: path = "/kit/test/harness.html" } = {}) {
  const { server, origin } = await serve();
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: CHROMIUM_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("console", (m) => { if (m.type() === "error") console.error("[page]", m.text()); });
    page.on("pageerror", (e) => console.error("[page error]", e.message));
    await page.goto(origin + path);
    await page.waitForFunction(() => window.vk?.ready);
    return await fn(page, { origin, browserVersion: browser.version() });
  } finally {
    await browser.close();
    server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await withHarness(async (page, env) => {
    console.log(env.browserVersion, CHROMIUM_ARGS.join(" "));
    console.log(await page.evaluate(() => window.vk.webglInfo()));
    console.log(await page.evaluate(() => ({ isolated: crossOriginIsolated, cores: navigator.hardwareConcurrency })));
  });
}
