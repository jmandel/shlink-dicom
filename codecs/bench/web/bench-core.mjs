// Runs cases with one or more wasm builds. Used by both the worker and the main-thread mode.
// Builds are interleaved per case (case outer, build inner, order rotated per case), so a burst
// of load from other processes affects every build about equally.
import { instantiate, measure } from "../lib/wasm.mjs";
import { CWASM, runCwasm } from "./cwasm.mjs";

const modules = new Map();
async function moduleFor(build) {
  if (!modules.has(build)) modules.set(build, await WebAssembly.compileStreaming(fetch(`/wasm/${build}.wasm`)));
  return modules.get(build);
}

const fetchBytes = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

/** config: {builds: [..], cases: [{id, fmt, corpusId, max_abs}], opts, marks: bool}; progress(rec) per result */
export async function runCases(config, progress) {
  const builds = config.builds ?? [config.build];
  for (const b of builds) await moduleFor(b);
  const out = [];
  for (const [i, c] of config.cases.entries()) {
    const [file, npy] = await Promise.all([
      fetchBytes(`/corpus/${c.fmt}/samples/${encodeURIComponent(c.corpusId)}.dcm`),
      fetchBytes(`/corpus/${c.fmt}/oracle/${encodeURIComponent(c.corpusId)}.npy`),
    ]);
    const order = builds.map((_, k) => builds[(k + i) % builds.length]);
    for (const build of order) {
      const dec = await instantiate(await moduleFor(build));
      const mark = config.marks
        ? ([t0, t1, t2]) => {
            // Shows up in the DevTools Performance panel's Timings track.
            performance.measure(`${c.id} parse+split`, { start: t0, end: t1 });
            performance.measure(`${c.id} codec+normalise`, { start: t1, end: t2 });
          }
        : undefined;
      const r = measure(dec, file, npy, { ...config.opts, maxAbs: c.max_abs, mark });
      const rec = { case: c.id, build, ...r };
      out.push(rec);
      progress?.(rec);
    }
    if (config.cwasm && Object.values(CWASM).some((p) => p.formats.includes(c.fmt))) {
      const frames = await extractFrames(await moduleFor(builds[0]), file);
      if (frames.error) {
        const rec = { case: c.id, build: "(frame split)", status: 2, msg: frames.error, cwasm: true };
        out.push(rec);
        progress?.(rec);
      } else {
        for (const r of await runCwasm(c, frames, npy, config.opts)) {
          const rec = { ...r, cwasm: true };
          out.push(rec);
          progress?.(rec);
        }
      }
    }
  }
  return out;
}

/** Frame codestreams exactly as our decoder splits them (copied out of wasm memory). */
async function extractFrames(module, file) {
  const { exports: e } = await WebAssembly.instantiate(module, { env: { bench_now: () => performance.now() } });
  const p = e.bench_alloc(file.byteLength);
  new Uint8Array(e.memory.buffer).set(file, p);
  const n = e.bench_extract_frames(p, file.byteLength);
  if (n < 0) return { error: `frame split failed (exit ${-n})` };
  const frames = [];
  for (let i = 0; i < n; i++) frames.push(new Uint8Array(e.memory.buffer, e.bench_frame_ptr(i), e.bench_frame_len(i)).slice());
  return frames;
}

export function timerResolution() {
  let min = Infinity, last = performance.now();
  for (let i = 0; i < 200000 && min > 0.0005; i++) {
    const t = performance.now();
    if (t !== last) { min = Math.min(min, t - last); last = t; }
  }
  return min;
}
