// viewer-kit benchmarks in headless Chromium. Results -> bench/results/<date>.json, summary on stdout.
//
//   node viewer-kit/bench/run.mjs                 # pool + wl
//   node viewer-kit/bench/run.mjs pool            # pool scaling only
//   node viewer-kit/bench/run.mjs wl              # window/level only
//
// Needs: node viewer-kit/scripts/build.mjs, and the CT series from bench/make_series.py.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg, cpus } from "node:os";
import { join } from "node:path";
import { withHarness, CHROMIUM_ARGS } from "../scripts/browser.mjs";
import { KIT } from "../scripts/build.mjs";

const what = process.argv[2] ?? "all";
const WORKERS = [1, 2, 4, 8];
const corpus = (c) => `/corpus/${c.split("/")[0]}/samples/${c.split("/")[1]}.dcm`;
const MULTIFRAME = [
  ["jpeg2000/idc-j2kr-mono2-u10of16-mf-mg-hologicinc-0294fa98", "MG tomo 1890×2457 × 22, 16-bit, J2K lossless"],
  ["jpeg-dct/pydicom-color3d_jpeg_baseline", "US 640×480 × 120 RGB, JPEG baseline"],
  ["jpeg-lossless/ext-gdcm-GE_DLX-8-MONO2-Multiframe-Jpeg_Lossless", "XA 512² × 67, 8-bit, JPEG lossless"],
  ["jpeg2000/idc-j2k-ict-u8of8-p0-mf-sm-leicabiosy-017f7beb", "WSI tiles 256² × 888 RGB, J2K"],
];

const manifest = JSON.parse(readFileSync(join(KIT, "data", "manifest.json"), "utf8"));
const out = { date: new Date().toISOString(), cpu: cpus()[0].model, cores: cpus().length, loadStart: loadavg(), chromiumArgs: CHROMIUM_ARGS, pool: {}, multiframe: {}, wl: [] };

await withHarness(async (page, env) => {
  out.chromium = env.browserVersion;
  out.webgl = await page.evaluate(() => window.vk.webglInfo());
  if (what === "all" || what === "pool") {
    for (const [name, s] of Object.entries(manifest.series)) {
      const r = await page.evaluate((o) => window.vk.poolBench(o), { urls: s.files.map((f) => `/series/${f}`), workers: WORKERS, reps: 3, seedUrl: "/series/ct100-seed.npy" });
      out.pool[name] = r;
      console.log(`CT100 ${name.padEnd(18)} ${(r.totalBytes / 1e6).toFixed(1).padStart(5)} MB  ` + r.results.map((x) => `${x.workers}w ${x.medianMs.toFixed(0).padStart(5)} ms`).join("  ") + `  [${r.verified}]`);
    }
    for (const [c, label] of MULTIFRAME) {
      const r = await page.evaluate((o) => window.vk.poolBench(o), { urls: [corpus(c)], workers: WORKERS, reps: 3, mode: "frames" });
      out.multiframe[c] = { label, ...r };
      console.log(`MF ${label.padEnd(46)} ` + r.results.map((x) => `${x.workers}w ${x.medianMs.toFixed(0).padStart(5)} ms`).join("  "));
    }
  }
  if (what === "all" || what === "wl") {
    for (const [url, canvas] of [
      ["/series/ct100-explicit-le/050.dcm", null],
      [corpus("uncompressed/gen-bench-dx2048-u12"), null],
      [corpus("uncompressed/gen-bench-dx2048-u12"), [1920, 1080]],
    ]) {
      const r = await page.evaluate((o) => window.vk.wlBench(o), { url, frames: 120, canvas });
      out.wl.push(r);
      console.log(`W/L ${r.image} canvas ${r.canvas}: GPU submit ${r.gpu.submit.median} ms, work ${r.gpu.work.median} ms (p90 ${r.gpu.work.p90}), frame ${r.gpu.frameInterval.median} ms | CPU fallback ${r.cpuFallback.work.median} ms`);
    }
  }
});
out.loadEnd = loadavg();
console.log(`load average start ${out.loadStart.map((x) => x.toFixed(1))} end ${out.loadEnd.map((x) => x.toFixed(1))}; WebGL: ${out.webgl?.gpu}`);
mkdirSync(join(KIT, "bench", "results"), { recursive: true });
const tag = process.env.VK_ANGLE ? `-${process.env.VK_ANGLE}` : "";
const file = join(KIT, "bench", "results", `${out.date.slice(0, 19).replace(/:/g, "")}-${what}${tag}.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
writeFileSync(join(KIT, "bench", "results", `latest-${what}${tag}.json`), JSON.stringify(out, null, 1));
console.log(file);
