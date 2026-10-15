// "Download originals": the shared DICOM files, byte for byte, as a ZIP with a DICOMDIR (a study
// or a series), or one .dcm file. Series are read in runs of a few MB, so memory stays bounded and
// bytes reach the save target as they are verified.
import type { SeriesEntry, StudyEntry } from "./bundle";
import { buildDicomdir, type DicomdirEntry } from "./dicomdir";
import { readDicomHeader } from "./dicom-header";
import { FetchPriority, type InstanceLoader } from "./loader";
import { planRuns } from "./range";
import { ZipWriter, type ByteSink } from "./zip";

export interface ExportProgress {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
}

export type ExportScope =
  | { kind: "study"; study: StudyEntry }
  | { kind: "series"; study: StudyEntry; series: SeriesEntry };

const pad = (n: number) => String(n).padStart(6, "0");

/** Bytes and file count an export will contain (before the DICOMDIR). */
export function exportSize(scope: ExportScope): { files: number; bytes: number } {
  const list = scope.kind === "study" ? scope.study.series : [scope.series];
  return {
    files: list.reduce((a, s) => a + s.instances.length, 0),
    bytes: list.reduce((a, s) => a + s.plaintextLength, 0),
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
  const seriesList = scope.kind === "study" ? scope.study.series : [scope.series];
  const total = exportSize(scope);
  const zip = new ZipWriter(sink);
  const dir: DicomdirEntry[] = [];
  const progress: ExportProgress = { files: 0, totalFiles: total.files, bytes: 0, totalBytes: total.bytes };
  onProgress?.(progress);
  try {
    for (let s = 0; s < seriesList.length; s++) {
      const series = seriesList[s];
      for (const plan of planRuns(series)) {
        if (signal?.aborted) throw new DOMException("export cancelled", "AbortError");
        const files = await loader.run(series, plan, { priority: FetchPriority.Background, signal });
        for (let k = 0; k < files.length; k++) {
          const i = plan.firstInstance + k;
          const id = ["DICOM", "ST000001", `SE${pad(s + 1)}`, `IM${pad(i + 1)}`];
          await zip.add(id.join("/"), files[k]);
          try {
            dir.push({ fileId: id, header: readDicomHeader(files[k]) });
          } catch {
            // Not Part 10: stored in the ZIP but left out of the DICOMDIR.
          }
          progress.files++;
          progress.bytes += files[k].byteLength;
          onProgress?.(progress);
        }
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
export function exportInstance(loader: InstanceLoader, series: SeriesEntry, i: number): Promise<Uint8Array> {
  return loader.instance(series, i, { priority: FetchPriority.Visible });
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
