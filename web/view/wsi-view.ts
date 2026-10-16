// Whole-slide viewer: a deep-zoom tile layer over a SlideSource (web/core/wsi-source.ts).
//
// - Level: the coarsest pyramid level with at least one level pixel per 1.5 CSS pixels.
// - Tiles: visible tiles of that level are fetched nearest-first; tiles that leave the view are
//   cancelled. Each tile is one byte range, decrypted with WebCrypto, wrapped as a one-frame DICOM
//   file and decoded in the pool's workers.
// - Placeholders: the coarsest level is always loaded; coarser cached tiles (and, while focus
//   changes, the nearest focal plane's tiles) are drawn under the tiles still loading.
// - Focal planes: one at a time, chosen with the focus control.
// - Optical paths: brightfield shows its one path; fluorescence composites the visible channels,
//   each with its own colour and intensity.
// - Overlays: bulk annotations and segmentations that refer to the slide (wsi-layers.ts).
// - Drawing: canvas 2D drawImage of ImageBitmaps (GPU-composited); no WebGL context needed.
// - Never decodes a whole pyramid level: only single frames, plus label/overview/thumbnail
//   images under WHOLE_DECODE_LIMIT.
import type { DecoderPool } from "../../viewer-kit/src/index";
import { formatBytes, type OpenShare, type SeriesEntry } from "../core/index";
import type { WalkState } from "../core/wsi-source";
import { levelForScale, type Pyramid } from "../core/wsi";
import { Priority, tileKey, type SlideSession } from "./wsi-session";
import { drawAnnotations, drawSegmentation, findLayers, layerBytes, loadLayer, segmentationWants, type SlideLayer, type ViewXf } from "./wsi-layers";
import { SlidePanel } from "./wsi-panel";

export { slideSession, SlideSession } from "./wsi-session";

// ------------------------------------------------------------------------------------- display

export interface ChannelState {
  visible: boolean;
  color: [number, number, number];
  /** Intensity multiplier (1 = the channel's window as is). */
  gain: number;
}

export interface DisplayState {
  plane: number;
  channels: ChannelState[];
}

const CHANNEL_COLORS: [number, number, number][] = [
  [0, 255, 0], [255, 0, 0], [255, 0, 255], [0, 255, 255], [255, 255, 0], [255, 128, 0], [128, 128, 255], [255, 255, 255],
];

/** Approximate display colour for an emission wavelength (nm). */
function wavelengthColor(nm: number): [number, number, number] {
  if (nm < 440) return [140, 0, 255];
  if (nm < 490) return [0, 90, 255];
  if (nm < 510) return [0, 255, 255];
  if (nm < 580) return [0, 255, 0];
  if (nm < 600) return [255, 220, 0];
  if (nm < 645) return [255, 120, 0];
  return [255, 0, 0];
}

/** Defaults: brightfield shows its path; fluorescence shows up to four channels, nuclear stains in blue. */
export function defaultDisplay(p: Pyramid): DisplayState {
  const plane = Math.floor((p.planes.length - 1) / 2);
  if (!p.monochrome) return { plane, channels: p.paths.map((_, k) => ({ visible: k === 0, color: [255, 255, 255], gain: 1 })) };
  if (p.paths.length === 1) return { plane, channels: [{ visible: true, color: [255, 255, 255], gain: 1 }] };
  let next = 0;
  const channels = p.paths.map((path, k) => {
    const nuclear = /dapi|hoechst|nucle/i.test(path.label);
    const color: [number, number, number] = nuclear ? [0, 90, 255] : path.wavelength ? wavelengthColor(path.wavelength) : CHANNEL_COLORS[next++ % CHANNEL_COLORS.length];
    return { visible: k < 4, color, gain: 1 };
  });
  return { plane, channels };
}

/** Paths whose tiles are drawn. */
function activePaths(p: Pyramid, d: DisplayState): number[] {
  if (!p.monochrome) return [0];
  return d.channels.map((c, k) => (c.visible ? k : -1)).filter((k) => k >= 0);
}

let layerCanvas: HTMLCanvasElement | null = null;

/**
 * Draws the slide for view `v` (levels from the coarsest down to `minLevel`) into ctx, which is
 * cleared first. Used by the viewer, the minimap and the overview thumbnail.
 */
