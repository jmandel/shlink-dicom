#!/usr/bin/env node
// Profile one case: where does decode time go, by function?
//
//   node codecs/bench/profile.mjs <case substring> [--build wasm-simd] [--seconds 4] [--native] [--no-browser]
//
// Browser (default): decodes the case in a loop in headless Chromium with the V8 CPU profiler on
// and a DevTools trace recording. wasm function names come from the name section, which the
// bench builds keep (debug = 1). Writes, in bench/profiles/:
//   <name>.cpuprofile   open in Chrome DevTools > Performance (drag the file in) or speedscope.app
//   <name>.trace.json   open in DevTools > Performance, or ui.perfetto.dev
//   <name>.txt          self time per function and per crate, the summary below
// --native: also runs `perf record` on bench-native --loop and writes <name>-native.txt (and
//   <name>-native.svg when the `flamegraph` tool is installed).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { binDir, removeSnapshot, snapshotBuilds } from "./lib/build.mjs";
import { BENCH, loadManifest, resolveCases } from "./lib/corpus.mjs";
import { withPage } from "./runners/browser.mjs";
import { NATIVE_MALLOC } from "./runners/native.mjs";

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { build: { type: "string", default: "wasm-simd" }, seconds: { type: "string", default: "4" }, native: { type: "boolean" }, "no-browser": { type: "boolean" }, top: { type: "string", default: "25" } },
});
// Profile the last builds, from a private snapshot (another run may be rebuilding meanwhile).
snapshotBuilds([a.build, ...(a.native ? ["native"] : [])], { noBuild: true });
process.on("exit", removeSnapshot);
process.on("SIGINT", () => process.exit(130));
const [c] = resolveCases(loadManifest(), { match: positionals[0] }).filter((x) => !x.missing);
if (!c) { console.error(`no case matches ${positionals[0]}`); process.exit(2); }
const name = `${c.corpusId}-${a.build}`.replace(/[^\w.-]+/g, "_");
const dir = join(BENCH, "profiles");
const top = Number(a.top);
const secs = Number(a.seconds);

