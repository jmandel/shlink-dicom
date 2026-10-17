// Frame-at-a-time reads (core/frames.ts) against whole-instance decodes: for every multi-frame
// file found, a FrameStream reads the file through a stand-in loader (plaintext, no network) and
// the decoder, frame by frame, and its finished image must equal the decode of the whole file:
// every pixel, every metadata field, the palette and the header bytes.
//
//   bun web/checks/frame-identity.ts [file or dir …]     (default: codec-corpus/formats)
//
// Exits non-zero on any difference. Files the stream declines (one frame, float pixel data, big
// endian, deflated) are counted, not compared; a file the decoder refuses whole is skipped.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { WasmDecoder } from "../../viewer-kit/src/wasm-decoder";
import { headerEnd } from "../../viewer-kit/src/header-end";
import type { DecodedImage, DecoderPool } from "../../viewer-kit/src/index";
import type { SeriesEntry } from "../core/bundle";
import type { InstanceLoader } from "../core/loader";
import { RECORD_PLAINTEXT, type RangePlan } from "../core/range";
import { FrameStream } from "../core/frames";

const ROOT = join(import.meta.dir, "..", "..");
const args = process.argv.slice(2);
const inputs = args.length ? args : [join(ROOT, "codec-corpus", "formats")];
const walk = (p: string): string[] => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : /\.dcm$/i.test(p) ? [p] : []);
const files = inputs.flatMap(walk).sort();

const main = new WebAssembly.Module(readFileSync(join(ROOT, "viewer-kit", "dist", "shl_dicom_decode.wasm")));
const jxlModule = new WebAssembly.Module(readFileSync(join(ROOT, "viewer-kit", "dist", "shl_dicom_decode_jxl.wasm")));
let dec = await WasmDecoder.create(main);
let decJxl: WasmDecoder | null = null;
const isJxl = (b: Uint8Array) => /1\.2\.840\.10008\.1\.2\.4\.11[0-2]/.test(new TextDecoder("latin1").decode(b.subarray(0, Math.min(b.length, 400))));

function decode(bytes: Uint8Array, first = 0, count = 0): DecodedImage {
  const d = isJxl(bytes) ? decJxl! : dec;
  const r = d.decode(bytes, first, count);
  if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
  const info = r.info;
  const palette = info.palette && r.lut ? { first: info.palette.first, rgba: new Uint8Array(r.lut) } : null;
  return { ...info, pixels: r.pixels, palette, frameOffsets: Array.from({ length: info.frames }, (_, k) => k * info.frameBytes), decodeMs: r.ms, totalMs: r.ms } as DecodedImage;
}

/** The loader and pool the stream uses, over one file's plaintext. */
function standIns(bytes: Uint8Array) {
  const series = {
    id: "file@0",
    file: { fileId: "file", plaintextLength: bytes.byteLength, ciphertextLength: Math.ceil(bytes.byteLength / RECORD_PLAINTEXT) * 65536 },
    instances: [{ offset: 0, length: bytes.byteLength, sopClass: "", uid: "x" }],
  } as unknown as SeriesEntry;
  let reads = 0, readBytes = 0;
  const loader = {
    range: async (_s: SeriesEntry, plan: RangePlan) => {
      reads++;
      const a = plan.firstRecord * RECORD_PLAINTEXT, b = Math.min(bytes.byteLength, (plan.lastRecord + 1) * RECORD_PLAINTEXT);
      readBytes += b - a;
      return bytes.slice(a, b);
    },
    decryptor: { decrypt: async (_s: SeriesEntry, plan: RangePlan, ct: Uint8Array) => ct.slice(plan.plaintextStart - plan.firstRecord * RECORD_PLAINTEXT, plan.plaintextEnd - plan.firstRecord * RECORD_PLAINTEXT) },
    report() {},
  } as unknown as InstanceLoader;
  const pool = { decode: async (b: Uint8Array) => decode(b) } as unknown as DecoderPool;
  return { series, loader, pool, stats: () => ({ reads, readBytes }) };
}

