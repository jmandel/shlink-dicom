// Decoder pool adapter (viewer-kit) plus an LRU of raw decoded frames.
//
//   const pool = await getDecoderPool();
//   const images = new ImageStore(loader, pool);
//   const img = await images.get(series, i, { priority: Priority.Visible });
import { DecoderPool, FrameCache, Priority, UnsupportedDicomError, type DecodedImage } from "../../viewer-kit/src/index";
import { assetUrl } from "./config";
import type { SeriesEntry } from "./bundle";
import type { InstanceLoader } from "./loader";
import { decryptParams, RecordAuthenticationError, type RecordDecryptor } from "./decrypt";
import type { RangePlan } from "./range";
import { parseHeader, type ParsedDicom } from "./dicom";
import { FrameStream, mayStreamFrames } from "./frames";

export { Priority };
export type { DecodedImage };

let poolPromise: Promise<DecoderPool> | null = null;

/**
 * The page's decoder pool, created once. Start it early (it compiles a 0.9 MB wasm and starts the
 * workers) so it is ready when the first instance arrives.
 */
export function getDecoderPool(workers?: number): Promise<DecoderPool> {
  poolPromise ??= DecoderPool.create({
    wasm: assetUrl("shl_dicom_decode.wasm"),
    workerUrl: assetUrl("decoder-worker.js"),
    workers,
  });
  return poolPromise;
}

/** Suggested frame-cache budget: min(512 MiB, deviceMemory × 64 MiB), at least 128 MiB. */
function defaultFrameBudget(): number {
  const dm = (globalThis.navigator as any)?.deviceMemory as number | undefined;
  const mib = 1024 * 1024;
  return dm ? Math.max(128 * mib, Math.min(512 * mib, dm * 64 * mib)) : 512 * mib;
}

export interface ImageGetOptions {
  priority?: number;
  signal?: AbortSignal;
  /**
   * Decode at 1/2^scale size (thumbnails). A syntax the decoder cannot reduce falls back to a
   * full-size decode. Reduced images are cached under their own key.
   */
  scale?: number;
  /** Ciphertext bytes received so far for this instance, against its length. */
  onProgress?: (received: number, total: number) => void;
}

const headers = new WeakMap<DecodedImage, Promise<ParsedDicom>>();
const parsed = new WeakMap<DecodedImage, ParsedDicom>();

/** The decoded image's header attributes (everything before Pixel Data), parsed once. */
export function imageHeader(img: DecodedImage): Promise<ParsedDicom> | null {
  if (!img.header) return null;
  let p = headers.get(img);
  if (!p) {
    headers.set(img, (p = parseHeader(img.header)));
    void p.then((h) => parsed.set(img, h), () => {});
  }
  return p;
}

/** The parsed header if it is ready (imageHeader has been called and has finished), else undefined. */
export function imageHeaderNow(img: DecodedImage): ParsedDicom | undefined {
  return parsed.get(img);
}

/** A RecordDecryptor that verifies and decrypts in the decoder workers (main thread stays free). */
export class PoolDecryptor implements RecordDecryptor {
  constructor(private pool: Promise<DecoderPool> | DecoderPool) {}
  async decrypt(series: SeriesEntry, plan: RangePlan, ciphertext: Uint8Array): Promise<Uint8Array> {
    const [pool, p] = await Promise.all([this.pool, decryptParams(series, plan)]);
    return pool.decrypt(ciphertext, p, { priority: Priority.Visible });
  }
}

/**
 * Decoded instances by `${series.id}/${index}` (and `…@1/2^s` when reduced): ciphertext from the
 * InstanceLoader goes to one decoder-worker job that verifies, decrypts and decodes it, so the
 * main thread never decrypts. Results go in an LRU of raw frames.
 */
export class ImageStore {
  readonly cache: FrameCache<string>;
  private inflight = new Map<string, { p: Promise<DecodedImage>; signal?: AbortSignal }>();
  /** Multi-frame instances read a frame at a time (frames.ts), by key; null: read whole. */
  private streams = new Map<string, Promise<FrameStream | null>>();

  constructor(
    readonly loader: InstanceLoader,
    readonly pool: DecoderPool,
    budgetBytes = defaultFrameBudget(),
  ) {
    this.cache = new FrameCache<string>(budgetBytes);
  }

  static key(series: SeriesEntry, i: number, scale = 0) {
    return scale ? `${series.id}/${i}@1/${2 ** scale}` : `${series.id}/${i}`;
  }

  /** The full-size image if it is cached, without loading. */
  peek(series: SeriesEntry, i: number): DecodedImage | undefined {
    return this.cache.get(ImageStore.key(series, i));
  }

  /**
   * Instance i read a frame at a time, once its header is in: for a multi-frame instance of a
   * class that usually is one (frames.ts, mayStreamFrames). Null when it is read whole.
   */
  frameStream(series: SeriesEntry, i: number, o: { priority?: number; signal?: AbortSignal } = {}): Promise<FrameStream | null> {
    const key = ImageStore.key(series, i);
    let s = this.streams.get(key);
    if (!s) {
      if (this.cache.get(key) || !mayStreamFrames(series, i)) return Promise.resolve(null);
      // A partly read instance holds its whole pixel buffer: keep a few.
      while (this.streams.size >= ImageStore.MAX_STREAMS) this.forgetStream(this.streams.keys().next().value!);
      s = FrameStream.open(this.loader, this.pool, series, i, { priority: o.priority ?? Priority.Visible }).catch((e) => {
        this.forgetStream(key);
        if ((e as any)?.name === "AbortError") throw e;
        return null;
      });
      void s.then((fs) => {
        this.settled.set(key, fs);
        fs?.complete.then(
          (img) => {
            this.cache.set(key, img);
            this.forgetStream(key);
          },
          () => {},
        );
      }, () => {});
      this.streams.set(key, s);
    }
    return s.then((fs) => (fs && !fs.broken ? fs : null));
  }

