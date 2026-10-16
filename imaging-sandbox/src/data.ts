// Loads the dataset built by scripts/build-data.ts (manifest.json, the
// rewritten DICOM files and the report attachments) and indexes it as
// patients, studies, series and instances. WADO-RS serves the files'
// bytes unchanged.

import { join } from "node:path";
import { existsSync } from "node:fs";
import { parseDicom, str, int, type DicomElement } from "./dicom.ts";

export interface Instance {
  sopInstanceUID: string;
  sopClassUID: string;
  number?: number;
  transferSyntaxUID: string;
  path: string;
  bytes: Uint8Array;
  header: DicomElement[];
  // Losslessly compressed copies (scripts/make-variants.py), by transfer
  // syntax UID; served from disk.
  variants: Map<string, { file: string; size: number }>;
}

export interface Series {
  uid: string;
  number?: number;
  modality: string;
  description?: string;
  bodyPart?: string;
  instances: Instance[];
}

export interface Attachment {
  id: string; // Binary id
  contentType: string;
  title: string;
  size: number;
  sha1: string; // base64, as FHIR R4 Attachment.hash
  bytes: Uint8Array;
}

export interface Report {
  id: string;
  category: { system: string; code: string; display: string };
  code: { system: string; code: string; display: string };
  title: string;
  conclusion: string;
  attachments: Attachment[];
}

export interface Study {
  id: string;
  uid: string;
  patientId: string;
  accession: string;
  description?: string;
  started?: string; // FHIR dateTime
  modalities: string[];
  series: Series[];
  lastUpdated: string;
  bytes: number;
  report: Report;
  clinical?: StudyClinical;
  facility?: string; // Organization id of the facility that performed the study
  attribution?: string; // image source and license, for studies from public collections
}

export interface StudyClinical { encounter: string; orderedBy: string; readBy: string; orderedAt: string; signed: string; priority: string; reason: string }

export interface ClinicalContext {
  organizations: { id: string; name: string; address: string[]; phone: string }[];
  practitioners: { id: string; given: string[]; family: string; suffix?: string; role: string; organization: string }[];
  encounters: { id: string; class: { code: string; display: string }; type: string; start: string; end: string; organization: string; location: string; reason: string; practitioner: string }[];
}

export interface DemoPatient {
  id: string;
  family: string;
  given: string[];
  birthDate?: string;
  gender?: string;
  mrn?: string;
  synthetic?: boolean;
}

export interface Store {
  patients: Map<string, DemoPatient>;
  studies: Map<string, Study>; // by Study Instance UID
  studiesById: Map<string, Study>;
  binaries: Map<string, { attachment: Attachment; study: Study }>;
  clinical: ClinicalContext;
}

// Data in the sandbox changes only when the dataset is rebuilt; this fixed
// instant is used as meta.lastUpdated so responses are reproducible.
export const DATA_LAST_UPDATED = "2026-10-15T00:00:00Z";