/** Group a function name into the crate it belongs to. */
function crateOf(fn) {
  const m = /^(?:<)?([a-z_][a-z0-9_]*)::/.exec(fn);
  if (m) return m[1];
  if (/^(memcpy|memset|memmove|dlmalloc|malloc|free|realloc|\(libc)/.test(fn)) return "libc/alloc";
  if (fn.startsWith("wasm-function[")) return "(unnamed wasm)";
  return fn.startsWith("(") ? fn : "other";
}

function summarize(selfMs, totalMs, title) {
  const rows = [...selfMs.entries()].sort((x, y) => y[1] - x[1]);
  const crates = new Map();
  for (const [fn, ms] of rows) crates.set(crateOf(fn), (crates.get(crateOf(fn)) ?? 0) + ms);
  const pct = (ms) => ((ms / totalMs) * 100).toFixed(1).padStart(5) + "%";
  return [
    title, "",
    "self time by crate", ...[...crates.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => `  ${pct(v)}  ${k}`), "",
    `self time by function (top ${top})`, ...rows.slice(0, top).map(([k, v]) => `  ${pct(v)}  ${k.length > 150 ? k.slice(0, 147) + "..." : k}`),
  ].join("\n");
}

if (!a["no-browser"]) {
  await withPage(async (page, browser) => {
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(async ([build, c]) => {
      const { instantiate } = await import("/bench/lib/wasm.mjs");
      const m = await WebAssembly.compileStreaming(fetch(`/wasm/${build}.wasm`));
      const bytes = new Uint8Array(await (await fetch(`/corpus/${c.fmt}/samples/${encodeURIComponent(c.corpusId)}.dcm`)).arrayBuffer());
      window.profDec = await instantiate(m);
      window.profDec.setInput(bytes);
      for (let i = 0; i < 3; i++) window.profDec.decode(); // warm up and tier up before recording
    }, [a.build, { fmt: c.fmt, corpusId: c.corpusId }]);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
    await browser.startTracing(page, { path: join(dir, `${name}.trace.json`), categories: ["devtools.timeline", "v8.execute", "blink.user_timing", "disabled-by-default-devtools.timeline", "disabled-by-default-v8.cpu_profiler"] });
    await cdp.send("Profiler.start");
    const n = await page.evaluate(async ([secs, id]) => {
      const end = performance.now() + secs * 1000;
      let n = 0;
      while (performance.now() < end) {
        const r = window.profDec.decode(false);
        const [t0, t1, t2] = r.marks;
        performance.measure(`${id} parse+split`, { start: t0, end: t1 });
        performance.measure(`${id} codec+normalise`, { start: t1, end: t2 });
        n++;
      }
      return n;
    }, [secs, c.id]);
    const { profile } = await cdp.send("Profiler.stop");
    await browser.stopTracing();
    writeFileSync(join(dir, `${name}.cpuprofile`), JSON.stringify(profile));
    // Self time per function from the sampled profile.
    const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
    const counts = new Map();
    for (const s of profile.samples) counts.set(s, (counts.get(s) ?? 0) + 1);
    const dt = (profile.endTime - profile.startTime) / 1000 / profile.samples.length;
    const self = new Map();
    let total = 0;
    for (const [id, k] of counts) {
      const fn = byId.get(id).callFrame.functionName || "(anonymous)";
      if (fn === "(idle)" || fn === "(program)" || fn === "(garbage collector)") continue;
      self.set(fn, (self.get(fn) ?? 0) + k * dt);
      total += k * dt;
    }
    const txt = summarize(self, total, `${c.id} (${c.label}) — ${a.build} in Chromium ${browser.version()}, ${n} decodes in ${secs}s (${((secs * 1000) / n).toFixed(2)} ms each), ${profile.samples.length} samples`);
    writeFileSync(join(dir, `${name}.txt`), txt + "\n");
    console.log(txt);
    console.log(`\nwrote ${join(dir, name)}.{cpuprofile,trace.json,txt}`);
  });
}

if (a.native) {
  const bin = join(binDir(), "bench-native");
  const nname = `${c.corpusId}-native`.replace(/[^\w.-]+/g, "_");
  const data = join(dir, `${nname}.perf.data`);
  const env = { ...process.env, GLIBC_TUNABLES: NATIVE_MALLOC };
  execFileSync("perf", ["record", "-F", "2999", "-g", "-o", data, "--", bin, "--loop", String(secs), c.sample], { env, stdio: ["ignore", "ignore", "inherit"] });
  const rep = execFileSync("perf", ["report", "-i", data, "--stdio", "--no-children", "--sort", "dso,symbol", "--percent-limit", "0.3", "-g", "none"], { maxBuffer: 1 << 26 }).toString();
  const self = new Map();
  for (const line of rep.split("\n")) {
    const m = /^\s+([\d.]+)%\s+(\S+)\s+\[[.k]\]\s+(.*?)[\s-]*$/.exec(line);
    if (!m) continue;
    // Stripped libraries (libc memcpy/memset) have no symbols: one bucket per library.
    const sym = /^0x[0-9a-f]+$/.test(m[3]) ? `(${m[2]})` : m[3];
    self.set(sym, (self.get(sym) ?? 0) + Number(m[1]));
  }
  const txt = summarize(self, 100, `${c.id} (${c.label}) — native (perf record, ${secs}s loop)`);
  writeFileSync(join(dir, `${nname}.txt`), txt + "\n");
  console.log("\n" + txt);
  const fg = `${process.env.HOME}/.cargo/bin/flamegraph`;
  if (existsSync(fg)) {
    const r = spawnSync(fg, ["--perfdata", data, "-o", join(dir, `${nname}.svg`)], { stdio: "ignore" });
    if (r.status === 0) console.log(`wrote ${join(dir, nname)}.svg`);
  }
  console.log(`perf data: ${data}  (perf report -i ${data})`);
}
