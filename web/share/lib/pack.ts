// Packing on the device (PROPOSAL.md §8, §9, §11.1): one random file id and one random 32-byte key
// per study, the study's Part 10 files laid end to end (series by series, in Bundle order) and
// encrypted in 65,520-byte records with AES-256-GCM (nonce = record index), and the FHIR Bundle
// that lists them, with linked-file on each ImagingStudy.
import { b64urlDecode, b64urlEncode } from "../../core/b64";
import { ConcatBytes } from "./bytes";
import { EXT_INSTANCE_LENGTH, EXT_LINKED_FILE, PROFILE_URL } from "../../core/bundle";
import { randomKeyB64 } from "../../core/jwe";
import { RECORD_PLAINTEXT, TAG, recordCount, recordNonce } from "../../core/range";
import type { Collection, Instance, StudyModel } from "./ingest";

const ACSN = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "ACSN" }] };

/** One study's encrypted file. */
export interface PackedFile {
  study: StudyModel;
  /** The study's instances in file order: its series in order, each series' instances in order. */
  instances: Instance[];
  fileId: string;
  key: string;
  plaintextLength: number;
  records: number;
}

/** Draws a file id and a key for each included study (§11.1: one file per study). */
export function planStudyFiles(studies: StudyModel[]): PackedFile[] {
  return studies.map((study) => {
    const instances = study.series.flatMap((s) => s.instances);
    const P = instances.reduce((a, i) => a + i.src.size, 0);
    return {
      study,
      instances,
      fileId: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
      key: randomKeyB64(),
      plaintextLength: P,
      records: recordCount(P),
    };
  });
}

/** The file's length: P + 16·n (§9.2). */
export const ciphertextSize = (p: { plaintextLength: number; records: number }) => p.plaintextLength + TAG * p.records;

/** Records per upload chunk: 8 MiB of ciphertext. */
export const CHUNK_RECORDS = 128;

/**
 * Encrypts records [first, last) of a file (§9.2), reading only their plaintext from the
 * instances' byte sources. Returns that part of the ciphertext.
 */
export async function encryptRecords(p: PackedFile, key: CryptoKey, first: number, last: number): Promise<Uint8Array> {
  const P = p.plaintextLength;
  const a = first * RECORD_PLAINTEXT, b = Math.min(P, last * RECORD_PLAINTEXT);
  const plain = await new ConcatBytes(p.instances.map((i) => i.src)).read(a, b);
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

export function fileKey(p: PackedFile): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64urlDecode(p.key), "AES-GCM", false, ["encrypt"]);
}

