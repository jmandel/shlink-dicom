// Reading imaging on the device: archives (ZIP, TAR, TGZ), loose DICOM files and folders, and
// instances handed over by the portal and link sources. Everything ends up as Part 10 files grouped
// into studies and series (spec/README.md §11.1 steps 1–5).
//
// Nothing here holds a whole file: an instance is a byte source (lib/bytes.ts) read on demand, and
// only its header is read while collecting. Archive members that can't be read in place (deflated
// ZIP entries, anything inside a gzip stream, portal downloads) are staged to the origin-private
// file system (lib/stage.ts).
import { readDicomHeader, type DicomHeader } from "../../core/dicom-header";
import { modalityName } from "../../core/format";
import { SYNTAXES } from "../../core/transfer-syntax";
import { BlobBytes, ConcatBytes, MemBytes, SubBytes, type Bytes } from "./bytes";
import { shlWasm } from "./shl-wasm";
import type { Stager } from "./stage";
import { rememberOffsetTableHeader } from "./offset-tables";

export interface Instance {
  name: string;
  src: Bytes;
  h: DicomHeader;
  number: number | null;
  /** Re-encoded on this device (lib/compress.ts): pixel-identical to the file it came from. */
  reencoded?: boolean;
}

/** Bytes a header is read from, growing until the UIDs are found. */
const HEADER_READS = [64 << 10, 1 << 20, 16 << 20];

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
  /** The name as the Share page shows it. */
  name: string | null;
  birthDate: string | null;
  identifier: { system?: string; value: string; assigner?: { display: string } }[];
  /** A FHIR source's HumanName, for the Bundle. */
  humanName?: any;
}

export interface StudyModel {
  uid: string;
  description: string | null;
  /** ISO date or dateTime for ImagingStudy.started, from the source (DICOM StudyDate or the portal). */
  started: string | null;
  /** Accession Number (0008,0050), or the source ImagingStudy's ACSN identifier. */
  accession: string | null;
  series: SeriesModel[];
  include: boolean;
  /** DiagnosticReports for this study (from the portal or link, or attached by the sharer), attachments inline. */
  reports: ReportItem[];
}

export interface ReportItem {
  /** FHIR DiagnosticReport, presentedForm data inline. */
  resource: any;
  include: boolean;
  from: "portal" | "link" | "attached";
}

/** A DiagnosticReport for a report file the sharer attached (PDF or text). */
export async function reportFromFile(file: File): Promise<any> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name) || (bytes[0] === 0x25 && bytes[1] === 0x50);
  const contentType = isPdf ? "application/pdf" : "text/plain; charset=utf-8";
  const title = file.name.replace(/\.[^.]+$/, "") || "Report";
  return {
    resourceType: "DiagnosticReport",
    status: "final",
    code: { text: title },
    presentedForm: [{ contentType, title: file.name, size: bytes.length, data: btoa(bin) }],
  };
}

export function reportTitle(r: any): string {
  return r.code?.text ?? r.code?.coding?.[0]?.display ?? "Imaging report";
}

export interface Skipped {
  name: string;
  reason: string;
}

const DICOMDIR_SOP = "1.2.840.10008.1.3.10";

/** Collects instances as they are found; counts drive the live "Found …" line. */
export class Collection {
  studies = new Map<string, StudyModel>();
  /** Reports that name none of the studies (from the portal or link); each has its own choice. */
  looseReports: ReportItem[] = [];
  skipped: Skipped[] = [];
  duplicates = 0;
  instanceCount = 0;
  bytes = 0;
  patient: PatientInfo = { name: null, birthDate: null, identifier: [] };
  /** Portal downloads: images received per transfer syntax, as each part declared it. */
  received = new Map<string, number>();
  /** The sharer said files naming different people are one person's (sharePatient). */
  samePatient = false;
  /** Where the patient details came from: "dicom" until a FHIR source sets them. */
  patientSource: "dicom" | "fhir" = "dicom";

  get seriesCount() {
    let n = 0;
    for (const s of this.studies.values()) n += s.series.length;
    return n;
  }

  list(): StudyModel[] {
    return [...this.studies.values()];
  }

