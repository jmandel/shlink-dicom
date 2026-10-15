// Reading imaging on the device: archives (ZIP, TAR, TGZ), loose DICOM files and folders, and
// instances handed over by the portal and link sources. Everything ends up as Part 10 files grouped
// into studies and series (PROPOSAL.md §11.1 steps 1–4).
import { readDicomHeader, type DicomHeader } from "../../core/dicom-header";
import { formatPersonName, modalityName } from "../../core/format";

export interface Instance {
  name: string;
  bytes: Uint8Array;
  h: DicomHeader;
  number: number | null;
}

export interface SeriesModel {
  uid: string;
  number: number | null;
  modality: string;
  description: string;
  instances: Instance[];
  bytes: number;
  transferSyntaxes: Set<string>;
}

export interface PatientInfo {
  name: string | null;
  birthDate: string | null;
  identifier: { system?: string; value: string }[];
}

export interface StudyModel {
  uid: string;
  description: string | null;
  /** ISO date or dateTime for ImagingStudy.started, from the source (DICOM StudyDate or the portal). */
  started: string | null;
  series: SeriesModel[];
  include: boolean;
  /** FHIR DiagnosticReport resources for this study (portal or link sources), attachments inline. */
  reports: any[];
}

export interface Skipped {
  name: string;
  reason: string;
}

export const DICOMDIR_SOP = "1.2.840.10008.1.3.10";

/** Collects instances as they are found; counts drive the live "Found …" line. */
export class Collection {
  studies = new Map<string, StudyModel>();
  skipped: Skipped[] = [];
  duplicates = 0;
  instanceCount = 0;
  bytes = 0;
  patient: PatientInfo = { name: null, birthDate: null, identifier: [] };
  /** Where the patient details came from: "dicom" until a FHIR source sets them. */
  patientSource: "dicom" | "fhir" = "dicom";
  private seen = new Set<string>();

  get seriesCount() {
    let n = 0;
    for (const s of this.studies.values()) n += s.series.length;
    return n;
  }

  list(): StudyModel[] {
    return [...this.studies.values()];
  }

  /** Adds one file; DICOMDIR and non-DICOM files are skipped and recorded. */
  add(name: string, bytes: Uint8Array) {
    const base = name.split(/[\\/]/).pop() ?? name;
    if (base.toUpperCase() === "DICOMDIR") return this.skip(name, "DICOMDIR (an index, not an image)");
    if (bytes.length < 132 || bytes[128] !== 0x44 || bytes[129] !== 0x49 || bytes[130] !== 0x43 || bytes[131] !== 0x4d) {
      if (/^\./.test(base) || /\.(txt|htm|html|inf|exe|ini|pdf|xml|jpg|png|js|css|ico|dll)$/i.test(base)) return this.skip(name, "not a DICOM file");
      return this.skip(name, "not a DICOM Part 10 file");
    }
    let h: DicomHeader;
    try {
      h = readDicomHeader(bytes);
    } catch {
      return this.skip(name, "unreadable DICOM header");
    }
    if (h.sopClassUid === DICOMDIR_SOP) return this.skip(name, "DICOMDIR (an index, not an image)");
    if (!h.sopInstanceUid) return this.skip(name, "no SOP Instance UID");
    if (!h.studyInstanceUid || !h.seriesInstanceUid) return this.skip(name, "no Study or Series Instance UID");
    if (this.seen.has(h.sopInstanceUid)) {
      this.duplicates++;
      return;
    }
    this.seen.add(h.sopInstanceUid);
    let st = this.studies.get(h.studyInstanceUid);
    if (!st) {
      st = {
        uid: h.studyInstanceUid,
        description: h.studyDescription || null,
        started: dicomDate(h.studyDate, h.studyTime),
        series: [],
        include: true,
        reports: [],
      };
      this.studies.set(h.studyInstanceUid, st);
    }
    let se = st.series.find((s) => s.uid === h.seriesInstanceUid);
    if (!se) {
      se = {
        uid: h.seriesInstanceUid,
        number: toInt(h.seriesNumber),
        modality: h.modality || "OT",
        description: h.seriesDescription,
        instances: [],
        bytes: 0,
        transferSyntaxes: new Set(),
      };
      st.series.push(se);
    }
    se.instances.push({ name, bytes, h, number: toInt(h.instanceNumber) });
    se.bytes += bytes.length;
    se.transferSyntaxes.add(h.transferSyntax);
    this.instanceCount++;
    this.bytes += bytes.length;
    if (this.patientSource === "dicom" && !this.patient.name && h.patientName) {
      this.patient = {
        name: formatPersonName(h.patientName) || null,
        birthDate: dicomDate(h.patientBirthDate, ""),
        identifier: h.patientId ? [{ value: h.patientId }] : [],
      };
    }
  }

