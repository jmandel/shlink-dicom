// View: the recipient's viewer at /view#shlink:/… (also usable as a bare viewer prefix).
//
// Screens: loading → passcode (P links) → study overview → viewer. Errors replace everything with
// one message. History: the overview and the viewer are separate history entries, so Back on a
// phone returns from the viewer to the overview.
import {
  extractShlink,
  fetchSampleLinks,
  loadConfig,
  formatBytes,
  formatDate,
  formatPersonName,
  InvalidBundleError,
  InvalidLinkError,
  LinkError,
  LinkResolver,
  modalityName,
  openShare,
  PasscodeError,
  isLocalizer,
  pickInitialSeries,
  plural,
  studyTitle,
  FetchPriority,
  RecordAuthenticationError,
  type OpenShare,
  type SeriesEntry,
  type StudyEntry,
} from "../core/index";
import { getDecoderPool, ImageStore, imageHeader, imageHeaderNow, PoolDecryptor, Priority, type DecodedImage } from "../core/images";
import { displayPlan, formatValue, imageRealWorld, linearWindow, realValue, realWorldOf, unitText, type DisplayModel, type RealWorld, type VoiChoice } from "../core/display";
import { defaultView, frameOf, renderCpu, type Frame } from "../../viewer-kit/src/index";
import { iccToSrgb, type IccTransform } from "../core/icc";
import { drawThumbnail, Viewport } from "../core/render";
import { presetsFor, type WindowPreset } from "../core/wl";
import { exportBaseName, exportInstance, exportSize, exportZip, type ExportScope } from "../core/export";
import { openSaveTarget, saveBlob } from "../core/save";
import { isSlideSeries } from "../core/wsi";
import { drawSlideThumbnail, slideHooks, slideSession, SlideView, type SlideSession } from "./wsi-view";
import { mayHoldMedia, MediaController } from "../core/video-view";
import { linkReports, noteAccession, type ReportLink } from "../core/reports";
import { parseDicom, parseDicomSync, T, tag } from "../core/dicom";
import { readInstanceBytes, probeInstance, cineTiming } from "../core/video";
import { planInstances, RECORD_PLAINTEXT } from "../core/range";
import { readIcon, type Icon } from "../core/icon";
import { ThumbTile } from "./thumb-tile";
import { KIND_LABEL, seriesKind, sopInfo, type ObjectKind } from "../core/objects";
import { ObjectView, type ObjectContext } from "./object-view";
import { Layers, mapColours, mapScale, type Layer } from "./layers";
import { Measure, type Tool } from "./measure";
import { GpuReformatter } from "../core/volume-gl";
import { buildVolume, isAcquired, makeVolume, planeGrid, reformat, VolumeError, type Orientation, type Plane, type PlaneGrid, type PlaneSpec, type Slab, type SlabMode, type Volume } from "../core/volume";
import { geometryOf } from "../core/geometry";
import { renderReports, reportHeading } from "./report-view";

const sopKind = (c: string) => sopInfo(c).kind;

// ------------------------------------------------------------------------------------- metrics

/** Timings in ms since navigation start, for scripted checks (window.__view). */
const metrics = {
  marks: {} as Record<string, number>,
  draws: [] as number[],
  renderer: "",
  slices: 0,
};
(globalThis as any).__view = metrics;
const mark = (name: string) => {
  if (metrics.marks[name] === undefined) metrics.marks[name] = Math.round(performance.now());
};

// Start the decoder pool at once: it compiles 0.9 MB of wasm and starts workers while the link resolves.
const poolPromise = getDecoderPool();
poolPromise.then(() => mark("pool-ready")).catch(() => {});

// ------------------------------------------------------------------------------------- DOM

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const screens = ["loading", "passcode", "error", "overview", "viewer"] as const;
type Screen = (typeof screens)[number];

function show(screen: Screen) {
  for (const s of screens) $(`screen-${s}`).classList.toggle("hidden", s !== screen);
  const inViewer = screen === "viewer";
  document.body.classList.toggle("in-viewer", inViewer);
  $("btn-back").classList.toggle("hidden", !inViewer);
  $("dl-split").classList.toggle("hidden", !(inViewer && share));
  if (inViewer && share) updateDownloadButton();
  $("btn-report").classList.toggle("hidden", !(inViewer && share && studyReports().length > 0));
  if (!inViewer) closeReports();
  $("btn-trust").classList.toggle("hidden", !(share && (screen === "overview" || inViewer)));
  if (screen !== "viewer") document.title = share ? "Shared imaging" : document.title;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ------------------------------------------------------------------------------------- state

let resolver: LinkResolver | null = null;
let share: OpenShare | null = null;
let images: ImageStore | null = null;
let verifiedRecords = 0;
let failedRecords = 0;

let studyIdx = -1;
let seriesIdx = -1;
let sliceIdx = 0;
let sliceCount = 1;
/** Per-series window chosen at the first slice (auto), or the user's. */
let wc = 0;
let ww = 1;
/** The series' automatic window (from its first image shown); Reset and "Auto" return to it. */
let autoWc = 0;
let autoWw = 0;
let presetId = "auto";
let zoom = 1;
let panX = 0;
let panY = 0;
let viewport: Viewport | null = null;
let seriesAbort = new AbortController();
let studyAbort = new AbortController();
let shownKey = "";
/** Whole-slide (SM) series are shown by a tiled deep-zoom view instead of the slice viewer. */
let slideView: SlideView | null = null;
/** Video series, and cine controls for multi-frame images (web/core/video-view.ts). */
const media = new MediaController({
  stage: $("stage"),
  toolbar: $("toolbar"),
  share: () => share,
  cineFrame: (f) => showCineFrame(f),
  cineCurrent: () => (series().instances.length === 1 ? sliceIdx : cineFrame),
});
/** The frame on screen of a multi-frame instance in a series of several instances. */
let cineFrame = 0;

/** Cine: frame f of the image on screen. One multi-frame instance: its frames are the slices. */
function showCineFrame(f: number) {
  if (series().instances.length === 1) return showSlice(f);
  const img = viewport?.image;
  if (!img) return;
  cineFrame = Math.min(f, img.frames - 1);
  viewport!.show(img, cineFrame, { windowCenter: wc, windowWidth: ww, zoom, panX, panY });
}

const study = (): StudyEntry => share!.index.studies[studyIdx];
const series = (): SeriesEntry => study().series[seriesIdx];

// ------------------------------------------------------------------------------------- slides

function slideFor(se: SeriesEntry): Promise<SlideSession> {
  return slideSession(share!, se, images!.pool, {
    onRecords: (_f, a, b, state) => {
      if (state === "verified") verifiedRecords += b - a + 1;
      if (state === "failed") failedRecords += b - a + 1;
    },
  });
}

/** The instance a series' thumbnail is made from: the middle one, or the smallest when sizes differ (less to fetch). */
function thumbInstance(se: SeriesEntry): number {
  const lens = se.instances.map((x) => x.length);
  const min = Math.min(...lens), max = Math.max(...lens);
  return max > min * 1.1 ? lens.indexOf(min) : Math.floor(lens.length / 2);
}

const tiles = new WeakMap<HTMLCanvasElement, ThumbTile>();
const tileOf = (c: HTMLCanvasElement) => tiles.get(c) ?? (tiles.set(c, new ThumbTile(c)), tiles.get(c)!);

/**
 * Thumbnail of a series (instance `inst`, by default thumbInstance), or for a slide its coarsest
 * pyramid level. The tile shows the bytes received while the file arrives, and the file's own
 * icon (Icon Image Sequence) first when it has one; it ends drawn or with the reason it isn't.
 */
async function seriesThumb(canvas: HTMLCanvasElement, se: SeriesEntry, priority: number, signal?: AbortSignal, inst = thumbInstance(se)): Promise<void> {
  const tile = tileOf(canvas);
  try {
    if (isSlideSeries(se)) {
      tile.status("Opening the slide");
      await drawSlideThumbnail(canvas, await slideFor(se));
      return tile.drawn();
    }
    const kind = kindOf(se);
    if (OBJECT_KINDS.has(kind) || DERIVED_KINDS.has(kind)) {
      drawKindIcon(canvas, kind);
      return tile.drawn();
    }
    // Video series get a drawn placeholder instead of a decode (video-view.ts).
    if (mayHoldMedia(se) && (await media.drawThumb(canvas, se))) return tile.drawn();
    const plan = planInstances(se, inst);
    tile.progress(0, plan.ciphertextEnd - plan.ciphertextStart);
    const len = se.instances[inst].length;
    if (len > 384 * 1024) {
      // A larger file: its header may carry a ready-made icon, one small read away.
      void readInstanceBytes(share!, se, inst, 0, Math.min(len, RECORD_PLAINTEXT), { signal })
        .then((head) => {
          const icon = canvas.dataset.drawn ? null : readIcon(head);
          if (icon) {
            drawIcon(canvas, icon);
            tile.preview();
          }
        })
        .catch(() => {});
    }
    const img = await images!.get(se, inst, { priority, signal, scale: thumbScale(len, canvas.width), onProgress: (r, t) => tile.progress(r, t) });
    const h = await imageHeader(img)?.catch(() => null);
    drawThumbnail(canvas, img, Math.floor(img.frames / 2), h?.ds);
    tile.drawn();
  } catch (e) {
    if ((e as any)?.name === "AbortError") throw e;
    tile.failed(`Can't show this image: ${describeError(e).title.replace(/\.$/, "").toLowerCase()}`);
    throw e;
  }
}

/** A strip tile before its thumbnail is asked for: what it will load, nothing received yet. */
function primeTile(canvas: HTMLCanvasElement, se: SeriesEntry, inst = thumbInstance(se)) {
  const tile = tileOf(canvas);
  const kind = kindOf(se);
  if (OBJECT_KINDS.has(kind) || DERIVED_KINDS.has(kind)) {
    drawKindIcon(canvas, kind);
    tile.drawn();
  } else if (isSlideSeries(se) || mayHoldMedia(se)) tile.status("Waiting to load");
  else {
    const plan = planInstances(se, inst);
    tile.progress(0, plan.ciphertextEnd - plan.ciphertextStart);
  }
}

/** A file's icon, fitted to the canvas on black. */
function drawIcon(canvas: HTMLCanvasElement, icon: Icon) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const oc = new OffscreenCanvas(icon.width, icon.height);
  oc.getContext("2d")!.putImageData(new ImageData(icon.rgba as Uint8ClampedArray<ArrayBuffer>, icon.width, icon.height), 0, 0);
  const k = Math.min(canvas.width / icon.width, canvas.height / icon.height);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(oc, (canvas.width - icon.width * k) / 2, (canvas.height - icon.height * k) / 2, icon.width * k, icon.height * k);
  // For checks: the icon's size and mean colour.
  const m = [0, 0, 0];
  for (let i = 0; i < icon.rgba.length; i += 4) for (let c = 0; c < 3; c++) m[c] += icon.rgba[i + c];
  canvas.dataset.icon = `${icon.width}x${icon.height} ${m.map((v) => Math.round(v / (icon.width * icon.height))).join(",")}`;
}

/**
 * Reduced-resolution decode for a thumbnail of `px` pixels: the largest 1/2^s (s ≤ 3) that still
 * covers the canvas. The Bundle has no image size, so it is estimated from the file's length as if
 * 16-bit uncompressed; compressed files come out smaller, so they are reduced less, never too much.
 */
function thumbScale(fileBytes: number, px: number): number {
  const side = Math.sqrt(fileBytes / 2);
  return Math.max(0, Math.min(3, Math.floor(Math.log2(side / px))));
}

// ------------------------------------------------------------------------------------- objects

/** Kinds shown by object-view.ts instead of the slice viewer. */
const OBJECT_KINDS = new Set<ObjectKind>(["sr", "pdf", "cda", "waveform", "model", "ko", "other"]);
/** Kinds drawn on the images they refer to (layers.ts). */
const DERIVED_KINDS = new Set<ObjectKind>(["seg", "rtstruct", "pr"]);

const kinds = new WeakMap<SeriesEntry, ObjectKind>();
function kindOf(se: SeriesEntry): ObjectKind {
  let k = kinds.get(se);
  if (!k) kinds.set(se, (k = seriesKind(se.instances.map((i) => i.sopClass))));
  return k;
}

const ICON: Partial<Record<ObjectKind, string>> = {
  sr: "SR", pdf: "PDF", cda: "CDA", waveform: "ECG", model: "3D", ko: "KEY", other: "FILE", seg: "SEG", rtstruct: "RT", pr: "PS",
};

