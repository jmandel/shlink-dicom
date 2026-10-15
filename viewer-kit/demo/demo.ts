// viewer-kit demo: corpus files and the synthetic CT series, decoded by the pool and drawn by
// the GL renderer. Serve with `node viewer-kit/scripts/serve.mjs` and open /kit/demo/.
import { DecoderPool, Priority, type PoolStats } from "../src/decoder-pool";
import { createRenderer } from "../src/gl-renderer";
import { CpuRenderer, type Renderer, type View } from "../src/cpu-render";
import { FrameCache } from "../src/frame-cache";
import { frameOf, defaultWindow, DicomDecodeError, type DecodedImage, type Frame } from "../src/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------------------- data sets

interface Dataset {
  label: string;
  /** One URL per slice (a series), or one multi-frame URL (slices = frames). */
  urls: string[];
  multiframe?: boolean;
}

const corpus = (c: string) => `/corpus/${c.split("/")[0]}/samples/${c.split("/")[1]}.dcm`;

const STATIC: Dataset[] = [
  { label: "XA 512² × 67 frames, JPEG lossless", urls: [corpus("jpeg-lossless/ext-gdcm-GE_DLX-8-MONO2-Multiframe-Jpeg_Lossless")], multiframe: true },
  { label: "US cine 640×480 × 120 RGB, JPEG baseline", urls: [corpus("jpeg-dct/pydicom-color3d_jpeg_baseline")], multiframe: true },
  { label: "Slide tiles 256² × 88, JPEG 2000", urls: [corpus("jpeg2000/idc-j2k-ict-u8of8-p0-mf-sm-bioimagene-e9647081")], multiframe: true },
  { label: "SEG 240² × 308, JPEG-LS", urls: [corpus("jpeg-ls/idc-jls-mono2-u8of8-mf-seg-ncifnlcr-395ded29")], multiframe: true },
  {
    label: "Single images (DX, CR, PT, palette, RGB)",
    urls: [
      corpus("jpeg2000/gen-bench-dx2048-u12-openjpeg-rev"),
      corpus("jpeg-ls/ext-pylibjpeg-RG1_JLSL"),
      corpus("jpeg-dct/local-wrist-oblique"),
      corpus("uncompressed/idc-expl-mono1-s16of16-sf-pt-gemedicals-9fcfadc9"),
      corpus("rle/ext-gdcm-rle16sti"),
      corpus("htj2k/pydicom-HTJ2KLossless_08_RGB"),
    ],
  },
];

async function datasets(): Promise<Dataset[]> {
  const out: Dataset[] = [];
  try {
    const m = await (await fetch("/series/manifest.json")).json();
    for (const [name, s] of Object.entries<any>(m.series)) {
      out.push({ label: `CT ${m.slices} × 512², ${name} (${(s.bytes / 1e6).toFixed(1)} MB)`, urls: s.files.map((f: string) => `/series/${f}`) });
    }
  } catch {
    /* series not generated: run bench/make_series.py */
  }
  return [...out, ...STATIC];
}

// --------------------------------------------------------------------------------- state

const pool = await DecoderPool.create({
  wasm: new URL("../dist/shl_dicom_decode.wasm", import.meta.url),
  workerUrl: new URL("../dist/decoder-worker.js", import.meta.url),
  onStats: (s) => { poolStats = s; scheduleStats(); },
});
let poolStats: PoolStats = pool.stats;
const cache = new FrameCache<string>(768 * 1024 * 1024);

let renderer: Renderer;
let forceCpu = false;
let current: Dataset | null = null;
let controller = new AbortController();
/** Per slice: the decoded image holding it, and the frame index within that image. */
let slices: ({ img: DecodedImage; k: number } | null)[] = [];
let sliceCount = 0;
let slice = 0;
let shownFrame: Frame | null = null;
let shownInfo: DecodedImage | null = null;
let dataRange = 4096;
let tool = "wl";
const decodeTimes: number[] = [];
let lastDecode: { ms: number; total: number } | null = null;
let lastDraw: { drawMs: number; frameMs: number } | null = null;
let errors = 0;
let openedAt = 0;
let readyMs: number | null = null;

