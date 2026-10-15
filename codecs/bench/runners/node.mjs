// Node runner: the wasm builds in V8, in-process. Quick to iterate with; the browser runner is
// the number that matters for users. Builds are interleaved per case, as in the browser runner.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { binDir } from "../lib/build.mjs";
import { instantiate, measure } from "../lib/wasm.mjs";

export async function runNode(cases, builds, opts, log = console.error) {
  const modules = Object.fromEntries(await Promise.all(builds.map(async (b) => [b, await WebAssembly.compile(readFileSync(join(binDir(), `${b}.wasm`)))])));
  const records = [];
  for (const [i, c] of cases.entries()) {
    const file = readFileSync(c.sample), npy = readFileSync(c.oracle);
    for (const build of builds.map((_, k) => builds[(k + i) % builds.length])) {
      const dec = await instantiate(modules[build]);
      const r = measure(dec, file, npy, { ...opts, maxAbs: c.max_abs });
      records.push({ case: c.id, runner: "node", build, ...r });
      log(`  node ${build.padEnd(12)} ${c.id.padEnd(70)} ${r.status === 0 ? med(r.runs).toFixed(2).padStart(9) + " ms" : "exit " + r.status + " " + r.msg} ${r.verify && !r.verify.ok ? "VERIFY FAILED " + r.verify.reason : ""}`);
    }
  }
  return records;
}

const med = (runs) => runs.map((r) => r[0]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