/** A labelled tile for a series that has no picture of its own. */
function drawKindIcon(canvas: HTMLCanvasElement, kind: ObjectKind) {
  const c = canvas.getContext("2d")!;
  const w = canvas.width, h = canvas.height;
  c.fillStyle = "#1f2733";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#e6ebf2";
  c.font = `600 ${Math.round(h * 0.26)}px system-ui, sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(ICON[kind] ?? "FILE", w / 2, h / 2);
}

let objectView: ObjectView | null = null;

function objectContext(): ObjectContext {
  return {
    loader: share!.loader,
    study: study(),
    locate: (sop) => {
      const at = locateSop(sop);
      return at ? { series: share!.index.studies[at.study].series[at.series], index: at.instance } : null;
    },
    jump: (sop, frame) => jumpTo(sop, frame),
    download: (se, i) => void runOne(se, i),
    thumb: (canvas, se, i) => images!.get(se, i, { priority: Priority.Near, scale: thumbScale(se.instances[i].length, canvas.width) }).then((img) => drawThumbnail(canvas, img)),
  };
}

function showObject(se: SeriesEntry, kind: ObjectKind, note?: string) {
  shownKey = `${se.id}/object`;
  objectView ??= new ObjectView($("stage"), objectContext());
  objectView.setContext(objectContext());
  document.body.classList.add("object-mode");
  $("stage-busy").classList.add("hidden");
  $("stage-msg").classList.add("hidden");
  void objectView.show(se, kind, 0, note);
  // A study may open on an object rather than an image: draw the series list now.
  setTimeout(loadStripThumbs, 0);
}

function leaveObject() {
  if (!objectView?.active) return;
  objectView.close();
  document.body.classList.remove("object-mode");
}

// ------------------------------------------------------------------------------------- layers

let layers: Layers | null = null;
let measure: Measure | null = null;
/** The image on screen, for the layers. */
let shown: { img: DecodedImage; frame: number; sop: string } | null = null;
let layerSeq = 0;
let frameOfRef: string | null = null;

/** Redraws the layers for the image on screen (after a slice change, zoom or pan). */
function refreshLayers() {
  if (!layers || !viewport || !shown || objectView?.active || slideView?.active) {
    layers?.clear();
    return;
  }
  const seq = ++layerSeq;
  const s = shown;
  const at = imageHeader(s.img);
  void (at ?? Promise.resolve(null)).then((h) => {
    if (seq !== layerSeq || !layers) return;
    const fr = h?.ds.str(T.FrameOfReferenceUID) ?? null;
    if (fr !== frameOfRef) {
      frameOfRef = fr;
      updateLayersButton();
    }
    layers.update({ series: series(), sop: s.sop, frame: s.frame, img: s.img, header: h?.ds ?? null, cw: viewport!.canvas.width, ch: viewport!.canvas.height, zoom, panX, panY });
    measure?.update({ cols: s.img.columns, rows: s.img.rows, cw: viewport!.canvas.width, ch: viewport!.canvas.height, zoom, panX, panY, scale: viewport!.scale, header: h?.ds ?? null, frame: s.frame, key: `${s.sop}/${s.frame}` });
    if ((layers.planes.length > 0 || !!iccInUse) !== layersExtra) {
      layersExtra = layers.planes.length > 0 || !!iccInUse;
      updateLayersButton();
    }
  });
}

function seriesLayers(): Layer[] {
  // Slides have their own layers (wsi-view.ts); radiology layers are for the slice viewer only.
  if (!layers || studyIdx < 0 || seriesIdx < 0 || OBJECT_KINDS.has(kindOf(series())) || isSlideSeries(series())) return [];
  return layers.forSeries(series(), frameOfRef);
}

/** The image on screen has overlay planes or a colour profile: the Layers sheet has something to offer. */
let layersExtra = false;

function updateLayersButton() {
  const n = seriesLayers().length + (layersExtra ? 1 : 0);
  $("btn-layers").classList.toggle("hidden", n === 0);
  $("btn-layers").textContent = layers?.applied || [...(layers?.on ?? [])].length ? `Layers (${(layers!.applied ? 1 : 0) + layers!.on.size})` : "Layers";
}

/** A parametric map's colour scale with the values at its ends (filled in once the map is decoded). */
function mapLegend(l: Layer): HTMLElement {
  const box = el("div", "map-legend");
  const bar = el("canvas", "map-scale");
  bar.width = 256;
  bar.height = 1;
  const c = mapColours(l);
  const im = new ImageData(256, 1);
  im.data.set(c);
  bar.getContext("2d")!.putImageData(im, 0, 0);
  const text = el("span", "map-range");
  const fill = () => (text.textContent = l.segPixels || l.pmap?.realWorld?.first != null || l.pmap?.window ? mapScale(l).text : "");
  fill();
  if (!l.segPixels) layers!.onDecoded = () => fill();
  box.append(bar, text);
  return box;
}

/** The Layers sheet: segmentations and structures to draw, presentation states to apply. */
function openLayersSheet() {
  const box = $("layers-list");
  box.textContent = "";
  const all = seriesLayers();
  const drawn = all.filter((l) => l.kind !== "pr");
  const states = all.filter((l) => l.kind === "pr");
  if (layers!.planes.length) {
    box.append(el("h3", "layers-h", "Stored in the image"));
    const row = el("label", "layer-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = layers!.overlaysOn;
    cb.dataset.layer = "overlays";
    cb.addEventListener("change", () => {
      layers!.overlaysOn = cb.checked;
      layers!.redraw();
    });
    const names = layers!.planes.map((p) => p.label || p.description || (p.type === "R" ? "region" : "graphics")).join(", ");
    row.append(cb, el("span", "layer-name", `${plural(layers!.planes.length, "overlay plane")} (${names})`));
    box.append(row);
  }
  if (iccInUse) {
    if (!layers!.planes.length) box.append(el("h3", "layers-h", "Stored in the image"));
    const row = el("label", "layer-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = iccOn;
    cb.dataset.layer = "icc";
    cb.addEventListener("change", () => {
      iccOn = cb.checked;
      if (shown) draw(shown.img, shown.frame);
    });
    row.append(cb, el("span", "layer-name", `Colour corrected with the image's ICC profile (${iccInUse})`));
    box.append(row);
  }
  if (drawn.length) {
    box.append(el("h3", "layers-h", "Drawn on the images"));
    for (const l of drawn) {
      const row = el("label", "layer-row");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = layers!.on.has(l.id);
      cb.dataset.layer = l.id;
      cb.addEventListener("change", () => void layers!.toggle(l, cb.checked).then(updateLayersButton));
      row.append(cb, el("span", "layer-name", `${l.name} · ${l.kind === "seg" ? "segmentation" : l.kind === "pmap" ? "parametric map" : "structure set"}`));
      box.append(row);
      if (l.kind === "pmap") {
        box.append(mapLegend(l));
        continue;
      }
      const legend = el("ul", "legend");
      const items = l.seg ? l.seg.segments.map((x) => ({ n: x.number, name: x.label, color: x.color })) : l.rt!.rois.map((x) => ({ n: x.number, name: x.name, color: x.color }));
      for (const it of items) {
        const li = el("li", "legend-item");
        const c2 = el("input");
        c2.type = "checkbox";
        c2.checked = !layers!.hidden.has(`${l.id}/${it.n}`);
        c2.setAttribute("aria-label", `Show ${it.name}`);
        c2.addEventListener("change", () => {
          if (c2.checked) layers!.hidden.delete(`${l.id}/${it.n}`);
          else layers!.hidden.add(`${l.id}/${it.n}`);
          layers!.redraw();
        });
        const sw = el("span", "swatch");
        sw.style.background = `rgb(${it.color.join(",")})`;
        li.append(c2, sw, el("span", undefined, it.name));
        legend.append(li);
      }
      box.append(legend);
    }
  }
  if (states.length) {
    box.append(el("h3", "layers-h", "Presentation states"));
    box.append(el("p", "small muted", "Saved views of these images: window, annotations, shutters and zoom chosen by whoever made them."));
    const radio = (label: string, l: Layer | null) => {
      const row = el("label", "layer-row");
      const r = el("input");
      r.type = "radio";
      r.name = "pstate";
      r.checked = layers!.applied === l;
      r.addEventListener("change", () => applyPresentationState(l));
      row.append(r, el("span", "layer-name", label));
      box.append(row);
    };
    radio("None: the images as stored", null);
    for (const l of states) radio(l.name, l);
  }
  openSheet("sheet-layers");
}

/** Applies a presentation state (or removes one): window, invert, zoom to its displayed area, then draws its graphics. */
function applyPresentationState(l: Layer | null) {
  if (!layers) return;
  layers.applied = l;
  const ps = l?.ps;
  const sop = shown?.sop ?? "";
  if (!ps) {
    viewport?.setView({ invert: false });
    resetView();
  } else {
    const voi = ps.voi.find((v) => !v.images.length || v.images.some((r) => r.sopInstance === sop)) ?? ps.voi[0];
    if (voi) setWindow(voi.center, voi.width);
    viewport?.setView({ invert: ps.presentationShape === "INVERSE" });
    const area = ps.displayedArea[0];
    if (area && shown) {
      const cols = shown.img.columns, rows = shown.img.rows;
      const w = area.br[0] - area.tl[0] + 1, h = area.br[1] - area.tl[1] + 1;
      const z = Math.min(cols / w, rows / h);
      const cx = (area.tl[0] - 1 + w / 2 - cols / 2), cy = (area.tl[1] - 1 + h / 2 - rows / 2);
      const s = Math.min(viewport!.canvas.width / cols, viewport!.canvas.height / rows) * z;
      setZoomPan(z, -cx * s, -cy * s);
    }
  }
  $("stage").style.setProperty("--ps-transform", ps ? `rotate(${ps.rotation}deg)${ps.flip ? " scaleX(-1)" : ""}` : "none");
  layers.redraw();
  updateLayersButton();
}

/** A series holding video says so in the list, with its length when the file records frame timing. */
async function labelVideo(se: SeriesEntry, label: HTMLElement) {
  try {
    const p = await probeInstance(share!, se, 0);
    if (!p.video) return;
    const t = cineTiming(p.header);
    const secs = t.source ? Math.round(t.durations.reduce((a, b) => a + b, 0) / 1000) : 0;
    label.textContent = secs >= 1 ? `Video · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : "Video";
  } catch {}
}

const isSlideAnnotation = (se: SeriesEntry) => se.instances.some((i) => i.sopClass === "1.2.840.10008.5.1.4.1.1.91.1");

/**
 * Opens the slide a segmentation or annotation series belongs to, with that layer switched on.
 * The slide view finds its layers itself (wsi-layers.ts); this waits for them and turns one on.
 * When no slide in the study lists it, the series is shown as an object.
 */
async function showOnSlide(se: SeriesEntry, kind: ObjectKind) {
  const st = study();
  const id = isSlideAnnotation(se) ? `ann:${se.id}` : `seg:${se.id}`;
  for (let k = 0; k < st.series.length; k++) {
    if (!isSlideSeries(st.series[k])) continue;
    selectSeries(k);
    for (let t = 0; t < 100; t++) {
      if (series() !== st.series[k]) return; // the user moved on
      const ls = slideView?.layers ?? [];
      if (ls.some((l) => l.id === id)) {
        await slideView!.setLayer(id, true);
        return;
      }
      // The slide lists its layers after one header read per candidate; give up after about 8 s.
      if (slideView?.active && (ls.length > 0 || t > 40)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const back = st.series.indexOf(se);
  seriesIdx = back;
  showObject(se, OBJECT_KINDS.has(kind) ? kind : "other", "It belongs to a slide that is not in this share.");
}

/** A segmentation, structure set or presentation state chosen in the series list: show the images it refers to, with it on. */
async function showDerived(se: SeriesEntry) {
  await layers?.scan(share!.index.studies);
  const l = layers?.layers.find((x) => x.series === se);
  let at: { study: number; series: number } | null = null;
  share!.index.studies.forEach((st, a) => st.series.forEach((x, b) => {
    if (!at && l?.refSeries.includes(x.uid)) at = { study: a, series: b };
  }));
  if (!l || !at) {
    showObject(se, "other", l ? "It applies to images that are not in this share." : undefined);
    return;
  }
  const { study: ts, series: tse } = at as { study: number; series: number };
  if (ts !== studyIdx) openStudy(ts);
  selectSeries(tse);
  if (l.kind === "pr") applyPresentationState(l);
  else await layers!.toggle(l, true);
  updateLayersButton();
}

// ------------------------------------------------------------------------------------- reformats

/** The reformatted view on screen: planes through the series' volume, sampled in patient space (volume.ts). */
let mpr: { volume: Volume; orient: Orientation; grid: PlaneGrid; slab: Slab; first: DecodedImage; spec: PlaneSpec | null; ms: number; engine: "gpu" | "cpu"; frame: Frame | null } | null = null;
/**
 * Where planes are resampled: on the GPU when the viewer draws with WebGL2 (a 3D texture of the
 * volume, volume-gl.ts), else on the CPU. Both are held to the same oracle; checks can force one.
 */
let mprEngine: "auto" | "cpu" | "gpu" = "auto";
let acquiredSlice = 0;
/** The last volume built, by series UID (switching planes reuses it). */
let lastVolume: { uid: string; volume: Volume; first: DecodedImage; gpu?: GpuReformatter | null } | null = null;

/** The GPU path for the current volume (made on first use; null where it can't run). */
function gpuFor(v: NonNullable<typeof lastVolume>): GpuReformatter | null {
  if (v.gpu === undefined) {
    try {
      v.gpu = GpuReformatter.create(v.volume);
    } catch {
      v.gpu = null;
    }
  }
  return v.gpu;
}

/** Plane choices for a series that may be a volume (CT, MR, PET, NM with enough slices). */
function updatePlaneSelect(se: SeriesEntry) {
  const sel = $<HTMLSelectElement>("view-plane");
  const maybe = ["CT", "MR", "PT", "NM"].includes(se.modality ?? "") && (se.instances.length >= 10 || se.instances.length === 1);
  sel.classList.toggle("hidden", !maybe);
  sel.textContent = "";
  for (const [v, label] of [["", "As acquired"], ["axial", "Axial"], ["sagittal", "Sagittal"], ["coronal", "Coronal"]]) {
    const o = el("option", undefined, label);
    o.value = v;
    sel.append(o);
  }
  sel.value = "";
  $("btn-plane-opts").classList.add("hidden");
}

/** The series' volume: every slice decoded, with its header (counted on the stage while it loads). */
async function seriesVolume(se: SeriesEntry): Promise<{ volume: Volume; first: DecodedImage }> {
  if (lastVolume?.uid === se.uid) return lastVolume;
  const input = [];
  if (se.instances.length === 1) {
    const img = await images!.get(se, 0, { priority: Priority.Visible, onProgress: (r, t) => stageBusy(`Loading the series · ${formatBytes(r)} of ${formatBytes(t)}`, r, t) });
    const h = await imageHeader(img);
    for (let f = 0; f < img.frames; f++) input.push({ img, frame: f, geom: geometryOf(h!.ds, f) });
  } else {
    const n = se.instances.length;
    let done = 0;
    const step = () => stageBusy(`Loading slices · ${done} of ${n}`, done, n);
    step();
    const imgs = await Promise.all(se.instances.map((_, i) => images!.get(se, i, { priority: Priority.Visible }).then((im) => (done++, step(), im))));
    for (const img of imgs) input.push({ img, frame: 0, geom: geometryOf((await imageHeader(img))!.ds, null) });
  }
  const volume = buildVolume(input);
  lastVolume?.gpu?.destroy();
  lastVolume = { uid: se.uid, volume, first: input[0].img };
  return lastVolume;
}

/**
 * Shows a reformatted plane (true axial, sagittal or coronal, turned and tilted by `opts`, with a
 * slab), or the stored images for "". The plane the slices were acquired in, untilted, is the
 * stored images themselves.
 */
async function enterMpr(plane: Plane | "", opts: { turn?: number; tilt?: number; slab?: Slab } = {}) {
  const se = series();
  const sel = $<HTMLSelectElement>("view-plane");
  if (!plane) {
    $("btn-plane-opts").classList.add("hidden");
    if (mpr) {
      mpr = null;
      sliceCount = se.instances.length === 1 ? sliceCount : se.instances.length;
      $<HTMLInputElement>("slice").max = String(sliceCount - 1);
      showSlice(acquiredSlice);
    }
    return;
  }
  try {
    const { volume, first } = await seriesVolume(se);
    if (series() !== se) return;
    const orient: Orientation = { plane, turn: opts.turn ?? 0, tilt: opts.tilt ?? 0 };
    const slab = opts.slab ?? mpr?.slab ?? { thickness: 0, mode: "mip" };
    if (isAcquired(volume, orient) && !(slab.thickness > 0)) {
      sel.value = "";
      return enterMpr("");
    }
    const grid = planeGrid(volume, orient);
    // Keep the same depth through the volume when the plane changes angle.
    const frac = mpr && mpr.orient.plane === plane ? sliceIdx / Math.max(1, mpr.grid.count - 1) : 0.5;
    if (!mpr) acquiredSlice = sliceIdx;
    mpr = { volume, orient, grid, slab, first, spec: null, ms: 0, engine: "cpu", frame: null };
    sel.value = plane;
    $("btn-plane-opts").classList.remove("hidden");
    sliceCount = grid.count;
    $<HTMLInputElement>("slice").max = String(sliceCount - 1);
    $<HTMLInputElement>("slice").disabled = false;
    showMpr(Math.round(frac * (grid.count - 1)));
  } catch (e) {
    sel.value = "";
    $("stage-msg").textContent = e instanceof VolumeError ? `These images can't be reformatted: ${e.message}.` : `Reformatting failed: ${(e as Error).message}`;
    $("stage-msg").classList.remove("hidden");
  } finally {
    $("stage-busy").classList.add("hidden");
  }
}

