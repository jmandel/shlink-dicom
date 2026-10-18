// "Download originals": the shared DICOM files, byte for byte, as a ZIP with a DICOMDIR (a series,
// a study or every study shared), or one .dcm file. Series are read in runs of a few MB, so memory stays bounded and
// bytes reach the save target as they are verified.
import type { SeriesEntry, StudyEntry } from "./bundle";
import { buildDicomdir, type DicomdirEntry } from "./dicomdir";
import { readDicomHeader } from "./dicom-header";
import { FetchPriority, type InstanceLoader } from "./loader";
import { planRuns, type RangePlan } from "./range";
import type { ExportJob } from "./export-jobs";

/** Runs (of up to 8 MiB) read ahead of the one being written. */
const READ_AHEAD = 3;
import { ZipWriter, type ByteSink } from "./zip";

export interface ExportProgress {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
}

export type ExportScope =
  | { kind: "all"; studies: StudyEntry[] }
  | { kind: "study"; study: StudyEntry }
  | { kind: "series"; study: StudyEntry; series: SeriesEntry };

/** The studies of a scope, each with the series it includes. */
function scopeStudies(scope: ExportScope): SeriesEntry[][] {
  return scope.kind === "all" ? scope.studies.map((st) => st.series) : scope.kind === "study" ? [scope.study.series] : [[scope.series]];
}

const pad = (n: number) => String(n).padStart(6, "0");

export interface ExportPlan {
  readonly total: Readonly<{ files: number; bytes: number }>;
  readonly runs: readonly Readonly<{ t: number; s: number; series: SeriesEntry; plan: Readonly<RangePlan> }>[];
}

/** Snapshot the complete inventory before any payload read. Execution consumes this same plan. */
export function planExport(scope: ExportScope): ExportPlan {
  const runs: ExportPlan["runs"][number][] = [];
  let files = 0, bytes = 0;
  scopeStudies(scope).forEach((list, t) => list.forEach((original, s) => {
    const series = { ...original, instances: original.instances.map((i) => Object.freeze({ ...i })) };
    Object.freeze(series.instances);
    Object.freeze(series);
    files += series.instances.length;
    bytes += series.instances.reduce((n, i) => n + i.length, 0);
    for (const plan of planRuns(series)) runs.push(Object.freeze({ t, s, series, plan: Object.freeze(plan) }));
  }));
  return Object.freeze({ total: Object.freeze({ files, bytes }), runs: Object.freeze(runs) });
}

export function sealExport(job: ExportJob, loader: InstanceLoader, plan: ExportPlan): boolean {
  return job.seal(loader.resolver, plan.runs.map((r) => ({ file: r.series.file, lo: r.plan.firstRecord, hi: r.plan.lastRecord + 1 })));
}

/** Bytes and file count an export will contain (before the DICOMDIR). */
export function exportSize(scope: ExportScope): { files: number; bytes: number } {
  const list = scopeStudies(scope).flat();
  return {
    files: list.reduce((a, s) => a + s.instances.length, 0),
    bytes: list.reduce((a, s) => a + s.bytes, 0),
  };
}

/**
 * Writes the scope as a ZIP: `DICOMDIR` plus `DICOM/ST000001/SE000001/IM000001`… (DICOM file IDs:
 * up to 8 upper-case characters per component, no extension). The files are the shared bytes,
 * unchanged.
 */
export async function exportZip(
  scope: ExportScope,
  loader: InstanceLoader,
  sink: ByteSink,
  onProgress?: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  return exportPlannedZip(planExport(scope), loader, sink, onProgress, signal);
}

/** The caller owns a job across planning, execution and cleanup. Headless callers can omit it. */
export async function exportPlannedZip(
  plan: ExportPlan,
  loader: InstanceLoader,
  sink: ByteSink,
  onProgress?: (p: ExportProgress) => void,
  signal?: AbortSignal,
  job?: ExportJob,
): Promise<void> {
  const total = plan.total;
  const zip = new ZipWriter(sink);
  const dir: DicomdirEntry[] = [];
  const progress: ExportProgress = { files: 0, totalFiles: total.files, bytes: 0, totalBytes: total.bytes };
  const controller = new AbortController();
  const reads = new Set<Promise<Uint8Array[]>>();
  let failed = false, failure: unknown;
  let abortSink: Promise<void> | undefined;
  const stop = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
    job?.fail(error); // terminal + gate release before any asynchronous cleanup
    controller.abort(error);
    abortSink = Promise.resolve().then(() => sink.abort(error)).catch(() => {});
  };
  const cancelled = () => stop(signal?.reason ?? new DOMException("export cancelled", "AbortError"));
  signal?.addEventListener("abort", cancelled, { once: true });
  const check = () => {
    if (failed) throw failure;
    if (signal?.aborted) { cancelled(); throw failure; }
    job?.check();
  };
  try {
    check();
    onProgress?.(progress);
    // Every run in order. A few are read ahead (fetched and verified) while earlier ones are
    // written, so the connection stays busy while the ZIP is written.
    const runs = plan.runs;
    const ahead: (Promise<Uint8Array[]> | undefined)[] = [];
    let verifiedRuns = 0;
    const start = (k: number) => {
      if (k >= runs.length || ahead[k]) return;
      check();
      const run = runs[k];
      job?.require(loader.resolver, run.series.file, run.plan.firstRecord, run.plan.lastRecord + 1);
      ahead[k] = loader.run(run.series, run.plan, { priority: FetchPriority.Background, signal: controller.signal, durable: true }).then((files) => {
        check();
        if (++verifiedRuns === runs.length) job?.finalizing();
        return files;
      });
      const reading = ahead[k]!;
      reads.add(reading);
      reading.then(() => reads.delete(reading), (e) => { reads.delete(reading); stop(e); });
    };
    job?.running();
    if (!runs.length) job?.finalizing();
    for (let k = 0; k < runs.length; k++) {
      check();
      for (let j = k; j < k + READ_AHEAD; j++) start(j);
      const { t, s, plan } = runs[k];
      const files = await ahead[k]!;
      delete ahead[k];
      for (let n = 0; n < files.length; n++) {
        check();
        const i = plan.firstInstance + n;
        const id = ["DICOM", `ST${pad(t + 1)}`, `SE${pad(s + 1)}`, `IM${pad(i + 1)}`];
        await zip.add(id.join("/"), files[n]);
        try {
          dir.push({ fileId: id, header: await readDicomHeader(files[n]) });
        } catch {
          // Not Part 10: stored in the ZIP but left out of the DICOMDIR.
        }
        progress.files++;
        progress.bytes += files[n].byteLength;
        onProgress?.(progress);
      }
    }
    check();
    await zip.add("DICOMDIR", buildDicomdir(dir));
    check();
    await zip.finish();
    check();
  } catch (e) {
    stop(e);
    throw e;
  } finally {
    signal?.removeEventListener("abort", cancelled);
    await Promise.allSettled(reads);
    await abortSink;
  }
}

/** One instance's bytes, for "This image". */
export function exportInstance(loader: InstanceLoader, series: SeriesEntry, i: number, onProgress?: (received: number, total: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  return loader.instance(series, i, { priority: FetchPriority.Visible, onProgress, signal, durable: true });
}

/** A file name such as "brain-mri-2020-07-29" from a study's description and date. */
export function exportBaseName(study: StudyEntry, series?: SeriesEntry): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
  const parts = [slug(study.description ?? "study") || "study"];
  if (study.started) parts.push(study.started.slice(0, 10));
  if (series) parts.push(slug(series.description ?? `series-${series.number ?? ""}`) || "series");
  return parts.join("-");
}
