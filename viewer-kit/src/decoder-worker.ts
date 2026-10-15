// Worker script for DecoderPool: one wasm instance per worker.
//
// Messages in:
//   { type: "init", module: WebAssembly.Module }
//   { type: "decode", id, bytes: ArrayBuffer, first, count }
//   { type: "probe", id, bytes: ArrayBuffer }
// Messages out:
//   { type: "ready" }
//   { id, ok: true, info, pixels, lut, ms }   (pixels and lut transferred)
//   { id, ok: false, code, message, ms }     (code 2/3 from the decoder; 0 for a wasm trap)
//   { id, probe }
import { WasmDecoder } from "./wasm-decoder";

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
  const d = dec ?? (await fresh());
  const bytes = new Uint8Array(m.bytes);
  try {
    if (m.type === "probe") {
      const p = d.probe(bytes);
      post("error" in p ? { id: m.id, ok: false, code: p.error, message: p.message, ms: 0 } : { id: m.id, ok: true, probe: p });
    } else {
      const r = d.decode(bytes, m.first ?? 0, m.count ?? 0);
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