/** Plain words for the plane on screen: "Sagittal, turned 10°, MIP 10 mm". */
function planeLabel(m: NonNullable<typeof mpr>): string {
  const parts = [m.orient.plane[0].toUpperCase() + m.orient.plane.slice(1)];
  if (m.orient.turn) parts.push(`turned ${m.orient.turn}°`);
  if (m.orient.tilt) parts.push(`tilted ${m.orient.tilt}°`);
  if (m.slab.thickness > 0) parts.push(`${{ mip: "MIP", minip: "MinIP", avg: "average" }[m.slab.mode]} ${m.slab.thickness} mm`);
  return parts.join(", ");
}

function showMpr(i: number) {
  const m = mpr!;
  sliceIdx = Math.max(0, Math.min(m.grid.count - 1, i));
  $<HTMLInputElement>("slice").value = String(sliceIdx);
  $("slice-label").textContent = `${sliceIdx + 1} / ${m.grid.count}`;
  const t0 = performance.now();
  // A slab is many planes: the GPU wins even when it is a software one.
  const useGpu = mprEngine === "gpu" || (mprEngine === "auto" && (viewport?.kind === "webgl2" || m.slab.thickness > 0));
  const gpu = useGpu && lastVolume?.volume === m.volume ? gpuFor(lastVolume) : null;
  const onGpu = gpu?.reformat(m.grid, sliceIdx, m.slab) ?? null;
  const { frame, pixelSpacing, spec } = onGpu ?? reformat(m.volume, m.grid, sliceIdx, m.slab);
  m.ms = performance.now() - t0;
  m.engine = onGpu ? "gpu" : "cpu";
  m.spec = spec;
  m.frame = frame;
  shown = null;
  layers?.clear();
  const w = linearWindow(m.first.float ? "LINEAR_EXACT" : "LINEAR", wc, ww);
  viewport!.show(m.first, 0, { windowCenter: w.center, windowWidth: w.width, zoom, panX, panY }, frame);
  const se = series();
  $("hud-tl").textContent = `${se.description ?? modalityName(se.modality)}\n${planeLabel(m)} · ${sliceIdx + 1}/${m.grid.count}\nReformatted in the viewer`;
  $("hud-tr").textContent = `${frame.columns}×${frame.rows} · ${pixelSpacing.toFixed(2)} mm\n${m.first.float ? `W ${formatValue(ww)} L ${formatValue(wc)}` : `W ${Math.round(ww)} L ${Math.round(wc)}`}`;
  measure?.update({ cols: frame.columns, rows: frame.rows, cw: viewport!.canvas.width, ch: viewport!.canvas.height, zoom, panX, panY, scale: viewport!.scale, header: null, frame: 0, key: `mpr/${planeLabel(m)}/${sliceIdx}`, spacing: [pixelSpacing, pixelSpacing] });
}

/** The angle and slab sheet: turn and tilt the plane, and choose a slab. */
function openPlaneSheet() {
  if (!mpr) return;
  const m = mpr;
  $<HTMLInputElement>("plane-turn").value = String(m.orient.turn);
  $<HTMLInputElement>("plane-tilt").value = String(m.orient.tilt);
  $<HTMLSelectElement>("slab-thickness").value = String(m.slab.thickness);
  $<HTMLSelectElement>("slab-mode").value = m.slab.mode;
  planeSheetText();
  openSheet("sheet-plane");
}

function planeSheetText() {
  $("plane-turn-v").textContent = `${$<HTMLInputElement>("plane-turn").value}°`;
  $("plane-tilt-v").textContent = `${$<HTMLInputElement>("plane-tilt").value}°`;
  $("slab-mode").classList.toggle("hidden", $<HTMLSelectElement>("slab-thickness").value === "0");
}

/** Applies the sheet's controls (on each change, so the plane follows the slider). */
function applyPlaneSheet() {
  if (!mpr) return;
  planeSheetText();
  void enterMpr(mpr.orient.plane, {
    turn: Number($<HTMLInputElement>("plane-turn").value),
    tilt: Number($<HTMLInputElement>("plane-tilt").value),
    slab: { thickness: Number($<HTMLSelectElement>("slab-thickness").value), mode: $<HTMLSelectElement>("slab-mode").value as SlabMode },
  });
}

/** Where a SOP instance is in the share. */
function locateSop(sop: string): { study: number; series: number; instance: number } | null {
  const idx = share!.index;
  for (let a = 0; a < idx.studies.length; a++)
    for (let b = 0; b < idx.studies[a].series.length; b++) {
      const k = idx.studies[a].series[b].instances.findIndex((i) => i.uid === sop);
      if (k >= 0) return { study: a, series: b, instance: k };
    }
  return null;
}

/** Shows a referenced instance (and 1-based frame) in the viewer. */
function jumpTo(sop: string, frame?: number) {
  const at = locateSop(sop);
  console.log("DBG jump", sop, JSON.stringify(at), studyIdx, seriesIdx);
  if (!at) return;
  if (at.study !== studyIdx) openStudy(at.study);
  selectSeries(at.series);
  const se = series();
  const kind = kindOf(se);
  if (OBJECT_KINDS.has(kind) || DERIVED_KINDS.has(kind)) return;
  showSlice(se.instances.length === 1 && frame ? frame - 1 : at.instance);
}

// ------------------------------------------------------------------------------------- boot

async function boot() {
  wireStatic();
  const link = extractShlink(decodeURIComponent(location.hash));
  if (!link) {
    showPasteScreen();
    return;
  }
  try {
    resolver = new LinkResolver(link, { recipient: "Web viewer" });
  } catch (e) {
    showError(e);
    return;
  }
  setHeader();
  if (resolver.needsPasscode) showPasscode();
  else await open();
}

function setHeader() {
  const label = resolver?.label;
  const exp = resolver?.expires;
  const bits = ["Shared with you"];
  if (label) bits.push(label);
  if (exp) bits.push(`expires ${formatDate(exp.toISOString())}`);
  sharedLine = bits.join(" · ");
  // Overview and prompts: the "Shared with you" line is the title. Viewer: it becomes the kicker.
  $("top-kicker").textContent = "";
  $("top-title").textContent = sharedLine;
}

let sharedLine = "";

function patientLine(): string {
  const p = share!.index.patient;
  return formatPersonName(p.name) || "Shared imaging";
}

async function open(passcode?: string) {
  show("loading");
  $("loading-text").textContent = "Opening the link…";
  try {
    share = await openShare(resolver!, {
      passcode,
      // Records are verified and decrypted in the decoder workers, not on this thread.
      decryptor: new PoolDecryptor(poolPromise),
      onRecords: (_f, a, b, state) => {
        if (state === "verified") verifiedRecords += b - a + 1;
        if (state === "failed") failedRecords += b - a + 1;
      },
    });
    mark("bundle");
  } catch (e) {
    if (e instanceof PasscodeError) {
      showPasscode(e);
      return;
    }
    showError(e);
    return;
  }
  if (!share.index.studies.length) {
    showError(new LinkError("invalid", "This link opened, but it contains no imaging studies."));
    return;
  }
  try {
    images = new ImageStore(share.loader, await poolPromise);
  } catch (e) {
    showError(new Error(`The image decoder could not start in this browser (${(e as Error).message}).`));
    return;
  }
  setHeader();
  renderOverview();
  const st = history.state as { screen?: string; study?: number } | null;
  if (st?.screen === "viewer" && typeof st.study === "number" && share.index.studies[st.study]) {
    openStudy(st.study, false);
  } else {
    history.replaceState({ screen: "overview" }, "");
    showOverview();
  }
}

// ------------------------------------------------------------------------------------- passcode

function showPasscode(err?: PasscodeError) {
  show("passcode");
  $("passcode-label").textContent = resolver?.label ? `For “${resolver.label}”` : "";
  const msg = $("passcode-msg");
  if (err?.kind === "incorrect") {
    const left = err.remainingAttempts;
    msg.textContent =
      left === undefined ? "That passcode is not right." : `That passcode is not right. ${plural(left, "attempt")} left.`;
  } else msg.textContent = "";
  const input = $<HTMLInputElement>("input-passcode");
  input.value = "";
  (input as any).disabled = false;
  $<HTMLButtonElement>("btn-passcode").disabled = false;
  setTimeout(() => input.focus({ preventScroll: true }), 0);
}

// ------------------------------------------------------------------------------------- errors

interface ErrorView {
  title: string;
  body: string;
  retry: boolean;
}

function describeError(e: unknown): ErrorView {
  if (e instanceof LinkError) {
    switch (e.reason) {
      case "expired":
        return { title: "This link has expired", body: `${e.message} Ask the sender for a new link.`, retry: false };
      case "unavailable":
        return {
          title: "This link no longer works",
          body: "The sender may have revoked it or taken it offline, or it may have expired. Ask the sender for a new link.",
          retry: false,
        };
      case "locked":
        return {
          title: "Too many wrong passcodes",
          body: "This link is now locked. Ask the sender for a new link.",
          retry: false,
        };
      case "network":
        return navigator.onLine === false
          ? { title: "You're offline", body: "Connect to the internet, then try again.", retry: true }
          : { title: "Couldn't reach the server", body: "The server holding this share did not answer. Try again in a moment.", retry: true };
      case "invalid":
        return { title: "This link can't be opened", body: `${e.message} It may have been copied incompletely.`, retry: false };
      default:
        return { title: "Something went wrong", body: `${e.message} Try again in a moment.`, retry: true };
    }
  }
  if (e instanceof InvalidLinkError) return { title: "This link can't be opened", body: e.message, retry: false };
  if (e instanceof InvalidBundleError)
    return { title: "This share can't be shown", body: `The shared file is not in the expected format (${e.message}).`, retry: false };
  return { title: "Something went wrong", body: (e as Error)?.message ?? String(e), retry: true };
}

let retryAction: (() => void) | null = null;

function showError(e: unknown) {
  const v = describeError(e);
  share = null;
  show("error");
  $("error-title").textContent = v.title;
  $("error-body").textContent = v.body;
  $("btn-retry").classList.toggle("hidden", !v.retry);
  $("btn-paste-other").classList.remove("hidden");
  $("paste-form").classList.add("hidden");
  $("sample-row").classList.add("hidden");
  retryAction = v.retry ? () => void (resolver?.needsPasscode ? showPasscode() : open()) : null;
  document.title = v.title;
}

