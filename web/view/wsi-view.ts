// Whole-slide viewer: a deep-zoom tile layer over a SlideSource (web/core/wsi-source.ts).
//
// - Level: the coarsest pyramid level with at least one level pixel per 1.5 CSS pixels.
// - Tiles: visible tiles of that level are fetched nearest-first; tiles that leave the view are
//   cancelled (queued reads and decodes are dropped). Each tile is one byte range, decrypted with
//   WebCrypto, wrapped as a one-frame DICOM file and decoded in the pool's workers.
// - Placeholders: the coarsest level is always loaded; coarser cached tiles are drawn under the
//   tiles still loading.
// - Drawing: canvas 2D drawImage of ImageBitmaps (GPU-composited); no WebGL context needed.
// - Never decodes a whole pyramid level: only single frames, plus label/overview/thumbnail
//   images under WHOLE_DECODE_LIMIT.
import type { DecoderPool, DecodedImage } from "../../viewer-kit/src/index";
import { formatBytes, type OpenShare, type SeriesEntry } from "../core/index";
import { SlideSource, type WalkState } from "../core/wsi-source";
import { levelForScale, type Pyramid } from "../core/wsi";

const Priority = { Visible: 0, Near: 1, Prefetch: 2 } as const;

// ------------------------------------------------------------------------------------- session

interface TileEntry {
  bmp: ImageBitmap | null;
  bytes: number;
}

export interface SlideMetrics {
  /** performance.now() marks. */
  marks: Record<string, number>;
  tilesDecoded: number;
  tilesDrawnFirst: number | null;
  decodeMs: number[];
}

/**
 * One slide's source plus decoded tiles, shared by the overview thumbnail and the viewer so
 * nothing is fetched or decoded twice.
 */
export class SlideSession {
  readonly tiles = new Map<string, TileEntry>();
  private inflight = new Map<string, { p: Promise<TileEntry>; ctrl: AbortController; priority: number; waiters: number }>();
  tileBytes = 0;
  readonly budget: number;
  readonly metrics: SlideMetrics = { marks: {}, tilesDecoded: 0, tilesDrawnFirst: null, decodeMs: [] };
  onTile: ((key: string) => void) | null = null;
  /** Pinned keys (the coarsest level) are never evicted. */
  private pinned = new Set<string>();

  constructor(
    readonly src: SlideSource,
    readonly pool: DecoderPool,
  ) {
    const dm = (navigator as any).deviceMemory as number | undefined;
    this.budget = Math.max(96, Math.min(384, (dm ?? 8) * 32)) * 1024 * 1024;
  }

  get pyramid(): Pyramid {
    return this.src.pyramid;
  }

  static key(level: number, tx: number, ty: number) {
    return `${level}/${tx}/${ty}`;
  }

  peek(level: number, tx: number, ty: number): TileEntry | undefined {
    return this.tiles.get(SlideSession.key(level, tx, ty));
  }

  isLoading(key: string) {
    return this.inflight.has(key);
  }

  get loadingCount() {
    return this.inflight.size;
  }

  pin(key: string) {
    this.pinned.add(key);
  }

