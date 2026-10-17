// Linking FHIR DiagnosticReports to the imaging studies in a share. The rule is the Rust one
// (crates/shl-dicom-core/src/report_links.rs): the reader's index gives each report its links, in
// this order:
//   1. "reference": DiagnosticReport.imagingStudy.reference resolves to studies in this Bundle; a
//      combined report belongs to each study it names;
//   2. "uid": DiagnosticReport.imagingStudy.identifier names studies by Study Instance UID;
//   3. "accession": a report identifier equals the accession number of exactly one study (from
//      the Bundle, or from an image header once one has been read: relinkWithAccessions);
//   4. "date": the same date, and the report's code or category names the modality of exactly
//      one study. This is a guess, and the viewer says so.
// A report that matches no study stays unlinked and is listed on its own.
import type { ReportEntry, StudyIndex } from "./bundle";
import { relinkReports } from "./reader";

export type LinkBasis = "reference" | "uid" | "accession" | "date";

/** One report in one study (a combined report gives one per study), or an unlinked report. */
export interface ReportLink {
  report: ReportEntry;
  studyId: string | null;
  basis: LinkBasis | null;
}

/** Each report's links, learnt again after accession numbers were read from image headers. */
const relinked = new WeakMap<StudyIndex, ReportEntry["links"][]>();

export function linkReports(index: StudyIndex): ReportLink[] {
  const again = relinked.get(index);
  return index.reports.flatMap((report, i) => {
    const links = again?.[i] ?? report.links;
    return links.length ? links.map((l) => ({ report, studyId: l.studyId, basis: l.basis })) : [{ report, studyId: null, basis: null }];
  });
}

/**
 * Links the reports again with accession numbers read from image headers (0008,0050), by
 * ImagingStudy id, for studies whose ImagingStudy has none. Returns whether any link changed.
 */
export async function relinkWithAccessions(index: StudyIndex, accessions: Map<string, string>): Promise<boolean> {
  const studies = index.studies.map((st) => ({
    id: st.id,
    studyInstanceUid: st.studyInstanceUid,
    accession: st.accession ?? accessions.get(st.id) ?? null,
    started: st.started,
    modalities: st.modalities,
  }));
  // References are already resolved to study ids; "ImagingStudy/<id>" resolves to the same.
  const reports = index.reports.map((r) => ({
    references: r.studyIds.map((id) => `ImagingStudy/${id}`),
    studyUids: r.studyUids,
    identifiers: r.identifiers.map((i) => i.value),
    date: r.effective ?? r.issued,
    words: [r.title, r.category].filter(Boolean).join(" "),
  }));
  const before = JSON.stringify(linkReports(index).map((l) => [l.studyId, l.basis]));
  relinked.set(index, await relinkReports({ studies, reports }));
  return JSON.stringify(linkReports(index).map((l) => [l.studyId, l.basis])) !== before;
}

/** The links the Share page takes: every one but a match by date alone (a guess it offers unticked). */
export function linksTakenWhenSharing(index: StudyIndex): ReportLink[] {
  return linkReports(index).filter((l) => l.studyId !== null && l.basis !== "date");
}

/** Plain words for how a report was matched to its images; empty when the report names the study. */
export function linkBasisText(basis: LinkBasis | null): string {
  switch (basis) {
    case "reference":
    case "uid":
      return "";
    case "accession":
      return "Matched to this study by accession number.";
    case "date":
      return "Matched to this study by date and type of exam. Check that it belongs to these images.";
    default:
      return "The images for this exam are not in this share.";
  }
}