export async function loadStore(datasetDir: string, testPatientsFile: string, variantsDir?: string): Promise<Store> {
  // Compressed copies, keyed by the dataset path of their source.
  const variantsByPath = new Map<string, Map<string, { file: string; size: number }>>();
  const vm = variantsDir ? join(variantsDir, "manifest.json") : "";
  if (vm && existsSync(vm)) {
    const v = JSON.parse(await Bun.file(vm).text());
    for (const e of v.instances) {
      const m = new Map<string, { file: string; size: number }>();
      for (const x of e.variants) if (x.path) m.set(x.ts, { file: join(variantsDir!, x.path), size: x.size });
      variantsByPath.set(e.source, Object.assign(m, { sourceSha256: e.sourceSha256 as string }));
    }
  }
  const manifestPath = join(datasetDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath} not found: run bun scripts/build-data.ts first`);
  const manifest = JSON.parse(await Bun.file(manifestPath).text());
  const patients = new Map<string, DemoPatient>();
  const studies = new Map<string, Study>();
  const studiesById = new Map<string, Study>();
  const binaries = new Map<string, { attachment: Attachment; study: Study }>();

  const p = manifest.patient;
  patients.set(p.id, { id: p.id, family: p.family, given: p.given, birthDate: p.birthDate, gender: p.gender, mrn: p.mrn });
  if (existsSync(testPatientsFile)) {
    for (const t of JSON.parse(await Bun.file(testPatientsFile).text()).patients) patients.set(t.id, { ...t, synthetic: true });
  }

  for (const m of manifest.studies) {
    const study: Study = {
      id: m.id,
      uid: m.studyInstanceUID,
      patientId: p.id,
      accession: m.accession,
      // A time needs a UTC offset in FHIR; without a known offset, the date only.
      started: m.utcOffset && m.studyTime ? `${m.studyDate}T${m.studyTime}${m.utcOffset}` : m.studyDate,
      modalities: [],
      series: [],
      lastUpdated: DATA_LAST_UPDATED,
      bytes: 0,
      attribution: m.attribution,
      clinical: m.clinical,
      report: {
        id: `report-${m.id}`,
        category: m.report.category ?? { system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "RAD", display: "Radiology" },
        code: m.report.code, title: m.report.title, conclusion: m.report.conclusion, attachments: [] },
    };
    for (const f of m.files) {
      const bytes = new Uint8Array(await Bun.file(join(datasetDir, f.path)).arrayBuffer());
      const parsed = parseDicom(bytes);
      const d = parsed.dataset;
      if (str(d, 0x0020000d) !== study.uid) throw new Error(`${f.path}: Study Instance UID does not match the manifest`);
      study.description ??= str(d, 0x00081030);
      const seriesUID = str(d, 0x0020000e)!;
      let series = study.series.find((s) => s.uid === seriesUID);
      if (!series) {
        series = { uid: seriesUID, number: int(d, 0x00200011), modality: str(d, 0x00080060) ?? "OT", description: str(d, 0x0008103e), bodyPart: str(d, 0x00180015), instances: [] };
        study.series.push(series);
        if (!study.modalities.includes(series.modality)) study.modalities.push(series.modality);
      }
      series.instances.push({
        sopInstanceUID: str(d, 0x00080018)!,
        sopClassUID: str(d, 0x00080016) ?? str(parsed.meta, 0x00020002)!,
        number: int(d, 0x00200013),
        transferSyntaxUID: parsed.transferSyntaxUID,
        path: f.path,
        bytes,
        header: d,
        // Copies made from a different version of this file are ignored.
        variants: (() => {
          const v = variantsByPath.get(f.path) as (Map<string, { file: string; size: number }> & { sourceSha256?: string }) | undefined;
          if (!v || v.sourceSha256 !== new Bun.CryptoHasher("sha256").update(bytes).digest("hex")) return new Map();
          return v;
        })(),
      });
      study.bytes += bytes.byteLength;
    }
    study.series.sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.uid.localeCompare(b.uid));
    for (const s of study.series) s.instances.sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.sopInstanceUID.localeCompare(b.sopInstanceUID));
    for (const a of m.report.attachments) {
      const ext = a.contentType === "application/pdf" ? "pdf" : "txt";
      const att: Attachment = {
        id: `${study.report.id}-${ext}`,
        contentType: a.contentType,
        title: `${study.report.title} (sample report, ${ext === "pdf" ? "PDF" : "text"})`,
        size: a.size,
        sha1: a.sha1,
        bytes: new Uint8Array(await Bun.file(join(datasetDir, a.path)).arrayBuffer()),
      };
      study.report.attachments.push(att);
      binaries.set(att.id, { attachment: att, study });
    }
    studies.set(study.uid, study);
    studiesById.set(study.id, study);
  }
  const clinical: ClinicalContext = manifest.clinical ?? { organizations: [], practitioners: [], encounters: [] };
  for (const st of studies.values()) st.facility = clinical.encounters.find((e) => e.id === st.clinical?.encounter)?.organization;
  return { patients, studies, studiesById, binaries, clinical };
}

export function studiesForPatient(store: Store, patientId: string): Study[] {
  return [...store.studies.values()].filter((s) => s.patientId === patientId);
}
