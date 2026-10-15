// Machine, toolchain and source state recorded with every results file. Node only.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import { join, relative } from "node:path";
import { CODECS, REPO } from "./corpus.mjs";

const sh = (cmd, cwd = REPO) => {
  try { return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; }
};

/** sha256 over every .rs and Cargo.toml under codecs/ (not target/): identifies the decoder source. */
export function sourceFingerprint() {
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === "target" || n === "node_modules" || n.startsWith(".") || n === "bench") continue;
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (n.endsWith(".rs") || n === "Cargo.toml" || n === "Cargo.lock") files.push(p);
    }
  };
  walk(CODECS);
  files.sort();
  const h = createHash("sha256");
  for (const f of files) h.update(relative(CODECS, f)).update("\0").update(readFileSync(f)).update("\0");
  return { sha256: h.digest("hex").slice(0, 16), files: files.length };
}

export function machine() {
  const cpus = os.cpus();
  return {
    host: os.hostname(), cpu: cpus[0]?.model, logical_cpus: cpus.length, memory_gb: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()}`, arch: os.arch(),
    governor: sh("cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
    load_avg_1m: os.loadavg()[0],
  };
}

export function gitState() {
  return {
    head: sh("git rev-parse --short HEAD"),
    branch: sh("git rev-parse --abbrev-ref HEAD"),
    dirty_files: Number(sh("git status --porcelain | wc -l") ?? 0),
    codecs_tracked: sh("git ls-files codecs | head -1") ? true : false,
    codecs_source: sourceFingerprint(),
  };
}

export function toolchain() {
  return {
    node: process.version,
    rustc: sh(`${process.env.HOME}/.cargo/bin/rustc +stable --version`),
    chromium: sh("/usr/bin/chromium --version"),
    python_refs: null,
  };
}
