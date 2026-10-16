// InstanceLoader: fetches byte ranges of the linked files, one instance or a run of instances at a time.
//
// Reads are planned in records (PROPOSAL.md §9.3), not instances. Instances rarely end on a record
// boundary, so neighbouring instances share a record; a record already fetched (or on its way for
// another instance) is not asked for again. Missing records go into spans: one Range request each,
// run through a priority queue with a fixed number in flight, so the slice on screen is fetched
// before neighbours and prefetch. When a span starts, queued spans of the same series that follow
// it in the file (and, if they are at least as urgent, precede it) join it, up to MERGE_RECORDS, so
// a series being prefetched costs a few requests instead of one per instance. A span's records are
// handed on as they arrive, so an instance at the front of a long request is not kept waiting for
// the rest of it.
//
// Verified-or-not ciphertext records are kept in an LRU (they are what the server holds, so they
// are safe to keep); a record whose check fails is dropped from it (`report(plan, "failed")`).
//
// Decryption is the decryptor's (decrypt.ts): `instance()` and `run()` return plaintext through it.
// ImageStore (images.ts) instead takes `ciphertext()` and decrypts and decodes in one worker job.
import type { SeriesEntry } from "./bundle";
import type { RecordDecryptor } from "./decrypt";
import { planInstances, RECORD_CIPHERTEXT, type RangePlan } from "./range";
import type { LinkResolver } from "./resolver";

/** Same values as viewer-kit's Priority: lower runs first. */
export const FetchPriority = { Visible: 0, Near: 1, Prefetch: 2, Background: 3 } as const;

export type RecordState = "fetching" | "verified" | "failed";

/** Most records one request carries after queued neighbours join it (2 MiB of ciphertext). */
export const MERGE_RECORDS = 32;

export interface LoaderOptions {
  /** Range requests in flight at once (default 6). Prefetch and background reads leave two of them free. */
  concurrency?: number;
  /** Ciphertext records kept for re-use (default 96 MiB). */
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

interface Deferred {
  promise: Promise<Uint8Array>;
  resolve(v: Uint8Array): void;
  reject(e: unknown): void;
  done: boolean;
}

/** One Range request: records first..last of a file, or a span merged into another. */
interface Span {
  fileId: string;
  /** SeriesEntry.id of the series the span was asked for (cancelQueued; merges stay within it). */
  seriesId: string;
  series: SeriesEntry;
  first: number;
  last: number;
  priority: number;
  seq: number;
  /** Requests waiting on this span (or a span merged into it). */
  refs: number;
  running: boolean;
  /** Keep its records in the cache. */
  cache: boolean;
  /** Ciphertext bytes received so far, from the span's first record. */
  received: number;
  /** Records not yet handed on. */
  waiting: Map<number, Deferred>;
  listeners: Set<() => void>;
  /** Set when this span joined another one. */
  into?: Span;
  /** Aborts the request when nobody waits for it any more. */
  abort?: AbortController;
}

const abortError = () => new DOMException("load aborted", "AbortError");

function deferred(): Deferred {
  let resolve!: (v: Uint8Array) => void, reject!: (e: unknown) => void;
  const promise = new Promise<Uint8Array>((a, b) => ((resolve = a), (reject = b)));
  promise.catch(() => {});
  const d: Deferred = {
    promise,
    resolve: (v) => ((d.done = true), resolve(v)),
    reject: (e) => ((d.done = true), reject(e)),
    done: false,
  };
  return d;
}

const root = (s: Span): Span => (s.into ? root(s.into) : s);

export class InstanceLoader {
  readonly concurrency: number;
  /** Ciphertext bytes received so far. */
  bytesFetched = 0;
  private queue: Span[] = [];
  private running = 0;
  private runningBulk = 0;
  private seq = 0;
  /** Records on their way: `${fileId}:${record}` → the span fetching it. */
  private pending = new Map<string, Span>();
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
    if (state === "failed") for (let r = plan.firstRecord; r <= plan.lastRecord; r++) this.forget(`${plan.fileId}:${r}`);
    this.opts.onRecords?.(plan.fileId, plan.firstRecord, plan.lastRecord, state);
  }

