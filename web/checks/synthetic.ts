// Synthetic DICOM for the checks: a 512² CT phantom series and a 2048² DX, written as explicit VR
// little endian Part 10 files. Fictional patient, generated UIDs (2.25), no real data.

const enc = new TextEncoder();

function el(out: number[], group: number, elem: number, vr: string, value: string | Uint8Array) {
  let v = typeof value === "string" ? Array.from(enc.encode(value)) : Array.from(value);
  if (v.length % 2) v.push(vr === "UI" || vr === "OB" ? 0 : 0x20);
  const long = ["OB", "OW", "SQ", "UN", "UT"].includes(vr);
  out.push(group & 0xff, group >> 8, elem & 0xff, elem >> 8, vr.charCodeAt(0), vr.charCodeAt(1));
  if (long) out.push(0, 0, v.length & 0xff, (v.length >> 8) & 0xff, (v.length >> 16) & 0xff, v.length >>> 24);
  else out.push(v.length & 0xff, v.length >> 8);
  for (const b of v) out.push(b);
}
const us = (n: number) => new Uint8Array([n & 0xff, n >> 8]);

export function uid(): string {
  let n = 0n;
  for (const b of crypto.getRandomValues(new Uint8Array(16))) n = (n << 8n) | BigInt(b);
  return `2.25.${n}`;
}

export interface SyntheticImage {
  studyUid: string;
  seriesUid: string;
  modality: string;
  studyDescription: string;
  seriesDescription: string;
  seriesNumber: number;
  instanceNumber: number;
  rows: number;
  columns: number;
  /** Signed 16-bit values (CT: Hounsfield units) or unsigned 12-bit in 16. */
  pixels: Int16Array | Uint16Array;
  window?: [number, number];
}

const CT_IMAGE = "1.2.840.10008.5.1.4.1.1.2";
const DX_IMAGE = "1.2.840.10008.5.1.4.1.1.1.1";

function writeDicom(im: SyntheticImage): Uint8Array {
  const sop = uid();
  const sopClass = im.modality === "CT" ? CT_IMAGE : DX_IMAGE;
  const meta: number[] = [];
  el(meta, 0x0002, 0x0001, "OB", new Uint8Array([0, 1]));
  el(meta, 0x0002, 0x0002, "UI", sopClass);
  el(meta, 0x0002, 0x0003, "UI", sop);
  el(meta, 0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1");
  el(meta, 0x0002, 0x0012, "UI", "2.25.1");
  const head: number[] = [];
  el(head, 0x0002, 0x0000, "UL", new Uint8Array(new Uint32Array([meta.length]).buffer));
  const ds: number[] = [];
  el(ds, 0x0008, 0x0016, "UI", sopClass);
  el(ds, 0x0008, 0x0018, "UI", sop);
  el(ds, 0x0008, 0x0020, "DA", "20260101");
  el(ds, 0x0008, 0x0060, "CS", im.modality);
  el(ds, 0x0008, 0x1030, "LO", im.studyDescription);
  el(ds, 0x0008, 0x103e, "LO", im.seriesDescription);
  el(ds, 0x0010, 0x0010, "PN", "TEST^SYNTHETIC");
  el(ds, 0x0010, 0x0020, "LO", "SYN0001");
  el(ds, 0x0020, 0x000d, "UI", im.studyUid);
  el(ds, 0x0020, 0x000e, "UI", im.seriesUid);
  el(ds, 0x0020, 0x0011, "IS", String(im.seriesNumber));
  el(ds, 0x0020, 0x0013, "IS", String(im.instanceNumber));
  el(ds, 0x0028, 0x0002, "US", us(1));
  el(ds, 0x0028, 0x0004, "CS", "MONOCHROME2");
  el(ds, 0x0028, 0x0010, "US", us(im.rows));
  el(ds, 0x0028, 0x0011, "US", us(im.columns));
  el(ds, 0x0028, 0x0100, "US", us(16));
  el(ds, 0x0028, 0x0101, "US", us(im.pixels instanceof Int16Array ? 16 : 12));
  el(ds, 0x0028, 0x0102, "US", us(im.pixels instanceof Int16Array ? 15 : 11));
  el(ds, 0x0028, 0x0103, "US", us(im.pixels instanceof Int16Array ? 1 : 0));
  if (im.window) {
    el(ds, 0x0028, 0x1050, "DS", String(im.window[0]));
    el(ds, 0x0028, 0x1051, "DS", String(im.window[1]));
  }
  if (im.modality === "CT") {
    el(ds, 0x0028, 0x1052, "DS", "0");
    el(ds, 0x0028, 0x1053, "DS", "1");
  }
  el(ds, 0x7fe0, 0x0010, "OW", new Uint8Array(im.pixels.buffer, im.pixels.byteOffset, im.pixels.byteLength));
  const out = new Uint8Array(132 + head.length + meta.length + ds.length);
  out.set([0x44, 0x49, 0x43, 0x4d], 128);
  out.set(head, 132);
  out.set(meta, 132 + head.length);
  out.set(ds, 132 + head.length + meta.length);
  return out;
}

/** A chest-like CT phantom: body, two lungs, a spine and ribs, changing along the series. */
export function ctSeries(n = 100, size = 512): Uint8Array[] {
  const studyUid = uid(), seriesUid = uid();
  const files: Uint8Array[] = [];
  for (let z = 0; z < n; z++) {
    const px = new Int16Array(size * size).fill(-1000);
    const t = z / (n - 1);
    const lungR = 0.17 + 0.06 * Math.sin(Math.PI * t);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x - size / 2) / size, v = (y - size / 2) / size;
        let h = -1000;
        if ((u / 0.42) ** 2 + (v / 0.32) ** 2 < 1) h = 40 + ((x * 7 + y * 13 + z * 31) % 17) - 8;
        const ring = (u / 0.39) ** 2 + (v / 0.29) ** 2;
        if (ring > 0.9 && ring < 1 && Math.sin(Math.atan2(v, u) * 12) > 0.3) h = 700;
        if (((u - 0.17) / lungR) ** 2 + (v / (lungR * 1.3)) ** 2 < 1 || ((u + 0.17) / lungR) ** 2 + (v / (lungR * 1.3)) ** 2 < 1) h = -820;
        if ((u / 0.05) ** 2 + ((v - 0.2) / 0.05) ** 2 < 1) h = 900;
        if ((u / 0.06) ** 2 + ((v + 0.02) / 0.06) ** 2 < 1) h = 50 + 30 * t;
        px[y * size + x] = h;
      }
    }
    files.push(writeDicom({ studyUid, seriesUid, modality: "CT", studyDescription: "Synthetic chest CT", seriesDescription: "Axial 5 mm", seriesNumber: 1, instanceNumber: z + 1, rows: size, columns: size, pixels: px, window: [40, 400] }));
  }
  return files;
}

/** One 2048² 12-bit radiograph-like image. */
export function dxImage(size = 2048): Uint8Array {
  const px = new Uint16Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x - size / 2) / size, v = (y - size / 2) / size;
      let s = 600 + 900 * Math.exp(-((u / 0.3) ** 2 + (v / 0.4) ** 2));
      if (Math.abs(u) < 0.03 && Math.abs(v) < 0.4) s += 1500;
      s += ((x ^ y) & 15) * 4;
      px[y * size + x] = Math.min(4095, Math.round(s));
    }
  }
  return writeDicom({ studyUid: uid(), seriesUid: uid(), modality: "DX", studyDescription: "Synthetic chest X-ray", seriesDescription: "PA", seriesNumber: 1, instanceNumber: 1, rows: size, columns: size, pixels: px });
}
