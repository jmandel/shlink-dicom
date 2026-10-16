// Browser-side harness for test/gl-vs-cpu.mjs and bench/*.mjs (driven by playwright-core).
// Loaded by test/harness.html; exposes window.vk.
import { DecoderPool, Priority } from "../src/decoder-pool";
import { importFileKey, recordNonce, RECORD_PLAINTEXT } from "../src/record-decrypt";
import { GlRenderer } from "../src/gl-renderer";
import { renderCpu, defaultView, type View } from "../src/cpu-render";
import { frameOf, defaultWindow, type DecodedImage, type Frame } from "../src/types";

const WASM = new URL("../dist/shl_dicom_decode.wasm", location.href);
const WORKER = new URL("../dist/decoder-worker.js", location.href);
let module: WebAssembly.Module | null = null;

async function wasmModule() {
  return (module ??= await WebAssembly.compileStreaming(fetch(WASM)));
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

function parseNpy(buf: ArrayBuffer) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  const major = b[6];
  const hlen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const hs = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(b.subarray(hs, hs + hlen));
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header)![1].split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  return { header, shape, data: b.subarray(hs + hlen) };
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** Decode a set of instances with a pool of `workers`; returns wall time per repetition. */
async function poolBench(opts: { urls: string[]; workers: number[]; reps: number; seedUrl?: string; mode?: "instances" | "frames" }) {
  const files = await Promise.all(opts.urls.map(fetchBytes));
  const totalBytes = files.reduce((a, f) => a + f.byteLength, 0);
  const out: any[] = [];
  let verified: string | null = null;
  for (const n of opts.workers) {
    const pool = await DecoderPool.create({ wasm: await wasmModule(), workerUrl: WORKER, workers: n });
    const run = async () => {
      const t0 = performance.now();
      let imgs: DecodedImage[];
      if (opts.mode === "frames") {
        imgs = await Promise.all(files.map((f) => pool.decodeFrames(f.slice(0), { priority: Priority.Visible })));
      } else {
        imgs = await Promise.all(files.map((f) => pool.decode(f.slice(0), { priority: Priority.Prefetch })));
      }
      return { ms: performance.now() - t0, imgs, decodeMs: imgs.reduce((a, i) => a + i.decodeMs, 0) };
    };
    await run(); // warm-up: instantiation, tier-up, memory growth
    const times: number[] = [], cpu: number[] = [];
    let last: DecodedImage[] = [];
    for (let r = 0; r < opts.reps; r++) {
      const res = await run();
      times.push(res.ms);
      cpu.push(res.decodeMs);
      last = res.imgs;
    }
    if (opts.seedUrl && verified === null) {
      const seed = parseNpy(await fetchBytes(opts.seedUrl));
      const per = seed.data.length / seed.shape[0];
      let bad = 0;
      last.forEach((img, k) => {
        const a = new Uint8Array(img.pixels), b = seed.data.subarray(k * per, (k + 1) * per);
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) bad++;
      });
      verified = bad ? `${bad} of ${last.length} differ from seed` : `all ${last.length} identical to seed`;
    }
    out.push({ workers: n, medianMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times), decodeCpuMs: median(cpu), reps: opts.reps });
    pool.destroy();
  }
  return { files: files.length, totalBytes, results: out, verified, hardwareConcurrency: navigator.hardwareConcurrency };
}

