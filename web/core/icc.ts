// ICC colour profiles → sRGB, for slides and visible-light photos (DICOM ICC Profile (0028,2000),
// in an Optical Path Sequence item or at the top level). One shared helper: the slide viewer and
// the photo display both use it.
//
//   const t = iccToSrgb(profileBytes);       // null: not RGB, unsupported, or already sRGB
//   t?.applyRgb(rgb8, pixelCount);            // in place, 3 bytes per pixel
//   t?.applyRgba(rgba8, pixelCount);          // in place, 4 bytes per pixel
//
// Supported: RGB input profiles with a matrix/TRC model (curv and para curves) or an A2B0 lut8 /
// lut16 transform (mft1, mft2), into an XYZ or Lab profile connection space, ICC v2 and v4
// headers. The rendering intent is the profile's default (A2B0, perceptual). The transform is
// sampled once into a 33×33×33 table, then applied with trilinear interpolation.
// lutAtoBType (mAB, v4) is not supported yet: such profiles return null and the caller shows the
// pixels as stored.

export interface IccTransform {
  /** The profile's description, if it has one. */
  description: string;
  /** "matrix-trc" or "lut" */
  model: "matrix-trc" | "lut";
  applyRgb(px: Uint8Array | Uint8ClampedArray, n: number): void;
  applyRgba(px: Uint8Array | Uint8ClampedArray, n: number): void;
}

type Curve = (x: number) => number;

const be32 = (b: DataView, o: number) => b.getUint32(o);
const s15 = (b: DataView, o: number) => b.getInt32(o) / 65536;

function readCurve(dv: DataView, o: number): Curve | null {
  const sig = be32(dv, o);
  if (sig === 0x63757276 /* curv */) {
    const n = be32(dv, o + 8);
    if (n === 0) return (x) => x;
    if (n === 1) {
      const g = dv.getUint16(o + 12) / 256;
      return (x) => Math.pow(x, g);
    }
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = dv.getUint16(o + 12 + 2 * i) / 65535;
    return (x) => {
      const p = Math.min(1, Math.max(0, x)) * (n - 1);
      const i = Math.min(n - 2, Math.floor(p));
      return t[i] + (t[i + 1] - t[i]) * (p - i);
    };
  }
  if (sig === 0x70617261 /* para */) {
    const fn = dv.getUint16(o + 8);
    const p = (k: number) => s15(dv, o + 12 + 4 * k);
    const g = p(0);
    switch (fn) {
      case 0: return (x) => Math.pow(x, g);
      case 1: { const a = p(1), b = p(2); return (x) => (x >= -b / a ? Math.pow(a * x + b, g) : 0); }
      case 2: { const a = p(1), b = p(2), c = p(3); return (x) => (x >= -b / a ? Math.pow(a * x + b, g) + c : c); }
      case 3: { const a = p(1), b = p(2), c = p(3), d = p(4); return (x) => (x >= d ? Math.pow(a * x + b, g) : c * x); }
      case 4: { const a = p(1), b = p(2), c = p(3), d = p(4), e = p(5), f = p(6); return (x) => (x >= d ? Math.pow(a * x + b, g) + e : c * x + f); }
    }
  }
  return null;
}

const D50 = [0.9642, 1.0, 0.8249];
// XYZ (D50, the ICC PCS) → linear sRGB, Bradford-adapted to D65 (as lcms and the sRGB profile do).
const XYZD50_TO_SRGB = [
  [3.1338561, -1.6168667, -0.4906146],
  [-0.9787684, 1.9161415, 0.033454],
  [0.0719453, -0.2289914, 1.4052427],
];

function labToXyz(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const f = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  return [D50[0] * f(fx), D50[1] * f(fy), D50[2] * f(fz)];
}

const srgbEncode = (v: number) => {
  v = Math.min(1, Math.max(0, v));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
};

function xyzToSrgb(x: number, y: number, z: number, out: Float64Array, o: number) {
  const m = XYZD50_TO_SRGB;
  out[o] = srgbEncode(m[0][0] * x + m[0][1] * y + m[0][2] * z);
  out[o + 1] = srgbEncode(m[1][0] * x + m[1][1] * y + m[1][2] * z);
  out[o + 2] = srgbEncode(m[2][0] * x + m[2][1] * y + m[2][2] * z);
}

