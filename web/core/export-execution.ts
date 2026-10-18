// One export owns its save target, read consumers and terminal transition. It does not own
// shared physical transfers or the foreground preference; those belong to their coordinators.
import type { FileEntry } from "./bundle";
import type { ByteSink } from "./zip";

export type ExportPhase = "planning" | "running" | "finalizing" | "completed" | "failed" | "cancelled";
export interface RecordInterval { readonly file: FileEntry; readonly lo: number; readonly hi: number }
export interface JobProgress { readonly files: number; readonly totalFiles: number; readonly bytes: number; readonly totalBytes: number }
export interface ExportSnapshot {
  readonly id: number;
  readonly name: string;
  readonly phase: ExportPhase;
  readonly progress: JobProgress;
  readonly error?: unknown;
  readonly cleanupComplete: boolean;
}

/** File object identity includes the validated file/key context of one opened source. */
export class ExportScopeRecords {
  private files = new Map<FileEntry, readonly { lo: number; hi: number }[]>();

  constructor(readonly source: object, intervals: readonly RecordInterval[]) {
    const grouped = new Map<FileEntry, { lo: number; hi: number }[]>();
    for (const { file, lo, hi } of intervals) {
      if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 0 || hi <= lo) throw new RangeError("invalid export record interval");
      let input = grouped.get(file);
      if (!input) grouped.set(file, input = []);
      input.push({ lo, hi });
    }
    for (const [file, input] of grouped) {
      input.sort((a, b) => a.lo - b.lo);
      const union: { lo: number; hi: number }[] = [];
      for (const r of input) {
        const last = union.at(-1);
        if (last && r.lo <= last.hi) last.hi = Math.max(last.hi, r.hi);
        else union.push(r);
      }
      this.files.set(file, Object.freeze(union.map((r) => Object.freeze(r))));
    }
  }

  overlaps(source: object, file: FileEntry, lo: number, hi: number): boolean {
    return source === this.source && !!this.files.get(file)?.some((r) => lo < r.hi && r.lo < hi);
  }

  contains(source: object, file: FileEntry, lo: number, hi: number): boolean {
    return source === this.source && !!this.files.get(file)?.some((r) => r.lo <= lo && hi <= r.hi);
  }
}

interface ExecutionObserver {
  changed(kind: "state" | "scope" | "terminal"): void;
  event(event: string, bytes?: number): void;
}
const abortError = () => new DOMException("export cancelled", "AbortError");

export class ExportExecution {
  private state: ExportSnapshot;
  private records?: ExportScopeRecords;
  private controller = new AbortController();
  private reads = new Set<Promise<unknown>>();
  private unverifiedReads = 0;
  private writer?: ByteSink;
  private aborting?: Promise<void>;
  private started = false;
  private closing = false;
  private closed = false;

  constructor(readonly id: number, readonly name: string, private observer?: ExecutionObserver) {
    this.state = Object.freeze({ id, name, phase: "planning", cleanupComplete: false,
      progress: Object.freeze({ files: 0, totalFiles: 0, bytes: 0, totalBytes: 0 }) });
  }

  get snapshot() { return this.state; }
  get phase() { return this.state.phase; }
  get scope() { return this.records; }
  get signal() { return this.controller.signal; }
  get terminal() { return this.phase === "completed" || this.phase === "failed" || this.phase === "cancelled"; }

  private change(patch: Partial<ExportSnapshot>, kind: "state" | "scope" | "terminal" = "state") {
    this.state = Object.freeze({ ...this.state, ...patch });
    this.observer?.changed(kind);
  }

  /** Seal the complete source inventory before the first payload acquisition. */
  seal(source: object, intervals: readonly RecordInterval[]) {
    this.check();
    if (this.records) throw new Error("export scope is already sealed");
    this.records = new ExportScopeRecords(source, intervals);
    this.observer?.changed("scope");
  }

  check() {
    if (this.terminal || this.signal.aborted) throw this.state.error ?? abortError();
  }