/** Render one frame with GL and with renderCpu under several views; count differing samples. */
async function glVsCpu(opts: { url: string; frame?: number }) {
  const pool = await DecoderPool.create({ wasm: await wasmModule(), workerUrl: WORKER, workers: 1 });
  try {
    const img = await pool.decode(await fetchBytes(opts.url));
    const k = Math.min(opts.frame ?? 0, img.frames - 1);
    const frame = frameOf(img, k);
    const w = defaultWindow(img, k);
    const W = frame.columns, H = frame.rows;
    const canvas = new OffscreenCanvas(W, H);
    const gl = GlRenderer.create(canvas);
    if (!gl) return { error: "no webgl2" };
    const ramp = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) ramp.set([i, 255 - i, (i * 7) & 255, 255], i * 4);
    const views: [string, Partial<View>][] = [
      ["default window, 1:1, nearest", { windowCenter: w.center, windowWidth: w.width }],
      ["default window, 1:1, linear", { windowCenter: w.center, windowWidth: w.width, interpolation: "linear" }],
      ["narrow window (w=7), 1:1", { windowCenter: w.center, windowWidth: 7 }],
      ["threshold window (w=1), 1:1", { windowCenter: w.center, windowWidth: 1 }],
      ["wide window, inverted, 1:1", { windowCenter: w.center + w.width / 3, windowWidth: w.width * 3, invert: true }],
      ["colour map, 1:1", { windowCenter: w.center, windowWidth: w.width, colormap: ramp }],
      ["zoom 2.37 + pan, nearest", { windowCenter: w.center, windowWidth: w.width, zoom: 2.37, panX: 13.25, panY: -7.5 }],
      ["zoom 2.37 + pan, linear", { windowCenter: w.center, windowWidth: w.width, zoom: 2.37, panX: 13.25, panY: -7.5, interpolation: "linear" }],
      ["zoom 0.61, linear", { windowCenter: w.center, windowWidth: w.width, zoom: 0.61, interpolation: "linear" }],
    ];
    const rows: any[] = [];
    for (const [name, v] of views) {
      const view: View = { ...defaultView(), fit: "none", ...v };
      gl.view = { ...view };
      gl.setFrame(frame);
      const g = gl.readPixels();
      const c = renderCpu(frame, view, W, H);
      let diff = 0, maxd = 0, off1 = 0;
      for (let i = 0; i < g.length; i++) {
        const d = Math.abs(g[i] - c[i]);
        if (d) { diff++; if (d === 1) off1++; if (d > maxd) maxd = d; }
      }
      rows.push({ view: name, samples: g.length, differing: diff, off1, maxDiff: maxd });
    }
    // Context loss: lose, restore, and check the frame is re-uploaded and drawn identically.
    let contextLoss = "not tested";
    const sim = gl.simulateContextLoss();
    if (sim) {
      gl.view = { ...defaultView(), fit: "none", windowCenter: w.center, windowWidth: w.width };
      const before = gl.readPixels();
      sim.lose();
      await new Promise((r) => setTimeout(r, 50));
      const lostFlag = gl.contextLost;
      sim.restore();
      await new Promise((r) => setTimeout(r, 100));
      const after = gl.readPixels();
      const same = before.length === after.length && before.every((v, i) => v === after[i]);
      contextLoss = `${lostFlag ? "lost" : "NOT lost"} → restored, redraw ${same ? "identical" : "DIFFERENT"}`;
    }
    const info = { rows: img.rows, columns: img.columns, bitsAllocated: img.bitsAllocated, bitsStored: img.bitsStored, signed: !!img.pixelRepresentation, photometric: img.photometric, slope: img.rescaleSlope, intercept: img.rescaleIntercept, window: w, palette: !!img.palette };
    gl.destroy();
    return { url: opts.url, info, rows, contextLoss, gpu: gl.gpu };
  } finally {
    pool.destroy();
  }
}

