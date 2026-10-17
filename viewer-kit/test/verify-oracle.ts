// Correctness of the pool's wasm against the codec-corpus oracle (the comparison of
// codec-corpus/scripts/check.py), using the same .wasm the workers load.
//
//   bun viewer-kit/test/verify-oracle.ts [--format rle] [--case substr] [--per-format N] [--shard i/n]
//
// For each case with expect=decode: whole-file decode must match the oracle within max_abs.
// For multi-frame encapsulated cases it also decodes the frames in three ranges (the path
// DecoderPool.decodeFrames uses) and checks the joined result is byte-identical to the whole decode.
// expect=error cases must return exit 2 (exit 3 counts as unsupported, as in check.py); any
// other code is a crash. Exits 1 when a case fails or crashes.
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WasmDecoder } from "../src/wasm-decoder";
import { checkCase, loadNpy } from "./oracle-check";

const KIT = join(import.meta.dir, "..");
const FORMATS = join(KIT, "..", "codec-corpus", "formats");

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const onlyFormat = opt("--format");
const onlyCase = opt("--case");
const perFormat = opt("--per-format") ? Number(opt("--per-format")) : Infinity;
const [shard, shards] = (opt("--shard") ?? "0/1").split("/").map(Number);

const mainModule = new WebAssembly.Module(readFileSync(join(KIT, "dist", "shl_dicom_decode.wasm")));
// JPEG XL cases use the separate module the pool loads for them.
const jxlModule = new WebAssembly.Module(readFileSync(join(KIT, "dist", "shl_dicom_decode_jxl.wasm")));
let module = mainModule;
let dec = await WasmDecoder.create(module);

type Outcome = "pass" | "fail" | "unsupported" | "crash" | "skipped";
const results: { format: string; case: string; outcome: Outcome; reason?: string; ms?: number; ranges?: string }[] = [];
const formats = readdirSync(FORMATS).filter((f) => existsSync(join(FORMATS, f, "cases.json")) && (!onlyFormat || f === onlyFormat)).sort();
let idx = 0;
for (const fmt of formats) {
  const cases = (JSON.parse(readFileSync(join(FORMATS, fmt, "cases.json"), "utf8")).cases as any[])
    .filter((c) => !onlyCase || c.id.includes(onlyCase));
  // A spread sample when --per-format is given: every k-th case.
  const step = Math.max(1, Math.floor(cases.length / Math.min(perFormat, cases.length)));
  const picked = cases.filter((_, i) => i % step === 0).slice(0, perFormat);
  if ((fmt === "jpeg-xl") !== (module === jxlModule)) {
    module = fmt === "jpeg-xl" ? jxlModule : mainModule;
    dec = await WasmDecoder.create(module);
  }
  for (const c of picked) {
    if (idx++ % shards !== shard) continue;
    const src = join(FORMATS, fmt, "samples", `${c.id}.dcm`);
    const npy = join(FORMATS, fmt, "oracle", `${c.id}.npy`);
    const rec: (typeof results)[number] = { format: fmt, case: c.id, outcome: "skipped" };
    results.push(rec);
    if (!existsSync(src) || !c.expect) { rec.reason = "no sample"; continue; }
    const bytes = new Uint8Array(readFileSync(src));
    try {
      Object.assign(rec, checkCase(dec, bytes, c, existsSync(npy) ? () => loadNpy(npy) : null));
    } catch (e) {
      rec.outcome = "crash";
      rec.reason = String(e);
      dec = await WasmDecoder.create(module);
    }
  }
}

const summary: Record<string, Record<string, number>> = {};
let ranges = 0;
for (const r of results) {
  (summary[r.format] ??= {})[r.outcome] = (summary[r.format][r.outcome] ?? 0) + 1;
  if (r.ranges === "ranges-identical") ranges++;
  if (r.outcome === "fail" || r.outcome === "crash") console.log(`${r.outcome.padEnd(11)} ${r.format.padEnd(14)} ${r.case.padEnd(64)} ${r.reason ?? ""}`);
}
console.log("\nsummary (pool wasm vs codec-corpus oracle)");
for (const [f, s] of Object.entries(summary)) console.log(`  ${f.padEnd(14)} ` + Object.entries(s).sort().map(([k, v]) => `${k}=${v}`).join("  "));
console.log(`  multi-frame encapsulated cases where 3 frame ranges == whole decode: ${ranges}`);
mkdirSync(join(KIT, "test", "results"), { recursive: true });
writeFileSync(join(KIT, "test", "results", `verify-oracle-${shard}of${shards}.json`), JSON.stringify(results, null, 1));
// A failure or a crash is the exit status too, so a script or CI run cannot miss it.
if (results.some((r) => r.outcome === "fail" || r.outcome === "crash")) process.exit(1);