export function renderSlide(ctx: CanvasRenderingContext2D, ss: SlideSession, v: ViewXf, minLevel: number, d: DisplayState): number {
  const p = ss.pyramid;
  const { W, H } = v;
  const X = (bx: number) => Math.round((bx - v.cx) * v.scale + W / 2);
  const Y = (by: number) => Math.round((by - v.cy) * v.scale + H / 2);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = p.monochrome ? "#000" : "#2a2a2a";
  ctx.fillRect(X(0), Y(0), X(p.width) - X(0), Y(p.height) - Y(0));
  let drawn = 0;
  const drawTiles = (c: CanvasRenderingContext2D, path: number, planeFallback: boolean) => {
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = v.scale > 1 ? "low" : "medium";
    const x0 = v.cx - W / (2 * v.scale), x1 = v.cx + W / (2 * v.scale), y0 = v.cy - H / (2 * v.scale), y1 = v.cy + H / (2 * v.scale);
    for (let k = p.levels.length - 1; k >= minLevel; k--) {
      const L = p.levels[k];
      const tw = L.tileWidth * L.downsample, th = L.tileHeight * L.downsample;
      const tx0 = Math.max(0, Math.floor(x0 / tw)), tx1 = Math.min(L.tilesAcross - 1, Math.floor(x1 / tw));
      const ty0 = Math.max(0, Math.floor(y0 / th)), ty1 = Math.min(L.tilesDown - 1, Math.floor(y1 / th));
      for (let ty = ty0; ty <= ty1; ty++)
        for (let tx = tx0; tx <= tx1; tx++) {
          let t = ss.peek(k, tx, ty, d.plane, path);
          if (!t && planeFallback) {
            // Focus just changed: show the nearest plane's tile until this one arrives.
            for (let dz = 1; dz < p.planes.length && !t; dz++) t = ss.peek(k, tx, ty, d.plane - dz, path) ?? ss.peek(k, tx, ty, d.plane + dz, path);
          }
          if (!t?.bmp) continue;
          const lx = tx * L.tileWidth, ly = ty * L.tileHeight;
          const w = Math.min(L.tileWidth, L.width - lx), h = Math.min(L.tileHeight, L.height - ly);
          const dx0 = X(lx * L.downsample), dy0 = Y(ly * L.downsample), dx1 = X((lx + w) * L.downsample), dy1 = Y((ly + h) * L.downsample);
          if (dx1 <= dx0 || dy1 <= dy0) continue;
          // One canvas pixel of overlap hides seams from edge filtering.
          c.drawImage(t.bmp, 0, 0, w, h, dx0, dy0, dx1 - dx0 + 1, dy1 - dy0 + 1);
          drawn++;
        }
    }
  };
  if (!p.monochrome || p.paths.length === 1) {
    drawTiles(ctx, 0, true);
  } else {
    // Fluorescence: each visible channel, grey → tinted with its colour → added with its intensity.
    layerCanvas ??= document.createElement("canvas");
    if (layerCanvas.width !== W || layerCanvas.height !== H) {
      layerCanvas.width = W;
      layerCanvas.height = H;
    }
    const lc = layerCanvas.getContext("2d")!;
    for (const path of activePaths(p, d)) {
      const ch = d.channels[path];
      lc.globalCompositeOperation = "source-over";
      lc.fillStyle = "#000";
      lc.fillRect(0, 0, W, H);
      drawTiles(lc, path, true);
      lc.globalCompositeOperation = "multiply";
      lc.fillStyle = `rgb(${ch.color[0]},${ch.color[1]},${ch.color[2]})`;
      lc.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      // Intensity: a brightness filter where the browser has canvas filters, else opacity (≤ 100%).
      const hasFilter = typeof (ctx as { filter?: unknown }).filter === "string";
      if (hasFilter) ctx.filter = ch.gain === 1 ? "none" : `brightness(${ch.gain})`;
      else ctx.globalAlpha = Math.min(1, ch.gain);
      ctx.drawImage(layerCanvas, 0, 0);
      if (hasFilter) ctx.filter = "none";
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
  return drawn;
}

/** Draws the coarsest level into a thumbnail canvas (loads its tiles at Near priority). */
export async function drawSlideThumbnail(canvas: HTMLCanvasElement, ss: SlideSession) {
  const p = ss.pyramid;
  const k = p.levels.length - 1;
  const L = p.levels[k];
  const d = defaultDisplay(p);
  const loads: Promise<unknown>[] = [];
  for (const path of activePaths(p, d))
    for (let ty = 0; ty < L.tilesDown; ty++)
      for (let tx = 0; tx < L.tilesAcross; tx++) {
        if (!L.frameRef(tx, ty, d.plane, path)) continue;
        ss.pin(tileKey(k, tx, ty, d.plane, path));
        loads.push(ss.load(k, tx, ty, d.plane, path, Priority.Near).catch(() => null));
      }
  await Promise.all(loads);
  const W = canvas.width, H = canvas.height;
  const scale = Math.min(W / p.width, H / p.height);
  renderSlide(canvas.getContext("2d")!, ss, { cx: p.width / 2, cy: p.height / 2, scale, W, H, dpr: 1 }, k, d);
}

// ------------------------------------------------------------------------------------- view

export interface SlideContext {
  share: OpenShare;
  pool: DecoderPool;
  /** The other series of the study (where annotations and segmentations are found). */
  others: SeriesEntry[];
}

/** The deep-zoom view inside the stage element. */
export class SlideView {
  readonly root: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private mini: HTMLCanvasElement;
  private miniKey = "";
  private miniBase: HTMLCanvasElement | null = null;
  private statsEl: HTMLDivElement;
  private msgEl: HTMLDivElement;
  private progEl: HTMLDivElement;
  private progText: HTMLSpanElement;
  private progBar: HTMLDivElement;
  private noticeEl: HTMLParagraphElement;
  private progTimer: ReturnType<typeof setInterval> | null = null;
  /** Since when wanted tiles have been missing (null: none missing). */
  private pendingSince: number | null = null;
  private ro: ResizeObserver;
  readonly panel: SlidePanel;
  ss: SlideSession | null = null;
  ctxt: SlideContext | null = null;
  display: DisplayState = { plane: 0, channels: [] };
  layers: SlideLayer[] = [];
  /** View: base-level pixel at the canvas centre, and canvas pixels per base pixel. */
  cx = 0;
  cy = 0;
  scale = 1;
  private fitScale = 1;
  private drawQueued = false;
  private updateQueued = false;
  private statsQueued = false;
  private openedAt = 0;
  firstTileAt: number | null = null;
  private wanted = new Set<string>();
  private lastWalk: WalkState | null = null;
  private openGen = 0;
  level = 0;
  active = false;

  constructor(readonly stage: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "wsi hidden";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "wsi-canvas";
    this.mini = document.createElement("canvas");
    this.mini.className = "wsi-mini";
    this.mini.setAttribute("aria-label", "Slide overview. Tap to move there.");
    this.statsEl = document.createElement("div");
    this.statsEl.className = "wsi-stats";
    this.statsEl.setAttribute("aria-live", "off");
    this.msgEl = document.createElement("div");
    this.msgEl.className = "stage-msg hidden";
    // Progress near the image: finding tiles (walking fragment headers) or any slow load.
    this.progEl = document.createElement("div");
    this.progEl.className = "wsi-progress hidden";
    this.progEl.setAttribute("role", "status");
    this.progText = document.createElement("span");
    const track = document.createElement("div");
    track.className = "wsi-progress-track";
    this.progBar = document.createElement("div");
    this.progBar.className = "wsi-progress-bar";
    track.append(this.progBar);
    this.progEl.append(this.progText, track);
    this.noticeEl = document.createElement("p");
    this.noticeEl.className = "wsi-info hidden";
    this.noticeEl.textContent = "This slide has no frame offset table, so the viewer has to read ahead to find tiles. Adding tables when sharing avoids this.";
    this.root.append(this.canvas, this.mini, this.statsEl, this.noticeEl, this.progEl, this.msgEl);
    stage.append(this.root);
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.root);
    this.panel = new SlidePanel(this);
    this.wire();
  }

  get dpr() {
    return Math.min(2, devicePixelRatio || 1);
  }

  get xf(): ViewXf {
    return { cx: this.cx, cy: this.cy, scale: this.scale, W: this.canvas.width, H: this.canvas.height, dpr: this.dpr };
  }

  /** Opens a slide session; draws as soon as the coarsest tiles arrive. */
  async show(ss: SlideSession, ctxt: SlideContext, openedAt = performance.now()) {
    this.close();
    const gen = ++this.openGen;
    this.ss = ss;
    this.ctxt = ctxt;
    this.active = true;
    this.openedAt = openedAt;
    this.firstTileAt = null;
    this.display = defaultDisplay(ss.pyramid);
    this.layers = [];
    this.root.classList.remove("hidden");
    this.stage.classList.add("slide-mode");
    this.resize();
    this.fit();
    ss.onTile = () => {
      this.requestDraw();
      this.requestStats();
    };
    ss.src.reader.onStats = () => this.requestStats();
    ss.src.onWalk = (w) => {
      this.lastWalk = w;
      this.renderProgress();
      this.requestStats();
    };
    this.panel.attach();
    this.noticeEl.classList.toggle("hidden", !ss.pyramid.levels.some((l) => ss.src.frameSource(l.instance) === "walk"));
    this.pendingSince = null;
    this.progTimer = setInterval(() => this.renderProgress(), 200);
    this.requestUpdate();
    this.requestStats();
    // Overlays that refer to this slide (one small header read per candidate instance).
    findLayers(ctxt.share, ss.src.series, ctxt.others)
      .then((ls) => {
        if (gen !== this.openGen) return;
        this.layers = ls;
        this.panel.refresh();
      })
      .catch(() => {});
  }

  close() {
    this.openGen++;
    if (this.ss) {
      this.ss.cancelExcept(new Set());
      this.ss.onTile = null;
      this.ss.src.reader.onStats = null;
      this.ss.src.onWalk = null;
    }
    for (const l of this.layers) if (l.kind === "segmentation" && l.ss) (l.ss.cancelExcept(new Set()), (l.ss.onTile = null));
    this.panel.detach();
    if (this.progTimer) clearInterval(this.progTimer);
    this.progTimer = null;
    this.progEl.classList.add("hidden");
    this.noticeEl.classList.add("hidden");
    this.ss = null;
    this.layers = [];
    this.miniBase = null;
    this.miniKey = "";
    this.lastWalk = null;
    this.active = false;
    this.root.classList.add("hidden");
    this.stage.classList.remove("slide-mode");
    this.msgEl.classList.add("hidden");
  }

  // ----------------------------------------------------------------------------------- display changes

  setPlane(plane: number) {
    if (!this.ss) return;
    const n = this.ss.pyramid.planes.length;
    this.display.plane = Math.max(0, Math.min(n - 1, plane));
    this.panel.refresh();
    this.requestUpdate();
  }

  setChannel(k: number, patch: Partial<ChannelState>) {
    const ch = this.display.channels[k];
    if (!ch) return;
    Object.assign(ch, patch);
    this.miniKey = "";
    this.requestUpdate();
  }

  setIcc(on: boolean) {
    this.ss?.setIcc(on);
    this.miniBase = null;
    this.miniKey = "";
    this.requestUpdate();
  }

  async setLayer(id: string, on: boolean) {
    const l = this.layers.find((x) => x.id === id);
    if (!l || !this.ss || !this.ctxt) return;
    l.visible = on;
    this.panel.refresh();
    if (on && l.state !== "ready") {
      await loadLayer(l, this.ctxt.share, this.ctxt.pool, this.ss.pyramid);
      if (l.kind === "segmentation" && l.ss) {
        l.ss.onTile = () => this.requestDraw();
      }
      this.panel.refresh();
      this.requestStats();
    }
    this.requestUpdate();
  }

  // ----------------------------------------------------------------------------------- geometry

  private resize() {
    const dpr = this.dpr;
    const w = Math.max(1, Math.round(this.root.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.root.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return;
    const wasFit = Math.abs(this.scale - this.fitScale) < 1e-9;
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.ss) {
      const p = this.ss.pyramid;
      this.fitScale = Math.min(w / p.width, h / p.height) * 0.94;
      if (wasFit) this.scale = this.fitScale;
      this.requestUpdate();
    }
  }

  fit() {
    if (!this.ss) return;
    const p = this.ss.pyramid;
    this.fitScale = Math.min(this.canvas.width / p.width, this.canvas.height / p.height) * 0.94;
    this.scale = this.fitScale;
    this.cx = p.width / 2;
    this.cy = p.height / 2;
    this.requestUpdate();
  }

  get minScale() {
    return this.fitScale * 0.5;
  }
  get maxScale() {
    return 4 * this.dpr;
  }

  setView(cx: number, cy: number, scale: number) {
    if (!this.ss) return;
    const p = this.ss.pyramid;
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, scale));
    // Keep some of the slide on screen.
    const hw = this.canvas.width / (2 * this.scale), hh = this.canvas.height / (2 * this.scale);
    this.cx = Math.max(-hw * 0.8, Math.min(p.width + hw * 0.8, cx));
    this.cy = Math.max(-hh * 0.8, Math.min(p.height + hh * 0.8, cy));
    this.requestUpdate();
  }

  /** Zoom by k keeping canvas point (px, py) fixed. */
  zoomAt(k: number, px: number, py: number) {
    const s1 = Math.max(this.minScale, Math.min(this.maxScale, this.scale * k));
    const W = this.canvas.width, H = this.canvas.height;
    const bx = this.cx + (px - W / 2) / this.scale, by = this.cy + (py - H / 2) / this.scale;
    this.setView(bx - (px - W / 2) / s1, by - (py - H / 2) / s1, s1);
  }

  panBy(dxCanvas: number, dyCanvas: number) {
    this.setView(this.cx - dxCanvas / this.scale, this.cy - dyCanvas / this.scale, this.scale);
  }

  /** The level for the current scale: at least one level pixel per 1.5 CSS pixels. */
  private targetLevel() {
    return levelForScale(this.ss!.pyramid, this.scale / this.dpr / 1.5);
  }

  requestUpdate() {
    if (this.updateQueued) return;
    this.updateQueued = true;
    requestAnimationFrame(() => {
      this.updateQueued = false;
      this.update();
      this.draw();
    });
  }

  requestDraw() {
    if (this.drawQueued || this.updateQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  private requestStats() {
    if (this.statsQueued) return;
    this.statsQueued = true;
    setTimeout(() => {
      this.statsQueued = false;
      this.renderStats();
    }, 120);
  }

  // ----------------------------------------------------------------------------------- scheduling

  /** Decides which tiles are wanted, cancels the rest, and starts loads nearest-first. */
  private update() {
    const ss = this.ss;
    if (!ss) return;
    const p = ss.pyramid;
    const coarsest = p.levels.length - 1;
    const k = this.targetLevel();
    this.level = k;
    const plane = this.display.plane;
    const want: { key: string; k: number; tx: number; ty: number; path: number; d: number; pri: number }[] = [];
    const W = this.canvas.width, H = this.canvas.height;
    const x0 = this.cx - W / (2 * this.scale), x1 = this.cx + W / (2 * this.scale);
    const y0 = this.cy - H / (2 * this.scale), y1 = this.cy + H / (2 * this.scale);
    const paths = activePaths(p, this.display);
    const add = (lk: number, pri: number, whole: boolean) => {
      const L = p.levels[lk];
      const tw = L.tileWidth * L.downsample, th = L.tileHeight * L.downsample;
      const tx0 = whole ? 0 : Math.max(0, Math.floor(x0 / tw)), tx1 = whole ? L.tilesAcross - 1 : Math.min(L.tilesAcross - 1, Math.floor(x1 / tw));
      const ty0 = whole ? 0 : Math.max(0, Math.floor(y0 / th)), ty1 = whole ? L.tilesDown - 1 : Math.min(L.tilesDown - 1, Math.floor(y1 / th));
      for (const path of paths)
        for (let ty = ty0; ty <= ty1; ty++)
          for (let tx = tx0; tx <= tx1; tx++) {
            if (!L.frameRef(tx, ty, plane, path)) continue; // absent (TILED_SPARSE)
            const key = tileKey(lk, tx, ty, plane, path);
            if (whole) ss.pin(key);
            const d = whole ? -1 : Math.hypot((tx + 0.5) * tw - this.cx, (ty + 0.5) * th - this.cy);
            want.push({ key, k: lk, tx, ty, path, d, pri });
          }
    };
    // The coarsest level, whole: placeholders and the minimap.
    add(coarsest, Priority.Visible, true);
    if (k < coarsest) {
      add(k, Priority.Visible, false);
      // One level coarser, so a fast zoom-in has a sharper placeholder.
      if (k + 1 < coarsest) add(k + 1, Priority.Near, false);
    }
    want.sort((a, b) => a.pri - b.pri || a.d - b.d);
    this.wanted = new Set(want.filter((w) => w.k === k || w.k === coarsest).map((w) => w.key));
    ss.cancelExcept(new Set(want.map((w) => w.key)));
    for (const w of want) {
      if (ss.peek(w.k, w.tx, w.ty, plane, w.path)) continue;
      if (ss.isLoading(w.key)) {
        ss.raise(w.key, w.pri);
        continue;
      }
      ss.load(w.k, w.tx, w.ty, plane, w.path, w.pri).catch((e) => this.tileError(e));
    }
    // Segmentation overlays: their own levels and tiles, after the slide's.
    for (const l of this.layers) {
      if (l.kind !== "segmentation" || !l.ss) continue;
      const sw = l.visible ? segmentationWants(l, this.xf) : [];
      sw.sort((a, b) => a.d - b.d);
      l.ss.cancelExcept(new Set(sw.map((w) => w.key)));
      for (const w of sw) if (!l.ss.peek(w.k, w.tx, w.ty, 0, w.path) && !l.ss.isLoading(w.key)) l.ss.load(w.k, w.tx, w.ty, 0, w.path, Priority.Near).catch((e) => this.tileError(e));
    }
    this.renderProgress();
    this.requestStats();
  }

  private tileError(e: unknown) {
    if ((e as any)?.name === "AbortError") return;
    this.showMessage(`A tile could not be shown: ${(e as any)?.decoderMessage ?? (e as Error)?.message ?? e}`);
  }

  private showMessage(text: string) {
    this.msgEl.textContent = text;
    this.msgEl.classList.remove("hidden");
  }

  /** The message shown on the stage, if any (for scripted checks). */
  get message(): string | null {
    return this.msgEl.classList.contains("hidden") ? null : this.msgEl.textContent;
  }

  // ----------------------------------------------------------------------------------- drawing

  private draw() {
    const ss = this.ss;
    if (!ss) return;
    const drawn = renderSlide(this.ctx, ss, this.xf, this.level, this.display);
    for (const l of this.layers) {
      if (l.kind === "segmentation") drawSegmentation(this.ctx, l, this.xf);
    }
    for (const l of this.layers) {
      if (l.kind === "annotations") drawAnnotations(this.ctx, l, this.xf);
    }
    if (drawn && this.firstTileAt === null) {
      this.firstTileAt = performance.now();
      ss.metrics.marks.firstTileDrawn ??= this.firstTileAt;
    }
    this.drawMini();
  }

  private drawMini() {
    const ss = this.ss!;
    const p = ss.pyramid;
    const dpr = this.dpr;
    const cssW = Math.min(150, Math.max(90, this.root.clientWidth * 0.28));
    const cssH = Math.min(150, (cssW * p.height) / p.width);
    const cw = Math.min(150, (cssH * p.width) / p.height);
    const w = Math.round(cw * dpr), h = Math.round(cssH * dpr);
    if (this.mini.width !== w || this.mini.height !== h) {
      this.mini.width = w;
      this.mini.height = h;
      this.mini.style.width = `${cw}px`;
      this.mini.style.height = `${cssH}px`;
      this.miniBase = null;
    }
    const k = p.levels.length - 1;
    const L = p.levels[k];
    let have = 0;
    for (const path of activePaths(p, this.display))
      for (let ty = 0; ty < L.tilesDown; ty++) for (let tx = 0; tx < L.tilesAcross; tx++) if (ss.peek(k, tx, ty, this.display.plane, path)) have++;
    const key = `${w}x${h}/${have}/${this.display.plane}/${JSON.stringify(this.display.channels)}`;
    if (!this.miniBase || key !== this.miniKey) {
      const c = this.miniBase ?? document.createElement("canvas");
      c.width = w;
      c.height = h;
      const scale = Math.min(w / p.width, h / p.height);
      renderSlide(c.getContext("2d")!, ss, { cx: p.width / 2, cy: p.height / 2, scale, W: w, H: h, dpr: 1 }, k, this.display);
      this.miniBase = c;
      this.miniKey = key;
    }
    const m = this.mini.getContext("2d")!;
    m.drawImage(this.miniBase, 0, 0);
    const W = this.canvas.width, H = this.canvas.height;
    const r = { x0: this.cx - W / (2 * this.scale), y0: this.cy - H / (2 * this.scale), x1: this.cx + W / (2 * this.scale), y1: this.cy + H / (2 * this.scale) };
    const sx = w / p.width, sy = h / p.height;
    m.strokeStyle = "#1f8fff";
    m.lineWidth = Math.max(1.5, dpr * 1.5);
    const x0 = Math.max(0, r.x0 * sx), y0 = Math.max(0, r.y0 * sy), x1 = Math.min(w, r.x1 * sx), y1 = Math.min(h, r.y1 * sy);
    if (x1 - x0 < w - 1 || y1 - y0 < h - 1) m.strokeRect(x0, y0, Math.max(3, x1 - x0), Math.max(3, y1 - y0));
  }

  // ----------------------------------------------------------------------------------- progress

  /** The progress card: shown while fragment headers are walked, or when tiles take over 300 ms. */
  private renderProgress() {
    const ss = this.ss;
    if (!ss) return;
    let missing = 0;
    for (const k of this.wanted) {
      const [l, x, y, z, path] = k.split("/").map(Number);
      if (!ss.peek(l, x, y, z, path)) missing++;
    }
    const now = performance.now();
    if (missing) this.pendingSince ??= now;
    else this.pendingSince = null;
    const walks = missing ? ss.src.walking() : [];
    let text = "", frac = 0;
    if (walks.length) {
      // Bytes read so far against an estimate of what reaching the wanted frames needs.
      let read = 0, est = 0;
      for (const w of walks) {
        read += w.walkedBytes;
        const guess = w.known > 0 && w.need >= 0 ? (w.walkedBytes * (w.need + 1)) / w.known : w.pixelBytes;
        est += Math.min(w.pixelBytes, Math.max(w.walkedBytes, guess));
      }
      // One decimal, so each chunk read moves the figure.
      const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);
      // Downloaded counts every record (tiles and headers too), so it moves even while tile reads
      // share the connection with the walk.
      text = `Finding tiles: ${mb(read)} of about ${mb(est).replace(/\.\d MB$/, " MB")} read · ${mb(ss.src.reader.stats.bytes)} downloaded`;
      frac = est ? read / est : 0;
    } else if (this.pendingSince !== null && now - this.pendingSince > 300) {
      const total = this.wanted.size;
      text = `Loading tiles: ${(total - missing).toLocaleString()} of ${total.toLocaleString()} · ${formatBytes(ss.src.reader.stats.bytes)} downloaded`;
      frac = total ? (total - missing) / total : 0;
    }
    this.progEl.classList.toggle("hidden", !text);
    if (text && this.progText.textContent !== text) this.progText.textContent = text;
    this.progBar.style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
  }

  /** The progress text on screen, or null (for scripted checks). */
  get progress(): string | null {
    return this.progEl.classList.contains("hidden") ? null : this.progText.textContent;
  }

  /** The no-offset-table note, when shown (for scripted checks). */
  get notice(): string | null {
    return this.noticeEl.classList.contains("hidden") ? null : this.noticeEl.textContent;
  }

  // ----------------------------------------------------------------------------------- stats

  stats() {
    const ss = this.ss;
    if (!ss) return null;
    const st = ss.src.reader.stats;
    const p = ss.pyramid;
    const L = p.levels[this.level];
    const sources = new Set(p.levels.map((l) => ss.src.frameSource(l.instance)));
    let walk: { known: number; frames: number } | null = null;
    for (const l of p.levels) {
      const w = ss.src.walkState(l.instance);
      if (!w.done && w.known > 0) walk = { known: w.known, frames: w.frames };
    }
    return {
      bytes: st.bytes,
      requests: st.requests,
      byPurpose: st.byPurpose,
      totalBytes: ss.src.ciphertextBytes,
      fraction: st.bytes / ss.src.ciphertextBytes,
      layerBytes: this.layers.reduce((a, l) => a + layerBytes(l), 0),
      tilesDecoded: ss.metrics.tilesDecoded,
      loading: ss.loadingCount,
      level: this.level,
      levels: p.levels.length,
      levelSize: [L.width, L.height],
      downsample: L.downsample,
      /** First request for this slide → first tile decoded (the overview thumbnail may be that tile). */
      firstTileMs: ss.metrics.marks.firstDecode ? ss.metrics.marks.firstDecode - ss.metrics.marks.sessionStart : null,
      /** Opening the slide view → first tile on its canvas. */
      firstDrawMs: this.firstTileAt === null ? null : this.firstTileAt - this.openedAt,
      frameSources: [...sources],
      walk,
      zoom: this.scale / this.dpr,
    };
  }

  private renderStats() {
    const s = this.stats();
    if (!s) return;
    const pct = s.fraction * 100;
    const offsets = s.frameSources.includes("walk")
      ? s.walk
        ? `Finding frames: ${s.walk.known.toLocaleString()} of ${s.walk.frames.toLocaleString()} located`
        : "Frame offsets: read from fragment headers"
      : "Frame offsets from the file's offset table";
    const lines = [
      `Downloaded ${formatBytes(s.bytes)} of ${formatBytes(s.totalBytes)} (${pct < 10 ? pct.toFixed(2) : pct.toFixed(1)}%)`,
      `${s.tilesDecoded.toLocaleString()} tiles · ${s.requests.toLocaleString()} requests${s.loading ? ` · ${s.loading} loading` : ""}`,
      `Level ${s.levels - s.level} of ${s.levels} · ${s.levelSize[0].toLocaleString()}×${s.levelSize[1].toLocaleString()}`,
      s.firstTileMs === null ? "First tile: waiting" : `First tile in ${(s.firstTileMs / 1000).toFixed(2)} s`,
      offsets,
    ];
    if (s.layerBytes) lines.push(`Layers: ${formatBytes(s.layerBytes)} more`);
    this.statsEl.textContent = lines.join("\n");
    this.statsEl.dataset.pct = pct.toFixed(3);
  }

  // ----------------------------------------------------------------------------------- input

  private wire() {
    const el = this.root;
    type P = { x: number; y: number; x0: number; y0: number; t0: number; button: number };
    const pts = new Map<number, P>();
    let lastTap = 0, lastTapX = 0, lastTapY = 0;
    let pinch: { d0: number; s0: number; mx: number; my: number; bx: number; by: number } | null = null;
    let lastPointerType = "mouse";
    const cp = (x: number, y: number) => {
      const r = this.canvas.getBoundingClientRect();
      const k = this.canvas.width / Math.max(1, r.width);
      return [(x - r.left) * k, (y - r.top) * k] as const;
    };
    const startPinch = () => {
      const [a, b] = [...pts.values()];
      const [mx, my] = cp((a.x + b.x) / 2, (a.y + b.y) / 2);
      const W = this.canvas.width, H = this.canvas.height;
      pinch = { d0: Math.hypot(b.x - a.x, b.y - a.y), s0: this.scale, mx, my, bx: this.cx + (mx - W / 2) / this.scale, by: this.cy + (my - H / 2) / this.scale };
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.target === this.mini) return;
      e.stopPropagation();
      lastPointerType = e.pointerType;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), button: e.pointerType === "mouse" ? e.button : 0 });
      if (pts.size === 2) startPinch();
      el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      e.stopPropagation();
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pts.size === 1 && p.button === 2) {
        // Right-drag zooms (up zooms in) about where the drag started, as in the slice viewer.
        const [x, y] = cp(p.x0, p.y0);
        this.zoomAt(Math.exp(-dy * 0.01), x, y);
      } else if (pts.size === 1) {
        const k = this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width);
        this.panBy(dx * k, dy * k);
      } else if (pts.size === 2 && pinch && pinch.d0 > 10) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const [mx, my] = cp((a.x + b.x) / 2, (a.y + b.y) / 2);
        const s1 = Math.max(this.minScale, Math.min(this.maxScale, pinch.s0 * (d / pinch.d0)));
        const W = this.canvas.width, H = this.canvas.height;
        // Keep the base point under the fingers' midpoint.
        this.setView(pinch.bx - (mx - W / 2) / s1, pinch.by - (my - H / 2) / s1, s1);
      }
    });
    const end = (e: PointerEvent) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      e.stopPropagation();
      pts.delete(e.pointerId);
      if (pts.size === 2) startPinch();
      else pinch = null;
      if (pts.size === 0) el.classList.remove("dragging");
      // Double tap (touch) returns to the whole slide, as Reset does.
      if (e.type === "pointerup" && e.pointerType !== "mouse" && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 10 && performance.now() - p.t0 < 300) {
        const now = performance.now();
        if (now - lastTap < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 40) {
          this.fit();
          lastTap = 0;
        } else {
          lastTap = now;
          lastTapX = e.clientX;
          lastTapY = e.clientY;
        }
      }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      // Touch double taps are handled on pointerup (browsers also send dblclick for them).
      if (lastPointerType !== "mouse") return;
      this.fit();
    });
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const [x, y] = cp(e.clientX, e.clientY);
        const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        this.zoomAt(Math.exp(-dy * (e.ctrlKey || e.metaKey ? 0.01 : 0.0025)), x, y);
      },
      { passive: false },
    );
    // Minimap: tap or drag to move there.
    const miniMove = (e: PointerEvent) => {
      if (!this.ss) return;
      const r = this.mini.getBoundingClientRect();
      const p = this.ss.pyramid;
      this.setView(((e.clientX - r.left) / r.width) * p.width, ((e.clientY - r.top) / r.height) * p.height, this.scale);
    };
    this.mini.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.mini.setPointerCapture(e.pointerId);
      miniMove(e);
    });
    this.mini.addEventListener("pointermove", (e) => {
      if (this.mini.hasPointerCapture(e.pointerId)) {
        e.stopPropagation();
        miniMove(e);
      }
    });
    this.statsEl.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.statsEl.classList.toggle("collapsed");
    });
  }

  /** Keyboard (the stage has focus): arrows pan, +/− zoom, 0 fits, Page Up/Down focus. Returns true when handled. */
  key(e: KeyboardEvent): boolean {
    const W = this.canvas.width, H = this.canvas.height;
    const step = Math.min(W, H) / 6;
    switch (e.key) {
      case "ArrowLeft": this.panBy(step, 0); break;
      case "ArrowRight": this.panBy(-step, 0); break;
      case "ArrowUp": this.panBy(0, step); break;
      case "ArrowDown": this.panBy(0, -step); break;
      case "+": case "=": this.zoomAt(1.5, W / 2, H / 2); break;
      case "-": case "_": this.zoomAt(1 / 1.5, W / 2, H / 2); break;
      case "0": case "r": case "Home": this.fit(); break;
      case "PageUp": this.setPlane(this.display.plane + 1); break;
      case "PageDown": this.setPlane(this.display.plane - 1); break;
      default: return false;
    }
    return true;
  }

  /** True when every wanted tile is drawn and nothing is loading (for scripted checks). */
  get idle() {
    if (!this.ss) return true;
    if (this.updateQueued) return false;
    for (const k of this.wanted) {
      const [l, x, y, z, path] = k.split("/").map(Number);
      if (!this.ss.peek(l, x, y, z, path)) return false;
    }
    if (this.layers.some((l) => l.visible && l.state === "loading")) return false;
    for (const l of this.layers) {
      if (l.kind !== "segmentation" || !l.ss || !l.visible) continue;
      if (l.ss.loadingCount) return false;
      for (const w of segmentationWants(l, this.xf)) if (!l.ss.peek(w.k, w.tx, w.ty, 0, w.path)) return false;
    }
    return this.ss.loadingCount === 0;
  }
}