/** Window/level drag: GPU uniforms + redraw vs the CPU fallback renderer. */
async function wlBench(opts: { url: string; frames: number; canvas?: [number, number] }) {
  const pool = await DecoderPool.create({ wasm: await wasmModule(), workerUrl: WORKER, workers: 1 });
  const img = await pool.decode(await fetchBytes(opts.url));
  pool.destroy();
  const frame = frameOf(img, 0);
  const w = defaultWindow(img, 0);
  const W = opts.canvas?.[0] ?? frame.columns, H = opts.canvas?.[1] ?? frame.rows;
  const centres = Array.from({ length: opts.frames }, (_, i) => w.center + Math.sin(i / 7) * w.width * 0.4);
  const widths = Array.from({ length: opts.frames }, (_, i) => w.width * (1 + 0.3 * Math.cos(i / 5)));

  // GPU
  const glCanvas = document.createElement("canvas");
  glCanvas.width = W; glCanvas.height = H;
  document.body.append(glCanvas);
  const gl = GlRenderer.create(glCanvas)!;
  gl.setFrame(frame, { windowCenter: w.center, windowWidth: w.width, fit: "contain" });
  gl.finish();
  const gpuWork: number[] = [], gpuFrame: number[] = [], gpuSubmit: number[] = [];
  await nextFrame();
  let prev = await nextFrame();
  for (let i = 0; i < opts.frames; i++) {
    const t0 = performance.now();
    gl.view.windowCenter = centres[i];
    gl.view.windowWidth = widths[i];
    gl.draw();
    gpuSubmit.push(performance.now() - t0);
    gl.finish();
    gpuWork.push(performance.now() - t0);
    const t = await nextFrame();
    gpuFrame.push(t - prev);
    prev = t;
  }

  // CPU fallback renderer of this kit (renderCpu into the same canvas size as the GPU path).
  const fbCanvas = document.createElement("canvas");
  fbCanvas.width = W; fbCanvas.height = H;
  const fbCtx = fbCanvas.getContext("2d")!;
  const fbImage = new ImageData(W, H);
  const fbWork: number[] = [];
  for (let i = 0; i < Math.min(opts.frames, 30); i++) {
    const t0 = performance.now();
    renderCpu(frame, { ...defaultView(), windowCenter: centres[i], windowWidth: widths[i] }, W, H, fbImage.data);
    fbCtx.putImageData(fbImage, 0, 0);
    fbWork.push(performance.now() - t0);
  }
  glCanvas.remove();
  const s = (a: number[]) => ({ median: +median(a).toFixed(3), p90: +pct(a, 0.9).toFixed(3), max: +Math.max(...a).toFixed(3) });
  return {
    image: `${frame.columns}×${frame.rows} ${img.bitsAllocated}-bit`,
    canvas: `${W}×${H}`,
    gpu: { submit: s(gpuSubmit), work: s(gpuWork), frameInterval: s(gpuFrame), renderer: gl.gpu },
    cpuFallback: { work: s(fbWork) },
  };
}

