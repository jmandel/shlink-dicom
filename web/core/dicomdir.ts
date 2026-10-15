// DICOMDIR writer (PS3.10 Basic Directory, PS3.3 F.5): PATIENT → STUDY → SERIES → IMAGE records
// for files stored under IDs such as DICOM/ST000001/SE000001/IM000001.
import type { DicomHeader } from "./dicom-header";

export interface DicomdirEntry {
  /** Path components of the file inside the file set, e.g. ["DICOM","ST000001","SE000001","IM000001"]. */
  fileId: string[];
  header: DicomHeader;
}

const LONG_VR = new Set(["OB", "OW", "SQ", "UN", "UT"]);

class W {
  parts: number[] = [];
  get length() {
    return this.parts.length;
  }
  u16(v: number) {
    this.parts.push(v & 0xff, (v >> 8) & 0xff);
  }
  u32(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
  }
}

function valueBytes(vr: string, v: string | number): number[] {
  if (vr === "UL" || vr === "US") {
    const n = v as number;
    return vr === "US" ? [n & 0xff, (n >> 8) & 0xff] : [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  }
  const s = String(v);
  const out = Array.from(s, (c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 0x3f));
  if (out.length % 2) out.push(vr === "UI" || vr === "OB" ? 0 : 0x20);
  return out;
}

function element(w: W, group: number, elem: number, vr: string, value: string | number | number[]) {
  const vb = Array.isArray(value) ? value : valueBytes(vr, value);
  w.u16(group);
  w.u16(elem);
  w.bytes([vr.charCodeAt(0), vr.charCodeAt(1)]);
  if (LONG_VR.has(vr)) {
    w.u16(0);
    w.u32(vb.length);
  } else {
    w.u16(vb.length);
  }
  w.bytes(vb);
}

/** Cleans a value for a CS/SH/LO field: no backslashes, clipped to the VR's length. */
const clip = (s: string, n: number) => s.replace(/\\/g, " ").slice(0, n).trim();

interface Rec {
  type: "PATIENT" | "STUDY" | "SERIES" | "IMAGE";
  fields: [number, number, string, string | number][];
  children: Rec[];
  /** Filled during layout. */
  offset?: number;
  next?: number;
  lower?: number;
}

function newUid(): string {
  // 2.25.<128-bit random integer> (PS3.5 B.2).
  const b = crypto.getRandomValues(new Uint8Array(16));
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return `2.25.${n.toString()}`;
}

/** Builds DICOMDIR bytes for the given files. */
export function buildDicomdir(entries: DicomdirEntry[], fileSetId = "SHLDICOM"): Uint8Array {
  const patients: Rec[] = [];
  const pIdx = new Map<string, Rec>(), stIdx = new Map<string, Rec>(), seIdx = new Map<string, Rec>();
  for (const { fileId, header: h } of entries) {
    const pk = `${h.patientId}|${h.patientName}`;
    let p = pIdx.get(pk);
    if (!p) {
      p = {
        type: "PATIENT",
        fields: [
          ...(h.specificCharacterSet ? ([[0x0008, 0x0005, "CS", h.specificCharacterSet]] as Rec["fields"]) : []),
          [0x0010, 0x0010, "PN", clip(h.patientName, 64)],
          [0x0010, 0x0020, "LO", clip(h.patientId || "UNKNOWN", 64)],
          [0x0010, 0x0030, "DA", h.patientBirthDate],
          [0x0010, 0x0040, "CS", h.patientSex],
        ],
        children: [],
      };
      pIdx.set(pk, p);
      patients.push(p);
    }
    let st = stIdx.get(h.studyInstanceUid);
    if (!st) {
      st = {
        type: "STUDY",
        fields: [
          ...(h.specificCharacterSet ? ([[0x0008, 0x0005, "CS", h.specificCharacterSet]] as Rec["fields"]) : []),
          [0x0008, 0x0020, "DA", h.studyDate],
          [0x0008, 0x0030, "TM", h.studyTime],
          [0x0008, 0x0050, "SH", clip(h.accessionNumber, 16)],
          [0x0008, 0x1030, "LO", clip(h.studyDescription, 64)],
          [0x0020, 0x000d, "UI", h.studyInstanceUid],
          [0x0020, 0x0010, "SH", clip(h.studyId, 16)],
        ],
        children: [],
      };
      stIdx.set(h.studyInstanceUid, st);
      p.children.push(st);
    }
    const sk = `${h.studyInstanceUid}|${h.seriesInstanceUid}`;
    let se = seIdx.get(sk);
    if (!se) {
      se = {
        type: "SERIES",
        fields: [
          ...(h.specificCharacterSet ? ([[0x0008, 0x0005, "CS", h.specificCharacterSet]] as Rec["fields"]) : []),
          [0x0008, 0x0060, "CS", clip(h.modality || "OT", 16)],
          [0x0008, 0x103e, "LO", clip(h.seriesDescription, 64)],
          [0x0020, 0x000e, "UI", h.seriesInstanceUid],
          [0x0020, 0x0011, "IS", clip(h.seriesNumber, 12)],
        ],
        children: [],
      };
      seIdx.set(sk, se);
      st.children.push(se);
    }
    se.children.push({
      type: "IMAGE",
      fields: [
        [0x0004, 0x1500, "CS", fileId.join("\\")],
        [0x0004, 0x1510, "UI", h.sopClassUid],
        [0x0004, 0x1511, "UI", h.sopInstanceUid],
        [0x0004, 0x1512, "UI", h.transferSyntax],
        ...(h.specificCharacterSet ? ([[0x0008, 0x0005, "CS", h.specificCharacterSet]] as Rec["fields"]) : []),
        [0x0020, 0x0013, "IS", clip(h.instanceNumber, 12)],
      ],
      children: [],
    });
  }

  // Records in file order (depth first) and the size of each encoded item.
  const order: Rec[] = [];
  const walk = (rs: Rec[]) => rs.forEach((r) => (order.push(r), walk(r.children)));
  walk(patients);
  const encodeItem = (r: Rec): number[] => {
    const body = new W();
    element(body, 0x0004, 0x1400, "UL", r.next ?? 0);
    element(body, 0x0004, 0x1410, "US", 0xffff);
    element(body, 0x0004, 0x1420, "UL", r.lower ?? 0);
    element(body, 0x0004, 0x1430, "CS", r.type);
    // Directory record keys must be in ascending tag order.
    const sorted = [...r.fields].sort((a, b) => (a[0] << 16 | a[1]) - (b[0] << 16 | b[1]));
    for (const [g, e, vr, v] of sorted) element(body, g, e, vr, v);
    const item = new W();
    item.u16(0xfffe);
    item.u16(0xe000);
    item.u32(body.length);
    item.bytes(body.parts);
    return item.parts;
  };

  // File meta.
  const meta = new W();
  const sopInstance = newUid();
  element(meta, 0x0002, 0x0001, "OB", [0, 1]);
  element(meta, 0x0002, 0x0002, "UI", "1.2.840.10008.1.3.10");
  element(meta, 0x0002, 0x0003, "UI", sopInstance);
  element(meta, 0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1");
  element(meta, 0x0002, 0x0012, "UI", "2.25.329800735698586629295641978511506172918");
  element(meta, 0x0002, 0x0013, "SH", "SHL_DICOM_1");
  const metaGroup = new W();
  element(metaGroup, 0x0002, 0x0000, "UL", meta.length);
  metaGroup.bytes(meta.parts);

  // Data set header up to the sequence; its size does not depend on offsets.
  const head = (firstRoot: number, lastRoot: number, seqLen: number) => {
    const w = new W();
    element(w, 0x0004, 0x1130, "CS", fileSetId);
    element(w, 0x0004, 0x1200, "UL", firstRoot);
    element(w, 0x0004, 0x1202, "UL", lastRoot);
    element(w, 0x0004, 0x1212, "US", 0);
    w.u16(0x0004);
    w.u16(0x1220);
    w.bytes([0x53, 0x51, 0, 0]);
    w.u32(seqLen);
    return w;
  };
  const start = 128 + 4 + metaGroup.length + head(0, 0, 0).length;

  // Layout: item sizes do not depend on offset values (UL is fixed width), so one pass fixes them.
  let pos = start;
  for (const r of order) {
    r.offset = pos;
    pos += encodeItem(r).length;
  }
  const link = (rs: Rec[]) =>
    rs.forEach((r, i) => {
      r.next = rs[i + 1]?.offset ?? 0;
      r.lower = r.children[0]?.offset ?? 0;
      link(r.children);
    });
  link(patients);
  const items = order.map(encodeItem);
  const seqLen = items.reduce((a, b) => a + b.length, 0);
  const h = head(patients[0]?.offset ?? 0, patients[patients.length - 1]?.offset ?? 0, seqLen);

  const out = new Uint8Array(start + seqLen);
  out.set([0x44, 0x49, 0x43, 0x4d], 128);
  out.set(metaGroup.parts, 132);
  out.set(h.parts, 132 + metaGroup.length);
  let o = start;
  for (const it of items) {
    out.set(it, o);
    o += it.length;
  }
  return out;
}