/** The whole file in memory, for scripts and small test fixtures. /share streams instead. */
export async function encryptFile(p: PackedFile): Promise<Uint8Array> {
  const key = await fileKey(p);
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
export function buildBundle(col: Collection, packed: PackedFile[], lastUpdated = new Date().toISOString()): any {
  const patient: any = { resourceType: "Patient", id: "p1" };
  if (col.patient.name) {
    const parts = col.patient.name.split(" ");
    patient.name = [{ text: col.patient.name, family: parts.length > 1 ? parts[parts.length - 1] : parts[0], ...(parts.length > 1 ? { given: parts.slice(0, -1) } : {}) }];
  }
  if (col.patient.birthDate) patient.birthDate = col.patient.birthDate;
  if (col.patient.identifier.length) patient.identifier = col.patient.identifier;
  const entry: any[] = [{ fullUrl: "urn:uuid:" + crypto.randomUUID(), resource: patient }];
  let reportN = 0;
  packed.forEach((p, si) => {
    const st = p.study;
    const id = `study-${si + 1}`;
    // Same order as p.instances, so offsets in the file follow the Bundle (§8.1).
    const series = st.series.map((se) => ({
      uid: se.uid,
      ...(se.number != null ? { number: se.number } : {}),
      modality: { system: "http://dicom.nema.org/resources/ontology/DCM", code: se.modality || "OT" },
      ...(se.description ? { description: se.description } : {}),
      numberOfInstances: se.instances.length,
      instance: se.instances.map((inst) => ({
        extension: [{ url: EXT_INSTANCE_LENGTH, valueDecimal: inst.src.size }],
        uid: inst.h.sopInstanceUid,
        sopClass: { system: "urn:ietf:rfc:3986", code: `urn:oid:${inst.h.sopClassUid}` },
        ...(inst.number != null ? { number: inst.number } : {}),
      })),
    }));
    const res: any = {
      resourceType: "ImagingStudy",
      id,
      meta: { profile: [PROFILE_URL] },
      extension: [{ url: EXT_LINKED_FILE, extension: [{ url: "id", valueString: p.fileId }, { url: "key", valueString: p.key }] }],
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
    // For the owner page only (links leave it out): images this device re-encoded without loss.
    const reencoded = p.instances.filter((i) => i.reencoded).length;
    if (reencoded) entry.push({ fullUrl: "urn:uuid:" + crypto.randomUUID(), resource: reencodingProvenance(studyUrl, reencoded, p.instances.length, lastUpdated) });
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

/** Activity text of the owner Bundle's re-encoding note, which the owner page shows as it is. */
export const REENCODED_TEXT = (n: number, of: number) =>
  `${n} of ${of} images were compressed without loss when shared (JPEG Lossless): pixel-identical to the files they came from, not the same bytes.`;

/**
 * A Provenance saying the Share page re-encoded some of a study's images (PROPOSAL.md §11.1). It
 * is in the owner Bundle only; subsetBundle leaves it out of every link's Bundle.
 */
function reencodingProvenance(studyUrl: string, n: number, of: number, recorded: string): any {
  return {
    resourceType: "Provenance",
    target: [{ reference: studyUrl }],
    recorded,
    activity: {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation", code: "TRANSFORM" }],
      text: REENCODED_TEXT(n, of),
    },
    agent: [{ who: { display: "shlink-dicom Share page" } }],
  };
}

/** The owner page's note for a study: its re-encoding Provenance's text, if any. */
export function reencodingNote(owner: any, studyId: string): string | null {
  const url = (owner.entry ?? []).find((e: any) => e.resource?.resourceType === "ImagingStudy" && e.resource.id === studyId)?.fullUrl;
  const prov = (owner.entry ?? []).find((e: any) => e.resource?.resourceType === "Provenance" && e.resource.target?.some((t: any) => t.reference === url));
  return prov?.resource.activity?.text ?? null;
}

const linkedFileId = (el: any): string | undefined =>
  (el?.extension ?? []).find((x: any) => x.url === EXT_LINKED_FILE)?.extension?.find((x: any) => x.url === "id")?.valueString;

/**
 * The file ids an ImagingStudy's series use (each series' own linked-file, else the study's, as
 * core/bundle.ts resolves them), and the study without a study-level linked-file none of its series
 * use, so a link carries no key for a file it does not serve (PROPOSAL.md §8.1).
 */
function studyFiles(study: any): { ids: string[]; study: any } {
  const studyId = linkedFileId(study);
  const ids: string[] = [];
  for (const se of study.series ?? []) {
    const id = linkedFileId(se) ?? studyId;
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (!studyId || ids.includes(studyId)) return { ids, study };
  const { extension, ...rest } = study;
  const others = (extension ?? []).filter((x: any) => x.url !== EXT_LINKED_FILE);
  return { ids, study: others.length ? { ...rest, extension: others } : rest };
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
      const used = studyFiles(r);
      files.push(...used.ids.map((id) => `${id}.bin`));
      entry.push(used.study === r ? e : { ...e, resource: used.study });
    } else if (r?.resourceType === "DiagnosticReport") {
      const refs = (r.imagingStudy ?? []).map((x: any) => String(x.reference ?? ""));
      // A report goes with the studies it names; one that names none goes with every link.
      if (!refs.length || refs.some((ref: string) => keepUrls.has(ref) || keep.has(ref.replace(/^.*ImagingStudy\//, "")))) entry.push(e);
    } else if (r?.resourceType !== "Provenance") entry.push(e);
  }
  return { bundle: { ...owner, meta: { ...(owner.meta ?? {}), lastUpdated: new Date().toISOString() }, entry }, allowedFiles: files };
}
