// InstanceLoader: fetches byte ranges of the linked files, one instance or a run of instances at a time.
// Requests are deduplicated and run through a priority queue with a fixed number in flight, so the
// slice on screen is fetched before neighbours and prefetch. Verified ciphertext is not needed
// again once decoded, but a thumbnail and the full image of one instance both start from it, so
// instance ciphertext is kept in a small LRU (it is safe to keep: it is what the server holds).
//
// Decryption is the decryptor's (decrypt.ts): `instance()` and `run()` return plaintext through it.
// ImageStore (images.ts) instead takes `ciphertext()` and decrypts and decodes in one worker job.
import type { SeriesEntry } from "./bundle";
import type { RecordDecryptor } from "./decrypt";
import { planInstances, type RangePlan } from "./range";
import type { LinkResolver } from "./resolver";

/** Same values as viewer-kit's Priority: lower runs first. */
export const FetchPriority = { Visible: 0, Near: 1, Prefetch: 2, Background: 3 } as const;

export type RecordState = "fetching" | "verified" | "failed";

export interface LoaderOptions {
  /** Range requests in flight at once (default 6). */
  concurrency?: number;
  /** Instance ciphertext kept for re-use (default 96 MiB). */
  cacheBytes?: number;
  /** Called when records change state (for record maps and the trust count). */
  onRecords?: (fileId: string, firstRecord: number, lastRecord: number, state: RecordState) => void;
  /** Called after each range arrives, with its ciphertext bytes. */
  onBytes?: (bytes: number) => void;
}

export interface LoadOptions {
  priority?: number;
  signal?: AbortSignal;
  /** Ciphertext bytes received so far, against the instance's ciphertext length. */
  onProgress?: (received: number, total: number) => void;
}

