// Linking FHIR DiagnosticReports to the imaging studies in a share. Reports usually come from
// the clinical record, not from the imaging system, so the link is worked out, in this order:
//   1. "reference": DiagnosticReport.imagingStudy.reference resolves to the study's entry in this
//      Bundle (its fullUrl, or "ImagingStudy/<id>");
//   2. "uid": DiagnosticReport.imagingStudy.identifier is the study's Study Instance UID;
//   3. "accession": a report identifier equals the study's accession number (from the Bundle,
//      or from the DICOM header once an image has been read);
//   4. "date": the same date, and the report's code or category names the study's modality.
//      This is a guess, and the viewer says so.
// A report that matches no study stays unlinked and is listed on its own.
import type { ReportEntry, StudyEntry, StudyIndex } from "./bundle";

export type LinkBasis = "reference" | "uid" | "accession" | "date";

export interface ReportLink {
  report: ReportEntry;
  studyId: string | null;
  basis: LinkBasis | null;
}

/** Accession numbers learnt from DICOM headers, by ImagingStudy id. */
const headerAccessions = new WeakMap<StudyIndex, Map<string, string>>();

/** Records a study's accession number read from an image header (0008,0050). */
export function noteAccession(index: StudyIndex, studyId: string, accession: string | null) {
  if (!accession) return;
  let m = headerAccessions.get(index);
  if (!m) headerAccessions.set(index, (m = new Map()));
  m.set(studyId, accession);
}

const MODALITY_WORDS: Record<string, RegExp> = {
  CT: /\bCT\b|computed tomograph/i,
  MR: /\bMRI?\b|magnetic resonance/i,
  CR: /\bX-?ray\b|\bXR\b|radiograph/i,
  DX: /\bX-?ray\b|\bXR\b|radiograph/i,
  US: /\bUS\b|ultraso/i,
  NM: /nuclear|\bNM\b/i,
  PT: /\bPET\b/i,
  MG: /mammo/i,
  SM: /patholog|histolog|slide|biopsy/i,
};

const day = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

function accessionOf(index: StudyIndex, st: StudyEntry): string | null {
  return st.accession ?? headerAccessions.get(index)?.get(st.id) ?? null;
}

export function linkReports(index: StudyIndex): ReportLink[] {
  return index.reports.map((report) => {
    const byRef = index.studies.find((st) => report.studyIds.includes(st.id));
    if (byRef) return { report, studyId: byRef.id, basis: "reference" };
    const byUid = index.studies.find((st) => report.studyUids.includes(st.studyInstanceUid));
    if (byUid) return { report, studyId: byUid.id, basis: "uid" };
    const ids = report.identifiers.map((i) => i.value);
    const byAcc = index.studies.find((st) => {
      const a = accessionOf(index, st);
      return a !== null && ids.includes(a);
    });
    if (byAcc) return { report, studyId: byAcc.id, basis: "accession" };
    const d = day(report.effective) ?? day(report.issued);
    if (d) {
      const words = `${report.title ?? ""} ${report.category ?? ""}`;
      const sameDay = index.studies.filter((st) => day(st.started) === d);
      const byModality = sameDay.filter((st) => st.modalities.some((m) => MODALITY_WORDS[m]?.test(words)));
      if (byModality.length === 1) return { report, studyId: byModality[0].id, basis: "date" };
    }
    return { report, studyId: null, basis: null };
  });
}

/** Plain words for how a report was matched to its images. */
export function linkBasisText(basis: LinkBasis | null): string {
  switch (basis) {
    case "reference":
      return "The report names this study.";
    case "uid":
      return "The report names this study by its Study Instance UID.";
    case "accession":
      return "Matched to this study by accession number.";
    case "date":
      return "Matched to this study by date and type of exam. Check that it belongs to these images.";
    default:
      return "The images for this exam are not in this share.";
  }
}
