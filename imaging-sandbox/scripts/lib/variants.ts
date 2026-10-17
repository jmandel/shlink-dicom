// Losslessly compressed copies of the dataset's uncompressed images, for WADO-RS transfer syntax
// negotiation (argonautproject/smart-imaging PR #5): JPEG Lossless SV1 (1.2.840.10008.1.2.4.70)
// and JPEG 2000 Lossless (1.2.840.10008.1.2.4.90), made by this project's transcoder
// (codecs/shl-dicom-transcode, through its wasm build, as the Share page re-encodes), in Bun
// workers. The transcoder decodes each result and compares it with the original pixels bit for bit
// before returning it; it changes nothing else but the transfer syntax and Pixel Data.
//
// Independent verification is separate: CI decodes every copy with pydicom and pylibjpeg /
// OpenJPEG / GDCM (web/checks/pixel-identity.py) before a release is published.
//
// Output: <out>/<transfer syntax UID>/<dataset path>, plus <out>/manifest.json:
//   { encoders, instances: [{ source, sourceSha256, sourceSize, sop, variants: [{ ts, path, size, sha256 } | { ts, error }] }], failures }
// Copies are not part of the dataset's SHA256SUMS: their bytes depend on the encoder version.
import { availableParallelism } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDicom } from "../../src/dicom.ts";

export const SV1 = "1.2.840.10008.1.2.4.70";
export const J2K = "1.2.840.10008.1.2.4.90";
const UNCOMPRESSED = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2"]);
export const TRANSCODER_WASM = new URL("../../../codecs/shl-dicom-transcode-wasm/pkg/shl_dicom_transcode_wasm_bg.wasm", import.meta.url);

export interface VariantJob {
  source: string; // absolute path of the dataset file
  rel: string; // its dataset path
  out: string; // output root
}
export interface VariantEntry {
  source: string;
  sourceSha256: string;
  sourceSize: number;
  sop: string;
  variants: ({ ts: string; path: string; size: number; sha256: string } | { ts: string; error: string })[];
}

/** Makes the copies for every uncompressed image listed in `<dataset>/manifest.json`. */
export async function makeVariants(dataset: string, out: string, jobs = Number(process.env.VARIANT_JOBS) || Math.min(8, Math.max(1, availableParallelism() - 1))) {
  if (!existsSync(TRANSCODER_WASM)) {
    throw new Error(`${TRANSCODER_WASM.pathname} missing: build codecs/shl-dicom-transcode-wasm (cargo build --release --target wasm32-unknown-unknown -p shl-dicom-transcode-wasm in codecs/, then wasm-bindgen --target web --out-dir codecs/shl-dicom-transcode-wasm/pkg …)`);
  }
  const manifest = JSON.parse(readFileSync(join(dataset, "manifest.json"), "utf8"));
  const tmp = `${out}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const todo: VariantJob[] = [];
  for (const st of manifest.studies) {
    for (const f of st.files) {
      const p = join(dataset, f.path);
      const d = parseDicom(new Uint8Array(readFileSync(p)), { stopAtPixelData: true });
      if (UNCOMPRESSED.has(d.transferSyntaxUID) && d.dataset.some((e) => e.tag === 0x00280010)) todo.push({ source: p, rel: f.path, out: tmp });
    }
  }
  // A small pool of workers, each with its own transcoder instance.
  const entries: VariantEntry[] = [];
  let next = 0;
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const w = new Worker(new URL("./variants-worker.ts", import.meta.url).href);
      const feed = () => {
        if (next >= todo.length) {
          w.terminate();
          return resolve();
        }
        w.postMessage(todo[next++]);
      };
      w.onmessage = (e: MessageEvent) => {
        if (e.data.fatal) return reject(new Error(e.data.fatal));
        entries.push(e.data as VariantEntry);
        feed();
      };
      w.onerror = (e) => reject(e);
      feed();
    });
  await Promise.all(Array.from({ length: Math.min(jobs, todo.length) }, run));
  entries.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const failures = entries.flatMap((e) => e.variants.filter((v) => "error" in v).map((v) => [e.source, v.ts, (v as { error: string }).error]));
  const wasm = new Bun.CryptoHasher("sha256").update(readFileSync(TRANSCODER_WASM)).digest("hex");
  const encoder = `shl-dicom-transcode-wasm (this repository; wasm SHA-256 ${wasm.slice(0, 16)})`;
  writeFileSync(
    join(tmp, "manifest.json"),
    JSON.stringify(
      {
        _note: "Losslessly compressed copies of the uncompressed images (scripts/lib/variants.ts). The encoder checks each copy decodes to exactly the original pixels.",
        encoders: { [SV1]: encoder, [J2K]: encoder },
        instances: entries,
        failures,
      },
      null,
      1,
    ),
  );
  rmSync(out, { recursive: true, force: true });
  renameSync(tmp, out);
  const kept = entries.reduce((n, e) => n + e.variants.filter((v) => "path" in v).length, 0);
  return { instances: entries.length, kept, failures };
}