function showPasteScreen() {
  show("error");
  $("top-kicker").textContent = "Shared imaging viewer";
  $("top-title").textContent = "Open a link";
  $("error-title").textContent = "Open a shared link";
  $("error-body").textContent = "Paste the SMART Health Link you received. It opens here, in your browser.";
  $("btn-retry").classList.add("hidden");
  $("btn-paste-other").classList.add("hidden");
  $("paste-form").classList.remove("hidden");
  $("sample-row").classList.remove("hidden");
}

// ------------------------------------------------------------------------------------- overview

/**
 * What a study card's thumbnail shows: the series the study opens on; for projection images
 * (radiographs and the like, a few large files) the smallest non-localizer image in the study,
 * since every byte of an uncompressed file must arrive before it can be drawn.
 */
function overviewThumb(st: StudyEntry, se: SeriesEntry): { se: SeriesEntry; inst: number } {
  if (["CT", "MR", "PT", "NM"].includes(se.modality ?? "") || kindOf(se) !== "image") return { se, inst: thumbInstance(se) };
  let best = { se, inst: thumbInstance(se) };
  for (const x of st.series) {
    if (kindOf(x) !== "image" || isLocalizer(x)) continue;
    const i = thumbInstance(x);
    if (x.instances[i].length < best.se.instances[best.inst].length) best = { se: x, inst: i };
  }
  return best;
}

function renderOverview() {
  const idx = share!.index;
  $("ov-patient").textContent = patientLine();
  const meta: string[] = [];
  if (idx.patient.birthDate) meta.push(`Born ${formatDate(idx.patient.birthDate)}`);
  meta.push(plural(idx.studies.length, "study", "studies"));
  const exp = resolver?.expires;
  if (exp) meta.push(`link expires ${formatDate(exp.toISOString())}`);
  $("ov-meta").textContent = meta.join(" · ");

  const list = $("ov-studies");
  list.textContent = "";
  const thumbs: Promise<void>[] = [];
  const big: { bytes: number; run: () => Promise<void> }[] = [];
  const after: (() => Promise<unknown>)[] = [];
  idx.studies.forEach((st, si) => {
    const card = el("article", "card study-card");
    const openBtn = el("button", "study-open");
    openBtn.type = "button";
    openBtn.dataset.study = String(si);
    const thumb = el("canvas", "study-thumb");
    const dpr = Math.min(2, devicePixelRatio || 1);
    thumb.width = thumb.height = Math.round(112 * dpr);
    const text = el("div", "study-text");
    text.append(el("p", "study-title", studyTitle(st)));
    const sub = [st.started ? formatDate(st.started) : null, st.modalities.map(modalityName).join(", ")].filter(Boolean).join(" · ");
    if (sub) text.append(el("p", "study-sub", sub));
    text.append(el("p", "study-tech", `From the imaging system · ${plural(st.numberOfSeries, "series", "series")} · ${kindCounts(st)} · ${formatBytes(st.bytes)}`));
    for (const n of st.notes) text.append(el("p", "study-tech", n));
    text.append(el("span", "open-hint", "Open"));
    openBtn.append(thumb, text);
    openBtn.addEventListener("click", () => openStudy(si));
    card.append(openBtn);

    for (const l of reportLinks().filter((l) => l.studyId === st.id)) card.append(reportSummary(l));
    card.append(contentsList(st, si));
    const actions = el("div", "study-actions");
    if (st.series.length) {
      const dl = el("button", "btn", `Download study · ${formatBytes(exportSize({ kind: "study", study: st }).bytes)}`);
      dl.type = "button";
      dl.addEventListener("click", () => openDownloadSheet(true, st));
      actions.append(dl);
    }
    card.append(actions);
    list.append(card);

    // Thumbnail: the series the study opens on (for radiographs, the smallest image in the study).
    // Once every card has one, the slice the study opens on is fetched at full size at low
    // priority, so opening the study shows it at once.
    const se = st.series[pickInitialSeries(st)];
    if (!se) return;
    const target = overviewThumb(st, se);
    // Large files (uncompressed radiographs) one after another, smallest first, so the first
    // arrives early rather than all together at the end; small ones at once.
    const run = () => seriesThumb(thumb, target.se, Priority.Visible, undefined, target.inst).then(() => mark("first-thumb"));
    const bytes = target.se.instances[target.inst].length;
    if (!isSlideSeries(target.se) && bytes > 2 * 1024 * 1024) {
      primeTile(thumb, target.se, target.inst);
      big.push({ bytes, run });
    } else thumbs.push(run());
    if (!isSlideSeries(se) && !media.isVideo(se)) after.push(() => images!.get(se, Math.floor(se.instances.length / 2), { priority: Priority.Prefetch }));
  });
  let chain: Promise<void> = Promise.resolve();
  for (const b of big.sort((x, y) => x.bytes - y.bytes)) thumbs.push((chain = chain.then(b.run, b.run)));
  void Promise.allSettled(thumbs).then(() => after.forEach((f) => void f().catch(() => {})));
  // Reports that match no study in the share still appear, on their own.
  const loose = reportLinks().filter((l) => l.studyId === null);
  if (loose.length) {
    const card = el("article", "card study-card loose-reports");
    card.append(el("h2", "loose-title", plural(loose.length, "report") + " without images in this share"));
    for (const l of loose) card.append(reportSummary(l));
    list.append(card);
  }
  mark("overview");
  void learnAccessions();
}

/**
 * When some reports match no study by reference, read each study's accession number from one
 * image header (a 1/8-size decode) and match again; re-render the overview if that links any.
 */
async function learnAccessions() {
  const idx = share!.index;
  if (!reportLinks().some((l) => l.basis !== "reference" && l.basis !== "uid")) return;
  const sig = () => reportLinks().map((l) => `${l.studyId}:${l.basis}`).join();
  const before = sig();
  await Promise.all(
    idx.studies.map(async (st) => {
      // One header: the first 64 KiB of the study's first instance (no pixels, whatever it holds).
      const se = st.series[0];
      if (!se) return;
      try {
        const bytes = await readInstanceBytes(share!, se, 0, 0, RECORD_PLAINTEXT);
        noteAccession(idx, st.id, parseDicomSync(bytes, { untilPixelData: true }).ds.str(T.AccessionNumber));
      } catch {}
    }),
  );
  if (sig() !== before && !$("screen-overview").classList.contains("hidden")) renderOverview();
}

/** Instance counts by kind, e.g. "263 images · 1 report · 1 PDF". */
function kindCounts(st: StudyEntry): string {
  const n = new Map<ObjectKind, number>();
  for (const se of st.series)
    for (const i of se.instances) {
      const k = sopKind(i.sopClass);
      n.set(k, (n.get(k) ?? 0) + 1);
    }
  const order: ObjectKind[] = ["image", "slide", "video", "pmap", "sr", "pdf", "cda", "seg", "rtstruct", "pr", "ko", "waveform", "model", "other"];
  return order.filter((k) => n.has(k)).map((k) => plural(n.get(k)!, ...KIND_LABEL[k])).join(" · ");
}

/** Every series in the study, with its kind, count and size: nothing in the share goes unlisted. */
function contentsList(st: StudyEntry, si: number): HTMLElement {
  const d = el("details", "study-contents");
  const n = st.series.reduce((a, se) => a + se.instances.length, 0);
  d.append(el("summary", undefined, `Everything in this study (${plural(n, "file")})`));
  const ul = el("ul", "contents-list");
  st.series.forEach((se, k) => {
    const kind = kindOf(se);
    const li = el("li", "contents-item");
    const b = el("button", "linkish", se.description ?? `${modalityName(se.modality)} ${se.number ?? k + 1}`);
    b.type = "button";
    b.addEventListener("click", () => {
      openStudy(si);
      selectSeries(k);
    });
    const names = [...new Set(se.instances.map((i) => sopInfo(i.sopClass).name))].join(", ");
    li.append(b, el("span", "small muted", ` ${names} · ${plural(se.instances.length, ...KIND_LABEL[kind === "slide" || kind === "video" ? "image" : kind])} · ${formatBytes(se.bytes)}`));
    ul.append(li);
  });
  d.append(ul);
  return d;
}

function reportLinks(): ReportLink[] {
  return share ? linkReports(share.index) : [];
}

/** A report in a study card: where it came from, its conclusion, and a button to read it all. */
function reportSummary(l: ReportLink) {
  const r = l.report;
  const box = el("section", "report");
  box.dataset.report = r.id;
  box.dataset.basis = l.basis ?? "none";
  box.append(el("h3", undefined, `Report · ${reportHeading(r)}`));
  const from = {
    reference: "From the clinical record.",
    uid: "From the clinical record.",
    accession: "From the clinical record, matched by accession number.",
    date: "From the clinical record, matched by date and type of exam.",
    none: "From the clinical record. The images for this exam are not in this share.",
  }[l.basis ?? "none"];
  box.append(el("p", "report-from small muted", from));
  const summary = r.conclusion ?? r.text?.split(/\n\s*\n/)[0] ?? "";
  if (summary) box.append(el("p", "report-sum", summary));
  const b = el("button", "btn report-read", "Read the report");
  b.type = "button";
  b.addEventListener("click", () => openReports([l]));
  box.append(b);
  return box;
}

let reportAbort: AbortController | null = null;

/** Opens the report panel: beside the images on wide screens, full screen on phones. */
function openReports(links: ReportLink[]) {
  reportAbort?.abort();
  reportAbort = new AbortController();
  renderReports($("report-body"), links, reportAbort.signal);
  $("report-panel").classList.remove("hidden");
  document.body.classList.add("report-open");
  $("btn-report").setAttribute("aria-expanded", "true");
  $("report-panel").scrollTop = 0;
  viewport?.resize();
}

function closeReports() {
  reportAbort?.abort();
  reportAbort = null;
  $("report-panel").classList.add("hidden");
  document.body.classList.remove("report-open");
  $("btn-report").setAttribute("aria-expanded", "false");
  viewport?.resize();
}

/** The open study's reports, for the viewer's Report button. */
function studyReports(): ReportLink[] {
  return studyIdx >= 0 ? reportLinks().filter((l) => l.studyId === study().id) : [];
}

