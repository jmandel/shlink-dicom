#!/usr/bin/env node
// Regression check: a --quick run (native and Node, simd build) compared with a stored quick
// baseline. Any case whose median is more than 5% slower is timed again on its own; the ones
// that are still more than 5% slower are reported, and the check exits 1.
//
//   node codecs/bench/check.mjs --save            # store a quick run as results/baseline-quick.json
//   node codecs/bench/check.mjs                   # later: compare a quick run with it
//   node codecs/bench/check.mjs --format jpeg-dct # extra arguments go to run.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH = fileURLToPath(new URL(".", import.meta.url));
const BASE = join(BENCH, "results", "baseline-quick.json");
const LATEST = join(BENCH, "results", "latest.json");
const LIMIT = 1.05;
const args = process.argv.slice(2);
const save = args.includes("--save");
const extra = args.filter((x) => x !== "--save");

function quick(more, label) {
  // run.mjs exits 1 when a result fails to verify; that stops the check too.
  execFileSync("node", [join(BENCH, "run.mjs"), "--quick", "--label", label, "--baseline", join(BENCH, "results", "none.json"), ...more], { stdio: ["ignore", "ignore", "inherit"] });
  return JSON.parse(readFileSync(LATEST, "utf8"));
}

const key = (r) => `${r.case}|${r.runner}|${r.build}`;
const medians = (res) => new Map(res.records.filter((r) => r.status === 0 && r.stats).map((r) => [key(r), r.stats.total.median]));

if (save) {
  quick(extra, "baseline-quick");
  copyFileSync(LATEST, BASE);
  console.log(`baseline stored: ${BASE}`);
  process.exit(0);
}
if (!existsSync(BASE)) {
  console.error(`no baseline: run node codecs/bench/check.mjs --save on the build to compare against`);
  process.exit(2);
}
const base = medians(JSON.parse(readFileSync(BASE, "utf8")));
const now = medians(quick(extra, "check"));
const slow = [...now].filter(([k, ms]) => base.has(k) && ms > base.get(k) * LIMIT);
// Time each slower case again, alone, and keep it only if it is still slower.
const confirmed = [];
for (const [k] of slow) {
  const [c, runner] = k.split("|");
  const again = medians(quick(["--case", c, "--runners", runner], "check-again")).get(k);
  if (again !== undefined && again > base.get(k) * LIMIT) confirmed.push([k, base.get(k), again]);
}
const compared = [...now.keys()].filter((k) => base.has(k)).length;
console.log(`${compared} results compared with ${BASE}; ${slow.length} more than 5% slower at first, ${confirmed.length} still slower when timed again`);
for (const [k, b, n] of confirmed) console.log(`  SLOWER ${k.replaceAll("|", " ")}: ${b.toFixed(3)} -> ${n.toFixed(3)} ms (+${((n / b - 1) * 100).toFixed(0)}%)`);
process.exit(confirmed.length ? 1 : 0);
