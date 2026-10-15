// Minimal DICOM Part 10 header reader: the attributes a DICOMDIR needs, read from the start of a
// file without touching pixel data. Handles explicit and implicit VR little endian and skips
// sequences of defined or undefined length.

export interface DicomHeader {
  transferSyntax: string;
  sopClassUid: string;
  sopInstanceUid: string;
  patientName: string;
  patientId: string;
  patientBirthDate: string;
  patientSex: string;
  studyDate: string;
  studyTime: string;
  accessionNumber: string;
  studyDescription: string;
  studyInstanceUid: string;
  studyId: string;
  referringPhysician: string;
  seriesInstanceUid: string;
  modality: string;
  seriesNumber: string;
  seriesDescription: string;
  instanceNumber: string;
  specificCharacterSet: string;
}

const WANT: Record<number, keyof DicomHeader> = {
  0x00020002: "sopClassUid",
  0x00020003: "sopInstanceUid",
  0x00020010: "transferSyntax",
  0x00080005: "specificCharacterSet",
  0x00080016: "sopClassUid",
  0x00080018: "sopInstanceUid",
  0x00080020: "studyDate",
  0x00080030: "studyTime",
  0x00080050: "accessionNumber",
  0x00080060: "modality",
  0x00080090: "referringPhysician",
  0x00081030: "studyDescription",
  0x0008103e: "seriesDescription",
  0x00100010: "patientName",
  0x00100020: "patientId",
  0x00100030: "patientBirthDate",
  0x00100040: "patientSex",
  0x0020000d: "studyInstanceUid",
  0x0020000e: "seriesInstanceUid",
  0x00200010: "studyId",
  0x00200011: "seriesNumber",
  0x00200013: "instanceNumber",
};

const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);
const UNDEFINED = 0xffffffff;

export class DicomHeaderError extends Error {}

export function readDicomHeader(bytes: Uint8Array): DicomHeader {
  const h: DicomHeader = {
    transferSyntax: "", sopClassUid: "", sopInstanceUid: "", patientName: "", patientId: "",
    patientBirthDate: "", patientSex: "", studyDate: "", studyTime: "", accessionNumber: "",
    studyDescription: "", studyInstanceUid: "", studyId: "", referringPhysician: "",
    seriesInstanceUid: "", modality: "", seriesNumber: "", seriesDescription: "", instanceNumber: "",
    specificCharacterSet: "",
  };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 132 || dv.getUint32(128) !== 0x4449434d) throw new DicomHeaderError("not a Part 10 file");
  const text = (o: number, n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[o + i]);
    return s.replace(/[\0 ]+$/, "").replace(/^ +/, "");
  };
  const ascii = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1]);
  let pos = 132;
  let explicit = true;
  const end = bytes.length;

  // Skips an undefined-length sequence or item content starting at p; returns the position after its delimiter.
  const skipUndefined = (p: number, isExplicit: boolean): number => {
    while (p + 8 <= end) {
      const g = dv.getUint16(p, true), e = dv.getUint16(p + 2, true);
      if (g === 0xfffe) {
        const len = dv.getUint32(p + 4, true);
        if (e === 0xe0dd || e === 0xe00d) return p + 8; // sequence / item delimiter
        if (e === 0xe000) {
          p = len === UNDEFINED ? skipUndefined(p + 8, isExplicit) : p + 8 + len;
          continue;
        }
      }
      p = skipElement(p, isExplicit).next;
    }
    return end;
  };

  const skipElement = (p: number, isExplicit: boolean): { tag: number; vo: number; len: number; next: number; vr: string } => {
    const tag = ((dv.getUint16(p, true) << 16) | dv.getUint16(p + 2, true)) >>> 0;
    let vr = "", len: number, vo: number;
    if (isExplicit && /^[A-Z]{2}$/.test(ascii(p + 4))) {
      vr = ascii(p + 4);
      if (LONG_VR.has(vr)) {
        len = dv.getUint32(p + 8, true);
        vo = p + 12;
      } else {
        len = dv.getUint16(p + 6, true);
        vo = p + 8;
      }
    } else {
      len = dv.getUint32(p + 4, true);
      vo = p + 8;
    }
    const next = len === UNDEFINED ? skipUndefined(vo, isExplicit) : vo + len;
    return { tag, vo, len, next, vr };
  };

  while (pos + 8 <= end) {
    const group = dv.getUint16(pos, true);
    if (group !== 0x0002 && pos > 132 && explicit && h.transferSyntax) {
      // Leaving the file meta group: switch to the data set's encoding.
      explicit = h.transferSyntax !== "1.2.840.10008.1.2";
      if (h.transferSyntax === "1.2.840.10008.1.2.1.99" || h.transferSyntax === "1.2.840.10008.1.2.2") break; // deflated / big endian: meta only
    }
    const el = skipElement(pos, group === 0x0002 ? true : explicit);
    if (el.tag > 0x0020ffff) break;
    const field = WANT[el.tag];
    if (field && el.len !== UNDEFINED && el.len < 1024 && !(field === "sopClassUid" && h.sopClassUid && el.tag >> 16 === 8) && !(field === "sopInstanceUid" && h.sopInstanceUid && el.tag >> 16 === 8)) {
      h[field] = text(el.vo, el.len);
    }
    pos = el.next;
  }
  return h;
}