/** lut8 / lut16 (mft1, mft2): matrix (XYZ input only), input curves, CLUT, output curves. */
function readLut(dv: DataView, o: number, pcsLab: boolean): ((r: number, g: number, b: number, out: Float64Array, oo: number) => void) | null {
  const sig = be32(dv, o);
  const lut16 = sig === 0x6d667432; // mft2
  if (!lut16 && sig !== 0x6d667431 /* mft1 */) return null;
  const nin = dv.getUint8(o + 8), nout = dv.getUint8(o + 9), grid = dv.getUint8(o + 10);
  if (nin !== 3 || nout !== 3 || grid < 2) return null;
  let p = o + 48;
  let inN = 256, outN = 256;
  if (lut16) {
    inN = dv.getUint16(o + 48);
    outN = dv.getUint16(o + 50);
    p = o + 52;
  }
  const rd = lut16 ? (q: number) => dv.getUint16(q) / 65535 : (q: number) => dv.getUint8(q) / 255;
  const step = lut16 ? 2 : 1;
  const inT = [0, 1, 2].map((c) => Float64Array.from({ length: inN }, (_, i) => rd(p + step * (c * inN + i))));
  p += step * 3 * inN;
  const g3 = grid * grid * grid;
  const clut = new Float64Array(g3 * 3);
  for (let i = 0; i < g3 * 3; i++) clut[i] = rd(p + step * i);
  p += step * g3 * 3;
  const outT = [0, 1, 2].map((c) => Float64Array.from({ length: outN }, (_, i) => rd(p + step * (c * outN + i))));
  const table = (t: Float64Array, x: number) => {
    const q = Math.min(1, Math.max(0, x)) * (t.length - 1);
    const i = Math.min(t.length - 2, Math.floor(q));
    return t[i] + (t[i + 1] - t[i]) * (q - i);
  };
  const v = new Float64Array(3);
  const g1 = grid - 1;
  return (r, g, b, out, oo) => {
    // Input curves, then trilinear interpolation in the CLUT (first input varies slowest).
    const x0 = table(inT[0], r) * g1, x1 = table(inT[1], g) * g1, x2 = table(inT[2], b) * g1;
    const i0 = Math.min(grid - 2, x0 | 0), i1 = Math.min(grid - 2, x1 | 0), i2 = Math.min(grid - 2, x2 | 0);
    const f0 = x0 - i0, f1 = x1 - i1, f2 = x2 - i2;
    v[0] = v[1] = v[2] = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c >> 2, dy = (c >> 1) & 1, dz = c & 1;
      const w = (dx ? f0 : 1 - f0) * (dy ? f1 : 1 - f1) * (dz ? f2 : 1 - f2);
      if (!w) continue;
      const idx = (((i0 + dx) * grid + (i1 + dy)) * grid + (i2 + dz)) * 3;
      v[0] += w * clut[idx];
      v[1] += w * clut[idx + 1];
      v[2] += w * clut[idx + 2];
    }
    const a = table(outT[0], v[0]), bb = table(outT[1], v[1]), c = table(outT[2], v[2]);
    if (pcsLab) {
      // Legacy 16-bit Lab encoding in lut8/lut16: L = a·100·65535/65280, a/b = x·255·65535/65280 − 128.
      const k = 65535 / 65280;
      const [X, Y, Z] = labToXyz(a * 100 * k, bb * 255 * k - 128, c * 255 * k - 128);
      xyzToSrgb(X, Y, Z, out, oo);
    } else {
      // XYZ PCS in lut16: 0..1 + 32767/32768 maps to 0..65535.
      const k = 1 + 32767 / 32768;
      xyzToSrgb(a * k, bb * k, c * k, out, oo);
    }
  };
}

const GRID = 33;

/**
 * A transform from the profile's RGB to sRGB, or null when the profile is not an RGB profile, is
 * not supported, or is sRGB already (nothing to do).
 */
