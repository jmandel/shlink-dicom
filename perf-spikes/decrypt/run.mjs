// Runs the decrypt benchmark: native Rust, then headless Chromium (main thread, a dedicated
// worker, and pools of workers). Writes results/latest.json and prints a table.
//
//   ./build.sh && node run.mjs                 # everything
//   node run.mjs --quick                       # 1 MB and 50 MB only, no pools
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, loadavg } from "node:os";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";

const here = new URL(".", import.meta.url).pathname;
const require = createRequire(join(here, "../../package.json"));
const { chromium } = require("playwright-core");
const quick = process.argv.includes("--quick");

const SIZES = [
  { label: "1 MB", records: 16 },
  { label: "50 MB", records: 763 },
  { label: "400 MB", records: 6104 },
].slice(0, quick ? 2 : 3);
const BUILDS = ["wasm-base", "wasm-simd", "wasm-base-opt", "wasm-simd-opt"];

// ---- native
const native = {};
for (const [k, bin] of [["native (AES-NI + PCLMULQDQ)", "target/release/bench-native"], ["native (software AES, forced)", "target/soft/release/bench-native"]]) {
  const txt = execFileSync(join(here, "rust", bin), SIZES.map((s) => String(Math.round((s.records * 65536) / 1e6)))).toString();
  native[k] = txt.trim().split("\n").map((l) => JSON.parse(l));
}

// ---- server (cross-origin isolated, for 5 µs timers)
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".bin": "application/octet-stream" };
const server = createServer((req, res) => {
  const p = normalize(join(here, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  if (!p.startsWith(here)) return res.writeHead(403).end();
  try { if (!statSync(p).isFile()) throw 0; } catch { return res.writeHead(404).end(); }
  res.writeHead(200, {
    "content-type": types[extname(p)] ?? "application/octet-stream",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cache-control": "no-store",
  });
  createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/bench/page.html`;

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--js-flags=--max-old-space-size=8192"] });
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e));
page.setDefaultTimeout(0);
await page.goto(url);
await page.waitForFunction(() => window.ready === true);
const isolated = await page.evaluate(() => crossOriginIsolated);
const ua = await page.evaluate(() => navigator.userAgent);

const cfg = { builds: BUILDS, sizes: SIZES };
console.log("worker context…");
const worker = await page.evaluate((c) => window.runWorker(c), cfg);
console.log("main-thread context…");
const main = await page.evaluate((c) => window.runMain(c), cfg);
console.log("main-thread responsiveness…");
const jank = await page.evaluate(() => window.runJank());
let pools = [];
if (!quick) {
  console.log("worker pools…");
  pools = await page.evaluate(
    (sizes) => window.runPool({ paths: ["webcrypto", "wasm-simd-opt"], workerCounts: [1, 2, 4, 6, 12], sizes, K: 16 }),
    SIZES.slice(1),
  );
}
await browser.close();
server.close();

const result = {
  date: new Date().toISOString(),
  cpu: cpus()[0].model, logicalCpus: cpus().length, loadavg: loadavg(),
  chromium: ua, crossOriginIsolated: isolated,
  note: "MB/s = ciphertext bytes / 1e6 / seconds; median of runs. Each wasm call copies records in (1 MiB batches) and plaintext out; WebCrypto copies each result into one output buffer.",
  native, worker, main, pools, jank,
};
mkdirSync(join(here, "results"), { recursive: true });
const stamp = result.date.replace(/[:T]/g, "-").slice(0, 19);
writeFileSync(join(here, "results", `${stamp}${quick ? "-quick" : ""}.json`), JSON.stringify(result, null, 2));
writeFileSync(join(here, "results", "latest.json"), JSON.stringify(result, null, 2));

// ---- print
const bad = [...worker.correctness, ...main.correctness].filter((c) => !c.ok);
console.log(`\ncorrectness: ${bad.length ? "FAILED " + JSON.stringify(bad, null, 1) : "all paths pass in worker and main thread"} (${worker.correctness.length} paths × ${worker.correctness[0].results.length} checks)`);
const sizeLabels = SIZES.map((s) => s.label);
const row = (name, cells) => console.log(name.padEnd(42) + cells.map((c) => (c == null ? "—" : c.toFixed(0)).padStart(10)).join(""));
console.log("\nMB/s".padEnd(42) + sizeLabels.map((s) => s.padStart(10)).join(""));
for (const [k, v] of Object.entries(native)) {
  row(`${k} tuned`, v.map((x) => x.tuned_MBps));
  row(`${k} as-is`, v.map((x) => x.asis_MBps));
}
for (const [ctx, r] of [["worker", worker], ["main", main]]) {
  const paths = [...new Set(r.timings.map((t) => t.path))];
  for (const p of paths) row(`${ctx}: ${p}`, sizeLabels.map((s) => r.timings.find((t) => t.path === p && t.size === s)?.MBps));
}
for (const p of [...new Set(pools.map((t) => t.path))]) row(`main: ${p}`, sizeLabels.map((s) => pools.find((t) => t.path === p && t.size === s)?.MBps));
console.log("\nmain-thread longest event-loop gap while decrypting 50 MB:", JSON.stringify(jank));
console.log("\nWebCrypto call cost:", JSON.stringify({ worker: worker.overhead, main: main.overhead }));
if (bad.length) process.exit(1);
