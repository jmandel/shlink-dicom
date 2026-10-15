// Decoder pool adapter (viewer-kit) plus an LRU of raw decoded frames.
//
//   const pool = await getDecoderPool();
//   const images = new ImageStore(loader, pool);
//   const img = await images.get(series, i, { priority: Priority.Visible });
import { DecoderPool, FrameCache, Priority, type DecodedImage } from "../../viewer-kit/src/index";
import { assetUrl } from "./config";
import type { SeriesEntry } from "./bundle";
import type { InstanceLoader } from "./loader";

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
export function defaultFrameBudget(): number {
  const dm = (globalThis.navigator as any)?.deviceMemory as number | undefined;
  const mib = 1024 * 1024;
  return dm ? Math.max(128 * mib, Math.min(512 * mib, dm * 64 * mib)) : 512 * mib;
}

export interface ImageGetOptions {
  priority?: number;
  signal?: AbortSignal;
}

/** Decoded instances by `${fileId}/${index}`: fetch + decrypt (InstanceLoader) → decode (pool) → LRU. */
export class ImageStore {
  readonly cache: FrameCache<string>;
  private inflight = new Map<string, { p: Promise<DecodedImage>; signal?: AbortSignal }>();

  constructor(
    readonly loader: InstanceLoader,
    readonly pool: DecoderPool,
    budgetBytes = defaultFrameBudget(),
  ) {
    this.cache = new FrameCache<string>(budgetBytes);
  }

  static key(series: SeriesEntry, i: number) {
    return `${series.fileId}/${i}`;
  }

  /** The decoded image if it is cached, without loading. */
  peek(series: SeriesEntry, i: number): DecodedImage | undefined {
    return this.cache.get(ImageStore.key(series, i));
  }

  /**
   * Fetches, verifies, decodes and caches instance i (all its frames). Fetch and decode both use
   * `priority`; asking again with a higher priority moves a queued request up.
   */
  get(series: SeriesEntry, i: number, o: ImageGetOptions = {}): Promise<DecodedImage> {
    const key = ImageStore.key(series, i);
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const priority = o.priority ?? Priority.Visible;
    const existing = this.inflight.get(key);
    if (existing && !existing.signal?.aborted) {
      // Raise the queued fetch; the decode is deduplicated by key (and raised) in the pool.
      void this.loader.instance(series, i, { priority, signal: o.signal }).catch(() => {});
      if (existing.signal && !o.signal) {
        // The first request can be cancelled but this one can't: don't tie it to the first.
        return existing.p.catch(() => this.get(series, i, o));
      }
      return existing.p;
    }
    const p = (async () => {
      const bytes = await this.loader.instance(series, i, { priority, signal: o.signal });
      const img = await this.pool.decode(bytes, { priority, key, signal: o.signal });
      this.cache.set(key, img);
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

  /** Every frame of a multi-frame instance, decoded in parallel chunks (cine, enhanced MR/CT, tomo); not cached. */
  async getFrames(
    series: SeriesEntry,
    i: number,
    o: ImageGetOptions & { onChunk?: (chunk: DecodedImage) => void } = {},
  ): Promise<DecodedImage> {
    const bytes = await this.loader.instance(series, i, { priority: o.priority, signal: o.signal });
    return this.pool.decodeFrames(bytes, { priority: o.priority, signal: o.signal, onChunk: o.onChunk });
  }
}