export function iccToSrgb(profile: Uint8Array): IccTransform | null {
  if (profile.byteLength < 132) return null;
  const dv = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
  if (be32(dv, 16) !== 0x52474220 /* "RGB " */) return null;
  const pcsLab = be32(dv, 20) === 0x4c616220; /* "Lab " */
  const tags = new Map<string, number>();
  const n = be32(dv, 128);
  for (let i = 0; i < n && 144 + 12 * i <= profile.byteLength; i++) {
    const o = 132 + 12 * i;
    tags.set(String.fromCharCode(...profile.subarray(o, o + 4)), be32(dv, o + 4));
  }
  const description = readDescription(dv, tags.get("desc"));
  if (/^sRGB\b/i.test(description) || /IEC ?61966-2[.-]1/.test(description)) return null;

  const sample = new Float64Array(GRID * GRID * GRID * 3);
  let model: IccTransform["model"];
  const a2b0 = tags.get("A2B0");
  const lut = a2b0 !== undefined ? readLut(dv, a2b0, pcsLab) : null;
  if (lut) {
    model = "lut";
    for (let r = 0, k = 0; r < GRID; r++)
      for (let g = 0; g < GRID; g++)
        for (let b = 0; b < GRID; b++, k += 3) lut(r / (GRID - 1), g / (GRID - 1), b / (GRID - 1), sample, k);
  } else {
    const xyz = ["rXYZ", "gXYZ", "bXYZ"].map((t) => tags.get(t));
    const trc = ["rTRC", "gTRC", "bTRC"].map((t) => tags.get(t));
    if (xyz.some((o) => o === undefined) || trc.some((o) => o === undefined) || pcsLab) return null;
    const cols = xyz.map((o) => [s15(dv, o! + 8), s15(dv, o! + 12), s15(dv, o! + 16)]);
    const curves = trc.map((o) => readCurve(dv, o!));
    if (curves.some((c) => !c)) return null;
    model = "matrix-trc";
    for (let r = 0, k = 0; r < GRID; r++)
      for (let g = 0; g < GRID; g++)
        for (let b = 0; b < GRID; b++, k += 3) {
          const lr = curves[0]!(r / (GRID - 1)), lg = curves[1]!(g / (GRID - 1)), lb = curves[2]!(b / (GRID - 1));
          xyzToSrgb(
            cols[0][0] * lr + cols[1][0] * lg + cols[2][0] * lb,
            cols[0][1] * lr + cols[1][1] * lg + cols[2][1] * lb,
            cols[0][2] * lr + cols[1][2] * lg + cols[2][2] * lb,
            sample,
            k,
          );
        }
  }
  const table = Float32Array.from(sample, (v) => v * 255);
  const apply = (px: Uint8Array | Uint8ClampedArray, count: number, stride: number) => {
    const s = (GRID - 1) / 255;
    const G2 = GRID * GRID * 3, G1 = GRID * 3;
    for (let i = 0, o = 0; i < count; i++, o += stride) {
      const x = px[o] * s, y = px[o + 1] * s, z = px[o + 2] * s;
      const x0 = Math.min(GRID - 2, x | 0), y0 = Math.min(GRID - 2, y | 0), z0 = Math.min(GRID - 2, z | 0);
      const fx = x - x0, fy = y - y0, fz = z - z0;
      const base = x0 * G2 + y0 * G1 + z0 * 3;
      for (let c = 0; c < 3; c++) {
        const b0 = base + c;
        const c00 = table[b0] + (table[b0 + 3] - table[b0]) * fz;
        const c01 = table[b0 + G1] + (table[b0 + G1 + 3] - table[b0 + G1]) * fz;
        const c10 = table[b0 + G2] + (table[b0 + G2 + 3] - table[b0 + G2]) * fz;
        const c11 = table[b0 + G2 + G1] + (table[b0 + G2 + G1 + 3] - table[b0 + G2 + G1]) * fz;
        const c0 = c00 + (c01 - c00) * fy, c1 = c10 + (c11 - c10) * fy;
        px[o + c] = Math.round(c0 + (c1 - c0) * fx);
      }
    }
  };
  return {
    description,
    model,
    applyRgb: (px, count) => apply(px, count, 3),
    applyRgba: (px, count) => apply(px, count, 4),
  };
}

function readDescription(dv: DataView, o: number | undefined): string {
  if (o === undefined) return "";
  const sig = be32(dv, o);
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  if (sig === 0x64657363 /* desc */) {
    const n = be32(dv, o + 8);
    return String.fromCharCode(...bytes.subarray(o + 12, o + 12 + Math.max(0, n - 1))).trim();
  }
  if (sig === 0x6d6c7563 /* mluc */) {
    const len = be32(dv, o + 20), off = be32(dv, o + 24);
    let s = "";
    for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(dv.getUint16(o + off + i));
    return s.trim();
  }
  return "";
}

/** DICOM CIELab (Recommended Display CIELab Value: three 16-bit values) → 8-bit sRGB. */
export function dicomLabToSrgb(lab: [number, number, number]): [number, number, number] {
  const [X, Y, Z] = labToXyz((lab[0] / 65535) * 100, (lab[1] / 65535) * 255 - 128, (lab[2] / 65535) * 255 - 128);
  const out = new Float64Array(3);
  xyzToSrgb(X, Y, Z, out, 0);
  return [Math.round(out[0] * 255), Math.round(out[1] * 255), Math.round(out[2] * 255)];
}
