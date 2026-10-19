// "Download originals": the shared DICOM files, byte for byte, as a ZIP with a DICOMDIR (a series,
// a study or every study shared), or one .dcm file. A few source runs are read ahead; the
// save target determines whether output streams to disk or is retained in a Blob.
import type { SeriesEntry, StudyEntry } from "./bundle";
import { buildDicomdir, type DicomdirEntry } from "./dicomdir";
import { readDicomHeader } from "./dicom-header";
import { DicomdirHeader } from "./dicomdir-header";
import { FetchPriority, type InstanceLoader } from "./loader";
import { planInstances, planRuns, type RangePlan } from "./range";
import { ExportExecution } from "./export-execution";

/** Runs (of up to 8 MiB) read ahead of the one being written. */
const READ_AHEAD = 3;
const MAX_RUN_BYTES = 8 * 1024 * 1024;
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
  const plan = planExport(scope);
  const execution = new ExportExecution(0, "archive.zip");
  return execution.run(sink, (task, owned) => writePlannedZip(plan, loader, owned, task, onProgress), signal);
}

/** Format the archive. The execution owns failure, read-ahead cancellation and writer cleanup. */
export async function writePlannedZip(
  plan: ExportPlan,
  loader: InstanceLoader,
  sink: ByteSink,
  execution: ExportExecution,
  onProgress?: (p: ExportProgress) => void,
): Promise<void> {
  execution.seal(loader.resolver, plan.runs.map((r) => ({ file: r.series.file, lo: r.plan.firstRecord, hi: r.plan.lastRecord + 1 })));
  const zip = new ZipWriter(sink);
  const dir: DicomdirEntry[] = [];
  const progress: ExportProgress = { files: 0, totalFiles: plan.total.files, bytes: 0, totalBytes: plan.total.bytes };
  const report = () => { execution.update(progress); onProgress?.(progress); };
  report();
  const runs = plan.runs;
  const ahead: (Promise<Uint8Array[]> | undefined)[] = [];
  let verifiedRuns = 0;
  const start = (k: number) => {
    if (k >= runs.length || ahead[k]) return;
    const run = runs[k];
    // planRuns groups small instances, but a single large instance must stream within itself.
    if (run.plan.plaintextEnd - run.plan.plaintextStart > MAX_RUN_BYTES) return;
    ahead[k] = execution.read(loader.resolver, { file: run.series.file, lo: run.plan.firstRecord, hi: run.plan.lastRecord + 1 },
      (signal) => loader.run(run.series, run.plan, { priority: FetchPriority.Background, signal, durable: true }),
      () => { if (++verifiedRuns === runs.length) execution.sourcesVerified(); });
  };
  if (!runs.length) execution.sourcesVerified();
  for (let k = 0; k < runs.length; k++) {
    execution.check();
    for (let j = k; j < k + READ_AHEAD; j++) start(j);
    const { t, s, plan } = runs[k];
    if (plan.plaintextEnd - plan.plaintextStart > MAX_RUN_BYTES) {
      const run = runs[k], i = plan.firstInstance;
      const id = ["DICOM", `ST${pad(t + 1)}`, `SE${pad(s + 1)}`, `IM${pad(i + 1)}`];
      const header = new DicomdirHeader();
      await execution.read(loader.resolver, { file: run.series.file, lo: plan.firstRecord, hi: plan.lastRecord + 1 }, async (signal) => {
        async function* chunks() {
          for await (const bytes of loader.streamInstance(run.series, i, { priority: FetchPriority.Background, signal, durable: true })) {
            await header.feed(bytes);
            yield bytes;
            progress.bytes += bytes.length;
            report();
          }
        }
        try {
          await zip.addStream(id.join("/"), run.series.instances[i].length, chunks());
          const collected = await header.finish();
          if (collected) dir.push({ fileId: id, header: collected });
        } finally { await header.dispose(); }
      }, () => { if (++verifiedRuns === runs.length) execution.sourcesVerified(); });
      progress.files++;
      report();
      continue;
    }
    const files = await ahead[k]!;
    delete ahead[k];
    for (let n = 0; n < files.length; n++) {
      execution.check();
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
      report();
    }
  }
  execution.check();
  await zip.add("DICOMDIR", buildDicomdir(dir));
  await zip.finish();
}

/** One instance's verified bytes, for callers that do not need a save target. */
export function exportInstance(loader: InstanceLoader, series: SeriesEntry, i: number, onProgress?: (received: number, total: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  return loader.instance(series, i, { priority: FetchPriority.Visible, onProgress, signal, durable: true });
}

/** The single-image formatter uses the same execution owner as a ZIP. */
export async function writeInstance(loader: InstanceLoader, series: SeriesEntry, i: number, sink: ByteSink, execution: ExportExecution): Promise<void> {
  const plan = planInstances(series, i);
  const range = { file: series.file, lo: plan.firstRecord, hi: plan.lastRecord + 1 };
  execution.seal(loader.resolver, [range]);
  const totalBytes = series.instances[i].length;
  let bytes = 0;
  execution.update({ bytes, totalBytes, files: 0, totalFiles: 1 });
  await execution.read(loader.resolver, range,
    async (signal) => {
      for await (const chunk of loader.streamInstance(series, i, { priority: FetchPriority.Visible, signal, durable: true })) {
        await sink.write(chunk);
        bytes += chunk.length;
        execution.update({ bytes, totalBytes, files: 0, totalFiles: 1 });
      }
    },
    () => execution.sourcesVerified());
  execution.update({ bytes, totalBytes, files: 1, totalFiles: 1 });
  await sink.close();
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