  /** Adds one file; DICOMDIR and non-DICOM files are skipped and recorded. Reads only its header. */
  async add(name: string, data: Bytes | Uint8Array) {
    let src = data instanceof Uint8Array ? new MemBytes(data) : data;
    const base = name.split(/[\\/]/).pop() ?? name;
    if (base.toUpperCase() === "DICOMDIR") return this.skip(name, "DICOMDIR (an index, not an image)");
    let head = await src.read(0, Math.min(src.size, HEADER_READS[0]));
    if (head.length < 132 || head[128] !== 0x44 || head[129] !== 0x49 || head[130] !== 0x43 || head[131] !== 0x4d) {
      if (/^\./.test(base) || /\.(txt|htm|html|inf|exe|ini|pdf|xml|jpg|png|js|css|ico|dll)$/i.test(base)) return this.skip(name, "not a DICOM file");
      // A bare data set is wrapped in Part 10 as the packer does (spec/README.md §11.1 step 3).
      if (!shlWasm().looks_like_bare_data_set(head)) return this.skip(name, "not a DICOM file (no DICM preamble)");
      // From the file's first bytes (longer ones only when its UIDs come later): the new head, then
      // the file's own bytes, so a large file is never read whole.
      const whole = src;
      let wrap: { head: Uint8Array; skip: number } | null = null;
      for (const n of [...HEADER_READS, whole.size]) {
        const prefix = n >= whole.size ? await whole.read(0, whole.size) : n === HEADER_READS[0] ? head : await whole.read(0, n);
        try {
          const w = shlWasm().part10_wrap(prefix);
          wrap = { head: w.head, skip: w.skip };
          w.free();
          break;
        } catch (x) {
          if (prefix.length >= whole.size) return this.skip(name, `unreadable DICOM: ${(x as Error).message}`);
        }
      }
      src = new ConcatBytes([new MemBytes(wrap!.head), new SubBytes(whole, wrap!.skip, whole.size - wrap!.skip)]);
      head = await src.read(0, Math.min(src.size, HEADER_READS[0]));
    }
    let h: DicomHeader | null = null;
    for (const n of HEADER_READS) {
      if (n > HEADER_READS[0]) {
        if (src.size <= head.length) break;
        head = await src.read(0, Math.min(src.size, n));
      }
      try {
        h = await readDicomHeader(head);
      } catch {
        h = null;
      }
      if (h?.sopInstanceUid && h.studyInstanceUid && h.seriesInstanceUid) break;
    }
    if (!h) return this.skip(name, "unreadable DICOM header");
    this.addWithHeader(name, src, h, head);
  }