  /**
   * Frame k of instance i: an image with frame k ready (the whole instance, or one being filled a
   * frame at a time; see frameStream). Other frames of a partly filled image are not ready.
   */
  async getFrame(series: SeriesEntry, i: number, k: number, o: ImageGetOptions = {}): Promise<DecodedImage> {
    const whole = this.peek(series, i);
    if (whole) return whole;
    const fs = mayStreamFrames(series, i) ? await this.frameStream(series, i, o).catch(() => null) : null;
    if (fs) {
      try {
        return await fs.frame(k, { priority: o.priority, signal: o.signal });
      } catch (e) {
        if ((e as any)?.name === "AbortError" || !fs.broken) throw e;
      }
    }
    return this.get(series, i, o);
  }

  /** An image with frame k of instance i ready, without loading anything. */
  peekFrame(series: SeriesEntry, i: number, k: number): DecodedImage | undefined {
    return this.peek(series, i) ?? this.streamNow(series, i, (fs) => (fs.ready[k] ? fs.image ?? undefined : undefined));
  }

  /** Streams opened and past their header read, by key. */
  private settled = new Map<string, FrameStream | null>();
  static MAX_STREAMS = 3;

  private forgetStream(key: string) {
    this.streams.delete(key);
    this.settled.delete(key);
  }

  /** The instance's stream if its header has been read. */
  private streamNow<T>(series: SeriesEntry, i: number, f: (fs: FrameStream) => T | undefined): T | undefined {
    const fs = this.settled.get(ImageStore.key(series, i));
    return fs && !fs.broken ? f(fs) : undefined;
  }

  /**
   * Fetches, verifies, decrypts, decodes and caches instance i (all its frames). Fetch and decode
   * both use `priority`; asking again with a higher priority moves a queued request up. With
   * `scale`, a cached full-size image is returned when there is one.
   */
  get(series: SeriesEntry, i: number, o: ImageGetOptions = {}): Promise<DecodedImage> {
    const scale = o.scale ?? 0;
    const key = ImageStore.key(series, i, scale);
    const hit = this.cache.get(key) ?? (scale ? this.cache.get(ImageStore.key(series, i)) : undefined);
    if (hit) return Promise.resolve(hit);
    const priority = o.priority ?? Priority.Visible;
    // Being read a frame at a time: wait for its frames (a thumbnail needs only the middle one).
    const stream = this.streams.get(ImageStore.key(series, i));
    if (stream) {
      return stream.catch(() => null).then(async (fs) => {
        if (!fs || fs.broken) return this.getWhole(series, i, o, key, priority, scale);
        if (scale) return fs.frame(Math.floor(fs.frames / 2), { priority, signal: o.signal });
        fs.raise(priority);
        try {
          return await fs.complete;
        } catch {
          return this.getWhole(series, i, o, key, priority, scale);
        }
      });
    }
    return this.getWhole(series, i, o, key, priority, scale);
  }

  private getWhole(series: SeriesEntry, i: number, o: ImageGetOptions, key: string, priority: number, scale: number): Promise<DecodedImage> {
    const existing = this.inflight.get(key);
    if (existing && !existing.signal?.aborted) {
      // Raise the queued fetch; the decode is deduplicated by key (and raised) in the pool.
      void this.loader.ciphertext(series, i, { priority, signal: o.signal, onProgress: o.onProgress }).catch(() => {});
      if (existing.signal && !o.signal) {
        // The first request can be cancelled but this one can't: don't tie it to the first.
        return existing.p.catch(() => this.get(series, i, o));
      }
      return existing.p;
    }
    const p = (async () => {
      const { plan, bytes } = await this.loader.ciphertext(series, i, { priority, signal: o.signal, onProgress: o.onProgress });
      const encrypted = await decryptParams(series, plan);
      const report = (e: unknown) => {
        if (e instanceof RecordAuthenticationError) this.loader.report(plan, "failed");
        return e;
      };
      const decode = (s: number, b: Uint8Array) =>
        this.pool.decode(b, { priority, key: ImageStore.key(series, i, s), signal: o.signal, scale: s, encrypted, header: true });
      let img: DecodedImage;
      try {
        img = await decode(scale, scale ? bytes.slice() : bytes);
      } catch (e) {
        if (!(scale && e instanceof UnsupportedDicomError)) throw report(e);
        img = await decode(0, bytes).catch((e2) => {
          throw report(e2);
        });
      }
      this.loader.report(plan, "verified");
      this.cache.set(img.scale ? key : ImageStore.key(series, i), img);
      return img;
    })();
    const entry = { p, signal: o.signal };
    this.inflight.set(key, entry);
    const done = () => {
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    };
    p.then(done, done);
    return p;
  }
}
