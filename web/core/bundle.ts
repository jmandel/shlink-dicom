// The ImagingStudy index: a decrypted SHL Bundle (spec/README.md §8) as studies, series and
// instances with their byte offsets in the linked files, plus the Patient and DiagnosticReports.
// The reader module builds it (reader.ts openBundle / parseIndex: crates/shl-dicom-reader); these
// are its types, and the choices the viewer makes on it.
import { linkReports } from "./reports";
import { seriesKind } from "./objects";

const SD = "http://hl7.org/fhir/uv/smart-health-cards-and-links/StructureDefinition/";
export const PROFILE_URL = SD + "dicom-imaging-study";
export const EXT_LINKED_FILE = SD + "linked-file";
export const EXT_INSTANCE_LENGTH = SD + "instance-length";

/** One encrypted file, `{fileId}.bin` (spec/README.md §8.1, §9). One object per fileId. */
export interface FileEntry {
  /** 22-character file id; the file is `{fileId}.bin` next to the Bundle. */
  fileId: string;
  /** 43-character base64url 32-byte encryption key. */
  key: string;
  /** Plaintext length of the file: every instance of every series in it. */
  plaintextLength: number;
  ciphertextLength: number;
  recordCount: number;
}

export interface InstanceEntry {
  uid: string;
  sopClass: string;
  number: number | null;
  /** Byte offset of this Part 10 file in its series' file plaintext. */
  offset: number;
  length: number;
  firstRecord: number;
  lastRecord: number;
}

export interface SeriesEntry {
  uid: string;
  number: number | null;
  modality: string | null;
  description: string | null;
  bodySite: string | null;
  /**
   * Identifies the series within the index: `${file.fileId}@${offset}`. Use it, not the file id,
   * for cache keys and maps (several series share a file).
   */
  id: string;
  /** The encrypted file this series is in. */
  file: FileEntry;
  /** Byte offset of the series' first instance in its file's plaintext. */
  offset: number;
  /** Sum of the series' instance lengths (its DICOM bytes). */
  bytes: number;
  /** First and last records covering the series in its file. */
  firstRecord: number;
  lastRecord: number;
  instances: InstanceEntry[];
}

export interface StudyEntry {
  /** ImagingStudy.id */
  id: string;
  studyInstanceUid: string;
  description: string | null;
  /** ImagingStudy.started (ISO 8601). */
  started: string | null;
  /** Distinct series modalities, in series order. */
  modalities: string[];
  /** ImagingStudy.note texts (for example "partial: 2 of 5 series shared"). */
  notes: string[];
  /** Accession number from ImagingStudy.identifier (type ACSN), when the Bundle carries one. */
  accession: string | null;
  /** The distinct files the study's series are in, in first-use order. */
  files: FileEntry[];
  numberOfSeries: number;
  numberOfInstances: number;
  /** Sum of the series' bytes (the original DICOM bytes). */
  bytes: number;
  series: SeriesEntry[];
}

export interface ReportEntry {
  id: string;
  status: string;
  /** DiagnosticReport.code text or first coding display. */
  title: string | null;
  conclusion: string | null;
  issued: string | null;
  effective: string | null;
  /**
   * ImagingStudy ids this report refers to: DiagnosticReport.imagingStudy references resolved
   * against the Bundle (an entry's fullUrl such as urn:uuid:…, or "ImagingStudy/<id>").
   */
  studyIds: string[];
  /** Study Instance UIDs this report refers to (DiagnosticReport.imagingStudy identifiers). */
  studyUids: string[];
  /** DiagnosticReport.identifier values (accession numbers among them). */
  identifiers: { system: string | null; value: string; accession: boolean }[];
  category: string | null;
  /** Inline presentedForm text (text/plain or text/html stripped of tags), when present. */
  text: string | null;
  /** presentedForm attachments: inline bytes when the Bundle carries them, else a URL. */
  attachments: ReportAttachment[];
  /** The studies it belongs to and why (shl_dicom_core::report_links; web/core/reports.ts). */
  links: { studyId: string; basis: "reference" | "uid" | "accession" | "date" }[];
}

export interface ReportAttachment {
  contentType: string;
  title: string | null;
  size: number | null;
  data: Uint8Array | null;
  url: string | null;
}

export interface PatientEntry {
  /** HumanName.text, else "given family". */
  name: string | null;
  birthDate: string | null;
  id: string | null;
}

export interface StudyIndex {
  lastUpdated: string | null;
  patient: PatientEntry;
  reports: ReportEntry[];
  studies: StudyEntry[];
  /** The Bundle as parsed JSON (read-only use). */
  bundle: any;
}

export class InvalidBundleError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InvalidBundleError";
  }
}

/** Reports linked to a study (see reports.ts for how they are matched). */
export function reportsForStudy(index: StudyIndex, study: StudyEntry): ReportEntry[] {
  return linkReports(index).filter((l) => l.studyId === study.id).map((l) => l.report);
}

const LOCALIZER = /\b(loc|locali[sz]er|scout|survey|surview|topogram|3[- ]?plane|tri[- ]?pilot|pilot|plan(ning)?)\b/i;
const AXIAL = /\b(ax|axial|tra|trans|transverse)\b/i;

/** True when a series looks like a localizer/scout (by description, or a tiny MR/CT series). */
function isLocalizer(s: SeriesEntry): boolean {
  if (s.description && LOCALIZER.test(s.description.replace(/[_]/g, " "))) return true;
  return (s.modality === "MR" || s.modality === "CT") && s.instances.length <= 3 && !s.description;
}

function isAxial(s: SeriesEntry): boolean {
  return !!s.description && AXIAL.test(s.description.replace(/[_]/g, " "));
}

/**
 * The series a study should open on: the largest axial non-localizer series of a cross-sectional
 * study (CT, MR, PT, NM), else the first non-localizer series, else the first series.
 */
export function pickInitialSeries(study: StudyEntry): number {
  const s = study.series;
  // Images first: reports, documents and other objects are opened from the series list.
  const viewable = s.map((x, i) => i).filter((i) => ["image", "slide", "video", "pmap"].includes(seriesKind(s[i].instances.map((x) => x.sopClass))));
  if (!viewable.length) return 0;
  const candidates = viewable.filter((i) => !isLocalizer(s[i]));
  if (!candidates.length) return viewable[0];
  const crossSectional = candidates.filter((i) => ["CT", "MR", "PT", "NM"].includes(s[i].modality ?? ""));
  const axial = crossSectional.filter((i) => isAxial(s[i]));
  if (axial.length) return axial.reduce((best, i) => (s[i].instances.length > s[best].instances.length ? i : best));
  return candidates[0];
}
