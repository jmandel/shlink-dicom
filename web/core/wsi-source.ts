// SlideSource: a whole-slide series read through byte ranges of its encrypted series file.
//
//   const src = await SlideSource.open(share, series, { onRecords });
//   src.pyramid.levels[k]                       // finest first
//   const file = await src.tileFile(k, tx, ty, { priority, signal });   // one-frame Part 10 file
//   const img = await pool.decode(file, { key, priority, signal });
//
// Reads go through SeriesReader: a cache of verified, decrypted 64 KiB records (PROPOSAL.md §9.3)
// with a byte budget, and a priority queue that merges adjacent missing records into one Range
// request. A frame is located from, in order: the Extended Offset Table, the Basic Offset Table,
// native frame arithmetic, or by walking the fragment item headers from the start of Pixel Data
// (sequential; what it learns is kept). A sharer can add the tables when packing
// (crates/shl-dicom-core/src/offset_tables.rs).
import type { SeriesEntry } from "./bundle";
import type { RecordDecryptor } from "./decrypt";
import { planBytes, RECORD_PLAINTEXT } from "./range";
import type { LinkResolver } from "./resolver";
import type { RecordState } from "./loader";
import {
  buildPyramid,
  FragmentWalker,
  frameTableFromHeader,
  parseSlideHeader,
  singleFrameFile,
  type FrameTable,
  type Pyramid,
  type SlideHeader,
} from "./wsi";

export type ReadPurpose = "header" | "walk" | "tile" | "image";

export interface ReadOptions {
  priority?: number;
  signal?: AbortSignal;
  purpose?: ReadPurpose;
}

export interface ReaderStats {
  requests: number;
  /** Ciphertext bytes received. */
  bytes: number;
  byPurpose: Record<ReadPurpose, { requests: number; bytes: number }>;
  /** Records currently cached, and their plaintext bytes. */
  cachedRecords: number;
  cachedBytes: number;
}

interface Job {
  first: number;
  last: number;
  priority: number;
  seq: number;
  purpose: ReadPurpose;
  waiters: number;
  running: boolean;
  promise: Promise<void>;
  resolve(): void;
  reject(e: unknown): void;
}

const abortError = () => new DOMException("read aborted", "AbortError");

/** Verified, decrypted records of one series file, fetched on demand through a priority queue. */
export class SeriesReader {
  readonly stats: ReaderStats = {
    requests: 0,
    bytes: 0,
    byPurpose: { header: { requests: 0, bytes: 0 }, walk: { requests: 0, bytes: 0 }, tile: { requests: 0, bytes: 0 }, image: { requests: 0, bytes: 0 } },
    cachedRecords: 0,
    cachedBytes: 0,
  };
  /** The last 5,000 requests: purpose, record range, ciphertext bytes, ms. */
  readonly log: { purpose: ReadPurpose; first: number; last: number; bytes: number; ms: number; t: number }[] = [];
  /** Called after every response (for live counters). */
  onStats: (() => void) | null = null;
  private cache = new Map<number, Uint8Array>();
  private pending = new Map<number, Job>();
  private queue: Job[] = [];
  private running = 0;
  private seq = 0;

  constructor(
    readonly resolver: LinkResolver,
    readonly decryptor: RecordDecryptor,
    readonly series: SeriesEntry,
    private o: {
      concurrency?: number;
      /** Plaintext bytes of records kept (default 64 MiB). */
      budgetBytes?: number;
      /** Records per request at most (default 64, 4 MiB). */
      maxRun?: number;
      onRecords?: (fileId: string, first: number, last: number, s: RecordState) => void;
    } = {},
  ) {}

