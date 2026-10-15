// View: the recipient's viewer at /view#shlink:/… (also usable as a bare viewer prefix).
//
// Screens: loading → passcode (P links) → study overview → viewer. Errors replace everything with
// one message. History: the overview and the viewer are separate history entries, so Back on a
// phone returns from the viewer to the overview.
import {
  extractShlink,
  formatBytes,
  formatDate,
  formatPersonName,
  InvalidBundleError,
  InvalidLinkError,
  LinkError,
  LinkResolver,
  loadConfig,
  modalityName,
  openShare,
  PasscodeError,
  pickInitialSeries,
  plural,
  reportsForStudy,
  studyTitle,
  FetchPriority,
  decryptFromQuery,
  RecordAuthenticationError,
  type OpenShare,
  type SeriesEntry,
  type StudyEntry,
} from "../core/index";
import { getDecoderPool, ImageStore, Priority, type DecodedImage } from "../core/images";
import { drawThumbnail, Viewport } from "../core/render";
import { autoWindow, presetsFor, type WindowPreset } from "../core/wl";
import { exportBaseName, exportInstance, exportSize, exportZip, type ExportScope } from "../core/export";
import { openSaveTarget, saveBlob } from "../core/save";
import { isSlideSeries } from "../core/wsi";
import { drawSlideThumbnail, slideSession, SlideView, type SlideSession } from "./wsi-view";

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
  $("btn-download").classList.toggle("hidden", !(inViewer && share));
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

/** Thumbnail of a series: the middle image, or for a slide its coarsest pyramid level. */
function seriesThumb(canvas: HTMLCanvasElement, se: SeriesEntry, priority: number, signal?: AbortSignal): Promise<void> {
  if (isSlideSeries(se)) return slideFor(se).then((ss) => drawSlideThumbnail(canvas, ss, signal));
  const mid = Math.floor(se.instances.length / 2);
  return images!.get(se, mid, { priority, signal }).then((img) => drawThumbnail(canvas, img, Math.floor(img.frames / 2)));
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
    const cfg = await Promise.race([loadConfig(), new Promise<null>((r) => setTimeout(() => r(null), 300))]);
    share = await openShare(resolver!, {
      passcode,
      decrypt: cfg?.decrypt ?? decryptFromQuery(),
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
}

// ------------------------------------------------------------------------------------- overview

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
    text.append(el("p", "study-tech", `${plural(st.numberOfSeries, "series", "series")} · ${plural(st.numberOfInstances, "image")} · ${formatBytes(st.bytes)}`));
    for (const n of st.notes) text.append(el("p", "study-tech", n));
    text.append(el("span", "open-hint", "Open"));
    openBtn.append(thumb, text);
    openBtn.addEventListener("click", () => openStudy(si));
    card.append(openBtn);

    for (const r of reportsForStudy(idx, st)) card.append(reportBlock(r));
    const actions = el("div", "study-actions");
    const dl = el("button", "btn", "Download originals");
    dl.type = "button";
    dl.addEventListener("click", () => openDownloadSheet({ kind: "study", study: st }, false));
    actions.append(dl);
    card.append(actions);
    list.append(card);

    // Thumbnail: middle slice of the series the study opens on (also warms the viewer).
    const se = st.series[pickInitialSeries(st)];
    seriesThumb(thumb, se, Priority.Visible)
      .then(() => mark("first-thumb"))
      .catch(() => {});
  });
  // Reports not tied to a study.
  const loose = idx.reports.filter((r) => !r.studyIds.some((id) => idx.studies.some((s) => s.id === id)));
  if (loose.length) {
    const card = el("article", "card study-card");
    for (const r of loose) card.append(reportBlock(r));
    list.append(card);
  }
  mark("overview");
}

function reportBlock(r: { title: string | null; conclusion: string | null; text: string | null; issued: string | null; status: string }) {
  const box = el("section", "report");
  box.append(el("h3", undefined, [r.title ?? "Report", r.issued ? formatDate(r.issued) : null, r.status === "preliminary" ? "preliminary" : null].filter(Boolean).join(" · ")));
  const summary = r.conclusion ?? r.text?.split(/\n\s*\n/)[0] ?? "";
  box.append(el("p", undefined, summary || "No summary in the report."));
  if (r.text && r.text !== summary) {
    const det = el("details");
    det.append(el("summary", undefined, "Full report"));
    det.append(el("p", undefined, r.text));
    box.append(det);
  }
  return box;
}

