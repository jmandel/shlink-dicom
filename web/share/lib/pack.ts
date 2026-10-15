// Packing on the device (PROPOSAL.md §8, §9, §11.1): one random file id and one random 32-byte key
// per series, the series' Part 10 files laid end to end and encrypted in 65,520-byte records with
// AES-256-GCM (nonce = record index), and the FHIR Bundle that lists them.
import { b64urlDecode, b64urlEncode } from "../../core/b64";
import { ConcatBytes } from "./bytes";
import { EXT_LENGTH, EXT_SERIES_FILE, PROFILE_URL } from "../../core/bundle";
import { randomKeyB64 } from "../../core/jwe";
import { RECORD_PLAINTEXT, TAG, recordCount, recordNonce } from "../../core/range";
import type { Collection, SeriesModel, StudyModel } from "./ingest";

const ACSN = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "ACSN" }] };

export interface PackedSeries {
  study: StudyModel;
  series: SeriesModel;
  fileId: string;
  key: string;
  plaintextLength: number;
  records: number;
}

/** Draws a file id and a key for each series of the included studies. */
export function planSeriesFiles(studies: StudyModel[]): PackedSeries[] {
  const out: PackedSeries[] = [];
  for (const study of studies) {
    for (const series of study.series) {
      const P = series.instances.reduce((a, i) => a + i.src.size, 0);
      out.push({
        study,
        series,
        fileId: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
        key: randomKeyB64(),
        plaintextLength: P,
        records: recordCount(P),
      });
    }
  }
  return out;
}

/** The series file's length: P + 16·n (§9.2). */
export const ciphertextSize = (p: { plaintextLength: number; records: number }) => p.plaintextLength + TAG * p.records;

/** Records per upload chunk: 8 MiB of ciphertext. */
export const CHUNK_RECORDS = 128;

/**
 * Encrypts records [first, last) of a series file (§9.2), reading only their plaintext from the
 * instances' byte sources. Returns that part of the ciphertext.
 */
export async function encryptRecords(p: PackedSeries, key: CryptoKey, first: number, last: number): Promise<Uint8Array> {
  const P = p.plaintextLength;
  const a = first * RECORD_PLAINTEXT, b = Math.min(P, last * RECORD_PLAINTEXT);
  const plain = await new ConcatBytes(p.series.instances.map((i) => i.src)).read(a, b);
  const out = new Uint8Array(b - a + TAG * (last - first));
  await Promise.all(
    Array.from({ length: last - first }, async (_, k) => {
      const i = first + k;
      const chunk = plain.subarray(k * RECORD_PLAINTEXT, Math.min(plain.length, (k + 1) * RECORD_PLAINTEXT));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: recordNonce(i), tagLength: 128 }, key, chunk);
      out.set(new Uint8Array(ct), k * (RECORD_PLAINTEXT + TAG));
    }),
  );
  return out;
}

export function seriesKey(p: PackedSeries): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64urlDecode(p.key), "AES-GCM", false, ["encrypt"]);
}

/** The whole series file in memory, for scripts and small test fixtures. /share streams instead. */
export async function encryptSeries(p: PackedSeries): Promise<Uint8Array> {
  const key = await seriesKey(p);
  const out = new Uint8Array(ciphertextSize(p));
  for (let r = 0; r < p.records; r += CHUNK_RECORDS) {
    out.set(await encryptRecords(p, key, r, Math.min(p.records, r + CHUNK_RECORDS)), r * (RECORD_PLAINTEXT + TAG));
  }
  return out;
}

const DR_KEEP = ["status", "category", "code", "effectiveDateTime", "effectivePeriod", "issued", "conclusion", "conclusionCode", "presentedForm", "text", "identifier"];

/**
 * The owner Bundle: Patient, one ImagingStudy per included study (ids study-1…), and the studies'
 * DiagnosticReports. Each report's imagingStudy points at its packed ImagingStudy in this Bundle
 * (by fullUrl) and names the study by UID; each ImagingStudy carries the Study Instance UID and the
 * accession number, so a report can be matched either way.
 */
