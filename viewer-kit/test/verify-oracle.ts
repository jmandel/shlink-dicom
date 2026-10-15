// Correctness of the pool's wasm against the codec-corpus oracle (the comparison of
// codec-corpus/scripts/check.py), using the same .wasm the workers load.
//
//   bun viewer-kit/test/verify-oracle.ts [--format rle] [--case substr] [--per-format N] [--shard i/n]
//
// For each case with expect=decode: whole-file decode must match the oracle within max_abs.
// For multi-frame encapsulated cases it also decodes the frames in three ranges (the path
// DecoderPool.decodeFrames uses) and checks the joined result is byte-identical to the whole decode.
// expect=error cases must return exit 2 (exit 3 counts as unsupported, as in check.py).
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WasmDecoder } from "../src/wasm-decoder";

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

function loadNpy(path: string): { dtype: string; shape: number[]; data: Uint8Array } {
  const b = readFileSync(path);
  const major = b[6];
  const hlen = major === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8);
  const hstart = major === 1 ? 10 : 12;
  const header = b.subarray(hstart, hstart + hlen).toString("latin1");
  const dtype = /'descr':\s*'([^']+)'/.exec(header)![1];
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header)![1].split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (/'fortran_order':\s*True/.test(header)) throw new Error("fortran order npy");
  return { dtype, shape, data: new Uint8Array(b.buffer, b.byteOffset + hstart + hlen, b.length - hstart - hlen) };
}

function typed(dtype: string, u8: Uint8Array) {
  const kind = dtype.replace(/^[<>|=]/, "");
  const ab = u8.slice().buffer;
  switch (kind) {
    case "u1": return new Uint8Array(ab);
    case "i1": return new Int8Array(ab);
    case "u2": return new Uint16Array(ab);
    case "i2": return new Int16Array(ab);
    case "u4": return new Uint32Array(ab);
    case "i4": return new Int32Array(ab);
    case "f4": return new Float32Array(ab);
    case "f8": return new Float64Array(ab);
    default: throw new Error(`dtype ${dtype}`);
  }
}

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
    let r;
    try {
      r = dec.decode(bytes);
    } catch (e) {
      rec.outcome = "crash";
      rec.reason = String(e);
      dec = await WasmDecoder.create(module);
      continue;
    }
    rec.ms = r.ms;
    if (!r.ok && r.code === 3) { rec.outcome = "unsupported"; rec.reason = r.message; continue; }
    if (c.expect === "error") {
      rec.outcome = r.ok ? "fail" : "pass";
      if (r.ok) rec.reason = "decoded a file no reference can decode";
      continue;
    }
    if (!r.ok) { rec.outcome = "fail"; rec.reason = `exit ${r.code}: ${r.message}`; continue; }
    if (!existsSync(npy)) { rec.outcome = "skipped"; rec.reason = "no oracle"; continue; }
    const o = loadNpy(npy);
    if (r.pixels.byteLength !== o.data.byteLength) {
      rec.outcome = "fail";
      rec.reason = `wrote ${r.pixels.byteLength} bytes, expected ${o.data.byteLength} (${o.dtype} ${o.shape})`;
      continue;
    }
    const a = typed(o.dtype, new Uint8Array(r.pixels)), b = typed(o.dtype, o.data);
    let maxd = 0;
    for (let i = 0; i < a.length; i++) {
      // Floats: two NaNs (or equal infinities) are equal, NaN against a number is not.
      const d = a[i] === b[i] || (Number.isNaN(a[i]) && Number.isNaN(b[i])) ? 0 : Math.abs(a[i] - b[i]) || Infinity;
      if (d > maxd) maxd = d;
    }
    const ok = maxd <= c.max_abs;
    rec.outcome = ok ? "pass" : "fail";
    if (!ok) rec.reason = `max|d|=${maxd} > ${c.max_abs}`;
    // Metadata sanity.
    const info = r.info;
    if (ok && (info.rows !== o.shape[1] || info.columns !== o.shape[2] || info.frames !== o.shape[0])) {
      rec.outcome = "fail";
      rec.reason = `metadata ${info.frames}x${info.rows}x${info.columns} vs oracle ${o.shape}`;
    }
    // Frame ranges (DecoderPool.decodeFrames) must equal the whole decode exactly.
    if (ok && info.totalFrames > 1) {
      const p = dec.probe(bytes);
      if ("frames" in p && p.encapsulated) {
        const whole = new Uint8Array(r.pixels);
        const per = Math.ceil(info.totalFrames / 3);
        let same = true;
        for (let first = 0; first < info.totalFrames; first += per) {
          const part = dec.decode(bytes, first, Math.min(per, info.totalFrames - first));
          if (!part.ok) { same = false; rec.reason = `range ${first}: exit ${part.code} ${part.message}`; break; }
          const pb = new Uint8Array(part.pixels);
          const ref = whole.subarray(first * info.frameBytes, first * info.frameBytes + pb.length);
          if (pb.length !== ref.length || pb.some((v, i) => v !== ref[i])) { same = false; rec.reason = `range ${first} differs from whole decode`; break; }
        }
        rec.ranges = same ? "ranges-identical" : "ranges-DIFFER";
        if (!same) rec.outcome = "fail";
      }
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
