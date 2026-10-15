// The wasm decoder (codecs/shl-dicom-wasm-bench) and the measurement loop. Runs in Node, in a
// browser page and in a Web Worker. All timings come from inside wasm (performance.now() via the
// imported env.bench_now), around shl_dicom_decode::decode_file_with only: copying the input in,
// hashing and verifying the output are outside the timed region.
import { runCount } from "./stats.mjs";
import { verifyOutput } from "./verify.mjs";

export async function instantiate(module) {
  const { exports: e } = await WebAssembly.instantiate(module, { env: { bench_now: () => performance.now() } });
  let inPtr = 0, inLen = 0;
  const mem = () => new Uint8Array(e.memory.buffer);
  return {
    setInput(bytes) {
      if (inPtr) e.bench_free(inPtr, inLen);
      inLen = bytes.byteLength;
      inPtr = e.bench_alloc(inLen);
      mem().set(bytes, inPtr);
    },
    decode(withHash = true) {
      const status = e.bench_decode(inPtr, inLen);
      const t = [0, 1, 2, 3].map((i) => e.bench_timing(i));
      const marks = [4, 5, 6].map((i) => e.bench_timing(i));
      if (status !== 0) {
        const msg = new TextDecoder().decode(mem().subarray(e.bench_msg_ptr(), e.bench_msg_ptr() + e.bench_msg_len()));
        return { status, msg, t, marks };
      }
      if (!withHash) return { status, t, marks };
      const hash = (e.bench_out_hash(1) >>> 0).toString(16).padStart(8, "0") + (e.bench_out_hash(0) >>> 0).toString(16).padStart(8, "0");
      return { status, t, marks, hash };
    },
    /** View of the last output (valid until the next decode). */
    output() {
      return mem().subarray(e.bench_out_ptr(), e.bench_out_ptr() + e.bench_out_len());
    },
    memoryBytes: () => e.memory.buffer.byteLength,
    dispose() {
      if (inPtr) e.bench_free(inPtr, inLen);
      e.bench_out_free();
      inPtr = 0;
    },
  };
}

/**
 * Warm up, verify, measure. Returns a record without case metadata.
 * opts: {warmup, min_runs, max_runs, budget_ms, maxAbs, mark?: (name, start, end) => void}
 */
export function measure(dec, fileBytes, npyBytes, opts) {
  dec.setInput(fileBytes);
  const first = dec.decode();
  if (first.status !== 0) return { status: first.status, msg: first.msg };
  const cold_ms = first.t[0];
  const verify = npyBytes ? verifyOutput(dec.output(), npyBytes, opts.maxAbs) : { ok: false, reason: "no oracle" };
  let est = cold_ms, consistent = true;
  for (let i = 1; i < Math.max(opts.warmup, 1); i++) {
    const r = dec.decode();
    est = r.t[0];
    consistent &&= r.hash === first.hash;
  }
  const n = runCount(est, opts);
  const runs = [];
  for (let i = 0; i < n; i++) {
    const r = dec.decode();
    consistent &&= r.status === 0 && r.hash === first.hash;
    runs.push(r.t);
    if (opts.mark && i === 0) opts.mark(r.marks);
  }
  const memory_bytes = dec.memoryBytes();
  dec.dispose();
  if (!consistent) verify.ok = false, verify.reason = "output changed between runs";
  return { status: 0, cold_ms, n, runs, hash: first.hash, verify, memory_bytes };
}
