// The pool's wasm at reduced resolution (DecodeOptions.scale) against the native decoder:
// for samples of every codec-corpus format, WasmDecoder.decode(bytes, 0, 0, s) must equal
// `shl-dicom-decode --scale s` byte for byte, with the same reduced rows and columns, for
// s = 1, 2, 3. Exception: where the full-size decodes of the two builds already differ (lossy
// JPEG 2000 / HTJ2K, whose float arithmetic rounds differently in wasm and native), the scaled
// results may differ by at most as much as the full ones; a box average cannot widen that. Multi-frame encapsulated samples are also decoded in three frame ranges, and the
// joined ranges must equal the whole scaled decode (the path DecoderPool.decodeFrames uses).
//
//   bun viewer-kit/test/scaled.ts [--per-format N] [--format rle]
//
// Needs viewer-kit/dist/shl_dicom_decode.wasm (node viewer-kit/scripts/build.mjs) and the native
// CLI (CARGO_TARGET_DIR=codecs/target/scaled cargo build --release -p shl-dicom-decode, or set
// SHL_DICOM_DECODE to its path).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WasmDecoder } from "../src/wasm-decoder";

const KIT = join(import.meta.dir, "..");
const ROOT = join(KIT, "..");
const FORMATS = join(ROOT, "codec-corpus", "formats");
const cli = process.env.SHL_DICOM_DECODE ?? join(ROOT, "codecs", "target", "scaled", "release", "shl-dicom-decode");
const args = process.argv.slice(2);
const opt = (n: string) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const perFormat = Number(opt("--per-format") ?? 4);
const onlyFormat = opt("--format");

const module = await WebAssembly.compile(readFileSync(join(KIT, "dist", "shl_dicom_decode.wasm")));
const tmp = mkdtempSync(join(tmpdir(), "vk-scaled-"));
let checks = 0, failures = 0;
const fail = (m: string) => { failures++; console.log(`FAIL ${m}`); };

/** Largest per-sample difference between two canonical buffers. */
function maxDiff(a: Uint8Array, b: Uint8Array, bitsAllocated: number, signed: boolean): number {
  const view = (u: Uint8Array) => {
    const buf = u.slice().buffer;
    if (bitsAllocated === 16) return signed ? new Int16Array(buf) : new Uint16Array(buf);
    if (bitsAllocated === 32) return signed ? new Int32Array(buf) : new Uint32Array(buf);
    return signed ? new Int8Array(buf) : new Uint8Array(buf);
  };
  const x = view(a), y = view(b);
  let m = x.length === y.length ? 0 : Infinity;
  for (let i = 0; i < Math.min(x.length, y.length); i++) m = Math.max(m, Math.abs(x[i] - y[i]));
  return m;
}

/** How far the two builds' full-size decodes of a file already differ (0 almost always). */
function fullDiff(path: string, bytes: Uint8Array, dec: WasmDecoder): number {
  const out = join(tmp, "f.raw");
  execFileSync(cli, [path, out], { stdio: "ignore" });
  const r = dec.decode(bytes);
  if (!r.ok) return Infinity;
  return maxDiff(new Uint8Array(r.pixels), new Uint8Array(readFileSync(out)), r.info.bitsAllocated, r.info.pixelRepresentation === 1);
}

for (const fmt of readdirSync(FORMATS).sort()) {
  if (onlyFormat && fmt !== onlyFormat) continue;
  const manifest = join(FORMATS, fmt, "cases.json");
  if (!existsSync(manifest)) continue;
  const cases = (JSON.parse(readFileSync(manifest, "utf8")).cases as any[])
    .filter((c) => c.expect === "decode" && existsSync(join(FORMATS, fmt, "samples", `${c.id}.dcm`)));
  // Spread the picks over the manifest, plus the first multi-frame case.
  const step = Math.max(1, Math.floor(cases.length / perFormat));
  const picks = new Set(cases.filter((_, i) => i % step === 0).slice(0, perFormat));
  const multi = cases.find((c) => c.frames >= 3);
  if (multi) picks.add(multi);
  for (const c of picks) {
    const bytes = new Uint8Array(readFileSync(join(FORMATS, fmt, "samples", `${c.id}.dcm`)));
    for (const s of [1, 2, 3]) {
      const out = join(tmp, "n.raw");
      let native: Buffer | null = null, dims = "";
      try {
        dims = execFileSync(cli, ["--scale", String(s), join(FORMATS, fmt, "samples", `${c.id}.dcm`), out], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
        native = readFileSync(out);
      } catch { /* native refuses: wasm must refuse too */ }
      const dec = await WasmDecoder.create(module);
      const r = dec.decode(bytes, 0, 0, s);
      checks++;
      if (!native) {
        if (r.ok) fail(`${fmt}/${c.id} 1/${1 << s}: native refuses, wasm decodes`);
        continue;
      }
      if (!r.ok) { fail(`${fmt}/${c.id} 1/${1 << s}: wasm error ${r.code} ${r.message}`); continue; }
      const [cols, rows] = dims.split(" ").map(Number);
      const i = r.info as any;
      if (i.rows !== rows || i.columns !== cols || i.scale !== s || i.fullRows !== c.rows || i.fullColumns !== c.columns
          || i.rows !== Math.ceil(c.rows / (1 << s)) || i.columns !== Math.ceil(c.columns / (1 << s))) {
        fail(`${fmt}/${c.id} 1/${1 << s}: metadata ${i.columns}x${i.rows} (full ${i.fullColumns}x${i.fullRows}, scale ${i.scale}); native ${cols}x${rows}`);
        continue;
      }
      if (Buffer.compare(Buffer.from(r.pixels), native) !== 0) {
        const path = join(FORMATS, fmt, "samples", `${c.id}.dcm`);
        const scaled = maxDiff(new Uint8Array(r.pixels), new Uint8Array(native), i.bitsAllocated, i.pixelRepresentation === 1);
        const full = fullDiff(path, bytes, await WasmDecoder.create(module));
        if (full === 0 || scaled > full) { fail(`${fmt}/${c.id} 1/${1 << s}: pixels differ from native by ${scaled} (full decodes differ by ${full})`); continue; }
        console.log(`note ${fmt}/${c.id} 1/${1 << s}: differs from native by ${scaled}, as the full decodes do (${full})`);
      }
      if (c === multi && s === 3) {
        // Frame ranges, as decodeFrames splits them.
        const per = Math.ceil(c.frames / 3);
        const parts: Uint8Array[] = [];
        for (let first = 0; first < c.frames; first += per) {
          const q = (await WasmDecoder.create(module)).decode(bytes, first, Math.min(per, c.frames - first), s);
          if (!q.ok) { fail(`${fmt}/${c.id} frames ${first}+: ${q.message}`); break; }
          parts.push(new Uint8Array(q.pixels));
        }
        const joined = Buffer.concat(parts);
        checks++;
        if (Buffer.compare(joined, native) !== 0) fail(`${fmt}/${c.id} 1/8: frame ranges joined differ from the whole decode`);
      }
    }
    console.log(`ok   ${fmt}/${c.id} (${c.columns}x${c.rows}${c.frames > 1 ? `, ${c.frames} frames` : ""})`);
  }
}
rmSync(tmp, { recursive: true });
console.log(`${checks} checks, ${failures} failing`);
process.exit(failures ? 1 : 0);
