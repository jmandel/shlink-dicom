// Packing on the device (spec/README.md §8, §9, §11.1): one random file id and one random 32-byte key
// per study, the study's Part 10 files laid end to end (series by series, in Bundle order) and
// encrypted in 65,520-byte records with AES-256-GCM (nonce = record index). The FHIR Bundle that
// lists them, and each link's subset of it, come from the packer's Rust builder (shl-dicom-wasm).
import { b64urlDecode, b64urlEncode } from "../../core/b64";
import { ConcatBytes } from "./bytes";
import { randomKeyB64 } from "../../core/jwe";
import { EXT_LINKED_FILE } from "../../core/bundle";
import { ciphertextLength, RECORD_CIPHERTEXT, RECORD_PLAINTEXT, TAG, recordCount, recordNonce } from "../../core/range";
import { sharePatient, type Collection, type Instance, type StudyModel } from "./ingest";
import { shlWasm } from "./shl-wasm";
import { encodingName } from "./compress";

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
      out.set(new Uint8Array(ct), k * RECORD_CIPHERTEXT);
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
  const out = new Uint8Array(ciphertextLength(p.plaintextLength));
  for (let r = 0; r < p.records; r += CHUNK_RECORDS) {
    out.set(await encryptRecords(p, key, r, Math.min(p.records, r + CHUNK_RECORDS)), r * RECORD_CIPHERTEXT);
  }
  return out;
}

/** Points the owner Bundle's studies and series that link file `oldId` at file `fileId` with `key` instead. */
export function relinkFile(owner: any, oldId: string, fileId: string, key: string) {
  const relink = (el: any) => {
    for (const x of el?.extension ?? []) {
      if (x.url !== EXT_LINKED_FILE) continue;
      const id = x.extension?.find((y: any) => y.url === "id");
      if (id?.valueString !== oldId) continue;
      id.valueString = fileId;
      x.extension.find((y: any) => y.url === "key").valueString = key;
    }
  };
  for (const e of owner.entry ?? []) {
    if (e.resource?.resourceType !== "ImagingStudy") continue;
    relink(e.resource);
    for (const se of e.resource.series ?? []) relink(se);
  }
}


/**
 * The owner Bundle, built by the packer's one builder (shl_dicom_core::bundle::build_fhir_bundle,
 * through shl-dicom-wasm): Patient (refusing studies of two people unless the sharer said they are
 * one, lib/ingest.ts sharePatient), then for each packed study its ImagingStudy (study-1…), a
 * Provenance when this device re-encoded some of its images, and its included reports; then the
 * included reports that name no study. Needs loadShlWasm first.
 */
export function buildBundle(col: Collection, packed: PackedFile[], lastUpdated = new Date().toISOString()): any {
  const p = col.patient;
  // From a FHIR source, its Patient; from DICOM, the packed studies' patient (one person, §11.1).
  let patient: any;
  if (col.patientSource === "fhir") {
    patient = { fhirName: p.humanName ?? (p.name ? { text: p.name } : null), birthDate: p.birthDate, identifiers: p.identifier };
  } else {
    const sp = sharePatient(packed.map((f) => f.study), col.samePatient);
    if ("conflict" in sp) throw new Error(sp.message);
    patient = sp.patient;
  }
  const input = {
    lastUpdated,
    patient,
    // Same order as each file's instances, so offsets in the file follow the Bundle (§8.1).
    studies: packed.map(({ study: st, instances, fileId, key }) => {
      const reencoded = instances.filter((i) => i.reencoded);
      return {
        studyInstanceUid: st.uid,
        description: st.description,
        started: st.started,
        accession: st.accession,
        file: { fileId, keyB64: key },
        series: st.series.map((se) => ({
          uid: se.uid,
          number: se.number,
          modality: se.modality || "OT",
          description: se.description || null,
          instances: se.instances.map((i) => ({ uid: i.h.sopInstanceUid, sopClassUid: i.h.sopClassUid, number: i.number, length: i.src.size })),
        })),
        reports: st.reports.filter((x) => x.include).map((x) => x.resource),
        reencoded: reencoded.length
          ? {
              images: reencoded.length,
              of: instances.length,
              encodings: [...new Set(reencoded.map((i) => encodingName(i.h.transferSyntax) ?? "lossless"))],
              agent: "shlink-dicom Share page",
            }
          : null,
      };
    }),
    looseReports: col.looseReports.filter((x) => x.include).map((x) => x.resource),
  };
  return JSON.parse(shlWasm().build_bundle(JSON.stringify(input)));
}