interface Waiter {
  resolve(v: Uint8Array): void;
  reject(e: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Job {
  key: string;
  /** SeriesEntry.id of the series the plan reads. */
  seriesId: string;
  plan: RangePlan;
  priority: number;
  seq: number;
  waiters: Set<Waiter>;
  listeners: Set<(received: number, total: number) => void>;
  running: boolean;
  cache: boolean;
}

const abortError = () => new DOMException("load aborted", "AbortError");

export class InstanceLoader {
  readonly concurrency: number;
  /** Ciphertext bytes received so far. */
  bytesFetched = 0;
  private queue: Job[] = [];
  private jobs = new Map<string, Job>();
  private running = 0;
  private seq = 0;
  private cached = new Map<string, Uint8Array>();
  private cachedBytes = 0;
  private budget: number;

  constructor(
    readonly resolver: LinkResolver,
    readonly decryptor: RecordDecryptor,
    private opts: LoaderOptions = {},
  ) {
    this.concurrency = opts.concurrency ?? 6;
    this.budget = opts.cacheBytes ?? 96 * 1024 * 1024;
  }

  /** Reports a decrypt outcome for a plan's records (decryptors running elsewhere call this). */
  report(plan: RangePlan, state: RecordState) {
    this.opts.onRecords?.(plan.fileId, plan.firstRecord, plan.lastRecord, state);
  }

  /**
   * Instance i's ciphertext (the records covering it), in a fresh buffer the caller owns and may
   * transfer. Asking again for a queued instance with a higher priority moves it up.
   */
  async ciphertext(series: SeriesEntry, i: number, o: LoadOptions = {}): Promise<{ plan: RangePlan; bytes: Uint8Array }> {
    const plan = planInstances(series, i);
    const key = `${series.id}/${i}`;
    const hit = this.cached.get(key);
    if (hit) {
      this.cached.delete(key);
      this.cached.set(key, hit);
      o.onProgress?.(hit.byteLength, hit.byteLength);
      return { plan, bytes: hit.slice() };
    }
    const bytes = await this.enqueue(key, series.id, plan, o, true);
    return { plan, bytes: bytes.slice() };
  }

  /** One instance as a complete DICOM Part 10 file, verified and decrypted by the decryptor. */
  async instance(series: SeriesEntry, i: number, o: LoadOptions = {}): Promise<Uint8Array> {
    const { plan, bytes } = await this.ciphertext(series, i, o);
    return this.decrypt(series, plan, bytes);
  }

  /**
   * Instances first..last in one Range request, verified and decrypted. Returns each instance's
   * bytes (views on one buffer). Used by downloads; not cached.
   */
  async run(series: SeriesEntry, plan: RangePlan, o: LoadOptions = {}): Promise<Uint8Array[]> {
    const key = `${series.id}/run/${plan.firstInstance}-${plan.lastInstance}`;
    const ct = await this.enqueue(key, series.id, plan, { priority: o.priority ?? FetchPriority.Background, signal: o.signal }, false);
    const bytes = await this.decrypt(series, plan, ct);
    const out: Uint8Array[] = [];
    const base = series.instances[plan.firstInstance].offset;
    for (let i = plan.firstInstance; i <= plan.lastInstance; i++) {
      const inst = series.instances[i];
      out.push(bytes.subarray(inst.offset - base, inst.offset - base + inst.length));
    }
    return out;
  }

  /**
   * Drops queued (not running) requests, e.g. the prefetch of a series the user has left.
   * `predicate` gets the request's SeriesEntry.id and priority.
   */
  cancelQueued(predicate: (seriesId: string, priority: number) => boolean) {
    this.queue = this.queue.filter((j) => {
      if (!predicate(j.seriesId, j.priority)) return true;
      for (const w of j.waiters) {
        w.signal?.removeEventListener("abort", w.onAbort!);
        w.reject(abortError());
      }
      this.jobs.delete(j.key);
      return false;
    });
  }

  private async decrypt(series: SeriesEntry, plan: RangePlan, ct: Uint8Array): Promise<Uint8Array> {
    try {
      const pt = await this.decryptor.decrypt(series, plan, ct);
      this.report(plan, "verified");
      return pt;
    } catch (e) {
      if ((e as any)?.name !== "AbortError") this.report(plan, "failed");
      throw e;
    }
  }

  private enqueue(key: string, seriesId: string, plan: RangePlan, o: LoadOptions, cache: boolean): Promise<Uint8Array> {
    if (o.signal?.aborted) return Promise.reject(abortError());
    const priority = o.priority ?? FetchPriority.Visible;
    let job = this.jobs.get(key);
    if (!job) {
      job = { key, seriesId, plan, priority, seq: this.seq++, waiters: new Set(), listeners: new Set(), running: false, cache };
      this.jobs.set(key, job);
      this.queue.push(job);
    } else if (!job.running && priority < job.priority) {
      job.priority = priority;
      job.seq = this.seq++;
    }
    const j = job;
    if (o.onProgress) j.listeners.add(o.onProgress);
    const p = new Promise<Uint8Array>((resolve, reject) => {
      const w: Waiter = { resolve, reject, signal: o.signal };
      if (o.signal) {
        w.onAbort = () => {
          j.waiters.delete(w);
          reject(abortError());
          if (j.waiters.size === 0 && !j.running) {
            this.queue = this.queue.filter((x) => x !== j);
            this.jobs.delete(j.key);
          }
        };
        o.signal.addEventListener("abort", w.onAbort, { once: true });
      }
      j.waiters.add(w);
    });
    this.pump();
    return p;
  }

  private pump() {
    while (this.running < this.concurrency && this.queue.length) {
      let best = 0;
      for (let k = 1; k < this.queue.length; k++) {
        const a = this.queue[k], b = this.queue[best];
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = k;
      }
      const job = this.queue.splice(best, 1)[0];
      this.running++;
      job.running = true;
      void this.runJob(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async runJob(job: Job) {
    const { plan } = job;
    this.report(plan, "fetching");
    try {
      // Listeners can join while the request runs (a thumbnail asking for a prefetched slice).
      const ct = await this.resolver.fetchRange(plan, undefined, (r, t) => job.listeners.forEach((f) => f(r, t)));
      this.bytesFetched += ct.byteLength;
      this.opts.onBytes?.(ct.byteLength);
      if (job.cache) this.remember(job.key, ct);
      this.jobs.delete(job.key);
      for (const w of job.waiters) {
        w.signal?.removeEventListener("abort", w.onAbort!);
        w.resolve(job.waiters.size > 1 ? ct.slice() : ct);
      }
    } catch (e) {
      this.report(plan, "failed");
      this.jobs.delete(job.key);
      for (const w of job.waiters) {
        w.signal?.removeEventListener("abort", w.onAbort!);
        w.reject(e);
      }
    }
  }

  private remember(key: string, ct: Uint8Array) {
    if (ct.byteLength > this.budget / 4) return;
    this.cached.set(key, ct);
    this.cachedBytes += ct.byteLength;
    for (const [k, v] of this.cached) {
      if (this.cachedBytes <= this.budget) break;
      this.cached.delete(k);
      this.cachedBytes -= v.byteLength;
    }
  }
}