  /** Plaintext bytes [a, b) of the series file. */
  async read(a: number, b: number, o: ReadOptions = {}): Promise<Uint8Array> {
    if (o.signal?.aborted) throw abortError();
    const r0 = Math.floor(a / RECORD_PLAINTEXT), r1 = Math.floor((b - 1) / RECORD_PLAINTEXT);
    const priority = o.priority ?? 0;
    const jobs = new Set<Job>();
    let runStart = -1;
    const maxRun = this.o.maxRun ?? 64;
    const flush = (end: number) => {
      if (runStart < 0) return;
      for (let s = runStart; s <= end; s += maxRun) jobs.add(this.enqueue(s, Math.min(end, s + maxRun - 1), priority, o.purpose ?? "tile"));
      runStart = -1;
    };
    for (let r = r0; r <= r1; r++) {
      const job = this.cache.has(r) ? null : this.pending.get(r);
      if (this.cache.has(r)) {
        flush(r - 1);
        continue;
      }
      if (job) {
        flush(r - 1);
        if (!job.running && priority < job.priority) {
          job.priority = priority;
          job.seq = this.seq++;
        }
        jobs.add(job);
        continue;
      }
      if (runStart < 0) runStart = r;
    }
    flush(r1);
    if (jobs.size) {
      for (const j of jobs) j.waiters++;
      this.pump();
      let onAbort: (() => void) | null = null;
      const aborted = new Promise<never>((_, reject) => {
        if (!o.signal) return;
        onAbort = () => reject(abortError());
        o.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        await Promise.race([Promise.all([...jobs].map((j) => j.promise)), aborted]);
      } finally {
        if (onAbort) o.signal!.removeEventListener("abort", onAbort);
        for (const j of jobs) {
          j.waiters--;
          if (j.waiters === 0 && !j.running) this.drop(j);
        }
      }
    }
    const out = new Uint8Array(b - a);
    for (let r = r0; r <= r1; r++) {
      let rec = this.cache.get(r);
      if (!rec) {
        // Evicted between the fetch and now (tiny budget): fetch again.
        return this.read(a, b, o);
      }
      // LRU touch.
      this.cache.delete(r);
      this.cache.set(r, rec);
      const rs = r * RECORD_PLAINTEXT;
      const from = Math.max(a, rs), to = Math.min(b, rs + rec.byteLength);
      out.set(rec.subarray(from - rs, to - rs), from - a);
    }
    return out;
  }

  /** True when every record of plaintext [a, b) is cached. */
  has(a: number, b: number): boolean {
    for (let r = Math.floor(a / RECORD_PLAINTEXT); r <= Math.floor((b - 1) / RECORD_PLAINTEXT); r++) if (!this.cache.has(r)) return false;
    return true;
  }

  get queued(): number {
    return this.queue.length;
  }
  get inFlight(): number {
    return this.running;
  }

  private enqueue(first: number, last: number, priority: number, purpose: ReadPurpose): Job {
    let resolve!: () => void, reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {});
    const job: Job = { first, last, priority, seq: this.seq++, purpose, waiters: 0, running: false, promise, resolve, reject };
    for (let r = first; r <= last; r++) this.pending.set(r, job);
    this.queue.push(job);
    return job;
  }

  private drop(job: Job) {
    const i = this.queue.indexOf(job);
    if (i < 0) return;
    this.queue.splice(i, 1);
    for (let r = job.first; r <= job.last; r++) if (this.pending.get(r) === job) this.pending.delete(r);
    job.reject(abortError());
  }

