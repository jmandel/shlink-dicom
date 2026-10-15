// The ImagingStudy index: reads a decrypted SHL Bundle (PROPOSAL.md §8) into studies, series and
// instances with their byte offsets in the series files, plus the Patient and DiagnosticReports.
import { ciphertextLength, recordCount, RECORD_PLAINTEXT } from "./range";

export const PROFILE_URL = "https://example.org/shl-dicom/v1";
export const EXT_SERIES_FILE = "https://example.org/shl-dicom/series-file";
export const EXT_LENGTH = "https://example.org/shl-dicom/length";

export interface InstanceEntry {
  uid: string;
  sopClass: string;
  number: number | null;
  /** Byte offset of this Part 10 file in the series plaintext. */
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
  /** 22-character series file id; the file is `{fileId}.bin` next to the Bundle. */
  fileId: string;
  /** 43-character base64url series key. */
  key: string;
  plaintextLength: number;
  ciphertextLength: number;
  recordCount: number;
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
  numberOfSeries: number;
  numberOfInstances: number;
  /** Sum of the series' plaintext lengths (the original DICOM bytes). */
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
  /** ImagingStudy ids this report refers to (DiagnosticReport.imagingStudy). */
  studyIds: string[];
  /** Inline presentedForm text (text/plain or text/html stripped of tags), when present. */
  text: string | null;
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

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function codeText(cc: any): string | null {
  return str(cc?.text) ?? str(cc?.coding?.[0]?.display) ?? str(cc?.coding?.[0]?.code);
}

function decodeAttachmentText(att: any): string | null {
  if (!att?.data || typeof att.data !== "string") return null;
  const ct = String(att.contentType ?? "");
  if (!ct.startsWith("text/")) return null;
  try {
    const bin = atob(att.data);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    let t = new TextDecoder().decode(bytes);
    if (ct.startsWith("text/html")) t = t.replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n");
    return t.trim() || null;
  } catch {
    return null;
  }
}

function parseSeries(se: any): SeriesEntry | null {
  const ext = (se.extension ?? []).find((e: any) => e?.url === EXT_SERIES_FILE);
  if (!ext) return null;
  const sub = (name: string) => str((ext.extension ?? []).find((e: any) => e?.url === name)?.valueString);
  const fileId = sub("id");
  const key = sub("key");
  if (!fileId || !key) throw new InvalidBundleError("series-file extension without id or key");
  if (!/^[A-Za-z0-9_-]{22}$/.test(fileId)) throw new InvalidBundleError(`bad series file id ${fileId}`);
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new InvalidBundleError("bad series key");
  const uid = str(se.uid);
  if (!uid) throw new InvalidBundleError("series without uid");
  const instances: InstanceEntry[] = [];
  let offset = 0;
  for (const inst of se.instance ?? []) {
    const lenExt = (inst.extension ?? []).find((e: any) => e?.url === EXT_LENGTH);
    const length = Number(lenExt?.valueDecimal);
    if (!Number.isSafeInteger(length) || length <= 0) throw new InvalidBundleError("instance without a valid length");
    const iuid = str(inst.uid);
    if (!iuid) throw new InvalidBundleError("instance without uid");
    instances.push({
      uid: iuid,
      sopClass: (str(inst.sopClass?.code) ?? "").replace(/^urn:oid:/, ""),
      number: typeof inst.number === "number" ? inst.number : null,
      offset,
      length,
      firstRecord: Math.floor(offset / RECORD_PLAINTEXT),
      lastRecord: Math.floor((offset + length - 1) / RECORD_PLAINTEXT),
    });
    offset += length;
  }
  if (!instances.length) throw new InvalidBundleError(`series ${uid} lists no instances`);
  return {
    uid,
    number: typeof se.number === "number" ? se.number : null,
    modality: str(se.modality?.code),
    description: str(se.description),
    bodySite: str(se.bodySite?.display) ?? str(se.bodySite?.code),
    fileId,
    key,
    plaintextLength: offset,
    ciphertextLength: ciphertextLength(offset),
    recordCount: recordCount(offset),
    instances,
  };
}

/** Parses Bundle JSON (string, bytes or object). Throws InvalidBundleError. */
export function parseStudyIndex(input: string | Uint8Array | object): StudyIndex {
  let root: any;
  try {
    root =
      typeof input === "string"
        ? JSON.parse(input)
        : input instanceof Uint8Array
          ? JSON.parse(new TextDecoder().decode(input))
          : input;
  } catch {
    throw new InvalidBundleError("the shared file is not JSON");
  }
  if (root?.resourceType !== "Bundle" || !Array.isArray(root.entry)) {
    throw new InvalidBundleError("the shared file is not a FHIR Bundle");
  }
  const patient: PatientEntry = { name: null, birthDate: null, id: null };
  const reports: ReportEntry[] = [];
  const studies: StudyEntry[] = [];
  for (const entry of root.entry) {
    const r = entry?.resource;
    if (!r) continue;
    if (r.resourceType === "Patient" && !patient.name) {
      const n = r.name?.[0];
      patient.name = str(n?.text) ?? (([...(n?.given ?? []), n?.family].filter(Boolean).join(" ").trim() || null));
      patient.birthDate = str(r.birthDate);
      patient.id = str(r.identifier?.[0]?.value);
    } else if (r.resourceType === "DiagnosticReport") {
      const text = (r.presentedForm ?? []).map(decodeAttachmentText).find(Boolean) ?? null;
      reports.push({
        id: str(r.id) ?? `report-${reports.length + 1}`,
        status: str(r.status) ?? "unknown",
        title: codeText(r.code),
        conclusion: str(r.conclusion),
        issued: str(r.issued),
        effective: str(r.effectiveDateTime) ?? str(r.effectivePeriod?.start),
        studyIds: (r.imagingStudy ?? [])
          .map((ref: any) => String(ref?.reference ?? "").replace(/^.*ImagingStudy\//, ""))
          .filter(Boolean),
        text,
      });
    } else if (r.resourceType === "ImagingStudy") {
      const series = (r.series ?? []).map(parseSeries).filter(Boolean) as SeriesEntry[];
      if (!series.length) continue;
      const ident = (r.identifier ?? []).find((i: any) => i?.system === "urn:dicom:uid") ?? r.identifier?.[0];
      const modalities: string[] = [];
      for (const s of series) if (s.modality && !modalities.includes(s.modality)) modalities.push(s.modality);
      studies.push({
        id: str(r.id) ?? `study-${studies.length + 1}`,
        studyInstanceUid: (str(ident?.value) ?? str(r.id) ?? "").replace(/^urn:oid:/, ""),
        description: str(r.description),
        started: str(r.started),
        modalities,
        notes: (r.note ?? []).map((n: any) => str(n?.text)).filter(Boolean) as string[],
        numberOfSeries: series.length,
        numberOfInstances: series.reduce((a, s) => a + s.instances.length, 0),
        bytes: series.reduce((a, s) => a + s.plaintextLength, 0),
        series,
      });
    }
  }
  return { lastUpdated: str(root.meta?.lastUpdated), patient, reports, studies, bundle: root };
}

/** Reports that refer to a study (by ImagingStudy.id). */
export function reportsForStudy(index: StudyIndex, study: StudyEntry): ReportEntry[] {
  return index.reports.filter((r) => r.studyIds.includes(study.id));
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
  const candidates = s.map((x, i) => i).filter((i) => !isLocalizer(s[i]));
  if (!candidates.length) return 0;
  const crossSectional = candidates.filter((i) => ["CT", "MR", "PT", "NM"].includes(s[i].modality ?? ""));
  const axial = crossSectional.filter((i) => isAxial(s[i]));
  if (axial.length) return axial.reduce((best, i) => (s[i].instances.length > s[best].instances.length ? i : best));
  return candidates[0];
}
