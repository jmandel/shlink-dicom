// The lossless encoder in a worker: Part 10 in, Part 10 out (JPEG Lossless SV1 or JPEG 2000
// Lossless), or a reason it declined. The encoder (shl-dicom-transcode-wasm) decodes its result and
// compares it with the original pixels bit for bit before returning it; a difference is a decline.
import { assetUrl } from "../../core/config";
import { TS as SYNTAX } from "../../core/transfer-syntax";

type Result = { bytes?: Uint8Array; declined?: string; tsUid?: string; free?(): void };
type Transcoder = {
  transcode_part10(input: Uint8Array, tsUid: string): Result;
  /** The transfer syntaxes this build encodes; absent in builds that encode only JPEG Lossless SV1. */
  supported_transfer_syntaxes?(): string[];
};

const TS = { sv1: SYNTAX.JPEGLosslessSV1, j2k: SYNTAX.J2KLossless } as const;

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
  const { id, bytes, mode, caps } = ev.data as { id: number; bytes: ArrayBuffer; mode: keyof typeof TS; caps?: boolean };
  const t = await load();
  if (caps) return postMessage({ id, caps: t ? (t.supported_transfer_syntaxes?.() ?? [TS.sv1]) : [] });
  if (!t) return postMessage({ id, declined: "the encoder is not in this build" });
  try {
    const input = new Uint8Array(bytes);
    const r = t.transcode_part10(input, TS[mode]);
    const out = r.bytes;
    const reply = out ? { id, bytes: out.buffer, transferSyntax: r.tsUid ?? TS[mode] } : { id, declined: r.declined ?? "declined" };
    r.free?.();
    postMessage(reply, out ? [out.buffer as ArrayBuffer] : []);
  } catch (e) {
    postMessage({ id, declined: `the encoder failed (${(e as Error).message})` });
  }
};