  skip(name: string, reason: string) {
    this.skipped.push({ name, reason });
  }

  /** Sorts series by number and instances by Instance Number, then SOP Instance UID (§11.1 step 4). */
  finish() {
    for (const st of this.studies.values()) {
      st.series.sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.uid.localeCompare(b.uid));
      for (const se of st.series) {
        se.instances.sort(
          (a, b) => (a.number ?? 2 ** 31) - (b.number ?? 2 ** 31) || a.h.sopInstanceUid.localeCompare(b.h.sopInstanceUid),
        );
      }
    }
  }
}

function toInt(s: string): number | null {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/** DICOM DA (+TM) to an ISO date ("2020-07-29"); null when absent. */
export function dicomDate(da: string, _tm: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(da.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ------------------------------------------------------------------------------------- display

const TS_NAMES: Record<string, string> = {
  "1.2.840.10008.1.2": "uncompressed",
  "1.2.840.10008.1.2.1": "uncompressed",
  "1.2.840.10008.1.2.2": "uncompressed",
  "1.2.840.10008.1.2.1.99": "deflated",
  "1.2.840.10008.1.2.5": "RLE",
  "1.2.840.10008.1.2.4.50": "JPEG",
  "1.2.840.10008.1.2.4.51": "JPEG",
  "1.2.840.10008.1.2.4.57": "JPEG lossless",
  "1.2.840.10008.1.2.4.70": "JPEG lossless",
  "1.2.840.10008.1.2.4.80": "JPEG-LS",
  "1.2.840.10008.1.2.4.81": "JPEG-LS",
  "1.2.840.10008.1.2.4.90": "JPEG 2000",
  "1.2.840.10008.1.2.4.91": "JPEG 2000",
  "1.2.840.10008.1.2.4.201": "HTJ2K",
  "1.2.840.10008.1.2.4.202": "HTJ2K",
  "1.2.840.10008.1.2.4.203": "HTJ2K",
};

/** "uncompressed", "JPEG", or "uncompressed + JPEG". */
export function encodingSummary(study: StudyModel): string {
  const names = new Set<string>();
  for (const se of study.series) for (const ts of se.transferSyntaxes) names.add(TS_NAMES[ts] ?? "compressed");
  return [...names].join(" + ");
}

export function studyModalities(study: StudyModel): string[] {
  const out: string[] = [];
  for (const s of study.series) if (s.modality && !out.includes(s.modality)) out.push(s.modality);
  return out;
}

export function studyCounts(study: StudyModel) {
  let images = 0, bytes = 0;
  for (const s of study.series) {
    images += s.instances.length;
    bytes += s.bytes;
  }
  return { series: study.series.length, images, bytes };
}

const DATE_IN_TEXT = /\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/;

/** The study's date for display: its own date, else one written in its description ("BRAIN 7/29/20"). */
export function studyDisplayDate(study: { started: string | null; description: string | null }): string | null {
  if (study.started) return study.started;
  const m = study.description ? DATE_IN_TEXT.exec(study.description) : null;
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const mo = Number(m[1]), d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A plain study name: "BRAIN 7/29/20" + MR → "Brain MRI"; "Upper Extremity" + CR → "Upper extremity X-ray". */
export function plainStudyTitle(description: string | null, modalities: string[]): string {
  const mods = modalities.filter((m) => !["SR", "KO", "PR", "SEG", "OT", "DOC"].includes(m));
  const modText = [...new Set((mods.length ? mods : modalities).map(modalityName))].join(" + ");
  let d = (description ?? "").replace(DATE_IN_TEXT, "").replace(/[_^]+/g, " ").replace(/\s+/g, " ").trim();
  if (d && d === d.toUpperCase()) d = d.charAt(0) + d.slice(1).toLowerCase();
  else if (d) d = d.charAt(0).toUpperCase() + d.slice(1).replace(/\b([A-Z])([a-z]+)/g, (_, a, b) => a.toLowerCase() + b);
  if (!d) return modText || "Imaging study";
  if (!modText) return d;
  const has = (s: string) => d.toLowerCase().includes(s.toLowerCase());
  const aliases: Record<string, string[]> = { MRI: ["MRI", "MR "], "X-ray": ["X-ray", "XR", "radiograph"], CT: ["CT"] };
  if ((aliases[modText] ?? [modText]).some(has)) return d;
  return `${d} ${modText}`;
}

export function seriesName(se: { description: string | null | undefined; number: number | null }): string {
  return se.description?.trim() || (se.number != null ? `Series ${se.number}` : "Series");
}

// ------------------------------------------------------------------------------------ archives

const gz = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const zip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const tar = (b: Uint8Array) =>
  b.length >= 512 && b[257] === 0x75 && b[258] === 0x73 && b[259] === 0x74 && b[260] === 0x61 && b[261] === 0x72;

async function inflate(b: Uint8Array, format: "gzip" | "deflate-raw"): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export interface FileEntry {
  name: string;
  bytes: Uint8Array;
}

/** Expands one file: ZIP, TAR and gzip (TGZ) archives yield their members; anything else itself. */
export async function* expand(name: string, bytes: Uint8Array, depth = 0): AsyncGenerator<FileEntry> {
  if (depth < 3 && gz(bytes)) {
    const inner = await inflate(bytes, "gzip");
    yield* expand(name.replace(/\.(t?gz)$/i, (_, e) => (e.toLowerCase() === "tgz" ? ".tar" : "")), inner, depth + 1);
  } else if (depth < 3 && zip(bytes)) {
    for await (const e of zipEntries(bytes)) yield* expand(`${name}/${e.name}`, e.bytes, depth + 1);
  } else if (depth < 3 && tar(bytes)) {
    for (const e of tarEntries(bytes)) yield* expand(`${name}/${e.name}`, e.bytes, depth + 1);
  } else {
    yield { name, bytes };
  }
}

function ascii(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = 0; i < n && b[o + i] !== 0; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

export function* tarEntries(b: Uint8Array): Generator<FileEntry> {
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= b.length) {
    const h = b.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const name = ascii(h, 0, 100);
    const sizeField = ascii(h, 124, 12).trim();
    const size = parseInt(sizeField || "0", 8) || 0;
    const type = String.fromCharCode(h[156] || 0x30);
    const prefix = tar(h) ? ascii(h, 345, 155) : "";
    const data = b.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = ascii(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(data));
      if (m) paxPath = m[1];
      continue;
    }
    if (type === "0" || type === "\0" || type === "7") {
      const full = longName ?? paxPath ?? (prefix ? `${prefix}/${name}` : name);
      if (size > 0) yield { name: full, bytes: data };
    }
    longName = paxPath = null;
  }
}

export async function* zipEntries(b: Uint8Array): AsyncGenerator<FileEntry> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP file without a central directory");
  let count = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
      const z64 = Number(dv.getBigUint64(loc + 8, true));
      count = Number(dv.getBigUint64(z64 + 32, true));
      cdOff = Number(dv.getBigUint64(z64 + 48, true));
    }
  }
  let p = cdOff;
  for (let i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    let lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
    // ZIP64 extra field: sizes and offset that did not fit.
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = dv.getUint16(x, true), len = dv.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) (usize = Number(dv.getBigUint64(q, true))), (q += 8);
        if (csize === 0xffffffff) (csize = Number(dv.getBigUint64(q, true))), (q += 8);
        if (lho === 0xffffffff) lho = Number(dv.getBigUint64(q, true));
      }
      x += 4 + len;
    }
    p = xend + clen;
    if (name.endsWith("/")) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = b.subarray(start, start + csize);
    if (method === 0) yield { name, bytes: raw };
    else if (method === 8) yield { name, bytes: await inflate(raw, "deflate-raw") };
    else throw new Error(`${name}: ZIP compression method ${method} is not supported`);
  }
}
