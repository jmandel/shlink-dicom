// Shared types for viewer-kit. See ../INTEGRATION.md.

/** Image metadata returned with every decode (built in codecs/shl-dicom-decode-wasm, `info_json`). */
export interface ImageInfo {
  rows: number;
  columns: number;
  /** Frames in this result (a frame-range decode returns fewer than totalFrames). */
  frames: number;
  /** Index of the first frame of this result within the instance. */
  firstFrame: number;
  /** Number of Frames of the instance. */
  totalFrames: number;
  samplesPerPixel: 1 | 3;
  /** 8, 16 or 32 (Bits Allocated 1 is returned as one byte per sample). */
  bitsAllocated: number;
  bitsStored: number;
  /** 0 unsigned, 1 two's complement. */
  pixelRepresentation: 0 | 1;
  /**
   * Float or Double Float Pixel Data: samples are IEEE 754 f32 (bitsAllocated 32) or f64
   * (bitsAllocated 64), little-endian; pixelRepresentation is 0 and bitsStored equals
   * bitsAllocated. minValue/maxValue skip NaN and infinities.
   */
  float: boolean;
  /**
   * First Real World Value Mapping item (top level, else Shared, else Per-Frame item 0), or null:
   * real value = stored × slope + intercept, in `units` (UCUM code) / `unitsMeaning`.
   */
  realWorldValueMapping: RealWorldValueMapping | null;
  /** rows × columns × samples × bytes per sample. */
  frameBytes: number;
  /** Of the returned pixels: "RGB" after a YBR conversion, otherwise as declared. */
  photometric: string;
  transferSyntax: string;
  /** Rescale Slope (1 when absent). From the top level, else the functional groups. */
  rescaleSlope: number;
  /** Rescale Intercept (0 when absent). */
  rescaleIntercept: number;
  /** First Window Center / Width, or null when the instance has none. */
  windowCenter: number | null;
  windowWidth: number | null;
  /** VOI LUT Function (LINEAR, LINEAR_EXACT, SIGMOID), or null. Only LINEAR is rendered. */
  voiLutFunction: string | null;
  modality: string | null;
  sopInstanceUid: string | null;
  instanceNumber: number | null;
  /** Smallest / largest stored value over the returned frames (single-sample images only). */
  minValue: number | null;
  maxValue: number | null;
  /** Per-frame rescale and window from the Per-Frame Functional Groups, for the returned frames. */
  perFrame: FrameValues[] | null;
  /**
   * Set only by a reduced-resolution decode (`scale` option): log2 of the reduction, and the
   * instance's own Rows and Columns. `rows`, `columns` and `frameBytes` then describe the reduced
   * pixels.
   */
  scale?: number;
  fullRows?: number;
  fullColumns?: number;
}

export interface RealWorldValueMapping {
  slope: number | null;
  intercept: number | null;
  label: string | null;
  units: string | null;
  unitsMeaning: string | null;
}

export interface FrameValues {
  rescaleSlope: number | null;
  rescaleIntercept: number | null;
  windowCenter: number | null;
  windowWidth: number | null;
}

/** RGBA8 palette for PALETTE COLOR images (from the Palette Color LUT descriptors and data). */
export interface PaletteLut {
  /** First Mapped stored value. */
  first: number;
  /** count × 4 bytes, RGBA. */
  rgba: Uint8Array;
}

/** Canonical pixels (codec-corpus/CONTRACT.md) plus metadata. */
export interface DecodedImage extends ImageInfo {
  /** frames × rows × columns × samples, little-endian, Bits Allocated wide. Transferred, not copied. */
  pixels: ArrayBuffer;
  /** Byte offset of each returned frame in `pixels` (k × frameBytes). */
  frameOffsets: number[];
  palette: PaletteLut | null;
  /** Time inside the wasm decode, in the worker. */
  decodeMs: number;
  /** Time from pool.decode() to the result reaching the main thread (queueing included). */
  totalMs: number;
  /** The instance's bytes before Pixel Data, when the decode asked for them (`header: true`). */
  header?: Uint8Array;
}

export type Samples =
  | Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/** One frame ready to render: the input of the renderers. */
