// The ready-made thumbnail some DICOM files carry near the start of the header: Icon Image
// Sequence (0088,0200), PS3.3 F.7. Its pixels are uncompressed, 8-bit grey, RGB or palette.
import { parseDicomSync, T, tag, type DataSet } from "./dicom";

export interface Icon {
  width: number;
  height: number;
  /** RGBA, width × height × 4. */
  rgba: Uint8ClampedArray;
}

/** The icon in the first bytes of a file (which may stop before Pixel Data), or null. */
export function readIcon(head: Uint8Array): Icon | null {
  let ds: DataSet;
  try {
    ds = parseDicomSync(head, { untilPixelData: true }).ds;
  } catch {
    return null;
  }
  const it = ds.seq(T.IconImageSequence)[0];
  if (!it) return null;
  const w = it.num(T.Columns) ?? 0, h = it.num(T.Rows) ?? 0;
  const spp = it.num(T.SamplesPerPixel) ?? 1, bits = it.num(T.BitsAllocated) ?? 8;
  const pi = (it.str(T.PhotometricInterpretation) ?? "MONOCHROME2").toUpperCase();
  const px = it.raw(T.PixelData);
  if (!w || !h || bits !== 8 || !px || px.length < w * h * spp) return null;
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (spp === 3) {
    const planar = (it.num(T.PlanarConfiguration) ?? 0) === 1;
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = planar ? px[c * w * h + i] : px[i * 3 + c];
      rgba[i * 4 + 3] = 255;
    }
    return { width: w, height: h, rgba };
  }
  let lut: Uint8Array[] | null = null;
  if (pi === "PALETTE COLOR") {
    lut = [0x1201, 0x1202, 0x1203].map((e, c) => {
      const desc = it.nums(tag(0x0028, 0x1101 + c));
      const raw = it.raw(tag(0x0028, e));
      if (desc.length < 3 || !raw) return new Uint8Array(0);
      const n = desc[0] || 65536, out = new Uint8Array(256);
      const wide = raw.length >= 2 * n;
      for (let k = 0; k < 256; k++) {
        const j = Math.min(n - 1, Math.max(0, k - desc[1]));
        out[k] = wide ? raw[2 * j + 1] : raw[j];
      }
      return out;
    });
    if (lut.some((l) => !l.length)) return null;
  }
  const invert = pi === "MONOCHROME1";
  for (let i = 0; i < w * h; i++) {
    const v = px[i];
    if (lut) {
      rgba[i * 4] = lut[0][v];
      rgba[i * 4 + 1] = lut[1][v];
      rgba[i * 4 + 2] = lut[2][v];
    } else rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = invert ? 255 - v : v;
    rgba[i * 4 + 3] = 255;
  }
  return { width: w, height: h, rgba };
}
