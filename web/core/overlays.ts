// Overlay planes (PS3.3 C.9, groups 6000–601E): bit-mapped graphics and regions of interest stored
// with an image, either in Overlay Data (60xx,3000) or, in older files, in the unused high bits of
// the pixel data (Overlay Bit Position).
import { tag, type DataSet } from "./dicom";

export interface OverlayPlane {
  group: number;
  rows: number;
  columns: number;
  /** 1-based row and column of the overlay's first pixel within the image. */
  origin: [number, number];
  /** "G" graphics, "R" region of interest. */
  type: string;
  label: string;
  description: string;
  /** Frames: the overlay applies to frames origin..origin+count−1 (1-based) of a multi-frame image. */
  frameOrigin: number;
  frames: number;
  /** One byte per overlay pixel (0 or 1), frame after frame; null until read from the pixel data. */
  bits: Uint8Array | null;
  /** Bit position in the pixel data when the overlay lives in the high bits. */
  bitPosition: number | null;
}

const at = (g: number, e: number) => tag(g, e);

/** The overlay planes an image header declares. Planes in the pixel data's high bits have bits null. */
export function readOverlays(ds: DataSet): OverlayPlane[] {
  const out: OverlayPlane[] = [];
  for (let g = 0x6000; g <= 0x601e; g += 2) {
    const rows = ds.num(at(g, 0x0010)), cols = ds.num(at(g, 0x0011));
    if (!rows || !cols) continue;
    const origin = ds.nums(at(g, 0x0050));
    const frames = ds.num(at(g, 0x0015)) ?? 1;
    const data = ds.raw(at(g, 0x3000));
    let bits: Uint8Array | null = null;
    if (data) {
      const n = rows * cols * frames;
      bits = new Uint8Array(n);
      for (let i = 0; i < n && i >> 3 < data.length; i++) bits[i] = (data[i >> 3] >> (i & 7)) & 1;
    }
    out.push({
      group: g,
      rows,
      columns: cols,
      origin: [origin[0] ?? 1, origin[1] ?? 1],
      type: ds.str(at(g, 0x0040)) ?? "G",
      label: ds.str(at(g, 0x1500)) ?? "",
      description: ds.str(at(g, 0x0022)) ?? "",
      frameOrigin: ds.num(at(g, 0x0051)) ?? 1,
      frames,
      bits,
      bitPosition: data ? null : ds.num(at(g, 0x0102)),
    });
  }
  return out;
}

/**
 * Fills the bits of planes stored in the pixel data's high bits, from the raw (unmasked) native
 * pixel data of the instance: 16-bit little endian samples, frame after frame.
 */
export function overlayBitsFromPixels(planes: OverlayPlane[], pixelData: Uint8Array, rows: number, cols: number, bitsAllocated: number) {
  if (bitsAllocated !== 16) return;
  const dv = new DataView(pixelData.buffer, pixelData.byteOffset, pixelData.byteLength);
  for (const p of planes) {
    if (p.bits || p.bitPosition === null) continue;
    const n = Math.min(rows * cols * p.frames, pixelData.length >> 1);
    const bits = new Uint8Array(rows * cols * p.frames);
    const pos = p.bitPosition;
    for (let i = 0; i < n; i++) bits[i] = (dv.getUint16(2 * i, true) >> pos) & 1;
    p.bits = bits;
    p.rows = rows;
    p.columns = cols;
  }
}