function showOverview() {
  show("overview");
  document.body.classList.add("scrolling");
  $("top-kicker").textContent = "";
  $("top-title").textContent = sharedLine;
  seriesAbort.abort();
  studyAbort.abort();
  leaveSlide();
  media.leave();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------------------------- viewer

function openStudy(si: number, push = true) {
  if (push) history.pushState({ screen: "viewer", study: si }, "");
  document.body.classList.remove("scrolling");
  window.scrollTo(0, 0);
  studyIdx = si;
  seriesIdx = -1;
  mpr = null;
  studyAbort.abort();
  studyAbort = new AbortController();
  show("viewer");
  $("top-kicker").textContent = sharedLine;
  $("top-title").textContent = studyTitle(study());
  document.title = studyTitle(study());
  // The study's reports open beside the images where there is room for both.
  const reps = studyReports();
  $("btn-report").classList.toggle("hidden", reps.length === 0);
  if (reps.length && matchMedia("(min-width: 1100px)").matches) openReports(reps);
  else closeReports();
  if (!viewport) {
    viewport = new Viewport($("stage"), {
      allowSoftwareGl: new URLSearchParams(location.search).get("renderer") === "gl",
      forceCpu: new URLSearchParams(location.search).get("renderer") === "cpu",
    });
    viewport.onDraw = (ms) => {
      if (metrics.draws.length < 5000) metrics.draws.push(ms);
      refreshLayers();
    };
    metrics.renderer = viewport.kind;
    layers = new Layers($("stage"), () => share!.loader, () => images!.pool);
    layers.onChange = updateLayersButton;
    measure = new Measure($("stage"));
    measure.onResult = (r) => {
      $("hud-br").textContent = r ? `${r.text}${r.calibration ? `\n${r.calibration}` : ""}` : "";
    };
    layers.rawPixels = async (se, sop) => {
      const i = se.instances.findIndex((x) => x.uid === sop);
      if (i < 0) return null;
      const { ds } = await parseDicom(await share!.loader.instance(se, i));
      return ds.raw(T.PixelData);
    };
  }
  void layers!.scan(share!.index.studies);
  // Series thumbnails come after a study's first image; a study opened later gets them now.
  if (metrics.marks["first-slice"]) setTimeout(loadStripThumbs, 300);
  buildStrip();
  selectSeries(pickInitialSeries(study()));
}

function buildStrip() {
  const strip = $("strip");
  strip.textContent = "";
  strip.scrollTo({ left: 0, top: 0 });
  const st = study();
  const dpr = Math.min(2, devicePixelRatio || 1);
  st.series.forEach((se, k) => {
    const b = el("button", "series-btn");
    b.type = "button";
    b.dataset.series = String(k);
    b.dataset.uid = se.uid;
    const c = el("canvas");
    c.width = c.height = Math.round(80 * dpr);
    const t = el("span", "s-text");
    t.append(el("span", "s-name", se.description ?? `${modalityName(se.modality)} ${se.number ?? k + 1}`));
    const kind = kindOf(se);
    const count = el("span", "s-count", isSlideSeries(se) ? "Whole slide" : kind === "video" ? "Video" : plural(se.instances.length, ...KIND_LABEL[kind === "slide" || kind === "pmap" ? "image" : kind]));
    t.append(count);
    if (mayHoldMedia(se)) void labelVideo(se, count);
    b.append(c, t);
    primeTile(c, se);
    b.addEventListener("click", () => selectSeries(k));
    strip.append(b);
  });
}

function loadStripThumbs() {
  const st = study();
  const signal = studyAbort.signal;
  st.series.forEach((se, k) => {
    const c = $("strip").querySelector<HTMLCanvasElement>(`[data-series="${k}"] canvas`);
    if (!c || c.dataset.drawn || c.dataset.error) return;
    seriesThumb(c, se, Priority.Near, signal).catch(() => {});
  });
}

function selectSeries(k: number) {
  if (k === seriesIdx && shownKey.startsWith(series()?.id ?? "-")) return;
  if (k === seriesIdx && slideView?.active && slideView.ss?.src.series === series()) return;
  seriesAbort.abort();
  seriesAbort = new AbortController();
  const prevSeries = seriesIdx >= 0 ? study()?.series[seriesIdx]?.id : undefined;
  if (!study()?.series[k]) return;
  seriesIdx = k;
  const se = series();
  updateDownloadButton();
  // Reformats are for image series (set again below when this is one).
  $("view-plane").classList.add("hidden");
  $("btn-plane-opts").classList.add("hidden");
  if (prevSeries && prevSeries !== se.id) {
    share!.loader.cancelQueued((sid, p) => sid === prevSeries && p >= FetchPriority.Prefetch);
  }
  $("strip")
    .querySelectorAll<HTMLElement>(".series-btn")
    .forEach((b) => b.setAttribute("aria-current", String(b.dataset.series === String(k))));
  const btn = $("strip").querySelector<HTMLElement>(`[data-series="${k}"]`);
  if (btn) {
    // Scroll the strip only, never the page.
    const strip = $("strip");
    const sr = strip.getBoundingClientRect(), br = btn.getBoundingClientRect();
    if (br.left < sr.left || br.right > sr.right) strip.scrollLeft += br.left - sr.left - (sr.width - br.width) / 2;
    if (br.top < sr.top || br.bottom > sr.bottom) strip.scrollTop += br.top - sr.top - (sr.height - br.height) / 2;
  }
  // Video series play in video-view.ts; a series that may hold video is probed first.
  const m = media.select(se, () => {
    shownKey = "";
    selectSeries(k);
  });
  if (m) {
    leaveSlide();
    leaveObject();
    shownKey = m === "shown" ? `${se.id}/media` : "";
    sliceIdx = 0;
    sliceCount = se.instances.length;
    setTimeout(loadStripThumbs, 0);
    return;
  }
  if (isSlideSeries(se)) {
    leaveObject();
    showSlide(se);
    return;
  }
  leaveSlide();
  // Reports, documents, waveforms, models, key images and other objects: object-view.ts.
  const kind = kindOf(se);
  // Segmentations and annotations of a slide: open the slide with that layer on (wsi-view.ts).
  if ((kind === "seg" || isSlideAnnotation(se)) && study().series.some(isSlideSeries)) {
    void showOnSlide(se, kind);
    return;
  }
  if (OBJECT_KINDS.has(kind)) {
    showObject(se, kind);
    return;
  }
  if (DERIVED_KINDS.has(kind)) {
    void showDerived(se);
    return;
  }
  leaveObject();
  if (layers?.applied) applyPresentationState(null);
  shown = null;
  layers?.clear();
  updateLayersButton();
  mpr = null;
  updatePlaneSelect(se);
  sliceCount = se.instances.length;
  presetId = "auto";
  wc = 0;
  ww = 0;
  autoWc = 0;
  autoWw = 0;
  cursorText = "";
  zoom = 1;
  panX = 0;
  panY = 0;
  shownKey = "";
  seriesDisplay = null;
  presetList = presetsFor(se.modality);
  fillPresets();
  $<HTMLSelectElement>("preset").value = "auto";
  const slider = $<HTMLInputElement>("slice");
  slider.max = String(Math.max(0, sliceCount - 1));
  slider.disabled = sliceCount <= 1;
  showSlice(Math.floor(sliceCount / 2), true);
}

/** Opens a whole-slide series in the tiled view. */
function showSlide(se: SeriesEntry) {
  const t0 = performance.now();
  shownKey = "";
  slideView ??= new SlideView($("stage"));
  document.body.classList.add("slide-mode");
  $("stage-msg").classList.add("hidden");
  stageBusy("Opening the slide");
  $("hud-tl").textContent = `${se.description ?? "Slide"}\nSlide microscopy`;
  $("hud-tr").textContent = "";
  $("hud-bl").textContent = "";
  $("btn-label").classList.add("hidden");
  slideFor(se)
    .then((ss) => {
      if (series() !== se) return;
      $("stage-busy").classList.add("hidden");
      const p = ss.pyramid;
      $("hud-tl").textContent = `${se.description ?? "Slide"}\n${p.width.toLocaleString()} × ${p.height.toLocaleString()} · ${p.levels.length} levels`;
      $("btn-label").classList.toggle("hidden", p.label === null && p.overview === null);
      $("btn-label").textContent = p.label !== null ? "Label" : "Glass slide";
      $("label-title").textContent = p.label !== null && p.overview !== null ? "Slide label and glass slide" : p.label !== null ? "Slide label" : "Glass slide";
      slideView!.show(ss, { share: share!, pool: images!.pool, others: study().series }, t0);
      shownKey = `${se.id}/slide`;
      if (!metrics.marks["first-slice"]) {
        mark("first-slice");
        setTimeout(loadStripThumbs, 0);
      }
    })
    .catch((e) => {
      if (series() !== se) return;
      sliceError(e);
    });
}

function leaveSlide() {
  // The label/glass-slide button belongs to slide mode only.
  $("btn-label").classList.add("hidden");
  if (!slideView?.active) return;
  slideView.close();
  document.body.classList.remove("slide-mode");
}

async function openLabelSheet() {
  const ss = slideView?.ss;
  if (!ss) return;
  const box = $("label-images");
  box.textContent = "";
  const p = ss.pyramid;
  const items: [string, number | null][] = [["Slide label", p.label], ["Whole glass slide", p.overview]];
  openSheet("sheet-label");
  for (const [caption, inst] of items) {
    if (inst === null) continue;
    const fig = el("figure", "label-fig");
    const c = el("canvas");
    const cap = el("figcaption", "small muted", `${caption} · loading ${formatBytes(ss.src.series.instances[inst].length)}…`);
    fig.append(c, cap);
    box.append(fig);
    ss.image(inst)
      .then((bmp) => {
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext("2d")!.drawImage(bmp, 0, 0);
        cap.textContent = `${caption} · ${bmp.width} × ${bmp.height}`;
      })
      .catch((e) => (cap.textContent = `${caption}: could not be shown (${(e as Error).message})`));
  }
}

/** Slice i → (instance, frame). Many instances: one slice each. One multi-frame instance: its frames. */
function sliceTarget(i: number): { inst: number; frame: number } {
  const se = series();
  return se.instances.length === 1 ? { inst: 0, frame: i } : { inst: i, frame: 0 };
}

function showSlice(i: number, startPrefetch = false) {
  const se = series();
  if (mpr) {
    showMpr(i);
    return;
  }
  sliceIdx = Math.max(0, Math.min(sliceCount - 1, i));
  const slider = $<HTMLInputElement>("slice");
  slider.value = String(sliceIdx);
  $("slice-label").textContent = `${sliceIdx + 1} / ${sliceCount}`;
  const { inst, frame } = sliceTarget(sliceIdx);
  const img = images!.peek(se, inst);
  $("stage-msg").classList.add("hidden");
  if (img) {
    draw(img, frame);
  } else {
    const want = { series: se.id, slice: sliceIdx };
    const plan = planInstances(se, inst);
    const total = plan.ciphertextEnd - plan.ciphertextStart;
    const progress = (r: number, t: number) => {
      if (series()?.id === want.series && sliceIdx === want.slice) stageBusy(`Loading the image · ${formatBytes(r)} of ${formatBytes(t)}`, r, t);
    };
    progress(0, total);
    images!
      .get(se, inst, { priority: Priority.Visible, onProgress: progress })
      .then((im) => {
        if (series()?.id !== want.series) return;
        if (sliceIdx === want.slice) draw(im, sliceTarget(sliceIdx).frame);
        else if (images!.peek(series(), sliceTarget(sliceIdx).inst)) showSlice(sliceIdx);
      })
      .catch((e) => {
        if ((e as any)?.name === "AbortError") return;
        if (series()?.id !== want.series || sliceIdx !== want.slice) return;
        sliceError(e);
      });
  }
  if (startPrefetch) prefetch();
  else nudgePrefetch();
}

/** The stage's waiting note: what it waits for, with a bar when the amount is known. */
function stageBusy(text: string, now?: number, total?: number) {
  $("stage-busy").classList.remove("hidden");
  $("stage-busy-text").textContent = text;
  const track = $("stage-track");
  track.classList.toggle("hidden", total === undefined);
  if (total !== undefined && now !== undefined) {
    track.setAttribute("aria-valuemax", String(total));
    track.setAttribute("aria-valuenow", String(Math.min(now, total)));
    track.setAttribute("aria-valuetext", text);
    $("stage-fill").style.width = `${total ? (100 * Math.min(now, total)) / total : 0}%`;
  }
}

function sliceError(e: unknown) {
  $("stage-busy").classList.add("hidden");
  const msg = $("stage-msg");
  if (e instanceof LinkError && (e.reason === "unavailable" || e.reason === "locked")) {
    showError(e);
    return;
  }
  if (e instanceof RecordAuthenticationError) {
    msg.textContent = "This image failed its integrity check and is not shown. The copy on the server may be damaged or altered.";
  } else if (e instanceof LinkError) {
    msg.textContent = describeError(e).title + ". " + describeError(e).body;
  } else {
    msg.textContent = `This image can't be displayed: ${(e as any)?.decoderMessage ?? (e as Error)?.message ?? e}`;
  }
  msg.classList.remove("hidden");
}

function draw(img: DecodedImage, frame: number) {
  const se = series();
  $("stage-busy").classList.add("hidden");
  // Single multi-frame instance: its frames become the slices.
  if (se.instances.length === 1 && img.frames > 1 && sliceCount !== img.frames) {
    sliceCount = img.frames;
    const slider = $<HTMLInputElement>("slice");
    slider.max = String(sliceCount - 1);
    slider.disabled = false;
    if (frame === 0) {
      showSlice(Math.floor(sliceCount / 2));
      return;
    }
  }
  // The display transform needs the header (its LUTs, windows, shape): draw once it is read.
  const hp = img.header && !imageHeaderNow(img) ? imageHeader(img) : null;
  if (hp) {
    void hp.then(() => draw(img, frame), () => draw(img, frame));
    return;
  }
  const k = Math.min(frame, img.frames - 1);
  if (autoWw === 0) initialDisplay(img, k);
  viewport!.show(img, k, { ...displayView(img, k), zoom, panX, panY }, displayFrame(img, k));
  shown = { img, frame: Math.min(frame, img.frames - 1), sop: se.instances[sliceTarget(sliceIdx).inst].uid };
  const t = iccs.get(img);
  iccInUse = t ? t.description || "embedded profile" : "";
  refreshLayers();
  cineFrame = frame;
  shownKey = `${se.id}/${sliceIdx}`;
  metrics.slices++;
  if (!metrics.marks["first-slice"]) {
    mark("first-slice");
    // Thumbnails for the strip once the first image is up.
    setTimeout(loadStripThumbs, 0);
  }
  updateHud(img);
  media.showingImage(se, sliceTarget(sliceIdx).inst, img.frames);
}

/** The value under the mouse pointer, shown in the bottom-left HUD. */
let cursorText = "";

/**
 * The value of image pixel (x, y) on screen: real-world value and units when the image has a
 * Real World Value Mapping, else the rescaled value (with its Rescale Type, e.g. HU).
 */
function valueAt(x: number, y: number): { value: number; units: string; text: string } | null {
  if (!shown || mpr || shown.img.samplesPerPixel !== 1) return null;
  const img = shown.img, k = shown.frame;
  if (x < 0 || y < 0 || x >= img.columns || y >= img.rows) return null;
  const f = frameOf(img, k);
  const rw = realWorldFor(img, k);
  const value = realValue(f.data[y * img.columns + x], rw, f);
  const units = rw ? unitText(rw.units) : seriesDisplay?.rescaleType && seriesDisplay.rescaleType !== "US" ? seriesDisplay.rescaleType : "";
  const label = rw?.label && rw.label !== rw.units ? `${rw.label} ` : "";
  return { value, units, text: `${label}${formatValue(value)}${units ? ` ${units}` : ""}` };
}

/** Image pixel under a client point (null off the image). */
function pixelAtClient(cx: number, cy: number): { x: number; y: number } | null {
  if (!viewport || !shown) return null;
  const r = viewport.canvas.getBoundingClientRect();
  const s = viewport.scale;
  const px = (cx - r.left) * s, py = (cy - r.top) * s;
  const cols = shown.img.columns, rows = shown.img.rows;
  const k = Math.min(viewport.canvas.width / cols, viewport.canvas.height / rows) * zoom;
  const x = Math.floor((px - viewport.canvas.width / 2 - panX) / k + cols / 2);
  const y = Math.floor((py - viewport.canvas.height / 2 - panY) / k + rows / 2);
  return x >= 0 && y >= 0 && x < cols && y < rows ? { x, y } : null;
}

function showCursorValue(cx: number | null, cy = 0) {
  const p = cx === null ? null : pixelAtClient(cx, cy);
  const v = p && valueAt(p.x, p.y);
  const text = v ? `${v.text} (${p!.x}, ${p!.y})` : "";
  if (text === cursorText) return;
  cursorText = text;
  updateHud();
}

function updateHud(img?: DecodedImage) {
  const se = series();
  const im = img ?? viewport?.image;
  $("hud-tl").textContent = `${se.description ?? modalityName(se.modality)}\n${se.modality ?? ""} · ${sliceIdx + 1}/${sliceCount}`;
  const wl = im?.float ? `W ${formatValue(ww)} L ${formatValue(wc)}` : `W ${Math.round(ww)} L ${Math.round(wc)}`;
  $("hud-tr").textContent = im ? `${im.columns}×${im.rows}\n${wl}` : "";
  const z = zoom > 1.01 || zoom < 0.99 ? `${zoom.toFixed(1)}×` : "";
  $("hud-bl").textContent = [z, cursorText].filter(Boolean).join("\n");
}

/** Fetch + decode around the current slice: ±1–3 Near, the rest Prefetch, nearest first. */
function prefetch() {
  const se = series();
  const signal = seriesAbort.signal;
  if (se.instances.length === 1) return;
  const n = se.instances.length;
  const c = sliceIdx;
  for (let d = 1; d < n; d++) {
    for (const i of [c + d, c - d]) {
      if (i < 0 || i >= n) continue;
      images!.get(se, i, { priority: d <= 3 ? Priority.Near : Priority.Prefetch, signal }).catch(() => {});
    }
  }
}

/** When the slice moves, raise the new neighbours to Near. */
function nudgePrefetch() {
  const se = series();
  if (se.instances.length === 1) return;
  for (let d = 1; d <= 3; d++) {
    for (const i of [sliceIdx + d, sliceIdx - d]) {
      if (i < 0 || i >= se.instances.length || images!.peek(se, i)) continue;
      images!.get(se, i, { priority: Priority.Near, signal: seriesAbort.signal }).catch(() => {});
    }
  }
}

// ------------------------------------------------------------------------------------- view changes

/** Whether the image on screen (or the reformatted volume) holds float pixel data. */
const isFloat = () => !!(shown?.img ?? mpr?.first)?.float;

function setWindow(c: number, w: number) {
  wc = c;
  // Float images are windowed in real values (LINEAR_EXACT), where any width above 0 is valid.
  ww = isFloat() ? Math.max(autoWw * 1e-4, w) : Math.max(1, w);
  if (currentPreset()?.lut !== undefined) {
    // Leaving a header VOI LUT for a window: redraw from the values.
    presetId = "custom";
    $<HTMLSelectElement>("preset").value = "";
    if (shown) draw(shown.img, shown.frame);
    return;
  }
  if (shown && seriesDisplay?.voiFunction === "SIGMOID" && currentPreset()?.lut === undefined) {
    // SIGMOID is drawn from the values (display.ts): redraw at most once per frame.
    if (!sigmoidPending) {
      sigmoidPending = true;
      requestAnimationFrame(() => {
        sigmoidPending = false;
        if (shown) draw(shown.img, shown.frame);
      });
    }
    updateHud();
    return;
  }
  viewport?.setView(shown ? displayView(shown.img, shown.frame) : (({ center, width }) => ({ windowCenter: center, windowWidth: width }))(linearWindow(isFloat() ? "LINEAR_EXACT" : "LINEAR", wc, ww)));
  updateHud();
}

// ------------------------------------------------------------------------------------- display pipeline

/** The series' window choices (wl.ts presetsFor, with the header's windows and VOI LUTs once read). */
let presetList: WindowPreset[] = [];
let sigmoidPending = false;
/** The first image's display model: decides the presets, VOI function and Presentation LUT Shape. */
let seriesDisplay: DisplayModel | null = null;
const frameCache = new WeakMap<DecodedImage, Map<string, Frame>>();

function currentPreset(): WindowPreset | undefined {
  return presetList.find((p) => p.id === presetId);
}

/** An image's parsed header (null when it has none, or before it is read). */
const headerNow = (img: DecodedImage) => imageHeaderNow(img)?.ds ?? null;

/** The series' presets, from its first image's display model. */
function seriesModel(m: DisplayModel | null) {
  if (seriesDisplay || !m) return;
  seriesDisplay = m;
  presetList = presetsFor(series().modality, m);
  fillPresets();
  $<HTMLSelectElement>("preset").value = presetId;
}

/** What the viewer's VOI is now: the chosen file VOI LUT, else the window (wc, ww). */
function voiNow(): VoiChoice {
  const lut = currentPreset()?.lut;
  return lut !== undefined ? { kind: "lut", index: lut } : { kind: "window", center: wc, width: ww };
}

/** The Real World Value Mapping of an image frame: from the header once read, else as the decoder reported it. */
function realWorldFor(img: DecodedImage, k: number): RealWorld | null {
  const h = imageHeaderNow(img);
  if (!h) return imageRealWorld(img);
  return realWorldOf(h.ds, (h.ds.num(T.NumberOfFrames) ?? 1) > 1 ? k : 0) ?? imageRealWorld(img);
}

/** The frame to draw (core/display.ts displayPlan; colour images through their ICC profile). */
function displayFrame(img: DecodedImage, k: number): Frame {
  if (img.samplesPerPixel === 3) return colourFrame(img, k) ?? frameOf(img, k);
  return displayPlan(img, k, headerNow(img), voiNow()).frame;
}

const iccs = new WeakMap<DecodedImage, IccTransform | null>();

/** An 8-bit RGB frame through its ICC profile (core/icc.ts), when the header carries one; else as decoded. */
function colourFrame(img: DecodedImage, k: number): Frame | undefined {
  if (img.bitsAllocated !== 8 || !iccOn) return undefined;
  let t = iccs.get(img);
  if (t === undefined) {
    const ds = imageHeaderNow(img)?.ds;
    const profile = ds?.raw(T.ICCProfile) ?? ds?.seq(tag(0x0048, 0x0105))[0]?.raw(T.ICCProfile) ?? null;
    t = profile ? iccToSrgb(profile) : null;
    iccs.set(img, t);
  }
  if (!t) return undefined;
  let cache = frameCache.get(img);
  if (!cache) frameCache.set(img, (cache = new Map()));
  let f = cache.get(`icc/${k}`);
  if (!f) {
    const base = frameOf(img, k);
    const data = new Uint8Array(base.data as Uint8Array);
    t.applyRgb(data, data.length / 3);
    f = { ...base, data, palette: null };
    cache.set(`icc/${k}`, f);
  }
  return f;
}

/** Whether ICC profiles are applied (the Layers sheet can turn them off), and the profile in use. */
let iccOn = true;
let iccInUse = "";

/** The renderer's window and inversion for the frame (displayPlan). */
function displayView(img: DecodedImage, k: number) {
  return displayPlan(img, k, headerNow(img), voiNow()).view;
}

function fillPresets() {
  const sel = $<HTMLSelectElement>("preset");
  sel.textContent = "";
  for (const p of presetList) {
    const o = el("option", undefined, p.label);
    o.value = p.id;
    sel.append(o);
  }
  sel.classList.toggle("hidden", presetList.length < 2);
}

function applyPreset(p: WindowPreset) {
  const wasLut = currentPreset()?.lut !== undefined;
  presetId = p.id;
  if (p.lut !== undefined || wasLut) {
    if (p.center !== null && p.width !== null) {
      wc = p.center;
      ww = p.width;
    } else if (p.lut === undefined && autoWw > 0) {
      wc = autoWc;
      ww = autoWw;
    }
    if (shown) draw(shown.img, shown.frame);
    return;
  }
  if (p.center === null || p.width === null) {
    if (autoWw > 0) setWindow(autoWc, autoWw);
  } else setWindow(p.center, p.width);
}

function setZoomPan(z: number, x: number, y: number) {
  zoom = Math.max(0.5, Math.min(12, z));
  // Keep part of the image on screen: at most this far from centred (canvas pixels).
  const f = viewport?.renderer.frame;
  if (viewport && f) {
    const cw = viewport.canvas.width, ch = viewport.canvas.height;
    const k = Math.min(cw / f.columns, ch / f.rows) * zoom;
    const keep = 64 * viewport.scale;
    const mx = Math.max(0, (f.columns * k + cw) / 2 - keep), my = Math.max(0, (f.rows * k + ch) / 2 - keep);
    x = Math.max(-mx, Math.min(mx, x));
    y = Math.max(-my, Math.min(my, y));
  }
  panX = x;
  panY = y;
  viewport?.setView({ zoom, panX, panY });
  updateHud();
}

/** Zoom by factor k keeping canvas point (px, py) fixed. */
function zoomAt(k: number, px: number, py: number) {
  const vp = viewport!;
  const z1 = Math.max(0.5, Math.min(12, zoom * k));
  const kk = z1 / zoom;
  const cx = vp.canvas.width / 2, cy = vp.canvas.height / 2;
  setZoomPan(z1, px - cx - (px - cx - panX) * kk, py - cy - (py - cy - panY) * kk);
}

/**
 * The display an image opens with: what the file's maker chose (its window, else its VOI LUT,
 * else a window over its values; displayPlan "auto"). The first draw of a series and Reset both
 * come here, so Reset returns exactly to the first view.
 */
function initialDisplay(img: DecodedImage, k: number) {
  const auto = displayPlan(img, k, headerNow(img), { kind: "auto" });
  seriesModel(auto.model);
  presetId = auto.lut !== null ? `lut-${auto.lut}` : "auto";
  $<HTMLSelectElement>("preset").value = presetId;
  // With a VOI LUT, dragging starts from the full range; colour images have the identity.
  const w = auto.window ?? displayPlan(img, k, headerNow(img), { kind: "minmax" }).window ?? { center: 128, width: 256 };
  autoWc = wc = w.center;
  autoWw = ww = w.width;
}

/** Reset: the first view of the image on screen (initialDisplay), at fit with no pan. */
function resetView() {
  zoom = 1;
  panX = 0;
  panY = 0;
  if (mpr) {
    wc = autoWc;
    ww = autoWw;
    showMpr(sliceIdx);
  } else if (shown) {
    initialDisplay(shown.img, shown.frame);
    draw(shown.img, shown.frame);
  } else viewport?.setView({ zoom, panX, panY });
  updateHud();
}

function stepSlice(d: number) {
  if (sliceCount <= 1) return;
  const next = Math.max(0, Math.min(sliceCount - 1, sliceIdx + d));
  if (next !== sliceIdx) showSlice(next);
}

// ------------------------------------------------------------------------------------- gestures

function wireGestures() {
  const stage = $("stage");
  type P = { x: number; y: number; x0: number; y0: number; type: string; button: number };
  const pts = new Map<number, P>();
  let mode: "none" | "slice" | "wl" | "pan" | "pinch" | "two" = "none";
  let carry = 0;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTap = 0;
  let pinchD0 = 0, pinchZ0 = 1, mid0x = 0, mid0y = 0, pan0x = 0, pan0y = 0;
  const STEP_PX = 9;
  const wlGain = () => (isFloat() ? ww / 220 : Math.max(0.5, ww / 220));

  const canvasPoint = (x: number, y: number) => {
    const r = viewport!.canvas.getBoundingClientRect();
    const s = viewport!.scale;
    return [(x - r.left) * s, (y - r.top) * s] as const;
  };

  // The object view (reports, documents, waveforms…) sits in the stage and takes its own input.
  const inObject = (e: Event) => !!objectView?.active && (e.target as Element | null)?.closest?.(".object-view");
  let lastMeasureTap = 0;
  stage.addEventListener("pointerdown", (e) => {
    if (!viewport || slideView?.active || inObject(e)) return;
    if (measure?.active) {
      stage.setPointerCapture(e.pointerId);
      const now = performance.now();
      measure.pointer("down", e.clientX, e.clientY, now - lastMeasureTap < 350);
      lastMeasureTap = now;
      return;
    }
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, type: e.pointerType, button: e.button });
    carry = 0;
    if (e.pointerType === "mouse") {
      mode = e.button === 1 || e.button === 2 || e.shiftKey ? "pan" : "wl";
      return;
    }
    if (pts.size === 1) {
      const now = performance.now();
      if (now - lastTap < 300) {
        resetView();
        lastTap = 0;
        mode = "none";
        return;
      }
      lastTap = now;
      // One finger pans a zoomed image, or an image with nothing to step through; else steps slices.
      mode = zoom > 1.01 || sliceCount <= 1 ? "pan" : "slice";
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        const p = pts.get(e.pointerId);
        if (pts.size === 1 && p && Math.hypot(p.x - p.x0, p.y - p.y0) < 8) {
          mode = "wl";
          navigator.vibrate?.(10);
        }
      }, 420);
    } else if (pts.size === 2) {
      if (holdTimer) clearTimeout(holdTimer);
      const [a, b] = [...pts.values()];
      pinchD0 = Math.hypot(b.x - a.x, b.y - a.y);
      pinchZ0 = zoom;
      mid0x = (a.x + b.x) / 2;
      mid0y = (a.y + b.y) / 2;
      pan0x = panX;
      pan0y = panY;
      mode = "two";
      lastTap = 0;
    }
  });

  stage.addEventListener("pointermove", (e) => {
    if (slideView?.active) return;
    if (measure?.active) {
      measure.pointer("move", e.clientX, e.clientY);
      return;
    }
    if (!pts.size && e.pointerType === "mouse") {
      showCursorValue(e.clientX, e.clientY);
      return;
    }
    const p = pts.get(e.pointerId);
    if (!p || !viewport) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (holdTimer && Math.hypot(p.x - p.x0, p.y - p.y0) > 8) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (mode === "wl") {
      setWindow(wc - dy * wlGain(), ww + dx * wlGain());
      presetId = "custom";
      return;
    }
    if (mode === "pan" && (pts.size === 1 || p.type === "mouse")) {
      const s = viewport.scale;
      setZoomPan(zoom, panX + dx * s, panY + dy * s);
      return;
    }
    if (mode === "slice" && pts.size === 1) {
      carry += dy;
      const steps = Math.trunc(carry / STEP_PX);
      if (steps) {
        carry -= steps * STEP_PX;
        stepSlice(steps);
      }
      return;
    }
    if ((mode === "two" || mode === "pinch") && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (mode === "two") {
        // Decide once per gesture: fingers spreading/closing → pinch; moving together → window/level.
        if (Math.abs(d - pinchD0) > 24) mode = "pinch";
        else if (Math.hypot(mx - mid0x, my - mid0y) > 16) {
          mode = "wl";
          return;
        } else return;
      }
      if (mode === "pinch" && pinchD0 > 10) {
        const s = viewport.scale;
        const k = d / pinchD0;
        const [px, py] = canvasPoint(mid0x, mid0y);
        const cx = viewport.canvas.width / 2, cy = viewport.canvas.height / 2;
        const z1 = Math.max(0.5, Math.min(12, pinchZ0 * k));
        const kk = z1 / pinchZ0;
        setZoomPan(z1, px - cx - (px - cx - pan0x) * kk + (mx - mid0x) * s, py - cy - (py - cy - pan0y) * kk + (my - mid0y) * s);
      }
    }
  });

  const end = (e: PointerEvent) => {
    if (measure?.active && e.type === "pointerup") measure.pointer("up", e.clientX, e.clientY);
    pts.delete(e.pointerId);
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (pts.size === 0) mode = "none";
    else if (pts.size === 1 && (mode === "pinch" || mode === "two" || mode === "wl")) mode = "none";
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("pointerleave", () => showCursorValue(null));
  stage.addEventListener("contextmenu", (e) => {
    if (!inObject(e)) e.preventDefault();
  });
  stage.addEventListener("dblclick", (e) => {
    if (!slideView?.active && !inObject(e)) resetView();
  });
  stage.addEventListener(
    "wheel",
    (e) => {
      if (inObject(e)) return;
      e.preventDefault();
      if (!viewport || slideView?.active) return;
      if (e.ctrlKey || e.metaKey) {
        const [px, py] = canvasPoint(e.clientX, e.clientY);
        zoomAt(Math.exp(-e.deltaY * 0.01), px, py);
        return;
      }
      if (Math.abs(e.deltaY) < 1) return;
      stepSlice(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false },
  );
  stage.addEventListener("keydown", (e) => {
    if (inObject(e)) return;
    if (slideView?.active) {
      if (slideView.key(e)) e.preventDefault();
      return;
    }
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowRight" || k === "PageDown") stepSlice(k === "PageDown" ? 5 : 1);
    else if (k === "ArrowUp" || k === "ArrowLeft" || k === "PageUp") stepSlice(k === "PageUp" ? -5 : -1);
    else if (k === "Home") showSlice(0);
    else if (k === "End") showSlice(sliceCount - 1);
    else if (k === "r" || k === "0") resetView();
    else if (k === "+" || k === "=") zoomAt(1.25, viewport!.canvas.width / 2, viewport!.canvas.height / 2);
    else if (k === "-") zoomAt(0.8, viewport!.canvas.width / 2, viewport!.canvas.height / 2);
    else return;
    e.preventDefault();
  });
}

// ------------------------------------------------------------------------------------- sheets

let openSheetId: string | null = null;
let exportAbort: AbortController | null = null;

function openSheet(id: string) {
  closeSheet();
  openSheetId = id;
  $("sheet-backdrop").classList.remove("hidden");
  $(id).classList.remove("hidden");
  ($(id).querySelector("button") as HTMLElement | null)?.focus({ preventScroll: true });
}

function closeSheet() {
  if (!openSheetId) return;
  if (exportAbort) return; // finish or cancel the download first
  $(openSheetId).classList.add("hidden");
  $("sheet-backdrop").classList.add("hidden");
  openSheetId = null;
}

interface DownloadChoice {
  id: "image" | "series" | "study" | "all";
  title: string;
  detail: string;
  bytes: number;
  /** Why the choice is not available here (shown greyed out). */
  disabled?: string;
  run: () => void;
}

/** The stored instance on screen, or why there is none (a reformat, a slide). Null with no series open. */
function instanceOnScreen(): { se: SeriesEntry; i: number } | { reason: string } | null {
  const se = studyIdx >= 0 && seriesIdx >= 0 ? study()?.series[seriesIdx] : undefined;
  if (!se) return null;
  if (objectView?.active && objectView.series === se) return { se, i: objectView.index };
  if (mpr) return { reason: "Reformatted in the viewer; not a stored image." };
  if (isSlideSeries(se)) return { reason: "A slide is stored as several files, one per magnification; the series has them all." };
  const { inst } = sliceTarget(sliceIdx);
  return inst >= 0 && inst < se.instances.length ? { se, i: inst } : null;
}

/**
 * What can be downloaded from the view on screen, with sizes: this study (the default), this
 * series, this image, everything shared. Only stored files: a view made in the viewer offers its
 * source series and study, and "This image" greyed out with the reason. Defined for every view state.
 */
function downloadChoices(forStudy?: StudyEntry): { choices: DownloadChoice[]; def: DownloadChoice | null } {
  const choices: DownloadChoice[] = [];
  // From a study card: that study (and everything shared); in the viewer: what is open.
  const st = forStudy ?? (share && studyIdx >= 0 ? study() : undefined);
  if (st && st.series.length) {
    const n = exportSize({ kind: "study", study: st });
    choices.push({ id: "study", title: "This study", detail: `${studyTitle(st)} · ${plural(n.files, "file")} · ${formatBytes(n.bytes)} · ZIP with DICOMDIR`, bytes: n.bytes, run: () => void runZip({ kind: "study", study: st }) });
  }
  const se = !forStudy && st && seriesIdx >= 0 ? st.series[seriesIdx] : undefined;
  if (st && se) {
    const n = exportSize({ kind: "series", study: st, series: se });
    choices.push({ id: "series", title: "This series", detail: `${se.description ?? modalityName(se.modality)} · ${plural(n.files, "file")} · ${formatBytes(n.bytes)} · ZIP with DICOMDIR`, bytes: n.bytes, run: () => void runZip({ kind: "series", study: st, series: se }) });
  }
  const on = forStudy ? null : instanceOnScreen();
  if (on && "reason" in on) choices.push({ id: "image", title: "This image", detail: on.reason, bytes: 0, disabled: on.reason, run: () => {} });
  else if (on) {
    const inst = on.se.instances[on.i];
    const kind = kindOf(on.se);
    const what = kind === "image" || kind === "pmap" ? "This image" : kind === "video" ? "This video" : "This file";
    choices.push({ id: "image", title: what, detail: `One DICOM file (.dcm) · ${formatBytes(inst.length)}`, bytes: inst.length, run: () => void runOne(on.se, on.i) });
  }
  const studies = share ? share.index.studies.filter((x) => x.series.length) : [];
  if (studies.length) {
    const n = exportSize({ kind: "all", studies });
    choices.push({ id: "all", title: "Everything shared", detail: `${plural(studies.length, "study", "studies")} · ${plural(n.files, "file")} · ${formatBytes(n.bytes)} · ZIP with DICOMDIR`, bytes: n.bytes, run: () => void runZip({ kind: "all", studies }) });
  }
  return { choices, def: choices.find((c) => c.id === "study") ?? choices.find((c) => c.id === "all") ?? null };
}

/** The split button: its main part saves the default choice (the study) and shows its size. */
function updateDownloadButton() {
  const { def } = downloadChoices();
  const word = def?.id === "study" ? "study" : "all";
  $("dl-text").textContent = def ? `Download ${word}` : "Download";
  $("dl-size").textContent = def ? formatBytes(def.bytes) : "";
  $("btn-download").setAttribute("aria-label", def ? `Download ${word === "all" ? "everything shared" : "this study"}, ${formatBytes(def.bytes)}` : "Download");
  ($("btn-download") as HTMLButtonElement).disabled = !def;
}

function downloadDefault() {
  const { def } = downloadChoices();
  if (!def) return;
  openDownloadSheet(false);
  def.run();
}

/** The download menu: every choice with its size. `list` false opens it straight on the progress of a choice. */
function openDownloadSheet(list = true, forStudy?: StudyEntry) {
  const opts = $("dl-options");
  opts.textContent = "";
  $("dl-progress").classList.add("hidden");
  opts.classList.toggle("hidden", !list);
  for (const c of downloadChoices(forStudy).choices) {
    const b = el("button", "dl-option");
    b.type = "button";
    b.dataset.choice = c.id;
    if (c.disabled) {
      b.disabled = true;
      b.dataset.reason = c.disabled;
    } else b.dataset.bytes = String(c.bytes);
    b.append(el("strong", undefined, c.title), el("span", undefined, c.detail));
    b.addEventListener("click", c.run);
    opts.append(b);
  }
  openSheet("sheet-download");
}

/** The download bar: bytes written against the total, with the text that says so. */
function setDownloadProgress(bytes: number, total: number, text: string) {
  const track = $("dl-track");
  track.setAttribute("aria-valuemax", String(total));
  track.setAttribute("aria-valuenow", String(bytes));
  track.setAttribute("aria-valuetext", `${formatBytes(bytes)} of ${formatBytes(total)}`);
  $("dl-bar").style.width = `${(100 * bytes) / Math.max(1, total)}%`;
  $("dl-status").textContent = text;
}

async function runZip(scope: ExportScope) {
  const name = (scope.kind === "all" ? "shared-imaging" : exportBaseName(scope.study, scope.kind === "series" ? scope.series : undefined)) + ".zip";
  // Ask for the file first, while the click still counts as a user gesture.
  const target = await openSaveTarget(name, "application/zip", ".zip");
  if (!target) return;
  exportAbort = new AbortController();
  $("dl-options").classList.add("hidden");
  $("dl-progress").classList.remove("hidden");
  $("btn-dl-cancel").classList.remove("hidden");
  const status = $("dl-status");
  try {
    await exportZip(
      scope,
      share!.loader,
      target,
      (p) => setDownloadProgress(p.bytes, p.totalBytes, `Saving · ${formatBytes(p.bytes)} of ${formatBytes(p.totalBytes)} · ${plural(p.files, "file")} saved`),
      exportAbort.signal,
    );
    status.textContent = `Saved ${name}`;
    (globalThis as any).__view.lastExport = name;
  } catch (e) {
    status.textContent = (e as any)?.name === "AbortError" ? "Cancelled." : `The download stopped: ${describeError(e).title}.`;
  } finally {
    exportAbort = null;
    $("btn-dl-cancel").classList.add("hidden");
  }
}

async function runOne(se: SeriesEntry, i: number) {
  const name = `${se.instances[i].uid}.dcm`;
  const target = await openSaveTarget(name, "application/dicom", ".dcm");
  if (!target) return;
  $("dl-options").classList.add("hidden");
  $("dl-progress").classList.remove("hidden");
  $("btn-dl-cancel").classList.add("hidden");
  const plan = planInstances(se, i);
  const total = plan.ciphertextEnd - plan.ciphertextStart;
  setDownloadProgress(0, total, `Saving · ${formatBytes(0)} of ${formatBytes(total)}`);
  try {
    const bytes = await exportInstance(share!.loader, se, i, (r, t) => setDownloadProgress(r, t, `Saving · ${formatBytes(r)} of ${formatBytes(t)}`));
    await target.write(bytes);
    await target.close();
    setDownloadProgress(total, total, `Saved ${name}`);
  } catch (e) {
    await target.abort(e).catch(() => {});
    $("dl-status").textContent = `The download stopped: ${describeError(e).title}.`;
  }
}

function openTrustSheet() {
  const dl = $("trust-facts");
  dl.textContent = "";
  const fact = (t: string, d: string) => dl.append(el("dt", undefined, t), el("dd", undefined, d));
  const idx = share!.index;
  const shared = [resolver?.label ? `Labelled “${resolver.label}” by the sender.` : "The sender gave this link no label."];
  if (idx.lastUpdated) shared.push(`Last updated ${formatDate(idx.lastUpdated)}.`);
  fact("Shared with you", shared.join(" "));
  fact(
    "Encrypted",
    "The server sends this share only as encrypted files. The key that opens them is in your link, after the #, a part browsers never send to servers.",
  );
  const checked =
    failedRecords > 0
      ? `${failedRecords} piece${failedRecords === 1 ? "" : "s"} failed the check and ${failedRecords === 1 ? "was" : "were"} not shown.`
      : `${plural(verifiedRecords, "piece")} checked so far, none altered.`;
  fact(
    "Checked",
    `Your browser checks every 64 KB piece it downloads (AES-256-GCM) before using it. A changed byte is refused, not shown. ${checked}`,
  );
  fact("Not checked", "The link does not prove who sent it. If you're unsure, ask the sender.");
  openSheet("sheet-trust");
}

// ------------------------------------------------------------------------------------- wiring

function wireStatic() {
  $("passcode-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $<HTMLInputElement>("input-passcode").value.trim();
    if (!code) {
      $("passcode-msg").textContent = "Enter the passcode first.";
      return;
    }
    $<HTMLButtonElement>("btn-passcode").disabled = true;
    void open(code);
  });
  $("btn-retry").addEventListener("click", () => retryAction?.());
  $("btn-paste-other").addEventListener("click", () => {
    $("paste-form").classList.remove("hidden");
    $("btn-paste-other").classList.add("hidden");
    $<HTMLInputElement>("input-link").focus();
  });
  $("paste-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $<HTMLInputElement>("input-link").value;
    const link = extractShlink(v);
    if (!link) {
      $<HTMLInputElement>("input-link").setCustomValidity("That doesn't contain a SMART Health Link (shlink:/…).");
      $<HTMLInputElement>("input-link").reportValidity();
      return;
    }
    location.hash = link;
  });
  $<HTMLInputElement>("input-link").addEventListener("input", () => $<HTMLInputElement>("input-link").setCustomValidity(""));
  // The current sample (its link changes when the server re-seeds it).
  $("btn-sample").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("btn-sample");
    btn.disabled = true;
    try {
      const pub = (await fetchSampleLinks(await loadConfig())).find((s) => !s.passcodeHint && s.shlink);
      if (!pub) throw new Error("no sample");
      location.hash = pub.shlink;
    } catch {
      btn.disabled = false;
      btn.textContent = "The sample isn't available right now";
    }
  });
  window.addEventListener("hashchange", () => location.reload());
  $("btn-back").addEventListener("click", () => {
    if ((history.state as any)?.screen === "viewer") history.back();
    else {
      history.replaceState({ screen: "overview" }, "");
      showOverview();
    }
  });
  window.addEventListener("popstate", (e) => {
    if (!share) return;
    const st = e.state as { screen?: string; study?: number } | null;
    closeSheetForce();
    if (st?.screen === "viewer" && typeof st.study === "number") openStudy(st.study, false);
    else showOverview();
  });
  $<HTMLInputElement>("slice").addEventListener("input", (e) => showSlice(Number((e.target as HTMLInputElement).value)));
  $<HTMLSelectElement>("preset").addEventListener("change", (e) => {
    const p = presetList.find((x) => x.id === (e.target as HTMLSelectElement).value);
    if (p) applyPreset(p);
  });
  $("btn-reset").addEventListener("click", () => (slideView?.active ? slideView.fit() : resetView()));
  $("btn-label").addEventListener("click", () => void openLabelSheet());
  $("btn-download").addEventListener("click", downloadDefault);
  $("btn-download-menu").addEventListener("click", () => openDownloadSheet());
  $("btn-trust").addEventListener("click", openTrustSheet);
  $("btn-report").addEventListener("click", () => ($("report-panel").classList.contains("hidden") ? openReports(studyReports()) : closeReports()));
  $("btn-report-close").addEventListener("click", closeReports);
  $("btn-layers").addEventListener("click", openLayersSheet);
  $<HTMLSelectElement>("view-plane").addEventListener("change", (e) => void enterMpr((e.target as HTMLSelectElement).value as Plane | ""));
  $("btn-plane-opts").addEventListener("click", openPlaneSheet);
  for (const id of ["plane-turn", "plane-tilt", "slab-thickness", "slab-mode"]) $(id).addEventListener("input", applyPlaneSheet);
  $("plane-reset").addEventListener("click", () => {
    $<HTMLInputElement>("plane-turn").value = "0";
    $<HTMLInputElement>("plane-tilt").value = "0";
    $<HTMLSelectElement>("slab-thickness").value = "0";
    applyPlaneSheet();
  });
  $<HTMLSelectElement>("measure-tool").addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === "clear") {
      measure?.clear();
      (e.target as HTMLSelectElement).value = measure?.tool ?? "";
      return;
    }
    if (measure) measure.tool = (v || null) as Tool | null;
    document.body.classList.toggle("measuring", !!v);
    $("hud-br").textContent = v ? "Click or tap on the image to measure." : "";
  });
  $("sheet-backdrop").addEventListener("click", closeSheet);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSheet));
  $("btn-dl-cancel").addEventListener("click", () => exportAbort?.abort());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSheet();
  });
  wireGestures();
}