export function buildBundle(col: Collection, packed: PackedSeries[], lastUpdated = new Date().toISOString()): any {
  const patient: any = { resourceType: "Patient", id: "p1" };
  if (col.patient.name) {
    const parts = col.patient.name.split(" ");
    patient.name = [{ text: col.patient.name, family: parts.length > 1 ? parts[parts.length - 1] : parts[0], ...(parts.length > 1 ? { given: parts.slice(0, -1) } : {}) }];
  }
  if (col.patient.birthDate) patient.birthDate = col.patient.birthDate;
  if (col.patient.identifier.length) patient.identifier = col.patient.identifier;
  const entry: any[] = [{ fullUrl: "urn:uuid:" + crypto.randomUUID(), resource: patient }];
  const studies: StudyModel[] = [];
  for (const p of packed) if (!studies.includes(p.study)) studies.push(p.study);
  let reportN = 0;
  studies.forEach((st, si) => {
    const id = `study-${si + 1}`;
    const series = packed.filter((p) => p.study === st).map((p) => ({
      extension: [{ url: EXT_SERIES_FILE, extension: [{ url: "id", valueString: p.fileId }, { url: "key", valueString: p.key }] }],
      uid: p.series.uid,
      ...(p.series.number != null ? { number: p.series.number } : {}),
      modality: { system: "http://dicom.nema.org/resources/ontology/DCM", code: p.series.modality || "OT" },
      ...(p.series.description ? { description: p.series.description } : {}),
      numberOfInstances: p.series.instances.length,
      instance: p.series.instances.map((inst) => ({
        extension: [{ url: EXT_LENGTH, valueDecimal: inst.src.size }],
        uid: inst.h.sopInstanceUid,
        sopClass: { system: "urn:ietf:rfc:3986", code: `urn:oid:${inst.h.sopClassUid}` },
        ...(inst.number != null ? { number: inst.number } : {}),
      })),
    }));
    const res: any = {
      resourceType: "ImagingStudy",
      id,
      meta: { profile: [PROFILE_URL] },
      status: "available",
      identifier: [
        { system: "urn:dicom:uid", value: `urn:oid:${st.uid}` },
        ...(st.accession ? [{ type: ACSN, value: st.accession }] : []),
      ],
      subject: { reference: "Patient/p1" },
      ...(st.started ? { started: st.started } : {}),
      numberOfSeries: series.length,
      numberOfInstances: series.reduce((a, s) => a + s.numberOfInstances, 0),
      ...(st.description ? { description: st.description } : {}),
      series,
    };
    const studyUrl = "urn:uuid:" + crypto.randomUUID();
    entry.push({ fullUrl: studyUrl, resource: res });
    for (const { resource: r } of st.reports.filter((x) => x.include)) {
      const dr: any = { resourceType: "DiagnosticReport", id: `report-${++reportN}` };
      for (const k of DR_KEEP) if (r[k] !== undefined) dr[k] = r[k];
      dr.subject = { reference: "Patient/p1" };
      dr.imagingStudy = [{ reference: studyUrl, identifier: { system: "urn:dicom:uid", value: `urn:oid:${st.uid}` } }];
      entry.push({ fullUrl: "urn:uuid:" + crypto.randomUUID(), resource: dr });
    }
  });
  // Reports that name no study, when the person included them: no imagingStudy.
  for (const { resource: r } of col.looseReports.filter((x) => x.include)) {
    const dr: any = { resourceType: "DiagnosticReport", id: `report-${++reportN}` };
    for (const k of DR_KEEP) if (r[k] !== undefined) dr[k] = r[k];
    dr.subject = { reference: "Patient/p1" };
    entry.push({ fullUrl: "urn:uuid:" + crypto.randomUUID(), resource: dr });
  }
  return { resourceType: "Bundle", meta: { lastUpdated }, type: "collection", entry };
}

/** Series file ids of an ImagingStudy resource. */
function studyFileIds(study: any): string[] {
  const out: string[] = [];
  for (const se of study.series ?? []) {
    const ext = (se.extension ?? []).find((x: any) => x.url === EXT_SERIES_FILE);
    const id = ext?.extension?.find((x: any) => x.url === "id")?.valueString;
    if (id) out.push(id);
  }
  return out;
}

/**
 * A link's Bundle: the owner Bundle cut down to whole studies (by ImagingStudy id), with the
 * reports that refer to them. Returns the Bundle and the `{fileId}.bin` names it needs.
 */
export function subsetBundle(owner: any, studyIds: string[]): { bundle: any; allowedFiles: string[] } {
  const keep = new Set(studyIds);
  const keepUrls = new Set(
    (owner.entry ?? []).filter((e: any) => e.resource?.resourceType === "ImagingStudy" && keep.has(e.resource.id)).map((e: any) => e.fullUrl),
  );
  const entry: any[] = [];
  const files: string[] = [];
  for (const e of owner.entry ?? []) {
    const r = e.resource;
    if (r?.resourceType === "ImagingStudy") {
      if (!keep.has(r.id)) continue;
      files.push(...studyFileIds(r).map((id) => `${id}.bin`));
      entry.push(e);
    } else if (r?.resourceType === "DiagnosticReport") {
      const refs = (r.imagingStudy ?? []).map((x: any) => String(x.reference ?? ""));
      // A report goes with the studies it names; one that names none goes with every link.
      if (!refs.length || refs.some((ref: string) => keepUrls.has(ref) || keep.has(ref.replace(/^.*ImagingStudy\//, "")))) entry.push(e);
    } else entry.push(e);
  }
  return { bundle: { ...owner, meta: { ...(owner.meta ?? {}), lastUpdated: new Date().toISOString() }, entry }, allowedFiles: files };
}
