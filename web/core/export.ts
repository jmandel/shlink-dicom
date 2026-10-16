// "Download originals": the shared DICOM files, byte for byte, as a ZIP with a DICOMDIR (a series,
// a study or every study shared), or one .dcm file. Series are read in runs of a few MB, so memory stays bounded and
// bytes reach the save target as they are verified.
import type { SeriesEntry, StudyEntry } from "./bundle";
import { buildDicomdir, type DicomdirEntry } from "./dicomdir";
import { readDicomHeader } from "./dicom-header";
import { FetchPriority, type InstanceLoader } from "./loader";
import { planRuns, type RangePlan } from "./range";

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
  const total = exportSize(scope);
  const zip = new ZipWriter(sink);
  const dir: DicomdirEntry[] = [];
  const progress: ExportProgress = { files: 0, totalFiles: total.files, bytes: 0, totalBytes: total.bytes };
  onProgress?.(progress);
  try {
    const studies = scopeStudies(scope);
    // Every run in order. A few are read ahead (fetched and verified) while earlier ones are
    // written, so the connection stays busy while the ZIP is written.
    const runs: { t: number; s: number; series: SeriesEntry; plan: RangePlan }[] = [];
    studies.forEach((list, t) => list.forEach((series, s) => planRuns(series).forEach((plan) => runs.push({ t, s, series, plan }))));
    const ahead: (Promise<Uint8Array[]> | undefined)[] = [];
    const start = (k: number) => {
      if (k >= runs.length || ahead[k]) return;
      ahead[k] = loader.run(runs[k].series, runs[k].plan, { priority: FetchPriority.Background, signal });
      ahead[k]!.catch(() => {});
    };
    for (let k = 0; k < runs.length; k++) {
      if (signal?.aborted) throw new DOMException("export cancelled", "AbortError");
      for (let j = k; j < k + READ_AHEAD; j++) start(j);
      const { t, s, plan } = runs[k];
      const files = await ahead[k]!;
      delete ahead[k];
      for (let n = 0; n < files.length; n++) {
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
    await zip.add("DICOMDIR", buildDicomdir(dir));
    await zip.finish();
  } catch (e) {
    await sink.abort(e).catch(() => {});
    throw e;
  }
}

/** One instance's bytes, for "This image". */
export function exportInstance(loader: InstanceLoader, series: SeriesEntry, i: number, onProgress?: (received: number, total: number) => void): Promise<Uint8Array> {
  return loader.instance(series, i, { priority: FetchPriority.Visible, onProgress });
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