  /** Adds an instance whose header is already known (link sources, from the Bundle). */
  addWithHeader(name: string, src: Bytes, h: DicomHeader, prefix?: Uint8Array) {
    if (h.sopClassUid === DICOMDIR_SOP) return this.skip(name, "DICOMDIR (an index, not an image)");
    if (!h.sopInstanceUid) return this.skip(name, "no SOP Instance UID");
    if (!h.studyInstanceUid || !h.seriesInstanceUid) return this.skip(name, "no Study or Series Instance UID");
    if (prefix) rememberOffsetTableHeader({ src, h }, prefix);
    let st = this.studies.get(h.studyInstanceUid);
    if (!st) {
      st = {
        uid: h.studyInstanceUid,
        description: null,
        started: null,
        accession: null,
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
    se.instances.push({ name, src, h, number: toInt(h.instanceNumber) });
    se.bytes += src.size;
    if (h.transferSyntax) se.transferSyntaxes.add(h.transferSyntax);
    this.instanceCount++;
    this.bytes += src.size;
  }

  skip(name: string, reason: string) {
    this.skipped.push({ name, reason });
  }

  /**
   * Groups and orders the instances with the packer's rule (shl_dicom_core::order through
   * shl-dicom-wasm; spec/README.md §11.1 step 5): studies newest first, series by number, instances
   * by Instance Number, one copy per SOP Instance UID (the others are skipped, with the reason).
   * Study-level values a source did not give come from the first instance in that order that has
   * them; the patient of DICOM files comes from the included studies (sharePatient). Needs
   * loadShlWasm first.
   */
  async finish() {
    const all: Instance[] = [];
    for (const st of this.studies.values()) for (const se of st.series) all.push(...se.instances);
    const metas = all.map((i) => ({
      studyUid: i.h.studyInstanceUid,
      seriesUid: i.h.seriesInstanceUid,
      sopUid: i.h.sopInstanceUid,
      studyDate: i.h.studyDate || null,
      studyTime: i.h.studyTime || null,
      seriesNumber: toInt(i.h.seriesNumber),
      instanceNumber: i.number,
      sha256: null as string | null,
    }));
    const group = () => JSON.parse(shlWasm().group_instances(JSON.stringify(metas))) as Grouped;
    let g = group();
    if (g.needSha256.length) {
      for (const i of g.needSha256) metas[i].sha256 = await sha256Hex(await all[i].src.read(0, all[i].src.size));
      g = group();
    }
    for (const [i] of g.duplicates) {
      this.skip(all[i].name, "duplicate SOP Instance UID");
      this.duplicates++;
      this.instanceCount--;
      this.bytes -= all[i].src.size;
    }
    const studies = new Map<string, StudyModel>();
    for (const gs of g.studies) {
      const st = this.studies.get(gs.uid)!;
      st.series = gs.series.map((gse) => {
        const se = st.series.find((s) => s.uid === gse.uid)!;
        se.instances = gse.instances.map((i) => all[i]);
        const nums = se.instances.map((i) => toInt(i.h.seriesNumber)).filter((n): n is number => n != null);
        se.number = nums.length ? Math.min(...nums) : null;
        se.bytes = se.instances.reduce((a, i) => a + i.src.size, 0);
        se.transferSyntaxes = new Set(se.instances.map((i) => i.h.transferSyntax).filter(Boolean));
        return se;
      });
      const first = (f: (h: DicomHeader) => string) => st.series.flatMap((se) => se.instances).map((i) => f(i.h)?.trim()).find(Boolean) ?? "";
      // Values a source gave (the portal's or the link's ImagingStudy) stay.
      st.description ??= first((h) => h.studyDescription) || null;
      st.started ??= dicomDate(first((h) => h.studyDate), "");
      st.accession ??= first((h) => h.accessionNumber) || null;
      studies.set(gs.uid, st);
    }
    this.studies = studies;
  }
}

/** The included studies' patient, or the two records that name different people. */
export type SharePatient =
  | { patient: { dicomName: string | null; birthDate: string | null; identifiers: { value: string; assigner?: { display: string } }[] } }
  | { conflict: { first: [string | null, string | null]; other: [string | null, string | null] }; message: string };

/**
 * The patient of these studies by the packer's one-patient rule (shl_dicom_core::patient through
 * shl-dicom-wasm): family names or birth dates that differ name different people, unless the
 * sharer said they are the same person. Needs loadShlWasm first.
 */
export function sharePatient(studies: StudyModel[], samePatient: boolean): SharePatient {
  const records = studies.flatMap((st) =>
    st.series.flatMap((se) =>
      se.instances.map((i) => ({ name: i.h.patientName || null, birthDate: i.h.patientBirthDate || null, id: i.h.patientId || null, issuer: i.h.patientIdIssuer || null })),
    ),
  );
  return JSON.parse(shlWasm().share_patient(JSON.stringify(records), samePatient));
}

interface Grouped {
  studies: { uid: string; series: { uid: string; instances: number[] }[] }[];
  duplicates: [number, number][];
  needSha256: number[];
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function toInt(s: string): number | null {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/** DICOM DA (+TM) to an ISO date ("2020-07-29"); null when absent. */
function dicomDate(da: string, _tm: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(da.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ------------------------------------------------------------------------------------- display


/** "uncompressed", "JPEG", or "uncompressed + JPEG". */
export function encodingSummary(study: StudyModel): string {
  const names = new Set<string>();
  for (const se of study.series) for (const ts of se.transferSyntaxes) names.add(SYNTAXES[ts]?.family ?? "compressed");
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

/** Kept in capitals when a description is sentence-cased. */
const ACRONYMS = /\b(ct|mri?|pet|xr|us|ap|pa|cta|mra|dwi|adc|flair)\b/gi;

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
  if (d && d === d.toUpperCase()) d = (d.charAt(0) + d.slice(1).toLowerCase()).replace(ACRONYMS, (w) => w.toUpperCase());
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

const isGz = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isTar = (b: Uint8Array) =>
  b.length >= 512 && b[257] === 0x75 && b[258] === 0x73 && b[259] === 0x74 && b[260] === 0x61 && b[261] === 0x72;

export interface FileEntry {
  name: string;
  src: Bytes;
}

/** A stream of the source's bytes (a Blob's own stream when there is one). */
function streamOf(src: Bytes): ReadableStream<Uint8Array> {
  if (src instanceof BlobBytes) return src.blob.stream() as ReadableStream<Uint8Array>;
  if (src instanceof SubBytes && src.base instanceof BlobBytes) return src.base.blob.slice(src.offset, src.offset + src.size).stream() as ReadableStream<Uint8Array>;
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (pos >= src.size) return c.close();
      const n = Math.min(src.size - pos, 4 << 20);
      c.enqueue(await src.read(pos, pos + n));
      pos += n;
    },
  });
}

/** The most bytes one gzip stream or ZIP member is decompressed to (64 GiB). */
export const MAX_EXPANDED_BYTES = 2 ** 36;

/** Passes at most `limit` bytes; a stream that goes on fails with `message`. */
function capped(limit: number, message: string): TransformStream<Uint8Array, Uint8Array> {
  let n = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(c, ctl) {
      n += c.length;
      if (n > limit) ctl.error(new Error(message));
      else ctl.enqueue(c);
    },
  });
}

/**
 * Expands one file: ZIP and TAR members are read in place where they can be (stored entries, plain
 * TAR); gzip streams and deflated entries are decompressed into the stager. Anything else is itself.
 */
export async function* expand(name: string, src: Bytes, stager: Stager, depth = 0, onPos?: (pos: number) => void): AsyncGenerator<FileEntry> {
  const sniff = await src.read(0, Math.min(src.size, 512));
  if (depth < 3 && isGz(sniff)) {
    // Count the compressed bytes consumed, for progress.
    let pos = 0;
    const counted = streamOf(src).pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(c, ctl) {
          pos += c.length;
          onPos?.(pos);
          ctl.enqueue(c);
        },
      }),
    );
    const stream = counted
      .pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>)
      .pipeThrough(capped(MAX_EXPANDED_BYTES, `${name} decompresses to more than ${MAX_EXPANDED_BYTES / 2 ** 30} GiB.`));
    yield* tarStream(name.replace(/\.(t?gz)$/i, ""), stream, stager);
  } else if (depth < 3 && isZip(sniff)) {
    for await (const e of zipEntries(src, stager)) {
      if (e.src instanceof SubBytes) onPos?.(e.src.offset + e.src.size);
      yield* expand(`${name}/${e.name}`, e.src, stager, depth + 1);
    }
  } else if (depth < 3 && isTar(sniff)) {
    for await (const e of tarEntries(src)) {
      if (e.src instanceof SubBytes) onPos?.(e.src.offset + e.src.size);
      yield* expand(`${name}/${e.name}`, e.src, stager, depth + 1);
    }
  } else {
    yield { name, src };
  }
  onPos?.(src.size);
}

