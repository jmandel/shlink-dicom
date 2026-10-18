import type { FileEntry } from "./bundle";

/** Policy for starting a physical read. Cached data and existing transfers bypass it. */
export interface ReadAdmission {
  allows(source: object, file: FileEntry, firstRecord: number, endRecord: number): boolean;
  subscribeChanged(wake: () => void): () => void;
}

/** Observe policy only while a reader has queued work; coalesce changes into one pump. */
export class AdmissionWakeup {
  private unsubscribe?: () => void;
  private queued = false;
  private scheduled = false;

  constructor(private admission: ReadAdmission | undefined, private wake: () => void) {}

  update(hasQueuedWork: boolean) {
    this.queued = hasQueuedWork;
    if (hasQueuedWork && this.admission && !this.unsubscribe) {
      this.unsubscribe = this.admission.subscribeChanged(() => {
        if (this.scheduled) return;
        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          if (this.queued) this.wake();
        });
      });
    } else if (!hasQueuedWork && this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }
}
