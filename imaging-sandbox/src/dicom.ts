// Small DICOM Part 10 parser: enough to read the header attributes the
// sandbox needs (UIDs, patient, study, series) and to produce DICOM JSON
// (PS3.18 F.2) for the WADO-RS /metadata resources. Each element records
// its byte span in the file, so scripts/lib/dicom-rewrite.ts can copy
// untouched elements (pixel data above all) verbatim.

export interface DicomElement {
  tag: number; // (group << 16) | element
  vr: string;
  value: Uint8Array; // raw value bytes (empty for SQ)
  items?: DicomElement[][]; // for SQ
  start: number; // offset of the element's tag in the file
  end: number; // offset just past the element (including any delimiter)
  undefinedLength: boolean;
  itemSpans?: { start: number; end: number; undefinedLength: boolean }[]; // for SQ
  fromUN?: boolean; // an SQ read from an undefined-length UN (items are implicit VR)
}

export interface ParsedDicom {
  transferSyntaxUID: string;
  meta: DicomElement[];
  dataset: DicomElement[];
}

const EXPLICIT_LONG = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);

// VRs for implicit-VR datasets. Only attributes the sandbox reads or that
// commonly appear in headers; everything else is reported as UN.
const IMPLICIT_VR: Record<number, string> = {
  0x00080005: "CS", 0x00080008: "CS", 0x00080012: "DA", 0x00080013: "TM", 0x00080016: "UI",
  0x00080018: "UI", 0x00080020: "DA", 0x00080021: "DA", 0x00080022: "DA", 0x00080023: "DA",
  0x00080030: "TM", 0x00080031: "TM", 0x00080032: "TM", 0x00080033: "TM", 0x00080050: "SH",
  0x00080060: "CS", 0x00080070: "LO", 0x00080080: "LO", 0x00080090: "PN", 0x00081030: "LO",
  0x0008103e: "LO", 0x00081090: "LO", 0x00100010: "PN", 0x00100020: "LO", 0x00100030: "DA",
  0x00100040: "CS", 0x00101010: "AS", 0x00180015: "CS", 0x00180050: "DS", 0x00180088: "DS",
  0x0020000d: "UI", 0x0020000e: "UI", 0x00200010: "SH", 0x00200011: "IS", 0x00200013: "IS",
  0x00200032: "DS", 0x00200037: "DS", 0x00200052: "UI", 0x00201041: "DS", 0x00280002: "US",
  0x00280004: "CS", 0x00280008: "IS", 0x00280010: "US", 0x00280011: "US", 0x00280030: "DS",
  0x00280100: "US", 0x00280101: "US", 0x00280102: "US", 0x00280103: "US", 0x00281050: "DS",
  0x00281051: "DS", 0x00281052: "DS", 0x00281053: "DS", 0x7fe00010: "OW",
};

const ITEM = 0xfffee000;
const ITEM_DELIM = 0xfffee00d;
const SEQ_DELIM = 0xfffee0dd;
const UNDEFINED = 0xffffffff;

