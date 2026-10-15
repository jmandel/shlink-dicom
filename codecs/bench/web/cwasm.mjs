// C/C++ codecs compiled to wasm (the Cornerstone codec packages), timed in the same worker as
// our decoder. Browser only. Each library decodes the frame codestreams that our own frame
// splitter produces (bench_extract_frames), so both sides decode the same bytes; only decode()
// is timed, which is comparable with our `codec` stage.
import { runCount } from "../lib/stats.mjs";
import { verifyOutput } from "../lib/verify.mjs";

const NM = "/bench/node_modules/@cornerstonejs";
export const CWASM = {
  "libjpeg-turbo-8bit": { dir: `${NM}/codec-libjpeg-turbo-8bit/dist/`, js: "libjpegturbowasm_decode.js", cls: "JPEGDecoder", formats: ["jpeg-dct", "jpeg-lossless"] },
  charls: { dir: `${NM}/codec-charls/dist/`, js: "charlswasm_decode.js", cls: "JpegLSDecoder", formats: ["jpeg-ls"] },
  openjpeg: { dir: `${NM}/codec-openjpeg/dist/`, js: "openjpegwasm_decode.js", cls: "J2KDecoder", formats: ["jpeg2000", "htj2k"] },
  openjph: { dir: `${NM}/codec-openjph/dist/`, js: "openjphjs.js", cls: "HTJ2KDecoder", formats: ["htj2k"] },
};

const sources = new Map();
/** A fresh Emscripten module instance (after an error the old one may be in an aborted state). */
async function load(name) {
  const p = CWASM[name];
  if (!sources.has(name)) sources.set(name, await (await fetch(p.dir + p.js)).text());
  // The packages are UMD scripts; give them a CommonJS `module` and take module.exports.
  const m = { exports: {} };
  new Function("module", "exports", sources.get(name))(m, m.exports);
  const factory = m.exports.default ?? m.exports;
  return factory({ locateFile: (f) => p.dir + f, print: () => {}, printErr: () => {} });
}

function errText(mod, e) {
  if (typeof e === "number") {
    try { return mod?.getExceptionMessage?.(e) ?? `C++ exception ${e}`; } catch { return `C++ exception ${e}`; }
  }
  return String(e?.message ?? e);
}

function decodeFrame(mod, cls, cs, keep) {
  const d = new mod[cls]();
  try {
    d.getEncodedBuffer(cs.length).set(cs);
    const t0 = performance.now();
    d.decode();
    const dt = performance.now() - t0;
    if (!keep) return { dt };
    return { dt, out: d.getDecodedBuffer().slice(), info: d.getFrameInfo(), ilv: d.getInterleaveMode?.() };
  } finally {
    d.delete();
  }
}

/** Planar -> interleaved, and Bits Stored masking / sign extension, as our CLI does (not timed). */
function canonicalFrame(out, c, ilv) {
  const bps = c.bits_allocated > 8 ? 2 : 1;
  let data = out;
  if (c.spp === 3 && ilv === 0) {
    const px = c.rows * c.columns, d = new Uint8Array(out.length);
    for (let i = 0; i < px; i++) for (let s = 0; s < 3; s++) for (let b = 0; b < bps; b++) d[(i * 3 + s) * bps + b] = out[(s * px + i) * bps + b];
    data = d;
  }
  if (bps === 2 && c.bits_stored < 16) {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength), sh = 16 - c.bits_stored;
    for (let i = 0; i + 1 < data.length; i += 2) {
      const x = v.getUint16(i, true);
      v.setUint16(i, c.signed ? ((x << sh) << 16 >> 16 >> sh) & 0xffff : x & ((1 << c.bits_stored) - 1), true);
    }
  }
  return data;
}

/** Time every applicable library on one case. frames: array of codestreams. */
export async function runCwasm(c, frames, npy, opts) {
  const recs = [];
  for (const [name, p] of Object.entries(CWASM)) {
    if (!p.formats.includes(c.fmt)) continue;
    const rec = { case: c.id, build: name };
    let mod = null;
    try {
      mod = await load(name);
      // First pass: decode every frame once, keep the output for verification.
      const t0 = performance.now();
      const firsts = frames.map((cs) => decodeFrame(mod, p.cls, cs, true));
      rec.cold_ms = firsts.reduce((s, f) => s + f.dt, 0);
      const fb = c.rows * c.columns * c.spp * (c.bits_allocated > 8 ? 2 : 1);
      const bad = firsts.find((f) => f.out.length !== fb);
      if (bad) {
        const fi = bad.info;
        rec.verify = { ok: false, reason: `frame output ${bad.out.length} bytes, expected ${fb} (library reports ${fi?.width}×${fi?.height}×${fi?.componentCount} at ${fi?.bitsPerSample} bits)` };
      } else {
        const all = new Uint8Array(fb * frames.length);
        firsts.forEach((f, i) => all.set(canonicalFrame(f.out, c, f.ilv), i * fb));
        rec.verify = verifyOutput(all, npy, c.max_abs);
      }
      let est = performance.now() - t0;
      for (let i = 1; i < Math.max(opts.warmup, 1); i++) {
        const t = performance.now();
        frames.forEach((cs) => decodeFrame(mod, p.cls, cs, false));
        est = performance.now() - t;
      }
      const runs = [];
      for (let i = 0, n = runCount(est, opts); i < n; i++) {
        const ms = frames.reduce((s, cs) => s + decodeFrame(mod, p.cls, cs, false).dt, 0);
        runs.push([ms, 0, ms, 0]); // [total, parse, codec, normalise]: all of it is codec time
      }
      Object.assign(rec, { status: 0, n: runs.length, runs });
    } catch (e) {
      Object.assign(rec, { status: 3, msg: `not decoded: ${errText(mod, e)}` });
    }
    recs.push(rec);
  }
  return recs;
}