  /** Loads (fetch → decrypt → decode → bitmap) a tile; deduplicated; aborting drops queued work. */
  load(level: number, tx: number, ty: number, priority: number, signal?: AbortSignal): Promise<TileEntry> {
    const key = SlideSession.key(level, tx, ty);
    const hit = this.tiles.get(key);
    if (hit) {
      this.tiles.delete(key);
      this.tiles.set(key, hit);
      return Promise.resolve(hit);
    }
    let f = this.inflight.get(key);
    if (!f) {
      const ctrl = new AbortController();
      const p = this.fetchTile(level, tx, ty, priority, ctrl.signal).then(
        (e) => {
          this.inflight.delete(key);
          this.remember(key, e);
          this.onTile?.(key);
          return e;
        },
        (err) => {
          this.inflight.delete(key);
          throw err;
        },
      );
      p.catch(() => {});
      f = { p, ctrl, priority, waiters: 0 };
      this.inflight.set(key, f);
    } else this.raise(key, priority);
    const entry = f;
    entry.waiters++;
    if (!signal) return entry.p;
    return new Promise<TileEntry>((resolve, reject) => {
      const onAbort = () => {
        entry.waiters--;
        if (entry.waiters <= 0) entry.ctrl.abort();
        reject(new DOMException("tile aborted", "AbortError"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      entry.p.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  /** Raises a loading tile's priority: re-issuing its read moves queued records up (the reader dedupes). */
  raise(key: string, priority: number) {
    const f = this.inflight.get(key);
    if (!f || priority >= f.priority) return;
    f.priority = priority;
    const [level, tx, ty] = key.split("/").map(Number);
    const L = this.pyramid.levels[level];
    const fr = L.frameOf(tx, ty);
    if (fr >= 0 && this.src.tables[L.instance]) void this.src.frameBytes(L.instance, fr, { priority, signal: f.ctrl.signal }).catch(() => {});
  }

  private async fetchTile(level: number, tx: number, ty: number, priority: number, signal: AbortSignal): Promise<TileEntry> {
    const file = await this.src.tileFile(level, tx, ty, { priority, signal });
    if (!file) return { bmp: null, bytes: 0 };
    const t0 = performance.now();
    const img = await this.pool.decode(file, { priority, signal, key: `${this.src.series.fileId}/wsi/${level}/${tx}/${ty}` });
    this.metrics.tilesDecoded++;
    if (this.metrics.decodeMs.length < 2000) this.metrics.decodeMs.push(img.decodeMs);
    if (!this.metrics.marks.firstDecode) this.metrics.marks.firstDecode = performance.now();
    this.metrics.marks[`level${level}`] ??= performance.now();
    void t0;
    const bmp = await toBitmap(img);
    return { bmp, bytes: bmp.width * bmp.height * 4 };
  }

  /** Decodes a small whole instance (label, overview) to a bitmap. */
  async image(instance: number): Promise<ImageBitmap> {
    const bytes = await this.src.wholeInstance(instance, { priority: Priority.Near });
    const img = await this.pool.decode(bytes, { priority: Priority.Near });
    return toBitmap(img);
  }

  private remember(key: string, e: TileEntry) {
    this.tiles.set(key, e);
    this.tileBytes += e.bytes;
    if (this.tileBytes <= this.budget) return;
    for (const [k, v] of this.tiles) {
      if (this.tileBytes <= this.budget * 0.9) break;
      if (this.pinned.has(k) || k === key) continue;
      this.tiles.delete(k);
      this.tileBytes -= v.bytes;
      v.bmp?.close();
    }
  }

  /** Cancels loads not in `keep`. */
  cancelExcept(keep: Set<string>) {
    for (const [k, f] of this.inflight) {
      if (!keep.has(k) && !this.pinned.has(k)) f.ctrl.abort();
    }
  }

  dispose() {
    for (const f of this.inflight.values()) f.ctrl.abort();
    for (const t of this.tiles.values()) t.bmp?.close();
    this.tiles.clear();
  }
}

/** Decoded pixels (RGB or grey, 8 or 16 bits) → an RGBA ImageBitmap. */
async function toBitmap(img: DecodedImage): Promise<ImageBitmap> {
  const w = img.columns, h = img.rows, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  if (img.samplesPerPixel === 3 && img.bitsAllocated === 8) {
    const src = new Uint8Array(img.pixels, img.frameOffsets[0], n * 3);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      rgba[i * 4] = src[j];
      rgba[i * 4 + 1] = src[j + 1];
      rgba[i * 4 + 2] = src[j + 2];
      rgba[i * 4 + 3] = 255;
    }
  } else if (img.samplesPerPixel === 3) {
    const src = new Uint16Array(img.pixels, img.frameOffsets[0], n * 3);
    const sh = Math.max(0, img.bitsStored - 8);
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = src[i * 3] >> sh;
      rgba[i * 4 + 1] = src[i * 3 + 1] >> sh;
      rgba[i * 4 + 2] = src[i * 3 + 2] >> sh;
      rgba[i * 4 + 3] = 255;
    }
  } else {
    const src = img.bitsAllocated > 8 ? new Uint16Array(img.pixels, img.frameOffsets[0], n) : new Uint8Array(img.pixels, img.frameOffsets[0], n);
    const lo = img.minValue ?? 0, hi = Math.max(lo + 1, img.maxValue ?? 255);
    const inv = img.photometric === "MONOCHROME1";
    for (let i = 0; i < n; i++) {
      let v = Math.round(((src[i] - lo) * 255) / (hi - lo));
      if (inv) v = 255 - v;
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  }
  return createImageBitmap(new ImageData(rgba, w, h));
}

const sessions = new Map<string, Promise<SlideSession>>();

/** The slide session of a series, created once per page (headers are read once). */
export function slideSession(share: OpenShare, series: SeriesEntry, pool: DecoderPool, o: { onRecords?: OpenShareRecords } = {}): Promise<SlideSession> {
  let s = sessions.get(series.fileId);
  if (!s) {
    const t0 = performance.now();
    s = SlideSource.open(share, series, { onRecords: o.onRecords }).then((src) => {
      const ss = new SlideSession(src, pool);
      ss.metrics.marks.sessionStart = t0;
      ss.metrics.marks.headers = performance.now();
      return ss;
    });
    s.catch(() => sessions.delete(series.fileId));
    sessions.set(series.fileId, s);
  }
  return s;
}

type OpenShareRecords = (fileId: string, a: number, b: number, s: "fetching" | "verified" | "failed") => void;

/** Draws the coarsest level into a thumbnail canvas (loads its tiles at Near priority). */
export async function drawSlideThumbnail(canvas: HTMLCanvasElement, ss: SlideSession, signal?: AbortSignal) {
  const p = ss.pyramid;
  const k = p.levels.length - 1;
  const L = p.levels[k];
  const loads: Promise<unknown>[] = [];
  for (let ty = 0; ty < L.tilesDown; ty++)
    for (let tx = 0; tx < L.tilesAcross; tx++) {
      ss.pin(SlideSession.key(k, tx, ty));
      loads.push(ss.load(k, tx, ty, Priority.Near, signal).catch(() => null));
    }
  await Promise.all(loads);
  if (signal?.aborted) return;
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const s = Math.min(W / L.width, H / L.height);
  const ox = (W - L.width * s) / 2, oy = (H - L.height * s) / 2;
  ctx.imageSmoothingQuality = "high";
  for (let ty = 0; ty < L.tilesDown; ty++)
    for (let tx = 0; tx < L.tilesAcross; tx++) {
      const t = ss.peek(k, tx, ty);
      if (!t?.bmp) continue;
      const w = Math.min(L.tileWidth, L.width - tx * L.tileWidth), h = Math.min(L.tileHeight, L.height - ty * L.tileHeight);
      ctx.drawImage(t.bmp, 0, 0, w, h, ox + tx * L.tileWidth * s, oy + ty * L.tileHeight * s, w * s + 0.5, h * s + 0.5);
    }
}

// ------------------------------------------------------------------------------------- view

export interface SlideViewOptions {
  /** Shown in the stats panel. */
  onEvent?: (e: string) => void;
}

/** The deep-zoom view inside the stage element. */
export class SlideView {
  readonly root: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private mini: HTMLCanvasElement;
  private miniBase: HTMLCanvasElement | null = null;
  private statsEl: HTMLDivElement;
  private msgEl: HTMLDivElement;
  private ro: ResizeObserver;
  ss: SlideSession | null = null;
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
  private ctrl = new AbortController();
  private lastWalk: WalkState | null = null;
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
    this.root.append(this.canvas, this.mini, this.statsEl, this.msgEl);
    stage.append(this.root);
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.root);
    this.wire();
  }

  get dpr() {
    return Math.min(2, devicePixelRatio || 1);
  }

  /** Opens a slide session; draws as soon as the coarsest tiles arrive. */
  async show(ss: SlideSession, openedAt = performance.now()) {
    this.close();
    this.ctrl = new AbortController();
    this.ss = ss;
    this.active = true;
    this.openedAt = openedAt;
    this.firstTileAt = null;
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
      this.requestStats();
    };
    // The coarsest level is the placeholder and the minimap: always loaded, never evicted.
    const k = ss.pyramid.levels.length - 1;
    const L = ss.pyramid.levels[k];
    for (let ty = 0; ty < L.tilesDown; ty++) for (let tx = 0; tx < L.tilesAcross; tx++) ss.pin(SlideSession.key(k, tx, ty));
    this.requestUpdate();
    this.requestStats();
  }

  close() {
    this.ctrl.abort();
    if (this.ss) {
      this.ss.cancelExcept(new Set());
      this.ss.onTile = null;
      this.ss.src.reader.onStats = null;
      this.ss.src.onWalk = null;
    }
    this.ss = null;
    this.miniBase = null;
    this.lastWalk = null;
    this.active = false;
    this.root.classList.add("hidden");
    this.stage.classList.remove("slide-mode");
    this.msgEl.classList.add("hidden");
  }

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

  /** Base-level rectangle on screen. */
  private viewRect() {
    const W = this.canvas.width, H = this.canvas.height;
    return { x0: this.cx - W / (2 * this.scale), y0: this.cy - H / (2 * this.scale), x1: this.cx + W / (2 * this.scale), y1: this.cy + H / (2 * this.scale) };
  }

  private tileRange(k: number, r = this.viewRect(), margin = 0) {
    const L = this.ss!.pyramid.levels[k];
    const tw = L.tileWidth * L.downsample, th = L.tileHeight * L.downsample;
    return {
      tx0: Math.max(0, Math.floor(r.x0 / tw - margin)),
      ty0: Math.max(0, Math.floor(r.y0 / th - margin)),
      tx1: Math.min(L.tilesAcross - 1, Math.floor(r.x1 / tw + margin)),
      ty1: Math.min(L.tilesDown - 1, Math.floor(r.y1 / th + margin)),
    };
  }

  /** The level for the current scale: at least one level pixel per 1.5 CSS pixels. */
  private targetLevel() {
    return levelForScale(this.ss!.pyramid, (this.scale / this.dpr) / 1.5);
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

  /** Decides which tiles are wanted, cancels the rest, and starts loads nearest-first. */
  private update() {
    const ss = this.ss;
    if (!ss) return;
    const p = ss.pyramid;
    const coarsest = p.levels.length - 1;
    const k = this.targetLevel();
    this.level = k;
    const want: { key: string; k: number; tx: number; ty: number; d: number; pri: number }[] = [];
    const r = this.viewRect();
    const add = (lk: number, margin: number, pri: number) => {
      const L = p.levels[lk];
      const tr = this.tileRange(lk, r, margin);
      const tw = L.tileWidth * L.downsample, th = L.tileHeight * L.downsample;
      for (let ty = tr.ty0; ty <= tr.ty1; ty++)
        for (let tx = tr.tx0; tx <= tr.tx1; tx++) {
          const d = Math.hypot((tx + 0.5) * tw - this.cx, (ty + 0.5) * th - this.cy);
          want.push({ key: SlideSession.key(lk, tx, ty), k: lk, tx, ty, d, pri });
        }
    };
    // The coarsest level, whole: placeholders and the minimap.
    const C = p.levels[coarsest];
    for (let ty = 0; ty < C.tilesDown; ty++)
      for (let tx = 0; tx < C.tilesAcross; tx++) want.push({ key: SlideSession.key(coarsest, tx, ty), k: coarsest, tx, ty, d: -1, pri: Priority.Visible });
    if (k < coarsest) {
      add(k, 0, Priority.Visible);
      // One level coarser, so a fast zoom-in has a sharper placeholder.
      if (k + 1 < coarsest) add(k + 1, 0, Priority.Near);
    }
    want.sort((a, b) => a.pri - b.pri || a.d - b.d);
    this.wanted = new Set(want.filter((w) => w.k === k || w.k === coarsest).map((w) => w.key));
    ss.cancelExcept(new Set(want.map((w) => w.key)));
    for (const w of want) {
      if (ss.peek(w.k, w.tx, w.ty)) continue;
      if (ss.isLoading(w.key)) {
        ss.raise(w.key, w.pri);
        continue;
      }
      // Cancellation: tiles that leave the view are aborted by cancelExcept above (and by close()).
      ss.load(w.k, w.tx, w.ty, w.pri).catch((e) => {
        if ((e as any)?.name === "AbortError") return;
        this.showMessage(`A tile could not be shown: ${(e as any)?.decoderMessage ?? (e as Error)?.message ?? e}`);
      });
    }
    this.requestStats();
  }

  private showMessage(text: string) {
    this.msgEl.textContent = text;
    this.msgEl.classList.remove("hidden");
  }

  private draw() {
    const ss = this.ss;
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, W, H);
    if (!ss) return;
    const p = ss.pyramid;
    const s = this.scale;
    const X = (bx: number) => Math.round((bx - this.cx) * s + W / 2);
    const Y = (by: number) => Math.round((by - this.cy) * s + H / 2);
    // Slide area while tiles load.
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(X(0), Y(0), X(p.width) - X(0), Y(p.height) - Y(0));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = s > 1 ? "low" : "medium";
    const r = this.viewRect();
    let drawn = 0;
    for (let k = p.levels.length - 1; k >= this.level; k--) {
      const L = p.levels[k];
      const tr = this.tileRange(k, r, 0);
      const ds = L.downsample;
      for (let ty = tr.ty0; ty <= tr.ty1; ty++)
        for (let tx = tr.tx0; tx <= tr.tx1; tx++) {
          const t = ss.peek(k, tx, ty);
          if (!t?.bmp) continue;
          const lx = tx * L.tileWidth, ly = ty * L.tileHeight;
          const w = Math.min(L.tileWidth, L.width - lx), h = Math.min(L.tileHeight, L.height - ly);
          const dx0 = X(lx * ds), dy0 = Y(ly * ds), dx1 = X((lx + w) * ds), dy1 = Y((ly + h) * ds);
          if (dx1 <= dx0 || dy1 <= dy0) continue;
          // One canvas pixel of overlap hides seams from edge filtering.
          ctx.drawImage(t.bmp, 0, 0, w, h, dx0, dy0, dx1 - dx0 + 1, dy1 - dy0 + 1);
          drawn++;
        }
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
    if (!this.miniBase) {
      let all = true;
      for (let ty = 0; ty < L.tilesDown && all; ty++) for (let tx = 0; tx < L.tilesAcross; tx++) if (!ss.peek(k, tx, ty)) all = false;
      if (all) {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        void drawSlideThumbnailSync(c, ss);
        this.miniBase = c;
      }
    }
    const m = this.mini.getContext("2d")!;
    m.fillStyle = "#2a2a2a";
    m.fillRect(0, 0, w, h);
    if (this.miniBase) m.drawImage(this.miniBase, 0, 0);
    const r = this.viewRect();
    const sx = w / p.width, sy = h / p.height;
    m.strokeStyle = "#1f8fff";
    m.lineWidth = Math.max(1.5, dpr * 1.5);
    const x0 = Math.max(0, r.x0 * sx), y0 = Math.max(0, r.y0 * sy), x1 = Math.min(w, r.x1 * sx), y1 = Math.min(h, r.y1 * sy);
    if (x1 - x0 < w - 1 || y1 - y0 < h - 1) m.strokeRect(x0, y0, Math.max(3, x1 - x0), Math.max(3, y1 - y0));
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
    this.statsEl.textContent = lines.join("\n");
    this.statsEl.dataset.pct = pct.toFixed(3);
  }

  // ----------------------------------------------------------------------------------- input

  private wire() {
    const el = this.root;
    type P = { x: number; y: number; x0: number; y0: number; t0: number };
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
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
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
      if (pts.size === 1) {
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
      // Double tap (touch) zooms in at the tap.
      if (e.type === "pointerup" && e.pointerType !== "mouse" && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 10 && performance.now() - p.t0 < 300) {
        const now = performance.now();
        if (now - lastTap < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 40) {
          const [x, y] = cp(e.clientX, e.clientY);
          this.zoomAt(2, x, y);
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
      const [x, y] = cp(e.clientX, e.clientY);
      this.zoomAt(e.shiftKey ? 0.5 : 2, x, y);
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

  /** Keyboard (the stage has focus): arrows pan, +/− zoom, 0 fits. Returns true when handled. */
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
      default: return false;
    }
    return true;
  }

  /** True when every wanted tile is drawn and nothing is loading (for scripted checks). */
  get idle() {
    if (!this.ss) return true;
    if (this.updateQueued) return false;
    for (const k of this.wanted) {
      const [l, x, y] = k.split("/").map(Number);
      if (!this.ss.peek(l, x, y)) return false;
    }
    return this.ss.loadingCount === 0;
  }

  destroy() {
    this.close();
    this.ro.disconnect();
    this.root.remove();
  }
}

function drawSlideThumbnailSync(c: HTMLCanvasElement, ss: SlideSession) {
  const p = ss.pyramid;
  const k = p.levels.length - 1;
  const L = p.levels[k];
  const ctx = c.getContext("2d")!;
  const sx = c.width / L.width, sy = c.height / L.height;
  ctx.imageSmoothingQuality = "high";
  for (let ty = 0; ty < L.tilesDown; ty++)
    for (let tx = 0; tx < L.tilesAcross; tx++) {
      const t = ss.peek(k, tx, ty);
      if (!t?.bmp) continue;
      const w = Math.min(L.tileWidth, L.width - tx * L.tileWidth), h = Math.min(L.tileHeight, L.height - ty * L.tileHeight);
      ctx.drawImage(t.bmp, 0, 0, w, h, tx * L.tileWidth * sx, ty * L.tileHeight * sy, w * sx + 0.5, h * sy + 0.5);
    }
}
