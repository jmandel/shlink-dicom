#!/usr/bin/env node
// Build, run every runner, write results/<run>.json, report.html and a terminal summary.
//
//   node codecs/bench/run.mjs                         everything (about 15-25 minutes)
//   node codecs/bench/run.mjs --format jpeg-dct       one format
//   node codecs/bench/run.mjs --quick --format jpeg-dct   native + node, simd build only
//   node codecs/bench/run.mjs --help
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BUILDS, removeSnapshot, snapshotBuilds } from "./lib/build.mjs";
import { BENCH, loadManifest, megapixels, resolveCases } from "./lib/corpus.mjs";
import { gitState, machine, toolchain } from "./lib/env.mjs";
import { summarize } from "./lib/stats.mjs";
import { runBrowser } from "./runners/browser.mjs";
import { NATIVE_MALLOC, runNative } from "./runners/native.mjs";
import { runNode } from "./runners/node.mjs";
import { REF_CMD, runReference } from "./runners/reference.mjs";
import { cwasmPackages, simdInstructions } from "./lib/cwasm-info.mjs";
import { compare, findBaseline, terminalSummary, writeReport } from "./report.mjs";

const HELP = `node codecs/bench/run.mjs [options]
  --format F        only this corpus format (repeatable): uncompressed rle jpeg-dct jpeg-lossless jpeg-ls jpeg2000 htj2k
  --case S          only manifest ids containing S
  --tag T           only cases with this tag (repeatable): small medium large synthetic real colour multiframe ...
  --runners LIST    comma list of native,node,chromium-worker,chromium-cwasm,chromium-main,ref (default: all)
                    chromium-cwasm = C/C++ codecs compiled to wasm (Cornerstone packages), same worker as ours;
                    chromium-main runs wasm-simd only; ref = native C/C++ libraries from Python
  --builds LIST     wasm builds: base,simd,relaxed,base-opt,simd-opt (default all five; -opt = after wasm-opt)
  --quick           = --runners native,node --builds simd, budget 150 ms
  --no-build        use the last builds in codecs/target/bench/out
  --throttle N      slow Chromium's CPU N times (DevTools emulation, a stand-in for a slower
                    device). It reaches the page's main thread only, not dedicated workers, so
                    use it with --runners chromium-main. Browser results are then compared only
                    with runs at the same rate
  --label NAME      added to the results file name
  --baseline FILE   compare with this results file (default results/baseline.json if present)
  --fail-on-regression  exit 1 when a regression is found (verification failures always exit 1)`;

const { values: a } = parseArgs({
  options: {
    format: { type: "string", multiple: true }, case: { type: "string" }, tag: { type: "string", multiple: true },
    runners: { type: "string" }, builds: { type: "string" }, quick: { type: "boolean" }, "no-build": { type: "boolean" },
    label: { type: "string" }, throttle: { type: "string" }, baseline: { type: "string" }, "fail-on-regression": { type: "boolean" }, help: { type: "boolean" },
  },
});
if (a.help) { console.log(HELP); process.exit(0); }

const manifest = loadManifest();
const opts = { ...manifest.defaults, ...(a.quick ? { budget_ms: 150 } : {}) };
const runners = (a.runners ?? (a.quick ? "native,node" : "native,node,chromium-worker,chromium-cwasm,chromium-main,ref")).split(",");
const wasmBuilds = (a.builds ?? (a.quick ? "simd" : "base,simd,relaxed,base-opt,simd-opt")).split(",").map((b) => `wasm-${b}`);
const log = (s) => console.error(s);

const all = resolveCases(manifest, { formats: a.format, match: a.case, tags: a.tag });
const cases = all.filter((c) => !c.missing);
for (const c of all.filter((c) => c.missing)) log(`SKIP ${c.id}: ${c.missing}`);
for (const c of cases) for (const w of c.warnings) log(`WARN ${c.id}: ${w}`);
if (!cases.length) { log("no cases selected"); process.exit(2); }

const needBuilds = [...(runners.includes("native") ? ["native"] : []), ...(runners.some((r) => r === "node" || r.startsWith("chromium")) ? [...new Set([...wasmBuilds, ...(runners.includes("chromium-cwasm") ? ["wasm-simd"] : [])])] : [])];
const builds = snapshotBuilds(needBuilds, { noBuild: a["no-build"], log });
process.on("exit", removeSnapshot);
process.on("SIGINT", () => process.exit(130));