function makeRenderer() {
  const old = $<HTMLCanvasElement>("view");
  const canvas = old.cloneNode() as HTMLCanvasElement; // a canvas keeps its first context type
  old.replaceWith(canvas);
  const view = renderer?.view;
  renderer?.destroy();
  // The demo shows the GL path even on SwiftShader; an app would use the default (CPU there).
  renderer = createRenderer(canvas, { forceCpu, allowSoftwareGl: true });
  if (view) Object.assign(renderer.view, view);
  renderer.onDraw = (t) => { lastDraw = t; scheduleStats(); };
  attachInput(canvas);
  resize();
  if (shownFrame) setFrame(shownFrame);
}

function resize() {
  if (!renderer) return;
  const c = renderer.canvas as HTMLCanvasElement;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  renderer.draw();
}
new ResizeObserver(resize).observe($("stage"));

function setFrame(f: Frame) {
  try {
    renderer.setFrame(f);
  } catch (e) {
    if (e instanceof RangeError && renderer.kind === "webgl2") {
      // Larger than MAX_TEXTURE_SIZE: this image goes through the CPU path.
      const view = renderer.view;
      renderer.destroy();
      const c = $<HTMLCanvasElement>("view"), n = c.cloneNode() as HTMLCanvasElement;
      c.replaceWith(n);
      renderer = new CpuRenderer(n);
      Object.assign(renderer.view, view);
      attachInput(n);
      resize();
      renderer.setFrame(f);
    } else throw e;
  }
}

// ------------------------------------------------------------------------------- loading