const uidOf = (identifiers: any[] | undefined) => (identifiers ?? []).find((i: any) => i.system === "urn:dicom:uid")?.value?.replace(/^urn:oid:/, "");

/**
 * Puts what an owner Bundle says the person chose back on a collection read again after a reload
 * (the Share page stores one, from buildBundle, before files compressed on the way are uploaded):
 * each study's description, start and accession, the reports left in (those left out are not in
 * the Bundle), and, for a FHIR source, its Patient.
 */
export function applyChoices(col: Collection, owner: any, patientSource: "dicom" | "fhir") {
  const res = (owner.entry ?? []).map((e: any) => e.resource);
  const pt = res.find((r: any) => r?.resourceType === "Patient");
  if (patientSource === "fhir" && pt) {
    const n = pt.name?.[0];
    col.patientSource = "fhir";
    col.patient = {
      name: n?.text ?? ([...(n?.given ?? []), n?.family].filter(Boolean).join(" ") || null),
      birthDate: pt.birthDate ?? null,
      identifier: pt.identifier ?? [],
      ...(n ? { humanName: n } : {}),
    };
  }
  const byUrl = new Map<string, StudyModel>();
  for (const e of owner.entry ?? []) {
    const r = e.resource;
    if (r?.resourceType !== "ImagingStudy") continue;
    const st = col.studies.get(uidOf(r.identifier) ?? "");
    if (!st) continue;
    byUrl.set(e.fullUrl, st);
    st.description = r.description ?? null;
    st.started = r.started ?? null;
    st.accession = (r.identifier ?? []).find((i: any) => i.type?.coding?.some((c: any) => c.code === "ACSN"))?.value ?? null;
    st.reports = [];
  }
  col.looseReports = [];
  for (const r of res) {
    if (r?.resourceType !== "DiagnosticReport") continue;
    const { id: _id, subject: _s, imagingStudy, ...rest } = r;
    const st = imagingStudy?.length ? byUrl.get(imagingStudy[0].reference) : undefined;
    const item = { resource: rest, include: true, from: "portal" as const };
    if (st) st.reports.push(item);
    else if (!imagingStudy?.length) col.looseReports.push(item);
  }
}

/** The owner page's note for a study: its re-encoding Provenance's text, if any. */
export function reencodingNote(owner: any, studyId: string): string | null {
  const url = (owner.entry ?? []).find((e: any) => e.resource?.resourceType === "ImagingStudy" && e.resource.id === studyId)?.fullUrl;
  const prov = (owner.entry ?? []).find((e: any) => e.resource?.resourceType === "Provenance" && e.resource.target?.some((t: any) => t.reference === url));
  return prov?.resource.activity?.text ?? null;
}

/**
 * A link's Bundle (shl_dicom_core::bundle::subset_bundle, through shl-dicom-wasm): the owner
 * Bundle cut down to whole studies (by ImagingStudy id) with their reports, plus the reports that
 * name no study which the sharer picked (by DiagnosticReport id). Returns the Bundle and the
 * `{fileId}.bin` names it needs. Needs loadShlWasm first.
 */
export function subsetBundle(owner: any, studyIds: string[], looseReportIds: string[] = []): { bundle: any; allowedFiles: string[] } {
  const sel = JSON.stringify({ studies: studyIds, looseReports: looseReportIds });
  return JSON.parse(shlWasm().subset_bundle(JSON.stringify(owner), sel, new Date().toISOString()));
}

/** DiagnosticReports in a Bundle that name no study: the ones a link carries only when picked. */
export function looseReports(bundle: any): any[] {
  return (bundle.entry ?? []).map((e: any) => e.resource).filter((r: any) => r?.resourceType === "DiagnosticReport" && !(r.imagingStudy ?? []).length);
}
