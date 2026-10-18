/** Permission to update one presentation or start its next work. It never cancels shared data. */
export class ViewOperation {
  constructor(readonly current: () => boolean) {}

  /** Apply a synchronous UI effect, including progress or errors, only while current. */
  commit(effect: () => void): boolean {
    if (!this.current()) return false;
    effect(); return true;
  }

  /** A sequential producer must preserve this promise so the next step still waits for it. */
  start<T>(work: () => Promise<T>): Promise<T> | undefined {
    if (this.current()) return work();
  }

  withGuard(condition: () => boolean): ViewOperation {
    return new ViewOperation(() => this.current() && condition());
  }
}

/** Successive operations for a single target. Returning to an old target cannot revive a token. */
export class LatestOperation {
  private revision = 0;
  invalidate() { this.revision++; }
  begin(condition: () => boolean = () => true): ViewOperation { this.invalidate(); return this.capture(condition); }
  capture(condition: () => boolean = () => true): ViewOperation {
    const revision = this.revision;
    return new ViewOperation(() => revision === this.revision && condition());
  }
}

/** A series/view lifetime, with one presentation slot shared by slices and reformats. */
export class ViewSession {
  private context = new LatestOperation();
  private presentation = new LatestOperation();

  reset() { this.context.invalidate(); this.presentation.invalidate(); }
  capture(condition?: () => boolean) { return this.context.capture(condition); }
  beginPresentation(condition?: () => boolean) {
    return this.presentation.begin(this.context.capture(condition).current);
  }
  capturePresentation(condition?: () => boolean) {
    return this.presentation.capture(this.context.capture(condition).current);
  }
}
