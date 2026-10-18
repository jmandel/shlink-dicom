// Jobs own execution; this registry owns foreground preference. Neither navigation nor
// closing progress ends a job. Only a selected, sealed, nonterminal job restricts reads.
import type { FileEntry } from "./bundle";
import { ExportExecution, type ExportSnapshot } from "./export-execution";
import type { ReadAdmission } from "./read-admission";
export { ExportScopeRecords } from "./export-execution";
export type { ExportPhase, ExportSnapshot, JobProgress, RecordInterval } from "./export-execution";

export type Foreground = Readonly<{ epoch: number; kind: "browse" } | { epoch: number; kind: "export"; jobId: number }>;
export interface FocusToken { readonly jobId: number; readonly epoch: number }
export interface ExportEvent {
  time: number;
  event: string;
  epoch: number;
  gateVersion: number;
  jobId?: number;
  reason?: string;
  bytes?: number;
}

export class ExportJobs implements ReadAdmission {
  private jobs = new Map<number, ExportExecution>();
  private preference: Foreground = Object.freeze({ epoch: 0, kind: "browse" });
  private version = 0;
  private nextId = 0;
  private gates = new Set<() => void>();
  private views = new Set<() => void>();

  constructor(private onEvent?: (event: ExportEvent) => void) {}

  get foreground() { return this.preference; }
  get gateVersion() { return this.version; }
  get focused(): ExportSnapshot | undefined { return this.active?.snapshot; }
  private get active() { return this.preference.kind === "export" ? this.jobs.get(this.preference.jobId) : undefined; }
  get(id: number): ExportSnapshot | undefined { return this.jobs.get(id)?.snapshot; }
  list(): readonly ExportSnapshot[] { return [...this.jobs.values()].map((job) => job.snapshot); }

  create(name: string): ExportExecution {
    const job = new ExportExecution(++this.nextId, name, {
      changed: (kind) => {
        if (kind === "scope") this.changedGate("plan-sealed", job.id);
        else if (kind === "terminal") {
          // Completion of a resumed job releases it; a late completion of A cannot release B.
          if (this.active === job) this.preference = Object.freeze({ epoch: this.preference.epoch + 1, kind: "browse" });
          this.changedGate("job-terminal", job.id, job.phase);
        } else this.changed();
      },
      event: (event, bytes) => this.event(event, job.id, undefined, bytes),
    });
    this.jobs.set(job.id, job);
    this.focusExport(job.id);
    this.event("job-created", job.id);
    return job;
  }

  allows(source: object, file: FileEntry, lo: number, hi: number): boolean {
    const job = this.active;
    return !job || job.terminal || !job.scope || job.scope.overlaps(source, file, lo, hi);
  }

  focusBrowse(reason = "browse") {
    this.preference = Object.freeze({ epoch: this.preference.epoch + 1, kind: "browse" });
    this.changedGate("foreground-browse", undefined, reason);
  }

  focusExport(id: number): FocusToken | undefined {
    const job = this.jobs.get(id);
    if (!job || job.terminal) return;
    this.preference = Object.freeze({ epoch: this.preference.epoch + 1, kind: "export", jobId: id });
    this.changedGate("foreground-export", id);
    return Object.freeze({ jobId: id, epoch: this.preference.epoch });
  }

  retireFocus(token: FocusToken) {
    const f = this.preference;
    if (f.kind === "export" && f.jobId === token.jobId && f.epoch === token.epoch) this.focusBrowse("dismiss");
  }

  cancel(id: number) { this.jobs.get(id)?.cancel(); }
  forget(id: number) {
    const job = this.jobs.get(id);
    if (job?.terminal && job.snapshot.cleanupComplete) { this.jobs.delete(id); this.changed(); }
  }

  subscribeChanged(f: () => void): () => void { this.gates.add(f); return () => { this.gates.delete(f); }; }
  subscribe(f: () => void): () => void { this.views.add(f); return () => { this.views.delete(f); }; }

  private changedGate(event: string, jobId?: number, reason?: string) {
    this.version++;
    this.event(event, jobId, reason);
    for (const f of [...this.gates]) f();
    this.changed();
  }
  private changed() { for (const f of [...this.views]) f(); }
  private event(event: string, jobId?: number, reason?: string, bytes?: number) {
    this.onEvent?.({ time: performance.now(), event, epoch: this.preference.epoch, gateVersion: this.version, jobId, reason, bytes });
  }
}
