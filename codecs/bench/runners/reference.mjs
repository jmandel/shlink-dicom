// Reference C/C++ libraries (reference/ref_bench.py), run through uv in the corpus environment.
// One process per case: some libraries abort the process on files they reject (GDCM throws an
// uncaught C++ exception on some SEG files), and that must not lose the other cases.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { BENCH, REPO } from "../lib/corpus.mjs";

export const REF_CMD = ["uv", "run", "--quiet", "--project", "codec-corpus", "--with", "pillow", "--with", "imagecodecs", "python", join(BENCH, "reference", "ref_bench.py")];

function runOne(c, log) {
  return new Promise((resolve) => {
    const p = spawn(REF_CMD[0], [...REF_CMD.slice(1), "--ids", c.id], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    const records = [];
    let buf = "", err = "";
    p.stderr.on("data", (d) => (err += d));
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        records.push(r);
        log(`  ref ${r.build.padEnd(28)} ${r.case.padEnd(70)} ${r.status === 0 ? r.stats.total.median.toFixed(2).padStart(9) + " ms" + (r.cpu_over_wall > 1.3 ? ` (threads: cpu/wall ${r.cpu_over_wall})` : "") : r.msg}`);
      }
    });
    p.on("close", (code, signal) => {
      if (code !== 0) {
        const why = `ref_bench.py ${signal ?? "exit " + code} after ${records.length} librar${records.length === 1 ? "y" : "ies"}: ${err.trim().split("\n").slice(-2).join(" ").slice(0, 200)}`;
        log(`  ref ${c.id}: ${why}`);
        records.push({ case: c.id, runner: "ref", build: "(crashed)", status: -1, msg: why });
      }
      resolve(records);
    });
  });
}

export async function runReference(cases, log = console.error) {
  const records = [];
  for (const c of cases) if (c.fmt !== "uncompressed") records.push(...(await runOne(c, log)));
  return records;
}