/** Pool behaviour: errors, priorities, abort, transfer, dedupe, frame split. */
async function poolSemantics(opts: { big: string; multiframe: string; unsupported: string; jpeg?: string; jxl?: string }) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  const pool = await DecoderPool.create({ wasm: await wasmModule(), workerUrl: WORKER, workers: 1 });
  try {
    // Typed errors.
    try {
      await pool.decode(new TextEncoder().encode("DICM? no, just text").buffer);
      check("garbage -> InvalidDicomError", false, "decoded");
    } catch (e: any) {
      check("garbage -> InvalidDicomError", e?.name === "InvalidDicomError" && e.exitCode === 2, `${e?.name}: ${e?.message}`);
    }
    try {
      await pool.decode(await fetchBytes(opts.unsupported));
      check("unsupported -> UnsupportedDicomError", false, "decoded");
    } catch (e: any) {
      check("unsupported -> UnsupportedDicomError", e?.name === "UnsupportedDicomError" && e.exitCode === 3, `${e?.name}: ${e?.message}`);
    }

    // Transfer: the caller's buffer is detached, no copy.
    const big = await fetchBytes(opts.big);
    const mine = big.slice(0);
    const p0 = pool.decode(mine);
    check("input transferred (detached)", mine.byteLength === 0, `byteLength after decode() = ${mine.byteLength}`);
    const img0 = await p0;
    const copyIn = big.slice(0);
    await pool.decode(copyIn, { copy: true });
    check("copy: true keeps the input", copyIn.byteLength === big.byteLength);

    // Priority: one worker busy, 6 prefetch queued, then a visible job: it runs next.
    const order: string[] = [];
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) jobs.push(pool.decode(big.slice(0), { priority: Priority.Prefetch }).then(() => order.push(`prefetch${i}`)));
    jobs.push(pool.decode(big.slice(0), { priority: Priority.Visible }).then(() => order.push("visible")));
    await Promise.all(jobs);
    check("visible jumps the prefetch queue", order.indexOf("visible") <= 1, order.join(" "));

    // Key dedupe and raising a queued job's priority.
    // The worker is busy with "busy"; p0..p2 queue ahead of x; raising x moves it to the front.
    const order2: string[] = [];
    const busy = pool.decode(big.slice(0)).then(() => order2.push("busy"));
    const others = [0, 1, 2].map((i) => pool.decode(big.slice(0), { priority: Priority.Prefetch }).then(() => order2.push(`p${i}`)));
    const xFirst = pool.decode(big.slice(0), { priority: Priority.Prefetch, key: "x" });
    const xAgain = pool.decode(big.slice(0), { priority: Priority.Visible, key: "x" });
    const xFirstP = xFirst.then(() => order2.push("x"));
    await Promise.all([busy, ...others, xFirstP, xAgain]);
    check("same key -> same job, priority raised", xFirst === xAgain && order2.join(" ") === "busy x p0 p1 p2", order2.join(" "));

    // Abort: queued job removed and rejected; running job rejected at once.
    const ac = new AbortController();
    const running = pool.decode(big.slice(0));
    const queued = pool.decode(big.slice(0), { signal: ac.signal });
    const before = pool.stats.queued;
    ac.abort();
    let aborted = "";
    try { await queued; } catch (e: any) { aborted = e?.name; }
    check("abort queued -> AbortError, dequeued", aborted === "AbortError" && pool.stats.queued === before - 1, `${aborted}, queued ${before} -> ${pool.stats.queued}`);
    await running;
    const ac2 = new AbortController();
    const r2 = pool.decode(big.slice(0), { signal: ac2.signal });
    await new Promise((r) => setTimeout(r, 0));
    ac2.abort();
    let aborted2 = "";
    try { await r2; } catch (e: any) { aborted2 = e?.name; }
    check("abort running -> AbortError", aborted2 === "AbortError");
    const after = await pool.decode(big.slice(0));
    check("pool still works after aborts", after.pixels.byteLength === img0.pixels.byteLength);
  } finally {
    pool.destroy();
  }

  // decodeFrames on 4 workers equals decode on one.
  const pool4 = await DecoderPool.create({ wasm: await wasmModule(), workerUrl: WORKER, workers: 4 });
  try {
    const mf = await fetchBytes(opts.multiframe);
    const whole = await pool4.decode(mf.slice(0));
    let chunks = 0;
    const split = await pool4.decodeFrames(mf.slice(0), { onChunk: () => chunks++ });
    const a = new Uint8Array(whole.pixels), b = new Uint8Array(split.pixels);
    check("decodeFrames == decode (bytes)", a.length === b.length && a.every((v, i) => v === b[i]), `${split.frames} frames in ${chunks} chunks`);
    check("frameOffsets", split.frameOffsets.length === split.frames && split.frameOffsets[1] === split.frameBytes);

    // Reduced resolution: metadata, and decodeFrames == decode at the same scale.
    const small = await pool4.decode(mf.slice(0), { scale: 2 });
    const want = (n: number) => Math.ceil(n / 4);
    check(
      "scale: 2 -> reduced rows/columns, full size kept",
      small.rows === want(whole.rows) && small.columns === want(whole.columns) && small.scale === 2 && small.fullRows === whole.rows
        && small.fullColumns === whole.columns && small.frameBytes * small.frames === small.pixels.byteLength,
      `${small.columns}x${small.rows} of ${small.fullColumns}x${small.fullRows}`,
    );
    const smallSplit = await pool4.decodeFrames(mf.slice(0), { scale: 2 });
    const c = new Uint8Array(small.pixels), d = new Uint8Array(smallSplit.pixels);
    check("decodeFrames == decode at scale 2", c.length === d.length && c.every((v, i) => v === d[i]), `${smallSplit.frames} frames`);
    if (opts.jpeg) {
      const jb = await fetchBytes(opts.jpeg);
      const full = await pool4.decode(jb.slice(0));
      const thumb = await pool4.decode(jb.slice(0), { scale: 3 });
      check(
        "JPEG scale: 3 (codec's reduced decode)",
        thumb.rows === Math.ceil(full.rows / 8) && thumb.columns === Math.ceil(full.columns / 8),
        `${thumb.columns}x${thumb.rows}; decode ${full.decodeMs.toFixed(1)} ms full, ${thumb.decodeMs.toFixed(1)} ms at 1/8`,
      );
    }
    // Encrypted input (spec/README.md §9): a series file of [garbage, the instance, garbage], the
    // instance's window decrypted and decoded in the worker; one flipped bit is refused.
    const one = new Uint8Array(await fetchBytes(opts.big));
    const pre = 70_000, post = 9_000, P = pre + one.length + post;
    const plain = new Uint8Array(P);
    plain.fill(7, 0, pre);
    plain.set(one, pre);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const enc = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    const n = Math.ceil(P / RECORD_PLAINTEXT);
    const recs = await Promise.all(Array.from({ length: n }, (_, i) =>
      crypto.subtle.encrypt({ name: "AES-GCM", iv: recordNonce(i) }, enc, plain.subarray(i * RECORD_PLAINTEXT, Math.min(P, (i + 1) * RECORD_PLAINTEXT))).then((b) => new Uint8Array(b))));
    const first = Math.floor(pre / RECORD_PLAINTEXT), last = Math.floor((pre + one.length - 1) / RECORD_PLAINTEXT);
    const ct = new Uint8Array(recs.slice(first, last + 1).reduce((a, r) => a + r.length, 0));
    recs.slice(first, last + 1).reduce((o, r) => (ct.set(r, o), o + r.length), 0);
    const key = await importFileKey(raw);
    const encrypted = { key, firstRecord: first, filePlaintextLength: P, window: { start: pre - first * RECORD_PLAINTEXT, length: one.length } };
    const viaEnc = await pool4.decode(ct.slice(), { encrypted });
    const viaPlain = await pool4.decode(one.slice());
    const e1 = new Uint8Array(viaEnc.pixels), e2 = new Uint8Array(viaPlain.pixels);
    check("encrypted input == plain input", e1.length === e2.length && e1.every((v, i) => v === e2[i]), `${last - first + 1} records`);
    const pt = await pool4.decrypt(ct.slice(), encrypted);
    check("decrypt returns the window", pt.length === one.length && pt.every((v, i) => v === one[i]));
    const bad = ct.slice();
    bad[RECORD_PLAINTEXT + 16 + 5] ^= 1;
    try {
      await pool4.decode(bad, { encrypted });
      check("flipped bit -> RecordAuthenticationError", false, "decoded");
    } catch (e: any) {
      check("flipped bit -> RecordAuthenticationError", e?.name === "RecordAuthenticationError" && e.recordIndex === first + 1, `${e?.name}: ${e?.message}`);
    }
  } finally {
    pool4.destroy();
  }
  if (opts.jxl) {
    // JPEG XL: a pool given the wasm URL fetches shl_dicom_decode_jxl.wasm next to it, and only
    // when a JPEG XL instance arrives; several workers share the one compiled module.
    const jxlFetched = () => performance.getEntriesByType("resource").some((e) => e.name.endsWith("shl_dicom_decode_jxl.wasm"));
    const poolX = await DecoderPool.create({ wasm: WASM, workerUrl: WORKER, workers: 2 });
    try {
      await poolX.decode(await fetchBytes(opts.big));
      check("JPEG XL module not loaded for other syntaxes", !jxlFetched());
      const bytes = await fetchBytes(opts.jxl);
      const [a, b] = await Promise.all([poolX.decode(bytes.slice(0)), poolX.decode(bytes.slice(0))]);
      const same = a.pixels.byteLength === b.pixels.byteLength && new Uint8Array(a.pixels).every((v, i) => v === new Uint8Array(b.pixels)[i]);
      check("JPEG XL decodes through the lazily loaded module", jxlFetched() && same && a.rows > 0 && a.transferSyntax.startsWith("1.2.840.10008.1.2.4.11"),
        `${a.columns}x${a.rows} ${a.photometric}, ${a.decodeMs.toFixed(1)} ms`);
    } catch (e: any) {
      check("JPEG XL decodes through the lazily loaded module", false, `${e?.name}: ${e?.message}`);
    } finally {
      poolX.destroy();
    }
  }
  return checks;
}

async function webglInfo() {
  const c = document.createElement("canvas");
  const gl = GlRenderer.create(c);
  return gl ? { gpu: gl.gpu, maxTextureSize: gl.maxTextureSize } : null;
}

(window as any).vk = { poolBench, glVsCpu, wlBench, webglInfo, poolSemantics, ready: true };