class Reader {
  view: DataView;
  constructor(public buf: Uint8Array, public pos: number, public explicit: boolean) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u16(): number { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  tag(): number { const g = this.u16(); const e = this.u16(); return ((g << 16) | e) >>> 0; }
}

function readElements(r: Reader, end: number, stopAtPixelData: boolean, explicitOverride?: boolean): DicomElement[] {
  const out: DicomElement[] = [];
  while (r.pos + 8 <= end) {
    const start = r.pos;
    const tag = r.tag();
    if (tag === ITEM_DELIM || tag === SEQ_DELIM) { r.u32(); break; }
    const explicit = explicitOverride ?? r.explicit;
    let vr: string;
    let len: number;
    if (explicit && (tag >>> 16) !== 0xfffe) {
      vr = String.fromCharCode(r.buf[r.pos], r.buf[r.pos + 1]);
      r.pos += 2;
      if (EXPLICIT_LONG.has(vr)) { r.pos += 2; len = r.u32(); } else { len = r.u16(); }
    } else {
      len = r.u32();
      vr = IMPLICIT_VR[tag] ?? (len === UNDEFINED ? "SQ" : "UN");
    }
    const undefinedLength = len === UNDEFINED;
    if (tag === 0x7fe00010 && stopAtPixelData) {
      out.push({ tag, vr, value: new Uint8Array(0), start, end, undefinedLength });
      r.pos = end;
      break;
    }
    if (vr === "SQ" || (vr === "UN" && undefinedLength)) {
      const itemSpans: DicomElement["itemSpans"] = [];
      const items = readItems(r, undefinedLength ? end : r.pos + len, undefinedLength, explicit && vr !== "UN", itemSpans);
      out.push({ tag, vr: "SQ", value: new Uint8Array(0), items, itemSpans, start, end: r.pos, undefinedLength, fromUN: vr === "UN" });
      continue;
    }
    if (undefinedLength) {
      // Encapsulated data (pixel data): skip the fragments, keep the span.
      while (r.pos + 8 <= end) { const t = r.tag(); const l = r.u32(); r.pos += l; if (t === SEQ_DELIM) break; }
      out.push({ tag, vr, value: new Uint8Array(0), start, end: r.pos, undefinedLength });
      continue;
    }
    if (r.pos + len > end) throw new Error(`element ${tag.toString(16)} at ${start} overruns buffer`);
    out.push({ tag, vr, value: r.buf.subarray(r.pos, r.pos + len), start, end: r.pos + len, undefinedLength });
    r.pos += len;
  }
  return out;
}

function readItems(r: Reader, end: number, undefinedLen: boolean, explicit: boolean, spans: NonNullable<DicomElement["itemSpans"]>): DicomElement[][] {
  const items: DicomElement[][] = [];
  while (r.pos + 8 <= end) {
    const itemStart = r.pos;
    const tag = r.tag();
    const len = r.u32();
    if (tag === SEQ_DELIM) break;
    if (tag !== ITEM) throw new Error(`expected item tag, got ${tag.toString(16)}`);
    const itemEnd = len === UNDEFINED ? end : r.pos + len;
    items.push(readElements(r, itemEnd, false, explicit));
    if (len !== UNDEFINED) r.pos = itemEnd;
    spans.push({ start: itemStart, end: r.pos, undefinedLength: len === UNDEFINED });
  }
  if (!undefinedLen) r.pos = end;
  return items;
}

export function parseDicom(bytes: Uint8Array, opts: { stopAtPixelData?: boolean } = {}): ParsedDicom {
  const magic = new TextDecoder().decode(bytes.subarray(128, 132));
  if (magic !== "DICM") throw new Error("not a DICOM Part 10 file (missing DICM)");
  const metaReader = new Reader(bytes, 132, true);
  // Group 2 length tells us where the meta header ends.
  const first = readElements(new Reader(bytes, 132, true), 132 + 12, false);
  const groupLen = first[0]?.tag === 0x00020000 ? new DataView(first[0].value.buffer, first[0].value.byteOffset).getUint32(0, true) : 0;
  const metaEnd = 132 + 12 + groupLen;
  const meta = readElements(metaReader, metaEnd, false);
  const ts = str(meta, 0x00020010) ?? "1.2.840.10008.1.2.1";
  if (ts === "1.2.840.10008.1.2.2") throw new Error("explicit VR big endian is not supported");
  if (ts === "1.2.840.10008.1.2.1.99") throw new Error("deflated transfer syntax is not supported");
  const explicit = ts !== "1.2.840.10008.1.2";
  const dataset = readElements(new Reader(bytes, metaEnd, explicit), bytes.length, opts.stopAtPixelData ?? true);
  return { transferSyntaxUID: ts, meta, dataset };
}

export function find(els: DicomElement[], tag: number): DicomElement | undefined {
  return els.find((e) => e.tag === tag);
}

export function str(els: DicomElement[], tag: number): string | undefined {
  const e = find(els, tag);
  if (!e || e.items) return undefined;
  const s = new TextDecoder("latin1").decode(e.value).replace(/[\0 ]+$/, "").replace(/^ +/, "");
  return s === "" ? undefined : s;
}

export function int(els: DicomElement[], tag: number): number | undefined {
  const e = find(els, tag);
  if (!e) return undefined;
  if (e.vr === "US") return new DataView(e.value.buffer, e.value.byteOffset).getUint16(0, true);
  if (e.vr === "UL") return new DataView(e.value.buffer, e.value.byteOffset).getUint32(0, true);
  const s = str(els, tag);
  if (s === undefined) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ---- DICOM JSON (PS3.18 Annex F) ----

const STRING_VRS = new Set(["AE", "AS", "CS", "DA", "DT", "LO", "LT", "SH", "ST", "TM", "UC", "UI", "UR", "UT"]);
const BINARY_VRS = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "UN"]);