const notes: string[] = [];
function differences(a: DecodedImage, b: DecodedImage): string[] {
  const out: string[] = [];
  const skip = new Set(["pixels", "palette", "header", "decodeMs", "totalMs"]);
  // The whole decode reads per-frame values until a functional group it cannot parse; frames
  // after that have none (a decoder limit, reported). The one-frame files each start at their
  // own item, so every frame has its values: compare the frames the whole decode has.
  if (a.perFrame && b.perFrame && b.perFrame.length < a.perFrame.length) {
    notes.push(`the whole decode has per-frame values for ${b.perFrame.length} of ${a.perFrame.length} frames`);
    if (JSON.stringify(a.perFrame.slice(0, b.perFrame.length)) !== JSON.stringify(b.perFrame)) out.push("perFrame differs");
    skip.add("perFrame");
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (skip.has(k)) continue;
    const x = JSON.stringify((a as any)[k]), y = JSON.stringify((b as any)[k]);
    if (x !== y) out.push(`${k}: ${x?.slice(0, 80)} ≠ ${y?.slice(0, 80)}`);
  }
  const pa = new Uint8Array(a.pixels), pb = new Uint8Array(b.pixels);
  if (pa.length !== pb.length) out.push(`pixel bytes ${pa.length} ≠ ${pb.length}`);
  else {
    const fb = a.frameBytes;
    for (let i = 0; i < pa.length; i++)
      if (pa[i] !== pb[i]) {
        out.push(`pixels differ from byte ${i} (frame ${Math.floor(i / fb) + 1})`);
        break;
      }
  }
  const ra = a.palette?.rgba, rb = b.palette?.rgba;
  if (!!ra !== !!rb || (ra && rb && (ra.length !== rb.length || ra.some((v, i) => v !== rb[i])))) out.push("palette differs");
  if (a.palette?.first !== b.palette?.first) out.push("palette start differs");
  const ha = a.header, hb = b.header;
  if (!ha || !hb || ha.length !== hb.length || ha.some((v, i) => v !== hb[i])) out.push("header bytes differ");
  return out;
}

let compared = 0, declined = 0, skipped = 0, failed = 0;
const MAX_BYTES = 400e6;
for (const f of files) {
  const name = f.replace(ROOT + "/", "");
  let bytes: Uint8Array;
  try {
    if (statSync(f).size > MAX_BYTES) continue;
    bytes = new Uint8Array(readFileSync(f));
  } catch {
    continue;
  }
  if (isJxl(bytes)) decJxl ??= await WasmDecoder.create(jxlModule);
  let whole: DecodedImage;
  try {
    whole = decode(bytes);
  } catch (e) {
    if (String((e as Error).message).includes("unreachable")) dec = await WasmDecoder.create(main);
    skipped++;
    continue;
  }
  if (whole.frames < 2) continue;
  whole.totalFrames = whole.frames;
  whole.header = bytes.slice(0, headerEnd(bytes));
  const { series, loader, pool, stats } = standIns(bytes);
  let fs: FrameStream | null;
  try {
    fs = await FrameStream.open(loader, pool, series, 0);
  } catch (e) {
    console.log(`FAIL ${name}: the header read threw ${(e as Error).message}`);
    failed++;
    continue;
  }
  if (!fs) {
    declined++;
    console.log(`  declined ${name} (${whole.frames} frames, ${whole.transferSyntax})`);
    continue;
  }
  let img: DecodedImage;
  try {
    // The middle frame first, as the viewer asks for it; the rest stream in.
    await fs.frame(Math.floor(fs.frames / 2));
    img = await fs.complete;
  } catch (e) {
    console.log(`FAIL ${name}: ${(e as Error).message}`);
    failed++;
    continue;
  }
  notes.length = 0;
  const d = differences(img, whole);
  compared++;
  const source = fs.locator.tables[0]?.source ?? "walk";
  const st = stats();
  if (d.length) {
    failed++;
    console.log(`FAIL ${name} (${whole.frames} frames, ${source}): ${d.join("; ")}`);
  } else if (notes.length) console.log(`note ${name}: ${notes.splice(0).join("; ")}`);
  else console.log(`ok   ${name} (${whole.frames} frames, ${whole.transferSyntax}, ${source}, ${st.reads} reads, ${(st.readBytes / bytes.byteLength).toFixed(2)}× the file)`);
}
console.log(`\n${compared} compared, ${failed} failed, ${declined} declined, ${skipped} not decodable whole`);
process.exit(failed ? 1 : 0);
