// SlideSource: a whole-slide series read through byte ranges of its encrypted file. Its frame
// location (FrameLocator: header, offset tables, fragment walk, one frame's bytes) also serves
// multi-frame images read a frame at a time (frames.ts).
//
//   const src = await SlideSource.open(share, series, { onRecords });
//   src.pyramid.levels[k]                       // finest first
//   const file = await src.tileFile(k, tx, ty, { priority, signal });   // one-frame Part 10 file
//   const img = await pool.decode(file, { key, priority, signal });
//
// Reads go through SeriesReader: a cache of verified, decrypted 64 KiB records (spec/README.md §9.3)
// with a byte budget, and a priority queue that merges adjacent missing records into one Range
// request. A frame is located from, in order: the Extended Offset Table, the Basic Offset Table,
// native frame arithmetic, or by walking the fragment item headers from the start of Pixel Data
// (sequential; what it learns is kept). A sharer can add the tables when packing
// (crates/shl-dicom-core/src/offset_tables.rs).
import type { SeriesEntry } from "./bundle";
import type { RecordDecryptor } from "./decrypt";
import { planBytes, RECORD_CIPHERTEXT, RECORD_PLAINTEXT } from "./range";
import type { LinkResolver } from "./resolver";
import { FrameFiles } from "./frame-file";
import type { RecordState } from "./loader";
import {
  buildPyramid,
  FragmentWalker,
  frameTableFromHeader,
  parseSlideHeader,
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

/** Plaintext bytes of a series' file, read on demand (SeriesReader, or the InstanceLoader in frames.ts). */
export interface ByteSource {
  /** Plaintext bytes [a, b) of the series' file. */
  read(a: number, b: number, o?: ReadOptions): Promise<Uint8Array>;
  /** Recent transfer speed (bytes per second), or 0 before any. */
  throughput(): number;
  /** True when [a, b) can be read without fetching. */
  has?(a: number, b: number): boolean;
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

/** Verified, decrypted records of one series' file, fetched on demand through a priority queue. */
export class SeriesReader implements ByteSource {
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
  private recent: { bytes: number; ms: number }[] = [];
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

  /** Requests queued or running. */
  get busy(): boolean {
    return this.running > 0 || this.queue.length > 0;
  }

  /** Plaintext bytes [a, b) of the series' file. */
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

  /** Recent transfer speed (bytes per second) from the last requests, or 0 before any. */
  throughput(): number {
    const recent = this.recent;
    const ms = recent.reduce((a, r) => a + r.ms, 0);
    return ms > 0 ? (recent.reduce((a, r) => a + r.bytes, 0) * 1000) / ms : 0;
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
    const a = job.first * RECORD_PLAINTEXT, b = Math.min(s.file.plaintextLength, (job.last + 1) * RECORD_PLAINTEXT);
    const plan = planBytes(s, a, b);
    this.o.onRecords?.(s.file.fileId, plan.firstRecord, plan.lastRecord, "fetching");
    try {
      const t0 = performance.now();
      const ct = await this.resolver.fetchRange(plan);
      this.recent.push({ bytes: ct.byteLength, ms: performance.now() - t0 });
      if (this.recent.length > 8) this.recent.shift();
      if (this.log.length < 5000) this.log.push({ purpose: job.purpose, first: job.first, last: job.last, bytes: ct.byteLength, ms: Math.round(performance.now() - t0), t: Math.round(t0) });
      this.stats.requests++;
      this.stats.bytes += ct.byteLength;
      this.stats.byPurpose[job.purpose].requests++;
      this.stats.byPurpose[job.purpose].bytes += ct.byteLength;
      let pt: Uint8Array;
      try {
        pt = await this.decryptor.decrypt(s, plan, ct);
      } catch (e) {
        this.o.onRecords?.(s.file.fileId, plan.firstRecord, plan.lastRecord, "failed");
        throw e;
      }
      this.o.onRecords?.(s.file.fileId, plan.firstRecord, plan.lastRecord, "verified");
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
  /** Bytes of Pixel Data in the instance. */
  pixelBytes: number;
  /** The furthest frame a tile is waiting for (-1: none). */
  need: number;
  done: boolean;
}

/** Largest instance whose pixels are decoded in one piece (label, overview, thumbnail). */
export const WHOLE_DECODE_LIMIT = 48 * 1024 * 1024;

interface Walker {
  w: FragmentWalker;
  running: boolean;
  /** locate() calls waiting on this walk. */
  waiting: number;
  /** Frames those calls wait for (frame → number of callers). */
  needs: Map<number, number>;
  listeners: Set<() => void>;
  error: unknown;
}

/**
 * Where the frames of a series' instances are: each instance's header (read in growing ranges up
 * to Pixel Data), its frame table (Extended or Basic Offset Table, or native arithmetic), else a
 * fragment walk, and a frame's bytes.
 */
export class FrameLocator {
  headers: (SlideHeader | null)[] = [];
  /** Where frame offsets come from, per instance. */
  tables: (FrameTable | null)[] = [];
  /** Called when walking makes progress. */
  onWalk: ((w: WalkState) => void) | null = null;
  private walkers = new Map<number, Walker>();
  /** Per instance, once its header is complete: its bytes before Pixel Data and the Pixel Data element header. */
  private headerBytes: ({ header: Uint8Array; pixelElement: Uint8Array } | null)[] = [];
  private files = new Map<number, FrameFiles | null>();

  constructor(
    readonly series: SeriesEntry,
    readonly bytes: ByteSource,
    protected signal?: AbortSignal,
  ) {}

  /** Waited for before a frame of the instance is located (SlideSource: a header read later). */
  protected beforeLocate(_instance: number): Promise<void> | null {
    return null;
  }

  /** Bytes for a header's first read: to the end of the record holding byte 16 KiB. */
  firstHeaderBytes(i: number): number {
    const inst = this.series.instances[i];
    let n = RECORD_PLAINTEXT - (inst.offset % RECORD_PLAINTEXT);
    if (n < 16384) n += RECORD_PLAINTEXT;
    return Math.min(inst.length, n);
  }

  /**
   * Reads instance i's header from n bytes on, growing the read until it is complete (or, with
   * `once`, stops after one read). Returns 0 when the header needs no more bytes, else the bytes
   * the next read should cover.
   */
  async readHeader(i: number, n: number, priority: number, once: boolean): Promise<number> {
    const inst = this.series.instances[i];
    const sig = { priority, signal: this.signal, purpose: "header" as const };
    for (;;) {
      const h = this.takeHeader(i, await this.bytes.read(inst.offset, inst.offset + n, sig));
      if (h.complete) return 0;
      // Label, overview and thumbnail images are read whole when shown, so their attributes are
      // enough here; Pixel Data's position is not needed.
      if (["LABEL", "OVERVIEW", "THUMBNAIL"].includes(h.flavor) && h.rows && h.columns && h.transferSyntax) return 0;
      if (n >= inst.length) return 0;
      // Read on, to the end of the record holding the byte needed, growing by at least 2.5× so a
      // long header (an ICC profile, say) takes two or three reads rather than one per record.
      const want = inst.offset + Math.max((h.needBytes || n) + 1024, Math.ceil(n * 2.5));
      n = Math.min(inst.length, (Math.floor(want / RECORD_PLAINTEXT) + 1) * RECORD_PLAINTEXT - inst.offset);
      if (once) return n;
    }
  }

  /**
   * Parses instance i's first bytes (a header read) and keeps what it learns: the header, the
   * frame table, and, when the header is complete, its bytes for one-frame files.
   */
  takeHeader(i: number, bytes: Uint8Array): SlideHeader {
    const h = parseSlideHeader(bytes, { partial: true });
    this.headers[i] = h;
    this.tables[i] = h.complete ? frameTableFromHeader(h, this.series.instances[i].length) : null;
    this.files.delete(i);
    if (h.complete) {
      const start = h.pixelDataValueOffset - (h.transferSyntax === "1.2.840.10008.1.2" ? 8 : 12);
      this.headerBytes[i] = { header: bytes.slice(0, start), pixelElement: bytes.slice(start, h.pixelDataValueOffset) };
    } else this.headerBytes[i] = null;
    return h;
  }

  /** The one-frame files of an instance (frame-file.ts), or null when its header can't make them. */
  frameFiles(instance: number): FrameFiles | null {
    let ff = this.files.get(instance);
    if (ff === undefined) {
      const hb = this.headerBytes[instance];
      ff = hb ? FrameFiles.of(hb.header, hb.pixelElement, this.headers[instance]!) : null;
      this.files.set(instance, ff);
    }
    return ff;
  }

  /** A one-frame Part 10 file holding `frame`, the bytes of frame k of an instance. */
  frameFile(instance: number, k: number, frame: Uint8Array): Uint8Array<ArrayBuffer> | null {
    return this.frameFiles(instance)?.file(k, frame, this.tables[instance]?.bitShift?.(k) ?? 0) ?? null;
  }

  walkState(instance: number): WalkState {
    const h = this.headers[instance]!;
    const wk = this.walkers.get(instance);
    const pixelBytes = Math.max(0, this.series.instances[instance].length - Math.max(0, h.firstFragmentOffset));
    if (this.tables[instance]) return { instance, known: h.numberOfFrames, frames: h.numberOfFrames, walkedBytes: 0, pixelBytes, need: -1, done: true };
    return {
      instance,
      known: wk?.w.knownFrames ?? 0,
      frames: h.numberOfFrames,
      walkedBytes: wk ? wk.w.pos - wk.w.header.firstFragmentOffset : 0,
      pixelBytes,
      need: wk && wk.needs.size ? Math.max(...wk.needs.keys()) : -1,
      done: wk?.w.done ?? false,
    };
  }

  /** Walks under way that a tile is waiting for. */
  walking(): WalkState[] {
    const out: WalkState[] = [];
    for (const [i, wk] of this.walkers) if (wk.waiting > 0 && !wk.w.done) out.push(this.walkState(i));
    return out;
  }

  /** Instance byte range of frame k, locating it first if needed. */
  async locate(instance: number, k: number, o: ReadOptions = {}): Promise<[number, number] | null> {
    const wait = this.beforeLocate(instance);
    if (wait) await wait;
    const t = this.tables[instance];
    if (t) return t.range(k);
    const h = this.headers[instance];
    if (!h) return null;
    let wk = this.walkers.get(instance);
    if (!wk) {
      wk = { w: new FragmentWalker(h, this.series.instances[instance].length), running: false, waiting: 0, needs: new Map(), listeners: new Set(), error: null };
      this.walkers.set(instance, wk);
    }
    wk.waiting++;
    wk.needs.set(k, (wk.needs.get(k) ?? 0) + 1);
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
      const left = (wk.needs.get(k) ?? 1) - 1;
      if (left > 0) wk.needs.set(k, left);
      else wk.needs.delete(k);
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
      // Chunks sized to about 0.4 s at the measured speed (256 KiB to 4 MiB), so progress moves
      // several times a second on slow connections and requests stay few on fast ones.
      let first = true;
      const size = () => {
        // The first chunk is small, so progress shows at once; later ones follow the measured speed.
        if (first) return (first = false), 4 * RECORD_PLAINTEXT;
        const bps = this.bytes.throughput();
        const want = bps ? bps * 0.4 : 4 * RECORD_PLAINTEXT;
        return Math.max(4, Math.min(64, Math.round(want / RECORD_PLAINTEXT))) * RECORD_PLAINTEXT;
      };
      try {
        while (!wk.w.done && wk.waiting > 0) {
          const a = wk.w.pos;
          const chunk = size();
          const b = Math.min(inst.length, a + chunk);
          if (b <= a) {
            wk.w.done = true;
            break;
          }
          const read = this.bytes.read(inst.offset + a, inst.offset + b, { priority: 0, purpose: "walk", signal: this.signal });
          // Read ahead: the next item header is almost always in the next chunk.
          if (b < inst.length) void this.bytes.read(inst.offset + b, inst.offset + Math.min(inst.length, b + chunk), { priority: 0, purpose: "walk", signal: this.signal }).catch(() => {});
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
    return this.bytes.read(off + r[0], off + r[1], { ...o, purpose: o.purpose ?? "tile" });
  }

  /** True when frame k of an instance can be read without walking or fetching. */
  frameCached(instance: number, k: number): boolean {
    const r = this.tables[instance]?.range(k) ?? this.walkers.get(instance)?.w.frameRange(k);
    if (!r || !this.bytes.has) return false;
    const off = this.series.instances[instance].offset;
    return this.bytes.has(off + r[0], off + r[1]);
  }
}

export class SlideSource extends FrameLocator {
  readonly reader: SeriesReader;
  pyramid!: Pyramid;
  /** ms to read the headers and build the pyramid. */
  openMs = 0;

  private constructor(
    readonly share: SlideShare,
    series: SeriesEntry,
    readonly opts: SlideSourceOptions,
  ) {
    const reader = new SeriesReader(share.resolver, share.decryptor, series, { budgetBytes: opts.budgetBytes, onRecords: opts.onRecords });
    super(series, reader, opts.signal);
    this.reader = reader;
  }

  protected override beforeLocate(instance: number): Promise<void> | null {
    // A level whose header is still being read (progressive open).
    const wait = this.headerWait.get(instance);
    if (!wait) return null;
    this.continueHeaders();
    return wait;
  }

  /**
   * Reads every instance's header (small ranges before Pixel Data) and builds the pyramid.
   *
   * Progressive: when the first read of each header shows a plain tiled slide (TILED_FULL, one
   * focal plane and optical path, the coarsest level's header complete), the pyramid is built from
   * those reads and returned at once, so the coarsest level can be drawn; the other levels'
   * headers (ICC profiles, offset tables) are read on after it at lower priority. A frame of such
   * a level waits for its header (`locate`). `complete` resolves when every header is in; if the
   * full headers describe a different pyramid, `pyramid` is replaced and `onPyramid` called.
   */
  static async open(share: SlideShare, series: SeriesEntry, opts: SlideSourceOptions = {}): Promise<SlideSource> {
    const t0 = performance.now();
    const s = new SlideSource(share, series, opts);
    const first = await Promise.all(series.instances.map((_, i) => s.readHeader(i, s.firstHeaderBytes(i), 0, true)));
    // A plain tiled slide: the coarsest level's header is finished first; the others after it.
    const coarse = s.coarsestCandidate();
    let provisional: Pyramid | null = null;
    if (coarse !== null) {
      // The other headers wait until the coarsest level's first tiles have come in (or a frame of
      // their level is asked for), so they don't share the connection with those tiles.
      let go!: () => void;
      const started = new Promise<void>((r) => (go = r));
      s.continueHeaders = () => go();
      series.instances.forEach((_, i) => {
        if (i === coarse || first[i] === 0) return;
        s.headerWait.set(i, started.then(() => s.readHeader(i, first[i], 2, false)).then(() => {}));
      });
      if (first[coarse]) await s.readHeader(coarse, first[coarse], 0, false);
      provisional = s.provisionalPyramid();
      if (!provisional) go();
      else {
        const t = performance.now();
        const tick = () => {
          if ((s.reader.stats.byPurpose.tile.requests > 0 && !s.reader.busy) || performance.now() - t > 3000) go();
          else setTimeout(tick, 50);
        };
        setTimeout(tick, 50);
      }
    }
    if (provisional) {
      s.pyramid = provisional;
      s.headersDone = false;
      s.complete = Promise.all(s.headerWait.values())
        .then(() => s.settle(provisional))
        .finally(() => {
          s.headersDone = true;
          s.headerWait.clear();
        });
      s.complete.catch(() => {});
    } else {
      await Promise.all(series.instances.map((_, i) => s.headerWait.get(i) ?? (first[i] === 0 || s.headers[i]?.complete ? null : s.readHeader(i, first[i], 0, false))));
      s.headerWait.clear();
      s.pyramid = buildPyramid(s.headers);
    }
    s.openMs = performance.now() - t0;
    return s;
  }

  /** Resolves when every header has been read in full (at once unless the open was progressive). */
  complete: Promise<void> = Promise.resolve();
  /** False while a progressive open is still reading headers. */
  headersDone = true;
  /** Called when the full headers replace a provisional pyramid that turned out different. */
  onPyramid: (() => void) | null = null;
  private headerWait = new Map<number, Promise<void>>();
  /** Starts reading the headers a progressive open left for later. */
  private continueHeaders: () => void = () => {};

  /**
   * A pyramid from the first reads, when that is safe: every level TILED_FULL with one frame per
   * tile (so one focal plane and one optical path), the coarsest level's header complete, and the
   * other levels' optical path taken from it. Null when the headers must be read in full first.
   */
  /**
   * From the first reads: the coarsest level's instance when every level looks like a plain tiled
   * slide (TILED_FULL, one frame per tile, so one focal plane and one optical path) and some level
   * still needs more header; else null.
   */
  private coarsestCandidate(): number | null {
    const hs = this.headers;
    const isVol = (h: SlideHeader | null) => !!h && !!h.rows && !!h.columns && !["LABEL", "OVERVIEW", "THUMBNAIL"].includes(h.flavor);
    const vols = hs.flatMap((h, i) => (isVol(h) ? [i] : []));
    if (vols.length < 2 || vols.every((i) => hs[i]!.complete)) return null;
    for (const i of vols) {
      const h = hs[i]!;
      if (!h.totalColumns || !h.totalRows || h.dimensionOrganization !== "TILED_FULL" || !h.transferSyntax || h.segments.length) return null;
      if (h.numberOfFrames !== Math.ceil(h.totalColumns / h.columns) * Math.ceil(h.totalRows / h.rows)) return null;
    }
    const minW = Math.min(...vols.map((i) => hs[i]!.totalColumns));
    const coarse = vols.filter((i) => hs[i]!.totalColumns === minW);
    return coarse.length === 1 ? coarse[0] : null;
  }

  private provisionalPyramid(): Pyramid | null {
    const hs = this.headers;
    const isVol = (h: SlideHeader | null) => !!h && !!h.rows && !!h.columns && !["LABEL", "OVERVIEW", "THUMBNAIL"].includes(h.flavor);
    const vols = hs.flatMap((h, i) => (isVol(h) ? [i] : []));
    const coarse = this.coarsestCandidate();
    if (coarse === null) return null;
    const c = hs[coarse]!;
    if (!c.complete || c.paths.length > 1 || c.opticalPaths > 1 || c.focalPlanes > 1 || c.planePositions) return null;
    const filled = hs.map((h, i) =>
      !h || h.complete || !vols.includes(i)
        ? h
        : { ...h, paths: c.paths, sharedPath: c.sharedPath, sharedZ: c.sharedZ, opticalPaths: 1, focalPlanes: 1, frameZ: null, framePath: null, planePositions: null },
    );
    try {
      return buildPyramid(filled);
    } catch {
      return null;
    }
  }

  /** Every header is in: the provisional pyramid takes the full one's details, or is replaced. */
  private settle(provisional: Pyramid) {
    const full = buildPyramid(this.headers);
    const shape = (p: Pyramid) =>
      JSON.stringify([
        p.levels.map((l) => [l.width, l.height, l.tileWidth, l.tileHeight, l.instance, l.header.numberOfFrames]),
        p.paths.map((x) => x.id),
        p.planes,
        p.label,
        p.overview,
        p.thumbnail,
      ]);
    if (shape(full) === shape(provisional)) {
      // Same tiles and frames: keep the object (sessions hold it), with the full headers' details.
      provisional.levels.splice(0, provisional.levels.length, ...full.levels);
      Object.assign(provisional, { ...full, levels: provisional.levels });
    } else {
      this.pyramid = full;
      this.onPyramid?.();
    }
  }

  /** Total bytes of the slide (sum of instance lengths). */
  get plaintextBytes() {
    return this.series.bytes;
  }
  /** Ciphertext bytes of the records that cover the slide in its file. */
  get ciphertextBytes() {
    const { firstRecord, lastRecord, file } = this.series;
    return Math.min(file.ciphertextLength, (lastRecord + 1) * RECORD_CIPHERTEXT) - firstRecord * RECORD_CIPHERTEXT;
  }

  /** The header-only frame table source of an instance, or "walk". */
  frameSource(instance: number): FrameTable["source"] | "pending" {
    if (this.headerWait.has(instance)) return "pending";
    return this.tables[instance]?.source ?? "walk";
  }

  /** A one-frame Part 10 file for tile (tx, ty) of a level, plane and path, or null when the tile is absent. */
  async tileFile(level: number, tx: number, ty: number, plane = 0, path = 0, o: ReadOptions = {}): Promise<Uint8Array<ArrayBuffer> | null> {
    const ref = this.pyramid.levels[level].frameRef(tx, ty, plane, path);
    if (!ref) return null;
    const bytes = await this.frameBytes(ref.instance, ref.frame, o);
    return bytes && this.frameFile(ref.instance, ref.frame, bytes);
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
