// Worker script for DecoderPool: one wasm instance per worker.
//
// Messages in:
//   { type: "init", module: WebAssembly.Module }
//   { type: "decode", id, bytes: ArrayBuffer, first, count, scale, encrypted? }
//   { type: "probe", id, bytes: ArrayBuffer }
//   { type: "decrypt", id, bytes: ArrayBuffer, encrypted }
// With `encrypted` the bytes are series-file ciphertext: verified and decrypted with WebCrypto
// (record-decrypt.ts) before decoding, so neither the key nor unverified bytes reach wasm.
// Messages out:
//   { type: "ready" }
//   { id, ok: true, info, pixels, lut, ms }   (pixels and lut transferred)
//   { id, ok: false, code, message, ms }     (code 2/3 from the decoder; 0 for a wasm trap)
//   { id, probe }
//   { id, ok: true, plaintext }               (decrypt; transferred)
//   { id, ok: false, auth: { record, reason } }  (a record failed its integrity check)
import { WasmDecoder } from "./wasm-decoder";
import { decryptRecords, RecordAuthenticationError } from "./record-decrypt";

/** Linear memory never shrinks; recycle the instance after a job leaves it larger than this. */
const RECYCLE_BYTES = 512 * 1024 * 1024;

let module: WebAssembly.Module | null = null;
let dec: WasmDecoder | null = null;

async function fresh(): Promise<WasmDecoder> {
  dec = await WasmDecoder.create(module!);
  return dec;
}

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === "init") {
    module = m.module;
    await fresh();
    post({ type: "ready" });
    return;
  }
  let bytes = new Uint8Array(m.bytes);
  if (m.encrypted) {
    const e = m.encrypted;
    try {
      bytes = await decryptRecords(e.key, bytes, e.firstRecord, { window: e.window, seriesPlaintextLength: e.seriesPlaintextLength });
    } catch (err) {
      if (err instanceof RecordAuthenticationError) post({ id: m.id, ok: false, auth: { record: err.recordIndex, reason: err.reason } });
      else post({ id: m.id, ok: false, code: 0, message: `decrypt: ${String((err as Error)?.message ?? err)}`, ms: 0 });
      return;
    }
    if (m.type === "decrypt") {
      post({ id: m.id, ok: true, plaintext: bytes.buffer }, [bytes.buffer]);
      return;
    }
  }
  const d = dec ?? (await fresh());
  try {
    if (m.type === "probe") {
      const p = d.probe(bytes);
      post("error" in p ? { id: m.id, ok: false, code: p.error, message: p.message, ms: 0 } : { id: m.id, ok: true, probe: p });
    } else {
      const r = d.decode(bytes, m.first ?? 0, m.count ?? 0, m.scale ?? 0);
      if (r.ok) post({ id: m.id, ...r }, r.lut ? [r.pixels, r.lut] : [r.pixels]);
      else post({ id: m.id, ...r });
    }
  } catch (e) {
    // A trap (panic, OOM): the instance is unusable. Report and start a new one.
    post({ id: m.id, ok: false, code: 0, message: String((e as Error)?.message ?? e), ms: 0 });
    dec = null;
    return;
  }
  if (d.memoryBytes > RECYCLE_BYTES) dec = null; // next job instantiates a fresh, small instance
};
