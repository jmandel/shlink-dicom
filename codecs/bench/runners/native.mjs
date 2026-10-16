// Native runner: one bench-native process decodes every case; outputs are verified here.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { binDir } from "../lib/build.mjs";
import { verifyOutput } from "../lib/verify.mjs";

// glibc returns large freed blocks to the OS, so every run would page-fault its output buffer
// in again (RLE 512²: 1.0 ms instead of 0.2 ms). wasm keeps its linear memory, so for a like-for-like
// codec comparison native keeps freed memory too.
export const NATIVE_MALLOC = "glibc.malloc.mmap_threshold=33554432:glibc.malloc.trim_threshold=4294967295";

// The decoder runs the frames of a multi-frame file on several threads. On Linux the process is
// pinned to one CPU (the last), which leaves it one thread, so every case is a single-core time.
function command(bin, args) {
  if (process.platform !== "linux") return [bin, args];
  return ["taskset", ["-c", String(cpus().length - 1), bin, ...args]];
}

export async function runNative(cases, opts, log = console.error) {
  // Decoded outputs go next to the run's binaries (or under BENCH_TMP), not to the system temp
  // directory, which may be a small tmpfs.
  const dir = mkdtempSync(join(process.env.BENCH_TMP || binDir(), "dump-"));
  const records = [];
  try {
    for (const c of cases) {
      const args = ["--warmup", opts.warmup, "--min-runs", opts.min_runs, "--max-runs", opts.max_runs, "--budget-ms", opts.budget_ms, "--dump", dir, c.sample].map(String);
      const [cmd, argv] = command(join(binDir(), "bench-native"), args);
      const line = execFileSync(cmd, argv, { maxBuffer: 1 << 26, env: { ...process.env, GLIBC_TUNABLES: NATIVE_MALLOC } }).toString().trim();
      const r = JSON.parse(line);
      const rec = { case: c.id, runner: "native", build: "native", status: r.status };
      if (r.status !== 0) { rec.msg = r.msg; records.push(rec); log(`  native ${c.id}: exit ${r.status} ${r.msg}`); continue; }
      const out = readFileSync(r.dump);
      rec.verify = verifyOutput(new Uint8Array(out.buffer, out.byteOffset, out.byteLength), readFileSync(c.oracle), c.max_abs);
      if (!r.consistent) Object.assign(rec.verify, { ok: false, reason: "output changed between runs" });
      rmSync(r.dump);
      Object.assign(rec, { cold_ms: r.cold, n: r.runs.length, runs: r.runs, hash: r.hash });
      records.push(rec);
      log(`  native ${c.id.padEnd(70)} ${median(r.runs).toFixed(2).padStart(9)} ms ${rec.verify.ok ? "" : "VERIFY FAILED " + rec.verify.reason}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return records;
}

function median(runs) {
  const xs = runs.map((r) => r[0]).sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
}
