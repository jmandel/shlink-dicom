import type { ExportJobs, ExportSnapshot, FocusToken } from "../core/export-jobs";
import { formatBytes, plural } from "../core/format";

export interface DownloadChoice {
  id: "image" | "series" | "study" | "all";
  title: string;
  detail: string;
  bytes: number;
  disabled?: string;
  run: () => void;
}
interface Panel {
  open(): void;
  close(): void;
  isOpen(): boolean;
}
const terminal = (job: ExportSnapshot) => job.phase === "completed" || job.phase === "failed" || job.phase === "cancelled";
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
};

/** Owns download presentation and its focus lease. State notifications only render existing UI. */
export class DownloadsController {
  private selected: number | null = null;
  private focus?: FocusToken;
  private rows = new Map<number, { root: HTMLElement; open: HTMLButtonElement; title: HTMLElement; status: HTMLElement; action: HTMLButtonElement }>();
  private unsubscribe: () => void;
  private $: <T extends HTMLElement = HTMLElement>(id: string) => T;
  private cancelSelected = () => { if (this.selected !== null) this.jobs.cancel(this.selected); };

  constructor(private jobs: ExportJobs, private panel: Panel, private describeFailure: (error: unknown) => string, root: ParentNode = document) {
    this.$ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
    this.$("btn-dl-cancel").addEventListener("click", this.cancelSelected);
    this.unsubscribe = jobs.subscribe(() => this.render());
    this.render();
  }

  showChoices(choices: readonly DownloadChoice[], visible = true) {
    this.panel.open();
    this.selected = null;
    this.$("sheet-download").classList.remove("nonmodal");
    this.$("sheet-download").setAttribute("aria-modal", "true");
    this.$("dl-progress").classList.add("hidden");
    const options = this.$("dl-options");
    options.replaceChildren(); options.classList.toggle("hidden", !visible);
    for (const choice of choices) {
      const button = element("button", "dl-option"); button.type = "button"; button.dataset.choice = choice.id;
      if (choice.disabled) { button.disabled = true; button.dataset.reason = choice.disabled; }
      else button.dataset.bytes = String(choice.bytes);
      button.append(element("strong", "", choice.title), element("span", "", choice.detail));
      button.addEventListener("click", choice.run); options.append(button);
    }
  }

  show(id: number, focus = true) {
    if (!this.jobs.get(id)) return;
    if (!this.panel.isOpen()) this.panel.open();
    this.selected = id;
    const foreground = this.jobs.foreground;
    this.focus = focus ? this.jobs.focusExport(id) : foreground.kind === "export" && foreground.jobId === id ? { jobId: id, epoch: foreground.epoch } : undefined;
    this.$("dl-options").classList.add("hidden");
    this.$("dl-progress").classList.remove("hidden");
    this.$("sheet-download").classList.add("nonmodal");
    this.$("sheet-download").setAttribute("aria-modal", "false");
    this.$("sheet-backdrop").classList.add("hidden");
    this.render();
  }

  /** Called by the sheet host whenever this panel closes, including replacement by another sheet. */
  closed() {
    const focus = this.focus;
    this.focus = undefined; this.selected = null;
    if (focus) this.jobs.retireFocus(focus);
  }

  browse(reason: string) {
    if (this.jobs.foreground.kind === "export") this.jobs.focusBrowse(reason);
    if (this.panel.isOpen() && this.$("sheet-download").classList.contains("nonmodal")) this.panel.close();
  }

  dispose() {
    this.closed(); this.unsubscribe();
    this.$("btn-dl-cancel").removeEventListener("click", this.cancelSelected);
    for (const row of this.rows.values()) row.root.remove();
    this.rows.clear(); this.$("download-jobs").classList.add("hidden");
  }

  private status(job: ExportSnapshot) {
    if (job.phase === "completed") return `Saved ${job.name}`;
    if (job.phase === "cancelled") return "Cancelled.";
    if (job.phase === "failed") return `The download stopped: ${this.describeFailure(job.error)}.`;
    if (job.phase === "planning") return "Preparing download…";
    const p = job.progress;
    return `${job.phase === "finalizing" ? "Finishing" : "Saving"} · ${formatBytes(p.bytes)} of ${formatBytes(p.totalBytes)} · ${plural(p.files, "file")} saved`;
  }

  private render() {
    const host = this.$("download-jobs"), jobs = this.jobs.list();
    for (const [id, row] of this.rows) if (!this.jobs.get(id)) { row.root.remove(); this.rows.delete(id); }
    for (const job of jobs) {
      let row = this.rows.get(job.id);
      if (!row) {
        const root = element("div", "download-job"), open = element("button", "btn btn-ghost download-job-open"), title = element("strong"), status = element("span"), action = element("button", "btn btn-ghost");
        root.dataset.jobId = String(job.id); open.type = action.type = "button";
        open.append(title, status); root.append(open, action); host.append(root);
        open.addEventListener("click", () => this.show(job.id));
        action.addEventListener("click", () => {
          const current = this.jobs.get(job.id);
          if (current) terminal(current) ? this.jobs.forget(job.id) : this.jobs.cancel(job.id);
        });
        this.rows.set(job.id, row = { root, open, title, status, action });
      }
      row.title.textContent = job.name; row.status.textContent = this.status(job);
      row.root.setAttribute("aria-current", String(this.jobs.focused?.id === job.id));
      row.open.setAttribute("aria-label", `${terminal(job) ? "View" : "Focus"} download: ${job.name}`);
      row.action.textContent = terminal(job) ? "Dismiss" : "Cancel";
      row.action.disabled = terminal(job) && !job.cleanupComplete;
    }
    host.classList.toggle("hidden", !jobs.length);
    const selected = this.selected === null ? undefined : this.jobs.get(this.selected);
    if (!selected) return;
    const { bytes, totalBytes } = selected.progress, track = this.$("dl-track");
    track.setAttribute("aria-valuemax", String(totalBytes)); track.setAttribute("aria-valuenow", String(bytes));
    track.setAttribute("aria-valuetext", `${formatBytes(bytes)} of ${formatBytes(totalBytes)}`);
    this.$("dl-bar").style.width = `${(100 * bytes) / Math.max(1, totalBytes)}%`;
    this.$("dl-status").textContent = this.status(selected);
    this.$("btn-dl-cancel").classList.toggle("hidden", terminal(selected));
  }
}