function showOverview() {
  show("overview");
  document.body.classList.add("scrolling");
  $("top-kicker").textContent = "";
  $("top-title").textContent = sharedLine;
  seriesAbort.abort();
  studyAbort.abort();
  leaveSlide();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------------------------- viewer

function openStudy(si: number, push = true) {
  if (push) history.pushState({ screen: "viewer", study: si }, "");
  document.body.classList.remove("scrolling");
  window.scrollTo(0, 0);
  studyIdx = si;
  studyAbort.abort();
  studyAbort = new AbortController();
  show("viewer");
  $("top-kicker").textContent = sharedLine;
  $("top-title").textContent = studyTitle(study());
  document.title = studyTitle(study());
  if (!viewport) {
    viewport = new Viewport($("stage"), {
      allowSoftwareGl: new URLSearchParams(location.search).get("renderer") === "gl",
      forceCpu: new URLSearchParams(location.search).get("renderer") === "cpu",
    });
    viewport.onDraw = (ms) => {
      if (metrics.draws.length < 5000) metrics.draws.push(ms);
    };
    metrics.renderer = viewport.kind;
  }
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
    const c = el("canvas");
    c.width = c.height = Math.round(80 * dpr);
    const t = el("span", "s-text");
    t.append(el("span", "s-name", se.description ?? `${modalityName(se.modality)} ${se.number ?? k + 1}`));
    t.append(el("span", "s-count", isSlideSeries(se) ? "Whole slide" : plural(se.instances.length, "image")));
    b.append(c, t);
    b.addEventListener("click", () => selectSeries(k));
    strip.append(b);
  });
}

function loadStripThumbs() {
  const st = study();
  const signal = studyAbort.signal;
  st.series.forEach((se, k) => {
    const c = $("strip").querySelector<HTMLCanvasElement>(`[data-series="${k}"] canvas`);
    if (!c || c.dataset.drawn) return;
    seriesThumb(c, se, Priority.Near, signal)
      .then(() => (c.dataset.drawn = "1"))
      .catch(() => {});
  });
}

function selectSeries(k: number) {
  if (k === seriesIdx && shownKey.startsWith(series()?.fileId ?? "-")) return;
  if (k === seriesIdx && slideView?.active && slideView.ss?.src.series === series()) return;
  seriesAbort.abort();
  seriesAbort = new AbortController();
  const prevFile = seriesIdx >= 0 ? study()?.series[seriesIdx]?.fileId : undefined;
  seriesIdx = k;
  const se = series();
  if (prevFile && prevFile !== se.fileId) {
    share!.loader.cancelQueued((fid, p) => fid === prevFile && p >= FetchPriority.Prefetch);
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
  if (isSlideSeries(se)) {
    showSlide(se);
    return;
  }
  leaveSlide();
  sliceCount = se.instances.length;
  presetId = "auto";
  wc = 0;
  ww = 0;
  autoWc = 0;
  autoWw = 0;
  zoom = 1;
  panX = 0;
  panY = 0;
  shownKey = "";
  const presets = presetsFor(se.modality);
  const sel = $<HTMLSelectElement>("preset");
  sel.textContent = "";
  for (const p of presets) {
    const o = el("option", undefined, p.label);
    o.value = p.id;
    sel.append(o);
  }
  sel.classList.toggle("hidden", presets.length < 2);
  sel.value = "auto";
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
  $("stage-busy").classList.remove("hidden");
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
      slideView!.show(ss, t0);
      shownKey = `${se.fileId}/slide`;
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
    $("stage-busy").classList.remove("hidden");
    const want = { file: se.fileId, slice: sliceIdx };
    images!
      .get(se, inst, { priority: Priority.Visible })
      .then((im) => {
        if (series()?.fileId !== want.file) return;
        if (sliceIdx === want.slice) draw(im, sliceTarget(sliceIdx).frame);
        else if (images!.peek(series(), sliceTarget(sliceIdx).inst)) showSlice(sliceIdx);
      })
      .catch((e) => {
        if ((e as any)?.name === "AbortError") return;
        if (series()?.fileId !== want.file || sliceIdx !== want.slice) return;
        sliceError(e);
      });
  }
  if (startPrefetch) prefetch();
  else nudgePrefetch();
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
  if (autoWw === 0) {
    const w = autoWindow(img, frame);
    autoWc = w.center;
    autoWw = w.width;
  }
  if (ww === 0) {
    wc = autoWc;
    ww = autoWw;
  }
  viewport!.show(img, Math.min(frame, img.frames - 1), { windowCenter: wc, windowWidth: ww, zoom, panX, panY });
  shownKey = `${se.fileId}/${sliceIdx}`;
  metrics.slices++;
  if (!metrics.marks["first-slice"]) {
    mark("first-slice");
    // Thumbnails for the strip once the first image is up.
    setTimeout(loadStripThumbs, 0);
  }
  updateHud(img);
}