function hexTag(tag: number): string {
  return tag.toString(16).toUpperCase().padStart(8, "0");
}

function numbers(e: DicomElement): number[] {
  const dv = new DataView(e.value.buffer, e.value.byteOffset, e.value.byteLength);
  const out: number[] = [];
  const step: Record<string, number> = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8, UV: 8, SV: 8 };
  const n = step[e.vr];
  for (let i = 0; i + n <= e.value.byteLength; i += n) {
    switch (e.vr) {
      case "US": out.push(dv.getUint16(i, true)); break;
      case "SS": out.push(dv.getInt16(i, true)); break;
      case "UL": out.push(dv.getUint32(i, true)); break;
      case "SL": out.push(dv.getInt32(i, true)); break;
      case "FL": out.push(dv.getFloat32(i, true)); break;
      case "FD": out.push(dv.getFloat64(i, true)); break;
      case "UV": out.push(Number(dv.getBigUint64(i, true))); break;
      case "SV": out.push(Number(dv.getBigInt64(i, true))); break;
    }
  }
  return out;
}

export function toDicomJson(els: DicomElement[], bulkDataUri?: (tag: number) => string | undefined): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const e of els) {
    const group = e.tag >>> 16;
    if (group === 0x0002) continue; // file meta is not part of the dataset
    if ((e.tag & 0xffff) === 0x0000) continue; // group lengths are retired in DICOM JSON
    const key = hexTag(e.tag);
    const entry: Record<string, unknown> = { vr: e.vr };
    if (e.vr === "SQ") {
      if (e.items && e.items.length) entry.Value = e.items.map((it) => toDicomJson(it));
    } else if (e.tag === 0x7fe00010) {
      const uri = bulkDataUri?.(e.tag);
      if (!uri) continue; // pixel data is left out of metadata without a bulk data URI
      entry.BulkDataURI = uri;
    } else if (BINARY_VRS.has(e.vr)) {
      if (e.value.byteLength) entry.InlineBinary = Buffer.from(e.value).toString("base64");
    } else if (e.vr === "PN") {
      const s = new TextDecoder("latin1").decode(e.value).replace(/[\0 ]+$/, "");
      if (s) entry.Value = s.split("\\").map((v) => {
        const [alphabetic, ideographic, phonetic] = v.split("=");
        const pn: Record<string, string> = {};
        if (alphabetic) pn.Alphabetic = alphabetic;
        if (ideographic) pn.Ideographic = ideographic;
        if (phonetic) pn.Phonetic = phonetic;
        return pn;
      });
    } else if (e.vr === "AT") {
      const dv = new DataView(e.value.buffer, e.value.byteOffset, e.value.byteLength);
      const vals: string[] = [];
      for (let i = 0; i + 4 <= e.value.byteLength; i += 4) vals.push(hexTag(((dv.getUint16(i, true) << 16) | dv.getUint16(i + 2, true)) >>> 0));
      if (vals.length) entry.Value = vals;
    } else if (["US", "SS", "UL", "SL", "FL", "FD", "UV", "SV"].includes(e.vr)) {
      const vals = numbers(e);
      if (vals.length) entry.Value = vals;
    } else if (e.vr === "IS" || e.vr === "DS") {
      const s = new TextDecoder("latin1").decode(e.value).replace(/[\0 ]+$/, "").trim();
      if (s) entry.Value = s.split("\\").map((v) => (v.trim() === "" ? null : Number(v)));
    } else if (STRING_VRS.has(e.vr)) {
      let s = new TextDecoder("latin1").decode(e.value).replace(/\0+$/, "");
      if (e.vr !== "LT" && e.vr !== "ST" && e.vr !== "UT") s = s.trim();
      else s = s.replace(/ +$/, "");
      if (s) entry.Value = ["LT", "ST", "UT"].includes(e.vr) ? [s] : s.split("\\").map((v) => v.trim());
    } else {
      if (e.value.byteLength) entry.InlineBinary = Buffer.from(e.value).toString("base64");
    }
    obj[key] = entry;
  }
  return obj;
}
