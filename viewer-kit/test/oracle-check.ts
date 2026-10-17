// One codec-corpus case through the viewer's wasm decoder: whole decode against the oracle, and
// for multi-frame encapsulated files three frame ranges against the whole decode
// (verify-oracle.ts runs it over the corpus; oracle-check.test.ts tests it).
import { readFileSync } from "node:fs";
import type { WasmDecoder } from "../src/wasm-decoder";

export type Outcome = "pass" | "fail" | "unsupported" | "crash" | "skipped";
export interface CaseResult {
  outcome: Outcome;
  reason?: string;
  ms?: number;
  ranges?: string;
}
export interface Npy {
  dtype: string;
  shape: number[];
  data: Uint8Array;
}

export function loadNpy(path: string): { dtype: string; shape: number[]; data: Uint8Array } {
  const b = readFileSync(path);
  const major = b[6];
  const hlen = major === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8);
  const hstart = major === 1 ? 10 : 12;
  const header = b.subarray(hstart, hstart + hlen).toString("latin1");
  const dtype = /'descr':\s*'([^']+)'/.exec(header)![1];
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header)![1].split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (/'fortran_order':\s*True/.test(header)) throw new Error("fortran order npy");
  return { dtype, shape, data: new Uint8Array(b.buffer, b.byteOffset + hstart + hlen, b.length - hstart - hlen) };
}

function typed(dtype: string, u8: Uint8Array) {
  const kind = dtype.replace(/^[<>|=]/, "");
  const ab = u8.slice().buffer;
  switch (kind) {
    case "u1": return new Uint8Array(ab);
    case "i1": return new Int8Array(ab);
    case "u2": return new Uint16Array(ab);
    case "i2": return new Int16Array(ab);
    case "u4": return new Uint32Array(ab);
    case "i4": return new Int32Array(ab);
    case "f4": return new Float32Array(ab);
    case "f8": return new Float64Array(ab);
    default: throw new Error(`dtype ${dtype}`);
  }
}


/** The decoder calls a case needs (WasmDecoder, or a stand-in in tests). */
export type Decoder = Pick<WasmDecoder, "decode" | "probe">;

/** Checks one case. `oracle` loads the oracle; null when there is none. */
export function checkCase(dec: Decoder, bytes: Uint8Array, c: { expect?: string; max_abs?: number }, oracle: (() => Npy) | null): CaseResult {
  const rec: CaseResult = { outcome: "skipped" };
  const r = dec.decode(bytes);
  rec.ms = r.ms;
  if (!r.ok && r.code === 3) return { ...rec, outcome: "unsupported", reason: r.message };
  if (c.expect === "error") {
    rec.outcome = r.ok ? "fail" : "pass";
    if (r.ok) rec.reason = "decoded a file no reference can decode";
    return rec;
  }
  if (!r.ok) return { ...rec, outcome: "fail", reason: `exit ${r.code}: ${r.message}` };
  if (!oracle) return { ...rec, outcome: "skipped", reason: "no oracle" };
  const o = oracle();
  if (r.pixels.byteLength !== o.data.byteLength) {
    return { ...rec, outcome: "fail", reason: `wrote ${r.pixels.byteLength} bytes, expected ${o.data.byteLength} (${o.dtype} ${o.shape})` };
  }
  const a = typed(o.dtype, new Uint8Array(r.pixels)), b = typed(o.dtype, o.data);
  let maxd = 0;
  for (let i = 0; i < a.length; i++) {
    // Floats: two NaNs (or equal infinities) are equal, NaN against a number is not.
    const d = a[i] === b[i] || (Number.isNaN(a[i]) && Number.isNaN(b[i])) ? 0 : Math.abs(a[i] - b[i]) || Infinity;
    if (d > maxd) maxd = d;
  }
  const max = c.max_abs ?? 0;
  const ok = maxd <= max;
  rec.outcome = ok ? "pass" : "fail";
  if (!ok) rec.reason = `max|d|=${maxd} > ${max}`;
  // Metadata sanity.
  const info = r.info;
  if (ok && (info.rows !== o.shape[1] || info.columns !== o.shape[2] || info.frames !== o.shape[0])) {
    rec.outcome = "fail";
    rec.reason = `metadata ${info.frames}x${info.rows}x${info.columns} vs oracle ${o.shape}`;
  }
  // Frame ranges (DecoderPool.decodeFrames) must equal the whole decode exactly.
  if (ok && info.totalFrames > 1) {
    const p = dec.probe(bytes);
    if ("frames" in p && p.encapsulated) {
      const whole = new Uint8Array(r.pixels);
      const per = Math.ceil(info.totalFrames / 3);
      let same = true;
      for (let first = 0; first < info.totalFrames; first += per) {
        const part = dec.decode(bytes, first, Math.min(per, info.totalFrames - first));
        if (!part.ok) { same = false; rec.reason = `range ${first}: exit ${part.code} ${part.message}`; break; }
        const pb = new Uint8Array(part.pixels);
        const ref = whole.subarray(first * info.frameBytes, first * info.frameBytes + pb.length);
        if (pb.length !== ref.length || pb.some((v, i) => v !== ref[i])) { same = false; rec.reason = `range ${first} differs from whole decode`; break; }
      }
      rec.ranges = same ? "ranges-identical" : "ranges-DIFFER";
      if (!same) rec.outcome = "fail";
    }
  }
  return rec;
}