function closeSheetForce() {
  exportAbort?.abort();
  exportAbort = null;
  closeSheet();
}

// Expose a few hooks for scripted checks (no behaviour depends on them).
(globalThis as any).__viewHooks = {
  state: () => ({ studyIdx, seriesIdx, sliceIdx, sliceCount, wc, ww, zoom, panX, panY, presetId, renderer: viewport?.kind }),
  showSlice,
  setWindow,
  /**
   * Compares what is on screen, rendered at the image's own size (CPU reference, same pixels as
   * the GPU path), with a reference rendering (an image URL): per-pixel grey-level differences.
   */
  compareWith: async (url: string) => {
    let frame: Frame, view;
    if (mpr) {
      frame = mpr.frame ?? reformat(mpr.volume, mpr.grid, sliceIdx, mpr.slab).frame;
      const w = linearWindow(mpr.first.float ? "LINEAR_EXACT" : "LINEAR", wc, ww);
      view = { windowCenter: w.center, windowWidth: w.width };
    } else {
      if (!shown) return null;
      frame = displayFrame(shown.img, shown.frame) ?? frameOf(shown.img, shown.frame);
      view = displayView(shown.img, shown.frame);
    }
    const w = frame.columns, h = frame.rows;
    const ours = renderCpu(frame, { ...defaultView(), ...view, fit: "none", zoom: 1, panX: 0, panY: 0, interpolation: "nearest" }, w, h);
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    if (bmp.width !== w || bmp.height !== h) return { error: `reference is ${bmp.width}×${bmp.height}, image is ${w}×${h}` };
    const c = new OffscreenCanvas(w, h).getContext("2d")!;
    c.drawImage(bmp, 0, 0);
    const ref = c.getImageData(0, 0, w, h).data;
    let max = 0, sum = 0, over = 0;
    for (let i = 0; i < w * h; i++) {
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(ours[i * 4 + k] - ref[i * 4 + k]);
        if (d > max) max = d;
        sum += d;
        if (d > 2) over++;
      }
    }
    return { w, h, max, mean: sum / (w * h * 3), over2: over / (w * h * 3) };
  },
  /** Window to the frame's full value range after the Modality LUT and rescale (DICOM viewers' "min–max"). */
  minMaxWindow: () => {
    if (!shown) return;
    presetId = "custom";
    const w = displayPlan(shown.img, shown.frame, headerNow(shown.img), { kind: "minmax" }).window;
    if (w) setWindow(w.center, w.width);
  },
  /** The overlay planes drawn now, as a mask, and the counts. */
  overlayMask: () => {
    const m = layers?.planeMask();
    if (!m) return null;
    let n = 0;
    for (const v of m) n += v;
    return { set: n, size: m.length, mask: Array.from(m) };
  },
  presets: () => presetList.map((p) => ({ id: p.id, label: p.label })),
  applyPresetId: (id: string) => {
    const p = presetList.find((x) => x.id === id);
    if (p) {
      $<HTMLSelectElement>("preset").value = id;
      applyPreset(p);
    }
  },
  enterMpr: (plane: Plane | "", opts?: { turn?: number; tilt?: number; slab?: Slab }) => enterMpr(plane, opts),
  /** The reformatted plane on screen: its pixel grid in patient space, the time it took, the volume's lattice. */
  mprState: () =>
    mpr && {
      spec: mpr.spec,
      ms: mpr.ms,
      engine: mpr.engine,
      count: mpr.grid.count,
      label: planeLabel(mpr),
      hud: $("hud-tl").textContent,
      volume: { origin: mpr.volume.origin, rowDir: mpr.volume.rowDir, colDir: mpr.volume.colDir, step: mpr.volume.step, spacing: mpr.volume.spacing, tilt: mpr.volume.tilt },
    },
  /**
   * Reformat speed on a synthetic volume (cols × rows × depth, 16-bit), in ms per plane: the middle
   * plane of each orientation, thin and with a 20 mm MIP slab.
   */
  /** Forces the CPU or GPU path for reformats ("auto": GPU when the viewer draws with WebGL2). */
  setMprEngine: (e: "auto" | "cpu" | "gpu") => {
    mprEngine = e;
    if (mpr) showMpr(sliceIdx);
    return mpr?.engine ?? null;
  },
  mprPerf: (cols: number, rows: number, depth: number, engine: "cpu" | "gpu" = "cpu") => {
    const slices: Frame[] = [];
    for (let k = 0; k < depth; k++) {
      const data = new Int16Array(cols * rows);
      for (let i = 0; i < data.length; i++) data[i] = ((i * 7 + k * 13) % 2000) - 1000;
      slices.push({ rows, columns: cols, samplesPerPixel: 1, bitsAllocated: 16, bitsStored: 16, signed: true, photometric: "MONOCHROME2", rescaleSlope: 1, rescaleIntercept: 0, data });
    }
    const vol = makeVolume(slices, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0.7, 0.7], [0, 0, 0.625]);
    const out: Record<string, number> = {};
    const t0 = performance.now();
    const gpu = engine === "gpu" ? GpuReformatter.create(vol) : null;
    if (engine === "gpu") {
      if (!gpu) return { error: "no GPU path" };
      out["upload (once)"] = Math.round(performance.now() - t0);
    }
    const run = (g: PlaneGrid, i: number, slab?: Slab) => (gpu ? gpu.reformat(g, i, slab) : reformat(vol, g, i, slab));
    const time = (name: string, o: Orientation, slab?: Slab) => {
      const g = planeGrid(vol, o);
      run(g, Math.floor(g.count / 2), slab);
      const t0 = performance.now();
      for (let r = 0; r < 3; r++) run(g, Math.floor(g.count / 2) + r, slab);
      out[name] = Math.round(((performance.now() - t0) / 3) * 10) / 10;
    };
    time("sagittal", { plane: "sagittal", turn: 0, tilt: 0 });
    time("coronal", { plane: "coronal", turn: 0, tilt: 0 });
    time("axial", { plane: "axial", turn: 0, tilt: 0 });
    time("oblique 20°/15°", { plane: "sagittal", turn: 20, tilt: 15 });
    time("sagittal MIP 20 mm", { plane: "sagittal", turn: 0, tilt: 0 }, { thickness: 20, mode: "mip" });
    time("axial average 10 mm", { plane: "axial", turn: 0, tilt: 0 }, { thickness: 10, mode: "avg" });
    gpu?.destroy();
    return out;
  },
  measureLength: (x0: number, y0: number, x1: number, y1: number) => measure?.measureAt(x0, y0, x1, y1) ?? null,
  /** The value at image pixel (x, y) of the frame on screen, as the cursor readout shows it. */
  valueAt,
  /** Image pixel under a client point. */
  pixelAtClient,
  /**
   * The image on screen as the viewer draws it, at w × h (fit, linear), as grey levels: for
   * comparing with its thumbnail (same file, same display transform).
   */
  renderShown: (w: number, h: number) => {
    let out: Uint8ClampedArray | Uint8Array;
    let colour = false;
    if (mpr?.frame) {
      const e = linearWindow(mpr.first.float ? "LINEAR_EXACT" : "LINEAR", wc, ww);
      out = renderCpu(mpr.frame, { ...defaultView(), windowCenter: e.center, windowWidth: e.width, interpolation: "linear" }, w, h);
    } else if (shown) {
      out = renderCpu(displayFrame(shown.img, shown.frame), { ...defaultView(), ...displayView(shown.img, shown.frame), interpolation: "linear" }, w, h);
      colour = shown.img.samplesPerPixel === 3;
    } else return null;
    return { grey: Array.from({ length: w * h }, (_, i) => out[i * 4]), colour };
  },
  /** How much of the image is on screen (canvas pixels, across and down), after zoom and pan. */
  imageOnScreen: () => {
    const f = viewport?.renderer.frame;
    if (!viewport || !f) return null;
    const cw = viewport.canvas.width, ch = viewport.canvas.height;
    const k = Math.min(cw / f.columns, ch / f.rows) * zoom;
    const x0 = cw / 2 + panX - (f.columns * k) / 2, y0 = ch / 2 + panY - (f.rows * k) / 2;
    return { x: Math.max(0, Math.min(cw, x0 + f.columns * k) - Math.max(0, x0)), y: Math.max(0, Math.min(ch, y0 + f.rows * k) - Math.max(0, y0)), scale: viewport.scale };
  },
  /** What is open, for the download checks: study and series UIDs, and the stored instance on screen (or why there is none). */
  current: () => {
    const on = instanceOnScreen();
    return {
      study: studyIdx >= 0 ? study()?.studyInstanceUid ?? null : null,
      series: studyIdx >= 0 && seriesIdx >= 0 ? study()?.series[seriesIdx]?.uid ?? null : null,
      onScreen: on && "reason" in on ? { reason: on.reason } : on ? { uid: on.se.instances[on.i].uid } : null,
      mpr: mpr?.orient.plane ?? null,
    };
  },
  /** Client point at the centre of image pixel (x, y). */
  clientAt: (x: number, y: number) => {
    if (!viewport || !shown) return null;
    const r = viewport.canvas.getBoundingClientRect();
    const cols = shown.img.columns, rows = shown.img.rows;
    const k = Math.min(viewport.canvas.width / cols, viewport.canvas.height / rows) * zoom;
    const px = viewport.canvas.width / 2 + panX + (x + 0.5 - cols / 2) * k, py = viewport.canvas.height / 2 + panY + (y + 0.5 - rows / 2) * k;
    return { x: r.left + px / viewport.scale, y: r.top + py / viewport.scale };
  },
  /** Index of a SOP instance in the current series (-1 if absent). */
  instanceIndex: (sop: string) => series().instances.findIndex((i) => i.uid === sop),
  /** Slices of the current series already decoded and cached. */
  cached: () => (share && seriesIdx >= 0 ? series().instances.filter((_, i) => images!.peek(series(), i)).length : 0),
  saveBlob,
};

/** Slide view hooks for scripted checks. */
(globalThis as any).__wsi = slideHooks(() => slideView);

void boot();
