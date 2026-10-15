import type { WasmShlSession } from "../crates/shl-dicom-wasm/pkg/shl_dicom_wasm.js";
import type { StudySummary, SeriesSummary } from "./view-sharer";
import { buildStoreZip, triggerBlobDownload, type ZipEntryInput } from "./exporter";

export function exportCurrentSlice(
  session: WasmShlSession,
  studyIdx: number,
  seriesIdx: number,
  instIdx: number,
  instUid: string,
) {
  const bytes = session.get_instance_dicom(studyIdx, seriesIdx, instIdx);
  triggerBlobDownload(new Blob([bytes], { type: "application/dicom" }), `${instUid}.dcm`);
}

export async function exportCurrentSeries(
  session: WasmShlSession,
  studyIdx: number,
  seriesIdx: number,
  ser: SeriesSummary,
  ensureSeriesFetched: (ser: SeriesSummary) => Promise<void>,
) {
  await ensureSeriesFetched(ser);
  const zipBytes = session.export_series_zip(studyIdx, seriesIdx);
  triggerBlobDownload(new Blob([zipBytes], { type: "application/zip" }), `series-${ser.uid}.zip`);
}

export async function exportCurrentStudy(
  session: WasmShlSession,
  studyIdx: number,
  study: StudySummary,
  ensureSeriesFetched: (ser: SeriesSummary) => Promise<void>,
) {
  const entries: ZipEntryInput[] = [];
  for (let sIdx = 0; sIdx < study.series.length; sIdx++) {
    const ser = study.series[sIdx];
    await ensureSeriesFetched(ser);
    for (let iIdx = 0; iIdx < ser.instances.length; iIdx++) {
      const inst = ser.instances[iIdx];
      const dcm = session.get_instance_dicom(studyIdx, sIdx, iIdx);
      entries.push({
        path: `${study.studyInstanceUid}/${ser.uid}/${String(iIdx + 1).padStart(4, "0")}-${inst.uid}.dcm`,
        data: dcm,
      });
    }
  }
  const blob = buildStoreZip(entries);
  triggerBlobDownload(blob, `study-${study.studyInstanceUid}.zip`);
}