/** Pull-based reader over a byte stream. */
class StreamReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = new Uint8Array(0);
  private done = false;
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }
  private async fill(n: number) {
    while (this.buf.length < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) this.done = true;
      else if (value?.length) {
        const b = new Uint8Array(this.buf.length + value.length);
        b.set(this.buf);
        b.set(value, this.buf.length);
        this.buf = b;
      }
    }
  }
  /** Exactly n bytes, or fewer at the end of the stream. */
  async take(n: number): Promise<Uint8Array> {
    await this.fill(n);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(out.length);
    return out;
  }
  /** The next n bytes as chunks, without holding them all. */
  async *chunks(n: number): AsyncGenerator<Uint8Array> {
    while (n > 0) {
      if (!this.buf.length) await this.fill(1);
      if (!this.buf.length) return;
      const out = this.buf.subarray(0, Math.min(n, this.buf.length));
      this.buf = this.buf.subarray(out.length);
      n -= out.length;
      yield out;
    }
  }
  async skip(n: number) {
    for await (const _ of this.chunks(n));
  }
  cancel() {
    this.reader.cancel().catch(() => {});
  }
}

function ascii(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = 0; i < n && b[o + i] !== 0; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

interface TarHeader {
  name: string;
  size: number;
  type: string;
  prefix: string;
}
function tarHeader(h: Uint8Array): TarHeader | null {
  if (h.length < 512 || h.every((x) => x === 0)) return null;
  const sizeField = ascii(h, 124, 12).trim();
  return { name: ascii(h, 0, 100), size: parseInt(sizeField || "0", 8) || 0, type: String.fromCharCode(h[156] || 0x30), prefix: isTar(h) ? ascii(h, 345, 155) : "" };
}

/** TAR members of a stream (the inside of a .tgz), each staged as it is read. */
async function* tarStream(name: string, stream: ReadableStream<Uint8Array>, stager: Stager): AsyncGenerator<FileEntry> {
  const r = new StreamReader(stream);
  const first = await r.take(512);
  if (!isTar(first)) {
    // A plain .gz of one file.
    const rest = async function* () {
      yield first;
      for await (const c of r.chunks(Infinity)) yield c;
    };
    yield { name, src: await stager.stage(name, rest()) };
    return;
  }
  let block: Uint8Array | null = first;
  let longName: string | null = null, paxPath: string | null = null;
  try {
    for (;;) {
      const h = block ?? (await r.take(512));
      block = null;
      const th = tarHeader(h);
      if (!th) break;
      const pad = Math.ceil(th.size / 512) * 512 - th.size;
      if (th.type === "L" || th.type === "x") {
        const data = await r.take(th.size);
        await r.skip(pad);
        if (th.type === "L") longName = ascii(data, 0, data.length);
        else paxPath = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(data))?.[1] ?? null;
        continue;
      }
      const full = longName ?? paxPath ?? (th.prefix ? `${th.prefix}/${th.name}` : th.name);
      longName = paxPath = null;
      if ((th.type === "0" || th.type === "\0" || th.type === "7") && th.size > 0) {
        const src = await stager.stage(`${name}/${full}`, r.chunks(th.size));
        await r.skip(pad);
        yield { name: `${name}/${full}`, src };
      } else await r.skip(th.size + pad);
    }
  } finally {
    r.cancel();
  }
}

