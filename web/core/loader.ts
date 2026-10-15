// InstanceLoader: fetches, verifies and decrypts series-file byte ranges, one instance or a run of
// instances at a time. Requests are deduplicated and run through a priority queue with a fixed
// number in flight, so the slice on screen is fetched before neighbours and prefetch.
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
  /** Decrypted instances kept for re-use (default 96 MiB). */
  plaintextBudgetBytes?: number;
  /** Called when records change state (for record maps). */
  onRecords?: (fileId: string, firstRecord: number, lastRecord: number, state: RecordState) => void;
  /** Called after each verified range with ciphertext bytes received. */
  onBytes?: (bytes: number) => void;
}

export interface LoadOptions {
  priority?: number;
  signal?: AbortSignal;
}

interface Waiter {
  resolve(v: Uint8Array): void;
  reject(e: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Job {
  key: string;
  series: SeriesEntry;
  plan: RangePlan;
  priority: number;
  seq: number;
  waiters: Set<Waiter>;
  running: boolean;
  ctrl: AbortController;
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
  private plain = new Map<string, Uint8Array>();
  private plainBytes = 0;
  private budget: number;

  constructor(
    readonly resolver: LinkResolver,
    readonly decryptor: RecordDecryptor,
    private opts: LoaderOptions = {},
  ) {
    this.concurrency = opts.concurrency ?? 6;
    this.budget = opts.plaintextBudgetBytes ?? 96 * 1024 * 1024;
  }

  /** True when the instance's plaintext is cached (a load would not touch the network). */
  has(series: SeriesEntry, i: number): boolean {
    return this.plain.has(`${series.fileId}/${i}`);
  }

  /**
   * One instance as a complete DICOM Part 10 file, in a fresh buffer the caller owns (it may be
   * transferred). Asking again for a queued instance with a higher priority moves it up.
   */
  async instance(series: SeriesEntry, i: number, o: LoadOptions = {}): Promise<Uint8Array> {
    const key = `${series.fileId}/${i}`;
    const hit = this.plain.get(key);
    if (hit) {
      this.plain.delete(key);
      this.plain.set(key, hit);
      return hit.slice();
    }
    const bytes = await this.enqueue(key, series, planInstances(series, i), o);
    return bytes.slice();
  }

  /**
   * Instances first..last in one Range request. Returns each instance's bytes (views on one
   * buffer). Used by downloads; the result is not cached.
   */
  async run(series: SeriesEntry, plan: RangePlan, o: LoadOptions = {}): Promise<Uint8Array[]> {
    const key = `${series.fileId}/run/${plan.firstInstance}-${plan.lastInstance}`;
    const bytes = await this.enqueue(key, series, plan, { priority: o.priority ?? FetchPriority.Background, signal: o.signal }, false);
    const out: Uint8Array[] = [];
    const base = series.instances[plan.firstInstance].offset;
    for (let i = plan.firstInstance; i <= plan.lastInstance; i++) {
      const inst = series.instances[i];
      out.push(bytes.subarray(inst.offset - base, inst.offset - base + inst.length));
    }
    return out;
  }

  /** Drops queued (not running) requests below the given priority, e.g. on switching series. */
  cancelQueued(predicate: (fileId: string, priority: number) => boolean) {
    this.queue = this.queue.filter((j) => {
      if (!predicate(j.series.fileId, j.priority)) return true;
      for (const w of j.waiters) {
        w.signal?.removeEventListener("abort", w.onAbort!);
        w.reject(abortError());
      }
      this.jobs.delete(j.key);
      return false;
    });
  }

  private enqueue(key: string, series: SeriesEntry, plan: RangePlan, o: LoadOptions, cache = true): Promise<Uint8Array> {
    if (o.signal?.aborted) return Promise.reject(abortError());
    const priority = o.priority ?? FetchPriority.Visible;
    let job = this.jobs.get(key);
    if (!job) {
      job = { key, series, plan, priority, seq: this.seq++, waiters: new Set(), running: false, ctrl: new AbortController(), cache };
      this.jobs.set(key, job);
      this.queue.push(job);
    } else if (!job.running && priority < job.priority) {
      job.priority = priority;
      job.seq = this.seq++;
    }
    const j = job;
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
    const { series, plan } = job;
    this.opts.onRecords?.(series.fileId, plan.firstRecord, plan.lastRecord, "fetching");
    let reported = false;
    try {
      const ct = await this.resolver.fetchRange(plan, job.ctrl.signal);
      this.bytesFetched += ct.byteLength;
      this.opts.onBytes?.(ct.byteLength);
      let pt: Uint8Array;
      try {
        pt = await this.decryptor.decrypt(series, plan, ct);
      } catch (e) {
        this.opts.onRecords?.(series.fileId, plan.firstRecord, plan.lastRecord, "failed");
        reported = true;
        throw e;
      }
      this.opts.onRecords?.(series.fileId, plan.firstRecord, plan.lastRecord, "verified");
      if (job.cache) this.remember(job.key, pt);
      this.jobs.delete(job.key);
      for (const w of job.waiters) {
        w.signal?.removeEventListener("abort", w.onAbort!);
        w.resolve(pt);
      }
    } catch (e) {
      if (!reported && (e as any)?.name !== "AbortError") {
        this.opts.onRecords?.(series.fileId, plan.firstRecord, plan.lastRecord, "failed");
      }
      this.jobs.delete(job.key);
      for (const w of job.waiters) {
        w.signal?.removeEventListener("abort", w.onAbort!);
        w.reject(e);
      }
    }
  }

  private remember(key: string, pt: Uint8Array) {
    if (pt.byteLength > this.budget / 4) return;
    this.plain.set(key, pt);
    this.plainBytes += pt.byteLength;
    for (const [k, v] of this.plain) {
      if (this.plainBytes <= this.budget) break;
      this.plain.delete(k);
      this.plainBytes -= v.byteLength;
    }
  }
}