async function fetchBytes(url: string, signal: AbortSignal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

async function loadSlice(i: number, priority: number) {
  if (!current || slices[i]) return;
  const url = current.urls[i];
  const cached = cache.get(url);
  if (cached) { slices[i] = { img: cached, k: 0 }; return; }
  const signal = controller.signal;
  const bytes = await fetchBytes(url, signal);
  const img = await pool.decode(bytes, { priority, signal, key: url });
  if (signal.aborted) return;
  cache.set(url, img);
  slices[i] = { img, k: 0 };
  decodeTimes.push(img.decodeMs);
  lastDecode = { ms: img.decodeMs, total: img.totalMs };
  progress();
  if (i === slice) show();
}

async function loadMultiframe(url: string) {
  const signal = controller.signal;
  const bytes = await fetchBytes(url, signal);
  const t0 = performance.now();
  const all = await pool.decodeFrames(bytes, {
    priority: Priority.Visible,
    signal,
    onChunk: (chunk) => {
      if (signal.aborted) return;
      sliceCount = chunk.totalFrames;
      if (slices.length !== sliceCount) slices = new Array(sliceCount).fill(null);
      for (let k = 0; k < chunk.frames; k++) slices[chunk.firstFrame + k] = { img: chunk, k };
      decodeTimes.push(chunk.decodeMs);
      lastDecode = { ms: chunk.decodeMs, total: performance.now() - t0 };
      progress();
      if (!shownFrame || slices[slice]?.img === chunk) show();
    },
  });
  if (signal.aborted) return;
  scheduleStats();
}

async function open(ds: Dataset) {
  controller.abort();
  controller = new AbortController();
  current = ds;
  slices = new Array(ds.urls.length).fill(null);
  sliceCount = ds.urls.length;
  slice = ds.multiframe ? 0 : Math.floor(ds.urls.length / 2);
  shownFrame = null;
  shownInfo = null;
  decodeTimes.length = 0;
  errors = 0;
  openedAt = performance.now();
  readyMs = null;
  resetView(true);
  const guard = (p: Promise<unknown>) => p.catch((e) => {
    if (e?.name === "AbortError") return;
    errors++;
    console.error(e);
    $("hud-tl").innerHTML = `<span class="err">${e instanceof DicomDecodeError ? e.message : String(e)}</span>`;
  });
  if (ds.multiframe) {
    guard(loadMultiframe(ds.urls[0]));
    return;
  }
  guard(loadSlice(slice, Priority.Visible));
  prefetchAround(guard);
}

function prefetchAround(guard: (p: Promise<unknown>) => void) {
  if (!current || current.multiframe) return;
  const n = current.urls.length;
  // Nearest first: ±1..±3 Near, everything else Prefetch, outward from the current slice.
  for (let d = 1; d < n; d++) {
    for (const i of [slice + d, slice - d]) {
      if (i < 0 || i >= n || slices[i]) continue;
      guard(loadSlice(i, d <= 3 ? Priority.Near : Priority.Prefetch));
    }
  }
}

function progress() {
  const done = slices.filter(Boolean).length;
  if (done === sliceCount && readyMs === null) readyMs = performance.now() - openedAt;
  $("progress").style.width = `${(100 * done) / Math.max(1, sliceCount)}%`;
  scheduleStats();
}

// ---------------------------------------------------------------------------------- display

function show() {
  const s = slices[slice];
  if (!s) {
    // Not decoded yet: raise its priority (the key dedupes with the queued prefetch job).
    if (current && !current.multiframe) void loadSlice(slice, Priority.Visible).catch(() => {});
    hud();
    return;
  }
  const first = !shownFrame;
  const f = frameOf(s.img, s.k);
  shownFrame = f;
  shownInfo = s.img;
  if (first) {
    const w = defaultWindow(s.img, s.k);
    Object.assign(renderer.view, { windowCenter: w.center, windowWidth: w.width });
    const lo = (s.img.minValue ?? 0) * s.img.rescaleSlope + s.img.rescaleIntercept;
    const hi = (s.img.maxValue ?? 4095) * s.img.rescaleSlope + s.img.rescaleIntercept;
    dataRange = Math.max(16, Math.abs(hi - lo));
  }
  setFrame(f);
  hud();
}

function setSlice(i: number) {
  if (!sliceCount) return;
  const n = Math.max(0, Math.min(sliceCount - 1, i));
  if (n === slice) return;
  slice = n;
  show();
}

function resetView(keepWindow = false) {
  const v: Partial<View> = { zoom: 1, panX: 0, panY: 0 };
  if (!keepWindow && shownInfo) {
    const w = defaultWindow(shownInfo, slices[slice]?.k ?? 0);
    v.windowCenter = w.center;
    v.windowWidth = w.width;
  }
  renderer.setView(v);
  hud();
}

function hud() {
  const i = shownInfo, v = renderer.view;
  $("hud-tl").textContent = current ? `${current.label}\n${i ? `${i.modality ?? ""} ${i.transferSyntax}` : "decoding…"}` : "";
  $("hud-tr").textContent = i ? `${i.columns}×${i.rows} · ${i.bitsStored}/${i.bitsAllocated} bit${i.pixelRepresentation ? " signed" : ""}\n${i.photometric}${i.rescaleSlope !== 1 || i.rescaleIntercept ? ` · rescale ${i.rescaleSlope}/${i.rescaleIntercept}` : ""}` : "";
  $("hud-bl").textContent = sliceCount ? `slice ${slice + 1} / ${sliceCount}${slices[slice] ? "" : " (decoding)"}` : "";
  $("hud-br").textContent = i && i.samplesPerPixel === 1 ? `WL ${v.windowCenter.toFixed(0)} / WW ${v.windowWidth.toFixed(0)}\nzoom ${v.zoom.toFixed(2)}` : `zoom ${v.zoom.toFixed(2)}`;
}

let statsQueued = false;
function scheduleStats() {
  if (statsQueued) return;
  statsQueued = true;
  requestAnimationFrame(() => {
    statsQueued = false;
    const med = decodeTimes.length ? [...decodeTimes].sort((a, b) => a - b)[Math.floor(decodeTimes.length / 2)] : null;
    const gpu = (renderer as any).gpu as string | undefined;
    $("stats").innerHTML = [
      `decode <b>${lastDecode ? lastDecode.ms.toFixed(1) : "–"}</b> ms last ${current?.multiframe ? "chunk" : "image"}, <b>${med?.toFixed(1) ?? "–"}</b> median (${decodeTimes.length})`,
      `all ${sliceCount} ${readyMs !== null ? `ready in <b>${readyMs.toFixed(0)}</b> ms` : "loading"}`,
      `pool <b>${poolStats.running}</b> running / <b>${poolStats.queued}</b> queued / ${poolStats.workers} workers`,
      `redraw <b>${lastDraw ? lastDraw.drawMs.toFixed(2) : "–"}</b> ms draw, <b>${lastDraw ? lastDraw.frameMs.toFixed(1) : "–"}</b> ms to next frame`,
      `cache ${cache.size} · ${(cache.bytes / 1048576).toFixed(0)} MiB`,
      `${renderer.kind}${gpu ? ` (${gpu.replace(/^ANGLE \((.*)\)$/, "$1").slice(0, 60)})` : ""}`,
      errors ? `<span class="err">${errors} error(s)</span>` : "",
    ].filter(Boolean).join(" · ");
  });
}

// ------------------------------------------------------------------------------------ input

function attachInput(canvas: HTMLCanvasElement) {
  const pts = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; mx: number; my: number } | null = null;
  const dpr = () => Math.min(2, devicePixelRatio || 1);

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch = null;
  });
  const end = (e: PointerEvent) => { pts.delete(e.pointerId); pinch = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  let sliceAcc = 0;
  canvas.addEventListener("pointermove", (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    const v = renderer.view;
    if (pts.size >= 2) {
      // Two fingers: pinch zoom around the midpoint, and pan with it.
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (pinch) {
        const f = d / Math.max(1, pinch.d);
        zoomAt(v.zoom * f, mx, my, canvas);
        renderer.setView({ panX: renderer.view.panX + (mx - pinch.mx) * dpr(), panY: renderer.view.panY + (my - pinch.my) * dpr() });
      }
      pinch = { d, mx, my };
      hud();
      return;
    }
    const mode = e.buttons & 2 ? "pan" : e.buttons & 4 ? "zoom" : tool;
    if (mode === "wl") {
      const k = dataRange / 500;
      renderer.setView({ windowWidth: Math.max(1, v.windowWidth + dx * k), windowCenter: v.windowCenter + dy * k });
    } else if (mode === "pan") {
      renderer.setView({ panX: v.panX + dx * dpr(), panY: v.panY + dy * dpr() });
    } else if (mode === "zoom") {
      renderer.setView({ zoom: Math.max(0.05, v.zoom * Math.exp(-dy / 200)) });
    } else if (mode === "slice") {
      sliceAcc += dy / 8;
      const step = Math.trunc(sliceAcc);
      if (step) { sliceAcc -= step; setSlice(slice + step); }
    }
    hud();
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      zoomAt(renderer.view.zoom * Math.exp(-e.deltaY / 300), e.clientX, e.clientY, canvas);
    } else {
      setSlice(slice + Math.sign(e.deltaY));
    }
    hud();
  }, { passive: false });
}