/** Hooks for scripted checks (window.__wsi). */
export function slideHooks(get: () => SlideView | null) {
  return {
    active: () => !!get()?.active,
    idle: () => !!get()?.active && get()!.idle,
    stats: () => get()?.stats() ?? null,
    message: () => get()?.message ?? null,
    progress: () => get()?.progress ?? null,
    notice: () => get()?.notice ?? null,
    view: () => {
      const v = get();
      return v ? { cx: v.cx, cy: v.cy, scale: v.scale, level: v.level, dpr: v.dpr, w: v.canvas.width, h: v.canvas.height } : null;
    },
    setView: (cx: number, cy: number, scale: number) => get()?.setView(cx, cy, scale),
    display: () => {
      const v = get();
      return v ? JSON.parse(JSON.stringify(v.display)) : null;
    },
    setPlane: (i: number) => get()?.setPlane(i),
    setChannel: (k: number, patch: Partial<ChannelState>) => get()?.setChannel(k, patch),
    setIcc: (on: boolean) => get()?.setIcc(on),
    icc: () => {
      const ss = get()?.ss;
      return ss ? { available: !!ss.icc, on: ss.iccOn, description: ss.icc?.description ?? null } : null;
    },
    layers: () =>
      (get()?.layers ?? []).map((l) => ({
        id: l.id, kind: l.kind, title: l.title, detail: l.detail, visible: l.visible, state: l.state, error: l.error,
        drawn: l.kind === "annotations" ? l.drawn : null,
        groups: l.kind === "annotations" ? l.data?.groups.map((g) => ({ label: g.label, type: g.graphicType, count: g.count })) ?? null : null,
        segments: l.kind === "segmentation" ? l.ss?.pyramid.paths.map((p) => p.label) ?? null : null,
      })),
    setLayer: (id: string, on: boolean) => get()?.setLayer(id, on),
    pyramid: () => {
      const v = get();
      const p = v?.ss?.pyramid;
      return (
        p && {
          width: p.width, height: p.height, label: p.label, overview: p.overview, monochrome: p.monochrome,
          planes: p.planes, planesInMicrons: p.planesInMicrons, paths: p.paths.map((x) => x.label), icc: !!p.icc,
          levels: p.levels.map((l) => ({
            instance: l.instance, width: l.width, height: l.height, tileWidth: l.tileWidth, tileHeight: l.tileHeight,
            tilesAcross: l.tilesAcross, tilesDown: l.tilesDown, downsample: l.downsample, frames: l.header.numberOfFrames,
            source: v!.ss!.src.frameSource(l.instance), sparse: l.header.dimensionOrganization === "TILED_SPARSE",
          })),
        }
      );
    },
    /** Tile (level, tx, ty, plane, path) of the slide, or of a segmentation layer: frame, instance and pixels (base64). */
    tilePixels: async (level: number, tx: number, ty: number, plane = 0, path = 0, layerId?: string) => {
      const v = get();
      const ss = layerId ? (v?.layers.find((l) => l.id === layerId) as any)?.ss : v?.ss;
      if (!ss) return null;
      const ref = ss.pyramid.levels[level].frameRef(tx, ty, plane, path);
      if (!ref) return { absent: true };
      const file = await ss.src.tileFile(level, tx, ty, plane, path, { priority: 0 });
      const img = await ss.pool.decode(file, { priority: 0 });
      const u8 = new Uint8Array(img.pixels, img.frameOffsets[0], img.frameBytes);
      let bin = "";
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return { frame: ref.frame, instance: ref.instance, uid: ss.src.series.instances[ref.instance].uid, rows: img.rows, columns: img.columns, spp: img.samplesPerPixel, bits: img.bitsAllocated, photometric: img.photometric, b64: btoa(bin) };
    },
    /** The displayed (ICC-corrected when on) RGB of a slide tile, as base64. */
    tileRgb: async (level: number, tx: number, ty: number, plane = 0, path = 0) => {
      const ss = get()?.ss;
      const t = ss?.peek(level, tx, ty, plane, path) ?? (await ss?.load(level, tx, ty, plane, path, 0));
      if (!t?.bmp) return null;
      const c = new OffscreenCanvas(t.bmp.width, t.bmp.height);
      const g = c.getContext("2d")!;
      g.drawImage(t.bmp, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const rgb = new Uint8Array((d.length / 4) * 3);
      for (let i = 0, j = 0; i < d.length; i += 4, j += 3) (rgb[j] = d[i]), (rgb[j + 1] = d[i + 1]), (rgb[j + 2] = d[i + 2]);
      let bin = "";
      for (let i = 0; i < rgb.length; i += 0x8000) bin += String.fromCharCode(...rgb.subarray(i, i + 0x8000));
      return { width: c.width, height: c.height, b64: btoa(bin) };
    },
    /** Canvas pixel (RGB) at a CSS point of the slide view. */
    pixelAt: (x: number, y: number) => {
      const v = get();
      if (!v) return null;
      const r = v.canvas.getBoundingClientRect();
      const k = v.canvas.width / r.width;
      const d = (v.canvas.getContext("2d") as CanvasRenderingContext2D).getImageData(Math.round((x - r.left) * k), Math.round((y - r.top) * k), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    marks: () => get()?.ss?.metrics.marks ?? null,
    log: () => get()?.ss?.src.reader.log ?? [],
    instances: () => get()?.ss?.src.series.instances.map((i) => [i.offset, i.length]) ?? [],
  };
}
