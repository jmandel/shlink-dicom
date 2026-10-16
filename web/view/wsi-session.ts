// A slide's tiles: fetch → decrypt → decode → ImageBitmap, deduplicated, cancellable, with a byte
// budget. Shared by the overview thumbnail, the viewer and the segmentation overlays, so nothing
// is fetched or decoded twice.
//
// Tiles are keyed by level, column, row, focal plane and optical path (or segment). How decoded
// pixels become a bitmap depends on the slide:
// - RGB (brightfield): as stored, or through the scanner's ICC profile (web/core/icc.ts);
// - single-sample (fluorescence channels): grey, scaled by a per-channel window taken from the
//   channel's first decoded tile; colour and intensity are applied when compositing;
// - segmentations: the segment's colour, opacity from the pixel value (binary or fractional).
import type { DecoderPool, DecodedImage } from "../../viewer-kit/src/index";
import type { OpenShare, SeriesEntry } from "../core/index";
import { iccToSrgb, type IccTransform } from "../core/icc";
import { SlideSource } from "../core/wsi-source";
import type { Pyramid } from "../core/wsi";

export const Priority = { Visible: 0, Near: 1, Prefetch: 2 } as const;

export interface TileEntry {
  bmp: ImageBitmap | null;
  bytes: number;
}

export interface SlideMetrics {
  /** performance.now() marks. */
  marks: Record<string, number>;
  tilesDecoded: number;
  decodeMs: number[];
}

export type BitmapMode = "image" | "segmentation";

export const tileKey = (level: number, tx: number, ty: number, plane = 0, path = 0) => `${level}/${tx}/${ty}/${plane}/${path}`;

export class SlideSession {
  readonly tiles = new Map<string, TileEntry>();
  private inflight = new Map<string, { p: Promise<TileEntry>; ctrl: AbortController; priority: number; gen: number }>();
  tileBytes = 0;
  readonly budget: number;
  readonly metrics: SlideMetrics = { marks: {}, tilesDecoded: 0, decodeMs: [] };
  onTile: ((key: string) => void) | null = null;
  /** Pinned keys (coarsest levels) are never evicted. */
  private pinned = new Set<string>();
  /** Per optical path: the window [lo, hi] for single-sample images, from the path's first tile. */
  readonly windows = new Map<number, [number, number]>();
  /** The scanner's ICC profile as a transform to sRGB (null: none, or already sRGB). */
  readonly icc: IccTransform | null;
  /** Apply the ICC profile (brightfield). */
  iccOn: boolean;
  /** Segmentations: colour of each path (segment). */
  segmentColors: [number, number, number][] = [];
  /** Changing what bitmaps look like (ICC on/off) bumps this; older loads are dropped. */
  private gen = 0;

  constructor(
    readonly src: SlideSource,
    readonly pool: DecoderPool,
    readonly mode: BitmapMode = "image",
  ) {
    const dm = (navigator as any).deviceMemory as number | undefined;
    this.budget = Math.max(96, Math.min(384, (dm ?? 8) * 32)) * 1024 * 1024;
    let t: IccTransform | null = null;
    try {
      t = mode === "image" && src.pyramid.icc && !src.pyramid.monochrome ? iccToSrgb(src.pyramid.icc) : null;
    } catch {
      t = null;
    }
    this.icc = t;
    this.iccOn = !!t;
  }

  get pyramid(): Pyramid {
    return this.src.pyramid;
  }

