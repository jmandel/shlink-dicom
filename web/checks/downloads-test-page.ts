import { ExportJobs } from "../core/export-jobs";
import { DownloadsController } from "../view/downloads";

const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

(globalThis as any).__downloadsChecks = async () => {
  const results: string[] = [];
  document.body.innerHTML = `<style>.hidden{display:none}</style><aside id="download-jobs" class="hidden"></aside>
    <div id="sheet-backdrop" class="hidden"></div><section id="sheet-download" class="hidden">
      <div id="dl-options"></div><div id="dl-progress"><div id="dl-track"><div id="dl-bar"></div></div>
      <p id="dl-status"></p><button id="btn-dl-cancel">Cancel</button></div></section>`;
  const $ = (id: string) => document.getElementById(id)!;
  const jobs = new ExportJobs(); let open = false, opens = 0;
  const panel = {
    open: () => { controller.closed(); open = true; opens++; $("sheet-download").classList.remove("hidden"); $("sheet-backdrop").classList.remove("hidden"); },
    close: () => { controller.closed(); open = false; $("sheet-download").classList.add("hidden"); $("sheet-backdrop").classList.add("hidden"); },
    isOpen: () => open,
  };
  const controller = new DownloadsController(jobs, panel, (error) => (error as Error).message);
  const make = (name: string) => {
    const source = {}, ready = deferred(); let aborts = 0;
    const execution = jobs.create(name);
    const finished = execution.run({ write: async () => {}, close: async () => {}, abort: async () => { aborts++; } }, async (task, sink) => {
      task.seal(source, []); await ready.promise; task.sourcesVerified(); await sink.close();
    }).catch(() => {});
    return { execution, ready, finished, aborts: () => aborts };
  };
  const row = (id: number) => document.querySelector<HTMLElement>(`[data-job-id="${id}"]`)!;
  const action = (id: number) => row(id).querySelector<HTMLButtonElement>("button:last-child")!;

  const a = make("A.zip"); controller.show(a.execution.id, false); await turn();
  a.execution.update({ files: 1, totalFiles: 2, bytes: 10, totalBytes: 20 });
  assert($("dl-track").getAttribute("aria-valuenow") === "10", "selected progress missing");
  assert($("dl-bar").style.width === "50%", "progress fill mismatch");
  assert($("sheet-download").getAttribute("aria-modal") === "false", "progress blocks browsing");
  controller.browse("image");
  assert(!open && jobs.foreground.kind === "browse", "browsing must close progress and release preference");
  assert(!a.execution.signal.aborted, "closing progress cancelled the execution");
  results.push("progress renders snapshots; browsing closes progress without cancelling");

  controller.show(a.execution.id); const first = jobs.foreground;
  jobs.focusBrowse(); jobs.focusExport(a.execution.id); panel.close();
  assert(jobs.foreground.kind === "export" && jobs.foreground.epoch !== first.epoch, "old panel lease released resumed preference");
  results.push("closing an old panel lease cannot release a newer selection of the same job");

  const b = make("B.zip"); controller.show(b.execution.id, false); await turn();
  b.execution.update({ files: 2, totalFiles: 3, bytes: 20, totalBytes: 30 });
  const statusB = $("dl-status").textContent, opensB = opens;
  a.ready.resolve(); await a.finished;
  assert($("dl-status").textContent === statusB && opens === opensB && open, "late A changed B's panel");
  assert(jobs.focused?.id === b.execution.id, "late A released B's foreground preference");
  assert(row(a.execution.id).textContent?.includes("Saved A.zip"), "A's own status was not updated");
  results.push("late completion updates only its row and leaves the selected job intact");

  $("btn-dl-cancel").click(); await turn();
  assert(b.execution.phase === "cancelled" && a.execution.phase === "completed", "cancel affected the wrong job");
  assert(action(b.execution.id).disabled && b.aborts() === 1, "cleanup must retain the cancelled row");
  b.ready.resolve(); await b.finished;
  assert(!action(b.execution.id).disabled, "completed cleanup did not enable dismissal");
  action(b.execution.id).click();
  assert(!jobs.get(b.execution.id) && !document.querySelector(`[data-job-id="${b.execution.id}"]`), "dismissal did not remove B");
  results.push("cancel targets the selected execution; dismissal waits for cleanup");

  const c = make("C.zip"); controller.show(c.execution.id, false); await turn(); panel.close();
  const closedAt = opens;
  c.ready.resolve(); await c.finished;
  assert(!open && opens === closedAt, "background completion reopened the panel");
  results.push("background completion never opens or selects progress");

  const d = make("D.zip"); controller.show(d.execution.id, false); await turn();
  let choices = 0;
  controller.showChoices([{ id: "series", title: "Series", detail: "2 files", bytes: 10, run: () => { choices++; } }]);
  assert($("sheet-download").getAttribute("aria-modal") === "true", "choices retained nonmodal progress styling");
  d.execution.update({ files: 1, totalFiles: 2, bytes: 5, totalBytes: 10 });
  assert($("dl-progress").classList.contains("hidden") && !$("dl-options").classList.contains("hidden"), "background progress replaced choices");
  $("dl-options").querySelector<HTMLButtonElement>("button")!.click();
  assert(choices === 1 && !d.execution.signal.aborted, "choice callback or job lifetime changed");
  results.push("choice presentation is independent of background progress");

  controller.show(d.execution.id); controller.show(a.execution.id);
  assert(jobs.focused?.id === d.execution.id, "viewing a completed job stole active export preference");
  assert($("btn-dl-cancel").classList.contains("hidden"), "completed job offered cancellation");
  results.push("completed rows remain inspectable without selecting an inactive job for loading");

  controller.dispose();
  d.execution.update({ files: 2, totalFiles: 2, bytes: 10, totalBytes: 10 });
  assert(!$("download-jobs").children.length && !d.execution.signal.aborted, "disposed UI retained observers or cancelled work");
  d.ready.resolve(); await d.finished;
  assert(!$("download-jobs").children.length, "completion repopulated disposed UI");
  results.push("disposing presentation removes observers and leaves execution ownership intact");
  return results;
};