function updateHud(img?: DecodedImage) {
  const se = series();
  const im = img ?? viewport?.image;
  $("hud-tl").textContent = `${se.description ?? modalityName(se.modality)}\n${se.modality ?? ""} · ${sliceIdx + 1}/${sliceCount}`;
  $("hud-tr").textContent = im ? `${im.columns}×${im.rows}\nW ${Math.round(ww)} L ${Math.round(wc)}` : "";
  $("hud-bl").textContent = zoom > 1.01 || zoom < 0.99 ? `${zoom.toFixed(1)}×` : "";
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

function setWindow(c: number, w: number) {
  wc = c;
  ww = Math.max(1, w);
  viewport?.setView({ windowCenter: wc, windowWidth: ww });
  updateHud();
}

function applyPreset(p: WindowPreset) {
  presetId = p.id;
  if (p.center === null || p.width === null) {
    if (autoWw > 0) setWindow(autoWc, autoWw);
  } else setWindow(p.center, p.width);
}

function setZoomPan(z: number, x: number, y: number) {
  zoom = Math.max(0.5, Math.min(12, z));
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

function resetView() {
  zoom = 1;
  panX = 0;
  panY = 0;
  presetId = "auto";
  $<HTMLSelectElement>("preset").value = "auto";
  viewport?.setView({ zoom, panX, panY });
  applyPreset({ id: "auto", label: "Auto", center: null, width: null });
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
  const wlGain = () => Math.max(0.5, ww / 220);

  const canvasPoint = (x: number, y: number) => {
    const r = viewport!.canvas.getBoundingClientRect();
    const s = viewport!.scale;
    return [(x - r.left) * s, (y - r.top) * s] as const;
  };

  stage.addEventListener("pointerdown", (e) => {
    if (!viewport || slideView?.active) return;
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
      mode = "slice";
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
    if (mode === "pan") {
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
  stage.addEventListener("contextmenu", (e) => e.preventDefault());
  stage.addEventListener("dblclick", () => {
    if (!slideView?.active) resetView();
  });
  stage.addEventListener(
    "wheel",
    (e) => {
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

function openDownloadSheet(scope: ExportScope, withImage: boolean) {
  const opts = $("dl-options");
  opts.textContent = "";
  $("dl-progress").classList.add("hidden");
  opts.classList.remove("hidden");
  const st = scope.study;
  const add = (title: string, detail: string, run: () => void) => {
    const b = el("button", "dl-option");
    b.type = "button";
    b.append(el("strong", undefined, title), el("span", undefined, detail));
    b.addEventListener("click", run);
    opts.append(b);
  };
  const studySize = exportSize({ kind: "study", study: st });
  add("This study", `${studyTitle(st)} · ${plural(studySize.files, "file")} · ${formatBytes(studySize.bytes)} · ZIP with DICOMDIR`, () =>
    void runZip({ kind: "study", study: st }),
  );
  if (scope.kind === "series" || withImage) {
    const se = scope.kind === "series" ? scope.series : series();
    const s = exportSize({ kind: "series", study: st, series: se });
    add("This series", `${se.description ?? modalityName(se.modality)} · ${plural(s.files, "file")} · ${formatBytes(s.bytes)} · ZIP with DICOMDIR`, () =>
      void runZip({ kind: "series", study: st, series: se }),
    );
  }
  if (withImage) {
    const se = series();
    const { inst } = sliceTarget(sliceIdx);
    add("This image", `One DICOM file (.dcm) · ${formatBytes(se.instances[inst].length)}`, () => void runOne(se, inst));
  }
  openSheet("sheet-download");
}

async function runZip(scope: ExportScope) {
  const name = exportBaseName(scope.study, scope.kind === "series" ? scope.series : undefined) + ".zip";
  // Ask for the file first, while the click still counts as a user gesture.
  const target = await openSaveTarget(name, "application/zip", ".zip");
  if (!target) return;
  exportAbort = new AbortController();
  $("dl-options").classList.add("hidden");
  $("dl-progress").classList.remove("hidden");
  $("btn-dl-cancel").classList.remove("hidden");
  const status = $("dl-status");
  const bar = $("dl-bar");
  try {
    await exportZip(
      scope,
      share!.loader,
      target,
      (p) => {
        bar.style.width = `${(100 * p.bytes) / Math.max(1, p.totalBytes)}%`;
        status.textContent = `Saving ${p.files} of ${plural(p.totalFiles, "file")} · ${formatBytes(p.bytes)} of ${formatBytes(p.totalBytes)}`;
      },
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
  try {
    const bytes = await exportInstance(share!.loader, se, i);
    await target.write(bytes);
    await target.close();
    $("dl-options").classList.add("hidden");
    $("dl-progress").classList.remove("hidden");
    $("dl-bar").style.width = "100%";
    $("dl-status").textContent = `Saved ${name}`;
    $("btn-dl-cancel").classList.add("hidden");
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
    const p = presetsFor(series().modality).find((x) => x.id === (e.target as HTMLSelectElement).value);
    if (p) applyPreset(p);
  });
  $("btn-reset").addEventListener("click", () => (slideView?.active ? slideView.fit() : resetView()));
  $("btn-label").addEventListener("click", () => void openLabelSheet());
  $("btn-download").addEventListener("click", () => openDownloadSheet({ kind: "series", study: study(), series: series() }, !isSlideSeries(series())));
  $("btn-trust").addEventListener("click", openTrustSheet);
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
  /** Slices of the current series already decoded and cached. */
  cached: () => (share && seriesIdx >= 0 ? series().instances.filter((_, i) => images!.peek(series(), i)).length : 0),
  saveBlob,
};

/** Slide view hooks for scripted checks. */
(globalThis as any).__wsi = {
  active: () => !!slideView?.active,
  idle: () => !!slideView?.active && slideView.idle,
  stats: () => slideView?.stats() ?? null,
  view: () => (slideView ? { cx: slideView.cx, cy: slideView.cy, scale: slideView.scale, level: slideView.level, dpr: slideView.dpr, w: slideView.canvas.width, h: slideView.canvas.height } : null),
  setView: (cx: number, cy: number, scale: number) => slideView?.setView(cx, cy, scale),
  pyramid: () => {
    const p = slideView?.ss?.pyramid;
    return p && { width: p.width, height: p.height, label: p.label, overview: p.overview, levels: p.levels.map((l) => ({ instance: l.instance, width: l.width, height: l.height, tileWidth: l.tileWidth, tileHeight: l.tileHeight, tilesAcross: l.tilesAcross, tilesDown: l.tilesDown, downsample: l.downsample, frames: l.header.numberOfFrames, source: slideView!.ss!.src.frameSource(l.instance) })) };
  },
  marks: () => slideView?.ss?.metrics.marks ?? null,
  log: () => slideView?.ss?.src.reader.log ?? [],
  instances: () => slideView?.ss?.src.series.instances.map((i) => [i.offset, i.length]) ?? [],
  /** Decodes tile (level, tx, ty) again and returns its pixels as base64, with the frame number. */
  tilePixels: async (level: number, tx: number, ty: number) => {
    const ss = slideView?.ss;
    if (!ss) return null;
    const L = ss.pyramid.levels[level];
    const file = await ss.src.tileFile(level, tx, ty, { priority: 0 });
    if (!file) return null;
    const img = await ss.pool.decode(file, { priority: 0 });
    const u8 = new Uint8Array(img.pixels, img.frameOffsets[0], img.frameBytes);
    let bin = "";
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return { frame: L.frameOf(tx, ty), instance: L.instance, uid: ss.src.series.instances[L.instance].uid, rows: img.rows, columns: img.columns, spp: img.samplesPerPixel, photometric: img.photometric, b64: btoa(bin) };
  },
};

void boot();