  peek(level: number, tx: number, ty: number, plane = 0, path = 0): TileEntry | undefined {
    return this.tiles.get(tileKey(level, tx, ty, plane, path));
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

  /** Loads (fetch → decrypt → decode → bitmap) a tile; deduplicated. */
  load(level: number, tx: number, ty: number, plane: number, path: number, priority: number): Promise<TileEntry> {
    const key = tileKey(level, tx, ty, plane, path);
    const hit = this.tiles.get(key);
    if (hit) {
      this.tiles.delete(key);
      this.tiles.set(key, hit);
      return Promise.resolve(hit);
    }
    const f = this.inflight.get(key);
    if (f) {
      this.raise(key, priority);
      return f.p;
    }
    const ctrl = new AbortController();
    const gen = this.gen;
    const p = this.fetchTile(level, tx, ty, plane, path, priority, ctrl.signal).then(
      (e) => {
        if (this.inflight.get(key)?.ctrl === ctrl) this.inflight.delete(key);
        if (gen !== this.gen) {
          e.bmp?.close();
          throw new DOMException("superseded", "AbortError");
        }
        this.remember(key, e);
        this.onTile?.(key);
        return e;
      },
      (err) => {
        if (this.inflight.get(key)?.ctrl === ctrl) this.inflight.delete(key);
        throw err;
      },
    );
    p.catch(() => {});
    this.inflight.set(key, { p, ctrl, priority, gen });
    return p;
  }

  /** Stops the loads of these tiles that are still queued or running (they load again when asked for). */
  cancel(keys: string[]) {
    for (const k of keys) {
      const f = this.inflight.get(k);
      if (!f) continue;
      f.ctrl.abort();
      this.inflight.delete(k);
    }
  }

  /** Raises a loading tile's priority: re-issuing its read moves queued records up (the reader dedupes). */
  raise(key: string, priority: number) {
    const f = this.inflight.get(key);
    if (!f || priority >= f.priority) return;
    f.priority = priority;
    const [level, tx, ty, plane, path] = key.split("/").map(Number);
    const ref = this.pyramid.levels[level].frameRef(tx, ty, plane, path);
    if (ref && this.src.tables[ref.instance]) void this.src.frameBytes(ref.instance, ref.frame, { priority, signal: f.ctrl.signal }).catch(() => {});
  }

  private async fetchTile(level: number, tx: number, ty: number, plane: number, path: number, priority: number, signal: AbortSignal): Promise<TileEntry> {
    const file = await this.src.tileFile(level, tx, ty, plane, path, { priority, signal });
    if (!file) return { bmp: null, bytes: 0 };
    const img = await this.pool.decode(file, { priority, signal, key: `${this.src.series.id}/wsi/${tileKey(level, tx, ty, plane, path)}/${this.gen}` });
    this.metrics.tilesDecoded++;
    if (this.metrics.decodeMs.length < 2000) this.metrics.decodeMs.push(img.decodeMs);
    this.metrics.marks.firstDecode ??= performance.now();
    this.metrics.marks[`level${level}`] ??= performance.now();
    const bmp = await this.toBitmap(img, path);
    return { bmp, bytes: bmp.width * bmp.height * 4 };
  }

  /** Decodes a small whole instance (label, overview) to a bitmap. */
  async image(instance: number): Promise<ImageBitmap> {
    const bytes = await this.src.wholeInstance(instance, { priority: Priority.Near });
    const img = await this.pool.decode(bytes, { priority: Priority.Near });
    return this.toBitmap(img, -1);
  }

  /** Turns the ICC transform on or off: cached tiles are dropped and load again. */
  setIcc(on: boolean) {
    if (!this.icc || on === this.iccOn) return;
    this.iccOn = on;
    this.reset();
  }

  /** Drops every tile and every load (pins stay). */
  reset() {
    this.gen++;
    for (const f of this.inflight.values()) f.ctrl.abort();
    this.inflight.clear();
    for (const t of this.tiles.values()) t.bmp?.close();
    this.tiles.clear();
    this.tileBytes = 0;
  }

  /** Decoded pixels → an RGBA ImageBitmap, as this session's mode says. */
  private toBitmap(img: DecodedImage, path: number): Promise<ImageBitmap> {
    const w = img.columns, h = img.rows, n = w * h;
    const rgba = new Uint8ClampedArray(n * 4);
    const off = img.frameOffsets[0];
    if (this.mode === "segmentation") {
      const src = img.bitsAllocated > 8 ? new Uint16Array(img.pixels, off, n) : new Uint8Array(img.pixels, off, n);
      const [r, g, b] = this.segmentColors[path] ?? [255, 214, 0];
      const max = img.bitsAllocated === 1 ? 1 : Math.max(1, this.src.headers.find((x) => x?.maxFractional)?.maxFractional ?? 255);
      for (let i = 0; i < n; i++) {
        const v = src[i];
        if (!v) continue;
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = Math.round((Math.min(v, max) / max) * 150);
      }
    } else if (img.samplesPerPixel === 3) {
      const sh = Math.max(0, img.bitsStored - 8);
      const src = img.bitsAllocated === 8 ? new Uint8Array(img.pixels, off, n * 3) : new Uint16Array(img.pixels, off, n * 3);
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        rgba[i * 4] = src[j] >> sh;
        rgba[i * 4 + 1] = src[j + 1] >> sh;
        rgba[i * 4 + 2] = src[j + 2] >> sh;
        rgba[i * 4 + 3] = 255;
      }
      if (this.icc && this.iccOn) this.icc.applyRgba(rgba, n);
    } else {
      const src = img.bitsAllocated > 8 ? new Uint16Array(img.pixels, off, n) : new Uint8Array(img.pixels, off, n);
      let win = this.windows.get(path);
      if (!win) {
        win = channelWindow(src, img.bitsAllocated > 8 ? 65536 : 256);
        if (path >= 0) this.windows.set(path, win);
      }
      const [lo, hi] = win;
      const k = 255 / Math.max(1, hi - lo);
      const inv = img.photometric === "MONOCHROME1";
      for (let i = 0; i < n; i++) {
        let v = (src[i] - lo) * k;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        if (inv) v = 255 - v;
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
        rgba[i * 4 + 3] = 255;
      }
    }
    return createImageBitmap(new ImageData(rgba, w, h));
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

  /** Cancels loads not in `keep` (pinned tiles keep loading). */
  cancelExcept(keep: Set<string>) {
    for (const [k, f] of this.inflight) {
      if (!keep.has(k) && !this.pinned.has(k)) {
        f.ctrl.abort();
        this.inflight.delete(k);
      }
    }
  }
}

/** A display window for a fluorescence channel: the 0.5th to 99.8th percentile of a tile. */
function channelWindow(src: Uint8Array | Uint16Array, levels: number): [number, number] {
  const hist = new Uint32Array(levels);
  for (let i = 0; i < src.length; i++) hist[src[i]]++;
  const n = src.length;
  let acc = 0, lo = 0, hi = levels - 1;
  for (let v = 0; v < levels; v++) {
    acc += hist[v];
    if (acc >= n * 0.005) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = levels - 1; v >= 0; v--) {
    acc += hist[v];
    if (acc >= n * 0.002) {
      hi = v;
      break;
    }
  }
  return [lo, Math.max(lo + 1, hi)];
}

const sessions = new Map<string, Promise<SlideSession>>();

type Records = (fileId: string, a: number, b: number, s: "fetching" | "verified" | "failed") => void;

/** The session of a series, created once per page (headers are read once). */
export function slideSession(share: OpenShare, series: SeriesEntry, pool: DecoderPool, o: { onRecords?: Records; mode?: BitmapMode } = {}): Promise<SlideSession> {
  let s = sessions.get(series.id);
  if (!s) {
    const t0 = performance.now();
    s = SlideSource.open(share, series, { onRecords: o.onRecords }).then((src) => {
      const ss = new SlideSession(src, pool, o.mode);
      // The full headers described a different pyramid than the first reads: start the tiles over.
      src.onPyramid = () => {
        ss.reset();
        ss.onTile?.("");
      };
      ss.metrics.marks.sessionStart = t0;
      ss.metrics.marks.headers = performance.now();
      return ss;
    });
    s.catch(() => sessions.delete(series.id));
    sessions.set(series.id, s);
  }
  return s;
}