  /**
   * Instance i's ciphertext (the records covering it), in a fresh buffer the caller owns and may
   * transfer. Asking again for a queued instance with a higher priority moves it up.
   */
  async ciphertext(series: SeriesEntry, i: number, o: LoadOptions = {}): Promise<{ plan: RangePlan; bytes: Uint8Array }> {
    const plan = planInstances(series, i);
    const bytes = await this.records(series, plan, o, true);
    return { plan, bytes };
  }

  /**
   * The ciphertext of a byte plan (planBytes) through the same queue and record cache, so a header
   * read and the instance's later full read share their records.
   */
  range(series: SeriesEntry, plan: RangePlan, o: LoadOptions = {}): Promise<Uint8Array> {
    return this.records(series, plan, o, true);
  }

  /** One instance as a complete DICOM Part 10 file, verified and decrypted by the decryptor. */
  async instance(series: SeriesEntry, i: number, o: LoadOptions = {}): Promise<Uint8Array> {
    const { plan, bytes } = await this.ciphertext(series, i, o);
    return this.decrypt(series, plan, bytes);
  }

  /**
   * Instances first..last in one Range request (fewer, when some of their records are already
   * here), verified and decrypted. Returns each instance's bytes (views on one buffer). Used by
   * downloads; what it fetches is not cached.
   */
  async run(series: SeriesEntry, plan: RangePlan, o: LoadOptions = {}): Promise<Uint8Array[]> {
    const ct = await this.records(series, plan, { priority: o.priority ?? FetchPriority.Background, signal: o.signal, onProgress: o.onProgress }, false);
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
    this.queue = this.queue.filter((s) => {
      if (!predicate(s.seriesId, s.priority)) return true;
      this.drop(s, abortError());
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

  private recordLength(series: SeriesEntry, r: number): number {
    return Math.min(RECORD_CIPHERTEXT, series.file.ciphertextLength - r * RECORD_CIPHERTEXT);
  }

  /** Records plan.firstRecord..plan.lastRecord of the plan's file, joined into one fresh buffer. */
  private records(series: SeriesEntry, plan: RangePlan, o: LoadOptions, cache: boolean): Promise<Uint8Array> {
    if (o.signal?.aborted) return Promise.reject(abortError());
    const fileId = plan.fileId;
    const priority = o.priority ?? FetchPriority.Visible;
    const parts: (Uint8Array | Deferred)[] = [];
    const used = new Set<Span>();
    let missingFrom = -1;
    const addSpan = (a: number, b: number) => {
      const s: Span = {
        fileId, seriesId: series.id, series, first: a, last: b, priority, seq: this.seq++, refs: 0, running: false, cache, received: 0,
        waiting: new Map(), listeners: new Set(),
      };
      for (let r = a; r <= b; r++) {
        const d = deferred();
        s.waiting.set(r, d);
        this.pending.set(`${fileId}:${r}`, s);
        parts[r - plan.firstRecord] = d;
      }
      this.queue.push(s);
      used.add(s);
    };
    for (let r = plan.firstRecord; r <= plan.lastRecord; r++) {
      const key = `${fileId}:${r}`;
      const hit = this.cached.get(key);
      const span = hit ? undefined : this.pending.get(key);
      if (hit || span) {
        if (missingFrom >= 0) addSpan(missingFrom, r - 1), (missingFrom = -1);
        if (hit) {
          // Most recently used last.
          this.cached.delete(key);
          this.cached.set(key, hit);
          parts[r - plan.firstRecord] = hit;
        } else {
          const s = root(span!);
          parts[r - plan.firstRecord] = s.waiting.get(r)!;
          if (!s.running && priority < s.priority) {
            s.priority = priority;
            s.seq = this.seq++;
          }
          used.add(s);
        }
      } else if (missingFrom < 0) missingFrom = r;
    }
    if (missingFrom >= 0) addSpan(missingFrom, plan.lastRecord);

    const total = plan.ciphertextEnd - plan.ciphertextStart;
    const spans = [...used];
    for (const s of spans) s.refs++;
    let released = false;
    // This request no longer needs its spans: a queued span nobody needs is dropped, a running one
    // aborted (its records already here stay).
    const release = () => {
      if (released) return;
      released = true;
      for (const s of spans) {
        const r = root(s);
        r.refs--;
        if (r.refs > 0) continue;
        if (r.running) {
          if (!r.waiting.size) continue;
          // New requests for its records start their own spans.
          for (const k of r.waiting.keys()) if (this.pending.get(`${r.fileId}:${k}`) === r) this.pending.delete(`${r.fileId}:${k}`);
          r.abort?.abort();
        } else if (this.queue.includes(r)) {
          this.queue = this.queue.filter((x) => x !== r);
          this.drop(r, abortError());
        }
      }
    };
    let progress: (() => void) | null = null;
    if (o.onProgress) {
      const on = o.onProgress;
      let last = -1;
      progress = () => {
        let n = 0;
        for (let r = plan.firstRecord; r <= plan.lastRecord; r++) {
          const p = parts[r - plan.firstRecord];
          const len = this.recordLength(series, r);
          if (p instanceof Uint8Array || (p as Deferred).done) n += len;
          else {
            const s = root(this.pending.get(`${fileId}:${r}`) ?? spans[0]);
            n += Math.max(0, Math.min(len, s.received - (r - s.first) * RECORD_CIPHERTEXT));
          }
        }
        if (n !== last) on((last = n), total);
      };
      for (const s of spans) s.listeners.add(progress);
      progress();
    }

    const result = new Promise<Uint8Array>((resolve, reject) => {
      const onAbort = () => {
        release();
        reject(abortError());
      };
      o.signal?.addEventListener("abort", onAbort, { once: true });
      Promise.all(parts.map((p) => (p instanceof Uint8Array ? p : p.promise))).then(
        (chunks) => {
          o.signal?.removeEventListener("abort", onAbort);
          if (released) return;
          release();
          const out = new Uint8Array(total);
          let k = 0;
          for (const c of chunks) {
            out.set(c, k);
            k += c.byteLength;
          }
          resolve(out);
        },
        (e) => {
          o.signal?.removeEventListener("abort", onAbort);
          release();
          reject(e);
        },
      );
    });
    if (progress) {
      const p = progress;
      void result.finally(() => spans.forEach((s) => root(s).listeners.delete(p))).catch(() => {});
    }
    this.pump();
    return result;
  }

  /** Rejects a queued span's records and forgets it. */
  private drop(s: Span, e: unknown) {
    for (const [r, d] of s.waiting) {
      if (this.pending.get(`${s.fileId}:${r}`) === s) this.pending.delete(`${s.fileId}:${r}`);
      d.reject(e);
    }
    s.waiting.clear();
  }

  private isBulk(s: Span) {
    return s.priority >= FetchPriority.Prefetch;
  }

  private pump() {
    while (this.running < this.concurrency && this.queue.length) {
      let best = -1;
      for (let k = 0; k < this.queue.length; k++) {
        const a = this.queue[k];
        if (this.isBulk(a) && this.runningBulk >= this.concurrency - 2) continue;
        const b = best >= 0 ? this.queue[best] : null;
        if (!b || a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = k;
      }
      if (best < 0) return;
      const span = this.queue.splice(best, 1)[0];
      if (span.cache) this.merge(span);
      span.running = true;
      this.running++;
      const bulk = this.isBulk(span);
      if (bulk) this.runningBulk++;
      void this.runSpan(span).finally(() => {
        this.running--;
        if (bulk) this.runningBulk--;
        this.pump();
      });
    }
  }

  /** Queued spans of the same series next to `s` in its file join it. */
  private merge(s: Span) {
    for (;;) {
      if (s.last - s.first + 1 >= MERGE_RECORDS) return;
      const k = this.queue.findIndex(
        (q) =>
          q.cache && q.fileId === s.fileId && q.seriesId === s.seriesId &&
          ((q.first === s.last + 1 && q.last - s.first + 1 <= MERGE_RECORDS) ||
            // Before it only when at least as urgent: its bytes would arrive first.
            (q.last === s.first - 1 && q.priority <= s.priority && s.last - q.first + 1 <= MERGE_RECORDS)),
      );
      if (k < 0) return;
      const q = this.queue.splice(k, 1)[0];
      q.into = s;
      s.first = Math.min(s.first, q.first);
      s.last = Math.max(s.last, q.last);
      s.refs += q.refs;
      for (const [r, d] of q.waiting) {
        s.waiting.set(r, d);
        this.pending.set(`${s.fileId}:${r}`, s);
      }
      q.waiting.clear();
      for (const l of q.listeners) s.listeners.add(l);
      q.listeners.clear();
    }
  }

  private async runSpan(s: Span) {
    const series = s.series;
    const start = s.first * RECORD_CIPHERTEXT;
    const end = Math.min(series.file.ciphertextLength, (s.last + 1) * RECORD_CIPHERTEXT);
    const plan: RangePlan = {
      fileId: s.fileId,
      firstInstance: -1,
      lastInstance: -1,
      plaintextStart: -1,
      plaintextEnd: -1,
      firstRecord: s.first,
      lastRecord: s.last,
      ciphertextStart: start,
      ciphertextEnd: end,
      rangeHeader: `bytes=${start}-${end - 1}`,
    };
    this.opts.onRecords?.(s.fileId, s.first, s.last, "fetching");
    s.abort = new AbortController();
    let next = s.first;
    // Hands on every record that has fully arrived.
    const deliver = (buf: Uint8Array, received: number) => {
      while (next <= s.last) {
        const a = (next - s.first) * RECORD_CIPHERTEXT;
        const b = Math.min(a + RECORD_CIPHERTEXT, end - start);
        if (received < b) break;
        const rec = buf.slice(a, b);
        const key = `${s.fileId}:${next}`;
        if (s.cache) this.remember(key, rec);
        if (this.pending.get(key) === s) this.pending.delete(key);
        s.waiting.get(next)?.resolve(rec);
        s.waiting.delete(next);
        next++;
      }
    };
    try {
      const ct = await this.resolver.fetchRange(plan, s.abort.signal, (received, _total, buf) => {
        s.received = received;
        if (buf) deliver(buf, received);
        for (const l of s.listeners) l();
      });
      s.received = ct.byteLength;
      deliver(ct, ct.byteLength);
      this.bytesFetched += ct.byteLength;
      this.opts.onBytes?.(ct.byteLength);
      for (const l of s.listeners) l();
    } catch (e) {
      // Abandoned (nobody waits for it): not a failure of the records.
      if ((e as any)?.name !== "AbortError") this.opts.onRecords?.(s.fileId, s.first, s.last, "failed");
      this.drop(s, e);
    }
  }

  private forget(key: string) {
    const v = this.cached.get(key);
    if (!v) return;
    this.cached.delete(key);
    this.cachedBytes -= v.byteLength;
  }

  private remember(key: string, ct: Uint8Array) {
    this.forget(key);
    this.cached.set(key, ct);
    this.cachedBytes += ct.byteLength;
    for (const [k, v] of this.cached) {
      if (this.cachedBytes <= this.budget) break;
      this.cached.delete(k);
      this.cachedBytes -= v.byteLength;
    }
  }
}
