// Worker script for DecoderPool: one wasm instance per worker.
//
// Messages in:
//   { type: "init", module: WebAssembly.Module }
//   { type: "decode", id, bytes: ArrayBuffer, first, count, scale, encrypted?, header? }
//   { type: "probe", id, bytes: ArrayBuffer }
//   { type: "decrypt", id, bytes: ArrayBuffer, encrypted }
//   { type: "jxl", module } or { type: "jxl", error }   (answer to "need-jxl")
// With `encrypted` the bytes are series-file ciphertext: verified and decrypted with WebCrypto
// (record-decrypt.ts) before decoding, so neither the key nor unverified bytes reach wasm.
// Messages out:
//   { type: "ready" }
//   { type: "need-jxl" }   (a JPEG XL instance: the pool sends the JPEG XL module once)
//   { id, ok: true, info, pixels, lut, ms, header? }   (pixels, lut and header transferred; header:
//                                              the bytes before Pixel Data, when asked for)
//   { id, ok: false, code, message, ms }     (code 2/3 from the decoder; 0 for a wasm trap)
//   { id, probe }
//   { id, ok: true, plaintext }               (decrypt; transferred)
//   { id, ok: false, auth: { record, reason } }  (a record failed its integrity check)
import { WasmDecoder } from "./wasm-decoder";
import { decryptRecords, RecordAuthenticationError } from "./record-decrypt";
import { headerEnd } from "./header-end";

/** Linear memory never shrinks; recycle the instance after a job leaves it larger than this. */
const RECYCLE_BYTES = 512 * 1024 * 1024;

let module: WebAssembly.Module | null = null;
let dec: WasmDecoder | null = null;

/** JPEG XL transfer syntaxes: decoded by the separate JPEG XL module (shl_dicom_decode_jxl.wasm). */
const JXL = new Set(["1.2.840.10008.1.2.4.110", "1.2.840.10008.1.2.4.111", "1.2.840.10008.1.2.4.112"]);
let jxlDec: WasmDecoder | null = null;
let jxlWait: { resolve(m: WebAssembly.Module): void; reject(e: Error): void } | null = null;
let jxlModule: Promise<WebAssembly.Module> | null = null;

/** Transfer Syntax UID from the file meta (explicit VR little endian), or "" without one. */
function metaTransferSyntax(b: Uint8Array): string {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = b.length >= 132 && dv.getUint32(128) === 0x4449434d ? 132 : b.length >= 4 && dv.getUint32(0) === 0x4449434d ? 4 : 0;
  while (p + 8 <= b.length && dv.getUint16(p, true) === 0x0002) {
    const vr = String.fromCharCode(b[p + 4], b[p + 5]);
    const long = vr === "OB" || vr === "UN";
    const len = long ? (p + 12 <= b.length ? dv.getUint32(p + 8, true) : 0) : dv.getUint16(p + 6, true);
    const vo = p + (long ? 12 : 8);
    if (dv.getUint16(p + 2, true) === 0x0010) return String.fromCharCode(...b.subarray(vo, Math.min(vo + len, b.length))).replace(/[\0 ]+$/, "");
    p = vo + len;
  }
  return "";
}

/** The JPEG XL decoder, asking the pool for its module the first time. */
async function jxl(): Promise<WasmDecoder> {
  jxlModule ??= new Promise<WebAssembly.Module>((resolve, reject) => {
    jxlWait = { resolve, reject };
    post({ type: "need-jxl" });
  });
  try {
    jxlDec ??= await WasmDecoder.create(await jxlModule);
  } catch (e) {
    jxlModule = null; // ask again next time
    throw e;
  }
  return jxlDec;
}

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
  if (m.type === "jxl") {
    const w = jxlWait;
    jxlWait = null;
    if (m.module) w?.resolve(m.module);
    else w?.reject(new Error(m.error ?? "JPEG XL decoder unavailable"));
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
  let d = dec ?? (await fresh());
  if (m.type === "decode") {
    // JPEG XL lives in its own module; the main one only names the syntax as unsupported.
    if (JXL.has(metaTransferSyntax(bytes))) {
      try {
        d = await jxl();
      } catch (e) {
        post({ id: m.id, ok: false, code: 3, message: `JPEG XL: ${String((e as Error)?.message ?? e)}`, ms: 0 });
        return;
      }
    }
  }
  try {
    if (m.type === "probe") {
      const p = d.probe(bytes);
      post("error" in p ? { id: m.id, ok: false, code: p.error, message: p.message, ms: 0 } : { id: m.id, ok: true, probe: p });
    } else {
      const header = m.header ? bytes.slice(0, headerEnd(bytes)).buffer : null;
      const r = d.decode(bytes, m.first ?? 0, m.count ?? 0, m.scale ?? 0);
      if (r.ok) {
        const transfer: ArrayBuffer[] = [r.pixels];
        if (r.lut) transfer.push(r.lut);
        if (header) transfer.push(header);
        post({ id: m.id, ...r, header }, transfer);
      }
      else post({ id: m.id, ...r });
    }
  } catch (e) {
    // A trap (panic, OOM): the instance is unusable. Report and start a new one.
    post({ id: m.id, ok: false, code: 0, message: String((e as Error)?.message ?? e), ms: 0 });
    if (d === jxlDec) jxlDec = null;
    else dec = null;
    return;
  }
  // A fresh, small instance for the next job.
  if (d.memoryBytes > RECYCLE_BYTES) {
    if (d === jxlDec) jxlDec = null;
    else dec = null;
  }
};