/** Zoom keeping the image point under (clientX, clientY) fixed. */
function zoomAt(zoom: number, clientX: number, clientY: number, canvas: HTMLCanvasElement) {
  const v = renderer.view;
  zoom = Math.max(0.05, Math.min(64, zoom));
  const r = canvas.getBoundingClientRect(), dpr = canvas.width / Math.max(1, r.width);
  const px = (clientX - r.left) * dpr - canvas.width / 2 - v.panX;
  const py = (clientY - r.top) * dpr - canvas.height / 2 - v.panY;
  const f = zoom / v.zoom;
  renderer.setView({ zoom, panX: v.panX - px * (f - 1), panY: v.panY - py * (f - 1) });
}

addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowLeft") setSlice(slice - 1);
  else if (e.key === "ArrowDown" || e.key === "ArrowRight") setSlice(slice + 1);
  else return;
  e.preventDefault();
  hud();
});

document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) =>
  b.addEventListener("click", () => {
    tool = b.dataset.tool!;
    document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
  }),
);
const toggle = (id: string, fn: (on: boolean) => void) =>
  $(id).addEventListener("click", () => {
    const on = $(id).getAttribute("aria-pressed") !== "true";
    $(id).setAttribute("aria-pressed", String(on));
    fn(on);
  });
toggle("interp", (on) => renderer.setView({ interpolation: on ? "linear" : "nearest" }));
toggle("invert", (on) => renderer.setView({ invert: on }));
toggle("cpu", (on) => { forceCpu = on; makeRenderer(); scheduleStats(); });
$("reset").addEventListener("click", () => resetView());

// ------------------------------------------------------------------------------------- start

const list = await datasets();
const sel = $<HTMLSelectElement>("dataset");
list.forEach((d, i) => sel.add(new Option(d.label, String(i))));
sel.addEventListener("change", () => void open(list[Number(sel.value)]));
makeRenderer();
const initial = Number(new URLSearchParams(location.search).get("ds") ?? 0);
sel.value = String(initial);
void open(list[initial] ?? list[0]);
(window as any).demo = { pool, cache, get renderer() { return renderer; }, setSlice, open: (i: number) => { sel.value = String(i); return open(list[i]); } };
