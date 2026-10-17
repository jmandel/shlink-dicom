// One worker of scripts/lib/variants.ts: re-encodes one dataset file as SV1 and as J2K Lossless.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDicom, str } from "../../src/dicom.ts";
import { initSync, transcode_part10 } from "../../../codecs/shl-dicom-transcode-wasm/pkg/shl_dicom_transcode_wasm.js";
import { J2K, SV1, TRANSCODER_WASM, type VariantEntry, type VariantJob } from "./variants.ts";

declare const self: Worker;
try {
  initSync({ module: readFileSync(TRANSCODER_WASM) });
} catch (e) {
  postMessage({ fatal: `transcoder: ${(e as Error).message}` });
}
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

self.onmessage = (ev: MessageEvent) => {
  const job = ev.data as VariantJob;
  const input = new Uint8Array(readFileSync(job.source));
  const sop = str(parseDicom(input, { stopAtPixelData: true }).dataset, 0x00080018) ?? "";
  const entry: VariantEntry = { source: job.rel, sourceSha256: sha256(input), sourceSize: input.length, sop, variants: [] };
  for (const ts of [SV1, J2K]) {
    try {
      const r = transcode_part10(input, ts);
      const out = r.bytes;
      const declined = r.declined;
      r.free();
      if (!out) throw new Error(`declined: ${declined}`);
      const d = parseDicom(out, { stopAtPixelData: true });
      if (d.transferSyntaxUID !== ts) throw new Error(`wrote ${d.transferSyntaxUID}`);
      if (str(d.dataset, 0x00080018) !== sop) throw new Error("SOP Instance UID changed");
      const path = join(ts, job.rel);
      mkdirSync(dirname(join(job.out, path)), { recursive: true });
      writeFileSync(join(job.out, path), out);
      entry.variants.push({ ts, path, size: out.length, sha256: sha256(out) });
    } catch (e) {
      entry.variants.push({ ts, error: (e as Error).message });
    }
  }
  postMessage(entry);
};
