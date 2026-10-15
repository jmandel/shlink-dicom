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
 * Decoded instances by `${fileId}/${index}` (and `…@1/2^s` when reduced): ciphertext from the
 * InstanceLoader goes to one decoder-worker job that verifies, decrypts and decodes it, so the
 * main thread never decrypts. Results go in an LRU of raw frames.
 */
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

  static key(series: SeriesEntry, i: number, scale = 0) {
    return scale ? `${series.fileId}/${i}@1/${2 ** scale}` : `${series.fileId}/${i}`;
  }

  /** The full-size image if it is cached, without loading. */
  peek(series: SeriesEntry, i: number): DecodedImage | undefined {
    return this.cache.get(ImageStore.key(series, i));
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
    const existing = this.inflight.get(key);
    if (existing && !existing.signal?.aborted) {
      // Raise the queued fetch; the decode is deduplicated by key (and raised) in the pool.
      void this.loader.ciphertext(series, i, { priority, signal: o.signal }).catch(() => {});
      if (existing.signal && !o.signal) {
        // The first request can be cancelled but this one can't: don't tie it to the first.
        return existing.p.catch(() => this.get(series, i, o));
      }
      return existing.p;
    }
    const p = (async () => {
      const { plan, bytes } = await this.loader.ciphertext(series, i, { priority, signal: o.signal });
      const encrypted = await decryptParams(series, plan);
      const report = (e: unknown) => {
        if (e instanceof RecordAuthenticationError) this.loader.report(plan, "failed");
        return e;
      };
      const decode = (s: number, b: Uint8Array) =>
        this.pool.decode(b, { priority, key: ImageStore.key(series, i, s), signal: o.signal, scale: s, encrypted });
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