const started = new Date();
const records = [];
const env = { machine: machine(), git: gitState(), toolchain: toolchain(), native_malloc: NATIVE_MALLOC };
// Noise warnings: load average above 1.5, or another bench run on the machine.
const otherRuns = () => {
  try {
    return execSync("ps -eo pid=,args=").toString().split("\n").filter((l) => {
      const [pid, exe, ...rest] = l.trim().split(/\s+/);
      return /(^|\/)node$/.test(exe ?? "") && Number(pid) !== process.pid && rest.some((x) => /(^|\/)(run|profile)\.mjs$/.test(x) && /bench/.test(x + process.cwd()));
    }).length;
  } catch { return 0; }
};
const busy = () => {
  const l = machine().load_avg_1m, o = otherRuns();
  if (l > 1.5) log(`WARN load average ${l.toFixed(1)}: other processes are running; timings will be noisy`);
  if (o) log(`WARN ${o} other bench run(s) in progress; timings will be noisy`);
  return { load: l, other_runs: o };
};
if (a.throttle && runners.some((r) => r === "chromium-worker" || r === "chromium-cwasm")) {
  log("WARN --throttle does not reach dedicated workers: chromium-worker and chromium-cwasm run unthrottled");
}
const b0 = busy();
env.load_avg = { start: b0.load };
env.other_bench_runs = { start: b0.other_runs };
if (runners.includes("native")) { log("native"); records.push(...(await runNative(cases, opts, log))); }
if (runners.includes("node")) { log("node"); records.push(...(await runNode(cases, wasmBuilds, opts, log))); }
const jobs = [
  ...(runners.includes("chromium-worker") || runners.includes("chromium-cwasm")
    ? [{ mode: "worker", builds: runners.includes("chromium-worker") ? wasmBuilds : ["wasm-simd"], cwasm: runners.includes("chromium-cwasm") }] : []),
  ...(runners.includes("chromium-main") && wasmBuilds.includes("wasm-simd") ? [{ mode: "main", builds: ["wasm-simd"] }] : []),
];
if (runners.includes("chromium-cwasm")) env.cwasm_packages = cwasmPackages();
for (const [k, b] of Object.entries(builds)) if (b.path?.endsWith(".wasm") && needBuilds.includes(k)) b.simd_instructions = simdInstructions(b.path);
if (jobs.length) {
  const r = await runBrowser(cases, jobs, opts, log, Number(a.throttle ?? 1));
  records.push(...r.records);
  env.browser = r.env;
}
if (runners.includes("ref")) {
  log("reference libraries");
  try { records.push(...(await runReference(cases, log))); env.reference_cmd = REF_CMD.join(" "); }
  catch (e) { log(`reference run failed: ${e.message}`); }
}

const b1 = busy();
env.load_avg.end = b1.load;
env.other_bench_runs.end = b1.other_runs;
const byId = new Map(cases.map((c) => [c.id, c]));
for (const r of records) {
  const c = byId.get(r.case);
  if (r.runs) r.stats = summarize(r.runs);
  if (r.status === 0 && c) {
    r.frames = c.frames;
    r.megapixels = megapixels(c);
    r.ms_per_frame = r.stats.total.median / c.frames;
    r.mpix_per_s = r.megapixels / (r.stats.total.median / 1000);
  }
}

// wasm-opt must not change the output: each -opt build's pixels must hash the same as its source build's.
for (const r of records) {
  const from = BUILDS[r.build]?.from;
  if (!from || r.status !== 0) continue;
  const src = records.find((x) => x.case === r.case && x.runner === r.runner && x.build === from && x.status === 0);
  if (src && src.hash !== r.hash) Object.assign(r.verify, { ok: false, reason: `output differs from ${from} (hash ${r.hash} vs ${src.hash})` });
  else if (src) r.verify.same_as = from;
}
const id = started.toISOString().slice(0, 19).replace(/[:T]/g, "-") + (a.label ? `-${a.label}` : "");
const result = {
  schema: 1, id, label: a.label ?? null, started: started.toISOString(), finished: new Date().toISOString(),
  manifest_version: manifest.version, selection: { format: a.format ?? null, case: a.case ?? null, tag: a.tag ?? null },
  options: opts, runners, env,
  builds: Object.fromEntries(Object.entries(builds).filter(([k]) => needBuilds.includes(k))),
  cases: cases.map(({ id, fmt, label, tags, rows, columns, frames, spp, bits_allocated, bits_stored, signed, photometric, transfer_syntax, max_abs, size, warnings }) =>
    ({ id, fmt, label, tags, rows, columns, frames, spp, bits_allocated, bits_stored, signed, photometric, transfer_syntax, max_abs, size, warnings })),
  records,
};
mkdirSync(join(BENCH, "results"), { recursive: true });
const file = join(BENCH, "results", `${id}.json`);
writeFileSync(file, JSON.stringify(result));
writeFileSync(join(BENCH, "results", "latest.json"), JSON.stringify(result));

const baseline = findBaseline(a.baseline, result);
// Browser times at different CPU throttle rates are not comparable.
if (baseline && (baseline.env?.browser?.cpu_throttle ?? 1) !== (result.env.browser?.cpu_throttle ?? 1)) {
  baseline.records = baseline.records.filter((r) => !r.runner.startsWith("chromium"));
}
const cmp = baseline ? compare(result, baseline) : null;
const html = writeReport(result, baseline, cmp);
console.log(terminalSummary(result, baseline, cmp));
console.log(`\nresults: ${file}\nreport:  ${html}${baseline ? `\nbaseline: ${baseline.id}` : ""}`);

// Reference libraries that cannot read a case are listed in the report but do not fail the run.
const failed = records.filter((r) => r.runner !== "ref" && r.runner !== "chromium-cwasm" && (r.status !== 0 || (r.verify && !r.verify.ok)));
if (failed.length) console.log(`\n${failed.length} record(s) failed or did not verify:\n` + failed.map((r) => `  ${r.runner} ${r.build} ${r.case}: ${r.msg ?? r.verify?.reason}`).join("\n"));
process.exit(failed.length || (a["fail-on-regression"] && cmp?.regressions.length) ? 1 : 0);