export interface Frame {
  rows: number;
  columns: number;
  samplesPerPixel: 1 | 3;
  bitsAllocated: number;
  /** Used to scale RGB with more than 8 bits; defaults to bitsAllocated. */
  bitsStored?: number;
  signed: boolean;
  photometric: string;
  rescaleSlope: number;
  rescaleIntercept: number;
  /** rows × columns × samples values (typed to Bits Allocated and Pixel Representation; Float32Array
   * or Float64Array for float pixel data). */
  data: Samples;
  palette?: PaletteLut | null;
}

/** Typed view of frame `k` (index within the result) of a decoded image. No copy. */
export function frameOf(img: DecodedImage, k = 0): Frame {
  const n = img.rows * img.columns * img.samplesPerPixel;
  const off = img.frameOffsets[k];
  if (off === undefined) throw new RangeError(`frame ${k} not in this result (${img.frames} frames)`);
  const signed = img.pixelRepresentation === 1;
  let data: Samples;
  if (img.float) {
    if (img.bitsAllocated === 32) data = new Float32Array(img.pixels, off, n);
    else if (img.bitsAllocated === 64) data = new Float64Array(img.pixels, off, n);
    else throw new Error(`float pixel data with Bits Allocated ${img.bitsAllocated}`);
  } else switch (img.bitsAllocated) {
    case 8: case 1: data = signed ? new Int8Array(img.pixels, off, n) : new Uint8Array(img.pixels, off, n); break;
    case 16: data = signed ? new Int16Array(img.pixels, off, n) : new Uint16Array(img.pixels, off, n); break;
    case 32: data = signed ? new Int32Array(img.pixels, off, n) : new Uint32Array(img.pixels, off, n); break;
    default: throw new Error(`Bits Allocated ${img.bitsAllocated}`);
  }
  const pf = img.perFrame?.[k];
  return {
    rows: img.rows,
    columns: img.columns,
    samplesPerPixel: img.samplesPerPixel,
    bitsAllocated: img.bitsAllocated,
    bitsStored: img.bitsStored,
    signed,
    photometric: img.photometric,
    rescaleSlope: pf?.rescaleSlope ?? img.rescaleSlope,
    rescaleIntercept: pf?.rescaleIntercept ?? img.rescaleIntercept,
    data,
    palette: img.palette,
  };
}

/** The window an image asks for, else one covering its rescaled value range. */
export function defaultWindow(img: ImageInfo, k = 0): { center: number; width: number } {
  const pf = img.perFrame?.[k];
  const c = pf?.windowCenter ?? img.windowCenter;
  const w = pf?.windowWidth ?? img.windowWidth;
  if (c != null && w != null && w >= 1) return { center: c, width: w };
  const m = pf?.rescaleSlope ?? img.rescaleSlope, b = pf?.rescaleIntercept ?? img.rescaleIntercept;
  if (img.samplesPerPixel === 1 && img.minValue != null && img.maxValue != null) {
    const a = img.minValue * m + b, z = img.maxValue * m + b;
    const lo = Math.min(a, z), hi = Math.max(a, z);
    return { center: (lo + hi + 1) / 2, width: Math.max(1, hi - lo + 1) };
  }
  const full = 2 ** img.bitsStored;
  return img.pixelRepresentation ? { center: 0, width: full } : { center: full / 2, width: full };
}

/** Decoder refused the file: CONTRACT exit 2 (malformed) or 3 (unsupported). */
export class DicomDecodeError extends Error {
  constructor(readonly exitCode: 2 | 3, readonly decoderMessage: string) {
    super(`${exitCode === 2 ? "invalid DICOM" : "unsupported DICOM"}: ${decoderMessage}`);
    this.name = new.target.name;
  }
}
/** Exit 2: the file is malformed or violates the standard. */
export class InvalidDicomError extends DicomDecodeError {
  constructor(msg: string) { super(2, msg); }
}
/** Exit 3: valid, but the decoder does not handle it (for example an unsupported transfer syntax). */
export class UnsupportedDicomError extends DicomDecodeError {
  constructor(msg: string) { super(3, msg); }
}
/** The wasm instance trapped (a decoder bug: CONTRACT treats a panic as a crash). The worker has been reset. */
export class DecoderCrashError extends Error {
  constructor(msg: string) { super(`decoder crashed: ${msg}`); this.name = "DecoderCrashError"; }
}

export function decodeError(code: number, message: string): Error {
  if (code === 2) return new InvalidDicomError(message);
  if (code === 3) return new UnsupportedDicomError(message);
  return new DecoderCrashError(message);
}
