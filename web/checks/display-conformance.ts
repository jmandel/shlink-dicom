// Display conformance: every grayscale file we can find, through our display transform
// (core/display.ts displayPlan, the one every view uses) and the CPU renderer, at its own size,
// written as 8-bit PGM next to what the reference renderers make of it. display-conformance.py
// renders the references (dcmtk dcm2img; pydicom's modality and VOI functions as a second opinion)
// and compares.
//
//   bun web/checks/display-conformance.ts [out dir] [file or dir …]
//
// The VOI follows one rule on both sides: the file's first window if it has one; else its first
// VOI LUT; else the full range of the values (dcm2img +Wi 1, +Wl 1, +Wm). Frame 1 only.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WasmDecoder } from "../../viewer-kit/src/wasm-decoder";
import type { DecodedImage } from "../../viewer-kit/src/index";
import { defaultView, renderCpu } from "../../viewer-kit/src/index";
import { parseDicomSync, T } from "../core/dicom";
import { displayModel, displayPlan, type VoiChoice } from "../core/display";

const ROOT = join(import.meta.dir, "..", "..");
const args = process.argv.slice(2);
const out = args[0] ?? "/media/barracuda/shlink-display-conformance/out";
mkdirSync(out, { recursive: true });
const inputs = args.length > 1 ? args.slice(1) : [join(ROOT, "codec-corpus", "formats")];

const walk = (p: string): string[] => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : p.endsWith(".dcm") ? [p] : []);
const files = inputs.flatMap(walk).sort();

const main = new WebAssembly.Module(readFileSync(join(ROOT, "viewer-kit", "dist", "shl_dicom_decode.wasm")));
const jxl = new WebAssembly.Module(readFileSync(join(ROOT, "viewer-kit", "dist", "shl_dicom_decode_jxl.wasm")));
let dec = await WasmDecoder.create(main);
let decJxl: WasmDecoder | null = null;

const MAX_PIXELS = 25e6;
const index: any[] = [];
for (const f of files) {
  const id = f.replace(ROOT + "/", "").replace(/[^A-Za-z0-9._-]+/g, "_");
  const rec: any = { id, file: f };
  index.push(rec);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(f));
    const { ds, transferSyntax } = parseDicomSync(bytes, { untilPixelData: true });
    rec.ts = transferSyntax;
    const spp = ds.num(T.SamplesPerPixel) ?? 1, pi = (ds.str(T.PhotometricInterpretation) ?? "").toUpperCase();
    if (spp !== 1 || !/^MONOCHROME[12]$/.test(pi)) {
      rec.skip = "not grayscale";
      continue;
    }
    if ((ds.num(T.Rows) ?? 0) * (ds.num(T.Columns) ?? 0) > MAX_PIXELS) {
      rec.skip = "larger than 25 Mpixel";
      continue;
    }
    const isJxl = /^1\.2\.840\.10008\.1\.2\.4\.11[0-2]$/.test(transferSyntax);
    const d = isJxl ? (decJxl ??= await WasmDecoder.create(jxl)) : dec;
    let r;
    try {
      r = d.decode(bytes, 0, 1);
    } catch (e) {
      dec = await WasmDecoder.create(main);
      rec.skip = `decoder trapped: ${e}`;
      continue;
    }
    if (!r.ok) {
      rec.skip = `not decoded: ${r.message}`;
      continue;
    }
    const info = r.info;
    const img: DecodedImage = { ...info, pixels: r.pixels, palette: null, frameOffsets: [0], decodeMs: r.ms, totalMs: r.ms } as DecodedImage;
    const model = displayModel(ds, 0);
    const choice: VoiChoice = model.windows.length ? { kind: "file-window", index: 0 } : model.voiLuts.length ? { kind: "lut", index: 0 } : { kind: "minmax" };
    rec.voi = choice.kind;
    rec.features = [
      model.modalityLut && `Modality LUT (${model.modalityLut.declaredBits}→${model.modalityLut.bits} bits)`,
      model.voiLuts.length && `VOI LUT ×${model.voiLuts.length} (${model.voiLuts[0].declaredBits}→${model.voiLuts[0].bits} bits)`,
      model.voiFunction !== "LINEAR" && model.voiFunction,
      model.presentationShape && `shape ${model.presentationShape}`,
      pi === "MONOCHROME1" && "MONOCHROME1",
      info.float && "float",
    ].filter(Boolean);
    const plan = displayPlan(img, 0, ds, choice);
    const w = img.columns, h = img.rows;
    const rgba = renderCpu(plan.frame, { ...defaultView(), ...plan.view, fit: "none", zoom: 1, panX: 0, panY: 0, interpolation: "nearest" }, w, h);
    const grey = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) grey[i] = rgba[i * 4];
    const header = new TextEncoder().encode(`P5\n${w} ${h}\n255\n`);
    const pgm = new Uint8Array(header.length + grey.length);
    pgm.set(header);
    pgm.set(grey, header.length);
    writeFileSync(join(out, `${id}.ours.pgm`), pgm);
    rec.size = [w, h];
  } catch (e) {
    rec.skip = `error: ${(e as Error).message}`;
  }
}
writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 1));
const rendered = index.filter((r) => !r.skip).length;
console.log(`${files.length} files, ${rendered} grayscale rendered, ${index.length - rendered} skipped → ${out}`);
