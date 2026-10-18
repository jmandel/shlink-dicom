// Export lifetime and foreground preference are independent. A job survives navigation;
// only the selected, sealed, nonterminal job restricts new imaging transfers.
import type { FileEntry } from "./bundle";
import type { ByteSink } from "./zip";

export type ExportPhase = "planning" | "running" | "finalizing" | "completed" | "failed" | "cancelled";
export type Foreground = { epoch: number; kind: "browse" } | { epoch: number; kind: "export"; jobId: number };
export interface FocusToken { jobId: number; epoch: number }
export interface RecordInterval { file: FileEntry; lo: number; hi: number }
export interface JobProgress { files: number; totalFiles: number; bytes: number; totalBytes: number }

/** Object identity includes the opened source and its validated file/key context. No keys in logs. */
export class ExportScopeRecords {
  private files = new Map<FileEntry, readonly { lo: number; hi: number }[]>();

  constructor(readonly source: object, intervals: readonly RecordInterval[]) {
    const grouped = new Map<FileEntry, { lo: number; hi: number }[]>();
    for (const { file, lo, hi } of intervals) {
      let input = grouped.get(file);
      if (!input) grouped.set(file, input = []);
      input.push({ lo, hi });
    }
    for (const [file, input] of grouped) {
      input.sort((a, b) => a.lo - b.lo);
      const union: { lo: number; hi: number }[] = [];
      for (const r of input) {
        if (!Number.isSafeInteger(r.lo) || !Number.isSafeInteger(r.hi) || r.lo < 0 || r.hi <= r.lo) throw new RangeError("invalid export record interval");
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

export interface ExportEvent {
  time: number;
  event: string;
  epoch: number;
  gateVersion: number;
  jobId?: number;
  reason?: string;
  bytes?: number;
}

export class ExportJobs {
  readonly jobs = new Map<number, ExportJob>();
  foreground: Foreground = { epoch: 0, kind: "browse" };
  gateVersion = 0;
  private nextId = 0;
  private gates = new Set<() => void>();
  private views = new Set<() => void>();

  constructor(private onEvent?: (event: ExportEvent) => void) {}

  create(name: string): ExportJob {
    const job = new ExportJob(this, ++this.nextId, name);
    this.jobs.set(job.id, job);
    this.focusExport(job.id);
    this.event("job-created", job.id);
    return job;
  }

  get focused(): ExportJob | undefined {
    return this.foreground.kind === "export" ? this.jobs.get(this.foreground.jobId) : undefined;
  }

  allows(source: object, file: FileEntry, lo: number, hi: number): boolean {
    const job = this.focused;
    return !job || job.terminal || !job.scope || job.scope.overlaps(source, file, lo, hi);
  }

  focusBrowse(reason = "browse") {
    this.foreground = { epoch: this.foreground.epoch + 1, kind: "browse" };
    this.changedGate("foreground-browse", undefined, reason);
  }

  focusExport(id: number): FocusToken | undefined {
    const job = this.jobs.get(id);
    if (!job || job.terminal) return;
    this.foreground = { epoch: this.foreground.epoch + 1, kind: "export", jobId: id };
    this.changedGate("foreground-export", id);
    return { jobId: id, epoch: this.foreground.epoch };
  }

  retireFocus(token: FocusToken) {
    const f = this.foreground;
    if (f.kind === "export" && f.jobId === token.jobId && f.epoch === token.epoch) this.focusBrowse("dismiss");
  }

  subscribeGate(f: () => void): () => void {
    this.gates.add(f);
    return () => this.gates.delete(f);
  }

  subscribe(f: () => void): () => void {
    this.views.add(f);
    return () => this.views.delete(f);
  }

  changedGate(event: string, jobId?: number, reason?: string) {
    this.gateVersion++;
    this.event(event, jobId, reason);
    for (const f of [...this.gates]) f();
    this.changed();
  }

  changed() { for (const f of [...this.views]) f(); }

  event(event: string, jobId?: number, reason?: string, bytes?: number) {
    this.onEvent?.({ time: performance.now(), event, epoch: this.foreground.epoch, gateVersion: this.gateVersion, jobId, reason, bytes });
  }

  settle(job: ExportJob, phase: "completed" | "failed" | "cancelled", error?: unknown): boolean {
    if (job.terminal || this.jobs.get(job.id) !== job) return false;
    job.phase = phase;
    job.error = error;
    // Terminal identity, not the original focus epoch: a resumed job must also release.
    if (this.foreground.kind === "export" && this.foreground.jobId === job.id) {
      this.foreground = { epoch: this.foreground.epoch + 1, kind: "browse" };
    }
    this.changedGate("job-terminal", job.id, phase);
    return true;
  }

  forget(id: number) {
    const job = this.jobs.get(id);
    if (job?.terminal && job.cleanupComplete) { this.jobs.delete(id); this.changed(); }
  }
}

export class ExportJob {
  phase: ExportPhase = "planning";
  scope?: ExportScopeRecords;
  error?: unknown;
  progress: JobProgress = { files: 0, totalFiles: 0, bytes: 0, totalBytes: 0 };
  readonly controller = new AbortController();
  cleanupComplete = false;
  private writer?: ByteSink;
  private aborting?: Promise<void>;

  constructor(readonly jobs: ExportJobs, readonly id: number, readonly name: string) {}

  get terminal() { return this.phase === "completed" || this.phase === "failed" || this.phase === "cancelled"; }
  get signal() { return this.controller.signal; }

  seal(source: object, intervals: readonly RecordInterval[]) {
    if (this.terminal) return false;
    if (this.scope) throw new Error("export scope is already sealed");
    this.scope = new ExportScopeRecords(source, intervals);
    this.jobs.changedGate("plan-sealed", this.id);
    return true;
  }

  require(source: object, file: FileEntry, lo: number, hi: number) {
    this.check();
    if (!this.scope?.contains(source, file, lo, hi)) throw new Error("export source read is outside its sealed plan");
  }

  check() {
    if (this.terminal || this.signal.aborted) throw this.error ?? new DOMException("export cancelled", "AbortError");
  }

  running() { this.check(); this.phase = "running"; this.jobs.changed(); }
  finalizing() { this.check(); this.phase = "finalizing"; this.jobs.event("source-verified", this.id); this.jobs.changed(); }
  update(progress: JobProgress) { if (!this.terminal) { this.progress = { ...progress }; this.jobs.changed(); } }

  /** The task retains its sink through cancellation/cleanup; only this job can abort it. */
  ownWriter(sink: ByteSink): ByteSink {
    if (this.writer) throw new Error("export already owns a writer");
    this.writer = sink;
    if (this.terminal) void this.abortWriter(this.error);
    return {
      write: async (chunk) => {
        this.check();
        this.jobs.event("sink-write-start", this.id, undefined, chunk.byteLength);
        try { await sink.write(chunk); }
        finally { this.jobs.event("sink-write-settled", this.id, undefined, chunk.byteLength); }
        this.check();
      },
      close: async () => {
        this.check();
        this.jobs.event("sink-close-start", this.id);
        await sink.close();
        this.check();
        this.jobs.event("sink-closed", this.id);
      },
      abort: (reason) => this.abortWriter(reason),
    };
  }

  private abortWriter(reason?: unknown): Promise<void> {
    if (!this.writer) return Promise.resolve();
    return this.aborting ??= Promise.resolve().then(() => this.writer!.abort(reason)).catch(() => {});
  }

  complete() { this.jobs.settle(this, "completed"); }

  fail(error: unknown) {
    if (!this.jobs.settle(this, "failed", error)) return;
    // Release and wake first. Aborting fetches/writes and draining their callbacks follows.
    this.controller.abort(error);
    void this.abortWriter(error);
  }

  cancel() {
    const error = new DOMException("export cancelled", "AbortError");
    if (!this.jobs.settle(this, "cancelled", error)) return;
    this.controller.abort(error);
    void this.abortWriter(error);
  }

  /** Called by the owning task only after all reads and writer work have settled. */
  async cleanedUp() {
    await this.aborting;
    this.writer = undefined;
    this.cleanupComplete = true;
    this.jobs.event("job-cleaned-up", this.id);
    this.jobs.changed();
  }
}
