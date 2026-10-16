// The lossless encoder in a worker: Part 10 in, Part 10 out (JPEG Lossless SV1 or JPEG 2000
// Lossless), or a reason it declined. The encoder (shl-dicom-transcode-wasm) decodes its result and
// compares it with the original pixels bit for bit before returning it; a difference is a decline.
import { assetUrl } from "../../core/config";

type Result = { bytes?: Uint8Array; declined?: string; tsUid?: string; free?(): void };
type Transcoder = { transcode_part10?(input: Uint8Array, tsUid: string): Result; transcode_part10_sv1(input: Uint8Array): Result };

const TS = { sv1: "1.2.840.10008.1.2.4.70", j2k: "1.2.840.10008.1.2.4.90" } as const;

let transcoder: Promise<Transcoder | null> | null = null;
function load(): Promise<Transcoder | null> {
  transcoder ??= (async () => {
    try {
      const m = await import(/* @vite-ignore */ assetUrl("shl_dicom_transcode_wasm.js"));
      await m.default({ module_or_path: assetUrl("shl_dicom_transcode_wasm_bg.wasm") });
      return m as Transcoder;
    } catch {
      return null;
    }
  })();
  return transcoder;
}

self.onmessage = async (ev: MessageEvent) => {
  const { id, bytes, mode } = ev.data as { id: number; bytes: ArrayBuffer; mode: keyof typeof TS };
  const t = await load();
  if (!t) return postMessage({ id, declined: "the encoder is not in this build" });
  try {
    const input = new Uint8Array(bytes);
    const r = t.transcode_part10 ? t.transcode_part10(input, TS[mode]) : mode === "sv1" ? t.transcode_part10_sv1(input) : { declined: "JPEG 2000 is not in this build" };
    const out = r.bytes;
    const reply = out ? { id, bytes: out.buffer, transferSyntax: r.tsUid ?? TS[mode] } : { id, declined: r.declined ?? "declined" };
    r.free?.();
    postMessage(reply, out ? [out.buffer as ArrayBuffer] : []);
  } catch (e) {
    postMessage({ id, declined: `the encoder failed (${(e as Error).message})` });
  }
};