  update(progress: JobProgress) {
    if (!this.terminal) this.change({ progress: Object.freeze({ ...progress }) });
  }

  /** A failed read-ahead stops the job even while the exporter awaits an earlier read. */
  read<T>(source: object, range: RecordInterval, start: (signal: AbortSignal) => Promise<T>, verified?: () => void): Promise<T> {
    this.check();
    if (this.phase !== "running") throw new Error("source reads require a running export");
    if (!this.records?.contains(source, range.file, range.lo, range.hi)) throw new Error("export source read is outside its sealed plan");
    let sourceRead: Promise<T>;
    try { sourceRead = start(this.signal); }
    catch (error) { this.fail(error); throw error; }
    this.unverifiedReads++;
    const reading = sourceRead.then((value) => {
      this.unverifiedReads--;
      this.check();
      verified?.();
      return value;
    }, (error) => { this.unverifiedReads--; throw error; });
    this.reads.add(reading);
    reading.then(() => this.reads.delete(reading), (error) => { this.reads.delete(reading); this.fail(error); });
    return reading;
  }

  sourcesVerified() {
    this.check();
    if (this.phase !== "running" || !this.records || this.unverifiedReads) throw new Error("export still has unverified sources");
    this.change({ phase: "finalizing" });
    this.observer?.event("source-verified");
  }

  cancel(reason: unknown = abortError()) { this.stop("cancelled", reason); }

  private fail(error: unknown) { this.stop("failed", error); }

  private stop(phase: "failed" | "cancelled", error: unknown) {
    if (this.terminal) return;
    // Release admission and notify views before potentially slow read/writer cleanup.
    this.change({ phase, error }, "terminal");
    this.controller.abort(error);
    void this.abortWriter(error);
  }

  private abortWriter(reason: unknown): Promise<void> {
    if (!this.writer) return Promise.resolve();
    return this.aborting ??= Promise.resolve().then(() => this.writer!.abort(reason)).catch(() => {});
  }

  private sink(): ByteSink {
    return {
      write: async (chunk) => {
        this.check();
        if (this.closing) throw new Error("export writer is already closing");
        this.observer?.event("sink-write-start", chunk.byteLength);
        try { await this.writer!.write(chunk); }
        catch (error) { this.fail(error); throw error; }
        finally { this.observer?.event("sink-write-settled", chunk.byteLength); }
        this.check();
      },
      close: async () => {
        this.check();
        if (this.phase !== "finalizing" || this.closing) throw new Error("export writer cannot close before source verification or twice");
        this.closing = true;
        this.observer?.event("sink-close-start");
        try { await this.writer!.close(); }
        catch (error) { this.fail(error); throw error; }
        this.check();
        this.closed = true;
        this.observer?.event("sink-closed");
      },
      abort: (reason) => { this.fail(reason); return this.abortWriter(reason); },
    };
  }

  /**
   * Call the browser picker synchronously in the user gesture, then pass its promise here.
   * Even a target arriving after cancellation is owned and aborted. Headless callers use
   * this same runner with an already available sink and, optionally, an external signal.
   */
  async run(target: ByteSink | Promise<ByteSink | null>, write: (execution: ExportExecution, sink: ByteSink) => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (this.started) throw new Error("export execution already started");
    this.started = true;
    const cancel = () => this.cancel(signal?.reason ?? abortError());
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const writer = await target;
      if (!writer) { this.cancel(); this.check(); }
      this.writer = writer!;
      if (this.terminal) void this.abortWriter(this.state.error);
      this.check();
      this.change({ phase: "running" });
      await write(this, this.sink());
      this.check();
      if (!this.closed) throw new Error("export finished without closing its writer");
      this.change({ phase: "completed" }, "terminal");
    } catch (error) {
      this.fail(error);
      throw this.state.error ?? error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      await Promise.allSettled(this.reads);
      await this.aborting;
      this.writer = undefined;
      this.change({ cleanupComplete: true });
      this.observer?.event("job-cleaned-up");
    }
  }
}