  private pump() {
    const conc = this.o.concurrency ?? 6;
    while (this.running < conc && this.queue.length) {
      let best = 0;
      for (let k = 1; k < this.queue.length; k++) {
        const a = this.queue[k], b = this.queue[best];
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = k;
      }
      const job = this.queue.splice(best, 1)[0];
      job.running = true;
      this.running++;
      void this.run(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: Job) {
    const s = this.series;
    const a = job.first * RECORD_PLAINTEXT, b = Math.min(s.plaintextLength, (job.last + 1) * RECORD_PLAINTEXT);
    const plan = planBytes(s, a, b);
    this.o.onRecords?.(s.fileId, plan.firstRecord, plan.lastRecord, "fetching");
    try {
      const t0 = performance.now();
      const ct = await this.resolver.fetchRange(plan);
      if (this.log.length < 5000) this.log.push({ purpose: job.purpose, first: job.first, last: job.last, bytes: ct.byteLength, ms: Math.round(performance.now() - t0), t: Math.round(t0) });
      this.stats.requests++;
      this.stats.bytes += ct.byteLength;
      this.stats.byPurpose[job.purpose].requests++;
      this.stats.byPurpose[job.purpose].bytes += ct.byteLength;
      let pt: Uint8Array;
      try {
        pt = await this.decryptor.decrypt(s, plan, ct);
      } catch (e) {
        this.o.onRecords?.(s.fileId, plan.firstRecord, plan.lastRecord, "failed");
        throw e;
      }
      this.o.onRecords?.(s.fileId, plan.firstRecord, plan.lastRecord, "verified");
      for (let r = job.first; r <= job.last; r++) {
        const off = (r - job.first) * RECORD_PLAINTEXT;
        this.remember(r, pt.slice(off, Math.min(pt.byteLength, off + RECORD_PLAINTEXT)));
      }
      job.resolve();
    } catch (e) {
      job.reject(e);
    } finally {
      for (let r = job.first; r <= job.last; r++) if (this.pending.get(r) === job) this.pending.delete(r);
      this.onStats?.();
    }
  }

  private remember(r: number, rec: Uint8Array) {
    const budget = this.o.budgetBytes ?? 64 * 1024 * 1024;
    const old = this.cache.get(r);
    if (old) {
      this.cache.delete(r);
      this.stats.cachedBytes -= old.byteLength;
    }
    this.cache.set(r, rec);
    this.stats.cachedBytes += rec.byteLength;
    for (const [k, v] of this.cache) {
      if (this.stats.cachedBytes <= budget) break;
      this.cache.delete(k);
      this.stats.cachedBytes -= v.byteLength;
    }
    this.stats.cachedRecords = this.cache.size;
  }
}

// ------------------------------------------------------------------------------------- slide

export interface SlideShare {
  resolver: LinkResolver;
  decryptor: RecordDecryptor;
  index: { bundle: any };
}

export interface SlideSourceOptions {
  /** Record cache budget (default 64 MiB). */
  budgetBytes?: number;
  onRecords?: (fileId: string, first: number, last: number, s: RecordState) => void;
  signal?: AbortSignal;
}

export interface WalkState {
  instance: number;
  /** Frames located so far. */
  known: number;
  frames: number;
  /** Bytes of Pixel Data walked. */
  walkedBytes: number;
  done: boolean;
}

/** Largest instance whose pixels are decoded in one piece (label, overview, thumbnail). */
export const WHOLE_DECODE_LIMIT = 48 * 1024 * 1024;

interface Walker {
  w: FragmentWalker;
  running: boolean;
  /** locate() calls waiting on this walk. */
  waiting: number;
  listeners: Set<() => void>;
  error: unknown;
}

export class SlideSource {
  readonly reader: SeriesReader;
  headers: (SlideHeader | null)[] = [];
  pyramid!: Pyramid;
  /** Where frame offsets come from, per instance. */
  tables: (FrameTable | null)[] = [];
  /** ms to read the headers and build the pyramid. */
  openMs = 0;
  /** Called when walking makes progress. */
  onWalk: ((w: WalkState) => void) | null = null;
  private walkers = new Map<number, Walker>();

  private constructor(
    readonly share: SlideShare,
    readonly series: SeriesEntry,
    readonly opts: SlideSourceOptions,
  ) {
    this.reader = new SeriesReader(share.resolver, share.decryptor, series, { budgetBytes: opts.budgetBytes, onRecords: opts.onRecords });
  }

  /** Reads every instance's header (small ranges before Pixel Data) and builds the pyramid. */
  static async open(share: SlideShare, series: SeriesEntry, opts: SlideSourceOptions = {}): Promise<SlideSource> {
    const t0 = performance.now();
    const s = new SlideSource(share, series, opts);
    await Promise.all(series.instances.map((_, i) => s.loadHeader(i)));
    s.pyramid = buildPyramid(s.headers);
    s.openMs = performance.now() - t0;
    return s;
  }

  /** Total bytes of the slide (sum of instance lengths) and of its series file. */
  get plaintextBytes() {
    return this.series.plaintextLength;
  }
  get ciphertextBytes() {
    return this.series.ciphertextLength;
  }

  private async loadHeader(i: number) {
    const inst = this.series.instances[i];
    const sig = { priority: 0, signal: this.opts.signal, purpose: "header" as const };
    // Read up to the end of the Basic Offset Table (a filled BOT is 4 bytes per frame).
    let n = RECORD_PLAINTEXT - (inst.offset % RECORD_PLAINTEXT);
    if (n < 16384) n += RECORD_PLAINTEXT;
    n = Math.min(inst.length, n);
    let h: SlideHeader | null = null;
    for (;;) {
      const bytes = await this.reader.read(inst.offset, inst.offset + n, sig);
      h = parseSlideHeader(bytes, { partial: true });
      if (h.complete) break;
      // Label, overview and thumbnail images are read whole when shown, so their attributes are
      // enough here; Pixel Data's position is not needed.
      if (["LABEL", "OVERVIEW", "THUMBNAIL"].includes(h.flavor) && h.rows && h.columns && h.transferSyntax) break;
      if (n >= inst.length) break;
      // Read on, to the end of the record holding the byte needed, growing by at least 2.5× so a
      // long header (an ICC profile, say) takes two or three reads rather than one per record.
      const want = inst.offset + Math.max((h.needBytes || n) + 1024, Math.ceil(n * 2.5));
      n = Math.min(inst.length, (Math.floor(want / RECORD_PLAINTEXT) + 1) * RECORD_PLAINTEXT - inst.offset);
    }
    this.headers[i] = h;
    this.tables[i] = h && h.complete ? frameTableFromHeader(h, inst.length) : null;
  }

  /** The header-only frame table source of an instance, or "walk". */
  frameSource(instance: number): FrameTable["source"] {
    return this.tables[instance]?.source ?? "walk";
  }

  walkState(instance: number): WalkState {
    const h = this.headers[instance]!;
    const wk = this.walkers.get(instance);
    if (this.tables[instance]) return { instance, known: h.numberOfFrames, frames: h.numberOfFrames, walkedBytes: 0, done: true };
    return {
      instance,
      known: wk?.w.knownFrames ?? 0,
      frames: h.numberOfFrames,
      walkedBytes: wk ? wk.w.pos - wk.w.header.firstFragmentOffset : 0,
      done: wk?.w.done ?? false,
    };
  }

  /** Instance byte range of frame k, locating it first if needed. */
  async locate(instance: number, k: number, o: ReadOptions = {}): Promise<[number, number] | null> {
    const t = this.tables[instance];
    if (t) return t.range(k);
    const h = this.headers[instance];
    if (!h) return null;
    let wk = this.walkers.get(instance);
    if (!wk) {
      wk = { w: new FragmentWalker(h, this.series.instances[instance].length), running: false, waiting: 0, listeners: new Set(), error: null };
      this.walkers.set(instance, wk);
    }
    wk.waiting++;
    try {
      for (;;) {
        const r = wk.w.frameRange(k);
        if (r) return r;
        if (wk.w.done) return null;
        if (wk.error) throw wk.error;
        if (o.signal?.aborted) throw abortError();
        if (!wk.running) this.walk(instance, wk);
        // Wait for the walk's next step.
        await new Promise<void>((res, rej) => {
          const wake = () => {
            o.signal?.removeEventListener("abort", onAbort);
            res();
          };
          const onAbort = () => {
            wk!.listeners.delete(wake);
            rej(abortError());
          };
          wk!.listeners.add(wake);
          o.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
    } finally {
      wk.waiting--;
    }
  }

  /**
   * Walks fragment item headers in growing chunks (256 KiB up to 4 MiB, the next chunk requested
   * while this one is parsed) for as long as some locate() is waiting.
   */
  private walk(instance: number, wk: Walker) {
    wk.running = true;
    const inst = this.series.instances[instance];
    const notify = () => {
      const ls = [...wk.listeners];
      wk.listeners.clear();
      for (const f of ls) f();
    };
    void (async () => {
      let chunk = 4 * RECORD_PLAINTEXT;
      try {
        while (!wk.w.done && wk.waiting > 0) {
          const a = wk.w.pos;
          const b = Math.min(inst.length, a + chunk);
          if (b <= a) {
            wk.w.done = true;
            break;
          }
          const read = this.reader.read(inst.offset + a, inst.offset + b, { priority: 0, purpose: "walk", signal: this.opts.signal });
          chunk = Math.min(chunk * 2, 64 * RECORD_PLAINTEXT);
          // Read ahead: the next item header is almost always in the next chunk.
          if (b < inst.length) void this.reader.read(inst.offset + b, inst.offset + Math.min(inst.length, b + chunk), { priority: 0, purpose: "walk", signal: this.opts.signal }).catch(() => {});
          wk.w.feed(await read, a);
          if (b >= inst.length) wk.w.done = true;
          if (wk.w.done) {
            const w = wk.w;
            this.tables[instance] = { source: "walk", range: (k) => w.frameRange(k) };
          }
          this.onWalk?.(this.walkState(instance));
          notify();
        }
      } catch (e) {
        if ((e as any)?.name !== "AbortError") wk.error = e;
      } finally {
        wk.running = false;
        notify();
      }
    })();
  }

  /** The bytes of frame `k` of an instance (fragment items for encapsulated data). */
  async frameBytes(instance: number, k: number, o: ReadOptions = {}): Promise<Uint8Array | null> {
    const r = await this.locate(instance, k, o);
    if (!r) return null;
    const off = this.series.instances[instance].offset;
    return this.reader.read(off + r[0], off + r[1], { ...o, purpose: o.purpose ?? "tile" });
  }

  /** True when frame k of an instance can be read without walking or fetching. */
  frameCached(instance: number, k: number): boolean {
    const r = this.tables[instance]?.range(k) ?? this.walkers.get(instance)?.w.frameRange(k);
    if (!r) return false;
    const off = this.series.instances[instance].offset;
    return this.reader.has(off + r[0], off + r[1]);
  }

  /** A one-frame Part 10 file for tile (tx, ty) of a level, or null when the tile is absent. */
  async tileFile(level: number, tx: number, ty: number, o: ReadOptions = {}): Promise<Uint8Array<ArrayBuffer> | null> {
    const L = this.pyramid.levels[level];
    const f = L.frameOf(tx, ty);
    if (f < 0) return null;
    const bytes = await this.frameBytes(L.instance, f, o);
    if (!bytes) return null;
    return singleFrameFile(L.header, bytes);
  }

  /**
   * A small single-frame instance (label, overview, thumbnail) as a whole Part 10 file. Refuses
   * anything over WHOLE_DECODE_LIMIT, so a pyramid level is never decoded in one piece.
   */
  async wholeInstance(instance: number, o: ReadOptions = {}): Promise<Uint8Array> {
    const inst = this.series.instances[instance];
    if (inst.length > WHOLE_DECODE_LIMIT) throw new RangeError(`instance ${instance} is ${inst.length} bytes; too large to decode whole`);
    return this.reader.read(inst.offset, inst.offset + inst.length, { ...o, purpose: "image" });
  }
}