/** TAR members read in place (an uncompressed .tar). */
export async function* tarEntries(src: Bytes): AsyncGenerator<FileEntry> {
  let off = 0;
  let longName: string | null = null, paxPath: string | null = null;
  while (off + 512 <= src.size) {
    const th = tarHeader(await src.read(off, off + 512));
    if (!th) break;
    const start = off + 512;
    off = start + Math.ceil(th.size / 512) * 512;
    if (th.type === "L" || th.type === "x") {
      const data = await src.read(start, start + th.size);
      if (th.type === "L") longName = ascii(data, 0, data.length);
      else paxPath = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(data))?.[1] ?? null;
      continue;
    }
    const full = longName ?? paxPath ?? (th.prefix ? `${th.prefix}/${th.name}` : th.name);
    longName = paxPath = null;
    if ((th.type === "0" || th.type === "\0" || th.type === "7") && th.size > 0) yield { name: full, src: new SubBytes(src, start, th.size) };
  }
}

/** ZIP members: stored entries in place, deflated entries inflated into the stager. */
export async function* zipEntries(src: Bytes, stager: Stager): AsyncGenerator<FileEntry> {
  const tailStart = Math.max(0, src.size - 22 - 65535);
  const tail = await src.read(tailStart, src.size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP file without a central directory");
  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOff = tv.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tv.getUint32(loc, true) === 0x07064b50) {
      const z64 = Number(tv.getBigUint64(loc + 8, true));
      const z = await src.read(z64, z64 + 56);
      const zv = new DataView(z.buffer, z.byteOffset, z.byteLength);
      count = Number(zv.getBigUint64(32, true));
      cdSize = Number(zv.getBigUint64(40, true));
      cdOff = Number(zv.getBigUint64(48, true));
    }
  }
  const cd = await src.read(cdOff, cdOff + cdSize);
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    let lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nlen));
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
    const lh = await src.read(lho, lho + 30);
    const lv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
    const start = lho + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    const raw = new SubBytes(src, start, csize);
    if (method === 0) yield { name, src: raw };
    else if (method === 8) {
      // No more than the size the ZIP gives for it.
      const inflated = streamOf(raw)
        .pipeThrough(new DecompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>)
        .pipeThrough(capped(Math.min(usize, MAX_EXPANDED_BYTES), `${name}: the ZIP member is larger than the ZIP says.`));
      const it = async function* () {
        const rd = inflated.getReader();
        for (;;) {
          const { value, done } = await rd.read();
          if (done) return;
          yield value;
        }
      };
      yield { name, src: await stager.stage(name, it()) };
    } else throw new Error(`${name}: ZIP compression method ${method} is not supported`);
  }
}
